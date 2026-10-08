import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import {
  TABELLE_REGISTRO_PRIMARIA,
  alunniConRegistroPrimaria,
  leggiRegistroPrimaria,
} from '@/lib/alunni/registro-primaria'

const { logEvento } = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento }))

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
  beforeEach(() => logEvento.mockClear())

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

  it('una tabella assente dallo schema (DB E2E non migrato) vale «nessuna riga», si CONTINUA e si logga', async () => {
    // Il finto pretende che la tabella con l'errore iniettato esista in `db`
    // (anche vuota): l'assenza vera la simula il codice 42P01.
    // note_disciplinari viene DOPO scrutinio_giudizi: se il ciclo si fermasse
    // alla tabella assente, CON_NOTA risulterebbe senza registro.
    const supabase = creaFintoSupabase(db(), [], {
      errori: { scrutinio_giudizi: { code: '42P01', message: 'relation does not exist' } },
    })
    expect(await leggiRegistroPrimaria(supabase as never, CON_NOTA)).toEqual({ ok: true, presente: true })
    expect(await leggiRegistroPrimaria(supabase as never, PULITO)).toEqual({ ok: true, presente: false })
    expect(logEvento).toHaveBeenCalledWith('db', 'warn', {
      operazione: 'registro-primaria',
      esito: 'tabella-assente-trattata-come-vuota',
      tipo: 'scrutinio_giudizi',
    })
  })

  it('una colonna assente (42703) NON è una tabella assente: è un guasto', async () => {
    const supabase = creaFintoSupabase(db(), [], {
      errori: { pagelle: { code: '42703', message: 'column does not exist' } },
    })
    expect((await leggiRegistroPrimaria(supabase as never, PULITO)).ok).toBe(false)
  })

  it('una risposta senza righe e senza errore (HEAD/404 del gateway) è un guasto, non «assente»', async () => {
    const vero = creaFintoSupabase(db()) as unknown as { from: (t: string) => unknown }
    const supabase = {
      from: (t: string) =>
        t === 'pagelle'
          ? { select: () => ({ eq: () => ({ limit: async () => ({ data: null, error: null }) }) }) }
          : vero.from(t),
    }
    expect((await leggiRegistroPrimaria(supabase as never, PULITO)).ok).toBe(false)
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

  it('in blocco un guasto di lettura si PROPAGA: non diventa «senza registro»', async () => {
    const supabase = creaFintoSupabase(db(), [], {
      errori: { pagelle: { code: '57014', message: 'timeout' } },
    })
    const esito = await alunniConRegistroPrimaria(supabase as never, [CON_VOTO, PULITO])
    expect(esito.ok).toBe(false)
  })

  it('le sei letture di un alunno partono INSIEME, non una dopo l’altra', async () => {
    // Su un elenco di candidati sono sei andate e ritorno per bambino: in fila,
    // il tempo dell'elenco è la SOMMA delle sei; in parallelo è la più lenta.
    const partite: string[] = []
    const sblocca: (() => void)[] = []
    const supabase = {
      from: (t: string) => ({
        select: () => ({
          eq: () => ({
            limit: () => {
              partite.push(t)
              return new Promise((ok) => sblocca.push(() => ok({ data: [], error: null })))
            },
          }),
        }),
      }),
    }
    const esito = leggiRegistroPrimaria(supabase as never, PULITO)
    await new Promise((r) => setTimeout(r, 0))
    expect(partite.sort()).toEqual([...TABELLE_REGISTRO_PRIMARIA].sort())
    for (const s of sblocca) s()
    expect(await esito).toEqual({ ok: true, presente: false })
  })

  it('in parallelo resta la regola: una riga in una tabella qualsiasi basta, anche se è l’ultima', async () => {
    const supabase = creaFintoSupabase({ ...db(), certificati_competenze: [{ id: 'c-1', alunno_id: PULITO }] })
    expect(await leggiRegistroPrimaria(supabase as never, PULITO)).toEqual({ ok: true, presente: true })
  })

  it('in blocco con lista vuota non legge niente e risponde vuoto', async () => {
    const lette: string[] = []
    const esito = await alunniConRegistroPrimaria(creaFintoSupabase({}, lette) as never, [])
    expect(esito).toEqual({ ok: true, conRegistro: new Set() })
    expect(lette).toEqual([])
  })
})
