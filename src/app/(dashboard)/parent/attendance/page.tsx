'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, CalendarX2, AlertTriangle, RotateCcw } from 'lucide-react';
import { RigaAssenzaComunicata } from '@/components/features/parent/RigaAssenzaComunicata';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Una comunicazione di assenza fatta dal genitore e ancora RITIRABILE, come la
 * restituisce `GET /api/parent/presenze` nel campo `comunicate` (righe con
 * `giustificata_da` valorizzato e `registrato_da` ancora nullo).
 */
export interface AssenzaComunicata {
    id: string;
    data: string;
    giustificazione_testo: string | null;
    stato: string;
}

/** La rotta della PAGINA, per i log del client (mai la rotta della fetch). */
const ROTTA = '/parent/attendance';

/**
 * L'id del riquadro d'errore dell'invio. È una costante e non un `useId` perché
 * ci punta l'`aria-describedby` del campo del giorno: due nodi che devono
 * combaciare, e un id inventato in due punti diversi è il modo in cui
 * `aria-describedby` smette di descrivere qualcosa. La pagina è una sola per
 * schermata, quindi l'unicità è garantita.
 */
const ID_ERRORE_INVIO = 'attendance-errore-invio';

/**
 * Le due chiamate al backend vivono FUORI dal componente e non lanciano mai:
 * restituiscono un esito. Non è pulizia estetica —
 *  · un `catch` che tocca lo stato dentro una `useCallback` chiamata da un
 *    effetto fa fallire `react-hooks/set-state-in-effect` (regola d'errore in
 *    questo repo), e la scappatoia nota — `.catch(() => {})` al call-site — è
 *    vietata da AGENTS.md regola 6 e da ESLint `no-restricted-syntax`;
 *  · così l'errore di rete si logga UNA volta, nel punto in cui avviene, invece
 *    di essere inghiottito da chi aggiorna lo stato.
 */
type EsitoLettura =
    | { ok: true; voci: AssenzaComunicata[] }
    | { ok: false; corpo: unknown };

/**
 * Legge le assenze comunicate ancora annullabili. Il filtro (solo future, solo
 * quelle di questo genitore, solo quelle su cui l'appello non è stato fatto) è
 * del SERVER: qui non si rifiltra niente, altrimenti due regole diverse
 * direbbero due cose diverse sulla stessa riga.
 */
export async function leggiAssenzeComunicate(parentId: string, studentId: string): Promise<EsitoLettura> {
    try {
        const res = await fetch(
            `/api/parent/presenze?studentId=${encodeURIComponent(studentId)}&userId=${encodeURIComponent(parentId)}`,
            { headers: { 'x-user-id': parentId } },
        );
        const corpo: unknown = await res.json().catch(() => null);
        if (!res.ok) return { ok: false, corpo };
        const dati = (corpo as { data?: { comunicate?: unknown; comunicateLette?: unknown } } | null)?.data;
        // IL 200 CHE MENTE. La GET degrada a `comunicate: []` quando la sua query
        // fallisce — la home non deve rompersi per un elenco accessorio — e
        // risponde comunque 200: senza questa riga il ramo d'errore qui sotto,
        // che c'è ed è giusto, su quel guasto non veniva MAI raggiunto, e il
        // genitore leggeva «non hai comunicato nessuna assenza» avendone (e
        // perdendo anche il modo di annullarle). Il server ora lo dichiara.
        //
        // `=== false`, non `!dati?.comunicateLette`: un server che il campo non
        // lo manda ancora — rilascio a scaglioni, app dello store più nuova —
        // spedisce `undefined`, e «non lo dichiara» non è «dichiara di no».
        // Leggerlo come guasto trasformerebbe ogni risposta buona in un allarme.
        if (dati?.comunicateLette === false) return { ok: false, corpo };
        const voci = Array.isArray(dati?.comunicate) ? (dati.comunicate as AssenzaComunicata[]) : [];
        return { ok: true, voci };
    } catch (e) {
        // Rete giù, o corpo illeggibile. `nomeErrore` è l'UNICO pezzo dell'errore
        // che può lasciare il dispositivo: il `message` di un errore PostgREST
        // riecheggia filtri e colonne (`alunno_id=eq.<uuid>`), e questo canale
        // finisce in `app_log` per 30 giorni. Nessun motivo di assenza, mai.
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `parent/attendance: elenco assenze comunicate non letto — ${nomeErrore(e)}`,
            route: ROTTA,
        });
        return { ok: false, corpo: null };
    }
}

/**
 * Ritira una comunicazione. La coppia (alunno, giorno) è la chiave della riga —
 * `presenze` ha UNIQUE (alunno_id, data) — ed è il server a verificare che quella
 * riga sia davvero del genitore e che l'appello non sia già stato registrato:
 * risponde 409 `ASSENZA_GIA_REGISTRATA` se lo è.
 */
export async function annullaAssenzaComunicata(
    parentId: string,
    studentId: string,
    data: string,
): Promise<EsitoAnnullamento> {
    try {
        const res = await fetch(
            `/api/parent/presenze/comunica-assenza?studentId=${encodeURIComponent(studentId)}`
            + `&data=${encodeURIComponent(data)}&userId=${encodeURIComponent(parentId)}`,
            { method: 'DELETE', headers: { 'x-user-id': parentId } },
        );
        const corpo: unknown = await res.json().catch(() => null);
        return res.ok ? { ok: true } : { ok: false, corpo };
    } catch (e) {
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: `parent/attendance: annullamento assenza non riuscito — ${nomeErrore(e)}`,
            route: ROTTA,
        });
        return { ok: false, corpo: null };
    }
}

type EsitoAnnullamento = { ok: true } | { ok: false; corpo: unknown };

function AttendanceInner() {
    const t = useTranslations('parentServizi');
    const { parentId, studentId, ready } = useParentIdentity();
    const f = useDateFormat();
    // «Oggi» nel fuso Europe/Rome, non in UTC. Il `new Date().toISOString()` che
    // stava qui, fra mezzanotte e le 01:00 (02:00 in ora legale) italiane,
    // proponeva IERI come primo giorno selezionabile: una data che il server —
    // che ora la valida — rifiuta con ASSENZA_DATA_PASSATA. Il modulo suggeriva
    // l'unico valore che non poteva funzionare.
    const today = oggiFiscaleISO();

    const [data, setData] = useState(today);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * Il CODICE del rifiuto, accanto alla frase già tradotta.
     *
     * Serve a una cosa sola: sapere se il rifiuto riguarda IL GIORNO SCELTO, e
     * quindi se marcare il campo con `aria-invalid`. Marcarlo sempre manderebbe
     * il genitore a correggere un valore giusto quando il guasto è del server
     * (`ASSENZA_NON_SALVATA`), e uno screen reader annuncerebbe «non valido» su
     * un campo che non ha nessuna colpa.
     */
    const [codiceErrore, setCodiceErrore] = useState<string | null>(null);
    /**
     * Tutti i rifiuti che parlano della data cominciano con `ASSENZA_DATA_`
     * (`ASSENZA_DATA_PASSATA` oggi; un eventuale tetto superiore domani). Il
     * prefisso, e non l'elenco dei codici, perché un codice nuovo scritto nella
     * route non deve dipendere da qualcuno che si ricordi di aggiornarlo qui.
     */
    const erroreSullaData = codiceErrore?.startsWith('ASSENZA_DATA_') ?? false;

    // ── Elenco delle assenze già comunicate ──────────────────────────────────
    const [comunicate, setComunicate] = useState<AssenzaComunicata[]>([]);
    const [caricandoElenco, setCaricandoElenco] = useState(true);
    const [erroreElenco, setErroreElenco] = useState<string | null>(null);
    /**
     * La data in corso di annullamento. Serve a DUE cose, e la seconda è il
     * motivo per cui è una data e non un booleano: mostra «Annullamento…» solo
     * sulla riga toccata (con un booleano lo direbbero tutte, e il genitore non
     * saprebbe quale sta partendo). I bottoni delle ALTRE righe restano
     * disabilitati lo stesso finché la chiamata è in volo: due DELETE
     * sovrapposte tornerebbero in ordine qualunque, e l'ultima rilettura
     * vincerebbe sulla prima.
     */
    const [annullando, setAnnullando] = useState<string | null>(null);
    const [esitoAnnullamento, setEsitoAnnullamento] = useState<string | null>(null);
    const [erroreAnnullamento, setErroreAnnullamento] = useState<string | null>(null);
    /**
     * Dove va il FUOCO quando la riga annullata sparisce.
     *
     * Il bottone «Annulla» si smonta insieme alla sua riga: chi l'ha premuto da
     * tastiera si ritrova il fuoco su `<body>` — cioè riparte dall'inizio della
     * pagina — e chi usa uno screen reader perde il punto in cui stava e non
     * sente mai com'è finita. È lo stesso motivo per cui `Modal.tsx` ripristina
     * il fuoco alla chiusura (WCAG 2.4.3): un'azione riuscita non deve costare
     * la posizione a chi non usa il mouse.
     */
    const refEsito = useRef<HTMLParagraphElement | null>(null);
    /**
     * Dove va il FUOCO quando l'invio riesce, e quando si torna indietro.
     *
     * Il successo trasforma la pagina: il modulo si smonta e compare la conferma.
     * Chi ha premuto «Comunica assenza» da tastiera si ritrova il fuoco su
     * `<body>` — riparte dall'inizio della pagina — e chi usa uno screen reader
     * non sente NIENTE: nel nuovo albero non c'era nessuna live region, e la
     * tentazione naturale, di fronte al silenzio, è ripremere. È lo stesso difetto
     * che `refEsito` qui sopra chiude per l'annullamento (WCAG 2.4.3, la ragione
     * per cui anche `Modal.tsx` ripristina il fuoco alla chiusura); il ramo
     * dell'invio era rimasto indietro.
     *
     * Il ritorno («Comunica un'altra assenza») ha lo stesso problema al contrario:
     * il bottone si smonta insieme alla conferma, e il fuoco va rimesso dentro
     * il modulo.
     */
    const refConferma = useRef<HTMLHeadingElement | null>(null);
    /**
     * Dove RIENTRA il fuoco tornando al modulo: il paragrafo che spiega cosa
     * fare, NON il campo del giorno.
     *
     * ⚠️ REGRESSIONE iOS, misurata il 2026-08-07. Il ricovero precedente puntava
     * a `<input type="date">`. Su WebKit/iOS il solo FUOCO su quel campo apre il
     * selettore nativo: un modale a tutto schermo che il genitore non ha
     * chiesto, che copre l'elenco delle assenze già comunicate e da cui deve
     * uscire con «Fine». Nel log di sistema del collaudo: 2.759 righe
     * `_UICalendarDateViewCell`. È comportamento della piattaforma, non un bug
     * del campo — quindi si cambia la DESTINAZIONE, non il campo.
     *
     * PERCHÉ NON SI PASSA A `DateField` (il `type="text"` mascherato che usa la
     * card della primaria, e che il problema non ce l'ha): su un telefono il
     * selettore nativo è il modo MIGLIORE di scegliere un giorno — si tocca, non
     * si digita — e `min={today}` dà un pavimento che un campo mascherato non
     * può imporre. Toglierlo per curare un fuoco mal indirizzato peggiorerebbe
     * il gesto principale della schermata per curare un effetto collaterale.
     *
     * Il requisito di accessibilità resta soddisfatto: il fuoco non finisce su
     * `<body>`, sta dentro il modulo, non entra nell'ordine di tabulazione
     * (`tabIndex={-1}`) e STA PRIMA del campo — così il primo Tab porta
     * esattamente dove si deve scrivere. Lock:
     * `__tests__/pages/parent-attendance-elenco.test.tsx`, «il fuoco NON va sul
     * campo data».
     */
    const refIntro = useRef<HTMLParagraphElement | null>(null);
    /**
     * Dove va il FUOCO quando il server RIFIUTA — l'invio o l'annullamento.
     *
     * Il ciclo 1 ha dato un ricovero ai soli esiti POSITIVI. Sul rifiuto il
     * fuoco cadeva su `<body>` (Chrome sfoca l'elemento che React marca
     * `disabled`), cioè proprio quando l'utente ha bisogno di sapere cos'è
     * successo: chi naviga a Tab riparte dall'inizio della pagina e chi ascolta
     * non arriva mai sul messaggio. Gli effetti qui sotto dipendono dal TESTO
     * dell'errore e funzionano anche al secondo rifiuto identico, perché i due
     * gestori azzerano l'errore PRIMA di richiamare il server: lo stato fa
     * comunque null → frase, e l'effetto riparte.
     */
    const refErrore = useRef<HTMLDivElement | null>(null);
    const refErroreAnnullamento = useRef<HTMLDivElement | null>(null);
    /**
     * Il valore PRECEDENTE di `isSubmitted`, non un flag «primo render».
     *
     * Il fuoco si sposta solo quando lo stato CAMBIA: rubarlo a chi apre la
     * pagina sarebbe un difetto a sua volta — chi usa uno screen reader si
     * ritroverebbe saltati titolo e intestazione. Un flag «è il primo render»
     * qui non basterebbe: in StrictMode React monta, smonta e rimonta, quindi
     * l'effetto gira DUE volte al caricamento e alla seconda il flag è già
     * spento — il fuoco finirebbe sul campo data appena si apre la pagina.
     * Confrontare il valore vecchio col nuovo è vero quante volte si vuole.
     */
    const inviatoPrima = useRef(isSubmitted);

    /**
     * ⚠️ NESSUN `setState` PRIMA DEL PRIMO `await`: questa funzione la chiama un
     * effetto, e `react-hooks/set-state-in-effect` (errore, non warning, in
     * questo repo) considera sincrono tutto ciò che precede l'await. Lo stato
     * «sto caricando» nasce già `true` e viene solo spento nel `finally` — la
     * stessa forma di `PagamentiSummary`. Chi vuole rimostrarlo (il bottone
     * «Riprova») passa da `ricaricaComunicate`, che è un gestore di evento e non
     * ha quel vincolo.
     */
    const caricaComunicate = useCallback(async () => {
        if (!ready || !parentId || !studentId) return;
        try {
            const esito = await leggiAssenzeComunicate(parentId, studentId);
            if (esito.ok) {
                setComunicate(esito.voci);
                setErroreElenco(null);
            } else {
                // Lista vuota + nessun messaggio sarebbe una BUGIA: «non hai
                // comunicato niente» invece di «non sono riuscito a leggerlo».
                setErroreElenco(soloCatalogoDaCorpo(esito.corpo, t('attendanceElencoErrore')));
            }
        } finally {
            setCaricandoElenco(false);
        }
    }, [ready, parentId, studentId, t]);

    useEffect(() => { void caricaComunicate(); }, [caricaComunicate]);

    // Il ricovero del fuoco. Sta in un effetto e non nel gestore perché il
    // paragrafo dell'esito nasce con il render CHE SEGUE `setEsitoAnnullamento`:
    // nel gestore il nodo non esiste ancora, e `refEsito.current` sarebbe `null`.
    useEffect(() => {
        if (esitoAnnullamento) refEsito.current?.focus();
    }, [esitoAnnullamento]);

    // Il ricovero del fuoco all'invio riuscito e al ritorno al modulo. Sta in un
    // effetto per la stessa ragione dell'altro: il nodo di destinazione nasce con
    // il render CHE SEGUE il cambio di stato, e nel gestore non esiste ancora.
    useEffect(() => {
        if (inviatoPrima.current === isSubmitted) return;
        inviatoPrima.current = isSubmitted;
        if (isSubmitted) refConferma.current?.focus();
        else refIntro.current?.focus();
    }, [isSubmitted]);

    // Il ricovero del fuoco sui due RIFIUTI. Stessa forma dei due qui sopra, e
    // stessa ragione per cui sta in un effetto: il contenitore `role="alert"`
    // nasce con il render CHE SEGUE `setError`/`setErroreAnnullamento`.
    useEffect(() => {
        if (error) refErrore.current?.focus();
    }, [error]);

    useEffect(() => {
        if (erroreAnnullamento) refErroreAnnullamento.current?.focus();
    }, [erroreAnnullamento]);

    /** Ricarico ESPLICITO (bottone «Riprova»): qui lo stato di attesa si rimostra. */
    const ricaricaComunicate = useCallback(async () => {
        setCaricandoElenco(true);
        await caricaComunicate();
    }, [caricaComunicate]);

    // Collega il submit al backend esistente: POST /api/parent/presenze/comunica-assenza
    // (decisione 2 — niente nuove API). L'endpoint crea l'assenza già giustificata.
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!parentId || !studentId || submitting) return;
        setSubmitting(true);
        setError(null);
        setCodiceErrore(null);
        // L'esito dell'annullamento precedente SCADE qui. Se l'invio viene
        // rifiutato il genitore resta sul modulo con l'elenco sotto: un «Assenza
        // annullata.» rimasto lì accanto all'errore appena comparso parla di
        // un'altra azione, e le due frasi insieme non si possono più attribuire.
        setEsitoAnnullamento(null);
        setErroreAnnullamento(null);
        try {
            const res = await fetch(`/api/parent/presenze/comunica-assenza?userId=${parentId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
                body: JSON.stringify({ studentId, data, motivo: reason }),
            });
            const j = await res.json().catch(() => ({}));
            if (res.ok) {
                setIsSubmitted(true);
                // L'elenco si rilegge SUBITO, non al prossimo ingresso: quando il
                // genitore torna al modulo deve trovarci dentro ciò che ha appena
                // comunicato — ed è anche l'unica prova che il salvataggio c'è stato.
                void caricaComunicate();
            } else {
                // La prosa del server NON si mostra: nasce dove il locale non
                // esiste ed è italiana per costruzione (T10-F1). O il codice
                // dichiarato, tradotto, o la frase di questo componente.
                setError(soloCatalogoDaCorpo(j, t('attendanceErrGenerico')));
                // Il codice si conserva a parte: la frase serve a chi legge, il
                // codice a decidere se il campo del giorno va marcato non valido.
                const c = (j as { codice?: unknown } | null)?.codice;
                setCodiceErrore(typeof c === 'string' ? c : null);
            }
        } catch {
            setError(t('attendanceErrRete'));
            // La rete caduta non dice niente sul giorno scelto: nessun codice.
            setCodiceErrore(null);
        } finally {
            setSubmitting(false);
        }
    };

    const handleAnnulla = async (voce: AssenzaComunicata) => {
        if (!parentId || !studentId || annullando) return;
        setAnnullando(voce.data);
        setErroreAnnullamento(null);
        setEsitoAnnullamento(null);
        try {
            const esito = await annullaAssenzaComunicata(parentId, studentId, voce.data);
            if (esito.ok) {
                setEsitoAnnullamento(t('attendanceAnnullata'));
                // Si RILEGGE invece di togliere la riga in locale: se il server ha
                // fatto qualcosa di diverso da quel che crediamo (o l'appello è
                // arrivato nel frattempo), l'elenco deve dire la verità del server.
                await caricaComunicate();
            } else {
                setErroreAnnullamento(soloCatalogoDaCorpo(esito.corpo, t('attendanceErrAnnulla')));
            }
        } finally {
            setAnnullando(null);
        }
    };

    // ── L'elenco, sotto il modulo ────────────────────────────────────────────
    const elenco = (
        <section
            className="mt-5 rounded-card bg-kidville-white p-6 shadow-sm"
            aria-labelledby="assenze-comunicate-titolo"
        >
            <h2
                id="assenze-comunicate-titolo"
                className="font-barlow text-lg font-black uppercase text-kidville-green"
            >
                {t('attendanceElencoTitolo')}
            </h2>
            <p className="mt-1 font-maven text-xs text-kidville-sub">{t('attendanceElencoNota')}</p>

            {caricandoElenco && (
                <p role="status" className="mt-4 font-maven text-sm text-kidville-sub">
                    {t('attendanceElencoCaricamento')}
                </p>
            )}

            {!caricandoElenco && erroreElenco && (
                <div className="mt-4">
                    <div
                        role="alert"
                        className="flex items-start gap-2 rounded-xl border border-kidville-error/20 bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong"
                    >
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> {erroreElenco}
                    </div>
                    <Btn variant="ghost" size="sm" className="mt-3" onClick={() => { void ricaricaComunicate(); }}>
                        <RotateCcw size={14} /> {t('attendanceRiprova')}
                    </Btn>
                </div>
            )}

            {!caricandoElenco && !erroreElenco && comunicate.length === 0 && (
                <p className="mt-4 font-maven text-sm text-kidville-sub">{t('attendanceElencoVuoto')}</p>
            )}

            {/*
                    La riga e il suo comando vivono in UN SOLO posto
                    (`RigaAssenzaComunicata`), condiviso con la card della
                    primaria: la stessa funzione era stata scritta due volte, con
                    due raggi, due varianti di bottone e due formati di data. Lì
                    dentro sta anche il conto in pixel del telefono a 320px.
            */}
            {!caricandoElenco && !erroreElenco && comunicate.length > 0 && (
                <ul className="mt-4 space-y-2">
                    {comunicate.map((v) => (
                        <RigaAssenzaComunicata
                            key={v.id}
                            giorno={f.dataBreve(`${v.data}T12:00:00`) || v.data}
                            motivo={v.giustificazione_testo}
                            etichettaAnnulla={t('attendanceAnnullaAria', {
                                data: f.dataBreve(`${v.data}T12:00:00`) || v.data,
                            })}
                            testoAnnulla={t('attendanceAnnulla')}
                            testoAnnullamento={t('attendanceAnnullamento')}
                            inCorso={annullando === v.data}
                            bloccato={annullando !== null}
                            onAnnulla={() => { void handleAnnulla(v); }}
                        />
                    ))}
                </ul>
            )}

            {erroreAnnullamento && (
                <div
                    ref={refErroreAnnullamento}
                    role="alert"
                    // `tabIndex={-1}`: raggiungibile dal codice, mai dal Tab.
                    // Il fuoco ci arriva solo da chi ha appena premuto un
                    // «Annulla» che il server ha rifiutato.
                    tabIndex={-1}
                    className="mt-3 flex items-start gap-2 rounded-xl border border-kidville-error/20 bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong outline-none focus:ring-2 focus:ring-kidville-green"
                >
                    <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> {erroreAnnullamento}
                </div>
            )}
            {esitoAnnullamento && !erroreAnnullamento && (
                <p
                    ref={refEsito}
                    role="status"
                    // `tabIndex={-1}` lo rende raggiungibile dal codice ma NON
                    // dal Tab: non entra nell'ordine di navigazione, ci finisce
                    // solo chi arriva dal bottone appena smontato.
                    tabIndex={-1}
                    // `outline-none` non toglie l'indicatore, lo SOSTITUISCE con
                    // quello della casa: l'anello verde Clay Village, sempre
                    // visibile quando il fuoco è qui (`focus:`, non
                    // `focus-visible:` — il fuoco arriva da codice, e le
                    // euristiche di `focus-visible` non lo mostrerebbero).
                    className="mt-3 rounded-xl px-1 font-maven text-xs text-kidville-success-strong outline-none focus:ring-2 focus:ring-kidville-green"
                >
                    {esitoAnnullamento}
                </p>
            )}
        </section>
    );

    // ── La conferma dell'invio ───────────────────────────────────────────────
    // NON è più un `return` anticipato che sostituisce l'intero albero: quel
    // ritorno portava via con sé anche il `PageHeaderCard`, cioè l'UNICO `<h1>`
    // della pagina (WCAG 1.3.1 — una schermata senza titolo di primo livello).
    // Qui la conferma prende il posto del solo modulo, dentro la stessa pagina.
    const conferma = (
        <div className="mt-5 rounded-card bg-kidville-white p-6 text-center shadow-sm">
            {/*
                `role="status"` — la conferma è un MESSAGGIO DI STATO (WCAG 4.1.3):
                senza, chi usa uno screen reader preme «Comunica assenza» e sente
                silenzio, senza modo di sapere se l'assenza è partita. `polite`
                perché non interrompe: l'annuncio arriva alla prima pausa.
            */}
            <div role="status" aria-live="polite">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-kidville-success-soft text-kidville-success">
                    <CheckCircle size={32} aria-hidden="true" />
                </div>
                <h2
                    ref={refConferma}
                    // Raggiungibile dal codice ma NON dal Tab: non entra nell'ordine
                    // di navigazione, ci finisce solo chi arriva dal bottone appena
                    // smontato. Stessa forma dell'esito dell'annullamento qui sopra.
                    tabIndex={-1}
                    className="mb-2 font-barlow text-2xl font-black uppercase text-kidville-green outline-none focus:ring-2 focus:ring-kidville-green"
                >
                    {t('attendanceInviataTitolo')}
                </h2>
                {/* L'UNICA riga che dice per quale giorno l'assenza è stata
                    comunicata: `sub` (6,46:1 su bianco) e non `muted` (2,51:1). */}
                <p className="mb-6 font-maven text-kidville-sub">
                    {t('attendanceInviataTesto', { data: f.dataBreve(data + 'T12:00:00') })}
                </p>
            </div>
            <Btn
                variant="ghost"
                size="sm"
                onClick={() => { setIsSubmitted(false); setReason(''); setData(today); }}
            >
                {t('attendanceComunicaAltra')}
            </Btn>
        </div>
    );

    const modulo = (
        <>
            <form onSubmit={handleSubmit} className="mt-5 rounded-card bg-kidville-white p-6 shadow-sm">
                {/* Icona DR */}
                <div className="mb-4 flex items-center gap-3">
                    <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-kidville-error-soft text-kidville-error">
                        <CalendarX2 size={22} />
                    </span>
                    {/* `sub` (6,46:1) e non `muted` (2,51:1): è la riga che spiega
                        a cosa serve il modulo, e stava nel grigio meno leggibile
                        della palette.
                        È anche il RICOVERO del fuoco al ritorno dalla conferma:
                        vedi `refIntro` per il perché non è il campo data. */}
                    <p
                        ref={refIntro}
                        tabIndex={-1}
                        className="font-maven text-sm text-kidville-sub outline-none focus:ring-2 focus:ring-kidville-green"
                    >
                        {t('attendanceIndicaGiorno')}
                    </p>
                </div>

                {/* `htmlFor`/`id`: senza, l'etichetta è solo testo VICINO al campo — uno
                    screen reader annuncia «campo data» e basta, e il tocco sull'etichetta
                    non porta il fuoco sul campo. */}
                <label htmlFor="attendance-giorno" className="mb-2 block font-maven font-medium text-kidville-green">
                    {t('attendanceGiorno')}
                </label>
                {/*
                    ⚠️ `bg-kidville-white text-kidville-ink` NON è ridondanza.
                    Questi due campi non dichiaravano NESSUN inchiostro: lo
                    ereditavano da `body { color: var(--color-kidville-green) }`. Con
                    l'Alto Contrasto acceso `[data-contrast="high"] body` ribalta
                    l'inchiostro EREDITATO a #FFFFFF, mentre la card sotto è
                    `bg-kidville-white` — una utility nata da `@theme inline`, che
                    porta l'hex #FFFFFF INLINATO e quindi NON si ribalta. Risultato
                    misurato: bianco su bianco, 1:1, sui due campi che dicono al
                    genitore quale giorno sta comunicando. Il rimedio non è un colore
                    a mano: è che il campo si porti il proprio inchiostro, come già
                    fa la card gemella della primaria (`text-kidville-ink`, 11,78:1
                    in entrambe le modalità). Il fondo è dichiarato per la stessa
                    ragione — un campo che eredita la superficie eredita anche i suoi
                    ribaltamenti. Lock: `__tests__/a11y/contrasto-campi-assenza.test.tsx`.
                */}
                <input
                    id="attendance-giorno"
                    type="date"
                    value={data}
                    min={today}
                    onChange={(e) => setData(e.target.value)}
                    // Il campo dichiara di essere lui il problema SOLO quando il
                    // rifiuto parla della data (`ASSENZA_DATA_*`), e rimanda al
                    // messaggio che dice perché. Su un rifiuto generico resta
                    // pulito: mandare a correggere un valore giusto è peggio che
                    // non dire niente.
                    aria-invalid={erroreSullaData || undefined}
                    aria-describedby={erroreSullaData ? ID_ERRORE_INVIO : undefined}
                    className="mb-4 w-full rounded-xl border border-kidville-line bg-kidville-white p-3 font-maven text-kidville-ink focus:border-kidville-green focus:outline-none focus:ring-1 focus:ring-kidville-green"
                />

                <label htmlFor="attendance-motivo" className="mb-2 block font-maven font-medium text-kidville-green">
                    {t('attendanceMotivo')}
                </label>
                {/* `placeholder-kidville-sub`: senza, il segnaposto lo dipinge
                    l'agente utente con `currentColor` al 50% di alfa — misurato in
                    Chrome `rgb(128,180,175)`, 2,32:1. Un segnaposto è TESTO, e
                    1.4.3 si applica. Il repo aveva già chiuso lo stesso difetto
                    sulle superfici pubbliche (`.kv-public ::placeholder`); questa
                    è una schermata di dashboard, e quella regola non la raggiunge. */}
                <textarea
                    id="attendance-motivo"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="h-28 w-full resize-none rounded-xl border border-kidville-line bg-kidville-white p-3 font-maven text-kidville-ink placeholder-kidville-sub focus:border-kidville-green focus:outline-none focus:ring-1 focus:ring-kidville-green"
                    placeholder={t('attendanceMotivoPlaceholder')}
                />

                {error && (
                    <div
                        id={ID_ERRORE_INVIO}
                        ref={refErrore}
                        role="alert"
                        // Raggiungibile dal codice ma NON dal Tab: stessa forma
                        // della conferma e dell'esito dell'annullamento.
                        tabIndex={-1}
                        className="mt-3 flex items-start gap-2 rounded-xl border border-kidville-error/20 bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong outline-none focus:ring-2 focus:ring-kidville-green"
                    >
                        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> {error}
                    </div>
                )}

                <Btn
                    type="submit"
                    variant="primary"
                    size="lg"
                    disabled={!ready || submitting}
                    className="mt-4 w-full"
                >
                    {submitting ? t('attendanceInvio') : t('attendanceComunicaAssenza')}
                </Btn>
            </form>

            {/* Senza un figlio risolto non esiste un elenco di cui parlare: si
                mostra finché l'identità si sta risolvendo (`!ready`), poi solo se
                un alunno c'è davvero. */}
            {(!ready || studentId) && elenco}
        </>
    );

    return (
        <div className="px-4 pt-5 pb-24">
            {/* Il `PageHeaderCard` — cioè l'`<h1>` — resta montato in ENTRAMBI gli
                stati: prima la conferma lo portava via con sé, e la schermata di
                successo restava una pagina con un `<h2>` e nessun titolo di primo
                livello (WCAG 1.3.1). */}
            <PageHeaderCard
                eyebrow={t('attendanceEyebrow')}
                title={t('attendanceTitolo')}
                subtitle={t('attendanceSottotitolo')}
            />
            {isSubmitted ? conferma : modulo}
        </div>
    );
}

function AttendanceFallback() {
    const t = useTranslations('parentServizi');
    // `sub`, non `muted`: anche la schermata d'attesa è testo che qualcuno legge.
    return <div className="px-4 pt-5 pb-24 font-maven text-kidville-sub">{t('caricamento')}</div>;
}

export default function ParentAttendancePage() {
    return (
        <Suspense fallback={<AttendanceFallback />}>
            <AttendanceInner />
        </Suspense>
    );
}
