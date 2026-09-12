import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { processVideoWithWatermark, type MisuraConversioneVideo } from '@/lib/media/video-mediarecorder';
import { logClient } from '@/lib/logging/client';

/**
 * L'ORCHESTRAZIONE DELLA CONVERSIONE VIDEO — cioè la parte che in produzione consegnava
 * file guasti senza dirlo a nessuno.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * IL DIFETTO, MISURATO. Il log `gallery-video-conversione-fallita` ha **ZERO righe in tutta
 * `app_log`**: su iOS la conversione non rigetta MAI. E `traccia-audio-non-catturata` ne ha
 * quattro, tutte iOS. Il titolare, da iPhone: «si ferma ad un certo punto, e mostra lo stesso
 * frame fino alla fine del video, ed è muto». Quel file ha durata giusta, container giusto,
 * peso giusto: `validateVideoFile` lo fa passare, nessun test è rosso, nessuna route risponde
 * 400. Il primo a vederlo è il genitore.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ I DOPPI, E PERCHÉ SONO PILOTATI A MANO
 *
 * In jsdom non esistono `MediaRecorder`, `AudioContext`, `canvas.captureStream`,
 * `getContext('2d')`, `URL.createObjectURL`, né il caricamento di un `<img>` o di un `<video>`.
 * Non è un limite da aggirare: è ciò che permette di scrivere i guasti che in un browser vero
 * non si riesce a provocare a comando — la tela che si ferma, l'AudioContext che resta
 * `suspended`, l'app che va in secondo piano nel mezzo.
 *
 * `requestAnimationFrame` è una CODA che questo file pompa a mano, e i timer sono finti:
 * nessun test dipende dall'orologio della macchina. Un test che aspetta 3 secondi veri è un
 * test che qualcuno prima o poi cancella.
 *
 * ⚠️ `esitoDi`/`sorveglia` guardano se la promise è PENDENTE, non solo se rigetta. È la
 * differenza che conta due volte in questo file: il difetto di `wm.width === 0` non è «rigetta
 * col motivo sbagliato», è **la promise che resta appesa per sempre**, e un `await expect(…)`
 * lo avrebbe raccontato solo come un timeout di vitest a 20 secondi.
 */

vi.mock('@/lib/logging/client', async (importOriginal) => {
    const vero = await importOriginal<typeof import('@/lib/logging/client')>();
    return { ...vero, logClient: vi.fn() };
});

/** Il bridge nativo: `App.addListener('appStateChange', …)` è una delle quattro chiusure. */
const nativo = vi.hoisted(() => ({
    ascoltatore: null as null | ((stato: { isActive: boolean }) => void),
    rimozioni: 0,
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: (_nome: string, cb: (stato: { isActive: boolean }) => void) => {
            nativo.ascoltatore = cb;
            return Promise.resolve({
                remove: () => {
                    nativo.rimozioni += 1;
                    return Promise.resolve();
                },
            });
        },
    },
}));

const MAX = 50 * 1024 * 1024;

/* ═══════════════════════════════════════════════════════════════════════════════════
 * I DOPPI
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** Ogni passo osservabile, in ordine: è così che si dimostra che `start` non precede il disegno. */
let traccia: string[] = [];

/** I ripristini dei globali sostituiti: si disfano in `afterEach`, uno per uno. */
let ripristini: (() => void)[] = [];

function sostituisci(oggetto: object, chiave: string, descrittore: PropertyDescriptor): void {
    const prima = Object.getOwnPropertyDescriptor(oggetto, chiave);
    Object.defineProperty(oggetto, chiave, { configurable: true, ...descrittore });
    ripristini.push(() => {
        if (prima) Object.defineProperty(oggetto, chiave, prima);
        else delete (oggetto as Record<string, unknown>)[chiave];
    });
}

/** Il contesto 2D: registra i disegni e si comporta come il vero su una geometria non finita. */
const ctxFinto = {
    globalAlpha: 1,
    disegni: [] as string[],
    drawImage: (_sorgente: unknown, ...numeri: number[]) => {
        if (numeri.some((n) => !Number.isFinite(n))) {
            // Come il browser vero: `drawImage` con un NaN lancia. È il caso `wm.width === 0`.
            throw new TypeError('drawImage: valore non finito');
        }
        ctxFinto.disegni.push(numeri.join(','));
        traccia.push('drawImage');
    },
};

/** Lo stream della tela. `addTrack` è ciò che unisce l'audio al video. */
const streamFinto = {
    tracce: [] as unknown[],
    addTrack(t: unknown) {
        this.tracce.push(t);
    },
    getTracks() {
        return this.tracce;
    },
    getAudioTracks() {
        return this.tracce;
    },
};

class MediaRecorderFinto {
    /** I mime che il dispositivo dichiara di sapere scrivere. Pilotabile per test. */
    static supportati: string[] = [];
    static ultimo: MediaRecorderFinto | null = null;
    /** Una WebView che non implementa `isTypeSupported`: l'eccezione INATTESA nel mezzo. */
    static isTypeSupportedLancia = false;
    /**
     * `stop()` che NON emette `onstop`. È l'ultimo anello della catena, e prima non era
     * sorvegliato da niente: la consegna veniva chiesta e nessuno chiudeva più.
     */
    static senzaOnstop = false;
    /** `stop()` che non consegna nessun pezzo: il file di ZERO byte, involucro giusto e vuoto. */
    static senzaPezzi = false;
    /**
     * `onstop` ASINCRONO, come nel browser vero: `stop()` ritorna subito, l'ULTIMO pezzo e
     * `onstop` arrivano dopo. È la finestra in cui una seconda richiesta di consegna assemblerebbe
     * un file senza il pezzo finale — tronco, con l'involucro giusto.
     */
    static onstopAsincrono = false;

    static isTypeSupported(tipo: string): boolean {
        if (MediaRecorderFinto.isTypeSupportedLancia) {
            throw new TypeError('MediaRecorder.isTypeSupported non è una funzione');
        }
        return MediaRecorderFinto.supportati.includes(tipo);
    }

    state: 'inactive' | 'recording' | 'paused' = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    argomentiStart: unknown[] = [];
    avvii = 0;
    arresti = 0;

    constructor(
        public stream: unknown,
        public opzioni?: { mimeType?: string; videoBitsPerSecond?: number; audioBitsPerSecond?: number },
    ) {
        MediaRecorderFinto.ultimo = this;
        traccia.push('new MediaRecorder');
    }

    start(...argomenti: unknown[]): void {
        this.avvii += 1;
        this.argomentiStart = argomenti;
        this.state = 'recording';
        traccia.push('start');
    }

    stop(): void {
        this.arresti += 1;
        if (this.state === 'inactive') return;
        // Lo stato passa a `inactive` SUBITO, come nel vero: è il motivo per cui una seconda
        // richiesta di consegna finisce nel ramo «assembla adesso».
        this.state = 'inactive';
        const conclusione = () => {
            // Come il vero: l'ultimo pezzo arriva PRIMA di `onstop`.
            if (!MediaRecorderFinto.senzaPezzi) this.emetti(4096);
            traccia.push('stop');
            if (MediaRecorderFinto.senzaOnstop) return;
            this.onstop?.();
        };
        if (MediaRecorderFinto.onstopAsincrono) {
            void Promise.resolve().then(conclusione);
            return;
        }
        conclusione();
    }

    /** Un pezzo di registrazione, come farebbe il timeslice. */
    emetti(byte: number): void {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(byte)]) });
    }
}

const audio = {
    /** Lo stato con cui nasce un AudioContext in WebKit: **misurato**, `suspended`. */
    statoIniziale: 'suspended' as AudioContextState,
    /** `resume()` che non porta a `running`: il muto che il titolare ha visto. */
    resumeFunziona: true,
    /**
     * `resume()` che non risolve MAI. Su iOS un contesto audio che non ottiene il permesso di
     * suonare può restare in attesa senza né risolvere né rigettare: la preparazione è `async`
     * e si fermerebbe lì, con tutto il resto — watchdog compreso — non ancora armato.
     */
    resumeNonRisolve: false,
    /** `createMediaElementSource` che lancia: i 4 casi iOS di `traccia-audio-non-catturata`. */
    sorgenteLancia: false,
    chiusure: 0,
    resumeChiamate: 0,
};

class AudioContextFinto {
    state: AudioContextState;

    constructor() {
        this.state = audio.statoIniziale;
    }

    resume(): Promise<void> {
        audio.resumeChiamate += 1;
        traccia.push('resume');
        if (audio.resumeNonRisolve) return new Promise<void>(() => {});
        if (audio.resumeFunziona) this.state = 'running';
        return Promise.resolve();
    }

    createMediaElementSource(): { connect: (d: unknown) => void } {
        if (audio.sorgenteLancia) throw new Error('InvalidStateError');
        return { connect: () => {} };
    }

    createMediaStreamDestination(): { stream: { getAudioTracks: () => unknown[] } } {
        return { stream: { getAudioTracks: () => [{ kind: 'audio' }] } };
    }

    close(): Promise<void> {
        audio.chiusure += 1;
        return Promise.resolve();
    }
}

/**
 * Il watermark. `larghezza: 0` è il difetto che rende `wmHeight` un NaN; `maiCaricato` è
 * l'immagine che non consegna né `load` né `error` — una richiesta che resta appesa nella
 * WebView — e prima di questo giro bastava a non far partire NIENTE, per sempre.
 */
const wm = { larghezza: 200, altezza: 100, fallisce: false, maiCaricato: false };

class ImmagineFinta {
    /** L'ultima creata: serve a farle consegnare il `load` in RITARDO, a scadenza già passata. */
    static ultima: ImmagineFinta | null = null;

    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = wm.larghezza;
    height = wm.altezza;
    #src = '';

    constructor() {
        ImmagineFinta.ultima = this;
    }

    get src(): string {
        return this.#src;
    }

    set src(v: string) {
        this.#src = v;
        if (wm.maiCaricato) return;
        // Caricamento asincrono, come nel browser: il codice sotto prova deve poter agganciare
        // `onload` prima che scatti.
        void Promise.resolve().then(() => {
            this.width = wm.larghezza;
            this.height = wm.altezza;
            if (wm.fallisce) this.onerror?.();
            else this.onload?.();
        });
    }
}

/** La coda di `requestAnimationFrame`: si pompa a mano, un giro alla volta. */
let codaRaf: FrameRequestCallback[] = [];

/** Gli oggetti URL creati e revocati: il conteggio che dimostra l'idempotenza della chiusura. */
const url = { creati: [] as string[], revocati: [] as string[] };

/** Gli elementi creati dal codice sotto prova, per tag. */
let creati: Record<string, HTMLElement[]> = {};

/**
 * `document.createElement('video')` che lancia. Non è un capriccio: `startProcessing` viene
 * chiamata da un gestore di evento del DOM (`wm.onload`) o da un tick del watchdog, e
 * un'eccezione lì non la raccoglie nessuno.
 */
let creazioneVideoLancia = false;

interface OpzioniVideo {
    duration?: number;
    currentTime?: number;
    paused?: boolean;
    ended?: boolean;
    readyState?: number;
    videoWidth?: number;
    videoHeight?: number;
    playRigetta?: boolean;
    /** `currentTime` legato all'OROLOGIO (finto): il video avanza anche se nessuno disegna. */
    avanzaConOrologio?: boolean;
    /** Il dispositivo espone `requestVideoFrameCallback` (Safari e Chrome moderni). */
    conRvfc?: boolean;
}

const statoVideo = {
    currentTime: 0,
    paused: false,
    ended: false,
    avanzaConOrologio: false,
    t0: 0,
    volumeToccato: false,
    volume: 1,
    rvfcRichiesti: 0,
};

/**
 * Gli ascoltatori VIVI sull'elemento `<video>`, per nome di evento.
 *
 * Si contano per identità (un `Set` di callback) e non con un contatore: `removeEventListener`
 * di un ascoltatore mai aggiunto nel DOM è un no-op, e un contatore lo leggerebbe come −1
 * facendo SEMBRARE ripulito ciò che non è mai stato agganciato. Serve a una cosa sola, e
 * precisa: quando è il watchdog a chiudere, i tre ascoltatori del primo fotogramma restavano
 * agganciati all'elemento — una perdita per ogni video rifiutato, su un telefono che di
 * memoria ne ha poca.
 */
const ascoltatori = new Map<string, Set<EventListener>>();

function vivi(nome: string): number {
    return ascoltatori.get(nome)?.size ?? 0;
}

/**
 * Veste l'elemento `<video>` creato dal codice sotto prova con ciò che jsdom non ha.
 * Si chiama DOPO che il codice l'ha creato e PRIMA di `loadedmetadata`: è la finestra in cui
 * un browser vero avrebbe già i metadati e non ancora un fotogramma.
 */
function prepara(video: HTMLVideoElement, o: OpzioniVideo = {}): void {
    statoVideo.currentTime = o.currentTime ?? 0;
    statoVideo.paused = o.paused ?? false;
    statoVideo.ended = o.ended ?? false;
    statoVideo.avanzaConOrologio = o.avanzaConOrologio ?? false;
    statoVideo.t0 = Date.now();
    statoVideo.volume = 1;
    statoVideo.volumeToccato = false;

    const def = (chiave: string, descrittore: PropertyDescriptor) =>
        Object.defineProperty(video, chiave, { configurable: true, ...descrittore });

    const aggiungiVero = video.addEventListener.bind(video);
    const togliVero = video.removeEventListener.bind(video);
    def('addEventListener', {
        value: (nome: string, cb: EventListener, o2?: boolean | AddEventListenerOptions) => {
            let insieme = ascoltatori.get(nome);
            if (!insieme) {
                insieme = new Set<EventListener>();
                ascoltatori.set(nome, insieme);
            }
            insieme.add(cb);
            aggiungiVero(nome, cb, o2);
        },
    });
    def('removeEventListener', {
        value: (nome: string, cb: EventListener, o2?: boolean | EventListenerOptions) => {
            ascoltatori.get(nome)?.delete(cb);
            togliVero(nome, cb, o2);
        },
    });

    def('duration', { get: () => o.duration ?? 10 });
    def('videoWidth', { get: () => o.videoWidth ?? 640 });
    def('videoHeight', { get: () => o.videoHeight ?? 360 });
    def('readyState', { get: () => o.readyState ?? 2 });
    def('paused', { get: () => statoVideo.paused });
    def('ended', { get: () => statoVideo.ended });
    def('currentTime', {
        get: () =>
            statoVideo.avanzaConOrologio
                ? (Date.now() - statoVideo.t0) / 1000
                : statoVideo.currentTime,
        set: (v: number) => {
            statoVideo.currentTime = v;
        },
    });
    def('volume', {
        get: () => statoVideo.volume,
        set: (v: number) => {
            statoVideo.volume = v;
            statoVideo.volumeToccato = true;
        },
    });
    def('play', {
        value: () => {
            traccia.push('play');
            return o.playRigetta
                ? Promise.reject(new Error('NotAllowedError'))
                : Promise.resolve();
        },
    });
    def('pause', { value: () => { traccia.push('pause'); } });
    if (o.conRvfc) {
        def('requestVideoFrameCallback', {
            value: (cb: () => void) => {
                statoVideo.rvfcRichiesti += 1;
                void Promise.resolve().then(() => cb());
                return 1;
            },
        });
    }
}

/* ═══════════════════════════════════════════════════════════════════════════════════
 * GLI AIUTI
 * ═══════════════════════════════════════════════════════════════════════════════════ */

/** Svuota le microtask (e i timer a zero) senza far avanzare l'orologio finto. */
async function scorri(giri = 10): Promise<void> {
    for (let i = 0; i < giri; i += 1) await vi.advanceTimersByTimeAsync(0);
}

type Esito =
    | { stato: 'pendente' }
    | { stato: 'risolta'; valore: File }
    | { stato: 'rigettata'; errore: unknown };

/**
 * Sorveglia la promise SENZA attenderla: distingue «pendente» da «rigettata», che è la
 * differenza fra il difetto vero (la promise appesa per sempre) e il rifiuto corretto.
 */
function sorveglia(p: Promise<File>): { readonly esito: Esito } {
    const scatola: { esito: Esito } = { esito: { stato: 'pendente' } };
    p.then(
        (valore) => {
            scatola.esito = { stato: 'risolta', valore };
        },
        (errore: unknown) => {
            scatola.esito = { stato: 'rigettata', errore };
        },
    );
    return scatola;
}

function videoCreato(): HTMLVideoElement {
    const elenco = creati.video ?? [];
    if (elenco.length === 0) throw new Error('il codice sotto prova non ha creato nessun <video>');
    return elenco[elenco.length - 1] as HTMLVideoElement;
}

function registratore(): MediaRecorderFinto {
    const r = MediaRecorderFinto.ultimo;
    if (!r) throw new Error('nessun MediaRecorder costruito');
    return r;
}

/**
 * Un giro di `requestAnimationFrame`, con il video che avanza di `passoS` secondi.
 *
 * Con `avanzaConOrologio` il tempo del video è legato all'orologio finto, quindi per farlo
 * avanzare si avanza l'orologio — di 40 ms, cioè un fotogramma a 25 fps, che è molto meno del
 * mezzo secondo del watchdog: pompare non deve far scattare la sorveglianza.
 */
const PASSO_OROLOGIO_MS = 40;

async function pompa(giri = 1, passoS = 0.04): Promise<void> {
    for (let i = 0; i < giri; i += 1) {
        if (statoVideo.avanzaConOrologio) await vi.advanceTimersByTimeAsync(PASSO_OROLOGIO_MS);
        else statoVideo.currentTime += passoS;
        const coda = codaRaf;
        codaRaf = [];
        for (const cb of coda) cb(Date.now());
        await scorri(2);
    }
}

function fileVideo(nome = 'clip.mp4', byte = 8_000_000): File {
    const f = new File([new Uint8Array(8)], nome, { type: 'video/mp4' });
    Object.defineProperty(f, 'size', { value: byte });
    return f;
}

/**
 * Porta la conversione fino a registrazione avviata: è il punto di partenza di quasi tutti i
 * casi, e riprodurlo in ognuno renderebbe illeggibile ciò che ciascuno prova.
 */
async function avvia(
    opzioniVideo: OpzioniVideo = {},
    opzioni: { obbligatoria?: boolean; onMisura?: (m: MisuraConversioneVideo) => void } = {
        obbligatoria: true,
    },
): Promise<{ file: File; esito: { readonly esito: Esito }; video: HTMLVideoElement }> {
    const file = fileVideo();
    const p = processVideoWithWatermark(file, '/watermark.png', MAX, opzioni);
    const esito = sorveglia(p);
    await scorri();
    const video = videoCreato();
    prepara(video, opzioniVideo);
    video.dispatchEvent(new Event('loadedmetadata'));
    await scorri();
    // Un browser vero emette anche `play`: il codice non deve DIPENDERE da lui (era così che
    // il ciclo di disegno partiva), ma riceverlo non deve cambiare niente.
    video.dispatchEvent(new Event('play'));
    await scorri();
    return { file, esito, video };
}

const logSpy = logClient as unknown as Mock;

function righeLog(messaggio: string): { campi?: Record<string, unknown> }[] {
    return logSpy.mock.calls
        .map((c) => c[0] as { messaggio?: string; campi?: Record<string, unknown> })
        .filter((e) => e.messaggio === messaggio);
}

beforeEach(() => {
    // ⚠️ `toFake` ESPLICITO e senza `requestAnimationFrame`: i timer finti di sinon lo
    // farebbero diventare un timer da 16 ms, e i disegni tornerebbero a dipendere
    // dall'avanzamento dell'orologio invece dalla pompa di questo file.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    logSpy.mockClear();
    traccia = [];
    ripristini = [];
    creati = {};
    codaRaf = [];
    url.creati = [];
    url.revocati = [];
    ctxFinto.disegni = [];
    streamFinto.tracce = [];
    MediaRecorderFinto.ultimo = null;
    MediaRecorderFinto.isTypeSupportedLancia = false;
    MediaRecorderFinto.senzaOnstop = false;
    MediaRecorderFinto.senzaPezzi = false;
    MediaRecorderFinto.onstopAsincrono = false;
    ImmagineFinta.ultima = null;
    ascoltatori.clear();
    MediaRecorderFinto.supportati = [
        // Un iPhone reale: **misurato in WebKit**, la forma col codec AUDIO è supportata.
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4',
    ];
    audio.statoIniziale = 'suspended';
    audio.resumeFunziona = true;
    audio.resumeNonRisolve = false;
    audio.sorgenteLancia = false;
    audio.chiusure = 0;
    audio.resumeChiamate = 0;
    wm.larghezza = 200;
    wm.altezza = 100;
    wm.fallisce = false;
    wm.maiCaricato = false;
    statoVideo.rvfcRichiesti = 0;
    nativo.ascoltatore = null;
    nativo.rimozioni = 0;

    creazioneVideoLancia = false;

    const createElementVero = document.createElement.bind(document);
    sostituisci(document, 'createElement', {
        value: (tag: string, ...resto: unknown[]) => {
            if (tag === 'video' && creazioneVideoLancia) {
                throw new DOMException('createElement non disponibile', 'InvalidStateError');
            }
            const el = createElementVero(tag as 'div', ...(resto as []));
            (creati[tag] ??= []).push(el);
            return el;
        },
        writable: true,
    });

    sostituisci(globalThis, 'Image', { value: ImmagineFinta, writable: true });
    sostituisci(globalThis, 'MediaRecorder', { value: MediaRecorderFinto, writable: true });
    sostituisci(globalThis, 'AudioContext', { value: AudioContextFinto, writable: true });
    sostituisci(globalThis, 'requestAnimationFrame', {
        value: (cb: FrameRequestCallback) => {
            codaRaf.push(cb);
            return codaRaf.length;
        },
        writable: true,
    });
    sostituisci(globalThis, 'cancelAnimationFrame', { value: () => {}, writable: true });
    sostituisci(URL, 'createObjectURL', {
        value: () => {
            const u = `blob:finto/${url.creati.length}`;
            url.creati.push(u);
            return u;
        },
        writable: true,
    });
    sostituisci(URL, 'revokeObjectURL', {
        value: (u: string) => {
            url.revocati.push(u);
        },
        writable: true,
    });
    sostituisci(HTMLCanvasElement.prototype, 'getContext', {
        value: () => ctxFinto,
        writable: true,
    });
    sostituisci(HTMLCanvasElement.prototype, 'captureStream', {
        value: () => {
            traccia.push('captureStream');
            return streamFinto;
        },
        writable: true,
    });
    sostituisci(document, 'visibilityState', { get: () => 'visible' });
});

afterEach(() => {
    for (const r of ripristini.reverse()) r();
    ripristini = [];
    vi.useRealTimers();
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * A — LA STRADA CHE FUNZIONA (e le tre cose che oggi non fa)
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('conversione riuscita', () => {
    it('consegna un File e MISURA i fotogrammi distinti, non i giri del ciclo', async () => {
        const misure: MisuraConversioneVideo[] = [];
        const { esito } = await avvia({ duration: 10 }, { obbligatoria: true, onMisura: (m) => misure.push(m) });

        // Dieci giri con il video che avanza: dieci fotogrammi nuovi.
        await pompa(10, 0.04);
        // Cinque giri con la tela ferma (`currentTime` immobile): il contatore NON deve salire.
        await pompa(5, 0);

        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();

        expect(esito.esito.stato).toBe('risolta');
        const consegnato = esito.esito.stato === 'risolta' ? esito.esito.valore : null;
        expect(consegnato).toBeInstanceOf(File);
        expect(consegnato?.type).toContain('video/mp4');
        expect(consegnato?.name.endsWith('.mp4')).toBe(true);

        expect(misure).toHaveLength(1);
        const m = misure[0];
        // 1 (il primo fotogramma, disegnato prima di `start`) + 10 avanzamenti. I 5 giri a
        // tela ferma non contano: è il contatore che «si inchioda» quando la tela si ferma.
        expect(m.fotogrammiDistinti).toBe(11);
        expect(m.fotogrammiAttesi).toBe(250); // 10 s × 25 fps di `captureStream(25)`
        expect(m.fpsTela).toBe(25);
        expect(m.durataIngressoS).toBe(10);
        expect(m.byteUscita).toBeGreaterThan(0);
        expect(m.audioCatturato).toBe(true);
        expect(m.mimeUscita).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    });

    it('logga il SUCCESSO con i contatori (regola 5: senza, «nessun log» non distingue niente)', async () => {
        const { esito } = await avvia();
        await pompa(4);
        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();

        expect(esito.esito.stato).toBe('risolta');
        const righe = righeLog('gallery-video-conversione-riuscita');
        expect(righe).toHaveLength(1);
        const campi = righe[0].campi ?? {};
        expect(typeof campi.ms).toBe('number');
        expect(campi.fotogrammi).toBe(5);
        expect(campi.byte_in).toBe(8_000_000);
        expect(typeof campi.byte_out).toBe('number');
        expect(campi.mime_out).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
        expect(campi.audio).toBe(true);
        // Il nome del file di un bambino non esce dal dispositivo, mai.
        expect(JSON.stringify(righe[0])).not.toContain('clip');
    });

    it('`start` NON precede il primo `drawImage` (si registrava una tela vuota)', async () => {
        await avvia();
        const iDisegno = traccia.indexOf('drawImage');
        const iStart = traccia.indexOf('start');
        expect(iDisegno).toBeGreaterThanOrEqual(0);
        expect(iStart).toBeGreaterThanOrEqual(0);
        expect(iDisegno).toBeLessThan(iStart);
        // E `play` viene atteso prima del disegno: `play()` è asincrono.
        expect(traccia.indexOf('play')).toBeLessThan(iDisegno);
    });

    it('usa `requestVideoFrameCallback` quando c\'è (il primo fotogramma vero)', async () => {
        await avvia({ conRvfc: true, readyState: 0 });
        expect(statoVideo.rvfcRichiesti).toBeGreaterThan(0);
        expect(traccia.indexOf('drawImage')).toBeLessThan(traccia.indexOf('start'));
    });

    it('`start` riceve un TIMESLICE numerico (senza, un solo pezzo alla fine: si perde tutto)', async () => {
        await avvia();
        const r = registratore();
        expect(r.avvii).toBe(1);
        expect(r.argomentiStart).toHaveLength(1);
        expect(typeof r.argomentiStart[0]).toBe('number');
        expect(r.argomentiStart[0] as number).toBeGreaterThan(0);
    });

    it('i pezzi intermedi del timeslice finiscono nel file consegnato', async () => {
        const { esito } = await avvia();
        const r = registratore();
        r.emetti(1_000);
        r.emetti(2_000);
        await pompa(2);
        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();
        expect(esito.esito.stato).toBe('risolta');
        const consegnato = esito.esito.stato === 'risolta' ? esito.esito.valore : null;
        // 1.000 + 2.000 + i 4.096 dell'ultimo pezzo emesso da `stop()`.
        expect(consegnato?.size).toBe(7_096);
    });

    it('chiede un mime CON il codec audio, e un bitrate audio', async () => {
        await avvia();
        const r = registratore();
        expect(r.opzioni?.mimeType).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
        expect(r.opzioni?.audioBitsPerSecond).toBe(128_000);
        expect(typeof r.opzioni?.videoBitsPerSecond).toBe('number');
    });

    it('ripiega sulla forma `avc1,mp4a.40.2` se il profilo esatto non è supportato', async () => {
        MediaRecorderFinto.supportati = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1'];
        await avvia();
        expect(registratore().opzioni?.mimeType).toBe('video/mp4;codecs=avc1,mp4a.40.2');
    });

    it('risveglia l\'AudioContext: in WebKit nasce `suspended` e nessuno lo chiamava', async () => {
        await avvia();
        expect(audio.resumeChiamate).toBeGreaterThan(0);
        expect(traccia.indexOf('resume')).toBeLessThan(traccia.indexOf('start'));
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * B — LE QUATTRO CHIUSURE: il file congelato non deve poter uscire
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('la tela che si ferma', () => {
    it('rAF sospeso mentre il video AVANZA (la firma iOS) → canvas-congelato', async () => {
        // Questa è la forma esatta del guasto riferito: iOS sospende `requestAnimationFrame`
        // fuori dal primo piano, `captureStream` continua a emettere l'ultima tela, e il file
        // esce di durata PIENA e con un fotogramma solo.
        const { esito } = await avvia({ avanzaConOrologio: true });
        await pompa(3);
        expect(esito.esito.stato).toBe('pendente');

        // Nessun altro giro di rAF: la tela è ferma, il registratore vivo, il video avanza.
        await vi.advanceTimersByTimeAsync(4000);

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            name: 'VideoConversionError',
            puntoDiFallimento: 'canvas-congelato',
        });
    });

    it('`currentTime` fermo per 3 s mentre il ciclo gira → canvas-congelato', async () => {
        const { esito } = await avvia();
        // Il ciclo continua a girare (la tela si ridisegna), ma il video non avanza: un
        // contatore di GIRI resterebbe perfetto proprio nel caso da prendere.
        for (let i = 0; i < 8; i += 1) {
            await pompa(1, 0);
            await vi.advanceTimersByTimeAsync(500);
        }
        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'canvas-congelato',
        });
    });

    it('il rifiuto LOGGA i contatori (punto, fotogrammi attesi e distinti)', async () => {
        const { esito } = await avvia({ avanzaConOrologio: true, duration: 8 });
        await pompa(2);
        await vi.advanceTimersByTimeAsync(4000);
        expect(esito.esito.stato).toBe('rigettata');

        const righe = righeLog('gallery-video-conversione-interrotta');
        expect(righe).toHaveLength(1);
        const campi = righe[0].campi ?? {};
        expect(campi.punto).toBe('canvas-congelato');
        expect(campi.fotogrammi_attesi).toBe(200);
        expect(campi.fotogrammi_distinti).toBe(3);
        expect(campi.durata_in_s).toBe(8);
        expect(typeof campi.ms).toBe('number');
    });

    it('un video FINITO senza evento `ended` viene CONSEGNATO, non abortito', async () => {
        // La differenza fra le due letture di «`currentTime` non avanza»: se il video è
        // finito, non è un guasto — è la fine. Sbagliarla significa rifiutare video sani.
        const { esito } = await avvia();
        await pompa(3);
        statoVideo.ended = true;
        await vi.advanceTimersByTimeAsync(600);
        await scorri();
        expect(esito.esito.stato).toBe('risolta');
    });
});

describe('l\'app che va in secondo piano', () => {
    it('`visibilitychange` a `hidden` → app-in-background', async () => {
        const { esito } = await avvia();
        await pompa(2);
        sostituisci(document, 'visibilityState', { get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'app-in-background',
        });
    });

    it('`appStateChange({isActive:false})` del bridge nativo → app-in-background', async () => {
        sostituisci(globalThis, 'Capacitor', {
            value: { isNativePlatform: () => true, getPlatform: () => 'ios' },
            writable: true,
        });
        const { esito } = await avvia();
        await pompa(2);
        expect(nativo.ascoltatore).not.toBeNull();
        nativo.ascoltatore?.({ isActive: false });
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'app-in-background',
        });
        // L'ascoltatore nativo viene STACCATO: restare agganciati a una conversione finita è
        // il modo in cui il secondo video eredita il guasto del primo.
        expect(nativo.rimozioni).toBe(1);
    });

    it('su web NON tocca il bridge nativo', async () => {
        await avvia();
        expect(nativo.ascoltatore).toBeNull();
    });
});

describe('il disegno che lancia', () => {
    it('`wm.width === 0` → disegno-fallito (oggi la promise resta appesa per sempre)', async () => {
        wm.larghezza = 0;
        const { esito } = await avvia();
        await pompa(2);
        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'disegno-fallito',
        });
    });

    it('il watermark che non si carica NON è un guasto: si converte senza', async () => {
        wm.fallisce = true;
        const { esito } = await avvia();
        await pompa(3);
        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();
        expect(esito.esito.stato).toBe('risolta');
    });

    it('un\'eccezione INATTESA nella preparazione rigetta, non resta appesa', async () => {
        // La preparazione gira dentro una funzione `async` che nessuno attende: senza un `catch`
        // esplicito, un'eccezione qui diventa una promise rifiutata che nessuno legge, e la
        // conversione non finisce MAI. È lo stesso guasto del disegno senza `try`, spostato.
        MediaRecorderFinto.isTypeSupportedLancia = true;
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        prepara(videoCreato());
        videoCreato().dispatchEvent(new Event('loadedmetadata'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'preparazione-fallita',
        });
        expect(url.revocati).toHaveLength(1);
    });

    it('il registratore che EMETTE `error` rigetta invece di consegnare un video tronco', async () => {
        const { esito } = await avvia();
        await pompa(3);
        registratore().onerror?.(new Event('error'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'registratore-errore',
        });
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * C — L'AUDIO: due rami che consegnavano un muto
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('audio', () => {
    it('AudioContext che resta `suspended` dopo `resume()` → audio-sospeso', async () => {
        audio.resumeFunziona = false;
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        prepara(videoCreato());
        videoCreato().dispatchEvent(new Event('loadedmetadata'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'audio-sospeso',
        });
        // Non si è registrato niente: meglio nessun file che un file muto.
        expect(MediaRecorderFinto.ultimo?.avvii ?? 0).toBe(0);
    });

    it('`createMediaElementSource` che lancia → audio-non-catturabile, e il VOLUME non si tocca', async () => {
        audio.sorgenteLancia = true;
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        const video = videoCreato();
        prepara(video);
        video.dispatchEvent(new Event('loadedmetadata'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'audio-non-catturabile',
        });
        // Il ramo che azzerava il volume e proseguiva non esiste più: consegnava un muto.
        expect(statoVideo.volumeToccato).toBe(false);
        expect(statoVideo.volume).toBe(1);
    });

    it('l\'AudioContext viene chiuso UNA volta sola', async () => {
        const { esito } = await avvia();
        await pompa(2);
        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();
        expect(esito.esito.stato).toBe('risolta');
        expect(audio.chiusure).toBe(1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * D — L'ERRORE DELL'ELEMENTO VIDEO
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('video.onerror', () => {
    it('a registrazione AVVIATA rigetta e LOGGA (non consegna più il pezzo parziale)', async () => {
        const { esito, video } = await avvia();
        await pompa(3);
        logSpy.mockClear();
        video.dispatchEvent(new Event('error'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'video-errore-durante-conversione',
        });
        expect(logSpy).toHaveBeenCalled();
        expect(righeLog('gallery-video-conversione-interrotta')).toHaveLength(1);
    });

    it('PRIMA dei metadati resta `video-metadati-illeggibili` (invariato)', async () => {
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        // `prepara` qui serve solo a dare a jsdom un `pause()` che esiste: l'errore arriva prima
        // dei metadati, quindi nessuna delle proprietà pilotate viene letta.
        prepara(videoCreato());
        videoCreato().dispatchEvent(new Event('error'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'video-metadati-illeggibili',
        });
        expect(url.revocati).toHaveLength(1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * E — `play()` CHE RIGETTA: il registratore vivo su uno stream morto
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('play() che rigetta', () => {
    it('`start` non viene MAI chiamato e l\'URL si revoca ESATTAMENTE una volta', async () => {
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        const video = videoCreato();
        prepara(video, { playRigetta: true });
        video.dispatchEvent(new Event('loadedmetadata'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'play-fallito',
        });
        expect(MediaRecorderFinto.ultimo?.avvii ?? 0).toBe(0);
        expect(url.revocati).toEqual([url.creati[0]]);
        expect(audio.chiusure).toBe(1);
    });

    it('un `error` che arriva DOPO non revoca una seconda volta né cambia l\'esito', async () => {
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        const video = videoCreato();
        prepara(video, { playRigetta: true });
        video.dispatchEvent(new Event('loadedmetadata'));
        await scorri();
        video.dispatchEvent(new Event('error'));
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(5000);

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'play-fallito',
        });
        expect(url.revocati).toHaveLength(1);
        expect(audio.chiusure).toBe(1);
        // Una sola riga di log: una chiusura, un verdetto.
        expect(righeLog('gallery-video-conversione-interrotta')).toHaveLength(1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * F — IL COMPORTAMENTO LEGACY, che non cambia
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('senza { obbligatoria: true } il ripiego resta l\'originale', () => {
    it('una tela congelata risolve con il file ORIGINALE (e lo dice nel log)', async () => {
        const { file, esito } = await avvia({ avanzaConOrologio: true }, {});
        await pompa(2);
        await vi.advanceTimersByTimeAsync(4000);

        expect(esito.esito.stato).toBe('risolta');
        expect(esito.esito.stato === 'risolta' ? esito.esito.valore : null).toBe(file);
        const righe = righeLog('gallery-video-conversione-interrotta');
        expect(righe).toHaveLength(1);
        expect(righe[0].campi?.ripiego).toBe(true);
    });

    it('non chiama `onMisura` quando consegna l\'originale: non c\'è niente da misurare', async () => {
        const misure: MisuraConversioneVideo[] = [];
        const { esito } = await avvia({ avanzaConOrologio: true }, { onMisura: (m) => misure.push(m) });
        await pompa(2);
        await vi.advanceTimersByTimeAsync(4000);
        expect(esito.esito.stato).toBe('risolta');
        expect(misure).toHaveLength(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * G — LE STRADE CHE RESTAVANO APPESE PER SEMPRE
 *
 * Il file dichiara «QUATTRO CHIUSURE INDIPENDENTI». Non basta, e la differenza è misurabile:
 * tutte e quattro confluiscono in `consegna()`/`chiudi()`, quindi se il tratto sorvegliato non
 * copre l'INTERA corsa non sono quattro reti, sono quattro ingressi nella stessa rete con dei
 * buchi prima e dopo. Tre buchi, tre sonde, tre `pendente`:
 *
 *   · prima del `<video>`: il logo che non consegna né `load` né `error`;
 *   · fra `el.src` e `loadedmetadata`: il decoder che non apre il file e non lancia;
 *   · dopo `registratore.stop()`: `onstop` che non arriva mai — il buco più NUOVO, aperto dalla
 *     sequenza `play → primo fotogramma → disegna → start` di questo stesso giro.
 *
 * ⚠️ Ogni caso qui dentro pretende PRIMA `pendente` a un passo dalla scadenza e POI `rigettata`:
 * senza il primo dei due, un tetto sbagliato di un ordine di grandezza resterebbe verde.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('nessuna strada resta appesa', () => {
    it('`stop()` senza `onstop`: l\'ULTIMO anello è sorvegliato → registratore-stop-senza-onstop', async () => {
        // Il guard `consegnaChiesta` rendeva il watchdog cieco proprio qui: al tick successivo
        // entrava nel ramo `ended` → `consegna()` → uscita immediata, e non arrivava MAI al
        // controllo dello stallo. Sonda del critico: pendente dopo 60 s, con il `setInterval`
        // che gira in eterno, l'AudioContext non chiuso e l'object URL non revocato.
        MediaRecorderFinto.senzaOnstop = true;
        const { esito } = await avvia();
        await pompa(3);
        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();

        expect(registratore().arresti, 'la consegna è stata CHIESTA').toBe(1);
        expect(esito.esito.stato).toBe('pendente');

        await vi.advanceTimersByTimeAsync(14_000);
        expect(esito.esito.stato, 'a 14 s si aspetta ancora: `stop()` può metterci').toBe('pendente');

        await vi.advanceTimersByTimeAsync(2_000);
        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'registratore-stop-senza-onstop',
        });
        // E la pulizia avviene comunque: è il punto di avere una chiusura sola.
        expect(url.revocati).toHaveLength(1);
        expect(audio.chiusure).toBe(1);
    });

    it('nessun evento dopo `el.src`: → metadati-mancanti (l\'HEVC che il decoder non apre)', async () => {
        // Il commento del codice lo dice da sempre — «`onloadedmetadata` non scatta mai» — e
        // l'unica uscita era `el.onerror`, che è esattamente ciò che su iOS non è affidabile.
        // Sonda del critico: pendente dopo 10 MINUTI simulati.
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        // `prepara` serve solo a dare a jsdom un `pause()` che esiste: nessun evento viene
        // emesso, che è tutto il punto del caso.
        prepara(videoCreato());

        await vi.advanceTimersByTimeAsync(19_000);
        expect(esito.esito.stato).toBe('pendente');

        await vi.advanceTimersByTimeAsync(2_000);
        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'metadati-mancanti',
        });
        expect(url.revocati).toHaveLength(1);
        expect(MediaRecorderFinto.ultimo).toBeNull();
    });

    it('`resume()` dell\'audio che non risolve MAI → preparazione-in-stallo', async () => {
        // La preparazione è `async` e il watchdog nasceva DENTRO di lei, dopo l'`await` del
        // `resume`: un contesto audio che non risponde lasciava la conversione senza nessuna
        // sorveglianza. Il `punto` è suo e non `primo-fotogramma-mancante`, perché in `app_log`
        // un guasto contato nella colonna sbagliata è il dato sbagliato.
        audio.resumeNonRisolve = true;
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        const video = videoCreato();
        prepara(video);
        video.dispatchEvent(new Event('loadedmetadata'));
        await scorri();

        expect(audio.resumeChiamate).toBe(1);
        await vi.advanceTimersByTimeAsync(14_000);
        expect(esito.esito.stato).toBe('pendente');

        await vi.advanceTimersByTimeAsync(2_000);
        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'preparazione-in-stallo',
        });
        expect(MediaRecorderFinto.ultimo?.avvii ?? 0).toBe(0);
    });

    it('il PRIMO FOTOGRAMMA che non arriva mai → primo-fotogramma-mancante', async () => {
        // È l'attesa introdotta dalla sequenza corretta (`play` → primo fotogramma → disegna →
        // `start`): senza il ramo che la sorveglia, la promise resta appesa per sempre e
        // l'insegnante guarda una rotellina eterna. Nessun `rvfc`, `readyState: 0`, e nessuno
        // dei tre eventi di ripiego.
        const { esito } = await avvia({ readyState: 0 });
        expect(traccia, 'la registrazione non è mai partita').not.toContain('start');

        await vi.advanceTimersByTimeAsync(9_000);
        expect(esito.esito.stato).toBe('pendente');

        await vi.advanceTimersByTimeAsync(2_000);
        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'primo-fotogramma-mancante',
        });
        expect(righeLog('gallery-video-conversione-interrotta')[0].campi?.punto)
            .toBe('primo-fotogramma-mancante');
    });

    it('gli ascoltatori del primo fotogramma si STACCANO quando chiude il watchdog', async () => {
        // `chiudi` stacca `visibilitychange` e l'ascoltatore nativo, ma non questi tre: per ogni
        // video rifiutato su questo punto restavano agganciati all'elemento, tenendo in vita per
        // riferimento elemento, tela e chiusure — e `preparaEAvvia` restava sospesa per sempre.
        const { esito } = await avvia({ readyState: 0 });
        expect([vivi('loadeddata'), vivi('seeked'), vivi('timeupdate')]).toEqual([1, 1, 1]);

        await vi.advanceTimersByTimeAsync(11_000);
        expect(esito.esito.stato).toBe('rigettata');
        expect([vivi('loadeddata'), vivi('seeked'), vivi('timeupdate')]).toEqual([0, 0, 0]);
    });

    it('il watermark che non arriva MAI non appende niente: si converte SENZA logo', async () => {
        // `new Image()` non ha nessun tetto, e una richiesta appesa nella WebView non consegna
        // né `load` né `error`: prima di questo giro non partiva NIENTE, per sempre. Scaduta
        // l'attesa si prosegue senza watermark — che è già ciò che fa `wm.onerror`, perché un
        // logo mancante non è un video perso.
        wm.maiCaricato = true;
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        expect(creati.video ?? [], 'fermi sul logo: nessun <video> ancora').toHaveLength(0);

        await vi.advanceTimersByTimeAsync(11_000);
        const video = videoCreato();
        prepara(video);
        video.dispatchEvent(new Event('loadedmetadata'));
        await scorri();
        await pompa(3);
        statoVideo.ended = true;
        video.dispatchEvent(new Event('ended'));
        await scorri();

        expect(esito.esito.stato).toBe('risolta');
        expect(righeLog('watermark-video-in-stallo')).toHaveLength(1);
        // Un solo `drawImage` per giro, sempre con la geometria del VIDEO: il logo non c'è.
        expect([...new Set(ctxFinto.disegni)]).toEqual(['0,0,640,360']);
    });

    it('una registrazione di ZERO byte non diventa un File: registrazione-vuota', async () => {
        // L'involucro giusto e niente dentro: la forma più pura del difetto per cui esiste
        // questo giro. `validateVideoFile` guarda `type` e `size`, e un `File` di 0 byte con
        // `type: video/mp4` gli sembra in ordine.
        MediaRecorderFinto.senzaPezzi = true;
        const { esito } = await avvia();
        await pompa(3);
        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'registrazione-vuota',
        });
        expect(righeLog('gallery-video-conversione-riuscita')).toHaveLength(0);
    });

    it('un `error` SUBITO dopo i metadati è già `video-errore-durante-conversione`', async () => {
        // La riassegnazione dell'handler stava a metà di `preparaEAvvia`, dopo l'`await` del
        // `resume` dell'audio: un `error` che arrivasse in quella finestra veniva contato come
        // `video-metadati-illeggibili`, cioè nella colonna sbagliata di `app_log`. Il
        // significato dell'evento cambia NELL'ISTANTE in cui i metadati arrivano, non dieci
        // righe dopo — perciò i due eventi qui sono nello stesso giro, senza svuotare le
        // microtask in mezzo.
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();
        const video = videoCreato();
        prepara(video);
        video.dispatchEvent(new Event('loadedmetadata'));
        video.dispatchEvent(new Event('error'));
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'video-errore-durante-conversione',
        });
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * H — LA CONSEGNA, CHE È UN TRATTO A SÉ
 *
 * Fra `registratore.stop()` e `onstop` non si sta convertendo più niente e non si è ancora
 * consegnato: è il tratto in cui le regole degli altri tratti fanno danno se restano accese, e
 * in cui una seconda richiesta consegna un file tronco. I tre casi qui sotto inchiodano i tre
 * guard che lo tengono in piedi — provati uno per uno con dei mutanti: senza, restavano verdi.
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('il tratto fra `stop()` e `onstop`', () => {
    it('le regole del PROGRESSO tacciono mentre si aspetta `onstop` (o la colonna cambia)', async () => {
        // Un `ended` che arriva senza che la proprietà `ended` dell'elemento si alzi — accade
        // nelle WebView — e un `onstop` che non arriva. Se il watchdog continuasse a guardare il
        // progresso, tre secondi senza disegni diventerebbero `canvas-congelato`: un guasto
        // INVENTATO al posto di un'attesa legittima, e nel ramo LEGACY un ripiego silenzioso
        // sull'originale invece della conversione che stava per arrivare.
        MediaRecorderFinto.senzaOnstop = true;
        const { esito } = await avvia();
        await pompa(3);
        videoCreato().dispatchEvent(new Event('ended')); // `statoVideo.ended` resta `false`
        await scorri();
        expect(registratore().arresti, 'la consegna è stata chiesta').toBe(1);

        await vi.advanceTimersByTimeAsync(4_000);
        expect(esito.esito.stato, 'a 4 s si aspetta ancora `onstop`, non si accusa la tela').toBe('pendente');

        await vi.advanceTimersByTimeAsync(12_000);
        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'registratore-stop-senza-onstop',
        });
    });

    it('`onstop` è ASINCRONO: una seconda richiesta consegnerebbe un file TRONCO', async () => {
        // Nel browser vero `stop()` ritorna subito e mette `state` a `inactive`: una seconda
        // `consegna()` in quella finestra trova il registratore già spento, assembla i pezzi
        // raccolti FINO A QUEL MOMENTO e consegna un file senza il pezzo finale — durata giusta,
        // container giusto, contenuto mozzo. È il difetto di questo file, in miniatura.
        MediaRecorderFinto.onstopAsincrono = true;
        const { esito } = await avvia();
        const r = registratore();
        r.emetti(1_000);
        await pompa(2);
        statoVideo.ended = true;
        const video = videoCreato();
        video.dispatchEvent(new Event('ended'));
        video.dispatchEvent(new Event('ended')); // la seconda richiesta, con `onstop` in volo
        await vi.advanceTimersByTimeAsync(600);
        await scorri();

        expect(esito.esito.stato).toBe('risolta');
        const consegnato = esito.esito.stato === 'risolta' ? esito.esito.valore : null;
        // 1.000 + i 4.096 dell'ultimo pezzo, che arriva DOPO `stop()`.
        expect(consegnato?.size).toBe(5_096);
        expect(r.arresti, '`stop()` una volta sola').toBe(1);
    });

    it('il logo che arriva TARDI non fa partire una seconda conversione', async () => {
        // Una richiesta lenta che si sblocca dopo la scadenza: senza il guard sarebbero due
        // elementi `<video>`, due object URL e due registratori su una promise sola — cioè due
        // conversioni dello stesso file, sullo stesso telefono, per un logo in ritardo.
        wm.maiCaricato = true;
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        sorveglia(p);
        await scorri();
        await vi.advanceTimersByTimeAsync(11_000);
        expect(creati.video ?? []).toHaveLength(1);

        ImmagineFinta.ultima?.onload?.();
        await scorri();

        expect(creati.video ?? [], 'un solo <video>: la conversione non riparte').toHaveLength(1);
        expect(url.creati, 'un solo object URL').toHaveLength(1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════════════
 * I — LE DUE STRADE CHE NESSUN GESTORE RACCOGLIE
 *
 * `startProcessing` gira dentro `wm.onload` (un gestore del DOM) o dentro un tick del watchdog;
 * la pulizia di `chiudi` gira DOPO che `concluso` è stato alzato. In entrambi i posti
 * un'eccezione non la raccoglie nessuno: nel primo la promise resta appesa con il timer che gira
 * a vuoto, nel secondo resta appesa con la porta già chiusa per tutte le altre strade. Sono le
 * ultime due, e chiudono la frase «nessuna strada resta appesa».
 * ═══════════════════════════════════════════════════════════════════════════════════ */

describe('le eccezioni fuori da ogni gestore', () => {
    it('un avvio di preparazione che LANCIA rigetta: avvio-preparazione-fallito', async () => {
        creazioneVideoLancia = true;
        const file = fileVideo();
        const p = processVideoWithWatermark(file, '/watermark.png', MAX, { obbligatoria: true });
        const esito = sorveglia(p);
        await scorri();

        expect(esito.esito.stato).toBe('rigettata');
        expect(esito.esito.stato === 'rigettata' ? esito.esito.errore : null).toMatchObject({
            puntoDiFallimento: 'avvio-preparazione-fallito',
        });
        // E il watchdog non resta a girare su un'attesa del logo già consumata.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(esito.esito.stato).toBe('rigettata');
    });

    it('una pulizia che LANCIA non trattiene il verdetto', async () => {
        // `concluso` è già alzato quando la pulizia comincia: se un'eccezione qui saltasse il
        // verdetto, NESSUNA altra strada potrebbe più chiudere la promise — la porta è chiusa per
        // tutte. Fra una risorsa non liberata e una rotellina eterna si sceglie la perdita.
        sostituisci(URL, 'revokeObjectURL', {
            value: () => {
                throw new DOMException('revoke non permesso', 'SecurityError');
            },
            writable: true,
        });
        const { esito } = await avvia();
        await pompa(3);
        statoVideo.ended = true;
        videoCreato().dispatchEvent(new Event('ended'));
        await scorri();

        expect(esito.esito.stato).toBe('risolta');
        // Il verdetto è arrivato, e il guasto della pulizia non è muto.
        expect(righeLog('gallery-video-pulizia-fallita')).toHaveLength(1);
        expect(righeLog('gallery-video-conversione-riuscita')).toHaveLength(1);
    });
});
