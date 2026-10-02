import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  annullaIntentoVideo,
  chiaveIdempotenzaVideo,
  durataVideoDalFile,
  leggiElencoVideoGalleria,
  leggiStatoIntentoVideo,
  rifiutoLocaleVideo,
  riprovaPubblicazioneVideo,
  sediDalCookie,
  sedeDelCaricamento,
  segnalaVideoCaricato,
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
