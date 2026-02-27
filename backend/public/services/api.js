/**
 * API 服务
 * 提供统一的请求处理、竞态控制、Token刷新
 */

const STORAGE_ACCESS = 'access_token';
const STORAGE_REFRESH = 'refresh_token';

class ApiService {
  constructor() {
    this._pendingRequests = new Map();
    this._refreshPromise = null;
  }

  // ============ Token 管理 ============

  getTokens() {
    return {
      accessToken: localStorage.getItem(STORAGE_ACCESS),
      refreshToken: localStorage.getItem(STORAGE_REFRESH)
    };
  }

  setTokens(accessToken, refreshToken = null) {
    if (accessToken) {
      localStorage.setItem(STORAGE_ACCESS, accessToken);
    } else {
      localStorage.removeItem(STORAGE_ACCESS);
    }

    if (refreshToken !== null) {
      if (refreshToken) {
        localStorage.setItem(STORAGE_REFRESH, refreshToken);
      } else {
        localStorage.removeItem(STORAGE_REFRESH);
      }
    }
  }

  clearTokens() {
    localStorage.removeItem(STORAGE_ACCESS);
    localStorage.removeItem(STORAGE_REFRESH);
  }

  // ============ 核心请求方法 ============

  /**
   * 发起请求
   * @param {string} path - API路径
   * @param {Object} options - 请求选项
   */
  async request(path, options = {}) {
    const {
      method = 'GET',
      body = null,
      auth = true,
      dedupKey = null,
      abortPrevious = false,
      retry = true
    } = options;

    // 竞态处理
    if (dedupKey) {
      // 如果需要取消之前的请求
      if (abortPrevious && this._pendingRequests.has(dedupKey)) {
        const pending = this._pendingRequests.get(dedupKey);
        pending.controller.abort();
        this._pendingRequests.delete(dedupKey);
      }

      // 如果不取消且已有相同请求，返回现有Promise
      if (!abortPrevious && this._pendingRequests.has(dedupKey)) {
        return this._pendingRequests.get(dedupKey).promise;
      }
    }

    const controller = new AbortController();

    const fetchPromise = this._doFetch(path, {
      method,
      body,
      auth,
      retry,
      signal: controller.signal
    });

    // 存储请求信息用于去重
    if (dedupKey) {
      const requestInfo = {
        controller,
        promise: fetchPromise
      };
      this._pendingRequests.set(dedupKey, requestInfo);

      fetchPromise.finally(() => {
        // 只有当前请求仍在map中时才删除
        if (this._pendingRequests.get(dedupKey) === requestInfo) {
          this._pendingRequests.delete(dedupKey);
        }
      });
    }

    return fetchPromise;
  }

  /**
   * 实际执行fetch
   * @private
   */
  async _doFetch(path, { method, body, auth, retry, signal }) {
    const headers = {};

    if (body !== null) {
      headers['Content-Type'] = 'application/json';
    }

    if (auth) {
      const { accessToken } = this.getTokens();
      if (accessToken) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
    }

    try {
      const res = await fetch(path, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal
      });

      // Token过期，尝试刷新
      if (res.status === 401 && auth && retry) {
        const refreshed = await this._refreshToken();
        if (refreshed) {
          return this._doFetch(path, { method, body, auth, retry: false, signal });
        }
        this.clearTokens();
        throw new Error('登录已过期，请重新登录');
      }

      const text = await res.text();
      const data = this._parseJson(text);

      if (!res.ok) {
        const msg = data?.error?.message ||
                    data?.message ||
                    (text && text.trim()) ||
                    `HTTP ${res.status}`;
        throw new Error(msg);
      }

      return data ?? text;

    } catch (err) {
      // 请求被取消
      if (err.name === 'AbortError') {
        throw new Error('请求已取消');
      }
      throw err;
    }
  }

  /**
   * 刷新Token
   * @private
   */
  async _refreshToken() {
    // 防止并发刷新
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    const { refreshToken } = this.getTokens();
    if (!refreshToken) return false;

    this._refreshPromise = (async () => {
      try {
        const res = await fetch('/admin/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken })
        });

        if (!res.ok) return false;

        const data = await res.json();
        if (data?.access_token) {
          this.setTokens(data.access_token, refreshToken);
          return true;
        }
        return false;
      } catch {
        return false;
      } finally {
        this._refreshPromise = null;
      }
    })();

    return this._refreshPromise;
  }

  /**
   * 解析JSON
   * @private
   */
  _parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // ============ 认证 API ============

  async login(password, remember = true) {
    const data = await this.request('/admin/auth/login', {
      method: 'POST',
      auth: false,
      body: { password, remember }
    });

    if (data?.access_token) {
      this.setTokens(data.access_token, data.refresh_token || null);
    }
    return data;
  }

  async getMe() {
    return this.request('/admin/auth/me');
  }

  // ============ Dashboard API ============

  async getDashboard() {
    return this.request('/admin/dashboard', {
      dedupKey: 'dashboard'
    });
  }

  async getSettings() {
    return this.request('/admin/settings', {
      dedupKey: 'admin-settings'
    });
  }

  async updateSetting(key, value) {
    return this.request('/admin/settings', {
      method: 'PUT',
      body: { key, value }
    });
  }

  // ============ 账号 API ============

  async getAccounts() {
    return this.request('/admin/accounts', {
      dedupKey: 'accounts'
    });
  }

async createAccount(email, refreshToken, projectId = null) {
    return this.request('/admin/accounts', {
      method: 'POST',
      body: { email, refresh_token: refreshToken, project_id: projectId }
    });
  }

  async updateAccountStatus(id, status) {
    return this.request(`/admin/accounts/${encodeURIComponent(id)}/status`, {
      method: 'PUT',
      body: { status }
    });
  }

  async refreshAccount(id) {
    return this.request(`/admin/accounts/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      body: {}
    });
  }

  async refreshAllAccounts() {
    return this.request('/admin/accounts/refresh-all', {
      method: 'POST',
      body: {}
    });
  }

async deleteAccount(id) {
    return this.request(`/admin/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }

  async exportAccounts() {
    return this.request('/admin/accounts/export');
  }

  async importAccounts(accounts) {
    return this.request('/admin/accounts/batch', {
      method: 'POST',
      body: { accounts }
    });
  }

  /**
   * 获取账号配额（带竞态处理）
   * 快速切换账号时，自动取消之前的请求
   */
  async getAccountQuota(id) {
    return this.request(`/admin/accounts/${encodeURIComponent(id)}/quota`, {
      dedupKey: 'account-quota',
      abortPrevious: true
    });
  }

  // ============ 日志 API ============

  async getLogs(params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        query.set(key, String(value));
      }
    }
    const url = query.toString() ? `/admin/logs?${query}` : '/admin/logs';
    return this.request(url, {
      dedupKey: 'logs',
      abortPrevious: true
    });
  }

  async getAttemptLogs(params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        query.set(key, String(value));
      }
    }
    const url = query.toString() ? `/admin/logs/attempts?${query}` : '/admin/logs/attempts';
    return this.request(url, {
      dedupKey: 'logs',
      abortPrevious: true
    });
  }

  async getStats(params = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        query.set(key, String(value));
      }
    }
    const url = query.toString() ? `/admin/stats?${query}` : '/admin/stats';
    return this.request(url, {
      dedupKey: 'stats'
    });
  }

  // ============ OAuth API ============

  async getOAuthConfig() {
    return this.request('/oauth/config');
  }

  async exchangeOAuthCode(code, port) {
    return this.request('/oauth/exchange', {
      method: 'POST',
      body: { code, port }
    });
  }
}

// 创建全局实例
export const api = new ApiService();

export default api;
