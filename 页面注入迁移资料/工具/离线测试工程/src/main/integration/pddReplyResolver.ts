import type { BannedWord, GeneralSettings, Intent } from '@shared/contracts'

export interface FixedReplyDecision {
  reply: string
  source: 'intent' | 'fallback'
  intentId?: string
  intentName?: string
}

function replaceBannedWords(text: string, bannedWords: BannedWord[]): string {
  return bannedWords
    .filter((item) => item.enabled && item.word)
    .reduce((reply, item) => reply.split(item.word).join(item.replacement), text)
}

export function resolveFixedReply(
  text: string,
  intents: Intent[],
  bannedWords: BannedWord[],
  settings: GeneralSettings
): FixedReplyDecision | undefined {
  const normalized = text.trim().toLocaleLowerCase('zh-CN')
  if (!normalized || !settings.aiEnabledGlobal) return undefined

  const intent = intents
    .filter((item) => item.enabled && item.reply.trim())
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .find((item) =>
      item.keywords.some((keyword) =>
        normalized.includes(keyword.trim().toLocaleLowerCase('zh-CN'))
      )
    )
  if (intent) {
    return {
      reply: replaceBannedWords(intent.reply.trim(), bannedWords),
      source: 'intent',
      intentId: intent.id,
      intentName: intent.name
    }
  }

  const fallback = settings.fallbackReplies.find((item) => item.trim())
  if (!fallback) return undefined
  return {
    reply: replaceBannedWords(fallback.trim(), bannedWords),
    source: 'fallback'
  }
}
