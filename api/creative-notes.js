// api/creative-notes.js — reads and writes the "Hey Love — Creative Notes" Notion database.
// Notes are keyed by creative name; posting a name that already has a row updates it in place.
const NOTION_VERSION = '2025-09-03';
const DATA_SOURCE_ID = '8c682404-1545-496b-a364-30fac64f03e5'; // Hey Love — Creative Notes

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
    name: (p['Creative Name']?.title || []).map((t) => t.plain_text).join('') || '',
    notes: (p.Notes?.rich_text || []).map((t) => t.plain_text).join('') || '',
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
    try {
      const data = await notion(`/data_sources/${DATA_SOURCE_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({ page_size: 100 }),
      });
      return res.status(200).json({ notes: data.results.map(rowFromPage) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { passcode, name, notes } = req.body || {};
    if (!process.env.DASHBOARD_PASSCODE || passcode !== process.env.DASHBOARD_PASSCODE) {
      return res.status(401).json({ error: 'Wrong passcode' });
    }
    if (!name) return res.status(400).json({ error: 'Missing name' });
    try {
      const search = await notion(`/data_sources/${DATA_SOURCE_ID}/query`, {
        method: 'POST',
        body: JSON.stringify({ filter: { property: 'Creative Name', title: { equals: name } } }),
      });
      if (search.results.length) {
        await notion(`/pages/${search.results[0].id}`, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { Notes: { rich_text: [{ text: { content: notes || '' } }] } } }),
        });
      } else {
        await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
            properties: {
              'Creative Name': { title: [{ text: { content: name } }] },
              Notes: { rich_text: [{ text: { content: notes || '' } }] },
            },
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
