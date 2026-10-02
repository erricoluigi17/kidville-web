import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// =============================================================================
// IL BATTITO CHE FA PARTIRE LA CONVERSIONE — e la cosa che fino al 2026-09-18
// mancava del tutto.
//
// La pipeline video aveva tutti i pezzi e nessuno che la avviasse: misurato,
// `eseguiProssimoJobVideo` non aveva un solo chiamante fuori dal proprio modulo e
// `vercel.json` non dichiarava nessun cron. Un genitore avrebbe caricato il video,
// l'upload sarebbe riuscito, il job sarebbe rimasto `queued` PER SEMPRE, e nei log
// non sarebbe comparso un errore — perché non sbagliava niente: non partiva niente.
//
// Perciò le prove qui sotto non guardano «la route risponde 200»: guardano che il
// runner venga CHIAMATO, che lo sia UNA VOLTA SOLA per giro, e che ogni giro lasci
// una riga in `app_log` anche quando non c'era niente da fare. È quella riga a
// distinguere «nessuno ha caricato video» da «il cron non chiama più», e i due
// fatti si somigliano solo finché non ne serve uno.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-runner-non-usato-altrove'

const h = vi.hoisted(() => ({
  eventi: [] as {
    evento: string
    livello: string
    campi: Record<string, unknown>
    err?: unknown
    opzioni?: { distingui?: readonly string[] }
  }[],
  /** Quante volte il runner è stato invocato: è il numero che conta di più qui. */
  chiamate: 0,
  /** Con quale richiesta (`{}` per il giro del cron, `{ jobId }` per un calcio) è stato invocato ogni volta. */
  richieste: [] as unknown[],
  esito: { esito: 'coda-vuota' } as unknown,
  esplode: null as Error | null,
  staffNegato: null as unknown,
  /** Il client Supabase finto del test di cablaggio (`createAdminClient` restituisce questo). */
  supabase: null as unknown,
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (
    evento: string,
    livello: string,
    campi: Record<string, unknown>,
    err?: unknown,
    opzioni?: { distingui?: readonly string[] },
  ) => {
    h.eventi.push({ evento, livello, campi, err, opzioni })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () =>
    h.staffNegato
      ? { user: null, response: h.staffNegato }
      : { user: { id: '00000000-0000-4000-8000-000000000001' }, response: null },
  ),
}))

// ⚠️ Si sostituisce SOLO `eseguiProssimoJobVideo`. `TETTO_INVOCAZIONE_MS` arriva dal
// modulo vero: è il numero su cui poggia la scelta della cadenza del cron, e un
// doppio che lo inventasse renderebbe verde una route che dichiara nel battito un
// tetto diverso da quello che il runner rispetta davvero.
vi.mock('@/lib/media/video/runner', async (originale) => {
  const vero = await originale<typeof import('@/lib/media/video/runner')>()
  return {
    ...vero,
    eseguiProssimoJobVideo: async (richiesta?: unknown) => {
      h.chiamate += 1
      h.richieste.push(richiesta)
      if (h.esplode) throw h.esplode
      return h.esito
    },
  }
})

// Il client amministrativo lo dà `createAdminClient`: nel test del CABLAGGIO (in fondo) è un finto che registra
// ogni RPC. Il resto del modulo resta vero, perché lo importano anche il logger e `withRoute`.
vi.mock('@/lib/supabase/server-client', async (originale) => ({
  ...(await originale<typeof import('@/lib/supabase/server-client')>()),
  createAdminClient: async () => h.supabase,
}))

function richiesta(intestazioni: Record<string, string> = {}, corpo?: string): Request {
  return new Request('https://esempio.invalid/api/video/runner', {
    method: 'POST',
    headers: intestazioni,
    ...(corpo === undefined ? {} : { body: corpo }),
  })
}

// Il battito è l'ULTIMA riga di questa operazione: la scrive il `finally`, dopo ogni altra che la route abbia
// scritto per conto suo (il segreto sbagliato, il corpo malformato…) con lo stesso nome di lavoro.
const battito = () => h.eventi.filter((e) => e.campi.operazione === 'video-runner-tick').at(-1)

describe('il battito del runner video', () => {
  const precedente = process.env.CRON_SECRET

  beforeEach(() => {
    h.eventi.length = 0
    h.chiamate = 0
    h.richieste.length = 0
    h.esito = { esito: 'coda-vuota' }
    h.esplode = null
    h.staffNegato = null
    process.env.CRON_SECRET = CRON_SECRET
  })

  afterEach(() => {
    if (precedente === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = precedente
  })

  it('col segreto giusto chiama il runner UNA volta sola, e non in ciclo', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = { esito: 'pronto', jobId: '40000000-0000-4000-8000-00000000000a', byteUscita: 12 }

    const res = await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)

    expect(res.status).toBe(200)
    // Uno, non «almeno uno». Il runner tiene un job alla volta e un ciclo qui dentro
    // darebbe al secondo job il tempo avanzato dal primo — cioè una sorveglianza più
    // corta proprio sul lavoro che ha aspettato di più.
    expect(h.chiamate).toBe(1)
    expect(battito()?.livello).toBe('info')
  })

  it('senza segreto e senza staff non chiama il runner, e lo scrive', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.staffNegato = new Response(null, { status: 401 })

    const res = await POST(richiesta() as never)

    expect(res.status).toBe(401)
    expect(h.chiamate).toBe(0)
    expect(battito()?.campi.esito).toBe('non-autorizzato')
  })

  it('col segreto SBAGLIATO grida, perché è un cron che ha smesso di funzionare in silenzio', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.staffNegato = new Response(null, { status: 401 })

    await POST(richiesta({ 'x-cron-secret': 'non-questo' }) as never)

    // La distinzione che conta: header assente = una persona che lancia il giro a
    // mano, e il gate dello staff è il suo. Header presente ma errato = il cron che
    // bussa con la chiave sbagliata, cioè la conversione che ha smesso di partire
    // senza dirlo a nessuno.
    expect(h.eventi.some((e) => e.campi.esito === 'secret-errato' && e.livello === 'error')).toBe(
      true,
    )
  })

  it('senza `VIDEO_RUNNER_OWNER_ID` risponde 503 e grida il nome della variabile', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = { esito: 'non-configurato', variabile: 'VIDEO_RUNNER_OWNER_ID' }

    const res = await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)

    expect(res.status).toBe(503)
    // Configurazione mancante = `error`, mai `info`: senza quella variabile il runner
    // non parte affatto e la coda si riempie in silenzio.
    const gridato = h.eventi.filter((e) => e.livello === 'error')
    expect(gridato.length).toBeGreaterThan(0)
    expect(JSON.stringify(gridato)).toContain('VIDEO_RUNNER_OWNER_ID')
  })

  it('scrive il battito ANCHE quando il giro esplode', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esplode = new Error('la MicroVM non risponde')

    await expect(
      POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never),
    ).rejects.toThrow()

    // È il punto del `finally`: un giro che esplode e non lascia traccia è
    // indistinguibile da un cron che non chiama più.
    expect(battito()).toBeDefined()
    expect(battito()?.livello).toBe('error')
  })

  it('la coda vuota e una conversione in corso NON sono guasti', async () => {
    const { POST } = await import('@/app/api/video/runner/route')

    for (const esito of [
      { esito: 'coda-vuota' },
      { esito: 'in-corso', jobId: '40000000-0000-4000-8000-00000000000a' },
    ]) {
      h.eventi.length = 0
      h.esito = esito
      await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)
      // Nelle ore in cui nessuno carica niente questa route gira comunque 288 volte
      // al giorno: se la coda vuota fosse un `error`, il registro sarebbe pieno di
      // allarmi per il funzionamento normale, e un allarme che suona sempre viene
      // spento.
      expect(battito()?.livello, `esito ${esito.esito}`).toBe('info')
    }
  })

  it('un job rimesso in coda per un guasto NOSTRO (`in-riprova`) è un `warn`: né tranquillo né un guasto', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = {
      esito: 'in-riprova',
      jobId: '40000000-0000-4000-8000-00000000000a',
      codice: 'BUILD_DOWNLOAD_FAILED',
      tentativo: 1,
      attesaS: 300,
    }

    const res = await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)

    // La route risponde 200 e lo dice: il giro è riuscito, ha rimesso in coda un job.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, esito: 'in-riprova' })
    expect(h.chiamate).toBe(1)
    // `warn`: non è «tranquillo» (qualcosa non ha funzionato: se la build non si scarica, ogni video
    // in coda farà lo stesso, e il battito deve poterlo mostrare) e non è un `error` (il job non è
    // perso, e un allarme che suona a ogni ritentativo viene spento).
    expect(battito()?.livello).toBe('warn')
    expect(battito()?.campi.esito).toBe('in-riprova')
    expect(battito()?.campi.error_code).toBe('BUILD_DOWNLOAD_FAILED')
    expect(battito()?.campi.job_id).toBe('40000000-0000-4000-8000-00000000000a')
    // E non c'è nessun'altra riga d'errore: il registro non si riempie di allarmi per un ritentativo.
    expect(h.eventi.filter((e) => e.livello === 'error')).toEqual([])
  })

  it.each([
    [{ esito: 'fallito', jobId: '40000000-0000-4000-8000-00000000000a', codice: 'ENCODE_FAILED', rifiutato: false }],
    [{ esito: 'lease-persa', jobId: '40000000-0000-4000-8000-00000000000a', codice: 'FENCE_MISMATCH' }],
    [{ esito: 'esito-non-scritto', jobId: '40000000-0000-4000-8000-00000000000a', codice: 'OUTPUT_CONFLICT' }],
    [{ esito: 'presa-rifiutata', codice: 'LEASE_ACTIVE' }],
  ])('il `warn` non si allarga: %o resta un `error`', async (esito) => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = esito

    await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)

    // Solo `in-riprova` è un ritentativo già preso in carico. Un fallimento definitivo, una lease
    // persa, un esito non scritto o una presa rifiutata sono guasti veri, e restano `error`.
    expect(battito()?.livello, `esito ${esito.esito}`).toBe('error')
  })

  it('una conversione fallita invece è un guasto, e porta il suo codice', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = {
      esito: 'fallito',
      jobId: '40000000-0000-4000-8000-00000000000a',
      codice: 'ENCODE_FAILED',
      rifiutato: false,
    }

    await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)

    expect(battito()?.livello).toBe('error')
    expect(battito()?.campi.error_code).toBe('ENCODE_FAILED')
  })

  it('nel battito non finisce niente che somigli a un dato personale', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = { esito: 'pronto', jobId: '40000000-0000-4000-8000-00000000000a', byteUscita: 12 }

    await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)

    // La lista bianca di `redact` passa uuid, numeri, booleani e date. Un nome di
    // file scelto da un genitore non è nessuna di queste cose, e in un repository
    // pubblico finirebbe in un registro che qualcuno esporta.
    const campi = battito()?.campi ?? {}
    for (const [chiave, valore] of Object.entries(campi)) {
      if (typeof valore !== 'string') continue
      expect(valore, `campo ${chiave}`).not.toMatch(/\.(mp4|mov|jpg|png)$/i)
      expect(valore, `campo ${chiave}`).not.toMatch(/\//)
    }
  })

  it('dichiara nel battito lo STESSO tetto che il runner rispetta davvero', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    const { TETTO_INVOCAZIONE_MS } = await import('@/lib/media/video/runner')

    await POST(richiesta({ 'x-cron-secret': CRON_SECRET }) as never)

    // La cadenza del cron (cinque minuti) resta più lunga di questo numero (spec della PR 2, §9: «il cron
    // ogni cinque minuti resta la rete e non si tocca»). Fino alla PR 2 era anche un VINCOLO — al minuto,
    // due tick si agganciavano allo stesso Sandbox e il secondo scriveva un `error` su una conversione
    // riuscita — e adesso lo evita la sorveglianza esclusiva; ma un tetto che superasse la cadenza
    // vorrebbe dire invocazioni che si sovrappongono sempre, e se un giorno salisse senza che nessuno
    // tocchi il cron questa asserzione è il posto in cui il conto torna visibile.
    expect(battito()?.campi.tetto_invocazione_ms).toBe(TETTO_INVOCAZIONE_MS)
    expect(TETTO_INVOCAZIONE_MS).toBeLessThan(5 * 60_000)
  })
})

// =============================================================================
// IL CORPO: LETTO DOPO IL GATE, E SOLO `{ job_id? }` (PR 2, spec §6 e §9)
//
// Il cron manda `{}`; un calcio (`video_runner_kick`) manda `{"job_id":"<uuid>"}`. Il corpo si legge DOPO il
// gate — a un anonimo non si deserializza niente — con `request.text()` e non con `parseBody`, che
// risponderebbe 400 a un corpo vuoto (e il corpo vuoto è un'ipotesi che il cron e lo staff possono fare).
// Lo schema è `.strict()` (secondario #19): `{ "jobId": … }` col refuso prende 400 invece di essere scartato
// come `{}` e far fare al runner il giro intero del cron senza che nessuno lo sappia.
// =============================================================================

const JOB_UUID = '40000000-0000-4000-8000-00000000000a'
const GIUSTO = { 'x-cron-secret': CRON_SECRET }

describe('il corpo della richiesta al runner', () => {
  const precedente = process.env.CRON_SECRET

  beforeEach(() => {
    h.eventi.length = 0
    h.chiamate = 0
    h.richieste.length = 0
    h.esito = { esito: 'coda-vuota' }
    h.esplode = null
    h.staffNegato = null
    process.env.CRON_SECRET = CRON_SECRET
  })

  afterEach(() => {
    if (precedente === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = precedente
  })

  describe('cosa arriva al runner', () => {
    it.each([
      ['nessun corpo (il cron di prima)', undefined],
      ['`{}` (quello che manda `video_runner_tick_http`)', '{}'],
      ['una stringa vuota', ''],
      ['solo spazi e a capo', '  \n\t '],
    ])('%s: il giro del cron, senza un job', async (_nome, corpo) => {
      const { POST } = await import('@/app/api/video/runner/route')

      const res = await POST(richiesta(GIUSTO, corpo) as never)

      // Il corpo VUOTO è ammesso: `parseBody` avrebbe risposto 400 proprio al cron.
      expect(res.status).toBe(200)
      expect(h.richieste).toEqual([{}])
    })

    it('un calcio `{ "job_id": "<uuid>" }`: il runner riceve QUEL job', async () => {
      const { POST } = await import('@/app/api/video/runner/route')
      h.esito = { esito: 'in-corso', jobId: JOB_UUID }

      const res = await POST(richiesta(GIUSTO, JSON.stringify({ job_id: JOB_UUID })) as never)

      expect(res.status).toBe(200)
      expect(h.richieste).toEqual([{ jobId: JOB_UUID }])
      // E il job finisce nel battito: è lì che si vede quale calcio ha fatto che cosa.
      expect(battito()?.campi.job_id).toBe(JOB_UUID)
    })

    it('anche lo staff (senza il segreto) può lanciare un calcio a mano', async () => {
      const { POST } = await import('@/app/api/video/runner/route')

      const res = await POST(richiesta({}, JSON.stringify({ job_id: JOB_UUID })) as never)

      expect(res.status).toBe(200)
      expect(h.richieste).toEqual([{ jobId: JOB_UUID }])
      expect(battito()?.campi.canale).toBe('manuale')
    })
  })

  describe('cosa si RIFIUTA con un 400, e il runner NON parte', () => {
    it('SECONDARIO #19: la chiave col refuso (`jobId`, non `job_id`) è un 400 che nomina la chiave — non un giro del cron', async () => {
      const { POST } = await import('@/app/api/video/runner/route')

      const res = await POST(richiesta(GIUSTO, JSON.stringify({ jobId: JOB_UUID })) as never)

      expect(res.status).toBe(400)
      // ⚠️ Prima dello `.strict()` questo era un 200: la chiave sconosciuta veniva scartata, il corpo diventava
      // `{}` e il runner faceva il giro intero senza dire a nessuno che il calcio non era stato capito.
      expect(h.chiamate).toBe(0)
      const corpo = (await res.json()) as { error: string; details: { path: string; message: string }[] }
      expect(corpo.error).toBe('Dati non validi')
      expect(JSON.stringify(corpo.details)).toContain('jobId')
      // Si vede nel battito, a livello `error`: un cron che bussa col corpo sbagliato è un guasto nostro.
      expect(battito()?.campi.esito).toBe('corpo-non-valido')
      expect(battito()?.livello).toBe('error')
    })

    it.each([
      ['un `job_id` che non è un uuid', JSON.stringify({ job_id: 'non-un-uuid' })],
      ['un `job_id` nullo', JSON.stringify({ job_id: null })],
      ['un `job_id` giusto accanto a una chiave in più', JSON.stringify({ job_id: JOB_UUID, altro: 1 })],
      ['`null`', 'null'],
      ['una lista', '[]'],
      ['una stringa JSON', '"x"'],
      ['un numero', '42'],
      ['JSON malformato', '{"job_id":'],
      ['una chiave sconosciuta con un valore di 2.000 caratteri', JSON.stringify({ job_id: JOB_UUID, riempitivo: 'x'.repeat(2000) })],
      // ⚠️ QUESTA è la riga che prova il TETTO del corpo, e non quella sopra: una chiave in più la respinge già lo
      // schema `.strict()`, quindi togliere il tetto lasciava verde la riga di prima. Qui il JSON è valido e lo
      // schema lo accetterebbe (gli spazi in coda non sono una chiave): lo ferma solo la lunghezza.
      ['un `job_id` giusto seguito da 2.000 spazi (valido per lo schema, troppo lungo per la route)', JSON.stringify({ job_id: JOB_UUID }) + ' '.repeat(2000)],
    ])('%s: 400, e il runner non parte', async (_nome, corpo) => {
      const { POST } = await import('@/app/api/video/runner/route')

      const res = await POST(richiesta(GIUSTO, corpo) as never)

      expect(res.status).toBe(400)
      expect(h.chiamate).toBe(0)
      expect(battito()?.campi.esito).toBe('corpo-non-valido')
    })

    it('JSON malformato: si logga (`warn`) col perché, oltre al battito', async () => {
      const { POST } = await import('@/app/api/video/runner/route')

      await POST(richiesta(GIUSTO, '{"job_id":') as never)

      const riga = h.eventi.find((e) => e.campi.esito === 'corpo-json-malformato')
      expect(riga?.livello).toBe('warn')
      expect(riga?.err).toBeInstanceOf(Error)
    })

    it('un corpo che non si legge (lo stream si interrompe): 400, `warn`, e il runner non parte', async () => {
      const { POST } = await import('@/app/api/video/runner/route')
      const req = richiesta(GIUSTO, '{}')
      vi.spyOn(req, 'text').mockRejectedValue(new Error('stream interrotto'))

      const res = await POST(req as never)

      expect(res.status).toBe(400)
      expect(h.chiamate).toBe(0)
      expect(h.eventi.find((e) => e.campi.esito === 'corpo-illeggibile')?.livello).toBe('warn')
    })
  })

  describe('il corpo si legge DOPO il gate (lock `corpo-letto-dopo-il-gate`)', () => {
    it('senza segreto e senza staff NON si legge: a un anonimo non si deserializza niente', async () => {
      const { POST } = await import('@/app/api/video/runner/route')
      h.staffNegato = new Response(null, { status: 401 })
      const req = richiesta({}, JSON.stringify({ job_id: JOB_UUID }))
      const lettura = vi.spyOn(req, 'text')

      const res = await POST(req as never)

      expect(res.status).toBe(401)
      expect(lettura).not.toHaveBeenCalled()
      expect(h.chiamate).toBe(0)
    })

    it('col segreto SBAGLIATO (e senza staff) nemmeno', async () => {
      const { POST } = await import('@/app/api/video/runner/route')
      h.staffNegato = new Response(null, { status: 401 })
      const req = richiesta({ 'x-cron-secret': 'non-questo' }, JSON.stringify({ job_id: JOB_UUID }))
      const lettura = vi.spyOn(req, 'text')

      await POST(req as never)

      expect(lettura).not.toHaveBeenCalled()
    })

    it.each([
      ['col segreto giusto', GIUSTO],
      ['da staff, senza segreto', {}],
    ])('%s si legge UNA volta sola', async (_nome, intestazioni) => {
      const { POST } = await import('@/app/api/video/runner/route')
      const req = richiesta(intestazioni, JSON.stringify({ job_id: JOB_UUID }))
      const lettura = vi.spyOn(req, 'text')

      await POST(req as never)

      expect(lettura).toHaveBeenCalledTimes(1)
    })
  })
})

// =============================================================================
// GLI ESITI NUOVI E IL BATTITO: tranquilli, e con un'impronta TUTTA SUA
// =============================================================================

describe('gli esiti della PR 2 nel battito', () => {
  const precedente = process.env.CRON_SECRET

  beforeEach(() => {
    h.eventi.length = 0
    h.chiamate = 0
    h.richieste.length = 0
    h.esito = { esito: 'coda-vuota' }
    h.esplode = null
    h.staffNegato = null
    process.env.CRON_SECRET = CRON_SECRET
  })

  afterEach(() => {
    if (precedente === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = precedente
  })

  it.each([
    [{ esito: 'gia-sorvegliato', jobId: JOB_UUID }, 'info'],
    [{ esito: 'capacita-piena', jobId: JOB_UUID }, 'info'],
    [{ esito: 'capacita-piena' }, 'info'],
    [{ esito: 'coda-vuota' }, 'info'],
    [{ esito: 'in-corso', jobId: JOB_UUID }, 'info'],
    [{ esito: 'pronto', jobId: JOB_UUID, byteUscita: 12 }, 'info'],
    [{ esito: 'in-riprova', jobId: JOB_UUID, codice: 'SANDBOX_UNAVAILABLE', tentativo: 1, attesaS: 300 }, 'warn'],
    [{ esito: 'fallito', jobId: JOB_UUID, codice: 'ENCODE_FAILED', rifiutato: false }, 'error'],
    [{ esito: 'lease-persa', jobId: JOB_UUID, codice: 'FENCE_MISMATCH' }, 'error'],
    [{ esito: 'esito-non-scritto', jobId: JOB_UUID, codice: 'OUTPUT_CONFLICT' }, 'error'],
    [{ esito: 'presa-rifiutata', codice: 'LEASE_ACTIVE' }, 'error'],
  ])('%o: livello `%s`', async (esito, livello) => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = esito

    const res = await POST(richiesta(GIUSTO) as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, esito: esito.esito })
    // `gia-sorvegliato` e `capacita-piena` sono il runner che fa il suo mestiere: se fossero `error` tornerebbe
    // il falso allarme (`OUTPUT_CONFLICT` su una conversione riuscita) che la sorveglianza esclusiva toglie.
    expect(battito()?.livello, esito.esito).toBe(livello)
    expect(battito()?.campi.esito).toBe(esito.esito)
  })

  it('`capacita-piena` senza job: nel battito non c’è un `job_id` inventato', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    h.esito = { esito: 'capacita-piena' }

    await POST(richiesta(GIUSTO) as never)

    expect(battito()?.campi).not.toHaveProperty('job_id')
  })

  it('il battito distingue per OPERAZIONE: ha il suo bersaglio, e non cade nella riga del battito interno del runner', async () => {
    const { POST } = await import('@/app/api/video/runner/route')
    // Il vero modulo di logging e il vero calcolo dell'impronta: il resto di questo file li sostituisce.
    const { rigaEvento } = await vi.importActual<typeof import('@/lib/logging/logger')>('@/lib/logging/logger')
    const { impronta } = await vi.importActual<typeof import('@/lib/logging/app-log')>('@/lib/logging/app-log')

    await POST(richiesta(GIUSTO) as never)
    const b = battito()
    expect(b?.opzioni).toEqual({ distingui: ['operazione'] })

    const impronteDi = (r: NonNullable<ReturnType<typeof rigaEvento>>) =>
      impronta({
        sorgente: 'server',
        livello: r.livello,
        evento: r.evento,
        route: '/api/video/runner',
        codice: r.codice,
        statoHttp: r.statoHttp,
        messaggio: r.messaggio,
        stack: r.stack,
        bersaglio: r.bersaglio,
      })
    const dalBattito = rigaEvento('cron', 'info', b?.campi as never, undefined, b?.opzioni)
    // Il battito che il RUNNER scrive per conto suo quando la coda è vuota (`esegui.ts`): stesso evento, stesso
    // livello, stesso `esito` — quindi stesso MESSAGGIO — e durante la stessa richiesta, quindi stessa rotta.
    const dalRunner = rigaEvento('cron', 'info', { operazione: 'video-runner', esito: 'coda-vuota' })
    expect(dalBattito?.messaggio).toBe(dalRunner?.messaggio)

    // ⚠️ IL DIFETTO CHE QUESTO CHIUDE. `app_log` deduplica per `(impronta, giorno)` e la riga tiene il `contesto`
    // della PRIMA occorrenza: con la stessa impronta, in certi giorni l'unica riga di `coda-vuota` portava
    // `operazione: video-runner` (misurato in `app_log` il 2026-10-02, solo conteggi: nei 15 giorni dal 18/09 la
    // riga `coda-vuota` del giorno è sopravvissuta 8 volte come `video-runner` e 7 come `video-runner-tick`), e
    // `/api/health` non vedeva il battito di `video-runner-tick` anche con la lista degli esiti giusta.
    expect(impronteDi(dalBattito as never)).not.toBe(impronteDi(dalRunner as never))
    // La prova che il bersaglio è ciò che le separa: senza, sarebbero la STESSA riga.
    const senzaBersaglio = rigaEvento('cron', 'info', b?.campi as never)
    expect(impronteDi(senzaBersaglio as never)).toBe(impronteDi(dalRunner as never))
  })

  it('il bersaglio c’è a ogni livello (info, warn, error): vale per OGNI battito, non solo per la coda vuota', async () => {
    const { POST } = await import('@/app/api/video/runner/route')

    for (const esito of [
      { esito: 'pronto', jobId: JOB_UUID, byteUscita: 1 },
      { esito: 'in-riprova', jobId: JOB_UUID, codice: 'X_Y', tentativo: 1, attesaS: 300 },
      { esito: 'presa-rifiutata', codice: 'LEASE_ACTIVE' },
    ]) {
      h.eventi.length = 0
      h.esito = esito
      await POST(richiesta(GIUSTO) as never)
      expect(battito()?.opzioni, esito.esito).toEqual({ distingui: ['operazione'] })
    }
  })
})

// =============================================================================
// IL CABLAGGIO: `index.ts` → adattatori → nomi e argomenti delle RPC, con l'ambiente vero
//
// Qui NON si sostituisce il runner: si sostituisce il client Supabase, e si legge che cosa gli arriva. È l'unico
// punto che prova insieme che la variabile `VIDEO_CONVERSIONI_PARALLELE` diventi `p_tetto`, che l'identità
// dell'invocazione sia un uuid NUOVO a ogni chiamata e UGUALE fra le RPC della stessa, e che le RPC si chiamino
// con i nomi della PR 2.
// =============================================================================

describe('il cablaggio del runner con l’ambiente', () => {
  const OWNER_UUID = '00000000-1111-4222-8333-444444444444'
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  /** Un client Supabase che registra le RPC e risponde con `risposte[nome]`, o con un `ok` senza altro. */
  function clientCheRegistra(risposte: Record<string, unknown> = {}) {
    const rpc: { nome: string; args: Record<string, unknown> }[] = []
    const catena: Record<string, unknown> = {}
    // `is`, `in` e `not` sono quelli della scansione degli esiti (T7): l'elenco degli intenti in volo, qui, è vuoto.
    for (const metodo of ['select', 'eq', 'order', 'is', 'in', 'not']) catena[metodo] = () => catena
    // `miei()`: nessun job già mio. Chiude anche le due letture della scansione degli esiti.
    catena.limit = async () => ({ data: [], error: null })
    h.supabase = {
      rpc: async (nome: string, args: Record<string, unknown>) => {
        rpc.push({ nome, args })
        return { data: risposte[nome] ?? { ok: true }, error: null }
      },
      from: () => catena,
    }
    return rpc
  }

  async function runnerVero() {
    const { eseguiProssimoJobVideo } = await vi.importActual<typeof import('@/lib/media/video/runner')>(
      '@/lib/media/video/runner',
    )
    return eseguiProssimoJobVideo
  }

  beforeEach(() => {
    h.eventi.length = 0
    vi.stubEnv('VIDEO_RUNNER_OWNER_ID', OWNER_UUID)
    vi.stubEnv('VIDEO_CONVERSIONI_PARALLELE', '2')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    h.supabase = null
  })

  it('il giro: la variabile diventa `p_tetto` in ventaglio e prossimo, gli arrivi si recuperano a cinquanta', async () => {
    const rpc = clientCheRegistra({ video_job_prossimo: { ok: false, code: 'EMPTY_QUEUE' } })
    const esegui = await runnerVero()

    const esito = await esegui()

    expect(esito).toEqual({ esito: 'coda-vuota' })
    // Le pubblicazioni (T7) stanno fra il ventaglio e la presa, come nella testata di `esegui.ts`: `video_outbox_claim` è il loro
    // consumo. Prima di T7 il punto d'aggancio era vuoto e questo elenco non lo aveva.
    expect(rpc.map((r) => r.nome)).toEqual([
      'video_arrivi_recupera',
      'video_runner_ventaglio',
      'video_outbox_claim',
      'video_job_prossimo',
    ])
    expect(rpc[0].args).toEqual({ p_limite: 50 })
    expect(rpc[1].args).toEqual({ p_tetto: 2, p_escludi: null })
    expect(rpc[3].args).toEqual({ p_lease_owner: OWNER_UUID, p_lease_seconds: 300, p_tetto: 2 })
  })

  it('il giro consuma le pubblicazioni del RUNNER: un evento alla volta, SOLO `gallery.auto_publish`, col filtro nel claim', async () => {
    const rpc = clientCheRegistra({ video_job_prossimo: { ok: false, code: 'EMPTY_QUEUE' } })
    const esegui = await runnerVero()

    await esegui()

    const claim = rpc.filter((r) => r.nome === 'video_outbox_claim')
    expect(claim).toHaveLength(1)
    expect(claim[0].args).toMatchObject({ p_limite: 1, p_lease_seconds: 120, p_tipi: ['gallery.auto_publish'] })
    // La lease del claim è un uuid, e non è né il `lease_owner` del worker né l'identità dell'invocazione: è del consumo.
    expect(claim[0].args.p_lease_owner).toMatch(UUID)
    expect(claim[0].args.p_lease_owner).not.toBe(OWNER_UUID)
  })

  it('un calcio che non porta a un esito definitivo NON consuma le pubblicazioni (il giro del cron e `dopo-esito` sì)', async () => {
    const rpc = clientCheRegistra({ video_job_prendi: { ok: false, code: 'CAPACITA_PIENA' } })
    const esegui = await runnerVero()

    await esegui({ jobId: JOB_UUID })

    expect(rpc.some((r) => r.nome === 'video_outbox_claim')).toBe(false)
  })

  it('la scansione degli esiti legge gli intenti in volo con il nome del runner, e senza niente da notificare non scrive RPC', async () => {
    const rpc = clientCheRegistra({ video_job_prossimo: { ok: false, code: 'EMPTY_QUEUE' } })
    const esegui = await runnerVero()

    await esegui()

    // Nessun intento automatico in volo (la catena risponde `[]`): nessuna marca, nessuna notifica.
    expect(rpc.some((r) => r.nome === 'video_intent_esito_segna')).toBe(false)
    expect(h.eventi.some((e) => e.campi.esito === 'esiti-scansione-eccezione')).toBe(false)
  })

  it('senza la variabile il tetto è 3 (il predefinito)', async () => {
    vi.stubEnv('VIDEO_CONVERSIONI_PARALLELE', '')
    const rpc = clientCheRegistra({ video_job_prossimo: { ok: false, code: 'EMPTY_QUEUE' } })
    const esegui = await runnerVero()

    await esegui()

    expect(rpc.find((r) => r.nome === 'video_job_prossimo')?.args.p_tetto).toBe(3)
    expect(rpc.find((r) => r.nome === 'video_runner_ventaglio')?.args.p_tetto).toBe(3)
  })

  it('il calcio: `job_id` → sorveglianza (270 s) → presa col tetto → rilascio, tutte con la STESSA invocazione', async () => {
    const rpc = clientCheRegistra({ video_job_prendi: { ok: false, code: 'CAPACITA_PIENA' } })
    const esegui = await runnerVero()

    const esito = await esegui({ jobId: JOB_UUID })

    expect(esito).toEqual({ esito: 'capacita-piena', jobId: JOB_UUID })
    expect(rpc.map((r) => r.nome)).toEqual([
      'video_job_sorveglianza_prendi',
      'video_job_prendi',
      'video_job_sorveglianza_rilascia',
    ])
    expect(rpc[0].args).toMatchObject({ p_job_id: JOB_UUID, p_secondi: 270 })
    expect(rpc[1].args).toEqual({ p_job_id: JOB_UUID, p_lease_owner: OWNER_UUID, p_lease_seconds: 300, p_tetto: 2 })
    expect(rpc[2].args).toMatchObject({ p_job_id: JOB_UUID })
    // L'identità dell'invocazione è un uuid, ed è la STESSA nelle due RPC che la portano: chi rilascia deve
    // essere chi ha preso, altrimenti la lease di sorveglianza resterebbe lì fino alla scadenza.
    expect(rpc[0].args.p_invocazione).toMatch(UUID)
    expect(rpc[2].args.p_invocazione).toBe(rpc[0].args.p_invocazione)
  })

  it('l’identità dell’invocazione è NUOVA a ogni chiamata, quella del worker (`lease_owner`) invece è STABILE', async () => {
    const rpc = clientCheRegistra({ video_job_prendi: { ok: false, code: 'CAPACITA_PIENA' } })
    const esegui = await runnerVero()

    await esegui({ jobId: JOB_UUID })
    await esegui({ jobId: JOB_UUID })

    const sorveglianze = rpc.filter((r) => r.nome === 'video_job_sorveglianza_prendi')
    const prese = rpc.filter((r) => r.nome === 'video_job_prendi')
    expect(sorveglianze).toHaveLength(2)
    expect(prese).toHaveLength(2)
    // Con la stessa identità due invocazioni non si distinguerebbero, e la sorveglianza ESCLUSIVA sarebbe
    // condivisa da tutte: è il difetto del `lease_owner` stabile, che la sorveglianza esiste per non avere.
    expect(sorveglianze[0].args.p_invocazione).not.toBe(sorveglianze[1].args.p_invocazione)
    // …mentre l'owner della conversione resta lo stesso: è ciò che permette di RIPRENDERE una lease con lo
    // stesso fence (e quindi di riagganciare lo stesso Sandbox) dall'invocazione dopo.
    expect(prese.map((r) => r.args.p_lease_owner)).toEqual([OWNER_UUID, OWNER_UUID])
  })

  it('senza `VIDEO_RUNNER_OWNER_ID` il runner non parte e non chiama il database', async () => {
    vi.stubEnv('VIDEO_RUNNER_OWNER_ID', '')
    const rpc = clientCheRegistra()
    const esegui = await runnerVero()

    const esito = await esegui({ jobId: JOB_UUID })

    expect(esito).toEqual({ esito: 'non-configurato', variabile: 'VIDEO_RUNNER_OWNER_ID' })
    expect(rpc).toEqual([])
  })
})

// =============================================================================
// LA CONFIGURAZIONE: `VIDEO_CONVERSIONI_PARALLELE`
// =============================================================================

describe('la variabile VIDEO_CONVERSIONI_PARALLELE', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function leggi(valore: string | undefined) {
    const { conversioniParallele } = await import('@/lib/media/video/runner')
    h.eventi.length = 0
    if (valore === undefined) vi.stubEnv('VIDEO_CONVERSIONI_PARALLELE', undefined as unknown as string)
    else vi.stubEnv('VIDEO_CONVERSIONI_PARALLELE', valore)
    return conversioniParallele()
  }

  it.each([undefined, ''])('assente o vuota (%j) è il predefinito, 3, e NON è una riga di log (è il caso normale)', async (valore) => {
    expect(await leggi(valore)).toBe(3)
    expect(h.eventi).toEqual([])
  })

  it.each([
    ['1', 1],
    ['3', 3],
    ['5', 5],
    ['10', 10],
  ])('«%s» è valida: %i', async (valore, atteso) => {
    expect(await leggi(valore)).toBe(atteso)
    expect(h.eventi).toEqual([])
  })

  it.each(['0', '11', '-2', '2.5', 'abc', '3 volte', 'NaN', 'Infinity', '1e1000'])(
    '«%s» è fuori dall’intervallo 1–10: si torna al predefinito e la riga è `error` (configurazione sbagliata, mai `info`)',
    async (valore) => {
      expect(await leggi(valore)).toBe(3)

      expect(h.eventi).toHaveLength(1)
      expect(h.eventi[0]).toMatchObject({
        evento: 'config',
        livello: 'error',
        campi: { operazione: 'video-runner', esito: 'config-non-valida' },
      })
      // Il NOME della variabile viaggia nel messaggio dell'errore (in un campo diventerebbe `[redatto]`): senza,
      // la riga direbbe «manca una variabile» senza dire quale. Il valore invece non c'è.
      // Sempre lo stesso testo, qualunque sia il valore sbagliato: il valore non entra nel log.
      expect((h.eventi[0].err as Error).message).toBe('VIDEO_CONVERSIONI_PARALLELE: atteso un intero fra 1 e 10')
    },
  )

  it('il massimo accettato è 10 e il predefinito 3: sono costanti esportate, non numeri sparsi', async () => {
    const m = await import('@/lib/media/video/runner')
    expect(m.CONVERSIONI_PARALLELE_MASSIME).toBe(10)
    expect(m.CONVERSIONI_PARALLELE_PREDEFINITE).toBe(3)
    expect(m.ENV_CONVERSIONI_PARALLELE).toBe('VIDEO_CONVERSIONI_PARALLELE')
  })
})
