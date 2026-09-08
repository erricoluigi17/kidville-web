/**
 * ESTRATTORE CONDIVISO PER IL BAGNO — gemello di `nanna.ts`, e per lo stesso motivo.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO CHE LO FA NASCERE, segnalato dal titolare il 2026-09-08: *«se aggiungo
 * una pipì e una cacca per un bambino, poi risulta a tutti anche a chi non l'ha
 * fatta»*. Il salvataggio del diario scriveva una riga in `eventi_diario` per OGNI
 * bambino presente — il pulsante dice «Salva bagno per tutti» — e `buildInitialState`
 * mette d'ufficio `{pipi:0, cacca:0, vasino:0}` a tutti. Chi non era stato toccato
 * finiva in archivio con i contatori a zero, e il genitore leggeva la voce generica:
 * «🚿 Sono stato/a al bagno oggi!». Un bagno mai avvenuto, nel diario di suo figlio.
 *
 * Misurato dal 1° settembre 2026: **323 righe su 514 completamente vuote, il 63%**.
 *
 * PERCHÉ LA PREMESSA CHE LO LASCIAVA APERTO ERA FALSA. Quando la nanna fu corretta
 * (PR #130), bagno e pasti restarono fuori di proposito, con questa ragione scritta
 * nel codice: *«lo stato vuoto È un dato — "segnato: non ha mangiato niente" è
 * diverso da "non l'ho segnato"»*. Per i pasti è vero, e `pasto.ts` lo difende con
 * un test: `MEAL_QUANTITIES` ha il valore `'niente'`, che la maestra sceglie con un
 * tocco. Per il bagno **non esiste niente del genere**: i contatori nascono a zero
 * per tutti, e nessun gesto produce «controllato, non ha fatto nulla». Quello zero
 * è indistinguibile da «non l'ho toccato», ed era proprio la distinzione su cui la
 * premessa si reggeva.
 *
 * EFFETTO RETROATTIVO, la parte che vale di più: le 323 righe già in archivio non si
 * cancellano — diventano inerti in tutti i lettori nello stesso istante, senza
 * nessuna migrazione e senza scrivere una riga sul database di produzione.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/** I tre contatori che una registrazione di bagno porta in `dettagli`. */
export type CampoBagno = 'pipi' | 'cacca' | 'vasino';

const CAMPI_BAGNO: readonly CampoBagno[] = ['pipi', 'cacca', 'vasino'];

/** Questo tipo evento è un bagno? */
export function eEventoBagno(tipo: string): boolean {
    return tipo === 'bagno';
}

/**
 * Il valore di un contatore, normalizzato a un intero ≥ 0.
 *
 * In JSONB `2` e `"2"` sono entrambi possibili — la colonna non ha uno schema — e
 * il lettore del genitore già faceva `Number(dettagli?.pipi ?? 0)`. Qui si stringe
 * un po' di più: `NaN`, negativi e non-numerici valgono **zero**, perché la domanda
 * è «quante volte è successo», e un numero che non si sa leggere non è una volta.
 */
export function contatoreBagno(
    dettagli: Record<string, unknown> | null | undefined,
    campo: CampoBagno,
): number {
    const n = Number(dettagli?.[campo] ?? 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
}

/**
 * Questa registrazione di bagno è stata COMPILATA davvero?
 *
 * Fail-closed su un tipo che bagno non è: la chiamano solo i punti che trattano il
 * bagno, e rispondere `true` a un `pranzo` significherebbe lasciar passare per
 * compilato un evento di cui questo modulo non sa niente.
 */
export function bagnoCompilato(
    tipo: string,
    dettagli: Record<string, unknown> | null | undefined,
): boolean {
    if (!eEventoBagno(tipo)) return false;
    return CAMPI_BAGNO.some(c => contatoreBagno(dettagli, c) > 0);
}
