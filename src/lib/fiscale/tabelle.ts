/**
 * TABELLE del codice fiscale italiano — dati condivisi, e basta.
 *
 * Nessun I/O, nessun log, nessun orologio: qui dentro c'è solo ciò che l'Agenzia delle
 * Entrate ha deciso una volta per tutte, e che serve identico a chi il codice lo LEGGE
 * (`codice-fiscale.ts`), a chi lo CALCOLA (`calcolo.ts`), a chi lo VALIDA
 * (`validazione.ts`) e a chi lo confronta con l'anagrafica (`coerenza.ts`).
 *
 * ⚠️ FINO AL 2026-08-10 QUESTA INTESTAZIONE DICEVA ANCHE «nessuna funzione», e la riga è
 * stata tolta invece di essere aggirata. Le funzioni pubbliche sono tre e sono quelle del
 * CALENDARIO (`giornoDiNascitaAmmesso`, `dataEsiste`, `dataEsistePerAnnoADueCifre`), e
 * sono qui per la ragione esatta per cui esiste il file:
 * le stesse regole erano scritte in due o tre moduli e divergevano. Una costante non
 * bastava — la scala dei giorni è un intervallo spezzato in due (1–31 e 41–71), il
 * calendario è aritmetica — e riscriverle a mano è il modo in cui le copie divergono. Il
 * criterio per aggiungerne un'altra resta stretto: solo aritmetica pura su queste tabelle,
 * mai una decisione di prodotto, mai un orologio.
 *
 * ⚠️ PERCHÉ ESISTE QUESTO FILE. Le stesse lettere dei mesi e la stessa tabella
 * dell'omocodia erano già scritte in due posti diversi, e una terza copia stava per
 * nascere. Una regola valida per due strade deve vivere in un posto solo: quando la copia
 * A viene corretta e la copia B no, il difetto non è una riga sbagliata — è che le due
 * risposte divergono e nessun test se ne accorge, perché ogni copia ha i suoi.
 * (È la lezione del ciclo 2 di `/ship-cycle`, in memoria dal 2026-08.)
 */

/**
 * Lettere del mese in ordine: A=gennaio … T=dicembre.
 * L'indice nella stringa + 1 è il numero del mese. Le lettere saltate (F, G, I, N, O, Q)
 * non sono un errore di battitura: servono a non confondersi con le cifre e fra loro.
 */
export const LETTERE_MESE = 'ABCDEHLMPRST'

/**
 * OMOCODIA — lettera → cifra che ha sostituito.
 *
 * Quando due persone otterrebbero lo stesso codice, l'Agenzia sostituisce le CIFRE con
 * lettere partendo da destra. Un parser che legge le posizioni numeriche come cifre e
 * basta ricava una data di nascita SBAGLIATA.
 */
export const CIFRA_DA_OMOCODIA: Readonly<Record<string, string | undefined>> = {
  L: '0', M: '1', N: '2', P: '3', Q: '4', R: '5', S: '6', T: '7', U: '8', V: '9',
}

/** OMOCODIA — cifra → lettera che la sostituisce. È l'inversa esatta della tabella sopra. */
export const OMOCODIA_DA_CIFRA: Readonly<Record<string, string | undefined>> = {
  '0': 'L', '1': 'M', '2': 'N', '3': 'P', '4': 'Q', '5': 'R', '6': 'S', '7': 'T', '8': 'U', '9': 'V',
}

/**
 * Gli indici (0-based) delle posizioni che in un codice SENZA omocodia sono cifre:
 * le due dell'anno (6, 7), le due del giorno (9, 10) e le tre del codice catastale
 * (12, 13, 14). Fuori da questi, una lettera è una lettera e non va mai interpretata come
 * una cifra travestita — l'8 è il mese, l'11 la prima lettera del catastale, il 15 il
 * carattere di controllo.
 */
export const POSIZIONI_NUMERICHE: readonly number[] = [6, 7, 9, 10, 12, 13, 14]

/**
 * ⚠️ IL PUNTO IN CUI SI SBAGLIA. Le posizioni «dispari» e «pari» del carattere di
 * controllo sono in numerazione **1-BASED**: la prima lettera del codice è in posizione
 * DISPARI, e in un array indicizzato da zero è l'indice PARI.
 *
 *     indice 0-based:  0  1  2  3 …   → PESI_DISPARI su 0, 2, 4 …
 *     posizione 1-based: 1  2  3  4 … → PESI_PARI     su 1, 3, 5 …
 *
 * Scambiare le due tabelle non produce un errore: produce un'altra lettera dell'alfabeto,
 * plausibile e falsa. Il collaudo lo fissa calcolando anche la versione invertita e
 * pretendendo che sia DIVERSA (`__tests__/lib/fiscale/calcolo.test.ts`).
 */
export const PESI_DISPARI: Readonly<Record<string, number | undefined>> = {
  '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14,
  U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
}

/** Posizioni PARI in numerazione 1-based, cioè indici 0-based DISPARI: il valore ordinale. */
export const PESI_PARI: Readonly<Record<string, number | undefined>> = {
  '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19,
  U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
}

/** Il resto della somma dei pesi, modulo 26, si legge qui: 0 → A, 25 → Z. */
export const ALFABETO_CONTROLLO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Alle donne si somma 40 al giorno di nascita: 15 → 55, 1 → 41. */
export const SCARTO_FEMMINA = 40

/**
 * Le due cifre del giorno stanno nella SCALA dei giorni?
 *
 * La scala è **1–31 al maschile e 41–71 al femminile** (giorno + `SCARTO_FEMMINA`).
 * Fuori di lì non c'è nessuno: `00` non è un giorno, `32`–`40` è la terra di nessuno fra
 * il maschile e il femminile, oltre `71` non arriva nemmeno il 31 con lo scarto.
 *
 * ⚠️ QUESTA FUNZIONE NON GUARDA IL MESE, ED È VOLUTO: `31` è nella scala anche quando il
 * mese è febbraio. «Quel giorno esiste in quel mese?» è la domanda successiva e la risponde
 * `dataEsistePerAnnoADueCifre`. Sono due domande separate perché hanno due risposte utili
 * diverse — «quelle due cifre non sono un giorno» e «quel giorno quel mese non ce l'ha» —
 * e chi deve correggere un'anagrafica le corregge in due modi diversi.
 *
 * ⚠️ FINO AL 2026-08-10 LA SEPARAZIONE NON C'ERA E LA SECONDA DOMANDA NON VENIVA POSTA:
 * `validaCodiceFiscale` si fermava alla scala e dichiarava `{valido: true, motivi: []}` su
 * `XQQYKV19B31Z999A` (31 febbraio, checksum corretta), mentre `codice-fiscale.ts` sulla
 * stessa stringa rispondeva `null`. Era la stessa divergenza che questo file esiste per
 * abolire, riparata a metà.
 *
 * ⚠️ PERCHÉ STA QUI E NON NEI DUE MODULI CHE LA USANO. Fino al 2026-08-10 questa regola
 * era scritta in `codice-fiscale.ts` e basta: `validaCodiceFiscale` non ce l'aveva, e
 * `XQQYKV19C00Z999D`, `…C35…`, `…C99…` — checksum corretta — tornavano
 * `{valido: true, motivi: []}` mentre il modulo fratello, sulla stessa stringa,
 * rispondeva `null`. Due verdetti opposti nella stessa cartella: esattamente ciò che
 * questo file esiste per abolire.
 *
 * ⚠️ L'ARGOMENTO SI VUOLE GIÀ SCIOLTO DALL'OMOCODIA. Le posizioni 9 e 10 possono portare
 * lettere (`LT` = `07`): chi passa `Number('LT')` passa `NaN`, e `NaN` non è ammesso —
 * che è la risposta giusta per un `NaN` ma sbagliata per quel codice, che è valido.
 */
export function giornoDiNascitaAmmesso(giornoDueCifre: number): boolean {
  if (!Number.isInteger(giornoDueCifre)) return false
  const maschile = giornoDueCifre >= 1 && giornoDueCifre <= 31
  const femminile =
    giornoDueCifre >= 1 + SCARTO_FEMMINA && giornoDueCifre <= 31 + SCARTO_FEMMINA
  return maschile || femminile
}

/**
 * Quanti giorni ha ogni mese, febbraio nell'anno NON bisestile.
 * L'indice è il mese meno uno, come per `LETTERE_MESE`.
 */
const GIORNI_DEL_MESE: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Anno bisestile secondo il calendario gregoriano: divisibile per 4, tranne i secolari che
 * non sono divisibili per 400. Il 2000 è bisestile, il 1900 e il 2100 no.
 */
function annoBisestile(anno: number): boolean {
  if (!Number.isInteger(anno)) return false
  return (anno % 4 === 0 && anno % 100 !== 0) || anno % 400 === 0
}

/**
 * Quanti giorni ha quel mese in quell'anno. `0` se il mese non è un mese.
 *
 * Non è esportata, e non per pudore: fuori di qui nessuno chiede «quanti giorni ha aprile»
 * — chiedono tutti «questa data esiste?». Una funzione pubblica senza chiamanti è
 * superficie che qualcuno userà un giorno per rifarsi la sua copia del calendario, che è
 * il difetto che questo file esiste per chiudere.
 */
function giorniDelMese(mese: number, anno: number): number {
  if (!Number.isInteger(mese) || mese < 1 || mese > 12) return 0
  if (mese === 2 && annoBisestile(anno)) return 29
  return GIORNI_DEL_MESE[mese - 1]
}

/**
 * La terna anno/mese/giorno esiste sul calendario? (31 aprile e 29 febbraio non bisestile:
 * no.)
 *
 * ⚠️ ARITMETICA, NON `new Date`. Fino al 2026-08-10 questa stessa domanda era scritta due
 * volte: in `calcolo.ts` con l'aritmetica e in `codice-fiscale.ts` con
 * `new Date(anno, mese - 1, giorno)` — cioè proprio la costruzione dipendente dal fuso
 * orario del processo che il commento di `calcolo.ts` additava come rischio già pagato in
 * questo repo (il banco di prova viveva in UTC mentre il prodotto usa Europe/Rome, e
 * quattro punti sono caduti insieme; memoria del 2026-08-09). Adesso la copia è una sola
 * ed è quella che non ha un fuso orario.
 */
export function dataEsiste(anno: number, mese: number, giorno: number): boolean {
  if (!Number.isInteger(giorno)) return false
  return giorno >= 1 && giorno <= giorniDelMese(mese, anno)
}

/**
 * La stessa domanda, ma con l'anno a DUE CIFRE — cioè senza sapere il secolo: quella data
 * può esistere in QUALCHE secolo?
 *
 * È la domanda giusta per chi VALIDA un codice fiscale: nel codice il secolo non c'è, e
 * indovinarlo richiederebbe un orologio — che qui dentro non entra. `19B29` non esiste in
 * nessun secolo (nessun anno che finisce per 19 è bisestile); `00B29` esiste, perché il
 * 2000 lo è.
 *
 * ⚠️ PERCHÉ BASTA PROVARE UN ANNO SOLO, E PERCHÉ PROPRIO `2000 + aa`. Un anno
 * `Y = 100k + aa` è bisestile se `Y % 4 === 0` e non è secolare, oppure se `Y % 400 === 0`.
 * Poiché `100k % 4 === 0`, la divisibilità per 4 dipende solo da `aa`:
 *  · `aa` non multiplo di 4 → nessun secolo lo rende bisestile;
 *  · `aa` multiplo di 4 e diverso da `00` → bisestile in OGNI secolo (non è mai secolare);
 *  · `aa === 00` → bisestile solo nei secoli multipli di 400, e uno di quelli è il 2000.
 * In tutti e tre i casi `2000 + aa` dà la risposta giusta: è divisibile per 4 esattamente
 * quando lo è `aa`, e l'unico caso secolare che produce (`2000`) è divisibile per 400.
 * Il `2000` non è quindi «il secolo di comodo»: è l'unico rappresentante che rende
 * l'affermazione vera per costruzione.
 */
export function dataEsistePerAnnoADueCifre(
  annoDueCifre: number,
  mese: number,
  giorno: number,
): boolean {
  if (!Number.isInteger(annoDueCifre) || annoDueCifre < 0 || annoDueCifre > 99) return false
  return dataEsiste(2000 + annoDueCifre, mese, giorno)
}

/**
 * La forma del codice catastale (Belfiore): una lettera e tre cifre. `H501`, `Z999`…
 * Sta qui e non in `calcolo.ts` perché la usano sia il calcolo sia il confronto.
 */
export const FORMA_CODICE_BELFIORE = /^[A-Za-z][0-9]{3}$/

/** Classe di caratteri ammessi in una posizione numerica: cifra oppure lettera d'omocodia. */
const OMOCODIA = '[\\dLMNPQRSTUVlmnpqrstuv]'
/** Classe delle sole lettere del mese, maiuscole e minuscole, costruita da `LETTERE_MESE`. */
const MESE = `[${LETTERE_MESE}${LETTERE_MESE.toLowerCase()}]`

/**
 * Struttura del codice fiscale: 6 lettere (cognome+nome), 2 cifre (anno), 1 lettera
 * (mese), 2 cifre (giorno+sesso), 4 caratteri (catastale: 1 lettera + 3 cifre), 1 lettera
 * (carattere di controllo). Le posizioni numeriche accettano anche le lettere
 * dell'omocodia — è per questo che la classe non è `\d`.
 *
 * ⚠️ La lettera del mese è vincolata alle dodici valide, non a `[A-Za-z]`. Chi legge il
 * codice lo verificava già un passo più in là (`LETTERE_MESE.indexOf(...)` in
 * `codice-fiscale.ts`), quindi per lui non cambia niente; per chi VALIDA cambia tutto —
 * senza il vincolo, un codice con mese `Z` e checksum giusta passerebbe per valido.
 *
 * Niente flag `g` né `y`: una regex con stato condivisa fra moduli dà risultati diversi a
 * chiamate identiche, ed è un difetto che si manifesta solo alla seconda chiamata.
 */
export const FORMA_CF = new RegExp(
  `^[A-Za-z]{6}${OMOCODIA}{2}${MESE}${OMOCODIA}{2}[A-Za-z]${OMOCODIA}{3}[A-Za-z]$`,
)

/**
 * La stessa forma, ma senza omocodia: è quella che un codice CALCOLATO deve avere sempre.
 * L'omocodia la assegna l'Agenzia quando due persone collidono; non si calcola, non si
 * indovina, e un modulo che la producesse inventerebbe il codice di qualcun altro.
 */
export const FORMA_CF_SENZA_OMOCODIA = new RegExp(
  `^[A-Za-z]{6}\\d{2}${MESE}\\d{2}[A-Za-z]\\d{3}[A-Za-z]$`,
)
