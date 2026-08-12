// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// POST /api/iscrizione/personale/upload — la scansione del documento d'identità.
//
// Da questa porta, senza login, arriva la fotografia della carta d'identità di una
// maestra in servizio. I difetti REALI che questi test impediscono sono cinque, e
// quattro di loro sono già accaduti su una porta gemella:
//
//  1. NESSUN TETTO. `iscrizione/upload` accettava dieci POST di fila senza mai un
//     429 — misurato sul server di produzione il 2026-08-02, mentre le tre rotte
//     sorelle dello stesso wizard il tetto ce l'avevano tutte.
//  2. NESSUNA LISTA DI TIPI. Il bucket aveva `allowed_mime_types = NULL`: nessun
//     freno né nell'applicazione né sotto. Un `.exe` o un finto `.html` entravano.
//  3. IL 500 SU UN ERRORE DEL CLIENT. `request.formData()` LANCIA quando il
//     Content-Type non è multipart, e l'eccezione finiva nel `catch` generico: 500
//     al posto di 400, col messaggio interno del runtime restituito a un anonimo.
//  4. IL CORPO DELL'ERRORE DEL FORNITORE RIGIRATO AL CLIENT. `avvisi/upload`
//     rispondeva `500 {"error":"mime type text/plain is not supported"}`: inglese,
//     col nome di un vincolo interno, davanti a chi non ha nessuno a cui chiedere.
//  5. E UNO CHE È SOLO DI QUESTA PORTA: IL NOME DEL FILE. Qui si chiama
//     «carta-identita-<cognome>.pdf», cioè il cognome di una persona. Non deve
//     sopravvivere alla richiesta: non nel percorso, non nel log, da nessuna parte.
//
// Più il bucket, che è la ragione per cui questa rotta esiste invece di riusare
// quella d'iscrizione: `form_attachments` custodisce i documenti dei MINORI, e due
// popolazioni con basi giuridiche e termini di conservazione diversi non stanno
// nello stesso spazio.
// =============================================================================

const h = vi.hoisted(() => ({
  /** Ogni `.storage.from(bucket).upload(path, …)` visto dal finto. */
  uploads: [] as { bucket: string; path: string; contentType?: string; upsert?: boolean }[],
  /** L'errore che lo Storage deve restituire. */
  erroreUpload: null as unknown,
  /** Gli argomenti di ogni `logErrore` / `logEvento`. */
  errori: [] as unknown[][],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],

  // ── il REGISTRO dei caricamenti, come lo vede un finto database ────────────
  /** Le righe già in tabella, con cui si allestisce lo scenario della spazzata. */
  registro: [] as { percorso: string; caricato_il: string; pratica_id: string | null }[],
  /** Ogni riga passata a `.insert()` su `caricamenti_personale`. */
  registroInserts: [] as Record<string, unknown>[],
  /** L'errore che l'INSERT nel registro deve restituire (PostgREST non lancia). */
  erroreRegistro: null as { code?: string; message?: string } | null,
  /** L'errore che la LETTURA degli orfani deve restituire. */
  erroreSpazzata: null as { code?: string; message?: string } | null,
  /** I percorsi cancellati dal registro, per chiamata. */
  registroDelete: [] as string[][],
  /** La soglia temporale con cui la route ha chiesto gli orfani (`caricato_il <`). */
  soglieChieste: [] as string[],

  // ── lo STORAGE ────────────────────────────────────────────────────────────
  /** Ogni `.remove([...])` visto dal finto: bucket e percorsi. */
  rimozioni: [] as { bucket: string; percorsi: string[] }[],
  /** L'errore che `remove()` deve restituire. */
  erroreRimozione: null as unknown,
  /**
   * I percorsi che `remove()` NON deve dichiarare usciti: `rimuoviEVerifica` li
   * verifica uno per uno con `list()`, ed è così che si prova che una scansione
   * ancora nell'archivio TRATTIENE la sua riga invece di sparire dal registro.
   */
  nonUsciti: [] as string[],
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
    /**
     * Il REGISTRO dei caricamenti, con i filtri che si MEMORIZZANO invece di essere
     * ignorati. Un finto che rispondesse sempre lo stesso elenco renderebbe verdi le
     * prove sulla spazzata qualunque predicato la route usasse — e i due predicati
     * sono l'intera regola: `pratica_id is null` (nessuno l'ha reclamato) e
     * `caricato_il <` la soglia (è passato abbastanza tempo).
     */
    from(tabella: string) {
      if (tabella !== 'caricamenti_personale') throw new Error(`tabella non prevista: ${tabella}`)
      let modo: 'select' | 'insert' | 'delete' = 'select'
      let soloSospesi = false
      let soglia: string | null = null
      const b: Record<string, unknown> = {}
      b.insert = (riga: Record<string, unknown>) => {
        modo = 'insert'
        h.registroInserts.push(riga)
        return b
      }
      b.select = () => b
      b.delete = () => {
        modo = 'delete'
        return b
      }
      b.is = (colonna: string, valore: unknown) => {
        if (colonna === 'pratica_id' && valore === null) soloSospesi = true
        return b
      }
      b.lt = (colonna: string, valore: unknown) => {
        if (colonna === 'caricato_il') {
          soglia = String(valore)
          h.soglieChieste.push(soglia)
        }
        return b
      }
      b.in = (_colonna: string, valori: string[]) => {
        h.registroDelete.push([...valori])
        h.registro = h.registro.filter((r) => !valori.includes(r.percorso))
        return b
      }
      b.order = () => b
      b.limit = (n: number) => {
        b.__tetto = n
        return b
      }
      b.then = (res: (v: unknown) => unknown) => {
        if (modo === 'insert') {
          if (!h.erroreRegistro) {
            for (const riga of h.registroInserts.slice(-1)) {
              h.registro.push({
                percorso: String(riga.percorso),
                caricato_il: new Date().toISOString(),
                pratica_id: null,
              })
            }
          }
          return Promise.resolve({ data: null, error: h.erroreRegistro }).then(res)
        }
        if (modo === 'delete') return Promise.resolve({ data: null, error: null }).then(res)
        if (h.erroreSpazzata) {
          return Promise.resolve({ data: null, error: h.erroreSpazzata }).then(res)
        }
        const righe = h.registro
          .filter((r) => (soloSospesi ? r.pratica_id === null : true))
          .filter((r) => (soglia === null ? true : r.caricato_il < soglia))
          .sort((x, y) => x.caricato_il.localeCompare(y.caricato_il))
          .slice(0, (b.__tetto as number) ?? 1000)
          .map((r) => ({ percorso: r.percorso }))
        return Promise.resolve({ data: righe, error: null }).then(res)
      }
      return b
    },
    storage: {
      // IL BUCKET SI MEMORIZZA. È metà del punto di questa rotta: scrivere in
      // `form_attachments` invece che in `documenti_personale` non farebbe fallire
      // niente — metterebbe soltanto la carta d'identità di una dipendente nello
      // stesso spazio dei documenti dei bambini.
      from: (bucket: string) => ({
        upload: async (
          path: string,
          _corpo: unknown,
          opzioni?: { contentType?: string; upsert?: boolean },
        ) => {
          h.uploads.push({
            bucket,
            path,
            contentType: opzioni?.contentType,
            upsert: opzioni?.upsert,
          })
          return { error: h.erroreUpload }
        },
        // `remove()` risponde con GLI OGGETTI CHE HA DAVVERO TOLTO, e non fallisce sui
        // percorsi inesistenti: è la forma vera dell'API, ed è ciò su cui poggia tutta
        // `rimuoviEVerifica`. `h.nonUsciti` permette di simulare il caso che conta —
        // un file che NON esce — senza il quale la verifica non sarebbe mai provata.
        remove: async (percorsi: string[]) => {
          h.rimozioni.push({ bucket, percorsi: [...percorsi] })
          if (h.erroreRimozione) return { data: null, error: h.erroreRimozione }
          const usciti = percorsi.filter((p) => !h.nonUsciti.includes(p))
          return { data: usciti.map((p) => ({ name: p })), error: null }
        },
        // `list(cartella, { search: nome })` è come `rimuoviEVerifica` VERIFICA: un
        // elenco vuoto significa «non c'è più», un elenco col nome significa «c'è
        // ancora». Qui risponde in base a `h.nonUsciti`.
        list: async (cartella: string, opzioni?: { search?: string }) => {
          const nome = opzioni?.search ?? ''
          const presente = h.nonUsciti.includes(`${cartella}/${nome}`)
          return { data: presente ? [{ name: nome }] : [], error: null }
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/iscrizione/personale/upload/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import { TETTO_UPLOAD_PUBBLICO } from '@/lib/upload/allegati-pubblici'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'

/** Un file di byte VERI: la richiesta viaggia in multipart e una taglia finta si perderebbe. */
const fileDa = (nome: string, tipo: string, byte = 32): File =>
  new File([Buffer.alloc(byte, 0x78)], nome, { type: tipo })

function richiesta(file: File | null, ip = '10.0.0.1'): Request {
  const fd = new FormData()
  if (file) fd.append('file', file)
  return new Request('http://localhost/api/iscrizione/personale/upload', {
    method: 'POST',
    body: fd,
    headers: { 'x-forwarded-for': ip },
  })
}

const richiestaNonMultipart = (ip = '10.0.0.9'): Request =>
  new Request('http://localhost/api/iscrizione/personale/upload', {
    method: 'POST',
    body: '{"file":"eccolo"}',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  })

/** Un documento valido: è il caso normale, e serve a quasi tutti i test. */
const documento = () => fileDa('carta-identita-prova.pdf', 'application/pdf')

beforeEach(() => {
  vi.clearAllMocks()
  h.uploads = []
  h.erroreUpload = null
  h.errori = []
  h.eventi = []
  h.registro = []
  h.registroInserts = []
  h.erroreRegistro = null
  h.erroreSpazzata = null
  h.registroDelete = []
  h.soglieChieste = []
  h.rimozioni = []
  h.erroreRimozione = null
  h.nonUsciti = []
  resetRateLimit()
})

/** Un percorso nella forma che questa rotta produce, per allestire il registro. */
const percorsoFinto = () => `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.pdf`

/** `n` ore fa, in ISO: serve a distinguere l'orfano di ieri da quello di adesso. */
const oreFa = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString()

describe('POST /api/iscrizione/personale/upload · il percorso felice', () => {
  it('200 col percorso, sul bucket SEPARATO e non su quello dei minori', async () => {
    const res = await POST(richiesta(documento()) as never)

    expect(res.status).toBe(200)
    const { path } = await res.json()
    expect(h.uploads).toHaveLength(1)
    expect(h.uploads[0].path).toBe(path)
    expect(
      h.uploads[0].bucket,
      'la scansione di una dipendente è finita nel bucket dei documenti dei minori',
    ).toBe('documenti_personale')
    expect(h.uploads[0].bucket).not.toBe('form_attachments')
    // Un percorso generato dal server non deve poterne sostituire un altro.
    expect(h.uploads[0].upsert).toBe(false)
  })

  it('il NOME del file non sopravvive: nel percorso ci sono solo due uuid', async () => {
    // «carta-identita-<cognome>.pdf» è il cognome di una persona, e quel percorso
    // finisce in una colonna del database e dentro ogni URL firmato.
    const res = await POST(richiesta(fileDa('carta-identita-prova.pdf', 'application/pdf')) as never)
    const { path } = await res.json()

    expect(path).toMatch(
      /^documenti\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/,
    )
    for (const frammento of ['carta', 'identita', 'prova']) {
      expect(path, `il nome del file è sopravvissuto nel percorso («${frammento}»)`).not.toContain(
        frammento,
      )
    }
  })

  it('due caricamenti non si sovrascrivono, nemmeno con lo stesso nome', async () => {
    const uno = await (await POST(richiesta(documento()) as never)).json()
    const due = await (await POST(richiesta(documento()) as never)).json()
    expect(uno.path).not.toBe(due.path)
  })

  it('l’estensione la decide il TIPO, non il nome: `.JPEG` diventa `.jpg`', async () => {
    // Deriva dal `contentType` che il gate ha già normalizzato e verificato: da
    // `file.name` non passa un solo byte. Un tipo, un'estensione canonica — il bucket
    // non deve contenere lo stesso formato scritto in due modi.
    const res = await POST(richiesta(fileDa('DOCUMENTO.JPEG', 'image/jpeg')) as never)
    const { path } = await res.json()
    expect(path.endsWith('.jpg')).toBe(true)
    expect(h.uploads[0].contentType).toBe('image/jpeg')
  })

  it('la foto scattata dall’iPhone passa: `.heic` senza tipo dichiarato', async () => {
    // Chrome non dichiara il tipo sugli `.heic`, e la codifica multipart lo spedisce
    // come `application/octet-stream`. È il modo in cui questo allegato arriverà quasi
    // sempre: respingerlo significherebbe respingere la fotografia di una carta
    // d'identità perché il browser non sa come si chiama il suo formato.
    const res = await POST(richiesta(fileDa('IMG_0042.heic', '')) as never)

    expect(res.status).toBe(200)
    expect((await res.json()).path.endsWith('.heic')).toBe(true)
    // Allo Storage va il tipo GIUSTO, mai `application/octet-stream`: il bucket
    // dichiara i suoi cinque tipi ammessi, e un file valido spedito come octet-stream
    // verrebbe respinto DOPO il caricamento, con un 500 opaco.
    expect(h.uploads[0].contentType).toBe('image/heic')
  })

  it('il caricamento riuscito lascia una riga, con i soli METADATI', async () => {
    // Con i soli errori, «nessun log di upload» non distingue «nessuna maestra ha
    // allegato niente» da «gli allegati non partono più»: è l'ambiguità che ha tenuto
    // invisibile per mesi il guasto delle email di credenziali.
    await POST(richiesta(fileDa('carta-identita-prova.pdf', 'application/pdf', 1234)) as never)

    const ok = h.eventi.find((e) => e.campi.esito === 'documento-caricato')
    expect(ok?.livello).toBe('info')
    expect(ok?.campi.operazione).toBe('iscrizione/personale/upload:POST')
    expect(ok?.campi.bucket).toBe('documenti_personale')
    expect(ok?.campi.mime).toBe('application/pdf')
    expect(ok?.campi.byte).toBe(1234)

    // ⚠️ NÉ IL NOME NÉ IL PERCORSO. Il nome non c'è più per costruzione; il percorso è
    // la chiave con cui si firma il documento d'identità di una persona.
    const scritto = JSON.stringify(h.eventi)
    expect(scritto, 'il nome del file è finito nei log').not.toContain('carta-identita')
    expect(scritto, 'il percorso è finito nei log').not.toContain('documenti/')
  })
})

describe('POST /api/iscrizione/personale/upload · il tetto per IP', () => {
  it('oltre il tetto risponde 429 con Retry-After, e il file non parte', async () => {
    for (let i = 0; i < TETTO_UPLOAD_PUBBLICO; i++) {
      const ok = await POST(richiesta(documento()) as never)
      expect(ok.status, `il caricamento ${i + 1} doveva passare`).toBe(200)
    }
    const caricatiPrima = h.uploads.length

    const res = await POST(richiesta(documento()) as never)

    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
    expect(
      h.uploads.length,
      'Il caricamento oltre il tetto è arrivato allo Storage: un 429 dato DOPO l’upload non è un tetto, è un commento.',
    ).toBe(caricatiPrima)
    expect(h.eventi.some((e) => e.campi.esito === 'tetto-ip-raggiunto')).toBe(true)
  })

  it('il tetto è PER IP: un altro indirizzo riparte da zero (controllo positivo)', async () => {
    for (let i = 0; i < TETTO_UPLOAD_PUBBLICO; i++) {
      await POST(richiesta(documento(), '10.0.0.1') as never)
    }
    expect((await POST(richiesta(documento(), '10.0.0.1') as never)).status).toBe(429)
    // Una seconda maestra, dietro un altro indirizzo, non paga il tetto della prima.
    expect((await POST(richiesta(documento(), '10.0.0.2') as never)).status).toBe(200)
  })
})

describe('POST /api/iscrizione/personale/upload · ciò che non deve entrare', () => {
  it('un Content-Type non multipart è un errore del CLIENT: 400, non 500', async () => {
    // `request.formData()` LANCIA su un Content-Type non multipart, e senza la
    // primitiva l'eccezione finirebbe nel `catch` generico — che è tarato sui guasti
    // del server — restituendo a un ANONIMO il messaggio interno del runtime.
    const res = await POST(richiestaNonMultipart() as never)

    expect(res.status, 'un JSON spedito per sbaglio produce un 500 e una riga `error` in app_log').toBe(400)
    const corpo = await res.json()
    expect(JSON.stringify(corpo), 'il messaggio interno del runtime esce verso un anonimo').not.toContain(
      'multipart/form-data',
    )
    expect(h.uploads).toHaveLength(0)
    expect(h.errori, 'un errore del client ha sporcato il canale dei guasti veri').toHaveLength(0)
  })

  it('senza file la risposta è 400, non un 500 su `file.size`', async () => {
    const res = await POST(richiesta(null) as never)
    expect(res.status).toBe(400)
    expect(h.uploads).toHaveLength(0)
  })

  it('un eseguibile non arriva MAI nel bucket', async () => {
    const res = await POST(richiesta(fileDa('virus.exe', 'application/octet-stream')) as never)
    expect(res.status).toBe(415)
    expect(h.uploads, 'il file rifiutato ha toccato lo Storage').toHaveLength(0)
  })

  it('un finto `.html` viene rifiutato (porta script)', async () => {
    const res = await POST(richiesta(fileDa('pagina.html', 'text/html')) as never)
    expect(res.status).toBe(415)
    expect(h.uploads).toHaveLength(0)
  })

  it('l’estensione conta quanto il tipo: un `.exe` dichiarato `application/pdf` è rifiutato', async () => {
    // Altrimenti basterebbe rinominare per far passare qualunque cosa.
    const res = await POST(richiesta(fileDa('trojan.exe', 'application/pdf')) as never)
    expect(res.status).toBe(415)
    expect(h.uploads).toHaveLength(0)
  })

  it('sopra il limite della PIATTAFORMA la risposta è 413, con un corpo JSON leggibile', async () => {
    // Il vecchio «8 MB» era una promessa che il codice non poteva mantenere: sopra i
    // ~4,5 MB il corpo lo rifiuta Vercel con un 413 che non è nostro e non risponde
    // nemmeno in JSON. 413 e non 400: è lo stesso codice che darebbe la piattaforma,
    // così il client ha una sola cosa da riconoscere.
    const res = await POST(
      richiesta(fileDa('documento.pdf', 'application/pdf', LIMITE_UPLOAD_BYTE + 1)) as never,
    )

    expect(res.status).toBe(413)
    const corpo = await res.json()
    // ⚠️ IL CODICE NON È QUELLO DEL BUCKET DA 10 MB. La frase di
    // `ALLEGATO_TROPPO_GRANDE` dice, in entrambe le lingue, «al massimo 10 MB»:
    // mostrarla qui direbbe a una maestra che ha ancora 6 MB di margine mentre il
    // caricamento è già stato respinto — un modulo inutilizzabile con un messaggio
    // rassicurante. Il numero VERO viaggia nella prosa, interpolato dalla costante
    // condivisa, e non è ribattuto in nessun catalogo.
    expect(corpo.codice).toBe('ALLEGATO_OLTRE_LIMITE_PIATTAFORMA')
    expect(corpo.error).toContain(String(LIMITE_UPLOAD_MB))
    expect(h.uploads).toHaveLength(0)
  })
})

// =============================================================================
// IL REGISTRO DEI CARICAMENTI — il difetto che questi test impediscono.
//
// La scansione si carica al TERZO passo del wizard e la pratica nasce al QUARTO.
// Chiunque carichi e poi chiuda la pagina lasciava, fino all'11/08/2026, la
// fotografia della propria carta d'identità nel bucket a tempo indeterminato:
// senza il nome del file (buttato via apposta, sopra) e senza NESSUNA riga che
// dicesse di chi fosse — cioè nemmeno identificabile per cancellarla se quella
// persona l'avesse chiesto. `gdpr/retention-personale:POST` non poteva vederla:
// parte da `pratiche_personale` e `anagrafica_personale`, quindi guarda solo ciò
// che è GIÀ referenziato.
//
// Non è il caso dell'abuso: è quello normale di chi si interrompe. Ed è lo stato
// che la retention stessa chiama, con parole sue, «il modo peggiore di conservare
// un dato personale».
// =============================================================================
describe('POST /api/iscrizione/personale/upload · l’oggetto e la riga che lo nomina', () => {
  it('il caricamento riuscito scrive nel registro LO STESSO percorso che restituisce', async () => {
    const res = await POST(richiesta(documento()) as never)
    const { path } = await res.json()

    expect(h.registroInserts, 'l’oggetto è entrato nel bucket senza nessuna riga che lo nomini').toHaveLength(1)
    // LO STESSO percorso, non uno che gli somiglia: se le due stringhe divergessero
    // il registro sorveglierebbe un oggetto che non esiste, e quello vero resterebbe
    // orfano — cioè il difetto tornerebbe intatto con il registro in piedi.
    expect(h.registroInserts[0].percorso).toBe(path)
    // In sospeso: nessuna pratica l'ha ancora reclamato. È la colonna su cui gira la
    // spazzata, e scriverla qui la renderebbe inutile dal primo giorno.
    expect(h.registroInserts[0]).not.toHaveProperty('pratica_id')
  })

  it('se il registro NON si scrive, l’oggetto viene RITIRATO dal bucket', async () => {
    // Fra i due mali la scelta è dichiarata: un caricamento fallito costa a una
    // maestra un secondo tentativo, un oggetto non registrato costa la fotografia del
    // suo documento d'identità conservata per sempre e da nessuno cancellabile.
    h.erroreRegistro = { code: '23514', message: 'new row violates check constraint' }

    const res = await POST(richiesta(documento()) as never)

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ALLEGATO_NON_CARICATO')
    expect(h.uploads).toHaveLength(1)
    expect(h.rimozioni, 'il registro non si è scritto e l’oggetto è rimasto nel bucket').toHaveLength(1)
    expect(h.rimozioni[0].bucket).toBe('documenti_personale')
    expect(h.rimozioni[0].percorsi).toEqual([h.uploads[0].path])

    const ritiro = h.eventi.find((e) => e.campi.esito === 'documento-ritirato')
    expect(ritiro?.livello).toBe('error')
    expect(JSON.stringify(h.eventi), 'il percorso è finito nei log').not.toContain('documenti/')
  })

  it('registro non scritto E ritiro fallito: l’esito è DIVERSO, perché il fatto è diverso', async () => {
    // «L'ho tolto» e «non sono riuscito a toglierlo» sono due stati opposti del
    // bucket: con lo stesso esito, nessuno saprebbe mai quali oggetti sono davvero
    // rimasti lì da togliere a mano.
    h.erroreRegistro = { code: '23514' }
    h.erroreRimozione = { message: 'storage non raggiungibile' }

    const res = await POST(richiesta(documento()) as never)

    expect(res.status).toBe(500)
    expect(h.eventi.some((e) => e.campi.esito === 'documento-non-ritirato')).toBe(true)
    expect(h.eventi.some((e) => e.campi.esito === 'documento-ritirato')).toBe(false)
  })

  it('registro ASSENTE: l’oggetto si RITIRA lo stesso, e lo si GRIDA', async () => {
    // ⚠️ QUESTA PROVA DICEVA IL CONTRARIO, e l'ha fatto per un giro intero: «il
    // caricamento passa, ma lo si grida», con `h.rimozioni` atteso a zero. La ragione
    // scritta nella rotta era «su un database senza quella tabella non c'è nemmeno
    // questo bucket», e MISURATA IN PRODUZIONE il 12/08/2026 con una query su
    // `pg_class` e `storage.buckets` è risultata FALSA: bucket `documenti_personale`
    // presente (migrazione `20260811205643`, applicata), tabella
    // `caricamenti_personale` assente (migrazione `20260811234334`, non ancora
    // applicata). Le due non viaggiano insieme, e la finestra in cui l'eccezione si
    // apriva era esattamente l'unico stato in cui poteva scattare: quello di oggi.
    //
    // Cosa succedeva in quello stato, che è il caso normale e non l'abuso: ogni
    // wizard abbandonato lasciava nel bucket la fotografia di una carta d'identità
    // senza il nome del file (buttato via apposta) e senza nessuna riga che dicesse di
    // chi fosse — cioè nemmeno cancellabile su richiesta di quella persona. È lo
    // stato che tutto il registro esiste per impedire, ricreato dalla difesa stessa.
    //
    // La premessa giusta non ha bisogno di sapere cosa c'è nel database: se
    // `storage.upload` è riuscito, l'oggetto esiste e c'è sempre qualcosa da ritirare.
    // Il degrado resta DICHIARATO a livello `error` con il nome della migrazione da
    // applicare — cambia che non è più il permesso di tenersi il documento.
    h.erroreRegistro = { code: 'PGRST205', message: "Could not find the table 'caricamenti_personale'" }

    const res = await POST(richiesta(documento()) as never)

    expect(
      res.status,
      'il registro non c’è e la porta ha risposto 200: da questo istante ogni caricamento è un orfano invisibile',
    ).toBe(500)
    expect(
      h.rimozioni,
      'la carta d’identità è rimasta nel bucket senza nessuna riga che la nomini',
    ).toHaveLength(1)
    expect(h.rimozioni[0].percorsi).toEqual([h.uploads[0].path])

    // Il grido resta, ed è la sola cosa che dice PERCHÉ la porta si è chiusa e cosa
    // fare per riaprirla: senza il numero della migrazione, «500» non è diagnosticabile.
    const grido = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-assente')
    expect(grido?.livello).toBe('error')
    expect(String(grido?.campi.msg)).toContain('20260811234334')
    expect(JSON.stringify(h.eventi), 'il percorso è finito nei log').not.toContain('documenti/')
  })
})

describe('POST /api/iscrizione/personale/upload · la spazzata degli orfani', () => {
  it('toglie l’orfano di ieri, e non tocca né il caricamento di adesso né quello reclamato', async () => {
    const orfano = percorsoFinto()
    const recente = percorsoFinto()
    const reclamato = percorsoFinto()
    h.registro = [
      { percorso: orfano, caricato_il: oreFa(48), pratica_id: null },
      // Chi si è interrotto un'ora fa sta ancora compilando: togliergli il documento
      // significherebbe farlo ricominciare.
      { percorso: recente, caricato_il: oreFa(1), pratica_id: null },
      // Vecchio quanto l'orfano, ma una pratica lo nomina: qui il file NON è più in
      // sospeso, ed è la conservazione di QUELLA riga a decidere quando esce.
      // Toglierlo significherebbe cancellare il documento che la Segreteria deve
      // ancora vedere.
      { percorso: reclamato, caricato_il: oreFa(48), pratica_id: 'una-pratica' },
    ]

    await POST(richiesta(documento()) as never)

    expect(h.rimozioni, 'la spazzata non è partita').toHaveLength(1)
    expect(h.rimozioni[0].bucket).toBe('documenti_personale')
    expect(h.rimozioni[0].percorsi).toEqual([orfano])
    // PRIMA I FILE, POI LE RIGHE: la riga di registro esce solo dopo che il file è
    // uscito davvero. Al contrario si otterrebbe, per un'altra strada, esattamente lo
    // stato che questa spazzata esiste per togliere.
    expect(h.registroDelete).toEqual([[orfano]])
  })

  it('la soglia è di ore, non di giorni: la route la dichiara e il finto la memorizza', async () => {
    await POST(richiesta(documento()) as never)

    expect(h.soglieChieste, 'la route ha chiesto gli orfani senza nessuna soglia temporale').toHaveLength(1)
    const ore = (Date.now() - Date.parse(h.soglieChieste[0])) / (60 * 60 * 1000)
    // Il modulo si compila in una sessione, ma capita di riprenderlo la mattina dopo:
    // sotto le sei ore si toglierebbe il documento a chi sta ancora compilando, sopra
    // le settantadue la fotografia di una carta d'identità che nessuno ha reclamato
    // resterebbe lì per giorni.
    expect(ore).toBeGreaterThanOrEqual(6)
    expect(ore).toBeLessThanOrEqual(72)
  })

  it('una scansione che NON esce dall’archivio TRATTIENE la sua riga', async () => {
    // «Non rimosso» e «ancora lì» sono due fatti diversi, e solo il secondo è un
    // guasto: cancellare la riga di un file ancora presente lo renderebbe invisibile
    // invece che cancellato. Se ne perde traccia per sempre.
    const bloccato = percorsoFinto()
    h.registro = [{ percorso: bloccato, caricato_il: oreFa(48), pratica_id: null }]
    h.nonUsciti = [bloccato]

    await POST(richiesta(documento()) as never)

    expect(h.rimozioni[0].percorsi).toEqual([bloccato])
    expect(
      h.registroDelete,
      'la riga è stata cancellata mentre la scansione è ancora nell’archivio',
    ).toHaveLength(0)
  })

  it('la spazzata che fallisce NON fa fallire un caricamento riuscito', async () => {
    // La chiama una porta pubblica dopo che il file è già stato scritto: un guasto
    // della pulizia non può diventare un caricamento fallito per una maestra che ha
    // fatto tutto bene. Ma la riga ci vuole, sempre.
    h.erroreSpazzata = { code: '57014', message: 'canceling statement due to statement timeout' }

    const res = await POST(richiesta(documento()) as never)

    expect(res.status).toBe(200)
    expect((await res.json()).path).toBeTruthy()
    const guasto = h.eventi.find((e) => e.campi.esito === 'spazzata-lettura-fallita')
    expect(guasto?.livello).toBe('error')
  })

  it('senza orfani non si tocca lo Storage (controllo negativo)', async () => {
    // Il caso normale: nessuna `remove()` a vuoto, e nessuna riga cancellata. Senza
    // questa prova, una spazzata che togliesse tutto passerebbe i test qui sopra.
    h.registro = [{ percorso: percorsoFinto(), caricato_il: oreFa(1), pratica_id: null }]

    await POST(richiesta(documento()) as never)

    expect(h.rimozioni).toHaveLength(0)
    expect(h.registroDelete).toHaveLength(0)
  })
})

describe('POST /api/iscrizione/personale/upload · quando lo Storage dice di no', () => {
  it('il corpo dell’errore del fornitore resta nel LOG e non torna al client', async () => {
    // «403» non dice nulla, «403 the domain is not verified» dice tutto: il corpo
    // dell'errore di un servizio esterno non si butta via mai (AGENTS §3). Ma il
    // destinatario di quel testo è il log, non un anonimo — porta fuori il nome del
    // bucket, i vincoli e le policy.
    h.erroreUpload = { message: 'new row violates row-level security policy for bucket "documenti_personale"' }
    const res = await POST(richiesta(documento()) as never)

    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('ALLEGATO_NON_CARICATO')
    expect(JSON.stringify(corpo)).not.toContain('row-level security')
    expect(JSON.stringify(corpo)).not.toContain('documenti_personale')

    expect(h.errori, 'il guasto dello Storage non ha lasciato nessuna riga').toHaveLength(1)
    expect(JSON.stringify(h.errori[0]), 'il corpo dell’errore del fornitore è stato buttato via').toContain(
      'row-level security',
    )
  })
})
