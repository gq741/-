import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PddStateStore } from './pddStateStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('拼多多运行状态持久化', () => {
  it('以 msg_id 原子认领，并跨实例保持去重结果', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdd-state-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'runtime-state.json')
    const first = new PddStateStore(path)

    expect(await Promise.all([first.claimMessage('msg-1'), first.claimMessage('msg-1')])).toEqual([
      true,
      false
    ])
    expect(await new PddStateStore(path).claimMessage('msg-1')).toBe(false)
  })

  it('保存自动回复开关并在重启后恢复', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdd-state-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'runtime-state.json')
    const first = new PddStateStore(path)
    expect(await first.autoReplySetting()).toBeUndefined()
    await first.setAutoReplyEnabled(true)
    expect(await new PddStateStore(path).autoReplySetting()).toBe(true)
    await first.setAutoReplyEnabled(false)
    expect(await new PddStateStore(path).autoReplySetting()).toBe(false)
  })

  it('保存发送回执与人工暂停状态', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdd-state-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'runtime-state.json')
    const store = new PddStateStore(path)

    await store.addReceipt({
      inboundMessageId: 'in-1',
      requestId: 'req-1',
      buyerId: 'buyer-1',
      ok: true,
      capturedAt: 100,
      durationMs: 50,
      platformMessageId: 'out-1'
    })
    await store.pauseConversation('pdd:buyer-1')
    const snapshot = await store.snapshot()

    expect(snapshot.receipts[0].platformMessageId).toBe('out-1')
    expect(await store.isOwnedOutgoingMessage('out-1')).toBe(true)
    expect(await store.isOwnedOutgoingMessage('human-out-1')).toBe(false)
    expect(await store.markMerchantEcho('out-1')).toBe(true)
    expect(await store.confirmBuyerReceipt('out-1')).toBe(true)
    expect(await store.confirmBuyerReceipt('human-out-1')).toBe(false)
    const reloaded = await new PddStateStore(path).snapshot()
    expect(reloaded.receipts[0].merchantEchoAt).toBeTypeOf('number')
    expect(reloaded.receipts[0].buyerConfirmedAt).toBeTypeOf('number')
    expect(snapshot.pausedConversations).toEqual(['pdd:buyer-1'])
    expect(JSON.parse(await readFile(path, 'utf8')).receipts).toHaveLength(1)

    await store.resumeAllConversations()
    expect((await store.snapshot()).pausedConversations).toEqual([])
  })

  it('平台消息 ID 已返回但初始判定不确定时，商家回显与买家确认可校正回执', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pdd-state-'))
    temporaryDirectories.push(directory)
    const store = new PddStateStore(join(directory, 'runtime-state.json'))
    await store.addReceipt({
      inboundMessageId: 'in-uncertain',
      requestId: 'req-uncertain',
      buyerId: 'buyer-1',
      ok: false,
      capturedAt: 100,
      durationMs: 50,
      platformMessageId: 'out-uncertain'
    })
    expect(await store.isOwnedOutgoingMessage('out-uncertain')).toBe(true)
    expect(await store.markMerchantEcho('out-uncertain')).toBe(true)
    expect((await store.snapshot()).receipts[0]).toMatchObject({ ok: true })
    expect(await store.confirmBuyerReceipt('out-uncertain')).toBe(true)
    expect((await store.snapshot()).receipts[0].buyerConfirmedAt).toBeTypeOf('number')
  })
})
