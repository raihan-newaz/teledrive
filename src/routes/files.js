const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, copyFileSync, unlinkSync } = require('fs');
const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const authMiddleware = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimiter');
const telegram = require('../telegram');
const db = require('../db');
const cryptoModule = require('../crypto');

const router = express.Router();
router.use(authMiddleware);

const dataDir = path.join(__dirname, '../../data');
const tmpDir = path.join(dataDir, 'tmp');
const cacheDir = path.join(dataDir, 'cache');
const thumbnailsDir = path.join(dataDir, 'thumbnails');

if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
if (!existsSync(thumbnailsDir)) mkdirSync(thumbnailsDir, { recursive: true });

let resolvedFfmpegPath = null;
function resolveFfmpeg() {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) {
    resolvedFfmpegPath = process.env.FFMPEG_PATH;
    return resolvedFfmpegPath;
  }
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  if (localAppData) {
    const candidateDirs = [
      path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      'C:\\ffmpeg\\bin',
      'C:\\Program Files\\ffmpeg\\bin'
    ];
    for (const dir of candidateDirs) {
      const p = path.join(dir, 'ffmpeg.exe');
      if (existsSync(p)) {
        resolvedFfmpegPath = p;
        return resolvedFfmpegPath;
      }
    }
    const wingetPackages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    if (existsSync(wingetPackages)) {
      try {
        const entries = fs.readdirSync(wingetPackages);
        for (const entry of entries) {
          if (entry.toLowerCase().includes('ffmpeg')) {
            const fullPkgDir = path.join(wingetPackages, entry);
            const checkFfmpeg = (currDir, depth = 0) => {
              if (depth > 4) return null;
              const exePath = path.join(currDir, 'ffmpeg.exe');
              if (existsSync(exePath)) return exePath;
              try {
                const subDirs = fs.readdirSync(currDir, { withFileTypes: true });
                for (const sub of subDirs) {
                  if (sub.isDirectory()) {
                    const found = checkFfmpeg(path.join(currDir, sub.name), depth + 1);
                    if (found) return found;
                  }
                }
              } catch (e) {}
              return null;
            };
            const found = checkFfmpeg(fullPkgDir);
            if (found) {
              resolvedFfmpegPath = found;
              return resolvedFfmpegPath;
            }
          }
        }
      } catch (e) {}
    }
  }
  resolvedFfmpegPath = 'ffmpeg';
  return resolvedFfmpegPath;
}

// Worker pool for thumbnail generation (balanced concurrency for smooth playback & fast thumbnails)
let activeThumbnailJobs = 0;
const MAX_CONCURRENT_THUMBNAIL_JOBS = 3;
const thumbnailJobQueue = [];

function runThumbnailTask(taskFn) {
  return new Promise((resolve, reject) => {
    thumbnailJobQueue.push({ taskFn, resolve, reject });
    processThumbnailJobQueue();
  });
}

function processThumbnailJobQueue() {
  if (activeThumbnailJobs >= MAX_CONCURRENT_THUMBNAIL_JOBS || thumbnailJobQueue.length === 0) {
    return;
  }

  const { taskFn, resolve, reject } = thumbnailJobQueue.shift();
  activeThumbnailJobs++;

  taskFn()
    .then(resolve)
    .catch(reject)
    .finally(() => {
      activeThumbnailJobs--;
      processThumbnailJobQueue();
    });
}

function generateVideoThumbnailServer(videoPath, outputPath) {
  return new Promise((resolve) => {
    const isUrl = typeof videoPath === 'string' && (videoPath.startsWith('http://') || videoPath.startsWith('https://'));
    if (!isUrl && !existsSync(videoPath)) return resolve(false);

    const ffmpeg = resolveFfmpeg();
    execFile(ffmpeg, [
      '-ss', '00:00:02',
      '-i', videoPath,
      '-vframes', '1',
      '-vf', 'scale=240:-1',
      '-q:v', '4',
      '-y',
      outputPath
    ], { timeout: 12000 }, (err) => {
      if (err || !existsSync(outputPath)) {
        execFile(ffmpeg, [
          '-ss', '00:00:00.5',
          '-i', videoPath,
          '-vframes', '1',
          '-vf', 'scale=240:-1',
          '-q:v', '4',
          '-y',
          outputPath
        ], { timeout: 12000 }, (err2) => {
          if (err2 || !existsSync(outputPath)) {
            execFile(ffmpeg, [
              '-i', videoPath,
              '-vframes', '1',
              '-vf', 'scale=240:-1',
              '-q:v', '4',
              '-y',
              outputPath
            ], { timeout: 12000 }, (err3) => {
              resolve(!err3 && existsSync(outputPath));
            });
          } else {
            resolve(existsSync(outputPath));
          }
        });
      } else {
        resolve(existsSync(outputPath));
      }
    });
  });
}

function generateImageThumbnailServer(imagePath, outputPath) {
  return new Promise((resolve) => {
    if (!existsSync(imagePath)) return resolve(false);
    const ffmpeg = resolveFfmpeg();
    execFile(ffmpeg, [
      '-i', imagePath,
      '-vf', 'scale=240:-1',
      '-q:v', '4',
      '-y',
      outputPath
    ], { timeout: 10000 }, (err) => {
      resolve(!err && existsSync(outputPath));
    });
  });
}

/**
 * Downloads and authenticates a single Telegram part with AES-256-GCM AEAD integrity check
 * @param {Object} part - { telegram_message_id, size, iv, salt, auth_tag, chunk_index }
 * @param {string|Buffer} [userKey] - Optional per-user encryption key. Fallback to process.env.ENCRYPTION_KEY
 * @returns {Promise<Buffer>} Plaintext buffer
 */
async function downloadAndDecryptTelegramPart(part, userKey = null) {
  const encKey = userKey || process.env.ENCRYPTION_KEY;
  const key = cryptoModule.deriveKey(encKey, part.salt);
  const iv = Buffer.from(part.iv, 'base64');
  
  const cipherChunks = [];
  for await (const chunk of telegram.iterDownloadFile(part.telegram_message_id, 1024 * 1024)) {
    cipherChunks.push(chunk);
  }

  const rawDownloadedBuf = Buffer.concat(cipherChunks);
  let authTag = part.auth_tag ? Buffer.from(part.auth_tag, 'base64') : null;
  let ciphertext = rawDownloadedBuf;

  if (part.size && rawDownloadedBuf.length === part.size + 16) {
    ciphertext = rawDownloadedBuf.subarray(0, part.size);
    if (!authTag) {
      authTag = rawDownloadedBuf.subarray(part.size);
    }
  } else if (part.size && rawDownloadedBuf.length > part.size) {
    ciphertext = rawDownloadedBuf.subarray(0, part.size);
  }

  // Attempt 1: Standard decryption with stored or extracted authTag
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (authTag) decipher.setAuthTag(authTag);
    const d = decipher.update(ciphertext);
    const f = decipher.final();
    return Buffer.concat([d, f]);
  } catch (err1) {
    // Attempt 2: If authTag was appended at the end of the full raw downloaded buffer
    if (rawDownloadedBuf.length >= 16) {
      try {
        const decipher2 = crypto.createDecipheriv('aes-256-gcm', key, iv);
        const tagFromEnd = rawDownloadedBuf.subarray(rawDownloadedBuf.length - 16);
        const ctFromEnd = rawDownloadedBuf.subarray(0, rawDownloadedBuf.length - 16);
        decipher2.setAuthTag(tagFromEnd);
        const d2 = decipher2.update(ctFromEnd);
        const f2 = decipher2.final();
        return Buffer.concat([d2, f2]);
      } catch (err2) {}
    }

    // Attempt 3: Try full raw buffer with stored authTag
    try {
      const decipher3 = crypto.createDecipheriv('aes-256-gcm', key, iv);
      if (authTag) decipher3.setAuthTag(authTag);
      const d3 = decipher3.update(rawDownloadedBuf);
      const f3 = decipher3.final();
      return Buffer.concat([d3, f3]);
    } catch (err3) {}

    console.error(`[Crypto] Decryption failed for part ${part.chunk_index || 0}:`, err1.message);
    throw new Error(`Integrity check failed: File part ${part.chunk_index || 0} could not be authenticated.`);
  }
}

async function generateServerImageThumbnailForFile(file, outputPath, userKey = null) {
  try {
    const cachedPath = path.join(cacheDir, `${file.id}.dec`);
    if (existsSync(cachedPath)) {
      const ok = await generateImageThumbnailServer(cachedPath, outputPath);
      if (ok && existsSync(outputPath)) return true;
    }

    let parts = [];
    if (file.is_chunked === 1) {
      parts = db.getFileChunks(file.id);
      if (parts && parts.length > 0) parts.sort((a, b) => a.chunk_index - b.chunk_index);
    } else {
      parts = [{
        chunk_index: 0,
        telegram_message_id: file.telegram_message_id,
        size: file.size,
        iv: file.iv,
        salt: file.salt,
        auth_tag: file.auth_tag
      }];
    }

    if (!parts || parts.length === 0 || !parts[0].telegram_message_id) return false;

    const tempImgPath = path.join(tmpDir, `img_${file.id}${path.extname(file.name || '') || '.jpg'}`);
    const firstPartDecrypted = await downloadAndDecryptTelegramPart(parts[0], userKey);
    await fsPromises.writeFile(tempImgPath, firstPartDecrypted);

    const ok = await generateImageThumbnailServer(tempImgPath, outputPath);

    // Keep in data/cache if file size <= 40MB and caching is explicitly enabled
    if (file.size <= 40 * 1024 * 1024 && process.env.PLAINTEXT_CACHE_ENABLED === 'true' && !existsSync(cachedPath)) {
      try {
        await fsPromises.copyFile(tempImgPath, cachedPath);
        const cacheManager = require('../services/cacheManager');
        cacheManager.touchCacheFile(cachedPath);
      } catch (e) {}
    }

    await fsPromises.unlink(tempImgPath).catch(() => {});
    return ok && existsSync(outputPath);
  } catch (err) {
    console.warn(`[Thumbnail] Error generating server image thumbnail for ${file.id}:`, err.message);
    return false;
  }
}

async function generateServerThumbnailForFile(file, outputPath, userKey = null) {
  try {
    const cachedPath = path.join(cacheDir, `${file.id}.dec`);
    if (existsSync(cachedPath)) {
      return await generateVideoThumbnailServer(cachedPath, outputPath);
    }

    let parts = [];
    if (file.is_chunked === 1) {
      parts = db.getFileChunks(file.id);
      if (parts && parts.length > 0) parts.sort((a, b) => a.chunk_index - b.chunk_index);
    } else {
      parts = [{
        chunk_index: 0,
        telegram_message_id: file.telegram_message_id,
        size: file.size,
        iv: file.iv,
        salt: file.salt,
        auth_tag: file.auth_tag
      }];
    }

    if (!parts || parts.length === 0 || !parts[0].telegram_message_id) return false;

    const tempVidPath = path.join(tmpDir, `vid_thumb_${file.id}${path.extname(file.name || '') || '.mp4'}`);
    const firstPartDecrypted = await downloadAndDecryptTelegramPart(parts[0], userKey);
    await fsPromises.writeFile(tempVidPath, firstPartDecrypted);

    const ok = await generateVideoThumbnailServer(tempVidPath, outputPath);

    if (file.size <= 40 * 1024 * 1024 && process.env.PLAINTEXT_CACHE_ENABLED === 'true' && !existsSync(cachedPath)) {
      try {
        await fsPromises.copyFile(tempVidPath, cachedPath);
        const cacheManager = require('../services/cacheManager');
        cacheManager.touchCacheFile(cachedPath);
      } catch (e) {}
    }

    await fsPromises.unlink(tempVidPath).catch(() => {});
    return ok && existsSync(outputPath);
  } catch (err) {
    console.warn(`[Thumbnail] Error generating server thumbnail for ${file.id}:`, err.message);
    return false;
  }
}

/**
 * Checks if user has enough storage quota
 */
function checkUserStorageQuota(userId, incomingSize) {
  const user = db.getUserById(userId);
  if (!user || !user.storage_limit || user.storage_limit <= 0) return { allowed: true };
  const currentUsed = user.storage_used || 0;
  if (currentUsed + incomingSize > user.storage_limit) {
    return {
      allowed: false,
      limit: user.storage_limit,
      used: currentUsed,
      required: incomingSize,
      message: `Storage quota exceeded. Current usage: ${(currentUsed / (1024 * 1024)).toFixed(1)} MB / ${(user.storage_limit / (1024 * 1024)).toFixed(1)} MB.`
    };
  }
  return { allowed: true };
}

const upload = multer({
  dest: tmpDir,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB max
    files: 1,
    fields: 10,
    parts: 20
  }
});

// Clean up abandoned upload sessions older than 48 hours
async function purgeExpiredUploadSessions() {
  try {
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const expiredSessions = db.getExpiredUploadSessions(fortyEightHoursAgo);
    for (const session of expiredSessions) {
      const chunks = db.getUploadedSessionChunks(session.id);
      for (const ch of chunks) {
        try { await telegram.deleteFile(ch.telegram_message_id); } catch (e) {}
      }
      db.deleteUploadSession(session.id);
    }
  } catch (err) {
    console.error('[Upload-Session] Error purging expired sessions:', err);
  }
}
setInterval(purgeExpiredUploadSessions, 12 * 3600 * 1000).unref();

// Clean up temporary upload files older than 2 hours in data/tmp
async function cleanupTmpDir() {
  try {
    const files = await fsPromises.readdir(tmpDir);
    const now = Date.now();
    const twoHoursMs = 2 * 3600 * 1000;
    for (const file of files) {
      try {
        const filePath = path.join(tmpDir, file);
        const stats = await fsPromises.stat(filePath);
        if (now - stats.mtimeMs > twoHoursMs) {
          await fsPromises.unlink(filePath).catch(() => {});
        }
      } catch (e) {}
    }
  } catch (err) {
    console.error('[Cleanup] Error in cleanupTmpDir:', err.message);
  }
}
setInterval(cleanupTmpDir, 30 * 60 * 1000).unref();
setTimeout(cleanupTmpDir, 60 * 1000).unref();

// LRU Cache Cleaner for data/cache (keeps cache <= 5GB)
const MAX_CACHE_BYTES = (parseInt(process.env.MAX_CACHE_GB, 10) || 5) * 1024 * 1024 * 1024;
async function cleanupCacheLRU() {
  try {
    const files = await fsPromises.readdir(cacheDir);
    let totalBytes = 0;
    const fileEntries = [];

    for (const file of files) {
      try {
        const filePath = path.join(cacheDir, file);
        const stats = await fsPromises.stat(filePath);
        if (stats.isFile()) {
          totalBytes += stats.size;
          fileEntries.push({
            filePath,
            size: stats.size,
            lastAccess: stats.atimeMs || stats.mtimeMs
          });
        }
      } catch (e) {}
    }

    if (totalBytes > MAX_CACHE_BYTES) {
      console.log(`[Cache LRU] Cache usage ${(totalBytes / 1024 / 1024).toFixed(1)}MB exceeds limit ${(MAX_CACHE_BYTES / 1024 / 1024).toFixed(1)}MB. Evicting oldest files...`);
      fileEntries.sort((a, b) => a.lastAccess - b.lastAccess);

      const targetBytes = MAX_CACHE_BYTES * 0.75;
      let freedBytes = 0;
      for (const entry of fileEntries) {
        if (totalBytes - freedBytes <= targetBytes) break;
        try {
          await fsPromises.unlink(entry.filePath);
          freedBytes += entry.size;
        } catch (e) {}
      }
      console.log(`[Cache LRU] Evicted ${(freedBytes / 1024 / 1024).toFixed(1)}MB. Current cache: ${((totalBytes - freedBytes) / 1024 / 1024).toFixed(1)}MB.`);
    }
  } catch (err) {
    console.error('[Cache LRU] Error in cleanupCacheLRU:', err.message);
  }
}
setInterval(cleanupCacheLRU, 60 * 60 * 1000).unref();
setTimeout(cleanupCacheLRU, 2 * 60 * 1000).unref();

function getMimeType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.avif': 'image/avif', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mov': 'video/mp4', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.f4v': 'video/mp4',
    '.ts': 'video/mp2t', '.mts': 'video/mp2t', '.m2ts': 'video/mp2t', '.vob': 'video/x-ms-vob', '.ogv': 'video/ogg',
    '.divx': 'video/divx', '.xvid': 'video/x-msvideo', '.rm': 'video/vnd.rn-realvideo', '.rmvb': 'video/vnd.rn-realvideo',
    '.asf': 'video/x-ms-asf', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.m2v': 'video/mpeg',
    '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.h264': 'video/mp4', '.h265': 'video/mp4', '.hevc': 'video/mp4',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
    '.aiff': 'audio/x-aiff', '.alac': 'audio/mp4', '.mid': 'audio/midi', '.midi': 'audio/midi',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.py': 'text/x-python', '.java': 'text/x-java-source', '.c': 'text/x-c', '.cpp': 'text/x-c++',
    '.md': 'text/markdown', '.log': 'text/plain',
    '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
    '.tar': 'application/x-tar', '.gz': 'application/gzip',
    '.apk': 'application/vnd.android.package-archive', '.exe': 'application/x-msdownload',
    '.iso': 'application/x-iso9660-image',
  };
  return map[ext] || 'application/octet-stream';
}

function sanitizeFilename(filename) {
  return path.basename(filename).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

/**
 * Unified Stream/Download Pipe Helper with 100% Byte-Accurate Range (Pause & Resume) Support
 */
async function streamFileToResponse(file, req, res, isDownload = false, explicitKey = null) {
  const cachedPath = path.join(cacheDir, `${file.id}.dec`);
  const fileSize = file.size;
  const userKey = explicitKey || req.user?.encryptionKey || process.env.ENCRYPTION_KEY;

  // Parse Range header if requested by client (Chrome, Edge, IDM, curl, media players)
  const range = req.headers.range;
  let start = 0;
  let end = fileSize - 1;
  let isRangeRequest = false;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const parsedStart = parseInt(parts[0], 10);
    const parsedEnd = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (!isNaN(parsedStart) && parsedStart >= 0 && parsedStart < fileSize) {
      start = parsedStart;
      end = (!isNaN(parsedEnd) && parsedEnd >= start && parsedEnd < fileSize) ? parsedEnd : fileSize - 1;
      isRangeRequest = true;
    } else if (parsedStart >= fileSize) {
      return res.status(416).header('Content-Range', `bytes */${fileSize}`).send();
    }
  }

  const chunkSize = (end - start) + 1;
  const effectiveMimeType = (file.mime_type && file.mime_type !== 'application/octet-stream') ? file.mime_type : getMimeType(file.name);

  const commonHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Authorization, x-folder-token',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Type',
    'Accept-Ranges': 'bytes',
    'Content-Type': effectiveMimeType,
    'Content-Disposition': isDownload ? `attachment; filename="${encodeURIComponent(file.name)}"` : 'inline',
  };

  // 1. If cached locally, serve directly from cache with byte-accurate slice
  if (existsSync(cachedPath)) {
    try {
      const stats = statSync(cachedPath);
      if (stats.size === fileSize) {
        if (isRangeRequest) {
          res.writeHead(206, {
            ...commonHeaders,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunkSize,
          });
          const fileStream = createReadStream(cachedPath, { start, end });
          fileStream.pipe(res);
          req.on('close', () => fileStream.destroy());
          return;
        } else {
          res.writeHead(200, {
            ...commonHeaders,
            'Content-Length': fileSize,
          });
          const fileStream = createReadStream(cachedPath);
          fileStream.pipe(res);
          req.on('close', () => fileStream.destroy());
          return;
        }
      }
    } catch (e) {
      // Cache read fallback to stream
    }
  }

  // 2. Stream from Telegram on-the-fly with Full Range & Multi-Part Slicing Support
  console.log(`[Stream] Streaming "${file.name}" (ID: ${file.id}, bytes: ${start}-${end}/${fileSize}, chunked: ${file.is_chunked})...`);

  let partsToStream = [];
  if (file.is_chunked === 1) {
    partsToStream = db.getFileChunks(file.id);
  } else {
    partsToStream = [{
      chunk_index: 0,
      telegram_message_id: file.telegram_message_id,
      size: file.size,
      iv: file.iv,
      salt: file.salt,
      auth_tag: file.auth_tag
    }];
  }

  if (!partsToStream || partsToStream.length === 0) {
    return res.status(404).json({ error: 'File parts not found' });
  }

  // Sort chunks by index ascending
  partsToStream.sort((a, b) => a.chunk_index - b.chunk_index);

  // Send proper HTTP 206 Partial Content or HTTP 200 OK headers
  if (isRangeRequest) {
    res.writeHead(206, {
      ...commonHeaders,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });
  } else {
    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': fileSize,
    });
  }

  const plaintextCacheEnabled = process.env.PLAINTEXT_CACHE_ENABLED === 'true';
  const shouldCache = plaintextCacheEnabled && (start === 0);
  const tempCachedPath = `${cachedPath}.tmp`;
  let cacheWriteStream = null;
  if (shouldCache) {
    try {
      cacheWriteStream = createWriteStream(tempCachedPath);
    } catch (e) {}
  }

  let isClientClosed = false;
  let streamCompleted = false;

  req.on('close', () => {
    isClientClosed = true;
    if (!streamCompleted && cacheWriteStream) {
      cacheWriteStream.destroy();
      try {
        if (existsSync(tempCachedPath)) unlinkSync(tempCachedPath);
      } catch (e) {}
    }
  });

  try {
    let currentFileOffset = 0;

    for (const part of partsToStream) {
      if (isClientClosed) break;

      const partSize = part.size;
      const partStartOffset = currentFileOffset;
      const partEndOffset = currentFileOffset + partSize - 1;
      currentFileOffset += partSize;

      // Skip parts that are completely outside the requested [start, end] Range
      if (partEndOffset < start || partStartOffset > end) {
        continue;
      }

      const neededStartInPart = Math.max(0, start - partStartOffset);
      const neededEndInPart = Math.min(partSize - 1, end - partStartOffset);

      // Download and fully authenticate the encrypted part with AES-GCM AEAD check (decipher.final)
      const decryptedPartBuf = await downloadAndDecryptTelegramPart(part, userKey);

      const sliceToSend = decryptedPartBuf.subarray(neededStartInPart, neededEndInPart + 1);

      if (!isClientClosed && sliceToSend.length > 0) {
        const canContinue = res.write(sliceToSend);
        if (!canContinue) {
          await new Promise(r => res.once('drain', r));
        }
      }

      if (cacheWriteStream && !isClientClosed) {
        cacheWriteStream.write(decryptedPartBuf);
      }
    }

    if (cacheWriteStream) {
      cacheWriteStream.end(() => {
        if (!isClientClosed && existsSync(tempCachedPath)) {
          try {
            const stats = statSync(tempCachedPath);
            if (stats.size === fileSize) {
              const fs = require('fs');
              fs.renameSync(tempCachedPath, cachedPath);
              const cacheManager = require('../services/cacheManager');
              cacheManager.touchCacheFile(cachedPath);
            } else {
              unlinkSync(tempCachedPath);
            }
          } catch (e) {}
        }
      });
    }

    if (!isClientClosed) {
      streamCompleted = true;
      res.end();
    }
  } catch (err) {
    console.error('[Stream] Streaming error:', err.message);
    if (cacheWriteStream) {
      cacheWriteStream.destroy();
      try {
        if (existsSync(tempCachedPath)) unlinkSync(tempCachedPath);
      } catch (e) {}
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Streaming failed: ' + err.message });
    } else {
      res.destroy(err);
    }
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function checkUserStorageQuota(userId, incomingBytes = 0) {
  if (!userId) return { allowed: true };
  const user = db.getUserById(userId);
  if (!user) return { allowed: true };
  if (!user.storage_limit || user.storage_limit <= 0) {
    return { allowed: true }; // Unlimited quota
  }
  const currentUsed = user.storage_used || 0;
  if (currentUsed + incomingBytes > user.storage_limit) {
    return {
      allowed: false,
      message: `Storage quota exceeded. You are using ${formatBytes(currentUsed)} of your ${formatBytes(user.storage_limit)} quota.`
    };
  }
  return { allowed: true };
}

/**
 * POST /check-duplicate — Check if user already uploaded identical file (user-scoped)
 */
router.post('/check-duplicate', (req, res) => {
  try {
    const { sha256, size } = req.body;
    if (!sha256 || !size) {
      return res.json({ isDuplicate: false });
    }
    const existing = db.checkUserFileDuplicate(req.user.id, sha256, size);
    if (existing) {
      return res.json({
        isDuplicate: true,
        existingFile: {
          id: existing.id,
          name: existing.name,
          size: existing.size,
          folderId: existing.folder_id,
          createdAt: existing.created_at
        }
      });
    }
    return res.json({ isDuplicate: false });
  } catch (error) {
    console.error('Duplicate check error:', error);
    return res.json({ isDuplicate: false });
  }
});

/**
 * POST /upload — Upload single file with AES-256-GCM encryption + Instant Local Cache
 */
router.post('/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  let originalPath = null;
  let encryptedPath = null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const userId = req.user.id;

    // Check storage quota
    const quotaCheck = checkUserStorageQuota(userId, req.file.size);
    if (!quotaCheck.allowed) {
      return res.status(413).json({ error: quotaCheck.message, quotaExceeded: true });
    }

    const rawFolderId = req.body.folderId;
    const folderId = (rawFolderId && rawFolderId !== 'null' && rawFolderId !== 'undefined' && String(rawFolderId).trim() !== '') ? String(rawFolderId).trim() : null;
    const safeName = sanitizeFilename(req.file.originalname);
    const fileId = uuidv4();

    originalPath = req.file.path;
    encryptedPath = originalPath + '.enc';

    // 1. If plaintext cache is enabled, place in local cache for 0ms instant playback
    if (process.env.PLAINTEXT_CACHE_ENABLED === 'true') {
      const cachedPath = path.join(cacheDir, `${fileId}.dec`);
      try { copyFileSync(originalPath, cachedPath); } catch (e) {}
    }

    // 2. Encrypt file using per-user encryption key + compute plaintext SHA-256
    const encryptionKey = req.user.encryptionKey || process.env.ENCRYPTION_KEY;
    const { iv, salt, authTag, sha256 } = await cryptoModule.encryptFile(originalPath, encryptedPath, encryptionKey);

    // 3. Upload encrypted file to Telegram
    const message = await telegram.uploadFile(encryptedPath, safeName + '.enc');

    // 4. Save metadata to SQLite
    const mimeType = getMimeType(safeName);
    const now = new Date().toISOString();

    // 5. Try generating server-side lightweight thumbnail (10-20 KB)
    const thumbPath = path.join(thumbnailsDir, `${fileId}.jpg`);
    if (mimeType.startsWith('video/')) {
      try { await generateVideoThumbnailServer(originalPath, thumbPath); } catch (e) {}
    } else if (mimeType.startsWith('image/')) {
      try { await generateImageThumbnailServer(originalPath, thumbPath); } catch (e) {}
    }

    db.run(
      `INSERT INTO files (id, user_id, name, mime_type, size, folder_id, telegram_message_id, iv, salt, auth_tag, is_starred, is_trashed, is_chunked, total_chunks, sha256, content_hash, hash_algorithm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, ?, ?, 'sha256', ?, ?)`,
      [fileId, userId, safeName, mimeType, req.file.size, folderId, message.id, iv, salt, authTag, sha256 || null, sha256 || null, now, now]
    );

    db.recalculateUserStorage(userId);

    const fileRecord = db.getFile(fileId, userId);
    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('file_uploaded', { file: fileRecord, folderId });
    } catch (e) {}

    res.json({ success: true, file: fileRecord });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  } finally {
    if (originalPath) await fsPromises.unlink(originalPath).catch(() => {});
    if (encryptedPath) await fsPromises.unlink(encryptedPath).catch(() => {});
  }
});

const assemblyLocks = new Set();

/**
 * Helper to commit completed chunked file to database (with mutex lock)
 */
function assembleFinalFile(uploadId, userId, safeName, totalFileSize, folderId, totalChunks, chunks, res, userKey = null, sha256 = null) {
  if (assemblyLocks.has(uploadId)) {
    return res.json({ success: true, message: 'Assembly in progress' });
  }
  assemblyLocks.add(uploadId);

  try {
    const existingFile = db.getFile(uploadId, userId);
    if (existingFile && existingFile.size === totalFileSize) {
      db.deleteUploadSession(uploadId, userId);
      return res.json({ success: true, done: true, file: existingFile });
    }

    const allChunks = db.getUploadedSessionChunks(uploadId);
    const chunksToUse = allChunks.length >= totalChunks ? allChunks : chunks;
    chunksToUse.sort((a, b) => a.chunk_index - b.chunk_index);

    const fileId = uploadId;
    const mimeType = getMimeType(safeName);
    const now = new Date().toISOString();
    const firstChunk = chunksToUse[0] || {};
    const session = db.getUploadSession(uploadId, userId);
    const resolvedSha256 = sha256 || (session ? session.sha256 : null) || null;

    db.run(
      `INSERT OR REPLACE INTO files (id, user_id, name, mime_type, size, folder_id, telegram_message_id, iv, salt, auth_tag, is_starred, is_trashed, is_chunked, total_chunks, sha256, content_hash, hash_algorithm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'sha256', ?, ?)`,
      [fileId, userId, safeName, mimeType, totalFileSize, folderId, firstChunk.telegram_message_id, firstChunk.iv, firstChunk.salt, firstChunk.auth_tag || null, totalChunks > 1 ? 1 : 0, totalChunks, resolvedSha256, resolvedSha256, now, now]
    );

    // Clear any old records for this file ID in file_chunks, then commit all chunks
    db.deleteFileChunks(fileId);
    for (const ch of chunksToUse) {
      db.addFileChunk({
        id: ch.id,
        fileId,
        chunkIndex: ch.chunk_index,
        telegramMessageId: ch.telegram_message_id,
        size: ch.size,
        iv: ch.iv,
        salt: ch.salt,
        authTag: ch.auth_tag || null
      });
    }

    // Remove upload session
    db.deleteUploadSession(uploadId, userId);
    db.recalculateUserStorage(userId);

    const fileRecord = db.getFile(fileId, userId);
    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('file_uploaded', { file: fileRecord, folderId });
    } catch (e) {}

    return res.json({ success: true, done: true, file: fileRecord });
  } finally {
    assemblyLocks.delete(uploadId);
  }
}

/**
 * GET /upload-session — Check existing upload session state for resumable uploads
 */
router.get('/upload-session', (req, res) => {
  try {
    const { uploadId } = req.query;
    if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });

    const session = db.getUploadSession(uploadId, req.user.id);
    if (!session) {
      return res.json({ exists: false, uploadedIndices: [] });
    }

    const chunks = db.getUploadedSessionChunks(uploadId);
    const uploadedIndices = chunks.map(c => c.chunk_index);

    res.json({
      exists: true,
      fileName: session.file_name,
      fileSize: session.file_size,
      totalChunks: session.total_chunks,
      uploadedIndices
    });
  } catch (error) {
    console.error('Check upload session error:', error);
    res.status(500).json({ error: 'Failed to check upload session' });
  }
});

/**
 * DELETE /upload-session/:uploadId — Cancel an in-progress session and delete its chunks from Telegram
 */
router.delete('/upload-session/:uploadId', async (req, res) => {
  try {
    const uploadId = req.params.uploadId;
    const session = db.getUploadSession(uploadId, req.user.id);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    const chunks = db.getUploadedSessionChunks(uploadId);
    if (chunks && chunks.length > 0) {
      const msgIds = chunks.map(ch => parseInt(ch.telegram_message_id, 10)).filter(id => !isNaN(id) && id > 0);
      if (msgIds.length > 0) {
        try {
          await telegram.deleteFiles(msgIds);
          console.log(`[UploadSession] Deleted ${msgIds.length} uploaded chunk(s) from Telegram for cancelled session ${uploadId}`);
        } catch (tgErr) {
          console.error(`[UploadSession] Error deleting ${msgIds.length} chunks from Telegram:`, tgErr.message);
        }
      }
    }
    db.deleteUploadSession(uploadId, req.user.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete upload session error:', error);
    res.status(500).json({ error: 'Failed to cancel upload session' });
  }
});

/**
 * POST /upload-chunk — Auto-Chunked Resumable Upload
 */
router.post('/upload-chunk', uploadLimiter, upload.single('file'), async (req, res) => {
  let originalPath = null;
  let encryptedPath = null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No chunk uploaded' });

    const userId = req.user.id;
    const uploadId = req.body.uploadId;
    const chunkIndex = parseInt(req.body.chunkIndex, 10);
    const totalChunks = parseInt(req.body.totalChunks, 10);
    const fileName = req.body.fileName || req.file.originalname;
    const totalFileSize = parseInt(req.body.fileSize, 10) || req.file.size;
    const rawFolderId = req.body.folderId;
    const folderId = (rawFolderId && rawFolderId !== 'null' && rawFolderId !== 'undefined' && String(rawFolderId).trim() !== '') ? String(rawFolderId).trim() : null;

    if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 128 || isNaN(chunkIndex) || isNaN(totalChunks)) {
      return res.status(400).json({ error: 'Missing or invalid chunk metadata' });
    }
    if (chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks || totalChunks > 10000) {
      return res.status(400).json({ error: 'Invalid chunk index or total chunks range' });
    }
    if (totalFileSize <= 0 || totalFileSize > 500 * 1024 * 1024 * 1024) {
      return res.status(400).json({ error: 'Invalid total file size' });
    }

    // Check storage quota on initial chunk or ongoing
    const quotaCheck = checkUserStorageQuota(userId, totalFileSize);
    if (!quotaCheck.allowed) {
      return res.status(413).json({ error: quotaCheck.message, quotaExceeded: true });
    }

    const safeName = sanitizeFilename(fileName);

    // 1. Ensure persistent session exists in DB
    db.createUploadSession({
      id: uploadId,
      userId,
      fileName: safeName,
      fileSize: totalFileSize,
      folderId,
      totalChunks
    });

    // 2. Check if this chunk was already uploaded (prevents duplicate work on retry/resume)
    const existingChunks = db.getUploadedSessionChunks(uploadId);
    const alreadyUploaded = existingChunks.find(c => c.chunk_index === chunkIndex);
    if (alreadyUploaded) {
      if (existingChunks.length === totalChunks) {
        return assembleFinalFile(uploadId, userId, safeName, totalFileSize, folderId, totalChunks, existingChunks, res);
      }
      return res.json({ success: true, done: false, chunkIndex, uploadedChunks: existingChunks.length, totalChunks });
    }

    originalPath = req.file.path;
    encryptedPath = originalPath + '.enc';

    // 3. Encrypt this chunk with AES-256-GCM using user key
    const encryptionKey = req.user.encryptionKey || process.env.ENCRYPTION_KEY;
    const { iv, salt, authTag } = await cryptoModule.encryptFile(originalPath, encryptedPath, encryptionKey);

    // 4. Upload chunk to Telegram
    const chunkTgName = `${safeName}.part${chunkIndex + 1}.enc`;
    const message = await telegram.uploadFile(encryptedPath, chunkTgName);

    // 5. Persist chunk in DB
    db.addUploadSessionChunk({
      id: uuidv4(),
      sessionId: uploadId,
      chunkIndex,
      telegramMessageId: message.id,
      size: req.file.size,
      iv,
      salt,
      authTag
    });

    // 6. Check if all chunks have been received
    const allChunks = db.getUploadedSessionChunks(uploadId);
    if (allChunks.length === totalChunks) {
      return assembleFinalFile(uploadId, userId, safeName, totalFileSize, folderId, totalChunks, allChunks, res);
    }

    return res.json({ success: true, done: false, chunkIndex, uploadedChunks: allChunks.length, totalChunks });
  } catch (error) {
    console.error('Upload chunk error:', error);
    res.status(500).json({ error: 'Chunk upload failed: ' + error.message });
  } finally {
    if (originalPath) await fsPromises.unlink(originalPath).catch(() => {});
    if (encryptedPath) await fsPromises.unlink(encryptedPath).catch(() => {});
  }
});

function checkFileFolderAccess(file, req) {
  if (!file || !file.folder_id) return true;
  try {
    const folder = db.getFolder(file.folder_id);
    if (folder && (folder.is_locked === 1 || Boolean(folder.password_hash))) {
      const token = req.headers['x-folder-token'] || req.query.folderToken;
      const foldersRouter = require('./folders');
      if (foldersRouter.verifyFolderToken && !foldersRouter.verifyFolderToken(file.folder_id, token)) {
        return false;
      }
    }
  } catch (e) {}
  return true;
}

/**
 * Generates a short-lived HMAC-SHA256 signed playback token for HLS streaming
 */
function generatePlaybackToken(fileId, userId) {
  const secret = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || 'teledrive-hls-secret-key';
  const ttl = parseInt(process.env.HLS_PLAYBACK_TOKEN_TTL || '1800', 10);
  return jwt.sign(
    { fileId, userId, type: 'hls_playback' },
    secret,
    { expiresIn: ttl, algorithm: 'HS256' }
  );
}

/**
 * GET /:id/stream — REAL-TIME PROGRESSIVE STREAMING (Plays immediately without waiting for full download!)
 */
router.get('/:id/stream', async (req, res) => {
  try {
    const file = db.getFile(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!checkFileFolderAccess(file, req)) {
      return res.status(403).json({ error: 'Folder is locked. Please unlock the folder to stream this file.' });
    }
    await streamFileToResponse(file, req, res, false, req.user.encryptionKey);
  } catch (error) {
    console.error('Stream handler error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Streaming error: ' + error.message });
  }
});

/**
 * GET /:id/thumbnail — High-performance cached thumbnails for Images and Videos
 */
router.get('/:id/thumbnail', async (req, res) => {
  try {
    const file = db.getFile(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!checkFileFolderAccess(file, req)) {
      return res.status(403).json({ error: 'Folder is locked.' });
    }

    // 1. If static generated thumbnail exists (JPEG), serve with private cache headers
    const thumbPath = path.join(thumbnailsDir, `${file.id}.jpg`);
    if (existsSync(thumbPath)) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      const stream = createReadStream(thumbPath);
      stream.pipe(res);
      req.on('close', () => stream.destroy());
      return;
    }

    const mime = (file.mime_type || '').toLowerCase();
    
    // 2. If image, generate lightweight 240px thumbnail, save permanently to data/thumbnails, and serve
    if (mime.startsWith('image/')) {
      const ok = await runThumbnailTask(() => generateServerImageThumbnailForFile(file, thumbPath, req.user.encryptionKey)).catch(() => false);
      if (ok && existsSync(thumbPath)) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        const stream = createReadStream(thumbPath);
        stream.pipe(res);
        req.on('close', () => stream.destroy());
        return;
      }
      // Fallback: stream original image
      await streamFileToResponse(file, req, res, false, req.user.encryptionKey);
      return;
    }

    // 3. If video, generate thumbnail with FFmpeg on demand, save permanently to data/thumbnails, and serve
    if (mime.startsWith('video/')) {
      const ok = await runThumbnailTask(() => generateServerThumbnailForFile(file, thumbPath, req.user.encryptionKey)).catch(() => false);
      if (ok && existsSync(thumbPath)) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'private, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        const stream = createReadStream(thumbPath);
        stream.pipe(res);
        req.on('close', () => stream.destroy());
        return;
      }
    }

    res.status(404).json({ error: 'Thumbnail not available' });
  } catch (error) {
    console.error('Thumbnail error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to load thumbnail' });
  }
});

/**
 * POST /:id/thumbnail — Store client-extracted thumbnail permanently on server
 */
function isValidImageMagicBytes(buf) {
  if (!buf || buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return true;
  // WebP: RIFF .... WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

router.post('/:id/thumbnail', async (req, res) => {
  try {
    const file = db.getFile(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    let { thumbnail } = req.body;
    if (!thumbnail || typeof thumbnail !== 'string') {
      return res.status(400).json({ error: 'Invalid thumbnail data' });
    }

    const base64Data = thumbnail.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    
    if (buffer.length < 100) {
      return res.status(400).json({ error: 'Thumbnail data too small' });
    }
    const MAX_THUMBNAIL_SIZE = 2 * 1024 * 1024; // 2MB cap
    if (buffer.length > MAX_THUMBNAIL_SIZE) {
      return res.status(400).json({ error: 'Thumbnail exceeds maximum size limit (2MB)' });
    }
    if (!isValidImageMagicBytes(buffer)) {
      return res.status(400).json({ error: 'Invalid image format: must be valid JPEG, PNG, or WebP' });
    }

    const thumbPath = path.join(thumbnailsDir, `${file.id}.jpg`);
    await fsPromises.writeFile(thumbPath, buffer);
    res.json({ success: true });
  } catch (error) {
    console.error('Save thumbnail error:', error);
    res.status(500).json({ error: 'Failed to save thumbnail' });
  }
});

/**
 * GET /:id/download — Download file (Unified full file stream)
 */
router.get('/:id/download', async (req, res) => {
  try {
    const file = db.getFile(req.params.id, req.user.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!checkFileFolderAccess(file, req)) {
      return res.status(403).json({ error: 'Folder is locked. Please unlock the folder to download this file.' });
    }
    await streamFileToResponse(file, req, res, true, req.user.encryptionKey);
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed: ' + error.message });
  }
});

/**
 * GET / — List files (User Isolated)
 */
router.get('/', (req, res) => {
  try {
    const userId = req.user.id;
    const { folderId, search, type, starred, trashed } = req.query;

    if (search) return res.json(db.searchFiles(search, userId));
    if (starred === 'true') return res.json(db.getStarredFiles(userId));
    if (trashed === 'true') return res.json(db.getTrashedFiles(userId));

    let files;
    if (folderId && folderId !== 'null') {
      files = db.all('SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND is_trashed = 0 ORDER BY name ASC', [userId, folderId]);
    } else {
      files = db.all('SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL AND is_trashed = 0 ORDER BY name ASC', [userId]);
    }

    if (type && type !== 'all') {
      const typeMap = {
        'image': ['image/'],
        'video': ['video/'],
        'audio': ['audio/'],
        'document': ['application/pdf', 'application/msword', 'application/vnd.openxmlformats', 'text/'],
        'archive': ['application/zip', 'application/x-rar', 'application/x-7z', 'application/x-tar', 'application/gzip'],
      };
      const prefixes = typeMap[type] || [];
      files = files.filter(f => prefixes.some(p => (f.mime_type || '').startsWith(p)));
    }

    res.json(files);
  } catch (error) {
    console.error('List files error:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * GET /stats — Storage statistics (User Isolated)
 */
router.get('/stats', (req, res) => {
  try {
    const stats = db.getUserStorageStats(req.user.id);
    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

/**
 * PATCH /:id — Update file metadata
 */
router.patch('/:id', (req, res) => {
  try {
    const userId = req.user.id;
    const { name, folder_id, is_starred } = req.body;
    const file = db.getFile(req.params.id, userId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const updates = [];
    const params = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(sanitizeFilename(name));
    }
    if (folder_id !== undefined) {
      updates.push('folder_id = ?');
      params.push(folder_id || null);
    }
    if (is_starred !== undefined) {
      updates.push('is_starred = ?');
      params.push(is_starred ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(req.params.id);
      params.push(userId);
      db.run(`UPDATE files SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    const updatedFile = db.getFile(req.params.id, userId);
    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('file_updated', { file: updatedFile, folderId: updatedFile.folder_id });
    } catch (e) {}
    res.json(updatedFile);
  } catch (error) {
    console.error('Update file error:', error);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

/**
 * Permanently deletes multiple files efficiently in batches (Telegram messages, local cache, DB records).
 * Guaranteed to clean up local SQLite and cache even if Telegram API encounters missing messages or transient errors.
 * @param {Array<Object>} files - Array of file objects from database
 * @param {string} userId - Owner user ID
 * @returns {Promise<{ count: number, warnings: string[] }>}
 */
/**
 * Permanently deletes multiple files.
 * Deletes from Telegram FIRST. Once confirmed (or already gone), cleans DB and cache, and immediately broadcasts realtime file_deleted event so the frontend vanishes the file in real-time.
 * If Telegram deletion fails for a file, that file is NOT removed from DB and remains visible in Trash.
 * @param {Array<Object>} files - Array of file objects from database
 * @param {string} userId - Owner user ID
 * @returns {Promise<{ count: number, warnings: string[], deletedFileIds: string[] }>}
 */
async function permanentlyDeleteFilesBatch(files, userId) {
  if (!Array.isArray(files) || files.length === 0) {
    return { count: 0, warnings: [], deletedFileIds: [] };
  }

  const warnings = [];
  const deletedFileIds = [];
  const eventBroadcaster = require('../services/eventBroadcaster');

  // 1. Map files to their message IDs and index all message IDs
  const fileToMsgIdsMap = new Map();
  const allMsgIds = new Set();

  for (const file of files) {
    if (!file || !file.id) continue;
    const fileMsgIds = new Set();

    if (file.telegram_message_id) {
      const parsed = parseInt(file.telegram_message_id, 10);
      if (!isNaN(parsed) && parsed > 0) fileMsgIds.add(parsed);
    }

    try {
      const chunks = db.getFileChunks(file.id);
      if (Array.isArray(chunks)) {
        for (const ch of chunks) {
          if (ch.telegram_message_id) {
            const parsed = parseInt(ch.telegram_message_id, 10);
            if (!isNaN(parsed) && parsed > 0) fileMsgIds.add(parsed);
          }
        }
      }
    } catch (e) {}

    fileToMsgIdsMap.set(file.id, fileMsgIds);
    for (const msgId of fileMsgIds) {
      allMsgIds.add(msgId);
    }
  }

  // 2. Batch delete message IDs in chunks of up to 100 via Telegram MTProto
  const failedMsgIds = new Set();
  const allIdsArray = Array.from(allMsgIds);
  const TG_BATCH_SIZE = 100;
  const tgBatches = [];

  for (let i = 0; i < allIdsArray.length; i += TG_BATCH_SIZE) {
    tgBatches.push(allIdsArray.slice(i, i + TG_BATCH_SIZE));
  }

  // Concurrency pool to finish 500+ files in ~1-2 seconds without blocking Node event loop
  const CONCURRENCY = 4;
  let batchPtr = 0;

  const worker = async () => {
    while (batchPtr < tgBatches.length) {
      const currentBatch = tgBatches[batchPtr++];
      try {
        await telegram.deleteFiles(currentBatch);
        console.log(`[Batch Delete] Successfully deleted Telegram batch of ${currentBatch.length} message(s)`);
      } catch (tgErr) {
        console.warn(`[Batch Delete] Telegram deletion error for batch of ${currentBatch.length} message(s):`, tgErr.message);
        warnings.push(`Telegram deletion warning: ${tgErr.message}`);
        currentBatch.forEach(id => failedMsgIds.add(id));
      }
    }
  };

  const workers = [];
  const workerCount = Math.min(CONCURRENCY, tgBatches.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  if (workers.length > 0) {
    await Promise.all(workers);
  }

  // 3. Determine which files are ready for DB deletion
  const filesToDelete = [];
  for (const file of files) {
    if (!file || !file.id) continue;
    const msgIds = fileToMsgIdsMap.get(file.id) || new Set();
    // File is ready for deletion if none of its message IDs failed in Telegram
    const hasFailedMsg = Array.from(msgIds).some(id => failedMsgIds.has(id));
    if (!hasFailedMsg) {
      filesToDelete.push(file);
    }
  }

  // 4. Batch clean DB, cache, thumbnails, and broadcast SSE
  if (filesToDelete.length > 0) {
    for (const file of filesToDelete) {
      try { db.deleteFileChunks(file.id); } catch (e) {}
      try { db.deleteTranscodeJob(file.id); } catch (e) {}

      const cachedPath = path.join(cacheDir, `${file.id}.dec`);
      fsPromises.unlink(cachedPath).catch(() => {});
      const thumbPath = path.join(thumbnailsDir, `${file.id}.jpg`);
      fsPromises.unlink(thumbPath).catch(() => {});

      db.run('DELETE FROM video_metadata WHERE file_id = ?', [file.id]);
      if (userId) {
        db.run('DELETE FROM files WHERE id = ? AND user_id = ?', [file.id, userId]);
      } else {
        db.run('DELETE FROM files WHERE id = ?', [file.id]);
      }

      deletedFileIds.push(file.id);

      try {
        eventBroadcaster.broadcast('file_deleted', { fileId: file.id, folderId: file.folder_id, userId });
      } catch (e) {}
    }
  }

  if (userId) {
    db.recalculateUserStorage(userId);
  }

  return { count: deletedFileIds.length, warnings, deletedFileIds };
}

/**
 * Permanently deletes a single file.
 * Telegram is deleted first; on success, cleans DB and broadcasts realtime event.
 * @param {Object} file - File record from database
 * @param {Object} [options={}] - Options
 */
async function permanentlyDeleteFile(file, options = {}) {
  if (!file) return { success: true, count: 0 };
  const eventBroadcaster = require('../services/eventBroadcaster');

  // 1. Collect Telegram message IDs
  const messageIds = new Set();
  if (file.telegram_message_id) {
    const parsed = parseInt(file.telegram_message_id, 10);
    if (!isNaN(parsed) && parsed > 0) messageIds.add(parsed);
  }
  try {
    const chunks = db.getFileChunks(file.id);
    if (Array.isArray(chunks)) {
      for (const ch of chunks) {
        if (ch.telegram_message_id) {
          const parsed = parseInt(ch.telegram_message_id, 10);
          if (!isNaN(parsed) && parsed > 0) messageIds.add(parsed);
        }
      }
    }
  } catch (e) {}

  // 2. Delete from Telegram
  if (messageIds.size > 0) {
    try {
      await telegram.deleteFiles(Array.from(messageIds));
      console.log(`[Delete] Successfully deleted Telegram message(s) for "${file.name}" (${file.id})`);
    } catch (err) {
      console.warn(`[Delete] Telegram message delete error for "${file.name}":`, err.message);
      return { success: false, fileId: file.id, telegramDeleted: false, error: err.message };
    }
  }

  // 3. Clean DB and cache
  try { db.deleteFileChunks(file.id); } catch (e) {}
  try { db.deleteTranscodeJob(file.id); } catch (e) {}

  const cachedPath = path.join(cacheDir, `${file.id}.dec`);
  await fsPromises.unlink(cachedPath).catch(() => {});
  const thumbPath = path.join(thumbnailsDir, `${file.id}.jpg`);
  await fsPromises.unlink(thumbPath).catch(() => {});

  db.run('DELETE FROM video_metadata WHERE file_id = ?', [file.id]);
  if (file.user_id) {
    db.run('DELETE FROM files WHERE id = ? AND user_id = ?', [file.id, file.user_id]);
    db.recalculateUserStorage(file.user_id);
  } else {
    db.run('DELETE FROM files WHERE id = ?', [file.id]);
  }

  try {
    eventBroadcaster.broadcast('file_deleted', { fileId: file.id, folderId: file.folder_id, userId: file.user_id });
  } catch (e) {}

  return { success: true, fileId: file.id, telegramDeleted: true };
}

/**
 * 30-Day Automated Trash Purge Worker
 * Automatically removes items that have been in Trash for more than 30 days.
 */
async function purgeExpiredTrash() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const expiredFiles = db.all('SELECT * FROM files WHERE is_trashed = 1 AND trashed_at IS NOT NULL AND trashed_at <= ?', [thirtyDaysAgo]);

    if (expiredFiles.length > 0) {
      console.log(`[Auto-Purge] Found ${expiredFiles.length} file(s) in Trash older than 30 days. Purging...`);
      for (const file of expiredFiles) {
        await permanentlyDeleteFile(file, { throwOnError: false });
      }
      console.log(`[Auto-Purge] Successfully purged ${expiredFiles.length} expired file(s) from Telegram and database.`);
    }
  } catch (err) {
    console.error('[Auto-Purge] Error during 30-day trash auto-purge:', err);
  }
}

// Run 30-day auto-purge every 6 hours
setInterval(purgeExpiredTrash, 6 * 3600 * 1000).unref();
// Run on startup
setTimeout(purgeExpiredTrash, 30 * 1000).unref();

/**
 * Automated Incomplete Upload Sessions Purge Worker
 * Purges unfinished upload sessions older than 24h and deletes any orphaned Telegram chunks.
 */
async function purgeExpiredUploadSessions() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const expiredSessions = db.getExpiredUploadSessions(oneDayAgo);
    if (expiredSessions && expiredSessions.length > 0) {
      console.log(`[Auto-Purge] Found ${expiredSessions.length} abandoned upload session(s) older than 24h. Purging...`);
      for (const session of expiredSessions) {
        try {
          const chunks = db.getUploadedSessionChunks(session.id);
          if (chunks && chunks.length > 0) {
            const msgIds = chunks.map(ch => parseInt(ch.telegram_message_id, 10)).filter(id => !isNaN(id) && id > 0);
            if (msgIds.length > 0) {
              await telegram.deleteFiles(msgIds).catch(() => {});
            }
          }
          db.deleteUploadSession(session.id, session.user_id);
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('[Auto-Purge] Error during expired upload sessions purge:', err.message);
  }
}

// Run expired upload sessions purge every 6 hours and on startup
setInterval(purgeExpiredUploadSessions, 6 * 3600 * 1000).unref();
setTimeout(purgeExpiredUploadSessions, 60 * 1000).unref();

/**
 * DELETE /trash/empty — Empty all files currently in Trash for this user
 */
router.delete('/trash/empty', async (req, res) => {
  try {
    const userId = req.user.id;
    const trashedFiles = db.getTrashedFiles(userId);
    
    const result = await permanentlyDeleteFilesBatch(trashedFiles, userId);

    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('trash_emptied', { userId });
    } catch (e) {}

    res.json({
      success: true,
      count: result.count,
      warnings: result.warnings && result.warnings.length > 0 ? result.warnings : undefined
    });
  } catch (error) {
    console.error('Empty trash error:', error);
    res.status(500).json({ error: 'Failed to empty trash: ' + error.message });
  }
});

/**
 * DELETE /:id — Move to Trash (Soft delete, keeps file intact on Telegram)
 */
router.delete('/:id', (req, res) => {
  try {
    const userId = req.user.id;
    const file = db.getFile(req.params.id, userId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    db.run('UPDATE files SET is_trashed = 1, trashed_at = ? WHERE id = ? AND user_id = ?', [new Date().toISOString(), req.params.id, userId]);
    if (userId) db.recalculateUserStorage(userId);
    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('file_deleted', { fileId: req.params.id, folderId: file.folder_id, userId });
    } catch (e) {}
    res.json({ success: true });
  } catch (error) {
    console.error('Soft delete error:', error);
    res.status(500).json({ error: 'Failed to trash file' });
  }
});

/**
 * DELETE /:id/permanent — Hard delete (Manually deletes all parts from Telegram & DB)
 */
router.delete('/:id/permanent', async (req, res) => {
  try {
    const userId = req.user.id;
    const file = db.getFile(req.params.id, userId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const folderId = file.folder_id;

    const result = await permanentlyDeleteFile(file, { throwOnError: false });
    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('file_deleted', { fileId: req.params.id, folderId, userId });
    } catch (e) {}
    res.json({ success: true, warning: result.telegramDeleted ? undefined : 'File removed from database and cache. Telegram message was already removed or unreachable.' });
  } catch (error) {
    console.error('Permanent delete error:', error);
    res.status(500).json({ error: error.message || 'Failed to permanently delete file' });
  }
});

/**
 * POST /:id/restore — Restore from trash
 */
router.post('/:id/restore', (req, res) => {
  try {
    const userId = req.user.id;
    const file = db.getFile(req.params.id, userId);
    if (!file) return res.status(404).json({ error: 'File not found' });

    db.run('UPDATE files SET is_trashed = 0, trashed_at = NULL WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (userId) db.recalculateUserStorage(userId);
    const restoredFile = db.getFile(req.params.id, userId);
    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('file_uploaded', { file: restoredFile, folderId: restoredFile ? restoredFile.folder_id : null, userId });
    } catch (e) {}
    res.json({ success: true });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ error: 'Failed to restore file' });
  }
});

/**
 * POST /batch-trash — Move multiple files and folders to trash
 */
router.post('/batch-trash', async (req, res) => {
  try {
    const userId = req.user.id;
    const { fileIds = [], folderIds = [] } = req.body;
    const now = new Date().toISOString();
    let trashedFilesCount = 0;
    let trashedFoldersCount = 0;

    // Trash files
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      for (const id of fileIds) {
        db.run('UPDATE files SET is_trashed = 1, trashed_at = ? WHERE id = ? AND user_id = ?', [now, id, userId]);
        trashedFilesCount++;
      }
    }

    // Trash folders recursively
    if (Array.isArray(folderIds) && folderIds.length > 0) {
      const foldersRouter = require('./folders');
      for (const folderId of folderIds) {
        if (foldersRouter.deleteFolderRecursive) {
          const r = await foldersRouter.deleteFolderRecursive(folderId, userId);
          trashedFilesCount += r.deletedFiles || 0;
          trashedFoldersCount += r.deletedFolders || 0;
        }
      }
    }

    res.json({ success: true, trashedFilesCount, trashedFoldersCount });
  } catch (error) {
    console.error('Batch trash error:', error);
    res.status(500).json({ error: 'Failed to trash selected items' });
  }
});

/**
 * POST /batch-restore — Restore multiple files from trash
 */
router.post('/batch-restore', (req, res) => {
  try {
    const userId = req.user.id;
    const { fileIds = [] } = req.body;
    let restoredCount = 0;

    if (Array.isArray(fileIds) && fileIds.length > 0) {
      for (const id of fileIds) {
        db.run('UPDATE files SET is_trashed = 0, trashed_at = NULL WHERE id = ? AND user_id = ?', [id, userId]);
        restoredCount++;
      }
    }

    res.json({ success: true, restoredCount });
  } catch (error) {
    console.error('Batch restore error:', error);
    res.status(500).json({ error: 'Failed to restore selected files' });
  }
});

/**
 * POST /batch-delete — Permanently delete multiple files and folders
 */
router.post('/batch-delete', async (req, res) => {
  try {
    const userId = req.user.id;
    const { fileIds = [], folderIds = [] } = req.body;
    let deletedFilesCount = 0;
    let deletedFoldersCount = 0;
    const warnings = [];

    // 1. Collect all target files
    const filesToDelete = [];
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      for (const id of fileIds) {
        const file = db.getFile(id, userId);
        if (file) {
          filesToDelete.push(file);
        }
      }
    }

    // 2. Permanently delete folders
    if (Array.isArray(folderIds) && folderIds.length > 0) {
      const foldersRouter = require('./folders');
      for (const folderId of folderIds) {
        try {
          if (foldersRouter.permanentlyDeleteFolderRecursive) {
            const r = await foldersRouter.permanentlyDeleteFolderRecursive(folderId, userId);
            deletedFilesCount += r.deletedFiles || 0;
            deletedFoldersCount += r.deletedFolders || 0;
          }
        } catch (err) {
          warnings.push(`Folder ${folderId}: ${err.message}`);
        }
      }
    }

    // 3. Batch delete files
    if (filesToDelete.length > 0) {
      const result = await permanentlyDeleteFilesBatch(filesToDelete, userId);
      deletedFilesCount += result.count;
      if (result.warnings && result.warnings.length > 0) {
        warnings.push(...result.warnings);
      }
    }

    if (userId) db.recalculateUserStorage(userId);

    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      for (const f of filesToDelete) {
        eventBroadcaster.broadcast('file_deleted', { fileId: f.id, folderId: f.folder_id, userId });
      }
      if (Array.isArray(folderIds)) {
        for (const fId of folderIds) {
          eventBroadcaster.broadcast('folder_deleted', { folderId: fId, userId });
        }
      }
    } catch (e) {}

    res.json({
      success: true,
      deletedFilesCount,
      deletedFoldersCount,
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (error) {
    console.error('Batch delete error:', error);
    res.status(500).json({ error: 'Failed to permanently delete selected items: ' + error.message });
  }
});

/**
 * POST /batch-star — Star or unstar multiple files
 */
router.post('/batch-star', (req, res) => {
  try {
    const userId = req.user.id;
    const { fileIds = [], isStarred = true } = req.body;
    const now = new Date().toISOString();
    const starVal = isStarred ? 1 : 0;
    let updatedCount = 0;

    if (Array.isArray(fileIds) && fileIds.length > 0) {
      for (const id of fileIds) {
        db.run('UPDATE files SET is_starred = ?, updated_at = ? WHERE id = ? AND user_id = ?', [starVal, now, id, userId]);
        updatedCount++;
      }
    }

    res.json({ success: true, updatedCount });
  } catch (error) {
    console.error('Batch star error:', error);
    res.status(500).json({ error: 'Failed to update star state' });
  }
});

/**
 * POST /batch-move — Move multiple files and folders
 */
router.post('/batch-move', async (req, res) => {
  try {
    const userId = req.user.id;
    const { fileIds = [], folderIds = [], targetFolderId = null } = req.body;
    const destination = (targetFolderId && targetFolderId !== 'null') ? targetFolderId : null;
    const now = new Date().toISOString();
    let movedFilesCount = 0;
    let movedFoldersCount = 0;

    // Move files
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      for (const id of fileIds) {
        db.run('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ? AND user_id = ?', [destination, now, id, userId]);
        movedFilesCount++;
      }
    }

    // Move folders
    if (Array.isArray(folderIds) && folderIds.length > 0) {
      for (const id of folderIds) {
        if (destination !== id) {
          db.run('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ? AND user_id = ?', [destination, now, id, userId]);
          movedFoldersCount++;
        }
      }
    }

    res.json({ success: true, movedFilesCount, movedFoldersCount });
  } catch (error) {
    console.error('Batch move error:', error);
    res.status(500).json({ error: 'Failed to move selected items' });
  }
});

router.permanentlyDeleteFile = permanentlyDeleteFile;
router.permanentlyDeleteFilesBatch = permanentlyDeleteFilesBatch;
router.streamFileToResponse = streamFileToResponse;
module.exports = router;
