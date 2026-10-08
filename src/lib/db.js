'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

let db = null;

function dataDir() {
  return process.env.GUILDSIGHT_DATA_DIR || path.join(__dirname, '..', '..', 'data');
}

function dbFilePath() {
  return path.join(dataDir(), 'guildsight.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members(
  guild_id TEXT,
  user_id TEXT,
  first_seen TEXT,
  last_seen TEXT,
  message_count INTEGER DEFAULT 0,
  reactions_given INTEGER DEFAULT 0,
  reactions_received INTEGER DEFAULT 0,
  voice_minutes REAL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
CREATE TABLE IF NOT EXISTS channels(
  guild_id TEXT,
  channel_id TEXT,
  kind TEXT DEFAULT 'text',
  msg_7d INTEGER DEFAULT 0,
  msg_prev_7d INTEGER DEFAULT 0,
  reply_ratio REAL DEFAULT 0,
  unanswered_7d INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id)
);
CREATE TABLE IF NOT EXISTS messages(
  message_id TEXT PRIMARY KEY,
  guild_id TEXT,
  channel_id TEXT,
  author_id TEXT,
  content TEXT,
  created_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content);
CREATE TRIGGER IF NOT EXISTS messages_fts_after_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_after_update AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

function openDb() {
  if (db) return db;
  fs.mkdirSync(dataDir(), { recursive: true });
  db = new Database(dbFilePath());
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

function getDb() {
  if (!db) openDb();
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function resetDb() {
  const d = getDb();
  d.exec('DELETE FROM messages; DELETE FROM messages_fts; DELETE FROM members; DELETE FROM channels;');
}

function upsertMember(guildId, userId, seen = null) {
  const d = getDb();
  if (seen == null) {
    d.prepare('INSERT OR IGNORE INTO members(guild_id, user_id) VALUES (?, ?)').run(guildId, userId);
    return;
  }
  d.prepare(
    `INSERT INTO members(guild_id, user_id, first_seen, last_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET
       first_seen = CASE
         WHEN members.first_seen IS NULL OR excluded.first_seen < members.first_seen
         THEN excluded.first_seen ELSE members.first_seen END,
       last_seen = CASE
         WHEN members.last_seen IS NULL OR excluded.last_seen > members.last_seen
         THEN excluded.last_seen ELSE members.last_seen END`
  ).run(guildId, userId, seen, seen);
}

function ensureChannel(guildId, channelId, kind) {
  getDb()
    .prepare('INSERT OR IGNORE INTO channels(guild_id, channel_id, kind) VALUES (?, ?, ?)')
    .run(guildId, channelId, kind || 'text');
}

function recordMessage({ guild_id, channel_id, channel_kind, message_id, author_id, content, created_at }) {
  const d = getDb();
  ensureChannel(guild_id, channel_id, channel_kind);
  upsertMember(guild_id, author_id, created_at);
  const info = d
    .prepare(
      'INSERT OR IGNORE INTO messages(message_id, guild_id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(message_id, guild_id, channel_id, author_id, content, created_at);
  if (info.changes === 0) return false;
  d.prepare(
    `UPDATE members SET message_count = message_count + 1,
       last_seen = CASE WHEN last_seen IS NULL OR ? > last_seen THEN ? ELSE last_seen END
     WHERE guild_id = ? AND user_id = ?`
  ).run(created_at, created_at, guild_id, author_id);
  d.prepare('UPDATE channels SET msg_7d = msg_7d + 1 WHERE guild_id = ? AND channel_id = ?').run(
    guild_id,
    channel_id
  );
  return true;
}

function recordReaction({ guild_id, author_id, target_author_id, created_at }) {
  const d = getDb();
  upsertMember(guild_id, author_id, created_at);
  upsertMember(guild_id, target_author_id, created_at);
  d.prepare(
    `UPDATE members SET reactions_given = reactions_given + 1,
       last_seen = CASE WHEN last_seen IS NULL OR ? > last_seen THEN ? ELSE last_seen END
     WHERE guild_id = ? AND user_id = ?`
  ).run(created_at, created_at, guild_id, author_id);
  d.prepare('UPDATE members SET reactions_received = reactions_received + 1 WHERE guild_id = ? AND user_id = ?').run(
    guild_id,
    target_author_id
  );
}

function recordVoice({ guild_id, user_id, minutes, created_at }) {
  const d = getDb();
  upsertMember(guild_id, user_id, created_at);
  d.prepare(
    `UPDATE members SET voice_minutes = voice_minutes + ?,
       last_seen = CASE WHEN last_seen IS NULL OR ? > last_seen THEN ? ELSE last_seen END
     WHERE guild_id = ? AND user_id = ?`
  ).run(minutes, created_at, created_at, guild_id, user_id);
}

function getMembers(guildId) {
  return getDb().prepare('SELECT * FROM members WHERE guild_id = ? ORDER BY user_id').all(guildId);
}

function getChannels(guildId) {
  return getDb().prepare('SELECT * FROM channels WHERE guild_id = ? ORDER BY channel_id').all(guildId);
}

function toFtsQuery(query) {
  const tokens = String(query).match(/[\p{L}\p{N}]+/gu) || [];
  return tokens
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

function searchArchive(guildId, query, limit = 20, opts = {}) {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];
  const d = getDb();
  const guildFilter = guildId != null ? 'AND m.guild_id = ?' : '';
  const channelId = opts && typeof opts.channelId === 'string' && opts.channelId !== '' ? opts.channelId : undefined;
  const channelFilter = channelId != null ? 'AND m.channel_id = ?' : '';
  const params = [ftsQuery];
  if (guildId != null) params.push(guildId);
  if (channelId != null) params.push(channelId);
  params.push(limit);
  try {
    return d
      .prepare(
        `SELECT m.message_id, m.guild_id, m.channel_id, m.author_id, m.content, m.created_at, snippet(messages_fts, 0, CHAR(1), CHAR(2), CHAR(8230), 20) AS snippet_raw
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN channels c ON c.guild_id = m.guild_id AND c.channel_id = m.channel_id
         WHERE messages_fts MATCH ?
         ${guildFilter}
         ${channelFilter}
         AND c.kind IN ('help', 'forum')
         ORDER BY rank
         LIMIT ?`
      )
      .all(...params)
      .map((row) => ({
        message_id: row.message_id,
        guild_id: row.guild_id,
        channel_id: row.channel_id,
        author_id: row.author_id,
        content: row.content,
        created_at: row.created_at,
        snippet: String(row.snippet_raw ?? '').replaceAll(String.fromCharCode(1), '').replaceAll(String.fromCharCode(2), '').replace(/\s+/g, ' ').trim().slice(0, 160),
      }));
  } catch (_err) {
    return [];
  }
}

module.exports = {
  openDb,
  getDb,
  closeDb,
  resetDb,
  upsertMember,
  recordMessage,
  recordReaction,
  recordVoice,
  getMembers,
  getChannels,
  searchArchive,
};
