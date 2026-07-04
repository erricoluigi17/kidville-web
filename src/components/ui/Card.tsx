import { cx } from '@/lib/ui/cx'

/** Ombre flat leggerissime del design (DR fondamenta.css). */
export const SHADOW_CARD = '0 1px 2px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)'
export const SHADOW_FLOAT = '0 14px 40px -16px rgba(0,84,75,.35)'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** card cliccabile: leggera elevazione all'hover (usare con onClick/role). */
  tappable?: boolean
  children: React.ReactNode
}

/**
 * Primitive Card del design Kidville: superficie bianca, raggio `--radius-card`,
 * ombra flat. Equivalente di `.kv-card` in DR fondamenta.css.
 */
export function Card({ tappable, className, style, children, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        'bg-kidville-white rounded-card',
        tappable && 'cursor-pointer transition-transform hover:-translate-y-0.5 active:scale-[.99]',
        className,
      )}
      style={{ boxShadow: SHADOW_CARD, ...style }}
      {...rest}
    >
      {children}
    </div>
  )
}
