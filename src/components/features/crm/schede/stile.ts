/**
 * CRM della segreteria · le classi condivise dalle tre schermate delle schede.
 *
 * La geometria dei controlli è quella della barra dei filtri (`BarraFiltri.tsx`): stessa altezza,
 * stesso raggio, stesso anello. Un modulo che sembra di un'altra applicazione accanto alla barra che
 * lo precede è un difetto che si vede subito e non si spiega.
 *
 * ⚠️ Niente `outline-none`: l'anello `ring-kidville-*` ha l'esadecimale inlinato nel `box-shadow` e in
 * Alto Contrasto resterebbe verde mentre tutto il resto passa al giallo. Togliendo `outline-none`
 * l'anello di sistema (`:focus-visible`) resta sopra. È la stessa scelta, scritta in `BarraFiltri.tsx`.
 */

/** Altezza 44 px: il bersaglio minimo per un dito. */
export const CAMPO =
  'h-11 w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15 disabled:opacity-60'

export const AREA =
  'w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15 disabled:opacity-60'

export const RIQUADRO = 'rounded-card border border-kidville-line bg-kidville-white p-4'

export const TITOLO_SEZIONE = 'font-barlow text-sm font-extrabold uppercase tracking-[0.05em] text-kidville-green'

export const TESTO_SECONDARIO = 'font-maven text-xs text-kidville-sub'

export const MESSAGGIO_ERRORE =
  'rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong'

/** Il collegamento che sembra una pastiglia (WhatsApp, Chiama). */
export const COLLEGAMENTO_PASTIGLIA =
  'inline-flex items-center gap-1 rounded-pill border border-kidville-green bg-kidville-green-soft px-2.5 py-1 font-barlow text-[12px] font-extrabold uppercase tracking-[0.02em] text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-white'
