import { cx } from '@/lib/ui/cx'

export type BadgeTone =
  | 'unread'
  | 'evidenza'
  | 'info'
  | 'inCorso'
  | 'read'
  | 'success'
  | 'warn'
  | 'error'
  | 'neutral'

// Toni informativi (success/warn/error/neutral): il testo usa le varianti
// `-strong`/`-sub` per reggere il contrasto AA (≥4,5:1) sui fondi soft — i pieni
// (#43A047/#E6720A/#E53935 su soft ≈2,7–3,7:1) erano sotto soglia (ciclo 1, RC5).
// `unread`/`info`/`read` restano INVARIATI (già conformi o decorativi voluti).
const TONES: Record<BadgeTone, string> = {
  unread: 'bg-kidville-yellow text-kidville-green',
  // Testo informativo su giallo: verde-su-giallo sta a 4,05:1 (sotto AA per testo
  // normale) → per etichette testuali (es. «In evidenza» nelle News) si usa ink (~8:1).
  evidenza: 'bg-kidville-yellow text-kidville-ink',
  info: 'bg-kidville-green-soft text-kidville-green',
  // `inCorso` — la coppia semantica `info-soft`/`info-strong`, che al catalogo dei
  // toni mancava: `info` qui sopra è VERDE (green-soft), cioè lo stesso colore di
  // «fatto». Un badge «in approvazione» verde accanto a uno «approvata» verde sono
  // due stati diversi con la stessa faccia. Il blu di `--color-kidville-info-*` è
  // dichiarato in `globals.css` con i suoi rapporti di contrasto (6,7:1 su soft) e
  // regge l'Alto Contrasto; passarlo da fuori con `className` NON funzionava: `cx`
  // concatena, ma fra due utility di pari specificità decide l'ordine nel FOGLIO di
  // stile, non quello nell'attributo — cioè il colore sarebbe stato una lotteria.
  inCorso: 'bg-kidville-info-soft text-kidville-info-strong',
  read: 'bg-kidville-neutral-soft text-kidville-muted',
  success: 'bg-kidville-success-soft text-kidville-success-strong',
  warn: 'bg-kidville-warn-soft text-kidville-warn-strong',
  error: 'bg-kidville-error-soft text-kidville-error-strong',
  neutral: 'bg-kidville-neutral-soft text-kidville-sub',
}

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
  /** Il testo può andare a capo: vedi `A_CAPO`. Default `false`, cioè la pillola di sempre. */
  aCapo?: boolean
}

/** Il Badge di sempre: una riga, pillola. */
const UNA_RIGA =
  'inline-flex items-center gap-[5px] whitespace-nowrap rounded-pill px-[11px] py-1 font-barlow text-[11.5px] font-extrabold uppercase leading-[1.35] tracking-[0.06em]'

/**
 * `aCapo` (2026-09-28) — per le FRASI dentro un badge («Paga il fratello Mario Rossi (Sez. C)
 * · Non generata», 355 px col font vero, contro ~251 px di card a 360 px di schermo). Con
 * `whitespace-nowrap` un testo così schiacciava il nome accanto e faceva scorrere la pagina in
 * orizzontale.
 *
 * È una PROP e non un `className="whitespace-normal"` per la stessa ragione di `inCorso` qui
 * sopra: `cx` concatena, e fra `whitespace-nowrap` e `whitespace-normal` avrebbe vinto quella
 * che il foglio di stile dichiara per ULTIMA, non quella scritta dopo nell'attributo. Qui
 * `whitespace-normal` SOSTITUISCE `whitespace-nowrap`: nell'elemento ce n'è una sola.
 *
 * Il resto segue: `text-left` (una frase su due righe non si centra), `max-w-full` (non più
 * largo del contenitore), `[overflow-wrap:anywhere]` (un cognome lunghissimo va a capo anche a
 * metà parola invece di sfondare), e un raggio fisso al posto di `rounded-pill` — su due righe
 * il 9999px arrotonda fino a mangiare gli angoli del testo, mentre su una riga `rounded-xl`
 * resta una pillola a vista.
 *
 * `anywhere` e NON `break-words` (seconda revisione 2026-09-28, K3): `break-words` è
 * `overflow-wrap: break-word`, che spezza la parola solo DOPO che la larghezza è decisa e non
 * abbassa la larghezza minima del contenuto. In un `inline-flex` il testo è un elemento flex
 * che non scende sotto quella larghezza minima: misurato, una parola di 80 caratteri a 360 px
 * faceva un badge di 517 px, fuori dalla card. `anywhere` abbassa anche la larghezza minima.
 * Il rovescio: in una TABELLA la colonna può allora stringersi fino a una lettera — lì chi usa
 * il badge gli dà una larghezza minima (vedi `BadgeRettaACarico`, `inTabella`).
 */
const A_CAPO =
  'inline-flex max-w-full items-center gap-[5px] whitespace-normal [overflow-wrap:anywhere] rounded-xl px-[11px] py-1 text-left font-barlow text-[11.5px] font-extrabold uppercase leading-[1.35] tracking-[0.06em]'

/**
 * Le classi del Badge, per chi deve dare la stessa faccia a un elemento che non è uno
 * `span` — il collegamento «Errore in coda» di `FatturaChip` (consegna 2b, D7), che non
 * può annidare uno `span` dentro l'`a` e restare un bersaglio solo.
 */
export function classiBadge(tone: BadgeTone = 'info', className?: string, opzioni?: { aCapo?: boolean }): string {
  return cx(opzioni?.aCapo ? A_CAPO : UNA_RIGA, TONES[tone], className)
}

/** Badge/pill di stato del design (DR `.kv-badge`). */
export function Badge({ tone = 'info', aCapo = false, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={classiBadge(tone, className, { aCapo })}
      {...rest}
    >
      {children}
    </span>
  )
}
