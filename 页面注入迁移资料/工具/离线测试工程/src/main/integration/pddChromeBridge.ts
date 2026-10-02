import { access, appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Page } from 'playwright-core'

const PDD_CHAT_URL = 'https://mms.pinduoduo.com/chat-merchant/index.html'

interface PageCrawler {
  updateServerTime?(value: number): void
  messagePack(): unknown
}

interface PddPageWindow extends Window {
  SERVER_DIFF_TIME?: number
  global_mall_id?: string | number
  global_uid?: string | number
  riskControlCrawler?: PageCrawler
  __YZ_PDD_HOOK_V1__?: {
    drain(): Array<Record<string, unknown>>
    rescan(): unknown
    status(): Record<string, unknown>
  }
}

interface PddVueRoot extends Element {
  __vue__?: {
    $store?: {
      state?: {
        riskControlCrawler?: PageCrawler
        IMSDK?: {
          riskControlCrawler?: PageCrawler
          sendCmdMsg?(payload: unknown): Promise<unknown>
        }
        userInfo?: { mall_id?: string | number; uid?: string | number }
      }
    }
  }
}

export interface PddChromeSendResult {
  ok: boolean
  status: number
  platformMessageId?: string
  previousMessageId?: string
  timestamp?: number
  code?: string
  message?: string
  method: string
  antiLength?: number
  pageTitle?: string
  pageUrl?: string
  responseBody?: unknown
  mallId?: string
}

export interface PddChromeTransport {
  prepare(): Promise<void>
  sendText(
    buyerId: string,
    text: string,
    isAut?: 0 | 1,
    previousMessageId?: string
  ): Promise<PddChromeSendResult>
  setFrameListener?(listener: (payloadData: string, opcode: number) => void): void
  setMessageListener?(listener: (message: Record<string, unknown>) => void): void
}

async function findProfileDirectory(): Promise<string> {
  const candidates = [
    process.env.PDD_CHROME_PROFILE,
    resolve(process.cwd(), '..', '_capture', 'chrome-profile'),
    resolve(process.cwd(), '_capture', 'chrome-profile')
  ].filter((item): item is string => Boolean(item))
  for (const path of candidates) {
    try {
      await access(path)
      return path
    } catch {
      // Try the next configured location.
    }
  }
  return candidates[0]
}

async function loadHookSource(): Promise<string> {
  const candidates = [
    resolve(process.cwd(), 'resources', 'injections', 'yz-pdd-hook.js'),
    resolve(process.resourcesPath, 'injections', 'yz-pdd-hook.js')
  ]
  for (const path of candidates) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new Error(`拼多多页面注入脚本缺失：${candidates.join('；')}`)
}

export class PddChromeBridge implements PddChromeTransport {
  private page?: Page
  private opening?: Promise<Page>
  private frameListener?: (payloadData: string, opcode: number) => void
  private messageListener?: (message: Record<string, unknown>) => void
  private receivedFrameCount = 0
  private hookPoller?: ReturnType<typeof setInterval>
  private hookPollBusy = false
  private lastHookStatus = ''

  setFrameListener(listener: (payloadData: string, opcode: number) => void): void {
    this.frameListener = listener
  }

  setMessageListener(listener: (message: Record<string, unknown>) => void): void {
    this.messageListener = listener
  }

  async prepare(): Promise<void> {
    try {
      await this.ensurePage()
    } catch (error) {
      await this.writeJsonLine('hook-debug.jsonl', {
        at: new Date().toISOString(),
        event: 'prepare-error',
        message: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async sendText(
    buyerId: string,
    text: string,
    isAut: 0 | 1 = 1,
    previousMessageId?: string
  ): Promise<PddChromeSendResult> {
    const page = await this.ensurePage()
    await page.waitForFunction(
      () => {
        const root = document.querySelector('#app') as PddVueRoot | null
        const pageWindow = window as PddPageWindow
        const state = root?.__vue__?.$store?.state || {}
        const crawler =
          pageWindow.riskControlCrawler ||
          state.riskControlCrawler ||
          state.IMSDK?.riskControlCrawler
        return Boolean(crawler && typeof crawler.messagePack === 'function')
      },
      undefined,
      { timeout: 60_000 }
    )
    const result = await page.evaluate(
      async ({ buyerId, text, isAut, previousMessageId, preferHttp }) => {
        const root = document.querySelector('#app') as PddVueRoot | null
        const pageWindow = window as PddPageWindow
        const store = root?.__vue__?.$store?.state || {}
        const im = store.IMSDK
        const crawler =
          pageWindow.riskControlCrawler || store.riskControlCrawler || im?.riskControlCrawler
        if (!crawler || typeof crawler.messagePack !== 'function') {
          throw new Error('真 Chrome 页面签名器尚未就绪。')
        }
        const now = (pageWindow.SERVER_DIFF_TIME || 0) + Date.now()
        if (typeof crawler.updateServerTime === 'function') crawler.updateServerTime(now)
        const anti = crawler.messagePack() || ''
        if (!anti) throw new Error('真 Chrome 页面未生成 anti-content。')

        const digest = async (value: string): Promise<string> => {
          const bytes = new TextEncoder().encode(value)
          const hash = await crypto.subtle.digest('SHA-256', bytes)
          return Array.from(new Uint8Array(hash))
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        }
        const randomHex = (): string => {
          if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '')
          return `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`
            .padEnd(32, '0')
            .slice(0, 32)
        }
        const summarize = (value: unknown): unknown => {
          try {
            return JSON.parse(JSON.stringify(value))
          } catch {
            return String(value)
          }
        }
        const asRecord = (value: unknown): Record<string, unknown> =>
          value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
        const sendSucceeded = (value: unknown): boolean => {
          const record = asRecord(value)
          if (record.error_code || record.errorCode || record.error_msg || record.errorMsg)
            return false
          const message = asRecord(record.message)
          return Boolean(
            record.result === 'ok' || record.success === true || record.msg_id || message.msg_id
          )
        }
        const messageIdOf = (value: unknown): string | undefined => {
          const record = asRecord(value)
          const message = asRecord(record.message)
          const nestedResult = asRecord(record.result)
          const id = record.msg_id || message.msg_id || nestedResult.msg_id
          return id == null ? undefined : String(id)
        }

        const imRequestId = Number(`${Date.now()}${Math.floor(Math.random() * 900 + 100)}`)
        const ts = Math.floor(Date.now() / 1000)
        const mallId = String(pageWindow.global_mall_id || store.userInfo?.mall_id || '')
        const imHash = await digest(`uid=${buyerId}&mall_id=${mallId}&request_id=${imRequestId}`)
        const imPayload = {
          cmd: 'send_message',
          anti_content: anti,
          request_id: imRequestId,
          message: {
            to: { role: 'user', uid: buyerId },
            from: { role: 'mall_cs' },
            ts,
            content: text,
            msg_id: Infinity,
            pre_msg_id: previousMessageId || undefined,
            type: 0,
            is_aut: isAut,
            manual_reply: isAut === 1 ? 0 : 1,
            status: 'read',
            is_read: 1,
            hash: imHash
          },
          random: randomHex()
        }
        let imResult: unknown
        let imError: string | undefined
        if (!preferHttp && typeof im?.sendCmdMsg === 'function') {
          try {
            imResult = await im.sendCmdMsg(imPayload)
          } catch (error) {
            imError = error instanceof Error ? error.message : String(error)
          }
          if (sendSucceeded(imResult)) {
            return {
              ok: true,
              status: 200,
              platformMessageId: messageIdOf(imResult),
              timestamp: ts,
              code: '200',
              method: 'chrome.page.IMSDK.sendCmdMsg',
              antiLength: String(anti).length,
              pageTitle: document.title,
              pageUrl: location.href,
              responseBody: summarize(imResult)
            }
          }
        }

        const requestId = Date.now()
        const body = {
          data: {
            cmd: 'send_message',
            anti_content: anti,
            request_id: requestId,
            message: {
              to: { role: 'user', uid: buyerId },
              from: { role: 'mall_cs' },
              ts,
              content: text,
              msg_id: null,
              pre_msg_id: previousMessageId || undefined,
              type: 0,
              is_aut: isAut,
              manual_reply: isAut === 1 ? 0 : 1,
              status: 'read',
              is_read: 1
            },
            random: Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
          },
          client: 'WEB',
          anti_content: anti
        }
        const response = await fetch('https://mms.pinduoduo.com/plateau/chat/send_message', {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'anti-content': String(anti)
          },
          body: JSON.stringify(body)
        })
        const data = await response.json().catch(() => null)
        const result = data?.result || {}
        const linked =
          !previousMessageId || String(result?.pre_msg_id || '') === String(previousMessageId)
        const platformMessageId = result?.msg_id == null ? undefined : String(result.msg_id)
        const ok =
          response.ok &&
          data?.success === true &&
          result?.result === 'ok' &&
          Boolean(platformMessageId)
        return {
          ok,
          status: response.status,
          platformMessageId,
          previousMessageId: result?.pre_msg_id == null ? undefined : String(result.pre_msg_id),
          timestamp: Number(result?.ts || ts),
          code: String(data?.error_code || result?.error_code || response.status),
          message:
            data?.error_msg ||
            data?.errorMsg ||
            data?.msg ||
            result?.error_msg ||
            (!platformMessageId
              ? '平台响应缺少 msg_id。'
              : !linked
                ? '平台返回的上一条消息 ID 与入站不同；已取得正式消息 ID，待买家端核验。'
                : undefined),
          method: !preferHttp && im ? 'chrome.page.IMSDK.sendCmdMsg+fetch' : 'chrome.page.fetch',
          antiLength: String(anti).length,
          pageTitle: document.title,
          pageUrl: location.href,
          responseBody: { imResult: summarize(imResult), imError, httpResult: data }
        }
      },
      {
        buyerId: String(buyerId),
        text: String(text),
        isAut,
        previousMessageId: previousMessageId ? String(previousMessageId) : undefined,
        preferHttp: process.env.PDD_SEND_TRANSPORT === 'fetch'
      }
    )
    await this.writeDiagnostic({
      at: new Date().toISOString(),
      buyerId: String(buyerId),
      text: String(text),
      isAut,
      result
    })
    return result
  }

  private async writeJsonLine(filename: string, entry: unknown): Promise<void> {
    try {
      const base = process.env.APPDATA || process.cwd()
      const file = resolve(base, 'Electron', 'pdd', filename)
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      // Diagnostics must never interrupt message delivery.
    }
  }

  private async writeDiagnostic(entry: unknown): Promise<void> {
    await this.writeJsonLine('send-debug.jsonl', entry)
  }

  private startHookPolling(page: Page): void {
    if (this.hookPoller) clearInterval(this.hookPoller)
    this.hookPoller = setInterval(() => {
      if (this.hookPollBusy || page.isClosed()) return
      this.hookPollBusy = true
      void page
        .evaluate(() => {
          const hook = (window as PddPageWindow).__YZ_PDD_HOOK_V1__
          if (!hook) return { status: null, messages: [] }
          hook.rescan()
          return { status: hook.status(), messages: hook.drain() }
        })
        .then(({ status, messages }) => {
          const encodedStatus = JSON.stringify(status || {})
          if (encodedStatus !== this.lastHookStatus) {
            this.lastHookStatus = encodedStatus
            void this.writeJsonLine('hook-debug.jsonl', {
              at: new Date().toISOString(),
              event: 'hook-status',
              status
            })
          }
          for (const message of messages || []) {
            const from =
              message.from && typeof message.from === 'object'
                ? (message.from as Record<string, unknown>)
                : {}
            const to =
              message.to && typeof message.to === 'object'
                ? (message.to as Record<string, unknown>)
                : {}
            void this.writeJsonLine('incoming-debug.jsonl', {
              at: new Date().toISOString(),
              msg_id: message.msg_id,
              client_msg_id: message.client_msg_id,
              pre_msg_id: message.pre_msg_id,
              ts: message.ts,
              type: message.type,
              content: message.content,
              from,
              to,
              nickname: message.nickname
            })
            this.messageListener?.(message)
          }
        })
        .catch(() => {})
        .finally(() => {
          this.hookPollBusy = false
        })
    }, 250)
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page
    this.opening ??= this.openChromePage().finally(() => {
      this.opening = undefined
    })
    return this.opening
  }

  private async openChromePage(): Promise<Page> {
    await this.writeJsonLine('hook-debug.jsonl', {
      at: new Date().toISOString(),
      event: 'open-start'
    })
    const { chromium } = await import('playwright-core')
    const profileDirectory = await findProfileDirectory()
    const hookSource = await loadHookSource()
    const context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chrome',
      headless: false,
      viewport: null,
      args: ['--start-maximized']
    })
    await this.writeJsonLine('hook-debug.jsonl', {
      at: new Date().toISOString(),
      event: 'context-launched',
      profileDirectory
    })
    await context.addInitScript({ content: hookSource })
    await this.writeJsonLine('hook-debug.jsonl', {
      at: new Date().toISOString(),
      event: 'init-script-installed'
    })
    context.once('close', () => {
      this.page = undefined
      if (this.hookPoller) clearInterval(this.hookPoller)
      this.hookPoller = undefined
    })
    const page =
      context.pages().find((candidate) => candidate.url().startsWith(PDD_CHAT_URL)) ||
      context.pages()[0] ||
      (await context.newPage())
    page.on('websocket', (socket) => {
      void this.writeDiagnostic({
        at: new Date().toISOString(),
        event: 'websocket-open',
        url: (() => {
          try {
            const value = new URL(socket.url())
            return `${value.origin}${value.pathname}`
          } catch {
            return 'websocket'
          }
        })()
      })
      socket.on('framereceived', ({ payload }) => {
        this.receivedFrameCount += 1
        if (this.receivedFrameCount <= 5 || this.receivedFrameCount % 100 === 0) {
          void this.writeDiagnostic({
            at: new Date().toISOString(),
            event: 'websocket-frame',
            count: this.receivedFrameCount,
            kind: typeof payload === 'string' ? 'text' : 'binary',
            length: typeof payload === 'string' ? payload.length : payload.byteLength
          })
        }
        if (typeof payload === 'string') {
          this.frameListener?.(payload, 1)
          return
        }
        this.frameListener?.(payload.toString('base64'), 2)
      })
    })
    if (!page.url().startsWith(PDD_CHAT_URL)) {
      await page.goto(PDD_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    }
    await this.writeJsonLine('hook-debug.jsonl', {
      at: new Date().toISOString(),
      event: 'chat-page-loaded',
      pageTitle: await page.title()
    })
    await page.waitForFunction(
      () => Boolean((window as PddPageWindow).__YZ_PDD_HOOK_V1__),
      undefined,
      { timeout: 30_000 }
    )
    this.startHookPolling(page)
    await this.writeJsonLine('hook-debug.jsonl', {
      at: new Date().toISOString(),
      event: 'hook-polling-started'
    })
    this.page = page
    return page
  }
}
