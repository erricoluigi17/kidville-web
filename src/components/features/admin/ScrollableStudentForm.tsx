'use client';

import React, { useState, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Fingerprint, FileWarning, User, AlertTriangle } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { z } from 'zod';
import { AllergeniSelect } from '@/components/features/admin/AllergeniSelect';
import { BadgeCoerenzaCf } from '@/components/features/anagrafica/BadgeCoerenzaCf';
import { LuogoNascitaFields, type ValoreLuogoNascita } from '@/components/features/anagrafica/LuogoNascitaFields';
import { useSediAttive } from '@/lib/context/sede-context';
import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo';
import { verificaCoerenza } from '@/lib/fiscale/coerenza';
import { DateField } from '@/components/ui/DateField';

/**
 * Alone rosso dei campi in errore. Era un `rgba(…)` letterale ripetuto undici
 * volte, ed era il rosso di Tailwind (`red-500`), NON il token del brand
 * `--color-kidville-error` — un colore fuori palette entrato per copia-incolla,
 * che l'Alto Contrasto non poteva rimappare perché non passava da nessun token.
 * Ora l'alone segue il token; `color-mix` tiene la stessa trasparenza al 30%.
 * Stringa COMPLETA in un'unica costante: Tailwind v4 cerca le classi come testo
 * nei sorgenti, quindi una classe spezzata in concatenazioni non verrebbe
 * generata affatto.
 */
const ALONE_ERRORE = 'shadow-[0_0_10px_color-mix(in_srgb,var(--color-kidville-error)_30%,transparent)]';

// I messaggi di validazione sono localizzati: lo schema è costruito con `t`
// (la funzione di traduzione), così gli errori zod seguono la lingua attiva.
const buildStudentSchema = (t: (k: string) => string) => z.object({
    nome: z.string().min(2, t('valNomeMin')),
    cognome: z.string().min(2, t('valCognomeMin')),
    sesso: z.enum(['M', 'F']),
    data_nascita: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t('valDataNonValida')),
    comune_nascita: z.string().min(2, t('valComuneNonValido')),
    provincia_nascita: z.string().length(2, t('valProvincia2')),
    nazione_nascita: z.string().optional().or(z.literal('')),
    /**
     * Il codice catastale del luogo di nascita (`alunni.codice_belfiore_nascita`,
     * migrazione `20260810094625`). NULLABLE e mai obbligatorio: è il dato che rende
     * il codice fiscale CALCOLABILE, non un requisito d'iscrizione — e su un comune
     * scritto a mano che la tendina non riconosce resta `null` mentre il testo del
     * comune si conserva.
     *
     * ⚠️ IL VALORE ARRIVA DALLA RETE, ED È PER QUESTO CHE SI VALIDA. Non lo digita
     * nessuno: `cambiaLuogoNascita` lo prende da `opzione.valore`, cioè dal campo
     * `belfiore` di `GET /api/anagrafiche/comuni`. Questo `regex` è quindi il
     * controllo di CONFINE su un dato di provenienza esterna — quattro caratteri che
     * finiscono dentro il codice fiscale di un bambino e ci restano per tutta la vita
     * della scheda. Un `belfiore` malformato che arrivasse dalla rotta accende
     * `t('valBelfioreNonValido')` nello span qui sotto (righe ≈385-389) invece di
     * essere scritto in archivio: percorso MISURATO in
     * `ScrollableStudentForm-codice-fiscale.test.tsx` §5, con la rotta finta che
     * risponde con un codice fuori forma.
     *
     * ⚠️ E FINO ALL'11 AGOSTO IL VALORE NON ARRIVAVA IN COLONNA — riparato, e la
     * storia resta scritta perché è la ragione per cui esiste il collaudo che la
     * sorveglia. Non mancava la colonna (`alunni.codice_belfiore_nascita` esiste in
     * produzione ed è nullable, misurato l'11 agosto su `information_schema.columns`):
     * mancava nella rotta, in tre punti di `src/app/api/admin/students/route.ts` —
     * `postBodySchema`, che è uno `z.object` NON strict e quindi scartava la chiave
     * senza errore e senza log; l'oggetto `record` del POST; `allowedFields` del PATCH.
     * L'operatore sceglieva il comune dalla tendina, premeva Salva, riceveva `201`/`200`
     * e il dato non esisteva. Le tre righe ci sono dall'11 agosto, e con loro il ramo
     * `PGRST204` della resilienza, senza il quale il campo in più avrebbe fatto 500 su
     * ogni creazione di alunno nel DB E2E della CI (progetto separato, non migrato).
     *
     * 🔴 PERCHÉ ERA UN BLOCCANTE e non una nota di servizio: `messages/it/shared.json`
     * → `cfMancaLuogoNascita` prescrive a schermo esattamente quel gesto («scegli il
     * comune dall'elenco del luogo di nascita per registrarlo»). Un'istruzione scritta
     * all'operatore che fallisce in silenzio su dati di minori è la definizione di bug
     * che AGENTS.md vieta. E il gemello ADULTO era già completo (`buildParentRecord`,
     * `src/lib/anagrafiche/parents.ts`): la stessa schermata funzionava sui genitori e
     * mentiva sui bambini.
     *
     * Combinando le due cose — questo modulo che salva SEMPRE il codice fiscale
     * calcolato (vedi la decisione di prodotto più sotto) e la rotta che buttava via il
     * codice catastale — ogni alunno creato sarebbe entrato in archivio con un codice
     * fiscale e SENZA il dato che permette di verificarlo. Riaprendo quella scheda,
     * `StudentDetailPanel` passa a `BadgeCoerenzaCf` il Belfiore GREZZO, che sarebbe
     * stato `null`, e il badge avrebbe dipinto GIALLO «non verificabile»: cioè si
     * sarebbe convertito in giallo l'intero flusso di inserimento — la generalizzazione
     * dello stato giallo che tutta questa corsia esiste per evitare.
     *
     * ⚠️ LA PERSISTENZA SI MISURA, non si deduce da questo commento: le tre schede
     * verificano il PAYLOAD, e un payload corretto contro una rotta che lo scarta è
     * verde in perpetuo mentre in archivio non arriva niente. La misura che chiude la
     * catena — POST e PATCH, il campo che sopravvive fino al record scritto, e il
     * degrado tracciato quando la colonna non c'è — è
     * `__tests__/api/admin-students-belfiore.test.ts`.
     */
    codice_belfiore_nascita: z.string().regex(/^[A-Z][0-9]{3}$/, t('valBelfioreNonValido')).nullable(),
    cittadinanza: z.string().optional().or(z.literal('')),
    codice_fiscale: z.string().optional().or(z.literal('')),
    indirizzo_residenza: z.string().optional().or(z.literal('')),
    civico: z.string().optional().or(z.literal('')),
    comune_residenza: z.string().optional().or(z.literal('')),
    provincia_residenza: z.string().max(2).optional().or(z.literal('')),
    cap: z.string().optional().or(z.literal('')),
    // La sede è OBBLIGATORIA e non ha default: con tre plessi, «quale scuola»
    // è un dato dell'iscrizione, non una preferenza di interfaccia. Prima del
    // 2026-07-31 il form ripiegava sulla prima sede accessibile e il server —
    // che riceveva una `preferita` valida — non aveva modo di accorgersene.
    scuola_id: z.string().min(1, t('valSedeObbligatoria')),
    classe_sezione: z.string().optional().or(z.literal('')),
    is_bes_dsa: z.boolean(),
    note_bes: z.string().optional(),
    usa_pannolino: z.boolean().optional(),
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

export interface StudentFormHandle {
    // Valida i campi (mostra gli errori inline) e ritorna il payload pronto per
    // POST /api/admin/students, oppure { ok:false } se ci sono errori.
    validate: () => { ok: true; data: Record<string, unknown> } | { ok: false };
    reset: () => void;
}

export const ScrollableStudentForm = forwardRef<StudentFormHandle>(function ScrollableStudentForm(_props, ref) {
    const t = useTranslations('adminStudents');
    const [formData, setFormData] = useState({
        nome: '',
        cognome: '',
        sesso: 'M',
        data_nascita: '',
        comune_nascita: '',
        provincia_nascita: '',
        nazione_nascita: 'Italia',
        codice_belfiore_nascita: '',
        cittadinanza: 'Italiana',
        codice_fiscale: '',
        indirizzo_residenza: '',
        civico: '',
        comune_residenza: '',
        provincia_residenza: '',
        cap: '',
        classe_sezione: '',
        scuola_id: '',
        is_bes_dsa: false,
        note_bes: '',
        usa_pannolino: false,
        allergies: '',
        allergeni: [] as string[],
        invoice_holder_type: 'mom',
        invoice_holder_details: { nome: '', cognome: '', codice_fiscale: '', adult_id: '' }
    });

    // Sezioni della SEDE scelta, tenute insieme alla sede per cui sono state
    // caricate: così la tendina non mostra mai, nemmeno per un istante, le
    // sezioni del plesso precedente mentre la nuova richiesta è in volo.
    const [sezioniCaricate, setSezioniCaricate] = useState<{ scuolaId: string; elenco: {id: string, name: string, school_type: string}[] }>({ scuolaId: '', elenco: [] });
    // Sedi reali accessibili all'utente (contesto multi-sede).
    // `sedeCorrente` è la sede SCELTA nel selettore quando ne è attiva una sola
    // (ed è l'unica sede quando l'utente ne ha una): è una dichiarazione, non un
    // ripiego. Quando invece sono attive più sedi, `sedeCorrente` è null e qui
    // NON si indovina: il campo resta vuoto e la validazione blocca il salvataggio.
    const { sedi, effettive, sedeCorrente } = useSediAttive();
    // Si offrono solo le sedi ATTIVE, non tutte le accessibili: la lista delle
    // sezioni (`GET /api/admin/sections?scuola_id=`) è comunque intersecata con
    // `resolveScuoleAttive`, quindi una sede deselezionata darebbe una tendina
    // classi VUOTA — una scelta promessa e poi non mantenuta, che finisce con un
    // bambino salvato senza sezione. Per iscrivere altrove si cambia sede nel
    // selettore del cockpit, che è il posto dove quella decisione si prende.
    const sediSelezionabili = sedi.filter(s => effettive.includes(s.id));
    const scuolaSelezionata = formData.scuola_id || sedeCorrente || '';
    // La tendina si popola solo quando l'elenco appartiene alla sede scelta.
    const sections = sezioniCaricate.scuolaId === scuolaSelezionata ? sezioniCaricate.elenco : [];
    const [errors, setErrors] = useState<Record<string, string>>({});

    /**
     * L'`id` del badge di coerenza, scritto e non lasciato al default.
     *
     * `role="status"` non promette nessun annuncio (lo dice la testata di
     * `BadgeCoerenzaCf`): la via dichiarata per SENTIRE il verdetto è
     * `aria-describedby` dal campo del codice fiscale. Senza `id` esplicito ogni
     * scheda erediterebbe lo stesso `badge-coerenza-cf`, e in questa pagina il badge
     * dell'alunno convivrebbe con quelli delle schede adulto — che
     * `FamilyRegistryManager` tiene montate insieme a questa.
     *
     * Statico e non `useId()` come nelle schede adulto, e la differenza è misurabile:
     * di `ScrollableStudentForm` `FamilyRegistryManager` monta UNA sola istanza
     * (riga 294), delle schede adulto ne monta N.
     */
    const idBadgeCf = 'alunno-badge-coerenza-cf';

    /**
     * ⚠️ E LO STESSO VALE PER GLI `id` DI TUTTI GLI ALTRI CAMPI, che fino all'11
     * agosto non c'erano. `htmlFor`/`id` erano stati messi al SOLO codice fiscale,
     * perché lì servivano all'`aria-describedby` del badge: gli undici vicini —
     * nome, cognome, sesso, data, cittadinanza, sede, sezione, indirizzo, civico,
     * comune, provincia, CAP — erano `<label>` sospesi sopra `<input>` senza nome
     * accessibile. Non è una deduzione: axe conta NOVE violazioni `label` /
     * `select-name` su questa scheda, misurate e ora rosse per sempre in
     * `__tests__/a11y/schede-alunno-a11y.test.tsx`. `smoke.axe.test.tsx` questo
     * componente non lo monta, ed è il motivo per cui il gate restava verde.
     *
     * Il prefisso `alunno-` è statico per la stessa ragione di `idBadgeCf`:
     * `FamilyRegistryManager` monta UNA sola istanza di questa scheda (riga 294) e
     * il tab `student` è unico, mentre delle schede adulto — che le stanno accanto
     * nella stessa pagina — ne monta N, ed è per quello che LORO usano `useId()`.
     */

    const initialFormData = {
        nome: '', cognome: '', sesso: 'M', data_nascita: '', comune_nascita: '', provincia_nascita: '',
        nazione_nascita: 'Italia', codice_belfiore_nascita: '', cittadinanza: 'Italiana',
        codice_fiscale: '', indirizzo_residenza: '', civico: '', comune_residenza: '', provincia_residenza: '', cap: '', classe_sezione: '',
        scuola_id: '', is_bes_dsa: false, note_bes: '', usa_pannolino: false, allergies: '', allergeni: [] as string[],
        invoice_holder_type: 'mom', invoice_holder_details: { nome: '', cognome: '', codice_fiscale: '', adult_id: '' },
    };

    // Sezioni della sede scelta. La fetch DIPENDE dalla sede: cambiarla ricarica.
    // Senza sede non si chiede nulla — un elenco di sezioni «di tutte le sedi
    // attive» è la trappola che assegnava a un bambino di Aversa la «3 ANNI» di
    // Giugliano, lasciando poi `section_id` NULL in silenzio.
    useEffect(() => {
        const sede = scuolaSelezionata;
        if (!sede) return;
        let annullato = false;
        const carica = async () => {
            try {
                const r = await fetch(`/api/admin/sections?scuola_id=${encodeURIComponent(sede)}`);
                const d = await r.json().catch(() => null);
                if (!annullato && Array.isArray(d)) setSezioniCaricate({ scuolaId: sede, elenco: d });
            } catch (error) {
                // Un catch muto qui significherebbe tendina vuota senza spiegazione:
                // l'operatore penserebbe «questa sede non ha classi». Nessun dato
                // nel messaggio (l'uuid della sede non è un errore, è contesto).
                logClient({ livello: 'error', evento: 'fetch', messaggio: `sezioni-sede-caricamento-fallito: ${nomeErrore(error)}` });
            }
        };
        void carica();
        return () => { annullato = true; };
    }, [scuolaSelezionata]);

    /**
     * ─── IL CODICE FISCALE SI CALCOLA QUI, IN RENDER, SENZA RETE ────────────────
     *
     * Fino al 2026-08-11 questo blocco era un `useEffect` con 800 ms di debounce che
     * chiamava `fetchFiscalCode` (`@/lib/utils/fiscalCodeApi`, 425 KB di libreria in un
     * chunk del browser). Tolta la rete, il debounce non ha più niente da attendere:
     * `calcolaCodiceFiscale` è puro e sincrono, e un effetto che scrive stato
     * riaprirebbe il ciclo `setState → effect → setState` che in questo repo ESLint
     * vieta (`react-hooks/set-state-in-effect`).
     *
     * ⚠️ IL CALCOLO VUOLE IL CODICE CATASTALE, NON IL NOME DEL COMUNE. È la ragione per
     * cui i tre campi liberi sono diventati `<LuogoNascitaFields>`: «Napoli» scritto a
     * mano non produce nessun codice — `F839` sì. Finché il comune non è stato scelto
     * dalla tendina, `codice_belfiore_nascita` è vuoto e qui esce `null`, cioè nessun
     * suggerimento. Che è il comportamento giusto: meglio un campo vuoto che un codice
     * costruito su un comune indovinato.
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
     * ⚠️ QUELLO CHE L'OPERATORE HA DIGITATO VINCE SEMPRE, e non è una preferenza: il
     * codice sul tesserino è l'unico dato certo, quello calcolato è solo ciò che
     * l'anagrafica IMPLICA (vedi la testata di `calcolo.ts`). Su un omocodico —
     * assegnato dall'Agenzia, quindi legittimo e NON calcolabile — sovrascrivere
     * significherebbe cancellare il codice vero di un bambino con uno inventato.
     *
     * Qui il ruolo che aveva `codiceFiscaleRef` (uno specchio di
     * `formData.codice_fiscale`, tenuto solo perché l'effect non potesse dipendere dal
     * campo) lo fa il campo stesso: il suggerimento parla SOLO quando
     * `formData.codice_fiscale` è vuoto. Il ref è sparito perché la sua unica lettura
     * sarebbe stata in render, e lì ESLint la vieta — MISURATO, non dedotto:
     * `react-hooks/refs` → «Cannot access refs during render». Il valore che
     * proteggeva è rimasto, ed è quello che l'operatore vede nel campo.
     */
    const codiceFiscaleMostrato = formData.codice_fiscale || (codiceFiscaleCalcolato ?? '');
    const cfDalCalcolo = formData.codice_fiscale === '' && codiceFiscaleCalcolato !== null;

    /**
     * ⚠️ DECISIONE DI PRODOTTO, non un dettaglio d'implementazione — scritta qui perché
     * chi legge il codice non possa scoprirla per caso.
     *
     * `codiceFiscaleMostrato` è ciò che si vede E ciò che `validate()` spedisce.
     * Conseguenza: su un'anagrafica NUOVA con nome, cognome, sesso, data e comune
     * scelto dalla tendina, **il codice fiscale calcolato si salva sempre, e non
     * esiste nessun gesto che permetta di salvare la scheda senza**. Chi svuota il
     * campo vede tornare il suggerimento — perché «vuoto» e «svuotato apposta» qui non
     * si distinguono: c'è un solo stato, `formData.codice_fiscale === ''`.
     *
     * È accettato perché il record è NUOVO — non c'è niente in archivio da
     * contraddire, il codice è esatto per costruzione (il comune viene dalla tendina,
     * quindi il codice catastale è quello vero) e lo schema non lo pretende
     * (`optional()`, ramo che di fatto non si raggiunge). È l'OPPOSTO della scelta
     * fatta in `StudentDetailPanel`, dove il calcolo propone e basta: lì si aprono i
     * record veri e riempire da soli significherebbe scrivere su diciotto bambini un
     * codice che nessun documento ha confermato.
     *
     * Se un giorno servisse poterlo lasciare vuoto, la modifica è una sola e va
     * decisa, non dedotta: tenere uno stato «campo toccato» e spedire
     * `formData.codice_fiscale` quando l'operatore l'ha svuotato di proposito.
     */

    /**
     * Il verdetto del badge. NON blocca il salvataggio, mai: `validate()` non lo guarda
     * nemmeno. Un dato mancante non è un errore — con 18 alunni su 33 senza comune di
     * nascita, un pannello che pretende di verificare tutto diventa rosso ovunque e si
     * impara a ignorarlo in una settimana.
     */
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
     * I tre campi del luogo di nascita, che ora sono UN campo solo. La nomenclatura di
     * QUESTA scheda è `comune_nascita` / `provincia_nascita` / `nazione_nascita` (la
     * scheda di dettaglio usa `birth_city` / `birth_province` / `birth_nation`: sono lo
     * stesso dato con tre nomi, e mescolarli significa scrivere in una colonna che non
     * esiste).
     */
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
        } else if (name === 'scuola_id') {
            // Cambiando plesso la sezione scelta non vale più: i nomi si ripetono
            // fra sedi, quindi tenerla sarebbe peggio che perderla (verrebbe
            // salvata come classe di un'ALTRA scuola).
            setFormData(prev => ({ ...prev, scuola_id: value, classe_sezione: '' }));
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

    // Il salvataggio è orchestrato dal contenitore (FamilyRegistryManager) tramite
    // un unico pulsante: qui esponiamo solo validazione + estrazione del payload.
    useImperativeHandle(ref, () => ({
        validate() {
            setErrors({});
            try {
                // Si valida la sede RISOLTA (scelta a mano oppure sede attiva
                // unica), non `formData.scuola_id`: sono la stessa cosa solo
                // quando l'operatore ha toccato la tendina. Vuota ⇒ zod ferma il
                // salvataggio con l'errore sotto il campo, e nessun payload esce.
                const parsedData = buildStudentSchema(t).parse({
                    ...formData,
                    scuola_id: scuolaSelezionata,
                    // Il codice MOSTRATO, non `formData.codice_fiscale`: quando
                    // l'operatore non ha digitato niente i due differiscono, e a
                    // salvarsi dev'essere ciò che sta scritto nel campo — non la
                    // stringa vuota che c'è dietro.
                    codice_fiscale: codiceFiscaleMostrato,
                    // Vuoto ⇒ `null`: la colonna è nullable e il `check` accetta solo
                    // la forma `^[A-Z][0-9]{3}$`. Una stringa vuota sarebbe un valore
                    // che non esiste, scritto al posto dell'assenza.
                    codice_belfiore_nascita: formData.codice_belfiore_nascita || null,
                });
                return { ok: true as const, data: parsedData };
            } catch (error) {
                const zodLike = error as { issues?: { path?: (string | number)[]; message: string }[] };
                if (zodLike && zodLike.issues) {
                    const fieldErrors: Record<string, string> = {};
                    zodLike.issues.forEach((err) => {
                        if (err.path && err.path.length > 0) fieldErrors[err.path.join('.')] = err.message;
                    });
                    setErrors(fieldErrors);
                }
                return { ok: false as const };
            }
        },
        reset() {
            setErrors({});
            setFormData({ ...initialFormData });
        },
    }), [formData, scuolaSelezionata, codiceFiscaleMostrato]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="text-kidville-green">
            <div className="flex items-center mb-8 border-b border-kidville-green/15 pb-4">
                <h2 className="text-2xl font-bold text-kidville-green flex items-center gap-2">
                    <User /> {t('sFormCompilazioneAlunno')}
                </h2>
            </div>

            <div className="space-y-12">
                {/* Sezione 1: Dati Personali */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-green pl-3">
                        {t('datiPersonali')}
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label htmlFor="alunno-nome" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoNome')}</label>
                            <input id="alunno-nome" name="nome" value={formData.nome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.nome ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`} />
                            {errors.nome && <span className="text-xs text-kidville-error font-bold">{errors.nome}</span>}
                        </div>
                        <div>
                            <label htmlFor="alunno-cognome" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCognome')}</label>
                            <input id="alunno-cognome" name="cognome" value={formData.cognome} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.cognome ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`} />
                            {errors.cognome && <span className="text-xs text-kidville-error font-bold">{errors.cognome}</span>}
                        </div>
                        <div>
                            <label htmlFor="alunno-sesso" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoSesso')}</label>
                            <select id="alunno-sesso" name="sesso" value={formData.sesso} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green">
                                <option value="M">{t('optMaschio')}</option>
                                <option value="F">{t('optFemmina')}</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor="alunno-data-nascita" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoDataNascita')}</label>
                            <DateField id="alunno-data-nascita" name="data_nascita" value={formData.data_nascita} onChange={(iso) => handleInputChange({ target: { name: 'data_nascita', value: iso, type: 'date' } } as unknown as React.ChangeEvent<HTMLInputElement>)} className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.data_nascita ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`} />
                            {errors.data_nascita && <span className="text-xs text-kidville-error font-bold">{errors.data_nascita}</span>}
                        </div>
                        {/* ⚠️ UN CAMPO SOLO, non tre. Comune, provincia e nazione erano
                            tre caselle di testo libero, e da lì non usciva nessun codice
                            catastale: senza quello il codice fiscale non è calcolabile —
                            «Napoli» non è `F839`. La tendina a cascata è anche l'unica
                            strada che tiene il dataset dei 13.656 comuni FUORI dal bundle
                            del browser (lock `dataset-comuni-fuori-dal-bundle`): passa
                            dalla rotta `/api/anagrafiche/comuni`, non da un import. */}
                        <div className="col-span-2">
                            <LuogoNascitaFields
                                valore={luogoNascita}
                                onChange={cambiaLuogoNascita}
                                idPrefisso="alunno"
                                errori={{ provincia: errors.provincia_nascita, comune: errors.comune_nascita }}
                            />
                            {errors.codice_belfiore_nascita && (
                                <span role="alert" className="text-xs text-kidville-error font-bold">
                                    {errors.codice_belfiore_nascita}
                                </span>
                            )}
                        </div>
                        <div>
                            <label htmlFor="alunno-cittadinanza" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCittadinanza')}</label>
                            <input id="alunno-cittadinanza" name="cittadinanza" value={formData.cittadinanza} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div className="col-span-2">
                            <label htmlFor="alunno-codice-fiscale" className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2">
                                <Fingerprint size={16} /> {t('campoCodiceFiscale')}
                                {/* Niente più rotellina né lampo di tre secondi: il calcolo
                                    è sincrono, quindi non c'è nessuna attesa da annunciare,
                                    e la nota resta finché il campo è quello suggerito. */}
                                {cfDalCalcolo && <span className="text-xs text-kidville-green font-normal">{t('cfAutocalcolato')}</span>}
                            </label>
                            <input
                                id="alunno-codice-fiscale"
                                name="codice_fiscale"
                                value={codiceFiscaleMostrato}
                                onChange={handleInputChange}
                                // Il verdetto si sente arrivando sul campo, una volta sola.
                                aria-describedby={idBadgeCf}
                                className={`w-full p-3 rounded-xl border outline-none uppercase transition-all duration-500 bg-kidville-white text-kidville-green placeholder-kidville-green/40 ${errors.codice_fiscale ? `border-kidville-error bg-kidville-error-soft ${ALONE_ERRORE}` : cfDalCalcolo ? 'border-kidville-green ring-2 ring-kidville-green/50 bg-kidville-green/5' : 'border-kidville-green/15 focus:ring-2 focus:ring-kidville-green'}`}
                            />
                            {errors.codice_fiscale && <span className="text-xs text-kidville-error font-bold">{errors.codice_fiscale}</span>}
                            {/* Segnala, non blocca: il badge non ha nessuna voce in
                                `validate()`. Ed è muto quando non c'è ancora un codice da
                                verificare — un campo da compilare non è un errore. */}
                            <div className="mt-2 empty:hidden">
                                <BadgeCoerenzaCf
                                    esito={esitoCoerenza}
                                    id={idBadgeCf}
                                    // Riempie il campo e nulla più: da qui non parte
                                    // nessun salvataggio (è il contratto del badge).
                                    onUsaCalcolato={(codice) => setFormData(prev => ({ ...prev, codice_fiscale: codice }))}
                                />
                            </div>
                        </div>
                    </div>
                </section>

                {/* Sezione 1b: Sede e Sezione */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        {t('sFormSedeSezione')}
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label htmlFor="alunno-scuola-id" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoSede')}</label>
                            <select
                                id="alunno-scuola-id"
                                name="scuola_id"
                                value={scuolaSelezionata}
                                onChange={handleInputChange}
                                disabled={sediSelezionabili.length <= 1}
                                className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green focus:ring-2 focus:ring-kidville-green disabled:opacity-70 ${errors.scuola_id ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`}
                            >
                                {sediSelezionabili.length === 0 && <option value="">{t('sFormNessunaSede')}</option>}
                                {/* Segnaposto vuoto: con più sedi accessibili e nessuna
                                    scelta, la sede va DICHIARATA. Nessuna preselezione. */}
                                {sediSelezionabili.length > 1 && !scuolaSelezionata && <option value="">{t('sFormSelezionaSede')}</option>}
                                {sediSelezionabili.map(s => (
                                    <option key={s.id} value={s.id}>{s.nome}</option>
                                ))}
                            </select>
                            {errors.scuola_id && <span className="text-xs text-kidville-error font-bold">{errors.scuola_id}</span>}
                        </div>
                        <div>
                            <label htmlFor="alunno-classe-sezione" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoSezione')}</label>
                            <select
                                id="alunno-classe-sezione"
                                name="classe_sezione"
                                value={formData.classe_sezione}
                                onChange={handleInputChange}
                                disabled={!scuolaSelezionata}
                                className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green focus:ring-2 focus:ring-kidville-green disabled:opacity-70 ${errors.classe_sezione ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`}
                            >
                                <option value="">{scuolaSelezionata ? t('sFormSelezionaSezione') : t('sFormSezioneScegliSede')}</option>
                                {sections.map(s => (
                                    <option key={s.id} value={s.name}>{s.name} ({s.school_type})</option>
                                ))}
                            </select>
                            {errors.classe_sezione && <span className="text-xs text-kidville-error font-bold">{errors.classe_sezione}</span>}
                        </div>
                    </div>
                </section>

                {/* Sezione 2: Residenza */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        {t('sezioneResidenza')}
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label htmlFor="alunno-indirizzo-residenza" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoIndirizzoResidenza')}</label>
                            <input id="alunno-indirizzo-residenza" name="indirizzo_residenza" value={formData.indirizzo_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.indirizzo_residenza ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`} placeholder={t('phVia')} />
                            {errors.indirizzo_residenza && <span className="text-xs text-kidville-error font-bold">{errors.indirizzo_residenza}</span>}
                        </div>
                        <div>
                            <label htmlFor="alunno-civico" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoNumeroCivico')}</label>
                            <input id="alunno-civico" name="civico" value={formData.civico} onChange={handleInputChange} maxLength={20} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" placeholder="123" />
                        </div>
                        <div>
                            <label htmlFor="alunno-comune-residenza" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoComuneResidenza')}</label>
                            <input id="alunno-comune-residenza" name="comune_residenza" value={formData.comune_residenza} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.comune_residenza ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`} />
                            {errors.comune_residenza && <span className="text-xs text-kidville-error font-bold">{errors.comune_residenza}</span>}
                        </div>
                        <div>
                            <label htmlFor="alunno-provincia-residenza" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoProvResidenza')}</label>
                            <input id="alunno-provincia-residenza" name="provincia_residenza" value={formData.provincia_residenza} onChange={handleInputChange} maxLength={2} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
                        </div>
                        <div>
                            <label htmlFor="alunno-cap" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCap')}</label>
                            <input id="alunno-cap" name="cap" value={formData.cap} onChange={handleInputChange} className={`w-full p-3 rounded-xl border outline-none bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green ${errors.cap ? 'border-kidville-error ${ALONE_ERRORE}' : 'border-kidville-green/15'}`} maxLength={5} />
                            {errors.cap && <span className="text-xs text-kidville-error font-bold">{errors.cap}</span>}
                        </div>
                    </div>
                </section>

                {/* Sezione 3: Medica / BES */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-error pl-3">
                        {t('sFormInfoMediche')}
                    </h3>
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2">
                                <AlertTriangle size={16} className="text-kidville-error" /> {t('allergieIntolleranze')}
                            </label>
                            <AllergeniSelect value={formData.allergeni} onChange={next => setFormData(prev => ({ ...prev, allergeni: next }))} />
                            {formData.allergies?.trim() && (
                                <p className="mt-2 rounded-xl bg-kidville-cream px-3 py-2 font-maven text-xs text-kidville-sub">
                                    {t('testoStorico', { testo: formData.allergies })}
                                </p>
                            )}
                        </div>

                        <div className="p-4 bg-kidville-warn-soft/10 rounded-2xl border border-kidville-warn">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" name="is_bes_dsa" checked={formData.is_bes_dsa} onChange={handleInputChange} className="w-5 h-5 rounded border-kidville-warn/50 bg-kidville-white text-kidville-warn focus:ring-kidville-warn" />
                                <span className="font-bold text-kidville-warn flex items-center gap-2">
                                    <FileWarning size={18} /> {t('studenteBesDsa')}
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
                                        <label htmlFor="alunno-note-bes" className="block text-sm font-bold text-kidville-warn mb-1">{t('noteBesDsa')}</label>
                                        <textarea id="alunno-note-bes" name="note_bes" value={formData.note_bes} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-warn bg-kidville-white text-kidville-green focus:ring-2 focus:ring-kidville-warn outline-none" rows={2} placeholder={t('phDettagliAggiuntivi')} />
                                        <div className="mt-3 text-sm text-kidville-warn/80">{t('besDocumentiHint')}</div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        {/* `bg-kidville-info-soft0/10` non esisteva (residuo di `bg-sky-500/10`
                            sostituito a macchina): il pannello restava senza fondo. */}
                        <div className="p-4 bg-kidville-info/10 rounded-2xl border border-kidville-info/30">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input type="checkbox" name="usa_pannolino" checked={formData.usa_pannolino} onChange={handleInputChange} className="w-5 h-5 rounded border-kidville-info-soft/50 bg-kidville-white text-kidville-info focus:ring-kidville-info" />
                                <span className="font-bold text-kidville-info flex items-center gap-2">
                                    🧷 {t('sFormUsaPannolino')}
                                </span>
                            </label>
                            <p className="mt-2 text-sm text-kidville-info/80">{t('sFormPannolinoHint')}</p>
                        </div>
                    </div>
                </section>

                {/* Sezione 4: Amministrazione */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        {t('sFormAmministrazione')}
                    </h3>
                    <div className="space-y-6">
                        <div>
                            <label className="block text-sm font-bold text-kidville-green/80 mb-2">{t('intestatarioFattura')}</label>
                            <div className="flex gap-4">
                                {['mom', 'dad', 'other'].map(type => (
                                    <label key={type} className={`flex-1 flex items-center justify-center p-3 rounded-xl border cursor-pointer transition-all ${formData.invoice_holder_type === type ? 'border-kidville-green bg-kidville-green/20 text-kidville-green font-bold' : 'border-kidville-green/15 text-kidville-sub hover:bg-kidville-cream'}`}>
                                        <input type="radio" name="invoice_holder_type" value={type} checked={formData.invoice_holder_type === type} onChange={handleInputChange} className="hidden" />
                                        {type === 'mom' ? t('ruoloMadre') : type === 'dad' ? t('ruoloPadre') : t('optAltroSoggetto')}
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
                                    // `bg-kidville-info-soft0/5` non esisteva (residuo di `bg-blue-500/5`).
                                    className="p-6 border border-kidville-info/30 bg-kidville-info/5 rounded-2xl overflow-hidden mt-2"
                                >
                                    <div className="flex items-center justify-between mb-4">
                                        <h4 className="font-bold text-kidville-info">{t('sFormDettagliIntestatario')}</h4>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label htmlFor="alunno-intestatario-nome" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoNome')}</label>
                                            <input id="alunno-intestatario-nome" name="invoice_holder_details.nome" value={formData.invoice_holder_details.nome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div>
                                            <label htmlFor="alunno-intestatario-cognome" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCognome')}</label>
                                            <input id="alunno-intestatario-cognome" name="invoice_holder_details.cognome" value={formData.invoice_holder_details.cognome} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white focus:ring-2 focus:ring-kidville-green outline-none" />
                                        </div>
                                        <div className="col-span-2">
                                            <label htmlFor="alunno-intestatario-codice-fiscale" className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCodiceFiscaleIntestatario')}</label>
                                            <input id="alunno-intestatario-codice-fiscale" name="invoice_holder_details.codice_fiscale" value={formData.invoice_holder_details.codice_fiscale} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
                                        </div>
                                        <div className="col-span-2 text-xs text-kidville-sub mt-2">
                                            {t('sFormNotaIntestatario')}
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </section>
            </div>
        </div>
    );
});
