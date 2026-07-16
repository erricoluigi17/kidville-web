'use client';

import { useState, useEffect, useCallback } from 'react';
import { Ticket, Search, Plus, History, AlertTriangle } from 'lucide-react';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import { STATI_PAGAMENTO as STATI, METODO_LABEL } from './stati';

interface Props { userId: string; scuolaId: string }
interface Alunno { id: string; nome: string; cognome: string; classe_sezione?: string }
interface Pacchetto { label: string; pezzi: number; costo: number }
interface Movimento {
    id: string;
    tipo: 'ricarica' | 'consumo' | 'disdetta' | 'rettifica';
    delta: number;
    saldo_dopo: number | null;
    data: string;
    origine: string | null;
    note: string | null;
    creato_il: string;
    pagamento_id: string | null;
    pagamenti?: { descrizione?: string; importo?: number; stato?: string; incassi?: { metodo?: string }[] } | null;
}
interface Storico { saldo_ticket: number; ultimo_carico: string | null; movimenti: Movimento[] }
interface Moroso { alunno_id: string; nome: string; cognome: string; classe_sezione?: string | null; saldo_ticket: number; ultimo_carico: string | null }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const dataIt = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('it-IT') : '—');

export function TicketMensaPanel({ userId, scuolaId }: Props) {
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [search, setSearch] = useState('');
    const [sel, setSel] = useState<Alunno | null>(null);
    const [saldo, setSaldo] = useState<number | null>(null);
    const [pacchetti, setPacchetti] = useState<Pacchetto[]>([]);
    const [pezzi, setPezzi] = useState(10);
    const [costo, setCosto] = useState(50);
    const [metodo, setMetodo] = useState('contanti');
    const [done, setDone] = useState<string | null>(null);
    const [confermaId, setConfermaId] = useState(0);
    const [storico, setStorico] = useState<Storico | null>(null);
    const [morosi, setMorosi] = useState<Moroso[]>([]);

    const loadMorosi = useCallback(() => {
        fetch(`/api/pagamenti/ticket/morosi?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setMorosi(d.data); }).catch(() => {});
    }, [userId, scuolaId]);

    useEffect(() => {
        fetch(`/api/admin/students?scuola_id=${scuolaId}&limit=1000`).then(r => r.json())
            .then(d => { if (Array.isArray(d)) setAlunni(d.map((a: Alunno) => ({ id: a.id, nome: a.nome, cognome: a.cognome, classe_sezione: a.classe_sezione }))); });
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) }).then(r => r.json())
            .then(d => { if (d.success) setPacchetti(d.data.ticket_pacchetti || []); });
        loadMorosi();
    }, [scuolaId, userId, loadMorosi]);

    const loadSaldo = useCallback((alunnoId: string) => {
        fetch(`/api/pagamenti/ticket?userId=${userId}&alunno_id=${alunnoId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setSaldo(d.data.saldo_ticket); });
    }, [userId]);

    const loadStorico = useCallback((alunnoId: string) => {
        fetch(`/api/pagamenti/ticket/storico?userId=${userId}&alunno_id=${alunnoId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setStorico(d.data); }).catch(() => {});
    }, [userId]);

    const select = (a: Alunno) => { setSel(a); setDone(null); setStorico(null); loadSaldo(a.id); loadStorico(a.id); };

    const ricarica = async () => {
        if (!sel) return;
        const res = await fetch('/api/pagamenti/ticket', { method: 'POST', headers: hdr(userId), body: JSON.stringify({ alunno_id: sel.id, pezzi, costo, metodo }) });
        const j = await res.json();
        if (j.success) {
            setSaldo(j.data.saldo_ticket);
            setDone(`Ricarica di ${pezzi} ticket registrata (€ ${costo}).`);
            setConfermaId(n => n + 1);
            loadStorico(sel.id);
            loadMorosi();
        } else alert(j.error);
    };

    const filtered = alunni.filter(a => `${a.nome} ${a.cognome}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8);
    const ricariche = storico?.movimenti.filter(m => m.tipo === 'ricarica') ?? [];
    // tutto ciò che non è ricarica (consumi, disdette, rettifiche): niente movimenti
    // silenziosamente nascosti, così la somma dei delta mostrati quadra col saldo
    const altriMovimenti = storico?.movimenti.filter(m => m.tipo !== 'ricarica') ?? [];

    return (
        <div className="space-y-5">
            {/* Morosità ticket: alunni con saldo negativo (req E) */}
            {morosi.length > 0 && (
                <div className="rounded-card border-[1.5px] border-kidville-error-soft bg-kidville-error-soft px-4 py-3">
                    <div className="flex items-center gap-2 text-kidville-error mb-2">
                        <AlertTriangle size={18} />
                        <span className="font-barlow font-bold uppercase text-sm">Morosi ticket · saldo negativo ({morosi.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {morosi.map(m => (
                            <button key={m.alunno_id}
                                onClick={() => select({ id: m.alunno_id, nome: m.nome, cognome: m.cognome, classe_sezione: m.classe_sezione ?? undefined })}
                                className="px-3 py-1.5 rounded-input bg-kidville-white border border-kidville-error/30 font-maven text-xs text-kidville-error transition-colors hover:border-kidville-error">
                                {m.nome} {m.cognome} <b>{m.saldo_ticket}</b>{m.classe_sezione ? <span className="opacity-70"> · {m.classe_sezione}</span> : null}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="grid md:grid-cols-2 gap-5">
                <div>
                    <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><Search size={14} /> Seleziona alunno</h3>
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca…"
                        className="w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-4 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15 mb-2" />
                    <div className="space-y-1 max-h-72 overflow-y-auto">
                        {filtered.map(a => (
                            <button key={a.id} onClick={() => select(a)}
                                className={cx('w-full text-left px-3 py-2 rounded-input font-maven text-sm transition-colors', sel?.id === a.id ? 'bg-kidville-green text-kidville-white' : 'text-kidville-green hover:bg-kidville-cream')}>
                                {a.nome} {a.cognome} <span className="text-xs opacity-70">{a.classe_sezione}</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div>
                    <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><Ticket size={14} /> Ricarica</h3>
                    {!sel ? <p className="font-maven text-sm text-kidville-muted">Seleziona un alunno.</p> : (
                        <div className={cx('rounded-card p-4', (saldo ?? 0) < 0 ? 'bg-kidville-error-soft/50' : 'bg-kidville-cream/60')}>
                            <div className="flex justify-between mb-3">
                                <span className="font-maven text-sm text-kidville-green font-bold">{sel.nome} {sel.cognome}</span>
                                <span className="font-maven text-sm text-kidville-muted">Saldo: <b className={(saldo ?? 0) < 0 ? 'text-kidville-error' : 'text-kidville-green'}>{saldo ?? '—'}</b> ticket</span>
                            </div>
                            {pacchetti.length > 0 && (
                                <div className="flex flex-wrap gap-2 mb-3">
                                    {pacchetti.map((p, i) => (
                                        <button key={i} onClick={() => { setPezzi(p.pezzi); setCosto(p.costo); }}
                                            className="px-3 py-1 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white font-maven text-xs text-kidville-green transition-colors hover:border-kidville-green">
                                            {p.label} · {p.pezzi}pz · €{p.costo}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <div className="grid grid-cols-3 gap-2 mb-3">
                                <div><label className="font-maven text-xs text-kidville-muted">Pezzi</label>
                                    <input type="number" value={pezzi} onChange={e => setPezzi(Number(e.target.value))} className="w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15" /></div>
                                <div><label className="font-maven text-xs text-kidville-muted">Costo €</label>
                                    <input type="number" value={costo} onChange={e => setCosto(Number(e.target.value))} className="w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15" /></div>
                                <div><label className="font-maven text-xs text-kidville-muted">Metodo</label>
                                    <select value={metodo} onChange={e => setMetodo(e.target.value)} className="w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15">
                                        <option value="contanti">Contanti</option><option value="bonifico">Bonifico</option><option value="pos">POS</option>
                                    </select></div>
                            </div>
                            <button onClick={ricarica} className="w-full py-2.5 rounded-pill bg-kidville-green text-kidville-yellow font-maven font-bold text-sm flex items-center justify-center gap-1 transition-colors hover:bg-kidville-green-dark">
                                <Plus size={15} /> Ricarica (crea pagamento Mensa saldato)
                            </button>
                            {done && <p key={confermaId} className="mt-2 font-maven text-xs text-kidville-success flex items-center gap-1"><SaveCheck size={14} /> {done}</p>}
                        </div>
                    )}
                </div>
            </div>

            {/* Storico ticket per-alunno (req D) */}
            {sel && storico && (
                <div>
                    <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2">
                        <History size={14} /> Storico ticket di {sel.nome} {sel.cognome}
                    </h3>
                    <div className="grid md:grid-cols-2 gap-4">
                        {/* Ricariche acquistate */}
                        <div>
                            <p className="font-maven text-xs font-bold text-kidville-muted uppercase mb-2">Ticket acquistati</p>
                            {ricariche.length === 0 ? (
                                <p className="font-maven text-sm text-kidville-muted">Nessuna ricarica registrata.</p>
                            ) : (
                                <div className="space-y-1">
                                    {ricariche.map(m => {
                                        const importo = Number(m.pagamenti?.importo ?? 0);
                                        // 'Gratuita' solo se il pagamento esiste ancora ed è a costo 0;
                                        // se il pagamento è stato eliminato (embed null) non affermarlo
                                        const gratis = m.pagamento_id != null && importo <= 0;
                                        const st = m.pagamenti?.stato ? (STATI[m.pagamenti.stato] ?? STATI.da_pagare) : null;
                                        const met = m.pagamenti?.incassi?.[0]?.metodo;
                                        return (
                                            <div key={m.id} className="flex items-center justify-between gap-2 bg-kidville-cream/40 rounded-lg px-3 py-1.5">
                                                <div className="min-w-0">
                                                    <p className="font-maven text-xs text-kidville-ink truncate">{dataIt(m.creato_il)} · +{m.delta} ticket · € {importo.toFixed(2)}</p>
                                                    {met && !gratis && <p className="font-maven text-[10px] text-kidville-muted">{METODO_LABEL[met] ?? met}</p>}
                                                </div>
                                                {gratis
                                                    ? <Badge tone="neutral" className="shrink-0">Gratuita</Badge>
                                                    : st && <Badge tone={st.tone} className="shrink-0">{st.label}</Badge>}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        {/* Consumi, disdette e rettifiche */}
                        <div>
                            <p className="font-maven text-xs font-bold text-kidville-muted uppercase mb-2">Consumi e movimenti</p>
                            {altriMovimenti.length === 0 ? (
                                <p className="font-maven text-sm text-kidville-muted">Nessun consumo registrato.</p>
                            ) : (
                                <div className="space-y-1 max-h-64 overflow-y-auto">
                                    {altriMovimenti.map(m => {
                                        const isRett = m.tipo === 'rettifica';
                                        const badgeTone: BadgeTone = m.tipo === 'disdetta' ? 'warn' : isRett ? 'read' : 'neutral';
                                        const badgeTxt = m.tipo === 'disdetta' ? `Disdetta +${m.delta}`
                                            : isRett ? `Rettifica ${m.delta >= 0 ? '+' : ''}${m.delta}` : `Consumo ${m.delta}`;
                                        return (
                                            <div key={m.id} className="flex items-center justify-between gap-2 bg-kidville-cream/40 rounded-input px-3 py-1.5">
                                                <span className="font-maven text-xs text-kidville-ink truncate">
                                                    {isRett ? (m.note ?? 'Rettifica') : <>{dataIt(m.data)}{m.origine ? <span className="text-kidville-muted"> · {m.origine}</span> : null}</>}
                                                </span>
                                                <Badge tone={badgeTone} className="shrink-0">{badgeTxt}</Badge>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
