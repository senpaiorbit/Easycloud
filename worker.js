const MAX_RETRIES = 6;
const MAX_CHUNK_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/$/, "") || "/";
      const method = request.method;

      // Handle CORS preflight
      if (method === "OPTIONS") {
        return corsResponse(null, 204);
      }

      // Route handlers
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
        "GET /health": healthCheck,
        "POST /init": initFS,
      };

      const routeKey = `${method} ${path}`;
      const handler = routes[routeKey];

      if (!handler) {
        return jsonResponse({ error: "Not found", path, method }, 404);
      }

      return await handler(request, env, url);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse(
        {
          error: err.message || "Internal server error",
          stack: err.stack?.split("\n").slice(0, 3),
        },
        500
      );
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// CORS & RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };
}

function corsResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function streamResponse(body, contentType, contentLength) {
  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", contentType || "application/octet-stream");
  if (contentLength) {
    headers.set("Content-Length", String(contentLength));
  }
  headers.set("Cache-Control", "private, max-age=7200");
  return new Response(body, { status: 200, headers });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function sanitizeFilename(name) {
  if (!name || typeof name !== "string") return "file";
  return name
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200) || "file";
}

function isValidFileId(fileId) {
  if (!fileId || typeof fileId !== "string") return false;
  // Telegram file_id can contain: letters, numbers, underscore, hyphen, and sometimes special chars
  // They are base64-like, so we allow a broad set
  if (fileId.length < 10 || fileId.length > 200) return false;
  // Block obvious path traversal
  if (fileId.includes("..") || fileId.includes("/") || fileId.includes("\\")) return false;
  return true;
}

function isValidUUID(id) {
  if (!id || typeof id !== "string") return false;
  return /^[a-f0-9\-]{36}$/i.test(id) || /^[A-Za-z0-9_\-]+$/.test(id);
}

async function computeSHA256(buffer) {
  let arrayBuffer;
  if (buffer instanceof ArrayBuffer) {
    arrayBuffer = buffer;
  } else if (buffer instanceof Uint8Array) {
    arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
  } else if (typeof buffer === "object" && buffer.arrayBuffer) {
    arrayBuffer = await buffer.arrayBuffer();
  } else {
    throw new Error("Invalid buffer type for SHA256");
  }

  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function telegramAPI(env, method, body, isFormData = false, attempt = 0) {
  const botToken = env.BOT_TOKEN;
  if (!botToken) {
    throw new Error("BOT_TOKEN not configured");
  }

  const endpoint = `https://api.telegram.org/bot${botToken}/${method}`;
  const options = { method: "POST" };

  if (isFormData) {
    options.body = body;
  } else {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(endpoint, options);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * Math.pow(2, attempt));
      return telegramAPI(env, method, body, isFormData, attempt + 1);
    }
    throw new Error(`Telegram network error: ${err.message}`);
  }

  // Handle rate limiting
  if (response.status === 429) {
    if (attempt < MAX_RETRIES) {
      let waitTime = 1000 * Math.pow(2, attempt);
      try {
        const errorData = await response.clone().json();
        if (errorData?.parameters?.retry_after) {
          waitTime = errorData.parameters.retry_after * 1000;
        }
      } catch (_) {}
      console.log(`Rate limited, waiting ${waitTime}ms`);
      await sleep(waitTime);
      return telegramAPI(env, method, body, isFormData, attempt + 1);
    }
    throw new Error("Telegram rate limit exceeded after retries");
  }

  // Handle other errors
  if (!response.ok) {
    if (attempt < MAX_RETRIES && response.status >= 500) {
      await sleep(1000 * Math.pow(2, attempt));
      return telegramAPI(env, method, body, isFormData, attempt + 1);
    }
    const errorText = await response.text();
    throw new Error(`Telegram API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram returned error: ${JSON.stringify(data)}`);
  }

  return data;
}

async function fetchWithRetry(url, options = {}, maxAttempts = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 429 || response.status >= 500) {
        const waitTime = Math.min(30000, 1000 * Math.pow(2, attempt));
        await sleep(waitTime);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
  }

  throw lastError || new Error("Fetch failed after retries");
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE SYSTEM (KV-BASED)
// ═══════════════════════════════════════════════════════════════════════════════

function createRootFolder() {
  return {
    id: "root",
    name: "My Files",
    type: "folder",
    children: [],
    createdAt: Date.now(),
  };
}

async function getFileSystem(env) {
  if (!env.VAULT_KV) {
    throw new Error("VAULT_KV not configured");
  }

  try {
    const raw = await env.VAULT_KV.get("fs:tree");
    if (!raw) {
      const root = createRootFolder();
      await env.VAULT_KV.put("fs:tree", JSON.stringify(root));
      return root;
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error("Error reading FS:", err);
    return createRootFolder();
  }
}

async function saveFileSystem(env, tree) {
  if (!env.VAULT_KV) {
    throw new Error("VAULT_KV not configured");
  }
  await env.VAULT_KV.put("fs:tree", JSON.stringify(tree));
}

function findNodeById(tree, id) {
  if (!tree || !id) return null;
  if (tree.id === id) return tree;

  if (Array.isArray(tree.children)) {
    for (const child of tree.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }

  return null;
}

function findParentNode(tree, targetId) {
  if (!tree || !targetId) return null;

  if (Array.isArray(tree.children)) {
    for (const child of tree.children) {
      if (child.id === targetId) {
        return tree;
      }
      const found = findParentNode(child, targetId);
      if (found) return found;
    }
  }

  return null;
}

function collectAllFileIds(node, ids = []) {
  if (!node) return ids;

  if (node.type === "file" && node.id) {
    ids.push(node.id);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectAllFileIds(child, ids);
    }
  }

  return ids;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function healthCheck(request, env) {
  const checks = {
    worker: true,
    kv: false,
    telegram: false,
  };

  // Check KV
  try {
    if (env.VAULT_KV) {
      await env.VAULT_KV.get("health_check_test");
      checks.kv = true;
    }
  } catch (_) {}

  // Check Telegram
  try {
    if (env.BOT_TOKEN) {
      const res = await telegramAPI(env, "getMe", {});
      checks.telegram = !!res?.result?.id;
    }
  } catch (_) {}

  return jsonResponse({
    ok: true,
    checks,
    timestamp: Date.now(),
  });
}

async function initFS(request, env) {
  const tree = await getFileSystem(env);
  return jsonResponse({
    ok: true,
    message: "File system initialized",
    root: tree,
  });
}

// ─── UPLOAD CHUNK ───
async function uploadChunk(request, env) {
  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    return jsonResponse({ error: "Invalid form data: " + err.message }, 400);
  }

  const chunk = formData.get("chunk");
  const indexStr = formData.get("index");
  const filename = formData.get("filename");
  const expectedHash = formData.get("hash");
  const uploadId = formData.get("uploadId");

  // Validate inputs
  if (!chunk) {
    return jsonResponse({ error: "Missing chunk" }, 400);
  }

  const index = parseInt(indexStr, 10);
  if (isNaN(index) || index < 0) {
    return jsonResponse({ error: "Invalid chunk index" }, 400);
  }

  const safeName = sanitizeFilename(filename);

  // Get chunk data
  let chunkBuffer;
  try {
    if (chunk instanceof Blob || (chunk && typeof chunk.arrayBuffer === "function")) {
      chunkBuffer = await chunk.arrayBuffer();
    } else {
      return jsonResponse({ error: "Invalid chunk type" }, 400);
    }
  } catch (err) {
    return jsonResponse({ error: "Failed to read chunk: " + err.message }, 400);
  }

  // Validate chunk size
  if (chunkBuffer.byteLength > MAX_CHUNK_SIZE) {
    return jsonResponse({ error: `Chunk too large. Max: ${MAX_CHUNK_SIZE} bytes` }, 400);
  }

  if (chunkBuffer.byteLength === 0) {
    return jsonResponse({ error: "Empty chunk" }, 400);
  }

  // Compute hash
  const computedHash = await computeSHA256(chunkBuffer);

  // Verify hash if provided
  if (expectedHash && computedHash !== expectedHash) {
    return jsonResponse(
      {
        error: "Hash mismatch",
        expected: expectedHash,
        computed: computedHash,
      },
      400
    );
  }

  // Prepare Telegram upload
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    return jsonResponse({ error: "TELEGRAM_CHAT_ID not configured" }, 500);
  }

  const formDataTG = new FormData();
  formDataTG.append("chat_id", chatId);
  formDataTG.append(
    "document",
    new Blob([chunkBuffer], { type: "application/octet-stream" }),
    `${safeName}.part${index}`
  );
  formDataTG.append("disable_content_type_detection", "true");

  // Add caption with metadata
  const caption = JSON.stringify({
    uploadId: uploadId || "unknown",
    index,
    filename: safeName,
    hash: computedHash,
    size: chunkBuffer.byteLength,
    timestamp: Date.now(),
  }).slice(0, 1024);
  formDataTG.append("caption", caption);

  // Upload to Telegram
  let tgResponse;
  try {
    tgResponse = await telegramAPI(env, "sendDocument", formDataTG, true);
  } catch (err) {
    return jsonResponse({ error: "Telegram upload failed: " + err.message }, 502);
  }

  const document = tgResponse?.result?.document;
  if (!document?.file_id) {
    return jsonResponse(
      { error: "Telegram did not return file_id", response: tgResponse },
      500
    );
  }

  return jsonResponse({
    ok: true,
    index,
    file_id: document.file_id,
    file_unique_id: document.file_unique_id,
    hash: computedHash,
    size: document.file_size || chunkBuffer.byteLength,
  });
}

// ─── GET CHUNK (STREAM) ───
async function getChunk(request, env, url) {
  const fileId = url.searchParams.get("file_id");

  if (!fileId) {
    return jsonResponse({ error: "Missing file_id parameter" }, 400);
  }

  if (!isValidFileId(fileId)) {
    return jsonResponse({ error: "Invalid file_id format" }, 400);
  }

  // Get file path from Telegram
  let fileData;
  try {
    fileData = await telegramAPI(env, "getFile", { file_id: fileId });
  } catch (err) {
    return jsonResponse({ error: "Failed to get file info: " + err.message }, 502);
  }

  const filePath = fileData?.result?.file_path;
  if (!filePath) {
    return jsonResponse({ error: "Telegram did not return file_path" }, 500);
  }

  // Security check
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return jsonResponse({ error: "Invalid file path" }, 400);
  }

  // Stream file from Telegram
  const downloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;

  let upstream;
  try {
    upstream = await fetchWithRetry(downloadUrl);
  } catch (err) {
    return jsonResponse({ error: "Failed to fetch from Telegram: " + err.message }, 502);
  }

  if (!upstream.ok) {
    return jsonResponse(
      { error: `Telegram returned ${upstream.status}` },
      upstream.status >= 500 ? 502 : upstream.status
    );
  }

  return streamResponse(
    upstream.body,
    upstream.headers.get("Content-Type"),
    upstream.headers.get("Content-Length")
  );
}

// ─── SAVE METADATA ───
async function saveMeta(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "Invalid JSON: " + err.message }, 400);
  }

  const id = body.id || crypto.randomUUID();
  const parentId = body.parentId || "root";
  const filename = sanitizeFilename(body.filename);

  // Validate required fields
  if (!body.chunks || !Array.isArray(body.chunks)) {
    return jsonResponse({ error: "Missing or invalid chunks array" }, 400);
  }

  if (body.chunks.length === 0) {
    return jsonResponse({ error: "Chunks array is empty" }, 400);
  }

  // Validate each chunk has required fields
  for (let i = 0; i < body.chunks.length; i++) {
    const chunk = body.chunks[i];
    if (!chunk.file_id) {
      return jsonResponse({ error: `Chunk ${i} missing file_id` }, 400);
    }
  }

  const metadata = {
    id,
    type: "file",
    name: filename,
    size: Number(body.size) || 0,
    chunkSize: Number(body.chunkSize) || MAX_CHUNK_SIZE,
    chunkCount: Number(body.chunkCount) || body.chunks.length,
    chunks: body.chunks.map((c, i) => ({
      index: c.index ?? i,
      file_id: c.file_id,
      hash: c.hash || null,
      size: c.size || 0,
    })),
    mimeType: body.mimeType || "application/octet-stream",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
  };

  // Save metadata to KV
  try {
    await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(metadata));
  } catch (err) {
    return jsonResponse({ error: "Failed to save metadata: " + err.message }, 500);
  }

  // Update file system tree
  try {
    const tree = await getFileSystem(env);
    const parent = findNodeById(tree, parentId);

    if (!parent) {
      return jsonResponse({ error: "Parent folder not found: " + parentId }, 400);
    }

    if (parent.type !== "folder") {
      return jsonResponse({ error: "Parent is not a folder" }, 400);
    }

    // Remove existing entry with same ID if any
    parent.children = parent.children.filter((c) => c.id !== id);

    // Add new entry
    parent.children.push({
      id,
      type: "file",
      name: filename,
      size: metadata.size,
      mimeType: metadata.mimeType,
      createdAt: metadata.createdAt,
    });

    await saveFileSystem(env, tree);
  } catch (err) {
    return jsonResponse({ error: "Failed to update file system: " + err.message }, 500);
  }

  return jsonResponse({
    ok: true,
    id,
    metadata,
  });
}

// ─── GET METADATA ───
async function getMeta(request, env, url) {
  const id = url.searchParams.get("id");

  if (!id) {
    return jsonResponse({ error: "Missing id parameter" }, 400);
  }

  try {
    const raw = await env.VAULT_KV.get(`meta:${id}`);
    if (!raw) {
      return jsonResponse({ error: "Metadata not found" }, 404);
    }

    const metadata = JSON.parse(raw);
    return jsonResponse(metadata);
  } catch (err) {
    return jsonResponse({ error: "Failed to get metadata: " + err.message }, 500);
  }
}

// ─── LIST FILES ───
async function listFiles(request, env, url) {
  const folderId = url.searchParams.get("folder") || "root";

  try {
    const tree = await getFileSystem(env);
    const folder = findNodeById(tree, folderId);

    if (!folder) {
      return jsonResponse({ error: "Folder not found: " + folderId }, 404);
    }

    if (folder.type !== "folder") {
      return jsonResponse({ error: "Not a folder" }, 400);
    }

    return jsonResponse({
      ok: true,
      folder: {
        id: folder.id,
        name: folder.name,
        type: folder.type,
        children: folder.children || [],
        createdAt: folder.createdAt,
      },
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to list files: " + err.message }, 500);
  }
}

// ─── DELETE FILE/FOLDER ───
async function deleteFile(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "Invalid JSON: " + err.message }, 400);
  }

  const id = body.id;
  if (!id) {
    return jsonResponse({ error: "Missing id" }, 400);
  }

  if (id === "root") {
    return jsonResponse({ error: "Cannot delete root folder" }, 400);
  }

  try {
    const tree = await getFileSystem(env);
    const node = findNodeById(tree, id);

    if (!node) {
      return jsonResponse({ error: "Item not found" }, 404);
    }

    // Collect all file IDs to delete (for recursive folder deletion)
    const fileIds = collectAllFileIds(node);

    // Include the node itself if it's a file
    if (node.type === "file") {
      fileIds.push(id);
    }

    // Delete metadata for all files
    for (const fileId of fileIds) {
      try {
        await env.VAULT_KV.delete(`meta:${fileId}`);
      } catch (_) {
        // Continue even if some deletions fail
      }
    }

    // Remove from parent
    const parent = findParentNode(tree, id);
    if (parent) {
      parent.children = parent.children.filter((c) => c.id !== id);
      await saveFileSystem(env, tree);
    }

    return jsonResponse({
      ok: true,
      deleted: id,
      filesDeleted: fileIds.length,
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to delete: " + err.message }, 500);
  }
}

// ─── RENAME FILE/FOLDER ───
async function renameFile(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "Invalid JSON: " + err.message }, 400);
  }

  const id = body.id;
  const newName = sanitizeFilename(body.name);

  if (!id) {
    return jsonResponse({ error: "Missing id" }, 400);
  }

  if (!newName || newName === "file") {
    return jsonResponse({ error: "Invalid name" }, 400);
  }

  if (id === "root") {
    return jsonResponse({ error: "Cannot rename root folder" }, 400);
  }

  try {
    const tree = await getFileSystem(env);
    const node = findNodeById(tree, id);

    if (!node) {
      return jsonResponse({ error: "Item not found" }, 404);
    }

    // Update node name
    node.name = newName;
    await saveFileSystem(env, tree);

    // Also update metadata if it's a file
    if (node.type === "file") {
      const raw = await env.VAULT_KV.get(`meta:${id}`);
      if (raw) {
        const metadata = JSON.parse(raw);
        metadata.name = newName;
        metadata.modifiedAt = Date.now();
        await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(metadata));
      }
    }

    return jsonResponse({
      ok: true,
      id,
      name: newName,
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to rename: " + err.message }, 500);
  }
}

// ─── CREATE FOLDER ───
async function mkdir(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "Invalid JSON: " + err.message }, 400);
  }

  const parentId = body.parentId || "root";
  const name = sanitizeFilename(body.name);

  if (!name || name === "file") {
    return jsonResponse({ error: "Invalid folder name" }, 400);
  }

  try {
    const tree = await getFileSystem(env);
    const parent = findNodeById(tree, parentId);

    if (!parent) {
      return jsonResponse({ error: "Parent folder not found" }, 404);
    }

    if (parent.type !== "folder") {
      return jsonResponse({ error: "Parent is not a folder" }, 400);
    }

    // Check for duplicate name
    const existing = parent.children.find(
      (c) => c.name.toLowerCase() === name.toLowerCase() && c.type === "folder"
    );
    if (existing) {
      return jsonResponse({ error: "Folder with this name already exists" }, 409);
    }

    const newFolder = {
      id: crypto.randomUUID(),
      type: "folder",
      name,
      children: [],
      createdAt: Date.now(),
    };

    parent.children.push(newFolder);
    await saveFileSystem(env, tree);

    return jsonResponse({
      ok: true,
      folder: newFolder,
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to create folder: " + err.message }, 500);
  }
}

// ─── MOVE FILE/FOLDER ───
async function moveFile(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "Invalid JSON: " + err.message }, 400);
  }

  const id = body.id;
  const targetId = body.targetId || "root";

  if (!id) {
    return jsonResponse({ error: "Missing id" }, 400);
  }

  if (id === "root") {
    return jsonResponse({ error: "Cannot move root folder" }, 400);
  }

  if (id === targetId) {
    return jsonResponse({ error: "Cannot move item into itself" }, 400);
  }

  try {
    const tree = await getFileSystem(env);

    const node = findNodeById(tree, id);
    if (!node) {
      return jsonResponse({ error: "Item not found" }, 404);
    }

    const target = findNodeById(tree, targetId);
    if (!target) {
      return jsonResponse({ error: "Target folder not found" }, 404);
    }

    if (target.type !== "folder") {
      return jsonResponse({ error: "Target is not a folder" }, 400);
    }

    // Check if trying to move a folder into its descendant
    if (node.type === "folder" && findNodeById(node, targetId)) {
      return jsonResponse({ error: "Cannot move folder into its own descendant" }, 400);
    }

    const parent = findParentNode(tree, id);
    if (!parent) {
      return jsonResponse({ error: "Could not find parent" }, 500);
    }

    // Remove from current parent
    parent.children = parent.children.filter((c) => c.id !== id);

    // Add to target
    target.children.push(node);

    await saveFileSystem(env, tree);

    return jsonResponse({
      ok: true,
      id,
      movedTo: targetId,
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to move: " + err.message }, 500);
  }
}

// ─── REMOTE UPLOAD ───
async function remoteUpload(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "Invalid JSON: " + err.message }, 400);
  }

  const fileUrl = body.url;
  const filename = sanitizeFilename(body.filename || "remote_file.bin");
  const uploadId = body.uploadId || crypto.randomUUID();
  const parentId = body.parentId || "root";
  const chunkSize = Math.min(
    Math.max(Number(body.chunkSize) || MAX_CHUNK_SIZE, 1024 * 1024),
    MAX_CHUNK_SIZE
  );

  // Validate URL
  if (!fileUrl || typeof fileUrl !== "string") {
    return jsonResponse({ error: "Missing url" }, 400);
  }

  if (!/^https?:\/\//i.test(fileUrl)) {
    return jsonResponse({ error: "Invalid URL protocol (must be http or https)" }, 400);
  }

  // Verify parent exists
  const tree = await getFileSystem(env);
  const parent = findNodeById(tree, parentId);
  if (!parent || parent.type !== "folder") {
    return jsonResponse({ error: "Parent folder not found" }, 400);
  }

  // Fetch remote file
  let remoteResponse;
  try {
    remoteResponse = await fetchWithRetry(fileUrl, {
      headers: {
        "User-Agent": "TelegramCloudVault/1.0",
      },
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to fetch remote file: " + err.message }, 502);
  }

  if (!remoteResponse.ok) {
    return jsonResponse(
      { error: `Remote server returned ${remoteResponse.status}` },
      502
    );
  }

  if (!remoteResponse.body) {
    return jsonResponse({ error: "Remote file has no body" }, 502);
  }

  // Check content length if available
  const contentLength = parseInt(remoteResponse.headers.get("Content-Length") || "0", 10);
  if (contentLength > MAX_FILE_SIZE) {
    return jsonResponse(
      { error: `File too large. Max: ${MAX_FILE_SIZE} bytes` },
      400
    );
  }

  const chatId = env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    return jsonResponse({ error: "TELEGRAM_CHAT_ID not configured" }, 500);
  }

  // Stream and chunk the file
  const reader = remoteResponse.body.getReader();
  let buffer = new Uint8Array(0);
  let chunkIndex = 0;
  const chunks = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        const newBuffer = new Uint8Array(buffer.length + value.length);
        newBuffer.set(buffer);
        newBuffer.set(value, buffer.length);
        buffer = newBuffer;
        totalSize += value.length;

        // Check total size limit
        if (totalSize > MAX_FILE_SIZE) {
          throw new Error(`File exceeds maximum size of ${MAX_FILE_SIZE} bytes`);
        }
      }

      // Process complete chunks
      while (buffer.length >= chunkSize) {
        const chunkData = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);

        const hash = await computeSHA256(chunkData);

        const formData = new FormData();
        formData.append("chat_id", chatId);
        formData.append(
          "document",
          new Blob([chunkData], { type: "application/octet-stream" }),
          `${filename}.part${chunkIndex}`
        );
        formData.append("disable_content_type_detection", "true");

        const tgResponse = await telegramAPI(env, "sendDocument", formData, true);
        const doc = tgResponse?.result?.document;

        if (!doc?.file_id) {
          throw new Error("Telegram did not return file_id for chunk " + chunkIndex);
        }

        chunks.push({
          index: chunkIndex,
          file_id: doc.file_id,
          hash,
          size: chunkData.length,
        });

        chunkIndex++;
      }

      if (done) break;
    }

    // Upload remaining buffer
    if (buffer.length > 0) {
      const hash = await computeSHA256(buffer);

      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append(
        "document",
        new Blob([buffer], { type: "application/octet-stream" }),
        `${filename}.part${chunkIndex}`
      );
      formData.append("disable_content_type_detection", "true");

      const tgResponse = await telegramAPI(env, "sendDocument", formData, true);
      const doc = tgResponse?.result?.document;

      if (!doc?.file_id) {
        throw new Error("Telegram did not return file_id for final chunk");
      }

      chunks.push({
        index: chunkIndex,
        file_id: doc.file_id,
        hash,
        size: buffer.length,
      });
    }
  } catch (err) {
    return jsonResponse({ error: "Remote upload failed: " + err.message }, 500);
  }

  // Create metadata
  const metadata = {
    id: uploadId,
    type: "file",
    name: filename,
    size: totalSize,
    chunkSize,
    chunkCount: chunks.length,
    chunks,
    mimeType: remoteResponse.headers.get("Content-Type") || "application/octet-stream",
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    source: "remote_upload",
    sourceUrl: fileUrl,
  };

  // Save metadata
  await env.VAULT_KV.put(`meta:${uploadId}`, JSON.stringify(metadata));

  // Update file system
  const updatedTree = await getFileSystem(env);
  const parentFolder = findNodeById(updatedTree, parentId);
  if (parentFolder && parentFolder.type === "folder") {
    parentFolder.children = parentFolder.children.filter((c) => c.id !== uploadId);
    parentFolder.children.push({
      id: uploadId,
      type: "file",
      name: filename,
      size: totalSize,
      mimeType: metadata.mimeType,
      createdAt: metadata.createdAt,
    });
    await saveFileSystem(env, updatedTree);
  }

  return jsonResponse({
    ok: true,
    id: uploadId,
    metadata,
  });
}
