import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { PddChromeSendResult } from './pddChromeBridge'
import { createPddGuestSendScript, parsePddGuestSendResult } from './pddGuestSender'

async function runPageSend(responseResult: Record<string, unknown>): Promise<{
  result: PddChromeSendResult
  sentBody?: Record<string, unknown>
}> {
  let sentBody: Record<string, unknown> | undefined
  const script = createPddGuestSendScript({
    buyerId: 'buyer-1',
    text: '仓库会尽快安排发出。',
    previousMessageId: 'in-1'
  })
  const raw = await runInNewContext(script, {
    window: { global_mall_id: 'mall-1', riskControlCrawler: { messagePack: () => 'anti-test' } },
    document: { querySelector: () => ({ __vue__: { $store: { state: {} } } }) },
    location: { hostname: 'mms.pinduoduo.com' },
    crypto: webcrypto,
    TextEncoder,
    Date,
    fetch: async (_url: string, options: { body: string }) => {
      sentBody = JSON.parse(options.body) as Record<string, unknown>
      return { ok: true, status: 200, json: async () => responseResult }
    }
  })
  return { result: parsePddGuestSendResult(raw), sentBody }
}

describe('同一拼多多客服页的自动回复发送', () => {
  it('构造自动回复标记、文本 hash，并把平台回执仅记为接受', async () => {
    const { result, sentBody } = await runPageSend({
      success: true,
      result: { result: 'ok', msg_id: 'out-1', pre_msg_id: 'in-1' }
    })
    const data = sentBody?.data as Record<string, unknown>
    const message = data.message as Record<string, unknown>
    expect(message).toMatchObject({
      content: '仓库会尽快安排发出。',
      is_aut: 1,
      manual_reply: 0,
      pre_msg_id: 'in-1'
    })
    expect(message.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(data.anti_content).toBe('anti-test')
    expect(result).toMatchObject({
      ok: true,
      platformMessageId: 'out-1',
      method: 'electron.guest.page.fetch'
    })
  })

  it('缺少 msg_id 判失败，前序消息 ID 差异保留告警但仍接受正式回执', async () => {
    const missing = await runPageSend({ success: true, result: { result: 'ok' } })
    expect(missing.result.ok).toBe(false)
    expect(missing.result.message).toContain('msg_id')

    const mismatched = await runPageSend({
      success: true,
      result: { result: 'ok', msg_id: 'out-2', pre_msg_id: 'another-inbound' }
    })
    expect(mismatched.result.ok).toBe(true)
    expect(mismatched.result.platformMessageId).toBe('out-2')
    expect(mismatched.result.previousMessageId).toBe('another-inbound')
    expect(mismatched.result.message).toContain('上一条消息')
  })
})
