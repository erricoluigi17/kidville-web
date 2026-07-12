'use client';

import Link from 'next/link';
import { AlertTriangle, CheckSquare, FileText, BarChart3, BookOpen, CalendarDays, ChevronRight } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';

const SEZIONI = [
  { href: '/parent/lezioni', label: 'Lezioni', sub: 'Argomenti e compiti', icon: BookOpen, bg: 'bg-kidville-info-soft', fg: 'text-kidville-info' },
  { href: '/parent/primaria/orario', label: 'Orario', sub: 'Orario settimanale della classe', icon: CalendarDays, bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
  { href: '/parent/primaria/valutazioni', label: 'Valutazioni', sub: 'Giudizi per materia', icon: BarChart3, bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
  { href: '/parent/primaria/note', label: 'Note', sub: 'Note disciplinari e didattiche', icon: AlertTriangle, bg: 'bg-kidville-warn-soft', fg: 'text-kidville-warn' },
  { href: '/parent/primaria/assenze', label: 'Presenze', sub: 'Assenze, ritardi e giustifiche', icon: CheckSquare, bg: 'bg-kidville-yellow-soft', fg: 'text-kidville-yellow-dark' },
  { href: '/parent/primaria/pagelle', label: 'Pagelle', sub: 'Scarica e firma le pagelle', icon: FileText, bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' },
] as const;

export default function PrimariahubPage() {
  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow="Didattica · Primaria"
        title="Scuola Primaria"
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
                  <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{s.label}</p>
                  <p className="font-maven text-xs text-kidville-muted">{s.sub}</p>
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
