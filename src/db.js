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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      encryption_key TEXT NOT NULL,
      storage_limit INTEGER DEFAULT 0,
      storage_used INTEGER DEFAULT 0,
      last_login_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
      is_locked INTEGER DEFAULT 0,
      password_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      telegram_message_id INTEGER,
      iv TEXT,
      salt TEXT,
      auth_tag TEXT,
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
      auth_tag TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Safe migrations for existing databases
  try { db.run('ALTER TABLE files ADD COLUMN user_id TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN is_chunked INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN total_chunks INTEGER DEFAULT 1;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN is_shared INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_token TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_password TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_expires_at DATETIME;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_views INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN share_downloads INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE files ADD COLUMN auth_tag TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE folders ADD COLUMN user_id TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE folders ADD COLUMN is_locked INTEGER DEFAULT 0;'); } catch (e) {}
  try { db.run('ALTER TABLE folders ADD COLUMN password_hash TEXT;'); } catch (e) {}
  try { db.run('ALTER TABLE file_chunks ADD COLUMN auth_tag TEXT;'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      file_name TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      folder_id TEXT,
      total_chunks INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try { db.run('ALTER TABLE upload_sessions ADD COLUMN user_id TEXT;'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS upload_session_chunks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      size INTEGER NOT NULL,
      iv TEXT NOT NULL,
      salt TEXT NOT NULL,
      auth_tag TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, chunk_index)
    );
  `);

  try { db.run('ALTER TABLE upload_session_chunks ADD COLUMN auth_tag TEXT;'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      file_name TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      size INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try { db.run('ALTER TABLE backups ADD COLUMN user_id TEXT;'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT NOT NULL,
      user_id TEXT,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (key, user_id)
    );
  `);

  try { db.run('ALTER TABLE app_settings ADD COLUMN user_id TEXT;'); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS video_metadata (
      file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
      duration REAL,
      width INTEGER,
      height INTEGER,
      codec TEXT,
      audio_codec TEXT,
      bitrate INTEGER,
      fps REAL,
      is_hdr INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS video_transcode_jobs (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER DEFAULT 0,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Performance compound indexes for lightning-fast scale & user isolation
  try {
    db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_user_folder ON files(user_id, folder_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_user_trashed ON files(user_id, is_trashed);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_user_starred ON files(user_id, is_starred);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);');
    db.run('CREATE INDEX IF NOT EXISTS idx_files_share_token ON files(share_token);');
    db.run('CREATE INDEX IF NOT EXISTS idx_file_chunks_file_id ON file_chunks(file_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_upload_session_chunks_sid ON upload_session_chunks(session_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_folders_user_parent ON folders(user_id, parent_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at);');
    db.run('CREATE INDEX IF NOT EXISTS idx_video_transcode_jobs_file ON video_transcode_jobs(file_id);');
    db.run('CREATE INDEX IF NOT EXISTS idx_video_transcode_jobs_user ON video_transcode_jobs(user_id);');
  } catch (e) {
    console.warn('[DB] Index creation warning:', e.message);
  }

  // Automatic legacy migration: If no users exist, create primary Admin account and associate existing data
  try {
    const existingUsers = all('SELECT * FROM users');
    if (!existingUsers || existingUsers.length === 0) {
      const bcrypt = require('bcryptjs');
      const cryptoModule = require('./crypto');
      const masterPassword = process.env.MASTER_PASSWORD || 'admin';
      const masterEncryptionKey = process.env.ENCRYPTION_KEY || 'default-encryption-key';
      const passwordHash = bcrypt.hashSync(masterPassword, 12);
      const adminId = 'usr_admin_primary';
      const wrappedAdminKey = cryptoModule.wrapUserKey(masterEncryptionKey, masterEncryptionKey);

      run(`
        INSERT INTO users (id, email, password_hash, name, role, status, encryption_key, storage_limit, storage_used)
        VALUES (?, ?, ?, ?, 'admin', 'active', ?, 0, 0)
      `, [adminId, 'admin@teledrive.local', passwordHash, 'Admin', wrappedAdminKey]);

      // Assign all legacy orphaned files, folders, and upload sessions to Admin
      run('UPDATE files SET user_id = ? WHERE user_id IS NULL OR user_id = ""', [adminId]);
      run('UPDATE folders SET user_id = ? WHERE user_id IS NULL OR user_id = ""', [adminId]);
      run('UPDATE upload_sessions SET user_id = ? WHERE user_id IS NULL OR user_id = ""', [adminId]);
      run('UPDATE backups SET user_id = ? WHERE user_id IS NULL OR user_id = ""', [adminId]);

      // Recalculate Admin storage
      const stats = get('SELECT COALESCE(SUM(size), 0) as total_size FROM files WHERE user_id = ? AND is_trashed = 0', [adminId]);
      if (stats) {
        run('UPDATE users SET storage_used = ? WHERE id = ?', [stats.total_size || 0, adminId]);
      }
      console.log('[DB] Auto-migrated legacy data to primary Admin account (admin@teledrive.local)');
    }
  } catch (migErr) {
    console.warn('[DB] User auto-migration notice:', migErr.message);
  }

  save(true);
  console.log('[DB] SQLite database initialized at', dbPath);
  return db;
}

let saveTimeout = null;

/**
 * Save database to disk (debounced atomic write)
 * @param {boolean} immediate - Whether to write immediately or debounce
 */
function save(immediate = false) {
  if (!db) return;
  const doSave = () => {
    try {
      const data = db.export();
      const tmpPath = dbPath + '.tmp';
      fs.writeFileSync(tmpPath, Buffer.from(data));
      fs.renameSync(tmpPath, dbPath);
    } catch (e) {
      console.error('[DB] Save error:', e.message);
    }
  };

  if (immediate) {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    doSave();
  } else {
    if (!saveTimeout) {
      saveTimeout = setTimeout(() => {
        saveTimeout = null;
        doSave();
      }, 300);
    }
  }
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
 * Gets a file by ID (optionally scoped to userId)
 * @param {string} id - The file ID
 * @param {string|null} userId - Optional user ID for tenant isolation
 * @returns {Object|undefined} The file record
 */
function getFile(id, userId = null) {
  if (id === undefined || id === null) return undefined;
  const strId = String(id).trim();
  if (userId) {
    return get('SELECT * FROM files WHERE id = ? AND user_id = ?', [strId, String(userId)]);
  }
  return get('SELECT * FROM files WHERE id = ?', [strId]);
}

/**
 * Gets a folder by ID (optionally scoped to userId)
 * @param {string} id - The folder ID
 * @param {string|null} userId - Optional user ID for tenant isolation
 * @returns {Object|undefined} The folder record
 */
function getFolder(id, userId = null) {
  if (!id) return undefined;
  if (userId) {
    return get('SELECT * FROM folders WHERE id = ? AND user_id = ?', [id, String(userId)]);
  }
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
 * Gets contents of a specific folder scoped to user
 * @param {string|null} folderId - The folder ID or null for root
 * @param {string|null} userId - User ID
 * @returns {Object} { folders: [...], files: [...] }
 */
function getFolderContents(folderId, userId = null) {
  if (userId) {
    if (folderId) {
      return {
        folders: all('SELECT * FROM folders WHERE parent_id = ? AND user_id = ? ORDER BY name ASC', [folderId, userId]),
        files: all('SELECT * FROM files WHERE folder_id = ? AND user_id = ? AND is_trashed = 0 ORDER BY name ASC', [folderId, userId])
      };
    } else {
      return {
        folders: all('SELECT * FROM folders WHERE parent_id IS NULL AND user_id = ? ORDER BY name ASC', [userId]),
        files: all('SELECT * FROM files WHERE folder_id IS NULL AND user_id = ? AND is_trashed = 0 ORDER BY name ASC', [userId])
      };
    }
  }
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
 * Searches for files by name (excluding files in locked folders for privacy)
 * @param {string} query - The search query
 * @param {string|null} userId - User ID
 * @returns {Array} Array of matching files
 */
function searchFiles(query, userId = null) {
  if (userId) {
    return all(
      `SELECT f.* FROM files f
       LEFT JOIN folders fo ON f.folder_id = fo.id
       WHERE f.name LIKE ? AND f.user_id = ? AND f.is_trashed = 0 AND (fo.is_locked IS NULL OR fo.is_locked = 0)
       ORDER BY f.name ASC`,
      ['%' + query + '%', userId]
    );
  }
  return all(
    `SELECT f.* FROM files f
     LEFT JOIN folders fo ON f.folder_id = fo.id
     WHERE f.name LIKE ? AND f.is_trashed = 0 AND (fo.is_locked IS NULL OR fo.is_locked = 0)
     ORDER BY f.name ASC`,
    ['%' + query + '%']
  );
}

/**
 * Searches for folders by name
 * @param {string} query - The search query
 * @param {string|null} userId - User ID
 * @returns {Array} Array of matching folders
 */
function searchFolders(query, userId = null) {
  if (userId) {
    return all('SELECT * FROM folders WHERE name LIKE ? AND user_id = ? ORDER BY name ASC', ['%' + query + '%', userId]);
  }
  return all('SELECT * FROM folders WHERE name LIKE ? ORDER BY name ASC', ['%' + query + '%']);
}

/**
 * Gets all starred files (excluding files in locked folders for privacy)
 * @param {string|null} userId - User ID
 * @returns {Array} Array of starred files
 */
function getStarredFiles(userId = null) {
  if (userId) {
    return all(
      `SELECT f.* FROM files f
       LEFT JOIN folders fo ON f.folder_id = fo.id
       WHERE f.is_starred = 1 AND f.user_id = ? AND f.is_trashed = 0 AND (fo.is_locked IS NULL OR fo.is_locked = 0)
       ORDER BY f.updated_at DESC`,
      [userId]
    );
  }
  return all(
    `SELECT f.* FROM files f
     LEFT JOIN folders fo ON f.folder_id = fo.id
     WHERE f.is_starred = 1 AND f.is_trashed = 0 AND (fo.is_locked IS NULL OR fo.is_locked = 0)
     ORDER BY f.updated_at DESC`
  );
}

/**
 * Gets all trashed files
 * @param {string|null} userId - User ID
 * @returns {Array} Array of trashed files
 */
function getTrashedFiles(userId = null) {
  if (userId) {
    return all('SELECT * FROM files WHERE is_trashed = 1 AND user_id = ? ORDER BY trashed_at DESC', [userId]);
  }
  return all('SELECT * FROM files WHERE is_trashed = 1 ORDER BY trashed_at DESC');
}

/**
 * Gets recent files (excluding files in locked folders for privacy)
 * @param {number} limit - Max number of files to return
 * @param {string|null} userId - User ID
 * @returns {Array} Array of recent files
 */
function getRecentFiles(limit = 20, userId = null) {
  if (userId) {
    return all(
      `SELECT f.* FROM files f
       LEFT JOIN folders fo ON f.folder_id = fo.id
       WHERE f.is_trashed = 0 AND f.user_id = ? AND (fo.is_locked IS NULL OR fo.is_locked = 0)
       ORDER BY f.created_at DESC LIMIT ?`,
      [userId, limit]
    );
  }
  return all(
    `SELECT f.* FROM files f
     LEFT JOIN folders fo ON f.folder_id = fo.id
     WHERE f.is_trashed = 0 AND (fo.is_locked IS NULL OR fo.is_locked = 0)
     ORDER BY f.created_at DESC LIMIT ?`,
    [limit]
  );
}

/**
 * Gets storage statistics
 * @param {string|null} userId - Optional user ID
 * @returns {Object} Object containing totalFiles and totalSize
 */
function getStorageStats(userId = null) {
  if (userId) {
    const stats = get('SELECT COUNT(*) as totalFiles, COALESCE(SUM(size), 0) as totalSize FROM files WHERE user_id = ? AND is_trashed = 0', [userId]);
    return {
      totalFiles: stats ? stats.totalFiles : 0,
      totalSize: stats ? stats.totalSize : 0
    };
  }
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
 * @param {Object} chunk - { id, fileId, chunkIndex, telegramMessageId, size, iv, salt, authTag }
 */
function addFileChunk(chunk) {
  run(
    `INSERT INTO file_chunks (id, file_id, chunk_index, telegram_message_id, size, iv, salt, auth_tag, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [chunk.id, chunk.fileId, chunk.chunkIndex, chunk.telegramMessageId, chunk.size, chunk.iv, chunk.salt, chunk.authTag || chunk.auth_tag || null, new Date().toISOString()]
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
function getUploadSession(id, userId = null) {
  if (userId) {
    return get('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?', [id, userId]);
  }
  return get('SELECT * FROM upload_sessions WHERE id = ?', [id]);
}

/**
 * Creates or updates an upload session
 */
function createUploadSession(session) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO upload_sessions (id, user_id, file_name, file_size, folder_id, total_chunks, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = ?`,
    [session.id, session.userId || session.user_id || null, session.fileName, session.fileSize, session.folderId || null, session.totalChunks, now, now, now]
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
    `INSERT OR REPLACE INTO upload_session_chunks (id, session_id, chunk_index, telegram_message_id, size, iv, salt, auth_tag, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [chunk.id, chunk.sessionId, chunk.chunkIndex, chunk.telegramMessageId, chunk.size, chunk.iv, chunk.salt, chunk.authTag || chunk.auth_tag || null, new Date().toISOString()]
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

  const strId = String(fileId).trim();
  const numId = !isNaN(Number(strId)) ? Number(strId) : null;

  if (numId !== null) {
    run(
      'UPDATE files SET is_shared = ?, share_token = ?, share_password = ?, share_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR id = ?',
      [isShared ? 1 : 0, token || null, password || null, expiresAt || null, strId, numId]
    );
  } else {
    run(
      'UPDATE files SET is_shared = ?, share_token = ?, share_password = ?, share_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [isShared ? 1 : 0, token || null, password || null, expiresAt || null, strId]
    );
  }
  save(true);
  return getFile(fileId);
}

/**
 * Revokes public share link for a file
 */
function revokeFileShare(fileId) {
  const strId = String(fileId).trim();
  const numId = !isNaN(Number(strId)) ? Number(strId) : null;
  if (numId !== null) {
    run('UPDATE files SET is_shared = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR id = ?', [strId, numId]);
  } else {
    run('UPDATE files SET is_shared = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [strId]);
  }
  save(true);
  return getFile(fileId);
}

/**
 * Increment view count for shared file
 */
function incrementShareViews(token) {
  run('UPDATE files SET share_views = COALESCE(share_views, 0) + 1 WHERE share_token = ?', [token]);
  save(true);
}

/**
 * Increment download count for shared file
 */
function incrementShareDownloads(token) {
  run('UPDATE files SET share_downloads = COALESCE(share_downloads, 0) + 1 WHERE share_token = ?', [token]);
  save(true);
}

/**
 * Record a new cloud database backup
 */
function addBackup(id, fileName, telegramMessageId, size, userId = null) {
  run(
    'INSERT INTO backups (id, user_id, file_name, telegram_message_id, size) VALUES (?, ?, ?, ?, ?)',
    [id, userId || null, fileName, telegramMessageId, size]
  );
  save();
  return getLatestBackup(userId);
}

/**
 * Get the most recent database backup
 */
function getLatestBackup(userId = null) {
  if (userId) {
    return get('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  }
  return get('SELECT * FROM backups ORDER BY created_at DESC LIMIT 1');
}

/**
 * Get all database backups history
 */
function getAllBackups(limit = 20, userId = null) {
  if (userId) {
    return all('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
  }
  return all('SELECT * FROM backups ORDER BY created_at DESC LIMIT ?', [limit]);
}

/**
 * Get single app setting / preference
 */
function getSetting(key, defaultValue = null, userId = null) {
  if (!db) return defaultValue;
  if (userId) {
    const userRow = get('SELECT value FROM app_settings WHERE key = ? AND user_id = ?', [key, String(userId)]);
    if (userRow) return userRow.value;
  }
  const globalRow = get('SELECT value FROM app_settings WHERE key = ? AND (user_id IS NULL OR user_id = "")', [key]);
  return globalRow ? globalRow.value : defaultValue;
}

/**
 * Get all app settings / preferences
 */
function getAllSettings(userId = null) {
  if (!db) return {};
  const rows = userId
    ? all('SELECT key, value FROM app_settings WHERE user_id = ? OR user_id IS NULL', [String(userId)])
    : all('SELECT key, value FROM app_settings WHERE user_id IS NULL OR user_id = ""');
  const result = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      result[r.key] = r.value;
    }
  }
  return result;
}

/**
 * Set single app setting / preference
 */
function setSetting(key, value, userId = null) {
  if (!db) return;
  run('INSERT OR REPLACE INTO app_settings (key, user_id, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [key, userId || null, String(value)]);
  save();
}

/**
 * Set multiple app settings / preferences in batch
 */
function setMultipleSettings(settingsObj, userId = null) {
  if (!db || !settingsObj || typeof settingsObj !== 'object') return;
  for (const [key, value] of Object.entries(settingsObj)) {
    if (value !== undefined && value !== null) {
      run('INSERT OR REPLACE INTO app_settings (key, user_id, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [key, userId || null, String(value)]);
    }
  }
  save();
}

// ─── User Management Helper Functions ─────────────────────────────

function getUserById(id) {
  if (!id) return undefined;
  return get('SELECT * FROM users WHERE id = ?', [String(id)]);
}

function getUserByEmail(email) {
  if (!email) return undefined;
  return get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [String(email).trim()]);
}

function getAllUsers() {
  return all('SELECT id, email, name, role, status, storage_limit, storage_used, last_login_at, created_at, updated_at FROM users ORDER BY created_at ASC');
}

function createUser(user) {
  const id = user.id || ('usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7));
  const role = user.role || 'user';
  const status = user.status || 'active';
  const storageLimit = user.storageLimit !== undefined ? user.storageLimit : (user.storage_limit || 0);
  const now = new Date().toISOString();

  run(`
    INSERT INTO users (id, email, password_hash, name, role, status, encryption_key, storage_limit, storage_used, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `, [id, user.email.toLowerCase().trim(), user.passwordHash || user.password_hash, user.name, role, status, user.encryptionKey || user.encryption_key, storageLimit, now, now]);

  save(true);
  return getUserById(id);
}

function updateUser(id, updates = {}) {
  const fields = [];
  const params = [];

  if (updates.email !== undefined) {
    fields.push('email = ?');
    params.push(updates.email.toLowerCase().trim());
  }
  if (updates.name !== undefined) {
    fields.push('name = ?');
    params.push(updates.name.trim());
  }
  if (updates.passwordHash !== undefined || updates.password_hash !== undefined) {
    fields.push('password_hash = ?');
    params.push(updates.passwordHash || updates.password_hash);
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    params.push(updates.role);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    params.push(updates.status);
  }
  if (updates.storageLimit !== undefined || updates.storage_limit !== undefined) {
    fields.push('storage_limit = ?');
    params.push(updates.storageLimit !== undefined ? updates.storageLimit : updates.storage_limit);
  }
  if (updates.storageUsed !== undefined || updates.storage_used !== undefined) {
    fields.push('storage_used = ?');
    params.push(updates.storageUsed !== undefined ? updates.storageUsed : updates.storage_used);
  }
  if (updates.lastLoginAt !== undefined || updates.last_login_at !== undefined) {
    fields.push('last_login_at = ?');
    params.push(updates.lastLoginAt || updates.last_login_at);
  }

  if (fields.length === 0) return getUserById(id);

  fields.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);

  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params);
  save(true);
  return getUserById(id);
}

function updateUserLastLogin(id) {
  run('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  save();
}

function deleteUser(id) {
  const userFiles = all('SELECT id FROM files WHERE user_id = ?', [id]);
  for (const f of userFiles) {
    run('DELETE FROM file_chunks WHERE file_id = ?', [f.id]);
  }
  run('DELETE FROM files WHERE user_id = ?', [id]);
  run('DELETE FROM folders WHERE user_id = ?', [id]);
  run('DELETE FROM upload_sessions WHERE user_id = ?', [id]);
  run('DELETE FROM backups WHERE user_id = ?', [id]);
  run('DELETE FROM app_settings WHERE user_id = ?', [id]);
  run('DELETE FROM users WHERE id = ?', [id]);
  save(true);
}

function recalculateUserStorage(userId) {
  if (!userId) return 0;
  const stats = get('SELECT COALESCE(SUM(size), 0) as total_size FROM files WHERE user_id = ? AND is_trashed = 0', [userId]);
  const total = stats ? (stats.total_size || 0) : 0;
  run('UPDATE users SET storage_used = ? WHERE id = ?', [total, userId]);
  save();
  return total;
}

function getUserStorageStats(userId) {
  if (!userId) return { totalFiles: 0, totalSize: 0 };
  const stats = get('SELECT COUNT(*) as totalFiles, COALESCE(SUM(size), 0) as totalSize FROM files WHERE user_id = ? AND is_trashed = 0', [userId]);
  return {
    totalFiles: stats ? stats.totalFiles : 0,
    totalSize: stats ? stats.totalSize : 0
  };
}

function getVideoMetadata(fileId) {
  if (!fileId) return null;
  return get('SELECT * FROM video_metadata WHERE file_id = ?', [fileId]);
}

function saveVideoMetadata(fileId, meta = {}) {
  if (!fileId) return;
  const now = new Date().toISOString();
  run(
    `INSERT INTO video_metadata (file_id, duration, width, height, codec, audio_codec, bitrate, fps, is_hdr, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id) DO UPDATE SET
       duration = excluded.duration,
       width = excluded.width,
       height = excluded.height,
       codec = excluded.codec,
       audio_codec = excluded.audio_codec,
       bitrate = excluded.bitrate,
       fps = excluded.fps,
       is_hdr = excluded.is_hdr,
       updated_at = excluded.updated_at`,
    [
      fileId,
      meta.duration || null,
      meta.width || null,
      meta.height || null,
      meta.codec || null,
      meta.audio_codec || null,
      meta.bitrate || null,
      meta.fps || null,
      meta.is_hdr ? 1 : 0,
      now,
      now
    ]
  );
  save();
}

function getTranscodeJob(fileId) {
  if (!fileId) return null;
  return get('SELECT * FROM video_transcode_jobs WHERE file_id = ?', [fileId]);
}

function upsertTranscodeJob(fileId, userId, status, progress = 0, error = null) {
  if (!fileId) return;
  const now = new Date().toISOString();
  const existing = get('SELECT id FROM video_transcode_jobs WHERE file_id = ?', [fileId]);
  if (existing) {
    run(
      'UPDATE video_transcode_jobs SET user_id = ?, status = ?, progress = ?, error = ?, updated_at = ? WHERE file_id = ?',
      [userId || null, status, progress, error, now, fileId]
    );
  } else {
    const { v4: uuidv4 } = require('uuid');
    run(
      'INSERT INTO video_transcode_jobs (id, file_id, user_id, status, progress, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), fileId, userId || null, status, progress, error, now, now]
    );
  }
  save();
}

function deleteTranscodeJob(fileId) {
  if (!fileId) return;
  run('DELETE FROM video_transcode_jobs WHERE file_id = ?', [fileId]);
  save();
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
  getStorageStats,
  addBackup,
  getLatestBackup,
  getAllBackups,
  getSetting,
  getAllSettings,
  setSetting,
  setMultipleSettings,
  getUserById,
  getUserByEmail,
  getAllUsers,
  createUser,
  updateUser,
  updateUserLastLogin,
  deleteUser,
  recalculateUserStorage,
  getUserStorageStats,
  getVideoMetadata,
  saveVideoMetadata,
  getTranscodeJob,
  upsertTranscodeJob,
  deleteTranscodeJob
};
