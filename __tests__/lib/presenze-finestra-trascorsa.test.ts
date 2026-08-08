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
  FILTRO_NON_ANNUNCIO,
  filtroFatti,
  finestraAnnuncioAperta,
  limitaAgliAnnunciAperti,
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
    expect(or, 'senza questo filtro il `.lte` non può escludere una riga che cade su OGGI').toEqual([
      filtroFatti(oggiFiscaleISO()),
    ])
  })

  it('il filtro è una DISGIUNZIONE: nega la sola congiunzione dell’annuncio', () => {
    // `or=(a,b,c)` è «a OR b OR c», cioè NOT(annuncio) = NOT(giustificata_da NOT
    // NULL AND registrato_da IS NULL AND stato = 'assente'). Scritto in un posto
    // solo perché una virgola di troppo qui toglie righe vere dal registro.
    expect(FILTRO_NON_ANNUNCIO).toBe('giustificata_da.is.null,registrato_da.not.is.null,stato.neq.assente')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// R15 — L'ANNUNCIO HA UNA FINE.
//
// La distinzione «annunciato ≠ accaduto» è stata introdotta senza un termine
// sulla DATA: `eAssenzaSoloAnnunciata` non riceveva `riga.data`, quindi
// «annuncio» era una proprietà PERMANENTE della riga invece che una proprietà
// del giorno in cui la si guarda. Due conseguenze misurate:
//
//  (a) un'assenza comunicata dal genitore e mai confermata dall'appello restava
//      invisibile PER SEMPRE — registro del docente, monte ore della primaria,
//      riepilogo della home, cronologia;
//  (b) un'assenza VERA già a registro e priva di `registrato_da` (le 36 righe
//      storiche) SPARIVA da tutti quei conteggi nell'istante in cui il genitore
//      la giustificava — cioè il gesto che l'app gli chiede di fare.
//
// La regola: un annuncio è tale finché parla di un giorno che il genitore può
// ancora RITIRARE (`data >= oggi`, la stessa finestra di
// `comunica-assenza:DELETE`). Dal giorno dopo è l'unica affermazione esistente
// su un giorno concluso, ed è firmata: torna a essere un fatto.
// ═════════════════════════════════════════════════════════════════════════════

describe('finestraAnnuncioAperta', () => {
  const OGGI = '2026-08-08'

  it('è aperta su OGGI e sul futuro — ed è la stessa finestra dell’ANNULLAMENTO', () => {
    // `comunica-assenza:DELETE` rifiuta con 400 `ASSENZA_DATA_PASSATA` esattamente
    // `data < oggi`: finché il genitore può ritirare la comunicazione, quella
    // comunicazione è un annuncio. Due regole gemelle scritte a mano in due file
    // divergono; questa vive in un posto solo.
    expect(finestraAnnuncioAperta(OGGI, OGGI)).toBe(true)
    expect(finestraAnnuncioAperta('2026-08-20', OGGI)).toBe(true)
  })

  it('si chiude a mezzanotte del giorno annunciato', () => {
    expect(finestraAnnuncioAperta('2026-08-07', OGGI)).toBe(false)
    expect(finestraAnnuncioAperta('2026-07-15', OGGI)).toBe(false)
  })

  it('senza una data leggibile resta APERTA: in dubbio non si afferma un fatto', () => {
    // Il chiamante che non porta la data è `parent/presenze:GET` sul badge di
    // OGGI (`.eq('data', oggiData)`): lì «annuncio» è la risposta giusta. E in
    // generale promuovere a fatto una riga di cui non si sa il giorno è il modo
    // per far comparire «ASSENTE» sulla home di un bambino che è a scuola.
    expect(finestraAnnuncioAperta(undefined, OGGI)).toBe(true)
    expect(finestraAnnuncioAperta(null, OGGI)).toBe(true)
    expect(finestraAnnuncioAperta('non-una-data', OGGI)).toBe(true)
  })
})

describe('eAssenzaSoloAnnunciata · l’annuncio scade', () => {
  const OGGI = '2026-08-08'

  it('l’annuncio di IERI non è più un annuncio: il giorno è concluso e nessuno l’ha smentito', () => {
    expect(
      eAssenzaSoloAnnunciata(
        { stato: 'assente', giustificata_da: 'g-1', registrato_da: null, data: '2026-08-07' },
        OGGI,
      ),
    ).toBe(false)
  })

  it('l’annuncio di OGGI resta un annuncio: l’appello può ancora smentirlo', () => {
    expect(
      eAssenzaSoloAnnunciata(
        { stato: 'assente', giustificata_da: 'g-1', registrato_da: null, data: OGGI },
        OGGI,
      ),
    ).toBe(true)
  })

  it('l’annuncio per un giorno FUTURO resta un annuncio', () => {
    expect(
      eAssenzaSoloAnnunciata(
        { stato: 'assente', giustificata_da: 'g-1', registrato_da: null, data: '2026-09-20' },
        OGGI,
      ),
    ).toBe(true)
  })
})

describe('eFattoDelRegistro · i due casi di R15', () => {
  const OGGI = '2026-08-08'

  it('(a) l’assenza comunicata per un giorno ORMAI PASSATO conta nel registro', () => {
    // Il caso che non finiva mai: comunicata il 5, mai confermata dall'appello,
    // e ancora invisibile il 20 — nel monte ore con cui si valuta la validità
    // dell'anno scolastico.
    expect(
      eFattoDelRegistro(
        { data: '2026-08-05', stato: 'assente', giustificata_da: 'g-1', registrato_da: null },
        OGGI,
      ),
    ).toBe(true)
  })

  it('(b) l’assenza storica NON sparisce quando il genitore la giustifica', () => {
    // La stessa riga, prima e dopo il gesto che l'app chiede al genitore: il 15
    // luglio è passato da ventiquattro giorni e resta un fatto in entrambi gli
    // istanti. Prima del rimedio la seconda riga era `false`.
    const prima = { data: '2026-07-15', stato: 'assente', giustificata_da: null, registrato_da: null }
    expect(eFattoDelRegistro(prima, OGGI)).toBe(true)
    expect(eFattoDelRegistro({ ...prima, giustificata_da: 'g-1' }, OGGI)).toBe(true)
  })

  it('l’annuncio di oggi e quello futuro restano fuori (il rimedio non si mangia se stesso)', () => {
    expect(eFattoDelRegistro({ data: OGGI, stato: 'assente', giustificata_da: 'g-1', registrato_da: null }, OGGI)).toBe(false)
    expect(eFattoDelRegistro({ data: '2026-08-20', stato: 'assente', giustificata_da: 'g-1', registrato_da: null }, OGGI)).toBe(false)
  })
})

describe('soloFatti · con la scadenza dell’annuncio', () => {
  it('tiene l’annuncio scaduto, toglie quello di oggi e quello futuro', () => {
    const righe = [
      { data: '2026-08-05', stato: 'assente', giustificata_da: 'g-1', registrato_da: null },  // annuncio SCADUTO → fatto
      { data: '2026-08-08', stato: 'assente', giustificata_da: 'g-1', registrato_da: null },  // annuncio di oggi
      { data: '2026-08-20', stato: 'assente', giustificata_da: 'g-1', registrato_da: null },  // annuncio futuro
    ]
    expect(soloFatti(righe, (r) => r.data, '2026-08-08').map((r) => r.data)).toEqual(['2026-08-05'])
  })
})

describe('filtroFatti · la stessa scadenza lato PostgREST', () => {
  it('porta il QUARTO termine: la data già passata basta da sola a fare un fatto', () => {
    expect(filtroFatti('2026-08-08')).toBe(
      'giustificata_da.is.null,registrato_da.not.is.null,stato.neq.assente,data.lt.2026-08-08',
    )
  })

  it('il quarto termine usa la STESSA colonna del tetto temporale', () => {
    expect(filtroFatti('2026-08-08', 'giorno')).toContain('giorno.lt.2026-08-08')
  })

  it('un `oggi` malformato non entra nella stringa di filtro', () => {
    // La stringa finisce dentro `or=(…)` di PostgREST: un valore arbitrario ci
    // aggiungerebbe termini. Nessun chiamante lo fa oggi — tutti passano
    // `oggiFiscaleISO()` — e il presidio serve perché continui a essere vero.
    const sporco = filtroFatti('2026-08-08),alunno_id.not.is.null,(')
    expect(sporco).not.toContain('alunno_id')
    expect(sporco).toContain(`data.lt.${oggiFiscaleISO()}`)
  })

  it('limitaAiFatti manda a PostgREST il filtro CON la data, non i soli tre termini', () => {
    const or: string[] = []
    const finta = {
      lte() { return this },
      or(filtro: string) { or.push(filtro); return this },
    }
    limitaAiFatti(finta, 'data', '2026-08-08')
    expect(or).toEqual(['giustificata_da.is.null,registrato_da.not.is.null,stato.neq.assente,data.lt.2026-08-08'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// LE DUE STRADE DELLA STESSA REGOLA DEVONO DIRE LA STESSA COSA.
//
// La regola vive in due forme perché i conteggi si fanno in due posti: in
// MEMORIA (`eFattoDelRegistro`, quando le righe sono già scaricate) e nel
// DATABASE (`filtroFatti` + `.lte`, quando si conta con `head: true`). Sono due
// implementazioni della stessa frase, e finora nessuna prova le confrontava: il
// difetto R15 è nato esattamente lì — il termine sulla data è stato dimenticato
// in ENTRAMBE, e nessun test poteva accorgersene perché ognuna era coerente con
// se stessa.
//
// Il valutatore qui sotto interpreta le clausole PostgREST che usiamo (`is.null`,
// `not.is.null`, `neq`, `lt`) in disgiunzione, come fa `or=(…)`. Non è un motore
// SQL: è il minimo che serve per far parlare le due strade.
// ═════════════════════════════════════════════════════════════════════════════

type RigaFinta = { data: string; stato: string; giustificata_da: string | null; registrato_da: string | null }

/** Valuta una clausola `campo.op[.valore]` su una riga. */
function clausolaVera(clausola: string, riga: RigaFinta): boolean {
  const [campo, ...resto] = clausola.split('.')
  const op = resto.join('.')
  const valore = (riga as unknown as Record<string, string | null>)[campo] ?? null
  if (op === 'is.null') return valore === null
  if (op === 'not.is.null') return valore !== null
  if (op.startsWith('neq.')) return valore !== op.slice(4)
  if (op.startsWith('lt.')) return valore !== null && valore < op.slice(3)
  throw new Error(`clausola PostgREST non prevista dal valutatore: ${clausola}`)
}

/** `.lte(colonna, oggi)` + `or=(…)`, cioè ciò che il DATABASE tiene davvero. */
function tenutaDalDatabase(riga: RigaFinta, oggi: string): boolean {
  if (!(riga.data <= oggi)) return false
  return filtroFatti(oggi).split(',').some((c) => clausolaVera(c, riga))
}

describe('la regola in memoria e la regola in PostgREST danno lo stesso verdetto', () => {
  const OGGI = '2026-08-08'
  const CASI: { nome: string; riga: RigaFinta }[] = [
    { nome: 'annuncio di oggi', riga: { data: OGGI, stato: 'assente', giustificata_da: 'g', registrato_da: null } },
    { nome: 'annuncio futuro', riga: { data: '2026-08-20', stato: 'assente', giustificata_da: 'g', registrato_da: null } },
    { nome: 'annuncio SCADUTO', riga: { data: '2026-08-05', stato: 'assente', giustificata_da: 'g', registrato_da: null } },
    { nome: 'appello del docente di oggi', riga: { data: OGGI, stato: 'assente', giustificata_da: null, registrato_da: 'd' } },
    { nome: 'riga storica senza registrato_da', riga: { data: '2026-07-15', stato: 'assente', giustificata_da: null, registrato_da: null } },
    { nome: 'riga storica poi GIUSTIFICATA dal genitore', riga: { data: '2026-07-15', stato: 'assente', giustificata_da: 'g', registrato_da: null } },
    { nome: 'ritardo storico giustificato', riga: { data: '2026-07-15', stato: 'ritardo', giustificata_da: 'g', registrato_da: null } },
    { nome: 'presenza di oggi', riga: { data: OGGI, stato: 'presente', giustificata_da: null, registrato_da: 'd' } },
  ]

  for (const { nome, riga } of CASI) {
    it(`${nome}: stesso verdetto in memoria e nel database`, () => {
      expect(tenutaDalDatabase(riga, OGGI)).toBe(eFattoDelRegistro(riga, OGGI))
    })
  }

  it('il valutatore di clausole funziona davvero (altrimenti l’equivalenza è vuota)', () => {
    const riga: RigaFinta = { data: '2026-08-05', stato: 'assente', giustificata_da: 'g', registrato_da: null }
    expect(clausolaVera('giustificata_da.is.null', riga)).toBe(false)
    expect(clausolaVera('registrato_da.not.is.null', riga)).toBe(false)
    expect(clausolaVera('stato.neq.assente', riga)).toBe(false)
    expect(clausolaVera('data.lt.2026-08-08', riga)).toBe(true)
    // …e i TRE termini della sola sorgente la escluderebbero: è il difetto R15,
    // riprodotto qui sopra la riga che lo chiude.
    expect(FILTRO_NON_ANNUNCIO.split(',').some((c) => clausolaVera(c, riga))).toBe(false)
    expect(filtroFatti('2026-08-08').split(',').some((c) => clausolaVera(c, riga))).toBe(true)
  })
})

// =============================================================================
// `limitaAgliAnnunciAperti` — il verso POSITIVO della stessa finestra.
//
// L'elenco «assenze già comunicate» della home genitore (quello col bottone
// «Annulla») componeva a mano i tre termini che lo definiscono. Coincidevano con
// `eAssenzaSoloAnnunciata` e con ciò che `comunica-assenza:DELETE` accetta di
// annullare — finché qualcuno non avesse toccato uno solo dei due posti: il
// genitore avrebbe visto «Annulla» su una riga che il server rifiuta, o non
// l'avrebbe visto su una che poteva ancora ritirare.
//
// Questo blocco non prova che la funzione «funziona»: prova che le DUE FACCE
// della stessa regola restano d'accordo. È l'unica cosa che il ricopiare non
// garantiva.
// =============================================================================
describe('l’elenco annullabile e il predicato dicono la stessa cosa', () => {
  const OGGI = '2026-08-08'

  /** Registra i termini che la query riceve, invece di eseguirli. */
  function queryFinta() {
    const termini: string[] = []
    const q = {
      gte: (c: string, v: string) => { termini.push(`${c}>=${v}`); return q },
      not: (c: string, op: string, v: null) => { termini.push(`${c} not ${op} ${v}`); return q },
      is: (c: string, v: null) => { termini.push(`${c} is ${v}`); return q },
    }
    return { q, termini }
  }

  /** La riga passerebbe i termini raccolti? */
  function tenutaDallaQuery(riga: RigaFinta, oggi: string): boolean {
    const { q, termini } = queryFinta()
    limitaAgliAnnunciAperti(q, 'data', oggi)
    return termini.every((t) => {
      if (t.startsWith('data>=')) return (riga.data ?? '') >= t.slice('data>='.length)
      if (t === 'giustificata_da not is null') return riga.giustificata_da != null
      if (t === 'registrato_da is null') return riga.registrato_da == null
      throw new Error(`termine non modellato: ${t}`)
    })
  }

  const CASI: Array<{ nome: string; riga: RigaFinta }> = [
    { nome: 'annuncio per domani', riga: { data: '2026-08-09', stato: 'assente', giustificata_da: 'g', registrato_da: null } },
    { nome: 'annuncio per oggi', riga: { data: OGGI, stato: 'assente', giustificata_da: 'g', registrato_da: null } },
    { nome: 'annuncio di IERI (il giorno è concluso)', riga: { data: '2026-08-07', stato: 'assente', giustificata_da: 'g', registrato_da: null } },
    { nome: 'appello già fatto sullo stesso giorno', riga: { data: OGGI, stato: 'assente', giustificata_da: 'g', registrato_da: 'd' } },
    { nome: 'assenza del docente, mai comunicata dal genitore', riga: { data: OGGI, stato: 'assente', giustificata_da: null, registrato_da: 'd' } },
  ]

  for (const { nome, riga } of CASI) {
    it(`${nome}: l'elenco e il predicato concordano`, () => {
      expect(tenutaDallaQuery(riga, OGGI)).toBe(eAssenzaSoloAnnunciata(riga, OGGI))
    })
  }

  it('i termini sono TRE, e la data non è mai una stringa arbitraria', () => {
    const { q, termini } = queryFinta()
    limitaAgliAnnunciAperti(q, 'data', 'non-una-data')
    expect(termini).toHaveLength(3)
    // Ricade sul giorno del server invece di interpolare spazzatura.
    expect(termini[0]).toMatch(/^data>=\d{4}-\d{2}-\d{2}$/)
  })

  it('il valutatore non è vacuo: una riga che NON è un annuncio viene esclusa', () => {
    expect(tenutaDallaQuery({ data: OGGI, stato: 'assente', giustificata_da: null, registrato_da: 'd' }, OGGI)).toBe(false)
    expect(tenutaDallaQuery({ data: OGGI, stato: 'assente', giustificata_da: 'g', registrato_da: null }, OGGI)).toBe(true)
  })
})
