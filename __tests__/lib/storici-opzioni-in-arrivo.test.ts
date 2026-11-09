import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * COMPITO 4.5.4-bis · le stampe storiche non offrono il bambino che NON ha ancora cominciato.
 *
 * `opzioniStorici` elenca i bambini della sede per le stampe (registri, fascicoli) con DUE letture di `alunni`: quelli della sede
 * e gli ex alunni ricavati dalle classi storiche. Un bambino «in arrivo» (la domanda è per l'anno dopo) non ha registri da stampare:
 * non compare in nessuna delle due. Il finto client filtra davvero, e `stato` NULL resta (non è un `in_arrivo`).
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZ = '55555555-5555-4555-8555-555555555551'

const h = vi.hoisted(() => ({ sedi: [] as string[] }))
vi.mock('@/lib/auth/scope', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/scope')>()),
  scuoleDiUtente: async () => h.sedi,
}))

import { opzioniStorici } from '@/lib/storici/generazioni'

const alunno = (id: string, stato: string | null, extra: Record<string, unknown> = {}) => ({
  id, nome: 'N', cognome: id, section_id: null, archiviato_il: null, anonimizzato_il: null, scuola_id: SEDE, stato, ...extra,
})

let db: DBFinto
beforeEach(() => {
  h.sedi = [SEDE]
  db = {
    alunni: [
      alunno('a-frequenta', 'iscritto', { section_id: SEZ }),
      alunno('b-sospeso', 'sospeso', { section_id: SEZ }),
      alunno('c-ritirato', 'ritirato', { archiviato_il: '2026-09-01T00:00:00Z' }),
      alunno('d-stato-null', null, { section_id: SEZ }),
      alunno('e-in-arrivo', 'in_arrivo'),
    ],
    // un ex alunno (c-ritirato) e, per provare la SECONDA lettura, una classe storica attribuita anche al bambino in arrivo
    alunni_classi_storico: [
      { id: 'h1', alunno_id: 'c-ritirato', scuola_id: SEDE, section_id: SEZ, section_nome: '3 ANNI' },
      { id: 'h2', alunno_id: 'e-in-arrivo', scuola_id: SEDE, section_id: SEZ, section_nome: '3 ANNI' },
    ],
  } as DBFinto
})

const utente = { id: 'seg-1', role: 'segreteria', ruolo: 'segreteria', scuola_id: SEDE } as never

describe('opzioniStorici · il bambino in arrivo', () => {
  it('non compare fra i bambini offerti, né dalla lettura della sede né da quella degli ex alunni; gli altri restano', async () => {
    const out = await opzioniStorici(creaFintoSupabase(db) as never, utente, SEDE)
    const ids = out.alunni.map((a) => a.id).sort()
    expect(ids).not.toContain('e-in-arrivo')
    expect(ids).toEqual(['a-frequenta', 'b-sospeso', 'c-ritirato', 'd-stato-null'])
  })
})
