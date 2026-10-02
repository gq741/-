import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureMessageShape, describeMessageShape } from './messageSchemaCapture'

describe('message shape capture', () => {
  it('keeps nested keys while excluding message text and customer data', () => {
    const shape = describeMessageShape({
      content: JSON.stringify({ order_id: 'SECRET-ORDER', address: 'PRIVATE-ADDRESS' }),
      buyerId: 'PRIVATE-BUYER',
      items: [{ goods_id: 'SECRET-GOODS' }]
    })
    expect(shape).toEqual({
      content: { json: { order_id: 'string', address: 'string' } },
      buyerId: 'string',
      items: [{ goods_id: 'string' }]
    })
    const output = JSON.stringify(shape)
    expect(output).not.toContain('SECRET-ORDER')
    expect(output).not.toContain('PRIVATE-ADDRESS')
    expect(output).not.toContain('PRIVATE-BUYER')
    expect(output).not.toContain('SECRET-GOODS')
  })

  it('writes one parseable line without any original message values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yzs-schema-'))
    const before = process.env.YZS_SCHEMA_CAPTURE_PATH
    try {
      const file = join(directory, 'capture.jsonl')
      process.env.YZS_SCHEMA_CAPTURE_PATH = file
      await captureMessageShape('pdd', { content: 'PRIVATE-TEXT', order_id: 'SECRET-ORDER' }, 'order_card', 'type_7')
      const entry = JSON.parse((await readFile(file, 'utf8')).trim())
      expect(entry).toMatchObject({
        platform: 'pdd',
        contentType: 'order_card',
        shape: { content: 'string', order_id: 'string' }
      })
      expect(JSON.stringify(entry)).not.toContain('PRIVATE-TEXT')
      expect(JSON.stringify(entry)).not.toContain('SECRET-ORDER')
    } finally {
      if (before === undefined) delete process.env.YZS_SCHEMA_CAPTURE_PATH
      else process.env.YZS_SCHEMA_CAPTURE_PATH = before
      await rm(directory, { recursive: true, force: true })
    }
  })
})
