'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
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
        icon={BookOpen}
        title="Diario 0-6"
        subtitle="Presenze del giorno in consultazione (l'appello resta alle maestre) e compilazione/aggiornamento del diario di sezione."
      />

      {scopedLoaded && scuole.length === 0 ? (
        <div className="rounded-card bg-kidville-white p-8 text-center shadow-sm">
          <p className="font-maven text-sm text-kidville-muted">
            Nessuna sezione nido/infanzia nei tuoi plessi. Se non è quello che ti aspetti,
            verifica che il tuo profilo utente abbia una sede associata (Anagrafica → Staff).
          </p>
        </div>
      ) : (
        <>
          {/* Selettori sede/sezione + filtro presenze */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {scuole.length > 1 && (
              <label className="flex items-center gap-2">
                <span className="font-maven text-sm text-kidville-ink/70">Sede:</span>
                <CockpitSelect
                  value={scuolaId}
                  onChange={pickScuola}
                  options={scuole.map(s => ({ value: s.scuolaId, label: s.scuolaNome }))}
                />
              </label>
            )}
            <label className="flex items-center gap-2">
              <span className="font-maven text-sm text-kidville-ink/70">Sezione:</span>
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
              title={day.showAll ? 'Sto mostrando tutti i bambini' : 'Sto mostrando solo i presenti'}
            >
              <Users size={12} strokeWidth={1.5} /> {day.showAll ? 'Tutti' : 'Solo presenti'}
            </button>
          </div>

          {/* Stat del giorno */}
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:max-w-[560px]">
            <StatCard
              icon={Users}
              label={day.showAll ? 'Alunni (tutti)' : 'Presenti oggi'}
              value={day.isLoading ? '…' : day.students.length}
              sub={sezione ? `Sezione ${sezione}` : undefined}
            />
            <StatCard
              icon={CheckCircle2}
              label="Con diario compilato"
              value={compilati ?? '…'}
              sub="oggi"
              tone="yellow"
            />
          </div>

          {/* Presenti del giorno (appello delle maestre) */}
          {!day.isLoading && (
            <div className="rounded-card bg-kidville-white p-4 shadow-sm">
              <p className="font-barlow mb-2 text-xs font-bold uppercase tracking-wide text-kidville-green">
                {day.showAll ? 'Alunni della sezione' : 'Presenti oggi'}
              </p>
              {day.students.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted">
                  {day.showAll
                    ? 'Nessun alunno in questa sezione.'
                    : 'Nessuna presenza registrata oggi: l’appello non è ancora stato fatto (passa a "Tutti" per vedere comunque la sezione).'}
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
                <p className="font-maven text-sm text-kidville-muted">Caricamento alunni…</p>
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

export default function AdminDiaryPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <AdminDiaryInner />
    </Suspense>
  );
}
