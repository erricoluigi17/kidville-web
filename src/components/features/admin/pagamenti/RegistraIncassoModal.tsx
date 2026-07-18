'use client';

import { useRef, useState } from 'react';
import { X, Euro } from 'lucide-react';
import { FatturaButton } from './FatturaButton';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';
import { residuoEffettivo } from '@/lib/pagamenti/aging';
import { formatEuro } from '@/lib/format/valuta';
import { Modal } from '@/components/ui/Modal';
import { MODAL_CARD, MODAL_SHADOW, INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY } from './ui';

export interface PagamentoRow {
    id: string;
    descrizione: string;
    importo: number;
    importo_pagato: number;
    stato: string;
    tipo: string;
    /** Sconto/abbuono già applicato sulla voce (Contabilità v2). */
    sconto?: number;
    alunno_id?: string;
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

interface Pagante { adult_id: string; nome: string; cognome: string; }

interface Props {
    pagamento: PagamentoRow;
    userId: string;
    onClose: () => void;
    onDone: () => void;
}

export function RegistraIncassoModal({ pagamento, userId, onClose, onDone }: Props) {
    // Residuo EFFETTIVO (fonte unica S1): importo − sconto − già incassato, clampato a 0.
    const mancante = residuoEffettivo({
        importo: pagamento.importo,
        importo_pagato: pagamento.importo_pagato,
        sconto: pagamento.sconto,
        stato: pagamento.stato,
    });
    const [importo, setImporto] = useState<number>(mancante);
    const [metodo, setMetodo] = useState('contanti');
    const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
    const [note, setNote] = useState('');
    const [spill, setSpill] = useState(true);
    const [abbuono, setAbbuono] = useState(false);
    const [abbuonoMotivo, setAbbuonoMotivo] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saldato, setSaldato] = useState(pagamento.stato === 'pagato');

    // Dialog di conferma eccedenza → credito famiglia. Il ref sul bottone «Registra»
    // permette il ripristino del focus (WCAG 2.4.3): durante la POST async quel
    // bottone è `disabled`, quindi al capture del Modal activeElement è già <body>.
    const registraBtnRef = useRef<HTMLButtonElement>(null);
    const [eccedenza, setEccedenza] = useState<number | null>(null);
    const [paganti, setPaganti] = useState<Pagante[]>([]);
    const [paganteId, setPaganteId] = useState('');

    const eccedenzaLive = importo - mancante;
    const isRata = !!pagamento.parent_payment_id;
    const isParziale = importo > 0 && importo < mancante;

    const caricaPaganti = async () => {
        if (!pagamento.alunno_id) return;
        try {
            const res = await fetch(`/api/pagamenti/tutori?alunno_id=${pagamento.alunno_id}&userId=${userId}`, {
                headers: { 'x-user-id': userId },
            });
            const j = await res.json();
            const lista: Pagante[] = j.success ? (j.data || []) : [];
            setPaganti(lista);
            if (lista.length > 0) setPaganteId(lista[0].adult_id);
        } catch {
            setPaganti([]);
        }
    };

    const doSubmit = async (opts?: { confermaEccedenza?: boolean }) => {
        if (!importo || importo === 0) { setError('Inserisci un importo'); return; }
        if (abbuono && isParziale && abbuonoMotivo.trim().length < 3) {
            setError('Indica il motivo dell\'abbuono (almeno 3 caratteri)');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const payload: Record<string, unknown> = {
                pagamento_id: pagamento.id,
                importo,
                data_incasso: data,
                metodo,
                note: note || null,
                spill: isRata ? spill : false,
            };
            if (abbuono && isParziale) payload.abbuono = { motivo: abbuonoMotivo.trim() };
            if (opts?.confermaEccedenza && paganteId) {
                payload.conferma_eccedenza = 'credito_famiglia';
                payload.pagante_parent_id = paganteId;
            }
            const res = await fetch('/api/pagamenti/incassi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify(payload),
            });
            const json = await res.json();
            // Sovraincasso su voce non-rata: apri la conferma esplicita «credito famiglia».
            if (res.status === 409 && json.eccedenza != null) {
                await caricaPaganti();
                setEccedenza(Number(json.eccedenza));
                return;
            }
            if (!res.ok) { setError(json.error || 'Errore nella registrazione'); return; }
            setEccedenza(null);
            // Se l'incasso salda il pagamento, resta nel popup per inviare la fattura
            if (importo >= mancante || (abbuono && isParziale)) setSaldato(true);
            else onDone();
        } catch {
            setError('Errore di rete');
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            <Modal
                open
                onClose={onClose}
                title="Registra incasso"
                labelledBy="registra-incasso-title"
                className={MODAL_CARD}
                style={{ boxShadow: MODAL_SHADOW }}
            >
                <div className="flex items-center justify-between mb-4">
                    <h3 id="registra-incasso-title" className="font-barlow font-black text-lg text-kidville-green uppercase flex items-center gap-2">
                        <Euro size={18} /> Registra incasso
                    </h3>
                    <button onClick={onClose} aria-label="Chiudi" className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
                </div>

                <div className="bg-kidville-cream/60 rounded-card p-3 mb-4">
                    <p className="font-maven text-sm text-kidville-green font-bold">{pagamento.descrizione}</p>
                    <p className="font-maven text-xs text-kidville-sub">
                        {pagamento.alunni?.nome} {pagamento.alunni?.cognome}
                    </p>
                    <div className="flex justify-between mt-2 font-maven text-xs">
                        <span className="text-kidville-sub">Totale {formatEuro(pagamento.importo)}</span>
                        <span className="text-kidville-sub">Già incassato {formatEuro(pagamento.importo_pagato)}</span>
                        <span className="text-kidville-green font-bold">Resta {formatEuro(mancante)}</span>
                    </div>
                    {Number(pagamento.sconto) > 0 && (
                        <p className="font-maven text-[11px] text-kidville-sub mt-1">Sconto applicato {formatEuro(pagamento.sconto)}</p>
                    )}
                </div>

                <div className={`space-y-3 ${saldato ? 'hidden' : ''}`}>
                    <div>
                        <label htmlFor="inc-importo" className="font-maven text-xs text-kidville-sub mb-1 block">Importo incassato (€)</label>
                        <input
                            id="inc-importo"
                            type="number" min={0} step="0.01" value={importo || ''}
                            onChange={(e) => setImporto(e.target.value === '' ? 0 : Number(e.target.value))}
                            className={INPUT}
                        />
                        {isParziale && !abbuono && (
                            <p className="font-maven text-[11px] text-kidville-warn-strong mt-1">Pagamento parziale: resterà {formatEuro(mancante - importo)}.</p>
                        )}
                        {eccedenzaLive > 0 && (
                            <p className="font-maven text-[11px] text-kidville-warn-strong mt-1">
                                Eccedenza {formatEuro(eccedenzaLive)}{isRata && spill ? ' → riportata sulla rata successiva.' : ' → richiederà conferma come credito famiglia.'}
                            </p>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label htmlFor="inc-metodo" className="font-maven text-xs text-kidville-sub mb-1 block">Metodo</label>
                            <select id="inc-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)}
                                className={SELECT}>
                                {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="inc-data" className="font-maven text-xs text-kidville-sub mb-1 block">Data</label>
                            <input id="inc-data" type="date" value={data} onChange={(e) => setData(e.target.value)}
                                className={INPUT} />
                        </div>
                    </div>

                    {metodo === 'contanti' && (
                        <p className="rounded-xl bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] leading-snug text-kidville-warn-strong">
                            Contanti: pagamento non tracciabile. La quota non sarà detraibile nel 730 (art. 15 TUIR)
                            e resterà esclusa dalla comunicazione delle spese scolastiche all&apos;AdE.
                        </p>
                    )}

                    <div>
                        <label htmlFor="inc-note" className="font-maven text-xs text-kidville-sub mb-1 block">Note (facoltativo)</label>
                        <input id="inc-note" type="text" value={note} onChange={(e) => setNote(e.target.value)}
                            className={INPUT} />
                    </div>

                    {isRata && eccedenzaLive > 0 && (
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={spill} onChange={(e) => setSpill(e.target.checked)}
                                className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                            <span className="font-maven text-xs text-kidville-green">Riporta l&apos;eccedenza sulla rata successiva</span>
                        </label>
                    )}

                    {isParziale && (
                        <div className="space-y-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={abbuono} onChange={(e) => setAbbuono(e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                                <span className="font-maven text-xs text-kidville-green">Salda con abbuono della differenza ({formatEuro(mancante - importo)})</span>
                            </label>
                            {abbuono && (
                                <input type="text" value={abbuonoMotivo} onChange={(e) => setAbbuonoMotivo(e.target.value)}
                                    placeholder="Motivo dell'abbuono (obbligatorio)" aria-label="Motivo dell'abbuono"
                                    className={INPUT} />
                            )}
                        </div>
                    )}

                    {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}
                </div>

                {saldato ? (
                    <div className="mt-5">
                        <div role="status" className="flex items-center justify-between gap-2 bg-kidville-success-soft rounded-card px-3 py-2.5 mb-3">
                            <span className="flex items-center gap-1.5 font-maven text-sm text-kidville-success-strong font-bold">
                                <SaveCheck size={17} /> Pagamento saldato
                            </span>
                            <FatturaButton pagamentoId={pagamento.id} userId={userId} fatturaStato={pagamento.fattura_stato} descrizione={pagamento.descrizione} />
                        </div>
                        <button onClick={onDone} className={cx(BTN_PRIMARY, 'w-full')}>
                            Chiudi
                        </button>
                    </div>
                ) : (
                    <div className="flex gap-2 mt-5">
                        <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>
                            Annulla
                        </button>
                        <button ref={registraBtnRef} onClick={() => doSubmit()} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1')}>
                            {saving ? 'Salvataggio…' : `Registra ${formatEuro(importo || 0)}`}
                        </button>
                    </div>
                )}
            </Modal>

            {/* Conferma esplicita dell'eccedenza → credito famiglia */}
            <Modal
                open={eccedenza != null}
                onClose={() => setEccedenza(null)}
                title="Eccedenza da gestire"
                labelledBy="incasso-ecc-title"
                className={cx(MODAL_CARD, 'max-w-sm')}
                style={{ boxShadow: MODAL_SHADOW }}
                returnFocusRef={registraBtnRef}
            >
                <h4 id="incasso-ecc-title" className="font-barlow font-black text-base text-kidville-green uppercase mb-2">Eccedenza da gestire</h4>
                <p className="font-maven text-sm text-kidville-ink mb-3">
                    Stai incassando {formatEuro(eccedenza)} oltre il residuo di questa voce.
                    Vuoi registrarli come <strong>credito famiglia</strong> riutilizzabile?
                </p>
                <label htmlFor="inc-pagante" className="font-maven text-xs text-kidville-sub mb-1 block">Intesta il credito a</label>
                {paganti.length > 0 ? (
                    <select id="inc-pagante" value={paganteId} onChange={(e) => setPaganteId(e.target.value)} className={cx(SELECT, 'mb-3')}>
                        {paganti.map((p) => (
                            <option key={p.adult_id} value={p.adult_id}>{p.nome} {p.cognome}</option>
                        ))}
                    </select>
                ) : (
                    <p role="alert" className="font-maven text-xs text-kidville-error-strong mb-3">Nessun pagante disponibile per questo alunno.</p>
                )}
                <div className="flex gap-2">
                    <button onClick={() => setEccedenza(null)} className={cx(BTN_SECONDARY, 'flex-1')}>Annulla</button>
                    <button
                        onClick={() => { setEccedenza(null); doSubmit({ confermaEccedenza: true }); }}
                        disabled={saving || !paganteId}
                        className={cx(BTN_PRIMARY, 'flex-1')}
                    >
                        Conferma credito
                    </button>
                </div>
            </Modal>
        </>
    );
}
