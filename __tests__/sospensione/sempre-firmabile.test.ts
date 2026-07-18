import { describe, it, expect } from 'vitest'
import { leggiSempreFirmabile } from '@/lib/forms/sempre-firmabile'

// Fake supabase: una singola lettura `.from(table).select().eq().maybeSingle()`.
function fake(risposta: { data?: unknown; error?: { code?: string } | null }) {
  return {
    from() {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: risposta.data ?? null, error: risposta.error ?? null })
      return b
    },
  } as never
}

describe('leggiSempreFirmabile', () => {
  it('true quando il flag del modulo è true', async () => {
    expect(await leggiSempreFirmabile(fake({ data: { sempre_firmabile: true } }), 'form_models', 'm1')).toBe(true)
  })

  it('false quando il flag è false o null', async () => {
    expect(await leggiSempreFirmabile(fake({ data: { sempre_firmabile: false } }), 'form_models', 'm1')).toBe(false)
    expect(await leggiSempreFirmabile(fake({ data: null }), 'forms_templates', 't1')).toBe(false)
  })

  it('colonna assente sul DB non migrato (42703) → false = comportamento bloccante', async () => {
    expect(await leggiSempreFirmabile(fake({ error: { code: '42703' } }), 'forms_templates', 't1')).toBe(false)
  })

  it('errore generico → false (mai apre il blocco per un guasto di lettura)', async () => {
    expect(await leggiSempreFirmabile(fake({ error: { code: '500' } }), 'form_models', 'm1')).toBe(false)
  })
})
