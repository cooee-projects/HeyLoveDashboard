// api/social-report.js — monthly organic social reporting (Reporting → Social).
//   GET  ?month=YYYY-MM          → live Facebook + Instagram numbers from Meta for that month
//                                   (each metric fetched on its own, so one unsupported
//                                   metric never blanks the rest; failures listed in `errors`).
// Env: META_TOKEN (system user token), META_PAGE_ID (optional — resolved from the token).
const V = 'v23.0';

async function g(path, params = {}, token = process.env.META_TOKEN) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`https://graph.facebook.com/${V}/${path}?${qs}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1)); // first day of next month
  const now = new Date();
  const until = end > now ? now : end;
  return { start, until, iso: (d) => d.toISOString().slice(0, 10) };
}
const unix = (d) => Math.floor(d.getTime() / 1000);

// Meta caps insights ranges (~30 days for IG), so split the month in two.
function halves(start, until) {
  const mid = new Date(start.getTime() + Math.floor((until - start) / 2 / 864e5) * 864e5);
  return mid > start && mid < until ? [[start, mid], [mid, until]] : [[start, until]];
}

async function pageContext(errors) {
  let pageId = process.env.META_PAGE_ID;
  if (!pageId) {
    const pages = await g('me/accounts', { fields: 'id,name' });
    pageId = (pages.data || [])[0]?.id;
  }
  if (!pageId) throw new Error('No Facebook Page found for META_TOKEN');
  // Page insights need a Page access token; a system user token can request one.
  let pageToken = null;
  try {
    pageToken = (await g(pageId, { fields: 'access_token' })).access_token || null;
  } catch (e) {
    errors.push('page token: ' + e.message);
  }
  if (!pageToken) {
    try {
      const pages = await g('me/accounts', { fields: 'id,access_token' });
      pageToken = (pages.data || []).find((p) => p.id === pageId)?.access_token || null;
    } catch (e) {
      errors.push('page token (me/accounts): ' + e.message);
    }
  }
  const info = await g(pageId, { fields: 'name,followers_count,fan_count,instagram_business_account{id,username,followers_count,media_count}' }, pageToken || undefined);
  return { pageId, pageToken, info };
}

async function facebook(ctx, month, errors) {
  const { start, until, iso } = monthRange(month);
  const tok = ctx.pageToken || process.env.META_TOKEN;
  const out = { followers: ctx.info.followers_count ?? ctx.info.fan_count ?? null, metrics: {}, topPosts: [] };
  const dayMetrics = ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements',
    'page_daily_follows_unique', 'page_daily_unfollows_unique', 'page_views_total'];
  await Promise.all(dayMetrics.map(async (metric) => {
    try {
      const r = await g(`${ctx.pageId}/insights`, { metric, period: 'day', since: iso(start), until: iso(until) }, tok);
      const vals = r.data?.[0]?.values || [];
      out.metrics[metric] = vals.reduce((s, v) => s + (Number(v.value) || 0), 0);
    } catch (e) { errors.push(`facebook ${metric}: ${e.message}`); }
  }));
  try {
    const posts = await g(`${ctx.pageId}/published_posts`, {
      since: unix(start), until: unix(until), limit: 100,
      fields: 'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)',
    }, tok);
    const list = (posts.data || []).map((p) => {
      const reactions = p.reactions?.summary?.total_count || 0;
      const comments = p.comments?.summary?.total_count || 0;
      const shares = p.shares?.count || 0;
      return { id: p.id, caption: (p.message || '').slice(0, 140), date: p.created_time, url: p.permalink_url,
        image: p.full_picture || null, reactions, comments, shares, engagement: reactions + comments + shares };
    });
    out.metrics.posts = list.length;
    out.metrics.reactions = list.reduce((s, p) => s + p.reactions, 0);
    out.metrics.comments = list.reduce((s, p) => s + p.comments, 0);
    out.metrics.shares = list.reduce((s, p) => s + p.shares, 0);
    out.topPosts = list.sort((a, b) => b.engagement - a.engagement).slice(0, 3);
  } catch (e) { errors.push('facebook posts: ' + e.message); }
  return out;
}

async function instagram(ctx, month, errors) {
  const ig = ctx.info.instagram_business_account;
  if (!ig) { errors.push('instagram: no Instagram business account linked to the Facebook Page'); return null; }
  const { start, until } = monthRange(month);
  const tok = ctx.pageToken || process.env.META_TOKEN;
  const out = { username: ig.username, followers: ig.followers_count ?? null, metrics: {}, topPosts: [] };
  const totals = ['reach', 'views', 'total_interactions', 'accounts_engaged', 'likes', 'comments',
    'shares', 'saves', 'profile_views', 'website_clicks'];
  const ranges = halves(start, until);
  await Promise.all(totals.map(async (metric) => {
    try {
      let sum = 0;
      for (const [a, b] of ranges) {
        const r = await g(`${ig.id}/insights`, { metric, period: 'day', metric_type: 'total_value', since: unix(a), until: unix(b) }, tok);
        sum += Number(r.data?.[0]?.total_value?.value) || 0;
      }
      out.metrics[metric] = sum;
    } catch (e) { errors.push(`instagram ${metric}: ${e.message}`); }
  }));
  try {
    let follows = 0, unfollows = 0;
    for (const [a, b] of ranges) {
      const r = await g(`${ig.id}/insights`, { metric: 'follows_and_unfollows', period: 'day', metric_type: 'total_value',
        breakdown: 'follow_type', since: unix(a), until: unix(b) }, tok);
      for (const res of r.data?.[0]?.total_value?.breakdowns?.[0]?.results || []) {
        if (res.dimension_values?.[0] === 'FOLLOWER') follows += Number(res.value) || 0;
        if (res.dimension_values?.[0] === 'NON_FOLLOWER') unfollows += Number(res.value) || 0;
      }
    }
    out.metrics.new_follows = follows;
    out.metrics.unfollows = unfollows;
  } catch (e) { errors.push('instagram follows_and_unfollows: ' + e.message); }
  try {
    const media = await g(`${ig.id}/media`, { limit: 60,
      fields: 'id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count' }, tok);
    const inMonth = (media.data || []).filter((m) => { const t = new Date(m.timestamp); return t >= start && t < until; });
    out.metrics.posts = inMonth.length;
    out.topPosts = inMonth
      .map((m) => ({ id: m.id, caption: (m.caption || '').slice(0, 140), date: m.timestamp, url: m.permalink,
        image: m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url, type: m.media_product_type || m.media_type,
        likes: m.like_count || 0, comments: m.comments_count || 0, engagement: (m.like_count || 0) + (m.comments_count || 0) }))
      .sort((a, b) => b.engagement - a.engagement).slice(0, 3);
  } catch (e) { errors.push('instagram media: ' + e.message); }
  return out;
}

module.exports = async (req, res) => {
  if (!process.env.META_TOKEN) return res.status(200).json({ configured: false });
  const month = /^\d{4}-\d{2}$/.test(req.query?.month || '') ? req.query.month
    : new Date().toISOString().slice(0, 7);
  const errors = [];
  const out = { configured: true, month, errors };
  try {
    const ctx = await pageContext(errors);
    out.pageTokenOk = !!ctx.pageToken;
    const [fb, ig] = await Promise.all([facebook(ctx, month, errors), instagram(ctx, month, errors)]);
    out.facebook = fb;
    out.instagram = ig;
  } catch (e) {
    errors.push('meta: ' + e.message);
  }
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.status(200).json(out);
};
