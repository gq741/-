import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import type { DouyinRuntimeState } from '@shared/contracts'
import { DouyinAdapter } from './douyinAdapter'
import { DouyinRecoveryState } from './douyinRecoveryState'
import { PddStateStore } from './pddStateStore'
import { MockPlatformAdapter } from './mockAdapter'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('DouyinAdapter recovery', () => {
  it('waits for history and cancels an unanswered buyer batch when a later merchant reply appears', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-adapter-'))
    directories.push(directory)
    const stateStore = new PddStateStore(join(directory, 'runtime-state.json'))
    const recoveryState = new DouyinRecoveryState(join(directory, 'recovery-state.json'))
    const mock = new MockPlatformAdapter()
    const adapter = new DouyinAdapter({
      profileId: 'shop-1',
      stateStore,
      recoveryState,
      getRules: () => {
        const snapshot = mock.getSnapshot()
        return {
          intents: snapshot.intents,
          bannedWords: snapshot.bannedWords,
          settings: snapshot.settings
        }
      },
      onMessage() {
        /* observe through persisted state */
      },
      onTrace() {
        /* no send is expected */
      }
    })
    const at = Date.now()
    const buyer = {
      kind: 'message',
      source: 'history',
      buyerId: 'BUYER',
      conversationId: 'CONV',
      message: {
        serverId: 'IN',
        content: '断线期间问题',
        createTime: at,
        ext: { sender_role: '1', type: 'text' }
      }
    }
    const merchant = {
      kind: 'message',
      source: 'history',
      buyerId: 'BUYER',
      conversationId: 'CONV',
      message: {
        serverId: 'OUT',
        content: '人工已经回答',
        createTime: at + 500,
        ext: { sender_role: '2', type: 'text' }
      }
    }
    const results = [
      { ready: true, historyPending: 1, events: [buyer] },
      { ready: true, historyPending: 0, events: [merchant] }
    ]
    const frame = { frames: [], executeJavaScript: async () => results.shift() }
    const guest = {
      mainFrame: frame,
      getURL: () => 'https://im.jinritemai.com/pc_seller_v2/main/workspace',
      isDestroyed: () => false
    } as unknown as WebContents
    const state: DouyinRuntimeState = {
      ...(await adapter.getState()),
      mode: 'online',
      autoReplyEnabled: true
    }
    Object.assign(adapter, { guest, runtime: state, recoveryCutoff: at - 1000 })
    const poll = (adapter as unknown as { poll(): Promise<void> }).poll.bind(adapter)
    await poll()
    expect((await stateStore.snapshot()).processedMessageIds).toHaveLength(0)
    await poll()
    const stored = await stateStore.snapshot()
    expect(stored.processedMessageIds).toHaveLength(1)
    expect(stored.receipts).toHaveLength(0)
  })
})
