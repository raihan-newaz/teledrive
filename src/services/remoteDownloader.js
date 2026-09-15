const http = require('http');
const https = require('https');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const dns = require('dns').promises;
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const cryptoModule = require('../crypto');
const telegram = require('../telegram');
const eventBroadcaster = require('./eventBroadcaster');

const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB chunk size
const TEMP_DIR = path.join(__dirname, '..', '..', 'data', 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function getMimeType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.avif': 'image/avif', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mov': 'video/mp4', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.f4v': 'video/mp4',
    '.ts': 'video/mp2t', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.vob': 'video/x-ms-vob', '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar', '.gz': 'application/gzip',
    '.apk': 'application/vnd.android.package-archive', '.exe': 'application/x-msdownload',
    '.iso': 'application/x-iso9660-image',
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeFilename(filename) {
  return path.basename(filename || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'downloaded_file';
}

/**
 * Checks if an IP is in a private / local / loopback subnet (SSRF Protection)
 */
function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '0.0.0.0') return true;

  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 127) return true; // 127.0.0.0/8
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 (link-local)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16
  }

  // Check IPv6 private addresses
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;

  return false;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

class RemoteDownloader {
  constructor() {
    this.tasks = new Map(); // taskId -> taskObject
  }

  /**
   * Validate URL against SSRF vulnerabilities
   */
  async validateUrl(targetUrl) {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      throw new Error('Invalid URL format');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS URLs are supported');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      throw new Error('Access to local/private network addresses is blocked');
    }

    // Resolve hostname to IP to verify public routing
    try {
      const { address } = await dns.lookup(hostname);
      if (isPrivateIP(address)) {
        throw new Error('Target IP address is in a private network range');
      }
    } catch (err) {
      if (err.message && err.message.includes('private')) throw err;
      throw new Error(`DNS lookup failed for ${hostname}`);
    }

    return parsed;
  }

  /**
   * Extract filename from content-disposition header or URL path
   */
  extractFilename(urlObj, headers, customName) {
    if (customName && customName.trim()) {
      return sanitizeFilename(customName.trim());
    }

    const disposition = headers['content-disposition'];
    if (disposition) {
      // Try UTF-8 filename* first
      const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utf8Match && utf8Match[1]) {
        try {
          return sanitizeFilename(decodeURIComponent(utf8Match[1]));
        } catch (e) {}
      }

      // Standard filename="name.ext"
      const match = disposition.match(/filename="?([^";]+)"?/i);
      if (match && match[1]) {
        return sanitizeFilename(match[1]);
      }
    }

    // Extract from URL path
    const pathname = urlObj.pathname;
    const basename = path.basename(pathname);
    if (basename && basename.includes('.')) {
      try {
        return sanitizeFilename(decodeURIComponent(basename));
      } catch (e) {
        return sanitizeFilename(basename);
      }
    }

    return `remote_file_${Date.now()}`;
  }

  /**
   * Start a remote download task
   */
  async startDownload({ userId, userKey, url, customFileName, folderId }) {
    await this.validateUrl(url);

    const taskId = uuidv4();
    const task = {
      id: taskId,
      userId,
      userKey: userKey || process.env.ENCRYPTION_KEY || 'default-encryption-key',
      url,
      customFileName,
      folderId: folderId || null,
      fileName: customFileName ? sanitizeFilename(customFileName) : 'Preparing download...',
      status: 'downloading', // 'downloading', 'uploading', 'completed', 'error', 'cancelled'
      totalBytes: 0,
      downloadedBytes: 0,
      uploadedChunks: 0,
      totalChunks: 1,
      speedText: '',
      etaText: '',
      progress: 0,
      error: null,
      createdAt: Date.now(),
      abortController: new AbortController(),
      chunks: []
    };

    this.tasks.set(taskId, task);

    // Execute in background
    this.runDownloadPipeline(task).catch((err) => {
      console.error(`[RemoteDownload] Task ${taskId} failed:`, err);
      task.status = 'error';
      task.error = err.message || 'Remote download failed';
      this.broadcastTaskUpdate(task);
    });

    return {
      taskId,
      status: task.status,
      fileName: task.fileName
    };
  }

  /**
   * Main download & chunk-on-the-fly execution loop
   */
  async runDownloadPipeline(task) {
    const { url, userId, userKey, folderId, id: taskId } = task;
    let redirectCount = 0;
    let currentUrl = url;

    const executeRequest = (targetUrl) => {
      return new Promise((resolve, reject) => {
        if (task.abortController.signal.aborted) {
          return reject(new Error('Download cancelled by user'));
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(targetUrl);
        } catch (e) {
          return reject(new Error('Invalid URL'));
        }

        const client = parsedUrl.protocol === 'https:' ? https : http;
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
          },
          signal: task.abortController.signal
        };

        const req = client.get(targetUrl, options, async (res) => {
          // Handle HTTP Redirects (301, 302, 303, 307, 308)
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            redirectCount++;
            if (redirectCount > 5) {
              return reject(new Error('Too many HTTP redirects'));
            }
            const nextUrl = new URL(res.headers.location, targetUrl).toString();
            try {
              await this.validateUrl(nextUrl);
              res.resume(); // consume stream to free memory
              return resolve(executeRequest(nextUrl));
            } catch (err) {
              return reject(err);
            }
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`Remote server responded with HTTP status ${res.statusCode}`));
          }

          // Extract content-length & file name
          const contentLength = parseInt(res.headers['content-length'], 10);
          if (!isNaN(contentLength) && contentLength > 0) {
            task.totalBytes = contentLength;
            task.totalChunks = Math.max(1, Math.ceil(contentLength / CHUNK_SIZE));
          }

          task.fileName = this.extractFilename(parsedUrl, res.headers, task.customFileName);
          this.broadcastTaskUpdate(task);

          // Stream chunks to Telegram
          try {
            await this.processStreamChunks(res, task);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        req.on('error', (err) => {
          if (task.abortController.signal.aborted) {
            reject(new Error('Download cancelled by user'));
          } else {
            reject(err);
          }
        });
      });
    };

    await executeRequest(currentUrl);
  }

  /**
   * Reads stream into 20MB chunks and uploads each encrypted chunk directly to Telegram
   */
  async processStreamChunks(resStream, task) {
    let chunkIndex = 0;
    let currentChunkBytes = 0;
    let currentChunkBuffers = [];
    let lastTime = Date.now();
    let bytesSinceLastCheck = 0;

    const uploadCurrentChunk = async (chunkBuffer, isFinal = false) => {
      if (chunkBuffer.length === 0 && !isFinal) return;

      const chunkId = uuidv4();
      const rawChunkPath = path.join(TEMP_DIR, `remote_${task.id}_chunk_${chunkIndex}.bin`);
      const encChunkPath = rawChunkPath + '.enc';

      try {
        await fsPromises.writeFile(rawChunkPath, chunkBuffer);

        // AES-256-GCM encryption
        const { iv, salt, authTag } = await cryptoModule.encryptFile(rawChunkPath, encChunkPath, task.userKey);

        // Upload to Telegram
        const chunkTgName = `${task.fileName}.part${chunkIndex + 1}.enc`;
        const tgMessage = await telegram.uploadFile(encChunkPath, chunkTgName);

        task.chunks.push({
          id: chunkId,
          chunkIndex,
          telegramMessageId: tgMessage.id,
          size: chunkBuffer.length,
          iv,
          salt,
          authTag
        });

        task.uploadedChunks++;
        chunkIndex++;
        this.broadcastTaskUpdate(task);
      } finally {
        // Clean temp chunk files immediately to prevent disk bloat
        await fsPromises.unlink(rawChunkPath).catch(() => {});
        await fsPromises.unlink(encChunkPath).catch(() => {});
      }
    };

    for await (const chunk of resStream) {
      if (task.abortController.signal.aborted) {
        throw new Error('Download cancelled by user');
      }

      currentChunkBuffers.push(chunk);
      currentChunkBytes += chunk.length;
      task.downloadedBytes += chunk.length;
      bytesSinceLastCheck += chunk.length;

      // Speed & ETA calculation every 500ms
      const now = Date.now();
      if (now - lastTime >= 500) {
        const speed = (bytesSinceLastCheck / ((now - lastTime) / 1000));
        task.speedText = `${formatBytes(speed)}/s`;
        if (task.totalBytes > 0) {
          const remainingBytes = Math.max(0, task.totalBytes - task.downloadedBytes);
          const remainingSecs = speed > 0 ? Math.ceil(remainingBytes / speed) : 0;
          task.etaText = `ETA ${remainingSecs}s`;
          task.progress = Math.min(99, Math.floor((task.downloadedBytes / task.totalBytes) * 100));
        } else {
          task.etaText = `${formatBytes(task.downloadedBytes)} downloaded`;
          task.progress = 50;
        }
        lastTime = now;
        bytesSinceLastCheck = 0;
        this.broadcastTaskUpdate(task);
      }

      // When chunk reaches 20MB, upload it
      if (currentChunkBytes >= CHUNK_SIZE) {
        const fullBuffer = Buffer.concat(currentChunkBuffers);
        currentChunkBuffers = [];
        currentChunkBytes = 0;
        await uploadCurrentChunk(fullBuffer, false);
      }
    }

    // Upload remaining final chunk
    if (currentChunkBuffers.length > 0 || task.chunks.length === 0) {
      const finalBuffer = Buffer.concat(currentChunkBuffers);
      await uploadCurrentChunk(finalBuffer, true);
    }

    // Assembling final file in TeleDrive DB
    await this.completeFileAssembly(task);
  }

  /**
   * Finalizes file records in SQLite and broadcasts success
   */
  async completeFileAssembly(task) {
    const { id: fileId, userId, fileName, folderId, chunks, downloadedBytes } = task;
    const totalFileSize = downloadedBytes;
    const totalChunks = chunks.length;
    const mimeType = getMimeType(fileName);
    const now = new Date().toISOString();
    const firstChunk = chunks[0] || {};

    // 1. Insert into files table
    db.run(
      `INSERT OR REPLACE INTO files (id, user_id, name, mime_type, size, folder_id, telegram_message_id, iv, salt, auth_tag, is_starred, is_trashed, is_chunked, total_chunks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      [
        fileId,
        userId,
        fileName,
        mimeType,
        totalFileSize,
        folderId,
        firstChunk.telegramMessageId || 0,
        firstChunk.iv || null,
        firstChunk.salt || null,
        firstChunk.authTag || null,
        totalChunks > 1 ? 1 : 0,
        totalChunks,
        now,
        now
      ]
    );

    // 2. Insert into file_chunks table
    db.deleteFileChunks(fileId);
    for (const ch of chunks) {
      db.addFileChunk({
        id: ch.id,
        fileId,
        chunkIndex: ch.chunkIndex,
        telegramMessageId: ch.telegramMessageId,
        size: ch.size,
        iv: ch.iv,
        salt: ch.salt,
        authTag: ch.authTag || null
      });
    }

    // 3. Recalculate user storage quota
    db.recalculateUserStorage(userId);

    task.status = 'completed';
    task.progress = 100;
    task.speedText = 'Completed';
    task.etaText = '';
    this.broadcastTaskUpdate(task);

    const fileRecord = db.getFile(fileId, userId);

    // Broadcast file_uploaded event so UI updates instantly
    try {
      eventBroadcaster.broadcast('file_uploaded', { file: fileRecord, folderId });
      eventBroadcaster.broadcast('remote_upload_completed', { taskId: task.id, file: fileRecord });
    } catch (e) {}
  }

  /**
   * Cancel an active task
   */
  cancelDownload(taskId, userId) {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.userId !== userId) return false;

    if (task.status === 'downloading' || task.status === 'uploading') {
      task.abortController.abort();
      task.status = 'cancelled';
      task.speedText = 'Cancelled';
      task.etaText = '';
      this.broadcastTaskUpdate(task);
      return true;
    }

    return false;
  }

  /**
   * Get all active / recent tasks for a user
   */
  getUserTasks(userId) {
    const list = [];
    for (const task of this.tasks.values()) {
      if (task.userId === userId) {
        list.push({
          id: task.id,
          fileName: task.fileName,
          url: task.url,
          status: task.status,
          downloadedBytes: task.downloadedBytes,
          totalBytes: task.totalBytes,
          uploadedChunks: task.uploadedChunks,
          totalChunks: task.totalChunks,
          speedText: task.speedText,
          etaText: task.etaText,
          progress: task.progress,
          error: task.error,
          createdAt: task.createdAt
        });
      }
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Broadcast task progress via EventBroadcaster
   */
  broadcastTaskUpdate(task) {
    try {
      eventBroadcaster.broadcast('remote_upload_progress', {
        taskId: task.id,
        userId: task.userId,
        fileName: task.fileName,
        status: task.status,
        downloadedBytes: task.downloadedBytes,
        totalBytes: task.totalBytes,
        uploadedChunks: task.uploadedChunks,
        totalChunks: task.totalChunks,
        speedText: task.speedText,
        etaText: task.etaText,
        progress: task.progress,
        error: task.error
      });
    } catch (e) {}
  }
}

module.exports = new RemoteDownloader();
