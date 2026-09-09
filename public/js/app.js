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

  async init() {
    try {
      this.initTheme();

      // Check setup status first
      let setupStatus = null;
      try {
        setupStatus = await API.getSetupStatus();
      } catch (e) {
        console.warn('Could not fetch setup status, showing setup wizard:', e);
      }

      if (!setupStatus || !setupStatus.isComplete) {
        this.showScreen('setup');
        Setup.init();
        return;
      }

      // If setup is complete, initialize app listeners & UI
      this.initEventListeners();
      this.updateSortButtonsUI();
      this.initSidebar();
      this.initBottomNav();
      this.initSearch();
      this.initFileContainerEvents();
      this.initDragAndDropMove();
      this.initContextMenu();
      this.initModals();
      this.initUpload();
      this.initSettings();
      this.initKeyboardShortcuts();

      // Check auth
      if (API.token) {
        try {
          await API.verifyAuth();
          this.showScreen('app');
          await this.navigateToFolder(null);
          this.loadStorageStats();
        } catch (authErr) {
          this.showScreen('login');
        }
      } else {
        this.showScreen('login');
      }
    } catch (e) {
      console.error('App init error:', e);
      this.showScreen('setup');
      Setup.init();
    }
  },

  showScreen(screen) {
    const loaderEl = document.getElementById('app-loader');
    const setupEl = document.getElementById('setup-screen');
    const loginEl = document.getElementById('login-screen');
    const appEl = document.getElementById('app-screen');
    
    if (loaderEl) loaderEl.style.display = 'none';
    if (setupEl) setupEl.style.display = screen === 'setup' ? 'flex' : 'none';
    if (loginEl) loginEl.style.display = screen === 'login' ? 'flex' : 'none';
    if (appEl) appEl.style.display = screen === 'app' ? 'flex' : 'none';
  },

  // ─── View & Navigation ─────────────────────────────────────────────
  async navigateToFolder(folderId) {
    this.currentView = 'drive';
    this.currentFolderId = folderId;
    this.updateSidebarActive('drive');
    UI.clearSelection();
    await this.loadFolderContents(folderId);
  },

  async navigateToView(view) {
    this.currentView = view;
    UI.clearSelection();
    this.updateSidebarActive(view);

    switch (view) {
      case 'drive':
        await this.navigateToFolder(null);
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
      case 'settings':
        this.openSettings();
        break;
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

  async loadFolderContents(folderId) {
    UI.showSkeletons();
    try {
      const data = await API.getFolderContents(folderId);
      this.folders = data.folders || [];
      this.files = data.files || [];
      this.breadcrumbs = data.breadcrumbs || [{ id: null, name: 'My Drive' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      UI.showToast('Failed to load files: ' + e.message, 'error');
    } finally {
      UI.hideSkeletons();
    }
  },

  async loadStarredFiles() {
    UI.showSkeletons();
    try {
      this.folders = [];
      this.files = await API.getFiles({ starred: true });
      this.breadcrumbs = [{ id: null, name: 'Starred' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      UI.showToast('Failed to load starred files', 'error');
    } finally {
      UI.hideSkeletons();
    }
  },

  async loadRecentFiles() {
    UI.showSkeletons();
    try {
      this.folders = [];
      this.files = await API.getFiles();
      this.breadcrumbs = [{ id: null, name: 'Recent Files' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      UI.showToast('Failed to load recent files', 'error');
    } finally {
      UI.hideSkeletons();
    }
  },

  async loadTrashedFiles() {
    UI.showSkeletons();
    try {
      this.folders = [];
      this.files = await API.getFiles({ trashed: true });
      this.breadcrumbs = [{ id: null, name: 'Trash' }];
      this.renderContents();
      UI.renderBreadcrumbs(this.breadcrumbs);
    } catch (e) {
      UI.showToast('Failed to load trash', 'error');
    } finally {
      UI.hideSkeletons();
    }
  },

  async loadStorageStats() {
    try {
      const stats = await API.getStorageStats();
      const storageText = document.getElementById('storage-text');
      if (storageText) {
        storageText.textContent = `${stats.totalFiles} files · ${UI.formatFileSize(stats.totalSize)} used`;
      }
    } catch (e) {
      // Ignore
    }
  },

  // ─── Rendering ─────────────────────────────────────────────────────
  renderContents() {
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
    this.folders.forEach(f => this.foldersMap.set(f.id, { ...f, type: 'folder' }));
    this.files.forEach(f => this.filesMap.set(f.id, { ...f, type: 'file' }));

    // Filter files
    let filteredFiles = this.files;
    if (this.activeFilter && this.activeFilter !== 'all') {
      filteredFiles = this.files.filter(f => UI.getFileTypeCategory(f.mime_type) === this.activeFilter);
    }

    // Sort files & folders
    this.sortArray(this.folders);
    this.sortArray(filteredFiles);

    const hasFolders = this.folders.length > 0;
    const hasFiles = filteredFiles.length > 0;

    if (!hasFolders && !hasFiles) {
      foldersSection.style.display = 'none';
      filesSection.style.display = 'none';
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';

    // Render Folders
    if (hasFolders) {
      foldersSection.style.display = 'block';
      foldersGrid.innerHTML = this.folders.map(f => UI.renderFolderCard(f)).join('');
    } else {
      foldersSection.style.display = 'none';
    }

    // Render Files
    if (hasFiles) {
      filesSection.style.display = 'block';
      filesGrid.innerHTML = filteredFiles.map(f => UI.renderFileCard(f)).join('');
      UI.loadVideoThumbnails(filteredFiles);
    } else {
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
        const id = selectBtn.getAttribute('data-id');
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
        const id = moreBtn.getAttribute('data-id');
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
          const id = card.getAttribute('data-id');
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
          const lastIdx = allCards.findIndex(c => c.getAttribute('data-id') === this.lastSelectedId);
          const currIdx = allCards.findIndex(c => c === card);
          if (lastIdx !== -1 && currIdx !== -1) {
            const start = Math.min(lastIdx, currIdx);
            const end = Math.max(lastIdx, currIdx);
            for (let i = start; i <= end; i++) {
              const c = allCards[i];
              const cid = c.getAttribute('data-id');
              const ctype = c.getAttribute('data-type');
              const citem = ctype === 'folder' ? this.foldersMap.get(cid) : this.filesMap.get(cid);
              UI.toggleSelection(cid, ctype, citem, true);
            }
            return;
          }
        }
      }

      // 5. If currently in selection mode, regular click on a card toggles its selection
      if (UI.selectedItems.size > 0) {
        const card = e.target.closest('.file-card, .folder-card');
        if (card) {
          const id = card.getAttribute('data-id');
          const type = card.getAttribute('data-type');
          const item = type === 'folder' ? this.foldersMap.get(id) : this.filesMap.get(id);
          UI.toggleSelection(id, type, item);
          this.lastSelectedId = id;
          return;
        }
      }

      // 6. Normal click: Folder navigates, File opens preview
      const folderCard = e.target.closest('.folder-card');
      if (folderCard) {
        const id = folderCard.getAttribute('data-id');
        this.lastSelectedId = id;
        this.navigateToFolder(id);
        return;
      }

      const fileCard = e.target.closest('.file-card');
      if (fileCard) {
        const id = fileCard.getAttribute('data-id');
        this.lastSelectedId = id;
        const file = this.filesMap.get(id);
        if (file) {
          Preview.open(file);
        }
        return;
      }
    });

    // Context menu / right-click handler (delegated)
    fileContainer.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.file-card, .folder-card');
      if (card) {
        e.preventDefault();
        e.stopPropagation();
        const id = card.getAttribute('data-id');
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
        window.open(API.getDownloadUrl(itemData.id), '_blank');
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
    } else if (action === 'move') {
      this.openMoveModal(itemData);
    } else if (action === 'trash') {
      if (itemData.type === 'file') {
        await API.trashFile(itemData.id);
        UI.showToast('Moved to Trash', 'info');
        this.refreshCurrentView();
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
        UI.showToast('Moving folder to Trash...', 'info');
        await API.deleteFolder(itemData.id);
        UI.showToast('Folder moved to Trash', 'info');
        this.refreshCurrentView();
      }
    } else if (action === 'restore') {
      if (itemData.type === 'file') {
        await API.restoreFile(itemData.id);
        UI.showToast('File restored', 'success');
        this.refreshCurrentView();
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
      copyLinkBtn.onclick = () => {
        const url = window.location.origin + API.getStreamUrl(item.id);
        navigator.clipboard.writeText(url);
        UI.showToast('Stream link copied to clipboard!', 'success');
      };
    }

    UI.showModal('file-info-modal');
  },

  async refreshCurrentView() {
    if (this.currentView === 'drive') {
      await this.loadFolderContents(this.currentFolderId);
    } else if (this.currentView === 'starred') {
      await this.loadStarredFiles();
    } else if (this.currentView === 'recent') {
      await this.loadRecentFiles();
    } else if (this.currentView === 'trash') {
      await this.loadTrashedFiles();
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
        const pwd = document.getElementById('login-password').value;
        const spinner = document.getElementById('login-spinner');
        const btn = document.getElementById('login-btn');
        if (spinner) spinner.style.display = 'inline-block';
        if (btn) btn.disabled = true;

        try {
          await API.login(pwd);
          UI.showToast('Login successful!', 'success');
          this.showScreen('app');
          await this.navigateToFolder(null);
          this.loadStorageStats();
        } catch (err) {
          UI.showToast('Invalid password', 'error');
        } finally {
          if (spinner) spinner.style.display = 'none';
          if (btn) btn.disabled = false;
        }
      };
    }

    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
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
        localStorage.setItem('teledrive_view_mode', this.viewMode);
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
          UI.showToast('Permanently deleting all items from Telegram...', 'info');
          const res = await API.emptyTrash();
          if (res.warnings && res.warnings.length > 0) {
            UI.showToast(`Deleted with warning: ${res.warnings.join('; ')}`, 'warning');
          } else {
            UI.showToast(`Permanently deleted ${res.count || 0} file(s) from Telegram`, 'success');
          }
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Failed to empty trash: ' + e.message, 'error');
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
        localStorage.setItem('teledrive_sort_by', this.sortBy);
        localStorage.setItem('teledrive_sort_order', this.sortOrder);
        this.updateSortButtonsUI();
        this.renderContents();
      };
    });

    // Action Bar actions
    const actionDownload = document.getElementById('action-download');
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

    if (actionDownload) {
      actionDownload.onclick = () => {
        const selectedFiles = Array.from(UI.selectedItems.values()).filter(i => i.type === 'file');
        if (selectedFiles.length === 0) {
          UI.showToast('No files selected to download', 'info');
          return;
        }
        if (selectedFiles.length === 1) {
          window.open(API.getDownloadUrl(selectedFiles[0].id), '_blank');
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

    if (actionTrash) {
      actionTrash.onclick = async () => {
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
          await API.batchTrash(fileIds, folderIds);
          UI.showToast(`Moved ${count} item(s) to Trash`, 'success');
          UI.clearSelection();
          await this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Failed to trash items: ' + e.message, 'error');
        }
      };
    }

    if (actionRestore) {
      actionRestore.onclick = async () => {
        const selectedItems = Array.from(UI.selectedItems.values());
        const fileIds = selectedItems.filter(i => i.type === 'file').map(i => i.id);
        if (fileIds.length === 0) return;
        try {
          await API.batchRestore(fileIds);
          UI.showToast(`Restored ${fileIds.length} file(s)`, 'success');
          UI.clearSelection();
          await this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Failed to restore files: ' + e.message, 'error');
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
          UI.showToast('Permanently deleting from Telegram...', 'info');
          const res = await API.batchDelete(fileIds, folderIds);
          if (res.warnings && res.warnings.length > 0) {
            UI.showToast(`Deleted with warning: ${res.warnings.join('; ')}`, 'warning');
          } else {
            UI.showToast(`Permanently deleted ${count} item(s) from Telegram`, 'success');
          }
          UI.clearSelection();
          await this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Failed to permanently delete items: ' + e.message, 'error');
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
          UI.showSkeletons();
          try {
            const [folderData, fileData] = await Promise.all([
              API.getFolderContents(null, query).catch(() => ({ folders: [] })),
              API.getFiles({ search: query }).catch(() => [])
            ]);
            this.folders = (folderData && folderData.folders) ? folderData.folders : [];
            this.files = Array.isArray(fileData) ? fileData : [];
            this.breadcrumbs = [{ id: null, name: `Search: "${query}"` }];
            this.renderContents();
            UI.renderBreadcrumbs(this.breadcrumbs);
          } catch (e) {
            // Ignore
          } finally {
            UI.hideSkeletons();
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
          await API.createFolder(name, this.currentFolderId);
          UI.showToast(`Folder "${name}" created`, 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
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

    // Permanent Delete confirm
    const deleteConfirm = document.getElementById('delete-confirm');
    if (deleteConfirm) {
      deleteConfirm.onclick = async () => {
        if (!this.selectedItem) return;
        try {
          UI.showToast('Deleting permanently from Telegram...', 'info');
          if (this.selectedItem.type === 'folder') {
            await API.deleteFolder(this.selectedItem.id, true);
          } else {
            await API.permanentDeleteFile(this.selectedItem.id);
          }
          UI.showToast('Permanently deleted from Telegram', 'success');
          UI.hideAllModals();
          this.refreshCurrentView();
        } catch (e) {
          UI.showToast('Delete failed: ' + e.message, 'error');
        }
      };
    }
  },

  initUpload() {
    const uploadBtn = document.getElementById('upload-btn');
    const fabUpload = document.getElementById('fab-upload');
    const fileInput = document.getElementById('file-input');

    const triggerUpload = () => {
      if (fileInput) fileInput.click();
    };

    if (uploadBtn) uploadBtn.onclick = triggerUpload;
    if (fabUpload) fabUpload.onclick = triggerUpload;

    if (fileInput) {
      fileInput.onchange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
          Upload.addFiles(Array.from(e.target.files), this.currentFolderId);
          fileInput.value = '';
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
      UI.showToast('Deleting permanently from Telegram...', 'info');
      if (isFolder) {
        await API.deleteFolder(item.id, true);
      } else {
        await API.permanentDeleteFile(item.id);
      }
      UI.showToast('Permanently deleted from Telegram', 'success');
      this.refreshCurrentView();
    } catch (e) {
      UI.showToast('Delete failed: ' + e.message, 'error');
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
      };
    });

    // Password Eye Toggles
    document.querySelectorAll('.btn-toggle-pass').forEach(btn => {
      btn.onclick = () => {
        const targetId = btn.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (input) {
          if (input.type === 'password') {
            input.type = 'text';
            btn.textContent = '🙈';
          } else {
            input.type = 'password';
            btn.textContent = '👁️';
          }
        }
      };
    });

    // Change Master Password Action
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
        if (next.length < 4) {
          UI.showToast('New password must be at least 4 characters long', 'warning');
          return;
        }

        btnSavePass.disabled = true;
        btnSavePass.innerHTML = '<span>Saving...</span>';

        try {
          await API.changePassword(curr, next);
          UI.showToast('Master password changed successfully!', 'success');
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
          if (bannerTitle) bannerTitle.textContent = `🟢 Valid Connection (@${res.bot?.username || 'Bot'})`;
          if (bannerSub) bannerSub.textContent = 'Telegram MTProto handshake & channel access verified!';
          UI.showToast('Telegram connection test passed successfully!', 'success');
        } catch (err) {
          if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
          if (bannerTitle) bannerTitle.textContent = '🔴 Connection Test Failed';
          if (bannerSub) bannerSub.textContent = err.message || 'Could not verify credentials';
          UI.showToast('Telegram test failed: ' + err.message, 'error');
        } finally {
          btnTestTg.disabled = false;
          btnTestTg.innerHTML = '<span>⚡ Test Connection</span>';
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
          if (bannerTitle) bannerTitle.textContent = `🟢 Connected as @${res.bot?.username || 'Bot'}`;
          if (bannerSub) bannerSub.textContent = 'Settings saved to .env and client connected!';

          UI.showToast('Telegram settings updated & saved!', 'success');
        } catch (err) {
          UI.showToast('Save failed: ' + err.message, 'error');
        } finally {
          btnSaveTg.disabled = false;
          btnSaveTg.innerHTML = '<span>💾 Save & Reconnect</span>';
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
        localStorage.setItem('teledrive_view_mode', 'grid');
        viewPrefGrid.classList.add('active');
        if (viewPrefList) viewPrefList.classList.remove('active');
        this.renderContents();
      };
    }
    if (viewPrefList) {
      viewPrefList.onclick = () => {
        this.viewMode = 'list';
        localStorage.setItem('teledrive_view_mode', 'list');
        viewPrefList.classList.add('active');
        if (viewPrefGrid) viewPrefGrid.classList.remove('active');
        this.renderContents();
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
          btnClearCache.innerHTML = '<span>🗑️ Clear Local Cache</span>';
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
        const confirmed = await UI.confirm({
          title: 'Restore Database Backup?',
          message: `Are you sure you want to restore database from "${file.name}"?`,
          description: 'Warning: This will overwrite the current database file. TeleDrive will restart after restoration.',
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
        btnImportTrigger.innerHTML = '<span>⏳ Restoring Database...</span>';

        try {
          const res = await API.importDatabase(file);
          UI.showToast(res.message || 'Database restored successfully!', 'success');
          setTimeout(() => window.location.reload(), 1200);
        } catch (err) {
          UI.showToast('Import failed: ' + err.message, 'error');
        } finally {
          btnImportTrigger.disabled = false;
          btnImportTrigger.innerHTML = '<span>⬆️ Choose & Restore DB</span>';
          inputImportDb.value = '';
        }
      };
    }
  },

  async openSettings() {
    UI.showModal('settings-modal');

    // Default to security tab or keep selected
    const activeTabBtn = document.querySelector('.settings-tab-btn.active');
    const tabName = activeTabBtn ? activeTabBtn.getAttribute('data-tab') : 'security';
    document.querySelectorAll('.settings-tab-pane').forEach(p => {
      p.style.display = p.id === `pane-${tabName}` ? 'flex' : 'none';
    });

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
          if (bannerTitle) bannerTitle.textContent = `🟢 Connected to Telegram (${uName})`;
          if (bannerSub) bannerSub.textContent = `Channel ID: ${data.telegram.channelId || 'N/A'}`;
        } else {
          if (bannerDot) bannerDot.className = 'tg-status-dot disconnected';
          if (bannerTitle) bannerTitle.textContent = '🟡 Telegram Connecting / Standby';
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
    } catch (e) {
      console.warn('Could not fetch settings details:', e);
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
        const previewModal = document.getElementById('preview-modal');
        if (previewModal && previewModal.classList.contains('visible')) {
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
        const previewModal = document.getElementById('preview-modal');
        if (!previewModal || !previewModal.classList.contains('visible')) {
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

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('teledrive_theme', theme);
    UI.showToast(`Theme set to ${theme}`, 'info');
  },

  initTheme() {
    const saved = localStorage.getItem('teledrive_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
  },

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    this.setTheme(next);
  }
};

// Start App when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}
