// ==================== CONFIGURATION ====================
const TELEGRAM_BOT_TOKEN = 'YOUR_BOT_TOKEN'; // Replace with your bot token
const TELEGRAM_CHANNEL_ID = 'YOUR_CHANNEL_ID'; // Replace with your channel ID (e.g., -100xxxxxxxxxx)
const MAX_CHUNK_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_CONCURRENT_UPLOADS = 4;
const MAX_RETRIES = 5;

// KV namespace (configured in wrangler.toml)
// Use `kv` namespace binding when deploying

// ==================== CORS HEADERS ====================
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name, X-File-Size, X-File-Type',
    'Access-Control-Max-Age': '86400',
};

// ==================== TELEGRAM API ====================
async function sendDocumentToTelegram(bytes, filename, caption = '') {
    const formData = new FormData();
    formData.append('document', new Blob([bytes]), filename);
    if (caption) formData.append('caption', caption);
    formData.append('chat_id', TELEGRAM_CHANNEL_ID);

    return await retryWithBackoff(async () => {
        const response = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
            {
                method: 'POST',
                body: formData,
            }
        );

        const data = await response.json();

        if (!data.ok) {
            if (data.error_code === 429) {
                console.log(`Rate limited, retrying after ${data.parameters?.retry_after || 5}s`);
                throw new Error(`RATE_LIMIT:${data.parameters?.retry_after || 5}`);
            }
            throw new Error(`Telegram API error: ${data.description}`);
        }

        return data.result.document.file_id;
    });
}

async function getTelegramFile(fileId) {
    const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const data = await response.json();

    if (!data.ok) {
        if (data.error_code === 429) {
            throw new Error(`RATE_LIMIT:${data.parameters?.retry_after || 5}`);
        }
        throw new Error(`Telegram API error: ${data.description}`);
    }

    return data.result.file_path;
}

async function fetchTelegramFile(filePath) {
    const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to fetch file from Telegram: ${response.status}`);
    }

    return response;
}

// ==================== RETRY WITH EXPONENTIAL BACKOFF ====================
async function retryWithBackoff(fn, maxRetries = MAX_RETRIES) {
    let lastError;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (error.message?.startsWith('RATE_LIMIT:')) {
                const delay = parseInt(error.message.split(':')[1]) * 1000;
                console.log(`Rate limited, waiting ${delay}ms`);
                await sleep(delay);
                continue;
            }

            if (attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * 1000;
                console.log(`Attempt ${attempt + 1} failed, retrying after ${delay}ms`);
                await sleep(delay);
            }
        }
    }

    throw lastError;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== KV HELPERS ====================
async function storeFileInfo(kv, fileId, fileInfo) {
    await kv.put(`file:${fileId}`, JSON.stringify(fileInfo), {
        expirationTtl: 30 * 24 * 60 * 60 // 30 days
    });
}

async function getFileInfo(kv, fileId) {
    const data = await kv.get(`file:${fileId}`, { type: 'json' });
    return data;
}

async function deleteFileInfo(kv, fileId) {
    await kv.delete(`file:${fileId}`);
}

function generateFileId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 10; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ==================== VALIDATION ====================
function validateFileId(fileId) {
    if (!fileId || typeof fileId !== 'string' || fileId.length < 5 || fileId.length > 50) {
        return false;
    }
    return /^[a-zA-Z0-9_-]+$/.test(fileId);
}

function sanitizeFilename(filename) {
    if (!filename) return 'file.bin';
    // Remove path traversal and keep only safe characters
    return filename.replace(/[^\w\-\._]/g, '_').substring(0, 255);
}

// ==================== ROUTER ====================
async function handleRequest(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // Get KV binding
    const kv = env?.kv;

    try {
        // Health check
        if (path === '/health' || path === '/') {
            return new Response(JSON.stringify({ 
                status: 'ok', 
                service: 'Easy Cloud',
                timestamp: Date.now()
            }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Upload endpoint
        if (path === '/upload' && method === 'POST') {
            return await handleUpload(request, kv);
        }

        // Upload chunk endpoint
        if (path === '/upload_chunk' && method === 'POST') {
            return await handleUploadChunk(request, kv);
        }

        // Complete upload endpoint (store metadata)
        if (path === '/complete_upload' && method === 'POST') {
            return await handleCompleteUpload(request, kv);
        }

        // Get chunk endpoint
        if (path === '/get_chunk' && method === 'GET') {
            return await handleGetChunk(request);
        }

        // Get file URL endpoint
        if (path === '/get_file_url' && method === 'GET') {
            return await handleGetFileUrl(request);
        }

        // Download endpoint (stream file)
        if (path === '/download' && method === 'GET') {
            return await handleDownload(request, kv);
        }

        // Get file info endpoint
        if (path === '/get_file_info' && method === 'GET') {
            return await handleGetFileInfo(request, kv);
        }

        // Remote upload endpoint
        if (path === '/remote_upload' && method === 'POST') {
            return await handleRemoteUpload(request, kv);
        }

        // Delete file endpoint
        if (path === '/delete_file' && method === 'POST') {
            return await handleDeleteFile(request, kv);
        }

        // 404 for unknown routes
        return new Response(JSON.stringify({ 
            success: false,
            error: 'Endpoint not found'
        }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Error:', error);
        return new Response(JSON.stringify({ 
            success: false,
            error: error.message || 'Internal server error'
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// ==================== HANDLERS ====================

// Handle direct upload (≤20MB)
async function handleUpload(request, kv) {
    const filename = sanitizeFilename(request.headers.get('X-File-Name') || 'file');
    const fileSize = parseInt(request.headers.get('X-File-Size') || '0');
    const fileType = request.headers.get('X-File-Type') || 'application/octet-stream';
    const fileId = request.headers.get('X-File-Id') || generateFileId();

    if (fileSize > MAX_CHUNK_SIZE) {
        return new Response(JSON.stringify({
            success: false,
            error: 'File too large for direct upload, use chunked upload'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Read file from request body
    const bytes = await request.arrayBuffer();

    // Upload to Telegram
    const telegramFileId = await sendDocumentToTelegram(new Uint8Array(bytes), filename);

    // Generate download URL
    const shareUrl = `download.html?id=${fileId}`;

    // Store file info in KV
    const fileInfo = {
        id: fileId,
        name: filename,
        size: fileSize,
        type: fileType,
        mode: 'direct',
        file_id: telegramFileId,
        uploadTime: Date.now(),
        shareUrl: shareUrl
    };

    if (kv) {
        await storeFileInfo(kv, fileId, fileInfo);
    }

    return new Response(JSON.stringify({
        success: true,
        file_id: telegramFileId,
        fileId: fileId,
        fileInfo: fileInfo,
        shareUrl: shareUrl
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Handle chunk upload
async function handleUploadChunk(request, kv) {
    const fileId = request.headers.get('X-File-Id');
    const chunkIndex = parseInt(request.headers.get('X-Chunk-Index') || '0');
    const totalChunks = parseInt(request.headers.get('X-Total-Chunks') || '1');
    const chunkHash = request.headers.get('X-Chunk-Hash') || '';

    if (!validateFileId(fileId)) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Invalid file ID format'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Read chunk from request body
    const chunkBytes = await request.arrayBuffer();
    const chunkSize = chunkBytes.byteLength;

    // Upload chunk to Telegram
    const chunkName = `${fileId}_chunk_${chunkIndex}.bin`;
    const telegramFileId = await sendDocumentToTelegram(new Uint8Array(chunkBytes), chunkName);

    // Verify hash if provided
    if (chunkHash) {
        const computedHash = await computeHash(chunkBytes);
        if (computedHash !== chunkHash) {
            return new Response(JSON.stringify({
                success: false,
                error: 'Chunk hash verification failed'
            }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }

    return new Response(JSON.stringify({
        success: true,
        chunk_index: chunkIndex,
        file_id: telegramFileId,
        size: chunkSize,
        hash: computedHash || chunkHash
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Handle complete upload (store metadata for chunked files)
async function handleCompleteUpload(request, kv) {
    const body = await request.json();

    const fileId = body.fileId;
    const filename = sanitizeFilename(body.name || 'file');
    const fileSize = body.size || 0;
    const fileType = body.type || 'application/octet-stream';
    const chunks = body.chunks || [];

    if (!validateFileId(fileId)) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Invalid file ID format'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    if (chunks.length === 0) {
        return new Response(JSON.stringify({
            success: false,
            error: 'No chunks provided'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Generate download URL
    const shareUrl = `download.html?id=${fileId}`;

    // Store file info in KV
    const fileInfo = {
        id: fileId,
        name: filename,
        size: fileSize,
        type: fileType,
        mode: 'chunked',
        chunks: chunks,
        chunkCount: chunks.length,
        uploadTime: Date.now(),
        shareUrl: shareUrl
    };

    if (kv) {
        await storeFileInfo(kv, fileId, fileInfo);
    }

    return new Response(JSON.stringify({
        success: true,
        fileId: fileId,
        fileInfo: fileInfo,
        shareUrl: shareUrl
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Handle get chunk
async function handleGetChunk(request) {
    const url = new URL(request.url);
    const chunkId = url.searchParams.get('chunk_id');

    if (!chunkId) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Chunk ID is required'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Get file path from Telegram
    const filePath = await retryWithBackoff(() => getTelegramFile(chunkId));

    // Stream file from Telegram CDN
    const tgResponse = await fetchTelegramFile(filePath);

    // Stream response
    return new Response(tgResponse.body, {
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="chunk.bin"'
        }
    });
}

// Handle get file URL
async function handleGetFileUrl(request) {
    const url = new URL(request.url);
    const fileId = url.searchParams.get('file_id');

    if (!fileId) {
        return new Response(JSON.stringify({
            success: false,
            error: 'File ID is required'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    const filePath = await getTelegramFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    return new Response(JSON.stringify({
        success: true,
        file_path: filePath,
        file_url: fileUrl
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Handle download (stream file for direct uploads)
async function handleDownload(request, kv) {
    const url = new URL(request.url);
    const fileId = url.searchParams.get('id');
    const direct = url.searchParams.get('direct') === '1';

    if (!fileId) {
        return new Response(JSON.stringify({
            success: false,
            error: 'File ID is required'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    if (!validateFileId(fileId)) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Invalid file ID format'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Get file info from KV
    let fileInfo;
    if (kv) {
        fileInfo = await getFileInfo(kv, fileId);
    }

    if (!fileInfo || fileInfo.mode !== 'direct') {
        return new Response(JSON.stringify({
            success: false,
            error: 'File not found or not a direct upload'
        }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // For direct downloads, get file from Telegram and stream
    const telegramFileId = fileInfo.file_id;

    if (direct) {
        // Stream the file directly
        const filePath = await retryWithBackoff(() => getTelegramFile(telegramFileId));
        const tgResponse = await fetchTelegramFile(filePath);

        return new Response(tgResponse.body, {
            headers: {
                ...corsHeaders,
                'Content-Type': fileInfo.type,
                'Content-Disposition': `inline; filename="${fileInfo.name}"`,
                'Cache-Control': 'public, max-age=31536000'
            }
        });
    } else {
        // Return file info for client-side handling
        return new Response(JSON.stringify({
            success: true,
            fileInfo: fileInfo
        }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// Handle get file info
async function handleGetFileInfo(request, kv) {
    const url = new URL(request.url);
    const fileId = url.searchParams.get('id');

    if (!fileId) {
        return new Response(JSON.stringify({
            success: false,
            error: 'File ID is required'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    if (!validateFileId(fileId)) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Invalid file ID format'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Get file info from KV
    let fileInfo;
    if (kv) {
        fileInfo = await getFileInfo(kv, fileId);
    }

    if (!fileInfo) {
        return new Response(JSON.stringify({
            success: false,
            error: 'File not found or has expired'
        }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    return new Response(JSON.stringify({
        success: true,
        ...fileInfo
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// Handle remote upload (with chunking support for large files)
async function handleRemoteUpload(request, kv) {
    const body = await request.json();
    const fileUrl = body.url;
    const filename = sanitizeFilename(body.name || 'file');

    if (!fileUrl) {
        return new Response(JSON.stringify({
            success: false,
            error: 'URL is required'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    try {
        // Fetch the file
        const fileResponse = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (!fileResponse.ok) {
            return new Response(JSON.stringify({
                success: false,
                error: `Failed to fetch file: ${fileResponse.status}`
            }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // Get file size from content-length header
        const contentLength = fileResponse.headers.get('content-length');
        let fileSize = contentLength ? parseInt(contentLength) : 0;

        // Get content type
        const contentType = fileResponse.headers.get('content-type') || 'application/octet-stream';

        // Read file data
        const fileBytes = await fileResponse.arrayBuffer();
        fileSize = fileBytes.byteLength;

        // Determine if we need to chunk
        const needsChunking = fileSize > MAX_CHUNK_SIZE;

        let result;

        if (needsChunking) {
            // Chunked upload for large files
            const fileId = generateFileId();
            const chunks = [];
            const chunkDataArray = new Uint8Array(fileBytes);
            const totalChunks = Math.ceil(chunkDataArray.length / MAX_CHUNK_SIZE);

            // Upload chunks in parallel (concurrent)
            const uploadChunks = async (startIndex) => {
                for (let i = startIndex; i < totalChunks; i += MAX_CONCURRENT_UPLOADS) {
                    const promises = [];
                    const endIndex = Math.min(i + MAX_CONCURRENT_UPLOADS, totalChunks);

                    for (let j = i; j < endIndex; j++) {
                        const start = j * MAX_CHUNK_SIZE;
                        const end = Math.min(start + MAX_CHUNK_SIZE, chunkDataArray.length);
                        const chunkData = chunkDataArray.slice(start, end);

                        promises.push((async (idx, data) => {
                            const chunkName = `${fileId}_chunk_${idx}.bin`;
                            const telegramFileId = await sendDocumentToTelegram(data, chunkName);
                            
                            const hash = await computeHash(data.buffer);
                            
                            chunks[idx] = {
                                file_id: telegramFileId,
                                size: data.length,
                                hash: hash
                            };
                        })(j, chunkData));
                    }

                    await Promise.all(promises);
                }
            };

            await uploadChunks(0);

            // Store file info in KV
            const fileInfo = {
                id: fileId,
                name: filename,
                size: fileSize,
                type: contentType,
                mode: 'chunked',
                chunks: chunks,
                chunkCount: chunks.length,
                uploadTime: Date.now(),
                shareUrl: `download.html?id=${fileId}`
            };

            if (kv) {
                await storeFileInfo(kv, fileId, fileInfo);
            }

            result = {
                success: true,
                fileId: fileId,
                fileInfo: fileInfo,
                shareUrl: `download.html?id=${fileId}`
            };
        } else {
            // Direct upload for small files
            const fileId = generateFileId();
            const telegramFileId = await sendDocumentToTelegram(new Uint8Array(fileBytes), filename);

            const fileInfo = {
                id: fileId,
                name: filename,
                size: fileSize,
                type: contentType,
                mode: 'direct',
                file_id: telegramFileId,
                uploadTime: Date.now(),
                shareUrl: `download.html?id=${fileId}`
            };

            if (kv) {
                await storeFileInfo(kv, fileId, fileInfo);
            }

            result = {
                success: true,
                fileId: fileId,
                fileInfo: fileInfo,
                shareUrl: `download.html?id=${fileId}`
            };
        }

        return new Response(JSON.stringify(result), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Remote upload error:', error);
        return new Response(JSON.stringify({
            success: false,
            error: error.message || 'Remote upload failed'
        }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

// Handle delete file
async function handleDeleteFile(request, kv) {
    const body = await request.json();
    const fileId = body.fileId;

    if (!validateFileId(fileId)) {
        return new Response(JSON.stringify({
            success: false,
            error: 'Invalid file ID format'
        }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }

    // Delete from KV (metadata only, files remain in Telegram)
    if (kv) {
        await deleteFileInfo(kv, fileId);
    }

    return new Response(JSON.stringify({
        success: true,
        message: 'File metadata deleted (files remain in Telegram)'
    }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
}

// ==================== HASH HELPER ====================
async function computeHash(data) {
    // For Cloudflare Workers, we can use the Web Crypto API
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ==================== EXPORT ====================
export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    }
};