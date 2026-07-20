import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { projects } from "../../../db/schema";
import {
	getProjectConfigPath,
	hasConfiguredScripts,
	loadSetupConfig,
	resolveScript,
	type SetupConfig,
} from "../../../runtime/setup/config";
import { getTerminalBaseEnv } from "../../../terminal/env";
import { resolveLaunchShell } from "../../../terminal/shell-launch";
import type { HostServiceContext } from "../../../types";
import { protectedProcedure, router } from "../../index";
import { buildSetupScriptCommand } from "../workspace-creation/shared/setup-terminal";

const projectIdInput = z.object({ projectId: z.string().uuid() });

const stringArray = z.array(z.string());

function requireProject(
	ctx: HostServiceContext,
	projectId: string,
): { id: string; repoPath: string } {
	const row = ctx.db.query.projects
		.findFirst({ where: eq(projects.id, projectId) })
		.sync();
	if (!row || !row.repoPath) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: `Project not set up locally: ${projectId}`,
		});
	}
	return { id: row.id, repoPath: row.repoPath };
}

/**
 * Resolve workspace run as a command array for terminal launch (v1 + v2).
 *
 * Configured `run: []` commands are returned as-is. Discovered scripts use the
 * same shell/platform-aware invocation as setup/teardown so Windows extensions
 * (`.ts`/`.cmd`/`.bat`/`.ps1`/`.sh`) are not forced through POSIX `bash '…'`.
 *
 * Exported for tests so platform/shell can be forced without mocking process.
 */
export function resolveWorkspaceRunDefinition(args: {
	repoPath: string;
	projectId: string;
	/** Override $HOME for tests. */
	homeDir?: string;
	shell?: string;
	platform?: NodeJS.Platform;
}): {
	source: "project-config";
	projectId: string;
	commands: string[];
	cwd?: string;
} | null {
	const platform = args.platform ?? process.platform;
	const resolved = resolveScript("run", {
		repoPath: args.repoPath,
		projectId: args.projectId,
		...(args.homeDir !== undefined && { homeDir: args.homeDir }),
		platform,
	});
	if (!resolved) return null;

	const commands =
		resolved.kind === "commands"
			? resolved.commands
			: [buildSetupScriptCommand(resolved.scriptPath, args.shell, platform)];

	return {
		source: "project-config" as const,
		projectId: args.projectId,
		commands,
		...(resolved.cwd && { cwd: resolved.cwd }),
	};
}

/** Same launch-shell source as setup/teardown terminal sessions. */
function resolveRunShell(): string | undefined {
	try {
		return resolveLaunchShell(getTerminalBaseEnv());
	} catch {
		return undefined;
	}
}

export const configRouter = router({
	/**
	 * Decide whether the v2 sidebar setup-script CTA should show for a project.
	 * Returns true only when no source (main repo, user override, local overlay)
	 * defines any setup/teardown/run commands. Renderer also gates on a
	 * client-side dismissal store, so this only answers "is config empty".
	 */
	shouldShowSetupCard: protectedProcedure
		.input(projectIdInput)
		.query(({ ctx, input }) => {
			const project = requireProject(ctx, input.projectId);
			const config = loadSetupConfig({
				repoPath: project.repoPath,
				projectId: project.id,
			});
			return !hasConfiguredScripts(config);
		}),

	/**
	 * Read the canonical config file. Returns null content when the file is
	 * absent — the editor renders an empty form in that case and creates the
	 * file on first save via updateConfig.
	 */
	getConfigContent: protectedProcedure
		.input(projectIdInput)
		.query(({ ctx, input }) => {
			const project = requireProject(ctx, input.projectId);
			const configPath = getProjectConfigPath(project.repoPath);
			if (!existsSync(configPath)) {
				return { content: null as string | null, exists: false };
			}
			try {
				return {
					content: readFileSync(configPath, "utf-8") as string | null,
					exists: true,
				};
			} catch (error) {
				console.error(
					`[config.getConfigContent] failed to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return { content: null as string | null, exists: false };
			}
		}),

	/**
	 * Write setup/teardown to the project's config.json, preserving any other
	 * existing top-level keys. Omitted script keys are preserved so narrow
	 * editors can update one script without clobbering another.
	 */
	updateConfig: protectedProcedure
		.input(
			z.object({
				projectId: z.string().uuid(),
				setup: stringArray.optional(),
				teardown: stringArray.optional(),
				run: stringArray.optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const project = requireProject(ctx, input.projectId);
			const configPath = getProjectConfigPath(project.repoPath);
			mkdirSync(dirname(configPath), { recursive: true });

			let existing: Record<string, unknown> = {};
			if (existsSync(configPath)) {
				try {
					const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						existing = parsed as Record<string, unknown>;
					}
				} catch {
					existing = {};
				}
			}

			const merged: SetupConfig & Record<string, unknown> = {
				...existing,
				...(input.setup !== undefined && { setup: input.setup }),
				...(input.teardown !== undefined && { teardown: input.teardown }),
				...(input.run !== undefined && { run: input.run }),
			};

			try {
				writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");
			} catch (error) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Failed to write config: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
			return { success: true as const };
		}),

	getWorkspaceRunDefinition: protectedProcedure
		.input(projectIdInput)
		.query(({ ctx, input }) => {
			const project = requireProject(ctx, input.projectId);
			return resolveWorkspaceRunDefinition({
				repoPath: project.repoPath,
				projectId: project.id,
				shell: resolveRunShell(),
			});
		}),
});
