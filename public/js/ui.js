/**
 * UI Utilities and DOM Renderers for TeleDrive
 */
const UI = {
  selectedItems: new Map(),

  // ─── Direct Background Download (No Blank Tabs) ────────────────────
  triggerDownload(url, filename) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.setAttribute('download', filename);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  },

  // ─── Toasts ────────────────────────────────────────────────────────
  showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#1a73e8"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
    if (type === 'success') {
      icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#34a853"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
    } else if (type === 'error') {
      icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#ea4335"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    } else if (type === 'warning') {
      icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#fbbc05"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
    }

    toast.innerHTML = `
      <span class="toast-icon" style="display:inline-flex; align-items:center;">${icon}</span>
      <span class="toast-msg">${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => toast.classList.add('visible'), 10);

    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  // ─── Modals ────────────────────────────────────────────────────────
  showModal(modalId) {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById(modalId);
    if (overlay && modal) {
      overlay.style.display = 'block';
      modal.style.display = (modal.classList.contains('settings-modal') || modal.classList.contains('share-modal')) ? 'flex' : 'block';
      modal.removeAttribute('inert');
      modal.removeAttribute('aria-hidden');
      modal.querySelectorAll('input, button, select, textarea').forEach(el => el.disabled = false);
      setTimeout(() => {
        overlay.classList.add('visible');
        modal.classList.add('visible');
      }, 10);
    }
  },

  hideModal(modalId) {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('visible');
      modal.setAttribute('inert', '');
      modal.setAttribute('aria-hidden', 'true');
      modal.querySelectorAll('input, button, select, textarea').forEach(el => {
        el.blur();
      });
      setTimeout(() => { 
        modal.style.display = 'none'; 
      }, 200);
    }
    if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.style.display = 'none'; }, 200);
    }
  },

  hideAllModals() {
    document.querySelectorAll('.modal').forEach(m => {
      m.classList.remove('visible');
      m.setAttribute('inert', '');
      m.setAttribute('aria-hidden', 'true');
      m.querySelectorAll('input, button, select, textarea').forEach(el => el.blur());
      setTimeout(() => { m.style.display = 'none'; }, 200);
    });
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.style.display = 'none'; }, 200);
    }
  },

  /**
   * Modern, Promise-based custom confirmation dialog with beautiful UI
   * @param {Object} options
   * @param {string} options.title - Header title
   * @param {string} options.message - Primary question / message
   * @param {string} [options.description] - Additional warning or details
   * @param {string} [options.icon='danger'] - 'danger' | 'trash' | 'warning' | 'info'
   * @param {string} [options.confirmText='Confirm'] - Action button text
   * @param {string} [options.cancelText='Cancel'] - Cancel button text
   * @param {string} [options.confirmType='danger'] - 'danger' | 'primary' | 'warning'
   * @returns {Promise<boolean>}
   */
  confirm({
    title = 'Are you sure?',
    message = 'Do you want to proceed?',
    description = '',
    icon = 'danger',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    confirmType = 'danger'
  } = {}) {
    return new Promise((resolve) => {
      const modal = document.getElementById('custom-confirm-modal');
      const titleEl = document.getElementById('confirm-modal-title');
      const msgEl = document.getElementById('confirm-modal-message');
      const descEl = document.getElementById('confirm-modal-description');
      const iconWrap = document.getElementById('confirm-icon-wrapper');
      const iconEl = document.getElementById('confirm-icon');
      const cancelBtn = document.getElementById('confirm-btn-cancel');
      const actionBtn = document.getElementById('confirm-btn-action');

      if (!modal || !titleEl || !msgEl || !actionBtn || !cancelBtn) {
        return resolve(window.confirm(`${title}\n\n${message}`));
      }

      titleEl.textContent = title;
      msgEl.textContent = message;

      if (description) {
        descEl.textContent = description;
        descEl.style.display = 'block';
        descEl.className = `confirm-subtext ${confirmType === 'danger' ? 'danger' : (confirmType === 'warning' ? 'warning' : '')}`;
      } else {
        descEl.style.display = 'none';
      }

      // Set icon style and SVG
      if (iconWrap) iconWrap.className = `confirm-icon-wrapper ${confirmType || icon}`;
      const icons = {
        danger: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
        trash: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M15 4V3H9v1H4v2h1v13c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9V8zm4 0h2v9h-2V8z"/></svg>`,
        warning: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
        info: `<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`
      };
      if (iconEl) iconEl.innerHTML = icons[icon] || icons.danger;

      // Button styling & text
      cancelBtn.textContent = cancelText;
      actionBtn.textContent = confirmText;
      actionBtn.className = `btn-${confirmType || 'danger'}`;

      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        this.hideModal('custom-confirm-modal');
        document.removeEventListener('keydown', onKeyDown);
      };

      const onConfirm = () => {
        cleanup();
        resolve(true);
      };

      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onConfirm();
        }
      };

      cancelBtn.onclick = onCancel;
      actionBtn.onclick = onConfirm;

      // Close on backdrop overlay click
      const overlay = document.getElementById('modal-overlay');
      if (overlay) {
        overlay.onclick = () => {
          if (modal.classList.contains('visible')) {
            onCancel();
          }
        };
      }

      document.addEventListener('keydown', onKeyDown);
      this.showModal('custom-confirm-modal');
      actionBtn.focus();
    });
  },

  // ─── Loading Skeletons ─────────────────────────────────────────────
  showSkeletons() {
    const sk = document.getElementById('skeleton-container');
    const fc = document.getElementById('file-container');
    const empty = document.getElementById('empty-state');
    if (sk) {
      const mode = (typeof App !== 'undefined' && App.viewMode) || localStorage.getItem('teledrive_view_mode') || 'grid';
      if (mode === 'list') {
        sk.className = 'skeleton-container list-view';
        sk.style.display = 'flex';
        sk.innerHTML = Array(8).fill(`
          <div class="skeleton-row">
            <div class="skeleton-icon skeleton-shimmer"></div>
            <div class="skeleton-text-group">
              <div class="skeleton-line skeleton-title skeleton-shimmer"></div>
              <div class="skeleton-line skeleton-sub skeleton-shimmer"></div>
            </div>
            <div class="skeleton-line skeleton-meta skeleton-shimmer"></div>
          </div>
        `).join('');
      } else {
        sk.className = 'skeleton-container grid-view';
        sk.style.display = 'grid';
        sk.innerHTML = Array(8).fill(`
          <div class="skeleton-card">
            <div class="skeleton-card-thumb skeleton-shimmer"></div>
            <div class="skeleton-card-body">
              <div class="skeleton-line skeleton-title skeleton-shimmer"></div>
              <div class="skeleton-line skeleton-sub skeleton-shimmer"></div>
            </div>
          </div>
        `).join('');
      }
    }
    if (fc) fc.style.display = 'none';
    if (empty) empty.style.display = 'none';
  },

  hideSkeletons() {
    const sk = document.getElementById('skeleton-container');
    if (sk) sk.style.display = 'none';
  },

  // ─── Selection Management ──────────────────────────────────────────
  toggleSelection(id, type, item, forceState) {
    const shouldSelect = forceState !== undefined ? forceState : !this.selectedItems.has(id);
    if (shouldSelect) {
      this.selectedItems.set(id, { id, type, item });
    } else {
      this.selectedItems.delete(id);
    }

    const card = document.querySelector(`[data-id="${id}"]`);
    if (card) {
      card.classList.toggle('selected', shouldSelect);
    }

    this.updateActionBar();
  },

  selectAll(itemsList) {
    if (!itemsList || itemsList.length === 0) return;
    itemsList.forEach(item => {
      const type = item.type || (item.mime_type ? 'file' : 'folder');
      this.selectedItems.set(item.id, { id: item.id, type, item });
      const card = document.querySelector(`[data-id="${item.id}"]`);
      if (card) card.classList.add('selected');
    });
    this.updateActionBar();
  },

  clearSelection() {
    this.selectedItems.clear();
    const actionBar = document.getElementById('action-bar');
    if (actionBar) actionBar.style.display = 'none';
    document.querySelectorAll('.file-card, .folder-card').forEach(c => c.classList.remove('selected'));
  },

  updateActionBar() {
    const actionBar = document.getElementById('action-bar');
    const selectedCount = document.getElementById('selected-count');
    if (!actionBar) return;

    const count = this.selectedItems.size;
    if (count === 0) {
      actionBar.style.display = 'none';
      return;
    }

    actionBar.style.display = 'flex';
    if (selectedCount) {
      selectedCount.textContent = `${count} selected`;
    }

    const isTrashView = typeof App !== 'undefined' && App.currentView === 'trash';
    const restoreBtn = document.getElementById('action-restore');
    const permDeleteBtn = document.getElementById('action-permanent-delete');
    const downloadBtn = document.getElementById('action-download');
    const moveBtn = document.getElementById('action-move');
    const starBtn = document.getElementById('action-star');
    const deleteBtn = document.getElementById('action-delete');

    if (isTrashView) {
      if (restoreBtn) restoreBtn.style.display = 'inline-flex';
      if (permDeleteBtn) permDeleteBtn.style.display = 'inline-flex';
      if (deleteBtn) deleteBtn.style.display = 'none';
      if (downloadBtn) downloadBtn.style.display = 'none';
      if (moveBtn) moveBtn.style.display = 'none';
      if (starBtn) starBtn.style.display = 'none';
    } else {
      if (restoreBtn) restoreBtn.style.display = 'none';
      if (permDeleteBtn) permDeleteBtn.style.display = 'none';
      if (deleteBtn) deleteBtn.style.display = 'inline-flex';
      if (moveBtn) moveBtn.style.display = 'inline-flex';

      const hasFiles = Array.from(this.selectedItems.values()).some(i => i.type === 'file');
      if (downloadBtn) downloadBtn.style.display = hasFiles ? 'inline-flex' : 'none';
      if (starBtn) starBtn.style.display = hasFiles ? 'inline-flex' : 'none';

      const shareBtn = document.getElementById('action-share');
      if (shareBtn) {
        const selectedFiles = Array.from(this.selectedItems.values()).filter(i => i.type === 'file');
        shareBtn.style.display = (!isTrashView && selectedFiles.length === 1) ? 'inline-flex' : 'none';
      }
    }
  },

  // ─── Formatters ────────────────────────────────────────────────────
  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(i >= 3 ? 2 : 1)) + ' ' + sizes[i];
  },

  formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  },

  formatFullDateTime(dateStr) {
    if (!dateStr) return 'N/A';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  },

  getFileTypeCategory(mimeType, fileName = '') {
    const mime = (mimeType || '').toLowerCase();
    const ext = (fileName || '').split('.').pop().toLowerCase();

    if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic'].includes(ext)) return 'image';
    if (mime.startsWith('video/') || ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', '3gp'].includes(ext)) return 'video';
    if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma'].includes(ext)) return 'audio';
    if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z') || mime.includes('tar') || mime.includes('gzip') || ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'archive';
    if (mime.includes('pdf') || ext === 'pdf') return 'document';
    return 'document';
  },

  getFileIconSvg(mimeType, fileName = '') {
    const cat = this.getFileTypeCategory(mimeType, fileName);
    if (cat === 'image') {
      return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#34A853"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
    }
    if (cat === 'video') {
      return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#EA4335"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`;
    }
    if (cat === 'audio') {
      return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#A142F4"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    }
    if (cat === 'archive') {
      return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#F9AB00"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10v-2h-4v2H8v-4h2v2h4v-2h2v4h-2z"/></svg>`;
    }
    if ((mimeType && mimeType.includes('pdf')) || (fileName && fileName.toLowerCase().endsWith('.pdf'))) {
      return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#EA4335"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v4zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#1A73E8"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
  },

  // ─── Render Card HTML (Clean & Robust, No broken inline JS) ───────
  renderFolderCard(folder) {
    const folderIdStr = String(folder.id);
    const safeName = folder.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const isSelected = this.selectedItems.has(folderIdStr) || this.selectedItems.has(folder.id);
    const selectedClass = isSelected ? ' selected' : '';
    const hasLock = Boolean(folder.is_locked);
    const isUnlocked = typeof App !== 'undefined' && App.unlockedFolders && App.unlockedFolders.has(folderIdStr);

    let lockBadge = '';
    let iconFill = '#5f6368';
    if (hasLock) {
      if (isUnlocked) {
        lockBadge = `<span class="folder-lock-badge unlocked" title="Unlocked Folder (Protected by Password)"><svg viewBox="0 0 24 24" width="12" height="12" fill="#34a853"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/></svg></span>`;
        iconFill = '#34a853';
      } else {
        lockBadge = `<span class="folder-lock-badge" title="Password Protected Folder (Locked)"><svg viewBox="0 0 24 24" width="12" height="12" fill="#ea4335"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg></span>`;
        iconFill = '#ea4335';
      }
    }

    return `
      <div class="folder-card${selectedClass}${hasLock ? ' is-locked' : ''}${isUnlocked ? ' is-unlocked' : ''}" data-id="${folderIdStr}" data-type="folder" data-locked="${hasLock ? '1' : '0'}" data-unlocked="${isUnlocked ? '1' : '0'}" draggable="true">
        <button class="card-select-btn icon-btn" title="Select folder" data-id="${folderIdStr}" data-type="folder" aria-label="Select">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </button>
        <div class="folder-icon-wrap">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="${iconFill}">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
          ${lockBadge}
        </div>
        <div class="folder-name" title="${safeName}">${safeName}</div>
        <button class="item-more-btn icon-btn" title="More options" data-id="${folderIdStr}" data-type="folder">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
      </div>
    `;
  },

  renderFileCard(file) {
    const fileIdStr = String(file.id);
    const safeName = file.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const isSelected = this.selectedItems.has(fileIdStr) || this.selectedItems.has(file.id);
    const selectedClass = isSelected ? ' selected' : '';
    const cat = this.getFileTypeCategory(file.mime_type);
    const icon = this.getFileIconSvg(file.mime_type);
    const size = this.formatFileSize(file.size);
    const date = this.formatDate(file.created_at);
    const starIcon = file.is_starred ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="#fbbc04" style="vertical-align: -2px;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>' : '';
    const downloadUrl = API.getDownloadUrl(file.id);
    const streamUrl = API.getStreamUrl(file.id);

    let previewHtml = '';
    if (cat === 'image') {
      const thumbUrl = API.getThumbnailUrl(file.id);
      previewHtml = `
        <div class="file-card-preview has-thumbnail">
          <div class="file-type-icon-lg fallback-icon">${icon}</div>
          <img src="${thumbUrl}" class="file-thumb-media" loading="lazy" alt="${safeName}" onerror="this.style.display='none'">
        </div>
      `;
    } else if (cat === 'video') {
      previewHtml = `
        <div class="file-card-preview has-thumbnail video-preview">
          <div class="file-type-icon-lg fallback-icon">${icon}</div>
          <img id="vthumb-${file.id}" class="file-thumb-media" loading="lazy" alt="${safeName}" style="display:none;" onerror="this.style.display='none'">
          <div class="video-play-badge">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
      `;
    } else {
      previewHtml = `
        <div class="file-card-preview">
          <div class="file-type-icon-lg">${icon}</div>
        </div>
      `;
    }

    return `
      <div class="file-card${selectedClass}" data-id="${fileIdStr}" data-type="file" draggable="true">
        <button class="card-select-btn icon-btn" title="Select file" data-id="${fileIdStr}" data-type="file" aria-label="Select">
          <svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </button>
        ${previewHtml}
        <div class="file-card-info">
          <div class="file-card-title-row">
            <span class="file-name" title="${safeName}">${safeName}</span>
            <span class="file-star">${starIcon}</span>
          </div>
          <div class="file-meta-row">
            <span class="file-size">${size}</span>
            <span class="file-date">${date}</span>
          </div>
        </div>
        <button class="item-more-btn icon-btn" title="More options" data-id="${fileIdStr}" data-type="file">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
      </div>
    `;
  },

  // ─── Breadcrumbs ───────────────────────────────────────────────────
  renderBreadcrumbs(breadcrumbs, currentFolder = null) {
    const container = document.getElementById('breadcrumb');
    if (!container) return;

    let relockBtnHtml = '';
    if (currentFolder && Boolean(currentFolder.is_locked)) {
      relockBtnHtml = ` <button type="button" class="btn-relock-folder" id="btn-header-relock" data-folder-id="${currentFolder.id}" title="Lock and exit this folder" style="display:inline-flex; align-items:center; gap:5px;"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg><span>Lock Folder</span></button>`;
    }

    container.innerHTML = breadcrumbs.map((b, idx) => {
      const isLast = idx === breadcrumbs.length - 1;
      const safeName = b.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (isLast) {
        return `<span class="breadcrumb-item active">${safeName}</span>${relockBtnHtml}`;
      }
      return `
        <a class="breadcrumb-item" href="#" data-folder-id="${b.id || ''}">${safeName}</a>
        <span class="breadcrumb-sep">›</span>
      `;
    }).join('');

    // Attach click listeners to breadcrumbs
    container.querySelectorAll('a.breadcrumb-item').forEach(link => {
      link.onclick = (e) => {
        e.preventDefault();
        const fid = link.getAttribute('data-folder-id') || null;
        App.navigateToFolder(fid);
      };
    });

    const relockBtn = container.querySelector('#btn-header-relock');
    if (relockBtn) {
      relockBtn.onclick = (e) => {
        e.preventDefault();
        const fid = relockBtn.getAttribute('data-folder-id');
        if (fid && typeof App !== 'undefined' && App.relockFolder) {
          App.relockFolder(fid);
        }
      };
    }
  },

  // ─── Folder Tree for Move Modal ────────────────────────────────────
  renderFolderTree(container, tree, onSelect) {
    let html = `
      <div class="tree-item active" data-folder-id="null">
        <span class="tree-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="var(--accent-color)" style="vertical-align:-2px; margin-right:6px;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
        <span class="tree-label">My Drive (Root)</span>
      </div>
    `;

    const renderNodes = (nodes, depth = 1) => {
      nodes.forEach(node => {
        const padding = depth * 18;
        const safeName = (node.name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        html += `
          <div class="tree-item" data-folder-id="${node.id}" style="padding-left: ${padding}px">
            <span class="tree-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="var(--accent-color)" style="vertical-align:-2px; margin-right:6px;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></span>
            <span class="tree-label">${safeName}</span>
          </div>
        `;
        if (node.children && node.children.length > 0) {
          renderNodes(node.children, depth + 1);
        }
      });
    };

    if (tree && tree.length > 0) {
      renderNodes(tree);
    }

    container.innerHTML = html;

    container.querySelectorAll('.tree-item').forEach(item => {
      item.onclick = () => {
        container.querySelectorAll('.tree-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        const rawId = item.getAttribute('data-folder-id');
        const folderId = rawId === 'null' ? null : rawId;
        if (onSelect) onSelect(folderId);
      };
    });

    if (onSelect) onSelect(null);
  },

  // ─── Show Context Menu ─────────────────────────────────────────────
  showContextMenu(event, item) {
    if (!item) return;
    App.selectedItem = item;

    const menu = document.getElementById('context-menu');
    if (!menu) return;

    const isTrashed = App.currentView === 'trash';
    const trashBtn = menu.querySelector('[data-action="trash"]');
    const restoreBtn = menu.querySelector('[data-action="restore"]');
    const permDeleteBtn = menu.querySelector('[data-action="permanent-delete"]');
    const downloadBtn = menu.querySelector('[data-action="download"]');
    const starBtn = menu.querySelector('[data-action="star"]');
    const shareBtn = menu.querySelector('[data-action="share"]');
    const infoBtn = menu.querySelector('[data-action="info"]');

    if (trashBtn) trashBtn.style.display = isTrashed ? 'none' : 'flex';
    if (restoreBtn) restoreBtn.style.display = isTrashed ? 'flex' : 'none';
    if (permDeleteBtn) permDeleteBtn.style.display = isTrashed ? 'flex' : 'none';
    if (downloadBtn) downloadBtn.style.display = item.type === 'file' ? 'flex' : 'none';
    if (starBtn) starBtn.style.display = item.type === 'file' ? 'flex' : 'none';
    const lockFolderBtn = menu.querySelector('[data-action="lock-folder"]');
    const lockFolderText = document.getElementById('ctx-lock-folder-text');
    const relockFolderBtn = menu.querySelector('[data-action="relock-folder"]');
    if (lockFolderBtn) {
      if (!isTrashed && item.type === 'folder') {
        const isProtected = Boolean(item.is_locked);
        const isUnlocked = typeof App !== 'undefined' && App.unlockedFolders && App.unlockedFolders.has(String(item.id));

        if (isProtected) {
          if (isUnlocked) {
            if (relockFolderBtn) relockFolderBtn.style.display = 'flex';
            lockFolderBtn.style.display = 'flex';
            if (lockFolderText) lockFolderText.textContent = 'Manage / Remove Password';
          } else {
            if (relockFolderBtn) relockFolderBtn.style.display = 'none';
            lockFolderBtn.style.display = 'flex';
            if (lockFolderText) lockFolderText.textContent = 'Unlock Folder';
          }
        } else {
          if (relockFolderBtn) relockFolderBtn.style.display = 'none';
          lockFolderBtn.style.display = 'flex';
          if (lockFolderText) lockFolderText.textContent = 'Lock Folder (Set Password)';
        }
      } else {
        lockFolderBtn.style.display = 'none';
        if (relockFolderBtn) relockFolderBtn.style.display = 'none';
      }
    }

    menu.style.display = 'block';
    const x = Math.min(event.pageX, window.innerWidth - 220);
    const y = Math.min(event.pageY, window.innerHeight - 250);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  },

  // ─── Generate Real Video Thumbnails via Canvas (Lazy & Concurrency-Throttled) ───
  _videoObserver: null,
  _thumbnailQueue: [],
  _activeThumbnailWorkers: 0,
  _MAX_THUMBNAIL_WORKERS: 4,

  _processThumbnailQueue() {
    while (this._activeThumbnailWorkers < this._MAX_THUMBNAIL_WORKERS && this._thumbnailQueue.length > 0) {
      const task = this._thumbnailQueue.shift();
      this._activeThumbnailWorkers++;

      const { file, imgEl } = task;
      if (!imgEl || !document.body.contains(imgEl) || (imgEl.style.display === 'block' && imgEl.src && imgEl.src.startsWith('data:image'))) {
        this._activeThumbnailWorkers--;
        continue;
      }

      const cached = sessionStorage.getItem(`vthumb_${file.id}`);
      if (cached && typeof cached === 'string' && cached.startsWith('data:image') && cached.length > 500) {
        imgEl.src = cached;
        imgEl.style.display = 'block';
        this._activeThumbnailWorkers--;
        continue;
      }

      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.src = API.getStreamUrl(file.id);

      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        try {
          video.removeAttribute('src');
          video.load();
          video.remove();
        } catch (e) {}
        this._activeThumbnailWorkers--;
        this._processThumbnailQueue();
      };

      const timeoutId = setTimeout(done, 7000); // 7s fast fallback timeout

      const captureFrame = () => {
        if (finished) return false;
        try {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(240, video.videoWidth || 240);
            canvas.height = Math.min(135, video.videoHeight || 135);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            let dataUrl;
            try {
              dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            } catch (e) {
              dataUrl = null;
            }
            
            if (dataUrl && dataUrl.length > 500) {
              if (imgEl && document.body.contains(imgEl)) {
                imgEl.src = dataUrl;
                imgEl.style.display = 'block';
              }
              try {
                sessionStorage.setItem(`vthumb_${file.id}`, dataUrl);
              } catch(e) {}
              clearTimeout(timeoutId);
              done();
              return true;
            }
          }
        } catch (e) {}
        return false;
      };

      video.onloadedmetadata = () => {
        try {
          video.currentTime = Math.min(0.2, (video.duration || 1) / 2);
        } catch (e) {}
      };

      video.onloadeddata = () => {
        if (!captureFrame()) {
          try { video.currentTime = 0.1; } catch (e) { done(); }
        }
      };

      video.onseeked = () => {
        captureFrame();
        done();
      };

      video.onerror = () => {
        clearTimeout(timeoutId);
        done();
      };
    }
  },

  generateVideoThumbnailFromBlob(blob, fileId, imgEl) {
    if (!blob || !imgEl) return;
    try {
      const blobUrl = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = blobUrl;

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        try {
          URL.revokeObjectURL(blobUrl);
          video.removeAttribute('src');
          video.load();
          video.remove();
        } catch (e) {}
      };

      const capture = () => {
        if (cleaned) return false;
        try {
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(240, video.videoWidth || 240);
            canvas.height = Math.min(135, video.videoHeight || 135);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            let dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            if (dataUrl && dataUrl.length > 500) {
              if (imgEl && document.body.contains(imgEl)) {
                imgEl.src = dataUrl;
                imgEl.style.display = 'block';
              }
              try { sessionStorage.setItem(`vthumb_${fileId}`, dataUrl); } catch(e) {}
              cleanup();
              return true;
            }
          }
        } catch (e) {}
        return false;
      };

      video.onloadeddata = () => {
        if (!capture()) {
          try { video.currentTime = 0.05; } catch (e) { cleanup(); }
        }
      };

      video.onseeked = () => {
        capture();
        cleanup();
      };

      video.onerror = () => cleanup();
      setTimeout(cleanup, 5000);
    } catch (e) {}
  },

  loadVideoThumbnails(files) {
    if (!files || files.length === 0) return;
    const videoFiles = files.filter(f => this.getFileTypeCategory(f.mime_type) === 'video');
    if (videoFiles.length === 0) return;

    if (!this._videoObserver && window.IntersectionObserver) {
      this._videoObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const el = entry.target;
            this._videoObserver.unobserve(el);
            const fileId = el.getAttribute('data-vid');
            const file = (App && App.filesMap) ? App.filesMap.get(String(fileId)) : null;
            if (file) {
              this._thumbnailQueue.push({ file, imgEl: el });
              this._processThumbnailQueue();
            }
          }
        });
      }, { rootMargin: '200px' });
    }

    videoFiles.forEach(file => {
      const imgEl = document.getElementById(`vthumb-${file.id}`);
      if (!imgEl) return;

      const cached = sessionStorage.getItem(`vthumb_${file.id}`);
      if (cached && typeof cached === 'string' && cached.startsWith('data:image') && cached.length > 500) {
        imgEl.src = cached;
        imgEl.style.display = 'block';
        return;
      }

      // Check if local Blob exists for instant client-side thumbnail creation
      const localBlob = file.localBlob || (typeof App !== 'undefined' && App.filesMap && App.filesMap.get(String(file.id)) && App.filesMap.get(String(file.id)).localBlob);
      if (localBlob) {
        this.generateVideoThumbnailFromBlob(localBlob, file.id, imgEl);
        return;
      }

      imgEl.setAttribute('data-vid', String(file.id));
      if (this._videoObserver) {
        this._videoObserver.observe(imgEl);
      } else {
        this._thumbnailQueue.push({ file, imgEl });
        this._processThumbnailQueue();
      }
    });
  },

  async copyToClipboard(text, fallbackInputEl = null) {
    if (!text && fallbackInputEl && fallbackInputEl.value) {
      text = fallbackInputEl.value;
    }
    if (!text) return false;

    // 1. Try modern Clipboard API if available and permitted
    if (navigator.clipboard && navigator.clipboard.writeText && (window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        console.warn('navigator.clipboard.writeText failed, falling back to execCommand:', err);
      }
    }

    // 2. Fallback: input element selection or temporary offscreen textarea
    try {
      if (fallbackInputEl && typeof fallbackInputEl.select === 'function') {
        fallbackInputEl.focus();
        fallbackInputEl.select();
        if (fallbackInputEl.setSelectionRange) {
          fallbackInputEl.setSelectionRange(0, 99999);
        }
        const success = document.execCommand('copy');
        if (success) return true;
      }

      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.top = '-9999px';
      textArea.style.left = '-9999px';
      textArea.style.opacity = '0';
      textArea.setAttribute('readonly', '');
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      if (textArea.setSelectionRange) {
        textArea.setSelectionRange(0, 99999);
      }
      const success = document.execCommand('copy');
      document.body.removeChild(textArea);
      return !!success;
    } catch (err) {
      console.error('Clipboard copy fallback failed:', err);
      return false;
    }
  }
};
