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

    await cryptoModule.encryptFile(rawBackupPath, encBackupPath, encryptionKey);
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
  getBackupStatus,
  startAutoBackupSchedule
};
