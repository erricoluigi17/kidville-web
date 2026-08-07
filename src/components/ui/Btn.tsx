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

/**
 * Riempimento di BRAND invariato (verde #006A5F / giallo #FDC400), inchiostro
 * che quel riempimento regge davvero. La coppia storica giallo-su-verde vale
 * 4,05:1 in ENTRAMBI i versi (il contrasto è simmetrico) e nessuna delle tre
 * taglie qui sopra arriva ai 18,66px del «testo grande»: la soglia applicabile
 * è 4,5:1, non 3:1. Con gli inchiostri di brand (`*-ink`, definiti in
 * globals.css) si passa a 4,78:1 e 6,35:1, hover compresi.
 * `danger` usa `error-strong`: `error` su `error-soft` è 3,70:1 — stessa storia.
 * Misure e lock: `__tests__/a11y/contrasto-cascata.test.tsx` (§2).
 *
 * ─── IL CONTORNO DELLE DUE VARIANTI «SOFT» (2026-08-07, WCAG 1.4.11) ────────
 * `ghost` e `danger` erano definite come sola coppia testo/fondo. L'inchiostro
 * era a norma; la SUPERFICIE no. Misurata in pagina, la pillola di `danger`
 * posata sulla riga crema dell'elenco «Assenze già comunicate» vale
 *   error-soft #FDECEC su cream #FEF1E4 = 1,03:1
 * (su bianco 1,14:1; `ghost` su crema 1,07:1). Senza bordo né ombra, di quello
 * che è l'UNICO comando distruttivo della schermata restava la sola scritta
 * rossa: nessun segnale che fosse un bottone. WCAG 1.4.11 chiede 3:1 al confine
 * di un controllo privo di altri indicatori visivi.
 *
 * Il rimedio sta QUI e non nella pagina: `variant="danger"` non era mai stato
 * usato in tutto il repo prima del ciclo 1, e lo si è inaugurato sul fondo
 * peggiore — cioè il difetto era della famiglia, non della riga.
 *
 * ⚠️ Il `border-kidville-error/40` proposto dal rapporto di collaudo («≈3:1») è
 * stato MISURATO e scartato: composto sulla crema vale **1,74:1**. Un'alfa su un
 * rosso chiaro consuma quasi tutto il contorno. I bordi qui sotto sono i token
 * PIENI, misurati sulle due superfici su cui questi bottoni vivono davvero:
 *   · `error` #E53935 → 4,23:1 su bianco · 3,81:1 su crema · 3,70:1 sul proprio fondo
 *   · `green` #006A5F → 6,51:1 su bianco · 5,86:1 su crema · 5,48:1 sul proprio fondo
 * Il RIEMPIMENTO e l'INCHIOSTRO non cambiano: cambia solo il fatto che adesso si
 * vede dove comincia il bottone. Lock:
 * `__tests__/a11y/contrasto-schermate-assenza.test.tsx` (§2).
 */
const VARIANTS: Record<BtnVariant, string> = {
  primary: 'bg-kidville-green text-kidville-yellow-ink hover:bg-kidville-green-dark',
  secondary: 'bg-kidville-yellow text-kidville-green-ink hover:bg-kidville-yellow-dark',
  ghost: 'border border-kidville-green bg-kidville-green-soft text-kidville-green',
  danger: 'border border-kidville-error bg-kidville-error-soft text-kidville-error-strong',
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
