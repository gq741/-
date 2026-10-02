export const ENABLE_PLATFORM_WEBVIEW = process.env['ENABLE_PLATFORM_WEBVIEW'] !== 'false'
export const PLATFORM_HOST_ALLOWLIST = new Set([
  'mms.pinduoduo.com',
  'im.jinritemai.com',
  'jsls.jinritemai.com'
])
export const usePddGuestSession = (): boolean => process.env['PDD_SEND_CONTEXT'] !== 'chrome'
