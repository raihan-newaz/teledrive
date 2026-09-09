const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const filesRouter = require('./files');

const router = express.Router();

/**
 * Helper to generate HMAC verification token for password-protected shared files
 */
const SECRET = process.env.JWT_SECRET || 'teledrive_share_secret_fallback';
function generateShareAccessToken(token) {
  return crypto.createHmac('sha256', SECRET).update(`access:${token}`).digest('hex');
}

function verifyShareAccessToken(token, accessKey) {
  if (!accessKey || typeof accessKey !== 'string') return false;
  const expected = generateShareAccessToken(token);
  const keyBuf = Buffer.from(accessKey);
  const expBuf = Buffer.from(expected);
  if (keyBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, expBuf);
}

// ══════════════════════════════════════════════════════════════════════════
// 1. PUBLIC ENDPOINTS (No Login Required)
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /public/:token — Retrieve shared file metadata
 */
router.get('/public/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const file = db.getFileByShareToken(token);

    if (!file) {
      return res.status(404).json({ error: 'File not found or sharing has been disabled by the owner.' });
    }

    if (file.share_expires_at) {
      const expires = new Date(file.share_expires_at);
      if (expires < new Date()) {
        return res.status(410).json({ error: 'This share link has expired.' });
      }
    }

    // Increment view count
    db.incrementShareViews(token);

    res.json({
      name: file.name,
      size: file.size,
      mime_type: file.mime_type,
      created_at: file.created_at,
      requiresPassword: Boolean(file.share_password),
      expiresAt: file.share_expires_at || null,
      views: (file.share_views || 0) + 1,
      downloads: file.share_downloads || 0
    });
  } catch (err) {
    console.error('[Share] Public meta error:', err);
    res.status(500).json({ error: 'Failed to retrieve shared file' });
  }
});

/**
 * POST /public/:token/verify — Verify password for protected shared file
 */
router.post('/public/:token/verify', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;
    const file = db.getFileByShareToken(token);

    if (!file) {
      return res.status(404).json({ error: 'File not found or link has expired' });
    }

    if (!file.share_password) {
      return res.json({ success: true, accessKey: generateShareAccessToken(token) });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const isValid = await bcrypt.compare(password, file.share_password);
    if (!isValid) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    const accessKey = generateShareAccessToken(token);
    res.json({
      success: true,
      accessKey,
      file: {
        name: file.name,
        size: file.size,
        mime_type: file.mime_type,
        created_at: file.created_at,
        requiresPassword: false,
        expiresAt: file.share_expires_at || null,
        views: file.share_views || 0,
        downloads: file.share_downloads || 0
      }
    });
  } catch (err) {
    console.error('[Share] Verify error:', err);
    res.status(500).json({ error: 'Failed to verify password' });
  }
});

/**
 * Helper to check password access for download and stream
 */
function checkPublicAccess(req, res, file) {
  if (!file.share_password) return true;

  const accessKey = req.query.key || req.headers['x-share-key'];
  if (accessKey && verifyShareAccessToken(file.share_token, accessKey)) {
    return true;
  }

  // Fallback: support ?pw=password directly in URL
  if (req.query.pw && bcrypt.compareSync(req.query.pw, file.share_password)) {
    return true;
  }

  return false;
}

/**
 * GET /public/:token/download — Download file decrypted from Telegram (Public)
 */
router.get('/public/:token/download', async (req, res) => {
  try {
    const { token } = req.params;
    const file = db.getFileByShareToken(token);

    if (!file) {
      return res.status(404).send('File not found or sharing has been disabled.');
    }

    if (file.share_expires_at && new Date(file.share_expires_at) < new Date()) {
      return res.status(410).send('This share link has expired.');
    }

    if (!checkPublicAccess(req, res, file)) {
      return res.status(403).send('Password required to download this file.');
    }

    // Increment download count
    db.incrementShareDownloads(token);

    // Stream file as attachment download
    await filesRouter.streamFileToResponse(file, req, res, true);
  } catch (err) {
    console.error('[Share] Public download error:', err);
    if (!res.headersSent) {
      res.status(500).send('Failed to download file');
    }
  }
});

/**
 * GET /public/:token/stream — Stream file decrypted from Telegram (Public)
 */
router.get('/public/:token/stream', async (req, res) => {
  try {
    const { token } = req.params;
    const file = db.getFileByShareToken(token);

    if (!file) {
      return res.status(404).send('File not found or sharing has been disabled.');
    }

    if (file.share_expires_at && new Date(file.share_expires_at) < new Date()) {
      return res.status(410).send('This share link has expired.');
    }

    if (!checkPublicAccess(req, res, file)) {
      return res.status(403).send('Password required to stream this file.');
    }

    // Stream file inline (supports Range requests)
    await filesRouter.streamFileToResponse(file, req, res, false);
  } catch (err) {
    console.error('[Share] Public stream error:', err);
    if (!res.headersSent) {
      res.status(500).send('Failed to stream file');
    }
  }
});


// ══════════════════════════════════════════════════════════════════════════
// 2. AUTHENTICATED MANAGEMENT ENDPOINTS (Require TeleDrive Login)
// ══════════════════════════════════════════════════════════════════════════

/**
 * GET /file/:fileId — Get current share status for a file
 */
router.get('/file/:fileId', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const file = db.getFile(fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    const host = req.get('host') || 'localhost';
    const protocol = req.protocol || 'http';
    const shareUrl = file.share_token ? `${protocol}://${host}/share/${file.share_token}` : null;

    res.json({
      fileId: file.id,
      id: file.id,
      fileName: file.name,
      name: file.name,
      fileSize: file.size,
      size: file.size,
      mimeType: file.mime_type,
      mime_type: file.mime_type,
      isShared: Boolean(file.is_shared),
      is_shared: Boolean(file.is_shared),
      shareToken: file.share_token || null,
      share_token: file.share_token || null,
      shareUrl,
      share_url: shareUrl,
      hasPassword: Boolean(file.share_password),
      has_password: Boolean(file.share_password),
      expiresAt: file.share_expires_at || null,
      share_expires_at: file.share_expires_at || null,
      views: file.share_views || 0,
      share_views: file.share_views || 0,
      downloads: file.share_downloads || 0,
      share_downloads: file.share_downloads || 0
    });
  } catch (err) {
    console.error('[Share] Get status error:', err);
    res.status(500).json({ error: 'Failed to retrieve share status' });
  }
});

/**
 * POST /file/:fileId — Update share settings (turn on/off, password, expiration)
 */
router.post('/file/:fileId', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const isShared = req.body.isShared !== undefined ? req.body.isShared : req.body.is_shared;
    const password = req.body.password;
    const expiresInDays = req.body.expiresInDays !== undefined ? req.body.expiresInDays : req.body.expires_in_days;
    const clearPassword = req.body.clearPassword || req.body.clear_password;
    const file = db.getFile(fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    let token = file.share_token;
    if (isShared && !token) {
      token = crypto.randomBytes(16).toString('hex');
    }

    let hashedPassword = file.share_password;
    if (clearPassword) {
      hashedPassword = null;
    } else if (password && password.trim()) {
      hashedPassword = await bcrypt.hash(password.trim(), 10);
    }

    let expiresAt = file.share_expires_at;
    if (expiresInDays !== undefined) {
      if (expiresInDays === null || expiresInDays <= 0) {
        expiresAt = null;
      } else {
        const d = new Date();
        d.setDate(d.getDate() + Number(expiresInDays));
        expiresAt = d.toISOString();
      }
    }

    const updated = db.updateFileShare(fileId, {
      isShared: Boolean(isShared),
      token,
      password: hashedPassword,
      expiresAt
    });

    const host = req.get('host') || 'localhost';
    const protocol = req.protocol || 'http';
    const shareUrl = token ? `${protocol}://${host}/share/${token}` : null;

    res.json({
      success: true,
      fileId: updated.id,
      id: updated.id,
      isShared: Boolean(updated.is_shared),
      is_shared: Boolean(updated.is_shared),
      shareToken: updated.share_token,
      share_token: updated.share_token,
      shareUrl,
      share_url: shareUrl,
      hasPassword: Boolean(updated.share_password),
      has_password: Boolean(updated.share_password),
      expiresAt: updated.share_expires_at,
      share_expires_at: updated.share_expires_at,
      views: updated.share_views || 0,
      share_views: updated.share_views || 0,
      downloads: updated.share_downloads || 0,
      share_downloads: updated.share_downloads || 0
    });
  } catch (err) {
    console.error('[Share] Update share error:', err);
    res.status(500).json({ error: 'Failed to update share settings' });
  }
});

/**
 * DELETE /file/:fileId — Revoke public share link immediately
 */
router.delete('/file/:fileId', authMiddleware, async (req, res) => {
  try {
    const { fileId } = req.params;
    const file = db.getFile(fileId);

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    db.revokeFileShare(fileId);
    res.json({ success: true, message: 'Public share link revoked successfully' });
  } catch (err) {
    console.error('[Share] Revoke share error:', err);
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
});

module.exports = router;
