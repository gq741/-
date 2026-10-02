import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { GeneralSettings, Intent, MessageTrace, NormalizedMessage } from '@shared/contracts'
import { PddAdapter } from './pddAdapter'
import { PddStateStore } from './pddStateStore'

class FakeDebugger extends EventEmitter {
  attached = false
  isAttached(): boolean {
    return this.attached
  }
  attach(): void {
    this.attached = true
  }
  async sendCommand(): Promise<Record<string, never>> {
    return {}
  }
}

class FakeWebContents extends EventEmitter {
  id = 99
  debugger = new FakeDebugger()
  scripts: string[] = []
  getURL(): string {
    return 'https://mms.pinduoduo.com/chat-merchant/index.html'
  }
  setWindowOpenHandler(): void {
    return undefined
  }
  isDestroyed(): boolean {
    return false
  }
  async executeJavaScript(script: string): Promise<unknown> {
    this.scripts.push(script)
    return {
      ok: true,
      requestId: '100',
      status: 200,
      platformMessageId: 'out-100',
      previousMessageId: 'in-1',
      timestamp: 1789978058,
      code: '200'
    }
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  delete process.env.PDD_HOOK_AUTO_REPLY
  delete process.env.PDD_HOOK_WARMUP_MS
  delete process.env.PDD_REPLY_GRACE_MS
  delete process.env.PDD_SEND_CONTEXT
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function titanFrame(messageId: string): { response: { opcode: number; payloadData: string } } {
  const payload = {
    push_type: 2,
    seq_id: Number(messageId.replace(/\D/g, '')) || 1,
    data: [
      {
        message: {
          ts: '1789977592',
          content: '什么时候发货？',
          type: 0,
          from: { role: 'user', uid: 'buyer-1' },
          to: { role: 'mall_cs', uid: 'mall-1' },
          msg_id: messageId,
          nickname: '买家A'
        }
      }
    ]
  }
  const binary = Buffer.concat([
    Buffer.from([0, 10, 0, 102]),
    gzipSync(JSON.stringify(payload)),
    Buffer.from([0, 1])
  ])
  return { response: { opcode: 2, payloadData: binary.toString('base64') } }
}

function outboundTitanFrame(messageId: string): {
  response: { opcode: number; payloadData: string }
} {
  const payload = {
    push_type: 2,
    seq_id: 20,
    data: [
      {
        message: {
          ts: '1789977593',
          content: '商家回复',
          type: 0,
          from: { role: 'mall_cs', uid: 'mall-1' },
          to: { role: 'user', uid: 'buyer-1' },
          msg_id: messageId
        }
      }
    ]
  }
  const binary = Buffer.concat([gzipSync(JSON.stringify(payload)), Buffer.from([0, 1])])
  return { response: { opcode: 2, payloadData: binary.toString('base64') } }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('等待异步处理超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('正式 PddAdapter 消息闭环', () => {
  it('页面能力晚于首次加载时，状态轮询可检测就绪并开启自动回复', async () => {
    process.env.PDD_HOOK_AUTO_REPLY = 'false'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-late-ready-'))
    temporaryDirectories.push(directory)
    const stateStore = new PddStateStore(join(directory, 'state.json'))
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore,
      getRules: () => ({
        intents: [],
        bannedWords: [],
        settings: {
          aiEnabledGlobal: true,
          replyStyle: 'concise',
          welcomeEnabled: false,
          welcomeText: '',
          fallbackReplies: ['收到'],
          llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
          jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
        }
      }),
      onMessage() {
        return undefined
      },
      onTrace() {
        return undefined
      }
    })
    class DelayedReadyGuest extends FakeWebContents {
      ready = false
      override async executeJavaScript(script: string): Promise<unknown> {
        if (script.includes('hasStore:')) return { hasStore: this.ready, hasSigner: this.ready }
        return super.executeJavaScript(script)
      }
    }
    const guest = new DelayedReadyGuest()
    await adapter.attach(guest as unknown as WebContents)
    expect((await adapter.getState()).mode).toBe('opening')
    guest.ready = true
    expect((await adapter.getState()).mode).toBe('online')
    expect((await adapter.setAutoReply(true)).autoReplyEnabled).toBe(true)
    expect(await stateStore.autoReplySetting()).toBe(true)
  })

  it('手动开启后立即到达的新消息不受启动预热期影响', async () => {
    process.env.PDD_HOOK_AUTO_REPLY = 'false'
    process.env.PDD_HOOK_WARMUP_MS = '60000'
    process.env.PDD_REPLY_GRACE_MS = '0'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-enable-now-'))
    temporaryDirectories.push(directory)
    const stateStore = new PddStateStore(join(directory, 'state.json'))
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore,
      getRules: () => ({
        intents: [],
        bannedWords: [],
        settings: {
          aiEnabledGlobal: true,
          replyStyle: 'concise',
          welcomeEnabled: false,
          welcomeText: '',
          fallbackReplies: ['收到'],
          llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
          jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
        }
      }),
      onMessage() {
        return undefined
      },
      onTrace() {
        return undefined
      }
    })
    class ReadyGuest extends FakeWebContents {
      override async executeJavaScript(script: string): Promise<unknown> {
        if (script.includes('hasStore:')) return { hasStore: true, hasSigner: true }
        return super.executeJavaScript(script)
      }
    }
    const guest = new ReadyGuest()
    await adapter.attach(guest as unknown as WebContents)
    await adapter.getState()
    await adapter.setAutoReply(true)
    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-1'))
    await waitFor(async () => (await stateStore.snapshot()).receipts.length === 1)
    expect((await stateStore.snapshot()).receipts[0]).toMatchObject({
      inboundMessageId: 'in-1',
      ok: true
    })
  })

  it('手动关闭自动回复后不处理新消息，重启仍保持关闭', async () => {
    process.env.PDD_HOOK_AUTO_REPLY = 'true'
    process.env.PDD_HOOK_WARMUP_MS = '0'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-switch-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state.json')
    const stateStore = new PddStateStore(path)
    const settings: GeneralSettings = {
      aiEnabledGlobal: true,
      replyStyle: 'concise',
      welcomeEnabled: false,
      welcomeText: '',
      fallbackReplies: ['收到'],
      llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
      jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
    }
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore,
      getRules: () => ({ intents: [], bannedWords: [], settings }),
      onMessage() {
        return undefined
      },
      onTrace() {
        return undefined
      }
    })
    const guest = new FakeWebContents()
    await adapter.attach(guest as unknown as WebContents)
    expect((await adapter.setAutoReply(false)).autoReplyEnabled).toBe(false)
    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-off'))
    expect((await stateStore.snapshot()).processedMessageIds).toEqual([])
    const restarted = new PddAdapter({
      profileId: 'profile-1',
      stateStore: new PddStateStore(path),
      getRules: () => ({ intents: [], bannedWords: [], settings }),
      onMessage() {
        return undefined
      },
      onTrace() {
        return undefined
      }
    })
    await restarted.attach(new FakeWebContents() as unknown as WebContents)
    expect((await restarted.getState()).autoReplyEnabled).toBe(false)
  })

  it('平台响应缺少出站 msg_id 时记录失败回执', async () => {
    process.env.PDD_SEND_CONTEXT = 'chrome'
    process.env.PDD_HOOK_AUTO_REPLY = 'true'
    process.env.PDD_HOOK_WARMUP_MS = '0'
    process.env.PDD_REPLY_GRACE_MS = '0'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-missing-ack-'))
    temporaryDirectories.push(directory)
    const traces: MessageTrace[] = []
    const settings: GeneralSettings = {
      aiEnabledGlobal: true,
      replyStyle: 'concise',
      welcomeEnabled: false,
      welcomeText: '',
      fallbackReplies: ['正在查询，请稍候。'],
      llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
      jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
    }
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore: new PddStateStore(join(directory, 'state.json')),
      getRules: () => ({ intents: [], bannedWords: [], settings }),
      onMessage() {
        return undefined
      },
      onTrace: (trace) => traces.push(trace),
      chromeTransport: {
        async prepare() {
          return undefined
        },
        async sendText() {
          return { ok: true, status: 200, method: 'chrome.page.test' }
        }
      }
    })
    const guest = new FakeWebContents()
    await adapter.attach(guest as unknown as WebContents)
    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-1'))
    await waitFor(() => traces.some((trace) => trace.status === 'failed'))
    expect((await adapter.getState()).lastReceipt).toMatchObject({
      inboundMessageId: 'in-1',
      ok: false,
      message: '平台未返回有效发送回执。'
    })
  })

  it('默认在接收消息的同一 webview 中发送，不启动独立 Chrome', async () => {
    process.env.PDD_HOOK_AUTO_REPLY = 'true'
    process.env.PDD_HOOK_WARMUP_MS = '0'
    process.env.PDD_REPLY_GRACE_MS = '0'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-guest-'))
    temporaryDirectories.push(directory)
    const traces: MessageTrace[] = []
    let chromePrepared = false
    const settings: GeneralSettings = {
      aiEnabledGlobal: true,
      replyStyle: 'concise',
      welcomeEnabled: false,
      welcomeText: '',
      fallbackReplies: ['正在查询，请稍候。'],
      llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
      jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
    }
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore: new PddStateStore(join(directory, 'state.json')),
      getRules: () => ({ intents: [], bannedWords: [], settings }),
      onMessage() {
        return undefined
      },
      onTrace: (trace) => traces.push(trace),
      chromeTransport: {
        async prepare() {
          chromePrepared = true
        },
        async sendText() {
          throw new Error('独立 Chrome 发送端不应参与同一 webview 模式。')
        }
      }
    })
    const guest = new FakeWebContents()
    await adapter.attach(guest as unknown as WebContents)
    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-1'))
    await waitFor(() => traces.some((trace) => trace.status === 'sent'))
    expect(chromePrepared).toBe(false)
    expect(guest.scripts.some((script) => script.includes('is_aut: 1'))).toBe(true)
    expect((await adapter.getState()).lastReceipt).toMatchObject({
      inboundMessageId: 'in-1',
      platformMessageId: 'out-100',
      ok: true
    })
  })

  it('去重、以自动标记发送、保存回执，并在人工回复后暂停', async () => {
    process.env.PDD_SEND_CONTEXT = 'chrome'
    process.env.PDD_HOOK_AUTO_REPLY = 'true'
    process.env.PDD_HOOK_WARMUP_MS = '0'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-adapter-'))
    temporaryDirectories.push(directory)
    const messages: NormalizedMessage[] = []
    const traces: MessageTrace[] = []
    const chromeSends: Array<{ buyerId: string; text: string; isAut?: 0 | 1 }> = []
    const settings: GeneralSettings = {
      aiEnabledGlobal: true,
      replyStyle: 'concise',
      welcomeEnabled: true,
      welcomeText: '您好',
      fallbackReplies: ['正在查询，请稍候。'],
      llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
      jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
    }
    const intents: Intent[] = [
      {
        id: 'ship',
        name: '催发货',
        category: '履约',
        orderStatus: '已下单',
        scope: '通用问题',
        keywords: ['什么时候发货'],
        reply: '仓库会尽快安排发出。',
        enabled: true,
        priority: 100,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore: new PddStateStore(join(directory, 'state.json')),
      getRules: () => ({ intents, bannedWords: [], settings }),
      onMessage: (message) => messages.push(message),
      onTrace: (trace) => traces.push(trace),
      chromeTransport: {
        async prepare() {
          return undefined
        },
        async sendText(buyerId, text, isAut) {
          chromeSends.push({ buyerId, text, isAut })
          return {
            ok: true,
            status: 200,
            platformMessageId: 'out-100',
            previousMessageId: 'in-1',
            timestamp: 1789978058,
            code: '200',
            method: 'chrome.page.fetch'
          }
        }
      }
    })
    const guest = new FakeWebContents()
    await adapter.attach(guest as unknown as WebContents)

    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-1'))
    await waitFor(() => traces.some((trace) => trace.status === 'sent'))
    expect(messages.map((message) => message.direction)).toEqual(['in'])
    expect(chromeSends).toEqual([{ buyerId: 'buyer-1', text: '仓库会尽快安排发出。', isAut: 1 }])
    expect((await adapter.getState()).lastReceipt).toMatchObject({
      inboundMessageId: 'in-1',
      platformMessageId: 'out-100',
      ok: true
    })

    guest.debugger.emit(
      'message',
      {},
      'Network.webSocketFrameReceived',
      outboundTitanFrame('out-100')
    )
    await waitFor(async () => Boolean((await adapter.getState()).lastReceipt?.merchantEchoAt))
    await waitFor(() => messages.length === 2)
    expect(messages.map((message) => message.direction)).toEqual(['in', 'out'])
    expect((await adapter.getState()).pausedConversations).toEqual([])

    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-1'))
    await waitFor(() => traces.some((trace) => trace.status === 'duplicate'))
    expect(chromeSends).toHaveLength(1)

    guest.debugger.emit(
      'message',
      {},
      'Network.webSocketFrameReceived',
      outboundTitanFrame('human-out-1')
    )
    await waitFor(async () => (await adapter.getState()).pausedConversations.length === 1)

    guest.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      request: {
        url: 'https://mms.pinduoduo.com/plateau/chat/send_message',
        postData: JSON.stringify({
          data: {
            message: {
              to: { role: 'user', uid: 'buyer-1' },
              from: { role: 'mall_cs' },
              content: '人工回复',
              is_aut: 0,
              manual_reply: 1
            }
          }
        })
      }
    })
    await waitFor(() => traces.some((trace) => trace.status === 'duplicate'))
    await waitFor(() => messages.length === 3 && chromeSends.length === 1)
    await waitFor(async () => (await adapter.getState()).pausedConversations.length === 1)

    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-2'))
    await waitFor(() => traces.some((trace) => trace.humanIntervened))
    expect(chromeSends).toHaveLength(1)
    expect((await adapter.getState()).pausedConversations).toEqual(['pdd:buyer-1'])
  })

  it('人工在发送宽限期内回复时取消待发送任务并暂停会话', async () => {
    process.env.PDD_SEND_CONTEXT = 'chrome'
    process.env.PDD_HOOK_AUTO_REPLY = 'true'
    process.env.PDD_HOOK_WARMUP_MS = '0'
    process.env.PDD_REPLY_GRACE_MS = '80'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-human-race-'))
    temporaryDirectories.push(directory)
    const traces: MessageTrace[] = []
    const chromeSends: string[] = []
    const settings: GeneralSettings = {
      aiEnabledGlobal: true,
      replyStyle: 'concise',
      welcomeEnabled: false,
      welcomeText: '',
      fallbackReplies: ['自动回复'],
      llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
      jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
    }
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore: new PddStateStore(join(directory, 'state.json')),
      getRules: () => ({ intents: [], bannedWords: [], settings }),
      onMessage() {
        return undefined
      },
      onTrace: (trace) => traces.push(trace),
      chromeTransport: {
        async prepare() {
          return undefined
        },
        async sendText(_buyerId, text) {
          chromeSends.push(text)
          return {
            ok: true,
            status: 200,
            platformMessageId: 'out-race-1',
            method: 'chrome.page.test'
          }
        }
      }
    })
    const guest = new FakeWebContents()
    await adapter.attach(guest as unknown as WebContents)

    guest.debugger.emit('message', {}, 'Network.webSocketFrameReceived', titanFrame('in-race-1'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    guest.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      request: {
        url: 'https://mms.pinduoduo.com/plateau/chat/send_message',
        postData: JSON.stringify({
          data: {
            message: {
              to: { role: 'user', uid: 'buyer-1' },
              content: '人工已接管',
              is_aut: 0,
              manual_reply: 1
            }
          }
        })
      }
    })

    await waitFor(() => traces.some((trace) => trace.humanIntervened))
    expect(chromeSends).toEqual([])
    expect((await adapter.getState()).pausedConversations).toEqual(['pdd:buyer-1'])
  })

  it('页面注入消息在观察模式下只入库、不发回复', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdd-hook-capture-'))
    temporaryDirectories.push(directory)
    const messages: NormalizedMessage[] = []
    const traces: MessageTrace[] = []
    const chromeSends: Array<{ buyerId: string; text: string; isAut?: 0 | 1 }> = []
    let injectedListener: ((message: Record<string, unknown>) => void) | undefined
    const settings: GeneralSettings = {
      aiEnabledGlobal: true,
      replyStyle: 'concise',
      welcomeEnabled: false,
      welcomeText: '',
      fallbackReplies: ['正在查询，请稍候。'],
      llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
      jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
    }
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore: new PddStateStore(join(directory, 'state.json')),
      getRules: () => ({ intents: [], bannedWords: [], settings }),
      onMessage: (message) => messages.push(message),
      onTrace: (trace) => traces.push(trace),
      chromeTransport: {
        setMessageListener(listener) {
          injectedListener = listener
        },
        async prepare() {
          return undefined
        },
        async sendText(buyerId, text, isAut) {
          chromeSends.push({ buyerId, text, isAut })
          return { ok: true, status: 200, method: 'chrome.page.hook-test' }
        }
      }
    })

    await adapter.attach(new FakeWebContents() as unknown as WebContents)
    injectedListener?.({
      ts: '1789977592',
      content: '页面注入接收测试',
      type: 0,
      from: { role: 'user', uid: 'buyer-hook-1' },
      to: { role: 'mall_cs', uid: 'mall-1' },
      msg_id: 'hook-in-1',
      nickname: '买家B'
    })

    await waitFor(() => messages.length === 1)
    expect(messages[0]).toMatchObject({
      id: 'pdd-profile-1-hook-in-1',
      direction: 'in',
      buyerId: 'buyer-hook-1',
      text: '页面注入接收测试'
    })
    expect(chromeSends).toEqual([])
    expect(traces).toEqual([])
    expect((await adapter.getState()).lastMessageAt).not.toBeNull()
  })
  it('只读查询在自动回复关闭时仍按买家缓存订单且同一消息只查一次', async () => {
    process.env.PDD_HOOK_AUTO_REPLY = 'false'
    const directory = await mkdtemp(join(tmpdir(), 'pdd-order-context-'))
    temporaryDirectories.push(directory)
    let injectedListener: ((message: Record<string, unknown>) => void) | undefined
    class OrderPage extends FakeWebContents {
      selectedBuyer = '123'
      override async executeJavaScript(script: string): Promise<unknown> {
        this.scripts.push(script)
        if (script.includes('const current = store?.state?.currentUserInfo'))
          return this.selectedBuyer
        if (script.includes('userAllOrder') && this.selectedBuyer === '999')
          return { status: 'ok', orderCount: 0, total: 0, orders: [] }
        if (script.includes('userAllOrder') && this.selectedBuyer === '888')
          return { status: 'platform_error', platformErrorCode: 19001 }
        return {
          status: 'ok',
          orderCount: 1,
          total: 1,
          orders: [
            { orderId: 'ORDER-1', goodsId: 'GOODS-1', skuId: 'SKU-1', rawOrderStatus: '待发货' }
          ]
        }
      }
    }
    const guest = new OrderPage()
    const adapter = new PddAdapter({
      profileId: 'profile-1',
      stateStore: new PddStateStore(join(directory, 'state.json')),
      getRules: () => ({ intents: [], bannedWords: [], settings: {} as GeneralSettings }),
      onMessage: () => undefined,
      onTrace: () => undefined,
      chromeTransport: {
        setMessageListener(listener) {
          injectedListener = listener
        },
        async prepare() {
          return undefined
        },
        async sendText() {
          return { ok: true, status: 200, method: 'mock' }
        }
      }
    })
    await adapter.attach(guest as unknown as WebContents)
    const card = {
      msg_id: 'CARD-1',
      type: 0,
      content: '订单信息',
      info: { order_id: 'ORDER-1', order_status: 2, orderBriefPrompt: '查看订单' },
      from: { role: 'user', uid: '123' },
      to: { role: 'mall_cs' }
    }
    injectedListener?.(card)
    await waitFor(() => Boolean(adapter.getCachedBuyerOrders('123')))
    expect(adapter.getCachedBuyerOrders('123')).toMatchObject({
      profileId: 'profile-1',
      buyerId: '123',
      total: 1,
      orders: [{ orderId: 'ORDER-1', rawOrderStatus: '待发货' }]
    })
    expect(adapter.getCachedBuyerOrders('999')).toBeUndefined()
    await adapter.getState()
    expect(await adapter.getActiveBuyerOrders()).toMatchObject({
      status: 'ready',
      buyerId: '123',
      total: 1,
      orders: [{ orderId: 'ORDER-1' }]
    })
    guest.selectedBuyer = '999'
    expect(await adapter.getActiveBuyerOrders()).toEqual({ status: 'not_queried', buyerId: '999' })
    guest.selectedBuyer = ''
    expect(await adapter.getActiveBuyerOrders()).toEqual({ status: 'no_conversation' })
    injectedListener?.(card)
    expect(guest.scripts.filter((script) => script.includes('userAllOrder'))).toHaveLength(1)
    guest.selectedBuyer = '999'
    expect(await adapter.queryActiveBuyerOrders()).toMatchObject({
      status: 'ready',
      buyerId: '999',
      total: 0,
      orders: []
    })
    expect(adapter.getCachedBuyerOrders('123')?.orders).toHaveLength(1)
    expect(guest.scripts.filter((script) => script.includes('userAllOrder'))).toHaveLength(2)
    guest.selectedBuyer = '888'
    expect(await adapter.queryActiveBuyerOrders()).toEqual({
      status: 'query_failed',
      buyerId: '888',
      reason: 'platform_error',
      code: 19001
    })
    expect(await adapter.queryActiveBuyerOrders()).toEqual({
      status: 'query_failed',
      buyerId: '888',
      reason: 'rate_limited'
    })
    expect(guest.scripts.filter((script) => script.includes('userAllOrder'))).toHaveLength(3)
    guest.selectedBuyer = ''
    expect(await adapter.queryActiveBuyerOrders()).toEqual({ status: 'no_conversation' })
    expect(guest.scripts.filter((script) => script.includes('userAllOrder'))).toHaveLength(3)
  })
})
