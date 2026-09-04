'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ArrowLeft, Building2, GraduationCap, Loader2, Lock, Pencil, Plus, RotateCcw, Settings, User, X } from 'lucide-react';
import { CockpitPage } from '@/components/ui/cockpit';
// ⚠️ `Btn` e non un `<button>` a mano: lo stato spento di questa famiglia è
// DIPINTO (5,75:1) invece che sbiadito con un'alfa, che sul verde saturo del
// primario misurava 1,20:1 — testo quasi invisibile (lock
// `__tests__/a11y/btn-disabilitato-leggibile.test.tsx`).
import { Btn } from '@/components/ui/Btn';
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
    | 'sezAlunniErrore'
    // I tre esiti della RINOMINA. Sono chiavi di catalogo e non prosa del
    // server di proposito: vedi `avvertimentoRinomina` più sotto.
    | 'sezRinominaDuplicato'
    | 'sezRinominaAltraSede'
    | 'sezRinominaErrore';
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
    // ─── RINOMINA DELLA CLASSE ───────────────────────────────────────────────
    // Il nome è la TERZA proprietà di questa riga, accanto al grado e alla sede,
    // ed era l'unica che si poteva cambiare soltanto in SQL: è passata due volte
    // da una migrazione scritta a mano (`20260820220954` per Cesa,
    // `20260831192043` per Aversa). `requireStaff` ammette già
    // `admin | coordinator | segreteria`, e `PATCH /api/admin/sections` accetta
    // `name` dal 2026-07-31: qui non si apre nessun permesso nuovo, si dà una
    // porta a un potere che c'era già e che nessuno poteva esercitare.
    //
    // La bozza è uno stato SUO e non si scrive in `sezione`: finché il server non
    // ha detto di sì, il nome vero è ancora quello vecchio, e una schermata che
    // mostra il nome nuovo prima della conferma sta raccontando una cosa che
    // potrebbe non essere mai successa (è il difetto che `changeSchoolType`
    // aveva prima del 2026-07-31, al contrario).
    const [rinominaAperta, setRinominaAperta] = useState(false);
    const [nomeBozza, setNomeBozza] = useState('');
    const [isSavingName, setIsSavingName] = useState(false);
    /* ─── DOVE VA IL FUOCO QUANDO IL CONTROLLO CAMBIA FORMA ──────────────────
       Il riquadro scambia due alberi diversi (lettura ⇄ modifica), quindi il
       pulsante che si è appena premuto viene SMONTATO — e il fuoco, che era su
       di lui, ricade su `<body>`. Misurato: dopo «Rinomina», dopo «Annulla» e
       dopo il salvataggio, `document.activeElement` era `BODY` tutte e tre le
       volte. Col mouse non si vede; da tastiera vuol dire ripartire dall'inizio
       del documento e ridiscendere fino a qui, e per uno screen reader vuol dire
       perdere il punto in cui si era. È lo stesso difetto che il commento sul
       `Btn` qui sotto dichiara di voler evitare con `aria-disabled`: si evitava
       nel piccolo e si ripresentava nel grande. Rilievo del critico, 2026-09-04. */
    const campoNomeRef = useRef<HTMLInputElement | null>(null);
    const pulsanteRinominaRef = useRef<HTMLButtonElement | null>(null);
    /** Dove riportare il fuoco al prossimo disegno: `null` = lascialo dov'è. */
    const fuocoDaRidare = useRef<'campo' | 'pulsante' | null>(null);
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

            const stuRes = await fetch(`/api/admin/students?stato=iscritto&scuola_id=${found.scuolaId}&limit=${LIMITE_ELENCO_ALUNNI}`)
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

    /** Apre la rinomina partendo SEMPRE dal nome vero, mai da una bozza vecchia. */
    // Si agisce DOPO il disegno, perché prima il nodo di destinazione non esiste
    // ancora: `rinominaAperta` è nelle dipendenze proprio per aspettarlo.
    useEffect(() => {
        if (fuocoDaRidare.current === 'campo') campoNomeRef.current?.focus();
        else if (fuocoDaRidare.current === 'pulsante') pulsanteRinominaRef.current?.focus();
        fuocoDaRidare.current = null;
    }, [rinominaAperta]);

    const apriRinomina = () => {
        if (!sezione) return;
        setNomeBozza(sezione.name);
        setErroreImpostazioni(null);
        fuocoDaRidare.current = 'campo';
        setRinominaAperta(true);
    };

    const chiudiRinomina = () => {
        fuocoDaRidare.current = 'pulsante';
        setRinominaAperta(false);
        setNomeBozza('');
        setErroreImpostazioni(null);
    };

    /**
     * Il rifiuto del server tradotto in qualcosa che si capisce.
     *
     * ⚠️ PERCHÉ 409 E 403 NON PASSANO DA `messaggioErrore`. Quella funzione
     * mostra la PROSA del server quando non riconosce un codice, ed è la scelta
     * giusta dove la prosa è l'unica cosa che dice il motivo. Ma questi due
     * rifiuti sono PREVISTI — sono i due modi documentati in cui questa
     * scrittura può essere respinta — e la loro prosa nasce dentro la route,
     * dove il locale e il catalogo non esistono: in un'interfaccia inglese
     * uscirebbe in italiano (fallimento F2 del collaudo del 2026-07-31).
     * Il modo pulito sarebbe un `codice:` dichiarato in `CODICI_ERRORE`, ma
     * quello si aggiunge nella route — che qui non si tocca. Finché non c'è, lo
     * STATO HTTP è l'unico segnale stabile e bilingue che abbiamo, e questi due
     * sono inequivocabili su questa PATCH: 409 = omonimia nella stessa sede,
     * 403 = classe di un altro plesso.
     * Tutto il resto (400, 404, 500) tiene la prosa: lì è l'unica cosa che dice
     * cosa è andato storto.
     */
    const avvertimentoRinomina = async (res: Response): Promise<Avvertimento> => {
        if (res.status === 409) return { chiave: 'sezRinominaDuplicato', testo: '' };
        if (res.status === 403) return { chiave: 'sezRinominaAltraSede', testo: '' };
        return { chiave: 'sezRinominaErrore', testo: await messaggioErrore(res, '') };
    };

    const rinominaSezione = async () => {
        if (!sezione) return;
        const nome = nomeBozza.trim();
        // Tre motivi per non partire, e nessuno è una formalità:
        //  · nome vuoto o di soli spazi — il server risponderebbe 400, ma un giro
        //    di rete per sapere una cosa che sappiamo già lascia l'operatore
        //    davanti a un errore invece che davanti al vincolo;
        //  · nome invariato — sarebbe una scrittura, con il suo audit e il suo
        //    trigger, per non cambiare niente;
        //  · richiesta già in volo — il secondo click non deve raddoppiarla.
        if (!nome || nome === sezione.name || isSavingName) return;
        setIsSavingName(true);
        setErroreImpostazioni(null);
        try {
            const res = await fetch('/api/admin/sections', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                // Solo `id` e `name`: `scuola_id` è fuori dallo schema della route
                // di proposito (era la primitiva che spostava una classe di plesso
                // e disarmava tutti gli altri gate di sede). Il client non ci prova.
                body: JSON.stringify({ id: sezione.id, name: nome }),
            });
            if (!res.ok) {
                // Si RESTA in modifica, col nome digitato: su un rifiuto perdere
                // anche ciò che si è scritto è la lezione di `addTeacher`.
                setErroreImpostazioni(await avvertimentoRinomina(res));
                logRifiuto('sezione-rinomina-respinta', res.status);
                return;
            }
            // Aggiornamento locale, come per il grado: il nome della classe è
            // contesto scolastico e non c'è ragione di rifare i due GET per
            // rileggere una cosa che il server ha appena confermato.
            setSezione({ ...sezione, name: nome });
            fuocoDaRidare.current = 'pulsante';
            setRinominaAperta(false);
        } catch (err) {
            // ⚠️ Niente nome di classe nel messaggio: è testo libero, e nessuna
            // lista bianca lo filtra (stessa regola di `SectionsView`).
            setErroreImpostazioni({ chiave: 'sezRinominaErrore', testo: '' });
            logGuasto('sezione-rinomina-fallita', err);
        } finally {
            setIsSavingName(false);
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
    // Ciò che partirebbe davvero. «  3 ANNI  » e «3 ANNI» sono lo stesso nome:
    // mandarli come diversi creerebbe un omonimo che a schermo non si distingue,
    // e l'indice unico `sections_forma_normalizzata_per_sede` lo rifiuterebbe con
    // un 409 che sembrerebbe sbagliato («ma è diverso!»).
    const nomeRipulito = nomeBozza.trim();
    const nomeVuoto = nomeRipulito === '';
    const rinominaPronta = !nomeVuoto && nomeRipulito !== sezione.name;

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
                        {/* ─── IL NOME DELLA CLASSE ───────────────────────────────
                            Sta qui e non nella griglia dell'elenco per una ragione
                            di forma prima che di gusto: là ogni card È un `<Link>`,
                            e un pulsante dentro un'ancora è un controllo dentro un
                            controllo (il click porterebbe via la pagina). Qui il
                            nome sta accanto alle altre due proprietà della stessa
                            riga — il grado e la sede — e la sede, che è metà della
                            chiave di una classe, si legge senza cambiare schermata:
                            «3 ANNI» esiste in tutti e tre i plessi. */}
                        <div>
                            {rinominaAperta ? (
                                /* ⚠️ È un `<form>` per una ragione sola, e non è
                                   semantica astratta: senza, l'Invio dentro il campo
                                   non faceva NIENTE. Misurato: `keyDown Enter` → zero
                                   PATCH, nessun messaggio, nessun segnale. Chi scrive
                                   un nome in un campo e preme Invio si aspetta che
                                   valga, e il silenzio somiglia a un guasto.
                                   `preventDefault` perché la navigazione nativa del
                                   form ricaricherebbe la pagina; le tre guardie
                                   (vuoto · invariato · richiesta in volo) stanno già
                                   dentro `rinominaSezione` e valgono per entrambe le
                                   strade. Rilievo del critico, 2026-09-04. */
                                <form
                                    onSubmit={(e) => { e.preventDefault(); void rinominaSezione(); }}
                                >
                                    <label htmlFor="sezione-nome" className="mb-1 block text-xs font-bold uppercase text-kidville-sub">{t('secNomeSezione')}</label>
                                    <input
                                        id="sezione-nome"
                                        ref={campoNomeRef}
                                        value={nomeBozza}
                                        onChange={e => setNomeBozza(e.target.value)}
                                        disabled={isSavingName}
                                        aria-invalid={nomeVuoto}
                                        aria-describedby="sezione-nome-vincolo sezione-nome-avviso"
                                        className="w-full rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none disabled:opacity-60"
                                    />
                                    {/* ⚠️ IL POSTO DEL MESSAGGIO È RISERVATO, non conquistato
                                        quando serve. Su WebKit un elemento che compare fa
                                        RISALIRE il pulsante sotto il dito mentre lo si preme:
                                        misurato 25px, e 48px su «Lavora con noi» (corretto in
                                        `5c181ffe`, `FieldRenderer`). Il nodo esiste sempre e ha
                                        un'altezza minima: cambia solo il testo dentro. */}
                                    <p id="sezione-nome-vincolo" aria-live="polite" className="mt-1 min-h-[1.125rem] font-maven text-xs text-kidville-error-strong">
                                        {nomeVuoto ? t('sezRinominaVuoto') : ''}
                                    </p>
                                    {/* ─── COSA COMPORTA, PRIMA DI CONFERMARE ─────────
                                        Rinominare non è cambiare un'etichetta: il nome della
                                        classe è scritto come TESTO in sette archivi — registro
                                        orario, destinatari di avvisi/news/galleria/moduli, menu
                                        della mensa, anagrafica degli alunni — e in quattro di
                                        essi è la chiave con cui si ritrovano le righe.
                                        ⚠️ E QUI STA LA RAGIONE DELLA SECONDA FRASE. La
                                        propagazione a tutte e sette esiste come migrazione
                                        (`20260903145106_propaga_rinomina_sezione_a_tutte_le_tabelle.sql`)
                                        ma NON è applicata: verificato su `pg_proc` il 2026-09-03,
                                        il corpo installato di `propaga_rinomina_sezione` non
                                        nomina né `registro_orario`, né `target_classes`, né
                                        `mensa_class_menu_assignment`. Oggi il trigger aggiorna
                                        SOLO `alunni`. Un avviso che dicesse «il nome viene
                                        aggiornato ovunque» direbbe il falso a chi lo legge
                                        adesso — ed è il modo esatto in cui, in questo repo, un
                                        documento è arrivato a mentire per due settimane.
                                        Quando quella migrazione sarà applicata è `sezRinominaOggi`
                                        — e solo quella chiave — che va riscritta. */}
                                    <div id="sezione-nome-avviso" className="mt-1 flex items-start gap-2 rounded-xl border border-kidville-warn-strong bg-kidville-warn-soft px-3 py-2.5 font-maven text-xs text-kidville-warn-strong">
                                        <AlertTriangle size={14} className="mt-0.5 shrink-0" strokeWidth={1.8} />
                                        <span>
                                            <span className="block">{t('sezRinominaAvviso')}</span>
                                            <span className="mt-1.5 block font-bold">{t('sezRinominaOggi')}</span>
                                        </span>
                                    </div>
                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        {/* Mentre la richiesta è in volo il pulsante è un
                                            MESSAGGIO, non un controllo spento: `disabled`
                                            sfoga il fuoco su `<body>` e sbiadisce l'unico
                                            segnale che il gesto sia partito. `aria-disabled`
                                            più la guardia dentro `rinominaSezione`. */}
                                        <Btn
                                            size="sm"
                                            type="submit"
                                            disabled={!rinominaPronta}
                                            aria-disabled={isSavingName}
                                        >
                                            {isSavingName && <Loader2 size={15} className="animate-spin" />}
                                            {isSavingName ? t('sezRinominaInCorso') : t('sezRinominaConferma')}
                                        </Btn>
                                        <Btn size="sm" type="button" variant="ghost" onClick={chiudiRinomina} disabled={isSavingName}>
                                            {t('annulla')}
                                        </Btn>
                                    </div>
                                </form>
                            ) : (
                                <>
                                    <p className="mb-1 text-xs font-bold uppercase text-kidville-sub">{t('secNomeSezione')}</p>
                                    <div className="flex items-center gap-2 rounded-xl border-2 border-kidville-line bg-kidville-white p-2.5">
                                        <span className="font-maven flex-1 text-sm font-bold text-kidville-ink">{sezione.name}</span>
                                        <button
                                            ref={pulsanteRinominaRef}
                                            onClick={apriRinomina}
                                            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-kidville-green px-3 py-1.5 font-barlow text-xs font-bold uppercase tracking-[0.03em] text-kidville-green transition-transform hover:bg-kidville-green-soft active:scale-95"
                                        >
                                            <Pencil size={13} strokeWidth={2} /> {t('sezRinomina')}
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
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
