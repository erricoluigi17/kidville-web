/**
 * T26 — «si conta ciò che è già accaduto», in un posto solo.
 *
 * L'assunzione infranta è scritta per esteso in `parent/primaria/assenze:GET`:
 * fino al 2026-08-07 `presenze` aveva UNA sola sorgente di scrittura — il
 * docente, sul giorno corrente — quindi «una riga di presenze è un giorno già
 * trascorso» era vero per COSTRUZIONE, e tutti i consumatori sono stati scritti
 * su quel presupposto. «Comunica un'assenza» ne ha introdotta una seconda, che
 * scrive `data >= oggi`.
 *
 * La correzione del ciclo precedente è andata sui DUE consumatori su cui era
 * stato scritto il rilievo, non sulla regola: il registro del docente contava
 * ancora «2 A» e «10 ORE» per un alunno con una sola assenza avvenuta e una
 * comunicata per dodici giorni nel futuro, e gli stessi numeri finivano nel PDF.
 * Il monte ore della primaria è il numero con cui si valuta la validità
 * dell'anno scolastico: un genitore poteva gonfiarlo con sessanta giorni di
 * anticipo.
 *
 * «una regola valida per due strade deve vivere in un posto solo» — la lezione
 * è già scritta in `src/lib/presenze/limiti-testo.ts`.
 */
import { describe, it, expect } from 'vitest'
import {
  eAssenzaSoloAnnunciata,
  eFattoDelRegistro,
  eGiornoTrascorso,
  FILTRO_FATTI,
  limitaAiFatti,
  limitaAOggi,
  soloFatti,
  soloTrascorsi,
} from '@/lib/presenze/finestra-trascorsa'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'

describe('eGiornoTrascorso', () => {
  it('oggi CONTA (`lte`, non `lt`)', () => {
    // Con `lt` l'appello fatto stamattina resterebbe invisibile fino a domani:
    // si toglierebbe un dato VERO per nascondere un dato futuro. È la stessa
    // definizione già scelta dalle due rotte corrette nel ciclo precedente.
    expect(eGiornoTrascorso('2026-08-08', '2026-08-08')).toBe(true)
  })

  it('ieri conta, domani no', () => {
    expect(eGiornoTrascorso('2026-08-07', '2026-08-08')).toBe(true)
    expect(eGiornoTrascorso('2026-08-09', '2026-08-08')).toBe(false)
    expect(eGiornoTrascorso('2026-12-31', '2026-08-08')).toBe(false)
  })

  it('senza il secondo argomento usa OGGI in Europe/Rome, non UTC', () => {
    // `new Date().toISOString()` fra mezzanotte e le due italiane restituisce
    // ancora ieri: è il difetto per cui esiste `oggiFiscaleISO()`.
    expect(eGiornoTrascorso(oggiFiscaleISO())).toBe(true)
  })

  it('una data illeggibile NON viene contata (in dubbio non si somma)', () => {
    expect(eGiornoTrascorso('', '2026-08-08')).toBe(false)
    expect(eGiornoTrascorso('non-una-data', '2026-08-08')).toBe(false)
  })
})

describe('soloTrascorsi', () => {
  it('tiene solo le righe già avvenute, qualunque sia il nome del campo data', () => {
    const righe = [
      { data: '2026-08-01', stato: 'assente' },
      { data: '2026-08-08', stato: 'assente' },
      { data: '2026-08-20', stato: 'assente' },
    ]
    expect(soloTrascorsi(righe, (r) => r.data, '2026-08-08')).toHaveLength(2)
  })
})

describe('limitaAOggi', () => {
  it('appende `.lte(colonna, oggi)` alla query', () => {
    const visti: { colonna: string; valore: string }[] = []
    const finta = { lte(colonna: string, valore: string) { visti.push({ colonna, valore }); return this } }
    limitaAOggi(finta, 'data')
    expect(visti).toEqual([{ colonna: 'data', valore: oggiFiscaleISO() }])
  })

  it('il nome della colonna è dichiarato dal chiamante (`data` è solo il default)', () => {
    const visti: string[] = []
    const finta = { lte(colonna: string) { visti.push(colonna); return this } }
    limitaAOggi(finta)
    limitaAOggi(finta, 'giorno')
    expect(visti).toEqual(['data', 'giorno'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Q4 — IL SECONDO ASSE: «ANNUNCIATO» NON È «ACCADUTO».
//
// Il taglio temporale non può, per costruzione, escludere una riga che cade su
// OGGI: `oggi <= oggi` è vero sempre. E `oggi` non è un caso di bordo — è il
// valore PREIMPOSTATO del modulo su entrambe le schermate. Con una sola POST il
// badge della home passava a «ASSENTE», il riepilogo dei 30 giorni da 0 a 1 e il
// monte ore della primaria da 0 a 5,25 ore, senza che nessun docente avesse
// registrato niente.
// ═════════════════════════════════════════════════════════════════════════════

describe('eAssenzaSoloAnnunciata', () => {
  it('assenza scritta dal genitore e mai lavorata dall’appello → annuncio', () => {
    expect(eAssenzaSoloAnnunciata({ stato: 'assente', giustificata_da: 'g-1', registrato_da: null })).toBe(true)
  })

  it('appena il docente la lavora smette di essere un annuncio', () => {
    expect(eAssenzaSoloAnnunciata({ stato: 'assente', giustificata_da: 'g-1', registrato_da: 'd-1' })).toBe(false)
  })

  it('LE 36 RIGHE STORICHE NON SONO ANNUNCI, e questo è il punto della misura', () => {
    // Misurato in produzione il 2026-08-08: 49 righe in `presenze`, 36 con
    // `registrato_da IS NULL` e `giustificata_da IS NULL` — appelli VERI dello
    // 0-6 scritti prima che `attendance/daily:POST` valorizzasse la colonna.
    // Il predicato «è un fatto solo se `registrato_da IS NOT NULL`», che il
    // rilievo proponeva alla lettera, le avrebbe cancellate da ogni conteggio:
    // 2 assenze infanzia + 1 assenza e 3 ritardi primaria spariti dal registro.
    expect(eAssenzaSoloAnnunciata({ stato: 'assente', giustificata_da: null, registrato_da: null })).toBe(false)
    expect(eAssenzaSoloAnnunciata({ stato: 'presente', giustificata_da: null, registrato_da: null })).toBe(false)
  })

  it('un RITARDO giustificato dal genitore su una riga storica resta un fatto', () => {
    // `giustifica:POST` scrive `giustificata_da` su una riga che ESISTE GIÀ: se
    // quella riga è una delle storiche senza `registrato_da`, le sole due
    // colonne della sorgente la farebbero sembrare un annuncio. Un annuncio è
    // sempre e solo un'ASSENZA: è la cintura che tiene fuori le 10 righe
    // storiche di primaria (6 presenze, 3 ritardi, 1 uscita).
    expect(eAssenzaSoloAnnunciata({ stato: 'ritardo', giustificata_da: 'g-1', registrato_da: null })).toBe(false)
  })
})

describe('eFattoDelRegistro', () => {
  const OGGI = '2026-08-08'

  it('l’assenza annunciata OGGI non è un fatto, anche se la data è «trascorsa»', () => {
    const riga = { data: OGGI, stato: 'assente', giustificata_da: 'g-1', registrato_da: null }
    expect(eGiornoTrascorso(riga.data, OGGI), 'il taglio temporale da solo la lascia passare').toBe(true)
    expect(eFattoDelRegistro(riga, OGGI)).toBe(false)
  })

  it('l’appello del docente di stamattina È un fatto', () => {
    expect(eFattoDelRegistro({ data: OGGI, stato: 'assente', giustificata_da: null, registrato_da: 'd-1' }, OGGI)).toBe(true)
  })

  it('il giorno futuro resta escluso dal taglio temporale', () => {
    expect(eFattoDelRegistro({ data: '2026-09-20', stato: 'assente', giustificata_da: null, registrato_da: 'd-1' }, OGGI)).toBe(false)
  })

  it('la riga storica senza `registrato_da` continua a contare', () => {
    expect(eFattoDelRegistro({ data: '2026-07-23', stato: 'assente', giustificata_da: null, registrato_da: null }, OGGI)).toBe(true)
  })
})

describe('soloFatti', () => {
  it('toglie l’annuncio di oggi e il futuro, tiene l’appello e lo storico', () => {
    const righe = [
      { data: '2026-07-23', stato: 'assente', giustificata_da: null, registrato_da: null },   // storica 0-6
      { data: '2026-08-08', stato: 'assente', giustificata_da: null, registrato_da: 'd-1' },  // appello di oggi
      { data: '2026-08-08', stato: 'assente', giustificata_da: 'g-1', registrato_da: null },  // annuncio di oggi
      { data: '2026-08-20', stato: 'assente', giustificata_da: 'g-1', registrato_da: null },  // annuncio futuro
    ]
    expect(soloFatti(righe, (r) => r.data, '2026-08-08').map((r) => r.data)).toEqual(['2026-07-23', '2026-08-08'])
  })
})

describe('limitaAiFatti', () => {
  it('appende il tetto temporale E il filtro sulla sorgente', () => {
    const lte: { colonna: string; valore: string }[] = []
    const or: string[] = []
    const finta = {
      lte(colonna: string, valore: string) { lte.push({ colonna, valore }); return this },
      or(filtro: string) { or.push(filtro); return this },
    }
    limitaAiFatti(finta)
    expect(lte).toEqual([{ colonna: 'data', valore: oggiFiscaleISO() }])
    expect(or, 'senza questo filtro il `.lte` non può escludere una riga che cade su OGGI').toEqual([FILTRO_FATTI])
  })

  it('il filtro è una DISGIUNZIONE: nega la sola congiunzione dell’annuncio', () => {
    // `or=(a,b,c)` è «a OR b OR c», cioè NOT(annuncio) = NOT(giustificata_da NOT
    // NULL AND registrato_da IS NULL AND stato = 'assente'). Scritto in un posto
    // solo perché una virgola di troppo qui toglie righe vere dal registro.
    expect(FILTRO_FATTI).toBe('giustificata_da.is.null,registrato_da.not.is.null,stato.neq.assente')
  })
})
