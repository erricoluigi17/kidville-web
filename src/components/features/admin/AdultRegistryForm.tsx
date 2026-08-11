'use client';

import React, { useState, useEffect, useId, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { UserPlus, Shield, Mail, Phone, Loader2, CheckCircle2, XCircle, Building2, Fingerprint } from 'lucide-react';
import { z } from 'zod';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { BadgeCoerenzaCf } from '@/components/features/anagrafica/BadgeCoerenzaCf';
import { LuogoNascitaFields, type ValoreLuogoNascita } from '@/components/features/anagrafica/LuogoNascitaFields';
import { verificaCoerenza } from '@/lib/fiscale/coerenza';
import { eCfGenitoreDuplicato } from '@/lib/anagrafiche/errori-cf';

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ QUESTA SCHEDA NON È MONTATA DA NESSUNA PAGINA. VA DETTO PRIMA DI TUTTO.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * MISURATO l'11 agosto: `grep -rn AdultRegistryForm src/` non trova nessun
 * importatore che non sia questo file stesso. Nessun utente arriva qui. Quindi la
 * cascata del luogo di nascita, il badge di coerenza, il sesso che non si inventa
 * più e la correzione `emails: [...]` — quest'ultima presentata altrove come «lo
 * sblocco di un 400 sistematico» — sono, oggi, codice corretto e IRRAGGIUNGIBILE.
 * Dirlo qui costa una riga; scoprirlo fra sei mesi costa una giornata.
 *
 * ─── E MONTARLA NON BASTEREBBE: LA ROTTA SCARTA MEZZO MODULO ────────────────
 * `POST /api/admin/adults` scrive in **`utenti`**, non in `parents`, e il suo
 * `postBodySchema` accetta soltanto `emails` · `first_name` · `last_name` · `role` ·
 * `scuola_id` (route.ts:15-23): `fiscal_code`, `gender` e i `birth_*` che questo
 * modulo produce vengono scartati da zod prima ancora dell'handler. E non è un
 * dimenticanza dello schema — è che la tabella quelle colonne non ce le ha: le 13
 * colonne di `utenti`, misurate l'11 agosto su `information_schema`, sono
 * `id · email · nome · cognome · cellulare · ruolo · scuola_id · attivo · creato_il ·
 * first_name · last_name · role · gradi`. Montare questa scheda richiederebbe una
 * MIGRAZIONE sul database di produzione, che è un'altra corsia e un'altra decisione.
 *
 * ─── PERCHÉ ALLORA È STATA CORRETTA LO STESSO ───────────────────────────────
 * Perché la strada viva verso `parents` è l'altra — `FamilyRegistryManager` →
 * `ScrollableAdultForm` → `POST /api/admin/students` / `create_parent` — e finché
 * questo file esiste, deve dire la stessa cosa delle altre due schede: il codice
 * fiscale calcolato si PROPONE, non si adotta d'ufficio. Un modulo dormiente che
 * porta dentro la regola sbagliata è la regola sbagliata che torna il giorno in cui
 * qualcuno lo monta.
 *
 * ─── E LO STESSO ARGOMENTO VALE PER LE ALTRE DUE COSE ROTTE QUI DENTRO ──────
 * Metà scheda era tradotta e metà no («Nuovo Adulto», «Nome», «Cognome», «Ruolo»,
 * «Correggi gli errori.» erano italiano CABLATO accanto a `t('campoSesso')`), e il
 * caricamento delle sedi finiva in `.catch(() => {})` — che AGENTS.md §6 vieta:
 * un catch che non logga è un bug. Erano preesistenti e su codice non montato,
 * quindi non urgenti; ma «lo correggo lo stesso perché un modulo dormiente con la
 * regola sbagliata è la regola sbagliata che torna» o vale per tutto o non vale.
 * Corrette entrambe l'11 agosto.
 */

const adultSchema = z.object({
    first_name: z.string().min(2),
    last_name: z.string().min(2),
    role: z.enum(['admin', 'coordinator', 'educator', 'parent', 'delegate']),
    email: z.string().email().optional().or(z.literal('')),
    fiscal_code: z.string().length(16).toUpperCase().optional().or(z.literal('')),
    gender: z.enum(['M', 'F']).optional().or(z.literal('')),
    birth_date: z.string().optional().or(z.literal('')),
    birth_place: z.string().optional().or(z.literal('')),
    birth_province: z.string().max(2).optional().or(z.literal('')),
    birth_nation: z.string().optional().or(z.literal('')),
    /** Il codice catastale del luogo di nascita: nullable, mai obbligatorio. */
    codice_belfiore_nascita: z.string().regex(/^[A-Z][0-9]{3}$/).nullable(),
    phone: z.string().optional().or(z.literal('')),
    // Multi-sede: la sede di destinazione. L'API adults la valida via
    // resolveScuolaScrittura (una sola sede per la scrittura).
    scuola_id: z.string().optional().or(z.literal(''))
});

interface Sede { id: string; nome: string }

export function AdultRegistryForm() {
    const t = useTranslations('adminStudents');
    /** Radice unica degli `id`, così due schede aperte insieme non si rubano il fuoco. */
    const radiceId = `adulto-registro-${useId().replace(/[^A-Za-z0-9_-]+/g, '-')}`;
    const idBadgeCf = `${radiceId}-badge-cf`;

    const [formData, setFormData] = useState({
        first_name: '',
        last_name: '',
        role: 'parent',
        email: '',
        fiscal_code: '',
        /**
         * ⚠️ VUOTO, non `'M'`. Fino al 2026-08-11 questo campo nasceva a «Maschio»: un
         * dato di una persona vera, scelto da nessuno, che entrava nel payload al
         * primo salvataggio e da lì nel codice fiscale calcolato. Senza il sesso il
         * codice di un adulto non è calcolabile — e dirlo è più onesto che indovinare.
         * Dal nome di battesimo non si deduce: «Andrea» è maschile in Italia e
         * femminile altrove.
         */
        gender: '',
        birth_date: '',
        birth_place: '',
        birth_province: '',
        birth_nation: '',
        codice_belfiore_nascita: '',
        phone: '',
        scuola_id: ''
    });

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);
    const [sedi, setSedi] = useState<Sede[]>([]);

    // Sedi accessibili (multi-sede): la select «Sede» compare solo se >1. Con una
    // sola sede il campo è superfluo — la risolve comunque resolveScuolaScrittura.
    useEffect(() => {
        let alive = true;
        fetch('/api/admin/sedi')
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
                if (!alive || !Array.isArray(j?.data)) return;
                setSedi(j.data as Sede[]);
                if (j.data.length === 1) {
                    setFormData((prev) => ({ ...prev, scuola_id: (j.data[0] as Sede).id }));
                }
            })
            // ⚠️ Qui stava `.catch(() => {})`, che AGENTS.md §6 vieta: un catch che non
            // logga è un bug. L'errore È tollerabile — senza l'elenco la select non
            // compare e `resolveScuolaScrittura` risolve comunque la sede lato server —
            // ma «tollerabile» non vuol dire «invisibile»: se la rotta delle sedi non
            // risponde, chi legge i log deve poterlo sapere. `warn` è il livello più
            // basso che il logger del browser espone (`info` non esiste, di proposito).
            .catch((e) => {
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `sedi-non-caricate: ${nomeErrore(e)}`,
                    route: '/admin/students',
                });
            });
        return () => { alive = false; };
    }, []);

    /**
     * ─── IL CAMPO PORTA IL DIGITATO. IL CALCOLO SI *PROPONE*. ──────────────────
     * `verificaCoerenza` produce anche `codiceAtteso` (da `calcolaCodiceFiscale`,
     * puro e sincrono: niente debounce, nessun dato di una persona vera spedito a un
     * servizio terzo). Il calcolo vuole il codice CATASTALE — non il nome del comune
     * — e vuole il SESSO: senza uno dei due non c'è niente da proporre.
     *
     * Il campo NON si autocompila: se lo facesse, cancellarlo non servirebbe a
     * niente (il valore tornerebbe alla battuta dopo) e premere Salva scriverebbe un
     * codice che nessuno ha confermato. Il badge lo propone con «Usa questo».
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
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        if (errors[name]) {
            setErrors(prev => {
                const newErrors = { ...prev };
                delete newErrors[name];
                return newErrors;
            });
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        setErrors({});
        
        try {
            const parsedData = adultSchema.parse({
                ...formData,
                // Quello che c'è nel campo, e nient'altro: qui stava il codice
                // CALCOLATO, cioè un valore che nessuno aveva confermato, diretto verso
                // una colonna UNIQUE.
                fiscal_code: formData.fiscal_code.trim(),
                // Vuoto ⇒ `null`: una stringa vuota sarebbe un valore che non esiste.
                codice_belfiore_nascita: formData.codice_belfiore_nascita || null,
            });
            const body = {
                ...parsedData,
                // scuola_id vuoto → undefined: l'API lo risolve via resolveScuolaScrittura.
                scuola_id: formData.scuola_id || undefined,
                // ⚠️ `emails`, AL PLURALE, ed è una correzione: `POST /api/admin/adults`
                // legge `emails[0]` e non guarda `email`. Finché il corpo portava la sola
                // chiave singolare, la rotta rispondeva SEMPRE 400 «Primary Email is
                // required» — questa scheda non ha mai potuto salvare niente.
                emails: parsedData.email ? [parsedData.email] : [],
            };

            const res = await fetch('/api/admin/adults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t('aRegErroreCreazione'));
            }

            setToast({ type: 'success', message: t('aRegSalvatoOk') });
            setFormData({
                first_name: '', last_name: '', role: 'parent', email: '', fiscal_code: '', gender: '', birth_date: '',
                birth_place: '', birth_province: '', birth_nation: '', codice_belfiore_nascita: '', phone: '',
                scuola_id: sedi.length === 1 ? sedi[0].id : ''
            });

        } catch (error) {
            if (error instanceof z.ZodError) {
                const fieldErrors: Record<string, string> = {};
                error.issues.forEach(err => {
                    if (err.path.length > 0) fieldErrors[err.path.join('.')] = err.message;
                });
                setErrors(fieldErrors);
                setToast({ type: 'error', message: t('aRegCorreggiErrori') });
            } else {
                // Il vincolo UNIQUE su `parents.fiscal_code` diventa una frase che si
                // capisce, non la riga di Postgres. Il riconoscimento vive in un posto
                // solo — `@/lib/anagrafiche/errori-cf`, importato qui sopra — perché la
                // regola vale per più strade e non può abitare dentro una scheda.
                const grezzo = (error as { message?: string })?.message ?? '';
                setToast({ type: 'error', message: eCfGenitoreDuplicato(grezzo) ? t('parentCfDuplicato') : grezzo });
            }
        } finally {
            setIsSubmitting(false);
            setTimeout(() => setToast(null), 4000);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="w-full max-w-3xl mx-auto p-8 bg-white backdrop-blur-xl border border-kidville-green/15 rounded-3xl shadow-xl relative text-kidville-green">
            <AnimatePresence>
                {toast && (
                    <motion.div
                        // L'errore si legge in pagina e si ANNUNCIA: senza `role`, chi usa
                        // uno screen reader non sapeva nemmeno che il salvataggio era
                        // fallito. I dati compilati restano dove sono.
                        role={toast.type === 'error' ? 'alert' : 'status'}
                        initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
                        className={`absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-6 py-3 rounded-full font-bold shadow-lg z-50 ${toast.type === 'success' ? 'bg-kidville-green text-white' : 'bg-kidville-error text-white'}`}
                    >
                        {toast.type === 'success' ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                        {toast.message}
                    </motion.div>
                )}
            </AnimatePresence>

            <h2 className="text-2xl font-bold text-kidville-green mb-6 flex items-center gap-3">
                <UserPlus className="text-kidville-green" /> {t('familyNuovoAdulto')}
            </h2>

            <div className="grid grid-cols-2 gap-6">
                <div>
                    <label htmlFor={`${radiceId}-nome`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoNome')}</label>
                    <input id={`${radiceId}-nome`} name="first_name" value={formData.first_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white outline-none focus:ring-2 focus:ring-kidville-green ${errors.first_name ? 'border-kidville-error' : 'border-kidville-green/15'}`} />
                </div>
                <div>
                    <label htmlFor={`${radiceId}-cognome`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoCognome')}</label>
                    <input id={`${radiceId}-cognome`} name="last_name" value={formData.last_name} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white outline-none focus:ring-2 focus:ring-kidville-green ${errors.last_name ? 'border-kidville-error' : 'border-kidville-green/15'}`} />
                </div>
                <div>
                    <label htmlFor={`${radiceId}-ruolo`} className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Shield size={14}/> {t('campoRuolo')}</label>
                    <select id={`${radiceId}-ruolo`} name="role" value={formData.role} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green">
                        <option value="parent">{t('ruoloGenitore')}</option>
                        <option value="educator">{t('aFormRuoloEducatore')}</option>
                        <option value="coordinator">{t('aFormRuoloCoordinatore')}</option>
                        <option value="delegate">{t('aFormRuoloDelegato')}</option>
                    </select>
                </div>
                <div>
                    <label htmlFor={`${radiceId}-email`} className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Mail size={14}/> {t('aRegEmailCredenziali')}</label>
                    <input id={`${radiceId}-email`} type="email" name="email" value={formData.email} onChange={handleInputChange} className={`w-full p-3 rounded-xl border bg-white outline-none focus:ring-2 focus:ring-kidville-green ${errors.email ? 'border-kidville-error' : 'border-kidville-green/15'}`} placeholder={t('aRegEmailPlaceholder')} />
                </div>
                <div>
                    <label htmlFor={`${radiceId}-sesso`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoSesso')}</label>
                    <select id={`${radiceId}-sesso`} name="gender" value={formData.gender} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green">
                        <option value="">{t('optSessoNonIndicato')}</option>
                        <option value="M">{t('optMaschio')}</option>
                        <option value="F">{t('optFemmina')}</option>
                    </select>
                </div>
                <div>
                    <label htmlFor={`${radiceId}-data-nascita`} className="block text-sm font-bold text-kidville-green/80 mb-1">{t('campoDataNascita')}</label>
                    <input id={`${radiceId}-data-nascita`} type="date" name="birth_date" value={formData.birth_date} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green" />
                </div>
                {/* ⚠️ UN CAMPO SOLO al posto della casella libera «Comune»: da un comune
                    scritto a mano non esce nessun codice catastale, e senza quello il
                    codice fiscale non è calcolabile. Il dataset dei comuni resta fuori dal
                    bundle del browser: passa dalla rotta `/api/anagrafiche/comuni`. */}
                <div className="col-span-2">
                    <LuogoNascitaFields valore={luogoNascita} onChange={cambiaLuogoNascita} idPrefisso={radiceId} />
                </div>
                <div className="col-span-2">
                    <label htmlFor={`${radiceId}-codice-fiscale`} className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2">
                        <Fingerprint size={14} /> {t('campoCodiceFiscale')}
                    </label>
                    <input
                        id={`${radiceId}-codice-fiscale`}
                        name="fiscal_code"
                        value={formData.fiscal_code}
                        onChange={handleInputChange}
                        aria-describedby={idBadgeCf}
                        className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green uppercase"
                    />
                    {/* Segnala, non blocca: il badge non ha nessuna voce nel submit. */}
                    <div className="mt-2 empty:hidden">
                        <BadgeCoerenzaCf
                            esito={esitoCoerenza}
                            id={idBadgeCf}
                            onUsaCalcolato={(codice) => setFormData(prev => ({ ...prev, fiscal_code: codice }))}
                        />
                    </div>
                </div>
                <div>
                    <label htmlFor={`${radiceId}-telefono`} className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Phone size={14}/> {t('campoTelefono')}</label>
                    <input id={`${radiceId}-telefono`} name="phone" value={formData.phone} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green" />
                </div>
                {sedi.length > 1 && (
                    <div className="col-span-2">
                        <label htmlFor={`${radiceId}-sede`} className="block text-sm font-bold text-kidville-green/80 mb-1 flex items-center gap-2"><Building2 size={14}/> {t('campoSede')}</label>
                        <select id={`${radiceId}-sede`} name="scuola_id" value={formData.scuola_id} onChange={handleInputChange} className="w-full p-3 rounded-xl border border-kidville-green/15 bg-white outline-none focus:ring-2 focus:ring-kidville-green">
                            <option value="">{t('sFormSelezionaSede')}</option>
                            {sedi.map((s) => (
                                <option key={s.id} value={s.id}>{s.nome}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>

            <div className="mt-8 border-t border-kidville-green/15 pt-6 flex justify-end">
                <button type="submit" disabled={isSubmitting} className="flex items-center gap-2 px-8 py-3 rounded-full bg-kidville-green text-white font-bold hover:bg-kidville-green/90 shadow-lg disabled:opacity-50">
                    {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : t('aRegSalvaProfilo')}
                </button>
            </div>
        </form>
    );
}
