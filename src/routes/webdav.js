const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const webdavAuth = require('../middleware/webdavAuth');
const db = require('../db');
const telegram = require('../telegram');
const cryptoModule = require('../crypto');

const router = express.Router();

// Apply WebDAV Authentication & Permissions middleware
router.use(webdavAuth);

const dataDir = path.join(__dirname, '../../data');
const tmpDir = path.join(dataDir, 'tmp');
const cacheDir = path.join(dataDir, 'cache');

if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

/**
 * Escape XML special characters
 */
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format Date to RFC1123 format (e.g., Thu, 01 Jan 1970 00:00:00 GMT)
 */
function toRFC1123(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

/**
 * Format Date to ISO8601 format
 */
function toISO8601(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/**
 * Determine MIME type by filename
 */
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.txt': 'text/plain', '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Resolve a WebDAV URL path into database folder and file items
 * e.g., "/FolderA/SubB/myfile.txt" -> { type: 'file', item: fileRecord, parentId: '...' }
 */
function resolveWebdavPath(requestPath) {
  // Normalize and decode URI path
  let cleanPath = decodeURIComponent(requestPath || '')
    .replace(/^\/DavWWWRoot\/webdav/i, '')
    .replace(/^\/DavWWWRoot/i, '')
    .replace(/^\/webdav/i, '');
  cleanPath = cleanPath.replace(/^\/+|\/+$/g, ''); // strip leading/trailing slashes

  if (!cleanPath) {
    return { type: 'root', parentId: null };
  }

  const segments = cleanPath.split('/').filter(Boolean);
  let currentParentId = null;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = (i === segments.length - 1);

    // Look for a folder with this name under currentParentId
    const folder = db.get(
      'SELECT * FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))',
      [segment, currentParentId, currentParentId]
    );

    if (folder) {
      if (isLast) {
        return { type: 'folder', item: folder, parentId: currentParentId };
      }
      currentParentId = folder.id;
      continue;
    }

    if (isLast) {
      // Check if it matches a file under currentParentId
      const file = db.get(
        'SELECT * FROM files WHERE name = ? AND is_trashed = 0 AND (folder_id = ? OR (folder_id IS NULL AND ? IS NULL))',
        [segment, currentParentId, currentParentId]
      );

      if (file) {
        return { type: 'file', item: file, parentId: currentParentId };
      }

      return { type: 'not_found', name: segment, parentId: currentParentId };
    }

    // Intermediate folder not found
    return { type: 'not_found', name: segment, parentId: currentParentId };
  }

  return { type: 'root', parentId: null };
}

/**
 * Generate WebDAV XML response for a Folder
 */
function renderFolderXml(folderHref, folderName, createdAt, updatedAt) {
  const href = folderHref.endsWith('/') ? folderHref : `${folderHref}/`;
  return `
    <D:response>
      <D:href>${escapeXml(href)}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype><D:collection/></D:resourcetype>
          <D:displayname>${escapeXml(folderName || 'Root')}</D:displayname>
          <D:creationdate>${toISO8601(createdAt)}</D:creationdate>
          <D:getlastmodified>${toRFC1123(updatedAt || createdAt)}</D:getlastmodified>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`;
}

/**
 * Generate WebDAV XML response for a File
 */
function renderFileXml(fileHref, file) {
  return `
    <D:response>
      <D:href>${escapeXml(fileHref)}</D:href>
      <D:propstat>
        <D:prop>
          <D:resourcetype/>
          <D:displayname>${escapeXml(file.name)}</D:displayname>
          <D:getcontentlength>${file.size || 0}</D:getcontentlength>
          <D:getcontenttype>${escapeXml(file.mime_type || getMimeType(file.name))}</D:getcontenttype>
          <D:creationdate>${toISO8601(file.created_at)}</D:creationdate>
          <D:getlastmodified>${toRFC1123(file.updated_at || file.created_at)}</D:getlastmodified>
          <D:getetag>"${file.id}_${new Date(file.updated_at || file.created_at).getTime()}"</D:getetag>
        </D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>`;
}

// ─── WebDAV PROPFIND Handler (Directory & File Tree Listing) ──────────
router.all('*', async (req, res, next) => {
  const method = req.method.toUpperCase();

  if (method !== 'PROPFIND') {
    return next();
  }

  const depth = req.headers['depth'] || '1'; // '0', '1', or 'infinity'
  const resolved = resolveWebdavPath(req.path);
  const basePath = '/webdav' + (req.path.replace(/^\/webdav/, '') || '/').replace(/\/+$/, '');

  let responsesXml = '';

  if (resolved.type === 'root') {
    // 1. Root Collection
    responsesXml += renderFolderXml('/webdav/', 'TeleDrive', null, null);

    if (depth !== '0') {
      // List root folders
      const rootFolders = db.all('SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name ASC');
      for (const f of rootFolders) {
        responsesXml += renderFolderXml(`/webdav/${encodeURIComponent(f.name)}/`, f.name, f.created_at, f.updated_at);
      }

      // List root files
      const rootFiles = db.all('SELECT * FROM files WHERE folder_id IS NULL AND is_trashed = 0 ORDER BY name ASC');
      for (const f of rootFiles) {
        responsesXml += renderFileXml(`/webdav/${encodeURIComponent(f.name)}`, f);
      }
    }
  } else if (resolved.type === 'folder') {
    // 2. Specific Folder
    const folder = resolved.item;
    responsesXml += renderFolderXml(`${basePath}/`, folder.name, folder.created_at, folder.updated_at);

    if (depth !== '0') {
      // Subfolders
      const subFolders = db.all('SELECT * FROM folders WHERE parent_id = ? ORDER BY name ASC', [folder.id]);
      for (const f of subFolders) {
        responsesXml += renderFolderXml(`${basePath}/${encodeURIComponent(f.name)}/`, f.name, f.created_at, f.updated_at);
      }

      // Files in folder
      const files = db.all('SELECT * FROM files WHERE folder_id = ? AND is_trashed = 0 ORDER BY name ASC', [folder.id]);
      for (const f of files) {
        responsesXml += renderFileXml(`${basePath}/${encodeURIComponent(f.name)}`, f);
      }
    }
  } else if (resolved.type === 'file') {
    // 3. Single File
    const file = resolved.item;
    responsesXml += renderFileXml(basePath, file);
  } else {
    return res.status(404).set('Content-Type', 'text/plain').send('Resource not found');
  }

  const xml = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  ${responsesXml}
</D:multistatus>`;

  res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(xml);
});

// ─── WebDAV GET & HEAD Handler (Stream / Download Files) ───────────────
router.get('*', async (req, res) => {
  const resolved = resolveWebdavPath(req.path);

  if (resolved.type === 'root' || resolved.type === 'folder') {
    // Return simple directory listing HTML for web browsers
    const folderName = resolved.type === 'root' ? 'TeleDrive Root' : resolved.item.name;
    const folderId = resolved.type === 'root' ? null : resolved.item.id;

    const folders = db.all('SELECT * FROM folders WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL)) ORDER BY name ASC', [folderId, folderId]);
    const files = db.all('SELECT * FROM files WHERE is_trashed = 0 AND (folder_id = ? OR (folder_id IS NULL AND ? IS NULL)) ORDER BY name ASC', [folderId, folderId]);

    let html = `<html><head><title>${escapeXml(folderName)} - WebDAV</title></head><body>`;
    html += `<h2>Index of ${escapeXml(req.path)}</h2><hr><ul>`;
    html += `<li><a href="../">../ (Parent Directory)</a></li>`;
    for (const f of folders) html += `<li>📁 <a href="./${encodeURIComponent(f.name)}/">${escapeXml(f.name)}/</a></li>`;
    for (const f of files) html += `<li>📄 <a href="./${encodeURIComponent(f.name)}">${escapeXml(f.name)}</a> (${(f.size / 1024).toFixed(1)} KB)</li>`;
    html += `</ul><hr><i>TeleDrive WebDAV Storage</i></body></html>`;
    return res.status(200).set('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  if (resolved.type !== 'file') {
    return res.status(404).set('Content-Type', 'text/plain').send('File not found');
  }

  const file = resolved.item;
  const cachedPath = path.join(cacheDir, `${file.id}.dec`);
  const fileSize = file.size;

  // Handle Range Header for media players and streaming
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
    }
  }

  // 1. If in local decryption cache, stream from cache
  if (fs.existsSync(cachedPath)) {
    try {
      const stats = fs.statSync(cachedPath);
      if (stats.size === fileSize) {
        if (isRangeRequest) {
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': (end - start) + 1,
            'Content-Type': file.mime_type || getMimeType(file.name),
            'ETag': `"${file.id}"`,
          });
          const stream = fs.createReadStream(cachedPath, { start, end });
          return stream.pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': file.mime_type || getMimeType(file.name),
            'Accept-Ranges': 'bytes',
            'ETag': `"${file.id}"`,
          });
          const stream = fs.createReadStream(cachedPath);
          return stream.pipe(res);
        }
      }
    } catch (e) {}
  }

  // 2. Stream from Telegram on-demand
  try {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) throw new Error('Encryption key not configured');

    const tempDecPath = path.join(tmpDir, `webdav_get_${file.id}_${Date.now()}.dec`);
    const tempEncPath = path.join(tmpDir, `webdav_get_${file.id}_${Date.now()}.enc`);

    // Download & Decrypt to cache/tmp
    await telegram.downloadFile(file.telegram_message_id, tempEncPath);
    await cryptoModule.decryptFile(tempEncPath, tempDecPath, encryptionKey, file.iv, file.salt);

    // Save to cache for ultra-fast subsequent reads
    try { fs.copyFileSync(tempDecPath, cachedPath); } catch (e) {}
    try { fs.unlinkSync(tempEncPath); } catch (e) {}

    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': file.mime_type || getMimeType(file.name),
      'Accept-Ranges': 'bytes',
      'ETag': `"${file.id}"`,
    });

    const stream = fs.createReadStream(tempDecPath);
    stream.pipe(res);
    stream.on('close', () => {
      try { if (fs.existsSync(tempDecPath)) fs.unlinkSync(tempDecPath); } catch (e) {}
    });
  } catch (err) {
    console.error('[WebDAV GET Error]', err);
    if (!res.headersSent) {
      res.status(500).set('Content-Type', 'text/plain').send('Error reading file from storage: ' + err.message);
    }
  }
});

router.head('*', async (req, res) => {
  const resolved = resolveWebdavPath(req.path);
  if (resolved.type === 'file') {
    const file = resolved.item;
    res.status(200).set({
      'Content-Length': file.size || 0,
      'Content-Type': file.mime_type || getMimeType(file.name),
      'Accept-Ranges': 'bytes',
      'ETag': `"${file.id}"`,
    }).end();
  } else if (resolved.type === 'root' || resolved.type === 'folder') {
    res.status(200).set('Content-Type', 'text/html').end();
  } else {
    res.status(404).end();
  }
});

// ─── WebDAV PUT Handler (Upload & Save/Edit Files) ─────────────────────
router.put('*', async (req, res) => {
  const cleanPath = decodeURIComponent(req.path || '').replace(/^\/webdav/, '');
  const segments = cleanPath.split('/').filter(Boolean);

  if (segments.length === 0) {
    return res.status(400).set('Content-Type', 'text/plain').send('Cannot PUT to root collection.');
  }

  const filename = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);

  // Resolve or create parent directory tree
  let parentFolderId = null;
  for (const dir of dirSegments) {
    let folder = db.get(
      'SELECT * FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))',
      [dir, parentFolderId, parentFolderId]
    );
    if (!folder) {
      const newFolderId = uuidv4();
      const now = new Date().toISOString();
      db.run('INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [newFolderId, dir, parentFolderId, now, now]);
      folder = { id: newFolderId };
    }
    parentFolderId = folder.id;
  }

  const tempUploadPath = path.join(tmpDir, `webdav_up_${Date.now()}_${uuidv4()}.tmp`);
  const tempEncPath = path.join(tmpDir, `webdav_enc_${Date.now()}_${uuidv4()}.enc`);

  try {
    // Write incoming raw request stream to temporary file
    const writeStream = fs.createWriteStream(tempUploadPath);
    await new Promise((resolve, reject) => {
      req.pipe(writeStream);
      req.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
    });

    const fileSize = fs.statSync(tempUploadPath).size;

    // Encrypt file using AES-256-GCM
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) throw new Error('Encryption key not configured in environment');

    const { iv, salt } = await cryptoModule.encryptFile(tempUploadPath, tempEncPath, encryptionKey);

    // Upload to Telegram Channel
    const message = await telegram.uploadFile(tempEncPath, filename + '.enc');
    if (!message || !message.id) {
      throw new Error('Telegram upload failed: No message ID returned');
    }

    // Check if file already exists in this folder (File Edit / Overwrite scenario)
    const existing = db.get(
      'SELECT * FROM files WHERE name = ? AND is_trashed = 0 AND (folder_id = ? OR (folder_id IS NULL AND ? IS NULL))',
      [filename, parentFolderId, parentFolderId]
    );

    const now = new Date().toISOString();
    let fileId;
    let isCreated = false;

    if (existing) {
      // Overwrite / Update existing file
      fileId = existing.id;
      const oldMessageId = existing.telegram_message_id;

      db.run(
        `UPDATE files SET size = ?, telegram_message_id = ?, iv = ?, salt = ?, mime_type = ?, updated_at = ? WHERE id = ?`,
        [fileSize, message.id, iv, salt, getMimeType(filename), now, fileId]
      );

      // Clean up old Telegram message in background
      if (oldMessageId) {
        telegram.deleteFile(oldMessageId).catch(() => {});
      }
    } else {
      // Insert new file
      fileId = uuidv4();
      isCreated = true;
      db.run(
        `INSERT INTO files (id, name, mime_type, size, folder_id, telegram_message_id, iv, salt, is_starred, is_trashed, is_chunked, total_chunks, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, ?, ?)`,
        [fileId, filename, getMimeType(filename), fileSize, parentFolderId, message.id, iv, salt, now, now]
      );
    }

    // Place into local cache for 0ms instant playback
    const cachedPath = path.join(cacheDir, `${fileId}.dec`);
    try { fs.copyFileSync(tempUploadPath, cachedPath); } catch (e) {}

    const fileRecord = db.getFile(fileId);
    try {
      const eventBroadcaster = require('../services/eventBroadcaster');
      eventBroadcaster.broadcast('file_uploaded', { file: fileRecord, folderId: parentFolderId });
    } catch (e) {}

    console.log(`[WebDAV PUT] "${filename}" (${fileSize} bytes) saved to folder: ${parentFolderId || 'root'}`);
    res.status(isCreated ? 201 : 204).set('ETag', `"${fileId}"`).end();
  } catch (err) {
    console.error('[WebDAV PUT Error]', err);
    res.status(500).set('Content-Type', 'text/plain').send('Failed to save file: ' + err.message);
  } finally {
    try { if (fs.existsSync(tempUploadPath)) fs.unlinkSync(tempUploadPath); } catch (e) {}
    try { if (fs.existsSync(tempEncPath)) fs.unlinkSync(tempEncPath); } catch (e) {}
  }
});

// ─── WebDAV MKCOL Handler (Create Directory) ──────────────────────────
router.all('*', async (req, res, next) => {
  if (req.method.toUpperCase() !== 'MKCOL') return next();

  const cleanPath = decodeURIComponent(req.path || '').replace(/^\/webdav/, '').replace(/\/+$/, '');
  const segments = cleanPath.split('/').filter(Boolean);

  if (segments.length === 0) {
    return res.status(405).set('Content-Type', 'text/plain').send('Cannot create root folder.');
  }

  const folderName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);

  // Resolve parent folder
  let parentFolderId = null;
  for (const dir of dirSegments) {
    const folder = db.get(
      'SELECT * FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))',
      [dir, parentFolderId, parentFolderId]
    );
    if (!folder) {
      return res.status(409).set('Content-Type', 'text/plain').send('Parent directory does not exist.');
    }
    parentFolderId = folder.id;
  }

  // Check if folder already exists
  const existing = db.get(
    'SELECT * FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))',
    [folderName, parentFolderId, parentFolderId]
  );
  if (existing) {
    return res.status(405).set('Content-Type', 'text/plain').send('Folder already exists.');
  }

  const newId = uuidv4();
  const now = new Date().toISOString();
  db.run('INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [newId, folderName, parentFolderId, now, now]);

  const createdFolder = { id: newId, name: folderName, parent_id: parentFolderId, created_at: now, updated_at: now };
  try {
    const eventBroadcaster = require('../services/eventBroadcaster');
    eventBroadcaster.broadcast('folder_created', { folder: createdFolder, parentId: parentFolderId });
  } catch (e) {}

  console.log(`[WebDAV MKCOL] Created folder "${folderName}" under parent ${parentFolderId || 'root'}`);
  res.status(201).end();
});

// ─── WebDAV DELETE Handler (Delete Files & Folders) ────────────────────
router.delete('*', async (req, res) => {
  const resolved = resolveWebdavPath(req.path);

  if (resolved.type === 'root') {
    return res.status(405).set('Content-Type', 'text/plain').send('Cannot delete root folder.');
  }

  if (resolved.type === 'not_found') {
    return res.status(404).set('Content-Type', 'text/plain').send('Resource not found.');
  }

  try {
    if (resolved.type === 'file') {
      const file = resolved.item;
      // Delete from Telegram
      if (file.telegram_message_id) {
        telegram.deleteFile(file.telegram_message_id).catch(() => {});
      }
      // Delete from cache
      const cached = path.join(cacheDir, `${file.id}.dec`);
      try { if (fs.existsSync(cached)) fs.unlinkSync(cached); } catch (e) {}
      // Delete from DB
      db.run('DELETE FROM files WHERE id = ?', [file.id]);

      try {
        const eventBroadcaster = require('../services/eventBroadcaster');
        eventBroadcaster.broadcast('file_deleted', { fileId: file.id, folderId: file.folder_id });
      } catch (e) {}

      console.log(`[WebDAV DELETE] Deleted file "${file.name}" (ID: ${file.id})`);
    } else if (resolved.type === 'folder') {
      const folder = resolved.item;
      // Recursively gather all descendant folder IDs
      const folderIdsToDelete = [folder.id];
      const gatherDescendantFolders = (fId) => {
        const children = db.all('SELECT id FROM folders WHERE parent_id = ?', [fId]);
        for (const ch of children) {
          folderIdsToDelete.push(ch.id);
          gatherDescendantFolders(ch.id);
        }
      };
      gatherDescendantFolders(folder.id);

      // Gather all files in these folders and clean them up
      for (const fId of folderIdsToDelete) {
        const filesInFolder = db.all('SELECT * FROM files WHERE folder_id = ?', [fId]);
        for (const file of filesInFolder) {
          if (file.telegram_message_id) {
            telegram.deleteFile(file.telegram_message_id).catch(() => {});
          }
          const cached = path.join(cacheDir, `${file.id}.dec`);
          try { if (fs.existsSync(cached)) fs.unlinkSync(cached); } catch (e) {}
          db.run('DELETE FROM files WHERE id = ?', [file.id]);
        }
        db.run('DELETE FROM folders WHERE id = ?', [fId]);
      }

      try {
        const eventBroadcaster = require('../services/eventBroadcaster');
        eventBroadcaster.broadcast('folder_deleted', { folderId: folder.id });
      } catch (e) {}

      console.log(`[WebDAV DELETE] Deleted folder "${folder.name}" and ${folderIdsToDelete.length} subfolders`);
    }

    res.status(204).end();
  } catch (err) {
    console.error('[WebDAV DELETE Error]', err);
    res.status(500).set('Content-Type', 'text/plain').send('Failed to delete resource: ' + err.message);
  }
});

// ─── WebDAV MOVE Handler (Rename & Move) ──────────────────────────────
router.all('*', async (req, res, next) => {
  if (req.method.toUpperCase() !== 'MOVE') return next();

  const destHeader = req.headers['destination'];
  if (!destHeader) {
    return res.status(400).set('Content-Type', 'text/plain').send('Missing Destination header.');
  }

  const srcResolved = resolveWebdavPath(req.path);
  if (srcResolved.type === 'not_found' || srcResolved.type === 'root') {
    return res.status(404).set('Content-Type', 'text/plain').send('Source resource not found.');
  }

  // Parse destination URL path
  let destUrlPath = '';
  try {
    const url = new URL(destHeader);
    destUrlPath = decodeURIComponent(url.pathname);
  } catch (e) {
    destUrlPath = decodeURIComponent(destHeader);
  }

  const destClean = destUrlPath.replace(/^\/webdav/, '').replace(/\/+$/, '');
  const destSegments = destClean.split('/').filter(Boolean);

  if (destSegments.length === 0) {
    return res.status(400).set('Content-Type', 'text/plain').send('Invalid destination.');
  }

  const newName = destSegments[destSegments.length - 1];
  const destDirSegments = destSegments.slice(0, -1);

  // Resolve destination parent folder
  let targetParentId = null;
  for (const dir of destDirSegments) {
    const folder = db.get(
      'SELECT * FROM folders WHERE name = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))',
      [dir, targetParentId, targetParentId]
    );
    if (!folder) {
      return res.status(409).set('Content-Type', 'text/plain').send('Destination parent directory does not exist.');
    }
    targetParentId = folder.id;
  }

  try {
    const now = new Date().toISOString();
    if (srcResolved.type === 'file') {
      db.run('UPDATE files SET name = ?, folder_id = ?, updated_at = ? WHERE id = ?', [newName, targetParentId, now, srcResolved.item.id]);
      console.log(`[WebDAV MOVE] Moved file "${srcResolved.item.name}" -> "${newName}" (Parent: ${targetParentId || 'root'})`);
    } else if (srcResolved.type === 'folder') {
      db.run('UPDATE folders SET name = ?, parent_id = ?, updated_at = ? WHERE id = ?', [newName, targetParentId, now, srcResolved.item.id]);
      console.log(`[WebDAV MOVE] Moved folder "${srcResolved.item.name}" -> "${newName}" (Parent: ${targetParentId || 'root'})`);
    }

    res.status(201).end();
  } catch (err) {
    console.error('[WebDAV MOVE Error]', err);
    res.status(500).set('Content-Type', 'text/plain').send('Failed to move resource: ' + err.message);
  }
});

// ─── WebDAV LOCK & UNLOCK Compatibility (Windows Explorer & MS Office) ─
router.all('*', async (req, res, next) => {
  const method = req.method.toUpperCase();

  if (method === 'LOCK') {
    const lockToken = `urn:uuid:${uuidv4()}`;
    res.status(200).set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Lock-Token': `<${lockToken}>`
    }).send(`<?xml version="1.0" encoding="utf-8" ?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:owner><D:href>TeleDrive</D:href></D:owner>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>${lockToken}</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`);
    return;
  }

  if (method === 'UNLOCK') {
    return res.status(204).end();
  }

  if (method === 'PROPPATCH') {
    return res.status(207).set('Content-Type', 'application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${escapeXml(req.path)}</D:href>
    <D:propstat>
      <D:prop/>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`);
  }

  next();
});

module.exports = router;
