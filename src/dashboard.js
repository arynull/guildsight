'use strict';

/**
 * guildsight local dashboard — Express, bound to loopback, read-only.
 *
 * Serves HTML pages and a JSON API from the local SQLite archive. It performs
 * no outbound network calls at all: no Discord gateway, no remote assets, no
 * external fonts or CDNs. One guild is in focus per request, selected with
 * `?guild=<id>` and defaulting to the first guild that has data.
 */

const express = require('express');
const db = require('./lib/db');
const scoring = require('./lib/scoring');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape untrusted text for interpolation into HTML text or attributes. */
function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Guild ids that have any data, deterministic order. */
function listGuilds() {
  return db
    .getDb()
    .prepare(
      `SELECT guild_id FROM members
       UNION SELECT guild_id FROM channels
       UNION SELECT guild_id FROM messages
       ORDER BY guild_id`
    )
    .all()
    .map((r) => r.guild_id);
}

/** Resolve the guild in focus for a request, or null when the store is empty. */
function resolveGuildId(req) {
  const requested = req.query.guild;
  const guilds = listGuilds();
  if (requested != null && String(requested).trim() !== '') return String(requested);
  return guilds.length ? guilds[0] : null;
}

/** All guilds known locally, for the picker. */
function guildOptions(activeGuild) {
  return listGuilds()
    .map(
      (g) =>
        `<option value="${escapeHtml(g)}"${g === activeGuild ? ' selected' : ''}>${escapeHtml(g)}</option>`
    )
    .join('');
}

function fmt(n) {
  if (n == null || n === '') return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return escapeHtml(n);
  return num.toFixed(2).replace(/\.00$/, '');
}

function fmtPct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return `${Math.round(num * 100)}%`;
}

function daysAgoLabel(days) {
  if (days == null) return '—';
  const d = Number(days);
  if (!Number.isFinite(d)) return '—';
  if (d >= 36500) return 'never';
  if (d >= 2) return `${Math.floor(d)}d ago`;
  return 'today';
}

// ---------------------------------------------------------------------------
// Data shaping (shared by HTML pages and JSON API)
// ---------------------------------------------------------------------------

function memberRows(guildId, now = new Date()) {
  if (guildId == null) return [];
  return db
    .getMembers(guildId)
    .map((m) => {
      const days = Number.isFinite(scoring.daysSince(m.last_seen, now)) ? scoring.daysSince(m.last_seen, now) : null;
      return {
        user_id: m.user_id,
        score: Math.round(scoring.engagementScore(m, now) * 100) / 100,
        lifecycle: scoring.lifecycleStage(m, now),
        message_count: m.message_count || 0,
        reactions_given: m.reactions_given || 0,
        reactions_received: m.reactions_received || 0,
        voice_minutes: Math.round((m.voice_minutes || 0) * 100) / 100,
        first_seen: m.first_seen,
        last_seen: m.last_seen,
        days_since_last_seen: days,
        churn_risk: scoring.isChurnRisk(m, now),
      };
    })
    .sort((a, b) => b.score - a.score || (a.user_id < b.user_id ? -1 : 1));
}

function channelRows(guildId) {
  if (guildId == null) return [];
  return db
    .getChannels(guildId)
    .map((ch) => {
      const h = scoring.channelHealth(ch);
      return {
        channel_id: ch.channel_id,
        kind: ch.kind || 'text',
        msg_7d: ch.msg_7d || 0,
        msg_prev_7d: ch.msg_prev_7d || 0,
        trend: h.trend,
        trend_pct: Math.round(h.trendPct * 100) / 100,
        reply_ratio: h.replyRatio,
        unanswered_7d: h.unanswered,
      };
    })
    .sort((a, b) => (a.channel_id < b.channel_id ? -1 : 1));
}

function overviewData(guildId, now = new Date()) {
  const members = memberRows(guildId, now);
  const channels = channelRows(guildId);
  const churn = members.filter((m) => m.churn_risk);
  const totals = members.reduce(
    (acc, m) => {
      acc.messages += m.message_count;
      acc.reactions_given += m.reactions_given;
      acc.reactions_received += m.reactions_received;
      acc.voice_minutes += m.voice_minutes;
      return acc;
    },
    { messages: 0, reactions_given: 0, reactions_received: 0, voice_minutes: 0 }
  );
  const needsAttention = channels.filter((c) => c.kind === 'help' || c.kind === 'forum');
  return {
    guild_id: guildId,
    guilds: listGuilds(),
    generated_at: now.toISOString(),
    totals: {
      members: members.length,
      channels: channels.length,
      churn_risk: churn.length,
      messages: totals.messages,
      reactions_given: totals.reactions_given,
      reactions_received: totals.reactions_received,
      voice_minutes: Math.round(totals.voice_minutes * 100) / 100,
      unanswered_7d: channels.reduce((n, c) => n + c.unanswered_7d, 0),
    },
    channel_health_summary: {
      up: channels.filter((c) => c.trend === 'up').length,
      flat: channels.filter((c) => c.trend === 'flat').length,
      down: channels.filter((c) => c.trend === 'down').length,
      help_or_forum: needsAttention.length,
      help_or_forum_unanswered: needsAttention.reduce((n, c) => n + c.unanswered_7d, 0),
    },
    top_members: members.slice(0, 10),
    churn_risk: churn,
    lifecycle_summary: scoring.lifecycleSummary(members, now),
  };
}

function searchData(guildId, q, limit = 20) {
  const query = String(q == null ? '' : q).trim();
  if (!query) return { query, results: [] };
  const results = db.searchArchive(guildId, query, limit).map((r) => ({
    message_id: r.message_id,
    guild_id: r.guild_id,
    channel_id: r.channel_id,
    author_id: r.author_id,
    content: r.content,
    created_at: r.created_at,
  }));
  return { query, results };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const STYLE = `
:root { color-scheme: light dark; --fg:#1b1f24; --muted:#5b6672; --line:#d8dee6; --bg:#ffffff; --accent:#3b5bdb; --warn:#b02a37; }
@media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --muted:#9aa6b2; --line:#2d333b; --bg:#0d1117; --accent:#7a9cff; --warn:#ff7b72; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; }
header h1 { font-size:18px; margin:0; letter-spacing:-0.01em; }
header .who { color:var(--muted); font-size:13px; }
nav { padding:0 24px; border-bottom:1px solid var(--line); }
nav a { display:inline-block; padding:8px 12px; color:var(--accent); text-decoration:none; border-bottom:2px solid transparent; }
nav a.active { border-bottom-color:var(--accent); font-weight:600; }
main { padding:24px; max-width:1100px; }
table { border-collapse:collapse; width:100%; margin:12px 0 24px; }
th, td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
th { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
td.num, th.num { text-align:right; }
.flag { color:var(--warn); font-weight:600; }
.muted { color:var(--muted); }
.cards { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:24px; }
.card { border:1px solid var(--line); border-radius:8px; padding:12px 16px; min-width:150px; }
.card .k { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
.card .v { font-size:22px; font-weight:600; }
form.search { display:flex; gap:8px; margin:12px 0; flex-wrap:wrap; }
input[type=text] { flex:1 1 320px; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); font:inherit; }
button, select { padding:8px 12px; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); font:inherit; cursor:pointer; }
select { flex:0 0 auto; }
.msg { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin-bottom:10px; }
.msg .meta { font-size:12px; color:var(--muted); }
footer { padding:16px 24px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); }
`;

function layout({ title, guildId, active, body }) {
  const link = (href, label) =>
    `<a href="${escapeHtml(href)}"${active === label ? ' class="active"' : ''}>${escapeHtml(label)}</a>`;
  const q = guildId == null ? '' : `?guild=${encodeURIComponent(guildId)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} — guildsight</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>guildsight</h1>
  <span class="who">${guildId == null ? 'no guild data yet' : `guild ${escapeHtml(guildId)}`}</span>
  <form class="search" method="get" action="/">
    <select name="guild" onchange="this.form.submit()" aria-label="Guild">
      ${guildOptions(guildId) || '<option value="">(no guilds)</option>'}
    </select>
    <button type="submit">Switch</button>
  </form>
</header>
<nav>${link('/', 'overview')}${link(`/members${q}`, 'members')}${link(`/channels${q}`, 'channels')}${link(`/archive${q}`, 'archive')}</nav>
<main>${body}</main>
<footer>Read-only local view. No data leaves this machine.</footer>
</body>
</html>`;
}

function guildPickerNote(guildId) {
  return guildId == null
    ? '<p class="muted">No guild data found. Load a fixture with <code>guildsight ingest --fixture &lt;file.jsonl&gt;</code>.</p>'
    : '';
}

function renderOverview(data) {
  const t = data.totals;
  const card = (k, v) => `<div class="card"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`;
  const rows = data.top_members
    .map(
      (m, i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(m.user_id)}</td><td class="num">${escapeHtml(fmt(m.score))}</td>` +
        `<td class="num">${escapeHtml(m.message_count)}</td><td>${escapeHtml(daysAgoLabel(m.days_since_last_seen))}</td>` +
        `<td>${m.churn_risk ? '<span class="flag">churn risk</span>' : '<span class="muted">active</span>'}</td></tr>`
    )
    .join('');
  const s = data.channel_health_summary;
  const lc = data.lifecycle_summary || {};
  const lcCards = scoring.LIFECYCLE_STAGES.map((stage) => card(stage, lc[stage] == null ? '—' : lc[stage])).join('\n  ');
  return `
<div class="cards">
  ${card('members', t.members)}
  ${card('channels', t.channels)}
  ${card('churn risk', t.churn_risk)}
  ${card('messages', t.messages)}
  ${card('voice minutes', fmt(t.voice_minutes))}
  ${card('unanswered 7d', t.unanswered_7d)}
</div>
<h2>Member lifecycle</h2>
<div class="cards">
  ${lcCards}
</div>
<h2>Channel health</h2>
<p class="muted">${escapeHtml(s.up)} up · ${escapeHtml(s.flat)} flat · ${escapeHtml(s.down)} down · ${escapeHtml(s.help_or_forum)} help/forum channel(s) with ${escapeHtml(s.help_or_forum_unanswered)} unanswered</p>
<h2>Top members</h2>
<table>
  <thead><tr><th>#</th><th>User</th><th class="num">Score</th><th class="num">Messages</th><th>Last seen</th><th>Status</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="muted">No members recorded.</td></tr>'}</tbody>
</table>`;
}

function renderMembers(rows, guildId) {
  const body = rows
    .map(
      (m) =>
        `<tr><td>${escapeHtml(m.user_id)}</td><td class="num">${escapeHtml(fmt(m.score))}</td>` +
        `<td>${escapeHtml(m.lifecycle || 'unknown')}</td>` +
        `<td class="num">${escapeHtml(m.message_count)}</td><td>${escapeHtml(daysAgoLabel(m.days_since_last_seen))}</td>` +
        `<td>${m.churn_risk ? '<span class="flag">yes</span>' : '<span class="muted">no</span>'}</td></tr>`
    )
    .join('');
  return `<h2>Engagement leaderboard</h2>
<p class="muted">Score = 1.0·messages + 0.5·reactions given + 0.7·reactions received + 0.05·voice minutes, decayed with a 30-day half-life.</p>
<table>
  <thead><tr><th>User</th><th class="num">Score</th><th>Stage</th><th class="num">Messages</th><th>Last seen</th><th>Churn risk</th></tr></thead>
  <tbody>${body || '<tr><td colspan="6" class="muted">No members recorded.</td></tr>'}</tbody>
</table>
<p class="muted">Guild ${escapeHtml(guildId == null ? '—' : guildId)}</p>`;
}

function renderChannels(rows) {
  const body = rows
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.channel_id)}</td><td>${escapeHtml(c.kind)}</td><td>${escapeHtml(c.trend)}</td>` +
        `<td class="num">${escapeHtml(Math.round(c.trend_pct))}%</td><td class="num">${escapeHtml(fmtPct(c.reply_ratio))}</td>` +
        `<td class="num">${escapeHtml(c.unanswered_7d)}</td></tr>`
    )
    .join('');
  return `<h2>Channel health</h2>
<p class="muted">Trend compares the last 7 days against the prior 7 days. Unanswered counts help/forum messages with no reply within 48h.</p>
<table>
  <thead><tr><th>Channel</th><th>Kind</th><th>Trend</th><th class="num">Δ</th><th class="num">Reply ratio</th><th class="num">Unanswered 7d</th></tr></thead>
  <tbody>${body || '<tr><td colspan="6" class="muted">No channels recorded.</td></tr>'}</tbody>
</table>`;
}

function renderArchive(guildId, data) {
  const hidden = guildId == null ? '' : `<input type="hidden" name="guild" value="${escapeHtml(guildId)}">`;
  const results = data.results
    .map(
      (r) =>
        `<div class="msg"><div class="meta">${escapeHtml(r.created_at)} · ${escapeHtml(r.channel_id)} · ${escapeHtml(r.author_id)}</div>` +
        `${escapeHtml(String(r.content || '').slice(0, 400))}</div>`
    )
    .join('');
  const status = !data.query
    ? '<p class="muted">Enter a query to search help and forum history.</p>'
    : results
      ? results
      : '<p class="muted">No matches.</p>';
  return `<h2>Archive search</h2>
<form class="search" method="get" action="/archive">
  ${hidden}
  <input type="text" name="q" value="${escapeHtml(data.query)}" placeholder="e.g. reset password" aria-label="Search query">
  <button type="submit">Search</button>
</form>
${status}`;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/** Build the Express app. Requires no Discord token and no network access. */
function createApp({ now = () => new Date() } = {}) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/overview', (req, res) => {
    const nowMs = now();
    res.json(overviewData(resolveGuildId(req), nowMs));
  });

  app.get('/api/members', (req, res) => {
    const guildId = resolveGuildId(req);
    res.json({ guild_id: guildId, members: memberRows(guildId, now()) });
  });

  app.get('/api/channels', (req, res) => {
    const guildId = resolveGuildId(req);
    res.json({ guild_id: guildId, channels: channelRows(guildId, now()) });
  });

  app.get('/api/search', (req, res) => {
    const guildId = resolveGuildId(req);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
    res.json({ guild_id: guildId, ...searchData(guildId, req.query.q, limit) });
  });

  const html = (res, body) => res.type('html').send(body);

  app.get('/', (req, res) => {
    const guildId = resolveGuildId(req);
    const data = overviewData(guildId, now());
    html(
      res,
      layout({
        title: 'Overview',
        guildId,
        active: 'overview',
        body: guildPickerNote(guildId) + renderOverview(data),
      })
    );
  });

  app.get('/members', (req, res) => {
    const guildId = resolveGuildId(req);
    html(
      res,
      layout({
        title: 'Members',
        guildId,
        active: 'members',
        body: guildPickerNote(guildId) + renderMembers(memberRows(guildId, now()), guildId),
      })
    );
  });

  app.get('/channels', (req, res) => {
    const guildId = resolveGuildId(req);
    html(
      res,
      layout({
        title: 'Channels',
        guildId,
        active: 'channels',
        body: guildPickerNote(guildId) + renderChannels(channelRows(guildId, now())),
      })
    );
  });

  app.get('/archive', (req, res) => {
    const guildId = resolveGuildId(req);
    html(
      res,
      layout({
        title: 'Archive',
        guildId,
        active: 'archive',
        body: guildPickerNote(guildId) + renderArchive(guildId, searchData(guildId, req.query.q)),
      })
    );
  });

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'not found' });
  });

  return app;
}

/**
 * Boot the dashboard.
 * @param {object} [opts]
 * @param {number} [opts.port] default: PORT env or 3000
 * @param {string} [opts.host] default: HOST env or 127.0.0.1
 * @returns {import('node:http').Server}
 */
function startDashboard({ port, host } = {}) {
  const resolvedPort = port != null ? Number(port) : Number(process.env.PORT) || DEFAULT_PORT;
  const resolvedHost = host || process.env.HOST || DEFAULT_HOST;
  const app = createApp();
  const server = app.listen(resolvedPort, resolvedHost, () => {
    const addr = server.address();
    const shown = typeof addr === 'object' && addr ? `${addr.address}:${addr.port}` : `${resolvedHost}:${resolvedPort}`;
    process.stdout.write(`guildsight dashboard listening on http://${shown}\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`dashboard error: ${err.message}\n`);
  });
  return server;
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  escapeHtml,
  listGuilds,
  resolveGuildId,
  memberRows,
  channelRows,
  overviewData,
  searchData,
  createApp,
  startDashboard,
};

if (require.main === module) {
  startDashboard();
}
