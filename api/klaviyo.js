// Vercel serverless function: pulls recent sent campaigns from Klaviyo.
// Env var: KLAVIYO_API_KEY (private key, pk_...). Read-only scopes are enough.
// Emails include the real rendered HTML; SMS include the actual message copy.

const BASE = "https://a.klaviyo.com/api";

async function k(path) {
  const r = await fetch(`${BASE}/${path}`, {
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      revision: "2024-10-15",
      accept: "application/vnd.api+json",
    },
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0]?.detail || "Klaviyo error");
  return j;
}

async function campaigns(channel) {
  const filter = encodeURIComponent(`equals(messages.channel,'${channel}')`);
  const j = await k(`campaigns/?filter=${filter}&sort=-created_at&include=campaign-messages`);
  const msgs = {};
  for (const inc of j.included || []) {
    if (inc.type === "campaign-message") msgs[inc.id] = inc;
  }
  return (j.data || [])
    .filter((c) => (c.attributes.status || "").toLowerCase() !== "draft")
    .slice(0, 6)
    .map((c) => {
      const msgId = (c.relationships?.["campaign-messages"]?.data || [])[0]?.id;
      const msg = msgs[msgId];
      const def = msg?.attributes?.definition || msg?.attributes || {};
      const content = def.content || {};
      return {
        id: c.id,
        msgId,
        name: c.attributes.name,
        status: c.attributes.status,
        date: c.attributes.send_time || c.attributes.scheduled_at || c.attributes.created_at,
        subject: content.subject || "",
        preview: content.preview_text || "",
        body: content.body || "",
      };
    });
}

module.exports = async (req, res) => {
  if (!process.env.KLAVIYO_API_KEY) {
    return res.status(200).json({ configured: false });
  }
  const out = { configured: true, errors: [] };

  try {
    const emails = await campaigns("email");
    // Fetch real template HTML for the most recent 4 emails.
    await Promise.all(
      emails.slice(0, 4).map(async (e) => {
        try {
          if (!e.msgId) return;
          const t = await k(`campaign-messages/${e.msgId}/template/`);
          e.html = t.data?.attributes?.html || null;
        } catch (err) {
          out.errors.push(`template ${e.name}: ${err.message}`);
        }
      })
    );
    out.emails = emails.slice(0, 4);
  } catch (e) {
    out.errors.push("email campaigns: " + e.message);
  }

  try {
    out.sms = (await campaigns("sms")).slice(0, 4);
  } catch (e) {
    out.errors.push("sms campaigns: " + e.message);
  }

  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
  res.status(200).json(out);
};
