import { spawn } from "node:child_process";
import { existsSync as fsExistsSync } from "node:fs";
import nodePath from "node:path";
import type { ExternalApp } from "@superset/local-db";

/** Map of app IDs to their macOS application names */
const MACOS_APP_NAMES: Record<ExternalApp, string | null> = {
	finder: null, // Handled specially with shell.showItemInFolder
	vscode: "Visual Studio Code",
	"vscode-insiders": "Visual Studio Code - Insiders",
	cursor: "Cursor",
	antigravity: "Antigravity",
	devin: "Devin",
	zed: "Zed",
	xcode: "Xcode",
	iterm: "iTerm",
	warp: "Warp",
	terminal: "Terminal",
	ghostty: "Ghostty",
	sublime: "Sublime Text",
	intellij: null, // Multi-edition, uses bundle IDs
	webstorm: "WebStorm",
	pycharm: null, // Multi-edition, uses bundle IDs
	phpstorm: "PhpStorm",
	rubymine: "RubyMine",
	goland: "GoLand",
	clion: "CLion",
	rider: "Rider",
	datagrip: "DataGrip",
	appcode: "AppCode",
	fleet: "Fleet",
	rustrover: "RustRover",
	"android-studio": "Android Studio",
};

/**
 * Bundle ID candidates for JetBrains IDEs with multiple editions.
 * `open -b <bundleId>` works regardless of the .app display name,
 * so "IntelliJ IDEA Ultimate.app" and "IntelliJ IDEA CE.app" both resolve correctly.
 */
const BUNDLE_ID_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
	pycharm: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
};

/** Map of app IDs to their Linux CLI commands */
const LINUX_CLI_COMMANDS: Record<ExternalApp, string | null> = {
	finder: null, // Handled specially with shell.showItemInFolder
	vscode: "code",
	"vscode-insiders": "code-insiders",
	cursor: "cursor",
	antigravity: "antigravity",
	devin: "devin-desktop",
	zed: "zed",
	xcode: null, // macOS only
	iterm: null, // macOS only
	warp: "warp-terminal",
	terminal: null, // No universal Linux terminal command
	ghostty: "ghostty",
	sublime: "subl",
	intellij: null, // Multi-edition, uses CLI candidates
	webstorm: "webstorm",
	pycharm: null, // Multi-edition, uses CLI candidates
	phpstorm: "phpstorm",
	rubymine: "rubymine",
	goland: "goland",
	clion: "clion",
	rider: "rider",
	datagrip: "datagrip",
	appcode: null, // macOS only
	fleet: "fleet",
	rustrover: "rustrover",
	"android-studio": "studio",
};

/**
 * CLI command candidates for JetBrains IDEs with multiple editions on Linux.
 * JetBrains Toolbox typically creates `idea`/`pycharm` launchers,
 * while package managers may use edition-specific names.
 */
const LINUX_CLI_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["idea", "intellij-idea-ultimate", "intellij-idea-community"],
	pycharm: ["pycharm", "pycharm-professional", "pycharm-community"],
};

/** Map of app IDs to their Windows CLI commands. */
const WINDOWS_CLI_COMMANDS: Record<ExternalApp, string | null> = {
	finder: null, // Handled specially with shell.showItemInFolder
	vscode: "code",
	"vscode-insiders": "code-insiders",
	cursor: "cursor",
	antigravity: "antigravity",
	devin: "devin",
	zed: "zed",
	xcode: null, // macOS only
	iterm: null, // macOS only
	warp: "warp",
	terminal: null, // macOS Terminal.app only
	ghostty: "ghostty",
	sublime: "subl",
	intellij: null, // Multi-edition, uses CLI candidates
	webstorm: "webstorm",
	pycharm: null, // Multi-edition, uses CLI candidates
	phpstorm: "phpstorm",
	rubymine: "rubymine",
	goland: "goland",
	clion: "clion",
	rider: "rider",
	datagrip: "datagrip",
	appcode: null, // macOS only
	fleet: "fleet",
	rustrover: "rustrover",
	"android-studio": "studio",
};

/**
 * CLI command candidates for JetBrains IDEs with multiple editions on Windows.
 * JetBrains Toolbox can install scripts without extensions, while direct
 * installs commonly expose the native executable names.
 */
const WINDOWS_CLI_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["idea", "idea64.exe", "idea.exe"],
	pycharm: ["pycharm", "pycharm64.exe", "pycharm.exe"],
};

/**
 * Get candidate commands to open a path in the specified app.
 * Returns an array of commands to try in order — for multi-edition apps (IntelliJ, PyCharm),
 * multiple candidates are returned so the caller can fall back if one isn't installed.
 *
 * macOS: Uses `open -b` (bundle ID) for multi-edition apps and `open -a` (app name) for others.
 * Linux: Uses direct CLI commands (e.g. `code`, `cursor`, `zed`).
 * Windows: Uses PATH/PATHEXT-resolved CLI commands (e.g. `code`, `cursor`, `pycharm64.exe`).
 */
export function getAppCommand(
	app: ExternalApp,
	targetPath: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] }[] | null {
	if (platform === "darwin") {
		const bundleIds = BUNDLE_ID_CANDIDATES[app];
		if (bundleIds) {
			return bundleIds.map((id) => ({
				command: "open",
				args: ["-b", id, targetPath],
			}));
		}

		const appName = MACOS_APP_NAMES[app];
		if (!appName) return null;
		return [{ command: "open", args: ["-a", appName, targetPath] }];
	}

	if (platform === "win32") {
		const windowsCandidates = WINDOWS_CLI_CANDIDATES[app];
		if (windowsCandidates) {
			return windowsCandidates.map((cmd) => ({
				command: cmd,
				args: [targetPath],
			}));
		}

		const cliCommand = WINDOWS_CLI_COMMANDS[app];
		if (!cliCommand) return null;
		return [{ command: cliCommand, args: [targetPath] }];
	}

	const linuxCandidates = LINUX_CLI_CANDIDATES[app];
	if (linuxCandidates) {
		return linuxCandidates.map((cmd) => ({
			command: cmd,
			args: [targetPath],
		}));
	}

	const cliCommand = LINUX_CLI_COMMANDS[app];
	if (!cliCommand) return null;
	return [{ command: cliCommand, args: [targetPath] }];
}

/**
 * Wrapper characters that can surround paths.
 * These are pairs of [open, close] characters.
 */
const PATH_WRAPPERS: [string, string][] = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["(", ")"],
	["[", "]"],
	["<", ">"],
];

/**
 * Trailing punctuation that can appear after paths in sentences.
 * These are stripped unless they're part of a valid suffix (extension, line:col).
 */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Check if a string looks like a file path.
 * A path typically contains forward slashes, or starts with ., ~, or /
 */
function looksLikePath(str: string): boolean {
	return (
		str.includes("/") ||
		str.startsWith(".") ||
		str.startsWith("~") ||
		str.startsWith("/")
	);
}

/**
 * Extract a path from within brackets/parentheses when there's adjacent text.
 * Handles patterns like:
 *   "text(src/file.ts)more" -> "src/file.ts"
 *   "see (path/to/file) here" -> "path/to/file"
 *   "in [src/file.ts:42]" -> "src/file.ts:42"
 *
 * Returns the original string if no embedded path is found.
 */
function extractEmbeddedPath(input: string): string {
	const bracketPairs: [string, string][] = [
		["(", ")"],
		["[", "]"],
		["<", ">"],
	];

	for (const [open, close] of bracketPairs) {
		const openIdx = input.indexOf(open);
		const closeIdx = input.lastIndexOf(close);

		if (openIdx !== -1 && closeIdx > openIdx) {
			const hasTextBefore = openIdx > 0;
			const hasTextAfter = closeIdx < input.length - 1;

			if (hasTextBefore || hasTextAfter) {
				const content = input.slice(openIdx + 1, closeIdx);
				if (looksLikePath(content)) {
					return content;
				}
			}
		}
	}

	return input;
}

/**
 * Strip trailing punctuation from a path, but preserve valid suffixes.
 * - Preserves file extensions like .ts, .json
 * - Preserves line:col suffixes like :42 or :42:10
 * - Strips sentence punctuation like trailing period, comma, etc.
 */
function stripTrailingPunctuation(path: string): string {
	const match = path.match(TRAILING_PUNCTUATION);
	if (!match) return path;

	const punct = match[0];
	const beforePunct = path.slice(0, -punct.length);

	// Don't strip if it looks like a file extension (e.g., "file.ts")
	if (punct === "." || punct.startsWith(".")) {
		const extMatch = beforePunct.match(/\.[a-zA-Z0-9]{1,10}$/);
		if (extMatch) {
			return beforePunct;
		}
		// e.g., path ends with ".ts." - strip just the final "."
		if (/^\.[a-zA-Z0-9]{1,10}\.$/.test(punct)) {
			return path.slice(0, -1);
		}
	}

	// Don't strip colons followed by digits (line numbers like :42)
	if (punct === ":") {
		return beforePunct;
	}
	if (punct.startsWith(":") && /^:\d/.test(punct)) {
		return path;
	}

	return beforePunct;
}

/**
 * Strip matching wrapper characters and trailing punctuation from a path.
 * Handles nested wrappers and multiple layers of wrapping.
 * Examples:
 *   "(path/to/file)" -> "path/to/file"
 *   '"path/to/file"' -> "path/to/file"
 *   "'(path/to/file)'" -> "path/to/file"
 *   "./path/file.ts." -> "./path/file.ts"
 *   '"./path/file.ts",' -> "./path/file.ts"
 *   "path/to/file" -> "path/to/file" (unchanged)
 */
export function stripPathWrappers(filePath: string): string {
	let result = filePath.trim();

	// First, try to extract embedded paths from patterns like "text(path)more"
	result = extractEmbeddedPath(result);

	let changed = true;
	while (changed && result.length > 0) {
		changed = false;

		const withoutPunct = stripTrailingPunctuation(result);
		if (withoutPunct !== result) {
			result = withoutPunct;
			changed = true;
			continue;
		}

		for (const [open, close] of PATH_WRAPPERS) {
			if (result.startsWith(open) && result.endsWith(close)) {
				result = result.slice(1, -1);
				changed = true;
				break;
			}
		}
	}

	return result;
}

export class RelativePathWithoutCwdError extends Error {
	readonly originalPath: string;
	constructor(originalPath: string) {
		super(
			`resolvePath received a relative path (${JSON.stringify(originalPath)}) without a cwd. ` +
				"Pass an absolute path, or supply cwd (e.g. the workspace worktreePath). " +
				"Falling back to process.cwd() would resolve against Electron's working directory and silently produce wrong paths.",
		);
		this.name = "RelativePathWithoutCwdError";
		this.originalPath = originalPath;
	}
}

/**
 * Resolve a path by expanding ~ and converting relative paths to absolute.
 * Also handles file:// URLs by converting them to regular file paths.
 * Strips wrapping characters like quotes, parentheses, brackets, etc.
 *
 * Throws `RelativePathWithoutCwdError` if the input resolves to a relative
 * path and no `cwd` was supplied — callers must be explicit about what
 * relative paths are relative to. (A silent `process.cwd()` fallback would
 * point at Electron's working directory, not the workspace.)
 */
export function resolvePath(filePath: string, cwd?: string): string {
	let resolved = stripPathWrappers(filePath);

	if (resolved.startsWith("file://")) {
		try {
			const url = new URL(resolved);
			resolved = decodeURIComponent(url.pathname);
		} catch {
			// If URL parsing fails, try simple prefix removal
			resolved = decodeURIComponent(resolved.replace(/^file:\/\//, ""));
		}
	}

	if (resolved.startsWith("~")) {
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home) {
			resolved = resolved.replace(/^~/, home);
		}
	}

	if (!nodePath.isAbsolute(resolved)) {
		if (!cwd) throw new RelativePathWithoutCwdError(filePath);
		resolved = nodePath.resolve(cwd, resolved);
	}

	return resolved;
}

/**
 * Quote a single argument for inclusion in a `cmd.exe /d /s /c` command line.
 * Always double-quotes; doubles embedded quotes; doubles `%` so env expansion
 * cannot reinterpret a path.
 */
export function quoteWindowsCmdArg(value: string): string {
	return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

/** True when the path/name is a Windows batch/cmd launcher. */
export function isWindowsBatchFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

/** Windows absolute path: drive letter or UNC. Independent of host path.posix. */
function isWindowsAbsolutePath(filePath: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\");
}

/** Join a Windows directory + name without depending on host path.sep. */
function joinWindowsPath(dir: string, name: string): string {
	if (!dir) return name;
	if (dir.endsWith("\\") || dir.endsWith("/")) return `${dir}${name}`;
	return `${dir}\\${name}`;
}

/**
 * Resolve a Windows command to an absolute executable/script path using PATH
 * and PATHEXT (preferring native `.exe` over `.cmd` when both exist).
 * Returns null when nothing is found — callers should still attempt a direct
 * spawn so the OS reports ENOENT cleanly.
 *
 * Uses Windows path rules even when unit tests run on macOS/Linux hosts.
 */
export function resolveWindowsCommandPath(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	existsSync: (path: string) => boolean = fsExistsSync,
): string | null {
	const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((ext) => ext.trim())
		.filter((ext) => ext.length > 0);

	const hasExtension = /\.[A-Za-z0-9]{1,10}$/.test(command);
	const isPathLike =
		isWindowsAbsolutePath(command) ||
		command.includes("\\") ||
		command.includes("/");

	const candidatesFor = (dir: string | null): string[] => {
		const base = dir ? joinWindowsPath(dir, command) : command;
		if (hasExtension) return [base];
		// Prefer PATHEXT order so .exe beats .cmd for bare names like "code".
		return pathExt.map((ext) => `${base}${ext}`);
	};

	const tryCandidates = (candidates: string[]): string | null => {
		for (const candidate of candidates) {
			try {
				if (existsSync(candidate)) return candidate;
			} catch {
				// Ignore unreadable path entries.
			}
		}
		return null;
	};

	if (isPathLike) {
		return tryCandidates(candidatesFor(null));
	}

	// Windows PATH is `;`-delimited regardless of the host that runs unit tests.
	const pathEntries = (env.PATH ?? env.Path ?? "").split(";");
	for (const dir of pathEntries) {
		if (!dir) continue;
		const found = tryCandidates(candidatesFor(dir));
		if (found) return found;
	}
	return null;
}

export type SpawnInvocation = {
	command: string;
	args: string[];
	/** Original user-facing command (for error messages). */
	displayCommand: string;
	options: {
		stdio: ["ignore", "ignore", "pipe"];
		detached: false;
		shell: false;
		windowsHide: boolean;
		windowsVerbatimArguments?: boolean;
	};
};

export type BuildSpawnInvocationOptions = {
	platform?: NodeJS.Platform;
	/** Pre-resolved absolute path (tests / callers that already resolved). */
	resolvedCommandPath?: string | null;
	comspec?: string;
	env?: NodeJS.ProcessEnv;
	existsSync?: (path: string) => boolean;
};

/**
 * Build a shell-free spawn invocation.
 *
 * - Non-Windows: direct spawn, argv preserved.
 * - Windows native `.exe` (and other non-batch): direct spawn, argv preserved —
 *   CreateProcess does not interpret cmd metacharacters in argv.
 * - Windows `.cmd`/`.bat` launchers (e.g. `code.cmd`, `cursor.cmd`): explicit
 *   `cmd.exe /d /s /c` adapter with robust quoting. Never `shell: true`.
 */
export function buildSpawnInvocation(
	command: string,
	args: string[],
	options: BuildSpawnInvocationOptions = {},
): SpawnInvocation {
	const platform = options.platform ?? process.platform;
	const baseOptions = {
		stdio: ["ignore", "ignore", "pipe"] as ["ignore", "ignore", "pipe"],
		detached: false as const,
		shell: false as const,
		windowsHide: platform === "win32",
	};

	if (platform !== "win32") {
		return {
			command,
			args,
			displayCommand: command,
			options: baseOptions,
		};
	}

	const resolved =
		options.resolvedCommandPath !== undefined
			? options.resolvedCommandPath
			: resolveWindowsCommandPath(
					command,
					options.env ?? process.env,
					options.existsSync ?? fsExistsSync,
				);
	const target = resolved ?? command;

	if (isWindowsBatchFile(target)) {
		// Explicit cmd.exe /d /s /c form. With /s, cmd strips the first and last
		// quote of the /c string, so the payload needs a distinct outer pair
		// around the complete command (inner per-token quotes preserved):
		//   ""C:\...\code.cmd" "C:\...\target with spaces""
		// See: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd
		const innerCmdline = [target, ...args].map(quoteWindowsCmdArg).join(" ");
		const cmdline = `"${innerCmdline}"`;
		const comspec =
			options.comspec ??
			options.env?.ComSpec ??
			options.env?.COMSPEC ??
			process.env.ComSpec ??
			process.env.COMSPEC ??
			"cmd.exe";
		return {
			command: comspec,
			args: ["/d", "/s", "/c", cmdline],
			displayCommand: command,
			options: {
				...baseOptions,
				// We already quoted for cmd; do not let Node re-escape.
				windowsVerbatimArguments: true,
			},
		};
	}

	// Native executable (or unresolved bare name): preserve argv boundaries.
	return {
		command: target,
		args,
		displayCommand: command,
		options: baseOptions,
	};
}

/**
 * Spawns a process and waits for it to complete.
 * Never uses `shell: true` — Windows batch launchers go through an explicit
 * quoted `cmd.exe /d /s /c` adapter; native executables are spawned shell-free.
 *
 * @throws Error if the process exits with non-zero code or fails to spawn
 */
export function spawnAsync(command: string, args: string[]): Promise<void> {
	const invocation = buildSpawnInvocation(command, args);

	return new Promise((resolve, reject) => {
		const child = spawn(
			invocation.command,
			invocation.args,
			invocation.options,
		);

		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			reject(
				new Error(
					`Failed to spawn '${invocation.displayCommand}': ${error.message}. Ensure the application is installed.`,
				),
			);
		});

		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				const stderrMessage = stderr.trim();
				reject(
					new Error(
						stderrMessage ||
							`'${invocation.displayCommand}' exited with code ${code}`,
					),
				);
			}
		});
	});
}

export type { ExternalApp };
