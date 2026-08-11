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

const SHOW = ["sent", "sending", "scheduled", "queued"]; // statuses worth showing

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
      return {
        id: c.id,
        msgId,
        name: a.name,
        status: a.status,
        scheduled: !status.includes("sent") && !status.includes("sending"),
        date: a.send_time || a.scheduled_at || a.send_options?.datetime || a.created_at,
        subject: content.subject || "",
        preview: content.preview_text || "",
        body: content.body || "",
      };
    })
    .filter((c) => SHOW.some((s) => (c.status || "").toLowerCase().includes(s)))
    .slice(0, 12);
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

  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).json(out);
};
