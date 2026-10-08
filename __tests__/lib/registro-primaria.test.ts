import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import {
  TABELLE_REGISTRO_PRIMARIA,
  alunniConRegistroPrimaria,
  leggiRegistroPrimaria,
} from '@/lib/alunni/registro-primaria'

// Solo uuid inventati: il repository è pubblico.
const CON_VOTO = '10000000-0000-4000-8000-000000000001'
const CON_NOTA = '10000000-0000-4000-8000-000000000002'
const PULITO = '10000000-0000-4000-8000-000000000003'

function db(): DBFinto {
  return {
    valutazioni: [{ id: 'v-1', alunno_id: CON_VOTO }],
    pagelle: [],
    scrutinio_giudizi: [],
    scrutinio_comportamento: [],
    note_disciplinari: [{ id: 'n-1', alunno_id: CON_NOTA }],
    certificati_competenze: [],
  }
}

describe('registro della primaria', () => {
  it('l’elenco delle tabelle è quello deciso dal titolare, e non cambia per distrazione', () => {
    expect([...TABELLE_REGISTRO_PRIMARIA]).toEqual([
      'valutazioni',
      'pagelle',
      'scrutinio_giudizi',
      'scrutinio_comportamento',
      'note_disciplinari',
      'certificati_competenze',
    ])
  })

  it('un voto basta a rendere presente il registro', async () => {
    const esito = await leggiRegistroPrimaria(creaFintoSupabase(db()) as never, CON_VOTO)
    expect(esito).toEqual({ ok: true, presente: true })
  })

  it('senza righe nelle sei tabelle il registro è assente', async () => {
    const esito = await leggiRegistroPrimaria(creaFintoSupabase(db()) as never, PULITO)
    expect(esito).toEqual({ ok: true, presente: false })
  })

  it('una tabella assente dallo schema (DB E2E non migrato) vale «nessuna riga», non un guasto', async () => {
    // Il finto pretende che la tabella con l'errore iniettato esista in `db`
    // (anche vuota): l'assenza vera la simula il codice 42P01.
    const supabase = creaFintoSupabase(db(), [], {
      errori: { scrutinio_giudizi: { code: '42P01', message: 'relation does not exist' } },
    })
    const esito = await leggiRegistroPrimaria(supabase as never, PULITO)
    expect(esito).toEqual({ ok: true, presente: false })
  })

  it('una lettura FALLITA non è mai «assente»', async () => {
    const supabase = creaFintoSupabase(db(), [], {
      errori: { pagelle: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    const esito = await leggiRegistroPrimaria(supabase as never, PULITO)
    expect(esito.ok).toBe(false)
  })

  it('in blocco restituisce SOLO gli alunni con registro', async () => {
    const esito = await alunniConRegistroPrimaria(creaFintoSupabase(db()) as never, [CON_VOTO, CON_NOTA, PULITO])
    expect(esito.ok).toBe(true)
    if (esito.ok) expect([...esito.conRegistro].sort()).toEqual([CON_VOTO, CON_NOTA].sort())
  })

  it('in blocco con lista vuota non legge niente e risponde vuoto', async () => {
    const esito = await alunniConRegistroPrimaria(creaFintoSupabase({}) as never, [])
    expect(esito).toEqual({ ok: true, conRegistro: new Set() })
  })
})
