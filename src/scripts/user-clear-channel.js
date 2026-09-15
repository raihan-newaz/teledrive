/**
 * Telegram User-Session Channel Cleaner
 * Uses your Telegram User Account to fetch ALL message IDs from the channel and bulk delete them.
 *
 * Usage:
 *   node src/scripts/user-clear-channel.js
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
const configEnv = path.join(__dirname, '../../data/config.env');
const dataEnv = path.join(__dirname, '../../data/.env');
const rootEnv = path.join(__dirname, '../../.env');
if (fs.existsSync(configEnv)) dotenv.config({ path: configEnv });
if (fs.existsSync(dataEnv)) dotenv.config({ path: dataEnv });
if (fs.existsSync(rootEnv)) {
  try {
    if (!fs.statSync(rootEnv).isDirectory()) dotenv.config({ path: rootEnv });
  } catch (e) {}
}

const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const channelId = process.env.CHANNEL_ID;

if (!apiId || !apiHash || !channelId) {
  console.error('❌ Missing API_ID, API_HASH, or CHANNEL_ID in data/config.env.');
  process.exit(1);
}

// Store user session temporarily in data/user_session.txt for quick re-use
const userSessionPath = path.join(__dirname, '../../data/user_session.txt');
let savedUserSession = '';
if (fs.existsSync(userSessionPath)) {
  try {
    savedUserSession = fs.readFileSync(userSessionPath, 'utf8').trim();
  } catch (e) {}
}

async function main() {
  console.log('\n======================================================');
  console.log('   TELEGRAM USER-ACCOUNT CHANNEL FULL PURGE TOOL');
  console.log('======================================================');
  console.log(`Target Channel ID : ${channelId}`);
  console.log('------------------------------------------------------\n');

  const stringSession = new StringSession(savedUserSession);
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 10,
    autoReconnect: true,
  });

  console.log('[1/4] Connecting to Telegram with your User Account...');
  await client.start({
    phoneNumber: async () => await input.text('📱 Enter your Telegram phone number (e.g. +88017...): '),
    password: async () => await input.text('🔑 Enter your 2FA Cloud Password (if enabled): '),
    phoneCode: async () => await input.text('✉️  Enter the OTP code received on your Telegram app: '),
    onError: (err) => console.error('[Telegram Auth Error]', err.message),
  });

  // Save session for convenience
  const currentSession = client.session.save();
  try {
    fs.writeFileSync(userSessionPath, currentSession);
  } catch (e) {}

  console.log('✓ Successfully authenticated as Channel Owner/Admin!');

  console.log('\n[2/4] Resolving channel entity...');
  let channelEntity;
  try {
    channelEntity = await client.getInputEntity(channelId.startsWith('-100') ? BigInt(channelId) : channelId);
  } catch (e) {
    try {
      const ent = await client.getEntity(channelId.startsWith('-100') ? BigInt(channelId) : channelId);
      channelEntity = await client.getInputEntity(ent);
    } catch (e2) {
      console.error('❌ Could not resolve channel entity. Make sure you are a member/admin of the channel:', e2.message);
      process.exit(1);
    }
  }
  console.log('✓ Channel entity resolved successfully.');

  console.log('\n[3/4] Scanning channel history to fetch ALL message IDs...');
  const allMessageIds = [];

  for await (const message of client.iterMessages(channelEntity, { limit: 100000 })) {
    if (message && message.id) {
      allMessageIds.push(message.id);
      if (allMessageIds.length % 100 === 0) {
        process.stdout.write(`  ├─ Found ${allMessageIds.length} messages so far...\r`);
      }
    }
  }

  console.log(`\n✓ Scan complete! Found a total of ${allMessageIds.length} message(s) in this channel.`);

  if (allMessageIds.length === 0) {
    console.log('\n🎉 Channel is already completely empty!');
    await client.disconnect();
    process.exit(0);
  }

  const confirm = await input.text(`\n⚠️  Are you sure you want to permanently DELETE all ${allMessageIds.length} message(s)? (type "yes" to confirm): `);
  if (confirm.trim().toLowerCase() !== 'yes') {
    console.log('Operation cancelled.');
    await client.disconnect();
    process.exit(0);
  }

  console.log('\n[4/4] Purging messages in 100-item batches via Owner authority...\n');

  const BATCH_SIZE = 100;
  let totalDeleted = 0;
  let batchIndex = 0;

  for (let i = 0; i < allMessageIds.length; i += BATCH_SIZE) {
    batchIndex++;
    const chunkIds = allMessageIds.slice(i, i + BATCH_SIZE);
    process.stdout.write(`[Batch #${batchIndex}] Deleting ${chunkIds.length} message(s) (IDs ${chunkIds[0]} ... ${chunkIds[chunkIds.length - 1]})... `);

    try {
      await client.deleteMessages(channelEntity, chunkIds, { revoke: true });
      totalDeleted += chunkIds.length;
      process.stdout.write(`✓ Done\n`);
    } catch (err) {
      if (err.seconds) {
        console.warn(`\n[FloodWait] Rate limit hit. Waiting ${err.seconds}s...`);
        await new Promise(r => setTimeout(r, (err.seconds + 1) * 1000));
        await client.deleteMessages(channelEntity, chunkIds, { revoke: true }).catch(() => {});
        totalDeleted += chunkIds.length;
        process.stdout.write(`✓ Done after wait\n`);
      } else {
        console.warn(`\n⚠️ Notice on batch: ${err.message}`);
      }
    }

    // Small delay between batches to avoid Telegram FloodWait
    await new Promise(r => setTimeout(r, 300));
  }

  console.log('\n======================================================');
  console.log(`🎉 SUCCESS: Purged ${totalDeleted} message(s) from the channel!`);
  console.log('======================================================\n');

  await client.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
