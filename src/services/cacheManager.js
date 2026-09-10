const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');
const cacheDir = path.join(dataDir, 'cache');

// Ensure cache directory exists
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

/**
 * Get current configured cache limit in bytes (Default 3 GB)
 */
function getMaxCacheLimitBytes() {
  const envLimit = process.env.MAX_CACHE_LIMIT_GB;
  const parsed = parseFloat(envLimit);
  if (!isNaN(parsed) && parsed > 0) {
    return Math.round(parsed * 1024 * 1024 * 1024);
  }
  return 3 * 1024 * 1024 * 1024; // 3 GB default
}

let isPruning = false;

/**
 * Prune cache using LRU (Least Recently Used) policy when total size exceeds max limit
 */
async function pruneCacheIfNeeded() {
  if (isPruning) return;
  isPruning = true;

  try {
    if (!fs.existsSync(cacheDir)) return;

    const maxLimit = getMaxCacheLimitBytes();
    const targetLimit = Math.round(maxLimit * 0.8); // Prune down to 80% to avoid thrashing

    const files = await fsPromises.readdir(cacheDir);
    const fileEntries = [];
    let totalBytes = 0;

    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      try {
        const stats = await fsPromises.stat(filePath);
        if (stats.isFile()) {
          totalBytes += stats.size;
          fileEntries.push({
            path: filePath,
            size: stats.size,
            atime: stats.atimeMs || stats.mtimeMs || 0
          });
        }
      } catch (e) {}
    }

    if (totalBytes <= maxLimit) {
      return; // Under limit, nothing to do
    }

    console.log(`[Cache] Cache size (${(totalBytes / (1024 * 1024)).toFixed(1)} MB) exceeded limit (${(maxLimit / (1024 * 1024 * 1024)).toFixed(1)} GB). Pruning oldest LRU files...`);

    // Sort by last accessed time (oldest first)
    fileEntries.sort((a, b) => a.atime - b.atime);

    let freedBytes = 0;
    for (const entry of fileEntries) {
      if (totalBytes - freedBytes <= targetLimit) break;
      try {
        await fsPromises.unlink(entry.path);
        freedBytes += entry.size;
      } catch (err) {
        console.warn(`[Cache] Could not delete cached file ${entry.path}:`, err.message);
      }
    }

    console.log(`[Cache] LRU Prune complete: freed ${(freedBytes / (1024 * 1024)).toFixed(1)} MB disk space.`);
  } catch (err) {
    console.error('[Cache] Pruning error:', err);
  } finally {
    isPruning = false;
  }
}

/**
 * Update access time when cached file is used
 */
function touchCacheFile(filePath) {
  try {
    const now = new Date();
    fs.utimes(filePath, now, now, () => {});
  } catch (e) {}
}

/**
 * Start recurring background cache maintenance (checks every 20 minutes)
 */
function startCacheMaintenanceSchedule() {
  setInterval(() => {
    pruneCacheIfNeeded();
  }, 20 * 60 * 1000);
  
  // Initial check on startup
  setTimeout(() => {
    pruneCacheIfNeeded();
  }, 10000);

  console.log(`[Cache] Auto LRU cache management active (Limit: ${(getMaxCacheLimitBytes() / (1024 * 1024 * 1024)).toFixed(1)} GB)`);
}

module.exports = {
  getMaxCacheLimitBytes,
  pruneCacheIfNeeded,
  touchCacheFile,
  startCacheMaintenanceSchedule
};
