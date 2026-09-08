const express = require('express');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const telegram = require('../telegram');
const db = require('../db');

const router = express.Router();
router.use(authMiddleware);

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const dataEnvPath = path.join(dataDir, '.env');
const rootEnvPath = path.join(__dirname, '../../.env');
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

/**
 * Helper to update .env key-value pairs
 */
async function updateEnvVariables(updates) {
  let targetPath = dataEnvPath;
  let content = '';

  if (fs.existsSync(dataEnvPath)) {
    targetPath = dataEnvPath;
    try { content = await fsPromises.readFile(dataEnvPath, 'utf8'); } catch (e) {}
  } else if (fs.existsSync(rootEnvPath)) {
    try {
      if (!fs.statSync(rootEnvPath).isDirectory()) {
        targetPath = rootEnvPath;
        content = await fsPromises.readFile(rootEnvPath, 'utf8');
      }
    } catch (e) {}
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

  await fsPromises.writeFile(targetPath, lines.join('\n').trim() + '\n');
}

/**
 * GET /api/settings
 * Retrieve current configuration, Telegram connection state, storage stats, and preferences
 */
router.get('/', async (req, res) => {
  try {
    // 1. Storage statistics from SQLite
    const stats = db.getStorageStats();

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

    // 4. Return settings (credentials are safely provided for owner's admin control)
    return res.json({
      telegram: {
        apiId: process.env.API_ID || '',
        apiHash: process.env.API_HASH || '',
        botToken: process.env.BOT_TOKEN || '',
        channelId: process.env.CHANNEL_ID || '',
        connected: telegramConnected,
        botInfo,
      },
      storage: {
        totalFiles: stats ? stats.totalFiles : 0,
        totalBytes: stats ? stats.totalSize : 0,
        cacheBytes: cacheStats.totalSize,
        cacheFiles: cacheStats.fileCount,
      },
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
 * POST /api/settings/telegram/test
 * Validates Telegram credentials on the fly
 */
router.post('/telegram/test', async (req, res) => {
  try {
    const { apiId, apiHash, botToken, channelId } = req.body;
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
router.put('/telegram', async (req, res) => {
  try {
    const { apiId, apiHash, botToken, channelId } = req.body;
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
router.post('/clear-cache', async (req, res) => {
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
router.get('/export-db', async (req, res) => {
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
 * Upload and restore teledrive.db
 */
router.post('/import-db', uploadDb.single('database'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No database file provided' });
    }
    const uploadedPath = req.file.path;
    const dbPath = path.join(__dirname, '../../data/teledrive.db');
    
    await fsPromises.copyFile(uploadedPath, dbPath);
    await fsPromises.unlink(uploadedPath);
    await db.initialize();

    return res.json({
      success: true,
      message: 'Database imported and restored successfully!'
    });
  } catch (error) {
    console.error('Error importing database:', error);
    return res.status(500).json({ error: error.message || 'Failed to import database' });
  }
});

module.exports = router;
