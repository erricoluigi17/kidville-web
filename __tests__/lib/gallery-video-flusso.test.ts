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

import { MAX_VIDEO_DURATION_SECONDS, MAX_VIDEO_INPUT_BYTES } from '@/lib/media/video/limiti'
import {
  apriIntentoVideoGalleria,
  annullaIntentoVideo,
  chiaveIdempotenzaVideo,
  confermaIntentoVideo,
  durataVideoDalFile,
  faseDelJob,
  leggiStatoIntentoVideo,
  pubblicaVideoInGalleria,
  rifiutoLocaleVideo,
  sediDalCookie,
  sedeDelCaricamento,
  segnalaVideoCaricato,
} from '@/lib/gallery/video-galleria-flusso'
import itShared from '../../messages/it/shared.json'

const INTENTO = '11111111-0000-4000-8000-000000000001'
const JOB = '22222222-0000-4000-8000-000000000002'
const DOCENTE = '33333333-0000-4000-8000-000000000003'

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
// LA CHIAVE DI IDEMPOTENZA — deterministica, e senza il nome di un bambino
// ═══════════════════════════════════════════════════════════════════════════

describe('chiaveIdempotenzaVideo', () => {
  it('lo stesso file dà la stessa chiave: un ritentativo ritrova il suo job', () => {
    const a = chiaveIdempotenzaVideo(fileVideo())
    const b = chiaveIdempotenzaVideo(fileVideo())
    expect(a).toBe(b)
  })

  it('due file diversi danno chiavi diverse, anche a parità di taglia e data', () => {
    const a = chiaveIdempotenzaVideo(fileVideo({ nome: 'recita.mp4' }))
    const b = chiaveIdempotenzaVideo(fileVideo({ nome: 'saggio.mp4' }))
    expect(a).not.toBe(b)
  })

  it('NON contiene il nome del file: finirebbe in `video_jobs.idempotency_key`', () => {
    // `IMG_bambina-rossi.mov` è anagrafica di un minore. La chiave viaggia al
    // server, viene scritta in tabella e compare nei log della route.
    const chiave = chiaveIdempotenzaVideo(fileVideo({ nome: 'recita-di-natale-bambina-rossi.mov' }))
    expect(chiave.toLowerCase()).not.toContain('rossi')
    expect(chiave.toLowerCase()).not.toContain('recita')
    expect(chiave).toMatch(/^[a-z0-9-]+$/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// L'APERTURA DELL'INTENTO
// ═══════════════════════════════════════════════════════════════════════════

describe('apriIntentoVideoGalleria', () => {
  it('dichiara canale, azione, sede e UN solo file — quello che la Galleria ammette', async () => {
    const rete = vi.fn(async () =>
      risposta(201, {
        intentId: INTENTO,
        revisione: 1,
        canale: 'gallery',
        scadenzaCaricamentoIl: '2026-09-18T12:00:00.000Z',
        job: [{ jobId: JOB, chiaveIdempotenza: 'g-1', caricamento: COORDINATE, firma: 'firma-finta' }],
      }),
    )

    const esito = await apriIntentoVideoGalleria(rete, {
      file: fileVideo({ byte: 999, tipo: 'video/mp4;codecs=avc1' }),
      scuolaId: SEDE_A,
      durataSecondi: 12,
      chiaveIdempotenza: 'g-1',
      ripiego: 'ripiego',
    })

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

  it('una durata non misurabile viaggia come `null`, non come 0 né come NaN', async () => {
    const rete = vi.fn(async () =>
      risposta(201, {
        intentId: INTENTO,
        revisione: 1,
        canale: 'gallery',
        scadenzaCaricamentoIl: '2026-09-18T12:00:00.000Z',
        job: [{ jobId: JOB, chiaveIdempotenza: 'g-1', caricamento: COORDINATE, firma: 'f' }],
      }),
    )
    await apriIntentoVideoGalleria(rete, {
      file: fileVideo(),
      scuolaId: SEDE_A,
      durataSecondi: Number.NaN,
      chiaveIdempotenza: 'g-1',
      ripiego: 'ripiego',
    })
    const corpo = JSON.parse(String((rete.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(corpo.file[0].durataSecondi).toBeNull()
  })

  it('un rifiuto del server si legge dal CATALOGO, non dalla prosa italiana della route', async () => {
    // È il difetto T10-F1: con l'interfaccia in inglese la prosa del server resta
    // italiana. Il codice invece ha la sua voce in `messages/{it,en}/shared.json`.
    const rete = vi.fn(async () =>
      risposta(413, { error: 'Il video supera il limite consentito.', codice: 'VIDEO_TROPPO_GRANDE' }),
    )
    const esito = await apriIntentoVideoGalleria(rete, {
      file: fileVideo(),
      scuolaId: SEDE_A,
      durataSecondi: null,
      chiaveIdempotenza: 'g-1',
      ripiego: 'ripiego-che-non-deve-comparire',
    })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.codice).toBe('VIDEO_TROPPO_GRANDE')
      expect(esito.messaggio).toBe(itShared.erroreVideoTroppoGrande)
      expect(esito.stato).toBe(413)
    }
  })

  it('una prosa del server SENZA codice non arriva a schermo: resta la frase tradotta', async () => {
    // ⚠️ IL CONTROLLO CHE MORDE, e il precedente da solo non mordeva: con un codice
    // dichiarato `messaggioDaCorpo` e `soloCatalogoDaCorpo` danno la STESSA frase,
    // quindi quel test resterebbe verde anche con la regola sbagliata. La differenza
    // fra le due si vede solo qui: un rifiuto senza codice — un 400 di validazione
    // zod, un 429, un 502 dell'infrastruttura — porta prosa ITALIANA scritta in una
    // route dove il locale non esiste, e con l'interfaccia in inglese sarebbe il
    // fallimento F2 del collaudo del 2026-07-31 riaperto in una schermata nuova.
    const rete = vi.fn(async () => risposta(400, { error: 'scuolaId: indicare la sede a cui si riferisce' }))
    const esito = await apriIntentoVideoGalleria(rete, {
      file: fileVideo(),
      scuolaId: SEDE_A,
      durataSecondi: null,
      chiaveIdempotenza: 'g-1',
      ripiego: 'La frase del componente',
    })
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
    const esito = await apriIntentoVideoGalleria(rete, {
      file: fileVideo(),
      scuolaId: SEDE_A,
      durataSecondi: null,
      chiaveIdempotenza: 'g-1',
      ripiego: 'Nessuna rete',
    })
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.messaggio).toBe('Nessuna rete')
      expect(esito.stato).toBeNull()
    }
    expect(h.logClient).toHaveBeenCalled()
  })

  it('NON manda il nome del file nei log: è anagrafica di un minore', async () => {
    const rete = vi.fn(async () => risposta(500, { error: 'boom', codice: 'VIDEO_OPERAZIONE_NON_RIUSCITA' }))
    await apriIntentoVideoGalleria(rete, {
      file: fileVideo({ nome: 'recita-bambina-rossi.mov' }),
      scuolaId: SEDE_A,
      durataSecondi: null,
      chiaveIdempotenza: 'g-1',
      ripiego: 'ripiego',
    })
    const scritto = JSON.stringify(h.logClient.mock.calls)
    expect(scritto.toLowerCase()).not.toContain('rossi')
    expect(scritto.toLowerCase()).not.toContain('recita')
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

  it('«conferma» porta la revisione: è l’istante in cui si può chiudere l’app', async () => {
    const rete = vi.fn(async () => risposta(200, statoFinto))
    const esito = await confermaIntentoVideo(rete, { intentId: INTENTO, revisione: 3, ripiego: 'ripiego' })
    expect(esito.ok).toBe(true)
    const corpo = JSON.parse(String((rete.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(corpo).toEqual({ azione: 'conferma', revisione: 3 })
  })

  it('«annulla» ritira l’intento intero con la sua revisione', async () => {
    const rete = vi.fn(async () => risposta(200, statoFinto))
    await annullaIntentoVideo(rete, { intentId: INTENTO, revisione: 2, ripiego: 'ripiego' })
    const corpo = JSON.parse(String((rete.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(corpo).toEqual({ azione: 'annulla', revisione: 2 })
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
// LA PUBBLICAZIONE
// ═══════════════════════════════════════════════════════════════════════════

describe('pubblicaVideoInGalleria', () => {
  const base = {
    intentId: INTENTO,
    revisione: 1,
    utenteId: DOCENTE,
    didascalia: 'Recita',
    tagAlunni: ['44444444-0000-4000-8000-000000000004'],
    broadcast: false,
    classi: ['3 ANNI'],
    scuolaId: SEDE_A,
    ripiego: 'ripiego',
  }

  it('non manda MAI un `file_url`: il percorso lo decide il server dopo la copia', async () => {
    const rete = vi.fn(async () => risposta(201, { id: 'media-1' }))
    const esito = await pubblicaVideoInGalleria(rete, base)
    expect(esito.ok).toBe(true)
    const [url, init] = rete.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/gallery')
    expect(init.method).toBe('POST')
    const corpo = JSON.parse(String(init.body))
    expect(corpo.file_url).toBeUndefined()
    expect(corpo.video_intent_id).toBe(INTENTO)
    expect(corpo.video_revisione).toBe(1)
    expect(corpo.file_type).toBe('video')
    expect(corpo.scuola_id).toBe(SEDE_A)
    expect(corpo.tag_students).toEqual(base.tagAlunni)
    expect((init.headers as Record<string, string>)['x-user-id']).toBe(DOCENTE)
  })

  it('in broadcast i tag non partono: la regola vale anche prima del server', async () => {
    const rete = vi.fn(async () => risposta(201, { id: 'media-1' }))
    await pubblicaVideoInGalleria(rete, { ...base, broadcast: true })
    const corpo = JSON.parse(String((rete.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(corpo.tag_students).toEqual([])
    expect(corpo.is_broadcast).toBe(true)
    expect(corpo.target_classes).toEqual(['3 ANNI'])
  })

  it('il 422 del Privacy Lock porta i NOMI a schermo, e non nei log', async () => {
    const rete = vi.fn(async () =>
      risposta(422, {
        error: 'Foto di gruppo non pubblicabile: …',
        nomi: ['Ada B.'],
        ids: ['44444444-0000-4000-8000-000000000004'],
      }),
    )
    const esito = await pubblicaVideoInGalleria(rete, base)
    expect(esito.ok).toBe(false)
    if (!esito.ok) {
      expect(esito.nomi).toEqual(['Ada B.'])
      // Senza `codice` dichiarato resta la prosa del server, che per la Galleria è
      // la scelta già in vigore (`messaggioDaCorpo`): dice QUALI bambini togliere.
      expect(esito.messaggio).toContain('Foto di gruppo non pubblicabile')
    }
    expect(JSON.stringify(h.logClient.mock.calls)).not.toContain('Ada')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LE FASI — ciò che una persona legge mentre aspetta
// ═══════════════════════════════════════════════════════════════════════════

describe('faseDelJob — l’attesa ha un nome, e non è «caricamento»', () => {
  it('distingue la coda dalla conversione: sono due attese diverse', () => {
    expect(faseDelJob('awaiting_upload')).toBe('caricamento')
    expect(faseDelJob('queued')).toBe('in-coda')
    expect(faseDelJob('processing')).toBe('conversione')
  })

  it('«pronto» non è «pubblicato»: manca ancora un gesto', () => {
    expect(faseDelJob('ready')).toBe('pronto')
  })

  it('i tre modi di finire male non si confondono con un’attesa', () => {
    expect(faseDelJob('failed')).toBe('fallito')
    expect(faseDelJob('rejected')).toBe('fallito')
    expect(faseDelJob('cancelled')).toBe('annullato')
  })
})
