// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// POST /api/iscrizione/insegnanti/upload — il curriculum di chi si candida.
//
// È nata il 2026-08-15, ed è una PORTA ANONIMA CHE SCRIVE NEL BUCKET DEI
// DOCUMENTI DEI MINORI: `form_attachments` custodisce le carte d'identità dei
// genitori e le fotografie dei bambini delle domande d'iscrizione (1389 oggetti
// misurati quel giorno). Il curriculum ci convive sotto il prefisso
// `candidature/`, e la separazione è affidata alla FORMA del percorso.
//
// I difetti che questi test impediscono sono già accaduti tutti, su porte
// gemelle di questo stesso repo:
//
//  1. NESSUN TETTO. `iscrizione/upload` accettava dieci POST di fila senza mai un
//     429 — misurato sul server di produzione il 2026-08-02.
//  2. NESSUNA LISTA DI TIPI. Un `.exe` o un finto `.html` entravano nel bucket.
//  3. IL 500 SU UN ERRORE DEL CLIENT. `request.formData()` LANCIA quando il
//     Content-Type non è multipart, e l'eccezione finiva nel `catch` generico.
//  4. IL CORPO DELL'ERRORE DEL FORNITORE RIGIRATO AL CLIENT, in inglese e col
//     nome di un vincolo interno, davanti a chi non ha nessuno a cui chiedere.
//  5. IL NOME DEL FILE. Su QUESTA porta si chiama `cv-<cognome>.pdf`: è il
//     cognome di chi si è candidato, e lo dice questo stesso repo in testa a
//     `gdpr/retention-candidature`. Non deve sopravvivere alla richiesta — non
//     nel percorso, che finisce in una colonna e dentro un URL firmato in
//     chiaro, e non nei log.
//
// E uno che è solo di questa porta, ed è la ragione per cui il test più
// importante di tutti è l'ultimo: il percorso che questa rotta PRODUCE deve
// essere accettato dal gate che `iscrizione/insegnanti:POST` applica all'INVIO.
// Se le due forme divergono si ottiene un caricamento riuscito e un modulo che
// rifiuta il proprio allegato — dopo che è stato compilato per intero.
// =============================================================================

const h = vi.hoisted(() => ({
  /** Ogni `.storage.from(bucket).upload(path, …)` visto dal finto. */
  uploads: [] as { bucket: string; path: string; contentType?: string; upsert?: boolean }[],
  /** L'errore che lo Storage deve restituire. */
  erroreUpload: null as unknown,
  /** Gli argomenti di ogni `logErrore` / `logEvento`. */
  errori: [] as unknown[][],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', async (orig) => {
  const reale = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logErrore: (...a: unknown[]) => {
      h.errori.push(a)
    },
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _corpo: unknown, opts?: Record<string, unknown>) => {
          h.uploads.push({
            bucket,
            path,
            contentType: opts?.contentType as string | undefined,
            upsert: opts?.upsert as boolean | undefined,
          })
          return { data: h.erroreUpload ? null : { path }, error: h.erroreUpload }
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/iscrizione/insegnanti/upload/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import { TETTO_UPLOAD_CANDIDATURE, ESTENSIONI_ALLEGATO_PUBBLICO } from '@/lib/upload/allegati-pubblici'
import { LIMITE_UPLOAD_BYTE } from '@/lib/upload/limite-piattaforma'
import {
  BUCKET_CURRICULUM,
  CV_PREFISSO,
  percorsoCvAmmesso,
} from '@/lib/candidature/percorso-cv'

/** Un file di byte VERI: la richiesta viaggia in multipart e una taglia finta si perderebbe. */
const fileDa = (nome: string, tipo: string, byte = 32): File =>
  new File([Buffer.alloc(byte, 0x78)], nome, { type: tipo })

/**
 * ⚠️ Il `folder` c'è di proposito in OGNI richiesta: `caricaFile` lo accoda
 * davvero (`extra: { folder: modelId }`), e questa rotta — a differenza della
 * sorella d'iscrizione — deve IGNORARLO. Un test che non lo mandasse mai
 * lascerebbe verde il giorno in cui qualcuno lo leggesse.
 */
function richiesta(file: File | null, ip = '10.0.0.1', folder = 'candidature'): Request {
  const fd = new FormData()
  if (file) fd.append('file', file)
  fd.append('folder', folder)
  return new Request('http://localhost/api/iscrizione/insegnanti/upload', {
    method: 'POST',
    body: fd,
    headers: { 'x-forwarded-for': ip },
  })
}

const richiestaNonMultipart = (ip = '10.0.0.9'): Request =>
  new Request('http://localhost/api/iscrizione/insegnanti/upload', {
    method: 'POST',
    body: '{"file":"eccolo"}',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  })

/** Il caso normale: un curriculum in PDF, col nome che ha davvero in produzione. */
const curriculum = () => fileDa('cv-rossi.pdf', 'application/pdf')

beforeEach(() => {
  vi.clearAllMocks()
  h.uploads = []
  h.erroreUpload = null
  h.errori = []
  h.eventi = []
  resetRateLimit()
})

describe('POST /api/iscrizione/insegnanti/upload · il percorso felice', () => {
  it('200 col percorso, nel bucket dichiarato e con `upsert: false`', async () => {
    const res = await POST(richiesta(curriculum()) as never)

    expect(res.status).toBe(200)
    const { path } = await res.json()
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0].path).toBe(path)
    expect(h.uploads[0].bucket).toBe(BUCKET_CURRICULUM)
    // Un percorso generato dal server non deve poterne sostituire un altro.
    expect(h.uploads[0].upsert).toBe(false)
    expect(path.startsWith(CV_PREFISSO)).toBe(true)
  })

  it('🔴 il percorso prodotto è ACCETTATO dal gate che applica l’invio del modulo', async () => {
    // È la sutura fra le due metà di questo lavoro, ed è il test che vale più di
    // tutti gli altri messi insieme: la rotta di caricamento e la rotta d'invio
    // sono due file diversi, e fino al 2026-08-15 la seconda esisteva senza la
    // prima. Se le forme divergono, chi si candida carica il curriculum e poi si
    // vede rifiutare l'invio — dopo aver compilato tutto il modulo.
    const res = await POST(richiesta(curriculum()) as never)
    const { path } = await res.json()
    expect(
      percorsoCvAmmesso(path),
      `il percorso prodotto dalla rotta di caricamento (${path}) non supera ` +
        '`percorsoCvAmmesso`, cioè il gate che `iscrizione/insegnanti:POST` applica al ' +
        'valore di `cv_path`: il curriculum si carica e poi l’invio lo respinge',
    ).toBe(true)
  })

  it('🔴 il NOME DEL FILE non sopravvive: né nel percorso, né in un log', async () => {
    // `cv-rossi.pdf` è il cognome di una persona. Il percorso finisce in una
    // colonna del database e dentro un URL firmato che lo porta IN CHIARO.
    const res = await POST(richiesta(fileDa('cv-esposito-maria.pdf', 'application/pdf')) as never)
    const { path } = await res.json()

    expect(path).not.toMatch(/esposito/i)
    expect(path).not.toMatch(/maria/i)
    expect(h.uploads[0].path).not.toMatch(/esposito/i)

    const tuttiILog = JSON.stringify(h.eventi) + JSON.stringify(h.errori)
    expect(tuttiILog).not.toMatch(/esposito/i)
    // …e nemmeno il PERCORSO, che non contiene più un nome ma resta la chiave con
    // cui si firma il curriculum di una persona.
    expect(tuttiILog).not.toContain(path)
  })

  it('l’estensione la decide il TIPO, non il nome del file', async () => {
    // Un `.pdf` nel nome con dentro un JPEG dichiarato non deve archiviarsi come
    // pdf: sarebbe un oggetto che nessun visualizzatore apre. Il gate condiviso
    // pretende comunque che i due concordino, quindi qui si prova il caso in cui
    // concordano ed è il TIPO a decidere l'estensione canonica: `image/jpeg` → jpg.
    await POST(richiesta(fileDa('foto.jpeg', 'image/jpeg')) as never)
    expect(h.uploads[0].path.endsWith('.jpg')).toBe(true)
    expect(h.uploads[0].contentType).toBe('image/jpeg')
  })

  it('un `.heic` senza tipo dichiarato (Chrome) entra, e allo Storage va il tipo giusto', async () => {
    // È il caso di chi fotografa il curriculum con un iPhone: il browser non
    // dichiara il tipo, e la codifica multipart lo spedisce come
    // `application/octet-stream`. Passare quello allo Storage significherebbe
    // vederselo respingere DOPO il caricamento, perché il bucket dichiara i suoi
    // cinque tipi ammessi.
    await POST(richiesta(fileDa('curriculum.heic', '')) as never)
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0].contentType).toBe('image/heic')
    expect(h.uploads[0].contentType).not.toBe('application/octet-stream')
  })

  it('il `folder` mandato dal client NON influenza il percorso', async () => {
    const res = await POST(richiesta(curriculum(), '10.0.0.2', '../iscrizioni') as never)
    const { path } = await res.json()
    expect(path.startsWith(CV_PREFISSO)).toBe(true)
    expect(path).not.toContain('iscrizioni')
    expect(path).not.toContain('..')
  })

  it('il caricamento riuscito lascia una riga, con i soli metadati', async () => {
    // AGENTS §5: con i soli errori, «nessun log di upload» non distingue «nessuno
    // allega il curriculum» da «gli allegati non partono più». Su questa porta la
    // distinzione conta il doppio: la funzione è nata oggi.
    await POST(richiesta(curriculum(), '10.0.0.3') as never)
    const riga = h.eventi.find((e) => e.campi.esito === 'curriculum-caricato')
    expect(riga, 'il caricamento riuscito non lascia nessuna riga di log').toBeTruthy()
    expect(riga!.livello).toBe('info')
    expect(riga!.evento).toBe('storage')
    expect(riga!.campi.bucket).toBe(BUCKET_CURRICULUM)
    expect(riga!.campi.mime).toBe('application/pdf')
    expect(typeof riga!.campi.byte).toBe('number')
    expect(Object.keys(riga!.campi)).not.toContain('path')
    expect(Object.keys(riga!.campi)).not.toContain('nome')
  })
})

describe('POST /api/iscrizione/insegnanti/upload · i rifiuti', () => {
  it('il Content-Type sbagliato è un errore del CLIENT: 400, non 500', async () => {
    const res = await POST(richiestaNonMultipart() as never)
    expect(res.status).toBe(400)
    expect(h.uploads).toHaveLength(0)
    const corpo = await res.json()
    // Il messaggio interno del runtime non esce verso un anonimo.
    expect(JSON.stringify(corpo)).not.toMatch(/could not parse|boundary/i)
  })

  it('nessun file ⇒ 400, e niente tocca lo Storage', async () => {
    const res = await POST(richiesta(null, '10.0.0.4') as never)
    expect(res.status).toBe(400)
    expect(h.uploads).toHaveLength(0)
  })

  it('🔴 un tipo fuori elenco è respinto PRIMA dello Storage, con un codice traducibile', async () => {
    const res = await POST(richiesta(fileDa('curriculum.txt', 'text/plain'), '10.0.0.5') as never)
    expect(res.status).toBe(415)
    expect((await res.json()).codice).toBe('ALLEGATO_PDF_O_IMMAGINE')
    expect(
      h.uploads,
      'un file di tipo non ammesso è entrato nel bucket che custodisce anche i documenti dei minori',
    ).toHaveLength(0)
  })

  it('🔴 il `.docx` cade qui, non all’invio — ed è il rifiuto più frequente di questa porta', async () => {
    // È il formato in cui la maggioranza dei curriculum viaggia, e
    // `form_attachments` ammette cinque tipi che non lo comprendono. Il 415
    // arriva SUBITO, invece che a modulo compilato: è la ragione per cui il
    // template ha smesso di offrire `.doc`/`.docx` nel selettore il 2026-08-10.
    const docx = fileDa(
      'curriculum.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const res = await POST(richiesta(docx, '10.0.0.6') as never)
    expect(res.status).toBe(415)
    expect(h.uploads).toHaveLength(0)
  })

  it('oltre il limite della piattaforma ⇒ 413 col codice GIUSTO', async () => {
    // ⚠️ `ALLEGATO_OLTRE_LIMITE_PIATTAFORMA` e non `ALLEGATO_TROPPO_GRANDE`: la
    // frase di quest'ultimo, in entrambi i cataloghi, dice «al massimo 10 MB» —
    // il limite di un ALTRO bucket. Qui direbbe a chi si candida che ha ancora
    // margine mentre il caricamento è già stato respinto.
    const enorme = fileDa('cv.pdf', 'application/pdf', LIMITE_UPLOAD_BYTE + 1)
    const res = await POST(richiesta(enorme, '10.0.0.7') as never)
    expect(res.status).toBe(413)
    expect((await res.json()).codice).toBe('ALLEGATO_OLTRE_LIMITE_PIATTAFORMA')
    expect(h.uploads).toHaveLength(0)
  })

  it('🔴 il corpo dell’errore del fornitore resta nel LOG e non torna al client', async () => {
    h.erroreUpload = { message: 'mime type text/plain is not supported', statusCode: '400' }
    const res = await POST(richiesta(curriculum(), '10.0.0.8') as never)

    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ALLEGATO_NON_CARICATO')
    expect(
      JSON.stringify(corpo),
      'il messaggio del fornitore — inglese, col nome di un vincolo interno — è uscito ' +
        'verso un chiamante anonimo',
    ).not.toMatch(/mime type/i)
    // …ma non si è perso: AGENTS §3, il corpo dell'errore di un provider non si
    // butta MAI via. `403` non dice niente, `403 "the domain is not verified"`
    // dice tutto.
    expect(JSON.stringify(h.errori)).toMatch(/mime type/i)
  })
})

describe('POST /api/iscrizione/insegnanti/upload · il tetto per IP', () => {
  it(`il caricamento numero ${TETTO_UPLOAD_CANDIDATURE + 1} dallo stesso IP prende 429`, async () => {
    for (let i = 0; i < TETTO_UPLOAD_CANDIDATURE; i++) {
      const ok = await POST(richiesta(curriculum(), '10.9.9.9') as never)
      expect(ok.status, `il caricamento ${i + 1} entro il tetto è stato respinto`).toBe(200)
    }
    const res = await POST(richiesta(curriculum(), '10.9.9.9') as never)
    expect(res.status).toBe(429)
    const corpo = await res.json()
    expect(corpo.codice).toBe('TROPPE_RICHIESTE')
    // Un client che non sa quando riprovare riprova subito, e un tetto contro cui
    // si sbatte in continuazione è indistinguibile da un servizio rotto.
    expect(res.headers.get('Retry-After')).toBeTruthy()
    // Il tetto sta PRIMA di leggere il corpo: nessun caricamento in più.
    expect(h.uploads).toHaveLength(TETTO_UPLOAD_CANDIDATURE)
  })

  it('il tetto è PER INDIRIZZO: un altro IP non paga il conto del primo', async () => {
    for (let i = 0; i < TETTO_UPLOAD_CANDIDATURE; i++) {
      await POST(richiesta(curriculum(), '10.9.9.9') as never)
    }
    expect((await POST(richiesta(curriculum(), '10.9.9.9') as never)).status).toBe(429)
    expect((await POST(richiesta(curriculum(), '10.1.1.1') as never)).status).toBe(200)
  })

  it('un abuso in corso lascia una traccia (`warn`, non `error`)', async () => {
    for (let i = 0; i <= TETTO_UPLOAD_CANDIDATURE; i++) {
      await POST(richiesta(curriculum(), '10.9.9.8') as never)
    }
    const riga = h.eventi.find((e) => e.campi.esito === 'tetto-ip-raggiunto')
    expect(riga, 'il tetto raggiunto non lascia nessuna riga: un abuso non si vedrebbe').toBeTruthy()
    // È un uso sbagliato, non un guasto nostro.
    expect(riga!.livello).toBe('warn')
  })
})

describe('POST /api/iscrizione/insegnanti/upload · i confini dichiarati', () => {
  it('ogni estensione ammessa dal gate produce un percorso che il gate d’invio accetta', async () => {
    // Il giro completo, una estensione per volta: è il modo in cui una mappa
    // `tipo → estensione` che perdesse una voce si vedrebbe subito, invece che al
    // primo curriculum vero in quel formato.
    const perEstensione: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      heic: 'image/heic',
    }
    for (const est of ESTENSIONI_ALLEGATO_PUBBLICO) {
      resetRateLimit()
      h.uploads = []
      const res = await POST(richiesta(fileDa(`cv.${est}`, perEstensione[est])) as never)
      expect(res.status, `un file .${est} — ammesso dal gate condiviso — è stato respinto`).toBe(200)
      const { path } = await res.json()
      expect(percorsoCvAmmesso(path), `il percorso prodotto per .${est} non supera il gate d’invio`).toBe(
        true,
      )
    }
  })

  it('due caricamenti non producono mai lo stesso percorso', async () => {
    // Il percorso è unico in tabella (`candidature_insegnanti_cv_unico`): due
    // percorsi uguali significherebbero una candidatura che non entra, e con il
    // motivo sbagliato.
    const a = await POST(richiesta(curriculum(), '10.2.2.2') as never)
    const b = await POST(richiesta(curriculum(), '10.2.2.2') as never)
    expect((await a.json()).path).not.toBe((await b.json()).path)
  })
})
