import fs from "fs";
import path from "path";
import type { Identity, IdentityFrontmatter } from "./types.js";

const IDENTITIES_DIR = "identities";

function identitiesDir(baseDir?: string): string {
  return baseDir ? path.join(baseDir, IDENTITIES_DIR) : IDENTITIES_DIR;
}

/**
 * Parse YAML frontmatter from a markdown string delimited by --- fences.
 * Returns the parsed frontmatter fields.
 */
export function parseIdentityFrontmatter(raw: string): IdentityFrontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("No YAML frontmatter found");
  }

  const yaml = match[1];
  const result: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      // Inline array: [a, b, c]
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      result[key] = value.replace(/^["']|["']$/g, "");
    }
  }

  if (!result.name || typeof result.name !== "string") {
    throw new Error("Identity frontmatter must include 'name'");
  }
  if (!result.description || typeof result.description !== "string") {
    throw new Error("Identity frontmatter must include 'description'");
  }

  return {
    name: result.name as string,
    description: result.description as string,
    expertise: (result.expertise as string[] | undefined) ?? [],
    vibe: (result.vibe as string | undefined) ?? "",
    emoji: result.emoji as string | undefined,
    color: result.color as string | undefined,
  };
}

/**
 * Load an identity by name from identities/<name>.md.
 * Parses YAML frontmatter and markdown body into an Identity object.
 */
export function loadIdentity(name: string, baseDir?: string): Identity {
  const filePath = path.join(identitiesDir(baseDir), `${name}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Identity not found: ${name} (looked in ${filePath})`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const frontmatter = parseIdentityFrontmatter(raw);

  // Extract body after the closing ---
  const bodyMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1].trim() : "";

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    expertise: frontmatter.expertise ?? [],
    vibe: frontmatter.vibe ?? "",
    content: body,
  };
}

/**
 * List all identity names (filenames without .md extension).
 */
export function listIdentities(baseDir?: string): string[] {
  const dir = identitiesDir(baseDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

