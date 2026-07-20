import { buildShellCommandChain, getKnownShell } from "@superset/shared/shell";
import { eq } from "drizzle-orm";
import { projects, workspaces } from "../../../../db/schema";
import {
	resolveScript,
	shellSingleQuote,
} from "../../../../runtime/setup/config";
import { getTerminalBaseEnv } from "../../../../terminal/env";
import { resolveLaunchShell } from "../../../../terminal/shell-launch";
import { createTerminalSessionInternal } from "../../../../terminal/terminal";
import type { HostServiceContext } from "../../../../types";
import type { TerminalDescriptor } from "./types";

interface StartSetupTerminalArgs {
	ctx: HostServiceContext;
	workspaceId: string;
}

interface StartSetupTerminalResult {
	terminal: TerminalDescriptor | null;
	warning: string | null;
}

/**
 * Resolve and start the workspace-creation setup terminal, if any.
 *
 * Source order is the shared lifecycle-script posture (see `resolveScript`):
 * configured `setup` commands (joined with a shell-aware short-circuit so
 * failures stop the chain; worktree config overrides the main repo's), then
 * `bash .superset/setup.sh` (worktree first, then main repo). Scripts that need
 * the canonical `.superset/` dir read `$SUPERSET_ROOT_PATH`, injected by the v2
 * terminal env builder. Configured `cwd` is honored via the terminal session.
 *
 * No-op when no source resolves to anything runnable.
 */
export async function startSetupTerminalIfPresent(
	args: StartSetupTerminalArgs,
): Promise<StartSetupTerminalResult> {
	const row = args.ctx.db
		.select({
			worktreePath: workspaces.worktreePath,
			repoPath: projects.repoPath,
			projectId: workspaces.projectId,
		})
		.from(workspaces)
		.innerJoin(projects, eq(projects.id, workspaces.projectId))
		.where(eq(workspaces.id, args.workspaceId))
		.get();

	if (!row || !row.worktreePath || !row.repoPath) {
		return { terminal: null, warning: null };
	}

	const resolved = resolveInitialCommand({
		repoPath: row.repoPath,
		projectId: row.projectId,
		worktreePath: row.worktreePath,
		shell: resolveSetupShell(),
	});
	if (!resolved) {
		return { terminal: null, warning: null };
	}

	const terminalId = crypto.randomUUID();
	const result = await createTerminalSessionInternal({
		terminalId,
		workspaceId: args.workspaceId,
		db: args.ctx.db,
		eventBus: args.ctx.eventBus,
		initialCommand: resolved.initialCommand,
		...(resolved.cwd && { cwd: resolved.cwd }),
	});
	if ("error" in result) {
		return {
			terminal: null,
			warning: `Failed to start setup terminal: ${result.error}`,
		};
	}

	return {
		terminal: {
			id: terminalId,
			role: "setup",
			label: "Workspace Setup",
		},
		warning: null,
	};
}

/** Exported for tests. Resolves the initial command for the setup terminal. */
export function resolveInitialCommand(args: {
	repoPath: string;
	projectId: string;
	worktreePath?: string;
	/** Override $HOME for tests. */
	homeDir?: string;
	shell?: string;
	platform?: NodeJS.Platform;
}): { initialCommand: string; cwd?: string } | null {
	const platform = args.platform ?? process.platform;
	const resolved = resolveScript("setup", {
		...args,
		platform,
	});
	if (!resolved) return null;

	const initialCommand =
		resolved.kind === "commands"
			? buildSetupCommand(resolved.commands, args.shell, platform)
			: buildSetupScriptCommand(resolved.scriptPath, args.shell, platform);
	return { initialCommand, ...(resolved.cwd && { cwd: resolved.cwd }) };
}

export function buildSetupCommand(
	commands: string[],
	shell?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	return buildShellCommandChain(commands, {
		shell,
		platform,
		mode: "exit-on-failure",
	});
}

export function buildSetupScriptCommand(
	scriptPath: string,
	shell?: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32") {
		const knownShell = shell ? getKnownShell(shell) : "unknown";
		const lower = scriptPath.toLowerCase();
		if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
			if (knownShell === "powershell" || knownShell === "pwsh") {
				return `cmd.exe /d /s /c ${powershellSingleQuote(doubleQuote(scriptPath))}; if (-not $?) { exit 1 }`;
			}
			return `${doubleQuote(scriptPath)} && exit /b 0 || exit /b 1`;
		}
		if (lower.endsWith(".ps1")) {
			if (knownShell === "cmd" || knownShell === "unknown") {
				return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${doubleQuote(scriptPath)} && exit /b 0 || exit /b 1`;
			}
			return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${powershellSingleQuote(scriptPath)}; if (-not $?) { exit 1 }`;
		}
		// Portable .ts / .sh on Windows: prefer bun for .ts; run .sh via Git Bash
		// with shell-specific Windows quoting (POSIX single quotes are not
		// quoting syntax in cmd.exe / PowerShell).
		if (lower.endsWith(".ts")) {
			if (knownShell === "cmd") {
				return `bun ${doubleQuote(scriptPath)} && exit /b 0 || exit /b 1`;
			}
			if (knownShell === "powershell" || knownShell === "pwsh") {
				return `bun ${powershellSingleQuote(scriptPath)}; if (-not $?) { exit 1 }`;
			}
			return `bun ${doubleQuote(scriptPath)}`;
		}
		if (lower.endsWith(".sh")) {
			if (knownShell === "powershell" || knownShell === "pwsh") {
				return `bash ${powershellSingleQuote(scriptPath)}; if (-not $?) { exit 1 }`;
			}
			if (knownShell === "cmd" || knownShell === "unknown") {
				return `bash ${doubleQuote(scriptPath)} && exit /b 0 || exit /b 1`;
			}
			// Session shell is already Git Bash / POSIX: single-quote the path.
			return `bash ${shellSingleQuote(scriptPath)}`;
		}
	}

	return `bash ${shellSingleQuote(scriptPath)}`;
}

function powershellSingleQuote(s: string): string {
	return `'${s.replaceAll("'", "''")}'`;
}

function doubleQuote(s: string): string {
	return `"${s.replaceAll('"', '\\"')}"`;
}

function resolveSetupShell(): string | undefined {
	try {
		return resolveLaunchShell(getTerminalBaseEnv());
	} catch {
		return undefined;
	}
}
