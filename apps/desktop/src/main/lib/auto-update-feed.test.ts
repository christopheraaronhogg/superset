import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_GITHUB_REPO_SLUG,
	DESKTOP_CANARY_UPDATE_TAG,
	resolveGithubRepoSlug,
	resolveUpdateFeedUrl,
	WINDOWS_STABLE_UPDATE_TAG,
} from "./auto-update-feed";

const REPO_ROOT = join(import.meta.dir, "../../../../../");

describe("resolveGithubRepoSlug", () => {
	test("prefers GITHUB_REPOSITORY when set", () => {
		expect(
			resolveGithubRepoSlug({
				GITHUB_REPOSITORY: "christopheraaronhogg/superset",
			}),
		).toBe("christopheraaronhogg/superset");
	});

	test("falls back to upstream slug", () => {
		expect(resolveGithubRepoSlug({})).toBe(DEFAULT_GITHUB_REPO_SLUG);
		expect(resolveGithubRepoSlug({ GITHUB_REPOSITORY: "  " })).toBe(
			DEFAULT_GITHUB_REPO_SLUG,
		);
		expect(resolveGithubRepoSlug({ GITHUB_REPOSITORY: "not-a-slug" })).toBe(
			DEFAULT_GITHUB_REPO_SLUG,
		);
	});
});

describe("resolveUpdateFeedUrl", () => {
	const fork = "christopheraaronhogg/superset";

	test("canary uses desktop-canary on every platform", () => {
		for (const platform of ["darwin", "linux", "win32"] as const) {
			expect(
				resolveUpdateFeedUrl({
					repoSlug: fork,
					isPrerelease: true,
					platform,
				}),
			).toBe(
				`https://github.com/${fork}/releases/download/${DESKTOP_CANARY_UPDATE_TAG}`,
			);
		}
	});

	test("macOS/Linux stable use GitHub /releases/latest (upstream desktop feed)", () => {
		expect(
			resolveUpdateFeedUrl({
				repoSlug: DEFAULT_GITHUB_REPO_SLUG,
				isPrerelease: false,
				platform: "darwin",
			}),
		).toBe(
			`https://github.com/${DEFAULT_GITHUB_REPO_SLUG}/releases/latest/download`,
		);
		expect(
			resolveUpdateFeedUrl({
				repoSlug: DEFAULT_GITHUB_REPO_SLUG,
				isPrerelease: false,
				platform: "linux",
			}),
		).toBe(
			`https://github.com/${DEFAULT_GITHUB_REPO_SLUG}/releases/latest/download`,
		);
	});

	test("Windows stable uses rolling windows-latest tag, not /releases/latest", () => {
		const url = resolveUpdateFeedUrl({
			repoSlug: fork,
			isPrerelease: false,
			platform: "win32",
		});
		expect(url).toBe(
			`https://github.com/${fork}/releases/download/${WINDOWS_STABLE_UPDATE_TAG}`,
		);
		expect(url).not.toContain("/releases/latest/");
	});
});

describe("Windows release workflow ↔ runtime feed contract", () => {
	const workflowPath = join(
		REPO_ROOT,
		".github/workflows/release-desktop-windows.yml",
	);
	const workflow = readFileSync(workflowPath, "utf8");

	test("publishes the rolling windows-latest feed tag used by the runtime", () => {
		expect(WINDOWS_STABLE_UPDATE_TAG).toBe("windows-latest");
		// Versioned releases stay off the global latest pointer.
		expect(workflow).toMatch(/--latest=false/);
		// Rolling durable feed must be updated with the same artifacts.
		expect(workflow).toContain(WINDOWS_STABLE_UPDATE_TAG);
		expect(workflow).toMatch(
			new RegExp(
				`gh release (create|upload|delete).*${WINDOWS_STABLE_UPDATE_TAG}|tag_name:.*${WINDOWS_STABLE_UPDATE_TAG}|${WINDOWS_STABLE_UPDATE_TAG}`,
			),
		);
		// Must not re-introduce the broken "mark versioned tag as GitHub latest"
		// shortcut that collides with macOS/Linux /releases/latest consumers.
		expect(workflow).not.toMatch(/--latest=true/);
	});

	test("runtime module documents the same rolling tag constant", () => {
		const feedModule = readFileSync(
			join(import.meta.dir, "auto-update-feed.ts"),
			"utf8",
		);
		expect(feedModule).toContain(
			`WINDOWS_STABLE_UPDATE_TAG = "${WINDOWS_STABLE_UPDATE_TAG}"`,
		);
	});
});
