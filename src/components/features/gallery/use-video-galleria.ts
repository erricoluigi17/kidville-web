'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
    accodaCaricamentoVideo,
    annullaCaricamentoVideo,
    caricaVideo,
    concludiCaricamentoVideo,
    creaArchivioCaricamenti,
    potaArchivioCaricamenti,
    type ArchivioCaricamentiVideo,
    type CaricamentoVideoLocale,
    type DipendenzeCaricamentoVideo,
} from '@/lib/media/video/upload';
import {
    annullaIntentoVideo,
    apriIntentoVideoGalleria,
    apriIntentoVideoGalleriaNativo,
    chiaveIdempotenzaVideo,
    chiaveIdempotenzaVideoNativo,
    intentoConcluso,
    leggiElencoVideoGalleria,
    leggiStatoIntentoVideo,
    rifiutoLocaleVideo,
    riprovaPubblicazioneVideo,
    segnalaVideoCaricato,
    type EsitoFlusso,
} from '@/lib/gallery/video-galleria-flusso';
import { conTettoDiTempo } from '@/lib/auth/errore-accesso';
import { scartaPreparatiNativi } from '@/lib/gallery/selettore-nativo';
import type { ElementoVideoNativo } from '@/lib/gallery/selettore-media';
import {
    CODICI_MOSTRATI_VIDEO,
    type CodiceMostratoVideo,
    type VoceVideo as VoceElencoVideo,
} from '@/lib/media/video/contratto';
import { scegliTrasporto, trasportoTus, type TrasportoVideo } from '@/lib/media/video/trasporto';
import { caricamentoNelContesto } from '@/lib/media/video/upload/stato';
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile';
import { useOnlineStatus } from '@/lib/hooks/use-online-status';
import { logClient } from '@/lib/logging/client';
import {
    accodaVideo as accodaVideoNativo,
    annulla as annullaVideoNativo,
    ascoltaCaricamenti,
    caricamentiNativiDisponibili,
    codiceDelPonte,
    dimentica as dimenticaVideoNativi,
    elenco as elencoVideoNativi,
} from '@/lib/native/caricamenti-nativi';
import {
    eStatoTerminaleNativo,
    type CaricamentoNativo,
    type TestiNotificheCaricamento,
} from '@/lib/native/caricamenti-nativi-tipi';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';

import type { RigaVideoLavorazione } from './VideoInLavorazione';
import { leggiNascosti, nascondiIntento } from './video-galleria-nascosti';
import {
    FASI_UI_ATTIVE,
    fondiRighe,
    statoLocaleDaCaricamentoNativo,
    stessoStatoLocale,
    type RigaComposta,
    type StatoLocale,
} from './video-galleria-righe';
import { useRipresaAutomatica, type MotivoRipresa } from './use-ripresa-automatica';

/**
 * V11 · LA MACCHINA A STATI DI UN VIDEO DI GALLERIA, DAL LATO DELLA SCHERMATA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * CHE COSA FA QUESTO HOOK, DOPO LA PR 2 «SERVER E WEB»
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * I bambini si scelgono UNA volta, prima dell'invio, e non si richiedono più. «Invia» apre subito
 * l'intento **con i destinatari** (`POST /api/video-uploads`): il server li conosce, e quando la
 * conversione finisce pubblica da solo — anche a pagina chiusa — e avvisa chi ha caricato. Quindi
 * qui non c'è più nessun ramo di pubblicazione, nessun tag in memoria e nessun «chiedi i bambini
 * al rientro»: la vita di un video, per questa schermata, è soltanto il suo trasferimento e il suo
 * racconto.
 *
 * Tre cose, e nessun'altra:
 *
 *  1. **inviare** — apre l'intento (un 422 che nomina i bambini senza liberatoria torna alla
 *     schermata PRIMA che parta un byte), scrive la riga locale e accoda il trasferimento;
 *  2. **trasferire e riprendere** — i byte partono in TUS UNO ALLA VOLTA (due gigabyte insieme si
 *     rubano la banda a vicenda), e quando la rete li interrompe ripartono da soli, senza un clic:
 *     al ritorno in primo piano, quando torna la rete, e con un'attesa crescente di 5, 15, 30, 60
 *     secondi finché la pagina è visibile (`useRipresaAutomatica`). La firma si rinnova con
 *     `POST /api/video-uploads/[id]/firma`, mai riaprendo l'intento;
 *  3. **raccontare** — fonde le righe di QUESTO dispositivo (nome, byte spediti) con l'elenco del
 *     server (`GET /api/video-uploads`, ogni 10 secondi solo mentre c'è qualcosa di attivo e la
 *     pagina è visibile; senza nulla di attivo, una volta sola al ritorno in primo piano), così un
 *     video mandato da un altro dispositivo si vede, una pubblicazione fallita offre «Riprova», e
 *     un invio del flusso vecchio dice «questo video va ricaricato».
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * LE REGOLE CHE NON SI DEROGANO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  · **«Rimuovi» ferma prima i byte, poi ritira l'intento.** `annullaCaricamentoVideo` (TUS e
 *    copia locale) viene PRIMA di `annullaIntentoVideo`: il contrario lasciava il trasferimento
 *    in volo su un intento già revocato. Se il trasferimento è già concluso non c'è nessuna
 *    sessione TUS da terminare (#136): la riga si marca annullata e si elimina, senza passare dalla
 *    terminazione che prenderebbe un 409 da `/firma`.
 *  · **I byte già sul server non si rispediscono.** Se l'apertura dice `needs_upload: false`
 *    si passa da `concludiCaricamentoVideo` (che ferma la copia in background): chiudere la riga
 *    a mano metterebbe l'`eliminaByte` dietro una copia di due gigabyte.
 *  · **Lo stesso file rimandato in volo non riscrive la scheda** (#134): la stessa chiave ritrova lo
 *    stesso job, che è già in coda o in volo, e lo stato che mostra (la barra, il turno) è già quello
 *    vero. Solo un job fermo, fuori dalla coda, riparte.
 *  · **I byte spariti sono un invio da rifare.** Un'app chiusa a metà copia lascia la riga e non i
 *    byte: la scheda dice «questo video va ricaricato» e l'intento si annulla, invece di restare
 *    in attesa dei suoi byte fino alla ritenzione.
 *  · **Un intento aperto per niente si ritira.** Se la risposta dell'apertura arriva quando la
 *    schermata non c'è più (smontata, altro utente, altra sede) l'intento esiste già sul server,
 *    confermato e in attesa di byte che nessuno spedirà: senza il ritiro resterebbe lì fino alla
 *    ritenzione, e al rientro la scheda direbbe «in caricamento da un altro dispositivo» (falso).
 *    Non si ritira però un intento che questo dispositivo ha già in mano (la stessa chiave ritrova
 *    l'invio di prima, che ha la sua riga locale): sarebbe un caricamento buono ucciso.
 *  · **«Togli» si ricorda solo a ritiro riuscito.** La scheda sparisce subito, ma l'intento entra
 *    fra quelli tolti (`video-galleria-nascosti`) soltanto quando il server ha confermato il
 *    ritiro: altrimenti resterebbe vivo — e un video in preparazione uscirebbe lo stesso in
 *    galleria — mentre il telefono lo fa credere sparito. Se il ritiro non riesce la scheda torna.
 *  · **Ogni ritiro che parte da solo ha il suo `.catch` che logga** (`ritiraSenzaAspettare`): una
 *    promessa rifiutata che nessuno ascolta è un guasto senza traccia.
 *  · **Nei log, mai il nome di un file né di un bambino**: uuid, conteggi e codici. Il nome sta
 *    sullo schermo di chi ha scelto il file, e basta.
 *  · **Una credenziale arrivata tardi non si consegna.** Dopo un logout, un cambio di sede o lo
 *    smontaggio, nessuna firma arriva a TUS (`ancora()` nelle dipendenze del trasporto).
 *
 * ⚠️ Il trasferimento TUS vive finché questa pagina è montata: lasciare la Galleria lo ferma al blocco
 * successivo, e rientrarvi lo riprende dallo stesso punto (il `File` scelto resta nell'archivio
 * condiviso). I testi dicono «finché resti in Galleria», non «finché l'app è aperta»: è vero solo del
 * TRASFERIMENTO. Quando i byte sono arrivati conversione e pubblicazione sono del server, e lì sì,
 * l'app si può chiudere.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * L'APP 1.2: I VIDEO NATIVI (spec «caricamenti nativi in background» §7.4-§7.7)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un video scelto dal selettore NATIVO non è un `File`: i suoi byte stanno nel plugin, che li spedisce
 * dal sistema operativo con una PUT sola, a telefono bloccato e a pagina chiusa. Questo hook non
 * li trasferisce: `avviaVideoNativo` apre l'intento (come `avviaVideo`, con gli stessi cancelli e lo
 * stesso 422 coi nomi) e consegna al plugin ciò che gli serve; da lì la vita del video è del nativo, e
 * qui si RACCONTA. Le regole che non si derogano:
 *
 *  · **Il trasporto lo decide l'ORIGINE dell'elemento, non `scegliTrasporto()`.** Un `File` (web, app
 *    1.0/1.1, ripiego «Usa il selettore del browser» della 1.2) va SEMPRE in TUS; un elemento nativo va
 *    al plugin. Nessuno registra `put-nativo`: farlo farebbe dichiarare la PUT a un `File` che poi andrebbe in TUS.
 *  · **La chiave d'idempotenza è `gn1-`** (`chiaveIdempotenzaVideoNativo`): deterministica, salata, coi
 *    bambini dentro. Lo stesso video con gli stessi bambini ritrova lo stesso intento (e ne ruota il token);
 *    con altri bambini apre un intento nuovo, mai un `IDEMPOTENCY_CONFLICT`.
 *  · **Un accodamento fallito ritira l'intento.** L'intento esiste già sul server, in attesa di byte che
 *    non partiranno: si ritira, si scrive `video-nativo-accodamento-fallito: job=<uuid> <codice>` e il file
 *    resta nel passo dei bambini. Lo stesso per un'apertura arrivata a schermata cambiata — salvo che la coda
 *    nativa abbia già quel job: ritirarlo ucciderebbe un invio buono.
 *  · **«Rimuovi» ferma prima i byte** (`annulla` del plugin) **e poi ritira l'intento**: stesso ordine della #58.
 *    Se i byte non si riescono a fermare l'intento NON si ritira, e la scheda torna.
 *  · **L'elenco è UNO**: la coda nativa (`elenco`, anche senza rete: è una chiamata al plugin) si fonde con
 *    quella del server in `fondiRighe`. Si rilegge al montaggio, al ritorno in primo piano, ogni 10 secondi
 *    mentre c'è qualcosa di attivo e a ogni evento `caricamento`. Una voce di un'altra sede o di un altro
 *    utente non si vede.
 *  · **A `inviato` si dice UNA volta «caricato»** al server (rete di sicurezza accanto al trigger d'arrivo e
 *    alla scansione) quando il video PASSA a `inviato` davanti alla schermata; una voce che si trova già `inviato`
 *    al montaggio lo dice solo se il server risponde ancora «da caricare» (`riconcilia`). Le voci terminali si
 *    `dimenticano` quando il server è oltre `da-caricare`, o su «Togli».
 *  · **La ripresa automatica TUS ignora le righe native**: il nativo riprende da solo.
 *  · **All'uscita dall'account l'invio CONTINUA** (decisione del titolare): `logout.ts` non nomina il plugin.
 *  · **Nei log mai un nome, un URL, un token o un hash**: uuid, conteggi e codici dell'elenco chiuso, sotto
 *    l'evento `caricamento-nativo`, solo `warn`/`error`.
 *  · **Gli id verso il plugin sono in minuscolo**: lo schema li rifiuta altrimenti (e la sede del cookie
 *    `sedi_attive` può avere le maiuscole).
 *
 * ⚠️ LIMITE NOTO. Se il plugin non è rilevato (interruttore d'emergenza spento, binario incompleto, `info()`
 * scaduta) NESSUNA chiamata al plugin parte, `elenco`/`annulla`/`dimentica` comprese: le voci già nella coda nativa
 * proseguono da sole, ma questa schermata non le mostra né le può annullare fino al ricaricamento.
 */

export interface OpzioniVideoGalleria {
    /** L'insegnante che carica. */
    utenteId: string | null;
    /**
     * La sede su cui si sta pubblicando, o `null` quando non si può sapere.
     * `null` NON è un ripiego: è il rifiuto che impedisce di archiviare il video
     * di un bambino nel plesso sbagliato senza che nessuno se ne accorga.
     */
    sede: string | null;
    /** Le classi destinatarie quando il video va in broadcast. */
    classi: string[];
    /** Da chiamare quando un video entra davvero in galleria: ricarica l'elenco. */
    onPubblicato: () => void | Promise<void>;
}

/** I bambini scelti per un video, e se va a tutta la classe. */
export interface SceltaVideo {
    tag: string[];
    broadcast: boolean;
    durataSecondi: number | null;
}

export type EsitoAvvio =
    | { ok: true }
    /**
     * Il video NON è partito, e il file resta dov'è (nel passo dei bambini): `messaggio` è già
     * tradotto, e `nomi` — quando c'è — sono i bambini senza liberatoria del 422, da mostrare a
     * schermo e mai da loggare.
     */
    | {
        ok: false;
        messaggio: string;
        nomi?: string[];
        /**
         * Il server ha detto «troppe richieste» (429): anche i video che seguono riceverebbero lo stesso
         * rifiuto, e riprovare subito non serve. Chi invia più file si ferma qui, e li lascia dov'erano.
         */
        riprovaPiuTardi?: boolean;
    };

export interface ApiVideoGalleria {
    righe: RigaVideoLavorazione[];
    avviaVideo: (file: File, scelta: SceltaVideo) => Promise<EsitoAvvio>;
    /**
     * Invia un video NATIVO (app 1.2): apre l'intento e lo consegna al plugin, che lo spedisce dal sistema operativo.
     * Stessi esiti di `avviaVideo` (un 422 coi nomi, un 429, una rete caduta restano alla schermata, col file dov'è).
     * `scelta.durataSecondi` è quella che il plugin ha misurato (`ElementoVideoNativo.durataSecondi`).
     */
    avviaVideoNativo: (nativo: ElementoVideoNativo, scelta: SceltaVideo) => Promise<EsitoAvvio>;
    /** Riprende un caricamento fermo a mano: di norma lo fa da solo (`useRipresaAutomatica`). Non vale per un video nativo. */
    riprendi: (jobId: string) => void;
    /** «Rimuovi» / «Togli»: ferma i byte, ritira l'intento, toglie la scheda. */
    rimuovi: (jobId: string) => void;
    /** «Riprova» su una pubblicazione fallita in modo definitivo. */
    riprova: (jobId: string) => void;
}

/** Ogni quanto si rilegge l'elenco mentre qualcosa è attivo e qualcuno guarda lo schermo. */
const RITMO_ELENCO_MS = 10_000;

/**
 * Oltre questo tempo la lettura della coda nativa si ABBANDONA (la richiesta non si annulla: il bridge non lo permette):
 * l'elenco del server non deve restare fermo dietro una chiamata al plugin che non risponde. Una lettura costa millisecondi.
 */
const TETTO_ELENCO_NATIVO_MS = 8_000;

/** Il contesto di chi ha avviato un giro: finché è lo stesso, ciò che il giro scrive è ancora vero. */
type Contesto = { owner: string | null; sede: string | null };

/** Il plugin dei caricamenti nativi c'è, completo e acceso? La rilevazione ne tiene la risposta in memoria per tutta la sessione. */
async function pluginNativoPresente(): Promise<boolean> {
    return (await caricamentiNativiDisponibili()) !== null;
}

/** Il rifiuto di un'apertura, per la schermata: una rete caduta dice che il file non è partito. Vale per il TUS e per il nativo. */
function rifiutoDellApertura(esito: Extract<EsitoFlusso<unknown>, { ok: false }>, testoRete: string): EsitoAvvio {
    return {
        ok: false,
        messaggio: esito.stato === null ? testoRete : esito.messaggio,
        ...(esito.nomi ? { nomi: esito.nomi } : {}),
        ...(esito.stato === 429 ? { riprovaPiuTardi: true } : {}),
    };
}

/** Un `string` qualunque (la colonna `codice` di una riga) come codice mostrabile, o `null`. */
function comeCodiceMostrato(codice: string | null | undefined): CodiceMostratoVideo | null {
    return typeof codice === 'string' && (CODICI_MOSTRATI_VIDEO as readonly string[]).includes(codice)
        ? (codice as CodiceMostratoVideo)
        : null;
}

/** Lo stato di un video su QUESTO dispositivo, a partire dalla sua riga nell'archivio. `null` = non si mostra. */
function statoDaRiga(riga: CaricamentoVideoLocale): StatoLocale | null {
    const base = {
        jobId: riga.jobId,
        intentId: riga.intentId,
        nome: riga.nome,
        creatoIl: riga.creatoIl,
        percentuale: null,
        // Una riga dell'archivio locale è sempre un trasferimento TUS: i video nativi non hanno una riga IndexedDB.
        trasporto: 'tus' as const,
        nota: null,
    };
    switch (riga.stato) {
        // Una riga con byte ancora da spedire, al rientro, è un trasferimento fermo: il codice di
        // un'altra sessione (una firma rifiutata ieri) non dice niente di quello di adesso.
        case 'da_caricare':
        case 'in_corso':
            return { ...base, trasferimento: 'interrotto', codice: null };
        case 'caricato':
            return { ...base, trasferimento: 'concluso', codice: null };
        // Un fallito di un'altra sessione la persona può non averlo visto: si mostra. Un annullato
        // l'ha chiesto lei, e non c'è niente da raccontare.
        case 'fallito':
            return { ...base, trasferimento: 'fallito', codice: comeCodiceMostrato(riga.codice) };
        default:
            return null;
    }
}

export function useVideoGalleria(opzioni: OpzioniVideoGalleria): ApiVideoGalleria {
    const t = useTranslations('teacherServizi');
    const online = useOnlineStatus();

    const [locali, setLocali] = useState<Record<string, StatoLocale>>({});
    const [voci, setVoci] = useState<VoceElencoVideo[] | null>(null);
    /** Gli intenti che la persona ha tolto E che il server ha confermato fuori dal gioco: si ricordano sul dispositivo. */
    const [nascosti, setNascosti] = useState<ReadonlySet<string>>(() => new Set<string>());
    /** Gli intenti tolti a schermo di cui si aspetta ancora il verdetto del server: spariscono subito, e non si ricordano. */
    const [inRitiro, setInRitiro] = useState<ReadonlySet<string>>(() => new Set<string>());
    const [messaggiAzione, setMessaggiAzione] = useState<Record<string, string>>({});

    /**
     * LO STATO DI ADESSO, LETTO DA CHI VIVE PIÙ A LUNGO DI UN RENDER.
     *
     * Un trasferimento dura minuti, e la funzione che lo segue è partita all'inizio: leggendo la
     * CHIUSURA vedrebbe la sede di quando è partita, non quella di adesso — e su un admin che nel
     * frattempo ha cambiato plesso, sarebbe il video archiviato nella sede sbagliata. Le due fonti
     * dello stato visibile (`locali`, `voci`) sono SCRITTE nel ref nello stesso istante in cui si
     * scrivono nello stato: un ref aggiornato solo dopo il render darebbe, a chi gira subito dopo
     * una `setState`, il valore di prima — e un trasferimento accodato un attimo dopo la riga
     * non la troverebbe.
     */
    const opzioniRef = useRef(opzioni);
    const localiRef = useRef<Record<string, StatoLocale>>({});
    const vociRef = useRef<VoceElencoVideo[] | null>(null);
    const archivioRef = useRef<ArchivioCaricamentiVideo | null>(null);
    const montatoRef = useRef(false);
    useEffect(() => {
        montatoRef.current = true;
        return () => {
            montatoRef.current = false;
        };
    }, []);

    /** Le dipendenze di trasferimento di ogni job (con la firma in memoria), e il trasporto che le ha prodotte. */
    const dipRef = useRef<Map<string, DipendenzeCaricamentoVideo>>(new Map());
    const trasportiRef = useRef<Map<string, TrasportoVideo>>(new Map());
    /** La firma con cui il server ha aperto un job: vale solo per il primo trasferimento. */
    const firmeRef = useRef<Map<string, { firma: string; scadeIl: string | null }>>(new Map());
    /** La coda dei trasferimenti: UNO alla volta. */
    const codaRef = useRef<Promise<void>>(Promise.resolve());
    /** I job accodati o in volo: un secondo tocco, o un segnale doppio, non ne fa partire un secondo. */
    const inCodaRef = useRef<Set<string>>(new Set());
    const annullatiRef = useRef<Set<string>>(new Set());
    /** I job per cui «caricato» è già stato segnalato in questa sessione. */
    const segnalatiRef = useRef<Set<string>>(new Set());
    const riprovaInCorsoRef = useRef<Set<string>>(new Set());
    const elencoInVoloRef = useRef<Promise<void> | null>(null);
    /** Gli intenti visti in una fase attiva: solo per loro, una pubblicazione è una NOVITÀ che ricarica la galleria. */
    const attiviVistiRef = useRef<Set<string>>(new Set());
    const pubblicatiRef = useRef<Set<string>>(new Set());
    const ultimaPercentualeRef = useRef<Map<string, number | null>>(new Map());
    /** Azzera l'attesa della ripresa automatica: la chiama un trasferimento arrivato in fondo (`useRipresaAutomatica`). */
    const azzeraRipresaRef = useRef<() => void>(() => undefined);
    /**
     * L'ULTIMA voce della coda nativa vista per ogni job di QUESTO contesto (utente e sede). Serve a tre cose che lo
     * `StatoLocale` non porta: i byte e il MIME da dichiarare a «caricato», l'istante dell'ultimo aggiornamento (un evento
     * arrivato in ritardo non fa tornare indietro la scheda) e se la voce è terminale (e si può dimenticare).
     */
    const vociNativeRef = useRef<Map<string, CaricamentoNativo>>(new Map());
    /** I job nativi di cui si è già chiesto `dimentica`: una volta sola. */
    const dimenticatiNativiRef = useRef<Set<string>>(new Set());
    /** Rilegge la coda nativa. Sta in un ref perché è definita dopo `segnalaCaricato`, da cui dipende: così si spezza il giro di dipendenze. */
    const leggiElencoNativoRef = useRef<(c: Contesto) => Promise<void>>(async () => undefined);
    /** Applica una voce della coda nativa (la stessa per l'elenco, per gli eventi e per l'esito di `accodaVideo`). */
    const applicaVoceNativaRef = useRef<(voce: CaricamentoNativo, c: Contesto) => void>(() => undefined);

    /** Il ripiego di ogni messaggio: mai la stringa vuota, che a schermo è silenzio. */
    const ripiego = t('galleryErrCaricamentoGenerico');
    const ripiegoRef = useRef(ripiego);
    const testoRete = t('galleryErrRete');
    const testoReteRef = useRef(testoRete);
    // I testi del trasporto NATIVO. Si leggono QUI, come stringhe, e non dentro le funzioni: `t` cambia a ogni render (nei
    // test, e può farlo anche altrove) e metterlo fra le dipendenze rifarebbe ogni callback a ogni render.
    const notaNativoInvio = t('galleryVideoNotaNativo');
    const notaNativoAttesaRete = t('galleryVideoAttesaRete');
    const notaNativoPausa = t('galleryVideoInPausa');
    const noteNativo = useMemo(
        () => ({ invio: notaNativoInvio, attesaRete: notaNativoAttesaRete, pausa: notaNativoPausa }),
        [notaNativoInvio, notaNativoAttesaRete, notaNativoPausa],
    );
    // Le frasi delle notifiche di sistema (iOS: notifica locale; Android: servizio in primo piano): le conserva il nativo
    // nella sua coda, e le legge a schermo bloccato. Senza nomi né miniature (spec §9).
    const testoNotificaTitolo = t('notificaCaricamentoTitolo');
    const testoNotificaInvio = t('notificaCaricamentoInvio');
    const testoNotificaAttesaRete = t('notificaCaricamentoAttesaRete');
    const testoNotificaPausa = t('notificaCaricamentoPausa');
    const testiNotifiche = useMemo<TestiNotificheCaricamento>(
        () => ({
            titolo: testoNotificaTitolo,
            invio: testoNotificaInvio,
            attesaRete: testoNotificaAttesaRete,
            pausa: testoNotificaPausa,
        }),
        [testoNotificaTitolo, testoNotificaInvio, testoNotificaAttesaRete, testoNotificaPausa],
    );
    const testiNotificheRef = useRef(testiNotifiche);
    useEffect(() => {
        opzioniRef.current = opzioni;
        ripiegoRef.current = ripiego;
        testoReteRef.current = testoRete;
        testiNotificheRef.current = testiNotifiche;
    });

    /** La frase del catalogo per un codice della pipeline, nella lingua a schermo. */
    const frase = useCallback((codice: string | null): string => soloCatalogoDaCorpo({ codice }, ripiego), [ripiego]);
    const fraseRef = useRef(frase);
    useEffect(() => {
        fraseRef.current = frase;
    });

    /* ────────────────────────────────────────────────────────────────────────
     * LO STATO: scrittura nel ref E nello stato, nello stesso istante
     * ──────────────────────────────────────────────────────────────────────── */

    const scriviLocali = useCallback((f: (prec: Record<string, StatoLocale>) => Record<string, StatoLocale>) => {
        const dopo = f(localiRef.current);
        if (dopo === localiRef.current) return;
        localiRef.current = dopo;
        setLocali(dopo);
    }, []);

    const aggiornaLocale = useCallback(
        (jobId: string, modifiche: Partial<StatoLocale>) =>
            scriviLocali((prec) => (prec[jobId] ? { ...prec, [jobId]: { ...prec[jobId], ...modifiche } } : prec)),
        [scriviLocali],
    );

    const togliLocale = useCallback(
        (jobId: string) =>
            scriviLocali((prec) =>
                jobId in prec ? Object.fromEntries(Object.entries(prec).filter(([id]) => id !== jobId)) : prec,
            ),
        [scriviLocali],
    );

    const scriviVoci = useCallback((dopo: VoceElencoVideo[] | null) => {
        vociRef.current = dopo;
        setVoci(dopo);
    }, []);

    const segnalaMessaggioAzione = useCallback((jobId: string, messaggio: string | null) => {
        setMessaggiAzione((prec) => {
            if (messaggio === null) {
                if (!(jobId in prec)) return prec;
                return Object.fromEntries(Object.entries(prec).filter(([id]) => id !== jobId));
            }
            return { ...prec, [jobId]: messaggio };
        });
    }, []);

    /** Il contesto di chi ha avviato un giro: finché è lo stesso, ciò che il giro scrive è ancora vero. */
    const contesto = useCallback(
        () => ({ owner: opzioniRef.current.utenteId, sede: opzioniRef.current.sede }),
        [],
    );
    const stessoContesto = useCallback(
        (c: { owner: string | null; sede: string | null }) =>
            montatoRef.current && c.owner === opzioniRef.current.utenteId && c.sede === opzioniRef.current.sede,
        [],
    );

    const logErroreAzione = useCallback((messaggio: string, err: unknown) => {
        logClient({
            livello: 'error',
            evento: 'offline',
            messaggio,
            campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' },
        });
    }, []);

    /* ────────────────────────────────────────────────────────────────────────
     * IL TRASPORTO DI UN JOB
     * ──────────────────────────────────────────────────────────────────────── */

    const dipendenzePer = useCallback(
        (jobId: string, intentId: string): DipendenzeCaricamentoVideo | null => {
            const gia = dipRef.current.get(jobId);
            if (gia) return gia;
            const archivio = archivioRef.current;
            if (!archivio) return null;
            const c = contesto();
            const trasporto = trasportiRef.current.get(jobId) ?? trasportoTus;
            const dip = trasporto.dipendenze({
                archivio,
                jobId,
                intentId,
                iniziale: firmeRef.current.get(jobId) ?? null,
                ancora: () => stessoContesto(c),
                rete: (url, init) => fetch(url, init),
            });
            dipRef.current.set(jobId, dip);
            return dip;
        },
        [contesto, stessoContesto],
    );

    /** Dimentica tutto ciò che il dispositivo teneva in memoria per un job. */
    const dimenticaJob = useCallback((jobId: string) => {
        dipRef.current.delete(jobId);
        trasportiRef.current.delete(jobId);
        firmeRef.current.delete(jobId);
        ultimaPercentualeRef.current.delete(jobId);
    }, []);

    /* ────────────────────────────────────────────────────────────────────────
     * IL RITIRO DI UN INTENTO
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * Ritira un intento: legge lo stato per avere la revisione di ADESSO (cambia a ogni passo del
     * ciclo, e indovinarla vuol dire un `REVISION_MISMATCH` che nessuno vede) e lo annulla. Un
     * intento già concluso non si tocca.
     *
     * Risponde se l'intento è DAVVERO fuori dal gioco: `true` quando il server l'ha annullato o era
     * già concluso, `false` quando non lo si sa (rete, rifiuto, revisione che continua a cambiare).
     * È il verdetto su cui si decide se ricordare che la persona l'ha tolto (#141): un intento che
     * resta vivo non si può far passare per sparito. Non lancia per un guasto di rete (`chiama` lo
     * registra già); chi lo lancia senza aspettarlo passa da `ritiraSenzaAspettare`.
     */
    const ritiraIntento = useCallback(async (intentId: string): Promise<boolean> => {
        for (let tentativo = 0; tentativo < 2; tentativo++) {
            const letto = await leggiStatoIntentoVideo(fetch, { intentId, ripiego: ripiegoRef.current });
            if (!letto.ok) return false;
            if (['published', 'cancelled', 'superseded'].includes(letto.dati.statoIntent)) return true;
            const esito = await annullaIntentoVideo(fetch, {
                intentId,
                revisione: letto.dati.revisione,
                ripiego: ripiegoRef.current,
            });
            if (esito.ok) return true;
            // 409 = qualcosa è cambiato fra la lettura e il ritiro: si rilegge e si riprova UNA volta.
            if (esito.stato !== 409) return false;
        }
        return false;
    }, []);

    /**
     * Il ritiro di un intento che nessuno aspetta (#137): ogni `void ritiraIntento(…)` del file passa
     * da qui, così il `.catch` che logga non dipende dalla memoria di chi scrive la chiamata.
     */
    const ritiraSenzaAspettare = useCallback(
        (intentId: string) => {
            void ritiraIntento(intentId).catch((err: unknown) => logErroreAzione('video-annullamento-interrotto', err));
        },
        [logErroreAzione, ritiraIntento],
    );

    /**
     * L'apertura è riuscita, ma la schermata che l'aspettava non c'è più (#132): smontata, un altro
     * utente, un'altra sede. L'intento esiste sul server — confermato, con il suo job in attesa di
     * byte — e nessuno li spedirà: lo si ritira.
     *
     * ⚠️ Solo se è un intento SENZA PADRONE. La stessa chiave di idempotenza ritrova l'intento di un
     * invio precedente dello stesso file con gli stessi bambini (la risposta si era persa, un secondo
     * tocco): se quell'invio è di questo dispositivo ha la sua riga nell'archivio, e ritirarlo
     * ucciderebbe un caricamento buono che riprenderebbe al rientro. Nel dubbio — l'archivio non si
     * legge — non si ritira: un intento fantasma costa una scheda sbagliata fino alla ritenzione, un
     * caricamento ucciso costa un video da rimandare.
     */
    const ritiraAperturaOrfana = useCallback(
        (intentId: string, jobId: string) => {
            void (async () => {
                const riga = await archivioRef.current?.leggi(jobId);
                if (riga) return;
                const ritirato = await ritiraIntento(intentId);
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `${ritirato ? 'video-intento-orfano-ritirato' : 'video-intento-orfano-non-ritirato'}: job=${jobId}`,
                });
            })().catch((err: unknown) => logErroreAzione('video-annullamento-interrotto', err));
        },
        [logErroreAzione, ritiraIntento],
    );

    /**
     * Lo stesso di `ritiraAperturaOrfana` per un video NATIVO: l'apertura è riuscita, ma la schermata non c'è più (smontata,
     * un altro utente, un'altra sede) e nessuno consegnerà i byte al plugin. Il dubbio è lo stesso — «questo dispositivo ha
     * già l'invio in mano?» — ma la risposta non sta nell'archivio (un video nativo non ha una riga IndexedDB): sta nella
     * coda del PLUGIN. Se quel job c'è, la stessa chiave `gn1-` ha ritrovato l'intento di un invio precedente di questo
     * telefono, che sta spedendo: ritirarlo ucciderebbe un caricamento buono. Nel dubbio — la coda non si legge — non si
     * ritira, per la stessa ragione.
     */
    const ritiraAperturaOrfanaNativa = useCallback(
        (intentId: string, jobId: string, owner: string) => {
            void (async () => {
                let giaNellaCoda: boolean;
                try {
                    const { caricamenti } = await elencoVideoNativi({ utenteId: owner.toLowerCase() });
                    giaNellaCoda = caricamenti.some((v) => v.jobId === jobId.toLowerCase());
                } catch (err) {
                    logClient({
                        livello: 'warn',
                        evento: 'caricamento-nativo',
                        messaggio: `video-nativo-elenco-non-letto: ${codiceDelPonte(err)}`,
                    });
                    return;
                }
                if (giaNellaCoda) return;
                const ritirato = await ritiraIntento(intentId);
                logClient({
                    livello: 'warn',
                    evento: 'caricamento-nativo',
                    messaggio: `${ritirato ? 'video-intento-orfano-ritirato' : 'video-intento-orfano-non-ritirato'}: job=${jobId}`,
                });
            })().catch((err: unknown) => logErroreAzione('video-annullamento-interrotto', err));
        },
        [logErroreAzione, ritiraIntento],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * LA CODA NATIVA: togliere ciò che è finito
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * Toglie dalla coda del plugin la voce di un job che ha FINITO (`inviato`, `fallito`, `annullato`): da lì in poi la sua
     * storia la racconta il server, e tenerla lì la farebbe tornare in ogni lettura fino alla pulizia di 7 giorni. Una volta
     * sola per job (`dimenticatiNativiRef`), e solo se la voce che si è vista è terminale: il plugin ignora comunque una voce
     * che non lo è, ma è inutile chiederglielo. Mai lancia: un guasto qui è un ritardo (la voce sparisce alla pulizia).
     */
    const dimenticaVoceNativa = useCallback((jobId: string) => {
        const voce = vociNativeRef.current.get(jobId);
        if (!voce || !eStatoTerminaleNativo(voce.stato) || dimenticatiNativiRef.current.has(jobId)) return;
        dimenticatiNativiRef.current.add(jobId);
        void dimenticaVideoNativi({ jobIds: [jobId] }).then(
            () => {
                vociNativeRef.current.delete(jobId);
            },
            (err: unknown) => {
                dimenticatiNativiRef.current.delete(jobId);
                logClient({
                    livello: 'warn',
                    evento: 'caricamento-nativo',
                    messaggio: `video-nativo-dimentica-fallito: ${codiceDelPonte(err)}`,
                });
            },
        );
    }, []);

    /* ────────────────────────────────────────────────────────────────────────
     * L'ELENCO DAL SERVER
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * Ciò che l'elenco dice e questo dispositivo ancora non sa, messo a posto:
     *
     *  · un video **pubblicato** si toglie dallo schermo, la riga locale si butta, e se lo si era
     *    visto in lavorazione la galleria si ricarica (`onPubblicato`): è la notizia che c'è un
     *    video nuovo;
     *  · un trasferimento fermo il cui job ha già i byte sul server (arrivati da un altro tentativo,
     *    o dall'ultimo blocco di un tentativo la cui risposta si è persa) non si rispedisce: si
     *    conclude;
     *  · un trasferimento finito per cui il server dice ancora «da caricare» riceve la rete di
     *    sicurezza (`PATCH caricato`) una volta sola: il server se ne accorge anche da sé, ma non
     *    è detto che l'abbia già fatto.
     *
     * Un video NATIVO ha le sue strade (spec §7.5), perché non ha una riga nell'archivio e i suoi byte non li
     * muove questa pagina: la voce terminale del plugin si DIMENTICA quando il server è oltre `da-caricare` (o è già
     * pubblicato); un trasferimento fermo non si «conclude» a mano (il plugin lo scoprirà da sé al prossimo rifiuto
     * della PUT, che è immediato per un file già arrivato); e la rete di sicurezza usa i byte e il MIME che il plugin
     * ha dichiarato, non quelli di una riga IndexedDB.
     */
    const riconcilia = useCallback(
        async (lista: readonly VoceElencoVideo[], c: { owner: string | null; sede: string | null }) => {
            const archivio = archivioRef.current;
            for (const voce of lista) {
                if (!stessoContesto(c)) return;
                const locale = localiRef.current[voce.jobId];
                const nativo = locale?.trasporto === 'nativo';

                if (voce.fase === 'pubblicato') {
                    if (locale) {
                        togliLocale(voce.jobId);
                        dimenticaJob(voce.jobId);
                        if (nativo) {
                            dimenticaVoceNativa(voce.jobId);
                        } else {
                            await archivio?.elimina(voce.jobId).catch((err: unknown) => {
                                logClient({
                                    livello: 'warn',
                                    evento: 'offline',
                                    messaggio: 'video-riferimento-non-rimosso',
                                    campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' },
                                });
                            });
                        }
                    }
                    if (!pubblicatiRef.current.has(voce.intentId)) {
                        pubblicatiRef.current.add(voce.intentId);
                        if (attiviVistiRef.current.has(voce.intentId)) await opzioniRef.current.onPubblicato();
                    }
                    continue;
                }

                if (!locale) continue;

                if (nativo) {
                    if (voce.fase !== 'da-caricare') {
                        dimenticaVoceNativa(voce.jobId);
                    } else if (locale.trasferimento === 'concluso' && !segnalatiRef.current.has(voce.jobId)) {
                        const inviata = vociNativeRef.current.get(voce.jobId);
                        if (inviata) {
                            segnalatiRef.current.add(voce.jobId);
                            await segnalaVideoCaricato(fetch, {
                                intentId: voce.intentId,
                                jobId: voce.jobId,
                                byte: inviata.byteTotali,
                                mime: inviata.mime,
                                ripiego: ripiegoRef.current,
                            });
                        }
                    }
                    continue;
                }

                if (
                    voce.fase !== 'da-caricare'
                    && (locale.trasferimento === 'interrotto' || locale.trasferimento === 'in-fila')
                ) {
                    if (archivio) {
                        await concludiCaricamentoVideo({ archivio }, voce.jobId).catch((err: unknown) =>
                            logErroreAzione('video-conclusione-locale-fallita', err),
                        );
                    }
                    aggiornaLocale(voce.jobId, { trasferimento: 'concluso', percentuale: null, codice: null });
                } else if (
                    voce.fase === 'da-caricare'
                    && locale.trasferimento === 'concluso'
                    && !segnalatiRef.current.has(voce.jobId)
                ) {
                    segnalatiRef.current.add(voce.jobId);
                    const riga = await archivio?.leggi(voce.jobId);
                    if (riga) {
                        await segnalaVideoCaricato(fetch, {
                            intentId: voce.intentId,
                            jobId: voce.jobId,
                            byte: riga.dimensioneByte,
                            mime: riga.mime,
                            ripiego: ripiegoRef.current,
                        });
                    }
                }
            }
        },
        [aggiornaLocale, dimenticaJob, dimenticaVoceNativa, logErroreAzione, stessoContesto, togliLocale],
    );

    const caricaElenco = useCallback((): Promise<void> => {
        if (elencoInVoloRef.current) return elencoInVoloRef.current;
        const c = contesto();
        if (!c.owner || !c.sede) return Promise.resolve();
        const sede = c.sede;
        // Senza rete non si chiede al SERVER: ogni giro a vuoto lascerebbe una riga `error` e non direbbe niente. La coda
        // NATIVA invece si legge lo stesso: è una chiamata al plugin e non alla rete, ed è proprio senza rete che racconta «in attesa».
        const senzaRete = typeof navigator !== 'undefined' && navigator.onLine === false;
        const giro = (async () => {
            // Le due letture partono insieme — la richiesta al server nello stesso istante di prima — e `riconcilia`
            // aspetta entrambe: per decidere che cosa dimenticare e che cosa segnalare deve vedere le voci del plugin.
            const codaNativa = leggiElencoNativoRef.current(c);
            const server = senzaRete ? null : leggiElencoVideoGalleria(fetch, { scuolaId: sede, ripiego: ripiegoRef.current });
            const [esito] = await Promise.all([server, codaNativa]);
            if (!stessoContesto(c) || !esito?.ok) return;
            scriviVoci(esito.dati.voci);
            await riconcilia(esito.dati.voci, c);
        })()
            .catch((err: unknown) => logErroreAzione('video-elenco-interrotto', err))
            .finally(() => {
                elencoInVoloRef.current = null;
            });
        elencoInVoloRef.current = giro;
        return giro;
    }, [contesto, logErroreAzione, riconcilia, scriviVoci, stessoContesto]);
    const caricaElencoRef = useRef(caricaElenco);
    useEffect(() => {
        caricaElencoRef.current = caricaElenco;
    });

    /* ────────────────────────────────────────────────────────────────────────
     * IL TRASFERIMENTO (che è anche la RIPRESA)
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * I byte sono tutti sullo Storage: si dice al server («rete di sicurezza», idempotente: il
     * trigger d'arrivo se ne accorge da solo) e si rilegge l'elenco. Un rifiuto qui NON è un
     * problema per chi ha caricato — i byte ci sono — e `chiama` lo registra già nei log.
     */
    const dopoTrasferimento = useCallback(
        async (jobId: string, byte: number, mime: string, c: { owner: string | null; sede: string | null }) => {
            aggiornaLocale(jobId, { trasferimento: 'concluso', percentuale: null, codice: null });
            const locale = localiRef.current[jobId];
            if (!locale) return;
            segnalatiRef.current.add(jobId);
            await segnalaVideoCaricato(fetch, {
                intentId: locale.intentId,
                jobId,
                byte,
                mime,
                ripiego: ripiegoRef.current,
            });
            if (!stessoContesto(c)) return;
            await caricaElenco();
        },
        [aggiornaLocale, caricaElenco, stessoContesto],
    );

    /**
     * «Caricato» FUORI dalla coda dei trasferimenti: la coda aspetta i byte, non la risposta di una
     * richiesta che su una rete mobile può restare appesa minuti — il video dopo non deve aspettarla.
     */
    const segnalaCaricato = useCallback(
        (jobId: string, byte: number, mime: string, c: { owner: string | null; sede: string | null }) => {
            void dopoTrasferimento(jobId, byte, mime, c).catch((err: unknown) =>
                logErroreAzione('video-caricato-non-segnalato', err),
            );
        },
        [dopoTrasferimento, logErroreAzione],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * LA CODA NATIVA (app 1.2): leggerla e raccontarla
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * Mette una voce della coda del plugin dentro lo stato della schermata. È l'UNICA strada: la percorrono la lettura
     * dell'elenco, ogni evento `caricamento` e l'esito di `accodaVideo`, così nessuna delle tre può raccontare le cose in
     * modo diverso dalle altre.
     *
     *  · una voce di un ALTRO utente o di un'ALTRA sede non è di questa schermata: l'elenco del plugin è dell'utente, e un
     *    evento arriva a chiunque ascolti;
     *  · una voce che «Rimuovi» ha appena tolto (`annullatiRef`) non risorge: l'evento `annullato` che l'annullamento stesso
     *    produce arriva dopo che la scheda è sparita;
     *  · una voce PIÙ VECCHIA di quella già vista (un evento e l'esito di `accodaVideo` non hanno un ordine garantito)
     *    non fa tornare indietro la scheda;
     *  · lo stato si riscrive solo se cambia qualcosa: un avanzamento che non sposta la percentuale intera non rifà il disegno;
     *  · quando il video PASSA a `inviato` sotto gli occhi di questa schermata (la voce di prima era ancora viva) i byte sono
     *    sullo Storage: si dice «caricato» al server UNA volta, come fa il TUS a fine trasferimento (rete di sicurezza accanto
     *    al trigger d'arrivo e alla scansione). Una voce che si TROVA già `inviato` — l'app era chiusa, la pagina appena
     *    aperta — non scatta da qui: ci pensa `riconcilia`, che dice «caricato» solo se il server dice ancora «da caricare».
     *    Chiederlo sempre sarebbe una richiesta in più, e un rifiuto nei log, per ogni video già pubblicato da giorni.
     */
    const applicaVoceNativa = useCallback(
        (voce: CaricamentoNativo, c: Contesto) => {
            if (!stessoContesto(c) || !c.owner || !c.sede) return;
            if (voce.utenteId !== c.owner.toLowerCase() || voce.scuolaId !== c.sede.toLowerCase()) return;
            if (annullatiRef.current.has(voce.jobId)) return;
            const prima = vociNativeRef.current.get(voce.jobId);
            if (prima && Date.parse(prima.aggiornatoIl) > Date.parse(voce.aggiornatoIl)) return;
            vociNativeRef.current.set(voce.jobId, voce);
            const stato = statoLocaleDaCaricamentoNativo(voce);
            scriviLocali((prec) => (stessoStatoLocale(prec[voce.jobId], stato) ? prec : { ...prec, [voce.jobId]: stato }));
            const eraViva = prima !== undefined && !eStatoTerminaleNativo(prima.stato);
            if (voce.stato === 'inviato' && eraViva && !segnalatiRef.current.has(voce.jobId)) {
                segnalatiRef.current.add(voce.jobId);
                segnalaCaricato(voce.jobId, voce.byteTotali, voce.mime, c);
            }
        },
        [scriviLocali, segnalaCaricato, stessoContesto],
    );

    /**
     * Legge la coda del plugin per QUESTO utente e applica ogni voce di QUESTA sede. Senza plugin (web, app 1.0/1.1,
     * interruttore spento, binario incompleto) non chiama niente e non scrive niente: è il caso normale, non un guasto.
     * Mai lancia, e non aspetta più di `TETTO_ELENCO_NATIVO_MS`: una chiamata al plugin che non risponde non deve tenere
     * ferma la lettura dell'elenco del server, che aspetta questa (`caricaElenco`). Un rifiuto è un `warn` col suo CODICE
     * dell'elenco chiuso, mai il messaggio del ponte: la lettura successiva riprova.
     */
    const leggiElencoNativo = useCallback(
        async (c: Contesto): Promise<void> => {
            if (!c.owner || !c.sede || !(await pluginNativoPresente())) return;
            let caricamenti: CaricamentoNativo[];
            try {
                const lettura = await conTettoDiTempo(
                    elencoVideoNativi({ utenteId: c.owner.toLowerCase() }),
                    TETTO_ELENCO_NATIVO_MS,
                );
                if (lettura.scaduto) {
                    logClient({ livello: 'warn', evento: 'caricamento-nativo', messaggio: 'video-nativo-elenco-scaduto' });
                    return;
                }
                caricamenti = lettura.valore.caricamenti;
            } catch (err) {
                logClient({
                    livello: 'warn',
                    evento: 'caricamento-nativo',
                    messaggio: `video-nativo-elenco-non-letto: ${codiceDelPonte(err)}`,
                });
                return;
            }
            if (!stessoContesto(c)) return;
            for (const voce of caricamenti) applicaVoceNativa(voce, c);
        },
        [applicaVoceNativa, stessoContesto],
    );
    useEffect(() => {
        leggiElencoNativoRef.current = leggiElencoNativo;
        applicaVoceNativaRef.current = applicaVoceNativa;
    });

    const trasferisci = useCallback(
        async (jobId: string): Promise<void> => {
            const c = contesto();
            const ancora = () => stessoContesto(c) && !annullatiRef.current.has(jobId);
            const archivio = archivioRef.current;
            const locale = localiRef.current[jobId];
            if (!archivio || !locale || !c.owner || !c.sede || !ancora()) return;
            // Il lavoro è già stato fatto (o disfatto) da un'altra strada mentre aspettava il suo turno.
            if (!['in-fila', 'interrotto'].includes(locale.trasferimento)) return;

            const riga = await archivio.leggi(jobId);
            if (!ancora() || !riga || !caricamentoNelContesto(riga, c.owner, c.sede, 'gallery')) return;
            if (riga.stato === 'annullato') {
                aggiornaLocale(jobId, { trasferimento: 'annullato' });
                return;
            }
            if (riga.stato === 'fallito') {
                aggiornaLocale(jobId, { trasferimento: 'fallito', codice: comeCodiceMostrato(riga.codice) });
                return;
            }
            if (riga.stato === 'caricato') {
                segnalaCaricato(jobId, riga.dimensioneByte, riga.mime, c);
                return;
            }

            const dip = dipendenzePer(jobId, locale.intentId);
            if (!dip) return;
            aggiornaLocale(jobId, {
                trasferimento: 'in-corso',
                codice: null,
                percentuale: riga.dimensioneByte > 0 ? Math.min(100, Math.round((riga.offsetByte / riga.dimensioneByte) * 100)) : null,
            });

            const esito = await caricaVideo(dip, jobId, {
                alProgresso: (fatti, totali) => {
                    if (!ancora()) return;
                    const percentuale = totali > 0 ? Math.min(100, Math.round((fatti / totali) * 100)) : null;
                    // Un numero uguale non rifà il disegno: tus avvisa a ogni blocco, la barra si muove per interi.
                    if (ultimaPercentualeRef.current.get(jobId) === percentuale) return;
                    ultimaPercentualeRef.current.set(jobId, percentuale);
                    aggiornaLocale(jobId, { percentuale });
                },
            });
            if (!stessoContesto(c)) return;

            switch (esito.esito) {
                case 'caricato':
                    // I byte sono arrivati: la rete funziona. Se altri video sono fermi, riprovano fra 5
                    // secondi e non dopo i 60 accumulati dai tentativi a vuoto.
                    azzeraRipresaRef.current();
                    segnalaCaricato(jobId, esito.byteCaricati, riga.mime, c);
                    return;
                case 'interrotto':
                    // Non è un fallimento: i byte restano sul dispositivo e la ripresa è automatica.
                    aggiornaLocale(jobId, { trasferimento: 'interrotto', percentuale: null, codice: esito.codice });
                    return;
                case 'annullato':
                    // L'ha chiesto una persona (`rimuovi`), che si occupa anche del resto.
                    return;
                case 'fallito':
                    // Riprovare gli stessi byte non può funzionare: la scheda lo dice, e l'intento si
                    // ritira — altrimenti resterebbe un job in attesa di byte che non arriveranno, e
                    // dopo due giorni un avviso di «video non riuscito» per un invio già abbandonato.
                    aggiornaLocale(jobId, { trasferimento: 'fallito', percentuale: null, codice: esito.codice });
                    ritiraSenzaAspettare(locale.intentId);
                    return;
            }
        },
        [aggiornaLocale, contesto, dipendenzePer, ritiraSenzaAspettare, segnalaCaricato, stessoContesto],
    );

    /** Mette un trasferimento in coda: ne parte UNO alla volta, nell'ordine in cui sono stati accodati. */
    const accodaTrasferimento = useCallback(
        (jobId: string) => {
            if (inCodaRef.current.has(jobId)) return;
            inCodaRef.current.add(jobId);
            codaRef.current = codaRef.current
                .then(() => trasferisci(jobId))
                .catch((err: unknown) => logErroreAzione('video-trasferimento-interrotto', err))
                .finally(() => {
                    inCodaRef.current.delete(jobId);
                });
        },
        [logErroreAzione, trasferisci],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * INVIARE
     * ──────────────────────────────────────────────────────────────────────── */

    const avviaVideo = useCallback<ApiVideoGalleria['avviaVideo']>(
        async (file, scelta) => {
            const c = contesto();
            if (!c.sede || !c.owner) {
                // NON si indovina il plesso. `SEDE_DA_SPECIFICARE` è il codice che
                // `rifiutoSede` manda già da 137 route, con la sua voce di catalogo:
                // inventarne un secondo per i video vorrebbe dire due frasi diverse
                // per lo stesso rifiuto.
                return { ok: false, messaggio: fraseRef.current('SEDE_DA_SPECIFICARE') };
            }
            const sede = c.sede;
            const owner = c.owner;
            const archivio = archivioRef.current;
            if (!archivio) return { ok: false, messaggio: ripiegoRef.current };

            const rifiuto = rifiutoLocaleVideo(file, scelta.durataSecondi);
            if (rifiuto) return { ok: false, messaggio: fraseRef.current(rifiuto) };

            const trasporto = scegliTrasporto();
            // I bambini di QUESTO invio, fissati una volta: sono nel corpo della POST e sono nella chiave.
            const destinatari = {
                tagAlunni: scelta.tag,
                broadcast: scelta.broadcast,
                classi: opzioniRef.current.classi,
            };
            const apri = (chiaveIdempotenza: string) =>
                apriIntentoVideoGalleria(fetch, {
                    file,
                    scuolaId: sede,
                    durataSecondi: scelta.durataSecondi,
                    chiaveIdempotenza,
                    destinatari,
                    trasporto: trasporto.nome,
                    ripiego: ripiegoRef.current,
                });
            const rifiutato = (esito: Extract<EsitoFlusso<unknown>, { ok: false }>): EsitoAvvio =>
                rifiutoDellApertura(esito, testoReteRef.current);

            // ⚠️ La chiave porta i bambini: per il server la stessa chiave con bambini diversi è un
            // `IDEMPOTENCY_CONFLICT` (409 `VIDEO_RIPROVA`), cioè «ricarica e riprova» per un gesto che
            // non può riuscire — lo stesso file rimandato dopo «Rimuovi» con altri bambini, o già
            // mandato col client di prima. Vedi `chiaveIdempotenzaVideo` (che porta anche il sale del
            // dispositivo: i bambini non restano in tabella nemmeno come impronta).
            let chiave = chiaveIdempotenzaVideo(file, destinatari);
            let apertura = await apri(chiave);
            if (!apertura.ok) return rifiutato(apertura);

            // Una scelta NUOVA dello stesso file (stesso nome, peso e data) CON GLI STESSI BAMBINI
            // ritrova l'intento di prima. Se quello è già finito — pubblicato e magari poi cancellato,
            // ritirato, sostituito, fallito — riaprirlo non porta da nessuna parte: è un caricamento
            // nuovo, con un intento nuovo (`intentoConcluso`).
            // La risposta è arrivata a schermata cambiata (smontata, altro utente, altra sede): l'intento
            // esiste sul server e nessuno spedirà i suoi byte. Un intento già concluso, invece, non è
            // nostro e non si tocca.
            if (!stessoContesto(c)) {
                if (!intentoConcluso(apertura.dati)) ritiraAperturaOrfana(apertura.dati.intentId, apertura.dati.jobId);
                return { ok: false, messaggio: fraseRef.current('VIDEO_NON_AUTORIZZATO') };
            }

            if (intentoConcluso(apertura.dati)) {
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: `video-nuovo-intento-dopo-concluso: job=${apertura.dati.jobId}`,
                    campi: { stato_intento: apertura.dati.statoIntent, stato_job: apertura.dati.statoJob },
                });
                chiave = `${chiave}-${crypto.randomUUID()}`;
                apertura = await apri(chiave);
                if (!apertura.ok) return rifiutato(apertura);
                if (!stessoContesto(c)) {
                    ritiraAperturaOrfana(apertura.dati.intentId, apertura.dati.jobId);
                    return { ok: false, messaggio: fraseRef.current('VIDEO_NON_AUTORIZZATO') };
                }
            }

            const { jobId, intentId, coordinate, firma, chiaveIdempotenza, needsUpload, expiresAt } = apertura.dati;
            if (firma) firmeRef.current.set(jobId, { firma, scadeIl: expiresAt });
            trasportiRef.current.set(jobId, trasporto);
            const dip = dipendenzePer(jobId, intentId);
            if (!dip) return { ok: false, messaggio: ripiegoRef.current };

            // La riga locale e il `File` vivo: il trasferimento comincia subito, la copia in IndexedDB
            // (che serve alla ripresa dopo la chiusura dell'app) parte per conto suo e non si aspetta.
            const messo = await accodaCaricamentoVideo(dip, {
                jobId,
                intentId,
                canale: 'gallery',
                ownerId: owner,
                scuolaId: sede,
                chiaveIdempotenza,
                coordinate,
                file,
            });
            if (!messo.ok) {
                // L'intento esiste già sul server, confermato e in attesa di byte che non partiranno:
                // si ritira, o aspetterebbe la ritenzione e poi avviserebbe di un video fallito.
                dimenticaJob(jobId);
                ritiraSenzaAspettare(intentId);
                return { ok: false, messaggio: fraseRef.current(messo.codice) };
            }
            if (!stessoContesto(c)) return { ok: false, messaggio: fraseRef.current('VIDEO_NON_AUTORIZZATO') };

            annullatiRef.current.delete(jobId);
            segnalatiRef.current.delete(jobId);

            // LO STESSO FILE RIMANDATO MENTRE IL SUO TRASFERIMENTO È IN CODA O IN VOLO (#134). L'apertura
            // ha ritrovato lo stesso job (stessa chiave, stessi bambini) e `accodaCaricamentoVideo` lo ha
            // lasciato com'era: la riga locale e il trasferimento sono già quelli giusti, con la loro barra.
            // Riscrivere lo stato a «in-fila» farebbe tornare la scheda a «in attesa del suo turno», senza
            // percentuale, mentre i byte corrono. Un job FERMO (`interrotto`, non in coda) invece sì: rimandarlo
            // è chiedere di riprendere, e riparte.
            const giaInCoda = inCodaRef.current.has(jobId) && jobId in localiRef.current;
            if (!giaInCoda) {
                scriviLocali((prec) => ({
                    ...prec,
                    [jobId]: {
                        jobId,
                        intentId,
                        nome: file.name,
                        creatoIl: messo.riga.creatoIl,
                        trasferimento: needsUpload ? 'in-fila' : 'concluso',
                        percentuale: null,
                        codice: null,
                        trasporto: 'tus',
                        nota: null,
                    },
                }));

                if (needsUpload) {
                    // NON si aspetta: da qui in poi il caricamento vive per conto suo e la schermata
                    // torna alla galleria, dove la scheda racconta a che punto è.
                    accodaTrasferimento(jobId);
                } else {
                    // I byte sono già sul server: si ferma la copia in background e si lascia l'archivio
                    // com'è — niente da rispedire — poi si dice al server («caricato», idempotente).
                    void (async () => {
                        await concludiCaricamentoVideo(dip, jobId);
                        await dopoTrasferimento(jobId, messo.riga.dimensioneByte, messo.riga.mime, c);
                    })().catch((err: unknown) => logErroreAzione('video-conclusione-locale-fallita', err));
                }
            }
            void caricaElenco();
            return { ok: true };
        },
        [
            accodaTrasferimento,
            caricaElenco,
            contesto,
            dimenticaJob,
            dipendenzePer,
            dopoTrasferimento,
            logErroreAzione,
            ritiraAperturaOrfana,
            ritiraSenzaAspettare,
            scriviLocali,
            stessoContesto,
        ],
    );

    /**
     * INVIARE UN VIDEO NATIVO (app 1.2, spec §7.4): apre l'intento col trasporto `put-nativo` e consegna al plugin ciò
     * che gli serve per spedire i byte dal sistema operativo.
     *
     * I passi sono quelli di `avviaVideo` — contesto, rifiuto locale, chiave, apertura con i bambini, intento già
     * concluso, schermata cambiata — e finiscono in un posto diverso: non c'è un `File` né una riga IndexedDB, c'è
     * `accodaVideo`. Un rifiuto dell'apertura (il 422 coi nomi, un 429, una rete caduta) torna alla schermata con il
     * video ancora nel passo dei bambini, e prima di quel momento non è partito un byte.
     *
     * Dopo l'apertura:
     *  · `needs_upload: false` — i byte sono GIÀ sullo Storage (un invio precedente è arrivato e la chiave deterministica
     *    l'ha ritrovato): la copia preparata non serve più (`scartaScelti`), la riga locale è «conclusa» e si dice «caricato»;
     *  · altrimenti `accodaVideo` con i campi della risposta (l'URL firmato, il `content-type` delle sue intestazioni, la
     *    scadenza dell'URL, il token di rinnovo, e gli indirizzi di rinnovo e di registro, composti dall'origine della pagina).
     *    Se il plugin rifiuta, l'intento si RITIRA (esiste già sul server, in attesa di byte che non partiranno), si scrive
     *    `video-nativo-accodamento-fallito: job=<uuid> <codice>` e il video resta nel passo dei bambini.
     *
     * Gli id verso il plugin sono in MINUSCOLO: lo schema li rifiuta altrimenti, e la sede letta dal cookie `sedi_attive`
     * può avere le maiuscole (secondario S1 n. 3).
     *
     * Dopo `accodaVideo` l'invio è del plugin: se nel frattempo la schermata è cambiata (smontata, altra sede) non si scrive
     * niente qui — e non si ritira niente, perché sta partendo davvero — e si risponde `ok`: ripresentarsi con lo stesso video
     * e gli stessi bambini ritrova lo stesso intento e ne ruota il token, senza un secondo invio.
     */
    const avviaVideoNativo = useCallback<ApiVideoGalleria['avviaVideoNativo']>(
        async (nativo, scelta) => {
            const c = contesto();
            // Una pagina già smontata non apre intenti: li ritirerebbe subito.
            if (!montatoRef.current) return { ok: false, messaggio: fraseRef.current('VIDEO_NON_AUTORIZZATO') };
            if (!c.sede || !c.owner) {
                // Come `avviaVideo`: NON si indovina il plesso.
                return { ok: false, messaggio: fraseRef.current('SEDE_DA_SPECIFICARE') };
            }
            const sede = c.sede;
            const owner = c.owner;

            const rifiuto = rifiutoLocaleVideo({ size: nativo.byte }, scelta.durataSecondi);
            if (rifiuto) return { ok: false, messaggio: fraseRef.current(rifiuto) };

            // I bambini di QUESTO invio, fissati una volta: sono nel corpo della POST e sono nella chiave.
            const destinatari = {
                tagAlunni: scelta.tag,
                broadcast: scelta.broadcast,
                classi: opzioniRef.current.classi,
            };
            const apri = (chiaveIdempotenza: string) =>
                apriIntentoVideoGalleriaNativo(fetch, {
                    file: { nome: nativo.nome, byte: nativo.byte, mime: nativo.mime, sha256: nativo.sha256 },
                    scuolaId: sede,
                    durataSecondi: scelta.durataSecondi,
                    chiaveIdempotenza,
                    destinatari,
                    ripiego: ripiegoRef.current,
                });
            const rifiutato = (esito: Extract<EsitoFlusso<unknown>, { ok: false }>): EsitoAvvio =>
                rifiutoDellApertura(esito, testoReteRef.current);

            // ⚠️ `gn1-`: deterministica, salata, e COI BAMBINI dentro (vedi `chiaveIdempotenzaVideoNativo`). Lo stesso video con
            // gli stessi bambini ritrova lo stesso intento e ne ruota il token; con altri bambini è un intento nuovo, mai un conflitto.
            let chiave = chiaveIdempotenzaVideoNativo({ byte: nativo.byte, sha256: nativo.sha256 }, destinatari);
            let apertura = await apri(chiave);
            if (!apertura.ok) return rifiutato(apertura);

            // La risposta è arrivata a schermata cambiata: l'intento esiste sul server e nessuno consegnerà i byte al plugin.
            // Un intento già concluso, invece, non è nostro e non si tocca.
            if (!stessoContesto(c)) {
                if (!intentoConcluso(apertura.dati)) {
                    ritiraAperturaOrfanaNativa(apertura.dati.intentId, apertura.dati.jobId, owner);
                }
                return { ok: false, messaggio: fraseRef.current('VIDEO_NON_AUTORIZZATO') };
            }

            // Lo stesso video con gli stessi bambini ritrova l'intento di prima; se quello è già finito riaprirlo non porta
            // da nessuna parte: è un invio nuovo, con un intento nuovo.
            if (intentoConcluso(apertura.dati)) {
                logClient({
                    livello: 'warn',
                    evento: 'caricamento-nativo',
                    messaggio: `video-nuovo-intento-dopo-concluso: job=${apertura.dati.jobId}`,
                    campi: { stato_intento: apertura.dati.statoIntent, stato_job: apertura.dati.statoJob, tipo: 'put-nativo' },
                });
                chiave = `${chiave}-${crypto.randomUUID()}`;
                apertura = await apri(chiave);
                if (!apertura.ok) return rifiutato(apertura);
                if (!stessoContesto(c)) {
                    ritiraAperturaOrfanaNativa(apertura.dati.intentId, apertura.dati.jobId, owner);
                    return { ok: false, messaggio: fraseRef.current('VIDEO_NON_AUTORIZZATO') };
                }
            }

            const { put, rinnovo, expiresAt, needsUpload } = apertura.dati;
            const jobId = apertura.dati.jobId.toLowerCase();
            const intentId = apertura.dati.intentId.toLowerCase();

            if (!needsUpload) {
                // I byte sono GIÀ sullo Storage: niente da spedire. La copia preparata non serve più, la riga locale è
                // «conclusa» (da qui la parola è del server) e si dice «caricato» (idempotente).
                annullatiRef.current.delete(jobId);
                void scartaPreparatiNativi([nativo.id]);
                scriviLocali((prec) => ({
                    ...prec,
                    [jobId]: {
                        jobId,
                        intentId,
                        nome: nativo.nome,
                        creatoIl: new Date().toISOString(),
                        trasferimento: 'concluso',
                        percentuale: null,
                        codice: null,
                        trasporto: 'nativo',
                        nota: null,
                    },
                }));
                segnalaCaricato(jobId, nativo.byte, nativo.mime, c);
                void caricaElenco();
                return { ok: true };
            }

            if (!put || !rinnovo) {
                // Non può succedere (`apriIntentoVideoGalleriaNativo` rifiuta una risposta senza URL o senza token), ma se
                // succede NON si spedisce a metà: si ritira l'intento e lo si dice.
                logClient({
                    livello: 'error',
                    evento: 'caricamento-nativo',
                    messaggio: `video-nativo-accodamento-fallito: job=${jobId} PARAMETRI_NON_VALIDI`,
                });
                ritiraSenzaAspettare(intentId);
                return { ok: false, messaggio: ripiegoRef.current };
            }

            const origine = window.location.origin;
            let voce: CaricamentoNativo;
            try {
                voce = await accodaVideoNativo({
                    idElemento: nativo.id,
                    sha256: nativo.sha256,
                    byteAttesi: nativo.byte,
                    jobId,
                    intentId,
                    utenteId: owner.toLowerCase(),
                    scuolaId: sede.toLowerCase(),
                    caricamento: { url: put.url, contentType: put.contentType, scadeIl: expiresAt },
                    rinnovo: { url: `${origine}/api/video-uploads/rinnovo`, token: rinnovo.token, scadeIl: rinnovo.scadeIl },
                    registro: { url: `${origine}/api/logs` },
                    testi: testiNotificheRef.current,
                });
            } catch (err) {
                // L'intento esiste già sul server, confermato e in attesa di byte che non partiranno: si ritira, o aspetterebbe
                // la ritenzione e poi avviserebbe di un video fallito. Il video resta nel passo dei bambini. Solo il CODICE
                // dell'elenco chiuso: mai il messaggio del ponte, né il nome del file.
                logClient({
                    livello: 'error',
                    evento: 'caricamento-nativo',
                    messaggio: `video-nativo-accodamento-fallito: job=${jobId} ${codiceDelPonte(err)}`,
                });
                ritiraSenzaAspettare(intentId);
                return { ok: false, messaggio: ripiegoRef.current };
            }

            // L'invio è del plugin da qui in poi: prosegue anche se la schermata cambia, o se si esce dall'account.
            annullatiRef.current.delete(jobId);
            if (stessoContesto(c)) {
                applicaVoceNativa(voce, c);
                void caricaElenco();
            }
            return { ok: true };
        },
        [
            applicaVoceNativa,
            caricaElenco,
            contesto,
            ritiraAperturaOrfanaNativa,
            ritiraSenzaAspettare,
            scriviLocali,
            segnalaCaricato,
            stessoContesto,
        ],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * GLI ALTRI GESTI
     * ──────────────────────────────────────────────────────────────────────── */

    const riprendi = useCallback(
        (jobId: string) => {
            // La ripresa a mano è del TUS: un invio nativo riprende da solo (rete, riapertura, notifica) e la pagina non ha un
            // gesto che lo sposti.
            const locale = localiRef.current[jobId];
            if (locale?.trasporto !== 'nativo' && locale?.trasferimento === 'interrotto') accodaTrasferimento(jobId);
        },
        [accodaTrasferimento],
    );

    /**
     * «RIMUOVI» / «TOGLI».
     *
     * L'ORDINE È LA CORREZIONE (#58): PRIMA si ferma il trasferimento — `annullaCaricamentoVideo`
     * chiude la sessione TUS e la copia in background — e DOPO si ritira l'intento. Col verso
     * opposto il server avrebbe un intento revocato mentre il telefono continuava a spedirgli
     * byte, e il trigger d'arrivo li avrebbe visti comparire su un job che non li voleva più.
     *
     * I BYTE GIÀ SUL SERVER NON HANNO NIENTE DA TERMINARE (#136): se il trasferimento è concluso la
     * sessione TUS non esiste più, e `annullaCaricamentoVideo` la «terminerebbe» lo stesso — una
     * `DELETE` che passa da `/firma`, trova il job fuori da `awaiting_upload`, prende 409 e lascia due
     * `warn` che non dicono niente. Qui la riga si marca annullata e si elimina, e basta.
     *
     * La scheda sparisce SUBITO, ma l'intento si RICORDA fra quelli tolti (il server lo riporta ancora
     * per una settimana, e un intento del flusso vecchio resta «da ricaricare» qualunque sia il suo
     * stato) SOLO quando il ritiro è riuscito (#141). Finché il server non ha confermato, la scheda è
     * nascosta soltanto a schermo; se il ritiro non riesce, o lancia, la scheda TORNA: l'intento è
     * ancora vivo, e un video in preparazione uscirebbe lo stesso in galleria mentre la persona lo
     * crede tolto.
     *
     * UN VIDEO NATIVO (app 1.2, spec §7.6) segue lo stesso ordine con le sue mani: PRIMA `annulla` del plugin (si fermano i
     * byte, si cancellano copia e segreti), POI il ritiro dell'intento, e dopo il ritiro riuscito la voce terminale si
     * `dimentica`. Se i byte NON si riescono a fermare l'intento non si ritira — i byte potrebbero ancora correre su un job
     * revocato — e la scheda torna, riprendendo il racconto del plugin. Un `annulla` che risponde «niente da annullare»
     * (la voce era già terminale) non è un guasto: il ritiro prosegue.
     */
    const rimuovi = useCallback(
        (jobId: string) => {
            const c = contesto();
            if (!c.owner || !c.sede) return;
            const owner = c.owner;
            const locale = localiRef.current[jobId];
            const voce = vociRef.current?.find((v) => v.jobId === jobId);
            const intentId = locale?.intentId ?? voce?.intentId;
            if (!intentId) return;
            const nativo = locale?.trasporto === 'nativo';

            annullatiRef.current.add(jobId);
            // Sparisce a schermo (`inRitiro`), ma non entra fra i `nascosti` finché il server non conferma: vedi sopra.
            setInRitiro((prec) => new Set(prec).add(intentId));
            togliLocale(jobId);
            const archivio = archivioRef.current;
            const dip = locale && !nativo ? dipendenzePer(jobId, intentId) : null;
            const byteGiaSulServer = locale?.trasferimento === 'concluso';

            void (async () => {
                let ritirato = false;
                try {
                    if (nativo) {
                        // PRIMA i byte (regola #58). Un rifiuto del plugin interrompe tutto: il ritiro non parte.
                        try {
                            await annullaVideoNativo({ jobId: jobId.toLowerCase() });
                        } catch (err) {
                            logClient({
                                livello: 'error',
                                evento: 'caricamento-nativo',
                                messaggio: `video-nativo-annulla-fallito: job=${jobId} ${codiceDelPonte(err)}`,
                            });
                            throw err;
                        }
                    } else if (archivio && dip) {
                        if (byteGiaSulServer) {
                            // Nessun trasferimento da fermare: se la riga non si marca (archivio che non risponde) il
                            // ritiro dell'intento — che è ciò che conta — parte lo stesso, e il guasto si registra.
                            await archivio
                                .aggiorna(jobId, { stato: 'annullato', codice: null, aggiornatoIl: new Date().toISOString() })
                                .catch((err: unknown) => logErroreAzione('video-riga-locale-non-annullata', err));
                        } else {
                            // Chiude il lato CLIENT: ferma TUS e copia, e termina la sessione TUS se è aperta,
                            // così nel bucket non resta un troncone che nessuno cerca.
                            await annullaCaricamentoVideo(dip, jobId);
                        }
                    }
                    ritirato = await ritiraIntento(intentId);
                    if (nativo) {
                        // Intento ritirato: la voce (annullata, o terminale) non serve più. Un guasto qui è un ritardo — la
                        // pulizia del plugin la toglie dopo 7 giorni — e non cambia l'esito.
                        if (ritirato) {
                            await dimenticaVideoNativi({ jobIds: [jobId.toLowerCase()] }).catch((err: unknown) =>
                                logClient({
                                    livello: 'warn',
                                    evento: 'caricamento-nativo',
                                    messaggio: `video-nativo-dimentica-fallito: ${codiceDelPonte(err)}`,
                                }),
                            );
                            vociNativeRef.current.delete(jobId);
                        }
                    } else if (archivio && locale) {
                        await archivio.elimina(jobId);
                    }
                    dimenticaJob(jobId);
                } finally {
                    // Il verdetto c'è: l'attesa finisce comunque. Se il server ha confermato l'intento passa fra i
                    // `nascosti` (e si ricorda: la scheda non torna, nemmeno dopo un ricaricamento); altrimenti
                    // esce da `inRitiro` e la scheda TORNA, perché l'intento è ancora vivo.
                    let ricordati: ReadonlySet<string> = new Set();
                    if (ritirato) {
                        ricordati = nascondiIntento(owner, intentId);
                    } else {
                        logClient({
                            livello: 'warn',
                            // La storia di un video nativo sta tutta in `client:caricamento-nativo` (spec §8.1).
                            evento: nativo ? 'caricamento-nativo' : 'fetch',
                            messaggio: `video-ritiro-non-riuscito: job=${jobId}`,
                        });
                        // Un invio nativo non si è ritirato (i byte non si sono fermati, o il server ha rifiutato): la voce del
                        // plugin torna a raccontarlo, e la rilettura la riporta a schermo.
                        if (nativo) {
                            annullatiRef.current.delete(jobId);
                            void caricaElencoRef.current();
                        }
                    }
                    if (stessoContesto(c)) {
                        if (ritirato) setNascosti((prec) => new Set([...prec, ...ricordati]));
                        setInRitiro((prec) => {
                            const dopo = new Set(prec);
                            dopo.delete(intentId);
                            return dopo;
                        });
                    }
                }
            })().catch((err: unknown) => logErroreAzione('video-annullamento-interrotto', err));
        },
        [contesto, dimenticaJob, dipendenzePer, logErroreAzione, ritiraIntento, stessoContesto, togliLocale],
    );

    const riprova = useCallback(
        (jobId: string) => {
            const voce = vociRef.current?.find((v) => v.jobId === jobId);
            if (!voce?.riprovaPossibile || riprovaInCorsoRef.current.has(jobId)) return;
            const c = contesto();
            riprovaInCorsoRef.current.add(jobId);
            segnalaMessaggioAzione(jobId, null);
            void (async () => {
                const esito = await riprovaPubblicazioneVideo(fetch, {
                    intentId: voce.intentId,
                    ripiego: ripiegoRef.current,
                });
                if (!stessoContesto(c)) return;
                // Un rifiuto dice perché («potrebbe essere già in galleria, oppure è passato troppo
                // tempo»): è l'unica risposta utile, e sta nella scheda finché non si rilegge l'elenco.
                if (!esito.ok) segnalaMessaggioAzione(jobId, esito.messaggio);
                await caricaElenco();
            })()
                .catch((err: unknown) => logErroreAzione('video-riprova-interrotta', err))
                .finally(() => {
                    riprovaInCorsoRef.current.delete(jobId);
                });
        },
        [caricaElenco, contesto, logErroreAzione, segnalaMessaggioAzione, stessoContesto],
    );

    /* ────────────────────────────────────────────────────────────────────────
     * IL RIENTRO NELLA PAGINA
     * ──────────────────────────────────────────────────────────────────────── */

    /**
     * Riprende, uno alla volta, ciò che è fermo. Risolve quando la coda si è svuotata: l'attesa
     * successiva della ripresa automatica conta da lì.
     */
    const riprendiInterrotti = useCallback(
        async (motivo: MotivoRipresa): Promise<void> => {
            // Senza rete non si tenta: ogni ripresa a vuoto lascerebbe una riga `error` (la firma che non
            // si riesce a chiedere) e un conto che non dice niente. Quando la rete torna lo dice `online`.
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            // Solo i trasferimenti TUS: un invio nativo fermo riprende da solo (rete, riapertura, notifica) e questa pagina non può spostarlo.
            const daRiprendere = Object.values(localiRef.current).filter(
                (l) => l.trasporto !== 'nativo' && l.trasferimento === 'interrotto' && !inCodaRef.current.has(l.jobId),
            );
            for (const locale of daRiprendere) {
                // Il motivo sta nel MESSAGGIO (e non solo nei campi): `app_log` conserva i campi della
                // prima occorrenza del giorno, e ciò che distingue un'occorrenza dall'altra deve stare
                // nell'impronta. Mai il nome del file.
                logClient({
                    livello: 'warn',
                    evento: 'offline',
                    messaggio: `video-ripresa-automatica: job=${locale.jobId} motivo=${motivo}`,
                    campi: { motivo },
                });
                accodaTrasferimento(locale.jobId);
            }
            await codaRef.current;
        },
        [accodaTrasferimento],
    );

    useEffect(() => {
        let vivo = true;
        const owner = opzioni.utenteId;
        const sede = opzioni.sede;
        void (async () => {
            await Promise.resolve();
            if (!vivo) return;
            scriviLocali(() => ({}));
            scriviVoci(null);
            setMessaggiAzione({});
            setInRitiro(new Set());
            dipRef.current.clear();
            trasportiRef.current.clear();
            firmeRef.current.clear();
            ultimaPercentualeRef.current.clear();
            attiviVistiRef.current.clear();
            pubblicatiRef.current.clear();
            segnalatiRef.current.clear();
            annullatiRef.current.clear();
            vociNativeRef.current.clear();
            dimenticatiNativiRef.current.clear();
            if (!owner || !sede) return;
            setNascosti(leggiNascosti(owner));
            const archivio = await creaArchivioCaricamenti();
            if (!vivo) return;
            archivioRef.current = archivio;
            await potaArchivioCaricamenti({ archivio, intestazioni: () => ({}) });
            const righe = (await archivio.elenca()).filter((r) => caricamentoNelContesto(r, owner, sede, 'gallery'));
            if (!vivo) return;
            const iniziali: Record<string, StatoLocale> = {};
            for (const riga of righe) {
                const stato = statoDaRiga(riga);
                if (stato) iniziali[riga.jobId] = stato;
            }
            // Le righe NATIVE già scritte (un evento del plugin arrivato mentre si leggeva l'archivio) non si perdono: l'archivio
            // IndexedDB non le conosce, e riscrivere tutto con le sole sue righe le cancellerebbe fino alla lettura successiva.
            scriviLocali((prec) => ({
                ...Object.fromEntries(Object.entries(prec).filter(([, l]) => l.trasporto === 'nativo')),
                ...iniziali,
            }));
            // Prima l'elenco (che dice a che punto è ciò che il server già sa), poi la ripresa.
            await caricaElenco();
            if (!vivo) return;
            void riprendiInterrotti('rientro');
        })().catch((err: unknown) => {
            logClient({
                livello: 'error',
                evento: 'offline',
                messaggio: 'video-archivio-non-disponibile',
                campi: { error_code: err instanceof Error ? err.name : 'Sconosciuto' },
            });
        });
        return () => {
            vivo = false;
        };
    }, [opzioni.utenteId, opzioni.sede, caricaElenco, riprendiInterrotti, scriviLocali, scriviVoci]);

    /* ────────────────────────────────────────────────────────────────────────
     * LE RIGHE, E I DUE OROLOGI
     * ──────────────────────────────────────────────────────────────────────── */

    const notaCaricamento = t('galleryVideoCaricamentoTus');
    const composte: RigaComposta[] = useMemo(
        () => fondiRighe({
            locali,
            voci,
            // Le schede tolte e confermate, più quelle tolte di cui si aspetta il verdetto: a schermo sono sparite insieme.
            nascosti: new Set([...nascosti, ...inRitiro]),
            messaggiAzione,
            frase,
            notaCaricamento,
            noteNativo,
            offline: !online,
        }),
        [locali, voci, nascosti, inRitiro, messaggiAzione, frase, notaCaricamento, noteNativo, online],
    );

    // Gli intenti visti in una fase attiva: una pubblicazione di uno di questi è una NOVITÀ. Si
    // scrive solo un ref, quindi niente `setState` in un effetto.
    useEffect(() => {
        for (const riga of composte) {
            if (FASI_UI_ATTIVE.has(riga.fase)) attiviVistiRef.current.add(riga.intentId);
        }
    }, [composte]);

    const attivo = composte.some((r) => FASI_UI_ATTIVE.has(r.fase));
    const contestoNoto = Boolean(opzioni.utenteId && opzioni.sede);

    // L'ELENCO: ogni 10 secondi mentre c'è qualcosa di attivo, e comunque al ritorno in primo piano
    // (`intervalloMs: null` = «solo al ritorno»): chi riapre l'app deve trovare i dati freschi, e
    // vedere un video mandato da un altro dispositivo. Mai a pagina nascosta.
    usePollingVisibile(() => caricaElencoRef.current(), attivo ? RITMO_ELENCO_MS : null, { attivo: contestoNoto });

    // LA RIPRESA: finché c'è un trasferimento fermo, da sola — ritorno in primo piano, rete che
    // torna, e un'attesa crescente di 5, 15, 30, 60 secondi. Ogni tentativo porta la riga a
    // «caricamento» e poi di nuovo a «interrotto»: il conto dei tentativi sta nell'hook della ripresa
    // e non riparte da capo a ogni giro; lo azzerano le notizie (rete tornata, ritorno in primo
    // piano, un trasferimento arrivato in fondo: `azzeraRipresaRef`).
    // Solo i trasferimenti TUS: un invio nativo fermo riprende da solo, e armare la ripresa per lui sarebbe un orologio che non può fare niente.
    const ripresa = useRipresaAutomatica({
        attiva: composte.some((r) => r.fase === 'interrotto' && r.trasporto !== 'nativo'),
        riprendi: riprendiInterrotti,
    });
    useEffect(() => {
        azzeraRipresaRef.current = ripresa.azzera;
    }, [ripresa.azzera]);

    // GLI EVENTI DEL PLUGIN (app 1.2): ogni cambio di una voce della coda nativa arriva qui senza aspettare il prossimo
    // giro dell'elenco — la percentuale si muove, un «in attesa di rete» compare quando la rete cade. Si ascolta solo se il
    // plugin c'è, e solo con un utente e una sede (le voci di un'altra sede o di un altro utente le scarta `applicaVoceNativa`).
    // L'ascolto si toglie allo smontaggio e al cambio di utente o di sede: gli eventi arrivano comunque a chiunque ascolti.
    useEffect(() => {
        const owner = opzioni.utenteId;
        const sede = opzioni.sede;
        if (!owner || !sede) return;
        const c: Contesto = { owner, sede };
        let vivo = true;
        let togliAscolto: (() => Promise<void>) | null = null;
        const logAscolto = (err: unknown) =>
            logClient({
                livello: 'warn',
                evento: 'caricamento-nativo',
                messaggio: `video-nativo-ascolto-fallito: ${codiceDelPonte(err)}`,
            });
        void (async () => {
            if (!(await pluginNativoPresente()) || !vivo) return;
            try {
                const togli = await ascoltaCaricamenti((voce) => {
                    if (vivo) applicaVoceNativaRef.current(voce, c);
                });
                // Smontato mentre il plugin rispondeva: l'ascolto appena agganciato si toglie subito.
                if (vivo) togliAscolto = togli;
                else await togli();
            } catch (err) {
                logAscolto(err);
            }
        })().catch(logAscolto);
        return () => {
            vivo = false;
            if (togliAscolto) void togliAscolto().catch(logAscolto);
        };
    }, [opzioni.utenteId, opzioni.sede]);

    const righe: RigaVideoLavorazione[] = composte;

    return { righe, avviaVideo, avviaVideoNativo, riprendi, rimuovi, riprova };
}

