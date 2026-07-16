'use client';

import { useState } from 'react';
import { X, ShoppingBag } from 'lucide-react';
import { motion } from 'framer-motion';
import { FatturaButton } from './FatturaButton';
import { RateizzaModal } from './RateizzaModal';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';
import { MODAL_OVERLAY, MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY } from './ui';

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
    // Anti-duplicato: al primo submit si controlla se esiste già un pagamento
    // gemello (stesso alunno+categoria, stesso importo, scadenza ±15gg); serve
    // una seconda conferma esplicita per procedere comunque.
    const [confermaDup, setConfermaDup] = useState<string | null>(null);

    const submit = async () => {
        if (!descrizione.trim()) { setError('Inserisci una descrizione'); return; }
        if (!importo || importo <= 0) { setError('Inserisci un importo maggiore di 0'); return; }
        setSaving(true);
        setError(null);
        if (!confermaDup) {
            try {
                const r = await fetch(`/api/pagamenti?alunno_id=${alunno.id}&categoria_id=${categoria.id}`, { headers: { 'x-user-id': userId } });
                const j = await r.json();
                const SOGLIA_MS = 15 * 86_400_000;
                const dup = ((j?.data || []) as { importo: number; scadenza?: string | null; descrizione?: string }[]).find(
                    (p) => Number(p.importo) === Number(importo) && p.scadenza && Math.abs(Date.parse(p.scadenza) - Date.parse(data)) <= SOGLIA_MS
                );
                if (dup) {
                    setConfermaDup(`Possibile duplicato: esiste già "${dup.descrizione}" da € ${Number(dup.importo).toFixed(2)} con scadenza ${dup.scadenza ? new Date(dup.scadenza).toLocaleDateString('it-IT') : '—'}.`);
                    setSaving(false);
                    return;
                }
            } catch {
                // controllo best-effort: se fallisce non blocca la registrazione
            }
        }
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
        <div className={MODAL_OVERLAY} onClick={onClose}>
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className={MODAL_CARD}
                style={{ boxShadow: MODAL_SHADOW }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                        <ShoppingBag size={18} /> Nuovo acquisto
                    </h3>
                    <button onClick={onClose} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                </div>

                <div className="bg-kidville-cream/60 rounded-card p-3 mb-4">
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
                        <button onClick={onDone} className={cx(BTN_PRIMARY, 'mt-2 w-full')}>
                            Chiudi
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="space-y-3">
                            <div>
                                <label className="font-maven text-xs text-kidville-muted mb-1 block">Descrizione</label>
                                <input type="text" value={descrizione} onChange={(e) => setDescrizione(e.target.value)}
                                    className={INPUT} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Importo (€)</label>
                                    <input type="number" min={0} step="0.01" value={importo || ''}
                                        onChange={(e) => { setImporto(e.target.value === '' ? 0 : Number(e.target.value)); setConfermaDup(null); }}
                                        className={INPUT} />
                                </div>
                                <div>
                                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Data</label>
                                    <input type="date" value={data} onChange={(e) => { setData(e.target.value); setConfermaDup(null); }}
                                        className={INPUT} />
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
                                        className={SELECT}>
                                        {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                                    </select>
                                </div>
                            )}

                            {!acconti && giaPagato && metodo === 'contanti' && (
                                <p className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] leading-snug text-kidville-warn">
                                    Contanti: pagamento non tracciabile. La quota non sarà detraibile nel 730 (art. 15 TUIR)
                                    e resterà esclusa dalla comunicazione delle spese scolastiche all&apos;AdE.
                                </p>
                            )}

                            {confermaDup && (
                                <p className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] leading-snug text-kidville-warn">
                                    {confermaDup}
                                </p>
                            )}

                            {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
                        </div>

                        <div className="flex gap-2 mt-5">
                            <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>
                                Annulla
                            </button>
                            {acconti ? (
                                <button onClick={() => {
                                    if (!descrizione.trim()) { setError('Inserisci una descrizione'); return; }
                                    if (!importo || importo <= 0) { setError('Inserisci un importo maggiore di 0'); return; }
                                    setError(null); setRateizza(true);
                                }}
                                    className={cx(BTN_PRIMARY, 'flex-1')}>
                                    Configura acconti
                                </button>
                            ) : (
                                <button onClick={submit} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1')}>
                                    {saving ? 'Salvataggio…' : confermaDup ? 'Conferma comunque' : 'Registra acquisto'}
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
