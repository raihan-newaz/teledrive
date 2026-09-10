const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

/**
 * WebDAV Authentication and Permission Enforcement Middleware
 */
function webdavAuthMiddleware(req, res, next) {
  // 1. Check if WebDAV is globally enabled
  const webdavEnabled = process.env.WEBDAV_ENABLED !== 'false';
  if (!webdavEnabled) {
    return res.status(503).set('Content-Type', 'text/plain').send('WebDAV Service is currently disabled in TeleDrive settings.');
  }

  // Handle CORS & Preflight
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Depth, Destination, If, Lock-Token, Overwrite, Timeout, X-Requested-With');
  res.set('MS-Author-Via', 'DAV');
  res.set('DAV', '1, 2');

  if (req.method === 'OPTIONS') {
    res.set('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, TRACE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
    return res.status(200).end();
  }

  // 2. Parse HTTP Basic Authentication header
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="TeleDrive WebDAV Network Storage"');
    return res.status(401).set('Content-Type', 'text/plain').send('Authentication required for TeleDrive WebDAV Network Storage.');
  }

  const base64Credentials = authHeader.substring(6);
  let credentials = '';
  try {
    credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
  } catch (e) {
    res.set('WWW-Authenticate', 'Basic realm="TeleDrive WebDAV Network Storage"');
    return res.status(401).set('Content-Type', 'text/plain').send('Invalid authorization header encoding.');
  }

  const [username, ...passParts] = credentials.split(':');
  const password = passParts.join(':');

  // Configured WebDAV credentials (or fall back to admin credentials)
  const configuredWebdavUser = process.env.WEBDAV_USERNAME || 'admin';
  const configuredWebdavPass = process.env.WEBDAV_PASSWORD;
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;

  let isAuthenticated = false;

  // If custom WebDAV password is set in .env
  if (configuredWebdavPass) {
    isAuthenticated = (username === configuredWebdavUser && password === configuredWebdavPass);
  } else if (adminPasswordHash) {
    // Fall back to Master Admin Password verification via bcrypt
    const isUserMatch = (username === configuredWebdavUser || username === 'admin');
    if (isUserMatch && password) {
      try {
        isAuthenticated = bcrypt.compareSync(password, adminPasswordHash);
      } catch (e) {
        isAuthenticated = false;
      }
    }
  }

  if (!isAuthenticated) {
    res.set('WWW-Authenticate', 'Basic realm="TeleDrive WebDAV Network Storage"');
    return res.status(401).set('Content-Type', 'text/plain').send('Invalid WebDAV username or password.');
  }

  // 3. Check Session Revocation & Track Device Session
  const sessionTracker = require('../services/sessionTracker');
  const clientIp = sessionTracker.getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'Generic-WebDAV';

  if (sessionTracker.isRevoked(clientIp, userAgent, username)) {
    return res.status(403).set('Content-Type', 'text/plain').send('Forbidden: This device session has been disconnected from TeleDrive Settings.');
  }

  sessionTracker.trackWebDavRequest(req, username);

  // 4. Enforce WebDAV Permission Modes (full, readonly, safemode)
  const mode = process.env.WEBDAV_PERMISSION_MODE || 'full';
  const method = req.method.toUpperCase();

  req.webdavMode = mode;
  req.webdavUser = username;

  if (mode === 'readonly') {
    const readMethods = ['GET', 'HEAD', 'PROPFIND', 'OPTIONS'];
    if (!readMethods.includes(method)) {
      return res.status(403).set('Content-Type', 'text/plain').send('Forbidden: WebDAV is currently set to Read-Only mode.');
    }
  } else if (mode === 'safemode') {
    // Safe Mode allows Reading and Uploading, but blocks Delete and Overwrites
    const blockedMethods = ['DELETE'];
    if (blockedMethods.includes(method)) {
      return res.status(403).set('Content-Type', 'text/plain').send('Forbidden: Deletion is disabled under WebDAV Safe Mode.');
    }
  }

  next();
}

module.exports = webdavAuthMiddleware;
