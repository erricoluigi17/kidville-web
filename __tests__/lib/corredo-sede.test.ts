import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// W4-A — Il CORREDO MINIMO di una sede: che cosa deve esserci perché una sede
// «nasca pronta», e che cosa resta a un umano.
//
// Il difetto (R123): `provisiona_sede` preparava quattro cose — `schools`,
// `scuole`, `admin_settings` e i legami della Direzione — e si fermava lì.
// Kidville Aversa e Kidville Cesa sono nate il 2026-07-29 senza scala dei
// giudizi, senza titolario dei protocolli e (Cesa, che ha 5 classi di primaria)
// senza una sola disciplina. Nessun errore da nessuna parte: la sede SEMBRA
// pronta, e chi la apre trova elenchi vuoti.
//
// Qui si prova il lato TypeScript — quello che gira sul DB E2E, dove la RPC non
// esiste. Non si asserisce «non ha risposto 500»: si guarda che cosa è finito
// DAVVERO nel database finto, tabella per tabella.
// =============================================================================

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
}))

vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import {
  DEFAULT_GIUDIZI_SCALA,
  TITOLARIO_DEFAULT,
  VOCI_CHECKLIST,
  checklistSede,
  provisionaCorredoFallback,
} from '@/lib/scuole/corredo-sede'

let db: DBFinto
let scritture: Scrittura[]

beforeEach(() => {
  vi.clearAllMocks()
  db = { admin_settings: [], giudizi_sintetici_scala: [], protocolli_categorie: [] }
  scritture = []
})

const client = (errori: Record<string, { code: string; message?: string }> = {}) =>
  creaFintoSupabase(db, [], { scritture, errori })

describe('il default del corredo', () => {
  it('la scala dei giudizi ha 6 voci, ordinate 1→6 e decrescenti di valore', () => {
    expect(DEFAULT_GIUDIZI_SCALA.map((g) => g.ordine)).toEqual([1, 2, 3, 4, 5, 6])
    const valori = DEFAULT_GIUDIZI_SCALA.map((g) => g.valore_numerico)
    expect(valori).toEqual([...valori].sort((a, b) => b - a))
    // Le etichette sono la CHIAVE (UNIQUE (scuola_id, etichetta)): due uguali
    // farebbero fallire l'INSERT dell'intero corredo.
    expect(new Set(DEFAULT_GIUDIZI_SCALA.map((g) => g.etichetta)).size).toBe(6)
  })

  it('il titolario ha 7 voci distinte', () => {
    expect(TITOLARIO_DEFAULT).toHaveLength(7)
    expect(new Set(TITOLARIO_DEFAULT).size).toBe(7)
  })
})

describe('provisionaCorredoFallback — il ramo senza RPC (DB E2E)', () => {
  it('scrive DAVVERO le tre tabelle del corredo, tutte con lo scuola_id della sede', async () => {
    const fatti = await provisionaCorredoFallback(client(), SEDE_A, 'test:POST')

    expect(db.admin_settings).toHaveLength(1)
    expect(db.admin_settings[0].scuola_id).toBe(SEDE_A)
    expect(
      (db.admin_settings[0].funzioni_matrice as Record<string, Record<string, boolean>>).primaria
        .registro,
    ).toBe(true)

    expect(db.giudizi_sintetici_scala).toHaveLength(6)
    expect(db.giudizi_sintetici_scala.map((r) => r.etichetta)).toEqual(
      DEFAULT_GIUDIZI_SCALA.map((g) => g.etichetta),
    )
    expect(new Set(db.giudizi_sintetici_scala.map((r) => r.scuola_id))).toEqual(new Set([SEDE_A]))

    expect(db.protocolli_categorie).toHaveLength(7)
    expect(db.protocolli_categorie.map((r) => r.nome)).toEqual([...TITOLARIO_DEFAULT])
    expect(db.protocolli_categorie.map((r) => r.ordine)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(new Set(db.protocolli_categorie.map((r) => r.scuola_id))).toEqual(new Set([SEDE_A]))

    expect([...fatti].sort()).toEqual(['giudizi', 'registro', 'titolario'])
  })

  it('nessuna scrittura del corredo finisce su una sede diversa da quella richiesta', async () => {
    await provisionaCorredoFallback(client(), SEDE_A, 'test:POST')
    const sedi = scritture.flatMap((s) => s.colpite.map((r) => r.scuola_id))
    expect(sedi.length).toBeGreaterThan(0)
    expect(new Set(sedi)).toEqual(new Set([SEDE_A]))
  })

  it('ogni pezzo creato è un evento loggato a info (successo, non solo errori)', async () => {
    await provisionaCorredoFallback(client(), SEDE_A, 'test:POST')
    for (const esito of ['admin-settings-creato', 'giudizi-creato', 'titolario-creato']) {
      expect(h.logEvento).toHaveBeenCalledWith(
        'multi_sede',
        'info',
        expect.objectContaining({ operazione: 'test:POST', esito, sede_id: SEDE_A }),
      )
    }
  })

  it.each(['PGRST204', '42703', 'PGRST205', '42P01'])(
    'DB non migrato (%s) → il pezzo manca, si dice a info e il resto del corredo si crea comunque',
    async (code) => {
      const fatti = await provisionaCorredoFallback(
        client({ giudizi_sintetici_scala: { code, message: 'tabella assente' } }),
        SEDE_A,
        'test:POST',
      )
      expect(db.giudizi_sintetici_scala).toHaveLength(0)
      // Il resto del corredo NON si ferma al primo buco.
      expect(db.admin_settings).toHaveLength(1)
      expect(db.protocolli_categorie).toHaveLength(7)
      expect(fatti.has('giudizi')).toBe(false)
      expect(fatti.has('titolario')).toBe(true)
      expect(h.logEvento).toHaveBeenCalledWith(
        'multi_sede',
        'info',
        expect.objectContaining({ esito: 'giudizi-non-disponibile', sede_id: SEDE_A }),
        expect.anything(),
      )
    },
  )

  it('errore VERO → livello error (configurazione mancante è un incidente, AGENTS.md §4)', async () => {
    const fatti = await provisionaCorredoFallback(
      client({ protocolli_categorie: { code: '23503', message: 'violates foreign key' } }),
      SEDE_A,
      'test:POST',
    )
    expect(db.protocolli_categorie).toHaveLength(0)
    expect(fatti.has('titolario')).toBe(false)
    expect(h.logEvento).toHaveBeenCalledWith(
      'multi_sede',
      'error',
      expect.objectContaining({ esito: 'titolario-fallito', sede_id: SEDE_A }),
      expect.anything(),
    )
  })
})

describe('checklistSede — che cosa resta a un umano', () => {
  it('le voci automatiche risultano fatte solo se il provisioning le ha davvero create', () => {
    const tutte = checklistSede(new Set(['registro', 'giudizi', 'titolario']))
    const stato = Object.fromEntries(tutte.map((v) => [v.chiave, v.stato]))
    expect(stato.registro).toBe('fatto')
    expect(stato.giudizi).toBe('fatto')
    expect(stato.titolario).toBe('fatto')

    const parziale = checklistSede(new Set(['registro']))
    const statoParziale = Object.fromEntries(parziale.map((v) => [v.chiave, v.stato]))
    expect(statoParziale.registro).toBe('fatto')
    expect(statoParziale.giudizi).toBe('da_fare')
  })

  it('le voci umane restano SEMPRE da fare: nessun dato fiscale si inventa', () => {
    // Il perimetro chiuso del piano, punto 9: «niente dati inventati nella
    // config fiscale». Una sede nuova non ha né P.IVA né PEC né menu di mensa,
    // e la risposta del POST deve dirlo invece di lasciarlo scoprire alla prima
    // ricevuta senza intestazione.
    const tutte = checklistSede(new Set(['registro', 'giudizi', 'titolario']))
    const umane = tutte.filter((v) => v.manuale)
    expect(umane.map((v) => v.chiave).sort()).toEqual([
      'anagrafica',
      'fiscale',
      'mensa',
      'scrutinio_periodi',
      'sezioni',
    ])
    expect(umane.every((v) => v.stato === 'da_fare')).toBe(true)
    // Ogni voce dice DOVE si compila: una checklist senza il percorso è un elenco di rimproveri.
    expect(umane.every((v) => v.dove.length > 0 && v.etichetta.length > 0)).toBe(true)
  })

  it('le chiavi della checklist sono stabili e senza duplicati', () => {
    const chiavi = VOCI_CHECKLIST.map((v) => v.chiave)
    expect(new Set(chiavi).size).toBe(chiavi.length)
    expect(checklistSede(new Set()).map((v) => v.chiave)).toEqual(chiavi)
  })
})
