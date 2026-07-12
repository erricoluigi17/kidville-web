import type { LucideIcon } from 'lucide-react';
import { cx } from '@/lib/ui/cx';

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
 * Card-header verde del design (DR "Header verde"): eyebrow gialla, titolo
 * bianco Barlow 900, sottotitolo e slot azione. Estratta dalle pagine docente
 * dove era copia-incollata; unico header di pagina per docente E genitore.
 * Il back NON vive qui: è nella AppBar persistente.
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
  return (
    <header
      className={cx('kv-header-card rounded-3xl bg-kidville-green px-5 py-5', className)}
      style={{ boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow">
            {eyebrow}
          </p>
          <div className="flex items-center gap-2">
            {Icon && <Icon size={26} strokeWidth={2} className="shrink-0 text-kidville-yellow" />}
            <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">{title}</h1>
            {badge}
          </div>
          {subtitle && <div className="mt-1.5 font-maven text-xs text-white/80">{subtitle}</div>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      {children}
    </header>
  );
}
