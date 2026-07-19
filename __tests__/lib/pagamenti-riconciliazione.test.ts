import { describe, it, expect } from 'vitest'
import { estraiCodiciFiscali, hashMovimento, parseCsv, suggerisciMatch } from '@/lib/pagamenti/riconciliazione'

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
      '06/09/2026;-30,00;PAGAMENTO POS;—',            // uscita → scartata
      '07/09/2026;1.234,56;SALDO GITA;BIANCHI',
    ].join('\n')
    const r = parseCsv(csv)
    expect(r.movimenti).toHaveLength(2)
    expect(r.movimenti[0]).toMatchObject({ data_operazione: '2026-09-05', importo: 150 })
    expect(r.movimenti[1].importo).toBe(1234.56)
    expect(r.scartate).toBe(1)
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
