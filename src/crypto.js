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

const BACKUP_MAGIC = Buffer.from('TELEBACK'); // 8 bytes identifier

/**
 * Encrypts a database snapshot file with self-contained metadata header (Magic + Salt + IV + Ciphertext + AuthTag)
 * @param {string} inputPath - Path to plain db file
 * @param {string} outputPath - Path to write .enc.db file
 * @param {string} passphrase - Encryption passphrase
 * @returns {Promise<Object>}
 */
function encryptBackupFile(inputPath, outputPath, passphrase) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(passphrase, salt, 310000, 32, 'sha512');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const readStream = fs.createReadStream(inputPath);
    const writeStream = fs.createWriteStream(outputPath);

    // Write header: MAGIC (8B) + SALT (16B) + IV (12B) = 36 bytes header
    writeStream.write(Buffer.concat([BACKUP_MAGIC, salt, iv]));

    readStream.on('error', reject);
    writeStream.on('error', reject);
    cipher.on('error', reject);

    readStream.pipe(cipher).pipe(writeStream, { end: false });

    cipher.on('end', () => {
      const authTag = cipher.getAuthTag();
      writeStream.end(authTag, () => {
        resolve({
          salt: salt.toString('base64'),
          iv: iv.toString('base64'),
          authTag: authTag.toString('base64')
        });
      });
    });
  });
}

/**
 * Decrypts a self-contained encrypted backup file
 * @param {string} inputPath - Path to .enc.db file
 * @param {string} outputPath - Path to write plain db file
 * @param {string} passphrase - Encryption passphrase
 * @returns {Promise<void>}
 */
function decryptBackupFile(inputPath, outputPath, passphrase) {
  return new Promise((resolve, reject) => {
    fs.stat(inputPath, (err, stats) => {
      if (err) return reject(err);
      const fileSize = stats.size;
      const HEADER_SIZE = 8 + 16 + 12; // 36 bytes
      const MIN_SIZE = HEADER_SIZE + 16; // 52 bytes

      if (fileSize < MIN_SIZE) {
        return reject(new Error('Invalid backup file: File is too small'));
      }

      let fd;
      try {
        fd = fs.openSync(inputPath, 'r');
        const headerBuf = Buffer.alloc(HEADER_SIZE);
        fs.readSync(fd, headerBuf, 0, HEADER_SIZE, 0);

        const magic = headerBuf.subarray(0, 8);
        if (!magic.equals(BACKUP_MAGIC)) {
          fs.closeSync(fd);
          return reject(new Error('Invalid backup format: Missing TELEBACK signature'));
        }

        const salt = headerBuf.subarray(8, 24); // 16 bytes
        const iv = headerBuf.subarray(24, 36);   // 12 bytes

        // Read authTag (last 16 bytes)
        const authTag = Buffer.alloc(16);
        fs.readSync(fd, authTag, 0, 16, fileSize - 16);
        fs.closeSync(fd);

        const encryptedDataSize = fileSize - HEADER_SIZE - 16;
        if (encryptedDataSize < 0) {
          return reject(new Error('Corrupt backup file: Invalid payload length'));
        }

        const key = crypto.pbkdf2Sync(passphrase, salt, 310000, 32, 'sha512');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        const readStream = fs.createReadStream(inputPath, {
          start: HEADER_SIZE,
          end: fileSize - 17
        });
        const writeStream = fs.createWriteStream(outputPath);

        readStream.on('error', reject);
        writeStream.on('error', reject);
        decipher.on('error', () => {
          reject(new Error('Decryption failed: Incorrect encryption key or corrupted backup file'));
        });

        readStream.pipe(decipher).pipe(writeStream);
        writeStream.on('finish', resolve);
      } catch (openErr) {
        if (fd) try { fs.closeSync(fd); } catch (e) {}
        reject(openErr);
      }
    });
  });
}

module.exports = {
  BACKUP_MAGIC,
  generateSalt,
  generateIV,
  deriveKey,
  encryptFile,
  decryptFile,
  encryptBackupFile,
  decryptBackupFile,
  encryptStream,
  decryptStream
};
