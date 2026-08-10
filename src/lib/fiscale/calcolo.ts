/**
 * CALCOLO del codice fiscale italiano a partire dall'anagrafica.
 *
 * Funzioni PURE: nessun I/O, nessuna rete, nessun log, nessun orologio. Chi chiama sa su
 * quale pratica sta lavorando ed è l'unico che possa loggare qualcosa di utile; qui non
 * entra e non esce nulla che non sia una stringa.
 *
 * ⚠️ NON confondere questo modulo con `@/lib/utils/fiscalCode`, che è un GENERATORE FINTO
 * (mese sempre `A`, giorno fisso 15/55, catastale fisso) usato per riempire un modulo a
 * schermo. Quello non calcola niente e non va esteso.
 *
 * ⚠️ QUESTO MODULO NON PRODUCE MAI UN CODICE OMOCODICO. L'omocodia la assegna l'Agenzia
 * quando due persone otterrebbero lo stesso codice: non è una funzione dell'anagrafica, è
 * una decisione presa altrove. Un modulo che la calcolasse produrrebbe, con la faccia
 * della certezza, il codice di qualcun altro.
 *
 * ⚠️ IL CODICE CALCOLATO NON È IL CODICE VERO. È il codice che l'anagrafica IMPLICA: serve
 * a confrontare (`coerenza.ts`) e a suggerire, non a sostituire il documento. Fra i due,
 * l'unico dato certo è quello che sta sul tesserino.
 */

import {
  ALFABETO_CONTROLLO,
  FORMA_CODICE_BELFIORE,
  LETTERE_MESE,
  PESI_DISPARI,
  PESI_PARI,
  SCARTO_FEMMINA,
  dataEsiste,
} from './tabelle'

export interface DatiAnagraficiCf {
  nome: string
  cognome: string
  sesso: 'M' | 'F'
  /** Data di nascita nella sola forma `AAAA-MM-GG` (è quella che restituisce una colonna `date`). */
  dataNascita: string
  /** Codice catastale (Belfiore) del comune o dello stato di nascita: una lettera e tre cifre. */
  codiceBelfiore: string
}

export type MotivoNonCalcolabile =
  /**
   * ⚠️ «Senza lettere» va letto «senza lettere LEGGIBILI»: copre sia il campo vuoto o in
   * cirillico, sia il cognome latino che contiene una lettera che non si sa tradurre
   * (`ROSSИ`). Il nome del motivo è rimasto quello perché la decisione del chiamante è la
   * stessa in entrambi i casi — non si calcola nulla — e distinguerli qui vorrebbe dire
   * far scegliere a chi legge fra due rossi identici.
   */
  | 'cognome-senza-lettere'
  | 'nome-senza-lettere'
  | 'sesso-non-valido'
  | 'data-non-valida'
  | 'belfiore-non-valido'

export type EsitoCalcolo =
  | { ok: true; codice: string }
  | { ok: false; motivo: MotivoNonCalcolabile }

const VOCALI = 'AEIOU'

/**
 * I segni diacritici combinanti che NFD stacca dalla lettera: l'intervallo Unicode
 * U+0300–U+036F.
 *
 * La classe si costruisce dai codepoint invece di scrivere i due caratteri nel sorgente
 * perché alla lettera sono INVISIBILI: un sorgente in cui una modifica non si vede è un
 * sorgente su cui non si può fare una revisione. Quello che li protegge davvero sono i
 * casi con l'accento in `__tests__/lib/fiscale/calcolo.test.ts`.
 */
const SEGNI_DIACRITICI = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  'g',
)
const LUNGHEZZA_PRIMI_15 = 15
const RIEMPIMENTO = 'XXX'

/**
 * LETTERE LATINE CHE NFD NON DECOMPONE, e la loro resa in A–Z.
 *
 * ⚠️ QUESTA TABELLA È NATA DA UN COMMENTO CHE DICEVA IL FALSO. Fino al 2026-08-10 la nota
 * su `soloLettereLatine` sosteneva che `Ø` e `Đ` facessero restituire `null`. Misurato:
 * `terzinaCognome('ĐORĐE')` dava `ROE` e `terzinaCognome('ŁUKASZ')` dava `KSZ` — le
 * lettere venivano buttate una per una e usciva una terzina PLAUSIBILE E SBAGLIATA. La
 * rete di sicurezza scattava solo se TUTTE le lettere erano non decomponibili, cioè quasi
 * mai. Un documento che descrive una protezione inesistente costa più di nessun
 * documento (`CLAUDE.md`).
 *
 * Le chiavi sono MAIUSCOLE perché la tabella si applica dopo `toUpperCase()`.
 *
 * Due gruppi, con due giustificazioni diverse:
 *
 *  · **lettera sbarrata → lettera** (`Ł`→`L`, `Đ`/`Ð`→`D`, `Ø`→`O`, `Ħ`→`H`, `Ŧ`→`T`).
 *    Qui non si indovina niente: la sbarra è un segno diacritico che Unicode ha scelto di
 *    non codificare come combinante. È la stessa regola di NFD, applicata a mano dove NFD
 *    non arriva — e la stessa con cui questo modulo fa già `Ä`→`A`.
 *
 *  · **legamento → le sue lettere** (`Æ`→`AE`, `Œ`→`OE`, `Ĳ`→`IJ`, `Þ`→`TH`, `ẞ`→`SS`).
 *    Questi cambiano la LUNGHEZZA della stringa, quindi cambiano quale consonante è la
 *    1ª, la 3ª e la 4ª: pesano più degli altri. Si sciolgono lo stesso perché `ß`→`SS` il
 *    codice lo fa GIÀ — lo fa `toUpperCase` — e applicare la regola a una sola lettera
 *    della famiglia sarebbe la solita divergenza fra due copie della stessa idea.
 *
 * ⚠️ IL RISCHIO CHE RESTA, detto invece che taciuto: per `Ø` esistono due convenzioni in
 * giro (`O` e `OE`, quest'ultima è quella dei passaporti ICAO). Qui si è scelto `O`, che è
 * coerente con `Ä`→`A` — mentre ICAO farebbe `Ä`→`AE`, e seguirlo per una lettera sola
 * sarebbe peggio che non seguirlo. Dove la scelta non coincide con quella dell'anagrafe
 * che ha emesso il codice, il confronto di `coerenza.ts` produce un rosso falso: è il caso
 * residuo, ed è molto più raro di quello riparato.
 *
 * Quello che NON è in tabella non si indovina: fa restituire `null` (vedi
 * `restanoLettereNonLatine`), che significa «non confrontabile», non «sbagliato».
 */
const TRASLITTERAZIONE_LATINA: Readonly<Record<string, string>> = {
  Ł: 'L',
  Đ: 'D',
  Ð: 'D',
  Ø: 'O',
  Ħ: 'H',
  Ŧ: 'T',
  Æ: 'AE',
  Œ: 'OE',
  Ĳ: 'IJ',
  Þ: 'TH',
  ẞ: 'SS',
}

/**
 * Dopo NFD, diacritici e traslitterazione: è rimasta una LETTERA che non è A–Z?
 *
 * Se sì, la stringa non si sa leggere e chi chiama restituisce `null`. Non si butta via il
 * carattere e non si tira avanti con le lettere superstiti: `ROSSИ` non è `ROSSI`, e dare
 * `RSS` significherebbe affermare che il cognome comincia per quelle tre consonanti
 * quando non lo si è dimostrato — un motivo `cognome` di incoerenza emesso a torto su un
 * bambino il cui codice fiscale è giusto.
 *
 * ⚠️ Il filtro è sulle LETTERE (`\p{L}`), non su «tutto ciò che non è A–Z»: spazi,
 * apostrofi, trattini, cifre e SIMBOLI continuano a essere scartati in silenzio, ed è
 * giusto — `DE LUCA` e `D'ANGELO` sono la regola dell'Agenzia, non un'eccezione.
 *
 * ⚠️ MA «LETTERA» QUI VUOL DIRE `\p{L}`, CHE È PIÙ LARGO DI QUANTO CHIUNQUE INTENDA. Sono
 * lettere per Unicode, e quindi fanno restituire `null`, anche l'indicatore ordinale `ª` e
 * `º` (categoria Lo), il segno micro `µ` (Ll) e le forme a larghezza piena `ＲＯＳＳＩ`.
 * Misurato, non dedotto: `terzinaCognome('ROSSIª')` e `terzinaCognome('ROSSIµ')` danno
 * `null`. La coppia che inganna è `3°` / `3ª`: il grado è un SIMBOLO e sparisce in
 * silenzio, l'ordinale è una LETTERA e rende il campo non confrontabile — due caratteri
 * che a schermo si somigliano e qui si comportano in modo opposto.
 *
 * È una scelta consapevole di non restringere il filtro: il fallimento è CONSERVATIVO — il
 * campo finisce fra i `nonVerificabili` di `coerenza.ts`, grigio, mai rosso — e allargare
 * la lista bianca delle categorie Unicode per accogliere `ª` significherebbe decidere che
 * `3ª` fa parte del cognome, che non è vero più di quanto lo sia `3°`. Quello che si
 * perde è verificabilità su un caso raro; quello che si eviterebbe scrivendo una regola in
 * più è nulla. Fissato in `__tests__/lib/fiscale/calcolo.test.ts` accanto a `D'ANGELO 3°`,
 * perché non sia più una sorpresa: fino al 2026-08-10 questa nota diceva il contrario.
 */
const LETTERA_UNICODE = /\p{L}/u

function restanoLettereNonLatine(testo: string): boolean {
  return [...testo].some((c) => LETTERA_UNICODE.test(c) && (c < 'A' || c > 'Z'))
}

/**
 * Riduce un nome proprio alle sole lettere latine maiuscole.
 *
 * ⚠️ LA NORMALIZZAZIONE NFD È IL PUNTO. `NICCOLÒ`, `FRANÇOIS`, `MÜLLER`: un
 * `replace(/[^A-Z]/g, '')` ingenuo non toglie l'accento, toglie LA LETTERA — e il codice
 * che ne esce è plausibile e sbagliato. NFD spezza la lettera accentata nella lettera più
 * il segno diacritico, e qui si buttano via solo i segni (`SEGNI_DIACRITICI`).
 *
 * L'ordine conta: prima si spoglia, poi si alza a maiuscolo (così `ß` diventa `SS`, che è
 * la regola), poi si traducono le lettere latine che NFD non decompone
 * (`TRASLITTERAZIONE_LATINA`: `Ł`→`L`, `Đ`→`D`, `Æ`→`AE`…), e solo alla fine si scarta
 * tutto ciò che non è `A-Z` — spazi, apostrofi e trattini compresi, come vuole l'Agenzia
 * per `DE LUCA` e `D'ANGELO`.
 *
 * ⚠️ QUELLO CHE RESTA E NON SI SA LEGGERE FA RESTITUIRE STRINGA VUOTA, e con essa `null`
 * a chi chiama: alfabeti non latini (cirillico, arabo, cinese) e lettere latine fuori
 * tabella. **Anche quando sono in mezzo a lettere latine** — ed è il punto in cui questa
 * nota, fino al 2026-08-10, prometteva una difesa che non c'era: il vecchio
 * `replace(/[^A-Z]/g, '')` buttava via la lettera e tirava avanti con le altre, e la
 * stringa usciva vuota solo se erano illeggibili TUTTE. `ĐORĐE` dava `ROE`.
 */
function soloLettereLatine(testo: unknown): string {
  if (typeof testo !== 'string') return ''
  const spogliato = testo
    .normalize('NFD')
    .replace(SEGNI_DIACRITICI, '')
    .toUpperCase()
    .replace(/./gu, (c) => TRASLITTERAZIONE_LATINA[c] ?? c)
  if (restanoLettereNonLatine(spogliato)) return ''
  return spogliato.replace(/[^A-Z]/g, '')
}

function consonantiDi(lettere: string): string {
  return [...lettere].filter((c) => !VOCALI.includes(c)).join('')
}

function vocaliDi(lettere: string): string {
  return [...lettere].filter((c) => VOCALI.includes(c)).join('')
}

/**
 * Terzina del COGNOME: consonanti, poi vocali, poi `X` di riempimento; prime tre.
 * `ROSSI`→`RSS`, `FOA`→`FOA`, `RE`→`REX`, `O`→`OXX`.
 *
 * ⚠️ Ritorna `null` — e non `XXX` — in due casi: quando non c'è nemmeno una lettera latina
 * (cirillico, arabo, cinese, solo cifre, solo punteggiatura) e quando ce n'è una che non
 * si sa tradurre, **anche se le altre sono latine** (`ROSSИ`). `XXX` sarebbe un codice
 * dall'aspetto regolare costruito sul nulla, e `RSS` da `ROSSИ` è la stessa cosa in
 * peggio: il modo peggiore di sbagliare, perché non si vede.
 */
export function terzinaCognome(cognome: string): string | null {
  const lettere = soloLettereLatine(cognome)
  if (lettere.length === 0) return null
  return (consonantiDi(lettere) + vocaliDi(lettere) + RIEMPIMENTO).slice(0, 3)
}

/**
 * Terzina del NOME: se le consonanti sono **quattro o più** si prendono la 1ª, la 3ª e la
 * 4ª (`FRANCESCO`→`FNC`); altrimenti si torna alla regola del cognome — consonanti, vocali,
 * `X` (`EVA`→`VEA`, `LI`→`LIX`).
 *
 * Il confine è esattamente quattro: con tre consonanti la regola NON si applica.
 * Ritorna `null` quando le lettere non si sanno leggere, per la stessa ragione — e negli
 * stessi due casi — di `terzinaCognome`.
 */
export function terzinaNome(nome: string): string | null {
  const lettere = soloLettereLatine(nome)
  if (lettere.length === 0) return null
  const consonanti = consonantiDi(lettere)
  if (consonanti.length >= 4) return consonanti[0] + consonanti[2] + consonanti[3]
  return (consonanti + vocaliDi(lettere) + RIEMPIMENTO).slice(0, 3)
}

const FORMA_DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * I cinque caratteri centrali del codice: anno a due cifre, lettera del mese, giorno.
 * Alla femmina si sommano 40 al giorno (15 → `55`, 1 → `41`).
 *
 * Accetta SOLO la forma `AAAA-MM-GG` (spazi ai bordi tollerati), che è quella con cui una
 * colonna `date` di Postgres esce da PostgREST. Un `timestamptz` non si accetta di
 * proposito: interpretarne la parte letterale significherebbe sbagliare il giorno di
 * qualcuno per due ore ogni notte, in silenzio; qui invece dà `null`, che si vede.
 *
 * Il sesso lo vuole già normalizzato (`'M'` o `'F'`): è la primitiva, non l'ingresso.
 *
 * ⚠️ IL CALENDARIO NON È PIÙ SCRITTO QUI. Fino al 2026-08-10 questo file aveva il suo
 * `giorniDelMese` e `codice-fiscale.ts` aveva il suo `dataReale` (con `new Date`, cioè
 * dipendente dal fuso), e `validazione.ts` non aveva né l'uno né l'altro: tre moduli, due
 * copie della stessa regola e un buco. La regola vive ora in `dataEsiste` (`./tabelle`),
 * in aritmetica pura, e la usano tutti e tre.
 */
export function terzinaData(dataNascita: string, sesso: 'M' | 'F'): string | null {
  if (typeof dataNascita !== 'string') return null
  if (sesso !== 'M' && sesso !== 'F') return null

  const pezzi = FORMA_DATA_ISO.exec(dataNascita.trim())
  if (!pezzi) return null

  const anno = Number(pezzi[1])
  const mese = Number(pezzi[2])
  const giorno = Number(pezzi[3])
  if (!dataEsiste(anno, mese, giorno)) return null

  const aa = String(anno % 100).padStart(2, '0')
  const gg = String(sesso === 'F' ? giorno + SCARTO_FEMMINA : giorno).padStart(2, '0')
  return `${aa}${LETTERE_MESE[mese - 1]}${gg}`
}

/**
 * Il sedicesimo carattere, calcolato sui primi quindici.
 *
 * ⚠️ Le posizioni «dispari» dell'Agenzia sono 1-BASED: sono gli indici 0-based PARI. Vedi
 * la nota estesa su `PESI_DISPARI` in `tabelle.ts` — scambiare le due tabelle non dà un
 * errore, dà un'altra lettera.
 *
 * Su un ingresso che non sia quindici caratteri alfanumerici SOLLEVA `RangeError` invece
 * di restituire una lettera qualsiasi: un carattere di controllo inventato renderebbe
 * "valido" un codice che non lo è, e sarebbe indistinguibile da uno vero. Chi chiama, in
 * questo modulo e in `validazione.ts`, verifica la forma prima.
 */
export function carattereControllo(primi15: string): string {
  if (typeof primi15 !== 'string' || primi15.length !== LUNGHEZZA_PRIMI_15) {
    throw new RangeError(
      `carattereControllo: servono esattamente ${LUNGHEZZA_PRIMI_15} caratteri, ricevuti ${
        typeof primi15 === 'string' ? primi15.length : typeof primi15
      }`,
    )
  }
  const codice = primi15.toUpperCase()
  let somma = 0
  for (let i = 0; i < LUNGHEZZA_PRIMI_15; i++) {
    const carattere = codice[i]
    const peso = i % 2 === 0 ? PESI_DISPARI[carattere] : PESI_PARI[carattere]
    if (peso === undefined) {
      throw new RangeError(
        `carattereControllo: carattere non ammesso in posizione ${i + 1} (solo A-Z e 0-9)`,
      )
    }
    somma += peso
  }
  return ALFABETO_CONTROLLO[somma % 26]
}

/**
 * Normalizza un codice catastale: via gli spazi, tutto maiuscolo. `null` se non ha la
 * forma «una lettera e tre cifre».
 */
export function normalizzaCodiceBelfiore(codice: unknown): string | null {
  if (typeof codice !== 'string') return null
  const pulito = codice.replace(/\s+/g, '').toUpperCase()
  return FORMA_CODICE_BELFIORE.test(pulito) ? pulito : null
}

/** Il sesso come lo tratta l'ingresso: spazi e minuscole tollerati, il resto è `null`. */
function normalizzaSesso(sesso: unknown): 'M' | 'F' | null {
  if (typeof sesso !== 'string') return null
  const s = sesso.trim().toUpperCase()
  return s === 'M' || s === 'F' ? s : null
}

/**
 * Il codice fiscale che l'anagrafica implica, oppure il MOTIVO per cui non si può
 * calcolare.
 *
 * I motivi si restituiscono uno alla volta, nell'ordine in cui si leggono i pezzi del
 * codice: chi deve correggere un'anagrafica parte comunque dal primo campo.
 *
 * Non c'è nessun ripiego, nessun riempimento di `X`, nessuna deduzione: se manca un pezzo
 * non esce un codice «quasi giusto». Un codice quasi giusto è un codice sbagliato con
 * l'aria di essere buono, e su una fattura elettronica lo scarto arriva dallo SDI giorni
 * dopo, quando nessuno ricorda più di aver tirato a indovinare.
 */
export function calcolaCodiceFiscale(dati: DatiAnagraficiCf): EsitoCalcolo {
  const cognome = terzinaCognome(dati?.cognome)
  if (cognome === null) return { ok: false, motivo: 'cognome-senza-lettere' }

  const nome = terzinaNome(dati?.nome)
  if (nome === null) return { ok: false, motivo: 'nome-senza-lettere' }

  const sesso = normalizzaSesso(dati?.sesso)
  if (sesso === null) return { ok: false, motivo: 'sesso-non-valido' }

  const data = terzinaData(dati?.dataNascita, sesso)
  if (data === null) return { ok: false, motivo: 'data-non-valida' }

  const belfiore = normalizzaCodiceBelfiore(dati?.codiceBelfiore)
  if (belfiore === null) return { ok: false, motivo: 'belfiore-non-valido' }

  const primi15 = `${cognome}${nome}${data}${belfiore}`
  return { ok: true, codice: primi15 + carattereControllo(primi15) }
}
