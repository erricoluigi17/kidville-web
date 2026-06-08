'use client';

import { useEffect, useMemo, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  Users,
  Euro,
  ClipboardList,
  UtensilsCrossed,
  FileText,
  ReceiptText,
  AlertTriangle,
  ArrowRight,
  Plus,
  TrendingUp,
  GraduationCap,
  Settings,
  Wrench,
} from 'lucide-react';
import { AnimatedNumber } from '@/components/features/admin/motion/AnimatedNumber';
import { TiltCard } from '@/components/features/admin/motion/TiltCard';
import { RevealGroup, RevealItem } from '@/components/features/admin/motion/reveal';
import { AuroraHeader } from '@/components/features/admin/motion/AuroraHeader';
import { TrendIncassiChart, StudentiPerClasseChart } from '@/components/features/admin/DashboardCharts';

const DEMO_ADMIN_ID = '22222222-2222-2222-2222-555555555555';

interface DashboardData {
  studenti: { iscritti: number; perClasse: { classe: string; count: number }[] };
  pagamenti: { scadutoImporto: number; scadutoCount: number; incassatoMese: number; fattureInAttesa: number };
  iscrizioni: { pending: number };
  mensa: { oggiPrenotazioni: number };
  moduli: { submissionTotale: number; daFirmare: number };
  trend: { mese: string; label: string; incassato: number }[];
  alert: {
    scaduti: { id: string; alunno: string; importo: number; scadenza: string }[];
    iscrizioni: { id: string; data: string | null }[];
  };
}

const euroFmt = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

function AdminDashboardInner() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('userId') || DEMO_ADMIN_ID;
  const withUser = (href: string) => `${href}?userId=${userId}`;

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/admin/dashboard?userId=${userId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('Errore caricamento'))))
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [userId]);

  const kpis = useMemo(() => {
    if (!data) return [];
    return [
      {
        key: 'studenti',
        label: 'Alunni iscritti',
        value: data.studenti.iscritti,
        format: 'int' as const,
        icon: Users,
        accent: 'border-kidville-green',
        iconBg: 'bg-kidville-green/10 text-kidville-green',
        href: '/admin/students',
      },
      {
        key: 'scaduto',
        label: 'Pagamenti scaduti',
        value: data.pagamenti.scadutoImporto,
        format: 'euro' as const,
        sub: `${data.pagamenti.scadutoCount} posizioni`,
        icon: AlertTriangle,
        accent: 'border-red-500',
        iconBg: 'bg-red-50 text-red-500',
        href: '/admin/pagamenti',
      },
      {
        key: 'incassato',
        label: 'Incassato nel mese',
        value: data.pagamenti.incassatoMese,
        format: 'euro' as const,
        icon: TrendingUp,
        accent: 'border-emerald-500',
        iconBg: 'bg-emerald-50 text-emerald-600',
        href: '/admin/pagamenti',
      },
      {
        key: 'iscrizioni',
        label: 'Iscrizioni in attesa',
        value: data.iscrizioni.pending,
        format: 'int' as const,
        icon: ClipboardList,
        accent: 'border-amber-500',
        iconBg: 'bg-amber-50 text-amber-600',
        href: '/admin/iscrizioni',
      },
      {
        key: 'mensa',
        label: 'Prenotazioni mensa oggi',
        value: data.mensa.oggiPrenotazioni,
        format: 'int' as const,
        icon: UtensilsCrossed,
        accent: 'border-kidville-yellow',
        iconBg: 'bg-kidville-yellow/20 text-kidville-green',
        href: '/admin/mensa',
      },
      {
        key: 'fatture',
        label: 'Fatture da emettere',
        value: data.pagamenti.fattureInAttesa,
        format: 'int' as const,
        icon: ReceiptText,
        accent: 'border-indigo-400',
        iconBg: 'bg-indigo-50 text-indigo-500',
        href: '/admin/pagamenti',
      },
    ];
  }, [data]);

  const modules = [
    { href: '/admin/students', label: 'Anagrafica', icon: Users },
    { href: '/admin/iscrizioni', label: 'Iscrizioni', icon: ClipboardList },
    { href: '/admin/pagamenti', label: 'Pagamenti', icon: Euro },
    { href: '/admin/mensa', label: 'Mensa', icon: UtensilsCrossed },
    { href: '/admin/primaria', label: 'Primaria', icon: GraduationCap },
    { href: '/admin/modulistica', label: 'Modulistica', icon: FileText },
    { href: '/admin/impostazioni', label: 'Impostazioni', icon: Settings },
    { href: '/admin/tools', label: 'Strumenti', icon: Wrench },
  ];

  const oggi = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 lg:px-8 lg:py-8">
      {/* Header aurora */}
      <AuroraHeader className="p-6 lg:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-maven text-sm text-white/80 capitalize">{oggi}</p>
            <h1 className="font-barlow font-black uppercase tracking-wide text-3xl lg:text-4xl mt-1">
              Dashboard Direzione
            </h1>
            <p className="font-maven text-white/85 mt-1">Quadro generale della scuola in tempo reale</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href={withUser('/admin/iscrizioni')}
              className="inline-flex items-center gap-2 rounded-pill bg-white/15 hover:bg-white/25 px-4 py-2 font-barlow font-black uppercase tracking-wide text-sm transition-colors backdrop-blur"
            >
              <ClipboardList size={16} /> Iscrizioni
            </Link>
            <Link
              href={withUser('/admin/pagamenti')}
              className="inline-flex items-center gap-2 rounded-pill bg-kidville-yellow text-kidville-green px-4 py-2 font-barlow font-black uppercase tracking-wide text-sm hover:opacity-90 transition-opacity"
            >
              <Plus size={16} /> Genera rette
            </Link>
          </div>
        </div>
      </AuroraHeader>

      {error && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 font-maven text-sm text-red-600">
          {error}. Verifica di essere autenticato come staff (parametro <code>userId</code>).
        </div>
      )}

      {/* KPI */}
      {loading ? (
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-2xl bg-white/60 animate-pulse border border-gray-100" />
          ))}
        </div>
      ) : (
        data && (
          <RevealGroup className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {kpis.map((kpi) => {
              const Icon = kpi.icon;
              return (
                <RevealItem key={kpi.key}>
                  <Link href={withUser(kpi.href)} className="block group h-full">
                    <TiltCard className={`h-full rounded-2xl bg-white p-5 shadow-sm border-l-4 ${kpi.accent} border-y border-r border-gray-100`}>
                      <div className="flex items-start justify-between">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${kpi.iconBg}`}>
                          <Icon size={22} strokeWidth={2.2} />
                        </div>
                        <ArrowRight size={18} className="text-gray-300 group-hover:text-kidville-green group-hover:translate-x-1 transition-all" />
                      </div>
                      <p className="font-barlow font-black text-3xl text-kidville-green mt-4">
                        <AnimatedNumber value={kpi.value} format={kpi.format} />
                      </p>
                      <p className="font-maven text-sm text-gray-500 font-semibold">{kpi.label}</p>
                      {kpi.sub && <p className="font-maven text-xs text-gray-400 mt-0.5">{kpi.sub}</p>}
                    </TiltCard>
                  </Link>
                </RevealItem>
              );
            })}
          </RevealGroup>
        )
      )}

      {/* Grafici */}
      {data && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, type: 'spring', stiffness: 200, damping: 24 }}
            className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green">
                Incassi · ultimi 6 mesi
              </h2>
              <TrendingUp size={18} className="text-emerald-500" />
            </div>
            <TrendIncassiChart data={data.trend} />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, type: 'spring', stiffness: 200, damping: 24 }}
            className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green">
                Alunni per classe
              </h2>
              <Users size={18} className="text-kidville-green" />
            </div>
            {data.studenti.perClasse.length ? (
              <StudentiPerClasseChart data={data.studenti.perClasse} />
            ) : (
              <p className="font-maven text-sm text-gray-400 py-12 text-center">Nessun alunno iscritto</p>
            )}
          </motion.div>
        </div>
      )}

      {/* Alert / attività */}
      {data && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <AlertPanel
            title="Pagamenti scaduti"
            icon={AlertTriangle}
            count={data.pagamenti.scadutoCount}
            tone="red"
            href={withUser('/admin/pagamenti')}
            empty="Nessun pagamento scaduto 🎉"
            rows={data.alert.scaduti.map((s) => ({
              id: s.id,
              left: s.alunno,
              right: euroFmt.format(s.importo),
              meta: new Date(s.scadenza).toLocaleDateString('it-IT'),
            }))}
          />
          <AlertPanel
            title="Iscrizioni da processare"
            icon={ClipboardList}
            count={data.iscrizioni.pending}
            tone="amber"
            href={withUser('/admin/iscrizioni')}
            empty="Nessuna iscrizione in attesa"
            rows={data.alert.iscrizioni.map((s, i) => ({
              id: s.id,
              left: `Richiesta #${i + 1}`,
              right: 'Da gestire',
              meta: s.data ? new Date(s.data).toLocaleDateString('it-IT') : '',
            }))}
          />
        </div>
      )}

      {/* Hub moduli */}
      <div className="mt-8">
        <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green mb-3">
          Tutti i moduli
        </h2>
        <RevealGroup className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {modules.map((m) => {
            const Icon = m.icon;
            return (
              <RevealItem key={m.href}>
                <Link
                  href={withUser(m.href)}
                  className="flex flex-col items-center gap-2 rounded-2xl bg-white p-4 shadow-sm border border-gray-100 hover:border-kidville-green hover:shadow-md transition-all text-center"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-kidville-green/10 text-kidville-green">
                    <Icon size={24} strokeWidth={2} />
                  </div>
                  <span className="font-maven text-sm font-semibold text-gray-700">{m.label}</span>
                </Link>
              </RevealItem>
            );
          })}
        </RevealGroup>
      </div>
    </div>
  );
}

interface AlertRow {
  id: string;
  left: string;
  right: string;
  meta: string;
}

function AlertPanel({
  title,
  icon: Icon,
  count,
  tone,
  href,
  rows,
  empty,
}: {
  title: string;
  icon: typeof AlertTriangle;
  count: number;
  tone: 'red' | 'amber';
  href: string;
  rows: AlertRow[];
  empty: string;
}) {
  const toneCls = tone === 'red' ? 'bg-red-500' : 'bg-amber-500';
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className={tone === 'red' ? 'text-red-500' : 'text-amber-500'} />
          <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green">{title}</h2>
          {count > 0 && (
            <motion.span
              className={`ml-1 inline-flex min-w-5 items-center justify-center rounded-full ${toneCls} px-1.5 text-xs font-bold text-white`}
              animate={{ scale: [1, 1.18, 1] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            >
              {count}
            </motion.span>
          )}
        </div>
        <Link href={href} className="font-maven text-xs font-semibold text-kidville-green hover:underline inline-flex items-center gap-1">
          Apri <ArrowRight size={14} />
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="font-maven text-sm text-gray-400 py-6 text-center">{empty}</p>
      ) : (
        <motion.ul
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.07 } } }}
          className="divide-y divide-gray-50"
        >
          {rows.map((row) => (
            <motion.li
              key={row.id}
              variants={{ hidden: { opacity: 0, x: -12 }, show: { opacity: 1, x: 0 } }}
              className="flex items-center justify-between py-2.5"
            >
              <div className="min-w-0">
                <p className="font-maven text-sm font-semibold text-gray-700 truncate">{row.left}</p>
                {row.meta && <p className="font-maven text-xs text-gray-400">{row.meta}</p>}
              </div>
              <span className="font-barlow font-black text-sm text-gray-600 shrink-0">{row.right}</span>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}

export default function AdminDashboardPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <AdminDashboardInner />
    </Suspense>
  );
}
