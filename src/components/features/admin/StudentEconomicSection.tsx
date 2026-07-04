'use client';

import { useEffect, useState, useCallback } from 'react';
import { Euro, Users2, FileText } from 'lucide-react';

// Identità app-level (M4, session-only): userId da query param, poi sessione
// persistita da useSessionIdentity (kv_user_id). Nessun fallback demo:
// null = identità non risolta. Vedi getCurrentTeacherId in lib/auth/current-teacher.ts.
function currentUserId(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const fromUrl = new URLSearchParams(window.location.search).get('userId');
        if (fromUrl) return fromUrl;
        return window.localStorage.getItem('kv_user_id');
    } catch {
        return null;
    }
}

interface QuotaConfig { adult_id?: string; nome?: string; importo: number }
interface SplitConfig { quote: QuotaConfig[] }
interface IntestatarioAltro { nome?: string; cf?: string; indirizzo?: string; email?: string }
interface Intestatario { tipo: 'adult' | 'altro'; adult_id?: string; nome?: string; dati?: IntestatarioAltro }

interface Tutore { adult_id: string; nome: string; cognome: string; email: string; percentuale: number | null; has_fiscal_code?: boolean }

interface ParentOption { id: string; nome: string; relazione: string }

interface Props {
    alunnoId: string;
    form: Record<string, unknown>;
    updateForm: (field: string, value: unknown) => void;
    // opzioni intestatario derivate dagli adulti collegati (anagrafica parents)
    parents?: { relation_type: string; parents?: { id: string; first_name?: string; last_name?: string } }[];
}

const inputCls =
    'w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green';
const labelCls = 'font-maven text-xs text-kidville-muted mb-1 block';

export function StudentEconomicSection({ alunnoId, form, updateForm, parents }: Props) {
    const importo = Number(form.importo_retta_mensile ?? 0);
    const separati = !!form.genitori_separati;
    const split = (form.retta_split_config as SplitConfig | null) ?? null;
    const intestatario = (form.intestatario_fatture as Intestatario | null) ?? null;

    const [tutori, setTutori] = useState<Tutore[]>([]);

    const parentOptions: ParentOption[] = (parents || [])
        .filter((p) => p.parents)
        .map((p) => ({
            id: p.parents!.id,
            nome: `${p.parents!.first_name ?? ''} ${p.parents!.last_name ?? ''}`.trim(),
            relazione: p.relation_type === 'mother' ? 'Madre' : p.relation_type === 'father' ? 'Padre' : 'Genitore',
        }));

    // Carica i tutori (account) per il default delle quote split
    useEffect(() => {
        if (!separati || !alunnoId) return;
        const uid = currentUserId();
        if (!uid) return;
        fetch(`/api/pagamenti/tutori?alunno_id=${alunnoId}&userId=${uid}`, {
            headers: { 'x-user-id': uid },
        })
            .then((r) => r.json())
            .then((d) => { if (d?.success) setTutori(d.data); })
            .catch(() => {});
    }, [separati, alunnoId]);

    // Inizializza split di default quando si attiva "genitori separati"
    const seedSplit = useCallback(() => {
        const base: Partial<Tutore>[] = tutori.length >= 2 ? tutori.slice(0, 2) : tutori;
        const half = Math.round((importo / 2) * 100) / 100;
        const quote: QuotaConfig[] = (base.length ? base : ([{}, {}] as Partial<Tutore>[])).map((t, i) => ({
            adult_id: t.adult_id,
            nome: t.nome ? `${t.nome} ${t.cognome}`.trim() : i === 0 ? 'Genitore 1' : 'Genitore 2',
            importo: t.percentuale != null ? Math.round((importo * t.percentuale) / 100 * 100) / 100 : half,
        }));
        updateForm('retta_split_config', { quote });
    }, [tutori, importo, updateForm]);

    useEffect(() => {
        if (separati && (!split || split.quote.length === 0) && (tutori.length > 0 || importo > 0)) {
            seedSplit();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [separati, tutori]);

    const updateQuota = (idx: number, value: number) => {
        const cur = (form.retta_split_config as SplitConfig | null)?.quote ?? [];
        const next = cur.map((q, i) => (i === idx ? { ...q, importo: value } : q));
        updateForm('retta_split_config', { quote: next });
    };

    const quoteSum = (split?.quote ?? []).reduce((s, q) => s + Number(q.importo || 0), 0);
    const sumMismatch = separati && split && split.quote.length > 0 && Math.abs(quoteSum - importo) > 0.01;

    // Mappa adult_id → ha codice fiscale (dal ponte parents lato server). Serve ad
    // avvisare che una quota non è fatturabile senza CF del genitore intestatario.
    const cfByAdult = new Map(tutori.map((t) => [t.adult_id, t.has_fiscal_code !== false]));

    const setIntestatario = (val: Intestatario | null) => updateForm('intestatario_fatture', val);

    return (
        <section className="pt-4 border-t border-kidville-line">
            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                <Euro size={12} />
                Dati Economici
            </h3>

            {/* Retta mensile */}
            <div className="mb-4">
                <label className={labelCls}>Importo retta mensile (€)</label>
                <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={importo || ''}
                    onChange={(e) => updateForm('importo_retta_mensile', e.target.value === '' ? 0 : Number(e.target.value))}
                    placeholder="Es: 150.00"
                    className={inputCls}
                />
                <p className="font-maven text-[11px] text-kidville-muted mt-1">
                    Per lo sconto fratelli, assegna l&apos;intero importo familiare a un solo figlio (gli altri a 0).
                </p>
            </div>

            {/* Genitori separati */}
            <div className="mb-3 flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={separati}
                        onChange={(e) => {
                            updateForm('genitori_separati', e.target.checked);
                            if (!e.target.checked) updateForm('retta_split_config', null);
                        }}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                    />
                    <span className="font-maven font-semibold text-sm text-kidville-green flex items-center gap-1">
                        <Users2 size={14} /> Genitori separati (retta divisa in due quote)
                    </span>
                </label>
            </div>

            {separati && (
                <div className="mb-4 bg-kidville-cream/60 rounded-xl p-3 space-y-2">
                    {(split?.quote ?? []).map((q, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <span className="font-maven text-sm text-kidville-green flex-1 truncate">
                                {q.nome || `Genitore ${i + 1}`}
                                {q.adult_id && cfByAdult.get(q.adult_id) === false && (
                                    <span className="ml-1 rounded-full bg-kidville-warn-soft px-1.5 py-0.5 text-[10px] font-bold text-kidville-warn" title="Codice fiscale mancante: questa quota non può essere fatturata finché non lo aggiungi all'anagrafica del genitore.">
                                        manca CF
                                    </span>
                                )}
                            </span>
                            <div className="flex items-center gap-1">
                                <span className="font-maven text-xs text-kidville-muted">€</span>
                                <input
                                    type="number"
                                    min={0}
                                    step="0.01"
                                    value={q.importo || ''}
                                    onChange={(e) => updateQuota(i, e.target.value === '' ? 0 : Number(e.target.value))}
                                    className="w-24 border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                    ))}
                    <div className="flex justify-between items-center pt-1 border-t border-kidville-line">
                        <span className="font-maven text-xs text-kidville-muted">Somma quote</span>
                        <span className={`font-maven text-sm font-bold ${sumMismatch ? 'text-kidville-error' : 'text-kidville-green'}`}>
                            € {quoteSum.toFixed(2)} {sumMismatch && `≠ € ${importo.toFixed(2)}`}
                        </span>
                    </div>
                    {sumMismatch && (
                        <p className="font-maven text-[11px] text-kidville-error">
                            La somma delle quote deve coincidere con la retta mensile.
                        </p>
                    )}
                </div>
            )}

            {/* Intestatario fatture */}
            <div>
                <label className={`${labelCls} flex items-center gap-1`}>
                    <FileText size={12} /> Intestatario fatture
                </label>
                <select
                    value={intestatario?.tipo === 'altro' ? '__altro__' : intestatario?.adult_id ?? ''}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return setIntestatario(null);
                        if (v === '__altro__') return setIntestatario({ tipo: 'altro', dati: {} });
                        const opt = parentOptions.find((p) => p.id === v);
                        setIntestatario({ tipo: 'adult', adult_id: v, nome: opt?.nome });
                    }}
                    className={`${inputCls} bg-white`}
                >
                    <option value="">— Nessuno —</option>
                    {parentOptions.map((p) => (
                        <option key={p.id} value={p.id}>{p.relazione}: {p.nome}</option>
                    ))}
                    <option value="__altro__">Altro (persona non registrata)</option>
                </select>

                {intestatario?.tipo === 'altro' && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                        {([
                            ['nome', 'Nome e cognome'],
                            ['cf', 'Codice fiscale / P.IVA'],
                            ['indirizzo', 'Indirizzo'],
                            ['email', 'Email'],
                        ] as const).map(([k, ph]) => (
                            <input
                                key={k}
                                type="text"
                                value={(intestatario.dati?.[k] as string) ?? ''}
                                onChange={(e) =>
                                    setIntestatario({
                                        tipo: 'altro',
                                        dati: { ...intestatario.dati, [k]: e.target.value },
                                    })
                                }
                                placeholder={ph}
                                className={inputCls}
                            />
                        ))}
                    </div>
                )}
            </div>
        </section>
    );
}
