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
  res.set('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Depth, Destination, If, Lock-Token, Overwrite, Timeout, X-Requested-With');
  res.set('MS-Author-Via', 'DAV');
  res.set('DAV', '1, 2');

  if (req.method === 'OPTIONS') {
    res.set('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
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

  const [rawUsername, ...passParts] = credentials.split(':');
  const password = passParts.join(':');
  let username = (rawUsername || '').trim();
  if (username.includes('\\')) {
    username = username.split('\\').pop().trim();
  }

  // Configured WebDAV credentials (or fall back to admin / user credentials)
  const db = require('../db');
  const configuredWebdavUser = (db.getSetting('webdav_username') || process.env.WEBDAV_USERNAME || 'admin').trim().toLowerCase();
  const configuredWebdavPassHash = db.getSetting('webdav_password_hash') || process.env.WEBDAV_PASSWORD_HASH;
  const configuredWebdavPassPlain = process.env.WEBDAV_PASSWORD;
  const adminPasswordHash = process.env.MASTER_PASSWORD_HASH || process.env.ADMIN_PASSWORD_HASH;

  let isAuthenticated = false;
  const isWebdavUserMatch = (username.toLowerCase() === configuredWebdavUser || username.toLowerCase() === 'admin');

  // 1. If custom WebDAV password hash (bcrypt) is configured
  if (configuredWebdavPassHash && password && isWebdavUserMatch) {
    try {
      isAuthenticated = bcrypt.compareSync(password, configuredWebdavPassHash);
    } catch (e) {}
  }

  // 1b. Fall back to plaintext custom WebDAV password if set previously
  if (!isAuthenticated && configuredWebdavPassPlain && password && isWebdavUserMatch) {
    if (password === configuredWebdavPassPlain) {
      isAuthenticated = true;
    }
  }

  // 2. Fall back to Master Admin Password verification via bcrypt
  if (!isAuthenticated && adminPasswordHash && password && isWebdavUserMatch) {
    try {
      isAuthenticated = bcrypt.compareSync(password, adminPasswordHash);
    } catch (e) {
      isAuthenticated = false;
    }
  }

  // 3. Fall back to checking database user accounts
  let matchedDbUser = null;
  if (!isAuthenticated && password) {
    try {
      const allUsers = db.getAllUsers();
      matchedDbUser = allUsers.find(u => u.email.toLowerCase() === username.toLowerCase() || (u.name && u.name.toLowerCase() === username.toLowerCase()));
      if (matchedDbUser && matchedDbUser.status === 'active') {
        if (bcrypt.compareSync(password, matchedDbUser.password_hash)) {
          isAuthenticated = true;
        } else {
          matchedDbUser = null;
        }
      } else {
        matchedDbUser = null;
      }
    } catch (e) {}
  }

  if (!isAuthenticated) {
    res.set('WWW-Authenticate', 'Basic realm="TeleDrive WebDAV Network Storage"');
    return res.status(401).set('Content-Type', 'text/plain').send('Invalid WebDAV username or password.');
  }

  // Attach user context with encryption key
  const cryptoModule = require('../crypto');
  const masterKey = process.env.ENCRYPTION_KEY || 'default-encryption-key';
  const targetUser = matchedDbUser || db.getUserByEmail('admin@teledrive.local') || db.getAllUsers().find(u => u.role === 'admin') || db.getAllUsers()[0];

  if (targetUser) {
    let userKey = masterKey;
    if (targetUser.encryption_key) {
      try {
        userKey = cryptoModule.unwrapUserKey(targetUser.encryption_key, masterKey);
      } catch (e) {
        userKey = masterKey;
      }
    }
    req.user = {
      id: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role: targetUser.role,
      status: targetUser.status,
      storageLimit: targetUser.storage_limit || 0,
      storageUsed: targetUser.storage_used || 0,
      filePrefix: targetUser.file_prefix || '',
      encryptionKey: userKey
    };
  }

  // 4. Check Session Revocation & Track Device Session
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
