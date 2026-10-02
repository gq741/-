import type {
  BannedWord,
  GeneralSettings,
  Intent,
  SimulateResult,
  WorkspaceSnapshot
} from '@shared/contracts'

export interface PlatformAdapter {
  getSnapshot(): WorkspaceSnapshot
  simulateMessage(): SimulateResult
  saveIntent(intent: Intent): WorkspaceSnapshot
  deleteIntent(id: string): WorkspaceSnapshot
  saveBannedWord(item: BannedWord): WorkspaceSnapshot
  deleteBannedWord(id: string): WorkspaceSnapshot
  saveSettings(settings: GeneralSettings): WorkspaceSnapshot
}
