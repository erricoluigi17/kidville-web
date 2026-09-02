'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import {
    CheckCircle2, Clock, ChevronDown, Package, Bell,
    Table2, ChevronLeft, ChevronRight, RefreshCw, Zap, AlertTriangle,
} from 'lucide-react';
import {
    MonthlyLockerTable,
    type StudentInfo,
} from '@/components/features/teacher/locker/MonthlyLockerTable';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * La forma che `GET /api/locker/requests?alunno_id=` restituisce davvero.
 *
 * ⚠️ Fino al 2026-09-01 questo tipo descriveva `locker_requests`, la tabella del
 * vecchio schema a saldo che NESSUNA migrazione applicata crea: oggetto annidato
 * `locker_catalog`, stati inglesi, `livello_alert`. La route legge
 * `armadietto_richieste`, dove il materiale è una COLONNA PIATTA (stessa chiave di
 * `armadietto.materiale`, non una FK verso `locker_config` — quella tabella è
 * legittimamente vuota). Il tipo sbagliato non faceva rumore: la lista è
 * condizionata a `length > 0`, e con la tabella assente restava semplicemente
 * invisibile.
 */
interface LockerRequest {
    id: string;
    alunno_id: string;
    materiale: string;
    livello: 'giallo' | 'rosso';
    quantita_residua: number;
    stato: 'aperta' | 'presa_in_carico' | 'evasa';
    presa_in_carico_il: string | null;
    evasa_il: string | null;
    creato_il: string;
}

/**
 * Un materiale come lo descrive `GET /api/locker/materials`: soglie e icona.
 *
 * Le soglie NON si cablano qui. Quelle che stavano a riga 400 (`gialla = 5`,
 * `rossa = 2`) erano già sbagliate il giorno in cui sono state scritte: il listino
 * vero (`src/lib/armadietto/materiali-default.ts`, l'unica copia) dice Crema 3/1 e
 * Cambio 2/1. Due schermate che decidono da sé quando un materiale è «esaurito»
 * sono due schermate che un giorno dicono cose diverse allo stesso genitore.
 */
interface MaterialeConfig {
    icona: string;
    unita: string;
    livello_allerta: number;
    livello_emergenza: number;
}

// Ritorna una CHIAVE di traduzione (`labelKey`) invece del testo: la funzione è
// module-level e non può usare l'hook — la label si traduce al render con `t`.
function getSemaforoUI(qty: number, gialla: number, rossa: number) {
    if (qty <= rossa) return {
        bg: 'bg-kidville-error-soft',
        border: 'border-kidville-error/30',
        text: 'text-kidville-error',
        icon: '🔴',
        labelKey: 'lockerStatoEsaurito',
        barColor: 'bg-kidville-error',
    };
    if (qty <= gialla) return {
        bg: 'bg-kidville-warn-soft',
        border: 'border-kidville-warn/30',
        text: 'text-kidville-warn',
        icon: '🟡',
        labelKey: 'lockerStatoInEsaurimento',
        barColor: 'bg-kidville-warn',
    };
    return {
        bg: 'bg-kidville-success-soft',
        border: 'border-kidville-success/30',
        text: 'text-kidville-success',
        icon: '🟢',
        labelKey: 'lockerStatoOk',
        barColor: 'bg-kidville-success',
    };
}

/**
 * Indicizza per NOME la risposta di `/api/locker/materials`.
 *
 * La route restituisce le righe di `locker_config` oppure — ed è il caso normale
 * al 2026-09-01, perché la tabella è vuota per decisione del titolare —
 * `MATERIALI_DEFAULT`. Le due forme hanno le stesse colonne, quindi qui non serve
 * distinguerle. Ciò che NON si fa è inventare un valore mancante: una riga senza
 * soglie numeriche viene scartata, e il materiale resterà senza semaforo.
 */
function indicizzaMateriali(righe: unknown[]): Record<string, MaterialeConfig> {
    const mappa: Record<string, MaterialeConfig> = {};
    for (const riga of righe) {
        if (riga === null || typeof riga !== 'object') continue;
        const m = riga as Record<string, unknown>;
        if (typeof m.nome !== 'string' || m.nome === '') continue;
        if (typeof m.livello_allerta !== 'number' || typeof m.livello_emergenza !== 'number') continue;
        mappa[m.nome] = {
            icona: typeof m.icona === 'string' && m.icona !== '' ? m.icona : '📦',
            unita: typeof m.unita === 'string' && m.unita !== '' ? m.unita : 'pz',
            livello_allerta: m.livello_allerta,
            livello_emergenza: m.livello_emergenza,
        };
    }
    return mappa;
}

/** Una riga di `mode=carico`: un giorno in cui il genitore ha consegnato qualcosa. */
interface RigaCarico {
    nome_oggetto: string;
    date: string;
    materiale?: string;
    quantita?: number;
}

/**
 * ⚠️ PERCHÉ IL `try/catch` VIVE QUI E NON DENTRO IL COMPONENTE.
 *
 * Fino al 2026-09-01 `fetchData` e `fetchMonthly` avevano `try/finally` **senza
 * `catch`**: un errore di rete diventava una unhandled rejection e il genitore
 * vedeva una lista vuota — cioè «non ti serve niente» al posto di «non ho potuto
 * guardare». Aggiungere il `catch` dentro il componente, però, rende rosso il
 * gate: `react-hooks/set-state-in-effect` (React Compiler) considera il ramo
 * `catch` di una funzione chiamata da `useEffect` raggiungibile SINCRONICAMENTE,
 * e ogni `setState` che ne discende diventa un errore ESLint. È la ragione per cui
 * mezzo repo usa `try/finally` e delega l'osservabilità al patch globale di
 * `fetch` — che però NON vede `res.json()` su un corpo malformato, e non può
 * accendere nessuno stato d'errore a schermo.
 *
 * Qui il `catch` c'è, logga, e sta in una funzione di MODULO: nessun `setState`
 * dentro, quindi l'analizzatore non ha niente da segnalare. Il chiamante riceve
 * `null` — «non ho potuto guardare», che è diverso da «non c'è niente» — e decide
 * cosa mostrare.
 *
 * Nel messaggio non entra mai il nome di un bambino: solo uno slug fisso e il
 * NOME della classe d'errore (`nomeErrore`), che è struttura, non contenuto.
 */
async function caricaPanoramica(
    studentId: string,
    classeSezione: string,
): Promise<{
    stock: { materiale: string; stock: number }[];
    richieste: LockerRequest[];
    materiali: Record<string, MaterialeConfig> | null;
} | null> {
    try {
        // mode=stock: ritorna [{materiale, stock}] con stock aggregato reale.
        // La terza chiamata sono le SOGLIE, e si fa solo con la sezione in mano:
        // senza `classe_sezione` la route non filtra per plesso e risponderebbe
        // con la configurazione di tutte le sedi. Meglio nessun semaforo che il
        // semaforo di un'altra scuola.
        const [stockRes, reqRes, matRes] = await Promise.all([
            fetch(`/api/locker/inventory?alunno_id=${studentId}&mode=stock`),
            fetch(`/api/locker/requests?alunno_id=${studentId}`),
            classeSezione
                ? fetch(`/api/locker/materials?classe_sezione=${encodeURIComponent(classeSezione)}`)
                : Promise.resolve(null),
        ]);

        const stockJson: unknown = await stockRes.json();
        const reqData: unknown = await reqRes.json();
        const matData: unknown = matRes ? await matRes.json() : null;

        return {
            stock: Array.isArray(stockJson) ? stockJson : [],
            richieste: Array.isArray(reqData) ? reqData : [],
            materiali: Array.isArray(matData) ? indicizzaMateriali(matData) : null,
        };
    } catch (err) {
        logClient({
            livello: 'error', evento: 'fetch',
            messaggio: `armadietto-genitore-caricamento-fallito: ${nomeErrore(err)}`,
            route: '/parent/locker',
        });
        return null;
    }
}

/** Il mese di consegne, o `null` se non si è potuto leggere. Vedi `caricaPanoramica`. */
async function caricaMensile(studentId: string, ym: string): Promise<RigaCarico[] | null> {
    try {
        // mode=carico → solo giorni in cui il genitore ha consegnato
        const res = await fetch(
            `/api/locker/inventory?alunno_id=${studentId}&mode=carico&month=${ym}`
        );
        const data: unknown = await res.json();
        return Array.isArray(data) ? (data as RigaCarico[]) : [];
    } catch (err) {
        logClient({
            livello: 'error', evento: 'fetch',
            messaggio: `armadietto-genitore-mensile-fallito: ${nomeErrore(err)}`,
            route: '/parent/locker',
        });
        return null;
    }
}

// ── Helper mesi ───────────────────────────────────────────────────────────────

function currentYearMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function prevMonth(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function nextMonth(ym: string): string {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────

function LockerInner() {
    // Identità reale (niente ID/nome hardcoded): come le altre pagine genitore.
    const t = useTranslations('parentServizi');
    const { studentId, ready } = useParentIdentity();
    const f = useDateFormat();
    const [childName, setChildName] = useState('');
    // La sezione del bambino: è la chiave con cui si chiedono le SOGLIE al server.
    // Arriva dalla stessa risposta che già dava il nome — nessuna chiamata in più.
    const [classeSezione, setClasseSezione] = useState('');
    useEffect(() => {
        if (!studentId) return;
        fetch(`/api/diary/students?id=${studentId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                if (d?.nome) setChildName(d.nome);
                if (typeof d?.classe_sezione === 'string') setClasseSezione(d.classe_sezione);
            })
            .catch(() => {});
    }, [studentId]);

    const [activeTab, setActiveTab] = useState<'overview' | 'monthly'>('overview');
    const [month, setMonth]         = useState(currentYearMonth());

    const [stockData, setStockData]   = useState<{ materiale: string; stock: number }[]>([]);
    const [requests, setRequests]     = useState<LockerRequest[]>([]);
    const [monthlyData, setMonthlyData] = useState<StudentInfo[]>([]);
    // Soglie e icone per materiale. Vuoto finché il server non ha risposto: un
    // materiale che non c'è si mostra SENZA semaforo, non con soglie inventate.
    const [materiali, setMateriali]   = useState<Record<string, MaterialeConfig>>({});

    const [isLoading, setIsLoading]               = useState(true);
    const [isMonthlyLoading, setIsMonthlyLoading] = useState(true);
    const [errore, setErrore]                     = useState(false);
    const [erroreMensile, setErroreMensile]       = useState(false);
    const [showHistory, setShowHistory]           = useState(false);
    const [savingId, setSavingId]                 = useState<string | null>(null);
    const [showToast, setShowToast]               = useState(false);
    const [toastMessage, setToastMessage]         = useState('');
    const [lastUpdated, setLastUpdated]           = useState<Date | null>(null);
    const [realtimePulse, setRealtimePulse]       = useState(false);
    const prevStockRef = useRef<string>('');

    // ── Fetch overview (usa mode=stock per numeri precisi) ──────────────────────────────
    const fetchData = useCallback(async (silent = false) => {
        if (!studentId) return; // identità non risolta: evita ?alunno_id=null (400/500); render gestisce loading/empty
        try {
            const dati = await caricaPanoramica(studentId, classeSezione);
            if (dati === null) {
                // `caricaPanoramica` ha già lasciato la riga di log: qui si dice
                // all'utente ciò che prima non gli veniva detto.
                setErrore(true);
            } else {
                const signature = JSON.stringify(dati.stock);
                // Lampeggia solo se i dati sono EFFETTIVAMENTE cambiati
                if (signature !== prevStockRef.current) {
                    prevStockRef.current = signature;
                    setLastUpdated(new Date());
                    setRealtimePulse(true);
                    setTimeout(() => setRealtimePulse(false), 2000);
                }
                setStockData(dati.stock);
                setRequests(dati.richieste);
                if (dati.materiali !== null) setMateriali(dati.materiali);
                setErrore(false);
            }
        } finally {
            if (!silent) setIsLoading(false);
        }
    }, [studentId, classeSezione]);

    // ── Fetch tabella mensile (solo per il figlio corrente) ───────────────────
    const fetchMonthly = useCallback(async (ym: string) => {
        if (!studentId) return; // identità non risolta
        try {
            const righe = await caricaMensile(studentId, ym);
            if (righe === null) {
                setErroreMensile(true);
            } else {
                setMonthlyData([
                    {
                        id: studentId,
                        nome: childName,
                        cognome: '',
                        inventario: righe.map((item) => ({
                            id:        item.nome_oggetto + item.date,
                            alunno_id: studentId,
                            materiale: item.materiale ?? item.nome_oggetto ?? '',
                            quantita:  item.quantita ?? 0,
                            date:      item.date ?? '',
                            portato:   true, // mode=carico, quindi sempre true
                        })),
                    },
                ]);
                setErroreMensile(false);
            }
        } finally {
            setIsMonthlyLoading(false);
        }
    }, [studentId, childName]);

    useEffect(() => { fetchData(); }, [fetchData]);
    useEffect(() => {
        if (activeTab === 'monthly') fetchMonthly(month);
    }, [activeTab, month, fetchMonthly]);

    // ── Polling: aggiornamento ogni 20 secondi (affidabile, funziona sempre) ─────────
    useEffect(() => {
        const interval = setInterval(() => {
            fetchData(true); // silent=true: non mostra spinner
            if (activeTab === 'monthly') fetchMonthly(month);
        }, 20_000); // ogni 20 secondi
        return () => clearInterval(interval);
    }, [fetchData, fetchMonthly, activeTab, month]);

    /**
     * «La porto» — il genitore prende in carico la richiesta.
     *
     * ⚠️ `alunno_id` NON è decorativo: il gate della PATCH segue il gesto, e per
     * `presa_in_carico` è `requireParentOfStudent(request, alunno_id)`, che deve
     * sapere di quale bambino si parla. Senza, la route risponde 400 — ed è ciò
     * che questa pagina faceva: mandava `{ id, stato: 'acknowledged' }`, cioè uno
     * stato che l'enum non contempla e un corpo senza il soggetto del permesso.
     */
    const handleAcknowledge = async (requestId: string, alunnoId: string) => {
        setSavingId(requestId);
        try {
            const res = await fetch('/api/locker/requests', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: requestId, alunno_id: alunnoId, stato: 'presa_in_carico' }),
            });
            if (!res.ok) throw new Error('Errore');
            showToastMsg(t('lockerToastLaPorto'));
            fetchData();
        } catch (err) {
            // L'id della richiesta resta fuori dal messaggio: il log dice COSA è fallito,
            // il toast dice all'utente che è fallito. Nessuno dei due nomina il bambino.
            logClient({ livello: 'error', evento: 'fetch', messaggio: `armadietto-presa-in-carico-fallita: ${nomeErrore(err)}`, route: '/parent/locker' });
            showToastMsg(t('lockerToastErrSalvataggio'));
        } finally {
            setSavingId(null);
        }
    };

    const showToastMsg = (msg: string) => {
        setToastMessage(msg);
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2500);
    };

    // I filtri seguono gli stati VERI della tabella: `aperta` → `presa_in_carico`
    // → `evasa`. Con i nomi inglesi del vecchio schema queste tre liste erano
    // sempre vuote, qualunque cosa il server rispondesse.
    const pendingRequests      = requests.filter(r => r.stato === 'aperta');
    const acknowledgedRequests = requests.filter(r => r.stato === 'presa_in_carico');
    const completedRequests    = requests.filter(r => r.stato === 'evasa');

    if (ready && !studentId) {
        return (
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
                <Package size={40} className="text-kidville-muted" />
                <p className="font-maven text-kidville-muted">{t('lockerNessunBambino')}</p>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="px-4 pt-5 pb-24 flex flex-col items-center justify-center min-h-[60vh] gap-4">
                <div className="w-10 h-10 border-4 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                <p className="font-maven text-kidville-muted">{t('lockerCaricamentoArmadietto')}</p>
            </div>
        );
    }

    return (
        <div className="px-4 pt-5 pb-24">
            {/* ── Header ── */}
            <PageHeaderCard
                eyebrow={t('lockerEyebrow')}
                title={t('lockerTitolo')}
                subtitle={<>{t('lockerSottotitolo', { nome: childName })}</>}
                action={
                    <>
                        {/* Badge LIVE */}
                        <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold transition-all
                            ${realtimePulse ? 'bg-kidville-success text-white scale-110' : 'bg-kidville-success-soft text-kidville-success'}`}>
                            <Zap size={10} className={realtimePulse ? 'animate-bounce' : ''} /> LIVE
                        </span>
                        <button
                            onClick={() => { fetchData(); if (activeTab === 'monthly') fetchMonthly(month); }}
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
                            title={t('lockerAggiornaTitle')}>
                            <RefreshCw size={16} />
                        </button>
                    </>
                }
            />
            {lastUpdated && (
                <p className="mt-2 px-1 font-maven text-[11px] text-kidville-muted">
                    {t('lockerAggiornatoAlle', { ora: intlDateTime(f.locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(lastUpdated) })}
                </p>
            )}

            {/* Un caricamento fallito si DICE. Prima diventava una lista vuota, che
                al genitore significa «non serve niente». */}
            {errore && (
                <div role="status"
                    className="mt-4 flex items-start gap-2 rounded-2xl border-2 border-kidville-error/30 bg-kidville-error-soft px-4 py-3">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-kidville-error" />
                    <p className="font-maven text-sm text-kidville-error">{t('lockerErroreCaricamento')}</p>
                </div>
            )}

            {/* ── Tab switcher ── */}
            <div className="flex bg-kidville-neutral-soft rounded-xl p-1 gap-1 mt-5 mb-6 self-start w-fit">
                <button
                    id="tab-overview-btn"
                    onClick={() => setActiveTab('overview')}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200
                                ${activeTab === 'overview'
                                    ? 'bg-white shadow text-kidville-green'
                                    : 'text-kidville-muted hover:text-kidville-green'}`}
                >
                    <Package size={14} /> {t('lockerTabPanoramica')}
                </button>
                <button
                    id="tab-monthly-btn"
                    onClick={() => setActiveTab('monthly')}
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-all duration-200
                                ${activeTab === 'monthly'
                                    ? 'bg-white shadow text-kidville-green'
                                    : 'text-kidville-muted hover:text-kidville-green'}`}
                >
                    <Table2 size={14} /> {t('lockerTabMensile')}
                </button>
            </div>

            {/* ══════════════════════════════════════════════════════════ */}
            {/* TAB: PANORAMICA                                           */}
            {/* ══════════════════════════════════════════════════════════ */}
            {activeTab === 'overview' && (
                <>
                    {/* Richieste Pendenti */}
                    {pendingRequests.length > 0 && (
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                <Bell size={16} className="text-kidville-error" />
                                <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide">
                                    {t('lockerDaPortare')}
                                </h2>
                                <span className="bg-kidville-error text-white text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
                                    {pendingRequests.length}
                                </span>
                            </div>
                            <div className="space-y-2">
                                {pendingRequests.map(req => (
                                    <div
                                        key={req.id}
                                        className={`rounded-2xl border-2 p-4 ${
                                            req.livello === 'rosso'
                                                ? 'bg-kidville-error-soft border-kidville-error/30'
                                                : 'bg-kidville-warn-soft border-kidville-warn/30'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="w-12 h-12 rounded-2xl bg-white flex items-center justify-center text-2xl shadow-sm">
                                                {materiali[req.materiale]?.icona ?? '📦'}
                                            </div>
                                            <div className="flex-1">
                                                <p className="font-maven font-bold text-kidville-green">
                                                    {req.materiale}
                                                </p>
                                                <p className={`font-maven text-sm ${
                                                    req.livello === 'rosso' ? 'text-kidville-error' : 'text-kidville-warn'
                                                }`}>
                                                    {t('lockerRigaResiduo', {
                                                        stato: t(req.livello === 'rosso' ? 'lockerAlertRosso' : 'lockerAlertGiallo'),
                                                        quantita: req.quantita_residua,
                                                        unita: materiali[req.materiale]?.unita ?? t('lockerPz'),
                                                    })}
                                                </p>
                                                <p className="font-maven text-xs text-kidville-muted mt-0.5 flex items-center gap-1">
                                                    <Clock size={10} />
                                                    {intlDateTime(f.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(req.creato_il))}
                                                </p>
                                            </div>
                                        </div>
                                        <Btn
                                            id={`acknowledge-${req.id}-btn`}
                                            onClick={() => handleAcknowledge(req.id, req.alunno_id)}
                                            disabled={savingId === req.id}
                                            variant="primary"
                                            size="md"
                                            className="w-full mt-3"
                                        >
                                            {savingId === req.id ? (
                                                <div className="w-4 h-4 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                                            ) : (
                                                <>
                                                    <CheckCircle2 size={16} />
                                                    {t('lockerLaPortoBtn')}
                                                </>
                                            )}
                                        </Btn>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Richieste Prese in Carico */}
                    {acknowledgedRequests.length > 0 && (
                        <div className="mb-6">
                            <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide mb-3 flex items-center gap-2">
                                <CheckCircle2 size={14} className="text-kidville-success" />
                                {t('lockerPresoInCaricoTitolo')}
                            </h2>
                            <div className="space-y-2">
                                {acknowledgedRequests.map(req => (
                                    <div key={req.id} className="rounded-2xl border-2 border-kidville-success/30 bg-kidville-success-soft p-3 flex items-center gap-3">
                                        <span className="text-xl">{materiali[req.materiale]?.icona ?? '📦'}</span>
                                        <div className="flex-1">
                                            <p className="font-maven font-bold text-sm text-kidville-green">{req.materiale}</p>
                                            <p className="font-maven text-xs text-kidville-success">
                                                {/* `?? creato_il`, non `!`: la colonna è nullable e una data
                                                    mancante darebbe «Invalid Date» a schermo. */}
                                                {t('lockerPortareEPreso', { data: intlDateTime(f.locale, { day: 'numeric', month: 'short' }).format(new Date(req.presa_in_carico_il ?? req.creato_il)) })}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Situazione Materiale — usa stockData da mode=stock (numeri precisi) */}
                    <div className="mb-6">
                        <h2 className="font-barlow font-bold text-kidville-green uppercase text-sm tracking-wide mb-3 flex items-center gap-2">
                            <Package size={14} /> {t('lockerSituazioneMateriale')}
                        </h2>
                        {stockData.length > 0 ? (
                            <div className="grid grid-cols-2 gap-3">
                                {stockData.map(item => {
                                    // Icona e soglie vengono dalla STESSA risposta del server.
                                    // Qui c'era una catena di `includes()` sul nome del materiale
                                    // («pannolin», «salviet», …) e due costanti 5/2: la prima
                                    // sbagliava l'icona di qualunque materiale nuovo, le seconde
                                    // sbagliavano il semaforo di Crema (3/1) e Cambio (2/1) già
                                    // il giorno in cui sono state scritte.
                                    const cfg = materiali[item.materiale];
                                    const qty = item.stock;
                                    // Materiale non configurato ⇒ NIENTE semaforo. Un colore
                                    // inventato è peggio di nessun colore: dice al genitore che
                                    // può stare tranquillo, o che deve correre, senza saperlo.
                                    const sem = cfg ? getSemaforoUI(qty, cfg.livello_allerta, cfg.livello_emergenza) : null;
                                    const maxBar = cfg ? Math.max(cfg.livello_allerta * 4, qty + 2) : 0;
                                    const pct = cfg ? Math.min(100, (qty / maxBar) * 100) : 0;
                                    return (
                                        <div key={item.materiale}
                                            className={`rounded-2xl border-2 p-4 text-center ${sem ? `${sem.border} ${sem.bg}` : 'border-kidville-line bg-white'}`}>
                                            <div className="text-3xl mb-2">{cfg?.icona ?? '📦'}</div>
                                            <p className="font-maven font-bold text-sm text-kidville-green mb-1">{item.materiale}</p>
                                            <p className={`font-barlow font-black text-3xl ${sem ? sem.text : 'text-kidville-green'}`}>{qty}</p>
                                            <p className="font-maven text-xs text-kidville-muted mb-2">{cfg?.unita ?? t('lockerPz')}</p>
                                            {sem && (
                                                <>
                                                    <div className="h-2 bg-white/60 rounded-full overflow-hidden">
                                                        <div className={`h-full ${sem.barColor} rounded-full transition-all duration-700`}
                                                            style={{ width: `${pct}%` }} />
                                                    </div>
                                                    <p className={`font-maven text-xs mt-1 ${sem.text}`}>{sem.icon} {t(sem.labelKey)}</p>
                                                </>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-8 bg-white rounded-2xl">
                                <Package size={40} className="mx-auto text-kidville-muted mb-2" />
                                <p className="font-maven text-kidville-muted text-sm">{t('lockerNessunMaterialeStock')}</p>
                            </div>
                        )}
                    </div>

                    {/* Storico */}
                    {completedRequests.length > 0 && (
                        <div>
                            <button
                                id="toggle-history-btn"
                                onClick={() => setShowHistory(!showHistory)}
                                className="flex items-center gap-2 mb-2"
                            >
                                <h2 className="font-barlow font-bold text-kidville-muted uppercase text-sm tracking-wide">
                                    {t('lockerStoricoRichieste', { count: completedRequests.length })}
                                </h2>
                                <ChevronDown size={14} className={`text-kidville-muted transition-transform ${showHistory ? 'rotate-180' : ''}`} />
                            </button>
                            {showHistory && (
                                <div className="space-y-1.5">
                                    {completedRequests.map(req => (
                                        <div key={req.id} className="rounded-xl bg-kidville-neutral-soft px-3 py-2 flex items-center gap-3 opacity-60">
                                            <span className="text-lg">{materiali[req.materiale]?.icona ?? '📦'}</span>
                                            <div className="flex-1">
                                                <p className="font-maven text-sm text-kidville-muted">{req.materiale}</p>
                                            </div>
                                            <span className="font-maven text-xs text-kidville-muted">
                                                {intlDateTime(f.locale, { day: 'numeric', month: 'short' }).format(new Date(req.creato_il))}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* ══════════════════════════════════════════════════════════ */}
            {/* TAB: ANDAMENTO MENSILE                                    */}
            {/* ══════════════════════════════════════════════════════════ */}
            {activeTab === 'monthly' && (
                <div className="bg-white rounded-3xl p-5">
                    {/* Navigazione mese */}
                    <div className="flex items-center justify-between mb-5">
                        <button
                            id="parent-prev-month-btn"
                            aria-label={t('lockerMesePrecedente')}
                            onClick={() => setMonth(m => prevMonth(m))}
                            className="p-2 rounded-xl text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-all"
                        >
                            <ChevronLeft size={18} />
                        </button>
                        <span className="text-sm font-semibold text-kidville-green/70">{t('lockerAndamentoMensileDi', { nome: childName })}</span>
                        <button
                            id="parent-next-month-btn"
                            aria-label={t('lockerMeseSuccessivo')}
                            onClick={() => setMonth(m => nextMonth(m))}
                            className="p-2 rounded-xl text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-all"
                        >
                            <ChevronRight size={18} />
                        </button>
                    </div>

                    {isMonthlyLoading ? (
                        <div className="flex items-center justify-center py-16 gap-3">
                            <div className="w-6 h-6 border-2 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                            <span className="text-kidville-muted text-sm">{t('caricamento')}</span>
                        </div>
                    ) : erroreMensile ? (
                        <div role="status" className="flex items-start gap-2 rounded-2xl border-2 border-kidville-error/30 bg-kidville-error-soft px-4 py-3">
                            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-kidville-error" />
                            <p className="font-maven text-sm text-kidville-error">{t('lockerErroreMensile')}</p>
                        </div>
                    ) : (
                        <MonthlyLockerTable
                            students={monthlyData}
                            month={month}
                            hideStudentColumn={true}
                        />
                    )}
                </div>
            )}

            {/* Toast */}
            {showToast && (
                <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] bg-kidville-green text-white font-maven font-semibold px-6 py-3 rounded-2xl shadow-xl flex items-center gap-2 animate-bounce">
                    {toastMessage}
                </div>
            )}
        </div>
    );
}

function LockerFallback() {
    const t = useTranslations('parentServizi');
    return <div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>;
}

export default function ParentLockerPage() {
    return (
        <Suspense fallback={<LockerFallback />}>
            <LockerInner />
        </Suspense>
    );
}
