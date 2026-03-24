/**
 * Easy Cloud - Cloudflare Worker Backend
 * Telegram-based cloud storage system
 */

const TELEGRAM_BOT_TOKEN = 'YOUR_BOT_TOKEN'; // Replace with your bot token
const TELEGRAM_CHANNEL_ID = 'YOUR_CHANNEL_ID'; // Replace with your private channel ID
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_RETRIES = 3;

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Size, X-File-Type, X-File-Hash',
  'Access-Control-Max-Age': '86400',
};

// Utility functions
function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 255);
}

function isValidFileId(fileId) {
  return fileId && typeof fileId === 'string' && fileId.length > 10 && /^[A-Za-z0-9_-]+$/.test(fileId);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Telegram API functions with retry logic
async function telegramApiCall(method, body, retries = MAX_RETRIES) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      
      const data = await response.json();
      
      if (data.ok) {
        return data.result;
      }
      
      // Handle flood wait (429)
      if (data.error_code === 429 && data.parameters?.retry_after) {
        await sleep(data.parameters.retry_after * 1000);
        continue;
      }
      
      throw new Error(data.description || 'Telegram API error');
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}

// Upload document to Telegram
async function uploadToTelegram(fileName, fileData, caption = '') {
  const formData = new FormData();
  formData.append('document', fileData, fileName);
  if (caption) formData.append('caption', caption);
  
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
  
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData,
      });
      
      const data = await response.json();
      
      if (data.ok) {
        return data.result.document.file_id;
      }
      
      if (data.error_code === 429 && data.parameters?.retry_after) {
        await sleep(data.parameters.retry_after * 1000);
        continue;
      }
      
      throw new Error(data.description || 'Upload failed');
    } catch (error) {
      if (i === MAX_RETRIES - 1) throw error;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}

// Get file info from Telegram
async function getFileInfo(fileId) {
  return telegramApiCall('getFile', { file_id: fileId });
}

// Main request handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    
    try {
      // Route handling
      if (path === '/upload' && request.method === 'POST') {
        return handleUpload(request);
      }
      
      if (path === '/upload_chunk' && request.method === 'POST') {
        return handleUploadChunk(request);
      }
      
      if (path === '/get_chunk' && request.method === 'GET') {
        return handleGetChunk(request);
      }
      
      if (path === '/get_file_url' && request.method === 'GET') {
        return handleGetFileUrl(request);
      }
      
      if (path === '/remote_upload' && request.method === 'POST') {
        return handleRemoteUpload(request);
      }
      
      if (path === '/health' && request.method === 'GET') {
        return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      // 404 for unknown routes
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

// Handle direct upload (≤20MB)
async function handleUpload(request) {
  const fileName = request.headers.get('X-File-Name') || 'unnamed';
  const fileSize = parseInt(request.headers.get('X-File-Size') || '0');
  const fileType = request.headers.get('X-File-Type') || 'application/octet-stream';
  const fileHash = request.headers.get('X-File-Hash') || '';
  
  if (fileSize > CHUNK_SIZE) {
    return new Response(JSON.stringify({ error: 'File too large for direct upload. Use chunked upload.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  const sanitized = sanitizeFilename(fileName);
  const fileData = await request.arrayBuffer();
  
  // Create file from ArrayBuffer
  const blob = new Blob([fileData], { type: fileType });
  
  const caption = `${sanitized}|${fileSize}|${fileType}|${fileHash}|${Date.now()}`;
  const fileId = await uploadToTelegram(sanitized, blob, caption);
  
  return new Response(JSON.stringify({
    success: true,
    file_id: fileId,
    file_name: sanitized,
    file_size: fileSize,
    file_type: fileType,
    hash: fileHash,
    mode: 'direct'
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Handle chunk upload
async function handleUploadChunk(request) {
  const fileName = request.headers.get('X-File-Name') || 'unnamed';
  const chunkIndex = parseInt(request.headers.get('X-Chunk-Index') || '0');
  const totalChunks = parseInt(request.headers.get('X-Total-Chunks') || '1');
  const fileSize = parseInt(request.headers.get('X-File-Size') || '0');
  const fileType = request.headers.get('X-File-Type') || 'application/octet-stream';
  const chunkHash = request.headers.get('X-Chunk-Hash') || '';
  
  const sanitized = sanitizeFilename(fileName);
  const chunkData = await request.arrayBuffer();
  
  const chunkBlob = new Blob([chunkData], { type: 'application/octet-stream' });
  const chunkName = `${sanitized}.part${chunkIndex}`;
  
  const caption = `${sanitized}|${fileSize}|${fileType}|${chunkIndex}|${totalChunks}|${chunkHash}|${Date.now()}`;
  const fileId = await uploadToTelegram(chunkName, chunkBlob, caption);
  
  return new Response(JSON.stringify({
    success: true,
    file_id: fileId,
    chunk_index: chunkIndex,
    total_chunks: totalChunks,
    chunk_hash: chunkHash,
    file_name: sanitized,
    file_size: fileSize,
    file_type: fileType
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Handle get chunk - stream from Telegram
async function handleGetChunk(request) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get('file_id');
  
  if (!isValidFileId(fileId)) {
    return new Response(JSON.stringify({ error: 'Invalid file_id' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  const fileInfo = await getFileInfo(fileId);
  const telegramFileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  
  // Stream the file from Telegram
  const response = await fetch(telegramFileUrl);
  
  if (!response.ok) {
    throw new Error('Failed to fetch file from Telegram');
  }
  
  // Stream response with appropriate headers
  return new Response(response.body, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileId}.bin"`,
      'X-File-Path': fileInfo.file_path
    }
  });
}

// Handle get file URL
async function handleGetFileUrl(request) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get('file_id');
  
  if (!isValidFileId(fileId)) {
    return new Response(JSON.stringify({ error: 'Invalid file_id' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  const fileInfo = await getFileInfo(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
  
  return new Response(JSON.stringify({
    file_path: fileInfo.file_path,
    file_size: fileInfo.file_size,
    file_url: fileUrl
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// Handle remote upload
async function handleRemoteUpload(request) {
  const body = await request.json();
  const { url: fileUrl } = body;
  
  if (!fileUrl) {
    return new Response(JSON.stringify({ error: 'URL is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  
  // Fetch the remote file
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error('Failed to fetch remote file');
  }
  
  const fileSize = parseInt(response.headers.get('Content-Length') || '0');
  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
  const fileName = fileUrl.split('/').pop().split('?')[0] || 'remote_file';
  
  const fileData = await response.arrayBuffer();
  
  if (fileSize <= CHUNK_SIZE) {
    // Direct upload
    const blob = new Blob([fileData], { type: contentType });
    const caption = `${fileName}|${fileSize}|${contentType}|${Date.now()}`;
    const fileId = await uploadToTelegram(fileName, blob, caption);
    
    return new Response(JSON.stringify({
      success: true,
      file_id: fileId,
      file_name: fileName,
      file_size: fileSize,
      file_type: contentType,
      mode: 'direct'
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } else {
    // For large files, return info for client-side chunking
    return new Response(JSON.stringify({
      success: true,
      file_name: fileName,
      file_size: fileSize,
      file_type: contentType,
      mode: 'chunked',
      chunk_size: CHUNK_SIZE,
      total_chunks: Math.ceil(fileSize / CHUNK_SIZE)
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}