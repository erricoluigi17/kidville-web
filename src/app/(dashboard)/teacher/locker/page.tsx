'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import {
    RefreshCw, ChevronDown, ChevronRight,
    PlusCircle, MinusCircle, Table2, Truck, ChevronLeft,
    ChevronRight as ChevronRightIcon, Settings, Bell, Check, AlertTriangle,
} from 'lucide-react';
import Link from 'next/link';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { LoadStockModal } from '@/components/features/teacher/locker/LoadStockModal';
import { MonthlyLockerTable, type StudentInfo } from '@/components/features/teacher/locker/MonthlyLockerTable';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { logClient, nomeErrore } from '@/lib/logging/client';

function currentYearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftMonth(ym: string, delta: number) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Tipi ────────────────────────────────────────────────────────────────────

interface StockItem  { materiale: string; stock: number; }
interface StockAlunno { id: string; nome: string; cognome: string; stocks: StockItem[]; }
interface InventarioRecord { date: string; nome_oggetto: string; materiale?: string; quantita?: number; }
interface CaricoDayStudent { id: string; nome: string; cognome: string; inventario: InventarioRecord[]; }

/** L'alunno incorporato da `armadietto_richieste → alunni (id, nome, cognome)`. */
interface RichiestaAlunno { id: string; nome: string; cognome: string; }

/**
 * Una richiesta di rifornimento come la restituisce
 * `GET /api/locker/requests?classe_sezione=`.
 *
 * Quel ramo della route esisteva DA SEMPRE e non aveva mai avuto un consumatore:
 * la scuola apriva richieste che soltanto il genitore poteva vedere. Questa vista
 * è il primo.
 */
interface Richiesta {
    id: string;
    alunno_id: string;
    materiale: string;
    livello: 'giallo' | 'rosso';
    quantita_residua: number;
    stato: 'aperta' | 'presa_in_carico' | 'evasa';
    presa_in_carico_il: string | null;
    evasa_il: string | null;
    creato_il: string;
    /** PostgREST rende una relazione to-one come oggetto; alcune versioni come array. */
    alunni?: RichiestaAlunno | RichiestaAlunno[] | null;
}

/** L'alunno della richiesta, qualunque forma abbia scelto PostgREST. */
function alunnoDi(r: Richiesta): RichiestaAlunno | null {
    const a = r.alunni;
    if (!a) return null;
    return (Array.isArray(a) ? a[0] : a) ?? null;
}

/**
 * Giorni interi trascorsi da una data ISO.
 *
 * Solo aritmetica sui millisecondi: niente `Intl`, niente `toLocale*`, quindi
 * nessun fuso da dichiarare. E non compare nel primo render — la lista esiste solo
 * dopo la fetch — quindi non può disallineare l'idratazione.
 */
function giorniDa(iso: string): number {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return 0;
    return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * Le richieste vive della sezione, o `null` se non si è potuto leggere.
 *
 * ⚠️ NIENTE `&userId=`. Le tre chiamate qui accanto ce l'hanno e sarebbe stato
 * naturale copiarlo: è la vecchia identità-per-query, chiusa con
 * `ALLOW_HEADER_IDENTITY=false`, e `getQuerySchema` di questa route non la
 * dichiara — zod la scarterebbe in silenzio. Non un errore: un parametro che non
 * fa niente e che il prossimo copia di nuovo.
 *
 * ⚠️ Il `try/catch` vive qui, in una funzione di MODULO, e non dentro il
 * componente: `react-hooks/set-state-in-effect` considera il ramo `catch` di una
 * funzione chiamata da `useEffect` raggiungibile sincronicamente e rende rosso
 * ogni `setState` che ne discende. Il chiamante riceve `null` — «non ho potuto
 * guardare», diverso da «non c'è niente» — e lo dice a schermo.
 *
 * Nel log non entra mai il nome di un bambino: solo uno slug fisso e lo stato.
 */
async function caricaRichieste(sezione: string): Promise<Richiesta[] | null> {
    try {
        const res = await fetch(`/api/locker/requests?classe_sezione=${encodeURIComponent(sezione)}`);
        if (!res.ok) {
            logClient({
                livello: 'warn', evento: 'fetch',
                messaggio: `armadietto-richieste-sezione-non-lette: ${res.status}`,
                route: '/teacher/locker', stato: res.status,
            });
            return null;
        }
        const dati: unknown = await res.json();
        if (!Array.isArray(dati)) return [];
        // Le evase sono storia. Questa vista risponde a una domanda sola: che cosa
        // manca ADESSO, e chi non ha ancora risposto.
        return (dati as Richiesta[]).filter((r) => r.stato !== 'evasa');
    } catch (err) {
        logClient({
            livello: 'error', evento: 'fetch',
            messaggio: `armadietto-richieste-sezione-fallite: ${nomeErrore(err)}`,
            route: '/teacher/locker',
        });
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

function TeacherLockerInner() {
    const t = useTranslations('teacherServizi');
    const search = useSearchParams();
    const pathname = usePathname();
    const userId = getCurrentTeacherId(search);
    // Link impostazioni base-path-aware: dentro il cockpit (/admin) resta nella shell;
    // sotto /teacher invariato. Evita una fuga dalla cornice Direzione/Segreteria.
    const uid = search.get('userId');
    const settingsHref = pathname?.startsWith('/admin')
        ? `/admin/impostazioni?sezione=armadietto${uid ? `&userId=${uid}` : ''}`
        : '/teacher/settings/locker';
    // 'carico' | 'consumo' | 'richieste' | 'mensile'
    const [view, setView]   = useState<'carico' | 'consumo' | 'richieste' | 'mensile'>('carico');
    const [month, setMonth] = useState(currentYearMonth());

    // Carico state
    const [caricoStudents, setCaricoStudents] = useState<CaricoDayStudent[]>([]);
    const [caricoLoading,  setCaricoLoading]  = useState(true);
    const [expandedCarico, setExpandedCarico] = useState<string | null>(null);
    const [showModal,      setShowModal]      = useState(false);
    const [preStudent,     setPreStudent]     = useState('');
    const [preMat,         setPreMat]         = useState('');

    // Consumo state
    const [consumoStudents, setConsumoStudents] = useState<StockAlunno[]>([]);
    const [consumoLoading,  setConsumoLoading]  = useState(true);
    const [expandedConsumo, setExpandedConsumo] = useState<string | null>(null);
    // inline consumo form: { studentId, materiale }
    const [consumoForm, setConsumoForm]         = useState<{sid: string; mat: string} | null>(null);
    const [consumoQty,  setConsumoQty]          = useState(1);
    const [consumoSaving, setConsumoSaving]     = useState(false);

    // Richieste state («Da portare»)
    const [richieste,        setRichieste]        = useState<Richiesta[]>([]);
    const [richiesteLoading, setRichiesteLoading] = useState(true);
    const [richiesteErrore,  setRichiesteErrore]  = useState(false);
    const [evadendoId,       setEvadendoId]       = useState<string | null>(null);
    const [erroreEvasione,   setErroreEvasione]   = useState(false);

    // Mensile state
    const [mensileStudents, setMensileStudents] = useState<StudentInfo[]>([]);
    const [mensileLoading,  setMensileLoading]  = useState(true);

    // Sezioni reali del docente (utenti_sezioni via /api/educator-sections):
    // niente più sezione hardcoded; con più sezioni compare il selettore a pill.
    const [availableSections, setAvailableSections] = useState<string[]>([]);
    const [sezione, setSezione] = useState('');

    useEffect(() => {
        if (!userId) return;
        fetch(`/api/educator-sections?userId=${userId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                const secs: string[] = d?.sectionNames ?? [];
                setAvailableSections(secs);
                setSezione(prev => prev || secs[0] || '');
                // Nessuna sezione assegnata: niente da caricare → chiudo gli spinner.
                // ⚠️ TUTTI E QUATTRO, non i due che c'erano: senza `sezione` nessuna
                // fetch parte mai, quindi ogni spinner rimasto acceso è ETERNO.
                // «Mensile» ne aveva già uno, e nessuno se n'era accorto perché quella
                // vista si apre di rado. La quarta vista non ne aggiunge un altro.
                if (secs.length === 0) {
                    setCaricoLoading(false); setConsumoLoading(false);
                    setRichiesteLoading(false); setMensileLoading(false);
                }
            })
            .catch(() => {
                setCaricoLoading(false); setConsumoLoading(false);
                setRichiesteLoading(false); setMensileLoading(false);
            });
    }, [userId]);

    // ── Fetch Carico ─────────────────────────────────────────────────────────
    const fetchCarico = useCallback(async () => {
        try {
            const today = new Date().toISOString().slice(0, 10);
            const res = await fetch(
                `/api/locker/inventory?classe_sezione=${encodeURIComponent(sezione)}&mode=carico&month=${today.slice(0, 7)}&userId=${userId}`
            );
            const data = await res.json();
            if (Array.isArray(data)) {
                // Filtra solo record di OGGI
                const todayData = data.map((s: CaricoDayStudent) => ({
                    ...s,
                    inventario: (s.inventario ?? []).filter((r) => r.date === today),
                }));
                setCaricoStudents(todayData);
                if (todayData.length > 0 && !expandedCarico) setExpandedCarico(todayData[0].id);
            }
        } finally { setCaricoLoading(false); }
    }, [expandedCarico, userId, sezione]);

    // ── Fetch Consumo (stock aggregato) ──────────────────────────────────────
    const fetchConsumo = useCallback(async () => {
        try {
            const res = await fetch(`/api/locker/inventory?classe_sezione=${encodeURIComponent(sezione)}&mode=stock&userId=${userId}`);
            const data = await res.json();
            if (Array.isArray(data)) {
                setConsumoStudents(data);
                if (data.length > 0 && !expandedConsumo) setExpandedConsumo(data[0].id);
            }
        } finally { setConsumoLoading(false); }
    }, [expandedConsumo, userId, sezione]);

    // ── Fetch Richieste («Da portare») ────────────────────────────────────────
    // `finally` e non `catch`: il `catch` vive dentro `caricaRichieste` (che logga),
    // e qui il `finally` copre TUTTI i rami terminali — compreso quello d'errore.
    // Nessuna strada porta a uno spinner che non si spegne.
    const fetchRichieste = useCallback(async () => {
        try {
            const dati = await caricaRichieste(sezione);
            if (dati === null) {
                setRichiesteErrore(true);
            } else {
                setRichieste(dati);
                setRichiesteErrore(false);
            }
        } finally {
            setRichiesteLoading(false);
        }
    }, [sezione]);

    // ── Fetch Mensile ─────────────────────────────────────────────────────────
    const fetchMensile = useCallback(async (ym: string) => {
        try {
            const res = await fetch(
                `/api/locker/inventory?classe_sezione=${encodeURIComponent(sezione)}&mode=carico&month=${ym}&userId=${userId}`
            );
            const data = await res.json();
            if (Array.isArray(data)) {
                setMensileStudents(data.map((s: CaricoDayStudent) => ({
                    id: s.id, nome: s.nome, cognome: s.cognome,
                    inventario: (s.inventario ?? []).map((r) => ({
                        id:        r.nome_oggetto + r.date,
                        alunno_id: s.id,
                        materiale: r.materiale ?? r.nome_oggetto,
                        quantita:  r.quantita ?? 0,
                        date:      r.date ?? '',
                        portato:   true,
                    })),
                })));
            }
        } finally { setMensileLoading(false); }
    }, [userId, sezione]);

    // Carica Carico odierno + stock totale quando la sezione reale è nota.
    useEffect(() => { if (sezione) { fetchCarico(); fetchConsumo(); } }, [sezione]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => { if (view === 'mensile' && sezione) fetchMensile(month); }, [view, month, sezione, fetchMensile]);
    useEffect(() => { if (view === 'richieste' && sezione) fetchRichieste(); }, [view, sezione, fetchRichieste]);

    // ── Azioni ────────────────────────────────────────────────────────────────
    const handleLoadStock = async (body: { alunno_id: string; materiale: string; quantita: number }) => {
        const res = await fetch('/api/locker/inventory', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        // Aggiorna SEMPRE entrambi i tab per coerenza dei numeri
        fetchCarico();
        fetchConsumo();
    };

    const handleConsumo = async () => {
        if (!consumoForm || !userId) return;
        setConsumoSaving(true);
        try {
            const res = await fetch(`/api/locker/inventory?userId=${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    alunno_id: consumoForm.sid,
                    materiale: consumoForm.mat,
                    quantita_usata: consumoQty,
                }),
            });
            if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
            setConsumoForm(null);
            setConsumoQty(1);
            fetchConsumo();
        } catch (e) { alert('❌ ' + (e instanceof Error ? e.message : String(e))); }
        finally { setConsumoSaving(false); }
    };

    /**
     * «Arrivato» — la scuola chiude la richiesta a mano.
     *
     * Serve per il caso in cui il materiale arriva e il carico si registra dopo (o
     * non si registra affatto): il motore chiude da sé la richiesta quando lo stock
     * risale sopra soglia, ma finché quel carico non c'è la richiesta resterebbe
     * aperta a dire il falso.
     *
     * Il gate segue il gesto: `evasa` è la SCUOLA, quindi `requireDocente` + scope
     * di sezione. `alunno_id` viaggia nel corpo perché la route ci verifica che la
     * riga sia davvero di quel bambino.
     */
    const handleEvadi = async (r: Richiesta) => {
        setEvadendoId(r.id);
        setErroreEvasione(false);
        try {
            const res = await fetch('/api/locker/requests', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: r.id, alunno_id: r.alunno_id, stato: 'evasa' }),
            });
            if (!res.ok) throw new Error(`stato ${res.status}`);
            await fetchRichieste();
        } catch (err) {
            // Il nome del bambino resta a schermo e MAI nel log: qui va solo il NOME
            // della classe d'errore, che è struttura e non contenuto.
            logClient({
                livello: 'error', evento: 'fetch',
                messaggio: `armadietto-richiesta-evasione-fallita: ${nomeErrore(err)}`,
                route: '/teacher/locker',
            });
            setErroreEvasione(true);
        } finally {
            setEvadendoId(null);
        }
    };

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="mx-auto max-w-[460px] px-4 pt-5">
            {/* Header verde (DR) */}
            <PageHeaderCard
                eyebrow={t('lockerEyebrow')}
                title={t('lockerTitolo')}
                subtitle={t('lockerSottotitolo', { sezione: sezione || '…' })}
                action={
                    <>
                        <Link href={settingsHref}
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
                            title={t('lockerImpostazioniMateriali')}>
                            <Settings size={17} />
                        </Link>
                        <button
                            id="refresh-btn"
                            aria-label={t('lockerAggiorna')}
                            onClick={() => { fetchCarico(); if (view === 'consumo') fetchConsumo(); if (view === 'richieste') fetchRichieste(); if (view === 'mensile') fetchMensile(month); }}
                            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
                        >
                            <RefreshCw size={17} />
                        </button>
                    </>
                }
            />

            {/* Selettore sezione (solo con più sezioni assegnate al docente) */}
            {availableSections.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                    {availableSections.map(s => (
                        <button key={s} onClick={() => { setSezione(s); setExpandedCarico(null); setExpandedConsumo(null); }}
                            className={`rounded-pill border px-3 py-1.5 font-maven text-xs font-semibold transition-colors ${
                                sezione === s ? 'border-kidville-green/20 bg-kidville-green text-kidville-yellow' : 'border-kidville-line bg-white text-kidville-muted'
                            }`} aria-pressed={sezione === s}>
                            {s}
                        </button>
                    ))}
                </div>
            )}

            {/* Toggle 3 viste */}
            <div className="mt-5 mb-6 flex gap-1 rounded-2xl bg-white p-1 shadow-sm">
                {([
                    { key: 'carico',    icon: <Truck size={14} />,       label: t('lockerTabCarico') },
                    { key: 'consumo',   icon: <MinusCircle size={14} />, label: t('lockerTabConsumo') },
                    { key: 'richieste', icon: <Bell size={14} />,        label: t('lockerTabRichieste') },
                    { key: 'mensile',   icon: <Table2 size={14} />,      label: t('lockerTabMensile') },
                ] as const).map(({ key, icon, label }) => (
                    <button
                        key={key}
                        id={`view-${key}-btn`}
                        onClick={() => setView(key)}
                        className={`flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl text-[11px] font-semibold transition-all
                            ${view === key ? 'bg-white shadow text-kidville-green' : 'text-kidville-muted hover:text-kidville-green'}`}
                    >
                        {icon} {label}
                    </button>
                ))}
            </div>

            {/* ══════════════════════ CARICO ══════════════════════════════════ */}
            {view === 'carico' && (
                <>
                    <button
                        id="new-carico-btn"
                        onClick={() => { setPreStudent(''); setPreMat(''); setShowModal(true); }}
                        className="w-full mb-5 py-3 bg-kidville-green text-kidville-yellow rounded-2xl font-barlow font-black uppercase shadow-lg hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                    >
                        <PlusCircle size={20} /> {t('lockerRegistraCarico')}
                    </button>

                    {caricoLoading ? (
                        <div className="text-center py-10 text-kidville-muted">{t('lockerCaricamento')}</div>
                    ) : (
                        <div className="space-y-3">
                            {caricoStudents.map(student => {
                                const isOpen = expandedCarico === student.id;
                                const todayCount = student.inventario.length;
                                return (
                                    <div key={student.id} className="bg-white rounded-2xl shadow-sm border border-kidville-line overflow-hidden">
                                        <button
                                            onClick={() => setExpandedCarico(isOpen ? null : student.id)}
                                            className="w-full flex items-center gap-3 p-4 hover:bg-kidville-cream"
                                        >
                                            <div className="w-10 h-10 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-black text-sm">
                                                {student.nome[0]}{student.cognome[0]}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="font-maven font-bold text-kidville-green">{student.nome} {student.cognome}</p>
                                                <p className="text-xs text-kidville-muted">
                                                    {t('lockerConsegneOggi', { count: todayCount })}
                                                </p>
                                            </div>
                                            {todayCount > 0 && (
                                                <span className="bg-kidville-success-soft text-kidville-success text-[10px] font-bold px-2 py-0.5 rounded-full">
                                                    ✓ {todayCount}
                                                </span>
                                            )}
                                            {isOpen ? <ChevronDown size={18} className="text-kidville-muted" /> : <ChevronRight size={18} className="text-kidville-muted" />}
                                        </button>

                                        {isOpen && (() => {
                                            // Recupera lo stock totale per questo alunno dal tab Consumo (già caricato)
                                            const studentStocks = consumoStudents.find(s => s.id === student.id)?.stocks ?? [];
                                            return (
                                                <div className="p-4 bg-kidville-cream/50 border-t border-kidville-line space-y-3">

                                                    {/* Stock totale attuale */}
                                                    {studentStocks.length > 0 && (
                                                        <div className="rounded-xl bg-kidville-green/5 border border-kidville-green/10 px-3 py-2">
                                                            <p className="text-[10px] font-bold text-kidville-green uppercase tracking-wide mb-1.5">{t('lockerStockTotale')}</p>
                                                            <div className="flex gap-3 flex-wrap">
                                                                {studentStocks.map((s) => (
                                                                    <span key={s.materiale} className="text-xs font-maven font-semibold text-kidville-ink">
                                                                        {s.materiale}: <strong className="text-kidville-green">{s.stock} pz</strong>
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Consegne di oggi */}
                                                    {todayCount > 0 ? (
                                                        <div className="space-y-1.5">
                                                            <p className="text-[10px] font-bold text-kidville-success uppercase tracking-wide">{t('lockerConsegnatoOggi')}</p>
                                                            {student.inventario.map((item, idx) => {
                                                                const matStock = studentStocks.find((s) => s.materiale === (item.materiale ?? item.nome_oggetto))?.stock ?? 0;
                                                                return (
                                                                    <div key={idx} className="flex items-center justify-between bg-white rounded-xl px-4 py-2 border border-kidville-success/20">
                                                                        <span className="font-maven font-semibold text-kidville-green text-sm">
                                                                            {item.materiale ?? item.nome_oggetto}
                                                                        </span>
                                                                        <div className="text-right">
                                                                            <span className="font-barlow font-black text-kidville-success block">+{item.quantita} pz</span>
                                                                            <span className="text-[10px] text-kidville-muted">{t('lockerTotale')}: {matStock} pz</span>
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    ) : (
                                                        <p className="text-center text-kidville-muted text-sm py-2">{t('lockerNessunaConsegna')}</p>
                                                    )}

                                                    <button
                                                        onClick={() => { setPreStudent(student.id); setPreMat(''); setShowModal(true); }}
                                                        className="w-full py-2 border-2 border-dashed border-kidville-green/30 rounded-xl text-kidville-green text-xs font-bold hover:bg-kidville-green/5 transition-colors flex items-center justify-center gap-1"
                                                    >
                                                        <PlusCircle size={14} /> {t('lockerAggiungiCaricoPer', { nome: student.nome })}
                                                    </button>
                                                </div>
                                            );
                                        })()}

                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <LoadStockModal
                        isOpen={showModal}
                        onClose={() => setShowModal(false)}
                        students={caricoStudents.map(s => ({ id: s.id, nome: s.nome, cognome: s.cognome }))}
                        preselectedStudent={preStudent}
                        preselectedMateriale={preMat}
                        classeSezione={sezione}
                        onConfirm={handleLoadStock}
                    />
                </>
            )}

            {/* ══════════════════════ CONSUMO ══════════════════════════════════ */}
            {view === 'consumo' && (
                <>
                    <div className="mb-4 bg-kidville-warn-soft border border-kidville-warn/30 rounded-2xl px-4 py-3 text-xs text-kidville-warn font-maven">
                        {t.rich('lockerConsumoHint', { strong: (c) => <strong>{c}</strong> })}
                    </div>

                    {consumoLoading ? (
                        <div className="text-center py-10 text-kidville-muted">{t('lockerCaricamentoStock')}</div>
                    ) : (
                        <div className="space-y-3">
                            {consumoStudents.map(student => {
                                const isOpen = expandedConsumo === student.id;
                                const hasStock = student.stocks.some(s => s.stock > 0);
                                return (
                                    <div key={student.id} className="bg-white rounded-2xl shadow-sm border border-kidville-line overflow-hidden">
                                        <button
                                            onClick={() => setExpandedConsumo(isOpen ? null : student.id)}
                                            className="w-full flex items-center gap-3 p-4 hover:bg-kidville-cream"
                                        >
                                            <div className="w-10 h-10 rounded-full bg-kidville-cream text-kidville-green flex items-center justify-center font-black text-sm">
                                                {student.nome[0]}{student.cognome[0]}
                                            </div>
                                            <div className="flex-1 text-left">
                                                <p className="font-maven font-bold text-kidville-green">{student.nome} {student.cognome}</p>
                                                <p className="text-xs text-kidville-muted">{t('lockerMaterialiInStock', { count: student.stocks.length })}</p>
                                            </div>
                                            {!hasStock && (
                                                <span className="bg-kidville-error-soft text-kidville-error text-[10px] font-bold px-2 py-0.5 rounded-full">{t('lockerEsaurito')}</span>
                                            )}
                                            {isOpen ? <ChevronDown size={18} className="text-kidville-muted" /> : <ChevronRight size={18} className="text-kidville-muted" />}
                                        </button>

                                        {isOpen && (
                                            <div className="p-4 bg-kidville-cream/50 border-t border-kidville-line space-y-2">
                                                {student.stocks.length === 0 ? (
                                                    <p className="text-center text-kidville-muted text-sm py-3">{t('lockerNessunMateriale')}</p>
                                                ) : student.stocks.map(item => {
                                                    const isFormOpen = consumoForm?.sid === student.id && consumoForm?.mat === item.materiale;
                                                    return (
                                                        <div key={item.materiale}>
                                                            {/* Riga materiale */}
                                                            <button
                                                                onClick={() => {
                                                                    if (isFormOpen) { setConsumoForm(null); return; }
                                                                    setConsumoForm({ sid: student.id, mat: item.materiale });
                                                                    setConsumoQty(1);
                                                                }}
                                                                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all
                                                                    ${isFormOpen
                                                                        ? 'border-kidville-warn bg-kidville-warn-soft'
                                                                        : item.stock === 0
                                                                            ? 'border-kidville-error/20 bg-kidville-error-soft opacity-60'
                                                                            : 'border-kidville-line bg-white hover:border-kidville-warn/30 hover:bg-kidville-warn-soft/50'}`}
                                                            >
                                                                <span className="font-maven font-semibold text-sm text-kidville-green">{item.materiale}</span>
                                                                <div className="flex items-center gap-2">
                                                                    <span className={`font-barlow font-black text-lg ${item.stock === 0 ? 'text-kidville-error' : 'text-kidville-green'}`}>
                                                                        {item.stock} pz
                                                                    </span>
                                                                    <MinusCircle size={18} className={item.stock > 0 ? 'text-kidville-warn' : 'text-kidville-muted'} />
                                                                </div>
                                                            </button>

                                                            {/* Form consumo inline */}
                                                            {isFormOpen && (
                                                                <div className="mt-1 px-4 py-3 bg-kidville-warn-soft border border-kidville-warn/30 rounded-xl space-y-3">
                                                                    <p className="text-xs text-kidville-warn font-maven">
                                                                        {t.rich('lockerQuanteUnita', { materiale: item.materiale, strong: (c) => <strong>{c}</strong> })}
                                                                    </p>
                                                                    <div className="flex items-center gap-3">
                                                                        <button
                                                                            onClick={() => setConsumoQty(q => Math.max(1, q - 1))}
                                                                            className="w-9 h-9 rounded-xl bg-white border border-kidville-warn/30 flex items-center justify-center text-kidville-warn font-black hover:bg-kidville-warn-soft"
                                                                        >-</button>
                                                                        <span className="font-barlow font-black text-2xl text-kidville-green w-8 text-center">{consumoQty}</span>
                                                                        <button
                                                                            onClick={() => setConsumoQty(q => Math.min(item.stock, q + 1))}
                                                                            className="w-9 h-9 rounded-xl bg-white border border-kidville-warn/30 flex items-center justify-center text-kidville-warn font-black hover:bg-kidville-warn-soft"
                                                                        >+</button>
                                                                        <button
                                                                            onClick={handleConsumo}
                                                                            disabled={consumoSaving || consumoQty > item.stock}
                                                                            // `hover:bg-kidville-warn-dark` non esisteva → l'hover non cambiava
                                                                            // nulla. `warn-strong` è il tono scuro del caldo: bianco 5,61:1.
                                                                            className="flex-1 h-9 bg-kidville-warn text-white rounded-xl font-barlow font-black text-sm disabled:opacity-50 hover:bg-kidville-warn-strong active:scale-95 transition-all"
                                                                        >
                                                                            {consumoSaving ? '...' : t('lockerConferma')}
                                                                        </button>
                                                                        <button onClick={() => setConsumoForm(null)} className="text-kidville-muted text-xs">{t('lockerAnnulla')}</button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}

            {/* ══════════════════════ DA PORTARE ═══════════════════════════════ */}
            {view === 'richieste' && (
                <>
                    {erroreEvasione && (
                        <div role="status" className="mb-4 flex items-start gap-2 rounded-2xl border border-kidville-error/30 bg-kidville-error-soft px-4 py-3">
                            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-kidville-error" />
                            <p className="font-maven text-sm text-kidville-error">{t('lockerRichiestaErroreArrivato')}</p>
                        </div>
                    )}

                    {/* `text-kidville-sub` e non `text-kidville-muted`: quel grigio vale
                        2,51:1 su bianco contro i 4,5:1 di WCAG AA, e su una vista NUOVA non
                        si riapre un debito che il repo sta smaltendo. */}
                    {richiesteLoading ? (
                        <div className="text-center py-10 text-kidville-sub">{t('lockerCaricamento')}</div>
                    ) : richiesteErrore ? (
                        <div role="status" className="flex items-start gap-2 rounded-2xl border border-kidville-error/30 bg-kidville-error-soft px-4 py-3">
                            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-kidville-error" />
                            <p className="font-maven text-sm text-kidville-error">{t('lockerRichiesteErrore')}</p>
                        </div>
                    ) : richieste.length === 0 ? (
                        /* In produzione questa vista SARÀ vuota: il modulo è appena
                           stato ricollegato e non ci sono ancora movimenti. Lo stato
                           vuoto deve dirlo, non lasciare una pagina bianca. */
                        <div className="rounded-2xl border border-kidville-line bg-white px-4 py-10 text-center">
                            <Bell size={32} className="mx-auto mb-2 text-kidville-sub" />
                            <p className="font-maven text-sm text-kidville-sub">{t('lockerRichiesteVuoto')}</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {richieste.map(r => {
                                const alunno = alunnoDi(r);
                                return (
                                    <div key={r.id} className="bg-white rounded-2xl shadow-sm border border-kidville-line p-4">
                                        <div className="flex items-center gap-3">
                                            {/* Il pallino ripete un'informazione che il testo dà già
                                                («nessuna risposta» / «in arrivo»): il colore aggiunge,
                                                non sostituisce — WCAG 1.4.1. */}
                                            <span aria-hidden="true"
                                                className={`h-3 w-3 flex-shrink-0 rounded-full ${r.livello === 'rosso' ? 'bg-kidville-error' : 'bg-kidville-warn'}`} />
                                            <div className="min-w-0 flex-1">
                                                <p className="font-maven font-bold text-kidville-green truncate">
                                                    {alunno ? `${alunno.nome} ${alunno.cognome}` : t('lockerRichiestaAlunnoIgnoto')}
                                                </p>
                                                <p className="font-maven text-xs text-kidville-sub">
                                                    {t('lockerRichiestaResiduo', { materiale: r.materiale, quantita: r.quantita_residua })}
                                                </p>
                                                <p className={`mt-0.5 font-maven text-xs ${r.stato === 'presa_in_carico' ? 'text-kidville-success' : 'text-kidville-warn'}`}>
                                                    {r.stato === 'presa_in_carico'
                                                        ? t('lockerRichiestaInArrivo')
                                                        : t('lockerRichiestaSenzaRisposta', { count: giorniDa(r.creato_il) })}
                                                </p>
                                            </div>
                                            <button
                                                id={`evadi-${r.id}-btn`}
                                                onClick={() => handleEvadi(r)}
                                                disabled={evadendoId === r.id}
                                                className="flex flex-shrink-0 items-center gap-1 rounded-pill border border-kidville-green/20 bg-kidville-green px-3 py-1.5 font-barlow text-[11px] font-extrabold uppercase tracking-wide text-kidville-yellow transition-all active:scale-95 disabled:opacity-50"
                                            >
                                                <Check size={13} /> {t('lockerRichiestaArrivato')}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}

            {/* ══════════════════════ MENSILE ══════════════════════════════════ */}
            {view === 'mensile' && (
                <div className="bg-white rounded-3xl p-5">
                    <div className="flex items-center justify-between mb-5">
                        <button id="prev-month-btn" onClick={() => setMonth(m => shiftMonth(m, -1))} aria-label={t('lockerMesePrecedente')}
                            className="p-2 rounded-xl text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-all">
                            <ChevronLeft size={18} />
                        </button>
                        <span className="text-sm font-semibold text-kidville-green/70">{t('lockerConsegneMensili')}</span>
                        <button id="next-month-btn" onClick={() => setMonth(m => shiftMonth(m, 1))} aria-label={t('lockerMeseSuccessivo')}
                            className="p-2 rounded-xl text-kidville-muted hover:text-kidville-green hover:bg-kidville-cream transition-all">
                            <ChevronRightIcon size={18} />
                        </button>
                    </div>
                    {mensileLoading ? (
                        <div className="flex items-center justify-center py-16 gap-3">
                            <div className="w-5 h-5 border-2 border-kidville-green/30 border-t-kidville-green rounded-full animate-spin" />
                            <span className="text-kidville-muted text-sm">{t('lockerCaricamento')}</span>
                        </div>
                    ) : (
                        <MonthlyLockerTable students={mensileStudents} month={month} hideStudentColumn={false} />
                    )}
                </div>
            )}
        </div>
    );
}

export default function TeacherLockerPage() {
    return (
        <Suspense fallback={null}>
            <TeacherLockerInner />
        </Suspense>
    );
}
