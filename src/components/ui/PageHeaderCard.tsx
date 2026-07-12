import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { TAB_GIALLO_OVUNQUE } from '@/lib/ui/tab-theme';
import { HeroMascot } from '@/components/features/shell/HeroMascot';

interface PageHeaderCardProps {
  eyebrow: string;
  /** Testo dell'`<h1>`: diverse stringhe sono asserite dagli e2e (getByRole
   *  heading), quindi il chiamante deve passare il titolo esistente invariato. */
  title: string;
  /** Conteggi/pill accanto al titolo: resi FUORI dall'`<h1>` (gli e2e usano
   *  `exact: true` sull'accessible name, un badge dentro l'h1 lo cambierebbe). */
  badge?: React.ReactNode;
  icon?: LucideIcon;
  subtitle?: React.ReactNode;
  /** Colonna destra: pill gialla azione, icon button `bg-white/15`, chip alunno… */
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Card-header di pagina per docente E genitore (estratta dalle pagine docente
 * dove era copia-incollata). Stile base: verde del design (DR "Header verde"),
 * eyebrow gialla e titolo bianco Barlow 900. Con TAB_GIALLO_OVUNQUE (TEST
 * reversibile, vedi src/lib/ui/tab-theme.ts) adotta il prototipo "tab gialla":
 * fondo giallo, testi verdi e mascotte a mezzo busto — la mascotte solo senza
 * slot `action`, che occupa lo stesso angolo. I contenuti dei chiamanti pensati
 * per il verde (text-white, bg-white/15, pill gialle) sono rimappati da
 * globals.css sotto `.kv-tab-giallo`. Il back NON vive qui: è nella AppBar.
 */
export function PageHeaderCard({
  eyebrow,
  title,
  badge,
  icon: Icon,
  subtitle,
  action,
  className,
  children,
}: PageHeaderCardProps) {
  const giallo = TAB_GIALLO_OVUNQUE;
  const mascotte = giallo && !action;

  return (
    <header
      className={cx(
        'kv-header-card rounded-3xl px-5 py-5',
        giallo ? 'kv-tab-giallo relative bg-kidville-yellow' : 'bg-kidville-green',
        className,
      )}
      style={{
        boxShadow: giallo
          ? '0 14px 30px -16px rgba(230,177,0,.7)'
          : '0 16px 34px -18px rgba(0,60,52,.6)',
      }}
    >
      <div
        className={cx('flex items-start justify-between gap-3', mascotte && 'relative z-[2]')}
        style={mascotte ? { paddingRight: 96 } : undefined}
      >
        <div className="min-w-0">
          <p
            className={cx(
              'font-barlow text-[11px] font-bold uppercase tracking-[0.14em]',
              giallo ? 'text-kidville-green-dark' : 'text-kidville-yellow',
            )}
          >
            {eyebrow}
          </p>
          <div className="flex items-center gap-2">
            {Icon && (
              <Icon
                size={26}
                strokeWidth={2}
                className={cx('shrink-0', giallo ? 'text-kidville-green-dark' : 'text-kidville-yellow')}
              />
            )}
            <h1
              className={cx(
                'font-barlow text-3xl font-black uppercase tracking-wide',
                giallo ? 'text-kidville-green' : 'text-white',
              )}
            >
              {title}
            </h1>
            {badge}
          </div>
          {subtitle && (
            <div
              className={cx(
                'mt-1.5 font-maven text-xs',
                giallo ? 'text-kidville-green-dark/80' : 'text-white/80',
              )}
            >
              {subtitle}
            </div>
          )}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      {children && mascotte ? <div className="relative z-[2]">{children}</div> : children}
      {mascotte && <HeroMascot width={92} height={112} insetRight={14} radius={24} />}
    </header>
  );
}
