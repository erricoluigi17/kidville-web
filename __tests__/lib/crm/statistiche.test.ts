import { describe, expect, it } from 'vitest'
import { dataCivile } from '@/i18n/config'
import {
  calcolaStatistiche,
  periodoDaSettembre,
  periodoMeseCorrente,
  periodoMeseScorso,
  type RigaPersona,
  type StatisticheCrm,
} from '@/lib/crm/statistiche'
import {
  ADESSO_DATASET,
  APPUNTAMENTI_20,
  AZIONI_20,
  BAMBINI_20,
  PERIODO_GENNAIO,
  PERSONA_1,
  PERSONA_2,
  PERSONA_3,
  SCHEDE_20,
  appuntamento,
  azione,
  bambino,
  scheda,
} from '../../fixtures/crm-statistiche-20'

/**
 * CRM della segreteria · Compito 6.1 — il calcolo delle statistiche.
 *
 * Le definizioni sono quelle del §10 della specifica. Due statistiche SEPARATE, e questo file lo prova
 * sei volte, una per ciascun caso del §10:
 *  · il tasso di PRESENTAZIONE va a chi ha FISSATO la visita (`fissato_da`; la riga «ai» se l'ha fissata
 *    l'assistente);
 *  · il tasso di CHIUSURA va a chi l'ha SVOLTA (`svolto_da`), una persona sola per bambino.
 * I numeri attesi sono scritti a mano, non letti dal calcolo: la tabella dei conti del dataset di venti
 * visite sta in testa a `__tests__/fixtures/crm-statistiche-20.ts`.
 */

const ADESSO = new Date('2026-02-10T12:00:00Z')

function calcola(i: {
  schede?: Parameters<typeof calcolaStatistiche>[0]['schede']
  bambini?: Parameters<typeof calcolaStatistiche>[0]['bambini']
  appuntamenti?: Parameters<typeof calcolaStatistiche>[0]['appuntamenti']
  azioni?: Parameters<typeof calcolaStatistiche>[0]['azioni']
  dal?: string
  al?: string
  adesso?: Date
}): StatisticheCrm {
  return calcolaStatistiche({
    schede: i.schede ?? [],
    bambini: i.bambini ?? [],
    appuntamenti: i.appuntamenti ?? [],
    azioni: i.azioni ?? [],
    dal: i.dal ?? PERIODO_GENNAIO.dal,
    al: i.al ?? PERIODO_GENNAIO.al,
    adesso: i.adesso ?? ADESSO,
  })
}

const riga = (s: StatisticheCrm, persona: string): RigaPersona | undefined =>
  s.righe.find((r) => r.persona === persona)

/** Ogni numero dell'esito, a qualunque profondità, dev'essere finito: né NaN né Infinity. */
function numeriNonFiniti(v: unknown, percorso = ''): string[] {
  if (typeof v === 'number') return Number.isFinite(v) ? [] : [`${percorso}=${v}`]
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => numeriNonFiniti(x, `${percorso}.${k}`))
  }
  return []
}

describe('i sei casi del §10 della specifica', () => {
  it('1 · la Segretaria 1 fissa, la 2 svolge, il bambino si iscrive → presentazione +1 alla 1, iscritto +1 alla 2', () => {
    const s = calcola({
      schede: [scheda('s1', '2026-01-02T10:00:00Z')],
      bambini: [
        bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: '2026-01-20T12:00:00Z', domanda_id: 'dom-1' }),
      ],
      appuntamenti: [
        appuntamento({
          scheda_id: 's1',
          inizio: '2026-01-10T10:00:00Z',
          stato: 'svolto',
          fissato_da: PERSONA_1,
          svolto_da: PERSONA_2,
        }),
      ],
    })

    const uno = riga(s, PERSONA_1)!
    expect([uno.fissati, uno.svolti, uno.nonPresentati, uno.tassoPresentazione]).toEqual([1, 1, 0, 1])
    // La 1 ha fissato ma non ha svolto: nessun bambino e nessuna chiusura sono suoi.
    expect([uno.bambiniVisitati, uno.iscrittiVerificati, uno.iscrittiAMano, uno.closeRate]).toEqual([0, 0, 0, null])

    const due = riga(s, PERSONA_2)!
    // La 2 ha svolto ma non ha fissato: nessuna presentazione è sua.
    expect([due.fissati, due.svolti, due.nonPresentati, due.tassoPresentazione]).toEqual([0, 0, 0, null])
    expect([due.bambiniVisitati, due.iscrittiVerificati, due.iscrittiAMano, due.closeRate]).toEqual([1, 1, 0, 1])

    expect(s.righe).toHaveLength(2)
    expect(s.totale.iscrittiVerificati + s.totale.iscrittiAMano).toBe(1)
  })

  it('2 · la 2 svolge e la 1 segna «svolto» → la visita va alla 2, non alla 1', () => {
    // `segnato_da` e `assegnata_a` sono della 1: per il calcolo conta solo `svolto_da`.
    const visita = appuntamento({
      scheda_id: 's1',
      inizio: '2026-01-10T10:00:00Z',
      stato: 'svolto',
      fissato_da: PERSONA_3,
      assegnata_a: PERSONA_1,
      segnato_da: PERSONA_1,
      segnato_il: '2026-01-10T12:00:00Z',
      svolto_da: PERSONA_2,
    })
    const s = calcola({
      schede: [scheda('s1', '2026-01-02T10:00:00Z')],
      bambini: [bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: '2026-01-20T12:00:00Z', domanda_id: 'dom-1' })],
      appuntamenti: [visita],
    })

    expect(riga(s, PERSONA_2)!.bambiniVisitati).toBe(1)
    expect(riga(s, PERSONA_2)!.iscrittiVerificati).toBe(1)
    // La 1 che ha premuto il tasto non compare nemmeno: non ha fissato, non ha svolto.
    expect(riga(s, PERSONA_1)).toBeUndefined()
    // Il merito della presentazione è di chi ha fissato (la 3), non di chi ha segnato.
    expect(riga(s, PERSONA_3)!.svolti).toBe(1)
  })

  it('3 · una famiglia con due bambini, se ne iscrive uno → 1 iscritto su 2', () => {
    const s = calcola({
      schede: [scheda('s1', '2026-01-02T10:00:00Z')],
      bambini: [
        bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: '2026-01-20T12:00:00Z', domanda_id: 'dom-1' }),
        bambino({ scheda_id: 's1', esito: 'ci_pensa' }),
      ],
      appuntamenti: [
        appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_2 }),
      ],
    })

    const due = riga(s, PERSONA_2)!
    expect(due.bambiniVisitati).toBe(2)
    expect(due.iscrittiVerificati + due.iscrittiAMano).toBe(1)
    expect(due.closeRate).toBe(0.5)
    expect(s.totale.closeRate).toBe(0.5)
  })

  it('4 · la visita viene spostata due volte da una collega → un appuntamento solo, che conta una volta', () => {
    // Lo spostamento riscrive `inizio` (e `assegnata_a`) sulla STESSA riga: nel database c'è un
    // appuntamento solo; i due eventi dello storico stanno in `crm_eventi`, non qui. La visita finisce
    // alla collega (`assegnata_a`), ma la presentazione resta di chi l'aveva fissata.
    const spostata = appuntamento({
      scheda_id: 's1',
      inizio: '2026-01-30T10:00:00Z',
      stato: 'in_programma',
      fissato_da: PERSONA_1,
      assegnata_a: PERSONA_3,
    })

    const s = calcola({ schede: [scheda('s1', '2026-01-02T10:00:00Z')], appuntamenti: [spostata] })
    expect(riga(s, PERSONA_1)!.fissati).toBe(1)
    expect(s.totale.fissati).toBe(1)
    expect(riga(s, PERSONA_3)).toBeUndefined()

    // Spostata due volte, fuori da gennaio: il vecchio periodo non la conta più, il nuovo sì.
    const spostataInFebbraio = { ...spostata, inizio: '2026-02-03T10:00:00Z' }
    expect(calcola({ appuntamenti: [spostataInFebbraio] }).totale.fissati).toBe(0)
    expect(
      calcola({ appuntamenti: [spostataInFebbraio], dal: '2026-02-01', al: '2026-02-28' }).totale.fissati,
    ).toBe(1)
  })

  it('5 · un iscritto a mano senza domanda → conta fra gli iscritti a mano, non fra i verificati', () => {
    const s = calcola({
      schede: [scheda('s1', '2026-01-02T10:00:00Z')],
      bambini: [
        bambino({ scheda_id: 's1', esito: 'iscritto', esito_origine: 'manuale', esito_il: '2026-01-20T12:00:00Z' }),
      ],
      appuntamenti: [
        appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_2 }),
      ],
    })

    const due = riga(s, PERSONA_2)!
    expect([due.iscrittiVerificati, due.iscrittiAMano]).toEqual([0, 1])
    expect([s.totale.iscrittiVerificati, s.totale.iscrittiAMano]).toEqual([0, 1])
    // …e vale anche per una domanda collegata ma poi respinta: «non conta più fra i verificati» (spec §7).
    const respinta = calcola({
      schede: [scheda('s1', '2026-01-02T10:00:00Z')],
      bambini: [
        bambino({
          scheda_id: 's1',
          esito: 'iscritto',
          esito_il: '2026-01-20T12:00:00Z',
          domanda_id: 'dom-1',
          da_verificare: true,
        }),
      ],
      appuntamenti: [
        appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_2 }),
      ],
    })
    expect([respinta.totale.iscrittiVerificati, respinta.totale.iscrittiAMano]).toEqual([0, 1])
  })

  it('6 · l’assistente AI fissa → la presentazione va alla riga «ai»', () => {
    const s = calcola({
      appuntamenti: [
        appuntamento({
          scheda_id: 's1',
          inizio: '2026-01-10T10:00:00Z',
          stato: 'svolto',
          fissato_da: null,
          fissato_via: 'ai',
          svolto_da: PERSONA_1,
        }),
      ],
    })

    const ai = riga(s, 'ai')!
    expect([ai.fissati, ai.svolti, ai.tassoPresentazione]).toEqual([1, 1, 1])
    // La segretaria che ha svolto la visita non riceve la presentazione dell'AI.
    expect(riga(s, PERSONA_1)).toBeUndefined()
    expect(s.righe.map((r) => r.persona)).toEqual(['ai'])
  })

  it('6bis · se per un errore c’è anche `fissato_da`, con `fissato_via=ai` vince l’AI: mai due nomi', () => {
    const s = calcola({
      appuntamenti: [
        appuntamento({
          scheda_id: 's1',
          inizio: '2026-01-10T10:00:00Z',
          stato: 'svolto',
          fissato_da: PERSONA_1,
          fissato_via: 'ai',
        }),
      ],
    })
    expect(s.righe.map((r) => r.persona)).toEqual(['ai'])
    expect(s.totale.fissati).toBe(1)
  })
})

describe('dataset di 20 appuntamenti: numeri calcolati a mano', () => {
  const s = calcola({
    schede: SCHEDE_20,
    bambini: BAMBINI_20,
    appuntamenti: APPUNTAMENTI_20,
    azioni: AZIONI_20,
    adesso: ADESSO_DATASET,
  })

  const attese = (r: RigaPersona | undefined) =>
    r && [
      r.fissati, r.svolti, r.nonPresentati, r.tassoPresentazione,
      r.bambiniVisitati, r.iscrittiVerificati, r.iscrittiAMano, r.closeRate,
      r.azioniDovute, r.azioniInTempo, r.followUpInTempo,
    ]

  it('ci sono quattro righe: tre segretarie e l’AI, mai altro', () => {
    expect(APPUNTAMENTI_20).toHaveLength(20)
    expect(s.righe.map((r) => r.persona).sort()).toEqual([PERSONA_1, PERSONA_2, PERSONA_3, 'ai'].sort())
    // L'AI sta sempre in fondo.
    expect(s.righe[s.righe.length - 1].persona).toBe('ai')
  })

  it('Segretaria 1: 6 fissate, 5 svolte, 1 non presentata; 4 bambini, 1 verificato, 2 a mano; 1 richiamo su 3', () => {
    expect(attese(riga(s, PERSONA_1))).toEqual([6, 5, 1, 5 / 6, 4, 1, 2, 3 / 4, 3, 1, 1 / 3])
  })

  it('Segretaria 2: 3 fissate, 2 svolte, 1 non presentata; 8 bambini, 1 verificato, 1 a mano; 2 richiami su 2', () => {
    expect(attese(riga(s, PERSONA_2))).toEqual([3, 2, 1, 2 / 3, 8, 1, 1, 2 / 8, 2, 2, 1])
  })

  it('Segretaria 3: 3 fissate (una ancora in programma), 2 svolte; 2 bambini, 1 verificato; 0 richiami su 1', () => {
    // Il follow-up di P3 vale 0, e 0 non è `null`: una persona con un richiamo dovuto e nessuno fatto in tempo.
    expect(attese(riga(s, PERSONA_3))).toEqual([3, 2, 0, 1, 2, 1, 0, 0.5, 1, 0, 0])
  })

  it('AI: 3 fissate, 2 svolte, 1 non presentata; nessun bambino e nessun richiamo → tassi nulli', () => {
    expect(attese(riga(s, 'ai'))).toEqual([3, 2, 1, 2 / 3, 0, 0, 0, null, 0, 0, null])
  })

  it('totale: 15 fissate, 11 svolte, 3 non presentate; 14 bambini, 3 verificati, 3 a mano; 3 richiami su 6', () => {
    const totale = s.totale
    expect([
      totale.fissati, totale.svolti, totale.nonPresentati, totale.tassoPresentazione,
      totale.bambiniVisitati, totale.iscrittiVerificati, totale.iscrittiAMano, totale.closeRate,
      totale.azioniDovute, totale.azioniInTempo, totale.followUpInTempo,
    ]).toEqual([15, 11, 3, 11 / 14, 14, 3, 3, 6 / 14, 6, 3, 0.5])
  })

  it('ritardo mediano contatto → visita: 3,5 giorni (dieci valori, la mediana è la media dei due centrali)', () => {
    expect(s.ritardoMedianoGiorni).toBe(3.5)
  })

  it('nessuna visita e nessun bambino resta senza nome', () => {
    expect(s.nonAttribuiti).toEqual({ visite: 0, bambini: 0 })
  })

  it('nessun numero è NaN o Infinity', () => {
    expect(numeriNonFiniti(s)).toEqual([])
  })
})

describe('periodo senza dati', () => {
  it('periodo senza visite → tassi null, non NaN', () => {
    const s = calcola({})
    expect(s.righe).toEqual([])
    expect(s.totale.tassoPresentazione).toBeNull()
    expect(s.totale.closeRate).toBeNull()
    expect(s.totale.followUpInTempo).toBeNull()
    expect(s.ritardoMedianoGiorni).toBeNull()
    expect(numeriNonFiniti(s)).toEqual([])
    expect(s.totale.fissati).toBe(0)
  })

  it('una persona con visite fissate ma nessuna conclusa → tasso di presentazione null (denominatore 0)', () => {
    const s = calcola({
      appuntamenti: [appuntamento({ scheda_id: 's1', inizio: '2026-01-20T10:00:00Z', stato: 'in_programma' })],
    })
    const r = riga(s, PERSONA_1)!
    expect(r.fissati).toBe(1)
    expect(r.tassoPresentazione).toBeNull()
    expect(Number.isNaN(r.tassoPresentazione as number)).toBe(false)
    expect(s.totale.tassoPresentazione).toBeNull()
  })

  it('un periodo rovesciato (dal dopo al) non produce niente e non lancia', () => {
    const s = calcola({
      appuntamenti: APPUNTAMENTI_20,
      dal: '2026-01-31',
      al: '2026-01-01',
    })
    expect(s.righe).toEqual([])
    expect(numeriNonFiniti(s)).toEqual([])
  })

  it('un periodo che non è una data lancia: la route lo ha già respinto, qui non si finge', () => {
    expect(() => calcola({ dal: 'ieri' })).toThrow(RangeError)
    expect(() => calcola({ al: '2026-13-40' })).toThrow(RangeError)
  })
})

describe('visite annullate e giorni civili di Roma', () => {
  it('visita annullata non entra in nessun denominatore', () => {
    const s = calcola({
      schede: [scheda('s1', '2026-01-02T10:00:00Z')],
      bambini: [bambino({ scheda_id: 's1' })],
      appuntamenti: [
        appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'annullato', svolto_da: PERSONA_2 }),
        appuntamento({ scheda_id: 's2', inizio: '2026-01-11T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_2 }),
        appuntamento({ scheda_id: 's3', inizio: '2026-01-12T10:00:00Z', stato: 'non_presentato' }),
      ],
    })
    const r = riga(s, PERSONA_1)!
    // Fissate = svolte + non presentate (+ in programma): l'annullata non c'è.
    expect([r.fissati, r.svolti, r.nonPresentati]).toEqual([2, 1, 1])
    expect(r.tassoPresentazione).toBe(0.5)
    // La scheda con la sola visita annullata non porta i suoi bambini nel tasso di chiusura.
    expect(s.totale.bambiniVisitati).toBe(0)
    expect(s.totale.closeRate).toBeNull()
  })

  it('una visita annullata non toglie né dà il merito dell’iscrizione', () => {
    // La 3 aveva svolto la prima visita; la seconda, della 2, è stata annullata: l'iscritto è della 3.
    const s = calcola({
      schede: [scheda('s1', '2026-01-02T10:00:00Z')],
      bambini: [bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: '2026-01-25T12:00:00Z', domanda_id: 'd' })],
      appuntamenti: [
        appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_3 }),
        appuntamento({ scheda_id: 's1', inizio: '2026-01-20T10:00:00Z', stato: 'annullato', svolto_da: PERSONA_2 }),
      ],
    })
    expect(riga(s, PERSONA_3)!.iscrittiVerificati).toBe(1)
    expect(riga(s, PERSONA_2)).toBeUndefined()
  })

  it('il periodo si legge in giorni civili di Roma: 23:30Z del 31/1 è già l’1/2', () => {
    const tardi = appuntamento({ scheda_id: 's1', inizio: '2026-01-31T23:30:00Z', stato: 'svolto' })
    const presto = appuntamento({ scheda_id: 's2', inizio: '2025-12-31T23:30:00Z', stato: 'svolto' })
    // gennaio: entra la mezzanotte e mezza del 1° gennaio, non quella dell'1 febbraio
    expect(calcola({ appuntamenti: [tardi, presto] }).totale.svolti).toBe(1)
    expect(calcola({ appuntamenti: [tardi, presto], dal: '2026-02-01', al: '2026-02-28' }).totale.svolti).toBe(1)
    expect(calcola({ appuntamenti: [tardi, presto], dal: '2025-12-01', al: '2025-12-31' }).totale.svolti).toBe(0)
  })

  it('e anche nel giorno del cambio d’ora legale (25/10/2026): le 00:30 di Roma sono le 22:30Z del 24', () => {
    const v = appuntamento({ scheda_id: 's1', inizio: '2026-10-24T22:30:00Z', stato: 'svolto' })
    expect(calcola({ appuntamenti: [v], dal: '2026-10-25', al: '2026-10-25' }).totale.svolti).toBe(1)
    expect(calcola({ appuntamenti: [v], dal: '2026-10-24', al: '2026-10-24' }).totale.svolti).toBe(0)
    // 23:30Z del 25 ottobre (ora solare, +01:00) sono le 00:30 del 26
    const dopo = appuntamento({ scheda_id: 's2', inizio: '2026-10-25T23:30:00Z', stato: 'svolto' })
    expect(calcola({ appuntamenti: [dopo], dal: '2026-10-26', al: '2026-10-26' }).totale.svolti).toBe(1)
    expect(calcola({ appuntamenti: [dopo], dal: '2026-10-25', al: '2026-10-25' }).totale.svolti).toBe(0)
  })
})

describe('chi prende il merito dell’iscrizione: una persona sola per bambino', () => {
  const sched = [scheda('s1', '2026-01-02T10:00:00Z')]
  const visiteDiDue = [
    appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_1 }),
    appuntamento({ scheda_id: 's1', inizio: '2026-01-15T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_2 }),
  ]

  it('due visite di persone diverse: l’iscritto va a chi ha svolto l’ultima PRIMA dell’iscrizione, mai a tutte e due', () => {
    const s = calcola({
      schede: sched,
      bambini: [bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: '2026-01-20T12:00:00Z', domanda_id: 'd' })],
      appuntamenti: visiteDiDue,
    })
    expect(riga(s, PERSONA_2)!.iscrittiVerificati).toBe(1)
    expect(riga(s, PERSONA_2)!.bambiniVisitati).toBe(1)
    expect(riga(s, PERSONA_1)!.bambiniVisitati).toBe(0)
    expect(riga(s, PERSONA_1)!.iscrittiVerificati).toBe(0)
    expect(s.totale.bambiniVisitati).toBe(1)
  })

  it('la visita fatta DOPO l’iscrizione non prende il merito', () => {
    const s = calcola({
      schede: sched,
      bambini: [bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: '2026-01-12T12:00:00Z', domanda_id: 'd' })],
      appuntamenti: visiteDiDue,
    })
    expect(riga(s, PERSONA_1)!.iscrittiVerificati).toBe(1)
    // La 2 ha svolto la seconda visita, ma l'iscrizione era già avvenuta: nessun bambino è suo.
    expect(riga(s, PERSONA_2)).toBeUndefined()
    expect(s.totale.bambiniVisitati).toBe(1)
  })

  it('chi non è iscritto va a chi ha svolto l’ultima visita fino a fine periodo', () => {
    const s = calcola({
      schede: sched,
      bambini: [bambino({ scheda_id: 's1', esito: 'ci_pensa' })],
      appuntamenti: visiteDiDue,
    })
    expect(riga(s, PERSONA_2)!.bambiniVisitati).toBe(1)
    expect(riga(s, PERSONA_1)!.bambiniVisitati).toBe(0)
  })

  it('…ma una visita dopo la fine del periodo non conta per chi non è iscritto', () => {
    const s = calcola({
      schede: sched,
      bambini: [bambino({ scheda_id: 's1', esito: 'ci_pensa' })],
      appuntamenti: [
        ...visiteDiDue.slice(0, 1),
        appuntamento({ scheda_id: 's1', inizio: '2026-02-05T10:00:00Z', stato: 'svolto', svolto_da: PERSONA_3 }),
      ],
    })
    expect(riga(s, PERSONA_1)!.bambiniVisitati).toBe(1)
    expect(riga(s, PERSONA_3)).toBeUndefined()
  })

  it('un bambino iscritto PRIMA di ogni visita non ha un merito da assegnare: resta fuori e si dichiara', () => {
    const s = calcola({
      schede: sched,
      bambini: [bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: '2026-01-05T12:00:00Z', domanda_id: 'd' })],
      appuntamenti: visiteDiDue.slice(0, 1),
    })
    expect(s.totale.bambiniVisitati).toBe(0)
    expect(s.totale.iscrittiVerificati).toBe(0)
    expect(s.nonAttribuiti).toEqual({ visite: 0, bambini: 1 })
    // La presentazione della visita resta di chi l'ha fissata.
    expect(riga(s, PERSONA_1)!.svolti).toBe(1)
  })

  it('una visita svolta senza `svolto_da` non assegna il bambino a nessuno e si dichiara', () => {
    const s = calcola({
      schede: sched,
      bambini: [bambino({ scheda_id: 's1' })],
      appuntamenti: [appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'svolto', svolto_da: null })],
    })
    expect(s.totale.bambiniVisitati).toBe(0)
    expect(s.nonAttribuiti.bambini).toBe(1)
  })

  it('una visita senza chi l’ha fissata (né utente né AI) non finisce a nessuno e si dichiara', () => {
    const s = calcola({
      appuntamenti: [
        appuntamento({ scheda_id: 's1', inizio: '2026-01-10T10:00:00Z', stato: 'svolto', fissato_da: null }),
      ],
    })
    expect(s.righe).toEqual([])
    expect(s.totale.fissati).toBe(0)
    expect(s.nonAttribuiti.visite).toBe(1)
  })

  it('un iscritto senza `esito_il` si legge come gli altri: l’ultima visita fino a fine periodo', () => {
    const s = calcola({
      schede: sched,
      bambini: [bambino({ scheda_id: 's1', esito: 'iscritto', esito_il: null })],
      appuntamenti: visiteDiDue,
    })
    expect(riga(s, PERSONA_2)!.iscrittiAMano).toBe(1)
    expect(s.nonAttribuiti.bambini).toBe(0)
  })
})

describe('follow-up in tempo', () => {
  const dovuta = (scadenza: string, extra: Partial<Parameters<typeof azione>[0]> = {}) =>
    azione({ responsabile: PERSONA_1, scadenza, ...extra })

  it('«in tempo» è fatta entro la fine del giorno della scadenza, a Roma', () => {
    const s = calcola({
      azioni: [
        dovuta('2026-01-12T09:30:00Z', { fatta_il: '2026-01-12T22:30:00Z' }), // 23:30 del 12 a Roma
        dovuta('2026-01-13T09:30:00Z', { fatta_il: '2026-01-13T23:30:00Z' }), // 00:30 del 14 a Roma
      ],
    })
    const r = riga(s, PERSONA_1)!
    expect([r.azioniDovute, r.azioniInTempo, r.followUpInTempo]).toEqual([2, 1, 0.5])
  })

  it('le azioni cancellate non si contano, nemmeno se scadute', () => {
    const s = calcola({
      azioni: [
        dovuta('2026-01-12T09:30:00Z', { cancellata_il: '2026-01-11T10:00:00Z' }),
        dovuta('2026-01-13T09:30:00Z', { fatta_il: '2026-01-13T10:00:00Z' }),
      ],
    })
    expect(riga(s, PERSONA_1)!.azioniDovute).toBe(1)
  })

  it('una scadenza ancora da venire (dopo «adesso») non è «scaduta nel periodo»', () => {
    const s = calcola({
      azioni: [
        dovuta('2026-01-12T09:30:00Z'),
        dovuta('2026-01-25T09:30:00Z'), // dopo «adesso»
      ],
      adesso: new Date('2026-01-20T12:00:00Z'),
    })
    expect(riga(s, PERSONA_1)!.azioniDovute).toBe(1)
  })

  it('una scadenza fuori dal periodo non entra', () => {
    const s = calcola({
      azioni: [dovuta('2025-12-31T09:30:00Z'), dovuta('2026-02-01T09:30:00Z')],
    })
    expect(s.righe).toEqual([])
  })

  it('le azioni vanno al responsabile, non a chi le ha fatte', () => {
    const s = calcola({
      azioni: [
        dovuta('2026-01-12T09:30:00Z', { fatta_da: PERSONA_2, fatta_il: '2026-01-12T10:00:00Z' }),
      ],
    })
    expect(riga(s, PERSONA_1)!.azioniInTempo).toBe(1)
    expect(riga(s, PERSONA_2)).toBeUndefined()
  })
})

describe('ritardo contatto → visita', () => {
  const unaVisita = (schedaId: string, inizio: string, extra = {}) =>
    appuntamento({ scheda_id: schedaId, inizio, stato: 'svolto', ...extra })

  it('è la mediana dei giorni fra la scheda creata e la PRIMA visita svolta', () => {
    const s = calcola({
      schede: [
        scheda('a', '2026-01-02T10:00:00Z'), // visita il 5 → 3 giorni
        scheda('b', '2026-01-02T10:00:00Z'), // visita il 12 → 10 giorni
        scheda('c', '2026-01-10T10:00:00Z'), // visita il 11 → 1 giorno
      ],
      appuntamenti: [
        unaVisita('a', '2026-01-05T10:00:00Z'),
        unaVisita('a', '2026-01-25T10:00:00Z'), // la seconda visita non cambia niente
        unaVisita('b', '2026-01-12T10:00:00Z'),
        unaVisita('c', '2026-01-11T10:00:00Z'),
      ],
    })
    expect(s.ritardoMedianoGiorni).toBe(3)
  })

  it('con un numero pari di valori è la media dei due centrali', () => {
    const s = calcola({
      schede: [scheda('a', '2026-01-02T10:00:00Z'), scheda('b', '2026-01-02T10:00:00Z')],
      appuntamenti: [unaVisita('a', '2026-01-03T10:00:00Z'), unaVisita('b', '2026-01-06T10:00:00Z')],
    })
    expect(s.ritardoMedianoGiorni).toBe(2.5)
  })

  it('conta i giorni di calendario di Roma, non le ore: 23:30 → 00:30 sono un giorno', () => {
    const s = calcola({
      schede: [scheda('a', '2026-01-04T22:30:00Z')], // 23:30 del 4 a Roma
      appuntamenti: [unaVisita('a', '2026-01-05T09:00:00Z')],
    })
    expect(s.ritardoMedianoGiorni).toBe(1)
  })

  it('una scheda registrata DOPO la visita (inserimento a posteriori) non entra: il ritardo non si conosce', () => {
    const s = calcola({
      schede: [scheda('a', '2026-01-20T10:00:00Z')],
      appuntamenti: [unaVisita('a', '2026-01-10T10:00:00Z')],
    })
    expect(s.ritardoMedianoGiorni).toBeNull()
  })

  it('senza visite svolte nel periodo è null', () => {
    const s = calcola({
      schede: [scheda('a', '2026-01-02T10:00:00Z')],
      appuntamenti: [
        appuntamento({ scheda_id: 'a', inizio: '2026-01-10T10:00:00Z', stato: 'non_presentato' }),
        unaVisita('a', '2026-02-10T10:00:00Z'),
      ],
    })
    expect(s.ritardoMedianoGiorni).toBeNull()
  })

  it('se la PRIMA visita è fuori periodo la scheda non entra, anche con una seconda dentro', () => {
    const s = calcola({
      schede: [scheda('a', '2025-12-01T10:00:00Z')],
      appuntamenti: [unaVisita('a', '2025-12-15T10:00:00Z'), unaVisita('a', '2026-01-15T10:00:00Z')],
    })
    expect(s.ritardoMedianoGiorni).toBeNull()
  })
})

describe('invarianti su dati qualunque', () => {
  // Un generatore deterministico (LCG): lo stesso seme dà gli stessi 300 casi, quindi un rosso si
  // riproduce. Non è un secondo calcolo dei risultati: verifica le proprietà che devono valere SEMPRE.
  function generatore(seme: number) {
    let x = seme >>> 0
    const prossimo = () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0
      return x / 0x100000000
    }
    const sceglie = <T,>(v: readonly T[]): T => v[Math.floor(prossimo() * v.length)]
    const intero = (a: number, b: number) => a + Math.floor(prossimo() * (b - a + 1))
    return { prossimo, sceglie, intero }
  }

  const PERSONE = [PERSONA_1, PERSONA_2, PERSONA_3, null] as const
  const STATI = ['in_programma', 'svolto', 'svolto', 'non_presentato', 'annullato'] as const
  const ESITI = ['aperto', 'iscritto', 'iscritto', 'ci_pensa', 'perso', 'lista_attesa'] as const

  function istante(g: ReturnType<typeof generatore>) {
    const giorno = g.intero(0, 75) // da metà dicembre a fine febbraio
    const d = new Date(Date.UTC(2025, 11, 15 + giorno, g.intero(0, 23), g.sceglie([0, 30])))
    return d.toISOString()
  }

  it('300 dataset casuali: il tasso di chiusura sta fra 0 e 1, ogni bambino è di una persona sola', () => {
    for (let seme = 1; seme <= 300; seme++) {
      const g = generatore(seme)
      const nSchede = g.intero(1, 7)
      const schede = [] as ReturnType<typeof scheda>[]
      const bambini = [] as ReturnType<typeof bambino>[]
      const appuntamenti = [] as ReturnType<typeof appuntamento>[]
      for (let k = 0; k < nSchede; k++) {
        const id = `sc-${k}`
        schede.push(scheda(id, istante(g)))
        for (let b = g.intero(1, 3); b > 0; b--) {
          const esito = g.sceglie(ESITI)
          bambini.push(
            bambino({
              scheda_id: id,
              esito,
              esito_il: g.prossimo() < 0.85 ? istante(g) : null,
              domanda_id: g.prossimo() < 0.5 ? 'dom' : null,
              da_verificare: g.prossimo() < 0.2,
            }),
          )
        }
        for (let a = g.intero(0, 3); a > 0; a--) {
          const via = g.prossimo() < 0.2 ? 'ai' : 'segreteria'
          appuntamenti.push(
            appuntamento({
              scheda_id: id,
              inizio: istante(g),
              stato: g.sceglie(STATI),
              fissato_via: via,
              fissato_da: via === 'ai' ? null : g.sceglie(PERSONE),
              svolto_da: g.sceglie(PERSONE),
            }),
          )
        }
      }

      const s = calcola({ schede, bambini, appuntamenti, dal: '2026-01-01', al: '2026-01-31' })

      for (const r of [...s.righe, s.totale]) {
        for (const rapporto of [r.tassoPresentazione, r.closeRate, r.followUpInTempo]) {
          if (rapporto !== null) {
            expect(rapporto).toBeGreaterThanOrEqual(0)
            expect(rapporto).toBeLessThanOrEqual(1)
          }
        }
        // Il numeratore non supera mai il denominatore: chi conta un iscritto conta anche il bambino.
        expect(r.iscrittiVerificati + r.iscrittiAMano).toBeLessThanOrEqual(r.bambiniVisitati)
        expect(r.svolti + r.nonPresentati).toBeLessThanOrEqual(r.fissati)
      }
      expect(numeriNonFiniti(s)).toEqual([])

      // Ogni bambino della coorte (scheda con una visita svolta nel periodo) è di UNA persona, oppure
      // dichiarato come non attribuito: la somma delle righe più i non attribuiti è la coorte intera.
      const schedeInCoorte = new Set(
        appuntamenti
          .filter((a) => a.stato === 'svolto')
          .filter((a) => {
            const gg = dataCivile(new Date(a.inizio))
            return gg >= '2026-01-01' && gg <= '2026-01-31'
          })
          .map((a) => a.scheda_id),
      )
      const coorte = bambini.filter((b) => schedeInCoorte.has(b.scheda_id)).length
      expect(s.righe.reduce((n, r) => n + r.bambiniVisitati, 0) + s.nonAttribuiti.bambini).toBe(coorte)
      expect(s.totale.bambiniVisitati).toBe(s.righe.reduce((n, r) => n + r.bambiniVisitati, 0))
    }
  })
})

describe('le scorciatoie del periodo (giorni civili di Roma)', () => {
  it('mese in corso e mese scorso', () => {
    const adesso = new Date('2027-01-15T12:00:00Z')
    expect(periodoMeseCorrente(adesso)).toEqual({ dal: '2027-01-01', al: '2027-01-31' })
    expect(periodoMeseScorso(adesso)).toEqual({ dal: '2026-12-01', al: '2026-12-31' })
  })

  it('la mezzanotte e mezza di Roma è già il mese dopo, anche se a Greenwich è ancora il 31', () => {
    const adesso = new Date('2026-10-31T23:30:00Z') // 00:30 del 1° novembre a Roma
    expect(periodoMeseCorrente(adesso)).toEqual({ dal: '2026-11-01', al: '2026-11-30' })
    expect(periodoMeseScorso(adesso)).toEqual({ dal: '2026-10-01', al: '2026-10-31' })
  })

  it('febbraio bisestile', () => {
    expect(periodoMeseCorrente(new Date('2028-02-10T12:00:00Z'))).toEqual({ dal: '2028-02-01', al: '2028-02-29' })
    expect(periodoMeseScorso(new Date('2028-03-10T12:00:00Z'))).toEqual({ dal: '2028-02-01', al: '2028-02-29' })
  })

  it('da settembre: dal 1° settembre dell’anno scolastico in corso a fine mese', () => {
    expect(periodoDaSettembre(new Date('2026-11-20T12:00:00Z'))).toEqual({ dal: '2026-09-01', al: '2026-11-30' })
    expect(periodoDaSettembre(new Date('2027-01-15T12:00:00Z'))).toEqual({ dal: '2026-09-01', al: '2027-01-31' })
    // a luglio l'anno scolastico in corso è cominciato a settembre dell'anno prima
    expect(periodoDaSettembre(new Date('2027-07-10T12:00:00Z'))).toEqual({ dal: '2026-09-01', al: '2027-07-31' })
    // il 1° settembre ne è già il primo giorno
    expect(periodoDaSettembre(new Date('2026-09-01T07:00:00Z'))).toEqual({ dal: '2026-09-01', al: '2026-09-30' })
  })
})
