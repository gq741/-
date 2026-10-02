import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DouyinRecoveryState } from './douyinRecoveryState'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('DouyinRecoveryState', () => {
  it('persists reply mode and recovery watermark across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-recovery-'))
    directories.push(directory)
    const file = join(directory, 'recovery-state.json')
    const first = new DouyinRecoveryState(file)
    expect(await first.snapshot()).toEqual({ autoReplyEnabled: false, lastOnlineAt: 0 })
    await first.update({ autoReplyEnabled: true, lastOnlineAt: 1234567890 })
    expect(await new DouyinRecoveryState(file).snapshot()).toEqual({
      autoReplyEnabled: true,
      lastOnlineAt: 1234567890
    })
  })
})
