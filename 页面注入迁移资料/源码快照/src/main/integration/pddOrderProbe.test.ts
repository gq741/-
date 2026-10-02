import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { createPddOrderProbeScript } from './pddOrderProbe'

describe('PDD read-only order probe', () => {
  it('uses the page signer and returns only field types and order count', async () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = []
    const result = await runInNewContext(createPddOrderProbeScript('123'), {
      location: { hostname: 'mms.pinduoduo.com' },
      document: { querySelector: () => ({ __vue__: { $store: { state: {} } } }) },
      window: { riskControlCrawler: { messagePack: () => 'SIGNATURE' } },
      fetch: async (url: string, options: Record<string, unknown>) => {
        calls.push({ url, options })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            errorCode: 1000000,
            result: {
              total: 1,
              orders: [
                {
                  uid: 123,
                  orderSn: 'PRIVATE-ORDER',
                  orderStatusStr: '待发货',
                  mallId: 9,
                  orderGoodsList: {
                    goodsId: 7,
                    skuId: 8,
                    goodsName: 'PRIVATE-GOODS',
                    spec: '蓝色 M',
                    goodsPrice: 9900
                  }
                }
              ]
            }
          })
        }
      },
      AbortController,
      setTimeout,
      clearTimeout,
      Date,
      Object,
      Array,
      String,
      JSON
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/latitude/order/userAllOrder')
    expect(calls[0].options).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(JSON.parse(String(calls[0].options.body))).toMatchObject({
      uid: '123',
      pageNo: 1,
      pageSize: 5
    })
    expect(result).toMatchObject({ status: 'ok', httpStatus: 200, orderCount: 1 })
    expect(result.shape.result.orders.items[0].orderSn).toBe('string')
    expect(result.orders).toMatchObject([
      {
        orderId: 'PRIVATE-ORDER',
        goodsId: '7',
        skuId: '8',
        rawOrderStatus: '待发货',
        spec: '蓝色 M',
        rawGoodsPrice: 9900
      }
    ])
    expect(JSON.stringify(result.shape)).not.toContain('PRIVATE-ORDER')
    expect(JSON.stringify(result.shape)).not.toContain('PRIVATE-GOODS')
  })

  it('keeps the first five summaries and reports the platform total separately', async () => {
    const result = await runInNewContext(createPddOrderProbeScript('123'), {
      location: { hostname: 'mms.pinduoduo.com' },
      document: { querySelector: () => ({ __vue__: { $store: { state: {} } } }) },
      window: { riskControlCrawler: { messagePack: () => 'SIGNATURE' } },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          errorCode: 1000000,
          result: {
            total: 6,
            orders: Array.from({ length: 6 }, (_, index) => ({ uid: 123, orderSn: `ORDER-${index}` }))
          }
        })
      }),
      AbortController,
      setTimeout,
      clearTimeout,
      Date,
      Object,
      Array,
      String,
      JSON
    })
    expect(result).toMatchObject({ status: 'ok', total: 6, orderCount: 6 })
    expect(result.orders).toHaveLength(5)
    expect(result.orders.map((item: { orderId: string }) => item.orderId)).toEqual([
      'ORDER-0', 'ORDER-1', 'ORDER-2', 'ORDER-3', 'ORDER-4'
    ])
  })

  it('captures a platform error code without returning error text or order data', async () => {
    const result = await runInNewContext(createPddOrderProbeScript('123'), {
      location: { hostname: 'mms.pinduoduo.com' },
      document: { querySelector: () => ({ __vue__: { $store: { state: {} } } }) },
      window: { riskControlCrawler: { messagePack: () => 'SIGNATURE' } },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: false, errorCode: 19001, errorMsg: 'PRIVATE-ERROR' })
      }),
      AbortController,
      setTimeout,
      clearTimeout,
      Date,
      Object,
      Array,
      String,
      JSON
    })
    expect(result).toMatchObject({
      status: 'platform_error',
      platformSuccess: false,
      platformErrorCode: 19001
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE-ERROR')
  })
  it('stops before fetch when page signing is unavailable', async () => {
    const result = await runInNewContext(createPddOrderProbeScript('123'), {
      location: { hostname: 'mms.pinduoduo.com' },
      document: { querySelector: () => null },
      window: {},
      Date
    })
    expect(result).toMatchObject({ status: 'signer_missing' })
  })
  it('rejects a buyer mismatch instead of exposing another buyer order', async () => {
    const result = await runInNewContext(createPddOrderProbeScript('123'), {
      location: { hostname: 'mms.pinduoduo.com' },
      document: { querySelector: () => ({ __vue__: { $store: { state: {} } } }) },
      window: { riskControlCrawler: { messagePack: () => 'SIGNATURE' } },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          errorCode: 0,
          result: { orders: [{ uid: 999, orderSn: 'OTHER-ORDER' }] }
        })
      }),
      AbortController,
      setTimeout,
      clearTimeout,
      Date,
      Object,
      Array,
      String,
      JSON
    })
    expect(result).toMatchObject({ status: 'buyer_mismatch' })
    expect(JSON.stringify(result)).not.toContain('OTHER-ORDER')
  })

  it('distinguishes a verified empty order list from an invalid response', async () => {
    const base = {
      location: { hostname: 'mms.pinduoduo.com' },
      document: { querySelector: () => ({ __vue__: { $store: { state: {} } } }) },
      window: { riskControlCrawler: { messagePack: () => 'SIGNATURE' } },
      AbortController,
      setTimeout,
      clearTimeout,
      Date,
      Object,
      Array,
      String,
      JSON
    }
    const empty = await runInNewContext(createPddOrderProbeScript('123'), {
      ...base,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, errorCode: 0, result: { total: 0, orders: [] } })
      })
    })
    expect(empty).toMatchObject({ status: 'ok', orderCount: 0, orders: [] })
    const invalid = await runInNewContext(createPddOrderProbeScript('123'), {
      ...base,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, errorCode: 0, result: {} })
      })
    })
    expect(invalid).toMatchObject({ status: 'shape_changed' })
  })
  it('accepts the platform empty-order form only when orders is null and total is zero', async () => {
    const base = {
      location: { hostname: 'mms.pinduoduo.com' },
      document: { querySelector: () => ({ __vue__: { $store: { state: {} } } }) },
      window: { riskControlCrawler: { messagePack: () => 'SIGNATURE' } },
      AbortController,
      setTimeout,
      clearTimeout,
      Date,
      Object,
      Array,
      String,
      JSON
    }
    const empty = await runInNewContext(createPddOrderProbeScript('123'), {
      ...base,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          errorCode: 1000000,
          result: { total: 0, historyTotal: 0, orders: null }
        })
      })
    })
    expect(empty).toMatchObject({ status: 'ok', total: 0, orderCount: 0, orders: [] })
    const suspicious = await runInNewContext(createPddOrderProbeScript('123'), {
      ...base,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          errorCode: 1000000,
          result: { total: 1, orders: null }
        })
      })
    })
    expect(suspicious).toMatchObject({ status: 'shape_changed' })
  })
})
