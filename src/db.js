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
      iv TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_starred INTEGER DEFAULT 0,
      is_trashed INTEGER DEFAULT 0,
      trashed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  getFolder,
  getFolderContents,
  searchFiles,
  getStarredFiles,
  getTrashedFiles,
  getRecentFiles,
  getStorageStats
};
