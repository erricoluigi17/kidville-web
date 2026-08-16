/**
 * Gli otto prestampati del genitore (`src/lib/prestampati/modelli/genitore.ts`).
 *
 * Quattro cose si misurano qui, e sono le quattro che si rompono in silenzio:
 *
 *  1. il NUCLEO COMUNE non viene mai richiesto — nome, nascita, codice fiscale, sezione,
 *     sede e anno scolastico l'app li ha già, e un modulo che li richiede è un modulo che
 *     la famiglia abbandona;
 *  2. lo schema `zod` RESPINGE l'input incompleto — non lo completa, non lo tollera;
 *  3. il DEGRADO omette davvero la riga quando il dato manca — mai «N.D.», mai un valore
 *     inventato su un foglio che va a un ente;
 *  4. il TESTO TRASCRITTO dai `.docx` della scuola compare nei blocchi, parola per
 *     parola: è l'unico modo di accorgersi che qualcuno l'ha «migliorato».
 *
 * Nessun dato reale: bambini, genitori, delegati, medici e sedi sono inventati, e i dati
 * della scuola (P.IVA, sede legale, legale rappresentante) sono valori di prova — nel
 * prodotto arrivano da `scuole.config.anagrafica`, mai dal codice.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  ACCOMPAGNATORE_GENITORE,
  MODELLI_GENITORE,
  autorizzazioneNidoCompleta,
  intestazionePrestampato,
  luogoDataPrestampato,
  modelloAutorizzazioneFarmaci,
  modelloAutorizzazioneUscita,
  modelloCertificatoBonusNido,
  modelloCertificatoIscrizioneFrequenza,
  modelloDelegaRitiro,
  modelloDietaSpeciale,
  modelloGenitore,
  modelloPermessoOrario,
  modelloSchedaSanitaria,
  motivoSanitario,
  richiedeDueFirme,
  type CampoModulo,
  type DatiGenitore,
  type DatiPrestampato,
  type EsitoComposizione,
  type ModelloPrestampato,
} from '@/lib/prestampati/modelli/genitore'
import type { BloccoPrestampato, CampoPrestampato } from '@/lib/prestampati/tipi'
import { buildCertificatoBody } from '@/lib/certificati/self-service'
import { TIPI_SANITARI } from '@/lib/documenti/registro'

// ─── Dati di prova (tutti inventati) ────────────────────────────────────────────

/**
 * I due tutori dell'alunna inventata. Stanno fuori dalla fabbrica perché `richiedente`
 * deve puntare a UNO DI LORO e non a una copia: è la differenza fra dichiarare chi firma
 * e riscrivere un nome uguale.
 */
const GENITORI_PROVA: DatiGenitore[] = [
  { nomeCompleto: 'Sanniti Marco', ruolo: 'padre', telefono: '081 0000001', email: 'prova.padre@example.invalid' },
  { nomeCompleto: 'Ferrone Giulia', ruolo: 'madre', telefono: '081 0000002' },
]

function dati(override: Partial<DatiPrestampato> = {}): DatiPrestampato {
  return {
    alunno: {
      nome: 'Ludovica',
      cognome: 'Sanniti',
      dataNascita: '2022-04-17',
      luogoNascita: 'Fiumefreddo (ZZ)',
      codiceFiscale: 'SNNLDV22D57Z999Q',
      sezione: 'Coccinelle',
      livello: 'nido',
    },
    genitori: GENITORI_PROVA,
    // In produzione il richiedente lo sa sempre la route (è l'utente autenticato): qui è
    // il padre, e i test che vogliono il caso limite — nessun richiedente, oppure la
    // madre — lo dichiarano loro, che è esattamente ciò che il modello pretende.
    richiedente: GENITORI_PROVA[0],
    sede: {
      scuola_nome: 'Kidville Prova',
      scuola_indirizzo: 'Via delle Prove 1',
      scuola_cap: '80000',
      scuola_citta: 'Cittaprova',
      scuola_provincia: 'ZZ',
      scuola_codice_meccanografico: 'ZZ1A000001',
      // ⚠️ «Comune di Cittaprova», non «Cittaprova»: il valore porta già dentro il
      // nome dell'ente, come i tre valori veri (vedi AUTORIZZAZIONI_VERE). La
      // fixture di prima diceva «Cittaprova» — un nome di comune nudo — ed era il
      // solo dato al mondo su cui il prefisso cablato «rilasciata dal Comune di»
      // sembrava giusto: 146 test verdi mentre il PDF di Giugliano stampava
      // «rilasciata dal Comune di Comune di Giugliano in Campania».
      autorizzazioneNido: { numero: '77/2024', data: '2024-09-01', ente: 'Comune di Cittaprova' },
    },
    scuola: {
      ragioneSociale: 'Cooperativa di Prova Soc. Coop.',
      piva: '00000000000',
      sedeLegale: 'Via delle Prove 1 — 80000 Cittaprova (ZZ)',
      legaleRappresentante: 'Nome Cognome Di Prova',
    },
    annoScolastico: '2026/2027',
    dataOggi: '2026-08-14',
    ...override,
  }
}

// ─── Lettori dei blocchi ────────────────────────────────────────────────────────

function componiOk(m: ModelloPrestampato, d: DatiPrestampato, risposte: unknown): BloccoPrestampato[] {
  const esito = m.componi(d, risposte)
  if (!esito.ok) throw new Error(`composizione rifiutata: ${JSON.stringify(esito.errori)}`)
  return esito.blocchi
}

function erroriDi(esito: EsitoComposizione): { campo: string; messaggio: string }[] {
  if (esito.ok) throw new Error('atteso un rifiuto, la composizione è riuscita')
  return esito.errori
}

/** I soli nomi dei campi in errore: il messaggio si controlla dove conta davvero. */
function campiInErrore(esito: { campo: string }[]): string[] {
  return esito.map((e) => e.campo)
}

function paragrafi(blocchi: BloccoPrestampato[]): string[] {
  return blocchi.filter((b) => b.tipo === 'paragrafo').map((b) => b.testo)
}

function sezioni(blocchi: BloccoPrestampato[]): string[] {
  return blocchi.filter((b) => b.tipo === 'sezione').map((b) => b.titolo)
}

function righeCampo(blocchi: BloccoPrestampato[]): CampoPrestampato[] {
  return blocchi.flatMap((b) => (b.tipo === 'campi' ? b.campi : []))
}

function etichetteCampo(blocchi: BloccoPrestampato[]): string[] {
  return righeCampo(blocchi).map((c) => c.etichetta)
}

function valoreDi(blocchi: BloccoPrestampato[], etichetta: string): string | null | undefined {
  return righeCampo(blocchi).find((c) => c.etichetta === etichetta)?.valore
}

function caselle(blocchi: BloccoPrestampato[]): { testo: string; spuntata?: boolean }[] {
  return blocchi.flatMap((b) => (b.tipo === 'caselle' ? b.caselle : []))
}

function tabelle(blocchi: BloccoPrestampato[]) {
  return blocchi.filter((b) => b.tipo === 'tabella')
}

function riquadri(blocchi: BloccoPrestampato[]) {
  return blocchi.filter((b) => b.tipo === 'riquadro')
}

// ─── Il registro degli otto ─────────────────────────────────────────────────────

describe('prestampati/modelli/genitore — il registro', () => {
  it('porta gli otto slug della specifica, senza doppioni', () => {
    expect(MODELLI_GENITORE.map((m) => m.slug)).toEqual([
      'scheda_sanitaria',
      'autorizzazione_farmaci',
      'dieta_speciale',
      'delega_ritiro',
      'permesso_orario',
      'autorizzazione_uscita',
      'certificato_iscrizione_frequenza',
      'certificato_bonus_nido',
    ])
    expect(new Set(MODELLI_GENITORE.map((m) => m.slug)).size).toBe(8)
  })

  it('si cerca per slug, e uno slug sconosciuto vale null (non un’eccezione)', () => {
    expect(modelloGenitore('delega_ritiro')).toBe(modelloDelegaRitiro)
    expect(modelloGenitore('modulo_inesistente')).toBeNull()
  })

  it('dichiara la firma che il §3 della specifica gli assegna', () => {
    expect(modelloSchedaSanitaria.firma).toBe('otp_genitore')
    expect(modelloAutorizzazioneFarmaci.firma).toBe('otp_genitore')
    expect(modelloDietaSpeciale.firma).toBe('otp_genitore')
    // L'unico che il cartaceo fa firmare a entrambi i genitori.
    expect(modelloDelegaRitiro.firma).toBe('otp_due_genitori')
    expect(modelloPermessoOrario.firma).toBe('otp_genitore')
    expect(modelloAutorizzazioneUscita.firma).toBe('otp_genitore')
    // Documenti che escono dalla scuola verso un ente.
    expect(modelloCertificatoIscrizioneFrequenza.firma).toBe('legale_rappresentante')
    expect(modelloCertificatoBonusNido.firma).toBe('legale_rappresentante')
  })

  it('i tre moduli sanitari sono già dentro il gate di `TIPI_SANITARI`', () => {
    // Il gate decide CHI vede il documento: uno slug non classificato diventerebbe
    // visibile a tutta la segreteria di ogni plesso.
    for (const slug of ['scheda_sanitaria', 'autorizzazione_farmaci', 'dieta_speciale']) {
      expect(TIPI_SANITARI).toContain(slug)
    }
  })

  it('i certificati sono disponibili anche al genitore, i moduli solo a lui', () => {
    expect(modelloCertificatoIscrizioneFrequenza.disponibileA).toBe('genitore_e_segreteria')
    expect(modelloCertificatoBonusNido.disponibileA).toBe('genitore_e_segreteria')
    for (const m of [modelloSchedaSanitaria, modelloDietaSpeciale, modelloPermessoOrario]) {
      expect(m.disponibileA).toBe('genitore')
    }
  })
})

// ─── Art. 9 GDPR: da qui dentro non esce nessun log ─────────────────────────────

describe('prestampati/modelli/genitore — i dati sanitari non hanno una via verso i log', () => {
  it('il modulo non importa il logger e non chiama console', () => {
    // 05, 06 e 07 maneggiano allergie, farmaci e diagnosi di un minore. Finché questo
    // file resta puro, un allergene in `app_log` non è «improbabile»: è impossibile.
    // `no-console` di ESLint copre metà del rischio; l'altra metà è `logEvento({ …,
    // allergene })`, che passerebbe il gate senza che nessuno se ne accorga.
    const sorgente = readFileSync(join(process.cwd(), 'src/lib/prestampati/modelli/genitore.ts'), 'utf8')
    expect(sorgente).not.toMatch(/from\s+'@\/lib\/logging/)
    expect(sorgente).not.toMatch(/\bconsole\s*\./)
  })
})

// ─── Il nucleo comune non si chiede mai ─────────────────────────────────────────

describe('prestampati/modelli/genitore — il nucleo comune non passa dal form', () => {
  /** Le chiavi che l'app ha già in archivio (tabella del README dei prestampati). */
  const CHIAVI_VIETATE = [
    'nome',
    'cognome',
    'dataNascita',
    'data_nascita',
    'luogoNascita',
    'luogo_nascita',
    'codiceFiscale',
    'codice_fiscale',
    'sezione',
    'classeSezione',
    'classe_sezione',
    'annoScolastico',
    'anno_scolastico',
    'sede',
    'scuola',
    'ragioneSociale',
    'piva',
    'sedeLegale',
    'legaleRappresentante',
    'genitore',
    'genitori',
  ]

  /** Le etichette esatte con cui il nucleo compare sul foglio: nessun campo le ripete. */
  const ETICHETTE_VIETATE = [
    'cognome',
    'nome',
    'data di nascita',
    'luogo di nascita',
    'codice fiscale',
    'sezione/classe',
    'anno scolastico',
    'sede',
    'denominazione',
    'p.iva/c.f.',
    'sede legale',
  ]

  /** I campi che ripeterebbero un dato del nucleo, per nome o per etichetta. */
  function campiVietati(campi: readonly CampoModulo[]): string[] {
    return campi
      .filter(
        (c) =>
          CHIAVI_VIETATE.includes(c.nome) || ETICHETTE_VIETATE.includes(c.etichetta.trim().toLowerCase())
      )
      .map((c) => c.nome)
  }

  it('il controllo ha i denti: su un campo «Codice fiscale» scatterebbe', () => {
    // Senza questo caso di riprova i due test qui sotto passerebbero anche con una lista
    // di chiavi sbagliata, cioè continuando a dire «verde» mentre non guardano niente.
    expect(
      campiVietati([{ nome: 'codiceFiscale', etichetta: 'Codice fiscale', tipo: 'testo', obbligatorio: true }])
    ).toEqual(['codiceFiscale'])
    expect(
      campiVietati([{ nome: 'cfMinore', etichetta: 'Codice fiscale', tipo: 'testo', obbligatorio: true }])
    ).toEqual(['cfMinore'])
  })

  it('nessuno degli otto modelli richiede un dato che l’app ha già', () => {
    const colpevoli = MODELLI_GENITORE.flatMap((m) => campiVietati(m.campi).map((nome) => `${m.slug}.${nome}`))
    expect(colpevoli).toEqual([])
  })

  it('nemmeno le colonne delle tabelle ripetibili lo richiedono', () => {
    const colpevoli = MODELLI_GENITORE.flatMap((m) =>
      m.campi.flatMap((c) =>
        (c.colonne ?? [])
          // Le colonne delle tabelle descrivono TERZE persone (un delegato, un contatto
          // d'emergenza): «nomeCompleto» lì dentro non è il bambino.
          .filter((col) => col.nome !== 'nomeCompleto' && CHIAVI_VIETATE.includes(col.nome))
          .map((col) => `${m.slug}.${c.nome}.${col.nome}`)
      )
    )
    expect(colpevoli).toEqual([])
  })

  it('i campi che oggi si richiedono ogni volta dichiarano dove dovranno atterrare', () => {
    // Non è cosmesi: è l'elenco esatto di ciò che diventa prefill il giorno in cui le
    // migrazioni tornano possibili. Se sparisce, sparisce anche la memoria del debito.
    const daPromuovere = modelloSchedaSanitaria.campi
      .filter((c) => c.daPromuovereInAnagrafica)
      .map((c) => c.nome)
    expect(daPromuovere).toContain('pediatraNome')
    expect(daPromuovere).toContain('pediatraTelefono')
    expect(daPromuovere).toContain('contattiEmergenza')
  })
})

// ─── 05 — Scheda sanitaria ──────────────────────────────────────────────────────

const RISPOSTE_SCHEDA = {
  pediatraNome: 'Dott.ssa Prova Inventata',
  pediatraTelefono: '081 0000003',
  asl: 'ASL di prova — Distretto 00',
  allergie: true,
  allergieDettaglio: 'Frutta a guscio',
  intolleranze: false,
  patologie: false,
  terapie: false,
  vaccinazioni: true,
  ausili: false,
  notePersonale: 'Si addormenta solo con il suo peluche.',
  contattiEmergenza: [
    { ordine: 2, nomeCompleto: 'Zia Inventata', relazione: 'Zia', telefono: '081 0000005' },
    { ordine: 1, nomeCompleto: 'Nonna Inventata', relazione: 'Nonna', telefono: '081 0000004' },
  ],
}

describe('05 — scheda sanitaria', () => {
  it('respinge l’input incompleto: senza pediatra e senza contatti d’emergenza', () => {
    const esito = modelloSchedaSanitaria.componi(dati(), {
      ...RISPOSTE_SCHEDA,
      pediatraNome: '   ',
      contattiEmergenza: [],
    })
    expect(campiInErrore(erroriDi(esito))).toEqual(
      expect.arrayContaining(['pediatraNome', 'contattiEmergenza'])
    )
  })

  it('respinge «allergie: sì» senza la specifica, e la accetta con', () => {
    const senza = modelloSchedaSanitaria.componi(dati(), { ...RISPOSTE_SCHEDA, allergieDettaglio: '  ' })
    expect(erroriDi(senza)[0]).toEqual({
      campo: 'allergieDettaglio',
      messaggio: 'Indicazione obbligatoria quando la risposta è «sì»',
    })
    expect(modelloSchedaSanitaria.componi(dati(), RISPOSTE_SCHEDA).ok).toBe(true)
  })

  it('non pretende la specifica quando la risposta è «no»', () => {
    const esito = modelloSchedaSanitaria.componi(dati(), {
      ...RISPOSTE_SCHEDA,
      allergie: false,
      allergieDettaglio: undefined,
    })
    expect(esito.ok).toBe(true)
  })

  it('riporta il testo del `.docx` parola per parola, dichiarazione e informativa', () => {
    const testi = paragrafi(componiOk(modelloSchedaSanitaria, dati(), RISPOSTE_SCHEDA))
    expect(testi).toContain(
      'Il/La sottoscritto/a dichiara che le informazioni sopra riportate corrispondono al vero e si impegna a comunicare tempestivamente alla scuola qualsiasi variazione dello stato di salute del/la proprio/a figlio/a.'
    )
    expect(testi).toContain(
      'I dati sopra riportati saranno trattati dalla scuola nel rispetto del Regolamento UE 2016/679 (GDPR) esclusivamente per le finalità connesse alla tutela della salute, della sicurezza e della vita scolastica del minore.'
    )
  })

  it('stampa il nucleo comune senza averlo chiesto, e spunta la sede da sé', () => {
    const blocchi = componiOk(modelloSchedaSanitaria, dati(), RISPOSTE_SCHEDA)
    expect(valoreDi(blocchi, 'Cognome')).toBe('Sanniti')
    expect(valoreDi(blocchi, 'Data di nascita')).toBe('17/04/2022')
    expect(valoreDi(blocchi, 'Sezione/Classe')).toBe('Coccinelle')
    expect(valoreDi(blocchi, 'Anno scolastico')).toBe('2026/2027')
    expect(caselle(blocchi)).toContainEqual({ testo: 'Sede: Kidville Prova', spuntata: true })
  })

  it('degrada omettendo la riga: senza sezione niente «Sezione/Classe», senza ASL niente riga ASL', () => {
    const senzaSezione = componiOk(
      modelloSchedaSanitaria,
      dati({ alunno: { ...dati().alunno, sezione: null } }),
      { ...RISPOSTE_SCHEDA, asl: '   ' }
    )
    const etichette = etichetteCampo(senzaSezione)
    expect(etichette).not.toContain('Sezione/Classe')
    expect(etichette).not.toContain('ASL / Studio medico')
    // E non compare nessun surrogato: niente «N.D.», niente riga vuota travestita.
    expect(righeCampo(senzaSezione).map((c) => c.valore)).not.toContain('N.D.')
  })

  it('senza sede in archivio non inventa la casella', () => {
    const blocchi = componiOk(
      modelloSchedaSanitaria,
      dati({ sede: { ...dati().sede, scuola_nome: null } }),
      RISPOSTE_SCHEDA
    )
    expect(caselle(blocchi).filter((c) => c.testo.startsWith('Sede'))).toEqual([])
  })

  it('i contatti d’emergenza escono in ordine di chiamata, senza righe libere in coda', () => {
    const blocchi = componiOk(modelloSchedaSanitaria, dati(), RISPOSTE_SCHEDA)
    const tabella = tabelle(blocchi).find((t) => t.intestazioni[0] === 'Ordine di chiamata')
    expect(tabella?.righe.map((r) => r[1])).toEqual(['Nonna Inventata', 'Zia Inventata'])
    // Una riga libera qui sarebbe un numero scritto a penna che l'app non conosce.
    expect(tabella?.righeVuote).toBe(0)
  })

  it('un genitore senza telefono non trascina il nome dell’altro nella colonna accanto', () => {
    const blocchi = componiOk(
      modelloSchedaSanitaria,
      dati({
        genitori: [
          { nomeCompleto: 'Sanniti Marco', ruolo: 'padre' },
          { nomeCompleto: 'Ferrone Giulia', ruolo: 'madre', telefono: '081 0000002' },
        ],
      }),
      RISPOSTE_SCHEDA
    )
    const bloccoPadre = blocchi.find(
      (b) => b.tipo === 'campi' && b.campi.some((c) => c.etichetta === 'Padre/Tutore — Cognome e nome')
    )
    expect(bloccoPadre?.tipo).toBe('campi')
    if (bloccoPadre?.tipo === 'campi') {
      expect(bloccoPadre.campi.map((c) => c.etichetta)).toEqual(['Padre/Tutore — Cognome e nome'])
    }
    expect(valoreDi(blocchi, 'Madre/Tutrice — Cognome e nome')).toBe('Ferrone Giulia')
  })

  it('senza genitori collegati non lascia un titolo di sezione orfano', () => {
    const blocchi = componiOk(modelloSchedaSanitaria, dati({ genitori: [] }), RISPOSTE_SCHEDA)
    expect(sezioni(blocchi)).not.toContain('Dati dei genitori/tutori')
    expect(sezioni(blocchi)).toContain("Contatti d'emergenza")
  })

  it('la risposta sì/no finisce sul foglio come parola, non come casella ambigua', () => {
    const blocchi = componiOk(modelloSchedaSanitaria, dati(), RISPOSTE_SCHEDA)
    expect(valoreDi(blocchi, 'Allergie (alimentari, farmacologiche, da contatto, respiratorie)')).toBe('SÌ')
    expect(valoreDi(blocchi, 'Intolleranze alimentari')).toBe('NO')
    expect(valoreDi(blocchi, 'Vaccinazioni aggiornate come da normativa vigente (L. 119/2017)')).toBe('SÌ')
    expect(valoreDi(blocchi, 'Se sì, specificare')).toBe('Frutta a guscio')
  })

  it('la sezione delle note sparisce quando le note non ci sono', () => {
    const blocchi = componiOk(modelloSchedaSanitaria, dati(), { ...RISPOSTE_SCHEDA, notePersonale: '   ' })
    expect(sezioni(blocchi)).not.toContain('Altre informazioni utili per il personale educativo')
  })
})

// ─── 06 — Autorizzazione alla somministrazione di farmaci ───────────────────────

const RISPOSTE_FARMACI = {
  farmaco: 'Farmaco di prova',
  dosaggio: 'una misurina',
  modalita: 'per via orale',
  orario: 'ore 13:00, dopo il pasto',
  dal: '2026-09-01',
  al: '2026-09-30',
  prescrizionePath: 'prescrizioni/finta-di-prova.pdf',
}

describe('06 — autorizzazione somministrazione farmaci', () => {
  it('respinge l’input incompleto: farmaco vuoto e prescrizione mancante', () => {
    const esito = modelloAutorizzazioneFarmaci.componi(dati(), {
      ...RISPOSTE_FARMACI,
      farmaco: '  ',
      prescrizionePath: '',
    })
    expect(campiInErrore(erroriDi(esito))).toEqual(expect.arrayContaining(['farmaco', 'prescrizionePath']))
  })

  it('respinge una durata che finisce prima di cominciare', () => {
    const esito = modelloAutorizzazioneFarmaci.componi(dati(), {
      ...RISPOSTE_FARMACI,
      dal: '2026-09-30',
      al: '2026-09-01',
    })
    expect(erroriDi(esito)).toContainEqual({ campo: 'al', messaggio: 'La fine del trattamento precede l’inizio' })
  })

  it('riporta la liberatoria del `.docx` parola per parola', () => {
    const testi = paragrafi(componiOk(modelloAutorizzazioneFarmaci, dati(), RISPOSTE_FARMACI))
    expect(testi).toContain(
      "Il/La sottoscritto/a, genitore/tutore dell'alunno/a sopra indicato/a, autorizza il personale della scuola a somministrare il farmaco sopra descritto secondo le indicazioni fornite dal pediatra, sollevando la scuola e il personale incaricato da ogni responsabilità per le conseguenze derivanti da una corretta somministrazione conforme alla prescrizione medica allegata."
    )
  })

  it('compone la durata in una riga sola e spunta l’allegato', () => {
    const blocchi = componiOk(modelloAutorizzazioneFarmaci, dati(), RISPOSTE_FARMACI)
    expect(valoreDi(blocchi, 'Durata del trattamento')).toBe('dal 01/09/2026 al 30/09/2026')
    expect(caselle(blocchi)).toContainEqual({
      testo: 'Si allega prescrizione medica / piano terapeutico del pediatra',
      spuntata: true,
    })
  })

  it('porta il registro delle dosi con le tre righe libere della specifica', () => {
    const tabella = tabelle(componiOk(modelloAutorizzazioneFarmaci, dati(), RISPOSTE_FARMACI))[0]
    expect(tabella.intestazioni).toEqual(['Data', 'Ora', 'Dose somministrata', 'Firma operatore'])
    expect(tabella.righe).toEqual([])
    expect(tabella.righeVuote).toBe(3)
  })

  it('il riquadro della Direzione resta anche vuoto, e si riempie quando il visto arriva', () => {
    const senza = riquadri(componiOk(modelloAutorizzazioneFarmaci, dati(), RISPOSTE_FARMACI))[0]
    expect(senza.titolo).toBe('Per accettazione — La Direzione')
    expect(senza.campi.map((c) => c.valore)).toEqual([null, null])

    const con = riquadri(
      componiOk(
        modelloAutorizzazioneFarmaci,
        dati({ visto: { utente: 'Direzione di prova', istante: '14/08/2026 09:15' } }),
        RISPOSTE_FARMACI
      )
    )[0]
    expect(con.campi.map((c) => c.valore)).toEqual(['14/08/2026 09:15', 'Direzione di prova'])
  })

  it('il richiedente è chi firma, non il primo dell’anagrafica', () => {
    // La madre apre il modulo: sotto «Genitore/tutore richiedente» va il suo nome, anche
    // se in `student_parents` il padre viene prima. È il nome di chi si assume la
    // responsabilità di far somministrare un farmaco al proprio figlio.
    const dallaMadre = componiOk(
      modelloAutorizzazioneFarmaci,
      dati({ richiedente: GENITORI_PROVA[1] }),
      RISPOSTE_FARMACI
    )
    expect(valoreDi(dallaMadre, 'Cognome e nome')).toBe('Ferrone Giulia')
    expect(valoreDi(dallaMadre, 'Telefono')).toBe('081 0000002')
  })

  it('con due tutori e nessun richiedente dichiarato il blocco sparisce, invece di indovinare', () => {
    const senza = componiOk(modelloAutorizzazioneFarmaci, dati({ richiedente: null }), RISPOSTE_FARMACI)
    expect(sezioni(senza)).not.toContain('Genitore/tutore richiedente')
    expect(righeCampo(senza).map((c) => c.valore)).not.toContain('Sanniti Marco')

    // Con un solo tutore in anagrafica non c'è niente da indovinare: è lui, e il blocco resta.
    const unico = componiOk(
      modelloAutorizzazioneFarmaci,
      dati({ genitori: [GENITORI_PROVA[1]], richiedente: null }),
      RISPOSTE_FARMACI
    )
    expect(valoreDi(unico, 'Cognome e nome')).toBe('Ferrone Giulia')
  })

  it('la composizione riuscita restituisce anche le risposte validate', () => {
    // La route ricava `expiry_date` dall'`al` del 06 e dell'08, e dalla `validita` del 07:
    // senza le risposte qui dentro dovrebbe validarle una seconda volta per conto proprio,
    // e due validazioni della stessa cosa divergono al primo campo che cambia.
    const esito = modelloAutorizzazioneFarmaci.componi(dati(), RISPOSTE_FARMACI)
    if (!esito.ok) throw new Error(`attesa una composizione riuscita: ${JSON.stringify(esito.errori)}`)
    expect(esito.risposte.al).toBe('2026-09-30')

    // Sono le risposte VALIDATE, non le grezze: qui lo schema ha già tolto gli spazi.
    const conSpazi = modelloAutorizzazioneFarmaci.componi(dati(), {
      ...RISPOSTE_FARMACI,
      farmaco: '   Farmaco di prova   ',
    })
    if (!conSpazi.ok) throw new Error('attesa una composizione riuscita')
    expect(conSpazi.risposte.farmaco).toBe('Farmaco di prova')
  })
})

// ─── 07 — Richiesta dieta speciale ──────────────────────────────────────────────

const RISPOSTE_DIETA = {
  motivo: 'allergia_alimentare' as const,
  alimenti: [
    { alimento: 'Latte vaccino', sostituzione: 'Bevanda di riso' },
    { alimento: 'Uova', sostituzione: '' },
  ],
  certificatoPath: 'certificati/finto-di-prova.pdf',
  medico: 'Dott. Inventato',
  dataCertificato: '2026-07-01',
  validita: '30/06/2027',
}

describe('07 — richiesta dieta speciale', () => {
  it('distingue il motivo sanitario da quello che non lo è', () => {
    expect(motivoSanitario('allergia_alimentare')).toBe(true)
    expect(motivoSanitario('intolleranza_alimentare')).toBe(true)
    expect(motivoSanitario('etico_religiosi')).toBe(false)
    expect(motivoSanitario('scelta_alimentare')).toBe(false)
    // «Altro» non si presume sanitario: pretendere un certificato medico da chi scrive
    // «non digerisce il pomodoro» sarebbe una raccolta di dati non necessaria.
    expect(motivoSanitario('altro')).toBe(false)
  })

  it('pretende il certificato solo quando il motivo è sanitario', () => {
    const sanitarioSenza = modelloDietaSpeciale.componi(dati(), {
      ...RISPOSTE_DIETA,
      certificatoPath: '',
      medico: '',
      dataCertificato: undefined,
    })
    expect(campiInErrore(erroriDi(sanitarioSenza))).toEqual(
      expect.arrayContaining(['certificatoPath', 'medico', 'dataCertificato'])
    )

    const eticoSenza = modelloDietaSpeciale.componi(dati(), {
      motivo: 'etico_religiosi',
      alimenti: [{ alimento: 'Carne di maiale' }],
    })
    expect(eticoSenza.ok).toBe(true)
  })

  it('respinge «Altro» senza la specifica e senza nemmeno un alimento', () => {
    const esito = modelloDietaSpeciale.componi(dati(), { motivo: 'altro', alimenti: [] })
    expect(campiInErrore(erroriDi(esito))).toEqual(expect.arrayContaining(['altroMotivo', 'alimenti']))
  })

  it('spunta un solo motivo fra i cinque del cartaceo', () => {
    const blocchi = componiOk(modelloDietaSpeciale, dati(), RISPOSTE_DIETA)
    // Il blocco dei motivi, non le altre caselle del foglio (la sede, il certificato).
    const motivi = blocchi.find(
      (b) => b.tipo === 'caselle' && b.caselle.some((c) => c.testo === 'Motivi etico-religiosi')
    )
    if (motivi?.tipo !== 'caselle') throw new Error('il blocco dei motivi non è stato composto')
    expect(motivi.caselle.map((c) => c.testo)).toEqual([
      'Allergia alimentare',
      'Intolleranza alimentare',
      'Motivi etico-religiosi',
      'Scelta alimentare (vegetariana/vegana)',
      'Altro',
    ])
    expect(motivi.caselle.filter((c) => c.spuntata).map((c) => c.testo)).toEqual(['Allergia alimentare'])
  })

  it('riporta la formula di chiusura del `.docx` e la tabella con le righe libere', () => {
    const blocchi = componiOk(modelloDietaSpeciale, dati(), RISPOSTE_DIETA)
    expect(paragrafi(blocchi)).toContain(
      "Il/La sottoscritto/a chiede che al/alla proprio/a figlio/a venga garantita la dieta sopra indicata e dichiara che le informazioni fornite corrispondono al vero."
    )
    const tabella = tabelle(blocchi)[0]
    expect(tabella.intestazioni).toEqual(['Alimento da escludere', 'Sostituzione proposta'])
    expect(tabella.righe).toEqual([
      ['Latte vaccino', 'Bevanda di riso'],
      ['Uova', ''],
    ])
    expect(tabella.righeVuote).toBe(3)
  })

  it('su una dieta non sanitaria non apre una sezione «certificazione medica» vuota', () => {
    const blocchi = componiOk(modelloDietaSpeciale, dati(), {
      motivo: 'scelta_alimentare',
      alimenti: [{ alimento: 'Carne' }],
    })
    expect(sezioni(blocchi)).not.toContain('Certificazione medica')
    expect(caselle(blocchi).map((c) => c.testo)).not.toContain('Si allega certificato medico')
  })

  it('il riquadro della presa in carico resta nel PDF, come dice la convenzione «RISERVATO A…»', () => {
    const riquadro = riquadri(componiOk(modelloDietaSpeciale, dati(), RISPOSTE_DIETA))[0]
    expect(riquadro.titolo).toBe('Riservato a segreteria/cucina')
    expect(riquadro.campi.map((c) => c.etichetta)).toEqual(['Preso in carico il', 'Da'])
  })
})

// ─── 08 — Delega al ritiro ──────────────────────────────────────────────────────

const RISPOSTE_DELEGA = {
  delegati: [
    {
      nomeCompleto: 'Nonno Inventato',
      relazione: 'Nonno',
      documento: 'CI AB0000000',
      documentoPath: 'deleghe/finto-di-prova.jpg',
    },
  ],
  validita: 'periodo' as const,
  dal: '2026-09-01',
  al: '2026-12-31',
}

const DUE_FIRME = [
  { firmatario: 'Sanniti Marco', istante: '14/08/2026 09:00' },
  { firmatario: 'Ferrone Giulia', istante: '14/08/2026 10:30' },
]

describe('08 — delega al ritiro', () => {
  it('dichiara quando servono due firme', () => {
    expect(richiedeDueFirme(dati())).toBe(true)
    expect(richiedeDueFirme(dati({ genitori: [dati().genitori[0]] }))).toBe(false)
    // Genitori separati: la doppia firma resta obbligatoria anche se in anagrafica ne
    // risulta uno solo — è proprio il caso in cui il consenso di chi manca conta di più.
    expect(
      richiedeDueFirme(
        dati({ genitori: [dati().genitori[0]], alunno: { ...dati().alunno, genitoriSeparati: true } })
      )
    ).toBe(true)
  })

  it('non compone il PDF finché la seconda firma manca', () => {
    const esito = modelloDelegaRitiro.componi(
      dati({ sottoscrizioni: [DUE_FIRME[0]] }),
      RISPOSTE_DELEGA
    )
    expect(erroriDi(esito)[0].messaggio).toMatch(/seconda sottoscrizione/)
    expect(modelloDelegaRitiro.componi(dati({ sottoscrizioni: DUE_FIRME }), RISPOSTE_DELEGA).ok).toBe(true)
  })

  it('con un solo tutore in anagrafica lo dichiara e non chiede la seconda firma', () => {
    const soloUno = dati({ genitori: [dati().genitori[0]], sottoscrizioni: [DUE_FIRME[0]] })
    const blocchi = componiOk(modelloDelegaRitiro, soloUno, RISPOSTE_DELEGA)
    expect(paragrafi(blocchi)).toContain(
      "In anagrafica risulta un solo genitore/tutore per l'alunno/a: la presente delega è sottoscritta dal solo firmatario ed è valida senza la seconda firma."
    )
  })

  it('riporta entrambe le tracce di firma, numerate', () => {
    const blocchi = componiOk(modelloDelegaRitiro, dati({ sottoscrizioni: DUE_FIRME }), RISPOSTE_DELEGA)
    expect(sezioni(blocchi)).toContain('Firme dei genitori/tutori')
    expect(valoreDi(blocchi, '1)')).toBe('Sanniti Marco — firmato con OTP il 14/08/2026 09:00')
    expect(valoreDi(blocchi, '2)')).toBe('Ferrone Giulia — firmato con OTP il 14/08/2026 10:30')
    // Con due firme la dichiarazione del tutore unico non deve comparire.
    expect(paragrafi(blocchi).join(' ')).not.toMatch(/un solo genitore\/tutore/)
  })

  it('toglie l’email dal firmatario prima di stamparlo sul foglio', () => {
    // `buildReceiptPdf()` formatta il firmatario come «Nome <email>»: un chiamante che
    // riusasse quella stringa infilerebbe l'email in un foglio che la famiglia consegna.
    const blocchi = componiOk(
      modelloDelegaRitiro,
      dati({
        sottoscrizioni: [
          { firmatario: 'Sanniti Marco <prova.padre@example.invalid>', istante: '14/08/2026 09:00' },
          DUE_FIRME[1],
        ],
      }),
      RISPOSTE_DELEGA
    )
    expect(valoreDi(blocchi, '1)')).toBe('Sanniti Marco — firmato con OTP il 14/08/2026 09:00')
    expect(JSON.stringify(blocchi)).not.toContain('@example.invalid')
  })

  it('respinge un periodo senza estremi e uno che finisce prima di cominciare', () => {
    const senzaDate = modelloDelegaRitiro.componi(dati({ sottoscrizioni: DUE_FIRME }), {
      ...RISPOSTE_DELEGA,
      dal: undefined,
      al: undefined,
    })
    expect(campiInErrore(erroriDi(senzaDate))).toEqual(expect.arrayContaining(['dal', 'al']))

    const rovesciato = modelloDelegaRitiro.componi(dati({ sottoscrizioni: DUE_FIRME }), {
      ...RISPOSTE_DELEGA,
      dal: '2026-12-31',
      al: '2026-09-01',
    })
    expect(erroriDi(rovesciato)).toContainEqual({ campo: 'al', messaggio: 'La fine del periodo precede l’inizio' })
  })

  it('una delega permanente non porta date: sarebbe una revoca che nessuno ha scritto', () => {
    // `expiry_date` nasce da `al` e alla scadenza i delegati a termine si disattivano da
    // soli: una delega dichiarata «fino a revoca scritta» con una data addosso smetterebbe
    // di valere in silenzio, e il nonno un mattino non potrebbe più prendere il bambino.
    const conScadenza = modelloDelegaRitiro.componi(dati({ sottoscrizioni: DUE_FIRME }), {
      delegati: RISPOSTE_DELEGA.delegati,
      validita: 'permanente',
      al: '2026-12-31',
    })
    expect(campiInErrore(erroriDi(conScadenza))).toContain('al')

    const conInizio = modelloDelegaRitiro.componi(dati({ sottoscrizioni: DUE_FIRME }), {
      delegati: RISPOSTE_DELEGA.delegati,
      validita: 'permanente',
      dal: '2026-09-01',
    })
    expect(campiInErrore(erroriDi(conInizio))).toContain('dal')

    // Senza date invece si compone, e sul foglio non resta nessuna riga di scadenza a
    // contraddire la casella spuntata.
    const blocchi = componiOk(modelloDelegaRitiro, dati({ sottoscrizioni: DUE_FIRME }), {
      delegati: RISPOSTE_DELEGA.delegati,
      validita: 'permanente',
    })
    expect(caselle(blocchi)).toContainEqual({ testo: 'Permanente (fino a revoca scritta)', spuntata: true })
    expect(etichetteCampo(blocchi)).not.toContain('Al')
    expect(etichetteCampo(blocchi)).not.toContain('Dal')
    expect(etichetteCampo(blocchi)).not.toContain('In data')
  })

  it('una delega a occasione singola vuole la data, e la stampa come «In data»', () => {
    const senzaData = modelloDelegaRitiro.componi(dati({ sottoscrizioni: DUE_FIRME }), {
      delegati: RISPOSTE_DELEGA.delegati,
      validita: 'occasione',
    })
    expect(campiInErrore(erroriDi(senzaData))).toContain('al')

    const blocchi = componiOk(modelloDelegaRitiro, dati({ sottoscrizioni: DUE_FIRME }), {
      delegati: RISPOSTE_DELEGA.delegati,
      validita: 'occasione',
      al: '2026-10-05',
    })
    expect(valoreDi(blocchi, 'In data')).toBe('05/10/2026')
    expect(etichetteCampo(blocchi)).not.toContain('Dal')
  })

  it('riporta la formula del `.docx` e la tabella dei delegati con le righe libere', () => {
    const blocchi = componiOk(modelloDelegaRitiro, dati({ sottoscrizioni: DUE_FIRME }), RISPOSTE_DELEGA)
    expect(paragrafi(blocchi)).toContain(
      "I sottoscritti, genitori/tutori dell'alunno/a sopra indicato/a, dichiarano di delegare al ritiro del/la proprio/a figlio/a da scuola le seguenti persone, assumendosene piena responsabilità:"
    )
    expect(paragrafi(blocchi)).toContain(
      'I sottoscritti si assumono ogni responsabilità civile e penale derivante dal ritiro del minore da parte delle persone sopra delegate ed esonerano la scuola da ogni responsabilità al riguardo.'
    )
    const tabella = tabelle(blocchi)[0]
    expect(tabella.intestazioni).toEqual([
      'Cognome e nome',
      'Relazione con il bambino/a',
      "Documento d'identità (tipo e n.)",
    ])
    expect(tabella.righe).toEqual([['Nonno Inventato', 'Nonno', 'CI AB0000000']])
    expect(tabella.righeVuote).toBe(3)
  })

  it('i deleganti escono numerati, come sul cartaceo', () => {
    const blocchi = componiOk(modelloDelegaRitiro, dati({ sottoscrizioni: DUE_FIRME }), RISPOSTE_DELEGA)
    expect(valoreDi(blocchi, 'Cognome e nome (1)')).toBe('Sanniti Marco')
    expect(valoreDi(blocchi, 'Cognome e nome (2)')).toBe('Ferrone Giulia')
  })
})

// ─── 09 — Permesso di entrata posticipata / uscita anticipata ───────────────────

describe('09 — permesso di entrata/uscita', () => {
  const USCITA = {
    giorno: '2026-09-15',
    tipo: 'uscita_anticipata' as const,
    oraUscita: '12:30',
    accompagnatore: ACCOMPAGNATORE_GENITORE,
  }

  it('respinge l’uscita senza orario e senza chi ritira', () => {
    const esito = modelloPermessoOrario.componi(dati(), { giorno: '2026-09-15', tipo: 'uscita_anticipata' })
    expect(campiInErrore(erroriDi(esito))).toEqual(expect.arrayContaining(['oraUscita', 'accompagnatore']))
  })

  it('respinge un orario che non è un orario', () => {
    const esito = modelloPermessoOrario.componi(dati(), { ...USCITA, oraUscita: '25:99' })
    expect(erroriDi(esito)).toContainEqual({ campo: 'oraUscita', messaggio: 'Orario non valido (atteso hh:mm)' })
  })

  const CHI_RITIRA = 'Persona che accompagna/ritira il bambino, se diversa dal genitore'

  it('«io stesso» diventa il nome del genitore che firma, non un codice e non il primo dell’elenco', () => {
    const blocchi = componiOk(modelloPermessoOrario, dati(), USCITA)
    expect(valoreDi(blocchi, CHI_RITIRA)).toBe('Sanniti Marco')

    // Il permesso lo chiede la madre: sul foglio esce il suo nome. Con `genitori[0]`
    // sarebbe uscito il padre — una persona che quel giorno non va a prendere nessuno, su
    // un foglio che l'educatrice legge prima di consegnare un bambino.
    const dallaMadre = componiOk(modelloPermessoOrario, dati({ richiedente: GENITORI_PROVA[1] }), USCITA)
    expect(valoreDi(dallaMadre, CHI_RITIRA)).toBe('Ferrone Giulia')
  })

  it('rifiuta «io stesso» quando il richiedente non si risolve in un nome', () => {
    // È lo stesso difetto che l'altro ramo rifiutava già: la riga sparirebbe per degrado e
    // resterebbe un permesso di uscita anticipata FIRMATO che non dice chi ritira.
    const senzaGenitori = modelloPermessoOrario.componi(dati({ genitori: [], richiedente: null }), USCITA)
    expect(erroriDi(senzaGenitori)).toContainEqual({
      campo: 'accompagnatore',
      messaggio: 'Il genitore/tutore richiedente non è indicato: il permesso non direbbe chi ritira il bambino/a',
    })

    // Due tutori e nessuno dichiarato: «io stesso» non si sa chi sia.
    expect(campiInErrore(erroriDi(modelloPermessoOrario.componi(dati({ richiedente: null }), USCITA)))).toContain(
      'accompagnatore'
    )

    // Sull'entrata posticipata non ritira nessuno, e il cancello non scatta.
    expect(
      modelloPermessoOrario.componi(dati({ genitori: [], richiedente: null }), {
        giorno: '2026-09-15',
        tipo: 'entrata_posticipata',
        oraArrivo: '10:00',
      }).ok
    ).toBe(true)
  })

  it('rifiuta un delegato che l’app non ha saputo risolvere in un nome', () => {
    // Senza questo cancello la riga sparirebbe per degrado, e resterebbe un permesso di
    // uscita anticipata che non dice chi ritira il bambino.
    const esito = modelloPermessoOrario.componi(dati(), {
      ...USCITA,
      accompagnatore: '11111111-2222-3333-4444-555555555555',
    })
    expect(erroriDi(esito)).toContainEqual({
      campo: 'accompagnatore',
      messaggio: 'Il delegato indicato non risulta fra i delegati attivi',
    })

    const risolto = modelloPermessoOrario.componi(
      dati({ accompagnatore: 'Nonno Inventato' }),
      { ...USCITA, accompagnatore: '11111111-2222-3333-4444-555555555555' }
    )
    expect(risolto.ok).toBe(true)
  })

  it('spunta solo il tipo scelto e stampa i due orari quando sono entrambi', () => {
    const blocchi = componiOk(modelloPermessoOrario, dati(), {
      giorno: '2026-09-15',
      tipo: 'entrambe',
      oraArrivo: '10:00',
      oraUscita: '12:30',
      accompagnatore: ACCOMPAGNATORE_GENITORE,
    })
    expect(caselle(blocchi)).toEqual(
      expect.arrayContaining([
        { testo: 'Entrata posticipata', spuntata: true },
        { testo: 'Uscita anticipata', spuntata: true },
      ])
    )
    expect(valoreDi(blocchi, 'Orario previsto di arrivo')).toBe('10:00')
    expect(valoreDi(blocchi, 'Orario previsto di uscita')).toBe('12:30')
  })

  it('sull’entrata posticipata non stampa la riga dell’orario di uscita', () => {
    const blocchi = componiOk(modelloPermessoOrario, dati(), {
      giorno: '2026-09-15',
      tipo: 'entrata_posticipata',
      oraArrivo: '10:00',
    })
    expect(etichetteCampo(blocchi)).not.toContain('Orario previsto di uscita')
    expect(caselle(blocchi)).toContainEqual({ testo: 'Uscita anticipata', spuntata: false })
  })

  it('il motivo è facoltativo, e quando manca la riga non compare', () => {
    const blocchi = componiOk(modelloPermessoOrario, dati(), USCITA)
    expect(etichetteCampo(blocchi)).not.toContain('Motivo (facoltativo)')
    const conMotivo = componiOk(modelloPermessoOrario, dati(), { ...USCITA, motivo: 'Visita di controllo' })
    expect(valoreDi(conMotivo, 'Motivo (facoltativo)')).toBe('Visita di controllo')
  })

  it('la ricorrenza vuole i giorni e la data insieme, o nessuno dei due', () => {
    expect(
      campiInErrore(erroriDi(modelloPermessoOrario.componi(dati(), { ...USCITA, ricorrenzaGiorni: ['lunedi'] })))
    ).toContain('ricorrenzaFino')
    expect(
      campiInErrore(
        erroriDi(modelloPermessoOrario.componi(dati(), { ...USCITA, ricorrenzaFino: '2026-12-31' }))
      )
    ).toContain('ricorrenzaGiorni')

    const blocchi = componiOk(modelloPermessoOrario, dati(), {
      ...USCITA,
      ricorrenzaGiorni: ['lunedi', 'mercoledi'],
      ricorrenzaFino: '2026-12-31',
    })
    expect(valoreDi(blocchi, 'Permesso ricorrente')).toBe('tutti i lunedì e mercoledì fino al 31/12/2026')

    // Con tre giorni la «e» resta una sola, davanti all'ultimo.
    const tre = componiOk(modelloPermessoOrario, dati(), {
      ...USCITA,
      ricorrenzaGiorni: ['lunedi', 'mercoledi', 'venerdi'],
      ricorrenzaFino: '2026-12-31',
    })
    expect(valoreDi(tre, 'Permesso ricorrente')).toBe(
      'tutti i lunedì, mercoledì e venerdì fino al 31/12/2026'
    )
  })

  it('porta la data della richiesta accanto al giorno del permesso', () => {
    const blocchi = componiOk(modelloPermessoOrario, dati(), USCITA)
    expect(valoreDi(blocchi, 'Data della richiesta')).toBe('14/08/2026')
    expect(valoreDi(blocchi, 'Giorno del permesso')).toBe('15/09/2026')
  })
})

// ─── 10 — Autorizzazione a uscite didattiche ────────────────────────────────────

const USCITA_PISCINA = {
  tipo: 'piscina' as const,
  destinazione: 'Piscina comunale di prova',
  data: '2026-10-20',
  oraPartenza: '09:00',
  oraRientro: '12:30',
  mezzo: 'pullman_privato' as const,
  attivitaInAcqua: true,
}

describe('10 — autorizzazione a uscite didattiche', () => {
  it('non si compone senza i dati dell’uscita', () => {
    const esito = modelloAutorizzazioneUscita.componi(dati(), { autorizzo: true, recapito: '081 0000001' })
    expect(erroriDi(esito)[0].messaggio).toMatch(/uscita/i)
  })

  it('per un’attività in acqua pretende la risposta «sa nuotare»', () => {
    const senza = modelloAutorizzazioneUscita.componi(dati({ uscita: USCITA_PISCINA }), {
      autorizzo: true,
      recapito: '081 0000001',
    })
    expect(erroriDi(senza)).toContainEqual({
      campo: 'saNuotare',
      messaggio: "Per un'attività in acqua va indicato se il bambino/a sa nuotare",
    })

    // Fuori dall'acqua la domanda non si fa, e l'assenza non è un errore.
    const aPiedi = modelloAutorizzazioneUscita.componi(
      dati({ uscita: { ...USCITA_PISCINA, tipo: 'uscita_didattica', mezzo: 'a_piedi', attivitaInAcqua: false } }),
      { autorizzo: true, recapito: '081 0000001' }
    )
    expect(aPiedi.ok).toBe(true)
  })

  it('respinge un recapito che non è un numero', () => {
    const esito = modelloAutorizzazioneUscita.componi(dati({ uscita: USCITA_PISCINA }), {
      autorizzo: true,
      recapito: 'chiamate mia sorella',
      saNuotare: true,
    })
    expect(campiInErrore(erroriDi(esito))).toContain('recapito')
  })

  it('riporta la formula del `.docx` quando il genitore autorizza', () => {
    const blocchi = componiOk(modelloAutorizzazioneUscita, dati({ uscita: USCITA_PISCINA }), {
      autorizzo: true,
      recapito: '081 0000001',
      saNuotare: true,
    })
    expect(paragrafi(blocchi)).toContain(
      "Il/La sottoscritto/a autorizza il/la proprio/a figlio/a a partecipare all'attività sopra descritta, sollevando la scuola da responsabilità per fatti non imputabili a negligenza del personale."
    )
    expect(paragrafi(blocchi)).toContain(
      "Si ricorda di segnalare eventuali informazioni sanitarie rilevanti già indicate nella scheda sanitaria dell'alunno/a."
    )
    expect(valoreDi(blocchi, 'Il/La bambino/a sa nuotare')).toBe('SÌ')
  })

  it('scrive il diniego per esteso, invece della formula che autorizza', () => {
    const blocchi = componiOk(modelloAutorizzazioneUscita, dati({ uscita: USCITA_PISCINA }), {
      autorizzo: false,
      recapito: '081 0000001',
      saNuotare: false,
    })
    expect(paragrafi(blocchi)).toContain(
      "Il/La sottoscritto/a NON autorizza il/la proprio/a figlio/a a partecipare all'attività sopra descritta."
    )
    expect(paragrafi(blocchi).join(' ')).not.toContain('sollevando la scuola da responsabilità')
  })

  it('stampa la descrizione dell’uscita presa dall’evento, non dalle risposte', () => {
    const blocchi = componiOk(modelloAutorizzazioneUscita, dati({ uscita: USCITA_PISCINA }), {
      autorizzo: true,
      recapito: '081 0000001',
      saNuotare: true,
    })
    expect(valoreDi(blocchi, 'Tipo di attività')).toBe('Corso di piscina/nuoto')
    expect(valoreDi(blocchi, 'Destinazione')).toBe('Piscina comunale di prova')
    expect(valoreDi(blocchi, 'Data')).toBe('20/10/2026')
    expect(valoreDi(blocchi, 'Mezzo di trasporto')).toBe('Pullman privato')
    expect(valoreDi(blocchi, 'Orario rientro previsto')).toBe('12:30')
  })

  it('con «Altro» stampa il dettaglio scritto dalla segreteria, e omette gli orari che mancano', () => {
    const blocchi = componiOk(
      modelloAutorizzazioneUscita,
      dati({
        uscita: {
          tipo: 'altro',
          tipoDettaglio: 'Spettacolo teatrale',
          destinazione: 'Teatro di prova',
          data: '2026-11-11',
          mezzo: 'altro',
          mezzoDettaglio: 'a piedi con accompagnatori',
        },
      }),
      { autorizzo: true, recapito: '081 0000001' }
    )
    expect(valoreDi(blocchi, 'Tipo di attività')).toBe('Altro — Spettacolo teatrale')
    expect(valoreDi(blocchi, 'Mezzo di trasporto')).toBe('Altro — a piedi con accompagnatori')
    expect(etichetteCampo(blocchi)).not.toContain('Orario partenza')
    expect(etichetteCampo(blocchi)).not.toContain('Il/La bambino/a sa nuotare')
  })
})

// ─── 26·27 — Certificato di iscrizione e frequenza ──────────────────────────────

describe('26·27 — certificato di iscrizione e frequenza', () => {
  it('riusa il corpo dei certificati già in produzione, senza riscriverlo', () => {
    const d = dati()
    const testi = paragrafi(componiOk(modelloCertificatoIscrizioneFrequenza, d, {}))
    const alunno = { nome: d.alunno.nome, cognome: d.alunno.cognome, classe_sezione: d.alunno.sezione }
    expect(testi).toContain(buildCertificatoBody('iscrizione', alunno, d.annoScolastico))
    expect(testi).toContain(buildCertificatoBody('frequenza', alunno, d.annoScolastico))
  })

  it('aggiunge le tre cose che al modello in app mancavano', () => {
    const blocchi = componiOk(modelloCertificatoIscrizioneFrequenza, dati(), {})
    // 1. la dicitura «in carta libera»
    expect(paragrafi(blocchi)).toContain(
      'Il presente certificato viene rilasciato, in carta libera, per gli usi consentiti dalla legge.'
    )
    // 2. il campo Livello, dedotto dalla sezione
    expect(valoreDi(blocchi, 'Livello')).toBe('Nido')
    // 3. il blocco DATI IDENTIFICATIVI DELLA SCUOLA
    expect(sezioni(blocchi)).toContain('Dati identificativi della scuola')
    expect(valoreDi(blocchi, 'Denominazione')).toBe('Cooperativa di Prova Soc. Coop.')
    expect(valoreDi(blocchi, 'P.IVA/C.F.')).toBe('00000000000')
    expect(valoreDi(blocchi, 'Sede legale')).toBe('Via delle Prove 1 — 80000 Cittaprova (ZZ)')
  })

  it('senza sezione omette il Livello invece di indovinarlo', () => {
    const blocchi = componiOk(
      modelloCertificatoIscrizioneFrequenza,
      dati({ alunno: { ...dati().alunno, sezione: null } }),
      {}
    )
    expect(etichetteCampo(blocchi)).not.toContain('Livello')
    // E la frase sulla frequenza degrada da sé, come già faceva in produzione.
    expect(paragrafi(blocchi).join(' ')).not.toContain('nella sezione')
  })

  it('senza anagrafica di sede in configurazione, il blocco della scuola sparisce del tutto', () => {
    const blocchi = componiOk(modelloCertificatoIscrizioneFrequenza, dati({ scuola: {} }), {})
    expect(sezioni(blocchi)).not.toContain('Dati identificativi della scuola')
    expect(JSON.stringify(blocchi)).not.toContain('N.D.')
  })

  it('l’uso dichiarato compare in calce solo se la segreteria lo scrive', () => {
    expect(paragrafi(componiOk(modelloCertificatoIscrizioneFrequenza, dati(), {})).join(' ')).not.toContain(
      'Si rilascia per il seguente uso'
    )
    const conUso = componiOk(modelloCertificatoIscrizioneFrequenza, dati(), { uso: 'uso INPS' })
    expect(paragrafi(conUso)).toContain('Si rilascia per il seguente uso: uso INPS.')
  })

  it('i tre campi di sportello si chiedono alla segreteria, non al genitore', () => {
    expect(modelloCertificatoIscrizioneFrequenza.campi.map((c) => c.chiestoA)).toEqual([
      'segreteria',
      'segreteria',
      'segreteria',
    ])
  })
})

// ─── 28 — Certificato per il Bonus Asilo Nido INPS ──────────────────────────────

describe('28 — certificato Bonus Asilo Nido', () => {
  it('riconosce quando gli estremi dell’autorizzazione sono completi', () => {
    expect(autorizzazioneNidoCompleta(dati().sede)).toBe(true)
    expect(autorizzazioneNidoCompleta({ ...dati().sede, autorizzazioneNido: null })).toBe(false)
    expect(
      autorizzazioneNidoCompleta({
        ...dati().sede,
        autorizzazioneNido: { numero: '77/2024', data: '2024-09-01', ente: '  ' },
      })
    ).toBe(false)
    // Una data in formato italiano supera qualunque `trim()` e poi non si stampa:
    // `autorizzazione_nido` sta in `scuole.config.anagrafica` e non passa da nessuno
    // schema, quindi ci arriva dentro ciò che qualcuno ha digitato.
    expect(
      autorizzazioneNidoCompleta({
        ...dati().sede,
        autorizzazioneNido: { numero: '77/2024', data: '01/09/2024', ente: 'Comune di Cittaprova' },
      })
    ).toBe(false)
  })

  it('o gli estremi escono interi, o il certificato non esce: nessun «N. 77/2024 del  » monco', () => {
    const varianti = [
      { numero: '77/2024', data: '2024-09-01', ente: 'Comune di Cittaprova' }, // completi
      { numero: '77/2024', data: '01/09/2024', ente: 'Comune di Cittaprova' }, // data in formato italiano
      { numero: '77/2024', data: 'settembre 2024', ente: 'Comune di Cittaprova' }, // data a parole
      { numero: '  ', data: '2024-09-01', ente: 'Comune di Cittaprova' }, // numero vuoto
      { numero: '77/2024', data: '2024-09-01' }, // ente assente
    ]
    for (const autorizzazioneNido of varianti) {
      const esito = modelloCertificatoBonusNido.componi(
        dati({ sede: { ...dati().sede, autorizzazioneNido } }),
        {}
      )
      if (!esito.ok) continue
      // Se è passata, la riga porta tutti e tre i pezzi: numero, data leggibile, ente.
      expect(valoreDi(esito.blocchi, 'Autorizzazione al funzionamento')).toMatch(
        /^N\. \S.* del \d{2}\/\d{2}\/\d{4} rilasciata da \S/
      )
    }
    // Riprova di non-vacuità: la prima variante DEVE passare, o il ciclo non ha misurato
    // niente e resterebbe verde anche con la guardia che rifiuta tutto.
    expect(modelloCertificatoBonusNido.componi(dati(), {}).ok).toBe(true)
    expect(
      modelloCertificatoBonusNido.componi(
        dati({ sede: { ...dati().sede, autorizzazioneNido: varianti[1] } }),
        {}
      ).ok
    ).toBe(false)
  })

  it('non certifica il nido a chi al nido non è: infanzia, primaria, livello ignoto', () => {
    // «Un certificato emesso per un bambino della primavera è una dichiarazione falsa a un
    // ente pubblico» (specifica, condizione 1): il livello è nei dati, e va guardato prima
    // di attestare la frequenza al Nido d'Infanzia.
    for (const livello of ['infanzia', 'primaria', null] as const) {
      const esito = modelloCertificatoBonusNido.componi(
        dati({ alunno: { ...dati().alunno, livello } }),
        {}
      )
      expect(erroriDi(esito)[0].messaggio).toMatch(/iscritto\/a al nido/i)
    }
    expect(modelloCertificatoBonusNido.componi(dati(), {}).ok).toBe(true)
  })

  it('non si emette senza gli estremi: mai un «N. ______ del ______» verso l’INPS', () => {
    const esito = modelloCertificatoBonusNido.componi(
      dati({ sede: { ...dati().sede, autorizzazioneNido: { numero: '77/2024' } } }),
      {}
    )
    expect(erroriDi(esito)[0].messaggio).toMatch(/autorizzazione al funzionamento/i)
    // Il messaggio non manda a cercare un «Comune»: per due sedi su tre non c'è.
    expect(erroriDi(esito)[0].messaggio).not.toMatch(/comune/i)
  })

  it('riporta il testo del `.docx` e gli estremi dell’autorizzazione della sede', () => {
    const blocchi = componiOk(modelloCertificatoBonusNido, dati(), {})
    expect(paragrafi(blocchi)).toContain(
      "Visti gli atti d'ufficio, si certifica che il/la bambino/a Sanniti Ludovica, nato/a a Fiumefreddo (ZZ) il 17/04/2022, codice fiscale SNNLDV22D57Z999Q, è regolarmente iscritto/a e frequenta con assiduità, per l'anno scolastico 2026/2027, il Nido d'Infanzia gestito da questa scuola."
    )
    expect(paragrafi(blocchi)).toContain(
      'Il presente certificato viene rilasciato per gli usi consentiti dalla legge, ivi compresa la richiesta del Bonus Asilo Nido INPS.'
    )
    expect(valoreDi(blocchi, 'Autorizzazione al funzionamento')).toBe(
      'N. 77/2024 del 01/09/2024 rilasciata da Comune di Cittaprova'
    )
    expect(valoreDi(blocchi, 'Sede operativa del Nido')).toBe('Via delle Prove 1 — 80000 Cittaprova (ZZ)')
    expect(caselle(blocchi)).toContainEqual({ testo: 'Sede del Nido: Kidville Prova', spuntata: true })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // I TRE VALORI VERI, PERCHÉ NESSUNO DEI TRE È UN NOME DI COMUNE
  //
  // Questo blocco esiste per un test che non poteva fallire. Fino al 2026-08-16 la
  // fixture qui sopra diceva `comune: 'Cittaprova'` e la riga attesa era «…
  // rilasciata dal Comune di Cittaprova»: con quel dato — un nome di comune nudo,
  // che in produzione non esiste — il prefisso cablato «dal Comune di» sembrava
  // corretto. Verde su cinque suite, 146 test, mentre i PDF veri stampavano:
  //
  //   Giugliano  «rilasciata dal Comune di Comune di Giugliano in Campania»
  //   Aversa     «rilasciata dal Comune di Ambito Socio-Sanitario C06 — …»
  //   Cesa       «rilasciata dal Comune di Ambito Socio-Sanitario C6 — …»
  //
  // Il primo ripete «Comune di»; gli altri due dichiarano all'INPS che un Ambito
  // socio-sanitario è un Comune — e annullano al passo della stampa la decisione
  // della spec §2.1, che è di riportare l'ente che ha EMESSO davvero il
  // provvedimento, perché è quello che un funzionario cerca se controlla.
  //
  // I valori sono quelli scritti in produzione (spec §2.1, tabella): due su tre
  // NON sono comuni. Un test che gira su un nome inventato non è una rete.
  // ───────────────────────────────────────────────────────────────────────────
  const AUTORIZZAZIONI_VERE = [
    {
      sede: 'Giugliano',
      aut: { numero: '102A', data: '2025-10-29', ente: 'Comune di Giugliano in Campania' },
      riga: 'N. 102A del 29/10/2025 rilasciata da Comune di Giugliano in Campania',
    },
    {
      sede: 'Aversa',
      aut: { numero: '17', data: '2024-10-01', ente: 'Ambito Socio-Sanitario C06 — Comune capofila Aversa' },
      riga: 'N. 17 del 01/10/2024 rilasciata da Ambito Socio-Sanitario C06 — Comune capofila Aversa',
    },
    {
      sede: 'Cesa',
      aut: { numero: '6/2018', data: '2018-04-12', ente: 'Ambito Socio-Sanitario C6 — Comune capofila Casaluce' },
      riga: 'N. 6/2018 del 12/04/2018 rilasciata da Ambito Socio-Sanitario C6 — Comune capofila Casaluce',
    },
  ] as const

  it.each(AUTORIZZAZIONI_VERE)(
    '$sede: la riga stampata è quella del provvedimento vero, senza etichette aggiunte dal codice',
    ({ aut, riga }) => {
      const blocchi = componiOk(
        modelloCertificatoBonusNido,
        dati({ sede: { ...dati().sede, autorizzazioneNido: aut } }),
        {}
      )
      const stampata = valoreDi(blocchi, 'Autorizzazione al funzionamento') ?? ''
      expect(stampata).toBe(riga)
      // Il dato è già completo: il codice non ci antepone niente.
      expect(stampata).not.toContain('Comune di Comune')
      expect(stampata).not.toMatch(/dal Comune di (Comune|Ambito)/)
      // E l'ente compare una volta sola, per intero.
      expect(stampata.split(aut.ente).length - 1).toBe(1)
    }
  )

  it('nessuno dei tre valori veri è un nome di comune nudo: è il motivo per cui la fixture di prima non poteva fallire', () => {
    // Controllo di non-vacuità del blocco qui sopra: se un domani qualcuno
    // «semplificasse» questi valori in «Giugliano», «Aversa», «Cesa», il test
    // tornerebbe a misurare un dato che in produzione non esiste.
    for (const { ente } of AUTORIZZAZIONI_VERE.map((v) => v.aut)) {
      expect(ente).toMatch(/^(Comune di|Ambito Socio-Sanitario) /)
    }
    expect(AUTORIZZAZIONI_VERE.filter((v) => v.aut.ente.startsWith('Ambito'))).toHaveLength(2)
  })

  it('degrada dentro la frase: senza luogo di nascita e senza codice fiscale niente incisi vuoti', () => {
    const corpoDi = (alunno: Partial<ReturnType<typeof dati>['alunno']>) =>
      paragrafi(
        componiOk(modelloCertificatoBonusNido, dati({ alunno: { ...dati().alunno, ...alunno } }), {})
      ).find((t) => t.startsWith("Visti gli atti d'ufficio"))

    // Senza il luogo, «nato/a» regge la sola data: non resta un «nato/a a » monco, e
    // nemmeno un «Sanniti Ludovica il 17/04/2022» che non è italiano.
    expect(corpoDi({ luogoNascita: null, codiceFiscale: '   ' })).toBe(
      "Visti gli atti d'ufficio, si certifica che il/la bambino/a Sanniti Ludovica, nato/a il 17/04/2022, è regolarmente iscritto/a e frequenta con assiduità, per l'anno scolastico 2026/2027, il Nido d'Infanzia gestito da questa scuola."
    )
    // Senza il luogo E senza la data l'inciso sparisce del tutto.
    expect(corpoDi({ luogoNascita: null, dataNascita: null })).toBe(
      "Visti gli atti d'ufficio, si certifica che il/la bambino/a Sanniti Ludovica, codice fiscale SNNLDV22D57Z999Q, è regolarmente iscritto/a e frequenta con assiduità, per l'anno scolastico 2026/2027, il Nido d'Infanzia gestito da questa scuola."
    )
    // Senza la sola data resta il luogo.
    expect(corpoDi({ dataNascita: null, codiceFiscale: null })).toBe(
      "Visti gli atti d'ufficio, si certifica che il/la bambino/a Sanniti Ludovica, nato/a a Fiumefreddo (ZZ), è regolarmente iscritto/a e frequenta con assiduità, per l'anno scolastico 2026/2027, il Nido d'Infanzia gestito da questa scuola."
    )
  })

  it('non ripete gli identificativi: stanno dentro la frase, non anche in righe-campo', () => {
    // Il modello trascritto dal `.docx` ha la casella della sede e poi la frase: un blocco
    // DATI DELL'ALUNNO/A stamperebbe nascita e codice fiscale due centimetri sopra la
    // stessa frase che li ripete. (Sul 26·27 il blocco serve: il corpo riusato di lì non
    // porta né nascita né codice fiscale.)
    const blocchi = componiOk(modelloCertificatoBonusNido, dati(), {})
    expect(sezioni(blocchi)).not.toContain("Dati dell'alunno/a")
    expect(etichetteCampo(blocchi)).not.toContain('Codice fiscale')
    expect(etichetteCampo(blocchi)).not.toContain('Data di nascita')
    expect(etichetteCampo(blocchi)).not.toContain('Luogo di nascita')
    // Il codice fiscale del minore compare una volta sola su tutto il foglio.
    expect(JSON.stringify(blocchi).split('SNNLDV22D57Z999Q')).toHaveLength(2)
    // La casella della sede invece resta: è l'unica cosa che il modello mette prima della frase.
    expect(caselle(blocchi)).toContainEqual({ testo: 'Sede del Nido: Kidville Prova', spuntata: true })
  })

  it('non chiede niente al genitore: si scarica e basta', () => {
    expect(modelloCertificatoBonusNido.campi).toEqual([])
    expect(modelloCertificatoBonusNido.componi(dati(), {}).ok).toBe(true)
  })
})

// ─── I due seminati verso l'impaginatore ────────────────────────────────────────

describe('prestampati/modelli/genitore — intestazione e luogo/data', () => {
  it('l’intestazione è quella dei certificati, con le righe mancanti omesse', () => {
    expect(intestazionePrestampato(dati())).toEqual([
      'Kidville Prova',
      'Via delle Prove 1 — 80000 Cittaprova (ZZ)',
      'Cod. Mecc. ZZ1A000001',
    ])
    expect(
      intestazionePrestampato(dati({ sede: { scuola_nome: 'Kidville Prova' } }))
    ).toEqual(['Kidville Prova'])
  })

  it('il luogo e data usa la città della sede, e degrada quando non c’è', () => {
    expect(luogoDataPrestampato(dati())).toBe('Cittaprova, lì 14/08/2026')
    expect(luogoDataPrestampato(dati({ sede: { ...dati().sede, scuola_citta: null } }))).toBe('Lì 14/08/2026')
  })
})
