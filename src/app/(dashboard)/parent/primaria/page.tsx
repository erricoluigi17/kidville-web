'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckSquare, FileText, BarChart3, BookOpen, CalendarDays, ChevronRight } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';

const SEZIONI = [
  { href: '/parent/lezioni', labelKey: 'hubLezioni', subKey: 'hubLezioniSub', icon: BookOpen, bg: 'bg-kidville-info-soft', fg: 'text-kidville-info' },
  { href: '/parent/primaria/orario', labelKey: 'hubOrario', subKey: 'hubOrarioSub', icon: CalendarDays, bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
  { href: '/parent/primaria/valutazioni', labelKey: 'hubValutazioni', subKey: 'hubValutazioniSub', icon: BarChart3, bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
  { href: '/parent/primaria/note', labelKey: 'hubNote', subKey: 'hubNoteSub', icon: AlertTriangle, bg: 'bg-kidville-warn-soft', fg: 'text-kidville-warn' },
  { href: '/parent/primaria/assenze', labelKey: 'hubPresenze', subKey: 'hubPresenzeSub', icon: CheckSquare, bg: 'bg-kidville-yellow-soft', fg: 'text-kidville-yellow-dark' },
  { href: '/parent/primaria/pagelle', labelKey: 'hubPagelle', subKey: 'hubPagelleSub', icon: FileText, bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' },
] as const;

export default function PrimariahubPage() {
  const t = useTranslations('parentPrimaria');
  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow={t('eyebrow')}
        title={t('hubTitolo')}
        className="mb-5"
      />

      <div className="space-y-3">
        {SEZIONI.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.href} href={s.href}>
              <div className="flex items-center gap-4 rounded-card border border-kidville-line bg-white p-4 shadow-sm active:scale-[0.98] transition-transform">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${s.bg} ${s.fg}`}>
                  <Icon size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{t(s.labelKey)}</p>
                  <p className="font-maven text-xs text-kidville-muted">{t(s.subKey)}</p>
                </div>
                <ChevronRight size={18} className="text-kidville-muted/60 flex-shrink-0" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
