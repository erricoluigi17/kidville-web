'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Building2, GraduationCap, Loader2, Lock, Plus, RotateCcw, Settings, User, X } from 'lucide-react';
import { CockpitPage } from '@/components/ui/cockpit';
import { schoolTypeConfig } from '@/components/features/admin/SectionsView';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';

// Etichetta tradotta del grado (schoolTypeConfig.label resta fallback statico).
const livelloLabelKey = (tipo: string) =>
    tipo === 'nido' ? 'secTipoNido' : tipo === 'primaria' ? 'secTipoPrimaria' : 'secTipoInfanzia';

// Dettaglio sezione a tutta area contenuto (sidebar e header del cockpit
// restano): alunni assegnati + impostazioni. Sostituisce il pannello inline
// che si apriva in fondo alla griglia dell'anagrafica.

type SchoolType = 'nido' | 'infanzia' | 'primaria';

interface SezioneDettaglio {
    id: string;
    name: string;
    school_type: SchoolType;
    scuolaId: string;
    scuolaNome: string;
}

interface Student {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione?: string | null;
    section_id?: string | null;
    stato?: string;
}

interface Teacher {
    id: string;
    nome: string;
    cognome: string;
}

/**
 * Un errore da mostrare, in forma NON ancora tradotta.
 *
 * ⚠️ NON è un vezzo: `load`/`loadTeachers` sono `useCallback` che alimentano un
 * `useEffect`. Se dentro ci finisse `t`, `t` andrebbe nelle loro dipendenze — e
 * `useTranslations` restituisce una funzione NUOVA a ogni render. L'effetto
 * ripartirebbe a ogni render: un ciclo di fetch infinito che, per giunta,
 * riscrive di continuo lo stato appena aggiornato da una mutazione riuscita
 * (misurato: il grado cambiato tornava indietro da solo). Perciò le due
 * `useCallback` conservano CHIAVE + testo-del-server, e la traduzione avviene al
 * render, dove `t` non è una dipendenza di niente.
 */
type ChiaveAvvertimento =
    | 'sezErroreOperazione'
    | 'sezErroreCaricamento'
    | 'sezInsegnantiErrore'
    | 'sezAlunniErrore';
type Avvertimento = { chiave: ChiaveAvvertimento; testo: string } | null;

/**
 * Il riquadro (card) di questa pagina: un titolo e il suo contenuto, come
 * REGIONE con nome accessibile.
 *
 * ⚠️ NON è decorazione. Da qui in poi ogni riquadro racconta il PROPRIO esito
 * dentro di sé, e perché quella promessa sia verificabile — da uno screen
 * reader come da un test — il riquadro deve avere un'identità: `role="region"`
 * + `aria-labelledby` sul titolo. Senza, «il messaggio è dentro il riquadro
 * insegnanti» non è un'affermazione che si possa provare.
 */
function Riquadro({
    id,
    icona: Icona,
    titolo,
    children,
}: {
    id: string;
    icona: typeof Settings;
    titolo: string;
    children: React.ReactNode;
}) {
    return (
        <section role="region" aria-labelledby={`${id}-titolo`} className="rounded-card bg-kidville-white p-6 shadow-sm">
            <h4 id={`${id}-titolo`} className="font-barlow mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-kidville-muted">
                <Icona size={16} /> {titolo}
            </h4>
            {children}
        </section>
    );
}

/**
 * L'esito NEGATIVO di un riquadro, reso dentro il riquadro stesso.
 *
 * 🔴 LA REGOLA CHE QUESTO COMPONENTE FA RISPETTARE. Fino al 2026-07-31 questa
 * pagina aveva UN solo stato d'errore e UNA sola fascia rossa, in cima: il 403
 * di `/teachers` — un riquadro secondario — veniva raccontato come «Accesso
 * negato» dell'INTERA schermata. La segreteria apriva il dettaglio di una
 * sezione, leggeva una fascia rossa che le diceva pure il falso, e concludeva
 * che la pagina fosse rotta. Non lo era: era rotto il modo di riportare.
 *
 * Un rifiuto parziale è parziale: sta dove è nato, e il resto della pagina
 * continua a funzionare e a dirlo.
 */
function EsitoRiquadro({ testo }: { testo: string }) {
    return (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} />
            <span>{testo}</span>
        </div>
    );
}

export default function SezioneDetailPage() {
    const t = useTranslations('adminStudents');
    const params = useParams<{ id: string }>();
    const sectionId = params?.id;

    const [sezione, setSezione] = useState<SezioneDettaglio | null>(null);
    const [students, setStudents] = useState<Student[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSavingType, setIsSavingType] = useState(false);
    const [teachers, setTeachers] = useState<{ assigned: Teacher[]; available: Teacher[] }>({ assigned: [], available: [] });
    const [newTeacherId, setNewTeacherId] = useState('');
    const [teacherBusy, setTeacherBusy] = useState(false);
    const [teachersLoading, setTeachersLoading] = useState(true);
    // L'esito NEGATIVO dell'ultima operazione, UNO PER RIQUADRO.
    //
    // PERCHÉ ESISTONO. Le tre scritture di questa pagina erano scritte
    // `if (res.ok) …` senza `else` (o senza guardare affatto la risposta): un
    // rifiuto del server — il 400 «Specificare la sede» nato con le tre sedi, un
    // 403 di scope — si comportava esattamente come un successo. La tendina del
    // grado lampeggiava e tornava indietro, il modulo dell'insegnante si
    // azzerava, e l'operatore restava convinto che il click non fosse stato
    // registrato.
    //
    // PERCHÉ SONO TRE E NON UNO (S27, collaudo del 2026-07-31). Con un solo
    // stato condiviso, il rifiuto di UN riquadro finiva in una fascia rossa in
    // cima alla PAGINA: chi la leggeva concludeva che la schermata intera fosse
    // negata, mentre erano negati gli insegnanti e basta. Un errore che non dice
    // DOVE è nato costa più di quanto informa.
    const [erroreInsegnanti, setErroreInsegnanti] = useState<Avvertimento>(null);
    const [erroreImpostazioni, setErroreImpostazioni] = useState<Avvertimento>(null);
    const [erroreAlunni, setErroreAlunni] = useState<Avvertimento>(null);
    // «Non hai i permessi» NON è un errore: è una risposta. Ha uno stato suo
    // perché si rende in modo diverso (nessun allarme, e i comandi spariscono:
    // una tendina disabilitata accanto a un diniego non serve a nessuno).
    const [insegnantiNegati, setInsegnantiNegati] = useState(false);
    // «Non ho potuto caricare» ≠ «non esiste». Sono due schermate diverse: la
    // seconda accusa i dati, la prima accusa la rete — e solo la prima ha senso
    // riprovarla.
    const [erroreCaricamento, setErroreCaricamento] = useState<Avvertimento>(null);

    /** Il testo da mostrare: quello del server se c'è, altrimenti il generico. */
    const testoDi = (a: Avvertimento) => (a === null ? '' : a.testo || t(a.chiave));

    /** Log di un rifiuto: lo `stato` è un numero (passa la lista bianca di `redact`). */
    const logRifiuto = (messaggio: string, stato: number) => {
        logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio,
            route: '/admin/students/sezioni/[id]',
            stato,
        });
    };

    /** Guasto già ridotto a testo (dal `.catch` di una promise). */
    const logGuastoMsg = (messaggio: string) => {
        logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio,
            route: '/admin/students/sezioni/[id]',
        });
    };

    const logGuasto = (messaggio: string, err: unknown) => logGuastoMsg(`${messaggio}: ${nomeErrore(err)}`);

    /**
     * ⚠️ DUE VINCOLI DI FORMA per questa funzione e per `load`, entrambi imposti
     * da `react-hooks/set-state-in-effect` (che nel gate è un ERRORE) e
     * verificati, non supposti — sono chiamate da un `useEffect`:
     *  1. niente blocco `catch`: il ramo d'errore vive su `.catch()` DELLA
     *     PROMISE, che torna `null` e lascia la gestione nel flusso normale;
     *  2. il `try { … } finally { setSomething(false) }` RESTA: spostare quel
     *     setter nel corpo lineare, a parità di codice, fa scattare la regola.
     * Le mutazioni (`addTeacher` & co.) non passano da un effetto: lì il
     * `try/catch` è legittimo.
     */
    const loadTeachers = useCallback(async () => {
        if (!sectionId) return;
        let motivo = '';
        try {
            const res = await fetch(`/api/admin/sections/${sectionId}/teachers`)
                .catch((e: unknown) => { motivo = nomeErrore(e); return null; });
            if (res === null) {
                setErroreInsegnanti({ chiave: 'sezInsegnantiErrore', testo: '' });
                logGuastoMsg(`sezione-insegnanti-caricamento-fallito: ${motivo}`);
                return;
            }
            const d = res.ok ? await res.json().catch(() => null) : null;
            if (d?.success) {
                setInsegnantiNegati(false);
                setErroreInsegnanti(null);
                setTeachers({ assigned: d.assigned ?? [], available: d.available ?? [] });
                return;
            }
            // 403 = «non ti compete», non «è rotto». Due conseguenze, entrambe
            // volute:
            //  · a schermo NON è un allarme (nessun `role="alert"`, nessuna
            //    fascia rossa): è lo stato del riquadro, e resta nel riquadro;
            //  · NON si spedisce nessuna riga al canale client. È la politica
            //    scritta di `src/lib/logging/client.ts` («401/403/404 → info,
            //    mai in tabella; l'unico modo di dire non conservarlo è non
            //    spedirlo») e quella di `with-route.ts`. Il diniego il server lo
            //    vede e lo logga già lui, con il ruolo e il motivo: qui
            //    aggiungerebbe solo rumore `error` sopra un evento normale.
            if (res.status === 403) {
                setInsegnantiNegati(true);
                setErroreInsegnanti(null);
                return;
            }
            // Elenco insegnanti VUOTO perché non è arrivato: senza questo ramo
            // la card diceva «Nessun insegnante di riferimento assegnato», che è
            // un'affermazione sui dati fatta senza avere i dati.
            setErroreInsegnanti({ chiave: 'sezInsegnantiErrore', testo: res.ok ? '' : await messaggioErrore(res, '') });
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: 'sezione-insegnanti-non-caricati',
                route: '/admin/students/sezioni/[id]',
                stato: res.status,
            });
        } finally {
            setTeachersLoading(false);
        }
    }, [sectionId]);

    useEffect(() => { loadTeachers(); }, [loadTeachers]);

    const addTeacher = async () => {
        if (!newTeacherId || !sectionId) return;
        setTeacherBusy(true);
        setErroreInsegnanti(null);
        try {
            const res = await fetch(`/api/admin/sections/${sectionId}/teachers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ utente_id: newTeacherId }),
            });
            if (!res.ok) {
                // ⚠️ IL PUNTO. `setNewTeacherId('')` stava QUI SOPRA, prima di
                // sapere l'esito: su un rifiuto si perdeva anche la scelta appena
                // fatta, ed è esattamente il difetto che l'ondata 3 dichiarava chiuso.
                setErroreInsegnanti({ chiave: 'sezErroreOperazione', testo: await messaggioErrore(res, '') });
                logRifiuto('sezione-insegnante-aggiunta-respinta', res.status);
                return;
            }
            setNewTeacherId('');
            await loadTeachers();
        } catch (err) {
            setErroreInsegnanti({ chiave: 'sezErroreOperazione', testo: '' });
            logGuasto('sezione-insegnante-aggiunta-fallita', err);
        } finally {
            setTeacherBusy(false);
        }
    };

    const removeTeacher = async (utenteId: string) => {
        if (!sectionId) return;
        setTeacherBusy(true);
        setErroreInsegnanti(null);
        try {
            const res = await fetch(`/api/admin/sections/${sectionId}/teachers`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ utente_id: utenteId }),
            });
            if (!res.ok) {
                // Ricaricare e basta faceva ricomparire la pillola dell'insegnante
                // come se nulla fosse: sembrava un ritardo, era un rifiuto.
                setErroreInsegnanti({ chiave: 'sezErroreOperazione', testo: await messaggioErrore(res, '') });
                logRifiuto('sezione-insegnante-rimozione-respinta', res.status);
                return;
            }
            await loadTeachers();
        } catch (err) {
            setErroreInsegnanti({ chiave: 'sezErroreOperazione', testo: '' });
            logGuasto('sezione-insegnante-rimozione-fallita', err);
        } finally {
            setTeacherBusy(false);
        }
    };

    const load = useCallback(async () => {
        if (!sectionId) return;
        let motivo = '';
        try {
            const res = await fetch('/api/admin/sections/scoped')
                .catch((e: unknown) => { motivo = nomeErrore(e); return null; });
            if (res === null) {
                setErroreCaricamento({ chiave: 'sezErroreCaricamento', testo: '' });
                logGuastoMsg(`sezione-dettaglio-caricamento-fallito: ${motivo}`);
                return;
            }
            if (!res.ok) {
                setErroreCaricamento({ chiave: 'sezErroreCaricamento', testo: await messaggioErrore(res, '') });
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'sezione-dettaglio-non-caricato',
                    route: '/admin/students/sezioni/[id]',
                    stato: res.status,
                });
                return;
            }
            const d = await res.json().catch(() => null);
            const groups: { scuolaId: string; scuolaNome: string; sezioni: { id: string; name: string; school_type: SchoolType }[] }[] =
                d?.success ? (d.data ?? []) : [];

            let found: SezioneDettaglio | null = null;
            for (const g of groups) {
                const s = g.sezioni.find(x => x.id === sectionId);
                if (s) { found = { ...s, scuolaId: g.scuolaId, scuolaNome: g.scuolaNome }; break; }
            }
            setErroreCaricamento(null);
            setSezione(found);
            if (!found) return;

            const stuRes = await fetch(`/api/admin/students?scuola_id=${found.scuolaId}&limit=${LIMITE_ELENCO_ALUNNI}`)
                .catch(() => null);
            const stuData = stuRes?.ok ? await stuRes.json().catch(() => null) : null;
            if (Array.isArray(stuData)) {
                const f = found;
                // `section_id` è il legame vero: se c'è, decide da solo. Il
                // nome-classe resta solo come ripiego per le righe che il
                // trigger `sync_alunno_section_id` non ha ancora risolto —
                // in OR con `section_id` faceva comparire in questa classe
                // anche chi è assegnato a un'altra e porta ancora scritto
                // sopra il vecchio nome, gonfiando il numero in testata.
                setStudents((stuData as Student[]).filter(s => (
                    s.section_id ? s.section_id === f.id : s.classe_sezione === f.name
                )));
                return;
            }
            // Elenco alunni non arrivato: «0 alunni» in testata sarebbe una
            // risposta a una domanda che nessuno ha potuto porre.
            setErroreAlunni({ chiave: 'sezAlunniErrore', testo: '' });
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: 'sezione-alunni-non-caricati',
                route: '/admin/students/sezioni/[id]',
                stato: stuRes?.status ?? 0,
            });
        } finally {
            setIsLoading(false);
        }
    }, [sectionId]);

    useEffect(() => { load(); }, [load]);

    /** Ritenta il caricamento: è un gestore d'evento, quindi può alzare lo spinner. */
    const riprovaCaricamento = () => {
        setIsLoading(true);
        setErroreCaricamento(null);
        setErroreInsegnanti(null);
        setErroreImpostazioni(null);
        setErroreAlunni(null);
        setInsegnantiNegati(false);
        setTeachersLoading(true);
        void load();
        void loadTeachers();
    };

    const changeSchoolType = async (newType: SchoolType) => {
        if (!sezione) return;
        setIsSavingType(true);
        setErroreImpostazioni(null);
        try {
            const res = await fetch('/api/admin/sections', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: sezione.id, school_type: newType }),
            });
            if (!res.ok) {
                // Senza questo ramo la tendina tornava al valore vecchio e basta:
                // identico a un click perso, e il 400 «Specificare la sede»
                // rimaneva invisibile.
                setErroreImpostazioni({ chiave: 'sezErroreOperazione', testo: await messaggioErrore(res, '') });
                logRifiuto('sezione-tipo-scuola-respinto', res.status);
                return;
            }
            setSezione({ ...sezione, school_type: newType });
        } catch (err) {
            setErroreImpostazioni({ chiave: 'sezErroreOperazione', testo: '' });
            logGuasto('sezione-tipo-scuola-fallito', err);
        } finally {
            setIsSavingType(false);
        }
    };

    const backHref = '/admin/students?tab=sections';

    if (isLoading) {
        return (
            <CockpitPage max={1152}>
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="animate-spin text-kidville-green" size={32} />
                </div>
            </CockpitPage>
        );
    }

    if (!sezione) {
        return (
            <CockpitPage max={1152}>
                <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline">
                    <ArrowLeft size={15} strokeWidth={2} /> {t('sezBack')}
                </Link>
                {erroreCaricamento ? (
                    // La sezione non è arrivata: dirlo. «Non esiste o non è tua»
                    // sarebbe un'accusa ai dati per un guasto della rete — e non
                    // offrirebbe l'unica cosa che qui serve, riprovare.
                    <div role="alert" className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-error-soft text-kidville-error">
                            <AlertTriangle size={34} strokeWidth={1.8} />
                        </div>
                        <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('sezErroreCaricamentoTitolo')}</h2>
                        <p className="font-maven mt-1 text-sm text-kidville-muted">{testoDi(erroreCaricamento)}</p>
                        <button
                            onClick={riprovaCaricamento}
                            className="mt-4 inline-flex items-center gap-2 rounded-pill bg-kidville-green px-5 py-2.5 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-yellow"
                        >
                            <RotateCcw size={15} strokeWidth={2} /> {t('sezRiprova')}
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col items-center rounded-card bg-kidville-white p-10 text-center shadow-sm">
                        <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-kidville-cream text-4xl">🏫</div>
                        <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('sezNonDisp')}</h2>
                        <p className="font-maven mt-1 text-sm text-kidville-muted">{t('sezNonDispHint')}</p>
                    </div>
                )}
            </CockpitPage>
        );
    }

    const config = schoolTypeConfig[sezione.school_type] || schoolTypeConfig.infanzia;
    const Icon = config.icon;

    return (
        <CockpitPage max={1152}>
            <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline">
                <ArrowLeft size={15} strokeWidth={2} /> {t('sezBack')}
            </Link>

            {/* ⚠️ QUI NON C'È PIÙ NESSUNA FASCIA. L'esito negativo lo mostra il
                riquadro che l'ha prodotto (`EsitoRiquadro`): una fascia in cima
                dice «questa pagina è negata» anche quando a essere negato è un
                riquadro su tre — ed è esattamente ciò che la segreteria leggeva
                il 2026-07-31. L'annuncio allo screen reader non si perde:
                `role="alert"` è sull'esito, dovunque stia. */}

            {/* Testata sezione */}
            <div className="mb-5 rounded-card bg-kidville-white p-6 shadow-sm">
                <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-2xl ${config.bg}`}>
                        <Icon size={28} className={config.color} />
                    </div>
                    <div>
                        <h1 className="font-barlow text-3xl font-black uppercase leading-none text-kidville-green">{t('sezIntestazione', { nome: sezione.name })}</h1>
                        <div className="mt-1.5 flex flex-wrap items-center gap-3">
                            <span className={`text-xs font-bold uppercase tracking-wider px-2 py-1 rounded-lg ${config.bg} ${config.color}`}>
                                {t(livelloLabelKey(sezione.school_type))}
                            </span>
                            <span className="font-maven flex items-center gap-1 text-sm text-kidville-muted">
                                <Building2 size={14} /> {sezione.scuolaNome}
                            </span>
                            <span className="font-maven flex items-center gap-1 text-sm text-kidville-muted">
                                <User size={14} /> {t('contAlunni', { n: students.length })}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
                {/* Alunni della sezione */}
                <Riquadro id="riquadro-alunni" icona={User} titolo={t('sezAlunniInSezione', { n: students.length })}>
                    {erroreAlunni && <EsitoRiquadro testo={testoDi(erroreAlunni)} />}
                    {students.length > 0 ? (
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                            {students.map(student => (
                                <div key={student.id} className="flex items-center gap-3 rounded-xl bg-kidville-cream p-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-kidville-green/10">
                                        <User size={14} className="text-kidville-green" />
                                    </div>
                                    <div>
                                        <p className="font-maven text-sm font-bold text-kidville-ink">{student.cognome} {student.nome}</p>
                                        <p className="text-xs text-kidville-muted">{student.stato || 'iscritto'}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="rounded-xl bg-kidville-cream py-6 text-center">
                            <p className="font-maven text-sm text-kidville-muted">{t('sezNessunAlunno')}</p>
                        </div>
                    )}
                    <p className="font-maven mt-4 text-xs text-kidville-muted">
                        {t('sezPerAprirePre')}<Link href="/admin/students" className="font-semibold text-kidville-green hover:underline">{t('tabAlunni')}</Link>{t('sezPerAprirePost')}
                    </p>
                </Riquadro>

                <div className="space-y-5">
                {/* Impostazioni sezione */}
                <Riquadro id="riquadro-impostazioni" icona={Settings} titolo={t('sezImpostazioni')}>
                    {erroreImpostazioni && <EsitoRiquadro testo={testoDi(erroreImpostazioni)} />}
                    <div className="space-y-4 rounded-xl bg-kidville-cream p-4">
                        <div>
                            <label className="mb-1 block text-xs font-bold uppercase text-kidville-muted">{t('sezTipoScuola')}</label>
                            <select
                                value={sezione.school_type}
                                disabled={isSavingType}
                                onChange={e => changeSchoolType(e.target.value as SchoolType)}
                                className="w-full rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5 font-maven text-sm focus:border-kidville-green focus:outline-none disabled:opacity-60"
                            >
                                <option value="nido">{t('secTipoNido')}</option>
                                <option value="infanzia">{t('secTipoInfanzia')}</option>
                                <option value="primaria">{t('secTipoPrimaria')}</option>
                            </select>
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-bold uppercase text-kidville-muted">{t('campoSede')}</label>
                            <div className="flex items-center gap-2 rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5">
                                <Building2 size={16} className="text-kidville-muted" />
                                <span className="font-maven text-sm text-kidville-ink">{sezione.scuolaNome}</span>
                            </div>
                        </div>
                    </div>
                </Riquadro>

                {/* Insegnanti di riferimento */}
                <Riquadro id="riquadro-insegnanti" icona={GraduationCap} titolo={t('sezInsegnanti')}>
                    {/* 🔴 IL 403 RESTA QUI DENTRO. Non è un allarme e non è una
                        fascia rossa: è lo stato del riquadro. E i comandi
                        spariscono invece di restare disabilitati — una tendina
                        grigia accanto a un diniego non dice niente a nessuno.
                        Nemmeno «Nessun insegnante assegnato» va detto: sarebbe
                        un'affermazione sui dati fatta senza avere i dati. */}
                    {insegnantiNegati ? (
                        <div className="flex items-start gap-2 rounded-xl bg-kidville-cream px-4 py-4 font-maven text-sm text-kidville-sub">
                            <Lock size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} />
                            <span>{t('sezInsegnantiNegato')}</span>
                        </div>
                    ) : (
                    <div className="space-y-3 rounded-xl bg-kidville-cream p-4">
                        {erroreInsegnanti && <EsitoRiquadro testo={testoDi(erroreInsegnanti)} />}
                        {teachers.assigned.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                                {teachers.assigned.map(tch => (
                                    <span key={tch.id} className="inline-flex items-center gap-1.5 rounded-full bg-kidville-green/10 px-3 py-1.5 font-maven text-sm text-kidville-green">
                                        {tch.cognome} {tch.nome}
                                        <button
                                            onClick={() => removeTeacher(tch.id)}
                                            disabled={teacherBusy}
                                            aria-label={t('sezRimuoviInsegnante')}
                                            className="text-kidville-green/60 hover:text-kidville-error disabled:opacity-50"
                                        >
                                            <X size={14} />
                                        </button>
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p className="font-maven text-sm text-kidville-muted">{t('sezNessunInsegnante')}</p>
                        )}
                        <div className="flex items-center gap-2">
                            <select
                                value={newTeacherId}
                                onChange={e => setNewTeacherId(e.target.value)}
                                disabled={teacherBusy || teachersLoading || teachers.available.length === 0}
                                className="flex-1 rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5 font-maven text-sm focus:border-kidville-green focus:outline-none disabled:opacity-60"
                            >
                                <option value="">{teachersLoading ? t('sezCaricamento') : teachers.available.length === 0 ? t('sezNessunDocente') : t('sezSelezionaInsegnante')}</option>
                                {teachers.available.map(tch => (
                                    <option key={tch.id} value={tch.id}>{tch.cognome} {tch.nome}</option>
                                ))}
                            </select>
                            <button
                                onClick={addTeacher}
                                disabled={!newTeacherId || teacherBusy || teachersLoading}
                                className="inline-flex items-center gap-1.5 rounded-xl bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-yellow disabled:opacity-50"
                            >
                                <Plus size={16} /> {t('sezAggiungi')}
                            </button>
                        </div>
                        <p className="font-maven text-xs text-kidville-muted">
                            {t('sezInsegnanteHint')}
                        </p>
                    </div>
                    )}
                </Riquadro>
                </div>
            </div>
        </CockpitPage>
    );
}
