import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  analyzeImports,
  findCouplingClusters,
  getFileContext,
  buildDecompositionPrompt,
  parseDecompositionResponse,
  decompose,
} from "./decomposer.js";

// === Helpers ===

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "decomposer-test-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// === analyzeImports ===

describe("analyzeImports", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts static and dynamic imports from .ts files", () => {
    writeFile(
      tmpDir,
      "src/a.ts",
      `import { foo } from './b.js';\nimport('./c.js');\n`
    );
    writeFile(tmpDir, "src/b.ts", `export const foo = 1;\n`);
    writeFile(tmpDir, "src/c.ts", `export const bar = 2;\n`);

    const result = analyzeImports(tmpDir);
    assert.ok(result.has("src/a.ts"));
    const deps = result.get("src/a.ts")!;
    assert.ok(deps.includes("src/b.ts"));
    assert.ok(deps.includes("src/c.ts"));
  });

  it("handles empty directory", () => {
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    const result = analyzeImports(tmpDir);
    assert.equal(result.size, 0);
  });

  it("handles non-existent srcDir", () => {
    const result = analyzeImports(tmpDir, "nonexistent/");
    assert.equal(result.size, 0);
  });

  it("handles circular imports", () => {
    writeFile(
      tmpDir,
      "src/a.ts",
      `import { B } from './b.js';\nexport const A = 1;\n`
    );
    writeFile(
      tmpDir,
      "src/b.ts",
      `import { A } from './a.js';\nexport const B = 2;\n`
    );

    const result = analyzeImports(tmpDir);
    assert.ok(result.get("src/a.ts")!.includes("src/b.ts"));
    assert.ok(result.get("src/b.ts")!.includes("src/a.ts"));
  });

  it("skips files larger than 100KB", () => {
    const bigContent = "x".repeat(101 * 1024);
    writeFile(tmpDir, "src/big.ts", bigContent);
    writeFile(tmpDir, "src/small.ts", `export const x = 1;\n`);

    const result = analyzeImports(tmpDir);
    assert.ok(!result.has("src/big.ts"));
    assert.ok(result.has("src/small.ts"));
  });

  it("uses custom srcDir", () => {
    writeFile(tmpDir, "lib/a.ts", `export const x = 1;\n`);
    const result = analyzeImports(tmpDir, "lib/");
    assert.ok(result.has("lib/a.ts"));
  });
});

// === findCouplingClusters ===

describe("findCouplingClusters", () => {
  it("finds connected components", () => {
    const imports = new Map<string, string[]>([
      ["a.ts", ["b.ts"]],
      ["b.ts", ["c.ts"]],
      ["c.ts", []],
      ["d.ts", ["e.ts"]],
      ["e.ts", []],
    ]);

    const clusters = findCouplingClusters(imports);
    assert.equal(clusters.length, 2);
    // Largest first
    assert.equal(clusters[0].length, 3);
    assert.equal(clusters[1].length, 2);
    assert.ok(clusters[0].includes("a.ts"));
    assert.ok(clusters[0].includes("b.ts"));
    assert.ok(clusters[0].includes("c.ts"));
    assert.ok(clusters[1].includes("d.ts"));
    assert.ok(clusters[1].includes("e.ts"));
  });

  it("handles disconnected files as singletons", () => {
    const imports = new Map<string, string[]>([
      ["a.ts", []],
      ["b.ts", []],
    ]);

    const clusters = findCouplingClusters(imports);
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0].length, 1);
    assert.equal(clusters[1].length, 1);
  });

  it("single file returns singleton cluster", () => {
    const imports = new Map<string, string[]>([["only.ts", []]]);
    const clusters = findCouplingClusters(imports);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0], ["only.ts"]);
  });

  it("handles empty map", () => {
    const clusters = findCouplingClusters(new Map());
    assert.equal(clusters.length, 0);
  });
});

// === getFileContext ===

describe("getFileContext", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads header (first 30 lines) and extracts exports", () => {
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`// line ${i + 1}`);
    }
    lines[5] = "export function doStuff(): void {}";
    lines[10] = "export class MyClass {}";
    lines[15] = "export const FOO = 42;";
    lines[20] = "export type MyType = string;";
    lines[25] = "export interface IFace {}";
    lines[35] = "export enum Status { A, B }";
    writeFile(tmpDir, "test.ts", lines.join("\n"));

    const ctx = getFileContext(path.join(tmpDir, "test.ts"));

    // Header is first 30 lines
    const headerLines = ctx.header.split("\n");
    assert.equal(headerLines.length, 30);

    // All exports found (including ones beyond line 30)
    assert.equal(ctx.exports.length, 6);
    assert.ok(ctx.exports.some((e) => e.includes("doStuff")));
    assert.ok(ctx.exports.some((e) => e.includes("MyClass")));
    assert.ok(ctx.exports.some((e) => e.includes("FOO")));
    assert.ok(ctx.exports.some((e) => e.includes("MyType")));
    assert.ok(ctx.exports.some((e) => e.includes("IFace")));
    assert.ok(ctx.exports.some((e) => e.includes("Status")));
  });

  it("handles empty file", () => {
    writeFile(tmpDir, "empty.ts", "");
    const ctx = getFileContext(path.join(tmpDir, "empty.ts"));
    assert.equal(ctx.header, "");
    assert.equal(ctx.exports.length, 0);
  });

  it("handles non-existent file", () => {
    const ctx = getFileContext(path.join(tmpDir, "nope.ts"));
    assert.equal(ctx.header, "");
    assert.equal(ctx.exports.length, 0);
  });
});

// === buildDecompositionPrompt ===

describe("buildDecompositionPrompt", () => {
  it("builds prompt with all sections", () => {
    const fileContexts = new Map([
      ["src/a.ts", { header: "// a", exports: ["export function foo(): void {}"] }],
    ]);

    const prompt = buildDecompositionPrompt({
      goal: "Build a widget",
      fileTree: ["src/a.ts", "src/b.ts"],
      clusters: [["src/a.ts", "src/b.ts"]],
      fileContexts,
      identities: [{ name: "Builder", description: "Builds things" }],
    });

    assert.ok(prompt.includes("Build a widget"));
    assert.ok(prompt.includes("src/a.ts"));
    assert.ok(prompt.includes("src/b.ts"));
    assert.ok(prompt.includes("Cluster 1"));
    assert.ok(prompt.includes("export function foo"));
    assert.ok(prompt.includes("Builder"));
    assert.ok(prompt.includes("Builds things"));
    assert.ok(prompt.includes("DISJOINT"));
    assert.ok(prompt.includes('"goal"'));
    assert.ok(prompt.includes('"tasks"'));
  });

  it("handles empty identities", () => {
    const prompt = buildDecompositionPrompt({
      goal: "Do stuff",
      fileTree: ["a.ts"],
      clusters: [],
      fileContexts: new Map(),
      identities: [],
    });

    assert.ok(prompt.includes("Do stuff"));
    assert.ok(!prompt.includes("Available Agents"));
  });

  it("handles empty file tree", () => {
    const prompt = buildDecompositionPrompt({
      goal: "Do stuff",
      fileTree: [],
      clusters: [],
      fileContexts: new Map(),
      identities: [],
    });

    assert.ok(prompt.includes("Do stuff"));
    assert.ok(!prompt.includes("File Tree"));
  });
});

// === parseDecompositionResponse ===

describe("parseDecompositionResponse", () => {
  const validJson = JSON.stringify({
    goal: "Build widget",
    tasks: [
      {
        agent: "Builder",
        handle: "@builder",
        mission: "Build the widget",
        scope: ["src/widget.ts"],
      },
      {
        agent: "Tester",
        handle: "tester",
        mission: "Test the widget",
        scope: ["src/widget.test.ts"],
      },
    ],
  });

  it("parses valid JSON response", () => {
    const result = parseDecompositionResponse(validJson);
    assert.equal(result.goal, "Build widget");
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].agent, "Builder");
    assert.equal(result.tasks[0].handle, "@builder");
    // normalizeHandle adds @ prefix
    assert.equal(result.tasks[1].handle, "@tester");
  });

  it("handles markdown-wrapped JSON", () => {
    const wrapped = "Here is the plan:\n```json\n" + validJson + "\n```\n";
    const result = parseDecompositionResponse(wrapped);
    assert.equal(result.goal, "Build widget");
    assert.equal(result.tasks.length, 2);
  });

  it("handles JSON with leading text", () => {
    const withPrefix = "Sure, here is the decomposition:\n" + validJson;
    const result = parseDecompositionResponse(withPrefix);
    assert.equal(result.goal, "Build widget");
  });

  it("throws on invalid JSON", () => {
    assert.throws(
      () => parseDecompositionResponse("{not valid json!!!}"),
      (err: Error) => err.message.includes("could not parse JSON")
    );
  });

  it("throws on missing goal field", () => {
    const noGoal = JSON.stringify({ tasks: [{ agent: "A", handle: "@a", mission: "m", scope: [] }] });
    assert.throws(
      () => parseDecompositionResponse(noGoal),
      (err: Error) => err.message.includes('"goal"')
    );
  });

  it("throws on missing tasks field", () => {
    const noTasks = JSON.stringify({ goal: "x" });
    assert.throws(
      () => parseDecompositionResponse(noTasks),
      (err: Error) => err.message.includes('"tasks"')
    );
  });

  it("throws on empty tasks array", () => {
    const empty = JSON.stringify({ goal: "x", tasks: [] });
    assert.throws(
      () => parseDecompositionResponse(empty),
      (err: Error) => err.message.includes("empty")
    );
  });

  it("throws on overlapping scopes", () => {
    const overlapping = JSON.stringify({
      goal: "x",
      tasks: [
        { agent: "A", handle: "@a", mission: "m", scope: ["shared.ts"] },
        { agent: "B", handle: "@b", mission: "m", scope: ["shared.ts"] },
      ],
    });
    assert.throws(
      () => parseDecompositionResponse(overlapping),
      (err: Error) => err.message.includes("overlapping") && err.message.includes("shared.ts")
    );
  });

  it("throws on missing task fields", () => {
    const missingAgent = JSON.stringify({
      goal: "x",
      tasks: [{ handle: "@a", mission: "m", scope: [] }],
    });
    assert.throws(
      () => parseDecompositionResponse(missingAgent),
      (err: Error) => err.message.includes('"agent"')
    );
  });

  it("throws on Claude refusal (no JSON)", () => {
    const refusal =
      "I'm sorry, but I cannot decompose this task as it involves potentially harmful activities.";
    assert.throws(
      () => parseDecompositionResponse(refusal),
      (err: Error) => err.message.includes("does not contain valid JSON")
    );
  });
});

// === decompose (end-to-end with mocked executor) ===

describe("decompose", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("end-to-end with mocked executor", async () => {
    // Set up a minimal project
    writeFile(
      tmpDir,
      "src/api.ts",
      `import { db } from './db.js';\nexport function getUsers() {}\n`
    );
    writeFile(
      tmpDir,
      "src/db.ts",
      `export const db = {};\n`
    );
    writeFile(
      tmpDir,
      "src/utils.ts",
      `export function helper() {}\n`
    );

    const cannedResponse = JSON.stringify({
      goal: "Add user management",
      tasks: [
        {
          agent: "Backend Dev",
          handle: "@backend",
          mission: "Implement user CRUD",
          scope: ["src/api.ts", "src/db.ts"],
        },
        {
          agent: "Utils Dev",
          handle: "@utils",
          mission: "Add utility helpers",
          scope: ["src/utils.ts"],
        },
      ],
    });

    const executor = (_cmd: string, _opts: { cwd: string; timeout: number }) => cannedResponse;

    const result = await decompose("Add user management", tmpDir, executor);

    assert.equal(result.goal, "Add user management");
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].handle, "@backend");
    assert.equal(result.tasks[1].handle, "@utils");
    assert.deepEqual(result.tasks[0].scope, ["src/api.ts", "src/db.ts"]);
  });

  it("passes prompt to executor", async () => {
    writeFile(tmpDir, "src/main.ts", `export function main() {}\n`);

    let capturedCmd = "";
    const executor = (cmd: string, _opts: { cwd: string; timeout: number }) => {
      capturedCmd = cmd;
      return JSON.stringify({
        goal: "Test",
        tasks: [
          { agent: "Dev", handle: "@dev", mission: "Do it", scope: ["src/main.ts"] },
        ],
      });
    };

    await decompose("Test goal", tmpDir, executor);

    assert.ok(capturedCmd.includes("claude -p"));
    assert.ok(capturedCmd.includes("Test goal"));
  });
});
