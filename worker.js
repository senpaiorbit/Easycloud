// ============================================================
// Easy Cloud — Cloudflare Worker Backend
// ============================================================
// Environment Variables Required (set in Cloudflare Dashboard):
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — private channel numeric ID
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Filename, X-Chunk-Index',
};

// ── Helpers ──────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function sanitize(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._\-() ]/g, '_')
    .substring(0, 200)
    .trim() || 'file';
}

function validFileId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_\-]+$/.test(id) && id.length > 10;
}

// ── Telegram API wrapper with 429 retry ─────────────────────

async function tg(env, method, body, formData = false) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const opts = { method: 'POST' };

  if (formData) {
    opts.body = body; // already FormData
  } else {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429) {
      const d = await res.json().catch(() => ({}));
      const wait = ((d.parameters && d.parameters.retry_after) || 3 + attempt * 2) * 1000;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const result = await res.json();
    return result;
  }
  return { ok: false, description: 'Rate-limited after retries' };
}

// ── /upload  (direct, ≤ 20 MB) ─────────────────────────────

async function handleUpload(req, env) {
  const fd = await req.formData();
  const file = fd.get('file');
  if (!file) return json({ error: 'No file provided' }, 400);

  const filename = sanitize(fd.get('filename') || file.name);

  const tgFd = new FormData();
  tgFd.append('chat_id', env.TELEGRAM_CHAT_ID);
  tgFd.append('document', file, filename);

  const res = await tg(env, 'sendDocument', tgFd, true);
  if (!res.ok) return json({ error: res.description || 'Telegram upload failed' }, 502);

  const doc = res.result.document;
  return json({
    success: true,
    file_id: doc.file_id,
    file_unique_id: doc.file_unique_id,
    file_size: doc.file_size,
  });
}

// ── /upload_chunk ───────────────────────────────────────────

async function handleUploadChunk(req, env) {
  const fd = await req.formData();
  const chunk = fd.get('chunk');
  if (!chunk) return json({ error: 'No chunk provided' }, 400);

  const chunkName = sanitize(fd.get('chunk_name') || 'chunk.bin');

  const tgFd = new FormData();
  tgFd.append('chat_id', env.TELEGRAM_CHAT_ID);
  tgFd.append('document', chunk, chunkName);

  const res = await tg(env, 'sendDocument', tgFd, true);
  if (!res.ok) return json({ error: res.description || 'Chunk upload failed' }, 502);

  const doc = res.result.document;
  return json({
    success: true,
    file_id: doc.file_id,
    file_unique_id: doc.file_unique_id,
    file_size: doc.file_size,
  });
}

// ── /get_chunk  (stream from Telegram CDN) ──────────────────

async function handleGetChunk(req, env) {
  const url = new URL(req.url);
  const fileId = url.searchParams.get('file_id');
  if (!validFileId(fileId)) return json({ error: 'Invalid file_id' }, 400);

  const info = await tg(env, 'getFile', { file_id: fileId });
  if (!info.ok) return json({ error: info.description || 'File not found' }, 404);

  const filePath = info.result.file_path;
  const cdnUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

  const fileRes = await fetch(cdnUrl);
  if (!fileRes.ok) return json({ error: 'CDN fetch failed' }, 502);

  const headers = new Headers(CORS_HEADERS);
  headers.set('Content-Type', fileRes.headers.get('Content-Type') || 'application/octet-stream');
  const cl = fileRes.headers.get('Content-Length');
  if (cl) headers.set('Content-Length', cl);

  // Stream — do NOT buffer the body
  return new Response(fileRes.body, { headers });
}

// ── /get_file_url ───────────────────────────────────────────

async function handleGetFileUrl(req, env) {
  const url = new URL(req.url);
  const fileId = url.searchParams.get('file_id');
  if (!validFileId(fileId)) return json({ error: 'Invalid file_id' }, 400);

  const info = await tg(env, 'getFile', { file_id: fileId });
  if (!info.ok) return json({ error: info.description || 'File not found' }, 404);

  return json({
    success: true,
    file_path: info.result.file_path,
    file_size: info.result.file_size,
  });
}

// ── /remote_upload ──────────────────────────────────────────

async function handleRemoteUpload(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const fileUrl = body.url;
  if (!fileUrl) return json({ error: 'No URL provided' }, 400);

  const res = await fetch(fileUrl, { redirect: 'follow' });
  if (!res.ok) return json({ error: `Remote fetch failed (${res.status})` }, 502);

  const blob = await res.blob();
  const name = sanitize(body.filename || decodeURIComponent(fileUrl.split('/').pop().split('?')[0]) || 'remote');

  const CHUNK_LIMIT = 20 * 1024 * 1024;

  if (blob.size <= CHUNK_LIMIT) {
    // Direct
    const tgFd = new FormData();
    tgFd.append('chat_id', env.TELEGRAM_CHAT_ID);
    tgFd.append('document', blob, name);
    const r = await tg(env, 'sendDocument', tgFd, true);
    if (!r.ok) return json({ error: r.description || 'Upload failed' }, 502);
    return json({ success: true, mode: 'direct', file_id: r.result.document.file_id, file_size: blob.size });
  }

  // Chunked
  const buf = await blob.arrayBuffer();
  const total = Math.ceil(buf.byteLength / CHUNK_LIMIT);
  const chunks = [];

  for (let i = 0; i < total; i++) {
    const start = i * CHUNK_LIMIT;
    const end = Math.min(start + CHUNK_LIMIT, buf.byteLength);
    const part = new Blob([buf.slice(start, end)]);
    const tgFd = new FormData();
    tgFd.append('chat_id', env.TELEGRAM_CHAT_ID);
    tgFd.append('document', part, `${name}_chunk_${i}.bin`);
    const r = await tg(env, 'sendDocument', tgFd, true);
    if (!r.ok) return json({ error: `Chunk ${i} failed: ${r.description}` }, 502);
    chunks.push({ index: i, file_id: r.result.document.file_id, size: end - start });
  }

  return json({ success: true, mode: 'chunked', chunks, total_size: blob.size });
}

// ── Router ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const path = new URL(request.url).pathname;

    try {
      switch (path) {
        case '/upload':        return await handleUpload(request, env);
        case '/upload_chunk':  return await handleUploadChunk(request, env);
        case '/get_chunk':     return await handleGetChunk(request, env);
        case '/get_file_url':  return await handleGetFileUrl(request, env);
        case '/remote_upload': return await handleRemoteUpload(request, env);
        default:
          return json({
            name: 'Easy Cloud Worker',
            endpoints: ['/upload', '/upload_chunk', '/get_chunk', '/get_file_url', '/remote_upload'],
          });
      }
    } catch (e) {
      return json({ error: 'Internal error', detail: e.message }, 500);
    }
  },
};
