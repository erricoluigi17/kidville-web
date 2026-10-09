import { describe, it, expect } from 'vitest'
import { causaleBonifico, conCodiceVoce, haCodiceFiscale, rigaCausaleSollecito, sedeCausale, nomeCompleto, renderCausale, DEFAULT_CAUSALE_TEMPLATE, PLACEHOLDER_CAUSALE, type DatiCausale } from '@/lib/pagamenti/causale'
import { LIMITE_CAUSALE_BANCA } from '@/lib/pagamenti/causale-banca'
import { estraiCodiciVoce } from '@/lib/pagamenti/codice-voce'
import { estraiCodiciFiscali } from '@/lib/pagamenti/riconciliazione'

// CF SINTETICO — non appartiene a nessuna persona reale (repo pubblico).
const CF_SINTETICO = 'TSTTST00T00T000T'

/**
 * Un codice voce in forma CANONICA, col sigillo. È scritto a mano di proposito:
 * `codiceVoce` non si chiama da qui, perché il motore delle causali riceve il codice
 * **già calcolato** da chi chiama, come riceve già formattati importo e scadenza.
 * Chiamarla qui misurerebbe lei invece del motore.
 */
const CODICE = '#K7MXN3P'

/**
 * Lo stesso codice come esce nella causale del BONIFICO: senza il `#`, che Poste rifiuta
 * (2026-10-09, v. `@/lib/pagamenti/causale-banca`). L'estrattore lo riconosce anche così.
 */
const NUDO = CODICE.slice(1)

/** Il set che passa in TUTTE le banche: lettere, cifre e spazi. */
const SET_SICURO = /^[A-Za-z0-9 ]*$/

describe('sedeCausale', () => {
  it('maiuscolo, senza il prefisso «Kidville»', () => {
    expect(sedeCausale('Kidville Giugliano')).toBe('GIUGLIANO')
    expect(sedeCausale('kidville  napoli')).toBe('NAPOLI')
    expect(sedeCausale('Giugliano')).toBe('GIUGLIANO')
    expect(sedeCausale(null)).toBe('')
    expect(sedeCausale('  ')).toBe('')
  })
})

describe('causaleBonifico', () => {
  it('compone «{descrizione} {codice} {CF} {Nome Cognome} {SEDE}» — i dati dell’abbinamento in testa', () => {
    expect(causaleBonifico({ descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' }))
      .toBe(`Retta Settembre 2026 ${CF_SINTETICO} Mario Rossi GIUGLIANO`)
  })

  it('normalizza CF (trim+maiuscolo) e sede', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: '  tsttst00t00t000t  ', sede: 'Kidville Giugliano' }))
      .toBe(`Retta ${CF_SINTETICO} Mario Rossi GIUGLIANO`)
  })

  it('omette le parti assenti (senza CF / senza sede)', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi' }))
      .toBe('Retta Mario Rossi')
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO }))
      .toBe(`Retta ${CF_SINTETICO} Mario Rossi`)
  })

  it('tollera campi mancanti senza spazi sporchi né «undefined»', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: null })).toBe('Retta Mario')
    expect(causaleBonifico({ nome: null, cognome: null, codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' })).toBe(`${CF_SINTETICO} GIUGLIANO`)
    expect(causaleBonifico({})).toBe('')
  })
})

describe('la causale che arriva alla BANCA (Poste, 2026-10-09)', () => {
  /** Dati scelti per contenere OGNI carattere a rischio misurato in produzione. */
  const DATI_SPORCHI: DatiCausale = {
    descrizione: 'Retta 10/2026 — [rata 1/3]: 2× Felpa*',
    nome: 'Niccolò',
    cognome: 'D’Angelo-Rossi',
    codiceFiscale: CF_SINTETICO,
    sede: 'Kidville Giugliano',
    mese: 'settembre',
    anno: 2026,
    importo: '€ 150,00',
    scadenza: '30/09/2026',
    codice: CODICE,
  }

  it('IL FORMATO, byte per byte: niente `#`, niente `/`, niente « - »', () => {
    // La stringa attesa è scritta per intero, non ricavata dal modello: ricavarla lo farebbe
    // passare anche se il modello cambiasse forma. È la forma scelta dal titolare il
    // 2026-10-09 («dati chiave in testa»).
    const dati = { descrizione: 'Retta 10/2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano', codice: CODICE }
    expect(causaleBonifico(dati)).toBe(`Retta 10 2026 ${NUDO} ${CF_SINTETICO} Mario Rossi GIUGLIANO`)
    // Senza codice il segnaposto sparisce senza lasciare uno spazio doppio.
    expect(causaleBonifico({ ...dati, codice: null })).toBe(`Retta 10 2026 ${CF_SINTETICO} Mario Rossi GIUGLIANO`)
    expect(causaleBonifico({ ...dati, codice: '   ' })).toBe(`Retta 10 2026 ${CF_SINTETICO} Mario Rossi GIUGLIANO`)
  })

  it('codice della voce e codice fiscale stanno nei primi 50 caratteri (banche che tagliano a 50)', () => {
    const causale = causaleBonifico({ descrizione: 'Retta 10/2026', nome: 'Maria Vittoria', cognome: 'Esposito Capasso', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano', codice: CODICE })
    const tagliata = causale.slice(0, 50)
    expect(estraiCodiciVoce(tagliata)).toEqual([CODICE])
    expect(estraiCodiciFiscali(tagliata)).toEqual([CF_SINTETICO])
  })

  it('codice e CF nei primi 50 anche con le descrizioni LUNGHE (merchandise, rate)', () => {
    // La descrizione sta in testa e non ha un limite suo: un ordine di merchandise arriva a
    // 300 caratteri, una rata aggiunge « — Rata i/n». Senza accorciarla, codice e CF
    // scivolerebbero oltre il taglio di 50 — e oltre i 140 dell'app stessa.
    const descrizioni = [
      'Merchandise: 2× Felpa (M), 1× Cappellino (U), 3× Maglietta (S), 1× Zaino (U), 2× Borraccia (U), 1× Grembiule (M), 1× Felpa (L)',
      'Retta annuale 2026/27 — Rata 10/10',
      'Iscrizione anno scolastico 2026/2027 — quota associativa e materiali',
    ]
    for (const descrizione of descrizioni) {
      const causale = causaleBonifico({ descrizione, codice: CODICE, codiceFiscale: CF_SINTETICO, nome: 'Mario', cognome: 'Rossi', sede: 'Kidville Giugliano' })
      const tagliata = causale.slice(0, 50)
      expect(estraiCodiciVoce(tagliata), descrizione).toEqual([CODICE])
      expect(estraiCodiciFiscali(tagliata), descrizione).toEqual([CF_SINTETICO])
      expect(causale, descrizione).toMatch(SET_SICURO)
    }
    // La descrizione corta resta INTERA: l'accorciamento morde solo dove serve.
    expect(causaleBonifico({ descrizione: 'Retta annuale 2026/27 — Rata 10/10', codice: CODICE }))
      .toBe(`Retta annuale 2026 27 ${NUDO}`)
  })

  it('l’accorciamento della descrizione vale solo per il BONIFICO, non per il motore', () => {
    const lunga = 'Iscrizione anno scolastico 2026/2027 — quota associativa e materiali'
    expect(renderCausale('{descrizione}', { descrizione: lunga })).toBe(lunga)
  })

  it('il modello di FABBRICA, con i dati più sporchi, esce dentro il set sicuro', () => {
    const causale = causaleBonifico(DATI_SPORCHI)
    expect(causale).toMatch(SET_SICURO)
    // La descrizione sporca, ripulita, fa 32 caratteri: entra accorciata ai 24 del bonifico.
    expect(causale).toBe(`Retta 10 2026 rata 1 3 2 ${NUDO} ${CF_SINTETICO} Niccolo D Angelo Rossi GIUGLIANO`)
    expect(estraiCodiciVoce(causale)).toEqual([CODICE])
    expect(estraiCodiciFiscali(causale)).toEqual([CF_SINTETICO])
  })

  it('OGNI segnaposto del catalogo, e un modello pieno di simboli, escono dentro il set sicuro', () => {
    // Un modello personalizzato non è controllato al salvataggio: la garanzia sta in uscita.
    const tutti = PLACEHOLDER_CAUSALE.map((p) => `{${p.chiave}}`).join(' - ')
    const modelli = [
      tutti,
      ...PLACEHOLDER_CAUSALE.map((p) => `{${p.chiave}}`),
      '#* PAGAMENTO: {descrizione} / {nome_completo} — {sede} (rif. {codice}) ’’',
    ]
    for (const modello of modelli) {
      const causale = causaleBonifico(DATI_SPORCHI, modello)
      expect(causale, `modello «${modello}»`).toMatch(SET_SICURO)
      expect(causale.length, `modello «${modello}»`).toBeLessThanOrEqual(LIMITE_CAUSALE_BANCA)
    }
  })

  it('anche la riga del SOLLECITO porta la causale ripulita', () => {
    const riga = rigaCausaleSollecito(DATI_SPORCHI)
    expect(riga).toContain(`"${causaleBonifico(DATI_SPORCHI)}"`)
    expect(riga).not.toContain(CODICE)
  })
})

describe('renderCausale (motore a segnaposto per-categoria)', () => {
  it('rende un modello CUSTOM sostituendo i segnaposto', () => {
    expect(renderCausale('ISCRIZIONE {nome} {cognome} - {sede}', { nome: 'Mario', cognome: 'Rossi', sede: 'Kidville Giugliano' }))
      .toBe('ISCRIZIONE Mario Rossi - GIUGLIANO')
  })

  it('OMETTE un segmento coi soli segnaposto vuoti («per il minore {nome_completo}» sparisce senza nome)', () => {
    // segmento con placeholder ma tutti vuoti → via del tutto (niente label penzolante)
    expect(renderCausale('Retta - per il minore {nome_completo}', { descrizione: 'x', nome: null, cognome: null }))
      .toBe('Retta')
    expect(renderCausale('per il minore {nome_completo}', {})).toBe('')
  })

  it('MANTIENE il testo FISSO privo di segnaposto', () => {
    expect(renderCausale('Contributo volontario - {nome_completo}', { nome: 'Ada', cognome: 'Neri' }))
      .toBe('Contributo volontario - Ada Neri')
    // segmento di solo testo fisso: resta anche se gli altri spariscono
    expect(renderCausale('Contributo volontario - {codice_fiscale}', { nome: 'Ada', cognome: 'Neri' }))
      .toBe('Contributo volontario')
  })

  it('supporta i nuovi segnaposto {mese} {anno} {importo} {scadenza}', () => {
    expect(renderCausale('{descrizione} {mese} {anno} - {importo} - scad. {scadenza}', {
      descrizione: 'Retta', mese: 'settembre', anno: '2026', importo: '€ 150,00', scadenza: '30/09/2026',
    })).toBe('Retta settembre 2026 - € 150,00 - scad. 30/09/2026')
    // mese/anno assenti → il segmento che li contiene sparisce, il resto resta
    expect(renderCausale('{descrizione} {mese} {anno} - {importo}', {
      descrizione: 'Retta', importo: '€ 150,00',
    })).toBe('Retta - € 150,00')
  })

  it('DIFESA: un template NON-stringa ricade sul predefinito (niente crash su .split)', () => {
    const dati = { descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: 'TSTTST00T00T000T', sede: 'Kidville Giugliano' }
    const atteso = renderCausale(DEFAULT_CAUSALE_TEMPLATE, dati)
    for (const t of [999, {}, [], null, undefined]) {
      expect(renderCausale(t as unknown as string, dati)).toBe(atteso)
    }
  })

  it('il PREDEFINITO mette codice della voce e codice fiscale subito dopo la descrizione', () => {
    expect(DEFAULT_CAUSALE_TEMPLATE).toBe('{descrizione} {codice} {codice_fiscale} {nome_completo} {sede}')
    expect(renderCausale(DEFAULT_CAUSALE_TEMPLATE, { descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' }))
      .toBe(`Retta Settembre 2026 ${CF_SINTETICO} Mario Rossi GIUGLIANO`)
    // le parti assenti si omettono senza spazi doppi
    expect(renderCausale(DEFAULT_CAUSALE_TEMPLATE, { descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi' }))
      .toBe('Retta Mario Rossi')
  })
})

describe('{codice} — la causale dice anche QUALE voce si sta pagando', () => {
  const DATI = { descrizione: 'Retta', codice: CODICE, nome: 'Mario', cognome: 'Rossi' }

  it('è reso NELLA POSIZIONE scelta dal modello, una volta sola', () => {
    const resa = causaleBonifico(DATI, 'ISCRIZIONE {codice} - {nome_completo}')
    expect(resa).toBe(`ISCRIZIONE ${NUDO} Mario Rossi`)
    // Una sola occorrenza: `split` su un separatore presente una volta dà due pezzi.
    expect(resa.split(NUDO)).toHaveLength(2)
  })

  it('normalizza il codice (trim + MAIUSCOLO), come fa col codice fiscale', () => {
    expect(causaleBonifico({ ...DATI, codice: '  #k7mxn3p  ' }))
      .toBe(`Retta ${NUDO} Mario Rossi`)
  })

  it('APPEND AUTOMATICO: un modello che non lo cita lo riceve nel segmento della DESCRIZIONE', () => {
    // Le tre sedi possono avere modelli propri in `causali_config`, scritti quando il codice
    // non esisteva. Non si migra quel JSONB: il pannello riscrive il campo per intero,
    // quindi la prima modifica dell'admin ributterebbe fuori il segnaposto. La
    // garanzia sta in lettura.
    const resa = causaleBonifico(
      { ...DATI, sede: 'Kidville Giugliano' },
      'PAGAMENTO {descrizione} - {nome_completo} - {sede}',
    )
    expect(resa).toBe(`PAGAMENTO Retta ${NUDO} Mario Rossi GIUGLIANO`)
    // E MAI in coda: il campo causale della banca si taglia da destra, quindi in fondo
    // il codice sarebbe il primo pezzo a sparire — proprio nelle causali più lunghe.
    expect(resa.endsWith(NUDO)).toBe(false)
  })

  it('un modello che lo CITA non riceve nessun doppione', () => {
    const resa = causaleBonifico(DATI, '{descrizione} - rif. {codice} - {nome_completo}')
    expect(resa).toBe(`Retta rif ${NUDO} Mario Rossi`)
    expect(resa.split(NUDO)).toHaveLength(2)
  })

  it('`conCodiceVoce` è IDEMPOTENTE, e tiene il codice fuori dalla coda', () => {
    const una = conCodiceVoce('{descrizione} - {nome_completo}')
    expect(una).toBe('{descrizione} {codice} - {nome_completo}')
    expect(conCodiceVoce(una)).toBe(una)
    // Un modello NON-stringa (configurazione malformata) ricade sul predefinito, che
    // il segnaposto ce l'ha già: stessa difesa di `renderCausale`.
    expect(conCodiceVoce(999 as unknown as string)).toBe(DEFAULT_CAUSALE_TEMPLATE)
  })

  it('un modello SENZA {descrizione}: il codice va nel PRIMO segmento', () => {
    expect(conCodiceVoce('{nome_completo} - {sede}')).toBe('{nome_completo} {codice} - {sede}')
    expect(causaleBonifico({ codice: CODICE, nome: 'Mario', cognome: 'Rossi', sede: 'Kidville Giugliano' }, '{nome_completo} - {sede}'))
      .toBe(`Mario Rossi ${NUDO} GIUGLIANO`)
  })

  it('le causali VECCHIE, col `#`, restano riconoscibili: il codice è lo stesso', () => {
    // Le causali già in circolazione (solleciti spediti, bonifici ricorrenti salvati
    // nell'home banking) portano ancora `#K7MXN3P - per il minore …`. Il codice dipende
    // solo dall'id della voce: vecchia e nuova forma agganciano la stessa voce.
    const vecchia = `Retta Settembre 2026 ${CODICE} - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`
    const nuova = causaleBonifico({ descrizione: 'Retta Settembre 2026', codice: CODICE, nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' })
    expect(estraiCodiciVoce(vecchia)).toEqual([CODICE])
    expect(estraiCodiciVoce(nuova)).toEqual([CODICE])
  })

  it('descrizione VUOTA ma codice presente: la causale comincia dal codice', () => {
    expect(causaleBonifico({ descrizione: '', codice: CODICE, nome: 'Mario', cognome: 'Rossi' }))
      .toBe(`${NUDO} Mario Rossi`)
  })

  it('`causaleBonifico` e `renderCausale` DIVERGONO di proposito', () => {
    // Codice e pulizia per la banca vivono nel solo ramo del bonifico. Il motore è
    // condiviso con la causale della FATTURA elettronica, che il codice non lo porta e
    // che accetta accenti e `/`: un `if` là dentro sarebbe la divergenza che il lock
    // `causale-fattura-un-motore-solo` esiste per impedire. Se un giorno questo test
    // diventasse rosso perché le due strade coincidono, vorrebbe dire che l'append o la
    // pulizia sono scesi nel motore — e con loro su un documento fiscale.
    const modello = '{descrizione} - {nome_completo}'
    expect(renderCausale(modello, DATI)).toBe('Retta - Mario Rossi')
    expect(causaleBonifico(DATI, modello)).toBe(`Retta ${NUDO} Mario Rossi`)
    expect(renderCausale('{descrizione}', { descrizione: 'Retta 10/2026' })).toBe('Retta 10/2026')
    expect(causaleBonifico({ descrizione: 'Retta 10/2026' }, '{descrizione}')).toBe('Retta 10 2026')
  })

  it('il chip è nel catalogo, e il suo ESEMPIO non può agganciare nessun movimento', () => {
    const voce = PLACEHOLDER_CAUSALE.find((p) => p.chiave === 'codice')
    expect(voce, 'il segnaposto {codice} non è nel catalogo PLACEHOLDER_CAUSALE').toBeDefined()
    expect(voce!.label.trim()).not.toBe('')
    // L'esempio mostra la forma che esce DAVVERO nella causale: senza `#`.
    expect(voce!.esempio).toMatch(/^[A-Z]{7}$/)
    // L'esempio è di SOLE LETTERE apposta: finisce nel tooltip del chip, cioè a schermo
    // dentro un repository pubblico. `estraiCodiciVoce` pretende almeno una cifra,
    // quindi questa forma la rifiuta — ricopiarla in una causale vera non abbinerebbe
    // niente e niente a nessuno. Un esempio «più realistico» rende rosso questo caso.
    expect(estraiCodiciVoce(voce!.esempio)).toEqual([])
    expect(estraiCodiciVoce(`CAUSALE ${voce!.esempio}.`)).toEqual([])
    // Controllo negativo: la misura sa dire di sì, altrimenti sopra passerebbe sempre.
    expect(estraiCodiciVoce(`CAUSALE ${NUDO}.`)).toEqual([CODICE])
  })
})

describe('nomeCompleto', () => {
  it('ripulisce spazi e campi assenti', () => {
    expect(nomeCompleto({ nome: 'Mario', cognome: 'Rossi' })).toBe('Mario Rossi')
    expect(nomeCompleto({ nome: null, cognome: 'Rossi' })).toBe('Rossi')
    expect(nomeCompleto({})).toBe('')
  })
})

describe('haCodiceFiscale', () => {
  it('true solo con CF valorizzato', () => {
    expect(haCodiceFiscale(CF_SINTETICO)).toBe(true)
    expect(haCodiceFiscale('   ')).toBe(false)
    expect(haCodiceFiscale('')).toBe(false)
    expect(haCodiceFiscale(null)).toBe(false)
    expect(haCodiceFiscale(undefined)).toBe(false)
  })
})

describe('rigaCausaleSollecito', () => {
  it('include la causale completa (descrizione, CF, minore, sede)', () => {
    const riga = rigaCausaleSollecito({ descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' })
    expect(riga.toLowerCase()).toContain('causale')
    expect(riga).toContain(`Retta Settembre 2026 ${CF_SINTETICO} Mario Rossi GIUGLIANO`)
  })

  it('senza CF resta utile (descrizione + minore) e senza «undefined»', () => {
    const riga = rigaCausaleSollecito({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: null })
    expect(riga).toContain('Retta Mario Rossi')
    expect(riga).not.toContain('undefined')
  })

  it('senza dati ritorna stringa vuota', () => {
    expect(rigaCausaleSollecito({})).toBe('')
  })
})
