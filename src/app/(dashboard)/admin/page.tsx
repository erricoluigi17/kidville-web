'use client';

import { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
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
import { TrendIncassiChart, StudentiPerClasseChart } from '@/components/features/admin/DashboardCharts';
import { Donut, Live, SectionTitle } from '@/components/ui/cockpit';
import { Badge } from '@/components/ui/Badge';
import { btnClass } from '@/components/ui/Btn';
import { HeroCard } from '@/components/features/shell/HeroCard';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { greetingByHour } from '@/lib/ui/greeting';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import type { PresenzeAggregate } from '@/lib/presenze/aggregate';
import { formattaIstante } from '@/i18n/config';

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
  const t = useTranslations('adminNav');
  const locale = useLocale();
  const { userId, ready } = useSessionIdentity();
  // Identità di sessione (M4): con identità non risolta il parametro viene
  // omesso (href invariato), mai `userId=null`.
  const withUser = (href: string) => (userId ? `${href}${href.includes('?') ? '&' : '?'}userId=${userId}` : href);

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !userId) return; // in risoluzione o non autenticato (gestito nel render)
    let active = true;
    fetch(`/api/admin/dashboard?userId=${userId}`)
      // Marker interno (non mostrato): il testo d'errore è localizzato al render.
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load'))))
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ready, userId]);

  const kpis = useMemo(() => {
    if (!data) return [];
    return [
      {
        key: 'studenti',
        label: t('kpiAlunniIscritti'),
        value: data.studenti.iscritti,
        format: 'int' as const,
        // Scope esplicito: il KPI conta gli iscritti delle sole sedi selezionate
        // (SedeSelector). La card Presenze somma invece tutti i plessi accessibili.
        sub: t('kpiAlunniIscrittiSub'),
        icon: Users,
        accent: 'border-kidville-green',
        iconBg: 'bg-kidville-green/10 text-kidville-green',
        href: '/admin/students',
      },
      {
        key: 'scaduto',
        label: t('kpiPagamentiScaduti'),
        value: data.pagamenti.scadutoImporto,
        format: 'euro' as const,
        sub: t('kpiPagamentiScadutiSub', { count: data.pagamenti.scadutoCount }),
        icon: AlertTriangle,
        accent: 'border-kidville-error',
        iconBg: 'bg-kidville-error-soft text-kidville-error',
        href: '/admin/pagamenti',
      },
      {
        key: 'incassato',
        label: t('kpiIncassatoMese'),
        value: data.pagamenti.incassatoMese,
        format: 'euro' as const,
        icon: TrendingUp,
        accent: 'border-kidville-success',
        iconBg: 'bg-kidville-success-soft text-kidville-success',
        href: '/admin/pagamenti',
      },
      {
        key: 'iscrizioni',
        label: t('kpiIscrizioniAttesa'),
        value: data.iscrizioni.pending,
        format: 'int' as const,
        icon: ClipboardList,
        accent: 'border-kidville-warn',
        iconBg: 'bg-kidville-warn-soft text-kidville-warn',
        href: '/admin/modulistica?tab=ricevuti',
      },
      {
        key: 'mensa',
        label: t('kpiPrenotazioniMensa'),
        value: data.mensa.oggiPrenotazioni,
        format: 'int' as const,
        icon: UtensilsCrossed,
        accent: 'border-kidville-yellow',
        iconBg: 'bg-kidville-yellow/20 text-kidville-green',
        href: '/admin/mensa',
      },
      {
        key: 'fatture',
        label: t('kpiFattureEmettere'),
        value: data.pagamenti.fattureInAttesa,
        format: 'int' as const,
        icon: ReceiptText,
        accent: 'border-kidville-info',
        iconBg: 'bg-kidville-info-soft text-kidville-info',
        href: '/admin/pagamenti',
      },
    ];
  }, [data, t]);

  const modules = [
    { href: '/admin/students', label: t('moduloAnagrafica'), icon: Users },
    { href: '/admin/pagamenti', label: t('moduloPagamenti'), icon: Euro },
    { href: '/admin/mensa', label: t('moduloMensa'), icon: UtensilsCrossed },
    { href: '/admin/primaria', label: t('moduloPrimaria'), icon: GraduationCap },
    { href: '/admin/modulistica', label: t('moduloModulistica'), icon: FileText },
    { href: '/admin/impostazioni', label: t('moduloImpostazioni'), icon: Settings },
    { href: '/admin/tools', label: t('moduloStrumenti'), icon: Wrench },
  ];

  // Saluto neutro per fascia oraria, calcolato SOLO client-side (hydration-safe,
  // come le home genitore/docente); la data la mostra la HeroCard internamente.
  const greeting = useClientValue(greetingByHour, '');

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 lg:px-8 lg:py-8">
      {/* Hero gialla come le altre home: saluto + data + mascotte a mezzo busto */}
      <HeroCard
        title={`${greeting}${greeting ? '!' : ''}`}
        loading={greeting === ''}
        subtitle={t('heroSubtitle')}
        showDate
        animate
      />

      {/* Heading di sezione + azioni rapide. Il testo «Dashboard Direzione» resta
          VISIBILE (vincolo e2e admin-dashboard.spec.ts) come heading sotto la hero;
          la eyebrow "Direzione" è un elemento a parte (fuori dall'accessible name). */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-green">
            {t('eyebrowDirezione')}
          </p>
          <h2 className="mt-0.5 font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green lg:text-[28px]">
            {t('dashboardTitolo')}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={withUser('/admin/modulistica?tab=ricevuti')} className={btnClass('ghost', 'sm')}>
            <ClipboardList size={16} /> {t('azioneIscrizioni')}
          </Link>
          <Link href={withUser('/admin/pagamenti')} className={btnClass('primary', 'sm')}>
            <Plus size={16} /> {t('azioneGeneraRette')}
          </Link>
        </div>
      </div>

      {(error || (ready && !userId)) && (
        <div className="mt-6 rounded-2xl border border-kidville-error/30 bg-kidville-error-soft p-4 font-maven text-sm text-kidville-error">
          {error ? t('erroreDashboard') : t('sessioneNonValida')}
        </div>
      )}

      {/* KPI */}
      {loading && !(ready && !userId) ? (
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
                {t('graficoIncassiTitolo')}
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
                {t('graficoAlunniClasseTitolo')}
              </h2>
              <Users size={18} className="text-kidville-green" />
            </div>
            {data.studenti.perClasse.length ? (
              <StudentiPerClasseChart data={data.studenti.perClasse} />
            ) : (
              <p className="font-maven text-sm text-kidville-muted py-12 text-center">{t('nessunAlunnoIscritto')}</p>
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
            title={t('kpiPagamentiScaduti')}
            icon={AlertTriangle}
            count={data.pagamenti.scadutoCount}
            tone="red"
            href={withUser('/admin/pagamenti')}
            empty={t('alertScadutiVuoto')}
            rows={data.alert.scaduti.map((s) => ({
              id: s.id,
              left: s.alunno,
              right: euroFmt.format(s.importo),
              meta: formattaIstante(new Date(s.scadenza), locale),
            }))}
          />
          <AlertPanel
            title={t('alertIscrizioniTitolo')}
            icon={ClipboardList}
            count={data.iscrizioni.pending}
            tone="amber"
            href={withUser('/admin/modulistica?tab=ricevuti')}
            empty={t('alertIscrizioniVuoto')}
            rows={data.alert.iscrizioni.map((s, i) => ({
              id: s.id,
              left: t('alertRichiesta', { n: i + 1 }),
              right: t('alertDaGestire'),
              meta: s.data ? formattaIstante(new Date(s.data), locale) : '',
            }))}
          />
        </div>
      )}

      {/* Hub moduli */}
      <div className="mt-8">
        <h2 className="font-barlow font-black uppercase tracking-wide text-kidville-green mb-3">
          {t('tuttiIModuli')}
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
  const t = useTranslations('adminNav');
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
    { label: t('presenzeTilePresenti'), value: totale?.presenti, cls: 'text-kidville-green' },
    { label: t('presenzeTileIscritti'), value: totale?.iscritti, cls: 'text-kidville-green' },
    { label: t('presenzeTileAssenti'), value: totale?.assenti, cls: 'text-kidville-green' },
    {
      label: t('presenzeTileAppelli'),
      value: totale?.appelli_mancanti,
      cls: (totale?.appelli_mancanti ?? 0) > 0 ? 'text-kidville-warn' : 'text-kidville-green',
    },
  ];

  return (
    <div className="mt-6 rounded-2xl bg-kidville-white p-5 shadow-sm border border-kidville-line">
      <SectionTitle
        icon={Users}
        title={t('presenzeTitolo')}
        sub={t('presenzeSottotitolo')}
        action={<Live label={t('presenzeLive')} />}
      />
      <div className="flex flex-col items-center gap-6 sm:flex-row">
        <Donut
          value={totale?.presenti ?? 0}
          max={totale?.iscritti ?? 1}
          tone={pct == null ? 'neutral' : 'green'}
          label={pct == null ? '—' : `${pct}%`}
          sub={t('presenzeDonutSub')}
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
        <p className="mt-3 font-maven text-xs text-kidville-muted">{t('presenzeNessunPlesso')}</p>
      )}
      {dati && dati.sedi.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {dati.sedi.map((sede) => (
            <div key={sede.scuola_id} className="rounded-xl border border-kidville-line p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-barlow text-[13.5px] font-extrabold uppercase text-kidville-green">{sede.scuola}</span>
                <span className="shrink-0 font-maven text-xs font-semibold text-kidville-ink/70">
                  {t('sedePresenti', { presenti: sede.presenti, iscritti: sede.iscritti })}
                </span>
              </div>
              {sede.classi.length > 0 && (
                <ul className="mt-2 divide-y divide-kidville-line">
                  {sede.classi.map((c) => (
                    <li key={c.section_id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="truncate font-maven text-sm font-semibold text-kidville-ink/80">{c.classe}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {!c.appello_fatto && <Badge tone="warn">{t('appelloMancante')}</Badge>}
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
  const t = useTranslations('adminNav');
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
          {t('alertApri')} <ArrowRight size={14} />
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

function DashboardFallback() {
  const t = useTranslations('adminNav');
  return <div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>;
}

export default function AdminDashboardPage() {
  return (
    <Suspense fallback={<DashboardFallback />}>
      <AdminDashboardInner />
    </Suspense>
  );
}
