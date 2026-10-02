import type { PddOrderSummary } from '@shared/contracts'

export interface PddOrderProbeResult {
  status:
    | 'ok'
    | 'wrong_origin'
    | 'signer_missing'
    | 'signer_error'
    | 'http_error'
    | 'invalid_json'
    | 'platform_error'
    | 'shape_changed'
    | 'buyer_mismatch'
    | 'error'
  httpStatus?: number
  platformSuccess?: boolean
  platformErrorCode?: number
  orderCount?: number
  total?: number
  orders?: PddOrderSummary[]
  shape?: unknown
}

export interface PddBuyerOrderContext {
  profileId: string
  buyerId: string
  fetchedAt: number
  total: number
  orders: PddOrderSummary[]
}
export function createPddOrderProbeScript(buyerId: string): string {
  return `(async () => {
    if (location.hostname !== 'mms.pinduoduo.com') return { status: 'wrong_origin' };
    const store = document.querySelector('#app')?.__vue__?.$store;
    const im = store?.state?.IMSDK;
    const crawler = window.riskControlCrawler || store?.state?.riskControlCrawler || im?.riskControlCrawler;
    if (typeof crawler?.messagePack !== 'function') return { status: 'signer_missing' };
    let signature;
    try {
      const now = (window.SERVER_DIFF_TIME || 0) + Date.now();
      if (typeof crawler.updateServerTime === 'function') crawler.updateServerTime(now);
      signature = await crawler.messagePack();
    } catch { return { status: 'signer_error' }; }
    if (!signature) return { status: 'signer_missing' };
    const shape = (value, depth = 0) => {
      if (depth >= 8) return 'nested';
      if (Array.isArray(value)) return { arrayLength: value.length, items: value.slice(0, 2).map((item) => shape(item, depth + 1)) };
      if (value && typeof value === 'object') {
        const output = {};
        for (const key of Object.keys(value).filter((key) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)).slice(0, 80))
          output[key] = shape(value[key], depth + 1);
        return output;
      }
      return value === null ? 'null' : typeof value;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/latitude/order/userAllOrder', {
        method: 'POST', credentials: 'include', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'anti-content': String(signature) },
        body: JSON.stringify({ pageNo: 1, pageSize: 5, showHistory: true, uid: ${JSON.stringify(buyerId)} })
      });
      if (!response.ok) return { status: 'http_error', httpStatus: response.status };
      let body;
      try { body = await response.json(); }
      catch { return { status: 'invalid_json', httpStatus: response.status }; }
      if (body?.success !== true || ![0, 1000000].includes(Number(body?.errorCode)))
        return { status: 'platform_error', httpStatus: response.status,
          platformSuccess: body?.success === true,
          platformErrorCode: Number.isFinite(Number(body?.errorCode)) ? Number(body.errorCode) : undefined,
          shape: shape(body) };
      const result = body?.result;
      const orders = result?.orders;
      if (orders === null && result?.total === 0)
        return { status: 'ok', httpStatus: response.status,
          orderCount: 0, total: 0, orders: [], shape: shape(body) };
      if (!Array.isArray(orders))
        return { status: 'shape_changed', httpStatus: response.status, shape: shape(body) };
      const requestedUid = String(${JSON.stringify(buyerId)});
      if (orders.some((order) => order?.uid == null || String(order.uid) !== requestedUid))
        return { status: 'buyer_mismatch', httpStatus: response.status, orderCount: orders.length };
      const text = (value) => value == null ? '' : String(value).trim();
      const summaries = orders.slice(0, 5).map((order) => {
        const source = Array.isArray(order.orderGoodsList) ? order.orderGoodsList[0] : order.orderGoodsList;
        const goods = source && typeof source === 'object' ? source : {};
        return {
          orderId: text(order.orderSn || order.id),
          mallId: text(order.mallId) || undefined,
          goodsId: text(goods.goodsId) || undefined,
          skuId: text(goods.skuId) || undefined,
          goodsTitle: text(goods.goodsName) || undefined,
          spec: text(goods.spec) || undefined,
          rawOrderStatus: text(order.orderStatusStr || order.orderStatus) || undefined,
          rawGoodsPrice: typeof goods.goodsPrice === 'number' ? goods.goodsPrice : undefined,
          rawOrderTime: typeof order.orderTime === 'number' ? order.orderTime : undefined
        };
      }).filter((order) => order.orderId);
      return { status: 'ok', httpStatus: response.status,
        orderCount: orders.length, total: Number(result.total) || orders.length,
        orders: summaries, shape: shape(body) };
    } catch { return { status: 'error' }; }
    finally { clearTimeout(timer); }
  })()`
}
