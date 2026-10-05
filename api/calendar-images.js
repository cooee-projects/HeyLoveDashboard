// api/calendar-images.js — images on "FY26 MKT Calendar" items.
// Uploads go through Notion's File Upload API and are appended to the event
// page's body as image blocks (appending never overwrites what's already
// there). Images added by hand in Notion's "Images" property are shown too.
const TOKEN = () => process.env.NOTION_TOKEN || process.env.NOTION_TOKEN_TASKS;
const NOTION_VERSION = '2022-06-28';

async function notion(path, options = {}) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN()}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
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

function checkPass(req) {
  const { passcode } = req.body || {};
  return !!process.env.DASHBOARD_PASSCODE && passcode === process.env.DASHBOARD_PASSCODE;
}

function fileUrl(f) {
  return f?.file?.url || f?.external?.url || null;
}

async function listImages(pageId) {
  const [page, children] = await Promise.all([
    notion(`/pages/${pageId}`),
    notion(`/blocks/${pageId}/children?page_size=100`),
  ]);
  const fromProperty = (page.properties?.Images?.files || [])
    .map((f) => ({ url: fileUrl(f), name: f.name, removable: false }))
    .filter((x) => x.url);
  const fromBody = (children.results || [])
    .filter((b) => b.type === 'image')
    .map((b) => ({ blockId: b.id, url: fileUrl(b.image), name: '', removable: true }))
    .filter((x) => x.url);
  return [...fromProperty, ...fromBody];
}

async function uploadImage(pageId, filename, contentType, base64) {
  const buf = Buffer.from(base64, 'base64');
  const created = await notion('/file_uploads', {
    method: 'POST',
    body: JSON.stringify({ filename, content_type: contentType }),
  });

  const form = new FormData();
  form.append('file', new Blob([buf], { type: contentType }), filename);
  const sent = await fetch(`https://api.notion.com/v1/file_uploads/${created.id}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Notion-Version': NOTION_VERSION },
    body: form,
  });
  const sj = await sent.json();
  if (!sent.ok) {
    const err = new Error(`Notion upload ${sent.status}: ${sj.message || 'error'}`);
    err.status = sent.status;
    throw err;
  }

  await notion(`/blocks/${pageId}/children`, {
    method: 'PATCH',
    body: JSON.stringify({
      children: [{ object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: created.id } } }],
    }),
  });
}

module.exports = async (req, res) => {
  if (!TOKEN()) return res.status(500).json({ error: 'NOTION_TOKEN is not set' });

  if (req.method === 'GET') {
    const id = req.query?.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    try {
      return res.status(200).json({ images: await listImages(id) });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    if (!checkPass(req)) return res.status(401).json({ error: 'Wrong passcode' });
    const { id, blockId, delete: del, filename, contentType, data } = req.body || {};
    try {
      if (blockId && del) {
        await notion(`/blocks/${blockId}`, { method: 'DELETE' });
        return res.status(200).json({ ok: true });
      }
      if (id && data) {
        if (!/^image\//.test(contentType || '')) return res.status(400).json({ error: 'Only images can be uploaded' });
        await uploadImage(id, filename || 'image.jpg', contentType, data);
        return res.status(200).json({ ok: true, images: await listImages(id) });
      }
      return res.status(400).json({ error: 'Missing id+data (upload) or blockId+delete (remove)' });
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
