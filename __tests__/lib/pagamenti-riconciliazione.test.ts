import { describe, it, expect } from 'vitest'
import {
  agganciaFuoriSede,
  estraiCodiciFiscali,
  hashMovimento,
  parseCsv,
  preparaAlunniPerCf,
  preparaAperti,
  sedeDedotta,
  suggerisciMatch,
  suggerisciMatchPreparato,
  type CandidatoSede,
} from '@/lib/pagamenti/riconciliazione'
import { codiceVoce } from '@/lib/pagamenti/codice-voce'
import {
  codiceDelSuggerimento,
  codiceDellaRiga,
  type SuggerimentoUi,
} from '@/components/features/admin/pagamenti/riconciliazione-ui'

// CF SINTETICI (formato valido, persone inesistenti) — repo pubblico, mai PII reale.
const CF_MARIO = 'RSSMRA85T10A562S'
const CF_LIA = 'BNCLRA90A41F205X'
const CF_TERZO = 'VRDGPP80A01H501A'
const CF_QUARTO = 'GLLNNA75M41H501B'
// Omocodia: le ultime tre cifre del comune (562) → RSN (5→R, 6→S, 2→N).
const CF_OMOCODE = 'RSSMRA85T10ARSNS'

describe('parseCsv', () => {
  it('separatore ; con intestazioni-sinonimo bancarie e importi italiani', () => {
    const csv = [
      'Data;Entrate;Descrizione;Ordinante',
      '05/09/2026;150,00;BONIFICO RETTA SETTEMBRE ROSSI MARIO;ROSSI GIUSEPPE',
      '06/09/2026;-30,00;PAGAMENTO POS;—',            // uscita → NON scartata: contata a parte
      '07/09/2026;1.234,56;SALDO GITA;BIANCHI',
    ].join('\n')
    const r = parseCsv(csv)
    expect(r.movimenti).toHaveLength(2)
    expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-09-05', importo: 150 })
    expect(r.movimenti[1].importo).toBe(1234.56)
    // ⚠️ Cambiato di proposito: l'uscita non è una riga «scartata». Prima ci finiva dentro, e
    // sull'estratto annuale l'operatore leggeva «2.225 righe scartate» su un import riuscito.
    expect(r.scartate).toBe(0)
    expect(r.uscite).toBe(1)
  })

  it('separatore , con virgolette e date ISO', () => {
    const csv = 'date,amount,description\n2026-09-05,"150.00","Retta, settembre — Rossi"\n'
    const r = parseCsv(csv)
    expect(r.movimenti).toHaveLength(1)
    expect(r.movimenti[0].causale).toContain('Retta, settembre')
  })

  it('mapping esplicito prevale sui sinonimi', () => {
    const csv = 'colA;colB\n05/09/2026;99,50\n'
    const r = parseCsv(csv, { data: 'colA', importo: 'colB' })
    expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-09-05', importo: 99.5 })
  })

  it('senza colonne riconoscibili → nessun movimento', () => {
    const r = parseCsv('foo;bar\n1;2\n')
    expect(r.movimenti).toHaveLength(0)
  })
})

describe('hashMovimento', () => {
  const m = { data_operazione: '2026-09-05', importo: 150, causale: 'Bonifico Rossi', controparte: '' }
  it('stabile e sensibile ai campi chiave', () => {
    expect(hashMovimento(m)).toBe(hashMovimento({ ...m }))
    expect(hashMovimento(m)).not.toBe(hashMovimento({ ...m, importo: 151 }))
    expect(hashMovimento(m)).not.toBe(hashMovimento({ ...m, data_operazione: '2026-09-06' }))
  })
})

describe('suggerisciMatch', () => {
  const aperti = [
    { id: 'p1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_nome: 'Mario Rossi' },
    { id: 'p2', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_nome: 'Lia Bianchi' },
    { id: 'p3', descrizione: 'Gita zoo', importo: 25, importo_pagato: 0, alunno_nome: 'Mario Rossi' },
  ]

  it('importo esatto + nome in causale → suggerito con distacco', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: 'BONIFICO RETTA SETTEMBRE ROSSI MARIO', controparte: '' },
      aperti,
    )
    expect(r.stato).toBe('suggerito')
    expect(r.suggerimenti[0].pagamento_id).toBe('p1')
    expect(r.suggerimenti[0].score).toBeGreaterThanOrEqual(75)
  })

  it('due candidati equivalenti (solo importo) → da_abbinare con entrambi i suggerimenti', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: 'BONIFICO', controparte: '' },
      aperti,
    )
    expect(r.stato).toBe('da_abbinare')
    expect(r.suggerimenti.length).toBeGreaterThanOrEqual(2)
  })

  it('nessun segnale → da_abbinare senza suggerimenti', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 999, causale: 'GIROCONTO INTERNO', controparte: '' },
      aperti,
    )
    expect(r.stato).toBe('da_abbinare')
    expect(r.suggerimenti).toHaveLength(0)
  })

  it('nessun CF nel movimento → nessun campo multi/cf_match (retro-compatibile)', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: 'BONIFICO RETTA SETTEMBRE ROSSI MARIO', controparte: '' },
      aperti,
    )
    expect(r.multi).toBeUndefined()
    expect(r.cf_match).toBeUndefined()
    expect(r.suggerimenti[0].pagamento_id).toBe('p1')
  })
})

describe('estraiCodiciFiscali', () => {
  it('CF valido riconosciuto, in mezzo al rumore', () => {
    expect(estraiCodiciFiscali(`BONIFICO SEPA ${CF_MARIO} RETTA SETTEMBRE`)).toEqual([CF_MARIO])
  })

  it('normalizza a maiuscolo', () => {
    expect(estraiCodiciFiscali(CF_MARIO.toLowerCase())).toEqual([CF_MARIO])
  })

  it('CF con omocodia (cifre sostituite da lettere) riconosciuto', () => {
    expect(estraiCodiciFiscali(`PAGAMENTO ${CF_OMOCODE} GRAZIE`)).toContain(CF_OMOCODE)
  })

  it('due CF distinti → entrambi, senza duplicati', () => {
    const r = estraiCodiciFiscali(`FRATELLI ${CF_MARIO} E ${CF_LIA} ${CF_MARIO}`)
    expect(r).toHaveLength(2)
    expect(r).toEqual(expect.arrayContaining([CF_MARIO, CF_LIA]))
  })

  it('CF spezzato da spazi ma delimitato da punteggiatura → riconosciuto (variante senza spazi)', () => {
    // Alcuni export bancari spezzano il CF: la variante senza spazi lo ricompone.
    expect(estraiCodiciFiscali('RIF/RSSMRA 85T10A562S/BONIFICO')).toContain(CF_MARIO)
  })

  it('testo benigno con parole e numeri → nessun falso positivo', () => {
    expect(estraiCodiciFiscali('STIPENDIO SETTEMBRE 2026 IMPORTO 1234,56 EUR GRAZIE')).toEqual([])
  })

  it('stringa vuota → []', () => {
    expect(estraiCodiciFiscali('')).toEqual([])
  })
})

describe('suggerisciMatch — abbinamento per codice fiscale', () => {
  const apertiCf = [
    { id: 'p1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_id: 'al-1', codice_fiscale: CF_MARIO, alunno_nome: 'Mario Rossi' },
    { id: 'p2', descrizione: 'Retta Settembre', importo: 90, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_id: 'al-2', codice_fiscale: CF_LIA, alunno_nome: 'Lia Bianchi' },
  ]

  it('CF dell’alunno nel movimento → candidato DOMINANTE (primo) e suggerito, mai auto-confermato', () => {
    const r = suggerisciMatch(
      // importo 999 NON combacia con nessun residuo: vince comunque il CF.
      { data_operazione: '2026-09-05', importo: 999, causale: `BONIFICO GENERICO ${CF_MARIO}`, controparte: '' },
      apertiCf,
    )
    expect(r.stato).toBe('suggerito')
    expect(r.suggerimenti[0].pagamento_id).toBe('p1')
    expect(r.suggerimenti[0].cf_match).toBe(true)
    expect(r.multi).toBe(false)
    expect(r.cf_match).toEqual([{ pagamento_id: 'p1', alunno_id: 'al-1' }])
  })

  it('CF (case-insensitive) confrontato ignorando maiuscole/minuscole', () => {
    const apertiLower = [{ ...apertiCf[0], codice_fiscale: CF_MARIO.toLowerCase() }]
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 999, causale: `BONIFICO ${CF_MARIO}`, controparte: '' },
      apertiLower,
    )
    expect(r.suggerimenti[0].cf_match).toBe(true)
  })

  it('≥2 alunni distinti con voci aperte → multi:true con l’elenco dei match', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 240, causale: `BONIFICO FRATELLI ${CF_MARIO} ${CF_LIA}`, controparte: '' },
      apertiCf,
    )
    expect(r.stato).toBe('suggerito')
    expect(r.multi).toBe(true)
    expect(r.cf_match).toEqual(expect.arrayContaining([
      { pagamento_id: 'p1', alunno_id: 'al-1' },
      { pagamento_id: 'p2', alunno_id: 'al-2' },
    ]))
    expect(r.suggerimenti.filter((s) => s.cf_match).length).toBeGreaterThanOrEqual(2)
  })

  it('famiglia con ≥4 alunni agganciati per CF → TUTTI i suggerimenti CF restituiti (non cappati a 3)', () => {
    // Un bonifico unico per 4 fratelli: se i suggerimenti CF si fermano a 3 (vecchio cap),
    // l'«Incasso unico» ne precompila solo 3 mentre il totale è l'intero bonifico → allocazione corta.
    const quattro = [
      { id: 'p1', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-1', codice_fiscale: CF_MARIO, alunno_nome: 'Mario Rossi' },
      { id: 'p2', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-2', codice_fiscale: CF_LIA, alunno_nome: 'Lia Bianchi' },
      { id: 'p3', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-3', codice_fiscale: CF_TERZO, alunno_nome: 'Gigi Verdi' },
      { id: 'p4', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-4', codice_fiscale: CF_QUARTO, alunno_nome: 'Anna Galli' },
    ]
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 600, causale: `BONIFICO FAMIGLIA ${CF_MARIO} ${CF_LIA} ${CF_TERZO} ${CF_QUARTO}`, controparte: '' },
      quattro,
    )
    expect(r.stato).toBe('suggerito')
    expect(r.multi).toBe(true)
    // Tutti e 4 i CF agganciati devono comparire NEI suggerimenti (prima erano cappati a 3).
    const cfSugg = r.suggerimenti.filter((s) => s.cf_match)
    expect(cfSugg).toHaveLength(4)
    expect(r.cf_match).toHaveLength(4)
    expect(cfSugg.map((s) => s.pagamento_id).sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
  })

  it('con 2 CF + molti non-CF → i CF restano tutti e si riempie fino a 3 con i non-CF', () => {
    const misti = [
      { id: 'p1', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-1', codice_fiscale: CF_MARIO, alunno_nome: 'Mario Rossi' },
      { id: 'p2', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-2', codice_fiscale: CF_LIA, alunno_nome: 'Lia Bianchi' },
      // Voci senza CF ma con match d'importo (600 non combacia: nessuna elevata, restano fuori dai motivi)
      { id: 'p3', descrizione: 'Retta', importo: 240, importo_pagato: 0, alunno_id: 'al-3', alunno_nome: 'Nome Uno' },
      { id: 'p4', descrizione: 'Retta', importo: 240, importo_pagato: 0, alunno_id: 'al-4', alunno_nome: 'Nome Due' },
    ]
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 240, causale: `BONIFICO ${CF_MARIO} ${CF_LIA}`, controparte: '' },
      misti,
    )
    // I 2 CF ci sono sempre; poi si riempie fino a 3 → almeno i 2 CF, cap standard 3.
    const cfSugg = r.suggerimenti.filter((s) => s.cf_match)
    expect(cfSugg).toHaveLength(2)
    expect(r.suggerimenti.length).toBeLessThanOrEqual(3)
  })

  it('CF che punta a un alunno SENZA voce aperta → nessuna elevazione (fallback allo score standard)', () => {
    // aperti contiene SOLO Mario; il movimento cita il CF di Lia (nessuna voce aperta)
    // ma l’importo combacia con Mario → vince Mario per importo, non per CF.
    const soloMario = [apertiCf[0]]
    const r = suggerisciMatch(
      { data_operazione: '2026-09-05', importo: 150, causale: `BONIFICO ${CF_LIA}`, controparte: '' },
      soloMario,
    )
    expect(r.multi).toBeUndefined()
    expect(r.cf_match).toBeUndefined()
    expect(r.suggerimenti[0].pagamento_id).toBe('p1')
    expect(r.suggerimenti[0].cf_match).toBeFalsy()
    expect(r.stato).toBe('da_abbinare') // solo importo (50) < soglia: non elevato
  })
})

/**
 * IL VETTORE D'ORO — l'unico modo di sorvegliare un'impronta.
 *
 * Il test qui sopra («stabile e sensibile ai campi chiave») confronta l'hash CON SÉ STESSO:
 * resterebbe verde anche riscrivendo `norm()` da capo, e con lui tornerebbero importabili
 * tutti i movimenti già in registro — cioè il doppio import, in silenzio, su un archivio che
 * da oggi non è più vuoto. Qui invece si asserisce l'ESADECIMALE LETTERALE.
 *
 * Se questa riga diventa rossa non si aggiorna il numero: si rimette a posto `norm()`.
 */
describe('hashMovimento — vettore d’oro', () => {
  const MOVIMENTO = {
    data_operazione: '2026-08-06',
    importo: 150,
    causale: 'BONIFICO A VOSTRO FAVORE DA  FABBRI GIULIA PER  RETTA SETTEMBRE TRN 1',
    controparte: '',
  }
  const ORO = 'ea6c9c7fe8a2c12438e6bb31ffb678231e512d3bf4daae20d6125b69d75b6482'

  it('l’impronta di un movimento fisso è ESATTAMENTE questa', () => {
    expect(hashMovimento(MOVIMENTO)).toBe(ORO)
  })

  it('valorizzare la controparte NON cambia l’impronta', () => {
    // L'ordinante entra in `controparte`, che è FUORI dall'hash: altrimenti i movimenti
    // importati prima che l'ordinante si leggesse tornerebbero tutti nuovi.
    expect(hashMovimento({ ...MOVIMENTO, controparte: 'FABBRI GIULIA' })).toBe(ORO)
  })

  it('la causale INTERA è dentro l’impronta: accorciarla la cambia', () => {
    expect(hashMovimento({ ...MOVIMENTO, causale: 'BONIFICO A VOSTRO FAVORE' })).not.toBe(ORO)
  })

  /**
   * ⚠️ IL SECONDO VETTORE ESISTE PERCHÉ IL PRIMO È CIECO, e vale la pena dire dove.
   *
   * `MOVIMENTO` qui sopra è tutto ASCII: `normalize('NFD')` non lo cambia e lo strip dei
   * segni combinanti non ha niente da togliere. Togliendo `.replace(/[\u0300-\u036F]/g,'')`
   * da `norm()` quel vettore resta VERDE — misurato: l'intera suite resta verde. Cioè il
   * passo che rende l'impronta indipendente dagli accenti non era sorvegliato da nessuno.
   *
   * Non è teoria: durante questo lavoro quella riga è stata riscritta con gli escape
   * `\u0300-\u036F` e poi ripristinata. La riscrittura era equivalente — ma se non lo fosse
   * stata, ogni causale con una lettera accentata avrebbe cambiato impronta e sarebbe
   * tornata importabile come nuova, in silenzio.
   *
   * Oggi 0 causali su 6.840 hanno caratteri non ASCII, quindi non c'è esposizione viva.
   * Un lock non serve per oggi.
   */
  const CON_ACCENTI = {
    data_operazione: '2026-05-06',
    importo: 150,
    causale: 'BONIFICO A VOSTRO FAVORE DA  PERLINI TOMMASO PER  RETTA MAGGIO GIÀ VERSATA PERÒ IN RITARDO',
    controparte: '',
  }
  /** `sha256('2026-05-06|150.00|…gia versata pero in ritardo')` — accenti GIÀ tolti. */
  const ORO_ACCENTI = '8838b5cafe51a84b22d3c2c36ec73ecd8d8fa675f508e3366f342ace54e62de2'

  it('gli ACCENTI si tolgono prima dell’impronta: À e Ò non la cambiano', () => {
    // Senza lo strip dei segni combinanti l'impronta sarebbe `989c18f6…2ea8`: un numero
    // diverso, e ogni bonifico con un accento in causale tornerebbe «nuovo».
    expect(hashMovimento(CON_ACCENTI)).toBe(ORO_ACCENTI)
  })

  it('«GIÀ» e «GIA» sono lo STESSO movimento: l’accento non fa un doppione', () => {
    // La PROPRIETÀ, non una seconda copia del numero. Un test che confrontasse la forma
    // ASCII col letterale resterebbe verde anche togliendo lo strip — l'ho verificato
    // mutando `norm()` — perché su una causale senza accenti quel passo non fa niente:
    // sarebbe un lock che guarda dalla parte sbagliata. Qui invece si confrontano le DUE
    // forme fra loro, ed è l'uguaglianza che cade per prima quando lo strip sparisce.
    const senzaAccenti = { ...CON_ACCENTI, causale: CON_ACCENTI.causale.replace('GIÀ', 'GIA').replace('PERÒ', 'PERO') }
    expect(hashMovimento(CON_ACCENTI)).toBe(hashMovimento(senzaAccenti))
    expect(hashMovimento(senzaAccenti)).toBe(ORO_ACCENTI)
  })
})

describe('parseCsv — il guscio sopra il lettore multi-formato', () => {
  const CSV_BANCA = [
    'Rapporto IT 00 X 00000 00000 000000000000 - CONTO DI PROVA',
    ';;;;',
    'Data;;Descrizione;EUR;Caus.',
    'Operaz.;Valuta',
    '06/08/26;06/08/26;BONIFICO A VOSTRO FAVORE DA  PERLINI CARLO PER  RETTA TRN 9;150,00;048',
    '07/08/26;07/08/26;PAGAMENTO POS;-30,00;048',
  ].join('\n')

  it('il CSV della banca (preambolo, riga di soli separatori, intestazione su due righe) si legge', () => {
    const r = parseCsv(CSV_BANCA)
    expect(r.movimenti).toHaveLength(1)
    expect(r.movimenti[0].data_operazione).toBe('2026-08-06')
    expect(r.intestazioni).toEqual(['Data Operaz.', 'Valuta', 'Descrizione', 'EUR', 'Caus.'])
  })

  it('l’ordinante arriva dalla descrizione e la causale resta INTERA', () => {
    const r = parseCsv(CSV_BANCA)
    expect(r.movimenti[0].controparte).toBe('PERLINI CARLO')
    expect(r.movimenti[0].causale).toBe('BONIFICO A VOSTRO FAVORE DA  PERLINI CARLO PER  RETTA TRN 9')
  })

  it('le uscite si contano a parte dalle righe illeggibili', () => {
    const r = parseCsv(CSV_BANCA)
    expect(r.uscite).toBe(1)
    expect(r.scartate).toBe(0)
    expect(r.senzaOrdinante).toBe(0)
    expect(r.troncate).toBe(0)
  })
})

describe('suggerisciMatchPreparato — la strada veloce dà gli stessi risultati', () => {
  const aperti = [
    { id: 'p1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', alunno_nome: 'Giulia Fabbri', codice_fiscale: CF_MARIO, alunno_id: 'a1' },
    { id: 'p2', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 30, periodo_competenza: '2026-09-01', intestatario_nome: 'Luca Bianchi', codice_fiscale: CF_LIA, alunno_id: 'a2' },
    { id: 'p3', descrizione: 'Gita zoo', importo: 25, importo_pagato: 0, alunno_nome: 'Carlo Perlini', alunno_id: 'a3' },
    { id: 'p4', descrizione: 'Mensa', importo: 120, importo_pagato: null, periodo_competenza: '2026-10-01', alunno_nome: 'Giulia Fabbri', alunno_id: 'a1' },
  ]
  const movimenti = [
    { data_operazione: '2026-09-05', importo: 150, causale: 'BONIFICO RETTA SETTEMBRE GIULIA FABBRI', controparte: 'FABBRI GIULIA' },
    { data_operazione: '2026-09-06', importo: 25, causale: 'GITA ZOO CARLO PERLINI', controparte: '' },
    { data_operazione: '2026-09-07', importo: 999, causale: `BONIFICO ${CF_MARIO} E ${CF_LIA}`, controparte: '' },
    { data_operazione: '2026-10-01', importo: 120, causale: 'MENSA OTTOBRE 2026-10', controparte: 'PERLINI CARLO' },
    { data_operazione: '2026-11-01', importo: 7, causale: 'NIENTE DI RICONOSCIBILE', controparte: '' },
  ]

  it('LOCK DI EQUIVALENZA: stesso risultato, movimento per movimento', () => {
    const preparati = preparaAperti(aperti)
    for (const m of movimenti) {
      expect(suggerisciMatchPreparato(m, preparati)).toEqual(suggerisciMatch(m, aperti))
    }
  })

  it('gli `aperti` preparati si riusano su più movimenti senza consumarsi', () => {
    const preparati = preparaAperti(aperti)
    const primo = suggerisciMatchPreparato(movimenti[0], preparati)
    suggerisciMatchPreparato(movimenti[2], preparati)
    expect(suggerisciMatchPreparato(movimenti[0], preparati)).toEqual(primo)
  })
})

/**
 * ─── IL CODICE DELLA VOCE ENTRA NEL MATCHER ──────────────────────────────────
 *
 * Il codice fiscale identifica una FAMIGLIA, il codice identifica una VOCE.
 * Finché la famiglia ha una voce aperta sola i due dicono la stessa cosa; appena
 * ne ha due il CF non discrimina più — e nemmeno l'importo, perché le rette sono
 * tutte uguali (misurato in produzione il 2026-09-20: 37 movimenti rossi su 50
 * hanno più voci aperte con lo STESSO identico residuo).
 *
 * I codici non si cablano: si chiedono a `codiceVoce`, che è congelata dal lock
 * `__tests__/architecture/codice-voce-congelato.test.ts`. Cablarli qui vorrebbe
 * dire tenerne una seconda copia, e sarebbe una copia che diverge in silenzio.
 */
describe('suggerisciMatch — il codice della voce batte il codice fiscale', () => {
  /** Due voci dello STESSO bambino, stesso identico residuo: il caso misurato. */
  const dueVociUgualiDiMario = [
    { id: 'v-retta', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, alunno_id: 'al-1', codice_fiscale: CF_MARIO, alunno_nome: 'Mario Rossi' },
    { id: 'v-mensa', descrizione: 'Mensa Settembre', importo: 150, importo_pagato: 0, alunno_id: 'al-1', codice_fiscale: CF_MARIO, alunno_nome: 'Mario Rossi' },
  ]

  it('col SOLO codice fiscale le due voci pareggiano: è l’ambiguità che il codice toglie', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 150, causale: `BONIFICO ${CF_MARIO}`, controparte: '' },
      dueVociUgualiDiMario,
    )
    // Il controllo NEGATIVO del caso qui sotto: senza codice nessuno dei due segnali sceglie.
    expect(r.suggerimenti[0].score).toBe(r.suggerimenti[1].score)
    expect(r.suggerimenti.every((s) => s.codice_match === undefined)).toBe(true)
  })

  it('il CODICE vince sul CF quando puntano a voci diverse: primo il candidato nominato', () => {
    const codiceMensa = codiceVoce('v-mensa')
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 150, causale: `BONIFICO ${CF_MARIO} ${codiceMensa}`, controparte: '' },
      dueVociUgualiDiMario,
    )
    expect(r.stato).toBe('suggerito')
    expect(r.suggerimenti[0].pagamento_id).toBe('v-mensa')
    // Il distacco non è di misura: 10.000 contro 1.000 + al massimo 100 di segnali deboli.
    expect(r.suggerimenti[0].score - r.suggerimenti[1].score).toBeGreaterThan(1000)
    // La voce agganciata per solo CF NON sparisce: resta proposta, più in basso.
    expect(r.suggerimenti.map((s) => s.pagamento_id)).toContain('v-retta')
  })

  it('un codice che risolve porta `codice_match: true` e `codice_voce` VALORIZZATO', () => {
    const codiceMensa = codiceVoce('v-mensa')
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 150, causale: `RETTA ${codiceMensa} GRAZIE`, controparte: '' },
      dueVociUgualiDiMario,
    )
    const primo = r.suggerimenti[0]
    expect(primo.pagamento_id).toBe('v-mensa')
    // Il dato sta in un campo SUO, non dentro la prosa dei motivi: chi lo legge non
    // fa il parsing di una frase italiana (che una traduzione renderebbe muta).
    expect(primo.codice_match).toBe(true)
    expect(primo.codice_voce).toBe(codiceMensa)
    expect(primo.motivi).toContain('codice della voce')
    // E il candidato non agganciato non porta il campo (JSONB del registro: si pesa).
    const altro = r.suggerimenti.find((s) => s.pagamento_id === 'v-retta')
    expect(altro?.codice_match).toBeUndefined()
    expect(altro?.codice_voce).toBeUndefined()
  })

  it('un codice che non è di nessuna voce aperta non aggancia niente (nessun fuzzy)', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 999, causale: `BONIFICO ${codiceVoce('v-inesistente')}`, controparte: '' },
      dueVociUgualiDiMario,
    )
    expect(r.suggerimenti.every((s) => !s.codice_match)).toBe(true)
    expect(r.stato).toBe('da_abbinare')
  })

  it('TUTTI i `codice_match` sopravvivono al taglio: quattro voci nominate restano quattro', () => {
    // La stessa asimmetria dei `cf_match`: un bonifico che nomina quattro voci per
    // codice le perderebbe dalla quarta in giù col cap fisso a 3, e la composizione
    // allocherebbe corto sull'intero bonifico.
    const quattroVoci = ['q1', 'q2', 'q3', 'q4'].map((id, i) => ({
      id, descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: `al-${i + 1}`, alunno_nome: `Nome ${i + 1}`,
    }))
    const deboli = ['d1', 'd2', 'd3'].map((id) => ({
      id, descrizione: 'Retta', importo: 600, importo_pagato: 0, alunno_id: id, alunno_nome: 'Altro Bambino',
    }))
    const codici = quattroVoci.map((v) => codiceVoce(v.id))
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 600, causale: `BONIFICO FAMIGLIA ${codici.join(' ')}`, controparte: '' },
      [...quattroVoci, ...deboli],
    )
    const conCodice = r.suggerimenti.filter((s) => s.codice_match)
    expect(conCodice).toHaveLength(4)
    expect(conCodice.map((s) => s.pagamento_id).sort()).toEqual(['q1', 'q2', 'q3', 'q4'])
    expect(conCodice.map((s) => s.codice_voce).sort()).toEqual([...codici].sort())
    // ⚠️ E lo STATO, che qui non è un di più: le quattro voci pareggiano a 10.000,
    // quindi il distacco è ZERO e la regola delle soglie direbbe rosso. A dare il
    // giallo è il codice — il ramo che il caso qui sotto guarda in faccia.
    expect(r.suggerimenti[0].score).toBe(r.suggerimenti[3].score)
    expect(r.stato).toBe('suggerito')
  })

  it('DUE voci nominate pareggiano: il giallo lo dà il CODICE, non il distacco', () => {
    // ─── IL RAMO PER CUI ESISTE IL LOTTO, GUARDATO IN FACCIA ──────────────────
    // Due voci dello stesso bambino, stesso identico residuo, ENTRAMBE nominate
    // per codice: i punteggi pareggiano, quindi `best - second = 0` e il distacco
    // (`DISTACCO_AGGANCIO`, 20) NON è raggiunto — la regola delle soglie da sola
    // direbbe `da_abbinare`, cioè ROSSO. Lo stato lo eleva il ramo del codice, e
    // questo caso esiste per vederlo cadere: togliendo `haCodice ||` dall'OR che
    // calcola `suggerito` questa asserzione diventa rossa.
    // È il caso MISURATO in produzione il 2026-09-20: 37 movimenti rossi su 50
    // hanno più voci aperte con lo stesso identico residuo (le rette sono tutte
    // uguali), quindi né l'importo né il CF discriminano.
    const r = suggerisciMatch(
      {
        data_operazione: '2026-09-20',
        importo: 150,
        causale: `BONIFICO ${codiceVoce('v-retta')} ${codiceVoce('v-mensa')}`,
        controparte: '',
      },
      dueVociUgualiDiMario,
    )
    // La PREMESSA: pareggio perfetto fra i due agganci forti.
    expect(r.suggerimenti).toHaveLength(2)
    expect(r.suggerimenti[0].score).toBe(r.suggerimenti[1].score)
    expect(r.suggerimenti.every((s) => s.codice_match === true)).toBe(true)
    // Nessun codice fiscale in causale: l'unico segnale che può elevare è il codice.
    expect(r.cf_match).toBeUndefined()
    // LA TESI.
    expect(r.stato).toBe('suggerito')
  })

  it('codici e CF insieme: gli agganci forti si tengono tutti, i deboli riempiono fino a 3', () => {
    const misti = [
      { id: 'c1', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-1', alunno_nome: 'Uno Uno' },
      { id: 'f1', descrizione: 'Retta', importo: 150, importo_pagato: 0, alunno_id: 'al-2', codice_fiscale: CF_LIA, alunno_nome: 'Due Due' },
      { id: 'x1', descrizione: 'Retta', importo: 300, importo_pagato: 0, alunno_id: 'al-3', alunno_nome: 'Tre Tre' },
      { id: 'x2', descrizione: 'Retta', importo: 300, importo_pagato: 0, alunno_id: 'al-4', alunno_nome: 'Quattro Quattro' },
    ]
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 300, causale: `BONIFICO ${codiceVoce('c1')} ${CF_LIA}`, controparte: '' },
      misti,
    )
    expect(r.suggerimenti[0].pagamento_id).toBe('c1')
    expect(r.suggerimenti.filter((s) => s.codice_match)).toHaveLength(1)
    expect(r.suggerimenti.filter((s) => s.cf_match)).toHaveLength(1)
    expect(r.suggerimenti.length).toBeLessThanOrEqual(3)
    // `multi`/`cf_match` restano la risposta alla domanda del CF: il codice ha il campo suo.
    expect(r.cf_match).toEqual([{ pagamento_id: 'f1', alunno_id: 'al-2' }])
  })

  it('la strada veloce dice la stessa cosa anche coi codici (lock di equivalenza)', () => {
    const mov = { data_operazione: '2026-09-20', importo: 150, causale: `BONIFICO ${codiceVoce('v-mensa')}`, controparte: '' }
    expect(suggerisciMatchPreparato(mov, preparaAperti(dueVociUgualiDiMario))).toEqual(
      suggerisciMatch(mov, dueVociUgualiDiMario),
    )
  })
})

describe('sede dedotta col CODICE — un codice dentro chiude la domanda, uno fuori la apre', () => {
  const GIU = 'sc-giugliano'
  const CESA = 'sc-cesa'
  const AVE = 'sc-aversa'
  const sedi = (m: Record<string, string | null | undefined>) => (id: string) => m[id]
  const conCodice = (pagamento_id: string, score: number): CandidatoSede => ({ pagamento_id, score, codice_match: true })
  const conCf = (pagamento_id: string, score: number): CandidatoSede => ({ pagamento_id, score, cf_match: true })

  it('codice FUORI e CF DENTRO → il bonifico è dell’altra sede, e la certezza è del codice', () => {
    // Il bonifico di famiglia coi fratelli in due plessi: il CF di casa è vero e non
    // dice QUALE voce sia stata pagata. Il codice sì, ed è di Cesa.
    const candidati = [conCodice('p-cesa', 11050), conCf('p-giu', 1050)]
    expect(agganciaFuoriSede(candidati, sedi({ 'p-cesa': CESA, 'p-giu': GIU }), new Set([GIU]))).toEqual({
      scuola_id: CESA, per_cf: false, per_codice: true,
    })
    expect(sedeDedotta(candidati, sedi({ 'p-cesa': CESA, 'p-giu': GIU }))).toEqual({ scuola_id: CESA, certa: true })
  })

  it('codice DENTRO e CF FUORI → nessun verdetto: la voce nominata è qui', () => {
    const candidati = [conCodice('p-giu', 11050), conCf('p-cesa', 1050)]
    expect(agganciaFuoriSede(candidati, sedi({ 'p-giu': GIU, 'p-cesa': CESA }), new Set([GIU]))).toBeNull()
    expect(sedeDedotta(candidati, sedi({ 'p-giu': GIU, 'p-cesa': CESA }))).toEqual({ scuola_id: GIU, certa: true })
  })

  it('due codici FUORI, in due plessi diversi → vince quello col punteggio più alto', () => {
    // ─── IL GEMELLO ESATTO DEL CASO GIÀ COLLAUDATO SUI `cf_match` ──────────────
    // `__tests__/lib/pagamenti-altra-sede.test.ts:85` («due CF fuori sede → vince
    // quello col punteggio più alto») regge il comparatore del ramo `cfFuori`. Il
    // ramo del codice è stato scritto con la stessa forma ma senza la stessa prova:
    // invertendo il `>` nel `reduce` su `codiceFuori` la suite restava tutta VERDE.
    // Una riga estesa senza la prova che la regge è una riga scoperta, e qui si
    // paga il giorno in cui la rotta comincerà a emettere `codice_match` sui
    // `CandidatoSede` (oggi non lo fa: quel ramo in produzione è ancora muto, e i
    // test sono la sua unica rete). Il prezzo dell'inversione è concreto: con due
    // voci nominate per codice in due plessi fuori perimetro il popup annuncerebbe
    // il plesso sbagliato, senza che nessun gate diventi rosso.
    // I punteggi sono quelli del CF più `CODICE_BONUS`: 11.050 contro 11.075.
    const candidati = [conCodice('p-cesa', 11050), conCodice('p-ave', 11075)]
    expect(agganciaFuoriSede(candidati, sedi({ 'p-cesa': CESA, 'p-ave': AVE }), new Set([GIU]))).toEqual({
      scuola_id: AVE, per_cf: false, per_codice: true,
    })
  })

  it('due codici in due sedi diverse → nessuna vince, e la regola si difende da sola', () => {
    const candidati = [conCodice('p-giu', 11050), conCodice('p-cesa', 11050)]
    expect(sedeDedotta(candidati, sedi({ 'p-giu': GIU, 'p-cesa': CESA }))).toBeNull()
  })

  it('senza `codice_match` il verdetto è quello di ieri, chiave per chiave', () => {
    // Le righe già in registro non portano il campo nuovo: la forma del verdetto per
    // CF non cambia (nessun `per_codice` che spunta dove prima non c'era).
    expect(agganciaFuoriSede([conCf('p-cesa', 1050), { pagamento_id: 'p-giu', score: 50 }], sedi({ 'p-cesa': CESA, 'p-giu': GIU }), new Set([GIU]))).toEqual({
      scuola_id: CESA, per_cf: true,
    })
  })
})

describe('il giallo «alunno riconosciuto, nessuna voce aperta»', () => {
  const soloMario = [
    { id: 'p1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, alunno_id: 'al-1', codice_fiscale: CF_MARIO, alunno_nome: 'Mario Rossi' },
  ]
  /** Il movimento cita il CF di Lia, che non ha NESSUNA voce aperta. */
  const movimento = { data_operazione: '2026-09-20', importo: 999, causale: `BONIFICO ${CF_LIA}`, controparte: '' }

  it('SENZA il parametro nuovo il comportamento è identico a oggi', () => {
    const r = suggerisciMatch(movimento, soloMario)
    expect(r.stato).toBe('da_abbinare')
    expect(r.alunni_senza_voci).toBeUndefined()
    expect(r.motivo_stato).toBeUndefined()
    // Identico anche a un indice VUOTO: nessun campo nuovo compare dal nulla.
    expect(suggerisciMatch(movimento, soloMario, new Map())).toEqual(r)
  })

  it('CON l’indice degli alunni noti diventa `suggerito`, col motivo e con l’uuid del bambino', () => {
    const r = suggerisciMatch(movimento, soloMario, preparaAlunniPerCf([{ codice_fiscale: CF_LIA, alunno_id: 'al-2' }]))
    expect(r.stato).toBe('suggerito')
    expect(r.motivo_stato).toBe('alunno_senza_voci_aperte')
    expect(r.alunni_senza_voci).toEqual(['al-2'])
    // Nessuna voce aperta da proporre: il giallo NON inventa un suggerimento.
    expect(r.suggerimenti).toHaveLength(0)
  })

  it('un CF che ha agganciato una voce aperta NON entra fra quelli senza voci', () => {
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 150, causale: `BONIFICO ${CF_MARIO}`, controparte: '' },
      soloMario,
      preparaAlunniPerCf([{ codice_fiscale: CF_MARIO, alunno_id: 'al-1' }]),
    )
    expect(r.stato).toBe('suggerito')
    expect(r.alunni_senza_voci).toBeUndefined()
    expect(r.motivo_stato).toBeUndefined()
  })

  it('due fratelli, uno con voci e uno senza: il motivo dello STATO non si dichiara', () => {
    // Il giallo se lo sarebbe preso comunque (c'è un aggancio CF): `motivo_stato`
    // direbbe che il colore viene da questa regola, e sarebbe falso. L'elenco degli
    // alunni senza voci resta, perché serve alla composizione.
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 150, causale: `FRATELLI ${CF_MARIO} ${CF_LIA}`, controparte: '' },
      soloMario,
      preparaAlunniPerCf([{ codice_fiscale: CF_MARIO, alunno_id: 'al-1' }, { codice_fiscale: CF_LIA, alunno_id: 'al-2' }]),
    )
    expect(r.stato).toBe('suggerito')
    expect(r.alunni_senza_voci).toEqual(['al-2'])
    expect(r.motivo_stato).toBeUndefined()
  })

  it('due CF distinti dello STESSO bambino: l’uuid esce UNA volta sola', () => {
    // ─── LA PROMESSA SCRITTA NEL COMMENTO, MESSA ALLA PROVA ────────────────────
    // Sopra il ciclo c'è scritto «e un alunno si nomina una volta sola»: senza
    // questo caso era una frase che nessun test aveva mai visto fallire — togliendo
    // `|| visti.has(alunno)` la suite restava verde. Il caso è raggiungibile: la
    // chiave della mappa è il CODICE FISCALE, non l'alunno, e `preparaAlunniPerCf`
    // accetta due righe diverse che puntano allo stesso `alunno_id` (una persona
    // con la variante omocodica del proprio CF è esattamente questo). Senza la
    // guardia `alunni_senza_voci` uscirebbe con l'uuid ripetuto, e la composizione
    // aprirebbe due righe identiche sullo stesso bambino.
    const r = suggerisciMatch(
      { data_operazione: '2026-09-20', importo: 999, causale: `BONIFICO ${CF_LIA} ${CF_TERZO}`, controparte: '' },
      soloMario,
      preparaAlunniPerCf([
        { codice_fiscale: CF_LIA, alunno_id: 'al-2' },
        { codice_fiscale: CF_TERZO, alunno_id: 'al-2' },
      ]),
    )
    expect(r.stato).toBe('suggerito')
    expect(r.motivo_stato).toBe('alunno_senza_voci_aperte')
    // LA TESI: un solo uuid, non `['al-2', 'al-2']`.
    expect(r.alunni_senza_voci).toEqual(['al-2'])
  })

  it('un CF sconosciuto all’indice resta rosso: non si inventa nessun bambino', () => {
    const r = suggerisciMatch(movimento, soloMario, preparaAlunniPerCf([{ codice_fiscale: CF_TERZO, alunno_id: 'al-3' }]))
    expect(r.stato).toBe('da_abbinare')
    expect(r.alunni_senza_voci).toBeUndefined()
  })

  it('`preparaAlunniPerCf`: MAIUSCOLO, scarti e doppioni', () => {
    const indice = preparaAlunniPerCf([
      { codice_fiscale: CF_LIA.toLowerCase(), alunno_id: ' al-2 ' },
      { codice_fiscale: '', alunno_id: 'al-x' },
      { codice_fiscale: CF_TERZO, alunno_id: null },
      // Due alunni con lo STESSO codice fiscale: la chiave si toglie, non si tiene la prima.
      { codice_fiscale: CF_QUARTO, alunno_id: 'al-4' },
      { codice_fiscale: CF_QUARTO, alunno_id: 'al-5' },
    ])
    expect(indice.get(CF_LIA)).toBe('al-2')
    expect(indice.has(CF_TERZO)).toBe(false)
    expect(indice.has(CF_QUARTO)).toBe(false)
    expect(indice.size).toBe(1)
  })
})

/**
 * ⚠️ L'IMPRONTA NON SI È MOSSA, E QUESTA È LA PROVA A VETTORE CABLATO.
 *
 * `norm()` e `hashMovimento()` sono l'impronta anti-doppio-import: cambiarle — anche
 * solo per "pulizia" mentre si aggiunge un segnale al matcher — renderebbe
 * re-importabile TUTTO lo storico dell'estratto conto, in silenzio e tutto insieme.
 *
 * Il numero qui sotto NON è stato preso eseguendo il codice di oggi: è calcolato da
 * un oracolo indipendente (la specifica di `norm()` riscritta a mano: minuscolo, NFD,
 * segni combinanti tolti, spazi collassati, trim), lo stesso che riproduce alla lettera
 * i due vettori d'oro già in questa suite. La causale porta apposta tutte e quattro le
 * cose che `norm()` fa — maiuscole, accenti, spazi multipli, spazi ai bordi — **più un
 * codice della voce**, che è la novità: se qualcuno normalizzasse il testo in modo
 * diverso per farci entrare il codice, questa riga diventa rossa.
 */
describe('hashMovimento — l’impronta dopo l’ingresso del codice della voce', () => {
  const CON_CODICE = {
    data_operazione: '2026-09-20',
    importo: 150,
    causale: '  BONIFICO   #K7MXN3P  PERÒ  RETTA GIÀ VERSATA  ',
    controparte: '',
  }
  /** `sha256('2026-09-20|150.00|bonifico #k7mxn3p pero retta gia versata')`. */
  const ORO_CODICE = '5551adfd30f40ba702e730cc5d5647dacc955acc5aaa163d02f2f3288dfdcc42'

  it('l’impronta di una causale CON codice è ESATTAMENTE questa', () => {
    expect(hashMovimento(CON_CODICE)).toBe(ORO_CODICE)
  })

  it('il sigillo `#` fa parte della causale: toglierlo cambia l’impronta', () => {
    // Non è pedanteria: se `norm()` cominciasse a ripulire i sigilli «tanto il codice
    // lo si estrae a parte», ogni movimento con un codice in causale tornerebbe nuovo.
    //
    // ⚠️ Il confronto è con l'impronta CALCOLATA, non con `ORO_CODICE`. Contro la
    // costante congelata questa riga sarebbe decorazione: qualunque ritocco a `norm()`
    // sposta lontano dall'oro ANCHE la variante senza `#`, quindi il `not.toBe`
    // resterebbe verde proprio nella mutazione che esiste per catturare — un `norm()`
    // che ripulisce il sigillo, cioè il caso in cui togliere il `#` NON cambia più
    // niente. Confrontando i due hash fra loro, quella mutazione fa cadere questo caso
    // oltre al vettore d'oro qui sopra.
    expect(hashMovimento({ ...CON_CODICE, causale: CON_CODICE.causale.replace('#', '') })).not.toBe(hashMovimento(CON_CODICE))
  })

  it('maiuscole, accenti e spazi doppi restano indifferenti (la PROPRIETÀ, non il numero)', () => {
    const pulita = { ...CON_CODICE, causale: 'bonifico #k7mxn3p pero retta gia versata' }
    expect(hashMovimento(pulita)).toBe(hashMovimento(CON_CODICE))
  })
})

/**
 * IL CODICE COME DATO LATO CLIENT — letto dal campo, mai dalla frase.
 *
 * Sta in questo file e non accanto agli altri collaudi della pelle
 * (`__tests__/pagamenti/riconciliazione-ui.test.ts`) perché è il gemello esatto del
 * campo aggiunto qui sopra: la sorgente (`Suggerimento.codice_voce`) e il lettore
 * devono cadere insieme se qualcuno tornasse a dedurre il codice dai `motivi`.
 */
describe('riconciliazione-ui — il codice si legge dal campo strutturato', () => {
  it('un suggerimento agganciato per codice consegna il codice; gli altri `null`', () => {
    expect(codiceDelSuggerimento({ pagamento_id: 'p1', score: 11050, motivi: ['codice della voce'], codice_match: true, codice_voce: '#K7MXN3P' })).toBe('#K7MXN3P')
    expect(codiceDelSuggerimento({ pagamento_id: 'p1', score: 1050, motivi: ['codice fiscale'], cf_match: true })).toBeNull()
    expect(codiceDelSuggerimento(null)).toBeNull()
  })

  it('la PROSA non basta: un motivo senza il campo non produce nessun codice', () => {
    // È il difetto che il campo esiste per impedire: `motivi.includes('codice della
    // voce')` diventerebbe muto alla prima traduzione, e in silenzio.
    expect(codiceDelSuggerimento({ pagamento_id: 'p1', score: 11050, motivi: ['codice della voce'] })).toBeNull()
  })

  it('lo specchio: `codice_voce` SENZA il flag non consegna niente — decide il flag', () => {
    // A dire «questo candidato è agganciato per codice» è `codice_match`, non la
    // presenza della stringa: il campo è il VERDETTO, `codice_voce` solo il dato
    // che lo accompagna. Oggi il matcher li scrive sempre insieme, e proprio per
    // questo la metà scoperta sarebbe rimasta scoperta: un domani che scrivesse il
    // codice anche su un candidato non agganciato (per mostrarlo, per diagnostica)
    // troverebbe qui il muro, non nel registro.
    expect(codiceDelSuggerimento({ pagamento_id: 'p1', score: 11050, motivi: [], codice_voce: '#K7MXN3P' })).toBeNull()
    expect(codiceDelSuggerimento({ pagamento_id: 'p1', score: 11050, motivi: [], codice_match: false, codice_voce: '#K7MXN3P' })).toBeNull()
    expect(codiceDellaRiga([{ pagamento_id: 'p1', score: 11050, motivi: [], codice_voce: '#K7MXN3P' }])).toBeNull()
  })

  it('riga vecchia: `codice_match` senza `codice_voce` (o vuoto) → `null`, non una stringa vuota', () => {
    expect(codiceDelSuggerimento({ pagamento_id: 'p1', score: 11050, motivi: [], codice_match: true })).toBeNull()
    expect(codiceDelSuggerimento({ pagamento_id: 'p1', score: 11050, motivi: [], codice_match: true, codice_voce: '' })).toBeNull()
  })

  it('sulla riga si prende il primo candidato che porta un codice, non il primo candidato', () => {
    const sugg: SuggerimentoUi[] = [
      { pagamento_id: 'p1', score: 1050, motivi: ['codice fiscale'], cf_match: true },
      { pagamento_id: 'p2', score: 10050, motivi: ['codice della voce'], codice_match: true, codice_voce: '#K7MXN3P' },
    ]
    expect(codiceDellaRiga(sugg)).toBe('#K7MXN3P')
    expect(codiceDellaRiga([])).toBeNull()
    expect(codiceDellaRiga(null)).toBeNull()
  })
})
