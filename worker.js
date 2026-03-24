export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return handleCors();
      }

      // Upload & Download
      if (path === "/upload_chunk" && request.method === "POST") return await uploadChunk(request, env);
      if (path === "/get_chunk" && request.method === "GET") return await getChunk(request, env);
      if (path === "/file_proxy" && request.method === "GET") return await fileProxy(request, env);

      // Metadata
      if (path === "/save_meta" && request.method === "POST") return await saveMeta(request, env);
      if (path === "/meta" && request.method === "GET") return await getMeta(request, env);

      // File Manager
      if (path === "/list" && request.method === "GET") return await listFiles(request, env);
      if (path === "/mkdir" && request.method === "POST") return await mkdirHandler(request, env);
      if (path === "/delete" && request.method === "POST") return await deleteHandler(request, env);
      if (path === "/rename" && request.method === "POST") return await renameHandler(request, env);
      if (path === "/move" && request.method === "POST") return await moveHandler(request, env);

      // Remote
      if (path === "/remote_upload" && request.method === "POST") return await remoteUpload(request, env);

      // Health
      if (path === "/health") return json({ ok: true, ts: Date.now() });

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Internal error", message: err?.message || String(err) }, 500);
    }
  }
};

// ═══════════════════════════════════════════════════════════════════
// HELPERS — exact copy from working reference
// ═══════════════════════════════════════════════════════════════════

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function handleCors() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

function sanitizeFilename(name) {
  return (name || "file")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\.\./g, "_")
    .slice(0, 180);
}

function getExt(name) {
  const i = (name || "").lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

async function sha256Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM API — exact copy from working reference
// ═══════════════════════════════════════════════════════════════════

async function telegramApi(env, method, body, isFormData = false, attempt = 0) {
  const maxAttempts = 5;
  const endpoint = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

  let headers = {};
  let payload = body;

  if (!isFormData) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: payload
  });

  if (resp.status === 429) {
    let wait = 2 ** attempt * 1000;
    try {
      const data = await resp.json();
      const retryAfter = data?.parameters?.retry_after;
      if (retryAfter) wait = retryAfter * 1000;
    } catch (_) {}
    if (attempt < maxAttempts) {
      await sleep(wait);
      return telegramApi(env, method, body, isFormData, attempt + 1);
    }
  }

  if (!resp.ok) {
    const text = await resp.text();
    if (attempt < maxAttempts) {
      await sleep(2 ** attempt * 1000);
      return telegramApi(env, method, body, isFormData, attempt + 1);
    }
    throw new Error(`Telegram API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  if (!data.ok) {
    if (attempt < maxAttempts) {
      await sleep(2 ** attempt * 1000);
      return telegramApi(env, method, body, isFormData, attempt + 1);
    }
    throw new Error(`Telegram API returned not ok: ${JSON.stringify(data)}`);
  }

  return data;
}

async function fetchWithRetry(url, opts = {}, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.status === 429) {
        await sleep(Math.min(30000, 1000 * 2 ** i));
        continue;
      }
      if (!resp.ok) {
        if (i < attempts - 1) {
          await sleep(1000 * 2 ** i);
          continue;
        }
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await sleep(1000 * 2 ** i);
      }
    }
  }
  throw lastErr || new Error("fetchWithRetry failed");
}

// ═══════════════════════════════════════════════════════════════════
// UPLOAD CHUNK — based on working reference, adds single-file mode
// ═══════════════════════════════════════════════════════════════════

async function uploadChunk(request, env) {
  const form = await request.formData();
  const chunk = form.get("chunk");
  const index = form.get("index");
  const fileName = sanitizeFilename(form.get("filename"));
  const expectedHash = form.get("hash");
  const uploadId = form.get("uploadId");
  const isSingle = form.get("single") === "true";

  if (!chunk || !(chunk instanceof File)) {
    return json({ error: "Missing chunk file" }, 400);
  }

  const arrBuf = await chunk.arrayBuffer();
  const actualHash = await sha256Hex(arrBuf);

  if (expectedHash && actualHash !== expectedHash) {
    return json({ error: "SHA-256 mismatch before Telegram upload" }, 400);
  }

  // Single file: use real filename. Chunked: use .bin
  const tgFileName = isSingle ? fileName : `${fileName}.part${index}.bin`;

  const tgForm = new FormData();
  tgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
  tgForm.append("document", new Blob([arrBuf]), tgFileName);
  tgForm.append("disable_content_type_detection", "true");
  tgForm.append("caption", JSON.stringify({
    uploadId,
    index: Number(index),
    originalName: fileName,
    hash: actualHash,
    single: isSingle
  }).slice(0, 1024));

  const res = await telegramApi(env, "sendDocument", tgForm, true);
  const doc = res?.result?.document;

  if (!doc?.file_id) {
    return json({ error: "Telegram did not return file_id" }, 500);
  }

  return json({
    ok: true,
    index: Number(index),
    file_id: doc.file_id,
    file_unique_id: doc.file_unique_id,
    hash: actualHash,
    size: doc.file_size || chunk.size
  });
}

// ═══════════════════════════════════════════════════════════════════
// GET CHUNK — exact pattern from working reference
// ═══════════════════════════════════════════════════════════════════

async function getChunk(request, env) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("file_id");

  if (!fileId || typeof fileId !== "string" || fileId.length < 8) {
    return json({ error: "Invalid file_id" }, 400);
  }

  if (fileId.includes("..") || fileId.includes("/") || fileId.includes("\\")) {
    return json({ error: "Invalid file_id" }, 400);
  }

  const tg = await telegramApi(env, "getFile", { file_id: fileId });
  const filePath = tg?.result?.file_path;

  if (!filePath || filePath.includes("..")) {
    return json({ error: "Invalid file path" }, 400);
  }

  const tgUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const upstream = await fetchWithRetry(tgUrl, {}, 5);

  if (!upstream.ok) {
    return json({ error: "Failed to fetch Telegram file", status: upstream.status }, 502);
  }

  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Length", upstream.headers.get("Content-Length") || "");
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(upstream.body, { status: 200, headers });
}

// ═══════════════════════════════════════════════════════════════════
// FILE PROXY — for single small files, streams with correct mime
// ═══════════════════════════════════════════════════════════════════

async function fileProxy(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) return json({ error: "Missing id" }, 400);
  if (!env.VAULT_KV) return json({ error: "KV not configured" }, 500);

  const raw = await env.VAULT_KV.get(`meta:${id}`);
  if (!raw) return json({ error: "Not found" }, 404);

  const meta = JSON.parse(raw);

  if (!meta.single || !meta.chunks?.[0]?.file_id) {
    return json({ error: "Not a single previewable file" }, 400);
  }

  const fileId = meta.chunks[0].file_id;
  const tg = await telegramApi(env, "getFile", { file_id: fileId });
  const filePath = tg?.result?.file_path;

  if (!filePath || filePath.includes("..")) {
    return json({ error: "Invalid file path" }, 400);
  }

  const tgUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const upstream = await fetchWithRetry(tgUrl, {}, 5);

  if (!upstream.ok) {
    return json({ error: "Proxy fetch failed" }, 502);
  }

  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", meta.mimeType || upstream.headers.get("Content-Type") || "application/octet-stream");
  headers.set("Content-Length", upstream.headers.get("Content-Length") || "");
  headers.set("Cache-Control", "private, max-age=7200");
  headers.set("Content-Disposition", `inline; filename="${meta.name.replace(/"/g, "")}"`);

  return new Response(upstream.body, { status: 200, headers });
}

// ═══════════════════════════════════════════════════════════════════
// FILE SYSTEM (KV)
// ═══════════════════════════════════════════════════════════════════

async function getFS(env) {
  if (!env.VAULT_KV) throw new Error("KV not configured");
  const raw = await env.VAULT_KV.get("fs:tree");
  if (!raw) {
    const root = { id: "root", name: "My Files", type: "folder", children: [], createdAt: Date.now() };
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
  for (const c of (tree.children || [])) {
    const found = findNode(c, id);
    if (found) return found;
  }
  return null;
}

function findParent(tree, id) {
  if (!tree) return null;
  for (const c of (tree.children || [])) {
    if (c.id === id) return tree;
    const found = findParent(c, id);
    if (found) return found;
  }
  return null;
}

function collectFileIds(node, ids = []) {
  if (!node) return ids;
  if (node.type === "file") ids.push(node.id);
  for (const c of (node.children || [])) collectFileIds(c, ids);
  return ids;
}

function isPreviewable(mimeType, filename) {
  const ext = getExt(filename);
  if ((mimeType || "").startsWith("image/")) return true;
  if ((mimeType || "").startsWith("video/")) return true;
  if ((mimeType || "").startsWith("audio/")) return true;
  if (mimeType === "application/pdf") return true;
  if (["jpg","jpeg","png","gif","webp","svg","mp4","webm","mp3","wav","ogg","pdf","txt"].includes(ext)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// SAVE & GET METADATA
// ═══════════════════════════════════════════════════════════════════

async function saveMeta(request, env) {
  const body = await request.json();
  const id = body.id || crypto.randomUUID();
  const parentId = body.parentId || "root";
  const name = sanitizeFilename(body.filename || body.name || "file");

  if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
    return json({ error: "Missing chunks" }, 400);
  }

  const meta = {
    id,
    type: "file",
    name,
    size: Number(body.size || 0),
    chunkSize: Number(body.chunkSize || 0),
    chunkCount: body.chunks.length,
    chunks: body.chunks.map((c, i) => ({
      index: c.index ?? i,
      file_id: c.file_id,
      hash: c.hash || null,
      size: Number(c.size || 0)
    })),
    mimeType: body.mimeType || "application/octet-stream",
    ext: getExt(name),
    single: !!body.single,
    previewable: !!body.previewable,
    createdAt: Date.now(),
    modifiedAt: Date.now()
  };

  await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(meta));

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (!parent || parent.type !== "folder") {
    return json({ error: "Parent folder not found" }, 400);
  }

  parent.children = (parent.children || []).filter(c => c.id !== id);
  parent.children.push({
    id, type: "file", name, size: meta.size,
    mimeType: meta.mimeType, ext: meta.ext,
    single: meta.single, previewable: meta.previewable,
    createdAt: meta.createdAt
  });
  await putFS(env, tree);

  return json({ ok: true, id, metadata: meta });
}

async function getMeta(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400);
  if (!env.VAULT_KV) return json({ error: "KV not configured" }, 500);

  const data = await env.VAULT_KV.get(`meta:${id}`);
  if (!data) return json({ error: "Not found" }, 404);

  return new Response(data, {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

// ═══════════════════════════════════════════════════════════════════
// FILE MANAGER ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

async function listFiles(request, env) {
  const url = new URL(request.url);
  const folderId = url.searchParams.get("folder") || "root";
  const tree = await getFS(env);
  const folder = findNode(tree, folderId);
  if (!folder || folder.type !== "folder") return json({ error: "Folder not found" }, 404);
  return json({ ok: true, folder });
}

async function mkdirHandler(request, env) {
  const body = await request.json();
  const parentId = body.parentId || "root";
  const name = sanitizeFilename(body.name);
  if (!name) return json({ error: "Invalid name" }, 400);

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (!parent || parent.type !== "folder") return json({ error: "Parent not found" }, 400);

  const folder = {
    id: crypto.randomUUID(),
    type: "folder",
    name,
    children: [],
    createdAt: Date.now()
  };
  parent.children.push(folder);
  await putFS(env, tree);

  return json({ ok: true, folder });
}

async function deleteHandler(request, env) {
  const body = await request.json();
  const id = body.id;
  if (!id) return json({ error: "Missing id" }, 400);
  if (id === "root") return json({ error: "Cannot delete root" }, 400);

  const tree = await getFS(env);
  const node = findNode(tree, id);
  if (!node) return json({ error: "Not found" }, 404);

  // Delete all metadata for files within
  const fileIds = collectFileIds(node);
  if (node.type === "file") fileIds.push(id);
  for (const fid of fileIds) {
    try { await env.VAULT_KV.delete(`meta:${fid}`); } catch (_) {}
  }

  const parent = findParent(tree, id);
  if (parent) {
    parent.children = parent.children.filter(c => c.id !== id);
    await putFS(env, tree);
  }

  return json({ ok: true });
}

async function renameHandler(request, env) {
  const body = await request.json();
  const id = body.id;
  const newName = sanitizeFilename(body.name);
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
    meta.ext = getExt(newName);
    meta.modifiedAt = Date.now();
    await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(meta));
  }

  return json({ ok: true });
}

async function moveHandler(request, env) {
  const body = await request.json();
  const id = body.id;
  const targetId = body.targetId || "root";
  if (!id) return json({ error: "Missing id" }, 400);
  if (id === targetId) return json({ error: "Cannot move into self" }, 400);

  const tree = await getFS(env);
  const node = findNode(tree, id);
  const target = findNode(tree, targetId);
  const parent = findParent(tree, id);

  if (!node || !target || !parent) return json({ error: "Not found" }, 404);
  if (target.type !== "folder") return json({ error: "Target not folder" }, 400);
  if (node.type === "folder" && findNode(node, targetId)) {
    return json({ error: "Cannot move into descendant" }, 400);
  }

  parent.children = parent.children.filter(c => c.id !== id);
  target.children.push(node);
  await putFS(env, tree);

  return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════
// REMOTE UPLOAD — same pattern as working reference
// ═══════════════════════════════════════════════════════════════════

async function remoteUpload(request, env) {
  const body = await request.json();
  const fileUrl = body?.url;
  const fileName = sanitizeFilename(body?.filename || "remote_file.bin");
  const uploadId = body?.uploadId || crypto.randomUUID();
  const parentId = body?.parentId || "root";
  const chunkSize = Math.min(Number(body?.chunkSize || 20 * 1024 * 1024), 20 * 1024 * 1024);

  if (!fileUrl || !/^https?:\/\//i.test(fileUrl)) {
    return json({ error: "Invalid URL" }, 400);
  }

  const remoteResp = await fetchWithRetry(fileUrl, {}, 5);
  if (!remoteResp.ok || !remoteResp.body) {
    return json({ error: "Failed to fetch remote file" }, 502);
  }

  const contentType = remoteResp.headers.get("Content-Type") || "application/octet-stream";
  const contentLength = Number(remoteResp.headers.get("Content-Length") || 0);

  // Small file: single upload with real name
  if (contentLength > 0 && contentLength <= chunkSize) {
    const arrBuf = await remoteResp.arrayBuffer();
    const hash = await sha256Hex(arrBuf);

    const tgForm = new FormData();
    tgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
    tgForm.append("document", new Blob([arrBuf]), fileName);
    tgForm.append("disable_content_type_detection", "true");
    tgForm.append("caption", JSON.stringify({
      uploadId, single: true, originalName: fileName, hash
    }).slice(0, 1024));

    const res = await telegramApi(env, "sendDocument", tgForm, true);
    const doc = res?.result?.document;
    if (!doc?.file_id) return json({ error: "Telegram upload failed" }, 500);

    const previewable = isPreviewable(contentType, fileName);

    const meta = {
      id: uploadId, type: "file", name: fileName, size: arrBuf.byteLength,
      chunkSize: arrBuf.byteLength, chunkCount: 1, single: true, previewable,
      chunks: [{ index: 0, file_id: doc.file_id, hash, size: arrBuf.byteLength }],
      mimeType: contentType, ext: getExt(fileName),
      createdAt: Date.now(), modifiedAt: Date.now()
    };

    await env.VAULT_KV.put(`meta:${uploadId}`, JSON.stringify(meta));

    const tree = await getFS(env);
    const parent = findNode(tree, parentId);
    if (parent?.type === "folder") {
      parent.children.push({
        id: uploadId, type: "file", name: fileName, size: meta.size,
        mimeType: contentType, ext: meta.ext, single: true, previewable,
        createdAt: meta.createdAt
      });
      await putFS(env, tree);
    }

    return json({ ok: true, metadata: meta });
  }

  // Large file: chunked .bin upload
  const reader = remoteResp.body.getReader();
  let buffer = new Uint8Array(0);
  let chunkIndex = 0;
  const chunks = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const next = new Uint8Array(buffer.length + value.length);
    next.set(buffer, 0);
    next.set(value, buffer.length);
    buffer = next;
    totalSize += value.length;

    while (buffer.length >= chunkSize) {
      const chunkBytes = buffer.slice(0, chunkSize);
      buffer = buffer.slice(chunkSize);

      const hash = await sha256Hex(chunkBytes.buffer);
      const tgForm = new FormData();
      tgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
      tgForm.append("document", new Blob([chunkBytes]), `${fileName}.part${chunkIndex}.bin`);
      tgForm.append("disable_content_type_detection", "true");
      tgForm.append("caption", JSON.stringify({
        uploadId, index: chunkIndex, originalName: fileName, hash
      }).slice(0, 1024));

      const res = await telegramApi(env, "sendDocument", tgForm, true);
      const doc = res?.result?.document;
      chunks.push({ index: chunkIndex, file_id: doc.file_id, hash, size: chunkBytes.length });
      chunkIndex++;
    }
  }

  if (buffer.length > 0) {
    const hash = await sha256Hex(buffer.buffer);
    const tgForm = new FormData();
    tgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
    tgForm.append("document", new Blob([buffer]), `${fileName}.part${chunkIndex}.bin`);
    tgForm.append("disable_content_type_detection", "true");
    tgForm.append("caption", JSON.stringify({
      uploadId, index: chunkIndex, originalName: fileName, hash
    }).slice(0, 1024));

    const res = await telegramApi(env, "sendDocument", tgForm, true);
    const doc = res?.result?.document;
    chunks.push({ index: chunkIndex, file_id: doc.file_id, hash, size: buffer.length });
  }

  const meta = {
    id: uploadId, type: "file", name: fileName, size: totalSize,
    chunkSize, chunkCount: chunks.length, single: false, previewable: false,
    chunks, mimeType: contentType, ext: getExt(fileName),
    createdAt: Date.now(), modifiedAt: Date.now()
  };

  await env.VAULT_KV.put(`meta:${uploadId}`, JSON.stringify(meta));

  const tree = await getFS(env);
  const parent = findNode(tree, parentId);
  if (parent?.type === "folder") {
    parent.children.push({
      id: uploadId, type: "file", name: fileName, size: totalSize,
      mimeType: contentType, ext: meta.ext, single: false, previewable: false,
      createdAt: meta.createdAt
    });
    await putFS(env, tree);
  }

  return json({ ok: true, metadata: meta });
}
