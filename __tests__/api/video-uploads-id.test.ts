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
 * `caricato`, `conferma`, `annulla`, `annulla-job` e, dal 2026-10-02, `riprova-pubblicazione`.
 * Il cancello **applicativo** (chi sei, e questa sede è ancora tua) sta in TypeScript; il
 * cancello **transazionale** (revisione corrente, un solo vincitore, stato ammesso) sta
 * nelle RPC. La lezione che questo file custodisce è che il cancello applicativo
 * è UNO SOLO e vale per TUTTI i verbi: una copia nel `GET` che lasciasse scoperta
 * la `PATCH` è il difetto che il piano cita per nome.
 *
 * ─── DAL 2026-10-02: IL CALCIO AL RUNNER, E L'ARRIVO GIÀ REGISTRATO ──────────
 * `caricato` mette il job in coda e CALCIA il runner subito (`video_runner_kick`), senza aspettare
 * il cron: è la rete del trigger d'arrivo, e non deve mai far fallire la risposta. E un
 * `SOURCE_CONFLICT` su un job che il trigger ha già portato in coda (`arrivato_il` scritto) è un
 * successo: il file c'è, e dire «riprova» a un client che ha solo un `mime` scritto in un altro modo
 * vorrebbe dire farlo ripetere all'infinito.
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
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

// Si spiano SOLO i due logger di dominio (il resto resta reale e silenzioso sotto VITEST).
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
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
  // I filtri `.eq()` si APPLICANO alle righe, come fa PostgREST: un finto che li ignorasse restituirebbe l'intento
  // di un'altra persona anche se la route dimenticasse `owner_id`, ed è esattamente il difetto da provare.
  const filtri: [string, unknown][] = []
  const passa = (riga: unknown) =>
    riga !== null && typeof riga === 'object' && filtri.every(([c, v]) => (riga as Record<string, unknown>)[c] === v)
  const proietta = (riga: unknown): unknown => {
    if (colonne === null || riga === null || typeof riga !== 'object') return riga
    const scelte = colonne
    return Object.fromEntries(Object.entries(riga as Record<string, unknown>).filter(([k]) => scelte.includes(k)))
  }
  const risposta = () =>
    nome === 'video_intents'
      ? { data: proietta(passa(h.intent) ? h.intent : null), error: h.intentError }
      : { data: Array.isArray(h.job) ? h.job.filter(passa).map(proietta) : h.job, error: h.jobError }
  const catena: Record<string, unknown> = {
    select: (elenco?: string) => {
      h.colonneChieste[nome] = elenco ?? ''
      colonne = elenco ? elenco.split(',').map((c) => c.trim()) : null
      return catena
    },
    eq: (colonna: string, valore: unknown) => {
      filtri.push([colonna, valore])
      return catena
    },
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

/** Gli eventi di dominio della Galleria o delle News (via il rumore di `route` di `withRoute`). */
const eventi = (area: 'galleria' | 'news' = 'galleria') => h.logEvento.mock.calls.filter((c) => c[0] === area)

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
  created_at: '2026-09-18T10:00:00.000Z',
  // Le colonne della PR 2: il percorso dell'originale (porta l'uuid di chi ha caricato, e non esce mai), il tipo
  // dichiarato all'apertura e l'arrivo del file (lo scrive il trigger).
  original_path: `${DOCENTE}/0123456789abcdef0123456789abcdef.mov`,
  mime_dichiarato: 'video/quicktime',
  arrivato_il: null,
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

  it('il filtro di PROPRIETÀ sta dentro la query: l’intento di una collega risponde 404 (non 403) e nessuna RPC parte', async () => {
    // Qui il finto APPLICA i `.eq()`: se `leggiIntento` dimenticasse `owner_id`, la riga della collega tornerebbe e la
    // risposta sarebbe 200 (GET) o l'azione partirebbe (PATCH). Un confronto DOPO la lettura darebbe 403, e un 403 direbbe
    // a chi prova che quell'id esiste.
    h.intent = rigaIntent({ owner_id: '99999999-0000-4000-8000-000000000009' })
    const lettura = await GET(richiestaGet(), params)
    expect(lettura.status).toBe(404)
    expect((await lettura.json()).codice).toBe('VIDEO_NON_TROVATO')

    const azione = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect(azione.status).toBe(404)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('i job si leggono PER INTENTO: quelli di un altro intento non finiscono nello stato', async () => {
    h.job = [rigaJob(), rigaJob({ id: JOB_ESTRANEO, intent_id: '30000000-0000-4000-8000-0000000000ff' })]
    const corpo = await (await GET(richiestaGet(), params)).json()
    expect(corpo.job.map((j: { jobId: string }) => j.jobId)).toEqual([JOB_1])
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

  it('la risposta di un’azione porta lo stato RILETTO dopo di lei, non quello letto prima', async () => {
    // Dopo `annulla-job` il job cambia stato: restituire ciò che si era letto PRIMA manderebbe il client a mostrare una
    // schermata già falsa. Il finto cambia le righe nel momento in cui la RPC gira, e la route deve rileggerle.
    h.job = [rigaJob({ status: 'processing' })]
    h.rpc.mockImplementation(async () => {
      h.job = [rigaJob({ status: 'cancelled' })]
      h.intent = rigaIntent({ status: 'cancelled', updated_at: '2026-09-18T10:05:00.000Z' })
      return { data: { ok: true }, error: null }
    })
    const res = await PATCH(richiestaPatch({ azione: 'annulla-job', jobId: JOB_1 }), params)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.job[0].stato).toBe('cancelled')
    expect(corpo.statoIntent).toBe('cancelled')
    expect(corpo.aggiornatoIl).toBe('2026-09-18T10:05:00.000Z')
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

/**
 * IL CALCIO AL RUNNER — `caricato` non aspetta il cron.
 *
 * Il trigger che vede il file arrivare nello Storage porta il job in coda e calcia il runner da sé.
 * Il `PATCH caricato` del web è la RETE di quel trigger: idempotente (il runner risponde
 * «già sorvegliato» se c'è chi lavora) e, soprattutto, mai bloccante. Un calcio perso non deve costare
 * un arrivo: il job è in coda, il cron ogni cinque minuti lo ripesca.
 */
describe('PATCH /api/video-uploads/[id] — `caricato` calcia il runner', () => {
  const caricato = () =>
    richiestaPatch({ azione: 'caricato', jobId: JOB_1, byte: 812_345_678, mime: 'video/quicktime' })

  /** Risponde a ciascuna RPC per nome: la principale `ok`, il calcio come si decide nel test. */
  const rpcCon = (calcio: () => unknown) =>
    h.rpc.mockImplementation(async (nome: string) => {
      if (nome === 'video_runner_kick') return calcio()
      return { data: { ok: true }, error: null }
    })

  it('dopo `video_job_uploaded` chiama `video_runner_kick` con il job, e in quest’ordine', async () => {
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(200)
    expect(h.rpc.mock.calls.map(([nome]) => nome)).toEqual(['video_job_uploaded', 'video_runner_kick'])
    expect(h.rpc).toHaveBeenLastCalledWith('video_runner_kick', { p_job_id: JOB_1 })
    // Il successo si logga, col fatto che il runner è partito (solo uuid e un enumerato).
    const ev = eventi().find((c) => c[2]?.esito === 'azione-eseguita')
    expect(ev?.[2]).toMatchObject({ azione: 'caricato', intento: INTENT, runner: 'calciato' })
  })

  it('NON si calcia se il job non è entrato in coda (la RPC ha rifiutato): niente da sorvegliare', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'INTENT_INACTIVE' }, error: null })
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(409)
    expect(h.rpc.mock.calls.map(([nome]) => nome)).toEqual(['video_job_uploaded'])
  })

  it.each([
    ['conferma', { azione: 'conferma', revisione: 1 }],
    ['annulla', { azione: 'annulla', revisione: 1 }],
    ['annulla-job', { azione: 'annulla-job', jobId: JOB_1 }],
    ['riprova-pubblicazione', { azione: 'riprova-pubblicazione' }],
  ])('l’azione `%s` NON calcia il runner: è solo del `caricato`', async (_nome, corpo) => {
    h.intent = rigaIntent({ status: 'confirmed' })
    const res = await PATCH(richiestaPatch(corpo), params)
    expect(res.status).toBe(200)
    expect(h.rpc.mock.calls.map(([nome]) => nome)).not.toContain('video_runner_kick')
  })

  it.each([
    ['la funzione non c’è (DB non migrato)', () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }), 'warn', 'PGRST202'],
    ['manca l’URL del runner (configurazione)', () => ({ data: { ok: false, code: 'URL_ASSENTE' }, error: null }), 'error', 'URL_ASSENTE'],
    ['la POST non è partita', () => ({ data: { ok: false, code: 'POST_FALLITO' }, error: null }), 'error', 'POST_FALLITO'],
    ['un rifiuto qualunque', () => ({ data: { ok: false, code: 'BAD_INPUT' }, error: null }), 'warn', 'BAD_INPUT'],
  ] as const)('un calcio che fallisce — %s — NON fa fallire la risposta, e lascia un log', async (_perche, calcio, livello, codice) => {
    rpcCon(calcio)
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(200)
    expect((await res.json()).job[0].jobId).toBe(JOB_1)
    const fallito = eventi().filter((c) => c[2]?.esito === 'calcio-runner-non-riuscito')
    expect(fallito).toHaveLength(1)
    // Configurazione mancante è un incidente (`error`), mai una nota a piè di pagina (AGENTS §4).
    expect(fallito[0][1]).toBe(livello)
    expect(fallito[0][2]).toMatchObject({ error_code: codice, job: JOB_1 })
    expect(eventi().find((c) => c[2]?.esito === 'azione-eseguita')?.[2]).toMatchObject({ runner: 'fallito' })
  })

  it('un’eccezione dal calcio (la rete cade) NON solleva: 200, e due righe — quella aggregabile e quella con lo stack', async () => {
    rpcCon(() => {
      throw new Error('socket hang up')
    })
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(200)
    expect(eventi().filter((c) => c[2]?.esito === 'calcio-runner-non-riuscito')[0][2]).toMatchObject({ error_code: 'ECCEZIONE' })
    // L'errore VERO, con il suo stack, arriva a `logErrore` (un `Error` non si serializza con JSON: si legge il messaggio).
    expect(h.logErrore.mock.calls.some(([, e]) => e instanceof Error && e.message === 'socket hang up')).toBe(true)
  })

  it('`pg_net` assente (il DB della CI): non è un guasto, il corpo è quello di sempre e il log dice «non inviato»', async () => {
    rpcCon(() => ({ data: { ok: true, inviato: false, motivo: 'pg-net-assente' }, error: null }))
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(200)
    expect(eventi().some((c) => c[2]?.esito === 'calcio-runner-non-riuscito')).toBe(false)
    expect(eventi().find((c) => c[2]?.esito === 'azione-eseguita')?.[2]).toMatchObject({ runner: 'non-inviato' })
  })
})

/**
 * `SOURCE_CONFLICT` DOPO IL TRIGGER D'ARRIVO È UN SUCCESSO (secondario #69).
 *
 * `video_job_uploaded` su un job già in coda confronta `source_mime` con quello che il client manda ora:
 * il trigger ha scritto il tipo che ha letto dallo Storage, il `caricato` del web porta il `mime` del
 * suo `File` — spesso con il suffisso dei codec — e i due non coincidono carattere per carattere. Il
 * file però c'è, e il server lo sa: `arrivato_il`.
 */
describe('PATCH /api/video-uploads/[id] — `caricato` dopo il trigger d’arrivo', () => {
  const caricato = () =>
    richiestaPatch({ azione: 'caricato', jobId: JOB_1, byte: 812_345_678, mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' })

  const conflitto = () =>
    h.rpc.mockImplementation(async (nome: string) =>
      nome === 'video_job_uploaded' ? { data: { ok: false, code: 'SOURCE_CONFLICT' }, error: null } : { data: { ok: true }, error: null },
    )

  it('con `arrivato_il` già scritto è un SUCCESSO: 200 con lo stato, il runner calciato, e il motivo nel log', async () => {
    h.intent = rigaIntent({ status: 'confirmed' })
    h.job = [rigaJob({ status: 'queued', attempt: 0, arrivato_il: '2026-10-02T10:00:00.000Z' })]
    conflitto()
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.job[0]).toMatchObject({ jobId: JOB_1, stato: 'queued' })
    // Il calcio parte comunque: se quello del trigger si fosse perso, questa è la rete.
    expect(h.rpc.mock.calls.map(([nome]) => nome)).toEqual(['video_job_uploaded', 'video_runner_kick'])
    expect(eventi().find((c) => c[2]?.esito === 'azione-eseguita')?.[2]).toMatchObject({
      azione: 'caricato',
      tipo: 'arrivo-gia-registrato',
    })
    // Non è stato un «rifiuto»: nessuna riga `rpc-rifiutata`.
    expect(eventi().some((c) => c[2]?.esito === 'rpc-rifiutata')).toBe(false)
  })

  it('SENZA `arrivato_il` è un conflitto VERO: 409 «riprova», e nessun calcio', async () => {
    h.intent = rigaIntent({ status: 'confirmed' })
    h.job = [rigaJob({ status: 'queued', attempt: 0, arrivato_il: null })]
    conflitto()
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VIDEO_RIPROVA')
    expect(h.rpc.mock.calls.map(([nome]) => nome)).toEqual(['video_job_uploaded'])
    expect(eventi().find((c) => c[2]?.esito === 'rpc-rifiutata')?.[2]).toMatchObject({ error_code: 'SOURCE_CONFLICT' })
  })

  it('l’arrivo di UN ALTRO job dell’intento non basta: conta quello nominato dal `caricato`', async () => {
    // Un job proprio ma di un altro intento è già un 404; qui è un job dello STESSO intento con un arrivo
    // che non è quello nominato (una News con più allegati: gli arrivi sono per job).
    const ALTRO = '40000000-0000-4000-8000-0000000000bb'
    h.intent = rigaIntent({ status: 'confirmed' })
    h.job = [
      rigaJob({ status: 'queued', attempt: 0, arrivato_il: null }),
      rigaJob({ id: ALTRO, status: 'queued', attempt: 0, arrivato_il: '2026-10-02T10:00:00.000Z' }),
    ]
    conflitto()
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(409)
  })

  it('un conflitto su un’ALTRA azione, o con un altro codice, non cambia: resta un rifiuto', async () => {
    h.intent = rigaIntent({ status: 'confirmed' })
    h.job = [rigaJob({ status: 'queued', attempt: 0, arrivato_il: '2026-10-02T10:00:00.000Z' })]
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'INTENT_INACTIVE' }, error: null })
    expect((await PATCH(caricato(), params)).status).toBe(409)
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'SOURCE_CONFLICT' }, error: null })
    expect((await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)).status).toBe(409)
    // E anche un'azione che NOMINA un job (`annulla-job`) sul job che ha l'arrivo registrato: la regola è del solo
    // `caricato`, e la «riuscita» non si estende a un rifiuto che con l'arrivo del file non c'entra.
    expect((await PATCH(richiestaPatch({ azione: 'annulla-job', jobId: JOB_1 }), params)).status).toBe(409)
  })

  it('la rilettura dello stato rispetta il cancello: una sede non più propria nel frattempo ⇒ 403, e nessun calcio', async () => {
    h.intent = rigaIntent({ status: 'confirmed' })
    h.job = [rigaJob({ status: 'queued', attempt: 0, arrivato_il: '2026-10-02T10:00:00.000Z' })]
    // La prima lettura passa, la seconda (dopo il conflitto) trova la sede cambiata. Un contatore e non una
    // coda di `mockResolvedValueOnce`: una coda non consumata (un codice che non rilegge più) resterebbe nel
    // mock e farebbe cadere il test DOPO, con un rosso che non è il suo.
    let letture = 0
    h.scuoleDiUtente.mockImplementation(async () => (++letture === 1 ? [SEDE] : [ALTRA_SEDE]))
    conflitto()
    const res = await PATCH(caricato(), params)
    expect(res.status).toBe(403)
    expect(h.rpc.mock.calls.map(([nome]) => nome)).toEqual(['video_job_uploaded'])
  })
})

/**
 * IL «RIPROVA» DI UNA PUBBLICAZIONE FALLITA — solo l'autore, solo se la RPC dice che si può.
 */
describe('PATCH /api/video-uploads/[id] — `riprova-pubblicazione`', () => {
  const riprova = () => richiestaPatch({ azione: 'riprova-pubblicazione' })

  it('chiama `video_intent_pubblicazione_riprova` con l’intento dell’URL e il proprietario del GATE', async () => {
    h.intent = rigaIntent({ status: 'confirmed' })
    h.rpc.mockResolvedValue({ data: { ok: true, intent: { id: INTENT, status: 'confirmed' } }, error: null })
    const res = await PATCH(riprova(), params)
    expect(res.status).toBe(200)
    expect(h.rpc).toHaveBeenCalledWith('video_intent_pubblicazione_riprova', { p_intent_id: INTENT, p_owner_id: DOCENTE })
    // Risponde con lo stato rilevato DOPO: il client ha un parser solo.
    const corpo = await res.json()
    expect(corpo.statoIntent).toBe('confirmed')
    expect(corpo.job).toHaveLength(1)
    // E il successo ha il suo evento, quello del «Riprova».
    const ev = eventi().filter((c) => c[2]?.esito === 'pubblicazione-riprovata')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('info')
    expect(ev[0][2]).toMatchObject({ azione: 'riprova-pubblicazione', utente: DOCENTE, intento: INTENT })
  })

  it.each(['non-automatica', 'stato', 'minimizzato', 'job-non-pronti', 'uscita-rimossa', 'scaduto'])(
    '`RIPROVA_NON_POSSIBILE` (%s) ⇒ 409 con la frase «va cercato in galleria o ricaricato», e il motivo SOLO nel log',
    async (motivo) => {
      h.rpc.mockResolvedValue({ data: { ok: false, code: 'RIPROVA_NON_POSSIBILE', motivo }, error: null })
      const res = await PATCH(riprova(), params)
      expect(res.status).toBe(409)
      const corpo = await res.json()
      expect(corpo.codice).toBe('VIDEO_RIPROVA_NON_POSSIBILE')
      expect(JSON.stringify(corpo)).not.toContain(motivo)
      // Il codice INTERNO non esce come valore (`VIDEO_RIPROVA_NON_POSSIBILE` è quello mostrabile, e lo contiene come pezzo).
      expect(JSON.stringify(corpo)).not.toContain('"RIPROVA_NON_POSSIBILE"')
      const riga = eventi().find((c) => c[2]?.esito === 'rpc-rifiutata')
      expect(riga?.[1]).toBe('warn')
      expect(riga?.[2]).toMatchObject({ error_code: 'RIPROVA_NON_POSSIBILE', motivo, azione: 'riprova-pubblicazione' })
      // Nessun successo: il «Riprova» non è partito.
      expect(eventi().some((c) => c[2]?.esito === 'pubblicazione-riprovata')).toBe(false)
    },
  )

  it('un intento che non è mio ⇒ 404, e la RPC non si chiama nemmeno', async () => {
    h.intent = null
    const res = await PATCH(riprova(), params)
    expect(res.status).toBe(404)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('la sede non è più propria ⇒ 403: il cancello vale anche per il «Riprova»', async () => {
    h.scuoleDiUtente.mockResolvedValue([ALTRA_SEDE])
    const res = await PATCH(riprova(), params)
    expect(res.status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('`OWNER_MISMATCH` della RPC (l’autore non è chi chiama) ⇒ 403', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'OWNER_MISMATCH' }, error: null })
    const res = await PATCH(riprova(), params)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VIDEO_NON_AUTORIZZATO')
  })

  it('il corpo non ha altri campi: l’intento è quello dell’URL, e un `jobId` in più è respinto o ignorato, mai usato', async () => {
    h.rpc.mockResolvedValue({ data: { ok: true }, error: null })
    await PATCH(richiestaPatch({ azione: 'riprova-pubblicazione', jobId: JOB_ESTRANEO, p_owner_id: 'altro' }), params)
    expect(h.rpc).toHaveBeenCalledWith('video_intent_pubblicazione_riprova', { p_intent_id: INTENT, p_owner_id: DOCENTE })
    expect(JSON.stringify(h.rpc.mock.calls)).not.toContain(JOB_ESTRANEO)
  })

  it('NON esiste un’azione per cambiare i destinatari: i bambini si scelgono all’apertura', async () => {
    for (const corpo of [
      { azione: 'destinatari', tagAlunni: [] },
      { azione: 'tag', tagAlunni: [] },
    ]) {
      const res = await PATCH(richiestaPatch(corpo), params)
      expect(res.status).toBe(400)
    }
    expect(h.rpc).not.toHaveBeenCalled()
  })
})

/**
 * IL CODICE DA MOSTRARE DI UN JOB FALLITO — la regola #37, per Galleria e per News (secondari #28 e #54).
 *
 * Un job `failed` che si è ritentato (`attempt > 1`) è un guasto NOSTRO esaurito: legge «problema nostro»
 * qualunque fosse il codice tecnico dell'ultimo giro. Prima di questa regola `statoJob()` mandava il codice
 * dell'ultimo giro, e a chi aspettava un video dicevano «il file sembra rovinato» quando il guasto era la
 * rete fra noi e lo Storage. La regola sta in UN posto (`codiceMostrabileDelJob`) e la usano l'elenco, lo
 * stato e le notifiche: qui si prova che lo STATO la usi davvero, anche per un intento News (che al rientro
 * leggeva `VIDEO_RIPROVA` invece del codice vero: secondario #39).
 */
describe('GET /api/video-uploads/[id] — il codice di un job fallito passa dalla regola del contratto', () => {
  const stato = async (canale: 'gallery' | 'news', riga: Record<string, unknown>) => {
    h.intent = rigaIntent({ channel: canale, scuola_id: canale === 'news' ? SEDE : SEDE })
    h.job = [rigaJob({ channel: canale, ...riga })]
    const res = await GET(richiestaGet(), params)
    expect(res.status).toBe(200)
    return (await res.json()).job[0]
  }

  it.each(['gallery', 'news'] as const)(
    '%s: failed, ritentato (attempt 3), con il codice di un difetto del FILE ⇒ «problema nostro»',
    async (canale) => {
      for (const error_code of ['PROBE_COMMAND_FAILED', 'ENCODE_FAILED', 'CONVERSION_TIMEOUT', 'OUTPUT_DURATION_MISMATCH']) {
        const job = await stato(canale, { status: 'failed', attempt: 3, error_code })
        expect(job.codice, `${canale} ${error_code}`).toBe('VIDEO_GUASTO_NOSTRO')
        expect(JSON.stringify(job)).not.toContain(error_code)
      }
    },
  )

  it('lo stesso codice con UN SOLO tentativo resta quello del file: la regola scatta dal secondo giro', async () => {
    expect((await stato('news', { status: 'failed', attempt: 1, error_code: 'ENCODE_FAILED' })).codice).toBe(
      'VIDEO_CONVERSIONE_NON_RIUSCITA',
    )
    expect((await stato('news', { status: 'failed', attempt: 1, error_code: 'PROBE_COMMAND_FAILED' })).codice).toBe(
      'VIDEO_NON_LEGGIBILE',
    )
  })

  it('`rejected` NON si tocca mai, nemmeno ritentato: è il file, e il codice del suo difetto è l’unica cosa utile', async () => {
    expect((await stato('news', { status: 'rejected', attempt: 3, error_code: 'UNSUPPORTED_CONTAINER' })).codice).toBe(
      'VIDEO_FORMATO_NON_SUPPORTATO',
    )
    expect((await stato('gallery', { status: 'rejected', attempt: 2, error_code: 'ORIGINALE_DIVERSO' })).codice).toBe(
      'VIDEO_ORIGINALE_NON_COINCIDE',
    )
  })

  it('un job che non è fallito non porta un codice, qualunque cosa ci sia in `error_code`', async () => {
    for (const status of ['awaiting_upload', 'queued', 'processing', 'ready', 'cancelled']) {
      expect((await stato('news', { status, attempt: 3, error_code: 'ENCODE_FAILED' })).codice, status).toBeNull()
    }
  })

  it('anche la PATCH risponde col codice della regola: GET e PATCH hanno lo stesso corpo', async () => {
    h.intent = rigaIntent({ channel: 'news', status: 'confirmed' })
    h.job = [rigaJob({ channel: 'news', status: 'failed', attempt: 4, error_code: 'ENCODE_FAILED' })]
    const res = await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)
    expect((await res.json()).job[0].codice).toBe('VIDEO_GUASTO_NOSTRO')
  })
})

/**
 * COSA SI LEGGE E COSA ESCE — le colonne nuove servono alle azioni, non al corpo.
 */
describe('GET /api/video-uploads/[id] — le colonne della PR 2 non escono mai', () => {
  it('chiede il percorso, il tipo dichiarato e l’arrivo (servono alle azioni) e NON l’elenco dei bambini', async () => {
    await GET(richiestaGet(), params)
    const job = (h.colonneChieste.video_jobs ?? '').split(',').map((c) => c.trim())
    expect(job).toEqual(expect.arrayContaining(['original_path', 'mime_dichiarato', 'arrivato_il']))
    const intento = (h.colonneChieste.video_intents ?? '').split(',').map((c) => c.trim())
    // `tag_alunni` sono identificativi di minori: servono al pubblicatore, non a chi legge lo stato.
    expect(intento).not.toContain('tag_alunni')
    // Né l'hash del token di rinnovo né l'impronta dichiarata: non servono a nessuna azione di questa route.
    for (const c of ['rinnovo_token_hash', 'sha256_dichiarato', 'tag_alunni']) {
      expect([...job, ...intento]).not.toContain(c)
    }
  })

  it('il corpo di GET e di PATCH è costruito a mano: né il percorso dell’originale né il tipo dichiarato', async () => {
    const letto = JSON.stringify(await (await GET(richiestaGet(), params)).json())
    h.rpc.mockResolvedValue({ data: { ok: true }, error: null })
    const scritto = JSON.stringify(await (await PATCH(richiestaPatch({ azione: 'conferma', revisione: 1 }), params)).json())
    for (const corpo of [letto, scritto]) {
      expect(corpo).not.toContain('original_path')
      expect(corpo).not.toContain('0123456789abcdef')
      expect(corpo).not.toContain(DOCENTE)
      expect(corpo).not.toContain('mime_dichiarato')
      expect(corpo).not.toContain('arrivato_il')
    }
  })
})
