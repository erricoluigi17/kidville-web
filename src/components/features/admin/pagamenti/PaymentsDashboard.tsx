'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Filter, AlertTriangle, CheckCircle2, Clock, RefreshCw, Plus, Pencil, Layers } from 'lucide-react';
import { RegistraIncassoModal, PagamentoRow } from './RegistraIncassoModal';
import { FatturaButton } from './FatturaButton';
import { SospensioneToggle } from './SospensioneToggle';
import { QuickAcquistoModal } from './QuickAcquistoModal';
import { ModificaPagamentoModal } from './ModificaPagamentoModal';
import { RateizzaModal } from './RateizzaModal';
import { Badge } from '@/components/ui/Badge';

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

const STATI: Record<string, { label: string; cls: string }> = {
    da_pagare: { label: 'Da pagare', cls: 'bg-kidville-line text-kidville-ink' },
    parziale: { label: 'Parziale', cls: 'bg-kidville-warn-soft text-kidville-warn' },
    pagato: { label: 'Pagato', cls: 'bg-kidville-success-soft text-kidville-success' },
    scaduto: { label: 'Scaduto', cls: 'bg-kidville-error-soft text-kidville-error' },
};

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
    const [quick, setQuick] = useState<{ alunno: Alunno; categoria: Categoria } | null>(null);
    const [generando, setGenerando] = useState(false);
    const [arubaGated, setArubaGated] = useState(false);

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
                fetch(`/api/pagamenti?userId=${userId}&scuola_id=${scuolaId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
                fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=1000`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
            ]);
            if (pagRes.success) setPagamenti(pagRes.data);
            const lista: Alunno[] = Array.isArray(alRes) ? alRes : (alRes.data || []);
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

    const totals = useMemo(() => {
        let incassato = 0, daIncassare = 0, scaduto = 0;
        for (const p of pagamenti) {
            incassato += Number(p.importo_pagato || 0);
            const resto = Number(p.importo) - Number(p.importo_pagato || 0);
            if (resto > 0) daIncassare += resto;
            if (p.stato === 'scaduto') scaduto += resto;
        }
        return { incassato, daIncassare, scaduto };
    }, [pagamenti]);

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

    const fattureScartate = pagamenti.filter((p) => p.fattura_stato === 'scartata').length;
    // Mappa alunno → sospeso (DL-021), derivata dal payload pagamenti.
    const sospesoByAlunno = new Map<string, boolean>();
    for (const p of pagamenti) {
        if (p.alunno_id) sospesoByAlunno.set(p.alunno_id, !!(p as { alunni?: { sospeso?: boolean } }).alunni?.sospeso);
    }

    return (
        <div>
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

            {/* KPI */}
            <div className="grid grid-cols-3 gap-3 mb-5">
                <KPI icon={<CheckCircle2 size={16} />} label="Incassato" value={totals.incassato} color="text-kidville-success" />
                <KPI icon={<Clock size={16} />} label="Da incassare" value={totals.daIncassare} color="text-kidville-warn" />
                <KPI icon={<AlertTriangle size={16} />} label="Scaduto (morosità)" value={totals.scaduto} color="text-kidville-error" />
            </div>

            {/* Filtri */}
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
                        <select value={annoScolastico} onChange={(e) => setAnnoScolastico(Number(e.target.value))}
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
                <button onClick={() => { setLoading(true); load(); }} className="py-2 px-3 rounded-full border-2 border-kidville-line text-kidville-muted hover:text-kidville-green">
                    <RefreshCw size={14} />
                </button>
            </div>

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
            ) : alunniFiltrati.length === 0 ? (
                <p className="font-maven text-sm text-kidville-muted py-8 text-center">Nessun alunno attivo trovato.</p>
            ) : isRettaView ? (
                /* ---- Vista RETTE: una riga per alunno con la retta del mese ---- */
                <div className="overflow-x-auto">
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
                                            {st
                                                ? <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${st.cls}`}>{st.label}</span>
                                                : <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-kidville-cream text-kidville-muted">Non generata</span>}
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
                                                    {p.tipo === 'singolo' && p.stato !== 'pagato' && (
                                                        <button onClick={() => setRateizza({ alunno: a, pagamento: p })} title="Dividi in acconti"
                                                            className="text-kidville-muted hover:text-kidville-green"><Layers size={13} /></button>
                                                    )}
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
        </div>
    );
}

function KPI({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: number; color: string }) {
    return (
        <div className="bg-white rounded-xl border border-kidville-line p-3">
            <div className={`flex items-center gap-1 ${color} mb-1`}>{icon}<span className="font-maven text-xs uppercase">{label}</span></div>
            <p className="font-barlow font-black text-xl text-kidville-green">€ {value.toFixed(2)}</p>
        </div>
    );
}
