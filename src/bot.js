'use strict';

/**
 * guildsight gateway bot — READ-ONLY.
 *
 * Handlers persist observed activity into SQLite and nothing else. There is no
 * send/reply/react/DM path anywhere in this file: the only outbound network
 * traffic guildsight ever makes is the Discord gateway connection opened by
 * discord.js when a token is supplied.
 *
 * The token is read exclusively from the GUILDSIGHT_BOT_TOKEN environment
 * variable; it is never accepted as an argument, never logged, never stored.
 */

const db = require('./lib/db');

const TOKEN_ENV = 'GUILDSIGHT_BOT_TOKEN';
const VOICE_FLUSH_INTERVAL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure event-mapping helpers. No discord.js import, no I/O — unit-tested in
// tests/bot.test.js against fake payloads, and exercised without a gateway.
// ---------------------------------------------------------------------------

// Discord ChannelType numeric values (stable across the v14 line):
//   GuildText 0, DM 1, GuildVoice 2, GroupDM 3, GuildCategory 4,
//   GuildAnnouncement 5, GuildAnnouncementThread 10, GuildPublicThread 11,
//   GuildPrivateThread 12, GuildStageVoice 13, GuildForum 15, GuildMedia 16.
const FORUM_CHANNEL_TYPES = new Set([10, 11, 12, 15, 16]);

const HELP_NAME_RE =
  /(^|[^a-z])(help|helpdesk|support|support-?desk|question|questions|how-?do-?i|troubleshoot)([^a-z]|$)/i;

/** Map a Discord channel type to 'forum' or 'text'. */
function channelKindFromType(type) {
  return FORUM_CHANNEL_TYPES.has(Number(type)) ? 'forum' : 'text';
}

/** Map a channel name to 'help' when it reads like a support channel, else null. */
function channelKindFromName(name) {
  if (!name) return null;
  return HELP_NAME_RE.test(String(name)) ? 'help' : null;
}

/**
 * Channel kind for a stored channel row: forum structure wins on type, a
 * help-sounding name promotes a plain text channel to 'help'.
 */
function channelKindForChannel(channel) {
  if (!channel) return 'text';
  if (channelKindFromType(channel.type) === 'forum') return 'forum';
  return channelKindFromName(channel.name) || 'text';
}

/** True when a message must not be persisted (bots, webhooks, DMs). */
function shouldSkipMessage(message) {
  if (!message) return true;
  if (message.webhookId) return true;
  const author = message.author;
  if (author && author.bot) return true;
  const guildId = message.guildId || (message.guild && message.guild.id);
  return !guildId;
}

/** Shape a discord.js Message into the recordMessage() payload (or null). */
function messageToRecord(message) {
  if (shouldSkipMessage(message)) return null;
  const guildId = message.guildId || (message.guild && message.guild.id);
  const channel = message.channel || {};
  return {
    guild_id: String(guildId),
    channel_id: String(channel.id || message.channelId || ''),
    channel_kind: channelKindForChannel({
      type: typeof channel.type === 'number' ? channel.type : channel.type,
      name: typeof channel.name === 'string' ? channel.name : undefined,
    }),
    message_id: String(message.id),
    author_id: String(message.authorId || (message.author && message.author.id) || ''),
    content: String(message.content || ''),
    created_at: message.createdAt
      ? new Date(message.createdAt).toISOString()
      : new Date().toISOString(),
  };
}

/**
 * Shape a messageReactionAdd reaction into the recordReaction() payload, or
 * null when it cannot be resolved without an outbound REST fetch (partials).
 */
function reactionToRecord(reaction, reactor, now = new Date()) {
  if (!reaction || !reactor) return null;
  const message = reaction.message;
  const guildId = reaction.guildId || (message && (message.guildId || (message.guild && message.guild.id)));
  if (!guildId) return null;
  const targetAuthorId = message && (message.authorId || (message.author && message.author.id));
  if (!targetAuthorId) return null;
  return {
    guild_id: String(guildId),
    channel_id: String((reaction.channelId || (message && message.channelId) || (message && message.channel && message.channel.id)) || ''),
    message_id: String((message && message.id) || reaction.messageId || ''),
    author_id: String(reactor.id || ''),
    target_author_id: String(targetAuthorId),
    created_at: now.toISOString(),
  };
}

/** Minutes between two epoch-ms timestamps, rounded to 2dp, never negative. */
function elapsedMinutes(startMs, endMs) {
  const ms = Number(endMs) - Number(startMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 60000) * 100) / 100;
}

function sessionKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/**
 * In-memory voice session tracker keyed by (guild, user).
 * `flush(minThreshold)` persists elapsed minutes and re-bases the clock so a
 * long stay is written out incrementally instead of only on departure.
 */
function createVoiceTracker({ persist, now = () => Date.now(), minMinutes = 0 } = {}) {
  const sessions = new Map();
  const write = persist || ((p) => db.recordVoice(p));

  return {
    size() {
      return sessions.size;
    },
    join(guildId, userId, channelId, at = now()) {
      sessions.set(sessionKey(guildId, userId), {
        guild_id: String(guildId),
        user_id: String(userId),
        channel_id: channelId == null ? null : String(channelId),
        joined_at: at,
      });
    },
    /** Persist elapsed time for every session above `minMinutes`. */
    flush(minThreshold = minMinutes, at = now()) {
      let written = 0;
      for (const s of sessions.values()) {
        const minutes = elapsedMinutes(s.joined_at, at);
        if (minutes < minThreshold) continue;
        write({
          guild_id: s.guild_id,
          user_id: s.user_id,
          minutes,
          created_at: new Date(at).toISOString(),
        });
        s.joined_at = at;
        written += 1;
      }
      return written;
    },
    /** Persist and drop a single session (used for leave / channel switch). */
    end(guildId, userId, at = now()) {
      const key = sessionKey(guildId, userId);
      const s = sessions.get(key);
      if (!s) return null;
      sessions.delete(key);
      const minutes = elapsedMinutes(s.joined_at, at);
      if (minutes > 0) {
        write({
          guild_id: s.guild_id,
          user_id: s.user_id,
          minutes,
          created_at: new Date(at).toISOString(),
        });
      }
      return { ...s, minutes };
    },
    clear() {
      sessions.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

function stamp() {
  return new Date().toISOString();
}

/**
 * Boot the read-only gateway client.
 * @throws if GUILDSIGHT_BOT_TOKEN is unset or blank.
 * @returns {import('discord.js').Client} the logging-in client.
 */
function startBot() {
  const token = process.env[TOKEN_ENV];
  if (!token || !String(token).trim()) {
    throw new Error(
      `${TOKEN_ENV} is not set. Export the Discord bot token in that environment variable ` +
        `before running "guildsight bot" (ingest/report/search/dashboard never need it).`
    );
  }

  // Required lazily so the CLI's non-bot commands stay fast and dependency-light.
  const { Client, GatewayIntentBits, Partials } = require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
    ],
    // Partials so reactions on uncached messages still arrive as events.
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  const tracker = createVoiceTracker({ persist: (p) => db.recordVoice(p) });
  const flushTimer = setInterval(() => {
    try {
      const n = tracker.flush(1);
      if (n) console.log(`[${stamp()}] voice: flushed ${n} in-progress session(s)`);
    } catch (err) {
      console.error(`[${stamp()}] voice flush failed: ${err.message}`);
    }
  }, VOICE_FLUSH_INTERVAL_MS);
  flushTimer.unref();

  client.on('ready', () => {
    console.log(`[${stamp()}] guildsight bot ready as ${client.user.tag} — read-only mode`);
    console.log(`[${stamp()}] watching ${client.guilds.cache.size} guild(s)`);
  });

  client.on('disconnect', () => console.log(`[${stamp()}] gateway disconnected`));
  client.on('reconnecting', () => console.log(`[${stamp()}] gateway reconnecting…`));
  client.on('resume', () => console.log(`[${stamp()}] gateway session resumed`));
  client.on('error', (err) => console.error(`[${stamp()}] client error: ${err.message}`));

  client.on('messageCreate', (message) => {
    const record = messageToRecord(message);
    if (!record) return;
    try {
      db.recordMessage(record);
    } catch (err) {
      console.error(`[${stamp()}] message ${record.message_id} not stored: ${err.message}`);
    }
  });

  client.on('messageReactionAdd', (reaction, reactor) => {
    // Partial reactions carry no message author until a REST fetch. guildsight
    // makes no outbound calls beyond the gateway, so unresolvable partials are
    // skipped rather than fetched.
    if (reaction.partial) {
      console.log(`[${stamp()}] reaction skipped: partial reaction on uncached message`);
      return;
    }
    if (reactor && reactor.partial) {
      console.log(`[${stamp()}] reaction skipped: partial reactor`);
      return;
    }
    const record = reactionToRecord(reaction, reactor);
    if (!record) {
      console.log(`[${stamp()}] reaction skipped: unresolvable payload`);
      return;
    }
    try {
      db.recordReaction(record);
    } catch (err) {
      console.error(`[${stamp()}] reaction on ${record.message_id} not stored: ${err.message}`);
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = newState.guild && newState.guild.id;
    const userId = newState.member && (newState.member.id || (newState.member.user && newState.member.user.id));
    if (!guildId || !userId) return;
    const nextChannel = newState.channelId;
    const prevChannel = oldState.channelId;
    try {
      if (nextChannel && nextChannel !== prevChannel) {
        // Channel switch: bank the elapsed time, keep tracking the new channel.
        if (prevChannel) tracker.end(guildId, userId);
        tracker.join(guildId, userId, nextChannel);
      } else if (!nextChannel && prevChannel) {
        tracker.end(guildId, userId);
      }
    } catch (err) {
      console.error(`[${stamp()}] voice update failed: ${err.message}`);
    }
  });

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[${stamp()}] ${signal} received, flushing voice time and disconnecting`);
    clearInterval(flushTimer);
    try {
      tracker.flush(0);
    } catch (err) {
      console.error(`[${stamp()}] final voice flush failed: ${err.message}`);
    }
    Promise.resolve(client.destroy())
      .catch((err) => console.error(`[${stamp()}] destroy failed: ${err.message}`))
      .finally(() => {
        try {
          db.closeDb();
        } catch (_err) {
          /* already closed */
        }
        process.exit(0);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  client.login(token).catch((err) => {
    console.error(`[${stamp()}] login failed: ${err.message}`);
    process.exitCode = 1;
  });

  return client;
}

module.exports = {
  TOKEN_ENV,
  VOICE_FLUSH_INTERVAL_MS,
  FORUM_CHANNEL_TYPES,
  HELP_NAME_RE,
  channelKindFromType,
  channelKindFromName,
  channelKindForChannel,
  shouldSkipMessage,
  messageToRecord,
  reactionToRecord,
  elapsedMinutes,
  sessionKey,
  createVoiceTracker,
  startBot,
};
