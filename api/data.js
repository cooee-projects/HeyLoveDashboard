// Vercel serverless function: fetches all dashboard data from Notion.
// Requires env var NOTION_TOKEN (set in Vercel project settings).

const DB = {
  metaStats: "e65edd97944d4017b77b900eb85ed7f5",
  videos: "278fab9ad18149d0955d219900cc7dbe",
  events: "abed6c2cb5038318a1d401377a039e1c", // FY26 MKT Calendar
  tasks: "af5d6c2cb50383659f21819f225659b3",
  sms: "39dd6c2cb503808e8fb2f760d4197092",
  emails: "39dd6c2cb503804baec7ee27e95e8972",
};

async function queryDb(id, body = {}) {
  const r = await fetch(`https://api.notion.com/v1/databases/${id}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 100, ...body }),
  });
  if (!r.ok) throw new Error(`Notion ${id}: ${r.status} ${await r.text()}`);
  return (await r.json()).results;
}

// ---- property helpers ----
const plain = (arr) => (arr || []).map((t) => t.plain_text).join("");
const P = (page, name) => page.properties[name] || {};
const title = (page, name) => plain(P(page, name).title);
const text = (page, name) => plain(P(page, name).rich_text);
const num = (page, name) => P(page, name).number;
const date = (page, name) => (P(page, name).date || {}).start || null;
const check = (page, name) => !!P(page, name).checkbox;
const status = (page, name) => (P(page, name).status || {}).name || "";
const select = (page, name) => (P(page, name).select || {}).name || "";
const multi = (page, name) => (P(page, name).multi_select || []).map((o) => o.name);
const url = (page, name) => P(page, name).url || "";
const files = (page, name) =>
  (P(page, name).files || []).map((f) => (f.file ? f.file.url : f.external ? f.external.url : null)).filter(Boolean);

module.exports = async (req, res) => {
  try {
    const [statsRows, videoRows, eventRows, taskRows, smsRows, emailRows] = await Promise.all([
      queryDb(DB.metaStats),
      queryDb(DB.videos, { sorts: [{ property: "Date", direction: "descending" }] }),
      queryDb(DB.events, { sorts: [{ property: "Date", direction: "ascending" }] }),
      queryDb(DB.tasks, { sorts: [{ property: "Due Date", direction: "ascending" }] }),
      queryDb(DB.sms, { sorts: [{ property: "DATE", direction: "descending" }] }),
      queryDb(DB.emails, { sorts: [{ property: "DATE", direction: "descending" }] }),
    ]);

    // Meta stats: newest row = current month; previous row used for deltas.
    const stats = statsRows
      .map((p) => ({
        month: title(p, "Month"),
        adSpend: num(p, "Meta Ad Spend"),
        adRevenue: num(p, "Meta Ad Revenue"),
        roas: num(p, "ROAS"),
        aov: num(p, "AOV"),
        clicks: num(p, "Clicks"),
        totalFollowers: num(p, "Total Followers"),
        newFollowers: num(p, "New Followers"),
        totalReach: num(p, "Total Reach"),
        totalEngagement: num(p, "Total Engagement"),
        created: p.created_time,
      }))
      .sort((a, b) => (a.created < b.created ? 1 : -1));

    const today = new Date().toISOString().slice(0, 10);

    const data = {
      updated: new Date().toISOString(),
      stats: { current: stats[0] || null, previous: stats[1] || null },
      videos: videoRows.slice(0, 8).map((p) => ({
        name: title(p, "Name"),
        date: date(p, "Date"),
        platform: select(p, "Platform"),
        views: num(p, "Views"),
        link: url(p, "Video Link"),
      })),
      events: eventRows
        .filter((p) => (date(p, "Date") || "") >= today)
        .slice(0, 8)
        .map((p) => ({ name: title(p, "Name"), date: date(p, "Date"), tags: multi(p, "Tags") })),
      tasks: taskRows
        .filter((p) => !check(p, "Done"))
        .slice(0, 8)
        .map((p) => ({ name: title(p, "Name"), due: date(p, "Due Date"), priority: multi(p, "Priority") })),
      sms: smsRows.slice(0, 4).map((p) => ({
        focus: title(p, "FOCUS"),
        copy: text(p, "COPY"),
        date: date(p, "DATE"),
        status: status(p, "Status"),
      })),
      emails: emailRows.slice(0, 6).map((p) => ({
        focus: title(p, "FOCUS"),
        subject: text(p, "SUBJECT"),
        preview: text(p, "PREVIEW"),
        date: date(p, "DATE"),
        status: status(p, "Status"),
        images: files(p, "Files & media"),
      })),
    };

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
