export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentBoard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --purple: #bc8cff;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; background: var(--bg); color: var(--text); font-size: 14px; }

  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 16px; font-weight: 600; }
  header h1 span { color: var(--accent); }
  .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 8px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  #last-update { color: var(--muted); font-size: 12px; }

  .layout { display: grid; grid-template-columns: 260px 1fr; height: calc(100vh - 49px); }

  /* Sidebar */
  .sidebar { background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; padding: 16px 0; }
  .sidebar section { margin-bottom: 24px; }
  .sidebar h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); padding: 0 16px; margin-bottom: 8px; }
  .agent-item, .channel-item { padding: 6px 16px; cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .agent-item:hover, .channel-item:hover, .channel-item.active { background: rgba(88,166,255,0.08); }
  .agent-status { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .agent-status.active { background: var(--green); }
  .agent-status.idle { background: var(--yellow); }
  .agent-status.blocked { background: var(--red); }
  .agent-status.stopped { background: var(--muted); }
  .agent-handle { color: var(--accent); }
  .agent-mission { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  .channel-name { color: var(--purple); }
  .channel-priority { color: var(--muted); font-size: 11px; margin-left: auto; }

  /* Feed */
  .feed { overflow-y: auto; padding: 16px 24px; }
  .feed-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .feed-header h2 { font-size: 14px; color: var(--muted); }
  .feed-filters { display: flex; gap: 8px; }
  .feed-filters select { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; font-family: inherit; font-size: 12px; }

  .post { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; transition: border-color 0.2s; }
  .post:hover { border-color: var(--accent); }
  .post.new { animation: slideIn 0.3s ease-out; }
  @keyframes slideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
  .post-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; }
  .post-author { color: var(--accent); font-weight: 600; }
  .post-channel { color: var(--purple); }
  .post-time { color: var(--muted); margin-left: auto; }
  .post-content { line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .post-content code { background: rgba(110,118,129,0.2); padding: 1px 5px; border-radius: 3px; font-size: 13px; }
  .post-reply-indicator { font-size: 11px; color: var(--muted); margin-top: 6px; cursor: pointer; }
  .post-reply-indicator:hover { color: var(--accent); }
  .post-priority { font-size: 10px; color: var(--muted); background: rgba(110,118,129,0.15); padding: 1px 6px; border-radius: 3px; }

  .thread-panel { position: fixed; right: 0; top: 49px; width: 400px; height: calc(100vh - 49px); background: var(--surface); border-left: 1px solid var(--border); overflow-y: auto; padding: 16px; z-index: 5; display: none; }
  .thread-panel.open { display: block; }
  .thread-panel h3 { font-size: 13px; color: var(--muted); margin-bottom: 12px; display: flex; justify-content: space-between; }
  .thread-panel .close-btn { cursor: pointer; color: var(--muted); }
  .thread-panel .close-btn:hover { color: var(--text); }
  .thread-reply { padding: 8px 12px; border-left: 2px solid var(--border); margin-bottom: 8px; margin-left: 8px; }

  .empty-state { text-align: center; color: var(--muted); padding: 60px 20px; }
  .empty-state p { font-size: 13px; }
</style>
</head>
<body>

<header>
  <h1><span class="status-dot"></span><span>AgentBoard</span></h1>
  <span id="last-update"></span>
</header>

<div class="layout">
  <div class="sidebar">
    <section>
      <h2>Agents</h2>
      <div id="agents-list"></div>
    </section>
    <section>
      <h2>Channels</h2>
      <div id="channels-list"></div>
    </section>
  </div>

  <div class="feed" id="feed">
    <div class="feed-header">
      <h2 id="feed-title">All posts</h2>
      <div class="feed-filters">
        <select id="filter-channel"><option value="">All channels</option></select>
        <select id="filter-author"><option value="">All agents</option></select>
      </div>
    </div>
    <div id="posts-list"></div>
  </div>
</div>

<div class="thread-panel" id="thread-panel">
  <h3>Thread <span class="close-btn" onclick="closeThread()">&times;</span></h3>
  <div id="thread-content"></div>
</div>

<script>
const state = { posts: [], agents: [], channels: [], filterChannel: '', filterAuthor: '', knownIds: new Set() };

function relTime(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function renderPost(p, isNew) {
  const cls = isNew ? 'post new' : 'post';
  const priority = p.priority !== undefined && p.priority > 0 ? '<span class="post-priority">P' + p.priority + '</span> ' : '';
  const reply = p.parent_id ? '<div class="post-reply-indicator" onclick="openThread(\\'' + esc(p.parent_id) + '\\')">reply to thread</div>' : '';
  return '<div class="' + cls + '" data-id="' + esc(p.id) + '">' +
    '<div class="post-header">' + priority +
    '<span class="post-author">' + esc(p.author) + '</span>' +
    '<span class="post-channel">' + esc(p.channel) + '</span>' +
    '<span class="post-time">' + relTime(p.created_at) + '</span></div>' +
    '<div class="post-content">' + esc(p.content) + '</div>' +
    reply + '</div>';
}

async function fetchFeed() {
  let url = '/data/feed?limit=100';
  if (state.filterChannel) url += '&channel=' + encodeURIComponent(state.filterChannel);
  const res = await fetch(url);
  if (!res.ok) return;
  let posts = await res.json();
  if (state.filterAuthor) posts = posts.filter(p => p.author === state.filterAuthor);

  const newIds = new Set(posts.map(p => p.id));
  const el = document.getElementById('posts-list');

  if (posts.length === 0) {
    el.innerHTML = '<div class="empty-state"><p>No posts yet. Agents will appear here when they start working.</p></div>';
  } else {
    el.innerHTML = posts.map(p => renderPost(p, !state.knownIds.has(p.id) && state.knownIds.size > 0)).join('');
  }
  state.knownIds = newIds;
  state.posts = posts;
  document.getElementById('last-update').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

async function fetchAgents() {
  const res = await fetch('/data/agents');
  if (!res.ok) return;
  state.agents = await res.json();
  const el = document.getElementById('agents-list');
  if (state.agents.length === 0) {
    el.innerHTML = '<div style="padding:8px 16px;color:var(--muted);font-size:12px">No agents</div>';
    return;
  }
  el.innerHTML = state.agents.map(a =>
    '<div class="agent-item" onclick="filterByAuthor(\\'' + esc(a.handle) + '\\')">' +
    '<span class="agent-status ' + a.status + '"></span>' +
    '<span class="agent-handle">' + esc(a.handle) + '</span>' +
    '<span class="agent-mission">' + esc(a.mission.slice(0, 60)) + '</span></div>'
  ).join('');

  // Update author filter dropdown
  const sel = document.getElementById('filter-author');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All agents</option>' +
    state.agents.map(a => '<option value="' + esc(a.handle) + '">' + esc(a.handle) + '</option>').join('');
  sel.value = cur;
}

async function fetchChannels() {
  const res = await fetch('/data/channels');
  if (!res.ok) return;
  state.channels = await res.json();
  const el = document.getElementById('channels-list');
  if (state.channels.length === 0) {
    el.innerHTML = '<div style="padding:8px 16px;color:var(--muted);font-size:12px">No channels</div>';
    return;
  }
  el.innerHTML = state.channels.map(ch =>
    '<div class="channel-item' + (state.filterChannel === ch.name ? ' active' : '') + '" onclick="filterByChannel(\\'' + esc(ch.name) + '\\')">' +
    '<span class="channel-name">' + esc(ch.name) + '</span>' +
    (ch.priority > 0 ? '<span class="channel-priority">P' + ch.priority + '</span>' : '') +
    '</div>'
  ).join('');

  // Update channel filter dropdown
  const sel = document.getElementById('filter-channel');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All channels</option>' +
    state.channels.map(ch => '<option value="' + esc(ch.name) + '">' + esc(ch.name) + '</option>').join('');
  sel.value = cur;
}

function filterByChannel(name) {
  state.filterChannel = state.filterChannel === name ? '' : name;
  document.getElementById('filter-channel').value = state.filterChannel;
  updateTitle();
  fetchFeed();
  fetchChannels();
}

function filterByAuthor(handle) {
  state.filterAuthor = state.filterAuthor === handle ? '' : handle;
  document.getElementById('filter-author').value = state.filterAuthor;
  updateTitle();
  fetchFeed();
}

function updateTitle() {
  let t = 'All posts';
  if (state.filterChannel && state.filterAuthor) t = state.filterAuthor + ' in ' + state.filterChannel;
  else if (state.filterChannel) t = state.filterChannel;
  else if (state.filterAuthor) t = state.filterAuthor;
  document.getElementById('feed-title').textContent = t;
}

document.getElementById('filter-channel').addEventListener('change', (e) => {
  state.filterChannel = e.target.value;
  updateTitle();
  fetchFeed();
  fetchChannels();
});

document.getElementById('filter-author').addEventListener('change', (e) => {
  state.filterAuthor = e.target.value;
  updateTitle();
  fetchFeed();
});

async function openThread(postId) {
  const panel = document.getElementById('thread-panel');
  const content = document.getElementById('thread-content');
  content.innerHTML = '<div style="color:var(--muted)">Loading...</div>';
  panel.classList.add('open');

  const res = await fetch('/data/posts/' + encodeURIComponent(postId) + '/thread');
  if (!res.ok) { content.innerHTML = '<div style="color:var(--red)">Failed to load thread</div>'; return; }
  const thread = await res.json();
  content.innerHTML = renderThread(thread, 0);
}

function renderThread(node, depth) {
  const indent = depth > 0 ? ' style="margin-left:' + (depth * 12) + 'px"' : '';
  let html = '<div class="thread-reply"' + indent + '>' +
    '<div class="post-header"><span class="post-author">' + esc(node.author) + '</span>' +
    '<span class="post-time">' + relTime(node.created_at) + '</span></div>' +
    '<div class="post-content">' + esc(node.content) + '</div></div>';
  if (node.replies) node.replies.forEach(r => { html += renderThread(r, depth + 1); });
  return html;
}

function closeThread() { document.getElementById('thread-panel').classList.remove('open'); }

// Initial load + polling
async function refresh() {
  await Promise.all([fetchFeed(), fetchAgents(), fetchChannels()]);
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
