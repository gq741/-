import { appendFile } from 'node:fs/promises'

let captured = 0

export function describeMessageShape(value: unknown, depth = 0): unknown {
  if (depth >= 6) return 'nested'
  if (Array.isArray(value))
    return value.slice(0, 5).map((item) => describeMessageShape(item, depth + 1))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return { json: describeMessageShape(JSON.parse(trimmed), depth + 1) }
      } catch {
        // Ordinary text is represented only by its type.
      }
    }
    return 'string'
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [key, describeMessageShape(item, depth + 1)])
    )
  }
  return value === null ? 'null' : typeof value
}

export async function captureMessageShape(
  platform: 'pdd' | 'douyin',
  message: unknown,
  contentType: string,
  rawType: string
): Promise<void> {
  const file = process.env.YZS_SCHEMA_CAPTURE_PATH
  if (!file || captured >= 100) return
  captured += 1
  const safeContentType = /^(text|image|video|order_card|goods_card|system|goods_link|withdraw|source_hint|type_\d+)$/.test(contentType)
    ? contentType
    : 'other'
  const safeRawType = /^(text|image|file_image|video|template_card|type_\d+)$/.test(rawType)
    ? rawType
    : 'other'
  try {
    await appendFile(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), platform, contentType: safeContentType, rawType: safeRawType, shape: describeMessageShape(message) })}\n`,
      'utf8'
    )
  } catch {
    // Diagnostics must never interrupt message reception.
  }
}
