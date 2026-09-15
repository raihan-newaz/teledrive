const jwt = require('jsonwebtoken');
const db = require('../db');
const cryptoModule = require('../crypto');

/**
 * JWT Authentication Middleware
 * Supports:
 * 1. Authorization: Bearer <token> header
 * 2. httpOnly cookie named 'teledrive_token'
 * 3. URL query parameter ?token=<token> (for <video>, <img>, <iframe>, downloads)
 */
const authMiddleware = (req, res, next) => {
  try {
    let token = null;

    // 1. Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    // 2. Check query parameter (crucial for streaming media & downloads)
    if (!token && req.query && req.query.token) {
      token = req.query.token;
    }

    // 3. Fallback to cookie
    if (!token && req.cookies && req.cookies.teledrive_token) {
      token = req.cookies.teledrive_token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    // Explicitly verify token using JWT_SECRET and whitelist HS256 algorithm
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    
    // Fetch user from database
    let user = null;
    if (decoded.id) {
      user = db.getUserById(decoded.id);
    } else {
      // Legacy token compatibility: find first admin or first user
      user = db.getUserByEmail('admin@teledrive.local') || db.getAllUsers().find(u => u.role === 'admin') || db.getAllUsers()[0];
    }

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: User account not found' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Forbidden: This account has been suspended by the administrator.' });
    }

    // Unwrap the user's specific AES-256 encryption key using server master key
    const masterKey = process.env.ENCRYPTION_KEY || 'default-encryption-key';
    let userKey = masterKey;
    if (user.encryption_key) {
      try {
        userKey = cryptoModule.unwrapUserKey(user.encryption_key, masterKey);
      } catch (e) {
        userKey = masterKey;
      }
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      storageLimit: user.storage_limit || 0,
      storageUsed: user.storage_used || 0,
      encryptionKey: userKey,
      tokenExp: decoded.exp
    };

    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

/**
 * Middleware to restrict route access strictly to admins
 */
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Administrator privileges required.' });
  }
  next();
};

module.exports = authMiddleware;
module.exports.authMiddleware = authMiddleware;
module.exports.requireAdmin = requireAdmin;
