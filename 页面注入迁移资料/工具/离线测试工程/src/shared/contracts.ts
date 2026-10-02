export type PlatformId = 'pdd-web' | 'douyin-feige' | 'qianniu'
export type StoreStatus = 'opening' | 'online' | 'offline'
export type KnownContentType = 'text' | 'image' | 'video' | 'order_card' | 'system'
export type TraceStatus =
  | 'pending'
  | 'duplicate'
  | 'skipped'
  | 'deciding'
  | 'generating'
  | 'sending'
  | 'sent'
  | 'transferred'
  | 'failed'
export type ResolutionSource =
  'intent' | 'llm' | 'fallback' | 'welcome' | 'transfer' | 'manual' | 'none'

export interface Store {
  profileId: string
  platformId: PlatformId
  storeId: string
  name: string
  status: StoreStatus
  unread: number
  aiEnabled: boolean
  pinned: boolean
}

export interface RawEnvelope {
  kind: 'platform_frame' | 'platform_response'
  capturedAt: number
  sizeBytes: number
  redacted: boolean
  truncated?: boolean
  fields?: Record<string, string | number | boolean | null>
}

export interface NormalizedMessage {
  id: string
  platformId: PlatformId
  profileId: string
  conversationId: string
  platformMessageId?: string
  buyerId: string
  buyerName?: string
  direction: 'in' | 'out'
  contentType: KnownContentType | (string & {})
  rawType?: string
  text?: string
  mediaUrl?: string
  orderId?: string
  goodsId?: string
  goodsTitle?: string
  skuText?: string
  rawOrderStatus?: string
  platformSequence?: number | string
  receivedSequence: number
  occurredAt: number
  receivedAt: number
  sendStatus?: 'pending' | 'sent' | 'failed'
  raw?: RawEnvelope
}

export interface TraceStep {
  name: string
  label: string
  startedAt: number
  endedAt?: number
  state: 'done' | 'active' | 'failed' | 'skipped'
  detail?: Record<string, string | number | boolean | null>
}

export interface MessageTrace {
  traceId: string
  correlationId: string
  attemptNo: number
  msgId: string
  idempotentKey: string
  idempotentSource: 'platform_id' | 'content_hash'
  status: TraceStatus
  steps: TraceStep[]
  hitIntentId?: string
  hitIntentName?: string
  resolutionSource: ResolutionSource
  llmCalled: boolean
  reply?: string | null
  bannedWordsReplaced: string[]
  lengthTrimmed: boolean
  skipReason?: string
  humanIntervened: boolean
  retryCount: number
  durationMs?: number | null
  error?: string
}

export type IntentCategory = '开场' | '售前' | '履约' | '售后' | '教学' | '经营' | '自定义知识'

export interface Intent {
  id: string
  name: string
  category: IntentCategory
  orderStatus: '通用' | '已下单' | '未下单'
  scope: '通用问题' | '指定商品'
  keywords: string[]
  reply: string
  enabled: boolean
  priority?: number
  createdAt: number
  updatedAt: number
}

export interface BannedWord {
  id: string
  word: string
  replacement: string
  enabled: boolean
  createdAt: number
}

export interface LlmConfigView {
  provider: string
  model: string
  configured: boolean
  keyHint?: string
}

export interface JevConfigView {
  provider: 'typesafe'
  model: string
  configured: boolean
  keyHint?: string
}

export interface JevDecisionResult {
  intentId: string | 'other'
  confidence: number
  probabilities: Record<string, number>
  needsHuman: number
  needsOrder: number
  tone: 'calm' | 'frustrated' | 'angry'
  toneConfidence: number
  model: string
  durationMs: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
}

export interface GeneralSettings {
  aiEnabledGlobal: boolean
  replyStyle: 'brief' | 'concise' | 'detailed' | 'humanlike'
  welcomeEnabled: boolean
  welcomeText: string
  fallbackReplies: string[]
  llm: LlmConfigView
  jev: JevConfigView
}

export interface WorkspaceSnapshot {
  store: Store
  rulePlatformId: PlatformId
  messages: NormalizedMessage[]
  traces: MessageTrace[]
  intents: Intent[]
  bannedWords: BannedWord[]
  settings: GeneralSettings
  generatedAt: number
}

export interface SimulateResult {
  scenario: string
  snapshot: WorkspaceSnapshot
}

export interface SendReceipt {
  ok: boolean
  code?: string
  message?: string
  durationMs?: number
  raw?: RawEnvelope
}

export interface PddOrderSummary {
  orderId: string
  mallId?: string
  goodsId?: string
  skuId?: string
  goodsTitle?: string
  spec?: string
  rawOrderStatus?: string
  rawGoodsPrice?: number
  rawOrderTime?: number
}

export type PddActiveOrderView =
  | { status: 'unavailable' }
  | { status: 'no_conversation' }
  | { status: 'not_queried'; buyerId: string }
  | { status: 'query_failed'; buyerId: string; reason: string; code?: number }
  | {
      status: 'ready'
      buyerId: string
      fetchedAt: number
      total: number
      orders: PddOrderSummary[]
    }

export interface PddRuntimeState {
  profileId: string
  sessionMode: 'guest' | 'chrome'
  autoReplyEnabled: boolean
  mode: 'detached' | 'opening' | 'login_required' | 'online' | 'error'
  attached: boolean
  captureActive: boolean
  url: string
  processedCount: number
  receiptCount: number
  pausedConversations: string[]
  lastMessageAt?: number
  lastReceipt?: {
    inboundMessageId: string
    platformMessageId?: string
    ok: boolean
    capturedAt: number
    merchantEchoAt?: number
    buyerConfirmedAt?: number
    method?: string
    mallId?: string
    code?: string
    message?: string
  }
  lastError?: string
}

export interface DouyinRuntimeState {
  profileId: string
  mode: 'detached' | 'opening' | 'login_required' | 'permission_required' | 'online' | 'error'
  attached: boolean
  autoReplyEnabled: boolean
  url: string
  processedCount: number
  receiptCount: number
  pausedConversations: string[]
  lastMessageAt?: number
  lastReceipt?: {
    inboundMessageId: string
    platformMessageId?: string
    ok: boolean
    capturedAt: number
    message?: string
  }
  lastError?: string
}

export interface QianniuClientState {
  configured: boolean
  executablePath: string
  clientFound: boolean
  messageBridgeReady: false
  pairedExecutablePath?: string
  transportExecutablePath?: string
  transportPathMatches?: boolean
  transportLoginPending?: boolean
  transportActive?: boolean
}

export interface QianniuViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface QianniuCompanionState {
  sidecarConnected: boolean
  clientRunning: boolean
  loginVisible: boolean
  receptionReady: boolean
  following: boolean
  opening: boolean
  lastError?: string
}

export interface QianniuObservedMessage {
  key: string
  storeId: string
  conversationId: string
  platformMessageId: string
  buyerName: string
  text: string
  sequence: number
  occurredAt: number
  receivedAt: number
}

export interface QianniuMonitorState {
  connected: boolean
  source: 'yunduo-local-sidecar'
  storeCount: number
  pendingCount: number
  observedCount: number
  messages: QianniuObservedMessage[]
  checkedAt: number
  error?: string
  notice?: string
  autoReplyEnabled?: boolean
  readyStoreCount?: number
  pausedCount?: number
  acceptedCount?: number
  lastReceipt?: {
    inboundMessageId: string
    buyerName: string
    text: string
    accepted: boolean
    at: number
    error?: string
  }
}

export interface MockScenario {
  id: string
  name: string
  description: string
  seed: number
  messages: NormalizedMessage[]
  expected: {
    traces: Array<Pick<MessageTrace, 'msgId' | 'resolutionSource' | 'status'>>
    minIntents?: number
  }
  failureInjection?: 'none' | 'send_failed' | 'llm_timeout' | 'duplicate_push'
}

export interface SecretPayload {
  provider: string
  model: string
  secret: string
}

export interface JevSecretPayload {
  model: string
  secret: string
}

export interface JevTestPayload {
  message: string
}

export interface DesktopApi {
  getSnapshot(): Promise<WorkspaceSnapshot>
  selectRulePlatform(platformId: PlatformId): Promise<WorkspaceSnapshot>
  simulateMessage(): Promise<SimulateResult>
  saveIntent(intent: Intent): Promise<WorkspaceSnapshot>
  deleteIntent(id: string): Promise<WorkspaceSnapshot>
  saveBannedWord(item: BannedWord): Promise<WorkspaceSnapshot>
  deleteBannedWord(id: string): Promise<WorkspaceSnapshot>
  saveSettings(settings: GeneralSettings): Promise<WorkspaceSnapshot>
  saveLlmSecret(payload: SecretPayload): Promise<LlmConfigView>
  deleteLlmSecret(): Promise<LlmConfigView>
  saveJevSecret(payload: JevSecretPayload): Promise<JevConfigView>
  deleteJevSecret(): Promise<JevConfigView>
  testJev(payload: JevTestPayload): Promise<JevDecisionResult>
  getPddRuntimeState(): Promise<PddRuntimeState>
  getPddActiveOrders(): Promise<PddActiveOrderView>
  queryPddActiveOrders(): Promise<PddActiveOrderView>
  setPddAutoReply(enabled: boolean): Promise<PddRuntimeState>
  getDouyinRuntimeState(): Promise<DouyinRuntimeState>
  getQianniuClientState(): Promise<QianniuClientState>
  findQianniuClient(): Promise<QianniuClientState>
  getQianniuCompanionState(): Promise<QianniuCompanionState>
  recognizeQianniu(): Promise<QianniuClientState>
  setQianniuViewport(bounds: QianniuViewportBounds): Promise<QianniuCompanionState>
  deactivateQianniuViewport(): Promise<void>
  pollQianniuMonitor(): Promise<QianniuMonitorState>
  setQianniuAutoReply(enabled: boolean): Promise<QianniuMonitorState>
  bindQianniuAccounts(): Promise<QianniuMonitorState>
  resumeAllQianniuConversations(): Promise<QianniuMonitorState>
  chooseQianniuClient(): Promise<QianniuClientState>
  setDouyinAutoReply(enabled: boolean): Promise<DouyinRuntimeState>
  resumeAllDouyinConversations(): Promise<DouyinRuntimeState>
  resumeAllPddConversations(): Promise<PddRuntimeState>
  confirmPddBuyerReceipt(platformMessageId: string): Promise<PddRuntimeState>
  setWindowMode(mode: 'login' | 'workbench'): Promise<void>
  minimizeWindow(): void
  toggleMaximizeWindow(): void
  closeWindow(): void
}
