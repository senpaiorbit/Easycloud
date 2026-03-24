export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return handleCors();
      }

      if (path === "/upload_chunk" && request.method === "POST") {
        return await uploadChunk(request, env);
      }

      if (path === "/get_chunk" && request.method === "GET") {
        return await getChunk(request, env);
      }

      if (path === "/get_file_url" && request.method === "GET") {
        return await getFileUrl(request, env);
      }

      if (path === "/remote_upload" && request.method === "POST") {
        return await remoteUpload(request, env);
      }

      if (path === "/save_metadata" && request.method === "POST") {
        return await saveMetadata(request, env);
      }

      if (path === "/metadata" && request.method === "GET") {
        return await getMetadata(request, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({
        error: "Internal error",
        message: err?.message || String(err)
      }, 500);
    }
  }
};

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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function sanitizeFilename(name) {
  return (name || "file")
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\.\./g, "_")
    .slice(0, 180);
}

function validateFileId(fileId) {
  // Telegram file_id can contain letters, numbers, _ and -
  return typeof fileId === "string" && /^[A-Za-z0-9_\-]+$/.test(fileId);
}

async function sha256Hex(buffer) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function uploadChunk(request, env) {
  const form = await request.formData();
  const chunk = form.get("chunk");
  const index = form.get("index");
  const fileName = sanitizeFilename(form.get("filename"));
  const expectedHash = form.get("hash");
  const uploadId = form.get("uploadId");

  if (!chunk || !(chunk instanceof File)) {
    return json({ error: "Missing chunk file" }, 400);
  }

  const arrBuf = await chunk.arrayBuffer();
  const actualHash = await sha256Hex(arrBuf);

  if (expectedHash && actualHash !== expectedHash) {
    return json({ error: "SHA-256 mismatch before Telegram upload" }, 400);
  }

  const tgForm = new FormData();
  tgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
  tgForm.append("document", new Blob([arrBuf]), `${fileName}.part${index}`);
  tgForm.append("disable_content_type_detection", "true");
  tgForm.append("caption", JSON.stringify({
    uploadId,
    index: Number(index),
    originalName: fileName,
    hash: actualHash
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

async function getFileUrl(request, env) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("file_id");

  if (!validateFileId(fileId)) {
    return json({ error: "Invalid file_id" }, 400);
  }

  const res = await telegramApi(env, "getFile", { file_id: fileId });

  const filePath = res?.result?.file_path;
  if (!filePath) {
    return json({ error: "Unable to resolve file_path" }, 500);
  }

  const directUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  return json({
    ok: true,
    file_path: filePath,
    url: directUrl
  });
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

async function getChunk(request, env) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("file_id");

  if (!validateFileId(fileId)) {
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

  return new Response(upstream.body, {
    status: 200,
    headers
  });
}

async function remoteUpload(request, env) {
  const body = await request.json();
  const fileUrl = body?.url;
  const fileName = sanitizeFilename(body?.filename || "remote_file.bin");
  const uploadId = body?.uploadId || crypto.randomUUID();
  const chunkSize = Math.min(Number(body?.chunkSize || 20 * 1024 * 1024), 20 * 1024 * 1024);

  if (!fileUrl || !/^https?:\/\//i.test(fileUrl)) {
    return json({ error: "Invalid remote URL" }, 400);
  }

  const remoteResp = await fetchWithRetry(fileUrl, {}, 5);
  if (!remoteResp.ok || !remoteResp.body) {
    return json({ error: "Failed to fetch remote file" }, 502);
  }

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
      tgForm.append("document", new Blob([chunkBytes]), `${fileName}.part${chunkIndex}`);
      tgForm.append("disable_content_type_detection", "true");
      tgForm.append("caption", JSON.stringify({
        uploadId,
        index: chunkIndex,
        originalName: fileName,
        hash
      }).slice(0, 1024));

      const res = await telegramApi(env, "sendDocument", tgForm, true);
      const doc = res?.result?.document;
      chunks.push({
        index: chunkIndex,
        file_id: doc.file_id,
        hash,
        size: chunkBytes.length
      });

      chunkIndex++;
    }
  }

  if (buffer.length > 0) {
    const hash = await sha256Hex(buffer.buffer);
    const tgForm = new FormData();
    tgForm.append("chat_id", env.TELEGRAM_CHAT_ID);
    tgForm.append("document", new Blob([buffer]), `${fileName}.part${chunkIndex}`);
    tgForm.append("disable_content_type_detection", "true");
    tgForm.append("caption", JSON.stringify({
      uploadId,
      index: chunkIndex,
      originalName: fileName,
      hash
    }).slice(0, 1024));

    const res = await telegramApi(env, "sendDocument", tgForm, true);
    const doc = res?.result?.document;
    chunks.push({
      index: chunkIndex,
      file_id: doc.file_id,
      hash,
      size: buffer.length
    });
  }

  const metadata = {
    id: uploadId,
    filename: fileName,
    size: totalSize,
    chunkSize,
    chunkCount: chunks.length,
    chunks,
    createdAt: Date.now(),
    source: "remote_upload"
  };

  if (env.VAULT_KV) {
    await env.VAULT_KV.put(`meta:${uploadId}`, JSON.stringify(metadata));
  }

  return json({ ok: true, metadata });
}

async function saveMetadata(request, env) {
  const body = await request.json();
  const id = body?.id || crypto.randomUUID();

  const metadata = {
    id,
    filename: sanitizeFilename(body?.filename),
    size: Number(body?.size || 0),
    chunkSize: Number(body?.chunkSize || 0),
    chunkCount: Number(body?.chunkCount || 0),
    chunks: Array.isArray(body?.chunks) ? body.chunks : [],
    createdAt: Date.now()
  };

  if (!metadata.filename || !metadata.chunkCount) {
    return json({ error: "Invalid metadata" }, 400);
  }

  if (env.VAULT_KV) {
    await env.VAULT_KV.put(`meta:${id}`, JSON.stringify(metadata));
  }

  return json({ ok: true, id, metadata });
}

async function getMetadata(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) return json({ error: "Missing id" }, 400);
  if (!env.VAULT_KV) return json({ error: "KV not configured" }, 500);

  const data = await env.VAULT_KV.get(`meta:${id}`);
  if (!data) return json({ error: "Not found" }, 404);

  return new Response(data, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}
