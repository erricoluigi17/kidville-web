'use client';

// =============================================================================
// ClasseShell — cornice persistente per-classe (header + 8 tab + contenuto).
// Componente UNICO condiviso tra il flusso docente (/teacher/primaria) e il
// cockpit Direzione/Segreteria (/admin/primaria). Riceve solo il PREFISSO di
// base; risolve internamente sectionId da useParams() e costruisce i percorsi.
// =============================================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeft, LayoutGrid, ClipboardList, CheckSquare, Star, AlertTriangle, CalendarDays, BarChart3, GraduationCap, FolderLock, Info } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

// seg '' = indice sezione (Panoramica).
const NAV = [
  { seg: '', label: 'Panoramica', icon: LayoutGrid },
  { seg: 'registro', label: 'Registro', icon: ClipboardList },
  { seg: 'appello', label: 'Appello', icon: CheckSquare },
  { seg: 'valutazioni', label: 'Valutazioni', icon: Star },
  { seg: 'note', label: 'Note', icon: AlertTriangle },
  { seg: 'orario', label: 'Orario', icon: CalendarDays },
  { seg: 'prospetto', label: 'Prospetto', icon: BarChart3 },
  { seg: 'scrutinio', label: 'Scrutinio', icon: GraduationCap },
  { seg: 'fascicolo', label: 'Fascicolo', icon: FolderLock },
];

export function ClasseShell({ basePrefix, children }: { basePrefix: string; children: React.ReactNode }) {
  const params = useParams();
  const search = useSearchParams();
  const pathname = usePathname();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [nomeClasse, setNomeClasse] = useState('');
  const [ruolo, setRuolo] = useState('');

  useEffect(() => {
    if (!sectionId) return;
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data.section) setNomeClasse(d.data.section.name);
      })
      .catch(() => {});
  }, [sectionId, userId]);

  useEffect(() => {
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setRuolo(d.data.ruolo || ''); })
      .catch(() => {});
  }, [userId]);

  // Staff = opera per conto del docente titolare (admin/coordinator/segreteria).
  const isStaff = ruolo === 'admin' || ruolo === 'coordinator' || ruolo === 'segreteria';
  const base = `${basePrefix}/${sectionId}`;
  const suffix = `?userId=${userId}`;

  // Nel cockpit (/admin) la cornice persistente (sidebar desktop / topbar mobile)
  // è fornita da admin/layout: ClasseShell NON deve comportarsi da pagina a sé
  // (niente min-h-screen, niente header sticky a tutto schermo che copre la
  // topbar mobile z-30). Sotto /teacher resta lo shell standalone invariato.
  const inCockpit = basePrefix.startsWith('/admin');

  return (
    <div className={inCockpit ? '' : 'min-h-screen bg-kidville-cream/40'}>
      <header className={`${inCockpit ? 'lg:sticky lg:top-0' : 'sticky top-0'} z-20 bg-kidville-green`}>
        <div className="max-w-5xl mx-auto px-4 pt-3">
          <div className="flex items-center gap-3 pb-3">
            <Link href={`${basePrefix}${suffix}`} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25">
              <ArrowLeft size={18} />
            </Link>
            <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-white">
              {nomeClasse ? `Classe ${nomeClasse}` : 'Classe'}
            </h1>
            <span className="rounded-pill bg-white/15 px-2.5 py-0.5 text-[11px] font-barlow font-bold uppercase tracking-wide text-white">
              Primaria
            </span>
            {isStaff && (
              <span className="rounded-pill bg-kidville-yellow px-2.5 py-0.5 text-[11px] font-barlow font-bold uppercase tracking-wide text-kidville-green">
                Modalità segreteria
              </span>
            )}
          </div>
          <nav className="flex gap-1.5 overflow-x-auto pb-3">
            {NAV.map(({ seg, label, icon: Icon }) => {
              const href = seg ? `${base}/${seg}${suffix}` : `${base}${suffix}`;
              const active = seg ? pathname === `${base}/${seg}` : pathname === base;
              return (
                <Link
                  key={seg || 'panoramica'}
                  href={href}
                  className={`font-barlow inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-[12.5px] font-bold uppercase tracking-wide transition ${
                    active ? 'bg-white text-kidville-green' : 'bg-white/14 text-white hover:bg-white/25'
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

      {/* Avviso-ponte NON bloccante: mostrato UNA sola volta (solo su Panoramica),
          non ripetuto su ogni tab della classe. */}
      {isStaff && pathname === base && (
        <div className="max-w-5xl mx-auto px-4 pt-3">
          <p className="font-maven flex items-start gap-2 rounded-card bg-kidville-warn-soft px-3 py-2 text-xs text-kidville-warn">
            <Info size={14} className="mt-0.5 shrink-0" />
            Modalità operativa Segreteria/Direzione: il selettore del docente per cui operare non è ancora disponibile. Le scritture restano attribuite al docente titolare.
          </p>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-5">{children}</main>
    </div>
  );
}
