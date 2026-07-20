import { cx } from '@/lib/ui/cx'

export type BadgeTone =
  | 'unread'
  | 'info'
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
  info: 'bg-kidville-green-soft text-kidville-green',
  read: 'bg-kidville-neutral-soft text-kidville-muted',
  success: 'bg-kidville-success-soft text-kidville-success-strong',
  warn: 'bg-kidville-warn-soft text-kidville-warn-strong',
  error: 'bg-kidville-error-soft text-kidville-error-strong',
  neutral: 'bg-kidville-neutral-soft text-kidville-sub',
}

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone
}

/** Badge/pill di stato del design (DR `.kv-badge`). */
export function Badge({ tone = 'info', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-[5px] whitespace-nowrap rounded-pill px-[11px] py-1 font-barlow text-[11.5px] font-extrabold uppercase leading-[1.35] tracking-[0.06em]',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}
