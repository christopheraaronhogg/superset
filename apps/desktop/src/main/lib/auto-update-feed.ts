/**
 * Durable auto-update feed URLs for electron-updater (generic provider).
 *
 * Streams must not share GitHub's mutable `/releases/latest` pointer when a
 * lane publishes versioned tags with `--latest=false` (or when multiple
 * product streams coexist in one repo).
 *
 * - macOS/Linux stable → `/releases/latest/download` (upstream desktop-v*)
 * - Windows stable → rolling `windows-latest` tag (mirrors canary pattern)
 * - Canary (all platforms) → rolling `desktop-canary` tag
 */

/** Rolling GitHub release/tag that always holds the current Windows stable assets. */
export const WINDOWS_STABLE_UPDATE_TAG = "windows-latest";

/** Rolling GitHub release/tag for desktop canary builds. */
export const DESKTOP_CANARY_UPDATE_TAG = "desktop-canary";

export const DEFAULT_GITHUB_REPO_SLUG = "superset-sh/superset";

export type UpdateFeedPlatform = "darwin" | "linux" | "win32" | string;

export function resolveGithubRepoSlug(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
	const fromEnv = env.GITHUB_REPOSITORY?.trim();
	if (fromEnv?.includes("/")) return fromEnv;
	// Upstream/local default. Fork Windows builds inject GITHUB_REPOSITORY in CI
	// so installers point electron-updater at the fork release feed.
	return DEFAULT_GITHUB_REPO_SLUG;
}

/**
 * Resolve the electron-updater generic feed base URL (directory containing
 * latest.yml / latest-mac.yml / latest-linux.yml).
 */
export function resolveUpdateFeedUrl(options: {
	repoSlug: string;
	isPrerelease: boolean;
	platform: UpdateFeedPlatform;
}): string {
	const { repoSlug, isPrerelease, platform } = options;
	const base = `https://github.com/${repoSlug}/releases`;

	if (isPrerelease) {
		return `${base}/download/${DESKTOP_CANARY_UPDATE_TAG}`;
	}

	// Windows stable uses a dedicated rolling tag so windows-v* versioned
	// releases can stay off GitHub's global "latest" pointer (preserves
	// upstream macOS/Linux /releases/latest feeds).
	if (platform === "win32") {
		return `${base}/download/${WINDOWS_STABLE_UPDATE_TAG}`;
	}

	return `${base}/latest/download`;
}
