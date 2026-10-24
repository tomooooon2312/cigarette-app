import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MEDIAPIPE_TELEMETRY_PREFIX, blockMediaPipeTelemetry } from '../src/lib/telemetryGuard.ts'

describe('blockMediaPipeTelemetry', () => {
  it('MediaPipe の利用統計の送信だけを失敗させ、それ以外の fetch はそのまま通す', async () => {
    const calls: string[] = []
    const target = {
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input instanceof Request ? input.url : input))
        return new Response('ok')
      }) as typeof fetch,
    }
    blockMediaPipeTelemetry(target)
    await assert.rejects(target.fetch(`${MEDIAPIPE_TELEMETRY_PREFIX}v1/log`, { method: 'POST' }), TypeError)
    await assert.rejects(target.fetch(new URL(`${MEDIAPIPE_TELEMETRY_PREFIX}v1/log`)), TypeError)
    await assert.rejects(target.fetch(new Request(`${MEDIAPIPE_TELEMETRY_PREFIX}v1/log`)), TypeError)
    assert.equal(await (await target.fetch('/models/face_landmarker.task')).text(), 'ok')
    assert.equal(await (await target.fetch('https://example.com/odml.pa.googleapis.com/')).text(), 'ok')
    assert.deepEqual(calls, ['/models/face_landmarker.task', 'https://example.com/odml.pa.googleapis.com/'])
  })
})
