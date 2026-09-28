import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IntlMessageFormat } from 'intl-messageformat'
import {
  anomaliaPagante, componiBadge, indicizzaLegami, legamiDaRisposta, nomeConClasse, nomePagante, nonVisibiliDaRisposta,
  prefissoPaganteIt, sessoDa, testoPaganteIt, valoriPrefisso, SEPARATORE_STATO,
  type LegameRetta, type PaganteRetta,
} from '@/lib/pagamenti/rette-a-carico'

const pagante = (extra: Partial<PaganteRetta> = {}): PaganteRetta => ({
  id: 'p1', nome: 'Mario', cognome: 'Rossi', sesso: 'M', classe_sezione: 'Sez. C',
  iscritto: true, scuola_id: 's1', ...extra,
})
const legame = (extra: Partial<PaganteRetta> = {}, sedeBambino = 's1'): LegameRetta => ({
  alunno_id: 'b1', scuola_id: sedeBambino, pagante: pagante(extra),
})

describe('rette a carico — i testi (D1, D2, D5)', () => {
  it('fratello, sorella, sesso assente', () => {
    expect(prefissoPaganteIt(pagante())).toBe('Paga il fratello Mario Rossi (Sez. C)')
    expect(prefissoPaganteIt(pagante({ sesso: 'F', nome: 'Anna' }))).toBe('Paga la sorella Anna Rossi (Sez. C)')
    expect(prefissoPaganteIt(pagante({ sesso: null }))).toBe('A carico di Mario Rossi (Sez. C)')
  })
  it('senza classe niente parentesi; spazi ripuliti', () => {
    expect(nomeConClasse(pagante({ classe_sezione: null }))).toBe('Mario Rossi')
    expect(nomeConClasse(pagante({ classe_sezione: '   ' }))).toBe('Mario Rossi')
    expect(nomePagante({ nome: ' Mario ', cognome: ' De  Luca ' })).toBe('Mario De Luca')
  })
  it('lo stato si aggiunge dopo il separatore, e solo se c’è', () => {
    expect(SEPARATORE_STATO).toBe(' · ')
    expect(testoPaganteIt(pagante(), 'Da pagare')).toBe('Paga il fratello Mario Rossi (Sez. C) · Da pagare')
    expect(testoPaganteIt(pagante(), null)).toBe('Paga il fratello Mario Rossi (Sez. C)')
    expect(componiBadge('X', '')).toBe('X')
  })
  it('valoriPrefisso: il sesso assente diventa «nd» (ICU vuole una stringa)', () => {
    expect(valoriPrefisso(pagante({ sesso: null }))).toEqual({ sesso: 'nd', nome: 'Mario Rossi (Sez. C)' })
    expect(valoriPrefisso(pagante())).toEqual({ sesso: 'M', nome: 'Mario Rossi (Sez. C)' })
  })
})

describe('sessoDa', () => {
  it('accetta M/F anche minuscole e con spazi; il resto è null', () => {
    expect(sessoDa('M')).toBe('M')
    expect(sessoDa(' f ')).toBe('F')
    expect(sessoDa('X')).toBeNull()
    expect(sessoDa('')).toBeNull()
    expect(sessoDa(null)).toBeNull()
    expect(sessoDa(1)).toBeNull()
  })
})

describe('anomaliaPagante (D12)', () => {
  it('nessuna anomalia: iscritto e stessa sede', () => {
    expect(anomaliaPagante(legame())).toBeNull()
  })
  it('non iscritto', () => {
    expect(anomaliaPagante(legame({ iscritto: false }))).toBe('non-iscritto')
  })
  it('altra sede', () => {
    expect(anomaliaPagante(legame({ scuola_id: 's2' }))).toBe('altra-sede')
  })
  it('il non iscritto vince sull’altra sede', () => {
    expect(anomaliaPagante(legame({ iscritto: false, scuola_id: 's2' }))).toBe('non-iscritto')
  })
})

describe('indicizzaLegami e legamiDaRisposta', () => {
  it('indicizza per alunno a carico', () => {
    const m = indicizzaLegami([legame()])
    expect(m.get('b1')?.pagante.id).toBe('p1')
    expect(m.size).toBe(1)
  })
  it('una risposta che non è un array è null (guasto, non «nessun legame»)', () => {
    expect(legamiDaRisposta(undefined)).toBeNull()
    expect(legamiDaRisposta({})).toBeNull()
  })
  it('scarta le voci malformate, tiene le buone e CONTA le scartate (il cruscotto le logga)', () => {
    const buona = legame()
    expect(legamiDaRisposta([buona, null, { alunno_id: 'x' }, { alunno_id: 'y', pagante: { id: 3 } }]))
      .toEqual({ legami: [buona], scartati: 3 })
    expect(legamiDaRisposta([buona])).toEqual({ legami: [buona], scartati: 0 })
  })
})

describe('nonVisibiliDaRisposta (C3: il pagante sta in una sede che l’utente non legge)', () => {
  it('campo assente (risposta di prima): nessun bambino, nessuno scarto', () => {
    expect(nonVisibiliDaRisposta(undefined)).toEqual({ ids: [], scartati: 0 })
    expect(nonVisibiliDaRisposta(null)).toEqual({ ids: [], scartati: 0 })
  })
  it('tiene gli uuid e conta il resto', () => {
    expect(nonVisibiliDaRisposta(['a', '', 3, null, 'b'])).toEqual({ ids: ['a', 'b'], scartati: 3 })
  })
  it('un campo che non è un array è UNO scarto, non un crash', () => {
    expect(nonVisibiliDaRisposta('a')).toEqual({ ids: [], scartati: 1 })
    expect(nonVisibiliDaRisposta({ a: 1 })).toEqual({ ids: [], scartati: 1 })
  })
})

const catalogo = (lingua: string) =>
  JSON.parse(readFileSync(join(process.cwd(), `messages/${lingua}/adminContabilita.json`), 'utf8')) as Record<string, string>

describe('LOCK — schermo (catalogo it) ed Excel (prefissoPaganteIt) dicono la stessa frase', () => {
  const it_ = catalogo('it')
  for (const sesso of ['M', 'F', null] as const) {
    for (const classe of ['Sez. C', null]) {
      it(`sesso ${sesso ?? 'assente'}, classe ${classe ?? 'assente'}`, () => {
        const p = pagante({ sesso, classe_sezione: classe })
        const schermo = String(new IntlMessageFormat(it_.dashACarico, 'it').format(valoriPrefisso(p)))
        expect(schermo).toBe(prefissoPaganteIt(p))
      })
    }
  }
  // C6 (revisione 2026-09-28): `iscritto` è falso anche per un pagante SOSPESO, che per
  // `src/lib/alunni/stato.ts` è «ancora iscritto»: «non è più iscritto» gli attribuiva un'uscita
  // che non c'è stata. «Non risulta iscritto» è vero in tutti i casi che accendono l'avviso.
  it('C6: l’avviso dice «non risulta iscritto», in entrambe le lingue', () => {
    expect(it_.dashPaganteNonIscritto).toBe('Chi paga non risulta iscritto: retta da rivedere')
    expect(catalogo('en').dashPaganteNonIscritto).toBe('The payer is not enrolled: review the fee')
  })
  it('C3: il pagante non leggibile è «di un’altra sede», e in inglese è una location (glossario)', () => {
    expect(it_.dashACaricoAltraSede).toBe('A carico di un fratello di un’altra sede')
    expect(catalogo('en').dashACaricoAltraSede).toMatch(/location/)
    expect(catalogo('en').dashACaricoAltraSede).not.toMatch(/school/i)
  })
  it('l’avviso D9 usa la stessa forma di nome', () => {
    const p = pagante({ sesso: 'F', nome: 'Anna' })
    expect(String(new IntlMessageFormat(it_.dashACaricoVerifica, 'it').format(valoriPrefisso(p))))
      .toBe('A carico della sorella Anna Rossi (Sez. C): retta da verificare')
  })
  it('le sei chiavi esistono in entrambe le lingue', () => {
    for (const lingua of ['it', 'en']) {
      const c = catalogo(lingua)
      for (const k of ['dashACarico', 'dashACaricoVerifica', 'dashACaricoAltraSede', 'dashPaganteNonIscritto', 'dashPaganteAltraSede', 'dashMsErrLegami']) {
        expect(typeof c[k], `${lingua}.${k}`).toBe('string')
      }
    }
  })
})
