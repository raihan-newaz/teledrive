/**
 * Upload Controller with Progress Tracking, True Resumability, Speed & ETA, and Cancel Controls
 */
const Upload = {
  queue: [],
  isUploading: false,

  // 500MB chunk threshold & size — optimal balance: minimum Telegram parts, fast streaming, zero overhead, and instant resume
  CHUNK_SIZE: 500 * 1024 * 1024,

  /**
   * Deterministic Upload ID based on file metadata
   */
  getFileUploadId(file) {
    let hash = 0;
    const str = `${file.name}_${file.size}_${file.lastModified}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    const safeHash = Math.abs(hash).toString(36);
    const sizeHex = file.size.toString(36);
    return `up_${safeHash}_${sizeHex}`;
  },

  addFiles(fileList, folderId) {
    if (!fileList || fileList.length === 0) return;

    for (const file of fileList) {
      const uploadId = this.getFileUploadId(file);

      // Check if item already exists in queue
      const existing = this.queue.find(i => i.id === uploadId);
      if (existing) {
        if (existing.status === 'cancelled' || existing.status === 'error') {
          existing.status = 'pending';
          existing.error = null;
          existing.statusText = '';
        }
        continue;
      }

      this.queue.push({
        id: uploadId,
        file,
        folderId,
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
      this.renderQueue();
      return;
    }

    this.isUploading = true;
    nextItem.status = 'uploading';
    nextItem.statusText = '';
    this.renderQueue();

    try {
      await this.uploadFile(nextItem);
      if (nextItem.status === 'cancelled') {
        return;
      }
      nextItem.status = 'done';
      nextItem.progress = 100;
      nextItem.speedText = '';
      nextItem.etaText = '';
      nextItem.statusText = 'Completed';
      UI.showToast(`Uploaded "${nextItem.file.name}" to Telegram`, 'success');
      App.refreshCurrentView();
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

    if (item.status === 'uploading') {
      item.status = 'cancelled';
      item.statusText = 'Cancelled';
      item.speedText = '';
      item.etaText = '';
      if (item.xhr) {
        try { item.xhr.abort(); } catch (e) {}
        item.xhr = null;
      }
      UI.showToast(`Cancelled upload of "${item.file.name}"`, 'info');
      this.isUploading = false;
      this.renderQueue();
      this.processQueue();
    } else if (item.status === 'pending') {
      item.status = 'cancelled';
      item.statusText = 'Cancelled';
      this.renderQueue();
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
      if (item.status === 'uploading' && item.xhr) {
        try { item.xhr.abort(); } catch (e) {}
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

    // Single-part upload for files <= 500MB
    if (totalSize <= this.CHUNK_SIZE) {
      return this.uploadSingleFile(item);
    }

    // Auto-chunking for files > 500MB
    const totalChunks = Math.ceil(totalSize / this.CHUNK_SIZE);
    const uploadId = item.id;
    item.totalParts = totalChunks;

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

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      if (item.status === 'cancelled') {
        throw new Error('Upload cancelled by user');
      }

      item.currentPart = chunkIndex + 1;
      const start = chunkIndex * this.CHUNK_SIZE;
      const end = Math.min(start + this.CHUNK_SIZE, totalSize);

      // If chunk is already saved on server/Telegram, skip sending it!
      if (uploadedIndices.includes(chunkIndex)) {
        item.progress = Math.min(99, Math.round((end / totalSize) * 100));
        this.updateItemProgressUI(item, 100, `⚡ Resumed Part ${chunkIndex + 1}/${totalChunks}`);
        continue;
      }

      const chunkBlob = file.slice(start, end);
      await this.uploadChunk(item, chunkBlob, uploadId, chunkIndex, totalChunks, start, end, totalSize);
    }
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

  uploadChunk(item, chunkBlob, uploadId, chunkIndex, totalChunks, start, end, totalSize) {
    return new Promise((resolve, reject) => {
      if (item.status === 'cancelled') {
        return reject(new Error('Upload cancelled'));
      }

      const xhr = new XMLHttpRequest();
      item.xhr = xhr;

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
          const overallLoaded = start + e.loaded;
          item.progress = Math.min(99, Math.round((overallLoaded / totalSize) * 100));
          item.overallLoaded = overallLoaded;
          const chunkPct = Math.round((e.loaded / e.total) * 100);
          this.updateSpeedAndETA(item, overallLoaded, totalSize);

          if (chunkPct >= 100) {
            this.updateItemProgressUI(item, chunkPct, `🔒 Saving Part ${chunkIndex + 1}/${totalChunks} to Telegram...`);
          } else {
            this.updateItemProgressUI(item, chunkPct);
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
            reject(new Error(data.error || `Chunk ${chunkIndex + 1} upload failed`));
          } catch (e) {
            reject(new Error(`Chunk upload failed with status ${xhr.status}`));
          }
        }
      };

      xhr.onerror = () => {
        item.xhr = null;
        if (item.status === 'cancelled') {
          reject(new Error('Upload cancelled'));
        } else {
          reject(new Error(`Network error during chunk ${chunkIndex + 1} upload`));
        }
      };

      xhr.onabort = () => {
        item.xhr = null;
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

      // Action buttons
      let actionBtn = '';
      if (item.status === 'uploading' || item.status === 'pending') {
        actionBtn = `<button class="upload-action-btn cancel" onclick="Upload.cancelUpload('${item.id}')" title="Cancel upload">✕</button>`;
      } else if (item.status === 'cancelled' || item.status === 'error') {
        actionBtn = `
          <button class="upload-action-btn retry" onclick="Upload.retryUpload('${item.id}')" title="Resume/Retry">🔄</button>
          <button class="upload-action-btn" onclick="Upload.dismissItem('${item.id}')" title="Dismiss">✕</button>
        `;
      } else {
        actionBtn = `<button class="upload-action-btn" onclick="Upload.dismissItem('${item.id}')" title="Dismiss">✕</button>`;
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

  // ─── Drag & Drop for OS File Uploads ───────────────────────────────
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

    window.addEventListener('drop', (e) => {
      if (isInternalDrag(e)) return;
      e.preventDefault();
      dragCounter = 0;
      if (dropZone) dropZone.style.display = 'none';

      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        Upload.addFiles(Array.from(e.dataTransfer.files), App.currentFolderId);
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
  }
};
