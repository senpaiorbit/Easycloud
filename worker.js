const MAX_RETRIES = 6;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === "OPTIONS") return cors(204);

    const routes = {
      "POST /upload_chunk": uploadChunk,
      "GET /get_chunk": getChunk,
      "POST /save_meta": saveMeta,
      "GET /meta": getMeta,
      "GET /list": listFiles,
      "POST /delete": deleteFile,
      "POST /rename": renameFile,
      "POST /mkdir": mkdir,
      "POST /move": moveFile,
      "POST /remote_upload": remoteUpload,
    };

    const key = `${request.method} ${p}`;
    const handler = routes[key];
    if (!handler) return json({ error: "Not found" }, 404);

    try {
      return await handler(request, env, url);
    } catch (e) {
      return json({ error: e.message || "Internal error" }, 500);
    }
  }
};

function cors(status = 200) {
  return new Response(null, {
    status,
    headers: ch()
  });
}

function ch() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(data, s = 200) {
  return new Response(JSON.stringify(data), {
    status: s,
    headers: { "Content-Type": "application/json", ...ch() }
  });
}

function stream(body, contentType, contentLength) {
  const h = new Headers(ch());
  h.set("Content-Type", contentType || "application/octet-stream");
  if (contentLength) h.set("Content-Length", contentLength);
  h.set("Cache-Control", "private, max-age=7200");
  return new Response(body, { status: 200, headers: h });
}

function sanitize(n) {
  return (n || "file").replace(/[\/\\?%*:|"<>]/g, "_").replace(/\.\./g, "_").slice(0, 200);
}

function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_\-]+$/.test(id);
}

async function sha256(buf) {
  const d = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function tg(env, method, body, isForm = false, attempt = 0) {
  const ep = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const opts = { method: "POST" };

  if (isForm) {
    opts.body = body;
  } else {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(ep, opts);

  if (res.status === 429 && attempt < MAX_RETRIES) {
    let wait = 1000 * 2 ** attempt;
    try {
      const j = await res.json();
      if (j?.parameters?.retry_after) wait = j.parameters.retry_after * 1000;
    } catch (_) {}
    await sleep(wait);
    return tg(env, method, body, isForm, attempt + 1);
  }

  if (!res.ok && attempt < MAX_RETRIES) {
    await sleep(1000 * 2 ** attempt);
    return tg(env, method, body, isForm, attempt + 1);
  }

  const data = await res.json();
  if (!data.ok) throw new Error(`TG: ${JSON.stringify(data)}`);
  return data;
}

async function retryFetch(url, opts = {}, attempts = MAX_RETRIES) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || r.status >= 500) {
        await sleep(Math.min(30000, 1000 * 2 ** i));
        continue;
      }
      return r;
    } catch (e) {
      if (i === attempts - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error("retryFetch exhausted");
}

// ─── UPLOAD CHUNK ───
async function uploadChunk(request, env) {
  const form = await request.formData();
  const chunk = form.get("chunk");
  const index = Number(form.get("index"));
  const name = sanitize(form.get("filename"));
  const expectedHash = form.get("hash");
  const uploadId = form.get("uploadId");

  if (!chunk || !(chunk instanceof File)) return json({ error: "Missing chunk" }, 400);

  const buf = await chunk.arrayBuffer();
  const hash = await sha256(buf);

  if (expectedHash && hash !== expectedHash) {
    return json({ error: "Hash mismatch" }, 400);
  }

  const fd = new FormData();
  fd.append("chat_id", env.TELEGRAM_CHAT_ID);
  fd.append("document", new Blob([buf]), `${name}.part${index}`);
  fd.append("disable_content_type_detection", "true");

  const r = await tg(env, "sendDocument", fd, true);
  const doc = r?.result?.document;
  if (!doc?.file_id) return json({ error: "No file_id" }, 500);

  return json({
    ok: true,
    index,
    file_id: doc.file_id,
    hash,
    size: doc.file_size || chunk.size
  });
}

// ─── GET CHUNK (STREAM) ───
async function getChunk(request, env, url) {
  const fileId = url.searchParams.get("file_id");
  if (!validId(fileId)) return json({ error: "Invalid file_id" }, 400);

  const r = await tg(env, "getFile", { file_id: fileId });
  const fp = r?.result?.file_path;
  if (!fp || fp.includes("..")) return json({ error: "Bad path" }, 400);

  const tgUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fp}`;
  const upstream = await retryFetch(tgUrl);
  if (!upstream.ok) return json({ error: "TG fetch failed" }, 502);

  return stream(
    upstream.body,
    upstream.headers.get("Content-Type"),
    upstream.headers.get("Content-Length")
  );
}

// ─── FILE SYSTEM (KV-BASED) ───
async function getFS(env) {
  const raw = await env.VAULT_KV.get("fs:tree");
  return raw ? JSON.parse(raw) : { name: "root", type: "folder", children: [], id: "root" };
}

async function putFS(env, tree) {
  await env.VAULT_KV.put("fs:tree", JSON.stringify(tree));
}

function findNode(tree, id) {
  if (tree.id === id) return tree;
  if (tree.children) {
    for (const c of tree.children) {
      const found = findNode(c, id);
      if (found) return found;
    }
  }
  return null;
}

function findParent(tree, id) {
  if (tree.children) {
    for (const c of tree.children) {
      if (c.id === id) return tree;
      const found = findParent(c, id);
      if (found) return found;
    }
  }
  return null;
}

async function saveMeta(request, env) {
  const body = await request.json();
  const id = body.id || crypto.randomUUID();
  const parentId = body.parentId || "root";
  const name = sanitize(body.filename);

  const meta = {
    id,
    type: "file",
    name,
    size: Number(body.size || 0),
    chunkSize: Number(body.chunkSize || 0),
    chunkCount: Number(body.chunkCount || 0),
    chunks: body.chunks || [],
    mimeType: body.mimeType || "application/octet-stream",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };

  await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(meta));

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (!parent || parent.type !== "folder") return json({ error: "Parent not found" }, 400);

  parent.children = parent.children.filter(c => c.id !== id);
  parent.children.push({ id, type: "file", name, size: meta.size, mimeType: meta.mimeType, createdAt: meta.createdAt });
  await putFS(env, tree);

  return json({ ok: true, id, meta });
}

async function getMeta(request, env, url) {
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400);
  const raw = await env.VAULT_KV.get(`meta:${id}`);
  if (!raw) return json({ error: "Not found" }, 404);
  return new Response(raw, { status: 200, headers: { "Content-Type": "application/json", ...ch() } });
}

async function listFiles(request, env, url) {
  const parentId = url.searchParams.get("folder") || "root";
  const tree = await getFS(env);
  const node = findNode(tree, parentId);
  if (!node || node.type !== "folder") return json({ error: "Folder not found" }, 404);
  return json({ ok: true, folder: node });
}

async function deleteFile(request, env) {
  const body = await request.json();
  const id = body.id;
  if (!id) return json({ error: "Missing id" }, 400);

  const tree = await getFS(env);
  const parent = findParent(tree, id);
  if (parent) {
    parent.children = parent.children.filter(c => c.id !== id);
    await putFS(env, tree);
  }

  await env.VAULT_KV.delete(`meta:${id}`);
  return json({ ok: true });
}

async function renameFile(request, env) {
  const body = await request.json();
  const id = body.id;
  const newName = sanitize(body.name);
  if (!id || !newName) return json({ error: "Missing params" }, 400);

  const tree = await getFS(env);
  const node = findNode(tree, id);
  if (!node) return json({ error: "Not found" }, 404);
  node.name = newName;
  await putFS(env, tree);

  const raw = await env.VAULT_KV.get(`meta:${id}`);
  if (raw) {
    const meta = JSON.parse(raw);
    meta.name = newName;
    meta.modifiedAt = Date.now();
    await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(meta));
  }

  return json({ ok: true });
}

async function mkdir(request, env) {
  const body = await request.json();
  const parentId = body.parentId || "root";
  const name = sanitize(body.name);
  const id = crypto.randomUUID();

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (!parent || parent.type !== "folder") return json({ error: "Parent not found" }, 400);

  parent.children.push({ id, type: "folder", name, children: [], createdAt: Date.now() });
  await putFS(env, tree);

  return json({ ok: true, id, name });
}

async function moveFile(request, env) {
  const body = await request.json();
  const id = body.id;
  const targetId = body.targetId || "root";

  const tree = await getFS(env);
  const parent = findParent(tree, id);
  const target = findNode(tree, targetId);
  const node = findNode(tree, id);

  if (!parent || !target || !node) return json({ error: "Not found" }, 404);
  if (target.type !== "folder") return json({ error: "Target not folder" }, 400);

  parent.children = parent.children.filter(c => c.id !== id);
  target.children.push(node);
  await putFS(env, tree);

  return json({ ok: true });
}

async function remoteUpload(request, env) {
  const body = await request.json();
  const fileUrl = body.url;
  const name = sanitize(body.filename || "remote_file.bin");
  const uploadId = body.uploadId || crypto.randomUUID();
  const parentId = body.parentId || "root";
  const chunkSize = Math.min(Number(body.chunkSize || 20 * 1024 * 1024), 20 * 1024 * 1024);

  if (!fileUrl || !/^https?:\/\//i.test(fileUrl)) return json({ error: "Invalid URL" }, 400);

  const remote = await retryFetch(fileUrl);
  if (!remote.ok || !remote.body) return json({ error: "Fetch failed" }, 502);

  const reader = remote.body.getReader();
  let buffer = new Uint8Array(0);
  let idx = 0;
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buffer.length + value.length);
    next.set(buffer); next.set(value, buffer.length);
    buffer = next; total += value.length;

    while (buffer.length >= chunkSize) {
      const slice = buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);
      const hash = await sha256(slice.buffer);

      const fd = new FormData();
      fd.append("chat_id", env.TELEGRAM_CHAT_ID);
      fd.append("document", new Blob([slice]), `${name}.part${idx}`);
      fd.append("disable_content_type_detection", "true");

      const r = await tg(env, "sendDocument", fd, true);
      chunks.push({ index: idx, file_id: r.result.document.file_id, hash, size: slice.length });
      idx++;
    }
  }

  if (buffer.length > 0) {
    const hash = await sha256(buffer.buffer);
    const fd = new FormData();
    fd.append("chat_id", env.TELEGRAM_CHAT_ID);
    fd.append("document", new Blob([buffer]), `${name}.part${idx}`);
    fd.append("disable_content_type_detection", "true");
    const r = await tg(env, "sendDocument", fd, true);
    chunks.push({ index: idx, file_id: r.result.document.file_id, hash, size: buffer.length });
  }

  const meta = {
    id: uploadId, filename: name, size: total, chunkSize,
    chunkCount: chunks.length, chunks, parentId
  };

  // Reuse saveMeta logic
  await env.VAULT_KV.put(`meta:${uploadId}`, JSON.stringify({
    ...meta, type: "file", name, mimeType: "application/octet-stream",
    createdAt: Date.now(), modifiedAt: Date.now()
  }));

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (parent && parent.type === "folder") {
    parent.children.push({
      id: uploadId, type: "file", name, size: total,
      mimeType: "application/octet-stream", createdAt: Date.now()
    });
    await putFS(env, tree);
  }

  return json({ ok: true, metadata: meta });
}
