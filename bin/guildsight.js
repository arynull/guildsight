#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const pkg = require('../package.json');
const db = require('../src/lib/db');
const scoring = require('../src/lib/scoring');

function usage() {
  return [
    'guildsight <command> [options]',
    '',
    'Commands:',
    '  ingest --fixture <file.jsonl>   Load a JSONL event log',
    '  report --guild <guild_id>       Engagement, churn risk, channel health',
    '  search <query>                  Search the help/forum archive',
    '  dashboard [--port N] [--host H] Serve the local dashboard (default 127.0.0.1:3000)',
    '  bot                             Run the read-only gateway collector (needs GUILDSIGHT_BOT_TOKEN)',
    '  --version                       Print version',
  ].join('\n');
}

function fail(msg, code = 2) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

function readFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return null;
  return args[i + 1];
}

function readPositional(args) {
  const flags = new Set(['--fixture', '--guild', '--port', '--host']);
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.has(args[i])) {
      i++;
      continue;
    }
    if (args[i].startsWith('--')) continue;
    rest.push(args[i]);
  }
  return rest;
}

function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  const rounded = Math.round(n * 100) / 100;
  return rounded.toFixed(2).replace(/\.00$/, '.00');
}

function ingest(args) {
  const file = readFlag(args, '--fixture');
  if (!file) fail('ingest requires --fixture <file.jsonl>');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`cannot read fixture ${file}: ${err.message}`, 1);
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let valid = 0;
  for (let i = 0; i < lines.length; i++) {
    let evt;
    try {
      evt = JSON.parse(lines[i]);
    } catch (err) {
      process.stderr.write(`warning: line ${i + 1}: invalid JSON (${err.message}), skipping\n`);
      continue;
    }
    try {
      switch (evt.type) {
        case 'message':
          if (!evt.guild_id || !evt.channel_id || !evt.message_id || !evt.author_id || evt.content == null)
            throw new Error('missing message field');
          db.recordMessage({
            guild_id: String(evt.guild_id),
            channel_id: String(evt.channel_id),
            channel_kind: evt.channel_kind || 'text',
            message_id: String(evt.message_id),
            author_id: String(evt.author_id),
            content: String(evt.content),
            created_at: evt.created_at || new Date().toISOString(),
          });
          valid++;
          break;
        case 'reaction':
          if (!evt.guild_id || !evt.author_id || !evt.target_author_id)
            throw new Error('missing reaction field');
          db.recordReaction({
            guild_id: String(evt.guild_id),
            author_id: String(evt.author_id),
            target_author_id: String(evt.target_author_id),
            created_at: evt.created_at || new Date().toISOString(),
          });
          valid++;
          break;
        case 'voice':
          if (!evt.guild_id || !evt.user_id || typeof evt.minutes !== 'number')
            throw new Error('missing voice field');
          db.recordVoice({
            guild_id: String(evt.guild_id),
            user_id: String(evt.user_id),
            minutes: evt.minutes,
            created_at: evt.created_at || new Date().toISOString(),
          });
          valid++;
          break;
        default:
          throw new Error(`unknown event type "${evt.type}"`);
      }
    } catch (err) {
      process.stderr.write(`warning: line ${i + 1}: ${err.message}, skipping\n`);
    }
  }
  if (valid === 0) fail(`no valid events applied from ${file}`, 1);
  process.stdout.write(`ingest: ${valid} event(s) applied from ${file}\n`);
  return 0;
}

function report(args) {
  const guildId = readFlag(args, '--guild');
  if (!guildId) fail('report requires --guild <guild_id>');
  const now = new Date();
  const members = db.getMembers(guildId);
  const channels = db.getChannels(guildId);

  const out = [];
  out.push('ENGAGEMENT');
  const ranked = members
    .map((m) => ({ id: m.user_id, score: scoring.engagementScore(m, now) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 10);
  ranked.forEach((row, i) => {
    out.push(`${i + 1}. ${row.id} score=${formatNumber(row.score)}`);
  });

  out.push('CHURN RISK');
  members
    .filter((m) => scoring.isChurnRisk(m, now))
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0))
    .forEach((m) => {
      out.push(`${m.user_id} last_seen=${m.last_seen}`);
    });

  out.push('LIFECYCLE');
  const lifecycleCounts = scoring.lifecycleSummary(members, now);
  out.push(
    scoring.LIFECYCLE_STAGES.map((stage) => `${stage}=${lifecycleCounts[stage]}`).join(' ')
  );

  out.push('CHANNEL HEALTH');
  channels
    .slice()
    .sort((a, b) => (a.channel_id < b.channel_id ? -1 : a.channel_id > b.channel_id ? 1 : 0))
    .forEach((ch) => {
      const h = scoring.channelHealth(ch);
      const kind = ch.kind || 'text';
      out.push(
        `${ch.channel_id} kind=${kind} trend=${h.trend} (${formatNumber(Math.round(h.trendPct))}%) ` +
          `reply_ratio=${formatNumber(h.replyRatio)} unanswered_7d=${h.unanswered}`
      );
    });

  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function search(args) {
  const query = readPositional(args).join(' ').trim();
  if (!query) fail('search requires a query');
  const rows = db.searchArchive(null, query, 20);
  for (const row of rows) {
    const content = String(row.content || '').replace(/\s+/g, ' ').slice(0, 120);
    process.stdout.write(`${row.message_id} | ${row.author_id} | ${row.created_at} | ${content}\n`);
  }
  return 0;
}

function dashboard(args) {
  // Required lazily: the dashboard is a local server and needs no Discord code.
  const { startDashboard } = require('../src/dashboard');
  const port = readFlag(args, '--port');
  const host = readFlag(args, '--host');
  if (port != null && !/^\d+$/.test(port)) fail(`--port must be a number, got "${port}"`);
  startDashboard({ port, host });
  // The server keeps the event loop alive; db stays open for the process lifetime.
  return 0;
}

function bot() {
  // Required lazily so the rest of the CLI never loads discord.js.
  const { startBot } = require('../src/bot');
  try {
    startBot();
  } catch (err) {
    fail(err.message, 1);
  }
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(pkg.version + '\n');
    return 0;
  }
  const cmd = args[0];
  // Long-running surfaces keep the DB handle open; short-lived ones close it.
  const keepAlive = cmd === 'dashboard' || cmd === 'bot';
  let code = 0;
  try {
    switch (cmd) {
      case 'ingest':
        code = ingest(args.slice(1));
        break;
      case 'report':
        code = report(args.slice(1));
        break;
      case 'search':
        code = search(args.slice(1));
        break;
      case 'dashboard':
        code = dashboard(args.slice(1));
        break;
      case 'bot':
        code = bot();
        break;
      default:
        fail(`unknown command "${cmd}"\n\n${usage()}`);
    }
  } finally {
    if (!keepAlive) db.closeDb();
  }
  return { code, keepAlive };
}

const result = main(process.argv);
if (result.keepAlive) {
  // dashboard/bot own the event loop (listener / gateway session): do not exit.
  process.exitCode = result.code;
} else {
  process.exit(result.code);
}
