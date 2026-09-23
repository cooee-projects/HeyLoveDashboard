// api/calendar.js — reads and writes the real "FY26 MKT Calendar" Notion database
// (Hey Love Texas / FY26 MKT Calendar), not a separate copy.
//
// This database stores the emoji as part of the title text itself (e.g. "📸 HL x MM
// Shoot", "💬Text: Mahjong") rather than in its own property, and originally had no
// Notes field — a "Notes" rich_text column was added to it to support the notes modal,
// everything else on the database is untouched.
const NOTION_VERSION = '2025-09-03';
const DATA_SOURCE_ID = '73dd6c2c-b503-83cd-953a-876da5489904'; // FY26 MKT Calendar

const EMOJI_RE = /^(📸|📧|💬|🎟️|⭐️|🔴)\s*/u;
function splitEmoji(name) {
  const m = (name || '').match(EMOJI_RE);
  if (m) return { emoji: m[1], text: name.slice(m[0].length) };
  return { emoji: '', text: name || '' };
}
const CATEGORY_BY_EMOJI = { '📸': 'Shoot', '📧': 'Email/Social', '💬': 'Email/Social' };
function categoryFor(emoji) { return CATEGORY_BY_EMOJI[emoji] || 'Other'; }

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
  const rawName = (p.Name?.title || []).map((t) => t.plain_text).join('') || '(untitled)';
  const { emoji, text } = splitEmoji(rawName);
  return {
    id: page.id,
    name: text,
    date: p.Date?.date?.start || null,
    category: categoryFor(emoji),
    emoji,
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
        body: JSON.stringify({ sorts: [{ property: 'Date', direction: 'ascending' }], page_size: 100 }),
      });
      return res.status(200).json({ events: data.results.map(rowFromPage) });
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
        if (name) properties.Name = { title: [{ text: { content: (emoji ? emoji + ' ' : '') + name } }] };
        await notion(`/pages/${id}`, { method: 'PATCH', body: JSON.stringify({ properties }) });
        return res.status(200).json({ ok: true });
      }
      if (name && date) {
        const fullName = (emoji ? emoji + ' ' : '') + name;
        const properties = {
          Name: { title: [{ text: { content: fullName } }] },
          Date: { date: { start: date } },
        };
        const page = await notion('/pages', {
          method: 'POST',
          body: JSON.stringify({
            parent: { type: 'data_source_id', data_source_id: DATA_SOURCE_ID },
            properties,
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
