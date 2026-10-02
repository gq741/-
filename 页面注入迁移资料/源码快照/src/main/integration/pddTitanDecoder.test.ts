import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeTitanPayload, extractPddCandidates, normalizePddCandidate } from './pddTitanDecoder'

describe('拼多多 Titan 帧解析', () => {
  it('从带二进制前缀的 gzip 帧提取真实文本消息', () => {
    const payload = {
      push_type: 2,
      seq_id: 6,
      data: [
        {
          message: {
            ts: '1789977592',
            content: '什么时候发货？',
            client_msg_id: 'CLIENT-1',
            type: 0,
            from: { role: 'user', uid: 'buyer-1' },
            to: { role: 'mall_cs', uid: 'mall-1' },
            msg_id: '1789977592039',
            pre_msg_id: '1789977579330',
            nickname: '买家A'
          }
        }
      ]
    }
    const frame = Buffer.concat([
      Buffer.from([0, 10, 0, 102]),
      gzipSync(JSON.stringify(payload)),
      Buffer.from([0, 0, 1, 7])
    ])
    const decoded = decodeTitanPayload(frame.toString('base64'), 2)
    const candidates = decoded.flatMap(extractPddCandidates)
    const message = normalizePddCandidate(candidates[0], 'profile-1', 1789977592385)

    expect(message).toMatchObject({
      platformMessageId: '1789977592039',
      conversationId: 'pdd:buyer-1',
      buyerId: 'buyer-1',
      direction: 'in',
      contentType: 'text',
      text: '什么时候发货？',
      platformSequence: 6
    })
  })

  it('区分商家出站消息和商品链接', () => {
    const outgoing = extractPddCandidates({
      seq_id: 7,
      message: {
        msg_id: 'out-1',
        ts: 1789977593,
        type: 0,
        content: '已为您处理',
        from: { role: 'mall_cs' },
        to: { role: 'user', uid: 'buyer-1' }
      }
    })[0]
    const goods = extractPddCandidates({
      message: {
        msg_id: 'goods-1',
        ts: 1789977594,
        type: 0,
        content: 'https://mobile.yangkeduo.com/goods.html?goods_id=1',
        from: { role: 'user', uid: 'buyer-1' },
        to: { role: 'mall_cs' }
      }
    })[0]

    expect(normalizePddCandidate(outgoing, 'profile-1')?.direction).toBe('out')
    expect(normalizePddCandidate(goods, 'profile-1')).toMatchObject({
      contentType: 'goods_link',
      goodsId: '1'
    })
  })

  it('从采样商品链接提取商品 ID，不把跟踪参数并入 ID', () => {
    const goods = extractPddCandidates({
      message: {
        msg_id: 'goods-sample',
        ts: 1789977594,
        type: 0,
        content:
          'https://mobile.yangkeduo.com/goods.html?goods_id=GOODS_h_fe00df68&_oak_rcto=sample',
        from: { role: 'user', uid: 'buyer-1' },
        to: { role: 'mall_cs' }
      }
    })[0]
    expect(normalizePddCandidate(goods, 'profile-1')?.goodsId).toBe('GOODS_h_fe00df68')
  })

  it('把当前页面的 type 0 订单卡识别为卡片并提取订单与商品 ID', () => {
    const card = extractPddCandidates({
      message: {
        msg_id: 'order-card-1',
        ts: 1789977594,
        type: 0,
        content: '订单信息',
        info: {
          orderBriefPrompt: '查看订单',
          order_id: 'ORDER-1',
          orderSequenceNo: 'DISPLAY-1',
          goodsID: 12345,
          goodsName: '测试商品',
          spec: '红色 XL',
          order_status: 2,
          shipping_status: 0
        },
        from: { role: 'user', uid: 'buyer-1' },
        to: { role: 'mall_cs' }
      }
    })[0]
    const message = normalizePddCandidate(card, 'profile-1')
    expect(message).toMatchObject({
      contentType: 'order_card',
      orderId: 'ORDER-1',
      goodsId: '12345',
      goodsTitle: '测试商品',
      skuText: '红色 XL',
      rawOrderStatus: '2'
    })
    expect(message?.text).toBeUndefined()
  })

  it('商品链接缺少查询参数时使用卡片 info 中的商品 ID', () => {
    const goods = extractPddCandidates({
      message: {
        msg_id: 'goods-fallback',
        type: 0,
        content: 'https://mobile.yangkeduo.com/goods.html',
        info: { goodsID: 67890 },
        from: { role: 'user', uid: 'buyer-1' },
        to: { role: 'mall_cs' }
      }
    })[0]
    expect(normalizePddCandidate(goods, 'profile-1')?.goodsId).toBe('67890')
  })

  it('普通文字附带订单标识时仍保留为文字消息', () => {
    const text = extractPddCandidates({
      message: {
        msg_id: 'text-with-order-context',
        type: 0,
        content: '什么时候发货？',
        info: { order_id: 'ORDER-1' },
        from: { role: 'user', uid: 'buyer-1' },
        to: { role: 'mall_cs' }
      }
    })[0]
    expect(normalizePddCandidate(text, 'profile-1')).toMatchObject({
      contentType: 'text',
      text: '什么时候发货？'
    })
  })
})
