/**
 * COERENZA fra un codice fiscale e l'anagrafica: il codice e i dati si CONTRADDICONO?
 *
 * Funzioni PURE: nessun I/O, nessuna rete, nessun log, nessun orologio.
 *
 * ⚠️⚠️ LA REGOLA CHE VIENE PRIMA DI TUTTE LE ALTRE, E CHE NON È UNA RAFFINATEZZA:
 * **un dato MANCANTE non produce mai un motivo di incoerenza — produce un
 * `nonVerificabile`.**
 *
 * È una misura, non un principio estetico. Sul database di PRODUZIONE, il 2026-08-10:
 * su 33 alunni 18 non hanno il codice fiscale, 18 non hanno il comune di nascita, 17 non
 * hanno nemmeno il sesso; su 50 genitori 27 non hanno il codice fiscale. Senza questa
 * regola un pannello di verifica marcherebbe rosso **45 record su 83** per un dato che
 * nessuno ha mai inserito — e un pannello che segnala tutto non segnala niente: si impara
 * a ignorarlo in una settimana, e da quel momento non segnala nemmeno le cose vere.
 *
 * Da qui discendono le tre risposte possibili, che il chiamante deve poter distinguere:
 *  · **verde** — `coerente: true`, `nonVerificabili` vuoto: si è confrontato e torna;
 *  · **grigio** — `coerente: true`, `nonVerificabili` NON vuoto: quello che si poteva
 *    confrontare torna, il resto non c'era. È uno stato LEGITTIMO, non un ripiego;
 *  · **rosso** — `coerente: false`: c'è una contraddizione DIMOSTRATA, oppure il codice
 *    c'è ed è scritto male.
 *
 * ⚠️ Che cosa NON fa questo modulo: non giudica la qualità del dato anagrafico. Una data
 * scritta `07/03/2019`, un sesso che vale `X`, un comune scritto per esteso invece del
 * codice catastale sono dati che non si possono CONFRONTARE, non dati che contraddicono il
 * codice: finiscono fra i non verificabili. Dire «incoerente» significherebbe affermare
 * che il codice e l'anagrafica dicono cose diverse, e non lo si è dimostrato.
 */

import { calcolaCodiceFiscale, normalizzaCodiceBelfiore, terzinaCognome, terzinaData, terzinaNome } from './calcolo'
import { SCARTO_FEMMINA } from './tabelle'
import { validaCodiceFiscale } from './validazione'
import type { MotivoCfNonValido } from './validazione'

export type MotivoIncoerenza =
  | 'cf-assente'
  | 'cf-lunghezza'
  | 'cf-forma'
  /** Le due cifre del giorno non sono un giorno: fuori da 1–31 (M) e 41–71 (F). */
  | 'cf-giorno'
  /** Il giorno c'è, ma quel mese non ce l'ha: 31 febbraio, 31 aprile, 29 febbraio non bisestile. */
  | 'cf-data-inesistente'
  | 'cf-checksum'
  | 'cognome'
  | 'nome'
  | 'data-nascita'
  | 'sesso'
  | 'luogo-nascita'

export type CampoNonVerificabile = 'cognome' | 'nome' | 'data-nascita' | 'sesso' | 'luogo-nascita'

export interface DatiPerCoerenza {
  nome?: string | null
  cognome?: string | null
  sesso?: string | null
  /** Forma `AAAA-MM-GG`: è quella con cui una colonna `date` esce da PostgREST. */
  dataNascita?: string | null
  /** Codice catastale (Belfiore) del luogo di nascita, non il nome del comune. */
  codiceBelfiore?: string | null
}

export interface EsitoCoerenza {
  coerente: boolean
  motivi: MotivoIncoerenza[]
  nonVerificabili: CampoNonVerificabile[]
  /** Il codice che l'anagrafica implica, quando è calcolabile per intero. */
  codiceAtteso: string | null
  /** Il codice esaminato, ripulito. Stringa vuota quando non ce n'era uno. */
  codiceEsaminato: string
}

/** L'ordine in cui i campi compaiono nei due elenchi: stabile, così i test e la UI non ballano. */
const TUTTI_I_CAMPI: readonly CampoNonVerificabile[] = [
  'cognome',
  'nome',
  'data-nascita',
  'sesso',
  'luogo-nascita',
]

/** Il sesso come sta in anagrafica: in produzione la colonna `gender` vale `M`, `F` o `null`. */
function normalizzaSesso(sesso: unknown): 'M' | 'F' | null {
  if (typeof sesso !== 'string') return null
  const s = sesso.trim().toUpperCase()
  return s === 'M' || s === 'F' ? s : null
}

/** Il codice atteso, quando l'anagrafica basta a calcolarlo per intero. */
function codiceAttesoDa(dati: DatiPerCoerenza): string | null {
  const sesso = normalizzaSesso(dati.sesso)
  if (sesso === null) return null
  const esito = calcolaCodiceFiscale({
    cognome: dati.cognome ?? '',
    nome: dati.nome ?? '',
    sesso,
    dataNascita: dati.dataNascita ?? '',
    codiceBelfiore: dati.codiceBelfiore ?? '',
  })
  return esito.ok ? esito.codice : null
}

/**
 * Il giorno letto dal codice, riportato sotto i 40.
 *
 * Serve a verificare la DATA indipendentemente dal SESSO: senza questo passaggio, un
 * bambino la cui anagrafica non dice il sesso — 17 su 33 in produzione — avrebbe anche la
 * data di nascita fra i non verificabili, pur essendo scritta nel codice a chiare lettere.
 */
function giornoSenzaScarto(giornoDalCodice: number): number {
  return giornoDalCodice > SCARTO_FEMMINA ? giornoDalCodice - SCARTO_FEMMINA : giornoDalCodice
}

/**
 * Confronta un codice fiscale con l'anagrafica, campo per campo.
 *
 * Il confronto avviene sulla BASE SENZA OMOCODIA, non sul codice così com'è: un codice
 * omocodico è legittimo — l'ha assegnato l'Agenzia quando due persone sono collise — e
 * confrontarlo alla lettera lo farebbe risultare incoerente a torto. Sulla base, per di
 * più, le posizioni numeriche sono cifre davvero, e leggerle non richiede cautele.
 *
 * Campo per campo, e non «codice atteso contro codice trovato», per due ragioni pratiche:
 * un confronto fra due stringhe di sedici caratteri dice che qualcosa non va ma non dice
 * DOVE, e soprattutto non funziona quando manca un pezzo dell'anagrafica — cioè nella
 * maggior parte dei casi veri.
 */
export function verificaCoerenza(cf: unknown, dati: DatiPerCoerenza): EsitoCoerenza {
  const anagrafica: DatiPerCoerenza = dati ?? {}
  const esitoCf = validaCodiceFiscale(cf)
  const codiceAtteso = codiceAttesoDa(anagrafica)

  /**
   * ⚠️ IL CODICE FISCALE ASSENTE NON È UNA CONTRADDIZIONE: è l'assenza dell'oggetto della
   * verifica. Sono i 45 record su 83 della misura in cima al file. Perciò `motivi` resta
   * VUOTO e `coerente` resta `true`, così anche il consumatore più ingenuo
   * (`coerente ? verde : rosso`) non dipinge di rosso mezzo istituto. Che non si sia
   * verificato niente si legge da `codiceEsaminato === ''` e dai cinque campi in
   * `nonVerificabili` — che è un'informazione, non un allarme.
   *
   * (`'cf-assente'` resta nel tipo `MotivoIncoerenza` perché è il contratto che il
   * chiamante conosce, ma questo modulo non lo emette mai: emetterlo significherebbe
   * chiamare «incoerente» un'anagrafica incompleta, cioè fare esattamente il danno che
   * questo file esiste per evitare.)
   */
  if (esitoCf.normalizzato.length === 0) {
    return {
      coerente: true,
      motivi: [],
      nonVerificabili: [...TUTTI_I_CAMPI],
      codiceAtteso,
      codiceEsaminato: '',
    }
  }

  /**
   * Il codice c'è ma è scritto male: qui invece è rosso, perché qualcuno ha scritto
   * qualcosa e quel qualcosa non è un codice fiscale. È il caso dei trenta codici da
   * quattordici caratteri contati in produzione. Nessun campo si può verificare — la base
   * non è affidabile — quindi tutti e cinque restano fra i non verificabili ACCANTO al
   * motivo, non al posto suo.
   */
  if (!esitoCf.valido || esitoCf.baseSenzaOmocodia === null) {
    /**
     * ⚠️ RECORD COMPLETO, NON `Partial`. Con un `Partial` un motivo nuovo di
     * `validazione.ts` sarebbe caduto fuori in silenzio e sarebbe uscito un
     * `coerente: false` con `motivi: []` — un rosso senza ragione, che è il difetto
     * peggiore di tutti perché non si vede. Così invece il compilatore pretende una riga
     * per ogni motivo, e `'vuoto'` deve dire a voce che qui non arriva mai.
     */
    const traduzione: Record<MotivoCfNonValido, MotivoIncoerenza | null> = {
      vuoto: null, // irraggiungibile: il codice assente esce dal ramo qui sopra
      lunghezza: 'cf-lunghezza',
      forma: 'cf-forma',
      giorno: 'cf-giorno',
      'data-inesistente': 'cf-data-inesistente',
      checksum: 'cf-checksum',
    }
    const motivi = esitoCf.motivi
      .map((motivo) => traduzione[motivo])
      .filter((motivo): motivo is MotivoIncoerenza => motivo !== null)
    return {
      coerente: false,
      motivi,
      nonVerificabili: [...TUTTI_I_CAMPI],
      codiceAtteso,
      codiceEsaminato: esitoCf.normalizzato,
    }
  }

  const base = esitoCf.baseSenzaOmocodia
  const motivi: MotivoIncoerenza[] = []
  const nonVerificabili: CampoNonVerificabile[] = []

  const cognome = terzinaCognome(anagrafica.cognome ?? '')
  if (cognome === null) nonVerificabili.push('cognome')
  else if (cognome !== base.slice(0, 3)) motivi.push('cognome')

  const nome = terzinaNome(anagrafica.nome ?? '')
  if (nome === null) nonVerificabili.push('nome')
  else if (nome !== base.slice(3, 6)) motivi.push('nome')

  // La data si confronta al maschile da entrambe le parti: è il modo di non farla
  // dipendere dal sesso, che è un dato a sé e manca spesso.
  const dataAttesa = terzinaData(anagrafica.dataNascita ?? '', 'M')
  if (dataAttesa === null) {
    nonVerificabili.push('data-nascita')
  } else {
    const giorno = giornoSenzaScarto(Number(base.slice(9, 11)))
    const dataDalCodice = `${base.slice(6, 9)}${String(giorno).padStart(2, '0')}`
    if (dataAttesa !== dataDalCodice) motivi.push('data-nascita')
  }

  const sesso = normalizzaSesso(anagrafica.sesso)
  if (sesso === null) {
    nonVerificabili.push('sesso')
  } else {
    const sessoDalCodice = Number(base.slice(9, 11)) > SCARTO_FEMMINA ? 'F' : 'M'
    if (sesso !== sessoDalCodice) motivi.push('sesso')
  }

  const belfiore = normalizzaCodiceBelfiore(anagrafica.codiceBelfiore)
  if (belfiore === null) nonVerificabili.push('luogo-nascita')
  else if (belfiore !== base.slice(11, 15)) motivi.push('luogo-nascita')

  return {
    coerente: motivi.length === 0,
    motivi,
    nonVerificabili,
    codiceAtteso,
    codiceEsaminato: esitoCf.normalizzato,
  }
}
