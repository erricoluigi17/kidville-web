// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ricordaIntestatarioSullaScheda } from '@/lib/pagamenti/intestatari'

/**
 * ─── «RICORDA CHI HA PAGATO» — la scrittura più delicata di tutto il lotto ───
 *
 * Il lotto emette fatture intestate al genitore RICONOSCIUTO dall'ordinante del
 * bonifico. Dal 2026-09-08, a emissione riuscita, quel nome viene anche scritto
 * sulla scheda del bambino, così la fattura successiva non deve più dedurlo.
 *
 * È una scrittura sull'anagrafica di un minore, decisa da un'euristica: le due
 * condizioni qui sotto non sono prudenza, sono il contratto.
 *
 *  1. NON SOVRASCRIVE MAI una scheda già compilata. E la condizione sta nella
 *     `WHERE` della UPDATE, non in una lettura fatta prima: fra la lettura e la
 *     scrittura una persona può aver compilato quella scheda a mano, e la sua
 *     scelta batte la nostra deduzione — sempre.
 *  2. NON ROMPE NIENTE se fallisce. La fattura è già partita verso lo SdI e non
 *     si può disfare: un errore qui è un `warn`, non un'eccezione.
 *
 * Misurato in produzione il 2026-09-08: dei 693 alunni, 516 hanno la colonna
 * `NULL` e NESSUNO ha il letterale jsonb `null` — quindi `.is(…, null)` è la
 * condizione giusta e non ne serve una seconda.
 */

/** Un client finto che REGISTRA la catena: è la catena, la cosa da collaudare. */
function clientFinto(risposta: { data?: unknown[] | null; error?: unknown }) {
  const visto: Record<string, unknown> = {}
  const catena = {
    update: (v: unknown) => { visto.update = v; return catena },
    eq: (col: string, val: unknown) => { visto.eq = [col, val]; return catena },
    is: (col: string, val: unknown) => { visto.is = [col, val]; return catena },
    select: (cols: string) => { visto.select = cols; return Promise.resolve({ data: risposta.data ?? null, error: risposta.error ?? null }) },
  }
  const from = vi.fn((tabella: string) => { visto.from = tabella; return catena })
  return { supabase: { from } as unknown as SupabaseClient, visto, from }
}

describe('ricordaIntestatarioSullaScheda', () => {
  it('scrive sulla scheda VUOTA, e la condizione «vuota» sta nella WHERE', async () => {
    const { supabase, visto } = clientFinto({ data: [{ id: 'al-1' }] })

    const { esito, error } = await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')

    expect(esito).toBe('salvato')
    expect(error).toBe(null)
    expect(visto.from).toBe('alunni')
    expect(visto.update).toEqual({ intestatario_fatture: { tipo: 'adult', adult_id: 'a-1' } })
    expect(visto.eq).toEqual(['id', 'al-1'])
    // ⚠️ SENZA QUESTA RIGA il caso resterebbe verde su un'implementazione che legge
    // prima e scrive dopo — e che quindi può sovrascrivere una scheda compilata a
    // mano nel frattempo. La condizione DEVE viaggiare con la UPDATE.
    expect(visto.is).toEqual(['intestatario_fatture', null])
  })

  it('scheda già compilata: zero righe toccate ⇒ «gia_impostato», che non è un errore', async () => {
    const { supabase } = clientFinto({ data: [] })
    expect((await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')).esito).toBe('gia_impostato')
  })

  it('PostgREST non lancia: l’errore si legge dal valore di ritorno', async () => {
    // AGENTS.md, regola 7. Un `try/catch` qui non scatterebbe mai.
    const { supabase } = clientFinto({ data: null, error: { code: '42703', message: 'colonna assente' } })
    const r = await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')
    expect(r.esito).toBe('non_salvato')
    // ⚠️ L'ERRORE NON SI BUTTA VIA (AGENTS.md, regola 3): `42703` («colonna
    // assente», ambiente non migrato) e `42501` («policy») chiedono due interventi
    // diversi, e un'enumerazione a tre valori li fa uscire tutti e due come
    // «non salvato» — cioè come uno status senza il corpo.
    expect(r.error).toMatchObject({ code: '42703' })
  })

  it('il campo `nome` NON viene scritto: sarebbe una copia destinata a invecchiare', async () => {
    const { supabase, visto } = clientFinto({ data: [{ id: 'al-1' }] })
    await ricordaIntestatarioSullaScheda(supabase, 'al-1', 'a-1')
    expect(Object.keys((visto.update as { intestatario_fatture: object }).intestatario_fatture)).toEqual(['tipo', 'adult_id'])
  })
})
