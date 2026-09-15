/**
 * TeleDrive — Main Application Controller
 */
const App = {
  currentView: 'drive', // 'drive', 'starred', 'recent', 'trash', 'settings'
  currentFolderId: null,
  viewMode: localStorage.getItem('teledrive_view_mode') || 'grid',
  sortBy: localStorage.getItem('teledrive_sort_by') || 'name',
  sortOrder: localStorage.getItem('teledrive_sort_order') || (localStorage.getItem('teledrive_sort_by') === 'date' ? 'desc' : 'asc'),
  lastSelectedId: null,
  files: [],
  folders: [],
  filesMap: new Map(),
  foldersMap: new Map(),
  breadcrumbs: [],
  selectedItem: null,
  activeFilter: 'all',
  unlockedFolders: (() => {
    const set = new Set();
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('teledrive_unlocked_')) {
          set.add(key.replace('teledrive_unlocked_', ''));
        }
      }
    } catch (e) {}
    return set;
  })(),
  pendingUnlockFolder: null,
  isManagingLock: false,
  _navReqCounter: 0,
  filteredFiles: [],
  renderedFileCount: 0,
  _virtualScrollObserver: null,
  _VIRTUAL_PAGE_SIZE: 40,

  async init() {
    try {
      this.initTheme();

      // Check setup status with automatic retry for server startup
      let setupStatus = null;
      let retries = 3;
      while (retries > 0) {
        try {
          setupStatus = await API.getSetupStatus();
          break;
        } catch (e) {
          retries--;
          if (retries > 0) {
            await new Promise(r => setTimeout(r, 600));
          } else {
            console.warn('Could not reach setup status endpoint:', e);
          }
        }
      }

      // If backend explicitly confirms setup is incomplete, show wizard
      if (setupStatus && setupStatus.isComplete === false) {
        this.showScreen('setup');
        Setup.init();
        return;
      }

      // Initialize app listeners & UI components with isolated error handling
      const initializers = [
        ['EventListeners', () => this.initEventListeners()],
        ['SortButtons', () => this.updateSortButtonsUI()],
        ['Sidebar', () => this.initSidebar()],
        ['BottomNav', () => this.initBottomNav()],
        ['Search', () => this.initSearch()],
        ['FileContainerEvents', () => this.initFileContainerEvents()],
        ['DragAndDropMove', () => this.initDragAndDropMove()],
        ['ContextMenu', () => this.initContextMenu()],
        ['Modals', () => this.initModals()],
        ['ShareModal', () => this.initShareModal()],
        ['Upload', () => this.initUpload()],
        ['Settings', () => this.initSettings()],
        ['KeyboardShortcuts', () => this.initKeyboardShortcuts()]
      ];

      for (const [name, fn] of initializers) {
        try {
          fn();
        } catch (initErr) {
          console.error(`Error initializing ${name}:`, initErr);
        }
      }

      // Check auth
      if (API.token) {
        try {
          const authRes = await API.verifyAuth();
          this.user = authRes?.user || null;
          this.showScreen('app');
          // Load synced user preferences across devices
          await this.loadUserPreferences();
          try {
            // Restore active folder or view from URL query / hash / sessionStorage
            const urlParams = new URLSearchParams(window.location.search);
            const folderFromUrl = urlParams.get('folder');
            const viewFromUrl = urlParams.get('view');
            const hash = window.location.hash || '';
            const folderFromHash = hash.startsWith('#folder=') ? hash.substring(8) : null;
            const viewFromHash = hash.startsWith('#view=') ? hash.substring(6) : null;

            const targetFolder = folderFromUrl || folderFromHash || sessionStorage.getItem('teledrive_current_folder') || null;
            const targetView = viewFromUrl || viewFromHash || sessionStorage.getItem('teledrive_current_view') || 'drive';

            if (targetFolder && targetFolder !== 'null') {
              await this.navigateToFolder(targetFolder);
            } else if (targetView && targetView !== 'drive') {
              await this.navigateToView(targetView);
            } else {
              await this.navigateToFolder(null);
            }
            this.loadStorageStats();
          } catch (loadErr) {
            console.warn('Initial load contents warning:', loadErr);
            await this.navigateToFolder(null);
          }
        } catch (authErr) {
          this.showScreen('login');
        }
      } else {
        this.showScreen('login');
      }
    } catch (e) {
      console.error('App init error:', e);
      this.showScreen('login');
    }
  },

  showScreen(screen) {
    const loaderEl = document.getElementById('app-loader');
    const setupEl = document.getElementById('setup-screen');
    const loginEl = document.getElementById('login-screen');
    const appEl = document.getElementById('app-screen');
    
    if (loaderEl) loaderEl.style.display = 'none';
    
    if (setupEl) {
      setupEl.style.display = screen === 'setup' ? 'flex' : 'none';
      if (screen === 'setup') {
        setupEl.removeAttribute('inert');
        setupEl.removeAttribute('aria-hidden');
        setupEl.querySelectorAll('input, button, select, textarea').forEach(el => el.disabled = false);
      } else {
        setupEl.setAttribute('inert', '');
        setupEl.setAttribute('aria-hidden', 'true');
        setupEl.querySelectorAll('input, button, select, textarea').forEach(el => el.disabled = true);
      }
    }
    
    if (loginEl) {
      loginEl.style.display = screen === 'login' ? 'flex' : 'none';
      if (screen === 'login') {
        loginEl.removeAttribute('inert');
        loginEl.removeAttribute('aria-hidden');
        loginEl.querySelectorAll('input, button').forEach(el => el.disabled = false);
        setTimeout(() => {
          const emailInput = document.getElementById('login-email');
          const pwdInput = document.getElementById('login-password');
          if (emailInput && !emailInput.value) {
            emailInput.value = localStorage.getItem('teledrive_last_email') || 'admin@teledrive.local';
          }
          if (pwdInput) pwdInput.focus();
        }, 50);
      } else {
        loginEl.setAttribute('inert', '');
        loginEl.setAttribute('aria-hidden', 'true');
        const pwdInput = document.getElementById('login-password');
        if (pwdInput) {
          pwdInput.value = '';
          pwdInput.blur();
        }
        loginEl.querySelectorAll('input, button').forEach(el => {
          el.blur();
          el.disabled = true;
        });
      }
    }
    
    if (appEl) {
      appEl.style.display = screen === 'app' ? 'flex' : 'none';
      if (screen === 'app') {
        appEl.removeAttribute('inert');
        appEl.removeAttribute('aria-hidden');
        appEl.querySelectorAll('input, button, select, textarea').forEach(el => el.disabled = false);
        this.initRealtimeEvents();
      } else {
        appEl.setAttribute('inert', '');
        appEl.setAttribute('aria-hidden', 'true');
        if (this._eventSource) {
          try { this._eventSource.close(); } catch (e) {}
          this._eventSource = null;
        }
      }
    }
  },

  // ─── View & Navigation ─────────────────────────────────────────────
  async navigateToFolder(folderId, updateUrl = true) {
    const fid = (folderId && folderId !== 'null') ? String(folderId) : null;
    if (fid) {
      const folder = this.foldersMap.get(fid);
      if (folder && folder.is_locked && !this.unlockedFolders.has(fid)) {
        this.openUnlockFolderModal(folder, false);
        return;
      }
    }
    this.currentView = 'drive';
    this.currentFolderId = fid;
    this.updateSidebarActive('drive');
    UI.clearSelection();

    if (fid) {
      sessionStorage.setItem('teledrive_current_folder', fid);
    } else {
      sessionStorage.removeItem('teledrive_current_folder');
    }
    sessionStorage.setItem('teledrive_current_view', 'drive');

    if (updateUrl) {
      try {
        const url = new URL(window.location.href);
        if (fid) {
          url.searchParams.set('folder', fid);
          url.searchParams.delete('view');
        } else {
          url.searchParams.delete('folder');
          url.searchParams.delete('view');
        }
        window.history.replaceState({ folderId: fid, view: 'drive' }, '', url.toString());
      } catch (e) {}
    }

    await this.loadFolderContents(fid);
  },

  async navigateToView(view, updateUrl = true) {
    this.currentView = view;
    UI.clearSelection();
    this.updateSidebarActive(view);

    sessionStorage.setItem('teledrive_current_view', view);
    if (view !== 'drive') {
      sessionStorage.removeItem('teledrive_current_folder');
    }

    if (updateUrl) {
      try {
        const url = new URL(window.location.href);
        if (view !== 'drive') {
          url.searchParams.set('view', view);
          url.searchParams.delete('folder');
        } else {
          url.searchParams.delete('view');
        }
        window.history.replaceState({ view }, '', url.toString());
      } catch (e) {}
    }

    switch (view) {
      case 'drive':
        await this.navigateToFolder(null, false);
        break;
      case 'starred':
        await this.loadStarredFiles();
        break;
      case 'recent':
        await this.loadRecentFiles();
        break;
      case 'trash':
        await this.loadTrashedFiles();
        break;
      case 'storage':
        await this.openStorageAnalyticsModal();
        break;
      case 'settings':
        this.openSettings();
        break;
    }
  },

  _storageStatsTimer: null,
  loadStorageStats(immediate = false) {
    if (immediate) {
      if (this._storageStatsTimer) clearTimeout(this._storageStatsTimer);
      this._doLoadStorageStats();
      return;
    }
    if (this._storageStatsTimer) clearTimeout(this._storageStatsTimer);
    this._storageStatsTimer = setTimeout(() => {
      this._doLoadStorageStats();
    }, 400);
  },

  async _doLoadStorageStats() {
    try {
      const res = await API.getStorageStats();
      const s = (res && res.stats) ? res.stats : res;
      if (!s) return;

      const storageText = document.getElementById('storage-text');
      const storageSubtext = document.getElementById('storage-subtext');
      const storageFill = document.getElementById('storage-fill');

      const usedBytes = s.storageUsed !== undefined ? s.storageUsed : (s.used || s.totalSize || 0);
      const usedFormatted = UI.formatFileSize(usedBytes);
      const fileCount = s.activeFileCount !== undefined ? s.activeFileCount : (s.totalFiles || s.fileCount || 0);

      if (storageText) {
        storageText.textContent = `${fileCount} files · ${usedFormatted}`;
      }

      if (s.storageLimit > 0) {
        const quotaFormatted = UI.formatFileSize(s.storageLimit);
        const pct = s.usagePercentage !== undefined ? s.usagePercentage : Math.min(100, Math.round((usedBytes / s.storageLimit) * 100));
        if (storageSubtext) {
          storageSubtext.textContent = `${pct}% of ${quotaFormatted} used`;
        }
        if (storageFill) {
          storageFill.style.width = `${Math.min(100, Math.max(4, pct))}%`;
          if (pct >= 95) storageFill.style.background = '#ea4335';
          else if (pct >= 80) storageFill.style.background = '#fbbc05';
          else storageFill.style.background = 'var(--accent-color)';
        }
      } else {
        if (storageSubtext) {
          storageSubtext.textContent = 'Unlimited Free Storage';
        }
        if (storageFill) {
          storageFill.style.width = '100%';
          storageFill.style.background = 'var(--accent-color)';
        }
      }
    } catch (e) {
      console.warn('[App] Could not update storage stats:', e);
    }
  },

  async openStorageAnalyticsModal() {
    try {
      UI.showModal('storage-analytics-modal');

      const catList = document.getElementById('storage-categories-list');
      if (catList) {
        catList.innerHTML = '<div style="grid-column: 1 / -1; padding: 14px; text-align: center; color: var(--text-secondary); font-size: 12.5px;">Loading storage breakdown...</div>';
      }

      const largestContainer = document.getElementById('storage-largest-files');
      if (largestContainer) {
        largestContainer.innerHTML = '<div style="padding: 14px; text-align: center; color: var(--text-secondary); font-size: 12.5px;">Loading largest files...</div>';
      }

      const [statsRes, breakdownRes, largestRes] = await Promise.all([
        API.getStorageStats().catch(() => null),
        API.getStorageBreakdown().catch(() => null),
        API.getLargestFiles(10).catch(() => null)
      ]);

      if (statsRes && statsRes.stats) {
        const s = statsRes.stats;
        const usedEl = document.getElementById('storage-modal-used-text');
        const quotaEl = document.getElementById('storage-modal-quota-text');
        const barEl = document.getElementById('storage-modal-bar');
        const percEl = document.getElementById('storage-modal-percentage');
        const freeEl = document.getElementById('storage-modal-free');
        const warnBanner = document.getElementById('storage-warning-banner');
        const warnText = document.getElementById('storage-warning-text');

        if (usedEl) usedEl.textContent = `${UI.formatFileSize(s.storageUsed || 0)} used`;
        if (quotaEl) quotaEl.textContent = s.storageLimit > 0 ? `of ${UI.formatFileSize(s.storageLimit)} limit` : 'of Unlimited quota';

        if (s.storageLimit > 0) {
          if (barEl) {
            barEl.style.width = `${s.usagePercentage || 0}%`;
            if (s.usagePercentage >= 95) barEl.style.background = '#ea4335';
            else if (s.usagePercentage >= 80) barEl.style.background = '#fbbc05';
            else barEl.style.background = 'var(--accent-color)';
          }
          if (percEl) percEl.textContent = `${s.usagePercentage || 0}% used`;
          if (freeEl) freeEl.textContent = `${UI.formatFileSize(s.freeStorage || 0)} remaining`;

          if (s.warningLevel && warnBanner) {
            warnBanner.style.display = 'block';
            if (s.warningLevel === '100') warnText.textContent = '⚠️ Storage is 100% full! Free up space to upload more files.';
            else if (s.warningLevel === '95') warnText.textContent = '⚠️ Only 5% storage remaining. Storage almost full!';
            else if (s.warningLevel === '90') warnText.textContent = '⚠️ You are using 90% of your storage quota.';
            else if (s.warningLevel === '80') warnText.textContent = 'ℹ️ You are using 80% of your storage quota.';
          } else if (warnBanner) {
            warnBanner.style.display = 'none';
          }
        } else {
          if (barEl) {
            barEl.style.width = '100%';
            barEl.style.background = 'var(--accent-color)';
          }
          if (percEl) percEl.textContent = `${s.activeFileCount || 0} active files`;
          if (freeEl) freeEl.textContent = 'Unlimited Free';
          if (warnBanner) warnBanner.style.display = 'none';
        }
      }

      // Render Categories Breakdown
      if (catList && breakdownRes && breakdownRes.breakdown) {
        catList.innerHTML = '';
        const b = breakdownRes.breakdown;
        const iconMap = {
          video: '🎬',
          image: '🖼️',
          document: '📄',
          audio: '🎵',
          archive: '📦',
          other: '📁'
        };

        for (const [key, item] of Object.entries(b)) {
          const card = document.createElement('div');
          card.style.cssText = 'background: var(--bg-hover); border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 12px; display: flex; align-items: center; gap: 8px;';
          card.innerHTML = `
            <span style="font-size: 20px;">${iconMap[key] || '📁'}</span>
            <div style="min-width: 0;">
              <div style="font-weight: 600; font-size: 13px; color: var(--text-primary);">${item.label}</div>
              <div style="font-size: 11.5px; color: var(--text-secondary);">${UI.formatFileSize(item.size || 0)} (${item.count || 0})</div>
            </div>
          `;
          catList.appendChild(card);
        }
      }

      // Render Largest Files
      if (largestContainer) {
        if (largestRes && Array.isArray(largestRes.files) && largestRes.files.length > 0) {
          largestContainer.innerHTML = '';
          largestRes.files.forEach((f, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border-color); font-size: 13px; cursor: pointer;';
            row.innerHTML = `
              <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                <span style="color: var(--text-secondary); font-size: 12px; width: 18px;">${idx + 1}.</span>
                <span style="font-weight: 500; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${f.name}</span>
              </div>
              <span style="font-weight: 600; color: var(--text-secondary); font-size: 12px; margin-left: 12px; white-space: nowrap;">${UI.formatFileSize(f.size || 0)}</span>
            `;
            row.onclick = () => {
              UI.hideAllModals();
              if (f.folder_id) {
                App.navigateToFolder(f.folder_id);
              } else {
                App.navigateToFolder(null);
              }
            };
            largestContainer.appendChild(row);
          });
        } else {
          largestContainer.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 13px;">No files yet.</div>';
        }
      }
    } catch (err) {
      console.error('[App] Error opening storage analytics:', err);
    }
  },

  updateSidebarActive(view) {
    document.querySelectorAll('.sidebar-nav .nav-item, .bottom-nav-item').forEach(el => {
      if (el.getAttribute('data-view') === view) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });
  },

  async loadFolderContents(folderId, options = {}) {
    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      const data = await API.getFolderContents(folderId);
      if (reqId !== this._navReqCounter) return;
      if (data.currentFolder && Boolean(data.currentFolder.is_locked) && !this.unlockedFolders.has(String(data.currentFolder.id))) {
        this.openUnlockFolderModal(data.currentFolder, false);
        return;
      }
      this.folders = data.folders || [];
      this.files = data.files || [];
      this.breadcrumbs = data.breadcrumbs || [{ id: null, name: 'My Drive' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs, data.currentFolder);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load files: ' + e.message, 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  async loadStarredFiles(options = {}) {
    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      this.folders = [];
      const res = await API.getFiles({ starred: true });
      if (reqId !== this._navReqCounter) return;
      this.files = Array.isArray(res) ? res : [];
      this.breadcrumbs = [{ id: null, name: 'Starred' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load starred files', 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  async loadRecentFiles(options = {}) {
    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      this.folders = [];
      const res = await API.getFiles();
      if (reqId !== this._navReqCounter) return;
      this.files = Array.isArray(res) ? res : [];
      this.breadcrumbs = [{ id: null, name: 'Recent Files' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load recent files', 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  async loadTrashedFiles(options = {}) {
    const silent = options.silent || false;
    const reqId = ++this._navReqCounter;
    if (!silent) UI.showSkeletons();
    try {
      this.folders = [];
      const res = await API.getFiles({ trashed: true });
      if (reqId !== this._navReqCounter) return;
      this.files = Array.isArray(res) ? res : [];
      this.breadcrumbs = [{ id: null, name: 'Trash' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      if (reqId === this._navReqCounter) {
        UI.showToast('Failed to load trash', 'error');
      }
    } finally {
      if (reqId === this._navReqCounter && !silent) {
        UI.hideSkeletons();
      }
    }
  },

  // ─── Rendering ─────────────────────────────────────────────────────
  renderContents() {
    UI.hideSkeletons();
    const fileContainer = document.getElementById('file-container');
    const foldersSection = document.getElementById('folders-section');
    const filesSection = document.getElementById('files-section');
    const foldersGrid = document.getElementById('folders-grid');
    const filesGrid = document.getElementById('files-grid');
    const emptyState = document.getElementById('empty-state');

    // Update Trash Banner visibility
    const trashBanner = document.getElementById('trash-banner');
    if (trashBanner) {
      trashBanner.style.display = this.currentView === 'trash' ? 'flex' : 'none';
    }

    // Build Maps for instant, error-free lookup
    this.foldersMap.clear();
    this.filesMap.clear();
    this.folders.forEach(f => this.foldersMap.set(String(f.id), { ...f, type: 'folder' }));
    this.files.forEach(f => this.filesMap.set(String(f.id), { ...f, type: 'file' }));

    // Filter files
    let filteredFiles = this.files;
    if (this.activeFilter && this.activeFilter !== 'all') {
      filteredFiles = this.files.filter(f => UI.getFileTypeCategory(f.mime_type, f.name) === this.activeFilter);
    }

    // Sort files & folders
    this.sortArray(this.folders);
    this.sortArray(filteredFiles);

    const hasFolders = this.folders.length > 0;
    const hasFiles = filteredFiles.length > 0;

    if (!hasFolders && !hasFiles) {
      if (fileContainer) fileContainer.style.display = 'none';
      if (foldersSection) foldersSection.style.display = 'none';
      if (filesSection) filesSection.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
      return;
    }

    if (fileContainer) fileContainer.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';

    // Render Folders
    if (hasFolders) {
      foldersSection.style.display = 'block';
      foldersGrid.innerHTML = this.folders.map(f => UI.renderFolderCard(f)).join('');
    } else {
      foldersSection.style.display = 'none';
    }

    // Disconnect old scroll observer
    if (this._virtualScrollObserver) {
      this._virtualScrollObserver.disconnect();
    }

    // Render Files (Progressive Batch Windowing for 60fps scrolling on large folders)
    this.filteredFiles = filteredFiles;
    if (hasFiles) {
      filesSection.style.display = 'block';
      if (filteredFiles.length <= this._VIRTUAL_PAGE_SIZE) {
        this.renderedFileCount = filteredFiles.length;
        filesGrid.innerHTML = filteredFiles.map(f => UI.renderFileCard(f)).join('');
        UI.loadVideoThumbnails(filteredFiles);
      } else {
        this.renderedFileCount = this._VIRTUAL_PAGE_SIZE;
        const initialBatch = filteredFiles.slice(0, this._VIRTUAL_PAGE_SIZE);
        filesGrid.innerHTML = initialBatch.map(f => UI.renderFileCard(f)).join('') + `
          <div id="virtual-scroll-sentinel" style="grid-column: 1 / -1; height: 30px; width: 100%; display: flex; align-items: center; justify-content: center;"></div>
        `;
        UI.loadVideoThumbnails(initialBatch);
        this.initVirtualScrollObserver();
      }
    } else {
      this.renderedFileCount = 0;
      filesSection.style.display = 'none';
    }

    // Apply view mode
    if (this.viewMode === 'list') {
      fileContainer.classList.add('list-view');
      fileContainer.classList.remove('grid-view');
    } else {
      fileContainer.classList.add('grid-view');
      fileContainer.classList.remove('list-view');
    }

    const viewToggle = document.getElementById('view-toggle');
    if (viewToggle) {
      if (this.viewMode === 'list') {
        viewToggle.title = 'Switch to Grid View';
        viewToggle.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 11h5V5H4v6zm0 7h5v-6H4v6zm6 0h5v-6h-5v6zm6 0h5v-6h-5v6zm-6-7h5V5h-5v6zm6-6v6h5V5h-5z"/></svg>`;
      } else {
        viewToggle.title = 'Switch to List View';
        viewToggle.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>`;
      }
    }
  },

  /**
   * Google Drive style Instant Incremental File Insertion
   * Inserts only the newly uploaded file into UI with 0 full-page reload/flicker
   */
  addUploadedFileLocally(file, localFileBlob = null) {
    if (!file || !file.id) return;
    if (localFileBlob) file.localBlob = localFileBlob;

    // Check if the uploaded file belongs to current active view
    const isDriveView = this.currentView === 'drive';
    const isRecentView = this.currentView === 'recent';
    
    // In drive view, match current folder (both null for root, or exact ID match)
    const targetFolderId = (file.folder_id && file.folder_id !== 'null') ? String(file.folder_id) : null;
    const currentFolderId = (this.currentFolderId && this.currentFolderId !== 'null') ? String(this.currentFolderId) : null;
    const matchesFolder = isDriveView && (targetFolderId === currentFolderId);

    if (!matchesFolder && !isRecentView) {
      // Not currently viewing the folder this file was uploaded to: do not touch DOM!
      this.loadStorageStats();
      return;
    }

    // Check active file filter
    if (this.activeFilter && this.activeFilter !== 'all') {
      const cat = UI.getFileTypeCategory(file.mime_type, file.name);
      if (cat !== this.activeFilter) {
        this.loadStorageStats();
        return;
      }
    }

    // 1. Update State Maps & Array
    this.filesMap.set(String(file.id), { ...file, type: 'file' });
    const existingIndex = this.files.findIndex(f => String(f.id) === String(file.id));
    if (existingIndex !== -1) {
      this.files[existingIndex] = file;
    } else {
      this.files.unshift(file);
    }

    // 2. Ensure container visibility
    const emptyState = document.getElementById('empty-state');
    const fileContainer = document.getElementById('file-container');
    const filesSection = document.getElementById('files-section');
    const filesGrid = document.getElementById('files-grid');

    if (emptyState) emptyState.style.display = 'none';
    if (fileContainer) fileContainer.style.display = 'block';
    if (filesSection) filesSection.style.display = 'block';

    // 3. In-place DOM Insertion / Update
    if (filesGrid) {
      const existingCard = filesGrid.querySelector(`[data-id="${file.id}"]`);
      const cardHtml = UI.renderFileCard(file);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = cardHtml;
      const newCard = tempDiv.firstElementChild;

      if (newCard) {
        // Instant preview for local image files
        const cat = UI.getFileTypeCategory(file.mime_type, file.name);
        if (cat === 'image' && (localFileBlob || file.localBlob)) {
          const imgEl = newCard.querySelector('.file-thumb-media');
          if (imgEl) {
            try {
              imgEl.src = URL.createObjectURL(localFileBlob || file.localBlob);
              imgEl.style.display = 'block';
            } catch (e) {}
          }
        } else if (cat === 'video' && (localFileBlob || file.localBlob)) {
          const imgEl = newCard.querySelector('.file-thumb-media');
          if (imgEl) {
            UI.generateVideoThumbnailFromBlob(localFileBlob || file.localBlob, file.id, imgEl);
          }
        }

        if (existingCard) {
          filesGrid.replaceChild(newCard, existingCard);
        } else {
          if (filesGrid.firstChild) {
            filesGrid.insertBefore(newCard, filesGrid.firstChild);
          } else {
            filesGrid.appendChild(newCard);
          }
        }
        newCard.classList.add('card-just-added');
        setTimeout(() => newCard.classList.remove('card-just-added'), 1500);
      }

      // Load/generate thumbnail for this specific file (video / image)
      UI.loadVideoThumbnails([file]);
    }

    // 4. Update storage stats in background (debounced)
    this.loadStorageStats();
  },

  addUploadedFolderLocally(folder) {
    if (!folder || !folder.id) return;

    const isDriveView = this.currentView === 'drive';
    const targetParentId = (folder.parent_id && folder.parent_id !== 'null') ? String(folder.parent_id) : null;
    const currentFolderId = (this.currentFolderId && this.currentFolderId !== 'null') ? String(this.currentFolderId) : null;
    const matchesFolder = isDriveView && (targetParentId === currentFolderId);

    if (!matchesFolder) return;

    this.foldersMap.set(String(folder.id), { ...folder, type: 'folder' });
    const existingIndex = this.folders.findIndex(f => String(f.id) === String(folder.id));
    if (existingIndex !== -1) {
      this.folders[existingIndex] = folder;
    } else {
      this.folders.unshift(folder);
    }

    const emptyState = document.getElementById('empty-state');
    const fileContainer = document.getElementById('file-container');
    const foldersSection = document.getElementById('folders-section');
    const foldersGrid = document.getElementById('folders-grid');

    if (emptyState) emptyState.style.display = 'none';
    if (fileContainer) fileContainer.style.display = 'block';
    if (foldersSection) foldersSection.style.display = 'block';

    if (foldersGrid) {
      const existingCard = foldersGrid.querySelector(`[data-id="${folder.id}"]`);
      const cardHtml = UI.renderFolderCard(folder);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = cardHtml;
      const newCard = tempDiv.firstElementChild;

      if (newCard) {
        if (existingCard) {
          filesGrid.replaceChild(newCard, existingCard);
        } else {
          if (foldersGrid.firstChild) {
            foldersGrid.insertBefore(newCard, foldersGrid.firstChild);
          } else {
            foldersGrid.appendChild(newCard);
          }
        }
        newCard.classList.add('card-just-added');
        setTimeout(() => newCard.classList.remove('card-just-added'), 1500);
      }
    }
  },

  removeItemsLocally(items) {
    if (!items) return;
    const itemList = Array.isArray(items) ? items : [items];
    if (itemList.length === 0) return;

    const fileIdSet = new Set();
    const folderIdSet = new Set();
    const elementsToAnimate = [];

    itemList.forEach(item => {
      let id, type;
      if (typeof item === 'object' && item !== null) {
        id = String(item.id);
        type = item.type || (this.foldersMap.has(id) ? 'folder' : 'file');
      } else {
        id = String(item);
        type = this.foldersMap.has(id) ? 'folder' : 'file';
      }

      if (type === 'folder') {
        folderIdSet.add(id);
      } else {
        fileIdSet.add(id);
      }

      const card = document.querySelector(`.file-card[data-id="${id}"], .folder-card[data-id="${id}"]`);
      if (card) {
        elementsToAnimate.push(card);
      }

      // Deselect immediately
      UI.selectedItems.delete(id);
    });

    UI.updateActionBar();

    // Instant smooth vanishing animation (Google Drive style)
    elementsToAnimate.forEach(card => {
      card.classList.add('item-vanishing');
      card.style.pointerEvents = 'none';
    });

    // Update local dataset immediately so searches/filters/counts stay consistent
    this.files = this.files.filter(f => !fileIdSet.has(String(f.id)));
    this.folders = this.folders.filter(f => !folderIdSet.has(String(f.id)));
    if (this.filteredFiles) {
      this.filteredFiles = this.filteredFiles.filter(f => !fileIdSet.has(String(f.id)));
    }
    fileIdSet.forEach(id => this.filesMap.delete(id));
    folderIdSet.forEach(id => this.foldersMap.delete(id));

    setTimeout(() => {
      elementsToAnimate.forEach(card => card.remove());

      const hasFolders = this.folders.length > 0;
      const hasFiles = (this.filteredFiles ? this.filteredFiles.length : this.files.length) > 0;

      const foldersSection = document.getElementById('folders-section');
      const filesSection = document.getElementById('files-section');
      const fileContainer = document.getElementById('file-container');
      const emptyState = document.getElementById('empty-state');

      if (!hasFolders && foldersSection) {
        foldersSection.style.display = 'none';
      }
      if (!hasFiles && filesSection) {
        filesSection.style.display = 'none';
      }
      if (!hasFolders && !hasFiles) {
        if (fileContainer) fileContainer.style.display = 'none';
        if (emptyState) emptyState.style.display = 'flex';
      }
    }, 220);

    this.loadStorageStats();
  },

  emptyTrashLocally() {
    UI.clearSelection();
    const allCards = document.querySelectorAll('.file-card, .folder-card');
    allCards.forEach(card => {
      card.classList.add('item-vanishing');
      card.style.pointerEvents = 'none';
    });

    this.files = [];
    this.folders = [];
    this.filteredFiles = [];
    this.filesMap.clear();
    this.foldersMap.clear();

    setTimeout(() => {
      allCards.forEach(c => c.remove());
      const fileContainer = document.getElementById('file-container');
      const emptyState = document.getElementById('empty-state');
      const foldersSection = document.getElementById('folders-section');
      const filesSection = document.getElementById('files-section');
      if (foldersSection) foldersSection.style.display = 'none';
      if (filesSection) filesSection.style.display = 'none';
      if (fileContainer) fileContainer.style.display = 'none';
      if (emptyState) emptyState.style.display = 'flex';
    }, 220);

    this.loadStorageStats();
  },

  removeFileLocally(fileId) {
    if (!fileId) return;
    this.removeItemsLocally([{ id: fileId, type: 'file' }]);
  },

  removeFolderLocally(folderId) {
    if (!folderId) return;
    this.removeItemsLocally([{ id: folderId, type: 'folder' }]);
  },

  updateFileLocally(file) {
    if (!file || !file.id) return;
    this.filesMap.set(String(file.id), { ...file, type: 'file' });
    const idx = this.files.findIndex(f => String(f.id) === String(file.id));
    if (idx !== -1) {
      this.files[idx] = file;
    }

    const filesGrid = document.getElementById('files-grid');
    if (filesGrid) {
      const existingCard = filesGrid.querySelector(`[data-id="${file.id}"]`);
      if (existingCard) {
        const cardHtml = UI.renderFileCard(file);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cardHtml;
        const newCard = tempDiv.firstElementChild;
        if (newCard) {
          filesGrid.replaceChild(newCard, existingCard);
        }
      }
    }
  },

  updateFolderLocally(folder) {
    if (!folder || !folder.id) return;
    this.foldersMap.set(String(folder.id), { ...folder, type: 'folder' });
    const idx = this.folders.findIndex(f => String(f.id) === String(folder.id));
    if (idx !== -1) {
      this.folders[idx] = folder;
    }

    const foldersGrid = document.getElementById('folders-grid');
    if (foldersGrid) {
      const existingCard = foldersGrid.querySelector(`[data-id="${folder.id}"]`);
      if (existingCard) {
        const cardHtml = UI.renderFolderCard(folder);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cardHtml;
        const newCard = tempDiv.firstElementChild;
        if (newCard) {
          foldersGrid.replaceChild(newCard, existingCard);
        }
      }
    }
  },

  // ─── Virtual Scrolling & Batch Windowing ───────────────────────────
  initVirtualScrollObserver() {
    const sentinel = document.getElementById('virtual-scroll-sentinel');
    if (!sentinel) return;

    if (this._virtualScrollObserver) {
      this._virtualScrollObserver.disconnect();
    }

    if (!window.IntersectionObserver) {
      this.renderAllRemainingFiles();
      return;
    }

    this._virtualScrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          this.renderNextBatch();
        }
      });
    }, { rootMargin: '350px' });

    this._virtualScrollObserver.observe(sentinel);
  },

  renderNextBatch() {
    if (!this.filteredFiles || this.renderedFileCount >= this.filteredFiles.length) {
      const sentinel = document.getElementById('virtual-scroll-sentinel');
      if (sentinel) sentinel.remove();
      if (this._virtualScrollObserver) this._virtualScrollObserver.disconnect();
      return;
    }

    const nextBatch = this.filteredFiles.slice(this.renderedFileCount, this.renderedFileCount + this._VIRTUAL_PAGE_SIZE);
    this.renderedFileCount += nextBatch.length;

    const sentinel = document.getElementById('virtual-scroll-sentinel');
    if (sentinel) {
      const html = nextBatch.map(f => UI.renderFileCard(f)).join('');
      sentinel.insertAdjacentHTML('beforebegin', html);
      UI.loadVideoThumbnails(nextBatch);

      if (this.renderedFileCount >= this.filteredFiles.length) {
        sentinel.remove();
        if (this._virtualScrollObserver) this._virtualScrollObserver.disconnect();
      }
    }
  },

  renderAllRemainingFiles() {
    const sentinel = document.getElementById('virtual-scroll-sentinel');
    if (!sentinel || !this.filteredFiles) return;
    const remaining = this.filteredFiles.slice(this.renderedFileCount);
    if (remaining.length > 0) {
      const html = remaining.map(f => UI.renderFileCard(f)).join('');
      sentinel.insertAdjacentHTML('beforebegin', html);
      UI.loadVideoThumbnails(remaining);
    }
    sentinel.remove();
    this.renderedFileCount = this.filteredFiles.length;
  },

  sortArray(arr) {
    arr.sort((a, b) => {
      let valA = a[this.sortBy];
      let valB = b[this.sortBy];

      if (this.sortBy === 'name') {
        valA = (valA || '').toLowerCase();
        valB = (valB || '').toLowerCase();
        return this.sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      if (this.sortBy === 'size') {
        return this.sortOrder === 'asc' ? (a.size || 0) - (b.size || 0) : (b.size || 0) - (a.size || 0);
      }
      if (this.sortBy === 'date') {
        return this.sortOrder === 'asc' ? new Date(a.created_at) - new Date(b.created_at) : new Date(b.created_at) - new Date(a.created_at);
      }
      return 0;
    });
  },

  getVisibleFiles() {
    let list = Array.isArray(this.files) ? [...this.files] : [];
    if (this.activeFilter && this.activeFilter !== 'all') {
      list = list.filter(f => UI.getFileTypeCategory(f.mime_type, f.name) === this.activeFilter);
    }
    this.sortArray(list);
    return list;
  },

  // ─── Event Delegation on File Container (Rock Solid) ───────────────
  initFileContainerEvents() {
    const fileContainer = document.getElementById('file-container');
    if (!fileContainer) return;

    // Click handler (delegated)
    fileContainer.addEventListener('click', (e) => {
      // 1. Check if selection checkbox button was clicked
      const selectBtn = e.target.closest('.card-select-btn');
      if (selectBtn) {
        e.stopPropagation();
        const id = String(selectBtn.getAttribute('data-id'));
        const type = selectBtn.getAttribute('data-type');
        const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
        UI.toggleSelection(id, type, item);
        this.lastSelectedId = id;
        return;
      }

      // 2. Check if 3-dot menu button was clicked
      const moreBtn = e.target.closest('.item-more-btn');
      if (moreBtn) {
        e.stopPropagation();
        const id = String(moreBtn.getAttribute('data-id'));
        const type = moreBtn.getAttribute('data-type');
        const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
        if (item) {
          UI.showContextMenu(e, item);
        }
        return;
      }

      // 3. Check for Ctrl/Cmd multi-selection click on any card
      if (e.ctrlKey || e.metaKey) {
        const card = e.target.closest('.file-card, .folder-card');
        if (card) {
          e.stopPropagation();
          const id = String(card.getAttribute('data-id'));
          const type = card.getAttribute('data-type');
          const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
          UI.toggleSelection(id, type, item);
          this.lastSelectedId = id;
          return;
        }
      }

      // 4. Check for Shift range-selection click on any card
      if (e.shiftKey && this.lastSelectedId) {
        const card = e.target.closest('.file-card, .folder-card');
        if (card) {
          e.stopPropagation();
          const allCards = Array.from(fileContainer.querySelectorAll('.file-card, .folder-card'));
          const lastIdx = allCards.findIndex(c => String(c.getAttribute('data-id')) === String(this.lastSelectedId));
          const currIdx = allCards.findIndex(c => c === card);
          if (lastIdx !== -1 && currIdx !== -1) {
            const start = Math.min(lastIdx, currIdx);
            const end = Math.max(lastIdx, currIdx);
            for (let i = start; i <= end; i++) {
              const c = allCards[i];
              const cid = String(c.getAttribute('data-id'));
              const ctype = c.getAttribute('data-type');
              const citem = ctype === 'folder' ? this.foldersMap.get(cid) : this.filesMap.get(cid);
              UI.toggleSelection(cid, ctype, citem, true);
            }
            return;
          }
        }
      }

      // 5. If currently in selection mode:
      if (UI.selectedItems.size > 0) {
        // Clicking a folder card navigates directly into it (like Google Drive)
        const folderCard = e.target.closest('.folder-card');
        if (folderCard) {
          const id = String(folderCard.getAttribute('data-id'));
          UI.clearSelection();
          this.lastSelectedId = id;
          this.navigateToFolder(id);
          return;
        }

        // Clicking a file card toggles selection
        const card = e.target.closest('.file-card');
        if (card) {
          const id = String(card.getAttribute('data-id'));
          const type = card.getAttribute('data-type');
          const item = this.filesMap.get(id);
          UI.toggleSelection(id, type, item);
          this.lastSelectedId = id;
          return;
        }
      }

      // 6. Normal click: Folder navigates, File opens preview
      const folderCard = e.target.closest('.folder-card');
      if (folderCard) {
        const id = String(folderCard.getAttribute('data-id'));
        const isLocked = folderCard.getAttribute('data-locked') === '1';
        this.lastSelectedId = id;
        if (isLocked && !this.unlockedFolders.has(id)) {
          const folder = this.foldersMap.get(id) || { id, name: folderCard.querySelector('.folder-name')?.textContent || 'Folder', is_locked: 1 };
          this.openUnlockFolderModal(folder, false);
          return;
        }
        this.navigateToFolder(id);
        return;
      }

      const fileCard = e.target.closest('.file-card');
      if (fileCard) {
        const id = String(fileCard.getAttribute('data-id'));
        this.lastSelectedId = id;
        const file = this.filesMap.get(id);
        if (file) {
          Preview.open(file);
        }
        return;
      }
    });

    // Double-click handler as instant guarantee
    fileContainer.addEventListener('dblclick', (e) => {
      const folderCard = e.target.closest('.folder-card');
      if (folderCard) {
        const id = String(folderCard.getAttribute('data-id'));
        const isLocked = folderCard.getAttribute('data-locked') === '1';
        UI.clearSelection();
        if (isLocked && !this.unlockedFolders.has(id)) {
          const folder = this.foldersMap.get(id) || { id, name: folderCard.querySelector('.folder-name')?.textContent || 'Folder', is_locked: 1 };
          this.openUnlockFolderModal(folder, false);
          return;
        }
        this.navigateToFolder(id);
        return;
      }
      const fileCard = e.target.closest('.file-card');
      if (fileCard) {
        const id = String(fileCard.getAttribute('data-id'));
        const file = this.filesMap.get(id);
        if (file) {
          Preview.open(file);
        }
      }
    });

    // Context menu / right-click handler (delegated)
    fileContainer.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.file-card, .folder-card');
      if (card) {
        e.preventDefault();
        e.stopPropagation();
        const id = String(card.getAttribute('data-id'));
        const type = card.getAttribute('data-type');
        const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
        if (item) {
          UI.showContextMenu(e, item);
        }
      }
    });
  },

  // ─── Drag & Drop Moving (Smooth, Animated, Google Drive Style) ────
  initDragAndDropMove() {
    const fileContainer = document.getElementById('file-container');
    const breadcrumb = document.getElementById('breadcrumb');
    const driveNavItem = document.querySelector('.sidebar-nav .nav-item[data-view="drive"]');

    if (!fileContainer) return;

    // 1. Drag Start on File / Folder Cards
    fileContainer.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.file-card, .folder-card');
      if (!card) return;

      // Do not initiate drag if user clicked on the 3-dot more button
      if (e.target.closest('.item-more-btn')) {
        e.preventDefault();
        return;
      }

      const id = card.getAttribute('data-id');
      const type = card.getAttribute('data-type');
      const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
      if (!item) return;

      this.draggedItem = item;
      this.draggedCardElement = card;

      e.dataTransfer.setData('application/x-teledrive-item', JSON.stringify({ id: item.id, type: item.type, name: item.name }));
      e.dataTransfer.effectAllowed = 'move';

      setTimeout(() => {
        if (card) card.classList.add('is-dragging');
      }, 0);
    });

    // 2. Drag End
    fileContainer.addEventListener('dragend', (e) => {
      const card = e.target.closest('.file-card, .folder-card') || this.draggedCardElement;
      if (card) card.classList.remove('is-dragging');
      this.draggedItem = null;
      this.draggedCardElement = null;

      document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    // 3. Drag Over / Enter on Folder Cards
    fileContainer.addEventListener('dragover', (e) => {
      if (!this.draggedItem) return;
      const folderCard = e.target.closest('.folder-card');
      if (!folderCard) return;

      const targetFolderId = folderCard.getAttribute('data-id');
      // Cannot move folder into itself
      if (this.draggedItem.type === 'folder' && this.draggedItem.id === targetFolderId) {
        return;
      }

      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      folderCard.classList.add('drag-over');
    });

    fileContainer.addEventListener('dragleave', (e) => {
      const folderCard = e.target.closest('.folder-card');
      if (!folderCard) return;
      if (!folderCard.contains(e.relatedTarget)) {
        folderCard.classList.remove('drag-over');
      }
    });

    // 4. Drop on Folder Card
    fileContainer.addEventListener('drop', async (e) => {
      const folderCard = e.target.closest('.folder-card');
      if (!folderCard || !this.draggedItem) return;

      e.preventDefault();
      e.stopPropagation();
      folderCard.classList.remove('drag-over');

      const targetFolderId = folderCard.getAttribute('data-id');
      const targetFolder = this.foldersMap.get(targetFolderId);
      const targetName = targetFolder ? targetFolder.name : 'Folder';

      await this.executeMove(this.draggedItem, targetFolderId, targetName);
    });

    // 5. Drop on Breadcrumb Ancestor Folders
    if (breadcrumb) {
      breadcrumb.addEventListener('dragover', (e) => {
        if (!this.draggedItem) return;
        const bItem = e.target.closest('a.breadcrumb-item');
        if (!bItem) return;

        const rawId = bItem.getAttribute('data-folder-id');
        const targetFolderId = (rawId && rawId !== 'null' && rawId !== '') ? rawId : null;
        if (targetFolderId === this.currentFolderId) return;

        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        bItem.classList.add('drag-over');
      });

      breadcrumb.addEventListener('dragleave', (e) => {
        const bItem = e.target.closest('a.breadcrumb-item');
        if (bItem && !bItem.contains(e.relatedTarget)) {
          bItem.classList.remove('drag-over');
        }
      });

      breadcrumb.addEventListener('drop', async (e) => {
        const bItem = e.target.closest('a.breadcrumb-item');
        if (!bItem || !this.draggedItem) return;

        e.preventDefault();
        e.stopPropagation();
        bItem.classList.remove('drag-over');

        const rawId = bItem.getAttribute('data-folder-id');
        const targetFolderId = (rawId && rawId !== 'null' && rawId !== '') ? rawId : null;
        const targetName = bItem.textContent.trim() || 'My Drive';

        await this.executeMove(this.draggedItem, targetFolderId, targetName);
      });
    }

    // 6. Drop on Sidebar "My Drive" (Root)
    if (driveNavItem) {
      driveNavItem.addEventListener('dragover', (e) => {
        if (!this.draggedItem || this.currentFolderId === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        driveNavItem.classList.add('drag-over');
      });

      driveNavItem.addEventListener('dragleave', (e) => {
        if (!driveNavItem.contains(e.relatedTarget)) {
          driveNavItem.classList.remove('drag-over');
        }
      });

      driveNavItem.addEventListener('drop', async (e) => {
        if (!this.draggedItem || this.currentFolderId === null) return;
        e.preventDefault();
        e.stopPropagation();
        driveNavItem.classList.remove('drag-over');
        await this.executeMove(this.draggedItem, null, 'My Drive');
      });
    }
  },

  async executeMove(item, targetFolderId, targetFolderName) {
    if (!item) return;

    if (item.type === 'folder' && item.id === targetFolderId) {
      UI.showToast('Cannot move a folder into itself', 'warning');
      return;
    }
    if (item.type === 'file' && item.folder_id === targetFolderId) {
      return;
    }

    try {
      if (this.draggedCardElement) {
        this.draggedCardElement.classList.add('move-out');
      }

      if (item.type === 'folder') {
        await API.moveFolder(item.id, targetFolderId);
      } else {
        await API.moveFile(item.id, targetFolderId);
      }

      UI.showToast(`Moved "${item.name}" to "${targetFolderName}"`, 'success');

      setTimeout(() => {
        this.refreshCurrentView();
      }, 250);
    } catch (err) {
      UI.showToast(`Move failed: ${err.message}`, 'error');
      this.refreshCurrentView();
    }
  },

  // ─── Actions ───────────────────────────────────────────────────────
  async handleItemAction(action, itemData) {
    if (!itemData) return;

    if (action === 'preview') {
      if (itemData.type === 'folder') {
        this.navigateToFolder(itemData.id);
      } else {
        Preview.open(itemData);
      }
    } else if (action === 'download') {
      if (itemData.type !== 'folder') {
        UI.triggerDownload(API.getDownloadUrl(itemData.id), itemData.name);
      }
    } else if (action === 'share') {
      if (itemData.type !== 'folder') {
        this.openShareModal(itemData);
      }
    } else if (action === 'info') {
      this.openFileInfoModal(itemData);
    } else if (action === 'star') {
      if (itemData.type === 'file') {
        const newStar = itemData.is_starred ? 0 : 1;
        await API.starFile(itemData.id, newStar);
        UI.showToast(newStar ? 'Added to Starred' : 'Removed from Starred', 'info');
        this.refreshCurrentView();
      }
    } else if (action === 'rename') {
      this.openRenameModal(itemData);
    } else if (action === 'lock-folder') {
      if (itemData.type === 'folder') {
        if (itemData.is_locked) {
          this.openUnlockFolderModal(itemData, true);
        } else {
          this.openLockFolderModal(itemData);
        }
      }
    } else if (action === 'relock-folder') {
      if (itemData.type === 'folder') {
        this.relockFolder(itemData.id);
      }
    } else if (action === 'move') {
      this.openMoveModal(itemData);
    } else if (action === 'trash') {
      if (itemData.type === 'file') {
        this.removeItemsLocally([itemData]);
        try {
          await API.trashFile(itemData.id);
          UI.showToast('Moved to Trash', 'info');
        } catch (e) {
          UI.showToast('Failed to trash file: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      } else {
        const confirmed = await UI.confirm({
          title: 'Move Folder to Trash?',
          message: `Are you sure you want to move folder "${itemData.name}" and all its contents to Trash?`,
          description: 'All files inside will be unlinked and moved to Trash. They can still be restored.',
          icon: 'trash',
          confirmText: 'Move to Trash',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });
        if (!confirmed) return;
        this.removeItemsLocally([itemData]);
        UI.showToast('Moving folder to Trash...', 'info');
        try {
          await API.deleteFolder(itemData.id);
          UI.showToast('Folder moved to Trash', 'info');
        } catch (e) {
          UI.showToast('Failed to move folder to trash: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      }
    } else if (action === 'restore') {
      if (itemData.type === 'file') {
        this.removeItemsLocally([itemData]);
        try {
          await API.restoreFile(itemData.id);
          UI.showToast('File restored', 'success');
        } catch (e) {
          UI.showToast('Failed to restore file: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      }
    } else if (action === 'permanent-delete') {
      this.openDeleteModal(itemData);
    }
  },

  openFileInfoModal(item) {
    if (!item) return;
    this.selectedItem = item;

    const iconEl = document.getElementById('info-file-icon');
    const nameEl = document.getElementById('info-file-name');
    const subEl = document.getElementById('info-file-sub');
    const typeEl = document.getElementById('info-file-type');
    const sizeEl = document.getElementById('info-file-size');
    const locEl = document.getElementById('info-file-location');
    const createdEl = document.getElementById('info-file-created');
    const updatedEl = document.getElementById('info-file-updated');
    const tgEl = document.getElementById('info-file-tg');
    const idEl = document.getElementById('info-file-id');
    const copyLinkBtn = document.getElementById('info-copy-link');

    if (iconEl) {
      iconEl.innerHTML = item.type === 'folder' ?
        `<svg viewBox="0 0 24 24" width="36" height="36" fill="#5f6368"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>` :
        UI.getFileIconSvg(item.mime_type);
    }

    if (nameEl) nameEl.textContent = item.name;
    if (subEl) subEl.textContent = item.type === 'folder' ? 'Cloud Folder' : (item.mime_type || 'Binary file');
    if (typeEl) typeEl.textContent = item.type === 'folder' ? 'Directory / Folder' : `${UI.getFileTypeCategory(item.mime_type).toUpperCase()} (${item.mime_type || 'Unknown'})`;
    
    if (sizeEl) {
      if (item.type === 'folder') {
        sizeEl.textContent = '-';
      } else {
        const formatted = UI.formatFileSize(item.size);
        const bytes = (item.size || 0).toLocaleString();
        sizeEl.textContent = `${formatted} (${bytes} bytes)`;
      }
    }

    if (locEl) {
      if (this.breadcrumbs && this.breadcrumbs.length > 0) {
        locEl.textContent = this.breadcrumbs.map(b => b.name).join(' / ');
      } else {
        locEl.textContent = 'My Drive';
      }
    }

    // Exact upload & modified date with seconds
    if (createdEl) createdEl.textContent = UI.formatFullDateTime(item.created_at);
    if (updatedEl) updatedEl.textContent = UI.formatFullDateTime(item.updated_at || item.created_at);

    if (tgEl) {
      tgEl.textContent = item.telegram_message_id ? `Message ID #${item.telegram_message_id}` : 'N/A';
    }

    if (idEl) idEl.textContent = item.id;

    if (copyLinkBtn) {
      copyLinkBtn.style.display = item.type === 'file' ? 'inline-block' : 'none';
      copyLinkBtn.onclick = async () => {
        const url = window.location.origin + API.getStreamUrl(item.id);
        const success = await UI.copyToClipboard(url);
        if (success) {
          UI.showToast('Stream link copied to clipboard!', 'success');
        } else {
          UI.showToast('Failed to copy stream link', 'error');
        }
      };
    }

    UI.showModal('file-info-modal');
  },

  currentShareFile: null,

  async openShareModal(file) {
    if (!file) return;
    if (typeof file === 'string' || typeof file === 'number') {
      file = this.filesMap.get(String(file)) || { id: String(file), type: 'file', name: 'File' };
    } else if (file.item) {
      file = file.item;
    }
    if (file.type === 'folder') {
      UI.showToast('Only individual files can be shared publicly', 'info');
      return;
    }
    this.currentShareFile = file;

    const modalIcon = document.getElementById('share-modal-file-icon');
    const modalTitle = document.getElementById('share-modal-title');
    const modalSubtitle = document.getElementById('share-modal-subtitle');
    const accessSelect = document.getElementById('share-access-select');
    const publicSettings = document.getElementById('share-public-settings');
    const linkInput = document.getElementById('share-link-input');
    const copyBtnText = document.getElementById('copy-share-btn-text');
    const pwInput = document.getElementById('share-password-input');
    const pwStatus = document.getElementById('share-pw-status');
    const expSelect = document.getElementById('share-expiration-select');
    const expStatus = document.getElementById('share-expiry-status');
    const viewsEl = document.getElementById('share-stats-views');
    const dlsEl = document.getElementById('share-stats-downloads');
    const revokeBtn = document.getElementById('btn-revoke-share');
    const accessIcon = document.getElementById('share-access-icon-wrap');
    const accessHint = document.getElementById('share-access-hint');
    const btnRemovePw = document.getElementById('btn-remove-share-pw');

    const ICON_LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
    const ICON_GLOBE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

    if (modalIcon) modalIcon.innerHTML = UI.getFileIconSvg(file.mime_type);
    if (modalTitle) modalTitle.textContent = `Share "${file.name || 'File'}"`;
    if (modalSubtitle) modalSubtitle.textContent = `${UI.formatFileSize(file.size || 0)} • ${file.mime_type || 'File'}`;

    // Reset default UI state & IMMEDIATELY make public options visible
    this.clearPasswordRequested = false;
    this.currentShareStatus = null;
    if (accessSelect) accessSelect.value = 'public';
    if (accessIcon) accessIcon.innerHTML = ICON_GLOBE;
    if (accessHint) accessHint.textContent = 'Anyone on the internet with this link can view and download';
    if (publicSettings) publicSettings.style.display = 'flex';
    if (linkInput) linkInput.value = 'Click "Save Changes" to generate public link';
    if (copyBtnText) copyBtnText.textContent = 'Copy link';
    if (pwInput) {
      pwInput.value = '';
      pwInput.type = 'password';
      pwInput.placeholder = 'Set a password or leave blank';
    }
    if (btnRemovePw) btnRemovePw.style.display = 'none';
    if (pwStatus) pwStatus.textContent = '';
    if (expSelect) expSelect.value = 'never';
    if (expStatus) expStatus.textContent = '';
    if (viewsEl) viewsEl.textContent = '0';
    if (dlsEl) dlsEl.textContent = '0';
    if (revokeBtn) revokeBtn.style.display = 'none';

    // Show modal immediately
    UI.showModal('share-modal');
    this.initShareModal();

    try {
      const data = await API.getShareStatus(file.id);
      this.currentShareStatus = data;
      const isShared = Boolean(data.is_shared || data.isShared);

      if (isShared && (data.share_token || data.share_url)) {
        const shareToken = data.share_token || data.shareToken;
        const finalUrl = shareToken ? `${window.location.origin}/share/${shareToken}` : (data.share_url || '');
        if (linkInput) linkInput.value = finalUrl;
        if (accessSelect) accessSelect.value = 'public';
        if (accessIcon) accessIcon.innerHTML = ICON_GLOBE;
        if (publicSettings) publicSettings.style.display = 'flex';
        if (revokeBtn) revokeBtn.style.display = 'inline-flex';
      } else {
        if (linkInput) linkInput.value = 'Click "Save Changes" to generate public link';
        if (revokeBtn) revokeBtn.style.display = 'none';
      }

      if (pwStatus && pwInput) {
        if (data.has_password || data.hasPassword) {
          pwStatus.innerHTML = '<span style="color:#34a853;">🔒 Password protection is ACTIVE</span>';
          pwInput.placeholder = 'Type new password to change (or leave blank)';
          if (btnRemovePw) btnRemovePw.style.display = 'inline-block';
        } else {
          pwStatus.innerHTML = '<span style="color:var(--text-muted);">🔓 No password protection</span>';
          pwInput.placeholder = 'Set a password or leave blank';
          if (btnRemovePw) btnRemovePw.style.display = 'none';
        }
      }

      if (expStatus && expSelect) {
        const expAt = data.share_expires_at || data.expiresAt;
        if (expAt) {
          const expDate = new Date(expAt);
          const now = new Date();
          const isExpired = expDate < now;

          expStatus.innerHTML = isExpired
            ? `<span style="color:#ea4335;">⚠️ Expired on ${UI.formatFullDateTime(expAt)}</span>`
            : `<span style="color:#34a853;">● Active:</span> Expires on ${UI.formatFullDateTime(expAt)}`;
        } else {
          expSelect.value = 'never';
          expStatus.innerHTML = '<span style="color:var(--text-muted);">● Link never expires</span>';
        }
      }

      const viewsCount = (data.share_views !== undefined && data.share_views !== null) ? data.share_views : (data.views !== undefined ? data.views : 0);
      const dlsCount = (data.share_downloads !== undefined && data.share_downloads !== null) ? data.share_downloads : (data.downloads !== undefined ? data.downloads : 0);
      if (viewsEl) viewsEl.textContent = viewsCount;
      if (dlsEl) dlsEl.textContent = dlsCount;
    } catch (err) {
      console.warn('Share status load warning:', err);
    }
  },

  async refreshCurrentView(options = {}) {
    if (this.currentView === 'drive') {
      await this.loadFolderContents(this.currentFolderId, options);
    } else if (this.currentView === 'starred') {
      await this.loadStarredFiles(options);
    } else if (this.currentView === 'recent') {
      await this.loadRecentFiles(options);
    } else if (this.currentView === 'trash') {
      await this.loadTrashedFiles(options);
    }
    this.loadStorageStats();
  },

  // ─── Event Listeners ───────────────────────────────────────────────
  initEventListeners() {
    // Login form submit
    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.onsubmit = async (e) => {
        e.preventDefault();
        const emailInput = document.getElementById('login-email');
        const pwdInput = document.getElementById('login-password');
        const email = emailInput ? emailInput.value.trim() : '';
        const pwd = pwdInput ? pwdInput.value : '';
        const spinner = document.getElementById('login-spinner');
        const btn = document.getElementById('login-btn');

        if (!pwd || !pwd.trim()) {
          UI.showToast('Please enter your password', 'info');
          if (pwdInput) pwdInput.focus();
          return;
        }

        if (spinner) spinner.style.display = 'inline-block';
        if (btn) btn.disabled = true;

        try {
          const authData = await API.login(email, pwd);
          if (email) localStorage.setItem('teledrive_last_email', email);
          this.user = authData?.user || null;
          UI.showToast('Login successful!', 'success');
          if (pwdInput) pwdInput.value = '';
          this.showScreen('app');
          // Load synced user preferences across devices
          await this.loadUserPreferences();
          const urlParams = new URLSearchParams(window.location.search);
          const targetFolder = urlParams.get('folder') || sessionStorage.getItem('teledrive_current_folder') || null;
          const targetView = urlParams.get('view') || sessionStorage.getItem('teledrive_current_view') || 'drive';
          if (targetFolder && targetFolder !== 'null') {
            await this.navigateToFolder(targetFolder);
          } else if (targetView && targetView !== 'drive') {
            await this.navigateToView(targetView);
          } else {
            await this.navigateToFolder(null);
          }
          this.loadStorageStats();
        } catch (err) {
          UI.showToast(err.message || 'Invalid email or password', 'error');
          if (pwdInput) {
            pwdInput.focus();
            pwdInput.select();
          }
        } finally {
          if (spinner) spinner.style.display = 'none';
          if (btn) btn.disabled = false;
        }
      };
    }

    // Browser history popstate (Back/Forward buttons)
    window.addEventListener('popstate', async () => {
      if (this.currentView) {
        const urlParams = new URLSearchParams(window.location.search);
        const folder = urlParams.get('folder');
        const view = urlParams.get('view');
        if (folder) {
          await this.navigateToFolder(folder, false);
        } else if (view && view !== 'drive') {
          await this.navigateToView(view, false);
        } else {
          await this.navigateToFolder(null, false);
        }
      }
    });

    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        this.unlockedFolders.clear();
        sessionStorage.clear();
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('folder');
          url.searchParams.delete('view');
          window.history.replaceState({}, '', url.pathname);
        } catch (e) {}
        await API.logout();
        UI.showToast('Logged out', 'info');
        this.showScreen('login');
      };
    }

    // View toggle button (Grid / List)
    const viewToggle = document.getElementById('view-toggle');
    if (viewToggle) {
      viewToggle.onclick = () => {
        this.viewMode = this.viewMode === 'grid' ? 'list' : 'grid';
        this.saveUserPreference('view_mode', this.viewMode);
        this.renderContents();
      };
    }

    // Theme toggle button (Light / Dark)
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
      themeToggle.onclick = () => this.toggleTheme();
    }

    // New Folder button
    const newFolderBtn = document.getElementById('new-folder-btn');
    if (newFolderBtn) {
      newFolderBtn.onclick = () => this.openCreateFolderModal();
    }

    // Empty Trash button
    const emptyTrashBtn = document.getElementById('btn-empty-trash');
    if (emptyTrashBtn) {
      emptyTrashBtn.onclick = async () => {
        if (!this.files || this.files.length === 0) {
          UI.showToast('Trash is already empty', 'info');
          return;
        }

        const count = this.files.length;
        const confirmed = await UI.confirm({
          title: 'Empty Trash?',
          message: `Are you sure you want to permanently delete all ${count} item(s) in Trash?`,
          description: 'All items will be permanently erased from your Telegram cloud storage. This action cannot be undone.',
          icon: 'trash',
          confirmText: `Empty Trash (${count})`,
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          this.emptyTrashLocally();
          UI.showToast('Permanently deleting all items from Telegram...', 'info');
          const res = await API.emptyTrash();
          if (res.warnings && res.warnings.length > 0) {
            UI.showToast(`Deleted with warning: ${res.warnings.join('; ')}`, 'warning');
          } else {
            UI.showToast(`Permanently deleted ${res.count || 0} file(s) from Telegram`, 'success');
          }
        } catch (e) {
          UI.showToast('Failed to empty trash: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }

    // Filter chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.onclick = () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.activeFilter = chip.getAttribute('data-type');
        this.renderContents();
      };
    });

    // Sort buttons
    document.querySelectorAll('.sort-btn').forEach(btn => {
      btn.onclick = () => {
        const sort = btn.getAttribute('data-sort');
        if (this.sortBy === sort) {
          this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortBy = sort;
          this.sortOrder = (sort === 'date') ? 'desc' : 'asc';
        }
        this.saveUserPreferences({ sort_by: this.sortBy, sort_order: this.sortOrder });
        this.updateSortButtonsUI();
        this.renderContents();
      };
    });

    // Action Bar actions
    const actionDownload = document.getElementById('action-download');
    const actionShare = document.getElementById('action-share');
    const actionStar = document.getElementById('action-star');
    const actionMove = document.getElementById('action-move');
    const actionDelete = document.getElementById('action-delete');
    const actionRestore = document.getElementById('action-restore');
    const actionPermanentDelete = document.getElementById('action-permanent-delete');
    const actionSelectAll = document.getElementById('action-select-all');
    const actionBarClose = document.getElementById('action-bar-close');

    if (actionBarClose) actionBarClose.onclick = () => UI.clearSelection();

    if (actionSelectAll) {
      actionSelectAll.onclick = () => {
        const allItems = [...this.folders, ...this.files];
        UI.selectAll(allItems);
      };
    }

    if (actionShare) {
      actionShare.onclick = () => {
        const selectedFiles = Array.from(UI.selectedItems.values()).filter(i => i.type === 'file');
        if (selectedFiles.length === 1) {
          this.openShareModal(selectedFiles[0]);
        } else if (selectedFiles.length > 1) {
          UI.showToast('Select a single file to share', 'info');
        }
      };
    }

    if (actionDownload) {
      actionDownload.onclick = () => {
        const selectedFiles = Array.from(UI.selectedItems.values()).filter(i => i.type === 'file');
        if (selectedFiles.length === 0) {
          UI.showToast('No files selected to download', 'info');
          return;
        }
        if (selectedFiles.length === 1) {
          UI.triggerDownload(API.getDownloadUrl(selectedFiles[0].id), selectedFiles[0].name);
        } else {
          UI.showToast(`Downloading ${selectedFiles.length} file(s)...`, 'info');
          selectedFiles.forEach((fileItem, idx) => {
            setTimeout(() => {
              const a = document.createElement('a');
              a.href = API.getDownloadUrl(fileItem.id);
              a.download = '';
              document.body.appendChild(a);
              a.click();
              a.remove();
            }, idx * 400);
          });
        }
      };
    }

    if (actionStar) {
      actionStar.onclick = async () => {
        const selectedFiles = Array.from(UI.selectedItems.values()).filter(i => i.type === 'file');
        if (selectedFiles.length === 0) {
          UI.showToast('Select files to star/unstar', 'info');
          return;
        }
        const allStarred = selectedFiles.every(f => {
          const file = this.filesMap.get(f.id);
          return file && file.is_starred === 1;
        });
        const newStarState = !allStarred;
        const fileIds = selectedFiles.map(f => f.id);
        try {
          await API.batchStar(fileIds, newStarState);
          UI.showToast(`${newStarState ? 'Starred' : 'Unstarred'} ${fileIds.length} file(s)`, 'success');
          UI.clearSelection();
          await this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Failed to update star state: ' + e.message, 'error');
        }
      };
    }

    if (actionMove) {
      actionMove.onclick = () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        if (selectedItems.length === 0) return;
        this.openMoveModal(selectedItems[0].item);
      };
    }

    if (actionDelete) {
      actionDelete.onclick = async () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        if (selectedItems.length === 0) return;
        const fileIds = selectedItems.filter(i => i.type === 'file').map(i => i.id);
        const folderIds = selectedItems.filter(i => i.type === 'folder').map(i => i.id);
        const count = selectedItems.length;

        const confirmed = await UI.confirm({
          title: 'Move to Trash?',
          message: `Move ${count} selected item(s) to Trash?`,
          description: 'Items in Trash are safely kept and can be restored anytime within 30 days.',
          icon: 'trash',
          confirmText: `Move ${count} Item${count > 1 ? 's' : ''} to Trash`,
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          this.removeItemsLocally(selectedItems);
          await API.batchTrash(fileIds, folderIds);
          UI.showToast(`Moved ${count} item(s) to Trash`, 'success');
        } catch (e) {
          UI.showToast('Failed to trash items: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }

    if (actionRestore) {
      actionRestore.onclick = async () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        const fileIds = selectedItems.filter(i => i.type === 'file').map(i => i.id);
        if (fileIds.length === 0) return;
        try {
          this.removeItemsLocally(selectedItems);
          await API.batchRestore(fileIds);
          UI.showToast(`Restored ${fileIds.length} file(s)`, 'success');
        } catch (e) {
          UI.showToast('Failed to restore files: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }

    if (actionPermanentDelete) {
      actionPermanentDelete.onclick = async () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        const fileIds = selectedItems.filter(i => i.type === 'file').map(i => i.id);
        const folderIds = selectedItems.filter(i => i.type === 'folder').map(i => i.id);
        const count = selectedItems.length;

        const confirmed = await UI.confirm({
          title: 'Permanently Delete Items?',
          message: `Permanently delete ${count} item(s) from Telegram cloud?`,
          description: 'This action cannot be undone. All file data and chunk parts will be completely removed from Telegram and database.',
          icon: 'danger',
          confirmText: `Delete Permanently (${count})`,
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          this.removeItemsLocally(selectedItems);
          UI.showToast('Permanently deleting from Telegram...', 'info');
          const res = await API.batchDelete(fileIds, folderIds);
          if (res.warnings && res.warnings.length > 0) {
            UI.showToast(`Deleted with warning: ${res.warnings.join('; ')}`, 'warning');
          } else {
            UI.showToast(`Permanently deleted ${count} item(s) from Telegram`, 'success');
          }
        } catch (e) {
          UI.showToast('Failed to permanently delete items: ' + e.message, 'error');
          await this.refreshCurrentView();
        }
      };
    }
  },

  initSidebar() {
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    if (sidebarToggle && sidebar && overlay) {
      sidebarToggle.onclick = () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('open');
      };
      overlay.onclick = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
      };
    }

    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
      item.onclick = (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        if (view) {
          this.navigateToView(view);
          if (sidebar) sidebar.classList.remove('open');
          if (overlay) overlay.classList.remove('open');
        }
      };
    });

    const storageCard = document.getElementById('sidebar-storage-card');
    if (storageCard) {
      storageCard.onclick = () => {
        this.openStorageAnalyticsModal();
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('open');
      };
    }
  },

  initBottomNav() {
    document.querySelectorAll('.bottom-nav-item').forEach(item => {
      item.onclick = (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        if (view) this.navigateToView(view);
      };
    });
  },

  initSearch() {
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('search-clear');
    let timeout = null;

    if (searchInput) {
      searchInput.oninput = () => {
        const query = searchInput.value.trim();
        if (clearBtn) clearBtn.style.display = query ? 'flex' : 'none';

        clearTimeout(timeout);
        timeout = setTimeout(async () => {
          if (!query) {
            this.navigateToFolder(this.currentFolderId);
            return;
          }
          const reqId = ++this._navReqCounter;
          UI.showSkeletons();
          try {
            const [folderData, fileData] = await Promise.all([
              API.getFolderContents(null, query).catch(() => ({ folders: [] })),
              API.getFiles({ search: query }).catch(() => [])
            ]);
            if (reqId !== this._navReqCounter) return;
            this.folders = (folderData && folderData.folders) ? folderData.folders : [];
            this.files = Array.isArray(fileData) ? fileData : [];
            this.breadcrumbs = [{ id: null, name: `Search: "${query}"` }];
            this.renderContents();
            UI.renderBreadcrumbs(this.breadcrumbs);
          } catch (e) {
            // Ignore
          } finally {
            if (reqId === this._navReqCounter) {
              UI.hideSkeletons();
            }
          }
        }, 300);
      };
    }

    if (clearBtn) {
      clearBtn.onclick = () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        this.navigateToFolder(this.currentFolderId);
      };
    }
  },

  initContextMenu() {
    const menu = document.getElementById('context-menu');
    document.addEventListener('click', () => {
      if (menu) menu.style.display = 'none';
    });

    if (menu) {
      menu.querySelectorAll('.context-item').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const action = btn.getAttribute('data-action');
          menu.style.display = 'none';
          if (action && this.selectedItem) {
            this.handleItemAction(action, this.selectedItem);
          }
        };
      });
    }
  },

  initModals() {
    document.querySelectorAll('[data-modal-cancel]').forEach(btn => {
      btn.onclick = () => UI.hideAllModals();
    });
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.onclick = () => UI.hideAllModals();

    // Create Folder confirm
    const createFolderConfirm = document.getElementById('create-folder-confirm');
    const folderNameInput = document.getElementById('folder-name-input');
    if (createFolderConfirm && folderNameInput) {
      createFolderConfirm.onclick = async () => {
        const name = folderNameInput.value.trim();
        if (!name) return;
        try {
          const res = await API.createFolder(name, this.currentFolderId);
          UI.showToast(`Folder "${name}" created`, 'success');
          UI.hideAllModals();
          if (res) {
            this.addUploadedFolderLocally(res);
          }
        } catch (e) {
          UI.showToast('Could not create folder: ' + e.message, 'error');
        }
      };
    }

    // Rename confirm
    const renameConfirm = document.getElementById('rename-confirm');
    const renameInput = document.getElementById('rename-input');
    if (renameConfirm && renameInput) {
      renameConfirm.onclick = async () => {
        const newName = renameInput.value.trim();
        if (!newName || !this.selectedItem) return;
        try {
          if (this.selectedItem.type === 'folder') {
            await API.renameFolder(this.selectedItem.id, newName);
          } else {
            await API.renameFile(this.selectedItem.id, newName);
          }
          UI.showToast('Renamed successfully', 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Rename failed: ' + e.message, 'error');
        }
      };
    }

    // Move confirm
    const moveConfirm = document.getElementById('move-confirm');
    if (moveConfirm) {
      moveConfirm.onclick = async () => {
        if (this.targetMoveFolderId === undefined) return;
        const selectedList = Array.from(UI.selectedItems.values());

        if (selectedList.length > 0) {
          const fileIds = selectedList.filter(i => i.type === 'file').map(i => i.id);
          const folderIds = selectedList.filter(i => i.type === 'folder').map(i => i.id);
          try {
            await API.batchMove(fileIds, folderIds, this.targetMoveFolderId);
            UI.showToast(`Moved ${selectedList.length} item(s)`, 'success');
            UI.clearSelection();
            UI.hideAllModals();
            this.refreshCurrentView();
          } catch (e) {
            UI.showToast('Batch move failed: ' + e.message, 'error');
          }
          return;
        }

        if (!this.selectedItem) return;
        try {
          if (this.selectedItem.type === 'folder') {
            await API.moveFolder(this.selectedItem.id, this.targetMoveFolderId);
          } else {
            await API.moveFile(this.selectedItem.id, this.targetMoveFolderId);
          }
          UI.showToast('Item moved', 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Move failed: ' + e.message, 'error');
        }
      };
    }

    // Lock folder confirm
    const formLock = document.getElementById('form-lock-folder');
    const btnConfirmLock = document.getElementById('btn-confirm-lock-folder');
    const handleLockSubmit = async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const pass = document.getElementById('lock-folder-pass')?.value;
      const confirmPass = document.getElementById('lock-folder-confirm-pass')?.value;
      if (!pass || pass.length < 3) {
        return UI.showToast('Folder password must be at least 3 characters', 'warning');
      }
      if (pass !== confirmPass) {
        return UI.showToast('Passwords do not match', 'error');
      }
      if (!this.selectedItem || this.selectedItem.type !== 'folder') return;
      try {
        if (btnConfirmLock) btnConfirmLock.disabled = true;
        await API.lockFolder(this.selectedItem.id, pass);
        const fid = String(this.selectedItem.id);
        this.unlockedFolders.delete(fid);
        try {
          sessionStorage.removeItem('teledrive_unlocked_' + fid);
        } catch (err) {}
        UI.showToast(`Folder "${this.selectedItem.name}" locked successfully`, 'success');
        UI.hideAllModals();
        this.refreshCurrentView();
      } catch (err) {
        UI.showToast('Failed to lock folder: ' + err.message, 'error');
      } finally {
        if (btnConfirmLock) btnConfirmLock.disabled = false;
      }
    };
    if (formLock) formLock.onsubmit = handleLockSubmit;
    if (btnConfirmLock) btnConfirmLock.onclick = handleLockSubmit;

    // Unlock folder confirm
    const formUnlock = document.getElementById('form-unlock-folder');
    const btnConfirmUnlock = document.getElementById('btn-confirm-unlock-folder');
    const handleUnlockSubmit = async (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const pass = document.getElementById('unlock-folder-pass')?.value;
      if (!pass) {
        return UI.showToast('Please enter the folder password', 'warning');
      }
      const targetFolder = this.pendingUnlockFolder || this.selectedItem;
      if (!targetFolder) return;

      try {
        if (btnConfirmUnlock) btnConfirmUnlock.disabled = true;
        await API.verifyFolderLock(targetFolder.id, pass);
        const fid = String(targetFolder.id);
        this.unlockedFolders.add(fid);
        try {
          sessionStorage.setItem('teledrive_unlocked_' + fid, '1');
        } catch (err) {}
        UI.showToast('Folder unlocked!', 'success');
        UI.hideAllModals();

        if (this.isManagingLock) {
          this.selectedItem = targetFolder;
          this.openLockFolderModal(targetFolder);
        } else {
          this.navigateToFolder(targetFolder.id);
        }
      } catch (err) {
        UI.showToast(err.message || 'Incorrect folder password', 'error');
      } finally {
        if (btnConfirmUnlock) btnConfirmUnlock.disabled = false;
      }
    };
    if (formUnlock) formUnlock.onsubmit = handleUnlockSubmit;
    if (btnConfirmUnlock) btnConfirmUnlock.onclick = handleUnlockSubmit;

    // Remove lock permanently
    const btnRemoveLock = document.getElementById('btn-remove-lock');
    if (btnRemoveLock) {
      btnRemoveLock.onclick = async (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        const pass = document.getElementById('unlock-folder-pass')?.value;
        if (!pass) {
          return UI.showToast('Enter current password to remove lock', 'warning');
        }
        const targetFolder = this.pendingUnlockFolder || this.selectedItem;
        if (!targetFolder) return;

        try {
          btnRemoveLock.disabled = true;
          await API.unlockFolderPermanently(targetFolder.id, pass);
          const fid = String(targetFolder.id);
          this.unlockedFolders.delete(fid);
          try {
            sessionStorage.removeItem('teledrive_unlocked_' + fid);
          } catch (err) {}
          UI.showToast(`Lock removed from "${targetFolder.name}"`, 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
        } catch (err) {
          UI.showToast('Failed to remove lock: ' + err.message, 'error');
        } finally {
          btnRemoveLock.disabled = false;
        }
      };
    }

    // Permanent Delete confirm
    const deleteConfirm = document.getElementById('delete-confirm');
    if (deleteConfirm) {
      deleteConfirm.onclick = async () => {
        if (!this.selectedItem) return;
        const targetItem = this.selectedItem;
        UI.hideAllModals();
        this.removeItemsLocally([targetItem]);
        try {
          UI.showToast('Deleting permanently from Telegram...', 'info');
          if (targetItem.type === 'folder') {
            await API.deleteFolder(targetItem.id, true);
          } else {
            await API.permanentDeleteFile(targetItem.id);
          }
          UI.showToast('Permanently deleted from Telegram', 'success');
        } catch (e) {
          UI.showToast('Delete failed: ' + e.message, 'error');
          this.refreshCurrentView();
        }
      };
    }
  },

  initShareModal() {
    const accessSelect = document.getElementById('share-access-select');
    const accessIcon = document.getElementById('share-access-icon-wrap');
    const accessHint = document.getElementById('share-access-hint');
    const publicSettings = document.getElementById('share-public-settings');
    const linkInput = document.getElementById('share-link-input');
    const copyBtn = document.getElementById('btn-copy-share-link');
    const copyBtnText = document.getElementById('copy-share-btn-text');
    const pwToggleBtn = document.getElementById('share-toggle-pw');
    const pwInput = document.getElementById('share-password-input');
    const expSelect = document.getElementById('share-expiration-select');
    const expStatus = document.getElementById('share-expiry-status');
    const saveBtn = document.getElementById('btn-save-share');
    const revokeBtn = document.getElementById('btn-revoke-share');

    if (accessSelect) {
      accessSelect.onchange = () => {
        const isPublic = accessSelect.value === 'public';
        const ICON_LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
        const ICON_GLOBE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
        if (accessIcon) accessIcon.innerHTML = isPublic ? ICON_GLOBE : ICON_LOCK;
        if (accessHint) {
          accessHint.textContent = isPublic
            ? 'Anyone on the internet with this link can view and download'
            : 'Only people logged into TeleDrive can access this file';
        }
        if (publicSettings) {
          publicSettings.style.display = isPublic ? 'block' : 'none';
        }
        if (isPublic && (!linkInput.value || linkInput.value.includes('Loading'))) {
          linkInput.value = 'Click "Save Changes" to generate public link';
        }
      };
    }

    if (copyBtn && linkInput) {
      copyBtn.onclick = async () => {
        const url = linkInput.value.trim();
        if (!url || url.startsWith('Click') || url.startsWith('Loading')) {
          UI.showToast('Please save changes first to get active link', 'info');
          return;
        }
        const success = await UI.copyToClipboard(url, linkInput);
        if (success) {
          if (copyBtnText) copyBtnText.textContent = 'Copied!';
          UI.showToast('Share link copied to clipboard!', 'success');
          setTimeout(() => {
            if (copyBtnText) copyBtnText.textContent = 'Copy link';
          }, 2000);
        } else {
          UI.showToast('Failed to copy share link', 'error');
        }
      };
    }

    const btnRemovePw = document.getElementById('btn-remove-share-pw');
    const pwStatus = document.getElementById('share-pw-status');

    if (btnRemovePw && pwInput && pwStatus) {
      btnRemovePw.onclick = () => {
        this.clearPasswordRequested = true;
        pwInput.value = '';
        pwInput.placeholder = 'Password will be removed upon saving';
        pwStatus.innerHTML = '<span style="color:#ea4335;">🗑️ Password will be REMOVED when you click "Save Changes"</span>';
        btnRemovePw.style.display = 'none';
      };
    }

    if (pwInput && pwStatus) {
      pwInput.oninput = () => {
        if (pwInput.value.trim() !== '') {
          this.clearPasswordRequested = false;
          pwStatus.innerHTML = '<span style="color:var(--primary-color);">🔑 New password:</span> Will be saved upon clicking "Save Changes"';
          if (btnRemovePw) btnRemovePw.style.display = 'none';
        } else if (this.clearPasswordRequested) {
          pwStatus.innerHTML = '<span style="color:#ea4335;">🗑️ Password will be REMOVED when you click "Save Changes"</span>';
        } else if (this.currentShareStatus && this.currentShareStatus.has_password) {
          pwStatus.innerHTML = '<span style="color:#34a853;">🔒 Password protection is ACTIVE</span>';
          if (btnRemovePw) btnRemovePw.style.display = 'inline-block';
        } else {
          pwStatus.innerHTML = '<span style="color:var(--text-muted);">🔓 No password protection</span>';
          if (btnRemovePw) btnRemovePw.style.display = 'none';
        }
      };
    }

    if (expSelect && expStatus) {
      expSelect.onchange = () => {
        const val = expSelect.value;
        if (val === 'never') {
          expStatus.innerHTML = '<span style="color:var(--text-muted);">● Link will not expire</span>';
        } else {
          const d = new Date();
          d.setDate(d.getDate() + Number(val));
          expStatus.innerHTML = `<span style="color:var(--primary-color);">● Will expire on:</span> ${UI.formatFullDateTime(d.toISOString())}`;
        }
      };
    }

    if (pwToggleBtn && pwInput) {
      const ICON_EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      const ICON_EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

      pwToggleBtn.onclick = () => {
        if (pwInput.type === 'password') {
          pwInput.type = 'text';
          pwToggleBtn.innerHTML = ICON_EYE_OFF;
        } else {
          pwInput.type = 'password';
          pwToggleBtn.innerHTML = ICON_EYE;
        }
      };
    }

    if (saveBtn) {
      saveBtn.onclick = async () => {
        if (!this.currentShareFile || !this.currentShareFile.id) {
          UI.showToast('No active file selected to share. Please re-open the share dialog.', 'warning');
          return;
        }
        const isShared = accessSelect ? accessSelect.value === 'public' : true;
        const password = pwInput ? pwInput.value.trim() : '';
        const expVal = expSelect ? expSelect.value : 'never';
        const expiresInDays = expVal === 'never' ? null : parseInt(expVal, 10);

        const payload = {
          is_shared: isShared,
          expires_in_days: expiresInDays
        };

        if (this.clearPasswordRequested) {
          payload.clear_password = true;
          payload.password = null;
        } else if (password) {
          payload.password = password;
        } else if (!this.currentShareStatus || !this.currentShareStatus.has_password) {
          payload.clear_password = true;
          payload.password = null;
        }

        try {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
          const data = await API.updateShareStatus(this.currentShareFile.id, payload);
          this.currentShareStatus = data;
          this.clearPasswordRequested = false;

          // Update UI directly with accurate window.location.origin URL
          const shareToken = data.share_token || data.shareToken;
          const finalUrl = shareToken
            ? `${window.location.origin}/share/${shareToken}`
            : (data.share_url || data.shareUrl || '');

          if (linkInput) {
            linkInput.value = isShared ? finalUrl : '';
          }

          if (this.currentShareFile) {
            this.currentShareFile.is_shared = isShared ? 1 : 0;
            this.currentShareFile.share_token = shareToken;
            const mapped = this.filesMap.get(String(this.currentShareFile.id));
            if (mapped) {
              mapped.is_shared = isShared ? 1 : 0;
              mapped.share_token = shareToken;
            }
            this.renderContents();
          }

          const btnRemovePw = document.getElementById('btn-remove-share-pw');
          if (pwStatus && pwInput) {
            if (data.has_password) {
              pwStatus.innerHTML = '<span style="color:#34a853;">🔒 Password protection is ACTIVE</span>';
              pwInput.value = '';
              pwInput.placeholder = 'Type new password to change (or leave blank)';
              if (btnRemovePw) btnRemovePw.style.display = 'inline-block';
            } else {
              pwStatus.innerHTML = '<span style="color:var(--text-muted);">🔓 No password protection</span>';
              pwInput.value = '';
              pwInput.placeholder = 'Set a password or leave blank';
              if (btnRemovePw) btnRemovePw.style.display = 'none';
            }
          }

          if (revokeBtn) {
            revokeBtn.style.display = isShared ? 'inline-flex' : 'none';
          }

          if (publicSettings) {
            publicSettings.style.display = isShared ? 'flex' : 'none';
          }

          const viewsEl = document.getElementById('share-stats-views');
          const dlsEl = document.getElementById('share-stats-downloads');
          const finalViews = (data.share_views !== undefined && data.share_views !== null) ? data.share_views : (data.views !== undefined ? data.views : 0);
          const finalDls = (data.share_downloads !== undefined && data.share_downloads !== null) ? data.share_downloads : (data.downloads !== undefined ? data.downloads : 0);
          if (viewsEl) viewsEl.textContent = finalViews;
          if (dlsEl) dlsEl.textContent = finalDls;

          UI.showToast(isShared ? 'Public share link generated & saved!' : 'File is now restricted', 'success');
        } catch (err) {
          console.error('[Share] Save share error:', err);
          UI.showToast('Failed to save share settings: ' + (err.message || 'Error'), 'error');
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
        }
      };
    }

    if (revokeBtn) {
      revokeBtn.onclick = async () => {
        if (!this.currentShareFile) return;
        const confirmed = await UI.confirm({
          title: 'Turn Off Sharing?',
          message: `Are you sure you want to stop sharing "${this.currentShareFile.name}"?`,
          description: 'Any existing links will stop working immediately. Nobody outside TeleDrive will be able to access this file.',
          icon: 'lock',
          confirmText: 'Turn Off Sharing',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });
        if (!confirmed) return;

        try {
          revokeBtn.disabled = true;
          await API.revokeShare(this.currentShareFile.id);
          
          const ICON_LOCK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
          if (accessSelect) accessSelect.value = 'restricted';
          if (accessIcon) accessIcon.innerHTML = ICON_LOCK;
          if (accessHint) accessHint.textContent = 'Only people logged into TeleDrive can access this file';
          if (publicSettings) publicSettings.style.display = 'none';
          if (revokeBtn) revokeBtn.style.display = 'none';
          if (linkInput) linkInput.value = '';
          if (this.currentShareFile) {
            this.currentShareFile.is_shared = 0;
            const mapped = this.filesMap.get(String(this.currentShareFile.id));
            if (mapped) mapped.is_shared = 0;
            this.renderContents();
          }
          this.currentShareStatus = { is_shared: false };

          UI.showToast('Public link revoked successfully', 'info');
        } catch (err) {
          UI.showToast('Failed to revoke link: ' + err.message, 'error');
        } finally {
          revokeBtn.disabled = false;
        }
      };
    }
  },

  initUpload() {
    const uploadBtn = document.getElementById('upload-btn');
    const dropdownMenu = document.getElementById('upload-dropdown-menu');
    const btnUploadFile = document.getElementById('btn-upload-file');
    const btnUploadFolder = document.getElementById('btn-upload-folder');
    const fabUpload = document.getElementById('fab-upload');
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');

    // Toggle dropdown menu on "New Upload" button click
    if (uploadBtn) {
      uploadBtn.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) {
          const isHidden = dropdownMenu.style.display === 'none' || !dropdownMenu.style.display;
          dropdownMenu.style.display = isHidden ? 'flex' : 'none';
        } else if (fileInput) {
          fileInput.click();
        }
      };
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (dropdownMenu && dropdownMenu.style.display !== 'none') {
        if (!dropdownMenu.contains(e.target) && !uploadBtn.contains(e.target)) {
          dropdownMenu.style.display = 'none';
        }
      }
    });

    // Option 1: Upload Files
    if (btnUploadFile) {
      btnUploadFile.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        if (fileInput) fileInput.click();
      };
    }

    // Option 2: Upload Folder
    if (btnUploadFolder) {
      btnUploadFolder.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        if (folderInput) folderInput.click();
      };
    }

    // Option 3: Remote URL Upload
    const btnRemoteUpload = document.getElementById('btn-remote-upload');
    if (btnRemoteUpload) {
      btnRemoteUpload.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) dropdownMenu.style.display = 'none';
        UI.showModal('remote-upload-modal');
        const urlInput = document.getElementById('remote-url-input');
        if (urlInput) {
          urlInput.value = '';
          setTimeout(() => urlInput.focus(), 100);
        }
        const fnInput = document.getElementById('remote-filename-input');
        if (fnInput) fnInput.value = '';
      };
    }

    // Remote URL Form Submit
    const formRemoteUpload = document.getElementById('form-remote-upload');
    if (formRemoteUpload) {
      formRemoteUpload.onsubmit = async (e) => {
        e.preventDefault();
        const url = document.getElementById('remote-url-input')?.value?.trim();
        const fileName = document.getElementById('remote-filename-input')?.value?.trim();
        if (!url) return;

        const btn = document.getElementById('btn-submit-remote-upload');
        if (btn) btn.disabled = true;

        try {
          await Upload.startRemoteDownload(url, fileName, App.currentFolderId);
          UI.hideModals();
          UI.showToast('Remote download started on VPS', 'info');
        } catch (err) {
          UI.showToast(err.message || 'Failed to start remote download', 'error');
        } finally {
          if (btn) btn.disabled = false;
        }
      };
    }

    // Mobile FAB button
    if (fabUpload) {
      fabUpload.onclick = (e) => {
        e.stopPropagation();
        if (dropdownMenu) {
          const isHidden = dropdownMenu.style.display === 'none' || !dropdownMenu.style.display;
          dropdownMenu.style.display = isHidden ? 'flex' : 'none';
        } else if (fileInput) {
          fileInput.click();
        }
      };
    }

    // Multi-file selection change
    if (fileInput) {
      fileInput.onchange = async (e) => {
        if (e.target.files && e.target.files.length > 0) {
          await Upload.addFiles(Array.from(e.target.files), this.currentFolderId);
          fileInput.value = '';
          this.refreshCurrentView();
        }
      };
    }

    // Folder selection change
    if (folderInput) {
      folderInput.onchange = async (e) => {
        if (e.target.files && e.target.files.length > 0) {
          await Upload.addFiles(Array.from(e.target.files), this.currentFolderId);
          folderInput.value = '';
          this.refreshCurrentView();
        }
      };
    }

    // Drag and Drop
    Upload.initDragDrop();
  },

  openCreateFolderModal() {
    const input = document.getElementById('folder-name-input');
    if (input) input.value = '';
    UI.showModal('create-folder-modal');
    setTimeout(() => input && input.focus(), 100);
  },

  openRenameModal(item) {
    this.selectedItem = item;
    const input = document.getElementById('rename-input');
    if (input) input.value = item.name;
    UI.showModal('rename-modal');
    setTimeout(() => input && input.focus(), 100);
  },

  async openMoveModal(item) {
    this.selectedItem = item;
    this.targetMoveFolderId = null;
    const treeContainer = document.getElementById('folder-tree');
    if (treeContainer) {
      treeContainer.innerHTML = '<div class="loading-spinner"></div>';
      UI.showModal('move-modal');
      try {
        const tree = await API.getFolderTree();
        UI.renderFolderTree(treeContainer, tree, (selectedFolderId) => {
          this.targetMoveFolderId = selectedFolderId;
        });
      } catch (e) {
        treeContainer.innerHTML = '<p class="error-text">Failed to load folders</p>';
      }
    }
  },

  openLockFolderModal(folder) {
    if (!folder) return;
    this.selectedItem = folder;
    const titleEl = document.getElementById('lock-modal-title');
    if (titleEl) titleEl.textContent = `Lock "${folder.name}"`;
    const passInput = document.getElementById('lock-folder-pass');
    const confirmInput = document.getElementById('lock-folder-confirm-pass');
    if (passInput) passInput.value = '';
    if (confirmInput) confirmInput.value = '';
    UI.showModal('lock-folder-modal');
    setTimeout(() => { if (passInput) passInput.focus(); }, 100);
  },

  openUnlockFolderModal(folder, isManagingLock = false) {
    if (!folder) return;
    this.pendingUnlockFolder = folder;
    this.isManagingLock = isManagingLock;
    const titleEl = document.getElementById('unlock-modal-title');
    const subEl = document.getElementById('unlock-modal-sub');
    const removeLockBtn = document.getElementById('btn-remove-lock');
    const unlockPassInput = document.getElementById('unlock-folder-pass');

    if (titleEl) titleEl.textContent = `Protected: "${folder.name}"`;
    if (subEl) subEl.textContent = isManagingLock ? 'Enter password to change or remove lock' : 'Enter folder password to unlock and access contents';
    if (removeLockBtn) removeLockBtn.style.display = isManagingLock ? 'inline-flex' : 'none';
    if (unlockPassInput) unlockPassInput.value = '';

    UI.showModal('unlock-folder-modal');
    setTimeout(() => { if (unlockPassInput) unlockPassInput.focus(); }, 100);
  },

  relockFolder(folderId) {
    if (!folderId) return;
    const fid = String(folderId);
    this.unlockedFolders.delete(fid);
    delete API.folderTokens[fid];
    try {
      sessionStorage.removeItem('teledrive_unlocked_' + fid);
      sessionStorage.removeItem('teledrive_ftok_' + fid);
    } catch (e) {}

    UI.showToast('Folder locked', 'info');

    if (this.currentFolderId === fid) {
      let parentId = null;
      if (this.breadcrumbs && this.breadcrumbs.length >= 2) {
        parentId = this.breadcrumbs[this.breadcrumbs.length - 2].id;
      }
      this.navigateToFolder(parentId);
    } else {
      this.refreshCurrentView();
    }
  },

  async openDeleteModal(item) {
    if (!item) return;
    this.selectedItem = item;
    const isFolder = item.type === 'folder';

    const confirmed = await UI.confirm({
      title: isFolder ? 'Permanently Delete Folder?' : 'Permanently Delete File?',
      message: `Permanently delete "${item.name}" from Telegram cloud?`,
      description: 'This action cannot be undone. All associated message parts will be deleted from Telegram.',
      icon: 'danger',
      confirmText: 'Delete Permanently',
      confirmType: 'danger',
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
      this.removeItemsLocally([item]);
      UI.showToast('Deleting permanently from Telegram...', 'info');
      if (isFolder) {
        await API.deleteFolder(item.id, true);
      } else {
        await API.permanentDeleteFile(item.id);
      }
      UI.showToast('Permanently deleted from Telegram', 'success');
    } catch (e) {
      UI.showToast('Delete failed: ' + e.message, 'error');
      this.refreshCurrentView();
    }
  },

  initSettings() {
    // Open Settings button in sidebar
    const sidebarSettingsLink = document.getElementById('sidebar-settings-link');
    if (sidebarSettingsLink) {
      sidebarSettingsLink.onclick = (e) => {
        e.preventDefault();
        this.openSettings();
      };
    }

    // Settings Logout Button
    const settingsLogoutBtn = document.getElementById('settings-logout-btn');
    if (settingsLogoutBtn) {
      settingsLogoutBtn.onclick = async () => {
        this.unlockedFolders.clear();
        sessionStorage.clear();
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete('folder');
          url.searchParams.delete('view');
          window.history.replaceState({}, '', url.pathname);
        } catch (e) {}
        UI.hideAllModals();
        await API.logout();
        UI.showToast('Logged out', 'info');
        this.showScreen('login');
      };
    }

    // Settings Tab Switching
    document.querySelectorAll('.settings-tab-btn').forEach(btn => {
      btn.onclick = () => {
        const tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.settings-tab-pane').forEach(pane => {
          pane.style.display = 'none';
          pane.classList.remove('active');
        });

        const targetPane = document.getElementById(`pane-${tab}`);
        if (targetPane) {
          targetPane.style.display = 'flex';
          targetPane.classList.add('active');
        }

        if (tab === 'webdav') {
          this.loadWebDavSettings();
        } else if (tab === 'backup') {
          this.loadBackupStatus();
        } else if (tab === 'users') {
          this.loadAdminUsers();
        }
      };
    });

    // Save Profile Action
    const btnSaveProfile = document.getElementById('btn-save-profile');
    if (btnSaveProfile) {
      btnSaveProfile.onclick = async () => {
        const name = document.getElementById('profile-name-input')?.value.trim() || '';
        const email = document.getElementById('profile-email-input')?.value.trim() || '';

        if (!email) {
          UI.showToast('Email address is required', 'warning');
          return;
        }

        btnSaveProfile.disabled = true;
        btnSaveProfile.innerHTML = '<span>Saving...</span>';

        try {
          const res = await API.updateProfile({ name, email });
          if (res?.user) {
            this.user = res.user;
            const emailDisp = document.getElementById('profile-email-display');
            if (emailDisp) emailDisp.textContent = this.user.email;
          }
          UI.showToast('Profile updated successfully!', 'success');
        } catch (err) {
          UI.showToast(err.message || 'Failed to update profile', 'error');
        } finally {
          btnSaveProfile.disabled = false;
          btnSaveProfile.innerHTML = '<span>Save Profile</span>';
        }
      };
    }

    // Open Add User Modal
    const btnOpenCreateUser = document.getElementById('btn-open-create-user');
    if (btnOpenCreateUser) {
      btnOpenCreateUser.onclick = () => {
        const emailInp = document.getElementById('create-user-email');
        const nameInp = document.getElementById('create-user-name');
        const pwInp = document.getElementById('create-user-password');
        const roleSel = document.getElementById('create-user-role');
        const quotaInp = document.getElementById('create-user-quota');

        if (emailInp) emailInp.value = '';
        if (nameInp) nameInp.value = '';
        if (pwInp) pwInp.value = '';
        if (roleSel) roleSel.value = 'user';
        if (quotaInp) quotaInp.value = '0';

        UI.showModal('create-user-modal');
        setTimeout(() => emailInp && emailInp.focus(), 100);
      };
    }

    // Submit Create User
    const btnSubmitCreateUser = document.getElementById('btn-submit-create-user');
    if (btnSubmitCreateUser) {
      btnSubmitCreateUser.onclick = async () => {
        const email = document.getElementById('create-user-email')?.value.trim() || '';
        const name = document.getElementById('create-user-name')?.value.trim() || '';
        const password = document.getElementById('create-user-password')?.value || '';
        const role = document.getElementById('create-user-role')?.value || 'user';
        const quotaGB = parseFloat(document.getElementById('create-user-quota')?.value) || 0;
        const storageLimit = Math.round(quotaGB * 1024 * 1024 * 1024);

        if (!email || !password) {
          UI.showToast('Email and initial password are required', 'warning');
          return;
        }
        if (password.length < 6) {
          UI.showToast('Password must be at least 6 characters', 'warning');
          return;
        }

        btnSubmitCreateUser.disabled = true;
        btnSubmitCreateUser.innerHTML = '<span>Creating...</span>';

        try {
          await API.createAdminUser({ email, name, password, role, storageLimit });
          UI.showToast(`User ${email} created successfully!`, 'success');
          UI.hideModal('create-user-modal');
          await this.loadAdminUsers();
        } catch (err) {
          UI.showToast(err.message || 'Failed to create user', 'error');
        } finally {
          btnSubmitCreateUser.disabled = false;
          btnSubmitCreateUser.innerHTML = '<span>Create User Account</span>';
        }
      };
    }

    // Submit Edit User
    const btnSubmitEditUser = document.getElementById('btn-submit-edit-user');
    if (btnSubmitEditUser) {
      btnSubmitEditUser.onclick = async () => {
        const id = document.getElementById('edit-user-id')?.value;
        const name = document.getElementById('edit-user-name')?.value.trim() || '';
        const role = document.getElementById('edit-user-role')?.value || 'user';
        const status = document.getElementById('edit-user-status')?.value || 'active';
        const quotaGB = parseFloat(document.getElementById('edit-user-quota')?.value) || 0;
        const storageLimit = Math.round(quotaGB * 1024 * 1024 * 1024);

        if (!id) return;

        btnSubmitEditUser.disabled = true;
        btnSubmitEditUser.innerHTML = '<span>Saving...</span>';

        try {
          await API.updateAdminUser(id, { name, role, status, storageLimit });
          UI.showToast('User updated successfully!', 'success');
          UI.hideModal('edit-user-modal');
          await this.loadAdminUsers();
        } catch (err) {
          UI.showToast(err.message || 'Failed to update user', 'error');
        } finally {
          btnSubmitEditUser.disabled = false;
          btnSubmitEditUser.innerHTML = '<span>Save Changes</span>';
        }
      };
    }

    // Submit Reset User Password
    const btnSubmitResetUserPw = document.getElementById('btn-submit-reset-user-pw');
    if (btnSubmitResetUserPw) {
      btnSubmitResetUserPw.onclick = async () => {
        const id = document.getElementById('reset-pw-user-id')?.value;
        const password = document.getElementById('reset-user-new-pw')?.value || '';

        if (!id || !password) {
          UI.showToast('Please enter a new password', 'warning');
          return;
        }
        if (password.length < 6) {
          UI.showToast('Password must be at least 6 characters', 'warning');
          return;
        }

        btnSubmitResetUserPw.disabled = true;
        btnSubmitResetUserPw.innerHTML = '<span>Setting...</span>';

        try {
          await API.resetAdminUserPassword(id, password);
          UI.showToast('Password reset successfully!', 'success');
          UI.hideModal('reset-user-password-modal');
        } catch (err) {
          UI.showToast(err.message || 'Failed to reset password', 'error');
        } finally {
          btnSubmitResetUserPw.disabled = false;
          btnSubmitResetUserPw.innerHTML = '<span>Set Password</span>';
        }
      };
    }

    // Password Eye Toggles
    document.querySelectorAll('.btn-toggle-pass').forEach(btn => {
      btn.onclick = () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (input) {
          if (input.type === 'password') {
            input.type = 'text';
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>`;
            btn.title = 'Hide Password';
          } else {
            input.type = 'password';
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>`;
            btn.title = 'Show Password';
          }
        }
      };
    });

    // Change Account Password Action
    const btnSavePass = document.getElementById('btn-save-password');
    if (btnSavePass) {
      btnSavePass.onclick = async () => {
        const curr = document.getElementById('settings-current-pass')?.value || '';
        const next = document.getElementById('settings-new-pass')?.value || '';
        const conf = document.getElementById('settings-confirm-pass')?.value || '';

        if (!curr || !next || !conf) {
          UI.showToast('Please fill in all password fields', 'warning');
          return;
        }
        if (next !== conf) {
          UI.showToast('New passwords do not match!', 'error');
          return;
        }
        if (next.length < 6) {
          UI.showToast('New password must be at least 6 characters long', 'warning');
          return;
        }

        btnSavePass.disabled = true;
        btnSavePass.innerHTML = '<span>Saving...</span>';

        try {
          await API.changePassword(curr, next);
          UI.showToast('Password changed successfully!', 'success');
          document.getElementById('settings-current-pass').value = '';
          document.getElementById('settings-new-pass').value = '';
          document.getElementById('settings-confirm-pass').value = '';
        } catch (err) {
          UI.showToast(err.message || 'Failed to change password. Current password may be incorrect.', 'error');
        } finally {
          btnSavePass.disabled = false;
          btnSavePass.innerHTML = '<span>Save New Password</span>';
        }
      };
    }

    // Test Telegram Connection
    const btnTestTg = document.getElementById('btn-test-tg');
    if (btnTestTg) {
      btnTestTg.onclick = async () => {
        const apiId = document.getElementById('settings-tg-api-id')?.value.trim();
        const apiHash = document.getElementById('settings-tg-api-hash')?.value.trim();
        const botToken = document.getElementById('settings-tg-bot-token')?.value.trim();
        const channelId = document.getElementById('settings-tg-channel-id')?.value.trim();

        if (!apiId || !apiHash || !botToken || !channelId) {
          UI.showToast('Please enter all Telegram credentials first', 'warning');
          return;
        }

        btnTestTg.disabled = true;
        btnTestTg.innerHTML = '<span>Testing...</span>';
        const bannerDot = document.getElementById('tg-status-dot');
        const bannerTitle = document.getElementById('tg-status-title');
        const bannerSub = document.getElementById('tg-status-sub');

        try {
          const res = await API.testTelegramSettings({ apiId, apiHash, botToken, channelId });
          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          if (bannerTitle) bannerTitle.textContent = `Connected (@${res.bot?.username || 'Bot'})`;
          if (bannerSub) bannerSub.textContent = 'Telegram MTProto handshake & channel access verified!';
          UI.showToast('Telegram connection test passed successfully!', 'success');
        } catch (err) {
          if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
          if (bannerTitle) bannerTitle.textContent = 'Connection Test Failed';
          if (bannerSub) bannerSub.textContent = err.message || 'Could not verify credentials';
          UI.showToast('Telegram test failed: ' + err.message, 'error');
        } finally {
          btnTestTg.disabled = false;
          btnTestTg.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>Test Connection</span>';
        }
      };
    }

    // Save & Reconnect Telegram Settings
    const btnSaveTg = document.getElementById('btn-save-tg');
    if (btnSaveTg) {
      btnSaveTg.onclick = async () => {
        const apiId = document.getElementById('settings-tg-api-id')?.value.trim();
        const apiHash = document.getElementById('settings-tg-api-hash')?.value.trim();
        const botToken = document.getElementById('settings-tg-bot-token')?.value.trim();
        const channelId = document.getElementById('settings-tg-channel-id')?.value.trim();

        if (!apiId || !apiHash || !botToken || !channelId) {
          UI.showToast('All Telegram fields are required', 'warning');
          return;
        }

        btnSaveTg.disabled = true;
        btnSaveTg.innerHTML = '<span>Saving & Reconnecting...</span>';

        try {
          const res = await API.updateTelegramSettings({ apiId, apiHash, botToken, channelId });
          const bannerDot = document.getElementById('tg-status-dot');
          const bannerTitle = document.getElementById('tg-status-title');
          const bannerSub = document.getElementById('tg-status-sub');

          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          if (bannerTitle) bannerTitle.textContent = `Connected as @${res.bot?.username || 'Bot'}`;
          if (bannerSub) bannerSub.textContent = 'Settings saved to .env and client connected!';

          UI.showToast('Telegram settings updated & saved!', 'success');
        } catch (err) {
          UI.showToast('Save failed: ' + err.message, 'error');
        } finally {
          btnSaveTg.disabled = false;
          btnSaveTg.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/></svg>Save & Reconnect</span>';
        }
      };
    }

    // Appearance Theme Switchers inside settings
    const themeBtnLight = document.getElementById('theme-btn-light');
    const themeBtnDark = document.getElementById('theme-btn-dark');

    if (themeBtnLight) {
      themeBtnLight.onclick = () => {
        this.setTheme('light');
        themeBtnLight.classList.add('active');
        if (themeBtnDark) themeBtnDark.classList.remove('active');
      };
    }
    if (themeBtnDark) {
      themeBtnDark.onclick = () => {
        this.setTheme('dark');
        themeBtnDark.classList.add('active');
        if (themeBtnLight) themeBtnLight.classList.remove('active');
      };
    }

    // View Preference Switchers
    const viewPrefGrid = document.getElementById('view-pref-grid');
    const viewPrefList = document.getElementById('view-pref-list');

    if (viewPrefGrid) {
      viewPrefGrid.onclick = () => {
        this.viewMode = 'grid';
        this.saveUserPreference('view_mode', 'grid');
        viewPrefGrid.classList.add('active');
        if (viewPrefList) viewPrefList.classList.remove('active');
        this.renderContents();
      };
    }
    if (viewPrefList) {
      viewPrefList.onclick = () => {
        this.viewMode = 'list';
        this.saveUserPreference('view_mode', 'list');
        viewPrefList.classList.add('active');
        if (viewPrefGrid) viewPrefGrid.classList.remove('active');
        this.renderContents();
      };
    }

    // Upload & Chunk Size Preferences
    const prefChunkSize = document.getElementById('pref-chunk-size');
    const prefConcurrent = document.getElementById('pref-concurrent-chunks');

    if (prefChunkSize) {
      const customWrap = document.getElementById('pref-custom-chunk-wrap');
      const customInput = document.getElementById('pref-custom-chunk-input');
      const savedChunkSize = localStorage.getItem('teledrive_chunk_size') || '314572800';

      const presetValues = ['52428800', '104857600', '314572800', '524288000', '1073741824', '1610612736', '2039480320'];
      if (presetValues.includes(savedChunkSize)) {
        prefChunkSize.value = savedChunkSize;
        if (customWrap) customWrap.style.display = 'none';
      } else {
        prefChunkSize.value = 'custom';
        if (customWrap) customWrap.style.display = 'flex';
        if (customInput) customInput.value = Math.round(parseInt(savedChunkSize, 10) / (1024 * 1024)) || 250;
      }

      prefChunkSize.onchange = () => {
        if (prefChunkSize.value === 'custom') {
          if (customWrap) customWrap.style.display = 'flex';
          if (customInput) {
            customInput.focus();
            const mb = Math.min(1900, Math.max(5, parseInt(customInput.value, 10) || 250));
            customInput.value = mb;
            this.saveUserPreference('chunk_size', String(mb * 1024 * 1024));
          }
          UI.showToast('Custom chunk size mode enabled', 'info');
        } else {
          if (customWrap) customWrap.style.display = 'none';
          this.saveUserPreference('chunk_size', prefChunkSize.value);
          UI.showToast('Upload chunk size preference saved!', 'success');
        }
      };

      if (customInput) {
        customInput.oninput = () => {
          let mb = parseInt(customInput.value, 10);
          if (!isNaN(mb) && mb >= 5 && mb <= 1900) {
            this.saveUserPreference('chunk_size', String(mb * 1024 * 1024));
          }
        };
        customInput.onchange = () => {
          let mb = parseInt(customInput.value, 10);
          if (isNaN(mb) || mb < 5) mb = 5;
          if (mb > 1900) mb = 1900;
          customInput.value = mb;
          this.saveUserPreference('chunk_size', String(mb * 1024 * 1024));
          UI.showToast(`Custom chunk size set to ${mb} MB!`, 'success');
        };
      }
    }

    if (prefConcurrent) {
      prefConcurrent.value = localStorage.getItem('teledrive_concurrent_chunks') || '2';
      prefConcurrent.onchange = () => {
        this.saveUserPreference('concurrent_chunks', prefConcurrent.value);
        UI.showToast('Parallel upload streams preference saved!', 'success');
      };
    }

    // Keep Screen Awake Preference
    const prefWakeLock = document.getElementById('pref-wake-lock');
    if (prefWakeLock) {
      prefWakeLock.checked = localStorage.getItem('teledrive_wake_lock') !== 'false';
      prefWakeLock.onchange = () => {
        const enabled = prefWakeLock.checked;
        this.saveUserPreference('wake_lock', enabled ? 'true' : 'false');
        if (!enabled && typeof Upload !== 'undefined' && Upload.releaseWakeLock) {
          Upload.releaseWakeLock();
        } else if (enabled && typeof Upload !== 'undefined' && Upload.isUploading) {
          Upload.acquireWakeLock();
        }
        UI.showToast(enabled ? 'Keep Screen Awake enabled for uploads!' : 'Keep Screen Awake disabled', 'info');
      };
    }

    // Clear Cache Action
    const btnClearCache = document.getElementById('btn-clear-cache');
    if (btnClearCache) {
      btnClearCache.onclick = async () => {
        btnClearCache.disabled = true;
        btnClearCache.innerHTML = '<span>Clearing...</span>';
        try {
          const res = await API.clearCache();
          UI.showToast(res.message || 'Decryption cache cleared!', 'success');
          const cacheSizeEl = document.getElementById('settings-cache-size');
          if (cacheSizeEl) cacheSizeEl.textContent = '0 B';
        } catch (err) {
          UI.showToast('Failed to clear cache: ' + err.message, 'error');
        } finally {
          btnClearCache.disabled = false;
          btnClearCache.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>Clear Local Cache</span>';
        }
      };
    }

    // Telegram Cloud Backup Now button
    const btnCloudBackup = document.getElementById('btn-cloud-backup-now');
    if (btnCloudBackup) {
      btnCloudBackup.onclick = async () => {
        btnCloudBackup.disabled = true;
        btnCloudBackup.innerHTML = '<span>Backing up...</span>';
        try {
          UI.showToast('Creating encrypted cloud snapshot & uploading to Telegram...', 'info');
          const res = await API.backupNow();
          UI.showToast(res.message || 'Encrypted cloud backup created successfully!', 'success');
          this.loadBackupStatus();
        } catch (err) {
          UI.showToast('Cloud backup failed: ' + err.message, 'error');
        } finally {
          btnCloudBackup.disabled = false;
          btnCloudBackup.innerHTML = '<span><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>Backup Now</span>';
        }
      };
    }

    // Export Database button
    const btnExportDb = document.getElementById('btn-export-db');
    if (btnExportDb) {
      btnExportDb.onclick = async () => {
        try {
          UI.showToast('Generating database backup...', 'info');
          const res = await fetch('/api/settings/export-db', {
            headers: {
              'Authorization': `Bearer ${API.token || ''}`
            }
          });
          if (!res.ok) {
            let errorMsg = 'Failed to download database';
            try {
              const err = await res.json();
              errorMsg = err.error || errorMsg;
            } catch (e) {}
            throw new Error(errorMsg);
          }
          const blob = await res.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = `teledrive-backup-${new Date().toISOString().slice(0, 10)}.db`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          a.remove();
          UI.showToast('Database exported successfully!', 'success');
        } catch (e) {
          UI.showToast('Export failed: ' + e.message, 'error');
        }
      };
    }

    // Import Database trigger & upload
    const btnImportTrigger = document.getElementById('btn-import-db-trigger');
    const inputImportDb = document.getElementById('import-db-file');
    if (btnImportTrigger && inputImportDb) {
      btnImportTrigger.onclick = () => inputImportDb.click();

      inputImportDb.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const confirmed = await UI.confirm({
          title: 'Restore Database Backup?',
          message: `Are you sure you want to restore database from "${file.name}"?`,
          description: 'Warning: This will overwrite the current database file. TeleDrive will reload automatically once restored.',
          icon: 'warning',
          confirmText: 'Restore & Overwrite',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) {
          inputImportDb.value = '';
          return;
        }

        btnImportTrigger.disabled = true;
        btnImportTrigger.innerHTML = '<span>Restoring...</span>';
        UI.showToast('Restoring database backup and verifying tables... Please wait.', 'info', 10000);

        try {
          const res = await API.importDatabase(file);
          UI.showToast(res.message || 'Database restored successfully! Reloading...', 'success', 4000);
          setTimeout(() => window.location.reload(), 1500);
        } catch (err) {
          UI.showToast('Database restore failed: ' + (err.message || 'Invalid SQLite file'), 'error', 6000);
          btnImportTrigger.disabled = false;
          btnImportTrigger.innerHTML = '<span>Restore Backup File</span>';
          inputImportDb.value = '';
        }
      };
    }

    // WebDAV Settings Save Button
    const btnSaveWebdav = document.getElementById('btn-save-webdav');
    if (btnSaveWebdav) {
      btnSaveWebdav.onclick = async () => {
        const enabled = document.getElementById('webdav-enabled')?.checked;
        const permissionMode = document.getElementById('webdav-permission-mode')?.value || 'full';
        const username = document.getElementById('webdav-username')?.value.trim() || 'admin';
        const password = document.getElementById('webdav-password')?.value || '';

        btnSaveWebdav.disabled = true;
        btnSaveWebdav.innerHTML = '<span>Saving...</span>';

        try {
          const res = await API.updateWebDavSettings({
            enabled,
            permissionMode,
            username,
            password: password || undefined
          });
          UI.showToast(res.message || 'WebDAV settings updated successfully!', 'success');
          if (password) {
            const passInput = document.getElementById('webdav-password');
            if (passInput) passInput.value = '';
          }
          await this.loadWebDavSettings();
        } catch (err) {
          UI.showToast('Failed to update WebDAV settings: ' + err.message, 'error');
        } finally {
          btnSaveWebdav.disabled = false;
          btnSaveWebdav.innerHTML = '<span>Save WebDAV Settings</span>';
        }
      };
    }

    // WebDAV Test Credentials Button
    const btnTestWebdav = document.getElementById('btn-test-webdav');
    if (btnTestWebdav) {
      btnTestWebdav.onclick = async () => {
        const username = document.getElementById('webdav-username')?.value.trim() || 'admin';
        let password = document.getElementById('webdav-password')?.value || '';

        if (!password) {
          const promptedPass = prompt(`Enter password to test WebDAV connection for user "${username}":`);
          if (!promptedPass) return;
          password = promptedPass;
        }

        btnTestWebdav.disabled = true;
        btnTestWebdav.innerHTML = '<span>Testing...</span>';

        try {
          const res = await API.testWebDavAuth(username, password);
          if (res.success) {
            UI.showToast(res.message || 'WebDAV credentials verified successfully!', 'success');
          } else {
            UI.showToast(res.error || 'Authentication failed', 'error');
          }
        } catch (err) {
          UI.showToast(err.message || 'WebDAV Authentication failed. Please check password.', 'error');
        } finally {
          btnTestWebdav.disabled = false;
          btnTestWebdav.innerHTML = '<span>Test Credentials</span>';
        }
      };
    }

    // WebDAV Reset Password to Account Password Button
    const btnResetWebdavPw = document.getElementById('btn-reset-webdav-pw');
    if (btnResetWebdavPw) {
      btnResetWebdavPw.onclick = async () => {
        const confirmed = await UI.confirm({
          title: 'Reset WebDAV Password?',
          message: 'This will remove the custom WebDAV password and revert authentication back to your main TeleDrive account password.',
          icon: 'warning',
          confirmText: 'Reset Password',
          confirmType: 'danger',
          cancelText: 'Cancel'
        });

        if (!confirmed) return;

        try {
          const res = await API.updateWebDavSettings({ resetPassword: true });
          UI.showToast(res.message || 'WebDAV password reset to Account Password!', 'success');
          const passInput = document.getElementById('webdav-password');
          if (passInput) passInput.value = '';
          await this.loadWebDavSettings();
        } catch (err) {
          UI.showToast('Failed to reset password: ' + err.message, 'error');
        }
      };
    }

    // WebDAV Copy URL Button
    const btnCopyWebdavUrl = document.getElementById('btn-copy-webdav-url');
    if (btnCopyWebdavUrl) {
      btnCopyWebdavUrl.onclick = async () => {
        const urlInput = document.getElementById('webdav-url');
        const copyTextSpan = document.getElementById('btn-copy-webdav-url-text');
        if (urlInput && urlInput.value) {
          const success = await UI.copyToClipboard(urlInput.value, urlInput);
          if (success) {
            if (copyTextSpan) copyTextSpan.textContent = 'Copied!';
            UI.showToast('WebDAV Server URL copied to clipboard!', 'success');
            setTimeout(() => {
              if (copyTextSpan) copyTextSpan.textContent = 'Copy';
            }, 2000);
          } else {
            UI.showToast('Failed to copy WebDAV URL', 'error');
          }
        }
      };
    }

    // WebDAV Instant Enable/Disable Toggle
    const toggleWebdavEnabled = document.getElementById('webdav-enabled');
    if (toggleWebdavEnabled) {
      toggleWebdavEnabled.onchange = async () => {
        try {
          await API.updateWebDavSettings({ enabled: toggleWebdavEnabled.checked });
          UI.showToast(toggleWebdavEnabled.checked ? 'WebDAV Network Drive enabled!' : 'WebDAV Network Drive disabled', 'info');
        } catch (err) {
          UI.showToast('Error updating WebDAV state: ' + err.message, 'error');
        }
      };
    }

    // WebDAV Instant Permission Mode change
    const selectWebdavMode = document.getElementById('webdav-permission-mode');
    if (selectWebdavMode) {
      selectWebdavMode.onchange = async () => {
        try {
          await API.updateWebDavSettings({ permissionMode: selectWebdavMode.value });
          UI.showToast('WebDAV Permission Mode updated!', 'info');
        } catch (err) {
          UI.showToast('Error updating permission mode: ' + err.message, 'error');
        }
      };
    }

    // WebDAV Sessions Refresh Button
    const btnRefreshWebdavSessions = document.getElementById('btn-refresh-webdav-sessions');
    if (btnRefreshWebdavSessions) {
      btnRefreshWebdavSessions.onclick = async () => {
        const iconSvg = btnRefreshWebdavSessions.querySelector('svg');
        if (iconSvg) iconSvg.classList.add('spin-refresh');
        btnRefreshWebdavSessions.disabled = true;
        try {
          await this.loadWebDavSessions(true);
        } catch (err) {
          UI.showToast('Failed to refresh devices: ' + err.message, 'error');
        } finally {
          if (iconSvg) iconSvg.classList.remove('spin-refresh');
          btnRefreshWebdavSessions.disabled = false;
        }
      };
    }
  },

  async openSettings() {
    this.initSettings();
    UI.showModal('settings-modal');

    // Default to account tab or keep selected
    const activeTabBtn = document.querySelector('.settings-tab-btn.active');
    const tabName = activeTabBtn ? activeTabBtn.getAttribute('data-tab') : 'account';
    document.querySelectorAll('.settings-tab-pane').forEach(p => {
      p.style.display = p.id === `pane-${tabName}` ? 'flex' : 'none';
    });

    // Populate user profile info
    if (this.user) {
      const emailDisp = document.getElementById('profile-email-display');
      const roleBadge = document.getElementById('profile-role-badge');
      const storageText = document.getElementById('profile-storage-text');
      const nameInput = document.getElementById('profile-name-input');
      const emailInput = document.getElementById('profile-email-input');

      if (emailDisp) emailDisp.textContent = this.user.email || '';
      if (roleBadge) {
        roleBadge.textContent = this.user.role === 'admin' ? 'Admin' : 'User';
        roleBadge.className = this.user.role === 'admin' ? 'badge-secure' : 'badge-count';
      }
      if (storageText) {
        const used = UI.formatFileSize(this.user.storage_used || 0);
        const limit = this.user.storage_limit > 0 ? UI.formatFileSize(this.user.storage_limit) : 'Unlimited';
        storageText.textContent = `${used} / ${limit}`;
      }
      if (nameInput) nameInput.value = this.user.name || '';
      if (emailInput) emailInput.value = this.user.email || '';
    }

    // Toggle Admin-only Users tab
    const tabUsersNav = document.getElementById('tab-users-nav');
    if (tabUsersNav) {
      tabUsersNav.style.display = (this.user?.role === 'admin') ? 'inline-flex' : 'none';
    }

    if (tabName === 'users' && this.user?.role === 'admin') {
      await this.loadAdminUsers();
    }

    // Sync theme buttons
    const curTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const lightBtn = document.getElementById('theme-btn-light');
    const darkBtn = document.getElementById('theme-btn-dark');
    if (lightBtn) lightBtn.classList.toggle('active', curTheme === 'light');
    if (darkBtn) darkBtn.classList.toggle('active', curTheme === 'dark');

    // Sync view buttons
    const gridBtn = document.getElementById('view-pref-grid');
    const listBtn = document.getElementById('view-pref-list');
    if (gridBtn) gridBtn.classList.toggle('active', this.viewMode === 'grid');
    if (listBtn) listBtn.classList.toggle('active', this.viewMode === 'list');

    // Sync upload preferences
    const prefChunkSize = document.getElementById('pref-chunk-size');
    const prefConcurrent = document.getElementById('pref-concurrent-chunks');
    const prefWakeLock = document.getElementById('pref-wake-lock');
    if (prefChunkSize) {
      const customWrap = document.getElementById('pref-custom-chunk-wrap');
      const customInput = document.getElementById('pref-custom-chunk-input');
      const savedChunkSize = localStorage.getItem('teledrive_chunk_size') || '314572800';
      const presetValues = ['52428800', '104857600', '314572800', '524288000', '1073741824', '1610612736', '2039480320'];
      if (presetValues.includes(savedChunkSize)) {
        prefChunkSize.value = savedChunkSize;
        if (customWrap) customWrap.style.display = 'none';
      } else {
        prefChunkSize.value = 'custom';
        if (customWrap) customWrap.style.display = 'flex';
        if (customInput) customInput.value = Math.round(parseInt(savedChunkSize, 10) / (1024 * 1024)) || 250;
      }
    }
    if (prefConcurrent) {
      prefConcurrent.value = localStorage.getItem('teledrive_concurrent_chunks') || '2';
    }
    if (prefWakeLock) {
      prefWakeLock.checked = localStorage.getItem('teledrive_wake_lock') !== 'false';
    }

    // Fetch and populate live settings data
    try {
      const data = await API.getSettings();
      if (!data) return;

      // Populate Telegram config
      if (data.telegram) {
        const apiIdInput = document.getElementById('settings-tg-api-id');
        const apiHashInput = document.getElementById('settings-tg-api-hash');
        const botTokenInput = document.getElementById('settings-tg-bot-token');
        const channelIdInput = document.getElementById('settings-tg-channel-id');

        if (apiIdInput) apiIdInput.value = data.telegram.apiId || '';
        if (apiHashInput) apiHashInput.value = data.telegram.apiHash || '';
        if (botTokenInput) botTokenInput.value = data.telegram.botToken || '';
        if (channelIdInput) channelIdInput.value = data.telegram.channelId || '';

        // Status Banner
        const bannerDot = document.getElementById('tg-status-dot');
        const bannerTitle = document.getElementById('tg-status-title');
        const bannerSub = document.getElementById('tg-status-sub');

        if (data.telegram.connected) {
          if (bannerDot) bannerDot.className = 'tg-status-dot connected';
          const uName = data.telegram.botInfo?.username ? `@${data.telegram.botInfo.username}` : 'Bot';
          if (bannerTitle) bannerTitle.textContent = `Connected to Telegram (${uName})`;
          if (bannerSub) bannerSub.textContent = `Channel ID: ${data.telegram.channelId || 'N/A'}`;
        } else {
          if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
          if (bannerTitle) bannerTitle.textContent = 'Telegram Connecting / Standby';
          if (bannerSub) bannerSub.textContent = 'Ready to sync encrypted files with Telegram MTProto.';
        }
      }

      // Populate Storage & Cache Stats
      if (data.storage) {
        const filesEl = document.getElementById('settings-storage-files');
        const bytesEl = document.getElementById('settings-storage-bytes');
        const cacheEl = document.getElementById('settings-cache-size');

        if (filesEl) filesEl.textContent = data.storage.totalFiles.toLocaleString();
        if (bytesEl) bytesEl.textContent = UI.formatFileSize(data.storage.totalBytes);
        if (cacheEl) cacheEl.textContent = `${UI.formatFileSize(data.storage.cacheBytes)} (${data.storage.cacheFiles} files)`;
      }

      await this.loadBackupStatus();
      await this.loadWebDavSettings();
    } catch (e) {
      console.warn('Could not fetch settings details:', e);
    }
  },

  async loadAdminUsers() {
    const listEl = document.getElementById('admin-users-list');
    if (!listEl) return;

    listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 13px;">Loading users...</div>';

    try {
      const res = await API.getAdminUsers();
      const users = (res && res.users) || [];

      if (users.length === 0) {
        listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 13px;">No users found.</div>';
        return;
      }

      listEl.innerHTML = '';
      users.forEach(u => {
        const isSelf = this.user && this.user.id === u.id;
        const usedBytes = u.storage_used || 0;
        const limitBytes = u.storage_limit || 0;
        const isUnlimited = limitBytes === 0;
        const pct = isUnlimited ? 0 : Math.min(100, Math.round((usedBytes / limitBytes) * 100));

        const userCard = document.createElement('div');
        userCard.className = 'admin-user-card';
        userCard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;';

        const lastLoginText = u.last_login ? UI.formatDate(u.last_login) : 'Never';
        const roleLabel = u.role === 'admin' ? 'Admin' : 'User';
        const statusClass = u.status === 'active' ? 'background: rgba(16, 185, 129, 0.15); color: #10b981;' : 'background: rgba(239, 68, 68, 0.15); color: #ef4444;';
        const roleClass = u.role === 'admin' ? 'background: rgba(99, 102, 241, 0.15); color: #6366f1;' : 'background: rgba(100, 116, 139, 0.15); color: var(--text-secondary);';

        userCard.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <div style="width: 36px; height: 36px; border-radius: 50%; background: var(--accent-color); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 15px; text-transform: uppercase; flex-shrink: 0;">
                ${(u.name || u.email || 'U')[0]}
              </div>
              <div>
                <div style="display: flex; align-items: center; gap: 6px;">
                  <strong style="font-size: 14px; color: var(--text-primary);">${u.name || u.email}</strong>
                  ${isSelf ? '<span style="font-size: 10px; padding: 1px 6px; border-radius: 8px; background: rgba(59, 130, 246, 0.15); color: #3b82f6; font-weight: 600;">You</span>' : ''}
                </div>
                <div style="font-size: 12px; color: var(--text-secondary);">${u.email}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; ${roleClass}">${roleLabel}</span>
              <span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; text-transform: capitalize; ${statusClass}">${u.status}</span>
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-secondary); flex-wrap: wrap; gap: 6px;">
            <div>
              <span>Storage: <strong>${UI.formatFileSize(usedBytes)}</strong> / ${isUnlimited ? 'Unlimited' : UI.formatFileSize(limitBytes)}</span>
              ${!isUnlimited ? ` <span style="font-size: 11px;">(${pct}%)</span>` : ''}
            </div>
            <div>Last login: <span>${lastLoginText}</span></div>
          </div>

          ${!isUnlimited ? `
          <div style="width: 100%; height: 4px; background: var(--border-color); border-radius: 2px; overflow: hidden;">
            <div style="height: 100%; width: ${pct}%; background: ${pct > 90 ? '#ef4444' : 'var(--accent-color)'}; border-radius: 2px;"></div>
          </div>` : ''}

          <div style="display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 6px; border-top: 1px solid var(--border-color); padding-top: 10px; flex-wrap: wrap;">
            <button type="button" class="btn-secondary btn-sm btn-edit-user" title="Edit User">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
              <span>Edit</span>
            </button>
            <button type="button" class="btn-secondary btn-sm btn-reset-pw" title="Reset Password">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>
              <span>Reset PW</span>
            </button>
            ${!isSelf ? `
            <button type="button" class="${u.status === 'active' ? 'btn-warning' : 'btn-success'} btn-sm btn-toggle-status" title="${u.status === 'active' ? 'Suspend User' : 'Activate User'}">
              <span>${u.status === 'active' ? 'Suspend' : 'Activate'}</span>
            </button>
            <button type="button" class="btn-danger btn-sm btn-delete-user" title="Delete User">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
              <span>Delete</span>
            </button>` : ''}
          </div>
        `;

        userCard.querySelector('.btn-edit-user')?.addEventListener('click', () => this.openEditUserModal(u));
        userCard.querySelector('.btn-reset-pw')?.addEventListener('click', () => this.openResetUserPwModal(u));
        userCard.querySelector('.btn-toggle-status')?.addEventListener('click', () => this.toggleUserStatus(u));
        userCard.querySelector('.btn-delete-user')?.addEventListener('click', () => this.deleteUser(u));

        listEl.appendChild(userCard);
      });
    } catch (err) {
      listEl.innerHTML = `<div style="padding: 20px; text-align: center; color: #ef4444; font-size: 13px;">Failed to load users: ${err.message}</div>`;
    }
  },

  openEditUserModal(user) {
    const idInp = document.getElementById('edit-user-id');
    const nameInp = document.getElementById('edit-user-name');
    const roleSel = document.getElementById('edit-user-role');
    const statusSel = document.getElementById('edit-user-status');
    const quotaInp = document.getElementById('edit-user-quota');
    const titleEl = document.getElementById('edit-user-modal-title');

    if (idInp) idInp.value = user.id;
    if (nameInp) nameInp.value = user.name || '';
    if (roleSel) roleSel.value = user.role || 'user';
    if (statusSel) statusSel.value = user.status || 'active';
    if (quotaInp) quotaInp.value = user.storage_limit > 0 ? (user.storage_limit / (1024 * 1024 * 1024)).toFixed(1) : 0;
    if (titleEl) titleEl.textContent = `Edit User: ${user.email}`;

    UI.showModal('edit-user-modal');
  },

  openResetUserPwModal(user) {
    const idInp = document.getElementById('reset-pw-user-id');
    const pwInp = document.getElementById('reset-user-new-pw');
    const titleEl = document.getElementById('reset-pw-user-title');

    if (idInp) idInp.value = user.id;
    if (pwInp) pwInp.value = '';
    if (titleEl) titleEl.textContent = `Reset Password: ${user.email}`;

    UI.showModal('reset-user-password-modal');
    setTimeout(() => pwInp && pwInp.focus(), 100);
  },

  async toggleUserStatus(user) {
    const newStatus = user.status === 'active' ? 'suspended' : 'active';
    const actionText = newStatus === 'suspended' ? 'Suspend' : 'Activate';

    const confirmed = await UI.confirm({
      title: `${actionText} User Account`,
      message: `Are you sure you want to ${actionText.toLowerCase()} user "${user.email}"?${newStatus === 'suspended' ? ' They will be immediately blocked from signing in.' : ''}`,
      confirmText: actionText,
      confirmType: newStatus === 'suspended' ? 'danger' : 'primary',
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
      await API.updateAdminUser(user.id, { status: newStatus });
      UI.showToast(`User ${user.email} is now ${newStatus}`, 'success');
      await this.loadAdminUsers();
    } catch (err) {
      UI.showToast(err.message || `Failed to ${actionText.toLowerCase()} user`, 'error');
    }
  },

  async deleteUser(user) {
    const confirmed = await UI.confirm({
      title: 'Delete User Account',
      message: `Are you sure you want to permanently delete user "${user.email}"?\n\nAll their metadata will be removed. This action cannot be undone.`,
      confirmText: 'Delete User',
      confirmType: 'danger',
      cancelText: 'Cancel'
    });

    if (!confirmed) return;

    try {
      await API.deleteAdminUser(user.id);
      UI.showToast(`User ${user.email} deleted successfully`, 'success');
      await this.loadAdminUsers();
    } catch (err) {
      UI.showToast(err.message || 'Failed to delete user', 'error');
    }
  },

  async loadWebDavSettings() {
    try {
      const urlInput = document.getElementById('webdav-url');
      if (urlInput) {
        urlInput.value = `${window.location.origin}/webdav`;
      }
      const data = await API.getWebDavSettings();
      if (!data) return;

      const enabledToggle = document.getElementById('webdav-enabled');
      const modeSelect = document.getElementById('webdav-permission-mode');
      const usernameInput = document.getElementById('webdav-username');
      const passwordInput = document.getElementById('webdav-password');
      const passwordHint = document.getElementById('webdav-pw-hint');
      const pwStatusText = document.getElementById('webdav-pw-status-text');
      const pwStatusBadge = document.getElementById('webdav-pw-status-badge');
      const btnResetPw = document.getElementById('btn-reset-webdav-pw');

      if (enabledToggle) enabledToggle.checked = !!data.enabled;
      if (modeSelect && data.permissionMode) modeSelect.value = data.permissionMode;
      if (usernameInput && data.username) usernameInput.value = data.username;
      if (urlInput && data.webdavUrl) urlInput.value = data.webdavUrl;

      if (data.hasCustomPassword) {
        if (pwStatusText) pwStatusText.textContent = 'Custom Password Active';
        if (pwStatusBadge) {
          pwStatusBadge.style.background = 'rgba(16, 185, 129, 0.15)';
          pwStatusBadge.style.color = '#10b981';
        }
        if (btnResetPw) btnResetPw.style.display = 'inline-flex';
        if (passwordInput) passwordInput.placeholder = '•••••••• (Custom password saved)';
        if (passwordHint) {
          passwordHint.textContent = 'Dedicated WebDAV password is set. Leave blank to keep existing password, or enter a new one to change.';
          passwordHint.style.color = 'var(--accent-color)';
        }
      } else {
        if (pwStatusText) pwStatusText.textContent = 'Using Account Password';
        if (pwStatusBadge) {
          pwStatusBadge.style.background = 'rgba(59, 130, 246, 0.15)';
          pwStatusBadge.style.color = '#3b82f6';
        }
        if (btnResetPw) btnResetPw.style.display = 'none';
        if (passwordInput) passwordInput.placeholder = 'Leave blank to use Account Password';
        if (passwordHint) {
          passwordHint.textContent = 'No separate WebDAV password set — sign in with your main TeleDrive account password, or type a password to customize.';
          passwordHint.style.color = 'var(--text-secondary)';
        }
      }

      await this.loadWebDavSessions();
    } catch (e) {
      console.warn('Failed to load WebDAV settings:', e);
    }
  },

  async loadWebDavSessions(showToastOnManual = false) {
    try {
      const listEl = document.getElementById('webdav-sessions-list');
      const countBadge = document.getElementById('webdav-sessions-count');
      if (!listEl) return;

      const data = await API.getWebDavSessions();
      const sessions = (data && data.sessions) || [];
      const onlineCount = sessions.filter(s => s.isOnline).length;

      if (countBadge) {
        countBadge.textContent = `${onlineCount} Active`;
        countBadge.style.color = onlineCount > 0 ? '#34c759' : 'var(--text-secondary)';
        countBadge.style.background = onlineCount > 0 ? 'rgba(52, 199, 89, 0.15)' : 'var(--bg-hover)';
      }

      const getDeviceSvg = (osType) => {
        switch (osType) {
          case 'windows':
            return '<svg viewBox="0 0 88 88" width="22" height="22" fill="#0078d4"><path d="M0 12.402l35.689-4.86.016 34.423-35.67.202L0 12.402zm35.67 33.529l.028 34.453L.028 75.48.016 46.133l35.654-.202zm4.33-39.043L87.945 0v41.527l-47.945.31V6.888zm47.973 38.64L88 88l-48.027-6.746V45.73l48.027-.202z"/></svg>';
          case 'apple':
            return '<svg viewBox="0 0 170 170" width="22" height="22" fill="var(--text-primary)"><path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.35.13-9.16-1.9-14.42-6.08-3.7-3.04-7.69-7.83-11.98-14.35-5.99-9.13-10.74-19.66-14.25-31.6-3.51-11.93-5.27-23.08-5.27-33.43 0-14.56 3.7-26.68 11.09-36.37 7.39-9.69 16.74-14.65 28.05-14.88 4.78 0 10.23 1.25 16.34 3.75 6.11 2.5 10.15 3.81 12.11 3.93 1.74-.24 5.92-1.61 12.53-4.11 6.61-2.5 12.31-3.63 17.1-3.39 12.82.76 22.84 5.68 30.08 14.77-11.3 6.85-16.84 16.3-16.62 28.36.22 9.57 3.86 17.5 10.93 23.8 7.07 6.3 15.65 9.89 25.75 10.76-2.18 6.53-4.89 13.06-8.15 19.59zM119.22 31.84c0-7.39 2.67-14.25 8.01-20.57 5.34-6.32 11.9-10.45 19.68-12.38.33 1.52.49 2.94.49 4.24 0 7.39-2.83 14.47-8.49 21.23-5.66 6.76-12.41 10.66-20.25 11.7-.22-1.42-.44-2.82-.44-4.22z"/></svg>';
          case 'android':
            return '<svg viewBox="0 0 24 24" width="22" height="22" fill="#3ddc84"><path d="M6 18c0 .55.45 1 1 1h1v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h2v3.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5V19h1c.55 0 1-.45 1-1V8H6v10zM3.5 8C2.67 8 2 8.67 2 9.5v7c0 .83.67 1.5 1.5 1.5S5 17.33 5 16.5v-7C5 8.67 4.33 8 3.5 8zm17 0c-.83 0-1.5.67-1.5 1.5v7c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5v-7c0-.83-.67-1.5-1.5-1.5zm-4.97-4.84l1.3-1.3c.2-.2.2-.51 0-.71-.2-.2-.51-.2-.71 0l-1.48 1.48C13.85 2.23 12.95 2 12 2c-.96 0-1.86.23-2.66.63L7.85.99c-.2-.2-.51-.2-.71 0-.2.2-.2.51 0 .71l1.31 1.31C6.97 4.26 6 6.01 6 8h12c0-1.99-.97-3.75-2.47-4.84zM10 5H9V4h1v1zm5 0h-1V4h1v1z"/></svg>';
          case 'linux':
            return '<svg viewBox="0 0 24 24" width="22" height="22" fill="#f39c12"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
          default:
            return '<svg viewBox="0 0 24 24" width="22" height="22" fill="var(--accent-color)"><path d="M4 6h16v12H4z M2 4c-1.11 0-2 .89-2 2v12c0 1.1.89 2 2 2h20c1.1 0 2-.9 2-2V6c0-1.11-.9-2-2-2H2zm0 14V6h20v12H2z"/></svg>';
        }
      };

      if (sessions.length === 0) {
        listEl.innerHTML = `
          <div style="padding: 16px; text-align: center; color: var(--text-secondary); font-size: 13px; background: var(--bg-card); border-radius: var(--radius-sm); border: 1px dashed var(--border-color);">
            No network devices currently connected. Connect via Windows File Explorer or iOS Files to see live session.
          </div>
        `;
      } else {
        listEl.innerHTML = sessions.map(s => {
          let statusBadge = '';
          if (s.status === 'revoked') {
            statusBadge = '<span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(255, 69, 58, 0.15); color: #ff453a; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;"><span style="width:6px; height:6px; border-radius:50%; background:#ff453a;"></span>Disconnected</span>';
          } else if (s.isOnline) {
            statusBadge = '<span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(52, 199, 89, 0.15); color: #34c759; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;"><span style="width:6px; height:6px; border-radius:50%; background:#34c759;"></span>Online</span>';
          } else {
            statusBadge = '<span style="font-size: 11px; padding: 2px 8px; border-radius: 4px; background: rgba(255, 179, 0, 0.15); color: #ffb300; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;"><span style="width:6px; height:6px; border-radius:50%; background:#ffb300;"></span>Idle</span>';
          }

          const actionBtn = s.status === 'revoked'
            ? `<button type="button" class="btn-secondary btn-unrevoke-session" data-session-id="${s.id}" style="padding: 4px 10px; font-size: 11px; color: var(--accent-color);"><span>Re-allow</span></button>`
            : `<button type="button" class="btn-secondary btn-revoke-session" data-session-id="${s.id}" style="padding: 4px 10px; font-size: 11px; color: #ff453a;"><span>Disconnect</span></button>`;

          let timeAgo = 'Just now';
          if (s.lastActiveAgoSeconds > 60) {
            const mins = Math.floor(s.lastActiveAgoSeconds / 60);
            timeAgo = `${mins}m ago`;
          }

          return `
            <div class="webdav-session-card" style="padding: 10px 12px; background: var(--bg-hover); display: flex; align-items: center; justify-content: space-between; gap: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 200px;">
                <div style="width: 34px; height: 34px; border-radius: 8px; background: var(--bg-card); display: flex; align-items: center; justify-content: center; flex-shrink: 0; border: 1px solid var(--border-color);">
                  ${getDeviceSvg(s.osType)}
                </div>
                <div style="min-width: 0; flex: 1;">
                  <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <strong style="font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px;">${s.clientName}</strong>
                    ${statusBadge}
                  </div>
                  <p style="font-size: 11px; margin: 3px 0 0; color: var(--text-secondary); line-height: 1.4; word-break: break-word;">
                    IP: <code>${s.ip}</code> · User: <strong>${s.username}</strong> · Last active: ${timeAgo} · <em>${s.lastAction || 'Active'}</em>
                  </p>
                </div>
              </div>
              <div style="flex-shrink: 0; margin-left: auto;">
                ${actionBtn}
              </div>
            </div>
          `;
        }).join('');

        // Attach Revoke & Unrevoke handlers
        listEl.querySelectorAll('.btn-revoke-session').forEach(btn => {
          btn.onclick = async () => {
            const sId = btn.getAttribute('data-session-id');
            try {
              btn.disabled = true;
              await API.revokeWebDavSession(sId);
              UI.showToast('Device session disconnected!', 'info');
              this.loadWebDavSessions();
            } catch (err) {
              UI.showToast('Failed to disconnect device: ' + err.message, 'error');
              btn.disabled = false;
            }
          };
        });

        listEl.querySelectorAll('.btn-unrevoke-session').forEach(btn => {
          btn.onclick = async () => {
            const sId = btn.getAttribute('data-session-id');
            try {
              btn.disabled = true;
              await API.unrevokeWebDavSession(sId);
              UI.showToast('Device re-allowed!', 'success');
              this.loadWebDavSessions();
            } catch (err) {
              UI.showToast('Failed to re-allow device: ' + err.message, 'error');
              btn.disabled = false;
            }
          };
        });
      }

      if (showToastOnManual) {
        UI.showToast('Connected devices list refreshed!', 'info');
      }
    } catch (e) {
      console.warn('Failed to load WebDAV sessions:', e);
    }
  },

  async loadBackupStatus() {
    try {
      const statusEl = document.getElementById('backup-status-text');
      const listContainer = document.getElementById('cloud-backups-container');
      const listEl = document.getElementById('cloud-backups-list');
      if (!statusEl) return;

      const data = await API.getBackupStatus();
      if (data && data.latestBackup) {
        const timeAgo = UI.formatDate(data.latestBackup.created_at);
        statusEl.innerHTML = `Last backup created: <strong>${timeAgo}</strong> (${UI.formatFileSize(data.latestBackup.size)} encrypted snapshot · Msg #${data.latestBackup.telegram_message_id})`;
      } else {
        statusEl.innerHTML = 'Automatic schedule active. First automated cloud backup will run within 24h.';
      }

      if (listContainer && listEl) {
        if (data && data.history && data.history.length > 0) {
          listContainer.style.display = 'block';
          listEl.innerHTML = data.history.map(b => {
            const timeStr = UI.formatDate(b.created_at);
            const sizeStr = UI.formatFileSize(b.size);
            return `
              <div class="cache-action-box" style="padding: 10px 14px; background: var(--bg-hover);">
                <div>
                  <strong style="font-size: 13px;">${b.file_name}</strong>
                  <p style="font-size: 12px; margin: 2px 0 0; color: var(--text-secondary);">
                    ${timeStr} · ${sizeStr} · Telegram Msg #${b.telegram_message_id}
                  </p>
                </div>
                <button type="button" class="btn-secondary btn-restore-cloud-backup" data-msg-id="${b.telegram_message_id}" style="padding: 6px 12px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px;">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                  <span>Restore</span>
                </button>
              </div>
            `;
          }).join('');

          // Attach restore handlers
          listEl.querySelectorAll('.btn-restore-cloud-backup').forEach(btn => {
            btn.onclick = async () => {
              const msgId = btn.getAttribute('data-msg-id');
              const confirmed = await UI.confirm({
                title: 'Restore Database from Cloud?',
                message: `Are you sure you want to restore database from Telegram Cloud Backup (Msg #${msgId})?`,
                description: 'TeleDrive will download the encrypted backup from Telegram, decrypt it using your master encryption key, and replace the database.',
                icon: 'warning',
                confirmText: 'Restore & Reload',
                confirmType: 'danger',
                cancelText: 'Cancel'
              });

              if (!confirmed) return;

              btn.disabled = true;
              btn.innerHTML = '<span>Restoring...</span>';
              UI.showToast('Downloading & decrypting cloud backup from Telegram...', 'info', 10000);

              try {
                const res = await API.restoreCloudBackup(msgId);
                UI.showToast(res.message || 'Database restored successfully! Reloading...', 'success', 4000);
                setTimeout(() => window.location.reload(), 1500);
              } catch (err) {
                UI.showToast('Cloud restore failed: ' + err.message, 'error', 6000);
                btn.disabled = false;
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg><span>Restore</span>';
              }
            };
          });
        } else {
          listContainer.style.display = 'none';
        }
      }
    } catch (e) {
      console.warn('Failed to load backup status:', e);
    }
  },

  sortItems() {
    const isAsc = this.sortOrder === 'asc';
    const mult = isAsc ? 1 : -1;

    this.folders.sort((a, b) => {
      if (this.sortBy === 'name') return mult * (a.name || '').localeCompare(b.name || '');
      if (this.sortBy === 'date') return mult * (new Date(a.updated_at || a.created_at || 0) - new Date(b.updated_at || b.created_at || 0));
      return (a.name || '').localeCompare(b.name || '');
    });

    this.files.sort((a, b) => {
      if (this.sortBy === 'name') return mult * (a.name || '').localeCompare(b.name || '');
      if (this.sortBy === 'date') return mult * (new Date(a.updated_at || a.created_at || 0) - new Date(b.updated_at || b.created_at || 0));
      if (this.sortBy === 'size') return mult * ((a.size || 0) - (b.size || 0));
      return (a.name || '').localeCompare(b.name || '');
    });
  },

  initRealtimeEvents() {
    if (this._eventSource) {
      try { this._eventSource.close(); } catch (e) {}
      this._eventSource = null;
    }

    if (!API.token) return;

    try {
      const url = `/api/realtime/events?token=${encodeURIComponent(API.token)}`;
      const es = new EventSource(url);
      this._eventSource = es;

      es.addEventListener('file_uploaded', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.file) return;
          this.addUploadedFileLocally(data.file);
        } catch (err) {
          console.warn('[Realtime] file_uploaded error:', err);
        }
      });

      es.addEventListener('remote_upload_progress', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.taskId && window.Upload && typeof window.Upload.handleRemoteProgress === 'function') {
            window.Upload.handleRemoteProgress(data);
          }
        } catch (err) {
          console.warn('[Realtime] remote_upload_progress error:', err);
        }
      });

      es.addEventListener('remote_upload_completed', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.taskId && window.Upload && typeof window.Upload.handleRemoteCompleted === 'function') {
            window.Upload.handleRemoteCompleted(data);
          }
        } catch (err) {
          console.warn('[Realtime] remote_upload_completed error:', err);
        }
      });

      es.addEventListener('file_deleted', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.fileId) return;
          this.removeFileLocally(data.fileId);
        } catch (err) {
          console.warn('[Realtime] file_deleted error:', err);
        }
      });

      es.addEventListener('file_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.file) return;
          this.updateFileLocally(data.file);
        } catch (err) {
          console.warn('[Realtime] file_updated error:', err);
        }
      });

      es.addEventListener('folder_created', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.folder) return;
          this.addUploadedFolderLocally(data.folder);
        } catch (err) {
          console.warn('[Realtime] folder_created error:', err);
        }
      });

      es.addEventListener('folder_deleted', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.folderId) return;
          this.removeFolderLocally(data.folderId);
        } catch (err) {
          console.warn('[Realtime] folder_deleted error:', err);
        }
      });

      es.addEventListener('folder_updated', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || !data.folder) return;
          this.updateFolderLocally(data.folder);
        } catch (err) {
          console.warn('[Realtime] folder_updated error:', err);
        }
      });

      es.addEventListener('trash_emptied', () => {
        if (this.currentView === 'trash') {
          this.files = [];
          this.folders = [];
          this.renderContents();
        }
        this.loadStorageStats();
      });

      es.onerror = () => {
        // EventSource automatically retries
      };
    } catch (e) {
      console.warn('[Realtime] Failed to initialize SSE:', e);
    }
  },

  updateSortButtonsUI() {
    document.querySelectorAll('.sort-btn').forEach(btn => {
      const sort = btn.getAttribute('data-sort');
      const label = sort.charAt(0).toUpperCase() + sort.slice(1);
      if (this.sortBy === sort) {
        btn.classList.add('active');
        const arrow = this.sortOrder === 'asc' ? '↑' : '↓';
        btn.innerHTML = `${label} <span class="sort-arrow">${arrow}</span>`;
      } else {
        btn.classList.remove('active');
        btn.innerHTML = label;
      }
    });
  },

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const isInputActive = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || (document.activeElement && document.activeElement.isContentEditable);

      // 1. Ctrl+A / Cmd+A -> Select all items in view (when not typing in an input)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        if (!isInputActive) {
          e.preventDefault();
          const allItems = [...this.folders, ...this.files];
          UI.selectAll(allItems);
          return;
        }
      }

      // 2. Escape -> Close modals / Close preview / Clear selection
      if (e.key === 'Escape') {
        const anyModal = document.querySelector('.modal.visible');
        if (anyModal) {
          UI.hideAllModals();
          return;
        }
        const previewOverlay = document.getElementById('preview-overlay');
        if (previewOverlay && previewOverlay.style.display !== 'none') {
          if (typeof Preview !== 'undefined' && Preview.close) Preview.close();
          return;
        }
        if (UI.selectedItems.size > 0) {
          UI.clearSelection();
          return;
        }
      }

      // 3. Delete / Backspace -> Trash or Delete selected items
      if ((e.key === 'Delete' || (e.key === 'Backspace' && (e.ctrlKey || e.metaKey))) && !isInputActive) {
        if (UI.selectedItems.size > 0) {
          e.preventDefault();
          const actionDelete = document.getElementById('action-delete');
          const actionPermanentDelete = document.getElementById('action-permanent-delete');
          if (this.currentView === 'trash' && actionPermanentDelete && actionPermanentDelete.style.display !== 'none') {
            actionPermanentDelete.click();
          } else if (actionDelete && actionDelete.style.display !== 'none') {
            actionDelete.click();
          }
          return;
        }
      }

      // 4. F2 -> Rename selected item
      if (e.key === 'F2' && !isInputActive) {
        if (UI.selectedItems.size === 1) {
          e.preventDefault();
          const selected = Array.from(UI.selectedItems.values())[0];
          const fullItem = selected.type === 'folder' ? this.foldersMap.get(selected.id) : this.filesMap.get(selected.id);
          if (fullItem) this.openRenameModal(fullItem);
          return;
        }
      }

      // 5. Space -> Quick Preview single selected file
      if (e.key === ' ' && !isInputActive) {
        const previewOverlay = document.getElementById('preview-overlay');
        if (!previewOverlay || previewOverlay.style.display === 'none') {
          if (UI.selectedItems.size === 1) {
            const selected = Array.from(UI.selectedItems.values())[0];
            if (selected.type === 'file') {
              e.preventDefault();
              const file = this.filesMap.get(selected.id);
              if (file && typeof Preview !== 'undefined' && Preview.open) Preview.open(file);
              return;
            }
          }
        }
      }
    });
  },

  setTheme(theme, sync = true) {
    document.documentElement.classList.add('theme-transition');
    void document.documentElement.offsetHeight;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('teledrive_theme', theme);
    this.updateThemeToggleIcon(theme);
    if (sync) {
      this.saveUserPreference('theme', theme);
    }
    setTimeout(() => {
      document.documentElement.classList.remove('theme-transition');
    }, 240);
  },

  initTheme() {
    const saved = localStorage.getItem('teledrive_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    this.updateThemeToggleIcon(saved);
  },

  updateThemeToggleIcon(theme) {
    const themeToggle = document.getElementById('theme-toggle');
    if (!themeToggle) return;
    if (theme === 'dark') {
      themeToggle.title = 'Switch to Light Mode';
      themeToggle.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
    } else {
      themeToggle.title = 'Switch to Dark Mode';
      themeToggle.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
    }
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    this.setTheme(next);
  },

  async loadUserPreferences() {
    try {
      const data = await API.getPreferences();
      if (data && data.preferences) {
        const p = data.preferences;
        if (p.theme && (p.theme === 'light' || p.theme === 'dark')) {
          this.setTheme(p.theme, false);
        }
        if (p.view_mode && (p.view_mode === 'grid' || p.view_mode === 'list')) {
          this.viewMode = p.view_mode;
          localStorage.setItem('teledrive_view_mode', p.view_mode);
        }
        if (p.sort_by) {
          this.sortBy = p.sort_by;
          localStorage.setItem('teledrive_sort_by', p.sort_by);
        }
        if (p.sort_order) {
          this.sortOrder = p.sort_order;
          localStorage.setItem('teledrive_sort_order', p.sort_order);
        }
        if (p.chunk_size) {
          localStorage.setItem('teledrive_chunk_size', p.chunk_size);
        }
        if (p.concurrent_chunks) {
          localStorage.setItem('teledrive_concurrent_chunks', p.concurrent_chunks);
        }
        if (p.wake_lock !== undefined && p.wake_lock !== null) {
          localStorage.setItem('teledrive_wake_lock', p.wake_lock);
        }

        this.updateSortButtonsUI();
      }
    } catch (e) {
      console.warn('[Preferences] Could not load preferences from server:', e.message);
    }
  },

  async saveUserPreference(key, value) {
    localStorage.setItem(`teledrive_${key}`, String(value));
    try {
      await API.updatePreferences({ [key]: value });
    } catch (e) {
      console.warn(`[Preferences] Failed to sync ${key} to server:`, e.message);
    }
  },

  async saveUserPreferences(obj) {
    for (const [k, v] of Object.entries(obj)) {
      localStorage.setItem(`teledrive_${k}`, String(v));
    }
    try {
      await API.updatePreferences(obj);
    } catch (e) {
      console.warn('[Preferences] Failed to sync preferences to server:', e.message);
    }
  }
};

// Start App when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
