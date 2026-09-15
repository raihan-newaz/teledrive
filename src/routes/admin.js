const express = require('express');
const bcrypt = require('bcryptjs');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const db = require('../db');
const cryptoModule = require('../crypto');

const router = express.Router();

// Apply auth + requireAdmin to all admin routes
router.use(authMiddleware);
router.use(requireAdmin);

/**
 * GET /api/admin/users
 * Returns list of all user accounts with storage usage & stats
 */
router.get('/users', async (req, res) => {
  try {
    const users = db.getAllUsers();
    const enriched = users.map(user => {
      const stats = db.getUserStorageStats(user.id);
      return {
        ...user,
        totalFiles: stats.totalFiles,
        storageUsed: stats.totalSize,
        last_login: user.last_login_at || null,
        lastLoginAt: user.last_login_at || null
      };
    });
    return res.json({ success: true, users: enriched });
  } catch (error) {
    console.error('[Admin] Error fetching users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * POST /api/admin/users
 * Creates a new family member / user account
 */
router.post('/users', async (req, res) => {
  try {
    const { name, email, password, role, status, storageLimit, filePrefix } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (trimmedEmail.length < 3 || !trimmedEmail.includes('@')) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const existing = db.getUserByEmail(trimmedEmail);
    if (existing) {
      return res.status(400).json({ error: 'A user with this email address already exists' });
    }

    // 1. Generate unique 32-byte AES key for this user
    const rawUserKey = cryptoModule.generateUserEncryptionKey();
    
    // 2. Wrap user key with server's master encryption key
    const masterKey = process.env.ENCRYPTION_KEY || 'default-encryption-key';
    const wrappedKey = cryptoModule.wrapUserKey(rawUserKey, masterKey);

    // 3. Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // 4. Parse storage limit (in bytes)
    let limitBytes = 0;
    if (storageLimit !== undefined && storageLimit !== null) {
      limitBytes = parseInt(storageLimit, 10) || 0;
    }

    // Clean file prefix if provided (alphanumeric, underscore, hyphen)
    const cleanedPrefix = (typeof filePrefix === 'string' && filePrefix.trim()) ? filePrefix.trim().replace(/[^a-zA-Z0-9_-]/g, '') : null;

    // 5. Create user in DB
    const newUser = db.createUser({
      name: name.trim(),
      email: trimmedEmail,
      passwordHash,
      role: role === 'admin' ? 'admin' : 'user',
      status: status === 'suspended' ? 'suspended' : 'active',
      encryptionKey: wrappedKey,
      storageLimit: limitBytes,
      filePrefix: cleanedPrefix
    });

    return res.status(201).json({
      success: true,
      message: `User account "${newUser.name}" created successfully`,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
        status: newUser.status,
        storageLimit: newUser.storage_limit,
        storageUsed: 0,
        filePrefix: newUser.file_prefix,
        createdAt: newUser.created_at
      }
    });
  } catch (error) {
    console.error('[Admin] Error creating user:', error);
    return res.status(500).json({ error: 'Failed to create user account' });
  }
});

/**
 * PUT /api/admin/users/:id
 * Updates an existing user's details, role, status, or quota
 */
router.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, status, storageLimit, filePrefix } = req.body;

    const user = db.getUserById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Prevent demoting or suspending the currently logged in admin user
    if (id === req.user.id) {
      if (status === 'suspended') {
        return res.status(400).json({ error: 'You cannot suspend your own admin account.' });
      }
      if (role === 'user') {
        return res.status(400).json({ error: 'You cannot demote your own admin account.' });
      }
    }

    const updates = {};
    if (name && typeof name === 'string') updates.name = name.trim();
    if (role && (role === 'admin' || role === 'user')) updates.role = role;
    if (status && (status === 'active' || status === 'suspended')) updates.status = status;
    if (storageLimit !== undefined && storageLimit !== null) {
      updates.storageLimit = parseInt(storageLimit, 10) || 0;
    }
    if (filePrefix !== undefined) {
      const cleanedPrefix = (typeof filePrefix === 'string' && filePrefix.trim()) ? filePrefix.trim().replace(/[^a-zA-Z0-9_-]/g, '') : null;
      updates.filePrefix = cleanedPrefix;
    }

    if (email && typeof email === 'string' && email.trim()) {
      const trimmedEmail = email.trim().toLowerCase();
      const existing = db.getUserByEmail(trimmedEmail);
      if (existing && existing.id !== id) {
        return res.status(400).json({ error: 'Email is already used by another account.' });
      }
      updates.email = trimmedEmail;
    }

    const updated = db.updateUser(id, updates);
    return res.json({
      success: true,
      message: 'User updated successfully',
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        status: updated.status,
        storageLimit: updated.storage_limit,
        storageUsed: updated.storage_used,
        filePrefix: updated.file_prefix,
        updatedAt: updated.updated_at
      }
    });
  } catch (error) {
    console.error('[Admin] Error updating user:', error);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * POST /api/admin/users/:id/reset-password
 * Admin resets a user's password
 */
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { id } = req.params;
    const newPassword = req.body.newPassword || req.body.password;

    if (!newPassword || (typeof newPassword === 'string' && newPassword.trim().length < 6)) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const user = db.getUserById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    db.updateUser(id, { passwordHash });

    return res.json({ success: true, message: `Password for "${user.name}" reset successfully.` });
  } catch (error) {
    console.error('[Admin] Error resetting password:', error);
    return res.status(500).json({ error: 'Failed to reset user password' });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Permanently deletes a user account and all their files
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own active admin account.' });
    }

    const user = db.getUserById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    db.deleteUser(id);
    return res.json({ success: true, message: `User "${user.name}" and all associated data were deleted.` });
  } catch (error) {
    console.error('[Admin] Error deleting user:', error);
    return res.status(500).json({ error: 'Failed to delete user account' });
  }
});

/**
 * GET /api/admin/stats
 * Global admin statistics across all users
 */
router.get('/stats', async (req, res) => {
  try {
    const users = db.getAllUsers();
    let totalStorageUsed = 0;
    let totalStorageLimit = 0;
    let activeUsers = 0;

    users.forEach(u => {
      const stats = db.getUserStorageStats(u.id);
      totalStorageUsed += (stats.totalSize || 0);
      totalStorageLimit += (u.storage_limit || 0);
      if (u.status === 'active') activeUsers++;
    });

    const globalStats = db.getStorageStats();

    return res.json({
      success: true,
      stats: {
        totalUsers: users.length,
        activeUsers,
        totalFiles: globalStats.totalFiles,
        totalStorageUsed,
        totalStorageLimit,
        telegramStorageTotal: globalStats.totalSize
      }
    });
  } catch (error) {
    console.error('[Admin] Error fetching stats:', error);
    return res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

/**
 * GET /api/admin/storage/stats
 * Detailed system-wide storage metrics for admin dashboard
 */
router.get('/storage/stats', (req, res) => {
  try {
    const stats = db.getAdminStorageAnalytics();
    return res.json({ success: true, stats });
  } catch (error) {
    console.error('[Admin Storage API] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch admin storage stats' });
  }
});

/**
 * GET /api/admin/storage/breakdown
 * Aggregate storage breakdown by file type across system (without revealing private files)
 */
router.get('/storage/breakdown', (req, res) => {
  try {
    const breakdown = db.getAdminStorageBreakdown();
    return res.json({ success: true, ...breakdown });
  } catch (error) {
    console.error('[Admin Storage API] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch admin storage breakdown' });
  }
});

/**
 * GET /api/admin/storage/users
 * User storage consumption list for admin
 */
router.get('/storage/users', (req, res) => {
  try {
    const users = db.getAdminUserStorageList();
    return res.json({ success: true, users });
  } catch (error) {
    console.error('[Admin Storage API] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch admin user storage' });
  }
});

/**
 * POST /api/admin/storage/reconcile
 * Trigger storage usage reconciliation across all users
 */
router.post('/storage/reconcile', (req, res) => {
  try {
    const result = db.reconcileAllUserStorage();
    return res.json({ success: true, message: 'Storage reconciliation completed', result });
  } catch (error) {
    console.error('[Admin Storage API] Error:', error);
    return res.status(500).json({ error: 'Failed to reconcile storage' });
  }
});

module.exports = router;