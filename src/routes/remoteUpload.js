const express = require('express');
const authMiddleware = require('../middleware/auth');
const remoteDownloader = require('../services/remoteDownloader');

const router = express.Router();
router.use(authMiddleware);

/**
 * POST /api/remote-upload/start
 * Initiates a server-side remote URL download and Telegram cloud upload
 */
router.post('/start', async (req, res) => {
  try {
    const { url, fileName, folderId } = req.body;

    if (!url || typeof url !== 'string' || !url.trim()) {
      return res.status(400).json({ error: 'Direct download URL is required' });
    }

    const trimmedUrl = url.trim();
    const userId = req.user.id;
    const userKey = req.user.encryptionKey;

    const result = await remoteDownloader.startDownload({
      userId,
      userKey,
      url: trimmedUrl,
      customFileName: fileName,
      folderId: folderId || null
    });

    res.json({
      success: true,
      message: 'Remote download started',
      task: result
    });
  } catch (error) {
    console.error('Remote upload start error:', error);
    res.status(400).json({ error: error.message || 'Failed to start remote download' });
  }
});

/**
 * GET /api/remote-upload/tasks
 * Returns active and recent remote download tasks for current user
 */
router.get('/tasks', (req, res) => {
  try {
    const tasks = remoteDownloader.getUserTasks(req.user.id);
    res.json({ success: true, tasks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/remote-upload/cancel
 * Cancels an active remote download task
 */
router.post('/cancel', (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    const cancelled = remoteDownloader.cancelDownload(taskId, req.user.id);
    if (!cancelled) {
      return res.status(404).json({ error: 'Task not found or already completed' });
    }

    res.json({ success: true, message: 'Remote download cancelled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
