'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Tag, Euro, AlertTriangle, Ticket, FileText, Plus, Trash2, Save, Lock, BellRing, Receipt } from 'lucide-react';
import { livelliEffettivi, type LivelloSollecito, type SollecitiConfig } from '@/lib/pagamenti/solleciti';
import {
    CEDENTE_COOPERATIVA, LUNGHEZZE_CEDENTE, cedenteCompleto, validaCedente,
    type AnagraficaCedente, type CampoCedente,
} from '@/lib/fatturazione/cedente';
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
}
interface ArubaCfg {
    username: string; password_ref: string; has_password: boolean; abilitato: boolean; ambiente: string;
    /**
     * Anagrafica fiscale STORICA, letta ma non più modificata da qui: la fonte è
     * `fiscale_config` (pannello «Dati fiscali»). Resta nel tipo perché la riga
     * in `admin_settings` esiste già per Giugliano e fa ancora da ripiego.
     */
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

interface FiscaleCfg extends AnagraficaCedente {
    bollo_enabled?: boolean; bollo_soglia?: number; bollo_importo?: number;
    dicitura_bollo_ricevuta?: string;
}

/**
 * Etichetta i18n e larghezza di ogni campo dell'anagrafica del cedente.
 *
 * ⚠️ `maxLength` NON si scrive a mano dove il tracciato ha già un limite: qui
 * c'era `numero_civico: 10` mentre `<NumeroCivico>` è di **8** caratteri
 * (`LIMITI.numeroCivico`, `NumeroCivicoType` dello XSD). Il campo invitava a
 * scriverne dieci, e `27/B int.3` finiva nell'XML come `27/B int` — tagliato dal
 * `.slice()` del generatore, senza un errore e senza un log. Ora il limite si
 * legge da `LUNGHEZZE_CEDENTE`, che a sua volta legge `LIMITI`: due copie dello
 * stesso numero divergono, e quando divergono vince quella che tronca.
 *
 * Denominazione, indirizzo e comune restano SENZA `maxLength` di proposito: i
 * loro limiti (80 e 60) si superano solo incollando, e un incollato tagliato di
 * nascosto dal browser è lo stesso difetto un passo più in là. Su quei tre parla
 * `validaCedente`, che dice quanti caratteri sono ammessi e blocca il salvataggio.
 */
const CAMPI_FISCALI: { chiave: CampoCedente; etichetta: string; classe: string; maxLength?: number }[] = [
    { chiave: 'denominazione', etichetta: 'spFiscaleDenominazione', classe: 'col-span-2 md:col-span-3' },
    { chiave: 'piva', etichetta: 'spFiscalePiva', classe: '', maxLength: 11 },
    { chiave: 'codice_fiscale', etichetta: 'spFiscaleCf', classe: '', maxLength: 16 },
    { chiave: 'regime_fiscale', etichetta: 'spFiscaleRegime', classe: '', maxLength: 4 },
    { chiave: 'indirizzo', etichetta: 'spFiscaleIndirizzo', classe: 'col-span-2' },
    { chiave: 'numero_civico', etichetta: 'spFiscaleNumeroCivico', classe: '', maxLength: LUNGHEZZE_CEDENTE.numero_civico },
    { chiave: 'cap', etichetta: 'spFiscaleCap', classe: '', maxLength: 5 },
    { chiave: 'comune', etichetta: 'spFiscaleComune', classe: '' },
    { chiave: 'provincia', etichetta: 'spFiscaleProvincia', classe: '', maxLength: 2 },
    // L'email finisce in `<Contatti><Email>` del CedentePrestatore: sulle fatture
    // che la segreteria scrive a mano c'è sempre (misurato il 2026-08-10 sui
    // tracciati veri), e finché questo campo non esisteva nessuna fattura emessa
    // dal software poteva averla. È FACOLTATIVA per il tracciato: se resta vuota
    // il documento parte lo stesso, e l'emissione scrive un `warn` che dice che
    // uscirà diverso dagli altri della stessa serie.
    { chiave: 'email', etichetta: 'spFiscaleEmail', classe: 'col-span-2', maxLength: LUNGHEZZE_CEDENTE.email },
];

/** Il messaggio d'errore del singolo campo: cosa manca, o che forma deve avere. */
const ERRORE_FORMATO: Partial<Record<CampoCedente, string>> = {
    piva: 'spFiscaleErrPiva',
    codice_fiscale: 'spFiscaleErrCf',
    cap: 'spFiscaleErrCap',
    provincia: 'spFiscaleErrProvincia',
    regime_fiscale: 'spFiscaleErrRegime',
    email: 'spFiscaleErrEmail',
};

/**
 * Anagrafica del CEDENTE (chi emette) + marca da bollo.
 *
 * ⚠️ QUESTO PANNELLO È LA FONTE UNICA di P.IVA, codice fiscale e sede legale:
 * ricevute e attestazioni la leggono da qui, e da qui la legge il
 * `CedentePrestatore` della fattura elettronica. Fino al 2026-08-09 la sede
 * legale si scriveva invece nel pannello Aruba come UNA stringa libera, mentre
 * l'XML cercava CAP e comune separati: usciva `<CAP></CAP><Comune></Comune>` e lo
 * SDI scartava il documento. Per questo i campi qui sono separati e validati con
 * le STESSE regole del server (`validaCedente`), e per questo il pannello Aruba
 * non li raccoglie più.
 */
function FiscaleSettings({ userId, scuolaId }: Props) {
    const t = useTranslations('adminSettings');
    const [cfg, setCfg] = useState<FiscaleCfg | null>(null);
    // Vero quando i campi a schermo sono il PRECOMPILATO e non ciò che è salvato:
    // il pannello deve dirlo, altrimenti «sembra configurato» e la fattura non parte.
    const [precompilato, setPrecompilato] = useState(false);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
            .then(r => r.json())
            .then(d => {
                if (!d.success) {
                    // Il pannello si mostra comunque (vuoto) invece di sparire: un
                    // riquadro che non c'è non si distingue da uno che non serve.
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'settings-fiscale-non-caricato', route: '/admin/impostazioni' });
                }
                const salvata = ((d.success ? (d.data.fiscale_config as FiscaleCfg) : null) ?? {}) as FiscaleCfg;
                // Anagrafica mai compilata ⇒ si propongono i dati della cooperativa,
                // che sono quelli delle fatture già emesse. Si guarda denominazione e
                // P.IVA e non il resto: un campo mancante dentro un'anagrafica ALTRUI
                // non si "completa" con i dati nostri — mescolarle darebbe il CAP di
                // Cesa a una ragione sociale diversa. O si propone tutto, o niente.
                // Le impostazioni del bollo non si toccano: restano come sono.
                const vuota = !cedenteCompleto(salvata) && !salvata.denominazione && !salvata.piva;
                setPrecompilato(vuota);
                setCfg(vuota ? { ...salvata, ...CEDENTE_COOPERATIVA } : salvata);
            })
            .catch(err => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-fiscale-non-caricato: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
                setCfg({});
            });
    }, [userId, scuolaId]);
    if (!cfg) return null;
    const set = (k: keyof FiscaleCfg, v: unknown) => setCfg({ ...cfg, [k]: v });
    const errori = validaCedente(cfg);
    const invalido = Object.keys(errori).length > 0;
    const save = async () => {
        // Stessa validazione del server: una sede senza CAP non deve nemmeno
        // partire, così l'operatore vede QUALE campo, non un 500 generico.
        if (invalido) { setErrore(t('spFiscaleCorreggi')); return; }
        setSaving(true);
        const esito = await mutaConEsito(
            '/api/admin/settings',
            { method: 'PATCH', headers: hdr(userId), body: JSON.stringify({ scuola_id: scuolaId, fiscale_config: cfg }) },
            t('erroreSalvataggio'), 'settings-fiscale-respinto',
        );
        setErrore(esito);
        // L'avviso «non è ancora salvato» sparisce solo quando il salvataggio è
        // andato: finché il server dice di no, quei campi restano una proposta.
        if (!esito) setPrecompilato(false);
        setSaving(false);
    };
    return (
        <section className={card}>
            <h3 className={h3}><FileText size={16} /> {t('spDatiFiscali')}</h3>
            <p className="font-maven text-[11px] text-kidville-sub -mt-2 mb-3">
                {t('spFiscaleDesc')}
            </p>
            {precompilato && (
                <p className="mb-3 rounded-2xl bg-kidville-warn-soft px-3 py-2 font-maven text-[11px] text-kidville-warn">
                    {t('spFiscalePrecompilato')}
                </p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {CAMPI_FISCALI.map(({ chiave, etichetta, classe, maxLength }) => {
                    const motivo = errori[chiave];
                    const idErrore = `fiscale-${chiave}-errore`;
                    return (
                        <div key={chiave} className={classe}>
                            <label className={label} htmlFor={`fiscale-${chiave}`}>{t(etichetta)}</label>
                            <input
                                id={`fiscale-${chiave}`}
                                value={(cfg[chiave] as string) ?? ''}
                                maxLength={maxLength}
                                aria-invalid={motivo !== undefined}
                                aria-describedby={motivo ? idErrore : undefined}
                                onChange={e => set(chiave, e.target.value)}
                                className={`${input} w-full ${motivo ? 'border-kidville-error' : ''}`}
                            />
                            {motivo && (
                                <p id={idErrore} className="font-maven text-[10px] text-kidville-error-strong mt-0.5">
                                    {motivo === 'mancante'
                                        ? t('spFiscaleErrObbligatorio')
                                        // «Troppo lungo» dice il numero, perché è quello che serve
                                        // per correggere: senza, l'operatore accorcia a caso.
                                        : motivo === 'lungo'
                                            ? t('spFiscaleErrTroppoLungo', { max: LUNGHEZZE_CEDENTE[chiave] ?? 0 })
                                            : t(ERRORE_FORMATO[chiave] ?? 'spFiscaleErrObbligatorio')}
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="mt-4 rounded-xl border-2 border-kidville-line p-3">
                <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!cfg.bollo_enabled} onChange={e => set('bollo_enabled', e.target.checked)} className="mt-0.5 w-4 h-4 rounded accent-kidville-green" />
                    <span className="font-maven text-sm text-kidville-green">{t('spBolloAttiva')}</span>
                </label>
                <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('spBolloHint')}</p>
                {/* Soglia, importo e dicitura: i tre valori che il codice CONSUMA davvero
                    (`bolloDovuto` e la dicitura sulle ricevute). Qui c'era anche una casella
                    «Riaddebita il bollo al cliente» che prometteva «il totale cresce di 2 €» e
                    non era collegata a niente: nessuna riga in più, `ImportoTotaleDocumento`
                    invariato. È stata tolta — il perché, e cosa servirebbe per farla davvero,
                    sta in `@/lib/pagamenti/fiscale`. In questo pannello si mostra solo ciò che
                    ha un effetto. */}
                {cfg.bollo_enabled && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                        <div><label className={label} htmlFor="bollo-soglia">{t('spBolloSoglia')}</label>
                            <input id="bollo-soglia" type="number" step="0.01" value={cfg.bollo_soglia ?? 77.47} onChange={e => set('bollo_soglia', Number(e.target.value))} className={`${input} w-full`} /></div>
                        <div><label className={label} htmlFor="bollo-importo">{t('spBolloImporto')}</label>
                            <input id="bollo-importo" type="number" step="0.01" value={cfg.bollo_importo ?? 2} onChange={e => set('bollo_importo', Number(e.target.value))} className={`${input} w-full`} /></div>
                        <div className="col-span-2 md:col-span-1"><label className={label} htmlFor="bollo-dicitura">{t('spBolloDicitura')}</label>
                            <input id="bollo-dicitura" value={cfg.dicitura_bollo_ricevuta ?? ''} placeholder={t('spBolloDicituraPlaceholder')} onChange={e => set('dicitura_bollo_ricevuta', e.target.value)} className={`${input} w-full`} /></div>
                    </div>
                )}
            </div>
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
                            <button onClick={() => del(c.id)} aria-label={t('spEliminaCategoria')} className="text-kidville-sub hover:text-kidville-error"><Trash2 size={13} /></button>}
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
            {/*
                Qui c'era un campo «Causale fattura (template)»: uno solo per tutta la
                scuola, salvato davvero in `admin_settings.fattura_causale_template` e poi
                SCARTATO dall'emissione. Chi lo compilava riceveva la conferma di
                salvataggio e otteneva una fattura con la causale di fabbrica — nessun
                errore, nessun log, su un documento fiscale che si corregge solo con una
                nota di variazione. I due segnaposto che suggeriva, `{'{alunno}'}` e
                `{'{periodo}'}`, non sono mai esistiti nel motore.
                Ora la causale della fattura si configura per TIPOLOGIA DI PAGAMENTO in
                Contabilità → Causali, dove il valore scritto è quello che viene emesso.
                Resta il rimando, perché è qui che la segreteria la cercava.
            */}
            <div className="mt-4 rounded-2xl bg-kidville-cream px-3 py-2.5">
                <p className="font-maven text-[12px] text-kidville-sub">
                    <Receipt size={13} className="mr-1 inline align-[-2px]" aria-hidden /> {t('spCausaleFatturaSpostata')}{' '}
                    <Link
                        href={`/admin/pagamenti?userId=${encodeURIComponent(userId)}&vista=causali`}
                        className="font-semibold text-kidville-green underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-kidville-green"
                    >
                        {t('spCausaleFatturaVaiAlPannello')}
                    </Link>
                </p>
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
                        <button onClick={() => setPacchetti(pacchetti.filter((_, idx) => idx !== i))} aria-label={t('spRimuoviPacchetto')} className="text-kidville-sub hover:text-kidville-error"><Trash2 size={15} /></button>
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

/**
 * Credenziali e AMBIENTE del canale Aruba — e nient'altro.
 *
 * L'anagrafica del cedente (P.IVA, codice fiscale, ragione sociale, sede legale,
 * regime) NON si raccoglie più qui: viveva in questo pannello come stringa libera
 * `fiscal.sede` mentre il generatore dell'XML leggeva CAP e comune separati, e il
 * risultato era `<CAP></CAP><Comune></Comune>` — scarto SDI. La fonte unica è
 * `fiscale_config`, nel pannello «Dati fiscali & bollo» qui sopra.
 *
 * `fiscal` non viene più inviato nel PATCH: la route aggiorna la chiave solo se
 * la riceve, quindi ciò che una sede aveva già configurato resta dov'è e continua
 * a fare da ripiego. Toglierlo dall'interfaccia non doveva cancellarlo dal database.
 */
function ArubaSettings({ userId, scuolaId }: Props) {
    const t = useTranslations('adminSettings');
    const [cfg, setCfg] = useState<ArubaCfg | null>(null);
    const [saving, setSaving] = useState(false);
    const [errore, setErrore] = useState('');
    const [pwd, setPwd] = useState('');
    useEffect(() => {
        fetch(`/api/admin/settings/aruba?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setCfg(d.data); })
            .catch(err => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-aruba-non-caricato: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
            });
    }, [userId, scuolaId]);
    if (!cfg) return null;
    const save = async () => {
        setSaving(true);
        setErrore('');
        const body: Record<string, unknown> = {
            scuola_id: scuolaId, username: cfg.username, abilitato: cfg.abilitato, ambiente: cfg.ambiente,
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
    return (
        <section className={card}>
            <h3 className={h3}><FileText size={16} /> {t('spArubaTitolo')}</h3>
            <p className="font-maven text-xs text-kidville-sub mb-3">{t('spArubaDesc')}</p>
            <div className="grid grid-cols-2 gap-3">
                <div><label className={label} htmlFor="aruba-username">{t('spArubaUsername')}</label><input id="aruba-username" value={cfg.username} onChange={e => setCfg({ ...cfg, username: e.target.value })} className={`${input} w-full`} /></div>
                <div><label className={label} htmlFor="aruba-password">{t('spArubaPassword')}{cfg.has_password && t('spArubaPasswordImpostata')}</label><input id="aruba-password" type="password" value={pwd} onChange={e => setPwd(e.target.value)} placeholder={cfg.has_password ? '••••••' : t('spArubaPasswordPlaceholder')} className={`${input} w-full`} /></div>
                <div><label className={label} htmlFor="aruba-ambiente">{t('spArubaAmbiente')}</label>
                    <select id="aruba-ambiente" value={cfg.ambiente === 'production' ? 'production' : 'sandbox'} onChange={e => setCfg({ ...cfg, ambiente: e.target.value })} className={`${input} w-full`}>
                        <option value="sandbox">{t('spArubaAmbienteDemo')}</option>
                        <option value="production">{t('spArubaAmbienteProduzione')}</option>
                    </select>
                    <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('spArubaAmbienteHint')}</p>
                </div>
            </div>
            <p className="font-maven text-[11px] text-kidville-sub mt-3">{t('spArubaRimandoDatiFiscali')}</p>
            <label className="flex items-center gap-2 cursor-pointer mt-3">
                <input type="checkbox" checked={cfg.abilitato} onChange={e => setCfg({ ...cfg, abilitato: e.target.checked })} className="w-4 h-4 rounded accent-kidville-green" />
                <span className="font-maven text-sm text-kidville-green">{t('spArubaAbilita')}</span>
            </label>
            <div className="mt-4"><button onClick={save} disabled={saving} className={btnPrimary}><Save size={14} /> {saving ? t('salvataggioInCorso') : t('salva')}</button></div>
            <ErroreBox testo={errore} />
        </section>
    );
}
