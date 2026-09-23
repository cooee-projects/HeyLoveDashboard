// api/creative-notes.js — per-creative notes on the Paid Media tab.
// Database lives under the Hey Love Texas page, so the original integration's
// access (NOTION_TOKEN) covers it automatically.
const DB_ID = 'f8a3939d1a204374b87b6f1a2cc25300'; // Hey Love — Creative Notes
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



module.exports = async (req, res) => {
  if (!TOKEN()) return res.status(500).json({ error: 'NOTION_TOKEN is not set' });

  if (req.method === 'GET') {
    try {
      const pages = await queryAll(DB_ID, {});
      return res.status(200).json({
        notes: pages.map((pg) => ({
          id: pg.id,
          name: (pg.properties['Creative Name']?.title || []).map((t) => t.plain_text).join(''),
          notes: (pg.properties.Notes?.rich_text || []).map((t) => t.plain_text).join(''),
        })),
      });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    if (!checkPass(req)) return res.status(401).json({ error: 'Wrong passcode' });
    const { name, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Missing name' });
    try {
      const found = await queryAll(DB_ID, { filter: { property: 'Creative Name', title: { equals: name } } });
      const props = { Notes: { rich_text: [{ text: { content: (notes || '').slice(0, 2000) } }] } };
      if (found.length) {
        await notion(`/pages/${found[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties: props }) });
      } else {
        await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: DB_ID },
            properties: { 'Creative Name': { title: [{ text: { content: name } }] }, ...props },
          }),
        });
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
};
