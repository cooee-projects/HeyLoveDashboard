// api/meta-stats.js — pulls live stats from the Meta Marketing API for the Paid Media tab.
//
// IMPORTANT: this file could not be tested against the real ad account from the
// environment that wrote it (no access to META_TOKEN's value, no network path to
// graph.facebook.com). It's written carefully against Meta's documented API shape,
// but expect to need a debugging pass once it's actually deployed. Each section
// below fails independently so one bad field name doesn't take out the whole tab —
// if something shows "unavailable", check the Vercel function logs for that
// section's real error message first.

const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

function accountId() {
  const raw = (process.env.META_AD_ACCOUNT || '').trim();
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

async function fb(path, params = {}) {
  const url = new URL(`${GRAPH}${path}`);
  url.searchParams.set('access_token', process.env.META_TOKEN);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v)));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.error?.message || `Meta API error (${res.status})`);
  }
  return data;
}

function pickAction(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const found = actions.find((a) => a.action_type === t);
    if (found) return Number(found.value) || 0;
  }
  return 0;
}
function pickRoas(purchaseRoas) {
  if (!Array.isArray(purchaseRoas) || !purchaseRoas.length) return null;
  return Number(purchaseRoas[0].value) || null;
}
function isoDate(d) { return d.toISOString().slice(0, 10); }
function startOfWeek(d) { const x = new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate() - x.getDay()); return x; }

async function getMonthToDate() {
  const now = new Date();
  const since = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const until = isoDate(now);
  const data = await fb(`/${accountId()}/insights`, {
    level: 'account',
    time_range: { since, until },
    fields: 'spend,actions,action_values,purchase_roas',
  });
  const row = data.data?.[0] || {};
  const spend = Number(row.spend) || 0;
  const revenue = pickAction(row.action_values, ['omni_purchase', 'purchase']);
  const purchases = pickAction(row.actions, ['omni_purchase', 'purchase']);
  const roas = pickRoas(row.purchase_roas) ?? (spend ? revenue / spend : 0);
  return { spend, revenue, roas, purchases, range: { since, until } };
}

async function getWeekComparison() {
  const now = new Date();
  const thisStart = startOfWeek(now);
  const lastStart = new Date(thisStart); lastStart.setDate(lastStart.getDate() - 7);
  const lastEnd = new Date(thisStart); lastEnd.setDate(lastEnd.getDate() - 1);

  const [thisWeek, lastWeek] = await Promise.all([
    fb(`/${accountId()}/insights`, {
      level: 'account',
      time_range: { since: isoDate(thisStart), until: isoDate(now) },
      fields: 'spend,actions,action_values,purchase_roas',
    }),
    fb(`/${accountId()}/insights`, {
      level: 'account',
      time_range: { since: isoDate(lastStart), until: isoDate(lastEnd) },
      fields: 'spend,actions,action_values,purchase_roas',
    }),
  ]);
  const shape = (res) => {
    const row = res.data?.[0] || {};
    const spend = Number(row.spend) || 0;
    const revenue = pickAction(row.action_values, ['omni_purchase', 'purchase']);
    const purchases = pickAction(row.actions, ['omni_purchase', 'purchase']);
    const roas = pickRoas(row.purchase_roas) ?? (spend ? revenue / spend : 0);
    return { spend, revenue, roas, purchases };
  };
  return { thisWeek: shape(thisWeek), lastWeek: shape(lastWeek) };
}

async function getDailyBudget() {
  const campaigns = await fb(`/${accountId()}/campaigns`, {
    fields: 'daily_budget,effective_status',
    limit: '200',
  });
  const active = (campaigns.data || []).filter((c) => c.effective_status === 'ACTIVE');
  const budget = active.reduce((sum, c) => sum + (Number(c.daily_budget) || 0), 0) / 100; // Meta returns cents
  const today = await fb(`/${accountId()}/insights`, {
    level: 'account',
    date_preset: 'today',
    fields: 'spend',
  });
  const spentToday = Number(today.data?.[0]?.spend) || 0;
  return { budget, spentToday, remaining: Math.max(budget - spentToday, 0) };
}

async function getCampaigns() {
  const [meta, insights] = await Promise.all([
    fb(`/${accountId()}/campaigns`, { fields: 'name,effective_status', limit: '50' }),
    fb(`/${accountId()}/insights`, {
      level: 'campaign',
      date_preset: 'this_month',
      fields: 'campaign_id,campaign_name,spend,purchase_roas,actions',
      limit: '50',
    }),
  ]);
  const statusById = Object.fromEntries((meta.data || []).map((c) => [c.id, c.effective_status]));
  return (insights.data || []).map((row) => ({
    name: row.campaign_name,
    status: statusById[row.campaign_id] || 'UNKNOWN',
    spend: Number(row.spend) || 0,
    roas: pickRoas(row.purchase_roas) ?? 0,
    purchases: pickAction(row.actions, ['omni_purchase', 'purchase']),
  }));
}

async function getTopCreatives() {
  const insights = await fb(`/${accountId()}/insights`, {
    level: 'ad',
    date_preset: 'this_month',
    fields: 'ad_id,ad_name,spend,purchase_roas,actions',
    limit: '50',
  });
  const rows = (insights.data || [])
    .map((row) => ({
      id: row.ad_id,
      name: row.ad_name,
      spend: Number(row.spend) || 0,
      roas: pickRoas(row.purchase_roas) ?? 0,
      purchases: pickAction(row.actions, ['omni_purchase', 'purchase']),
    }))
    .sort((a, b) => b.roas - a.roas)
    .slice(0, 5);
  return rows;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.META_TOKEN || !process.env.META_AD_ACCOUNT) {
    return res.status(500).json({ error: 'META_TOKEN / META_AD_ACCOUNT not set' });
  }

  const out = { dataSource: 'Meta Ads Manager', refreshedAt: new Date().toISOString() };

  const sections = {
    monthToDate: getMonthToDate,
    weekComparison: getWeekComparison,
    dailyBudget: getDailyBudget,
    campaigns: getCampaigns,
    topCreatives: getTopCreatives,
  };
  await Promise.all(
    Object.entries(sections).map(async ([key, fn]) => {
      try {
        out[key] = await fn();
      } catch (e) {
        out[key] = { error: e.message };
      }
    })
  );

  return res.status(200).json(out);
};
