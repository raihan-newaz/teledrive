/**
 * TeleDrive — Video Transcoding & Adaptive Bitrate Streaming (HLS) Service
 * 
 * Supports:
 * - FFmpeg / ffprobe Metadata Inspection (4K, 1440p, 1080p, 720p, 480p)
 * - Multi-Rendition HLS Generation (master.m3u8 + variant playlists)
 * - User-Isolated Cache (data/video-cache/<userId>/<fileId>/)
 * - Temporary Decrypted Source Protection (auto-cleanup in finally block)
 * - Concurrency Control (MAX_TRANSCODE_JOBS) & In-Flight Job Deduplication
 * - Automatic LRU Cache Eviction & TTL Management
 */

const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const db = require('../db');
const telegram = require('../telegram');
const cryptoModule = require('../crypto');

const dataDir = path.join(__dirname, '../../data');
const tmpDir = path.join(dataDir, 'tmp');
const videoCacheDir = path.join(dataDir, 'video-cache');

if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
if (!fs.existsSync(videoCacheDir)) fs.mkdirSync(videoCacheDir, { recursive: true });

// Configuration Defaults
const MAX_TRANSCODE_JOBS = parseInt(process.env.MAX_TRANSCODE_JOBS || '1', 10);
const HLS_SEGMENT_SECONDS = parseInt(process.env.HLS_SEGMENT_SECONDS || '6', 10);
const VIDEO_CACHE_MAX_GB = parseInt(process.env.VIDEO_CACHE_MAX_GB || '20', 10);
const VIDEO_CACHE_TTL_DAYS = parseInt(process.env.VIDEO_CACHE_TTL_DAYS || '7', 10);
const VIDEO_TRANSCODING_ENABLED = process.env.VIDEO_TRANSCODING_ENABLED !== 'false';

// Standard ABR Profiles (Heights strictly sorted descending)
const ABR_PROFILES = [
  { name: '2160p', label: '4K (2160p)', width: 3840, height: 2160, videoBitrate: '14000k', maxRate: '16000k', bufSize: '28000k', audioBitrate: '192k', minSourceHeight: 1800 },
  { name: '1440p', label: '2K (1440p)', width: 2560, height: 1440, videoBitrate: '8000k',  maxRate: '9500k',  bufSize: '16000k', audioBitrate: '160k', minSourceHeight: 1300 },
  { name: '1080p', label: '1080p FHD',  width: 1920, height: 1080, videoBitrate: '4500k',  maxRate: '5200k',  bufSize: '9000k',  audioBitrate: '128k', minSourceHeight: 900 },
  { name: '720p',  label: '720p HD',    width: 1280, height: 720,  videoBitrate: '2200k',  maxRate: '2600k',  bufSize: '4400k',  audioBitrate: '128k', minSourceHeight: 600 },
  { name: '480p',  label: '480p SD',    width: 854,  height: 480,  videoBitrate: '1000k',  maxRate: '1200k',  bufSize: '2000k',  audioBitrate: '96k',  minSourceHeight: 0 }
];

// Active concurrency and in-memory queue
let activeJobCount = 0;
const jobQueue = [];
const activeJobsMap = new Map(); // fileId -> Promise

let resolvedFfmpegPath = null;
let resolvedFfprobePath = null;

/**
 * Resolves full path to ffmpeg and ffprobe binaries (supporting Linux, macOS, WinGet, and custom paths)
 */
function resolveFfmpegBinaries() {
  if (resolvedFfmpegPath && resolvedFfprobePath) {
    return { ffmpeg: resolvedFfmpegPath, ffprobe: resolvedFfprobePath };
  }

  // 1. Check custom environment variables
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    resolvedFfmpegPath = process.env.FFMPEG_PATH;
    resolvedFfprobePath = process.env.FFPROBE_PATH || process.env.FFMPEG_PATH.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    return { ffmpeg: resolvedFfmpegPath, ffprobe: resolvedFfprobePath };
  }

  // 2. Check WinGet / standard Windows directories
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  const candidateDirs = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    path.join(localAppData, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0.1-full_build', 'bin'),
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin'
  ];

  if (localAppData) {
    const wingetPackages = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
    if (fs.existsSync(wingetPackages)) {
      try {
        const entries = fs.readdirSync(wingetPackages);
        for (const entry of entries) {
          if (entry.toLowerCase().includes('ffmpeg')) {
            const subDir = path.join(wingetPackages, entry);
            const subEntries = fs.readdirSync(subDir);
            for (const sub of subEntries) {
              const binDir = path.join(subDir, sub, 'bin');
              if (fs.existsSync(binDir)) candidateDirs.unshift(binDir);
            }
          }
        }
      } catch (e) {}
    }
  }

  for (const dir of candidateDirs) {
    const ffmpegExe = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const ffprobeExe = path.join(dir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe)) {
      resolvedFfmpegPath = ffmpegExe;
      resolvedFfprobePath = ffprobeExe;
      return { ffmpeg: resolvedFfmpegPath, ffprobe: resolvedFfprobePath };
    }
  }

  // 3. Fallback to system PATH
  resolvedFfmpegPath = 'ffmpeg';
  resolvedFfprobePath = 'ffprobe';
  return { ffmpeg: resolvedFfmpegPath, ffprobe: resolvedFfprobePath };
}

/**
 * Check if FFmpeg and ffprobe are available
 */
function isFfmpegAvailable() {
  return new Promise((resolve) => {
    const { ffmpeg } = resolveFfmpegBinaries();
    execFile(ffmpeg, ['-version'], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Probes video file with ffprobe to retrieve exact dimensions, duration, bitrate, and codec
 */
function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    const { ffprobe } = resolveFfmpegBinaries();
    execFile(
      ffprobe,
      [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(new Error('ffprobe failed: ' + err.message));
        try {
          const data = JSON.parse(stdout);
          const vStream = (data.streams || []).find(s => s.codec_type === 'video');
          const aStream = (data.streams || []).find(s => s.codec_type === 'audio');

          if (!vStream) return reject(new Error('No video stream detected'));

          const duration = parseFloat(data.format?.duration || vStream.duration || 0);
          const width = parseInt(vStream.width || 0, 10);
          const height = parseInt(vStream.height || 0, 10);
          const codec = vStream.codec_name || 'unknown';
          const audioCodec = aStream ? (aStream.codec_name || 'unknown') : null;
          const bitrate = parseInt(data.format?.bit_rate || vStream.bit_rate || 0, 10);
          
          let fps = 30;
          if (vStream.r_frame_rate) {
            const parts = vStream.r_frame_rate.split('/');
            if (parts.length === 2 && parseInt(parts[1], 10) > 0) {
              fps = Math.round(parseInt(parts[0], 10) / parseInt(parts[1], 10));
            }
          }

          const isHdr = Boolean(
            vStream.color_space?.includes('bt2020') ||
            vStream.color_transfer?.includes('smpte2084') ||
            vStream.color_transfer?.includes('arib-std-b67') ||
            (vStream.bits_per_raw_sample && parseInt(vStream.bits_per_raw_sample, 10) > 8)
          );

          resolve({
            duration,
            width,
            height,
            codec,
            audio_codec: audioCodec,
            bitrate,
            fps,
            is_hdr: isHdr
          });
        } catch (parseErr) {
          reject(new Error('Failed to parse ffprobe output: ' + parseErr.message));
        }
      }
    );
  });
}

/**
 * Returns the HLS output directory path for a user's file
 */
function getFileHlsDir(userId, fileId) {
  const safeUserId = String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFileId = String(fileId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(videoCacheDir, safeUserId, safeFileId);
}

/**
 * Checks whether HLS master playlist and renditions already exist
 */
function isHlsReady(userId, fileId) {
  const hlsDir = getFileHlsDir(userId, fileId);
  const masterPath = path.join(hlsDir, 'master.m3u8');
  if (!fs.existsSync(masterPath)) return false;
  try {
    const content = fs.readFileSync(masterPath, 'utf8');
    return content.includes('#EXT-X-STREAM-INF') || content.includes('#EXTM3U');
  } catch (e) {
    return false;
  }
}

/**
 * Downloads and decrypts all parts of a file into a secure temporary plaintext file
 */
async function assemblePlaintextSource(file, userKey, tempOutputPath, onProgress) {
  let parts = [];
  if (file.is_chunked === 1) {
    parts = db.getFileChunks(file.id);
    if (parts && parts.length > 0) parts.sort((a, b) => a.chunk_index - b.chunk_index);
  } else {
    parts = [{
      chunk_index: 0,
      telegram_message_id: file.telegram_message_id,
      size: file.size,
      iv: file.iv,
      salt: file.salt,
      auth_tag: file.auth_tag
    }];
  }

  if (!parts || parts.length === 0) {
    throw new Error('File chunks not found');
  }

  let encKey = userKey;
  if (!encKey && (file.user_id || userId)) {
    const uId = file.user_id || userId;
    const user = db.getUserById(uId);
    const masterKey = process.env.ENCRYPTION_KEY || 'default-encryption-key';
    if (user && user.encryption_key) {
      try {
        encKey = cryptoModule.unwrapUserKey(user.encryption_key, masterKey);
      } catch (e) {
        encKey = masterKey;
      }
    } else {
      encKey = masterKey;
    }
  }
  if (!encKey) {
    encKey = process.env.ENCRYPTION_KEY || 'default-encryption-key';
  }

  const writeStream = fs.createWriteStream(tempOutputPath);
  try {
    for (const part of parts) {
      const key = cryptoModule.deriveKey(encKey, part.salt);
      const iv = Buffer.from(part.iv, 'base64');
      
      const cipherChunks = [];
      for await (const chunk of telegram.iterDownloadFile(part.telegram_message_id, 1024 * 1024)) {
        cipherChunks.push(chunk);
      }

      const rawDownloadedBuf = Buffer.concat(cipherChunks);
      let authTag = part.auth_tag ? Buffer.from(part.auth_tag, 'base64') : null;
      let ciphertext = rawDownloadedBuf;

      if (part.size && rawDownloadedBuf.length === part.size + 16) {
        ciphertext = rawDownloadedBuf.subarray(0, part.size);
        if (!authTag) {
          authTag = rawDownloadedBuf.subarray(part.size);
        }
      } else if (part.size && rawDownloadedBuf.length > part.size) {
        ciphertext = rawDownloadedBuf.subarray(0, part.size);
      }

      let partPlaintext = null;

      // Attempt 1: Standard decryption
      try {
        const decipher = require('crypto').createDecipheriv('aes-256-gcm', key, iv);
        if (authTag) decipher.setAuthTag(authTag);
        const d = decipher.update(ciphertext);
        const f = decipher.final();
        partPlaintext = Buffer.concat([d, f]);
      } catch (err1) {
        // Attempt 2: AuthTag at end of raw buffer
        if (rawDownloadedBuf.length >= 16) {
          try {
            const decipher2 = require('crypto').createDecipheriv('aes-256-gcm', key, iv);
            const tagFromEnd = rawDownloadedBuf.subarray(rawDownloadedBuf.length - 16);
            const ctFromEnd = rawDownloadedBuf.subarray(0, rawDownloadedBuf.length - 16);
            decipher2.setAuthTag(tagFromEnd);
            const d2 = decipher2.update(ctFromEnd);
            const f2 = decipher2.final();
            partPlaintext = Buffer.concat([d2, f2]);
          } catch (err2) {}
        }

        // Attempt 3: Raw buffer with stored tag
        if (!partPlaintext) {
          try {
            const decipher3 = require('crypto').createDecipheriv('aes-256-gcm', key, iv);
            if (authTag) decipher3.setAuthTag(authTag);
            const d3 = decipher3.update(rawDownloadedBuf);
            const f3 = decipher3.final();
            partPlaintext = Buffer.concat([d3, f3]);
          } catch (err3) {}
        }

        if (!partPlaintext) {
          console.error(`[Crypto] Decryption failed for part ${part.chunk_index || 0}:`, err1.message);
          throw new Error(`Integrity check failed: File part ${part.chunk_index || 0} could not be authenticated.`);
        }
      }

      const canWrite = writeStream.write(partPlaintext);
      if (!canWrite) {
        await new Promise(r => writeStream.once('drain', r));
      }

      // Report download progress
      if (onProgress) {
        const partPct = Math.round(((parts.indexOf(part) + 1) / parts.length) * 100);
        onProgress(partPct);
      }
    }

    await new Promise((resolve, reject) => {
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    writeStream.destroy();
    await fsPromises.unlink(tempOutputPath).catch(() => {});
    throw err;
  }
}

/**
 * Selects sensible renditions for a source video based on actual resolution
 */
function selectRenditionProfiles(sourceWidth, sourceHeight) {
  const maxDim = Math.max(sourceWidth, sourceHeight);
  const minDim = Math.min(sourceWidth, sourceHeight);

  // Filter profiles that are less than or equal to source resolution (never upscale)
  const selected = ABR_PROFILES.filter(p => minDim >= p.minSourceHeight);
  
  // If video is smaller than 480p, at least include 480p (or source)
  if (selected.length === 0) {
    selected.push(ABR_PROFILES[ABR_PROFILES.length - 1]);
  }

  return selected;
}

/**
 * Builds and executes FFmpeg HLS encoding for selected renditions
 */
function transcodeToHls(sourcePath, outputDir, renditions, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Ensure subdirectories for each rendition
    renditions.forEach(r => {
      const rendDir = path.join(outputDir, r.name);
      if (!fs.existsSync(rendDir)) fs.mkdirSync(rendDir, { recursive: true });
    });

    const args = [
      '-y',
      '-threads', '0',
      '-i', sourcePath
    ];

    // Build filter_complex and map arguments for multiple renditions
    const filterComplex = [];

    renditions.forEach((r, idx) => {
      // Scale maintaining aspect ratio, width & height even numbers
      filterComplex.push(`[0:v]scale=w=${r.width}:h=${r.height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[v${idx}]`);
    });

    args.push('-filter_complex', filterComplex.join(';'));

    renditions.forEach((r, idx) => {
      const rendDir = path.join(outputDir, r.name);
      const segPattern = path.join(rendDir, 'seg_%03d.ts').replace(/\\/g, '/');
      const playlistPath = path.join(rendDir, 'index.m3u8').replace(/\\/g, '/');

      args.push(
        '-map', `[v${idx}]`,
        '-map', '0:a?',
        `-c:v:${idx}`, 'libx264',
        `-preset:v:${idx}`, 'superfast',
        `-b:v:${idx}`, r.videoBitrate,
        `-maxrate:v:${idx}`, r.maxRate,
        `-bufsize:v:${idx}`, r.bufSize,
        `-pix_fmt:v:${idx}`, 'yuv420p',
        `-g:${idx}`, '60',
        `-keyint_min:${idx}`, '60',
        `-sc_threshold:${idx}`, '0',
        `-c:a:${idx}`, 'aac',
        `-b:a:${idx}`, r.audioBitrate,
        `-ac:${idx}`, '2',
        '-f', 'hls',
        '-hls_time', String(HLS_SEGMENT_SECONDS || 4),
        '-hls_list_size', '0',
        '-hls_segment_type', 'mpegts',
        '-hls_segment_filename', segPattern,
        playlistPath
      );
    });

    args.push('-progress', 'pipe:1');

    console.log(`[HLS] Spawning FFmpeg for ${renditions.map(r => r.name).join(', ')}...`);
    const { ffmpeg } = resolveFfmpegBinaries();
    const ffmpegProc = spawn(ffmpeg, args);

    let progressOutput = '';
    ffmpegProc.stdout.on('data', (data) => {
      progressOutput += data.toString();
      const lines = progressOutput.split('\n');
      progressOutput = lines.pop(); // keep remainder

      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const timeMs = parseInt(line.split('=')[1], 10);
          if (!isNaN(timeMs) && totalDuration > 0) {
            const currentSec = timeMs / 1000000;
            const pct = Math.min(99, Math.max(1, Math.round((currentSec / totalDuration) * 100)));
            if (onProgress) onProgress(pct);
          }
        }
      }
    });

    let stderrData = '';
    ffmpegProc.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ffmpegProc.on('error', (err) => {
      reject(new Error('FFmpeg execution error: ' + err.message));
    });

    ffmpegProc.on('close', (code) => {
      if (code === 0) {
        // Generate master.m3u8
        try {
          generateMasterPlaylist(outputDir, renditions);
          if (onProgress) onProgress(100);
          resolve(true);
        } catch (mErr) {
          reject(mErr);
        }
      } else {
        const lastErrLines = stderrData.split('\n').slice(-10).join('\n');
        reject(new Error(`FFmpeg exited with code ${code}: ${lastErrLines}`));
      }
    });
  });
}

/**
 * Generates the master.m3u8 playlist referencing all rendered variant streams
 */
function generateMasterPlaylist(outputDir, renditions) {
  let master = '#EXTM3U\n#EXT-X-VERSION:3\n\n';

  renditions.forEach((r) => {
    const bandwidth = parseInt(r.maxRate.replace('k', ''), 10) * 1000;
    master += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height},NAME="${r.label}"\n`;
    master += `${r.name}/index.m3u8\n\n`;
  });

  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.writeFileSync(masterPath, master, 'utf8');
}

/**
 * Process next job in the transcode queue
 */
async function processQueue() {
  if (activeJobCount >= MAX_TRANSCODE_JOBS || jobQueue.length === 0) return;

  const item = jobQueue.shift();
  activeJobCount++;

  const { file, userId, userKey, resolve, reject } = item;
  const fileId = file.id;
  const hlsDir = getFileHlsDir(userId, fileId);
  const tempSrcPath = path.join(tmpDir, `transcode_src_${fileId}${path.extname(file.name || '') || '.mp4'}`);

  try {
    db.upsertTranscodeJob(fileId, userId, 'processing', 2, null);

    // 1. Download and decrypt full source to temporary plaintext file
    // Progress phase 1: download = 2% → 30%
    console.log(`[HLS] Assembling decrypted source for "${file.name}" (${file.id})...`);
    await assemblePlaintextSource(file, userKey, tempSrcPath, (dlPct) => {
      const mapped = Math.round(2 + (dlPct / 100) * 28); // 2% → 30%
      db.upsertTranscodeJob(fileId, userId, 'processing', mapped, null);
    });

    db.upsertTranscodeJob(fileId, userId, 'processing', 30, null);

    // 2. Probe metadata using ffprobe
    const metadata = await probeVideo(tempSrcPath);
    db.saveVideoMetadata(fileId, metadata);

    // 3. Select appropriate rendition profiles
    const renditions = selectRenditionProfiles(metadata.width, metadata.height);

    // 4. Run FFmpeg Multi-Rendition HLS Transcoder
    // Progress phase 2: transcode = 30% → 99%
    await transcodeToHls(tempSrcPath, hlsDir, renditions, metadata.duration, (pct) => {
      const mapped = Math.round(30 + (pct / 100) * 69); // 30% → 99%
      db.upsertTranscodeJob(fileId, userId, 'processing', Math.min(99, mapped), null);
    });

    db.upsertTranscodeJob(fileId, userId, 'ready', 100, null);
    console.log(`[HLS] Successfully generated ABR HLS for "${file.name}" in ${hlsDir}`);

    try {
      const eventBroadcaster = require('./eventBroadcaster');
      eventBroadcaster.broadcast('hls_ready', { fileId, userId });
    } catch (e) {}

    // Enforce cache quota limits
    enforceCacheLimits().catch(() => {});

    resolve({ ready: true, renditions: renditions.map(r => r.name) });
  } catch (err) {
    console.error(`[HLS] Transcode failed for ${fileId}:`, err.message);
    db.upsertTranscodeJob(fileId, userId, 'failed', 0, err.message);
    
    // Clean partial HLS dir on failure
    try {
      await fsPromises.rm(hlsDir, { recursive: true, force: true });
    } catch (e) {}

    reject(err);
  } finally {
    // ALWAYS remove temporary decrypted source file
    await fsPromises.unlink(tempSrcPath).catch(() => {});
    activeJobsMap.delete(fileId);
    activeJobCount--;
    processQueue();
  }
}

/**
 * Requests or triggers HLS transcoding for a video file
 */
async function requestHlsTranscode(file, userId, userKey = null) {
  if (!VIDEO_TRANSCODING_ENABLED) {
    return { ready: false, disabled: true, message: 'Video transcoding is disabled by server configuration.' };
  }

  const fileId = file.id;

  // 1. If already completely ready in cache, return ready immediately
  if (isHlsReady(userId, fileId)) {
    const job = db.getTranscodeJob(fileId);
    if (!job || job.status !== 'ready') {
      db.upsertTranscodeJob(fileId, userId, 'ready', 100, null);
    }
    return { ready: true, status: 'ready', progress: 100 };
  }

  // 2. If in-flight active job exists, attach to existing promise (deduplication)
  if (activeJobsMap.has(fileId)) {
    const job = db.getTranscodeJob(fileId);
    return {
      ready: false,
      status: job?.status || 'processing',
      progress: job?.progress || 10
    };
  }

  // Check if FFmpeg is available
  const hasFfmpeg = await isFfmpegAvailable();
  if (!hasFfmpeg) {
    return { ready: false, error: 'FFmpeg is not installed or available on this system.' };
  }

  // 3. Queue new transcode job
  const jobPromise = new Promise((resolve, reject) => {
    db.upsertTranscodeJob(fileId, userId, 'queued', 0, null);
    jobQueue.push({ file, userId, userKey, resolve, reject });
    processQueue();
  });

  activeJobsMap.set(fileId, jobPromise);

  return {
    ready: false,
    status: 'queued',
    progress: 0
  };
}

/**
 * Enforces LRU and TTL limits on data/video-cache
 */
async function enforceCacheLimits() {
  try {
    if (!fs.existsSync(videoCacheDir)) return;

    const userDirs = await fsPromises.readdir(videoCacheDir);
    const allCacheEntries = [];

    for (const uDir of userDirs) {
      const uPath = path.join(videoCacheDir, uDir);
      const uStat = await fsPromises.stat(uPath).catch(() => null);
      if (!uStat || !uStat.isDirectory()) continue;

      const fileDirs = await fsPromises.readdir(uPath);
      for (const fDir of fileDirs) {
        const fPath = path.join(uPath, fDir);
        const fStat = await fsPromises.stat(fPath).catch(() => null);
        if (!fStat || !fStat.isDirectory()) continue;

        // Calculate total folder size and latest mtime
        let totalSize = 0;
        let latestMtime = fStat.mtimeMs;

        const subFiles = await fsPromises.readdir(fPath, { recursive: true }).catch(() => []);
        for (const sf of subFiles) {
          const sfPath = path.join(fPath, sf);
          const sfStat = await fsPromises.stat(sfPath).catch(() => null);
          if (sfStat && sfStat.isFile()) {
            totalSize += sfStat.size;
            if (sfStat.mtimeMs > latestMtime) latestMtime = sfStat.mtimeMs;
          }
        }

        allCacheEntries.push({
          dirPath: fPath,
          userId: uDir,
          fileId: fDir,
          size: totalSize,
          mtimeMs: latestMtime
        });
      }
    }

    const now = Date.now();
    const ttlMs = VIDEO_CACHE_TTL_DAYS * 24 * 3600 * 1000;
    const maxBytes = VIDEO_CACHE_MAX_GB * 1024 * 1024 * 1024;

    let currentTotalBytes = 0;

    // 1. Evict entries exceeding TTL
    for (const entry of allCacheEntries) {
      if (now - entry.mtimeMs > ttlMs) {
        console.log(`[HLS Cache] Evicting expired HLS cache (${VIDEO_CACHE_TTL_DAYS}d): ${entry.dirPath}`);
        await fsPromises.rm(entry.dirPath, { recursive: true, force: true }).catch(() => {});
        db.deleteTranscodeJob(entry.fileId);
      } else {
        currentTotalBytes += entry.size;
      }
    }

    // 2. Evict oldest LRU entries if total size exceeds VIDEO_CACHE_MAX_GB
    if (currentTotalBytes > maxBytes) {
      allCacheEntries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
      for (const entry of allCacheEntries) {
        if (currentTotalBytes <= maxBytes) break;
        console.log(`[HLS Cache] Evicting LRU HLS cache: ${entry.dirPath} (${(entry.size / (1024 * 1024)).toFixed(1)} MB)`);
        await fsPromises.rm(entry.dirPath, { recursive: true, force: true }).catch(() => {});
        db.deleteTranscodeJob(entry.fileId);
        currentTotalBytes -= entry.size;
      }
    }
  } catch (err) {
    console.error('[HLS Cache] Cache cleanup error:', err.message);
  }
}

/**
 * Permanently deletes HLS cache directory for a file
 */
async function deleteFileHlsCache(userId, fileId) {
  try {
    const hlsDir = getFileHlsDir(userId, fileId);
    if (fs.existsSync(hlsDir)) {
      await fsPromises.rm(hlsDir, { recursive: true, force: true });
    }
    db.deleteTranscodeJob(fileId);
  } catch (e) {}
}

module.exports = {
  resolveFfmpegBinaries,
  isFfmpegAvailable,
  probeVideo,
  getFileHlsDir,
  isHlsReady,
  requestHlsTranscode,
  enforceCacheLimits,
  deleteFileHlsCache,
  ABR_PROFILES
};
