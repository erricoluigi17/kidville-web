'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { X, Pencil, Trash2, Save, BadgePercent } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { Modal } from '@/components/ui/Modal';
import { MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY } from './ui';

// Campo inline compatto per la correzione di un incasso già registrato.
const INLINE_FIELD = 'rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

interface Categoria { id: string; nome: string }
interface Incasso { id: string; importo: number; data_incasso: string; metodo: string; note?: string | null }
interface PagamentoBase {
    id: string; descrizione: string; importo: number; scadenza: string;
    categoria_id?: string | null; obbligatorio: boolean; stato: string;
    importo_pagato?: number;
    sconto?: number;
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
    const t = useTranslations('adminContabilita');
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

    // Sconto/abbuono sulla singola voce (via la route dedicata /sconto).
    const [sconto, setSconto] = useState<number>(Number(pagamento.sconto ?? 0));
    const [scontoMotivo, setScontoMotivo] = useState('');
    const [scontoMsg, setScontoMsg] = useState<string | null>(null);
    const [savingSconto, setSavingSconto] = useState(false);

    // Somma incassata dal ledger (per le validazioni speculari lato server).
    const giaIncassato = incassi.reduce((s, i) => s + Number(i.importo), 0);

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
        // Validazioni speculari a quelle del server (finding #3):
        if (importo < 0) { setError(t('modifErrImportoNeg')); return; }
        if (importo - sconto < giaIncassato - 0.005) {
            setError(t('modifErrImportoInferiore'));
            return;
        }
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
            if (!res.ok) { setError(j.error || t('modifErrAggiornamento')); return; }
            onDone();
        } catch {
            setError(t('modifErrRete'));
        } finally { setSaving(false); }
    };

    const applicaSconto = async () => {
        if (sconto < 0) { setScontoMsg(t('modifScontoNeg')); return; }
        if (sconto > importo + 0.005) { setScontoMsg(t('modifScontoSupera')); return; }
        if (importo - sconto < giaIncassato - 0.005) { setScontoMsg(t('modifScontoTroppoAlto')); return; }
        if (scontoMotivo.trim().length < 3) { setScontoMsg(t('modifScontoMotivo')); return; }
        setSavingSconto(true); setScontoMsg(null);
        try {
            const res = await fetch(`/api/pagamenti/${pagamento.id}/sconto`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ sconto: Number(sconto), sconto_motivo: scontoMotivo.trim() }),
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) { setScontoMsg(j.error || t('modifScontoErrore')); return; }
            setScontoMsg(t('modifScontoApplicato'));
            onDone();
        } catch {
            setScontoMsg(t('modifErrRete'));
        } finally { setSavingSconto(false); }
    };

    const salvaIncasso = async (id: string) => {
        const res = await fetch(`/api/pagamenti/incassi/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
            body: JSON.stringify(editDraft),
        });
        if (res.ok) { setEditId(null); setEditDraft({}); await loadIncassi(); }
        else { const j = await res.json().catch(() => ({})); alert(j.error || t('modifErrore')); }
    };

    // Storno TRACCIATO: il motivo è obbligatorio (niente più cancellazione secca).
    const stornaIncasso = async (id: string) => {
        const motivo = window.prompt(t('modifStornoPrompt'))?.trim();
        if (!motivo) return;
        if (motivo.length < 3) { alert(t('modifStornoMinCaratteri')); return; }
        const res = await fetch('/api/pagamenti/incassi/storno', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
            body: JSON.stringify({ incasso_id: id, motivo }),
        });
        if (res.ok) await loadIncassi();
        else { const j = await res.json().catch(() => ({})); alert(j.error || t('modifStornoErrore')); }
    };

    return (
        <Modal
            open
            onClose={onClose}
            title={t('modifTitolo')}
            labelledBy="modifica-pagamento-title"
            className={cx(MODAL_CARD, 'max-h-[90vh] overflow-y-auto')}
            style={{ boxShadow: MODAL_SHADOW }}
        >
            <div className="flex items-center justify-between mb-4">
                <h3 id="modifica-pagamento-title" className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                    <Pencil size={18} /> {t('modifTitolo')}
                </h3>
                <button onClick={onClose} aria-label={t('modifChiudi')} className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
            </div>

            {pagamento.alunni && (
                <p className="font-maven text-xs text-kidville-sub mb-3">{pagamento.alunni.nome} {pagamento.alunni.cognome}</p>
            )}

            <div className="space-y-3">
                <div>
                    <label htmlFor="mod-descrizione" className="font-maven text-xs text-kidville-sub mb-1 block">{t('modifDescrizione')}</label>
                    <input id="mod-descrizione" type="text" value={descrizione} onChange={(e) => setDescrizione(e.target.value)}
                        className={INPUT} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label htmlFor="mod-importo" className="font-maven text-xs text-kidville-sub mb-1 block">{t('modifImporto')}</label>
                        <input id="mod-importo" type="number" min={0} step="0.01" value={importo || ''}
                            onChange={(e) => setImporto(e.target.value === '' ? 0 : Number(e.target.value))}
                            className={INPUT} />
                    </div>
                    <div>
                        <label htmlFor="mod-scadenza" className="font-maven text-xs text-kidville-sub mb-1 block">{t('modifScadenza')}</label>
                        <input id="mod-scadenza" type="date" value={scadenza} onChange={(e) => setScadenza(e.target.value)}
                            className={INPUT} />
                    </div>
                </div>
                <div>
                    <label htmlFor="mod-categoria" className="font-maven text-xs text-kidville-sub mb-1 block">{t('modifCategoria')}</label>
                    <select id="mod-categoria" value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}
                        className={SELECT}>
                        <option value="">—</option>
                        {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                    </select>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={obbligatorio} onChange={(e) => setObbligatorio(e.target.checked)}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                    <span className="font-maven text-xs text-kidville-green">{t('modifObbligatorio')}</span>
                </label>
                {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}
            </div>

            {/* Sconto / abbuono sulla voce */}
            <div className="mt-5 rounded-card bg-kidville-cream/50 p-3">
                <h4 className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide mb-2 flex items-center gap-1.5">
                    <BadgePercent size={14} /> {t('modifScontoTitolo')}
                </h4>
                <div className="grid grid-cols-[100px_1fr] gap-2 items-end">
                    <div>
                        <label htmlFor="mod-sconto" className="font-maven text-[11px] text-kidville-sub mb-1 block">{t('modifScontoEuro')}</label>
                        <input id="mod-sconto" type="number" min={0} step="0.01" value={sconto || ''}
                            onChange={(e) => setSconto(e.target.value === '' ? 0 : Number(e.target.value))}
                            className={INPUT} />
                    </div>
                    <div>
                        <label htmlFor="mod-sconto-motivo" className="font-maven text-[11px] text-kidville-sub mb-1 block">{t('modifMotivo')}</label>
                        <input id="mod-sconto-motivo" type="text" value={scontoMotivo} onChange={(e) => setScontoMotivo(e.target.value)}
                            placeholder={t('modifScontoPlaceholder')} className={INPUT} />
                    </div>
                </div>
                {scontoMsg && <p role="status" className="font-maven text-[11px] text-kidville-sub mt-2">{scontoMsg}</p>}
                <button onClick={applicaSconto} disabled={savingSconto} className={cx(BTN_SECONDARY, 'mt-2 w-full')}>
                    {savingSconto ? t('modifApplicando') : t('modifApplicaSconto')}
                </button>
            </div>

            {/* Incassi registrati */}
            <div className="mt-5">
                <h4 className="font-barlow font-bold text-xs text-kidville-green uppercase tracking-wide mb-2">{t('modifIncassiRegistrati')}</h4>
                {incassi.length === 0 ? (
                    <p className="font-maven text-xs text-kidville-sub">{t('modifNessunIncasso')}</p>
                ) : (
                    <div className="space-y-2">
                        {incassi.map((inc) => (
                            <div key={inc.id} className="border border-kidville-line rounded-input p-2">
                                {editId === inc.id ? (
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <input type="number" step="0.01" defaultValue={inc.importo} aria-label={t('modifAriaImportoIncasso')}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, importo: Number(e.target.value) }))}
                                            className={cx(INLINE_FIELD, 'w-20')} />
                                        <input type="date" defaultValue={String(inc.data_incasso).slice(0, 10)} aria-label={t('modifAriaDataIncasso')}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, data_incasso: e.target.value }))}
                                            className={INLINE_FIELD} />
                                        <select defaultValue={inc.metodo} aria-label={t('modifAriaMetodoIncasso')}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, metodo: e.target.value }))}
                                            className={cx(INLINE_FIELD, 'cursor-pointer')}>
                                            {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                                        </select>
                                        <button onClick={() => salvaIncasso(inc.id)} aria-label={t('modifAriaSalvaIncasso')} className="text-kidville-green"><Save size={16} /></button>
                                        <button onClick={() => { setEditId(null); setEditDraft({}); }} aria-label={t('modifAriaAnnullaModifica')} className="text-kidville-muted"><X size={16} /></button>
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-between">
                                        <span className="font-maven text-sm text-kidville-green">
                                            {formatEuro(inc.importo)} <span className="text-kidville-sub text-xs">· {String(inc.data_incasso).slice(0, 10)} · {inc.metodo}</span>
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => { setEditId(inc.id); setEditDraft({}); }} aria-label={t('modifAriaModificaIncasso')} className="text-kidville-muted hover:text-kidville-green"><Pencil size={14} /></button>
                                            <button onClick={() => stornaIncasso(inc.id)} title={t('modifTitleStorna')} aria-label={t('modifAriaStornaIncasso')} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={14} /></button>
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
                    {t('modifChiudi')}
                </button>
                <button onClick={salvaDati} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1')}>
                    {saving ? t('modifSalvataggio') : t('modifSalvaModifiche')}
                </button>
            </div>
        </Modal>
    );
}
