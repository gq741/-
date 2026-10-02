<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Lock, RefreshRight, VideoPause } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { PddActiveOrderView, PddRuntimeState } from '@shared/contracts'
import { desktopApi } from '@renderer/api/facade'

type WebviewElement = HTMLElement & { reload(): void }

const webview = ref<WebviewElement | null>(null)
const runtime = ref<PddRuntimeState>({
  profileId: 'pdd-store-default',
  sessionMode: 'guest',
  autoReplyEnabled: false,
  mode: 'detached',
  attached: false,
  captureActive: false,
  url: '',
  processedCount: 0,
  receiptCount: 0,
  pausedConversations: []
})
let poller: ReturnType<typeof setInterval> | undefined
const orderDrawerOpen = ref(false)
const orderView = ref<PddActiveOrderView>({ status: 'unavailable' })
const orderRefreshPending = ref(false)
const orderQueryPending = ref(false)
const orderQueryFailure = ref<{ buyerId?: string; reason: string; code?: number } | null>(null)
const visibleQueryFailure = computed(() => {
  const failure = orderQueryFailure.value
  if (!failure) return null
  if ('buyerId' in orderView.value && orderView.value.buyerId !== failure.buyerId) return null
  return failure
})

function shortId(value: string): string {
  return value.length > 6 ? `…${value.slice(-6)}` : value
}

async function refreshActiveOrders(): Promise<void> {
  if (!orderDrawerOpen.value || orderRefreshPending.value || orderQueryPending.value) return
  orderRefreshPending.value = true
  try {
    orderView.value = await desktopApi.getPddActiveOrders()
  } catch {
    orderView.value = { status: 'unavailable' }
  } finally {
    orderRefreshPending.value = false
  }
}

function showActiveOrders(): void {
  orderView.value = { status: 'unavailable' }
  orderQueryFailure.value = null
  orderDrawerOpen.value = true
  void refreshActiveOrders()
}

async function queryActiveOrders(): Promise<void> {
  if (orderQueryPending.value) return
  orderQueryPending.value = true
  orderQueryFailure.value = null
  try {
    const result = await desktopApi.queryPddActiveOrders()
    if (result.status === 'query_failed') {
      orderQueryFailure.value = result
      ElMessage.warning('订单查询暂未成功，请查看抽屉内的失败状态。')
    } else {
      orderView.value = result
      if (result.status === 'unavailable') ElMessage.warning('商家页面暂未就绪。')
    }
  } catch {
    orderQueryFailure.value = {
      buyerId: 'buyerId' in orderView.value ? orderView.value.buyerId : undefined,
      reason: 'ipc_error'
    }
    ElMessage.warning('订单查询暂未成功，请查看抽屉内的失败状态。')
  } finally {
    orderQueryPending.value = false
  }
}

const status = computed(() => {
  if (runtime.value.mode === 'online') return { label: '在线值守', type: 'success' as const }
  if (runtime.value.mode === 'login_required')
    return { label: '请登录店铺', type: 'warning' as const }
  if (runtime.value.mode === 'error') return { label: '监听异常', type: 'danger' as const }
  if (runtime.value.mode === 'opening') return { label: '页面加载中', type: 'info' as const }
  return { label: '等待页面', type: 'info' as const }
})

const receiptStage = computed(() => {
  const receipt = runtime.value.lastReceipt
  if (!receipt) return ''
  if (!receipt.ok) return receipt.platformMessageId ? '回执待人工核验' : '请求失败'
  if (receipt.buyerConfirmedAt) return '买家端已人工核验'
  if (receipt.merchantEchoAt) return '商家端已回显，买家端待核验'
  return '平台已接受，等待商家端回显与买家端核验'
})

async function refreshRuntime(): Promise<void> {
  try {
    runtime.value = await desktopApi.getPddRuntimeState()
  } catch {
    // The next polling cycle retries after the main process finishes attaching the webview.
  }
}

function reloadPlatform(): void {
  webview.value?.reload()
}

async function resumeAll(): Promise<void> {
  runtime.value = await desktopApi.resumeAllPddConversations()
  ElMessage.success('已恢复全部人工接管会话的 AI 接待。')
}

async function toggleReply(enabled: boolean): Promise<void> {
  try {
    runtime.value = await desktopApi.setPddAutoReply(enabled)
    ElMessage.info(enabled ? '拼多多文字自动回复已开启' : '拼多多文字自动回复已暂停')
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : '自动回复状态设置失败')
  }
}

async function confirmBuyerReceipt(): Promise<void> {
  const id = runtime.value.lastReceipt?.platformMessageId
  if (!id) return
  try {
    await ElMessageBox.confirm(
      '请先在买家手机端看到该条回复，再记录人工核验结果。',
      '确认买家实收',
      {
        confirmButtonText: '买家端已看到',
        cancelButtonText: '返回',
        type: 'warning'
      }
    )
    runtime.value = await desktopApi.confirmPddBuyerReceipt(id)
    ElMessage.success('已记录买家端人工核验。')
  } catch {
    // Dismissing the confirmation keeps the receipt pending.
  }
}

onMounted(() => {
  void refreshRuntime()
  poller = setInterval(() => {
    void refreshRuntime()
    void refreshActiveOrders()
  }, 1500)
})

onBeforeUnmount(() => {
  if (poller) clearInterval(poller)
})
</script>

<template>
  <section class="platform-viewport" aria-label="拼多多客服页面">
    <div class="platform-toolbar">
      <div>
        <span class="pdd-mark">多</span><strong>拼多多客服工作台</strong>
        <el-tag size="small" :type="status.type" effect="plain">{{ status.label }}</el-tag>
        <span class="runtime-counter"
          >{{ runtime.autoReplyEnabled ? '自动回复启用' : '自动回复关闭' }} ·
          {{ runtime.sessionMode === 'guest' ? '同页收发' : '独立 Chrome 测试' }} · 已处理
          {{ runtime.processedCount }} · 回执 {{ runtime.receiptCount }}</span
        >
      </div>
      <div class="platform-toolbar__actions">
        <el-button size="small" :disabled="runtime.mode !== 'online'" @click="showActiveOrders"
          >当前会话订单</el-button
        >
        <el-switch
          :model-value="runtime.autoReplyEnabled"
          :disabled="runtime.mode !== 'online' && !runtime.autoReplyEnabled"
          active-text="自动回复"
          @change="toggleReply(Boolean($event))"
        />
        <el-button
          v-if="runtime.pausedConversations.length"
          size="small"
          type="warning"
          plain
          @click="resumeAll"
          ><el-icon><VideoPause /></el-icon>人工暂停
          {{ runtime.pausedConversations.length }}</el-button
        >
        <span class="platform-toolbar__secure"
          ><el-icon><Lock /></el-icon
          >{{ runtime.captureActive ? '消息监听已连接' : '正在连接监听' }}</span
        >
        <el-button
          circle
          size="small"
          :icon="RefreshRight"
          aria-label="刷新拼多多页面"
          @click="reloadPlatform"
        />
      </div>
    </div>
    <div v-if="runtime.lastError" class="platform-runtime-error">{{ runtime.lastError }}</div>
    <div v-if="runtime.lastReceipt" class="platform-receipt-status">
      <span :title="runtime.lastReceipt.platformMessageId">
        最近回执：{{ receiptStage }} · 入站 {{ runtime.lastReceipt.inboundMessageId }}
        <template v-if="runtime.lastReceipt.platformMessageId">
          · 出站 {{ runtime.lastReceipt.platformMessageId }}</template
        >
        <template v-if="runtime.lastReceipt.mallId">
          · 店铺 {{ runtime.lastReceipt.mallId }}</template
        >
      </span>
      <el-button
        v-if="runtime.lastReceipt.platformMessageId && !runtime.lastReceipt.buyerConfirmedAt"
        size="small"
        @click="confirmBuyerReceipt"
        >核验买家实收</el-button
      >
    </div>
    <el-drawer
      v-model="orderDrawerOpen"
      title="当前会话订单 · 只读"
      size="380px"
      class="order-drawer"
    >
      <div class="pdd-order-intro">
        <strong>平台订单摘要</strong>
        <p>仅展示已查询结果。价格不展示，订单信息也不参与自动回复。</p>
      </div>
      <el-button
        size="small"
        :loading="orderQueryPending"
        :disabled="orderRefreshPending"
        @click="queryActiveOrders"
        >查询当前买家</el-button
      >
      <p v-if="visibleQueryFailure" class="pdd-order-state pdd-order-state--error" role="alert">
        <strong>本次查询未成功</strong
        ><span
          >{{ visibleQueryFailure.reason
          }}<template v-if="visibleQueryFailure.code">
            · 平台码 {{ visibleQueryFailure.code }}</template
          >。请稍后重试。</span
        >
      </p>
      <div
        v-if="orderRefreshPending && orderView.status === 'unavailable'"
        class="pdd-order-skeleton"
        aria-label="订单摘要加载中"
      >
        <el-skeleton :rows="4" animated />
      </div>
      <p
        v-else-if="orderView.status === 'unavailable' || orderView.status === 'query_failed'"
        class="pdd-order-state pdd-order-state--error"
      >
        <strong>订单摘要暂不可用</strong><span>商家页面或查询通道尚未就绪，请稍后重试。</span>
      </p>
      <p v-else-if="orderView.status === 'no_conversation'" class="pdd-order-state">
        <strong>尚未选择买家会话</strong><span>请先在商家页面选中会话，再查询订单。</span>
      </p>
      <p v-else-if="orderView.status === 'not_queried'" class="pdd-order-state">
        <strong>尚无已查询摘要</strong
        ><span>当前买家尚未查询；这不代表买家没有订单。点击“查询当前买家”获取平台结果。</span>
      </p>
      <template v-else>
        <p class="pdd-order-meta">
          买家 {{ shortId(orderView.buyerId) }} ·
          {{ new Date(orderView.fetchedAt).toLocaleTimeString('zh-CN') }} 读取 · 平台返回
          {{ orderView.total }} 笔
        </p>
        <p v-if="!orderView.orders.length" class="pdd-order-state">
          <strong>平台返回 0 笔</strong
          ><span>本次已完成查询，结果中没有订单；与“尚无已查询摘要”不同。</span>
        </p>
        <article v-for="order in orderView.orders" :key="order.orderId" class="pdd-order-card">
          <strong>{{ order.goodsTitle || '商品标题待核对' }}</strong>
          <span>订单尾号：{{ shortId(order.orderId) }}</span>
          <span v-if="order.spec">规格：{{ order.spec }}</span>
          <span v-if="order.rawOrderStatus">平台状态原值：{{ order.rawOrderStatus }}</span>
        </article>
        <p v-if="orderView.total > orderView.orders.length" class="pdd-order-note">
          当前只展示已读取的前 {{ orderView.orders.length }} 笔，其余订单尚待分页核对。
        </p>
      </template>
    </el-drawer>
    <webview
      ref="webview"
      class="pdd-live-webview"
      src="https://mms.pinduoduo.com/chat-merchant/index.html"
      partition="persist:pdd-store-default"
    />
  </section>
</template>
