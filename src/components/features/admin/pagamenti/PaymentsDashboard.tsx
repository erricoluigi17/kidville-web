'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Filter, AlertTriangle, CheckCircle2, Clock, RefreshCw, Plus, Pencil, Layers, Eye, FileText, Download, X } from 'lucide-react';
import { RegistraIncassoModal, PagamentoRow } from './RegistraIncassoModal';
import { FatturaButton } from './FatturaButton';
import { FatturaChip } from './FatturaChip';
import { PagamentoCardMobile } from './PagamentoCardMobile';
import { PagamentoDrawer } from './PagamentoDrawer';
import { SospensioneToggle } from './SospensioneToggle';
import { QuickAcquistoModal } from './QuickAcquistoModal';
import { ModificaPagamentoModal } from './ModificaPagamentoModal';
import { RateizzaModal } from './RateizzaModal';
import { STATI_PAGAMENTO as STATI, calcolaTotaliPagamenti } from './stati';
import { AgendaScadenze } from './AgendaScadenze';
import { AGING_LABEL, bucketScadenze, isMoroso, type AgingBucketId } from '@/lib/pagamenti/aging';
import { Badge } from '@/components/ui/Badge';
import { StatCard, TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';

// Pelle locale della dashboard contabilità, su token dell'app (allineata a
// `Btn`/cockpit): pillole verde+giallo per le azioni, filtri come la Toolbar.
const BTN_PRIMARY_SM = 'inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-1 font-maven text-xs font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50';
const ICON_BTN = 'text-kidville-muted transition-colors hover:text-kidville-green';
const FILTER_SELECT = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

/** Stato vuoto nello stile app: cerchio crema + emoji + testo (come parent/avvisi). */
function EmptyRiga({ emoji, testo }: { emoji: string; testo: string }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-pill bg-kidville-cream text-2xl">{emoji}</div>
            <p className="max-w-xs font-maven text-sm text-kidville-muted">{testo}</p>
        </div>
    );
}

interface Categoria { id: string; nome: string; slug: string; colore?: string; icona?: string }
interface Pagamento extends PagamentoRow {
    alunno_id: string;
    scadenza: string;
    obbligatorio: boolean;
    categoria_id?: string | null;
    periodo_competenza?: string | null;
    payment_categories?: { nome?: string; colore?: string; icona?: string } | null;
}
interface Alunno {
    id: string; nome?: string; cognome?: string;
    classe_sezione?: string | null; section_id?: string | null;
    stato?: string; importo_retta_mensile?: number | null;
}

const MESI_IT = ['', 'Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

// I 10 periodi (primo del mese) dell'anno scolastico set(annoInizio) -> giu(annoInizio+1)
function periodiAnno(annoInizio: number): { periodo: string; label: string }[] {
    const out: { periodo: string; label: string }[] = [];
    for (let m = 9; m <= 12; m++) out.push({ periodo: `${annoInizio}-${String(m).padStart(2, '0')}-01`, label: `${MESI_IT[m]} ${annoInizio}` });
    for (let m = 1; m <= 6; m++) out.push({ periodo: `${annoInizio + 1}-${String(m).padStart(2, '0')}-01`, label: `${MESI_IT[m]} ${annoInizio + 1}` });
    return out;
}

interface Props { userId: string; scuolaId: string }

export function PaymentsDashboard({ userId, scuolaId }: Props) {
    const [pagamenti, setPagamenti] = useState<Pagamento[]>([]);
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [categorie, setCategorie] = useState<Categoria[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [fCategoria, setFCategoria] = useState<string>('');
    const [onlyMorosi, setOnlyMorosi] = useState(false);
    const [nuovoAcqId, setNuovoAcqId] = useState('');
    const [selected, setSelected] = useState<Pagamento | null>(null);
    const [editing, setEditing] = useState<Pagamento | null>(null);
    const [rateizza, setRateizza] = useState<{ alunno: Alunno; pagamento: Pagamento } | null>(null);
    const [drawer, setDrawer] = useState<Pagamento | null>(null);
    const [agendaFiltro, setAgendaFiltro] = useState<AgingBucketId | null>(null);
    const [quick, setQuick] = useState<{ alunno: Alunno; categoria: Categoria } | null>(null);
    const [generando, setGenerando] = useState(false);
    const [arubaGated, setArubaGated] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Anno scolastico corrente (set->ago = anno corrente, gen->giu = anno-1)
    const now = new Date();
    const oggiStr = now.toISOString().slice(0, 10);
    const annoScolasticoCorrente = now.getMonth() + 1 >= 9 ? now.getFullYear() : now.getFullYear() - 1;
    const [annoScolastico, setAnnoScolastico] = useState<number>(annoScolasticoCorrente);
    const periodi = useMemo(() => periodiAnno(annoScolastico), [annoScolastico]);
    const [mese, setMese] = useState<string>(() => {
        const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        return periodiAnno(annoScolasticoCorrente).some((p) => p.periodo === cur) ? cur : `${annoScolasticoCorrente}-09-01`;
    });

    // NB: niente setLoading(true) sincrono qui dentro (react-hooks/set-state-in-effect):
    // al mount loading parte già true; il refresh manuale lo imposta nel suo handler.
    const load = useCallback(async () => {
        try {
            const [pagRes, alRes] = await Promise.all([
                fetch(`/api/pagamenti?userId=${userId}&scuola_id=${scuolaId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()).catch(() => null),
                fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=1000`, { headers: { 'x-user-id': userId } }).then((r) => r.json()).catch(() => null),
            ]);
            if (pagRes?.success) { setPagamenti(pagRes.data); setError(null); }
            else setError((pagRes && pagRes.error) || 'Impossibile caricare i pagamenti. Riprova.');
            const lista: Alunno[] = Array.isArray(alRes) ? alRes : (alRes?.data || []);
            setAlunni(lista.filter((a) => a.classe_sezione != null || a.section_id != null));
        } finally {
            setLoading(false);
        }
    }, [userId, scuolaId]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        fetch(`/api/admin/settings/categorie?userId=${userId}`, { headers: { 'x-user-id': userId } })
            .then((r) => r.json())
            .then((d) => {
                if (d.success) {
                    setCategorie(d.data);
                    const retta = d.data.find((c: Categoria) => c.slug === 'retta');
                    setFCategoria((cur) => cur || retta?.id || d.data[0]?.id || '');
                }
            }).catch(() => {});
    }, [userId]);

    // Gating Aruba/SDI visibile (M2.4): l'integrazione non configurata non deve
    // restare invisibile alla Segreteria.
    useEffect(() => {
        fetch(`/api/admin/settings/aruba?userId=${userId}&scuola_id=${scuolaId}`, { headers: { 'x-user-id': userId } })
            .then((r) => r.json())
            .then((d) => { if (d.success) setArubaGated(!d.data?.abilitato); })
            .catch(() => {});
    }, [userId, scuolaId]);

    const rettaCat = useMemo(() => categorie.find((c) => c.slug === 'retta'), [categorie]);
    const categoriaSel = useMemo(() => categorie.find((c) => c.id === fCategoria), [categorie, fCategoria]);
    const isRettaView = !!rettaCat && fCategoria === rettaCat.id;

    // mappa retta del periodo selezionato: alunno_id -> pagamento
    const rettaByAlunno = useMemo(() => {
        const m = new Map<string, Pagamento>();
        for (const p of pagamenti) {
            if (p.categoria_id === rettaCat?.id && p.periodo_competenza === mese) m.set(p.alunno_id, p);
        }
        return m;
    }, [pagamenti, rettaCat, mese]);

    // mappa alunno per id: usata dalla tabella-categoria (ricerca e label)
    const alunnoById = useMemo(() => new Map(alunni.map((a) => [a.id, a])), [alunni]);

    const alunniFiltrati = useMemo(() => {
        const q = search.trim().toLowerCase();
        return alunni.filter((a) => {
            if (q) {
                const nome = `${a.nome ?? ''} ${a.cognome ?? ''} ${a.classe_sezione ?? ''}`.toLowerCase();
                if (!nome.includes(q)) return false;
            }
            if (isRettaView && onlyMorosi) {
                const p = rettaByAlunno.get(a.id);
                if (!p || !isMoroso(p, oggiStr)) return false;
            }
            return true;
        });
    }, [alunni, search, isRettaView, onlyMorosi, rettaByAlunno, oggiStr]);

    // Vista CATEGORIA (non-retta): una riga per pagamento (padre escluso), con
    // ricerca su alunno/sezione, filtro morosi e ordinamento per scadenza.
    const righeCategoria = useMemo(() => {
        if (isRettaView) return [];
        const q = search.trim().toLowerCase();
        return pagamenti
            .filter((p) => p.categoria_id === fCategoria && p.tipo !== 'padre')
            .filter((p) => {
                if (q) {
                    // nome da p.alunni (stessa fonte del display, copre anche i ritirati);
                    // sezione da alunnoById quando disponibile (solo iscritti)
                    const a = alunnoById.get(p.alunno_id);
                    const nome = `${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''} ${a?.classe_sezione ?? ''}`.toLowerCase();
                    if (!nome.includes(q)) return false;
                }
                if (onlyMorosi && !isMoroso(p, oggiStr)) return false;
                return true;
            })
            .sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''));
    }, [pagamenti, fCategoria, isRettaView, search, onlyMorosi, oggiStr, alunnoById]);

    const totals = useMemo(() => calcolaTotaliPagamenti(pagamenti), [pagamenti]);

    // genera la retta del mese selezionato (per chi non ce l'ha ancora)
    const generaMese = async () => {
        setGenerando(true);
        try {
            await fetch('/api/pagamenti/genera-rette', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ periodo: mese.slice(0, 7) }),
            });
            await load();
        } finally {
            setGenerando(false);
        }
    };

    const mancantiRette = isRettaView ? alunniFiltrati.filter((a) => !rettaByAlunno.has(a.id)).length : 0;

    // Vista agenda: pagamenti aperti del bucket selezionato, per scadenza crescente.
    const agendaItems = useMemo(() => {
        if (!agendaFiltro) return [];
        return bucketScadenze(pagamenti, oggiStr)[agendaFiltro].items
            .slice()
            .sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''));
    }, [agendaFiltro, pagamenti, oggiStr]);

    const fattureScartate = pagamenti.filter((p) => p.fattura_stato === 'scartata').length;
    // Mappa alunno → sospeso (DL-021), derivata dal payload pagamenti.
    const sospesoByAlunno = new Map<string, boolean>();
    for (const p of pagamenti) {
        if (p.alunno_id) sospesoByAlunno.set(p.alunno_id, !!(p as { alunni?: { sospeso?: boolean } }).alunni?.sospeso);
    }

    return (
        <div>
            {/* Errore di caricamento: i KPI a 0,00 non devono sembrare dati reali */}
            {error && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="flex-1 font-maven text-sm font-bold">{error}</span>
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-pill border border-kidville-error/40 bg-kidville-white px-3 py-1 font-maven text-xs font-bold text-kidville-error transition-colors hover:bg-kidville-error-soft">
                        Riprova
                    </button>
                </div>
            )}

            {/* Gating Aruba/SDI (M2.4): segnale visibile quando la fatturazione non è configurata */}
            {arubaGated && (
                <div className="mb-4 flex items-center gap-2 flex-wrap">
                    <Badge tone="warn">Integrazione non configurata</Badge>
                    <span className="font-maven text-xs text-kidville-muted">
                        Fatturazione elettronica Aruba/SDI non attiva: le fatture non vengono trasmesse.
                    </span>
                </div>
            )}

            {/* Banner scarti SDI (DL-020): fatture rifiutate da correggere e reinviare */}
            {fattureScartate > 0 && (
                <div className="mb-4 flex items-center gap-2 rounded-xl border-2 border-kidville-error-soft bg-kidville-error-soft px-4 py-3 text-kidville-error">
                    <AlertTriangle size={18} />
                    <span className="font-maven text-sm font-bold">
                        {fattureScartate} fattura{fattureScartate > 1 ? 'e' : ''} scartata{fattureScartate > 1 ? 'e' : ''} dallo SDI — verifica i dati dell’intestatario e premi “Riprova fattura”.
                    </span>
                </div>
            )}

            {/* KPI (StatCard cockpit): 1 colonna sotto sm, 2 da sm, 4 da lg */}
            <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard icon={CheckCircle2} label="Incassato" value={loading ? '—' : `€ ${totals.incassato.toFixed(2)}`} tone="success" />
                <StatCard icon={Clock} label="Da incassare" value={loading ? '—' : `€ ${totals.daIncassare.toFixed(2)}`} tone="warn" />
                <StatCard icon={AlertTriangle} label="Scaduto (morosità)" value={loading ? '—' : `€ ${totals.scaduto.toFixed(2)}`} tone="error" />
                <StatCard icon={FileText} label="Da fatturare" value={loading ? '—' : `€ ${totals.daFatturare.toFixed(2)}`}
                    sub={!loading && totals.nDaFatturare > 0 ? `${totals.nDaFatturare} pagament${totals.nDaFatturare === 1 ? 'o' : 'i'}` : undefined} tone="info" />
            </div>

            {/* Agenda scadenze / aging: i bucket filtrano la lista sottostante */}
            {!loading && <AgendaScadenze pagamenti={pagamenti} attivo={agendaFiltro} onSelect={setAgendaFiltro} />}

            {/* Filtri (nascosti in vista agenda: non filtrerebbero la lista del bucket) */}
            {!agendaFiltro && (
            <div className="flex flex-wrap items-center gap-2 mb-4">
                <div className="relative flex-1 min-w-[200px]">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
                    <input
                        value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Cerca alunno o sezione…"
                        className="w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white pl-9 pr-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15"
                    />
                </div>
                <select value={fCategoria} onChange={(e) => setFCategoria(e.target.value)}
                    className={FILTER_SELECT}>
                    {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                </select>

                {/* Filtro mensilità: solo nella vista Rette */}
                {isRettaView && (
                    <>
                        <select value={annoScolastico} onChange={(e) => { const y = Number(e.target.value); setAnnoScolastico(y); setMese(`${y}-09-01`); }}
                            className={FILTER_SELECT}>
                            {[annoScolasticoCorrente - 1, annoScolasticoCorrente, annoScolasticoCorrente + 1].map((y) => (
                                <option key={y} value={y}>A.S. {y}/{y + 1}</option>
                            ))}
                        </select>
                        <select value={periodi.some((p) => p.periodo === mese) ? mese : periodi[0].periodo}
                            onChange={(e) => setMese(e.target.value)}
                            className={FILTER_SELECT}>
                            {periodi.map((p) => <option key={p.periodo} value={p.periodo}>{p.label}</option>)}
                        </select>
                    </>
                )}
                {/* Filtro Morosi: disponibile in tutte le categorie */}
                <button onClick={() => setOnlyMorosi((v) => !v)}
                    className={cx('inline-flex items-center gap-1 rounded-pill px-3 py-2 font-maven text-sm font-bold transition-colors', onlyMorosi ? 'bg-kidville-error-soft text-kidville-error' : 'border-[1.5px] border-kidville-line bg-kidville-white text-kidville-muted hover:border-kidville-green hover:text-kidville-green')}>
                    <Filter size={14} /> Morosi
                </button>
                <button onClick={() => { setLoading(true); load(); }} aria-label="Aggiorna" title="Aggiorna" className="rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                    <RefreshCw size={14} />
                </button>
                <a href={`/api/pagamenti/export?tipo=scadenzario&userId=${userId}&scuola_id=${scuolaId}`} title="Esporta XLSX" aria-label="Esporta XLSX"
                    className="rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                    <Download size={14} />
                </a>
            </div>
            )}

            {/* CTA generazione rette mancanti */}
            {isRettaView && !loading && mancantiRette > 0 && (
                <div className="flex items-center justify-between gap-2 bg-kidville-warn-soft border border-kidville-warn/30 rounded-card px-3 py-2 mb-3">
                    <span className="font-maven text-xs text-kidville-warn">
                        {mancantiRette} alunni senza retta generata per {periodi.find((p) => p.periodo === mese)?.label}.
                    </span>
                    <button onClick={generaMese} disabled={generando} className={BTN_PRIMARY_SM}>
                        {generando ? 'Genero…' : 'Genera mancanti'}
                    </button>
                </div>
            )}

            {/* Corpo */}
            {loading ? (
                <p className="font-maven text-sm text-kidville-muted py-8 text-center">Caricamento…</p>
            ) : agendaFiltro ? (
                /* ---- Vista AGENDA: pagamenti aperti del bucket, per scadenza ---- */
                <>
                <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="font-maven text-xs text-kidville-muted">
                        <span className="font-bold text-kidville-green">{AGING_LABEL[agendaFiltro]}</span> · {agendaItems.length} pagament{agendaItems.length === 1 ? 'o' : 'i'} aperti
                    </p>
                    <button onClick={() => setAgendaFiltro(null)}
                        className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-2.5 py-1 font-maven text-xs font-bold text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                        <X size={12} /> Chiudi
                    </button>
                </div>
                {agendaItems.length === 0 ? (
                    <EmptyRiga emoji="🗓️" testo="Nessun pagamento in questo intervallo." />
                ) : (
                    <>
                    <div className={cx('hidden lg:block', TABLE_WRAP)}>
                        <table className={TABLE}>
                            <thead>
                                <tr>
                                    <th className={TH}>Alunno</th>
                                    <th className={TH}>Descrizione</th>
                                    <th className={TH}>Scadenza</th>
                                    <th className={cx(TH, 'text-right')}>Residuo</th>
                                    <th className={TH}>Stato</th>
                                    <th className={TH}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {agendaItems.map((p) => {
                                    const st = STATI[p.stato] ?? STATI.da_pagare;
                                    const residuo = Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0));
                                    return (
                                        <tr key={p.id} className={TROW}>
                                            <td className={cx(TD, 'font-semibold text-kidville-green')}>{p.alunni?.nome} {p.alunni?.cognome}</td>
                                            <td className={cx(TD, 'text-kidville-ink')}>{p.descrizione}</td>
                                            <td className={cx(TD, 'text-kidville-muted')}>{p.scadenza ? new Date(p.scadenza).toLocaleDateString('it-IT') : '—'}</td>
                                            <td className={cx(TD, 'text-right font-bold text-kidville-green')}>€ {residuo.toFixed(2)}</td>
                                            <td className={TD}>
                                                <Badge tone={st.tone}>{st.label}</Badge>
                                            </td>
                                            <td className={cx(TD, 'text-right')}>
                                                <div className="flex items-center justify-end gap-2">
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>Incassa</button>
                                                    <button onClick={() => setDrawer(p)} title="Dettagli" className={ICON_BTN}><Eye size={15} /></button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <div className="space-y-2 lg:hidden">
                        {agendaItems.map((p) => (
                            <PagamentoCardMobile
                                key={p.id}
                                pagamento={p}
                                alunnoLabel={`${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim() || '—'}
                                onIncassa={() => setSelected(p)}
                                onApri={() => setDrawer(p)}
                            />
                        ))}
                    </div>
                    </>
                )}
                </>
            ) : isRettaView ? (
                /* ---- Vista RETTE: tabella su desktop, card-list su mobile ---- */
                alunniFiltrati.length === 0 ? (
                <EmptyRiga emoji="🧒" testo="Nessun alunno attivo trovato." />
                ) : (
                <>
                <div className={cx('hidden lg:block', TABLE_WRAP)}>
                    <table className={TABLE}>
                        <thead>
                            <tr>
                                <th className={TH}>Alunno</th>
                                <th className={TH}>Sezione</th>
                                <th className={cx(TH, 'text-right')}>Importo</th>
                                <th className={cx(TH, 'text-right')}>Pagato</th>
                                <th className={TH}>Stato</th>
                                <th className={TH}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {alunniFiltrati.map((a) => {
                                const p = rettaByAlunno.get(a.id);
                                const st = p ? (STATI[p.stato] ?? STATI.da_pagare) : null;
                                const moroso = p ? isMoroso(p, oggiStr) : false;
                                return (
                                    <tr key={a.id} className={cx(TROW, moroso && 'bg-kidville-error-soft/50')}>
                                        <td className={cx(TD, 'font-semibold text-kidville-green')}>
                                            {a.nome} {a.cognome}
                                            {sospesoByAlunno.get(a.id) && (
                                                <Badge tone="error" className="ml-1 align-middle">sospeso</Badge>
                                            )}
                                        </td>
                                        <td className={cx(TD, 'text-kidville-muted')}>{a.classe_sezione || '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-green')}>{p ? `€ ${Number(p.importo).toFixed(2)}` : '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-muted')}>{p ? `€ ${Number(p.importo_pagato).toFixed(2)}` : '—'}</td>
                                        <td className={TD}>
                                            <span className="inline-flex flex-wrap items-center gap-1">
                                                {st
                                                    ? <Badge tone={st.tone}>{st.label}</Badge>
                                                    : <Badge tone="neutral">Non generata</Badge>}
                                                {p && moroso && Number(p.importo_pagato) > 0 && (
                                                    <Badge tone="warn">Acconto € {Number(p.importo_pagato).toFixed(2)}</Badge>
                                                )}
                                                {p && <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} />}
                                            </span>
                                        </td>
                                        <td className={cx(TD, 'text-right')}>
                                            <div className="flex items-center justify-end gap-2">
                                                {p && p.stato !== 'pagato' ? (
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>Incassa</button>
                                                ) : p ? (
                                                    <FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} descrizione={p.descrizione} />
                                                ) : null}
                                                {p && (
                                                    <button onClick={() => setDrawer(p)} title="Dettagli" className={ICON_BTN}><Eye size={15} /></button>
                                                )}
                                                {p && (
                                                    <button onClick={() => setEditing(p)} title="Modifica" className={ICON_BTN}><Pencil size={15} /></button>
                                                )}
                                                <SospensioneToggle alunnoId={a.id} userId={userId} sospeso={!!sospesoByAlunno.get(a.id)} onChange={load} />
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <div className="space-y-2 lg:hidden">
                    {alunniFiltrati.map((a) => {
                        const p = rettaByAlunno.get(a.id);
                        if (!p) {
                            return (
                                <div key={a.id} className="flex items-center justify-between rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                                    <p className="font-maven text-sm font-bold text-kidville-green">{a.nome} {a.cognome}</p>
                                    <Badge tone="neutral">Non generata</Badge>
                                </div>
                            );
                        }
                        return (
                            <PagamentoCardMobile
                                key={a.id}
                                pagamento={p}
                                alunnoLabel={`${a.nome ?? ''} ${a.cognome ?? ''}`.trim()}
                                sezioneLabel={a.classe_sezione}
                                sospeso={!!sospesoByAlunno.get(a.id)}
                                onIncassa={() => setSelected(p)}
                                onApri={() => setDrawer(p)}
                            />
                        );
                    })}
                </div>
                </>
                )
            ) : (
                /* ---- Vista CATEGORIA: tabella 1-riga-per-pagamento (come le rette) ---- */
                <>
                {/* Aggiungi acquisto: la tabella per-pagamento non elenca gli alunni senza acquisti */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    <select value={nuovoAcqId} onChange={(e) => setNuovoAcqId(e.target.value)}
                        className={FILTER_SELECT}>
                        <option value="">Seleziona alunno…</option>
                        {alunniFiltrati.map((a) => (
                            <option key={a.id} value={a.id}>{a.nome} {a.cognome}{a.classe_sezione ? ` · ${a.classe_sezione}` : ''}</option>
                        ))}
                    </select>
                    <button
                        disabled={!nuovoAcqId || !categoriaSel}
                        onClick={() => { const a = alunnoById.get(nuovoAcqId); if (a && categoriaSel) { setQuick({ alunno: a, categoria: categoriaSel }); setNuovoAcqId(''); } }}
                        className="inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-2 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                        <Plus size={15} /> Nuovo acquisto
                    </button>
                </div>
                {righeCategoria.length === 0 ? (
                    <EmptyRiga emoji="🧾" testo="Nessun pagamento in questa categoria." />
                ) : (
                <>
                <div className={cx('hidden lg:block', TABLE_WRAP)}>
                    <table className={TABLE}>
                        <thead>
                            <tr>
                                <th className={TH}>Alunno</th>
                                <th className={TH}>Descrizione</th>
                                <th className={TH}>Scadenza</th>
                                <th className={cx(TH, 'text-right')}>Importo</th>
                                <th className={cx(TH, 'text-right')}>Acconto</th>
                                <th className={TH}>Stato</th>
                                <th className={TH}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {righeCategoria.map((p) => {
                                const st = STATI[p.stato] ?? STATI.da_pagare;
                                const moroso = isMoroso(p, oggiStr);
                                const acconto = Number(p.importo_pagato || 0);
                                return (
                                    <tr key={p.id} className={cx(TROW, moroso && 'bg-kidville-error-soft/50')}>
                                        <td className={cx(TD, 'font-semibold text-kidville-green')}>
                                            {p.alunni?.nome} {p.alunni?.cognome}
                                            {sospesoByAlunno.get(p.alunno_id) && (
                                                <Badge tone="error" className="ml-1 align-middle">sospeso</Badge>
                                            )}
                                        </td>
                                        <td className={cx(TD, 'text-kidville-ink')}>{p.descrizione}</td>
                                        <td className={cx(TD, 'text-kidville-muted')}>{p.scadenza ? new Date(p.scadenza).toLocaleDateString('it-IT') : '—'}</td>
                                        <td className={cx(TD, 'text-right text-kidville-green')}>€ {Number(p.importo).toFixed(2)}</td>
                                        <td className={cx(TD, 'text-right text-kidville-muted')}>{acconto > 0 ? `€ ${acconto.toFixed(2)}` : '—'}</td>
                                        <td className={TD}>
                                            <span className="inline-flex flex-wrap items-center gap-1">
                                                <Badge tone={st.tone}>{st.label}</Badge>
                                                {moroso && acconto > 0 && (
                                                    <Badge tone="warn">Acconto € {acconto.toFixed(2)}</Badge>
                                                )}
                                                <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} />
                                            </span>
                                        </td>
                                        <td className={cx(TD, 'text-right')}>
                                            <div className="flex items-center justify-end gap-2">
                                                {p.stato !== 'pagato' ? (
                                                    <button onClick={() => setSelected(p)}
                                                        className={BTN_PRIMARY_SM}>Incassa</button>
                                                ) : (
                                                    <FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} descrizione={p.descrizione} />
                                                )}
                                                {p.tipo === 'singolo' && p.stato !== 'pagato' && (
                                                    <button onClick={() => { const a = alunnoById.get(p.alunno_id); if (a) setRateizza({ alunno: a, pagamento: p }); }} title="Dividi in acconti" className={ICON_BTN}><Layers size={15} /></button>
                                                )}
                                                <button onClick={() => setDrawer(p)} title="Dettagli" className={ICON_BTN}><Eye size={15} /></button>
                                                <button onClick={() => setEditing(p)} title="Modifica" className={ICON_BTN}><Pencil size={15} /></button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <div className="space-y-2 lg:hidden">
                    {righeCategoria.map((p) => (
                        <PagamentoCardMobile
                            key={p.id}
                            pagamento={p}
                            alunnoLabel={`${p.alunni?.nome ?? ''} ${p.alunni?.cognome ?? ''}`.trim() || '—'}
                            sospeso={!!sospesoByAlunno.get(p.alunno_id)}
                            onIncassa={() => setSelected(p)}
                            onApri={() => setDrawer(p)}
                        />
                    ))}
                </div>
                </>
                )}
                </>
            )}

            {selected && (
                <RegistraIncassoModal
                    pagamento={selected}
                    userId={userId}
                    onClose={() => setSelected(null)}
                    onDone={() => { setSelected(null); load(); }}
                />
            )}

            {quick && (
                <QuickAcquistoModal
                    alunno={quick.alunno}
                    categoria={quick.categoria}
                    userId={userId}
                    scuolaId={scuolaId}
                    onClose={() => setQuick(null)}
                    onDone={() => { setQuick(null); load(); }}
                />
            )}

            {editing && (
                <ModificaPagamentoModal
                    pagamento={editing}
                    categorie={categorie}
                    userId={userId}
                    onClose={() => setEditing(null)}
                    onDone={() => { setEditing(null); load(); }}
                />
            )}

            {rateizza && (
                <RateizzaModal
                    alunno={rateizza.alunno}
                    userId={userId}
                    scuolaId={scuolaId}
                    categoriaId={rateizza.pagamento.categoria_id}
                    descrizione={rateizza.pagamento.descrizione}
                    importoTotale={Number(rateizza.pagamento.importo)}
                    obbligatorio={rateizza.pagamento.obbligatorio}
                    replacePagamentoId={rateizza.pagamento.id}
                    onClose={() => setRateizza(null)}
                    onDone={() => { setRateizza(null); load(); }}
                />
            )}

            {drawer && (
                <PagamentoDrawer
                    pagamento={drawer}
                    userId={userId}
                    onClose={() => setDrawer(null)}
                    onIncassa={() => { setSelected(drawer); setDrawer(null); }}
                    onModifica={() => { setEditing(drawer); setDrawer(null); }}
                    onRateizza={() => {
                        const a = alunni.find((x) => x.id === drawer.alunno_id);
                        if (a) setRateizza({ alunno: a, pagamento: drawer });
                        setDrawer(null);
                    }}
                    extra={
                        <SospensioneToggle alunnoId={drawer.alunno_id} userId={userId} sospeso={!!sospesoByAlunno.get(drawer.alunno_id)} onChange={load} />
                    }
                />
            )}
        </div>
    );
}
