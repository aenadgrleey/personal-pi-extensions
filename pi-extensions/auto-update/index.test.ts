import assert from "node:assert/strict";

import { buildSelfUpdateCommand, isNewerVersion } from "./index.ts";

assert.equal(isNewerVersion("0.74.0", "0.73.1"), true);
assert.equal(isNewerVersion("0.73.1", "0.74.0"), false);
assert.equal(isNewerVersion("0.73.1", "0.73.1"), false);
assert.equal(isNewerVersion("v0.74.0", "0.73.1"), true);

assert.deepEqual(buildSelfUpdateCommand("npm", "0.74.0"), {
	command: "npm",
	args: ["install", "-g", "@earendil-works/pi-coding-agent@0.74.0"],
	display: "npm install -g @earendil-works/pi-coding-agent@0.74.0",
});

assert.deepEqual(buildSelfUpdateCommand("bun", "0.74.0"), {
	command: "bun",
	args: ["install", "-g", "@earendil-works/pi-coding-agent@0.74.0"],
	display: "bun install -g @earendil-works/pi-coding-agent@0.74.0",
});

assert.equal(buildSelfUpdateCommand("bun-binary", "0.74.0"), undefined);

console.log("auto-update tests passed");
