import type { RawEnvelope } from '@shared/contracts'

const blocked = /token|cookie|password|phone|mobile|address|order.?id/i

export function redactRecord(input: Record<string, unknown>, capturedAt: number): RawEnvelope {
  const fields: RawEnvelope['fields'] = {}
  for (const [key, value] of Object.entries(input)) {
    if (blocked.test(key)) continue
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) {
      fields[key] = value as string | number | boolean | null
    }
  }
  const sizeBytes = Buffer.byteLength(JSON.stringify(fields))
  return {
    kind: 'platform_frame',
    capturedAt,
    sizeBytes: Math.min(sizeBytes, 8192),
    redacted: true,
    truncated: sizeBytes > 8192,
    fields
  }
}
