<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useToast } from '../composables/useToast'
import { getSettings, updateSetting, getHealth } from '../api'
import { copyToClipboard } from '../utils/clipboard'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import { Copy, CheckCircle, Settings as SettingsIcon } from 'lucide-vue-next'

const toast = useToast()
const loading = ref(false)
const saving = ref(false)

const settings = reactive({
  defaultModel: 'gemini-2.5-flash',
  pollingStrategy: 'weighted'
})

const models = [
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-3-pro-high', name: 'Gemini 3 Pro (High)' },
  { id: 'gemini-3-pro-low', name: 'Gemini 3 Pro (Low)' },
  { id: 'rev19-uic3-1p', name: 'rev19-uic3-1p' },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
  { id: 'claude-opus-4-5-thinking', name: 'Claude Opus 4.5 (Thinking)' },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
  { id: 'claude-sonnet-4-5-thinking', name: 'Claude Sonnet 4.5 (Thinking)' }
]

const apiEndpoint = computed(() => window.location.origin)

const fetchSettings = async () => {
  loading.value = true
  try {
    const res = await getSettings()
    Object.assign(settings, res.data || res)
  } catch (error) {
    console.error('Failed to load settings', error)
  } finally {
    loading.value = false
  }
}

const saveSettings = async () => {
  saving.value = true
  try {
    await updateSetting('defaultModel', settings.defaultModel)
    await updateSetting('pollingStrategy', settings.pollingStrategy)
    toast.success('设置已保存')
  } catch (error) {
    toast.error('保存设置失败')
  } finally {
    saving.value = false
  }
}

const copyText = async (text) => {
  const success = await copyToClipboard(text)
  if (success) {
    toast.success('已复制到剪贴板')
  } else {
    toast.error('复制失败，请手动复制')
  }
}

const checkHealth = async () => {
  try {
    const res = await getHealth()
    const data = res.data || res
    toast.success(`健康检查通过 - ${data.accounts?.active || 0} 个活跃账号`)
  } catch (error) {
    toast.error('健康检查失败')
  }
}

const exampleCode = computed(() => `curl ${apiEndpoint.value}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`)

onMounted(fetchSettings)
</script>

<template>
  <div class="settings-page">
    <div class="page-header">
      <h1 class="page-title">系统设置</h1>
    </div>

    <div class="settings-grid">
      <!-- System Settings -->
      <Card title="系统设置">
        <div class="form-group">
          <label class="form-label">默认模型</label>
          <select v-model="settings.defaultModel" class="form-select">
            <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">轮询策略</label>
          <select v-model="settings.pollingStrategy" class="form-select">
            <option value="weighted">加权轮询 (按配额)</option>
            <option value="roundrobin">轮询</option>
            <option value="random">随机</option>
          </select>
        </div>
        <Button variant="primary" :loading="saving" @click="saveSettings">
          保存设置
        </Button>
      </Card>

      <!-- API Information -->
      <Card title="API 信息">
        <div class="info-list">
          <div class="info-item">
            <span class="info-label">对话接口</span>
            <div class="info-value">
              <code>{{ apiEndpoint }}/v1/chat/completions</code>
              <Button variant="ghost" size="sm" icon @click="copyText(`${apiEndpoint}/v1/chat/completions`)">
                <Copy :size="14" />
              </Button>
            </div>
          </div>
          <div class="info-item">
            <span class="info-label">模型列表</span>
            <div class="info-value">
              <code>{{ apiEndpoint }}/v1/models</code>
              <Button variant="ghost" size="sm" icon @click="copyText(`${apiEndpoint}/v1/models`)">
                <Copy :size="14" />
              </Button>
            </div>
          </div>
          <div class="info-item">
            <span class="info-label">健康检查</span>
            <div class="info-value">
              <code>{{ apiEndpoint }}/health</code>
              <Button variant="ghost" size="sm" icon @click="checkHealth">
                <CheckCircle :size="14" />
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <!-- Usage Example -->
      <Card title="使用示例" class="example-card">
        <div class="code-block">
          <pre><code>{{ exampleCode }}</code></pre>
          <Button variant="secondary" size="sm" class="copy-btn" @click="copyText(exampleCode)">
            <Copy :size="14" />
            复制
          </Button>
        </div>
      </Card>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 1000px;
  width: 100%;
  margin: 0 auto;
}
.page-header { margin-bottom: var(--space-6); }
.page-title { font-size: var(--text-2xl); font-weight: 700; margin: 0; }

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-6);
  width: 100%;
  min-width: 0;
}
.example-card { grid-column: 1 / -1; }

.form-group { margin-bottom: var(--space-5); }
.form-label { display: block; font-size: var(--text-sm); font-weight: 500; color: var(--text-secondary); margin-bottom: var(--space-2); }
.form-select {
  width: 100%;
  padding: var(--space-3);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--text-sm);
}
.form-select:focus { outline: none; border-color: var(--accent); }

.toggle-wrapper { display: flex; align-items: center; gap: var(--space-3); cursor: pointer; }
.toggle-input { display: none; }
.toggle-switch {
  width: 44px;
  height: 24px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
  position: relative;
  transition: background var(--transition);
}
.toggle-switch::after {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  background: white;
  border-radius: 50%;
  top: 3px;
  left: 3px;
  transition: transform var(--transition);
}
.toggle-input:checked + .toggle-switch { background: var(--accent); }
.toggle-input:checked + .toggle-switch::after { transform: translateX(20px); }
.toggle-label { font-size: var(--text-sm); color: var(--text-secondary); }

.info-list { display: flex; flex-direction: column; gap: var(--space-4); }
.info-item { display: flex; flex-direction: column; gap: var(--space-2); }
.info-label { font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.info-value { display: flex; align-items: center; gap: var(--space-2); }
.info-value code { flex: 1; background: var(--bg-tertiary); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: var(--text-xs); word-break: break-all; }

.code-block {
  position: relative;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  overflow: auto;
  max-width: 100%;
  box-sizing: border-box;
}
.code-block pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.code-block code {
  color: var(--text-primary);
  font-size: var(--text-xs);
  line-height: 1.6;
}
.copy-btn { position: absolute; top: var(--space-2); right: var(--space-2); }

@media (max-width: 1023px) {
  .settings-page {
    max-width: 100%;
    width: 100%;
    overflow-x: hidden;
  }
  .settings-grid { grid-template-columns: 1fr; }
}
</style>
