const express = require('express');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const db = require('../db');
const telegram = require('../telegram');

const router = express.Router();
router.use(authMiddleware);

/**
 * Helper to build breadcrumbs from bottom to top
 * @param {string|null} folderId 
 * @param {string} userId
 * @returns {Promise<Array>} Array of {id, name}
 */
async function getBreadcrumbs(folderId, userId) {
    const breadcrumbs = [];
    let currentId = (folderId && folderId !== 'null' && folderId !== 'undefined' && String(folderId).trim() !== '') ? String(folderId).trim() : null;

    while (currentId) {
        const folder = await db.get('SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?', [currentId, userId]);
        if (!folder) break;
        
        breadcrumbs.unshift({ id: folder.id, name: folder.name });
        currentId = (folder.parent_id && folder.parent_id !== 'null' && folder.parent_id !== 'undefined' && String(folder.parent_id).trim() !== '') ? String(folder.parent_id).trim() : null;
    }
    
    // Add root
    breadcrumbs.unshift({ id: null, name: 'My Drive' });
    return breadcrumbs;
}

/**
 * Recursive delete helper — safely moves files to Trash instead of hard deleting from Telegram
 * @param {string} folderId 
 * @param {string} userId
 * @returns {Promise<Object>} Object with counts
 */
async function deleteFolderRecursive(folderId, userId) {
    let deletedFiles = 0;
    let deletedFolders = 0;

    const now = new Date().toISOString();

    // Move files in this folder to Trash (keeps files safe on Telegram)
    const files = await db.all('SELECT id FROM files WHERE folder_id = ? AND user_id = ?', [folderId, userId]);
    for (const file of files) {
        db.run('UPDATE files SET is_trashed = 1, trashed_at = ?, folder_id = NULL WHERE id = ? AND user_id = ?', [now, file.id, userId]);
        deletedFiles++;
    }

    // Recursively process subfolders
    const subfolders = await db.all('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?', [folderId, userId]);
    for (const sub of subfolders) {
        const res = await deleteFolderRecursive(sub.id, userId);
        deletedFiles += res.deletedFiles;
        deletedFolders += res.deletedFolders;
    }

    // Delete the empty folder metadata
    await db.run('DELETE FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]);
    deletedFolders++;

    if (userId) db.recalculateUserStorage(userId);

    return { deletedFiles, deletedFolders };
}

/**
 * Permanently deletes folder and all contained files from Telegram, local cache, and SQLite DB
 * @param {string} folderId 
 * @param {string} userId
 * @returns {Promise<Object>} Object with counts
 */
async function permanentlyDeleteFolderRecursive(folderId, userId) {
    let deletedFiles = 0;
    let deletedFolders = 0;

    // 1. Recursively process subfolders first
    const subfolders = await db.all('SELECT id FROM folders WHERE parent_id = ? AND user_id = ?', [folderId, userId]);
    for (const sub of subfolders) {
        const res = await permanentlyDeleteFolderRecursive(sub.id, userId);
        deletedFiles += res.deletedFiles;
        deletedFolders += res.deletedFolders;
    }

    // 2. Permanently delete all files inside this folder from Telegram & DB
    const files = await db.all('SELECT * FROM files WHERE folder_id = ? AND user_id = ?', [folderId, userId]);
    const filesRouter = require('./files');
    for (const file of files) {
        if (filesRouter.permanentlyDeleteFile) {
            await filesRouter.permanentlyDeleteFile(file, { throwOnError: true, user: { id: userId } });
            deletedFiles++;
        }
    }

    // 3. Delete the folder metadata from database
    await db.run('DELETE FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]);
    deletedFolders++;

    if (userId) db.recalculateUserStorage(userId);

    return { deletedFiles, deletedFolders };
}

const bcrypt = require('bcryptjs');

function generateFolderToken(folderId) {
    const secret = process.env.JWT_SECRET || 'teledrive_folder_secret';
    return crypto.createHmac('sha256', secret).update(`folder_access:${folderId}`).digest('hex');
}

function verifyFolderToken(folderId, token) {
    if (!token || typeof token !== 'string') return false;
    const expected = generateFolderToken(folderId);
    const bufA = Buffer.from(token);
    const bufB = Buffer.from(expected);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeFolder(f) {
    if (!f) return null;
    const { password_hash, ...rest } = f;
    return {
        ...rest,
        is_locked: (f.is_locked === 1 || Boolean(password_hash)) ? 1 : 0
    };
}

/**
 * GET /
 */
router.get('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const { search } = req.query;
        if (search) {
            const rawFolders = db.searchFolders(search, userId);
            const folders = (rawFolders || []).map(sanitizeFolder);
            return res.json({ folders, files: [], breadcrumbs: [] });
        }

        const rawParentId = req.query.parentId;
        const parentId = (rawParentId && rawParentId !== 'null' && rawParentId !== 'undefined' && String(rawParentId).trim() !== '') ? String(rawParentId).trim() : null;
        const currentFolder = parentId ? await db.getFolder(parentId, userId) : null;
        const breadcrumbs = await getBreadcrumbs(parentId, userId);

        // Security: If current folder is locked, verify HMAC folder token before returning contents
        if (currentFolder && (currentFolder.is_locked === 1 || Boolean(currentFolder.password_hash))) {
            const token = req.headers['x-folder-token'] || req.query.folderToken;
            const isUnlocked = verifyFolderToken(parentId, token);
            if (!isUnlocked) {
                return res.json({
                    currentFolder: sanitizeFolder(currentFolder),
                    folders: [],
                    files: [],
                    breadcrumbs,
                    isLocked: true
                });
            }
        }
        
        const foldersQuery = parentId ? 
            'SELECT * FROM folders WHERE parent_id = ? AND user_id = ? ORDER BY name ASC' : 
            'SELECT * FROM folders WHERE (parent_id IS NULL OR parent_id = "" OR parent_id = "null") AND user_id = ? ORDER BY name ASC';
        
        const rawFolders = await db.all(foldersQuery, parentId ? [parentId, userId] : [userId]);
        const folders = (rawFolders || []).map(sanitizeFolder);
        
        const filesQuery = parentId ? 
            'SELECT * FROM files WHERE folder_id = ? AND user_id = ? AND is_trashed = 0 ORDER BY name ASC' : 
            'SELECT * FROM files WHERE (folder_id IS NULL OR folder_id = "" OR folder_id = "null") AND user_id = ? AND is_trashed = 0 ORDER BY name ASC';
            
        const files = await db.all(filesQuery, parentId ? [parentId, userId] : [userId]);

        res.json({ currentFolder: sanitizeFolder(currentFolder), folders, files, breadcrumbs, isLocked: false });
    } catch (error) {
        console.error('Get folders error:', error);
        res.status(500).json({ error: 'Failed to retrieve folders' });
    }
});

/**
 * GET /tree
 * Returns nested folder tree scoped to user
 */
router.get('/tree', async (req, res) => {
    try {
        const userId = req.user.id;
        const rawFolders = await db.all('SELECT * FROM folders WHERE user_id = ? ORDER BY name ASC', [userId]);
        const folders = (rawFolders || []).map(sanitizeFolder);
        
        const folderMap = new Map();
        folders.forEach(f => folderMap.set(f.id, { ...f, children: [] }));
        
        const tree = [];
        folderMap.forEach(folder => {
            if (folder.parent_id) {
                const parent = folderMap.get(folder.parent_id);
                if (parent) parent.children.push(folder);
            } else {
                tree.push(folder);
            }
        });

        res.json(tree);
    } catch (error) {
        console.error('Tree error:', error);
        res.status(500).json({ error: 'Failed to generate folder tree' });
    }
});

/**
 * POST /:id/lock
 * Sets a password to lock this folder
 */
router.post('/:id/lock', async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const { password } = req.body;
        if (!password || password.trim().length < 3) {
            return res.status(400).json({ error: 'Folder password must be at least 3 characters long' });
        }

        const folder = await db.getFolder(folderId, userId);
        if (!folder) return res.status(404).json({ error: 'Folder not found' });

        const hash = await bcrypt.hash(password.trim(), 10);
        await db.lockFolder(folderId, hash);

        res.json({ success: true, message: 'Folder locked successfully' });
    } catch (error) {
        console.error('Lock folder error:', error);
        res.status(500).json({ error: 'Failed to lock folder' });
    }
});

/**
 * POST /:id/verify-lock
 * Verifies folder password for access
 */
router.post('/:id/verify-lock', async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const folder = await db.getFolder(folderId, userId);
        if (!folder) return res.status(404).json({ error: 'Folder not found' });

        if (!folder.password_hash) {
            return res.json({ success: true, folderToken: generateFolderToken(folderId), message: 'Folder is not locked' });
        }

        const isMatch = await bcrypt.compare(password, folder.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Incorrect folder password' });
        }

        const folderToken = generateFolderToken(folderId);
        res.json({ success: true, folderToken, message: 'Folder unlocked successfully' });
    } catch (error) {
        console.error('Verify folder lock error:', error);
        res.status(500).json({ error: 'Failed to verify folder password' });
    }
});

/**
 * POST /:id/unlock-permanently
 * Removes folder password lock permanently
 */
router.post('/:id/unlock-permanently', async (req, res) => {
    try {
        const folderId = req.params.id;
        const userId = req.user.id;
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Current password is required to remove lock' });
        }

        const folder = await db.getFolder(folderId, userId);
        if (!folder) return res.status(404).json({ error: 'Folder not found' });

        if (folder.password_hash) {
            const isMatch = await bcrypt.compare(password, folder.password_hash);
            if (!isMatch) {
                return res.status(401).json({ error: 'Incorrect password' });
            }
        }

        await db.unlockFolderPermanently(folderId);
        res.json({ success: true, message: 'Folder lock removed permanently' });
    } catch (error) {
        console.error('Unlock permanently error:', error);
        res.status(500).json({ error: 'Failed to remove folder lock' });
    }
});

/**
 * POST /
 */
router.post('/', async (req, res) => {
    try {
        const userId = req.user.id;
        const { name, parentId } = req.body;
        if (!name) return res.status(400).json({ error: 'Folder name is required' });

        const targetParentId = parentId && parentId !== 'null' ? parentId : null;
        const folderName = name.trim();

        // If parent folder is specified, verify ownership
        if (targetParentId) {
            const parentFolder = await db.getFolder(targetParentId, userId);
            if (!parentFolder) return res.status(404).json({ error: 'Parent folder not found' });
        }

        // If folder with same name already exists in target parent for this user, reuse it
        const query = targetParentId
            ? 'SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?'
            : 'SELECT * FROM folders WHERE name = ? AND parent_id IS NULL AND user_id = ?';
        const params = targetParentId ? [folderName, targetParentId, userId] : [folderName, userId];
        const existing = await db.get(query, params);
        if (existing) {
            return res.json(existing);
        }

        const folder = {
            id: crypto.randomUUID(),
            user_id: userId,
            name: folderName,
            parent_id: targetParentId,
            created_at: new Date().toISOString()
        };

        await db.run(
            'INSERT INTO folders (id, user_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)',
            [folder.id, folder.user_id, folder.name, folder.parent_id, folder.created_at]
        );

        const eventBroadcaster = require('../services/eventBroadcaster');
        eventBroadcaster.broadcast('folder_created', { folder, parentId: folder.parent_id });

        res.json(folder);
    } catch (error) {
        console.error('Create folder error:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

/**
 * PATCH /:id
 */
router.patch('/:id', async (req, res) => {
    try {
        const userId = req.user.id;
        const folderId = req.params.id;
        const { name, parent_id } = req.body;

        // Prevent moving folder into itself
        if (parent_id === folderId) {
            return res.status(400).json({ error: 'Cannot move folder into itself' });
        }

        const existingFolder = await db.getFolder(folderId, userId);
        if (!existingFolder) return res.status(404).json({ error: 'Folder not found' });

        if (parent_id) {
            const targetParent = await db.getFolder(parent_id, userId);
            if (!targetParent) return res.status(404).json({ error: 'Target parent folder not found' });
        }

        const updates = [];
        const params = [];

        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name.trim());
        }
        if (parent_id !== undefined) {
            updates.push('parent_id = ?');
            params.push(parent_id);
        }

        if (updates.length > 0) {
            params.push(folderId, userId);
            await db.run(`UPDATE folders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
        }

        const updatedFolder = await db.getFolder(folderId, userId);
        const eventBroadcaster = require('../services/eventBroadcaster');
        eventBroadcaster.broadcast('folder_updated', { folder: sanitizeFolder(updatedFolder) });

        res.json(updatedFolder);
    } catch (error) {
        console.error('Update folder error:', error);
        res.status(500).json({ error: 'Failed to update folder' });
    }
});

/**
 * DELETE /:id
 */
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.user.id;
        const folderId = req.params.id;
        const existing = await db.getFolder(folderId, userId);
        if (!existing) return res.status(404).json({ error: 'Folder not found' });

        const isPermanent = req.query.permanent === 'true';
        const result = isPermanent ?
            await permanentlyDeleteFolderRecursive(folderId, userId) :
            await deleteFolderRecursive(folderId, userId);

        const eventBroadcaster = require('../services/eventBroadcaster');
        eventBroadcaster.broadcast('folder_deleted', { folderId });
        
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Delete folder error:', error);
        res.status(500).json({ error: error.message || 'Failed to delete folder' });
    }
});

router.deleteFolderRecursive = deleteFolderRecursive;
router.permanentlyDeleteFolderRecursive = permanentlyDeleteFolderRecursive;
router.generateFolderToken = generateFolderToken;
router.verifyFolderToken = verifyFolderToken;
module.exports = router;
