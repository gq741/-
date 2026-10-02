import type { WebContents } from 'electron'
import type {
  BannedWord,
  GeneralSettings,
  Intent,
  MessageTrace,
  NormalizedMessage,
  PddActiveOrderView,
  PddRuntimeState
} from '@shared/contracts'
import { decodeTitanPayload, extractPddCandidates, normalizePddCandidate } from './pddTitanDecoder'
import { resolveFixedReply } from './pddReplyResolver'
import { PddStateStore, type StoredPddReceipt } from './pddStateStore'
import { PddChromeBridge, type PddChromeTransport } from './pddChromeBridge'
import { usePddGuestSession } from './flags'
import { createPddGuestSendScript, parsePddGuestSendResult } from './pddGuestSender'
import { captureMessageShape } from './messageSchemaCapture'
import {
  createPddOrderProbeScript,
  type PddOrderProbeResult,
  type PddBuyerOrderContext
} from './pddOrderProbe'
import { appendFile } from 'node:fs/promises'

interface PddRules {
  intents: Intent[]
  bannedWords: BannedWord[]
  settings: GeneralSettings
}

interface PddAdapterOptions {
  profileId: string
  stateStore: PddStateStore
  getRules(): PddRules
  onMessage(message: NormalizedMessage): void
  onTrace(trace: MessageTrace): void
  onStateChange?(): void
  chromeTransport?: PddChromeTransport
}

interface PageSendResult {
  ok: boolean
  requestId: string
  status: number
  platformMessageId?: string
  previousMessageId?: string
  timestamp?: number
  code?: string
  message?: string
  method?: string
  mallId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

export class PddAdapter {
  private guest?: WebContents
  private processingQueue: Promise<void> = Promise.resolve()
  private runtime: PddRuntimeState
  private readonly programmaticSendContent = new Map<string, string>()
  private readonly conversationGeneration = new Map<string, number>()
  private readonly lastOrderProbeAt = new Map<string, number>()
  private readonly probedOrderIds = new Set<string>()
  private readonly orderContexts = new Map<string, PddBuyerOrderContext>()
  private readonly chromeTransport: PddChromeTransport
  private autoReplyReadyAt: number

  constructor(private readonly options: PddAdapterOptions) {
    const warmupMs = Math.max(0, Number(process.env.PDD_HOOK_WARMUP_MS ?? 10_000) || 0)
    this.autoReplyReadyAt = Date.now() + warmupMs
    this.chromeTransport = options.chromeTransport || new PddChromeBridge()
    this.chromeTransport.setFrameListener?.((payloadData, opcode) => {
      this.handleTitanFrame(payloadData, opcode)
    })
    this.chromeTransport.setMessageListener?.((rawMessage) => {
      this.handleInjectedMessage(rawMessage)
    })
    this.runtime = {
      profileId: options.profileId,
      sessionMode: usePddGuestSession() ? 'guest' : 'chrome',
      autoReplyEnabled: process.env.PDD_HOOK_AUTO_REPLY === 'true',
      mode: 'detached',
      attached: false,
      captureActive: false,
      url: '',
      processedCount: 0,
      receiptCount: 0,
      pausedConversations: []
    }
  }

  async attach(guest: WebContents): Promise<void> {
    if (this.guest?.id === guest.id) return
    this.guest = guest
    this.runtime.autoReplyEnabled =
      (await this.options.stateStore.autoReplySetting()) ??
      process.env.PDD_HOOK_AUTO_REPLY === 'true'
    this.runtime = {
      ...this.runtime,
      mode: 'opening',
      attached: true,
      url: guest.getURL(),
      lastError: undefined
    }
    this.emitState()

    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
    guest.on('did-navigate', (_event, url) => this.updateUrl(url))
    guest.on('did-navigate-in-page', (_event, url) => this.updateUrl(url))
    guest.on('did-finish-load', () => {
      this.updateUrl(guest.getURL())
      setTimeout(() => void this.probePageReady(), 1200)
    })
    guest.once('destroyed', () => {
      if (this.guest?.id !== guest.id) return
      this.guest = undefined
      this.runtime = {
        ...this.runtime,
        mode: 'detached',
        attached: false,
        captureActive: false,
        url: ''
      }
      this.emitState()
    })

    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
      guest.debugger.on('message', (_event, method, params) => {
        this.handleDebuggerMessage(method, params)
      })
      guest.debugger.once('detach', (_event, reason) => {
        this.runtime.captureActive = false
        this.runtime.lastError = `消息监听已停止：${reason}`
        this.emitState()
      })
      await guest.debugger.sendCommand('Network.enable', {
        maxTotalBufferSize: 100_000_000,
        maxResourceBufferSize: 20_000_000
      })
      this.runtime.captureActive = true
      if (!usePddGuestSession()) {
        void this.chromeTransport.prepare().catch((error) => {
          this.runtime.lastError =
            error instanceof Error
              ? `真 Chrome 发送端：${error.message}`
              : '真 Chrome 发送端启动失败。'
          this.emitState()
        })
      }
      await this.refreshPersistentCounts()
      this.emitState()
    } catch (error) {
      this.runtime.mode = 'error'
      this.runtime.captureActive = false
      this.runtime.lastError = error instanceof Error ? error.message : '消息监听启动失败。'
      this.emitState()
    }
  }

  async getState(): Promise<PddRuntimeState> {
    if (this.runtime.mode === 'opening' && this.runtime.captureActive) {
      await this.probePageReady()
    }
    await this.refreshPersistentCounts()
    return structuredClone(this.runtime)
  }

  async setAutoReply(enabled: boolean): Promise<PddRuntimeState> {
    if (enabled && (this.runtime.mode !== 'online' || !this.runtime.captureActive)) {
      throw new Error('请先登录拼多多客服页并等待消息监听连接。')
    }
    await this.options.stateStore.setAutoReplyEnabled(enabled)
    this.runtime.autoReplyEnabled = enabled
    if (enabled) {
      // An explicit switch-on is already past the startup warmup; do not drop its first message.
      this.autoReplyReadyAt = Date.now()
    }
    this.emitState()
    return this.getState()
  }

  async prepareChrome(): Promise<void> {
    try {
      await this.chromeTransport.prepare()
      if (this.runtime.lastError?.startsWith('真 Chrome 发送端：')) {
        this.runtime.lastError = undefined
      }
    } catch (error) {
      this.runtime.lastError =
        error instanceof Error ? `真 Chrome 发送端：${error.message}` : '真 Chrome 发送端启动失败。'
      this.emitState()
      throw error
    }
  }

  async resumeAllConversations(): Promise<PddRuntimeState> {
    await this.options.stateStore.resumeAllConversations()
    await this.refreshPersistentCounts()
    this.emitState()
    return this.getState()
  }

  async confirmBuyerReceipt(platformMessageId: string): Promise<PddRuntimeState> {
    if (!(await this.options.stateStore.confirmBuyerReceipt(platformMessageId))) {
      throw new Error('待确认的发送回执不存在。')
    }
    await this.refreshPersistentCounts()
    this.emitState()
    return this.getState()
  }

  private emitState(): void {
    this.options.onStateChange?.()
  }

  private updateUrl(url: string): void {
    this.runtime.url = url
    if (/login|passport|janus/i.test(url)) this.runtime.mode = 'login_required'
    else if (this.runtime.mode !== 'online') this.runtime.mode = 'opening'
    this.emitState()
  }

  private async probePageReady(): Promise<void> {
    const guest = this.guest
    if (!guest || guest.isDestroyed()) return
    try {
      const result = (await guest.executeJavaScript(`(() => {
        const store = document.querySelector('#app')?.__vue__?.$store;
        const im = store?.state?.IMSDK;
        const crawler = window.riskControlCrawler
          || store?.state?.riskControlCrawler
          || im?.riskControlCrawler;
        return {
          hasStore: Boolean(store),
          hasSigner: Boolean(crawler && typeof crawler.messagePack === 'function')
        };
      })()`)) as { hasStore?: boolean; hasSigner?: boolean }
      if (result.hasStore && result.hasSigner) {
        this.runtime.mode = 'online'
        this.runtime.lastError = undefined
      } else if (!/login|passport|janus/i.test(guest.getURL())) {
        this.runtime.mode = 'opening'
      }
      this.emitState()
    } catch (error) {
      this.runtime.lastError = error instanceof Error ? error.message : '页面能力检测失败。'
      this.emitState()
    }
  }

  private handleDebuggerMessage(method: string, params: unknown): void {
    if (!isRecord(params)) return
    if (method === 'Network.webSocketFrameReceived') {
      const response = isRecord(params.response) ? params.response : undefined
      const payloadData =
        response && typeof response.payloadData === 'string' ? response.payloadData : ''
      const opcode = response ? Number(response.opcode ?? 0) : 0
      if (!payloadData) return
      this.handleTitanFrame(payloadData, opcode)
      return
    }
    if (method === 'Network.requestWillBeSent') this.detectHumanReply(params)
  }

  private handleTitanFrame(payloadData: string, opcode: number): void {
    for (const payload of decodeTitanPayload(payloadData, opcode)) {
      if (process.env.YZS_SCHEMA_CAPTURE_PATH) {
        void captureMessageShape('pdd', payload, 'system', 'frame')
      }
      for (const candidate of extractPddCandidates(payload)) {
        const message = normalizePddCandidate(candidate, this.options.profileId)
        if (!message) continue
        this.lookupOrdersFromCard(message)
        if (message.direction === 'in') {
          void captureMessageShape(
            'pdd',
            candidate.message,
            message.contentType,
            message.rawType || ''
          )
        }
        if (!this.runtime.autoReplyEnabled) continue
        if (Date.now() < this.autoReplyReadyAt) {
          if (message.direction === 'in') this.options.onMessage(message)
          continue
        }
        this.enqueue(() => this.processMessage(message))
      }
    }
  }

  private handleInjectedMessage(rawMessage: Record<string, unknown>): void {
    const message = normalizePddCandidate({ message: rawMessage }, this.options.profileId)
    if (!message || message.direction !== 'in') return
    this.lookupOrdersFromCard(message)
    if (message.contentType !== 'text') {
      void captureMessageShape('pdd', rawMessage, message.contentType, message.rawType || '')
    }
    if (this.runtime.autoReplyEnabled && Date.now() >= this.autoReplyReadyAt) {
      this.enqueue(() => this.processMessage(message))
      return
    }
    this.options.onMessage(message)
    this.runtime.mode = 'online'
    this.runtime.lastMessageAt = message.receivedAt
    this.emitState()
  }

  private lookupOrdersFromCard(message: NormalizedMessage): void {
    if (message.direction !== 'in' || message.contentType !== 'order_card') return
    const messageId = message.platformMessageId
    if (!messageId || this.probedOrderIds.has(messageId)) return
    const guest = this.guest
    if (!guest || guest.isDestroyed()) return
    const now = Date.now()
    if (now - (this.lastOrderProbeAt.get(message.buyerId) || 0) < 15_000) return
    this.lastOrderProbeAt.set(message.buyerId, now)
    this.probedOrderIds.add(messageId)
    if (this.probedOrderIds.size > 100)
      this.probedOrderIds.delete(this.probedOrderIds.values().next().value!)
    const diagnosticFile = process.env.PDD_ORDER_SHAPE_CAPTURE_PATH
    if (diagnosticFile) {
      void appendFile(
        diagnosticFile,
        `${JSON.stringify({
          at: new Date().toISOString(),
          platform: 'pdd',
          kind: 'order_query',
          status: 'dispatched'
        })}\n`,
        'utf8'
      ).catch(() => {})
    }
    void guest
      .executeJavaScript(createPddOrderProbeScript(message.buyerId))
      .then(async (value: PddOrderProbeResult) => {
        const status = [
          'ok',
          'wrong_origin',
          'signer_missing',
          'signer_error',
          'http_error',
          'invalid_json',
          'platform_error',
          'shape_changed',
          'buyer_mismatch',
          'error'
        ].includes(value?.status)
          ? value.status
          : 'error'
        if (status === 'ok' && Array.isArray(value.orders)) {
          this.orderContexts.set(message.buyerId, {
            profileId: this.options.profileId,
            buyerId: message.buyerId,
            fetchedAt: Date.now(),
            total: Number(value.total) || value.orders.length,
            orders: value.orders
          })
          if (this.orderContexts.size > 200)
            this.orderContexts.delete(this.orderContexts.keys().next().value!)
        }
        const file = process.env.PDD_ORDER_SHAPE_CAPTURE_PATH
        if (!file) return
        await appendFile(
          file,
          `${JSON.stringify({
            at: new Date().toISOString(),
            platform: 'pdd',
            kind: 'order_query',
            status,
            httpStatus: Number(value?.httpStatus) || undefined,
            platformSuccess:
              typeof value?.platformSuccess === 'boolean' ? value.platformSuccess : undefined,
            platformErrorCode: Number.isFinite(value?.platformErrorCode)
              ? value.platformErrorCode
              : undefined,
            orderCount: Number.isInteger(value?.orderCount) ? value.orderCount : undefined,
            mappedCount: Array.isArray(value?.orders) ? value.orders.length : undefined,
            hasStatus: Array.isArray(value?.orders)
              ? value.orders.some((item) => Boolean(item.rawOrderStatus))
              : undefined,
            hasSku: Array.isArray(value?.orders)
              ? value.orders.some((item) => Boolean(item.skuId))
              : undefined,
            shape: ['ok', 'platform_error', 'shape_changed'].includes(status)
              ? value.shape
              : undefined
          })}\n`,
          'utf8'
        )
      })
      .catch(async () => {
        const file = process.env.PDD_ORDER_SHAPE_CAPTURE_PATH
        if (file)
          await appendFile(
            file,
            `${JSON.stringify({
              at: new Date().toISOString(),
              platform: 'pdd',
              kind: 'order_query',
              status: 'execution_error'
            })}\n`,
            'utf8'
          ).catch(() => {})
      })
  }

  async getActiveBuyerOrders(): Promise<PddActiveOrderView> {
    const guest = this.guest
    if (!guest || guest.isDestroyed() || this.runtime.mode !== 'online')
      return { status: 'unavailable' }
    try {
      const buyerId = await guest.executeJavaScript(`(() => {
        if (location.hostname !== 'mms.pinduoduo.com') return '';
        const store = document.querySelector('#app')?.__vue__?.$store;
        const current = store?.state?.currentUserInfo;
        const uid = current?.userInfo?.uid ?? current?.uid;
        return uid == null ? '' : String(uid).trim();
      })()`)
      if (typeof buyerId !== 'string' || !buyerId) return { status: 'no_conversation' }
      const context = this.getCachedBuyerOrders(buyerId)
      if (!context) return { status: 'not_queried', buyerId }
      return {
        status: 'ready',
        buyerId,
        fetchedAt: context.fetchedAt,
        total: context.total,
        orders: context.orders
      }
    } catch {
      return { status: 'unavailable' }
    }
  }

  async queryActiveBuyerOrders(): Promise<PddActiveOrderView> {
    const current = await this.getActiveBuyerOrders()
    if (current.status !== 'ready' && current.status !== 'not_queried') return current
    const buyerId = current.buyerId
    const guest = this.guest
    if (!guest || guest.isDestroyed()) return { status: 'unavailable' }
    const now = Date.now()
    if (now - (this.lastOrderProbeAt.get(buyerId) || 0) < 15_000)
      return current.status === 'ready'
        ? current
        : { status: 'query_failed', buyerId, reason: 'rate_limited' }
    this.lastOrderProbeAt.set(buyerId, now)
    try {
      const result = (await guest.executeJavaScript(
        createPddOrderProbeScript(buyerId)
      )) as PddOrderProbeResult
      if (result?.status !== 'ok' || !Array.isArray(result.orders)) {
        const diagnosticFile = process.env.PDD_ORDER_SHAPE_CAPTURE_PATH
        if (diagnosticFile && result?.status === 'shape_changed')
          await appendFile(
            diagnosticFile,
            `${JSON.stringify({
              at: new Date().toISOString(),
              platform: 'pdd',
              kind: 'manual_order_query',
              status: result.status,
              shape: result.shape
            })}\n`,
            'utf8'
          ).catch(() => {})
        const reasons = [
          'wrong_origin', 'signer_missing', 'signer_error', 'http_error',
          'invalid_json', 'platform_error', 'shape_changed', 'buyer_mismatch', 'error'
        ]
        return {
          status: 'query_failed',
          buyerId,
          reason:
            typeof result?.status === 'string' && reasons.includes(result.status)
              ? result.status
              : 'error',
          code:
            typeof result?.platformErrorCode === 'number' &&
            Number.isFinite(result.platformErrorCode)
              ? result.platformErrorCode
              : undefined
        }
      }
      this.orderContexts.set(buyerId, {
        profileId: this.options.profileId,
        buyerId,
        fetchedAt: Date.now(),
        total: Number(result.total) || result.orders.length,
        orders: result.orders
      })
      if (this.orderContexts.size > 200)
        this.orderContexts.delete(this.orderContexts.keys().next().value!)
      return this.getActiveBuyerOrders()
    } catch {
      return { status: 'query_failed', buyerId, reason: 'execution_error' }
    }
  }

  getCachedBuyerOrders(buyerId: string): PddBuyerOrderContext | undefined {
    const context = this.orderContexts.get(buyerId)
    return context && Date.now() - context.fetchedAt < 120_000
      ? structuredClone(context)
      : undefined
  }
  private detectHumanReply(params: Record<string, unknown>): void {
    const request = isRecord(params.request) ? params.request : undefined
    const url = request && typeof request.url === 'string' ? request.url : ''
    if (!url.includes('/plateau/chat/send_message')) return
    const postData = request && typeof request.postData === 'string' ? request.postData : ''
    if (!postData) return
    try {
      const body = JSON.parse(postData) as Record<string, unknown>
      const data = isRecord(body.data) ? body.data : {}
      const message = isRecord(data.message) ? data.message : {}
      const to = isRecord(message.to) ? message.to : {}
      if (Number(message.manual_reply) !== 1 || Number(message.is_aut) === 1) return
      const buyerId = asString(to.uid)
      if (!buyerId) return
      const content = asString(message.content) || ''
      if (this.programmaticSendContent.get(buyerId) === content) return
      const conversationId = `pdd:${buyerId}`
      this.invalidatePendingReply(conversationId)
      void this.options.stateStore.pauseConversation(conversationId).then(async () => {
        await this.refreshPersistentCounts()
        this.emitState()
      })
    } catch {
      // Ignore unrelated or malformed requests.
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.processingQueue = this.processingQueue.then(task).catch((error) => {
      this.runtime.lastError = error instanceof Error ? error.message : '消息处理失败。'
      this.emitState()
    })
  }

  private invalidatePendingReply(conversationId: string): void {
    this.conversationGeneration.set(
      conversationId,
      (this.conversationGeneration.get(conversationId) || 0) + 1
    )
  }

  private async pendingReplyIsCurrent(
    conversationId: string,
    generation: number
  ): Promise<boolean> {
    return (
      this.conversationGeneration.get(conversationId) === generation &&
      this.runtime.autoReplyEnabled &&
      !(await this.options.stateStore.isConversationPaused(conversationId))
    )
  }

  private async processMessage(message: NormalizedMessage): Promise<void> {
    if (message.direction === 'out' && message.platformMessageId) {
      const sentByThisProgram = await this.options.stateStore.markMerchantEcho(
        message.platformMessageId
      )
      this.options.onMessage({ ...message, sendStatus: 'sent' })
      if (sentByThisProgram) {
        await this.refreshPersistentCounts()
        this.emitState()
      } else {
        await this.options.stateStore.pauseConversation(message.conversationId)
        await this.refreshPersistentCounts()
        this.emitState()
      }
      return
    }
    if (message.contentType !== 'text' || !message.text || !message.platformMessageId) {
      return
    }

    const claimed = await this.options.stateStore.claimMessage(message.platformMessageId)
    if (!claimed) {
      this.options.onTrace(this.createDuplicateTrace(message))
      return
    }

    this.options.onMessage(message)
    this.runtime.mode = 'online'
    this.runtime.lastMessageAt = message.receivedAt
    await this.refreshPersistentCounts()

    if (!this.runtime.autoReplyEnabled) {
      this.options.onTrace(this.createSkippedTrace(message, '自动回复已关闭。'))
      this.emitState()
      return
    }

    if (await this.options.stateStore.isConversationPaused(message.conversationId)) {
      this.options.onTrace(this.createSkippedTrace(message, '人工已接管，该会话保持暂停。', true))
      this.emitState()
      return
    }

    const replyGeneration = (this.conversationGeneration.get(message.conversationId) || 0) + 1
    this.conversationGeneration.set(message.conversationId, replyGeneration)

    const rules = this.options.getRules()
    const decision = resolveFixedReply(
      message.text,
      rules.intents,
      rules.bannedWords,
      rules.settings
    )
    if (!decision) {
      this.options.onTrace(this.createSkippedTrace(message, 'AI 总开关已关闭或缺少可用话术。'))
      this.emitState()
      return
    }

    const graceMs = Math.max(0, Number(process.env.PDD_REPLY_GRACE_MS ?? 1_200) || 0)
    if (graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs))
    }
    if (!(await this.pendingReplyIsCurrent(message.conversationId, replyGeneration))) {
      this.options.onTrace(
        this.createSkippedTrace(message, '检测到人工回复，已取消待发送的自动回复。', true)
      )
      await this.refreshPersistentCounts()
      this.emitState()
      return
    }

    const startedAt = Date.now()
    const requestId = String(Date.now())
    try {
      this.programmaticSendContent.set(message.buyerId, decision.reply)
      const result = await this.sendText(
        message.buyerId,
        decision.reply,
        requestId,
        message.platformMessageId
      ).finally(() => {
        if (this.programmaticSendContent.get(message.buyerId) === decision.reply) {
          this.programmaticSendContent.delete(message.buyerId)
        }
      })
      const accepted = result.ok && Boolean(result.platformMessageId)
      const receipt: StoredPddReceipt = {
        inboundMessageId: message.platformMessageId,
        requestId,
        buyerId: message.buyerId,
        ok: accepted,
        capturedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        platformMessageId: result.platformMessageId,
        code: result.code,
        message: accepted ? result.message : result.message || '平台未返回有效发送回执。',
        method: result.method,
        mallId: result.mallId
      }
      await this.options.stateStore.addReceipt(receipt)
      await this.refreshPersistentCounts()
      if (!accepted || !result.platformMessageId) {
        throw new Error(result.message || result.code || '平台未返回有效发送回执。')
      }

      this.options.onTrace({
        traceId: `pdd-trace-${message.platformMessageId}`,
        correlationId: requestId,
        attemptNo: 1,
        msgId: message.id,
        idempotentKey: `pdd-web:${this.options.profileId}:${message.platformMessageId}`,
        idempotentSource: 'platform_id',
        status: 'sent',
        steps: [
          {
            name: 'received',
            label: '收到真实消息',
            startedAt,
            endedAt: startedAt,
            state: 'done'
          },
          {
            name: 'resolve',
            label: decision.source === 'intent' ? '匹配固定意图' : '选择固定兜底话术',
            startedAt,
            endedAt: startedAt + 1,
            state: 'done'
          },
          {
            name: 'send',
            label: '同一客服页提交请求，平台返回 msg_id；等待商家端回显与买家端核验',
            startedAt: startedAt + 1,
            endedAt: Date.now(),
            state: 'done',
            detail: { platformMessageId: result.platformMessageId }
          }
        ],
        hitIntentId: decision.intentId,
        hitIntentName: decision.intentName,
        resolutionSource: decision.source,
        llmCalled: false,
        reply: decision.reply,
        bannedWordsReplaced: [],
        lengthTrimmed: false,
        humanIntervened: false,
        retryCount: 0,
        durationMs: Date.now() - startedAt
      })
      this.runtime.lastError = undefined
    } catch (error) {
      const messageText = error instanceof Error ? error.message : '发送失败。'
      const snapshot = await this.options.stateStore.snapshot()
      if (!snapshot.receipts.some((item) => item.requestId === requestId)) {
        await this.options.stateStore.addReceipt({
          inboundMessageId: message.platformMessageId,
          requestId,
          buyerId: message.buyerId,
          ok: false,
          capturedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          message: messageText
        })
      }
      await this.refreshPersistentCounts()
      this.options.onTrace({
        traceId: `pdd-trace-${message.platformMessageId}`,
        correlationId: requestId,
        attemptNo: 1,
        msgId: message.id,
        idempotentKey: `pdd-web:${this.options.profileId}:${message.platformMessageId}`,
        idempotentSource: 'platform_id',
        status: 'failed',
        steps: [
          {
            name: 'received',
            label: '收到真实消息',
            startedAt,
            endedAt: startedAt,
            state: 'done'
          },
          {
            name: 'send',
            label: '发送固定回复',
            startedAt,
            endedAt: Date.now(),
            state: 'failed'
          }
        ],
        resolutionSource: decision.source,
        llmCalled: false,
        reply: decision.reply,
        bannedWordsReplaced: [],
        lengthTrimmed: false,
        humanIntervened: false,
        retryCount: 0,
        durationMs: Date.now() - startedAt,
        error: messageText
      })
      this.runtime.lastError = messageText
    }
    this.emitState()
  }

  private async sendText(
    buyerId: string,
    text: string,
    requestId: string,
    previousMessageId: string
  ): Promise<PageSendResult> {
    if (usePddGuestSession()) {
      const guest = this.guest
      if (!guest || guest.isDestroyed()) throw new Error('拼多多客服页连接已断开。')
      const rawResult = await guest.executeJavaScript(
        createPddGuestSendScript({ buyerId, text, previousMessageId }),
        true
      )
      return { ...parsePddGuestSendResult(rawResult), requestId }
    }
    const result = await this.chromeTransport.sendText(buyerId, text, 1, previousMessageId)
    return { ...result, requestId }
  }

  private createDuplicateTrace(message: NormalizedMessage): MessageTrace {
    const now = Date.now()
    return {
      traceId: `pdd-duplicate-${message.platformMessageId}-${now}`,
      correlationId: `duplicate-${message.platformMessageId}`,
      attemptNo: 1,
      msgId: message.id,
      idempotentKey: `pdd-web:${this.options.profileId}:${message.platformMessageId}`,
      idempotentSource: 'platform_id',
      status: 'duplicate',
      steps: [
        {
          name: 'deduplicate',
          label: 'msg_id 已处理，忽略重复推送',
          startedAt: now,
          endedAt: now,
          state: 'done'
        }
      ],
      resolutionSource: 'none',
      llmCalled: false,
      reply: null,
      bannedWordsReplaced: [],
      lengthTrimmed: false,
      skipReason: 'duplicate_platform_message_id',
      humanIntervened: false,
      retryCount: 0,
      durationMs: 0
    }
  }

  private createSkippedTrace(
    message: NormalizedMessage,
    reason: string,
    humanIntervened = false
  ): MessageTrace {
    const now = Date.now()
    return {
      traceId: `pdd-skipped-${message.platformMessageId}`,
      correlationId: `skip-${message.platformMessageId}`,
      attemptNo: 1,
      msgId: message.id,
      idempotentKey: `pdd-web:${this.options.profileId}:${message.platformMessageId}`,
      idempotentSource: 'platform_id',
      status: 'skipped',
      steps: [
        {
          name: 'guard',
          label: reason,
          startedAt: now,
          endedAt: now,
          state: 'skipped'
        }
      ],
      resolutionSource: humanIntervened ? 'manual' : 'none',
      llmCalled: false,
      reply: null,
      bannedWordsReplaced: [],
      lengthTrimmed: false,
      skipReason: reason,
      humanIntervened,
      retryCount: 0,
      durationMs: 0
    }
  }

  private async refreshPersistentCounts(): Promise<void> {
    const snapshot = await this.options.stateStore.snapshot()
    const lastReceipt = snapshot.receipts.at(-1)
    this.runtime.processedCount = snapshot.processedMessageIds.length
    this.runtime.receiptCount = snapshot.receipts.length
    this.runtime.pausedConversations = snapshot.pausedConversations
    this.runtime.lastReceipt = lastReceipt
      ? {
          inboundMessageId: lastReceipt.inboundMessageId,
          platformMessageId: lastReceipt.platformMessageId,
          ok: lastReceipt.ok,
          capturedAt: lastReceipt.capturedAt,
          merchantEchoAt: lastReceipt.merchantEchoAt,
          buyerConfirmedAt: lastReceipt.buyerConfirmedAt,
          method: lastReceipt.method,
          mallId: lastReceipt.mallId,
          code: lastReceipt.code,
          message: lastReceipt.message
        }
      : undefined
  }
}
