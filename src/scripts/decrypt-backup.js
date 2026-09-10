#!/usr/bin/env node

/**
 * TeleDrive Database Backup Decryptor CLI Tool
 * 
 * Usage:
 *   node src/scripts/decrypt-backup.js <path-to-backup.enc.db> [output.db] [encryption_key]
 *   npm run decrypt-backup <path-to-backup.enc.db> [output.db] [encryption_key]
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const cryptoModule = require('../crypto');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
===========================================================
  TeleDrive Database Backup Decryptor
===========================================================

Usage:
  node src/scripts/decrypt-backup.js <input.enc.db> [output.db] [encryption_key]

Arguments:
  input.enc.db    : Path to the encrypted backup file (.enc.db)
  output.db       : (Optional) Output file path (Default: teledrive_decrypted.db)
  encryption_key  : (Optional) Master encryption key (Default: reads ENCRYPTION_KEY from .env)

Example:
  node src/scripts/decrypt-backup.js ./teledrive_backup_2026-09-10.enc.db ./restored.db
    `);
    process.exit(0);
  }

  const inputPath = path.resolve(args[0]);
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Error: Input file not found at "${inputPath}"`);
    process.exit(1);
  }

  const outputPath = path.resolve(args[1] || 'teledrive_decrypted.db');
  const encryptionKey = args[2] || process.env.ENCRYPTION_KEY;

  if (!encryptionKey) {
    console.error('❌ Error: Master encryption key not provided and not found in .env (ENCRYPTION_KEY)');
    process.exit(1);
  }

  console.log(`🔓 Decrypting "${path.basename(inputPath)}" using AES-256-GCM...`);

  try {
    await cryptoModule.decryptBackupFile(inputPath, outputPath, encryptionKey);
    const size = fs.statSync(outputPath).size;
    console.log(`✅ Success! Database decrypted to: "${outputPath}" (${(size / 1024).toFixed(2)} KB)`);
    console.log('💡 You can now open this .db file with DB Browser for SQLite or any SQLite tool.');
  } catch (err) {
    console.error(`❌ Decryption failed: ${err.message}`);
    process.exit(1);
  }
}

main();
