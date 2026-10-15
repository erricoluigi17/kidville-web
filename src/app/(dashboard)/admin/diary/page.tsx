'use client';

import { oggiRoma } from '@/lib/storici/retroattivita';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { voceDaMostrare } from '@/lib/diary/registrazione';
import { useTranslations } from 'next-intl';
import { BookOpen, CheckCircle2, Users } from 'lucide-react';
import { CockpitPage, PageHeader, StatCard, CockpitSelect } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { LinkStorici } from '@/components/features/admin/storici/LinkStorici';

// Diario 0-6 nel cockpit (segreteria/direzione): selettore sede/sezione dai
// plessi consentiti, presenze del giorno in consultazione (l'appello resta
// alle maestre) e compilazione del diario con lo stesso editor del docente.

interface SezioneScoped { id: string; name: string; school_type: string }
interface ScuolaScoped { scuolaId: string; scuolaNome: string; sezioni: SezioneScoped[] }

function todayISO() {
  return oggiRoma();
}

function AdminDiaryInner() {
  const t = useTranslations('adminAltro');
  const { userId } = useSessionIdentity();
  const [dataDiario, setDataDiario] = useState(todayISO);
  const [scuole, setScuole] = useState<ScuolaScoped[]>([]);
  const [scuolaId, setScuolaId] = useState('');
  const [classiStoriche, setClassiStoriche] = useState<{ scuolaId: string; classi: SezioneScoped[] } | null>(null);
  // La sezione si sceglie per UUID (2026-09-28): per nome, due sezioni omonime di due sedi
  // («Girasoli» esiste in più plessi) si mescolavano — bambini di una sede con le routine
  // dell'altra, e «Compilato» che contava entrambe.
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [scopedLoaded, setScopedLoaded] = useState(false);
  const [compilati, setCompilati] = useState<number | null>(null);

  const giroCompilati = useRef(0);
  const loadCompilati = (sez: string | null, sede: string) => {
    if (!sez || !userId) return;
    const giro = ++giroCompilati.current;
    const qs = new URLSearchParams({ sectionId: sez, date: dataDiario, userId });
    if (sede) qs.set('scuola_id', sede);
    fetch(`/api/diary/entries?${qs.toString()}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (giro !== giroCompilati.current || !Array.isArray(d)) return;
        // Contava le righe vuote, quindi diceva sempre «tutta la classe»: è il
        // numero su cui la direzione si fida per sapere se il diario è stato
        // compilato davvero. Ora conta chi ha una registrazione vera.
        const vere = (d as Array<{ alunno_id: string; tipo_evento: string; dettagli?: Record<string, unknown> | null; nota_libera?: string | null; nota_bambino?: string | null }>)
            .filter(e => voceDaMostrare(e.tipo_evento, e.dettagli, { conNota: Boolean(e.nota_libera || e.nota_bambino) }));
        setCompilati(new Set(vere.map(e => e.alunno_id)).size);
      })
      // Il contatore resta «…»: è un numero di consultazione, e la rete che manca la registra già
      // la fetch strumentata. Lo si dice comunque, perché un catch muto è un bug.
      .catch((err: unknown) => logClient({ livello: 'warn', evento: 'fetch', messaggio: `diario-compilati-non-letti: ${nomeErrore(err)}` }));
  };

  const storico = dataDiario < todayISO();
  const scuola = useMemo(() => {
    const corrente = scuole.find(s => s.scuolaId === scuolaId);
    if (!corrente) return null;
    const precedenti = storico && classiStoriche?.scuolaId === scuolaId ? classiStoriche.classi : [];
    return { ...corrente, sezioni: [...new Map([...precedenti, ...corrente.sezioni].map(s => [s.id, s])).values()] };
  }, [scuole, scuolaId, classiStoriche, storico]);
  const sezione = scuola?.sezioni.find(s => s.id === sectionId)?.name ?? null;

  // La sede del selettore arriva all'editor (2026-09-28): le routine sono per sede, e la
  // segreteria che compila il diario di un altro plesso deve vedere le routine di quello. Finché
  // la sede non è scelta (`null`) l'editor non chiede la configurazione: niente lampo delle
  // routine della sede principale di chi compila.
  const day = useDiaryDay(userId, sezione, {
    onSaved: () => loadCompilati(sectionId, scuolaId),
    sectionId: sectionId ?? undefined,
    scuolaId: scuolaId || null,
    date: dataDiario,
  });

  useEffect(() => {
    if (!userId) return;
    let active = true;
    fetch(`/api/admin/sections/scoped?grado=nido,infanzia&userId=${userId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!active || !d?.success) return;
        const list: ScuolaScoped[] = d.data ?? [];
        setScuole(list);
        const first = list[0];
        setScuolaId(cur => cur || (first?.scuolaId ?? ''));
        setSectionId(cur => cur ?? first?.sezioni[0]?.id ?? null);
      })
      .catch((err: unknown) => logClient({ livello: 'warn', evento: 'fetch', messaggio: `diario-sezioni-cockpit-non-lette: ${nomeErrore(err)}` }))
      .finally(() => { if (active) setScopedLoaded(true); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    if (!userId || !scuolaId || !storico) return;
    let attivo = true;
    fetch(`/api/admin/storici/catalogo?scuolaId=${scuolaId}&userId=${userId}`)
      .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (attivo) setClassiStoriche({ scuolaId, classi: (d.classiStoriche ?? []).map((s: { id: string; name: string }) => ({ ...s, school_type: '' })) }); })
      .catch((err: unknown) => logClient({ livello: 'warn', evento: 'fetch', messaggio: `diario-classi-storiche-non-lette: ${nomeErrore(err)}` }));
    return () => { attivo = false; };
  }, [scuolaId, userId, storico]);

  useEffect(() => {
    loadCompilati(sectionId, scuolaId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, scuolaId, userId, dataDiario]);

  const pickScuola = (id: string) => {
    setScuolaId(id);
    const g = scuole.find(s => s.scuolaId === id);
    setSectionId(g?.sezioni[0]?.id ?? null);
    setCompilati(null);
    day.resetSelection();
  };

  const pickSezione = (id: string) => {
    setSectionId(id);
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
        actions={<LinkStorici scuolaId={scuolaId || undefined} sectionId={sectionId ?? undefined} gruppo="diario" dal={dataDiario} al={dataDiario} />}
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
            <label className="flex items-center gap-2">
              <span className="font-maven text-sm text-kidville-ink/70">{t('diaryLabelData')}</span>
              <input type="date" value={dataDiario} max={todayISO()}
                className="rounded-xl border border-kidville-line bg-white px-3 py-2 font-maven text-sm"
                onChange={e => { if (e.target.value) {
                  setDataDiario(e.target.value); setCompilati(null); day.resetSelection();
                  if (e.target.value === todayISO() && !scuole.find(s => s.scuolaId === scuolaId)?.sezioni.some(s => s.id === sectionId)) setSectionId(scuole.find(s => s.scuolaId === scuolaId)?.sezioni[0]?.id ?? null);
                } }} />
            </label>
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
                value={sectionId ?? ''}
                onChange={pickSezione}
                options={(scuola?.sezioni ?? []).map(s => ({ value: s.id, label: `${s.name} (${s.school_type || t('diaryClasseStorica')})` }))}
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
              label={day.showAll ? t('diaryStatAlunniTutti') : t('diaryStatPresentiData')}
              value={day.isLoading ? '…' : day.students.length}
              sub={sezione ? t('diarySezioneSub', { sezione }) : undefined}
            />
            <StatCard
              icon={CheckCircle2}
              label={t('diaryStatCompilato')}
              value={compilati ?? '…'}
              sub={dataDiario}
              tone="yellow"
            />
          </div>

          {/* Presenti del giorno (appello delle maestre) */}
          {!day.isLoading && (
            <div className="rounded-card bg-kidville-white p-4 shadow-sm">
              <p className="font-barlow mb-2 text-xs font-bold uppercase tracking-wide text-kidville-green">
                {day.showAll ? t('diaryHeadingAlunni') : t('diaryStatPresentiData')}
              </p>
              {day.students.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted">
                  {day.showAll
                    ? t('diaryVuotoTutti')
                    : t('diaryVuotoPresentiData')}
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
