const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

const dataEnv = path.join(__dirname, '../data/.env');
const rootEnv = path.join(__dirname, '../.env');
if (fs.existsSync(dataEnv)) dotenv.config({ path: dataEnv });
if (fs.existsSync(rootEnv)) {
  try {
    if (!fs.statSync(rootEnv).isDirectory()) dotenv.config({ path: rootEnv });
  } catch (e) {}
}
const crypto = require('crypto');

const config = {
  apiId: process.env.API_ID,
  apiHash: process.env.API_HASH,
  botToken: process.env.BOT_TOKEN,
  channelId: process.env.CHANNEL_ID,
  masterPasswordHash: process.env.MASTER_PASSWORD_HASH,
  encryptionKey: process.env.ENCRYPTION_KEY,
  jwtSecret: process.env.JWT_SECRET,
  port: process.env.PORT || 3000,
  sessionString: process.env.SESSION_STRING
};

/**
 * Checks if the required environment variables for setup are complete
 * @returns {boolean} True if setup is complete
 */
function isSetupComplete() {
  return !!(
    process.env.API_ID &&
    process.env.API_HASH &&
    process.env.BOT_TOKEN &&
    process.env.CHANNEL_ID &&
    process.env.MASTER_PASSWORD_HASH &&
    process.env.ENCRYPTION_KEY &&
    process.env.JWT_SECRET
  );
}

/**
 * Derives a cryptographic key from a passphrase and salt using PBKDF2
 * @param {string} passphrase The password to derive from
 * @param {string|Buffer} salt The salt to use
 * @returns {Buffer} The derived 32-byte key
 */
function deriveKey(passphrase, salt) {
  const saltBuffer = typeof salt === 'string' ? Buffer.from(salt, 'base64') : salt;
  return crypto.pbkdf2Sync(passphrase, saltBuffer, 310000, 32, 'sha512');
}

module.exports = {
  config,
  isSetupComplete,
  deriveKey
};
