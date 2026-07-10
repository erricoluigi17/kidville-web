'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Users, WifiOff } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor';

// Pagina mobile del docente: chrome (header, selettore sezione, filtri) attorno
// alla compilazione condivisa in DiaryEventEditor (usata anche da /admin/diary).

function TeacherDiaryInner() {
    const search = useSearchParams();
    const userId = getCurrentTeacherId(search);

    // Sezioni assegnate al docente (utenti_sezioni via /api/educator-sections):
    // niente più sezione hardcoded; con più sezioni compare il selettore a pill.
    const [sezioni, setSezioni] = useState<string[]>([]);
    const [sezione, setSezione] = useState<string | null>(null);
    const [sezioniLoaded, setSezioniLoaded] = useState(false);
    // true se il docente ha SOLO sezioni primaria e l'admin ha disattivato
    // l'esposizione del diario 0-6 alla primaria (empty-state dedicato).
    const [soloPrimariaNascosta, setSoloPrimariaNascosta] = useState(false);
    const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);

    const day = useDiaryDay(userId, sezione);

    useEffect(() => {
        let active = true;
        Promise.all([
            fetch(`/api/educator-sections?userId=${userId}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
            fetch(`/api/diary/config?userId=${userId}`).then(r => (r.ok ? r.json() : null)).catch(() => null),
        ])
            .then(([sec, conf]) => {
                if (!active) return;
                // Preferisci `sections` (con school_type); fallback su `sectionNames` (risposta vecchia).
                const raw: { name: string; school_type: string | null }[] = Array.isArray(sec?.sections)
                    ? sec.sections
                    : (Array.isArray(sec?.sectionNames) ? sec.sectionNames.map((n: string) => ({ name: n, school_type: null })) : []);
                const primariaVisibile = conf?.diario_primaria_visibile === true; // fail-closed: primaria esposta solo se attivata dall'admin
                const filtered = primariaVisibile ? raw : raw.filter(s => s.school_type !== 'primaria');
                const names = filtered.map(s => s.name);
                setSezioni(names);
                setSezione(cur => cur ?? names[0] ?? null);
                setSoloPrimariaNascosta(!primariaVisibile && raw.length > 0 && names.length === 0);
            })
            .finally(() => { if (active) setSezioniLoaded(true); });
        return () => { active = false; };
    }, [userId]);

    // Listener connettività (una volta).
    useEffect(() => {
        const onOnline = () => setIsOffline(false);
        const onOffline = () => setIsOffline(true);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); };
    }, []);

    // Cambio sezione manuale: la selezione evento e i "salvati" riguardavano la
    // sezione precedente, quindi si azzerano insieme (reset nell'handler, non in
    // un effect: react-hooks/set-state-in-effect).
    const switchSezione = (name: string) => {
        setSezione(name);
        day.resetSelection();
    };

    if (sezioniLoaded && !sezione) {
        return (
            <div className="mx-auto max-w-[460px] px-4 pt-5">
                <div className="rounded-3xl bg-kidville-green px-5 py-5" style={{ boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}>
                    <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow">In sezione</p>
                    <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">Diario del giorno</h1>
                </div>
                <div className="mt-4 rounded-3xl border border-kidville-line bg-white p-8 text-center shadow-sm">
                    <p className="font-maven text-sm text-kidville-muted">
                        {soloPrimariaNascosta ? (
                            <>Il diario 0-6 non è attivo per la primaria.<br />Per la tua classe usa il <strong>Registro</strong>.</>
                        ) : (
                            <>Nessuna sezione assegnata al tuo profilo.<br />Chiedi alla segreteria di abbinarti alla tua sezione.</>
                        )}
                    </p>
                </div>
            </div>
        );
    }

    if (day.isLoading) {
        return (
            <div className="max-w-2xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-kidville-muted">Caricamento alunni da Supabase...</p>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">

            {/* Header verde (DR) */}
            <div className="rounded-3xl bg-kidville-green px-5 py-5" style={{ boxShadow: '0 16px 34px -18px rgba(0,60,52,.6)' }}>
                <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow">In sezione</p>
                <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-white">Diario del giorno</h1>
                <p className="mt-1.5 font-maven text-xs capitalize text-white/80">
                    Sezione {sezione} • {new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}
                </p>
            </div>

            {/* Selettore sezione (solo con più sezioni assegnate) */}
            {sezioni.length > 1 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    {sezioni.map(name => (
                        <button
                            key={name}
                            onClick={() => switchSezione(name)}
                            className={`rounded-pill border px-3 py-1.5 font-maven text-xs font-semibold transition-colors ${
                                sezione === name
                                    ? 'border-kidville-green/20 bg-kidville-green text-kidville-yellow'
                                    : 'border-kidville-line bg-white text-kidville-muted'
                            }`}
                            aria-pressed={sezione === name}
                        >
                            {name}
                        </button>
                    ))}
                </div>
            )}

            {/* Controlli (filtro presenze + offline) */}
            <div className="mt-3 flex items-center gap-2">
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
                {isOffline && (
                    <div className="flex items-center gap-1.5 rounded-pill border border-kidville-warn/30 bg-kidville-warn-soft px-3 py-1.5 font-maven text-xs text-kidville-warn">
                        <WifiOff size={12} strokeWidth={1.5} /> Offline
                    </div>
                )}
            </div>

            <DiaryEventEditor day={day} sezione={sezione} />
        </div>
    );
}

export default function TeacherDiaryPage() {
    return (
        <Suspense fallback={null}>
            <TeacherDiaryInner />
        </Suspense>
    );
}
