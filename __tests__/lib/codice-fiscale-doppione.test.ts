import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { codiceFiscaleDiAltroAlunno } from '@/lib/alunni/codice-fiscale-doppione'

const cliente = (risposta: { data?: unknown[]; error?: unknown }) => {
  const filtri: [string, unknown][] = []
  const catena: Record<string, unknown> = {}
  catena.select = () => catena
  catena.eq = (c: string, v: unknown) => { filtri.push([c, v]); return catena }
  catena.neq = (c: string, v: unknown) => { filtri.push([`!${c}`, v]); return catena }
  catena.limit = async () => ({ data: risposta.data ?? null, error: risposta.error ?? null })
  return { supabase: { from: () => catena } as unknown as SupabaseClient, filtri }
}

describe('codiceFiscaleDiAltroAlunno', () => {
  it('c’è un altro alunno con quel codice: usato, e il filtro esclude l’alunno stesso e NON ha filtri di sede', async () => {
    const { supabase, filtri } = cliente({ data: [{ id: 'x' }] })
    expect(await codiceFiscaleDiAltroAlunno(supabase, 'CF', 'me')).toEqual({ ok: true, usato: true })
    expect(filtri).toEqual([['codice_fiscale', 'CF'], ['!id', 'me']])
  })

  it('nessuno: libero', async () => {
    expect(await codiceFiscaleDiAltroAlunno(cliente({ data: [] }).supabase, 'CF', 'me')).toEqual({ ok: true, usato: false })
  })

  it('un guasto di lettura NON è «libero»: ok false con l’errore', async () => {
    const r = await codiceFiscaleDiAltroAlunno(cliente({ error: { code: '57014' } }).supabase, 'CF', 'me')
    expect(r).toMatchObject({ ok: false })
  })
})
