import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { processImageWithWatermark, ImageProcessingError } from '@/lib/media/immagini';
import { nomeErrore } from '@/lib/logging/client';
import { POST as POST_LOGS } from '@/app/api/logs/route';
import { resetRateLimit } from '@/lib/security/rate-limit';
import type { RigaLog } from '@/lib/logging/app-log';

/**
 * LE FOTO VUOTE DELLA GALLERIA — il cancello sulla funzione che le ha prodotte.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════
 * IL GUASTO, MISURATO E NON DEDOTTO (produzione, letta il 2026-09-11)
 *
 *   SELECT count(*), count(DISTINCT metadata->>'eTag')
 *   FROM storage.objects
 *   WHERE bucket_id = 'gallery' AND (metadata->>'size')::bigint = 775;
 *   → 3 righe, 1 SOLO eTag: "6ffc8975fca58e4ec3d9ba87b3f0f672"
 *
 * Tre immagini di ESATTAMENTE 775 byte, dal 09/09 al 10/09, due insegnanti diverse, tutte
 * a Giugliano, pubblicate e visibili alle famiglie. Un md5 solo per tre file vuol dire che
 * non sono tre foto sfortunate: è lo STESSO file, byte per byte, prodotto tre volte. E
 * `6ffc8975…` è l'md5 che la riproduzione in laboratorio ottiene da una tela 1x1.
 *
 * ⚠️ LA PRIMA DIAGNOSI ERA SBAGLIATA, e va scritto perché è la parte istruttiva: si era
 * detto «canvas nero a 1920». Un JPEG uniformemente nero a 1920x1440 costa 20-35 KB. 775
 * byte non poteva essere quello. La frontiera misurata è questa, e dice che la tela è
 * MINUSCOLA, non nera:
 *
 *   lato 1-16 → 771 byte      lato 17-32 → 775 byte      lato 33+ → 779 byte
 *
 * Cioè 1x1, 8x8 e 16x16 danno tutti lo stesso file. Il codice di prima calcolava le
 * dimensioni da un `<img>` e non le guardava MAI: una dimensione degenere diventava
 * `canvas.width = 1`, e da lì un file pubblicato.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ I CASI SONO SCRITTI COSÌ: il test NON sa quale strada di decodifica prende
 * l'implementazione. Ogni caso configura `createImageBitmap` E `new Image()` con le STESSE
 * dimensioni, poi asserisce il COMPORTAMENTO. Così il cancello vale per la strada
 * principale e per il ripiego, e non diventa verde il giorno in cui una delle due cambia.
 *
 * ⚠️ L'ULTIMO GRUPPO — «il caso normale DEVE riuscire» — non è un riempitivo: una
 * correzione che rifiuta tutto non è una correzione, è un'interruzione del servizio. È
 * l'unico gruppo che distingue le due cose.
 * ══════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * `logClient` SOSTITUITO, `nomeErrore` NO — e le due scelte hanno la stessa ragione.
 *
 * `logClient` diventa una spia perché serve leggere COSA parte dal dispositivo: il nome di
 * un file di galleria è `IMG_bimba-rossi.jpg`, cioè l'anagrafica di un minore, e il caso
 * «nessun log porta il nome del file» in fondo a questo file è l'unico modo di misurarlo.
 * Il throttle del logger vero (`visti`, chiave `evento|messaggio|stato`) scarterebbe inoltre
 * il secondo caso identico e renderebbe i conteggi dipendenti dall'ordine dei test.
 *
 * `nomeErrore` invece resta QUELLO VERO (`importOriginal`): è la funzione di cui questo file
 * verifica il risultato — `'errore'` in produzione, `'ImageProcessingError'` dopo la
 * correzione. Riscriverne una copia qui sarebbe un finto che verifica un finto.
 */
const logSpy = vi.fn();
vi.mock('@/lib/logging/client', async (importOriginal) => {
    const reale = await importOriginal<typeof import('@/lib/logging/client')>();
    return { ...reale, logClient: (e: unknown) => { logSpy(e); } };
});

/**
 * IL SINK DI `app_log` SOSTITUITO — la spia che rende NON CIECO il collaudo dei campi.
 *
 * ⚠️ PERCHÉ NON BASTA GUARDARE L'ARGOMENTO DI `logClient`, ed è la lezione che è costata
 * una bocciatura a questo stesso file. La redazione dei `campi` è SERVER-SIDE: il browser
 * spedisce l'evento a `/api/logs`, che scrive `contestoExtra: { campi: redact(c.campi) }`
 * (route.ts:399). Un campo può quindi essere presente e perfettamente leggibile nella spia
 * di `logClient` e arrivare in tabella come `[redatto:str/6]` — cioè la colonna che le query
 * interrogano è vuota mentre il test è verde. La prima stesura asseriva
 * `expect(ok[0].campi?.strada).toBeTypeOf('string')` su un valore sempre presente per
 * costruzione: misurava che il chiamante avesse scritto qualcosa, non che qualcosa
 * arrivasse. È lo stesso difetto già pagato dal progetto con `piattaforma`, che per un mese
 * ha scritto `web` su ogni riga.
 *
 * La rete che serve è questa: si prende l'evento VERO che la funzione ha emesso, lo si
 * rispedisce alla route VERA e si legge `contesto.campi`. Il punto di osservazione è
 * `appLogBatch`, lo stesso del lock `logs-campi-redatti.test.ts`.
 */
const appLogBatch = vi.fn<(righe: RigaLog[]) => Promise<void>>(async () => {});
vi.mock('@/lib/logging/app-log', () => ({
    appLog: (riga: RigaLog) => appLogBatch([riga]),
    appLogBatch: (righe: RigaLog[]) => appLogBatch(righe),
}));

const WATERMARK = '/watermark.png';

/** Il nome di file del caso reale: contiene un nome proprio, e non deve uscire in nessun log. */
const NOME_CON_ANAGRAFICA = 'IMG_bimba-cognomefinto_4421.jpg';

type Campione = [number, number, number, number];

interface Opzioni {
    /** Le dimensioni che la decodifica dichiara. `'rigetta'`/`'errore'` = decodifica fallita. */
    dimensioni: { larghezza: number; altezza: number } | 'fallisce';
    /** `false` = `createImageBitmap` assente dal globale (si deve ripiegare su `new Image()`). */
    conCreateImageBitmap?: boolean;
    /** Il pixel restituito da `getImageData` nel punto (x, y). Il default VARIA col punto. */
    campione?: (x: number, y: number) => Campione;
    /** Il blob che `toBlob` consegna. `null` = codifica fallita. */
    blob?: Blob | null;
    /** Il watermark non carica (`wm.onerror`). */
    watermarkRotto?: boolean;
    /** `getContext('2d')` restituisce `null`. */
    senzaContesto2d?: boolean;
    /** `getImageData` lancia (tela illeggibile: succede, e non deve fermare la pubblicazione). */
    getImageDataLancia?: boolean;
}

interface Ambiente {
    createImageBitmap: ReturnType<typeof vi.fn>;
    drawImage: ReturnType<typeof vi.fn>;
    getImageData: ReturnType<typeof vi.fn>;
    toBlob: ReturnType<typeof vi.fn>;
    canvas: { width: number; height: number };
    /**
     * Le bitmap consegnate, nell'ordine in cui sono state create: `[0]` è quella a PIENA
     * RISOLUZIONE, `[1]` la ridotta. Serve a misurare QUANDO si liberano, non solo SE.
     */
    bitmaps: Array<{ close: ReturnType<typeof vi.fn> }>;
    /**
     * La cronologia delle operazioni sul canvas e delle chiusure. Il vantaggio dichiarato da
     * `createImageBitmap` — «la memoria si libera quando lo decidiamo noi» — è una
     * affermazione sull'ORDINE: senza questa traccia, una `close()` nel `finally` è
     * indistinguibile da una `close()` appena la bitmap non serve più, e il picco di memoria
     * su WKWebView resta quello di prima col commento che dice il contrario.
     */
    ordine: string[];
}

const creaElementoVero = document.createElement.bind(document);
const globale = globalThis as unknown as Record<string, unknown>;
let salvati: { createImageBitmap: unknown; Image: unknown; creaUrl: unknown; revocaUrl: unknown };

function blobDa(byte: number): Blob {
    return new Blob([new Uint8Array(byte)]);
}

/** Un `File` immagine con una `size` DICHIARATA: il corpo resta di 4 byte, la taglia è finta. */
function fileImmagine(byte: number, nome = NOME_CON_ANAGRAFICA, tipo = 'image/jpeg'): File {
    const f = new File([new Uint8Array(4)], nome, { type: tipo });
    Object.defineProperty(f, 'size', { value: byte });
    return f;
}

function ambiente(opz: Opzioni): Ambiente {
    const ordine: string[] = [];
    const bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const drawImage = vi.fn(() => {
        ordine.push('drawImage');
    });
    const getImageData = vi.fn((x: number, y: number) => {
        if (opz.getImageDataLancia) throw new Error('SecurityError finto');
        const p = opz.campione ? opz.campione(x, y) : ([x & 0xff, y & 0xff, 0x40, 0xff] as Campione);
        return { data: new Uint8ClampedArray(p) };
    });
    const toBlob = vi.fn((cb: (b: Blob | null) => void) => {
        ordine.push('toBlob');
        cb(opz.blob === undefined ? blobDa(500_000) : opz.blob);
    });

    const canvas = {
        width: 0,
        height: 0,
        getContext: (tipo: string) =>
            tipo === '2d' && !opz.senzaContesto2d ? { drawImage, getImageData, globalAlpha: 1 } : null,
        toBlob,
    };

    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
        tag === 'canvas' ? (canvas as unknown as HTMLCanvasElement) : creaElementoVero(tag)) as typeof document.createElement);

    // ── `new Image()`: il ripiego della decodifica E il watermark passano da qui. Si
    //    distinguono dalla `src` — il watermark ha un URL nostro, la foto un `blob:`.
    class ImmagineFinta {
        onload: (() => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        naturalWidth = 0;
        naturalHeight = 0;
        width = 0;
        height = 0;
        private valoreSrc = '';
        get src(): string {
            return this.valoreSrc;
        }
        set src(v: string) {
            this.valoreSrc = v;
            queueMicrotask(() => {
                if (v === WATERMARK) {
                    if (opz.watermarkRotto) {
                        this.onerror?.(new Event('error'));
                        return;
                    }
                    this.naturalWidth = this.width = 400;
                    this.naturalHeight = this.height = 100;
                    this.onload?.();
                    return;
                }
                if (opz.dimensioni === 'fallisce') {
                    // ⚠️ UN `Event`, NON UN `Error`: è ciò che il DOM passa davvero a
                    // `img.onerror`, ed è la ragione per cui in `app_log` esiste la riga
                    // `gallery-pubblicazione-fallita: errore` invece di un nome utile.
                    this.onerror?.(new Event('error'));
                    return;
                }
                this.naturalWidth = this.width = opz.dimensioni.larghezza;
                this.naturalHeight = this.height = opz.dimensioni.altezza;
                this.onload?.();
            });
        }
    }
    globale.Image = ImmagineFinta;

    const createImageBitmap = vi.fn(async (_sorgente: unknown, opzioni?: ImageBitmapOptions) => {
        if (opz.dimensioni === 'fallisce') {
            // Anche qui un non-`Error`: un ripiego che ne assume uno è un ripiego che salta.
            throw 'decodifica-non-riuscita';
        }
        const l = opzioni?.resizeWidth ?? opz.dimensioni.larghezza;
        const a = opzioni?.resizeHeight ?? opz.dimensioni.altezza;
        const indice = bitmaps.length;
        const close = vi.fn(() => {
            ordine.push(`close#${indice}`);
        });
        const bitmap = { width: l, height: a, close };
        bitmaps.push(bitmap);
        return bitmap as unknown as ImageBitmap;
    });
    if (opz.conCreateImageBitmap === false) delete globale.createImageBitmap;
    else globale.createImageBitmap = createImageBitmap;

    globale.URL = URL;
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:finto');
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();

    return { createImageBitmap, drawImage, getImageData, toBlob, canvas, bitmaps, ordine };
}

beforeEach(() => {
    logSpy.mockClear();
    appLogBatch.mockClear();
    appLogBatch.mockImplementation(async () => {});
    // La route ha un rate limit per IP: senza questo, il quinto caso di un gruppo riceve un 429
    // e il test misurerebbe il rate limit invece della redazione.
    resetRateLimit();
    salvati = {
        createImageBitmap: globale.createImageBitmap,
        Image: globale.Image,
        creaUrl: (URL as unknown as Record<string, unknown>).createObjectURL,
        revocaUrl: (URL as unknown as Record<string, unknown>).revokeObjectURL,
    };
});

afterEach(() => {
    vi.restoreAllMocks();
    globale.createImageBitmap = salvati.createImageBitmap;
    globale.Image = salvati.Image;
    (URL as unknown as Record<string, unknown>).createObjectURL = salvati.creaUrl;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = salvati.revocaUrl;
});

interface EventoSpedito {
    livello: 'warn' | 'error';
    evento: string;
    messaggio: string;
    campi?: Record<string, unknown>;
}

/** Tutti gli eventi che il dispositivo ha spedito, nell'ordine. */
function eventiSpediti(): EventoSpedito[] {
    return logSpy.mock.calls.map((c) => c[0] as EventoSpedito);
}

/** I `campi` dell'ultimo evento che dichiara un rifiuto. */
function campiDelRifiuto(): Record<string, unknown> | undefined {
    return eventiSpediti()
        .filter((e) => typeof e.messaggio === 'string' && e.messaggio.startsWith('immagine-rifiutata'))
        .at(-1)?.campi;
}

/** I `campi` dell'evento di successo. */
function campiElaborata(): Record<string, unknown> | undefined {
    return eventiSpediti().find((e) => e.messaggio === 'immagine-elaborata')?.campi;
}

/** Il primo evento il cui messaggio comincia così. */
function eventoCon(prefisso: string): EventoSpedito {
    const e = eventiSpediti().find((x) => typeof x.messaggio === 'string' && x.messaggio.startsWith(prefisso));
    // Un `undefined` qui sarebbe un test che asserisce sul vuoto: meglio rosso adesso.
    expect(e, `nessun evento con messaggio «${prefisso}…»`).toBeDefined();
    return e as EventoSpedito;
}

/**
 * I `campi` di un evento COME ARRIVANO IN TABELLA: spediti alla route VERA, letti da
 * `contesto.campi` dopo il `redact` VERO. È il solo punto di osservazione che dica se la
 * diagnosi si potrà leggere in SQL, o se la colonna conterrà `[redatto:str/N]`.
 */
async function campiInTabella(e: EventoSpedito): Promise<Record<string, unknown>> {
    appLogBatch.mockClear();
    resetRateLimit();
    const res = await POST_LOGS(
        new Request('http://localhost/api/logs', {
            method: 'POST',
            body: JSON.stringify({ eventi: [{ livello: e.livello, evento: e.evento, messaggio: e.messaggio, campi: e.campi }] }),
            headers: { 'content-type': 'application/json' },
        }),
    );
    expect(res.status).toBe(200);
    const righe = appLogBatch.mock.calls.flatMap((c) => c[0]);
    return (righe[0]?.contestoExtra?.campi ?? {}) as Record<string, unknown>;
}

// ══════════════════════════════════════════════════════════════════════════════════════
describe('la tela degenere non diventa più un file pubblicato', () => {
    // Ogni caso di questo gruppo, prima della correzione, RISOLVEVA con un `File`.
    const degeneri: [string, number, number][] = [
        ['0x0 — la decodifica non ha misurato niente', 0, 0],
        ['1x1 — È IL CASO DI PRODUZIONE: 775 byte, eTag 6ffc8975fca58e4ec3d9ba87b3f0f672', 1, 1],
        ['8x8 — stessa frontiera: sotto i 17 px il file è identico', 8, 8],
        ['16x16 — l\'ultimo lato che produce 771 byte', 16, 16],
        ['63x63 — un pixel sotto la soglia: il confine dal lato che RIFIUTA', 63, 63],
        ['8000x2 — prima tornava l\'originale NON elaborato e senza un log', 8000, 2],
        ['2x8000 — lo stesso in verticale', 2, 8000],
    ];

    for (const [nome, larghezza, altezza] of degeneri) {
        it(`${nome} → RIGETTO per dimensioni-degeneri`, async () => {
            ambiente({ dimensioni: { larghezza, altezza } });
            const err = await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch((e) => e);
            expect(err).toBeInstanceOf(ImageProcessingError);
            // ⚠️ IL `motivo` SI ASSERISCE, e non è pedanteria: la prova di mutazione dice che
            // senza questa riga il caso resta VERDE anche togliendo il controllo sulle
            // dimensioni. Una tela 1x1 viene rifiutata comunque, un passo più in là, dalla
            // verifica «non è vuota» — nove campioni su un pixel sono per forza identici. Il
            // `toBeInstanceOf` da solo misurava quindi la SOMMA delle reti, e restava verde
            // mentre si smontava quella che chiude la causa radice.
            expect((err as ImageProcessingError).motivo).toBe('dimensioni-degeneri');
        });
    }

    it('64x64 — il confine dal lato che PASSA (senza di questo il test non distingue > da >=)', async () => {
        ambiente({ dimensioni: { larghezza: 64, altezza: 64 } });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).resolves.toBeInstanceOf(File);
    });

    it('8000x64: la soglia la sfonda solo la DESTINAZIONE (1920x15), e il log porta le due coppie', async () => {
        // 8000x64 → il ridimensionamento a 1920 porta l'altezza a round(64*1920/8000) = 15.
        // Guardare solo la sorgente lascerebbe passare una tela alta 15 px.
        ambiente({ dimensioni: { larghezza: 8000, altezza: 64 } });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toMatchObject({
            motivo: 'dimensioni-degeneri',
        });
        expect(campiDelRifiuto()).toMatchObject({
            larghezza: 8000,
            altezza: 64,
            larghezza_uscita: 1920,
            altezza_uscita: 15,
        });
    });

    it('il motivo è enum-like e le dimensioni finiscono nei campi del log', async () => {
        ambiente({ dimensioni: { larghezza: 1, altezza: 1 } });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toMatchObject({
            name: 'ImageProcessingError',
            motivo: 'dimensioni-degeneri',
        });
        // `esito` e non `motivo`: sotto `motivo` la lista bianca di `redact` non lo farebbe
        // mai uscire in chiaro (è in `RADICI_TESTO_LIBERO`). Vedi il gruppo «la diagnosi
        // arriva LEGGIBILE in app_log», che lo misura passando dalla route vera.
        expect(campiDelRifiuto()).toMatchObject({ esito: 'dimensioni-degeneri', larghezza: 1, altezza: 1 });
    });

    it('il rigetto NON produce un File: la pubblicazione si ferma prima dello Storage', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 1, altezza: 1 } });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toThrow();
        // Il guasto si riconosce da qui: prima si arrivava fino a `toBlob`.
        expect(amb.toBlob).not.toHaveBeenCalled();
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('la verifica «non è vuota» corre PRIMA del watermark', () => {
    const UNIFORME = () => [0, 0, 0, 255] as Campione;

    it('nove campioni identici → RIGETTO tela-vuota', async () => {
        ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, campione: UNIFORME });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toMatchObject({
            motivo: 'tela-vuota',
        });
    });

    it('una tela TRASPARENTE (il disegno non è avvenuto) è vuota quanto una nera', async () => {
        ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, campione: () => [0, 0, 0, 0] });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toMatchObject({
            motivo: 'tela-vuota',
        });
    });

    it('il watermark NON è stato disegnato: verificarlo DOPO dichiarerebbe buona una tela vuota', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, campione: UNIFORME });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toThrow();
        // Un solo `drawImage`: la foto. Il secondo sarebbe il watermark.
        expect(amb.drawImage).toHaveBeenCalledTimes(1);
    });

    it('i campioni sono nove e stanno DENTRO la tela', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, campione: UNIFORME });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toThrow();
        expect(amb.getImageData).toHaveBeenCalledTimes(9);
        for (const [x, y] of amb.getImageData.mock.calls as [number, number][]) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(y).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThan(1920);
            expect(y).toBeLessThan(1440);
        }
    });

    it('UN solo campione diverso basta a dichiararla piena (niente falsi rifiuti)', async () => {
        ambiente({
            dimensioni: { larghezza: 1920, altezza: 1440 },
            campione: (x, y) => (x > 900 && y > 700 ? [12, 34, 56, 255] : [0, 0, 0, 255]),
        });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).resolves.toBeInstanceOf(File);
    });

    it('una tela ILLEGGIBILE non ferma la pubblicazione, ma lascia un log', async () => {
        // `getImageData` può lanciare. Rifiutare qui bloccherebbe ogni caricamento su un
        // motore che non permette la rilettura: la causa radice la chiude il controllo sulle
        // dimensioni, questo è difesa in profondità e sa degradare.
        ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, getImageDataLancia: true });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).resolves.toBeInstanceOf(File);
        const messaggi = logSpy.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
        expect(messaggi).toContain('immagine-verifica-tela-illeggibile');
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('il pavimento sui byte', () => {
    it('800 byte in uscita da un ingresso di 3 MB → RIGETTO byte-implausibili', async () => {
        ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, blob: blobDa(800) });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toMatchObject({
            motivo: 'byte-implausibili',
        });
        expect(campiDelRifiuto()).toMatchObject({ byte_uscita: 800, byte_ingresso: 3_000_000 });
    });

    it('4.095 byte → rifiutati; 4.096 → passano (il confine dai due lati)', async () => {
        ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, blob: blobDa(4_095) });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toMatchObject({
            motivo: 'byte-implausibili',
        });
        ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, blob: blobDa(4_096) });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).resolves.toBeInstanceOf(File);
    });

    it('800 byte da un ingresso di 2 KB NON è un guasto: una miniatura vera passa', async () => {
        // Il pavimento vale a fronte di un ingresso GRANDE. Senza questa condizione una
        // piccola immagine legittima verrebbe rifiutata, e il rimedio sarebbe peggiore.
        ambiente({ dimensioni: { larghezza: 200, altezza: 150 }, blob: blobDa(800) });
        await expect(processImageWithWatermark(fileImmagine(2_048), WATERMARK)).resolves.toBeInstanceOf(File);
    });

    it('`toBlob` che consegna null non torna più l\'originale in silenzio', async () => {
        ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, blob: null });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toMatchObject({
            motivo: 'codifica-jpeg-fallita',
        });
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('la decodifica fallita rigetta con un Error VERO', () => {
    it('senza createImageBitmap, `img.onerror` → rejects.toBeInstanceOf(Error)', async () => {
        // ⚠️ È IL CASO ROSSO PRIMA DELLA CORREZIONE: `reject(err)` passava l'`Event` del DOM.
        ambiente({ dimensioni: 'fallisce', conCreateImageBitmap: false });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toBeInstanceOf(Error);
    });

    it('`nomeErrore` smette di dire «errore»: in app_log si leggerà ImageProcessingError', async () => {
        // È la riga di produzione `gallery-pubblicazione-fallita: errore`, chiusa qui:
        // `nomeErrore` restituisce 'errore' per tutto ciò che non è un `Error`.
        ambiente({ dimensioni: 'fallisce', conCreateImageBitmap: false });
        const err = await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch((e) => e);
        expect(nomeErrore(err)).toBe('ImageProcessingError');
        expect(err).toMatchObject({ motivo: 'immagine-non-decodificata' });
    });

    it('il messaggio è leggibile da un insegnante e cita il codice', async () => {
        // La pagina mostra `err.message` così com\'è (`alert(err instanceof Error && …)`):
        // se è vuoto, l\'insegnante legge il messaggio generico e nessuno sa quale foto.
        ambiente({ dimensioni: 'fallisce', conCreateImageBitmap: false });
        const err = (await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch((e) => e)) as Error;
        expect(err.message.length).toBeGreaterThan(20);
        expect(err.message).toContain('immagine-non-decodificata');
    });

    it('createImageBitmap che rigetta con un NON-Error: si ripiega, e se cede anche quello è un Error', async () => {
        ambiente({ dimensioni: 'fallisce' });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).rejects.toBeInstanceOf(Error);
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('il caso normale DEVE riuscire', () => {
    it('1000x800 → un File image/jpeg, col nome portato a .jpg', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 } });
        const out = await processImageWithWatermark(fileImmagine(3_000_000, 'foto.png'), WATERMARK);
        expect(out).toBeInstanceOf(File);
        expect(out.type).toBe('image/jpeg');
        expect(out.name).toBe('foto.jpg');
        expect(out.size).toBe(500_000);
    });

    it('la tela ha le dimensioni della DESTINAZIONE, non quelle della sorgente', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 4032, altezza: 3024 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        expect(amb.canvas.width).toBe(1920);
        expect(amb.canvas.height).toBe(1440);
    });

    it('il ridimensionamento lo fa il DECODIFICATORE: createImageBitmap con resizeQuality high', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 4032, altezza: 3024 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        const conOpzioni = amb.createImageBitmap.mock.calls.filter((c) => c[1] !== undefined);
        expect(conOpzioni.length).toBeGreaterThan(0);
        expect(conOpzioni.at(-1)?.[1]).toMatchObject({
            resizeWidth: 1920,
            resizeHeight: 1440,
            resizeQuality: 'high',
        });
    });

    it('un\'immagine già sotto il tetto non paga una seconda decodifica', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 1000, altezza: 800 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        expect(amb.createImageBitmap).toHaveBeenCalledTimes(1);
    });

    it('senza createImageBitmap si ripiega su new Image() e riesce comunque', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 }, conCreateImageBitmap: false });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).resolves.toBeInstanceOf(File);
    });

    it('il successo lascia UNA riga di log: senza, «zero foto vuote» non si distingue da «non gira più»', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        const ok = logSpy.mock.calls
            .map((c) => c[0] as { messaggio: string; campi?: Record<string, unknown> })
            .filter((e) => e.messaggio === 'immagine-elaborata');
        expect(ok).toHaveLength(1);
        expect(ok[0].campi).toMatchObject({ byte_ingresso: 3_000_000, byte_uscita: 500_000 });
        // ⚠️ QUI STAVA `expect(ok[0].campi?.strada).toBeTypeOf('string')`, e non misurava
        // niente: il valore è sempre presente nell'argomento di `logClient` per costruzione.
        // Il valore VERO — quello che arriva in tabella dopo il `redact` server-side — si
        // asserisce nel gruppo «la diagnosi arriva LEGGIBILE in app_log».
        expect(Object.values(await campiInTabella(ok[0] as EventoSpedito))).toContain('bitmap');
    });

    it('un watermark che non carica non blocca la pubblicazione', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 }, watermarkRotto: true });
        await expect(processImageWithWatermark(fileImmagine(3_000_000), WATERMARK)).resolves.toBeInstanceOf(File);
        const messaggi = logSpy.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
        expect(messaggi).toContain('watermark-immagine-non-caricato');
    });

    it('un file NON immagine torna intatto (e non muto)', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 } });
        const pdf = new File([new Uint8Array(4)], 'modulo.pdf', { type: 'application/pdf' });
        await expect(processImageWithWatermark(pdf, WATERMARK)).resolves.toBe(pdf);
        expect(logSpy).toHaveBeenCalled();
    });

    it('senza contesto 2d torna l\'originale, ma lo dice', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 }, senzaContesto2d: true });
        const file = fileImmagine(3_000_000);
        await expect(processImageWithWatermark(file, WATERMARK)).resolves.toBe(file);
        const messaggi = logSpy.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio);
        expect(messaggi).toContain('immagine-canvas-2d-non-disponibile');
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('la diagnosi arriva LEGGIBILE in app_log, non come [redatto:str/N]', () => {
    /**
     * ⚠️ QUESTO GRUPPO ESISTE PERCHÉ UNA VERSIONE DI QUESTO FILE ERA CIECA. Asseriva
     * `campi.strada` sull'argomento di `logClient`, dove il valore c'è sempre; la redazione
     * avviene dopo, in `/api/logs`. Misurato eseguendo il `redact` vero:
     *
     *   { motivo:'dimensioni-degeneri', strada:'bitmap', fase:'img_onerror' }
     *   → { motivo:'[redatto:str/19]', strada:'[redatto:str/6]', fase:'[redatto:str/11]' }
     *
     * Due cause, entrambe in `redact.ts`: `strada` e `fase` non sono in `CHIAVI_IN_CHIARO`,
     * quindi cadono in `redigiStringa` (`stringaAutoDescrittiva` passa SOLO uuid e date ISO);
     * `motivo` è dentro `RADICI_TESTO_LIBERO`, e «la CHIAVE decide, e decide per prima» —
     * sotto quel nome non uscirà in chiaro MAI.
     *
     * La correzione NON allarga la lista bianca (allargarla aprirebbe anche un canale
     * anonimo: `redact` gira sul body grezzo di chiunque sappia fare una POST). Usa i nomi
     * che il repo ha già e che la lista bianca ammette — la coppia `operazione` + `esito` di
     * `notifiche/triggers.ts` e `notifiche/destinatari.ts`, più `canale`.
     */
    const casi: [string, Opzioni][] = [
        ['1x1, il caso di produzione', { dimensioni: { larghezza: 1, altezza: 1 } }],
        ['tela vuota', { dimensioni: { larghezza: 1920, altezza: 1440 }, campione: () => [0, 0, 0, 255] }],
        ['byte implausibili', { dimensioni: { larghezza: 1920, altezza: 1440 }, blob: blobDa(800) }],
        ['codifica JPEG fallita', { dimensioni: { larghezza: 1920, altezza: 1440 }, blob: null }],
        ['decodifica fallita dal ripiego <img>', { dimensioni: 'fallisce', conCreateImageBitmap: false }],
        ['createImageBitmap che cede', { dimensioni: 'fallisce' }],
        ['tela illeggibile', { dimensioni: { larghezza: 1000, altezza: 800 }, getImageDataLancia: true }],
        ['successo con riscalatura', { dimensioni: { larghezza: 4032, altezza: 3024 } }],
    ];

    for (const [nome, opz] of casi) {
        it(`${nome}: NESSUN campo perde il proprio valore passando dal redact vero`, async () => {
            ambiente(opz);
            await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch(() => undefined);

            const conCampi = eventiSpediti().filter((e) => e.campi && Object.keys(e.campi).length > 0);
            expect(conCampi.length, 'nessun evento porta campi: non c\'è diagnosi da misurare').toBeGreaterThan(0);

            for (const e of conCampi) {
                const arrivati = await campiInTabella(e);
                // Le CHIAVI arrivano tutte: se `redact` ne rinominasse una
                // (`[chiave-redatta:N]`) la query non la troverebbe comunque.
                expect(Object.keys(arrivati).sort(), `chiavi di «${e.messaggio}»`).toEqual(
                    Object.keys(e.campi as Record<string, unknown>).sort(),
                );
                // E i VALORI arrivano IDENTICI: né redatti, né troncati, né hashati.
                for (const [k, v] of Object.entries(e.campi as Record<string, unknown>)) {
                    expect(arrivati[k], `«${e.messaggio}» → campo ${k}`).toEqual(v);
                }
            }
        });
    }

    it('la STRADA della decodifica si legge in tabella (usciva `[redatto:str/6]`)', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        const arrivati = await campiInTabella(eventoCon('immagine-elaborata'));
        // Si asserisce il VALORE e non il nome del campo: è il valore che una query legge, e
        // un nome di campo diverso va bene purché il valore arrivi.
        expect(Object.values(arrivati)).toContain('bitmap');
    });

    it('il RIPIEGO si distingue dalla strada principale anche in tabella', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 }, conCreateImageBitmap: false });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        const arrivati = await campiInTabella(eventoCon('immagine-elaborata'));
        // Senza questo, «`bitmap` su ogni riga» sarebbe indistinguibile da «il campo non
        // porta informazione»: è il difetto di `piattaforma`, che scrisse `web` per un mese.
        expect(Object.values(arrivati)).toContain('img');
    });

    it('la FASE del fallimento si legge in tabella (usciva `[redatto:str/11]`)', async () => {
        ambiente({ dimensioni: 'fallisce', conCreateImageBitmap: false });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch(() => undefined);
        const arrivati = await campiInTabella(eventoCon('immagine-rifiutata'));
        expect(Object.values(arrivati)).toContain('img_onerror');
    });

    it('il MOTIVO si raggruppa in SQL: in chiaro nei campi, E dentro il messaggio', async () => {
        ambiente({ dimensioni: { larghezza: 1, altezza: 1 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch(() => undefined);
        const rifiuto = eventoCon('immagine-rifiutata');
        // Nel messaggio perché la deduplica di `logClient` ha per chiave
        // `evento|messaggio|stato`: motivi diversi in un messaggio unico collasserebbero.
        expect(rifiuto.messaggio).toContain('dimensioni-degeneri');
        // E nei campi perché `GROUP BY contesto->'campi'->>…` non legge il messaggio.
        expect(Object.values(await campiInTabella(rifiuto))).toContain('dimensioni-degeneri');
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('`tela_verificata` dice se la rete 2 ha corso davvero', () => {
    // ⚠️ SENZA QUESTI DUE CASI la mutazione `tela_verificata: vuota === false` → `true`
    // sopravvive: il campo dichiara «rete 2 passata» anche quando `getImageData` ha lanciato,
    // e nessun test se ne accorge. Un campo che mente è peggio di un campo assente.
    it('false quando la tela NON si è potuta rileggere', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 }, getImageDataLancia: true });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        expect(campiElaborata()?.tela_verificata).toBe(false);
    });

    it('true quando la tela è stata riletta e trovata piena', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        expect(campiElaborata()?.tela_verificata).toBe(true);
    });

    it('il booleano arriva intatto in tabella', async () => {
        ambiente({ dimensioni: { larghezza: 1000, altezza: 800 }, getImageDataLancia: true });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        expect(await campiInTabella(eventoCon('immagine-elaborata'))).toMatchObject({ tela_verificata: false });
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('la bitmap a piena risoluzione si libera QUANDO non serve più', () => {
    it('chiusa PRIMA del watermark e della codifica JPEG, non nel finally', async () => {
        // La testata di `decodifica` promette «la memoria si libera quando lo decidiamo noi,
        // con `close()`, invece che quando il GC passa su un `<img>`». Tenerla viva fino al
        // `finally` la libera a funzione finita, cioè esattamente come prima: su una foto da
        // 12 Mpixel sono ~48 MB tenuti in vita accanto agli ~11 MB della ridotta e agli ~11
        // della tela, nel momento di massima pressione su WKWebView.
        const amb = ambiente({ dimensioni: { larghezza: 4032, altezza: 3024 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);

        expect(amb.bitmaps).toHaveLength(2); // piena risoluzione + ridotta dal decodificatore
        const chiusuraPiena = amb.ordine.indexOf('close#0');
        expect(chiusuraPiena, 'la bitmap a piena risoluzione non è mai stata chiusa').toBeGreaterThanOrEqual(0);
        expect(chiusuraPiena).toBeLessThan(amb.ordine.indexOf('toBlob'));
        // E anche prima del `drawImage`: se fosse dopo, si sarebbe disegnato dalla bitmap
        // grande e la riscalatura del decodificatore non servirebbe a niente.
        expect(chiusuraPiena).toBeLessThan(amb.ordine.indexOf('drawImage'));
    });

    it('ognuna si chiude UNA volta sola: la doppia chiusura passerebbe da un log d\'errore', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 4032, altezza: 3024 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        expect(amb.bitmaps[0].close).toHaveBeenCalledTimes(1);
        expect(amb.bitmaps[1].close).toHaveBeenCalledTimes(1);
        const messaggi = eventiSpediti().map((e) => e.messaggio);
        expect(messaggi).not.toContain('immagine-chiusura-sorgente-fallita');
    });

    it('senza riscalatura la sola bitmap si chiude comunque, alla fine', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 1000, altezza: 800 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK);
        expect(amb.bitmaps).toHaveLength(1);
        expect(amb.bitmaps[0].close).toHaveBeenCalledTimes(1);
        expect(amb.ordine.indexOf('close#0')).toBeGreaterThan(amb.ordine.indexOf('toBlob'));
    });

    it('anche su un RIGETTO la bitmap si chiude: il `finally` resta la rete', async () => {
        const amb = ambiente({ dimensioni: { larghezza: 1920, altezza: 1440 }, campione: () => [0, 0, 0, 255] });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch(() => undefined);
        expect(amb.bitmaps[0].close).toHaveBeenCalledTimes(1);
    });
});

// ══════════════════════════════════════════════════════════════════════════════════════
describe('nei log non entra il nome del file — è il nome di un bambino', () => {
    const casi: [string, Opzioni][] = [
        ['rifiuto per dimensioni', { dimensioni: { larghezza: 1, altezza: 1 } }],
        ['rifiuto per tela vuota', { dimensioni: { larghezza: 1920, altezza: 1440 }, campione: () => [0, 0, 0, 255] }],
        ['rifiuto per byte', { dimensioni: { larghezza: 1920, altezza: 1440 }, blob: blobDa(800) }],
        ['decodifica fallita', { dimensioni: 'fallisce' }],
        ['successo', { dimensioni: { larghezza: 1000, altezza: 800 } }],
    ];

    for (const [nome, opz] of casi) {
        it(`${nome}: nessun frammento del nome del file in nessun evento`, async () => {
            ambiente(opz);
            await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch(() => undefined);
            const spedito = JSON.stringify(logSpy.mock.calls);
            expect(spedito).not.toContain('bimba');
            expect(spedito).not.toContain('cognomefinto');
            expect(spedito).not.toContain('4421');
            expect(spedito).not.toContain('.jpg');
        });
    }

    it('i campi restano dentro i limiti del canale (chiavi minuscole, al più 12)', async () => {
        ambiente({ dimensioni: { larghezza: 1, altezza: 1 } });
        await processImageWithWatermark(fileImmagine(3_000_000), WATERMARK).catch(() => undefined);
        for (const [evento] of logSpy.mock.calls as [{ campi?: Record<string, unknown> }][]) {
            const campi = evento.campi ?? {};
            expect(Object.keys(campi).length).toBeLessThanOrEqual(12);
            for (const [chiave, valore] of Object.entries(campi)) {
                expect(chiave).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
                expect(['string', 'number', 'boolean']).toContain(typeof valore);
                if (typeof valore === 'string') expect(valore.length).toBeLessThanOrEqual(64);
            }
        }
    });
});
