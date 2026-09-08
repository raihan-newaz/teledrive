const jwt = require('jsonwebtoken');

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

    // Verify token using JWT_SECRET
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

module.exports = authMiddleware;
