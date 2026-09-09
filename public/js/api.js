/**
 * API Client for TeleDrive
 */
const API = {
  token: localStorage.getItem('teledrive_token'),
  folderTokens: (() => {
    const tokens = {};
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && key.startsWith('teledrive_ftok_')) {
          tokens[key.replace('teledrive_ftok_', '')] = sessionStorage.getItem(key);
        }
      }
    } catch (e) {}
    return tokens;
  })(),

  setToken(t) {
    this.token = t;
    if (t) {
      localStorage.setItem('teledrive_token', t);
    } else {
      localStorage.removeItem('teledrive_token');
    }
  },

  async request(method, url, body = null, options = {}) {
    const { headers: customHeaders, ...restOptions } = options;
    const headers = { ...customHeaders };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, {
        ...restOptions,
        method,
        headers,
        body: method !== 'GET' ? body : null
      });

      const contentType = response.headers.get('content-type');
      let data = null;
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      }

      // Only wipe session if the main auth token is invalid, not on folder/share password mismatches
      if (response.status === 401) {
        const isSubPasswordCheck = url.includes('/verify-lock') || url.includes('/unlock') || url.includes('/share/public');
        if (!isSubPasswordCheck) {
          this.setToken(null);
          if (typeof App !== 'undefined' && App.showScreen) {
            App.showScreen('login');
          }
        }
        const err = new Error(data?.error || 'Unauthorized');
        err.status = 401;
        throw err;
      }

      if (!response.ok) {
        const errorMsg = data?.error || `Request failed with status ${response.status}`;
        const error = new Error(errorMsg);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (error) {
      console.error(`[API] ${method} ${url} Error:`, error);
      throw error;
    }
  },

  // ─── Setup ────────────────────────────────────────────────────────
  async getSetupStatus() {
    return this.request('GET', '/api/setup/status');
  },

  async validateTelegram(apiId, apiHash, botToken, channelId) {
    return this.request('POST', '/api/setup/validate', { apiId, apiHash, botToken, channelId });
  },

  async completeSetup(data) {
    return this.request('POST', '/api/setup/complete', data);
  },

  // ─── Auth ─────────────────────────────────────────────────────────
  async login(password) {
    const data = await this.request('POST', '/api/auth/login', { password });
    if (data && data.token) {
      this.setToken(data.token);
    }
    return data;
  },

  async verifyAuth() {
    return this.request('GET', '/api/auth/verify');
  },

  async logout() {
    try {
      await this.request('POST', '/api/auth/logout');
    } catch (e) {
      // Ignore
    }
    this.folderTokens = {};
    try {
      sessionStorage.clear();
    } catch (e) {}
    this.setToken(null);
  },

  async changePassword(currentPassword, newPassword) {
    return this.request('POST', '/api/auth/change-password', { currentPassword, newPassword });
  },

  // ─── Folders ──────────────────────────────────────────────────────
  async getFolderContents(folderId = null) {
    const fid = (folderId && folderId !== 'null') ? folderId : null;
    const qs = fid ? `?parentId=${encodeURIComponent(fid)}` : '';
    const headers = {};
    if (fid && this.folderTokens[String(fid)]) {
      headers['X-Folder-Token'] = this.folderTokens[String(fid)];
    }
    return this.request('GET', `/api/folders${qs}`, null, { headers });
  },

  async getFolderTree() {
    return this.request('GET', '/api/folders/tree');
  },

  async createFolder(name, parentId = null) {
    return this.request('POST', '/api/folders', { name, parentId });
  },

  async renameFolder(id, name) {
    return this.request('PATCH', `/api/folders/${id}`, { name });
  },

  async moveFolder(id, parent_id) {
    return this.request('PATCH', `/api/folders/${id}`, { parent_id });
  },

  async deleteFolder(id, permanent = false) {
    return this.request('DELETE', `/api/folders/${id}${permanent ? '?permanent=true' : ''}`);
  },

  async lockFolder(id, password) {
    const fid = String(id);
    delete this.folderTokens[fid];
    try {
      sessionStorage.removeItem('teledrive_ftok_' + fid);
      sessionStorage.removeItem('teledrive_unlocked_' + fid);
    } catch (e) {}
    return this.request('POST', `/api/folders/${id}/lock`, { password });
  },

  async verifyFolderLock(id, password) {
    const fid = String(id);
    const res = await this.request('POST', `/api/folders/${id}/verify-lock`, { password });
    if (res && res.folderToken) {
      this.folderTokens[fid] = res.folderToken;
      try {
        sessionStorage.setItem('teledrive_ftok_' + fid, res.folderToken);
      } catch (e) {}
    }
    return res;
  },

  async unlockFolderPermanently(id, password) {
    const fid = String(id);
    delete this.folderTokens[fid];
    try {
      sessionStorage.removeItem('teledrive_ftok_' + fid);
      sessionStorage.removeItem('teledrive_unlocked_' + fid);
    } catch (e) {}
    return this.request('POST', `/api/folders/${id}/unlock-permanently`, { password });
  },

  // ─── Files ────────────────────────────────────────────────────────
  async getFiles(params = {}) {
    const query = new URLSearchParams();
    if (params.folderId) query.append('folderId', params.folderId);
    if (params.search) query.append('search', params.search);
    if (params.type) query.append('type', params.type);
    if (params.starred) query.append('starred', 'true');
    if (params.trashed) query.append('trashed', 'true');
    const qs = query.toString() ? `?${query.toString()}` : '';
    return this.request('GET', `/api/files${qs}`);
  },

  async renameFile(id, name) {
    return this.request('PATCH', `/api/files/${id}`, { name });
  },

  async moveFile(id, folder_id) {
    return this.request('PATCH', `/api/files/${id}`, { folder_id });
  },

  async starFile(id, is_starred) {
    return this.request('PATCH', `/api/files/${id}`, { is_starred });
  },

  async trashFile(id) {
    return this.request('DELETE', `/api/files/${id}`);
  },

  async permanentDeleteFile(id) {
    return this.request('DELETE', `/api/files/${id}/permanent`);
  },

  async emptyTrash() {
    return this.request('DELETE', '/api/files/trash/empty');
  },

  async restoreFile(id) {
    return this.request('POST', `/api/files/${id}/restore`);
  },

  async batchTrash(fileIds = [], folderIds = []) {
    return this.request('POST', '/api/files/batch-trash', { fileIds, folderIds });
  },

  async batchRestore(fileIds = []) {
    return this.request('POST', '/api/files/batch-restore', { fileIds });
  },

  async batchDelete(fileIds = [], folderIds = []) {
    return this.request('POST', '/api/files/batch-delete', { fileIds, folderIds });
  },

  async batchStar(fileIds = [], isStarred = true) {
    return this.request('POST', '/api/files/batch-star', { fileIds, isStarred });
  },

  async batchMove(fileIds = [], folderIds = [], targetFolderId = null) {
    return this.request('POST', '/api/files/batch-move', { fileIds, folderIds, targetFolderId });
  },

  async getStorageStats() {
    return this.request('GET', '/api/files/stats');
  },

  getDownloadUrl(fileId) {
    const file = typeof App !== 'undefined' && App.filesMap ? App.filesMap.get(String(fileId)) : null;
    const token = file && file.folder_id ? this.folderTokens[String(file.folder_id)] : '';
    const qs = token ? `?folderToken=${encodeURIComponent(token)}` : '';
    return `/api/files/${fileId}/download${qs}`;
  },

  getThumbnailUrl(fileId) {
    const file = typeof App !== 'undefined' && App.filesMap ? App.filesMap.get(String(fileId)) : null;
    const token = file && file.folder_id ? this.folderTokens[String(file.folder_id)] : '';
    const qs = token ? `?folderToken=${encodeURIComponent(token)}` : '';
    return `/api/files/${fileId}/thumbnail${qs}`;
  },

  getStreamUrl(fileId) {
    const file = typeof App !== 'undefined' && App.filesMap ? App.filesMap.get(String(fileId)) : null;
    const token = file && file.folder_id ? this.folderTokens[String(file.folder_id)] : '';
    const qs = token ? `?folderToken=${encodeURIComponent(token)}` : '';
    return `/api/files/${fileId}/stream${qs}`;
  },

  // ─── Settings ─────────────────────────────────────────────────────
  async getSettings() {
    return this.request('GET', '/api/settings');
  },

  async testTelegramSettings(data) {
    return this.request('POST', '/api/settings/telegram/test', data);
  },

  async updateTelegramSettings(data) {
    return this.request('PUT', '/api/settings/telegram', data);
  },

  async clearCache() {
    return this.request('POST', '/api/settings/clear-cache');
  },

  getExportDbUrl() {
    return '/api/settings/export-db';
  },

  async importDatabase(file) {
    const formData = new FormData();
    formData.append('database', file);
    return this.request('POST', '/api/settings/import-db', formData);
  },

  // ─── File Sharing ──────────────────────────────────────────────────
  async getShareStatus(fileId) {
    return this.request('GET', `/api/share/file/${fileId}`);
  },

  async updateShareStatus(fileId, options) {
    return this.request('POST', `/api/share/file/${fileId}`, options);
  },

  async revokeShare(fileId) {
    return this.request('DELETE', `/api/share/file/${fileId}`);
  }
};

if (typeof window !== 'undefined') {
  window.API = API;
}
