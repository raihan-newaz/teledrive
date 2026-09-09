const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
const fs = require('fs');

let client = null;

/**
 * Initializes the Telegram client
 * @param {string} apiId - Telegram API ID
 * @param {string} apiHash - Telegram API Hash
 * @param {string} botToken - Telegram Bot Token
 * @returns {Promise<string>} The session string
 */
async function initialize(apiId, apiHash, botToken) {
  if (!apiId || !apiHash || !botToken) {
    throw new Error('API ID, API Hash, and Bot Token are required');
  }

  const dataDir = path.join(__dirname, '../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const sessionFile = path.join(dataDir, 'session.txt');
  let sessionStr = process.env.SESSION_STRING || '';
  if (!sessionStr && fs.existsSync(sessionFile)) {
    try {
      sessionStr = fs.readFileSync(sessionFile, 'utf8').trim();
    } catch (e) {}
  }

  const stringSession = new StringSession(sessionStr);
  
  client = new TelegramClient(stringSession, parseInt(apiId, 10), apiHash, {
    connectionRetries: 5,
  });

  try {
    if (sessionStr) {
      await client.connect();
    } else {
      await client.start({
        botAuthToken: botToken,
      });
      const saved = client.session.save();
      try { fs.writeFileSync(sessionFile, saved); } catch (e) {}
    }
  } catch (err) {
    if (err.seconds) {
      console.warn(`[Telegram] FloodWait detected: waiting ${err.seconds}s...`);
      await new Promise(r => setTimeout(r, (err.seconds + 2) * 1000));
      await client.start({ botAuthToken: botToken });
      const saved = client.session.save();
      try { fs.writeFileSync(sessionFile, saved); } catch (e) {}
    } else {
      throw err;
    }
  }

  const savedSession = client.session.save();
  try { fs.writeFileSync(sessionFile, savedSession); } catch (e) {}
  return savedSession;
}

/**
 * Returns the Telegram client instance
 * @returns {TelegramClient} The client instance
 */
function getClient() {
  if (!client) {
    throw new Error('Telegram client not initialized');
  }
  return client;
}

/**
 * Tests connection and channel access
 * @param {string} apiId - Telegram API ID
 * @param {string} apiHash - Telegram API Hash
 * @param {string} botToken - Telegram Bot Token
 * @param {string} channelId - Channel ID to test access to
 * @returns {Promise<Object>} { success: boolean, error?: string, bot?: object }
 */
async function testConnection(apiId, apiHash, botToken, channelId) {
  let tempClient = null;
  try {
    tempClient = new TelegramClient(new StringSession(''), parseInt(apiId, 10), apiHash, {
      connectionRetries: 3,
    });
    
    await tempClient.start({
      botAuthToken: botToken,
    });

    const me = await tempClient.getMe();
    
    // Test channel access
    try {
      await tempClient.getEntity(channelId);
    } catch (e) {
      try {
        await tempClient.getEntity(BigInt(channelId));
      } catch (e2) {
        console.warn('[Telegram] Channel entity lookup warning:', e2.message);
      }
    }
    
    await tempClient.disconnect();
    return {
      success: true,
      bot: {
        id: me ? (me.id ? me.id.toString() : '') : '',
        username: me ? (me.username || me.firstName || 'Bot') : 'Bot'
      }
    };
  } catch (error) {
    if (tempClient) {
      try { await tempClient.disconnect(); } catch (e) {}
    }
    return { success: false, error: error.message };
  }
}

/**
 * Uploads a file to the configured channel
 * @param {string} filePath - Local path to the file to upload
 * @param {string} fileName - Name to give the file in Telegram
 * @param {Function} progressCallback - Callback for upload progress
 * @returns {Promise<Object>} The sent message object
 */
async function uploadFile(filePath, fileName, progressCallback) {
  const tClient = getClient();
  const channel = process.env.CHANNEL_ID;
  
  if (!channel) {
    throw new Error('Channel ID not configured');
  }

  return await tClient.sendFile(channel, {
    file: filePath,
    forceDocument: true,
    workers: 16,
    progressCallback: progressCallback,
    attributes: [
      new Api.DocumentAttributeFilename({
        fileName: fileName,
      })
    ]
  });
}

/**
 * Downloads a file from a message to a local path
 * @param {number} messageId - ID of the message containing the file
 * @param {string} outputPath - Local path to save the file
 * @param {Function} progressCallback - Callback for download progress
 * @returns {Promise<void>}
 */
async function downloadFile(messageId, outputPath, progressCallback) {
  const tClient = getClient();
  const channel = process.env.CHANNEL_ID;
  
  if (!channel) {
    throw new Error('Channel ID not configured');
  }

  const messages = await tClient.getMessages(channel, { ids: [parseInt(messageId, 10)] });
  if (!messages || messages.length === 0 || !messages[0]) {
    throw new Error('Message not found');
  }
  
  await tClient.downloadMedia(messages[0], {
    outputFile: outputPath,
    workers: 8,
    progressCallback: progressCallback,
  });
}

/**
 * Creates a stream to download media
 * @param {number} messageId - ID of the message
 * @returns {Promise<stream.Readable>} A readable stream
 */
async function downloadToStream(messageId) {
  const tClient = getClient();
  const channel = process.env.CHANNEL_ID;
  
  if (!channel) {
    throw new Error('Channel ID not configured');
  }

  const messages = await tClient.getMessages(channel, { ids: [parseInt(messageId, 10)] });
  if (!messages || messages.length === 0 || !messages[0]) {
    throw new Error('Message not found');
  }
  
  const buffer = await tClient.downloadMedia(messages[0], { workers: 8 });
  
  const { Readable } = require('stream');
  return Readable.from(buffer);
}

/**
 * Streams media in chunks from Telegram
 * @param {number} messageId - Telegram message ID
 * @param {number} [requestSize=512*1024] - Size of each chunk
 * @returns {AsyncGenerator<Buffer>} Yields chunks
 */
async function* iterDownloadFile(messageId, requestSize = 512 * 1024) {
  const tClient = getClient();
  const channel = process.env.CHANNEL_ID;
  if (!channel) throw new Error('Channel ID not configured');

  const messages = await tClient.getMessages(channel, { ids: [parseInt(messageId, 10)] });
  if (!messages || messages.length === 0 || !messages[0] || !messages[0].media) {
    throw new Error('Media not found in Telegram message ' + messageId);
  }

  for await (const chunk of tClient.iterDownload({
    file: messages[0].media,
    requestSize: requestSize,
    workers: 8,
  })) {
    yield chunk;
  }
}

let _cachedChannelEntity = null;

/**
 * Resolves the channel input entity reliably for GramJS
 */
async function getChannelInputEntity() {
  const tClient = getClient();
  const channel = process.env.CHANNEL_ID;
  if (!channel) throw new Error('Channel ID not configured');

  if (_cachedChannelEntity) {
    return _cachedChannelEntity;
  }

  try {
    _cachedChannelEntity = await tClient.getInputEntity(channel);
    return _cachedChannelEntity;
  } catch (e1) {
    try {
      _cachedChannelEntity = await tClient.getInputEntity(BigInt(channel));
      return _cachedChannelEntity;
    } catch (e2) {
      try {
        const ent = await tClient.getEntity(channel);
        _cachedChannelEntity = await tClient.getInputEntity(ent);
        return _cachedChannelEntity;
      } catch (e3) {
        const ent = await tClient.getEntity(BigInt(channel));
        _cachedChannelEntity = await tClient.getInputEntity(ent);
        return _cachedChannelEntity;
      }
    }
  }
}

/**
 * Deletes one or multiple messages/files from the Telegram channel
 * @param {number|number[]|string|string[]} messageIds - Message ID(s) to delete
 * @returns {Promise<Object>}
 */
async function deleteFiles(messageIds) {
  const tClient = getClient();
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds])
    .map(id => parseInt(id, 10))
    .filter(id => !isNaN(id) && id > 0);

  if (ids.length === 0) {
    return { success: true, count: 0 };
  }

  try {
    const channelEntity = await getChannelInputEntity();
    console.log(`[Telegram] Deleting message ID(s): [${ids.join(', ')}] from channel...`);
    const result = await tClient.deleteMessages(channelEntity, ids, { revoke: true });
    console.log(`[Telegram] Successfully deleted message ID(s): [${ids.join(', ')}]. Result:`, JSON.stringify(result));
    return { success: true, count: ids.length, result };
  } catch (err) {
    console.error(`[Telegram] Error deleting message ID(s) [${ids.join(', ')}]:`, err.message);
    if (err.message && (err.message.includes('CHAT_ADMIN_REQUIRED') || err.message.includes('MESSAGE_DELETE_FORBIDDEN') || err.message.includes('admin'))) {
      throw new Error(`Telegram bot permission error: Bot requires "Delete messages" administrator rights in the channel to remove files.`);
    }
    throw err;
  }
}

/**
 * Backward-compatible single file delete
 * @param {number|string} messageId - ID of the message to delete
 * @returns {Promise<Object>}
 */
async function deleteFile(messageId) {
  return deleteFiles([messageId]);
}

module.exports = {
  initialize,
  getClient,
  getChannelInputEntity,
  testConnection,
  uploadFile,
  downloadFile,
  downloadToStream,
  iterDownloadFile,
  deleteFile,
  deleteFiles
};

