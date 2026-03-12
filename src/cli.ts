import { Command } from "commander";
import { initDb, getDb, dbExists } from "./db.js";
import { createAgent, getAgent, listAgents, updateAgent } from "./agents.js";
import { createPost, listPosts, getThread } from "./posts.js";
import { linkCommit, listCommitsByPost } from "./commits.js";
import {
  renderAgent,
  renderAgentList,
  renderFeed,
  renderProfile,
  renderThread,
} from "./render.js";
import type { AgentRole, AgentStatus, PostType } from "./types.js";

const program = new Command();

program
  .name("board")
  .description("AgentBoard — a feed for supervising AI agents")
  .version("0.1.0");

// --- board init ---
program
  .command("init")
  .description("Initialize a new board in the current directory")
  .action(() => {
    if (dbExists()) {
      console.log("Board already initialized.");
      return;
    }
    initDb();
    console.log("Board initialized. Created board.db");
  });

// Helper: get db or exit
function requireDb() {
  if (!dbExists()) {
    console.error("No board found. Run `board init` first.");
    process.exit(1);
  }
  return getDb();
}

// --- board agent ---
const agent = program.command("agent").description("Manage agents");

agent
  .command("create <handle>")
  .description("Create a new agent")
  .requiredOption("--role <role>", "Agent role (manager or worker)")
  .requiredOption("--mission <mission>", "Agent mission")
  .option("--name <name>", "Agent display name")
  .option("--team <team>", "Team name")
  .action((handle: string, opts: { role: string; mission: string; name?: string; team?: string }) => {
    const db = requireDb();
    try {
      const a = createAgent(db, {
        handle,
        name: opts.name ?? handle.replace(/^@/, ""),
        role: opts.role as AgentRole,
        mission: opts.mission,
        team: opts.team,
      });
      console.log(`Created agent ${a.handle}`);
      console.log(renderAgent(a));
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

agent
  .command("list")
  .description("List all agents")
  .option("--role <role>", "Filter by role")
  .option("--status <status>", "Filter by status")
  .option("--team <team>", "Filter by team")
  .action((opts: { role?: string; status?: string; team?: string }) => {
    const db = requireDb();
    const agents = listAgents(db, {
      role: opts.role as AgentRole | undefined,
      status: opts.status as AgentStatus | undefined,
      team: opts.team,
    });
    console.log(renderAgentList(agents));
    db.close();
  });

agent
  .command("show <handle>")
  .description("Show agent details")
  .action((handle: string) => {
    const db = requireDb();
    const a = getAgent(db, handle);
    if (!a) {
      console.error(`Agent ${handle} not found`);
      process.exit(1);
    }
    console.log(renderAgent(a));
    db.close();
  });

agent
  .command("update <handle>")
  .description("Update an agent")
  .option("--name <name>", "New name")
  .option("--mission <mission>", "New mission")
  .option("--status <status>", "New status")
  .option("--team <team>", "New team")
  .action((handle: string, opts: { name?: string; mission?: string; status?: string; team?: string }) => {
    const db = requireDb();
    const a = updateAgent(db, handle, {
      name: opts.name,
      mission: opts.mission,
      status: opts.status as AgentStatus | undefined,
      team: opts.team,
    });
    if (!a) {
      console.error(`Agent ${handle} not found`);
      process.exit(1);
    }
    console.log(`Updated ${a.handle}`);
    console.log(renderAgent(a));
    db.close();
  });

// --- board post ---
program
  .command("post <handle> <content>")
  .description("Create a post as an agent")
  .option("--type <type>", "Post type", "update")
  .action((handle: string, content: string, opts: { type: string }) => {
    const db = requireDb();
    try {
      const post = createPost(db, {
        author: handle,
        content,
        type: opts.type as PostType,
      });
      console.log(`Posted ${post.id.slice(0, 8)} by ${post.author} [${post.type}]`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

// --- board reply ---
program
  .command("reply <post-id> <handle> <content>")
  .description("Reply to a post")
  .option("--type <type>", "Post type", "update")
  .action((postId: string, handle: string, content: string, opts: { type: string }) => {
    const db = requireDb();
    try {
      const post = createPost(db, {
        author: handle,
        content,
        type: opts.type as PostType,
        parent_id: postId,
      });
      console.log(`Reply ${post.id.slice(0, 8)} by ${post.author}`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

// --- board feed ---
program
  .command("feed")
  .description("Show the post feed")
  .option("--author <handle>", "Filter by author")
  .option("--type <type>", "Filter by type")
  .option("--limit <n>", "Limit posts", "20")
  .action((opts: { author?: string; type?: string; limit: string }) => {
    const db = requireDb();
    const posts = listPosts(db, {
      author: opts.author,
      type: opts.type as PostType | undefined,
      limit: parseInt(opts.limit, 10),
      parent_id: null, // top-level only
    });
    console.log(renderFeed(posts));
    db.close();
  });

// --- board thread ---
program
  .command("thread <post-id>")
  .description("Show a post thread")
  .action((postId: string) => {
    const db = requireDb();
    const thread = getThread(db, postId);
    if (!thread) {
      console.error(`Post ${postId} not found`);
      process.exit(1);
    }
    console.log(renderThread(thread));
    db.close();
  });

// --- board profile ---
program
  .command("profile <handle>")
  .description("Show an agent's profile and posts")
  .action((handle: string) => {
    const db = requireDb();
    const a = getAgent(db, handle);
    if (!a) {
      console.error(`Agent ${handle} not found`);
      process.exit(1);
    }
    const posts = listPosts(db, { author: handle, limit: 20 });
    console.log(renderProfile(a, posts));
    db.close();
  });

// --- board commit ---
program
  .command("commit <hash> <post-id>")
  .description("Link a git commit to a post")
  .option("--files <files...>", "Files changed")
  .action((hash: string, postId: string, opts: { files?: string[] }) => {
    const db = requireDb();
    try {
      const c = linkCommit(db, { hash, post_id: postId, files: opts.files });
      console.log(`Linked commit ${c.hash.slice(0, 8)} to post ${c.post_id.slice(0, 8)}`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    } finally {
      db.close();
    }
  });

program.parse();
