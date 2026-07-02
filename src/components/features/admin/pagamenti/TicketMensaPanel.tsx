'use client';

import { useState, useEffect, useCallback } from 'react';
import { Ticket, Search, Plus, CheckCircle2 } from 'lucide-react';

interface Props { userId: string; scuolaId: string }
interface Alunno { id: string; nome: string; cognome: string; classe_sezione?: string }
interface Pacchetto { label: string; pezzi: number; costo: number }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

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

    useEffect(() => {
        fetch(`/api/admin/students?scuola_id=${scuolaId}`).then(r => r.json())
            .then(d => { if (Array.isArray(d)) setAlunni(d.map((a: Alunno) => ({ id: a.id, nome: a.nome, cognome: a.cognome, classe_sezione: a.classe_sezione }))); });
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) }).then(r => r.json())
            .then(d => { if (d.success) setPacchetti(d.data.ticket_pacchetti || []); });
    }, [scuolaId, userId]);

    const loadSaldo = useCallback((alunnoId: string) => {
        fetch(`/api/pagamenti/ticket?userId=${userId}&alunno_id=${alunnoId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setSaldo(d.data.saldo_ticket); });
    }, [userId]);

    const select = (a: Alunno) => { setSel(a); setDone(null); loadSaldo(a.id); };

    const ricarica = async () => {
        if (!sel) return;
        const res = await fetch('/api/pagamenti/ticket', { method: 'POST', headers: hdr(userId), body: JSON.stringify({ alunno_id: sel.id, pezzi, costo, metodo }) });
        const j = await res.json();
        if (j.success) { setSaldo(j.data.saldo_ticket); setDone(`Ricarica di ${pezzi} ticket registrata (€ ${costo}).`); }
        else alert(j.error);
    };

    const filtered = alunni.filter(a => `${a.nome} ${a.cognome}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8);

    return (
        <div className="grid md:grid-cols-2 gap-5">
            <div>
                <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><Search size={14} /> Seleziona alunno</h3>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca…"
                    className="w-full border-2 border-kidville-line rounded-full px-4 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green mb-2" />
                <div className="space-y-1 max-h-72 overflow-y-auto">
                    {filtered.map(a => (
                        <button key={a.id} onClick={() => select(a)}
                            className={`w-full text-left px-3 py-2 rounded-xl font-maven text-sm ${sel?.id === a.id ? 'bg-kidville-green text-white' : 'hover:bg-kidville-cream text-kidville-green'}`}>
                            {a.nome} {a.cognome} <span className="text-xs opacity-70">{a.classe_sezione}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div>
                <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-3 flex items-center gap-2"><Ticket size={14} /> Ricarica</h3>
                {!sel ? <p className="font-maven text-sm text-kidville-muted">Seleziona un alunno.</p> : (
                    <div className="bg-kidville-cream/60 rounded-xl p-4">
                        <div className="flex justify-between mb-3">
                            <span className="font-maven text-sm text-kidville-green font-bold">{sel.nome} {sel.cognome}</span>
                            <span className="font-maven text-sm text-kidville-muted">Saldo: <b className="text-kidville-green">{saldo ?? '—'}</b> ticket</span>
                        </div>
                        {pacchetti.length > 0 && (
                            <div className="flex flex-wrap gap-2 mb-3">
                                {pacchetti.map((p, i) => (
                                    <button key={i} onClick={() => { setPezzi(p.pezzi); setCosto(p.costo); }}
                                        className="px-3 py-1 rounded-full border-2 border-kidville-line font-maven text-xs text-kidville-green hover:border-kidville-green">
                                        {p.label} · {p.pezzi}pz · €{p.costo}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="grid grid-cols-3 gap-2 mb-3">
                            <div><label className="font-maven text-xs text-kidville-muted">Pezzi</label>
                                <input type="number" value={pezzi} onChange={e => setPezzi(Number(e.target.value))} className="w-full border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-sm text-kidville-green" /></div>
                            <div><label className="font-maven text-xs text-kidville-muted">Costo €</label>
                                <input type="number" value={costo} onChange={e => setCosto(Number(e.target.value))} className="w-full border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-sm text-kidville-green" /></div>
                            <div><label className="font-maven text-xs text-kidville-muted">Metodo</label>
                                <select value={metodo} onChange={e => setMetodo(e.target.value)} className="w-full border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-sm text-kidville-green bg-white">
                                    <option value="contanti">Contanti</option><option value="bonifico">Bonifico</option><option value="pos">POS</option>
                                </select></div>
                        </div>
                        <button onClick={ricarica} className="w-full py-2.5 rounded-full bg-kidville-green text-white font-maven font-bold text-sm flex items-center justify-center gap-1">
                            <Plus size={15} /> Ricarica (crea pagamento Mensa saldato)
                        </button>
                        {done && <p className="mt-2 font-maven text-xs text-kidville-success flex items-center gap-1"><CheckCircle2 size={13} /> {done}</p>}
                    </div>
                )}
            </div>
        </div>
    );
}
