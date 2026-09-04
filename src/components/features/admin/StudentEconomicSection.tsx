'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Euro, Users2, FileText, Crown } from 'lucide-react';
import { formatEuro } from '@/lib/format/valuta';
import {
    CAMPI_CESSIONARIO,
    ETICHETTE_CAMPO_CESSIONARIO,
    validaCessionario,
    type ErroriCessionario,
} from '@/lib/fatturazione/cessionario';

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
/**
 * L'intestatario «Altro»: contratto condiviso con il backend, non una forma libera.
 *
 * ⚠️ Fino al 2026-09-04 qui c'erano quattro campi — `nome`, `cf`, `indirizzo`,
 * `email` — e **non bastavano per una fattura elettronica**: per un cessionario
 * persona fisica il tracciato pretende `CodiceFiscale`, `Nome`, `Cognome` e la
 * `Sede` completa (`Indirizzo`, `CAP`, `Comune`), tutti NON facoltativi. Mancavano
 * CAP e comune, e il **cognome**, che nel tracciato è un elemento distinto dal nome:
 * spaccare «Della Valle Ottavio» in due è esattamente la deduzione che questo repo
 * non fa (nome inventato: 0 riscontri su `alunni`, `parents` ed
 * `enrollment_submissions` — il repository è pubblico e un esempio si conta prima di
 * scriverlo). Chi compilava questa schermata usciva convinto di aver impostato un
 * intestatario, e il numero di fattura si sarebbe bruciato lo stesso
 * (`prossimo_numero_fattura_sezionale` scrive il contatore prima dell'upload).
 *
 * `email` resta ma è **fuori dal tracciato SdI**: serve a recapitare, non a
 * fatturare, ed è etichettata come tale perché nessuno la scambi per un dato che
 * completa l'intestatario.
 */
interface IntestatarioAltro {
    nome?: string;
    cognome?: string;
    cf?: string;
    indirizzo?: string;
    cap?: string;
    comune?: string;
    provincia?: string;
    civico?: string;
    email?: string;
}
interface Intestatario { tipo: 'adult' | 'altro'; adult_id?: string; nome?: string; dati?: IntestatarioAltro }

/**
 * Le caselle di «Altro», nell'ordine in cui si compilano. Quali siano obbligatorie
 * NON lo decide questa schermata: lo decide `validaCessionario`, la stessa funzione
 * che gira nell'anteprima e nell'emissione fail-closed. Una regola, tre posti.
 */
interface CampoAltro {
    chiave: keyof IntestatarioAltro;
    etichetta: string;
    /** Occupa entrambe le colonne della griglia. */
    largo?: boolean;
    /** Fuori da `CAMPI_CESSIONARIO`: la sua assenza non impedisce di fatturare. */
    facoltativo?: boolean;
}

const CAMPI_ALTRO: CampoAltro[] = [
    { chiave: 'nome', etichetta: 'econIntNome' },
    { chiave: 'cognome', etichetta: 'econIntCognome' },
    { chiave: 'cf', etichetta: 'econIntCf', largo: true },
    { chiave: 'indirizzo', etichetta: 'econIntIndirizzo', largo: true },
    { chiave: 'civico', etichetta: 'econIntCivico', facoltativo: true },
    { chiave: 'cap', etichetta: 'econIntCap' },
    { chiave: 'comune', etichetta: 'econIntComune' },
    { chiave: 'provincia', etichetta: 'econIntProvincia', facoltativo: true },
    { chiave: 'email', etichetta: 'econIntEmail', facoltativo: true, largo: true },
];

interface Tutore { adult_id: string; nome: string; cognome: string; email: string; percentuale: number | null; has_fiscal_code?: boolean }

interface ParentOption { id: string; nome: string; relazione: string }

/** Un fratello, come lo manda `GET /api/admin/students/[id]` (genitore condiviso). */
interface Fratello {
    id: string;
    nome: string;
    cognome: string;
    stato?: string;
    classe_sezione?: string | null;
    /** Valorizzato = la retta di QUESTO fratello la paga già qualcun altro. */
    retta_a_carico_di?: string | null;
    importo_retta_mensile?: number | null;
}

interface Props {
    alunnoId: string;
    form: Record<string, unknown>;
    updateForm: (field: string, value: unknown) => void;
    // opzioni intestatario derivate dagli adulti collegati (anagrafica parents)
    parents?: { relation_type: string; parents?: { id: string; first_name?: string; last_name?: string } }[];
    /**
     * I fratelli già caricati dalla scheda (`StudentDetailPanel`), non richiesti di
     * nuovo: la GET del dettaglio li calcola per genitore condiviso, con dedup.
     */
    siblings?: Fratello[];
}

const inputCls =
    'w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green';
/**
 * ⚠️ L'inchiostro delle etichette era `muted`, che **non raggiunge** i 4,5:1 che
 * WCAG 1.4.3 chiede per il testo; `sub` li raggiunge. I valori stanno in
 * `@theme inline` di `src/app/globals.css` e si leggono lì: copiarli qui vorrebbe
 * dire che questo commento diventa falso il giorno in cui il token cambia, ed è la
 * trappola che questo repo paga da anni. La misura vera la fa
 * `__tests__/a11y/contrasto-token.test.ts`.
 *
 * Cambiare il token QUI, invece di affiancare una costante nuova per le sole caselle
 * dell'intestatario, è ciò che tiene le etichette della sezione uniformi: altrimenti
 * «Importo retta mensile» resterebbe grigio chiaro accanto a «Nome» scuro, un metro
 * diverso per lo stesso tipo di testo nella stessa schermata.
 *
 * E il lock `testo-muted-allowlist` da solo non avrebbe protetto qui: conta le
 * occorrenze **testuali** della classe nel file, quindi delle etichette scritte
 * passando per questa costante gli sarebbero sfuggite restando illeggibili a schermo.
 */
const labelCls = 'font-maven text-xs text-kidville-sub mb-1 block';

export function StudentEconomicSection({ alunnoId, form, updateForm, parents, siblings }: Props) {
    const t = useTranslations('adminStudents');
    const importo = Number(form.importo_retta_mensile ?? 0);
    const aCaricoDi = (form.retta_a_carico_di as string | null) ?? null;
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

    /**
     * I fratelli che possono PAGARE: iscritti, e non già a carico di un terzo.
     *
     * Chi è a sua volta a carico di qualcuno non genera rette: metterglielo addosso
     * formerebbe una catena in fondo alla quale non paga nessuno. Il server la
     * rifiuta (`RETTA_CICLO_FRATELLI`), ma un'opzione che verrà rifiutata non si
     * offre.
     */
    const candidatiPaganti = (siblings ?? []).filter(
        (f) => f.id !== alunnoId && (f.stato ?? 'iscritto') === 'iscritto' && f.retta_a_carico_di == null,
    );

    /** I fratelli la cui retta la paga QUESTO bambino. Sola lettura. */
    const pagaPer = (siblings ?? []).filter((f) => f.retta_a_carico_di === alunnoId);

    /**
     * I due modi in cui la retta di un bambino può essere sbagliata SENZA che nulla
     * dia errore, entrambi misurati in produzione il 2026-09-04:
     *
     *  · un importo SIMBOLICO (fra 0 e 1 €) — cinque bambini veri, il ripiego che le
     *    famiglie hanno inventato per dire «non paga», perché lo zero sulla colonna
     *    significa il contrario («usa il default di sede», cioè 150 €);
     *  · il legame valorizzato CON un importo ancora addosso — tre bambini: le due
     *    facce dello stesso fatto che divergono, ed è così che è nato l'anello
     *    rovesciato da 250 €/mese.
     */
    const avvisoRetta = aCaricoDi && importo !== 0
        ? t('econRettaIncoerente')
        : !aCaricoDi && importo > 0 && importo < 1
            ? t('econRettaSimbolica')
            : '';

    const setIntestatario = (val: Intestatario | null) => updateForm('intestatario_fatture', val);

    /**
     * ─── L'INTESTATARIO «ALTRO», VALIDATO MENTRE SI SCRIVE ────────────────────
     *
     * La regola non è riscritta qui: è `validaCessionario`, importata dal modulo
     * puro `@/lib/fatturazione/cessionario` — lo stesso che decide nell'anteprima e
     * nell'emissione. Se questa schermata dicesse «va bene» e l'emissione dicesse di
     * no, il difetto tornerebbe identico con la suite verde davanti.
     *
     * Anche i nomi dei campi nell'avviso vengono da lì (`ETICHETTE_CAMPO_CESSIONARIO`,
     * nell'ordine di `CAMPI_CESSIONARIO`): chi legge «manca il CAP» qui e «manca il
     * CAP» al momento di emettere deve poter capire che è la stessa cosa, non due
     * controlli diversi che si somigliano.
     *
     * ⚠️ DEBITO DICHIARATO, non una svista: quelle etichette sono **in italiano fisso**,
     * quindi con l'interfaccia in inglese l'avviso nomina i campi in italiano mentre le
     * caselle sopra sono tradotte. È voluto — sono le stesse parole di
     * `messaggioCessionarioIncompleto`, che la segreteria rileggerà davanti allo scarto,
     * e due vocabolari per la stessa regola sarebbero peggio di uno solo un po' fuori
     * lingua.
     *
     * Se un giorno vanno localizzate, si localizzano in `cessionario.ts`, così che il
     * cambio valga in tutti e tre i posti. **Non** rimpiazzandole qui con `econIntCf` /
     * `econIntCap`: sono in catalogo a un passo, è la scorciatoia che verrebbe naturale,
     * e riporterebbe il messaggio dell'avviso a divergere da quello dell'emissione —
     * cioè esattamente il difetto che questo blocco esiste per non far tornare.
     */
    const datiAltro = intestatario?.tipo === 'altro' ? intestatario.dati ?? {} : null;
    const erroriAltro: ErroriCessionario = datiAltro
        ? validaCessionario({
            codice_fiscale: datiAltro.cf,
            nome: datiAltro.nome,
            cognome: datiAltro.cognome,
            indirizzo: datiAltro.indirizzo,
            cap: datiAltro.cap,
            comune: datiAltro.comune,
        })
        : {};
    const campiDaCorreggere = CAMPI_CESSIONARIO.filter((c) => erroriAltro[c] !== undefined);
    const avvisoIntestatario = campiDaCorreggere.length > 0
        ? t('econIntIncompleto', {
            campi: campiDaCorreggere
                .map((c) => (erroriAltro[c] === 'formato'
                    ? t('econIntCampoFormato', { campo: ETICHETTE_CAMPO_CESSIONARIO[c] })
                    : ETICHETTE_CAMPO_CESSIONARIO[c]))
                .join(', '),
        })
        : '';

    return (
        <section className="pt-4 border-t border-kidville-line">
            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                <Euro size={12} />
                {t('econDatiEconomici')}
            </h3>

            {/* Retta mensile */}
            <div className="mb-4">
                <label className={labelCls} htmlFor={`retta-${alunnoId}`}>{t('econImportoRetta')}</label>
                <input
                    id={`retta-${alunnoId}`}
                    type="number"
                    min={0}
                    step="0.01"
                    value={importo || ''}
                    disabled={!!aCaricoDi}
                    onChange={(e) => updateForm('importo_retta_mensile', e.target.value === '' ? 0 : Number(e.target.value))}
                    placeholder={t('econImportoPlaceholder')}
                    className={inputCls}
                />
                <p className="font-maven text-[11px] text-kidville-muted mt-1">
                    {t('econScontoFratelliPre')}<strong>{t('econScontoFratelliBold')}</strong>{t('econScontoFratelliPost')}
                </p>

                {/* ─── «OPPURE: LA PAGA …» ────────────────────────────────────────
                    `alunni.retta_a_carico_di`: entrambe le strade che generano le
                    rette saltano chi ce l'ha valorizzata. Fino al 2026-09-04 si
                    poteva scrivere solo dall'import: 44 alunni in produzione ce
                    l'avevano, e nessuna schermata lo diceva.

                    ⚠️ Solo i fratelli ISCRITTI, e solo quelli che non sono già a
                    carico di qualcun altro: una catena finisce con nessuno che paga,
                    e il server la rifiuta comunque (`RETTA_CICLO_FRATELLI`). Meglio
                    non offrirla. */}
                {candidatiPaganti.length > 0 && (
                    <div className="mt-3">
                        <label className={labelCls} htmlFor={`acarico-${alunnoId}`}>{t('econRettaACarico')}</label>
                        <select
                            id={`acarico-${alunnoId}`}
                            value={aCaricoDi ?? ''}
                            onChange={(e) => {
                                const scelto = e.target.value || null;
                                updateForm('retta_a_carico_di', scelto);
                                // Le due facce dello stesso fatto, mosse insieme. Togliendo
                                // il legame NON si tocca l'importo: uno zero su questa
                                // colonna significa «usa il default di sede», e sceglierlo
                                // al posto dell'operatore vorrebbe dire decidere una retta.
                                if (scelto) updateForm('importo_retta_mensile', 0);
                            }}
                            className={inputCls}
                        >
                            <option value="">{t('econRettaPagaLui')}</option>
                            {candidatiPaganti.map((f) => (
                                <option key={f.id} value={f.id}>
                                    {`${f.nome} ${f.cognome}`.trim()}{f.classe_sezione ? ` — ${f.classe_sezione}` : ''}
                                </option>
                            ))}
                        </select>
                        <p className="font-maven text-[11px] text-kidville-sub mt-1">{t('econRettaACaricoHint')}</p>
                    </div>
                )}

                {/* Il lato di CHI PAGA, in sola lettura: la stessa relazione modificabile
                    da due schermate è una doppia strada per lo stesso dato. Serve solo a
                    far vedere un legame ROVESCIATO guardando UNA delle due schede — è
                    ciò che è mancato al caso di Giugliano da 250 €/mese. */}
                {pagaPer.length > 0 && (
                    <p className="font-maven text-[11px] text-kidville-green mt-2 font-semibold">
                        {t('econRettaPagaPer')} {pagaPer.map((f) => `${f.nome} ${f.cognome}`.trim()).join(', ')}
                    </p>
                )}

                {/* ⚠️ I due avvisi. Live region unica, montata sempre: un `role="alert"`
                    inserito nel DOM col testo già dentro spesso resta muto. */}
                <p role="alert" className="font-maven text-[11px] text-kidville-error mt-2">
                    {avvisoRetta}
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
                            {formatEuro(quoteSum)} {sumMismatch && `≠ ${formatEuro(importo)}`}
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
                <label className={`${labelCls} flex items-center gap-1`} htmlFor={`intestatario-${alunnoId}`}>
                    <FileText size={12} /> {t('econIntestatarioFatture')} <span className="font-normal text-kidville-muted/80">{t('econEccezioneFiglio')}</span>
                </label>
                <select
                    id={`intestatario-${alunnoId}`}
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
                    <div className="mt-2 space-y-2">
                        <p className="font-maven text-[11px] text-kidville-sub">{t('econIntObbligatori')}</p>

                        <div className="grid grid-cols-2 gap-2">
                            {CAMPI_ALTRO.map((c) => (
                                <div key={c.chiave} className={c.largo ? 'col-span-2' : undefined}>
                                    <label className={labelCls} htmlFor={`intestatario-${c.chiave}-${alunnoId}`}>
                                        {t(c.etichetta)}{c.facoltativo ? ` ${t('econIntFacoltativo')}` : ''}
                                    </label>
                                    <input
                                        id={`intestatario-${c.chiave}-${alunnoId}`}
                                        type={c.chiave === 'email' ? 'email' : 'text'}
                                        value={intestatario.dati?.[c.chiave] ?? ''}
                                        onChange={(e) =>
                                            setIntestatario({
                                                tipo: 'altro',
                                                dati: { ...intestatario.dati, [c.chiave]: e.target.value },
                                            })
                                        }
                                        className={inputCls}
                                    />
                                </div>
                            ))}
                        </div>

                        {/* ⚠️ Live region montata SEMPRE, vuota quando non c'è niente da
                            dire: un `role="alert"` inserito nel DOM col testo già dentro
                            spesso resta muto (stessa scelta dell'avviso della retta). */}
                        <p
                            role="alert"
                            data-testid="avviso-intestatario-altro"
                            className="font-maven text-[11px] text-kidville-error"
                        >
                            {avvisoIntestatario}
                        </p>

                        {/* Il silenzio da solo non distingue «i dati bastano» da «il
                            controllo non è mai partito»: la conferma positiva sì. */}
                        {avvisoIntestatario === '' && (
                            <p
                                data-testid="intestatario-altro-completo"
                                className="font-maven text-[11px] font-semibold text-kidville-green"
                            >
                                {t('econIntCompleto')}
                            </p>
                        )}

                        <p className="font-maven text-[11px] text-kidville-sub">{t('econIntEmailFuoriFattura')}</p>
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
