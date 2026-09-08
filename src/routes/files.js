const express = require('express');
const multer = require('multer');
const fsPromises = require('fs/promises');
const { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, copyFileSync } = require('fs');
const path = require('path');
const crypto = require('crypto');
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

if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

const upload = multer({ dest: tmpDir, limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB max

const activeChunkSessions = new Map();

// Session cleaner for expired chunk sessions (after 6 hours)
setInterval(() => {
  const now = Date.now();
  for (const [uploadId, session] of activeChunkSessions.entries()) {
    if (now - session.createdAt > 6 * 3600 * 1000) {
      activeChunkSessions.delete(uploadId);
    }
  }
}, 30 * 60 * 1000).unref();

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.avif': 'image/avif', '.tiff': 'image/tiff', '.tif': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma', '.m4a': 'audio/mp4',
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
 * Unified Stream/Download Pipe Helper
 */
async function streamFileToResponse(file, req, res, isDownload = false) {
  const cachedPath = path.join(cacheDir, `${file.id}.dec`);

  // 1. If cached, serve from cache with Range request support
  if (existsSync(cachedPath)) {
    try {
      const stats = statSync(cachedPath);
      if (stats.size === file.size) {
        const range = req.headers.range;
        const fileSize = stats.size;

        if (range && !isDownload) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

          if (start >= fileSize || end >= fileSize) {
            res.status(416).header('Content-Range', `bytes */${fileSize}`).send();
            return;
          }

          const chunksize = (end - start) + 1;
          const fileStream = createReadStream(cachedPath, { start, end });

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': file.mime_type || 'application/octet-stream',
            'Content-Disposition': isDownload ? `attachment; filename="${encodeURIComponent(file.name)}"` : 'inline',
          });

          fileStream.pipe(res);
          req.on('close', () => fileStream.destroy());
          return;
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': file.mime_type || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Disposition': isDownload ? `attachment; filename="${encodeURIComponent(file.name)}"` : 'inline',
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

  // 2. Stream from Telegram on-the-fly
  console.log(`[Stream] Streaming "${file.name}" (${file.id}, chunked: ${file.is_chunked})...`);

  let partsToStream = [];
  if (file.is_chunked === 1) {
    partsToStream = db.getFileChunks(file.id);
  } else {
    partsToStream = [{
      chunk_index: 0,
      telegram_message_id: file.telegram_message_id,
      size: file.size,
      iv: file.iv,
      salt: file.salt
    }];
  }

  if (partsToStream.length === 0) {
    return res.status(404).json({ error: 'File parts not found' });
  }

  res.writeHead(200, {
    'Content-Type': file.mime_type || 'application/octet-stream',
    'Content-Length': file.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': isDownload ? `attachment; filename="${encodeURIComponent(file.name)}"` : 'inline',
  });

  const cacheWriteStream = createWriteStream(cachedPath);
  let isClientClosed = false;
  req.on('close', () => {
    isClientClosed = true;
  });

  try {
    for (const part of partsToStream) {
      if (isClientClosed) break;

      const key = cryptoModule.deriveKey(process.env.ENCRYPTION_KEY, part.salt);
      const iv = Buffer.from(part.iv, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

      let totalEncReceived = 0;
      const expectedPartSize = part.size;

      for await (const chunk of telegram.iterDownloadFile(part.telegram_message_id, 256 * 1024)) {
        if (isClientClosed) break;
        totalEncReceived += chunk.length;

        let cipherChunk = chunk;
        if (totalEncReceived > expectedPartSize) {
          const overflow = totalEncReceived - expectedPartSize;
          cipherChunk = chunk.subarray(0, chunk.length - overflow);
        }

        if (cipherChunk.length > 0) {
          const decrypted = decipher.update(cipherChunk);
          if (!isClientClosed) {
            res.write(decrypted);
          }
          cacheWriteStream.write(decrypted);
        }
      }
    }

    cacheWriteStream.end();
    if (!isClientClosed) {
      res.end();
    }
  } catch (err) {
    console.error('[Stream] Streaming error:', err);
    cacheWriteStream.end();
    if (!isClientClosed && !res.headersSent) {
      res.status(500).json({ error: 'Streaming failed: ' + err.message });
    }
  }
}

/**
 * POST /upload — Upload single file with AES-256-GCM encryption + Instant Local Cache
 */
router.post('/upload', uploadLimiter, upload.single('file'), async (req, res) => {
  let originalPath = null;
  let encryptedPath = null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const folderId = req.body.folderId || null;
    const safeName = sanitizeFilename(req.file.originalname);
    const fileId = uuidv4();

    originalPath = req.file.path;
    encryptedPath = originalPath + '.enc';

    // 1. Immediately place in local cache so newly uploaded files play with 0ms delay!
    const cachedPath = path.join(cacheDir, `${fileId}.dec`);
    copyFileSync(originalPath, cachedPath);

    // 2. Encrypt file using AES-256-GCM
    const encryptionKey = process.env.ENCRYPTION_KEY;
    const { iv, salt, authTag } = await cryptoModule.encryptFile(originalPath, encryptedPath, encryptionKey);

    // 3. Upload encrypted file to Telegram
    const message = await telegram.uploadFile(encryptedPath, safeName + '.enc');

    // 4. Save metadata to SQLite
    const mimeType = getMimeType(safeName);
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO files (id, name, mime_type, size, folder_id, telegram_message_id, iv, salt, is_starred, is_trashed, is_chunked, total_chunks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, ?, ?)`,
      [fileId, safeName, mimeType, req.file.size, folderId, message.id, iv, salt, now, now]
    );

    const fileRecord = db.getFile(fileId);
    res.json({ success: true, file: fileRecord });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed: ' + error.message });
  } finally {
    if (originalPath) await fsPromises.unlink(originalPath).catch(() => {});
    if (encryptedPath) await fsPromises.unlink(encryptedPath).catch(() => {});
  }
});

/**
 * POST /upload-chunk — Auto-Chunked Upload for Large Files (>2GB)
 */
router.post('/upload-chunk', uploadLimiter, upload.single('file'), async (req, res) => {
  let originalPath = null;
  let encryptedPath = null;

  try {
    if (!req.file) return res.status(400).json({ error: 'No chunk uploaded' });

    const uploadId = req.body.uploadId;
    const chunkIndex = parseInt(req.body.chunkIndex, 10);
    const totalChunks = parseInt(req.body.totalChunks, 10);
    const fileName = req.body.fileName || req.file.originalname;
    const totalFileSize = parseInt(req.body.fileSize, 10) || req.file.size;
    const folderId = req.body.folderId || null;

    if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
      return res.status(400).json({ error: 'Missing chunk metadata' });
    }

    const safeName = sanitizeFilename(fileName);
    originalPath = req.file.path;
    encryptedPath = originalPath + '.enc';

    // 1. Encrypt this chunk with AES-256-GCM
    const encryptionKey = process.env.ENCRYPTION_KEY;
    const { iv, salt, authTag } = await cryptoModule.encryptFile(originalPath, encryptedPath, encryptionKey);

    // 2. Upload this chunk to Telegram
    const chunkTgName = `${safeName}.part${chunkIndex + 1}.enc`;
    const message = await telegram.uploadFile(encryptedPath, chunkTgName);

    // 3. Track session
    if (!activeChunkSessions.has(uploadId)) {
      activeChunkSessions.set(uploadId, {
        uploadId,
        fileName: safeName,
        totalFileSize,
        folderId,
        totalChunks,
        createdAt: Date.now(),
        chunks: []
      });
    }

    const session = activeChunkSessions.get(uploadId);
    session.chunks.push({
      id: uuidv4(),
      chunkIndex,
      telegramMessageId: message.id,
      size: req.file.size,
      iv,
      salt
    });

    // 4. Check if all chunks have been received
    if (session.chunks.length === totalChunks) {
      session.chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

      const fileId = uploadId;
      const mimeType = getMimeType(safeName);
      const now = new Date().toISOString();
      const firstChunk = session.chunks[0];

      db.run(
        `INSERT INTO files (id, name, mime_type, size, folder_id, telegram_message_id, iv, salt, is_starred, is_trashed, is_chunked, total_chunks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
        [fileId, safeName, mimeType, totalFileSize, folderId, firstChunk.telegramMessageId, firstChunk.iv, firstChunk.salt, totalChunks > 1 ? 1 : 0, totalChunks, now, now]
      );

      // Insert each chunk into file_chunks table
      for (const ch of session.chunks) {
        db.addFileChunk({
          id: ch.id,
          fileId,
          chunkIndex: ch.chunkIndex,
          telegramMessageId: ch.telegramMessageId,
          size: ch.size,
          iv: ch.iv,
          salt: ch.salt
        });
      }

      activeChunkSessions.delete(uploadId);
      const fileRecord = db.getFile(fileId);
      return res.json({ success: true, done: true, file: fileRecord });
    }

    return res.json({ success: true, done: false, chunkIndex, uploadedChunks: session.chunks.length, totalChunks });
  } catch (error) {
    console.error('Upload chunk error:', error);
    res.status(500).json({ error: 'Chunk upload failed: ' + error.message });
  } finally {
    if (originalPath) await fsPromises.unlink(originalPath).catch(() => {});
    if (encryptedPath) await fsPromises.unlink(encryptedPath).catch(() => {});
  }
});

/**
 * GET /:id/stream — REAL-TIME PROGRESSIVE STREAMING (Plays immediately without waiting for full download!)
 */
router.get('/:id/stream', async (req, res) => {
  try {
    const file = db.getFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    await streamFileToResponse(file, req, res, false);
  } catch (error) {
    console.error('Stream handler error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Streaming error: ' + error.message });
  }
});

/**
 * GET /:id/thumbnail — Inline Thumbnail for Images & Videos
 */
router.get('/:id/thumbnail', async (req, res) => {
  try {
    const file = db.getFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const cachedPath = path.join(cacheDir, `${file.id}.dec`);

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (existsSync(cachedPath) && statSync(cachedPath).size === file.size) {
      res.setHeader('Content-Length', file.size);
      const stream = createReadStream(cachedPath);
      stream.pipe(res);
      req.on('close', () => stream.destroy());
      return;
    }

    // Stream on-the-fly (for thumbnail, we only need the first part)
    const targetMsgId = file.telegram_message_id;
    const targetSalt = file.salt;
    const targetIv = file.iv;
    const targetSize = file.size;

    const key = cryptoModule.deriveKey(process.env.ENCRYPTION_KEY, targetSalt);
    const iv = Buffer.from(targetIv, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

    const cacheWriteStream = createWriteStream(cachedPath);
    let totalEnc = 0;

    for await (const chunk of telegram.iterDownloadFile(targetMsgId, 256 * 1024)) {
      totalEnc += chunk.length;
      let cipherChunk = chunk;
      if (totalEnc > targetSize) {
        const overflow = totalEnc - targetSize;
        cipherChunk = chunk.subarray(0, chunk.length - overflow);
      }
      if (cipherChunk.length > 0) {
        const dec = decipher.update(cipherChunk);
        res.write(dec);
        cacheWriteStream.write(dec);
      }
    }

    cacheWriteStream.end();
    res.end();
  } catch (error) {
    console.error('Thumbnail error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to load thumbnail' });
  }
});

/**
 * GET /:id/download — Download file (Unified full file stream)
 */
router.get('/:id/download', async (req, res) => {
  try {
    const file = db.getFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });
    await streamFileToResponse(file, req, res, true);
  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed: ' + error.message });
  }
});

/**
 * GET / — List files
 */
router.get('/', (req, res) => {
  try {
    const { folderId, search, type, starred, trashed } = req.query;

    if (search) return res.json(db.searchFiles(search));
    if (starred === 'true') return res.json(db.getStarredFiles());
    if (trashed === 'true') return res.json(db.getTrashedFiles());

    let files;
    if (folderId && folderId !== 'null') {
      files = db.all('SELECT * FROM files WHERE folder_id = ? AND is_trashed = 0 ORDER BY name ASC', [folderId]);
    } else {
      files = db.all('SELECT * FROM files WHERE folder_id IS NULL AND is_trashed = 0 ORDER BY name ASC');
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
 * GET /stats — Storage statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = db.getStorageStats();
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
    const { name, folder_id, is_starred } = req.body;
    const file = db.getFile(req.params.id);
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
      db.run(`UPDATE files SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const updatedFile = db.getFile(req.params.id);
    res.json(updatedFile);
  } catch (error) {
    console.error('Update file error:', error);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

/**
 * DELETE /:id — Soft delete
 */
router.delete('/:id', (req, res) => {
  try {
    db.run('UPDATE files SET is_trashed = 1, trashed_at = ? WHERE id = ?', [new Date().toISOString(), req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Soft delete error:', error);
    res.status(500).json({ error: 'Failed to trash file' });
  }
});

/**
 * DELETE /:id/permanent — Hard delete (deletes all chunks from Telegram & DB)
 */
router.delete('/:id/permanent', async (req, res) => {
  try {
    const file = db.getFile(req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found' });

    // Delete chunked parts from Telegram if multi-chunk
    if (file.is_chunked === 1) {
      const chunks = db.getFileChunks(file.id);
      for (const ch of chunks) {
        try {
          await telegram.deleteFile(ch.telegram_message_id);
        } catch (tgError) {
          console.warn(`[Delete] Telegram chunk delete error (${ch.chunk_index}):`, tgError.message);
        }
      }
      db.deleteFileChunks(file.id);
    } else if (file.telegram_message_id) {
      try {
        await telegram.deleteFile(file.telegram_message_id);
      } catch (tgError) {
        console.warn('Telegram delete error:', tgError.message);
      }
    }

    const cachedPath = path.join(cacheDir, `${file.id}.dec`);
    await fsPromises.unlink(cachedPath).catch(() => {});

    db.run('DELETE FROM files WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Permanent delete error:', error);
    res.status(500).json({ error: 'Failed to permanently delete file' });
  }
});

/**
 * POST /:id/restore — Restore from trash
 */
router.post('/:id/restore', (req, res) => {
  try {
    db.run('UPDATE files SET is_trashed = 0, trashed_at = NULL WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ error: 'Failed to restore file' });
  }
});

module.exports = router;
