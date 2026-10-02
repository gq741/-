import { describe, expect, it } from 'vitest'
import { normalizeDouyinMessage, shouldQueueDouyinReply } from './douyinMessage'

describe('normalizeDouyinMessage', () => {
  it('reads the measured Feige buyer text fields', () => {
    const message = normalizeDouyinMessage(
      {
        buyerId: 'BUYER',
        conversationId: 'CONVERSATION',
        message: {
          serverId: 'SERVER_ID',
          content: '  什么时候发货  ',
          createTime: 1_780_000_000_000,
          ext: { sender_role: '1', type: 'text' }
        }
      },
      'shop-1'
    )
    expect(message).toMatchObject({
      id: 'dy-shop-1-SERVER_ID',
      platformId: 'douyin-feige',
      conversationId: 'dy:CONVERSATION',
      buyerId: 'BUYER',
      direction: 'in',
      contentType: 'text',
      text: '什么时候发货',
      platformMessageId: 'SERVER_ID'
    })
  })

  it('classifies merchant echo and ignores system messages and local placeholders', () => {
    const input = { buyerId: 'BUYER', conversationId: 'CONVERSATION' }
    expect(
      normalizeDouyinMessage(
        {
          ...input,
          message: {
            serverId: 'OUT',
            content: '已收到',
            ext: { sender_role: '2', type: 'text' }
          }
        },
        'shop-1'
      )?.direction
    ).toBe('out')
    expect(
      normalizeDouyinMessage(
        {
          ...input,
          message: {
            serverId: 'SYSTEM',
            ext: { sender_role: '3', type: 'text' }
          }
        },
        'shop-1'
      )
    ).toBeUndefined()
    expect(
      normalizeDouyinMessage(
        {
          ...input,
          message: {
            clientId: 'LOCAL',
            ext: { sender_role: '1', type: 'text' }
          }
        },
        'shop-1'
      )
    ).toBeUndefined()
  })

  it('replies only to recoverable text without a later merchant answer', () => {
    const input = {
      buyerId: 'BUYER',
      conversationId: 'CONV',
      message: {
        serverId: 'IN',
        content: '断线期间问题',
        createTime: 1_780_000_000_000,
        ext: { sender_role: '1', type: 'text' }
      }
    }
    const message = normalizeDouyinMessage(input, 'shop-1')!
    expect(shouldQueueDouyinReply(message, 'history', true, message.occurredAt - 1000, 0)).toBe(
      true
    )
    expect(shouldQueueDouyinReply(message, 'history', true, message.occurredAt + 1, 0)).toBe(false)
    expect(shouldQueueDouyinReply(message, 'history', false, 0, 0)).toBe(false)
    expect(shouldQueueDouyinReply(message, 'history', true, 0, message.occurredAt + 1)).toBe(false)
  })
})

describe('Douyin template cards', () => {
  it('classifies product and order template cards without treating either as buyer text', () => {
    const base = { buyerId: 'BUYER', conversationId: 'CONVERSATION' }
    const goods = normalizeDouyinMessage(
      {
        ...base,
        message: {
          serverId: 'GOODS',
          content: '[商品]',
          ext: {
            sender_role: '1',
            type: 'template_card',
            goods_id: 'PRODUCT_ID',
            card_header: JSON.stringify({ cardSourceScene: 'goods_card_v2' }),
            static_data: JSON.stringify({
              sale_goods: [{ product_name: '测试商品', sku: '蓝色 M' }]
            })
          }
        }
      },
      'shop-1'
    )!
    expect(goods).toMatchObject({
      contentType: 'goods_card',
      goodsId: 'PRODUCT_ID',
      goodsTitle: '测试商品',
      skuText: '蓝色 M'
    })
    expect(shouldQueueDouyinReply(goods, 'live', true, 0, 0)).toBe(false)

    const order = normalizeDouyinMessage(
      {
        ...base,
        message: {
          serverId: 'ORDER',
          content: '[订单卡片]',
          ext: {
            sender_role: '1',
            type: 'template_card',
            order_id: 'ORDER_ID',
            card_header: JSON.stringify({ cardSourceScene: 'order_card' }),
            static_data: JSON.stringify({ order_status: '已取消', product_name: '测试商品' })
          }
        }
      },
      'shop-1'
    )!
    expect(order).toMatchObject({
      contentType: 'order_card',
      orderId: 'ORDER_ID',
      goodsTitle: '测试商品',
      rawOrderStatus: '已取消'
    })
    expect(shouldQueueDouyinReply(order, 'live', true, 0, 0)).toBe(false)
  })

  it('keeps unknown template cards as system messages', () => {
    const message = normalizeDouyinMessage(
      {
        buyerId: 'BUYER',
        conversationId: 'CONVERSATION',
        message: {
          serverId: 'OTHER',
          ext: { sender_role: '1', type: 'template_card' }
        }
      },
      'shop-1'
    )
    expect(message?.contentType).toBe('system')
  })
})
