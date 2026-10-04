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
]
const ALUNNI = [
  voce({ id: 'a', nome: 'Niccolò', cognome: 'D’Amico', allergeni: ['latte'], haAllergie: true }),
  voce({ id: 'b', nome: 'Bruno', cognome: 'Rossi', sectionId: 'S2', grado: 'primaria', annoNascita: 2018, dataNascita: '2018-05-05', sesso: 'M', besDsa: true, consensoFotoSocial: false }),
  voce({ id: 'c', nome: 'Carla', cognome: 'Verdi', usaPannolino: true, consensoFotoSito: null, consensoFotoSocial: null, allergeni: ['uova'], haAllergie: true }),
]

const campi = campiAlunni(t, { sezioni: SEZIONI, alunni: ALUNNI, etichettaAllergene: (k) => `allergene:${k}` })
const filtra = (valori: ValoriFiltri) =>
  filtraRighe(campi, { ...valoriIniziali(campi, null), ...valori }, ALUNNI).map((r) => r.id)

describe('campiAlunni — ricerca per nome', () => {
  it('nessun filtro ⇒ tutti', () => expect(filtra({})).toEqual(['a', 'b', 'c']))
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
    expect(filtra({ sezione: ['S1', 'S2'] })).toEqual(['a', 'b', 'c'])
    expect(filtra({ grado: ['primaria'] })).toEqual(['b'])
  })
  it('salute', () => {
    expect(filtra({ allergie: true })).toEqual(['a', 'c'])
    expect(filtra({ allergene: ['uova'] })).toEqual(['c'])
    expect(filtra({ allergene: ['latte', 'uova'] })).toEqual(['a', 'c'])
    expect(filtra({ bes: true })).toEqual(['b'])
    expect(filtra({ pannolino: true })).toEqual(['c'])
  })
  it('consensi foto: un consenso ASSENTE conta come «senza consenso»', () => {
    expect(filtra({ senzaFotoSito: true })).toEqual(['c'])
    expect(filtra({ senzaFotoSocial: true })).toEqual(['b', 'c'])
  })
  it('età e sesso', () => {
    expect(filtra({ anno: ['2018'] })).toEqual(['b'])
    expect(filtra({ sesso: ['M'] })).toEqual(['b'])
  })
  it('AND fra campi diversi', () => {
    expect(filtra({ sezione: ['S1'], allergene: ['uova'] })).toEqual(['c'])
    expect(filtra({ allergie: true, sesso: ['M'] })).toEqual([])
  })
})

describe('campiAlunni — le opzioni', () => {
  it('nascono dai dati, con le etichette del catalogo e dell’allergene', () => {
    const grado = campi.find((c) => c.chiave === 'grado')
    expect(grado && 'opzioni' in grado ? grado.opzioni.map((o) => o.etichetta) : []).toEqual(['Infanzia', 'Primaria'])
    const allergene = campi.find((c) => c.chiave === 'allergene')
    expect(allergene && 'opzioni' in allergene ? allergene.opzioni.map((o) => o.etichetta) : []).toEqual(['allergene:latte', 'allergene:uova'])
  })
  it('con una sezione sola (e un grado solo) quei due filtri non si offrono', () => {
    const una = campiAlunni(t, { sezioni: SEZIONI, alunni: [ALUNNI[0], ALUNNI[2]], etichettaAllergene: (k) => k })
    for (const chiave of ['sezione', 'grado']) {
      const campo = una.find((c) => c.chiave === chiave)
      expect(campo && 'opzioni' in campo ? campo.opzioni : null).toEqual([])
    }
  })
})
