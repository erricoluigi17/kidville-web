import { describe, it, expect } from 'vitest'
import type { RigaElenco } from '@/lib/iscrizioni/import/abbinamento'
import {
  decidi,
  preferibile,
  completezza,
  referenteDi,
  type Domanda,
} from '@/lib/iscrizioni/import/analisi'

// ─────────────────────────────────────────────────────────────────────────────
// LA DECISIONE — dove il programma si ferma invece di indovinare.
//
// I casi sono quelli veri (misurati il 2026-08-16), con nomi cambiati dove il
// nome non conta. La regola che tutti i test qui verificano è una sola: quando
// non c'è UNA sola risposta certa, l'esito è `da_controllare` con un motivo che
// una persona può leggere — mai una scelta automatica.
// ─────────────────────────────────────────────────────────────────────────────

const riga = (over: Partial<RigaElenco>): RigaElenco => ({
  id: 'r', classe: '3 ANNI A', nome: 'ROSSI MARIO', riga: 2, retta: 180, rettaTesto: null, ...over,
})

const domanda = (over: Partial<Domanda> = {}): Domanda => ({
  id: 'd1',
  scuolaId: 's1',
  creataIl: '2026-07-30T10:00:00Z',
  bambini: [{ nome: 'Mario', cognome: 'Rossi', codiceFiscale: 'RSSMRA20A01H501U', dataNascita: '2023-05-01' }],
  adulti: [{ nome: 'Anna', cognome: 'Rossi', email: 'anna@esempio.it', codiceFiscale: 'RSSNNA80A41H501K', ruolo: 'madre' }],
  ...over,
})

const nessunFratello = () => []

describe('decidi — la strada dritta', () => {
  it('un bambino, una riga nell\'elenco, una cifra → si manda', () => {
    const d = decidi(domanda(), [riga({})], nessunFratello)
    expect(d.tipo).toBe('invia')
    if (d.tipo === 'invia') {
      expect(d.assegnazioni).toEqual([
        { indice: 0, nome: 'Mario', cognome: 'Rossi', classe: '3 ANNI A', retta: 180, aCaricoDi: null },
      ])
      expect(d.referente.email).toBe('anna@esempio.it')
    }
  })

  it('due fratelli nella stessa domanda vanno ciascuno nella sua classe', () => {
    const d = decidi(
      domanda({
        bambini: [
          { nome: 'Mario', cognome: 'Rossi', codiceFiscale: null, dataNascita: null },
          { nome: 'Sara', cognome: 'Rossi', codiceFiscale: null, dataNascita: null },
        ],
      }),
      [riga({ id: 'a', nome: 'ROSSI MARIO', classe: '3 ANNI A', retta: 180 }),
       riga({ id: 'b', nome: 'ROSSI SARA', classe: 'I', retta: 150 })],
      nessunFratello,
    )
    expect(d.tipo).toBe('invia')
    if (d.tipo === 'invia') expect(d.assegnazioni.map((a) => a.classe)).toEqual(['3 ANNI A', 'I'])
  })

  it('la retta a carico del fratello entra come 0 CON il nome di chi paga', () => {
    // Lo zero da solo sarebbe una bomba: 0 significa «retta di default» = 150 €.
    // È `aCaricoDi` a dire che quello zero è voluto, e a far scrivere la colonna
    // che esclude l'alunno dalla generazione.
    const fratello = riga({ id: 'f', nome: 'ROSSI LUCA', classe: 'MICRONIDO', retta: 330 })
    const d = decidi(
      domanda(),
      [riga({ retta: null, rettaTesto: 'vedi fratello' })],
      () => [fratello],
    )
    expect(d.tipo).toBe('invia')
    if (d.tipo === 'invia') {
      expect(d.assegnazioni[0].retta).toBe(0)
      expect(d.assegnazioni[0].aCaricoDi).toBe('ROSSI LUCA')
    }
  })
})

describe('decidi — dove ci si ferma', () => {
  it('due righe con lo stesso nome (PALMA ANDREA in due sezioni) → da controllare, con le due classi nel motivo', () => {
    const d = decidi(
      domanda({ bambini: [{ nome: 'Andrea', cognome: 'Palma', codiceFiscale: null, dataNascita: null }] }),
      [riga({ id: 'a', nome: 'PALMA ANDREA', classe: '2 ANNI B', riga: 15 }),
       riga({ id: 'b', nome: 'PALMA ANDREA', classe: '2 ANNI C', riga: 15 })],
      nessunFratello,
    )
    expect(d.tipo).toBe('da_controllare')
    if (d.tipo === 'da_controllare') {
      expect(d.motivo).toMatch(/2 ANNI B/)
      expect(d.motivo).toMatch(/2 ANNI C/)
    }
  })

  it('nome assente dall\'elenco → da controllare, con i nomi somiglianti nel motivo', () => {
    const d = decidi(
      domanda({ bambini: [{ nome: 'Diego', cognome: 'Grazioso', codiceFiscale: null, dataNascita: null }] }),
      [riga({ nome: 'GRAZIOSO DIECO', classe: 'MICRONIDO', retta: 450 })],
      nessunFratello,
    )
    expect(d.tipo).toBe('da_controllare')
    if (d.tipo === 'da_controllare') {
      expect(d.motivo).toMatch(/GRAZIOSO DIECO/)
      expect(d.motivo).toMatch(/errore di scrittura/i)
    }
  })

  it('retta vuota → da controllare, e si capisce di chi si parla', () => {
    const d = decidi(domanda(), [riga({ retta: null, rettaTesto: null })], nessunFratello)
    expect(d.tipo).toBe('da_controllare')
    if (d.tipo === 'da_controllare') expect(d.motivo).toMatch(/Rossi Mario|ROSSI MARIO/i)
  })

  it('nessun adulto con email → da controllare, perché non c\'è dove mandare l\'accesso', () => {
    const d = decidi(
      domanda({ adulti: [{ nome: 'Anna', cognome: 'Rossi', email: null, codiceFiscale: null, ruolo: 'madre' }] }),
      [riga({})],
      nessunFratello,
    )
    expect(d.tipo).toBe('da_controllare')
    if (d.tipo === 'da_controllare') expect(d.motivo).toMatch(/email/i)
  })

  it('BASTA UN FRATELLO INCERTO a fermare tutta la domanda', () => {
    // Se si mandasse metà domanda, il genitore riceverebbe l'accesso vedendo un
    // figlio solo, e nessuno saprebbe che l'altro è rimasto indietro.
    const d = decidi(
      domanda({
        bambini: [
          { nome: 'Mario', cognome: 'Rossi', codiceFiscale: null, dataNascita: null },
          { nome: 'Ignoto', cognome: 'Chissà', codiceFiscale: null, dataNascita: null },
        ],
      }),
      [riga({ nome: 'ROSSI MARIO' })],
      nessunFratello,
    )
    expect(d.tipo).toBe('da_controllare')
  })

  it('una domanda senza bambini non passa', () => {
    expect(decidi(domanda({ bambini: [] }), [riga({})], nessunFratello).tipo).toBe('da_controllare')
  })

  it('un duplicato dichiarato si chiude come tale, senza toccare l\'elenco', () => {
    const d = decidi(domanda(), [riga({})], nessunFratello, { id: 'altra', motivo: 'stesso codice fiscale' })
    expect(d.tipo).toBe('duplicata')
    if (d.tipo === 'duplicata') expect(d.di).toBe('altra')
  })
})

describe('quale delle due domande vale, quando lo stesso bambino è iscritto due volte', () => {
  it('vince la più completa', () => {
    const piena = domanda({ id: 'piena' })
    const scarna = domanda({
      id: 'scarna',
      creataIl: '2026-08-01T10:00:00Z',
      bambini: [{ nome: 'Mario', cognome: 'Rossi', codiceFiscale: null, dataNascita: null }],
      adulti: [{ nome: 'Anna', cognome: '', email: null, codiceFiscale: null, ruolo: null }],
    })
    expect(completezza(piena)).toBeGreaterThan(completezza(scarna))
    expect(preferibile(piena, scarna)).toBe(true)
  })

  it('a parità di completezza vince la più recente: chi rifà il modulo sta correggendo', () => {
    const vecchia = domanda({ id: 'v', creataIl: '2026-07-30T10:00:00Z' })
    const nuova = domanda({ id: 'n', creataIl: '2026-08-05T10:00:00Z' })
    expect(preferibile(nuova, vecchia)).toBe(true)
    expect(preferibile(vecchia, nuova)).toBe(false)
  })

  it('il confronto è deterministico: non dipende dall\'ordine in cui arrivano', () => {
    const a = domanda({ id: 'a', creataIl: '2026-07-30T10:00:00Z' })
    const b = domanda({ id: 'b', creataIl: '2026-08-05T10:00:00Z' })
    expect(preferibile(a, b)).toBe(!preferibile(b, a))
  })
})

describe('referenteDi', () => {
  it('è il primo adulto con un\'email', () => {
    const d = domanda({
      adulti: [
        { nome: 'Padre', cognome: 'X', email: null, codiceFiscale: null, ruolo: 'padre' },
        { nome: 'Madre', cognome: 'Y', email: 'm@y.it', codiceFiscale: null, ruolo: 'madre' },
      ],
    })
    expect(referenteDi(d)?.nome).toBe('Madre')
  })

  it('null se nessuno ne ha una', () => {
    expect(referenteDi(domanda({ adulti: [] }))).toBeNull()
  })
})
