// lib/paid-history.js — month-by-month Meta Ads history for the Paid Media tab.
// Served by api/meta-stats.js as GET /api/meta-stats?view=history&months=13 (kept out of /api
// because the Vercel plan allows at most 12 functions).
//   returns account + campaign monthly rows, last-12-weeks weekly rows,
//                      ad-level rows (last 3 months), age/gender + placement breakdowns (last 90 days).
// Purchases/revenue are split into 7-day-click vs 1-day-view so view-through credit can be judged.
// Each section fails on its own; problems are listed in `errors`.
// Env: META_TOKEN, META_AD_ACCOUNT.
const V = 'v23.0';
const W = ['7d_click', '1d_view'];
const PURCHASE = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const ATC = ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart'];
const CHECKOUT = ['omni_initiated_checkout', 'initiate_checkout', 'offsite_conversion.fb_pixel_initiate_checkout'];
const VIEW_CONTENT = ['omni_view_content', 'view_content', 'offsite_conversion.fb_pixel_view_content'];
const LPV = ['landing_page_view'];
const BASE_FIELDS = 'spend,impressions,reach,frequency,inline_link_clicks,inline_link_click_ctr,cpm,cost_per_inline_link_click,actions,action_values';

function accountId() {
  const raw = (process.env.META_AD_ACCOUNT || '').trim();
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

async function fb(path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${V}/${path}`);
  url.searchParams.set('access_token', process.env.META_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  let out = [];
  let next = url.toString();
  for (let page = 0; next && page < 20; page++) {
    const r = await fetch(next);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    if (!Array.isArray(j.data)) return j; // non-list endpoint
    out = out.concat(j.data);
    next = j.paging?.next || null;
  }
  return out;
}

// Pull one action type's totals, split by attribution window.
function pick(list, types) {
  // first match in priority order (omni_* already includes the pixel count, so never add them up)
  const hit = types.map((t) => (list || []).find((a) => a.action_type === t)).find(Boolean);
  if (!hit) return { total: 0, click: 0, view: 0 };
  const click = Number(hit['7d_click']) || 0;
  const view = Number(hit['1d_view']) || 0;
  const total = Number(hit.value) || click + view;
  return { total, click, view };
}

function shape(row) {
  const spend = Number(row.spend) || 0;
  const purchases = pick(row.actions, PURCHASE);
  const revenue = pick(row.action_values, PURCHASE);
  const linkClicks = Number(row.inline_link_clicks) || 0;
  return {
    start: row.date_start, end: row.date_stop,
    spend, impressions: Number(row.impressions) || 0, reach: Number(row.reach) || 0,
    frequency: Number(row.frequency) || 0, linkClicks,
    ctr: Number(row.inline_link_click_ctr) || 0, cpm: Number(row.cpm) || 0,
    cpc: Number(row.cost_per_inline_link_click) || 0,
    landingPageViews: pick(row.actions, LPV).total,
    viewContent: pick(row.actions, VIEW_CONTENT).total,
    addToCart: pick(row.actions, ATC).total,
    checkouts: pick(row.actions, CHECKOUT).total,
    purchases: purchases.total, purchasesClick: purchases.click, purchasesView: purchases.view,
    revenue: revenue.total, revenueClick: revenue.click, revenueView: revenue.view,
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const insights = (params) => fb(`${accountId()}/insights`, { action_attribution_windows: W, limit: 500, ...params });

module.exports = async (req, res) => {
  if (!process.env.META_TOKEN || !process.env.META_AD_ACCOUNT) {
    return res.status(200).json({ configured: false });
  }
  const months = Math.min(Math.max(parseInt(req.query?.months, 10) || 13, 2), 37);
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const range = { since: iso(since), until: iso(now) };
  const last90 = { since: iso(new Date(now - 89 * 864e5)), until: iso(now) };
  const threeMonths = { since: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))), until: iso(now) };
  const twelveWeeks = { since: iso(new Date(now - 83 * 864e5)), until: iso(now) };
  const errors = [];
  const out = { configured: true, refreshedAt: now.toISOString(), range, errors };

  const sections = {
    account: async () => {
      const a = await fb(accountId(), { fields: 'name,currency,timezone_name,account_status' });
      return { name: a.name, currency: a.currency, timezone: a.timezone_name };
    },
    months: async () => (await insights({ level: 'account', time_increment: 'monthly', time_range: range, fields: BASE_FIELDS }))
      .map((r) => ({ month: r.date_start.slice(0, 7), ...shape(r) })),
    weeks: async () => (await insights({ level: 'account', time_increment: 7, time_range: twelveWeeks, fields: BASE_FIELDS }))
      .map(shape),
    campaigns: async () => {
      const [meta, rows] = await Promise.all([
        fb(`${accountId()}/campaigns`, { fields: 'name,objective,effective_status,daily_budget,lifetime_budget,start_time,stop_time,bid_strategy', limit: 200 }),
        insights({ level: 'campaign', time_increment: 'monthly', time_range: range, fields: `campaign_id,campaign_name,objective,${BASE_FIELDS}` }),
      ]);
      const byId = {};
      for (const c of meta) {
        byId[c.id] = { id: c.id, name: c.name, objective: c.objective, status: c.effective_status,
          dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
          lifetimeBudget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
          start: c.start_time || null, stop: c.stop_time || null, bidStrategy: c.bid_strategy || null, months: [] };
      }
      for (const r of rows) {
        const c = byId[r.campaign_id] || (byId[r.campaign_id] = { id: r.campaign_id, name: r.campaign_name, objective: r.objective, status: 'UNKNOWN', months: [] });
        c.months.push({ month: r.date_start.slice(0, 7), ...shape(r) });
      }
      return Object.values(byId).filter((c) => c.months.length);
    },
    ads: async () => (await insights({ level: 'ad', time_increment: 'monthly', time_range: threeMonths,
      fields: `ad_id,ad_name,adset_name,campaign_name,${BASE_FIELDS}` }))
      .map((r) => ({ month: r.date_start.slice(0, 7), ad: r.ad_name, adset: r.adset_name, campaign: r.campaign_name, ...shape(r) })),
    ageGender: async () => (await insights({ level: 'account', time_range: last90, breakdowns: 'age,gender', fields: BASE_FIELDS }))
      .map((r) => ({ age: r.age, gender: r.gender, ...shape(r) })),
    placements: async () => (await insights({ level: 'account', time_range: last90, breakdowns: 'publisher_platform,platform_position', fields: BASE_FIELDS }))
      .map((r) => ({ platform: r.publisher_platform, position: r.platform_position, ...shape(r) })),
  };

  await Promise.all(Object.entries(sections).map(async ([key, fn]) => {
    try { out[key] = await fn(); } catch (e) { errors.push(`${key}: ${e.message}`); }
  }));

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
  return res.status(200).json(out);
};
