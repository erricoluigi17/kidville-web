'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Tag, Euro, AlertTriangle, Ticket, FileText, Plus, Trash2, Save, Lock, BellRing } from 'lucide-react';
import { livelliEffettivi, type LivelloSollecito, type SollecitiConfig } from '@/lib/pagamenti/solleciti';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { hdr, card, h3, input, label, btnPrimary } from './ui';

interface Props { userId: string; scuolaId: string }

/**
 * Banda d'errore di un pannello.
 *
 * Fino al 2026-07-31 questi pannelli non avevano NIENTE del genere: `save()`
 * faceva `await fetch(...)` e scartava la risposta. Un 403 di sede o il 400
 * «Specificare la sede» spegneva lo spinner e basta — indistinguibile da un
 * salvataggio riuscito. È la stessa cecità che per mesi ha nascosto le email
 * non consegnate, vista dal lato dell'interfaccia.
 */
function ErroreBox({ testo }: { testo: string }) {
    if (!testo) return null;
    return (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error-strong">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} />
            <span>{testo}</span>
        </div>
    );
}

/**
 * Esegue una mutazione e RIPORTA l'esito: `''` = riuscita, altrimenti il
 * messaggio da mostrare. Un rifiuto viene sempre anche loggato — lo `stato` è un
 * numero (lista bianca di `redact`) ed è l'unica cosa che, letta dai log,
 * distingue «sede ambigua» (400) da «sede non tua» (403) da «guasto» (500).
 * Il corpo NON si logga: può contenere il nome di una categoria o di una classe.
 */
async function mutaConEsito(
    url: string, init: RequestInit, fallback: string, evento: string,
): Promise<string> {
    try {
        const res = await fetch(url, init);
        if (!res.ok) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: evento, route: '/admin/impostazioni', stato: res.status });
            return await messaggioErrore(res, fallback);
        }
        return '';
    } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
        return fallback;
    }
}

interface Categoria { id: string; nome: string; slug?: string; colore?: string; icona?: string; is_sistema: boolean; ordine: number }
interface Settings {
    retta_default_importo: number; retta_giorno_scadenza: number; retta_giorno_visibilita: number;
    retta_auto_enabled: boolean; insoluto_tolleranza_giorni: number;
    ticket_pacchetti: { label: string; pezzi: number; costo: number }[];
    fattura_causale_template: string;
}
interface ArubaCfg {
    username: string; password_ref: string; has_password: boolean; abilitato: boolean; ambiente: string;
    fiscal: { piva?: string; cf?: string; ragione_sociale?: string; sede?: string; regime?: string };
    iva: { causale: string; aliquota: number; natura?: string }[];
}

export function SettingsPanel({ userId, scuolaId }: Props) {
    return (
        <div>
            <CategorieManager userId={userId} scuolaId={scuolaId} />
            <RettaMorositaSettings userId={userId} scuolaId={scuolaId} />
            <FiscaleSettings userId={userId} scuolaId={scuolaId} />
            <SollecitiSettings userId={userId} scuolaId={scuolaId} />
            <TicketSettings userId={userId} scuolaId={scuolaId} />
            <ArubaSettings userId={userId} scuolaId={scuolaId} />
        </div>
    );
}

// Template e cadenza dei solleciti: 3 livelli, testi con segnaposto. L'invio
// automatico resta OFF finché non attivato (il run cron salta la scuola).
function SollecitiSettings({ userId }: Props) {
    const t = useTranslations('adminSettings');
    const [cfg, setCfg] = useState<SollecitiConfig | null>(null);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json())
            .then(d => { if (d.success) setCfg((d.data.solleciti_config as SollecitiConfig) ?? {}); })
            .catch(() => setCfg({}));
    }, [userId]);
    if (!cfg) return null;
    const livelli = livelliEffettivi(cfg);
    const setLivello = (i: number, patch: Partial<LivelloSollecito>) => {
        const next = livelli.map((l, j) => (j === i ? { ...l, ...patch } : l));
        setCfg({ ...cfg, livelli: next });
    };
    const save = async () => {
        setSaving(true);
        setErrore(await mutaConEsito(
            '/api/admin/settings',
            { method: 'PATCH', headers: hdr(userId), body: JSON.stringify({ solleciti_config: { ...cfg, livelli } }) },
            t('erroreSalvataggio'), 'settings-solleciti-respinto',
        ));
        setSaving(false);
    };
    return (
        <section className={card}>
            <h3 className={h3}><BellRing size={16} /> {t('spSolleciti')}</h3>
            <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!cfg.enabled} onChange={e => setCfg({ ...cfg, enabled: e.target.checked })} className="w-4 h-4 rounded text-kidville-green" />
                    <span className="font-maven text-sm text-kidville-green">{t('spSollecitiCronAttivo')}</span>
                </label>
                <div className="flex items-center gap-2">
                    <span className="font-maven text-xs text-kidville-sub">{t('spSollecitiCadenza')}</span>
                    <input type="number" min={1} value={cfg.cadenza_min_giorni ?? 7}
                        onChange={e => setCfg({ ...cfg, cadenza_min_giorni: Math.max(1, Number(e.target.value) || 1) })}
                        className={`${input} w-16`} />
                </div>
            </div>
            <p className="font-maven text-[11px] text-kidville-sub mt-2">
                {t('spSegnaposto')} {'{alunno}'} {'{descrizione}'} {'{importo}'} {'{residuo}'} {'{scadenza}'} {'{scuola}'} {'{giorni_ritardo}'}
            </p>
            <div className="mt-3 space-y-4">
                {livelli.map((l, i) => (
                    <div key={i} className="rounded-xl border-2 border-kidville-line p-3">
                        <div className="flex flex-wrap items-center gap-3 mb-2">
                            <span className="font-barlow text-xs font-extrabold uppercase text-kidville-green">{t('spLivello', { n: i + 1 })}</span>
                            <span className="flex items-center gap-1.5 font-maven text-xs text-kidville-sub">
                                {t('spDopo')}
                                <input type="number" min={0} value={l.giorni_da_scadenza}
                                    onChange={e => setLivello(i, { giorni_da_scadenza: Math.max(0, Number(e.target.value) || 0) })}
                                    className={`${input} w-16`} />
                                {t('spGiorniDallaScadenza')}
                            </span>
                        </div>
                        <input value={l.oggetto} onChange={e => setLivello(i, { oggetto: e.target.value })}
                            placeholder={t('spOggettoEmail')} className={`${input} w-full mb-2`} />
                        <textarea value={l.testo} onChange={e => setLivello(i, { testo: e.target.value })} rows={3}
                            className={`${input} w-full`} />
                    </div>
                ))}
            </div>
            <div className="mt-4"><button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? t('salvataggioInCorso') : t('salva')}</button></div>
            <ErroreBox testo={errore} />
        </section>
    );
}

interface FiscaleCfg {
    denominazione?: string; piva?: string; codice_fiscale?: string;
    indirizzo?: string; cap?: string; comune?: string; provincia?: string;
    bollo_enabled?: boolean; bollo_soglia?: number; bollo_importo?: number;
    dicitura_bollo_ricevuta?: string;
}

// Dati struttura per ricevute/attestazioni (fallback: dati fiscali Aruba) e
// marca da bollo sui documenti esenti IVA sopra soglia.
function FiscaleSettings({ userId }: Props) {
    const t = useTranslations('adminSettings');
    const [cfg, setCfg] = useState<FiscaleCfg | null>(null);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json())
            .then(d => { if (d.success) setCfg((d.data.fiscale_config as FiscaleCfg) ?? {}); })
            .catch(() => setCfg({}));
    }, [userId]);
    if (!cfg) return null;
    const set = (k: keyof FiscaleCfg, v: unknown) => setCfg({ ...cfg, [k]: v });
    const save = async () => {
        setSaving(true);
        setErrore(await mutaConEsito(
            '/api/admin/settings',
            { method: 'PATCH', headers: hdr(userId), body: JSON.stringify({ fiscale_config: cfg }) },
            t('erroreSalvataggio'), 'settings-fiscale-respinto',
        ));
        setSaving(false);
    };
    const campi: [keyof FiscaleCfg, string][] = [
        ['denominazione', 'spFiscaleDenominazione'], ['piva', 'spFiscalePiva'], ['codice_fiscale', 'spFiscaleCf'],
        ['indirizzo', 'spFiscaleIndirizzo'], ['cap', 'spFiscaleCap'], ['comune', 'spFiscaleComune'], ['provincia', 'spFiscaleProvincia'],
    ];
    return (
        <section className={card}>
            <h3 className={h3}><FileText size={16} /> {t('spDatiFiscali')}</h3>
            <p className="font-maven text-[11px] text-kidville-sub -mt-2 mb-3">
                {t('spFiscaleDesc')}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {campi.map(([k, lk]) => (
                    <div key={k}><label className={label}>{t(lk)}</label>
                        <input value={(cfg[k] as string) ?? ''} onChange={e => set(k, e.target.value)} className={`${input} w-full`} /></div>
                ))}
            </div>
            <label className="flex items-center gap-2 cursor-pointer mt-4">
                <input type="checkbox" checked={!!cfg.bollo_enabled} onChange={e => set('bollo_enabled', e.target.checked)} className="w-4 h-4 rounded text-kidville-green" />
                <span className="font-maven text-sm text-kidville-green">{t('spBolloAttiva')}</span>
            </label>
            {cfg.bollo_enabled && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                    <div><label className={label}>{t('spBolloSoglia')}</label>
                        <input type="number" step="0.01" value={cfg.bollo_soglia ?? 77.47} onChange={e => set('bollo_soglia', Number(e.target.value))} className={`${input} w-full`} /></div>
                    <div><label className={label}>{t('spBolloImporto')}</label>
                        <input type="number" step="0.01" value={cfg.bollo_importo ?? 2} onChange={e => set('bollo_importo', Number(e.target.value))} className={`${input} w-full`} /></div>
                    <div className="col-span-2 md:col-span-1"><label className={label}>{t('spBolloDicitura')}</label>
                        <input value={cfg.dicitura_bollo_ricevuta ?? ''} placeholder={t('spBolloDicituraPlaceholder')} onChange={e => set('dicitura_bollo_ricevuta', e.target.value)} className={`${input} w-full`} /></div>
                </div>
            )}
            <div className="mt-4"><button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? t('salvataggioInCorso') : t('salva')}</button></div>
            <ErroreBox testo={errore} />
        </section>
    );
}

function CategorieManager({ userId }: Props) {
    const t = useTranslations('adminSettings');
    const [cats, setCats] = useState<Categoria[]>([]);
    const [nuovo, setNuovo] = useState('');
    const [errore, setErrore] = useState('');
    const load = useCallback(() => {
        fetch(`/api/admin/settings/categorie?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setCats(d.data); })
            .catch(err => {
                // Un catch che non logga è un bug: senza questa riga «non ci
                // sono categorie» e «la lettura è morta» sono la stessa cosa.
                logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-categorie-non-caricate: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
                setErrore(t('erroreCaricamentoDati'));
            });
    }, [userId, t]);
    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!nuovo.trim()) return;
        const err = await mutaConEsito(
            '/api/admin/settings/categorie',
            { method: 'POST', headers: hdr(userId), body: JSON.stringify({ nome: nuovo.trim() }) },
            t('erroreSalvataggio'), 'settings-categoria-nuova-respinta',
        );
        setErrore(err);
        // Il testo NON si azzera quando il server ha detto di no: cancellarlo
        // costringerebbe a riscriverlo per riprovare.
        if (!err) setNuovo('');
        load();
    };
    const del = async (id: string) => {
        setErrore(await mutaConEsito(
            `/api/admin/settings/categorie?userId=${userId}&id=${id}`,
            { method: 'DELETE', headers: hdr(userId) },
            t('erroreSalvataggio'), 'settings-categoria-elimina-respinta',
        ));
        load();
    };

    return (
        <section className={card}>
            <h3 className={h3}><Tag size={16} /> {t('spCategorie')}</h3>
            <div className="flex flex-wrap gap-2 mb-3">
                {cats.map(c => (
                    <span key={c.id} className="flex items-center gap-1 bg-kidville-cream rounded-full pl-3 pr-2 py-1 font-maven text-sm text-kidville-green">
                        {c.icona} {c.nome}
                        {c.is_sistema ? <Lock size={11} className="text-kidville-sub" /> :
                            <button onClick={() => del(c.id)} className="text-kidville-sub hover:text-kidville-error"><Trash2 size={13} /></button>}
                    </span>
                ))}
            </div>
            <div className="flex gap-2">
                <input value={nuovo} onChange={e => setNuovo(e.target.value)} placeholder={t('nuovaCategoriaPlaceholder')} className={`${input} flex-1`} />
                <button onClick={add} className={btnPrimary}><Plus size={14} /> {t('aggiungi')}</button>
            </div>
            <p className="font-maven text-[11px] text-kidville-sub mt-2"><Lock size={10} className="inline" />{t('spCategoriaSistemaHint')}</p>
            <ErroreBox testo={errore} />
        </section>
    );
}

function RettaMorositaSettings({ userId }: Props) {
    const t = useTranslations('adminSettings');
    const [s, setS] = useState<Settings | null>(null);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setS(d.data); })
            .catch(err => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-retta-non-caricate: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
            });
    }, [userId]);
    if (!s) return null;
    const save = async () => {
        setSaving(true);
        setErrore(await mutaConEsito(
            '/api/admin/settings',
            {
                method: 'PATCH', headers: hdr(userId), body: JSON.stringify({
                    retta_default_importo: s.retta_default_importo, retta_giorno_scadenza: s.retta_giorno_scadenza,
                    retta_giorno_visibilita: s.retta_giorno_visibilita,
                    retta_auto_enabled: s.retta_auto_enabled, insoluto_tolleranza_giorni: s.insoluto_tolleranza_giorni,
                    fattura_causale_template: s.fattura_causale_template,
                }),
            },
            t('erroreSalvataggio'), 'settings-retta-respinto',
        ));
        setSaving(false);
    };
    return (
        <section className={card}>
            <h3 className={h3}><Euro size={16} /> {t('spRettaMorosita')}</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div><label className={label}>{t('spRettaDefault')}</label>
                    <input type="number" value={s.retta_default_importo || ''} onChange={e => setS({ ...s, retta_default_importo: Number(e.target.value) })} className={`${input} w-full`} /></div>
                <div><label className={label}>{t('spGiornoScadenza')}</label>
                    <input type="number" min={1} max={28} value={s.retta_giorno_scadenza} onChange={e => setS({ ...s, retta_giorno_scadenza: Number(e.target.value) })} className={`${input} w-full`} />
                    <p className="font-maven text-[10px] text-kidville-sub mt-0.5">{t('spGiornoScadenzaHint')}</p></div>
                <div><label className={label}>{t('spVisibileDalGiorno')}</label>
                    <input type="number" min={1} max={28} value={s.retta_giorno_visibilita ?? 25} onChange={e => setS({ ...s, retta_giorno_visibilita: Number(e.target.value) })} className={`${input} w-full`} /></div>
                <div><label className={label}><AlertTriangle size={11} className="inline" /> {t('spTolleranzaInsoluti')}</label>
                    <input type="number" value={s.insoluto_tolleranza_giorni} onChange={e => setS({ ...s, insoluto_tolleranza_giorni: Number(e.target.value) })} className={`${input} w-full`} /></div>
            </div>
            <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('spRettaVisibilitaHint')}</p>
            <label className="flex items-center gap-2 cursor-pointer mt-3">
                <input type="checkbox" checked={s.retta_auto_enabled} onChange={e => setS({ ...s, retta_auto_enabled: e.target.checked })} className="w-4 h-4 rounded text-kidville-green" />
                <span className="font-maven text-sm text-kidville-green">{t('spRettaAutoGen')}</span>
            </label>
            <div className="mt-4">
                <label className={label}>{t('spCausaleFattura')}</label>
                <input value={s.fattura_causale_template ?? ''} onChange={e => setS({ ...s, fattura_causale_template: e.target.value })}
                    placeholder="{descrizione} - {alunno}" className={`${input} w-full`} />
                <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('spCausaleSegnaposto')} {'{descrizione}'}, {'{alunno}'}, {'{periodo}'}. {t('spCausaleModificabile')}</p>
            </div>
            <div className="mt-4"><button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? t('salvataggioInCorso') : t('salva')}</button></div>
            <ErroreBox testo={errore} />
        </section>
    );
}

function TicketSettings({ userId }: Props) {
    const t = useTranslations('adminSettings');
    const [pacchetti, setPacchetti] = useState<{ label: string; pezzi: number; costo: number }[]>([]);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setPacchetti(d.data.ticket_pacchetti || []); })
            .catch(err => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-ticket-non-caricati: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
            });
    }, [userId]);
    const save = async () => {
        setSaving(true);
        setErrore(await mutaConEsito(
            '/api/admin/settings',
            { method: 'PATCH', headers: hdr(userId), body: JSON.stringify({ ticket_pacchetti: pacchetti }) },
            t('erroreSalvataggio'), 'settings-ticket-respinto',
        ));
        setSaving(false);
    };
    const upd = (i: number, k: string, v: string | number) => setPacchetti(pacchetti.map((p, idx) => idx === i ? { ...p, [k]: v } : p));
    return (
        <section className={card}>
            <h3 className={h3}><Ticket size={16} /> {t('spTicketPacchetti')}</h3>
            <div className="space-y-2 mb-3">
                {pacchetti.map((p, i) => (
                    <div key={i} className="flex gap-2 items-center">
                        <input value={p.label} onChange={e => upd(i, 'label', e.target.value)} placeholder={t('spTicketNome')} className={`${input} flex-1`} />
                        <input type="number" value={p.pezzi || ''} onChange={e => upd(i, 'pezzi', Number(e.target.value))} placeholder={t('spTicketPezzi')} className={`${input} w-24`} />
                        <input type="number" value={p.costo || ''} onChange={e => upd(i, 'costo', Number(e.target.value))} placeholder="€" className={`${input} w-24`} />
                        <button onClick={() => setPacchetti(pacchetti.filter((_, idx) => idx !== i))} className="text-kidville-sub hover:text-kidville-error"><Trash2 size={15} /></button>
                    </div>
                ))}
            </div>
            <div className="flex gap-2">
                <button onClick={() => setPacchetti([...pacchetti, { label: '', pezzi: 10, costo: 50 }])} className="px-3 py-2 rounded-full border-2 border-kidville-line font-maven text-sm text-kidville-sub flex items-center gap-1"><Plus size={14} /> {t('spTicketAggiungiPacchetto')}</button>
                <button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? '…' : t('salva')}</button>
            </div>
            <ErroreBox testo={errore} />
        </section>
    );
}

function ArubaSettings({ userId }: Props) {
    const t = useTranslations('adminSettings');
    const [cfg, setCfg] = useState<ArubaCfg | null>(null);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState('');
    const [pwd, setPwd] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings/aruba?userId=${userId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setCfg(d.data); })
            .catch(err => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-aruba-non-caricato: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
            });
    }, [userId]);
    if (!cfg) return null;
    const save = async () => {
        setSaving(true);
        setErrore('');
        const body: Record<string, unknown> = {
            username: cfg.username, fiscal: cfg.fiscal, abilitato: cfg.abilitato, ambiente: cfg.ambiente,
        };
        if (pwd) body.password_ref = pwd;
        try {
            const res = await fetch('/api/admin/settings/aruba', { method: 'PATCH', headers: hdr(userId), body: JSON.stringify(body) });
            if (!res.ok) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'settings-aruba-respinto', route: '/admin/impostazioni', stato: res.status });
                setErrore(await messaggioErrore(res, t('erroreSalvataggio')));
            } else {
                const j = await res.json();
                if (j.success) { setCfg(j.data); setPwd(''); }
            }
        } catch (err) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-aruba-respinto: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
            setErrore(t('erroreRete'));
        }
        setSaving(false);
    };
    const f = cfg.fiscal || {};
    return (
        <section className={card}>
            <h3 className={h3}><FileText size={16} /> {t('spArubaTitolo')} <span className="text-[10px] bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 rounded-full">{t('spScaffold')}</span></h3>
            <p className="font-maven text-xs text-kidville-sub mb-3">{t('spArubaDesc')}</p>
            <div className="grid grid-cols-2 gap-3">
                <div><label className={label}>{t('spArubaUsername')}</label><input value={cfg.username} onChange={e => setCfg({ ...cfg, username: e.target.value })} className={`${input} w-full`} /></div>
                <div><label className={label}>{t('spArubaPassword')}{cfg.has_password && t('spArubaPasswordImpostata')}</label><input type="password" value={pwd} onChange={e => setPwd(e.target.value)} placeholder={cfg.has_password ? '••••••' : t('spArubaPasswordPlaceholder')} className={`${input} w-full`} /></div>
                <div><label className={label}>{t('spFiscalePiva')}</label><input value={f.piva ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, piva: e.target.value } })} className={`${input} w-full`} /></div>
                <div><label className={label}>{t('spArubaCf')}</label><input value={f.cf ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, cf: e.target.value } })} className={`${input} w-full`} /></div>
                <div className="col-span-2"><label className={label}>{t('spArubaRagioneSociale')}</label><input value={f.ragione_sociale ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, ragione_sociale: e.target.value } })} className={`${input} w-full`} /></div>
                <div><label className={label}>{t('spArubaSedeLegale')}</label><input value={f.sede ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, sede: e.target.value } })} className={`${input} w-full`} /></div>
                <div><label className={label}>{t('spArubaRegime')}</label><input value={f.regime ?? ''} onChange={e => setCfg({ ...cfg, fiscal: { ...f, regime: e.target.value } })} className={`${input} w-full`} /></div>
            </div>
            <label className="flex items-center gap-2 cursor-pointer mt-3">
                <input type="checkbox" checked={cfg.abilitato} onChange={e => setCfg({ ...cfg, abilitato: e.target.checked })} className="w-4 h-4 rounded text-kidville-green" />
                <span className="font-maven text-sm text-kidville-green">{t('spArubaAbilita')}</span>
            </label>
            <div className="mt-4"><button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? t('salvataggioInCorso') : t('salva')}</button></div>
            <ErroreBox testo={errore} />
        </section>
    );
}
