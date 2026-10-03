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

module.exports = {
  daysSince,
  engagementScore,
  isChurnRisk,
  channelHealth,
};
