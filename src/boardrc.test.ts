import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveServerLaunch } from "./boardrc.js";

let tmpDir: string;

describe("resolveServerLaunch", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boardrc-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prefers the built CLI when cli.js exists", () => {
    fs.writeFileSync(path.join(tmpDir, "cli.js"), "");

    const launch = resolveServerLaunch(tmpDir);

    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [path.join(tmpDir, "cli.js"), "serve"]);
  });

  it("falls back to the source CLI with tsx when only cli.ts exists", () => {
    fs.writeFileSync(path.join(tmpDir, "cli.ts"), "");

    const launch = resolveServerLaunch(tmpDir);

    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.args, [
      "--import",
      "tsx",
      path.join(tmpDir, "cli.ts"),
      "serve",
    ]);
  });
});
