const MAX_RETRIES = 6;
const MAX_CHUNK_SIZE = 20 * 1024 * 1024;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, "") || "/";
      const method = request.method;

      if (method === "OPTIONS") {
        return corsResponse(null, 204);
      }

      const routes = {
        "GET /health": healthCheck,
        "POST /init": initFS,

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

        "GET /file_proxy": fileProxy
      };

      const key = `${method} ${path}`;
      const handler = routes[key];
      if (!handler) return jsonResponse({ error: "Not found", path, method }, 404);

      return await handler(request, env, url);
    } catch (e) {
      console.error("Worker error:", e);
      return jsonResponse({
        error: e.message || "Internal error"
      }, 500);
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function corsResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      ...extra
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function streamResponse(body, contentType, contentLength, extra = {}) {
  const h = new Headers(corsHeaders());
  h.set("Content-Type", contentType || "application/octet-stream");
  if (contentLength) h.set("Content-Length", String(contentLength));
  h.set("Cache-Control", "private, max-age=3600");
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(body, { status: 200, headers: h });
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  if (!name || typeof name !== "string") return "file";
  return name
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200) || "file";
}

function getExtension(name = "") {
  const idx = name.lastIndexOf(".");
  if (idx === -1) return "";
  return name.slice(idx + 1).toLowerCase();
}

function isValidFileId(fileId) {
  if (!fileId || typeof fileId !== "string") return false;
  if (fileId.length < 8 || fileId.length > 300) return false;
  if (fileId.includes("..") || fileId.includes("/") || fileId.includes("\\")) return false;
  return true;
}

async function computeSHA256(input) {
  let ab;
  if (input instanceof ArrayBuffer) {
    ab = input;
  } else if (input instanceof Uint8Array) {
    ab = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  } else if (input && typeof input.arrayBuffer === "function") {
    ab = await input.arrayBuffer();
  } else {
    throw new Error("Invalid hash input");
  }

  const hash = await crypto.subtle.digest("SHA-256", ab);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function createRootFolder() {
  return {
    id: "root",
    name: "My Files",
    type: "folder",
    children: [],
    createdAt: Date.now()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function telegramAPI(env, method, body, isFormData = false, attempt = 0) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN missing");

  const endpoint = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const opts = { method: "POST" };

  if (isFormData) {
    opts.body = body;
  } else {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(endpoint, opts);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      return telegramAPI(env, method, body, isFormData, attempt + 1);
    }
    throw new Error(`Telegram fetch failed: ${err.message}`);
  }

  if (res.status === 429) {
    if (attempt < MAX_RETRIES) {
      let wait = 1000 * 2 ** attempt;
      try {
        const j = await res.clone().json();
        if (j?.parameters?.retry_after) wait = j.parameters.retry_after * 1000;
      } catch (_) {}
      await sleep(wait);
      return telegramAPI(env, method, body, isFormData, attempt + 1);
    }
    throw new Error("Telegram rate limited too many times");
  }

  if (!res.ok) {
    const txt = await res.text();
    if (attempt < MAX_RETRIES && res.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      return telegramAPI(env, method, body, isFormData, attempt + 1);
    }
    throw new Error(`Telegram API ${res.status}: ${txt}`);
  }

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data;
}

async function fetchWithRetry(url, opts = {}, retries = MAX_RETRIES) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(30000, 1000 * 2 ** i));
        continue;
      }
      return res;
    } catch (e) {
      last = e;
      if (i < retries - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw last || new Error("fetchWithRetry failed");
}

async function getTelegramFilePath(env, fileId) {
  const r = await telegramAPI(env, "getFile", { file_id: fileId });
  const fp = r?.result?.file_path;
  if (!fp) throw new Error("No file_path from Telegram");
  if (fp.includes("..") || fp.startsWith("/")) throw new Error("Invalid Telegram file path");
  return fp;
}

// ─────────────────────────────────────────────────────────────────────────────
// KV FILE SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

async function getFS(env) {
  if (!env.VAULT_KV) throw new Error("VAULT_KV missing");
  const raw = await env.VAULT_KV.get("fs:tree");
  if (!raw) {
    const root = createRootFolder();
    await env.VAULT_KV.put("fs:tree", JSON.stringify(root));
    return root;
  }
  return JSON.parse(raw);
}

async function putFS(env, tree) {
  await env.VAULT_KV.put("fs:tree", JSON.stringify(tree));
}

function findNode(tree, id) {
  if (!tree) return null;
  if (tree.id === id) return tree;
  for (const c of tree.children || []) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

function findParent(tree, id) {
  if (!tree) return null;
  for (const c of tree.children || []) {
    if (c.id === id) return tree;
    const found = findParent(c, id);
    if (found) return found;
  }
  return null;
}

function collectFileNodes(node, list = []) {
  if (!node) return list;
  if (node.type === "file") list.push(node);
  for (const c of node.children || []) collectFileNodes(c, list);
  return list;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

async function healthCheck() {
  return jsonResponse({ ok: true, ts: Date.now() });
}

async function initFS(request, env) {
  const fs = await getFS(env);
  return jsonResponse({ ok: true, root: fs });
}

// upload_chunk
// Supports:
// 1) small file upload as single real file (single=true)
// 2) chunk upload as .bin part files
async function uploadChunk(request, env) {
  const form = await request.formData();

  const part = form.get("chunk");
  const indexStr = form.get("index");
  const filenameRaw = form.get("filename");
  const expectedHash = form.get("hash");
  const uploadId = form.get("uploadId") || crypto.randomUUID();
  const isSingle = form.get("single") === "true";
  const mimeType = form.get("mimeType") || "application/octet-stream";

  if (!part || typeof part.arrayBuffer !== "function") {
    return jsonResponse({ error: "Missing chunk/file" }, 400);
  }

  const safeName = sanitizeFilename(filenameRaw || "file");
  const index = Number(indexStr || 0);
  if (isNaN(index) || index < 0) return jsonResponse({ error: "Invalid index" }, 400);

  const buf = await part.arrayBuffer();
  if (!buf.byteLength) return jsonResponse({ error: "Empty upload body" }, 400);
  if (buf.byteLength > MAX_CHUNK_SIZE) {
    return jsonResponse({ error: "Chunk exceeds 20MB max" }, 400);
  }

  const hash = await computeSHA256(buf);
  if (expectedHash && expectedHash !== hash) {
    return jsonResponse({ error: "Hash mismatch", expected: expectedHash, computed: hash }, 400);
  }

  let uploadName;
  if (isSingle) {
    uploadName = safeName;
  } else {
    uploadName = `${safeName}.part${index}.bin`;
  }

  const fd = new FormData();
  fd.append("chat_id", env.TELEGRAM_CHAT_ID);
  fd.append("document", new Blob([buf], { type: isSingle ? mimeType : "application/octet-stream" }), uploadName);
  fd.append("disable_content_type_detection", "true");

  const caption = JSON.stringify({
    uploadId,
    index,
    single: isSingle,
    filename: safeName,
    hash,
    size: buf.byteLength
  }).slice(0, 1024);

  fd.append("caption", caption);

  const tg = await telegramAPI(env, "sendDocument", fd, true);
  const doc = tg?.result?.document;

  if (!doc?.file_id) {
    return jsonResponse({ error: "Telegram did not return file_id" }, 500);
  }

  return jsonResponse({
    ok: true,
    index,
    single: isSingle,
    file_id: doc.file_id,
    file_unique_id: doc.file_unique_id,
    hash,
    size: doc.file_size || buf.byteLength,
    name: uploadName,
    mimeType
  });
}

async function getChunk(request, env, url) {
  const fileId = url.searchParams.get("file_id");
  if (!isValidFileId(fileId)) return jsonResponse({ error: "Invalid file_id" }, 400);

  const fp = await getTelegramFilePath(env, fileId);
  const tgUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fp}`;
  const upstream = await fetchWithRetry(tgUrl);

  if (!upstream.ok) return jsonResponse({ error: "Telegram fetch failed" }, 502);

  return streamResponse(
    upstream.body,
    upstream.headers.get("Content-Type") || "application/octet-stream",
    upstream.headers.get("Content-Length")
  );
}

async function saveMeta(request, env) {
  const body = await request.json();

  const id = body.id || crypto.randomUUID();
  const parentId = body.parentId || "root";
  const filename = sanitizeFilename(body.filename || body.name || "file");

  if (!Array.isArray(body.chunks) || !body.chunks.length) {
    return jsonResponse({ error: "Missing chunks array" }, 400);
  }

  const meta = {
    id,
    type: "file",
    name: filename,
    size: Number(body.size || 0),
    chunkSize: Number(body.chunkSize || MAX_CHUNK_SIZE),
    chunkCount: Number(body.chunkCount || body.chunks.length),
    chunks: body.chunks.map((c, i) => ({
      index: c.index ?? i,
      file_id: c.file_id,
      hash: c.hash || null,
      size: Number(c.size || 0)
    })),
    mimeType: body.mimeType || "application/octet-stream",
    ext: getExtension(filename),
    single: !!body.single,
    previewable: !!body.previewable,
    createdAt: Date.now(),
    modifiedAt: Date.now()
  };

  await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(meta));

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (!parent || parent.type !== "folder") {
    return jsonResponse({ error: "Parent folder not found" }, 400);
  }

  parent.children = (parent.children || []).filter(c => c.id !== id);
  parent.children.push({
    id,
    type: "file",
    name: filename,
    size: meta.size,
    mimeType: meta.mimeType,
    ext: meta.ext,
    single: meta.single,
    previewable: meta.previewable,
    createdAt: meta.createdAt
  });

  await putFS(env, tree);

  return jsonResponse({ ok: true, id, metadata: meta });
}

async function getMeta(request, env, url) {
  const id = url.searchParams.get("id");
  if (!id) return jsonResponse({ error: "Missing id" }, 400);

  const raw = await env.VAULT_KV.get(`meta:${id}`);
  if (!raw) return jsonResponse({ error: "Not found" }, 404);

  return corsResponse(raw, 200, { "Content-Type": "application/json" });
}

async function listFiles(request, env, url) {
  const folderId = url.searchParams.get("folder") || "root";
  const tree = await getFS(env);
  const folder = findNode(tree, folderId);

  if (!folder || folder.type !== "folder") {
    return jsonResponse({ error: "Folder not found" }, 404);
  }

  return jsonResponse({
    ok: true,
    folder
  });
}

async function deleteFile(request, env) {
  const body = await request.json();
  const id = body.id;
  if (!id) return jsonResponse({ error: "Missing id" }, 400);
  if (id === "root") return jsonResponse({ error: "Cannot delete root" }, 400);

  const tree = await getFS(env);
  const node = findNode(tree, id);
  if (!node) return jsonResponse({ error: "Item not found" }, 404);

  const files = collectFileNodes(node);
  for (const f of files) {
    await env.VAULT_KV.delete(`meta:${f.id}`);
  }
  if (node.type === "file") {
    await env.VAULT_KV.delete(`meta:${id}`);
  }

  const parent = findParent(tree, id);
  if (parent) {
    parent.children = (parent.children || []).filter(c => c.id !== id);
    await putFS(env, tree);
  }

  return jsonResponse({ ok: true });
}

async function renameFile(request, env) {
  const body = await request.json();
  const id = body.id;
  const newName = sanitizeFilename(body.name);

  if (!id || !newName) return jsonResponse({ error: "Missing params" }, 400);
  if (id === "root") return jsonResponse({ error: "Cannot rename root" }, 400);

  const tree = await getFS(env);
  const node = findNode(tree, id);
  if (!node) return jsonResponse({ error: "Not found" }, 404);

  node.name = newName;
  await putFS(env, tree);

  const raw = await env.VAULT_KV.get(`meta:${id}`);
  if (raw) {
    const meta = JSON.parse(raw);
    meta.name = newName;
    meta.ext = getExtension(newName);
    meta.modifiedAt = Date.now();
    await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(meta));
  }

  return jsonResponse({ ok: true });
}

async function mkdir(request, env) {
  const body = await request.json();
  const parentId = body.parentId || "root";
  const name = sanitizeFilename(body.name);
  if (!name) return jsonResponse({ error: "Invalid folder name" }, 400);

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (!parent || parent.type !== "folder") return jsonResponse({ error: "Parent not found" }, 400);

  const folder = {
    id: crypto.randomUUID(),
    type: "folder",
    name,
    children: [],
    createdAt: Date.now()
  };

  parent.children.push(folder);
  await putFS(env, tree);

  return jsonResponse({ ok: true, folder });
}

async function moveFile(request, env) {
  const body = await request.json();
  const id = body.id;
  const targetId = body.targetId || "root";

  if (!id) return jsonResponse({ error: "Missing id" }, 400);
  if (id === "root") return jsonResponse({ error: "Cannot move root" }, 400);
  if (id === targetId) return jsonResponse({ error: "Cannot move into self" }, 400);

  const tree = await getFS(env);
  const node = findNode(tree, id);
  const target = findNode(tree, targetId);
  const parent = findParent(tree, id);

  if (!node || !target || !parent) return jsonResponse({ error: "Not found" }, 404);
  if (target.type !== "folder") return jsonResponse({ error: "Target not folder" }, 400);
  if (node.type === "folder" && findNode(node, targetId)) {
    return jsonResponse({ error: "Cannot move folder into descendant" }, 400);
  }

  parent.children = parent.children.filter(c => c.id !== id);
  target.children.push(node);
  await putFS(env, tree);

  return jsonResponse({ ok: true });
}

async function remoteUpload(request, env) {
  const body = await request.json();
  const fileUrl = body.url;
  const name = sanitizeFilename(body.filename || "remote_file");
  const uploadId = body.uploadId || crypto.randomUUID();
  const parentId = body.parentId || "root";

  if (!fileUrl || !/^https?:\/\//i.test(fileUrl)) {
    return jsonResponse({ error: "Invalid URL" }, 400);
  }

  const remote = await fetchWithRetry(fileUrl);
  if (!remote.ok || !remote.body) {
    return jsonResponse({ error: "Remote fetch failed" }, 502);
  }

  const contentType = remote.headers.get("Content-Type") || "application/octet-stream";
  const contentLength = Number(remote.headers.get("Content-Length") || 0);

  // small file direct single upload
  if (contentLength > 0 && contentLength <= MAX_CHUNK_SIZE) {
    const buf = await remote.arrayBuffer();
    const hash = await computeSHA256(buf);

    const fd = new FormData();
    fd.append("chat_id", env.TELEGRAM_CHAT_ID);
    fd.append("document", new Blob([buf], { type: contentType }), name);
    fd.append("disable_content_type_detection", "true");
    fd.append("caption", JSON.stringify({ uploadId, single: true, filename: name, hash }).slice(0, 1024));

    const tg = await telegramAPI(env, "sendDocument", fd, true);
    const doc = tg?.result?.document;
    if (!doc?.file_id) return jsonResponse({ error: "Telegram upload failed" }, 500);

    const meta = {
      id: uploadId,
      type: "file",
      name,
      size: buf.byteLength,
      chunkSize: buf.byteLength,
      chunkCount: 1,
      single: true,
      previewable: isPreviewable(contentType, name),
      chunks: [{
        index: 0,
        file_id: doc.file_id,
        hash,
        size: buf.byteLength
      }],
      mimeType: contentType,
      ext: getExtension(name),
      createdAt: Date.now(),
      modifiedAt: Date.now()
    };

    await env.VAULT_KV.put(`meta:${uploadId}`, JSON.stringify(meta));

    const tree = await getFS(env);
    const parent = findNode(tree, parentId);
    if (parent?.type === "folder") {
      parent.children.push({
        id: uploadId,
        type: "file",
        name,
        size: meta.size,
        mimeType: meta.mimeType,
        ext: meta.ext,
        single: true,
        previewable: meta.previewable,
        createdAt: meta.createdAt
      });
      await putFS(env, tree);
    }

    return jsonResponse({ ok: true, metadata: meta });
  }

  // large remote upload chunked .bin
  const reader = remote.body.getReader();
  let buffer = new Uint8Array(0);
  let idx = 0;
  let total = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      const next = new Uint8Array(buffer.length + value.length);
      next.set(buffer);
      next.set(value, buffer.length);
      buffer = next;
      total += value.length;
      if (total > MAX_FILE_SIZE) throw new Error("Remote file too large");
    }

    while (buffer.length >= MAX_CHUNK_SIZE) {
      const slice = buffer.slice(0, MAX_CHUNK_SIZE);
      buffer = buffer.slice(MAX_CHUNK_SIZE);

      const hash = await computeSHA256(slice);
      const fd = new FormData();
      fd.append("chat_id", env.TELEGRAM_CHAT_ID);
      fd.append("document", new Blob([slice], { type: "application/octet-stream" }), `${name}.part${idx}.bin`);
      fd.append("disable_content_type_detection", "true");

      const tg = await telegramAPI(env, "sendDocument", fd, true);
      const doc = tg?.result?.document;
      if (!doc?.file_id) throw new Error("Chunk upload failed");

      chunks.push({
        index: idx,
        file_id: doc.file_id,
        hash,
        size: slice.length
      });
      idx++;
    }

    if (done) break;
  }

  if (buffer.length) {
    const hash = await computeSHA256(buffer);
    const fd = new FormData();
    fd.append("chat_id", env.TELEGRAM_CHAT_ID);
    fd.append("document", new Blob([buffer], { type: "application/octet-stream" }), `${name}.part${idx}.bin`);
    fd.append("disable_content_type_detection", "true");

    const tg = await telegramAPI(env, "sendDocument", fd, true);
    const doc = tg?.result?.document;
    if (!doc?.file_id) throw new Error("Final chunk upload failed");

    chunks.push({
      index: idx,
      file_id: doc.file_id,
      hash,
      size: buffer.length
    });
  }

  const meta = {
    id: uploadId,
    type: "file",
    name,
    size: total,
    chunkSize: MAX_CHUNK_SIZE,
    chunkCount: chunks.length,
    single: false,
    previewable: false,
    chunks,
    mimeType: contentType,
    ext: getExtension(name),
    createdAt: Date.now(),
    modifiedAt: Date.now()
  };

  await env.VAULT_KV.put(`meta:${uploadId}`, JSON.stringify(meta));

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (parent?.type === "folder") {
    parent.children.push({
      id: uploadId,
      type: "file",
      name,
      size: total,
      mimeType: contentType,
      ext: meta.ext,
      single: false,
      previewable: false,
      createdAt: meta.createdAt
    });
    await putFS(env, tree);
  }

  return jsonResponse({ ok: true, metadata: meta });
}

function isPreviewable(mimeType = "", filename = "") {
  const ext = getExtension(filename);
  if (mimeType.startsWith("image/")) return true;
  if (mimeType.startsWith("video/")) return true;
  if (mimeType.startsWith("audio/")) return true;
  if (mimeType === "application/pdf") return true;
  if (mimeType.startsWith("text/")) return true;
  if (["jpg","jpeg","png","gif","webp","svg","bmp","mp4","webm","mp3","wav","ogg","pdf","txt"].includes(ext)) return true;
  return false;
}

// file_proxy?id=<metaId>
// Only for single small files
async function fileProxy(request, env, url) {
  const id = url.searchParams.get("id");
  if (!id) return jsonResponse({ error: "Missing id" }, 400);

  const raw = await env.VAULT_KV.get(`meta:${id}`);
  if (!raw) return jsonResponse({ error: "Metadata not found" }, 404);

  const meta = JSON.parse(raw);
  if (!meta.single || !meta.chunks?.[0]?.file_id) {
    return jsonResponse({ error: "Preview not available for chunked file" }, 400);
  }

  const fileId = meta.chunks[0].file_id;
  if (!isValidFileId(fileId)) return jsonResponse({ error: "Invalid file_id" }, 400);

  const fp = await getTelegramFilePath(env, fileId);
  const tgUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fp}`;
  const upstream = await fetchWithRetry(tgUrl);

  if (!upstream.ok) return jsonResponse({ error: "Proxy fetch failed" }, 502);

  return streamResponse(
    upstream.body,
    meta.mimeType || upstream.headers.get("Content-Type") || "application/octet-stream",
    upstream.headers.get("Content-Length"),
    {
      "Content-Disposition": `inline; filename="${meta.name.replace(/"/g, "")}"`
    }
  );
}
