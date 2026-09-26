import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

/**
 * `POST /api/video-uploads` — la porta che APRE un caricamento video, e non ne
 * riceve un solo byte.
 *
 * ─── PERCHÉ QUESTA PORTA NON VEDE IL FILE ────────────────────────────────────
 * Il 2026-09-07, in produzione, `POST /api/gallery/upload` ha risposto **413 sei
 * volte in un giorno**: il corpo di una Function su Vercel si ferma a ~4,5 MB, e
 * il 413 lo scrive l'infrastruttura PRIMA che la funzione parta — quindi nei log
 * del server non restava niente. Qui gli originali arrivano a **2.000.000.000
 * byte**: farli passare di qui non è «lento», è impossibile. La route conia una
 * firma e il telefono spedisce i byte allo Storage per conto proprio, in TUS.
 *
 * ─── I DUE CANCELLI, CHE NON SI CONFONDONO ───────────────────────────────────
 * Questo file collauda il PRIMO. Il cancello **applicativo** — chi sei, in quale
 * sede stai scrivendo, con quale ambito — vive in TypeScript e riusa i presidi
 * che il repo ha già: `requireDocente`, `resolveScuolaScrittura`. Il cancello
 * **transazionale** — un solo vincitore, revisione corrente, target non
 * cambiato — vive dentro le RPC, ed è collaudato da `video-intents.test.ts` su
 * PGlite. Il ponte fra i due è che la route attraversa i gate e chiama la RPC
 * nella STESSA richiesta: se qualcosa è cambiato nel frattempo, rifiuta la RPC.
 *
 * Perciò qui si verifica ciò che solo qui si può verificare: che i gate ci siano,
 * che vengano PRIMA, e che ciò che la route passa alla RPC sia esattamente ciò
 * che i gate hanno deciso — non `user.scuola_id`, non un campo del client.
 *
 * ─── E CHE COSA ESCE VERSO UNA FAMIGLIA ──────────────────────────────────────
 * La pipeline produce sessantuno codici d'errore. `ORIGINAL_PATH_TAKEN` è il
 * vocabolario di un indice unico; a chi ha caricato il video della recita non
 * dice niente. Il contratto (`@/lib/media/video/contratto`) tiene due elenchi e
 * la mappa fra loro: qui si misura che dalla route esca solo il secondo.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rateLimit: vi.fn(),
  rpc: vi.fn(),
  createSignedUploadUrl: vi.fn(),
  info: vi.fn(),
  bucketFirmato: '' as string,
  percorsiFirmati: [] as string[],
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

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: h.rateLimit,
  clientIp: () => '1.2.3.4',
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    rpc: (nome: string, args: Record<string, unknown>) => h.rpc(nome, args),
    storage: {
      from: (bucket: string) => {
        h.bucketFirmato = bucket
        return {
          info: h.info,
          createSignedUploadUrl: (percorso: string) => {
            h.percorsiFirmati.push(percorso)
            return h.createSignedUploadUrl(percorso)
          },
        }
      },
    },
  }),
}))

import { POST } from '@/app/api/video-uploads/route'
import { BUCKET_ORIGINALI_VIDEO, schemaEsitoAperturaIntentVideo } from '@/lib/media/video/contratto'
import { SUPABASE_URL } from '@/lib/supabase/public-config'

/**
 * ⚠️ QUI IL BANCO DI PROVA E IL CONTRATTO SI CONTRADDICONO, ED È VOLUTO.
 *
 * `schemaEndpointSicuro` pretende `https://`, perché «un endpoint in chiaro
 * spedirebbe il video di un bambino su HTTP». `vitest.config.ts` invece impone
 * `NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321'`, e lo fa per una ragione
 * più grave: il ripiego hard-coded di `public-config.ts` punta al progetto di
 * PRODUZIONE, e senza quella riga ogni test che costruisce un client bersaglierebbe
 * il database con le domande d'iscrizione vere.
 *
 * Quindi in questo processo l'endpoint è http, e in produzione è https. Il
 * contratto si verifica su una copia con lo schema normalizzato — così TUTTO il
 * resto della risposta viene davvero controllato — e l'endpoint vero si controlla a
 * parte, confrontandolo con `SUPABASE_URL`. Normalizzare senza dirlo sarebbe il
 * modo di rendere verde un test che non guarda più niente.
 */
const conEndpointDiProduzione = (corpo: { job: { caricamento: { endpoint: string } }[] }) => {
  const copia = structuredClone(corpo)
  for (const j of copia.job) j.caricamento.endpoint = j.caricamento.endpoint.replace(/^http:/, 'https:')
  return copia
}

const SEDE = '10000000-0000-4000-8000-000000000001'
const DOCENTE = '20000000-0000-4000-8000-000000000002'
const INTENT = '30000000-0000-4000-8000-000000000003'
const JOB_1 = '40000000-0000-4000-8000-000000000004'
const JOB_2 = '40000000-0000-4000-8000-000000000005'
const JOB_3 = '40000000-0000-4000-8000-000000000006'

const richiesta = (corpo: unknown) =>
  ({
    url: 'http://test/api/video-uploads',
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => {
      h.corpoLetto += 1
      return corpo
    },
    text: async () => JSON.stringify(corpo),
    cookies: { get: () => undefined },
  }) as never

const file = (chiave: string, extra: Record<string, unknown> = {}) => ({
  chiaveIdempotenza: chiave,
  nome: 'recita-bambina-rossi.mov',
  byte: 812_345_678,
  mime: 'video/quicktime',
  durataSecondi: 96,
  ...extra,
})

const CORPO_GALLERIA = {
  canale: 'gallery',
  azione: 'publish',
  scuolaId: SEDE,
  ambitoGlobale: false,
  targetId: null,
  versioneTargetAttesa: null,
  file: [file('recita-1')],
}

/** La riga che `video_intent_open` restituisce dentro `{ ok: true, intent, job }`. */
const rigaIntent = (extra: Record<string, unknown> = {}) => ({
  id: INTENT,
  owner_id: DOCENTE,
  scuola_id: SEDE,
  channel: 'gallery',
  revision: 1,
  status: 'pending',
  ...extra,
})

const rigaJob = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  owner_id: DOCENTE,
  intent_id: INTENT,
  channel: 'gallery',
  status: 'awaiting_upload',
  original_bucket: BUCKET_ORIGINALI_VIDEO,
  original_path: `${DOCENTE}/${id}.mov`,
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.info.mockResolvedValue({ data: null, error: { status: 404 } })
  h.bucketFirmato = ''
  h.percorsiFirmati = []
  h.corpoLetto = 0
  h.requireDocente.mockResolvedValue({
    user: { id: DOCENTE, role: 'educator', scuola_id: 'sede-primaria-diversa' },
  })
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
  h.rateLimit.mockResolvedValue({ ok: true })
  h.rpc.mockImplementation(async (nome: string) => {
    if (nome === 'video_intent_open') {
      return { data: { ok: true, intent: rigaIntent(), job: rigaJob(JOB_1) }, error: null }
    }
    if (nome === 'video_intent_add_job') {
      return { data: { ok: true, job: rigaJob(JOB_2) }, error: null }
    }
    return { data: null, error: { code: 'PGRST202', message: 'funzione sconosciuta' } }
  })
  h.createSignedUploadUrl.mockResolvedValue({
    data: { signedUrl: 'https://storage.invalid/firmato', token: 'firma-tus', path: 'x' },
    error: null,
  })
})

describe('POST /api/video-uploads — l’apertura dell’intento', () => {
  it('apre l’intento e restituisce coordinate TUS che rispettano il contratto', async () => {
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(201)
    const corpo = await res.json()

    // Il contratto è l'autorità: se la risposta non lo soddisfa, il client di V10
    // non la sa leggere — e lo scoprirebbe su un telefono, non qui.
    const letto = schemaEsitoAperturaIntentVideo.safeParse(conEndpointDiProduzione(corpo))
    expect(letto.success, JSON.stringify(letto.error?.issues ?? [])).toBe(true)

    expect(corpo.intentId).toBe(INTENT)
    expect(corpo.revisione).toBe(1)
    expect(corpo.job).toHaveLength(1)
    expect(corpo.job[0].jobId).toBe(JOB_1)
    expect(corpo.job[0].chiaveIdempotenza).toBe('recita-1')
    expect(corpo.job[0].caricamento.protocollo).toBe('tus')
    expect(corpo.job[0].caricamento.bucket).toBe(BUCKET_ORIGINALI_VIDEO)
    // La rotta TUS FIRMATA, non la gemella col JWT di sessione: `storage.objects`
    // ha RLS accesa e zero policy, e quella gemella prende 403 al primo byte.
    // L'indirizzo si deriva da `SUPABASE_URL`, mai da un campo del client: un
    // endpoint scelto da chi chiama manderebbe il video di un bambino altrove.
    expect(corpo.job[0].caricamento.endpoint).toBe(`${SUPABASE_URL}/storage/v1/upload/resumable/sign`)
    expect(h.bucketFirmato).toBe(BUCKET_ORIGINALI_VIDEO)
  })

  it('la firma viaggia con le coordinate: senza, il client ha un indirizzo e nessuna chiave', async () => {
    const res = await POST(richiesta(CORPO_GALLERIA))
    const corpo = await res.json()
    // `x-signature` è ciò che fa passare l'upload fuori da RLS. Il contratto non
    // ha (ancora) un campo per portarla: qui si misura che ci sia comunque, e il
    // report di V07 chiede di aggiungerla a `schemaCoordinateCaricamentoVideo`.
    expect(corpo.job[0].firma).toBe('firma-tus')
  })

  it('il gate viene PRIMA del corpo: negato ⇒ nessuna lettura, nessuna RPC, nessuna firma', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(403)
    expect(h.corpoLetto).toBe(0)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('la SEDE che finisce nella RPC è quella del resolver, non `user.scuola_id`', async () => {
    const ALTRA = 'aaaaaaaa-0000-4000-8000-00000000000a'
    h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: ALTRA })
    await POST(richiesta(CORPO_GALLERIA))
    const [, args] = h.rpc.mock.calls[0]
    expect(args.p_scuola_id).toBe(ALTRA)
    expect(args.p_scuola_id).not.toBe('sede-primaria-diversa')
  })

  it('una sede dichiarata che non è propria ⇒ il rifiuto del resolver, e niente viene scritto', async () => {
    h.resolveScuolaScrittura.mockResolvedValue({
      response: NextResponse.json({ error: 'x', codice: 'SEDE_NON_ACCESSIBILE' }, { status: 403 }),
    })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('una Galleria SENZA sede non arriva nemmeno al resolver: la ferma il contratto', async () => {
    // Il 400 «specificare la sede» del resolver, su questa rotta, è irraggiungibile:
    // `schemaAperturaIntentVideo` pretende già una sede per tutto ciò che non sia
    // una News a ambito globale dichiarato. È una rete in più, non una di meno —
    // ma va misurata, altrimenti si finisce per credere che il presidio sia
    // l'altro. Nessuna riga senza sede può nascere da qui.
    const res = await POST(richiesta({ ...CORPO_GALLERIA, scuolaId: null }))
    expect(res.status).toBe(400)
    expect(h.resolveScuolaScrittura).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('due aperture con la stessa chiave chiedono lo STESSO originale', async () => {
    // Con un percorso a caso, il telefono che perde la rete e rispedisce la stessa
    // richiesta otterrebbe `IDEMPOTENCY_CONFLICT` da `video_intent_open` — «stessa
    // chiave, altro originale» — cioè il ritentativo, che è la ragione per cui la
    // chiave esiste, fallirebbe sempre.
    await POST(richiesta(CORPO_GALLERIA))
    const primo = h.rpc.mock.calls[0][1].p_original_path
    h.rpc.mockClear()
    await POST(richiesta(CORPO_GALLERIA))
    expect(h.rpc.mock.calls[0][1].p_original_path).toBe(primo)
  })

  it('il percorso dell’originale è intestato all’utente DEL GATE e non porta il nome del file', async () => {
    await POST(richiesta(CORPO_GALLERIA))
    const [, args] = h.rpc.mock.calls[0]
    // `video_intent_open` rifiuta con `ORIGINAL_PATH_SCOPE` un percorso che non
    // cominci con l'uuid del proprietario: qui si misura che la route non ci
    // arrivi mai, perché lo costruisce già così.
    expect(String(args.p_original_path).startsWith(`${DOCENTE}/`)).toBe(true)
    // `recita-bambina-rossi.mov` è il nome di un minore. Del nome serve solo
    // l'estensione, e quella si ricava dal MIME validato.
    expect(String(args.p_original_path)).not.toContain('bambina')
    expect(String(args.p_original_path)).not.toContain('rossi')
    expect(String(args.p_original_path)).toMatch(/\.mov$/)
    expect(h.percorsiFirmati[0]).toBe(args.p_original_path)
  })

  it('la chiave di idempotenza del client arriva intatta alla RPC', async () => {
    await POST(richiesta(CORPO_GALLERIA))
    const [, args] = h.rpc.mock.calls[0]
    expect(args.p_idempotency_key).toBe('recita-1')
    expect(args.p_owner_id).toBe(DOCENTE)
    expect(args.p_channel).toBe('gallery')
    expect(args.p_requested_action).toBe('publish')
  })

  it('una News con tre allegati: un `open` e DUE `add_job`, tutti sullo stesso intento', async () => {
    h.rpc.mockImplementation(async (nome: string, args: Record<string, unknown>) => {
      if (nome === 'video_intent_open') {
        return {
          data: { ok: true, intent: rigaIntent({ channel: 'news' }), job: rigaJob(JOB_1) },
          error: null,
        }
      }
      if (nome === 'video_intent_add_job') {
        const id = args.p_idempotency_key === 'n-2' ? JOB_2 : JOB_3
        return { data: { ok: true, job: rigaJob(id) }, error: null }
      }
      return { data: null, error: { code: 'PGRST202', message: 'x' } }
    })

    const res = await POST(
      richiesta({
        ...CORPO_GALLERIA,
        canale: 'news',
        azione: 'submit_proposal',
        file: [file('n-1'), file('n-2'), file('n-3')],
      }),
    )
    expect(res.status).toBe(201)
    const nomi = h.rpc.mock.calls.map(([n]) => n)
    expect(nomi).toEqual(['video_intent_open', 'video_intent_add_job', 'video_intent_add_job'])

    // La revisione che `add_job` riceve è quella dell'intento appena aperto: un
    // numero inventato qui uscirebbe come `REVISION_MISMATCH` e la News resterebbe
    // con un allegato solo.
    for (const [nome, args] of h.rpc.mock.calls.slice(1)) {
      expect(nome).toBe('video_intent_add_job')
      expect(args.p_intent_id).toBe(INTENT)
      expect(args.p_revision).toBe(1)
    }
    expect((await res.json()).job).toHaveLength(3)
    expect(h.createSignedUploadUrl).toHaveBeenCalledTimes(3)
  })

  it('l’ambito globale non è per chi insegna: 403, e nessuna riga senza sede', async () => {
    const res = await POST(
      richiesta({
        ...CORPO_GALLERIA,
        canale: 'news',
        azione: 'submit_proposal',
        scuolaId: null,
        ambitoGlobale: true,
      }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VIDEO_NON_AUTORIZZATO')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('l’ambito globale dalla Direzione: `scuola_id` NULL e `scope: global` nel payload', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE } })
    h.rpc.mockImplementation(async () => ({
      data: { ok: true, intent: rigaIntent({ channel: 'news', scuola_id: null }), job: rigaJob(JOB_1) },
      error: null,
    }))
    const res = await POST(
      richiesta({
        ...CORPO_GALLERIA,
        canale: 'news',
        azione: 'submit_proposal',
        scuolaId: null,
        ambitoGlobale: true,
      }),
    )
    expect(res.status).toBe(201)
    const [, args] = h.rpc.mock.calls[0]
    expect(args.p_scuola_id).toBeNull()
    // `video_intents_scuola_scope_chk` ammette la sede NULL solo se il payload
    // dichiara `scope = 'global'`: senza, il CHECK respinge con un 23514 anonimo.
    expect((args.p_payload as Record<string, unknown>).scope).toBe('global')
    // E il resolver di sede non è nemmeno stato interrogato: non c'è sede da
    // risolvere, e chiamarlo avrebbe prodotto un 400 «specificare la sede».
    expect(h.resolveScuolaScrittura).not.toHaveBeenCalled()
  })

  it('una Galleria con due video ⇒ 400 del contratto, prima di qualunque scrittura', async () => {
    const res = await POST(richiesta({ ...CORPO_GALLERIA, file: [file('g-1'), file('g-2')] }))
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('il codice INTERNO della RPC non esce: esce quello che una famiglia può leggere', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'ORIGINAL_PATH_TAKEN' }, error: null })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VIDEO_RIPROVA')
    expect(JSON.stringify(corpo)).not.toContain('ORIGINAL_PATH_TAKEN')
  })

  it('`OWNER_MISMATCH` della RPC diventa 403, non un 409 qualunque', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'OWNER_MISMATCH' }, error: null })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VIDEO_NON_AUTORIZZATO')
  })

  it('la pipeline non installata ⇒ 503 pulito, non un 500 con lo stack', async () => {
    // Le due migrazioni video sono dichiarate IN_CODA: sul DB E2E della CI le RPC
    // non esistono, e PostgREST risponde `PGRST202`. Un 500 qui farebbe cadere la
    // suite raccontando un guasto che non c'è.
    h.rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('la firma non riuscita ⇒ 500 con codice, e il motivo del fornitore NON esce', async () => {
    h.createSignedUploadUrl.mockResolvedValue({
      data: null,
      error: { message: 'Bucket not found: video_originals' },
    })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(JSON.stringify(corpo)).not.toContain('Bucket not found')
  })

  it('troppe aperture di fila ⇒ 429, e nessuna firma da 2 GB emessa', async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 30_000 })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
})


describe('riapertura video · stato autorevole e originali già trasferiti', () => {
  it('originale completo dopo risposta TUS persa: nessuna firma o sovrascrittura', async () => {
    h.info.mockResolvedValue({ data: { size: CORPO_GALLERIA.file[0].byte }, error: null })
    const res = await POST(richiesta(CORPO_GALLERIA))
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.intent.status).toBe('pending')
    expect(body.job[0]).toMatchObject({ status: 'awaiting_upload', needs_upload: false, firma: '', expires_at: null })
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
  it.each(['queued', 'processing', 'ready', 'failed', 'rejected', 'cancelled'])('job %s non autorizza un nuovo trasferimento', async status => {
    h.rpc.mockResolvedValue({ data: { ok: true, intent: rigaIntent({ status: 'confirmed' }), job: rigaJob(JOB_1, { status }) }, error: null })
    const body = await (await POST(richiesta(CORPO_GALLERIA))).json()
    expect(body.job[0]).toMatchObject({ status, needs_upload: false, firma: '' })
    expect(h.info).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
  it.each(['published', 'cancelled', 'superseded'])('intento %s non emette firme anche per un job rimasto awaiting_upload', async status => {
    h.rpc.mockResolvedValue({ data: { ok: true, intent: rigaIntent({ status }), job: rigaJob(JOB_1) }, error: null })
    const body = await (await POST(richiesta(CORPO_GALLERIA))).json()
    expect(body.intent.status).toBe(status)
    expect(body.job[0].needs_upload).toBe(false)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
  it('firma nuova con scadenza esplicita quando l’originale è assente', async () => {
    const body = await (await POST(richiesta(CORPO_GALLERIA))).json()
    expect(body.job[0]).toMatchObject({ needs_upload: true, status: 'awaiting_upload' })
    expect(Date.parse(body.job[0].expires_at)).toBeGreaterThan(Date.now())
  })
  it('originale con dimensione diversa: rifiuto, nessuna firma', async () => {
    h.info.mockResolvedValue({ data: { size: 123 }, error: null })
    expect((await POST(richiesta(CORPO_GALLERIA))).status).toBe(409)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
  it('guasto lettura Storage non diventa una nuova firma', async () => {
    h.info.mockResolvedValue({ data: null, error: { status: 503, message: 'temporary' } })
    expect((await POST(richiesta(CORPO_GALLERIA))).status).toBe(500)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
})
