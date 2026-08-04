'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Users, CalendarClock, Plus, Trash2, Sparkles } from 'lucide-react';
import { card, h3, input, label, hint, checkbox, checkboxLabel, checkboxRow } from './ui';
import { hdr } from './ui';
import { SaveRow } from './fields';
import { formatEuro } from '@/lib/format/valuta';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import {
    normalizzaRetteConfig,
    scontoFratelli,
    proRata,
    calcolaScontoRetta,
    type RetteConfig,
    type ScontoFratelliConfig,
    type ProRataConfig,
    type ModoScontoFratelli,
} from '@/lib/pagamenti/rette-config';

interface Props { userId: string; scuolaId: string }

// Sconto fratelli strutturato + rette proporzionali per iscrizione tardiva (slice S6).
// L'ANTEPRIMA è calcolata con le stesse funzioni pure che replicano la SQL
// (`genera_rette_mensili` v2), così ciò che si vede è ciò che verrà generato.
export function RetteSettings({ userId, scuolaId }: Props) {
    const t = useTranslations('adminSettings');
    const [cfg, setCfg] = useState<RetteConfig | null>(null);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState('');
    const [error, setError] = useState<string | null>(null);

    // Anteprima live (valori d'esempio modificabili).
    const [pvImporto, setPvImporto] = useState(150);
    const [pvPosizione, setPvPosizione] = useState(2);
    const [pvGiorno, setPvGiorno] = useState(15);

    useEffect(() => {
        let active = true;
        fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
            .then(r => r.json())
            .then(d => { if (active && d.success) setCfg(normalizzaRetteConfig(d.data.rette_config)); })
            .catch(() => { if (active) setCfg(normalizzaRetteConfig(null)); });
        return () => { active = false; };
    }, [userId, scuolaId]);

    if (!cfg) return null;

    const sf = cfg.sconto_fratelli;
    const pr = cfg.pro_rata_iscrizione;

    const setSF = (patch: Partial<ScontoFratelliConfig>) => setCfg({ ...cfg, sconto_fratelli: { ...sf, ...patch } });
    const setPR = (patch: Partial<ProRataConfig>) => setCfg({ ...cfg, pro_rata_iscrizione: { ...pr, ...patch } });

    const updF = (i: number, key: 'posizione' | 'valore', v: number) =>
        setSF({ scaglioni: sf.scaglioni.map((s, idx) => (idx === i ? { ...s, [key]: v } : s)) });
    const addF = () => {
        const next = sf.scaglioni.length ? Math.max(...sf.scaglioni.map(s => s.posizione)) + 1 : 2;
        setSF({ scaglioni: [...sf.scaglioni, { posizione: Math.max(2, next), valore: sf.modo === 'importo' ? 25 : 10 }] });
    };
    const delF = (i: number) => setSF({ scaglioni: sf.scaglioni.filter((_, idx) => idx !== i) });

    const updP = (i: number, key: 'dal_giorno' | 'percentuale', v: number) =>
        setPR({ scaglioni: pr.scaglioni.map((s, idx) => (idx === i ? { ...s, [key]: v } : s)) });
    const addP = () => {
        const next = pr.scaglioni.length ? Math.min(31, Math.max(...pr.scaglioni.map(s => s.dal_giorno)) + 10) : 1;
        setPR({ scaglioni: [...pr.scaglioni, { dal_giorno: Math.max(1, next), percentuale: 50 }] });
    };
    const delP = (i: number) => setPR({ scaglioni: pr.scaglioni.filter((_, idx) => idx !== i) });

    const save = async () => {
        setSaving(true); setMsg(''); setError(null);
        try {
            // Si invia l'OGGETTO INTERO rette_config (entrambe le sezioni): il merge
            // server-side dei *_config è shallow, mai patch parziali della sezione.
            const res = await fetch('/api/admin/settings', {
                method: 'PATCH', headers: hdr(userId),
                body: JSON.stringify({ scuola_id: scuolaId, rette_config: normalizzaRetteConfig(cfg) }),
            });
            const j = await res.json();
            if (j.success) { setMsg(t('rtImpostazioniSalvate')); setCfg(normalizzaRetteConfig(j.data?.rette_config)); }
            else setError(messaggioDaCorpo(j, t('erroreSalvataggio')));
        } catch {
            setError(t('erroreRete'));
        } finally {
            setSaving(false);
        }
    };

    // ── Anteprima ────────────────────────────────────────────────────────────
    const pvF = scontoFratelli(pvPosizione, pvImporto, cfg);
    const pvP = proRata(pvGiorno, pvImporto, cfg);
    const pvTot = calcolaScontoRetta({ importo: pvImporto, posizione: pvPosizione, giornoIscrizione: pvGiorno, applicaProRata: true, cfg });
    const residuo = Math.max(0, pvImporto - pvTot.sconto);

    const modoBtn = (m: ModoScontoFratelli, testo: string) => (
        <button
            type="button"
            onClick={() => setSF({ modo: m })}
            aria-pressed={sf.modo === m}
            className={`font-maven rounded-pill px-3 py-1.5 text-sm transition-colors ${
                sf.modo === m ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted hover:text-kidville-green'
            }`}
        >
            {testo}
        </button>
    );

    return (
        <div>
            {/* ── Sconto fratelli ── */}
            <section className={card}>
                <h3 className={h3}><Users size={16} /> {t('rtScontoFratelli')}</h3>
                <label className={checkboxRow}>
                    <input type="checkbox" className={checkbox} checked={sf.enabled} onChange={e => setSF({ enabled: e.target.checked })} />
                    <span className={checkboxLabel}>{t('rtAttivaScontoFratelli')}</span>
                </label>
                <p className={hint}>
                    {t('rtScontoFratelliHint')}
                </p>

                {sf.enabled && (
                    <div className="mt-4 space-y-3">
                        <div className="flex items-center gap-2">
                            <span className={label + ' mb-0'}>{t('rtTipoSconto')}</span>
                            {modoBtn('percentuale', t('rtModoPercentuale'))}
                            {modoBtn('importo', t('rtModoImporto'))}
                        </div>

                        <div className="space-y-2">
                            {sf.scaglioni.map((s, i) => (
                                <div key={i} className="flex flex-wrap items-end gap-2">
                                    <div>
                                        <label htmlFor={`sf-pos-${i}`} className={label}>{t('rtDalFiglioN')}</label>
                                        <input id={`sf-pos-${i}`} type="number" min={2} value={Number.isFinite(s.posizione) ? s.posizione : ''}
                                            onChange={e => updF(i, 'posizione', Math.max(2, Math.trunc(Number(e.target.value) || 2)))}
                                            className={`${input} w-28`} />
                                    </div>
                                    <div>
                                        <label htmlFor={`sf-val-${i}`} className={label}>{sf.modo === 'importo' ? t('rtScontoEuro') : t('rtScontoPct')}</label>
                                        <input id={`sf-val-${i}`} type="number" min={0} max={sf.modo === 'importo' ? undefined : 100} step={sf.modo === 'importo' ? '0.01' : '1'}
                                            value={Number.isFinite(s.valore) ? s.valore : ''}
                                            onChange={e => updF(i, 'valore', Math.max(0, Number(e.target.value) || 0))}
                                            className={`${input} w-28`} />
                                    </div>
                                    <button type="button" onClick={() => delF(i)} className="mb-1.5 text-kidville-muted hover:text-kidville-error" aria-label={t('rtRimuoviScaglione')}>
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                            {sf.scaglioni.length === 0 && <p className={hint}>{t('rtNessunoScaglione')}</p>}
                        </div>
                        <button type="button" onClick={addF} className="inline-flex items-center gap-1 rounded-pill border-2 border-kidville-line px-3 py-1.5 font-maven text-sm text-kidville-muted hover:border-kidville-green hover:text-kidville-green">
                            <Plus size={14} /> {t('rtAggiungiScaglione')}
                        </button>
                    </div>
                )}
            </section>

            {/* ── Pro-rata iscrizione ── */}
            <section className={card}>
                <h3 className={h3}><CalendarClock size={16} /> {t('rtProRataTitolo')}</h3>
                <label className={checkboxRow}>
                    <input type="checkbox" className={checkbox} checked={pr.enabled} onChange={e => setPR({ enabled: e.target.checked })} />
                    <span className={checkboxLabel}>{t('rtApplicaProRata')}</span>
                </label>
                <p className={hint}>
                    {t('rtProRataHint')}
                </p>

                {pr.enabled && (
                    <div className="mt-4 space-y-3">
                        <div className="space-y-2">
                            {pr.scaglioni.map((s, i) => (
                                <div key={i} className="flex flex-wrap items-end gap-2">
                                    <div>
                                        <label htmlFor={`pr-day-${i}`} className={label}>{t('rtIscrittoDalGiorno')}</label>
                                        <input id={`pr-day-${i}`} type="number" min={1} max={31} value={Number.isFinite(s.dal_giorno) ? s.dal_giorno : ''}
                                            onChange={e => updP(i, 'dal_giorno', Math.min(31, Math.max(1, Math.trunc(Number(e.target.value) || 1))))}
                                            className={`${input} w-32`} />
                                    </div>
                                    <div>
                                        <label htmlFor={`pr-perc-${i}`} className={label}>{t('rtRettaDovutaPct')}</label>
                                        <input id={`pr-perc-${i}`} type="number" min={0} max={100} value={Number.isFinite(s.percentuale) ? s.percentuale : ''}
                                            onChange={e => updP(i, 'percentuale', Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                                            className={`${input} w-32`} />
                                    </div>
                                    <button type="button" onClick={() => delP(i)} className="mb-1.5 text-kidville-muted hover:text-kidville-error" aria-label={t('rtRimuoviScaglione')}>
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            ))}
                            {pr.scaglioni.length === 0 && <p className={hint}>{t('rtNessunoScaglione')}</p>}
                        </div>
                        <button type="button" onClick={addP} className="inline-flex items-center gap-1 rounded-pill border-2 border-kidville-line px-3 py-1.5 font-maven text-sm text-kidville-muted hover:border-kidville-green hover:text-kidville-green">
                            <Plus size={14} /> {t('rtAggiungiScaglione')}
                        </button>
                    </div>
                )}
            </section>

            {/* ── Anteprima ── */}
            <section className={card}>
                <h3 className={h3}><Sparkles size={16} /> {t('rtAnteprimaSconto')}</h3>
                <div className="flex flex-wrap items-end gap-3">
                    <div>
                        <label htmlFor="pv-importo" className={label}>{t('rtRettaEuro')}</label>
                        <input id="pv-importo" type="number" min={0} value={Number.isFinite(pvImporto) ? pvImporto : ''}
                            onChange={e => setPvImporto(Math.max(0, Number(e.target.value) || 0))} className={`${input} w-28`} />
                    </div>
                    <div>
                        <label htmlFor="pv-posizione" className={label}>{t('rtFiglioN')}</label>
                        <input id="pv-posizione" type="number" min={1} value={Number.isFinite(pvPosizione) ? pvPosizione : ''}
                            onChange={e => setPvPosizione(Math.max(1, Math.trunc(Number(e.target.value) || 1)))} className={`${input} w-24`} />
                    </div>
                    <div>
                        <label htmlFor="pv-giorno" className={label}>{t('rtIscrittoIlGiorno')}</label>
                        <input id="pv-giorno" type="number" min={1} max={31} value={Number.isFinite(pvGiorno) ? pvGiorno : ''}
                            onChange={e => setPvGiorno(Math.min(31, Math.max(1, Math.trunc(Number(e.target.value) || 1))))} className={`${input} w-28`} />
                    </div>
                </div>
                <div className="mt-4 rounded-card bg-kidville-cream p-4 space-y-1.5">
                    <div className="flex justify-between font-maven text-sm text-kidville-sub">
                        <span>{t('rtScontoFratelliRiga', { pos: pvPosizione })}</span><span className="font-bold text-kidville-green">{formatEuro(pvF)}</span>
                    </div>
                    <div className="flex justify-between font-maven text-sm text-kidville-sub">
                        <span>{t('rtProRataRiga', { giorno: pvGiorno })}</span><span className="font-bold text-kidville-green">{formatEuro(pvP)}</span>
                    </div>
                    <div className="flex justify-between border-t border-kidville-line pt-1.5 font-barlow font-black uppercase text-sm text-kidville-green">
                        <span>{t('rtScontoTotale')}</span><span>{formatEuro(pvTot.sconto)}</span>
                    </div>
                    <div className="flex justify-between font-maven text-sm text-kidville-sub">
                        <span>{t('rtRettaDaPagare')}</span><span className="font-bold text-kidville-green">{formatEuro(residuo)}</span>
                    </div>
                    {pvTot.motivo && <p className="font-maven text-[11px] text-kidville-muted pt-1">{t('rtMotivoPrefix')} {pvTot.motivo}</p>}
                </div>
                <p className={hint}>{t('rtAnteprimaHint')}</p>
            </section>

            <SaveRow onSave={save} saving={saving} msg={msg} error={error} />
        </div>
    );
}
