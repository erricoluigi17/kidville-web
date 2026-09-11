import { describe, it, expect } from 'vitest'
import {
  mapStatoAruba,
  codiceStatoAruba,
  etichettaStatoAruba,
  motivoScartoAruba,
  CODICE_NON_INTERPRETATO,
} from '@/lib/aruba/stato'

describe('mapStatoAruba', () => {
  it('stati in-flight (1 presa in carico, 3 inviata, 5 non consegnata) → in_attesa, non terminale', () => {
    for (const code of [1, 3, 5]) {
      const r = mapStatoAruba(code)
      expect(r.fatturaStato).toBe('in_attesa')
      expect(r.isTerminal).toBe(false)
      expect(r.isScarto).toBe(false)
    }
  })

  it('stati validi a SDI (6 recapito impossibile, 7 consegnata, 8 accettata, 10 decorrenza) → emessa, terminale', () => {
    for (const code of [6, 7, 8, 10]) {
      const r = mapStatoAruba(code)
      expect(r.fatturaStato).toBe('emessa')
      expect(r.isTerminal).toBe(true)
      expect(r.isScarto).toBe(false)
    }
  })

  it('scarti/rifiuti (2 errore elaborazione, 4 scartata SDI, 9 rifiutata) → scartata, terminale, isScarto', () => {
    for (const code of [2, 4, 9]) {
      const r = mapStatoAruba(code)
      expect(r.fatturaStato).toBe('scartata')
      expect(r.isTerminal).toBe(true)
      expect(r.isScarto).toBe(true)
    }
  })

  it('espone una label leggibile per ogni stato noto', () => {
    expect(mapStatoAruba(4).label).toMatch(/scart/i)
    expect(mapStatoAruba(7).label).toMatch(/consegn/i)
  })

  it('codice sconosciuto → in_attesa difensivo, non terminale, non scarto', () => {
    const r = mapStatoAruba(999)
    expect(r.fatturaStato).toBe('in_attesa')
    expect(r.isTerminal).toBe(false)
    expect(r.isScarto).toBe(false)
    expect(r.label).toMatch(/sconosciuto|ignoto/i)
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * LA DICITURA. Aruba non manda numeri: manda tre parole italiane.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('codiceStatoAruba', () => {
  // Le tre diciture misurate su 4.000 documenti veri il 2026-09-11. Sono TRE, non dieci.
  it('le tre diciture misurate → i codici della tabella', () => {
    expect(codiceStatoAruba('Consegnata')).toBe(7)
    expect(codiceStatoAruba('Non consegnata')).toBe(6)
    expect(codiceStatoAruba('Scartata')).toBe(4)
  })

  // ⚠️ IL TEST PIÙ IMPORTANTE DEL FILE, e il più facile da cancellare per sbaglio.
  // «Non consegnata» vale 6 = `emessa`, NON 5 = «Non consegnata (SDI ritenta)», che è
  // `in_attesa`. Le due voci hanno quasi lo stesso nome e significato opposto: la prima
  // dice che lo SDI ha DEPOSITATO il documento nell'area riservata di un privato senza
  // cassetto fiscale — cioè la fattura è emessa e valida — la seconda che ci riproverà.
  // È il 99% dei nostri documenti: sbagliarla mette quasi tutte le fatture della
  // cooperativa in un limbo perpetuo.
  it('«Non consegnata» è 6 (emessa, depositata) e NON 5 (in attesa, SDI ritenta)', () => {
    expect(codiceStatoAruba('Non consegnata')).toBe(6)
    expect(mapStatoAruba(codiceStatoAruba('Non consegnata')).fatturaStato).toBe('emessa')
    expect(mapStatoAruba(codiceStatoAruba('Non consegnata')).isScarto).toBe(false)
  })

  it('maiuscole, spazi agli estremi e spazi doppi non contano', () => {
    expect(codiceStatoAruba('  CONSEGNATA ')).toBe(7)
    expect(codiceStatoAruba('non    consegnata')).toBe(6)
    expect(codiceStatoAruba('scartata\n')).toBe(4)
  })

  // ⚠️ LA NON-INTELLIGENZA È IL REQUISITO. Un confronto per sottostringa
  // riconoscerebbe «Consegnata» DENTRO «Non consegnata» e scambierebbe due voci
  // opposte. Se qualcuno «migliorasse» il matcher con `includes`/`startsWith`, questo
  // test diventa rosso — ed è l'unica cosa che glielo dirà.
  it('NON è robusto per sottostringa: «Non consegnata» non deve mai valere 7', () => {
    expect(codiceStatoAruba('Non consegnata')).not.toBe(7)
    // Frasi che CONTENGONO una dicitura nota, ma non sono quella dicitura.
    expect(codiceStatoAruba('Consegnata al destinatario')).toBe(CODICE_NON_INTERPRETATO)
    expect(codiceStatoAruba('Scartata dallo SDI')).toBe(CODICE_NON_INTERPRETATO)
  })

  // Una parola nuova NON si indovina: 0 = «non ancora interpretato», che resta in coda.
  it('dicitura ignota, vuota, assente o non-stringa → 0', () => {
    expect(codiceStatoAruba('Messa in quarantena')).toBe(0)
    expect(codiceStatoAruba('')).toBe(0)
    expect(codiceStatoAruba('   ')).toBe(0)
    expect(codiceStatoAruba(null)).toBe(0)
    expect(codiceStatoAruba(undefined)).toBe(0)
  })

  // Chiavi ereditate dal prototipo: su un oggetto letterale `['constructor']` non è
  // `undefined` e `?? 0` non lo intercetta. Con una `Map` la riga non può mentire.
  it('una chiave del prototipo non si traveste da dicitura nota', () => {
    expect(codiceStatoAruba('constructor')).toBe(0)
    expect(codiceStatoAruba('toString')).toBe(0)
    expect(codiceStatoAruba('__proto__')).toBe(0)
  })

  // ⚠️ LA REGOLA ASIMMETRICA. Marcare «emessa» una fattura scartata è molto peggio del
  // congelamento: esce dalla coda, non genera avvisi, resta in contabilità come valida e
  // non viene mai corretta né ritrasmessa. Uno 0 invece torna al giro dopo.
  it('uno 0 non può MAI diventare «emessa»', () => {
    const m = mapStatoAruba(codiceStatoAruba('parola mai vista'))
    expect(m.fatturaStato).toBe('in_attesa')
    expect(m.isTerminal).toBe(false)
    expect(m.isScarto).toBe(false)
  })
})

describe('etichettaStatoAruba', () => {
  it('quando la nostra etichetta e quella di Aruba divergono, si scrivono ENTRAMBE', () => {
    const e = etichettaStatoAruba(mapStatoAruba(6), 'Non consegnata')
    expect(e).toContain('Recapito impossibile')
    expect(e).toContain('Non consegnata')
  })

  it('quando coincidono non si ripete la stessa parola due volte', () => {
    expect(etichettaStatoAruba(mapStatoAruba(7), 'Consegnata')).toBe('Consegnata')
    expect(etichettaStatoAruba(mapStatoAruba(7), '  consegnata ')).toBe('Consegnata')
  })

  it('senza dicitura resta la nostra etichetta, senza code appese', () => {
    expect(etichettaStatoAruba(mapStatoAruba(4), null)).toBe('Scartata dallo SDI')
    expect(etichettaStatoAruba(mapStatoAruba(4), '   ')).toBe('Scartata dallo SDI')
  })

  // Una dicitura ignota deve arrivare a registro con la PAROLA VERA accanto allo 0:
  // senza, chi legge vede «Stato sconosciuto (0)» e non ha modo di sapere cosa aggiungere
  // alla tabella. È esattamente ciò che è successo alle 153 righe congelate.
  it('una dicitura ignota arriva a registro insieme allo «Stato sconosciuto (0)»', () => {
    const e = etichettaStatoAruba(mapStatoAruba(0), 'Messa in quarantena')
    expect(e).toContain('Stato sconosciuto (0)')
    expect(e).toContain('Messa in quarantena')
  })
})

describe('motivoScartoAruba', () => {
  // Su una fattura NON scartata la colonna deve restare `null`: è il valore che significa
  // «nessuno scarto». Scriverci del testo la farebbe sembrare respinta.
  it('non è uno scarto → null', () => {
    expect(motivoScartoAruba(mapStatoAruba(7), 'Consegnata', { descrizioneAruba: 'x' })).toBeNull()
    expect(motivoScartoAruba(mapStatoAruba(6), 'Non consegnata')).toBeNull()
  })

  // ⚠️ IL PUNTO DI TUTTA LA FUNZIONE: «perché», non «che». Prima qui finiva la nostra
  // etichetta più «Scartata» — cioè la stessa frase di `sdi_stato_label`, ripetuta.
  it('scarto → il MOTIVO del provider, non la nostra etichetta', () => {
    const m = motivoScartoAruba(mapStatoAruba(4), 'Scartata', {
      descrizioneAruba: 'Codice destinatario non valido',
      errorCode: '0093',
      errorDescription: 'deleghe non valide',
    })
    expect(m).toContain('Codice destinatario non valido')
    expect(m).toContain('deleghe non valide')
    expect(m).toContain('0093')
    // NON deve limitarsi a ripetere l'etichetta della nostra tabella.
    expect(m).not.toBe('Scartata dallo SDI')
  })

  it('descrizione e errorDescription uguali non si scrivono due volte', () => {
    const m = motivoScartoAruba(mapStatoAruba(4), 'Scartata', {
      descrizioneAruba: 'Formato non valido',
      errorDescription: 'formato non valido',
    })
    expect(m?.match(/formato non valido/gi)?.length).toBe(1)
  })

  // `0000` è il codice del percorso felice: come motivo di uno scarto non dice niente.
  it('il codice 0000 non finisce nel motivo', () => {
    const m = motivoScartoAruba(mapStatoAruba(4), 'Scartata', {
      descrizioneAruba: 'Partita IVA inesistente',
      errorCode: '0000',
    })
    expect(m).toBe('Partita IVA inesistente')
  })

  // ⚠️ MAI `null` SU UNO SCARTO: `null` significa «non è uno scarto». Se il provider non
  // dà nessun motivo, si scrive a lettere che non l'ha dato — è vero, ed è azionabile.
  it('scarto senza nessun motivo dal provider → lo dice, non tace', () => {
    const m = motivoScartoAruba(mapStatoAruba(4), 'Scartata', {})
    expect(m).not.toBeNull()
    expect(m).toContain('nessun motivo dal provider')
    expect(m).toContain('Scartata')
  })

  it('senza descrizioni ma con un codice utile, il codice basta a cercare sulla doc Aruba', () => {
    const m = motivoScartoAruba(mapStatoAruba(4), 'Scartata', { errorCode: '0093' })
    expect(m).toContain('0093')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * DALLA PAROLA DI ARUBA ALLO STATO CONTABILE, in un passaggio solo.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('dicitura → `fatturaStato`, che è ciò che vede la contabilità', () => {
  /**
   * ⚠️ IL CODICE NON È IL PUNTO D'ARRIVO. `codiceStatoAruba` restituisce 7, 6 o 4 —
   * numeri che da soli non dicono se una fattura è emessa. Chi lo decide è
   * `mapStatoAruba`, e fra le due funzioni c'è una tabella che qualcuno può cambiare.
   * Provare solo il codice lascerebbe scoperto l'unico anello che la Segreteria legge.
   *
   * ⚠️ E «Non consegnata» sta nella COLONNA `emessa` insieme a «Consegnata», che è la
   * riga più controintuitiva di questo file: lo SDI non ha recapitato perché il
   * destinatario è un privato senza cassetto fiscale, quindi ha DEPOSITATO. La fattura
   * è trasmessa, ha superato i controlli, è valida. Sono 3.960 documenti su 4.000.
   */
  it('«Consegnata» e «Non consegnata» sono entrambe EMESSE, e nessuna delle due è uno scarto', () => {
    for (const dicitura of ['Consegnata', 'Non consegnata']) {
      const m = mapStatoAruba(codiceStatoAruba(dicitura))
      expect(m.fatturaStato, dicitura).toBe('emessa')
      expect(m.isScarto, dicitura).toBe(false)
      expect(m.isTerminal, dicitura).toBe(true)
    }
  })

  /**
   * «Scartata» è l'unica delle tre che significa NON EMESSA: il documento va corretto e
   * RITRASMESSO, e la Segreteria va avvisata. Al 2026-09-11 sono quattro fatture vere
   * della cooperativa, che nel registro apparivano come tutte le altre.
   */
  it('«Scartata» è `scartata`, terminale, ed è marcata come scarto (è ciò che fa scattare l\'avviso)', () => {
    const m = mapStatoAruba(codiceStatoAruba('Scartata'))
    expect(m.fatturaStato).toBe('scartata')
    expect(m.isScarto).toBe(true)
    expect(m.isTerminal).toBe(true)
  })

  /**
   * ⚠️ LA GARANZIA ASIMMETRICA, scritta come una proprietà e non come un esempio.
   * Qualunque parola fuori dalle tre misurate — oggi, e qualunque cosa Aruba inventi
   * domani — non può diventare `emessa` e non può diventare terminale. Deve restare in
   * coda, perché fra i due modi di sbagliare uno torna indietro e l'altro no: una
   * fattura congelata si scongela al giro dopo, una fattura scartata marcata «emessa»
   * esce dalla coda, non genera avvisi, resta a bilancio come valida e non viene mai
   * corretta né ritrasmessa.
   */
  it('NESSUNA parola fuori dalle tre misurate può diventare «emessa» o terminale', () => {
    const mai_viste = [
      'Boh',
      'In elaborazione',
      'Accettata dal destinatario',
      'consegnata parzialmente',
      'Non consegnata al destinatario',
      'Scartata dal committente',
      'DELIVERED',
      'Rifiutata',
      'Decorrenza termini',
      '7',
      '0',
    ]
    for (const parola of mai_viste) {
      const codice = codiceStatoAruba(parola)
      expect(codice, `«${parola}» non è fra le tre misurate`).toBe(CODICE_NON_INTERPRETATO)
      const m = mapStatoAruba(codice)
      expect(m.fatturaStato, `«${parola}»`).toBe('in_attesa')
      expect(m.fatturaStato, `«${parola}»`).not.toBe('emessa')
      expect(m.isTerminal, `«${parola}»`).toBe(false)
      expect(m.isScarto, `«${parola}»`).toBe(false)
    }
  })
})
