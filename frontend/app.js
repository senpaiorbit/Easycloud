const WORKER_URL = "https://YOUR_WORKER.workers.dev";
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const chunkSizeInput = document.getElementById("chunkSizeInput");
const concurrencyInput = document.getElementById("concurrencyInput");
const statusText = document.getElementById("statusText");
const progressText = document.getElementById("progressText");
const speedText = document.getElementById("speedText");
const etaText = document.getElementById("etaText");
const retryText = document.getElementById("retryText");
const progressBar = document.getElementById("progressBar");
const fileMeta = document.getElementById("fileMeta");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const metadataIdInput = document.getElementById("metadataIdInput");
const downloadBtn = document.getElementById("downloadBtn");
const savedList = document.getElementById("savedList");

let paused = false;
let currentUpload = null;
let totalRetries = 0;

function setStatus(s) {
  statusText.textContent = s;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeFilename(name) {
  return name.replace(/[\/\\?%*:|"<>]/g, "_").replace(/\.\./g, "_");
}

function getUploadStorageKey(uploadId) {
  return `tgv_upload_${uploadId}`;
}

function getSavedVaultIndex() {
  return JSON.parse(localStorage.getItem("tgv_saved_index") || "[]");
}

function saveVaultIndex(arr) {
  localStorage.setItem("tgv_saved_index", JSON.stringify(arr));
}

function addVaultIndex(item) {
  const arr = getSavedVaultIndex();
  const existing = arr.find(x => x.id === item.id);
  if (!existing) {
    arr.unshift(item);
    saveVaultIndex(arr);
  }
  renderSavedList();
}

function renderSavedList() {
  const arr = getSavedVaultIndex();
  savedList.innerHTML = "<h3>Saved Metadata</h3>";
  if (!arr.length) {
    savedList.innerHTML += "<div>No saved uploads yet</div>";
    return;
  }

  arr.forEach(item => {
    const div = document.createElement("div");
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <strong>${item.filename}</strong><br>
      ID: ${item.id}<br>
      Size: ${formatBytes(item.size)}<br>
      <button data-id="${item.id}" class="loadMetaBtn">Load ID</button>
    `;
    savedList.appendChild(div);
  });

  document.querySelectorAll(".loadMetaBtn").forEach(btn => {
    btn.onclick = () => {
      metadataIdInput.value = btn.dataset.id;
    };
  });
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", e => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) startUpload(file);
});
fileInput.addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) startUpload(file);
});

pauseBtn.onclick = () => {
  paused = true;
  setStatus("paused");
};

resumeBtn.onclick = async () => {
  paused = false;
  if (currentUpload?.file) {
    setStatus("resuming");
    await startUpload(currentUpload.file, currentUpload.uploadId, true);
  }
};

async function retryFetch(url, options, retries = 5) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        totalRetries++;
        retryText.textContent = totalRetries;
        await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** i)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      totalRetries++;
      retryText.textContent = totalRetries;
      await new Promise(r => setTimeout(r, Math.min(30000, 1000 * 2 ** i)));
    }
  }
  throw lastErr || new Error("retryFetch failed");
}

async function startUpload(file, existingUploadId = null, isResume = false) {
  const uploadId = existingUploadId || crypto.randomUUID();
  const chunkSize = Math.min(Number(chunkSizeInput.value || 20), 20) * 1024 * 1024;
  const concurrency = Math.min(Math.max(Number(concurrencyInput.value || 3), 1), 5);
  const totalChunks = Math.ceil(file.size / chunkSize);
  const safeName = sanitizeFilename(file.name);

  currentUpload = { file, uploadId };

  let uploadState = JSON.parse(localStorage.getItem(getUploadStorageKey(uploadId)) || "null");
  if (!uploadState) {
    uploadState = {
      id: uploadId,
      filename: safeName,
      size: file.size,
      chunkSize,
      chunkCount: totalChunks,
      chunks: Array.from({ length: totalChunks }, (_, i) => ({
        index: i,
        start: i * chunkSize,
        end: Math.min(file.size, (i + 1) * chunkSize),
        uploaded: false,
        file_id: null,
        hash: null,
        size: Math.min(chunkSize, file.size - i * chunkSize),
        error: null
      }))
    };
  }

  setStatus(isResume ? "resuming upload" : "uploading");
  fileMeta.innerHTML = `
    <strong>File:</strong> ${safeName}<br>
    <strong>Size:</strong> ${formatBytes(file.size)}<br>
    <strong>Chunks:</strong> ${totalChunks}<br>
    <strong>Upload ID:</strong> ${uploadId}
  `;

  const startedAt = Date.now();

  function saveState() {
    localStorage.setItem(getUploadStorageKey(uploadId), JSON.stringify(uploadState));
  }

  function uploadedBytes() {
    return uploadState.chunks
      .filter(c => c.uploaded)
      .reduce((sum, c) => sum + c.size, 0);
  }

  function updateProgress() {
    const done = uploadedBytes();
    const percent = (done / file.size) * 100;
    const elapsed = (Date.now() - startedAt) / 1000;
    const speed = done / Math.max(elapsed, 1);
    const eta = (file.size - done) / Math.max(speed, 1);

    progressBar.style.width = `${percent.toFixed(2)}%`;
    progressText.textContent = `${percent.toFixed(2)}% (${formatBytes(done)} / ${formatBytes(file.size)})`;
    speedText.textContent = `${(speed / 1024 / 1024).toFixed(2)} MB/s`;
    etaText.textContent = formatTime(eta);
  }

  async function uploadOneChunk(chunkMeta) {
    if (paused) return;
    if (chunkMeta.uploaded) return;

    const blob = file.slice(chunkMeta.start, chunkMeta.end);
    const hash = chunkMeta.hash || await sha256Hex(blob);
    chunkMeta.hash = hash;
    saveState();

    const form = new FormData();
    form.append("chunk", blob, `${safeName}.part${chunkMeta.index}`);
    form.append("index", String(chunkMeta.index));
    form.append("filename", safeName);
    form.append("hash", hash);
    form.append("uploadId", uploadId);

    try {
      const res = await retryFetch(`${WORKER_URL}/upload_chunk`, {
        method: "POST",
        body: form
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt);
      }

      const data = await res.json();
      chunkMeta.uploaded = true;
      chunkMeta.file_id = data.file_id;
      chunkMeta.hash = data.hash || hash;
      chunkMeta.error = null;
      saveState();
      updateProgress();
    } catch (err) {
      chunkMeta.error = err.message || String(err);
      saveState();
      throw err;
    }
  }

  const queue = uploadState.chunks.filter(c => !c.uploaded);
  let pointer = 0;

  async function workerLoop() {
    while (pointer < queue.length) {
      if (paused) return;
      const i = pointer++;
      const chunkMeta = queue[i];
      try {
        await uploadOneChunk(chunkMeta);
      } catch (_) {
        // failed chunk stays not uploaded, retry later
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => workerLoop());
  await Promise.all(workers);

  updateProgress();

  const incomplete = uploadState.chunks.filter(c => !c.uploaded);
  if (incomplete.length > 0) {
    setStatus(paused ? "paused" : "error");
    return;
  }

  const metadata = {
    id: uploadId,
    filename: safeName,
    size: file.size,
    chunkSize,
    chunkCount: totalChunks,
    chunks: uploadState.chunks.map(c => ({
      index: c.index,
      file_id: c.file_id,
      hash: c.hash,
      size: c.size
    }))
  };

  localStorage.setItem(`tgv_meta_${uploadId}`, JSON.stringify(metadata));

  try {
    const res = await retryFetch(`${WORKER_URL}/save_metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata)
    });
    if (!res.ok) throw new Error("save_metadata failed");
  } catch (_) {
    // localStorage fallback already saved
  }

  addVaultIndex({
    id: uploadId,
    filename: safeName,
    size: file.size
  });

  setStatus("done");
}

downloadBtn.onclick = async () => {
  const id = metadataIdInput.value.trim();
  if (!id) return alert("Enter metadata ID");

  setStatus("fetching metadata");

  let metadata = null;

  try {
    const res = await retryFetch(`${WORKER_URL}/metadata?id=${encodeURIComponent(id)}`, {
      method: "GET"
    }, 4);

    if (res.ok) {
      metadata = await res.json();
    }
  } catch (_) {}

  if (!metadata) {
    metadata = JSON.parse(localStorage.getItem(`tgv_meta_${id}`) || "null");
  }

  if (!metadata) {
    alert("Metadata not found in KV or localStorage");
    setStatus("error");
    return;
  }

  try {
    await downloadFile(metadata);
  } catch (err) {
    console.error(err);
    setStatus("error");
    alert(`Download failed: ${err.message}`);
  }
};

async function downloadFile(metadata) {
  const concurrency = Math.min(Math.max(Number(concurrencyInput.value || 3), 1), 5);
  const totalSize = metadata.size;
  const chunks = metadata.chunks.slice().sort((a, b) => a.index - b.index);
  const out = new Array(chunks.length);
  let downloadedBytes = 0;
  let pointer = 0;
  const startedAt = Date.now();

  setStatus("downloading");

  function updateDownloadProgress() {
    const percent = (downloadedBytes / totalSize) * 100;
    const elapsed = (Date.now() - startedAt) / 1000;
    const speed = downloadedBytes / Math.max(elapsed, 1);
    const eta = (totalSize - downloadedBytes) / Math.max(speed, 1);

    progressBar.style.width = `${percent.toFixed(2)}%`;
    progressText.textContent = `${percent.toFixed(2)}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalSize)})`;
    speedText.textContent = `${(speed / 1024 / 1024).toFixed(2)} MB/s`;
    etaText.textContent = formatTime(eta);
  }

  async function fetchChunk(chunk) {
    const res = await retryFetch(`${WORKER_URL}/get_chunk?file_id=${encodeURIComponent(chunk.file_id)}`, {
      method: "GET"
    }, 5);

    if (!res.ok) {
      throw new Error(`Chunk ${chunk.index} failed with ${res.status}`);
    }

    const blob = await res.blob();
    const hash = await sha256Hex(blob);

    if (hash !== chunk.hash) {
      throw new Error(`SHA mismatch on chunk ${chunk.index}`);
    }

    out[chunk.index] = blob;
    downloadedBytes += blob.size;
    updateDownloadProgress();
  }

  async function workerLoop() {
    while (pointer < chunks.length) {
      const i = pointer++;
      await fetchChunk(chunks[i]);
    }
  }

  const workers = Array.from({ length: concurrency }, () => workerLoop());
  await Promise.all(workers);

  setStatus("reassembling");
  const finalBlob = new Blob(out, { type: "application/octet-stream" });
  const url = URL.createObjectURL(finalBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = metadata.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setStatus("done");
}

renderSavedList();
