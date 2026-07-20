import { waitForTerminalSessionReady } from "./session-readiness";

interface TerminalCreateOrAttachInput {
	paneId: string;
	tabId: string;
	workspaceId: string;
	cwd?: string;
	joinPending?: boolean;
}

interface TerminalWriteInput {
	paneId: string;
	data: string;
	throwOnError?: boolean;
}

interface LaunchCommandInPaneOptions {
	paneId: string;
	tabId: string;
	workspaceId: string;
	command: string;
	cwd?: string;
	createOrAttach: (input: TerminalCreateOrAttachInput) => Promise<unknown>;
	write: (input: TerminalWriteInput) => Promise<unknown>;
	noExecute?: boolean;
	/**
	 * Only use this for panes that will mount immediately in the active tab.
	 * Background tabs must use the helper-side attach path instead.
	 */
	waitForMountedSession?: boolean;
}

export function normalizeTerminalCommand(command: string): string {
	return command.endsWith("\n") ? command : `${command}\n`;
}

interface WriteCommandInPaneOptions {
	paneId: string;
	command: string;
	write: (input: TerminalWriteInput) => Promise<unknown>;
	noExecute?: boolean;
}

interface WriteCommandsInPaneOptions {
	paneId: string;
	commands: string[] | null | undefined;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

export function buildTerminalCommand(
	commands: string[] | null | undefined,
	options?: { shell?: string | null; platform?: string },
): string | null {
	if (!Array.isArray(commands) || commands.length === 0) return null;
	// Lazy import avoidance: keep this renderer-safe. PowerShell chaining is
	// only applied when the caller knows the interactive shell is PowerShell.
	const platform =
		options?.platform ??
		(typeof process !== "undefined" ? process.platform : undefined);
	const shell = (options?.shell ?? "").toLowerCase();
	const isPowerShell =
		platform === "win32" &&
		(shell.includes("powershell") ||
			shell.endsWith("pwsh") ||
			shell.includes("\\pwsh"));
	if (isPowerShell) {
		return commands
			.map((command, index) =>
				index === 0 ? command : `if ($?) { ${command} }`,
			)
			.join("; ");
	}
	return commands.join(" && ");
}

export async function writeCommandInPane({
	paneId,
	command,
	write,
	noExecute,
}: WriteCommandInPaneOptions): Promise<void> {
	const data = noExecute ? command : normalizeTerminalCommand(command);
	await write({
		paneId,
		data,
		throwOnError: true,
	});
}

export async function writeCommandsInPane({
	paneId,
	commands,
	write,
}: WriteCommandsInPaneOptions): Promise<void> {
	const command = buildTerminalCommand(commands);
	if (!command) return;
	await writeCommandInPane({ paneId, command, write });
}

export async function launchCommandInPane({
	paneId,
	tabId,
	workspaceId,
	command,
	cwd,
	createOrAttach,
	write,
	noExecute,
	waitForMountedSession,
}: LaunchCommandInPaneOptions): Promise<void> {
	if (waitForMountedSession) {
		await waitForTerminalSessionReady(paneId);
		await writeCommandInPane({ paneId, command, write, noExecute });
		return;
	}

	await ensureTerminalAttached({
		paneId,
		tabId,
		workspaceId,
		cwd,
		createOrAttach,
	});

	await writeCommandInPane({ paneId, command, write, noExecute });
}

export async function ensureTerminalAttached({
	paneId,
	tabId,
	workspaceId,
	cwd,
	createOrAttach,
}: {
	paneId: string;
	tabId: string;
	workspaceId: string;
	cwd?: string;
	createOrAttach: (input: TerminalCreateOrAttachInput) => Promise<unknown>;
}): Promise<void> {
	await createOrAttach({
		paneId,
		tabId,
		workspaceId,
		cwd,
		joinPending: true,
	});
}
