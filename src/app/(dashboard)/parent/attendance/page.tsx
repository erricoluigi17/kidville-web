'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, CalendarX2, RotateCcw } from 'lucide-react';
import { RigaAssenzaComunicata } from '@/components/features/parent/RigaAssenzaComunicata';
import { FasciaStatoAssenza } from '@/components/features/parent/FasciaStatoAssenza';
import { PiedeAzioneAssenza } from '@/components/features/parent/PiedeAzioneAssenza';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { LinkInterno } from '@/components/ui/LinkInterno';
import { Btn } from '@/components/ui/Btn';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { CODICI_ERRORE, erroreDaRisposta, soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { FUOCO_ESITO } from '@/lib/ui/fuoco';
import {
    BLOCCO_CAMPO_ASSENZA,
    CAMPO_ASSENZA,
    ETICHETTA_CAMPO_ASSENZA,
    SPAZIO_FRA_BLOCCHI_ASSENZA,
} from '@/lib/ui/campo-assenza';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { MOTIVO_MAX_CARATTERI } from '@/lib/presenze/limiti-testo';
import {
    GIORNI_MASSIMI_IN_ANTICIPO,
    rifiutoDelGiorno,
    ultimoGiornoComunicabile,
} from '@/lib/presenze/finestra-comunicazione';
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
 * L'id dell'ISTRUZIONE sul campo del giorno e quello della NOTA sul trattamento
 * del motivo. Costanti per la stessa ragione di `ID_ERRORE_INVIO`: ci puntano
 * due `aria-describedby`, e un id inventato in due punti diversi è il modo in
 * cui `aria-describedby` smette di descrivere qualcosa.
 */
const ID_AIUTO_GIORNO = 'attendance-aiuto-giorno';
const ID_NOTA_MOTIVO = 'attendance-nota-motivo';

/**
 * L'id della riga che dice PERCHÉ il comando non risponde (o che è partito).
 * Ci punta l'`aria-describedby` del pulsante: stessa ragione delle costanti qui
 * sopra — un id inventato in due punti diversi non descrive più niente.
 */
const ID_STATO_COMANDO = 'attendance-stato-comando';


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
        if (!res.ok) {
            // Il rifiuto lascia una riga CON lo status (R17): senza, «l'elenco non si
            // legge» e «la rete è caduta» arrivavano in `app_log` indistinguibili, e il
            // solo numero che dice quale dei due è successo veniva buttato via qui.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: 'parent/attendance: elenco assenze comunicate respinto dal server',
                route: ROTTA,
                stato: res.status,
            });
            return { ok: false, corpo };
        }
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
        if (res.ok) return { ok: true };
        // Stessa regola dell'elenco e dell'invio: un annullamento RESPINTO (409 se
        // l'appello è già stato fatto, 500 se la scrittura non riesce) lascia una riga
        // con lo status. Prima usciva muto, e a schermo restava solo la frase generica.
        logClient({
            livello: 'warn',
            evento: 'fetch',
            messaggio: 'parent/attendance: annullamento assenza respinto dal server',
            route: ROTTA,
            stato: res.status,
        });
        return { ok: false, corpo };
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
    /**
     * Le frasi che questa schermata CONDIVIDE con la card della primaria — la
     * nota sul trattamento del motivo, l'avviso «questo giorno lo hai già
     * comunicato», la conferma che distingue l'aggiornamento dalla creazione.
     * Vivono in un namespace loro perché sono le stesse identiche parole: la
     * stessa frase scritta due volte in due cataloghi è il difetto da cui nasce
     * metà di questo lavoro.
     */
    const ta = useTranslations('parentAssenze');
    /** Le frasi d'errore condivise con il server: stesse chiavi, stessi codici. */
    const tShared = useTranslations('shared');
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
    /**
     * L'invio appena riuscito ha AGGIORNATO una comunicazione che c'era già.
     *
     * Il server scrive la stessa riga in entrambi i casi — `presenze` ha UNIQUE
     * (alunno_id, data) — e risponde 201 sempre, quindi la distinzione la fa il
     * client, che l'elenco ce l'ha già in mano. Non è cosmesi: «Assenza
     * comunicata» detto dopo aver sovrascritto la comunicazione di ieri è la
     * frase che ha permesso al motivo di sparire senza che nessuno se ne
     * accorgesse.
     */
    const [aggiornata, setAggiornata] = useState(false);
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
     * La comunicazione GIÀ ARCHIVIATA per il giorno che il modulo mostra.
     *
     * ─── IL MOTIVO CANCELLATO IN SILENZIO (collaudo 2026-08-07) ──────────────
     * Due invii consecutivi sulla stessa data: il primo con «collaudo tecnico»,
     * il secondo — modulo riaperto, campo motivo vuoto — con il motivo a zero.
     * HTTP 201, «Assenza comunicata», e il motivo sparito dall'elenco. Il campo
     * è FACOLTATIVO, quindi il client lo mandava comunque (`motivo: ''`) e la
     * route lo normalizzava a NULL nell'UPDATE della riga esistente: un dato
     * sanitario di un minore cancellato dal fatto di non essere stato riscritto.
     *
     * LA REGOLA, e il perché: **il campo «Motivo» non è un foglio bianco, è lo
     * specchio di ciò che risulta archiviato per il giorno scelto.** Lasciarlo
     * com'è significa RICONFERMARE, non cancellare.
     *
     * ⚠️ E CANCELLARE NON SI FA PIÙ DA QUI (2026-08-08). Questo commento diceva
     * «cancellare resta possibile, ma si fa svuotando il campo — che è un gesto,
     * non una dimenticanza», e da `route.ts:518-522` in poi era FALSO: il server
     * ha scelto, deliberatamente, di non azzerare mai `giustificazione_testo` su
     * un campo vuoto, perché una copia vecchia dell'app dallo store cancellava un
     * dato sanitario di un minore senza che nessuno l'avesse chiesto. Il prezzo è
     * dichiarato lì. Qui il difetto era che l'interfaccia MENTIVA: mandava `''`,
     * il server lo ignorava, e lo schermo diceva comunque «Assenza aggiornata».
     * Ora lo dice PRIMA (`motivoNonCancellabile`) e indica la via che funziona —
     * annulla e ricomunica. Un commento che descrive una capacità che non c'è è
     * la trappola che questo repo ha già pagato tre volte.
     */
    const giaComunicata = comunicate.find((v) => v.data === data) ?? null;
    /**
     * Il genitore ha SVUOTATO un motivo che risulta archiviato per il giorno
     * scelto. Non è un errore — è solo un gesto che questa schermata non può
     * eseguire, e che senza un avviso verrebbe scambiato per una cancellazione
     * riuscita.
     */
    const motivoSvuotato = Boolean(giaComunicata?.giustificazione_testo) && reason.trim() === '';
    /**
     * L'identità è risolta e NON c'è nessun alunno. `ready` diventa `true` anche
     * in questo caso (`decidiFiglioRivalidato` con `figliIds = []` restituisce
     * `studentId: null`), e finora il pulsante guardava solo `ready` mentre il
     * gestore usciva su `!studentId`: nel mezzo restava uno stato in cui il
     * comando SEMBRA pronto e non fa assolutamente niente.
     */
    const senzaAlunno = ready && !studentId;
    /**
     * Perché il comando non risponde — oppure che è appena partito. Una riga
     * sola, in `role="status"`, che serve a due cose insieme: la DESCRIZIONE del
     * pulsante (`aria-describedby`) e l'ANNUNCIO dell'attesa (WCAG 4.1.3). Prima
     * l'unico segnale che il gesto fosse partito era l'etichetta «Invio…» su un
     * pulsante sbiadito a 1,20:1, e per chi ascolta non c'era nulla del tutto.
     */
    const statoComando = submitting
        ? ta('invioInCorso')
        : senzaAlunno
            ? ta('nessunAlunno')
            : !ready
                ? ta('identitaInCorso')
                : !data
                    ? ta('giornoMancante')
                    : '';
    /**
     * Il giorno mostrato dal modulo, leggibile da `caricaComunicate` SENZA
     * entrare fra le sue dipendenze. Se ci entrasse, l'effetto che legge
     * l'elenco ripartirebbe a ogni cambio di data: una GET per ogni tocco sul
     * calendario. Lo aggiornano gli stessi gestori che scrivono `data`.
     */
    const dataScelta = useRef(today);
    /**
     * La prima lettura riuscita dell'elenco è anche l'unico momento in cui il
     * modulo può scoprire che il giorno GIÀ PROPOSTO (oggi) ha un motivo
     * archiviato. Dopo, il riallineamento lo fanno i gestori.
     */
    const primaLettura = useRef(true);

    /**
     * Sposta il modulo su un altro giorno, riallineando il motivo a quel giorno.
     *
     * Il riallineamento NON è incondizionato: se né il giorno che si lascia né
     * quello che si sceglie hanno una comunicazione in archivio, ciò che il
     * genitore ha digitato resta dov'è. Cancellargli il testo appena scritto per
     * il solo fatto di aver corretto la data sarebbe un difetto nuovo.
     */
    const cambiaGiorno = useCallback((giorno: string) => {
        const partenza = comunicate.find((v) => v.data === dataScelta.current);
        const arrivo = comunicate.find((v) => v.data === giorno);
        dataScelta.current = giorno;
        setData(giorno);
        if (arrivo || partenza) setReason(arrivo?.giustificazione_testo ?? '');
        /**
         * ⚠️ CORREGGERE IL VALORE INVALIDA LA DIAGNOSI PRECEDENTE (2026-08-08).
         *
         * `error` e `codiceErrore` venivano azzerati soltanto dentro
         * `handleSubmit`. Misurato: dopo un rifiuto su `2026-08-01` il campo
         * restava `aria-invalid="true"` e continuava a rimandare al messaggio
         * anche una volta portato a `2026-08-20`, cioè a un valore giusto. Chi
         * usa uno screen reader torna sul campo e sente «non valido» con la
         * descrizione di un errore che ha già risolto (WCAG 4.1.2 e 3.3.1).
         * Un errore che sopravvive alla propria causa è un errore che mente.
         */
        setError(null);
        setCodiceErrore(null);
    }, [comunicate]);
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
                // Il giorno proposto all'apertura può essere GIÀ comunicato, con
                // un motivo scritto: qui è il primo istante in cui si può
                // saperlo, e il campo deve partire da quel testo invece che da
                // vuoto (vedi `giaComunicata`).
                if (primaLettura.current) {
                    primaLettura.current = false;
                    const gia = esito.voci.find((v) => v.data === dataScelta.current);
                    if (gia?.giustificazione_testo) setReason(gia.giustificazione_testo);
                }
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
        // `!data`: il giorno è obbligatorio, e il pulsante è già disabilitato
        // senza. La rete qui sotto serve al percorso che il bottone non copre
        // (Invio da tastiera dentro il modulo) — sul selettore nativo di Android
        // esiste un CLEAR, e il rifiuto che tornava dal server parlava «di questo
        // momento» invece che del campo mancante.
        if (!parentId || !studentId || submitting || !data) return;
        // ═══ IL PAVIMENTO SUL GIORNO NON PUÒ ESSERE SOLO `min` ═══════════════
        //
        // T34 del terzo collaudo, misurato sulle due piattaforme e non dedotto:
        // su Android il selettore nativo RISPETTA `min` (31 giorni, 7 disabilitati,
        // i passati non si toccano), su **iOS no** — il calendario di WebKit lascia
        // scegliere ieri, e l'unico rifiuto arrivava dal server, dopo il viaggio.
        // Il commento che dichiarava il pavimento sopra al campo era vero su una
        // piattaforma sola.
        //
        // Il controllo sta QUI e non in `<input required>` perché il modulo è
        // `noValidate`: la validazione nativa parla la lingua del BROWSER, non
        // quella dell'app — un genitore con il telefono in inglese leggeva una
        // frase inglese dentro un'app italiana (T6).
        //
        // `oggiFiscaleISO()` e non `new Date()`: «oggi» è quello di Europe/Rome,
        // com'è per il server che riceverà questa richiesta. Fra mezzanotte e le
        // due, in UTC, sarebbe ancora ieri.
        //
        // ⚠️ E IL CONFRONTO NON È PIÙ SCRITTO QUI (2026-08-08). Era
        // `if (data < today)`: solo il PAVIMENTO, mentre il server impone anche
        // un tetto (`GIORNI_MASSIMI_IN_ANTICIPO`) che nessuna delle due
        // schermate conosceva — un giorno a +97 partiva e tornava 400. E la card
        // gemella della primaria di guardia non ne aveva nessuna. La regola vale
        // per due schermate e una route: vive in `finestra-comunicazione`, e
        // dice anche QUALE dei due confini è stato rotto, perché i due rifiuti
        // mandano il genitore in due posti diversi.
        const rifiuto = rifiutoDelGiorno(data, today);
        if (rifiuto) {
            setError(tShared(CODICI_ERRORE[rifiuto]));
            setCodiceErrore(rifiuto);
            return;
        }
        // Il fatto che questo invio SOVRASCRIVA si decide adesso, con l'elenco
        // ancora quello di prima: dopo la rilettura la riga c'è comunque.
        setAggiornata(giaComunicata !== null);
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
                //
                // La lettura passa da `erroreDaRisposta` (R17): legge il corpo senza
                // lanciare — un 500 vuoto o l'HTML di un proxy non devono travestirsi da
                // rete caduta — e soprattutto TIENE lo status, che è l'unica cosa che
                // resta quando il corpo non c'è.
                const esito = await erroreDaRisposta(res, t('attendanceErrGenerico'));
                setError(esito.testo);
                // Il codice si conserva a parte: la frase serve a chi legge, il
                // codice a decidere se il campo del giorno va marcato non valido.
                setCodiceErrore(esito.codice);
                // IL RIFIUTO LASCIA UNA RIGA. Prima di oggi questo ramo non ne scriveva
                // nessuna: il `catch` qui sotto copriva la rete caduta, e un invio
                // RESPINTO dal server (400, 403, 409, 500) spariva senza traccia — cioè
                // il caso più frequente della funzione era anche il meno osservabile.
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `parent/attendance: comunicazione assenza respinta${esito.corpoLetto ? '' : ' (senza corpo)'}`,
                    route: ROTTA,
                    stato: esito.stato,
                });
            }
        } catch (e) {
            // T12 del terzo collaudo: questo `catch` non logga nulla. È il gesto
            // centrale della funzione — l'invio — e se la POST fallisce per rete,
            // CORS, service worker o certificato, il genitore legge «problema di
            // rete» e NESSUNO ne sa niente: non una riga, da nessuna parte.
            // È esattamente la forma del guasto che questo progetto ha già pagato
            // con le email (un `403` registrato senza il corpo che diceva perché).
            // `nomeErrore` e non il messaggio: il canale finisce in `app_log` per
            // 30 giorni, e il motivo dell'assenza non deve poterci entrare mai.
            logClient({
                livello: 'warn',
                evento: 'fetch',
                messaggio: `parent/attendance: comunicazione assenza non inviata — ${nomeErrore(e)}`,
                route: ROTTA,
            });
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
                    <FasciaStatoAssenza tipo="errore" ruolo="alert">{erroreElenco}</FasciaStatoAssenza>
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

            {/* L'ATTESA dell'annullamento, annunciata. Vale qui la stessa
                ragione dell'invio: `disabled` sfoga il fuoco su `<body>` e per
                chi ascolta l'intervallo era silenzio puro. */}
            {annullando && (
                <p role="status" className="mt-3 font-maven text-xs text-kidville-sub">
                    {ta('annullamentoInCorso')}
                </p>
            )}

            {erroreAnnullamento && (
                <FasciaStatoAssenza
                    tipo="errore"
                    ruolo="alert"
                    ricovero={refErroreAnnullamento}
                    // `tabIndex={-1}`: raggiungibile dal codice, mai dal Tab.
                    // Il fuoco ci arriva solo da chi ha appena premuto un
                    // «Annulla» che il server ha rifiutato.
                    tabIndex={-1}
                    className="mt-3"
                >
                    {erroreAnnullamento}
                </FasciaStatoAssenza>
            )}
            {esitoAnnullamento && !erroreAnnullamento && (
                <p
                    ref={refEsito}
                    role="status"
                    // `tabIndex={-1}` lo rende raggiungibile dal codice ma NON
                    // dal Tab: non entra nell'ordine di navigazione, ci finisce
                    // solo chi arriva dal bottone appena smontato. Forma e anello
                    // vengono da `FUOCO_ESITO`, uguali per tutti i ricoveri.
                    tabIndex={-1}
                    className={`mt-3 rounded-xl px-1 font-maven text-xs text-kidville-success-strong ${FUOCO_ESITO}`}
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
                    className={`mb-2 rounded-xl px-1 font-barlow text-2xl font-black uppercase text-kidville-green ${FUOCO_ESITO}`}
                >
                    {/* «Comunicata» e «aggiornata» sono due fatti diversi: il
                        secondo ha appena SOVRASCRITTO ciò che c'era, motivo
                        compreso, e va detto. */}
                    {aggiornata ? ta('aggiornataTitolo') : t('attendanceInviataTitolo')}
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
                // Il ritorno al modulo passa da `cambiaGiorno`, non da `setData`
                // nudo: rimettere «oggi» è un cambio di giorno come gli altri, e
                // se oggi ha già un motivo archiviato il campo deve mostrarlo.
                onClick={() => { setIsSubmitted(false); setAggiornata(false); setReason(''); cambiaGiorno(today); }}
            >
                {t('attendanceComunicaAltra')}
            </Btn>
        </div>
    );

    const modulo = (
        <>
            {/* `aria-busy`: il modulo dichiara di stare lavorando. Senza, dalla
                pressione fino alla risposta del server non c'era NIENTE — né un
                ruolo, né una proprietà, né una live region attiva (l'unica in
                pagina, il `PageLoader`, porta `aria-hidden`). */}
            <form
                onSubmit={handleSubmit}
                /*
                  T6 del terzo collaudo: senza `noValidate` il messaggio che
                  impedisce di comunicare per un giorno passato lo scrive il
                  BROWSER, nella lingua del BROWSER — «Value must be 2026-08-08 or
                  later» dentro un'app italiana, e in una bolla che nessuno stile
                  del prodotto può toccare. La regola resta, ma la dice l'app: la
                  guardia è in `handleSubmit`, con la frase del catalogo.
                */
                noValidate
                aria-busy={submitting || undefined}
                className="mt-5 rounded-card bg-kidville-white p-6 shadow-sm"
            >
                {/* Icona DR */}
                <div className="mb-4 flex items-center gap-3">
                    {/* ⚠️ `shrink-0` (2026-08-08). `h-11 w-11` fissa la base
                        flessibile ma NON toglie `flex-shrink: 1`: il paragrafo
                        fratello ha base `auto` (il max-content del suo testo,
                        molto più largo della riga) e la contrazione che avanza
                        ricade sul chip. Misurato in Chrome: 22,0×44 a 320, 360 e
                        390px — metà larghezza — con il glifo del calendario, che
                        di suo misura 22px, a sbordare dai due lati del
                        riempimento; e il raggio di 14px su una base di 22 fa una
                        capsula verticale, non un quadrato. Il ciclo l'aveva anche
                        PEGGIORATO allungando il paragrafo accanto (la frase sui
                        60 giorni): a 390px si passava da 36,5 a 22,0px.
                        Il gemello nato in questo stesso ciclo lo fa giusto
                        (`RigaAssenzaComunicata`, `flex h-9 w-9 flex-shrink-0`):
                        la regola non era tornata indietro sulla schermata da cui
                        era stata estratta. */}
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-kidville-error-soft text-kidville-error">
                        <CalendarX2 size={22} />
                    </span>
                    {/* `sub` (6,46:1) e non `muted` (2,51:1): è la riga che spiega
                        a cosa serve il modulo, e stava nel grigio meno leggibile
                        della palette.
                        È anche il RICOVERO del fuoco al ritorno dalla conferma:
                        vedi `refIntro` per il perché non è il campo data. */}
                    <p
                        ref={refIntro}
                        // L'ISTRUZIONE del campo del giorno, non solo una frase
                        // di contorno: il campo la referenzia con
                        // `aria-describedby` (WCAG 3.3.2), come già fa la card
                        // gemella della primaria. Non dichiara il FORMATO — su
                        // un `<input type="date">` lo disegna il sistema, e
                        // scriverlo qui sarebbe falso appena il browser è in
                        // inglese; dichiara ciò che è vero e che `min` impone.
                        id={ID_AIUTO_GIORNO}
                        tabIndex={-1}
                        className={`rounded-xl px-1 font-maven text-sm text-kidville-sub ${FUOCO_ESITO}`}
                    >
                        {/* L'INTERVALLO AMMESSO, TUTTO INTERO (2026-08-08). Il
                            campo dichiarava il pavimento (`min`) e non il
                            soffitto, e l'aiuto diceva «puoi indicare oggi o un
                            giorno futuro» — frase falsa oltre il sessantesimo
                            giorno, che è il tetto che il server impone. Il
                            numero è INTERPOLATO dalla costante condivisa, non
                            ricopiato: un 60 scritto a mano in catalogo diventa
                            una bugia il giorno in cui il tetto cambia. La frase
                            vive in `parentAssenze` perché è la stessa, parola per
                            parola, sulle due schermate. */}
                        {t('attendanceIndicaGiorno')}{' '}
                        {ta('finestraGiorni', { giorni: GIORNI_MASSIMI_IN_ANTICIPO })}
                    </p>
                </div>

                {/* IL BLOCCO DEL CAMPO — etichetta, controllo e ciò che li
                    riguarda, in un contenitore che dichiara la propria
                    spaziatura una volta sola e per tutte e due le schermate.
                    ⚠️ Prima lo spazio stava sulle singole classi (`mb-2` qui,
                    `gap-1` sulla card gemella) «perché è layout della
                    schermata»: risultato misurato, quattro distanze su quattro
                    divergenti di 4px sopra controlli identici al pixel. */}
                <div className={BLOCCO_CAMPO_ASSENZA}>
                {/* `htmlFor`/`id`: senza, l'etichetta è solo testo VICINO al campo — uno
                    screen reader annuncia «campo data» e basta, e il tocco sull'etichetta
                    non porta il fuoco sul campo. */}
                {/* La tipografia dell'etichetta viene da `campo-assenza`, non da
                    qui: era divergente fra le due schermate (16px/500/verde
                    contro 12px/600/ink) sopra due campi identici. E dal
                    2026-08-08 da lì viene anche lo SPAZIO. */}
                <label htmlFor="attendance-giorno" className={ETICHETTA_CAMPO_ASSENZA}>
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
                    Dal 2026-08-08 quelle classi stanno in `campo-assenza`, condivise
                    con la card gemella: la decisione era già stata presa due volte.
                */}
                <input
                    id="attendance-giorno"
                    type="date"
                    value={data}
                    min={today}
                    // IL SOFFITTO, che non c'era. Il calendario nativo offriva
                    // qualunque giorno futuro mentre il server ne accetta 60:
                    // il vincolo non era conoscibile prima di premere.
                    // ⚠️ `max` da solo non basta — su iOS il selettore nativo non
                    // rispetta nemmeno `min` (misurato) — e infatti la guardia
                    // vera è in `handleSubmit`, con la stessa regola condivisa.
                    max={ultimoGiornoComunicabile(today)}
                    onChange={(e) => cambiaGiorno(e.target.value)}
                    // Il campo dichiara di essere lui il problema SOLO quando il
                    // rifiuto parla della data (`ASSENZA_DATA_*`), e rimanda al
                    // messaggio che dice perché. Su un rifiuto generico resta
                    // pulito: mandare a correggere un valore giusto è peggio che
                    // non dire niente.
                    aria-invalid={erroreSullaData || undefined}
                    // L'istruzione c'è SEMPRE; il messaggio d'errore si aggiunge
                    // quando il rifiuto parla del giorno.
                    aria-describedby={erroreSullaData ? `${ID_AIUTO_GIORNO} ${ID_ERRORE_INVIO}` : ID_AIUTO_GIORNO}
                    className={CAMPO_ASSENZA}
                />

                {/*
                    IL GIORNO SCELTO È GIÀ STATO COMUNICATO.
                    Senza questa riga il modulo si comporta come se stesse
                    creando qualcosa, mentre sta per SOVRASCRIVERE — e con lui il
                    motivo già archiviato. `role="status"`: chi ascolta lo sente
                    al cambio di giorno, senza che gli venga interrotta la
                    compilazione.
                */}
                {giaComunicata && (
                    <FasciaStatoAssenza tipo="avviso" ruolo="status">
                        {ta('giaComunicataAvviso')}
                    </FasciaStatoAssenza>
                )}
                </div>

                <div className={`${SPAZIO_FRA_BLOCCHI_ASSENZA} ${BLOCCO_CAMPO_ASSENZA}`}>
                <label htmlFor="attendance-motivo" className={ETICHETTA_CAMPO_ASSENZA}>
                    {t('attendanceMotivo')}
                </label>
                {/*
                    L'INFORMAZIONE NEL MOMENTO IN CUI IL DATO SI SCRIVE — e sta
                    PRIMA del campo, non dopo.
                    Il segnaposto del campo sollecita esplicitamente un dato di
                    salute («Es. febbre, visita medica…») di un MINORE: è una
                    categoria particolare (art. 9 GDPR), e finora la schermata
                    non diceva né chi lo legge, né per quanto resta, né dove sta
                    l'informativa. Delegarlo all'informativa generale non basta:
                    il genitore non la sta leggendo nell'istante in cui scrive
                    «febbre». Legata al campo con `aria-describedby`, così chi
                    ascolta la sente PRIMA di digitare e non dopo.

                    ⚠️ PERCHÉ SI È SPOSTATA SOPRA IL CAMPO (2026-08-08). Stava
                    sotto, cioè esattamente nella fascia che il comando incollato
                    in fondo copre: misurato in Chrome a 390×844, il pulsante
                    (y 718→772, riempimento verde OPACO) copriva questa riga
                    (y 725→757) per 32px su 32 — il 100%. A 320px la frase si
                    leggeva «Il motivo lo leggono le insegnanti della se…». Una
                    nota di trasparenza che si vede solo scorrendo è una nota che
                    metà dei genitori non legge; sopra il campo la incontrano
                    prima di digitare, che è anche il momento giusto.
                    I dodici mesi non sono un numero scelto qui: sono quelli che
                    il lavoro `presenze-giustificazioni-retention` applica
                    davvero, e un lock li confronta con `v_mesi` della migrazione.
                */}
                <p id={ID_NOTA_MOTIVO} className="font-maven text-xs text-kidville-sub">
                    {ta('motivoPrivacy')}{' '}
                    {/* `LinkInterno`: nella WebView di Capacitor un `_blank`
                        consegna l'indirizzo a Safari e l'utente esce dall'app
                        (R25). Stessa scelta della schermata gemella. */}
                    <LinkInterno
                        href="/privacy"
                        className="font-semibold underline"
                    >
                        {ta('motivoPrivacyLink')}
                    </LinkInterno>
                </p>
                {/* `placeholder-kidville-sub`: senza, il segnaposto lo dipinge
                    l'agente utente con `currentColor` al 50% di alfa — misurato in
                    Chrome `rgb(128,180,175)`, 2,32:1. Un segnaposto è TESTO, e
                    1.4.3 si applica. Il repo aveva già chiuso lo stesso difetto
                    sulle superfici pubbliche (`.kv-public ::placeholder`); questa
                    è una schermata di dashboard, e quella regola non la raggiunge.
                    Dal 2026-08-08 le classi vengono da `campo-assenza`, e il
                    segnaposto dal catalogo CONDIVISO: la card gemella diceva
                    «Es. visita medica» e questa «Es. febbre, visita medica,
                    motivi familiari…» — due suggerimenti diversi su come si
                    scrive lo stesso dato sanitario. */}

                {/*
                    IL GESTO CHE QUESTA SCHERMATA NON PUÒ ESEGUIRE, DETTO PRIMA —
                    e ORA anche in un punto in cui si vede.
                    Svuotare il campo non cancella il motivo archiviato: il
                    server, dal 2026-08-08, non azzera mai `giustificazione_testo`
                    su un campo vuoto (una copia vecchia dell'app cancellava un
                    dato sanitario di un minore senza che nessuno l'avesse
                    chiesto). Finora l'app mandava `''`, il server lo ignorava e
                    lo schermo diceva comunque «Assenza aggiornata»: un successo
                    dichiarato senza verifica. La via che funziona — annullare e
                    ricomunicare — è scritta nel messaggio.

                    ⚠️ PERCHÉ ORA STA SOPRA LA TEXTAREA (2026-08-08, seconda
                    misura). Era stato aggiunto SOTTO il campo, cioè nella stessa
                    fascia da cui la nota sul trattamento era appena stata tolta:
                    a 390×844 nasceva a y 781→863 con la bottom-nav a 770→844 —
                    dei suoi 82px, 63 dietro la barra e 19 sotto la piega, parte
                    visibile e non ostruita **0px**. La correzione precedente era
                    stata applicata alla RIGA segnalata invece che alla ZONA: tutto
                    ciò che nasce fra il campo motivo e il piede finisce coperto.
                    E questo avviso compare in reazione a un gesto che si fa
                    GUARDANDO il campo: nessuno ha motivo di scorrere per cercarlo.
                */}
                {motivoSvuotato && (
                    <FasciaStatoAssenza tipo="avviso" ruolo="status">
                        {ta('motivoNonCancellabile')}
                    </FasciaStatoAssenza>
                )}

                <textarea
                    id="attendance-motivo"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    // Il tetto è quello del SERVER, letto dalla stessa costante
                    // che lo impone (`MOTIVO_MAX_CARATTERI`), non un numero
                    // ricopiato: senza, si scriveva una nota medica di 1200
                    // caratteri e lo si scopriva solo dal 400 dopo l'invio.
                    maxLength={MOTIVO_MAX_CARATTERI}
                    aria-describedby={ID_NOTA_MOTIVO}
                    className={`h-28 resize-none ${CAMPO_ASSENZA}`}
                    placeholder={ta('motivoPlaceholder')}
                />
                </div>

                {/*
                    IL PULSANTE NON DEVE FINIRE DIETRO LA BARRA DI NAVIGAZIONE.

                    Misurato sull'emulatore Android il 2026-08-07: al primo
                    ingresso, senza scorrere, il pulsante era coperto per 137px
                    su 145 dalla bottom-nav (`fixed`, `z-50`) e se ne vedeva un
                    bordo di 8px. Un tocco al suo centro — dove il pulsante SI
                    INTUISCE — apriva /parent/avvisi: il gesto principale della
                    schermata portava altrove, senza un messaggio.
                    Il `pb-24` della pagina non c'entra e non poteva bastare:
                    riserva spazio in FONDO al documento, mentre qui il pulsante
                    sta a metà e la pagina è più alta della viewport.
                    `sticky` + `--kv-bottomnav-h` (l'altezza DICHIARATA della
                    barra, safe-area compresa) lo tengono appoggiato sopra di
                    essa finché il modulo è a schermo, e lo rimettono nel flusso
                    appena la sua posizione naturale sale sopra quella linea.
                    `z-40` e non di più: sotto la barra, mai sopra — coprire la
                    navigazione sarebbe lo stesso difetto al contrario.
                    Misura del 2026-08-08 sull'emulatore: 49/49 tocchi a segno,
                    6px di sovrapposizione su 145. Il difetto è chiuso.

                    ⚠️ LA SUPERFICIE (2026-08-08). La correzione qui sopra ne
                    aveva aperto un altro: un pulsante incollato in fondo si porta
                    SOPRA la propria posizione naturale, e con il solo riempimento
                    del bottone copriva il testo sottostante a metà parola. Ora è
                    il PIEDE DELLA CARD — fondo bianco a piena larghezza
                    (`-mx-6`, che annulla il `p-6` del modulo), filo di
                    separazione e ombra verso l'alto, come `BulkSelectionBar` e
                    `BulkAssignBar` fanno da sempre per le loro barre galleggianti.
                    Ciò che passa sotto è coperto in modo DICHIARATO; e la nota
                    sul trattamento del motivo — che era la riga coperta al 100%
                    a 390×844 — non è più là sotto: sta sopra il campo.

                    ⚠️ E I MESSAGGI DELL'AZIONE ORA STANNO DENTRO (2026-08-08,
                    terza misura). Il piede aveva cominciato a coprire proprio ciò
                    che il piede stesso genera: il riquadro di RIFIUTO nasceva a
                    y 711→745 con il piede a 693→772 — 34px su 34, il **100%** su
                    iPhone 14/15/15 Pro, e la riga di stato del comando pure. Il
                    genitore vedente premeva, lo schermo non cambiava di un pixel,
                    e l'unica conclusione ragionevole era ripremere; chi usa uno
                    screen reader lo sentiva (role=alert), chi guarda no.
                    Il ricovero del fuoco funziona ed è innocente: `focus()`
                    scrolla un elemento in vista solo se è GEOMETRICAMENTE fuori
                    dal viewport, e non sa nulla degli strati appiccicati.
                    `scroll-margin-bottom` avrebbe curato il solo riquadro
                    d'errore, perché è l'unico che il fuoco lo riceve: la riga di
                    stato non lo riceve mai e sarebbe rimasta coperta. Qui i
                    messaggi entrano nel piede, sopra il pulsante, e non c'è più
                    nessuno stato in cui possano finire sotto qualcosa.
                    Il componente è condiviso con la card della primaria
                    (`PiedeAzioneAssenza`): la lezione del 07/08 era stata scritta
                    in questo commento e non era mai arrivata alla porta accanto.
                */}
                {/* Il margine SUPERIORE lo dichiara il componente: dal
                    2026-08-08 è il margine NEGATIVO che toglie il tetto al
                    sollevamento dello sticky, e non può arrivare da fuori. */}
                <PiedeAzioneAssenza className="-mx-6 -mb-6 rounded-b-card bg-kidville-white px-6 py-3">
                    {error && (
                        <FasciaStatoAssenza
                            tipo="errore"
                            ruolo="alert"
                            ricovero={refErrore}
                            // Raggiungibile dal codice ma NON dal Tab: stessa forma
                            // della conferma e dell'esito dell'annullamento.
                            tabIndex={-1}
                        >
                            <span id={ID_ERRORE_INVIO}>{error}</span>
                        </FasciaStatoAssenza>
                    )}
                    {/*
                        PERCHÉ IL COMANDO NON RISPONDE — o che è appena partito.
                        `role="status"` per due ragioni insieme: è la descrizione
                        del pulsante (`aria-describedby`) e l'annuncio dell'attesa
                        (WCAG 4.1.3). Sta accanto al comando di cui parla, che è
                        anche l'unico posto in cui non può finire coperta.
                    */}
                    {statoComando && (
                        <p id={ID_STATO_COMANDO} role="status" className="font-maven text-xs text-kidville-sub">
                            {statoComando}
                        </p>
                    )}
                    <Btn
                        type="submit"
                        variant="primary"
                        size="lg"
                        // I DUE SIGNIFICATI DI «non si può premere», separati.
                        //
                        // `disabled` = NON PUOI ANCORA, ed è vero: manca il
                        // giorno (il selettore nativo di Android offre CLEAR e la
                        // richiesta partiva per farsi rifiutare), manca l'alunno,
                        // o l'identità non è ancora risolta. `!studentId` era
                        // l'assente: `ready` diventa `true` anche per un genitore
                        // senza figli collegati, e il pulsante restava acceso su
                        // un gesto che non faceva NIENTE — nessuna richiesta,
                        // nessun messaggio, nessun cambiamento a schermo.
                        //
                        // `aria-disabled` = STO LAVORANDO. Marcarlo `disabled`
                        // faceva sfogare il fuoco a Chrome — che torna su
                        // `<body>`, cioè all'inizio della pagina — proprio
                        // durante l'attesa, e lo sbiadiva a 1,20:1 portandosi via
                        // l'unico segnale che il gesto fosse partito. Un pulsante
                        // che lavora è un MESSAGGIO, non un controllo spento:
                        // resta leggibile, conserva il fuoco, e il doppio invio lo
                        // impedisce la guardia di `handleSubmit`.
                        disabled={!ready || !studentId || !data}
                        aria-disabled={submitting || undefined}
                        aria-describedby={statoComando ? ID_STATO_COMANDO : undefined}
                        className="w-full"
                    >
                        {submitting ? t('attendanceInvio') : t('attendanceComunicaAssenza')}
                    </Btn>
                </PiedeAzioneAssenza>
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
