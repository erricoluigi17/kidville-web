/**
 * MIRROR documentato dei token colore di `globals.css` (`@theme inline`), in
 * valori hex letterali.
 *
 * È l'UNICO file del perimetro cockpit dove gli hex sono ammessi: il lock
 * `__tests__/architecture/design-tokens-admin.test.ts` esclude esplicitamente
 * questo modulo. Serve nei contesti dove `var(--color-kidville-*)` NON è
 * affidabile — gli attributi SVG di Recharts (`stroke`/`fill`), i `<circle>`
 * del Donut, gli inline-style delle medaglie — perché lì il valore finisce
 * come attributo di presentazione e la risoluzione della CSS custom property
 * non è garantita (lezione «hex→var mai su base-di-concat-alpha»).
 *
 * ⚠️ NON è una fonte di verità alternativa: è uno SPECCHIO. Se un token cambia
 * in `globals.css`, va aggiornato QUI in parallelo. In alto contrasto
 * (`[data-contrast="high"]`) questi valori NON seguono il remap dei token:
 * usarli solo dove la superficie è comunque coperta da regole dedicate o dove
 * il colore è un "data color" (grafico/medaglia) non legato al tema.
 */

/** Brand — specchio di `--color-kidville-{green,green-dark,yellow,cream,white}`. */
export const BRAND = {
  green: '#006A5F',
  greenDark: '#00544B',
  yellow: '#FDC400',
  cream: '#FEF1E4',
  white: '#FFFFFF',
} as const;

/**
 * Toni semantici — specchio di `--color-kidville-{green,info,warn,error,success,
 * neutral,yellow}`. Le chiavi coincidono con il tipo `Tone` di `cockpit.tsx`
 * (mantenerle allineate): il Donut mappa `tone` → colore da qui.
 */
export const TONE_HEX = {
  green: '#006A5F',
  info: '#2A6FDB',
  warn: '#E6720A',
  error: '#E53935',
  success: '#43A047',
  neutral: '#8A958F',
  yellow: '#FDC400',
} as const;

/** Traccia scarica di anelli/barre (il vecchio track inline del Donut). */
export const TRACK = '#EEF1EE';

/** Assi, griglia e bordo-tooltip dei grafici Recharts: grigi neutri, non-brand. */
export const CHART_AXIS = '#9ca3af';
export const CHART_GRID = '#eef0ee';
export const CHART_TOOLTIP_BORDER = '#eee';

/**
 * Palette categorica dei grafici (brand + accenti tenui coordinati): usata da
 * `DashboardCharts` per le serie multiple. Non è legata al tema (data colors).
 */
export const CHART_PALETTE = [
  '#006A5F', // brand green
  '#FDC400', // brand yellow
  '#43A047', // success
  '#2A9D8F', // teal
  '#E9C46A', // sand
  '#94D2BD', // mint
  '#83C5BE', // sea
] as const;

/**
 * Colori del podio graduatorie (oro/argento/bronzo): "data colors" del ranking,
 * non token di tema. Usati dalle medaglie di `forms/rankings/RankingTable`.
 */
export const MEDAL = {
  gold: { color: '#FBBF24', glow: 'rgba(230,114,10,0.35)', bg: 'rgba(230,114,10,0.08)' },
  silver: { color: '#94A3B8', glow: 'rgba(148,163,184,0.25)', bg: 'rgba(148,163,184,0.06)' },
  bronze: { color: '#D97706', glow: 'rgba(217,119,6,0.25)', bg: 'rgba(217,119,6,0.06)' },
} as const;
