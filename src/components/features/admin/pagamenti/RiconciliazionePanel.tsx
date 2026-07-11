'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Landmark, RefreshCw, Upload, X } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { Badge } from '@/components/ui/Badge';
import { SaveCheck } from '@/components/ui/SaveConfirmation';

interface Suggerimento { pagamento_id: string; score: number; motivi: string[]; label?: string | null }
interface Movimento {
    id: string;
    data_operazione: string;
    importo: number;
    causale?: string | null;
    controparte?: string | null;
    stato: 'da_abbinare' | 'suggerito' | 'confermato' | 'ignorato';
    suggerimenti?: Suggerimento[] | null;
}
interface PagamentoAperto {
    id: string;
    descrizione: string;
    importo: number;
    importo_pagato: number;
    tipo: string;
    alunni?: { nome?: string; cognome?: string } | null;
}
interface EsitoImport { nuovi: number; duplicati: number; scartate: number; suggeriti: number; da_abbinare: number }

interface Props { userId: string; scuolaId: string }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');

/** Vista Riconciliazione: import CSV banca → abbinamento con conferma esplicita. */
export function RiconciliazionePanel({ userId, scuolaId }: Props) {
    const [movimenti, setMovimenti] = useState<Movimento[]>([]);
    const [aperti, setAperti] = useState<PagamentoAperto[]>([]);
    const [disponibile, setDisponibile] = useState(true);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [esito, setEsito] = useState<EsitoImport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [manuale, setManuale] = useState<Record<string, string>>({});

    const load = useCallback(async () => {
        try {
            const [movRes, apRes] = await Promise.all([
                fetch(`/api/pagamenti/riconciliazione?userId=${userId}`, { headers: hdr(userId) }).then((r) => r.json()),
                fetch(`/api/pagamenti?userId=${userId}&scuola_id=${scuolaId}&solo_aperti=true`, { headers: hdr(userId) }).then((r) => r.json()),
            ]);
            if (movRes?.success) {
                setMovimenti(movRes.data || []);
                setDisponibile(movRes.disponibile !== false);
            }
            if (apRes?.success) {
                setAperti((apRes.data as PagamentoAperto[]).filter((p) => p.tipo !== 'padre'));
            }
        } finally {
            setLoading(false);
        }
    }, [userId, scuolaId]);

    useEffect(() => { load(); }, [load]);

    const upload = async (file: File) => {
        setBusy(true);
        setError(null);
        setEsito(null);
        try {
            const contenuto = await file.text();
            const r = await fetch('/api/pagamenti/riconciliazione', {
                method: 'POST',
                headers: hdr(userId),
                body: JSON.stringify({ filename: file.name, contenuto, scuola_id: scuolaId }),
            });
            const j = await r.json();
            if (!r.ok || !j.success) { setError(j.error || "Errore nell'import"); return; }
            setEsito(j.data as EsitoImport);
            await load();
        } catch {
            setError('Errore di lettura del file');
        } finally {
            setBusy(false);
        }
    };

    const azione = async (id: string, az: 'conferma' | 'ignora' | 'riapri', pagamentoId?: string) => {
        setBusy(true);
        setError(null);
        try {
            const r = await fetch(`/api/pagamenti/riconciliazione/${id}`, {
                method: 'PATCH',
                headers: hdr(userId),
                body: JSON.stringify({ azione: az, pagamento_id: pagamentoId || undefined }),
            });
            const j = await r.json();
            if (!r.ok || !j.success) { setError(j.error || "Errore nell'operazione"); return; }
            await load();
        } catch {
            setError('Errore di rete');
        } finally {
            setBusy(false);
        }
    };

    const daLavorare = movimenti.filter((m) => m.stato === 'suggerito' || m.stato === 'da_abbinare');
    const ignorati = movimenti.filter((m) => m.stato === 'ignorato');
    const confermati = movimenti.filter((m) => m.stato === 'confermato');
    const labelAperto = (p: PagamentoAperto) =>
        `${[p.alunni?.nome, p.alunni?.cognome].filter(Boolean).join(' ') || '—'} · ${p.descrizione} (residuo € ${(Number(p.importo) - Number(p.importo_pagato || 0)).toFixed(2)})`;

    return (
        <div>
            <SectionTitle icon={Landmark} title="Riconciliazione bancaria"
                sub="Importa l'estratto conto (CSV): i bonifici vengono abbinati agli addebiti aperti, la conferma è sempre tua."
                action={
                    <button onClick={() => { setLoading(true); load(); }}
                        className="rounded-full border-2 border-kidville-line p-2 text-kidville-muted hover:text-kidville-green">
                        <RefreshCw size={14} />
                    </button>
                } />

            <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-white ${busy ? 'opacity-50' : 'hover:opacity-90'}`}>
                <Upload size={14} /> {busy ? 'Elaboro…' : 'Importa CSV estratto conto'}
                <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
            </label>
            <p className="mt-1 font-maven text-[11px] text-kidville-muted">
                Colonne riconosciute automaticamente (Data/Valuta · Importo/Entrate/Accrediti · Causale/Descrizione · Ordinante). Solo gli accrediti. Il file non viene salvato.
            </p>

            {esito && (
                <p className="mt-3 flex items-center gap-1.5 rounded-xl bg-kidville-success-soft px-3 py-2 font-maven text-sm text-kidville-success">
                    <SaveCheck size={16} />
                    {esito.nuovi} nuovi movimenti ({esito.suggeriti} con suggerimento) · {esito.duplicati} già visti · {esito.scartate} righe scartate
                </p>
            )}
            {error && <p className="mt-3 font-maven text-xs text-kidville-error">{error}</p>}

            {loading ? (
                <p className="py-8 text-center font-maven text-sm text-kidville-muted">Caricamento…</p>
            ) : !disponibile ? (
                <p className="py-8 text-center font-maven text-sm text-kidville-muted">
                    Riconciliazione non ancora attiva su questo database (migrazione da applicare).
                </p>
            ) : daLavorare.length === 0 ? (
                <p className="py-8 text-center font-maven text-sm text-kidville-muted">
                    Nessun movimento da abbinare.{confermati.length > 0 ? ` ${confermati.length} confermati.` : ''}{ignorati.length > 0 ? ` ${ignorati.length} ignorati.` : ''}
                </p>
            ) : (
                <div className="mt-4 space-y-2">
                    {daLavorare.map((m) => {
                        const best = m.suggerimenti?.[0];
                        return (
                            <div key={m.id} className="rounded-xl border-2 border-kidville-line bg-kidville-white p-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="min-w-0">
                                        <span className="block font-maven text-sm font-bold text-kidville-green">
                                            € {Number(m.importo).toFixed(2)} · {dataIt(m.data_operazione)}
                                        </span>
                                        <span className="block truncate font-maven text-[11px] text-kidville-muted" title={m.causale ?? ''}>
                                            {m.causale || '—'}{m.controparte ? ` · ${m.controparte}` : ''}
                                        </span>
                                    </span>
                                    <Badge tone={m.stato === 'suggerito' ? 'success' : 'warn'}>
                                        {m.stato === 'suggerito' ? 'Suggerito' : 'Da abbinare'}
                                    </Badge>
                                </div>

                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                    {m.stato === 'suggerito' && best ? (
                                        <>
                                            <span className="font-maven text-xs text-kidville-ink">→ {best.label ?? best.pagamento_id}</span>
                                            <button onClick={() => azione(m.id, 'conferma')} disabled={busy}
                                                className="inline-flex items-center gap-1 rounded-full bg-kidville-green px-3 py-1.5 font-maven text-xs font-bold text-white disabled:opacity-50">
                                                <Check size={13} /> Conferma incasso
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <select value={manuale[m.id] ?? ''} onChange={(e) => setManuale({ ...manuale, [m.id]: e.target.value })}
                                                className="min-w-[240px] flex-1 rounded-full border-2 border-kidville-line bg-white px-3 py-1.5 font-maven text-xs text-kidville-green focus:border-kidville-green focus:outline-none">
                                                <option value="">— Scegli il pagamento da abbinare —</option>
                                                {aperti.map((p) => <option key={p.id} value={p.id}>{labelAperto(p)}</option>)}
                                            </select>
                                            <button onClick={() => azione(m.id, 'conferma', manuale[m.id])} disabled={busy || !manuale[m.id]}
                                                className="inline-flex items-center gap-1 rounded-full bg-kidville-green px-3 py-1.5 font-maven text-xs font-bold text-white disabled:opacity-50">
                                                <Check size={13} /> Conferma
                                            </button>
                                        </>
                                    )}
                                    <button onClick={() => azione(m.id, 'ignora')} disabled={busy}
                                        className="inline-flex items-center gap-1 rounded-full border-2 border-kidville-line px-3 py-1 font-maven text-xs font-bold text-kidville-muted hover:border-kidville-green hover:text-kidville-green disabled:opacity-50">
                                        <X size={13} /> Ignora
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {ignorati.length > 0 && (
                <details className="mt-4">
                    <summary className="cursor-pointer font-maven text-xs font-bold text-kidville-muted">Ignorati ({ignorati.length})</summary>
                    <div className="mt-2 space-y-1">
                        {ignorati.map((m) => (
                            <div key={m.id} className="flex items-center justify-between rounded-lg bg-kidville-cream/40 px-2.5 py-1.5 font-maven text-xs">
                                <span className="min-w-0 truncate text-kidville-muted">€ {Number(m.importo).toFixed(2)} · {dataIt(m.data_operazione)} · {m.causale || '—'}</span>
                                <button onClick={() => azione(m.id, 'riapri')} disabled={busy}
                                    className="shrink-0 font-bold text-kidville-green hover:underline">Riapri</button>
                            </div>
                        ))}
                    </div>
                </details>
            )}
        </div>
    );
}
