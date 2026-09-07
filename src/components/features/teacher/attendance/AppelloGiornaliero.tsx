'use client';

/**
 * IL MOTORE DELL'APPELLO 0-6 — la giornata di una sezione, senza cornice.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * ESTRATTO da `app/(dashboard)/teacher/attendance/page.tsx` il 2026-09-07, perché la
 * SEGRETERIA ne aveva bisogno: per nido e infanzia non esisteva nessuna vista
 * dell'appello fuori dall'area docente, e l'unica alternativa sarebbe stata un
 * copia-incolla di seicento righe destinato a divergere al primo ritocco.
 *
 * Cosa è rimasto nella pagina docente: SOLO la shell mobile — `max-w-[460px]`, la
 * `PageHeaderCard`, il selettore di sezione da `educator-sections`, i due tab. Tutto
 * ciò che sta qui dentro non sapeva già nulla di quella cornice: prende una sezione e
 * fa le proprie richieste.
 *
 * ⚠️ NESSUNA PROP `inCockpit`, ed è una scelta. `ClasseShell` ce l'ha perché È una
 * cornice e deve sapere chi la ospita; questo componente cornice non ne ha, e la
 * larghezza appartiene al contenitore — `max-w-[460px]` sotto `/teacher`, `CockpitPage`
 * sotto `/admin`. Una prop qui sarebbe la shell che cola dentro il contenuto.
 *
 * ⚠️ NON è una vista di sola lettura, nemmeno quando la monta la segreteria. Le route
 * dell'appello ammettono già `segreteria` (`requireDocente`) e `vedeTutteLeClassi` non
 * la restringe: nascondere i comandi sarebbe teatro, perché il permesso resta. Ogni
 * scrittura porta `registrato_da` con l'id di chi l'ha fatta.
 *
 * ⚠️ Il MOTIVO della giustifica (art. 9 GDPR) non arriva qui per chi vede tutte le
 * classi: `colonneConMotivo` non lo chiede nemmeno al database. La vista della
 * segreteria è muta per costruzione, non per un `if` in questo file.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Loader2, WifiOff, RefreshCw, ChevronLeft, ChevronRight, Calendar, Check } from 'lucide-react';
import { LocalDelegate } from '@/lib/offline/db';
import { StudentAttendanceRow, AttendanceRecord, AttendanceStato } from '@/components/features/teacher/StudentAttendanceRow';
import { CheckoutModal } from '@/components/features/teacher/CheckoutModal';
import { useOnlineStatus } from '@/lib/hooks/use-online-status';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { parametroClasse } from '@/lib/sezioni/parametro-classe';
import { formattaIstante } from '@/i18n/config';
import { conIniziale } from '@/lib/i18n/date';

// ─── Scala stati (token brand DR) ──────────────────────────────────────────────

// Solo i token cromatici di ciascuno stato; le etichette testuali vengono dal
// namespace i18n (nelle chip di Summary), non da qui.
const STATI: Record<string, { tint: string; soft: string }> = {
    presente: { tint: 'var(--color-kidville-success)', soft: 'var(--color-kidville-success-soft)' },
    ritardo: { tint: 'var(--color-kidville-warn)', soft: 'var(--color-kidville-warn-soft)' },
    uscita_anticipata: { tint: 'var(--color-kidville-info)', soft: 'var(--color-kidville-info-soft)' },
    assente: { tint: 'var(--color-kidville-neutral)', soft: 'var(--color-kidville-neutral-soft)' },
};

// ─── Tipi ─────────────────────────────────────────────────────────────────────

interface Student {
    id: string;
    firstName: string;
    lastName: string;
}

type FilterKey = 'tutti' | 'todo' | AttendanceStato;

// Da stato del record a chiave del namespace i18n: serve all'avviso di
// salvataggio fallito, che deve dire ANCHE cosa si stava registrando («Mario
// Rossi — Presente»). Letterali, non `string`, perché `t()` è tipizzata.
const CHIAVE_STATO = {
    presente: 'presente',
    ritardo: 'ritardo',
    assente: 'assente',
    uscita_anticipata: 'uscitaAnt',
} as const;

// ─── Tab ──────────────────────────────────────────────────────────────────────


// ─── Utility data ─────────────────────────────────────────────────────────────

function toISO(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(iso: string, n: number): string {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return toISO(d);
}

// La maiuscola iniziale sta QUI, dove il `locale` è noto, e non nella classe CSS
// `capitalize`: quella alzava anche l'iniziale del mese («Sabato 8 Agosto 2026»),
// che è la regola inglese applicata all'italiano. Vedi src/lib/i18n/date.ts.
function formatDataLunga(iso: string, locale: string): string {
    const d = new Date(iso + 'T12:00:00');
    return conIniziale(
        formattaIstante(d, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    );
}

// ─── Navigatore Data ─────────────────────────────────────────────────────────

function DateNavigator({ date, onChange }: { date: string; onChange: (d: string) => void }) {
    const t = useTranslations('teacherPresenze');
    const todayISO = toISO(new Date());
    const isToday = date === todayISO;

    return (
        <div className="flex items-center gap-2 rounded-2xl border border-kidville-line bg-kidville-cream p-2">
            <button
                onClick={() => onChange(addDays(date, -1))}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-kidville-green shadow-sm"
                title={t('giornoPrecedente')}
            >
                <ChevronLeft size={15} />
            </button>

            <div className="relative flex flex-1 items-center gap-2 rounded-xl bg-white px-3 py-1.5 shadow-sm">
                <Calendar size={14} className="flex-shrink-0 text-kidville-green" />
                <input
                    type="date"
                    value={date}
                    max={todayISO}
                    onChange={(e) => e.target.value && onChange(e.target.value)}
                    className="w-full cursor-pointer bg-transparent font-maven text-sm font-medium text-kidville-ink outline-none"
                />
            </div>

            <button
                onClick={() => !isToday && onChange(addDays(date, 1))}
                disabled={isToday}
                className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-kidville-green shadow-sm disabled:cursor-not-allowed disabled:opacity-30"
                title={t('giornoSuccessivo')}
            >
                <ChevronRight size={15} />
            </button>

            {!isToday && (
                <button
                    onClick={() => onChange(todayISO)}
                    className="rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-semibold text-kidville-yellow"
                >
                    {t('oggi')}
                </button>
            )}
        </div>
    );
}

// ─── Card riepilogo + filtro (DR Summary) ──────────────────────────────────────

function Summary({
    counts, total, filter, onFilter, sezione,
}: {
    counts: Record<string, number>;
    total: number;
    filter: FilterKey;
    onFilter: (f: FilterKey) => void;
    sezione: string;
}) {
    const t = useTranslations('teacherPresenze');
    const reg = (counts.presente ?? 0) + (counts.ritardo ?? 0) + (counts.uscita_anticipata ?? 0) + (counts.assente ?? 0);
    const safeTot = total || 1;
    const chips: { key: FilterKey; label: string; n: number; tint: string; soft: string }[] = [
        { key: 'tutti', label: t('tutti'), n: total, tint: 'var(--color-kidville-green)', soft: 'var(--color-kidville-green-soft)' },
        { key: 'presente', label: t('presenti'), n: counts.presente ?? 0, tint: STATI.presente.tint, soft: STATI.presente.soft },
        { key: 'ritardo', label: t('ritardo'), n: counts.ritardo ?? 0, tint: STATI.ritardo.tint, soft: STATI.ritardo.soft },
        { key: 'uscita_anticipata', label: t('uscita'), n: counts.uscita_anticipata ?? 0, tint: STATI.uscita_anticipata.tint, soft: STATI.uscita_anticipata.soft },
        { key: 'assente', label: t('assenti'), n: counts.assente ?? 0, tint: STATI.assente.tint, soft: STATI.assente.soft },
        { key: 'todo', label: t('daRegistrare'), n: total - reg, tint: 'var(--color-kidville-yellow-dark)', soft: 'var(--color-kidville-yellow-soft)' },
    ];

    return (
        <div>
            <div className="rounded-[20px] bg-white p-4" style={{ boxShadow: '0 1px 2px rgba(0,84,75,.05), 0 10px 28px -20px rgba(0,84,75,.4)' }}>
                <div className="flex items-end justify-between gap-3">
                    <div>
                        <div className="font-barlow text-[11px] font-bold uppercase tracking-[0.12em] text-kidville-yellow-dark">{t('sezioneCon', { sezione })}</div>
                        <div className="mt-0.5 flex items-baseline gap-1.5">
                            <span className="font-barlow text-[34px] font-black leading-none text-kidville-green">{reg}</span>
                            <span className="font-barlow text-lg font-extrabold text-kidville-sub">/ {total}</span>
                            <span className="ml-0.5 font-maven text-xs text-kidville-ink">{t('registrati')}</span>
                        </div>
                    </div>
                    {reg === total && total > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-success-soft px-2.5 py-1 font-barlow text-[10.5px] font-extrabold uppercase text-kidville-success"><Check size={11} strokeWidth={2.8} /> {t('completo')}</span>
                    ) : (
                        <span className="rounded-pill bg-kidville-yellow-soft px-2.5 py-1 font-barlow text-[10.5px] font-extrabold uppercase text-kidville-yellow-dark">{t('mancanti', { n: total - reg })}</span>
                    )}
                </div>
                <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-kidville-cream-dark">
                    <div style={{ width: `${(counts.presente ?? 0) / safeTot * 100}%`, background: STATI.presente.tint }} />
                    <div style={{ width: `${(counts.ritardo ?? 0) / safeTot * 100}%`, background: STATI.ritardo.tint }} />
                    <div style={{ width: `${(counts.uscita_anticipata ?? 0) / safeTot * 100}%`, background: STATI.uscita_anticipata.tint }} />
                    <div style={{ width: `${(counts.assente ?? 0) / safeTot * 100}%`, background: STATI.assente.tint }} />
                </div>
            </div>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {chips.map((c) => {
                    const on = filter === c.key;
                    return (
                        <button
                            key={c.key}
                            onClick={() => onFilter(c.key)}
                            className="flex shrink-0 items-center gap-1.5 rounded-pill bg-white py-1.5 pl-2 pr-3"
                            style={on ? { boxShadow: `inset 0 0 0 1.5px ${c.tint}`, background: c.soft } : { boxShadow: '0 1px 2px rgba(0,84,75,.05)' }}
                        >
                            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 font-barlow text-xs font-extrabold text-white" style={{ background: c.tint }}>{c.n}</span>
                            <span className="font-barlow text-xs font-extrabold uppercase tracking-wide" style={{ color: on ? c.tint : '#6c766f' }}>{c.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Vista Oggi ───────────────────────────────────────────────────────────────

export function AppelloGiornaliero({ sezione, sectionId }: { sezione: string; sectionId?: string }) {
    // L'uuid quando c'è, il nome quando no: la scelta sta in `parametroClasse`,
    // un posto solo per tutte e tre le chiamate qui sotto.
    const paramClasse = parametroClasse({ id: sectionId, name: sezione });
    const t = useTranslations('teacherPresenze');
    const locale = useLocale();
    const [selectedDate, setSelectedDate] = useState(toISO(new Date()));

    const [students, setStudents] = useState<Student[]>([]);
    const [records, setRecords] = useState<Record<string, AttendanceRecord>>({});
    const [delegates, setDelegates] = useState<LocalDelegate[]>([]);
    const [selectedCheckout, setSelectedCheckout] = useState<string | null>(null);
    const [loadingStudentId, setLoadingStudentId] = useState<string | null>(null);
    /**
     * Quale orario, di quale bambino, si sta salvando. Separato da
     * `loadingStudentId` di proposito: quello sostituisce l'INTERO gruppo di
     * bottoni con uno spinner, e usarlo qui farebbe sparire dagli occhi della
     * maestra proprio l'ora che sta correggendo.
     */
    const [orarioInCorso, setOrarioInCorso] = useState<{ studentId: string; campo: 'entrata' | 'uscita' } | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    /**
     * Salvataggi che il server NON ha accettato: `alunno_id` → stato che si
     * stava registrando. È una MAPPA e non un singolo errore di proposito: con
     * la rete che va e viene la maestra clicca dieci bambini di fila, e un
     * banner che mostra solo l'ultimo racconta che gli altri nove sono andati a
     * buon fine. Si svuota una riga alla volta, quando quella riga viene
     * salvata davvero.
     */
    const [erroriSalvataggio, setErroriSalvataggio] = useState<Record<string, AttendanceStato>>({});
    // SSR-safe (niente hydration mismatch né setState-in-effect).
    const isOffline = !useOnlineStatus();
    const [filter, setFilter] = useState<FilterKey>('tutti');

    // ── Fetch studenti reali dall'anagrafica Supabase ──
    // Restituisce null in caso di errore (rete o HTTP), mai eccezioni.
    const fetchStudents = useCallback(async (): Promise<Student[] | null> => {
        const res = await fetch(`/api/diary/students?${paramClasse}`).catch(() => null);
        if (!res?.ok) return null;
        const data = await res.json().catch(() => null);
        if (Array.isArray(data)) {
            return data.map((a: { id: string; nome: string; cognome: string }) => ({
                id: a.id,
                firstName: a.nome,
                lastName: a.cognome,
            }));
        }
        return [];
    }, [paramClasse]);

    // ── Fetch presenze del giorno selezionato da Supabase ──
    const fetchTodayRecords = useCallback(async () => {
        const res = await fetch(`/api/attendance/daily?data=${selectedDate}&${paramClasse}`).catch(() => null);
        const rows = res?.ok ? await res.json().catch(() => null) : null;
        const map: Record<string, AttendanceRecord> = {};
        if (Array.isArray(rows)) {
            rows.forEach((row: {
                alunno_id: string;
                id?: string;
                data: string;
                stato: AttendanceStato;
                orario_entrata: string | null;
                orario_uscita: string | null;
                giustificazione_testo?: string | null;
            }) => {
                map[row.alunno_id] = {
                    id: row.id,
                    alunno_id: row.alunno_id,
                    data: row.data,
                    stato: row.stato,
                    orario_entrata: row.orario_entrata,
                    orario_uscita: row.orario_uscita,
                    // Il motivo che il genitore ha comunicato: la riga lo mostra
                    // (vedi `StudentAttendanceRow`). È il dato che rende vera la
                    // frase mostrata alla famiglia al momento della raccolta.
                    giustificazione_testo: row.giustificazione_testo ?? null,
                };
            });
        }
        setRecords(map);
    }, [selectedDate, paramClasse]);

    // ── Fetch delegati ──
    const fetchDelegates = useCallback(async () => {
        try {
            const res = await fetch(`/api/attendance/delegates?${paramClasse}`);
            if (!res.ok) return;
            const data = await res.json();
            if (Array.isArray(data)) setDelegates(data);
        } catch { /* non bloccante */ }
    }, [paramClasse]);

    // ── Caricamento iniziale ──
    const loadAll = useCallback(async () => {
        try {
            const [studs] = await Promise.all([
                fetchStudents(),
                fetchTodayRecords(),
                fetchDelegates(),
            ]);
            if (studs) {
                setStudents(studs);
                setError(null);
            } else {
                setError(t('erroreCaricamentoAlunni'));
            }
        } finally {
            setIsLoading(false);
        }
    }, [fetchStudents, fetchTodayRecords, fetchDelegates, t]);

    useEffect(() => {
        loadAll();
    }, [loadAll]);

    // ── Cambia stato — scrive DIRETTAMENTE su Supabase ──
    const handleSetStato = async (studentId: string, stato: AttendanceStato) => {
        setLoadingStudentId(studentId);
        const now = new Date().toISOString();

        const orario_entrata = stato === 'assente' ? null : (records[studentId]?.orario_entrata ?? now);
        // `?? now` e non `now`, simmetrico alla riga sopra. Con `now` secco, ogni
        // ri-salvataggio di un'uscita anticipata — e `CheckoutModal` ne fa uno —
        // riscriveva l'ora del TOCCO sopra quella appena rettificata a mano.
        const orario_uscita = stato === 'uscita_anticipata' ? (records[studentId]?.orario_uscita ?? now) : null;

        // Ottimistic update. Si PARTE dal record precedente invece di ricostruirlo
        // da zero: il motivo comunicato dal genitore non arriva dalla POST (la
        // risposta porta solo le colonne dell'appello, vedi `COLONNE_ESITO`), e
        // ricreando l'oggetto sparirebbe dalla riga appena la maestra tocca un
        // bottone — cioè proprio mentre lo sta leggendo.
        setRecords(prev => ({
            ...prev,
            [studentId]: {
                ...prev[studentId],
                alunno_id: studentId,
                data: selectedDate,
                stato,
                orario_entrata,
                orario_uscita,
            }
        }));

        // Lo STATO della risposta va tenuto fuori dal `try`: nel `catch` non c'è
        // più la `res`, e senza lo stato la riga di log dice che il salvataggio è
        // fallito ma non perché. Non è un dettaglio: il logger di rete scarta di
        // proposito i 401/400 (`livelloFetch`, per non annegare `app_log`), quindi
        // un appello respinto per SESSIONE SCADUTA non lasciava NESSUNA traccia
        // leggibile — misurato in produzione il 2026-08-02. «Riprova» e «rifai il
        // login» sono due rimedi diversi, e alle 3 di notte si distinguono solo da
        // qui. Resta `undefined` se la risposta non è mai arrivata (rete giù):
        // meglio nessuno stato che uno inventato.
        let statoHttp: number | undefined;
        try {
            const res = await fetch('/api/attendance/daily', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: studentId, data: selectedDate, stato, orario_entrata, orario_uscita }),
            });
            statoHttp = res.status;
            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error ?? 'Errore salvataggio');
            }
            const saved = await res.json();
            // Si FONDE, non si sostituisce: la risposta del salvataggio dichiara
            // le sei colonne dell'appello e non il motivo del genitore, che resta
            // quello già in mano al client.
            setRecords(prev => ({ ...prev, [studentId]: { ...prev[studentId], ...saved } }));
            // Questa riga è salvata: se era in errore, esce dall'avviso.
            setErroriSalvataggio(prev => {
                if (!(studentId in prev)) return prev;
                const next = { ...prev };
                delete next[studentId];
                return next;
            });
        } catch (err) {
            // `err` qui è spesso l'errore del server sul record presenza: il suo `.message`
            // riecheggia `alunno_id` e lo stato del bambino. Esce solo la classe dell'errore.
            logClient({ livello: 'error', evento: 'fetch', messaggio: `presenza-salvataggio-fallito: ${nomeErrore(err)}`, route: '/teacher/attendance', stato: statoHttp });
            // Rollback ottimistico
            setRecords(prev => {
                const next = { ...prev };
                delete next[studentId];
                return next;
            });
            // …e SUBITO l'avviso a schermo. Il rollback da solo è ingannevole:
            // per un secondo la riga ha mostrato l'orario d'ingresso, poi è
            // tornata com'era. Chi ha appena cliccato «Presente» legge quella
            // sequenza come «fatto» e va avanti — il bambino resta non
            // registrato e nessuno lo sa fino al giorno dopo, quando qualcuno
            // legge i log. Il log serve a noi; questo serve a lei.
            setErroriSalvataggio(prev => ({ ...prev, [studentId]: stato }));
        } finally {
            setLoadingStudentId(null);
        }
    };

    /**
     * ── RETTIFICA DI UN ORARIO ──────────────────────────────────────────────
     *
     * Handler SUO, e non `handleSetStato` con un parametro in più. La POST è un
     * upsert della riga intera: passando di lì per cambiare l'ingresso si
     * azzererebbe l'uscita (vedi le due righe di `handleSetStato`), si riasserirebbe
     * lo stato e si rientrerebbe nel ramo che revoca le notifiche d'assenza. La
     * PATCH nomina una colonna sola, e una `.update()` non può azzerare quella che
     * non nomina.
     *
     * Sul filo va `HH:MM`, non un istante: l'ISO matcha `DATA_ISO` in
     * `@/lib/logging/redact` e uscirebbe in chiaro in `app_log` su ogni 400 — cioè
     * l'ora d'arrivo di un bambino. La conversione la fa il server, col fuso di
     * Roma, invece che l'orologio di questo tablet.
     */
    const handleSetOrario = async (studentId: string, campo: 'entrata' | 'uscita', ora: string) => {
        const chiave = campo === 'entrata' ? 'orario_entrata' : 'orario_uscita';
        setOrarioInCorso({ studentId, campo });
        const precedente = records[studentId];

        // Ottimistico sul SOLO campo toccato: si parte dal record precedente, come
        // fa `handleSetStato`, perché il motivo comunicato dal genitore non torna
        // dalla risposta e ricreando l'oggetto sparirebbe dalla riga.
        setRecords(prev => ({
            ...prev,
            [studentId]: { ...prev[studentId], [chiave]: ora },
        }));

        let statoHttp: number | undefined;
        try {
            const res = await fetch('/api/attendance/daily', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunno_id: studentId, data: selectedDate, [chiave]: ora }),
            });
            statoHttp = res.status;
            if (!res.ok) throw new Error('Rettifica rifiutata');
            const saved = await res.json();
            setRecords(prev => ({ ...prev, [studentId]: { ...prev[studentId], ...saved } }));
            setErroriSalvataggio(prev => {
                if (!(studentId in prev)) return prev;
                const next = { ...prev };
                delete next[studentId];
                return next;
            });
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `orario-rettifica-fallita: ${nomeErrore(err)}`, route: '/teacher/attendance', stato: statoHttp });
            // Rollback del solo campo, e SUBITO l'avviso: il rollback da solo è
            // ingannevole, perché per un istante la riga ha mostrato l'ora nuova.
            setRecords(prev => ({ ...prev, [studentId]: precedente ?? prev[studentId] }));
            setErroriSalvataggio(prev => ({ ...prev, [studentId]: prev[studentId] ?? (precedente?.stato ?? 'presente') }));
        } finally {
            setOrarioInCorso(null);
        }
    };

    // ── Panic alert ──
    const handlePanicAlert = async () => {
        if (!selectedCheckout) return;
        try {
            const res = await fetch('/api/panic-alert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alunnoId: selectedCheckout }),
            });
            if (res.ok) {
                alert(t('allarmeInviato'));
                setSelectedCheckout(null);
            } else {
                alert(t('erroreInvioAllarme'));
            }
        } catch {
            alert(t('erroreReteAllarme'));
        }
    };

    // ── Checkout delegato ──
    const handleConfirmCheckout = async () => {
        if (!selectedCheckout) return;
        await handleSetStato(selectedCheckout, 'uscita_anticipata');
        setSelectedCheckout(null);
    };

    const checkoutStudent = students.find(s => s.id === selectedCheckout);
    const studentDelegates = delegates.filter(d => d.alunno_id === selectedCheckout);

    const counts = useMemo(() => {
        const c: Record<string, number> = { presente: 0, ritardo: 0, uscita_anticipata: 0, assente: 0 };
        Object.values(records).forEach((r) => { if (r.stato in c) c[r.stato] += 1; });
        return c;
    }, [records]);

    // Righe da mostrare nell'avviso: solo quelle di cui si conosce il bambino
    // (l'elenco alunni è già caricato quando si clicca, ma se un giorno non lo
    // fosse un avviso senza nome sarebbe peggio di nessun avviso).
    const righeNonSalvate = useMemo(
        () => Object.entries(erroriSalvataggio).flatMap(([id, stato]) => {
            const alunno = students.find(s => s.id === id);
            return alunno ? [{ id, stato, nome: `${alunno.firstName} ${alunno.lastName}` }] : [];
        }),
        [erroriSalvataggio, students],
    );

    const visibleStudents = useMemo(() => {
        if (filter === 'tutti') return students;
        if (filter === 'todo') return students.filter((s) => !records[s.id]);
        return students.filter((s) => records[s.id]?.stato === filter);
    }, [students, records, filter]);

    // ── Stati UI ──
    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
                <Loader2 size={32} className="animate-spin text-kidville-green" />
                <p className="font-maven text-sm text-kidville-sub">{t('caricamentoAlunni')}</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
                <p className="font-maven text-sm text-kidville-error">⚠️ {error}</p>
                <button
                    onClick={loadAll}
                    className="flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-maven text-sm text-kidville-yellow"
                >
                    <RefreshCw size={14} /> {t('riprova')}
                </button>
            </div>
        );
    }

    if (students.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center gap-4 py-20">
                <span className="text-5xl opacity-30">👶</span>
                <p className="text-center font-maven text-sm text-kidville-sub">
                    {t('nessunAlunnoPre')} <strong>{sezione}</strong>.<br />
                    {t('nessunAlunnoAiuto')}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {/* Navigatore data + intestazione */}
            <div className="flex flex-col gap-3 rounded-2xl border border-kidville-line bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-maven text-sm text-kidville-sub">{formatDataLunga(selectedDate, locale)}</p>
                    <div className="flex items-center gap-2">
                        {isOffline && (
                            <div className="flex items-center gap-1.5 rounded-pill border border-kidville-warn/30 bg-kidville-warn-soft px-3 py-1.5 font-maven text-xs text-kidville-warn">
                                <WifiOff size={12} /> {t('offline')}
                            </div>
                        )}
                        <button
                            onClick={fetchTodayRecords}
                            title={t('aggiornaPresenze')}
                            className="flex h-8 w-8 items-center justify-center rounded-xl bg-kidville-cream text-kidville-sub transition-colors hover:text-kidville-green"
                        >
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>
                <DateNavigator date={selectedDate} onChange={setSelectedDate} />
            </div>

            {/* Card riepilogo + chip filtro */}
            <Summary counts={counts} total={students.length} filter={filter} onFilter={setFilter} sezione={sezione} />

            {/* Presenze che il server ha rifiutato. Sta QUI, sopra la lista e
                sotto il contatore, perché è lì che l'occhio torna dopo il click.
                `role="alert"` lo fa annunciare anche a chi non guarda lo schermo. */}
            {righeNonSalvate.length > 0 && (
                <div
                    role="alert"
                    /* `kv-appello-avviso` è il marcatore che porta questa fascia
                       dentro l'Alto Contrasto (globals.css, accanto a
                       `.kv-mensa-alt`): senza, restava identica alla luce
                       normale mentre il resto della schermata si ribaltava.
                       `.kv-appello-row` sta sulle righe alunno, non qui. */
                    className="kv-appello-avviso flex flex-col gap-2 rounded-2xl border border-kidville-error/30 bg-kidville-error-soft p-4"
                >
                    <p className="font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-error-strong">
                        {t('salvataggioFallito')}
                    </p>
                    <ul className="flex flex-col gap-2">
                        {righeNonSalvate.map(({ id, stato, nome }) => (
                            <li key={id} className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-maven text-sm text-kidville-ink">
                                    <strong className="font-semibold">{nome}</strong>
                                    {' — '}
                                    {t(CHIAVE_STATO[stato])}
                                </span>
                                <button
                                    onClick={() => handleSetStato(id, stato)}
                                    aria-label={t('riprovaPer', { alunno: nome })}
                                    className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-semibold text-kidville-yellow"
                                >
                                    <RefreshCw size={13} /> {t('riprova')}
                                </button>
                            </li>
                        ))}
                    </ul>
                    <p className="font-maven text-xs text-kidville-ink/80">{t('salvataggioFallitoAiuto')}</p>
                </div>
            )}

            {/* Lista studenti (filtrata) */}
            <div className="flex flex-col gap-2">
                {visibleStudents.map(student => (
                    <StudentAttendanceRow
                        key={student.id}
                        student={student}
                        record={records[student.id]}
                        onSetStato={handleSetStato}
                        onCheckoutClick={setSelectedCheckout}
                        isLoading={loadingStudentId === student.id}
                        onSetOrario={handleSetOrario}
                        orarioInCorso={orarioInCorso?.studentId === student.id ? orarioInCorso.campo : null}
                    />
                ))}
                {visibleStudents.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-kidville-line bg-white/60 p-6 text-center font-maven text-sm text-kidville-sub">
                        {t('nessunAlunnoFiltro')}
                    </div>
                )}
            </div>

            {/* Modal uscita delegato */}
            {selectedCheckout && checkoutStudent && (
                <CheckoutModal
                    studentName={`${checkoutStudent.firstName} ${checkoutStudent.lastName}`}
                    delegates={studentDelegates}
                    onClose={() => setSelectedCheckout(null)}
                    onConfirmCheckout={handleConfirmCheckout}
                    onPanicAlert={handlePanicAlert}
                />
            )}
        </div>
    );
}
