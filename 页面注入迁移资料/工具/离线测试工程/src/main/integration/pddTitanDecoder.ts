import { gunzipSync } from 'node:zlib'
import type { KnownContentType, NormalizedMessage } from '@shared/contracts'

interface Candidate {
  message: Record<string, unknown>
  sequence?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(value: string): unknown | undefined {
  const text = value.replace(/^\uFEFF/, '').trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    for (const [open, close] of [
      ['{', '}'],
      ['[', ']']
    ] as const) {
      const start = text.indexOf(open)
      const end = text.lastIndexOf(close)
      if (start < 0 || end <= start) continue
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // Continue with the next possible container.
      }
    }
    return undefined
  }
}

function gzipOffsets(buffer: Buffer): number[] {
  const offsets: number[] = []
  for (let index = 0; index <= buffer.length - 3; index += 1) {
    if (buffer[index] === 0x1f && buffer[index + 1] === 0x8b && buffer[index + 2] === 0x08) {
      offsets.push(index)
    }
  }
  return offsets
}

function inflateEmbeddedGzip(buffer: Buffer, offset: number): Buffer | undefined {
  try {
    return gunzipSync(buffer.subarray(offset))
  } catch {
    // Titan wraps the gzip member inside a protobuf envelope, so trailing bytes are expected.
  }
  const minimumEnd = offset + 18
  const maxInflatedBytes = 20 * 1024 * 1024
  for (let end = buffer.length - 1; end >= minimumEnd; end -= 1) {
    const expectedSize = buffer.readUInt32LE(end - 4)
    if (expectedSize > maxInflatedBytes) continue
    try {
      const inflated = gunzipSync(buffer.subarray(offset, end))
      if (inflated.length === expectedSize) return inflated
    } catch {
      // Keep searching for the gzip footer before the protobuf trailing bytes.
    }
  }
  return undefined
}

export function decodeTitanPayload(payloadData: string, opcode: number): unknown[] {
  const decoded: unknown[] = []
  if (opcode === 1) {
    const value = parseJson(payloadData)
    if (value !== undefined) decoded.push(value)
    return decoded
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(payloadData, 'base64')
  } catch {
    return decoded
  }

  for (const offset of gzipOffsets(buffer)) {
    const inflated = inflateEmbeddedGzip(buffer, offset)
    if (inflated) {
      const text = inflated.toString('utf8')
      const value = parseJson(text)
      if (value !== undefined) decoded.push(value)
    }
  }
  if (!decoded.length) {
    const value = parseJson(buffer.toString('utf8'))
    if (value !== undefined) decoded.push(value)
  }
  return decoded
}

function collectCandidates(
  value: unknown,
  output: Candidate[],
  inheritedSequence?: number,
  depth = 0
): void {
  if (depth > 10) return
  if (
    typeof value === 'string' &&
    (value.trimStart().startsWith('[') || value.trimStart().startsWith('{'))
  ) {
    const parsed = parseJson(value)
    if (parsed !== undefined) collectCandidates(parsed, output, inheritedSequence, depth + 1)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, output, inheritedSequence, depth + 1)
    return
  }
  if (!isRecord(value)) return

  const sequence =
    typeof value.seq_id === 'number'
      ? value.seq_id
      : typeof value.seq_id === 'string'
        ? Number(value.seq_id)
        : inheritedSequence
  if (isRecord(value.message) && value.message.msg_id && isRecord(value.message.from)) {
    output.push({ message: value.message, sequence })
  }
  for (const nested of Object.values(value)) {
    if (nested === value.message) continue
    collectCandidates(nested, output, sequence, depth + 1)
  }
}

export function extractPddCandidates(payload: unknown): Candidate[] {
  const output: Candidate[] = []
  collectCandidates(payload, output)
  const seen = new Set<string>()
  return output.filter(({ message }) => {
    const key = String(message.msg_id ?? '')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function contentType(
  type: number,
  content: string,
  info: Record<string, unknown>
): KnownContentType | (string & {}) {
  if (
    type === 0 &&
    (idText(info.order_id) || idText(info.orderSequenceNo)) &&
    ('orderBriefPrompt' in info || 'order_status' in info)
  ) {
    return 'order_card'
  }
  if (type === 0 && /(?:mobile\.)?yangkeduo\.com\/goods\.html/i.test(content)) {
    return 'goods_link'
  }
  if (type === 0) return 'text'
  if (type === 1) return 'image'
  if (type === 1002) return 'withdraw'
  if (type === 41) return 'source_hint'
  if (type === 20 || type === 40) return 'system'
  return `type_${type}`
}

function idText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const id = String(value).trim()
  return id && id !== '0' ? id : undefined
}

function goodsIdFromLink(content: string): string | undefined {
  const match = content.match(/(?:https?:\/\/)?(?:mobile\.)?yangkeduo\.com\/goods\.html[^\s]*/i)
  if (!match) return undefined
  try {
    const url = new URL(match[0].startsWith('http') ? match[0] : `https://${match[0]}`)
    return url.searchParams.get('goods_id') || undefined
  } catch {
    return undefined
  }
}

function toTimestamp(value: unknown, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric
}

export function normalizePddCandidate(
  candidate: Candidate,
  profileId: string,
  receivedAt = Date.now()
): NormalizedMessage | undefined {
  const raw = candidate.message
  const from = isRecord(raw.from) ? raw.from : {}
  const to = isRecord(raw.to) ? raw.to : {}
  const fromRole = String(from.role ?? '')
  const toRole = String(to.role ?? '')
  const buyerId =
    fromRole === 'user'
      ? String(from.uid ?? '')
      : toRole === 'user'
        ? String(to.uid ?? '')
        : String(from.uid ?? to.uid ?? '')
  const platformMessageId = String(raw.msg_id ?? '')
  if (!buyerId || !platformMessageId) return undefined

  const type = Number(raw.type ?? -1)
  const content = typeof raw.content === 'string' ? raw.content : ''
  const info = isRecord(raw.info) ? raw.info : {}
  const bizContext = isRecord(raw.biz_context) ? raw.biz_context : {}
  const direction = fromRole === 'mall_cs' ? 'out' : 'in'
  const occurredAt = toTimestamp(raw.ts, receivedAt)
  const normalizedType = contentType(type, content, info)
  const safeId = platformMessageId.replace(/[^\w-]/g, '_')

  return {
    id: `pdd-${profileId}-${safeId}`,
    platformId: 'pdd-web',
    profileId,
    conversationId: `pdd:${buyerId}`,
    platformMessageId,
    buyerId,
    buyerName: typeof raw.nickname === 'string' ? raw.nickname : undefined,
    direction,
    contentType: normalizedType,
    rawType: `type_${type}`,
    text:
      normalizedType === 'text' ||
      normalizedType === 'goods_link' ||
      normalizedType === 'withdraw' ||
      normalizedType === 'source_hint'
        ? content
        : undefined,
    mediaUrl: normalizedType === 'image' ? content : undefined,
    orderId:
      normalizedType === 'order_card'
        ? idText(info.order_id) || idText(info.orderSequenceNo)
        : undefined,
    goodsId:
      normalizedType === 'goods_link'
        ? goodsIdFromLink(content) || idText(info.goodsID) || idText(bizContext.goodsId)
        : normalizedType === 'order_card'
          ? idText(info.goodsID)
          : undefined,
    goodsTitle:
      normalizedType === 'goods_link' || normalizedType === 'order_card'
        ? (typeof info.goodsName === 'string' ? info.goodsName.trim() : '') || undefined
        : undefined,
    skuText:
      normalizedType === 'order_card' && typeof info.spec === 'string'
        ? info.spec.trim() || undefined
        : undefined,
    rawOrderStatus: normalizedType === 'order_card' ? idText(info.order_status) : undefined,
    platformSequence: candidate.sequence,
    receivedSequence: candidate.sequence ?? receivedAt,
    occurredAt,
    receivedAt,
    sendStatus: direction === 'out' ? 'sent' : undefined,
    raw: {
      kind: 'platform_frame',
      capturedAt: receivedAt,
      sizeBytes: Buffer.byteLength(JSON.stringify(raw)),
      redacted: true,
      fields: {
        platformType: type,
        fromRole,
        toRole,
        previousMessageId:
          typeof raw.pre_msg_id === 'string' || typeof raw.pre_msg_id === 'number'
            ? String(raw.pre_msg_id)
            : null,
        clientMessageId: typeof raw.client_msg_id === 'string' ? raw.client_msg_id : null
      }
    }
  }
}
