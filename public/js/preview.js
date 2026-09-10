/**
 * YouTube-Style Media Player & Comprehensive Document Viewer for TeleDrive
 */
const Preview = {
  currentFile: null,
  zoomLevel: 1,
  rotationAngle: 0,
  controlsTimeout: null,
  navTimeout: null,
  _activeListeners: [],

  _addListener(target, type, handler) {
    if (!target) return;
    target.addEventListener(type, handler);
    this._activeListeners.push({ target, type, handler });
  },

  _clearListeners() {
    for (const { target, type, handler } of this._activeListeners) {
      try { target.removeEventListener(type, handler); } catch (e) {}
    }
    this._activeListeners = [];
  },

  getNavFiles() {
    const files = (typeof App !== 'undefined' && App.getVisibleFiles) ? App.getVisibleFiles() : ((typeof App !== 'undefined' && App.files) ? App.files : []);
    if (!this.currentFile || !files.length) return { prev: null, next: null };
    const currentId = String(this.currentFile.id);
    const idx = files.findIndex(f => String(f.id) === currentId);
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: idx > 0 ? files[idx - 1] : null,
      next: idx < files.length - 1 ? files[idx + 1] : null
    };
  },

  navigate(direction) {
    const { prev, next } = this.getNavFiles();
    const targetFile = direction === 'prev' ? prev : next;
    if (targetFile) {
      this.open(targetFile);
    }
  },

  updateNavButtons() {
    const prevBtn = document.getElementById('preview-nav-prev');
    const nextBtn = document.getElementById('preview-nav-next');
    const { prev, next } = this.getNavFiles();

    if (prevBtn) {
      if (prev) {
        prevBtn.style.display = 'flex';
        prevBtn.title = `Previous: ${prev.name} (Left Arrow)`;
        prevBtn.onclick = (e) => {
          e.stopPropagation();
          this.navigate('prev');
        };
      } else {
        prevBtn.style.display = 'none';
        prevBtn.onclick = null;
      }
    }

    if (nextBtn) {
      if (next) {
        nextBtn.style.display = 'flex';
        nextBtn.title = `Next: ${next.name} (Right Arrow)`;
        nextBtn.onclick = (e) => {
          e.stopPropagation();
          this.navigate('next');
        };
      } else {
        nextBtn.style.display = 'none';
        nextBtn.onclick = null;
      }
    }
  },

  open(file) {
    if (!file || file.type === 'folder') return;
    this.currentFile = file;
    this.zoomLevel = 1;
    this.rotationAngle = 0;

    const overlay = document.getElementById('preview-overlay');
    const filenameEl = document.getElementById('preview-filename');
    const contentEl = document.getElementById('preview-content');
    const downloadBtn = document.getElementById('preview-download');
    const openTabBtn = document.getElementById('preview-open-tab');
    const shareBtn = document.getElementById('preview-share');
    const closeBtn = document.getElementById('preview-close');

    if (!overlay || !contentEl) return;

    overlay.style.display = 'flex';

    // Google Drive style prev/next update & auto-hide
    this.updateNavButtons();
    const prevBtn = document.getElementById('preview-nav-prev');
    const nextBtn = document.getElementById('preview-nav-next');
    
    const showNavButtons = () => {
      if (prevBtn) prevBtn.classList.remove('preview-nav-hidden');
      if (nextBtn) nextBtn.classList.remove('preview-nav-hidden');
      clearTimeout(this.navTimeout);
      this.navTimeout = setTimeout(() => {
        if (prevBtn && !prevBtn.matches(':hover')) prevBtn.classList.add('preview-nav-hidden');
        if (nextBtn && !nextBtn.matches(':hover')) nextBtn.classList.add('preview-nav-hidden');
      }, 2500);
    };

    this._addListener(overlay, 'mousemove', showNavButtons);
    this._addListener(overlay, 'touchstart', showNavButtons);
    showNavButtons();

    const streamUrl = API.getStreamUrl(file.id);
    const downloadUrl = API.getDownloadUrl(file.id);

    if (filenameEl) {
      filenameEl.textContent = file.name;
    }
    if (openTabBtn) {
      openTabBtn.onclick = () => window.open(streamUrl, '_blank');
    }
    if (shareBtn) {
      shareBtn.onclick = () => {
        if (typeof App !== 'undefined' && App.openShareModal) {
          App.openShareModal(file);
        }
      };
    }
    if (downloadBtn) {
      downloadBtn.onclick = () => UI.triggerDownload(downloadUrl, file.name);
    }
    if (closeBtn) {
      closeBtn.onclick = () => this.close();
    }

    const mime = file.mime_type || '';
    const cat = UI.getFileTypeCategory(mime);

    // ─── 1. VIDEO: Custom YouTube-Style Player ─────────────────────────
    if (cat === 'video') {
      contentEl.innerHTML = `
        <div class="yt-player-wrap" id="yt-player">
          <video class="yt-video-element" id="main-video" preload="metadata" playsinline>
            <source src="${streamUrl}" type="${mime}">
            Your browser does not support HTML5 video streaming.
          </video>

          <!-- Center Loading Spinner -->
          <div class="yt-spinner" id="yt-spinner">
            <div class="yt-spinner-ring"></div>
          </div>

          <!-- Center Click Animation Ripple -->
          <div class="yt-center-play-btn" id="yt-center-btn">
            <svg id="yt-center-icon" viewBox="0 0 24 24" width="48" height="48" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
          </div>

          <!-- YouTube Controls Bar -->
          <div class="yt-controls-gradient" id="yt-controls">
            <!-- Progress Bar with Scrubber & Buffer -->
            <div class="yt-progress-container" id="yt-progress-wrap">
              <div class="yt-progress-buffered" id="yt-buffered-bar"></div>
              <div class="yt-progress-played" id="yt-played-bar"></div>
              <div class="yt-progress-scrubber" id="yt-scrubber"></div>
              <div class="yt-time-tooltip" id="yt-time-tooltip">00:00</div>
            </div>

            <!-- Buttons Row -->
            <div class="yt-buttons-row">
              <div class="yt-btn-group-left">
                <!-- Play / Pause -->
                <button class="yt-btn" id="yt-play-btn" title="Play/Pause (Space / K)">
                  <svg id="yt-play-icon" viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
                </button>

                <!-- Rewind 10s -->
                <button class="yt-btn" id="yt-rewind-btn" title="Rewind 10s (Left Arrow / J)">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8zm-1.1 11h-.85v-3.26l-1.01.35v-.65l1.81-.66h.05V16zm4.28-1.54c0 .5-.11.89-.32 1.16s-.52.4-.92.4c-.41 0-.73-.13-.93-.4s-.31-.66-.31-1.16v-1.15c0-.5.1-.89.31-1.16s.52-.4.93-.4c.4 0 .71.13.92.4s.32.66.32 1.16v1.15zm-.82-1.3c0-.36-.04-.63-.12-.8s-.21-.26-.4-.26-.32.09-.4.26-.12.44-.12.8v1.44c0 .36.04.63.12.8s.21.26.4.26.32-.09.4-.26.12-.44.12-.8v-1.44z"/></svg>
                </button>

                <!-- Forward 10s -->
                <button class="yt-btn" id="yt-forward-btn" title="Forward 10s (Right Arrow / L)">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8zm-1.1 11h-.85v-3.26l-1.01.35v-.65l1.81-.66h.05V16zm4.28-1.54c0 .5-.11.89-.32 1.16s-.52.4-.92.4c-.41 0-.73-.13-.93-.4s-.31-.66-.31-1.16v-1.15c0-.5.1-.89.31-1.16s.52-.4.93-.4c.4 0 .71.13.92.4s.32.66.32 1.16v1.15zm-.82-1.3c0-.36-.04-.63-.12-.8s-.21-.26-.4-.26-.32.09-.4.26-.12.44-.12.8v1.44c0 .36.04.63.12.8s.21.26.4.26.32-.09.4-.26.12-.44.12-.8v-1.44z"/></svg>
                </button>

                <!-- Volume & Slider -->
                <div class="yt-volume-wrap">
                  <button class="yt-btn" id="yt-volume-btn" title="Mute/Unmute (M)">
                    <svg id="yt-volume-icon" viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                  </button>
                  <input type="range" class="yt-volume-slider" id="yt-volume-slider" min="0" max="1" step="0.05" value="1">
                </div>

                <!-- Time Display -->
                <div class="yt-time-display">
                  <span id="yt-current-time">00:00</span> / <span id="yt-duration">00:00</span>
                </div>
              </div>

              <div class="yt-btn-group-right">
                <!-- Speed Selector -->
                <div class="yt-speed-wrap">
                  <button class="yt-btn yt-speed-btn" id="yt-speed-btn" title="Playback Speed">
                    <span id="yt-speed-text">1x</span>
                  </button>
                  <div class="yt-speed-menu" id="yt-speed-menu" style="display:none;">
                    <div class="yt-speed-option" data-speed="0.5">0.5x</div>
                    <div class="yt-speed-option" data-speed="0.75">0.75x</div>
                    <div class="yt-speed-option active" data-speed="1.0">1.0x (Normal)</div>
                    <div class="yt-speed-option" data-speed="1.25">1.25x</div>
                    <div class="yt-speed-option" data-speed="1.5">1.5x</div>
                    <div class="yt-speed-option" data-speed="2.0">2.0x</div>
                  </div>
                </div>

                <!-- Picture in Picture (PiP) -->
                <button class="yt-btn" id="yt-pip-btn" title="Picture in Picture (P)">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"/></svg>
                </button>

                <!-- Fullscreen -->
                <button class="yt-btn" id="yt-fullscreen-btn" title="Fullscreen (F)">
                  <svg id="yt-fullscreen-icon" viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
      this.initYouTubePlayer();

    // ─── 2. AUDIO: Spotify-Style Modern Waveform Player ────────────────
    } else if (cat === 'audio') {
      contentEl.innerHTML = `
        <div class="modern-audio-card">
          <div class="audio-vinyl-wrap">
            <div class="audio-vinyl" id="audio-vinyl">
              <div class="audio-vinyl-inner">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z"/></svg>
              </div>
            </div>
          </div>

          <div class="audio-meta">
            <h2 class="audio-title">${file.name}</h2>
            <p class="audio-size">${UI.formatFileSize(file.size)} · Unlimited Telegram Cloud</p>
          </div>

          <audio id="main-audio" preload="metadata">
            <source src="${streamUrl}" type="${mime}">
          </audio>

          <!-- Audio Progress -->
          <div class="audio-progress-wrap" id="audio-progress-wrap">
            <div class="audio-progress-bar" id="audio-played-bar"></div>
            <div class="audio-progress-thumb" id="audio-thumb"></div>
          </div>

          <div class="audio-time-row">
            <span id="audio-curr-time">00:00</span>
            <span id="audio-total-time">00:00</span>
          </div>

          <!-- Controls -->
          <div class="audio-controls-row">
            <button class="audio-ctrl-btn" id="audio-rewind" title="Rewind 10s">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8zm-1.1 11h-.85v-3.26l-1.01.35v-.65l1.81-.66h.05V16zm4.28-1.54c0 .5-.11.89-.32 1.16s-.52.4-.92.4c-.41 0-.73-.13-.93-.4s-.31-.66-.31-1.16v-1.15c0-.5.1-.89.31-1.16s.52-.4.93-.4c.4 0 .71.13.92.4s.32.66.32 1.16v1.15zm-.82-1.3c0-.36-.04-.63-.12-.8s-.21-.26-.4-.26-.32.09-.4.26-.12.44-.12.8v1.44c0 .36.04.63.12.8s.21.26.4.26.32-.09.4-.26.12-.44.12-.8v-1.44z"/></svg>
            </button>
            <button class="audio-main-play-btn" id="audio-play-btn">
              <svg id="audio-play-icon" viewBox="0 0 24 24" width="32" height="32" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <button class="audio-ctrl-btn" id="audio-forward" title="Forward 10s">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8zm-1.1 11h-.85v-3.26l-1.01.35v-.65l1.81-.66h.05V16zm4.28-1.54c0 .5-.11.89-.32 1.16s-.52.4-.92.4c-.41 0-.73-.13-.93-.4s-.31-.66-.31-1.16v-1.15c0-.5.1-.89.31-1.16s.52-.4.93-.4c.4 0 .71.13.92.4s.32.66.32 1.16v1.15zm-.82-1.3c0-.36-.04-.63-.12-.8s-.21-.26-.4-.26-.32.09-.4.26-.12.44-.12.8v1.44c0 .36.04.63.12.8s.21.26.4.26.32-.09.4-.26.12-.44.12-.8v-1.44z"/></svg>
            </button>
          </div>

          <!-- Speed & Volume -->
          <div class="audio-footer-row">
            <div class="audio-volume-box">
              <span class="audio-vol-icon">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
              </span>
              <input type="range" class="audio-vol-slider" id="audio-vol-slider" min="0" max="1" step="0.05" value="1">
            </div>
            <a href="${downloadUrl}" class="audio-dl-link" download="${file.name}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <span>Download</span>
            </a>
          </div>
        </div>
      `;
      this.initAudioPlayer();

    // ─── 3. PDF: Full-Screen Google Drive Style Viewer ─────────────────
    } else if (mime === 'application/pdf' || (file.name && file.name.toLowerCase().endsWith('.pdf'))) {
      contentEl.innerHTML = `
        <div class="pdf-viewer-wrap">
          <iframe src="${streamUrl}#view=FitH&toolbar=1" class="pdf-iframe" title="${file.name}"></iframe>
        </div>
      `;

    // ─── 4. IMAGE: Lightbox with Pan, Zoom & Rotate ────────────────────
    } else if (cat === 'image') {
      contentEl.innerHTML = `
        <div class="img-lightbox-wrap">
          <div class="img-toolbar">
            <button class="icon-btn" id="img-zoom-in" title="Zoom In (+)" aria-label="Zoom In">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="7"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                <line x1="11" y1="8" x2="11" y2="14"></line>
                <line x1="8" y1="11" x2="14" y2="11"></line>
              </svg>
            </button>
            <button class="icon-btn" id="img-zoom-out" title="Zoom Out (-)" aria-label="Zoom Out">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="7"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                <line x1="8" y1="11" x2="14" y2="11"></line>
              </svg>
            </button>
            <button class="icon-btn" id="img-rotate" title="Rotate 90°" aria-label="Rotate">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21.5 2v6h-6"></path>
                <path d="M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
              </svg>
            </button>
            <button class="icon-btn" id="img-reset" title="Reset View" aria-label="Reset View">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
              </svg>
            </button>
          </div>
          <div class="img-viewport" id="img-viewport">
            <img src="${streamUrl}" class="lightbox-img" id="lightbox-img" alt="${file.name}">
          </div>
        </div>
      `;
      this.initImageControls();

    // ─── 5. CODE / TEXT / JSON / MARKDOWN ──────────────────────────────
    } else if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript') || mime.includes('xml') || mime.includes('yaml')) {
      contentEl.innerHTML = `
        <div class="code-viewer-wrap">
          <div class="code-toolbar">
            <span style="display:inline-flex; align-items:center; gap:6px;">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
              <span>${file.name}</span>
            </span>
            <button class="btn-secondary" id="btn-copy-code" style="display:inline-flex; align-items:center; gap:5px;">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
              <span>Copy All</span>
            </button>
          </div>
          <div class="code-content" id="code-content">Loading text content...</div>
        </div>
      `;
      fetch(downloadUrl, {
        headers: API.token ? { 'Authorization': `Bearer ${API.token}` } : {}
      })
        .then(r => r.text())
        .then(text => {
          const codeEl = document.getElementById('code-content');
          const lines = text.split('\n');
          const lineNumbered = lines.map((l, idx) => `<span class="line-num">${idx + 1}</span><span class="line-text">${l.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`).join('\n');
          if (codeEl) codeEl.innerHTML = `<pre><code>${lineNumbered}</code></pre>`;

          const copyBtn = document.getElementById('btn-copy-code');
          if (copyBtn) {
            copyBtn.onclick = () => {
              navigator.clipboard.writeText(text);
              UI.showToast('Copied to clipboard!', 'success');
            };
          }
        })
        .catch(() => {
          const codeEl = document.getElementById('code-content');
          if (codeEl) codeEl.innerHTML = '<p class="error-text">Failed to load text file</p>';
        });

    // ─── 6. OTHER / DOCUMENTS (Word, Excel, Zip, etc.) ────────────────
    } else {
      contentEl.innerHTML = `
        <div class="unsupported-card">
          <div class="unsupported-big-icon">${UI.getFileIconSvg(mime)}</div>
          <h2>${file.name}</h2>
          <p class="unsupported-size">${UI.formatFileSize(file.size)} · ${mime || 'Binary file'}</p>
          <p class="unsupported-hint">This file format can be downloaded and opened with your computer's native app.</p>
          <a href="${downloadUrl}" class="btn-primary btn-lg" download="${file.name}" style="display:inline-flex; align-items:center; gap:8px;">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
            <span>Download Decrypted File</span>
          </a>
        </div>
      `;
    }

    overlay.style.display = 'flex';
  },

  close() {
    clearTimeout(this.controlsTimeout);
    clearTimeout(this.navTimeout);
    this._clearListeners();

    const overlay = document.getElementById('preview-overlay');
    const contentEl = document.getElementById('preview-content');
    
    // Stop any playing video/audio
    const vid = document.getElementById('main-video');
    if (vid) {
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
    }
    const aud = document.getElementById('main-audio');
    if (aud) {
      aud.pause();
      aud.removeAttribute('src');
      aud.load();
    }

    if (contentEl) contentEl.innerHTML = '';
    if (overlay) overlay.style.display = 'none';
  },

  // ─── YOUTUBE PLAYER CONTROLLER ─────────────────────────────────────
  initYouTubePlayer() {
    const video = document.getElementById('main-video');
    const playerWrap = document.getElementById('yt-player');
    const controls = document.getElementById('yt-controls');
    const playBtn = document.getElementById('yt-play-btn');
    const playIcon = document.getElementById('yt-play-icon');
    const centerBtn = document.getElementById('yt-center-btn');
    const centerIcon = document.getElementById('yt-center-icon');
    const spinner = document.getElementById('yt-spinner');
    const progressWrap = document.getElementById('yt-progress-wrap');
    const playedBar = document.getElementById('yt-played-bar');
    const bufferedBar = document.getElementById('yt-buffered-bar');
    const scrubber = document.getElementById('yt-scrubber');
    const timeTooltip = document.getElementById('yt-time-tooltip');
    const currTimeEl = document.getElementById('yt-current-time');
    const durTimeEl = document.getElementById('yt-duration');
    const volumeBtn = document.getElementById('yt-volume-btn');
    const volumeIcon = document.getElementById('yt-volume-icon');
    const volumeSlider = document.getElementById('yt-volume-slider');
    const speedBtn = document.getElementById('yt-speed-btn');
    const speedText = document.getElementById('yt-speed-text');
    const speedMenu = document.getElementById('yt-speed-menu');
    const pipBtn = document.getElementById('yt-pip-btn');
    const fullscreenBtn = document.getElementById('yt-fullscreen-btn');
    const fullscreenIcon = document.getElementById('yt-fullscreen-icon');
    const rewindBtn = document.getElementById('yt-rewind-btn');
    const forwardBtn = document.getElementById('yt-forward-btn');

    if (!video) return;

    // SVG icon templates
    const ICONS = {
      play: `<path d="M8 5v14l11-7z"/>`,
      pause: `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`,
      replay: `<path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>`,
      fsEnter: `<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>`,
      fsExit: `<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>`
    };

    // Format time helper (MM:SS or HH:MM:SS)
    const formatTime = (secs) => {
      if (isNaN(secs) || secs < 0) return '00:00';
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = Math.floor(secs % 60);
      if (h > 0) {
        return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
      }
      return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const flashCenterIcon = (iconSvg) => {
      if (!centerBtn || !centerIcon) return;
      centerIcon.innerHTML = iconSvg;
      centerBtn.classList.remove('flash-play');
      void centerBtn.offsetWidth; // Trigger reflow
      centerBtn.classList.add('flash-play');
      setTimeout(() => centerBtn.classList.remove('flash-play'), 500);
    };

    const togglePlay = () => {
      if (video.paused || video.ended) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    };

    // Video Event Handlers for UI Sync
    video.addEventListener('play', () => {
      if (playIcon) playIcon.innerHTML = ICONS.pause;
      if (playBtn) playBtn.title = 'Pause (Space / K)';
      flashCenterIcon(ICONS.play);
      showControls();
    });

    video.addEventListener('pause', () => {
      if (playIcon) playIcon.innerHTML = ICONS.play;
      if (playBtn) playBtn.title = 'Play (Space / K)';
      flashCenterIcon(ICONS.pause);
      if (controls) controls.classList.remove('yt-controls-hidden');
    });

    video.addEventListener('ended', () => {
      if (playIcon) playIcon.innerHTML = ICONS.replay;
      if (playBtn) playBtn.title = 'Replay (Space / K)';
      if (controls) controls.classList.remove('yt-controls-hidden');
    });

    video.addEventListener('waiting', () => {
      if (spinner) spinner.classList.add('visible');
    });

    video.addEventListener('playing', () => {
      if (spinner) spinner.classList.remove('visible');
    });

    video.addEventListener('canplay', () => {
      if (spinner) spinner.classList.remove('visible');
    });

    video.addEventListener('seeking', () => {
      if (spinner) spinner.classList.add('visible');
    });

    video.addEventListener('seeked', () => {
      if (spinner) spinner.classList.remove('visible');
    });

    if (playBtn) playBtn.onclick = togglePlay;
    if (centerBtn) centerBtn.onclick = togglePlay;
    video.onclick = togglePlay;

    // Double click to toggle fullscreen
    video.ondblclick = (e) => {
      e.stopPropagation();
      if (!document.fullscreenElement) {
        if (playerWrap) playerWrap.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    };

    // Rewind / Forward 10s
    if (rewindBtn) rewindBtn.onclick = (e) => {
      e.stopPropagation();
      video.currentTime = Math.max(0, video.currentTime - 10);
    };
    if (forwardBtn) forwardBtn.onclick = (e) => {
      e.stopPropagation();
      video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
    };

    // Update Progress & Time
    video.ontimeupdate = () => {
      if (!video.duration) return;
      const pct = (video.currentTime / video.duration) * 100;
      if (playedBar) playedBar.style.width = `${pct}%`;
      if (scrubber) scrubber.style.left = `${pct}%`;
      if (currTimeEl) currTimeEl.textContent = formatTime(video.currentTime);

      // Buffered range
      if (video.buffered.length > 0 && bufferedBar) {
        try {
          const bufferedEnd = video.buffered.end(video.buffered.length - 1);
          const bufPct = (bufferedEnd / video.duration) * 100;
          bufferedBar.style.width = `${Math.min(100, bufPct)}%`;
        } catch (e) {}
      }
    };

    video.onloadedmetadata = () => {
      if (durTimeEl) durTimeEl.textContent = formatTime(video.duration);
      if (currTimeEl) currTimeEl.textContent = formatTime(video.currentTime);
    };

    // Progress Bar Hover Tooltip & Seeking
    let isDragging = false;
    const getPosFromEvent = (e) => {
      const rect = progressWrap.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    };

    if (progressWrap) {
      progressWrap.addEventListener('mousemove', (e) => {
        if (!video.duration || !timeTooltip) return;
        const pos = getPosFromEvent(e);
        const hoverSecs = pos * video.duration;
        timeTooltip.textContent = formatTime(hoverSecs);
        timeTooltip.style.left = `${pos * 100}%`;
        timeTooltip.style.display = 'block';
      });

      progressWrap.addEventListener('mouseleave', () => {
        if (timeTooltip && !isDragging) timeTooltip.style.display = 'none';
      });

      progressWrap.addEventListener('mousedown', (e) => {
        isDragging = true;
        const pos = getPosFromEvent(e);
        if (video.duration) video.currentTime = pos * video.duration;
      });

      this._addListener(window, 'mousemove', (e) => {
        if (isDragging && progressWrap && video.duration) {
          const pos = getPosFromEvent(e);
          video.currentTime = pos * video.duration;
          if (timeTooltip) {
            timeTooltip.textContent = formatTime(pos * video.duration);
            timeTooltip.style.left = `${pos * 100}%`;
            timeTooltip.style.display = 'block';
          }
        }
      });

      this._addListener(window, 'mouseup', () => {
        if (isDragging) {
          isDragging = false;
          if (timeTooltip) timeTooltip.style.display = 'none';
        }
      });
    }

    // Volume Slider & Mute
    if (volumeSlider) {
      volumeSlider.oninput = () => {
        video.volume = parseFloat(volumeSlider.value);
        video.muted = video.volume === 0;
        this.updateVolumeIcon(video.volume, volumeIcon);
      };
    }

    if (volumeBtn) {
      volumeBtn.onclick = (e) => {
        e.stopPropagation();
        video.muted = !video.muted;
        if (video.muted) {
          if (volumeSlider) volumeSlider.value = 0;
          this.updateVolumeIcon(0, volumeIcon);
        } else {
          const val = video.volume > 0 ? video.volume : 1;
          video.volume = val;
          if (volumeSlider) volumeSlider.value = val;
          this.updateVolumeIcon(val, volumeIcon);
        }
      };
    }

    // Speed Menu
    if (speedBtn && speedMenu) {
      speedBtn.onclick = (e) => {
        e.stopPropagation();
        speedMenu.style.display = speedMenu.style.display === 'none' ? 'flex' : 'none';
      };

      speedMenu.querySelectorAll('.yt-speed-option').forEach(opt => {
        opt.onclick = (e) => {
          e.stopPropagation();
          const speed = parseFloat(opt.getAttribute('data-speed'));
          video.playbackRate = speed;
          if (speedText) speedText.textContent = `${speed}x`;
          speedMenu.querySelectorAll('.yt-speed-option').forEach(o => o.classList.remove('active'));
          opt.classList.add('active');
          speedMenu.style.display = 'none';
        };
      });

      this._addListener(document, 'click', () => {
        if (speedMenu) speedMenu.style.display = 'none';
      });
    }

    // Picture in Picture
    if (pipBtn) {
      pipBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else {
            await video.requestPictureInPicture();
          }
        } catch (err) {
          UI.showToast('Picture-in-Picture not supported in this browser', 'warning');
        }
      };
    }

    // Fullscreen Toggle & Event Sync
    if (fullscreenBtn && playerWrap) {
      fullscreenBtn.onclick = (e) => {
        e.stopPropagation();
        if (!document.fullscreenElement) {
          playerWrap.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      };
    }

    const onFsChange = () => {
      const isFs = !!document.fullscreenElement;
      if (fullscreenIcon) {
        fullscreenIcon.innerHTML = isFs ? ICONS.fsExit : ICONS.fsEnter;
      }
      if (fullscreenBtn) {
        fullscreenBtn.title = isFs ? 'Exit Fullscreen (F)' : 'Fullscreen (F)';
      }
    };
    this._addListener(document, 'fullscreenchange', onFsChange);

    // Auto-hide controls when playing
    const showControls = () => {
      if (controls) controls.classList.remove('yt-controls-hidden');
      clearTimeout(this.controlsTimeout);
      if (!video.paused) {
        this.controlsTimeout = setTimeout(() => {
          if (controls && !isDragging) controls.classList.add('yt-controls-hidden');
        }, 3000);
      }
    };

    if (playerWrap) {
      playerWrap.onmousemove = showControls;
      playerWrap.onmouseleave = () => {
        if (!video.paused && controls && !isDragging) controls.classList.add('yt-controls-hidden');
      };
    }
  },

  updateVolumeIcon(vol, iconEl) {
    if (!iconEl) return;
    if (vol === 0) {
      iconEl.innerHTML = `<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>`;
    } else if (vol < 0.5) {
      iconEl.innerHTML = `<path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>`;
    } else {
      iconEl.innerHTML = `<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>`;
    }
  },

  // ─── AUDIO PLAYER CONTROLLER ───────────────────────────────────────
  initAudioPlayer() {
    const audio = document.getElementById('main-audio');
    const playBtn = document.getElementById('audio-play-btn');
    const playIcon = document.getElementById('audio-play-icon');
    const vinyl = document.getElementById('audio-vinyl');
    const rewind = document.getElementById('audio-rewind');
    const forward = document.getElementById('audio-forward');
    const progressWrap = document.getElementById('audio-progress-wrap');
    const playedBar = document.getElementById('audio-played-bar');
    const currTime = document.getElementById('audio-curr-time');
    const totalTime = document.getElementById('audio-total-time');
    const volSlider = document.getElementById('audio-vol-slider');

    if (!audio) return;

    const ICONS = {
      play: `<path d="M8 5v14l11-7z"/>`,
      pause: `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`
    };

    const formatTime = (secs) => {
      if (isNaN(secs)) return '00:00';
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const togglePlay = () => {
      if (audio.paused) {
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    };

    audio.addEventListener('play', () => {
      if (playIcon) playIcon.innerHTML = ICONS.pause;
      if (vinyl) vinyl.classList.add('playing');
    });

    audio.addEventListener('pause', () => {
      if (playIcon) playIcon.innerHTML = ICONS.play;
      if (vinyl) vinyl.classList.remove('playing');
    });

    audio.addEventListener('ended', () => {
      if (playIcon) playIcon.innerHTML = ICONS.play;
      if (vinyl) vinyl.classList.remove('playing');
    });

    if (playBtn) playBtn.onclick = togglePlay;
    if (rewind) rewind.onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 10); };
    if (forward) forward.onclick = () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10); };

    audio.ontimeupdate = () => {
      if (!audio.duration) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      if (playedBar) playedBar.style.width = `${pct}%`;
      if (currTime) currTime.textContent = formatTime(audio.currentTime);
    };

    audio.onloadedmetadata = () => {
      if (totalTime) totalTime.textContent = formatTime(audio.duration);
    };

    if (progressWrap) {
      progressWrap.onclick = (e) => {
        const rect = progressWrap.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        if (audio.duration) audio.currentTime = pos * audio.duration;
      };
    }

    if (volSlider) {
      volSlider.oninput = () => {
        audio.volume = volSlider.value;
      };
    }
  },

  // ─── IMAGE VIEWER CONTROLS ─────────────────────────────────────────
  initImageControls() {
    const img = document.getElementById('lightbox-img');
    const zoomIn = document.getElementById('img-zoom-in');
    const zoomOut = document.getElementById('img-zoom-out');
    const rotate = document.getElementById('img-rotate');
    const reset = document.getElementById('img-reset');

    const updateTransform = () => {
      if (img) {
        img.style.transform = `scale(${this.zoomLevel}) rotate(${this.rotationAngle}deg)`;
      }
    };

    if (zoomIn) {
      zoomIn.onclick = () => {
        this.zoomLevel = Math.min(4, this.zoomLevel + 0.25);
        updateTransform();
      };
    }
    if (zoomOut) {
      zoomOut.onclick = () => {
        this.zoomLevel = Math.max(0.5, this.zoomLevel - 0.25);
        updateTransform();
      };
    }
    if (rotate) {
      rotate.onclick = () => {
        this.rotationAngle = (this.rotationAngle + 90) % 360;
        updateTransform();
      };
    }
    if (reset) {
      reset.onclick = () => {
        this.zoomLevel = 1;
        this.rotationAngle = 0;
        updateTransform();
      };
    }
  }
};

// Global Keyboard Shortcuts (YouTube standard: Space/K, Left/Right/J/L, F, M, Up/Down)
window.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('preview-overlay');
  if (!overlay || overlay.style.display !== 'flex') return;

  const vid = document.getElementById('main-video');
  const aud = document.getElementById('main-audio');
  const target = vid || aud;

  // Don't intercept keyboard shortcuts if focusing input or textarea
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

  if (e.key === 'Escape') {
    Preview.close();
  } else if ((e.code === 'Space' || e.key.toLowerCase() === 'k') && target) {
    e.preventDefault();
    if (target.paused || target.ended) target.play().catch(() => {}); else target.pause();
  } else if ((e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') && target) {
    e.preventDefault();
    target.currentTime = Math.max(0, target.currentTime - 10);
  } else if ((e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') && target) {
    e.preventDefault();
    target.currentTime = Math.min(target.duration || 0, target.currentTime + 10);
  } else if (e.key === 'ArrowLeft' && !target) {
    e.preventDefault();
    Preview.navigate('prev');
  } else if (e.key === 'ArrowRight' && !target) {
    e.preventDefault();
    Preview.navigate('next');
  } else if (e.key.toLowerCase() === 'm' && target) {
    e.preventDefault();
    target.muted = !target.muted;
    const volIcon = document.getElementById('yt-volume-icon');
    const volSlider = document.getElementById('yt-volume-slider');
    if (volIcon) Preview.updateVolumeIcon(target.muted ? 0 : target.volume, volIcon);
    if (volSlider) volSlider.value = target.muted ? 0 : target.volume;
  } else if (e.key.toLowerCase() === 'f' && vid) {
    e.preventDefault();
    const wrap = document.getElementById('yt-player');
    if (!document.fullscreenElement && wrap) {
      wrap.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  } else if (e.key.toLowerCase() === 'p' && vid) {
    e.preventDefault();
    const pipBtn = document.getElementById('yt-pip-btn');
    if (pipBtn) pipBtn.click();
  } else if (e.key === 'ArrowUp' && target) {
    e.preventDefault();
    target.volume = Math.min(1, target.volume + 0.1);
    target.muted = false;
    const volIcon = document.getElementById('yt-volume-icon');
    const volSlider = document.getElementById('yt-volume-slider');
    if (volIcon) Preview.updateVolumeIcon(target.volume, volIcon);
    if (volSlider) volSlider.value = target.volume;
  } else if (e.key === 'ArrowDown' && target) {
    e.preventDefault();
    target.volume = Math.max(0, target.volume - 0.1);
    const volIcon = document.getElementById('yt-volume-icon');
    const volSlider = document.getElementById('yt-volume-slider');
    if (volIcon) Preview.updateVolumeIcon(target.volume, volIcon);
    if (volSlider) volSlider.value = target.volume;
  }
});
