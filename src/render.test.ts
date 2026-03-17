import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  renderPost,
  renderRankedPost,
  renderThread,
  renderFeed,
  renderAgent,
  renderAgentList,
  renderProfile,
  renderBriefing,
  renderChannelList,
  renderSpawnList,
  renderStatus,
  renderResearchHistory,
  renderRetro,
  renderRetroMarkdown,
  type SpawnInfo,
  type ResearchSession,
  type RetroData,
} from "./render.js";
import type { Post, Agent, RankedPost } from "./types.js";
import type { PostThread } from "./posts.js";
import type { BriefingSummary } from "./supervision.js";

// === Test data factories ===

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    author: "@bot",
    channel: "#work",
    content: "test post content",
    parent_id: null,
    metadata: {},
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...overrides,
  };
}

function makeRankedPost(overrides: Partial<RankedPost> = {}): RankedPost {
  return {
    ...makePost(),
    priority: 0,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    handle: "@test-bot",
    name: "Test Bot",
    mission: "Testing things",
    status: "active",
    metadata: {},
    created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...overrides,
  };
}

// === renderPost ===

describe("renderPost", () => {
  it("renders a post with author, channel, and content", () => {
    const post = makePost({ content: "hello world" });
    const output = renderPost(post);
    assert.ok(output.includes("@bot"));
    assert.ok(output.includes("#work"));
    assert.ok(output.includes("hello world"));
  });

  it("renders shortened post ID (first 8 chars)", () => {
    const post = makePost({ id: "12345678-abcd-1234-5678-abcdefabcdef" });
    const output = renderPost(post);
    assert.ok(output.includes("12345678"));
  });

  it("respects indent parameter", () => {
    const post = makePost();
    const output0 = renderPost(post, 0);
    const output2 = renderPost(post, 2);
    // Indented version should have more leading spaces
    assert.ok(output2.length > output0.length);
  });
});

// === renderRankedPost ===

describe("renderRankedPost", () => {
  it("renders priority for high-priority posts", () => {
    const post = makeRankedPost({ priority: 100 });
    const output = renderRankedPost(post);
    assert.ok(output.includes("pri:100"));
  });

  it("renders priority for medium-priority posts", () => {
    const post = makeRankedPost({ priority: 25 });
    const output = renderRankedPost(post);
    assert.ok(output.includes("pri:25"));
  });

  it("omits priority badge when priority is 0", () => {
    const post = makeRankedPost({ priority: 0 });
    const output = renderRankedPost(post);
    assert.ok(!output.includes("pri:"));
  });

  it("includes content", () => {
    const post = makeRankedPost({ content: "urgent alert" });
    const output = renderRankedPost(post);
    assert.ok(output.includes("urgent alert"));
  });
});

// === renderThread ===

describe("renderThread", () => {
  it("renders a single post thread", () => {
    const thread: PostThread = {
      post: makePost({ content: "root" }),
      replies: [],
    };
    const output = renderThread(thread);
    assert.ok(output.includes("root"));
  });

  it("renders nested replies with indentation", () => {
    const thread: PostThread = {
      post: makePost({ content: "root" }),
      replies: [
        {
          post: makePost({ content: "reply1" }),
          replies: [
            {
              post: makePost({ content: "nested" }),
              replies: [],
            },
          ],
        },
      ],
    };
    const output = renderThread(thread);
    assert.ok(output.includes("root"));
    assert.ok(output.includes("reply1"));
    assert.ok(output.includes("nested"));
  });
});

// === renderFeed ===

describe("renderFeed", () => {
  it("renders multiple posts", () => {
    const posts = [
      makeRankedPost({ content: "first", priority: 100 }),
      makeRankedPost({ content: "second", priority: 0 }),
    ];
    const output = renderFeed(posts);
    assert.ok(output.includes("first"));
    assert.ok(output.includes("second"));
  });

  it("renders empty feed message", () => {
    const output = renderFeed([]);
    assert.ok(output.includes("No posts"));
  });
});

// === renderAgent ===

describe("renderAgent", () => {
  it("renders agent handle and status", () => {
    const agent = makeAgent({ handle: "@worker", status: "active" });
    const output = renderAgent(agent);
    assert.ok(output.includes("@worker"));
    assert.ok(output.includes("active"));
  });

  it("renders agent name and mission", () => {
    const agent = makeAgent({ name: "My Worker", mission: "Build features" });
    const output = renderAgent(agent);
    assert.ok(output.includes("My Worker"));
    assert.ok(output.includes("Build features"));
  });

  it("renders metadata when present", () => {
    const agent = makeAgent({ metadata: { lang: "ts", version: 2 } });
    const output = renderAgent(agent);
    assert.ok(output.includes("Metadata"));
    assert.ok(output.includes("ts"));
  });

  it("omits metadata line when metadata is empty", () => {
    const agent = makeAgent({ metadata: {} });
    const output = renderAgent(agent);
    assert.ok(!output.includes("Metadata"));
  });

  it("renders blocked status", () => {
    const agent = makeAgent({ status: "blocked" });
    const output = renderAgent(agent);
    assert.ok(output.includes("blocked"));
  });

  it("renders stopped status", () => {
    const agent = makeAgent({ status: "stopped" });
    const output = renderAgent(agent);
    assert.ok(output.includes("stopped"));
  });

  it("renders idle status", () => {
    const agent = makeAgent({ status: "idle" });
    const output = renderAgent(agent);
    assert.ok(output.includes("idle"));
  });
});

// === renderAgentList ===

describe("renderAgentList", () => {
  it("renders multiple agents", () => {
    const agents = [
      makeAgent({ handle: "@a1", name: "A1" }),
      makeAgent({ handle: "@a2", name: "A2" }),
    ];
    const output = renderAgentList(agents);
    assert.ok(output.includes("@a1"));
    assert.ok(output.includes("@a2"));
  });

  it("renders empty list message", () => {
    const output = renderAgentList([]);
    assert.ok(output.includes("No agents"));
  });
});

// === renderProfile ===

describe("renderProfile", () => {
  it("renders agent profile with posts", () => {
    const agent = makeAgent({ handle: "@profiled" });
    const posts = [makePost({ content: "my post" })];
    const output = renderProfile(agent, posts);
    assert.ok(output.includes("Profile"));
    assert.ok(output.includes("@profiled"));
    assert.ok(output.includes("my post"));
    assert.ok(output.includes("Posts (1)"));
  });

  it("renders profile with no posts", () => {
    const agent = makeAgent();
    const output = renderProfile(agent, []);
    assert.ok(output.includes("No posts"));
    assert.ok(output.includes("Posts (0)"));
  });
});

// === renderBriefing ===

describe("renderBriefing", () => {
  it("renders briefing with channels", () => {
    const briefing: BriefingSummary = {
      since: "2026-01-01T00:00:00Z",
      total: 3,
      channels: [
        {
          name: "#escalations",
          priority: 100,
          count: 1,
          posts: [makePost({ content: "urgent", channel: "#escalations" })],
        },
        {
          name: "#work",
          priority: 10,
          count: 2,
          posts: [
            makePost({ content: "w1" }),
            makePost({ content: "w2" }),
          ],
        },
      ],
    };
    const output = renderBriefing(briefing);
    assert.ok(output.includes("3 posts"));
    assert.ok(output.includes("#escalations"));
    assert.ok(output.includes("#work"));
    assert.ok(output.includes("1 post"));
    assert.ok(output.includes("2 posts"));
  });

  it("shows full text for high-priority channels (>= 50)", () => {
    const briefing: BriefingSummary = {
      since: null,
      total: 1,
      channels: [
        {
          name: "#escalations",
          priority: 50,
          count: 1,
          posts: [makePost({ content: "critical alert", channel: "#escalations" })],
        },
      ],
    };
    const output = renderBriefing(briefing);
    assert.ok(output.includes("critical alert"));
  });

  it("does not show full text for low-priority channels (< 50)", () => {
    const briefing: BriefingSummary = {
      since: null,
      total: 1,
      channels: [
        {
          name: "#work",
          priority: 10,
          count: 1,
          posts: [makePost({ content: "routine update", channel: "#work" })],
        },
      ],
    };
    const output = renderBriefing(briefing);
    // Content of individual posts should NOT appear for low-pri channels
    assert.ok(!output.includes("routine update"));
  });

  it("renders empty briefing", () => {
    const briefing: BriefingSummary = {
      since: "2026-01-01T00:00:00Z",
      total: 0,
      channels: [],
    };
    const output = renderBriefing(briefing);
    assert.ok(output.includes("Nothing new"));
  });

  it("renders empty briefing without since", () => {
    const briefing: BriefingSummary = {
      since: null,
      total: 0,
      channels: [],
    };
    const output = renderBriefing(briefing);
    assert.ok(output.includes("Nothing new"));
  });
});

// === renderChannelList ===

describe("renderChannelList", () => {
  it("renders channels sorted by priority desc", () => {
    const channels = [
      { name: "#work", description: "Work", priority: 10 },
      { name: "#escalations", description: "Urgent", priority: 100 },
      { name: "#general", description: null, priority: 0 },
    ];
    const output = renderChannelList(channels);
    const lines = output.split("\n");
    // Escalations should come first (highest priority)
    assert.ok(lines[0].includes("#escalations"));
    assert.ok(lines[1].includes("#work"));
    assert.ok(lines[2].includes("#general"));
  });

  it("renders empty channel list", () => {
    const output = renderChannelList([]);
    assert.ok(output.includes("No channels"));
  });

  it("shows priority badge for channels with priority > 0", () => {
    const channels = [{ name: "#urgent", description: null, priority: 75 }];
    const output = renderChannelList(channels);
    assert.ok(output.includes("pri:75"));
  });

  it("omits priority badge for channels with priority 0", () => {
    const channels = [{ name: "#general", description: null, priority: 0 }];
    const output = renderChannelList(channels);
    assert.ok(!output.includes("pri:"));
  });

  it("shows description when present", () => {
    const channels = [{ name: "#work", description: "Work updates", priority: 0 }];
    const output = renderChannelList(channels);
    assert.ok(output.includes("Work updates"));
  });
});

// === renderSpawnList ===

describe("renderSpawnList", () => {
  it("renders running spawn", () => {
    const spawns: SpawnInfo[] = [
      {
        agent_handle: "@worker",
        pid: 12345,
        started_at: new Date().toISOString(),
        stopped_at: null,
        alive: true,
      },
    ];
    const output = renderSpawnList(spawns);
    assert.ok(output.includes("@worker"));
    assert.ok(output.includes("12345"));
    assert.ok(output.includes("running"));
  });

  it("renders stopped spawn", () => {
    const spawns: SpawnInfo[] = [
      {
        agent_handle: "@done",
        pid: 11111,
        started_at: "2026-01-01T00:00:00Z",
        stopped_at: "2026-01-01T01:00:00Z",
        alive: false,
      },
    ];
    const output = renderSpawnList(spawns);
    assert.ok(output.includes("stopped"));
  });

  it("renders dead (not stopped but not alive) spawn", () => {
    const spawns: SpawnInfo[] = [
      {
        agent_handle: "@ghost",
        pid: 99999,
        started_at: "2026-01-01T00:00:00Z",
        stopped_at: null,
        alive: false,
      },
    ];
    const output = renderSpawnList(spawns);
    assert.ok(output.includes("dead"));
  });

  it("renders empty spawn list", () => {
    const output = renderSpawnList([]);
    assert.ok(output.includes("No spawned agents"));
  });
});

// === renderStatus ===

describe("renderStatus", () => {
  it("renders full status overview", () => {
    const output = renderStatus({
      agents: { total: 5, active: 3, blocked: 1, stopped: 1 },
      posts: 42,
      channels: [
        { name: "#work", priority: 10 },
        { name: "#escalations", priority: 100 },
      ],
      spawns: [
        {
          agent_handle: "@worker",
          pid: 123,
          started_at: new Date().toISOString(),
          stopped_at: null,
          alive: true,
        },
      ],
    });
    assert.ok(output.includes("AgentBoard Status"));
    assert.ok(output.includes("5 total"));
    assert.ok(output.includes("3 active"));
    assert.ok(output.includes("1 blocked"));
    assert.ok(output.includes("42"));
    assert.ok(output.includes("#work"));
    assert.ok(output.includes("#escalations"));
    assert.ok(output.includes("Spawned"));
    assert.ok(output.includes("@worker"));
  });

  it("omits spawned section when no spawns", () => {
    const output = renderStatus({
      agents: { total: 1, active: 1, blocked: 0, stopped: 0 },
      posts: 0,
      channels: [],
      spawns: [],
    });
    assert.ok(output.includes("AgentBoard Status"));
    assert.ok(!output.includes("Spawned"));
  });
});

// === renderResearchHistory ===

describe("renderResearchHistory", () => {
  it("renders empty research history", () => {
    const output = renderResearchHistory([]);
    assert.ok(output.includes("No research sessions"));
  });

  it("renders sessions with tag, branch, and experiments", () => {
    const sessions: ResearchSession[] = [
      {
        handle: "@researcher-security",
        tag: "security",
        preset: "security",
        branch: "agent/researcher-security",
        started_at: new Date().toISOString(),
        stopped_at: new Date().toISOString(),
        experiments: 10,
        kept: 7,
        discarded: 3,
      },
    ];
    const output = renderResearchHistory(sessions);
    assert.ok(output.includes("Research History"));
    assert.ok(output.includes("@researcher-security"));
    assert.ok(output.includes("security"));
    assert.ok(output.includes("7 kept"));
    assert.ok(output.includes("3 discarded"));
  });

  it("renders sessions without experiments", () => {
    const sessions: ResearchSession[] = [
      {
        handle: "@researcher",
        tag: "(default)",
        preset: null,
        branch: null,
        started_at: new Date().toISOString(),
        stopped_at: null,
        experiments: null,
        kept: null,
        discarded: null,
      },
    ];
    const output = renderResearchHistory(sessions);
    assert.ok(output.includes("@researcher"));
    assert.ok(!output.includes("experiments"));
  });
});

// === renderRetro ===

describe("renderRetro", () => {
  function makeRetro(overrides: Partial<RetroData> = {}): RetroData {
    return {
      sprintName: "test-sprint",
      goal: "Test goal",
      created_at: "2026-03-01T10:00:00Z",
      finished_at: "2026-03-01T12:00:00Z",
      agents: [
        {
          handle: "@worker-1",
          branch: "agent/worker-1",
          runtime: "2h",
          exitCode: 0,
          filesChanged: 5,
          additions: 100,
          deletions: 20,
        },
      ],
      conflicts: 0,
      testDelta: null,
      ...overrides,
    };
  }

  it("renders retro with sprint name and goal", () => {
    const output = renderRetro(makeRetro());
    assert.ok(output.includes("RETROSPECTIVE: test-sprint"));
    assert.ok(output.includes("Test goal"));
  });

  it("renders agent details", () => {
    const output = renderRetro(makeRetro());
    assert.ok(output.includes("@worker-1"));
    assert.ok(output.includes("exit 0"));
    assert.ok(output.includes("+100/-20"));
  });

  it("renders merge conflicts count", () => {
    const output = renderRetro(makeRetro({ conflicts: 3 }));
    assert.ok(output.includes("Merge conflicts: 3"));
  });

  it("renders test delta when available", () => {
    const output = renderRetro(makeRetro({ testDelta: 5 }));
    assert.ok(output.includes("Test delta: +5"));
  });

  it("renders negative test delta", () => {
    const output = renderRetro(makeRetro({ testDelta: -2 }));
    assert.ok(output.includes("Test delta: -2"));
  });
});

// === renderRetroMarkdown ===

describe("renderRetroMarkdown", () => {
  it("generates valid markdown with table", () => {
    const retro: RetroData = {
      sprintName: "sprint-1",
      goal: "Build features",
      created_at: "2026-03-01T10:00:00Z",
      finished_at: "2026-03-01T12:00:00Z",
      agents: [
        {
          handle: "@auth",
          branch: "agent/auth",
          runtime: "2h",
          exitCode: 0,
          filesChanged: 3,
          additions: 50,
          deletions: 10,
        },
      ],
      conflicts: 1,
      testDelta: 3,
    };
    const md = renderRetroMarkdown(retro);
    assert.ok(md.includes("# Retrospective: sprint-1"));
    assert.ok(md.includes("**Goal:** Build features"));
    assert.ok(md.includes("| @auth |"));
    assert.ok(md.includes("+50/-10"));
    assert.ok(md.includes("**Merge conflicts:** 1"));
    assert.ok(md.includes("**Test delta:** +3"));
  });
});
