// Vercel serverless function: pulls this month's campaigns (sent AND scheduled)
// from Klaviyo. Env var: KLAVIYO_API_KEY (private key, pk_..., read-only scopes).
// Emails include real rendered HTML for full previews.

const BASE = "https://a.klaviyo.com/api";

async function k(path) {
  const r = await fetch(`${BASE}/${path}`, {
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      revision: "2024-10-15",
      accept: "application/vnd.api+json",
    },
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.detail || "Klaviyo error");
  return j;
}

async function kPost(path, body) {
  const r = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      revision: "2024-10-15",
      accept: "application/vnd.api+json",
      "content-type": "application/vnd.api+json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.detail || "Klaviyo error");
  return j;
}

const SHOW = ["draft", "scheduled", "queued"]; // upcoming/unsent content only — sent & sending excluded

async function campaigns(channel) {
  const filter = encodeURIComponent(`equals(messages.channel,'${channel}')`);
  const j = await k(`campaigns/?filter=${filter}&sort=-created_at&include=campaign-messages`);
  const msgs = {};
  for (const inc of j.included || []) {
    if (inc.type === "campaign-message") msgs[inc.id] = inc;
  }
  return (j.data || [])
    .map((c) => {
      const a = c.attributes || {};
      const msgId = (c.relationships?.["campaign-messages"]?.data || [])[0]?.id;
      const msg = msgs[msgId];
      const def = msg?.attributes?.definition || msg?.attributes || {};
      const content = def.content || {};
      const status = (a.status || "").toLowerCase();
      const isDraft = status.includes("draft");
      return {
        id: c.id,
        msgId,
        name: a.name,
        status: a.status,
        isDraft,
        scheduled: !isDraft, // among draft/scheduled/queued, anything not a draft is scheduled
        // Drafts have no send time — leave date null rather than falling back
        // to created_at, which would misleadingly read as a send date.
        date: isDraft ? null : a.send_time || a.scheduled_at || a.send_options?.datetime || null,
        subject: content.subject || "",
        preview: content.preview_text || "",
        body: content.body || "",
      };
    })
    .filter((c) => SHOW.some((s) => (c.status || "").toLowerCase().includes(s)))
    .slice(0, 12);
}

// Klaviyo's Values Report endpoint requires a conversion_metric_id even when
// you're not requesting revenue — look up the account's own "Placed Order"
// metric (or closest match) rather than hardcoding an account-specific ID.
async function getConversionMetricId() {
  try {
    const j = await k("metrics/");
    const list = j.data || [];
    let m = list.find((x) => (x.attributes?.name || "").toLowerCase() === "placed order");
    if (!m) m = list.find((x) => (x.attributes?.name || "").toLowerCase().includes("order"));
    return m ? m.id : null;
  } catch {
    return null;
  }
}

// Email Campaign performance, last 30 days — Campaigns API only, Flows are
// never touched by this file, so flow emails can't leak into this list.
async function emailCampaignPerformance() {
  const filter = encodeURIComponent(`equals(messages.channel,'email')`);
  const list = await k(`campaigns/?filter=${filter}&sort=-created_at`);
  const names = {};
  for (const c of list.data || []) names[c.id] = c.attributes?.name;
  const ids = Object.keys(names);
  if (!ids.length) return [];

  const conversionMetricId = await getConversionMetricId();
  const statistics = ["delivered", "open_rate", "click_rate", "bounce_rate", "unsubscribe_rate"];
  if (conversionMetricId) statistics.push("conversion_value");

  const idList = ids.map((i) => `"${i}"`).join(",");
  const attributes = {
    timeframe: { key: "last_30_days" },
    statistics,
    filter: `any(campaign_id,[${idList}])`,
  };
  if (conversionMetricId) attributes.conversion_metric_id = conversionMetricId;

  const rep = await kPost("campaign-values-reports/", {
    data: { type: "campaign-values-report", attributes },
  });

  const byCampaign = {};
  for (const row of rep.data?.attributes?.results || []) {
    const cid = row.groupings?.campaign_id;
    if (!cid || !row.statistics) continue;
    if (!byCampaign[cid]) byCampaign[cid] = row.statistics;
  }

  return Object.keys(byCampaign)
    .filter((id) => (byCampaign[id].delivered || 0) > 0) // only campaigns that actually sent
    .map((id) => ({
      id,
      name: names[id] || "Untitled campaign",
      delivered: byCampaign[id].delivered ?? null,
      openRate: byCampaign[id].open_rate ?? null,
      clickRate: byCampaign[id].click_rate ?? null,
      bounceRate: byCampaign[id].bounce_rate ?? null,
      unsubRate: byCampaign[id].unsubscribe_rate ?? null,
      revenue: byCampaign[id].conversion_value ?? null,
    }))
    .sort((a, b) => (b.delivered || 0) - (a.delivered || 0));
}

module.exports = async (req, res) => {
  if (!process.env.KLAVIYO_API_KEY) {
    return res.status(200).json({ configured: false });
  }
  const out = { configured: true, errors: [] };

  try {
    const emails = await campaigns("email");
    await Promise.all(
      emails.slice(0, 8).map(async (e) => {
        try {
          if (!e.msgId) return;
          const t = await k(`campaign-messages/${e.msgId}/template/`);
          e.html = t.data?.attributes?.html || null;
        } catch (err) {
          out.errors.push(`template ${e.name}: ${err.message}`);
        }
      })
    );
    out.emails = emails;
  } catch (e) {
    out.errors.push("email campaigns: " + e.message);
  }

  try {
    out.sms = await campaigns("sms");
  } catch (e) {
    out.errors.push("sms campaigns: " + e.message);
  }

  try {
    out.emailPerformance = await emailCampaignPerformance();
  } catch (e) {
    out.errors.push("email performance: " + e.message);
    out.emailPerformance = [];
  }

  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).json(out);
};
