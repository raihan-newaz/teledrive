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
const gdriveCrawler = require('./gdriveCrawler');

// Configurable environment settings
const MAX_CONCURRENT_JOBS = parseInt(process.env.REMOTE_DOWNLOAD_MAX_CONCURRENT || '2', 10);
const DEFAULT_CHUNK_SIZE = parseInt(process.env.REMOTE_DOWNLOAD_CHUNK_SIZE || String(300 * 1024 * 1024), 10); // 300 MB default (matches TeleDrive standard)
const MAX_REDIRECTS = parseInt(process.env.REMOTE_DOWNLOAD_MAX_REDIRECTS || '5', 10);
const TIMEOUT_MS = parseInt(process.env.REMOTE_DOWNLOAD_TIMEOUT_MS || '30000', 10);
const RETRY_COUNT = parseInt(process.env.REMOTE_DOWNLOAD_RETRY_COUNT || '3', 10);
const TEMP_ROOT = path.join(__dirname, '..', '..', 'data', 'temp', 'remote-downloads');

if (!fs.existsSync(TEMP_ROOT)) {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
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
  return path.basename(filename || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'downloaded_file';
}

/**
 * Checks if an IP is in a private / local / loopback subnet (Strict SSRF Protection)
 */
function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '0.0.0.0') return true;

  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 0) return true; // 0.0.0.0/8
    if (parts[0] === 10) return true; // 10.0.0.0/8
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // 100.64.0.0/10 (carrier-grade NAT)
    if (parts[0] === 127) return true; // 127.0.0.0/8 (loopback)
    if (parts[0] === 169 && parts[1] === 254) return true; // 169.254.0.0/16 (link-local)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true; // 172.16.0.0/12 (private)
    if (parts[0] === 192 && parts[1] === 168) return true; // 192.168.0.0/16 (private)
    if (parts[0] >= 224 && parts[0] <= 239) return true; // 224.0.0.0/4 (multicast)
    if (parts[0] >= 240) return true; // 240.0.0.0/4 (reserved)
  }

  // IPv6 checks
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:') || lower.startsWith('::ffff:')) {
    if (lower.startsWith('::ffff:')) {
      return isPrivateIP(lower.replace('::ffff:', ''));
    }
    return true;
  }

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
    this.activeJobs = new Map(); // jobId -> { abortController, chunks: [] }
    this.isProcessingQueue = false;

    // Reset any interrupted jobs on startup
    setTimeout(() => {
      this.recoverStuckJobs();
    }, 1000).unref();
  }

  /**
   * Reset stale in-progress jobs on server restart
   */
  recoverStuckJobs() {
    try {
      db.resetStuckRemoteJobs();
      console.log('[RemoteDownloader] Cleaned interrupted remote jobs from previous run');
    } catch (e) {}
  }

  /**
   * Centralized SSRF validation helper
   */
  async validateRemoteUrl(targetUrl) {
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
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.localhost')
    ) {
      throw new Error('Access to local or private network destinations is blocked');
    }

    // Resolve hostname to IP to verify public routing
    try {
      const { address } = await dns.lookup(hostname);
      if (isPrivateIP(address)) {
        throw new Error('Destination IP address resolves to a private network range');
      }
    } catch (err) {
      if (err.message && err.message.includes('private')) throw err;
      throw new Error(`DNS resolution failed for ${hostname}`);
    }

    return parsed;
  }

  /**
   * Safe filename extraction
   */
  extractFilename(urlObj, headers, customName) {
    if (customName && customName.trim()) {
      return sanitizeFilename(customName.trim());
    }

    const disposition = headers['content-disposition'];
    if (disposition) {
      const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utf8Match && utf8Match[1]) {
        try {
          return sanitizeFilename(decodeURIComponent(utf8Match[1]));
        } catch (e) {}
      }

      const match = disposition.match(/filename="?([^";]+)"?/i);
      if (match && match[1]) {
        return sanitizeFilename(match[1]);
      }
    }

    const basename = path.basename(urlObj.pathname || '');
    if (basename && basename.includes('.')) {
      try {
        return sanitizeFilename(decodeURIComponent(basename));
      } catch (e) {
        return sanitizeFilename(basename);
      }
    }

    return `download_${Date.now()}`;
  }

  /**
   * Add a new remote download job to database queue
   */
  async createJob({ userId, userKey, url, customFileName, folderId, chunkSize }) {
    await this.validateRemoteUrl(url);

    const jobId = uuidv4();
    const initialName = customFileName ? sanitizeFilename(customFileName) : 'Discovering file...';

    const job = db.createRemoteJob({
      id: jobId,
      userId,
      url,
      filename: initialName,
      folderId: folderId || null,
      status: 'queued',
      totalSize: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      progress: 0,
      chunkSize: chunkSize || DEFAULT_CHUNK_SIZE,
      userKey
    });

    // Broadcast queued state
    this.broadcastJobEvent(job);

    // Trigger queue worker
    this.processQueue().catch(() => {});

    return job;
  }

  /**
   * Queue processor maintaining concurrency limits
   */
  async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      while (this.activeJobs.size < MAX_CONCURRENT_JOBS) {
        const queuedJobs = db.getQueuedRemoteJobs(1);
        if (!queuedJobs || queuedJobs.length === 0) break;

        const nextJob = queuedJobs[0];
        // Mark as validating/downloading immediately
        db.updateRemoteJob(nextJob.id, {
          status: 'downloading',
          started_at: new Date().toISOString()
        });

        // Launch job in background
        this.runJob(nextJob).catch((err) => {
          console.error(`[RemoteDownloader] Job ${nextJob.id} error:`, err);
          db.updateRemoteJob(nextJob.id, {
            status: 'failed',
            error_message: err.message || 'Download failed'
          });
          this.broadcastJobEvent(db.getRemoteJob(nextJob.id, nextJob.user_id));
        }).finally(() => {
          this.activeJobs.delete(nextJob.id);
          this.processQueue().catch(() => {});
        });
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Main job download, chunking, AES encryption, and Telegram upload worker
   */
  async runJob(jobRecord) {
    const jobId = jobRecord.id;
    const userId = jobRecord.user_id;

    // Fetch user encryption key and file prefix
    const user = db.getUserById(userId);
    const userKey = user && user.encryption_key ? user.encryption_key : (process.env.ENCRYPTION_KEY || 'default-encryption-key');
    const userPrefix = user && user.file_prefix ? user.file_prefix : '';

    const abortController = new AbortController();
    const activeTask = {
      id: jobId,
      userId,
      userKey,
      userPrefix,
      chunkSize: jobRecord.chunk_size || DEFAULT_CHUNK_SIZE,
      abortController,
      chunks: [],
      jobDir: path.join(TEMP_ROOT, jobId)
    };

    if (!fs.existsSync(activeTask.jobDir)) {
      fs.mkdirSync(activeTask.jobDir, { recursive: true });
    }

    this.activeJobs.set(jobId, activeTask);

    let redirectCount = 0;
    let targetUrl = jobRecord.url;

    // Discovery phase: HEAD or Initial GET
    const executeStream = (reqUrl, startByte = 0) => {
      return new Promise((resolve, reject) => {
        if (abortController.signal.aborted) {
          return reject(new Error('Cancelled by user'));
        }

        let parsed;
        try {
          parsed = new URL(reqUrl);
        } catch (e) {
          return reject(new Error('Invalid URL'));
        }

        const client = parsed.protocol === 'https:' ? https : http;
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TeleDrive/2.0',
          'Accept': '*/*'
        };

        if (startByte > 0) {
          headers['Range'] = `bytes=${startByte}-`;
          if (jobRecord.etag) {
            headers['If-Range'] = jobRecord.etag;
          }
        }

        const req = client.get(reqUrl, { headers, signal: abortController.signal, timeout: TIMEOUT_MS }, async (res) => {
          // Handle Redirects
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            redirectCount++;
            if (redirectCount > MAX_REDIRECTS) {
              res.resume();
              return reject(new Error('Too many HTTP redirects'));
            }
            try {
              const nextUrl = new URL(res.headers.location, reqUrl).toString();
              await this.validateRemoteUrl(nextUrl);
              res.resume();
              return resolve(executeStream(nextUrl, startByte));
            } catch (err) {
              res.resume();
              return reject(err);
            }
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`Remote server responded with HTTP status ${res.statusCode}`));
          }

          // Metadata discovery
          const contentLength = parseInt(res.headers['content-length'], 10);
          const contentType = res.headers['content-type'] || 'application/octet-stream';
          const acceptRanges = res.headers['accept-ranges'] === 'bytes';
          const etag = res.headers['etag'] || null;
          const lastModified = res.headers['last-modified'] || null;
          const resolvedFilename = this.extractFilename(parsed, res.headers, jobRecord.filename);

          let totalSize = (!isNaN(contentLength) && contentLength > 0) ? (startByte + contentLength) : (jobRecord.total_size || 0);

          db.updateRemoteJob(jobId, {
            filename: resolvedFilename,
            content_type: contentType,
            total_size: totalSize,
            supports_range: acceptRanges ? 1 : 0,
            etag,
            last_modified: lastModified
          });

          this.broadcastJobEvent(db.getRemoteJob(jobId, userId));

          try {
            await this.streamAndUploadChunks(res, activeTask, resolvedFilename, totalSize, jobRecord.folder_id);
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        req.on('error', (err) => {
          if (abortController.signal.aborted) {
            reject(new Error('Cancelled by user'));
          } else {
            reject(err);
          }
        });

        req.on('timeout', () => {
          req.destroy(new Error('Connection timed out'));
        });
      });
    };

    try {
      if (gdriveCrawler.isGoogleDriveUrl(jobRecord.url)) {
        // Special Google Drive stream resolver (bypasses virus scan warnings & handles tokens)
        const gdriveRes = await gdriveCrawler.openDownloadStream(jobRecord.url, abortController.signal);
        const resolvedFilename = (jobRecord.filename && jobRecord.filename !== 'Discovering file...' && !jobRecord.filename.startsWith('download_'))
          ? jobRecord.filename
          : (gdriveRes.filename || 'gdrive_file');

        db.updateRemoteJob(jobId, {
          filename: resolvedFilename,
          content_type: gdriveRes.contentType || 'application/octet-stream',
          total_size: gdriveRes.totalSize || jobRecord.total_size || 0
        });

        this.broadcastJobEvent(db.getRemoteJob(jobId, userId));
        await this.streamAndUploadChunks(gdriveRes.stream, activeTask, resolvedFilename, gdriveRes.totalSize, jobRecord.folder_id);
      } else {
        await executeStream(targetUrl, 0);
      }
    } finally {
      // Clean temp folder
      await fsPromises.rm(activeTask.jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Stream chunks into memory/temp buffers, AES encrypt, and pipe directly to Telegram
   */
  async streamAndUploadChunks(resStream, activeTask, filename, totalSize, folderId) {
    const { id: jobId, userId, userKey, jobDir, abortController } = activeTask;
    const configuredChunkSize = activeTask.chunkSize > 0 ? activeTask.chunkSize : DEFAULT_CHUNK_SIZE;
    // Clamp safely: min 20MB (to avoid telegram rate limits on large files), max 1.95GB (Telegram bot limit)
    const effectiveChunkSize = Math.max(20 * 1024 * 1024, Math.min(configuredChunkSize, 1950 * 1024 * 1024));

    const crypto = require('crypto');
    const sha256Hash = crypto.createHash('sha256');

    let chunkIndex = 0;
    let currentChunkBuffers = [];
    let currentChunkBytes = 0;
    let totalDownloaded = 0;
    let lastBroadcastTime = Date.now();
    let bytesSinceLastBroadcast = 0;

    const uploadCurrentChunk = async (chunkBuffer, isFinal = false) => {
      if (chunkBuffer.length === 0 && !isFinal) return;

      const chunkId = uuidv4();
      const rawChunkPath = path.join(jobDir, `part_${chunkIndex}.bin`);
      const encChunkPath = rawChunkPath + '.enc';

      try {
        await fsPromises.writeFile(rawChunkPath, chunkBuffer);

        // AES-256-GCM encryption with user's specific key
        const { iv, salt, authTag } = await cryptoModule.encryptFile(rawChunkPath, encChunkPath, userKey);

        // Upload chunk to Telegram (with optional user prefix)
        const prefix = activeTask.userPrefix || '';
        const chunkTgName = (prefix ? `${prefix}_` : '') + `${filename}.part${chunkIndex + 1}.enc`;
        const tgMessage = await telegram.uploadFile(encChunkPath, chunkTgName);

        activeTask.chunks.push({
          id: chunkId,
          chunkIndex,
          telegramMessageId: tgMessage.id,
          size: chunkBuffer.length,
          iv,
          salt,
          authTag
        });

        chunkIndex++;
      } finally {
        await fsPromises.unlink(rawChunkPath).catch(() => {});
        await fsPromises.unlink(encChunkPath).catch(() => {});
      }
    };

    for await (const chunk of resStream) {
      if (abortController.signal.aborted) {
        throw new Error('Cancelled by user');
      }

      // Check quota during streaming
      const user = db.getUserById(userId);
      if (user && user.storage_limit > 0 && ((user.storage_used || 0) + totalDownloaded + chunk.length > user.storage_limit)) {
        throw new Error(`Storage quota exceeded: You have reached your ${formatBytes(user.storage_limit)} storage limit.`);
      }

      sha256Hash.update(chunk);
      currentChunkBuffers.push(chunk);
      currentChunkBytes += chunk.length;
      totalDownloaded += chunk.length;
      bytesSinceLastBroadcast += chunk.length;

      const now = Date.now();
      if (now - lastBroadcastTime >= 600) {
        const speed = (bytesSinceLastBroadcast / ((now - lastBroadcastTime) / 1000));
        const progress = totalSize > 0 ? Math.min(99, Math.floor((totalDownloaded / totalSize) * 100)) : 50;

        db.updateRemoteJob(jobId, {
          downloaded_bytes: totalDownloaded,
          progress
        });

        const job = db.getRemoteJob(jobId, userId);
        if (job) {
          job.speedText = `${formatBytes(speed)}/s`;
          if (totalSize > 0) {
            const remaining = Math.max(0, totalSize - totalDownloaded);
            const eta = speed > 0 ? Math.ceil(remaining / speed) : 0;
            job.etaText = `ETA ${eta}s`;
          }
          this.broadcastJobEvent(job);
        }

        lastBroadcastTime = now;
        bytesSinceLastBroadcast = 0;
      }

      if (currentChunkBytes >= effectiveChunkSize) {
        const fullBuffer = Buffer.concat(currentChunkBuffers);
        currentChunkBuffers = [];
        currentChunkBytes = 0;
        await uploadCurrentChunk(fullBuffer, false);
      }
    }

    // Final chunk
    if (currentChunkBuffers.length > 0 || activeTask.chunks.length === 0) {
      const finalBuffer = Buffer.concat(currentChunkBuffers);
      await uploadCurrentChunk(finalBuffer, true);
    }

    const calculatedSha256 = sha256Hash.digest('hex');

    // Assemble file in TeleDrive database
    await this.assembleFinalFile(jobId, userId, filename, totalDownloaded, folderId, activeTask.chunks, calculatedSha256);
  }

  /**
   * Finalizes file creation in TeleDrive SQLite DB
   */
  async assembleFinalFile(jobId, userId, filename, totalSize, folderId, chunks, sha256 = null) {
    const fileId = jobId;
    const mimeType = getMimeType(filename);
    const now = new Date().toISOString();
    const firstChunk = chunks[0] || {};
    const totalChunks = chunks.length;

    // 1. Insert into files table
    db.run(
      `INSERT OR REPLACE INTO files (id, user_id, name, mime_type, size, folder_id, telegram_message_id, iv, salt, auth_tag, is_starred, is_trashed, is_chunked, total_chunks, sha256, content_hash, hash_algorithm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'sha256', ?, ?)`,
      [
        fileId,
        userId,
        filename,
        mimeType,
        totalSize,
        folderId,
        firstChunk.telegramMessageId || 0,
        firstChunk.iv || null,
        firstChunk.salt || null,
        firstChunk.authTag || null,
        totalChunks > 1 ? 1 : 0,
        totalChunks,
        sha256 || null,
        sha256 || null,
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

    // 3. Mark job completed
    db.updateRemoteJob(jobId, {
      status: 'completed',
      progress: 100,
      downloaded_bytes: totalSize,
      uploaded_bytes: totalSize,
      file_id: fileId,
      completed_at: now
    });

    db.recalculateUserStorage(userId);

    const completedJob = db.getRemoteJob(jobId, userId);
    const fileRecord = db.getFile(fileId, userId);

    try {
      eventBroadcaster.broadcast('file_uploaded', { file: fileRecord, folderId, userId }, userId);
      eventBroadcaster.broadcast('remote_upload_completed', { taskId: jobId, file: fileRecord, userId }, userId);
    } catch (e) {}

    this.broadcastJobEvent(completedJob);
  }

  /**
   * Cancel an active or queued job
   */
  cancelJob(jobId, userId) {
    const active = this.activeJobs.get(jobId);
    if (active) {
      if (active.userId !== userId) return false;
      active.abortController.abort();
      this.activeJobs.delete(jobId);
    }

    const job = db.getRemoteJob(jobId, userId);
    if (!job) return false;

    if (job.status !== 'completed' && job.status !== 'cancelled') {
      db.updateRemoteJob(jobId, {
        status: 'cancelled',
        cancelled_at: new Date().toISOString()
      });
      this.broadcastJobEvent(db.getRemoteJob(jobId, userId));
      this.processQueue().catch(() => {});
      return true;
    }

    return false;
  }

  /**
   * Broadcast job event over SSE
   */
  broadcastJobEvent(job) {
    if (!job) return;
    try {
      eventBroadcaster.broadcast('remote_upload_progress', {
        taskId: job.id,
        userId: job.user_id,
        fileName: job.filename,
        status: job.status,
        downloadedBytes: job.downloaded_bytes || 0,
        totalBytes: job.total_size || 0,
        progress: job.progress || 0,
        speedText: job.speedText || (job.status === 'completed' ? 'Completed' : (job.status === 'queued' ? 'In queue...' : '')),
        etaText: job.etaText || '',
        error: job.error_message || null
      }, job.user_id);
    } catch (e) {}
  }
}

module.exports = new RemoteDownloader();
