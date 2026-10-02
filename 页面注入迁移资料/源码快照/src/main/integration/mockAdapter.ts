import type {
  BannedWord,
  GeneralSettings,
  Intent,
  JevConfigView,
  LlmConfigView,
  MessageTrace,
  NormalizedMessage,
  PlatformId,
  SimulateResult,
  Store,
  WorkspaceSnapshot
} from '@shared/contracts'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PlatformAdapter } from './types'
import { redactRecord } from './redaction'

const BASE_TIME = Date.UTC(2026, 8, 21, 1, 0, 0)

const store: Store = {
  profileId: 'profile-pdd-demo-001',
  platformId: 'pdd-web',
  storeId: 'store-demo-001',
  name: '青禾生活馆',
  status: 'online',
  unread: 2,
  aiEnabled: true,
  pinned: true
}

const intents: Intent[] = [
  {
    id: 'intent-logistics',
    name: '物流-默认快递',
    category: '履约',
    orderStatus: '通用',
    scope: '通用问题',
    keywords: ['发什么快递', '默认快递', '什么快递'],
    reply: '亲，店铺默认发中通快递，下单后会尽快安排出库。',
    enabled: true,
    priority: 90,
    createdAt: BASE_TIME - 800000,
    updatedAt: BASE_TIME - 800000
  },
  {
    id: 'intent-ship',
    name: '履约-催发货',
    category: '履约',
    orderStatus: '已下单',
    scope: '通用问题',
    keywords: ['什么时候发货', '催发货', '还没发货'],
    reply: '已经帮您关注订单，仓库会按下单顺序尽快发出。',
    enabled: true,
    priority: 80,
    createdAt: BASE_TIME - 700000,
    updatedAt: BASE_TIME - 700000
  },
  {
    id: 'intent-price',
    name: '售前-价格咨询',
    category: '售前',
    orderStatus: '未下单',
    scope: '指定商品',
    keywords: ['能便宜吗', '最低价', '有优惠吗'],
    reply: '当前页面价格已经包含店铺活动，您可以先领取页面优惠券再下单。',
    enabled: true,
    priority: 70,
    createdAt: BASE_TIME - 600000,
    updatedAt: BASE_TIME - 600000
  },
  {
    id: 'intent-after-sale',
    name: '售后-退换货',
    category: '售后',
    orderStatus: '已下单',
    scope: '通用问题',
    keywords: ['退货', '换货', '质量问题'],
    reply: '可以先把具体情况和商品照片发来，我会马上为您核对售后方案。',
    enabled: true,
    priority: 60,
    createdAt: BASE_TIME - 500000,
    updatedAt: BASE_TIME - 500000
  },
  {
    id: 'intent-human',
    name: '服务-转人工',
    category: '售后',
    orderStatus: '通用',
    scope: '通用问题',
    keywords: ['人工', '转客服', '找客服'],
    reply: '正在为您转接人工客服，请稍候。',
    enabled: true,
    priority: 100,
    createdAt: BASE_TIME - 400000,
    updatedAt: BASE_TIME - 400000
  }
]

const bannedWords: BannedWord[] = [
  {
    id: 'bw-1',
    word: '微信',
    replacement: '在线联系',
    enabled: true,
    createdAt: BASE_TIME - 300000
  },
  { id: 'bw-2', word: '绝对', replacement: '通常', enabled: true, createdAt: BASE_TIME - 290000 },
  {
    id: 'bw-3',
    word: '百分百',
    replacement: '大多数情况下',
    enabled: true,
    createdAt: BASE_TIME - 280000
  }
]

const settings: GeneralSettings = {
  aiEnabledGlobal: true,
  replyStyle: 'concise',
  welcomeEnabled: true,
  welcomeText: '您好，我是店铺智能助手，很高兴为您服务。',
  fallbackReplies: [
    '您好，云值守已收到您的本次测试消息。',
    '您的问题已经收到，马上为您确认。',
    '正在查询相关信息，请稍候。'
  ],
  llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
  jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
}

function message(
  index: number,
  buyer: string,
  text: string,
  direction: 'in' | 'out',
  offset: number
): NormalizedMessage {
  const occurredAt = BASE_TIME + offset
  return {
    id: `msg-${index}`,
    platformId: 'pdd-web',
    profileId: store.profileId,
    conversationId: `conversation-${buyer}`,
    platformMessageId: `platform-${index}`,
    buyerId: buyer,
    buyerName: buyer,
    direction,
    contentType: 'text',
    text,
    receivedSequence: index,
    occurredAt,
    receivedAt: occurredAt + 120,
    sendStatus: direction === 'out' ? 'sent' : undefined,
    raw: redactRecord({ event: 'message', type: 'text', direction }, occurredAt)
  }
}

const initialMessages: NormalizedMessage[] = [
  message(1, '买家·小鹿', '这个发什么快递？', 'in', 0),
  message(2, '买家·小鹿', '亲，店铺默认发中通快递，下单后会尽快安排出库。', 'out', 1220),
  message(3, '买家·晚风', '你们这个和图片看起来不太一样', 'in', 100000),
  message(
    4,
    '买家·晚风',
    '不同屏幕显示会有轻微色差，可以把实拍照片发来，我帮您进一步确认。',
    'out',
    102860
  ),
  message(5, '买家·山野', '我要找人工客服', 'in', 210000),
  message(6, '买家·山野', '正在为您转接人工客服，请稍候。', 'out', 210680),
  message(7, '买家·星河', '什么时候可以发货呀', 'in', 340000),
  message(8, '买家·星河', '已经帮您关注订单，仓库会按下单顺序尽快发出。', 'out', 341080)
]

function trace(
  inputId: string,
  id: number,
  options: Partial<MessageTrace> & { reply: string; status?: MessageTrace['status'] }
): MessageTrace {
  const startedAt = BASE_TIME + (id - 1) * 100000
  const duration = options.durationMs ?? 1200
  return {
    traceId: `trace-${id}`,
    correlationId: `corr-${id}`,
    attemptNo: 1,
    msgId: inputId,
    idempotentKey: `pdd-web:${store.profileId}:${inputId}`,
    idempotentSource: 'platform_id',
    status: options.status ?? 'sent',
    steps: [
      { name: 'received', label: '收到消息', startedAt, endedAt: startedAt + 40, state: 'done' },
      {
        name: 'guard',
        label: '接待条件检查',
        startedAt: startedAt + 40,
        endedAt: startedAt + 90,
        state: 'done',
        detail: { aiEnabled: true, buyerPaused: false }
      },
      {
        name: 'resolve',
        label: options.llmCalled
          ? '模型生成回复'
          : options.status === 'transferred'
            ? '识别转人工'
            : '匹配意图',
        startedAt: startedAt + 90,
        endedAt: startedAt + duration - 180,
        state: 'done'
      },
      {
        name: 'send',
        label: options.status === 'transferred' ? '执行转接' : '发送回复',
        startedAt: startedAt + duration - 180,
        endedAt: startedAt + duration,
        state: options.status === 'failed' ? 'failed' : 'done'
      }
    ],
    hitIntentId: options.hitIntentId,
    hitIntentName: options.hitIntentName,
    resolutionSource: options.resolutionSource ?? 'intent',
    llmCalled: options.llmCalled ?? false,
    reply: options.reply,
    bannedWordsReplaced: [],
    lengthTrimmed: false,
    humanIntervened: options.humanIntervened ?? false,
    retryCount: 0,
    durationMs: duration,
    error: options.error
  }
}

const initialTraces: MessageTrace[] = [
  trace('msg-1', 1, {
    reply: initialMessages[1].text ?? '',
    hitIntentId: 'intent-logistics',
    hitIntentName: '物流-默认快递',
    resolutionSource: 'intent',
    durationMs: 1220
  }),
  trace('msg-3', 2, {
    reply: initialMessages[3].text ?? '',
    resolutionSource: 'llm',
    llmCalled: true,
    durationMs: 2860
  }),
  trace('msg-5', 3, {
    reply: initialMessages[5].text ?? '',
    status: 'transferred',
    hitIntentId: 'intent-human',
    hitIntentName: '服务-转人工',
    resolutionSource: 'transfer',
    durationMs: 680
  }),
  trace('msg-7', 4, {
    reply: initialMessages[7].text ?? '',
    hitIntentId: 'intent-ship',
    hitIntentName: '履约-催发货',
    resolutionSource: 'intent',
    durationMs: 1080
  })
]

interface MockScenario {
  buyer: string
  text: string
  reply: string
  source: 'intent' | 'llm' | 'transfer' | 'none'
  intent?: Intent
  duration: number
  status?: MessageTrace['status']
}

const scenarios: MockScenario[] = [
  {
    buyer: '买家·北岛',
    text: '这个发什么快递？',
    reply: intents[0].reply,
    source: 'intent' as const,
    intent: intents[0],
    duration: 940
  },
  {
    buyer: '买家·拾光',
    text: '这个面料夏天穿会不会热？',
    reply:
      '这款面料偏轻薄，日常通勤穿着比较透气；如果您所在地区特别炎热，也可以告诉我温度和使用场景，我再帮您判断。',
    source: 'llm' as const,
    duration: 2480
  },
  {
    buyer: '买家·青柠',
    text: '帮我转人工客服',
    reply: intents[4].reply,
    source: 'transfer',
    intent: intents[4],
    duration: 620
  },
  {
    buyer: '买家·北岛',
    text: '这个发什么快递？',
    reply: '',
    source: 'none',
    duration: 40,
    status: 'duplicate'
  },
  {
    buyer: '买家·空谷',
    text: '[系统通知]',
    reply: '',
    source: 'none',
    duration: 55,
    status: 'skipped'
  },
  {
    buyer: '买家·微雨',
    text: '这个活动怎么参加？',
    reply: '',
    source: 'llm',
    duration: 3200,
    status: 'failed'
  }
]

interface Rules {
  intents: Intent[]
  bannedWords: BannedWord[]
  settings: GeneralSettings
}

export class MockPlatformAdapter implements PlatformAdapter {
  private messages = structuredClone(initialMessages)
  private traces = structuredClone(initialTraces)
  private rulePlatformId: PlatformId = 'pdd-web'
  private rulesByPlatform: Record<PlatformId, Rules> = {
    'pdd-web': {
      intents: structuredClone(intents),
      bannedWords: structuredClone(bannedWords),
      settings: structuredClone(settings)
    },
    'douyin-feige': {
      intents: structuredClone(intents),
      bannedWords: structuredClone(bannedWords),
      settings: structuredClone(settings)
    },
    qianniu: {
      intents: structuredClone(intents),
      bannedWords: structuredClone(bannedWords),
      settings: structuredClone(settings)
    }
  }
  private rulesFile?: string
  private scenarioIndex = 0

  loadRules(filePath: string): void {
    if (existsSync(filePath)) {
      const data = JSON.parse(readFileSync(filePath, 'utf8')) as {
        version?: number
        platforms?: Record<PlatformId, Rules>
      }
      if (data.version !== 1 || !data.platforms)
        throw new Error('规则文件格式错误，请检查本机规则数据。')
      for (const platformId of ['pdd-web', 'douyin-feige', 'qianniu'] as const) {
        const rules = data.platforms[platformId]
        if (!rules) continue
        if (
          !Array.isArray(rules.intents) ||
          !Array.isArray(rules.bannedWords) ||
          !rules.settings ||
          !Array.isArray(rules.settings.fallbackReplies)
        ) {
          throw new Error(`规则文件中 ${platformId} 的数据格式错误。`)
        }
        this.rulesByPlatform[platformId] = structuredClone(rules)
      }
    }
    this.rulesFile = filePath
  }

  selectRulePlatform(platformId: PlatformId): WorkspaceSnapshot {
    if (!this.rulesByPlatform[platformId]) throw new Error('未知客服平台。')
    this.rulePlatformId = platformId
    return this.getSnapshot()
  }

  getRules(platformId: PlatformId): Rules {
    return structuredClone(this.rulesByPlatform[platformId])
  }

  private updateRules(change: (rules: Rules) => void): WorkspaceSnapshot {
    const next = structuredClone(this.rulesByPlatform)
    change(next[this.rulePlatformId])
    if (this.rulesFile) {
      mkdirSync(dirname(this.rulesFile), { recursive: true })
      const temporary = `${this.rulesFile}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, platforms: next }, null, 2), 'utf8')
      renameSync(temporary, this.rulesFile)
    }
    this.rulesByPlatform = next
    return this.getSnapshot()
  }

  getSnapshot(): WorkspaceSnapshot {
    return structuredClone({
      store,
      rulePlatformId: this.rulePlatformId,
      messages: this.messages,
      traces: this.traces,
      ...this.rulesByPlatform[this.rulePlatformId],
      generatedAt: BASE_TIME + 500000
    })
  }

  simulateMessage(): SimulateResult {
    const scenario = scenarios[this.scenarioIndex % scenarios.length]
    this.scenarioIndex += 1
    const sequence = this.messages.length + 1
    const offset = 500000 + this.scenarioIndex * 10000
    const input = message(sequence, scenario.buyer, scenario.text, 'in', offset)
    this.messages.push(input)
    if (scenario.reply) {
      this.messages.push(
        message(sequence + 1, scenario.buyer, scenario.reply, 'out', offset + scenario.duration)
      )
    }
    const status = scenario.status ?? (scenario.source === 'transfer' ? 'transferred' : 'sent')
    this.traces.push(
      trace(input.id, this.traces.length + 1, {
        reply: scenario.reply,
        status,
        resolutionSource: scenario.source,
        llmCalled: scenario.source === 'llm',
        hitIntentId: scenario.intent?.id,
        hitIntentName: scenario.intent?.name,
        durationMs: scenario.duration
      })
    )
    return { scenario: scenario.source, snapshot: this.getSnapshot() }
  }

  saveIntent(intent: Intent): WorkspaceSnapshot {
    return this.updateRules((rules) => {
      const index = rules.intents.findIndex((item) => item.id === intent.id)
      if (index >= 0) rules.intents[index] = structuredClone(intent)
      else rules.intents.unshift(structuredClone(intent))
    })
  }

  deleteIntent(id: string): WorkspaceSnapshot {
    return this.updateRules((rules) => {
      rules.intents = rules.intents.filter((item) => item.id !== id)
    })
  }

  saveBannedWord(item: BannedWord): WorkspaceSnapshot {
    return this.updateRules((rules) => {
      const index = rules.bannedWords.findIndex((entry) => entry.id === item.id)
      if (index >= 0) rules.bannedWords[index] = structuredClone(item)
      else rules.bannedWords.unshift(structuredClone(item))
    })
  }

  deleteBannedWord(id: string): WorkspaceSnapshot {
    return this.updateRules((rules) => {
      rules.bannedWords = rules.bannedWords.filter((item) => item.id !== id)
    })
  }

  saveSettings(next: GeneralSettings): WorkspaceSnapshot {
    return this.updateRules((rules) => {
      rules.settings = structuredClone(next)
    })
  }

  setLlmView(view: LlmConfigView): void {
    for (const rules of Object.values(this.rulesByPlatform))
      rules.settings.llm = structuredClone(view)
  }

  setJevView(view: JevConfigView): void {
    for (const rules of Object.values(this.rulesByPlatform))
      rules.settings.jev = structuredClone(view)
  }

  ingestLiveMessage(message: NormalizedMessage): void {
    if (this.messages.some((item) => item.id === message.id)) return
    this.messages.push(structuredClone(message))
    this.messages = this.messages.slice(-500)
  }

  ingestLiveTrace(value: MessageTrace): void {
    if (this.traces.some((item) => item.traceId === value.traceId)) return
    this.traces.push(structuredClone(value))
    this.traces = this.traces.slice(-500)
  }
}
