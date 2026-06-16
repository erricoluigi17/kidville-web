'use client';

import Link from 'next/link';
import { GraduationCap, AlertTriangle, CheckSquare, FileText, BarChart3, BookOpen } from 'lucide-react';

const SEZIONI = [
  { href: '/parent/lezioni', label: 'Lezioni', sub: 'Argomenti e compiti', icon: BookOpen, color: 'bg-blue-50 text-blue-600' },
  { href: '/parent/primaria/valutazioni', label: 'Valutazioni', sub: 'Giudizi per materia', icon: BarChart3, color: 'bg-kidville-green/10 text-kidville-green' },
  { href: '/parent/primaria/note', label: 'Note', sub: 'Note disciplinari e didattiche', icon: AlertTriangle, color: 'bg-amber-50 text-amber-600' },
  { href: '/parent/primaria/assenze', label: 'Presenze', sub: 'Assenze, ritardi e giustifiche', icon: CheckSquare, color: 'bg-purple-50 text-purple-600' },
  { href: '/parent/primaria/pagelle', label: 'Pagelle', sub: 'Scarica e firma le pagelle', icon: FileText, color: 'bg-emerald-50 text-emerald-600' },
] as const;

export default function PrimariahubPage() {
  return (
    <div className="px-4 pt-6 pb-24">
      <div className="mb-5 flex items-center gap-2">
        <GraduationCap className="text-kidville-green" size={22} />
        <h1 className="font-barlow text-xl font-black text-kidville-green uppercase tracking-wide">Scuola Primaria</h1>
      </div>

      <div className="space-y-3">
        {SEZIONI.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.href} href={s.href}>
              <div className="flex items-center gap-4 rounded-2xl bg-white p-4 shadow-sm active:scale-[0.98] transition-transform">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${s.color}`}>
                  <Icon size={22} />
                </div>
                <div>
                  <p className="font-barlow text-base font-bold text-gray-800">{s.label}</p>
                  <p className="font-maven text-xs text-gray-400">{s.sub}</p>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
