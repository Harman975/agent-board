import type { Command } from "commander";
import { api } from "./boardrc.js";
import { requireRC, die } from "./cli-shared.js";
import {
  renderDagTree,
  renderDagLog,
  renderPromoteSummary,
  renderDagSummary,
} from "./render.js";
import type { DagCommit } from "./types.js";
import type { DagSummary, PromoteResult } from "./gitdag.js";

export function registerDagCommands(program: Command): void {
  // --- board tree ---
  program
    .command("tree")
    .description("Show the DAG commit tree")
    .option("--agent <handle>", "Filter by agent")
    .action(async (opts: { agent?: string }) => {
      const rc = requireRC();
      const [commits, leaves] = await Promise.all([
        api<DagCommit[]>(rc, "GET", `/api/git/commits?limit=200${opts.agent ? `&agent=${encodeURIComponent(opts.agent)}` : ""}`),
        api<DagCommit[]>(rc, "GET", `/api/git/leaves${opts.agent ? `?agent=${encodeURIComponent(opts.agent)}` : ""}`),
      ]);
      const leafSet = new Set(leaves.map((l) => l.hash));
      console.log(renderDagTree(commits, leafSet));
    });

  // --- board dag ---
  const dag = program.command("dag").description("Git DAG operations");

  dag
    .command("log")
    .description("Show DAG commit log")
    .option("--agent <handle>", "Filter by agent")
    .option("--limit <n>", "Limit commits", "20")
    .action(async (opts: { agent?: string; limit: string }) => {
      const rc = requireRC();
      const params = new URLSearchParams();
      if (opts.agent) params.set("agent", opts.agent);
      params.set("limit", opts.limit);
      const commits = await api<DagCommit[]>(rc, "GET", `/api/git/commits?${params.toString()}`);
      console.log(renderDagLog(commits));
    });

  dag
    .command("leaves")
    .description("Show active exploration frontiers (leaf commits)")
    .option("--agent <handle>", "Filter by agent")
    .action(async (opts: { agent?: string }) => {
      const rc = requireRC();
      const qs = opts.agent ? `?agent=${encodeURIComponent(opts.agent)}` : "";
      const leaves = await api<DagCommit[]>(rc, "GET", `/api/git/leaves${qs}`);
      if (leaves.length === 0) {
        console.log("  No leaves (DAG is empty).");
      } else {
        console.log(`${leaves.length} active frontier${leaves.length !== 1 ? "s" : ""}:\n`);
        console.log(renderDagLog(leaves));
      }
    });

  dag
    .command("diff <hash-a> <hash-b>")
    .description("Diff two DAG commits")
    .action(async (hashA: string, hashB: string) => {
      const rc = requireRC();
      const url = `${rc.url}/api/git/diff/${encodeURIComponent(hashA)}/${encodeURIComponent(hashB)}`;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${rc.key}` },
        });
        if (!res.ok) {
          const err = await res.json();
          die(`Error: ${(err as any).error}`);
        }
        console.log(await res.text());
      } catch (err: any) {
        die(`Cannot connect to server: ${err.message}`);
      }
    });

  dag
    .command("promote <hash>")
    .description("Promote a DAG commit to main (cherry-pick)")
    .action(async (hash: string) => {
      const rc = requireRC();
      const result = await api<PromoteResult>(rc, "POST", "/api/git/promote", { hash });
      console.log(renderPromoteSummary(result));
    });

  dag
    .command("summary")
    .description("Show DAG summary")
    .action(async () => {
      const rc = requireRC();
      const summary = await api<DagSummary>(rc, "GET", "/data/dag");
      console.log(renderDagSummary(summary));
    });
}
