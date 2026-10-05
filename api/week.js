// api/week.js — the Planner's "This Week" card. Its own hand-added list, kept
// separate from the FY26 MKT Calendar so emails/SMS/social don't flow into it.
// Database lives under the Hey Love Texas page (covered by NOTION_TOKEN's access).
const DB_ID = '62455b24aa3c4f7b8b8c267bfcbac6f7'; // Hey Love — This Week
const TOKEN = () => process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_TASKS;

async function notion(path, options = {}) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  });
  const j = await r.json();
  if (!r.ok) {
    const err = new Error(`Notion ${r.status}: ${j.message || 'error'}`);
    err.status = r.status;
    throw err;
  }
  return j;
}

async function queryAll(dbId, body) {
  let results = [];
  let cursor;
  do {
    const j = await notion(`/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return results;
}

function checkPass(req) {
  const { passcode } = req.body || {};
  return !!process.env.DASHBOARD_PASSCODE && passcode === process.env.DASHBOARD_PASSCODE;
}

function rowFromPage(page) {
  const p = page.properties || {};
  const start = p.Date?.date?.start || null;
  return {
    id: page.id,
    name: (p.Name?.title || []).map((t) => t.plain_text).join('') || '(untitled)',
    date: start ? start.slice(0, 10) : null,
  };
}

module.exports = async (req, res) => {
  if (!TOKEN()) return res.status(500).json({ error: 'NOTION_TOKEN is not set' });

  if (req.method === 'GET') {
    // Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD to fetch just one week.
    const { from, to } = req.query || {};
    const and = [];
    if (from) and.push({ property: 'Date', date: { on_or_after: from } });
    if (to) and.push({ property: 'Date', date: { on_or_before: to } });
    try {
      const body = { sorts: [{ property: 'Date', direction: 'ascending' }] };
      if (and.length) body.filter = and.length === 1 ? and[0] : { and };
      const pages = await queryAll(DB_ID, body);
      return res.status(200).json({ items: pages.map(rowFromPage).filter((i) => i.date) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    if (!checkPass(req)) return res.status(401).json({ error: 'Wrong passcode' });
    const { id, name, date, delete: del } = req.body || {};
    try {
      if (id && del) {
        await notion(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
        return res.status(200).json({ ok: true });
      }
      if (id) {
        const properties = {};
        if (name) properties.Name = { title: [{ text: { content: name } }] };
        if (date) properties.Date = { date: { start: date } };
        await notion(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
        return res.status(200).json({ ok: true });
      }
      if (name && date) {
        const page = await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: DB_ID },
            properties: {
              Name: { title: [{ text: { content: name } }] },
              Date: { date: { start: date } },
            },
          }),
        });
        return res.status(200).json({ ok: true, item: rowFromPage(page) });
      }
      return res.status(400).json({ error: 'Missing id (update/delete) or name+date (create)' });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
