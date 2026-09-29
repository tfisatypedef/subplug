import { STATUS_GROUPS, statusGroup } from "../shared/status.ts"
import type { MonitorState } from "../shared/types.ts"

export type WebTranscriptMessage = {
  role: string
  agent?: string
  model?: string
  text: string
}

export type WebTranscript = {
  sessionID: string
  messages: WebTranscriptMessage[]
}

export type WebSource = {
  state: () => MonitorState
  transcript: (sessionID: string) => Promise<WebTranscript | undefined>
  token?: string
}

export type WebView = MonitorState & {
  groups: Record<string, string>
  groupOrder: string[]
  groupLabels: Record<string, string>
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })
}

function html(value: string): Response {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })
}

export function webView(state: MonitorState): WebView {
  const groups: Record<string, string> = {}
  for (const session of state.sessions) groups[session.sessionID] = statusGroup(session)
  return {
    ...state,
    groups,
    groupOrder: Object.keys(STATUS_GROUPS),
    groupLabels: Object.fromEntries(Object.entries(STATUS_GROUPS).map(([key, value]) => [key, value.label])),
  }
}

export function createWebFetch(source: WebSource): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
    if (source.token && url.searchParams.get("token") !== source.token) {
      return json({ error: "unauthorized" }, 401)
    }
    if (url.pathname === "/") return html(PAGE)
    if (url.pathname === "/api/state") return json(webView(source.state()))
    const match = /^\/api\/session\/([^/]+)$/.exec(url.pathname)
    if (match?.[1]) {
      const transcript = await source.transcript(decodeURIComponent(match[1]))
      return transcript ? json(transcript) : json({ error: "not found" }, 404)
    }
    return json({ error: "not found" }, 404)
  }
}

export function startWebServer(
  source: WebSource,
  options: { port: number },
): { port: number; stop: () => void } | { error: string } {
  if (typeof Bun === "undefined") {
    return { error: "the web view requires the Bun runtime" }
  }
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      fetch: createWebFetch(source),
    })
    return { port: server.port ?? options.port, stop: () => server.stop(true) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>subplug</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:#101010;color:#ddd;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
h1{margin:0;font-size:14px}
h2{margin:0 0 6px;font-size:13px}
.muted{color:#888}
section{margin-top:16px}
.row{display:flex;gap:8px;align-items:baseline;padding:2px 4px;white-space:nowrap;overflow:hidden}
.row.click{cursor:pointer}
.row:hover{background:#1a1a1a}
.row.selected{background:#222}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;display:inline-block}
.title{overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}
button{background:#1a1a1a;color:#ddd;border:1px solid #333;padding:2px 8px;cursor:pointer;font:inherit;margin-right:4px}
button.active{border-color:#5f87ff;color:#fff}
#transcript{border:1px solid #333;padding:8px;max-height:45vh;overflow:auto;white-space:pre-wrap}
.conflict{color:#f66}
</style>
</head>
<body>
<header>
  <h1>subplug <span class="muted">command center</span></h1>
  <span id="meta" class="muted">loading&hellip;</span>
</header>
<div id="filters"></div>
<section><h2>Sessions <span id="sessionCount" class="muted"></span></h2><div id="sessions"></div></section>
<section><h2>Claims <span id="claimCount" class="muted"></span></h2><div id="claims"></div></section>
<section><h2>Transcript</h2><div id="transcript" class="muted">select a session</div></section>
<script>
var token = new URLSearchParams(location.search).get("token") || "";
var COLORS = { needs: "#ff5555", working: "#55ff55", ready: "#5f87ff", inactive: "#888888" };
var current = null;
var filter = "all";
var selected = null;

function withToken(path) {
  if (!token) return path;
  return path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
}
function esc(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}
function age(ts, now) {
  var seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return seconds + "s";
  var minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m";
  var hours = Math.round(minutes / 60);
  if (hours < 48) return hours + "h";
  return Math.round(hours / 24) + "d";
}
function dot(group) {
  return '<span class="dot" style="background:' + (COLORS[group] || "#888") + '"></span>';
}

async function pull() {
  try {
    var response = await fetch(withToken("/api/state"));
    current = await response.json();
    render();
  } catch (error) {
    document.getElementById("meta").textContent = "connection lost";
  }
}
function render() {
  var state = current;
  if (!state) return;
  document.getElementById("meta").textContent =
    "updated " + new Date(state.generatedAt).toLocaleTimeString() + " | hub " + state.hubDir;

  var counts = { all: state.sessions.length };
  for (var i = 0; i < state.sessions.length; i += 1) {
    var group = state.groups[state.sessions[i].sessionID] || "inactive";
    counts[group] = (counts[group] || 0) + 1;
  }
  var filters = document.getElementById("filters");
  filters.innerHTML = "";
  var entries = [["all", "All " + counts.all]];
  for (var j = 0; j < state.groupOrder.length; j += 1) {
    var key = state.groupOrder[j];
    entries.push([key, state.groupLabels[key] + " " + (counts[key] || 0)]);
  }
  entries.forEach(function (entry) {
    var button = document.createElement("button");
    button.textContent = entry[1];
    if (filter === entry[0]) button.className = "active";
    button.onclick = function () { filter = entry[0]; render(); };
    filters.appendChild(button);
  });

  var sessions = state.sessions.slice().sort(function (a, b) { return (b.lastEventAt || 0) - (a.lastEventAt || 0); });
  var list = document.getElementById("sessions");
  list.innerHTML = "";
  sessions.forEach(function (session) {
    var group = state.groups[session.sessionID] || "inactive";
    if (filter !== "all" && group !== filter) return;
    var row = document.createElement("div");
    row.className = "row click" + (session.sessionID === selected ? " selected" : "");
    row.innerHTML = dot(group)
      + '<span class="title">' + esc(session.title || session.sessionID.slice(0, 12)) + "</span>"
      + '<span class="muted">' + esc(state.groupLabels[group] || group) + "</span>"
      + '<span class="muted">' + esc(session.agent || "-") + "</span>"
      + '<span class="muted">' + age(session.lastEventAt || state.generatedAt, state.generatedAt) + "</span>";
    row.onclick = function () { selected = session.sessionID; render(); loadTranscript(session.sessionID); };
    list.appendChild(row);
  });
  document.getElementById("sessionCount").textContent = "(" + state.sessions.length + ")";

  var active = (state.registry.claims || []).filter(function (claim) { return claim.status === "active"; });
  var conflicts = state.registry.conflicts || [];
  document.getElementById("claimCount").textContent =
    "(" + active.length + " active" + (conflicts.length ? ", " + conflicts.length + " conflict(s)" : "") + ")";
  var claims = document.getElementById("claims");
  if (!active.length) {
    claims.innerHTML = '<div class="row muted">no active claims</div>';
    return;
  }
  claims.innerHTML = active.map(function (claim) {
    var conflicted = conflicts.some(function (conflict) {
      return conflict.a === claim.claimID || conflict.b === claim.claimID;
    });
    return '<div class="row"><span class="muted">' + esc(claim.claimID) + "</span>"
      + "<span>" + esc(claim.agent) + "</span>"
      + (conflicted ? '<span class="conflict">conflict</span>' : "")
      + '<span class="muted">expires ' + esc(claim.expires) + "</span></div>";
  }).join("");
}
async function loadTranscript(sessionID) {
  var panel = document.getElementById("transcript");
  panel.textContent = "loading...";
  try {
    var response = await fetch(withToken("/api/session/" + encodeURIComponent(sessionID)));
    var data = await response.json();
    if (!data.messages || !data.messages.length) {
      panel.textContent = "no transcript";
      return;
    }
    panel.innerHTML = data.messages.map(function (message) {
      var who = esc(message.role) + (message.agent ? " | " + esc(message.agent) : "");
      return '<div><span class="muted">' + who + ":</span>\\n" + esc(message.text) + "</div>";
    }).join("\\n");
  } catch (error) {
    panel.textContent = "transcript unavailable";
  }
}
setInterval(pull, 1000);
pull();
</script>
</body>
</html>`
