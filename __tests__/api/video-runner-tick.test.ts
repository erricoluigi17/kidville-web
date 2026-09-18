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
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  /** Quante volte il runner è stato invocato: è il numero che conta di più qui. */
  chiamate: 0,
  esito: { esito: 'coda-vuota' } as unknown,
  esplode: null as Error | null,
  staffNegato: null as unknown,
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ evento, livello, campi })
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
    eseguiProssimoJobVideo: async () => {
      h.chiamate += 1
      if (h.esplode) throw h.esplode
      return h.esito
    },
  }
})

function richiesta(intestazioni: Record<string, string> = {}): Request {
  return new Request('https://esempio.invalid/api/video/runner', {
    method: 'POST',
    headers: intestazioni,
  })
}

const battito = () => h.eventi.find((e) => e.campi.operazione === 'video-runner-tick')

describe('il battito del runner video', () => {
  const precedente = process.env.CRON_SECRET

  beforeEach(() => {
    h.eventi.length = 0
    h.chiamate = 0
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

    // La cadenza del cron (cinque minuti) è scelta PERCHÉ sia più lunga di questo
    // numero: al minuto, due tick si aggancerebbero allo stesso Sandbox e il secondo
    // scriverebbe un `error` su una conversione riuscita. Se un giorno il tetto
    // salisse oltre la cadenza senza che nessuno tocchi il cron, questa asserzione è
    // il posto in cui il conto torna visibile.
    expect(battito()?.campi.tetto_invocazione_ms).toBe(TETTO_INVOCAZIONE_MS)
    expect(TETTO_INVOCAZIONE_MS).toBeLessThan(5 * 60_000)
  })
})
