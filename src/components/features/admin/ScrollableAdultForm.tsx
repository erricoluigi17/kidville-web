'use client';

import React, { useState, useMemo, useRef, useId, forwardRef, useImperativeHandle } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { UserPlus, Shield, Mail, Phone, MapPin, Plus, Trash2, Fingerprint } from 'lucide-react';
import { z } from 'zod';
import { BadgeCoerenzaCf } from '@/components/features/anagrafica/BadgeCoerenzaCf';
import { LuogoNascitaFields, type ValoreLuogoNascita } from '@/components/features/anagrafica/LuogoNascitaFields';
import { verificaCoerenza } from '@/lib/fiscale/coerenza';
import { DateField } from '@/components/ui/DateField';

// Schema con messaggi di validazione localizzati (costruito con `t`).
const buildAdultSchema = (t: (k: string) => string) => z.object({
    first_name: z.string().min(2, t('valMin2')),
    last_name: z.string().min(2, t('valMin2')),
    role: z.enum(['admin', 'coordinator', 'educator', 'parent', 'delegate', 'mother', 'father']),
    gender: z.enum(['M', 'F']).optional().or(z.literal('')),
    birth_date: z.string().optional().or(z.literal('')),
    citizenship: z.string().optional().or(z.literal('')),
    birth_nation: z.string().optional().or(z.literal('')),
    birth_province: z.string().max(2).optional().or(z.literal('')),
    birth_place: z.string().optional().or(z.literal('')),
    /**
     * Il codice catastale del luogo di nascita (`parents.codice_belfiore_nascita`).
     * NULLABLE e mai obbligatorio: è il dato che rende il codice fiscale CALCOLABILE,
     * non un requisito d'anagrafica. Su un comune che la tendina non riconosce resta
     * `null` mentre il testo del comune si conserva.
     *
     * ⚠️ Nomenclatura: questa scheda parla `birth_place` / `birth_province` /
     * `birth_nation` / `fiscal_code` (la scheda dell'alunno dice `comune_nascita` /
     * `provincia_nascita` / `codice_fiscale`, la scheda di dettaglio del genitore
     * dice `birth_city`). Sono lo stesso dato con tre nomi: mescolarli significa
     * scrivere in una colonna che non esiste.
     */
    codice_belfiore_nascita: z.string().regex(/^[A-Z][0-9]{3}$/, t('valBelfioreNonValido')).nullable(),
    fiscal_code: z.string().length(16, t('valCf16')).toUpperCase().optional().or(z.literal('')),
    address: z.string().optional().or(z.literal('')),
    civico: z.string().max(20).optional().or(z.literal('')),
    residence_city: z.string().optional().or(z.literal('')),
    residence_province: z.string().max(2).optional().or(z.literal('')),
    zip_code: z.string().max(10).optional().or(z.literal('')),
    emails: z.array(z.string().email(t('valEmailNonValida'))).optional(),
    phones: z.array(z.string()).optional()
});

export interface AdultFormHandle {
    // Scheda mai compilata (nome+cognome vuoti): va SALTATA dal salvataggio unico,
    // così si può registrare l'alunno con un solo genitore (o nessuno).
    isEmpty: () => boolean;
    // Valida i campi (mostra gli errori inline) e ritorna il payload per il POST
    // /api/admin/parents (action create_parent), oppure { ok:false } se invalido.
    validate: () => { ok: true; data: Record<string, unknown> } | { ok: false };
    reset: () => void;
}

export const ScrollableAdultForm = forwardRef<AdultFormHandle, { defaultRole?: string; updateTabLabel?: (label: string) => void }>(
    function ScrollableAdultForm({ defaultRole, updateTabLabel }, ref) {
    const t = useTranslations('adminStudents');
    /**
     * ⚠️ LA RADICE DEGLI `id` DEV'ESSERE UNICA PER SCHEDA, e non è una raffinatezza:
     * `FamilyRegistryManager` tiene MONTATE tutte le schede insieme (madre, padre, e
     * ogni delegato aggiunto) e ne nasconde le altre con `hidden` — quindi nel DOM
     * convivono più «Sesso», più «Codice fiscale» e più tendine del comune. Con un
     * prefisso fisso, `<label htmlFor>` porterebbe il fuoco al campo della scheda
     * sbagliata e `aria-describedby` leggerebbe il badge di un'altra persona.
     * `useId()` produce `:r3:`, con caratteri illegali nei selettori: si riducono qui.
     */
    const radiceId = `adulto-${useId().replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    const idBadgeCf = `${radiceId}-badge-cf`;
    const initialRole = defaultRole || 'mother';
    /**
     * ⚠️ IL SESSO NON SI INVENTA, e fino al 2026-08-11 questo campo lo faceva: la riga
     * era `(role === 'mother' || role === 'delegate') ? 'F' : 'M'`. Per «madre» e
     * «padre» il valore È il ruolo — sono le due schede fisse della famiglia, e chi le
     * apre ha già dichiarato di quale genitore sta parlando. Per un DELEGATO, un
     * educatore o un coordinatore no: quel `'F'` (e quel `'M'`) era un dato di una
     * persona vera, scelto da nessuno, che finiva in `parents.gender` al salvataggio e
     * da lì nel codice fiscale calcolato. Ora resta VUOTO, e il badge dice a voce che
     * senza il sesso il codice non è verificabile.
     *
     * Un valore predefinito qui non si può nemmeno dedurre dal nome di battesimo:
     * «Andrea» è maschile in Italia e femminile altrove, e in questo archivio ci sono
     * famiglie di più nazionalità.
     *
     * ⚠️ E VALE ANCHE DOPO IL MONTAGGIO, che è il buco chiuso l'11 agosto: la
     * deduzione qui sotto guardava il ruolo INIZIALE e poi non ci pensava più.
     * Aprendo la scheda «madre» (`gender: 'F'`) e cambiando la tendina del ruolo in
     * «Delegato», il sesso restava `'F'` — cioè esattamente il valore inventato che
     * questo commento dichiara di aver eliminato, arrivato per un'altra strada.
     * Ora `sessoImplicito` è consultato a OGNI cambio di ruolo (vedi
     * `handleInputChange`), e il valore scelto A MANO non viene mai sovrascritto:
     * `sessoSceltoAMano` distingue «il campo dice F perché lo dice il ruolo» da «il
     * campo dice F perché qualcuno l'ha scelto», e solo il primo si azzera.
     */
    const sessoImplicito = (ruolo: string) => (ruolo === 'mother' ? 'F' : ruolo === 'father' ? 'M' : '');
    const initialGender = sessoImplicito(initialRole);

    const initialFormData = {
        first_name: '',
        last_name: '',
        role: initialRole,
        gender: initialGender,
        birth_date: '',
        citizenship: 'Italiana',
        birth_nation: 'Italia',
        birth_province: '',
        birth_place: '',
        codice_belfiore_nascita: '',
        fiscal_code: '',
        address: '',
        civico: '',
        residence_city: '',
        residence_province: '',
        zip_code: '',
        emails: [''],
        phones: ['']
    };

    const [formData, setFormData] = useState(initialFormData);

    /**
     * «Il sesso l'ha scelto una persona», non «il sesso vale F». Senza questa
     * distinzione il cambio di ruolo o cancellerebbe una scelta deliberata, o
     * conserverebbe un valore che nessuno ha mai voluto. Sta in un `ref` e non in
     * uno stato perché non ha nessun effetto su ciò che si vede: cambia solo che
     * cosa il prossimo cambio di ruolo ha il diritto di toccare.
     */
    const sessoSceltoAMano = useRef(false);

    const [errors, setErrors] = useState<Record<string, string>>({});

    /**
     * ─── IL CAMPO PORTA CIÒ CHE È STATO DIGITATO. IL CALCOLO SI *PROPONE*. ──────
     *
     * ⚠️ QUESTA È LA CORREZIONE DELL'11 AGOSTO, ED È LA PIÙ IMPORTANTE DEL FILE.
     * Fino a poche ore fa l'`input` valeva `formData.fiscal_code || calcolato` e
     * `validate()` salvava quello stesso valore. Due conseguenze, entrambe MISURATE
     * e nessuna delle due voluta:
     *
     *   1. **il campo non si poteva svuotare.** Cancellandone il contenuto,
     *      `fiscal_code` tornava `''`, il ternario ripiegava sul calcolato e alla
     *      battuta successiva il codice era di nuovo lì. L'operatore non aveva
     *      NESSUN modo di dire «questa persona un codice fiscale non ce l'ha»;
     *   2. **il codice calcolato si salvava da solo.** Chi apriva la scheda,
     *      compilava l'anagrafica e premeva Salva scriveva su `parents.fiscal_code`
     *      — che è UNIQUE — un codice che nessuno aveva confermato. Per i nati
     *      all'estero, per gli omocodici (assegnati dall'Agenzia, per costruzione
     *      DIVERSI dal calcolato) e per i 27 genitori su 50 che in produzione un
     *      codice non ce l'hanno, quel valore è INVENTATO: e due invenzioni che
     *      collidono fanno fallire il salvataggio di una famiglia vera.
     *
     * Il contratto giusto è quello che `BadgeCoerenzaCf` già espone e che il vecchio
     * codice rendeva irraggiungibile: sul campo vuoto il badge PROPONE il codice che
     * l'anagrafica implica, con il bottone «Usa questo». Adottarlo è un gesto, non un
     * effetto collaterale — e finché nessuno lo compie, in archivio va l'assenza.
     *
     * Il codice atteso NON si calcola più qui: lo produce `verificaCoerenza`
     * (`codiceAtteso`), che lo ricava da `calcolaCodiceFiscale`. Una regola, un posto.
     *
     * ⚠️ IL CALCOLO VUOLE IL CODICE CATASTALE, NON IL NOME DEL COMUNE: «Napoli» non è
     * `F839`. Finché il comune non è stato scelto dalla tendina a cascata,
     * `codice_belfiore_nascita` è vuoto e non c'è niente da proporre — meglio nessuna
     * proposta che un codice costruito su un comune indovinato. E vuole il SESSO: con
     * `gender` vuoto (il caso di ogni delegato, da quando non lo si inventa più) il
     * badge dice a parole che manca, invece di scegliere per conto di qualcuno.
     *
     * Il verdetto NON blocca il salvataggio, mai: `validate()` non lo guarda nemmeno.
     */
    const esitoCoerenza = useMemo(
        () => verificaCoerenza(formData.fiscal_code, {
            nome: formData.first_name,
            cognome: formData.last_name,
            sesso: formData.gender,
            dataNascita: formData.birth_date,
            codiceBelfiore: formData.codice_belfiore_nascita,
        }),
        [formData.fiscal_code, formData.first_name, formData.last_name, formData.gender, formData.birth_date, formData.codice_belfiore_nascita],
    );

    /** I tre campi del luogo di nascita, che ora sono un campo solo (a cascata). */
    const luogoNascita: ValoreLuogoNascita = {
        provincia: formData.birth_province,
        comune: formData.birth_place,
        nazione: formData.birth_nation,
        belfiore: formData.codice_belfiore_nascita,
    };

    const cambiaLuogoNascita = (v: ValoreLuogoNascita) => {
        setFormData(prev => ({
            ...prev,
            birth_province: v.provincia,
            birth_place: v.comune,
            birth_nation: v.nazione,
            codice_belfiore_nascita: v.belfiore,
        }));
        setErrors(prev => {
            if (!prev.birth_place && !prev.birth_province && !prev.codice_belfiore_nascita) return prev;
            const next = { ...prev };
            delete next.birth_place;
            delete next.birth_province;
            delete next.codice_belfiore_nascita;
            return next;
        });
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        if (name === 'gender') sessoSceltoAMano.current = true;
        setFormData(prev => {
            // Il ruolo cambia ⇒ il sesso IMPLICITO cambia con lui, ma solo se il
            // valore attuale è quello che il vecchio ruolo implicava. «Madre» →
            // «Delegato» azzera la `F` che nessuno aveva scelto; se invece quella `F`
            // l'ha scelta l'operatore, resta dov'è.
            if (name === 'role' && !sessoSceltoAMano.current) {
                return { ...prev, role: value, gender: sessoImplicito(value) };
            }
            return { ...prev, [name]: value };
        });
        // Aggiorna l'etichetta della tab FUORI dall'updater (evita setState-in-render)
        if ((name === 'first_name' || name === 'last_name') && updateTabLabel) {
            const newFirst = name === 'first_name' ? value : formData.first_name;
            const newLast  = name === 'last_name'  ? value : formData.last_name;
            const label = `${newFirst} ${newLast}`.trim();
            updateTabLabel(label || t('familyNuovoAdulto'));
        }
        if (errors[name]) {
            setErrors(prev => { const newErrors = { ...prev }; delete newErrors[name]; return newErrors; });
        }
    };

    const handleArrayChange = (index: number, type: 'emails' | 'phones', value: string) => {
        setFormData(prev => {
            const arr = [...prev[type]];
            arr[index] = value;
            return { ...prev, [type]: arr };
        });
    };

    const addArrayItem = (type: 'emails' | 'phones') => {
        setFormData(prev => ({ ...prev, [type]: [...prev[type], ''] }));
    };

    const removeArrayItem = (index: number, type: 'emails' | 'phones') => {
        setFormData(prev => {
            const arr = [...prev[type]];
            if (arr.length > 1) arr.splice(index, 1);
            else arr[0] = '';
            return { ...prev, [type]: arr };
        });
    };

    // Salvataggio orchestrato dal contenitore (FamilyRegistryManager): qui solo
    // validazione + estrazione del payload (il role serve al collegamento lato server).
    useImperativeHandle(ref, () => ({
        isEmpty() {
            return !formData.first_name.trim() && !formData.last_name.trim();
        },
        validate() {
            setErrors({});
            try {
                const dataToValidate = {
                    ...formData,
                    emails: formData.emails.filter(e => e.trim() !== ''),
                    phones: formData.phones.filter(p => p.trim() !== ''),
                    // ⚠️ QUELLO CHE C'È NEL CAMPO, e nient'altro. Qui stava
                    // `codiceFiscaleMostrato`, cioè il codice CALCOLATO quando la casella
                    // era vuota: un valore che nessun essere umano aveva confermato
                    // finiva su una colonna UNIQUE. Il campo vuoto esce vuoto, e
                    // `buildParentRecord` lo normalizza a `null` prima dell'INSERT —
                    // perché con UNIQUE `''` è un valore, `NULL` no, e in produzione un
                    // genitore ha già `''` (misurato l'11 agosto).
                    fiscal_code: formData.fiscal_code.trim(),
                    // Vuoto ⇒ `null`: la colonna è nullable e accetta solo la forma
                    // `^[A-Z][0-9]{3}$`. Una stringa vuota sarebbe un valore che non
                    // esiste, scritto al posto dell'assenza.
                    codice_belfiore_nascita: formData.codice_belfiore_nascita || null,
                };
                const parsedData = buildAdultSchema(t).parse(dataToValidate);
                return { ok: true as const, data: { ...parsedData } };
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
            // Anche la memoria della scelta si azzera: una scheda ripulita non deve
            // ricordarsi che «qualcuno aveva scelto il sesso» di un'altra persona.
            sessoSceltoAMano.current = false;
            setFormData({ ...initialFormData });
        },
    }), [formData]); // eslint-disable-line react-hooks/exhaustive-deps

    return (
        <div className="text-kidville-green">
            <div className="flex items-center mb-8 border-b border-kidville-green/15 pb-4">
                <h2 className="text-2xl font-bold text-kidville-green flex items-center gap-2">
                    <UserPlus /> {t('aFormCompilazioneAdulto')}
                </h2>
            </div>

            <div className="space-y-12">
                {/* Dati Personali */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-green pl-3">
                        {t('datiPersonali')}
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <label htmlFor={`${radiceId}-nome`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoNome')}</label>
                            <input id={`${radiceId}-nome`} name="first_name" value={formData.first_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-kidville-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors.first_name ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.first_name && <span className="text-xs text-kidville-error font-bold">{errors.first_name}</span>}
                        </div>
                        <div>
                            <label htmlFor={`${radiceId}-cognome`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCognome')}</label>
                            <input id={`${radiceId}-cognome`} name="last_name" value={formData.last_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-kidville-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors.last_name ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                            {errors.last_name && <span className="text-xs text-kidville-error font-bold">{errors.last_name}</span>}
                        </div>
                        <div>
                            {/* `htmlFor`/`id`: senza, questa tendina era una casella SENZA
                                NOME per uno screen reader (violazione `select-name` di axe,
                                misurata l'11 agosto) — e stava nella stessa griglia del
                                campo «Sesso», che il nome invece ce l'aveva. */}
                            <label htmlFor={`${radiceId}-ruolo`} className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Shield size={14}/> {t('aFormRuoloFamiliare')}</label>
                            <select id={`${radiceId}-ruolo`} name="role" value={formData.role} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green">
                                <option value="mother">{t('ruoloMadre')}</option>
                                <option value="father">{t('ruoloPadre')}</option>
                                <option value="delegate">{t('aFormRuoloDelegato')}</option>
                                <option value="educator">{t('aFormRuoloEducatore')}</option>
                                <option value="coordinator">{t('aFormRuoloCoordinatore')}</option>
                            </select>
                        </div>
                        <div>
                            <label htmlFor={`${radiceId}-sesso`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoSesso')}</label>
                            {/* La voce vuota è la PRIMA e non è un ripiego: senza il sesso il
                                codice fiscale di un adulto non è calcolabile, e dirlo è più
                                onesto che scegliere per conto di qualcuno. */}
                            <select id={`${radiceId}-sesso`} name="gender" value={formData.gender} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green">
                                <option value="">{t('optSessoNonIndicato')}</option>
                                <option value="M">{t('optMaschio')}</option>
                                <option value="F">{t('optFemmina')}</option>
                            </select>
                        </div>
                    </div>
                </section>

                {/* Nascita e Cittadinanza */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-warn pl-3">
                        {t('detailNascitaCittadinanza')}
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            {/* `htmlFor`/`id`: l'etichetta era scollegata dal campo — un clic
                                sul testo non ci portava il fuoco e lo screen reader leggeva
                                una casella senza nome. */}
                            <label htmlFor={`${radiceId}-data-nascita`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoDataNascita')}</label>
                            <DateField id={`${radiceId}-data-nascita`} name="birth_date" value={formData.birth_date} onChange={(iso) => handleInputChange({ target: { name: 'birth_date', value: iso } } as unknown as React.ChangeEvent<HTMLInputElement>)} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div>
                            <label htmlFor={`${radiceId}-cittadinanza`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCittadinanza')}</label>
                            <input id={`${radiceId}-cittadinanza`} name="citizenship" value={formData.citizenship} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        {/* ⚠️ UN CAMPO SOLO, non tre. Nazione, comune e provincia erano tre
                            caselle di testo libero, e da lì non usciva nessun codice
                            catastale: senza quello il codice fiscale non è calcolabile. La
                            tendina a cascata è anche l'unica strada che tiene il dataset dei
                            13.656 comuni FUORI dal bundle del browser (lock
                            `dataset-comuni-fuori-dal-bundle`): passa dalla rotta
                            `/api/anagrafiche/comuni`, non da un import. */}
                        <div className="col-span-2">
                            <LuogoNascitaFields
                                valore={luogoNascita}
                                onChange={cambiaLuogoNascita}
                                idPrefisso={radiceId}
                                errori={{
                                    comune: errors.birth_place || errors.codice_belfiore_nascita,
                                    provincia: errors.birth_province,
                                }}
                            />
                        </div>
                        <div className="col-span-2">
                            <label htmlFor={`${radiceId}-codice-fiscale`} className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2">
                                <Fingerprint size={16} /> {t('campoCodiceFiscale')}
                            </label>
                            {/* ⚠️ `formData.fiscal_code`, NON il codice mostrato: è ciò che
                                rende il campo SVUOTABILE. Con `value={digitato || calcolato}`
                                cancellare il contenuto lo faceva ricomparire alla battuta
                                successiva, e «questa persona non ha un codice fiscale» — che
                                in produzione vale per 27 genitori su 50 — non era una cosa
                                che si potesse dire. */}
                            <input
                                id={`${radiceId}-codice-fiscale`}
                                name="fiscal_code"
                                value={formData.fiscal_code}
                                onChange={handleInputChange}
                                aria-describedby={idBadgeCf}
                                className={`w-full p-3 rounded-xl border outline-none uppercase bg-kidville-white text-kidville-green placeholder-kidville-green/40 transition-colors ${errors.fiscal_code ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15 focus:ring-2 focus:ring-kidville-green'}`}
                            />
                            {errors.fiscal_code && <span className="text-xs text-kidville-error font-bold">{errors.fiscal_code}</span>}
                            {/* Segnala e PROPONE, non decide: il badge non ha nessuna voce in
                                `validate()`, ed è muto quando non c'è né un codice da
                                verificare né uno da proporre — un campo da compilare non è
                                un errore. `onUsaCalcolato` compila il campo e basta: non
                                salva, e senza il clic in archivio va l'assenza. */}
                            <div className="mt-2 empty:hidden">
                                <BadgeCoerenzaCf
                                    esito={esitoCoerenza}
                                    id={idBadgeCf}
                                    onUsaCalcolato={(codice) => setFormData(prev => ({ ...prev, fiscal_code: codice }))}
                                />
                            </div>
                        </div>
                    </div>
                </section>

                {/* Residenza */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-kidville-info pl-3">
                        <MapPin size={20} className="text-kidville-info"/> {t('sezioneResidenza')}
                    </h3>
                    {/* Le cinque etichette di questa sezione erano SCOLLEGATE dai propri
                        campi: un clic sul testo non portava il fuoco, e uno screen reader
                        leggeva cinque caselle senza nome (violazione `label` di axe, x5,
                        misurata l'11 agosto sul componente montato). */}
                    <div className="grid grid-cols-2 gap-6">
                        <div className="col-span-2">
                            <label htmlFor={`${radiceId}-indirizzo`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoIndirizzoResidenza')}</label>
                            <input id={`${radiceId}-indirizzo`} name="address" value={formData.address} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" placeholder={t('phVia')} />
                        </div>
                        <div>
                            <label htmlFor={`${radiceId}-civico`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoNumeroCivico')}</label>
                            <input id={`${radiceId}-civico`} name="civico" value={formData.civico} onChange={handleInputChange} maxLength={20} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" placeholder="123" />
                        </div>
                        <div>
                            <label htmlFor={`${radiceId}-citta-residenza`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCittaResidenza')}</label>
                            <input id={`${radiceId}-citta-residenza`} name="residence_city" value={formData.residence_city} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                        <div>
                            <label htmlFor={`${radiceId}-prov-residenza`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoProvResidenza')}</label>
                            <input id={`${radiceId}-prov-residenza`} name="residence_province" value={formData.residence_province} onChange={handleInputChange} maxLength={2} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none uppercase" />
                        </div>
                        <div>
                            <label htmlFor={`${radiceId}-cap`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCap')}</label>
                            <input id={`${radiceId}-cap`} name="zip_code" value={formData.zip_code} onChange={handleInputChange} maxLength={10} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                        </div>
                    </div>
                </section>

                {/* Contatti */}
                <section>
                    <h3 className="text-lg font-bold text-kidville-green mb-4 flex items-center gap-2 border-l-4 border-pink-500 pl-3">
                        {t('aFormContattiAccesso')}
                    </h3>
                    <div className="grid grid-cols-2 gap-6">
                        {/* Telefoni */}
                        <div>
                            {/* ⚠️ QUI L'ETICHETTA È DI UN GRUPPO, non di un campo: i numeri
                                sono N, e un `htmlFor` può puntarne uno solo. Ogni casella
                                porta quindi il proprio nome con il proprio numero d'ordine
                                — senza, uno screen reader annunciava «casella di testo»
                                due volte di fila senza dire quale delle due. */}
                            <span className="block text-sm font-bold text-kidville-green/80 mb-2 flex items-center gap-2"><Phone size={14}/> {t('aFormNumeriCellulare')}</span>
                            <div className="space-y-3">
                                <AnimatePresence>
                                    {formData.phones.map((phone, idx) => (
                                        <motion.div key={idx} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2">
                                            <input id={`${radiceId}-telefono-${idx}`} aria-label={t('aFormTelefonoN', { n: idx + 1 })} value={phone} onChange={(e) => handleArrayChange(idx, 'phones', e.target.value)} placeholder="+39 333 000 0000" className="flex-1 p-3 rounded-xl border border-kidville-green/15 bg-kidville-white text-kidville-green placeholder-kidville-green/40 focus:ring-2 focus:ring-kidville-green outline-none" />
                                            <button onClick={() => removeArrayItem(idx, 'phones')} aria-label={t('aFormRimuoviTelefono')} className="p-3 bg-kidville-error/10 text-kidville-error rounded-xl hover:bg-kidville-error/20 transition-colors">
                                                <Trash2 size={18} />
                                            </button>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                                <button onClick={() => addArrayItem('phones')} className="text-sm font-bold text-kidville-green flex items-center gap-1 hover:underline">
                                    <Plus size={14} /> {t('aFormAggiungiNumero')}
                                </button>
                            </div>
                        </div>

                        {/* Email */}
                        <div>
                            <span className="block text-sm font-bold text-kidville-green/80 mb-2 flex items-center gap-2"><Mail size={14}/> {t('aFormIndirizziEmail')}</span>
                            <div className="space-y-3">
                                <AnimatePresence>
                                    {formData.emails.map((email, idx) => (
                                        <motion.div key={idx} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex items-center gap-2">
                                            <div className="flex-1 relative">
                                                <input id={`${radiceId}-email-${idx}`} aria-label={t('aFormEmailN', { n: idx + 1 })} type="email" value={email} onChange={(e) => handleArrayChange(idx, 'emails', e.target.value)} placeholder="mario.rossi@email.com" className={`w-full p-3 rounded-xl border bg-kidville-white text-kidville-green placeholder-kidville-green/40 outline-none focus:ring-2 focus:ring-kidville-green ${errors[`emails.${idx}`] ? 'border-kidville-error shadow-[0_0_10px_rgba(239,68,68,0.3)]' : 'border-kidville-green/15'}`} />
                                                {idx === 0 && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] uppercase font-black tracking-widest text-kidville-green bg-kidville-green/10 px-2 py-1 rounded">{t('aFormPrimaria')}</span>}
                                            </div>
                                            <button onClick={() => removeArrayItem(idx, 'emails')} aria-label={t('aFormRimuoviEmail')} className="p-3 bg-kidville-error/10 text-kidville-error rounded-xl hover:bg-kidville-error/20 transition-colors">
                                                <Trash2 size={18} />
                                            </button>
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                                <button onClick={() => addArrayItem('emails')} className="text-sm font-bold text-kidville-green flex items-center gap-1 hover:underline">
                                    <Plus size={14} /> {t('aFormAggiungiEmail')}
                                </button>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
});
