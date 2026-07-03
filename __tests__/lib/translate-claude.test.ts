import { describe, it, expect, vi } from 'vitest'
import { translateText } from '@/lib/translate/claude'

// P4/DL-042 — traduzione chat via Claude (haiku), gated su ANTHROPIC_API_KEY.
// Client iniettabile per testare senza rete.

function fakeClient(text: string) {
  const create = vi.fn<(args: unknown) => Promise<{ content: { type: string; text: string }[] }>>(
    async () => ({ content: [{ type: 'text', text }] })
  )
  return { messages: { create }, _create: create }
}

describe('translateText', () => {
  it('disabilitato se manca la API key', async () => {
    const res = await translateText('ciao', 'en', { apiKey: undefined })
    expect(res).toEqual({ translated: null, disabled: true })
  })

  it('testo vuoto → stringa vuota, nessuna chiamata', async () => {
    const c = fakeClient('x')
    const res = await translateText('   ', 'en', { apiKey: 'sk-test', client: c })
    expect(res.translated).toBe('')
    expect(c._create).not.toHaveBeenCalled()
  })

  it('traduce e ritorna il blocco testo; usa model haiku + targetLang nel system', async () => {
    const c = fakeClient('hello world')
    const res = await translateText('ciao mondo', 'en', { apiKey: 'sk-test', client: c })
    expect(res.translated).toBe('hello world')
    const args = c._create.mock.calls[0][0] as { model: string; system: string; messages: { content: string }[] }
    expect(args.model).toBe('claude-haiku-4-5')
    expect(args.system).toContain('en')
    expect(args.messages[0].content).toBe('ciao mondo')
  })

  it('errore del client → translated null (non lancia)', async () => {
    const client = { messages: { create: vi.fn(async () => { throw new Error('boom') }) } }
    const res = await translateText('ciao', 'en', { apiKey: 'sk-test', client })
    expect(res.translated).toBeNull()
  })
})
