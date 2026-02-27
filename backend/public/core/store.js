/**
 * 响应式状态管理 Store
 * 支持路径访问、订阅通知、批量更新
 */

class Store {
  constructor(initialState) {
    this._state = this._deepClone(initialState);
    this._listeners = new Map();  // path -> Set<callback>
    this._batchQueue = [];
    this._batching = false;
  }

  /**
   * 获取状态（支持路径访问）
   * @param {string} path - 点分隔路径，如 'accounts.list'
   * @returns {any} 状态值的深拷贝
   */
  get(path) {
    if (!path) return this._deepClone(this._state);
    const value = this._getByPath(this._state, path);
    // 返回深拷贝以防止外部修改
    return value !== undefined ? this._deepClone(value) : undefined;
  }

  /**
   * 设置状态（自动触发订阅通知）
   * @param {string} path - 点分隔路径
   * @param {any} value - 新值
   */
  set(path, value) {
    const oldValue = this._getByPath(this._state, path);
    
    // 无变化不触发
    if (this._deepEqual(oldValue, value)) return;

    this._setByPath(this._state, path, this._deepClone(value));

    if (this._batching) {
      this._batchQueue.push(path);
    } else {
      this._notify(path);
    }
  }

  /**
   * 更新状态（使用函数）
   * @param {string} path - 点分隔路径
   * @param {Function} updater - 接收当前值，返回新值
   */
  update(path, updater) {
    const current = this.get(path);
    const newValue = updater(current);
    this.set(path, newValue);
  }

  /**
   * 批量更新（合并通知，减少重渲染）
   * @param {Function} fn - 在批量模式下执行的函数
   */
  batch(fn) {
    this._batching = true;
    try {
      fn();
    } finally {
      this._batching = false;
      // 去重并通知
      const paths = [...new Set(this._batchQueue)];
      this._batchQueue = [];
      paths.forEach(path => this._notify(path));
    }
  }

  /**
   * 订阅状态变化
   * @param {string} path - 要监听的路径
   * @param {Function} callback - 变化时调用，接收新值
   * @returns {Function} 取消订阅函数
   */
  subscribe(path, callback) {
    if (!this._listeners.has(path)) {
      this._listeners.set(path, new Set());
    }
    this._listeners.get(path).add(callback);

    // 返回取消订阅函数
    return () => {
      const listeners = this._listeners.get(path);
      if (listeners) {
        listeners.delete(callback);
        if (listeners.size === 0) {
          this._listeners.delete(path);
        }
      }
    };
  }

  /**
   * 通知订阅者（包括父路径和子路径）
   * @private
   */
  _notify(changedPath) {
    this._listeners.forEach((callbacks, subscribedPath) => {
      // 检查路径是否匹配（包含关系）
      // 例如：changedPath='accounts.list' 应该通知 'accounts' 和 'accounts.list'
      if (changedPath.startsWith(subscribedPath) ||
          subscribedPath.startsWith(changedPath) ||
          subscribedPath === changedPath) {
        const value = this.get(subscribedPath);
        callbacks.forEach(cb => {
          try {
            cb(value);
          } catch (err) {
            console.error(`Store subscriber error for path "${subscribedPath}":`, err);
          }
        });
      }
    });
  }

  /**
   * 深拷贝
   * @private
   */
  _deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return obj;
    }
  }

  /**
   * 通过路径获取值
   * @private
   */
  _getByPath(obj, path) {
    return path.split('.').reduce((current, key) => {
      return current !== null && current !== undefined ? current[key] : undefined;
    }, obj);
  }

  /**
   * 通过路径设置值
   * @private
   */
  _setByPath(obj, path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    
    let current = obj;
    for (const key of keys) {
      if (current[key] === undefined || current[key] === null) {
        current[key] = {};
      }
      current = current[key];
    }
    
    current[lastKey] = value;
  }

  /**
   * 深度比较
   * @private
   */
  _deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== 'object' || typeof b !== 'object') return a === b;
    
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  /**
   * 重置状态到初始值
   * @param {string} path - 可选，指定路径
   */
  reset(path) {
    if (path) {
      const initialValue = this._getByPath(this._initialState, path);
      this.set(path, initialValue);
    } else {
      this._state = this._deepClone(this._initialState);
      this._notify('');
    }
  }

  /**
   * 获取调试用的状态快照
   */
  getSnapshot() {
    return this._deepClone(this._state);
  }
}

// 创建全局 Store 实例
export const store = new Store({
  // 用户状态
  user: null,
  
  // 当前激活的 Tab
  activeTab: 'dashboard',
  
  // 仪表盘数据
  dashboard: {
    data: null,
    loading: false,
    error: null,
    settings: {
      global: 0.2,
      flash: 0.2,
      pro: 0.2,
      claude: 0.2,
      image: 0.2
    },
    settingsLoading: false,
    settingsSaving: false
  },
  
  // 账号管理
  accounts: {
    list: [],
    loading: false,
    error: null,
    selectedIds: []  // 批量操作选中的账号ID
  },
  
  // 日志查看
  logs: {
    list: [],
    loading: false,
    error: null,
    filters: {
      model: '',
      status: '',
      requestId: ''
    },
    pagination: {
      page: 1,
      pageSize: 50,
      total: 0
    }
  },
  
  // 统计数据
  stats: {
    data: null,
    modelUsage: []
  },
  
  // 弹窗状态
  dialogs: {
    oauth: {
      open: false,
      step: 1,
      port: null,
      authUrl: '',
      callbackUrl: ''
    },
    quota: {
      open: false,
      accountId: null,
      account: null,
      data: null,
      loading: false
    }
  },
  
// 主题
  theme: localStorage.getItem('theme') || 'light'
});

// 开发模式下暴露到全局方便调试
if (typeof window !== 'undefined') {
  window.__STORE__ = store;
}

export default store;
