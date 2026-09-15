const express = require('express');
const authMiddleware = require('../middleware/auth');
const remoteDownloader = require('../services/remoteDownloader');
const db = require('../db');

const router = express.Router();
router.use(authMiddleware);

/**
 * POST /start or POST / — Start Remote Download Job
 */
const handleStartJob = async (req, res) => {
  try {
    const { url, fileName, filename, folderId } = req.body;
    const targetUrl = url || req.body.link;

    if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
      return res.status(400).json({ error: 'Direct download URL is required' });
    }

    const userId = req.user.id;
    const userKey = req.user.encryptionKey;
    const resolvedName = (fileName || filename || '').trim();

    const job = await remoteDownloader.createJob({
      userId,
      userKey,
      url: targetUrl.trim(),
      customFileName: resolvedName,
      folderId: folderId || null
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
