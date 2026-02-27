/**
 * 命令注册
 * 定义所有应用命令及其处理逻辑
 */

import { commands } from '../core/command.js';
import { store } from '../core/store.js';
import { api } from '../services/api.js';
import { toast } from '../ui/toast.js';
import { confirm } from '../ui/confirm.js';

function clampThreshold(value, fallback = 0.2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function mapThresholdSettings(raw) {
  const src = raw?.quotaThresholds || raw || {};
  return {
    global: clampThreshold(src.global ?? raw?.groupQuotaMinThreshold, 0.2),
    flash: clampThreshold(src.flash ?? raw?.flashGroupQuotaMinThreshold, 0.2),
    pro: clampThreshold(src.pro ?? raw?.proGroupQuotaMinThreshold, 0.2),
    claude: clampThreshold(src.claude ?? raw?.claudeGroupQuotaMinThreshold, 0.2),
    image: clampThreshold(src.image ?? raw?.imageGroupQuotaMinThreshold, 0.2)
  };
}

// ============ 认证命令 ============

commands.register('auth:login', async ({ password, remember = true }) => {
  const loading = toast.loading('正在登录...');
  
  try {
    await api.login(password, remember);
    const user = await api.getMe();
    store.set('user', user);
    loading.update('登录成功', 'success');
    setTimeout(() => loading.close(), 1500);
    return true;
  } catch (error) {
    loading.close();
    throw error;
  }
});

commands.register('auth:logout', async () => {
  api.clearTokens();
  store.set('user', null);
  toast.info('已退出登录');
});

commands.register('auth:check', async () => {
  const { accessToken } = api.getTokens();
  if (!accessToken) {
    store.set('user', null);
    return false;
  }
  
  try {
    const user = await api.getMe();
    store.set('user', user);
    return true;
  } catch {
    store.set('user', null);
    api.clearTokens();
    return false;
  }
});

// ============ 导航命令 ============

commands.register('nav:change', async ({ tab }) => {
  store.set('activeTab', tab);
  
  // 加载对应数据
  switch (tab) {
    case 'dashboard':
      await commands.dispatch('dashboard:load');
      break;
    case 'accounts':
      await commands.dispatch('accounts:load');
      break;
    case 'logs':
      await commands.dispatch('logs:load');
      break;
  }
});

// ============ 仪表盘命令 ============

commands.register('dashboard:load', async () => {
  store.set('dashboard.loading', true);
  store.set('dashboard.settingsLoading', true);
  store.set('dashboard.error', null);
  
  try {
    const [data, settings] = await Promise.all([
      api.getDashboard(),
      api.getSettings()
    ]);
    store.batch(() => {
      store.set('dashboard.data', data);
      store.set('dashboard.settings', mapThresholdSettings(settings));
    });
  } catch (error) {
    store.set('dashboard.error', error.message);
    throw error;
  } finally {
    store.set('dashboard.loading', false);
    store.set('dashboard.settingsLoading', false);
  }
});

commands.register('dashboard:save-thresholds', async ({ thresholds }) => {
  const next = mapThresholdSettings(thresholds || {});
  store.set('dashboard.settingsSaving', true);

  try {
    await Promise.all([
      api.updateSetting('groupQuotaMinThreshold', next.global),
      api.updateSetting('flashGroupQuotaMinThreshold', next.flash),
      api.updateSetting('proGroupQuotaMinThreshold', next.pro),
      api.updateSetting('claudeGroupQuotaMinThreshold', next.claude),
      api.updateSetting('imageGroupQuotaMinThreshold', next.image)
    ]);
    store.set('dashboard.settings', next);
    toast.success('Quota thresholds updated');
    return true;
  } catch (error) {
    toast.error(error?.message || 'Failed to update thresholds');
    throw error;
  } finally {
    store.set('dashboard.settingsSaving', false);
  }
});

// ============ 账号命令 ============

commands.register('accounts:load', async ({ silent = false } = {}) => {
  if (!silent) {
    store.set('accounts.loading', true);
  }
  store.set('accounts.error', null);
  
  try {
    const result = await api.getAccounts();
    store.set('accounts.list', result?.accounts || []);
  } catch (error) {
    store.set('accounts.error', error.message);
    throw error;
  } finally {
    if (!silent) {
      store.set('accounts.loading', false);
    }
  }
});

commands.register('accounts:create', async ({ email, refreshToken, projectId }) => {
  const loading = toast.loading('正在添加账号...');
  
  try {
    const result = await api.createAccount(email, refreshToken, projectId);
    const data = result?.data || result;
    const returnedProjectId = data?.project_id || projectId || null;

    if (returnedProjectId) {
      loading.update(`账号添加成功，project id：${returnedProjectId}`, 'success');
    } else {
      loading.update('账号添加成功，但未获取 project id（账号可能无法使用）', 'warning');
    }

setTimeout(() => loading.close(), 2500);
    
    await commands.dispatch('accounts:load', { silent: true });
    return true;
  } catch (error) {
    loading.close();
    throw error;
  }
});

commands.register('accounts:refresh', async ({ id }) => {
  const loading = toast.loading('正在刷新Token...');
  
  try {
    const result = await api.refreshAccount(id);
    const data = result?.data || result;
    const projectId = data?.project_id || null;

    if (projectId) {
      loading.update(`Token已刷新，成功获取 project id：${projectId}`, 'success');
    } else {
      loading.update('Token已刷新，但未获取 project id（账号可能无法使用）', 'warning');
    }

    setTimeout(() => loading.close(), 2500);
    
    await commands.dispatch('accounts:load', { silent: true });
  } catch (error) {
    loading.close();
    throw error;
  }
});

commands.register('accounts:refresh-all', async () => {
  store.set('accounts.refreshingAll', true);
  const loading = toast.loading('正在刷新全部账号...');

  try {
    const result = await api.refreshAllAccounts();
    const results = result?.results || [];
    const successCount = results.filter(r => r && r.success).length;
    const failCount = results.length - successCount;
    const withProjectId = results.filter(r => r && r.success && r.project_id).length;
    const withoutProjectId = successCount - withProjectId;

    if (results.length === 0) {
      loading.update('没有可刷新的账号', 'warning');
    } else if (failCount > 0) {
      loading.update(`刷新完成：${successCount} 成功，${failCount} 失败`, 'warning');
    } else if (withoutProjectId > 0) {
      loading.update(`已刷新 ${successCount} 个账号，但 ${withoutProjectId} 个未获取 project id`, 'warning');
    } else {
      loading.update(`已刷新 ${successCount} 个账号，全部成功获取 project id`, 'success');
    }
    setTimeout(() => loading.close(), 2500);

    await commands.dispatch('accounts:load', { silent: true });
  } catch (error) {
    loading.close();
    throw error;
  } finally {
    store.set('accounts.refreshingAll', false);
  }
});

commands.register('accounts:toggle-status', async ({ id, currentStatus }) => {
  const newStatus = currentStatus === 'active' ? 'disabled' : 'active';
  const actionText = newStatus === 'active' ? '启用' : '禁用';
  
  await api.updateAccountStatus(id, newStatus);
  toast.success(`账号已${actionText}`);
  
  await commands.dispatch('accounts:load', { silent: true });
});

commands.register('accounts:delete', async ({ id, email }) => {
  const confirmed = await confirm.show({
    title: '删除账号',
    message: `确定要删除账号 "${email}" 吗？此操作不可恢复。`,
    confirmText: '删除',
    danger: true
  });

  if (!confirmed) return false;

await api.deleteAccount(id);
  toast.success('账号已删除');
  
  await commands.dispatch('accounts:load', { silent: true });
  return true;
});

commands.register('accounts:view-quota', async ({ id }) => {
  const accounts = store.get('accounts.list') || [];
  const account = accounts.find(a => String(a.id) === String(id));
  
  store.batch(() => {
    store.set('dialogs.quota.open', true);
    store.set('dialogs.quota.accountId', id);
    store.set('dialogs.quota.account', account);
    store.set('dialogs.quota.loading', true);
    store.set('dialogs.quota.data', null);
  });

  try {
    const data = await api.getAccountQuota(id);
    
    // 检查弹窗是否仍打开且是同一账号
    if (store.get('dialogs.quota.open') && 
        store.get('dialogs.quota.accountId') === id) {
      store.set('dialogs.quota.data', data);
    }
  } catch (error) {
    if (store.get('dialogs.quota.accountId') === id) {
      toast.error(error.message || '获取配额失败');
    }
  } finally {
    if (store.get('dialogs.quota.accountId') === id) {
      store.set('dialogs.quota.loading', false);
    }
  }
});

commands.register('accounts:close-quota', () => {
  store.set('dialogs.quota.open', false);
});

commands.register('import:open', () => {
  store.batch(() => {
    store.set('dialogs.import.open', true);
    store.set('dialogs.import.tab', 'manual');
  });
});

commands.register('import:close', () => {
  store.set('dialogs.import.open', false);
});

commands.register('accounts:import-batch', async ({ accounts }) => {
  const result = await api.importAccounts(accounts);
  return result;
});

commands.register('accounts:export', async () => {
  const loading = toast.loading('正在导出账号...');
  
  try {
    const result = await api.exportAccounts();
    const accounts = result?.accounts || [];
    
    if (accounts.length === 0) {
      loading.update('没有可导出的账号', 'warning');
      setTimeout(() => loading.close(), 2000);
      return;
    }
    
    const json = JSON.stringify(accounts, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `tokens-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    loading.update(`已导出 ${accounts.length} 个账号`, 'success');
    setTimeout(() => loading.close(), 2000);
  } catch (error) {
    loading.close();
    throw error;
  }
});

commands.register('accounts:export-single', async ({ id }) => {
  const loading = toast.loading('正在导出...');
  
  try {
    const result = await api.exportAccounts();
    const accounts = result?.accounts || [];
    const account = accounts.find(a => String(a.email) || String(a.project_id));
    const target = accounts.find(a => {
      const list = store.get('accounts.list') || [];
      const match = list.find(acc => String(acc.id) === String(id));
      return match && a.email === match.email;
    });
    
    if (!target) {
      loading.update('未找到该账号', 'error');
      setTimeout(() => loading.close(), 2000);
      return;
    }
    
    const json = JSON.stringify(target, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `token-${target.email.split('@')[0]}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    loading.update('已导出', 'success');
    setTimeout(() => loading.close(), 1500);
  } catch (error) {
    loading.close();
    throw error;
  }
});

// ============ 账号批量操作命令 ============

commands.register('accounts:select', ({ id }) => {
  const selectedIds = store.get('accounts.selectedIds') || [];
  const idStr = String(id);

  if (selectedIds.includes(idStr)) {
    store.set('accounts.selectedIds', selectedIds.filter(i => i !== idStr));
  } else {
    store.set('accounts.selectedIds', [...selectedIds, idStr]);
  }
});

commands.register('accounts:select-all', () => {
  const accounts = store.get('accounts.list') || [];
  const selectedIds = store.get('accounts.selectedIds') || [];

  if (selectedIds.length === accounts.length) {
    store.set('accounts.selectedIds', []);
  } else {
    store.set('accounts.selectedIds', accounts.map(a => String(a.id)));
  }
});

commands.register('accounts:clear-selection', () => {
  store.set('accounts.selectedIds', []);
});

commands.register('accounts:batch-refresh', async () => {
  const selectedIds = store.get('accounts.selectedIds') || [];
  if (selectedIds.length === 0) {
    toast.warning('请先选择账号');
    return;
  }

  const loading = toast.loading(`正在刷新 ${selectedIds.length} 个账号...`);
  let success = 0;
  let fail = 0;
  let withProjectId = 0;

  for (const id of selectedIds) {
    try {
      const result = await api.refreshAccount(id);
      const data = result?.data || result;
      success++;
      if (data?.project_id) {
        withProjectId++;
      }
    } catch (e) {
      fail++;
    }
  }

  loading.close();

  const withoutProjectId = success - withProjectId;
  if (fail > 0) {
    toast.warning(`刷新完成：${success} 成功，${fail} 失败`);
  } else if (withoutProjectId > 0) {
    toast.warning(`已刷新 ${success} 个账号，但 ${withoutProjectId} 个未获取 project id`);
  } else {
    toast.success(`已刷新 ${success} 个账号，全部成功获取 project id`);
  }

  store.set('accounts.selectedIds', []);
  await commands.dispatch('accounts:load', { silent: true });
});

commands.register('accounts:batch-toggle', async ({ newStatus }) => {
  const selectedIds = store.get('accounts.selectedIds') || [];
  if (selectedIds.length === 0) {
    toast.warning('请先选择账号');
    return;
  }

  const actionText = newStatus === 'active' ? '启用' : '禁用';
  const loading = toast.loading(`正在${actionText} ${selectedIds.length} 个账号...`);
  let success = 0;
  let fail = 0;

  for (const id of selectedIds) {
    try {
      await api.updateAccountStatus(id, newStatus);
      success++;
    } catch (e) {
      fail++;
    }
  }

  loading.close();
  if (fail > 0) {
    toast.warning(`${actionText}完成: ${success} 成功, ${fail} 失败`);
  } else {
    toast.success(`已${actionText} ${success} 个账号`);
  }

  store.set('accounts.selectedIds', []);
  await commands.dispatch('accounts:load', { silent: true });
});

commands.register('accounts:batch-delete', async () => {
  const selectedIds = store.get('accounts.selectedIds') || [];
  if (selectedIds.length === 0) {
    toast.warning('请先选择账号');
    return;
  }

  const confirmed = await confirm.show({
    title: '批量删除账号',
    message: `确定要删除 ${selectedIds.length} 个账号吗？此操作不可恢复！`,
    confirmText: '删除',
    danger: true
  });

  if (!confirmed) {
    return;
  }

  const loading = toast.loading(`正在删除 ${selectedIds.length} 个账号...`);
  let success = 0;
  let fail = 0;

  for (const id of selectedIds) {
    try {
      await api.deleteAccount(id);
      success++;
    } catch (e) {
      fail++;
    }
  }

  loading.close();
  if (fail > 0) {
    toast.warning(`删除完成: ${success} 成功, ${fail} 失败`);
  } else {
    toast.success(`已删除 ${success} 个账号`);
  }

  store.set('accounts.selectedIds', []);
  await commands.dispatch('accounts:load', { silent: true });
});

commands.register('accounts:batch-export', async () => {
  const selectedIds = store.get('accounts.selectedIds') || [];
  if (selectedIds.length === 0) {
    toast.warning('请先选择账号');
    return;
  }

  const loading = toast.loading('正在导出...');

  try {
    const result = await api.exportAccounts();
    const allAccounts = result?.accounts || [];
    const accountList = store.get('accounts.list') || [];

    // 找到选中的账号对应的导出数据
    const selectedEmails = accountList
      .filter(a => selectedIds.includes(String(a.id)))
      .map(a => a.email);

    const exportData = allAccounts.filter(a => selectedEmails.includes(a.email));

    if (exportData.length === 0) {
      loading.update('未找到可导出的账号', 'warning');
      setTimeout(() => loading.close(), 2000);
      return;
    }

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `tokens-selected-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    loading.update(`已导出 ${exportData.length} 个账号`, 'success');
    setTimeout(() => loading.close(), 2000);

    store.set('accounts.selectedIds', []);
  } catch (error) {
    loading.close();
    throw error;
  }
});

// 单账号导出
commands.register('accounts:export', async ({ id }) => {
  if (!id) {
    toast.warning('未指定账号');
    return;
  }

  const loading = toast.loading('正在导出...');

  try {
    const result = await api.exportAccounts();
    const allAccounts = result?.accounts || [];
    const accountList = store.get('accounts.list') || [];

    // 找到指定 ID 的账号
    const account = accountList.find(a => String(a.id) === String(id));
    if (!account) {
      loading.update('未找到账号', 'warning');
      setTimeout(() => loading.close(), 2000);
      return;
    }

    const exportData = allAccounts.filter(a => a.email === account.email);

    if (exportData.length === 0) {
      loading.update('未找到可导出的数据', 'warning');
      setTimeout(() => loading.close(), 2000);
      return;
    }

    const json = JSON.stringify(exportData[0], null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `token-${account.email || id}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);

    loading.update('已导出账号', 'success');
    setTimeout(() => loading.close(), 2000);
  } catch (error) {
    loading.close();
    throw error;
  }
});

// ============ 日志命令 ============

commands.register('logs:load', async () => {
  store.set('logs.loading', true);
  store.set('logs.error', null);
  
  try {
    const now = Date.now();
    const start = now - 24 * 60 * 60 * 1000;
    
    // 加载统计数据
    const statsResponse = await api.getStats({ start_time: start, end_time: now });
    const rawStats = statsResponse?.stats || null;

    // 适配后端字段命名（snake_case）到 UI 需要的字段（camelCase）
    const statsForUi = rawStats ? {
      total: rawStats.total_requests || 0,
      avgLatency: rawStats.avg_latency || 0,
      successRate: rawStats.total_requests > 0
        ? ((rawStats.success_count / rawStats.total_requests) * 100).toFixed(1)
        : 100,
      tokens: rawStats.total_tokens || 0,
      promptTokens: rawStats.total_prompt_tokens || 0,
      completionTokens: rawStats.total_completion_tokens || 0,
      successCount: rawStats.success_count || 0,
      errorCount: rawStats.error_count || 0
    } : null;

    store.set('stats.data', statsForUi);
    store.set('stats.modelUsage', statsResponse?.modelUsage || []);
    
    // 加载日志列表
    const { page, pageSize } = store.get('logs.pagination');
    const filters = store.get('logs.filters');
    
    const commonParams = {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      model: filters.model || undefined,
      status: filters.status || undefined
    };

    const result = await api.getAttemptLogs({
      ...commonParams,
      request_id: filters.requestId || undefined
    });
    
    store.set('logs.list', result?.logs || []);
    
    // 更新总数（如果API返回）
    if (result?.total !== undefined) {
      store.set('logs.pagination.total', result.total);
    }
  } catch (error) {
    store.set('logs.error', error.message);
    throw error;
  } finally {
    store.set('logs.loading', false);
  }
});

commands.register('logs:set-filter', async ({ model, status, requestId }) => {
  store.batch(() => {
    if (model !== undefined) store.set('logs.filters.model', model);
    if (status !== undefined) store.set('logs.filters.status', status);
    if (requestId !== undefined) store.set('logs.filters.requestId', requestId);
    store.set('logs.pagination.page', 1);
  });
  
  await commands.dispatch('logs:load');
});

commands.register('logs:set-page', async ({ page }) => {
  store.set('logs.pagination.page', page);
  await commands.dispatch('logs:load');
});

commands.register('logs:set-page-size', async ({ pageSize }) => {
  store.batch(() => {
    store.set('logs.pagination.pageSize', pageSize);
    store.set('logs.pagination.page', 1);
  });
  await commands.dispatch('logs:load');
});

// ============ OAuth 命令 ============

commands.register('oauth:open', () => {
  store.batch(() => {
    store.set('dialogs.oauth.open', true);
    store.set('dialogs.oauth.step', 1);
    store.set('dialogs.oauth.port', null);
    store.set('dialogs.oauth.authUrl', '');
    store.set('dialogs.oauth.callbackUrl', '');
  });
});

commands.register('oauth:close', () => {
  store.set('dialogs.oauth.open', false);
});

commands.register('oauth:start', async () => {
  try {
    const config = await api.getOAuthConfig();
    const cfg = config?.client_id ? config : config?.data || config;
    
    const port = Math.floor(Math.random() * 10000) + 50000;
    const redirectUri = `http://localhost:${port}/oauth-callback`;
    
    const authUrl = `${cfg.auth_endpoint}?` + new URLSearchParams({
      access_type: 'offline',
      client_id: cfg.client_id,
      prompt: 'consent',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: cfg.scope,
      state: String(Date.now())
    }).toString();

    store.batch(() => {
      store.set('dialogs.oauth.port', String(port));
      store.set('dialogs.oauth.authUrl', authUrl);
      store.set('dialogs.oauth.step', 2);
    });

    window.open(authUrl, '_blank');
  } catch (error) {
    toast.error(error.message || '获取OAuth配置失败');
    throw error;
  }
});

commands.register('oauth:exchange', async ({ callbackUrl }) => {
  const port = store.get('dialogs.oauth.port');

  // 从URL中提取code
  const codeMatch = callbackUrl.match(/[?&]code=([^&]+)/);
  if (!codeMatch) {
    throw new Error('未找到授权码，请检查URL');
  }

  const code = decodeURIComponent(codeMatch[1]);
  const urlPort = (callbackUrl.match(/localhost:(\d+)/) || [])[1];
  const finalPort = port || urlPort;

  if (!finalPort) {
    throw new Error('未找到端口，请先点击"打开授权页面"');
  }

  const loading = toast.loading('正在交换Token...');

  try {
    const result = await api.exchangeOAuthCode(code, finalPort);

    // 检查是否返回了错误
    if (result?.success === false || result?.error) {
      const errorMsg = result?.message || result?.error?.message || '添加账号失败';
      loading.update(errorMsg, 'error');
      setTimeout(() => loading.close(), 2500);
      return false;
    }

    const data = result?.data || result;
    const projectId = data?.project_id || null;

    if (projectId) {
      loading.update(`账号添加成功，成功获取 project id：${projectId}`, 'success');
    } else {
      loading.update('账号添加成功，但未获取 project id（账号可能无法使用）', 'warning');
    }

    setTimeout(() => loading.close(), 2500);

    store.set('dialogs.oauth.open', false);
    await commands.dispatch('accounts:load');
    return true;
  } catch (error) {
    loading.close();
    throw error;
  }
});

// ============ 主题命令 ============

commands.register('theme:toggle', () => {
  const current = store.get('theme');
  const next = current === 'dark' ? 'light' : 'dark';
  
  store.set('theme', next);
  localStorage.setItem('theme', next);
  document.documentElement.classList.toggle('dark-mode', next === 'dark');
});

commands.register('theme:init', () => {
  const theme = store.get('theme');
  document.documentElement.classList.toggle('dark-mode', theme === 'dark');
});

// ============ 数据刷新命令 ============

commands.register('data:refresh', async () => {
  const tab = store.get('activeTab');
  
  switch (tab) {
    case 'dashboard':
      await commands.dispatch('dashboard:load');
      break;
    case 'accounts':
      await commands.dispatch('accounts:load');
      break;
    case 'logs':
      await commands.dispatch('logs:load');
      break;
  }
  
  toast.success('刷新成功');
});

export { commands };
