// =============================================================================
// CSV in uscita — la casa UNICA delle due regole che un file scaricabile deve
// rispettare: la citazione, e la NEUTRALIZZAZIONE della formula.
//
// ── PERCHÉ ESISTE, e che cosa si è trovato scrivendolo ──────────────────────
//
// La consegna chiedeva di verificare se `csvCell` (`src/lib/import/template.ts:41`)
// già disinnescasse l'iniezione, e in tal caso di estrarlo invece di scrivere la
// terza copia. **Non la disinnesca**: quella funzione cita e basta — mette fra
// apici ciò che contiene `,` `;` `"` o un a capo, raddoppia gli apici, e su una
// cella che comincia per `=` non fa niente. Va benissimo per ciò che produce (un
// prestampato di intestazioni fisse e una riga d'esempio scritta da noi), e non
// basta per un elenco che porta NOMI DI MINORI e un'etichetta scritta a mano
// dalla segreteria.
//
// ── L'INIEZIONE CSV, in due righe ───────────────────────────────────────────
//
// Excel, LibreOffice e Fogli Google trattano una cella che comincia per `=`,
// `+`, `-` o `@` come una FORMULA, anche quando arriva da un `.csv`. Un genitore
// che si chiamasse `=cmd|'…'!A1` — o, più realisticamente, una segreteria che
// scrivesse `=Quante persone?` nell'etichetta del contatore — produrrebbe un
// foglio che ESEGUE qualcosa all'apertura, sul computer di chi scarica.
// La cura è antica e stabile: si fa precedere un apice singolo, che i fogli di
// calcolo leggono come «questo è testo» e non mostrano. Il contenuto resta
// leggibile, la formula non parte.
//
// ⚠️ La citazione da sola NON basta: `"=1+1"` fra apici resta una formula per
// Excel. Le due regole sono indipendenti e si applicano ENTRAMBE.
//
// ── PERCHÉ UN MODULO E NON UNA FUNZIONE DENTRO LA ROUTE ─────────────────────
//
// Perché è la seconda strada che ne ha bisogno e la terza sta per nascere, ed è
// la lezione già pagata qui con `@/lib/avvisi/classi-sede`: una regola valida
// per tre strade vive in un posto solo, o le tre copie divergono e la prima che
// diverge è quella che nessuno guarda.
// =============================================================================

/**
 * Il BOM UTF-8, che va in testa al file.
 *
 * Senza, Excel su Windows apre il `.csv` in codifica locale e «Nicolò» diventa
 * «NicolÃ²». Non è un vezzo: è la differenza fra un elenco leggibile e uno da
 * riscrivere a mano.
 */
export const CSV_BOM = '﻿';

/**
 * I caratteri che fanno di una cella una FORMULA, per Excel/LibreOffice/Fogli.
 *
 * 🔴 `\s*` IN TESTA, E NON È UN ORNAMENTO. Fino al 2026-09-19 la regola era
 * `/^[=+\-@]/`, cioè il carattere di formula doveva essere il PRIMO in assoluto.
 * Misurato sul modulo: `'\t=1+1'` usciva come `\t=1+1` — né citato né disinnescato
 * — e `'\r=1+1'` usciva come `"\r=1+1"`, cioè CITATO e non disinnescato, che è il
 * caso peggiore perché ha l'aria di essere stato trattato. I fogli di calcolo
 * scartano la spaziatura iniziale prima di decidere se la cella è una formula: un
 * apice, una tabulazione o un a capo davanti a `=` non disarmano niente, e la
 * riga di commento qui sopra lo dice già per gli apici («la citazione da sola NON
 * basta: `"=1+1"` fra apici resta una formula») — vale identico per `"\r=1+1"`.
 *
 * È RAGGIUNGIBILE OGGI, non in teoria: nomi ed etichetta passano da `.trim()`, ma
 * la colonna **Classe** dell'export delle adesioni no — `classe_sezione` è testo
 * libero digitato in segreteria, e ci arriva così com'è.
 *
 * `\s` in JavaScript copre spazio, `\t`, `\n`, `\r`, `\v`, `\f`, gli spazi
 * unicode e il BOM: si prende la FAMIGLIA, non i tre casi che il collaudo ha
 * pestato. Una cella di sola spaziatura non corrisponde (dopo la spaziatura ci
 * vuole un carattere di formula) e resta quella che era.
 */
const AVVIO_FORMULA = /^\s*[=+\-@]/;

/** I caratteri che obbligano a citare la cella (`;` compreso: è il separatore italiano). */
const DA_CITARE = /[",;\n\r]/;

/**
 * Cita una cella secondo RFC 4180, **senza** disinnescare le formule.
 *
 * Usala solo per i valori che scriviamo NOI e che quindi non possono cominciare
 * per `=`/`+`/`-`/`@` — intestazioni costanti, etichette di colonna fisse.
 * Per qualunque cosa venga da un database o da una persona, `csvCellSicura`.
 */
export function csvCell(v: unknown): string {
    if (v == null) return '';
    const s = String(v);
    return DA_CITARE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Cita **e** disinnesca: la cella per il testo che non abbiamo scritto noi.
 *
 * Nomi di alunni e di genitori, etichette digitate in segreteria, qualunque
 * colonna `text` del database. L'apice iniziale non si vede nel foglio aperto e
 * impedisce che la cella venga valutata.
 */
export function csvCellSicura(v: unknown): string {
    if (v == null) return '';
    const s = String(v);
    const disinnescata = AVVIO_FORMULA.test(s) ? `'${s}` : s;
    return DA_CITARE.test(disinnescata) || disinnescata !== s
        ? `"${disinnescata.replace(/"/g, '""')}"`
        : disinnescata;
}

/**
 * Una riga di CSV, tutte le celle disinnescate.
 *
 * Il default è la forma SICURA di proposito: chi scrive un export nuovo non deve
 * ricordarsi di scegliere: deve ricordarsi di non farlo solo quando è certo che
 * il valore è suo. È l'inverso della disciplina che ha prodotto la prima copia.
 */
export function csvRiga(celle: readonly unknown[]): string {
    return celle.map(csvCellSicura).join(',');
}

/**
 * Il documento intero: BOM, intestazioni, righe. `\r\n` come vuole RFC 4180 —
 * è ciò che Excel si aspetta e l'unica forma che non spezza una cella multiriga
 * su tutti e tre i programmi.
 */
export function csvDocumento(intestazioni: readonly unknown[], righe: readonly (readonly unknown[])[]): string {
    return CSV_BOM + [csvRiga(intestazioni), ...righe.map(csvRiga)].join('\r\n') + '\r\n';
}
