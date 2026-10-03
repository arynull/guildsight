# guildsight

Self-hosted Discord community intelligence: engagement analytics, churn signals,
and a searchable archive of community knowledge. A read-only bot collects
activity into a local SQLite database; a CLI and a local web dashboard turn it
into insight.

## Features

- **Engagement scoring** — per-member score from messages, reactions given /
  received, and voice minutes, with 30-day recency decay.
- **Churn / lifecycle signals** — members who went silent after being active.
- **Channel health** — 7-day activity trend vs the prior 7 days, reply ratios,
  and unanswered-question rates for help channels.
- **Knowledge archive** — help/forum channels archived and full-text searchable
  (SQLite FTS5).
- **Local dashboard** — Express app bound to `127.0.0.1`, with HTML pages and a
  JSON API. No accounts, no cloud.

## Requirements

- Node.js >= 22
- No Discord token is needed for the CLI or the dashboard — they work purely
  on local data (ingest a fixture and explore).

## Install

```bash
git clone https://github.com/arynull/guildsight.git
cd guildsight
npm ci
```

## Configuration

| Variable               | Default                     | Purpose                                      |
|------------------------|-----------------------------|----------------------------------------------|
| `GUILDSIGHT_DATA_DIR`  | `<repo>/data/guildsight.db` | Directory holding the SQLite database        |
| `GUILDSIGHT_BOT_TOKEN` | *(unset)*                   | Discord bot token — only needed for `bot`    |
| `PORT`                 | `3000`                      | Dashboard port (`--port` flag overrides)     |
| `HOST`                 | `127.0.0.1`                 | Dashboard bind address (`--host` overrides)   |

The bot token is read **only** from `GUILDSIGHT_BOT_TOKEN`; never put it in
code, docs, or the fixture files:

```bash
export GUILDSIGHT_BOT_TOKEN=your-bot-token-here
```

## Command reference

All examples below work without a Discord token, using the bundled demo
fixture (`fixtures/demo.jsonl`, guild id `demo`).

**Ingest an event log** (JSONL: `message`, `reaction`, `voice` events):

```bash
node bin/guildsight.js ingest --fixture fixtures/demo.jsonl
# ingest: 15 event(s) applied from fixtures/demo.jsonl
```

**Engagement report** — leaderboard, churn-risk list, channel health:

```bash
node bin/guildsight.js report --guild demo
# ENGAGEMENT
# 1. u_alice score=4.40
# ...
# CHURN RISK
# CHANNEL HEALTH
# general kind=text trend=up (100%) reply_ratio=0 unanswered_7d=0
```

**Search the archive** (help/forum channels only):

```bash
node bin/guildsight.js search "reset password"
# m004 | u_alice | 2026-09-11T10:04:00.000Z | sure, open settings and click reset password
# m009 | u_bob | 2026-09-14T08:30:00.000Z | help me reset my password on the staging box too
# m003 | u_carol | 2026-09-11T10:00:00.000Z | help me reset my password, I lost access to the account
```

**Serve the dashboard** (local only, `127.0.0.1`):

```bash
node bin/guildsight.js dashboard --port 3000
# guildsight dashboard listening on http://127.0.0.1:3000
```

**Run the read-only gateway collector** (needs `GUILDSIGHT_BOT_TOKEN`):

```bash
node bin/guildsight.js bot
```

The bot only persists activity — it never posts, reacts, or sends DMs.

**Version:**

```bash
node bin/guildsight.js --version
# 0.1.0
```

## Dashboard

| Page        | Description                                              |
|-------------|----------------------------------------------------------|
| `/`         | Overview: top members, churn-risk count, channel summary |
| `/members`  | Engagement leaderboard (score, activity, churn flag)     |
| `/channels` | Channel health (trend, reply ratio, unanswered)          |
| `/archive`  | Full-text search over help/forum history                 |

Append `?guild=<id>` to focus a specific server. JSON equivalents:

| Endpoint          | Description                                  |
|-------------------|----------------------------------------------|
| `GET /api/health` | `{"ok":true}` liveness check                 |
| `GET /api/overview` | Totals + top members + churn-risk members  |
| `GET /api/members`  | Full engagement leaderboard                |
| `GET /api/channels` | Channel health rows                        |
| `GET /api/search?q=<query>` | Archive search results             |

## Scoring

- **Engagement** = `1.0·messages + 0.5·reactions_given + 0.7·reactions_received + 0.05·voice_minutes`,
  multiplied by `0.5^(days_since_last_seen / 30)` (30-day half-life).
- **Churn risk** = `last_seen` more than 14 days ago **and** `message_count >= 20`
  (was active, now silent).
- **Channel health** = message count this 7 days vs the prior 7 days
  (`up` / `down` / `flat`); help channels additionally report the share of
  questions with no reply within 48 hours.

## Data model (SQLite)

```sql
members(guild_id, user_id, first_seen, last_seen,
        message_count, reactions_given, reactions_received, voice_minutes)
channels(guild_id, channel_id, kind,
         msg_7d, msg_prev_7d, reply_ratio, unanswered_7d)
messages(message_id, guild_id, channel_id, author_id, content, created_at)
-- plus messages_fts, an FTS5 index over message content
```

## Privacy

- Self-hosted: every byte stays on the operator's machine.
- The bot is read-only by default — no posting, reacting, or DMs.
- Retention is yours to control: deleting the data directory wipes everything.

## License

MIT
