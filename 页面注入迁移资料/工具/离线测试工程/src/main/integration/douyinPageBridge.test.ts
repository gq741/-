import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { DOUYIN_BRIDGE_SCRIPT, douyinSendScript } from './douyinPageBridge'

describe('Douyin page bridge', () => {
  it('retries a message when the buyer conversation metadata arrives after the callback', () => {
    const callbacks: Array<(message: unknown) => void> = []
    const conversationMap: Record<string, unknown> = {}
    const im = {
      onMessage(callback: (message: unknown) => void) {
        callbacks.push(callback)
      },
      onMessageChange() {
        return undefined
      }
    }
    const window = {
      __monaGlobalStore: {
        data: {
          initContextData: {
            im,
            Store: {
              instance: {
                conversationsInfo: { conversationMap, messagesByConversationId: {} }
              }
            }
          }
        }
      }
    }
    const context = {
      window,
      document: { body: { innerText: '' } },
      Date,
      Set,
      Map,
      Object,
      String,
      Number,
      Array
    }
    runInNewContext(DOUYIN_BRIDGE_SCRIPT, context)
    const incoming = {
      serverId: 'LATE-BUYER',
      securityConversationId: 'CONV-B',
      content: '有优惠吗',
      ext: { sender_role: '1', type: 'text' }
    }
    callbacks[0](incoming)
    conversationMap['CONV-B'] = { id: 'CONV-B', buyerId: 'BUYER-B', lastMessage: incoming }
    const result = runInNewContext(DOUYIN_BRIDGE_SCRIPT, context) as {
      events: Array<{ buyerId: string; message: { serverId: string } }>
    }
    expect(result.events).toMatchObject([
      { buyerId: 'BUYER-B', message: { serverId: 'LATE-BUYER' } }
    ])
  })

  it('deduplicates callbacks and blocks a pending automatic send after a manual reply', async () => {
    const callbacks: Array<(message: unknown) => void> = []
    const sendCalls: string[] = []
    const conversation = { id: 'CONV', buyerId: 'BUYER' }
    const im = {
      onMessage(callback: (message: unknown) => void) {
        callbacks.push(callback)
      },
      onMessageChange(callback: (message: unknown) => void) {
        callbacks.push(callback)
      },
      async chatWithUid() {
        /* current conversation already selected */
      },
      async sendText(_conversationId: string, text: string) {
        sendCalls.push(text)
        return {
          serverId: 'OUT',
          flightStatus: 3,
          serverStatus: 0,
          ext: { 's:send_response_status': '0', 's:send_response_check_code': '0' }
        }
      }
    }
    const window = {
      __monaGlobalStore: {
        data: {
          initContextData: {
            im,
            Store: {
              instance: {
                conversationsInfo: {
                  currentConversation: conversation,
                  conversationMap: { CONV: conversation },
                  messagesByConversationId: {}
                }
              }
            }
          }
        }
      }
    } as Record<string, unknown>
    const context = {
      window,
      document: { body: { innerText: '' } },
      Date,
      Set,
      Map,
      Object,
      String,
      Number,
      Array
    }
    expect(runInNewContext(DOUYIN_BRIDGE_SCRIPT, context)).toMatchObject({
      ready: true,
      events: []
    })
    const incoming = {
      serverId: 'IN',
      securityConversationId: 'CONV',
      content: '你好',
      ext: { sender_role: '1', type: 'text' }
    }
    callbacks.forEach((callback) => callback(incoming))
    const polled = runInNewContext(DOUYIN_BRIDGE_SCRIPT, context) as { events: unknown[] }
    expect(polled.events).toHaveLength(1)
    const accepted = await runInNewContext(
      douyinSendScript('BUYER', '自动回复', Date.now()),
      context
    )
    expect(accepted).toMatchObject({ ok: true, platformMessageId: 'OUT' })
    const receivedAt = Date.now() - 1000
    await im.sendText('CONV', '人工回复')
    const result = await runInNewContext(
      douyinSendScript('BUYER', '第二条自动回复', receivedAt),
      context
    )
    expect(result).toMatchObject({ ok: false, message: '人工已回复，已取消自动发送' })
    expect(sendCalls).toEqual(['自动回复', '人工回复'])
  })

  it('reads the Feige store message container map on refresh', () => {
    const conversation = { id: 'CONV', buyerId: 'BUYER' }
    const message = {
      serverId: 'HISTORY',
      securityConversationId: 'CONV',
      content: '补偿消息',
      ext: { sender_role: '1', type: 'text' }
    }
    const window = {
      __monaGlobalStore: {
        data: {
          initContextData: {
            im: {
              onMessage() {
                return undefined
              },
              onMessageChange() {
                return undefined
              }
            },
            Store: {
              instance: {
                conversationsInfo: {
                  currentConversation: conversation,
                  conversationMap: new Map([['CONV', conversation]]),
                  messagesByConversationId: new Map([
                    ['CONV', { map: new Map([['HISTORY', message]]) }]
                  ])
                }
              }
            }
          }
        }
      }
    }
    const result = runInNewContext(DOUYIN_BRIDGE_SCRIPT, {
      window,
      document: { body: { innerText: '' } },
      Date,
      Set,
      Map,
      Object,
      String,
      Number,
      Array
    }) as { events: unknown[] }
    expect(result.events).toHaveLength(1)
  })

  it('reports an expired login instead of a ready IM bridge', () => {
    const result = runInNewContext(DOUYIN_BRIDGE_SCRIPT, {
      window: {},
      document: { body: { innerText: '登录过期，请重新登录' } }
    })
    expect(result).toMatchObject({ ready: false, reason: 'login_expired' })
  })

  it('pulls unread conversation history and drains recovered messages once', async () => {
    const conversation = {
      id: 'CONV',
      buyerId: 'BUYER',
      unreadCount: 1,
      lastMessage: {
        serverId: 'LAST',
        securityConversationId: 'CONV',
        content: '后发消息',
        createTime: Date.now(),
        ext: { sender_role: '1', type: 'text' }
      }
    }
    const older = {
      serverId: 'OLDER',
      securityConversationId: 'CONV',
      content: '断线期间消息',
      createTime: Date.now() - 1000,
      ext: { sender_role: '1', type: 'text' }
    }
    const im = {
      onMessage() {
        return undefined
      },
      onMessageChange() {
        return undefined
      },
      getMessagesByConversation() {
        return Promise.resolve([older])
      }
    }
    const window = {
      __monaGlobalStore: {
        data: {
          initContextData: {
            im,
            Store: {
              instance: {
                conversationsInfo: {
                  currentConversation: conversation,
                  conversationMap: new Map([['CONV', conversation]]),
                  messagesByConversationId: new Map()
                }
              }
            }
          }
        }
      }
    }
    const context = {
      window,
      document: { body: { innerText: '' } },
      Date,
      Set,
      Map,
      Object,
      String,
      Number,
      Array,
      Promise
    }
    const first = runInNewContext(DOUYIN_BRIDGE_SCRIPT, context) as {
      historyPending: number
      events: unknown[]
    }
    expect(first.historyPending).toBe(1)
    expect(first.events).toHaveLength(1)
    await Promise.resolve()
    await Promise.resolve()
    const second = runInNewContext(DOUYIN_BRIDGE_SCRIPT, context) as {
      events: Array<{ message: { serverId: string } }>
    }
    expect(second.events.map((event) => event.message.serverId)).toEqual(['OLDER'])
    const third = runInNewContext(DOUYIN_BRIDGE_SCRIPT, context) as { events: unknown[] }
    expect(third.events).toHaveLength(0)
  })
  it('keeps template card fields needed for product and order classification', () => {
    const message = {
      serverId: 'CARD',
      securityConversationId: 'CONV',
      content: '[商品]',
      ext: {
        sender_role: '1',
        type: 'template_card',
        goods_id: 'GOODS',
        order_id: 'ORDER',
        card_header: '{"cardSourceScene":"goods_card_v2"}',
        static_data: '{"sale_goods":[]}'
      }
    }
    const conversation = { id: 'CONV', buyerId: 'BUYER', lastMessage: message }
    const window = {
      __monaGlobalStore: {
        data: {
          initContextData: {
            im: {},
            Store: {
              instance: {
                conversationsInfo: {
                  conversationMap: { CONV: conversation },
                  messagesByConversationId: {}
                }
              }
            }
          }
        }
      }
    }
    const result = runInNewContext(DOUYIN_BRIDGE_SCRIPT, {
      window,
      document: { body: { innerText: '' } },
      Date,
      Set,
      Map,
      Object,
      String,
      Number,
      Array
    }) as { events: Array<{ message: { ext: Record<string, unknown> } }> }
    expect(result.events[0].message.ext).toMatchObject({
      goods_id: 'GOODS',
      order_id: 'ORDER',
      card_header: '{"cardSourceScene":"goods_card_v2"}',
      static_data: '{"sale_goods":[]}'
    })
  })
})
