const express = require('express');
const crypto = require('crypto');
const authMiddleware = require('../middleware/auth');
const remoteDownloader = require('../services/remoteDownloader');
const gdriveCrawler = require('../services/gdriveCrawler');
const eventBroadcaster = require('../services/eventBroadcaster');
const db = require('../db');

const router = express.Router();
router.use(authMiddleware);

/**
 * Helper to get or create a TeleDrive folder for a user
 */
function getOrCreateFolder(name, parentId, userId) {
  const folderName = (name || 'New Folder').trim();
  const targetParentId = (parentId && parentId !== 'null' && parentId !== 'undefined' && String(parentId).trim() !== '') ? String(parentId).trim() : null;

  const query = targetParentId
    ? 'SELECT * FROM folders WHERE name = ? AND parent_id = ? AND user_id = ?'
    : 'SELECT * FROM folders WHERE name = ? AND (parent_id IS NULL OR parent_id = "" OR parent_id = "null") AND user_id = ?';
  const params = targetParentId ? [folderName, targetParentId, userId] : [folderName, userId];

  let existing = db.get(query, params);
  if (existing) {
    return existing.id;
  }

  const newFolder = {
    id: crypto.randomUUID(),
    user_id: userId,
    name: folderName,
    parent_id: targetParentId,
    created_at: new Date().toISOString()
  };

  db.run(
    'INSERT INTO folders (id, user_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [newFolder.id, newFolder.user_id, newFolder.name, newFolder.parent_id, newFolder.created_at]
  );

  try {
    eventBroadcaster.broadcast('folder_created', { folder: newFolder, parentId: newFolder.parent_id, userId }, userId);
  } catch (e) {}

  return newFolder.id;
}

/**
 * POST /start or POST / — Start Remote Download Job
 */
const handleStartJob = async (req, res) => {
  try {
    const { url, fileName, filename, folderId, chunkSize, chunk_size } = req.body;
    const targetUrl = (url || req.body.link || '').trim();

    if (!targetUrl || typeof targetUrl !== 'string') {
      return res.status(400).json({ error: 'Direct download URL or Google Drive link is required' });
    }

    const userId = req.user.id;
    const userKey = req.user.encryptionKey;
    const resolvedName = (fileName || filename || '').trim();
    const parsedChunkSize = parseInt(chunkSize || chunk_size, 10);
    const effectiveChunkSize = (!isNaN(parsedChunkSize) && parsedChunkSize > 0) ? parsedChunkSize : null;
    const targetParentFolderId = (folderId && folderId !== 'null' && folderId !== 'undefined' && String(folderId).trim() !== '') ? String(folderId).trim() : null;

    // Check if it is a Google Drive link
    const gdriveInfo = gdriveCrawler.parseUrl(targetUrl);

    // CASE 1: Google Drive Folder Link -> Crawl & Queue all files
    if (gdriveInfo && gdriveInfo.type === 'folder') {
      console.log(`[RemoteUpload] Crawling Google Drive public folder: ${gdriveInfo.id}`);
      const folderTree = await gdriveCrawler.crawlFolder(gdriveInfo.id);

      // Create root folder in TeleDrive
      const rootFolderName = resolvedName || folderTree.name || 'Google Drive Import';
      const teleDriveRootFolderId = getOrCreateFolder(rootFolderName, targetParentFolderId, userId);

      const queuedJobs = [];

      // Helper to recursively process folder tree and create TeleDrive folders & file jobs
      const processNode = async (node, parentTdFolderId) => {
        // Queue files in this folder
        for (const file of node.files) {
          const job = await remoteDownloader.createJob({
            userId,
            userKey,
            url: file.downloadUrl,
            customFileName: file.name,
            folderId: parentTdFolderId,
            chunkSize: effectiveChunkSize
          });
          queuedJobs.push(job);
        }

        // Process subfolders
        for (const sub of (node.subfolders || [])) {
          const subTdFolderId = getOrCreateFolder(sub.name, parentTdFolderId, userId);
          await processNode(sub, subTdFolderId);
        }
      };

      await processNode(folderTree, teleDriveRootFolderId);

      if (queuedJobs.length === 0) {
        return res.status(400).json({
          error: 'No downloadable files were found in this Google Drive folder. Please ensure the folder is shared with "Anyone with the link".'
        });
      }

      return res.json({
        success: true,
        isFolder: true,
        folderName: rootFolderName,
        folderId: teleDriveRootFolderId,
        totalFiles: queuedJobs.length,
        message: `Discovered folder "${rootFolderName}" with ${queuedJobs.length} files. Queued for cloud download!`,
        jobs: queuedJobs,
        task: {
          taskId: queuedJobs[0].id,
          fileName: `${rootFolderName} (${queuedJobs.length} files)`,
          status: 'queued'
        }
      });
    }

    // CASE 2: Single File (Direct URL or Google Drive single file)
    const job = await remoteDownloader.createJob({
      userId,
      userKey,
      url: targetUrl,
      customFileName: resolvedName,
      folderId: targetParentFolderId,
      chunkSize: effectiveChunkSize
    });

    res.json({
      success: true,
      message: 'Remote download queued',
      job,
      task: {
        taskId: job.id,
        fileName: job.filename,
        status: job.status
      }
    });
  } catch (error) {
    console.error('Remote download error:', error);
    res.status(400).json({ error: error.message || 'Failed to start remote download' });
  }
};

router.post('/start', handleStartJob);
router.post('/', handleStartJob);

/**
 * GET /tasks or GET / — List Remote Download Jobs for authenticated user
 */
const handleListJobs = (req, res) => {
  try {
    const jobs = db.getUserRemoteJobs(req.user.id, 50);
    res.json({
      success: true,
      jobs,
      tasks: jobs.map(j => ({
        id: j.id,
        fileName: j.filename,
        url: j.url,
        status: j.status,
        downloadedBytes: j.downloaded_bytes,
        totalBytes: j.total_size,
        progress: j.progress,
        error: j.error_message,
        createdAt: j.created_at
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

router.get('/tasks', handleListJobs);
router.get('/', handleListJobs);

/**
 * GET /:id — Get single job detail (Strict user ownership check)
 */
router.get('/:id', (req, res) => {
  try {
    const job = db.getRemoteJob(req.params.id, req.user.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ success: true, job });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /cancel or POST /:id/cancel — Cancel an active/queued job
 */
const handleCancelJob = (req, res) => {
  try {
    const jobId = req.params.id || req.body.taskId || req.body.jobId;
    if (!jobId) {
      return res.status(400).json({ error: 'Job ID is required' });
    }

    const cancelled = remoteDownloader.cancelJob(jobId, req.user.id);
    if (!cancelled) {
      return res.status(404).json({ error: 'Job not found or cannot be cancelled' });
    }

    res.json({ success: true, message: 'Remote download cancelled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

router.post('/cancel', handleCancelJob);
router.post('/:id/cancel', handleCancelJob);

module.exports = router;
