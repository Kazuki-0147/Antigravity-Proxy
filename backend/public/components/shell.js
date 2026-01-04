/**
 * 应用外壳组件
 * 包含侧边栏导航和主内容区域
 */

import { Component } from '../core/component.js';
import { store } from '../core/store.js';
import { commands } from '../commands/index.js';

export class Shell extends Component {
  constructor(container) {
    super(container);
    this._sidebarOpen = false;
  }

  render() {
    const theme = store.get('theme');
    const activeTab = store.get('activeTab');
    const user = store.get('user');

    return `
      <div class="app-shell">
        <!-- 移动端遮罩 -->
        <div class="sidebar-backdrop" data-action="close-sidebar"></div>

        <!-- 移动端顶部栏 -->
        <div class="mobile-header">
          <div class="brand">
            <span class="brand-name">Antigravity</span>
            <span class="brand-tag">Proxy</span>
          </div>
          <div class="mobile-header-actions">
            <button class="mobile-menu-toggle" data-action="toggle-sidebar" title="菜单">
              ☰
            </button>
          </div>
        </div>

        <aside class="sidebar">
          <div class="brand">
            <span class="brand-name">Antigravity</span>
            <span class="brand-tag">Proxy</span>
          </div>

          <nav class="nav-menu">
            <div class="nav-item ${activeTab === 'dashboard' ? 'active' : ''}"
                 data-cmd="nav:change" data-tab="dashboard">
              <span class="icon">📊</span>
              <span class="nav-text">仪表盘</span>
            </div>
            <div class="nav-item ${activeTab === 'accounts' ? 'active' : ''}"
                 data-cmd="nav:change" data-tab="accounts">
              <span class="icon">👥</span>
              <span class="nav-text">账号管理</span>
            </div>
            <div class="nav-item ${activeTab === 'logs' ? 'active' : ''}"
                 data-cmd="nav:change" data-tab="logs">
              <span class="icon">📜</span>
              <span class="nav-text">请求日志</span>
            </div>
          </nav>

          <div class="sidebar-footer">
            <div class="theme-toggle" data-cmd="theme:toggle">
              <span class="icon">${theme === 'dark' ? '🌙' : '☀️'}</span>
              <span>${theme === 'dark' ? '暗色模式' : '明亮模式'}</span>
            </div>
          </div>
        </aside>

        <main class="main-content">
          <div class="page-wrapper">
            <header class="page-header">
              <h1 class="page-title">${this._getPageTitle(activeTab)}</h1>
              <div class="header-actions">
                <span class="user-info">
                  已登录：<strong>${this._escape(user?.username || 'Admin')}</strong>
                </span>
                <button class="btn btn-sm" data-cmd="data:refresh">
                  🔄 刷新
                </button>
                <button class="btn btn-sm btn-danger" data-cmd="auth:logout">
                  退出登录
                </button>
              </div>
            </header>

            <div id="pageContent" data-preserve-children="true"></div>
          </div>
        </main>
      </div>
    `;
  }

  _getPageTitle(tab) {
    const titles = {
      dashboard: '仪表盘',
      accounts: '账号管理',
      logs: '请求日志'
    };
    return titles[tab] || '';
  }

  onMount() {
    // 监听状态变化
    this.watch(['activeTab', 'theme', 'user']);
  }

  _bindEvents() {
    // 命令按钮点击
    this.delegate('click', '[data-cmd]', (e, target) => {
      const cmd = target.dataset.cmd;
      const tab = target.dataset.tab;

      commands.dispatch(cmd, { tab });

      // 移动端点击导航后自动关闭侧边栏
      if (cmd === 'nav:change') {
        this._closeSidebar();
      }
    });

    // 移动端菜单切换
    this.on('[data-action="toggle-sidebar"]', 'click', () => {
      this._toggleSidebar();
    });

    // 点击遮罩关闭侧边栏
    this.on('[data-action="close-sidebar"]', 'click', () => {
      this._closeSidebar();
    });

    // ESC 键关闭侧边栏
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._sidebarOpen) {
        this._closeSidebar();
      }
    });
  }

  _toggleSidebar() {
    if (this._sidebarOpen) {
      this._closeSidebar();
    } else {
      this._openSidebar();
    }
  }

  _openSidebar() {
    this._sidebarOpen = true;
    const sidebar = this.container.querySelector('.sidebar');
    const backdrop = this.container.querySelector('.sidebar-backdrop');
    if (sidebar) sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  _closeSidebar() {
    this._sidebarOpen = false;
    const sidebar = this.container.querySelector('.sidebar');
    const backdrop = this.container.querySelector('.sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
    document.body.style.overflow = '';
  }
}

export default Shell;
