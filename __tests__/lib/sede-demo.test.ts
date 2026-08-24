// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isScuolaE2E, isUtenteCollaudo } from '@/lib/scuole/reali'
import {
  SEDE_A,
  SEDE_DEMO,
  SEDE_E2E,
  SEDE_E2E_DUE,
  NOME_SEDE_A,
  NOME_SEDE_DEMO,
} from '../fixtures/sedi'

/**
 * La sede che ospita TUTTI i dati di collaudo in produzione, dal 2026-08-24.
 *
 * PERCHÉ ESISTE. Fino a quel giorno i dati di prova vivevano dentro le sedi
 * VERE: il KPI «Studenti iscritti» che vede la segreteria contava 22 bambini
 * inesistenti a Giugliano, 2 ad Aversa, 1 a Cesa — e `Collaudo ProvaAversa`
 * sedeva nella sezione REALE «3 ANNI» di Aversa, cioè nel registro di una
 * maestra vera.
 *
 * PERCHÉ NON C'È UN FILTRO NEL CODICE. L'isolamento esisteva già e sta in un
 * posto solo: `isScuolaE2E` esclude dagli elenchi pubblici ogni sede il cui id
 * inizia per `e2e00000`, e `resolveScuoleAttive` filtra ogni KPI con
 * `.in('scuola_id', sedi)`. Bastava che i dati di prova cambiassero sede.
 * Aggiungere un secondo filtro «escludi i finti» avrebbe creato una seconda
 * verità da tenere allineata per sempre.
 *
 * QUESTO FILE È IL GUARDIANO DELL'UNICA COSA che può far fallire quella scelta:
 * il PREFISSO dell'uuid. Il nome, di proposito, non contiene «e2e» — lo legge il
 * revisore Apple e Google dentro l'app — quindi il prefisso è l'unico segnale
 * rimasto.
 */
describe('sede demo per i dati di prova', () => {
  it("è esclusa dal pubblico grazie al PREFISSO DELL'ID, non al nome", () => {
    expect(isScuolaE2E({ id: SEDE_DEMO, nome: NOME_SEDE_DEMO })).toBe(true)
  })

  it('⚠️ lo stesso nome con un uuid ordinario NON è escluso: ecco perché il prefisso è obbligatorio', () => {
    // Questo è il difetto che la scelta dell'uuid evita. `GET /api/iscrizione/sedi`
    // costruisce il selettore del wizard pubblico con questo stesso predicato:
    // una sede demo con un uuid qualunque comparirebbe fra le sedi scegliibili, e
    // una famiglia vera potrebbe iscrivere il proprio figlio a una sede che non
    // esiste. Il nome «Kidville Demo» da solo non la protegge.
    expect(isScuolaE2E({ id: SEDE_A, nome: NOME_SEDE_DEMO })).toBe(false)
  })

  it('non collide con la sede della CI né con la sua seconda sede', () => {
    // Il seed di `scripts/seed-e2e.mjs` svuota e ripopola le proprie sedi a ogni
    // giro. La demo contiene gli account che Apple e Google stanno usando: se
    // condividesse un uuid col seed, un giro di CI spegnerebbe la review.
    expect(SEDE_DEMO).not.toBe(SEDE_E2E)
    expect(SEDE_DEMO).not.toBe(SEDE_E2E_DUE)
  })

  it('un utente la cui unica sede è la demo è un utente di collaudo', () => {
    expect(isUtenteCollaudo({ scuola_id: SEDE_DEMO }, new Map([[SEDE_DEMO, NOME_SEDE_DEMO]]))).toBe(true)
  })

  it('resta di collaudo anche se la mappa dei nomi non è leggibile: basta il prefisso', () => {
    // `isUtenteCollaudo` accetta una mappa parziale o vuota. Se la lettura di
    // `schools` degrada il nome sparisce, ma l'uuid resta: il predicato deve
    // reggere lo stesso, altrimenti un guasto transitorio promuoverebbe 48
    // account di prova a utenti veri.
    expect(isUtenteCollaudo({ scuola_id: SEDE_DEMO }, new Map())).toBe(true)
  })

  it('un utente con una sede REALE resta un utente vero anche se ne ha una demo', () => {
    const nomi = new Map([
      [SEDE_DEMO, NOME_SEDE_DEMO],
      [SEDE_A, NOME_SEDE_A],
    ])
    expect(isUtenteCollaudo({ scuola_id: SEDE_A, sedi: [SEDE_DEMO] }, nomi)).toBe(false)
  })
})
