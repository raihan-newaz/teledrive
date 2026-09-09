/**
 * UI Utilities and DOM Renderers for TeleDrive
 */
const UI = {
  selectedItems: new Set(),

  // ─── Toasts ────────────────────────────────────────────────────────
  showToast(message, type = 'info', duration = 3500) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';
    if (type === 'warning') icon = '⚠️';

    toast.innerHTML = `
      <span class="toast-icon">${icon}</span>
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
      modal.style.display = 'block';
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
      setTimeout(() => { modal.style.display = 'none'; }, 200);
    }
    if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.style.display = 'none'; }, 200);
    }
  },

  hideAllModals() {
    document.querySelectorAll('.modal').forEach(m => {
      m.classList.remove('visible');
      setTimeout(() => { m.style.display = 'none'; }, 200);
    });
    const overlay = document.getElementById('modal-overlay');
    if (overlay) {
      overlay.classList.remove('visible');
      setTimeout(() => { overlay.style.display = 'none'; }, 200);
    }
  },

  // ─── Loading Skeletons ─────────────────────────────────────────────
  showSkeletons() {
    const sk = document.getElementById('skeleton-container');
    if (sk) sk.style.display = 'grid';
  },

  hideSkeletons() {
    const sk = document.getElementById('skeleton-container');
    if (sk) sk.style.display = 'none';
  },

  // ─── Selection ─────────────────────────────────────────────────────
  clearSelection() {
    this.selectedItems.clear();
    const actionBar = document.getElementById('action-bar');
    if (actionBar) actionBar.style.display = 'none';
    document.querySelectorAll('.file-card, .folder-card').forEach(c => c.classList.remove('selected'));
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

  getFileTypeCategory(mimeType) {
    if (!mimeType) return 'document';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.includes('pdf') || mimeType.includes('word') || mimeType.includes('text') || mimeType.includes('sheet')) return 'document';
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('7z') || mimeType.includes('tar') || mimeType.includes('gzip')) return 'archive';
    return 'document';
  },

  getFileIconSvg(mimeType) {
    const cat = this.getFileTypeCategory(mimeType);
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
    if (mimeType && mimeType.includes('pdf')) {
      return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#EA4335"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v4zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5z"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="28" height="28" fill="#1A73E8"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
  },

  // ─── Render Card HTML (Clean & Robust, No broken inline JS) ───────
  renderFolderCard(folder) {
    const safeName = folder.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <div class="folder-card" data-id="${folder.id}" data-type="folder" draggable="true">
        <div class="folder-icon-wrap">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="#5f6368">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
        </div>
        <div class="folder-name" title="${safeName}">${safeName}</div>
        <button class="item-more-btn icon-btn" title="More options" data-id="${folder.id}" data-type="folder">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
      </div>
    `;
  },

  renderFileCard(file) {
    const safeName = file.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cat = this.getFileTypeCategory(file.mime_type);
    const icon = this.getFileIconSvg(file.mime_type);
    const size = this.formatFileSize(file.size);
    const date = this.formatDate(file.created_at);
    const starIcon = file.is_starred ? '⭐' : '';
    const downloadUrl = API.getDownloadUrl(file.id);
    const streamUrl = API.getStreamUrl(file.id);

    let previewHtml = '';
    if (cat === 'image') {
      const thumbUrl = API.getThumbnailUrl(file.id);
      previewHtml = `
        <div class="file-card-preview has-thumbnail">
          <div class="file-type-icon-lg fallback-icon">${icon}</div>
          <img src="${thumbUrl}" class="file-thumb-media" loading="lazy" alt="${safeName}">
        </div>
      `;
    } else if (cat === 'video') {
      previewHtml = `
        <div class="file-card-preview has-thumbnail video-preview">
          <div class="file-type-icon-lg fallback-icon">${icon}</div>
          <img id="vthumb-${file.id}" class="file-thumb-media" loading="lazy" alt="${safeName}">
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
      <div class="file-card" data-id="${file.id}" data-type="file" draggable="true">
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
        <button class="item-more-btn icon-btn" title="More options" data-id="${file.id}" data-type="file">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
        </button>
      </div>
    `;
  },

  // ─── Breadcrumbs ───────────────────────────────────────────────────
  renderBreadcrumbs(breadcrumbs) {
    const container = document.getElementById('breadcrumb');
    if (!container) return;

    container.innerHTML = breadcrumbs.map((b, idx) => {
      const isLast = idx === breadcrumbs.length - 1;
      const safeName = b.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (isLast) {
        return `<span class="breadcrumb-item active">${safeName}</span>`;
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
  },

  // ─── Folder Tree for Move Modal ────────────────────────────────────
  renderFolderTree(container, tree, onSelect) {
    let html = `
      <div class="tree-item active" data-folder-id="null">
        <span class="tree-icon">📁</span>
        <span class="tree-label">My Drive (Root)</span>
      </div>
    `;

    const renderNodes = (nodes, depth = 1) => {
      nodes.forEach(node => {
        const padding = depth * 18;
        html += `
          <div class="tree-item" data-folder-id="${node.id}" style="padding-left: ${padding}px">
            <span class="tree-icon">📁</span>
            <span class="tree-label">${node.name}</span>
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
    const infoBtn = menu.querySelector('[data-action="info"]');

    if (trashBtn) trashBtn.style.display = isTrashed ? 'none' : 'flex';
    if (restoreBtn) restoreBtn.style.display = isTrashed ? 'flex' : 'none';
    if (permDeleteBtn) permDeleteBtn.style.display = isTrashed ? 'flex' : 'none';
    if (downloadBtn) downloadBtn.style.display = item.type === 'file' ? 'flex' : 'none';
    if (starBtn) starBtn.style.display = item.type === 'file' ? 'flex' : 'none';
    if (infoBtn) infoBtn.style.display = 'flex';

    menu.style.display = 'block';
    const x = Math.min(event.pageX, window.innerWidth - 220);
    const y = Math.min(event.pageY, window.innerHeight - 250);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  },

  // ─── Generate Real Video Thumbnails via Canvas ─────────────────────
  loadVideoThumbnails(files) {
    if (!files || files.length === 0) return;
    const videoFiles = files.filter(f => this.getFileTypeCategory(f.mime_type) === 'video');

    videoFiles.forEach(file => {
      const imgEl = document.getElementById(`vthumb-${file.id}`);
      if (!imgEl) return;

      const cached = sessionStorage.getItem(`vthumb_${file.id}`);
      if (cached) {
        imgEl.src = cached;
        imgEl.classList.add('loaded');
        return;
      }

      // Generate video thumbnail on the fly
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.src = API.getStreamUrl(file.id);

      video.onloadedmetadata = () => {
        video.currentTime = Math.min(1.5, (video.duration || 2) * 0.1);
      };

      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = Math.min(480, video.videoWidth || 320);
          canvas.height = Math.min(270, video.videoHeight || 180);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          
          if (imgEl) {
            imgEl.src = dataUrl;
            imgEl.classList.add('loaded');
          }
          try {
            sessionStorage.setItem(`vthumb_${file.id}`, dataUrl);
          } catch(e) {}
        } catch(e) {
          // Canvas error fallback
        } finally {
          video.removeAttribute('src');
          video.load();
          video.remove();
        }
      };

      video.onerror = () => {
        video.remove();
      };
    });
  }
};
