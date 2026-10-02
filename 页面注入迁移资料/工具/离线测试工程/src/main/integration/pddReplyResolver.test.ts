import { describe, expect, it } from 'vitest'
import type { GeneralSettings, Intent } from '@shared/contracts'
import { resolveFixedReply } from './pddReplyResolver'

const settings: GeneralSettings = {
  aiEnabledGlobal: true,
  replyStyle: 'concise',
  welcomeEnabled: true,
  welcomeText: '您好',
  fallbackReplies: ['正在为您核对，请稍候。'],
  llm: { provider: 'deepseek', model: 'deepseek-chat', configured: false },
  jev: { provider: 'typesafe', model: 'jev-latest', configured: false }
}

const intents: Intent[] = [
  {
    id: 'ship',
    name: '催发货',
    category: '履约',
    orderStatus: '已下单',
    scope: '通用问题',
    keywords: ['什么时候发货'],
    reply: '仓库绝对会尽快发出。',
    enabled: true,
    priority: 80,
    createdAt: 1,
    updatedAt: 1
  }
]

describe('拼多多固定回复决策', () => {
  it('按关键词选择意图并替换禁用词', () => {
    expect(
      resolveFixedReply(
        '请问什么时候发货呀',
        intents,
        [{ id: '1', word: '绝对', replacement: '通常', enabled: true, createdAt: 1 }],
        settings
      )
    ).toMatchObject({ source: 'intent', intentId: 'ship', reply: '仓库通常会尽快发出。' })
  })

  it('未命中时使用固定兜底话术', () => {
    expect(resolveFixedReply('这个材质怎么样', intents, [], settings)).toMatchObject({
      source: 'fallback',
      reply: '正在为您核对，请稍候。'
    })
  })
})
