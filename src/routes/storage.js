const express = require('express');
const authMiddleware = require('../middleware/auth');
const db = require('../db');

const router = express.Router();
router.use(authMiddleware);

/**
 * GET /api/storage/stats
 * Returns authenticated user's storage quota, usage, breakdown, and warning level
 */
router.get('/stats', (req, res) => {
  try {
    const userId = req.user.id;
    const stats = db.getUserDetailedStorageStats(userId);
    if (!stats) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ success: true, stats });
  } catch (error) {
    console.error('[Storage API] Error fetching stats:', error);
    return res.status(500).json({ error: 'Failed to fetch storage statistics' });
  }
});

/**
 * GET /api/storage/breakdown
 * Returns category-based storage breakdown for authenticated user
 */
router.get('/breakdown', (req, res) => {
  try {
    const userId = req.user.id;
    const breakdown = db.getUserStorageBreakdown(userId);
    return res.json({ success: true, ...breakdown });
  } catch (error) {
    console.error('[Storage API] Error fetching breakdown:', error);
    return res.status(500).json({ error: 'Failed to fetch storage breakdown' });
  }
});

/**
 * GET /api/storage/largest
 * Returns top largest active files for authenticated user
 */
router.get('/largest', (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit, 10) || 10;
    const files = db.getUserLargestFiles(userId, limit);
    return res.json({ success: true, files });
  } catch (error) {
    console.error('[Storage API] Error fetching largest files:', error);
    return res.status(500).json({ error: 'Failed to fetch largest files' });
  }
});

/**
 * GET /api/storage/recent
 * Returns recent storage activities for authenticated user
 */
router.get('/recent', (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit, 10) || 10;
    const activities = db.getUserRecentStorageActivity(userId, limit);
    return res.json({ success: true, activities });
  } catch (error) {
    console.error('[Storage API] Error fetching recent activity:', error);
    return res.status(500).json({ error: 'Failed to fetch storage activity' });
  }
});

module.exports = router;
