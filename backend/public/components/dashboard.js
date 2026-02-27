/**
 * 仪表盘组件
 */

import { Component } from '../core/component.js';
import { store } from '../core/store.js';
import { commands } from '../commands/index.js';
import { formatNumber } from '../utils/format.js';

export class Dashboard extends Component {
  render() {
    const dashboard = store.get('dashboard') || {};
    const { data, loading, settings = {}, settingsSaving = false, settingsLoading = false } = dashboard;
    
    if (loading && !data) {
      return `
        <div class="loading-placeholder">
          <div class="spinner spinner-lg"></div>
          <span>正在加载...</span>
        </div>
      `;
    }

    const d = data || {};
    const today = d.today || {};
    const accounts = d.accounts || {};
    const pool = d.pool || {};
    const modelUsage = Array.isArray(d.modelUsage) ? d.modelUsage : [];
    const routing = Array.isArray(d.routing) ? d.routing : [];

    return `
      <div class="dashboard-page">
        <div class="stats-grid">
          ${this._renderStatCard('活跃账号', 
            `${accounts.active || 0}<span class="card-value-sub">/ ${accounts.total || 0}</span>`,
            `池中活跃 ${pool.active ?? 0} 个，平均配额 ${(pool.avgQuota ?? 0).toFixed(2)}`
          )}
          ${this._renderStatCard('今日请求',
            formatNumber(today.requests || 0),
            `成功率 ${today.successRate ?? '100'}%`
          )}
          ${this._renderStatCard('今日 Token',
            formatNumber(today.tokens || 0),
            `平均延迟 ${Math.round(today.avgLatency ?? 0)}ms`
          )}
          ${this._renderStatCard('异常账号',
            accounts.error || 0,
            '需要检查的账号',
            accounts.error > 0 ? 'text-danger' : ''
          )}
        </div>

        <div class="content-grid">
          <div class="card">
            <div class="card-header">
              <span class="card-title">模型使用统计（今日）</span>
            </div>
            ${this._renderModelUsage(modelUsage)}
          </div>

          <div class="card">
            <div class="card-header">
              <span class="card-title">API 端点</span>
            </div>
            <div class="endpoint-list">
              ${this._renderEndpoint('OpenAI 兼容', `${location.origin}/v1/chat/completions`)}
              ${this._renderEndpoint('Gemini 原生', `${location.origin}/v1beta/models/{model}:generateContent`)}
              ${this._renderEndpoint('Anthropic 兼容', `${location.origin}/v1/messages`)}
            </div>
          </div>

          <div class="card dashboard-settings-card">
            <div class="card-header">
              <span class="card-title">Quota Thresholds</span>
            </div>
            ${this._renderThresholdEditor(settings, { settingsSaving, settingsLoading })}
          </div>

          <div class="card dashboard-routing-card">
            <div class="card-header">
              <span class="card-title">Current Routing</span>
            </div>
            ${this._renderRoutingOverview(routing)}
          </div>
        </div>
      </div>
    `;
  }

  _renderRoutingOverview(routing) {
    if (!routing.length) {
      return `
        <div class="text-secondary text-center" style="padding:20px 0">
          No routing data yet
        </div>
      `;
    }

    return `
      <div class="routing-list">
        ${routing.map((item) => {
          const current = item?.currentAccount;
          const sticky = item?.sticky;
          const accountText = current?.email || (current?.id ? `#${current.id}` : '-');
          const quotaText = Number.isFinite(Number(current?.quotaRemaining))
            ? `${this._formatPercent(Number(current.quotaRemaining))}`
            : '-';
          const stickyText = sticky?.id
            ? `${sticky?.email || `#${sticky.id}`}${sticky?.switchRequired ? ' -> switch pending' : ''}`
            : 'not set';

          return `
            <div class="routing-item">
              <div class="routing-group">${this._escape(this._formatGroupName(item?.group))}</div>
              <div class="routing-account mono">${this._escape(accountText)}</div>
              <div class="routing-meta">quota ${this._escape(quotaText)} | threshold ${this._escape(this._formatPercent(item?.threshold))}</div>
              <div class="routing-sticky text-secondary">sticky: ${this._escape(stickyText)}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  _formatGroupName(group) {
    const key = String(group || '').toLowerCase();
    if (key === 'flash') return 'Gemini Flash';
    if (key === 'pro') return 'Gemini Pro';
    if (key === 'claude') return 'Claude';
    if (key === 'image') return 'Image';
    return key || 'Unknown';
  }

  _formatPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '-';
    const clamped = Math.max(0, Math.min(1, n));
    const pct = clamped * 100;
    return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
  }

  _renderThresholdEditor(settings, { settingsSaving = false, settingsLoading = false } = {}) {
    const global = this._toPercent(settings.global);
    const flash = this._toPercent(settings.flash);
    const pro = this._toPercent(settings.pro);
    const claude = this._toPercent(settings.claude);
    const image = this._toPercent(settings.image);
    const disabledAttr = settingsSaving || settingsLoading ? 'disabled' : '';
    const buttonLabel = settingsSaving ? 'Saving...' : 'Save Thresholds';

    return `
      <form class="threshold-form" data-settings-form>
        <div class="threshold-hint text-secondary">
          Per-group switch threshold (%). Requests stay on the same account for that group until threshold is reached.
        </div>
        <div class="threshold-grid">
          ${this._renderThresholdField('Global fallback', 'global', global, disabledAttr)}
          ${this._renderThresholdField('Gemini Flash', 'flash', flash, disabledAttr)}
          ${this._renderThresholdField('Gemini Pro', 'pro', pro, disabledAttr)}
          ${this._renderThresholdField('Claude', 'claude', claude, disabledAttr)}
          ${this._renderThresholdField('Image', 'image', image, disabledAttr)}
        </div>
        <div class="threshold-actions">
          <button class="btn btn-primary" type="submit" ${disabledAttr}>${buttonLabel}</button>
        </div>
      </form>
    `;
  }

  _renderThresholdField(label, key, value, disabledAttr = '') {
    return `
      <label class="form-group">
        <span class="form-label">${this._escape(label)}</span>
        <input
          class="form-input"
          type="number"
          min="0"
          max="100"
          step="0.1"
          name="${this._escape(key)}"
          value="${value}"
          ${disabledAttr}
        />
      </label>
    `;
  }

  _toPercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '20';
    const clamped = Math.max(0, Math.min(1, n));
    const pct = clamped * 100;
    return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  }

  _parsePercentToFraction(raw, fallback = 0.2) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const clampedPct = Math.max(0, Math.min(100, n));
    return clampedPct / 100;
  }

  _renderStatCard(title, value, subtitle, valueClass = '') {
    return `
      <div class="card">
        <div class="card-title">${this._escape(title)}</div>
        <div class="card-value ${valueClass}">${value}</div>
        <div class="card-subtitle">${this._escape(subtitle)}</div>
      </div>
    `;
  }

  _renderModelUsage(modelUsage) {
    if (modelUsage.length === 0) {
      return `
        <div class="text-secondary text-center" style="padding:48px 0">
          暂无数据
        </div>
      `;
    }

    return `
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>模型</th>
              <th>调用次数</th>
              <th>Token 数</th>
            </tr>
          </thead>
          <tbody>
            ${modelUsage.map(m => `
              <tr>
                <td class="mono" data-label="模型">${this._escape(m.model)}</td>
                <td data-label="调用次数">${formatNumber(m.count)}</td>
                <td data-label="Token 数">${formatNumber(m.tokens)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  _renderEndpoint(label, url) {
    return `
      <div class="endpoint-item">
        <span class="endpoint-label">${this._escape(label)}</span>
        <span class="endpoint-url">${this._escape(url)}</span>
      </div>
    `;
  }

  _bindEvents() {
    this.on('form[data-settings-form]', 'submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      if (!(form instanceof HTMLFormElement)) return;

      const data = new FormData(form);
      const current = store.get('dashboard.settings') || {};
      const thresholds = {
        global: this._parsePercentToFraction(data.get('global'), Number(current.global ?? 0.2)),
        flash: this._parsePercentToFraction(data.get('flash'), Number(current.flash ?? 0.2)),
        pro: this._parsePercentToFraction(data.get('pro'), Number(current.pro ?? 0.2)),
        claude: this._parsePercentToFraction(data.get('claude'), Number(current.claude ?? 0.2)),
        image: this._parsePercentToFraction(data.get('image'), Number(current.image ?? 0.2))
      };

      await commands.dispatch('dashboard:save-thresholds', { thresholds });
    });
  }

  onMount() {
    this.watch('dashboard');
  }
}

export default Dashboard;
