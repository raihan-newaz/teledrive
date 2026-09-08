const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const telegram = require('../telegram');
const { isSetupComplete } = require('../config');

const router = express.Router();

/**
 * Helper to get the path of the .env file
 */
const getEnvPath = () => path.join(__dirname, '../../.env');

/**
 * GET /status
 * Checks if all required configuration is present
 */
router.get('/status', (req, res) => {
    try {
        const requiredVars = [
            'API_ID', 'API_HASH', 'BOT_TOKEN', 'CHANNEL_ID', 
            'MASTER_PASSWORD_HASH', 'ENCRYPTION_KEY', 'JWT_SECRET'
        ];

        const missingFields = requiredVars.filter(key => !process.env[key]);

        res.json({
            isComplete: missingFields.length === 0,
            missingFields
        });
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /validate
 * Tests Telegram API credentials
 */
router.post('/validate', async (req, res) => {
    try {
        if (isSetupComplete()) {
            return res.status(403).json({ error: 'Setup already completed' });
        }

        const { apiId, apiHash, botToken, channelId } = req.body;

        if (!apiId || !apiHash || !botToken || !channelId) {
            return res.status(400).json({ error: 'Missing required Telegram credentials' });
        }

        const result = await telegram.testConnection(parseInt(apiId), apiHash, botToken, channelId);
        const valid = result.success;

        if (valid) {
            return res.json({ valid: true, bot: result.bot || null });
        } else {
            return res.status(400).json({ valid: false, error: result.error || 'Telegram validation failed with provided credentials' });
        }
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ valid: false, error: error.message || 'Validation failed' });
    }
});

/**
 * POST /complete
 * Finalizes the setup, hashes master password, generates JWT secret, and writes .env
 */
router.post('/complete', async (req, res) => {
    try {
        if (isSetupComplete()) {
            return res.status(403).json({ error: 'Setup already completed. Please authenticate to change settings.' });
        }

        const { apiId, apiHash, botToken, channelId, masterPassword, encryptionKey } = req.body;

        if (!apiId || !apiHash || !botToken || !channelId || !masterPassword || !encryptionKey) {
            return res.status(400).json({ error: 'Missing required fields to complete setup' });
        }

        // Generate secrets
        const masterPasswordHash = await bcrypt.hash(masterPassword, 12);
        const jwtSecret = crypto.randomBytes(32).toString('hex');

        // Prepare ENV content string
        const envContent = `API_ID=${apiId}
API_HASH=${apiHash}
BOT_TOKEN=${botToken}
CHANNEL_ID=${channelId}
MASTER_PASSWORD_HASH=${masterPasswordHash}
ENCRYPTION_KEY=${encryptionKey}
JWT_SECRET=${jwtSecret}
PORT=${process.env.PORT || 3000}
`;

        // Save to persistent data directory (config.env & .env)
        const dataDir = path.join(__dirname, '../../data');
        const fsSync = require('fs');
        if (!fsSync.existsSync(dataDir)) {
            fsSync.mkdirSync(dataDir, { recursive: true });
        }
        
        fsSync.writeFileSync(path.join(dataDir, 'config.env'), envContent);
        fsSync.writeFileSync(path.join(dataDir, '.env'), envContent);

        // Load them into the current process environment dynamically
        process.env.API_ID = apiId.toString();
        process.env.API_HASH = apiHash;
        process.env.BOT_TOKEN = botToken;
        process.env.CHANNEL_ID = channelId.toString();
        process.env.MASTER_PASSWORD_HASH = masterPasswordHash;
        process.env.ENCRYPTION_KEY = encryptionKey;
        process.env.JWT_SECRET = jwtSecret;

        // Initialize telegram client
        try {
            await telegram.initialize(parseInt(apiId, 10), apiHash, botToken);
        } catch (tgErr) {
            console.warn('[Setup] Telegram client init warning:', tgErr.message);
        }

        return res.json({ success: true, message: 'Setup completed successfully!' });
    } catch (error) {
        console.error('Setup completion error:', error);
        res.status(500).json({ error: error.message || 'Failed to complete setup' });
    }
});

module.exports = router;
