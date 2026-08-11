// Vercel serverless function: pulls live Meta stats.
// Env vars: META_TOKEN (system user token), META_AD_ACCOUNT (e.g. act_123...),
// META_PAGE_ID (optional — auto-resolved from the token if missing).
// Any metric that can't be fetched returns null; the dashboard falls back to
// the "Meta Stats — Monthly" Notion database for those fields.

const V = "v21.0";

async function g(path, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: process.env.META_TOKEN });
  const r = await fetch(`https://graph.facebook.com/${V}/${path}?${qs}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

const findAction = (list, types) => {
  for (const t of types) {
    const hit = (list || []).find((a) => a.action_type === t);
    if (hit) return Number(hit.value);
  }
  return null;
};

module.exports = async (req, res) => {
  if (!process.env.META_TOKEN) {
    return res.status(200).json({ configured: false });
  }
  const out = { configured: true, errors: [] };
  const purchaseTypes = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

  // ---- Ads insights (this month) ----
  try {
    const acct = process.env.META_AD_ACCOUNT;
    if (!acct) throw new Error("META_AD_ACCOUNT not set");
    const ins = await g(`${acct}/insights`, {
      date_preset: "this_month",
      fields: "spend,clicks,actions,action_values,purchase_roas",
    });
    const row = (ins.data || [])[0] || {};
    out.adSpend = row.spend != null ? Number(row.spend) : null;
    out.clicks = row.clicks != null ? Number(row.clicks) : null;
    out.adRevenue = findAction(row.action_values, purchaseTypes);
    const purchases = findAction(row.actions, purchaseTypes);
    out.aov = out.adRevenue && purchases ? Math.round(out.adRevenue / purchases) : null;
    out.roas = row.purchase_roas ? Number(row.purchase_roas[0]?.value) : null;
  } catch (e) {
    out.errors.push("ads: " + e.message);
  }

  // ---- Page stats ----
  try {
    let pageId = process.env.META_PAGE_ID;
    if (!pageId) {
      const pages = await g("me/accounts", { fields: "id,name" });
      pageId = (pages.data || [])[0]?.id;
    }
    if (pageId) {
      const page = await g(pageId, { fields: "followers_count,fan_count" });
      out.totalFollowers = page.followers_count ?? page.fan_count ?? null;

      const since = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
      try {
        const ins = await g(`${pageId}/insights`, {
          metric: "page_impressions_unique,page_post_engagements,page_fan_adds",
          period: "day",
          since,
        });
        const sum = (name) => {
          const m = (ins.data || []).find((x) => x.name === name);
          if (!m) return null;
          return m.values.reduce((s, v) => s + (Number(v.value) || 0), 0);
        };
        out.totalReach = sum("page_impressions_unique");
        out.totalEngagement = sum("page_post_engagements");
        out.newFollowers = sum("page_fan_adds");
      } catch (e) {
        out.errors.push("page insights: " + e.message);
      }
    }
  } catch (e) {
    out.errors.push("page: " + e.message);
  }

  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).json(out);
};
