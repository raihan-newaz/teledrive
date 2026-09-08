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
 * @returns {Promise<Array>} Array of {id, name}
 */
async function getBreadcrumbs(folderId) {
    const breadcrumbs = [];
    let currentId = folderId;

    while (currentId) {
        const folder = await db.get('SELECT id, name, parent_id FROM folders WHERE id = ?', [currentId]);
        if (!folder) break;
        
        breadcrumbs.unshift({ id: folder.id, name: folder.name });
        currentId = folder.parent_id;
    }
    
    // Add root
    breadcrumbs.unshift({ id: null, name: 'My Drive' });
    return breadcrumbs;
}

/**
 * Recursive delete helper — safely moves files to Trash instead of hard deleting from Telegram
 * @param {string} folderId 
 * @returns {Promise<Object>} Object with counts
 */
async function deleteFolderRecursive(folderId) {
    let deletedFiles = 0;
    let deletedFolders = 0;

    const now = new Date().toISOString();

    // Move files in this folder to Trash (keeps files safe on Telegram)
    const files = await db.all('SELECT id FROM files WHERE folder_id = ?', [folderId]);
    for (const file of files) {
        db.run('UPDATE files SET is_trashed = 1, trashed_at = ?, folder_id = NULL WHERE id = ?', [now, file.id]);
        deletedFiles++;
    }

    // Recursively process subfolders
    const subfolders = await db.all('SELECT id FROM folders WHERE parent_id = ?', [folderId]);
    for (const sub of subfolders) {
        const res = await deleteFolderRecursive(sub.id);
        deletedFiles += res.deletedFiles;
        deletedFolders += res.deletedFolders;
    }

    // Delete the empty folder metadata
    await db.run('DELETE FROM folders WHERE id = ?', [folderId]);
    deletedFolders++;

    return { deletedFiles, deletedFolders };
}

/**
 * GET /
 */
router.get('/', async (req, res) => {
    try {
        const parentId = req.query.parentId && req.query.parentId !== 'null' ? req.query.parentId : null;
        
        const foldersQuery = parentId ? 
            'SELECT * FROM folders WHERE parent_id = ?' : 
            'SELECT * FROM folders WHERE parent_id IS NULL';
        
        const folders = await db.all(foldersQuery, parentId ? [parentId] : []);
        
        const filesQuery = parentId ? 
            'SELECT * FROM files WHERE folder_id = ? AND is_trashed = 0' : 
            'SELECT * FROM files WHERE folder_id IS NULL AND is_trashed = 0';
            
        const files = await db.all(filesQuery, parentId ? [parentId] : []);
        const breadcrumbs = await getBreadcrumbs(parentId);

        res.json({ folders, files, breadcrumbs });
    } catch (error) {
        console.error('Get folders error:', error);
        res.status(500).json({ error: 'Failed to retrieve folders' });
    }
});

/**
 * GET /tree
 * Returns nested folder tree
 */
router.get('/tree', async (req, res) => {
    try {
        const folders = await db.all('SELECT * FROM folders');
        
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
 * POST /
 */
router.post('/', async (req, res) => {
    try {
        const { name, parentId } = req.body;
        if (!name) return res.status(400).json({ error: 'Folder name is required' });

        const folder = {
            id: crypto.randomUUID(),
            name,
            parent_id: parentId || null,
            created_at: new Date().toISOString()
        };

        await db.run(
            'INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)',
            [folder.id, folder.name, folder.parent_id, folder.created_at]
        );

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
        const { name, parent_id } = req.body;
        const folderId = req.params.id;

        // Prevent moving folder into itself
        if (parent_id === folderId) {
            return res.status(400).json({ error: 'Cannot move folder into itself' });
        }

        const updates = [];
        const params = [];

        if (name !== undefined) {
            updates.push('name = ?');
            params.push(name);
        }
        if (parent_id !== undefined) {
            updates.push('parent_id = ?');
            params.push(parent_id);
        }

        if (updates.length > 0) {
            params.push(folderId);
            await db.run(`UPDATE folders SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        const updatedFolder = await db.get('SELECT * FROM folders WHERE id = ?', [folderId]);
        if (!updatedFolder) return res.status(404).json({ error: 'Folder not found' });

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
        const folderId = req.params.id;
        const result = await deleteFolderRecursive(folderId);
        
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Delete folder error:', error);
        res.status(500).json({ error: 'Failed to delete folder' });
    }
});

module.exports = router;
