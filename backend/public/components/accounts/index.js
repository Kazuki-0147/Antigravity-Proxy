/**
 * 账号管理页面组件
 */

import { Component } from '../../core/component.js';
import { store } from '../../core/store.js';
import { commands } from '../../commands/index.js';
import { formatTime } from '../../utils/format.js';
import { toast } from '../../ui/toast.js';

export class AccountsPage extends Component {
  render() {
    const { list, loading } = store.get('accounts') || {};
    const accounts = list || [];

    return `
      <div class="accounts-page">
        <div class="card mb-4">
          <div class="flex justify-between items-center mb-4">
            <span class="text-secondary">共 ${accounts.length} 个账号</span>
            <div class="flex gap-2">
              <button class="btn btn-primary btn-sm" data-cmd="oauth:open">
                + OAuth 添加
              </button>
              <button class="btn btn-sm" data-cmd="accounts:refresh-all" ${loading ? 'disabled' : ''}>
                ${loading ? '<span class="spinner"></span>' : ''} 刷新全部
              </button>
            </div>
          </div>

          <!-- 快速添加表单 -->
          <form id="addAccountForm" class="form-row mb-4"
                style="padding-bottom:20px; border-bottom:1px solid var(--color-border)">
            <div class="form-group">
              <label class="form-label">Email</label>
              <input id="addEmail" class="form-input" placeholder="user@gmail.com" required />
            </div>
            <div class="form-group" style="flex:2">
              <label class="form-label">Refresh Token</label>
              <input id="addRefresh" class="form-input font-mono" placeholder="1//..." required />
            </div>
            <button class="btn btn-primary" type="submit" style="align-self:flex-end">
              快速添加
            </button>
          </form>

          <!-- 账号列表 -->
          <div class="table-wrapper">
            <table class="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Email</th>
                  <th>状态</th>
                  <th>层级</th>
                  <th>配额</th>
                  <th>错误</th>
                  <th>最后使用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${this._renderRows(accounts, loading)}
              </tbody>
            </table>
          </div>
        </div>
        
        <!-- Dialogs 必须在同一个顶级容器内，否则 _patchDOM 无法更新它们 -->
        ${this._renderOAuthDialog()}
        ${this._renderQuotaDialog()}
      </div>
    `;
  }

  _renderRows(accounts, loading) {
    if (loading && accounts.length === 0) {
      return `
        <tr>
          <td colspan="8" class="text-center" style="padding:48px">
            <div class="spinner"></div>
          </td>
        </tr>
      `;
    }

    if (accounts.length === 0) {
      return `
        <tr>
          <td colspan="8" class="text-center text-secondary" style="padding:48px">
            暂无账号
          </td>
        </tr>
      `;
    }

    return accounts.map(a => this._renderAccountRow(a)).join('');
  }

  _renderAccountRow(a) {
    const status = a.status || 'unknown';
    const badgeClass = {
      active: 'badge-success',
      disabled: 'badge-warning',
      error: 'badge-danger'
    }[status] || 'badge-neutral';

    const statusText = {
      active: '正常',
      disabled: '已禁用',
      error: '异常'
    }[status] || '未知';

    const quota = typeof a.quota_remaining === 'number'
      ? a.quota_remaining.toFixed(2)
      : '-';

    return `
      <tr data-account-id="${a.id}">
        <td class="mono">${this._escape(a.id)}</td>
        <td>${this._escape(a.email)}</td>
        <td><span class="badge ${badgeClass}">${statusText}</span></td>
        <td class="mono">${this._escape(a.tier || '-')}</td>
        <td class="mono">${quota}</td>
        <td class="mono ${a.error_count > 0 ? 'text-danger' : ''}">${a.error_count || 0}</td>
        <td class="mono" style="font-size:11px">${formatTime(a.last_used_at)}</td>
        <td>
          <div class="actions">
            <button class="btn btn-sm btn-icon" 
                    data-cmd="accounts:refresh" 
                    data-id="${a.id}" 
                    title="刷新 Token">↻</button>
            <button class="btn btn-sm btn-icon" 
                    data-cmd="accounts:view-quota" 
                    data-id="${a.id}" 
                    title="查看配额">📊</button>
            <button class="btn btn-sm ${status === 'active' ? 'btn-danger' : ''}" 
                    data-cmd="accounts:toggle-status" 
                    data-id="${a.id}" 
                    data-status="${status}">
              ${status === 'active' ? '禁用' : '启用'}
            </button>
            <button class="btn btn-sm btn-danger btn-icon" 
                    data-cmd="accounts:delete" 
                    data-id="${a.id}"
                    data-email="${this._escape(a.email)}"
                    title="删除">✕</button>
          </div>
        </td>
      </tr>
    `;
  }

  _renderOAuthDialog() {
    const oauth = store.get('dialogs.oauth') || {};
    const { port, step } = oauth;

    return `
      <dialog id="oauthDialog">
        <div class="dialog-header">
          <div class="dialog-title">OAuth 添加账号</div>
          <div class="dialog-subtitle">通过 Google 授权添加 Gemini API 账号</div>
        </div>
        <div class="dialog-body">
          <div class="flex gap-3 items-center mb-4" 
               style="padding:16px; background:var(--color-surface-2); border-radius:var(--radius-md)">
            <button class="btn btn-primary" data-cmd="oauth:start">
              1. 打开授权页面
            </button>
            <span class="text-secondary" style="font-size:12px">
              端口：<code class="font-mono">${port || '-'}</code>
            </span>
          </div>
          <div class="form-group">
            <label class="form-label">
              2. 粘贴浏览器地址栏的回调 URL（即使页面打不开也没关系）
            </label>
            <textarea id="oauthCallback" 
                      class="form-textarea" 
                      placeholder="http://localhost:xxxxx/oauth-callback?code=..."></textarea>
          </div>
        </div>
        <div class="dialog-footer">
          <button class="btn" data-cmd="oauth:close">取消</button>
          <button class="btn btn-primary" data-action="oauth-exchange">交换并创建账号</button>
        </div>
      </dialog>
    `;
  }

  _renderQuotaDialog() {
    const quota = store.get('dialogs.quota') || {};
    const { open, account, data, loading } = quota;

    let content = '';
    if (loading) {
      content = `
        <div class="loading-placeholder">
          <div class="spinner spinner-lg"></div>
          <span>正在加载配额数据...</span>
        </div>
      `;
    } else if (data) {
      const quotaData = data?.data || data;
      const quotas = quotaData?.quotas || {};
      const overallQuota = typeof quotaData?.overallQuota === 'number' && Number.isFinite(quotaData.overallQuota)
        ? Math.max(0, Math.min(1, quotaData.overallQuota))
        : null;
      const overallText = overallQuota === null ? '-' : `${(overallQuota * 100).toFixed(2)}%`;
      const overallReset = this._escape(formatTime(quotaData?.resetTime));

      const summary = `
        <div class="quota-summary">
          <div class="quota-card">
            <div class="quota-card-label">总体剩余</div>
            <div class="quota-card-value">${this._escape(overallText)}</div>
          </div>
          <div class="quota-card">
            <div class="quota-card-label">最近重置</div>
            <div class="quota-card-value quota-card-value--mono">${overallReset}</div>
          </div>
        </div>
      `;

      if (Object.keys(quotas).length === 0) {
        content = `
          ${summary}
          <div class="text-center text-secondary quota-empty">无配额数据</div>
        `;
      } else {
        const rows = Object.entries(quotas).map(([modelId, info]) => {
          const remaining = typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction)
            ? Math.max(0, Math.min(1, info.remainingFraction))
            : null;
          const percent = remaining === null ? null : remaining * 100;
          const percentText = percent === null ? '未知' : `${percent.toFixed(2)}%`;
          const barWidth = percent === null ? 0 : Math.max(0, Math.min(100, percent));
          const barClass = remaining === null ? 'unknown' : (remaining < 0.2 ? 'danger' : (remaining < 0.5 ? 'warn' : 'good'));
          const displayName = info?.displayName || modelId;

          return `
            <tr>
              <td>
                <div class="quota-model">
                  <div class="quota-model-name">${this._escape(displayName)}</div>
                  <div class="quota-model-id mono">${this._escape(modelId)}</div>
                </div>
              </td>
              <td>
                <div class="quota-meter">
                  <div class="quota-meter-header">
                    <span class="quota-percent">${this._escape(percentText)}</span>
                    ${remaining === null ? '' : `<span class="quota-fraction mono">${remaining.toFixed(4)}</span>`}
                  </div>
                  <div class="quota-bar">
                    <span class="quota-bar-fill ${barClass}" style="width:${barWidth}%"></span>
                  </div>
                </div>
              </td>
              <td class="quota-reset mono">${formatTime(info?.resetTime)}</td>
            </tr>
          `;
        }).join('');

        content = `
          ${summary}
          <div class="table-wrapper quota-table">
            <table class="table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>剩余额度</th>
                  <th>重置时间</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        `;
      }
    } else {
      content = '<div class="text-center text-secondary" style="padding:48px">无配额数据</div>';
    }

    return `
      <dialog id="quotaDialog" class="quota-dialog">
        <div class="dialog-header">
          <div class="dialog-title">配额详情</div>
          <div class="dialog-subtitle">${this._escape(account?.email || '')}</div>
        </div>
        <div class="dialog-body">
          ${content}
        </div>
        <div class="dialog-footer">
          <button class="btn" data-cmd="accounts:close-quota">关闭</button>
        </div>
      </dialog>
    `;
  }

  onMount() {
    this.watch(['accounts', 'dialogs.oauth', 'dialogs.quota']);
  }

  onUpdate() {
    // 同步 dialog 的 open 状态
    this._syncDialogState('oauthDialog', store.get('dialogs.oauth.open'));
    this._syncDialogState('quotaDialog', store.get('dialogs.quota.open'));
  }

  _syncDialogState(dialogId, shouldBeOpen) {
    const dialog = this.container.querySelector(`#${dialogId}`);
    if (!dialog) return;

    if (shouldBeOpen && !dialog.open) {
      dialog.showModal();
    } else if (!shouldBeOpen && dialog.open) {
      dialog.close();
    }
  }

  _bindEvents() {
    // 命令按钮点击
    this.delegate('click', '[data-cmd]', (e, target) => {
      const cmd = target.dataset.cmd;
      const id = target.dataset.id;
      const status = target.dataset.status;
      const email = target.dataset.email;

      commands.dispatch(cmd, { id, currentStatus: status, email });
    });

    // 添加账号表单提交
    this.on('#addAccountForm', 'submit', async (e) => {
      e.preventDefault();
      
      const email = this.container.querySelector('#addEmail')?.value?.trim();
      const refreshToken = this.container.querySelector('#addRefresh')?.value?.trim();

      if (!email || !refreshToken) {
        toast.error('请填写完整信息');
        return;
      }

      try {
        await commands.dispatch('accounts:create', { email, refreshToken });
        
        // 清空表单
        const form = this.container.querySelector('#addAccountForm');
        if (form) form.reset();
      } catch (error) {
        // 错误已在 command 中处理
      }
    });

    // OAuth 交换按钮
    this.on('[data-action="oauth-exchange"]', 'click', async () => {
      const callbackUrl = this.container.querySelector('#oauthCallback')?.value || '';
      
      if (!callbackUrl) {
        toast.error('请粘贴回调URL');
        return;
      }

      try {
        await commands.dispatch('oauth:exchange', { callbackUrl });
      } catch (error) {
        toast.error(error.message);
      }
    });

    // Dialog 背景点击关闭
    this.on('dialog', 'click', (e) => {
      if (e.target.tagName === 'DIALOG') {
        const dialogId = e.target.id;
        if (dialogId === 'oauthDialog') {
          commands.dispatch('oauth:close');
        } else if (dialogId === 'quotaDialog') {
          commands.dispatch('accounts:close-quota');
        }
      }
    });

    // ESC 关闭 dialog
    this.on('dialog', 'cancel', (e) => {
      e.preventDefault();
      const dialogId = e.target.id;
      if (dialogId === 'oauthDialog') {
        commands.dispatch('oauth:close');
      } else if (dialogId === 'quotaDialog') {
        commands.dispatch('accounts:close-quota');
      }
    });
  }
}

export default AccountsPage;
