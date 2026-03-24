# Easy Cloud - Quick Reference

## 📂 Complete Project Structure

```
easy-cloud/
├── worker.js           # Cloudflare Worker backend
├── index.html          # Main UI + CSS
├── app.js              # Frontend logic
├── download.html       # MEGA-style download page (self-contained)
├── wrangler.toml       # Worker configuration
├── README.md           # Full documentation
└── QUICK_REFERENCE.md  # This file
```

## 🚀 Quick Setup (5 Minutes)

### 1. Telegram Setup
```bash
# Create bot via @BotFather
# Create private channel, add bot as admin
# Get BOT_TOKEN and CHANNEL_ID
```

### 2. Cloudflare Setup
```bash
npm install -g wrangler
wrangler login
wrangler kv namespace create "EASYCLOUD"
# Copy the ID to wrangler.toml
```

### 3. Configure
Edit `worker.js`:
```javascript
const TELEGRAM_BOT_TOKEN = 'YOUR_BOT_TOKEN';
const TELEGRAM_CHANNEL_ID = '-100xxxxxxxxxx';
```

Edit `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "kv"
id = "YOUR_KV_ID_FROM_STEP_2"
```

### 4. Deploy
```bash
wrangler deploy
```

Done! Your Worker URL will be returned.

---

## 🎯 Key Features Implemented

### ✅ Frontend (index.html + app.js)
- Bootstrap 5 dark theme
- Drag & drop upload
- Smart chunking (≤20MB direct, >20MB chunked)
- Pause/Resume uploads
- localStorage persistence
- File previews (images, videos, audio)
- Shareable links
- Toast notifications

### ✅ Download Page (download.html)
- **Self-contained** - all CSS and JS included
- MEGA.nz style with animated loading lines
- Real-time progress (speed, ETA)
- **Direct files stream automatically** for images/videos
- Can be used as `<img src="...download.html?id=X">`
- Shareable URLs via KV

### ✅ Worker (worker.js)
- Single file, all endpoints
- KV integration for metadata
- Telegram Bot API
- Chunked upload/download
- SHA-256 verification
- Remote upload with chunking support!

---

## 🔗 Download URL Behavior

### Direct Files (≤20MB - Images, Videos, Audio)
```
download.html?id=abc123
```
- **Auto-redirects to direct file stream**
- Works as `<img src="download.html?id=abc123">`
- Works as `<video src="download.html?id=abc123">`
- Works as `<audio src="download.html?id=abc123">`
- Copy link, paste anywhere, it works!

### Chunked Files (>20MB)
```
download.html?id=abc123
```
- Shows MEGA-style download page
- Animated loading lines
- Real-time progress bar
- Download button
- Only manual download (can't embed as src)

---

## 📡 API Endpoints Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/upload` | POST | Direct upload (≤20MB) |
| `/upload_chunk` | POST | Single chunk upload |
| `/complete_upload` | POST | Store chunked file in KV |
| `/get_chunk` | GET | Stream chunk from Telegram |
| `/download?id=X&direct=1` | GET | Stream direct file |
| `/get_file_info?id=X` | GET | Get metadata from KV |
| `/remote_upload` | POST | URL upload (with chunking!) |
| `/delete_file` | POST | Delete metadata |

---

## 🔧 Configuration Examples

### Set Chunk Size
```javascript
// app.js and worker.js
const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB
```

### Set KV Expiration
```javascript
// worker.js line ~145
expirationTtl: 30 * 24 * 60 * 60 // 30 days
```

### Set Concurrency
```javascript
// app.js
const MAX_CONCURRENT_UPLOADS = 4;

// worker.js
const MAX_CONCURRENT_UPLOADS = 4;
```

---

## 💡 Usage Examples

### Upload File (Frontend)
```javascript
// Drag & drop or select file
// Handled automatically by app.js
```

### Share Direct File
```
File uploaded: image.jpg (5MB)
Share URL: https://worker.com/download.html?id=abc123

Use directly:
<img src="https://worker.com/download.html?id=abc123">
```

### Share Chunked File
```
File uploaded: video.mp4 (500MB)
Share URL: https://worker.com/download.html?id=xyz789

Recipients see MEGA-style page and click download
```

### Remote Upload (Large File)
```javascript
fetch('https://worker.com/remote_upload', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://example.com/large-file.zip',
    name: 'my-file.zip'
  })
})
// Automatically chunks if >20MB!
```

---

## 🐛 Common Issues & Fixes

### Issue: "KV binding not found"
**Fix**: Ensure KV namespace is created and ID is in `wrangler.toml`

### Issue: "File not found in download page"
**Fix**: Check KV has the metadata, or file expired (30 days)

### Issue: Remote upload fails for large files
**Fix**: Now supports chunking! Ensure remote URL is publicly accessible

### Issue: Images not loading as src
**Fix**: Ensure it's a direct upload (≤20MB), chunked files can't be embedded

---

## 📊 Storage Limits

| Resource | Limit |
|----------|-------|
| Single file (Telegram) | 2GB |
| Total storage | Unlimited (via private channel) |
| KV metadata | 30 days TTL (configurable) |
| Chunk size | 20MB (configurable) |

---

## 🎨 Customizing the UI

### Change Colors (index.html)
```css
/* Find and modify gradients */
background: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460);

/* Navbar color */
background: rgba(15, 52, 96, 0.95);
```

### Change Download Page Theme (download.html)
```css
/* Modify body background */
background: linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #0c0c0c 100%);

/* Change accent colors */
background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899);
```

---

## ✅ What's New in This Version

1. **MEGA-style download page** - Animated loading lines, beautiful UI
2. **Direct file streaming** - Images/videos usable as src directly
3. **Shareable URLs** - Store in KV, link works anywhere
4. **Remote upload chunking** - Now supports files >20MB
5. **Complete download.html** - Self-contained with CSS+JS

---

## 📞 Support

For issues or questions:
1. Check README.md for detailed documentation
2. Review Cloudflare Worker logs
3. Verify Telegram Bot API status
4. Test endpoints directly

---

**Made with ⚡ for Easy Cloud**