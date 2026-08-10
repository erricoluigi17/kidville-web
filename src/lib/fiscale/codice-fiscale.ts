/**
 * Lettura del CODICE FISCALE italiano: data di nascita e sesso.
 *
 * Funzioni PURE (nessun I/O, nessun log): l'osservabilità è di chi le chiama, che è
 * anche l'unico a sapere *su quale pratica* sta lavorando. Qui non entra e non esce
 * nulla che non sia una stringa.
 *
 * ⚠️ NON confondere questo modulo con `@/lib/utils/fiscalCode`: quello è un
 * GENERATORE FINTO (mese sempre 'A', giorno fisso 15/55) usato per riempire moduli.
 * Non è un parser e non va esteso.
 *
 * ⚠️ OMOCODIA. Quando due persone otterrebbero lo stesso codice, l'Agenzia delle
 * Entrate sostituisce le CIFRE con lettere, partendo da destra:
 * `L=0 M=1 N=2 P=3 Q=4 R=5 S=6 T=7 U=8 V=9`. Un parser che legge le posizioni
 * numeriche come cifre e basta ricava una data di nascita SBAGLIATA — e in questo
 * repo la data di nascita decide la serie fiscale su cui esce la fattura. La stessa
 * convenzione è in `@/lib/logging/serialize.ts` (classe `[\dLMNPQRSTUV]`), ed è ripetuta
 * là perché i due moduli servono a cose diverse: là si maschera, qui si legge.
 *
 * ⚠️ LE TABELLE NON STANNO PIÙ QUI. Forma del codice, lettere dei mesi, tabella
 * dell'omocodia, scarto del femminile e **calendario** vivono in `./tabelle`, insieme a
 * quelle del carattere di controllo, e sono le stesse che usano `calcolo.ts`,
 * `validazione.ts` e `coerenza.ts`. Una regola valida per due strade deve vivere in un posto solo: quando la
 * copia A viene corretta e la copia B no, il difetto non è una riga sbagliata — è che le
 * due risposte divergono e nessun test se ne accorge, perché ogni copia ha i suoi.
 *
 * Il comportamento pubblico di questo file non è cambiato con lo spostamento: lo dimostra
 * `__tests__/lib/fiscale/codice-fiscale.test.ts`, che non è stato toccato.
 */

import {
  CIFRA_DA_OMOCODIA,
  FORMA_CF,
  LETTERE_MESE,
  SCARTO_FEMMINA,
  dataEsiste,
  giornoDiNascitaAmmesso,
} from './tabelle'

/**
 * Il codice fiscale si legge su DUE secoli: `20` può essere 1920 o 2020. Oltre non
 * si va — non è una scelta di comodo, è che due secoli coprono qualunque persona
 * vivente, e qui i soggetti sono bambini di un asilo.
 */
const SECOLI_DA_PROVARE = 2

interface PezziCodiceFiscale {
  /** Le due cifre dell'anno, già decodificate dall'omocodia (0–99). */
  annoDueCifre: number
  /** Mese 1–12. */
  mese: number
  /** Giorno 1–31, già tolto lo scarto del femminile. */
  giorno: number
  femmina: boolean
}

/**
 * Normalizza il codice: via gli spazi (anche interni: capita incollandolo da un PDF)
 * e tutto maiuscolo.
 */
function normalizza(cf: string): string {
  return cf.replace(/\s+/g, '').toUpperCase()
}

/** Decodifica una posizione numerica, tenendo conto dell'omocodia. Ritorna `null` se illeggibile. */
function cifra(carattere: string): string | null {
  if (carattere >= '0' && carattere <= '9') return carattere
  return CIFRA_DA_OMOCODIA[carattere] ?? null
}

/**
 * Spezza il codice fiscale nei pezzi che servono a data e sesso.
 * Ritorna `null` se la forma non torna o se il giorno è fuori scala.
 *
 * Non verifica il carattere di controllo: vedi la nota in fondo al file.
 */
function leggiPezzi(cf: unknown): PezziCodiceFiscale | null {
  if (typeof cf !== 'string') return null
  const c = normalizza(cf)
  if (!FORMA_CF.test(c)) return null

  const anno = (cifra(c[6]) ?? '') + (cifra(c[7]) ?? '')
  if (anno.length !== 2) return null

  const mese = LETTERE_MESE.indexOf(c[8]) + 1
  if (mese === 0) return null

  const giornoGrezzo = (cifra(c[9]) ?? '') + (cifra(c[10]) ?? '')
  if (giornoGrezzo.length !== 2) return null

  const numero = Number(giornoGrezzo)
  // 0 e 32–40 non esistono né al maschile né al femminile: il codice è rotto.
  // ⚠️ La regola non è più scritta qui: vive in `giornoDiNascitaAmmesso` (`./tabelle`) ed è
  // la STESSA che usa `validaCodiceFiscale`. Fino al 2026-08-10 stava solo in questo file,
  // e i due moduli davano verdetti opposti sulla stessa stringa.
  if (!giornoDiNascitaAmmesso(numero)) return null

  const femmina = numero > SCARTO_FEMMINA
  const giorno = femmina ? numero - SCARTO_FEMMINA : numero

  return { annoDueCifre: Number(anno), mese, giorno, femmina }
}

/**
 * `(anno, mese, giorno)` viene prima o insieme al giorno di `oggi`?
 *
 * Confronto fra terne, non fra `Date`: costruire `new Date(anno, mese - 1, giorno)` solo
 * per confrontarlo rimetterebbe in mezzo il fuso orario del processo — e per un anno sotto
 * il 100 farebbe anche di peggio, perché `new Date(50, …)` è il 1950, non l'anno 50.
 */
function nonFutura(anno: number, mese: number, giorno: number, oggi: Date): boolean {
  const annoOggi = oggi.getFullYear()
  const meseOggi = oggi.getMonth() + 1
  if (anno !== annoOggi) return anno < annoOggi
  if (mese !== meseOggi) return mese < meseOggi
  return giorno <= oggi.getDate()
}

/**
 * Sceglie il secolo. Regola: **la data non può stare nel futuro**, e a parità si
 * prende la più recente.
 *
 * `99` letto con riferimento al 2026 è il 1999, non il 2099. E un `26` con mese dicembre,
 * letto col riferimento al 9 agosto 2026, è il **1926**: il 15/12/2026 non è ancora
 * arrivato. È assurdo per un bambino dell'infanzia, ed è voluto — questa funzione non
 * inventa plausibilità, dice solo cosa il codice può significare.
 *
 * ⚠️ PROPRIO PER QUESTO `oggi` NON È UN DETTAGLIO DEI TEST: è il perno della risposta.
 * Passare l'orologio di sistema significa che lo stesso codice fiscale, riletto due mesi
 * dopo, può dare un secolo diverso — misurato, e su una FATTURA cambiava la serie fiscale
 * fra l'emissione e la riemissione dopo uno scarto SDI. Chi legge un codice per decidere
 * qualcosa di irreversibile passa un riferimento **del documento**, non del calendario:
 * `@/lib/fatturazione/sezionale` passa la fine dell'anno scolastico che sta fatturando.
 *
 * La plausibilità — «può essere la data di nascita di un ALUNNO?» — non si stabilisce qui
 * e non si stabilisce nemmeno col solo confronto con l'anagrafica: la stabilisce
 * `sezionalePerMinore`, che conosce l'anno scolastico e scarta ciò che sta fuori dai
 * diciotto anni. Vedi la nota in fondo a questo file.
 *
 * Il 29 febbraio fa da filtro naturale: `00B29` è il 2000 (bisestile), perché il 1900
 * non lo era e quella data non esiste.
 */
function annoConSecolo(
  annoDueCifre: number,
  mese: number,
  giorno: number,
  oggi: Date,
): number | null {
  const inizioSecolo = Math.floor(oggi.getFullYear() / 100) * 100

  for (let indietro = 0; indietro < SECOLI_DA_PROVARE; indietro++) {
    const anno = inizioSecolo - indietro * 100 + annoDueCifre
    // Il calendario lo decide `tabelle.ts`, in aritmetica: qui non si costruiscono `Date`.
    if (!dataEsiste(anno, mese, giorno)) continue
    // Nato oggi conta come non futuro.
    if (nonFutura(anno, mese, giorno, oggi)) return anno
  }
  return null
}

/**
 * Data di nascita letta dal codice fiscale, omocodia compresa.
 * Ritorna `null` se il codice è malformato, se il giorno è fuori scala, se la data
 * non esiste (31 aprile) o se nessuno dei due secoli dà una data non futura.
 *
 * ⚠️ Il `Date` che esce è la **mezzanotte locale** di quel giorno (`new Date(a, m, g)`),
 * cioè la stessa convenzione con cui la legge `annoScolasticoCorrente` in questo repo:
 * il giorno si rilegge con `getFullYear/getMonth/getDate`, non con i getter UTC.
 *
 * @param cf codice fiscale, con o senza spazi, maiuscolo o minuscolo
 * @param oggi riferimento per la scelta del secolo: la data OLTRE LA QUALE una nascita
 *             sarebbe futura. Il valore di comodo `new Date()` va bene per una lettura
 *             a schermo; chi decide qualcosa di irreversibile passa una data del
 *             documento, altrimenti la stessa domanda dà risposte diverse in giorni
 *             diversi (vedi `finePlausibile` in `@/lib/fatturazione/sezionale`).
 */
export function dataNascitaDaCodiceFiscale(cf: string, oggi: Date = new Date()): Date | null {
  const pezzi = leggiPezzi(cf)
  if (!pezzi) return null
  if (!(oggi instanceof Date) || !Number.isFinite(oggi.getTime())) return null

  const anno = annoConSecolo(pezzi.annoDueCifre, pezzi.mese, pezzi.giorno, oggi)
  if (anno === null) return null

  return new Date(anno, pezzi.mese - 1, pezzi.giorno)
}

/**
 * Sesso letto dal codice fiscale: giorno > 40 → femmina.
 *
 * Volutamente **più permissiva** di `dataNascitaDaCodiceFiscale`: `…24B70…` (30 febbraio
 * al femminile) non è una data reale e lì dà `null`, ma il sesso resta leggibile e qui
 * dà `'F'`. Sono due domande diverse, e rispondere `null` al sesso perché il giorno è
 * impossibile butterebbe via un'informazione che nel codice c'è.
 */
export function sessoDaCodiceFiscale(cf: string): 'M' | 'F' | null {
  const pezzi = leggiPezzi(cf)
  if (!pezzi) return null
  return pezzi.femmina ? 'F' : 'M'
}

/**
 * NOTA — il carattere di controllo NON viene verificato, ed è una scelta.
 *
 * Verificarlo intercetterebbe i refusi di digitazione, ma renderebbe questo modulo
 * l'unico giudice di «codice attendibile», e un codice fiscale sbagliato in anagrafica
 * (succede) smetterebbe di produrre una data confrontabile.
 *
 * ⚠️ QUESTA NOTA, FINO AL 2026-08-10, PROMETTEVA UNA DIFESA CHE IL CODICE NON ESEGUIVA.
 * Diceva: «la difesa contro il refuso sta un livello più su — `sezionalePerMinore`
 * confronta la data del CF con la `data_nascita` dell'anagrafica — e due fonti che si
 * controllano a vicenda battono una checksum». Il confronto però avviene SOLO quando
 * entrambe le fonti sono leggibili: un codice che non passa nemmeno da `FORMA_CF`
 * (riga 85) esce di qui come `null`, e nel caso più frequente — quello dei codici
 * sbagliati, che in produzione il 2026-08-10 erano **11 su 14** — non veniva confrontato
 * con niente e nessuno se ne accorgeva. Un documento che descrive una protezione
 * inesistente costa più di nessun documento (`CLAUDE.md`).
 *
 * QUELLO CHE SUCCEDE DAVVERO, adesso, ed è verificabile:
 *  - se il codice è leggibile e discorda dall'anagrafica → `sezionalePerMinore` usa
 *    l'anagrafica e alza `discordanza`;
 *  - se il codice C'È ma è illeggibile → `sezionalePerMinore` alza
 *    `codiceFiscaleIlleggibile`, distinto da «assente», e `@/lib/aruba/emissione` lo
 *    logga a livello `error` col solo `alunno_id`;
 *  - se il codice si legge benissimo ma dice una data che un ALUNNO non può avere — il
 *    caso vero del codice di un genitore incollato nel campo del bambino — allora non è
 *    una fonte: `sezionalePerMinore` alza `codiceFiscaleImplausibile` e, se è l'unica
 *    fonte, BLOCCA l'emissione. Fino al 2026-08-10 quel caso usciva con tutte le bandiere
 *    a `false`, ed era il buco che questa nota prometteva coperto senza che lo fosse.
 * Il confronto fra due fonti resta più forte di una checksum *quando può avvenire*; il
 * caso in cui non può avvenire non è più muto, che è il punto.
 *
 * Conseguenza pratica per i test: i codici sintetici di questo repo hanno un carattere
 * di controllo qualsiasi. È un bene — un codice con checksum valida potrebbe essere di
 * una persona vera, e questo repository è pubblico.
 */
