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

const db = require('../db');

/**
 * POST /login
 * Authenticates user using email + password (or password fallback for legacy setup)
 */
router.post('/login', authLimiter, async (req, res) => {
    try {
        let { email, password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        let user = null;

        if (email && typeof email === 'string' && email.trim()) {
            user = db.getUserByEmail(email.trim());
        } else {
            // Password-only fallback: find primary admin user or first admin
            user = db.getUserByEmail('admin@teledrive.local') || db.getAllUsers().find(u => u.role === 'admin') || db.getAllUsers()[0];
        }

        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        if (user.status === 'suspended') {
            return res.status(403).json({ error: 'Your account is suspended. Please contact your administrator.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Update last login timestamp
        db.updateUserLastLogin(user.id);

        const expiresIn = 30 * 24 * 3600; // 30 days
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET,
            { algorithm: 'HS256', expiresIn }
        );

        res.cookie('teledrive_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: expiresIn * 1000
        });

        // Recalculate and return fresh storage info
        const storageUsed = db.recalculateUserStorage(user.id);
        const preferences = db.getAllSettings(user.id);

        return res.json({
            token,
            expiresIn,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                status: user.status,
                storageLimit: user.storage_limit || 0,
                storageUsed
            },
            preferences
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /me
 * Returns current authenticated user profile & quota
 */
router.get('/me', authMiddleware, (req, res) => {
    const user = db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const storageUsed = db.recalculateUserStorage(user.id);
    const preferences = db.getAllSettings(user.id);

    return res.json({
        user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            status: user.status,
            storageLimit: user.storage_limit || 0,
            storageUsed,
            lastLoginAt: user.last_login_at,
            createdAt: user.created_at
        },
        preferences
    });
});

/**
 * GET /verify
 * Verifies if the current token is valid
 */
router.get('/verify', authMiddleware, (req, res) => {
    const preferences = db.getAllSettings(req.user.id);
    return res.json({
        valid: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            name: req.user.name,
            role: req.user.role,
            storageLimit: req.user.storageLimit,
            storageUsed: req.user.storageUsed
        },
        preferences,
        expiresAt: req.user.tokenExp
    });
});

/**
 * POST /refresh
 * Refreshes the authentication token for active users
 */
router.post('/refresh', authMiddleware, (req, res) => {
    try {
        const expiresIn = 30 * 24 * 3600; // 30 days
        const token = jwt.sign(
            { id: req.user.id, email: req.user.email, role: req.user.role },
            process.env.JWT_SECRET,
            { algorithm: 'HS256', expiresIn }
        );

        res.cookie('teledrive_token', token, {
            httpOnly: true,
            sameSite: 'strict',
            maxAge: expiresIn * 1000
        });

        return res.json({ token, expiresIn });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to refresh token' });
    }
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
 * PUT /profile
 * Updates user name and/or email
 */
router.put('/profile', authMiddleware, async (req, res) => {
    try {
        const { name, email } = req.body;
        const updates = {};

        if (name && typeof name === 'string' && name.trim()) {
            updates.name = name.trim();
        }

        if (email && typeof email === 'string' && email.trim()) {
            const trimmedEmail = email.trim().toLowerCase();
            const existing = db.getUserByEmail(trimmedEmail);
            if (existing && existing.id !== req.user.id) {
                return res.status(400).json({ error: 'This email is already in use by another account.' });
            }
            updates.email = trimmedEmail;
        }

        const updated = db.updateUser(req.user.id, updates);
        return res.json({
            success: true,
            user: {
                id: updated.id,
                email: updated.email,
                name: updated.name,
                role: updated.role,
                storageLimit: updated.storage_limit,
                storageUsed: updated.storage_used
            }
        });
    } catch (error) {
        console.error('Profile update error:', error);
        return res.status(500).json({ error: 'Failed to update profile' });
    }
});

/**
 * POST /change-password
 * Changes the current user's password
 */
router.post('/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Both current and new passwords are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters long' });
        }

        const user = db.getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = await bcrypt.hash(newPassword, 12);
        db.updateUser(req.user.id, { passwordHash: newHash });

        // If user is Admin, also sync master password hash in .env
        if (user.role === 'admin') {
            await updateEnvFile('MASTER_PASSWORD_HASH', newHash);
            process.env.MASTER_PASSWORD_HASH = newHash;
        }

        return res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        return res.status(500).json({ error: 'Internal server error while changing password' });
    }
});

module.exports = router;
