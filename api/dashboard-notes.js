// api/dashboard-notes.js — reads and writes the "Hey Love — Dashboard Notes" Notion database.
// Shared by two sections: Paid Media's "Updates" and Content's "Notes & Feedback",
// distinguished by the "type" query param / field ("Paid Updates" or "Content Feedback").
// This is a log (each entry keeps its own timestamp) rather than one overwritable field —
// a small upgrade from the preview version so update history isn't lost.
const NOTION_VERSION = '2025-09-03';
const DATA_SOURCE_ID = '3a0f9220-bc38-4b57-9a9a-e39820a1e892'; // Hey Love — Dashboard Notes

async function notion(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN_TASKS}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || `Notion API error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function rowFromPage(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    text: (p.Text?.title || []).map((t) => t.plain_text).join('') || '',
    type: p.Type?.select?.name || '',
    logged: p.Logged?.created_time || null,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.NOTION_TOKEN_TASKS) {
    return res.status(500).json({ error: 'NOTION_TOKEN_TASKS is not set' });
  }

  if (req.method === 'GET') {
    const type = req.query?.type;
    try {
      const body = { sorts: [{ timestamp: 'created_time', direction: 'descending' }], page_size: 50 };
      if (type) body.filter = { property: 'Type', select: { equals: type } };
      const data = await notion(`/data_sources/${DATA_SOURCE_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
      return res.status(200).json({ notes: data.results.map(rowFromPage) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { passcode, text, type } = req.body || {};
    if (!process.env.DASHBOARD_PASSCODE || passcode !== process.env.DASHBOARD_PASSCODE) {
      return res.status(401).json({ error: 'Wrong passcode' });
    }
    if (!text || !type) return res.status(400).json({ error: 'Missing text or type' });
    try {
      const page = await notion('/pages', {
        method: 'POST',
        body: JSON.stringify({
          parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
          properties: {
            Text: { title: [{ text: { content: text } }] },
            Type: { select: { name: type } },
          },
        }),
      });
      return res.status(200).json({ ok: true, note: rowFromPage(page) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
