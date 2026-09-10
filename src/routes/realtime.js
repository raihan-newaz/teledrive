const express = require('express');
const authMiddleware = require('../middleware/auth');
const eventBroadcaster = require('../services/eventBroadcaster');

const router = express.Router();
router.use(authMiddleware);

/**
 * GET /api/realtime/events
 * Server-Sent Events (SSE) stream for live folder/file synchronization across devices
 */
router.get('/events', (req, res) => {
  eventBroadcaster.addClient(res, req);
});

/**
 * GET /api/realtime/status
 * Get real-time connection stats
 */
router.get('/status', (req, res) => {
  res.json({
    activeListeners: eventBroadcaster.getConnectionCount(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
