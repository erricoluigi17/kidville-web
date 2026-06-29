import { cx } from '@/lib/ui/cx'

export type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type BtnSize = 'sm' | 'md' | 'lg'

const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill font-barlow font-extrabold uppercase tracking-[0.05em] transition-transform active:scale-95 disabled:opacity-45 disabled:pointer-events-none'

const SIZES: Record<BtnSize, string> = {
  sm: 'h-9 px-4 text-[13px]',
  md: 'h-[46px] px-6 text-[15.5px]',
  lg: 'h-[54px] px-[30px] text-[17px]',
}

const VARIANTS: Record<BtnVariant, string> = {
  primary: 'bg-kidville-green text-kidville-yellow hover:bg-kidville-green-dark',
  secondary: 'bg-kidville-yellow text-kidville-green hover:bg-kidville-yellow-dark',
  ghost: 'bg-kidville-green-soft text-kidville-green',
  danger: 'bg-kidville-error-soft text-kidville-error',
}

/**
 * Classi del bottone-pillola del design (DR `.kv-btn`). Esportato a parte così
 * sia `<button>` che un `<Link>` Next possono condividere lo stesso stile.
 */
export function btnClass(variant: BtnVariant = 'primary', size: BtnSize = 'md', extra?: string) {
  return cx(BASE, SIZES[size], VARIANTS[variant], extra)
}

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: BtnSize
}

/** Bottone-pillola Kidville. Per i link usare `btnClass()` su `<Link>`. */
export function Btn({ variant = 'primary', size = 'md', className, type = 'button', ...rest }: BtnProps) {
  return <button type={type} className={btnClass(variant, size, className)} {...rest} />
}
