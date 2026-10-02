import type { WebContents, WebFrameMain } from 'electron'
import type {
  BannedWord,
  DouyinRuntimeState,
  GeneralSettings,
  Intent,
  MessageTrace,
  NormalizedMessage
} from '@shared/contracts'
import { PddStateStore } from './pddStateStore'
import { resolveFixedReply } from './pddReplyResolver'
import { DOUYIN_BRIDGE_SCRIPT, douyinSendScript } from './douyinPageBridge'
import {
  normalizeDouyinMessage,
  shouldQueueDouyinReply,
  type DouyinPageMessage
} from './douyinMessage'
import { DouyinRecoveryState } from './douyinRecoveryState'
import { captureMessageShape } from './messageSchemaCapture'

interface Rules {
  intents: Intent[]
  bannedWords: BannedWord[]
  settings: GeneralSettings
}

interface Options {
  profileId: string
  stateStore: PddStateStore
  recoveryState: DouyinRecoveryState
  getRules(): Rules
  onMessage(message: NormalizedMessage): void
  onTrace(trace: MessageTrace): void
}

interface PageEvent extends DouyinPageMessage {
  kind: 'message' | 'manual'
  source?: 'live' | 'history'
  at?: number
}

interface PagePoll {
  ready: boolean
  reason?: 'login_expired' | 'permission_missing'
  historyPending?: number
  verifiedAt?: number
  events: PageEvent[]
}

interface SendResult {
  ok: boolean
  platformMessageId?: string
  message?: string
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class DouyinAdapter {
  private guest?: WebContents
  private activeFrame?: WebFrameMain
  private poller?: ReturnType<typeof setInterval>
  private polling = false
  private sendQueue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, NormalizedMessage[]>()
  private deferredEvents: PageEvent[] = []
  private historySyncStartedAt = 0
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly generation = new Map<string, number>()
  private readonly lastMerchantAt = new Map<string, number>()
  private recoveryCutoff = Date.now()
  private hasRecoveryBaseline = false
  private lastWatermarkWriteAt = 0
  private readonly runtime: DouyinRuntimeState

  constructor(private readonly options: Options) {
    this.runtime = {
      profileId: options.profileId,
      mode: 'detached',
      attached: false,
      autoReplyEnabled: process.env.DY_HOOK_AUTO_REPLY === 'true',
      url: '',
      processedCount: 0,
      receiptCount: 0,
      pausedConversations: []
    }
  }

  async attach(guest: WebContents): Promise<void> {
    if (this.guest?.id === guest.id) return
    this.detach()
    this.guest = guest
    this.runtime.attached = true
    this.runtime.mode = 'opening'
    this.runtime.url = guest.getURL()
    guest.on('did-navigate', (_event, url) => {
      this.runtime.url = url
    })
    guest.once('destroyed', () => {
      if (this.guest?.id === guest.id) this.detach()
    })
    const recovery = await this.options.recoveryState.snapshot()
    this.runtime.autoReplyEnabled = recovery.autoReplyEnabled
    this.hasRecoveryBaseline = recovery.lastOnlineAt > 0
    this.lastWatermarkWriteAt = recovery.lastOnlineAt
    this.recoveryCutoff = recovery.lastOnlineAt
      ? Math.max(recovery.lastOnlineAt - 5000, Date.now() - 24 * 60 * 60 * 1000)
      : Date.now() - 5000
    await this.refreshCounts()
    this.poller = setInterval(() => void this.poll(), 1500)
    void this.poll()
  }

  private detach(): void {
    if (this.poller) clearInterval(this.poller)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pending.clear()
    this.deferredEvents = []
    this.historySyncStartedAt = 0
    this.guest = undefined
    this.activeFrame = undefined
    this.runtime.attached = false
    this.runtime.mode = 'detached'
    this.runtime.url = ''
  }

  async getState(): Promise<DouyinRuntimeState> {
    await this.refreshCounts()
    return structuredClone(this.runtime)
  }

  async setAutoReply(enabled: boolean): Promise<DouyinRuntimeState> {
    if (enabled && this.runtime.mode !== 'online') {
      throw new Error('请先完成抖店登录并确认飞鸽会话权限。')
    }
    this.runtime.autoReplyEnabled = enabled
    await this.options.recoveryState.update({ autoReplyEnabled: enabled })
    if (!enabled) {
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
      this.pending.clear()
      for (const key of this.generation.keys()) this.invalidate(key)
    }
    return this.getState()
  }

  async resumeAllConversations(): Promise<DouyinRuntimeState> {
    await this.options.stateStore.resumeAllConversations()
    return this.getState()
  }

  private async refreshCounts(): Promise<void> {
    const snapshot = await this.options.stateStore.snapshot()
    this.runtime.processedCount = snapshot.processedMessageIds.length
    this.runtime.receiptCount = snapshot.receipts.length
    this.runtime.pausedConversations = snapshot.pausedConversations
    const last = snapshot.receipts.at(-1)
    this.runtime.lastReceipt = last && {
      inboundMessageId: last.inboundMessageId,
      platformMessageId: last.platformMessageId,
      ok: last.ok,
      capturedAt: last.capturedAt,
      message: last.message
    }
  }

  private async poll(): Promise<void> {
    const guest = this.guest
    if (this.polling || !guest || guest.isDestroyed()) return
    this.polling = true
    try {
      const url = guest.getURL()
      this.runtime.url = url
      if (!/^https:\/\/(im|jsls)\.jinritemai\.com\//.test(url)) {
        this.runtime.mode = /login|passport|fxg/i.test(url) ? 'login_required' : 'opening'
        if (this.runtime.mode === 'login_required') await this.disableForAuth()
        return
      }
      let result: PagePoll = { ready: false, events: [] }
      const frames = [guest.mainFrame, ...guest.mainFrame.frames]
      for (const frame of new Set(frames)) {
        try {
          const candidate = (await frame.executeJavaScript(DOUYIN_BRIDGE_SCRIPT)) as PagePoll
          if (!candidate.ready) {
            if (candidate.reason) result = candidate
            continue
          }
          result = candidate
          this.activeFrame = frame
          break
        } catch {
          // A frame can disappear while the seller page navigates.
        }
      }
      this.runtime.mode = result.ready
        ? 'online'
        : result.reason === 'login_expired'
          ? 'login_required'
          : result.reason === 'permission_missing'
            ? 'permission_required'
            : 'opening'
      if (result.reason) await this.disableForAuth()
      if (!result.ready) return
      const events = [...this.deferredEvents, ...(result.events || [])]
      if (result.historyPending) {
        this.historySyncStartedAt ||= Date.now()
        if (Date.now() - this.historySyncStartedAt > 20_000) {
          this.runtime.lastError = '飞鸽历史同步超时，自动回复已暂停；刷新页面后重新检查。'
          if (this.runtime.autoReplyEnabled) await this.setAutoReply(false)
          this.deferredEvents = []
          events.sort((left, right) => this.eventTime(left) - this.eventTime(right))
          for (const event of events) await this.accept(event)
          return
        }
        this.deferredEvents = events.filter((event) => event.kind === 'message').slice(-2000)
        for (const event of events) {
          if (event.kind === 'manual') await this.accept(event)
        }
        return
      }
      this.historySyncStartedAt = 0
      this.runtime.lastError = undefined
      this.deferredEvents = []
      events.sort((left, right) => this.eventTime(left) - this.eventTime(right))
      for (const event of events) await this.accept(event)
      const verifiedAt = Number(result.verifiedAt) || 0
      if (!this.hasRecoveryBaseline) {
        const baseline = Date.now()
        await this.options.recoveryState.update({ lastOnlineAt: baseline })
        this.hasRecoveryBaseline = true
        this.lastWatermarkWriteAt = baseline
      } else if (
        verifiedAt > this.lastWatermarkWriteAt &&
        !result.historyPending &&
        Date.now() - this.lastWatermarkWriteAt >= 30_000
      ) {
        await this.options.recoveryState.update({ lastOnlineAt: verifiedAt })
        this.lastWatermarkWriteAt = verifiedAt
      }
    } catch (error) {
      this.runtime.mode = 'error'
      this.runtime.lastError = error instanceof Error ? error.message : '飞鸽页面读取失败'
    } finally {
      this.polling = false
    }
  }

  private async disableForAuth(): Promise<void> {
    if (!this.runtime.autoReplyEnabled) return
    this.runtime.autoReplyEnabled = false
    await this.options.recoveryState.update({ autoReplyEnabled: false })
  }

  private eventTime(event: PageEvent): number {
    if (event.kind === 'manual') return Number(event.at) || Date.now()
    const raw = event.message as Record<string, unknown> | undefined
    const time = Number(raw?.createTime || raw?.timestamp || raw?.ts || raw?.time)
    return time > 1e12 ? time : time > 1e9 ? time * 1000 : Date.now()
  }

  private invalidate(key: string): number {
    const next = (this.generation.get(key) || 0) + 1
    this.generation.set(key, next)
    return next
  }

  private async accept(event: PageEvent): Promise<void> {
    if (event.kind === 'manual') {
      const key = `dy:${event.conversationId}`
      this.invalidate(key)
      const timer = this.timers.get(key)
      if (timer) clearTimeout(timer)
      this.timers.delete(key)
      this.pending.delete(key)
      await this.options.stateStore.pauseConversation(key)
      await this.refreshCounts()
      return
    }
    const message = normalizeDouyinMessage(event, this.options.profileId)
    if (!message || !message.platformMessageId) return
    if (message.direction === 'in' && message.contentType !== 'text') {
      void captureMessageShape('douyin', event.message, message.contentType, message.rawType || '')
    }
    if (message.direction === 'out') {
      if (await this.options.stateStore.markMerchantEcho(message.platformMessageId)) {
        this.options.onMessage({ ...message, sendStatus: 'sent' })
      } else {
        this.lastMerchantAt.set(
          message.conversationId,
          Math.max(message.occurredAt, this.lastMerchantAt.get(message.conversationId) || 0)
        )
        const pending = this.pending.get(message.conversationId)
        if (pending?.some((item) => item.occurredAt <= message.occurredAt)) {
          this.invalidate(message.conversationId)
          const timer = this.timers.get(message.conversationId)
          if (timer) clearTimeout(timer)
          this.timers.delete(message.conversationId)
          this.pending.delete(message.conversationId)
        }
      }
      return
    }
    const key = `dy:${this.options.profileId}:${message.platformMessageId}`
    if (!(await this.options.stateStore.claimMessage(key))) return
    this.options.onMessage(message)
    this.runtime.lastMessageAt = message.receivedAt
    await this.refreshCounts()
    if (!this.runtime.autoReplyEnabled) return
    const raw = event.message as Record<string, unknown> | undefined
    const hasTimestamp = Boolean(raw?.createTime || raw?.timestamp || raw?.ts || raw?.time)
    if (
      !shouldQueueDouyinReply(
        message,
        event.source,
        hasTimestamp,
        this.recoveryCutoff,
        this.lastMerchantAt.get(message.conversationId) || 0
      )
    )
      return
    if (await this.options.stateStore.isConversationPaused(message.conversationId)) return
    const bucket = this.pending.get(message.conversationId) || []
    bucket.push(message)
    this.pending.set(message.conversationId, bucket)
    const old = this.timers.get(message.conversationId)
    if (old) clearTimeout(old)
    const generation = this.invalidate(message.conversationId)
    this.timers.set(
      message.conversationId,
      setTimeout(() => {
        void this.flush(message.conversationId, generation).catch((error) => {
          this.runtime.lastError = error instanceof Error ? error.message : '飞鸽自动回复失败'
        })
      }, 3500)
    )
  }

  private async flush(conversationId: string, generation: number): Promise<void> {
    this.timers.delete(conversationId)
    const messages = this.pending.get(conversationId) || []
    this.pending.delete(conversationId)
    if (!messages.length || !this.runtime.autoReplyEnabled) return
    const last = messages.at(-1)!
    const startedAt = Date.now()
    const rules = this.options.getRules()
    const decision = resolveFixedReply(
      messages.map((item) => item.text).join('\n'),
      rules.intents,
      rules.bannedWords,
      rules.settings
    )
    if (!decision) return
    const sendWork = this.sendQueue.then(async (): Promise<SendResult | undefined> => {
      await delay(100)
      if (
        this.generation.get(conversationId) !== generation ||
        (await this.options.stateStore.isConversationPaused(conversationId)) ||
        !this.runtime.autoReplyEnabled
      )
        return undefined
      const guest = this.guest
      const frame = this.activeFrame
      if (!guest || guest.isDestroyed() || !frame) return undefined
      try {
        return (await frame.executeJavaScript(
          douyinSendScript(last.buyerId, decision.reply, last.receivedAt)
        )) as SendResult
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : '页面发送调用失败' }
      }
    })
    this.sendQueue = sendWork.catch(() => undefined)
    const result = await sendWork
    if (!result) return
    await this.options.stateStore.addReceipt({
      inboundMessageId: last.platformMessageId!,
      requestId: `dy-${startedAt}`,
      buyerId: last.buyerId,
      ok: result.ok,
      capturedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      platformMessageId: result.platformMessageId,
      message: result.message,
      method: 'im.sendText'
    })
    await this.refreshCounts()
    this.options.onTrace({
      traceId: `dy-trace-${last.platformMessageId}`,
      correlationId: `dy-${startedAt}`,
      attemptNo: 1,
      msgId: last.id,
      idempotentKey: `dy:${this.options.profileId}:${last.platformMessageId}`,
      idempotentSource: 'platform_id',
      status: result.ok ? 'sent' : 'failed',
      steps: [
        {
          name: 'received',
          label: `收到并合并 ${messages.length} 条买家消息`,
          startedAt,
          endedAt: startedAt,
          state: 'done'
        },
        {
          name: 'send',
          label: '飞鸽原生接口发送',
          startedAt,
          endedAt: Date.now(),
          state: result.ok ? 'done' : 'failed',
          detail: { platformMessageId: result.platformMessageId || '' }
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
      durationMs: Date.now() - startedAt,
      error: result.ok ? undefined : result.message
    })
  }
}
