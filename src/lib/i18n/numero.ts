import { bcp47 } from '@/i18n/config';

// =============================================================================
// I NUMERI CHE FINISCONO DENTRO UNA FRASE, nella lingua di quella frase.
//
// PERCHÉ ESISTE (2026-08-03). `teacher/gallery/page.tsx` componeva così il
// messaggio «video oltre il limite»:
//
//     (file.size / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 })
//
// `undefined` come primo argomento non vuol dire «la lingua dell'app»: vuol dire
// «la lingua del RUNTIME». Nel browser è quella del sistema operativo, su Vercel
// è quella del processo (`en-US`). Misurato: interfaccia inglese su un browser
// italiano ⇒ «50,3 MB» dentro una frase inglese; interfaccia italiana su un
// browser inglese ⇒ «50.3 MB» dentro una frase italiana. Il difetto è gemello di
// quello delle date, chiuso in `src/lib/i18n/date.ts` con la stessa medicina: il
// locale è un PARAMETRO, e chi formatta lo deve avere in mano.
//
// La firma è la difesa: `locale` è obbligatorio e non ammette `undefined`, così
// il difetto non si può riaprire distrattamente — per rifarlo bisogna scrivere
// di nuovo `toLocaleString`, cioè decidere di farlo.
//
// La regione la sceglie `bcp47` (it-IT / en-GB), lo stesso punto delle date: un
// separatore deciso qui e uno deciso lì sarebbero due convenzioni nella stessa
// schermata.
//
// COSA NON STA QUI: gli IMPORTI. La valuta resta `it-IT` per decisione di
// progetto (`src/lib/format/valuta.ts`) — una retta si scrive «€ 1.234,50» anche
// nell'interfaccia inglese, perché è un dato contabile italiano, non una parola.
// =============================================================================

/**
 * Un decimale nella lingua indicata (separatore compreso).
 *
 * @param valore  il numero. Non finito (`NaN`, `Infinity`) ⇒ stringa vuota: in
 *   una frase «NaN MB» è peggio di un buco, e non deve poter arrivare a schermo.
 * @param locale  la lingua dell'INTERFACCIA (`useLocale()`), mai il runtime.
 * @param cifreMax quante cifre decimali al massimo (default 1).
 */
export function formattaDecimale(valore: number, locale: string, cifreMax = 1): string {
    if (!Number.isFinite(valore)) return '';
    return new Intl.NumberFormat(bcp47(locale), { maximumFractionDigits: cifreMax }).format(valore);
}

/**
 * La dimensione di un file in MB, nella lingua dell'interfaccia.
 *
 * `MB` è un simbolo invariante e viaggia attaccato al numero: NON entra nella
 * frase come parola separata, perché una parola andrebbe declinata al plurale e
 * questa non si declina in nessuna delle due lingue (cfr. il lock
 * `messaggi-plurali-e-glossario`, che su «{n} parola» pretende la forma ICU).
 *
 * `unita: false` per i messaggi che il simbolo ce l'hanno già scritto dentro
 * («supera i 50 MB (attuale: {dimensione} MB)»): la conversione resta comunque
 * qui — è l'unica cosa che non deve esistere in due copie — e a cambiare è solo
 * chi scrive il simbolo.
 */
export function formattaMegabyte(
    byte: number,
    locale: string,
    opzioni: { unita?: boolean; cifreMax?: number } = {},
): string {
    const { unita = true, cifreMax = 1 } = opzioni;
    const mb = formattaDecimale(byte / (1024 * 1024), locale, cifreMax);
    if (mb === '') return '';
    return unita ? `${mb} MB` : mb;
}
