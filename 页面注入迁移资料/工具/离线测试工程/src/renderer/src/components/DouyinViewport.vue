<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { DouyinRuntimeState } from '@shared/contracts'
import { desktopApi } from '@renderer/api/facade'

type WebviewElement = HTMLElement & { reload(): void; loadURL(url: string): Promise<void> }
const FEIGE_URL = 'https://im.jinritemai.com/pc_seller_v2/main/workspace'
const LOGIN_URL = 'https://fxg.jinritemai.com/login/common'
const webview = ref<WebviewElement | null>(null)
const runtime = ref<DouyinRuntimeState>({
  profileId: 'douyin-store-default',
  mode: 'detached',
  attached: false,
  autoReplyEnabled: false,
  url: '',
  processedCount: 0,
  receiptCount: 0,
  pausedConversations: []
})
let poller: ReturnType<typeof setInterval> | undefined
async function refresh(): Promise<void> {
  try {
    runtime.value = await desktopApi.getDouyinRuntimeState()
  } catch {
    /* next poll */
  }
}
async function toggleReply(enabled: boolean): Promise<void> {
  try {
    runtime.value = await desktopApi.setDouyinAutoReply(enabled)
    ElMessage.info(enabled ? '抖音文字自动回复已开启' : '抖音文字自动回复已暂停')
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '请先登录飞鸽工作台')
  }
}
async function openLogin(): Promise<void> {
  runtime.value = await desktopApi.setDouyinAutoReply(false)
  await webview.value?.loadURL(LOGIN_URL)
}
function openFeige(): void {
  void webview.value?.loadURL(FEIGE_URL)
}
async function resumeAll(): Promise<void> {
  runtime.value = await desktopApi.resumeAllDouyinConversations()
  ElMessage.success('人工接管会话已恢复自动接待')
}
onMounted(() => {
  void refresh()
  poller = setInterval(() => void refresh(), 1500)
})
onBeforeUnmount(() => {
  if (poller) clearInterval(poller)
})
</script>

<template>
  <section class="platform-viewport" aria-label="抖音飞鸽客服页面">
    <div class="platform-toolbar">
      <div>
        <span class="pdd-mark">抖</span><strong>抖音飞鸽客服工作台</strong>
        <el-tag
          size="small"
          :type="runtime.mode === 'online' ? 'success' : 'warning'"
          effect="plain"
        >
          {{
            runtime.mode === 'online'
              ? '页面已连接'
              : runtime.mode === 'login_required'
                ? '登录已过期'
                : runtime.mode === 'permission_required'
                  ? '缺少会话权限'
                  : '连接中'
          }}
        </el-tag>
        <span class="runtime-counter"
          >已处理 {{ runtime.processedCount }} · 回执 {{ runtime.receiptCount }}</span
        >
      </div>
      <div class="platform-toolbar__actions">
        <el-button size="small" @click="openLogin">登录抖店</el-button>
        <el-button size="small" @click="openFeige">进入飞鸽</el-button>
        <el-button v-if="runtime.pausedConversations.length" size="small" @click="resumeAll">
          人工暂停 {{ runtime.pausedConversations.length }} · 恢复
        </el-button>
        <el-switch
          :model-value="runtime.autoReplyEnabled"
          :disabled="runtime.mode !== 'online'"
          active-text="自动回复"
          @change="toggleReply(Boolean($event))"
        />
        <el-button circle size="small" aria-label="刷新抖音页面" @click="webview?.reload()"
          >↻</el-button
        >
      </div>
    </div>
    <div v-if="runtime.mode === 'permission_required'" class="platform-runtime-error">
      当前账号缺少飞鸽会话权限。请在抖店商家后台为该账号开通“飞鸽客服—客服接待”，然后返回飞鸽刷新。
    </div>
    <div v-else-if="runtime.mode === 'login_required'" class="platform-runtime-error">
      飞鸽登录已过期。点击“登录抖店”完成登录，再点击“进入飞鸽”。
    </div>
    <div v-if="runtime.lastError" class="platform-runtime-error">{{ runtime.lastError }}</div>
    <div v-if="runtime.lastReceipt" class="platform-receipt-status">
      最近发送：{{ runtime.lastReceipt.ok ? '服务端已接收' : '发送失败' }} · 入站
      {{ runtime.lastReceipt.inboundMessageId }} · 出站
      {{ runtime.lastReceipt.platformMessageId || '无回执' }}
    </div>
    <webview
      ref="webview"
      class="pdd-live-webview"
      :src="FEIGE_URL"
      partition="persist:douyin-store-default"
    />
  </section>
</template>
