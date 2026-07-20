import fs from "node:fs";
import path from "node:path";
import { env } from "shared/env.shared";
import { HOOKS_DIR } from "./paths";

export const NOTIFY_SCRIPT_NAME = "notify.sh";
export const WINDOWS_NOTIFY_SCRIPT_NAME = "notify.cmd";
export const NOTIFY_SCRIPT_MARKER = "# Superset agent notification hook v3";
export const WINDOWS_NOTIFY_SCRIPT_MARKER =
	"rem Superset agent notification hook v3";

const NOTIFY_SCRIPT_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"notify-hook.template.sh",
);

function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function getNotifyScriptPath(): string {
	return path.join(HOOKS_DIR, NOTIFY_SCRIPT_NAME);
}

export function getWindowsNotifyScriptPath(): string {
	return path.join(HOOKS_DIR, WINDOWS_NOTIFY_SCRIPT_NAME);
}

export function getNotifyScriptContent(): string {
	const template = fs.readFileSync(NOTIFY_SCRIPT_TEMPLATE_PATH, "utf-8");
	return template
		.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

/**
 * Windows agent hooks need a native entrypoint. PowerShell is avoided here so
 * ConPTY/agent spawn paths do not require ExecutionPolicy changes; instead we
 * write a small Node dispatcher that POSTs the same completion payload as the
 * POSIX shell hook.
 */
export function getWindowsNotifyScriptContent(
	port: number = env.DESKTOP_NOTIFICATIONS_PORT,
): string {
	const dispatcher = `// ${WINDOWS_NOTIFY_SCRIPT_MARKER}
const http = require("node:http");
const port = process.env.SUPERSET_PORT || "${port}";
const params = new URLSearchParams({
  paneId: process.env.SUPERSET_PANE_ID || "",
  tabId: process.env.SUPERSET_TAB_ID || "",
  workspaceId: process.env.SUPERSET_WORKSPACE_ID || "",
  terminalId: process.env.SUPERSET_TERMINAL_ID || "",
  sessionId: process.env.SUPERSET_SESSION_ID || "",
  hookSessionId: process.env.SUPERSET_HOOK_SESSION_ID || "",
  resourceId: process.env.SUPERSET_RESOURCE_ID || "",
  eventType: process.env.SUPERSET_EVENT_TYPE || "Stop",
  env: process.env.SUPERSET_ENV || "",
  version: process.env.SUPERSET_HOOK_VERSION || "",
});
const req = http.get(
  \`http://127.0.0.1:\${port}/hook/complete?\${params.toString()}\`,
  (res) => { res.resume(); },
);
req.on("error", () => {});
req.setTimeout(2000, () => req.destroy());
`;

	return `@echo off\r\n${WINDOWS_NOTIFY_SCRIPT_MARKER}\r\nsetlocal\r\nwhere node >NUL 2>&1\r\nif errorlevel 1 exit /b 0\r\nnode -e ${JSON.stringify(dispatcher)}\r\nexit /b 0\r\n`;
}

export function createNotifyScript(
	platform: NodeJS.Platform = process.platform,
): void {
	fs.mkdirSync(HOOKS_DIR, { recursive: true });
	const notifyPath = getNotifyScriptPath();
	const script = getNotifyScriptContent();
	const changed = writeFileIfChanged(notifyPath, script, 0o755);
	const changedWindows =
		platform === "win32"
			? writeFileIfChanged(
					getWindowsNotifyScriptPath(),
					getWindowsNotifyScriptContent(),
					0o644,
				)
			: false;
	console.log(
		`[agent-setup] ${changed || changedWindows ? "Updated" : "Verified"} notify hook`,
	);
}
