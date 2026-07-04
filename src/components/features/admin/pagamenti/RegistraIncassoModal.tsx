'use client';

import { useState } from 'react';
import { X, Euro } from 'lucide-react';
import { motion } from 'framer-motion';
import { FatturaButton } from './FatturaButton';
import { SaveCheck } from '@/components/ui/SaveConfirmation';

export interface PagamentoRow {
    id: string;
    descrizione: string;
    importo: number;
    importo_pagato: number;
    stato: string;
    tipo: string;
    parent_payment_id?: string | null;
    fattura_stato?: string;
    alunni?: { nome?: string; cognome?: string };
}

const METODI = [
    { v: 'contanti', l: 'Contanti' },
    { v: 'bonifico', l: 'Bonifico' },
    { v: 'pos', l: 'POS / Carta' },
    { v: 'assegno', l: 'Assegno' },
    { v: 'altro', l: 'Altro' },
];

interface Props {
    pagamento: PagamentoRow;
    userId: string;
    onClose: () => void;
    onDone: () => void;
}

export function RegistraIncassoModal({ pagamento, userId, onClose, onDone }: Props) {
    const mancante = Math.max(0, Number(pagamento.importo) - Number(pagamento.importo_pagato));
    const [importo, setImporto] = useState<number>(mancante);
    const [metodo, setMetodo] = useState('contanti');
    const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
    const [note, setNote] = useState('');
    const [spill, setSpill] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saldato, setSaldato] = useState(pagamento.stato === 'pagato');

    const eccedenza = importo - mancante;
    const isRata = !!pagamento.parent_payment_id;

    const submit = async () => {
        if (!importo || importo === 0) { setError('Inserisci un importo'); return; }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch('/api/pagamenti/incassi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    pagamento_id: pagamento.id,
                    importo,
                    data_incasso: data,
                    metodo,
                    note: note || null,
                    spill: isRata ? spill : false,
                }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.error || 'Errore nella registrazione'); return; }
            // Se l'incasso salda il pagamento, resta nel popup per inviare la fattura
            if (importo >= mancante) setSaldato(true);
            else onDone();
        } catch {
            setError('Errore di rete');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                        <Euro size={18} /> Registra incasso
                    </h3>
                    <button onClick={onClose} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                </div>

                <div className="bg-kidville-cream/60 rounded-xl p-3 mb-4">
                    <p className="font-maven text-sm text-kidville-green font-bold">{pagamento.descrizione}</p>
                    <p className="font-maven text-xs text-kidville-muted">
                        {pagamento.alunni?.nome} {pagamento.alunni?.cognome}
                    </p>
                    <div className="flex justify-between mt-2 font-maven text-xs">
                        <span className="text-kidville-muted">Totale € {Number(pagamento.importo).toFixed(2)}</span>
                        <span className="text-kidville-muted">Già incassato € {Number(pagamento.importo_pagato).toFixed(2)}</span>
                        <span className="text-kidville-green font-bold">Resta € {mancante.toFixed(2)}</span>
                    </div>
                </div>

                <div className={`space-y-3 ${saldato ? 'hidden' : ''}`}>
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">Importo incassato (€)</label>
                        <input
                            type="number" min={0} step="0.01" value={importo || ''}
                            onChange={(e) => setImporto(e.target.value === '' ? 0 : Number(e.target.value))}
                            className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                        />
                        {importo > 0 && importo < mancante && (
                            <p className="font-maven text-[11px] text-kidville-warn mt-1">Pagamento parziale: resterà € {(mancante - importo).toFixed(2)}.</p>
                        )}
                        {eccedenza > 0 && (
                            <p className="font-maven text-[11px] text-kidville-warn mt-1">
                                Eccedenza € {eccedenza.toFixed(2)}{isRata && spill ? ' → riportata sulla rata successiva.' : '.'}
                            </p>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">Metodo</label>
                            <select value={metodo} onChange={(e) => setMetodo(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green">
                                {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">Data</label>
                            <input type="date" value={data} onChange={(e) => setData(e.target.value)}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                        </div>
                    </div>

                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">Note (facoltativo)</label>
                        <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                    </div>

                    {isRata && eccedenza > 0 && (
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={spill} onChange={(e) => setSpill(e.target.checked)}
                                className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                            <span className="font-maven text-xs text-kidville-green">Riporta l&apos;eccedenza sulla rata successiva</span>
                        </label>
                    )}

                    {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
                </div>

                {saldato ? (
                    <div className="mt-5">
                        <div className="flex items-center justify-between gap-2 bg-kidville-success-soft rounded-xl px-3 py-2.5 mb-3">
                            <span className="flex items-center gap-1.5 font-maven text-sm text-kidville-success font-bold">
                                <SaveCheck size={17} /> Pagamento saldato
                            </span>
                            <FatturaButton pagamentoId={pagamento.id} userId={userId} fatturaStato={pagamento.fattura_stato} descrizione={pagamento.descrizione} />
                        </div>
                        <button onClick={onDone}
                            className="w-full py-2.5 rounded-full bg-kidville-green font-maven font-bold text-sm text-white hover:opacity-90">
                            Chiudi
                        </button>
                    </div>
                ) : (
                    <div className="flex gap-2 mt-5">
                        <button onClick={onClose} className="flex-1 py-2.5 rounded-full border-2 border-kidville-line font-maven font-bold text-sm text-kidville-muted hover:bg-kidville-cream">
                            Annulla
                        </button>
                        <button onClick={submit} disabled={saving}
                            className="flex-1 py-2.5 rounded-full bg-kidville-green font-maven font-bold text-sm text-white hover:opacity-90 disabled:opacity-50">
                            {saving ? 'Salvataggio…' : 'Registra'}
                        </button>
                    </div>
                )}
            </motion.div>
        </div>
    );
}
