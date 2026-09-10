/**
 * Upload Controller with Progress Tracking, True Resumability, Speed & ETA, and Cancel Controls
 */
const Upload = {
  queue: [],
  isUploading: false,
  wakeLock: null,
  _wakeLockFallbackVideo: null,

  get isWakeLockEnabled() {
    return localStorage.getItem('teledrive_wake_lock') !== 'false';
  },

  async acquireWakeLock() {
    if (!this.isWakeLockEnabled) return;
    try {
      if ('wakeLock' in navigator && navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
        if (!this.wakeLock) {
          this.wakeLock = await navigator.wakeLock.request('screen');
          this.wakeLock.addEventListener('release', () => {
            this.wakeLock = null;
          });
          console.log('[Upload] Screen Wake Lock active (iPhone/Mobile display kept awake)');
        }
      } else {
        this._acquireVideoWakeLockFallback();
      }
    } catch (err) {
      console.warn('[Upload] Screen Wake Lock warning:', err.message);
      this._acquireVideoWakeLockFallback();
    }
  },

  _acquireVideoWakeLockFallback() {
    if (this._wakeLockFallbackVideo) return;
    try {
      const vid = document.createElement('video');
      vid.setAttribute('playsinline', '');
      vid.setAttribute('muted', '');
      vid.setAttribute('loop', '');
      vid.muted = true;
      vid.style.position = 'fixed';
      vid.style.top = '-9999px';
      vid.style.left = '-9999px';
      vid.style.width = '1px';
      vid.style.height = '1px';
      vid.style.opacity = '0';
      vid.style.pointerEvents = 'none';
      vid.src = 'data:video/webm;base64,GkXfo0AgQoaBAUL3gQFC8oEEQvOBCEKCQAR3ZWJtQoeBAkKFgQIYUkoAk4EBq1ZfVlA4U2VnbWVudGF0aW9uTXZpZXcAU2VnbWVudERhdGUK';
      document.body.appendChild(vid);
      vid.play().catch(() => {});
      this._wakeLockFallbackVideo = vid;
    } catch (e) {}
  },

  releaseWakeLock() {
    if (this.wakeLock) {
      try {
        this.wakeLock.release().catch(() => {});
      } catch (e) {}
      this.wakeLock = null;
      console.log('[Upload] Screen Wake Lock released');
    }
    if (this._wakeLockFallbackVideo) {
      try {
        this._wakeLockFallbackVideo.pause();
        this._wakeLockFallbackVideo.remove();
      } catch (e) {}
      this._wakeLockFallbackVideo = null;
    }
  },

  // Dynamic user-configurable chunk size (up to 1.9GB) & concurrency
  get CHUNK_SIZE() {
    const saved = localStorage.getItem('teledrive_chunk_size');
    const parsed = parseInt(saved, 10);
    return (!isNaN(parsed) && parsed > 0) ? parsed : 300 * 1024 * 1024;
  },

  get CONCURRENT_CHUNKS() {
    const saved = localStorage.getItem('teledrive_concurrent_chunks');
    const parsed = parseInt(saved, 10);
    return (!isNaN(parsed) && parsed >= 1) ? Math.min(parsed, 6) : 2;
  },

  // Folder creation caches for fast idempotent folder uploads
  _folderCache: new Map(),
  _folderPromiseCache: new Map(),

  /**
   * Deterministic Upload ID based on file metadata & relative path
   */
  getFileUploadId(file) {
    let hash = 0;
    const relPath = file.webkitRelativePath || file._relativePath || '';
    const str = `${file.name}_${file.size}_${file.lastModified}_${relPath}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    const safeHash = Math.abs(hash).toString(36);
    const sizeHex = file.size.toString(36);
    return `up_${safeHash}_${sizeHex}`;
  },

  /**
   * Resolve or create a single directory under a parent folder (deduplicated)
   */
  async getOrCreateFolder(name, parentId) {
    const trimmed = (name || '').trim();
    if (!trimmed) return parentId;

    const cacheKey = `${parentId || 'root'}::${trimmed}`;
    if (this._folderCache.has(cacheKey)) {
      return this._folderCache.get(cacheKey);
    }
    if (this._folderPromiseCache.has(cacheKey)) {
      return await this._folderPromiseCache.get(cacheKey);
    }

    const promise = (async () => {
      try {
        const res = await API.createFolder(trimmed, parentId);
        const folderId = res.id;
        this._folderCache.set(cacheKey, folderId);
        return folderId;
      } catch (err) {
        console.error(`[Upload] Failed to create folder "${trimmed}":`, err);
        return parentId;
      } finally {
        this._folderPromiseCache.delete(cacheKey);
      }
    })();

    this._folderPromiseCache.set(cacheKey, promise);
    return await promise;
  },

  /**
   * Recursively resolve nested folders for a relative file path
   * e.g. "my-project/sub1/sub2/file.txt" under baseFolderId
   */
  async resolveDestinationFolder(relativePath, baseFolderId) {
    if (!relativePath) return baseFolderId;
    const parts = relativePath.split(/[/\\]+/).filter(Boolean);
    // If only filename or empty, it belongs directly in baseFolderId
    if (parts.length <= 1) return baseFolderId;

    const dirSegments = parts.slice(0, -1);
    let currentParentId = baseFolderId || null;

    for (const segment of dirSegments) {
      currentParentId = await this.getOrCreateFolder(segment, currentParentId);
    }
    return currentParentId;
  },

  async addFiles(fileList, baseFolderId) {
    if (!fileList || fileList.length === 0) return;

    const fileArray = Array.from(fileList);
    const hasRelativePaths = fileArray.some(f => (f.webkitRelativePath || f._relativePath));
    if (hasRelativePaths && typeof UI !== 'undefined' && UI.showToast) {
      UI.showToast('Scanning folder structure & preparing upload...', 'info');
    }

    let addedCount = 0;
    for (const file of fileArray) {
      const relPath = file.webkitRelativePath || file._relativePath || '';
      let targetFolderId = baseFolderId;

      if (relPath) {
        try {
          targetFolderId = await this.resolveDestinationFolder(relPath, baseFolderId);
        } catch (e) {
          console.warn('[Upload] Folder resolution error for:', relPath, e);
        }
      }

      const uploadId = this.getFileUploadId(file);

      // Check if item already exists in queue
      const existing = this.queue.find(i => i.id === uploadId);
      if (existing) {
        if (existing.status === 'cancelled' || existing.status === 'error') {
          existing.status = 'pending';
          existing.error = null;
          existing.statusText = '';
          existing.folderId = targetFolderId;
        }
        continue;
      }

      this.queue.push({
        id: uploadId,
        file,
        folderId: targetFolderId,
        progress: 0,
        speedText: '',
        etaText: '',
        statusText: '',
        status: 'pending', // 'pending', 'uploading', 'done', 'error', 'cancelled'
        xhr: null,
        startTime: null,
        lastTime: null,
        lastLoaded: 0,
        currentSpeed: 0
      });
      addedCount++;
    }

    if (hasRelativePaths && typeof App !== 'undefined' && App.refreshCurrentView) {
      App.refreshCurrentView({ silent: true });
    }

    this.showUploadPanel();
    this.renderQueue();

    if (!this.isUploading) {
      this.processQueue();
    }
  },

  async processQueue() {
    const nextItem = this.queue.find(item => item.status === 'pending');
    if (!nextItem) {
      this.isUploading = false;
      this.releaseWakeLock();
      this.renderQueue();
      return;
    }

    this.isUploading = true;
    await this.acquireWakeLock();
    nextItem.status = 'uploading';
    nextItem.statusText = '';
    this.renderQueue();

    try {
      const uploadResult = await this.uploadFile(nextItem);
      if (nextItem.status === 'cancelled') {
        return;
      }
      nextItem.status = 'done';
      nextItem.progress = 100;
      nextItem.speedText = '';
      nextItem.etaText = '';
      nextItem.statusText = 'Completed';
      UI.showToast(`Uploaded "${nextItem.file.name}" to Telegram`, 'success');
      
      // Google Drive-style Instant Incremental Insertion (Zero full-page reload)
      if (uploadResult && uploadResult.file && typeof App !== 'undefined' && App.addUploadedFileLocally) {
        App.addUploadedFileLocally(uploadResult.file);
      } else if (typeof App !== 'undefined' && App.refreshCurrentView) {
        App.refreshCurrentView({ silent: true });
      }
    } catch (error) {
      if (nextItem.status === 'cancelled') {
        nextItem.speedText = '';
        nextItem.etaText = '';
      } else {
        nextItem.status = 'error';
        nextItem.error = error.message;
        nextItem.speedText = '';
        nextItem.etaText = '';
        UI.showToast(`Upload failed for "${nextItem.file.name}": ${error.message}`, 'error');
      }
    }

    this.renderQueue();
    this.isUploading = false;
    this.processQueue();
  },

  cancelUpload(itemId) {
    const item = this.queue.find(i => i.id === itemId);
    if (!item) return;

    item.status = 'cancelled';
    item.statusText = 'Cancelled';
    item.speedText = '';
    item.etaText = '';

    if (item.xhr) {
      try { item.xhr.abort(); } catch (e) {}
      item.xhr = null;
    }
    if (item.activeXHRs) {
      for (const x of item.activeXHRs) {
        try { x.abort(); } catch (e) {}
      }
      item.activeXHRs.clear();
    }

    if (typeof UI !== 'undefined' && UI.showToast) {
      UI.showToast(`Cancelled upload of "${item.file.name}"`, 'info');
    }

    this.renderQueue();

    // If no other item is uploading, continue queue processing
    if (!this.queue.some(i => i.status === 'uploading')) {
      this.isUploading = false;
      this.processQueue();
    }
  },

  retryUpload(itemId) {
    const item = this.queue.find(i => i.id === itemId);
    if (!item) return;

    item.status = 'pending';
    item.error = null;
    item.statusText = 'Resuming...';
    this.renderQueue();

    if (!this.isUploading) {
      this.processQueue();
    }
  },

  dismissItem(itemId) {
    const index = this.queue.findIndex(i => i.id === itemId);
    if (index !== -1) {
      const item = this.queue[index];
      if (item.status === 'uploading') {
        if (item.xhr) {
          try { item.xhr.abort(); } catch (e) {}
        }
        if (item.activeXHRs) {
          for (const x of item.activeXHRs) {
            try { x.abort(); } catch (e) {}
          }
          item.activeXHRs.clear();
        }
        this.isUploading = false;
      }
      this.queue.splice(index, 1);
      this.renderQueue();
      if (!this.isUploading) {
        this.processQueue();
      }
    }
  },

  formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '';
    if (bytesPerSec >= 1024 * 1024) {
      return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    }
    if (bytesPerSec >= 1024) {
      return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
    }
    return bytesPerSec.toFixed(0) + ' B/s';
  },

  formatETA(seconds) {
    if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
    if (seconds >= 3600) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return `ETA ${h}h ${m}m`;
    }
    if (seconds >= 60) {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `ETA ${m}m ${s}s`;
    }
    return `ETA ${Math.ceil(seconds)}s`;
  },

  formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const val = parseFloat((bytes / Math.pow(k, i)).toFixed(i >= 2 ? 2 : 1));
    return `${val} ${sizes[i]}`;
  },

  updateSpeedAndETA(item, overallLoaded, totalSize) {
    const now = performance.now();
    if (!item.startTime) {
      item.startTime = now;
      item.lastTime = now;
      item.lastLoaded = overallLoaded;
      return;
    }

    const timeDelta = (now - item.lastTime) / 1000;
    if (timeDelta >= 0.4) {
      const bytesDelta = overallLoaded - item.lastLoaded;
      const instantSpeed = bytesDelta > 0 ? (bytesDelta / timeDelta) : 0;
      item.currentSpeed = item.currentSpeed > 0 ? (0.7 * instantSpeed + 0.3 * item.currentSpeed) : instantSpeed;
      item.speedText = this.formatSpeed(item.currentSpeed);

      if (item.currentSpeed > 0) {
        const remainingBytes = Math.max(0, totalSize - overallLoaded);
        const remainingSec = remainingBytes / item.currentSpeed;
        item.etaText = this.formatETA(remainingSec);
      } else {
        item.etaText = '';
      }

      item.lastTime = now;
      item.lastLoaded = overallLoaded;
    }
  },

  async uploadFile(item) {
    const file = item.file;
    const totalSize = file.size;

    // Single-part upload for files <= CHUNK_SIZE
    if (totalSize <= this.CHUNK_SIZE) {
      return this.uploadSingleFile(item);
    }

    // Auto-chunking for files > CHUNK_SIZE
    const totalChunks = Math.ceil(totalSize / this.CHUNK_SIZE);
    const uploadId = item.id;
    item.totalParts = totalChunks;
    item.activeXHRs = new Set();

    // Check if session already exists on server for true resumability
    let uploadedIndices = [];
    try {
      const sessRes = await fetch(`/api/files/upload-session?uploadId=${encodeURIComponent(uploadId)}`, {
        headers: API.token ? { 'Authorization': `Bearer ${API.token}` } : {}
      });
      if (sessRes.ok) {
        const sessData = await sessRes.json();
        if (sessData.exists && Array.isArray(sessData.uploadedIndices)) {
          uploadedIndices = sessData.uploadedIndices;
          console.log(`[Upload] Resuming "${file.name}" - ${uploadedIndices.length}/${totalChunks} chunks already saved!`);
        }
      }
    } catch (e) {
      console.warn('[Upload] Could not check upload session:', e.message);
    }

    item.startTime = performance.now();
    item.lastTime = item.startTime;
    item.currentSpeed = 0;
    item.uploadedIndices = uploadedIndices;

    const pendingIndices = [];
    for (let i = 0; i < totalChunks; i++) {
      if (!uploadedIndices.includes(i)) {
        pendingIndices.push(i);
      }
    }

    if (pendingIndices.length === 0) {
      item.progress = 100;
      this.updateItemProgressUI(item, 100, 'Completed');
      return;
    }

    let nextIndexPtr = 0;
    const chunkLoadedMap = new Map();
    let finalResult = null;

    const uploadWorker = async (workerId) => {
      while (nextIndexPtr < pendingIndices.length) {
        if (item.status === 'cancelled') {
          throw new Error('Upload cancelled by user');
        }

        const chunkIndex = pendingIndices[nextIndexPtr++];
        const start = chunkIndex * this.CHUNK_SIZE;
        const end = Math.min(start + this.CHUNK_SIZE, totalSize);
        const chunkBlob = file.slice(start, end);

        const res = await this.uploadChunk(item, chunkBlob, uploadId, chunkIndex, totalChunks, start, end, totalSize, chunkLoadedMap);
        if (res && res.done) {
          finalResult = res;
        }
        uploadedIndices.push(chunkIndex);
        chunkLoadedMap.delete(chunkIndex);
      }
    };

    const workerPromises = [];
    const concurrency = Math.min(this.CONCURRENT_CHUNKS, pendingIndices.length);
    for (let w = 0; w < concurrency; w++) {
      workerPromises.push(uploadWorker(w));
    }

    try {
      await Promise.all(workerPromises);
    } catch (err) {
      if (item.activeXHRs) {
        for (const xhr of item.activeXHRs) {
          try { xhr.abort(); } catch (e) {}
        }
        item.activeXHRs.clear();
      }
      throw err;
    }
    return finalResult;
  },

  uploadSingleFile(item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr;
      item.startTime = performance.now();
      item.lastTime = item.startTime;

      const formData = new FormData();
      formData.append('file', item.file);
      if (item.folderId) {
        formData.append('folderId', item.folderId);
      }

      xhr.upload.onprogress = (e) => {
        if (item.status === 'cancelled') return;
        if (e.lengthComputable) {
          item.progress = Math.round((e.loaded / e.total) * 100);
          item.overallLoaded = e.loaded;
          this.updateSpeedAndETA(item, e.loaded, e.total);
          if (e.loaded >= e.total) {
            this.updateItemProgressUI(item, 100, '🔒 Encrypting & saving to Telegram...');
          } else {
            this.updateItemProgressUI(item);
          }
        }
      };

      xhr.onload = () => {
        item.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve(data);
          } catch (e) {
            resolve(xhr.responseText);
          }
        } else {
          try {
            const data = JSON.parse(xhr.responseText);
            reject(new Error(data.error || `Upload failed with status ${xhr.status}`));
          } catch (e) {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => {
        item.xhr = null;
        if (item.status === 'cancelled') {
          reject(new Error('Upload cancelled'));
        } else {
          reject(new Error('Network error during upload'));
        }
      };

      xhr.onabort = () => {
        item.xhr = null;
        reject(new Error('Upload cancelled'));
      };

      xhr.open('POST', '/api/files/upload', true);
      if (API.token) {
        xhr.setRequestHeader('Authorization', `Bearer ${API.token}`);
      }
      xhr.send(formData);
    });
  },

  uploadChunk(item, chunkBlob, uploadId, chunkIndex, totalChunks, start, end, totalSize, chunkLoadedMap) {
    return new Promise((resolve, reject) => {
      if (item.status === 'cancelled') {
        return reject(new Error('Upload cancelled'));
      }

      const xhr = new XMLHttpRequest();
      if (!item.activeXHRs) item.activeXHRs = new Set();
      item.activeXHRs.add(xhr);

      const formData = new FormData();
      formData.append('file', chunkBlob, item.file.name);
      formData.append('uploadId', uploadId);
      formData.append('chunkIndex', chunkIndex);
      formData.append('totalChunks', totalChunks);
      formData.append('fileName', item.file.name);
      formData.append('fileSize', totalSize);
      if (item.folderId) {
        formData.append('folderId', item.folderId);
      }

      xhr.upload.onprogress = (e) => {
        if (item.status === 'cancelled') return;
        if (e.lengthComputable) {
          if (chunkLoadedMap) {
            chunkLoadedMap.set(chunkIndex, e.loaded);
          }

          let overallLoaded = 0;
          if (item.uploadedIndices) {
            for (const idx of item.uploadedIndices) {
              const isLast = idx === totalChunks - 1;
              const chunkBytes = isLast ? (totalSize - (totalChunks - 1) * this.CHUNK_SIZE) : this.CHUNK_SIZE;
              overallLoaded += chunkBytes;
            }
          }
          if (chunkLoadedMap) {
            for (const b of chunkLoadedMap.values()) {
              overallLoaded += b;
            }
          }
          overallLoaded = Math.min(overallLoaded, totalSize);

          item.progress = Math.min(99, Math.round((overallLoaded / totalSize) * 100));
          item.overallLoaded = overallLoaded;
          this.updateSpeedAndETA(item, overallLoaded, totalSize);

          const activeCount = item.activeXHRs ? item.activeXHRs.size : 1;
          const completedCount = item.uploadedIndices ? item.uploadedIndices.length : 0;
          this.updateItemProgressUI(item, item.progress, `🚀 Uploading Part ${completedCount + 1}/${totalChunks} (${activeCount}x parallel)...`);
        }
      };

      xhr.onload = () => {
        if (item.activeXHRs) item.activeXHRs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve(data);
          } catch (e) {
            resolve(xhr.responseText);
          }
        } else {
          try {
            const data = JSON.parse(xhr.responseText);
            reject(new Error(data.error || `Chunk ${chunkIndex + 1} upload failed`));
          } catch (e) {
            reject(new Error(`Chunk upload failed with status ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => {
        if (item.activeXHRs) item.activeXHRs.delete(xhr);
        if (item.status === 'cancelled') {
          reject(new Error('Upload cancelled'));
        } else {
          reject(new Error(`Network error during chunk ${chunkIndex + 1} upload`));
        }
      };

      xhr.onabort = () => {
        if (item.activeXHRs) item.activeXHRs.delete(xhr);
        reject(new Error('Upload cancelled'));
      };

      xhr.open('POST', '/api/files/upload-chunk', true);
      if (API.token) {
        xhr.setRequestHeader('Authorization', `Bearer ${API.token}`);
      }
      xhr.send(formData);
    });
  },

  // ─── UI Panel ──────────────────────────────────────────────────────
  showUploadPanel() {
    const panel = document.getElementById('upload-panel');
    if (panel) panel.style.display = 'block';
    this.initPanelEvents();
  },

  initPanelEvents() {
    const body = document.getElementById('upload-panel-body');
    if (!body || this._panelEventsInitialized) return;
    this._panelEventsInitialized = true;

    body.addEventListener('click', (e) => {
      const btn = e.target.closest('.upload-action-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      if (!id) return;

      if (action === 'cancel') {
        this.cancelUpload(id);
      } else if (action === 'retry') {
        this.retryUpload(id);
      } else if (action === 'dismiss') {
        this.dismissItem(id);
      }
    });
  },

  renderQueue() {
    const body = document.getElementById('upload-panel-body');
    const title = document.getElementById('upload-panel-title');
    if (!body) return;

    const pendingCount = this.queue.filter(i => i.status === 'uploading' || i.status === 'pending').length;
    if (title) {
      title.textContent = pendingCount > 0 ? `Uploading ${pendingCount} item(s)...` : 'Uploads completed';
    }

    body.innerHTML = this.queue.map(item => {
      const safeName = item.file.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      let statusIcon = '⏳';
      if (item.status === 'uploading') statusIcon = '⬆️';
      if (item.status === 'done') statusIcon = '✅';
      if (item.status === 'error') statusIcon = '❌';
      if (item.status === 'cancelled') statusIcon = '🚫';

      const partText = item.totalParts && item.totalParts > 1 ? ` (Part ${item.currentPart || 1}/${item.totalParts})` : '';

      // Action buttons with data-action and data-id (clean event delegation)
      let actionBtn = '';
      if (item.status === 'uploading' || item.status === 'pending') {
        actionBtn = `<button class="upload-action-btn cancel" data-id="${item.id}" data-action="cancel" title="Cancel upload">✕</button>`;
      } else if (item.status === 'cancelled' || item.status === 'error') {
        actionBtn = `
          <button class="upload-action-btn retry" data-id="${item.id}" data-action="retry" title="Resume/Retry">🔄</button>
          <button class="upload-action-btn dismiss" data-id="${item.id}" data-action="dismiss" title="Dismiss">✕</button>
        `;
      } else {
        actionBtn = `<button class="upload-action-btn dismiss" data-id="${item.id}" data-action="dismiss" title="Dismiss">✕</button>`;
      }

      // Metrics string (speed, ETA)
      const metricsText = (item.speedText || item.etaText)
        ? `<span>${item.speedText}${item.speedText && item.etaText ? ' · ' : ''}${item.etaText}</span>`
        : `<span>${item.statusText || ''}</span>`;

      return `
        <div class="upload-item" id="item-${item.id}">
          <div class="upload-item-header">
            <span class="upload-item-name" title="${safeName}">${safeName}</span>
            <div class="upload-item-right">
              <span class="upload-item-status">${statusIcon}${partText} ${item.progress}%</span>
              ${actionBtn}
            </div>
          </div>
          <div class="upload-progress-bar">
            <div class="upload-progress-fill ${item.status}" style="width: ${item.progress}%;"></div>
          </div>
          <div class="upload-item-metrics">
            ${metricsText}
            <span>${(item.status === 'uploading' && item.overallLoaded && item.progress < 100)
              ? `${this.formatFileSize(item.overallLoaded)} / ${this.formatFileSize(item.file.size)}`
              : this.formatFileSize(item.file.size)}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  updateItemProgressUI(item, chunkPct, customText) {
    const el = document.getElementById(`item-${item.id}`);
    if (el) {
      const status = el.querySelector('.upload-item-status');
      const fill = el.querySelector('.upload-progress-fill');
      const metrics = el.querySelector('.upload-item-metrics');

      if (status) {
        if (customText) {
          status.textContent = `${customText} (${item.progress}%)`;
        } else if (item.totalParts && item.totalParts > 1) {
          status.textContent = `⬆️ Part ${item.currentPart || 1}/${item.totalParts} (${chunkPct || item.progress}%) · ${item.progress}%`;
        } else {
          status.textContent = `⬆️ ${item.progress}%`;
        }
      }

      if (fill) {
        fill.style.width = `${item.progress}%`;
      }

      if (metrics) {
        const metricsText = (item.speedText || item.etaText)
          ? `${item.speedText}${item.speedText && item.etaText ? ' · ' : ''}${item.etaText}`
          : (customText || item.statusText || '');
        const sizeText = (item.status === 'uploading' && item.overallLoaded && item.progress < 100)
          ? `${this.formatFileSize(item.overallLoaded)} / ${this.formatFileSize(item.file.size)}`
          : this.formatFileSize(item.file.size);
        metrics.innerHTML = `
          <span>${metricsText}</span>
          <span>${sizeText}</span>
        `;
      }
    }
  },

  /**
   * Recursively extract all files and directory structure from DataTransfer items
   */
  async extractFilesFromDataTransfer(dataTransfer) {
    const items = dataTransfer.items;
    if (!items || items.length === 0) {
      return Array.from(dataTransfer.files || []);
    }

    const readEntryRecursively = async (entry, path = '') => {
      if (entry.isFile) {
        return new Promise((resolve) => {
          entry.file((file) => {
            if (path) {
              file._relativePath = `${path}/${file.name}`;
            }
            resolve([file]);
          }, (err) => {
            console.warn('[Upload] Error reading file entry:', err);
            resolve([]);
          });
        });
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        const currentPath = path ? `${path}/${entry.name}` : entry.name;

        // Drain all directory entries (readEntries returns in batches)
        const entries = [];
        const readBatch = () => new Promise((resolve) => {
          dirReader.readEntries((batch) => {
            resolve(batch);
          }, (err) => {
            console.warn('[Upload] Error reading directory entries:', err);
            resolve([]);
          });
        });

        while (true) {
          const batch = await readBatch();
          if (!batch || batch.length === 0) break;
          entries.push(...batch);
        }

        const nestedFiles = await Promise.all(
          entries.map(child => readEntryRecursively(child, currentPath))
        );
        return nestedFiles.flat();
      }
      return [];
    };

    // Check if webkitGetAsEntry is available
    const hasWebkitEntry = Array.from(items).some(item => typeof item.webkitGetAsEntry === 'function');
    if (!hasWebkitEntry) {
      return Array.from(dataTransfer.files || []);
    }

    try {
      const fileArrays = await Promise.all(
        Array.from(items).map((item) => {
          const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
          if (!entry) {
            const f = item.getAsFile ? item.getAsFile() : null;
            return Promise.resolve(f ? [f] : []);
          }
          return readEntryRecursively(entry, '');
        })
      );
      return fileArrays.flat();
    } catch (err) {
      console.warn('[Upload] Fallback to standard files due to error reading entries:', err);
      return Array.from(dataTransfer.files || []);
    }
  },

  // ─── Drag & Drop for OS File & Folder Uploads ──────────────────────
  initDragDrop() {
    const dropZone = document.getElementById('drop-zone');
    const content = document.getElementById('content');
    if (!content) return;

    let dragCounter = 0;

    const isInternalDrag = (e) => {
      if (typeof App !== 'undefined' && App.draggedItem) return true;
      if (e.dataTransfer && e.dataTransfer.types) {
        if (Array.from(e.dataTransfer.types).includes('application/x-teledrive-item')) return true;
        if (!Array.from(e.dataTransfer.types).includes('Files')) return true;
      }
      return false;
    };

    window.addEventListener('dragenter', (e) => {
      if (isInternalDrag(e)) return;
      e.preventDefault();
      dragCounter++;
      if (dropZone) dropZone.style.display = 'flex';
    });

    window.addEventListener('dragleave', (e) => {
      if (isInternalDrag(e)) return;
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0 && dropZone) {
        dropZone.style.display = 'none';
        dragCounter = 0;
      }
    });

    window.addEventListener('dragover', (e) => {
      if (isInternalDrag(e)) return;
      e.preventDefault();
    });

    window.addEventListener('drop', async (e) => {
      if (isInternalDrag(e)) return;
      e.preventDefault();
      dragCounter = 0;
      if (dropZone) dropZone.style.display = 'none';

      if (e.dataTransfer) {
        const files = await this.extractFilesFromDataTransfer(e.dataTransfer);
        if (files && files.length > 0) {
          await this.addFiles(files, App.currentFolderId);
          if (typeof App !== 'undefined' && App.refreshCurrentView) {
            App.refreshCurrentView({ silent: true });
          }
        }
      }
    });

    // Panel minimize/close buttons
    const toggleBtn = document.getElementById('upload-panel-toggle');
    const closeBtn = document.getElementById('upload-panel-close');
    const panelBody = document.getElementById('upload-panel-body');
    const panel = document.getElementById('upload-panel');

    if (toggleBtn && panelBody) {
      toggleBtn.onclick = () => {
        panelBody.style.display = panelBody.style.display === 'none' ? 'block' : 'none';
        toggleBtn.textContent = panelBody.style.display === 'none' ? '▲' : '▼';
      };
    }
    if (closeBtn && panel) {
      closeBtn.onclick = () => {
        panel.style.display = 'none';
      };
    }

    this.initWakeLockListeners();
  },

  initWakeLockListeners() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && this.isUploading && this.isWakeLockEnabled) {
        await this.acquireWakeLock();
      }
    });
  }
};

if (typeof window !== 'undefined') {
  window.Upload = Upload;
}
