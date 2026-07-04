'use client';

import { useState } from 'react';
import { X, ShoppingBag } from 'lucide-react';
import { motion } from 'framer-motion';
import { FatturaButton } from './FatturaButton';
import { RateizzaModal } from './RateizzaModal';
import { SaveCheck } from '@/components/ui/SaveConfirmation';

interface Alunno { id: string; nome?: string; cognome?: string; classe_sezione?: string | null }
interface Categoria { id: string; nome: string; slug?: string }

interface Props {
    alunno: Alunno;
    categoria: Categoria;
    userId: string;
    scuolaId?: string;
    onClose: () => void;
    onDone: () => void;
}

const METODI = [
    { v: 'contanti', l: 'Contanti' },
    { v: 'bonifico', l: 'Bonifico' },
    { v: 'pos', l: 'POS / Carta' },
    { v: 'assegno', l: 'Assegno' },
    { v: 'altro', l: 'Altro' },
];

// Acquisto una tantum: la segreteria seleziona un alunno e registra al volo
// un acquisto della categoria scelta (Gita, Divisa, Materiale…). Può marcarlo
// "già pagato" (crea l'incasso) e poi inviare la fattura, tutto dal popup.
export function QuickAcquistoModal({ alunno, categoria, userId, scuolaId, onClose, onDone }: Props) {
    const [descrizione, setDescrizione] = useState(categoria.nome);
    const [importo, setImporto] = useState<number>(0);
    const [obbligatorio, setObbligatorio] = useState(false);
    const [acconti, setAcconti] = useState(false);
    const [rateizza, setRateizza] = useState(false);
    const [giaPagato, setGiaPagato] = useState(true);
    const [metodo, setMetodo] = useState('contanti');
    const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [creato, setCreato] = useState<{ id: string; fattura_stato?: string } | null>(null);

    const submit = async () => {
        if (!descrizione.trim()) { setError('Inserisci una descrizione'); return; }
        if (!importo || importo <= 0) { setError('Inserisci un importo maggiore di 0'); return; }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch('/api/pagamenti', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    alunno_id: alunno.id,
                    scuola_id: scuolaId,
                    descrizione: descrizione.trim(),
                    importo,
                    scadenza: data,
                    categoria_id: categoria.id,
                    tipo: 'singolo',
                    obbligatorio,
                }),
            });
            const json = await res.json();
            if (!res.ok) { setError(json.error || 'Errore nella creazione'); return; }
            const pagamento = json.data;

            if (giaPagato) {
                const incRes = await fetch('/api/pagamenti/incassi', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                    body: JSON.stringify({
                        pagamento_id: pagamento.id,
                        importo,
                        data_incasso: data,
                        metodo,
                        spill: false,
                    }),
                });
                if (!incRes.ok) {
                    const j = await incRes.json().catch(() => ({}));
                    setError(j.error || 'Acquisto creato ma errore nella registrazione del pagamento');
                    setCreato({ id: pagamento.id, fattura_stato: pagamento.fattura_stato });
                    return;
                }
            }
            setCreato({ id: pagamento.id, fattura_stato: pagamento.fattura_stato });
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
                        <ShoppingBag size={18} /> Nuovo acquisto
                    </h3>
                    <button onClick={onClose} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                </div>

                <div className="bg-kidville-cream/60 rounded-xl p-3 mb-4">
                    <p className="font-maven text-sm text-kidville-green font-bold">
                        {alunno.nome} {alunno.cognome}
                    </p>
                    <p className="font-maven text-xs text-kidville-muted">
                        {alunno.classe_sezione || '—'} · Categoria: {categoria.nome}
                    </p>
                </div>

                {creato ? (
                    <div className="text-center py-4">
                        <span className="mx-auto mb-2 flex w-10 justify-center text-kidville-green"><SaveCheck size={40} /></span>
                        <p className="font-maven text-sm text-kidville-green font-bold mb-1">
                            Acquisto registrato{giaPagato ? ' e saldato' : ''}.
                        </p>
                        {error && <p className="font-maven text-xs text-kidville-warn mb-3">{error}</p>}
                        {giaPagato && (
                            <div className="flex justify-center my-3">
                                <FatturaButton pagamentoId={creato.id} userId={userId} fatturaStato={creato.fattura_stato} descrizione={descrizione} />
                            </div>
                        )}
                        <button onClick={onDone}
                            className="mt-2 w-full py-2.5 rounded-full bg-kidville-green font-maven font-bold text-sm text-white hover:opacity-90">
                            Chiudi
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="space-y-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Descrizione</label>
                                <input type="text" value={descrizione} onChange={(e) => setDescrizione(e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Importo (€)</label>
                                    <input type="number" min={0} step="0.01" value={importo || ''}
                                        onChange={(e) => setImporto(e.target.value === '' ? 0 : Number(e.target.value))}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                                </div>
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Data</label>
                                    <input type="date" value={data} onChange={(e) => setData(e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                                </div>
                            </div>

                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={obbligatorio} onChange={(e) => setObbligatorio(e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                                <span className="font-maven text-xs text-kidville-green">Pagamento obbligatorio (genera solleciti)</span>
                            </label>

                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={acconti} onChange={(e) => { setAcconti(e.target.checked); if (e.target.checked) setGiaPagato(false); }}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                                <span className="font-maven text-xs text-kidville-green">Dividi in acconti (rate)</span>
                            </label>

                            {!acconti && (
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={giaPagato} onChange={(e) => setGiaPagato(e.target.checked)}
                                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                                    <span className="font-maven text-xs text-kidville-green">Già pagato (registra subito l&apos;incasso)</span>
                                </label>
                            )}

                            {!acconti && giaPagato && (
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Metodo di pagamento</label>
                                    <select value={metodo} onChange={(e) => setMetodo(e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green">
                                        {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                                    </select>
                                </div>
                            )}

                            {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
                        </div>

                        <div className="flex gap-2 mt-5">
                            <button onClick={onClose} className="flex-1 py-2.5 rounded-full border-2 border-kidville-line font-maven font-bold text-sm text-kidville-muted hover:bg-kidville-cream">
                                Annulla
                            </button>
                            {acconti ? (
                                <button onClick={() => {
                                    if (!descrizione.trim()) { setError('Inserisci una descrizione'); return; }
                                    if (!importo || importo <= 0) { setError('Inserisci un importo maggiore di 0'); return; }
                                    setError(null); setRateizza(true);
                                }}
                                    className="flex-1 py-2.5 rounded-full bg-kidville-green font-maven font-bold text-sm text-white hover:opacity-90">
                                    Configura acconti
                                </button>
                            ) : (
                                <button onClick={submit} disabled={saving}
                                    className="flex-1 py-2.5 rounded-full bg-kidville-green font-maven font-bold text-sm text-white hover:opacity-90 disabled:opacity-50">
                                    {saving ? 'Salvataggio…' : 'Registra acquisto'}
                                </button>
                            )}
                        </div>
                    </>
                )}
            </motion.div>

            {rateizza && (
                <RateizzaModal
                    alunno={alunno}
                    userId={userId}
                    scuolaId={scuolaId}
                    categoriaId={categoria.id}
                    descrizione={descrizione}
                    importoTotale={importo}
                    obbligatorio={obbligatorio}
                    onClose={() => setRateizza(false)}
                    onDone={() => { setRateizza(false); onDone(); }}
                />
            )}
        </div>
    );
}
