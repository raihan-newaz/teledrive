/**
 * API Client for TeleDrive
 */
const API = {
  token: localStorage.getItem('teledrive_token'),

  setToken(t) {
    this.token = t;
    if (t) {
      localStorage.setItem('teledrive_token', t);
    } else {
      localStorage.removeItem('teledrive_token');
    }
  },

  async request(method, url, body = null, options = {}) {
    const headers = { ...options.headers };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? body : null,
        ...options
      });

      const contentType = response.headers.get('content-type');
      let data = null;
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      }

      if (response.status === 401) {
        this.setToken(null);
        if (typeof App !== 'undefined' && App.showScreen) {
          App.showScreen('login');
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
    this.setToken(null);
  },

  async changePassword(currentPassword, newPassword) {
    return this.request('POST', '/api/auth/change-password', { currentPassword, newPassword });
  },

  // ─── Folders ──────────────────────────────────────────────────────
  async getFolderContents(parentId = null) {
    const query = parentId ? `?parentId=${encodeURIComponent(parentId)}` : '';
    return this.request('GET', `/api/folders${query}`);
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

  async deleteFolder(id) {
    return this.request('DELETE', `/api/folders/${id}`);
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

  async restoreFile(id) {
    return this.request('POST', `/api/files/${id}/restore`);
  },

  async getStorageStats() {
    return this.request('GET', '/api/files/stats');
  },

  getDownloadUrl(fileId) {
    return `/api/files/${fileId}/download`;
  },

  getThumbnailUrl(fileId) {
    return `/api/files/${fileId}/thumbnail`;
  },

  getStreamUrl(fileId) {
    return `/api/files/${fileId}/stream`;
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
  }
};
