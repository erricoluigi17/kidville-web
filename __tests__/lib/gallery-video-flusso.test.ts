import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * V11 · IL FLUSSO VIDEO DELLA GALLERIA, LATO CLIENT — la parte che si può
 * collaudare senza un browser vero.
 *
 * ─── PERCHÉ È UN MODULO A SÉ E NON CODICE DENTRO LA PAGINA ──────────────────
 *
 * Il collaudo nel browser in locale è impossibile in questo repo: il middleware
 * rimanda al login e produce falsi verdi (memoria «collaudo_browser_locale_bloccato»).
 * L'unica copertura vera resta l'E2E in CI e il dispositivo. Quindi tutto ciò che
 * si PUÒ decidere fuori da React — quale sede dichiarare, quale chiave di
 * idempotenza, che cosa rifiutare prima di spedire due gigabyte, come si legge
 * un rifiuto del server — vive qui e si collauda qui.
 *
 * ─── LE TRE COSE CHE QUESTO FILE ESISTE PER TENERE FERME ────────────────────
 *
 *  1. **Nessun numero cablato.** I tetti sono quelli della pipeline
 *     (`MAX_VIDEO_INPUT_BYTES`, `MAX_VIDEO_DURATION_SECONDS`): il test li importa
 *     dalle stesse costanti, così non può restare verde su un numero copiato.
 *  2. **Il MIME può portare il suffisso del codec.** `video/mp4;codecs=avc1` è la
 *     forma che `MediaRecorder` consegna, e in questo repo un confronto per
 *     uguaglianza è già costato un giorno senza video (2026-09-08, 33 tentativi).
 *  3. **Ogni scrittura dichiara la sua sede.** `POST /api/video-uploads` pretende
 *     un uuid: indovinarlo significa archiviare il video nel plesso sbagliato in
 *     silenzio, che è il difetto per cui esiste `resolveScuolaScrittura`.
 *  4. **(T11c, #131) La chiave non lascia in tabella i bambini scelti, nemmeno come
 *     impronta.** È salata con 128 bit casuali per dispositivo (`saleDelDispositivo`):
 *     l'attacco per enumerazione che ritrovava i bambini dall'impronta di prima è
 *     riprodotto qui, e fallisce contro quella di oggi.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))

import { schemaAperturaIntentVideo } from '@/lib/media/video/contratto'
import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import * as flusso from '@/lib/gallery/video-galleria-flusso'
import {
  apriIntentoVideoGalleria,
  apriIntentoVideoGalleriaNativo,
  annullaIntentoVideo,
  chiaveIdempotenzaVideo,
  chiaveIdempotenzaVideoNativo,
  creaSaleDelDispositivo,
  durataVideoDalFile,
  intentoConcluso,
  leggiElencoVideoGalleria,
  leggiStatoIntentoVideo,
  rifiutoLocaleVideo,
  riprovaPubblicazioneVideo,
  sediDalCookie,
  sedeDelCaricamento,
  segnalaVideoCaricato,
  sha256Esadecimale,
} from '@/lib/gallery/video-galleria-flusso'
import itShared from '../../messages/it/shared.json'

const INTENTO = '11111111-0000-4000-8000-000000000001'
const JOB = '22222222-0000-4000-8000-000000000002'
const DOCENTE = '33333333-0000-4000-8000-000000000003'
const BAMBINO_A = '44444444-0000-4000-8000-000000000004'
const BAMBINO_B = '44444444-0000-4000-8000-000000000005'

/** Un `File` finto della taglia dichiarata: il contenuto non serve a nessuno di questi test. */
function fileVideo(opzioni: { byte?: number; tipo?: string; nome?: string; modificato?: number } = {}): File {
  const f = new File(['x'], opzioni.nome ?? 'recita.mp4', {
    type: opzioni.tipo ?? 'video/mp4',
    lastModified: opzioni.modificato ?? 1_726_000_000_000,
  })
  // `size` su un File di jsdom è la lunghezza del contenuto: qui serve dichiararla.
  Object.defineProperty(f, 'size', { value: opzioni.byte ?? 12_345_678 })
  return f
}

/** Una risposta finta: il corpo si legge una volta sola, come quello vero. */
function risposta(stato: number, corpo: unknown): Response {
  return {
    ok: stato >= 200 && stato < 300,
    status: stato,
    json: async () => corpo,
  } as unknown as Response
}

const COORDINATE = {
  protocollo: 'tus' as const,
  endpoint: 'https://esempio.supabase.co/storage/v1/upload/resumable/sign',
  bucket: 'video_originals' as const,
  percorso: `${DOCENTE}/abc.mp4`,
  contentType: 'video/mp4',
  dimensioneBloccoByte: 6 * 1024 * 1024 as 6291456,
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
// LA SEDE — «ogni scrittura dichiara la sua sede», e qui si decide quale
// ═══════════════════════════════════════════════════════════════════════════

describe('sedeDelCaricamento — non si indovina mai il plesso', () => {
  it('chi non è admin ha una sede sola: è quella del profilo', () => {
    expect(
      sedeDelCaricamento({ ruolo: 'educator', scuolaPrimaria: SEDE_A, sediSelezionate: [], sediAccessibili: null }),
    ).toBe(SEDE_A)
  })

  it('la sede SCELTA nel cockpit vince sul profilo, anche per un admin', () => {
    expect(
      sedeDelCaricamento({ ruolo: 'admin', scuolaPrimaria: SEDE_A, sediSelezionate: [SEDE_B], sediAccessibili: [SEDE_A, SEDE_B] }),
    ).toBe(SEDE_B)
  })

  it('un admin con più sedi e NESSUNA scelta non riceve un plesso a caso: riceve null', () => {
    expect(
      sedeDelCaricamento({ ruolo: 'admin', scuolaPrimaria: SEDE_A, sediSelezionate: [], sediAccessibili: [SEDE_A, SEDE_B] }),
    ).toBeNull()
  })

  it('due sedi selezionate insieme sono un’ambiguità, non una scelta', () => {
    expect(
      sedeDelCaricamento({ ruolo: 'admin', scuolaPrimaria: SEDE_A, sediSelezionate: [SEDE_A, SEDE_B], sediAccessibili: [SEDE_A, SEDE_B] }),
    ).toBeNull()
  })

  it('un admin di UN solo plesso non viene bloccato: la sede è quella', () => {
    expect(
      sedeDelCaricamento({ ruolo: 'admin', scuolaPrimaria: null, sediSelezionate: [], sediAccessibili: [SEDE_A] }),
    ).toBe(SEDE_A)
  })

  it('un admin di cui NON si sa l’elenco delle sedi non riceve la primaria per ripiego', () => {
    // ⚠️ QUESTO CASO È NATO DA UNA MUTAZIONE SOPRAVVISSUTA. Togliendo la guardia
    // `ruolo !== 'admin'` dal ripiego sulla sede del profilo, i cinque casi qui
    // sopra restavano tutti verdi: nessuno di loro lascia `sediAccessibili` a
    // `null` per un admin, che è proprio la situazione in cui la guardia serve —
    // `/api/admin/sedi` non ha risposto, l'elenco non si sa, e la primaria di un
    // admin di tre plessi NON è «l'unica sua sede». Senza questa riga il video
    // finirebbe a Giugliano mentre l'insegnante pensa di essere ad Aversa, che è
    // il difetto misurato il 2026-07-31.
    expect(
      sedeDelCaricamento({ ruolo: 'admin', scuolaPrimaria: SEDE_A, sediSelezionate: [], sediAccessibili: null }),
    ).toBeNull()
  })

  it('senza profilo e senza elenco non si inventa niente', () => {
    expect(
      sedeDelCaricamento({ ruolo: 'educator', scuolaPrimaria: null, sediSelezionate: [], sediAccessibili: null }),
    ).toBeNull()
  })

  it('legge il cookie `sedi_attive` nella forma in cui lo scrive il cockpit', () => {
    expect(sediDalCookie(`kv=1; sedi_attive=${SEDE_A}%2C${SEDE_B}; altro=x`)).toEqual([SEDE_A, SEDE_B])
    expect(sediDalCookie('altro=x')).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// IL RIFIUTO LOCALE — prima di spedire due gigabyte da un telefono
// ═══════════════════════════════════════════════════════════════════════════

describe('rifiutoLocaleVideo — i tetti sono quelli della pipeline, non copie', () => {
  it('accetta un video dentro i limiti, suffisso del codec compreso', () => {
    expect(rifiutoLocaleVideo(fileVideo({ tipo: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' }), 42)).toBeNull()
  })

  it('un file vuoto non è un video', () => {
    expect(rifiutoLocaleVideo(fileVideo({ byte: 0 }), null)).toBe('VIDEO_FILE_NON_VALIDO')
  })

  it('oltre `MAX_VIDEO_INPUT_BYTES` si dice subito, non dopo il caricamento', () => {
    expect(rifiutoLocaleVideo(fileVideo({ byte: MAX_VIDEO_INPUT_BYTES + 1 }), null)).toBe('VIDEO_TROPPO_GRANDE')
    // Il confine ESATTO passa: un `>=` al posto di un `>` rifiuterebbe un file valido.
    expect(rifiutoLocaleVideo(fileVideo({ byte: MAX_VIDEO_INPUT_BYTES }), null)).toBeNull()
  })

  it('oltre `MAX_VIDEO_DURATION_SECONDS` si accorcia, e lo si sa prima di caricare', () => {
    expect(rifiutoLocaleVideo(fileVideo(), MAX_VIDEO_DURATION_SECONDS + 0.5)).toBe('VIDEO_TROPPO_LUNGO')
    expect(rifiutoLocaleVideo(fileVideo(), MAX_VIDEO_DURATION_SECONDS)).toBeNull()
  })

  it('una durata che il telefono non sa dire NON è un motivo di rifiuto', () => {
    // La misura vera la fa ffprobe dopo: rifiutare qui un file solo perché il
    // browser non sa dire quanto dura sarebbe un rifiuto ingiusto.
    expect(rifiutoLocaleVideo(fileVideo(), null)).toBeNull()
    expect(rifiutoLocaleVideo(fileVideo(), Number.NaN)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA DURATA — best effort, e mai un'attesa senza fine
// ═══════════════════════════════════════════════════════════════════════════

describe('durataVideoDalFile', () => {
  /** Un `<video>` che si comporta come deciso dal test: jsdom non decodifica niente. */
  function videoFinto(opzioni: { durata?: number; evento?: string | null }): HTMLVideoElement {
    const el = document.createElement('video')
    Object.defineProperty(el, 'duration', {
      get: () => opzioni.durata ?? Number.NaN,
      configurable: true,
    })
    Object.defineProperty(el, 'src', {
      set() {
        if (opzioni.evento) setTimeout(() => el.dispatchEvent(new Event(opzioni.evento!)), 0)
      },
      get: () => '',
      configurable: true,
    })
    return el
  }

  const dip = (el: HTMLVideoElement, revoca = vi.fn()) => ({
    creaVideo: () => el,
    creaUrl: () => 'blob:finto',
    revocaUrl: revoca,
    tettoMs: 30,
  })

  it('restituisce i secondi quando il browser li sa', async () => {
    const durata = await durataVideoDalFile(new Blob(['x']), dip(videoFinto({ durata: 12.5, evento: 'loadedmetadata' })))
    expect(durata).toBe(12.5)
  })

  it('una durata che il browser non sa dire è `null`, non zero', async () => {
    // `Infinity` è ciò che Chrome restituisce su certi file registrati dal
    // telefono finché non si cerca dentro: zero sarebbe una misura FALSA, e
    // `rifiutoLocaleVideo` la prenderebbe per buona.
    const durata = await durataVideoDalFile(new Blob(['x']), dip(videoFinto({ durata: Infinity, evento: 'loadedmetadata' })))
    expect(durata).toBeNull()
  })

  it('un file che non si decodifica non blocca niente', async () => {
    const durata = await durataVideoDalFile(new Blob(['x']), dip(videoFinto({ evento: 'error' })))
    expect(durata).toBeNull()
  })

  it('e se non succede NIENTE si arrende: l’attesa ha un tetto', async () => {
    // Senza tetto, un `<video>` che non emette né `loadedmetadata` né `error`
    // lascerebbe la promessa appesa per sempre — e con lei il caricamento, che
    // la aspetta. È il caso reale di iOS in Risparmio Energetico, dove
    // `preload="metadata"` è un suggerimento che il browser può ignorare.
    const durata = await durataVideoDalFile(new Blob(['x']), dip(videoFinto({ evento: null })))
    expect(durata).toBeNull()
  })

  it('l’objectURL si revoca comunque: un Blob da due gigabyte non resta in memoria', async () => {
    const revoca = vi.fn()
    await durataVideoDalFile(new Blob(['x']), dip(videoFinto({ evento: null }), revoca))
    expect(revoca).toHaveBeenCalledWith('blob:finto')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA CHIAVE DI IDEMPOTENZA — deterministica, coi bambini dentro, e senza nomi
// ═══════════════════════════════════════════════════════════════════════════
//
// Il server (`video_galleria_intent_apri`, spec §5.3) rifiuta con `IDEMPOTENCY_CONFLICT` — 409
// `VIDEO_RIPROVA`, «ricarica e riprova» — la STESSA chiave con bambini diversi, e una chiave già usata
// da un intento del flusso VECCHIO (`g-…`). Con la chiave di prima (`g-<byte>-<data>-<impronta del
// nome>`, senza i bambini) il gesto «scegli di nuovo il file e invialo» falliva sempre dove nome, peso
// e data restano gli stessi. Qui si tiene ferma la FORMA della chiave; che il server la accetti lo
// prova `video-galleria-chiave-rpc.test.ts`, sulla funzione SQL vera.

/** Il file che il client in produzione ha mandato davvero, e la chiave `g-…` che ne ha calcolato. */
const FILE_GIA_MANDATO = { name: 'VID_20261002_101500.mp4', size: 5000, lastModified: 1759400000000 }
const CHIAVE_DEL_CLIENT_VECCHIO = 'g-5000-1759400000000-83ce6643'

const conBambini = (tagAlunni: string[], extra: Partial<{ broadcast: boolean; classi: string[] }> = {}) => ({
  tagAlunni,
  broadcast: false,
  classi: [] as string[],
  ...extra,
})

describe('chiaveIdempotenzaVideo', () => {
  it('lo stesso file con gli stessi bambini dà la stessa chiave: un ritentativo ritrova il suo intento', () => {
    const a = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
    const b = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
    expect(a).toBe(b)
  })

  it('due file diversi danno chiavi diverse, anche a parità di taglia e data', () => {
    const a = chiaveIdempotenzaVideo(fileVideo({ nome: 'recita.mp4' }), conBambini([BAMBINO_A]))
    const b = chiaveIdempotenzaVideo(fileVideo({ nome: 'saggio.mp4' }), conBambini([BAMBINO_A]))
    expect(a).not.toBe(b)
  })

  it('peso e data fanno parte della chiave', () => {
    const base = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
    expect(chiaveIdempotenzaVideo(fileVideo({ byte: 999 }), conBambini([BAMBINO_A]))).not.toBe(base)
    expect(chiaveIdempotenzaVideo(fileVideo({ modificato: 1_726_000_000_001 }), conBambini([BAMBINO_A]))).not.toBe(base)
  })

  it('gli stessi bambini in un altro ordine, o con un doppione, sono lo stesso invio: stessa chiave', () => {
    const base = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A, BAMBINO_B]))
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_B, BAMBINO_A]))).toBe(base)
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A, BAMBINO_B, BAMBINO_A]))).toBe(base)
    // Anche la grafia dell'uuid: il contratto del server li porta in minuscolo.
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_B.toUpperCase(), BAMBINO_A]))).toBe(base)
  })

  it('lo stesso file con bambini DIVERSI dà una chiave diversa: è un altro invio, non un conflitto', () => {
    const solo = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_B]))).not.toBe(solo)
    // Anche con UN bambino in più, o in meno.
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A, BAMBINO_B]))).not.toBe(solo)
  })

  it('i bambini scelti contro tutta la classe sono due invii diversi, e classi diverse pure', () => {
    const tag = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
    const classe = chiaveIdempotenzaVideo(fileVideo(), conBambini([], { broadcast: true, classi: ['3 ANNI'] }))
    const altraClasse = chiaveIdempotenzaVideo(fileVideo(), conBambini([], { broadcast: true, classi: ['4 ANNI'] }))
    expect(classe).not.toBe(tag)
    expect(altraClasse).not.toBe(classe)
    // Le classi sono un insieme anche loro.
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([], { broadcast: true, classi: ['4 ANNI', '3 ANNI'] })))
      .toBe(chiaveIdempotenzaVideo(fileVideo(), conBambini([], { broadcast: true, classi: ['3 ANNI', '4 ANNI', '3 ANNI'] })))
  })

  it('conta ciò che PARTE verso il server: in broadcast i tag non contano, senza broadcast le classi non contano', () => {
    // In broadcast i tag non partono (il server risponderebbe 400): due scelte che differiscono solo
    // per loro mandano lo stesso corpo, quindi sono lo stesso invio.
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A], { broadcast: true, classi: ['3 ANNI'] })))
      .toBe(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_B], { broadcast: true, classi: ['3 ANNI'] })))
    // E senza broadcast le classi non partono: la pagina le passa sempre, e non devono cambiare la chiave.
    expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A], { classi: ['3 ANNI'] })))
      .toBe(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A], { classi: [] })))
  })

  it('NON comincia come la chiave del flusso vecchio, e per il file già mandato è DIVERSA da quella di prima', () => {
    // Il server non adotta l'intento del flusso vecchio: una chiave `g-…` già usata è IDEMPOTENCY_CONFLICT.
    const chiave = chiaveIdempotenzaVideo(FILE_GIA_MANDATO, conBambini([BAMBINO_A]))
    expect(chiave.startsWith('gv2-')).toBe(true)
    expect(chiave.startsWith('g-')).toBe(false)
    expect(chiave).not.toBe(CHIAVE_DEL_CLIENT_VECCHIO)
    // Neppure cambiando i bambini si ritrova mai: il prefisso è fisso.
    expect(chiaveIdempotenzaVideo(FILE_GIA_MANDATO, conBambini([BAMBINO_B])).startsWith('g-')).toBe(false)
    expect(chiaveIdempotenzaVideo(FILE_GIA_MANDATO, conBambini([], { broadcast: true, classi: ['3 ANNI'] })).startsWith('g-')).toBe(false)
  })

  it('NON contiene il nome del file né l’uuid di un bambino: finirebbe in `video_jobs.idempotency_key`', () => {
    // `IMG_bambina-rossi.mov` è anagrafica di un minore, e l'uuid di un bambino ne è l'identificativo.
    // La chiave viaggia al server, viene scritta in tabella e compare nei log della route.
    const chiave = chiaveIdempotenzaVideo(
      fileVideo({ nome: 'recita-di-natale-bambina-rossi.mov' }),
      conBambini([BAMBINO_A, BAMBINO_B]),
    )
    expect(chiave.toLowerCase()).not.toContain('rossi')
    expect(chiave.toLowerCase()).not.toContain('recita')
    for (const id of [BAMBINO_A, BAMBINO_B]) {
      expect(chiave).not.toContain(id)
      // Nemmeno un pezzo riconoscibile: l'uuid ha un suo prefisso, e quel prefisso non c'è.
      expect(chiave).not.toContain(id.slice(0, 8))
    }
    expect(chiave).toMatch(/^[a-z0-9-]+$/)
  })

  it('resta nel limite di 128 caratteri anche col suffisso `-<uuid>` del ramo «intento concluso»', () => {
    // `avviaVideo` aggiunge `-` + un uuid (37 caratteri) quando l'intento ritrovato è già finito, e
    // zod (`chiaveIdempotenza`) e `video_intent_open` rifiutano oltre 128.
    const SUFFISSO = 1 + 36
    const tipica = chiaveIdempotenzaVideo(FILE_GIA_MANDATO, conBambini([BAMBINO_A, BAMBINO_B]))
    expect(tipica.length + SUFFISSO).toBeLessThanOrEqual(128)
    // Il caso peggiore: due gigabyte, una data a 13 cifre, mille bambini (l'impronta non cresce).
    const molti = Array.from({ length: 1000 }, (_, i) => `55555555-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const peggiore = chiaveIdempotenzaVideo(
      { name: 'x'.repeat(255), size: MAX_VIDEO_INPUT_BYTES, lastModified: 9_999_999_999_999 },
      conBambini(molti),
    )
    expect(peggiore.length + SUFFISSO).toBeLessThanOrEqual(128)
    expect(peggiore).toMatch(/^[a-z0-9-]+$/)
  })

  it('una data mancante o non intera non sporca la chiave con punti o esponenti', () => {
    for (const lastModified of [undefined, Number.NaN, 1_726_000_000_000.5, 1e21]) {
      const chiave = chiaveIdempotenzaVideo({ name: 'a.mp4', size: 10, lastModified }, conBambini([BAMBINO_A]))
      expect(chiave, String(lastModified)).toMatch(/^[a-z0-9-]+$/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA CHIAVE È SALATA — i bambini non restano in tabella, nemmeno come impronta (#131)
// ═══════════════════════════════════════════════════════════════════════════
//
// `video_jobs.idempotency_key` sopravvive alla minimizzazione di `video_intents.tag_alunni` (sette
// giorni). Con l'impronta di prima — un FNV a 32 bit degli uuid, senza sale — chi legge la tabella
// (service role) conosce gli uuid di tutti i bambini della sede, sa `n_tag` e la classe, e prova i
// sottoinsiemi finché l'impronta torna: i bambini scelti si ricostruiscono. Qui il difetto è
// RIPRODOTTO (l'attacco funziona sull'impronta di prima e non funziona su quella di oggi), e si tengono
// ferme le due proprietà che il sale deve dare senza togliere la terza:
//   · senza il sale l'impronta non si confronta con nessun candidato;
//   · con lo stesso sale (stesso dispositivo) la stessa scelta dà la stessa chiave: i ritentativi
//     ritrovano il loro intento.

const SALE_A = '0123456789abcdef0123456789abcdef'
const SALE_B = 'fedcba9876543210fedcba9876543210'
const CHIAVE_SALE_NEL_DEPOSITO = 'kv:video-galleria-sale'

/** Le due impronte di una chiave `gv2-<byte>-<data>-<nome>-<bambini>`. */
function impronteDi(chiave: string): { nome: string; bambini: string } {
  const pezzi = chiave.split('-')
  expect(pezzi, chiave).toHaveLength(5)
  return { nome: pezzi[3], bambini: pezzi[4] }
}

/**
 * L'impronta di PRIMA, riprodotta SOLO per fare l'attacco: FNV-1a a 32 bit, senza sale, sul JSON dei
 * bambini ordinati. NON è codice di produzione: è ciò che chi leggeva la tabella sapeva rifare.
 */
function improntaDiPrima(testo: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < testo.length; i++) {
    h ^= testo.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** La classe di chi attacca: dieci bambini, i cui uuid chi legge la tabella conosce. */
const CLASSE_DEL_NIDO = Array.from({ length: 10 }, (_, i) => `66666666-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)

/** Tutte le scelte possibili (2^10 − 1): è ciò che prova chi legge la tabella. */
function tutteLeScelte(elenco: string[]): string[][] {
  const scelte: string[][] = []
  for (let maschera = 1; maschera < 1 << elenco.length; maschera++) {
    scelte.push(elenco.filter((_, i) => (maschera >> i) & 1))
  }
  return scelte
}

/** L'attacco: quali scelte danno l'impronta che sta in tabella, secondo la funzione che l'attaccante conosce? */
const scelteCompatibili = (impronta: string, calcola: (tag: string[]) => string): string[][] =>
  tutteLeScelte(CLASSE_DEL_NIDO).filter((tag) => calcola(tag) === impronta)

describe('chiaveIdempotenzaVideo — il sale del dispositivo (#131)', () => {
  const SEGRETA = [CLASSE_DEL_NIDO[1], CLASSE_DEL_NIDO[4], CLASSE_DEL_NIDO[7]]
  const FILE_DEL_TEST = fileVideo({ nome: 'VID_20261002_101500.mp4' })

  /** Ciò che finisce in tabella quando il dispositivo col sale `sale` manda `tag`. */
  const chiaveCon = (sale: string, tag: string[]) => chiaveIdempotenzaVideo(FILE_DEL_TEST, conBambini(tag), sale)

  it('IL DIFETTO, RIPRODOTTO: l’impronta di prima si enumerava, e ritrovava i bambini scelti', () => {
    // Il controllo positivo che rende significativo il test dopo: l'attacco FUNZIONA contro l'impronta senza sale.
    const inTabella = improntaDiPrima(JSON.stringify([[...SEGRETA].sort(), false, []]))
    const trovate = scelteCompatibili(inTabella, (tag) => improntaDiPrima(JSON.stringify([[...tag].sort(), false, []])))
    expect(trovate).toEqual([[...SEGRETA]])
  })

  it('con il sale giusto l’attacco ritroverebbe la scelta: è il sale, e solo lui, a tenerla al sicuro', () => {
    // Controllo positivo del macchinario: se qui non trovasse niente, il test seguente sarebbe verde a vuoto.
    const inTabella = impronteDi(chiaveCon(SALE_A, SEGRETA)).bambini
    const trovate = scelteCompatibili(inTabella, (tag) => impronteDi(chiaveCon(SALE_A, tag)).bambini)
    expect(trovate).toEqual([SEGRETA])
  })

  it('SENZA il sale i sottoinsiemi non tornano: né col sale di un altro dispositivo né con la formula di prima', () => {
    const inTabella = impronteDi(chiaveCon(SALE_A, SEGRETA)).bambini
    // L'attaccante prova il sale di un altro dispositivo…
    expect(scelteCompatibili(inTabella, (tag) => impronteDi(chiaveCon(SALE_B, tag)).bambini)).toEqual([])
    // …o la vecchia impronta (la stessa formula, nessun sale), intera e nel suo prefisso di otto cifre.
    const vecchia = (tag: string[]) => improntaDiPrima(JSON.stringify([[...tag].sort(), false, []]))
    expect(scelteCompatibili(inTabella, vecchia)).toEqual([])
    expect(scelteCompatibili(inTabella.slice(0, 8), vecchia)).toEqual([])
  })

  it('la stessa scelta con due sali diversi dà due chiavi diverse, in TUTTE e due le impronte', () => {
    const a = chiaveCon(SALE_A, SEGRETA)
    const b = chiaveCon(SALE_B, SEGRETA)
    expect(a).not.toBe(b)
    // Anche il nome del file è salato: un'impronta del nome senza sale si prova su una lista di nomi.
    expect(impronteDi(a).bambini).not.toBe(impronteDi(b).bambini)
    expect(impronteDi(a).nome).not.toBe(impronteDi(b).nome)
    // La parte che non è personale resta uguale: byte e data.
    expect(a.split('-').slice(0, 3)).toEqual(b.split('-').slice(0, 3))
  })

  it('due video DIVERSI con gli STESSI bambini, dallo stesso dispositivo, non hanno niente in comune nell’impronta dei destinatari (#183)', () => {
    // Senza il file dentro l'impronta, lo stesso gruppo di bambini dava la stessa impronta per ogni video dello
    // stesso dispositivo: chi legge la tabella poteva legare un intento già minimizzato a un altro, i cui bambini
    // sono ancora noti, e risalire così ai destinatari del primo.
    const recita = impronteDi(chiaveIdempotenzaVideo(fileVideo({ nome: 'recita.mp4' }), conBambini(SEGRETA), SALE_A)).bambini
    const saggio = impronteDi(chiaveIdempotenzaVideo(fileVideo({ nome: 'saggio.mp4' }), conBambini(SEGRETA), SALE_A)).bambini
    const altroPeso = impronteDi(chiaveIdempotenzaVideo(fileVideo({ byte: 999 }), conBambini(SEGRETA), SALE_A)).bambini
    const altraData = impronteDi(chiaveIdempotenzaVideo(fileVideo({ modificato: 1_726_000_000_001 }), conBambini(SEGRETA), SALE_A)).bambini
    expect(new Set([recita, saggio, altroPeso, altraData]).size).toBe(4)
    // E l'idempotenza resta: lo stesso video con gli stessi bambini dà la stessa impronta.
    expect(impronteDi(chiaveIdempotenzaVideo(fileVideo({ nome: 'recita.mp4' }), conBambini(SEGRETA), SALE_A)).bambini).toBe(recita)
  })

  it('le due impronte sono di due DOMINI: un nome uguale al JSON dei bambini non darebbe la stessa impronta', () => {
    const json = JSON.stringify([[BAMBINO_A], false, []])
    const { nome, bambini } = impronteDi(chiaveIdempotenzaVideo(fileVideo({ nome: json }), conBambini([BAMBINO_A]), SALE_A))
    expect(nome).not.toBe(bambini)
  })

  it('con lo stesso sale la stessa chiave: un ritentativo dello stesso dispositivo ritrova il suo intento', () => {
    expect(chiaveCon(SALE_A, SEGRETA)).toBe(chiaveCon(SALE_A, SEGRETA))
    // E restano insiemi: ordine, doppioni e grafia dell'uuid non cambiano la chiave, col sale come senza.
    expect(chiaveCon(SALE_A, [...SEGRETA].reverse())).toBe(chiaveCon(SALE_A, SEGRETA))
    expect(chiaveCon(SALE_A, [...SEGRETA, SEGRETA[0].toUpperCase()])).toBe(chiaveCon(SALE_A, SEGRETA))
  })

  it('la chiave NON contiene l’impronta di prima: né dei bambini né del nome (valori misurati col codice senza sale)', () => {
    // Misurati prima della correzione, e scritti qui: un test che li ricalcolasse proverebbe la propria copia.
    const IMPRONTA_BAMBINO_A_SENZA_SALE = 'ebb36d66'
    const IMPRONTA_NOME_SENZA_SALE = 'afbbf116' // «recita.mp4», il nome di `fileVideo()`
    const chiave = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]), SALE_A)
    expect(chiave).not.toContain(IMPRONTA_BAMBINO_A_SENZA_SALE)
    expect(chiave).not.toContain(IMPRONTA_NOME_SENZA_SALE)
    // …e nemmeno la chiave di default, quella che parte davvero dalla schermata.
    const predefinita = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
    expect(predefinita).not.toContain(IMPRONTA_BAMBINO_A_SENZA_SALE)
    expect(predefinita).not.toContain(IMPRONTA_NOME_SENZA_SALE)
  })

  it('il sale non esce: non è nella chiave, nemmeno a pezzi', () => {
    const chiave = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]), SALE_A)
    expect(chiave).not.toContain(SALE_A)
    expect(chiave).not.toContain(SALE_A.slice(0, 8))
    expect(chiave).toMatch(/^gv2-12345678-1726000000000-[0-9a-f]{12}-[0-9a-f]{12}$/)
  })

  it('un sale che non ha la forma dei veri si RIFIUTA: vuoto o corto farebbe tornare l’impronta enumerabile in silenzio', () => {
    for (const sale of ['', 'x', 'a'.repeat(31), 'A'.repeat(32), 'g'.repeat(32), `${SALE_A}!`]) {
      expect(() => chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]), sale), JSON.stringify(sale)).toThrow('SaleNonValido')
    }
  })

  describe('senza un sale esplicito la chiave usa quello del DISPOSITIVO, tenuto in localStorage', () => {
    afterEach(() => localStorage.removeItem(CHIAVE_SALE_NEL_DEPOSITO))

    it('il sale del deposito è quello che entra nella chiave, e cambiarlo cambia la chiave', () => {
      localStorage.setItem(CHIAVE_SALE_NEL_DEPOSITO, SALE_A)
      const conA = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
      expect(conA).toBe(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]), SALE_A))

      localStorage.setItem(CHIAVE_SALE_NEL_DEPOSITO, SALE_B)
      const conB = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
      expect(conB).toBe(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]), SALE_B))
      expect(conB).not.toBe(conA)
    })

    it('il primo invio crea il sale e lo salva: gli invii dopo, e dopo un ricaricamento, ritrovano la stessa chiave', () => {
      localStorage.removeItem(CHIAVE_SALE_NEL_DEPOSITO)
      const prima = chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))
      const salvato = localStorage.getItem(CHIAVE_SALE_NEL_DEPOSITO)
      expect(salvato, 'il sale non è stato messo da parte').toMatch(/^[0-9a-f]{32}$/)
      expect(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]))).toBe(prima)
      expect(prima).toBe(chiaveIdempotenzaVideo(fileVideo(), conBambini([BAMBINO_A]), salvato!))
    })
  })
})

describe('creaSaleDelDispositivo — 128 bit casuali, per dispositivo, in localStorage', () => {
  const CHIAVE = CHIAVE_SALE_NEL_DEPOSITO

  /** Un deposito finto che registra le chiamate. */
  function depositoFinto(iniziale: Record<string, string> = {}) {
    const dati = new Map(Object.entries(iniziale))
    return {
      dati,
      getItem: vi.fn((k: string) => dati.get(k) ?? null),
      setItem: vi.fn((k: string, v: string) => {
        dati.set(k, v)
      }),
    }
  }

  /** Byte «casuali» che si possono prevedere: `da`, `da + 1`, … */
  const byteDa = (da = 0) => vi.fn((n: number) => Uint8Array.from({ length: n }, (_, i) => (da + i) & 0xff))

  /** Le righe di log di un guasto del sale. */
  const guasti = () => h.logClient.mock.calls
    .map((c) => c[0] as { livello: string; messaggio: string; campi?: Record<string, unknown> })
    .filter((r) => r.messaggio === 'video-galleria-sale-non-disponibile')

  it('genera sedici byte dalla fonte crittografica, li salva e a ogni invio ritorna lo stesso', () => {
    const deposito = depositoFinto()
    const casuali = byteDa()
    const sale = creaSaleDelDispositivo({ deposito: () => deposito, casuali })

    const primo = sale()
    expect(primo).toBe('000102030405060708090a0b0c0d0e0f')
    expect(casuali).toHaveBeenCalledWith(16)
    expect(deposito.dati.get(CHIAVE)).toBe(primo)

    expect(sale()).toBe(primo)
    expect(casuali, 'a ogni invio si rigenerava: i ritentativi non si ritroverebbero più').toHaveBeenCalledTimes(1)
    expect(guasti()).toEqual([])
  })

  it('un sale già nel deposito (il dispositivo di ieri) si USA: non se ne genera un altro', () => {
    const deposito = depositoFinto({ [CHIAVE]: SALE_B })
    const casuali = byteDa()
    expect(creaSaleDelDispositivo({ deposito: () => deposito, casuali })()).toBe(SALE_B)
    expect(casuali).not.toHaveBeenCalled()
    expect(deposito.setItem).not.toHaveBeenCalled()
  })

  it('un sale LETTO dal deposito resta quello della sessione anche se il deposito si svuota subito dopo', () => {
    const deposito = depositoFinto({ [CHIAVE]: SALE_B })
    const casuali = byteDa()
    const sale = creaSaleDelDispositivo({ deposito: () => deposito, casuali })
    expect(sale()).toBe(SALE_B)
    deposito.dati.clear()
    expect(sale(), 'la chiave dei ritentativi in corso è cambiata a metà sessione').toBe(SALE_B)
    expect(casuali).not.toHaveBeenCalled()
    // …e si rimette al sicuro dove l'utente l'aveva cancellato.
    expect(deposito.dati.get(CHIAVE)).toBe(SALE_B)
  })

  it('due dispositivi hanno due sali diversi', () => {
    const uno = creaSaleDelDispositivo({ deposito: () => depositoFinto(), casuali: byteDa(0) })()
    const due = creaSaleDelDispositivo({ deposito: () => depositoFinto(), casuali: byteDa(100) })()
    expect(uno).not.toBe(due)
  })

  it.each([
    ['vuoto', ''],
    ['corto (31 cifre)', 'a'.repeat(31)],
    ['maiuscolo', 'A'.repeat(32)],
    ['non esadecimale', 'g'.repeat(32)],
    ['con un suffisso', `${SALE_A}-x`],
  ])('un valore illeggibile nel deposito (%s) non si usa: si butta e se ne rifà uno', (_nome, guasto) => {
    const deposito = depositoFinto({ [CHIAVE]: guasto })
    const sale = creaSaleDelDispositivo({ deposito: () => deposito, casuali: byteDa(7) })()
    expect(sale).toBe('0708090a0b0c0d0e0f10111213141516')
    expect(deposito.dati.get(CHIAVE), 'il valore rotto è rimasto nel deposito').toBe(sale)
  })

  it('il deposito che LANCIA all’accesso (siti bloccati) non rompe l’invio: sale per sessione, e il guasto si dice UNA volta', () => {
    const casuali = byteDa()
    const sale = creaSaleDelDispositivo({
      deposito: () => {
        throw new Error('bloccato')
      },
      casuali,
    })
    const primo = sale()
    expect(primo).toMatch(/^[0-9a-f]{32}$/)
    expect(sale(), 'senza deposito il sale deve restare quello della sessione').toBe(primo)
    expect(casuali).toHaveBeenCalledTimes(1)
    expect(guasti()).toHaveLength(1)
    expect(guasti()[0]).toMatchObject({ livello: 'warn', campi: { motivo: 'accesso', error_code: 'Error' } })
    // Nessun segreto nel log: il sale non si registra mai.
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain(primo)
  })

  it('senza deposito (`null`) il sale è della SESSIONE: lo stesso finché dura, un altro alla prossima', () => {
    const sessione1 = creaSaleDelDispositivo({ deposito: () => null, casuali: byteDa(0) })
    const sessione2 = creaSaleDelDispositivo({ deposito: () => null, casuali: byteDa(50) })
    const a = sessione1()
    expect(sessione1()).toBe(a)
    expect(sessione2()).not.toBe(a)
    // `null` è «non c'è un deposito», non un guasto: niente rumore nei log.
    expect(guasti()).toEqual([])
  })

  it('una lettura che lancia non impedisce di avere un sale (e di provare a salvarlo)', () => {
    const deposito = depositoFinto()
    deposito.getItem.mockImplementation(() => {
      throw new Error('lettura')
    })
    const sale = creaSaleDelDispositivo({ deposito: () => deposito, casuali: byteDa() })
    const primo = sale()
    expect(primo).toMatch(/^[0-9a-f]{32}$/)
    expect(sale()).toBe(primo)
    expect(deposito.setItem).toHaveBeenCalledWith(CHIAVE, primo)
    expect(guasti().map((r) => r.campi?.motivo)).toEqual(['lettura'])
  })

  it('una scrittura che lancia (quota piena) lascia il sale in memoria: stessa chiave per tutta la sessione, guasto detto UNA volta', () => {
    const deposito = depositoFinto()
    deposito.setItem.mockImplementation(() => {
      throw new Error('piena')
    })
    const sale = creaSaleDelDispositivo({ deposito: () => deposito, casuali: byteDa() })
    const primo = sale()
    expect(sale()).toBe(primo)
    expect(sale()).toBe(primo)
    expect(guasti()).toHaveLength(1)
    expect(guasti()[0].campi).toMatchObject({ motivo: 'scrittura' })
  })

  it('un deposito svuotato a metà sessione (l’utente cancella i dati) NON cambia il sale della sessione: si rimette al sicuro', () => {
    const deposito = depositoFinto()
    const casuali = byteDa()
    const sale = creaSaleDelDispositivo({ deposito: () => deposito, casuali })
    const primo = sale()
    deposito.dati.clear()
    expect(sale()).toBe(primo)
    expect(deposito.dati.get(CHIAVE)).toBe(primo)
    expect(casuali).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['nessuna fonte crittografica', () => null],
    ['una fonte che dà meno byte del dovuto', () => new Uint8Array(4)],
  ])('%s: ripiega su un sale comunque di 128 bit, e LO DICE (non è un ripiego silenzioso)', (_nome, casuali) => {
    const sale = creaSaleDelDispositivo({ deposito: () => null, casuali })()
    expect(sale).toMatch(/^[0-9a-f]{32}$/)
    expect(guasti().map((r) => r.campi?.motivo)).toEqual(['senza-crypto'])
  })

  it('una fonte che lancia non ferma l’invio: ripiego dichiarato', () => {
    const sale = creaSaleDelDispositivo({
      deposito: () => null,
      casuali: () => {
        throw new Error('crypto')
      },
    })()
    expect(sale).toMatch(/^[0-9a-f]{32}$/)
    expect(guasti()).toHaveLength(1)
  })

  it('la fonte di tutti i giorni è `crypto.getRandomValues`: due dispositivi veri non hanno lo stesso sale', () => {
    const uno = creaSaleDelDispositivo({ deposito: () => null })()
    const due = creaSaleDelDispositivo({ deposito: () => null })()
    expect(uno).toMatch(/^[0-9a-f]{32}$/)
    expect(due).not.toBe(uno)
    expect(guasti(), 'il browser di prova ha una fonte crittografica: nessun ripiego').toEqual([])
  })
})

describe('sha256Esadecimale — è SHA-256, non un’imitazione', () => {
  it('i vettori del NIST (FIPS 180-4)', () => {
    expect(sha256Esadecimale('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Esadecimale('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Esadecimale('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })

  it('coincide con `node:crypto` a ogni lunghezza intorno al confine dei blocchi (55, 56, 63, 64, 65…) e con l’Unicode', () => {
    const lunghezze = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000, 100_000]
    for (const n of lunghezze) {
      const testo = 'x'.repeat(n)
      expect(sha256Esadecimale(testo), `lunghezza ${n}`).toBe(createHash('sha256').update(testo, 'utf8').digest('hex'))
    }
    for (const testo of ['è ñ 日本語 🙂', 'recita-di-natale-bambina-rossi.mov', '3 ANNI\n4 ANNI', '\u0000\u0001']) {
      expect(sha256Esadecimale(testo), testo).toBe(createHash('sha256').update(testo, 'utf8').digest('hex'))
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// L'APERTURA DELL'INTENTO — con i bambini già scelti
// ═══════════════════════════════════════════════════════════════════════════

/** La risposta di un'apertura riuscita, con i campi che il client legge. */
function aperturaRiuscita(extra: Record<string, unknown> = {}, job: Record<string, unknown> = {}) {
  return {
    intentId: INTENTO,
    revisione: 1,
    canale: 'gallery',
    intent: { status: 'confirmed' },
    scadenzaCaricamentoIl: '2026-09-18T12:00:00.000Z',
    job: [{ jobId: JOB, chiaveIdempotenza: 'g-1', caricamento: COORDINATE, firma: 'firma-finta', ...job }],
    ...extra,
  }
}

/** Una chiamata di apertura con le impostazioni di tutti i giorni; ogni test cambia solo ciò che prova. */
function apri(rete: Parameters<typeof apriIntentoVideoGalleria>[0], extra: Partial<Parameters<typeof apriIntentoVideoGalleria>[1]> = {}) {
  return apriIntentoVideoGalleria(rete, {
    file: fileVideo(),
    scuolaId: SEDE_A,
    durataSecondi: null,
    chiaveIdempotenza: 'g-1',
    destinatari: { tagAlunni: [BAMBINO_A], broadcast: false, classi: [] },
    trasporto: 'tus',
    ripiego: 'ripiego',
    ...extra,
  })
}

const corpoDellaChiamata = (rete: { mock: { calls: unknown[][] } }, n = 0) =>
  JSON.parse(String((rete.mock.calls[n] as unknown as [string, RequestInit])[1].body))

describe('apriIntentoVideoGalleria', () => {
  it('dichiara canale, azione, sede e UN solo file — quello che la Galleria ammette', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaRiuscita()))

    const esito = await apri(rete, { file: fileVideo({ byte: 999, tipo: 'video/mp4;codecs=avc1' }), durataSecondi: 12 })

    expect(esito.ok).toBe(true)
    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/video-uploads')
    expect(init.method).toBe('POST')
    const corpo = JSON.parse(String(init.body))
    expect(corpo.canale).toBe('gallery')
    expect(corpo.azione).toBe('publish')
    expect(corpo.scuolaId).toBe(SEDE_A)
    expect(corpo.ambitoGlobale).toBe(false)
    expect(corpo.file).toHaveLength(1)
    expect(corpo.file[0].byte).toBe(999)
    expect(corpo.file[0].durataSecondi).toBe(12)
    if (esito.ok) {
      expect(esito.dati.jobId).toBe(JOB)
      expect(esito.dati.intentId).toBe(INTENTO)
      expect(esito.dati.revisione).toBe(1)
      expect(esito.dati.firma).toBe('firma-finta')
    }
  })

  it('PORTA I BAMBINI e il trasporto: il server li conosce dall’apertura e pubblica da solo', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaRiuscita()))
    await apri(rete, { destinatari: { tagAlunni: [BAMBINO_A, BAMBINO_B], broadcast: false, classi: ['3 ANNI'] }, trasporto: 'tus' })
    const corpo = corpoDellaChiamata(rete)
    // Le classi non partono se non è un broadcast: sono i bersagli di un invio a tutta la classe.
    expect(corpo.destinatari).toEqual({ tagAlunni: [BAMBINO_A, BAMBINO_B], broadcast: false, classi: [] })
    expect(corpo.trasporto).toBe('tus')
    // E nessun campo del vecchio flusso: i bambini non si «confermano» né si mandano dopo.
    expect(corpo.tag_students).toBeUndefined()
    expect(corpo.video_intent_id).toBeUndefined()
  })

  it('il corpo della POST passa lo schema VERO della route, con la chiave vera: nessun campo che il server rifiuterebbe', async () => {
    // I server finti rispondono 201 a qualunque corpo: qui si prova il corpo contro lo zod che la route
    // usa davvero (`schemaAperturaIntentVideo`), con la chiave che il client calcola (≤ 128 caratteri).
    const rete = vi.fn(async () => risposta(201, aperturaRiuscita()))
    const file = fileVideo({ byte: 999, tipo: 'video/mp4;codecs=avc1' })
    const destinatari = { tagAlunni: [BAMBINO_A, BAMBINO_B], broadcast: false, classi: [] as string[] }
    await apri(rete, { file, durataSecondi: 12, destinatari, chiaveIdempotenza: chiaveIdempotenzaVideo(file, destinatari) })

    const letto = schemaAperturaIntentVideo.safeParse(corpoDellaChiamata(rete))
    expect(letto.success, JSON.stringify(letto.error?.issues)).toBe(true)
    if (letto.success) {
      expect(letto.data.destinatari).toEqual({ tagAlunni: [BAMBINO_A, BAMBINO_B], broadcast: false, classi: [] })
      expect(letto.data.trasporto).toBe('tus')
      expect(letto.data.file[0].chiaveIdempotenza).toBe(chiaveIdempotenzaVideo(file, destinatari))
    }
  })

  it('anche il corpo di un invio a tutta la classe passa lo schema della route', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaRiuscita()))
    const file = fileVideo()
    const destinatari = { tagAlunni: [BAMBINO_A], broadcast: true, classi: ['3 ANNI'] }
    await apri(rete, { file, destinatari, chiaveIdempotenza: chiaveIdempotenzaVideo(file, destinatari) })
    const letto = schemaAperturaIntentVideo.safeParse(corpoDellaChiamata(rete))
    expect(letto.success, JSON.stringify(letto.error?.issues)).toBe(true)
    if (letto.success) expect(letto.data.destinatari).toEqual({ tagAlunni: [], broadcast: true, classi: ['3 ANNI'] })
  })

  it('in broadcast i tag non partono — il server rifiuta la combinazione — e le classi sì', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaRiuscita()))
    await apri(rete, { destinatari: { tagAlunni: [BAMBINO_A], broadcast: true, classi: ['3 ANNI'] } })
    expect(corpoDellaChiamata(rete).destinatari).toEqual({ tagAlunni: [], broadcast: true, classi: ['3 ANNI'] })
  })

  it('una durata non misurabile viaggia come `null`, non come 0 né come NaN', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaRiuscita()))
    await apri(rete, { durataSecondi: Number.NaN })
    expect(corpoDellaChiamata(rete).file[0].durataSecondi).toBeNull()
  })

  it('il 422 del Privacy Lock porta i NOMI a schermo (con la sua prosa), e non nei log', async () => {
    // L'apertura attraversa i cancelli di `POST /api/gallery`: il rifiuto per liberatoria mancante non
    // ha un `codice`, ha `nomi` — e la sua prosa dice QUALI bambini togliere dalla scelta.
    const rete = vi.fn(async () =>
      risposta(422, { error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto.', nomi: ['Ada B.'], ids: [BAMBINO_A] }),
    )
    const esito = await apri(rete)
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.stato).toBe(422)
      expect(esito.nomi).toEqual(['Ada B.'])
      expect(esito.messaggio).toContain('Foto di gruppo non pubblicabile')
    }
    const scritto = JSON.stringify(h.logClient.mock.calls)
    expect(scritto).not.toContain('Ada')
    expect(scritto).not.toContain(BAMBINO_A)
  })

  it('un rifiuto con `codice` (403 `TAG_FUORI_SEDE`) si legge dal CATALOGO, non dalla prosa italiana', async () => {
    const PROSA_SERVER = 'Prosa italiana del server, diversa dal catalogo.'
    const rete = vi.fn(async () => risposta(403, { error: PROSA_SERVER, codice: 'TAG_FUORI_SEDE' }))
    const esito = await apri(rete)
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.codice).toBe('TAG_FUORI_SEDE')
      expect(esito.messaggio).toBe(itShared.erroreTagFuoriSede)
      expect(esito.messaggio).not.toContain(PROSA_SERVER)
    }
  })

  it('un rifiuto del server si legge dal CATALOGO, non dalla prosa italiana della route', async () => {
    // È il difetto T10-F1: con l'interfaccia in inglese la prosa del server resta
    // italiana. Il codice invece ha la sua voce in `messages/{it,en}/shared.json`.
    const rete = vi.fn(async () =>
      risposta(413, { error: 'Il video supera il limite consentito.', codice: 'VIDEO_TROPPO_GRANDE' }),
    )
    const esito = await apri(rete, { ripiego: 'ripiego-che-non-deve-comparire' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.codice).toBe('VIDEO_TROPPO_GRANDE')
      expect(esito.messaggio).toBe(itShared.erroreVideoTroppoGrande)
      expect(esito.stato).toBe(413)
    }
  })

  it('un client col JS vecchio (409 `VIDEO_APP_DA_AGGIORNARE`) legge la frase che dice di aggiornare', async () => {
    const rete = vi.fn(async () => risposta(409, { error: 'x', codice: 'VIDEO_APP_DA_AGGIORNARE' }))
    const esito = await apri(rete)
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.messaggio).toBe(itShared.erroreVideoAppDaAggiornare)
  })

  it('una prosa del server SENZA codice e SENZA nomi non arriva a schermo: resta la frase tradotta', async () => {
    // ⚠️ IL CONTROLLO CHE MORDE, e il precedente da solo non mordeva: con un codice
    // dichiarato `messaggioDaCorpo` e `soloCatalogoDaCorpo` danno la STESSA frase,
    // quindi quel test resterebbe verde anche con la regola sbagliata. La differenza
    // fra le due si vede solo qui: un rifiuto senza codice — un 400 di validazione
    // zod, un 429, un 502 dell'infrastruttura — porta prosa ITALIANA scritta in una
    // route dove il locale non esiste, e con l'interfaccia in inglese sarebbe il
    // fallimento F2 del collaudo del 2026-07-31 riaperto in una schermata nuova.
    // L'UNICA eccezione è il corpo che porta `nomi` (il caso qui sopra).
    const rete = vi.fn(async () => risposta(400, { error: 'scuolaId: indicare la sede a cui si riferisce' }))
    const esito = await apri(rete, { ripiego: 'La frase del componente' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.messaggio).toBe('La frase del componente')
      expect(esito.messaggio).not.toContain('scuolaId')
    }
  })

  it('una rete caduta non lascia la schermata muta, e lascia una riga nei log', async () => {
    const rete = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const esito = await apri(rete, { ripiego: 'Nessuna rete' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.messaggio).toBe('Nessuna rete')
      expect(esito.stato).toBeNull()
    }
    expect(h.logClient).toHaveBeenCalled()
  })

  it('una risposta che promette TUS ma porta un altro protocollo non diventa un caricamento', async () => {
    const put = { protocollo: 'put', url: 'https://esempio.supabase.co/x', metodo: 'PUT', intestazioni: { 'content-type': 'video/mp4' } }
    // La firma c'è: a rifiutare la risposta dev'essere il PROTOCOLLO, non un campo mancante.
    const rete = vi.fn(async () => risposta(201, aperturaRiuscita({}, { caricamento: put, firma: 'firma-presente' })))
    const esito = await apri(rete)
    expect(esito.ok).toBe(false)
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'video-galleria-apertura-incompleta' }),
    )
  })

  it('NON manda il nome del file né i bambini nei log: sono anagrafica di minori', async () => {
    const rete = vi.fn(async () => risposta(500, { error: 'boom', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }))
    await apri(rete, { file: fileVideo({ nome: 'recita-bambina-rossi.mov' }) })
    const scritto = JSON.stringify(h.logClient.mock.calls)
    expect(scritto.toLowerCase()).not.toContain('rossi')
    expect(scritto.toLowerCase()).not.toContain('recita')
    expect(scritto).not.toContain(BAMBINO_A)
    // Dei bambini passa il NUMERO, che sta nei campi.
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ campi: expect.objectContaining({ n_tag: 1, broadcast: false }) }),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LE AZIONI SULL'INTENTO
// ═══════════════════════════════════════════════════════════════════════════

describe('le azioni sull’intento parlano il vocabolario chiuso della route', () => {
  const statoFinto = {
    intentId: INTENTO,
    revisione: 1,
    canale: 'gallery',
    statoIntent: 'pending',
    aggiornatoIl: '2026-09-18T12:00:00.000Z',
    job: [{ jobId: JOB, intentId: INTENTO, canale: 'gallery', stato: 'queued', avanzamento: 25, codice: null, aggiornatoIl: '2026-09-18T12:00:00.000Z' }],
  }

  it('«caricato» dichiara i byte e il MIME RIDOTTO al solo container', async () => {
    const rete = vi.fn(async () => risposta(200, statoFinto))
    await segnalaVideoCaricato(rete, {
      intentId: INTENTO,
      jobId: JOB,
      byte: 555,
      mime: 'video/mp4;codecs=avc1.42E01E',
      ripiego: 'ripiego',
    })
    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/video-uploads/${INTENTO}`)
    expect(init.method).toBe('PATCH')
    const corpo = JSON.parse(String(init.body))
    expect(corpo).toEqual({ azione: 'caricato', jobId: JOB, byte: 555, mime: 'video/mp4' })
  })

  it('«annulla» ritira l’intento intero con la sua revisione', async () => {
    const rete = vi.fn(async () => risposta(200, statoFinto))
    await annullaIntentoVideo(rete, { intentId: INTENTO, revisione: 2, ripiego: 'ripiego' })
    const corpo = JSON.parse(String((rete.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(corpo).toEqual({ azione: 'annulla', revisione: 2 })
  })

  it('«riprova-pubblicazione» non porta altro: l’intento è quello dell’URL, e decide il server', async () => {
    const rete = vi.fn(async () => risposta(200, statoFinto))
    const esito = await riprovaPubblicazioneVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/video-uploads/${INTENTO}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ azione: 'riprova-pubblicazione' })
  })

  it('un «Riprova» negato (409) si legge dal catalogo: dice che cosa fare invece', async () => {
    const rete = vi.fn(async () => risposta(409, { error: 'x', codice: 'VIDEO_RIPROVA_NON_POSSIBILE' }))
    const esito = await riprovaPubblicazioneVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.stato).toBe(409)
      expect(esito.messaggio).toBe(itShared.erroreVideoRiprovaNonPossibile)
    }
  })

  it('lo stato si legge con una GET sola per tutto l’intento', async () => {
    const rete = vi.fn(async () => risposta(200, statoFinto))
    const esito = await leggiStatoIntentoVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.dati.job[0].stato).toBe('queued')
      expect(esito.dati.revisione).toBe(1)
    }
    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe(`/api/video-uploads/${INTENTO}`)
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('uno stato che non rispetta il contratto non diventa una schermata inventata', async () => {
    const rete = vi.fn(async () => risposta(200, { intentId: INTENTO, job: 'non-un-elenco' }))
    const esito = await leggiStatoIntentoVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// IL RITENTATIVO AUTOMATICO — «il problema è nostro, lo stiamo riprovando»
// ═══════════════════════════════════════════════════════════════════════════

describe('lo stato porta `riprovaAutomatica`, e solo dove ha senso', () => {
  const statoCon = (job: Record<string, unknown>) => ({
    intentId: INTENTO,
    revisione: 1,
    canale: 'gallery',
    statoIntent: 'confirmed',
    aggiornatoIl: '2026-10-02T10:00:00.000Z',
    job: [
      {
        jobId: JOB,
        intentId: INTENTO,
        canale: 'gallery',
        stato: 'queued',
        avanzamento: 25,
        codice: null,
        aggiornatoIl: '2026-10-02T10:00:00.000Z',
        ...job,
      },
    ],
  })

  it('un job in coda che il runner sta ritentando arriva con il flag acceso', async () => {
    const rete = vi.fn(async () => risposta(200, statoCon({ riprovaAutomatica: true })))
    const esito = await leggiStatoIntentoVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.dati.job[0].riprovaAutomatica).toBe(true)
  })

  it('un server più vecchio del client non manda il campo: vale false, e la scheda è quella di prima', async () => {
    const rete = vi.fn(async () => risposta(200, statoCon({})))
    const esito = await leggiStatoIntentoVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.dati.job[0].riprovaAutomatica).toBe(false)
  })

  it('il flag su un job che non aspetta né lavora è un dato fuori contratto: non diventa una schermata', async () => {
    // «Lo stiamo riprovando» su un video pronto direbbe che qualcosa sta ancora succedendo.
    // Si scarta lo stato intero e lo si LOGGA (un difetto del server non deve passare in silenzio).
    const rete = vi.fn(async () => risposta(200, statoCon({ stato: 'ready', avanzamento: 100, riprovaAutomatica: true })))
    const esito = await leggiStatoIntentoVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(false)
    expect(
      h.logClient.mock.calls.some(([voce]) => String((voce as { messaggio?: string }).messaggio).includes('video-galleria-job-fuori-contratto')),
      'uno stato fuori contratto non è stato loggato',
    ).toBe(true)
  })

  it('un job fallito per un guasto nostro porta il codice mostrabile, non quello interno', async () => {
    const rete = vi.fn(async () =>
      risposta(200, statoCon({ stato: 'failed', avanzamento: null, codice: 'VIDEO_GUASTO_NOSTRO' })),
    )
    const esito = await leggiStatoIntentoVideo(rete, { intentId: INTENTO, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.dati.job[0].codice).toBe('VIDEO_GUASTO_NOSTRO')
      expect(esito.dati.job[0].riprovaAutomatica).toBe(false)
    }
    // Un codice INTERNO che provasse a uscire non passa lo schema (è il confine che protegge le famiglie).
    const interno = vi.fn(async () =>
      risposta(200, statoCon({ stato: 'failed', avanzamento: null, codice: 'BUILD_DOWNLOAD_FAILED' })),
    )
    expect((await leggiStatoIntentoVideo(interno, { intentId: INTENTO, ripiego: 'ripiego' })).ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// L'ELENCO — i miei video, da qualunque dispositivo
// ═══════════════════════════════════════════════════════════════════════════

describe('leggiElencoVideoGalleria', () => {
  const voceValida = (extra: Record<string, unknown> = {}) => ({
    intentId: INTENTO,
    jobId: JOB,
    fase: 'in-coda',
    codice: null,
    creatoIl: '2026-10-02T10:00:00.000Z',
    aggiornatoIl: '2026-10-02T10:00:09.000Z',
    trasporto: 'tus',
    byte: 1234,
    durataS: null,
    nBambini: 2,
    broadcast: false,
    mediaId: null,
    pubblicazioneAutomatica: true,
    riprovaPossibile: false,
    ...extra,
  })

  it('chiede `canale=gallery` e la SEDE: l’elenco è di una sede sola', async () => {
    const rete = vi.fn(async () => risposta(200, { voci: [voceValida()] }))
    const esito = await leggiElencoVideoGalleria(rete, { scuolaId: SEDE_A, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit | undefined]
    expect(url).toBe(`/api/video-uploads?canale=gallery&scuolaId=${SEDE_A}`)
    expect(init?.method ?? 'GET').toBe('GET')
    if (esito.ok) expect(esito.dati.voci).toHaveLength(1)
  })

  it('una voce che non rispetta il contratto non fa cadere le altre, e lascia UNA riga col solo conteggio', async () => {
    const rete = vi.fn(async () =>
      risposta(200, { voci: [voceValida(), voceValida({ jobId: 'non-un-uuid' }), voceValida({ fase: 'fase-inventata' })] }),
    )
    const esito = await leggiElencoVideoGalleria(rete, { scuolaId: SEDE_A, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    if (esito.ok) expect(esito.dati.voci.map((v) => v.jobId)).toEqual([JOB])
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({
        livello: 'error',
        messaggio: 'video-galleria-voci-fuori-contratto',
        campi: { ricevute: 3, scartate: 2 },
      }),
    )
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('non-un-uuid')
  })

  it('una voce incoerente (un codice d’errore su un video che non è andato male) si scarta', async () => {
    const rete = vi.fn(async () => risposta(200, { voci: [voceValida({ codice: 'VIDEO_TROPPO_LUNGO' })] }))
    const esito = await leggiElencoVideoGalleria(rete, { scuolaId: SEDE_A, ripiego: 'ripiego' })
    expect(esito.ok && esito.dati.voci).toEqual([])
  })

  it('un corpo senza elenco non è un elenco vuoto: è un difetto, e si dice', async () => {
    const rete = vi.fn(async () => risposta(200, {}))
    const esito = await leggiElencoVideoGalleria(rete, { scuolaId: SEDE_A, ripiego: 'ripiego' })
    expect(esito.ok).toBe(false)
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'video-galleria-elenco-fuori-contratto' }),
    )
  })

  it('un rifiuto (sede non propria, 403) e una rete caduta sono «non lo so», non «nessun video»', async () => {
    const rifiuto = await leggiElencoVideoGalleria(
      vi.fn(async () => risposta(403, { error: 'x', codice: 'VIDEO_NON_AUTORIZZATO' })),
      { scuolaId: SEDE_B, ripiego: 'ripiego' },
    )
    expect(rifiuto.ok).toBe(false)
    if (!rifiuto.ok) expect(rifiuto.messaggio).toBe(itShared.erroreVideoNonAutorizzato)

    const caduta = await leggiElencoVideoGalleria(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
      { scuolaId: SEDE_A, ripiego: 'ripiego' },
    )
    expect(caduta.ok).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// IL CLIENT NON PUBBLICA PIÙ — a farlo è il server
// ═══════════════════════════════════════════════════════════════════════════

describe('il modulo non ha più nessun ramo di pubblicazione', () => {
  it('niente `pubblicaVideoInGalleria`, niente «conferma», niente fasi del vecchio ciclo', () => {
    // Il ramo `POST /api/gallery` con `video_intent_id` risponde 409 a chi lo prova ancora, e il client
    // non lo chiama più (secondario #87): una funzione che lo facesse sarebbe un client che non si
    // aggiorna da solo. Il test dei nomi tiene il gesto fermo; quello della pagina prova che non parte.
    const esportati = Object.keys(flusso)
    for (const tolto of ['pubblicaVideoInGalleria', 'confermaIntentoVideo', 'faseDelJob']) {
      expect(esportati, `${tolto} è tornato`).not.toContain(tolto)
    }
  })
})


// ═══════════════════════════════════════════════════════════════════════════
// L'INVIO NATIVO (app 1.2, compito J3) — la chiave `gn1-` e l'apertura `put-nativo`
// ═══════════════════════════════════════════════════════════════════════════
//
// Nell'app 1.2 un video scelto dal selettore nativo non è un `File`: l'identità di ciò che parte è lo `sha256` dei
// suoi byte. Qui si tiene ferma la FORMA della chiave (che la RPC vera la accetti e ritrovi lo stesso intento lo prova
// `video-galleria-chiave-rpc.test.ts`, su PGlite) e la lettura della risposta dell'apertura, che porta due credenziali:
// l'URL firmato della PUT e il token di rinnovo.

/** Gli `sha256` di due video diversi, calcolati con `node:crypto` (non due stringhe a caso: hanno la forma dei veri). */
const SHA_A = createHash('sha256').update('contenuto del video A').digest('hex')
const SHA_B = createHash('sha256').update('contenuto del video B').digest('hex')
const VIDEO_A = { byte: 73_000_000, sha256: SHA_A }

describe('chiaveIdempotenzaVideoNativo — `gn1-<byte>-<impronta del contenuto>-<impronta dell’invio>`', () => {
  const chiave = (video = VIDEO_A, bambini = conBambini([BAMBINO_A]), sale = SALE_A) =>
    chiaveIdempotenzaVideoNativo(video, bambini, sale)
  /** Le due impronte: `gn1-<byte>-<contenuto>-<invio>`. */
  const pezzi = (k: string) => {
    const p = k.split('-')
    expect(p, k).toHaveLength(4)
    return { byte: p[1], contenuto: p[2], invio: p[3] }
  }

  it('ha la forma `gn1-<byte>-<12 cifre>-<12 cifre>`, e non può essere scambiata con una chiave del TUS o del flusso vecchio', () => {
    const k = chiave()
    expect(k).toMatch(/^gn1-73000000-[0-9a-f]{12}-[0-9a-f]{12}$/)
    // Il server legge la chiave per prefisso: `g-` è il flusso vecchio (409 se già usata), `gv2-` il TUS di oggi.
    expect(k.startsWith('g-')).toBe(false)
    expect(k.startsWith('gv2-')).toBe(false)
  })

  it('è DETERMINISTICA: lo stesso video con gli stessi bambini dà la stessa chiave (la risposta si è persa: si ritrova l’intento)', () => {
    expect(chiave()).toBe(chiave())
    // Un'app morta fra l'apertura e `accodaVideo` non apre un doppione al reinvio: è il motivo per cui non è un UUID per «Invia».
    expect(chiave(VIDEO_A, conBambini([BAMBINO_A, BAMBINO_B]))).toBe(chiave(VIDEO_A, conBambini([BAMBINO_A, BAMBINO_B])))
  })

  it('i bambini sono un INSIEME: ordine, doppioni e grafia dell’uuid non cambiano la chiave', () => {
    const base = chiave(VIDEO_A, conBambini([BAMBINO_A, BAMBINO_B]))
    expect(chiave(VIDEO_A, conBambini([BAMBINO_B, BAMBINO_A]))).toBe(base)
    expect(chiave(VIDEO_A, conBambini([BAMBINO_A, BAMBINO_B, BAMBINO_A]))).toBe(base)
    expect(chiave(VIDEO_A, conBambini([BAMBINO_B.toUpperCase(), BAMBINO_A]))).toBe(base)
  })

  it('lo stesso video con bambini DIVERSI è un’altra chiave: un altro invio, mai un `IDEMPOTENCY_CONFLICT`', () => {
    const solo = chiave(VIDEO_A, conBambini([BAMBINO_A]))
    const altro = chiave(VIDEO_A, conBambini([BAMBINO_B]))
    const insieme = chiave(VIDEO_A, conBambini([BAMBINO_A, BAMBINO_B]))
    expect(new Set([solo, altro, insieme]).size).toBe(3)
    // Il pezzo che dice «è lo stesso video» resta uguale; cambia solo quello che porta i bambini.
    expect(pezzi(altro).byte).toBe(pezzi(solo).byte)
    expect(pezzi(altro).contenuto).toBe(pezzi(solo).contenuto)
    expect(pezzi(altro).invio).not.toBe(pezzi(solo).invio)
    // Tutta la classe al posto dei bambini scelti è un altro invio, e classi diverse pure.
    const classe = chiave(VIDEO_A, conBambini([], { broadcast: true, classi: ['3 ANNI'] }))
    expect(classe).not.toBe(solo)
    expect(chiave(VIDEO_A, conBambini([], { broadcast: true, classi: ['4 ANNI'] }))).not.toBe(classe)
  })

  it('conta ciò che PARTE verso il server: in broadcast i tag non contano, senza broadcast le classi non contano', () => {
    expect(chiave(VIDEO_A, conBambini([BAMBINO_A], { broadcast: true, classi: ['3 ANNI'] })))
      .toBe(chiave(VIDEO_A, conBambini([BAMBINO_B], { broadcast: true, classi: ['3 ANNI'] })))
    expect(chiave(VIDEO_A, conBambini([BAMBINO_A], { classi: ['3 ANNI'] })))
      .toBe(chiave(VIDEO_A, conBambini([BAMBINO_A], { classi: [] })))
    // E le classi, in un broadcast, sono un insieme anche loro.
    expect(chiave(VIDEO_A, conBambini([], { broadcast: true, classi: ['4 ANNI', '3 ANNI', '4 ANNI'] })))
      .toBe(chiave(VIDEO_A, conBambini([], { broadcast: true, classi: ['3 ANNI', '4 ANNI'] })))
  })

  it('un video DIVERSO (altro contenuto, o altro peso) è un’altra chiave, anche con gli stessi bambini', () => {
    const base = chiave()
    expect(chiave({ byte: VIDEO_A.byte, sha256: SHA_B })).not.toBe(base)
    expect(chiave({ byte: VIDEO_A.byte + 1, sha256: SHA_A })).not.toBe(base)
    // Il contenuto cambia ENTRAMBE le impronte: un confronto sul solo secondo pezzo non lo vedrebbe.
    expect(pezzi(chiave({ byte: VIDEO_A.byte, sha256: SHA_B })).contenuto).not.toBe(pezzi(base).contenuto)
    expect(pezzi(chiave({ byte: VIDEO_A.byte, sha256: SHA_B })).invio).not.toBe(pezzi(base).invio)
  })

  it('lo `sha256` si normalizza in minuscolo: il server lo riporta così, e due grafie non sono due video', () => {
    expect(chiave({ byte: VIDEO_A.byte, sha256: SHA_A.toUpperCase() })).toBe(chiave())
  })

  it('è SALATA col sale del dispositivo, in entrambe le impronte: due dispositivi, due chiavi (e nessun conflitto)', () => {
    const a = chiave(VIDEO_A, conBambini([BAMBINO_A]), SALE_A)
    const b = chiave(VIDEO_A, conBambini([BAMBINO_A]), SALE_B)
    expect(a).not.toBe(b)
    expect(pezzi(a).contenuto).not.toBe(pezzi(b).contenuto)
    expect(pezzi(a).invio).not.toBe(pezzi(b).invio)
    // La parte che non è personale resta uguale.
    expect(pezzi(a).byte).toBe(pezzi(b).byte)
  })

  it('le due impronte sono di due DOMINI: non si confrontano con quella dell’altro, neppure per lo stesso contenuto', () => {
    const k = pezzi(chiave())
    expect(k.contenuto).not.toBe(k.invio)
    // L'impronta del contenuto non è lo SHA-256 salato di `sha256` in un altro dominio: provarne uno solo non basta.
    expect(sha256Esadecimale(`${SALE_A}:contenuto:${SHA_A}`).slice(0, 12)).toBe(k.contenuto)
    expect(sha256Esadecimale(`${SALE_A}:bambini:${SHA_A}`).slice(0, 12)).not.toBe(k.contenuto)
  })

  it('NON contiene lo `sha256`, il nome del file né l’uuid di un bambino: la chiave finisce IN CHIARO in `video_jobs.idempotency_key`', () => {
    const k = chiave(VIDEO_A, conBambini([BAMBINO_A, BAMBINO_B]))
    // Nemmeno un pezzo riconoscibile dello `sha256` (le 12 cifre della chiave sono SALATE, non il suo prefisso).
    expect(k).not.toContain(SHA_A)
    expect(k).not.toContain(SHA_A.slice(0, 12))
    expect(k).not.toContain(SHA_A.slice(-12))
    for (const id of [BAMBINO_A, BAMBINO_B]) {
      expect(k).not.toContain(id)
      expect(k).not.toContain(id.slice(0, 8))
    }
    // …e il sale non esce, nemmeno a pezzi.
    expect(k).not.toContain(SALE_A)
    expect(k).not.toContain(SALE_A.slice(0, 8))
    expect(k).toMatch(/^[a-z0-9-]+$/)
  })

  it('IL DIFETTO DI #131, sulla chiave nuova: senza il sale i sottoinsiemi di bambini non si ritrovano, con il sale sì (controllo positivo)', () => {
    // L'attacco di chi legge la tabella: conosce gli uuid dei bambini della sede e prova tutti i sottoinsiemi.
    const SEGRETA = [CLASSE_DEL_NIDO[1], CLASSE_DEL_NIDO[4], CLASSE_DEL_NIDO[7]]
    const inTabella = pezzi(chiave(VIDEO_A, conBambini(SEGRETA), SALE_A)).invio
    const prova = (sale: string) => (tag: string[]) => pezzi(chiave(VIDEO_A, conBambini(tag), sale)).invio
    // Controllo positivo: col sale giusto l'attacco funziona, quindi il test dopo non è verde a vuoto.
    expect(scelteCompatibili(inTabella, prova(SALE_A))).toEqual([SEGRETA])
    // Senza il sale (quello di un altro dispositivo) non torna niente.
    expect(scelteCompatibili(inTabella, prova(SALE_B))).toEqual([])
  })

  it('resta nel limite di 128 caratteri anche col suffisso `-<uuid>` del ramo «intento concluso», nel caso peggiore', () => {
    const peggiore = chiaveIdempotenzaVideoNativo(
      { byte: MAX_VIDEO_INPUT_BYTES, sha256: SHA_A },
      conBambini(Array.from({ length: 1000 }, (_, i) => `55555555-0000-4000-8000-${String(i).padStart(12, '0')}`)),
      SALE_A,
    )
    expect(peggiore.length + 1 + 36).toBeLessThanOrEqual(128)
    expect(peggiore).toMatch(/^[a-z0-9-]+$/)
  })

  it('un sale, uno `sha256` o un peso che non hanno la forma dei veri si RIFIUTANO: una chiave su un dato storto non la ritrova nessuno', () => {
    for (const sale of ['', 'x', 'a'.repeat(31), 'A'.repeat(32), `${SALE_A}!`]) {
      expect(() => chiaveIdempotenzaVideoNativo(VIDEO_A, conBambini([BAMBINO_A]), sale), JSON.stringify(sale)).toThrow('SaleNonValido')
    }
    for (const sha256 of ['', 'abc', 'g'.repeat(64), SHA_A.slice(1), `${SHA_A}0`, ` ${SHA_A}`]) {
      expect(() => chiaveIdempotenzaVideoNativo({ byte: 10, sha256 }, conBambini([BAMBINO_A]), SALE_A), JSON.stringify(sha256)).toThrow('Sha256NonValido')
    }
    for (const byte of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => chiaveIdempotenzaVideoNativo({ byte, sha256: SHA_A }, conBambini([BAMBINO_A]), SALE_A), String(byte)).toThrow('ByteNonValidi')
    }
  })

  it('senza un sale esplicito usa quello del DISPOSITIVO (lo stesso della `gv2-`), e lo stesso invio ritrova la sua chiave', () => {
    localStorage.setItem(CHIAVE_SALE_NEL_DEPOSITO, SALE_A)
    try {
      expect(chiaveIdempotenzaVideoNativo(VIDEO_A, conBambini([BAMBINO_A]))).toBe(chiave(VIDEO_A, conBambini([BAMBINO_A]), SALE_A))
      localStorage.setItem(CHIAVE_SALE_NEL_DEPOSITO, SALE_B)
      expect(chiaveIdempotenzaVideoNativo(VIDEO_A, conBambini([BAMBINO_A]))).toBe(chiave(VIDEO_A, conBambini([BAMBINO_A]), SALE_B))
    } finally {
      localStorage.removeItem(CHIAVE_SALE_NEL_DEPOSITO)
    }
  })
})

describe('intentoConcluso — un intento ritrovato che è già finito non si riapre: serve un intento nuovo', () => {
  it.each([
    ['published', 'queued', true],
    ['cancelled', 'awaiting_upload', true],
    ['superseded', 'awaiting_upload', true],
    ['confirmed', 'failed', true],
    ['confirmed', 'rejected', true],
    ['confirmed', 'awaiting_upload', false],
    ['confirmed', 'processing', false],
    ['pending', 'awaiting_upload', false],
  ] as const)('intento %s, job %s ⇒ concluso: %s', (statoIntent, statoJob, atteso) => {
    expect(intentoConcluso({ statoIntent, statoJob })).toBe(atteso)
  })
})

const PUT_COORDINATE = {
  protocollo: 'put' as const,
  url: 'https://esempio.supabase.co/storage/v1/object/upload/sign/video_originals/percorso.mov?token=TOKEN-FINTO-DELLA-PUT',
  metodo: 'PUT' as const,
  intestazioni: { 'content-type': 'video/quicktime' },
}
/** `kvr_` più 43 caratteri base64url: la forma del token che il server conia (`schemaTokenRinnovoVideo`). */
const TOKEN_RINNOVO = `kvr_${'Ab1_-'.repeat(8)}Ab1`
const SCADENZA_URL = '2026-10-03T12:00:00.000Z'
const SCADENZA_TOKEN = '2026-10-05T10:00:00.000Z'

/** La risposta di un'apertura `put-nativo` riuscita: l'URL firmato nel job e il token di rinnovo accanto. */
function aperturaNativaRiuscita(extra: Record<string, unknown> = {}, job: Record<string, unknown> = {}) {
  return {
    intentId: INTENTO,
    revisione: 1,
    canale: 'gallery',
    intent: { status: 'confirmed' },
    scadenzaCaricamentoIl: SCADENZA_URL,
    job: [{
      jobId: JOB,
      chiaveIdempotenza: 'gn1-73000000-aaaaaaaaaaaa-bbbbbbbbbbbb',
      caricamento: PUT_COORDINATE,
      firma: '',
      status: 'awaiting_upload',
      needs_upload: true,
      expires_at: SCADENZA_URL,
      rinnovo: { token: TOKEN_RINNOVO, scadeIl: SCADENZA_TOKEN },
      ...job,
    }],
    ...extra,
  }
}

type DatiAperturaNativa = Parameters<typeof apriIntentoVideoGalleriaNativo>[1]

/** Un'apertura nativa con le impostazioni di tutti i giorni; ogni test cambia solo ciò che prova. */
function apriNativo(
  rete: Parameters<typeof apriIntentoVideoGalleriaNativo>[0],
  extra: Partial<DatiAperturaNativa> = {},
) {
  return apriIntentoVideoGalleriaNativo(rete, {
    file: { nome: 'filmato-privato.mov', byte: 73_000_000, mime: 'video/quicktime', sha256: SHA_A },
    scuolaId: SEDE_A,
    durataSecondi: 52,
    chiaveIdempotenza: 'gn1-73000000-aaaaaaaaaaaa-bbbbbbbbbbbb',
    destinatari: { tagAlunni: [BAMBINO_A], broadcast: false, classi: [] },
    ripiego: 'ripiego',
    ...extra,
  })
}

describe('apriIntentoVideoGalleriaNativo', () => {
  it('dichiara il trasporto `put-nativo` e lo `sha256` del file, con i bambini e la sede', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita()))
    const esito = await apriNativo(rete)
    expect(esito.ok).toBe(true)

    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/video-uploads')
    expect(init.method).toBe('POST')
    const corpo = JSON.parse(String(init.body))
    expect(corpo).toMatchObject({
      canale: 'gallery', azione: 'publish', scuolaId: SEDE_A, ambitoGlobale: false, trasporto: 'put-nativo',
      destinatari: { tagAlunni: [BAMBINO_A], broadcast: false, classi: [] },
    })
    expect(corpo.file).toHaveLength(1)
    expect(corpo.file[0]).toEqual({
      chiaveIdempotenza: 'gn1-73000000-aaaaaaaaaaaa-bbbbbbbbbbbb',
      nome: 'filmato-privato.mov', byte: 73_000_000, mime: 'video/quicktime', durataSecondi: 52, sha256: SHA_A,
    })
  })

  it('il corpo passa lo schema VERO della route: `put-nativo` esige lo `sha256`, e col nostro corpo non manca', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita()))
    const file = { nome: 'filmato-privato.mov', byte: 73_000_000, mime: 'video/quicktime', sha256: SHA_A }
    const destinatari = { tagAlunni: [BAMBINO_A, BAMBINO_B], broadcast: false, classi: [] as string[] }
    await apriNativo(rete, { file, destinatari, chiaveIdempotenza: chiaveIdempotenzaVideoNativo(file, destinatari, SALE_A) })

    const corpo = corpoDellaChiamata(rete)
    const letto = schemaAperturaIntentVideo.safeParse(corpo)
    expect(letto.success, JSON.stringify(letto.error?.issues)).toBe(true)
    if (letto.success) {
      expect(letto.data.trasporto).toBe('put-nativo')
      expect(letto.data.file[0].sha256).toBe(SHA_A)
      expect(letto.data.file[0].chiaveIdempotenza).toMatch(/^gn1-/)
    }
    // La controprova: lo stesso corpo SENZA `sha256` lo rifiuta la route — è la garanzia che regge una PUT che non si riprende.
    const senza = { ...corpo, file: [{ ...corpo.file[0], sha256: undefined }] }
    expect(schemaAperturaIntentVideo.safeParse(senza).success).toBe(false)
  })

  it('in broadcast i tag non partono e le classi sì; una durata non misurabile viaggia come `null`', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita()))
    await apriNativo(rete, { destinatari: { tagAlunni: [BAMBINO_A], broadcast: true, classi: ['3 ANNI'] }, durataSecondi: Number.NaN })
    const corpo = corpoDellaChiamata(rete)
    expect(corpo.destinatari).toEqual({ tagAlunni: [], broadcast: true, classi: ['3 ANNI'] })
    expect(corpo.file[0].durataSecondi).toBeNull()
  })

  it('un MIME vuoto ripiega su `video/mp4`: il server rifiuterebbe un `mime` assente', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita()))
    await apriNativo(rete, { file: { nome: 'a.mov', byte: 10, mime: '', sha256: SHA_A } })
    expect(corpoDellaChiamata(rete).file[0].mime).toBe('video/mp4')
  })

  it('rilegge la risposta col suo schema: URL e `content-type` della PUT, token e scadenza del rinnovo, scadenza dell’URL', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita()))
    const esito = await apriNativo(rete)
    expect(esito).toEqual({
      ok: true,
      dati: {
        intentId: INTENTO,
        revisione: 1,
        jobId: JOB,
        chiaveIdempotenza: 'gn1-73000000-aaaaaaaaaaaa-bbbbbbbbbbbb',
        statoIntent: 'confirmed',
        statoJob: 'awaiting_upload',
        needsUpload: true,
        expiresAt: SCADENZA_URL,
        put: { url: PUT_COORDINATE.url, contentType: 'video/quicktime' },
        rinnovo: { token: TOKEN_RINNOVO, scadeIl: SCADENZA_TOKEN },
      },
    })
  })

  it('byte GIÀ arrivati (`needs_upload: false`): le coordinate sono di ripiego (TUS) e non si guardano; né URL né token', async () => {
    // Senza byte da spedire il server manda coordinate TUS di ripiego e nessun token: lo schema le ammette, e il nativo non ne ha bisogno.
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita({}, { caricamento: COORDINATE, rinnovo: undefined, needs_upload: false, expires_at: null })))
    const esito = await apriNativo(rete)
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.dati.needsUpload).toBe(false)
      expect(esito.dati.put).toBeNull()
      expect(esito.dati.rinnovo).toBeNull()
      expect(esito.dati.expiresAt).toBeNull()
    }
  })

  it('un intento ritrovato GIÀ CONCLUSO porta lo stato dell’intento e del job, perché chi chiama lo riconosca', async () => {
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita({ intent: { status: 'published' } }, { status: 'ready', needs_upload: false, caricamento: COORDINATE, rinnovo: undefined, expires_at: null })))
    const esito = await apriNativo(rete)
    expect(esito.ok).toBe(true)
    if (esito.ok) {
      expect(esito.dati.statoIntent).toBe('published')
      expect(esito.dati.statoJob).toBe('ready')
      expect(intentoConcluso(esito.dati)).toBe(true)
    }
  })

  it.each([
    ['byte da spedire ma coordinate TUS (il server e il client non si capiscono)', { caricamento: COORDINATE, firma: 'firma-presente', rinnovo: undefined }],
    ['byte da spedire e URL di PUT, ma SENZA il token di rinnovo', { rinnovo: undefined }],
    ['un token di rinnovo di un’altra forma', { rinnovo: { token: 'kvr_corto', scadeIl: SCADENZA_TOKEN } }],
    ['un URL di PUT in chiaro (http)', { caricamento: { ...PUT_COORDINATE, url: 'http://esempio.supabase.co/x' } }],
  ])('una risposta incompleta non diventa una PUT: %s', async (_nome, job) => {
    const rete = vi.fn(async () => risposta(201, aperturaNativaRiuscita({}, job)))
    const esito = await apriNativo(rete, { ripiego: 'frase di ripiego' })
    expect(esito).toEqual({ ok: false, codice: null, messaggio: 'frase di ripiego', stato: null })
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', messaggio: 'video-galleria-apertura-incompleta', campi: expect.objectContaining({ tipo: 'put-nativo' }) }),
    )
  })

  it('una risposta senza job, o che non è un oggetto, è incompleta e lascia la sua riga', async () => {
    for (const corpo of [{ ...aperturaNativaRiuscita(), job: [] }, {}, null, 'testo']) {
      h.logClient.mockClear()
      const esito = await apriNativo(vi.fn(async () => risposta(201, corpo)))
      expect(esito.ok, JSON.stringify(corpo)).toBe(false)
      expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'video-galleria-apertura-incompleta' }))
    }
  })

  it('il 422 del Privacy Lock porta i NOMI a schermo (con la sua prosa), e non nei log: prima di un solo byte', async () => {
    const rete = vi.fn(async () =>
      risposta(422, { error: 'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto.', nomi: ['Ada B.'], ids: [BAMBINO_A] }),
    )
    const esito = await apriNativo(rete)
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.stato).toBe(422)
      expect(esito.nomi).toEqual(['Ada B.'])
      expect(esito.messaggio).toContain('Foto di gruppo non pubblicabile')
    }
    const scritto = JSON.stringify(h.logClient.mock.calls)
    expect(scritto).not.toContain('Ada')
    expect(scritto).not.toContain(BAMBINO_A)
    // L'operazione si distingue da quella del TUS: un rifiuto dell'apertura nativa si legge a sé.
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ messaggio: 'video-galleria-rifiutata: apertura-nativa', stato: 422 }))
  })

  it('un rifiuto con `codice` (403) si legge dal CATALOGO, e una rete caduta dice che non è partito (stato `null`)', async () => {
    const rifiutato = await apriNativo(vi.fn(async () => risposta(403, { error: 'prosa del server', codice: 'TAG_FUORI_SEDE' })))
    expect(rifiutato.ok).toBe(false)
    if (!rifiutato.ok) {
      expect(rifiutato.messaggio).toBe(itShared.erroreTagFuoriSede)
      expect(rifiutato.codice).toBe('TAG_FUORI_SEDE')
    }

    const caduta = await apriNativo(vi.fn(async () => { throw new TypeError('Failed to fetch') }), { ripiego: 'Nessuna rete' })
    expect(caduta).toEqual({ ok: false, codice: null, messaggio: 'Nessuna rete', stato: null })
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error', messaggio: 'video-galleria-rete: apertura-nativa' }))
  })

  it('NON scrive nei log il nome del file, lo `sha256`, l’URL firmato, il token né i bambini: sono dati di minori e credenziali', async () => {
    // Tre esiti, tre percorsi di log: rifiuto, rete caduta, risposta incompleta (e anche il successo, che non scrive niente).
    await apriNativo(vi.fn(async () => risposta(500, { error: 'boom', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' })))
    await apriNativo(vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await apriNativo(vi.fn(async () => risposta(201, aperturaNativaRiuscita({}, { rinnovo: undefined }))))
    await apriNativo(vi.fn(async () => risposta(201, aperturaNativaRiuscita())))
    const scritto = JSON.stringify(h.logClient.mock.calls)
    expect(scritto.length).toBeGreaterThan(50)
    for (const segreto of ['filmato-privato', SHA_A, SHA_A.slice(0, 16), 'supabase.co', 'TOKEN-FINTO', 'kvr_', TOKEN_RINNOVO, BAMBINO_A]) {
      expect(scritto, segreto).not.toContain(segreto)
    }
    // Dei bambini passa il NUMERO, che sta nei campi.
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ campi: expect.objectContaining({ n_tag: 1, broadcast: false, byte: 73_000_000 }) }))
  })
})
