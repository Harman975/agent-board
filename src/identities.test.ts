import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import os from "os";
import { saveIdentity, loadIdentity, listIdentities, parseIdentityFrontmatter } from "./identities.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-identity-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveIdentity", () => {
  it("saves a new identity to disk", () => {
    const saved = saveIdentity({
      name: "test-agent",
      description: "A test agent",
      expertise: ["testing", "automation"],
      vibe: "methodical",
      content: "# Test Agent\n\nDoes testing.",
    }, tmpDir);
    assert.ok(saved);
    const filePath = path.join(tmpDir, "identities", "test-agent.md");
    assert.ok(fs.existsSync(filePath));
    const raw = fs.readFileSync(filePath, "utf-8");
    assert.ok(raw.includes("name: test-agent"));
    assert.ok(raw.includes("description: A test agent"));
    assert.ok(raw.includes("expertise: [testing, automation]"));
    assert.ok(raw.includes("# Test Agent"));
  });

  it("returns false when identity already exists and overwrite is false", () => {
    saveIdentity({
      name: "existing",
      description: "Existing agent",
      expertise: [],
      vibe: "",
      content: "body",
    }, tmpDir);
    const result = saveIdentity({
      name: "existing",
      description: "New description",
      expertise: [],
      vibe: "",
      content: "new body",
    }, tmpDir, false);
    assert.strictEqual(result, false);
  });

  it("overwrites when overwrite is true", () => {
    saveIdentity({
      name: "overwritable",
      description: "Original",
      expertise: [],
      vibe: "",
      content: "original body",
    }, tmpDir);
    const result = saveIdentity({
      name: "overwritable",
      description: "Updated",
      expertise: [],
      vibe: "",
      content: "new body",
    }, tmpDir, true);
    assert.ok(result);
    const loaded = loadIdentity("overwritable", tmpDir);
    assert.strictEqual(loaded.description, "Updated");
  });

  it("creates identities directory if missing", () => {
    const subDir = path.join(tmpDir, "subdir");
    fs.mkdirSync(subDir);
    saveIdentity({
      name: "auto-dir",
      description: "Creates dir",
      expertise: [],
      vibe: "",
      content: "body",
    }, subDir);
    assert.ok(fs.existsSync(path.join(subDir, "identities", "auto-dir.md")));
  });

  it("saves emoji and color when provided", () => {
    saveIdentity({
      name: "colorful",
      description: "Has extras",
      expertise: [],
      vibe: "energetic",
      content: "body",
      emoji: "🎨",
      color: "#ff0000",
    }, tmpDir);
    const raw = fs.readFileSync(path.join(tmpDir, "identities", "colorful.md"), "utf-8");
    assert.ok(raw.includes("emoji: 🎨"));
    assert.ok(raw.includes("color: #ff0000"));
  });
});

describe("parseIdentityFrontmatter", () => {
  it("parses valid frontmatter", () => {
    const raw = `---
name: test
description: A test
expertise: [a, b]
vibe: calm
---
Body content`;
    const fm = parseIdentityFrontmatter(raw);
    assert.strictEqual(fm.name, "test");
    assert.strictEqual(fm.description, "A test");
    assert.deepStrictEqual(fm.expertise, ["a", "b"]);
    assert.strictEqual(fm.vibe, "calm");
  });

  it("throws when no frontmatter found", () => {
    assert.throws(() => parseIdentityFrontmatter("no frontmatter here"), /No YAML frontmatter found/);
  });

  it("throws when name is missing", () => {
    assert.throws(() => parseIdentityFrontmatter("---\ndescription: test\n---\n"), /must include 'name'/);
  });

  it("throws when description is missing", () => {
    assert.throws(() => parseIdentityFrontmatter("---\nname: test\n---\n"), /must include 'description'/);
  });
});

describe("roundtrip save/load", () => {
  it("identity survives save and load", () => {
    const original = {
      name: "roundtrip",
      description: "Test roundtrip",
      expertise: ["ts", "node"],
      vibe: "chill",
      content: "# Hello\n\nWorld",
    };
    saveIdentity(original, tmpDir);
    const loaded = loadIdentity("roundtrip", tmpDir);
    assert.strictEqual(loaded.name, original.name);
    assert.strictEqual(loaded.description, original.description);
    assert.deepStrictEqual(loaded.expertise, original.expertise);
    assert.strictEqual(loaded.vibe, original.vibe);
    assert.strictEqual(loaded.content, original.content);
  });
});

describe("listIdentities with saved identities", () => {
  it("lists saved identities", () => {
    saveIdentity({ name: "alpha", description: "A", expertise: [], vibe: "", content: "" }, tmpDir);
    saveIdentity({ name: "beta", description: "B", expertise: [], vibe: "", content: "" }, tmpDir);
    const names = listIdentities(tmpDir);
    assert.deepStrictEqual(names, ["alpha", "beta"]);
  });
});
