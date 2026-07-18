'use client';

// ─── Vista «Incasso unico» (Contabilità v2 S4) ────────────────────────────────
// Registra UN pagamento di famiglia (un bonifico/POS) che salda più voci di più
// figli e ricarica la mensa, con quadratura live e — solo su conferma esplicita —
// eccedenza a credito famiglia. Wizard a 3 passi:
//   (a) pagante  → ricerca tutori, GET /api/pagamenti/famiglia
//   (b) importi  → voci per figlio (checkbox + importo) + proposta automatica +
//                  ricariche mensa (euro + ticket) + quadratura live
//   (c) conferma → dialog eccedenza→credito (mai silenzioso); post-salvataggio
//                  ricevuta famiglia PDF o «dividi in fatture»
// In fondo: registro transazioni con annullo (motivo obbligatorio) e ristampa.

import { useCallback, useEffect, useState } from 'react';
import { Coins, Search, Wand2, X, RotateCcw, FileText, UtensilsCrossed, ArrowLeft, Check, Printer } from 'lucide-react';
import { SectionTitle } from '@/components/ui/cockpit';
import { Modal } from '@/components/ui/Modal';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { INPUT, SELECT, BTN_PRIMARY, BTN_SECONDARY, MODAL_CARD, MODAL_SHADOW } from './ui';
import { FatturaButton } from './FatturaButton';
import { proponiAllocazione, round2 } from '@/lib/pagamenti/transazioni-quadratura';

interface Props { userId: string; scuolaId: string }

interface ParentLite { id: string; first_name?: string | null; last_name?: string | null }
interface Figlio { id: string; nome: string | null; cognome: string | null; saldo_ticket: number }
interface Voce {
    id: string; alunno_id: string; descrizione?: string | null;
    importo: number; importo_pagato: number; sconto?: number;
    scadenza?: string | null; stato_effettivo?: string; residuo: number;
}
interface Famiglia { parent: { id: string; nome: string }; figli: Figlio[]; voci: Voce[]; credito: number }
interface TxRow {
    id: string; pagante_parent_id: string; importo_totale: number; metodo: string;
    riferimento?: string | null; data_valuta?: string | null; note?: string | null;
    annullata_il?: string | null; creato_il?: string | null;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const dataIt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('it-IT') : '—');
const nomeFiglio = (f?: { nome?: string | null; cognome?: string | null } | null) =>
    `${f?.nome ?? ''} ${f?.cognome ?? ''}`.trim() || 'Alunno';

const METODI = [
    { v: 'bonifico', l: 'Bonifico' },
    { v: 'pos', l: 'POS / Carta' },
    { v: 'contanti', l: 'Contanti' },
    { v: 'assegno', l: 'Assegno' },
    { v: 'altro', l: 'Altro' },
];

type Ricarica = { euro: string; ticket: string };

export function TransazioniPanel({ userId, scuolaId }: Props) {
    const [step, setStep] = useState<'pagante' | 'importi'>('pagante');

    // Step (a) — ricerca pagante.
    const [query, setQuery] = useState('');
    const [parents, setParents] = useState<ParentLite[]>([]);
    const [loadingParents, setLoadingParents] = useState(true);
    const [fam, setFam] = useState<Famiglia | null>(null);

    // Step (b) — importi.
    const [totale, setTotale] = useState('');
    const [metodo, setMetodo] = useState('bonifico');
    const [riferimento, setRiferimento] = useState('');
    const [dataValuta, setDataValuta] = useState(() => new Date().toISOString().slice(0, 10));
    const [note, setNote] = useState('');
    const [alloc, setAlloc] = useState<Record<string, string>>({}); // voce.id → importo (assente = esclusa)
    const [ric, setRic] = useState<Record<string, Ricarica>>({});    // alunno_id → { euro, ticket }

    // Dialog eccedenza + esito.
    const [confermaEcc, setConfermaEcc] = useState<number | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fatto, setFatto] = useState<{ transazioneId: string; voci: Voce[] } | null>(null);

    // Registro transazioni.
    const [registro, setRegistro] = useState<TxRow[]>([]);
    const [registroDisp, setRegistroDisp] = useState(true);
    const [loadingRegistro, setLoadingRegistro] = useState(true);
    const [annullaTx, setAnnullaTx] = useState<TxRow | null>(null);

    // ── Loader registro ──────────────────────────────────────────────────────
    // try/finally (mai try/catch): un catch che setState sarebbe raggiungibile in
    // modo sincrono e violerebbe react-hooks/set-state-in-effect.
    const caricaRegistro = useCallback(async () => {
        try {
            const r = await fetch('/api/pagamenti/transazioni', { headers: hdr(userId) });
            const j = await r.json();
            if (j?.success) { setRegistro(j.data ?? []); setRegistroDisp(j.disponibile !== false); }
            else setRegistroDisp(false);
        } finally {
            setLoadingRegistro(false);
        }
    }, [userId]);

    useEffect(() => { caricaRegistro(); }, [caricaRegistro]);

    // ── Step (a): ricerca pagante ─────────────────────────────────────────────
    const cercaParents = useCallback(async () => {
        try {
            const r = await fetch('/api/admin/parents', { headers: hdr(userId) });
            const j = await r.json();
            const lista: ParentLite[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
            setParents(lista);
        } finally {
            setLoadingParents(false);
        }
    }, [userId]);

    useEffect(() => { cercaParents(); }, [cercaParents]);

    const parentsFiltrati = parents
        .filter((p) => {
            const nome = `${p.first_name ?? ''} ${p.last_name ?? ''}`.toLowerCase();
            return query.trim().length === 0 || nome.includes(query.trim().toLowerCase());
        })
        .slice(0, 40);

    const selezionaPagante = async (p: ParentLite) => {
        setError(null);
        try {
            const r = await fetch(`/api/pagamenti/famiglia?parent_id=${p.id}`, { headers: hdr(userId) });
            const j = await r.json();
            if (!j?.success) { setError(j?.error || 'Impossibile caricare la famiglia'); return; }
            const f = j.data as Famiglia;
            setFam(f);
            // Precompila le allocazioni con il residuo effettivo di ogni voce (modificabili).
            const initAlloc: Record<string, string> = {};
            for (const v of f.voci) initAlloc[v.id] = String(v.residuo);
            setAlloc(initAlloc);
            setRic({});
            setTotale('');
            setStep('importi');
            setFatto(null);
        } catch { setError('Errore di rete nel caricamento della famiglia'); }
    };

    // ── Step (b): quadratura ──────────────────────────────────────────────────
    const totaleNum = Number(totale) || 0;
    const vociIncluse = (fam?.voci ?? []).filter((v) => alloc[v.id] !== undefined && Number(alloc[v.id]) > 0);
    const allocatoVoci = round2(vociIncluse.reduce((s, v) => s + Number(alloc[v.id] || 0), 0));
    const ricInclusi = Object.entries(ric)
        .map(([alunno_id, r]) => ({ alunno_id, euro: Number(r.euro) || 0, ticket: Math.trunc(Number(r.ticket) || 0) }))
        .filter((r) => r.euro > 0 && r.ticket > 0);
    const allocatoRic = round2(ricInclusi.reduce((s, r) => s + r.euro, 0));
    const allocato = round2(allocatoVoci + allocatoRic);
    const differenza = round2(totaleNum - allocato);
    const hasRigheOltreTotale = Object.entries(ric).some(([, r]) => (Number(r.euro) > 0) !== (Math.trunc(Number(r.ticket) || 0) > 0));

    const toggleVoce = (v: Voce) => {
        setAlloc((prev) => {
            const next = { ...prev };
            if (next[v.id] !== undefined) delete next[v.id];
            else next[v.id] = String(v.residuo);
            return next;
        });
    };
    const setVoceImporto = (id: string, val: string) => setAlloc((prev) => ({ ...prev, [id]: val }));

    const proponi = () => {
        if (!fam) return;
        if (totaleNum <= 0) { setError('Inserisci prima l\'importo totale versato'); return; }
        setError(null);
        // Capienza = totale meno quanto già destinato alle ricariche mensa; le voci
        // sono già ordinate dal server (più vecchie prima).
        setAlloc(proponiAllocazione(fam.voci, round2(totaleNum - allocatoRic)));
    };

    const setRicarica = (alunnoId: string, campo: keyof Ricarica, val: string) => {
        setRic((prev) => {
            const base: Ricarica = prev[alunnoId] ?? { euro: '', ticket: '' };
            return { ...prev, [alunnoId]: { ...base, [campo]: val } };
        });
    };

    // ── Salvataggio ───────────────────────────────────────────────────────────
    const puoConfermare = !!fam && totaleNum > 0 && (vociIncluse.length > 0 || ricInclusi.length > 0) && differenza >= -0.005 && !hasRigheOltreTotale;

    const invia = async (confermaEccedenza: boolean) => {
        if (!fam) return;
        setSaving(true);
        setError(null);
        try {
            const payload: Record<string, unknown> = {
                pagante_parent_id: fam.parent.id,
                scuola_id: scuolaId,
                metodo,
                riferimento: riferimento.trim() || null,
                data_valuta: dataValuta || null,
                note: note.trim() || null,
                importo_totale: totaleNum,
                voci: vociIncluse.map((v) => ({ pagamento_id: v.id, importo: round2(Number(alloc[v.id])) })),
                ricariche_mensa: ricInclusi.map((r) => ({ alunno_id: r.alunno_id, importo: round2(r.euro), ticket: r.ticket })),
                eccedenza_a_credito: differenza > 0.005 ? differenza : 0,
            };
            if (confermaEccedenza) payload.conferma_eccedenza = 'credito_famiglia';

            const res = await fetch('/api/pagamenti/transazioni', {
                method: 'POST', headers: hdr(userId), body: JSON.stringify(payload),
            });
            const j = await res.json();
            // Eccedenza mai silenziosa: 409 → apri la conferma esplicita «credito famiglia».
            if (res.status === 409 && j.eccedenza != null) { setConfermaEcc(Number(j.eccedenza)); return; }
            if (!res.ok) { setError(j.error || 'Errore nella registrazione della transazione'); return; }
            setConfermaEcc(null);
            setFatto({ transazioneId: j.data?.transazione_id ?? '', voci: vociIncluse });
            void caricaRegistro();
        } catch { setError('Errore di rete'); }
        finally { setSaving(false); }
    };

    const reset = () => {
        setStep('pagante'); setFam(null); setFatto(null); setError(null);
        setTotale(''); setRiferimento(''); setNote(''); setAlloc({}); setRic({});
    };

    // ── Annullo transazione ───────────────────────────────────────────────────
    const [motivoAnnullo, setMotivoAnnullo] = useState('');
    const [busyAnnullo, setBusyAnnullo] = useState(false);
    const eseguiAnnullo = async () => {
        if (!annullaTx || motivoAnnullo.trim().length < 3) return;
        setBusyAnnullo(true);
        try {
            const res = await fetch(`/api/pagamenti/transazioni/${annullaTx.id}/annulla`, {
                method: 'POST', headers: hdr(userId), body: JSON.stringify({ motivo: motivoAnnullo.trim() }),
            });
            if (res.ok) { setAnnullaTx(null); setMotivoAnnullo(''); void caricaRegistro(); }
            else { const j = await res.json(); setError(j.error || 'Annullo non riuscito'); }
        } catch { setError('Errore di rete nell\'annullo'); }
        finally { setBusyAnnullo(false); }
    };

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="space-y-8">
            <div>
                <SectionTitle icon={Coins} title="Incasso unico di famiglia" sub="Un solo versamento che salda più voci di più figli e ricarica la mensa." />

                {/* STEP A — pagante */}
                {step === 'pagante' && (
                    <div className="space-y-3">
                        <div className="relative">
                            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
                            <input
                                type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                                placeholder="Cerca il pagante per nome o cognome…"
                                className={cx(INPUT, 'pl-9')} aria-label="Cerca pagante"
                            />
                        </div>
                        <div className="max-h-80 overflow-y-auto rounded-card border border-kidville-line divide-y divide-kidville-line">
                            {loadingParents && <p className="px-3 py-3 font-maven text-sm text-kidville-muted">Caricamento…</p>}
                            {!loadingParents && parentsFiltrati.length === 0 && (
                                <p className="px-3 py-3 font-maven text-sm text-kidville-muted">Nessun tutore trovato.</p>
                            )}
                            {parentsFiltrati.map((p) => (
                                <button
                                    key={p.id} type="button" onClick={() => selezionaPagante(p)}
                                    className="flex w-full items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-kidville-green-soft"
                                >
                                    <span className="font-maven text-sm text-kidville-ink">{`${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || '—'}</span>
                                    <ArrowLeft size={15} className="rotate-180 text-kidville-muted" />
                                </button>
                            ))}
                        </div>
                        {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}
                    </div>
                )}

                {/* STEP B — importi */}
                {step === 'importi' && fam && !fatto && (
                    <div className="space-y-5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <p className="font-barlow text-sm font-black uppercase text-kidville-green">{fam.parent.nome || 'Pagante'}</p>
                                <p className="font-maven text-xs text-kidville-sub">
                                    {fam.figli.length} {fam.figli.length === 1 ? 'figlio' : 'figli'} · credito famiglia {formatEuro(fam.credito)}
                                </p>
                            </div>
                            <button type="button" onClick={reset} className={cx(BTN_SECONDARY, 'py-1.5 px-3 text-xs')}>
                                <ArrowLeft size={13} /> Cambia pagante
                            </button>
                        </div>

                        {/* Dati del versamento */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div>
                                <label htmlFor="tx-totale" className="mb-1 block font-maven text-xs text-kidville-sub">Totale versato (€)</label>
                                <input id="tx-totale" type="number" min={0} step="0.01" value={totale} onChange={(e) => setTotale(e.target.value)} className={INPUT} />
                            </div>
                            <div>
                                <label htmlFor="tx-metodo" className="mb-1 block font-maven text-xs text-kidville-sub">Metodo</label>
                                <select id="tx-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)} className={SELECT}>
                                    {METODI.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="tx-riferimento" className="mb-1 block font-maven text-xs text-kidville-sub">Riferimento / CRO</label>
                                <input id="tx-riferimento" type="text" value={riferimento} onChange={(e) => setRiferimento(e.target.value)} placeholder="CRO / TRN" className={INPUT} />
                            </div>
                            <div>
                                <label htmlFor="tx-datavaluta" className="mb-1 block font-maven text-xs text-kidville-sub">Data valuta</label>
                                <input id="tx-datavaluta" type="date" value={dataValuta} onChange={(e) => setDataValuta(e.target.value)} className={INPUT} />
                            </div>
                        </div>

                        {/* Voci aperte per figlio */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <h3 className="font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">Voci da saldare</h3>
                                <button type="button" onClick={proponi} className={cx(BTN_SECONDARY, 'py-1.5 px-3 text-xs')}>
                                    <Wand2 size={13} /> Proposta automatica
                                </button>
                            </div>
                            {fam.voci.length === 0 && <p className="font-maven text-sm text-kidville-muted">Nessuna voce aperta per questa famiglia.</p>}
                            {fam.figli.filter((f) => fam.voci.some((v) => v.alunno_id === f.id)).map((f) => (
                                <div key={f.id} className="rounded-card border border-kidville-line p-3">
                                    <p className="mb-2 font-maven text-sm font-bold text-kidville-ink">{nomeFiglio(f)}</p>
                                    <div className="space-y-1.5">
                                        {fam.voci.filter((v) => v.alunno_id === f.id).map((v) => {
                                            const on = alloc[v.id] !== undefined;
                                            return (
                                                <div key={v.id} className="flex items-center gap-2">
                                                    <input
                                                        type="checkbox" checked={on} onChange={() => toggleVoce(v)}
                                                        className="h-4 w-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                                        aria-label={`Includi ${v.descrizione ?? 'voce'}`}
                                                    />
                                                    <span className="flex-1 truncate font-maven text-sm text-kidville-ink">
                                                        {v.descrizione ?? 'Voce'}
                                                        <span className={cx('ml-2 text-xs', v.stato_effettivo === 'scaduto' ? 'text-kidville-error-strong' : 'text-kidville-sub')}>
                                                            resta {formatEuro(v.residuo)}{v.scadenza ? ` · scad. ${dataIt(v.scadenza)}` : ''}
                                                        </span>
                                                    </span>
                                                    <span className="font-maven text-xs text-kidville-muted">€</span>
                                                    <input
                                                        type="number" min={0} step="0.01" disabled={!on}
                                                        value={on ? alloc[v.id] : ''} onChange={(e) => setVoceImporto(v.id, e.target.value)}
                                                        className="w-24 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green disabled:opacity-50"
                                                        aria-label={`Importo ${v.descrizione ?? 'voce'}`}
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Ricariche mensa per figlio */}
                        <div className="space-y-2">
                            <h3 className="flex items-center gap-1.5 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">
                                <UtensilsCrossed size={13} /> Ricarica mensa
                            </h3>
                            {fam.figli.map((f) => (
                                <div key={f.id} className="flex flex-wrap items-center gap-2">
                                    <span className="min-w-40 flex-1 font-maven text-sm text-kidville-ink">
                                        {nomeFiglio(f)} <span className="text-xs text-kidville-muted">({f.saldo_ticket} ticket)</span>
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <span className="font-maven text-xs text-kidville-muted">€</span>
                                        <input
                                            type="number" min={0} step="0.01" value={ric[f.id]?.euro ?? ''}
                                            onChange={(e) => setRicarica(f.id, 'euro', e.target.value)}
                                            className="w-20 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                                            aria-label={`Euro ricarica ${nomeFiglio(f)}`}
                                        />
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <input
                                            type="number" min={0} step="1" value={ric[f.id]?.ticket ?? ''}
                                            onChange={(e) => setRicarica(f.id, 'ticket', e.target.value)}
                                            className="w-20 rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-2 py-1 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
                                            aria-label={`Ticket ricarica ${nomeFiglio(f)}`}
                                        />
                                        <span className="font-maven text-xs text-kidville-muted">ticket</span>
                                    </div>
                                </div>
                            ))}
                            {hasRigheOltreTotale && (
                                <p role="alert" className="font-maven text-[11px] text-kidville-error-strong">Ogni ricarica richiede sia gli euro sia i ticket (entrambi &gt; 0).</p>
                            )}
                        </div>

                        {/* Quadratura live — annunciata agli screen reader mentre cambia */}
                        <div role="status" aria-live="polite" className={cx(
                            'flex flex-wrap items-center justify-between gap-2 rounded-card px-3 py-2.5',
                            differenza === 0 ? 'bg-kidville-success-soft' : differenza > 0 ? 'bg-kidville-warn-soft' : 'bg-kidville-error-soft',
                        )}>
                            <span className="font-maven text-sm text-kidville-ink">
                                Allocato <strong>{formatEuro(allocato)}</strong> su <strong>{formatEuro(totaleNum)}</strong>
                            </span>
                            <span className={cx(
                                'font-barlow text-sm font-black uppercase',
                                differenza === 0 ? 'text-kidville-success-strong' : differenza > 0 ? 'text-kidville-warn-strong' : 'text-kidville-error-strong',
                            )}>
                                {differenza === 0 ? 'Quadra' : differenza > 0 ? `${formatEuro(differenza)} in eccesso → credito` : `${formatEuro(-differenza)} oltre il totale`}
                            </span>
                        </div>

                        {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}

                        <div className="flex gap-2">
                            <button type="button" onClick={reset} className={cx(BTN_SECONDARY, 'flex-1')}>Annulla</button>
                            <button
                                type="button" onClick={() => invia(false)} disabled={!puoConfermare || saving}
                                className={cx(BTN_PRIMARY, 'flex-1')}
                            >
                                {saving ? 'Registrazione…' : 'Registra incasso'}
                            </button>
                        </div>
                    </div>
                )}

                {/* ESITO — ricevuta / dividi in fatture */}
                {fatto && fam && (
                    <div className="space-y-4">
                        <div role="status" className="flex items-center gap-2 rounded-card bg-kidville-success-soft px-3 py-2.5">
                            <Check size={18} className="text-kidville-success-strong" />
                            <span className="font-maven text-sm font-bold text-kidville-success-strong">Transazione registrata · {formatEuro(totaleNum)}</span>
                        </div>

                        <div className="flex flex-wrap gap-2">
                            <a
                                href={`/api/pagamenti/transazioni/${fatto.transazioneId}/ricevuta?userId=${userId}`}
                                target="_blank" rel="noopener noreferrer"
                                className={cx(BTN_PRIMARY, 'text-sm')}
                            >
                                <FileText size={15} /> Ricevuta famiglia (PDF)
                            </a>
                        </div>

                        {fatto.voci.length > 0 && (
                            <div className="rounded-card border border-kidville-line p-3">
                                <p className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">Dividi in fatture</p>
                                <p className="mb-3 font-maven text-[11px] text-kidville-muted">In alternativa alla ricevuta unica, emetti una fattura elettronica per singola voce.</p>
                                <div className="space-y-1.5">
                                    {fatto.voci.map((v) => (
                                        <div key={v.id} className="flex items-center justify-between gap-2">
                                            <span className="flex-1 truncate font-maven text-sm text-kidville-ink">{v.descrizione ?? 'Voce'}</span>
                                            <FatturaButton pagamentoId={v.id} userId={userId} descrizione={v.descrizione ?? undefined} />
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <button type="button" onClick={reset} className={cx(BTN_SECONDARY, 'w-full')}>Nuovo incasso</button>
                    </div>
                )}
            </div>

            {/* REGISTRO TRANSAZIONI */}
            <div>
                <SectionTitle icon={RotateCcw} title="Registro transazioni" sub="Ultime transazioni di famiglia: ristampa la ricevuta o annulla con motivo." />
                {loadingRegistro && <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>}
                {!loadingRegistro && !registroDisp && <p className="font-maven text-sm text-kidville-muted">Registro non disponibile su questo ambiente.</p>}
                {!loadingRegistro && registroDisp && registro.length === 0 && <p className="font-maven text-sm text-kidville-muted">Nessuna transazione registrata.</p>}
                {!loadingRegistro && registroDisp && registro.length > 0 && (
                    <div className="overflow-x-auto rounded-card border border-kidville-line">
                        <table className="w-full min-w-[640px] border-collapse">
                            <thead>
                                <tr className="border-b border-kidville-line bg-kidville-cream/40 text-left">
                                    {['Data', 'Totale', 'Metodo', 'Riferimento', ''].map((h) => (
                                        <th key={h} className="px-3 py-2 font-barlow text-[11px] font-black uppercase tracking-wide text-kidville-muted">{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {registro.map((t) => (
                                    <tr key={t.id} className={cx('border-b border-kidville-line last:border-0', t.annullata_il && 'opacity-50')}>
                                        <td className="px-3 py-2 font-maven text-sm text-kidville-ink">{dataIt(t.data_valuta ?? t.creato_il)}</td>
                                        <td className="px-3 py-2 font-maven text-sm font-bold text-kidville-green">{formatEuro(Number(t.importo_totale))}</td>
                                        <td className="px-3 py-2 font-maven text-sm text-kidville-ink">{METODI.find((m) => m.v === t.metodo)?.l ?? t.metodo}</td>
                                        <td className="px-3 py-2 font-maven text-xs text-kidville-muted">{t.riferimento || '—'}</td>
                                        <td className="px-3 py-2 text-right">
                                            {t.annullata_il ? (
                                                <span className="font-barlow text-[11px] font-black uppercase text-kidville-error">Annullata</span>
                                            ) : (
                                                <div className="flex items-center justify-end gap-1.5">
                                                    <a
                                                        href={`/api/pagamenti/transazioni/${t.id}/ricevuta?userId=${userId}`}
                                                        target="_blank" rel="noopener noreferrer" title="Ristampa ricevuta"
                                                        className="inline-flex items-center gap-1 rounded-pill bg-kidville-green-soft px-2 py-1 font-maven text-xs font-bold text-kidville-green transition-colors hover:bg-kidville-green/20"
                                                    >
                                                        <Printer size={12} /> Ricevuta
                                                    </a>
                                                    <button
                                                        type="button" onClick={() => { setAnnullaTx(t); setMotivoAnnullo(''); }}
                                                        className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-kidville-line px-2 py-1 font-maven text-xs font-bold text-kidville-muted transition-colors hover:border-kidville-error hover:text-kidville-error"
                                                    >
                                                        <X size={12} /> Annulla
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* DIALOG — conferma eccedenza → credito famiglia (primitiva accessibile) */}
            <Modal
                open={confermaEcc != null}
                onClose={() => setConfermaEcc(null)}
                title="Eccedenza da confermare"
                labelledBy="tx-eccedenza-title"
                className={cx(MODAL_CARD, 'max-w-sm')}
                style={{ boxShadow: MODAL_SHADOW }}
            >
                <h2 id="tx-eccedenza-title" className="mb-2 font-barlow text-base font-black uppercase text-kidville-green">Eccedenza da confermare</h2>
                <p className="mb-3 font-maven text-sm text-kidville-ink">
                    Il totale versato supera l&apos;allocato di <strong>{formatEuro(confermaEcc)}</strong>.
                    Vuoi registrare l&apos;eccedenza come <strong>credito famiglia</strong> riutilizzabile?
                </p>
                <div className="flex gap-2">
                    <button type="button" onClick={() => setConfermaEcc(null)} className={cx(BTN_SECONDARY, 'flex-1')}>Annulla</button>
                    <button type="button" onClick={() => invia(true)} disabled={saving} className={cx(BTN_PRIMARY, 'flex-1')}>Conferma credito</button>
                </div>
            </Modal>

            {/* DIALOG — annullo transazione (primitiva accessibile) */}
            <Modal
                open={annullaTx != null}
                onClose={() => setAnnullaTx(null)}
                title="Annulla transazione"
                labelledBy="tx-annullo-title"
                className={cx(MODAL_CARD, 'max-w-sm')}
                style={{ boxShadow: MODAL_SHADOW }}
            >
                <h2 id="tx-annullo-title" className="mb-2 font-barlow text-base font-black uppercase text-kidville-green">Annulla transazione</h2>
                <p className="mb-3 font-maven text-sm text-kidville-ink">
                    Verranno stornati tutti gli incassi collegati, incluse le eventuali ricariche mensa{annullaTx ? ` (${formatEuro(Number(annullaTx.importo_totale))})` : ''}. Indica il motivo (obbligatorio).
                </p>
                <input
                    type="text" value={motivoAnnullo} onChange={(e) => setMotivoAnnullo(e.target.value)}
                    placeholder="Motivo dell'annullo (min 3 caratteri)" className={cx(INPUT, 'mb-3')} aria-label="Motivo dell'annullo"
                />
                <div className="flex gap-2">
                    <button type="button" onClick={() => setAnnullaTx(null)} className={cx(BTN_SECONDARY, 'flex-1')}>Indietro</button>
                    <button
                        type="button" onClick={eseguiAnnullo} disabled={busyAnnullo || motivoAnnullo.trim().length < 3}
                        className={cx(BTN_PRIMARY, 'flex-1')}
                    >
                        {busyAnnullo ? 'Annullo…' : 'Conferma annullo'}
                    </button>
                </div>
            </Modal>
        </div>
    );
}
