'use client';

import { useState } from 'react';
import { Ban, RotateCcw, Loader2, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';

// Toggle sospensione account moroso (DL-021 · Contabilità v2) — riservato alla
// Direzione (gate server-side). Granularità FAMIGLIA: prima di sospendere mostra i
// figli che verrebbero coinvolti e fa scegliere la causa (morosità / altro).
interface Figlio { id: string; nome: string | null; cognome: string | null; sospeso: boolean }

export function SospensioneToggle({
    alunnoId,
    userId,
    sospeso,
    onChange,
}: {
    alunnoId: string;
    userId: string;
    sospeso: boolean;
    onChange?: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState(false);
    const [figli, setFigli] = useState<Figlio[]>([]);
    const [parentAccountId, setParentAccountId] = useState<string | null>(null);
    const [causa, setCausa] = useState<'morosita' | 'altro'>('morosita');
    const [motivo, setMotivo] = useState('');
    const [caricando, setCaricando] = useState(false);

    const headers = { 'Content-Type': 'application/json', 'x-user-id': userId };

    const apriModaleSospensione = async () => {
        setOpen(true);
        setCaricando(true);
        setCausa('morosita');
        setMotivo('');
        try {
            const res = await fetch(`/api/admin/pagamenti/sospensione?alunno_id=${alunnoId}`, { headers: { 'x-user-id': userId } });
            if (res.status === 403) { alert('Azione riservata alla Direzione.'); setOpen(false); return; }
            const j = await res.json();
            if (j?.success) {
                setFigli((j.data.figli as Figlio[]) ?? []);
                setParentAccountId((j.data.parentAccountId as string | null) ?? null);
            }
        } catch {
            // se l'anteprima non carica, si può comunque sospendere il singolo alunno
            setFigli([]);
            setParentAccountId(null);
        } finally {
            setCaricando(false);
        }
    };

    const confermaSospensione = async () => {
        setBusy(true);
        try {
            // Con il parent account si sospende TUTTA la famiglia; altrimenti il solo alunno.
            const body = parentAccountId
                ? { parent_account_id: parentAccountId, sospeso: true, causa, motivo }
                : { alunno_id: alunnoId, sospeso: true, causa, motivo };
            const res = await fetch('/api/admin/pagamenti/sospensione', { method: 'POST', headers, body: JSON.stringify(body) });
            if (res.status === 403) { alert('Azione riservata alla Direzione.'); return; }
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                alert(j.error || 'Errore durante la sospensione.');
                return;
            }
            setOpen(false);
            onChange?.();
        } finally {
            setBusy(false);
        }
    };

    const riattiva = async () => {
        if (!window.confirm('Riattivare l’account dell’alunno?')) return;
        setBusy(true);
        try {
            const res = await fetch('/api/admin/pagamenti/sospensione', {
                method: 'POST', headers, body: JSON.stringify({ alunno_id: alunnoId, sospeso: false }),
            });
            if (res.status === 403) { alert('Azione riservata alla Direzione.'); return; }
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                alert(j.error || 'Errore durante la riattivazione.');
                return;
            }
            onChange?.();
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button
                onClick={() => (sospeso ? void riattiva() : void apriModaleSospensione())}
                disabled={busy}
                title={sospeso ? 'Riattiva account' : 'Sospendi per morosità'}
                className={`${sospeso ? 'text-kidville-error hover:text-kidville-success' : 'text-kidville-muted hover:text-kidville-error'} disabled:opacity-50`}
            >
                {busy && !open ? <Loader2 size={15} className="animate-spin" /> : sospeso ? <RotateCcw size={15} /> : <Ban size={15} />}
            </button>

            <Modal
                open={open}
                onClose={() => { if (!busy) setOpen(false); }}
                title="Sospensione morosità"
                labelledBy="sosp-title"
                className="w-full max-w-md rounded-[22px] bg-kidville-white p-5 shadow-xl"
            >
                <div className="mb-3 flex items-center justify-between">
                    <h2 id="sosp-title" className="font-barlow text-lg font-black uppercase text-kidville-error-strong">Sospensione morosità</h2>
                    <button onClick={() => { if (!busy) setOpen(false); }} className="text-kidville-muted hover:text-kidville-error" aria-label="Chiudi">
                        <X size={18} />
                    </button>
                </div>

                <p className="mb-2 font-maven text-[12.5px] text-kidville-sub">
                    La sospensione vale per l’intera famiglia. Verranno coinvolti:
                </p>
                <div className="mb-4 rounded-[14px] bg-kidville-cream px-3 py-2">
                    {caricando ? (
                        <div className="flex items-center gap-2 py-1 font-maven text-[12px] text-kidville-sub">
                            <Loader2 size={13} className="animate-spin" /> Caricamento figli…
                        </div>
                    ) : figli.length > 0 ? (
                        <ul className="space-y-1">
                            {figli.map((f) => (
                                <li key={f.id} className="flex items-center justify-between font-maven text-[13px] text-kidville-green">
                                    <span>{[f.nome, f.cognome].filter(Boolean).join(' ') || 'Alunno'}</span>
                                    {f.sospeso && <span className="font-barlow text-[10px] font-bold uppercase text-kidville-error-strong">già sospeso</span>}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="py-1 font-maven text-[12px] text-kidville-sub">Solo questo alunno (nessun altro figlio collegato).</p>
                    )}
                </div>

                <span id="sosp-causa-label" className="mb-1 block font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-green">Causa</span>
                <div role="group" aria-labelledby="sosp-causa-label" className="mb-4 flex gap-2">
                    {(['morosita', 'altro'] as const).map((c) => (
                        <button
                            key={c}
                            type="button"
                            onClick={() => setCausa(c)}
                            aria-pressed={causa === c}
                            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 font-maven text-[13px] font-semibold ${causa === c ? 'bg-kidville-green text-kidville-white' : 'bg-kidville-cream text-kidville-green'}`}
                        >
                            <span aria-hidden="true">{causa === c ? '◉' : '○'}</span>
                            {c === 'morosita' ? 'Morosità (revoca automatica)' : 'Altro (revoca manuale)'}
                        </button>
                    ))}
                </div>

                <label htmlFor="sosp-motivo" className="mb-1 block font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-green">Motivo</label>
                <input
                    id="sosp-motivo"
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="es. 3 rette scadute non saldate"
                    className="mb-4 w-full rounded-[12px] border border-kidville-cream bg-kidville-white px-3 py-2 font-maven text-[13px] text-kidville-green outline-none focus:border-kidville-green"
                />

                <div className="flex justify-end gap-2">
                    <button onClick={() => setOpen(false)} disabled={busy} className="rounded-[12px] px-4 py-2 font-maven text-[13px] font-semibold text-kidville-sub disabled:opacity-50">
                        Annulla
                    </button>
                    <button onClick={() => void confermaSospensione()} disabled={busy || caricando} className="flex items-center gap-2 rounded-[12px] bg-kidville-error px-4 py-2 font-maven text-[13px] font-semibold text-kidville-white disabled:opacity-50">
                        {busy && <Loader2 size={13} className="animate-spin" />} Sospendi la famiglia
                    </button>
                </div>
            </Modal>
        </>
    );
}
