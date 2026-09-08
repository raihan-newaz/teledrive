/**
 * Upload Controller with Progress Tracking
 */
const Upload = {
  queue: [],
  isUploading: false,

  addFiles(fileList, folderId) {
    if (!fileList || fileList.length === 0) return;

    for (const file of fileList) {
      this.queue.push({
        id: 'up_' + Math.random().toString(36).substring(2, 9),
        file,
        folderId,
        progress: 0,
        status: 'pending' // 'pending', 'uploading', 'done', 'error'
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
      return;
    }

    this.isUploading = true;
    nextItem.status = 'uploading';
    this.renderQueue();

    try {
      await this.uploadFile(nextItem);
      nextItem.status = 'done';
      nextItem.progress = 100;
      UI.showToast(`Uploaded "${nextItem.file.name}" to Telegram`, 'success');
      App.refreshCurrentView();
    } catch (error) {
      nextItem.status = 'error';
      nextItem.error = error.message;
      UI.showToast(`Upload failed for "${nextItem.file.name}": ${error.message}`, 'error');
    }

    this.renderQueue();
    this.processQueue();
  },

  // 1.8GB threshold for Telegram bot upload limit
  CHUNK_SIZE: 1.8 * 1024 * 1024 * 1024,

  async uploadFile(item) {
    const file = item.file;
    const totalSize = file.size;

    // Single-part upload for files <= 1.8GB
    if (totalSize <= this.CHUNK_SIZE) {
      return this.uploadSingleFile(item);
    }

    // Automated chunk slicing for large files (> 1.8GB, e.g. 5GB, 10GB+)
    const totalChunks = Math.ceil(totalSize / this.CHUNK_SIZE);
    const uploadId = 'up_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
    item.totalParts = totalChunks;

    console.log(`[Upload] Slicing large file "${file.name}" (${(totalSize / (1024*1024*1024)).toFixed(2)} GB) into ${totalChunks} chunks...`);

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      item.currentPart = chunkIndex + 1;
      const start = chunkIndex * this.CHUNK_SIZE;
      const end = Math.min(start + this.CHUNK_SIZE, totalSize);
      const chunkBlob = file.slice(start, end);

      await this.uploadChunk(item, chunkBlob, uploadId, chunkIndex, totalChunks, start, end, totalSize);
    }
  },

  uploadSingleFile(item) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const formData = new FormData();
      formData.append('file', item.file);
      if (item.folderId) {
        formData.append('folderId', item.folderId);
      }

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          item.progress = Math.round((e.loaded / e.total) * 100);
          this.updateItemProgressUI(item);
        }
      };

      xhr.onload = () => {
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

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.open('POST', '/api/files/upload', true);

      if (API.token) {
        xhr.setRequestHeader('Authorization', `Bearer ${API.token}`);
      }

      xhr.send(formData);
    });
  },

  uploadChunk(item, chunkBlob, uploadId, chunkIndex, totalChunks, start, end, totalSize) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
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
        if (e.lengthComputable) {
          const overallLoaded = start + e.loaded;
          item.progress = Math.min(99, Math.round((overallLoaded / totalSize) * 100));
          const chunkPct = Math.round((e.loaded / e.total) * 100);
          this.updateItemProgressUI(item, chunkPct);
        }
      };

      xhr.onload = () => {
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

      xhr.onerror = () => reject(new Error(`Network error during chunk ${chunkIndex + 1} upload`));
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

      const partText = item.totalParts && item.totalParts > 1 ? ` (Part ${item.currentPart || 1}/${item.totalParts})` : '';

      return `
        <div class="upload-item" id="item-${item.id}">
          <div class="upload-item-header">
            <span class="upload-item-name" title="${safeName}">${safeName}</span>
            <span class="upload-item-status">${statusIcon}${partText} ${item.progress}%</span>
          </div>
          <div class="upload-progress-bar">
            <div class="upload-progress-fill ${item.status}" style="width: ${item.progress}%;"></div>
          </div>
        </div>
      `;
    }).join('');
  },

  updateItemProgressUI(item, chunkPct) {
    const el = document.getElementById(`item-${item.id}`);
    if (el) {
      const status = el.querySelector('.upload-item-status');
      const fill = el.querySelector('.upload-progress-fill');
      if (status) {
        if (item.totalParts && item.totalParts > 1) {
          status.textContent = `⬆️ Part ${item.currentPart || 1}/${item.totalParts} (${chunkPct || item.progress}%) · ${item.progress}%`;
        } else {
          status.textContent = `⬆️ ${item.progress}%`;
        }
      }
      if (fill) fill.style.width = `${item.progress}%`;
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
