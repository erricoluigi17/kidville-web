import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `GET|PATCH /api/video-uploads/[id]` — lo stato che il telefono interroga, e le
 * azioni sull'intento.
 *
 * ─── PERCHÉ LO STATO SI LEGGE DALL'INTENTO E NON DAL JOB ─────────────────────
 * Una News può portare dieci allegati: dieci job sotto un solo impegno. Il
 * telefono ne interroga UNO — l'intento — e riceve tutti gli stati insieme.
 * Interrogarli uno per uno vorrebbe dire dieci richieste per ogni giro di
 * polling, su una rete mobile, mentre l'app è aperta.
 *
 * ─── E PERCHÉ IL POLLING NON PUÒ MOSTRARE I CODICI DELLA PIPELINE ────────────
 * `OUTPUT_DURATION_MISMATCH` è il verdetto di `verifyVideoOutput`; `LEASE_EXPIRED`
 * racconta com'è fatto il worker. Sono informazione per il log. `schemaStatoJobVideo`
 * accetta SOLO i codici mostrabili, e questo file misura che la traduzione avvenga
 * al bordo — non «per convenzione», ma perché lo schema rifiuterebbe il contrario.
 *
 * ─── LE AZIONI, E IL CANCELLO CHE LE PRECEDE ─────────────────────────────────
 * `caricato`, `conferma`, `annulla`, `annulla-job`. Il cancello **applicativo**
 * (chi sei, e questa sede è ancora tua) sta qui in TypeScript; il cancello
 * **transazionale** (revisione corrente, un solo vincitore, stato ammesso) sta
 * nelle RPC. La lezione che questo file custodisce è che il cancello applicativo
 * è UNO SOLO e vale per TUTTI i verbi: una copia nel `GET` che lasciasse scoperta
 * la `PATCH` è il difetto che il piano cita per nome.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  rpc: vi.fn(),
  intent: null as Record<string, unknown> | null,
  intentError: null as { code?: string; message?: string } | null,
  job: [] as Record<string, unknown>[],
  jobError: null as { code?: string; message?: string } | null,
  tabelleLette: [] as string[],
  /** L'elenco di colonne chiesto a ogni tabella: `.select('a, b, c')`. */
  colonneChieste: {} as Record<string, string>,
  corpoLetto: 0,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  requireDocente: h.requireDocente,
}))

vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: h.resolveScuolaScrittura,
  scuoleDiUtente: h.scuoleDiUtente,
  resolveScuoleAttive: vi.fn(),
}))

/**
 * Un finto builder PostgREST: `.select().eq().eq().maybeSingle()` e
 * `.select().eq().order()`. Sta qui e non in una fixture perché deve restituire
 * `{ data, error }` — cioè la forma che NON lancia, che è tutto il motivo per cui
 * la route deve guardare il valore di ritorno invece di avvolgere in un `try`.
 *
 * ⚠️ PROIETTA SULLE COLONNE CHIESTE, come fa PostgREST. Un finto che restituisce la riga
 * intera è verde anche quando la route dimentica di chiedere una colonna: il campo
 * `attempt` arriverebbe lo stesso al codice, nei test, e in produzione non arriverebbe
 * mai — e `riprovaAutomatica` resterebbe `false` per sempre senza un solo errore. È la
 * forma di silenzio che questo repository combatte: la colonna non chiesta si vede qui.
 */
function tabella(nome: string) {
  h.tabelleLette.push(nome)
  let colonne: string[] | null = null
  const proietta = (riga: unknown): unknown => {
    if (colonne === null || riga === null || typeof riga !== 'object') return riga
    const scelte = colonne
    return Object.fromEntries(Object.entries(riga as Record<string, unknown>).filter(([k]) => scelte.includes(k)))
  }
  const risposta = () =>
    nome === 'video_intents'
      ? { data: proietta(h.intent), error: h.intentError }
      : { data: Array.isArray(h.job) ? h.job.map(proietta) : h.job, error: h.jobError }
  const catena: Record<string, unknown> = {
    select: (elenco?: string) => {
      h.colonneChieste[nome] = elenco ?? ''
      colonne = elenco ? elenco.split(',').map((c) => c.trim()) : null
      return catena
    },
    eq: () => catena,
    in: () => catena,
    order: async () => risposta(),
    maybeSingle: async () => risposta(),
    limit: () => catena,
    then: undefined,
  }
  return catena
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: (nome: string, args: Record<string, unknown>) => h.rpc(nome, args),
    from: (nome: string) => tabella(nome),
  }),
}))

import { GET, PATCH } from '@/app/api/video-uploads/[id]/route'
import itShared from '../../messages/it/shared.json'

const SEDE = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const DOCENTE = '20000000-0000-4000-8000-000000000002'
const INTENT = '30000000-0000-4000-8000-000000000003'
const JOB_1 = '40000000-0000-4000-8000-000000000004'
const JOB_ESTRANEO = '40000000-0000-4000-8000-00000000000f'

const params = { params: Promise.resolve({ id: INTENT }) }

const richiestaGet = () =>
  ({
    url: `http://test/api/video-uploads/${INTENT}`,
    method: 'GET',
    headers: new Headers(),
    cookies: { get: () => undefined },
  }) as never

const richiestaPatch = (corpo: unknown) =>
  ({
    url: `http://test/api/video-uploads/${INTENT}`,
    method: 'PATCH',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => {
      h.corpoLetto += 1
      return corpo
    },
    text: async () => JSON.stringify(corpo),
    cookies: { get: () => undefined },
  }) as never

const rigaIntent = (extra: Record<string, unknown> = {}) => ({
  id: INTENT,
  owner_id: DOCENTE,
  scuola_id: SEDE,
  channel: 'gallery',
  revision: 1,
  status: 'pending',
  updated_at: '2026-09-18T10:00:00.000Z',
  ...extra,
})

const rigaJob = (extra: Record<string, unknown> = {}) => ({
  id: JOB_1,
  intent_id: INTENT,
  owner_id: DOCENTE,
  channel: 'gallery',
  status: 'processing',
  error_code: null,
  // Le colonne della migrazione dei ritentativi, com'è fatta la tabella vera: la route chiede
  // `attempt` e NON `last_error_code` (la causa interna) né `next_attempt_at`. Il primo giro del
  // runner è `attempt = 1`: un job `processing` di default non si sta ritentando.
  attempt: 1,
  last_error_code: null,
  next_attempt_at: null,
  updated_at: '2026-09-18T10:01:00.000Z',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelleLette = []
  h.colonneChieste = {}
  h.corpoLetto = 0
  h.intent = rigaIntent()
  h.intentError = null
  h.job = [rigaJob()]
  h.jobError = null
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
  h.rpc.mockResolvedValue({ data: { ok: true }, error: null })
})

describe('GET /api/video-uploads/[id] — lo stato in polling', () => {
  it('restituisce lo stato dell’intento e quello di ogni job', async () => {
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.intentId).toBe(INTENT)
    expect(corpo.revisione).toBe(1)
    expect(corpo.statoIntent).toBe('pending')
    expect(corpo.job).toHaveLength(1)
    expect(corpo.job[0]).toMatchObject({
      jobId: JOB_1,
      intentId: INTENT,
      canale: 'gallery',
      stato: 'processing',
      avanzamento: 60,
      codice: null,
    })
  })

  it('un job fallito porta il codice MOSTRABILE, non quello della pipeline', async () => {
    h.job = [rigaJob({ status: 'failed', error_code: 'OUTPUT_DURATION_MISMATCH' })]
    const res = await GET(richiestaGet(), params)
    const corpo = await res.json()
    expect(corpo.job[0].codice).toBe('VIDEO_CONVERSIONE_NON_RIUSCITA')
    expect(corpo.job[0].avanzamento).toBeNull()
    expect(JSON.stringify(corpo)).not.toContain('OUTPUT_DURATION_MISMATCH')
  })

  it('un job fallito SENZA codice non lascia la schermata muta', async () => {
    // `schemaStatoJobVideo` rifiuta un job fallito con `codice: null`: la
    // schermata non avrebbe niente da dire. Il ripiego del contratto copre il caso.
    h.job = [rigaJob({ status: 'rejected', error_code: null })]
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(200)
    expect((await res.json()).job[0].codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
  })

  it('un job annullato non porta un codice d’errore né una barra a metà', async () => {
    h.job = [rigaJob({ status: 'cancelled', error_code: 'FENCE_MISMATCH' })]
    const res = await GET(richiestaGet(), params)
    const corpo = await res.json()
    expect(corpo.job[0].codice).toBeNull()
    expect(corpo.job[0].avanzamento).toBeNull()
  })

  it('l’intento di un’altra persona non esiste: 404, non un oracolo', async () => {
    h.intent = null
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('VIDEO_NON_TROVATO')
  })

  it('la sede dell’intento non è più fra le proprie ⇒ 403', async () => {
    // Un'insegnante spostata di plesso non deve poter seguire — né concludere —
    // un caricamento rimasto nella sede da cui è uscita.
    h.scuoleDiUtente.mockResolvedValue([ALTRA_SEDE])
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VIDEO_NON_AUTORIZZATO')
  })

  it('gate negato ⇒ nessuna lettura del database', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 401 }) })
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(401)
    expect(h.tabelleLette).toEqual([])
  })

  it('un id che non è un uuid ⇒ 400, prima di interrogare qualunque tabella', async () => {
    const res = await GET(richiestaGet(), { params: Promise.resolve({ id: 'non-un-uuid' }) })
    expect(res.status).toBe(400)
    expect(h.tabelleLette).toEqual([])
  })

  it('la tabella non c’è (DB non migrato) ⇒ 503 pulito', async () => {
    h.intent = null
    h.intentError = { code: '42P01', message: 'relation "video_intents" does not exist' }
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
  })
})

/**
 * IL RITENTATIVO AUTOMATICO, COME LO LEGGE CHI ASPETTA.
 *
 * Dal 29/09/2026 nessun video si convertiva, e a chi aveva caricato il filmato lo schermo
 * non diceva niente di vero. Da quando il runner ritenta da solo i guasti NOSTRI (quattro
 * tentativi in un'ora), il job passa da `processing` a `queued` con `attempt` che cresce:
 * la route lo traduce in `riprovaAutomatica`, e la scheda dice «lo stiamo riprovando» invece
 * di sembrare una coda ferma. Qui si tiene fermo che il flag nasce dalla riga GIUSTA, che la
 * colonna da cui nasce viene davvero CHIESTA, e che la causa interna non esce.
 */
describe('GET /api/video-uploads/[id] — il ritentativo automatico dopo un guasto nostro', () => {
  const GUASTI_DI_INFRASTRUTTURA = [
    'BUILD_DOWNLOAD_FAILED',
    'BUILD_HASH_MISMATCH',
    'BUILD_EXTRACT_FAILED',
    'BUILD_INCOMPLETE',
    'SANDBOX_UNAVAILABLE',
    'SOURCE_DOWNLOAD_FAILED',
    'OUTPUT_UPLOAD_FAILED',
  ]

  it('un job rimesso in coda dopo un guasto nostro dice «lo stiamo riprovando», senza codice', async () => {
    // Com'è lasciato da `video_job_retry`: `queued`, `attempt` invariato, la causa in
    // `last_error_code` e l'orario del prossimo tentativo nel futuro.
    h.job = [
      rigaJob({
        status: 'queued',
        attempt: 1,
        last_error_code: 'BUILD_DOWNLOAD_FAILED',
        next_attempt_at: '2026-10-02T10:05:00.000Z',
      }),
    ]
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.job[0]).toMatchObject({
      stato: 'queued',
      avanzamento: 25,
      codice: null,
      riprovaAutomatica: true,
    })
    // La persona legge «è un problema nostro»: il NOME della causa resta nel log.
    const testo = JSON.stringify(corpo)
    expect(testo).not.toContain('BUILD_DOWNLOAD_FAILED')
    expect(testo).not.toContain('last_error_code')
    expect(testo).not.toContain('next_attempt_at')
  })

  it.each([
    // [stato del database, attempt, riprovaAutomatica attesa]
    ['queued', 0, false], // il caricamento appena arrivato: l'unica strada di `video_job_uploaded`
    ['queued', 1, true], // rimesso in coda dopo il primo giro
    ['queued', 3, true], // …dopo il terzo
    ['processing', 1, false], // il primo giro del runner non è un ritentativo
    ['processing', 2, true], // il primo ritentativo è partito
    ['processing', 4, true], // l'ultimo
    ['ready', 3, false], // finito bene dopo i ritentativi: non c'è più niente da riprovare
    ['cancelled', 2, false], // ritirato: nessuno sta riprovando niente
    ['awaiting_upload', 0, false],
  ] as const)('stato %s con attempt %i ⇒ riprovaAutomatica %s', async (status, attempt, atteso) => {
    h.job = [rigaJob({ status, attempt })]
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(200)
    expect((await res.json()).job[0].riprovaAutomatica).toBe(atteso)
  })

  it('un attempt che manca dalla riga non promette un ritentativo che potrebbe non esserci', async () => {
    h.job = [rigaJob({ status: 'queued', attempt: undefined })]
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(200)
    expect((await res.json()).job[0].riprovaAutomatica).toBe(false)
  })

  it('CHIEDE la colonna `attempt` (e solo quella dei ritentativi), non la causa interna', async () => {
    await GET(richiestaGet(), params)
    const colonne = (h.colonneChieste.video_jobs ?? '').split(',').map((c) => c.trim())
    // Il finto proietta sulle colonne chieste, come PostgREST: senza `attempt` qui sotto il
    // flag resterebbe `false` anche con la riga giusta — ed è esattamente il guasto muto.
    expect(colonne, 'la route non chiede più `attempt`: «lo stiamo riprovando» non comparirebbe mai').toContain('attempt')
    expect(colonne, '`last_error_code` è il nome interno della causa: non deve uscire').not.toContain('last_error_code')
    expect(colonne).not.toContain('next_attempt_at')
  })

  it.each(GUASTI_DI_INFRASTRUTTURA)('%s a tentativi esauriti ⇒ «problema nostro», e il nome interno resta fuori', async (codice) => {
    // `failed` dopo quattro tentativi: la scheda non ritenta più, e la frase è quella del
    // guasto nostro — non «il file sembra rovinato», non «riprova».
    h.job = [rigaJob({ status: 'failed', attempt: 4, error_code: codice, last_error_code: codice })]
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.job[0]).toMatchObject({
      stato: 'failed',
      avanzamento: null,
      codice: 'VIDEO_GUASTO_NOSTRO',
      riprovaAutomatica: false,
    })
    expect(JSON.stringify(corpo)).not.toContain(codice)
  })

  it.each([
    ['PROBE_COMMAND_FAILED', 'VIDEO_NON_LEGGIBILE'],
    ['ENCODE_FAILED', 'VIDEO_CONVERSIONE_NON_RIUSCITA'],
    ['CONVERSION_TIMEOUT', 'VIDEO_CONVERSIONE_NON_RIUSCITA'],
  ])('%s resta quello di prima: il file c’entra (%s)', async (codice, atteso) => {
    h.job = [rigaJob({ status: 'failed', attempt: 1, error_code: codice })]
    const res = await GET(richiestaGet(), params)
    expect((await res.json()).job[0].codice).toBe(atteso)
  })
})

describe('PATCH /api/video-uploads/[id] — le azioni sull’intento', () => {
  it('`conferma` chiama `video_intent_confirm` con proprietario e revisione', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, intent: rigaIntent({ status: 'confirmed' }) }, error: null })
    h.intent = rigaIntent({ status: 'confirmed' })
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('video_intent_confirm', {
      p_intent_id: INTENT,
      p_owner_id: DOCENTE,
      p_revision: 1,
    })
    // La risposta è lo stesso corpo del GET: il client ha un parser solo.
    const corpo = await res.json()
    expect(corpo.statoIntent).toBe('confirmed')
    expect(corpo.job).toHaveLength(1)
  })

  it('una revisione superata ⇒ 409 e il codice che invita a ricaricare', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'REVISION_MISMATCH' }, error: null })
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VIDEO_RIPROVA')
  })

  it('`caricato` chiama `video_job_uploaded` con la taglia e il tipo dichiarati', async () => {
    const res = await PATCH(
      richiestaPatch({ azione: 'caricato', jobId: JOB_1, byte: 812_345_678, mime: 'video/quicktime' }),
      params,
    )
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('video_job_uploaded', {
      p_job_id: JOB_1,
      p_owner_id: DOCENTE,
      p_source_size: 812_345_678,
      p_source_mime: 'video/quicktime',
    })
  })

  it('`caricato` su un job che non è di questo intento ⇒ 404, e nessuna RPC', async () => {
    const res = await PATCH(
      richiestaPatch({ azione: 'caricato', jobId: JOB_ESTRANEO, byte: 10, mime: 'video/mp4' }),
      params,
    )
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('VIDEO_NON_TROVATO')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('`annulla` ritira l’intento intero', async () => {
    h.intent = rigaIntent({ status: 'cancelled' })
    const res = await PATCH(richiestaPatch({ azione: 'annulla', revisione: 1 }), params)
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('video_intent_revoke', {
      p_intent_id: INTENT,
      p_owner_id: DOCENTE,
      p_revision: 1,
    })
  })

  it('`annulla-job` spegne un allegato solo, e solo se è di questo intento', async () => {
    const res = await PATCH(richiestaPatch({ azione: 'annulla-job', jobId: JOB_1 }), params)
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('video_job_cancel', {
      p_job_id: JOB_1,
      p_owner_id: DOCENTE,
    })
  })

  it('un intento già concluso ⇒ 409 con il codice che lo dice', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'INTENT_REVOKED' }, error: null })
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VIDEO_GIA_CONCLUSO')
  })

  it('IL CANCELLO VALE ANCHE QUI: sede non più propria ⇒ 403 e nessuna RPC', async () => {
    // È la lezione del piano: «una copia del gate nell'handler proteggeva la POST
    // e lasciava scoperta la PATCH».
    h.scuoleDiUtente.mockResolvedValue([ALTRA_SEDE])
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VIDEO_NON_AUTORIZZATO')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('gate negato ⇒ il corpo non viene nemmeno letto', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(403)
    expect(h.corpoLetto).toBe(0)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('un’azione che non esiste ⇒ 400 di validazione, nessuna RPC', async () => {
    const res = await PATCH(richiestaPatch({ azione: 'pubblica-subito' }), params)
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la pubblicazione NON passa di qui: `finalize` è di V08/V09', async () => {
    // `video_intent_finalize` è l'unico punto in cui qualcosa diventa visibile a
    // una famiglia, e pretende il consenso foto e i gate del dominio. Esporlo qui
    // come una quinta azione vorrebbe dire pubblicare senza quei gate.
    const res = await PATCH(richiestaPatch({ azione: 'pubblica', revisione: 1 }), params)
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la RPC assente (DB non migrato) ⇒ 503, non un 500', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'x' } })
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
  })

  it('GET e PATCH restituiscono lo STESSO corpo: anche la PATCH porta `riprovaAutomatica`', async () => {
    // La conferma può arrivare mentre il job è già stato rimesso in coda dal runner: la
    // risposta rilegge lo stato e non deve tornare a una schermata che non conosce il ritentativo.
    h.intent = rigaIntent({ status: 'confirmed' })
    h.job = [rigaJob({ status: 'queued', attempt: 2 })]
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(200)
    expect((await res.json()).job[0].riprovaAutomatica).toBe(true)
  })

  it('RETRY_NOT_DUE ⇒ 409 e «riprova»: un rifiuto ordinario, senza il nome della RPC', async () => {
    // È ciò che `video_job_claim` risponde al runner per un job che aspetta il suo turno: non
    // raggiunge una persona, ma la tabella dei numeri è totale e questo ne decide uno.
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'RETRY_NOT_DUE' }, error: null })
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VIDEO_RIPROVA')
    expect(JSON.stringify(corpo)).not.toContain('RETRY_NOT_DUE')
  })

  it('un guasto di infrastruttura arrivato fin qui parla col catalogo, mai col codice', async () => {
    // Non succede con le RPC di oggi (lo dice il runner, non la route), ma `rispostaVideo` ha
    // un ramo per `VIDEO_GUASTO_NOSTRO` e deve rispondere con la frase del catalogo: un ramo
    // che manca non compila, un ramo che legge la chiave sbagliata risponderebbe a stringa vuota.
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'SANDBOX_UNAVAILABLE' }, error: null })
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(res.status).toBe(503)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VIDEO_GUASTO_NOSTRO')
    expect(corpo.error).toBe(itShared.erroreVideoGuastoNostro)
    expect(corpo.error.length).toBeGreaterThan(40)
    expect(JSON.stringify(corpo)).not.toContain('SANDBOX_UNAVAILABLE')
  })
})
