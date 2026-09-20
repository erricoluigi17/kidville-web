import { describe, it, expect } from 'vitest'
import { causaleBonifico, conCodiceVoce, haCodiceFiscale, rigaCausaleSollecito, sedeCausale, nomeCompleto, renderCausale, DEFAULT_CAUSALE_TEMPLATE, PLACEHOLDER_CAUSALE } from '@/lib/pagamenti/causale'
import { estraiCodiciVoce } from '@/lib/pagamenti/codice-voce'

// CF SINTETICO — non appartiene a nessuna persona reale (repo pubblico).
const CF_SINTETICO = 'TSTTST00T00T000T'

/**
 * Un codice voce in forma CANONICA, col sigillo. È scritto a mano di proposito:
 * `codiceVoce` non si chiama da qui, perché il motore delle causali riceve il codice
 * **già calcolato** da chi chiama, come riceve già formattati importo e scadenza.
 * Chiamarla qui misurerebbe lei invece del motore.
 */
const CODICE = '#K7MXN3P'

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
  it('compone «{descrizione} - per il minore {Nome Cognome} - {CF} - {SEDE}»', () => {
    expect(causaleBonifico({ descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' }))
      .toBe(`Retta Settembre 2026 - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
  })

  it('normalizza CF (trim+maiuscolo) e sede', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: '  tsttst00t00t000t  ', sede: 'Kidville Giugliano' }))
      .toBe(`Retta - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
  })

  it('omette le parti assenti (senza CF / senza sede)', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi' }))
      .toBe('Retta - per il minore Mario Rossi')
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO }))
      .toBe(`Retta - per il minore Mario Rossi - ${CF_SINTETICO}`)
  })

  it('tollera campi mancanti senza spazi sporchi né «undefined»', () => {
    expect(causaleBonifico({ descrizione: 'Retta', nome: 'Mario', cognome: null })).toBe('Retta - per il minore Mario')
    expect(causaleBonifico({ nome: null, cognome: null, codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' })).toBe(`${CF_SINTETICO} - GIUGLIANO`)
    expect(causaleBonifico({})).toBe('')
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

  it('il PREDEFINITO è retro-compatibile con la causale storica', () => {
    expect(renderCausale(DEFAULT_CAUSALE_TEMPLATE, { descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' }))
      .toBe(`Retta Settembre 2026 - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
    // le parti assenti si omettono, esattamente come il formato storico
    expect(renderCausale(DEFAULT_CAUSALE_TEMPLATE, { descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi' }))
      .toBe('Retta - per il minore Mario Rossi')
  })
})

describe('{codice} — la causale dice anche QUALE voce si sta pagando', () => {
  const DATI = { descrizione: 'Retta', codice: CODICE, nome: 'Mario', cognome: 'Rossi' }

  it('è reso NELLA POSIZIONE scelta dal modello, una volta sola', () => {
    const resa = causaleBonifico(DATI, 'ISCRIZIONE {codice} - {nome_completo}')
    expect(resa).toBe(`ISCRIZIONE ${CODICE} - Mario Rossi`)
    // Una sola occorrenza: `split` su un separatore presente una volta dà due pezzi.
    expect(resa.split(CODICE)).toHaveLength(2)
  })

  it('normalizza il codice (trim + MAIUSCOLO), come fa col codice fiscale', () => {
    expect(causaleBonifico({ ...DATI, codice: '  #k7mxn3p  ' }))
      .toBe(`Retta ${CODICE} - per il minore Mario Rossi`)
  })

  it('APPEND AUTOMATICO: un modello che non lo cita lo riceve nel segmento della DESCRIZIONE', () => {
    // Le tre sedi hanno modelli propri in `causali_config`, scritti quando il codice
    // non esisteva. Non si migra quel JSONB: il pannello riscrive il campo per intero,
    // quindi la prima modifica dell'admin ributterebbe fuori il segnaposto. La
    // garanzia sta in lettura.
    const resa = causaleBonifico(
      { ...DATI, sede: 'Kidville Giugliano' },
      'PAGAMENTO {descrizione} - {nome_completo} - {sede}',
    )
    expect(resa).toBe(`PAGAMENTO Retta ${CODICE} - Mario Rossi - GIUGLIANO`)
    // E MAI in coda: il campo causale della banca si taglia da destra, quindi in fondo
    // il codice sarebbe il primo pezzo a sparire — proprio nelle causali più lunghe.
    expect(resa.endsWith(CODICE)).toBe(false)
  })

  it('un modello che lo CITA non riceve nessun doppione', () => {
    const resa = causaleBonifico(DATI, '{descrizione} - rif. {codice} - {nome_completo}')
    expect(resa).toBe(`Retta - rif. ${CODICE} - Mario Rossi`)
    expect(resa.split(CODICE)).toHaveLength(2)
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
      .toBe(`Mario Rossi ${CODICE} - GIUGLIANO`)
  })

  it('SENZA codice la causale resta identica, BYTE PER BYTE, a quella storica', () => {
    // È la prova della decisione «le causali già in circolazione continuano a
    // funzionare»: la stringa attesa è scritta per intero qui, non ricavata dal
    // modello — ricavarla lo farebbe passare anche se il modello cambiasse forma.
    const dati = { descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' }
    const STORICA = `Retta Settembre 2026 - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`
    expect(causaleBonifico(dati)).toBe(STORICA)
    expect(causaleBonifico({ ...dati, codice: null })).toBe(STORICA)
    expect(causaleBonifico({ ...dati, codice: '   ' })).toBe(STORICA)
    // Nemmeno uno spazio doppio dove il segnaposto è sparito.
    expect(causaleBonifico(dati)).not.toMatch(/ {2}/)
  })

  it('descrizione VUOTA ma codice presente: il segmento sopravvive col solo codice', () => {
    // Un segmento si omette solo se TUTTI i suoi segnaposto sono vuoti. Qui il codice
    // non lo è — e senza di lui il genitore non saprebbe quale voce sta pagando.
    expect(causaleBonifico({ descrizione: '', codice: CODICE, nome: 'Mario', cognome: 'Rossi' }))
      .toBe(`${CODICE} - per il minore Mario Rossi`)
  })

  it('`causaleBonifico` e `renderCausale` DIVERGONO di proposito', () => {
    // L'append vive nel solo ramo del bonifico. Il motore è condiviso con la causale
    // della FATTURA elettronica, che il codice non lo porta: un `if` là dentro sarebbe
    // la divergenza che il lock `causale-fattura-un-motore-solo` esiste per impedire.
    // Se un giorno questo test diventasse rosso perché le due strade coincidono,
    // vorrebbe dire che l'append è sceso nel motore — e con lui su un documento fiscale.
    const modello = '{descrizione} - {nome_completo}'
    expect(renderCausale(modello, DATI)).toBe('Retta - Mario Rossi')
    expect(causaleBonifico(DATI, modello)).toBe(`Retta ${CODICE} - Mario Rossi`)
    expect(causaleBonifico(DATI, modello)).not.toBe(renderCausale(modello, DATI))
  })

  it('il chip è nel catalogo, e il suo ESEMPIO non può agganciare nessun movimento', () => {
    const voce = PLACEHOLDER_CAUSALE.find((p) => p.chiave === 'codice')
    expect(voce, 'il segnaposto {codice} non è nel catalogo PLACEHOLDER_CAUSALE').toBeDefined()
    expect(voce!.label.trim()).not.toBe('')
    // L'esempio è di SOLE LETTERE apposta: finisce nel tooltip del chip, cioè a schermo
    // dentro un repository pubblico. `estraiCodiciVoce` pretende almeno una cifra,
    // quindi questa forma la rifiuta — ricopiarla in una causale vera non abbinerebbe
    // niente e niente a nessuno. Un esempio «più realistico» rende rosso questo caso.
    expect(estraiCodiciVoce(voce!.esempio)).toEqual([])
    expect(estraiCodiciVoce(`CAUSALE ${voce!.esempio}.`)).toEqual([])
    // Controllo negativo: la misura sa dire di sì, altrimenti sopra passerebbe sempre.
    expect(estraiCodiciVoce(`CAUSALE ${CODICE}.`)).toEqual([CODICE])
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
  it('include la causale completa (descrizione, minore, CF, sede)', () => {
    const riga = rigaCausaleSollecito({ descrizione: 'Retta Settembre 2026', nome: 'Mario', cognome: 'Rossi', codiceFiscale: CF_SINTETICO, sede: 'Kidville Giugliano' })
    expect(riga.toLowerCase()).toContain('causale')
    expect(riga).toContain(`Retta Settembre 2026 - per il minore Mario Rossi - ${CF_SINTETICO} - GIUGLIANO`)
  })

  it('senza CF resta utile (descrizione + minore) e senza «undefined»', () => {
    const riga = rigaCausaleSollecito({ descrizione: 'Retta', nome: 'Mario', cognome: 'Rossi', codiceFiscale: null })
    expect(riga).toContain('Retta - per il minore Mario Rossi')
    expect(riga).not.toContain('undefined')
  })

  it('senza dati ritorna stringa vuota', () => {
    expect(rigaCausaleSollecito({})).toBe('')
  })
})
