import { describe, expect, test } from "bun:test";
import { buildWindowsTaskkillArgs } from "./tree-kill";

describe("buildWindowsTaskkillArgs", () => {
	test("requests force kill of the process tree", () => {
		expect(buildWindowsTaskkillArgs(4242)).toEqual([
			"/PID",
			"4242",
			"/T",
			"/F",
		]);
	});
});
