'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Euro, Users2, FileText, Crown } from 'lucide-react';

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
    const t = useTranslations('adminStudents');
    const importo = Number(form.importo_retta_mensile ?? 0);
    const separati = !!form.genitori_separati;
    const split = (form.retta_split_config as SplitConfig | null) ?? null;
    const intestatario = (form.intestatario_fatture as Intestatario | null) ?? null;

    const [tutori, setTutori] = useState<Tutore[]>([]);

    // Intestatario di famiglia (predefinito): `parents.intestatario_default`. Vale
    // per tutti i figli, salvo l'eccezione per-figlio (intestatario_fatture) che vince.
    const [defaultParentId, setDefaultParentId] = useState<string | null>(null);
    const [savingDefault, setSavingDefault] = useState(false);

    const parentOptions: ParentOption[] = (parents || [])
        .filter((p) => p.parents)
        .map((p) => ({
            id: p.parents!.id,
            nome: `${p.parents!.first_name ?? ''} ${p.parents!.last_name ?? ''}`.trim(),
            relazione: p.relation_type === 'mother' ? t('ruoloMadre') : p.relation_type === 'father' ? t('ruoloPadre') : t('ruoloGenitore'),
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

    // Carica quale genitore è l'intestatario di famiglia predefinito (parents.*).
    useEffect(() => {
        if (!alunnoId) return;
        const uid = currentUserId();
        if (!uid) return;
        let active = true;
        fetch(`/api/admin/parents?student_id=${alunnoId}`, { headers: { 'x-user-id': uid } })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
                if (!active || !Array.isArray(d)) return;
                const def = d.find((p: { id: string; intestatario_default?: boolean }) => p.intestatario_default === true);
                setDefaultParentId(def?.id ?? null);
            })
            .catch(() => { /* colonna assente / errore: nessun default mostrato */ });
        return () => { active = false; };
    }, [alunnoId]);

    // Scegliere un intestatario di famiglia AZZERA l'altro tutore (uno solo per
    // famiglia). Scritture best-effort: se la colonna non c'è (PGRST204/42703) il
    // PATCH la scarta e il flusso non si rompe.
    const setIntestatarioFamiglia = useCallback(async (parentId: string | null) => {
        const uid = currentUserId();
        if (!uid) return;
        const precedente = defaultParentId;
        setDefaultParentId(parentId);
        setSavingDefault(true);
        try {
            const ids = new Set<string>(parentOptions.map((p) => p.id));
            if (precedente) ids.add(precedente);
            await Promise.all(
                [...ids].map((id) =>
                    fetch('/api/admin/parents', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json', 'x-user-id': uid },
                        body: JSON.stringify({ id, intestatario_default: id === parentId }),
                    }).catch(() => { /* best-effort per singolo tutore */ }),
                ),
            );
        } finally {
            setSavingDefault(false);
        }
    }, [defaultParentId, parentOptions]);

    // Inizializza split di default quando si attiva "genitori separati"
    const seedSplit = useCallback(() => {
        const base: Partial<Tutore>[] = tutori.length >= 2 ? tutori.slice(0, 2) : tutori;
        const half = Math.round((importo / 2) * 100) / 100;
        const quote: QuotaConfig[] = (base.length ? base : ([{}, {}] as Partial<Tutore>[])).map((tt, i) => ({
            adult_id: tt.adult_id,
            nome: tt.nome ? `${tt.nome} ${tt.cognome}`.trim() : i === 0 ? 'Genitore 1' : 'Genitore 2',
            importo: tt.percentuale != null ? Math.round((importo * tt.percentuale) / 100 * 100) / 100 : half,
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
    const cfByAdult = new Map(tutori.map((tt) => [tt.adult_id, tt.has_fiscal_code !== false]));

    const setIntestatario = (val: Intestatario | null) => updateForm('intestatario_fatture', val);

    return (
        <section className="pt-4 border-t border-kidville-line">
            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                <Euro size={12} />
                {t('econDatiEconomici')}
            </h3>

            {/* Retta mensile */}
            <div className="mb-4">
                <label className={labelCls}>{t('econImportoRetta')}</label>
                <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={importo || ''}
                    onChange={(e) => updateForm('importo_retta_mensile', e.target.value === '' ? 0 : Number(e.target.value))}
                    placeholder={t('econImportoPlaceholder')}
                    className={inputCls}
                />
                <p className="font-maven text-[11px] text-kidville-muted mt-1">
                    {t('econScontoFratelliPre')}<strong>{t('econScontoFratelliBold')}</strong>{t('econScontoFratelliPost')}
                </p>
            </div>

            {/* Giorno di paga personalizzato */}
            <div className="mb-4">
                <label className={labelCls}>{t('econGiornoPagamento')}</label>
                <input
                    type="number"
                    min={1}
                    max={28}
                    value={(form.giorno_scadenza_pagamenti as number | null) ?? ''}
                    onChange={(e) => updateForm('giorno_scadenza_pagamenti', e.target.value === '' ? null : Math.min(28, Math.max(1, Number(e.target.value))))}
                    placeholder={t('econGiornoPlaceholder')}
                    className={inputCls}
                />
                <p className="font-maven text-[11px] text-kidville-muted mt-1">
                    {t('econGiornoHint')}
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
                        <Users2 size={14} /> {t('econGenitoriSeparati')}
                    </span>
                </label>
            </div>

            {separati && (
                <div className="mb-4 bg-kidville-cream/60 rounded-xl p-3 space-y-2">
                    {(split?.quote ?? []).map((q, i) => (
                        <div key={i} className="flex items-center gap-2">
                            <span className="font-maven text-sm text-kidville-green flex-1 truncate">
                                {q.nome || t('econGenitoreN', { n: i + 1 })}
                                {q.adult_id && cfByAdult.get(q.adult_id) === false && (
                                    <span className="ml-1 rounded-full bg-kidville-warn-soft px-1.5 py-0.5 text-[10px] font-bold text-kidville-warn" title={t('econMancaCfTitle')}>
                                        {t('econMancaCf')}
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
                        <span className="font-maven text-xs text-kidville-muted">{t('econSommaQuote')}</span>
                        <span className={`font-maven text-sm font-bold ${sumMismatch ? 'text-kidville-error' : 'text-kidville-green'}`}>
                            € {quoteSum.toFixed(2)} {sumMismatch && `≠ € ${importo.toFixed(2)}`}
                        </span>
                    </div>
                    {sumMismatch && (
                        <p className="font-maven text-[11px] text-kidville-error">
                            {t('econSommaErrore')}
                        </p>
                    )}
                </div>
            )}

            {/* Intestatario di famiglia (predefinito) — parents.intestatario_default */}
            {parentOptions.length > 0 && (
                <div className="mb-4">
                    <label className={`${labelCls} flex items-center gap-1`}>
                        <Crown size={12} /> {t('econIntestatarioFamiglia')}
                    </label>
                    <select
                        value={defaultParentId ?? ''}
                        disabled={savingDefault}
                        onChange={(e) => setIntestatarioFamiglia(e.target.value || null)}
                        className={`${inputCls} bg-white disabled:opacity-60`}
                    >
                        <option value="">{t('econNessuno')}</option>
                        {parentOptions.map((p) => (
                            <option key={p.id} value={p.id}>{t('econOpzioneParent', { relazione: p.relazione, nome: p.nome })}</option>
                        ))}
                    </select>
                    <p className="font-maven text-[11px] text-kidville-muted mt-1">
                        {t('econIntestatarioFamigliaHint')}
                    </p>
                </div>
            )}

            {/* Intestatario fatture (eccezione per questo figlio, vince sul default) */}
            <div>
                <label className={`${labelCls} flex items-center gap-1`}>
                    <FileText size={12} /> {t('econIntestatarioFatture')} <span className="font-normal text-kidville-muted/80">{t('econEccezioneFiglio')}</span>
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
                    <option value="">{t('econNessuno')}</option>
                    {parentOptions.map((p) => (
                        <option key={p.id} value={p.id}>{t('econOpzioneParent', { relazione: p.relazione, nome: p.nome })}</option>
                    ))}
                    <option value="__altro__">{t('econAltro')}</option>
                </select>

                {intestatario?.tipo === 'altro' && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                        {([
                            ['nome', t('econPhNomeCognome')],
                            ['cf', t('econPhCf')],
                            ['indirizzo', t('econPhIndirizzo')],
                            ['email', t('econPhEmail')],
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

            <div className="mt-4 border-t border-kidville-line pt-3">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={!!form.opposizione_ade}
                        onChange={(e) => updateForm('opposizione_ade', e.target.checked)}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                    />
                    <span className="font-maven text-sm text-kidville-green">{t('econOpposizioneAde')}</span>
                </label>
                <p className="font-maven text-[11px] text-kidville-muted mt-1">
                    {t('econOpposizioneHint')}
                </p>
            </div>
        </section>
    );
}
