// @vitest-environment node
/**
 * Le due regole degli avvisi per le docenti, decise col titolare il 2026-10-07.
 *
 *   VEDE      — segreteria/direzione tutto; la docente gli avvisi per tutta la
 *               sede, quelli di almeno UNA delle sue classi (nella stessa sede) e
 *               quelli scritti da lei.
 *   MODIFICA  — segreteria/direzione tutto; la docente SOLO i propri.
 *
 * Il caso che ha aperto il lavoro: un avviso della segreteria per due classi
 * compariva nella bacheca di OGNI docente del plesso. Le famiglie giuste lo
 * ricevevano — il guasto era il ramo staff, che filtrava solo per sede.
 *
 * Funzioni pure, nessun mock: se la regola cambia, questo file diventa rosso.
 */
import { describe, it, expect } from 'vitest'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import {
  avvisoVisibileAlDocente,
  puoGestireAvviso,
  RUOLI_GESTIONE_AVVISI,
} from '@/lib/avvisi/permessi-docente'

const SEDE_A = 'sede-a'
const SEDE_B = 'sede-b'

const docente = { uid: 'edu-1', sezioni: [{ nome: 'Girasoli', scuola_id: SEDE_A }] }

describe('avvisoVisibileAlDocente', () => {
  it('vede un avviso per tutta la sede', () => {
    expect(avvisoVisibileAlDocente(
      { author_id: 'seg-1', target_scope: 'globale', target_classes: null, scuola_id: SEDE_A },
      docente,
    )).toBe(true)
  })

  it('vede un avviso di due classi se UNA è sua', () => {
    expect(avvisoVisibileAlDocente(
      { author_id: 'seg-1', target_scope: 'classe', target_classes: ['Girasoli', 'Tulipani'], scuola_id: SEDE_A },
      docente,
    )).toBe(true)
  })

  it('NON vede un avviso di due classi altrui — il caso segnalato dalla scuola', () => {
    expect(avvisoVisibileAlDocente(
      { author_id: 'seg-1', target_scope: 'classe', target_classes: ['Tulipani', 'Papaveri'], scuola_id: SEDE_A },
      docente,
    )).toBe(false)
  })

  it('NON vede la classe omonima di un ALTRO plesso', () => {
    // «Girasoli» esiste anche nella sede B: il nome non basta, conta la coppia.
    expect(avvisoVisibileAlDocente(
      { author_id: 'seg-2', target_scope: 'classe', target_classes: ['Girasoli'], scuola_id: SEDE_B },
      docente,
    )).toBe(false)
  })

  it('vede sempre ciò che ha scritto lei, anche se la classe non è più sua', () => {
    expect(avvisoVisibileAlDocente(
      { author_id: 'edu-1', target_scope: 'classe', target_classes: ['Papaveri'], scuola_id: SEDE_A },
      docente,
    )).toBe(true)
  })

  it('senza sezioni assegnate vede solo i globali e i propri (fail-closed)', () => {
    const senzaSezioni = { uid: 'edu-1', sezioni: [] }
    expect(avvisoVisibileAlDocente(
      { author_id: 'seg-1', target_scope: 'classe', target_classes: ['Girasoli'], scuola_id: SEDE_A },
      senzaSezioni,
    )).toBe(false)
    expect(avvisoVisibileAlDocente(
      { author_id: 'seg-1', target_scope: 'globale', target_classes: null, scuola_id: SEDE_A },
      senzaSezioni,
    )).toBe(true)
  })

  it('un avviso di classe senza sede non si attribuisce a nessuna classe', () => {
    expect(avvisoVisibileAlDocente(
      { author_id: 'seg-1', target_scope: 'classe', target_classes: ['Girasoli'], scuola_id: null },
      docente,
    )).toBe(false)
  })
})

describe('puoGestireAvviso', () => {
  const educator: AppUser = { id: 'edu-1', role: 'educator' }

  it.each(['admin', 'coordinator', 'segreteria'] as const)(
    '%s modifica anche gli avvisi altrui',
    (ruolo) => {
      const u: AppUser = { id: `${ruolo}-1`, role: ruolo }
      expect(puoGestireAvviso(u, 'edu-9')).toBe(true)
    },
  )

  it('la docente modifica il PROPRIO avviso', () => {
    expect(puoGestireAvviso(educator, 'edu-1')).toBe(true)
  })

  it('la docente NON modifica un avviso della segreteria né di una collega', () => {
    expect(puoGestireAvviso(educator, 'seg-1')).toBe(false)
    expect(puoGestireAvviso(educator, 'edu-2')).toBe(false)
  })

  it('autore ignoto ⇒ la docente non modifica (fail-closed)', () => {
    expect(puoGestireAvviso(educator, null)).toBe(false)
    expect(puoGestireAvviso(educator, undefined)).toBe(false)
  })

  it('decide sui ruoli REALI: la docente in veste di genitore non diventa gestione', () => {
    const inVesteGenitore: AppUser = { id: 'edu-1', role: 'genitore', ruoli: ['educator', 'genitore'] }
    expect(puoGestireAvviso(inVesteGenitore, 'seg-1')).toBe(false)
    expect(puoGestireAvviso(inVesteGenitore, 'edu-1')).toBe(true)
  })

  it('il gruppo di gestione è esattamente admin, coordinator, segreteria', () => {
    expect([...RUOLI_GESTIONE_AVVISI].sort()).toEqual(['admin', 'coordinator', 'segreteria'])
  })
})
