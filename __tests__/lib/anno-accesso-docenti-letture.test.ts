import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * I due controlli di LETTURA dei docenti (4.3.6): l'anagrafica in sola lettura e il fascicolo. Valgono tutte le
 * sezioni VISIBILI (anno attivo e anni passati, questi ultimi in sola lettura), mai quelle di un anno futuro.
 * I due di scrittura (`permesso-voce`, `segnalazioni`) hanno i loro casi in `primaria-permesso-voce.test.ts`
 * e `segnalazioni-route.test.ts`.
 */

vi.mock('@/lib/logging/logger', async (orig) => ({ ...(await orig<object>()), logEvento: vi.fn(), logErrore: vi.fn() }))

import { sezioniAnagraficaVisibili } from '@/lib/anagrafiche/docente/visibilita'
import { puoAccedereFascicolo, sezioniContitolari } from '@/lib/primaria/fascicolo-rbac'

const DOC = '33333333-3333-4333-8333-333333333333'
const SEDE = '22222222-2222-4222-8222-222222222222'
const S_ATTIVA = '55555555-5555-4555-8555-555555555552'
const S_PASSATA = '55555555-5555-4555-8555-555555555551'
const S_FUTURA = '55555555-5555-4555-8555-555555555553'
const AL_ATTIVA = 'a1000000-0000-4000-8000-000000000001'
const AL_PASSATA = 'a1000000-0000-4000-8000-000000000002'
const AL_FUTURA = 'a1000000-0000-4000-8000-000000000003'

const educator = { id: DOC, role: 'educator', scuola_id: SEDE } as never

function db(): DBFinto {
  return {
    utenti: [{ id: DOC, ruolo: 'maestra', role: 'educator', scuola_id: SEDE }],
    utenti_sezioni: [],
    // La sezione futura ha anche un'assegnazione per materia: non deve bastare.
    utenti_sezioni_materie: [
      { utente_id: DOC, section_id: S_FUTURA, materia_id: 'm1' },
      { utente_id: DOC, section_id: S_ATTIVA, materia_id: 'm1' },
    ],
    alunni: [
      { id: AL_ATTIVA, section_id: S_ATTIVA, scuola_id: SEDE },
      { id: AL_PASSATA, section_id: S_PASSATA, scuola_id: SEDE },
      { id: AL_FUTURA, section_id: S_FUTURA, scuola_id: SEDE },
    ],
  } as unknown as DBFinto
}

const conFunzione = (data: unknown, error: unknown = null, errori?: Record<string, unknown>): SupabaseClient =>
  creaFintoSupabase(db(), [], {
    rpc: { sezioni_visibili_docente: () => ({ data, error }) } as never,
    ...(errori ? { errori: errori as never } : {}),
  })

const VISIBILI = [
  { section_id: S_ATTIVA, sola_lettura: false },
  { section_id: S_PASSATA, sola_lettura: true },
]

describe('sezioniAnagraficaVisibili', () => {
  it('anno attivo e anno passato (sola lettura) sì, anno in preparazione no', async () => {
    const r = await sezioniAnagraficaVisibili(conFunzione(VISIBILI), educator)
    expect(r.esito === 'sezioni' && [...r.sezioni].sort()).toEqual([S_ATTIVA, S_PASSATA].sort())
  })

  it('un guasto della funzione è `errore`, come oggi', async () => {
    expect(await sezioniAnagraficaVisibili(conFunzione(null, { code: '57014', message: 'x' }), educator))
      .toEqual({ esito: 'errore' })
  })
})

describe('puoAccedereFascicolo', () => {
  it('sezione dell’anno attivo: passa', async () => {
    expect((await puoAccedereFascicolo(conFunzione(VISIBILI), DOC, AL_ATTIVA)).consentito).toBe(true)
  })

  it('sezione in sola lettura di un anno passato: passa (è una lettura)', async () => {
    expect((await puoAccedereFascicolo(conFunzione(VISIBILI), DOC, AL_PASSATA)).consentito).toBe(true)
  })

  it('sezione dell’anno in preparazione: NON passa, nemmeno con l’assegnazione per materia', async () => {
    const r = await puoAccedereFascicolo(conFunzione(VISIBILI), DOC, AL_FUTURA)
    expect(r).toMatchObject({ consentito: false, motivo: 'negato' })
  })

  it('un guasto della funzione nega con motivo `errore`, come oggi', async () => {
    const r = await puoAccedereFascicolo(conFunzione(null, { code: '57014', message: 'x' }), DOC, AL_ATTIVA)
    expect(r).toMatchObject({ consentito: false, motivo: 'errore' })
  })

  // Giro di correzione 1: upload, delete e sostituisci SCRIVONO, quindi contano solo le sezioni dell'anno attivo.
  it.each(['upload', 'delete', 'sostituisci'] as const)('%s: sezione dell’anno attivo passa', async (azione) => {
    expect((await puoAccedereFascicolo(conFunzione(VISIBILI), DOC, AL_ATTIVA, azione)).consentito).toBe(true)
  })

  it.each(['upload', 'delete', 'sostituisci'] as const)('%s: sezione in sola lettura di un anno passato NON passa', async (azione) => {
    const r = await puoAccedereFascicolo(conFunzione(VISIBILI), DOC, AL_PASSATA, azione)
    expect(r).toMatchObject({ consentito: false, motivo: 'negato' })
  })

  it.each(['list', 'view', 'download'] as const)('%s (lettura): la sezione di un anno passato passa ancora', async (azione) => {
    expect((await puoAccedereFascicolo(conFunzione(VISIBILI), DOC, AL_PASSATA, azione)).consentito).toBe(true)
  })

  it('upload: un guasto della funzione nega con motivo `errore` (mai un sì per un guasto)', async () => {
    const r = await puoAccedereFascicolo(conFunzione(null, { code: '57014', message: 'x' }), DOC, AL_ATTIVA, 'upload')
    expect(r).toMatchObject({ consentito: false, motivo: 'errore' })
  })
})

describe('sezioniContitolari', () => {
  it('visibili sì (anche in sola lettura), future no', async () => {
    expect((await sezioniContitolari(conFunzione(VISIBILI), DOC)).sort()).toEqual([S_ATTIVA, S_PASSATA].sort())
  })

  it('un guasto della funzione dà l’elenco vuoto (fail-closed), come oggi', async () => {
    expect(await sezioniContitolari(conFunzione(null, { code: '57014', message: 'x' }), DOC)).toEqual([])
  })
})
