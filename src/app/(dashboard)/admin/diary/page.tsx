'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, CheckCircle2, Users } from 'lucide-react';
import { CockpitPage, PageHeader, StatCard, CockpitSelect } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor';

// Diario 0-6 nel cockpit (segreteria/direzione): selettore sede/sezione dai
// plessi consentiti, presenze del giorno in consultazione (l'appello resta
// alle maestre) e compilazione del diario con lo stesso editor del docente.

interface SezioneScoped { id: string; name: string; school_type: string }
interface ScuolaScoped { scuolaId: string; scuolaNome: string; sezioni: SezioneScoped[] }

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function AdminDiaryInner() {
  const t = useTranslations('adminAltro');
  const { userId } = useSessionIdentity();
  const [scuole, setScuole] = useState<ScuolaScoped[]>([]);
  const [scuolaId, setScuolaId] = useState('');
  const [sezione, setSezione] = useState<string | null>(null);
  const [scopedLoaded, setScopedLoaded] = useState(false);
  const [compilati, setCompilati] = useState<number | null>(null);

  const loadCompilati = (sez: string | null) => {
    if (!sez || !userId) return;
    fetch(`/api/diary/entries?sezione=${encodeURIComponent(sez)}&date=${todayISO()}&userId=${userId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!Array.isArray(d)) return;
        setCompilati(new Set(d.map((e: { alunno_id: string }) => e.alunno_id)).size);
      })
      .catch(() => {});
  };

  const day = useDiaryDay(userId, sezione, { onSaved: () => loadCompilati(sezione) });

  useEffect(() => {
    if (!userId) return;
    let active = true;
    fetch(`/api/admin/sections/scoped?grado=nido,infanzia&userId=${userId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!active || !d?.success) return;
        const list: ScuolaScoped[] = (d.data ?? []).filter((g: ScuolaScoped) => g.sezioni.length > 0);
        setScuole(list);
        const first = list[0];
        setScuolaId(cur => cur || (first?.scuolaId ?? ''));
        setSezione(cur => cur ?? first?.sezioni[0]?.name ?? null);
      })
      .catch(() => {})
      .finally(() => { if (active) setScopedLoaded(true); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    loadCompilati(sezione);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sezione, userId]);

  const scuola = useMemo(() => scuole.find(s => s.scuolaId === scuolaId) ?? null, [scuole, scuolaId]);

  const pickScuola = (id: string) => {
    setScuolaId(id);
    const g = scuole.find(s => s.scuolaId === id);
    setSezione(g?.sezioni[0]?.name ?? null);
    setCompilati(null);
    day.resetSelection();
  };

  const pickSezione = (name: string) => {
    setSezione(name);
    setCompilati(null);
    day.resetSelection();
  };

  return (
    <CockpitPage max={1100}>
      <PageHeader
        eyebrow={t('diaryEyebrow')}
        icon={BookOpen}
        title={t('diaryTitle')}
        subtitle={t('diarySubtitle')}
      />

      {scopedLoaded && scuole.length === 0 ? (
        <div className="rounded-card bg-kidville-white p-8 text-center shadow-sm">
          <p className="font-maven text-sm text-kidville-muted">
            {t('diaryNessunaSezione')}
          </p>
        </div>
      ) : (
        <>
          {/* Selettori sede/sezione + filtro presenze */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {scuole.length > 1 && (
              <label className="flex items-center gap-2">
                <span className="font-maven text-sm text-kidville-ink/70">{t('diaryLabelSede')}</span>
                <CockpitSelect
                  value={scuolaId}
                  onChange={pickScuola}
                  options={scuole.map(s => ({ value: s.scuolaId, label: s.scuolaNome }))}
                />
              </label>
            )}
            <label className="flex items-center gap-2">
              <span className="font-maven text-sm text-kidville-ink/70">{t('diaryLabelSezione')}</span>
              <CockpitSelect
                value={sezione ?? ''}
                onChange={pickSezione}
                options={(scuola?.sezioni ?? []).map(s => ({ value: s.name, label: `${s.name} (${s.school_type})` }))}
              />
            </label>
            <button
              onClick={day.toggleShowAll}
              className={`flex items-center gap-1.5 rounded-pill border px-3 py-1.5 font-maven text-xs font-semibold transition-colors ${
                day.showAll
                  ? 'border-kidville-line bg-white text-kidville-muted'
                  : 'border-kidville-green/20 bg-kidville-green-soft text-kidville-green'
              }`}
              title={day.showAll ? t('diaryToggleTitleTutti') : t('diaryToggleTitlePresenti')}
            >
              <Users size={12} strokeWidth={1.5} /> {day.showAll ? t('diaryToggleTutti') : t('diaryToggleSoloPresenti')}
            </button>
          </div>

          {/* Stat del giorno */}
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-[560px]">
            <StatCard
              icon={Users}
              label={day.showAll ? t('diaryStatAlunniTutti') : t('diaryStatPresentiOggi')}
              value={day.isLoading ? '…' : day.students.length}
              sub={sezione ? t('diarySezioneSub', { sezione }) : undefined}
            />
            <StatCard
              icon={CheckCircle2}
              label={t('diaryStatCompilato')}
              value={compilati ?? '…'}
              sub={t('diaryOggi')}
              tone="yellow"
            />
          </div>

          {/* Presenti del giorno (appello delle maestre) */}
          {!day.isLoading && (
            <div className="rounded-card bg-kidville-white p-4 shadow-sm">
              <p className="font-barlow mb-2 text-xs font-bold uppercase tracking-wide text-kidville-green">
                {day.showAll ? t('diaryHeadingAlunni') : t('diaryStatPresentiOggi')}
              </p>
              {day.students.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted">
                  {day.showAll
                    ? t('diaryVuotoTutti')
                    : t('diaryVuotoPresenti')}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {day.students.map(s => (
                    <span key={s.id} className="rounded-pill bg-kidville-green-soft px-2.5 py-1 font-maven text-xs font-semibold text-kidville-green">
                      {s.firstName} {s.lastName}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Editor di compilazione condiviso col docente */}
          <div className="max-w-[720px]">
            {sezione && day.isLoading ? (
              <div className="mt-4 flex items-center gap-3 rounded-card bg-kidville-white p-6 shadow-sm">
                <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
                <p className="font-maven text-sm text-kidville-muted">{t('diaryCaricamentoAlunni')}</p>
              </div>
            ) : (
              <DiaryEventEditor day={day} sezione={sezione} />
            )}
          </div>
        </>
      )}
    </CockpitPage>
  );
}

function DiaryFallback() {
  const t = useTranslations('adminAltro');
  return <div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>;
}

export default function AdminDiaryPage() {
  return (
    <Suspense fallback={<DiaryFallback />}>
      <AdminDiaryInner />
    </Suspense>
  );
}
