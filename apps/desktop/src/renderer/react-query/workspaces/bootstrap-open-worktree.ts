import {
	ensureTerminalAttached,
	launchCommandsInPane,
} from "renderer/lib/terminal/launch-command";

interface OpenWorkspaceData {
	workspace: { id: string };
	initialCommands?: string[] | null;
}

export type BootstrapOpenWorktreeError =
	| "create_or_attach_failed"
	| "write_initial_commands_failed";

interface BootstrapOpenWorktreeOptions {
	data: OpenWorkspaceData;
	addTab: (workspaceId: string) => { tabId: string; paneId: string };
	setTabAutoTitle: (tabId: string, title: string) => void;
	createOrAttach: (input: {
		paneId: string;
		tabId: string;
		workspaceId: string;
		joinPending?: boolean;
	}) => Promise<unknown>;
	writeCommandsToTerminal: (input: {
		paneId: string;
		commands: string[];
		cwd?: string;
		throwOnError?: boolean;
	}) => Promise<unknown>;
}

export async function bootstrapOpenWorktree(
	options: BootstrapOpenWorktreeOptions,
): Promise<BootstrapOpenWorktreeError | null> {
	const initialCommands = (options.data.initialCommands ?? []).filter(
		(command) => command.trim().length > 0,
	);

	const { tabId, paneId } = options.addTab(options.data.workspace.id);
	if (initialCommands.length > 0) {
		options.setTabAutoTitle(tabId, "Workspace Setup");
	}

	if (initialCommands.length === 0) {
		try {
			await ensureTerminalAttached({
				paneId,
				tabId,
				workspaceId: options.data.workspace.id,
				createOrAttach: options.createOrAttach,
			});
		} catch (error) {
			console.error(
				"[bootstrapOpenWorktree] Failed to create or attach:",
				error,
			);
			return "create_or_attach_failed";
		}
		return null;
	}

	try {
		await launchCommandsInPane({
			paneId,
			tabId,
			workspaceId: options.data.workspace.id,
			commands: initialCommands,
			createOrAttach: options.createOrAttach,
			writeCommands: options.writeCommandsToTerminal,
		});
		return null;
	} catch (error) {
		// Distinguish attach vs write failures when possible.
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("create") ||
			message.includes("attach") ||
			message.includes("not found")
		) {
			console.error(
				"[bootstrapOpenWorktree] Failed to create or attach:",
				error,
			);
			return "create_or_attach_failed";
		}
		console.error(
			"[bootstrapOpenWorktree] Failed to write initial commands:",
			error,
		);
		return "write_initial_commands_failed";
	}
}
