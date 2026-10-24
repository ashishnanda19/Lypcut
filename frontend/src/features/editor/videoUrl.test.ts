import { describe, expect, it } from 'vitest'
import { expiryOf } from './videoUrl'

describe('when a presigned link stops working', () => {
  it('is the signing time plus the lifetime', () => {
    const url =
      'http://localhost:9000/lypcut/x/proxy.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261024T073343Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
    expect(expiryOf(url)).toBe(Date.UTC(2026, 9, 24, 8, 33, 43))
  })

  it('is unknown for a link without those parts', () => {
    expect(expiryOf('/demo/proxy.mp4')).toBeNull()
    expect(expiryOf('https://cdn.example.com/a.mp4?X-Amz-Date=bad&X-Amz-Expires=60')).toBeNull()
    expect(expiryOf('https://cdn.example.com/a.mp4?X-Amz-Date=20261024T073343Z')).toBeNull()
    expect(expiryOf('not a url at all')).toBeNull()
  })
})
