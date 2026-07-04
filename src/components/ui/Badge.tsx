import { cx } from '@/lib/ui/cx'

export type BadgeTone =
  | 'unread'
  | 'info'
  | 'read'
  | 'success'
  | 'warn'
  | 'error'
  | 'neutral'

const TONES: Record<BadgeTone, string> = {
  unread: 'bg-kidville-yellow text-kidville-green',
  info: 'bg-kidville-green-soft text-kidville-green',
  read: 'bg-kidville-neutral-soft text-kidville-muted',
  success: 'bg-kidville-success-soft text-kidville-success',
  warn: 'bg-kidville-warn-soft text-kidville-warn',
  error: 'bg-kidville-error-soft text-kidville-error',
  neutral: 'bg-kidville-neutral-soft text-kidville-neutral',
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
