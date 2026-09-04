'use client';

import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Fingerprint, FileWarning, Users, Activity, Home, User, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { AllergeniSelect } from '@/components/features/admin/AllergeniSelect';
import { BadgeCoerenzaCf, badgeHaQualcosaDaDire } from '@/components/features/anagrafica/BadgeCoerenzaCf';
import { LuogoNascitaFields, type ValoreLuogoNascita } from '@/components/features/anagrafica/LuogoNascitaFields';
import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo';
import { verificaCoerenza } from '@/lib/fiscale/coerenza';

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 🔻 QUESTO COMPONENTE NON È MONTATO DA NESSUNA PARTE — residuo, non schermata.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Misurato l'11 agosto, e scritto qui perché chi apre questo file non lo scambi per
 * una pagina viva: `grep -rn "StudentRegistryForm" src e2e` non trova **nessun punto
 * di montaggio** — zero import, zero JSX, zero rotte. Le uniche occorrenze fuori da
 * questo file sono in `__tests__/` (tre file che lo montano per misurarlo) e in
 * commenti. La scheda alunno che l'operatore incontra davvero è
 * `ScrollableStudentForm`, montata da `FamilyRegistryManager`; quella sui record già
 * in archivio è `StudentDetailPanel`.
 *
 * ⚠️ COSA NE SEGUE, detto senza attenuanti: le riparazioni fatte qui — i 12
 * `htmlFor`/`id`, il badge di coerenza, il codice catastale — **non sono verificabili
 * in produzione**, perché nessun utente incontrerà mai questa schermata. Restano
 * perché il file esiste e finché esiste si misura (la stessa regola vale per il
 * gemello vivo, e due schede che divergono sono peggio di due schede sbagliate
 * uguali), non perché servano a qualcuno oggi.
 *
 * La decisione di cancellarlo — con i suoi tre file di collaudo — non appartiene a
 * questa corsia: cinque agenti scrivono sullo stesso albero e la cancellazione di un
 * componente si fa a corsie cucite, non nel mezzo.
 *
 * ─── E QUINDI LE ETICHETTE ────────────────────────────────────────────────────
 *
 * ⚠️ TUTTE le stringhe visibili di questo file sono LETTERALI in italiano — non solo
 * «Avanti», «Indietro» e «Salva Anagrafica», ma ogni etichetta di campo («Nome»,
 * «Cognome», «Sesso», «CAP»…) e ogni messaggio di validazione. La ragione vera è
 * quella scritta qui sopra — un componente irraggiungibile —, non il fatto che quei
 * tre bottoni non passino da next-intl: quella è la conseguenza, non la causa.
 * Localizzarle è un intervento che non ha senso separatamente dalla decisione se
 * tenere o cancellare il file.
 *
 * L'unica eccezione è deliberata: il criterio di questa corsia era «nessuna stringa
 * NUOVA cablata», e `valBelfioreNonValido` — che nella scheda gemella
 * `ScrollableStudentForm` è già una chiave di catalogo, in `it` e in `en` — non
 * poteva nascere in italiano dentro una regex. Da qui la funzione: prende `t`, e lo
 * usa per l'unica riga che è sua.
 */
const buildStudentSchema = (t: (k: string) => string) => z.object({
    nome: z.string().min(2, "Il nome deve avere almeno 2 caratteri"),
    cognome: z.string().min(2, "Il cognome deve avere almeno 2 caratteri"),
    sesso: z.enum(['M', 'F']),
    data_nascita: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida"),
    data_iscrizione: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida").optional(),
    comune_nascita: z.string().min(2, "Comune non valido"),
    provincia_nascita: z.string().length(2, "Sigla provincia deve essere 2 lettere"),
    nazione_nascita: z.string().optional().or(z.literal('')),
    /**
     * Il codice catastale del luogo di nascita (`alunni.codice_belfiore_nascita`).
     * NULLABLE: è ciò che rende calcolabile il codice fiscale, non un requisito — un
     * comune che la tendina non riconosce lascia qui `null` e conserva il proprio
     * testo in `comune_nascita`.
     *
     * Il valore non lo digita nessuno: arriva da `opzione.valore` di
     * `GET /api/anagrafiche/comuni`. Questo `regex` è quindi il controllo di CONFINE su
     * un dato di rete che finisce dentro il codice fiscale di un bambino.
     */
    codice_belfiore_nascita: z.string().regex(/^[A-Z][0-9]{3}$/, t('valBelfioreNonValido')).nullable(),
    codice_fiscale: z.string().length(16, "Il CF deve essere di 16 caratteri").toUpperCase(),
    indirizzo_residenza: z.string().min(5, "Indirizzo non valido"),
    comune_residenza: z.string().min(2, "Comune non valido"),
    cap: z.string().length(5, "CAP deve essere di 5 cifre"),
    is_bes_dsa: z.boolean(),
    note_bes: z.string().optional(),
    allergies: z.string().optional(),
    allergeni: z.array(z.string()).optional(),
    invoice_holder_type: z.enum(['mom', 'dad', 'other']),
    invoice_holder_details: z.object({
        nome: z.string().optional(),
        cognome: z.string().optional(),
        codice_fiscale: z.string().optional(),
        adult_id: z.string().optional()
    }).optional()
});

export function StudentRegistryForm() {
    // I due placeholder vengono dal catalogo (`phVia`, `phDettagliAggiuntivi`),
    // che esisteva già ed era già in uso nel modulo gemello: scritti nel TSX,
    // restavano italiani con l'interfaccia in inglese.
    const t = useTranslations('adminStudents');
    const studentSchema = useMemo(() => buildStudentSchema(t), [t]);
    const [step, setStep] = useState(1);

    /**
     * L'`id` del badge di coerenza. `role="status"` non promette nessun annuncio (lo
     * dice la testata di `BadgeCoerenzaCf`): la via dichiarata per SENTIRE il verdetto
     * è `aria-describedby` dal campo del codice fiscale, e senza `id` esplicito ogni
     * scheda erediterebbe lo stesso `badge-coerenza-cf`. `registry-` distingue questa
     * dalle altre due schede alunno e dalle tre schede adulto.
     */
    const idBadgeCf = 'registry-badge-coerenza-cf';
    
    // Form state
    const [formData, setFormData] = useState({
        nome: '',
        cognome: '',
        sesso: 'M',
        data_nascita: '',
        // default oggi: la data d'iscrizione pilota da quale mese partono le rette
        data_iscrizione: new Date().toISOString().slice(0, 10),
        comune_nascita: '',
        provincia_nascita: '',
        nazione_nascita: 'Italia',
        codice_belfiore_nascita: '',
        codice_fiscale: '',
        indirizzo_residenza: '',
        comune_residenza: '',
        cap: '',
        is_bes_dsa: false,
        note_bes: '',
        allergies: '',
        allergeni: [] as string[],
        invoice_holder_type: 'mom',
        invoice_holder_details: { nome: '', cognome: '', codice_fiscale: '', adult_id: '' }
    });

    const [errors, setErrors] = useState<Record<string, string>>({});
    const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);

    /**
     * ─── IL CODICE FISCALE, CALCOLATO IN RENDER E SENZA RETE ────────────────────
     *
     * Qui c'era un `useEffect` con 800 ms di debounce attorno a `fetchFiscalCode`. La
     * rete non c'è più: `calcolaCodiceFiscale` è puro e sincrono, quindi non resta
     * niente da attendere — e un effetto che scrive stato riaprirebbe il ciclo
     * `setState → effect → setState` vietato da `react-hooks/set-state-in-effect`.
     *
     * ⚠️ Il calcolo vuole il CODICE CATASTALE, non il nome del comune: è la ragione per
     * cui i campi liberi sono diventati `<LuogoNascitaFields>`. Senza codice catastale
     * non esce nessun suggerimento — e va bene così: un codice costruito su un comune
     * indovinato è un codice sbagliato con l'aria di essere buono.
     */
    const codiceFiscaleCalcolato = useMemo(() => {
        const esito = calcolaCodiceFiscale({
            nome: formData.nome,
            cognome: formData.cognome,
            sesso: formData.sesso as 'M' | 'F',
            dataNascita: formData.data_nascita,
            codiceBelfiore: formData.codice_belfiore_nascita,
        });
        return esito.ok ? esito.codice : null;
    }, [formData.nome, formData.cognome, formData.sesso, formData.data_nascita, formData.codice_belfiore_nascita]);

    /**
     * Il suggerimento parla SOLO quando il campo è vuoto: ciò che l'operatore digita non
     * si sovrascrive mai (il codice sul tesserino è l'unico dato certo, e un omocodico
     * — legittimo, assegnato dall'Agenzia — non è calcolabile da nessuna anagrafica).
     * Il vecchio `codiceFiscaleRef` era lo specchio di questo stesso campo, tenuto solo
     * perché l'effect non dipendesse da lui: senza effect resta il campo, e leggere un
     * ref in render ESLint lo vieta (`react-hooks/refs`).
     */
    const codiceFiscaleMostrato = formData.codice_fiscale || (codiceFiscaleCalcolato ?? '');
    const cfDalCalcolo = formData.codice_fiscale === '' && codiceFiscaleCalcolato !== null;

    /** Il verdetto mostrato accanto al campo. Non blocca il salvataggio, mai. */
    const esitoCoerenza = useMemo(
        () => verificaCoerenza(codiceFiscaleMostrato, {
            nome: formData.nome,
            cognome: formData.cognome,
            sesso: formData.sesso,
            dataNascita: formData.data_nascita,
            codiceBelfiore: formData.codice_belfiore_nascita,
        }),
        [codiceFiscaleMostrato, formData.nome, formData.cognome, formData.sesso, formData.data_nascita, formData.codice_belfiore_nascita],
    );

    /**
     * ⚠️ IL CAMPO PUNTA AL BADGE SOLO SE IL BADGE C'È. `BadgeCoerenzaCf` restituisce
     * `null` quando non ha niente da dire — e a wizard appena aperto è esattamente
     * così: campo vuoto, niente da calcolare, nessun badge. Un `aria-describedby`
     * incondizionato rimanderebbe a un elemento che non esiste.
     *
     * La condizione non si riscrive qui: la decide `badgeHaQualcosaDaDire`, unico
     * posto in cui quella regola vive. Misurato in
     * `__tests__/a11y/schede-alunno-a11y.test.tsx`.
     */
    const badgeVisibile = badgeHaQualcosaDaDire(esitoCoerenza);

    /** La nomenclatura di QUESTA scheda: `comune_nascita` / `provincia_nascita` / `nazione_nascita`. */
    const luogoNascita: ValoreLuogoNascita = {
        provincia: formData.provincia_nascita,
        comune: formData.comune_nascita,
        nazione: formData.nazione_nascita,
        belfiore: formData.codice_belfiore_nascita,
    };

    const cambiaLuogoNascita = (v: ValoreLuogoNascita) => {
        setFormData(prev => ({
            ...prev,
            provincia_nascita: v.provincia,
            comune_nascita: v.comune,
            nazione_nascita: v.nazione,
            codice_belfiore_nascita: v.belfiore,
        }));
        setErrors(prev => {
            if (!prev.comune_nascita && !prev.provincia_nascita && !prev.codice_belfiore_nascita) return prev;
            const next = { ...prev };
            delete next.comune_nascita;
            delete next.provincia_nascita;
            delete next.codice_belfiore_nascita;
            return next;
        });
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value, type } = e.target as HTMLInputElement;
        const checked = (e.target as HTMLInputElement).checked;

        if (name.startsWith('invoice_holder_details.')) {
            const field = name.split('.')[1];
            setFormData(prev => ({
                ...prev,
                invoice_holder_details: { ...prev.invoice_holder_details, [field]: value }
            }));
        } else {
            setFormData(prev => ({
                ...prev,
                [name]: type === 'checkbox' ? checked : value
            }));
        }
        
        if (errors[name]) {
            setErrors(prev => {
                const newErrors = { ...prev };
                delete newErrors[name];
                return newErrors;
            });
        }
    };

    /**
     * ⚠️ IL RAMO DI RESILIENZA, e cosa lo può accendere DAVVERO — riscritto l'11
     * agosto, perché fino a quel giorno questo blocco diceva il contrario del vero.
     *
     * La colonna `codice_belfiore_nascita` esiste in produzione (migrazione
     * `20260810094625`) ma NON sul database E2E della CI, che è un progetto separato e
     * non migrato: lì PostgREST risponde `PGRST204` («Could not find the … column … in
     * the schema cache») a un INSERT che la nomina.
     *
     * La stesura precedente sosteneva che «nessun INSERT la nomina, oggi», perché
     * `postBodySchema` di `src/app/api/admin/students/route.ts` non la dichiarava e
     * `z.object` scartava le chiavi sconosciute. **Quelle righe adesso esistono** —
     * `postBodySchema` (riga 26), `patchBodySchema` (riga 92), l'oggetto `record` del
     * POST (riga 300) e `allowedFields` del PATCH (riga 638): il campo persiste
     * dall'11 agosto 2026, misurato in `__tests__/api/admin-students-belfiore.test.ts`.
     * Quindi il ramo qui sotto non è più preventivo: è la strada che l'E2E della CI
     * percorre a ogni creazione di alunno, e senza di lui si romperebbe.
     *
     * (Questa scheda, va ricordato, non è montata da nessuna pagina — vedi la testata
     * in cima: il ramo vive per davvero nel gemello, non qui.)
     *
     * La regola che il ramo implementa resta quella giusta: un codice catastale
     * mancante non può impedire l'iscrizione di un bambino. Si ritenta UNA volta senza
     * quel campo e si logga che è caduto — nominandolo, perché «qualcosa è caduto» non
     * si può interrogare alle tre di notte. Il nome della colonna non è un dato
     * personale.
     */
    const colonnaBelfioreAssente = (corpo: unknown): boolean => {
        const d = corpo as { code?: unknown; message?: unknown; error?: unknown } | null;
        const testo = [d?.code, d?.message, d?.error].filter(v => typeof v === 'string').join(' ');
        return testo.includes('PGRST204') || (testo.includes('codice_belfiore_nascita') && /column|colonna|schema cache/i.test(testo));
    };

    const handleSubmit = async () => {
        try {
            // Validazione Zod. Il codice fiscale che si salva è quello MOSTRATO: se
            // l'operatore non ha digitato niente, `formData.codice_fiscale` è vuoto
            // mentre nel campo si legge il suggerimento, e a salvarsi dev'essere ciò
            // che sta scritto. Il codice catastale vuoto diventa `null`: la colonna è
            // nullable e il `check` accetta solo la forma `^[A-Z][0-9]{3}$`.
            const parsedData = studentSchema.parse({
                ...formData,
                codice_fiscale: codiceFiscaleMostrato,
                codice_belfiore_nascita: formData.codice_belfiore_nascita || null,
            });

            const invia = (corpo: Record<string, unknown>) => fetch('/api/admin/students', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(corpo)
            });

            let res = await invia(parsedData);

            if (!res.ok) {
                const errorData = await res.json().catch(() => null);
                if (colonnaBelfioreAssente(errorData)) {
                    logClient({
                        livello: 'warn',
                        evento: 'fetch',
                        messaggio: 'alunno-salvataggio: colonna-assente:codice_belfiore_nascita, ritento senza',
                        stato: res.status,
                    });
                    const { codice_belfiore_nascita: _caduto, ...senzaBelfiore } = parsedData;
                    void _caduto;
                    res = await invia(senzaBelfiore);
                }
                if (!res.ok) {
                    const ultimo = (await res.json().catch(() => null)) ?? errorData;
                    // Lo stato lo porta il log, non il messaggio a schermo.
                    logClient({ livello: 'error', evento: 'fetch', messaggio: 'alunno-salvataggio-fallito', stato: res.status });
                    throw new Error((ultimo as { error?: string } | null)?.error || "Errore nel salvataggio");
                }
            }

            setToast({ type: 'success', message: 'Anagrafica salvata con successo!' });
            setTimeout(() => { setToast(null); setStep(1); }, 3000);

        } catch (error) {
            const zodLike = error as { errors?: { path?: (string | number)[]; message: string }[] };
            if (error instanceof z.ZodError || (zodLike && Array.isArray(zodLike.errors))) {
                const fieldErrors: Record<string, string> = {};
                (zodLike.errors || []).forEach((err) => {
                    if (err.path && err.path.length > 0) {
                        fieldErrors[err.path.join('.')] = err.message;
                    }
                });
                setErrors(fieldErrors);
                setToast({ type: 'error', message: 'Correggi gli errori evidenziati nel form.' });
            } else {
                // Non è un errore di validazione: o la rete è caduta prima della
                // risposta (`TypeError: Failed to fetch`), o è il rilancio del ramo
                // qui sopra — che ha già loggato il proprio stato. In entrambi i casi
                // qui si registra la CLASSE dell'errore, mai il messaggio: quello può
                // portarsi dietro il testo del server.
                logClient({ livello: 'error', evento: 'fetch', messaggio: `alunno-salvataggio-non-riuscito: ${nomeErrore(error)}` });
                setToast({ type: 'error', message: (error as Error).message });
            }
            setTimeout(() => setToast(null), 4000);
        }
    };

    return (
        <div className="w-full max-w-4xl mx-auto p-8 bg-white/5 backdrop-blur-lg border border-kidville-line rounded-3xl shadow-xl relative">
            
            {/* Custom Toast */}
            <AnimatePresence>
                {toast && (
                    <motion.div
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        // Un errore che si vede solo a colori non è un messaggio: chi
                        // usa uno screen reader non saprebbe che il salvataggio non è
                        // andato. I dati compilati restano dove sono, in ogni caso.
                        role={toast.type === 'error' ? 'alert' : 'status'}
                        className={`absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-6 py-3 rounded-full font-bold shadow-lg z-50 ${toast.type === 'success' ? 'bg-kidville-green text-white' : 'bg-kidville-error text-white'}`}
                    >
                        {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                        {toast.message}
                    </motion.div>
                )}
            </AnimatePresence>

            <h2 className="text-2xl font-bold text-kidville-green mb-6 font-maven flex items-center gap-2">
                <User className="text-kidville-green" /> Anagrafica Alunno
            </h2>

            {/* Stepper Header */}
            <div className="flex gap-4 mb-8 border-b border-kidville-line pb-4">
                {[
                    { num: 1, label: 'Dati Personali', icon: <User size={16} /> },
                    { num: 2, label: 'Residenza', icon: <Home size={16} /> },
                    { num: 3, label: 'Medica / BES', icon: <Activity size={16} /> },
                    { num: 4, label: 'Amministrazione', icon: <Users size={16} /> },
                ].map(s => (
                    <button
                        key={s.num}
                        onClick={() => setStep(s.num)}
                        className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm transition-all duration-300 ${step === s.num ? 'bg-kidville-green text-white shadow-md' : 'text-kidville-muted hover:bg-kidville-cream'}`}
                    >
                        {s.icon} {s.label}
                    </button>
                ))}
            </div>

            {/* Form Steps */}
            <div className="min-h-[300px]">
                {step === 1 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-6">
                        <div>
                            <label htmlFor="registry-nome" className="block text-sm font-bold text-kidville-ink mb-1">Nome</label>
                            <input id="registry-nome" name="nome" value={formData.nome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none transition-all ${errors.nome ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.nome && <span className="text-xs text-kidville-error">{errors.nome}</span>}
                        </div>
                        <div>
                            <label htmlFor="registry-cognome" className="block text-sm font-bold text-kidville-ink mb-1">Cognome</label>
                            <input id="registry-cognome" name="cognome" value={formData.cognome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none transition-all ${errors.cognome ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.cognome && <span className="text-xs text-kidville-error">{errors.cognome}</span>}
                        </div>
                        <div>
                            <label htmlFor="registry-sesso" className="block text-sm font-bold text-kidville-ink mb-1">Sesso</label>
                            <select id="registry-sesso" name="sesso" value={formData.sesso} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line focus:ring-2 focus:ring-kidville-green outline-none bg-white">
                                <option value="M">Maschio</option>
                                <option value="F">Femmina</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="registry-data-nascita" className="block text-sm font-bold text-kidville-ink mb-1">Data di Nascita</label>
                            <input type="date" id="registry-data-nascita" name="data_nascita" value={formData.data_nascita} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.data_nascita ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.data_nascita && <span className="text-xs text-kidville-error">{errors.data_nascita}</span>}
                        </div>
                        <div>
                            <label htmlFor="registry-data-iscrizione" className="block text-sm font-bold text-kidville-ink mb-1">Data di Iscrizione</label>
                            <input type="date" id="registry-data-iscrizione" name="data_iscrizione" value={formData.data_iscrizione} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.data_iscrizione ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            <span className="text-xs text-kidville-muted">Le rette partono dal mese di iscrizione.</span>
                        </div>
                        {/* Comune, provincia e nazione erano tre caselle di testo libero:
                            da lì non usciva nessun codice catastale, e senza quello il
                            codice fiscale non è calcolabile. Un campo solo, che passa
                            dalla rotta `/api/anagrafiche/comuni` — il dataset dei comuni
                            non deve entrare nel bundle del browser. */}
                        <div className="col-span-2">
                            <LuogoNascitaFields
                                valore={luogoNascita}
                                onChange={cambiaLuogoNascita}
                                idPrefisso="registry-alunno"
                                errori={{ provincia: errors.provincia_nascita, comune: errors.comune_nascita }}
                            />
                            {errors.codice_belfiore_nascita && (
                                <span role="alert" className="text-xs text-kidville-error">
                                    {errors.codice_belfiore_nascita}
                                </span>
                            )}
                        </div>
                        <div className="col-span-2">
                            <label htmlFor="registry-codice-fiscale" className="block text-sm font-bold text-kidville-ink mb-1 flex items-center gap-2">
                                <Fingerprint size={16} /> Codice Fiscale
                                {/* Il calcolo è sincrono: non c'è nessuna attesa da
                                    annunciare, e la nota resta finché il campo mostra il
                                    suggerimento invece di un codice digitato. */}
                                {cfDalCalcolo && <span className="text-xs text-kidville-green font-normal">{t('cfAutocalcolato')}</span>}
                            </label>
                            <input
                                id="registry-codice-fiscale"
                                name="codice_fiscale"
                                value={codiceFiscaleMostrato}
                                onChange={handleInputChange}
                                // Il verdetto si sente arrivando sul campo, una volta sola —
                                // e `undefined` quando il badge non c'è: un rimando a un
                                // elemento inesistente è peggio di nessun rimando.
                                aria-describedby={badgeVisibile ? idBadgeCf : undefined}
                                className={`w-full p-3 rounded-xl border outline-none uppercase transition-all duration-500 ${errors.codice_fiscale ? 'border-kidville-error bg-kidville-error-soft' : cfDalCalcolo ? 'border-kidville-green ring-2 ring-kidville-green/50 bg-kidville-green/5' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`}
                            />
                            {errors.codice_fiscale && <span className="text-xs text-kidville-error">{errors.codice_fiscale}</span>}
                            {/* Segnala, non blocca: nessun ramo del salvataggio lo guarda. */}
                            <div className="mt-2 empty:hidden">
                                <BadgeCoerenzaCf
                                    esito={esitoCoerenza}
                                    id={idBadgeCf}
                                    onUsaCalcolato={(codice) => setFormData(prev => ({ ...prev, codice_fiscale: codice }))}
                                />
                            </div>
                        </div>
                    </motion.div>
                )}

                {step === 2 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label htmlFor="registry-indirizzo-residenza" className="block text-sm font-bold text-kidville-ink mb-1">Indirizzo di Residenza</label>
                            <input id="registry-indirizzo-residenza" name="indirizzo_residenza" value={formData.indirizzo_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.indirizzo_residenza ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} placeholder={t('phVia')} />
                            {errors.indirizzo_residenza && <span className="text-xs text-kidville-error">{errors.indirizzo_residenza}</span>}
                        </div>
                        <div>
                            <label htmlFor="registry-comune-residenza" className="block text-sm font-bold text-kidville-ink mb-1">Comune di Residenza</label>
                            <input id="registry-comune-residenza" name="comune_residenza" value={formData.comune_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.comune_residenza ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} />
                            {errors.comune_residenza && <span className="text-xs text-kidville-error">{errors.comune_residenza}</span>}
                        </div>
                        <div>
                            <label htmlFor="registry-cap" className="block text-sm font-bold text-kidville-ink mb-1">CAP</label>
                            <input id="registry-cap" name="cap" value={formData.cap} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none ${errors.cap ? 'border-kidville-error bg-kidville-error-soft' : 'border-kidville-line focus:ring-2 focus:ring-kidville-green'}`} maxLength={5} />
                            {errors.cap && <span className="text-xs text-kidville-error">{errors.cap}</span>}
                        </div>
                    </motion.div>
                )}

                {step === 3 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-1 flex items-center gap-2">
                                <AlertTriangle size={16} className="text-kidville-error" /> Allergie e Intolleranze
                            </label>
                            <AllergeniSelect value={formData.allergeni} onChange={next => setFormData(prev => ({ ...prev, allergeni: next }))} />
                            {formData.allergies?.trim() && (
                                <p className="mt-2 rounded-xl bg-kidville-cream px-3 py-2 font-maven text-xs text-kidville-muted">
                                    Testo storico (sola lettura): {formData.allergies}
                                </p>
                            )}
                        </div>

                        <div className="p-4 bg-kidville-warn-soft rounded-2xl border border-kidville-warn/30">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" name="is_bes_dsa" checked={formData.is_bes_dsa} onChange={handleInputChange} className="w-5 h-5 rounded border-kidville-warn/30 text-kidville-warn focus:ring-kidville-warn" />
                                <span className="font-bold text-kidville-warn flex items-center gap-2">
                                    <FileWarning size={18} /> Studente BES / DSA
                                </span>
                            </label>

                            <AnimatePresence>
                                {formData.is_bes_dsa && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        className="mt-4 overflow-hidden"
                                    >
                                        <label htmlFor="registry-note-bes" className="block text-sm font-bold text-kidville-warn mb-1">Note BES / DSA</label>
                                        <textarea id="registry-note-bes" name="note_bes" value={formData.note_bes} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-warn/30 bg-white focus:ring-2 focus:ring-kidville-warn outline-none" rows={2} placeholder={t('phDettagliAggiuntivi')} />
                                        <div className="mt-3 text-sm text-kidville-warn">I documenti (PEI, Diagnosi) potranno essere caricati nella scheda Documenti dopo il salvataggio.</div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}

                {step === 4 && (
                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-ink mb-2">Intestatario Fattura</label>
                            <div className="flex gap-4">
                                {['mom', 'dad', 'other'].map(type => (
                                    <label key={type} className={`flex-1 flex items-center justify-center p-3 rounded-xl border cursor-pointer transition-all ${formData.invoice_holder_type === type ? 'border-kidville-green bg-kidville-green/10 text-kidville-green font-bold' : 'border-kidville-line text-kidville-muted hover:bg-kidville-cream'}`}>
                                        <input type="radio" name="invoice_holder_type" value={type} checked={formData.invoice_holder_type === type} onChange={handleInputChange} className="hidden" />
                                        {type === 'mom' ? 'Madre' : type === 'dad' ? 'Padre' : 'Altro Soggetto'}
                                    </label>
                                ))}
                            </div>
                        </div>

                        <AnimatePresence>
                            {formData.invoice_holder_type === 'other' && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    className="p-4 border border-kidville-info/30 bg-kidville-info-soft/50 rounded-2xl overflow-hidden mt-2"
                                >
                                    <div className="flex items-center justify-between mb-4">
                                        {/*
                                          * `h3` e non `h4`: l'unico altro titolo di questa scheda è
                                          * l'`h2` di riga 328, quindi un `h4` qui saltava un livello e
                                          * axe lo conta come violazione `heading-order` — chi naviga
                                          * per intestazioni trova un buco. Non è una deduzione: è
                                          * uscita rossa l'11 agosto, la prima volta che una misura ha
                                          * montato il PASSO 4 di questo wizard. Prima nessun collaudo
                                          * andava oltre il passo 1, ed è esattamente il motivo per cui
                                          * la testata di `__tests__/a11y/schede-alunno-a11y.test.tsx`
                                          * ora elenca cosa copre invece di promettere «fa rosso».
                                          */}
                                        <h3 className="font-bold text-kidville-info">Seleziona o Crea Adulto</h3>
                                        <button className="text-sm px-3 py-1 bg-white border border-kidville-info/30 rounded-full text-kidville-info font-medium hover:bg-kidville-info-soft">
                                            + Nuovo Adulto
                                        </button>
                                    </div>
                                    
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label htmlFor="registry-intestatario-nome" className="block text-sm font-bold text-kidville-ink mb-1">Nome</label>
                                            <input id="registry-intestatario-nome" name="invoice_holder_details.nome" value={formData.invoice_holder_details.nome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line bg-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div>
                                            <label htmlFor="registry-intestatario-cognome" className="block text-sm font-bold text-kidville-ink mb-1">Cognome</label>
                                            <input id="registry-intestatario-cognome" name="invoice_holder_details.cognome" value={formData.invoice_holder_details.cognome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line bg-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div className="col-span-2">
                                            <label htmlFor="registry-intestatario-codice-fiscale" className="block text-sm font-bold text-kidville-ink mb-1">Codice Fiscale Intestatario</label>
                                            <input id="registry-intestatario-codice-fiscale" name="invoice_holder_details.codice_fiscale" value={formData.invoice_holder_details.codice_fiscale} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-line bg-white focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
                                        </div>
                                        <div className="col-span-2 text-xs text-kidville-muted">
                                            Nota: Salvando questa anagrafica, questo adulto verrà automaticamente registrato e collegato con `is_invoice_holder = true`.
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                )}
            </div>

            <div className="mt-8 flex justify-between border-t border-kidville-line pt-6">
                <button 
                    onClick={() => setStep(s => Math.max(1, s - 1))}
                    disabled={step === 1}
                    className="px-6 py-2 rounded-full font-bold text-kidville-muted disabled:opacity-50"
                >
                    Indietro
                </button>
                {step < 4 ? (
                    <button 
                        onClick={() => setStep(s => Math.min(4, s + 1))}
                        className="px-6 py-2 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg"
                    >
                        Avanti
                    </button>
                ) : (
                    <button 
                        onClick={handleSubmit}
                        className="px-8 py-2 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg ring-4 ring-kidville-green/20"
                    >
                        Salva Anagrafica
                    </button>
                )}
            </div>
        </div>
    );
}
