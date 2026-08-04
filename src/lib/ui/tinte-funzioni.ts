/**
 * TINTE DELLE FUNZIONI — una funzione, un colore, per chiunque guardi.
 *
 * ── IL RILIEVO (collaudo 2026-08-03, T08-F2) ────────────────────────────────
 * Fra la bottom-nav del genitore e quella del docente **non una sola voce omologa**
 * condivideva la tinta: 11 su 11 divergevano. La mensa era verde per il genitore e
 * arancione per il docente, le foto rosa di qua e verdi di là, il diario verde di qua
 * e blu di là. Un genitore che è anche docente — caso reale in una scuola — vedeva due
 * mappe cromatiche in conflitto per le stesse funzioni. Sei tinte su tutte non
 * corrispondevano a **nessun** token dichiarato: `#1F8A5B`, `#475569`, `#7A3FD0`,
 * `#7C8A84`, `#C9971A`, `#D14D8A`.
 *
 * ── È UN DIFETTO O UNA SCELTA? La verifica, prima di uniformare ─────────────
 * Prima di toccare qualcosa ho cercato se il design system PREVEDA palette diverse per
 * ruolo. Non le prevede, e i documenti lo dicono in modo esplicito:
 *  · `design.md` (il documento di design del repo) descrive UNA palette sola — verde
 *    di brand, giallo, crema — e non nomina mai il ruolo di chi guarda;
 *  · `globals.css` dichiara le tinte non di tema sotto l'intestazione
 *    «Tinte per-dato (NON token tema): gradi scolastici e materie … sono scelte
 *    **da dato**, non classi statiche». Per DATO, cioè per la cosa mostrata — non per
 *    ruolo di chi la guarda. Una tinta per-ruolo non esiste in nessun documento.
 * Quindi la divergenza non è una scelta di design: è il sistema di tinte per-dato che
 * non è mai stato applicato. La causa radice è raggiungibile: quelle tinte vivono in
 * `globals.css` come variabili CSS che **di proposito non generano utility Tailwind**,
 * e non esisteva nessuna mappa TS che le esponesse ai componenti. Il posto giusto dove
 * prenderle non era raggiungibile dal codice, e ogni navigazione se le è riscritte a
 * mano. Prova: `--kv-subj-*` era letto da UN SOLO file e `--kv-grade-*` da NESSUNO.
 *
 * ── PERCHÉ HEX E NON `var(--kv-…)` ──────────────────────────────────────────
 * Stessa ragione, e stessa forma, di `src/lib/ui/chart-colors.ts`: questi valori
 * finiscono in `style={{ background: tinta + '18' }}`, cioè in una CONCATENAZIONE che
 * costruisce un colore con alfa. Su una base `var(--x)` la concatenazione produce
 * `var(--x)18`, che non è un colore e viene scartata — è la lezione «hex→var mai su
 * base-di-concat-alpha» già pagata su questo repo. Questo modulo è dunque uno
 * **SPECCHIO** dichiarato delle variabili di `globals.css`: ogni valore qui sotto è
 * copiato da lì, e il lock `__tests__/architecture/tinte-funzioni-uniche.test.ts`
 * fallisce se uno dei due lati cambia senza l'altro.
 */

/** Le variabili di `globals.css` di cui questo file è lo specchio. */
export const TINTE_SORGENTE = {
  'kv-grade-infanzia': '#006A5F',
  'kv-grade-primaria': '#E6720A',
  'kv-subj-italiano': '#2A6FDB',
  'kv-subj-storia': '#B5651D',
  'kv-subj-geografia': '#0E9488',
  'kv-subj-scienze': '#43A047',
  'kv-subj-arte': '#E5468A',
  'kv-subj-musica': '#7C5CE6',
  'kv-subj-religione': '#C79A00',
  'kv-subj-mensa': '#006A5F',
  'color-kidville-sub': '#55615C',
} as const

/**
 * Tinta CANONICA di ogni funzione del prodotto, valida per TUTTI i ruoli.
 * La chiave è l'`id` della voce di navigazione; gli alias (le stesse funzioni con un
 * nome diverso nella nav del docente) stanno in `ALIAS_FUNZIONE`.
 */
export const TINTA_FUNZIONE = {
  diario: TINTE_SORGENTE['kv-grade-infanzia'],
  presenze: TINTE_SORGENTE['kv-grade-primaria'],
  foto: TINTE_SORGENTE['kv-subj-arte'],
  registro: TINTE_SORGENTE['kv-subj-italiano'],
  lezioni: TINTE_SORGENTE['kv-subj-geografia'],
  compiti: TINTE_SORGENTE['kv-grade-primaria'],
  note: TINTE_SORGENTE['kv-subj-storia'],
  pagelle: TINTE_SORGENTE['kv-subj-italiano'],
  mensa: TINTE_SORGENTE['kv-subj-mensa'],
  armadietto: TINTE_SORGENTE['kv-subj-religione'],
  pagamenti: TINTE_SORGENTE['kv-subj-musica'],
  avvisi: TINTE_SORGENTE['kv-grade-infanzia'],
  news: TINTE_SORGENTE['kv-subj-arte'],
  chat: TINTE_SORGENTE['kv-subj-italiano'],
  modulistica: TINTE_SORGENTE['kv-subj-storia'],
  profilo: TINTE_SORGENTE['color-kidville-sub'],
  calendario: TINTE_SORGENTE['kv-subj-italiano'],
  attivita: TINTE_SORGENTE['kv-subj-scienze'],
} as const

export type IdFunzione = keyof typeof TINTA_FUNZIONE

/**
 * Le voci che nella nav del docente hanno un nome diverso ma sono la STESSA funzione.
 * `appello` e `presenze` del docente puntano entrambe a `/teacher/attendance`: sono la
 * stessa cosa elencata due volte, e devono avere la stessa tinta.
 */
export const ALIAS_FUNZIONE: Record<string, IdFunzione> = {
  appello: 'presenze',
  bacheca: 'avvisi',
  messaggi: 'chat',
  moduli: 'modulistica',
}

/** Tinta di una voce di navigazione, alias risolti. */
export function tintaFunzione(id: string): string {
  const canonico = (ALIAS_FUNZIONE[id] ?? id) as IdFunzione
  return TINTA_FUNZIONE[canonico]
}
