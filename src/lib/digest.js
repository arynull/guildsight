'use strict';

const scoring = require('./scoring');

function buildWeeklyDigest({ members, channels } = {}, now = new Date()) {
  const listMembers = Array.isArray(members) ? members.slice() : [];
  const listChannels = Array.isArray(channels) ? channels.slice() : [];
  const effectiveNow = now instanceof Date ? now : new Date(now);
  const lifecycle = scoring.lifecycleSummary(listMembers, effectiveNow);
  const scored = listMembers.map((m) => {
    return {
      user_id: m.user_id,
      score: scoring.engagementScore(m, effectiveNow)
    };
  });
  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const au = String(a.user_id);
    const bu = String(b.user_id);
    if (au < bu) {
      return -1;
    }
    if (au > bu) {
      return 1;
    }
    return 0;
  });
  const topMembers = scored.slice(0, 5).map((e) => {
    return {
      user_id: e.user_id,
      score: e.score
    };
  });
  const churnRisk = listMembers.filter((m) => scoring.isChurnRisk(m, effectiveNow)).map((m) => m.user_id);
  churnRisk.sort((a, b) => {
    const sa = String(a);
    const sb = String(b);
    if (sa < sb) {
      return -1;
    }
    if (sa > sb) {
      return 1;
    }
    return 0;
  });
  const newThisWeek = listMembers.filter((m) => scoring.lifecycleStage(m, effectiveNow) === 'new').map((m) => m.user_id);
  newThisWeek.sort((a, b) => {
    const sa = String(a);
    const sb = String(b);
    if (sa < sb) {
      return -1;
    }
    if (sa > sb) {
      return 1;
    }
    return 0;
  });
  const mapped = listChannels.map((ch) => {
    const c = ch || {};
    const h = scoring.channelHealth(c);
    return {
      channel_id: c.channel_id,
      kind: c.kind || 'text',
      trend: h.trend,
      trend_pct: Math.round(h.trendPct * 100) / 100,
      reply_ratio: h.replyRatio,
      unanswered_7d: h.unanswered
    };
  });
  mapped.sort((a, b) => {
    const sa = String(a.channel_id);
    const sb = String(b.channel_id);
    if (sa < sb) {
      return -1;
    }
    if (sa > sb) {
      return 1;
    }
    return 0;
  });
  const declining = mapped.filter((c) => c.trend === 'down').map((c) => c.channel_id);
  return {
    generated_at: effectiveNow.toISOString(),
    window_days: 7,
    lifecycle: lifecycle,
    top_members: topMembers,
    churn_risk: churnRisk,
    new_this_week: newThisWeek,
    channels: mapped,
    channels_declining: declining
  };
}

module.exports = {
  buildWeeklyDigest: buildWeeklyDigest
};
