/**
 * VALIDAZIONE di un codice fiscale: è scritto bene? torna il carattere di controllo?
 *
 * Funzioni PURE: nessun I/O, nessuna rete, nessun log, nessun orologio.
 *
 * ⚠️ QUESTO MODULO NON DICE SE IL CODICE È DI QUELLA PERSONA. Dice solo se è un codice
 * fiscale ben formato. «È di questo bambino?» è un'altra domanda, e la risponde
 * `coerenza.ts` confrontandolo con l'anagrafica.
 *
 * ⚠️ `codice-fiscale.ts` NON verifica il carattere di controllo, ed è una scelta scritta
 * là in fondo: quel modulo LEGGE (data, sesso) anche da un codice sbagliato, perché un
 * dato illeggibile è peggio di un dato discordante. Qui invece si GIUDICA. I due usi
 * convivono e condividono le tabelle; non si sovrappongono.
 */

import { carattereControllo } from './calcolo'
import {
  CIFRA_DA_OMOCODIA,
  FORMA_CF,
  LETTERE_MESE,
  POSIZIONI_NUMERICHE,
  SCARTO_FEMMINA,
  dataEsistePerAnnoADueCifre,
  giornoDiNascitaAmmesso,
} from './tabelle'

export type MotivoCfNonValido =
  | 'vuoto'
  | 'lunghezza'
  | 'forma'
  /** Le due cifre del giorno sono fuori dalla scala 1–31 (M) e 41–71 (F). */
  | 'giorno'
  /** Il giorno sta nella scala, ma quel mese non ce l'ha: 31 febbraio, 31 aprile. */
  | 'data-inesistente'
  | 'checksum'

export interface EsitoValidazione {
  valido: boolean
  /** Il codice ripulito: senza spazi, tutto maiuscolo. Stringa vuota se non c'era niente. */
  normalizzato: string
  motivi: MotivoCfNonValido[]
  /** Vero se almeno una posizione numerica porta una lettera al posto della cifra. */
  omocodia: boolean
  /**
   * Il codice come sarebbe stato PRIMA della sostituzione dell'Agenzia: posizioni
   * numeriche riportate a cifra e carattere di controllo RICALCOLATO su quelle.
   * Su un codice senza omocodia e con la checksum giusta coincide con `normalizzato`.
   * È `null` quando la forma non regge, perché non c'è niente da riportare indietro.
   */
  baseSenzaOmocodia: string | null
}

const LUNGHEZZA_CF = 16
const LUNGHEZZA_PRIMI_15 = 15

/**
 * Ripulisce un codice fiscale: via gli spazi — anche quelli INTERNI — e tutto maiuscolo.
 *
 * ⚠️ Gli spazi interni non sono un caso di scuola: un codice incollato da un PDF o da una
 * mail arriva spezzato in gruppi, e `\s` copre anche lo spazio unificatore U+00A0, che è
 * quello che i PDF usano davvero e che a schermo è indistinguibile da uno spazio normale.
 *
 * ⚠️ E non sono un caso di scuola nemmeno gli spazi in CODA: `alunni.codice_fiscale` è
 * `character(16)`, cioè Postgres IMPAGINA il valore con spazi fino a sedici. Un codice di
 * quattordici caratteri torna da PostgREST lungo sedici. Ogni controllo scritto come
 * `valore.length === 16` su quella colonna mente — e il 2026-08-10, in produzione, sarebbe
 * mentito su **30 codici su 36**.
 *
 * Quello che non è una stringa diventa stringa vuota: `null`, `undefined` e un numero
 * incollato per sbaglio sono tutti «non c'è un codice», che è uno stato normale.
 */
export function normalizzaCodiceFiscale(cf: unknown): string {
  if (typeof cf !== 'string') return ''
  return cf.replace(/\s+/g, '').toUpperCase()
}

/** Una posizione numerica che porta una lettera d'omocodia? */
function eOmocodia(carattere: string): boolean {
  return CIFRA_DA_OMOCODIA[carattere] !== undefined
}

/**
 * Riporta le lettere dell'omocodia a cifra e RICALCOLA il carattere di controllo:
 * il risultato è il codice originario, quello che l'anagrafica implica.
 */
function deOmocodifica(cf16: string): string {
  const base = [...cf16.slice(0, LUNGHEZZA_PRIMI_15)]
  for (const posizione of POSIZIONI_NUMERICHE) {
    const cifra = CIFRA_DA_OMOCODIA[base[posizione]]
    if (cifra !== undefined) base[posizione] = cifra
  }
  const primi15 = base.join('')
  return primi15 + carattereControllo(primi15)
}

/**
 * Il verdetto su un codice fiscale.
 *
 * I motivi sono a cascata e nella pratica l'elenco ne contiene uno solo: senza la
 * lunghezza giusta la forma non si può nemmeno guardare, e senza la forma giusta la
 * checksum non si può calcolare. L'elenco resta un elenco perché il chiamante non debba
 * cambiare firma il giorno in cui se ne aggiungerà uno indipendente.
 *
 * ⚠️ LA CHECKSUM SI VERIFICA SUI PRIMI QUINDICI CARATTERI COSÌ COME SONO, lettere
 * dell'omocodia comprese. È esattamente così che l'Agenzia lo calcola quando assegna un
 * codice omocodico, e chi de-omocodifica PRIMA e verifica DOPO accetta codici che non
 * esistono: i quindici caratteri di un omocodico con il carattere di controllo della base
 * passerebbero il controllo pur non essendo il codice di nessuno.
 *
 * ⚠️ LA FORMA NON BASTA A DIRE CHE UN CODICE È SCRITTO BENE, e fino al 2026-08-10 qui si
 * faceva finta di sì. `FORMA_CF` vincola la lettera del MESE alle dodici valide ma sul
 * GIORNO chiede solo due caratteri numerici: `XQQYKV19C00Z999D`, `…C35…`, `…C99…` —
 * checksum corretta — uscivano di qui come `{valido: true, motivi: []}`, mentre
 * `codice-fiscale.ts` sulla stessa stringa rispondeva già `null`. Lo stesso ragionamento
 * che aveva stretto la regex sul mese non era stato applicato al giorno. Ora la scala la
 * decide `giornoDiNascitaAmmesso`, in `tabelle.ts`, per entrambi i moduli.
 *
 * ⚠️ E LA SCALA DA SOLA NON BASTAVA: la prima correzione riparò metà del difetto e lasciò
 * viva l'altra metà per l'intera famiglia dei giorni impossibili DI CALENDARIO. Il 31
 * febbraio (`XQQYKV19B31Z999A`), il 30 febbraio, il 29 febbraio di un anno non bisestile,
 * il 31 aprile e i loro quattro femminili (`…B71…`, `…B70…`, `…B69…`, `…D71…`) hanno tutti
 * un giorno dentro la scala, tutti la checksum giusta, e continuavano a uscire di qui
 * `valido: true` mentre `dataNascitaDaCodiceFiscale` rispondeva `null` — con accanto un
 * test che si chiamava «lo stesso verdetto sulla stessa stringa» e provava dieci campioni
 * scelti fra quelli su cui la proprietà valeva. Ora la seconda domanda la pone
 * `dataEsistePerAnnoADueCifre`, sempre in `tabelle.ts`, e l'equivalenza fra i due moduli è
 * verificata su 4800 codici costruiti a tavolino.
 */
export function validaCodiceFiscale(cf: unknown): EsitoValidazione {
  const normalizzato = normalizzaCodiceFiscale(cf)

  if (normalizzato.length === 0) {
    return { valido: false, normalizzato, motivi: ['vuoto'], omocodia: false, baseSenzaOmocodia: null }
  }
  if (normalizzato.length !== LUNGHEZZA_CF) {
    return { valido: false, normalizzato, motivi: ['lunghezza'], omocodia: false, baseSenzaOmocodia: null }
  }
  if (!FORMA_CF.test(normalizzato)) {
    return { valido: false, normalizzato, motivi: ['forma'], omocodia: false, baseSenzaOmocodia: null }
  }

  const omocodia = POSIZIONI_NUMERICHE.some((posizione) => eOmocodia(normalizzato[posizione]))
  // Si calcola anche quando la checksum non torna: è una trasformazione meccanica, e
  // dire «ecco che cosa avrebbe dovuto esserci» è più utile che non dire niente.
  const base = deOmocodifica(normalizzato)

  /**
   * Il giorno si giudica sulla BASE, cioè dopo aver sciolto l'omocodia: nel codice così
   * com'è le due posizioni possono portare lettere (`LT` è il `07`), e `Number('LT')`
   * sarebbe `NaN`. Il controllo sta PRIMA della checksum perché due caratteri che non
   * sono un giorno non diventano un giorno se il sedicesimo torna.
   *
   * `baseSenzaOmocodia` esce `null`, come per la forma e a differenza della checksum: un
   * carattere di controllo sbagliato lascia i quindici caratteri perfettamente leggibili,
   * un giorno che non esiste no — non c'è nessun «ecco cosa avrebbe dovuto esserci» da
   * dire, e restituire una base con dentro il 35 significherebbe invitare il chiamante a
   * leggerne la data.
   */
  const giorno = Number(base.slice(9, 11))
  if (!giornoDiNascitaAmmesso(giorno)) {
    return { valido: false, normalizzato, motivi: ['giorno'], omocodia, baseSenzaOmocodia: null }
  }

  /**
   * E poi il CALENDARIO, che è la domanda successiva e non la stessa: `31` sta nella scala
   * anche quando il mese è febbraio. Il mese è già vincolato alle dodici lettere valide da
   * `FORMA_CF`, quindi l'indice non può venire `-1`; il giorno si riporta sotto i 40 perché
   * lo scarto del femminile è un modo di scrivere il sesso, non un giorno diverso.
   *
   * ⚠️ L'ANNO HA DUE CIFRE E QUI NON C'È UN OROLOGIO PER SCEGLIERE IL SECOLO — e non deve
   * esserci: una funzione pura che chiedesse l'ora darebbe verdetti diversi in giorni
   * diversi sulla stessa stringa. La domanda giusta è dunque «esiste in QUALCHE secolo?»,
   * e la risponde `dataEsistePerAnnoADueCifre` con l'aritmetica: `19B29` no (nessun anno
   * che finisce per 19 è bisestile), `00B29` sì (il 2000 lo è). Chi ha bisogno del secolo
   * vero passa da `dataNascitaDaCodiceFiscale`, che infatti chiede un riferimento.
   */
  const mese = LETTERE_MESE.indexOf(base[8]) + 1
  const giornoSenzaScarto = giorno > SCARTO_FEMMINA ? giorno - SCARTO_FEMMINA : giorno
  if (!dataEsistePerAnnoADueCifre(Number(base.slice(6, 8)), mese, giornoSenzaScarto)) {
    return {
      valido: false,
      normalizzato,
      motivi: ['data-inesistente'],
      omocodia,
      baseSenzaOmocodia: null,
    }
  }

  const checksumGiusta =
    carattereControllo(normalizzato.slice(0, LUNGHEZZA_PRIMI_15)) === normalizzato[LUNGHEZZA_PRIMI_15]

  return {
    valido: checksumGiusta,
    normalizzato,
    motivi: checksumGiusta ? [] : ['checksum'],
    omocodia,
    baseSenzaOmocodia: base,
  }
}
