const express = require('express');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const authMiddleware = require('../middleware/auth');
const { requireAdmin } = require('../middleware/auth');
const telegram = require('../telegram');
const db = require('../db');

const router = express.Router();
router.use(authMiddleware);

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const configEnvPath = path.join(dataDir, 'config.env');
const dataEnvPath = path.join(dataDir, '.env');
const cacheDir = path.join(dataDir, 'cache');
const sessionFile = path.join(dataDir, 'session.txt');

/**
 * Utility to calculate folder size in bytes
 */
function getDirectorySize(dirPath) {
  let totalSize = 0;
  let fileCount = 0;
  if (!fs.existsSync(dirPath)) return { totalSize, fileCount };

  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          totalSize += stats.size;
          fileCount++;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return { totalSize, fileCount };
}

const rootEnvPath = path.join(__dirname, '../../.env');

/**
 * Helper to update .env key-value pairs
 */
async function updateEnvVariables(updates) {
  let content = '';

  if (fs.existsSync(configEnvPath)) {
    try { content = await fsPromises.readFile(configEnvPath, 'utf8'); } catch (e) {}
  } else if (fs.existsSync(dataEnvPath)) {
    try { content = await fsPromises.readFile(dataEnvPath, 'utf8'); } catch (e) {}
  } else if (fs.existsSync(rootEnvPath)) {
    try { content = await fsPromises.readFile(rootEnvPath, 'utf8'); } catch (e) {}
  }

  const lines = content.split('\n');
  const processedKeys = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.substring(0, eqIdx).trim();
      if (key in updates) {
        lines[i] = `${key}=${updates[key]}`;
        processedKeys.add(key);
      }
    }
  }

  for (const [key, val] of Object.entries(updates)) {
    if (!processedKeys.has(key)) {
      lines.push(`${key}=${val}`);
    }
  }

  const finalContent = lines.join('\n').trim() + '\n';
  await fsPromises.writeFile(configEnvPath, finalContent);
  try { await fsPromises.writeFile(dataEnvPath, finalContent); } catch (e) {}
  try { await fsPromises.writeFile(rootEnvPath, finalContent); } catch (e) {}
}

/**
 * GET /api/settings
 * Retrieve current configuration, Telegram connection state, storage stats, and preferences
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;

    // 1. Storage statistics from SQLite (scoped to user)
    const stats = db.getStorageStats(userId);

    // 2. Cache disk usage
    const cacheStats = getDirectorySize(cacheDir);

    // 3. Telegram connection state
    const client = telegram.getClient();
    let telegramConnected = false;
    let botInfo = null;

    if (client) {
      try {
        telegramConnected = client.connected || false;
        if (telegramConnected) {
          const me = await client.getMe().catch(() => null);
          if (me) {
            botInfo = {
              id: me.id ? me.id.toString() : null,
              username: me.username || null,
              firstName: me.firstName || 'TeleDrive Bot',
            };
          }
        }
      } catch (e) {
        telegramConnected = false;
      }
    }

    // 4. Return settings (credentials are safely masked to prevent XSS credential exfiltration)
    const rawBotToken = process.env.BOT_TOKEN || '';
    const rawApiHash = process.env.API_HASH || '';
    const maskedBotToken = rawBotToken.length > 8 
      ? rawBotToken.slice(0, 4) + '••••••••' + rawBotToken.slice(-4)
      : (rawBotToken ? '••••••••' : '');
    const maskedApiHash = rawApiHash.length > 8
      ? rawApiHash.slice(0, 4) + '••••••••' + rawApiHash.slice(-4)
      : (rawApiHash ? '••••••••' : '');

    return res.json({
      telegram: {
        apiId: process.env.API_ID || '',
        apiHash: maskedApiHash,
        botToken: maskedBotToken,
        channelId: process.env.CHANNEL_ID || '',
        isConfigured: Boolean(process.env.API_ID && process.env.API_HASH && process.env.BOT_TOKEN),
        connected: telegramConnected,
        botInfo,
      },
      storage: {
        totalFiles: stats ? stats.totalFiles : 0,
        totalBytes: stats ? stats.totalSize : 0,
        cacheBytes: cacheStats.totalSize,
        cacheFiles: cacheStats.fileCount,
        maxCacheBytes: require('../services/cacheManager').getMaxCacheLimitBytes(),
        maxCacheLimitGb: 3,
        plaintextCacheEnabled: process.env.PLAINTEXT_CACHE_ENABLED === 'true'
      },
      preferences: db.getAllSettings(userId),
      encryption: {
        algorithm: 'AES-256-GCM',
        enabled: true,
      },
      server: {
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
      }
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    return res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

/**
 * GET /api/settings/preferences
 * Retrieve user UI and upload preferences
 */
router.get('/preferences', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const preferences = db.getAllSettings(userId);
    return res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching user preferences:', error);
    return res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

/**
 * PUT /api/settings/preferences
 * Update user UI and upload preferences in SQLite database
 */
router.put('/preferences', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { preferences } = req.body;
    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'Invalid preferences object' });
    }

    const allowedKeys = ['theme', 'view_mode', 'sort_by', 'sort_order', 'chunk_size', 'concurrent_chunks', 'wake_lock'];
    const filtered = {};
    for (const key of allowedKeys) {
      if (preferences[key] !== undefined) {
        filtered[key] = String(preferences[key]);
      }
    }

    db.setMultipleSettings(filtered, userId);
    return res.json({ success: true, preferences: db.getAllSettings(userId) });
  } catch (error) {
    console.error('Error updating user preferences:', error);
    return res.status(500).json({ error: 'Failed to update preferences' });
  }
});

/**
 * POST /api/settings/telegram/test
 * Validates Telegram credentials on the fly
 */
router.post('/telegram/test', requireAdmin, async (req, res) => {
  try {
    let { apiId, apiHash, botToken, channelId } = req.body;
    if (apiHash && apiHash.includes('••••')) apiHash = process.env.API_HASH;
    if (botToken && botToken.includes('••••')) botToken = process.env.BOT_TOKEN;

    if (!apiId || !apiHash || !botToken || !channelId) {
      return res.status(400).json({ error: 'All Telegram fields (API ID, API Hash, Bot Token, Channel ID) are required' });
    }

    const testRes = await telegram.testConnection(parseInt(apiId, 10), apiHash, botToken, channelId);
    if (testRes.success) {
      return res.json({
        valid: true,
        message: 'Telegram credentials are valid and connection test succeeded!',
        bot: testRes.bot || null,
      });
    } else {
      return res.status(400).json({
        valid: false,
        error: testRes.error || 'Failed to connect to Telegram with provided credentials'
      });
    }
  } catch (error) {
    console.error('Error testing Telegram credentials:', error);
    return res.status(500).json({ valid: false, error: error.message || 'Telegram test failed' });
  }
});

/**
 * PUT /api/settings/telegram
 * Updates Telegram settings, writes to .env, and reconnects the client
 */
router.put('/telegram', requireAdmin, async (req, res) => {
  try {
    let { apiId, apiHash, botToken, channelId } = req.body;
    if (apiHash && apiHash.includes('••••')) apiHash = process.env.API_HASH;
    if (botToken && botToken.includes('••••')) botToken = process.env.BOT_TOKEN;

    if (!apiId || !apiHash || !botToken || !channelId) {
      return res.status(400).json({ error: 'All Telegram fields (API ID, API Hash, Bot Token, Channel ID) are required' });
    }

    // 1. Verify before saving
    const testRes = await telegram.testConnection(parseInt(apiId, 10), apiHash, botToken, channelId);
    if (!testRes.success) {
      return res.status(400).json({ error: `Validation failed: ${testRes.error || 'Invalid credentials'}` });
    }

    // 2. If bot token or API ID changed, clear old session file so fresh session is established
    if (process.env.BOT_TOKEN !== botToken || process.env.API_ID !== apiId.toString()) {
      try {
        if (fs.existsSync(sessionFile)) {
          fs.unlinkSync(sessionFile);
        }
      } catch (e) {}
    }

    // 3. Update .env file
    await updateEnvVariables({
      API_ID: apiId.toString(),
      API_HASH: apiHash,
      BOT_TOKEN: botToken,
      CHANNEL_ID: channelId,
    });

    // 4. Update process.env
    process.env.API_ID = apiId.toString();
    process.env.API_HASH = apiHash;
    process.env.BOT_TOKEN = botToken;
    process.env.CHANNEL_ID = channelId;

    // 5. Reinitialize Telegram client
    try {
      await telegram.initialize(parseInt(apiId, 10), apiHash, botToken);
    } catch (tgErr) {
      console.warn('[Settings] Telegram re-init warning:', tgErr.message);
    }

    return res.json({
      success: true,
      message: 'Telegram settings updated and client connected successfully!',
      bot: testRes.bot || null,
    });
  } catch (error) {
    console.error('Error updating Telegram settings:', error);
    return res.status(500).json({ error: error.message || 'Failed to update Telegram settings' });
  }
});

/**
 * POST /api/settings/clear-cache
 * Clears local decrypted media cache to free disk space
 */
router.post('/clear-cache', requireAdmin, async (req, res) => {
  try {
    let deletedCount = 0;
    let freedBytes = 0;

    if (fs.existsSync(cacheDir)) {
      const files = await fsPromises.readdir(cacheDir);
      for (const file of files) {
        const filePath = path.join(cacheDir, file);
        try {
          const stats = await fsPromises.stat(filePath);
          freedBytes += stats.size;
          await fsPromises.unlink(filePath);
          deletedCount++;
        } catch (e) {}
      }
    }

    return res.json({
      success: true,
      deletedCount,
      freedBytes,
      message: `Cleared ${deletedCount} cached files (${(freedBytes / (1024 * 1024)).toFixed(2)} MB freed).`,
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    return res.status(500).json({ error: 'Failed to clear local cache' });
  }
});

/**
 * GET /api/settings/webdav
 * Retrieve WebDAV configuration and status
 */
router.get('/webdav', requireAdmin, async (req, res) => {
  try {
    const enabled = (db.getSetting('webdav_enabled') !== 'false') && (process.env.WEBDAV_ENABLED !== 'false');
    const permissionMode = db.getSetting('webdav_permission_mode') || process.env.WEBDAV_PERMISSION_MODE || 'full';
    const username = db.getSetting('webdav_username') || process.env.WEBDAV_USERNAME || 'admin';
    const hasCustomPassword = Boolean(db.getSetting('webdav_password_hash') || process.env.WEBDAV_PASSWORD_HASH || process.env.WEBDAV_PASSWORD);

    return res.json({
      enabled,
      permissionMode,
      username,
      hasCustomPassword,
      urlPath: '/webdav',
      userEmail: req.user ? req.user.email : 'admin',
      userName: req.user ? req.user.name : 'Admin'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch WebDAV settings' });
  }
});

/**
 * POST /api/settings/webdav
 * Update WebDAV configuration, permission mode, and credentials
 */
router.post('/webdav', requireAdmin, async (req, res) => {
  try {
    const { enabled, permissionMode, username, password, resetPassword } = req.body;

    const updates = {};
    if (enabled !== undefined) {
      const val = enabled ? 'true' : 'false';
      process.env.WEBDAV_ENABLED = val;
      updates.WEBDAV_ENABLED = val;
      db.setSetting('webdav_enabled', val);
    }

    if (permissionMode !== undefined) {
      const validModes = ['full', 'readonly', 'safemode'];
      const mode = validModes.includes(permissionMode) ? permissionMode : 'full';
      process.env.WEBDAV_PERMISSION_MODE = mode;
      updates.WEBDAV_PERMISSION_MODE = mode;
      db.setSetting('webdav_permission_mode', mode);
    }

    if (username !== undefined && username.trim()) {
      const user = username.trim();
      process.env.WEBDAV_USERNAME = user;
      updates.WEBDAV_USERNAME = user;
      db.setSetting('webdav_username', user);
    }

    if (resetPassword) {
      // Clear custom WebDAV password so authentication falls back to User Account / Master Password
      delete process.env.WEBDAV_PASSWORD_HASH;
      delete process.env.WEBDAV_PASSWORD;
      updates.WEBDAV_PASSWORD_HASH = '';
      updates.WEBDAV_PASSWORD = '';
      db.setSetting('webdav_password_hash', '');
    } else if (password !== undefined && password.trim()) {
      const pass = password.trim();
      const passHash = bcrypt.hashSync(pass, 10);
      process.env.WEBDAV_PASSWORD_HASH = passHash;
      process.env.WEBDAV_PASSWORD = pass;
      updates.WEBDAV_PASSWORD_HASH = passHash;
      updates.WEBDAV_PASSWORD = pass;
      db.setSetting('webdav_password_hash', passHash);
    }

    await updateEnvVariables(updates);

    const hasCustomPassword = Boolean(db.getSetting('webdav_password_hash') || process.env.WEBDAV_PASSWORD_HASH || process.env.WEBDAV_PASSWORD);

    return res.json({
      success: true,
      message: resetPassword ? 'WebDAV password reset to Account/Master Password!' : 'WebDAV settings updated successfully!',
      settings: {
        enabled: (db.getSetting('webdav_enabled') !== 'false') && (process.env.WEBDAV_ENABLED !== 'false'),
        permissionMode: db.getSetting('webdav_permission_mode') || process.env.WEBDAV_PERMISSION_MODE || 'full',
        username: db.getSetting('webdav_username') || process.env.WEBDAV_USERNAME || 'admin',
        hasCustomPassword,
      }
    });
  } catch (error) {
    console.error('Error updating WebDAV settings:', error);
    return res.status(500).json({ error: 'Failed to update WebDAV settings: ' + error.message });
  }
});

/**
 * POST /api/settings/webdav/test-auth
 * Test WebDAV credentials directly from settings UI
 */
router.post('/webdav/test-auth', requireAdmin, (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required to test credentials.' });
    }

    const testUser = username.trim().toLowerCase();
    const testPass = password;

    const configuredWebdavUser = (db.getSetting('webdav_username') || process.env.WEBDAV_USERNAME || 'admin').trim().toLowerCase();
    const configuredWebdavPassHash = db.getSetting('webdav_password_hash') || process.env.WEBDAV_PASSWORD_HASH;
    const configuredWebdavPassPlain = process.env.WEBDAV_PASSWORD;
    const adminPasswordHash = process.env.MASTER_PASSWORD_HASH || process.env.ADMIN_PASSWORD_HASH;

    let matchedMethod = null;

    // 1. Check custom WebDAV password
    if (configuredWebdavPassHash && (testUser === configuredWebdavUser || testUser === 'admin')) {
      try {
        if (bcrypt.compareSync(testPass, configuredWebdavPassHash)) {
          matchedMethod = 'Custom WebDAV Credentials';
        }
      } catch (e) {}
    }
    if (!matchedMethod && configuredWebdavPassPlain && (testUser === configuredWebdavUser || testUser === 'admin')) {
      if (testPass === configuredWebdavPassPlain) {
        matchedMethod = 'Custom WebDAV Credentials';
      }
    }

    // 2. Check Master Admin password
    if (!matchedMethod && adminPasswordHash && (testUser === configuredWebdavUser || testUser === 'admin')) {
      try {
        if (bcrypt.compareSync(testPass, adminPasswordHash)) {
          matchedMethod = 'Master Admin Password';
        }
      } catch (e) {}
    }

    // 3. Check DB User Accounts
    if (!matchedMethod) {
      try {
        const allUsers = db.getAllUsers();
        const matchedDbUser = allUsers.find(u => u.email.toLowerCase() === testUser || (u.name && u.name.toLowerCase() === testUser));
        if (matchedDbUser && matchedDbUser.status === 'active') {
          if (bcrypt.compareSync(testPass, matchedDbUser.password_hash)) {
            matchedMethod = `User Account (${matchedDbUser.email})`;
          }
        }
      } catch (e) {}
    }

    if (matchedMethod) {
      return res.json({
        success: true,
        message: `Credentials verified successfully using ${matchedMethod}! You can use these credentials to connect from Windows, Mac, or mobile.`
      });
    } else {
      return res.status(401).json({
        success: false,
        error: 'Authentication failed: Incorrect username or password.'
      });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/settings/webdav/sessions
 * List all real-time connected WebDAV devices & sessions
 */
router.get('/webdav/sessions', requireAdmin, (req, res) => {
  try {
    const sessionTracker = require('../services/sessionTracker');
    const sessions = sessionTracker.getActiveSessions();
    return res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch active device sessions' });
  }
});

/**
 * POST /api/settings/webdav/sessions/revoke
 * Disconnect / Block a specific device session
 */
router.post('/webdav/sessions/revoke', requireAdmin, (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const sessionTracker = require('../services/sessionTracker');
    sessionTracker.revokeSession(sessionId);
    return res.json({ success: true, message: 'Device disconnected successfully!' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to revoke device session' });
  }
});

/**
 * POST /api/settings/webdav/sessions/unrevoke
 * Re-allow a previously disconnected device session
 */
router.post('/webdav/sessions/unrevoke', requireAdmin, (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    const sessionTracker = require('../services/sessionTracker');
    sessionTracker.unrevokeSession(sessionId);
    return res.json({ success: true, message: 'Device re-allowed successfully!' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to unrevoke device session' });
  }
});

const multer = require('multer');
const tmpDbDir = path.join(__dirname, '../../data/tmp');
if (!fs.existsSync(tmpDbDir)) {
  fs.mkdirSync(tmpDbDir, { recursive: true });
}
const uploadDb = multer({ dest: tmpDbDir });

/**
 * GET /api/settings/export-db
 * Download teledrive.db backup file
 */
router.get('/export-db', requireAdmin, async (req, res) => {
  try {
    const dbPath = path.join(__dirname, '../../data/teledrive.db');
    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: 'Database file not found' });
    }
    const filename = `teledrive-backup-${new Date().toISOString().slice(0, 10)}.db`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/x-sqlite3');
    return res.sendFile(dbPath);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to export database' });
  }
});

/**
 * POST /api/settings/import-db
 * Upload and restore database backup (.enc.db or .db) with automatic decryption and integrity check
 */
router.post('/import-db', requireAdmin, uploadDb.single('database'), async (req, res) => {
  let uploadedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No database file provided' });
    }
    uploadedPath = req.file.path;
    const backupService = require('../services/backup');
    const result = await backupService.restoreBackupFromFile(uploadedPath, req.file.originalname);
    return res.json(result);
  } catch (error) {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { await fsPromises.unlink(uploadedPath); } catch (e) {}
    }
    console.error('Error importing database:', error);
    return res.status(400).json({ error: error.message || 'Failed to restore database' });
  }
});

/**
 * POST /api/settings/restore-cloud-backup
 * 1-Click Restore database directly from Telegram Cloud backup
 */
router.post('/restore-cloud-backup', requireAdmin, async (req, res) => {
  try {
    const { telegramMessageId } = req.body;
    if (!telegramMessageId) {
      return res.status(400).json({ error: 'telegramMessageId is required' });
    }
    const backupService = require('../services/backup');
    const result = await backupService.restoreBackupFromTelegram(telegramMessageId);
    return res.json(result);
  } catch (error) {
    console.error('Error restoring cloud backup:', error);
    return res.status(400).json({ error: error.message || 'Failed to restore cloud backup' });
  }
});

/**
 * GET /api/settings/backup-status
 * Get status of automated cloud backups and history
 */
router.get('/backup-status', requireAdmin, async (req, res) => {
  try {
    const backupService = require('../services/backup');
    const status = backupService.getBackupStatus();
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to retrieve backup status: ' + error.message });
  }
});

/**
 * POST /api/settings/backup-now
 * Trigger immediate encrypted database backup to Telegram
 */
router.post('/backup-now', requireAdmin, async (req, res) => {
  try {
    const backupService = require('../services/backup');
    const result = await backupService.createEncryptedBackup();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create backup' });
  }
});

module.exports = router;
