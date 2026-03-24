# ⚡ Easy Cloud

A modern, fast cloud storage web app using Cloudflare Workers and Telegram as storage backend.

## 📋 Features

#### Frontend (index.html)
- Bootstrap 5 dark theme with Google Drive–like layout
- Drag & drop file upload
- Smart upload system (direct ≤20MB, chunked >20MB)
- Pause / Resume uploads
- File preview (images, videos, audio)
- Shareable download links
- Toast notifications

#### Download Page (download.html)
- MEGA.nz-style download interface
- Animated loading lines
- Real-time progress with speed and ETA
- Chunk status visualization
- **Direct files** (.jpg, .png, .mp4, etc.) stream directly navegador
- Shareable URLs work anywhere

#### Backend (worker.js)
- Single Cloudflare Worker
- KV storage for file metadata
- Telegram Bot API integration
- Chunked upload/download with SHA-256 verification
- Automatic retry with exponential backoff
- Streaming responses (no buffering)

#### Smart Upload System
- **≤20MB**: Direct upload with SHA-256 hash
- **>20MB**: Split into 20MB chunks, parallel upload (4 concurrent)
- Retry failed chunks with exponential backoff
- Resume after page refresh (localStorage)
- Remote upload support (now with chunking for large files!)

#### Preview System
- **Images**: Thumbnail preview
- **Videos**: Playable preview  
- **Audio**: Inline player
- **Chunked files**: File icons (download required)

#### Download System
- Direct files: Stream directly from Telegram CDN
- Chunked files: Parallel fetch, verify hashes, merge in browser
- Progress: %, speed, ETA
- Auto-download after merge

## 🚀 Setup

### 1. Create a Telegram Bot
1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow instructions
3. Copy your **BOT_TOKEN**
4. Create a **private channel** for storage
5. Add your bot as admin
6. Get channel ID (use [@userinfobot](https://t.me/userinfobot) or forward a message to [@GetMyIdBot](https://t.me/GetMyIdBot))

### 2. Set up Cloudflare
1. Install Wrangler CLI: `npm install -g wrangler`
2. Login: `wrangler login`
3. Create a KV namespace:
   ```bash
   wrangler kv namespace create "EASYCLOUD"
   ```
   Copy the `id` from output
4. Edit `wrangler.toml` and update:
   ```toml
   [[kv_namespaces]]
   binding = "kv"
   id = "YOUR_KV_NAMESPACE_ID"  # Paste your ID here
   ```

### 3. Configure Worker
Edit `worker.js` and add your credentials:
```javascript
const TELEGRAM_BOT_TOKEN = 'YOUR_BOT_TOKEN';
const TELEGRAM_CHANNEL_ID = '-1001234567890';  // Channel starts with -100
```

### 4. Deploy
```bash
wrangler deploy
```

Copy your Worker URL (e.g., `https://easy-cloud.your-name.workers.dev`)

### 5. Configure Frontend
1. Open `index.html`
2. Click the ⚙️ settings icon (top right)
3. Enter your Worker URL
4. Save

## 📁 Files

| File | Description |
|------|-------------|
| `worker.js` | Cloudflare Worker backend |
| `index.html` | Main UI (includes CSS) |
| `app.js` | Frontend logic |
| `download.html` | MEGA-style download page (includes CSS+JS) |
| `wrangler.toml` | Cloudflare Worker configuration |

## 🔗 Download URLs

### Direct Uploads (≤20MB - Images, Videos, Audio)
- URL format: `https://your-worker.com/download.html?id={fileId}`
- **Auto-redirects file for direct streaming** (can be used as `src` in `<img>`, `<video>`, `<audio>`)
- Example image: `<img src="https://worker.com/download.html?id=abc123">`
- Works perfectly in `<img>`, `<video>`, `<audio>` tags!

### Chunked Uploads (>20MB)
- URL format: `https://your-worker.com/download.html?id={fileId}`
- Shows MEGA-style download page with:
  - Animated loading lines
  - Real-time progress
  - Speed and ETA display
  - Chunk status visualization
  - Download button

## 🎯 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/upload` | POST | Direct upload (≤20MB) |
| `/upload_chunk` | POST | Upload single chunk |
| `/complete_upload` | POST | Complete chunked upload (stores in KV) |
| `/get_chunk` | GET | Fetch chunk from Telegram |
| `/download` | GET | Stream direct file |
| `/get_file_info` | GET | Get file metadata from KV |
| `/remote_upload` | POST | Upload from URL (supports chunking!) |
| `/delete_file` | POST | Delete file metadata |

## 🛠️ Remote Upload

The remote upload feature now supports large files with automatic chunking:

```javascript
// Upload from any URL
POST /remote_upload
{
  "url": "https://example.com/large-file.zip",
  "name": "my-file.zip"
}

// Response
{
  "success": true,
  "fileId": "abc123...",
  "shareUrl": "download.html?id=abc123..."
}
```

**Features:**
- Automatically chunks files >20MB
- Parallel chunk uploads
- SHA-256 verification
- Returns shareable URL

## 🔒 Security

- File ID validation (format checks)
- Filename sanitization
- SHA-256 hash verification for chunks
- No full file buffering in Worker
- Streaming responses

## 📊 Storage

Files stored in Telegram:
- Up to **2GB** per file (Telegram limit)
- Unlimited storage (Telegram doesn't limit private channel size)
- Files preserved as long as Telegram account exists

Metadata in Cloudflare KV:
- File name, size, type
- Chunk list with file_ids
- SHA-256 hashes
- Upload timestamps
- Shareable URLs
- Expires after 30 days (configurable)

## 🎨 Customization

### Change Theme
Edit `index.html` CSS variables and gradients.

### Adjust Chunk Size
```javascript
// In app.js and worker.js
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB (adjustable)
```

### Change KV Expiration
```javascript
// In worker.js
await kv.put(`file:${fileId}`, JSON.stringify(fileInfo), {
    expirationTtl: 30 * 24 * 60 * 60 // 30 days (change as needed)
});
```

## 🐛 Troubleshooting

### Files not showing
- Check Worker URL is correct in settings
- Verify KV namespace is configured
- Check browser console for errors

### Upload fails
- Verify Telegram bot token and channel ID
- Ensure bot is admin in the channel
- Check Cloudflare Worker logs

### Download errors
- Check file exists in KV
- Verify file_id is valid
- Check Telegram Bot API status

### Remote upload fails
- URL must be publicly accessible
- Some servers block file fetching
- Try with direct download URLs

## 📝 License

MIT License - Use freely for personal and commercial projects.

## 🙏 Credits

Built with:
- Cloudflare Workers
- Telegram Bot API
- Bootstrap 5
- Cloudflare KV
- Web Crypto API

---

**Easy Cloud** - Simple. Fast. Secure. ⚡