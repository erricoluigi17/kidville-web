'use client';

import { useState, useMemo } from 'react';
import { X, Layers, Plus, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';

interface Alunno { id: string; nome?: string; cognome?: string; classe_sezione?: string | null }
interface Rata { importo: number; scadenza: string }

interface Props {
    alunno: Alunno;
    userId: string;
    scuolaId?: string;
    categoriaId?: string | null;
    descrizione?: string;
    importoTotale?: number;
    obbligatorio?: boolean;
    /** se valorizzato, dopo aver creato il piano elimina il pagamento singolo originale */
    replacePagamentoId?: string;
    onClose: () => void;
    onDone: () => void;
}

function addMonths(iso: string, n: number): string {
    const d = new Date(iso + 'T00:00:00');
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
}

// Divide una una tantum in N acconti (rate). Default: rate uguali con scadenze
// mensili a partire da una data base; importi e date restano modificabili.
export function RateizzaModal({
    alunno, userId, scuolaId, categoriaId, descrizione = '', importoTotale = 0,
    obbligatorio = true, replacePagamentoId, onClose, onDone,
}: Props) {
    const [desc, setDesc] = useState(descrizione);
    const [totale, setTotale] = useState<number>(importoTotale);
    const [nRate, setNRate] = useState<number>(3);
    const [dataBase, setDataBase] = useState(() => new Date().toISOString().slice(0, 10));
    const [rate, setRate] = useState<Rata[] | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // genera N rate uguali (l'ultima assorbe l'arrotondamento) con scadenze mensili
    const genera = () => {
        if (!totale || totale <= 0) { setError('Inserisci un importo totale maggiore di 0'); return; }
        if (nRate < 2) { setError('Servono almeno 2 rate'); return; }
        const base = Math.floor((totale / nRate) * 100) / 100;
        const arr: Rata[] = [];
        for (let i = 0; i < nRate; i++) {
            const importo = i === nRate - 1 ? Math.round((totale - base * (nRate - 1)) * 100) / 100 : base;
            arr.push({ importo, scadenza: addMonths(dataBase, i) });
        }
        setRate(arr);
        setError(null);
    };

    const somma = useMemo(() => (rate || []).reduce((s, r) => s + Number(r.importo || 0), 0), [rate]);
    const sommaOk = Math.abs(somma - Number(totale)) < 0.01;

    const updateRata = (i: number, patch: Partial<Rata>) => {
        setRate((prev) => prev!.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    };
    const removeRata = (i: number) => setRate((prev) => prev!.filter((_, idx) => idx !== i));
    const addRata = () => setRate((prev) => [...prev!, { importo: 0, scadenza: addMonths(dataBase, prev!.length) }]);

    const submit = async () => {
        if (!desc.trim()) { setError('Inserisci una descrizione'); return; }
        if (!rate || rate.length < 2) { setError('Genera almeno 2 rate'); return; }
        if (!sommaOk) { setError(`La somma delle rate (€ ${somma.toFixed(2)}) deve coincidere col totale (€ ${Number(totale).toFixed(2)})`); return; }
        setSaving(true); setError(null);
        try {
            const res = await fetch('/api/pagamenti/rate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    alunno_id: alunno.id,
                    scuola_id: scuolaId,
                    descrizione: desc.trim(),
                    importo_totale: Number(totale),
                    categoria_id: categoriaId ?? null,
                    obbligatorio,
                    rate: rate.map((r) => ({ importo: Number(r.importo), scadenza: r.scadenza })),
                }),
            });
            const j = await res.json();
            if (!res.ok) { setError(j.error || 'Errore nella creazione del piano'); return; }
            // sostituzione: elimina il pagamento singolo originale
            if (replacePagamentoId) {
                await fetch(`/api/pagamenti/${replacePagamentoId}?userId=${userId}`, {
                    method: 'DELETE', headers: { 'x-user-id': userId },
                }).catch(() => {});
            }
            onDone();
        } catch {
            setError('Errore di rete');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                        <Layers size={18} /> Dividi in acconti
                    </h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
                </div>

                <div className="bg-kidville-cream/60 rounded-xl p-3 mb-4">
                    <p className="font-maven text-sm text-kidville-green font-bold">{alunno.nome} {alunno.cognome}</p>
                    <p className="font-maven text-xs text-gray-500">{alunno.classe_sezione || '—'}</p>
                </div>

                <div className="space-y-3">
                    <div>
                        <label className="font-maven text-xs text-gray-500 mb-1 block">Descrizione</label>
                        <input type="text" value={desc} onChange={(e) => setDesc(e.target.value)}
                            className="w-full border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        <div>
                            <label className="font-maven text-xs text-gray-500 mb-1 block">Totale (€)</label>
                            <input type="number" min={0} step="0.01" value={totale || ''}
                                onChange={(e) => setTotale(e.target.value === '' ? 0 : Number(e.target.value))}
                                className="w-full border-2 border-gray-200 rounded-xl px-2 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                        </div>
                        <div>
                            <label className="font-maven text-xs text-gray-500 mb-1 block">N° rate</label>
                            <input type="number" min={2} max={24} value={nRate}
                                onChange={(e) => setNRate(Math.max(2, Number(e.target.value) || 2))}
                                className="w-full border-2 border-gray-200 rounded-xl px-2 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                        </div>
                        <div>
                            <label className="font-maven text-xs text-gray-500 mb-1 block">1ª scadenza</label>
                            <input type="date" value={dataBase} onChange={(e) => setDataBase(e.target.value)}
                                className="w-full border-2 border-gray-200 rounded-xl px-2 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                        </div>
                    </div>
                    <button onClick={genera}
                        className="w-full py-2 rounded-full border-2 border-kidville-green text-kidville-green font-maven font-bold text-sm hover:bg-kidville-green/5">
                        Genera rate uguali
                    </button>

                    {rate && (
                        <div className="border border-gray-100 rounded-xl p-2 space-y-2">
                            {rate.map((r, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <span className="font-maven text-xs text-gray-400 w-6">{i + 1}.</span>
                                    <input type="number" min={0} step="0.01" value={r.importo || ''}
                                        onChange={(e) => updateRata(i, { importo: e.target.value === '' ? 0 : Number(e.target.value) })}
                                        className="w-24 border-2 border-gray-200 rounded-lg px-2 py-1.5 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                                    <input type="date" value={r.scadenza}
                                        onChange={(e) => updateRata(i, { scadenza: e.target.value })}
                                        className="flex-1 border-2 border-gray-200 rounded-lg px-2 py-1.5 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                                    <button onClick={() => removeRata(i)} disabled={rate.length <= 2}
                                        className="text-gray-300 hover:text-red-500 disabled:opacity-30"><Trash2 size={15} /></button>
                                </div>
                            ))}
                            <button onClick={addRata} className="flex items-center gap-1 text-kidville-green font-maven text-xs font-bold">
                                <Plus size={13} /> Aggiungi rata
                            </button>
                            <p className={`font-maven text-xs font-bold text-right ${sommaOk ? 'text-green-600' : 'text-red-500'}`}>
                                Somma: € {somma.toFixed(2)} / € {Number(totale).toFixed(2)}
                            </p>
                        </div>
                    )}

                    {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
                </div>

                <div className="flex gap-2 mt-5">
                    <button onClick={onClose} className="flex-1 py-2.5 rounded-full border-2 border-gray-200 font-maven font-bold text-sm text-gray-500 hover:bg-gray-50">
                        Annulla
                    </button>
                    <button onClick={submit} disabled={saving || !rate || !sommaOk}
                        className="flex-1 py-2.5 rounded-full bg-kidville-green font-maven font-bold text-sm text-white hover:opacity-90 disabled:opacity-50">
                        {saving ? 'Salvataggio…' : 'Crea piano rateale'}
                    </button>
                </div>
            </motion.div>
        </div>
    );
}
