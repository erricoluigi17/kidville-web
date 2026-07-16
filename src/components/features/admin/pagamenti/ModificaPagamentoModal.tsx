'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Pencil, Trash2, Save } from 'lucide-react';
import { motion } from 'framer-motion';
import { cx } from '@/lib/ui/cx';
import { MODAL_OVERLAY, MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY } from './ui';

// Campo inline compatto per la correzione di un incasso già registrato.
const INLINE_FIELD = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

interface Categoria { id: string; nome: string }
interface Incasso { id: string; importo: number; data_incasso: string; metodo: string; note?: string | null }
interface PagamentoBase {
    id: string; descrizione: string; importo: number; scadenza: string;
    categoria_id?: string | null; obbligatorio: boolean; stato: string;
    alunni?: { nome?: string; cognome?: string };
}

interface Props {
    pagamento: PagamentoBase;
    categorie: Categoria[];
    userId: string;
    onClose: () => void;
    onDone: () => void;
}

const METODI = [
    { v: 'contanti', l: 'Contanti' }, { v: 'bonifico', l: 'Bonifico' },
    { v: 'pos', l: 'POS / Carta' }, { v: 'assegno', l: 'Assegno' }, { v: 'altro', l: 'Altro' },
];

// Modifica i dati di un pagamento (anche se già pagato) e corregge gli incassi registrati.
export function ModificaPagamentoModal({ pagamento, categorie, userId, onClose, onDone }: Props) {
    const [descrizione, setDescrizione] = useState(pagamento.descrizione);
    const [importo, setImporto] = useState<number>(Number(pagamento.importo));
    const [scadenza, setScadenza] = useState(String(pagamento.scadenza).slice(0, 10));
    const [categoriaId, setCategoriaId] = useState(pagamento.categoria_id ?? '');
    const [obbligatorio, setObbligatorio] = useState(pagamento.obbligatorio);
    const [incassi, setIncassi] = useState<Incasso[]>([]);
    const [editId, setEditId] = useState<string | null>(null);
    const [editDraft, setEditDraft] = useState<Partial<Incasso>>({});
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadIncassi = useCallback(async () => {
        try {
            const res = await fetch(`/api/pagamenti/incassi?pagamento_id=${pagamento.id}&userId=${userId}`, {
                headers: { 'x-user-id': userId },
            });
            const j = await res.json();
            if (j.success) setIncassi(j.data || []);
        } finally {
            // no-op: corpo in try/finally per il pattern loader (react-hooks set-state-in-effect)
        }
    }, [pagamento.id, userId]);

    useEffect(() => { loadIncassi(); }, [loadIncassi]);

    const salvaDati = async () => {
        setSaving(true); setError(null);
        try {
            const res = await fetch(`/api/pagamenti/${pagamento.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    descrizione: descrizione.trim(), importo: Number(importo), scadenza,
                    categoria_id: categoriaId || null, obbligatorio,
                }),
            });
            const j = await res.json();
            if (!res.ok) { setError(j.error || 'Errore aggiornamento'); return; }
            onDone();
        } catch {
            setError('Errore di rete');
        } finally { setSaving(false); }
    };

    const salvaIncasso = async (id: string) => {
        const res = await fetch(`/api/pagamenti/incassi/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
            body: JSON.stringify(editDraft),
        });
        if (res.ok) { setEditId(null); setEditDraft({}); await loadIncassi(); }
        else { const j = await res.json().catch(() => ({})); alert(j.error || 'Errore'); }
    };

    const eliminaIncasso = async (id: string) => {
        if (!confirm('Stornare questo incasso?')) return;
        const res = await fetch(`/api/pagamenti/incassi/${id}`, { method: 'DELETE', headers: { 'x-user-id': userId } });
        if (res.ok) await loadIncassi();
    };

    return (
        <div className={MODAL_OVERLAY} onClick={onClose}>
            <motion.div
                initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                className={cx(MODAL_CARD, 'max-h-[90vh] overflow-y-auto')}
                style={{ boxShadow: MODAL_SHADOW }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                        <Pencil size={18} /> Modifica pagamento
                    </h3>
                    <button onClick={onClose} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                </div>

                {pagamento.alunni && (
                    <p className="font-maven text-xs text-kidville-muted mb-3">{pagamento.alunni.nome} {pagamento.alunni.cognome}</p>
                )}

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
                                onChange={(e) => setImporto(e.target.value === '' ? 0 : Number(e.target.value))}
                                className={INPUT} />
                        </div>
                        <div>
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">Scadenza</label>
                            <input type="date" value={scadenza} onChange={(e) => setScadenza(e.target.value)}
                                className={INPUT} />
                        </div>
                    </div>
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">Categoria</label>
                        <select value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}
                            className={SELECT}>
                            <option value="">—</option>
                            {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                        </select>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={obbligatorio} onChange={(e) => setObbligatorio(e.target.checked)}
                            className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                        <span className="font-maven text-xs text-kidville-green">Pagamento obbligatorio</span>
                    </label>
                    {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}
                </div>

                {/* Incassi registrati */}
                <div className="mt-5">
                    <h4 className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide mb-2">Incassi registrati</h4>
                    {incassi.length === 0 ? (
                        <p className="font-maven text-xs text-kidville-muted">Nessun incasso registrato.</p>
                    ) : (
                        <div className="space-y-2">
                            {incassi.map((inc) => (
                                <div key={inc.id} className="border border-kidville-line rounded-input p-2">
                                    {editId === inc.id ? (
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <input type="number" step="0.01" defaultValue={inc.importo}
                                                onChange={(e) => setEditDraft((d) => ({ ...d, importo: Number(e.target.value) }))}
                                                className={cx(INLINE_FIELD, 'w-20')} />
                                            <input type="date" defaultValue={String(inc.data_incasso).slice(0, 10)}
                                                onChange={(e) => setEditDraft((d) => ({ ...d, data_incasso: e.target.value }))}
                                                className={INLINE_FIELD} />
                                            <select defaultValue={inc.metodo}
                                                onChange={(e) => setEditDraft((d) => ({ ...d, metodo: e.target.value }))}
                                                className={cx(INLINE_FIELD, 'cursor-pointer')}>
                                                {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                                            </select>
                                            <button onClick={() => salvaIncasso(inc.id)} className="text-kidville-green"><Save size={16} /></button>
                                            <button onClick={() => { setEditId(null); setEditDraft({}); }} className="text-kidville-muted"><X size={16} /></button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center justify-between">
                                            <span className="font-maven text-sm text-kidville-green">
                                                € {Number(inc.importo).toFixed(2)} <span className="text-kidville-muted text-xs">· {String(inc.data_incasso).slice(0, 10)} · {inc.metodo}</span>
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <button onClick={() => { setEditId(inc.id); setEditDraft({}); }} className="text-kidville-muted hover:text-kidville-green"><Pencil size={14} /></button>
                                                <button onClick={() => eliminaIncasso(inc.id)} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={14} /></button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex gap-2 mt-5">
                    <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>
                        Chiudi
                    </button>
                    <button onClick={salvaDati} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1')}>
                        {saving ? 'Salvataggio…' : 'Salva modifiche'}
                    </button>
                </div>
            </motion.div>
        </div>
    );
}
