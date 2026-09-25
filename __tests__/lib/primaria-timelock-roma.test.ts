import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// IL TERMINE DELLA PRIMARIA SI CONTA NELLA DATA DI ROMA.
//
// Prima: `new Date(eventDate + 'T00:00:00')` e `new Date()` nel fuso del SERVER
// (Vercel = UTC), con `Math.floor(ms / 86_400_000)`. Fra mezzanotte e l'una (le
// due in ora legale) a Roma è già il giorno dopo, ma per il server no: il
// termine scadeva un giorno più tardi. E sul cambio d'ora un giorno di 23 o 25
// ore spostava il conto di uno anche di giorno.
//
// Ogni caso qui sotto ha un ISTANTE fissato (mai «oggi»): un test che dipende dal
// calendario scade da solo.
// =============================================================================

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

import {
  calcolaScadenza,
  dataRomaDi,
  getDeadlines,
  giorniFraDate,
  isOltreScadenza,
  leggiTermini,
} from '@/lib/primaria/timelock'

const TZ_ORIGINALE = process.env.TZ
function impostaTZ(tz: string | undefined) {
  if (tz === undefined) delete process.env.TZ
  else process.env.TZ = tz
}

beforeEach(() => {
  h.logEvento.mockReset()
})
afterEach(() => {
  impostaTZ(TZ_ORIGINALE)
})

describe('dataRomaDi — il giorno che vede Roma, non il server', () => {
  it('00:30 di Roma in ora LEGALE (UTC+2) è già il giorno dopo, anche se in UTC no', () => {
    expect(dataRomaDi(new Date('2026-07-09T22:30:00Z'))).toBe('2026-07-10')
  })
  it('00:30 di Roma in ora SOLARE (UTC+1)', () => {
    expect(dataRomaDi(new Date('2026-01-14T23:30:00Z'))).toBe('2026-01-15')
  })
  it('23:30 di Roma resta quel giorno', () => {
    expect(dataRomaDi(new Date('2026-07-10T21:30:00Z'))).toBe('2026-07-10')
  })
  it('accetta anche la stringa ISO di `creato_il`', () => {
    expect(dataRomaDi('2026-03-29T22:30:00+00:00')).toBe('2026-03-30')
  })
})

describe('giorniFraDate — aritmetica di calendario, senza ore', () => {
  it('attraverso il passaggio all’ora LEGALE (29/03/2026, giorno di 23 ore)', () => {
    expect(giorniFraDate('2026-03-28', '2026-03-30')).toBe(2)
  })
  it('attraverso il ritorno all’ora SOLARE (25/10/2026, giorno di 25 ore)', () => {
    expect(giorniFraDate('2026-10-24', '2026-10-26')).toBe(2)
  })
  it('una data illeggibile non è un numero', () => {
    expect(Number.isNaN(giorniFraDate('07/09/2026', '2026-09-10'))).toBe(true)
  })
})

describe('calcolaScadenza — il termine in data di Roma', () => {
  // I casi in cui la regola VECCHIA dava la risposta sbagliata, in qualunque fuso
  // del server (UTC o Roma): tutti e tre sono «bloccato» solo contando il giorno
  // di Roma.
  it('ora LEGALE: lezione del 07/07, adesso 00:30 del 10/07 a Roma → 3 giorni, BLOCCATA', () => {
    const r = calcolaScadenza('2026-07-07', 2, new Date('2026-07-09T22:30:00Z'))
    expect(r).toEqual({ locked: true, giorniLimite: 2, giorniTrascorsi: 3 })
  })

  it('ora SOLARE: lezione del 12/01, adesso 00:30 del 15/01 a Roma → BLOCCATA', () => {
    const r = calcolaScadenza('2026-01-12', 2, new Date('2026-01-14T23:30:00Z'))
    expect(r.locked).toBe(true)
    expect(r.giorniTrascorsi).toBe(3)
  })

  it('notte del passaggio all’ora LEGALE: lezione del 27/03, adesso 00:30 del 30/03 a Roma → BLOCCATA', () => {
    const r = calcolaScadenza('2026-03-27', 2, new Date('2026-03-29T22:30:00Z'))
    expect(r.locked).toBe(true)
  })

  it('notte del ritorno all’ora SOLARE: lezione del 25/10, adesso 00:30 del 28/10 a Roma → BLOCCATA', () => {
    const r = calcolaScadenza('2026-10-25', 2, new Date('2026-10-27T23:30:00Z'))
    expect(r.locked).toBe(true)
    expect(r.giorniTrascorsi).toBe(3)
  })

  it('il giorno del termine è ancora buono: lezione del 07/07, adesso 23:59 del 09/07 a Roma', () => {
    const r = calcolaScadenza('2026-07-07', 2, new Date('2026-07-09T21:59:00Z'))
    expect(r).toEqual({ locked: false, giorniLimite: 2, giorniTrascorsi: 2 })
  })

  it('15 giorni per le prove scritte/pratiche', () => {
    expect(calcolaScadenza('2026-09-01', 15, new Date('2026-09-16T10:00:00Z')).locked).toBe(false)
    expect(calcolaScadenza('2026-09-01', 15, new Date('2026-09-16T22:30:00Z')).locked).toBe(true)
  })

  it('una data futura non è bloccata', () => {
    expect(calcolaScadenza('2026-09-30', 2, new Date('2026-09-25T10:00:00Z')).locked).toBe(false)
  })

  it('una data illeggibile è BLOCCATA (fail-closed)', () => {
    expect(calcolaScadenza('non-una-data', 2, new Date('2026-09-25T10:00:00Z')).locked).toBe(true)
  })

  it.each(['UTC', 'Europe/Rome', 'America/New_York', 'Asia/Tokyo'])(
    'il risultato NON dipende dal fuso del processo (%s)',
    (tz) => {
      impostaTZ(tz)
      const r = calcolaScadenza('2026-07-07', 2, new Date('2026-07-09T22:30:00Z'))
      expect(r.giorniTrascorsi).toBe(3)
      expect(r.locked).toBe(true)
    },
  )
})

describe('isOltreScadenza / leggiTermini — i termini della sede', () => {
  const db = (): DBFinto => ({
    admin_settings: [
      { scuola_id: SEDE_A, timelock_giorni_classe_orale: 5, timelock_giorni_scritto_pratico: 20 },
    ],
  })

  it('legge i valori della SEDE (non quelli predefiniti) e conta nel giorno di Roma', async () => {
    const supabase = creaFintoSupabase(db(), []) as unknown as SupabaseClient
    const adesso = new Date('2026-07-12T22:30:00Z') // 00:30 del 13/07 a Roma
    // 07/07 → 13/07 = 6 giorni > 5
    expect((await isOltreScadenza(supabase, SEDE_A, '2026-07-07', 'classe_orale', adesso)).locked).toBe(true)
    // 08/07 → 13/07 = 5 giorni: ancora buono con il limite della sede
    const buono = await isOltreScadenza(supabase, SEDE_A, '2026-07-08', 'classe_orale', adesso)
    expect(buono).toEqual({ locked: false, giorniLimite: 5, giorniTrascorsi: 5 })
    expect((await isOltreScadenza(supabase, SEDE_A, '2026-07-08', 'scritto_pratico', adesso)).giorniLimite).toBe(20)
  })

  it('una sede senza impostazioni usa i predefiniti (2 / 15)', async () => {
    const supabase = creaFintoSupabase(db(), []) as unknown as SupabaseClient
    const letti = await leggiTermini(supabase, SEDE_B)
    expect(letti).toEqual({ ok: true, termini: { classeOrale: 2, scrittoPratico: 15 } })
  })

  it('un guasto di lettura TORNA al chiamante (leggiTermini) invece di sparire', async () => {
    const supabase = creaFintoSupabase(db(), [], {
      errori: { admin_settings: { code: '57014', message: 'canceling statement due to statement timeout' } },
    }) as unknown as SupabaseClient
    const letti = await leggiTermini(supabase, SEDE_A)
    expect(letti.ok).toBe(false)
  })

  it('getDeadlines ripiega sui predefiniti ma LOGGA il guasto a livello error', async () => {
    const supabase = creaFintoSupabase(db(), [], {
      errori: { admin_settings: { code: '57014', message: 'timeout' } },
    }) as unknown as SupabaseClient
    expect(await getDeadlines(supabase, SEDE_A)).toEqual({ classeOrale: 2, scrittoPratico: 15 })
    expect(h.logEvento).toHaveBeenCalledWith(
      'registro',
      'error',
      expect.objectContaining({ esito: 'termini-non-letti-ripiego-predefiniti' }),
      expect.anything(),
    )
  })
})
