// api/tasks.js — reads and writes the "Task" data source under Hey Love Texas in Notion.
const NOTION_VERSION = '2025-09-03';
const DATA_SOURCE_ID = '56ad6c2c-b503-8319-a72a-87edbd56a19e'; // Hey Love Texas > Task

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
    name: (p.Name?.title || []).map((t) => t.plain_text).join('') || '(untitled)',
    done: !!p.Done?.checkbox,
    dueDate: p['Due Date']?.date?.start || null,
    priority: (p.Priority?.multi_select || []).map((o) => o.name),
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
        body: JSON.stringify({ sorts: [{ property: 'Due Date', direction: 'ascending' }] }),
      });
      return res.status(200).json({ tasks: data.results.map(rowFromPage) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { passcode, id, done, name, dueDate, priority, delete: del } = req.body || {};
    if (!process.env.DASHBOARD_PASSCODE || passcode !== process.env.DASHBOARD_PASSCODE) {
      return res.status(401).json({ error: 'Wrong passcode' });
    }
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
        const properties = { Name: { title: [{ text: { content: name } }] } };
        if (dueDate) properties['Due Date'] = { date: { start: dueDate } };
        if (priority) properties.Priority = { multi_select: [{ name: priority }] };
        const page = await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
            properties,
          }),
        });
        return res.status(200).json({ ok: true, task: rowFromPage(page) });
      }
      return res.status(400).json({ error: 'Missing id (to update/delete) or name (to create)' });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
