import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../../db/schema";
import type { HostServiceContext } from "../../../types";
import { configRouter, resolveWorkspaceRunDefinition } from "./config";

const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../../drizzle");
// Valid v4 UUID — zod's .uuid() rejects all-1s.
const PROJECT_ID = "1f0e8c7e-1234-4abc-8def-0123456789ab";

interface Sandbox {
	repoPath: string;
	cleanup: () => void;
}

function createRepo(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "config-router-test-"));
	const repoPath = join(root, "repo");
	mkdirSync(repoPath, { recursive: true });
	return {
		repoPath,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function createCaller(repoPath: string) {
	const sqlite = new Database(":memory:");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
	db.insert(schema.projects).values({ id: PROJECT_ID, repoPath }).run();
	const ctx = { db, isAuthenticated: true } as unknown as HostServiceContext;
	return configRouter.createCaller(ctx);
}

describe("configRouter", () => {
	let sandbox: Sandbox;

	beforeEach(() => {
		sandbox = createRepo();
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	describe("getConfigContent", () => {
		it("returns null content when config.json doesn't exist", async () => {
			const caller = createCaller(sandbox.repoPath);
			const result = await caller.getConfigContent({ projectId: PROJECT_ID });
			expect(result).toEqual({ content: null, exists: false });
		});

		it("returns raw content when config.json exists", async () => {
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				`{"setup":["bun install"]}`,
				"utf-8",
			);

			const result = await caller.getConfigContent({ projectId: PROJECT_ID });
			expect(result.exists).toBe(true);
			expect(result.content).toBe(`{"setup":["bun install"]}`);
		});

		it("throws NOT_FOUND when project isn't registered locally", async () => {
			const caller = createCaller(sandbox.repoPath);
			await expect(
				caller.getConfigContent({
					projectId: "2f0e8c7e-1234-4abc-8def-0123456789ab",
				}),
			).rejects.toThrow(/Project not set up locally/);
		});
	});

	describe("updateConfig", () => {
		it("creates .superset/config.json on first save", async () => {
			const caller = createCaller(sandbox.repoPath);
			await caller.updateConfig({
				projectId: PROJECT_ID,
				setup: ["bun install"],
				teardown: [],
			});

			const configPath = join(sandbox.repoPath, ".superset", "config.json");
			expect(existsSync(configPath)).toBe(true);
			const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(parsed).toEqual({ setup: ["bun install"], teardown: [] });
		});

		it("preserves the existing run array on subsequent saves", async () => {
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({
					setup: ["old"],
					teardown: ["old-down"],
					run: ["bun run dev"],
				}),
				"utf-8",
			);

			await caller.updateConfig({
				projectId: PROJECT_ID,
				setup: ["bun install"],
				teardown: ["docker compose down"],
			});

			const parsed = JSON.parse(
				readFileSync(join(dir, "config.json"), "utf-8"),
			);
			expect(parsed).toEqual({
				setup: ["bun install"],
				teardown: ["docker compose down"],
				run: ["bun run dev"],
			});
		});

		it("updates run when provided and preserves setup/teardown when omitted", async () => {
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({
					setup: ["bun install"],
					teardown: ["docker compose down"],
					run: ["old dev"],
				}),
				"utf-8",
			);

			await caller.updateConfig({
				projectId: PROJECT_ID,
				run: ["bun dev"],
			});

			const parsed = JSON.parse(
				readFileSync(join(dir, "config.json"), "utf-8"),
			);
			expect(parsed).toEqual({
				setup: ["bun install"],
				teardown: ["docker compose down"],
				run: ["bun dev"],
			});
		});

		it("preserves unrelated top-level keys (forward compatibility)", async () => {
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({
					setup: [],
					teardown: [],
					somethingNew: { nested: true },
				}),
				"utf-8",
			);

			await caller.updateConfig({
				projectId: PROJECT_ID,
				setup: ["x"],
				teardown: [],
			});

			const parsed = JSON.parse(
				readFileSync(join(dir, "config.json"), "utf-8"),
			);
			expect(parsed.somethingNew).toEqual({ nested: true });
			expect(parsed.setup).toEqual(["x"]);
		});

		it("overwrites a malformed config.json with a fresh shape", async () => {
			// Documents the current behavior: a corrupt file is silently replaced.
			// Surfaced in the smoke-test list as a known-but-accepted edge case.
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "config.json"), "{not valid json,,,", "utf-8");

			await caller.updateConfig({
				projectId: PROJECT_ID,
				setup: ["new"],
				teardown: [],
			});

			const parsed = JSON.parse(
				readFileSync(join(dir, "config.json"), "utf-8"),
			);
			expect(parsed).toEqual({ setup: ["new"], teardown: [] });
		});
	});

	describe("shouldShowSetupCard", () => {
		it("returns true when no config exists", async () => {
			const caller = createCaller(sandbox.repoPath);
			expect(await caller.shouldShowSetupCard({ projectId: PROJECT_ID })).toBe(
				true,
			);
		});

		it("returns false once setup is non-empty", async () => {
			const caller = createCaller(sandbox.repoPath);
			await caller.updateConfig({
				projectId: PROJECT_ID,
				setup: ["bun install"],
				teardown: [],
			});
			expect(await caller.shouldShowSetupCard({ projectId: PROJECT_ID })).toBe(
				false,
			);
		});

		it("returns true when config exists but all arrays are empty", async () => {
			const caller = createCaller(sandbox.repoPath);
			await caller.updateConfig({
				projectId: PROJECT_ID,
				setup: [],
				teardown: [],
			});
			expect(await caller.shouldShowSetupCard({ projectId: PROJECT_ID })).toBe(
				true,
			);
		});

		it("returns false when only teardown is defined (setup key absent)", async () => {
			// Different from "all-empty arrays": here there's no setup key at all.
			// Card should still hide because teardown counts as configured.
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ teardown: ["docker compose down"] }),
				"utf-8",
			);

			expect(await caller.shouldShowSetupCard({ projectId: PROJECT_ID })).toBe(
				false,
			);
		});

		it("returns false when only the run key is set", async () => {
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ setup: [], teardown: [], run: ["bun run dev"] }),
				"utf-8",
			);

			expect(await caller.shouldShowSetupCard({ projectId: PROJECT_ID })).toBe(
				false,
			);
		});
	});

	describe("getWorkspaceRunDefinition", () => {
		it("returns null when run is not configured", async () => {
			const caller = createCaller(sandbox.repoPath);
			expect(
				await caller.getWorkspaceRunDefinition({ projectId: PROJECT_ID }),
			).toBeNull();
		});

		it("returns non-empty run commands from resolved config", async () => {
			const caller = createCaller(sandbox.repoPath);
			await caller.updateConfig({
				projectId: PROJECT_ID,
				setup: [],
				teardown: [],
				run: ["", "bun dev", "   "],
			});

			expect(
				await caller.getWorkspaceRunDefinition({ projectId: PROJECT_ID }),
			).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: ["bun dev"],
			});
		});

		it("preserves cwd from resolved config", async () => {
			const caller = createCaller(sandbox.repoPath);
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ run: ["bun dev"], cwd: "apps/web" }),
				"utf-8",
			);

			expect(
				await caller.getWorkspaceRunDefinition({ projectId: PROJECT_ID }),
			).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: ["bun dev"],
				cwd: "apps/web",
			});
		});

		it("POSIX script fallback uses bash single-quote form", () => {
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			const scriptPath = join(dir, "run.sh");
			writeFileSync(scriptPath, "#!/usr/bin/env bash\n", "utf-8");

			expect(
				resolveWorkspaceRunDefinition({
					repoPath: sandbox.repoPath,
					projectId: PROJECT_ID,
					platform: "darwin",
					shell: "/bin/zsh",
				}),
			).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [`bash '${scriptPath}'`],
			});
		});

		it("preserves configured run command array without joining", () => {
			const dir = join(sandbox.repoPath, ".superset");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "config.json"),
				JSON.stringify({ run: ["echo a", "bun dev"] }),
				"utf-8",
			);

			expect(
				resolveWorkspaceRunDefinition({
					repoPath: sandbox.repoPath,
					projectId: PROJECT_ID,
					platform: "win32",
					shell: "cmd.exe",
				}),
			).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: ["echo a", "bun dev"],
			});
		});
	});
});

describe("resolveWorkspaceRunDefinition Windows script invocation", () => {
	let sandbox: Sandbox;

	beforeEach(() => {
		sandbox = createRepo();
	});

	afterEach(() => {
		sandbox.cleanup();
	});

	function writeRunScript(basename: string, body = "echo hi\r\n"): string {
		// Path with spaces so quoting regressions surface in expectations.
		const root = join(sandbox.repoPath, "My Project");
		const dir = join(root, ".superset");
		mkdirSync(dir, { recursive: true });
		const scriptPath = join(dir, basename);
		writeFileSync(scriptPath, body, "utf-8");
		return scriptPath;
	}

	function resolveWindows(shell: string, scriptBasename: string) {
		const scriptPath = writeRunScript(scriptBasename);
		const definition = resolveWorkspaceRunDefinition({
			repoPath: join(sandbox.repoPath, "My Project"),
			projectId: PROJECT_ID,
			platform: "win32",
			shell,
		});
		return { scriptPath, definition };
	}

	describe("cmd.exe", () => {
		it("runs .ts via bun with double-quoted paths (spaces)", () => {
			const { scriptPath, definition } = resolveWindows("cmd.exe", "run.ts");
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [`bun "${scriptPath}" && exit /b 0 || exit /b 1`],
			});
			expect(definition?.commands[0]).not.toMatch(/^bash '/);
		});

		it("runs .cmd natively without bash", () => {
			const { scriptPath, definition } = resolveWindows("cmd.exe", "run.cmd");
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [`"${scriptPath}" && exit /b 0 || exit /b 1`],
			});
			expect(definition?.commands[0]).not.toContain("bash");
		});

		it("runs .bat natively without bash", () => {
			const { scriptPath, definition } = resolveWindows("cmd.exe", "run.bat");
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [`"${scriptPath}" && exit /b 0 || exit /b 1`],
			});
			expect(definition?.commands[0]).not.toContain("bash");
		});

		it("runs .ps1 through powershell.exe -File with double-quoted paths", () => {
			const { scriptPath, definition } = resolveWindows("cmd.exe", "run.ps1");
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [
					`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" && exit /b 0 || exit /b 1`,
				],
			});
			expect(definition?.commands[0]).not.toMatch(/^bash '/);
		});

		it("runs .sh via Git Bash with double-quoted paths (spaces)", () => {
			const { scriptPath, definition } = resolveWindows("cmd.exe", "run.sh");
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [`bash "${scriptPath}" && exit /b 0 || exit /b 1`],
			});
			// POSIX single quotes are not quoting in cmd.exe.
			expect(definition?.commands[0]).not.toContain("'");
			expect(definition?.commands[0]).not.toMatch(/^bash '/);
		});
	});

	describe("Windows PowerShell 5.1", () => {
		it("runs .ts via bun with single-quoted paths (spaces)", () => {
			const { scriptPath, definition } = resolveWindows(
				"powershell.exe",
				"run.ts",
			);
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [`bun '${scriptPath}'; if (-not $?) { exit 1 }`],
			});
			expect(definition?.commands[0]).not.toMatch(/^bash '/);
		});

		it("runs .cmd through cmd.exe /d /s /c without bare bash", () => {
			const { scriptPath, definition } = resolveWindows(
				"powershell.exe",
				"run.cmd",
			);
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [
					`cmd.exe /d /s /c '"${scriptPath}"'; if (-not $?) { exit 1 }`,
				],
			});
			expect(definition?.commands[0]).not.toMatch(/\bbash\b/);
		});

		it("runs .bat through cmd.exe /d /s /c without bare bash", () => {
			const { scriptPath, definition } = resolveWindows(
				"powershell.exe",
				"run.bat",
			);
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [
					`cmd.exe /d /s /c '"${scriptPath}"'; if (-not $?) { exit 1 }`,
				],
			});
			expect(definition?.commands[0]).not.toMatch(/\bbash\b/);
		});

		it("runs .ps1 through powershell.exe -File with single-quoted paths", () => {
			const { scriptPath, definition } = resolveWindows(
				"powershell.exe",
				"run.ps1",
			);
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [
					`powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${scriptPath}'; if (-not $?) { exit 1 }`,
				],
			});
			expect(definition?.commands[0]).not.toMatch(/^bash '/);
		});

		it("runs .sh via Git Bash with single-quoted paths (spaces)", () => {
			const { scriptPath, definition } = resolveWindows(
				"powershell.exe",
				"run.sh",
			);
			expect(definition).toEqual({
				source: "project-config",
				projectId: PROJECT_ID,
				commands: [`bash '${scriptPath}'; if (-not $?) { exit 1 }`],
			});
			expect(definition?.commands[0]).not.toMatch(/bash "/);
			expect(definition?.commands[0]).not.toContain("exec bash");
		});
	});

	it("prefers run.ts over lower-priority Windows fallbacks", () => {
		const root = join(sandbox.repoPath, "My Project");
		const dir = join(root, ".superset");
		mkdirSync(dir, { recursive: true });
		const tsPath = join(dir, "run.ts");
		const cmdPath = join(dir, "run.cmd");
		writeFileSync(tsPath, "export {}", "utf-8");
		writeFileSync(cmdPath, "@echo off\r\n", "utf-8");

		const definition = resolveWorkspaceRunDefinition({
			repoPath: root,
			projectId: PROJECT_ID,
			platform: "win32",
			shell: "cmd.exe",
		});
		expect(definition?.commands[0]).toContain("bun ");
		expect(definition?.commands[0]).toContain(tsPath);
		expect(definition?.commands[0]).not.toContain(cmdPath);
	});

	it("threads platform into script discovery instead of relying on the host OS", () => {
		// Only a Windows-native run.cmd exists. On a macOS CI host, process.platform
		// would never find it — the router path must force platform into resolveScript.
		const root = join(sandbox.repoPath, "My Project");
		const dir = join(root, ".superset");
		mkdirSync(dir, { recursive: true });
		const cmdPath = join(dir, "run.cmd");
		writeFileSync(cmdPath, "@echo off\r\n", "utf-8");

		expect(
			resolveWorkspaceRunDefinition({
				repoPath: root,
				projectId: PROJECT_ID,
				platform: "darwin",
				shell: "/bin/zsh",
			}),
		).toBeNull();

		const winDef = resolveWorkspaceRunDefinition({
			repoPath: root,
			projectId: PROJECT_ID,
			platform: "win32",
			shell: "cmd.exe",
		});
		expect(winDef).toEqual({
			source: "project-config",
			projectId: PROJECT_ID,
			commands: [`"${cmdPath}" && exit /b 0 || exit /b 1`],
		});
	});

	it("threads shell into Windows quoting (cmd.exe vs PowerShell 5.1)", () => {
		const root = join(sandbox.repoPath, "My Project");
		const dir = join(root, ".superset");
		mkdirSync(dir, { recursive: true });
		const scriptPath = join(dir, "run.sh");
		writeFileSync(scriptPath, "#!/usr/bin/env bash\n", "utf-8");

		const cmdDef = resolveWorkspaceRunDefinition({
			repoPath: root,
			projectId: PROJECT_ID,
			platform: "win32",
			shell: "cmd.exe",
		});
		const psDef = resolveWorkspaceRunDefinition({
			repoPath: root,
			projectId: PROJECT_ID,
			platform: "win32",
			shell: "powershell.exe",
		});

		expect(cmdDef?.commands[0]).toBe(
			`bash "${scriptPath}" && exit /b 0 || exit /b 1`,
		);
		expect(psDef?.commands[0]).toBe(
			`bash '${scriptPath}'; if (-not $?) { exit 1 }`,
		);
		// Same host process.platform; only the shell arg changes quoting.
		expect(cmdDef?.commands[0]).not.toEqual(psDef?.commands[0]);
	});
});
