const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'teledrive.db');

let db = null;

/**
 * Initialize the database (must be called before any other function)
 * @returns {Promise<object>} The database instance
 */
async function initialize() {
  const SQL = await initSqlJs();

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON;');

  // Initialize schema
  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      telegram_message_id INTEGER,
      iv TEXT,
      salt TEXT,
      is_starred INTEGER DEFAULT 0,
      is_trashed INTEGER DEFAULT 0,
      is_chunked INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 1,
      is_shared INTEGER DEFAULT 0,
      share_token TEXT,
      share_password TEXT,
      share_expires_at DATETIME,
      share_views INTEGER DEFAULT 0,
      share_downloads INTEGER DEFAULT 0,
      trashed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS file_chunks (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      size INTEGER NOT NULL,
      iv TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe migrations for existing databases
  try { db.run('ALTER TABLE files ADD COLUMN is_chunked INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN total_chunks INTEGER DEFAULT 1;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN is_shared INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_token TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_password TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_expires_at DATETIME;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_views INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_downloads INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE folders ADD COLUMN is_locked INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE folders ADD COLUMN password_hash TEXT;'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      folder_id TEXT,
      total_chunks INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS upload_session_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      size INTEGER NOT NULL,
      iv TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, chunk_index)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  save();
  console.log('[DB] SQLite database initialized at', dbPath);
  return db;
}

/**
 * Save database to disk
 */
function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

/**
 * Execute a SQL statement with params and save to disk
 * @param {string} sql - SQL statement
 * @param {Array} params - Bind parameters
 */
function run(sql, params = []) {
  db.run(sql, params);
  save();
}

/**
 * Query a single row
 * @param {string} sql - SQL query
 * @param {Array} params - Bind parameters
 * @returns {Object|undefined} The row as an object, or undefined
 */
function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

/**
 * Query multiple rows
 * @param {string} sql - SQL query
 * @param {Array} params - Bind parameters
 * @returns {Array} Array of row objects
 */
function all(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// ─── Helper Functions ─────────────────────────────────────────────

/**
 * Gets a file by ID
 * @param {string} id - The file ID
 * @returns {Object|undefined} The file record
 */
function getFile(id) {
  return get('SELECT * FROM files WHERE id = ?', [id]);
}

/**
 * Gets a folder by ID
 * @param {string} id - The folder ID
 * @returns {Object|undefined} The folder record
 */
function getFolder(id) {
  return get('SELECT * FROM folders WHERE id = ?', [id]);
}

/**
 * Locks a folder with a hashed password
 */
function lockFolder(id, passwordHash) {
  return run('UPDATE folders SET is_locked = 1, password_hash = ? WHERE id = ?', [passwordHash, id]);
}

/**
 * Removes lock password from a folder permanently
 */
function unlockFolderPermanently(id) {
  return run('UPDATE folders SET is_locked = 0, password_hash = NULL WHERE id = ?', [id]);
}

/**
 * Gets contents of a specific folder
 * @param {string|null} folderId - The folder ID or null for root
 * @returns {Object} { folders: [...], files: [...] }
 */
function getFolderContents(folderId) {
  if (folderId) {
    return {
      folders: all('SELECT * FROM folders WHERE parent_id = ? ORDER BY name ASC', [folderId]),
      files: all('SELECT * FROM files WHERE folder_id = ? AND is_trashed = 0 ORDER BY name ASC', [folderId])
    };
  } else {
    return {
      folders: all('SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name ASC'),
      files: all('SELECT * FROM files WHERE folder_id IS NULL AND is_trashed = 0 ORDER BY name ASC')
    };
  }
}

/**
 * Searches for files by name
 * @param {string} query - The search query
 * @returns {Array} Array of matching files
 */
function searchFiles(query) {
  return all('SELECT * FROM files WHERE name LIKE ? AND is_trashed = 0 ORDER BY name ASC', ['%' + query + '%']);
}

/**
 * Searches for folders by name
 * @param {string} query - The search query
 * @returns {Array} Array of matching folders
 */
function searchFolders(query) {
  return all('SELECT * FROM folders WHERE name LIKE ? ORDER BY name ASC', ['%' + query + '%']);
}

/**
 * Gets all starred files
 * @returns {Array} Array of starred files
 */
function getStarredFiles() {
  return all('SELECT * FROM files WHERE is_starred = 1 AND is_trashed = 0 ORDER BY updated_at DESC');
}

/**
 * Gets all trashed files
 * @returns {Array} Array of trashed files
 */
function getTrashedFiles() {
  return all('SELECT * FROM files WHERE is_trashed = 1 ORDER BY trashed_at DESC');
}

/**
 * Gets recent files
 * @param {number} limit - Max number of files to return
 * @returns {Array} Array of recent files
 */
function getRecentFiles(limit = 20) {
  return all('SELECT * FROM files WHERE is_trashed = 0 ORDER BY created_at DESC LIMIT ?', [limit]);
}

/**
 * Gets storage statistics
 * @returns {Object} Object containing totalFiles and totalSize
 */
function getStorageStats() {
  const stats = get('SELECT COUNT(*) as totalFiles, COALESCE(SUM(size), 0) as totalSize FROM files WHERE is_trashed = 0');
  return {
    totalFiles: stats ? stats.totalFiles : 0,
    totalSize: stats ? stats.totalSize : 0
  };
}

/**
 * Gets all chunks for a chunked file ordered by chunk_index ASC
 * @param {string} fileId - The file ID
 * @returns {Array} Array of chunk records
 */
function getFileChunks(fileId) {
  return all('SELECT * FROM file_chunks WHERE file_id = ? ORDER BY chunk_index ASC', [fileId]);
}

/**
 * Adds a chunk record to the database
 * @param {Object} chunk - { id, fileId, chunkIndex, telegramMessageId, size, iv, salt }
 */
function addFileChunk(chunk) {
  run(
    `INSERT INTO file_chunks (id, file_id, chunk_index, telegram_message_id, size, iv, salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [chunk.id, chunk.fileId, chunk.chunkIndex, chunk.telegramMessageId, chunk.size, chunk.iv, chunk.salt, new Date().toISOString()]
  );
}

/**
 * Deletes all chunks for a file
 * @param {string} fileId - The file ID
 */
function deleteFileChunks(fileId) {
  run('DELETE FROM file_chunks WHERE file_id = ?', [fileId]);
}

/**
 * Gets an upload session by ID
 */
function getUploadSession(id) {
  return get('SELECT * FROM upload_sessions WHERE id = ?', [id]);
}

/**
 * Creates or updates an upload session
 */
function createUploadSession(session) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO upload_sessions (id, file_name, file_size, folder_id, total_chunks, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = ?`,
    [session.id, session.fileName, session.fileSize, session.folderId || null, session.totalChunks, now, now, now]
  );
}

/**
 * Gets all uploaded chunks for a session
 */
function getUploadedSessionChunks(sessionId) {
  return all('SELECT * FROM upload_session_chunks WHERE session_id = ? ORDER BY chunk_index ASC', [sessionId]);
}

/**
 * Adds an uploaded chunk to the session
 */
function addUploadSessionChunk(chunk) {
  run(
    `INSERT OR REPLACE INTO upload_session_chunks (id, session_id, chunk_index, telegram_message_id, size, iv, salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [chunk.id, chunk.sessionId, chunk.chunkIndex, chunk.telegramMessageId, chunk.size, chunk.iv, chunk.salt, new Date().toISOString()]
  );
  run('UPDATE upload_sessions SET updated_at = ? WHERE id = ?', [new Date().toISOString(), chunk.sessionId]);
}

/**
 * Deletes an upload session and its chunks
 */
function deleteUploadSession(sessionId) {
  run('DELETE FROM upload_session_chunks WHERE session_id = ?', [sessionId]);
  run('DELETE FROM upload_sessions WHERE id = ?', [sessionId]);
}

/**
 * Gets expired upload sessions
 */
function getExpiredUploadSessions(olderThanIso) {
  return all('SELECT * FROM upload_sessions WHERE updated_at <= ?', [olderThanIso]);
}

/**
 * Gets a file by public share token
 */
function getFileByShareToken(token) {
  return get('SELECT * FROM files WHERE share_token = ? AND is_shared = 1 AND is_trashed = 0', [token]);
}

/**
 * Enable or update public share configuration for a file
 */
function updateFileShare(fileId, options = {}) {
  const isShared = options.isShared !== undefined ? options.isShared : options.is_shared;
  const token = options.token !== undefined ? options.token : options.share_token;
  const password = options.password !== undefined ? options.password : options.share_password;
  const expiresAt = options.expiresAt !== undefined ? options.expiresAt : options.share_expires_at;

  run(
    'UPDATE files SET is_shared = ?, share_token = ?, share_password = ?, share_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [isShared ? 1 : 0, token || null, password || null, expiresAt || null, fileId]
  );
  return getFile(fileId);
}

/**
 * Revokes public share link for a file
 */
function revokeFileShare(fileId) {
  run(
    'UPDATE files SET is_shared = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [fileId]
  );
  return getFile(fileId);
}

/**
 * Increment view count for shared file
 */
function incrementShareViews(token) {
  run('UPDATE files SET share_views = COALESCE(share_views, 0) + 1 WHERE share_token = ?', [token]);
}

/**
 * Increment download count for shared file
 */
function incrementShareDownloads(token) {
  run('UPDATE files SET share_downloads = COALESCE(share_downloads, 0) + 1 WHERE share_token = ?', [token]);
}

/**
 * Get the raw database instance
 * @returns {object} sql.js Database instance
 */
function getDb() {
  return db;
}

module.exports = {
  initialize,
  save,
  run,
  get,
  all,
  getDb,
  getFile,
  getFileChunks,
  addFileChunk,
  deleteFileChunks,
  getUploadSession,
  createUploadSession,
  getUploadedSessionChunks,
  addUploadSessionChunk,
  deleteUploadSession,
  getExpiredUploadSessions,
  getFileByShareToken,
  updateFileShare,
  revokeFileShare,
  incrementShareViews,
  incrementShareDownloads,
  getFolder,
  lockFolder,
  unlockFolderPermanently,
  getFolderContents,
  searchFiles,
  searchFolders,
  getStarredFiles,
  getTrashedFiles,
  getRecentFiles,
  getStorageStats
};
