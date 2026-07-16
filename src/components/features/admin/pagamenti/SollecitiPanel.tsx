'use client';

import { useCallback, useEffect, useState } from 'react';
import { BellRing, RefreshCw, Send, X } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { Badge } from '@/components/ui/Badge';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { STATI_PAGAMENTO } from './stati';

interface Pagamento {
    id: string;
    alunno_id: string;
    descrizione: string;
    importo: number;
    importo_pagato: number;
    stato: string;
    tipo: string;
    scadenza: string;
    ultimo_sollecito_il?: string | null;
    alunni?: { nome?: string; cognome?: string } | null;
}

interface EsitoSollecito {
    pagamento_id: string;
    ok: boolean;
    livello?: number;
    oggetto?: string;
    corpo?: string;
    motivo?: string;
}

interface Props { userId: string; scuolaId: string }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');
const MS_GIORNO = 86_400_000;

/** Vista Solleciti: coda dei morosi con anteprima OBBLIGATORIA prima dell'invio. */
export function SollecitiPanel({ userId, scuolaId }: Props) {
    const [rows, setRows] = useState<Pagamento[]>([]);
    const [loading, setLoading] = useState(true);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [anteprime, setAnteprime] = useState<EsitoSollecito[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [inviati, setInviati] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const oggi = new Date().toISOString().slice(0, 10);

    const load = useCallback(async () => {
        try {
            const r = await fetch(`/api/pagamenti?userId=${userId}&scuola_id=${scuolaId}&solo_aperti=true&scadenza_a=${oggi}`, { headers: hdr(userId) });
            const j = await r.json();
            if (j?.success) {
                const aperti = (j.data as Pagamento[])
                    .filter((p) => p.tipo !== 'padre' && Number(p.importo) - Number(p.importo_pagato || 0) > 0)
                    .sort((a, b) => (a.scadenza || '').localeCompare(b.scadenza || ''));
                setRows(aperti);
            }
        } finally {
            setLoading(false);
        }
    }, [userId, scuolaId, oggi]);

    useEffect(() => { load(); }, [load]);

    const tuttiSelezionati = rows.length > 0 && selected.size === rows.length;
    const toggle = (id: string) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id); else next.add(id);
        setSelected(next);
        setAnteprime(null);
        setInviati(null);
    };
    const toggleTutti = () => {
        setSelected(tuttiSelezionati ? new Set() : new Set(rows.map((r) => r.id)));
        setAnteprime(null);
        setInviati(null);
    };

    const giorniRitardo = (p: Pagamento) =>
        Math.max(0, Math.floor((Date.parse(oggi) - Date.parse(p.scadenza)) / MS_GIORNO));

    const chiama = async (anteprima: boolean) => {
        setBusy(true);
        setError(null);
        try {
            const r = await fetch('/api/pagamenti/solleciti', {
                method: 'POST',
                headers: hdr(userId),
                body: JSON.stringify({ pagamento_ids: [...selected], anteprima }),
            });
            const j = await r.json();
            if (!r.ok || !j.success) { setError(j.error || "Errore nell'operazione"); return; }
            if (anteprima) {
                setAnteprime(j.data as EsitoSollecito[]);
            } else {
                setAnteprime(null);
                setSelected(new Set());
                setInviati((j.data as EsitoSollecito[]).filter((e) => e.ok).length);
                await load();
            }
        } catch {
            setError('Errore di rete');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div>
            <SectionTitle icon={BellRing} title="Solleciti di pagamento"
                sub="Pagamenti aperti oltre scadenza. Seleziona, guarda l'anteprima e conferma: l'email parte solo alla conferma."
                action={
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-pill border-[1.5px] border-kidville-line p-2 text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                        <RefreshCw size={14} />
                    </button>
                } />

            {inviati != null && (
                <p className="mb-3 flex items-center gap-1.5 rounded-xl bg-kidville-success-soft px-3 py-2 font-maven text-sm font-bold text-kidville-success">
                    <SaveCheck size={16} /> {inviati} sollecit{inviati === 1 ? 'o inviato' : 'i inviati'}.
                </p>
            )}
            {error && <p className="mb-3 font-maven text-xs text-kidville-error">{error}</p>}

            {loading ? (
                <p className="py-8 text-center font-maven text-sm text-kidville-muted">Caricamento…</p>
            ) : rows.length === 0 ? (
                <p className="py-8 text-center font-maven text-sm text-kidville-muted">Nessun pagamento scaduto: tutto in regola. 🎉</p>
            ) : (
                <>
                    <label className="mb-2 flex cursor-pointer items-center gap-2">
                        <input type="checkbox" checked={tuttiSelezionati} onChange={toggleTutti} className="h-4 w-4 rounded text-kidville-green" />
                        <span className="font-maven text-xs font-bold text-kidville-green">Seleziona tutti ({rows.length})</span>
                    </label>
                    <div className="space-y-2">
                        {rows.map((p) => {
                            const st = STATI_PAGAMENTO[p.stato] ?? STATI_PAGAMENTO.da_pagare;
                            const residuo = Math.max(0, Number(p.importo) - Number(p.importo_pagato || 0));
                            return (
                                <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3">
                                    <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="h-4 w-4 shrink-0 rounded text-kidville-green" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-maven text-sm font-bold text-kidville-green">
                                            {p.alunni?.nome} {p.alunni?.cognome} · {p.descrizione}
                                        </span>
                                        <span className="block font-maven text-[11px] text-kidville-muted">
                                            Scaduto da {giorniRitardo(p)}gg ({dataIt(p.scadenza)}) · ultimo sollecito: {dataIt(p.ultimo_sollecito_il)}
                                        </span>
                                    </span>
                                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                                        <span className="block font-maven text-sm font-bold text-kidville-error">€ {residuo.toFixed(2)}</span>
                                        <Badge tone={st.tone}>{st.label}</Badge>
                                    </span>
                                </label>
                            );
                        })}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button onClick={() => chiama(true)} disabled={busy || selected.size === 0}
                            className="rounded-pill bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                            {busy && !anteprime ? 'Preparo…' : `Anteprima (${selected.size})`}
                        </button>
                        {anteprime && (
                            <button onClick={() => setAnteprime(null)}
                                className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-kidville-line px-4 py-2 font-maven text-sm font-bold text-kidville-muted transition-colors hover:bg-kidville-cream">
                                <X size={14} /> Annulla
                            </button>
                        )}
                    </div>

                    {anteprime && (
                        <div className="mt-4 space-y-3 rounded-card border-[1.5px] border-kidville-line bg-kidville-cream/40 p-4">
                            <p className="font-barlow text-sm font-black uppercase text-kidville-green">Anteprima — nessuna email è ancora partita</p>
                            {anteprime.map((e) => (
                                <div key={e.pagamento_id} className="rounded-input bg-kidville-white p-3">
                                    {e.ok ? (
                                        <>
                                            <p className="font-maven text-xs font-bold text-kidville-green">Livello {e.livello} · {e.oggetto}</p>
                                            <pre className="mt-1 whitespace-pre-wrap font-maven text-[11px] leading-snug text-kidville-ink">{e.corpo}</pre>
                                        </>
                                    ) : (
                                        <p className="font-maven text-xs text-kidville-warn">Saltato: {e.motivo}</p>
                                    )}
                                </div>
                            ))}
                            <button onClick={() => chiama(false)} disabled={busy || anteprime.every((e) => !e.ok)}
                                className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                                <Send size={14} /> {busy ? 'Invio…' : `Conferma e invia (${anteprime.filter((e) => e.ok).length})`}
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
