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

  // K6 (seconda revisione 2026-09-28): si validavano solo `alunno_id`, `id`, `nome` e
  // `cognome`, ma il cruscotto USA anche gli altri campi. Una `classe_sezione` numerica faceva
  // lanciare `.trim()` e cadere il cruscotto; un `iscritto` assente accendeva il falso avviso
  // rosso «Chi paga non risulta iscritto». Ogni voce che non passa si scarta e si CONTA.
  describe('K6 — ogni campo che il cruscotto usa è validato', () => {
    const conPagante = (extra: Record<string, unknown>) => ({ ...legame(), pagante: { ...pagante(), ...extra } })
    const conLegame = (extra: Record<string, unknown>) => ({ ...legame(), ...extra })
    const scartata = (voce: unknown) => expect(legamiDaRisposta([legame(), voce])).toEqual({ legami: [legame()], scartati: 1 })
    const tenuta = (voce: unknown) => expect(legamiDaRisposta([voce])?.legami).toHaveLength(1)

    it('classe_sezione: stringa o null; un numero si scarta (prima: `.trim()` lanciava)', () => {
      tenuta(conPagante({ classe_sezione: null }))
      scartata(conPagante({ classe_sezione: 42 }))
      scartata(conPagante({ classe_sezione: undefined }))
    })
    it('iscritto: booleano; assente o stringa si scarta (prima: falso avviso rosso)', () => {
      tenuta(conPagante({ iscritto: false }))
      scartata(conPagante({ iscritto: undefined }))
      scartata(conPagante({ iscritto: 'true' }))
    })
    it('sesso: M, F o null; qualunque altra cosa si scarta', () => {
      tenuta(conPagante({ sesso: 'F' }))
      tenuta(conPagante({ sesso: null }))
      scartata(conPagante({ sesso: 'X' }))
      scartata(conPagante({ sesso: 'm' }))
      scartata(conPagante({ sesso: undefined }))
    })
    it('scuola_id del pagante: stringa non vuota o null', () => {
      tenuta(conPagante({ scuola_id: null }))
      scartata(conPagante({ scuola_id: 5 }))
      scartata(conPagante({ scuola_id: '' }))
      scartata(conPagante({ scuola_id: undefined }))
    })
    it('scuola_id del legame (la sede del bambino): stringa non vuota o null', () => {
      tenuta(conLegame({ scuola_id: null }))
      scartata(conLegame({ scuola_id: 5 }))
      scartata(conLegame({ scuola_id: '' }))
      scartata(conLegame({ scuola_id: undefined }))
    })
    it('gli id: stringhe NON vuote (un id vuoto non indicizza nessun bambino)', () => {
      scartata(conLegame({ alunno_id: '' }))
      scartata(conPagante({ id: '' }))
    })
    it('nome e cognome restano stringhe obbligatorie (anche vuote: il loader le mette così)', () => {
      tenuta(conPagante({ nome: '', cognome: '' }))
      scartata(conPagante({ cognome: null }))
    })
  })
})

describe('nonVisibiliDaRisposta (C3: il pagante sta in una sede che l’utente non legge)', () => {
  it('campo assente (risposta di prima): nessun bambino, nessuno scarto', () => {
    expect(nonVisibiliDaRisposta(undefined)).toEqual({ ids: [], scartati: 0 })
    expect(nonVisibiliDaRisposta(null)).toEqual({ ids: [], scartati: 0 })
  })
  it('tiene le stringhe non vuote e conta il resto (l’id si confronta, non si valida come uuid)', () => {
    expect(nonVisibiliDaRisposta(['a', '', 3, null, 'b'])).toEqual({ ids: ['a', 'b'], scartati: 3 })
  })
  // R10 (terza revisione 2026-09-29): era «uno scarto», e il cruscotto mostrava lo stesso i
  // legami di quella risposta. Un campo presente che non è un array è una FORMA INATTESA, come
  // `data` non array in `legamiDaRisposta`: `null`, e il chiamante lo dice a schermo.
  it('un campo presente che non è un array è una forma inattesa (null), non un crash', () => {
    expect(nonVisibiliDaRisposta('a')).toBeNull()
    expect(nonVisibiliDaRisposta({ a: 1 })).toBeNull()
    expect(nonVisibiliDaRisposta(7)).toBeNull()
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
