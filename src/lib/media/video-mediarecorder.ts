import { logClient, nomeErrore } from '@/lib/logging/client';
import { VideoConversionError } from './processing';
import type { MisuraConversione } from './integrita-video';

/**
 * LA CONVERSIONE VIDEO LATO CLIENTE — e il motivo per cui questo file è tutto sull'orchestrazione.
 *
 * Ridisegna il video su una tela (watermark + 720p), ne cattura lo stream insieme alla traccia
 * audio originale e lo ri-registra con `MediaRecorder`. Il difficile non è nessuno di questi
 * tre passaggi: è accorgersi quando uno dei tre cede A METÀ.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO, MISURATO IN PRODUZIONE (settembre 2026)
 *
 * Il log `gallery-video-conversione-fallita` — quello che la pagina della galleria scrive
 * quando questa funzione rigetta — ha **ZERO righe in tutta `app_log`**. Non perché su iOS
 * vada tutto bene: `traccia-audio-non-catturata` ne ha quattro, tutte iOS. Significa che su
 * iOS questa funzione **non rigettava mai**, e ogni guasto usciva sotto forma di FILE.
 *
 * Il titolare, da iPhone: «si ferma ad un certo punto, e mostra lo stesso frame fino alla fine
 * del video, ed è muto». Un file così ha durata giusta, container giusto, peso giusto:
 * `validateVideoFile` guarda `type` e `size` e li trova in ordine. Il primo a scoprirlo è il
 * genitore che apre la galleria.
 *
 * Le tre cause, misurate in WebKit (il motore di Safari e della WebView iOS):
 *
 *  1. `new AudioContext().state` appena creato è **`"suspended"`**, e nessuno chiamava
 *     `resume()`. Un contesto sospeso non fa passare campioni: il file esce muto.
 *  2. `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')` è **`true`**: la forma
 *     CON il codec audio c'era, e si chiedeva quella senza — un container che non dichiara una
 *     traccia audio non la scrive.
 *  3. iOS **sospende `requestAnimationFrame`** quando l'app non è in primo piano. Il ciclo di
 *     disegno si ferma, `captureStream` continua a emettere l'ULTIMA tela disegnata, e il file
 *     esce di durata PIENA e congelato. La chiusura dipendeva solo da quel ciclo, e
 *     `video.onended` non era nemmeno agganciato.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * LE DUE REGOLE DI STRUTTURA CHE TENGONO IN PIEDI IL RESTO
 *
 * **UNA SOLA CHIUSURA, IDEMPOTENTE** (`chiudi`). Prima ce n'erano cinque, ognuna con la sua
 * copia della pulizia, e si sovrapponevano: `play()` che rigettava chiamava `fallisci` DOPO che
 * `start()` era già partito — registratore vivo su uno stream morto, `onstop` che chiamava
 * `resolve` su una promise già rigettata, AudioContext e object URL liberati DUE volte. Adesso
 * ogni strada passa da `chiudi`, che alza il flag `concluso` per prima cosa: ferma il
 * registratore, chiude l'audio, revoca l'URL e stacca gli ascoltatori **una volta sola**.
 *
 * **QUATTRO CHIUSURE INDIPENDENTI**, perché nessuna delle quattro è affidabile da sola:
 *   (a) `video.onended` — la fine normale, che prima non era agganciata;
 *   (b) un **watchdog** ogni 500 ms sul PROGRESSO (non sulla durata: vedi sotto);
 *   (c) `visibilitychange → hidden` **e** `App.appStateChange({isActive:false})` — su iOS
 *       arrivano davvero, 2.426 e 3.316 occorrenze in 7 giorni;
 *   (d) un `try/catch` **dentro** il disegno: un'eccezione lì (per esempio `wm.width === 0`,
 *       che rende `wmHeight` un `NaN` e fa lanciare `drawImage`) uccideva il ciclo in silenzio
 *       e lasciava la promise **appesa per sempre**. Non c'è nessun timeout a valle: appesa per
 *       sempre significa che l'insegnante guarda uno spinner finché non chiude l'app.
 *
 * **IL WATCHDOG È ARMATO DAL PRIMO ISTANTE ALL'ULTIMO** — ed è la correzione del secondo giro,
 * 2026-09-12. Le quattro chiusure qui sopra confluiscono TUTTE in `consegna()` o in `chiudi()`:
 * se il tratto sorvegliato non copre l'intera corsa, «quattro chiusure» non sono quattro reti,
 * sono quattro ingressi nella stessa rete, con dei buchi prima e dopo. Ne sono stati MISURATI
 * tre, ognuno con una sonda che ha visto la promise **pendente**:
 *
 *   · **prima del `<video>`**: `new Image()` non ha nessun tetto, e una richiesta appesa nella
 *     WebView non consegna né `load` né `error` — non partiva NIENTE, per sempre. Scaduta
 *     l'attesa si converte SENZA watermark, che è già ciò che fa `wm.onerror`: un logo mancante
 *     non è un video perso;
 *   · **fra `el.src` e `loadedmetadata`**: il decoder che non apre il file e non lancia. È il
 *     caso che il commento di `el.onerror` descrive da sempre per l'HEVC («`onloadedmetadata`
 *     non scatta mai»), e l'unica uscita era proprio `el.onerror`, cioè ciò che su iOS non è
 *     affidabile → `metadati-mancanti`;
 *   · **dopo `registratore.stop()`**: `onstop` che non arriva mai. Era il buco più nuovo — lo
 *     apriva la sequenza `play → primo fotogramma → disegna → start` di questo stesso giro — e
 *     il guard `consegnaChiesta` rendeva il watchdog CIECO proprio lì: al tick successivo
 *     entrava nel ramo `ended` → `consegna()` → uscita immediata, senza mai arrivare al
 *     controllo dello stallo → `registratore-stop-senza-onstop`.
 *
 * Perciò il watchdog non ha fasi implicite e non nasce a metà strada: nasce **prima** di chiedere
 * il logo e ha UN controllo (`controllo`) che il codice SOSTITUISCE a ogni passo — logo,
 * metadati, preparazione, primo fotogramma, progresso — più la sorveglianza dell'ultimo anello,
 * la consegna. Ogni scadenza porta il suo `punto`, cioè la sua colonna in `app_log`: su questo
 * file la colonna È il dato, e un guasto contato in quella accanto è un dato sbagliato.
 *
 * ⚠️ **NESSUN TETTO DI DURATA**, ed è una decisione del titolare: «il video deve caricarsi
 * sempre». Un tetto sui secondi rifiuterebbe il video lungo di un saggio, che è legittimo. Il
 * watchdog guarda il PROGRESSO — si disegna ancora? il tempo del video avanza ancora? — e non
 * il totale.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * COSA QUESTO FILE NON FA, E CHI LO FA
 *
 * NON decide se la conversione è integra: quella decisione è aritmetica, pura e testabile senza
 * browser, e vive in `verificaIntegrita` (`./integrita-video`). Qui si MISURA e si consegna la
 * misura al chiamante (vedi `MisuraConversioneVideo` e `opzioni.onMisura`); a chiamare il
 * cancello è chi orchestra il caricamento, che è anche il solo che sappia risolvere la durata
 * del file PRODOTTO (`MediaRecorder` consegna `duration === Infinity` finché non si forza un
 * seek).
 */

/** I fps a cui si cattura la tela. È il `25` di `captureStream(25)`, e serve a chi conta i fotogrammi. */
const FPS_TELA = 25;

/**
 * Il timeslice di `start()`, in millisecondi.
 *
 * Senza argomento `MediaRecorder` emette **un solo `ondataavailable`, alla fine**: se la WebView
 * viene uccisa (memoria, chiamata in arrivo, l'utente che cambia app) si perde tutto il girato.
 * Con il timeslice i pezzi si accumulano e ciò che è stato registrato resta registrato.
 */
const TIMESLICE_MS = 1_000;

/** Ogni quanto il watchdog guarda se qualcosa si muove ancora. */
const WATCHDOG_MS = 500;

/**
 * Quanto si concede a un fermo prima di chiamarlo guasto.
 *
 * Tre secondi sono molto più di un singolo fotogramma perso (a 25 fps un fotogramma è 40 ms) e
 * molto meno del tempo che serve a un insegnante per capire che l'app è piantata. Sotto questa
 * soglia si tollera lo sfarfallio di una WebView che rallenta; sopra, non è più rallentamento.
 */
const STALLO_MS = 3_000;

/**
 * Quanto si aspetta il PRIMO fotogramma prima di arrendersi.
 *
 * Serve perché la sequenza corretta (`await play()` → attendi il primo fotogramma → disegna →
 * `start()`) introduce un'attesa che, se il fotogramma non arriva mai, non finisce mai. Dieci
 * secondi sono larghi di proposito: i metadati sono già stati letti e `play()` ha già risolto,
 * quindi il decoder ha solo da consegnare un fotogramma. Un valore stretto qui rifiuterebbe
 * video sani su telefoni lenti, ed è il modo più rapido di far disattivare un cancello.
 */
const ATTESA_PRIMO_FOTOGRAMMA_MS = 10_000;

/**
 * Quanto si aspetta il LOGO prima di convertire senza.
 *
 * `new Image()` non ha nessun tetto di suo: una richiesta appesa non consegna né `load` né
 * `error`, e prima di questo giro bastava a non far partire niente. Scaduta l'attesa NON si
 * rigetta — si prosegue senza watermark, esattamente come fa `wm.onerror`, perché un logo
 * mancante non è un video perso (è la stessa scelta di `disegnaWatermark` per le foto). Dieci
 * secondi per un PNG dell'origine locale (sul nativo è dentro il bundle) sono una richiesta
 * ferma, non una lenta.
 */
const ATTESA_WATERMARK_MS = 10_000;

/**
 * Quanto si aspetta `loadedmetadata` dopo aver assegnato `el.src`.
 *
 * È il tratto in cui il decoder apre il file. Su un HEVC/.mov che Chrome/Android non sanno
 * decodificare l'evento non scatta MAI, e l'unica uscita era `el.onerror` — che c'è quando il
 * decoder DICHIARA di non farcela, e non quando resta lì. Venti secondi sono larghi perché il
 * file è locale ma può essere grande e il telefono lento: qui un falso rifiuto significherebbe
 * scartare un video sano, e un cancello che rifiuta il lavoro buono viene disattivato in due
 * giorni.
 */
const ATTESA_METADATI_MS = 20_000;

/**
 * Quanto si concede alla PREPARAZIONE (dai metadati a `play()` risolta).
 *
 * Dentro ci sono il grafo Web Audio, `audioCtx.resume()` e `el.play()`: tutte e tre `Promise`
 * che su iOS possono restare pendenti invece di rigettare — un contesto audio che non ottiene il
 * permesso di suonare non risponde. Il punto è suo (`preparazione-in-stallo`) e non
 * `primo-fotogramma-mancante`: sono due guasti diversi e due colonne diverse.
 */
const ATTESA_PREPARAZIONE_MS = 15_000;

/**
 * Quanto si aspetta `onstop` dopo aver chiesto la consegna.
 *
 * È l'ULTIMO anello, quello che nessuna delle quattro chiusure sorvegliava: tutte chiamano
 * `stop()` e poi si affidano a `onstop` per assemblare. Se non arriva, la conversione è finita
 * bene e nessuno lo saprà mai. Quindici secondi sono generosi di proposito, e in questa
 * direzione la generosità è la scelta prudente: qui un falso scatto butterebbe via una
 * conversione RIUSCITA, mentre ciò che il tetto previene è un'attesa infinita, che tanto non
 * finisce comunque.
 */
const ATTESA_ONSTOP_MS = 15_000;

/** Il bitrate audio richiesto: senza, il container può nascere senza spazio per la voce. */
const BITRATE_AUDIO_BPS = 128_000;

/** Il lato lungo massimo della tela: 720p è il compromesso fra qualità e tempo di elaborazione. */
const MAX_DIM = 720;

/**
 * I MIME CANDIDATI, IN ORDINE, E TUTTI CON IL CODEC AUDIO DAVANTI.
 *
 * ⚠️ È la correzione della causa n. 2. Prima l'elenco dichiarava solo il codec VIDEO
 * (`video/mp4;codecs=avc1`), e un container che non dichiara una traccia audio non la scrive:
 * l'audio arrivava fino allo stream e si perdeva nel file. Misurato in WebKit:
 * `isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')` è `true`, cioè la forma giusta era
 * disponibile da sempre.
 *
 * L'ordine: prima il profilo H.264 esatto (`avc1.42E01E`, Baseline 3.0 — quello che apre su
 * tutto), poi la forma generica, poi webm con Opus, e solo ULTIME le forme di solo video. Le
 * ultime restano perché un file muto è comunque meglio di nessun file, ma ci si arriva soltanto
 * quando il dispositivo non sa scrivere nient'altro — e a valle il cancello di integrità vede
 * che l'audio è sparito.
 *
 * ⚠️ NON si tocca la normalizzazione del MIME a valle (`mimeBase` in `@/lib/gallery/limiti`):
 * il tipo che esce da qui porta il suffisso codec, e il 2026-09-08 un confronto per uguaglianza
 * su quel suffisso ha fermato TUTTI i video della galleria — 33 tentativi, 8 insegnanti, 3 sedi.
 * Era la seconda volta.
 */
const CANDIDATI_MIME = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/mp4;codecs=avc1',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
];

/**
 * LA MISURA DELLA CONVERSIONE, per il cancello di integrità.
 *
 * ⚠️ ESTENDE un `Pick` di `MisuraConversione` (`./integrita-video`) invece di ripeterne i nomi:
 * è un import di solo TIPO, quindi non trascina niente a runtime e non sfiora la purezza di
 * quel modulo — ma impedisce che i quattro campi condivisi divergano nel nome o nel tipo. Un
 * campo che qui si chiamasse `fotogrammiUnici` e là `fotogrammiDistinti` sarebbe un cancello
 * alimentato con `undefined`, cioè un cancello aperto.
 *
 * COSA NON C'È DENTRO, e perché resta del chiamante:
 *
 *  - **`durataUscitaS`**: `MediaRecorder` consegna `duration === Infinity` finché non si forza
 *    un seek sul blob prodotto. Risolverla richiede un secondo elemento `<video>` e un giro di
 *    eventi: è un lavoro dell'orchestratore del caricamento, non della conversione.
 *  - **`tracciaAudioIngresso`**: l'elemento video non espone in modo portabile la presenza di
 *    una traccia audio (`audioTracks` è di Safari, `mozHasAudio` di Firefox, su Chrome non c'è
 *    niente). Serve una sonda esplicita, e in sua mancanza `integrita-video` dice cosa fare:
 *    `false` da ENTRAMBI i lati, cioè regola dell'audio spenta. Mai `true` a indovinare — un
 *    video girato in silenzio verrebbe rifiutato, e un falso rifiuto è ciò che fa disattivare
 *    un cancello.
 *
 * `audioCatturato` è l'unica cosa che questo file sa dell'audio: la cattura Web Audio è
 * riuscita. Da esso si deduce `tracciaAudioUscita`, ma con una cautela — dal 2026-09-12 una
 * cattura fallita **interrompe** la conversione, quindi su un file consegnato è sempre `true`.
 * Non è quindi un segnale utile a distinguere un muto: quello lo dice `tracciaAudioIngresso`.
 */
export interface MisuraConversioneVideo
    extends Pick<
        MisuraConversione,
        'durataIngressoS' | 'byteUscita' | 'fotogrammiAttesi' | 'fotogrammiDistinti'
    > {
    /** I fps a cui la tela è stata catturata: `fotogrammiAttesi = durata × fps`. */
    fpsTela: number;
    /** La cattura Web Audio è riuscita (⇒ `tracciaAudioUscita`). Vedi la nota qui sopra. */
    audioCatturato: boolean;
    /** Il MIME del file prodotto, **con il suffisso codec**: normalizzare con `mimeBase`. */
    mimeUscita: string;
    /** Quanto è durata la conversione, in millisecondi. Diagnostica, non un criterio. */
    msConversione: number;
}

export interface OpzioniConversioneVideo {
    /**
     * Quando `true`, ogni anello che cede diventa un `reject(VideoConversionError)`. Serve ai
     * video HEVC/.mov, che NON sono riproducibili da Chrome/Android: consegnare l'originale
     * sarebbe consegnare un video rotto in bacheca. Senza l'opzione il comportamento LEGACY
     * resta identico (ripiego sull'originale = `resolve(file)`).
     */
    obbligatoria?: boolean;
    /**
     * Riceve la misura della conversione, **una volta sola e solo quando si consegna un file
     * convertito**. Sul ripiego all'originale non viene chiamata: non c'è niente da misurare, e
     * passare una misura finta al cancello di integrità è peggio che non passarne nessuna.
     *
     * È un callback e non un secondo valore di ritorno perché la firma `Promise<File>` è
     * pubblica e usata dalla pagina della galleria: cambiarla in `Promise<{file, misura}>`
     * avrebbe rotto ogni chiamante e ogni test esistente per un dato che serve a uno solo.
     */
    onMisura?: (misura: MisuraConversioneVideo) => void;
}

/** Un avviso di servizio: un ramo che non interrompe la conversione ma non deve essere muto. */
function avvisa(messaggio: string, causa: unknown): void {
    logClient({
        livello: 'warn',
        evento: 'js',
        messaggio,
        campi: { error_code: nomeErrore(causa) },
    });
}

/** `true` se si gira dentro la shell nativa Capacitor. */
function eNativo(): boolean {
    try {
        // Si legge il BRIDGE dal globale invece di importare `@capacitor/core`: questo modulo
        // viene valutato anche durante il prerender, dove quell'import non ha un bridge sotto.
        // È lo stesso motivo (e la stessa forma) della sonda `piattaforma` in `logging/client`.
        const bridge = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
        return typeof bridge?.isNativePlatform === 'function' ? bridge.isNativePlatform() === true : false;
    } catch (err) {
        avvisa('gallery-video-bridge-nativo-illeggibile', err);
        return false;
    }
}

/**
 * Applica il watermark del logo al video e lo comprime se necessario per rientrare nei limiti
 * di peso. Vedi la testata del file per il perché di ogni chiusura.
 */
export function processVideoWithWatermark(
    file: File,
    watermarkUrl: string = '/watermark.png',
    maxSizeBytes: number = 50 * 1024 * 1024,
    opzioni?: OpzioniConversioneVideo
): Promise<File> {
    return new Promise<File>((resolve, reject) => {
        /** Lo stato che sopravvive a tutte le fasi, perché il log e la misura lo leggono da ogni chiusura. */
        const misurato = {
            t0: Date.now(),
            /** `video.duration` GREZZO: se è `NaN`/`Infinity` lo dice, invece di inventare un 10. */
            durataIngressoS: NaN,
            fotogrammiAttesi: 0,
            fotogrammiDistinti: 0,
            audioCatturato: false,
            mimeUscita: '',
        };

        type Conclusione =
            | { tipo: 'convertito'; convertito: File; byteUscita: number }
            | { tipo: 'interrotta'; punto: string; causa?: unknown };

        /** Le risorse da liberare UNA volta sola, dichiarate qui perché `chiudi` è una sola. */
        let objectUrl: string | null = null;
        let video: HTMLVideoElement | null = null;
        let mediaRecorder: MediaRecorder | null = null;
        let audioCtx: AudioContext | null = null;
        let watchdog: ReturnType<typeof setInterval> | null = null;
        let staccaVisibilita: (() => void) | null = null;
        let staccaNativo: (() => void) | null = null;
        /**
         * Stacca (e risolve) l'attesa del primo fotogramma. Esiste perché quando è il watchdog a
         * chiudere, i tre ascoltatori `loadeddata`/`seeked`/`timeupdate` restavano agganciati
         * all'elemento e `preparaEAvvia` restava sospesa PER SEMPRE, tenendo in vita per
         * riferimento elemento, tela e chiusure: una perdita per ogni video rifiutato su quel
         * punto, su un dispositivo che di memoria ne ha poca. È lo stesso genere di «resta
         * agganciato» che il codice già si preoccupa di evitare per l'ascoltatore nativo.
         */
        let staccaPrimoFotogramma: (() => void) | null = null;

        /** Il flag che rende `chiudi` idempotente: prima cosa che si alza, ultima che si legge. */
        let concluso = false;
        /** La chiusura NORMALE è già stata chiesta: `stop()` non si chiama due volte. */
        let consegnaChiesta = false;
        /**
         * QUANDO è stata chiesta. Non è diagnostica: è ciò che rende l'ultimo anello sorvegliato
         * come tutti gli altri. Con il solo booleano, il watchdog usciva subito e `onstop` che non
         * arriva era un'attesa infinita — misurata.
         */
        let msConsegnaChiesta: number | null = null;

        const fermaRegistratore = () => {
            const r = mediaRecorder;
            if (!r) return;
            try {
                if (r.state !== 'inactive') r.stop();
            } catch (err) {
                // `stop()` su un registratore in uno stato inatteso lancia `InvalidStateError`:
                // non cambia l'esito (si sta già chiudendo), ma tacerlo renderebbe invisibile un
                // dispositivo su cui il registratore si comporta diversamente dagli altri.
                avvisa('gallery-video-registratore-stop-fallito', err);
            }
        };

        /** Libera tutto, una volta sola. Chiamata SOLO da `chiudi`, che la avvolge in un `try`. */
        const pulisci = () => {
            fermaRegistratore();

            if (watchdog !== null) {
                clearInterval(watchdog);
                watchdog = null;
            }
            if (staccaVisibilita) {
                staccaVisibilita();
                staccaVisibilita = null;
            }
            if (staccaNativo) {
                staccaNativo();
                staccaNativo = null;
            }
            if (staccaPrimoFotogramma) {
                // Stacca i tre ascoltatori E risolve l'attesa, così `preparaEAvvia` arriva al suo
                // `if (concluso) return` e finisce invece di restare sospesa per sempre. La
                // ripresa avviene in una microtask, cioè dopo che questa chiusura è completa.
                const stacca = staccaPrimoFotogramma;
                staccaPrimoFotogramma = null;
                stacca();
            }
            if (video) {
                // Gli handler si staccano PRIMA della pausa: `pause()` può emettere eventi, e un
                // `error` in arrivo su un elemento già concluso non deve chiamare niente.
                video.onended = null;
                video.onerror = null;
                video.onplay = null;
                try {
                    video.pause();
                } catch (err) {
                    avvisa('gallery-video-pause-fallita', err);
                }
            }
            if (audioCtx) {
                void audioCtx.close().catch((err: unknown) => {
                    // Fail-open: un AudioContext che non si chiude non deve far fallire un
                    // caricamento riuscito. Ma non è muto — è così che si scopre una perdita di
                    // contesti audio su un dispositivo (Safari ne concede pochi per pagina).
                    avvisa('gallery-video-audiocontext-close-fallita', err);
                });
                audioCtx = null;
            }
            if (objectUrl !== null) {
                URL.revokeObjectURL(objectUrl);
                objectUrl = null;
            }
        };

        /**
         * L'UNICA uscita. Alza `concluso` per prima cosa, così ogni altra strada che arriva dopo
         * — `onstop` del registratore, un `error` dell'elemento, un tick del watchdog — trova la
         * porta chiusa e non libera una seconda volta né risolve una promise già rigettata.
         */
        const chiudi = (c: Conclusione) => {
            if (concluso) return;
            concluso = true;

            // ⚠️ LA PULIZIA STA DENTRO UN `try`, ed è l'ULTIMA strada che restava appesa: il
            // verdetto viene DOPO di lei, e `concluso` è già alzato. Un'eccezione qui — un
            // `revokeObjectURL` che lancia in una WebView, un ascoltatore che non si stacca —
            // lascerebbe la promise senza esito e nessun'altra strada potrebbe più chiuderla,
            // perché la porta è già chiusa per tutte. Una risorsa che non si libera è una
            // perdita; una promise che non si conclude è l'insegnante davanti a una rotellina
            // eterna. Fra i due si sceglie la perdita, e si logga.
            try {
                pulisci();
            } catch (err) {
                avvisa('gallery-video-pulizia-fallita', err);
            }

            const ms = Date.now() - misurato.t0;

            if (c.tipo === 'convertito') {
                // REGOLA 5 di AGENTS.md: anche il successo logga. Senza la riga del successo,
                // «nessun log» non distingue «la conversione funziona» da «non è mai partita» —
                // ed è letteralmente l'ambiguità che ha tenuto nascosto per mesi il guasto delle
                // email di credenziali. Il livello è `warn` perché il canale del client non ha
                // `info` (`/api/logs` lo rifiuta), non perché sia un guasto.
                logClient({
                    livello: 'warn',
                    evento: 'js',
                    messaggio: 'gallery-video-conversione-riuscita',
                    campi: {
                        ms,
                        fotogrammi: misurato.fotogrammiDistinti,
                        byte_in: file.size,
                        byte_out: c.byteUscita,
                        mime_out: misurato.mimeUscita,
                        audio: misurato.audioCatturato,
                    },
                });
                // Solo numeri, enumerati e MIME: il nome del file NON entra nella misura né nel
                // log. `IMG_bambina-rossi.mov` è anagrafica di un minore.
                opzioni?.onMisura?.({
                    durataIngressoS: misurato.durataIngressoS,
                    byteUscita: c.byteUscita,
                    fotogrammiAttesi: misurato.fotogrammiAttesi,
                    fotogrammiDistinti: misurato.fotogrammiDistinti,
                    fpsTela: FPS_TELA,
                    audioCatturato: misurato.audioCatturato,
                    mimeUscita: misurato.mimeUscita,
                    msConversione: ms,
                });
                resolve(c.convertito);
                return;
            }

            const ripiego = opzioni?.obbligatoria !== true;
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: 'gallery-video-conversione-interrotta',
                campi: {
                    punto: c.punto,
                    error_code: nomeErrore(c.causa),
                    durata_in_s: misurato.durataIngressoS,
                    ms,
                    fotogrammi_distinti: misurato.fotogrammiDistinti,
                    fotogrammi_attesi: misurato.fotogrammiAttesi,
                    ripiego,
                },
            });

            if (ripiego) resolve(file);
            else reject(new VideoConversionError(c.punto));
        };

        /** Il punto di fallimento. Dopo di lui non succede più niente: `chiudi` è definitiva. */
        const fallisci = (punto: string, causa?: unknown) => {
            chiudi({ tipo: 'interrotta', punto, causa });
        };

        if (typeof window === 'undefined' || !window.MediaRecorder) {
            return fallisci('mediarecorder-non-supportato');
        }

        /**
         * UN'ATTESA SORVEGLIATA: il controllo che scade se `tetto` ms passano senza andare avanti.
         *
         * È una FABBRICA e non un assegnamento perché `controllo` non deve avere un default
         * vuoto: un `() => {}` iniziale sarebbe un tratto di corsa senza sorveglianza, cioè
         * esattamente il difetto che questo giro chiude. Così il primo valore di `controllo` è
         * già un'attesa vera, e l'istante di partenza lo cattura la chiusura.
         */
        const attesa = (tetto: number, scaduta: () => void) => {
            const da = Date.now();
            return (ora: number) => {
                if (ora - da > tetto) scaduta();
            };
        };

        /**
         * La preparazione parte UNA volta sola. Le tre strade che la chiamano — `wm.onload`,
         * `wm.onerror` e la scadenza del logo — possono sovrapporsi (un `load` che arriva un
         * istante dopo la scadenza), e due elementi `<video>` sullo stesso object URL sarebbero
         * due registratori e una sola promise.
         */
        let preparazioneAvviata = false;
        const avviaPreparazione = (noWatermark: boolean) => {
            if (preparazioneAvviata || concluso) return;
            preparazioneAvviata = true;
            try {
                startProcessing(noWatermark);
            } catch (err) {
                // Gira dentro un gestore di evento del DOM (`wm.onload`) o dentro un tick del
                // watchdog: un'eccezione qui non la raccoglie nessuno — e il watchdog, che ha già
                // consumato l'attesa del logo, non tornerebbe mai a guardare questo tratto. Cioè
                // la promise resterebbe appesa con il timer che gira a vuoto.
                fallisci('avvio-preparazione-fallito', err);
            }
        };

        /** Cosa il watchdog sta guardando ADESSO. Lo sostituisce ogni passo, appena comincia. */
        let controllo = attesa(ATTESA_WATERMARK_MS, () => {
            logClient({ livello: 'warn', evento: 'js', messaggio: 'watermark-video-in-stallo' });
            avviaPreparazione(true);
        });

        // ── IL WATCHDOG, armato PRIMA di qualunque cosa possa non tornare ──────────────────
        //
        // Guarda due cose, e l'ordine fra le due è la parte che conta: prima l'ULTIMO anello (la
        // consegna chiesta e `onstop` che non arriva), e SOLO se non si è in quel tratto il
        // controllo del passo corrente. Il `return` non è cosmetico: dopo `stop()` la tela non si
        // disegna più — per forza, la registrazione è finita — e le regole del progresso, lasciate
        // accese, direbbero `canvas-congelato` tre secondi dopo su una conversione RIUSCITA (nel
        // ramo legacy: ripiego silenzioso sull'originale). Misurato con due mutanti: togliendo il
        // `return`, o mettendo il progresso davanti, un test diventa rosso.
        watchdog = setInterval(() => {
            if (concluso) return;
            const ora = Date.now();

            if (consegnaChiesta) {
                if (msConsegnaChiesta !== null && ora - msConsegnaChiesta > ATTESA_ONSTOP_MS) {
                    fallisci('registratore-stop-senza-onstop');
                }
                return;
            }

            controllo(ora);
        }, WATCHDOG_MS);

        // Carica prima il watermark
        const wm = new Image();

        wm.onload = () => {
            avviaPreparazione(false);
        };

        wm.onerror = () => {
            logClient({ livello: 'warn', evento: 'js', messaggio: 'watermark-video-non-caricato' });
            avviaPreparazione(true); // Esegui solo compressione senza watermark
        };

        wm.src = watermarkUrl;

        function startProcessing(noWatermark: boolean) {
            if (concluso) return;

            const el = document.createElement('video');
            video = el;
            objectUrl = URL.createObjectURL(file);
            el.src = objectUrl;
            // NON si silenzia l'elemento con la proprietà `muted`: farlo svuoterebbe anche la
            // traccia catturata via `createMediaElementSource` → i video convertiti uscirebbero
            // SENZA audio (era esattamente questo il bug). L'audio non arriva agli speaker perché
            // il grafo Web Audio (sotto) instrada l'elemento nella registrazione e NON in
            // `audioCtx.destination` (niente eco).
            el.playsInline = true;

            // Metadati illeggibili: è QUI che casca un HEVC/.mov su Chrome/Android — il decoder
            // non lo apre e `onloadedmetadata` non scatta mai. Con conversione obbligatoria è il
            // punto in cui si rigetta (niente originale non riproducibile in bacheca).
            // ⚠️ Viene RIASSEGNATO dentro `onloadedmetadata`: dopo i metadati lo stesso evento
            // significa un'altra cosa, e merita un punto di fallimento diverso.
            el.onerror = () => {
                fallisci('video-metadati-illeggibili');
            };

            // ⚠️ E QUESTO È IL TRATTO CHE NON AVEVA NESSUNA SORVEGLIANZA: se il decoder non apre
            // il file e non lancia — il caso dell'HEVC descritto due righe sopra — l'unica uscita
            // era l'`onerror` qui sopra, cioè ciò che su iOS non è affidabile. Misurato con una
            // sonda: nessun evento ⇒ promise pendente dopo dieci minuti simulati.
            controllo = attesa(ATTESA_METADATI_MS, () => fallisci('metadati-mancanti'));

            el.onloadedmetadata = () => {
                // ⚠️ PRIMA ISTRUZIONE, e la posizione è la sostanza: il significato di `error`
                // cambia NELL'ISTANTE in cui i metadati arrivano, non dieci righe dopo. Prima la
                // riassegnazione stava a metà di `preparaEAvvia`, dopo un `await` (il `resume`
                // dell'audio): un guasto del decoder che arrivasse in quella finestra finiva
                // contato come `video-metadati-illeggibili`, cioè nella colonna sbagliata di
                // `app_log` — e su questo file la colonna è il dato.
                el.onerror = () => {
                    fallisci('video-errore-durante-conversione');
                };
                controllo = attesa(ATTESA_PREPARAZIONE_MS, () => fallisci('preparazione-in-stallo'));

                // ⚠️ IL `catch` NON È DECORATIVO, ed è l'ultima porta che restava aperta. Da qui
                // in giù si gira dentro una funzione `async` che nessuno attende: un'eccezione
                // INATTESA (un `MediaRecorder.isTypeSupported` che non esiste, un getter del DOM
                // che lancia in una WebView vecchia) diventerebbe una promise rifiutata che
                // nessuno legge, e la conversione resterebbe appesa per sempre — lo stesso
                // guasto del `drawFrame` senza `try`, in un altro punto della catena.
                preparaEAvvia(el, noWatermark).catch((err: unknown) => {
                    fallisci('preparazione-fallita', err);
                });
            };
        }

        async function preparaEAvvia(el: HTMLVideoElement, noWatermark: boolean): Promise<void> {
            if (concluso) return;

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return fallisci('canvas-2d-non-disponibile');
            }

            // Cappa le dimensioni massime a 720p per bilanciare qualità e velocità di elaborazione client-side
            let width = el.videoWidth;
            let height = el.videoHeight;

            if (width > MAX_DIM || height > MAX_DIM) {
                if (width > height) {
                    height = Math.round((height * MAX_DIM) / width);
                    width = MAX_DIM;
                } else {
                    width = Math.round((width * MAX_DIM) / height);
                    height = MAX_DIM;
                }
            }

            canvas.width = width;
            canvas.height = height;

            // LA MISURA DELLA SORGENTE, prima di qualunque cosa possa fallire: se la conversione
            // si interrompe, il log deve poter dire su QUALE video si è interrotta.
            misurato.durataIngressoS = el.duration;
            const durataUtile = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
            // `fotogrammiAttesi: 0` è una DICHIARAZIONE DI ASSENZA che `verificaIntegrita`
            // tollera (la regola dei fotogrammi resta cieca, sotto c'è l'euristica dei byte).
            // Inventare un'attesa da una durata illeggibile sarebbe peggio: un cancello
            // alimentato con un numero finto.
            misurato.fotogrammiAttesi = Math.round(durataUtile * FPS_TELA);

            // Calcola il bitrate ideale
            const duration = durataUtile || 10;
            let bitrate = 2000000; // Bitrate di default alto (2.0 Mbps) per preservare qualità su video già leggeri

            if (file.size > maxSizeBytes) {
                // Se il file supera il limite, calcoliamo il bitrate target
                const targetSizeBits = maxSizeBytes * 0.85 * 8;
                bitrate = Math.floor(targetSizeBits / duration);
            }
            // ⚠️ QUESTA RIGA È SORVEGLIATA: `__tests__/lib/integrita-video.test.ts` la rilegge
            // per confrontare il `600000` con `BITRATE_MINIMO_BPS`, da cui `integrita-video`
            // calcola il pavimento dei byte. Cambiare il numero senza cambiare là fa rifiutare
            // video sani in silenzio: il lock diventa rosso prima.
            bitrate = Math.max(600000, Math.min(2500000, bitrate)); // Cappa tra 600kbps e 2.5mbps

            // ── L'AUDIO: due rami che consegnavano un muto, e adesso interrompono ──────────
            let audioTrack: MediaStreamTrack | null = null;
            try {
                const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
                if (!AudioContextClass) {
                    // Nessun Web Audio: la traccia audio non è catturabile affatto. Prima si
                    // proseguiva e si consegnava un muto.
                    return fallisci('audio-non-catturabile');
                }
                audioCtx = new AudioContextClass();
                const source = audioCtx.createMediaElementSource(el);
                const dest = audioCtx.createMediaStreamDestination();
                source.connect(dest);
                audioTrack = dest.stream.getAudioTracks()[0] || null;
            } catch (err) {
                // ⚠️ IL RAMO CHE CONSEGNAVA IL MUTO. Prima qui si faceva `video.volume = 0` e si
                // PROSEGUIVA senza traccia audio: il file usciva completo e muto, e l'unica
                // traccia era un `warn` che nessuno collegava al video sbagliato. In produzione
                // sono 4 occorrenze, tutte iOS. Adesso è un'interruzione, e il volume non si
                // tocca: non c'è nessuna riproduzione da silenziare, si sta smettendo.
                return fallisci('audio-non-catturabile', err);
            }

            if (!audioTrack) {
                return fallisci('audio-non-catturabile');
            }

            try {
                // ⚠️ MISURATO IN WEBKIT: `new AudioContext().state` è `"suspended"`. Un contesto
                // sospeso non fa passare campioni, e nessuno chiamava `resume()`: è metà del
                // «ed è muto» riferito dal titolare. Il `resume` è lecito qui perché la
                // conversione parte da un gesto dell'utente (il tocco su «Carica»).
                await audioCtx.resume();
            } catch (err) {
                return fallisci('audio-sospeso', err);
            }
            if (concluso) return;
            if (audioCtx.state !== 'running') {
                // Non si consegna un muto: meglio nessun file che un ricordo senza la voce del
                // bambino, e l'insegnante che riprova (o carica dal telefono di un collega).
                return fallisci('audio-sospeso');
            }
            misurato.audioCatturato = true;

            // ── LO STREAM DELLA TELA ──────────────────────────────────────────────────────
            let stream: MediaStream;
            try {
                const capturableCanvas = canvas as HTMLCanvasElement & { mozCaptureStream?: (fps?: number) => MediaStream };
                stream = capturableCanvas.captureStream ? capturableCanvas.captureStream(FPS_TELA) : capturableCanvas.mozCaptureStream!(FPS_TELA);
                stream.addTrack(audioTrack); // Unisci la traccia audio originale
            } catch (err) {
                return fallisci('capture-stream-fallito', err);
            }

            const mimeType = CANDIDATI_MIME.find((c) => MediaRecorder.isTypeSupported(c)) || 'video/webm';
            misurato.mimeUscita = mimeType;

            let registratore: MediaRecorder;
            try {
                registratore = new MediaRecorder(stream, {
                    mimeType,
                    videoBitsPerSecond: bitrate,
                    audioBitsPerSecond: BITRATE_AUDIO_BPS,
                });
            } catch (err) {
                avvisa('gallery-video-mediarecorder-opzioni-rifiutate', err);
                try {
                    registratore = new MediaRecorder(stream);
                } catch (err2) {
                    return fallisci('mediarecorder-init-fallito', err2);
                }
            }
            mediaRecorder = registratore;

            const chunks: Blob[] = [];
            registratore.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                    chunks.push(e.data);
                }
            };

            /** Assembla il file dai pezzi accumulati. Chiamata SOLO dalla chiusura normale. */
            const assembla = () => {
                const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
                if (blob.size === 0) {
                    // Un file di zero byte è la forma più pura del difetto per cui esiste questo
                    // giro: un involucro giusto e niente dentro. Non si consegna.
                    return fallisci('registrazione-vuota');
                }
                const ext = mimeType.includes('mp4') ? '.mp4' : '.webm';
                const processedFile = new File([blob], file.name.replace(/\.[^/.]+$/, "") + "_watermarked" + ext, {
                    type: blob.type,
                    lastModified: Date.now()
                });
                chiudi({ tipo: 'convertito', convertito: processedFile, byteUscita: blob.size });
            };

            // Il registratore può morire da solo: memoria esaurita, codifica che cede, traccia
            // che si stacca. Senza questo ramo la registrazione smetteva di produrre pezzi e il
            // ciclo di disegno continuava a girare come se niente fosse: alla fine si
            // consegnava ciò che era stato scritto prima del guasto — cioè un video TRONCO, che
            // è la variante silenziosa del difetto per cui esiste tutto questo giro.
            registratore.onerror = (e: Event) => {
                fallisci('registratore-errore', (e as unknown as { error?: unknown }).error);
            };

            registratore.onstop = () => {
                // Se si sta chiudendo per un fallimento, `chiudi` ha già alzato `concluso` e ha
                // chiamato lei `stop()`: qui non c'è niente da consegnare.
                //
                // ⚠️ QUESTO GUARD E QUELLO IN CIMA A `chiudi` SI COPRONO A VICENDA, e la misura
                // dice di non potarne nessuno: togliendone UNO la suite resta verde (l'altro
                // regge), togliendoli INSIEME diventa rossa in NOVE punti. Non è ridondanza: è
                // la ragione per cui un fallimento vince su una consegna in volo — `chiudi`
                // chiama `stop()`, quindi senza i due guard il `resolve` di questa riga
                // arriverebbe dopo il `reject`, cioè il video guasto tornerebbe a uscire come File.
                if (concluso) return;
                assembla();
            };

            /** La chiusura NORMALE: si chiede l'ultimo pezzo e si assembla in `onstop`. */
            const consegna = () => {
                if (concluso || consegnaChiesta) return;
                consegnaChiesta = true;
                // L'istante si segna SEMPRE, anche sul ramo che assembla subito: là la chiusura è
                // sincrona e il watchdog non ci arriva, ma un `msConsegnaChiesta` che dipende dal
                // ramo è un `null` che un giorno rende cieca la sorveglianza dell'ultimo anello.
                msConsegnaChiesta = Date.now();
                if (registratore.state === 'inactive') {
                    assembla();
                    return;
                }
                try {
                    registratore.stop();
                } catch (err) {
                    return fallisci('registratore-stop-fallito', err);
                }
            };

            // ── IL DISEGNO, e il contatore dei fotogrammi DISTINTI ────────────────────────
            let ultimoTempoDisegnato = -1;
            let ultimoDisegnoMs = Date.now();

            /**
             * Un disegno. Ritorna `false` se è fallito — e in quel caso la conversione è già
             * conclusa: prima un'eccezione qui uccideva il ciclo in silenzio e lasciava la
             * promise appesa **per sempre**.
             */
            const disegna = (): boolean => {
                try {
                    // 1. Disegna il frame video corrente nel canvas
                    ctx.drawImage(el, 0, 0, width, height);

                    // 2. Disegna sopra il watermark
                    if (!noWatermark) {
                        // Watermark proporzionato al 70% della larghezza del video
                        const wmWidth = width * 0.70;
                        const wmHeight = (wm.height * wmWidth) / wm.width;
                        // ⚠️ `wm.width === 0` (immagine decodificata a vuoto, capita) rende
                        // `wmHeight` un `NaN`, e `drawImage` con un `NaN` LANCIA. Il controllo è
                        // esplicito invece di affidarsi all'eccezione perché così il motivo è
                        // leggibile e non dipende da quale browser lanci cosa.
                        if (!Number.isFinite(wmHeight) || wmHeight <= 0 || !Number.isFinite(wmWidth)) {
                            throw new TypeError('geometria-watermark-non-finita');
                        }
                        const x = (width - wmWidth) / 2;
                        const y = height - wmHeight - (height * 0.05);

                        ctx.globalAlpha = 1.0;
                        ctx.drawImage(wm, x, y, wmWidth, wmHeight);
                    }

                    // ⚠️ SI CONTA IL FOTOGRAMMA NUOVO, NON IL GIRO. Il ciclo gira anche su un
                    // video fermo: un contatore di giri resterebbe perfetto proprio nel caso da
                    // prendere. Contando i tempi DIVERSI, una tela ferma inchioda il contatore —
                    // ed è la firma con cui `verificaIntegrita` riconosce il video congelato.
                    const t = el.currentTime;
                    if (t !== ultimoTempoDisegnato) {
                        ultimoTempoDisegnato = t;
                        misurato.fotogrammiDistinti += 1;
                    }
                    ultimoDisegnoMs = Date.now();
                    return true;
                } catch (err) {
                    fallisci('disegno-fallito', err);
                    return false;
                }
            };

            const drawFrame = () => {
                if (concluso) return;
                if (el.paused || el.ended) {
                    consegna();
                    return;
                }
                if (!disegna()) return;
                requestAnimationFrame(drawFrame);
            };

            // ── (c) L'APP CHE VA IN SECONDO PIANO ─────────────────────────────────────────
            //
            // Due segnali, non uno, e per lo stesso motivo di `use-polling-visibile`: dentro una
            // WebView Capacitor non è dato per scontato quale dei due arrivi. Misurati in 7
            // giorni su `app_log`: `visibilitychange` 2.426 occorrenze, `appStateChange` 3.316.
            //
            // ⚠️ NON si guarda lo stato INIZIALE, solo la TRANSIZIONE. Su iOS, subito dopo la
            // chiusura del selettore di foto nativo, lo stato può essere ancora `hidden` per un
            // istante: abortire su quello significherebbe rifiutare ogni caricamento fatto nel
            // modo normale. Se l'app è davvero in secondo piano e non torna, il fotogramma non
            // arriva e ci pensa il watchdog.
            const suVisibilita = () => {
                if (document.visibilityState === 'hidden') fallisci('app-in-background');
            };
            document.addEventListener('visibilitychange', suVisibilita);
            staccaVisibilita = () => document.removeEventListener('visibilitychange', suVisibilita);

            if (eNativo()) {
                void (async () => {
                    try {
                        const { App } = await import('@capacitor/app');
                        const h = await App.addListener('appStateChange', ({ isActive }) => {
                            if (!isActive) fallisci('app-in-background');
                        });
                        // La conversione può essere finita mentre l'import era in volo: senza
                        // questo controllo l'ascoltatore resterebbe agganciato, e il video
                        // SUCCESSIVO erediterebbe la chiusura di questo.
                        if (concluso) {
                            void h.remove();
                            return;
                        }
                        staccaNativo = () => {
                            void h.remove();
                        };
                    } catch (err) {
                        // Il plugin manca o il bridge non risponde: resta `visibilitychange`, che
                        // è il segnale standard. Non è silenzioso, così si sa su quale dei due
                        // ci si sta reggendo davvero.
                        avvisa('gallery-video-appstate-non-disponibile', err);
                    }
                })();
            }

            // ── (b) IL CONTROLLO DEL PROGRESSO, che il watchdog assume a registrazione avviata ─
            //
            // Guarda due cose, in QUESTO ordine, e l'ordine è la parte che conta:
            //
            //  1. il video è FINITO (o in pausa) → si CONSEGNA. Sta prima delle regole di
            //     stallo di proposito: un video finito ha per definizione un `currentTime` che
            //     non avanza più, e leggerlo come guasto vorrebbe dire rifiutare video sani
            //     ogni volta che l'evento `ended` non arriva;
            //  2. niente si muove più → si ABORTISCE.
            //
            // Le due letture dello stallo sono diverse e servono entrambe:
            //  · **nessun disegno** da 3 s mentre il video avanza: è la firma iOS, `rAF`
            //    sospeso in background con `captureStream` che continua a emettere l'ultima
            //    tela. Un controllo sul solo `currentTime` qui sarebbe cieco;
            //  · **`currentTime` fermo** da 3 s mentre il ciclo gira: il decoder si è piantato
            //    e si sta registrando lo stesso fotogramma. Un controllo sui soli disegni qui
            //    sarebbe cieco.
            //
            // Ciò che PRIMA di questo momento il watchdog stia guardando non è affare di questa
            // funzione: le attese del logo, dei metadati e della preparazione le arma chi le
            // comincia, e ognuna porta il proprio `punto`.
            let ultimoTempoOsservato = el.currentTime;
            let ultimoAvanzamentoMs = Date.now();

            const sorvegliaProgresso = (ora: number) => {
                const t = el.currentTime;
                if (t !== ultimoTempoOsservato) {
                    ultimoTempoOsservato = t;
                    ultimoAvanzamentoMs = ora;
                }

                if (el.ended || el.paused) {
                    // `paused` è ambiguo — fine naturale, o riproduzione interrotta — e il DOM
                    // non dà modo di distinguerli. Si consegna ciò che c'è: se il video è
                    // troncato, a dirlo è il confronto delle durate del cancello di integrità,
                    // che è il posto dove quella decisione è misurabile. Dopo di qui il tick
                    // successivo non torna in questo controllo: passa alla sorveglianza della
                    // consegna, in cima al watchdog.
                    consegna();
                    return;
                }

                if (ora - ultimoDisegnoMs > STALLO_MS || ora - ultimoAvanzamentoMs > STALLO_MS) {
                    fallisci('canvas-congelato');
                }
            };

            // ── (a) LA FINE NORMALE, che prima non era agganciata a niente ────────────────
            el.onended = () => {
                consegna();
            };

            // ⚠️ `el.onerror` NON si riassegna qui. Dopo i metadati un `error` dell'elemento
            // significa un'altra cosa — il decoder ha ceduto A METÀ — e quel significato cambia
            // nell'istante dei metadati: l'handler è già stato sostituito come PRIMA istruzione
            // di `onloadedmetadata`. Riassegnarlo qui, dopo l'`await` del `resume` dell'audio,
            // lasciava una finestra in cui il guasto veniva contato nella colonna dei metadati.
            //
            // ⚠️ IL RAMO CANCELLATO: prima, se la registrazione era già partita, si faceva
            // `stop()` e si CONSEGNAVA il pezzo parziale come se fosse integro — con un
            // commento che lo diceva, e senza un solo log. È il difetto di questo file nella sua
            // forma più pura: un guasto che esce sotto forma di file.

            // ── LA SEQUENZA CORRETTA: play → primo fotogramma → disegna → start ───────────
            //
            // `play()` è ASINCRONO. Prima `start()` partiva subito dopo averla chiamata: si
            // registrava una tela ancora vuota, e se `play()` rigettava il registratore era già
            // vivo su uno stream che non avrebbe mai ricevuto niente.
            try {
                const avvio = el.play();
                if (avvio && typeof avvio.then === 'function') await avvio;
            } catch (err) {
                return fallisci('play-fallito', err);
            }
            if (concluso) return;

            // Da qui il watchdog aspetta il PRIMO FOTOGRAMMA, con il suo punto e il suo tetto: è
            // l'attesa che la sequenza corretta introduce, e senza questa riga non finisce mai.
            controllo = attesa(ATTESA_PRIMO_FOTOGRAMMA_MS, () => fallisci('primo-fotogramma-mancante'));

            await attendiPrimoFotogramma(el);
            if (concluso) return;

            if (!disegna()) return;

            ultimoTempoOsservato = el.currentTime;
            ultimoAvanzamentoMs = Date.now();
            controllo = sorvegliaProgresso;
            registratore.start(TIMESLICE_MS);
            requestAnimationFrame(drawFrame);
        }

        /**
         * Aspetta che ci sia DAVVERO un fotogramma da disegnare.
         *
         * `requestVideoFrameCallback` è il segnale esatto («un fotogramma nuovo è stato
         * consegnato al compositore») e c'è su Safari e su Chrome moderni. Dove manca si usa
         * `readyState` (≥ `HAVE_CURRENT_DATA` significa che un fotogramma c'è già) e, se non
         * basta, il primo fra `loadeddata`, `seeked` e `timeupdate` — con un seek a zero per
         * provocarlo. Non risolve mai due volte, e non lascia ascoltatori attaccati.
         *
         * Se nessuno di questi arriva, la promise non si risolve da sé: a chiudere è il watchdog,
         * che a questo punto sta sorvegliando `primo-fotogramma-mancante` — ed è l'unica cosa che
         * impedisce un'attesa infinita.
         *
         * ⚠️ E QUANDO CHIUDE LUI, questa attesa va RIPULITA da fuori: `chiudi` chiama
         * `staccaPrimoFotogramma`, che stacca i tre ascoltatori e risolve la promise. Senza,
         * l'attesa restava appesa per sempre — tre ascoltatori agganciati all'elemento e
         * `preparaEAvvia` sospesa, cioè elemento, tela e chiusure tenuti in vita per riferimento
         * a ogni video rifiutato su quel punto.
         */
        function attendiPrimoFotogramma(el: HTMLVideoElement): Promise<void> {
            return new Promise<void>((risolvi) => {
                let fatto = false;
                const finito = () => {
                    if (fatto) return;
                    fatto = true;
                    staccaPrimoFotogramma = null;
                    for (const nome of ['loadeddata', 'seeked', 'timeupdate'] as const) {
                        el.removeEventListener(nome, finito);
                    }
                    risolvi();
                };
                // La stessa funzione serve da pulizia: è idempotente per costruzione (`fatto`),
                // quindi un fotogramma che arrivasse dopo la chiusura non fa niente.
                staccaPrimoFotogramma = finito;

                if (typeof el.requestVideoFrameCallback === 'function') {
                    el.requestVideoFrameCallback(() => finito());
                    return;
                }

                const HAVE_CURRENT_DATA = 2;
                if (el.readyState >= HAVE_CURRENT_DATA) {
                    finito();
                    return;
                }

                for (const nome of ['loadeddata', 'seeked', 'timeupdate'] as const) {
                    el.addEventListener(nome, finito);
                }
                try {
                    el.currentTime = 0;
                } catch (err) {
                    avvisa('gallery-video-seek-iniziale-fallito', err);
                }
            });
        }
    });
}
