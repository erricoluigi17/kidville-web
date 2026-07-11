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
import { AGING_LABEL, bucketScadenze, type AgingBucketId } from '@/lib/pagamenti/aging';
import { Badge } from '@/components/ui/Badge';
import { StatCard } from '@/components/ui/cockpit';

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

    // mappa per categoria non-retta: alunno_id -> pagamenti di quella categoria
    const pagByAlunnoCat = useMemo(() => {
        const m = new Map<string, Pagamento[]>();
        for (const p of pagamenti) {
            if (p.categoria_id === fCategoria) {
                const arr = m.get(p.alunno_id) || [];
                arr.push(p);
                m.set(p.alunno_id, arr);
            }
        }
        return m;
    }, [pagamenti, fCategoria]);

    const alunniFiltrati = useMemo(() => {
        const q = search.trim().toLowerCase();
        return alunni.filter((a) => {
            if (q) {
                const nome = `${a.nome ?? ''} ${a.cognome ?? ''} ${a.classe_sezione ?? ''}`.toLowerCase();
                if (!nome.includes(q)) return false;
            }
            if (isRettaView && onlyMorosi) {
                const p = rettaByAlunno.get(a.id);
                if (!p || p.stato !== 'scaduto') return false;
            }
            return true;
        });
    }, [alunni, search, isRettaView, onlyMorosi, rettaByAlunno]);

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
    const oggiStr = now.toISOString().slice(0, 10);
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
                        className="rounded-full border border-kidville-error/40 bg-white px-3 py-1 font-maven text-xs font-bold text-kidville-error">
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

            {/* KPI (StatCard cockpit): 2 colonne su mobile, 4 su desktop */}
            <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
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
                        className="w-full pl-9 pr-3 py-2 border-2 border-kidville-line rounded-full font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                    />
                </div>
                <select value={fCategoria} onChange={(e) => setFCategoria(e.target.value)}
                    className="py-2 px-3 border-2 border-kidville-line rounded-full font-maven text-sm text-kidville-green bg-white">
                    {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                </select>

                {/* Filtro mensilità: solo nella vista Rette */}
                {isRettaView && (
                    <>
                        <select value={annoScolastico} onChange={(e) => { const y = Number(e.target.value); setAnnoScolastico(y); setMese(`${y}-09-01`); }}
                            className="py-2 px-3 border-2 border-kidville-line rounded-full font-maven text-sm text-kidville-green bg-white">
                            {[annoScolasticoCorrente - 1, annoScolasticoCorrente, annoScolasticoCorrente + 1].map((y) => (
                                <option key={y} value={y}>A.S. {y}/{y + 1}</option>
                            ))}
                        </select>
                        <select value={periodi.some((p) => p.periodo === mese) ? mese : periodi[0].periodo}
                            onChange={(e) => setMese(e.target.value)}
                            className="py-2 px-3 border-2 border-kidville-line rounded-full font-maven text-sm text-kidville-green bg-white">
                            {periodi.map((p) => <option key={p.periodo} value={p.periodo}>{p.label}</option>)}
                        </select>
                        <button onClick={() => setOnlyMorosi((v) => !v)}
                            className={`py-2 px-3 rounded-full font-maven text-sm font-bold flex items-center gap-1 ${onlyMorosi ? 'bg-kidville-error-soft text-kidville-error' : 'border-2 border-kidville-line text-kidville-muted'}`}>
                            <Filter size={14} /> Morosi
                        </button>
                    </>
                )}
                <button onClick={() => { setLoading(true); load(); }} aria-label="Aggiorna" title="Aggiorna" className="py-2 px-3 rounded-full border-2 border-kidville-line text-kidville-muted hover:text-kidville-green">
                    <RefreshCw size={14} />
                </button>
                <a href={`/api/pagamenti/export?tipo=scadenzario&userId=${userId}&scuola_id=${scuolaId}`} title="Esporta XLSX" aria-label="Esporta XLSX"
                    className="py-2 px-3 rounded-full border-2 border-kidville-line text-kidville-muted hover:text-kidville-green">
                    <Download size={14} />
                </a>
            </div>
            )}

            {/* CTA generazione rette mancanti */}
            {isRettaView && !loading && mancantiRette > 0 && (
                <div className="flex items-center justify-between gap-2 bg-kidville-warn-soft border border-kidville-warn/30 rounded-xl px-3 py-2 mb-3">
                    <span className="font-maven text-xs text-kidville-warn">
                        {mancantiRette} alunni senza retta generata per {periodi.find((p) => p.periodo === mese)?.label}.
                    </span>
                    <button onClick={generaMese} disabled={generando}
                        className="px-3 py-1 rounded-full bg-kidville-green text-white text-xs font-bold hover:opacity-90 disabled:opacity-50">
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
                        className="inline-flex items-center gap-1 rounded-full border-2 border-kidville-line px-2.5 py-1 font-maven text-xs font-bold text-kidville-muted hover:border-kidville-green hover:text-kidville-green">
                        <X size={12} /> Chiudi
                    </button>
                </div>
                {agendaItems.length === 0 ? (
                    <p className="font-maven text-sm text-kidville-muted py-8 text-center">Nessun pagamento in questo intervallo.</p>
                ) : (
                    <>
                    <div className="hidden lg:block overflow-x-auto">
                        <table className="w-full text-left">
                            <thead>
                                <tr className="font-maven text-xs text-kidville-muted uppercase">
                                    <th className="py-2 px-2">Alunno</th>
                                    <th className="py-2 px-2">Descrizione</th>
                                    <th className="py-2 px-2">Scadenza</th>
                                    <th className="py-2 px-2 text-right">Residuo</th>
                                    <th className="py-2 px-2">Stato</th>
                                    <th className="py-2 px-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {agendaItems.map((p) => {
                                    const st = STATI[p.stato] ?? STATI.da_pagare;
                                    const residuo = Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0));
                                    return (
                                        <tr key={p.id} className="border-t border-kidville-line font-maven text-sm">
                                            <td className="py-2 px-2 text-kidville-green font-semibold">{p.alunni?.nome} {p.alunni?.cognome}</td>
                                            <td className="py-2 px-2 text-kidville-ink">{p.descrizione}</td>
                                            <td className="py-2 px-2 text-kidville-muted">{p.scadenza ? new Date(p.scadenza).toLocaleDateString('it-IT') : '—'}</td>
                                            <td className="py-2 px-2 text-right font-bold text-kidville-green">€ {residuo.toFixed(2)}</td>
                                            <td className="py-2 px-2">
                                                <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${st.cls}`}>{st.label}</span>
                                            </td>
                                            <td className="py-2 px-2 text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <button onClick={() => setSelected(p)}
                                                        className="px-3 py-1 rounded-full bg-kidville-green text-white text-xs font-bold hover:opacity-90">Incassa</button>
                                                    <button onClick={() => setDrawer(p)} title="Dettagli"
                                                        className="text-kidville-muted hover:text-kidville-green"><Eye size={15} /></button>
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
            ) : alunniFiltrati.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted py-8 text-center">Nessun alunno attivo trovato.</p>
            ) : isRettaView ? (
                /* ---- Vista RETTE: tabella su desktop, card-list su mobile ---- */
                <>
                <div className="hidden lg:block overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="font-maven text-xs text-kidville-muted uppercase">
                                <th className="py-2 px-2">Alunno</th>
                                <th className="py-2 px-2">Sezione</th>
                                <th className="py-2 px-2 text-right">Importo</th>
                                <th className="py-2 px-2 text-right">Pagato</th>
                                <th className="py-2 px-2">Stato</th>
                                <th className="py-2 px-2"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {alunniFiltrati.map((a) => {
                                const p = rettaByAlunno.get(a.id);
                                const st = p ? (STATI[p.stato] ?? STATI.da_pagare) : null;
                                const isMoroso = p?.stato === 'scaduto';
                                return (
                                    <tr key={a.id} className={`border-t border-kidville-line font-maven text-sm ${isMoroso ? 'bg-kidville-error-soft/50' : ''}`}>
                                        <td className="py-2 px-2 text-kidville-green font-semibold">
                                            {a.nome} {a.cognome}
                                            {sospesoByAlunno.get(a.id) && (
                                                <span className="ml-1 inline-block px-1.5 py-0.5 rounded-full bg-kidville-error-soft text-kidville-error text-[10px] font-bold align-middle">sospeso</span>
                                            )}
                                        </td>
                                        <td className="py-2 px-2 text-kidville-muted">{a.classe_sezione || '—'}</td>
                                        <td className="py-2 px-2 text-right text-kidville-green">{p ? `€ ${Number(p.importo).toFixed(2)}` : '—'}</td>
                                        <td className="py-2 px-2 text-right text-kidville-muted">{p ? `€ ${Number(p.importo_pagato).toFixed(2)}` : '—'}</td>
                                        <td className="py-2 px-2">
                                            <span className="inline-flex flex-wrap items-center gap-1">
                                                {st
                                                    ? <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${st.cls}`}>{st.label}</span>
                                                    : <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-kidville-cream text-kidville-muted">Non generata</span>}
                                                {p && <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} />}
                                            </span>
                                        </td>
                                        <td className="py-2 px-2 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                {p && p.stato !== 'pagato' ? (
                                                    <button onClick={() => setSelected(p)}
                                                        className="px-3 py-1 rounded-full bg-kidville-green text-white text-xs font-bold hover:opacity-90">Incassa</button>
                                                ) : p ? (
                                                    <FatturaButton pagamentoId={p.id} userId={userId} fatturaStato={p.fattura_stato} descrizione={p.descrizione} />
                                                ) : null}
                                                {p && (
                                                    <button onClick={() => setDrawer(p)} title="Dettagli"
                                                        className="text-kidville-muted hover:text-kidville-green"><Eye size={15} /></button>
                                                )}
                                                {p && (
                                                    <button onClick={() => setEditing(p)} title="Modifica"
                                                        className="text-kidville-muted hover:text-kidville-green"><Pencil size={15} /></button>
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
                                <div key={a.id} className="flex items-center justify-between rounded-xl border-2 border-kidville-line bg-kidville-white p-3">
                                    <p className="font-maven text-sm font-bold text-kidville-green">{a.nome} {a.cognome}</p>
                                    <span className="inline-block rounded-full bg-kidville-cream px-2 py-0.5 text-xs font-bold text-kidville-muted">Non generata</span>
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
            ) : (
                /* ---- Vista CATEGORIA (una tantum): anagrafica cliccabile ---- */
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {alunniFiltrati.map((a) => {
                        const acquisti = pagByAlunnoCat.get(a.id) || [];
                        return (
                            <div key={a.id} className="text-left bg-white border-2 border-kidville-line rounded-xl p-3">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="font-maven text-sm text-kidville-green font-bold">{a.nome} {a.cognome}</p>
                                        <p className="font-maven text-xs text-kidville-muted">{a.classe_sezione || '—'}</p>
                                    </div>
                                    <button onClick={() => categoriaSel && setQuick({ alunno: a, categoria: categoriaSel })}
                                        title="Nuovo acquisto"
                                        className="w-7 h-7 rounded-full bg-kidville-green/10 text-kidville-green flex items-center justify-center hover:bg-kidville-green hover:text-white">
                                        <Plus size={15} />
                                    </button>
                                </div>
                                {acquisti.length > 0 && (
                                    <div className="mt-2 space-y-1">
                                        {acquisti.map((p) => (
                                            <div key={p.id} className="flex items-center justify-between gap-2 bg-kidville-cream/40 rounded-lg px-2 py-1">
                                                <span className="font-maven text-[11px] text-kidville-ink truncate">
                                                    {p.descrizione} · € {Number(p.importo).toFixed(2)}
                                                </span>
                                                <div className="flex items-center gap-1.5 shrink-0">
                                                    <FatturaChip stato={p.stato} fatturaStato={p.fattura_stato} />
                                                    {p.tipo === 'singolo' && p.stato !== 'pagato' && (
                                                        <button onClick={() => setRateizza({ alunno: a, pagamento: p })} title="Dividi in acconti"
                                                            className="text-kidville-muted hover:text-kidville-green"><Layers size={13} /></button>
                                                    )}
                                                    <button onClick={() => setDrawer(p)} title="Dettagli"
                                                        className="text-kidville-muted hover:text-kidville-green"><Eye size={13} /></button>
                                                    <button onClick={() => setEditing(p)} title="Modifica"
                                                        className="text-kidville-muted hover:text-kidville-green"><Pencil size={13} /></button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
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
