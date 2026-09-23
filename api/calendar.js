// api/calendar.js — reads/writes the real "FY26 MKT Calendar" Notion database.
// Uses the exact same key, API version, and query style as the original,
// already-working api/data.js (NOTION_TOKEN, Notion-Version 2022-06-28,
// /databases/{id}/query) — that integration already has access to this database.
const DB_ID = 'abed6c2cb5038318a1d401377a039e1c'; // FY26 MKT Calendar (same ID data.js uses)
const TOKEN = () => process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_TASKS;

const EMOJI_RE = /^(📸|📧|💬|🎟️|🎟|⭐️|⭐|🔴)\s*/u;
function splitEmoji(name) {
  const m = (name || '').match(EMOJI_RE);
  if (m) return { emoji: m[1], text: name.slice(m[0].length) };
  return { emoji: '', text: name || '' };
}
function categoryFor(emoji) {
  if (emoji === '📸') return 'Shoot';
  if (emoji === '📧' || emoji === '💬') return 'Email/Social';
  return 'Other';
}

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

async function queryAll(body) {
  let results = [];
  let cursor;
  do {
    const j = await notion(`/databases/${DB_ID}/query`, {
      method: 'POST',
      body: JSON.stringify({ page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return results;
}

function rowFromPage(page) {
  const p = page.properties || {};
  const raw = (p.Name?.title || []).map((t) => t.plain_text).join('') || '(untitled)';
  const { emoji, text } = splitEmoji(raw);
  const start = p.Date?.date?.start || null;
  return {
    id: page.id,
    name: text,
    date: start ? start.slice(0, 10) : null, // day only, for the calendar grid
    rawDate: start,                            // full value, so times survive a reschedule
    category: categoryFor(emoji),
    emoji,
    notes: (p.Notes?.rich_text || []).map((t) => t.plain_text).join(''),
  };
}

module.exports = async (req, res) => {
  if (!TOKEN()) return res.status(500).json({ error: 'NOTION_TOKEN is not set' });

  if (req.method === 'GET') {
    try {
      const pages = await queryAll({ sorts: [{ property: 'Date', direction: 'ascending' }] });
      return res.status(200).json({ events: pages.map(rowFromPage).filter((e) => e.date) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const { passcode, id, name, date, emoji, notes, delete: del } = req.body || {};
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
        if (date) properties.Date = { date: { start: date } };
        if (typeof notes === 'string') properties.Notes = { rich_text: [{ text: { content: notes } }] };
        if (name) properties.Name = { title: [{ text: { content: (emoji || '') + name } }] };
        await notion(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
        return res.status(200).json({ ok: true });
      }
      if (name && date) {
        const page = await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id: DB_ID },
            properties: {
              Name: { title: [{ text: { content: (emoji || '') + name } }] },
              Date: { date: { start: date } },
            },
          }),
        });
        return res.status(200).json({ ok: true, event: rowFromPage(page) });
      }
      return res.status(400).json({ error: 'Missing id (update/delete) or name+date (create)' });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
