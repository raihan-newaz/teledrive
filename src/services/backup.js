const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const telegram = require('../telegram');
const cryptoModule = require('../crypto');

let isBackingUp = false;
let autoBackupTimer = null;

/**
 * Creates an encrypted database snapshot and uploads it to Telegram
 * @returns {Promise<Object>} The backup record
 */
async function createEncryptedBackup() {
  if (isBackingUp) {
    throw new Error('Backup already in progress');
  }

  isBackingUp = true;
  const tempDir = path.join(__dirname, '..', '..', 'data', 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawBackupPath = path.join(tempDir, `raw_backup_${timestamp}.db`);
  const encBackupPath = path.join(tempDir, `teledrive_backup_${timestamp}.enc.db`);

  try {
    const rawDb = db.getDb();
    if (!rawDb) {
      throw new Error('Database not initialized');
    }

    // 1. Export atomic binary SQLite snapshot
    const dbData = rawDb.export();
    fs.writeFileSync(rawBackupPath, Buffer.from(dbData));
    const fileSize = fs.statSync(rawBackupPath).size;

    // 2. Encrypt using AES-256-GCM with master encryption key
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error('Master encryption key not set in environment');
    }

    await cryptoModule.encryptBackupFile(rawBackupPath, encBackupPath, encryptionKey);
    const encSize = fs.statSync(encBackupPath).size;

    // 3. Upload encrypted backup to Telegram Cloud Channel
    const backupFileName = `teledrive_backup_${timestamp}.enc.db`;
    const msg = await telegram.uploadFile(encBackupPath, backupFileName);

    if (!msg || !msg.id) {
      throw new Error('Telegram did not return message ID for uploaded backup');
    }

    // 4. Record backup entry in database
    const backupId = uuidv4();
    const record = db.addBackup(backupId, backupFileName, msg.id, encSize);

    console.log(`[Backup] Encrypted backup created successfully: ${backupFileName} (Msg ID: ${msg.id}, Size: ${encSize} bytes)`);
    return {
      success: true,
      backup: record,
      message: 'Cloud backup created and encrypted successfully!'
    };
  } catch (err) {
    console.error('[Backup] Failed to create encrypted backup:', err);
    throw err;
  } finally {
    isBackingUp = false;
    try { if (fs.existsSync(rawBackupPath)) fs.unlinkSync(rawBackupPath); } catch (e) {}
    try { if (fs.existsSync(encBackupPath)) fs.unlinkSync(encBackupPath); } catch (e) {}
  }
}

/**
 * Validates SQLite database buffer
 */
async function validateSqliteBuffer(buffer) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const testDb = new SQL.Database(buffer);
  try {
    const testStmt = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'");
    const hasFilesTable = testStmt.step();
    testStmt.free();
    if (!hasFilesTable) {
      throw new Error('Invalid TeleDrive database: Missing files table');
    }
    return true;
  } finally {
    try { testDb.close(); } catch (e) {}
  }
}

/**
 * Restore database from a Telegram Cloud backup message ID
 * @param {number|string} telegramMessageId
 * @returns {Promise<Object>}
 */
async function restoreBackupFromTelegram(telegramMessageId) {
  const tempDir = path.join(__dirname, '..', '..', 'data', 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const encPath = path.join(tempDir, `restore_cloud_${timestamp}.enc.db`);
  const decPath = path.join(tempDir, `restore_cloud_${timestamp}.db`);
  const activeDbPath = path.join(__dirname, '..', '..', 'data', 'teledrive.db');
  const backupDbPath = path.join(__dirname, '..', '..', 'data', 'teledrive.db.bak');

  try {
    console.log(`[Backup] Downloading encrypted backup from Telegram Msg #${telegramMessageId}...`);
    await telegram.downloadFile(parseInt(telegramMessageId, 10), encPath);

    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new Error('Master encryption key not set in environment');
    }

    console.log('[Backup] Decrypting cloud backup with AES-256-GCM...');
    await cryptoModule.decryptBackupFile(encPath, decPath, encryptionKey);

    const decBuffer = fs.readFileSync(decPath);
    await validateSqliteBuffer(decBuffer);

    // Create safety backup of current active db before replacing
    if (fs.existsSync(activeDbPath)) {
      try { fs.copyFileSync(activeDbPath, backupDbPath); } catch (e) {}
    }

    // Replace active database
    fs.copyFileSync(decPath, activeDbPath);
    await db.initialize();

    console.log(`[Backup] Database restored successfully from Telegram Msg #${telegramMessageId}`);
    return {
      success: true,
      message: 'Database restored successfully from Telegram cloud backup!'
    };
  } finally {
    try { if (fs.existsSync(encPath)) fs.unlinkSync(encPath); } catch (e) {}
    try { if (fs.existsSync(decPath)) fs.unlinkSync(decPath); } catch (e) {}
  }
}

/**
 * Restore database from an uploaded file (.enc.db or .db)
 * @param {string} uploadedFilePath
 * @param {string} originalFilename
 * @returns {Promise<Object>}
 */
async function restoreBackupFromFile(uploadedFilePath, originalFilename = '') {
  const tempDir = path.join(__dirname, '..', '..', 'data', 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Date.now();
  const decPath = path.join(tempDir, `restore_file_${timestamp}.db`);
  const activeDbPath = path.join(__dirname, '..', '..', 'data', 'teledrive.db');
  const backupDbPath = path.join(__dirname, '..', '..', 'data', 'teledrive.db.bak');

  try {
    const isEncrypted = originalFilename.endsWith('.enc.db') || (function() {
      try {
        const fd = fs.openSync(uploadedFilePath, 'r');
        const buf = Buffer.alloc(8);
        fs.readSync(fd, buf, 0, 8, 0);
        fs.closeSync(fd);
        return buf.equals(cryptoModule.BACKUP_MAGIC);
      } catch (e) {
        return false;
      }
    })();

    if (isEncrypted) {
      const encryptionKey = process.env.ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error('Master encryption key not set in environment');
      }
      console.log('[Backup] Decrypting uploaded encrypted backup file...');
      await cryptoModule.decryptBackupFile(uploadedFilePath, decPath, encryptionKey);
    } else {
      // Plain SQLite file
      fs.copyFileSync(uploadedFilePath, decPath);
    }

    const decBuffer = fs.readFileSync(decPath);
    await validateSqliteBuffer(decBuffer);

    // Create safety backup of current active db
    if (fs.existsSync(activeDbPath)) {
      try { fs.copyFileSync(activeDbPath, backupDbPath); } catch (e) {}
    }

    // Replace active database
    fs.copyFileSync(decPath, activeDbPath);
    await db.initialize();

    console.log('[Backup] Database restored successfully from uploaded file');
    return {
      success: true,
      message: 'Database imported and restored successfully!'
    };
  } finally {
    try { if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath); } catch (e) {}
    try { if (fs.existsSync(decPath)) fs.unlinkSync(decPath); } catch (e) {}
  }
}

/**
 * Get current backup status & history
 */
function getBackupStatus() {
  const latest = db.getLatestBackup();
  const history = db.getAllBackups(10);
  return {
    isBackingUp,
    latestBackup: latest || null,
    history: history || [],
    autoBackupEnabled: true,
    intervalHours: 24
  };
}

/**
 * Starts the automatic 24-hour backup schedule
 */
function startAutoBackupSchedule() {
  if (autoBackupTimer) {
    clearInterval(autoBackupTimer);
  }

  // Check on startup after 30 seconds
  setTimeout(async () => {
    await checkAndRunAutoBackup();
  }, 30000);

  // Check every 4 hours if a 24h backup is due
  autoBackupTimer = setInterval(async () => {
    await checkAndRunAutoBackup();
  }, 4 * 60 * 60 * 1000);

  console.log('[Backup] Automatic 24-hour cloud backup service started');
}

/**
 * Helper to check if 24 hours have passed since the last backup
 */
async function checkAndRunAutoBackup() {
  try {
    // Only run if setup is completed and telegram is connected
    if (!process.env.ENCRYPTION_KEY || !process.env.TELEGRAM_CHANNEL_ID) return;

    const latest = db.getLatestBackup();
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    if (!latest || (now - new Date(latest.created_at).getTime()) > ONE_DAY_MS) {
      console.log('[Backup] 24 hours elapsed since last backup. Starting auto-backup...');
      await createEncryptedBackup();
    }
  } catch (e) {
    console.warn('[Backup] Auto-backup check warning:', e.message);
  }
}

module.exports = {
  createEncryptedBackup,
  restoreBackupFromTelegram,
  restoreBackupFromFile,
  getBackupStatus,
  startAutoBackupSchedule
};
