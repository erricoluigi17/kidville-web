'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeft, ClipboardList, CheckSquare, Star, AlertTriangle, CalendarDays, BarChart3 } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

const NAV = [
  { seg: 'registro', label: 'Registro', icon: ClipboardList },
  { seg: 'appello', label: 'Appello', icon: CheckSquare },
  { seg: 'valutazioni', label: 'Valutazioni', icon: Star },
  { seg: 'note', label: 'Note', icon: AlertTriangle },
  { seg: 'orario', label: 'Orario', icon: CalendarDays },
  { seg: 'prospetto', label: 'Prospetto', icon: BarChart3 },
];

export default function PrimariaClasseLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const search = useSearchParams();
  const pathname = usePathname();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [nomeClasse, setNomeClasse] = useState('');

  useEffect(() => {
    if (!sectionId) return;
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data.section) setNomeClasse(d.data.section.name);
      })
      .catch(() => {});
  }, [sectionId, userId]);

  const base = `/teacher/primaria/${sectionId}`;
  const suffix = `?userId=${userId}`;

  return (
    <div className="min-h-screen bg-kidville-cream/40">
      <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/95 backdrop-blur">
        <div className="max-w-5xl mx-auto px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href={`/teacher/primaria${suffix}`} className="text-gray-400 hover:text-kidville-green">
              <ArrowLeft size={20} />
            </Link>
            <h1 className="font-barlow text-2xl font-bold text-kidville-green uppercase tracking-wide">
              {nomeClasse || 'Classe'}
            </h1>
            <span className="rounded-pill bg-kidville-green/10 px-2.5 py-0.5 text-[11px] font-maven text-kidville-green">
              Primaria
            </span>
          </div>
          <nav className="mt-3 flex gap-1 overflow-x-auto pb-1">
            {NAV.map(({ seg, label, icon: Icon }) => {
              const href = `${base}/${seg}${suffix}`;
              const active = pathname === `${base}/${seg}`;
              return (
                <Link
                  key={seg}
                  href={href}
                  className={`font-maven inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-sm transition ${
                    active ? 'bg-kidville-green text-kidville-yellow' : 'text-gray-500 hover:bg-kidville-green/10'
                  }`}
                >
                  <Icon size={14} />
                  {label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-5">{children}</main>
    </div>
  );
}
