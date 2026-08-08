/**
 * Q5 — «SCRIVERE IL MOTIVO AZZERA LA PRESA VISIONE», in un posto solo.
 *
 * Le porte che scrivono `presenze.giustificazione_testo` sono due:
 *   · `parent/presenze/comunica-assenza:POST` — l'assenza annunciata in anticipo;
 *   · `parent/presenze/giustifica:POST`       — la giustifica firmata a posteriori.
 *
 * Solo la seconda sapeva che cambiare il testo invalida la lettura che il
 * docente ne aveva fatto, e lo dichiarava in un commento («Una nuova giustifica
 * azzera l'eventuale presa visione precedente»). La prima non nominava
 * `giust_vista_il` in nessuno dei suoi due payload — e PostgREST aggiorna SOLO
 * le colonne nominate, quindi la colonna sopravviveva a ogni ricomunicazione: la
 * riga risultava «presa in visione» mentre il testo che il docente aveva letto
 * era stato sostituito.
 *
 * È la stessa forma del rilievo M14, risolto per il TETTO dei caratteri
 * (`limiti-testo.ts`) e non per questa regola: «una regola valida per due strade
 * deve vivere in un posto solo».
 *
 * ─── LA DECISIONE, MOTIVATA ─────────────────────────────────────────────────
 * Azzerare è GIUSTO: la presa visione è la lettura di UN testo, e il testo è
 * cambiato — un docente che ha letto «visita di controllo» non ha letto «febbre
 * alta da tre giorni». Ma si azzera SOLO quando il testo cambia davvero: una
 * ricomunicazione a motivo invariato non deve far perdere al docente una presa
 * visione legittima.
 */
import { describe, it, expect } from 'vitest'
import {
  azzeramentoPresaVisione,
  presaVisioneRevocata,
  testoCambiato,
} from '@/lib/presenze/presa-visione'

describe('testoCambiato', () => {
  it('testo diverso → cambiato', () => {
    expect(testoCambiato('visita di controllo', 'febbre')).toBe(true)
  })

  it('stesso testo → NON cambiato (la presa visione del docente resta valida)', () => {
    expect(testoCambiato('febbre', 'febbre')).toBe(false)
  })

  it('`undefined` = la colonna non viene nominata nella scrittura → non cambia', () => {
    // È il caso del motivo VUOTO su `comunica-assenza`: la colonna non entra nel
    // payload dell'UPDATE proprio per non cancellare il testo archiviato. Se
    // niente si scrive, niente si invalida.
    expect(testoCambiato('febbre', undefined)).toBe(false)
  })

  it('da nulla a un testo → cambiato; da nulla a nulla → no', () => {
    expect(testoCambiato(null, 'febbre')).toBe(true)
    expect(testoCambiato(null, null)).toBe(false)
    expect(testoCambiato('', null)).toBe(false)
  })
})

describe('azzeramentoPresaVisione', () => {
  it('testo cambiato → le DUE colonne, insieme', () => {
    // `giust_vista_il` senza `giust_vista_da` lascerebbe l'identificativo di un
    // docente appeso a una lettura che non risulta più avvenuta.
    expect(azzeramentoPresaVisione('a', 'b')).toEqual({ giust_vista_il: null, giust_vista_da: null })
  })

  it('testo invariato → nessuna colonna (il payload non la nomina affatto)', () => {
    expect(azzeramentoPresaVisione('a', 'a')).toEqual({})
    expect(azzeramentoPresaVisione('a', undefined)).toEqual({})
  })
})

describe('presaVisioneRevocata', () => {
  it('c’era una presa visione e il testo cambia → si sta togliendo qualcosa a qualcuno', () => {
    expect(presaVisioneRevocata({ giustificazione_testo: 'a', giust_vista_il: '2026-08-08T09:00:00Z' }, 'b')).toBe(true)
  })

  it('nessuna presa visione da togliere → non c’è niente da riavvisare', () => {
    expect(presaVisioneRevocata({ giustificazione_testo: 'a', giust_vista_il: null }, 'b')).toBe(false)
  })

  it('testo invariato → la presa visione resta, quindi non è revocata', () => {
    expect(presaVisioneRevocata({ giustificazione_testo: 'a', giust_vista_il: '2026-08-08T09:00:00Z' }, 'a')).toBe(false)
  })

  it('riga inesistente (INSERT) → niente da revocare', () => {
    expect(presaVisioneRevocata(null, 'b')).toBe(false)
  })
})
