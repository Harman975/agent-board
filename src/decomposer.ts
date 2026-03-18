import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { normalizeHandle } from "./agents.js";


// === Types ===

export interface FileContext {
  header: string;
  exports: string[];
}

export interface DecompositionTask {
  agent: string;
  handle: string;
  mission: string;
  scope: string[];
}

export interface DecompositionResult {
  goal: string;
  tasks: DecompositionTask[];
}

interface DecompositionOpts {
  goal: string;
  fileTree: string[];
  clusters: string[][];
  fileContexts: Map<string, FileContext>;
  identities: { name: string; description: string }[];
}

export type Executor = (cmd: string, opts: { cwd: string; timeout: number }) => string;

// === Import analysis ===

const STATIC_IMPORT_RE = /import\s+.*?\s+from\s+['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const MAX_FILE_SIZE = 100 * 1024; // 100KB

export function analyzeImports(
  projectDir: string,
  srcDir: string = "src/"
): Map<string, string[]> {
  const absDir = path.resolve(projectDir, srcDir);
  const result = new Map<string, string[]>();

  if (!fs.existsSync(absDir)) return result;

  const files = collectTsFiles(absDir);

  for (const absFile of files) {
    const stat = fs.statSync(absFile);
    if (stat.size > MAX_FILE_SIZE) continue;

    const relFile = path.relative(projectDir, absFile);
    const content = fs.readFileSync(absFile, "utf-8");
    const imports: string[] = [];

    for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const specifier = match[1];
        // Resolve relative to the file's directory
        const fileDir = path.dirname(absFile);
        let resolved = path.resolve(fileDir, specifier);
        // Normalize .js → .ts for resolution
        if (resolved.endsWith(".js")) {
          resolved = resolved.slice(0, -3) + ".ts";
        }
        // Only include if .ts file exists
        if (fs.existsSync(resolved)) {
          imports.push(path.relative(projectDir, resolved));
        }
      }
    }

    result.set(relFile, imports);
  }

  return result;
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

// === Coupling clusters (connected components) ===

export function findCouplingClusters(imports: Map<string, string[]>): string[][] {
  // Build undirected adjacency list
  const adj = new Map<string, Set<string>>();

  const ensureNode = (f: string) => {
    if (!adj.has(f)) adj.set(f, new Set());
  };

  for (const [file, deps] of imports) {
    ensureNode(file);
    for (const dep of deps) {
      ensureNode(dep);
      adj.get(file)!.add(dep);
      adj.get(dep)!.add(file);
    }
  }

  // BFS to find connected components
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of adj.keys()) {
    if (visited.has(node)) continue;

    const component: string[] = [];
    const queue: string[] = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      for (const neighbor of adj.get(current)!) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    components.push(component.sort());
  }

  // Sort by size descending
  components.sort((a, b) => b.length - a.length);
  return components;
}

// === File context extraction ===

export function getFileContext(filePath: string): FileContext {
  if (!fs.existsSync(filePath)) {
    return { header: "", exports: [] };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const header = lines.slice(0, 30).join("\n");

  const exportRe = /^export\s+(function|class|const|type|interface|enum)\s+/;
  const exports: string[] = [];
  for (const line of lines) {
    if (exportRe.test(line)) {
      exports.push(line.trim());
    }
  }

  return { header, exports };
}

// === Prompt building ===

export function buildDecompositionPrompt(opts: DecompositionOpts): string {
  const sections: string[] = [];

  sections.push(`# Task Decomposition Request

You are a task decomposition engine. Break the following goal into parallel, independently-executable tasks for a team of AI agents.

## Goal
${opts.goal}`);

  // File tree
  if (opts.fileTree.length > 0) {
    sections.push(`## File Tree
${opts.fileTree.map((f) => `- ${f}`).join("\n")}`);
  }

  // Coupling clusters
  if (opts.clusters.length > 0) {
    sections.push(`## Coupling Clusters
These groups of files are tightly coupled via imports. Avoid splitting a cluster across agents.

${opts.clusters.map((c, i) => `Cluster ${i + 1}: ${c.join(", ")}`).join("\n")}`);
  }

  // File contexts
  if (opts.fileContexts.size > 0) {
    const contextLines: string[] = [];
    for (const [file, ctx] of opts.fileContexts) {
      if (ctx.exports.length > 0) {
        contextLines.push(`### ${file}\nExports: ${ctx.exports.join("; ")}`);
      }
    }
    if (contextLines.length > 0) {
      sections.push(`## File Contexts\n${contextLines.join("\n\n")}`);
    }
  }

  // Identities
  if (opts.identities.length > 0) {
    sections.push(`## Available Agents
${opts.identities.map((id) => `- **${id.name}**: ${id.description}`).join("\n")}`);
  }

  sections.push(`## Instructions
1. Break the goal into parallel tasks that can be executed independently
2. Assign each task to one of the available agents based on their expertise
3. Ensure scopes are DISJOINT — no file should appear in more than one task's scope
4. Keep tightly-coupled file clusters together in a single task
5. Each task must have a clear, specific mission

## Output Format
Respond with ONLY a JSON object (no markdown, no explanation) matching this schema:
\`\`\`json
{
  "goal": "the original goal",
  "tasks": [
    {
      "agent": "Agent Name",
      "handle": "@agent-handle",
      "mission": "Specific task description",
      "scope": ["src/file1.ts", "src/file2.ts"]
    }
  ]
}
\`\`\``);

  return sections.join("\n\n");
}

// === Response parsing ===

export function parseDecompositionResponse(raw: string): DecompositionResult {
  // Try to extract JSON from the response
  let jsonStr = raw.trim();

  // Strip markdown code fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Try to find a JSON object
  if (!jsonStr.startsWith("{")) {
    const objStart = jsonStr.indexOf("{");
    if (objStart === -1) {
      throw new Error(
        "Decomposition failed: response does not contain valid JSON. The model may have refused or returned an unexpected format."
      );
    }
    jsonStr = jsonStr.slice(objStart);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      "Decomposition failed: could not parse JSON from response."
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof obj.goal !== "string") {
    throw new Error('Decomposition failed: missing "goal" field in response.');
  }

  if (!Array.isArray(obj.tasks)) {
    throw new Error('Decomposition failed: missing "tasks" array in response.');
  }

  if (obj.tasks.length === 0) {
    throw new Error("Decomposition failed: tasks array is empty.");
  }

  const tasks: DecompositionTask[] = [];
  for (const task of obj.tasks) {
    const t = task as Record<string, unknown>;
    if (typeof t.agent !== "string") {
      throw new Error('Decomposition failed: task missing "agent" field.');
    }
    if (typeof t.handle !== "string") {
      throw new Error('Decomposition failed: task missing "handle" field.');
    }
    if (typeof t.mission !== "string") {
      throw new Error('Decomposition failed: task missing "mission" field.');
    }
    if (!Array.isArray(t.scope)) {
      throw new Error('Decomposition failed: task missing "scope" array.');
    }

    tasks.push({
      agent: t.agent as string,
      handle: normalizeHandle(t.handle as string),
      mission: t.mission as string,
      scope: t.scope as string[],
    });
  }

  // Validate disjoint scopes
  const seen = new Map<string, string>();
  for (const task of tasks) {
    for (const file of task.scope) {
      const owner = seen.get(file);
      if (owner) {
        throw new Error(
          `Decomposition failed: overlapping scope — file "${file}" is assigned to both "${owner}" and "${task.handle}".`
        );
      }
      seen.set(file, task.handle);
    }
  }

  return { goal: obj.goal as string, tasks };
}

// === Main entry point ===

export async function decompose(
  goal: string,
  projectDir: string,
  executor?: Executor
): Promise<DecompositionResult> {
  const exec: Executor =
    executor ??
    ((cmd, opts) =>
      execSync(cmd, {
        cwd: opts.cwd,
        timeout: opts.timeout,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      }));

  // 1. Analyze imports
  const imports = analyzeImports(projectDir);

  // 2. Find coupling clusters
  const clusters = findCouplingClusters(imports);

  // 3. Get file context for each file
  const fileContexts = new Map<string, FileContext>();
  const allFiles: string[] = [];
  for (const [file] of imports) {
    allFiles.push(file);
    const absPath = path.resolve(projectDir, file);
    fileContexts.set(file, getFileContext(absPath));
  }

  // 4. Build prompt
  const prompt = buildDecompositionPrompt({
    goal,
    fileTree: allFiles,
    clusters,
    fileContexts,
    identities: [], // caller can extend if needed
  });

  // 5. Shell out to claude
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const raw = exec(`claude -p '${escapedPrompt}'`, {
    cwd: projectDir,
    timeout: 120000,
  });

  // 6. Parse response
  return parseDecompositionResponse(raw);
}
