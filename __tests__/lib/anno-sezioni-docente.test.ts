import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * I docenti vedono le sezioni PER ANNO (PR 4.3, compito 4.3.6): l'elenco viene dalla funzione SQL
 * `sezioni_visibili_docente`, che esclude gli anni futuri e marca in sola lettura quelli passati.
 * Il ripiego sulla query di prima c'è SOLO per «funzione assente» (DB della CI non migrato).
 */

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { redact } from '@/lib/logging/redact'
import {
  sezioniDiUtente,
  sezioniVisibiliDiUtente,
  sezioniVisibiliConEsito,
  nomiSezioniDiUtente,
} from '@/lib/sezioni/docenti'
import { assertSezioneScrivibile } from '@/lib/auth/scope'

const DOCENTE = '33333333-3333-4333-8333-333333333333'
const S_ATTIVA = '55555555-5555-4555-8555-555555555552'
const S_PASSATA = '55555555-5555-4555-8555-555555555551'
const S_FUTURA = '55555555-5555-4555-8555-555555555553'
const SEDE = '22222222-2222-4222-8222-222222222222'

const RIGHE = [
  { section_id: S_ATTIVA, sola_lettura: false },
  { section_id: S_PASSATA, sola_lettura: true },
]

function db(): DBFinto {
  return {
    utenti_sezioni: [
      { utente_id: DOCENTE, section_id: S_ATTIVA },
      { utente_id: DOCENTE, section_id: S_PASSATA },
      { utente_id: DOCENTE, section_id: S_FUTURA },
    ],
    sections: [
      { id: S_ATTIVA, name: 'Girasoli', scuola_id: SEDE },
      { id: S_PASSATA, name: 'Girasoli', scuola_id: SEDE },
      { id: S_FUTURA, name: 'Farfalle', scuola_id: SEDE },
    ],
    utenti: [{ id: DOCENTE, scuola_id: SEDE, scuole_ids: [SEDE], role: 'educator' }],
  } as unknown as DBFinto
}

const conRpc = (rpc: (a: Record<string, unknown>) => { data: unknown; error: unknown }, d = db()): SupabaseClient =>
  creaFintoSupabase(d, [], { rpc: { sezioni_visibili_docente: rpc } as never })

beforeEach(() => logEvento.mockClear())

describe('sezioniVisibiliDiUtente', () => {
  it('restituisce le sezioni della funzione con solaLettura', async () => {
    const chiamate: unknown[] = []
    const sb = conRpc((a) => { chiamate.push(a); return { data: RIGHE, error: null } })
    const r = await sezioniVisibiliDiUtente(sb, DOCENTE)
    expect(chiamate).toEqual([{ p_utente: DOCENTE }])
    expect(r).toEqual([
      { sectionId: S_ATTIVA, solaLettura: false },
      { sectionId: S_PASSATA, solaLettura: true },
    ])
  })

  it('con soloScrivibili esclude quelle in sola lettura', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    expect(await sezioniVisibiliDiUtente(sb, DOCENTE, { soloScrivibili: true }))
      .toEqual([{ sectionId: S_ATTIVA, solaLettura: false }])
  })

  it.each(['42883', 'PGRST202'])('funzione assente (%s): ripiega sulle assegnate, nessuna in sola lettura, log info', async (code) => {
    const sb = conRpc(() => ({ data: null, error: { code, message: 'x' } }))
    const r = await sezioniVisibiliDiUtente(sb, DOCENTE)
    expect(r.map(x => x.sectionId).sort()).toEqual([S_PASSATA, S_ATTIVA, S_FUTURA].sort())
    expect(r.every(x => x.solaLettura === false)).toBe(true)
    const info = logEvento.mock.calls.filter(c => c[1] === 'info')
    expect(info).toHaveLength(1)
    expect(info[0][2]).toMatchObject({ esito: 'rpc-assente', error_code: code })
    // la riga arriva leggibile dalla redazione vera
    expect(redact(info[0][2])).toMatchObject({ esito: 'rpc-assente', error_code: code })
  })

  it('un altro errore della funzione NON ripiega: lista vuota e log error', async () => {
    const sb = conRpc(() => ({ data: null, error: { code: '57014', message: 'x' } }))
    expect(await sezioniVisibiliDiUtente(sb, DOCENTE)).toEqual([])
    expect(logEvento.mock.calls.some(c => c[1] === 'error')).toBe(true)
  })
})

describe('sezioniDiUtente / nomiSezioniDiUtente', () => {
  it('sezioniDiUtente restituisce gli id visibili (anche in sola lettura)', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    expect(await sezioniDiUtente(sb, DOCENTE)).toEqual([S_ATTIVA, S_PASSATA])
  })

  it('i nomi sono solo quelli delle sezioni visibili (la futura non esce)', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    expect(await nomiSezioniDiUtente(sb, DOCENTE)).toEqual(['Girasoli'])
  })
})

describe('sezioniVisibiliConEsito', () => {
  it('ok con le sezioni', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    expect(await sezioniVisibiliConEsito(sb, DOCENTE)).toEqual({
      ok: true,
      sezioni: [{ sectionId: S_ATTIVA, solaLettura: false }, { sectionId: S_PASSATA, solaLettura: true }],
    })
  })

  it('funzione assente: ripiego ok, log info', async () => {
    const sb = conRpc(() => ({ data: null, error: { code: '42883', message: 'x' } }))
    const r = await sezioniVisibiliConEsito(sb, DOCENTE)
    expect(r.ok && r.sezioni).toHaveLength(3)
    expect(logEvento.mock.calls.filter(c => c[1] === 'info')).toHaveLength(1)
  })

  it('un altro errore PROPAGA il guasto: ok false e riga error', async () => {
    const sb = conRpc(() => ({ data: null, error: { code: '57014', message: 'x' } }))
    expect(await sezioniVisibiliConEsito(sb, DOCENTE)).toEqual({ ok: false })
    expect(logEvento.mock.calls.some(c => c[1] === 'error')).toBe(true)
  })

  it('ripiego con la query di prima rotta: ok false', async () => {
    const sb = creaFintoSupabase(db(), [], {
      rpc: { sezioni_visibili_docente: () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) } as never,
      errori: { utenti_sezioni: { code: '57014', message: 'timeout' } } as never,
    })
    expect(await sezioniVisibiliConEsito(sb, DOCENTE)).toEqual({ ok: false })
  })
})

describe('assertSezioneScrivibile', () => {
  const docente = { id: DOCENTE, role: 'educator', scuola_id: SEDE, scuole_ids: [SEDE] } as never
  const segreteria = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'segreteria', scuola_id: SEDE, scuole_ids: [SEDE] } as never

  it('sezione in sola lettura: 403 SEZIONE_SOLA_LETTURA', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    const res = await assertSezioneScrivibile(sb, docente, S_PASSATA)
    expect(res?.status).toBe(403)
    expect(await res!.json()).toMatchObject({ codice: 'SEZIONE_SOLA_LETTURA' })
  })

  it('sezione dell’anno attivo: passa', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    expect(await assertSezioneScrivibile(sb, docente, S_ATTIVA)).toBeNull()
  })

  it('sezione futura: 403 come non assegnata', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    const res = await assertSezioneScrivibile(sb, docente, S_FUTURA)
    expect(res?.status).toBe(403)
    expect(await res!.json()).not.toMatchObject({ codice: 'SEZIONE_SOLA_LETTURA' })
  })

  it('segreteria: mai sola lettura qui', async () => {
    const sb = conRpc(() => ({ data: RIGHE, error: null }))
    expect(await assertSezioneScrivibile(sb, segreteria, S_PASSATA)).toBeNull()
  })
})
