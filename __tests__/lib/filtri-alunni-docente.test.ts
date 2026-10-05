import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'use-intl'
import { filtraRighe, valoriIniziali, versoUrl } from '@/lib/ui/filtri/motore'
import type { ValoriFiltri } from '@/lib/ui/filtri/tipi'
import { campiAlunni } from '@/components/features/teacher/anagrafica/filtri-alunni'
import type { SezioneElenco, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'

// Il motore è quello vero: qui si prova che i CAMPI dicono la cosa giusta.
// Il traduttore usa il catalogo vero e LANCIA su una chiave mancante.
const CATALOGO = JSON.parse(readFileSync(join(process.cwd(), 'messages/it/teacherServizi.json'), 'utf8'))
const t = createTranslator({
  locale: 'it',
  messages: { teacherServizi: CATALOGO } as never,
  namespace: 'teacherServizi' as never,
  onError: (errore) => {
    throw errore
  },
}) as unknown as (chiave: string, valori?: Record<string, string | number>) => string

const voce = (v: Partial<VoceElencoAlunno> & { id: string }): VoceElencoAlunno => ({
  nome: 'N', cognome: 'C', sectionId: 'S1', grado: 'infanzia', dataNascita: '2021-01-01', annoNascita: 2021,
  sesso: 'F', allergeni: [], haAllergie: false, besDsa: false, usaPannolino: false,
  consensoFotoSito: true, consensoFotoSocial: true, ...v,
})

const SEZIONI: SezioneElenco[] = [
  { id: 'S1', nome: 'Girasoli', grado: 'infanzia' },
  { id: 'S2', nome: '3A', grado: 'primaria' },
  { id: 'S3', nome: 'Coccinelle', grado: 'nido' },
]
const ALUNNI = [
  voce({ id: 'a', nome: 'Niccolò', cognome: 'D’Amico', allergeni: ['latte'], haAllergie: true }),
  voce({ id: 'b', nome: 'Bruno', cognome: 'Rossi', sectionId: 'S2', grado: 'primaria', annoNascita: 2018, dataNascita: '2018-05-05', sesso: 'M', besDsa: true, consensoFotoSocial: false }),
  voce({ id: 'c', nome: 'Carla', cognome: 'Verdi', usaPannolino: true, consensoFotoSito: null, consensoFotoSocial: null, allergeni: ['uova'], haAllergie: true }),
  // allergia scritta solo a testo libero («fragole»): nessuna chiave, ma `haAllergie`
  voce({ id: 'd', nome: 'Dario', cognome: 'Neri', allergeni: [], haAllergie: true, consensoFotoSito: false }),
  voce({ id: 'e', nome: 'Elsa', cognome: 'Gialli', sectionId: 'S3', grado: 'nido', annoNascita: 2024, dataNascita: '2024-02-02' }),
]

const campi = campiAlunni(t, { sezioni: SEZIONI, alunni: ALUNNI, etichettaAllergene: (k) => `allergene:${k}` })
const filtra = (valori: ValoriFiltri) =>
  filtraRighe(campi, { ...valoriIniziali(campi, null), ...valori }, ALUNNI).map((r) => r.id)

describe('campiAlunni — ricerca per nome', () => {
  it('nessun filtro ⇒ tutti', () => expect(filtra({})).toEqual(['a', 'b', 'c', 'd', 'e']))
  it('senza accenti, apostrofi o maiuscole', () => {
    expect(filtra({ q: 'NICCOLO' })).toEqual(['a'])
    expect(filtra({ q: "d'amico niccolò" })).toEqual(['a'])
  })
  it('nome e cognome insieme, nei due ordini', () => {
    expect(filtra({ q: 'bruno rossi' })).toEqual(['b'])
    expect(filtra({ q: 'rossi bruno' })).toEqual(['b'])
  })
  it('la ricerca NON finisce nell’indirizzo, gli altri filtri sì', () => {
    const url = versoUrl(campi, { ...valoriIniziali(campi, null), q: 'rossi', bes: true })
    expect(url.get('q')).toBeNull()
    expect(url.get('bes')).toBe('1')
  })
})

describe('campiAlunni — ogni filtro', () => {
  it('sezione e grado (OR dentro il campo)', () => {
    expect(filtra({ sezione: ['S2'] })).toEqual(['b'])
    expect(filtra({ sezione: ['S1', 'S2'] })).toEqual(['a', 'b', 'c', 'd'])
    expect(filtra({ grado: ['primaria'] })).toEqual(['b'])
  })
  it('salute', () => {
    expect(filtra({ allergie: true })).toEqual(['a', 'c', 'd'])
    expect(filtra({ allergene: ['uova'] })).toEqual(['c'])
    expect(filtra({ allergene: ['latte', 'uova'] })).toEqual(['a', 'c'])
    expect(filtra({ bes: true })).toEqual(['b'])
    expect(filtra({ pannolino: true })).toEqual(['c'])
  })
  it('consensi foto: un consenso ASSENTE conta come «senza consenso»', () => {
    expect(filtra({ senzaFotoSito: true })).toEqual(['c', 'd'])
    expect(filtra({ senzaFotoSocial: true })).toEqual(['b', 'c'])
  })
  it('età e sesso', () => {
    expect(filtra({ anno: ['2018'] })).toEqual(['b'])
    expect(filtra({ sesso: ['M'] })).toEqual(['b'])
    expect(filtra({ anno: ['2024'] })).toEqual(['e'])
  })
  it('AND fra campi diversi', () => {
    expect(filtra({ sezione: ['S1'], allergene: ['uova'] })).toEqual(['c'])
    expect(filtra({ allergie: true, sesso: ['M'] })).toEqual([])
  })
})

const opzioniDi = (chiave: string, c = campi) => {
  const campo = c.find((x) => x.chiave === chiave)
  return campo && 'opzioni' in campo ? campo.opzioni : []
}

describe('campiAlunni — le opzioni', () => {
  it('nascono dai dati, con le etichette del catalogo e dell’allergene', () => {
    expect(opzioniDi('allergene').map((o) => o.etichetta)).toEqual(['allergene:latte', 'allergene:uova'])
  })
  it('grado: ordine fisso nido → infanzia → primaria, con le etichette del catalogo', () => {
    expect(opzioniDi('grado').map((o) => [o.valore, o.etichetta])).toEqual([
      ['nido', 'Nido'],
      ['infanzia', 'Infanzia'],
      ['primaria', 'Primaria'],
    ])
  })
  it('sezione: nell’ordine di `sezioni`, col nome (mai l’uuid), con i conteggi', () => {
    expect(opzioniDi('sezione').map((o) => [o.valore, o.etichetta, o.conteggio])).toEqual([
      ['S1', 'Girasoli', 3],
      ['S2', '3A', 1],
      ['S3', 'Coccinelle', 1],
    ])
  })
  it('un sectionId che non è fra le sezioni non produce un’opzione', () => {
    const alunni = [...ALUNNI, voce({ id: 'f', sectionId: 'UUID-SCONOSCIUTO' })]
    const c = campiAlunni(t, { sezioni: SEZIONI, alunni, etichettaAllergene: (k) => k })
    expect(opzioniDi('sezione', c).map((o) => o.valore)).toEqual(['S1', 'S2', 'S3'])
  })
  it('sesso: etichette del catalogo', () => {
    expect(opzioniDi('sesso').map((o) => [o.valore, o.etichetta]).sort()).toEqual([['F', 'Femmina'], ['M', 'Maschio']])
  })
  it('con una sezione sola (e un grado solo) quei due filtri non si offrono', () => {
    const una = campiAlunni(t, { sezioni: SEZIONI, alunni: [ALUNNI[0], ALUNNI[2]], etichettaAllergene: (k) => k })
    expect(opzioniDi('sezione', una)).toEqual([])
    expect(opzioniDi('grado', una)).toEqual([])
  })
})
