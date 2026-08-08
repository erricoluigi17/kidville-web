'use client';

import { useState, useEffect, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { useClientValue } from '@/lib/hooks/use-client-value';
import { useSearchParams } from 'next/navigation';
import { Users, WifiOff } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useDiaryDay, DiaryEventEditor } from '@/components/features/teacher/diary/DiaryEventEditor';
import { fetchDiarioConfig } from '@/lib/diary/config-cache';
import { fetchEducatorSections, sezioniDallaRisposta } from '@/lib/sezioni/educator-sections-cache';

// Pagina mobile del docente: chrome (header, selettore sezione, filtri) attorno
// alla compilazione condivisa in DiaryEventEditor (usata anche da /admin/diary).

function TeacherDiaryInner() {
    const t = useTranslations('teacherDiario');
    const f = useDateFormat();
    const search = useSearchParams();
    const userId = getCurrentTeacherId(search);

    // La data di OGGI si calcola solo lato client (stesso pattern del saluto
    // orario in /admin e /teacher). Formattarla nel corpo del render la faceva
    // nascere due volte: sul server, che su Vercel ha l'orologio in UTC, e nel
    // browser del docente, in Europe/Rome. Fra le 00:00 e le 02:00 italiane le
    // due date sono GIORNI diversi — l'HTML servito portava quello prima, e
    // React segnalava il disallineamento di idratazione. Il fuso ora è
    // dichiarato (`intlDateTime`), ma non basta: `new Date()` è comunque un
    // valore diverso sui due lati, quindi il calcolo resta client-only.
    const oggiEsteso = useClientValue(
        () => intlDateTime(f.locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()),
        '',
    );

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
        // Entrambe passano dalle cache di modulo condivise: la stessa GET la
        // chiedono anche `useDiaryDay` (config) e la bottom-nav, e in `next dev`
        // StrictMode raddoppia ogni effect. Erano 4 config + 2 sezioni per un
        // solo ingresso in pagina — ~14 s prima di poter toccare un pulsante.
        Promise.all([
            fetchEducatorSections(userId),
            fetchDiarioConfig(userId),
        ])
            .then(([sec, conf]) => {
                if (!active) return;
                // Preferisci `sections` (con school_type); fallback su `sectionNames` (risposta vecchia).
                const raw = sezioniDallaRisposta(sec);
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
                <PageHeaderCard eyebrow={t('inSezione')} title={t('diarioDelGiorno')} />
                <div className="mt-4 rounded-3xl border border-kidville-line bg-white p-8 text-center shadow-sm">
                    <p className="font-maven text-sm text-kidville-muted">
                        {soloPrimariaNascosta
                            ? t.rich('emptyPrimaria', { br: () => <br />, strong: (chunks) => <strong>{chunks}</strong> })
                            : t.rich('emptyNessunaSezione', { br: () => <br /> })}
                    </p>
                </div>
            </div>
        );
    }

    if (day.isLoading) {
        return (
            <div className="max-w-2xl mx-auto p-4 sm:p-6 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-kidville-muted">{t('inCaricamento')}</p>
            </div>
        );
    }

    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">

            {/* Header verde (DR) */}
            <PageHeaderCard
                eyebrow={t('inSezione')}
                title={t('diarioDelGiorno')}
                // Niente `capitalize`: la data qui sta in MEZZO alla frase
                // («Sezione Girasoli • sabato 8 agosto»), dove l'italiano vuole
                // il giorno e il mese minuscoli. La classe CSS alzava l'iniziale
                // di ogni parola — regola inglese — e deformava sia la data sia
                // il nome della sezione. Vedi src/lib/i18n/date.ts (`conIniziale`).
                subtitle={t('sottotitoloSezione', {
                    sezione: sezione ?? '',
                    data: oggiEsteso,
                })}
            />

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
                    title={day.showAll ? t('titleTutti') : t('titlePresenti')}
                >
                    <Users size={12} strokeWidth={1.5} /> {day.showAll ? t('filtroTutti') : t('filtroPresenti')}
                </button>
                {isOffline && (
                    <div className="flex items-center gap-1.5 rounded-pill border border-kidville-warn/30 bg-kidville-warn-soft px-3 py-1.5 font-maven text-xs text-kidville-warn">
                        <WifiOff size={12} strokeWidth={1.5} /> {t('offline')}
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
