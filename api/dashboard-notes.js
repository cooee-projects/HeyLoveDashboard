// api/dashboard-notes.js — Paid Media "Updates" log + Content "Notes & Feedback" log.
// Database lives under the Hey Love Texas page (covered by NOTION_TOKEN's access).
const DB_ID = 'd8e1f0d9d34b44429f6c8f6653ed4a8d'; // Hey Love — Dashboard Notes
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
    const type = req.query?.type;
    try {
      const body = { sorts: [{ timestamp: 'created_time', direction: 'descending' }] };
      if (type) body.filter = { property: 'Type', select: { equals: type } };
      const pages = await queryAll(DB_ID, body);
      return res.status(200).json({
        notes: pages.slice(0, 50).map((pg) => ({
          id: pg.id,
          text: (pg.properties.Text?.title || []).map((t) => t.plain_text).join(''),
          type: pg.properties.Type?.select?.name || '',
          logged: pg.created_time,
        })),
      });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    if (!checkPass(req)) return res.status(401).json({ error: 'Wrong passcode' });
    const { text, type } = req.body || {};
    if (!text || !type) return res.status(400).json({ error: 'Missing text or type' });
    try {
      await notion('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { database_id: DB_ID },
          properties: {
            Text: { title: [{ text: { content: text.slice(0, 2000) } }] },
            Type: { select: { name: type } },
          },
        }),
      });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
};
