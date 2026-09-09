# 🚀 TeleDrive — Unlimited Secure Cloud Storage

TeleDrive is an open-source, Google Drive-like personal cloud storage web application backed by your private **Telegram Cloud Channel**. It features military-grade **AES-256-GCM Zero-Knowledge Encryption**, YouTube-style video streaming, Spotify-style audio player, full-screen PDF viewer, drag-and-drop file organization, and live media thumbnails.

---

## ✨ Key Features

- ☁️ **Unlimited Free Storage**: Utilizes Telegram's unlimited cloud storage infrastructure with multi-part chunking for any file size.
- 🔐 **Zero-Knowledge Encryption**: All files are encrypted locally with **AES-256-GCM** using unique per-file salts and initialization vectors before upload. Telegram servers only ever receive encrypted ciphertext.
- ⚡ **Real-time Progressive Streaming**: Watch videos in a custom YouTube-style player with instant playback and seek support without waiting for full downloads.
- 🎵 **Spotify-Style Audio Player**: Stream music and podcasts with waveforms, progress scrubbing, and volume controls.
- 📄 **Full-Screen Document & PDF Viewer**: Google Drive style in-app viewer for reading PDFs, code files, and Markdown.
- 🗂️ **Drag & Drop Organization**: Smooth HTML5 drag-and-drop to organize files into folders and breadcrumb locations.
- 🖼️ **Live Thumbnails**: High-speed inline decrypted image & video thumbnail preview cards.
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

## 💾 Critical Backup & Security Advisory

> [!IMPORTANT]
> **Why Backups Are Essential for Zero-Knowledge Encryption:**
> 
> TeleDrive uses **Zero-Knowledge AES-256-GCM encryption**. This means **no one** (not even Telegram, nor any server provider) can decrypt your files without your `ENCRYPTION_KEY` and the metadata stored in `data/teledrive.db`.
> 
> If you lose your VPS or destroy the container without persistent volumes:
> 1. Always keep a safe copy of your **`ENCRYPTION_KEY`** (found in your `.env` file).
> 2. Always back up your **`data/teledrive.db`** file.
> 
> With `docker-compose.yml`, your `./data` folder and `./.env` are automatically mounted to the host machine so container restarts or updates will never lose your database or encryption keys.

---

## 🛠️ Tech Stack
- **Backend**: Node.js, Express, GramJS (Telegram MTProto Client), SQLite (`sql.js`), Multer
- **Security**: AES-256-GCM, PBKDF2 (310,000 iterations), Bcrypt (12 rounds), JWT, Helmet CSP, Same-Origin CORS, Rate Limiter
- **Frontend**: Vanilla JavaScript (ES6+), Modern CSS3 Variables, Responsive HTML5

---

## 📄 License
MIT License. Built for personal, secure, and private cloud storage.
