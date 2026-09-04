import { describe, it, expect } from 'vitest'
import { estraiCodiciFiscali, hashMovimento, parseCsv, preparaAperti, suggerisciMatch, suggerisciMatchPreparato } from '@/lib/pagamenti/riconciliazione'

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
