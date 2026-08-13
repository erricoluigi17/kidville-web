'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { X, Archive, Save, AlertTriangle, Undo2, Users, Baby } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { LinkedAdultProfile, AdultProfileData, AdultType } from './LinkedAdultProfile';
import { Task } from '../teacher/tasks/TaskCard';
import { StudentEconomicSection } from './StudentEconomicSection';
import { AllergeniSelect } from './AllergeniSelect';
import { BadgeCoerenzaCf, badgeHaQualcosaDaDire } from '@/components/features/anagrafica/BadgeCoerenzaCf';
import { LuogoNascitaFields, type ValoreLuogoNascita } from '@/components/features/anagrafica/LuogoNascitaFields';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { verificaCoerenza } from '@/lib/fiscale/coerenza';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { formattaIstante } from '@/i18n/config';

interface Student {
    id: string;
    nome?: string;
    cognome?: string;
    first_name?: string;
    last_name?: string;
    data_nascita?: string;
    gender?: string | null;
    citizenship?: string | null;
    birth_nation?: string | null;
    birth_city?: string | null;
    birth_province?: string | null;
    /**
     * Il codice catastale del luogo di nascita (`alunni.codice_belfiore_nascita`,
     * migrazione `20260810094625`). `undefined` su un ambiente non ancora migrato —
     * il DB E2E della CI risponde `42703` a una `select` che lo nomina — e `null` su
     * tutte le righe vere: al 2026-08-10 le righe valorizzate sono 0 su 83, e il caso
     * che gira davvero è «colonna vuota, comune scritto a mano».
     */
    codice_belfiore_nascita?: string | null;
    residence_address?: string | null;
    residence_street_number?: string | null;
    residence_city?: string | null;
    residence_province?: string | null;
    zip_code?: string | null;
    classe_sezione?: string | null;
    // Sede del bambino: è il perimetro entro cui una classe ha senso. Arriva
    // dalla `select *` di GET /api/admin/students/[id].
    scuola_id?: string | null;
    stato?: string;
    /**
     * LE TRE COLONNE DELL'ARCHIVIAZIONE (migrazione `20260812194517`), e perché
     * questa scheda deve leggerle invece di ignorarle come faceva fino al
     * 2026-08-13.
     *
     * Senza `archiviato_il` il pannello non sa se ha davanti un bambino
     * archiviato, e da lì discendevano due difetti che si sommavano:
     *  · offriva «Sposta fra i non iscritti» anche a chi era già fuori — e chi lo
     *    premeva riceveva un 409 DOPO aver letto il riquadro con le promesse e
     *    aver confermato;
     *  · l'unico comando di ciclo di vita che gli funzionava era la tendina
     *    «Stato», che è la strada sbagliata: rimette `iscritto` senza restituire
     *    la classe, e il bambino sparisce da ogni elenco per sezione.
     * È la scheda a cui manda il bottone «Apri scheda» dell'elenco dei «non più
     * iscritti»: chi ci arriva ci arriva apposta.
     *
     * `undefined` su un ambiente non ancora migrato — il DB E2E della CI risponde
     * `42703` — e in quel caso la scheda si comporta come prima: `!= null` è
     * falso, quindi nessun banner e nessun blocco. Assente non è archiviato.
     */
    archiviato_il?: string | null;
    archiviato_classe_sezione?: string | null;
    spazio_liberato_il?: string | null;
    data_iscrizione?: string | null;
    giorno_scadenza_pagamenti?: number | null;
    note_mediche?: string | null;
    allergeni?: string[] | null;
    allergies?: string | null;
    codice_fiscale?: string | null;
    fiscal_code?: string | null;
    bes?: boolean;
    note_bes?: string | null;
    // Liberatoria foto/video (galleria): senza consenso il bambino compare solo
    // in foto individuali visibili ai suoi genitori (regola "foto privata").
    consenso_privacy?: boolean | null;
    // Gli altri due CANALI, distinti per legge dal primo e fra loro: sito web
    // pubblico (bucket `news`, nessun login) e canali social (fuori dai nostri
    // sistemi). `undefined` su un ambiente non ancora migrato: il comando resta
    // spento e il salvataggio non nomina la colonna che non c'è.
    consenso_foto_sito?: boolean | null;
    consenso_foto_social?: boolean | null;
    emails?: string[];
    phone_numbers?: string[];
    student_parents?: {
        relation_type: string;
        is_primary: boolean;
        parents: AdultProfileData;
    }[];
    delegates?: AdultProfileData[];
    // Dati economici (modulo Pagamenti)
    importo_retta_mensile?: number | null;
    genitori_separati?: boolean | null;
    retta_split_config?: { quote: { adult_id?: string; nome?: string; importo: number }[] } | null;
    intestatario_fatture?: { tipo: 'adult' | 'altro'; adult_id?: string; nome?: string; dati?: Record<string, string> } | null;
}

interface Sibling {
    id: string;
    nome: string;
    cognome: string;
    data_nascita?: string;
    classe_sezione?: string | null;
    stato?: string;
}

interface Props {
    student: Student | null;
    onClose: () => void;
    onSave: (data: Partial<Student> & { id: string }) => void;
    /**
     * Sposta l'alunno fra i «non più iscritti» (`POST /api/admin/students/archivia`).
     *
     * ⚠️ RESTITUISCE L'ESITO, e non è un dettaglio di firma: fino al 2026-08-12 qui
     * c'era `onDelete: (id: string) => void`, cioè una funzione che non poteva dire
     * com'era andata. Il chiamante mostrava un «❌ Errore» generico e riportava
     * comunque l'operatore alla lista dopo 900 ms — con il messaggio del server già
     * letto e buttato via. La stessa correzione era GIÀ stata fatta sul ramo dei
     * genitori (`onSave` di `ParentDetailPanel`) e non era mai stata propagata qui.
     */
    onArchive: (id: string) => Promise<{ ok: boolean; errore?: string | null }>;
    /**
     * Riporta l'alunno fra gli iscritti (`POST /api/admin/students/riattiva`).
     *
     * ⚠️ È OBBLIGATORIA, e la scelta è deliberata. Un `prop` opzionale che nessuno
     * passa è il difetto che questo stesso lavoro ha già prodotto una volta
     * (`onLiberaSpazio`, rimosso): compila, non rompe niente, e lascia in piedi un
     * comando che non funziona. Qui il compilatore obbliga ogni punto di montaggio
     * a dichiarare la strada del ritorno — che è l'unica strada giusta, perché
     * `riattiva` rimette lo stato E ripristina la classe dopo averne verificato
     * l'esistenza nella sede, mentre la tendina «Stato» rimetteva solo lo stato.
     */
    onRiattiva: (id: string) => Promise<{ ok: boolean; errore?: string | null }>;
    // 'page' = scheda a tutta area (route /admin/students/[id]); 'drawer' = pannello
    // laterale storico. Il default resta 'drawer' per retro-compatibilità.
    variant?: 'drawer' | 'page';
}

export function StudentDetailPanel({ student, onClose, onSave, onArchive, onRiattiva, variant = 'drawer' }: Props) {
    const t = useTranslations('adminStudents');
    const locale = useLocale();
    // Il pannello è montato per-alunno ({selectedStudent && <StudentDetailPanel/>}):
    // form inizializzato dal prop, niente state+effect (react-hooks/set-state-in-effect).
    const [form, setForm] = useState<Partial<Student>>(() => (student ? { ...student } : {}));
    /** Primo clic: si chiede conferma. Secondo clic: si archivia. */
    const [confermaArchiviazione, setConfermaArchiviazione] = useState(false);
    const [archiviazioneInCorso, setArchiviazioneInCorso] = useState(false);
    /**
     * Il messaggio DEL SERVER, quando l'archiviazione è stata rifiutata.
     *
     * Vive qui e non in un toast della pagina perché la scheda NON si smonta sul
     * fallimento: l'operatore deve poter leggere il motivo e riprovare, invece di
     * ritrovarsi nella lista con un «❌ Errore» che sta sparendo.
     */
    const [erroreArchiviazione, setErroreArchiviazione] = useState<string | null>(null);
    /** Il ritorno è in volo: serve solo all'etichetta del comando. */
    const [riattivazioneInCorso, setRiattivazioneInCorso] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [activeAdultTab, setActiveAdultTab] = useState<string | null>(null);
    const [sections, setSections] = useState<{id: string, name: string, school_type: string}[]>([]);
    const [siblings, setSiblings] = useState<Sibling[]>([]);
    // NB: niente setLoading(true) sincrono negli effect (react-hooks/set-state-in-effect):
    // i loading partono già true al mount, i loader li spengono in finally.
    const [siblingsLoading, setSiblingsLoading] = useState(true);

    // Complaints / Reports states
    const [studentTasks, setStudentTasks] = useState<Task[]>([]);
    const [tasksLoading, setTasksLoading] = useState(true);

    // Sezioni della SEDE del bambino: una classe di un altro plesso non è una
    // destinazione possibile (il server la rifiuta da W2-C), quindi non deve
    // nemmeno comparire nella tendina. Senza sede sulla riga non si chiede nulla:
    // non esiste perimetro entro cui una classe sia lecita.
    const sedeAlunno = student?.scuola_id ?? null;
    useEffect(() => {
        if (!sedeAlunno) return;
        let annullato = false;
        fetch(`/api/admin/sections?scuola_id=${encodeURIComponent(sedeAlunno)}`)
            .then(r => r.json())
            .then(d => { if (!annullato && Array.isArray(d)) setSections(d); })
            .catch((err) => {
                logClient({ livello: 'error', evento: 'fetch', messaggio: `sezioni-sede-caricamento-fallito: ${nomeErrore(err)}` });
            });
        return () => { annullato = true; };
    }, [sedeAlunno]);

    useEffect(() => {
        if (!student?.id) return;
        const sid = student.id;
        const load = async () => {
            try {
                const res = await fetch(`/api/admin/students/${sid}`).catch(() => null);
                const d = res?.ok ? await res.json().catch(() => null) : null;
                if (Array.isArray(d?.siblings)) setSiblings(d.siblings);
            } finally {
                setSiblingsLoading(false);
            }
        };
        load();
    }, [student?.id]);

    useEffect(() => {
        if (!student?.id) return;
        const sid = student.id;
        const load = async () => {
            try {
                // Identità session-only (M4): senza id risolto non si interroga l'API.
                const uid = getCurrentTeacherId(null);
                if (!uid) return;
                const res = await fetch(`/api/tasks?studentId=${sid}&userId=${uid}`).catch(() => null);
                const d = res?.ok ? await res.json().catch(() => null) : null;
                if (Array.isArray(d)) setStudentTasks(d);
            } finally {
                setTasksLoading(false);
            }
        };
        load();
    }, [student?.id]);

    /**
     * ─── IL CODICE FISCALE, IN QUESTA SCHEDA, NON SI SCRIVE DA SOLO ─────────────
     *
     * Qui si aprono i record VERI: 33 alunni, di cui 18 senza codice fiscale e 18 senza
     * comune di nascita (misura sul database di produzione, 2026-08-10). Nei due moduli
     * di NUOVA anagrafica il campo vuoto si riempie col codice calcolato, e va bene:
     * non c'è niente in archivio da contraddire. Qui no. Riempire il campo da soli
     * significherebbe che chi apre una scheda per cambiare un numero di telefono e
     * preme «Salva» scrive in archivio un codice fiscale che nessun documento ha mai
     * confermato — su 18 bambini, in silenzio, con il gate verde.
     *
     * Perciò il calcolo qui PROPONE e basta: sta dentro l'esito (`codiceAtteso`), e il
     * badge lo offre col proprio pulsante «Usa questo» — che riempie il campo e non
     * salva niente. Il salvataggio resta un gesto solo, quello in fondo alla scheda.
     */
    const codiceFiscaleAttuale = ((form.codice_fiscale as string) ?? '').trim().toUpperCase();
    const codiceBelfiore = (form.codice_belfiore_nascita as string | null | undefined) ?? '';

    /**
     * L'`id` del badge, e il perché è SCRITTO invece di lasciare il default.
     *
     * `role="status"` non promette nessun annuncio (lo dice la testata di
     * `BadgeCoerenzaCf`): la via dichiarata per SENTIRE il verdetto è
     * `aria-describedby` dal campo del codice fiscale. Senza un `id` esplicito tutte
     * le schede erediterebbero lo stesso `badge-coerenza-cf` — e `dettaglio-` lo
     * distingue da `alunno-` (nuova anagrafica) e da `adulto-…` (le tre schede
     * adulto), che nel cockpit possono stare nella stessa pagina.
     *
     * Statico e non `useId()`, a differenza delle schede adulto: quelle
     * `FamilyRegistryManager` le tiene montate TUTTE insieme (madre, padre, ogni
     * delegato) e un prefisso fisso le farebbe puntare al badge di un'altra persona.
     * Di questo pannello, invece, ne esiste uno solo per volta — è montato
     * per-alunno (`{selectedStudent && <StudentDetailPanel/>}`).
     */
    const idBadgeCf = 'dettaglio-badge-coerenza-cf';

    /**
     * I TRE STATI, e perché non possono diventare due. `verificaCoerenza` distingue
     * «c'è un codice e contraddice l'anagrafica» (rosso, azionabile) da «manca un dato
     * per confrontare» (giallo) da «non c'è nessun codice da verificare» (niente): con
     * 45 record su 83 privi del codice fiscale, confondere il giallo col rosso
     * dipingerebbe di rosso metà archivio e il pannello smetterebbe di essere guardato
     * il primo giorno. Il badge riceve l'esito intero e decide da sé quale dei tre
     * mostrare — e se mostrarne uno.
     */
    const esitoCoerenza = useMemo(
        () => verificaCoerenza(codiceFiscaleAttuale, {
            nome: (form.nome as string) ?? '',
            cognome: (form.cognome as string) ?? '',
            sesso: (form.gender as string) ?? null,
            dataNascita: (form.data_nascita as string) ?? '',
            codiceBelfiore,
        }),
        [codiceFiscaleAttuale, form.nome, form.cognome, form.gender, form.data_nascita, codiceBelfiore],
    );

    /**
     * ⚠️ IL CAMPO PUNTA AL BADGE SOLO SE IL BADGE C'È. `BadgeCoerenzaCf` restituisce
     * `null` quando non ha niente da dire, e fino all'11 agosto qui `aria-describedby`
     * era incondizionato: su una scheda senza codice fiscale lo screen reader
     * annunciava un campo che rimanda a una descrizione INESISTENTE.
     *
     * Non era il caso di laboratorio: al 2026-08-11 in produzione 18 alunni su 33 non
     * hanno il codice fiscale, 17 non hanno il sesso e `codice_belfiore_nascita` è NULL
     * su 83 record su 83 — senza sesso e senza codice catastale non c'è nemmeno il
     * codice calcolato da proporre, quindi il badge non compare. Lo stato rotto era
     * quello ORDINARIO di questa scheda.
     *
     * La condizione non si riscrive qui: la decide il predicato del badge, che è
     * l'unico posto in cui quella regola vive (`badgeHaQualcosaDaDire`). Misurato in
     * `__tests__/a11y/schede-alunno-a11y.test.tsx`.
     */
    const badgeVisibile = badgeHaQualcosaDaDire(esitoCoerenza);

    if (!student) return null;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            /**
             * `codice_belfiore_nascita` viaggia SEMPRE, anche quando vale `null`: è
             * l'unico modo perché la scelta «questo comune non lo riconosco» resti
             * scritta invece di essere indovinata alla lettura successiva. La chiave
             * è scritta ESPLICITAMENTE dopo lo spread perché su una riga che arriva da
             * un ambiente non migrato la proprietà non c'è affatto (`select *` senza
             * quella colonna), e `...form` non può portare ciò che non esiste: senza
             * questa riga il payload uscirebbe SENZA la chiave, che per la rotta
             * significa «non toccare» e non «azzera». Misurato in
             * `StudentDetailPanel-codice-fiscale.test.tsx` §3, con una fixture che la
             * chiave non ce l'ha: tolta questa riga, quel test diventa rosso.
             *
             * ⚠️ FINO ALL'11 AGOSTO QUESTO VALORE NON ARRIVAVA IN COLONNA — riparato,
             * e la storia resta scritta perché è la ragione per cui il collaudo che la
             * sorveglia esiste. Non mancava la migrazione: `alunni.codice_belfiore_nascita`
             * esiste in produzione ed è nullable (misurato l'11 agosto su
             * `information_schema.columns`). Mancava nella rotta, in QUATTRO punti di
             * `src/app/api/admin/students/route.ts` — e la prima stesura di questo
             * commento ne elencava tre, dimenticando proprio quello del PATCH:
             *
             *   1. `postBodySchema` (riga 26) — uno `z.object` NON strict, che quindi
             *      scartava la chiave prima dell'handler senza errore e senza log;
             *   2. `patchBodySchema` (riga 92) — stessa forma di guasto sulla strada
             *      che questa scheda percorre davvero, ed è quella che l'elenco
             *      precedente non nominava: senza, il PATCH rispondeva `200` su un
             *      campo mai scritto;
             *   3. l'oggetto `record` del POST (riga 300, accanto a `birth_nation` /
             *      `birth_city` / `birth_province`);
             *   4. `allowedFields` del PATCH singolo (riga 638), altrimenti il ciclo
             *      `if (body[field] !== undefined)` la ignora.
             *
             * Il campo PERSISTE dall'11 agosto 2026. La misura che chiude la catena —
             * POST e PATCH, il valore che sopravvive fino al record scritto, e il
             * degrado tracciato dove la colonna non c'è — è
             * `__tests__/api/admin-students-belfiore.test.ts`: questa scheda verifica il
             * PAYLOAD, e un payload corretto contro una rotta che lo scarta è verde in
             * perpetuo mentre in archivio non arriva niente.
             *
             * PERCHÉ IL CODICE CATASTALE SERVE, che è la parte che non invecchia: da
             * «Napoli» scritto a mano non esce nessun codice fiscale — `F839` sì. È il
             * dato che rende il codice CALCOLABILE e VERIFICABILE, e senza di lui questa
             * scheda si riapre col comune marcato «valore in archivio, non riconosciuto»
             * e il badge fermo su «non verificabile». Non è un requisito d'iscrizione:
             * `null` resta un valore legittimo, ed è il caso di ogni riga già in archivio.
             *
             * Sull'ambiente non migrato (il DB E2E della CI: `PGRST204` in scrittura,
             * `42703` in lettura) la colonna viene scartata e il resto della scheda si
             * salva comunque: nessun campo di questa pagina dipende da lei, e il badge
             * continua a dire «non verificabile» invece di «sbagliato».
             */
            await onSave({
                id: student.id,
                ...form,
                codice_belfiore_nascita: (form.codice_belfiore_nascita as string | null | undefined) ?? null,
            });
        } finally {
            setIsSaving(false);
        }
    };

    /**
     * IL DOPPIO CLIC RESTA, IL ROSSO NO.
     *
     * La conferma in due tempi era l'unica protezione di una cancellazione
     * irreversibile, ed era troppo poca; per un'operazione REVERSIBILE è invece la
     * misura giusta — ferma il clic distratto senza chiedere a una segretaria di
     * digitare il nome di un bambino per spostarlo di elenco. Cambia il TONO:
     * `warn`, non `error`, perché qui non si distrugge niente.
     *
     * Sull'esito: si sta dentro la scheda. `ok` lascia la parola al chiamante (che
     * mostra il messaggio e torna alla lista); il rifiuto resta qui, sotto gli occhi
     * di chi ha premuto, con la frase che il server ha mandato.
     */
    const handleArchive = async () => {
        if (!confermaArchiviazione) {
            setConfermaArchiviazione(true);
            return;
        }
        setArchiviazioneInCorso(true);
        setErroreArchiviazione(null);
        try {
            const esito = await onArchive(student.id);
            if (esito?.ok) {
                setConfermaArchiviazione(false);
                return;
            }
            // `errore` assente (rete caduta, corpo non JSON) non vale silenzio: una
            // frase generica è comunque un fatto, «niente» è indistinguibile dal
            // successo — che è il difetto da cui nasce tutta questa correzione.
            setErroreArchiviazione(esito?.errore || t('detailArchiviaErrore'));
        } finally {
            setArchiviazioneInCorso(false);
        }
    };

    /**
     * IL RITORNO, DALLA SCHEDA — il comando che a questa scheda mancava.
     *
     * Chi apre la scheda di un archiviato ci arriva quasi sempre dal bottone
     * «Apri scheda» dell'elenco dei «non più iscritti», cioè con in testa una
     * domanda su QUEL bambino. Fino al 2026-08-13 qui trovava soltanto «Sposta fra
     * i non iscritti» — che gli rispondeva 409 dopo la conferma — e la tendina
     * «Stato», che è la strada che rompe la riga. Adesso trova il comando giusto.
     *
     * ⚠️ NIENTE DOPPIO CLIC, e non è una dimenticanza: la conferma in due tempi
     * dell'archiviazione esiste perché quella operazione toglie un bambino da
     * tutti gli elenchi. Questa fa l'opposto — lo rimette dov'era — ed è a sua
     * volta annullabile con un gesto solo. Chiedere una conferma per rimettere
     * dentro un bambino sarebbe cerimonia, non prudenza.
     *
     * L'esito segue la stessa regola dell'archiviazione: il successo è del
     * chiamante (annuncia e torna alla lista), il rifiuto resta qui sotto gli
     * occhi di chi ha premuto.
     */
    const handleRiattiva = async () => {
        setRiattivazioneInCorso(true);
        setErroreArchiviazione(null);
        try {
            const esito = await onRiattiva(student.id);
            if (esito?.ok) return;
            setErroreArchiviazione(esito?.errore || t('detailRiattivaErrore'));
        } finally {
            setRiattivazioneInCorso(false);
        }
    };

    const updateForm = (field: string, value: unknown) => {
        setForm(prev => ({ ...prev, [field]: value }));
    };

    /**
     * La nomenclatura di QUESTA scheda è `birth_city` / `birth_province` /
     * `birth_nation` — le colonne di `alunni`. I due moduli di nuova anagrafica usano
     * `comune_nascita` / `provincia_nascita` / `nazione_nascita`, che è lo stesso dato
     * con un altro nome: mescolarli significa scrivere in una colonna che non esiste.
     */
    const luogoNascita: ValoreLuogoNascita = {
        provincia: (form.birth_province as string) ?? '',
        comune: (form.birth_city as string) ?? '',
        nazione: (form.birth_nation as string) ?? '',
        belfiore: codiceBelfiore,
    };

    const cambiaLuogoNascita = (v: ValoreLuogoNascita) => {
        // Un aggiornamento solo: quattro `updateForm` di fila sarebbero quattro
        // disegni, e il terzo leggerebbe un `form` in cui la provincia è già cambiata
        // e il comune no.
        setForm(prev => ({
            ...prev,
            birth_province: v.provincia,
            birth_city: v.comune,
            birth_nation: v.nazione,
            codice_belfiore_nascita: v.belfiore,
        }));
    };

    /**
     * Il contratto del pulsante «Usa questo» del badge: riempie il campo e nulla più.
     * Nessun `onSave` qui dentro — un pulsante che scrive in archivio senza dirlo è il
     * modo più rapido di far perdere fiducia a una segreteria, e su 18 bambini senza
     * codice fiscale sarebbe una scrittura di massa che nessuno ha chiesto.
     */
    const applicaCodiceCalcolato = (codice: string) => {
        updateForm('codice_fiscale', codice);
    };

    // Estrai madre, padre e delegati per i tab
    const getAdultTabs = () => {
        const tabs: { id: string; type: AdultType; label: string; data: AdultProfileData }[] = [];
        
        if (student?.student_parents) {
            student.student_parents.forEach(sp => {
                if (sp.parents) {
                    if (sp.relation_type === 'mother' || sp.parents.gender === 'F') {
                        tabs.push({ id: 'mother', type: 'mother', label: t('ruoloMadre'), data: sp.parents });
                    } else if (sp.relation_type === 'father' || sp.parents.gender === 'M') {
                        tabs.push({ id: 'father', type: 'father', label: t('ruoloPadre'), data: sp.parents });
                    } else {
                        tabs.push({ id: `parent_${sp.parents.id}`, type: 'delegate', label: t('ruoloGenitore'), data: sp.parents });
                    }
                }
            });
        }

        if (student?.delegates) {
            student.delegates.forEach((del, idx) => {
                tabs.push({ id: `delegate_${del.id}`, type: 'delegate', label: t('detailDelegatoN', { n: idx + 1 }), data: del });
            });
        }

        return tabs;
    };

    const adultTabs = getAdultTabs();
    const activeTabData = adultTabs.find(t => t.id === activeAdultTab);

    // Classe corrente non presente fra le sezioni caricate: va mostrata comunque.
    const classeCorrente = (form.classe_sezione as string) ?? '';
    const classeFuoriElenco =
        classeCorrente && !sections.some(s => s.name === classeCorrente) ? classeCorrente : null;

    /**
     * ⚠️ SI LEGGE DA `student`, NON DA `form`, ed è una differenza che conta.
     *
     * `form` è la copia modificabile: `archiviato_il` non è un campo che si
     * modifica, e prenderlo da lì vorrebbe dire far dipendere il blocco della
     * tendina da uno stato che l'interfaccia può cambiare sotto i piedi. Qui il
     * fatto è del server e non si negozia.
     *
     * `!= null` e non `Boolean(...)`: su un ambiente non migrato la proprietà è
     * `undefined` e la scheda torna a comportarsi come prima. Assente ≠ archiviato.
     */
    const archiviato = student.archiviato_il != null;
    const archiviatoIl = typeof student.archiviato_il === 'string'
        ? formattaIstante(student.archiviato_il, locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
        : '';
    const eraIn = typeof student.archiviato_classe_sezione === 'string' && student.archiviato_classe_sezione !== ''
        ? student.archiviato_classe_sezione
        : null;

    const isPage = variant === 'page';
    const shellCls = isPage
        ? 'flex w-full flex-col rounded-card bg-kidville-white shadow-sm'
        : 'fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-kidville-white shadow-2xl';
    const bodyCls = isPage ? 'p-5 md:p-6 space-y-5' : 'flex-1 overflow-y-auto p-5 space-y-5';

    return (
        <>
            {/* Backdrop — solo nel pannello laterale */}
            {!isPage && <div className="fixed inset-0 z-40 bg-kidville-green/30 backdrop-blur-[1px]" onClick={onClose} />}

            {/* Contenitore: pannello laterale oppure scheda a tutta area */}
            <div className={shellCls}>
                {/* Header */}
                <div className="flex items-center justify-between p-5 border-b border-kidville-line">
                    <div>
                        <h2 className="font-barlow font-black text-xl text-kidville-green uppercase tracking-wide">
                            {t('detailSchedaAlunno')}
                        </h2>
                        <p className="font-maven text-sm text-kidville-muted">
                            {student.nome} {student.cognome}
                        </p>
                    </div>
                    {!isPage && (
                        <button
                            onClick={onClose}
                            aria-label={t('detailChiudiScheda')}
                            className="w-8 h-8 rounded-full bg-kidville-line flex items-center justify-center text-kidville-muted hover:text-kidville-ink"
                        >
                            <X size={16} />
                        </button>
                    )}
                </div>

                {/* Scrollable Form */}
                <div className={bodyCls}>
                    {/* Dati Anagrafici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('detailDatiAnagrafici')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label htmlFor="dettaglio-nome" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNome')}</label>
                                <input
                                    id="dettaglio-nome"
                                    type="text"
                                    value={(form.nome as string) ?? ''}
                                    onChange={e => updateForm('nome', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label htmlFor="dettaglio-cognome" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCognome')}</label>
                                <input
                                    id="dettaglio-cognome"
                                    type="text"
                                    value={(form.cognome as string) ?? ''}
                                    onChange={e => updateForm('cognome', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 mt-3">
                            <div>
                                <label htmlFor="dettaglio-data-nascita" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoDataNascita')}</label>
                                <input
                                    id="dettaglio-data-nascita"
                                    type="date"
                                    value={(form.data_nascita as string) ?? ''}
                                    onChange={e => updateForm('data_nascita', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label htmlFor="dettaglio-codice-fiscale" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCodiceFiscale')}</label>
                                <input
                                    id="dettaglio-codice-fiscale"
                                    type="text"
                                    value={(form.codice_fiscale as string) ?? ''}
                                    onChange={e => updateForm('codice_fiscale', e.target.value.toUpperCase())}
                                    maxLength={16}
                                    // Il verdetto si sente arrivando sul campo, una volta
                                    // sola: senza questo, chi legge con uno screen reader
                                    // non riceve mai il badge (vedi `idBadgeCf` sopra).
                                    // `undefined` quando il badge non c'è: un rimando a un
                                    // elemento inesistente è peggio di nessun rimando.
                                    aria-describedby={badgeVisibile ? idBadgeCf : undefined}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green uppercase"
                                />
                            </div>
                        </div>

                        {/* ─── VERIFICA DEL CODICE FISCALE ────────────────────────────
                            Il badge è SEMPRE montato: è lui a sapere se c'è qualcosa da
                            dire. Non blocca niente — «Salva Modifiche» funziona identico
                            con il badge rosso, e deve: la segreteria corregge un indirizzo
                            anche su una scheda il cui codice fiscale non torna. */}
                        <div className="mt-3">
                            <BadgeCoerenzaCf esito={esitoCoerenza} id={idBadgeCf} onUsaCalcolato={applicaCodiceCalcolato} />
                        </div>
                    </section>

                    {/* Nascita e Cittadinanza */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('detailNascitaCittadinanza')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label htmlFor="dettaglio-sesso" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoSesso')}</label>
                                <select
                                    id="dettaglio-sesso"
                                    value={(form.gender as string) ?? ''}
                                    onChange={e => updateForm('gender', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-kidville-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="">—</option>
                                    <option value="M">{t('optMaschio')}</option>
                                    <option value="F">{t('optFemmina')}</option>
                                </select>
                            </div>
                            {/* ⚠️ TRE CASELLE DI TESTO LIBERO SONO DIVENTATE UN CAMPO SOLO.
                                Da «Napoli» scritto a mano non esce nessun codice
                                catastale, e senza quello il codice fiscale non è
                                calcolabile né verificabile: erano 18 alunni su 33 con il
                                comune di nascita vuoto e nessuna strada per riempirlo in
                                modo utile. Il testo GIÀ IN ARCHIVIO non si perde — un
                                comune che la tendina non riconosce resta scritto com'è, e
                                il badge dice «non verificabile», non «sbagliato». */}
                            <div className="col-span-2">
                                <LuogoNascitaFields
                                    valore={luogoNascita}
                                    onChange={cambiaLuogoNascita}
                                    idPrefisso="dettaglio-alunno"
                                />
                            </div>
                            <div className="col-span-2">
                                <label htmlFor="dettaglio-cittadinanza" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCittadinanza')}</label>
                                <input
                                    id="dettaglio-cittadinanza"
                                    type="text"
                                    value={(form.citizenship as string) ?? ''}
                                    onChange={e => updateForm('citizenship', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                    </section>

                    {/* Residenza */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('sezioneResidenza')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div className="col-span-2">
                                <label htmlFor="dettaglio-indirizzo-residenza" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoIndirizzoResidenza')}</label>
                                <input
                                    id="dettaglio-indirizzo-residenza"
                                    type="text"
                                    value={(form.residence_address as string) ?? ''}
                                    onChange={e => updateForm('residence_address', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label htmlFor="dettaglio-civico" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoNumeroCivico')}</label>
                                <input
                                    id="dettaglio-civico"
                                    type="text"
                                    value={(form.residence_street_number as string) ?? ''}
                                    onChange={e => updateForm('residence_street_number', e.target.value)}
                                    maxLength={20}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label htmlFor="dettaglio-comune-residenza" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoComuneResidenza')}</label>
                                <input
                                    id="dettaglio-comune-residenza"
                                    type="text"
                                    value={(form.residence_city as string) ?? ''}
                                    onChange={e => updateForm('residence_city', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label htmlFor="dettaglio-provincia-residenza" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoProvResidenza')}</label>
                                <input
                                    id="dettaglio-provincia-residenza"
                                    type="text"
                                    value={(form.residence_province as string) ?? ''}
                                    onChange={e => updateForm('residence_province', e.target.value.toUpperCase())}
                                    maxLength={2}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green uppercase focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                            <div>
                                <label htmlFor="dettaglio-cap" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoCap')}</label>
                                <input
                                    id="dettaglio-cap"
                                    type="text"
                                    value={(form.zip_code as string) ?? ''}
                                    onChange={e => updateForm('zip_code', e.target.value)}
                                    maxLength={10}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                            </div>
                        </div>
                    </section>

                    {/* Classe e Stato */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3">
                            {t('detailClasseStato')}
                        </h3>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label htmlFor="dettaglio-classe-sezione" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoClasseSezione')}</label>
                                <select
                                    id="dettaglio-classe-sezione"
                                    name="classe_sezione"
                                    value={(form.classe_sezione as string) ?? ''}
                                    onChange={e => updateForm('classe_sezione', e.target.value)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-kidville-white focus:outline-none focus:border-kidville-green"
                                >
                                    <option value="">{t('detailNessuna')}</option>
                                    {sections.map(s => (
                                        <option key={s.id} value={s.name}>{s.name} ({s.school_type})</option>
                                    ))}
                                    {/* La classe ATTUALE del bambino, se non è più fra le
                                        sezioni della sede (rinominata, cancellata, o riga
                                        vecchia): senza questa voce la tendina resterebbe
                                        vuota e sembrerebbe che il bambino non abbia classe. */}
                                    {classeFuoriElenco && <option value={classeFuoriElenco}>{classeFuoriElenco}</option>}
                                </select>
                            </div>
                            <div>
                                <label htmlFor="dettaglio-stato" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoStato')}</label>
                                {/* ⚠️ SU UN ARCHIVIATO QUESTA TENDINA È SPENTA, ed è la
                                    correzione di un difetto MISURATO: `PATCH` con `stato` = `'iscritto'`
                                    su una riga archiviata rispondeva 200 e lasciava un bambino
                                    ISCRITTO con `section_id` e `classe_sezione` a NULL — fuori
                                    da registro, appello, mensa, diario e valutazioni, e fuori
                                    anche dalla linguetta «Non più iscritti», che filtra
                                    `stato=ritirato`. Il ritorno ha una rotta sua, che la classe
                                    la verifica e la rimette.

                                    `disabled` e non «l'opzione `iscritto` nascosta»: nascondere
                                    una voce lascia credere che le altre siano innocue, mentre
                                    anche `sospeso` sta dalla parte «ancora iscritto» del confine
                                    e farebbe lo stesso danno. E il gate VERO è comunque sul
                                    server (409 `STATO_ALUNNO_ARCHIVIATO`): questo è cortesia,
                                    non protezione — dalla console del browser si aggira. */}
                                <select
                                    id="dettaglio-stato"
                                    value={(form.stato as string) ?? 'iscritto'}
                                    onChange={e => updateForm('stato', e.target.value)}
                                    disabled={archiviato}
                                    aria-describedby={archiviato ? 'dettaglio-stato-bloccato' : undefined}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-kidville-white focus:outline-none focus:border-kidville-green disabled:cursor-not-allowed disabled:bg-kidville-cream disabled:text-kidville-sub"
                                >
                                    <option value="iscritto">{t('statoIscritto')}</option>
                                    <option value="ritirato">{t('statoRitirato')}</option>
                                    <option value="sospeso">{t('statoSospeso')}</option>
                                </select>
                                {/* Un comando spento senza una ragione scritta è un guasto agli
                                    occhi di chi lo preme: qui si dice perché, e dove si va. */}
                                {archiviato && (
                                    <p id="dettaglio-stato-bloccato" className="font-maven text-[11px] text-kidville-sub mt-1">
                                        {t('detailStatoBloccato')}
                                    </p>
                                )}
                            </div>
                            <div>
                                <label htmlFor="dettaglio-data-iscrizione" className="font-maven text-xs text-kidville-muted mb-1 block">{t('campoDataIscrizione')}</label>
                                <input
                                    id="dettaglio-data-iscrizione"
                                    type="date"
                                    value={(form.data_iscrizione as string) ?? ''}
                                    onChange={e => updateForm('data_iscrizione', e.target.value || null)}
                                    className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green"
                                />
                                <p className="font-maven text-[11px] text-kidville-muted mt-1">
                                    {t('detailDataIscrizioneHint')}
                                </p>
                            </div>
                        </div>
                    </section>

                    {/* Dati Medici */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <AlertTriangle size={12} className="text-kidville-error" />
                            {t('detailDatiMedici')}
                        </h3>

                        <div className="mb-3">
                            <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('detailAllergeni')}</label>
                            <AllergeniSelect
                                value={(form.allergeni as string[]) ?? []}
                                onChange={next => updateForm('allergeni', next)}
                            />
                            {(form.allergies as string)?.trim() && (
                                <p className="mt-2 rounded-lg bg-kidville-cream px-2.5 py-1.5 font-maven text-[11px] text-kidville-muted">
                                    {t('testoStorico', { testo: form.allergies as string })}
                                </p>
                            )}
                        </div>

                        <div className="mb-3">
                            <label htmlFor="dettaglio-note-mediche" className="font-maven text-xs text-kidville-muted mb-1 block">{t('detailNoteMediche')}</label>
                            <textarea
                                id="dettaglio-note-mediche"
                                value={(form.note_mediche as string) ?? ''}
                                onChange={e => updateForm('note_mediche', e.target.value)}
                                placeholder={t('detailNoteMedichePlaceholder')}
                                rows={2}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green resize-none"
                            />
                        </div>

                        <div className="flex items-center gap-3 mb-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.bes}
                                    onChange={e => updateForm('bes', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailBes')}</span>
                            </label>
                        </div>

                        {form.bes && (
                            <textarea
                                value={(form.note_bes as string) ?? ''}
                                onChange={e => updateForm('note_bes', e.target.value)}
                                placeholder={t('detailNoteBesPlaceholder')}
                                rows={2}
                                className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green resize-none"
                            />
                        )}

                        {/* ─── I TRE CONSENSI FOTOGRAFICI, uno per CANALE ─────────────────
                            Il modulo d'iscrizione li chiede separatamente perché il consenso
                            alla pubblicazione è granulare per canale (provv. Garante 725 del
                            27/11/2025). Fino al 2026-08-01 qui c'era una sola spunta: gli
                            altri due consensi si potevano solo IMPORTARE da una domanda, e
                            una famiglia che cambiava idea non aveva nessuna strada per farlo
                            registrare — art. 7 §3 GDPR, revocare dev'essere facile quanto
                            acconsentire. */}
                        <div className="mt-3 pt-3 border-t border-kidville-line">
                            <h4 className="font-barlow font-bold text-kidville-green uppercase text-[11px] tracking-wide mb-2">
                                {t('detailConsensiTitolo')}
                            </h4>

                            {/* Galleria riservata alle famiglie della sezione */}
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.consenso_privacy}
                                    onChange={e => updateForm('consenso_privacy', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailLiberatoria')}</span>
                            </label>
                            <p className="font-maven text-[11px] text-kidville-muted mt-1 mb-3">
                                {t('detailLiberatoriaHint')}
                            </p>

                            {/* Sito web della Scuola: canale PUBBLICO, senza login */}
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.consenso_foto_sito}
                                    onChange={e => updateForm('consenso_foto_sito', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailConsensoSito')}</span>
                            </label>
                            <p className="font-maven text-[11px] text-kidville-muted mt-1 mb-3">
                                {t('detailConsensoSitoHint')}
                            </p>

                            {/* Canali social: la pubblicazione avviene fuori dai nostri sistemi */}
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={!!form.consenso_foto_social}
                                    onChange={e => updateForm('consenso_foto_social', e.target.checked)}
                                    className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
                                />
                                <span className="font-maven font-semibold text-sm text-kidville-green">{t('detailConsensoSocial')}</span>
                            </label>
                            <p className="font-maven text-[11px] text-kidville-muted mt-1">
                                {t('detailConsensoSocialHint')}
                            </p>
                        </div>
                    </section>

                    {/* Dati Economici (modulo Pagamenti) */}
                    <StudentEconomicSection
                        alunnoId={student.id}
                        form={form as Record<string, unknown>}
                        updateForm={updateForm}
                        parents={student.student_parents}
                    />

                    {/* Famiglia e Delegati */}
                    <section className="pt-4 border-t border-kidville-line">
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <Users size={12} />
                            {t('detailFamigliaDelegati')}
                        </h3>
                        
                        {adultTabs.length > 0 ? (
                            <>
                                {/* Segmented Control */}
                                <div className="flex overflow-x-auto snap-x gap-2 pb-2 hide-scrollbar">
                                    {adultTabs.map(tab => {
                                        const isActive = activeAdultTab === tab.id;
                                        return (
                                            <button
                                                key={tab.id}
                                                onClick={() => setActiveAdultTab(isActive ? null : tab.id)}
                                                className={`snap-start whitespace-nowrap px-4 py-2 rounded-full font-barlow font-bold text-xs uppercase tracking-wide transition-all duration-300 ${
                                                    isActive 
                                                        ? 'bg-kidville-green/20 text-kidville-green border border-kidville-green/50 ring-1 ring-kidville-green/30' 
                                                        : 'bg-kidville-cream text-kidville-muted border border-kidville-line hover:bg-kidville-line'
                                                }`}
                                            >
                                                {tab.label}
                                            </button>
                                        );
                                    })}
                                </div>

                                {/* Animated Adult Profile Container */}
                                <AnimatePresence mode="wait">
                                    {activeAdultTab && activeTabData && (
                                        <motion.div
                                            key={activeAdultTab}
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.3, ease: 'easeInOut' }}
                                            className="overflow-hidden rounded-2xl mt-2"
                                        >
                                            <LinkedAdultProfile data={activeTabData.data} type={activeTabData.type} />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </>
                        ) : (
                            <div className="text-center py-6 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line">
                                <Users size={24} className="mx-auto text-kidville-muted mb-2" />
                                <p className="font-maven text-sm text-kidville-muted">{t('detailNessunGenitore')}</p>
                                <p className="font-maven text-xs text-kidville-muted mt-1">{t('detailAggiungiGenitori')}</p>
                            </div>
                        )}
                    </section>

                    {/* ===== FRATELLI ===== */}
                    <section>
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            <Baby size={12} className="text-kidville-green" />
                            {t('detailFratelli')}
                        </h3>

                        {siblingsLoading ? (
                            <div className="flex items-center gap-2 py-4 text-kidville-muted font-maven text-sm">
                                <div className="w-4 h-4 border-2 border-kidville-line border-t-kidville-green rounded-full animate-spin" />
                                {t('detailRicercaFratelli')}
                            </div>
                        ) : siblings.length > 0 ? (
                            <div className="space-y-2">
                                {siblings.map(sibling => (
                                    <div key={sibling.id} className="flex items-center gap-3 p-3 bg-kidville-green/5 border border-kidville-green/15 rounded-xl">
                                        <div className="w-9 h-9 rounded-full bg-kidville-green/10 flex items-center justify-center flex-shrink-0">
                                            <Baby size={16} className="text-kidville-green" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="font-barlow font-bold text-sm text-kidville-ink leading-tight truncate">
                                                {sibling.cognome} {sibling.nome}
                                            </p>
                                            <p className="font-maven text-xs text-kidville-muted mt-0.5">
                                                {sibling.classe_sezione || t('detailNessunaSezione')}
                                                {sibling.data_nascita && ` • ${new Date(sibling.data_nascita).getFullYear()}`}
                                            </p>
                                        </div>
                                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md flex-shrink-0 ${
                                            sibling.stato === 'iscritto' 
                                                ? 'bg-kidville-green/10 text-kidville-green' 
                                                : 'bg-kidville-line text-kidville-muted'
                                        }`}>
                                            {sibling.stato || 'iscritto'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="text-center py-5 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line">
                                <Baby size={20} className="mx-auto text-kidville-muted mb-1.5" />
                                <p className="font-maven text-sm text-kidville-muted">{t('detailNessunFratello')}</p>
                            </div>
                        )}
                    </section>

                    {/* ===== SEGNALAZIONI E RECLAMI ===== */}
                    <section className="pt-4 border-t border-kidville-line">
                        <h3 className="font-barlow font-bold text-kidville-green uppercase text-xs tracking-wide mb-3 flex items-center gap-2">
                            📌 {t('detailSegnalazioni')}
                        </h3>

                        {tasksLoading ? (
                            <div className="flex items-center gap-2 py-4 text-kidville-muted font-maven text-sm">
                                <div className="w-4 h-4 border-2 border-kidville-line border-t-kidville-green rounded-full animate-spin" />
                                {t('detailCaricamentoSegnalazioni')}
                            </div>
                        ) : studentTasks.length > 0 ? (
                            <div className="space-y-2">
                                {studentTasks.map(task => {
                                    const isCompleted = task.status === 'completed';
                                    return (
                                        <div key={task.id} className="p-3 bg-kidville-cream/50 border border-kidville-line rounded-xl space-y-1.5 text-left text-xs">
                                            <div className="flex justify-between items-start gap-1">
                                                <span className="font-bold text-kidville-ink font-maven leading-tight block">
                                                    {task.titolo}
                                                </span>
                                                <span className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md flex-shrink-0 ${
                                                    isCompleted
                                                        ? 'bg-kidville-success-soft/50 text-kidville-success ' 
                                                        : 'bg-kidville-warn-soft/50 text-kidville-warn '
                                                }`}>
                                                    {isCompleted ? t('detailRisolto') : t('detailAttivo')}
                                                </span>
                                            </div>
                                            
                                            {(task.descrizione || task.contenuto) && (
                                                <p className="text-[10px] text-kidville-muted font-maven leading-relaxed">
                                                    {task.descrizione || task.contenuto}
                                                </p>
                                            )}
                                            
                                            {isCompleted && task.resolution_notes && (
                                                <div className="p-2 bg-kidville-success-soft/20 border border-kidville-success/30 rounded-lg italic text-[9px] text-kidville-success font-maven">
                                                    &ldquo;{task.resolution_notes}&rdquo;
                                                </div>
                                            )}
                                            
                                            {/* Render attachments in student panel */}
                                            {task.attachments && task.attachments.length > 0 && (
                                                <div className="mt-1.5 space-y-1">
                                                    <p className="text-[8px] font-bold text-kidville-muted uppercase tracking-wider">{t('detailAllegati')}</p>
                                                    <div className="flex flex-col gap-1">
                                                        {task.attachments.map((att: { name: string; url: string; fileUrl?: string }, attIdx: number) => (
                                                            <a
                                                                key={attIdx}
                                                                href={att.fileUrl || att.url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="inline-flex items-center gap-1 text-[9px] text-kidville-green hover:underline truncate max-w-full font-semibold"
                                                            >
                                                                📎 {att.name}
                                                            </a>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            
                                            <div className="text-[8px] text-kidville-muted flex justify-between pt-1 border-t border-kidville-line/30">
                                                <span>{t('detailCategoria', { categoria: task.category })}</span>
                                                <span>{t('detailApertoIl', { data: formattaIstante(new Date(task.created_at), locale) })}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="text-center py-5 bg-kidville-cream rounded-xl border-2 border-dashed border-kidville-line ">
                                <span className="text-2xl block mb-1">📋</span>
                                <p className="font-maven text-sm text-kidville-muted">{t('detailNessunReclamo')}</p>
                            </div>
                        )}
                    </section>
                </div>

                {/* Footer actions */}
                <div className="flex-shrink-0 p-5 border-t border-kidville-line space-y-3">
                    {/* Salva */}
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className="w-full h-12 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase tracking-wide hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {isSaving ? (
                            <div className="w-5 h-5 border-2 border-kidville-yellow/40 border-t-kidville-yellow rounded-full animate-spin" />
                        ) : (
                            <>
                                <Save size={16} />
                                {t('salvaModifiche')}
                            </>
                        )}
                    </button>

                    {/* ══════════════════════════════════════════════════════════════
                        UN SOLO COMANDO DI CICLO DI VITA, E DIPENDE DA DOVE STA IL BAMBINO.

                        ⚠️ Fino al 2026-08-13 la scheda offriva «Sposta fra i non
                        iscritti» SEMPRE, archiviati compresi: premuto su chi era già
                        fuori rispondeva 409 `ALUNNO_GIA_ARCHIVIATO` — dopo che
                        l'operatore aveva letto il riquadro con le promesse e aveva
                        confermato. E il ritorno, sulla scheda, non c'era proprio:
                        l'unica cosa che «funzionava» era la tendina «Stato», cioè la
                        strada che rimette `iscritto` senza restituire la classe.
                        Questa scheda è dove porta il bottone «Apri scheda» dell'elenco
                        dei «non più iscritti».

                        I due comandi non convivono mai: uno dei due sarebbe sempre
                        quello che risponde 409. È lo stesso principio per cui la
                        `DELETE` è stata tolta invece che resa condizionale — «lo stesso
                        bottone, nella stessa posizione, che fa due cose diverse a
                        seconda di uno stato invisibile a chi lo preme» è una roulette.
                        Qui lo stato è VISIBILE: sopra il comando c'è scritto da quando
                        il bambino è fuori e da quale classe. */}
                    {archiviato ? (
                        <>
                            <div className="rounded-xl border border-kidville-line bg-kidville-cream p-3">
                                <p className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">
                                    {t('detailArchiviatoTitolo')}
                                </p>
                                {/* ETICHETTA E VALORE, non una frase con dentro un
                                    segnaposto: la data e il nome della classe sono i due
                                    dati che l'operatore cerca, e una coppia
                                    «etichetta: valore» non ha problemi di ordine delle
                                    parole fra le due lingue (una frase interpolata sì).
                                    «Data non registrata» invece della stringa vuota: a
                                    schermo il vuoto è indistinguibile da un dato che non
                                    è mai stato scritto. */}
                                <p className="font-maven text-xs text-kidville-ink mt-1">
                                    <span className="text-kidville-sub">{t('detailArchiviatoDalLabel')}: </span>
                                    <span>{archiviatoIl || t('detailArchiviatoSenzaData')}</span>
                                </p>
                                {eraIn && (
                                    <p className="font-maven text-xs text-kidville-ink">
                                        <span className="text-kidville-sub">{t('detailArchiviatoEraInLabel')}: </span>
                                        <span>{eraIn}</span>
                                    </p>
                                )}
                                {/* Il fatto IRREVERSIBILE si dice in parole: chi ha la
                                    famiglia davanti deve poterlo dire senza scoprirlo dopo. */}
                                {student.spazio_liberato_il != null && (
                                    <p className="font-maven text-xs text-kidville-warn-strong mt-1">
                                        {t('detailArchiviatoSpazioLiberato')}
                                    </p>
                                )}
                            </div>
                            <button
                                onClick={handleRiattiva}
                                disabled={riattivazioneInCorso}
                                className="w-full h-10 rounded-pill font-barlow font-bold uppercase tracking-wide text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 bg-kidville-green text-kidville-yellow"
                            >
                                <Undo2 size={14} />
                                {riattivazioneInCorso ? t('detailRiattivaInCorso') : t('detailRiattivaAlunno')}
                            </button>
                        </>
                    ) : (
                        <button
                            onClick={handleArchive}
                            disabled={archiviazioneInCorso}
                            className={`w-full h-10 rounded-pill font-barlow font-bold uppercase tracking-wide text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 ${
                                confermaArchiviazione
                                    ? 'bg-kidville-warn-strong text-kidville-white'
                                    : 'bg-kidville-warn-soft text-kidville-warn-strong border-2 border-kidville-warn/40'
                            }`}
                        >
                            <Archive size={14} />
                            {confermaArchiviazione
                                ? `⚠️ ${t('detailConfermaArchiviazione')}`
                                : t('detailArchiviaAlunno')
                            }
                        </button>
                    )}

                    {/* ⚠️ IL RIQUADRO CHE PRIMA MENTIVA.
                        Diceva «questa azione è irreversibile e cancellerà tutti i dati
                        dell'alunno dal sistema»: della cancellazione che descriveva,
                        28 alunni su 33 non erano nemmeno candidati, e per gli altri
                        cinque avrebbe reso illeggibili registri e pagamenti che si
                        conservano dieci anni. Adesso elenca CINQUE fatti, e il quarto
                        è quello che nessuno si aspetta: archiviare fa scattare, entro
                        24 ore, la retention che azzera il motivo delle assenze scritto
                        dalle famiglie (`presenze-giustificazioni-retention`, ogni notte
                        alle 04:59 UTC su chi non è più iscritto). Non è un difetto ed è
                        già promesso nell'informativa — ma va detto PRIMA, qui, perché è
                        l'unico effetto di questa operazione che non si può annullare
                        tornando indietro.

                        ⚠️ E DAL 2026-08-13 LE VOCI SONO SETTE, non cinque. La testata di
                        `riattiva` intitola un blocco «COSA NON TORNA INDIETRO, E VA
                        DETTO» ed elenca TRE cose; questo riquadro ne diceva UNA (il
                        motivo delle assenze) e chiudeva con «è reversibile», che è
                        parzialmente falso. Mancavano: il GRUPPO MENSA, che `archivia`
                        azzera di proposito e che nessuna colonna ricorda, e la CLASSE,
                        che al rientro torna solo se esiste ancora. Il criterio è
                        «l'operatore sa PRIMA che cosa perde»: due perdite su tre non
                        gliele diceva nessuno, né prima né dopo. */}
                    {confermaArchiviazione && (
                        <div className="rounded-xl border border-kidville-warn/40 bg-kidville-warn-soft p-3">
                            <p className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-warn-strong">
                                {t('detailArchiviaCosaSuccede')}
                            </p>
                            <ul className="mt-1.5 list-disc space-y-1 pl-4 font-maven text-xs text-kidville-warn-strong">
                                <li>{t('detailArchiviaAnagrafica')}</li>
                                <li>{t('detailArchiviaStorico')}</li>
                                <li>{t('detailArchiviaEsceDa')}</li>
                                <li>{t('detailArchiviaMotivoAssenze')}</li>
                                <li>{t('detailArchiviaMensa')}</li>
                                <li>{t('detailArchiviaClasse')}</li>
                                <li>{t('detailArchiviaReversibile')}</li>
                            </ul>
                            <button
                                onClick={() => { setConfermaArchiviazione(false); setErroreArchiviazione(null); }}
                                className="mt-2 text-xs font-maven font-bold text-kidville-muted hover:text-kidville-ink"
                            >
                                {t('annulla')}
                            </button>
                        </div>
                    )}

                    {/* Il rifiuto del server, IN PAGINA. Non un toast che sparisce
                        mentre la scheda si smonta: `role="alert"` perché chi legge con
                        uno screen reader deve sentirlo senza andarlo a cercare. */}
                    {erroreArchiviazione && (
                        <div
                            role="alert"
                            className="rounded-xl border border-kidville-error/40 bg-kidville-error-soft p-3 font-maven text-xs text-kidville-error"
                        >
                            {erroreArchiviazione}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
