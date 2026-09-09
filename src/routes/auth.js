const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs/promises');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

/**
 * Utility to update .env and config.env files across persistent data locations
 * @param {string} key 
 * @param {string} value 
 */
async function updateEnvFile(key, value) {
    const envPaths = [
        path.join(__dirname, '../../data/config.env'),
        path.join(__dirname, '../../data/.env'),
        path.join(__dirname, '../../.env')
    ];

    for (const envPath of envPaths) {
        let content = '';
        try {
            content = await fs.readFile(envPath, 'utf8');
        } catch (e) {
            // If file doesn't exist, check if data dir exists
            const dir = path.dirname(envPath);
            try {
                const fsSync = require('fs');
                if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
            } catch (err) {}
        }

        const lines = content ? content.split('\n') : [];
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`${key}=`)) {
                lines[i] = `${key}=${value}`;
                found = true;
                break;
            }
        }
        if (!found) {
            lines.push(`${key}=${value}`);
        }

        try {
            await fs.writeFile(envPath, lines.join('\n').trim() + '\n');
        } catch (err) {
            console.warn(`[Auth] Warning writing to ${envPath}:`, err.message);
        }
    }
}

/**
 * POST /login
 * Authenticates user using master password
 */
router.post('/login', authLimiter, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const masterHash = process.env.MASTER_PASSWORD_HASH;
        if (!masterHash) {
            return res.status(500).json({ error: 'Setup incomplete: Master password not set' });
        }

        const isMatch = await bcrypt.compare(password, masterHash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        const expiresIn = 3600; // 1 hour
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn });

        res.cookie('teledrive_token', token, {
            httpOnly: true,
            sameSite: 'strict',
            maxAge: expiresIn * 1000
        });

        return res.json({ token, expiresIn });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /verify
 * Verifies if the current token is valid
 */
router.get('/verify', authMiddleware, (req, res) => {
    return res.json({ valid: true, expiresAt: req.user.exp });
});

/**
 * POST /logout
 * Clears the authentication cookie
 */
router.post('/logout', (req, res) => {
    res.clearCookie('teledrive_token');
    return res.json({ success: true });
});

/**
 * POST /change-password
 * Changes the master password and updates .env
 */
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Both current and new passwords are required' });
        }

        const masterHash = process.env.MASTER_PASSWORD_HASH;
        const isMatch = await bcrypt.compare(currentPassword, masterHash);
        
        if (!isMatch) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        await updateEnvFile('MASTER_PASSWORD_HASH', newHash);

        // Update process.env so it applies without restart
        process.env.MASTER_PASSWORD_HASH = newHash;

        return res.json({ success: true });
    } catch (error) {
        console.error('Change password error:', error);
        return res.status(500).json({ error: 'Internal server error while changing password' });
    }
});

module.exports = router;
