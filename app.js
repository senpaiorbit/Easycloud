// ==================== CONFIGURATION ====================
let WORKER_URL = localStorage.getItem('easycloudWorkerUrl') || '';

// Dynamically detect Worker URL if not set
if (!WORKER_URL) {
    const scriptPath = document.currentScript?.src || window.location.href;
    WORKER_URL = scriptPath.replace(/\/[^\/]*$/, '').replace(/\/(js|scripts).*$/, '');
}

// Fallback to current origin
if (!WORKER_URL || WORKER_URL === window.location.origin) {
    const pathParts = window.location.pathname.split('/');
    if (pathParts.length > 1 && pathParts[1]) {
        WORKER_URL = window.location.origin;
    }
}

localStorage.setItem('easycloudWorkerUrl', WORKER_URL);

// Remove trailing slash
WORKER_URL = WORKER_URL.replace(/\/$/, '');

console.log('Easy Cloud - Worker URL:', WORKER_URL);

// ==================== CONSTANTS ====================
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_RETRIES = 5;

// ==================== STATE ====================
let uploadQueue = [];
let uploadingFiles = {};
let files = [];

// Initialize from localStorage
loadFilesFromStorage();
resumeUploads();

// ==================== DOM ELEMENTS ====================
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadQueueContainer = document.getElementById('uploadQueue');
const filesGrid = document.getElementById('filesGrid');
const emptyState = document.getElementById('emptyState');
const storageInfo = document.getElementById('storageInfo');
const totalFiles = document.getElementById('totalFiles');
const sortSelect = document.getElementById('sortSelect');

// Modal elements
const downloadModal = document.getElementById('downloadModal');
const downloadProgress = document.getElementById('downloadProgress');
const downloadPercent = document.getElementById('downloadPercent');
const downloadSpeed = document.getElementById('downloadSpeed');
const downloadETA = document.getElementById('downloadETA');
const chunkStatus = document.getElementById('chunkStatus');

// Settings elements
const workerUrlInput = document.getElementById('workerUrlInput');
const saveWorkerUrlBtn = document.getElementById('saveWorkerUrlBtn');
const sidebar = document.getElementById('sidebar');

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    updateUI();
    addEventListeners();
});

function addEventListeners() {
    // Drag and drop
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
    
    // File input
    fileInput.addEventListener('change', handleFileSelect);
    
    // Click to upload
    dropZone.addEventListener('click', () => fileInput.click());
    
    // Sort
    sortSelect.addEventListener('change', () => {
        sortFiles(sortSelect.value);
        renderFiles();
    });
    
    // Download modal
    document.querySelectorAll('[data-bs-dismiss="modal"]').forEach(btn => {
        btn.addEventListener('click', () => {
            downloading = false;
        });
    });
    
    // Save Worker URL
    saveWorkerUrlBtn.addEventListener('click', saveWorkerUrl);
    
    // Remote upload
    document.getElementById('remoteUploadBtn').addEventListener('click', handleRemoteUpload);
}

// ==================== DRAG AND DROP ====================
function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        addFilesToQueue(Array.from(files));
    }
}

function handleFileSelect(e) {
    const files = e.target.files;
    if (files.length > 0) {
        addFilesToQueue(Array.from(files));
    }
    // Reset input
    e.target.value = '';
}

// ==================== FILE QUEUING ====================
function addFilesToQueue(fileList) {
    fileList.forEach(file => {
        const fileId = generateId();
        const fileSize = file.size;
        const needsChunking = fileSize > CHUNK_SIZE;
        
        const queueFile = {
            id: fileId,
            file: file,
            name: file.name,
            size: fileSize,
            type: file.type,
            mode: needsChunking ? 'chunked' : 'direct',
            status: 'pending',
            progress: 0,
            uploadedBytes: 0,
            chunks: [],
            chunkCount: needsChunking ? Math.ceil(fileSize / CHUNK_SIZE) : 1,
            uploadedChunks: 0,
            createdAt: Date.now()
        };
        
        uploadQueue.push(queueFile);
    });
    
    updateUploadQueue();
    processQueue();
}

function updateUploadQueue() {
    if (uploadQueue.length === 0) {
        uploadQueueContainer.innerHTML = '';
        return;
    }
    
    uploadQueueContainer.innerHTML = uploadQueue.map(qf => `
        <div class="upload-item" id="upload-${qf.id}">
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="file-name">${escapeHtml(qf.name)}</span>
                <div class="upload-actions">
                    ${qf.status === 'uploading' || qf.status === 'paused' ? `
                        <button class="btn btn-sm ${qf.status === 'paused' ? 'btn-success' : 'btn-warning'}" 
                                onclick="${qf.status === 'paused' ? 'resumeUpload' : 'pauseUpload'}('${qf.id}')">
                            <i class="bi bi-${qf.status === 'paused' ? 'play' : 'pause'}"></i>
                        </button>
                    ` : ''}
                    ${qf.status === 'error' ? `
                        <button class="btn btn-sm btn-primary" onclick="retryUpload('${qf.id}')">
                            <i class="bi bi-arrow-clockwise"></i>
                        </button>
                    ` : ''}
                    ${(qf.status === 'pending' || qf.status === 'error') ? `
                        <button class="btn btn-sm btn-danger" onclick="removeFromQueue('${qf.id}')">
                            <i class="bi bi-x"></i>
                        </button>
                    ` : ''}
                </div>
            </div>
            <div class="progress">
                <div class="progress-bar" id="progress-${qf.id}" style="width: ${qf.progress}%"></div>
            </div>
            <div class="upload-info">
                <span>${qf.status === 'uploading' ? `${formatSize(qf.uploadedBytes)} / ${formatSize(qf.size)}` : 
                       qf.status === 'completed' ? 'Completed' :
                       qf.status === 'error' ? 'Failed' :
                       qf.status === 'paused' ? 'Paused' : 'Waiting...'}</span>
                <span>${qf.progress}%</span>
            </div>
            ${qf.mode === 'chunked' ? `
                <div class="chunk-info">
                    <i class="bi bi-layers"></i> ${qf.uploadedChunks}/${qf.chunkCount} chunks
                </div>
            ` : ''}
        </div>
    `).join('');
}

// ==================== UPLOAD PROCESSING ====================
let currentUploads = 0;

async function processQueue() {
    const pending = uploadQueue.filter(f => f.status === 'pending');
    
    while (currentUploads < MAX_CONCURRENT_UPLOADS && pending.length > 0) {
        const file = pending.shift();
        await uploadFile(file);
    }
}

async function uploadFile(queueFile) {
    if (queueFile.status === 'paused') return;
    
    queueFile.status = 'uploading';
    currentUploads++;
    updateUploadQueue();
    saveState();
    
    try {
        if (queueFile.mode === 'direct') {
            await uploadDirect(queueFile);
        } else {
            await uploadChunked(queueFile);
        }
    } catch (error) {
        console.error(`Upload failed for ${queueFile.name}:`, error);
        queueFile.status = 'error';
        showToast(`Upload failed: ${queueFile.name}`, 'error');
    }
    
    currentUploads--;
    processQueue();
    updateUploadQueue();
    saveState();
}

async function uploadDirect(queueFile) {
    const reader = new FileReader();
    
    reader.onload = async (e) => {
        try {
            const bytes = e.target.result;
            const fileId = queueFile.id;
            
            const formData = new FormData();
            formData.append('file', new Blob([bytes]), queueFile.name);
            
            const response = await fetch(`${WORKER_URL}/upload`, {
                method: 'POST',
                headers: {
                    'X-File-Name': queueFile.name,
                    'X-File-Size': queueFile.size.toString(),
                    'X-File-Type': queueFile.type,
                    'X-File-Id': fileId
                },
                body: bytes
            });
            
            const result = await response.json();
            
            if (result.success) {
                queueFile.status = 'completed';
                queueFile.progress = 100;
                queueFile.shareUrl = result.shareUrl || `${WORKER_URL}/${result.shareUrl}`;
                
                // Add to files list
                files.push({
                    id: fileId,
                    name: queueFile.name,
                    size: queueFile.size,
                    type: queueFile.type,
                    mode: 'direct',
                    file_id: result.file_id,
                    uploadTime: Date.now(),
                    shareUrl: queueFile.shareUrl
                });
                
                showToast(`✓ ${queueFile.name} uploaded successfully!`);
                saveFilesToStorage();
                updateUI();
                removeFromQueue(queueFile.id);
            } else {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error) {
            console.error('Direct upload error:', error);
            queueFile.status = 'error';
            queueFile.progress = 0;
        }
        updateUploadQueue();
    };
    
    reader.onerror = () => {
        queueFile.status = 'error';
        updateUploadQueue();
    };
    
    queueFile.status = 'uploading';
    queueFile.progress = 50;
    updateUploadQueue();
    
    reader.readAsArrayBuffer(queueFile.file);
}

async function uploadChunked(queueFile) {
    const fileId = queueFile.id;
    const totalChunks = queueFile.chunkCount;
    const chunks = [];
    let uploadedChunks = 0;
    
    uploadingFiles[fileId] = {
        queueFile,
        chunks,
        cancelRequested: false
    };
    
    // Read file
    const arrayBuffer = await queueFile.file.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    
    // Upload chunks
    for (let i = 0; i < totalChunks; i++) {
        if (uploadingFiles[fileId]?.cancelRequested) {
            queueFile.status = 'paused';
            break;
        }
        
        await uploadChunk(fileId, data, i, totalChunks, queueFile, chunks);
        uploadedChunks = chunks.filter(c => c).length;
        queueFile.uploadedChunks = uploadedChunks;
        queueFile.progress = Math.round((uploadedChunks / totalChunks) * 100);
        queueFile.uploadedBytes = (uploadedChunks / totalChunks) * queueFile.size;
        
        updateUploadQueue();
        saveState();
    }
    
    // Check if paused
    if (queueFile.status === 'paused') {
        return;
    }
    
    // Complete upload - store metadata in KV
    if (chunks.filter(c => c).length === totalChunks) {
        await completeChunkedUpload(fileId, queueFile, chunks);
    } else {
        queueFile.status = 'error';
    }
    
    delete uploadingFiles[fileId];
    updateUploadQueue();
}

async function uploadChunk(fileId, data, index, totalChunks, queueFile, chunks) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, data.length);
    const chunkData = data.slice(start, end);
    
    const hash = await sha256(chunkData.buffer);
    
    // Retry logic
    let retries = 0;
    while (retries < MAX_RETRIES && !chunks[index]) {
        try {
            const response = await fetch(`${WORKER_URL}/upload_chunk`, {
                method: 'POST',
                headers: {
                    'X-File-Id': fileId,
                    'X-Chunk-Index': index.toString(),
                    'X-Total-Chunks': totalChunks.toString(),
                    'X-Chunk-Hash': hash
                },
                body: chunkData.buffer
            });
            
            const result = await response.json();
            
            if (result.success) {
                chunks[index] = {
                    file_id: result.file_id,
                    size: result.size,
                    hash: result.hash
                };
            } else {
                throw new Error(result.error || 'Chunk upload failed');
            }
        } catch (error) {
            retries++;
            if (retries < MAX_RETRIES) {
                await sleep(Math.pow(2, retries) * 1000); // Exponential backoff
            } else {
                throw error;
            }
        }
    }
    
    queueFile.uploadedChunks = chunks.filter(c => c).length;
}

async function completeChunkedUpload(fileId, queueFile, chunks) {
    try {
        const response = await fetch(`${WORKER_URL}/complete_upload`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fileId: fileId,
                name: queueFile.name,
                size: queueFile.size,
                type: queueFile.type,
                chunks: chunks
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            queueFile.status = 'completed';
            queueFile.progress = 100;
            queueFile.shareUrl = `${WORKER_URL}/${result.shareUrl}`;
            
            // Add to files list
            files.push({
                id: fileId,
                name: queueFile.name,
                size: queueFile.size,
                type: queueFile.type,
                mode: 'chunked',
                chunks: chunks,
                chunkCount: chunks.length,
                uploadTime: Date.now(),
                shareUrl: queueFile.shareUrl
            });
            
            showToast(`✓ ${queueFile.name} uploaded successfully!`);
            saveFilesToStorage();
            updateUI();
            removeFromQueue(fileId);
        } else {
            throw new Error(result.error || 'Failed to complete upload');
        }
    } catch (error) {
        console.error('Complete upload error:', error);
        queueFile.status = 'error';
    }
}

// ==================== PAUSE/RESUME/RETRY ====================
async function pauseUpload(fileId) {
    const uploadInfo = uploadingFiles[fileId];
    if (uploadInfo) {
        uploadInfo.cancelRequested = true;
        uploadInfo.queueFile.status = 'paused';
        updateUploadQueue();
        saveState();
    }
}

async function resumeUpload(fileId) {
    const queueFile = uploadQueue.find(f => f.id === fileId);
    if (queueFile && queueFile.status === 'paused') {
        queueFile.status = 'uploading';
        uploadingFiles[fileId] = {
            queueFile,
            chunks: queueFile.chunks,
            cancelRequested: false
        };
        
        // Resume from where we left off
        const uploadedChunks = queueFile.chunks.filter(c => c).length;
        
        if (queueFile.mode === 'chunked') {
            const fileData = new Uint8Array(await queueFile.file.arrayBuffer());
            for (let i = uploadedChunks; i < queueFile.chunkCount; i++) {
                if (queueFile.status === 'paused') break;
                
                await uploadChunk(fileId, fileData, i, queueFile.chunkCount, queueFile, queueFile.chunks);
                queueFile.uploadedChunks = queueFile.chunks.filter(c => c).length;
                queueFile.progress = Math.round((queueFile.uploadedChunks / queueFile.chunkCount) * 100);
                queueFile.uploadedBytes = (queueFile.uploadedChunks / queueFile.chunkCount) * queueFile.size;
                
                updateUploadQueue();
                saveState();
            }
            
            if (queueFile.chunks.filter(c => c).length === queueFile.chunkCount) {
                await completeChunkedUpload(fileId, queueFile, queueFile.chunks);
            }
        }
        
        delete uploadingFiles[fileId];
    }
    processQueue();
}

async function retryUpload(fileId) {
    const queueFile = uploadQueue.find(f => f.id === fileId);
    if (queueFile) {
        queueFile.status = 'pending';
        queueFile.progress = 0;
        queueFile.uploadedBytes = 0;
        queueFile.uploadedChunks = 0;
        queueFile.chunks = [];
        updateUploadQueue();
        processQueue();
    }
}

function removeFromQueue(fileId) {
    const index = uploadQueue.findIndex(f => f.id === fileId);
    if (index > -1) {
        uploadQueue.splice(index, 1);
        updateUploadQueue();
        saveState();
    }
}

// ==================== RESUME UPLOADS ====================
function resumeUploads() {
    const paused = uploadQueue.filter(f => f.status === 'paused' || f.status === 'uploading');
    paused.forEach(f => {
        if (f.status === 'uploading') {
            f.status = 'paused';
        }
    });
    
    if (paused.length > 0) {
        showToast(`Found ${paused.length} incomplete upload(s)`, 'info');
    }
}

// ==================== FILE MANAGEMENT ====================
function updateUI() {
    renderFiles();
    updateStorageInfo();
}

function renderFiles() {
    if (files.length === 0) {
        filesGrid.innerHTML = '';
        emptyState.style.display = 'flex';
        return;
    }
    
    emptyState.style.display = 'none';
    
    filesGrid.innerHTML = files.map(file => `
        <div class="file-card" data-id="${file.id}">
            <div class="file-preview">
                ${getPreviewContent(file)}
            </div>
            <div class="file-info">
                <h5 class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(truncateString(file.name, 30))}</h5>
                <p class="file-meta">
                    <span class="badge ${file.mode === 'direct' ? 'badge-success' : 'badge-warning'}">
                        ${file.mode === 'direct' ? 'Direct' : 'Chunked'}
                    </span>
                    <span>${formatSize(file.size)} • ${formatDate(file.uploadTime)}</span>
                </p>
            </div>
            <div class="file-actions">
                <a href="${file.shareUrl}" target="_blank" class="btn btn-sm btn-primary" title="Download/View">
                    <i class="bi bi-download"></i>
                </a>
                <button class="btn btn-sm btn-info" onclick="copyShareLink('${file.id}')" title="Copy Link">
                    <i class="bi bi-link-45deg"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="deleteFile('${file.id}')" title="Delete">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function getPreviewContent(file) {
    if (file.mode === 'direct') {
        const type = file.type;
        
        if (type.startsWith('image/')) {
            return `<img src="${WORKER_URL}/download?id=${file.id}" alt="${escapeHtml(file.name)}" loading="lazy">`;
        } else if (type.startsWith('video/')) {
            return `
                <video src="${WORKER_URL}/download?id=${file.id}" muted></video>
                <i class="bi bi-play-circle"></i>
            `;
        } else if (type.startsWith('audio/')) {
            return `
                <div class="audio-preview">
                    <i class="bi bi-music-note-beamed"></i>
                </div>
            `;
        } else {
            return getFileIcon(type, file.name);
        }
    } else {
        return getFileIcon(file.type, file.name);
    }
}

function getFileIcon(type, name) {
    if (type?.startsWith('image/')) {
        return '<i class="bi bi-file-earmark-image"></i>';
    } else if (type?.startsWith('video/')) {
        return '<i class="bi bi-file-earmark-play"></i>';
    } else if (type?.startsWith('audio/')) {
        return '<i class="bi bi-file-earmark-music"></i>';
    } else if (type?.includes('pdf')) {
        return '<i class="bi bi-file-earmark-pdf"></i>';
    } else if (type?.includes('zip') || type?.includes('rar') || type?.includes('7z')) {
        return '<i class="bi bi-file-earmark-zip"></i>';
    } else if (type?.includes('text')) {
        return '<i class="bi bi-file-earmark-text"></i>';
    } else if (type?.includes('word') || name?.endsWith('.doc') || name?.endsWith('.docx')) {
        return '<i class="bi bi-file-earmark-word"></i>';
    } else if (type?.includes('sheet') || type?.includes('excel') || name?.endsWith('.xls') || name?.endsWith('.xlsx')) {
        return '<i class="bi bi-file-earmark-excel"></i>';
    } else {
        return '<i class="bi bi-file-earmark"></i>';
    }
}

function sortFiles(sortBy) {
    switch(sortBy) {
        case 'name':
            files.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case 'date':
            files.sort((a, b) => b.uploadTime - a.uploadTime);
            break;
        case 'size':
            files.sort((a, b) => b.size - a.size);
            break;
        case 'type':
            files.sort((a, b) => a.type.localeCompare(b.type));
            break;
    }
}

// ==================== DOWNLOAD ====================
let downloading = false;
let downloadedChunks = [];
let downloadStartTime = 0;
let downloadedBytes = 0;
let currentDownloadSpeed = 0;

async function downloadFile(fileId) {
    if (downloading) return;
    
    const file = files.find(f => f.id === fileId);
    if (!file) return;
    
    // Direct files - download directly
    if (file.mode === 'direct') {
        window.location.href = `${WORKER_URL}/download?id=${fileId}&direct=1`;
        return;
    }
    
    // Chunked files - show download modal
    downloading = true;
    downloadedChunks = new Array(file.chunkCount).fill(null);
    downloadedBytes = 0;
    downloadStartTime = Date.now();
    
    const modal = new bootstrap.Modal(downloadModal);
    modal.show();
    
    resetDownloadProgress();
    downloadPercent.textContent = 'Preparing...';
    
    try {
        await downloadAllChunks(file);
        await mergeAndDownload(file);
        
        modal.hide();
        showToast('Download completed!');
    } catch (error) {
        console.error('Download failed:', error);
        showToast('Download failed: ' + error.message, 'error');
    }
    
    downloading = false;
}

async function downloadAllChunks(file) {
    const chunks = file.chunks;
    const concurrency = 4;
    let completed = 0;
    
    const downloadChunk = async (index) => {
        const maxRetries = 5;
        let retries = 0;
        
        while (retries < maxRetries) {
            try {
                updateChunkBlock(index, 'downloading');
                
                const response = await fetch(`${WORKER_URL}/get_chunk?chunk_id=${chunks[index].file_id}`);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const chunk = await response.arrayBuffer();
                downloadedChunks[index] = chunk;
                downloadedBytes += chunk.byteLength;
                
                // Verify hash
                if (chunks[index].hash) {
                    const computedHash = await sha256(chunk);
                    if (computedHash !== chunks[index].hash) {
                        throw new Error('Hash verification failed');
                    }
                }
                
                updateChunkBlock(index, 'loaded');
                completed++;
                updateDownloadProgress(completed, chunks.length, file.size);
                
                return true;
            } catch (error) {
                retries++;
                if (retries < maxRetries) {
                    await sleep(Math.pow(2, retries) * 1000);
                } else {
                    updateChunkBlock(index, 'error');
                    throw new Error(`Failed to download chunk ${index + 1}`);
                }
            }
        }
        
        return false;
    };
    
    // Download with concurrency
    for (let i = 0; i < chunks.length; i += concurrency) {
        const batch = chunks.slice(i, i + concurrency).map((_, idx) => downloadChunk(i + idx));
        await Promise.all(batch);
    }
    
    downloadPercent.textContent = 'Merging...';
}

async function mergeAndDownload(file) {
    try {
        const fileBlob = new Blob(downloadedChunks, { type: file.type });
        const url = URL.createObjectURL(fileBlob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Merge failed:', error);
        throw error;
    }
}

function resetDownloadProgress() {
    downloadProgress.style.width = '0%';
    downloadSpeed.textContent = '0 KB/s';
    downloadETA.textContent = '--:--';
    chunkStatus.innerHTML = '';
    
    // Create chunk blocks
    const file = files[0]; // Will be set properly in downloadFile
}

function updateChunkBlock(index, status) {
    const blocks = chunkStatus.querySelectorAll('.chunk-block');
    if (blocks[index]) {
        blocks[index].className = `chunk-block ${status}`;
    }
}

function updateDownloadProgress(completed, total, totalSize) {
    const percent = Math.round((completed / total) * 100);
    downloadProgress.style.width = `${percent}%`;
    downloadPercent.textContent = `${percent}%`;
    
    // Calculate speed
    const elapsed = (Date.now() - downloadStartTime) / 1000;
    if (elapsed > 0) {
        currentDownloadSpeed = downloadedBytes / elapsed;
        downloadSpeed.textContent = formatSize(currentDownloadSpeed) + '/s';
        
        // Calculate ETA
        const remainingBytes = totalSize - downloadedBytes;
        const eta = remainingBytes / currentDownloadSpeed;
        downloadETA.textContent = formatTime(eta);
    }
}

// ==================== COPY LINK ====================
function copyShareLink(fileId) {
    const file = files.find(f => f.id === fileId);
    if (file && file.shareUrl) {
        const fullUrl = file.shareUrl.startsWith('http') ? file.shareUrl : `${WORKER_URL}/${file.shareUrl}`;
        
        if (navigator.clipboard) {
            navigator.clipboard.writeText(fullUrl).then(() => {
                showToast('Link copied to clipboard!');
            }).catch(() => {
                fallbackCopy(fullUrl);
            });
        } else {
            fallbackCopy(fullUrl);
        }
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    
    try {
        document.execCommand('copy');
        showToast('Link copied to clipboard!');
    } catch (err) {
        showToast('Failed to copy link', 'error');
    }
    
    document.body.removeChild(textarea);
}

// ==================== DELETE FILE ====================
async function deleteFile(fileId) {
    if (!confirm('Are you sure you want to delete this file?')) return;
    
    const index = files.findIndex(f => f.id === fileId);
    if (index > -1) {
        try {
            await fetch(`${WORKER_URL}/delete_file`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileId })
            });
        } catch (error) {
            console.error('Delete API error:', error);
        }
        
        // Remove from local storage
        files.splice(index, 1);
        saveFilesToStorage();
        updateUI();
        showToast('File deleted');
    }
}

// ==================== REMOTE UPLOAD ====================
async function handleRemoteUpload() {
    const urlInput = document.getElementById('remoteUrlInput');
    const nameInput = document.getElementById('remoteFileName');
    
    const url = urlInput.value.trim();
    let name = nameInput.value.trim();
    
    if (!url) {
        showToast('Please enter a URL', 'error');
        return;
    }
    
    if (!name) {
        name = url.split('/').pop() || 'remote_file';
    }
    
    // Add to queue
    const fileId = generateId();
    const queueFile = {
        id: fileId,
        name: name,
        size: 0,
        type: 'application/octet-stream',
        mode: 'unknown',
        status: 'uploading',
        progress: 0,
        uploadedBytes: 0,
        chunks: [],
        chunkCount: 0,
        uploadedChunks: 0,
        createdAt: Date.now(),
        isRemote: true,
        url: url
    };
    
    uploadQueue.push(queueFile);
    updateUploadQueue();
    
    try {
        const response = await fetch(`${WORKER_URL}/remote_upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, name })
        });
        
        const result = await response.json();
        
        if (result.success) {
            queueFile.status = 'completed';
            queueFile.progress = 100;
            queueFile.shareUrl = `${WORKER_URL}/${result.shareUrl}`;
            
            // Add to files list
            files.push({
                id: result.fileId || fileId,
                name: result.fileInfo?.name || name,
                size: result.fileInfo?.size || 0,
                type: result.fileInfo?.type || 'application/octet-stream',
                mode: result.fileInfo?.mode || 'direct',
                chunks: result.fileInfo?.chunks || [],
                chunkCount: result.fileInfo?.chunkCount || 0,
                uploadTime: Date.now(),
                shareUrl: queueFile.shareUrl
            });
            
            showToast(`✓ ${name} uploaded successfully!`);
            saveFilesToStorage();
            updateUI();
            
            // Clear inputs
            urlInput.value = '';
            nameInput.value = '';
        } else {
            throw new Error(result.error || 'Remote upload failed');
        }
    } catch (error) {
        console.error('Remote upload error:', error);
        queueFile.status = 'error';
        showToast(`Remote upload failed: ${error.message}`, 'error');
    }
    
    removeFromQueue(fileId);
}

// ==================== SETTINGS ====================
function saveWorkerUrl() {
    const url = workerUrlInput.value.trim();
    if (url) {
        WORKER_URL = url.replace(/\/$/, '');
        localStorage.setItem('easycloudWorkerUrl', WORKER_URL);
        showToast('Worker URL saved!');
        
        // Close sidebar
        sidebar.classList.remove('show');
    } else {
        showToast('Please enter a valid URL', 'error');
    }
}

// ==================== STORAGE ====================
function saveFilesToStorage() {
    const filesToStore = files.map(f => ({
        id: f.id,
        name: f.name,
        size: f.size,
        type: f.type,
        mode: f.mode,
        chunks: f.chunks,
        chunkCount: f.chunkCount,
        uploadTime: f.uploadTime,
        shareUrl: f.shareUrl
    }));
    
    try {
        localStorage.setItem('easycloudFiles', JSON.stringify(filesToStore));
    } catch (error) {
        console.error('Failed to save files:', error);
    }
}

function loadFilesFromStorage() {
    try {
        const stored = localStorage.getItem('easycloudFiles');
        if (stored) {
            const parsed = JSON.parse(stored);
            files = parsed.filter(f => f.id && f.name);
        }
    } catch (error) {
        console.error('Failed to load files:', error);
        files = [];
    }
    
    // Load upload queue state
    try {
        const queueState = localStorage.getItem('easycloudUploadQueue');
        if (queueState) {
            const parsed = JSON.parse(queueState);
            uploadQueue = parsed.filter(f => f.id && f.name && f.status !== 'completed');
        }
    } catch (error) {
        console.error('Failed to load queue:', error);
    }
}

function saveState() {
    // Save queue state
    const queueToSave = uploadQueue.map(qf => ({
        id: qf.id,
        name: qf.name,
        size: qf.size,
        type: qf.type,
        mode: qf.mode,
        status: qf.status,
        progress: qf.progress,
        uploadedBytes: qf.uploadedBytes,
        chunks: qf.chunks,
        chunkCount: qf.chunkCount,
        uploadedChunks: qf.uploadedChunks,
        createdAt: qf.createdAt,
        isRemote: qf.isRemote,
        url: qf.url
    }));
    
    try {
        localStorage.setItem('easycloudUploadQueue', JSON.stringify(queueToSave));
    } catch (error) {
        console.error('Failed to save queue:', error);
    }
}

function updateStorageInfo() {
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    storageInfo.textContent = formatSize(totalSize);
    totalFiles.textContent = files.length;
}

// ==================== UTILITIES ====================
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    
    return date.toLocaleDateString();
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--:--';
    
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function truncateString(str, maxLength) {
    if (str.length <= maxLength) return str;
    
    const ext = str.split('.').pop();
    const name = str.substring(0, str.lastIndexOf('.'));
    const truncated = name.substring(0, maxLength - ext.length - 4) + '...';
    
    return truncated + '.' + ext;
}

function showToast(message, type = 'success') {
    const toastContainer = document.getElementById('toastContainer') || createToastContainer();
    
    const toast = document.createElement('div');
    toast.className = `toast show toast-${type}`;
    toast.innerHTML = `
        <div class="toast-header ${type === 'error' ? 'bg-danger' : type === 'info' ? 'bg-info' : 'bg-success'} text-white">
            <i class="bi bi-${type === 'error' ? 'exclamation-circle' : type === 'info' ? 'info-circle' : 'check-circle'}"></i>
            <strong class="me-auto ms-2">${type === 'error' ? 'Error' : type === 'info' ? 'Info' : 'Success'}</strong>
            <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast"></button>
        </div>
        <div class="toast-body">
            ${escapeHtml(message)}
        </div>
    `;
    
    toastContainer.appendChild(toast);
    
    // Auto close after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function createToastContainer() {
    const container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container position-fixed bottom-0 end-0 p-3';
    container.style.cssText = 'z-index: 9999;';
    document.body.appendChild(container);
    return container;
}

async function sha256(data) {
    const buffer = new Uint8Array(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Make functions globally accessible
window.pauseUpload = pauseUpload;
window.resumeUpload = resumeUpload;
window.retryUpload = retryUpload;
window.removeFromQueue = removeFromQueue;
window.downloadFile = downloadFile;
window.copyShareLink = copyShareLink;
window.deleteFile = deleteFile;
window.saveWorkerUrl = saveWorkerUrl;