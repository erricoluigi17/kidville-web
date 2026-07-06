'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import Link from 'next/link';
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
import { Donut, Live, SectionTitle } from '@/components/ui/cockpit';
import { Badge } from '@/components/ui/Badge';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import type { PresenzeAggregate } from '@/lib/presenze/aggregate';

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
  const { userId } = useSessionIdentity();
  // Identità di sessione (M4): con identità non risolta il parametro viene
  // omesso (href invariato), mai `userId=null`.
  const withUser = (href: string) => (userId ? `${href}${href.includes('?') ? '&' : '?'}userId=${userId}` : href);

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return; // identità non risolta: lo skeleton (loading=true) resta attivo
    let active = true;
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
        accent: 'border-kidville-error',
        iconBg: 'bg-kidville-error-soft text-kidville-error',
        href: '/admin/pagamenti',
      },
      {
        key: 'incassato',
        label: 'Incassato nel mese',
        value: data.pagamenti.incassatoMese,
        format: 'euro' as const,
        icon: TrendingUp,
        accent: 'border-kidville-success',
        iconBg: 'bg-kidville-success-soft text-kidville-success',
        href: '/admin/pagamenti',
      },
      {
        key: 'iscrizioni',
        label: 'Iscrizioni in attesa',
        value: data.iscrizioni.pending,
        format: 'int' as const,
        icon: ClipboardList,
        accent: 'border-kidville-warn',
        iconBg: 'bg-kidville-warn-soft text-kidville-warn',
        href: '/admin/modulistica?tab=ricevuti',
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
        accent: 'border-kidville-info',
        iconBg: 'bg-kidville-info-soft text-kidville-info',
        href: '/admin/pagamenti',
      },
    ];
  }, [data]);

  const modules = [
    { href: '/admin/students', label: 'Anagrafica', icon: Users },
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
              href={withUser('/admin/modulistica?tab=ricevuti')}
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
        <div className="mt-6 rounded-2xl border border-kidville-error/30 bg-kidville-error-soft p-4 font-maven text-sm text-kidville-error">
          {error}. Verifica di essere autenticato come staff (parametro <code>userId</code>).
        </div>
      )}

      {/* KPI */}
      {loading ? (
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 rounded-2xl bg-kidville-white/60 animate-pulse border border-kidville-line" />
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
                    <TiltCard className={`h-full rounded-2xl bg-kidville-white p-5 shadow-sm border-l-4 ${kpi.accent} border-y border-r border-kidville-line`}>
                      <div className="flex items-start justify-between">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${kpi.iconBg}`}>
                          <Icon size={22} strokeWidth={2.2} />
                        </div>
                        <ArrowRight size={18} className="text-kidville-neutral/50 group-hover:text-kidville-green group-hover:translate-x-1 transition-all" />
                      </div>
                      <p className="font-barlow font-black text-3xl text-kidville-green mt-4">
                        <AnimatedNumber value={kpi.value} format={kpi.format} />
                      </p>
                      <p className="font-maven text-sm text-kidville-ink/70 font-semibold">{kpi.label}</p>
                      {kpi.sub && <p className="font-maven text-xs text-kidville-muted mt-0.5">{kpi.sub}</p>}
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
            className="rounded-2xl bg-kidville-white p-5 shadow-sm border border-kidville-line"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green">
                Incassi · ultimi 6 mesi
              </h2>
              <TrendingUp size={18} className="text-kidville-success" />
            </div>
            <TrendIncassiChart data={data.trend} />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, type: 'spring', stiffness: 200, damping: 24 }}
            className="rounded-2xl bg-kidville-white p-5 shadow-sm border border-kidville-line"
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
              <p className="font-maven text-sm text-kidville-muted py-12 text-center">Nessun alunno iscritto</p>
            )}
          </motion.div>
        </div>
      )}

      {/* Presenze in tempo reale — struttura DR, dati reali da
          /api/admin/presenze/realtime con poll 60s (M7.5). */}
      <PresenzeRealtimeCard userId={userId} />

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
            href={withUser('/admin/modulistica?tab=ricevuti')}
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
                  className="flex flex-col items-center gap-2 rounded-2xl bg-kidville-white p-4 shadow-sm border border-kidville-line hover:border-kidville-green hover:shadow-md transition-all text-center"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-kidville-green/10 text-kidville-green">
                    <Icon size={24} strokeWidth={2} />
                  </div>
                  <span className="font-maven text-sm font-semibold text-kidville-ink/80">{m.label}</span>
                </Link>
              </RevealItem>
            );
          })}
        </RevealGroup>
      </div>
    </div>
  );
}

/**
 * Card "Presenze in tempo reale" (M7.5): Donut presenti/iscritti, 4 tile e
 * elenco per sede/classe da /api/admin/presenze/realtime, poll 60s (niente
 * canali realtime). Stessa struttura DR del placeholder che sostituisce.
 */
function PresenzeRealtimeCard({ userId }: { userId: string | null }) {
  const [dati, setDati] = useState<PresenzeAggregate | null>(null);
  const [ready, setReady] = useState(false);

  // Pattern PagamentiSummary (react-hooks 7): nessun setState sincrono
  // pre-await, niente catch top-level, corpo in try/finally.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/presenze/realtime${userId ? `?userId=${userId}` : ''}`).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (j?.success) setDati(j.data);
    } finally {
      setReady(true);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { load(); }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const totale = dati?.totale;
  const pct = totale && totale.iscritti > 0 ? Math.round((totale.presenti / totale.iscritti) * 100) : null;
  const tiles = [
    { label: 'Presenti oggi', value: totale?.presenti, cls: 'text-kidville-green' },
    { label: 'Iscritti', value: totale?.iscritti, cls: 'text-kidville-green' },
    { label: 'Assenti', value: totale?.assenti, cls: 'text-kidville-green' },
    {
      label: 'Appelli mancanti',
      value: totale?.appelli_mancanti,
      cls: (totale?.appelli_mancanti ?? 0) > 0 ? 'text-kidville-warn' : 'text-kidville-green',
    },
  ];

  return (
    <div className="mt-6 rounded-2xl bg-kidville-white p-5 shadow-sm border border-kidville-line">
      <SectionTitle
        icon={Users}
        title="Presenze in tempo reale"
        sub="Monitoraggio multi-sede · per sede e per classe"
        action={<Live label="Live · 60s" />}
      />
      <div className="flex flex-col items-center gap-6 sm:flex-row">
        <Donut
          value={totale?.presenti ?? 0}
          max={totale?.iscritti ?? 1}
          tone={pct == null ? 'neutral' : 'green'}
          label={pct == null ? '—' : `${pct}%`}
          sub="presenti"
        />
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-xl bg-kidville-cream px-3 py-4 text-center">
              <div className={`font-barlow text-2xl font-black ${t.value == null ? 'text-kidville-neutral' : t.cls}`}>
                {t.value ?? '—'}
              </div>
              <div className="mt-1 font-barlow text-[10.5px] font-bold uppercase tracking-[0.03em] text-kidville-muted">{t.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* elenco per sede e per classe */}
      {ready && dati && dati.sedi.length === 0 && (
        <p className="mt-3 font-maven text-xs text-kidville-muted">Nessun alunno iscritto nei plessi in gestione.</p>
      )}
      {dati && dati.sedi.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {dati.sedi.map((sede) => (
            <div key={sede.scuola_id} className="rounded-xl border border-kidville-line p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-barlow text-[13.5px] font-extrabold uppercase text-kidville-green">{sede.scuola}</span>
                <span className="shrink-0 font-maven text-xs font-semibold text-kidville-ink/70">
                  {sede.presenti}/{sede.iscritti} presenti
                </span>
              </div>
              {sede.classi.length > 0 && (
                <ul className="mt-2 divide-y divide-kidville-line">
                  {sede.classi.map((c) => (
                    <li key={c.section_id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="truncate font-maven text-sm font-semibold text-kidville-ink/80">{c.classe}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {!c.appello_fatto && <Badge tone="warn">Appello mancante</Badge>}
                        <span className="font-barlow text-sm font-black text-kidville-ink/80">
                          {c.presenti}/{c.iscritti}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
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
  const toneCls = tone === 'red' ? 'bg-kidville-error' : 'bg-kidville-warn';
  return (
    <div className="rounded-2xl bg-kidville-white p-5 shadow-sm border border-kidville-line">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className={tone === 'red' ? 'text-kidville-error' : 'text-kidville-warn'} />
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
        <p className="font-maven text-sm text-kidville-muted py-6 text-center">{empty}</p>
      ) : (
        <motion.ul
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: 0.07 } } }}
          className="divide-y divide-kidville-line"
        >
          {rows.map((row) => (
            <motion.li
              key={row.id}
              variants={{ hidden: { opacity: 0, x: -12 }, show: { opacity: 1, x: 0 } }}
              className="flex items-center justify-between py-2.5"
            >
              <div className="min-w-0">
                <p className="font-maven text-sm font-semibold text-kidville-ink/80 truncate">{row.left}</p>
                {row.meta && <p className="font-maven text-xs text-kidville-muted">{row.meta}</p>}
              </div>
              <span className="font-barlow font-black text-sm text-kidville-ink/80 shrink-0">{row.right}</span>
            </motion.li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}

export default function AdminDashboardPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <AdminDashboardInner />
    </Suspense>
  );
}
