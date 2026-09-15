# 🚀 TeleDrive — Unlimited Secure Cloud Storage (PWA)

TeleDrive is an open-source, Google Drive-like personal cloud storage web application and **Progressive Web App (PWA)** backed by your private **Telegram Cloud Channel**. It features robust **AES-256-GCM Server-Side Encryption (Zero-Knowledge at Rest on Telegram)**, YouTube-style video streaming, Spotify-style audio player, full-screen PDF viewer, drag-and-drop file organization, and live media thumbnails.

---

## ✨ Key Features

- ☁️ **Unlimited Free Storage**: Utilizes Telegram's unlimited cloud storage infrastructure with multi-part chunking for any file size.
- 🔐 **AES-256-GCM Authenticated Encryption**: All files are encrypted on your private server instance using **AES-256-GCM** with unique per-file/per-chunk salts, IVs, and AEAD authentication tags before dispatch to Telegram. Telegram servers only ever receive and store encrypted ciphertext.
- 📱 **Progressive Web App (PWA)**: Installable directly on **iOS (iPhone/iPad)** via Safari ("Add to Home Screen") and **Android** via Chrome with a single tap for a fullscreen, native app experience without browser URL bars.
- ⚡ **Real-time Progressive Streaming**: Watch videos in a custom YouTube-style player with instant playback and seek support without waiting for full downloads.
- 🎵 **Spotify-Style Audio Player**: Stream music and podcasts with waveforms, progress scrubbing, and volume controls.
- 📄 **Full-Screen Document & PDF Viewer**: Google Drive style in-app viewer for reading PDFs, code files, and Markdown.
- 🗂️ **Drag & Drop Organization**: Smooth HTML5 drag-and-drop to organize files into folders and breadcrumb locations.
- 🖼️ **Live Thumbnails**: High-speed inline decrypted image & video thumbnail preview cards with AEAD authentication.
- ⚙️ **Comprehensive Settings Suite**: In-app password manager, Telegram API updater, live connection tester, and cache cleaner.

---

## 🐳 Docker Deployment on VPS

### Prerequisites
- A VPS running Linux (Ubuntu, Debian, etc.)
- Docker and Docker Compose installed

### 1. Clone the Repository
```bash
git clone <YOUR_GITHUB_REPO_URL> teledrive
cd teledrive
```

### 2. Configure Environment (Optional or use Web Setup Wizard)
```bash
cp .env.example .env
```
*(If `.env` is empty, opening the web UI in your browser will automatically launch the step-by-step Setup Wizard).*

### 3. Start with Docker Compose
```bash
docker compose up -d --build
```

### 4. Access the Web UI
Open your browser and navigate to:
```
http://YOUR_VPS_IP:3000
```

---

## 🔒 Security & Encryption Architecture

```
User (Browser / PWA)
       │ (HTTPS)
       ▼
TeleDrive Private Server (Self-Hosted VPS)
       │  ├─ Encrypts on-the-fly with AES-256-GCM
       │  └─ Generates unique Salt, IV & Auth Tag
       ▼ (MTProto)
Telegram Cloud Storage (Stores ONLY Encrypted Ciphertext)
```

- **Server-Side AES-256-GCM AEAD Encryption**: Files are encrypted on your private self-hosted server instance before being dispatched to Telegram.
- **Zero-Knowledge at Rest on Telegram**: Telegram servers only receive and store opaque encrypted binary chunks. Telegram has zero access to plaintext contents, filenames, or encryption keys.
- **Per-Chunk Cryptographic Integrity**: Every chunk has a distinct PBKDF2 salt, 96-bit IV, and 128-bit authentication tag verified before decryption.

---

## 💾 Critical Backup & Security Advisory

> [!IMPORTANT]
> **Why Database and Key Backups Are Essential:**
> 
> Because Telegram stores only encrypted binary blobs without keys, **no one** (not Telegram, nor any cloud provider) can recover your files without your `ENCRYPTION_KEY` and the metadata stored in `data/teledrive.db`.
> 
> If you migrate VPS or rebuild containers:
> 1. Always keep a safe copy of your **`ENCRYPTION_KEY`** (found in your `.env` file).
> 2. Always back up your **`data/teledrive.db`** file or use the built-in encrypted backup feature in Settings.
> 
> With `docker-compose.yml`, your `./data` folder and `./.env` are automatically mounted to the host machine so container updates preserve your database and keys.

---

## 🛠️ Tech Stack
- **Backend**: Node.js, Express, GramJS (Telegram MTProto Client), SQLite (`sql.js`), Multer
- **Security**: AES-256-GCM, PBKDF2 (310,000 iterations), Bcrypt (12 rounds), JWT, Helmet CSP, Same-Origin CORS, Rate Limiter
- **Frontend**: Vanilla JavaScript (ES6+), Modern CSS3 Variables, Responsive HTML5

---

## 📄 License
MIT License. Built for personal, secure, and private cloud storage.
