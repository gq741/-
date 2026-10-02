import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface DouyinRecoverySnapshot {
  autoReplyEnabled: boolean
  lastOnlineAt: number
}

export class DouyinRecoveryState {
  private loaded = false
  private loading?: Promise<void>
  private writing: Promise<void> = Promise.resolve()
  private value: DouyinRecoverySnapshot = { autoReplyEnabled: false, lastOnlineAt: 0 }

  constructor(private readonly filePath: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loading ??= (async () => {
      try {
        const parsed = JSON.parse(
          await readFile(this.filePath, 'utf8')
        ) as Partial<DouyinRecoverySnapshot>
        this.value = {
          autoReplyEnabled: parsed.autoReplyEnabled === true,
          lastOnlineAt: Number.isFinite(parsed.lastOnlineAt) ? Number(parsed.lastOnlineAt) : 0
        }
      } catch {
        // A new profile starts with automatic replies off and no recovery watermark.
      }
      this.loaded = true
    })()
    await this.loading
  }

  async snapshot(): Promise<DouyinRecoverySnapshot> {
    await this.load()
    return { ...this.value }
  }

  async update(patch: Partial<DouyinRecoverySnapshot>): Promise<void> {
    await this.load()
    this.value = { ...this.value, ...patch }
    const content = JSON.stringify(this.value, null, 2)
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, content, 'utf8')
    })
    await this.writing
  }
}
