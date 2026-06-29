import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cx } from '@/lib/ui/cx'

interface SectionHeaderProps {
  eyebrow?: string
  title: string
  actionLabel?: string
  actionHref?: string
  className?: string
}

/** Intestazione di sezione del design (DR `Section`): eyebrow + titolo + link azione. */
export function SectionHeader({ eyebrow, title, actionLabel, actionHref, className }: SectionHeaderProps) {
  return (
    <div className={cx('mb-3 flex items-end justify-between gap-3 px-1', className)}>
      <div className="min-w-0">
        {eyebrow && (
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow-dark">
            {eyebrow}
          </p>
        )}
        <h2 className="font-barlow text-lg font-black uppercase leading-none tracking-wide text-kidville-green">
          {title}
        </h2>
      </div>
      {actionLabel && actionHref && (
        <Link
          href={actionHref}
          className="flex items-center gap-0.5 whitespace-nowrap font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-green"
        >
          {actionLabel}
          <ChevronRight size={14} />
        </Link>
      )}
    </div>
  )
}
