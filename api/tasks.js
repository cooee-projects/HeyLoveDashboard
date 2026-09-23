// api/tasks.js — Action Items. Reads/writes the same Task database the original
// dashboard's "Tasks In Progress" uses (same ID as api/data.js), with the same
// proven key + API version. Shows open tasks only, like the original.
const DB_ID = 'af5d6c2cb50383659f21819f225659b3';
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
  return {
    id: page.id,
    name: (p.Name?.title || []).map((t) => t.plain_text).join('') || '(untitled)',
    done: !!p.Done?.checkbox,
    dueDate: p['Due Date']?.date?.start || null,
  };
}

module.exports = async (req, res) => {
  if (!TOKEN()) return res.status(500).json({ error: 'NOTION_TOKEN is not set' });

  if (req.method === 'GET') {
    try {
      const pages = await queryAll(DB_ID, { filter: { property: 'Done', checkbox: { equals: false } } });
      return res.status(200).json({ tasks: pages.map(rowFromPage) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    if (!checkPass(req)) return res.status(401).json({ error: 'Wrong passcode' });
    const { id, done, name, delete: del } = req.body || {};
    try {
      if (id && del) {
        await notion(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
        return res.status(200).json({ ok: true });
      }
      if (id) {
        const properties = {};
        if (typeof done === 'boolean') properties.Done = { checkbox: done };
        if (name) properties.Name = { title: [{ text: { content: name } }] };
        await notion(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
        return res.status(200).json({ ok: true });
      }
      if (name) {
        const page = await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: DB_ID },
            properties: { Name: { title: [{ text: { content: name } }] } },
          }),
        });
        return res.status(200).json({ ok: true, task: rowFromPage(page) });
      }
      return res.status(400).json({ error: 'Missing id or name' });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }
  return res.status(405).json({ error: 'Method not allowed' });
};
