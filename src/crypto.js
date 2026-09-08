const crypto = require('crypto');
const fs = require('fs');

/**
 * Generates a random 16-byte salt
 * @returns {string} Salt as base64 string
 */
function generateSalt() {
  return crypto.randomBytes(16).toString('base64');
}

/**
 * Generates a random 12-byte initialization vector (IV) for AES-GCM
 * @returns {string} IV as base64 string
 */
function generateIV() {
  return crypto.randomBytes(12).toString('base64');
}

/**
 * Derives a 32-byte key from passphrase and salt using PBKDF2
 * @param {string} passphrase - The encryption passphrase
 * @param {string} saltBase64 - The salt as a base64 string
 * @returns {Buffer} 32-byte derived key
 */
function deriveKey(passphrase, saltBase64) {
  const salt = Buffer.from(saltBase64, 'base64');
  return crypto.pbkdf2Sync(passphrase, salt, 310000, 32, 'sha512');
}

/**
 * Encrypts a file using AES-256-GCM
 * @param {string} inputPath - Path to the file to encrypt
 * @param {string} outputPath - Path to write the encrypted file
 * @param {string} passphrase - Encryption passphrase
 * @returns {Promise<Object>} Resolves with { iv, salt, authTag } as base64
 */
function encryptFile(inputPath, outputPath, passphrase) {
  return new Promise((resolve, reject) => {
    const salt = generateSalt();
    const iv = generateIV();
    
    const key = deriveKey(passphrase, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    
    const readStream = fs.createReadStream(inputPath);
    const writeStream = fs.createWriteStream(outputPath);
    
    readStream.on('error', reject);
    writeStream.on('error', reject);
    cipher.on('error', reject);
    
    readStream.pipe(cipher).pipe(writeStream, { end: false });
    
    cipher.on('end', () => {
      const authTag = cipher.getAuthTag();
      writeStream.end(authTag, () => {
        resolve({
          iv,
          salt,
          authTag: authTag.toString('base64')
        });
      });
    });
  });
}

/**
 * Decrypts a file using AES-256-GCM
 * @param {string} inputPath - Path to the encrypted file
 * @param {string} outputPath - Path to write the decrypted file
 * @param {string} passphrase - Encryption passphrase
 * @param {string} ivBase64 - Initialization vector as base64
 * @param {string} saltBase64 - Salt as base64
 * @returns {Promise<void>} Resolves when decryption is complete
 */
function decryptFile(inputPath, outputPath, passphrase, ivBase64, saltBase64) {
  return new Promise((resolve, reject) => {
    fs.stat(inputPath, (err, stats) => {
      if (err) return reject(err);
      
      const fileSize = stats.size;
      if (fileSize < 16) return reject(new Error('File is too small to contain an auth tag'));
      
      const encryptedDataSize = fileSize - 16;
      
      const authTagBuffer = Buffer.alloc(16);
      const fd = fs.openSync(inputPath, 'r');
      fs.readSync(fd, authTagBuffer, 0, 16, encryptedDataSize);
      fs.closeSync(fd);
      
      const key = deriveKey(passphrase, saltBase64);
      const iv = Buffer.from(ivBase64, 'base64');
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTagBuffer);
      
      const readStream = fs.createReadStream(inputPath, { end: encryptedDataSize - 1 });
      const writeStream = fs.createWriteStream(outputPath);
      
      readStream.on('error', reject);
      writeStream.on('error', reject);
      decipher.on('error', reject);
      
      readStream.pipe(decipher).pipe(writeStream);
      
      writeStream.on('finish', resolve);
    });
  });
}

/**
 * Encrypts a stream
 * @param {stream.Readable} readStream - The readable stream to encrypt
 * @param {string} passphrase - Encryption passphrase
 * @param {string} saltBase64 - Salt as base64
 * @param {string} ivBase64 - Initialization vector as base64
 * @returns {Object} { encryptedStream, authTagPromise }
 */
function encryptStream(readStream, passphrase, saltBase64, ivBase64) {
  const key = deriveKey(passphrase, saltBase64);
  const iv = Buffer.from(ivBase64, 'base64');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const authTagPromise = new Promise((resolve) => {
    cipher.on('end', () => {
      resolve(cipher.getAuthTag().toString('base64'));
    });
  });
  
  const encryptedStream = readStream.pipe(cipher);
  return { encryptedStream, authTagPromise };
}

/**
 * Decrypts a stream
 * @param {stream.Readable} readStream - The readable stream of encrypted data
 * @param {string} passphrase - Encryption passphrase
 * @param {string} saltBase64 - Salt as base64
 * @param {string} ivBase64 - Initialization vector as base64
 * @param {string} authTagBase64 - Authentication tag as base64
 * @returns {stream.Readable} The decrypted readable stream
 */
function decryptStream(readStream, passphrase, saltBase64, ivBase64, authTagBase64) {
  const key = deriveKey(passphrase, saltBase64);
  const iv = Buffer.from(ivBase64, 'base64');
  const authTag = Buffer.from(authTagBase64, 'base64');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  return readStream.pipe(decipher);
}

module.exports = {
  generateSalt,
  generateIV,
  deriveKey,
  encryptFile,
  decryptFile,
  encryptStream,
  decryptStream
};
