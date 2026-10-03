'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(isoDate, now = new Date()) {
  if (!isoDate) return Infinity;
  return (new Date(now) - new Date(isoDate)) / DAY_MS;
}

function engagementScore(member, now = new Date()) {
  if (!member || !member.last_seen) return 0;
  const base =
    1.0 * (member.message_count || 0) +
    0.5 * (member.reactions_given || 0) +
    0.7 * (member.reactions_received || 0) +
    0.05 * (member.voice_minutes || 0);
  if (base <= 0) return 0;
  const decay = Math.pow(0.5, daysSince(member.last_seen, now) / 30);
  return base * decay;
}

function isChurnRisk(member, now = new Date()) {
  if (!member || !member.last_seen) return false;
  return daysSince(member.last_seen, now) > 14 && (member.message_count || 0) >= 20;
}

/**
 * Lifecycle stage for a single member, evaluated against `now`.
 *
 * The stages are mutually exclusive and checked most-severe first, so a member
 * who has gone quiet after a long active run reports `churned`/`dormant` rather
 * than the softer `at-risk`, and `new` never masks a member who is already
 * silent. `unknown` covers rows the collector has seen but never timestamped.
 *
 * @param {object} member
 * @param {Date} [now]
 * @returns {'new'|'active'|'at-risk'|'churned'|'dormant'|'unknown'}
 */
function lifecycleStage(member, now = new Date()) {
  if (!member || !member.last_seen) return 'unknown';
  const silent = daysSince(member.last_seen, now);
  const messages = member.message_count || 0;

  if (silent > 14 && messages >= 20) return 'churned';
  if (silent > 30) return 'dormant';
  if (silent > 7 && messages >= 20) return 'at-risk';
  if (member.first_seen && daysSince(member.first_seen, now) <= 7) return 'new';
  return 'active';
}

function channelHealth(ch) {
  const msg7d = ch.msg_7d || 0;
  const prev = ch.msg_prev_7d || 0;
  const trendPct = prev > 0 ? ((msg7d - prev) / prev) * 100 : msg7d > 0 ? 100 : 0;
  const trend = trendPct > 5 ? 'up' : trendPct < -5 ? 'down' : 'flat';
  return {
    trendPct,
    trend,
    replyRatio: ch.reply_ratio || 0,
    unanswered: ch.unanswered_7d || 0,
  };
}

/** Stage order used by every summary surface (least to most severe). */
const LIFECYCLE_STAGES = ['new', 'active', 'at-risk', 'churned', 'dormant', 'unknown'];

/**
 * Per-stage member counts, always keyed by every stage in `LIFECYCLE_STAGES` so
 * summaries have a stable shape (a stage with no members reports 0, not absent).
 * @param {object[]} members
 * @param {Date} [now]
 * @returns {Record<string, number>}
 */
function lifecycleSummary(members, now = new Date()) {
  const counts = Object.fromEntries(LIFECYCLE_STAGES.map((stage) => [stage, 0]));
  for (const m of members || []) {
    counts[lifecycleStage(m, now)] += 1;
  }
  return counts;
}

module.exports = {
  daysSince,
  engagementScore,
  isChurnRisk,
  lifecycleStage,
  lifecycleSummary,
  LIFECYCLE_STAGES,
  channelHealth,
};
