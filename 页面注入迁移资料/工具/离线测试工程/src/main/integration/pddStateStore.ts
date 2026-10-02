import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredPddReceipt {
  inboundMessageId: string
  requestId: string
  buyerId: string
  ok: boolean
  capturedAt: number
  durationMs: number
  platformMessageId?: string
  code?: string
  message?: string
  method?: string
  mallId?: string
  merchantEchoAt?: number
  buyerConfirmedAt?: number
}

interface StoredState {
  version: 1
  autoReplyEnabled?: boolean
  processedMessageIds: string[]
  receipts: StoredPddReceipt[]
  pausedConversations: string[]
}

const EMPTY_STATE: StoredState = {
  version: 1,
  processedMessageIds: [],
  receipts: [],
  pausedConversations: []
}

export class PddStateStore {
  private state: StoredState = structuredClone(EMPTY_STATE)
  private loaded = false
  private loadPromise?: Promise<void>
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly maxProcessed = 10_000,
    private readonly maxReceipts = 2_000
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loadPromise ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredState>
        this.state = {
          version: 1,
          autoReplyEnabled:
            typeof parsed.autoReplyEnabled === 'boolean' ? parsed.autoReplyEnabled : undefined,
          processedMessageIds: Array.isArray(parsed.processedMessageIds)
            ? parsed.processedMessageIds.map(String).slice(-this.maxProcessed)
            : [],
          receipts: Array.isArray(parsed.receipts)
            ? (parsed.receipts as StoredPddReceipt[]).slice(-this.maxReceipts)
            : [],
          pausedConversations: Array.isArray(parsed.pausedConversations)
            ? [...new Set(parsed.pausedConversations.map(String))]
            : []
        }
      } catch {
        this.state = structuredClone(EMPTY_STATE)
      }
      this.loaded = true
    })()
    await this.loadPromise
  }

  private persist(): Promise<void> {
    const content = JSON.stringify(this.state, null, 2)
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, content, 'utf8')
    })
    return this.writeQueue
  }

  async claimMessage(messageId: string): Promise<boolean> {
    await this.ensureLoaded()
    if (this.state.processedMessageIds.includes(messageId)) return false
    this.state.processedMessageIds.push(messageId)
    this.state.processedMessageIds = this.state.processedMessageIds.slice(-this.maxProcessed)
    await this.persist()
    return true
  }

  async autoReplySetting(): Promise<boolean | undefined> {
    await this.ensureLoaded()
    return this.state.autoReplyEnabled
  }

  async setAutoReplyEnabled(enabled: boolean): Promise<void> {
    await this.ensureLoaded()
    this.state.autoReplyEnabled = enabled
    await this.persist()
  }

  async addReceipt(receipt: StoredPddReceipt): Promise<void> {
    await this.ensureLoaded()
    this.state.receipts.push(structuredClone(receipt))
    this.state.receipts = this.state.receipts.slice(-this.maxReceipts)
    await this.persist()
  }

  async markMerchantEcho(platformMessageId: string): Promise<boolean> {
    await this.ensureLoaded()
    const receipt = this.state.receipts.find((item) => item.platformMessageId === platformMessageId)
    if (!receipt) return false
    if (!receipt.ok || !receipt.merchantEchoAt) {
      receipt.ok = true
      receipt.merchantEchoAt ||= Date.now()
      await this.persist()
    }
    return true
  }

  async confirmBuyerReceipt(platformMessageId: string): Promise<boolean> {
    await this.ensureLoaded()
    const receipt = this.state.receipts.find((item) => item.platformMessageId === platformMessageId)
    if (!receipt) return false
    if (!receipt.ok || !receipt.buyerConfirmedAt) {
      receipt.ok = true
      receipt.buyerConfirmedAt ||= Date.now()
      await this.persist()
    }
    return true
  }

  async pauseConversation(conversationId: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.state.pausedConversations.includes(conversationId)) {
      this.state.pausedConversations.push(conversationId)
      await this.persist()
    }
  }

  async isConversationPaused(conversationId: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.state.pausedConversations.includes(conversationId)
  }

  async isOwnedOutgoingMessage(messageId: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.state.receipts.some((receipt) => receipt.platformMessageId === messageId)
  }

  async resumeAllConversations(): Promise<void> {
    await this.ensureLoaded()
    this.state.pausedConversations = []
    await this.persist()
  }

  async snapshot(): Promise<StoredState> {
    await this.ensureLoaded()
    return structuredClone(this.state)
  }
}
