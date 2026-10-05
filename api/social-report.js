// api/social-report.js — monthly organic social reporting (Reporting → Social).
//   GET  ?month=YYYY-MM[&live=0]  → { saved: {month, prev}, live: {facebook, instagram} }
//        saved = rows from the "Hey Love — Social Monthly Reports" Notion db (the permanent record)
//        live  = this month's numbers straight from Meta (each metric fetched on its own,
//                so one unsupported metric never blanks the rest; failures listed in `errors`)
//   POST {passcode, month, platform, numbers?, worked?, next?, topPosts?} → upsert that month+platform row
// Env: META_TOKEN (system user token), META_PAGE_ID (optional), NOTION_TOKEN, DASHBOARD_PASSCODE.
const V = 'v23.0';
const DB_ID = '8c3ea848bfcf492490fbb3bf08f5a489'; // Hey Love — Social Monthly Reports
const NOTION = () => process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_TASKS;
const PLATFORMS = ['Facebook', 'Instagram', 'TikTok'];

// dashboard key -> Notion column
const COLUMNS = {
  followers: 'Followers', newFollowers: 'New Followers', reach: 'Reach', views: 'Views',
  engagements: 'Engagements', likes: 'Likes', comments: 'Comments', shares: 'Shares', saves: 'Saves',
  posts: 'Posts', profileViews: 'Profile Views', linkClicks: 'Link Clicks',
};

/* ---------------- Meta ---------------- */
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
  return { start, until: end > now ? now : end, iso: (d) => d.toISOString().slice(0, 10) };
}
const unix = (d) => Math.floor(d.getTime() / 1000);

// Instagram caps insights ranges at 30 days; 31-day months are fetched in two halves.
function igRanges(start, until) {
  if (until - start <= 30 * 864e5) return [[start, until]];
  const mid = new Date(start.getTime() + 15 * 864e5);
  return [[start, mid], [mid, until]];
}

async function pageContext(errors) {
  let pageId = process.env.META_PAGE_ID;
  if (!pageId) {
    const pages = await g('me/accounts', { fields: 'id,name' });
    pageId = (pages.data || [])[0]?.id;
  }
  if (!pageId) throw new Error('No Facebook Page found for META_TOKEN');
  // Page insights need a Page access token; the system user token can request one.
  let pageToken = null;
  try { pageToken = (await g(pageId, { fields: 'access_token' })).access_token || null; }
  catch (e) { errors.push('page token: ' + e.message); }
  const info = await g(pageId, {
    fields: 'name,followers_count,fan_count,instagram_business_account{id,username,followers_count,media_count}',
  }, pageToken || undefined);
  return { pageId, pageToken, info };
}

async function facebook(ctx, month, errors) {
  const { start, until, iso } = monthRange(month);
  const tok = ctx.pageToken || process.env.META_TOKEN;
  const m = {};
  const metrics = ['page_media_view', 'page_total_media_view_unique', 'page_post_engagements',
    'page_daily_follows_unique', 'page_views_total'];
  await Promise.all(metrics.map(async (metric) => {
    try {
      const r = await g(`${ctx.pageId}/insights`, { metric, period: 'day', since: iso(start), until: iso(until) }, tok);
      m[metric] = (r.data?.[0]?.values || []).reduce((s, v) => s + (Number(v.value) || 0), 0);
    } catch (e) { errors.push(`facebook ${metric}: ${e.message}`); }
  }));
  const numbers = {
    followers: ctx.info.followers_count ?? ctx.info.fan_count ?? null,
    newFollowers: m.page_daily_follows_unique ?? null,
    reach: m.page_total_media_view_unique ?? null,
    views: m.page_media_view ?? null,
    engagements: m.page_post_engagements ?? null,
    profileViews: m.page_views_total ?? null,
  };
  let topPosts = [];
  // Post lists need an extra permission on some setups — try both endpoints.
  for (const edge of ['published_posts', 'posts']) {
    try {
      const posts = await g(`${ctx.pageId}/${edge}`, {
        since: unix(start), until: unix(until), limit: 100,
        fields: 'id,message,created_time,permalink_url,full_picture,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)',
      }, tok);
      const list = (posts.data || []).map((p) => {
        const likes = p.reactions?.summary?.total_count || 0;
        const comments = p.comments?.summary?.total_count || 0;
        const shares = p.shares?.count || 0;
        return { caption: (p.message || '').slice(0, 140), date: p.created_time, url: p.permalink_url,
          image: p.full_picture || null, likes, comments, shares, engagement: likes + comments + shares };
      });
      Object.assign(numbers, {
        posts: list.length,
        likes: list.reduce((s, p) => s + p.likes, 0),
        comments: list.reduce((s, p) => s + p.comments, 0),
        shares: list.reduce((s, p) => s + p.shares, 0),
      });
      topPosts = list.sort((a, b) => b.engagement - a.engagement).slice(0, 3);
      break;
    } catch (e) { errors.push(`facebook ${edge}: ${e.message}`); }
  }
  return { handle: ctx.info.name, numbers, topPosts };
}

async function instagram(ctx, month, errors) {
  const ig = ctx.info.instagram_business_account;
  if (!ig) { errors.push('instagram: no Instagram business account linked to the Facebook Page'); return null; }
  const { start, until } = monthRange(month);
  const tok = ctx.pageToken || process.env.META_TOKEN;
  const ranges = igRanges(start, until);
  const m = {};
  const totals = ['reach', 'views', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'profile_views', 'website_clicks'];
  await Promise.all(totals.map(async (metric) => {
    try {
      let sum = 0;
      for (const [a, b] of ranges) {
        const r = await g(`${ig.id}/insights`, { metric, period: 'day', metric_type: 'total_value', since: unix(a), until: unix(b) }, tok);
        sum += Number(r.data?.[0]?.total_value?.value) || 0;
      }
      m[metric] = sum;
    } catch (e) { errors.push(`instagram ${metric}: ${e.message}`); }
  }));
  try {
    let follows = 0;
    for (const [a, b] of ranges) {
      const r = await g(`${ig.id}/insights`, { metric: 'follows_and_unfollows', period: 'day', metric_type: 'total_value',
        breakdown: 'follow_type', since: unix(a), until: unix(b) }, tok);
      for (const res of r.data?.[0]?.total_value?.breakdowns?.[0]?.results || []) {
        if (res.dimension_values?.[0] === 'FOLLOWER') follows += Number(res.value) || 0;
      }
    }
    m.new_follows = follows;
  } catch (e) { errors.push('instagram follows: ' + e.message); }

  const numbers = {
    followers: ig.followers_count ?? null, newFollowers: m.new_follows ?? null, reach: m.reach ?? null,
    views: m.views ?? null, engagements: m.total_interactions ?? null, likes: m.likes ?? null,
    comments: m.comments ?? null, shares: m.shares ?? null, saves: m.saves ?? null,
    profileViews: m.profile_views ?? null, linkClicks: m.website_clicks ?? null,
  };
  let topPosts = [];
  try {
    const media = await g(`${ig.id}/media`, { limit: 80,
      fields: 'caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count' }, tok);
    const inMonth = (media.data || []).filter((x) => { const t = new Date(x.timestamp); return t >= start && t < until; });
    numbers.posts = inMonth.length;
    topPosts = inMonth
      .map((x) => ({ caption: (x.caption || '').slice(0, 140), date: x.timestamp, url: x.permalink,
        image: x.media_type === 'VIDEO' ? x.thumbnail_url : x.media_url, type: x.media_product_type || x.media_type,
        likes: x.like_count || 0, comments: x.comments_count || 0, engagement: (x.like_count || 0) + (x.comments_count || 0) }))
      .sort((a, b) => b.engagement - a.engagement).slice(0, 3);
  } catch (e) { errors.push('instagram media: ' + e.message); }
  return { handle: '@' + ig.username, numbers, topPosts };
}

/* ---------------- Notion (the permanent record) ---------------- */
async function notion(path, options = {}) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${NOTION()}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  if (!r.ok) { const err = new Error(`Notion ${r.status}: ${j.message || 'error'}`); err.status = r.status; throw err; }
  return j;
}
const text = (rt) => (rt || []).map((t) => t.plain_text).join('');
const richText = (s) => ((s || '').match(/[\s\S]{1,2000}/g) || ['']).slice(0, 100).map((c) => ({ text: { content: c } }));

function rowFromPage(pg) {
  const p = pg.properties || {};
  const numbers = {};
  for (const [key, col] of Object.entries(COLUMNS)) numbers[key] = p[col]?.number ?? null;
  let topPosts = [];
  try { topPosts = JSON.parse(text(p['Top Posts']?.rich_text) || '[]'); } catch {}
  return {
    id: pg.id, month: text(p.Month?.rich_text), platform: p.Platform?.select?.name || '',
    numbers, numbersSaved: p['Numbers Saved']?.date?.start || null,
    worked: text(p['What Worked']?.rich_text), next: text(p["What's Next"]?.rich_text), topPosts,
  };
}

async function savedRows(months) {
  const r = await notion(`/databases/${DB_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({ page_size: 100, filter: { or: months.map((mo) => ({ property: 'Month', rich_text: { equals: mo } })) } }),
  });
  return (r.results || []).map(rowFromPage);
}

function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const month = /^\d{4}-\d{2}$/.test(req.query?.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const prev = prevMonth(month);
    const errors = [];
    const out = { month, prev, errors, saved: { month: {}, prev: {} }, live: null };

    const tasks = [];
    if (NOTION()) {
      tasks.push(savedRows([month, prev]).then((rows) => {
        for (const row of rows) out.saved[row.month === month ? 'month' : 'prev'][row.platform] = row;
      }).catch((e) => errors.push('saved reports: ' + e.message)));
    }
    if (process.env.META_TOKEN && req.query?.live !== '0') {
      tasks.push((async () => {
        try {
          const ctx = await pageContext(errors);
          const [fb, ig] = await Promise.all([facebook(ctx, month, errors), instagram(ctx, month, errors)]);
          out.live = { Facebook: fb, Instagram: ig };
        } catch (e) { errors.push('meta: ' + e.message); }
      })());
    }
    await Promise.all(tasks);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(out);
  }

  if (req.method === 'POST') {
    const { passcode, month, platform, numbers, worked, next, topPosts } = req.body || {};
    if (!process.env.DASHBOARD_PASSCODE || passcode !== process.env.DASHBOARD_PASSCODE) {
      return res.status(401).json({ error: 'Wrong passcode' });
    }
    if (!/^\d{4}-\d{2}$/.test(month || '') || !PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Missing month (YYYY-MM) or platform' });
    }
    try {
      const properties = {};
      if (numbers && typeof numbers === 'object') {
        for (const [key, col] of Object.entries(COLUMNS)) {
          if (key in numbers) properties[col] = { number: numbers[key] === null || numbers[key] === '' ? null : Number(numbers[key]) };
        }
        properties['Numbers Saved'] = { date: { start: new Date().toISOString().slice(0, 10) } };
      }
      if (typeof worked === 'string') properties['What Worked'] = { rich_text: richText(worked) };
      if (typeof next === 'string') properties["What's Next"] = { rich_text: richText(next) };
      if (Array.isArray(topPosts)) properties['Top Posts'] = { rich_text: richText(JSON.stringify(topPosts.slice(0, 5))) };

      const existing = await notion(`/databases/${DB_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({ page_size: 1, filter: { and: [
          { property: 'Month', rich_text: { equals: month } },
          { property: 'Platform', select: { equals: platform } },
        ] } }),
      });
      let page;
      if (existing.results?.length) {
        page = await notion(`/pages/${existing.results[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
      } else {
        page = await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({ parent: { database_id: DB_ID }, properties: {
            Report: { title: [{ text: { content: `${month} · ${platform}` } }] },
            Month: { rich_text: [{ text: { content: month } }] },
            Platform: { select: { name: platform } },
            ...properties,
          } }),
        });
      }
      return res.status(200).json({ ok: true, row: rowFromPage(page) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
