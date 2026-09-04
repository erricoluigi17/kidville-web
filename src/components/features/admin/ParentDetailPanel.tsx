'use client';

import { useState, useEffect, useId, useMemo } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useTranslations } from 'next-intl';
import { X, Save, Users, User, ChevronRight, KeyRound } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { BadgeCoerenzaCf } from '@/components/features/anagrafica/BadgeCoerenzaCf';
import { LuogoNascitaFields, type ValoreLuogoNascita } from '@/components/features/anagrafica/LuogoNascitaFields';
import { verificaCoerenza } from '@/lib/fiscale/coerenza';
import { eCfGenitoreDuplicato } from '@/lib/anagrafiche/errori-cf';
import { useDestinazioniSede, nomeSede } from './destinazioni-sede';

/**
 * ⚠️ `parents.fiscal_code` È UNIQUE, e questa è la scheda da cui si correggono i
 * codici sbagliati: scrivere su un genitore il codice che appartiene già a un altro
 * fa rispondere Postgres `23505`. Il riconoscimento di quel messaggio NON vive più
 * qui: dall'11 agosto sta in `@/lib/anagrafiche/errori-cf`, perché una regola di
 * dominio valida per più strade non può stare dentro un componente `'use client'` —
 * l'altra scheda la importava passando per questo file, cioè per un pezzo di
 * interfaccia di cui non ha nessun bisogno.
 */

/**
 * L'esito che il contenitore può restituire da `onSave`.
 *
 * ⚠️ È FACOLTATIVO di proposito: `onSave` continua a poter restituire `void`, come
 * fa oggi la pagina `/admin/students/[id]`. Un contenitore che non lo restituisce
 * non si rompe — semplicemente questa scheda non ha nulla da mostrare, e il
 * messaggio del duplicato resta invisibile finché quel contenitore non inoltra
 * l'errore. Chi lo restituisce ottiene il messaggio leggibile senza toccare altro.
 */
export interface EsitoSalvataggioGenitore {
    ok: boolean;
    /** Il messaggio GREZZO del server, così com'è: qui dentro viene tradotto. */
    errore?: string | null;
}

// Strutture dati
interface LinkedParentRef {
    id: string;
    first_name: string;
    last_name: string;
}

interface ChildStudentParent {
    relation_type: string;
    parents: LinkedParentRef;
}

interface LinkedChild {
    id: string;
    nome: string;
    cognome: string;
    classe_sezione?: string | null;
    /**
     * La sede del BAMBINO (`alunni.scuola_id`), che arriva dal `alunni (*)` del
     * fascicolo genitore.
     *
     * ⚠️ NON ESISTE LA SEDE DEL GENITORE, e non è una mancanza da colmare:
     * `parents` non ha `scuola_id`, ed è precisamente ciò che permette a una madre
     * di avere un figlio a Cesa e uno ad Aversa — in produzione sono quattro le
     * famiglie in questa condizione. Il giorno in cui questa colonna nascesse sul
     * genitore, metà di quelle famiglie risulterebbe nel plesso sbagliato.
     * Perciò qui la sede si LEGGE dai figli e non si scrive da nessuna parte:
     * `corpoGenitoreDaSalvare` è una lista bianca e `scuola_id` non è nell'elenco.
     */
    scuola_id?: string | null;
    student_parents?: ChildStudentParent[];
}

/**
 * ⚠️ `string | null` SU TUTTE LE COLONNE DI TESTO, e non è pedanteria di tipi: in
 * `parents` sono tutte nullable, e in produzione lo sono davvero (26 righe su 50 senza
 * codice fiscale, 27 senza). Dichiararle `string` obbligava chi salva a scrivere `''`
 * al posto dell'assenza — che su `birth_date` (colonna `date`) è un errore di sintassi
 * Postgres, e su `fiscal_code` (UNIQUE) è un valore che collide.
 */
interface ParentProfile {
    id: string;
    first_name: string | null;
    last_name: string | null;
    gender: string | null;
    birth_date: string | null;
    birth_city: string | null;
    birth_province?: string | null;
    birth_nation?: string | null;
    /**
     * `parents.codice_belfiore_nascita`: i quattro caratteri del comune di nascita che
     * entrano nel codice fiscale. Nullable, e in produzione quasi sempre nullo — la
     * colonna è nuova e non è stato fatto nessun backfill. Senza, il codice non è
     * calcolabile e il confronto sul luogo di nascita resta «non verificabile»: che è
     * un'informazione, non un allarme.
     */
    codice_belfiore_nascita?: string | null;
    /**
     * `| null` non è una comodità di tipizzazione: la colonna È nullable, e in
     * produzione lo è su 26 righe su 50. Dichiararla `string` costringeva chi salva
     * a mandare `''` al posto dell'assenza — su una colonna UNIQUE, dove `''` è un
     * valore e `NULL` no.
     */
    fiscal_code: string | null;
    emails: string[];
    phone_numbers: string[];
    residence_address: string | null;
    residence_street_number?: string | null;
    residence_city: string | null;
    residence_province?: string | null;
    zip_code: string | null;
    citizenship?: string | null;
    student_parents?: {
        alunni: LinkedChild | null;
        is_primary: boolean;
        relation_type: string;
    }[];
}

/** `''`/spazi ⇒ `null`: in archivio l'assenza si scrive `NULL`, non stringa vuota. */
const orNull = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()) || null;

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * IL CORPO DEL PATCH SI COSTRUISCE PER ELENCO. `...form` NON SALVAVA NIENTE.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ MISURATO, non dedotto. Fino all'11 agosto `handleSave` faceva `onSave({ id,
 * ...form })`, e `form` è il corpo INTERO di `GET /api/admin/parents/[id]` — che
 * seleziona `*` **più la relazione annidata `student_parents`** (con dentro gli
 * `alunni` e i co-genitori). Quel corpo arrivava a `PATCH /api/admin/parents`, il
 * cui schema è `.loose()`, e finiva spalmato in `update()`. PostgREST valida il
 * corpo contro la propria cache dello schema PRIMA di parlare col database e
 * risponde `PGRST204` — «Could not find the 'student_parents' column of 'parents'
 * in the schema cache» — perché `student_parents` è una TABELLA, non una colonna.
 *
 * Le due prove, lette in produzione l'11 agosto:
 *  · `app_log` → `route=/api/admin/parents`, `codice=PGRST204`, `stato_http=400`,
 *    con quel messaggio esatto, seguito da `admin/parents:PATCH` a 500;
 *  · `audit_scritture_docente` — dove `logScrittura` scrive SOLO dopo che
 *    l'`update` è riuscito — ha 405 righe dal 5 luglio, 255 delle quali `update`,
 *    e **zero** con `entita_tipo='genitori'` e `azione='update'`. Cinque `insert`,
 *    nessun aggiornamento: da questa scheda non è mai stato salvato niente.
 *
 * Quindi: si elencano le colonne che questa scheda modifica, e nient'altro parte.
 * La normalizzazione è la stessa di `buildParentRecord` (la strada dell'INSERT),
 * perché una regola valida per due strade deve dire la stessa cosa su entrambe.
 */
export function corpoGenitoreDaSalvare(form: Partial<ParentProfile>): Partial<ParentProfile> {
    return {
        first_name: orNull(form.first_name),
        last_name: orNull(form.last_name),
        gender: orNull(form.gender),
        // `''` su una colonna `date` è un errore di sintassi Postgres, non un vuoto:
        // svuotare il campo data deve poter dire «non lo so».
        birth_date: orNull(form.birth_date),
        birth_city: orNull(form.birth_city),
        birth_province: orNull(form.birth_province),
        birth_nation: orNull(form.birth_nation),
        // Nullable, e accetta solo `^[A-Z][0-9]{3}$`: una stringa vuota sarebbe un
        // valore che non esiste.
        codice_belfiore_nascita: orNull(form.codice_belfiore_nascita),
        /**
         * ⚠️ VUOTO ⇒ `null`, E QUI NON È UNA PREFERENZA DI STILE. `fiscal_code` è
         * UNIQUE (`parents_fiscal_code_key`), e per un vincolo UNIQUE la stringa
         * vuota è un valore come tutti gli altri mentre `NULL` no: due righe possono
         * essere entrambe NULL, non entrambe `''`. MISURATO in produzione l'11
         * agosto: su 50 genitori, 26 hanno `NULL` e **uno ha già la stringa vuota**.
         * Salvare `''` da questa scheda farebbe collidere il secondo genitore senza
         * codice con quell'unico, e il messaggio che ne uscirebbe («esiste già un
         * genitore con questo codice fiscale») parlerebbe di un codice che non esiste.
         */
        fiscal_code: orNull(form.fiscal_code),
        citizenship: orNull(form.citizenship),
        residence_address: orNull(form.residence_address),
        residence_street_number: orNull(form.residence_street_number),
        residence_city: orNull(form.residence_city),
        residence_province: orNull(form.residence_province)?.toUpperCase() ?? null,
        zip_code: orNull(form.zip_code),
        phone_numbers: Array.isArray(form.phone_numbers) ? form.phone_numbers : [],
        emails: Array.isArray(form.emails) ? form.emails : [],
    };
}

interface Props {
    parentBasicInfo: { id: string } | null;
    onClose: () => void;
    onSave: (data: Partial<ParentProfile> & { id: string }) => void | Promise<void | EsitoSalvataggioGenitore>;
    // 'page' = scheda a tutta area (route /admin/students/[id]); 'drawer' = pannello laterale.
    variant?: 'drawer' | 'page';
}

export function ParentDetailPanel({ parentBasicInfo, onClose, onSave, variant = 'drawer' }: Props) {
    const t = useTranslations('adminStudents');
    const [parent, setParent] = useState<ParentProfile | null>(null);
    const [form, setForm] = useState<Partial<ParentProfile>>({});
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [expandedChild, setExpandedChild] = useState<string | null>(null);
    const [regen, setRegen] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
    const [regenMsg, setRegenMsg] = useState('');
    /** Il messaggio LEGGIBILE dell'ultimo salvataggio fallito. Mai il testo grezzo del server. */
    const [erroreSalvataggio, setErroreSalvataggio] = useState<string | null>(null);

    /**
     * Radice unica degli `id`: questa scheda vive sia come pannello laterale sia a
     * tutta pagina, e in entrambi i casi convive con la barra di ricerca del cockpit.
     * Un `id` fisso qui dentro sarebbe un `htmlFor` che punta al campo di un'altra
     * scheda il giorno in cui due pannelli si aprono insieme.
     */
    const radiceId = `genitore-${useId().replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    const idBadgeCf = `${radiceId}-badge-cf`;

    /**
     * I figli collegati. Il calcolo sta QUI, sopra il `return` condizionale, perché
     * da lui dipende un hook: senza figli non c'è nessun nome di sede da risolvere e
     * l'elenco delle sedi non si chiede affatto.
     */
    const figli = useMemo(
        () => (parent?.student_parents ?? []).map((sp) => sp.alunni).filter((c): c is LinkedChild => Boolean(c)),
        [parent],
    );

    /**
     * L'anagrafica delle sedi serve QUI per una ragione sola: tradurre l'uuid di
     * `alunni.scuola_id` nel NOME del plesso. Non c'è nessuna tendina da riempire e
     * non c'è niente da spostare da questa scheda — la sede è del bambino.
     * `admin/sedi/destinazioni` e non `admin/sedi` perché per la Direzione la prima
     * copre tutte le sedi reali: un figlio in un plesso che non è fra quelli
     * dell'utente resterebbe altrimenti senza nome.
     */
    const destinazioni = useDestinazioniSede({ abilitato: figli.length > 0 });

    useEffect(() => {
        if (!parentBasicInfo) return;
        
        const fetchParentDetails = async () => {
            setIsLoading(true);
            try {
                const res = await fetch(`/api/admin/parents/${parentBasicInfo.id}`);
                if (!res.ok) throw new Error('Errore nel recupero dati');
                const data = await res.json();
                setParent(data);
                setForm(data);
            } catch {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'dettaglio-genitore-fallito', route: '/admin/students' });
            } finally {
                setIsLoading(false);
            }
        };

        fetchParentDetails();
    }, [parentBasicInfo]);

    /**
     * ─── IL CAMPO PORTA IL CODICE IN ARCHIVIO. IL CALCOLO SI *PROPONE*. ─────────
     *
     * ⚠️ Fino all'11 agosto l'`input` valeva `form.fiscal_code || calcolato` e
     * `handleSave` inviava quello stesso valore. Su questa scheda — che è quella
     * aperta sui record VERI — significava due cose, entrambe misurate: il campo non
     * si poteva svuotare (cancellandolo, il calcolato tornava alla battuta dopo), e
     * premere Salva su un genitore senza codice ne SCRIVEVA uno che nessuno aveva
     * confermato, su una colonna UNIQUE, per 27 genitori su 50.
     *
     * Il contratto corretto è quello che `BadgeCoerenzaCf` già espone: sul campo
     * vuoto il badge PROPONE il codice che l'anagrafica implica, con «Usa questo».
     * Adottarlo è un gesto. Senza quel gesto, in archivio resta l'assenza — che è
     * ciò che l'archivio dice davvero.
     *
     * `codiceAtteso` lo produce `verificaCoerenza`, che chiama `calcolaCodiceFiscale`:
     * qui non si calcola più niente a parte. Il calcolo vuole il codice catastale
     * (non il nome del comune) e vuole il sesso — che su questa scheda è spesso
     * vuoto, perché in archivio non c'è: in quel caso non c'è nulla da proporre e il
     * badge lo dice a parole.
     *
     * Tre stati distinti e mai due: incoerente (rosso, azionabile) · non verificabile
     * (giallo, manca un dato per confrontare) · da compilare (neutro). Un campo mai
     * compilato non accende niente.
     */
    const esitoCoerenza = useMemo(
        () => verificaCoerenza(form.fiscal_code ?? '', {
            nome: form.first_name,
            cognome: form.last_name,
            sesso: form.gender,
            dataNascita: form.birth_date,
            codiceBelfiore: form.codice_belfiore_nascita,
        }),
        [form.fiscal_code, form.first_name, form.last_name, form.gender, form.birth_date, form.codice_belfiore_nascita],
    );

    if (!parentBasicInfo) return null;

    /** Il luogo di nascita: qui la nomenclatura è `birth_city`, non `birth_place`. */
    const luogoNascita: ValoreLuogoNascita = {
        provincia: form.birth_province ?? '',
        comune: form.birth_city ?? '',
        nazione: form.birth_nation ?? '',
        belfiore: form.codice_belfiore_nascita ?? '',
    };

    const cambiaLuogoNascita = (v: ValoreLuogoNascita) => {
        setForm(prev => ({
            ...prev,
            birth_province: v.provincia,
            birth_city: v.comune,
            birth_nation: v.nazione,
            codice_belfiore_nascita: v.belfiore,
        }));
    };

    const handleSave = async () => {
        if (!parent) return;
        setIsSaving(true);
        setErroreSalvataggio(null);
        try {
            // ⚠️ NON `...form`: quello è il fascicolo intero del GET, `student_parents`
            // compreso, e mandarlo al PATCH faceva rispondere PGRST204 a PostgREST —
            // cioè NESSUN salvataggio, mai. Vedi `corpoGenitoreDaSalvare` qui sopra.
            const esito = await onSave({
                id: parent.id,
                ...corpoGenitoreDaSalvare(form),
            });
            // ⚠️ I DATI COMPILATI NON SI PERDONO MAI: si mostra il messaggio e basta,
            // il modulo resta esattamente com'era. Chi ha appena corretto un codice
            // fiscale non deve riscrivere l'intera scheda per colpa di un doppione.
            if (esito && esito.ok === false) {
                setErroreSalvataggio(
                    eCfGenitoreDuplicato(esito.errore) ? t('parentCfDuplicato') : t('erroreSalvataggio'),
                );
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `salvataggio-genitore-rifiutato: ${eCfGenitoreDuplicato(esito.errore) ? 'cf-duplicato' : 'altro'}`,
                    route: '/admin/students',
                });
            }
        } catch (e) {
            // Un `catch` che non logga è un bug. Il codice fiscale NON entra nel log:
            // è il dato, non l'errore.
            setErroreSalvataggio(
                eCfGenitoreDuplicato((e as Error)?.message) ? t('parentCfDuplicato') : t('erroreSalvataggio'),
            );
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `salvataggio-genitore-fallito: ${nomeErrore(e)}`,
                route: '/admin/students',
            });
        } finally {
            setIsSaving(false);
        }
    };

    const updateForm = <K extends keyof ParentProfile>(field: K, value: ParentProfile[K]) => {
        setForm(prev => ({ ...prev, [field]: value }));
    };

    const handleRegen = async () => {
        if (!parent) return;
        if (!confirm(t('parentConfermaRigenera'))) return;
        setRegen('loading');
        setRegenMsg('');
        try {
            const res = await fetch('/api/admin/regenerate-credentials', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetKind: 'parent', targetId: parent.id }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || t('errore'));
            setRegen('done');
            const esito = body.pdf_notifica
                ? t('credEmailPdf')
                : body.email_inviata
                    ? t('credEmailInviata')
                    : body.warning || t('credRigenerate');
            // ⚠️ SE IL LOGIN DI QUESTA FAMIGLIA HA CAMBIATO INDIRIZZO, SI DICE.
            //
            // L'indirizzo dell'account viene riportato su quello dell'anagrafica
            // (decisione del 2026-09-04, dopo aver misurato 4 famiglie che non
            // potevano entrare e una con 13 rigenerazioni a vuoto in un giorno).
            // È la cosa giusta da fare, ma è anche una modifica al modo in cui
            // qualcuno accede: chi ha premuto il pulsante deve leggerla adesso,
            // non scoprirla la prossima volta che quella famiglia telefona.
            setRegenMsg(body.indirizzoSpostato ? `${esito} ${body.indirizzoSpostato}` : esito);
        } catch (e) {
            setRegen('error');
            setRegenMsg((e as Error).message);
        }
    };

    const children = figli;

    const isPage = variant === 'page';
    const shellCls = isPage
        ? 'flex w-full flex-col rounded-card bg-kidville-white shadow-sm'
        : 'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-kidville-white shadow-2xl';
    const bodyCls = isPage ? 'p-5 md:p-6 space-y-5 custom-scrollbar' : 'flex-1 overflow-y-auto p-5 space-y-5 custom-scrollbar';

    return (
        <>
            {/* Backdrop — solo nel pannello laterale */}
            {!isPage && <div className="fixed inset-0 z-40 bg-kidville-green/30 backdrop-blur-[1px]" onClick={onClose} />}

            {/* Contenitore: pannello laterale oppure scheda a tutta area */}
            <div className={shellCls}>
                {/* Header */}
                <div className="flex items-center justify-between p-5 border-b border-kidville-line">
                    <div>
                        <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
                            <Users size={20} />
                            {form.citizenship === 'educator' || form.citizenship === 'coordinator'
                                ? t('parentMembroStaff')
                                : t('parentAnagrafica')}
                        </h2>
                        <p className="font-maven text-sm text-kidville-muted mt-0.5">
                            {form.first_name || ''} {form.last_name || ''}
                        </p>
                    </div>
                    {!isPage && (
                        <button
                            onClick={onClose}
                            aria-label={t('parentPanelChiudi')}
                            className="w-8 h-8 rounded-full bg-kidville-line flex items-center justify-center text-kidville-muted hover:text-kidville-ink"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>

                {isLoading ? (
                    <div className={`${isPage ? 'py-16' : 'flex-1'} flex flex-col items-center justify-center gap-4`}>
                        <div className="w-8 h-8 border-4 border-kidville-line border-t-kidville-green rounded-full animate-spin"></div>
                        <p className="font-maven text-kidville-muted">{t('parentCaricamento')}</p>
                    </div>
                ) : (
                    <div className={bodyCls}>
                        {/* Dati Anagrafici */}
                        <section>
                            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                                {t('datiPersonali')}
                            </h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label htmlFor={`${radiceId}-nome`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNome')}</label>
                                    <input
                                        id={`${radiceId}-nome`}
                                        type="text"
                                        value={form.first_name ?? ''}
                                        onChange={e => updateForm('first_name', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${radiceId}-cognome`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCognome')}</label>
                                    <input
                                        id={`${radiceId}-cognome`}
                                        type="text"
                                        value={form.last_name ?? ''}
                                        onChange={e => updateForm('last_name', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3 mt-3">
                                <div>
                                    <label htmlFor={`${radiceId}-data-nascita`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoDataNascita')}</label>
                                    <input
                                        id={`${radiceId}-data-nascita`}
                                        type="date"
                                        value={form.birth_date ?? ''}
                                        onChange={e => updateForm('birth_date', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${radiceId}-codice-fiscale`} className="font-maven text-xs text-kidville-muted mb-1 block">
                                        {t('campoCodiceFiscale')}
                                    </label>
                                    {/* ⚠️ `form.fiscal_code`, non il codice mostrato: è ciò che
                                        rende il campo SVUOTABILE. Con `value={archivio ||
                                        calcolato}` cancellarlo lo faceva ricomparire, e
                                        «questo genitore non ha un codice fiscale» non era una
                                        cosa che si potesse dire — per 27 genitori su 50. */}
                                    <input
                                        id={`${radiceId}-codice-fiscale`}
                                        type="text"
                                        value={form.fiscal_code ?? ''}
                                        onChange={e => updateForm('fiscal_code', e.target.value.toUpperCase())}
                                        maxLength={16}
                                        aria-describedby={idBadgeCf}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green uppercase"
                                    />
                                    {/* Segnala e PROPONE, non decide: da qui non esce nessun
                                        `disabled`, ed è muto sul campo mai compilato quando non
                                        c'è nemmeno un codice da proporre. */}
                                    <div className="mt-2 empty:hidden">
                                        <BadgeCoerenzaCf
                                            esito={esitoCoerenza}
                                            id={idBadgeCf}
                                            onUsaCalcolato={(codice) => updateForm('fiscal_code', codice)}
                                        />
                                    </div>
                                </div>
                            </div>
                        </section>

                        {/* Nascita e Cittadinanza */}
                        <section>
                            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                                {t('detailNascitaCittadinanza')}
                            </h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label htmlFor={`${radiceId}-sesso`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoSesso')}</label>
                                    {/* ⚠️ Il sesso non si deduce dal nome di battesimo e non ha
                                        un valore predefinito: senza, il codice fiscale non è
                                        calcolabile, e il badge lo dice invece di indovinare. */}
                                    <select
                                        id={`${radiceId}-sesso`}
                                        value={form.gender ?? ''}
                                        onChange={e => updateForm('gender', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-kidville-white focus:outline-none focus:border-kidville-green"
                                    >
                                        <option value="">{t('optSessoNonIndicato')}</option>
                                        <option value="M">{t('optMaschio')}</option>
                                        <option value="F">{t('optFemmina')}</option>
                                    </select>
                                </div>
                                {/* ⚠️ UN CAMPO SOLO al posto di tre caselle libere: da «Napoli»
                                    scritto a mano non esce nessun codice catastale, e senza
                                    quello il codice fiscale non è né calcolabile né
                                    confrontabile. Il dataset dei 13.656 comuni resta fuori dal
                                    bundle: passa dalla rotta `/api/anagrafiche/comuni`. */}
                                <div className="col-span-2">
                                    <LuogoNascitaFields
                                        valore={luogoNascita}
                                        onChange={cambiaLuogoNascita}
                                        idPrefisso={radiceId}
                                    />
                                </div>
                                <div className="col-span-2">
                                    <label htmlFor={`${radiceId}-cittadinanza`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCittadinanza')}</label>
                                    <input
                                        id={`${radiceId}-cittadinanza`}
                                        type="text"
                                        value={form.citizenship ?? ''}
                                        onChange={e => updateForm('citizenship', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                            </div>
                        </section>

                        {/* Recapiti e Residenza */}
                        <section>
                            <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                                {t('parentRecapitiResidenza')}
                            </h3>
                            {/* ⚠️ SETTE ETICHETTE SCOLLEGATE, misurate con axe l'11 agosto
                                (violazione `label`, ×7 su questa sezione più la
                                cittadinanza): `<label>` senza `htmlFor` e `<input>` senza
                                `id`. Un clic sul testo non portava il fuoco, e chi legge con
                                uno screen reader sentiva sette caselle senza nome — su una
                                scheda che contiene l'anagrafica di una persona vera. */}
                            <div className="grid grid-cols-2 gap-3">
                                <div className="col-span-2">
                                    <label htmlFor={`${radiceId}-indirizzo`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoIndirizzoResidenza')}</label>
                                    <input
                                        id={`${radiceId}-indirizzo`}
                                        type="text"
                                        value={form.residence_address ?? ''}
                                        onChange={e => updateForm('residence_address', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${radiceId}-civico`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNumeroCivico')}</label>
                                    <input
                                        id={`${radiceId}-civico`}
                                        type="text"
                                        value={form.residence_street_number ?? ''}
                                        onChange={e => updateForm('residence_street_number', e.target.value)}
                                        maxLength={20}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${radiceId}-citta`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCitta')}</label>
                                    <input
                                        id={`${radiceId}-citta`}
                                        type="text"
                                        value={form.residence_city ?? ''}
                                        onChange={e => updateForm('residence_city', e.target.value)}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${radiceId}-prov-residenza`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoProvResidenza')}</label>
                                    <input
                                        id={`${radiceId}-prov-residenza`}
                                        type="text"
                                        value={form.residence_province ?? ''}
                                        onChange={e => updateForm('residence_province', e.target.value.toUpperCase())}
                                        maxLength={2}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green uppercase focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${radiceId}-cap`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCap')}</label>
                                    <input
                                        id={`${radiceId}-cap`}
                                        type="text"
                                        value={form.zip_code ?? ''}
                                        onChange={e => updateForm('zip_code', e.target.value)}
                                        maxLength={10}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div>
                                    <label htmlFor={`${radiceId}-telefono`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoTelefono')}</label>
                                    <input
                                        id={`${radiceId}-telefono`}
                                        type="text"
                                        value={form.phone_numbers?.[0] || ''}
                                        onChange={e => {
                                            const newPhones = [...(form.phone_numbers || [])];
                                            newPhones[0] = e.target.value;
                                            updateForm('phone_numbers', newPhones);
                                        }}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                                <div className="col-span-2">
                                    <label htmlFor={`${radiceId}-email`} className="font-maven text-xs text-kidville-muted mb-1 block">{t('parentEmailPrincipale')}</label>
                                    <input
                                        id={`${radiceId}-email`}
                                        type="email"
                                        value={form.emails?.[0] || ''}
                                        onChange={e => {
                                            const newEmails = [...(form.emails || [])];
                                            newEmails[0] = e.target.value;
                                            updateForm('emails', newEmails);
                                        }}
                                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                    />
                                </div>
                            </div>
                        </section>

                        {/* ══════════════════════════════════════════════════════════════
                            FIGLI COLLEGATI — e la SEDE DI CIASCUNO, in sola lettura.

                            ⚠️ QUI NON C'È NESSUN SELETTORE DI SEDE, ed è una decisione di
                            modello dati, non di ingombro. `parents` non ha `scuola_id` e
                            non deve averla: è ciò che permette a un genitore di avere
                            figli in due plessi diversi (in produzione sono quattro le
                            famiglie in questa condizione). Un selettore qui obbligherebbe
                            a sceglierne uno, e da lì metà di quelle famiglie risulterebbe
                            altrove.

                            Ma nasconderla sarebbe l'errore opposto: senza la sede accanto
                            a ogni figlio, l'unica lettura possibile di questa scheda è
                            «questa famiglia sta a Giugliano» — che per quattro famiglie è
                            falsa. Si mostra il fatto e si dice dove si agisce: sulla
                            scheda del BAMBINO, che ha il comando «Sposta di sede». */}
                        {children.length > 0 && (
                            <section data-testid="parent-sedi-figli">
                                <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                                    <User size={12} className="text-kidville-green" />
                                    {t('parentAlunniCollegati')}
                                </h3>

                                <div className="space-y-3">
                                    {children.map((child) => {
                                        const otherParents = child.student_parents?.filter((sp) => sp.parents?.id !== parent?.id) || [];
                                        const isExpanded = expandedChild === child.id;
                                        /* Il NOME del plesso, mai il suo uuid: un uuid a schermo
                                           non dice niente a chi guarda e mette in circolo un
                                           identificativo di produzione dove non serve. Quando non
                                           si risolve — sede fuori dalle destinazioni di chi
                                           guarda, elenco non ancora letto, bambino senza sede in
                                           archivio — si scrive che manca. */
                                        const sedeFiglio = nomeSede(destinazioni.sedi, child.scuola_id);

                                        return (
                                            <div key={child.id} data-testid={`parent-figlio-${child.id}`} className="bg-kidville-cream border border-kidville-line rounded-xl overflow-hidden transition-all">
                                                {/* Header Figlio */}
                                                <div
                                                    className={`p-4 flex items-center justify-between cursor-pointer hover:bg-kidville-line ${isExpanded ? 'bg-kidville-green/5 border-b border-kidville-green/10' : ''}`}
                                                    onClick={() => setExpandedChild(isExpanded ? null : child.id)}
                                                >
                                                    <div>
                                                        <h4 className="font-barlow font-bold text-kidville-ink uppercase tracking-wide">
                                                            {child.nome} {child.cognome}
                                                        </h4>
                                                        <p className="font-maven text-xs text-kidville-muted mt-0.5">
                                                            {child.classe_sezione || t('detailNessunaSezione')}
                                                        </p>
                                                        <p className="font-maven text-xs text-kidville-sub mt-0.5">
                                                            <span>{t('parentSedeFiglio')}: </span>
                                                            <span className="font-semibold">{sedeFiglio ?? t('parentSedeFiglioSconosciuta')}</span>
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] font-bold uppercase tracking-wider bg-kidville-green/10 text-kidville-green px-2 py-1 rounded-md">
                                                            {t('parentFiglio')}
                                                        </span>
                                                        <ChevronRight size={16} className={`text-kidville-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                                                    </div>
                                                </div>

                                                {/* Dettagli Altri Familiari (A Soffietto) */}
                                                <AnimatePresence>
                                                    {isExpanded && (
                                                        <motion.div
                                                            initial={{ height: 0, opacity: 0 }}
                                                            animate={{ height: 'auto', opacity: 1 }}
                                                            exit={{ height: 0, opacity: 0 }}
                                                            className="overflow-hidden"
                                                        >
                                                            <div className="p-4 bg-kidville-white/50">
                                                                {otherParents.length > 0 ? (
                                                                    <>
                                                                        <h5 className="font-maven text-[10px] text-kidville-muted uppercase tracking-wider mb-2 font-bold">{t('parentAltriFamiliari')}</h5>
                                                                        <div className="space-y-2">
                                                                            {otherParents.map((sp) => (
                                                                                <div key={sp.parents.id} className="flex items-center gap-3 p-3 bg-kidville-white border border-kidville-line rounded-lg shadow-sm">
                                                                                    <div className="w-8 h-8 rounded-full bg-kidville-info-soft text-kidville-info flex items-center justify-center">
                                                                                        <User size={14} />
                                                                                    </div>
                                                                                    <div>
                                                                                        <p className="font-barlow font-bold text-sm text-kidville-ink leading-tight">
                                                                                            {sp.parents.first_name} {sp.parents.last_name}
                                                                                        </p>
                                                                                        <p className="font-maven text-[10px] text-kidville-muted capitalize mt-0.5">
                                                                                            {sp.relation_type === 'mother' ? t('ruoloMadre') : sp.relation_type === 'father' ? t('ruoloPadre') : t('ruoloDelegato')}
                                                                                        </p>
                                                                                    </div>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    </>
                                                                ) : (
                                                                    <p className="font-maven text-xs text-kidville-muted text-center py-2">{t('parentNessunAltroFamiliare')}</p>
                                                                )}
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Il rimando. Non è cortesia: senza, chi cerca «dove si
                                    cambia la sede» conclude che il comando manchi, e la
                                    strada che resta è la `UPDATE` a mano sul database. */}
                                <p data-testid="parent-sedi-figli-nota" className="mt-3 font-maven text-xs text-kidville-sub">
                                    {t('parentSediFigliNota')}
                                </p>
                            </section>
                        )}
                    </div>
                )}

                {/* Footer actions */}
                <div className="flex-shrink-0 p-5 border-t border-kidville-line bg-kidville-white space-y-2">
                    {/* In pagina, non in un `alert()`: il messaggio si legge, si copia, e
                        soprattutto NON butta via quello che l'operatore ha appena scritto. */}
                    {erroreSalvataggio && (
                        <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
                            {erroreSalvataggio}
                        </p>
                    )}
                    {/* ⚠️ `text-kidville-yellow-ink`, non `text-kidville-yellow`: sul verde
                        di casa il giallo pieno sta a 4,05:1, cioè SOTTO l'AA per il testo
                        normale, ed è il criterio che `__tests__/a11y/contrasto-cascata.test.tsx`
                        misura. Era preesistente e stava sul bottone principale della scheda. */}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="w-full h-12 rounded-pill bg-kidville-green text-kidville-yellow-ink font-barlow font-black uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {isSaving ? (
                            <div className="w-5 h-5 border-2 border-kidville-yellow-ink/40 border-t-kidville-yellow-ink rounded-full animate-spin" />
                        ) : (
                            <>
                                <Save size={16} />
                                {t('salvaModifiche')}
                            </>
                        )}
                    </button>
                    <button
                        onClick={handleRegen}
                        disabled={regen === 'loading' || !parent}
                        className="w-full h-11 rounded-pill border-2 border-kidville-green/40 text-kidville-green font-barlow font-bold uppercase text-sm hover:bg-kidville-green/5 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        <KeyRound size={15} /> {regen === 'loading' ? t('parentRigenerazione') : t('rigeneraCredenziali')}
                    </button>
                    {regenMsg && (
                        <p className={`text-xs text-center font-maven ${regen === 'error' ? 'text-kidville-error' : 'text-kidville-success'}`}>{regenMsg}</p>
                    )}
                </div>
            </div>
        </>
    );
}
