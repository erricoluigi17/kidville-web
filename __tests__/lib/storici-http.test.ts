import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/logging/logger', () => ({ logErrore: vi.fn(), logEvento: vi.fn() }))
import { conCacheStorico } from '@/lib/storici/http'

describe('conCacheStorico — firma, stream e intestazioni', () => {
  it('mantiene la firma delle route dinamiche e non consuma il corpo della risposta', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255])
    const originale = new Response(bytes, { status: 202, statusText: 'In preparazione', headers: { 'Retry-After': '45', 'Cache-Control': 'public, max-age=60', 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="storico.xlsx"' } })
    const request = new NextRequest('http://test/api/admin/storici/generazioni/123')
    const context = { params: Promise.resolve({ id: '123' }) }
    const handler = vi.fn(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
      expect(req).toBe(request)
      expect(ctx).toBe(context)
      expect(await ctx.params).toEqual({ id: '123' })
      return originale
    })
    const res = await conCacheStorico(handler)(request, context)
    expect(handler).toHaveBeenCalledExactlyOnceWith(request, context)
    expect(originale.bodyUsed).toBe(false)
    expect(res.status).toBe(202)
    expect(res.statusText).toBe('In preparazione')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Retry-After')).toBe('45')
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="storico.xlsx"')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes])
  })

  it('gestisce anche le intestazioni immutabili senza cambiare il redirect', async () => {
    const originale = Response.redirect('https://example.invalid/accesso', 307)
    expect(() => originale.headers.set('Cache-Control', 'private, no-store')).toThrow()
    const res = await conCacheStorico(async (request: Request) => {
      expect(request.url).toBe('http://test/storici')
      return originale
    })(new Request('http://test/storici'))
    expect(res.status).toBe(307)
    expect(res.headers.get('Location')).toBe('https://example.invalid/accesso')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
