import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildTeardownCommandFromShell,
	buildTeardownInitialCommand,
	resolveTeardownCommand,
} from "./teardown";

function isFishAvailable(): boolean {
	const result = spawnSync("fish", ["-c", "exit 0"], { stdio: "ignore" });
	return result.status === 0;
}

describe("teardown initial command", () => {
	test("uses exec instead of shell-specific exit status syntax", () => {
		const command = buildTeardownInitialCommand(
			"/tmp/worktree/.superset/teardown.sh",
		);

		expect(command).toBe("exec bash '/tmp/worktree/.superset/teardown.sh'");
		expect(command).not.toContain("$?");
	});

	test("shell-command form runs via `bash -c` and avoids $?", () => {
		const command = buildTeardownCommandFromShell(
			"docker compose down && rm -rf .cache",
		);

		expect(command).toBe("exec bash -c 'docker compose down && rm -rf .cache'");
		expect(command).not.toContain("$?");
	});

	test("shell-command form single-quote-escapes the command", () => {
		expect(buildTeardownCommandFromShell("echo 'bye'")).toBe(
			"exec bash -c 'echo '\\''bye'\\'''",
		);
	});

	test("cmd.exe teardown scripts short-circuit on Windows", () => {
		const command = buildTeardownInitialCommand(
			String.raw`C:\wt\.superset\teardown.cmd`,
			"cmd.exe",
			"win32",
		);
		expect(command).toBe(
			String.raw`"C:\wt\.superset\teardown.cmd" && exit /b 0 || exit /b 1`,
		);
	});

	test("cmd.exe runs Windows teardown.sh via Git Bash with double-quote paths (spaces)", () => {
		const command = buildTeardownInitialCommand(
			String.raw`C:\Users\me\My Project\.superset\teardown.sh`,
			"cmd.exe",
			"win32",
		);
		expect(command).toBe(
			String.raw`bash "C:\Users\me\My Project\.superset\teardown.sh" && exit /b 0 || exit /b 1`,
		);
		// Neither POSIX `exec` nor single-quote path form — both break in cmd.exe.
		expect(command).not.toContain("exec bash");
		expect(command).not.toContain("'C:");
		expect(command).not.toMatch(/^bash '/);
	});

	test("PowerShell 5.1 runs Windows teardown.sh via Git Bash with single-quote paths (spaces)", () => {
		const command = buildTeardownInitialCommand(
			String.raw`C:\Users\me\My Project\.superset\teardown.sh`,
			"powershell.exe",
			"win32",
		);
		expect(command).toBe(
			String.raw`bash 'C:\Users\me\My Project\.superset\teardown.sh'; exit $LASTEXITCODE`,
		);
		expect(command).not.toContain("exec bash");
		expect(command).not.toMatch(/bash "/);
	});

	test("PowerShell teardown command chains short-circuit on Windows", () => {
		const command = buildTeardownCommandFromShell(
			"docker compose down; if (-not $?) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }; rm -r .cache",
			"powershell.exe",
			"win32",
		);
		expect(command).toContain("exit $LASTEXITCODE");
		expect(command).not.toContain("bash -c");
	});

	test("exits fish with the teardown script status", () => {
		if (!isFishAvailable()) return;

		const root = mkdtempSync(join(tmpdir(), "host-service-teardown-"));
		const dirWithQuote = join(root, "quote's dir");
		const scriptPath = join(dirWithQuote, "teardown.sh");

		try {
			mkdirSync(dirWithQuote, { recursive: true });
			writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 7\n", {
				mode: 0o755,
			});
			chmodSync(scriptPath, 0o755);

			const result = spawnSync("fish", [
				"-c",
				buildTeardownInitialCommand(scriptPath),
			]);

			expect(result.status).toBe(7);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("resolveTeardownCommand", () => {
	function makeSandbox(): {
		repoPath: string;
		homeDir: string;
		cleanup: () => void;
	} {
		const root = mkdtempSync(join(tmpdir(), "host-service-teardown-resolve-"));
		const repoPath = join(root, "repo");
		const homeDir = join(root, "home");
		mkdirSync(join(repoPath, ".superset"), { recursive: true });
		mkdirSync(homeDir, { recursive: true });
		return {
			repoPath,
			homeDir,
			cleanup: () => rmSync(root, { recursive: true, force: true }),
		};
	}

	function writeConfig(repoPath: string, config: unknown): void {
		writeFileSync(
			join(repoPath, ".superset", "config.json"),
			JSON.stringify(config),
		);
	}

	// Reproduces #5486: configured `teardown` commands must run on delete.
	// Before the fix, teardown never consulted the resolved config and
	// silently skipped when no teardown.sh script existed.
	test("runs configured teardown commands from .superset/config.json", () => {
		const sb = makeSandbox();
		try {
			writeConfig(sb.repoPath, {
				setup: ["bash setup.sh"],
				teardown: ["docker compose down", "bash teardown.sh"],
			});

			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath: join(sb.repoPath, ".worktrees", "feature"),
				homeDir: sb.homeDir,
			});

			expect(resolved).toEqual({
				initialCommand:
					"exec bash -c 'docker compose down && bash teardown.sh'",
			});
		} finally {
			sb.cleanup();
		}
	});

	test("configured teardown takes precedence over a teardown.sh script", () => {
		const sb = makeSandbox();
		try {
			writeConfig(sb.repoPath, { teardown: ["echo configured"] });
			writeFileSync(
				join(sb.repoPath, ".superset", "teardown.sh"),
				"#!/usr/bin/env bash\n",
			);

			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath: join(sb.repoPath, ".worktrees", "feature"),
				homeDir: sb.homeDir,
			});

			expect(resolved).toEqual({
				initialCommand: "exec bash -c 'echo configured'",
			});
		} finally {
			sb.cleanup();
		}
	});

	test("falls back to <repoPath>/.superset/teardown.sh when no teardown is configured", () => {
		const sb = makeSandbox();
		try {
			// Config exists but only defines setup — teardown must fall back.
			// The main repo is the source, matching setup.sh resolution:
			// gitignored scripts don't exist in worktrees.
			writeConfig(sb.repoPath, { setup: ["bash setup.sh"] });
			const scriptPath = join(sb.repoPath, ".superset", "teardown.sh");
			writeFileSync(scriptPath, "#!/usr/bin/env bash\n");

			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath: join(sb.repoPath, ".worktrees", "feature"),
				homeDir: sb.homeDir,
			});

			expect(resolved).toEqual({ initialCommand: `exec bash '${scriptPath}'` });
		} finally {
			sb.cleanup();
		}
	});

	test("worktree teardown.sh wins over the main repo copy", () => {
		const sb = makeSandbox();
		try {
			writeFileSync(
				join(sb.repoPath, ".superset", "teardown.sh"),
				"#!/usr/bin/env bash\n",
			);
			const worktreePath = join(sb.repoPath, ".worktrees", "feature");
			mkdirSync(join(worktreePath, ".superset"), { recursive: true });
			const worktreeScript = join(worktreePath, ".superset", "teardown.sh");
			writeFileSync(worktreeScript, "#!/usr/bin/env bash\n");

			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath,
				homeDir: sb.homeDir,
			});

			expect(resolved).toEqual({
				initialCommand: `exec bash '${worktreeScript}'`,
			});
		} finally {
			sb.cleanup();
		}
	});

	test("carries config cwd for the teardown session", () => {
		const sb = makeSandbox();
		try {
			writeConfig(sb.repoPath, {
				teardown: ["docker compose down"],
				cwd: "apps/web",
			});

			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath: join(sb.repoPath, ".worktrees", "feature"),
				homeDir: sb.homeDir,
			});

			expect(resolved).toEqual({
				initialCommand: "exec bash -c 'docker compose down'",
				cwd: "apps/web",
			});
		} finally {
			sb.cleanup();
		}
	});

	test("returns null (skipped) when neither config nor script provides a teardown", () => {
		const sb = makeSandbox();
		try {
			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath: join(sb.repoPath, ".worktrees", "feature"),
				homeDir: sb.homeDir,
			});

			expect(resolved).toBeNull();
		} finally {
			sb.cleanup();
		}
	});

	test("discovers Windows teardown.cmd fallback without bash", () => {
		const sb = makeSandbox();
		try {
			const scriptPath = join(sb.repoPath, ".superset", "teardown.cmd");
			writeFileSync(scriptPath, "@echo off\r\n");

			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath: join(sb.repoPath, ".worktrees", "feature"),
				homeDir: sb.homeDir,
				platform: "win32",
				shell: "cmd.exe",
			});

			expect(resolved?.initialCommand).toContain(scriptPath);
			expect(resolved?.initialCommand).not.toContain("exec bash");
			expect(resolved?.initialCommand).toContain("exit /b");
		} finally {
			sb.cleanup();
		}
	});

	test("chains PowerShell teardown commands without && (PS 5.1)", () => {
		const sb = makeSandbox();
		try {
			writeConfig(sb.repoPath, {
				teardown: ["docker compose down", "rm -rf .cache"],
			});

			const resolved = resolveTeardownCommand({
				repoPath: sb.repoPath,
				projectId: "proj-1",
				worktreePath: join(sb.repoPath, ".worktrees", "feature"),
				homeDir: sb.homeDir,
				platform: "win32",
				shell: "powershell.exe",
			});

			expect(resolved?.initialCommand).not.toContain(" && ");
			expect(resolved?.initialCommand).toContain("if (-not $?)");
			expect(resolved?.initialCommand).not.toContain("exec bash");
		} finally {
			sb.cleanup();
		}
	});
});
