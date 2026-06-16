'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  BookOpen,
  ClipboardCheck,
  NotebookPen,
  Images,
  Bell,
  MessageCircle,
  FileText,
  ListTodo,
  Package,
  Baby,
  ArrowRight,
} from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { TiltCard } from '@/components/features/admin/motion/TiltCard';
import { RevealGroup, RevealItem } from '@/components/features/admin/motion/reveal';
import { AuroraHeader } from '@/components/features/admin/motion/AuroraHeader';
import { GradeWorldSwitch } from '@/components/features/teacher/GradeWorldSwitch';

// Funzioni didattiche gated dalla matrice (admin_settings.funzioni_matrice).
// Solo quelle con una destinazione reale nel "mondo" Infanzia/Nido: le altre
// (valutazioni/note/orario) vivono nel flusso Primaria per-sezione.
const ACTIVITY_DEFS = [
  { key: 'registro', label: 'Registro di Classe', href: '/teacher/primaria', icon: BookOpen, tint: 'bg-kidville-green/10 text-kidville-green' },
  { key: 'appello', label: 'Presenze · Appello', href: '/teacher/attendance', icon: ClipboardCheck, tint: 'bg-emerald-50 text-emerald-600' },
  { key: 'diario', label: 'Diario del Giorno', href: '/teacher/diary', icon: NotebookPen, tint: 'bg-amber-50 text-amber-600' },
  { key: 'gallery', label: 'Galleria', href: '/teacher/gallery', icon: Images, tint: 'bg-kidville-yellow/20 text-kidville-green' },
] as const;

// Strumenti di comunicazione: sempre disponibili (non gestiti dalla matrice).
const COMM_DEFS = [
  { label: 'Avvisi', href: '/teacher/avvisi', icon: Bell },
  { label: 'Chat famiglie', href: '/teacher/chat', icon: MessageCircle },
  { label: 'Modulistica', href: '/teacher/modulistica', icon: FileText },
  { label: 'Attività', href: '/teacher/tasks', icon: ListTodo },
  { label: 'Armadietto', href: '/teacher/locker', icon: Package },
] as const;

type MeData = {
  gradi: string[];
  funzioni: Record<string, Record<string, boolean>>;
};

const GRADO_LABEL: Record<string, string> = { infanzia: 'Infanzia', nido: 'Nido', primaria: 'Primaria' };

function TeacherDashboardInner() {
  const params = useSearchParams();
  const userId = getCurrentTeacherId(params);
  const withUser = (href: string) => `${href}?userId=${userId}`;

  const [me, setMe] = useState<MeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (active && d?.success) setMe(d.data);
      })
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [userId]);

  // Gradi del "mondo Infanzia" (la dashboard è identica per infanzia e nido).
  const infanziaGradi = useMemo(
    () => (me?.gradi ?? []).filter((g) => g === 'infanzia' || g === 'nido'),
    [me]
  );

  // Una funzione è abilitata se attiva in almeno uno dei gradi infanzia/nido.
  const isEnabled = (key: string) =>
    infanziaGradi.some((g) => me?.funzioni?.[g]?.[key] === true);

  const activities = ACTIVITY_DEFS.filter((a) => isEnabled(a.key));

  const isInfanziaTeacher = infanziaGradi.length > 0;
  const isPrimariaOnly = !isInfanziaTeacher && (me?.gradi ?? []).includes('primaria');

  const oggi = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="min-h-screen bg-kidville-cream">
      <div className="mx-auto max-w-2xl px-4 py-6 sm:py-8">
        {/* Header */}
        <AuroraHeader className="p-6 sm:p-7">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-maven text-sm text-white/80 capitalize">{oggi}</p>
              <h1 className="font-barlow font-black uppercase tracking-wide text-3xl mt-1">
                Ciao, maestra!
              </h1>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {(me?.gradi ?? []).map((g) => (
                  <span
                    key={g}
                    className="inline-flex items-center gap-1 rounded-pill bg-white/15 px-2.5 py-1 font-maven text-xs font-semibold backdrop-blur"
                  >
                    <Baby size={12} /> {GRADO_LABEL[g] ?? g}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4">
            <GradeWorldSwitch />
          </div>
        </AuroraHeader>

        {/* Le tue attività (gated dalla matrice) */}
        <section className="mt-6">
          <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green mb-3">
            Le tue attività
          </h2>

          {loading ? (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-28 rounded-2xl bg-white/60 animate-pulse border border-gray-100" />
              ))}
            </div>
          ) : activities.length > 0 ? (
            <RevealGroup className="grid grid-cols-2 gap-3">
              {activities.map((a) => {
                const Icon = a.icon;
                return (
                  <RevealItem key={a.key}>
                    <Link href={withUser(a.href)} className="block group h-full">
                      <TiltCard className="h-full rounded-2xl bg-white p-4 shadow-sm border border-gray-100">
                        <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${a.tint}`}>
                          <Icon size={24} strokeWidth={2.1} />
                        </div>
                        <p className="font-maven text-sm font-semibold text-gray-700 mt-3 leading-tight">
                          {a.label}
                        </p>
                        <ArrowRight size={16} className="text-gray-300 mt-1 group-hover:text-kidville-green group-hover:translate-x-1 transition-all" />
                      </TiltCard>
                    </Link>
                  </RevealItem>
                );
              })}
            </RevealGroup>
          ) : (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-white/50 p-6 text-center">
              <p className="font-maven text-sm text-gray-500">
                {isPrimariaOnly ? (
                  <>
                    Nessuna attività infanzia/nido per il tuo profilo.{' '}
                    <Link href={withUser('/teacher/primaria')} className="font-semibold text-kidville-green underline">
                      Vai alla Primaria
                    </Link>
                  </>
                ) : (
                  'Nessuna funzione didattica abilitata per il tuo grado. Contatta la direzione.'
                )}
              </p>
            </div>
          )}
        </section>

        {/* Comunicazione (sempre disponibile) */}
        <section className="mt-8">
          <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green mb-3">
            Comunicazione
          </h2>
          <RevealGroup className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {COMM_DEFS.map((c) => {
              const Icon = c.icon;
              return (
                <RevealItem key={c.href}>
                  <Link
                    href={withUser(c.href)}
                    className="flex flex-col items-center gap-2 rounded-2xl bg-white p-3 shadow-sm border border-gray-100 hover:border-kidville-green hover:shadow-md transition-all text-center h-full"
                  >
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-kidville-green/10 text-kidville-green">
                      <Icon size={20} strokeWidth={2} />
                    </div>
                    <span className="font-maven text-xs font-semibold text-gray-600 leading-tight">{c.label}</span>
                  </Link>
                </RevealItem>
              );
            })}
          </RevealGroup>
        </section>
      </div>
    </div>
  );
}

export default function TeacherDashboardPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <TeacherDashboardInner />
    </Suspense>
  );
}
