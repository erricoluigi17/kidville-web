import { cx } from '@/lib/ui/cx'

interface AvatarProps {
  /** nome completo: usato per le iniziali e come alt dell'immagine. */
  name?: string
  /** URL immagine; in assenza mostra le iniziali su sfondo `color`. */
  src?: string
  /** lato in px (quadrato, cerchio). */
  size?: number
  /** tinta di sfondo per la variante iniziali (es. tinta grado/materia). */
  color?: string
  className?: string
}

function initials(name?: string): string {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

/** Avatar circolare: immagine se presente, altrimenti iniziali su tinta. */
export function Avatar({ name, src, size = 40, color = '#006A5F', className }: AvatarProps) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? ''}
        width={size}
        height={size}
        className={cx('rounded-full object-cover', className)}
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      aria-hidden={!name}
      className={cx(
        'inline-flex flex-shrink-0 items-center justify-center rounded-full font-barlow font-extrabold uppercase text-kidville-white',
        className,
      )}
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  )
}
