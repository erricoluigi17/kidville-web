/**
 * IL BLOCCO DI CAMPO DI «COMUNICA UN'ASSENZA» — etichetta e controllo, in un
 * posto solo.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Il ciclo del 2026-08-08 ha allineato i due CAMPI delle schermate gemelle
 * (`/parent/attendance` e la card di `/parent/primaria/assenze`): stesso raggio,
 * stesso padding, stessa altezza, stesso corpo — misurati con `getComputedStyle`
 * e identici. Ha allineato il campo e **non la sua etichetta**, che il collaudo
 * successivo ha ritrovato divergente:
 *
 *   `/parent/attendance`  → Maven Pro 16px, peso 500, verde  #006A5F
 *   `ComunicaAssenzaCard` → Maven Pro 12px, peso 600, ink    #1F3D38
 *
 * cioè −25% di corpo e un inchiostro diverso, sulle stesse parole, sopra due
 * campi identici. È lo schema che questo ciclo ha già pagato tre volte: si
 * corregge il nodo che il rilievo NOMINA (l'input) invece della regola che lo
 * governa (il blocco: etichetta, aiuto, controllo).
 *
 * Le due schermate non possono condividere il componente JSX senza riscriverne
 * la struttura — una monta un `<form>`, l'altra una card apribile, e le due
 * hanno spaziature e `id` diversi — ma possono, e devono, condividere la
 * DECISIONE tipografica. Da qui in poi la si cambia in un posto e cambia in
 * entrambe; e un lock (`assenze-due-schermate-coerenti`) verifica che le
 * etichette omonime portino le stesse classi.
 *
 * Lo spazio attorno resta al punto d'uso (`mb-2` nel form, `gap-1` nella
 * colonna della card): è layout della schermata, non tipografia del campo.
 */

/**
 * L'ETICHETTA di un campo del modulo.
 *
 * `text-kidville-green` su bianco vale 6,51:1 e su crema 5,86:1: è la scelta
 * della schermata gemella, ed è quella che regge su entrambe le superfici. Il
 * corpo è quello di base (16px) e non `text-xs`: un'etichetta più piccola del
 * valore che descrive è il difetto misurato sulla card.
 */
export const ETICHETTA_CAMPO_ASSENZA = 'block font-maven font-medium text-kidville-green';

/**
 * IL CONTROLLO — `<input type="date">` e `<textarea>` del motivo.
 *
 * ⚠️ `bg-kidville-white text-kidville-ink` NON è ridondanza, ed è la causa
 * radice di un bloccante già pagato: senza inchiostro DICHIARATO il campo lo
 * eredita da `body { color: var(--color-kidville-green) }`, e con l'Alto
 * Contrasto acceso `[data-contrast="high"] body` ribalta l'inchiostro EREDITATO
 * a #FFFFFF mentre la superficie — utility nata da `@theme inline`, hex inlinato
 * — resta bianca: 1:1, campo illeggibile per chi quella modalità la usa.
 *
 * `placeholder-kidville-sub`: senza, il segnaposto lo dipinge l'agente utente
 * con `currentColor` al 50% di alfa (2,79:1 misurati in Chrome). Un segnaposto è
 * TESTO, e 1.4.3 si applica.
 *
 * `rounded-input` e non `rounded-full`: la pillola è la forma dei PULSANTI
 * (`design.md`); su un campo dati dice «premimi».
 *
 * Lock: `__tests__/a11y/contrasto-campi-assenza.test.tsx` e
 * `__tests__/components/assenze-due-schermate-coerenti.test.tsx`.
 */
export const CAMPO_ASSENZA =
  'w-full rounded-input border border-kidville-line bg-kidville-white p-3 font-maven text-base ' +
  'text-kidville-ink placeholder-kidville-sub focus:border-kidville-green focus:outline-none ' +
  'focus:ring-1 focus:ring-kidville-green';
