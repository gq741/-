import { MockPlatformAdapter } from './mockAdapter'
import { PddAdapter } from './pddAdapter'
import { DouyinAdapter } from './douyinAdapter'
import { DouyinRecoveryState } from './douyinRecoveryState'
import { PddStateStore } from './pddStateStore'
import { usePddGuestSession } from './flags'
import { QianniuAdapter, QnpyTransport } from './qianniuAdapter'

export const mockAdapter = new MockPlatformAdapter()

let livePddAdapter: PddAdapter | undefined
let liveDouyinAdapter: DouyinAdapter | undefined
let liveQianniuAdapter: QianniuAdapter | undefined

export function initializeQianniuAdapter(stateFile: string): QianniuAdapter {
  liveQianniuAdapter ??= new QianniuAdapter(stateFile, new QnpyTransport(), () => {
    return mockAdapter.getRules('qianniu')
  })
  return liveQianniuAdapter
}

export function getQianniuAdapter(): QianniuAdapter {
  if (!liveQianniuAdapter) throw new Error('千牛运行模块尚未初始化。')
  return liveQianniuAdapter
}

export function initializeDouyinAdapter(stateFile: string): DouyinAdapter {
  if (liveDouyinAdapter) return liveDouyinAdapter
  liveDouyinAdapter = new DouyinAdapter({
    profileId: 'douyin-store-default',
    stateStore: new PddStateStore(stateFile),
    recoveryState: new DouyinRecoveryState(
      stateFile.replace(/runtime-state\.json$/, 'recovery-state.json')
    ),
    getRules: () => {
      return mockAdapter.getRules('douyin-feige')
    },
    onMessage: (message) => mockAdapter.ingestLiveMessage(message),
    onTrace: (trace) => mockAdapter.ingestLiveTrace(trace)
  })
  return liveDouyinAdapter
}

export function getDouyinAdapter(): DouyinAdapter {
  if (!liveDouyinAdapter) throw new Error('抖音运行模块尚未初始化。')
  return liveDouyinAdapter
}

export function initializePddAdapter(stateFile: string): PddAdapter {
  if (livePddAdapter) return livePddAdapter
  livePddAdapter = new PddAdapter({
    profileId: 'pdd-store-default',
    stateStore: new PddStateStore(stateFile),
    getRules: () => {
      return mockAdapter.getRules('pdd-web')
    },
    onMessage: (message) => mockAdapter.ingestLiveMessage(message),
    onTrace: (trace) => mockAdapter.ingestLiveTrace(trace)
  })
  if (!usePddGuestSession()) {
    void livePddAdapter.prepareChrome().catch(() => {})
  }
  return livePddAdapter
}

export function getPddAdapter(): PddAdapter {
  if (!livePddAdapter) throw new Error('拼多多运行模块尚未初始化。')
  return livePddAdapter
}
