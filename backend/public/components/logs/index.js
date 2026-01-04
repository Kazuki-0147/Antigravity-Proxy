/**
 * 日志查看页面组件
 */

import { Component } from '../../core/component.js';
import { store } from '../../core/store.js';
import { commands } from '../../commands/index.js';
import { formatTime, formatNumber } from '../../utils/format.js';
import { Pagination } from '../../ui/pagination.js';

export class LogsPage extends Component {
  constructor(container) {
    super(container);
    this._pagination = null;
  }

  render() {
    const logs = store.get('logs') || {};
    const stats = store.get('stats') || {};
    const { list = [], loading, filters = {}, pagination = {} } = logs;
    const { data: statsData, modelUsage = [] } = stats;

    return `
      <div class="logs-page">
        <!-- 统计卡片 -->
        ${statsData ? this._renderStats(statsData) : ''}
        
        <!-- 筛选器 -->
        <div class="card mb-4">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">按模型筛选</label>
              <input id="logModel" 
                     class="form-input" 
                     value="${this._escape(filters.model || '')}" 
                     placeholder="例如：gemini-2.0-flash" />
            </div>
            <div class="form-group" style="width:140px; flex:none">
              <label class="form-label">状态</label>
              <select id="logStatus" class="form-select">
                <option value="" ${!filters.status ? 'selected' : ''}>全部</option>
                <option value="success" ${filters.status === 'success' ? 'selected' : ''}>成功</option>
                <option value="error" ${filters.status === 'error' ? 'selected' : ''}>失败</option>
              </select>
            </div>
            <button class="btn btn-primary" data-action="apply-filter" style="align-self:flex-end">
              筛选
            </button>
            ${filters.model || filters.status ? `
              <button class="btn btn-sm" data-action="clear-filter" style="align-self:flex-end">
                清除筛选
              </button>
            ` : ''}
          </div>
        </div>

        <!-- 日志列表 -->
        <div class="card">
          <div class="table-wrapper">
            <table class="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th>账号</th>
                  <th>状态</th>
                  <th>Token</th>
                  <th>延迟</th>
                  <th>错误信息</th>
                </tr>
              </thead>
              <tbody>
                ${this._renderLogRows(list, loading)}
              </tbody>
            </table>
          </div>
          
          <!-- 分页 -->
          <div id="logsPagination"></div>
        </div>
      </div>
    `;
  }

  _renderStats(stats) {
    return `
      <div class="stats-grid stats-grid--logs mb-4">
        <div class="card">
          <div class="card-title">总请求</div>
          <div class="card-value">${formatNumber(stats.total || 0)}</div>
        </div>
        <div class="card">
          <div class="card-title">成功率</div>
          <div class="card-value">${stats.successRate ?? '100'}%</div>
        </div>
        <div class="card">
          <div class="card-title">平均延迟</div>
          <div class="card-value">${Math.round(stats.avgLatency || 0)}ms</div>
        </div>
      </div>
    `;
  }

  _renderLogRows(logs, loading) {
    if (loading && logs.length === 0) {
      return `
        <tr>
          <td colspan="7" class="text-center" style="padding:48px">
            <div class="spinner"></div>
          </td>
        </tr>
      `;
    }

    if (logs.length === 0) {
      return `
        <tr>
          <td colspan="7" class="text-center text-secondary" style="padding:48px">
            暂无日志
          </td>
        </tr>
      `;
    }

    return logs.map(l => {
      const isError = l.status !== 'success';
      const errorMsg = l.error_message || '';

      return `
        <tr>
          <td class="mono" data-label="时间" style="font-size:11px;white-space:nowrap">
            ${formatTime(l.created_at)}
          </td>
          <td class="mono" data-label="模型" style="font-size:12px">${this._escape(l.model)}</td>
          <td data-label="账号" style="font-size:12px">${this._escape(l.account_email || '-')}</td>
          <td data-label="状态">
            <span class="badge ${isError ? 'badge-danger' : 'badge-success'}">
              ${isError ? '失败' : '成功'}
            </span>
          </td>
          <td class="mono" data-label="Token">${formatNumber(l.total_tokens)}</td>
          <td class="mono" data-label="延迟">${l.latency_ms}ms</td>
          <td class="error-cell" data-label="错误信息">
            ${errorMsg 
              ? `<span class="error-text">${this._escape(errorMsg)}</span><div class="error-tooltip" role="tooltip">${this._escape(errorMsg)}</div>` 
              : '<span class="text-secondary">-</span>'
            }
          </td>
        </tr>
      `;
    }).join('');
  }

  onMount() {
    this.watch(['logs', 'stats']);
    this._mountPagination();
  }

  onUpdate() {
    this._mountPagination();
  }

  _mountPagination() {
    const container = this.container.querySelector('#logsPagination');
    if (!container) return;

    const pagination = store.get('logs.pagination') || {};
    const list = store.get('logs.list') || [];

    // 估算总数（如果API没有返回total）
    const estimatedTotal = pagination.total || (
      list.length === pagination.pageSize ? pagination.page * pagination.pageSize + 1 : list.length
    );

    if (this._pagination && this._pagination.container !== container) {
      this._pagination.unmount();
      this._pagination = null;
    }

    if (this._pagination) {
      this._pagination.setProps({
        page: pagination.page || 1,
        pageSize: pagination.pageSize || 50,
        total: estimatedTotal
      });
    } else {
      this._pagination = new Pagination(container, {
        page: pagination.page || 1,
        pageSize: pagination.pageSize || 50,
        total: estimatedTotal,
        pageSizeOptions: [20, 50, 100],
        onChange: (page) => {
          commands.dispatch('logs:set-page', { page });
        },
        onPageSizeChange: (pageSize) => {
          commands.dispatch('logs:set-page-size', { pageSize });
        }
      });
      this._pagination.mount();
    }
  }

  onUnmount() {
    if (this._pagination) {
      this._pagination.unmount();
      this._pagination = null;
    }
  }

  _bindEvents() {
    // 应用筛选
    this.on('[data-action="apply-filter"]', 'click', () => {
      const model = this.container.querySelector('#logModel')?.value || '';
      const status = this.container.querySelector('#logStatus')?.value || '';
      
      commands.dispatch('logs:set-filter', { model, status });
    });

    // 清除筛选
    this.on('[data-action="clear-filter"]', 'click', () => {
      commands.dispatch('logs:set-filter', { model: '', status: '' });
    });

    // 回车筛选
    this.on('#logModel', 'keydown', (e) => {
      if (e.key === 'Enter') {
        const model = e.target.value || '';
        const status = this.container.querySelector('#logStatus')?.value || '';
        commands.dispatch('logs:set-filter', { model, status });
      }
    });

    // 状态选择变化立即筛选
    this.on('#logStatus', 'change', () => {
      const model = this.container.querySelector('#logModel')?.value || '';
      const status = this.container.querySelector('#logStatus')?.value || '';
      commands.dispatch('logs:set-filter', { model, status });
    });
  }
}

export default LogsPage;
