// Vercel serverless function: fetches all dashboard data from Notion.
// Requires env var NOTION_TOKEN (set in Vercel project settings).
//
// "What's Happening This Week" reads directly from the "✨ This Week"
// bulleted list on the main Hey Love Texas Notion page — the team already
// maintains that list by hand, so there's nothing new to set up there.
//
// Optional env vars:
//   DRIVE_FOLDER_URL        - link to the Google Drive folder content lives in
//   HEYORCA_CALENDAR_URL    - HeyOrca's "universal link" for the live calendar
//                             (Calendar -> Share -> Universal Link in HeyOrca)

const DB = {
  metaStats: "e65edd97944d4017b77b900eb85ed7f5",
  videos: "278fab9ad18149d0955d219900cc7dbe",
  events: "abed6c2cb5038318a1d401377a039e1c", // FY26 MKT Calendar
  tasks: "af5d6c2cb50383659f21819f225659b3",
  sms: "39dd6c2cb503808e8fb2f760d4197092",
  emails: "39dd6c2cb503804baec7ee27e95e8972",
};

const THIS_WEEK_PAGE_ID = "845d6c2cb50382d0905d016cd9183fb2"; // Hey Love Texas page

async function queryDb(id, body = {}) {
  let results = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${id}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    if (!r.ok) throw new Error(`Notion ${id}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return results;
}

async function getBlockChildren(blockId) {
  let results = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const r = await fetch(`https://api.notion.com/v1/blocks/${blockId}/children?${qs}`, {
      headers: {
        Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
      },
    });
    if (!r.ok) throw new Error(`Notion blocks ${blockId}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return results;
}

// Walks the page (including into column layouts, one level deep is typical
// here but this recurses in case that changes) looking for a heading whose
// text contains "this week", then collects the bullet/checkbox items that
// follow it, stopping at the next heading.
async function fetchThisWeekNotes() {
  async function search(blocks) {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (/^heading_/.test(b.type)) {
        const headingText = plain(b[b.type].rich_text).toLowerCase();
        if (headingText.includes("this week")) {
          const notes = [];
          for (let j = i + 1; j < blocks.length; j++) {
            const sib = blocks[j];
            if (/^heading_/.test(sib.type)) break;
            if (sib.type === "bulleted_list_item" || sib.type === "to_do" || sib.type === "numbered_list_item") {
              notes.push(plain(sib[sib.type].rich_text));
            }
          }
          if (notes.length) return notes;
        }
      }
      if (b.type === "column_list") {
        const columns = await getBlockChildren(b.id);
        for (const col of columns) {
          const found = await search(await getBlockChildren(col.id));
          if (found) return found;
        }
      }
    }
    return null;
  }
  const top = await getBlockChildren(THIS_WEEK_PAGE_ID);
  return (await search(top)) || [];
}

// ---- property helpers ----
const plain = (arr) => (arr || []).map((t) => t.plain_text).join("");
const P = (page, name) => page.properties[name] || {};
const title = (page, name) => plain(P(page, name).title);
const text = (page, name) => plain(P(page, name).rich_text);
const num = (page, name) => P(page, name).number;
const date = (page, name) => {
  const d = (P(page, name).date || {}).start || null;
  return d ? d.slice(0, 10) : null; // strip any time-of-day — some rows store a datetime, most just a date
};
const check = (page, name) => !!P(page, name).checkbox;
const status = (page, name) => (P(page, name).status || {}).name || "";
const select = (page, name) => (P(page, name).select || {}).name || "";
const multi = (page, name) => (P(page, name).multi_select || []).map((o) => o.name);
const url = (page, name) => P(page, name).url || "";
const files = (page, name) =>
  (P(page, name).files || []).map((f) => (f.file ? f.file.url : f.external ? f.external.url : null)).filter(Boolean);

module.exports = async (req, res) => {
  try {
    const [statsRows, videoRows, eventRows, taskRows, smsRows, emailRows, weeklyNotes] = await Promise.all([
      queryDb(DB.metaStats),
      queryDb(DB.videos, { sorts: [{ property: "Date", direction: "descending" }] }),
      queryDb(DB.events, { sorts: [{ property: "Date", direction: "ascending" }] }),
      queryDb(DB.tasks, { sorts: [{ property: "Due Date", direction: "ascending" }] }),
      queryDb(DB.sms, { sorts: [{ property: "DATE", direction: "descending" }] }),
      queryDb(DB.emails, { sorts: [{ property: "DATE", direction: "descending" }] }),
      fetchThisWeekNotes().catch((e) => {
        console.warn("this week notes:", e.message);
        return [];
      }),
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

    const data = {
      updated: new Date().toISOString(),
      stats: { current: stats[0] || null, previous: stats[1] || null },
      weeklyNotes,
      links: {
        drive: process.env.DRIVE_FOLDER_URL || null,
        heyOrca: process.env.HEYORCA_CALENDAR_URL || null,
      },
      videos: videoRows.slice(0, 8).map((p) => ({
        name: title(p, "Name"),
        date: date(p, "Date"),
        platform: select(p, "Platform"),
        views: num(p, "Views"),
        link: url(p, "Video Link"),
      })),
      // Every dated row in FY26 MKT Calendar — used to plan ahead, not just
      // this month, so the calendar UI handles month-by-month navigation
      // itself rather than the API scoping it down.
      events: eventRows
        .filter((p) => date(p, "Date"))
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
