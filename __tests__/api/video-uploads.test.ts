import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
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
 *
 * ─── DAL 2026-10-02: I BAMBINI SI SCELGONO PRIMA ─────────────────────────────
 * Un video di Galleria porta i suoi `destinatari` all'apertura, attraversa gli STESSI quattro
 * cancelli di `POST /api/gallery` (qui provati contro la route vera, a parità di ingresso) e nasce
 * confermato (`video_galleria_intent_apri`). Senza destinatari è un client col JS vecchio: 409.
 * Con il trasporto nativo l'apertura restituisce un URL di PUT firmato SENZA upsert e il token di
 * rinnovo — che non entra mai in un log.
 */

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  rateLimit: vi.fn(),
  rpc: vi.fn(),
  createSignedUploadUrl: vi.fn(),
  info: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  bucketFirmato: '' as string,
  percorsiFirmati: [] as string[],
  opzioniFirma: [] as unknown[],
  corpoLetto: 0,
  /** I bambini del finto database, per i cancelli (tag nella sede, liberatoria). */
  alunni: [] as Array<Record<string, unknown>>,
  /** Quante volte il finto database è stato interrogato sulla tabella `alunni`. */
  lettureAlunni: 0,
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

// Si spiano SOLO i due logger di dominio (il resto resta reale e silenzioso sotto VITEST): serve a
// leggere che cosa le route decidono di registrare, e a provare che non sia mai un dato personale.
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
  createAdminClient: async () => ({
    rpc: (nome: string, args: Record<string, unknown>) => h.rpc(nome, args),
    storage: {
      from: (bucket: string) => {
        h.bucketFirmato = bucket
        return {
          info: h.info,
          createSignedUploadUrl: (percorso: string, opzioni?: unknown) => {
            h.percorsiFirmati.push(percorso)
            h.opzioniFirma.push(opzioni)
            return h.createSignedUploadUrl(percorso)
          },
        }
      },
    },
    // Il finto database dei cancelli della Galleria: SOLO `alunni`, e con i filtri `.in()` ACCUMULATI come
    // fa PostgREST (`.in('id', tag).in('scuola_id', sedi)` sono in AND). Un finto che ignorasse il filtro di
    // sede sarebbe verde anche per un bambino di un altro plesso: è esattamente il difetto che prova.
    from(tabella: string) {
      const b: Record<string, unknown> = {}
      b.select = () => {
        if (tabella === 'alunni') h.lettureAlunni += 1
        return b
      }
      b.eq = () => b
      b.order = () => b
      b.or = () => b
      b.range = () => b
      b.not = () => b
      const filtri: Record<string, Set<string>> = {}
      b.in = (colonna: string, valori: string[]) => {
        filtri[colonna] = new Set(valori ?? [])
        const righe = (tabella === 'alunni' ? h.alunni : []).filter((r) =>
          Object.entries(filtri).every(([c, ammessi]) => ammessi.has(String((r as Record<string, unknown>)[c] ?? ''))),
        )
        const b2 = { ...b } as Record<string, unknown>
        b2.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: righe, error: null }).then(res)
        return b2
      }
      b.maybeSingle = async () => ({ data: null, error: null })
      return b
    },
  }),
}))

import { POST } from '@/app/api/video-uploads/route'
import { POST as POST_GALLERY } from '@/app/api/gallery/route'
import {
  BUCKET_ORIGINALI_VIDEO,
  schemaEsitoAperturaIntentVideo,
  schemaRispostaAperturaVideo,
  schemaTokenRinnovoVideo,
} from '@/lib/media/video/contratto'
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
const conEndpointDiProduzione = (corpo: { job: { caricamento: { endpoint?: string; protocollo?: string } }[] }) => {
  const copia = structuredClone(corpo)
  for (const j of copia.job) {
    if (j.caricamento.protocollo === 'tus' && j.caricamento.endpoint) {
      j.caricamento.endpoint = j.caricamento.endpoint.replace(/^http:/, 'https:')
    }
  }
  return copia
}

const SEDE = '10000000-0000-4000-8000-000000000001'
const ALTRA_SEDE_ALUNNO = '10000000-0000-4000-8000-0000000000aa'
const DOCENTE = '20000000-0000-4000-8000-000000000002'
const INTENT = '30000000-0000-4000-8000-000000000003'
const JOB_1 = '40000000-0000-4000-8000-000000000004'
const JOB_2 = '40000000-0000-4000-8000-000000000005'
const JOB_3 = '40000000-0000-4000-8000-000000000006'
const ALUNNO_A = 'aaaaaaaa-1111-4111-8111-11111111111a'
const ALUNNO_B = 'bbbbbbbb-1111-4111-8111-11111111111b'
const ALUNNO_ALTRA_SEDE = 'cccccccc-1111-4111-8111-11111111111c'
const IMPRONTA = 'ab'.repeat(32)

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

const DESTINATARI = { tagAlunni: [ALUNNO_A], broadcast: false, classi: [] as string[] }

/** L'apertura di un video di GALLERIA, come la manda il client nuovo: con i bambini scelti prima. */
const CORPO_GALLERIA = {
  canale: 'gallery',
  azione: 'publish',
  scuolaId: SEDE,
  ambitoGlobale: false,
  targetId: null,
  versioneTargetAttesa: null,
  file: [file('recita-1')],
  destinatari: DESTINATARI,
}

/** L'apertura di una News: nessun destinatario, mai. */
const CORPO_NEWS = {
  canale: 'news',
  azione: 'submit_proposal',
  scuolaId: SEDE,
  ambitoGlobale: false,
  targetId: null,
  versioneTargetAttesa: null,
  file: [file('news-1')],
}

/** La riga che `video_intent_open` e `video_galleria_intent_apri` restituiscono dentro `{ ok: true, intent, job }`. */
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

/** L'esito di `video_galleria_intent_apri`: l'intento nasce già confermato, e dice se era una ripetizione. */
const esitoGalleria = (extra: Record<string, unknown> = {}, intent: Record<string, unknown> = {}, job: Record<string, unknown> = {}) => ({
  ok: true,
  intent: rigaIntent({ status: 'confirmed', ...intent }),
  job: rigaJob(JOB_1, job),
  ripetuta: false,
  token_ruotato: false,
  ...extra,
})

/** Gli eventi di dominio della Galleria (via il rumore di `route` di `withRoute`). */
const eventiGalleria = () => h.logEvento.mock.calls.filter((c) => c[0] === 'galleria')

/** Tutto ciò che le route hanno depositato nei log, come testo: serve a cercarvi cose che NON devono esserci. */
const tuttoIlLog = () => JSON.stringify([h.logEvento.mock.calls, h.logErrore.mock.calls])

beforeEach(() => {
  vi.clearAllMocks()
  h.info.mockResolvedValue({ data: null, error: { status: 404 } })
  h.bucketFirmato = ''
  h.percorsiFirmati = []
  h.opzioniFirma = []
  h.corpoLetto = 0
  h.lettureAlunni = 0
  h.requireDocente.mockResolvedValue({
    user: { id: DOCENTE, role: 'educator', scuola_id: 'sede-primaria-diversa' },
  })
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
  h.rateLimit.mockResolvedValue({ ok: true })
  // I bambini del finto database: due della sede (uno con liberatoria, uno senza) e uno di un ALTRO plesso.
  h.alunni = [
    { id: ALUNNO_A, nome: 'Ada', cognome: 'Rossi', consenso_privacy: true, scuola_id: SEDE },
    { id: ALUNNO_B, nome: 'Bea', cognome: 'Verdi', consenso_privacy: false, scuola_id: SEDE },
    { id: ALUNNO_ALTRA_SEDE, nome: 'Cleo', cognome: 'Neri', consenso_privacy: true, scuola_id: ALTRA_SEDE_ALUNNO },
  ]
  h.rpc.mockImplementation(async (nome: string) => {
    if (nome === 'video_galleria_intent_apri') {
      return { data: esitoGalleria(), error: null }
    }
    if (nome === 'video_intent_open') {
      return { data: { ok: true, intent: rigaIntent(), job: rigaJob(JOB_1) }, error: null }
    }
    if (nome === 'video_intent_add_job') {
      return { data: { ok: true, job: rigaJob(JOB_2) }, error: null }
    }
    return { data: null, error: { code: 'PGRST202', message: 'funzione sconosciuta' } }
  })
  h.createSignedUploadUrl.mockResolvedValue({
    data: { signedUrl: 'https://storage.invalid/firmato?token=segreto-di-firma', token: 'firma-tus', path: 'x' },
    error: null,
  })
})

describe('POST /api/video-uploads — l’apertura dell’intento', () => {
  it('apre l’intento e restituisce coordinate TUS che rispettano il contratto', async () => {
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(201)
    const corpo = await res.json()

    // Il contratto è l'autorità: se la risposta non lo soddisfa, il client di V10 non la sa leggere — e lo
    // scoprirebbe su un telefono, non qui. Vale per lo schema di prima E per quello esteso (sovrainsieme).
    const letto = schemaEsitoAperturaIntentVideo.safeParse(conEndpointDiProduzione(corpo))
    expect(letto.success, JSON.stringify(letto.error?.issues ?? [])).toBe(true)
    const esteso = schemaRispostaAperturaVideo.safeParse(conEndpointDiProduzione(corpo))
    expect(esteso.success, JSON.stringify(esteso.error?.issues ?? [])).toBe(true)

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
    // Un TUS non ha un token di rinnovo: la firma si rinnova con `[id]/firma`.
    expect(corpo.job[0].rinnovo).toBeUndefined()
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
    // I bambini sono della sede del RESOLVER: se la sede passata alla RPC fosse un'altra la route avrebbe
    // già rifiutato il tag, quindi qui il resolver restituisce una sede in cui i bambini ci sono.
    const ALTRA = 'aaaaaaaa-0000-4000-8000-00000000000a'
    h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: ALTRA })
    h.alunni = [{ id: ALUNNO_A, nome: 'Ada', cognome: 'Rossi', consenso_privacy: true, scuola_id: ALTRA }]
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
    // E i cancelli dei bambini non sono nemmeno stati interrogati: senza una sede non c'è un perimetro.
    expect(h.lettureAlunni).toBe(0)
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
    // richiesta otterrebbe `IDEMPOTENCY_CONFLICT` dalla RPC — «stessa chiave, altro
    // originale» — cioè il ritentativo, che è la ragione per cui la chiave esiste,
    // fallirebbe sempre.
    await POST(richiesta(CORPO_GALLERIA))
    const primo = h.rpc.mock.calls[0][1].p_original_path
    h.rpc.mockClear()
    await POST(richiesta(CORPO_GALLERIA))
    expect(h.rpc.mock.calls[0][1].p_original_path).toBe(primo)
  })

  it('il percorso dell’originale è intestato all’utente DEL GATE e non porta il nome del file', async () => {
    await POST(richiesta(CORPO_GALLERIA))
    const [, args] = h.rpc.mock.calls[0]
    // La RPC rifiuta con `ORIGINAL_PATH_SCOPE` un percorso che non cominci con l'uuid del proprietario: qui
    // si misura che la route non ci arrivi mai, perché lo costruisce già così.
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
    const [nome, args] = h.rpc.mock.calls[0]
    expect(nome).toBe('video_galleria_intent_apri')
    expect(args.p_idempotency_key).toBe('recita-1')
    expect(args.p_owner_id).toBe(DOCENTE)
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
        ...CORPO_NEWS,
        file: [file('n-1'), file('n-2'), file('n-3')],
      }),
    )
    expect(res.status).toBe(201)
    const nomi = h.rpc.mock.calls.map(([n]) => n)
    expect(nomi).toEqual(['video_intent_open', 'video_intent_add_job', 'video_intent_add_job'])

    // `video_intent_open` per la News porta ancora il canale e l'azione di sempre (la RPC della Galleria no).
    const [, apertura] = h.rpc.mock.calls[0]
    expect(apertura.p_channel).toBe('news')
    expect(apertura.p_requested_action).toBe('submit_proposal')

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
    // Le News non hanno bambini: nessun cancello dei destinatari è stato attraversato.
    expect(h.lettureAlunni).toBe(0)
  })

  it('l’ambito globale non è per chi insegna: 403, e nessuna riga senza sede', async () => {
    const res = await POST(
      richiesta({
        ...CORPO_NEWS,
        scuolaId: null,
        ambitoGlobale: true,
      }),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('VIDEO_NON_AUTORIZZATO')
    expect(h.rpc).not.toHaveBeenCalled()
    // Un accesso negato a un perimetro più largo del proprio è un segnale: `warn`, col ruolo, e solo uuid.
    const negato = h.logEvento.mock.calls.find((c) => c[0] === 'news' && c[2]?.esito === 'ambito-globale-negato')
    expect(negato?.[1]).toBe('warn')
    expect(negato?.[2]).toMatchObject({ operazione: 'video-uploads:POST', tipo: 'apertura-globale', utente: DOCENTE, ruolo: 'educator' })
  })

  it('l’ambito globale dalla Direzione: `scuola_id` NULL e `scope: global` nel payload', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE } })
    h.rpc.mockImplementation(async () => ({
      data: { ok: true, intent: rigaIntent({ channel: 'news', scuola_id: null }), job: rigaJob(JOB_1) },
      error: null,
    }))
    const res = await POST(
      richiesta({
        ...CORPO_NEWS,
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

  it('`IDEMPOTENCY_CONFLICT` (stessa chiave, altri destinatari) ⇒ 409 «riprova», senza il nome della RPC', async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'IDEMPOTENCY_CONFLICT' }, error: null })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('VIDEO_RIPROVA')
    expect(JSON.stringify(corpo)).not.toContain('IDEMPOTENCY')
  })

  it('il rifiuto della RPC nomina NEL LOG quella che ha rifiutato: `video_galleria_intent_apri` per la Galleria, `video_intent_open` per le News', async () => {
    // Il nome sta nel log e mai nella risposta: è ciò che dice, a chi indaga, QUALE delle due porte ha detto no
    // (la prima ha i destinatari e la conferma, la seconda no). Un'etichetta sbagliata manderebbe a leggere la funzione sbagliata.
    h.rpc.mockResolvedValue({ data: { ok: false, code: 'IDEMPOTENCY_CONFLICT' }, error: null })
    await POST(richiesta(CORPO_GALLERIA))
    const galleria = eventiGalleria().find((c) => c[2]?.esito === 'rpc-rifiutata')
    expect(galleria?.[1]).toBe('warn')
    expect(galleria?.[2]).toMatchObject({
      operazione: 'video-uploads:POST',
      tipo: 'video_galleria_intent_apri',
      error_code: 'IDEMPOTENCY_CONFLICT',
      utente: DOCENTE,
    })

    await POST(richiesta(CORPO_NEWS))
    const news = h.logEvento.mock.calls.find((c) => c[0] === 'news' && c[2]?.esito === 'rpc-rifiutata')
    expect(news?.[2]).toMatchObject({ operazione: 'video-uploads:POST', tipo: 'video_intent_open', error_code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('la pipeline non installata ⇒ 503 pulito, non un 500 con lo stack', async () => {
    // Le migrazioni video sono dichiarate IN_CODA: sul DB E2E della CI le RPC
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
    // Ma il motivo resta nel LOG, che è dove si diagnostica: un `403` senza il suo corpo non dice niente.
    expect(JSON.stringify(h.logErrore.mock.calls)).toContain('Bucket not found')
  })

  it('troppe aperture di fila ⇒ 429, e nessuna firma da 2 GB emessa', async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 30_000 })
    const res = await POST(richiesta(CORPO_GALLERIA))
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('il tetto è 30 aperture ogni 10 minuti PER UTENTE (invariato dalla PR 2): la chiave e i numeri', async () => {
    await POST(richiesta(CORPO_GALLERIA))
    expect(h.rateLimit).toHaveBeenCalledTimes(1)
    expect(h.rateLimit).toHaveBeenCalledWith(`video-uploads:${DOCENTE}`, { limit: 30, windowMs: 10 * 60 * 1000 })
  })
})

describe('riapertura video · stato autorevole e originali già trasferiti', () => {
  it('originale completo dopo risposta TUS persa: nessuna firma o sovrascrittura', async () => {
    h.info.mockResolvedValue({ data: { size: CORPO_GALLERIA.file[0].byte }, error: null })
    const res = await POST(richiesta(CORPO_GALLERIA))
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.intent.status).toBe('confirmed')
    expect(body.job[0]).toMatchObject({ status: 'awaiting_upload', needs_upload: false, firma: '', expires_at: null })
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
  it.each(['queued', 'processing', 'ready', 'failed', 'rejected', 'cancelled'])('job %s non autorizza un nuovo trasferimento', async status => {
    h.rpc.mockResolvedValue({ data: esitoGalleria({ ripetuta: true }, {}, { status }), error: null })
    const body = await (await POST(richiesta(CORPO_GALLERIA))).json()
    expect(body.job[0]).toMatchObject({ status, needs_upload: false, firma: '' })
    expect(h.info).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })
  it.each(['published', 'cancelled', 'superseded'])('intento %s non emette firme anche per un job rimasto awaiting_upload', async status => {
    h.rpc.mockResolvedValue({ data: esitoGalleria({ ripetuta: true }, { status }), error: null })
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

describe('POST /api/video-uploads — la Galleria porta i suoi destinatari', () => {
  it('`video_galleria_intent_apri` riceve TUTTO: i bambini, il broadcast, le classi, i dichiarati', async () => {
    const res = await POST(
      richiesta({
        ...CORPO_GALLERIA,
        destinatari: { tagAlunni: [ALUNNO_A.toUpperCase()], broadcast: false, classi: [] },
      }),
    )
    expect(res.status).toBe(201)
    const [nome, args] = h.rpc.mock.calls[0]
    expect(nome).toBe('video_galleria_intent_apri')
    expect(args).toMatchObject({
      p_owner_id: DOCENTE,
      p_scuola_id: SEDE,
      p_idempotency_key: 'recita-1',
      p_byte: 812_345_678,
      p_mime: 'video/quicktime',
      p_durata_s: 96,
      // Minuscoli e senza doppioni (lo schema li normalizza); i cancelli li hanno visti come tali.
      p_tag_alunni: [ALUNNO_A],
      p_broadcast: false,
      p_classi: [],
      p_trasporto: 'tus',
      // Il TUS non ha né impronta né token: la RPC rifiuterebbe una promessa che nessuno verifica.
      p_sha256: null,
      p_token_hash: null,
      p_token_scade_il: null,
    })
    // E NON ha più il canale né l'azione: quelle sono di `video_intent_open`.
    expect(args).not.toHaveProperty('p_channel')
    expect(args).not.toHaveProperty('p_requested_action')
  })

  it('la durata dichiarata `null` arriva come `null`, non come 0 (il probe fa la misura vera)', async () => {
    await POST(richiesta({ ...CORPO_GALLERIA, file: [file('recita-1', { durataSecondi: null })] }))
    expect(h.rpc.mock.calls[0][1].p_durata_s).toBeNull()
  })

  it('un broadcast della Direzione, senza bambini, passa: bambini vuoti e `p_broadcast` vero', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'admin', scuola_id: SEDE } })
    const res = await POST(
      richiesta({
        ...CORPO_GALLERIA,
        destinatari: { tagAlunni: [], broadcast: true, classi: ['A - Primavera', 'A - Primavera', 'B'] },
      }),
    )
    expect(res.status).toBe(201)
    const [, args] = h.rpc.mock.calls[0]
    expect(args.p_broadcast).toBe(true)
    expect(args.p_tag_alunni).toEqual([])
    // Le classi arrivano dal cancello: senza doppioni.
    expect(args.p_classi).toEqual(['A - Primavera', 'B'])
  })

  it('SENZA destinatari è un client col JS vecchio: 409 `VIDEO_APP_DA_AGGIORNARE`, nessuna lettura, nessuna RPC', async () => {
    const { destinatari: _tolto, ...senza } = CORPO_GALLERIA
    void _tolto
    const res = await POST(richiesta(senza))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('VIDEO_APP_DA_AGGIORNARE')
    // Prima di OGNI lettura: la risposta non dipende da ciò che sede o cancelli direbbero.
    expect(h.resolveScuolaScrittura).not.toHaveBeenCalled()
    expect(h.lettureAlunni).toBe(0)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    // Il giorno del rilascio bisogna poter dire QUANTI client parlano ancora la lingua vecchia: `warn`, solo l'uuid.
    const ev = eventiGalleria().filter((c) => c[2]?.esito === 'apertura-flusso-vecchio-rifiutata')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('warn')
    expect(ev[0][2]).toMatchObject({
      operazione: 'video-uploads:POST',
      esito: 'apertura-flusso-vecchio-rifiutata',
      error_code: 'CLIENT_UPDATE_REQUIRED',
      utente: DOCENTE,
    })
    // E con `distingui` sull'utente: `app_log` conserva il contesto della PRIMA occorrenza del giorno.
    expect(ev[0][4]).toEqual({ distingui: ['utente'] })
    expect(JSON.stringify(ev[0])).not.toContain('recita-bambina-rossi')
  })

  it('una News NON è un client vecchio: senza destinatari passa (e il 409 vale solo per la Galleria)', async () => {
    const res = await POST(richiesta(CORPO_NEWS))
    expect(res.status).toBe(201)
    expect(eventiGalleria().some((c) => c[2]?.esito === 'apertura-flusso-vecchio-rifiutata')).toBe(false)
  })

  it('un video di Galleria senza bambini e senza broadcast ⇒ 400 `VIDEO_DESTINATARI_MANCANTI`, prima della sede', async () => {
    const res = await POST(richiesta({ ...CORPO_GALLERIA, destinatari: {} }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('VIDEO_DESTINATARI_MANCANTI')
    expect(h.resolveScuolaScrittura).not.toHaveBeenCalled()
    expect(h.rpc).not.toHaveBeenCalled()
    const ev = eventiGalleria().filter((c) => c[2]?.esito === 'destinatari-mancanti')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('warn')
  })

  it('il successo si logga con il NUMERO dei bambini, il broadcast e il trasporto — mai un nome, mai un id', async () => {
    const ok = await POST(richiesta(CORPO_GALLERIA))
    expect(ok.status).toBe(201)
    const aperto = eventiGalleria().filter((c) => c[2]?.esito === 'intento-aperto')
    expect(aperto).toHaveLength(1)
    expect(aperto[0][1]).toBe('info')
    expect(aperto[0][2]).toMatchObject({
      operazione: 'video-uploads:POST',
      esito: 'intento-aperto',
      canale: 'gallery',
      utente: DOCENTE,
      // `tipo` è una chiave della lista bianca di `redact`: sopravvive in tabella, e si può contare.
      tipo: 'tus',
      n_tag: 1,
      broadcast: false,
      video: 1,
    })
    const testo = tuttoIlLog()
    for (const vietato of [ALUNNO_A, ALUNNO_B, 'Ada', 'Bea', 'Rossi', 'Verdi', 'recita-bambina']) {
      expect(testo, `«${vietato}» nel log`).not.toContain(vietato)
    }
  })

  it('una RIPETIZIONE della stessa apertura lo dice nel log (`ripetuta`), e la prima apertura no', async () => {
    // Serve a distinguere, sul campo, un telefono che ripete perché ha perso la risposta da un'apertura nuova: «190 aperture per
    // 44 job» si è scoperto solo contando a mano.
    await POST(richiesta(CORPO_GALLERIA))
    h.rpc.mockResolvedValue({ data: esitoGalleria({ ripetuta: true }), error: null })
    await POST(richiesta(CORPO_GALLERIA))
    const aperti = eventiGalleria().filter((c) => c[2]?.esito === 'intento-aperto')
    expect(aperti).toHaveLength(2)
    expect(aperti[0][2]).not.toHaveProperty('ripetuta', true)
    expect(aperti[1][2]).toMatchObject({ ripetuta: true })
  })
})

describe('POST /api/video-uploads — gli STESSI cancelli di POST /api/gallery, a parità di ingresso', () => {
  /**
   * Il rifiuto di un video e quello di una foto sono la stessa risposta, parola per parola: la UI che
   * oggi sa leggere il 422 con i nomi dei bambini non deve imparare un secondo formato. Qui si chiama la
   * route VERA della galleria con lo stesso utente, la stessa sede e gli stessi bambini, e si confrontano
   * lo stato e il CORPO. Un confronto fra due copie dello stesso letterale non proverebbe niente: per
   * questo ogni caso ha anche i suoi valori attesi, scritti a mano.
   */
  const postGallery = (corpo: unknown) =>
    new Request('http://localhost/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    })

  const confronta = async (opzioni: {
    ruolo?: string
    tag: string[]
    broadcast?: boolean
    classi?: string[]
  }) => {
    h.requireDocente.mockResolvedValue({
      user: { id: DOCENTE, role: opzioni.ruolo ?? 'educator', scuola_id: SEDE },
    })
    const gallery = await POST_GALLERY(
      postGallery({
        file_url: 'uploads/x.jpg',
        tag_students: opzioni.tag,
        is_broadcast: opzioni.broadcast ?? false,
        target_classes: opzioni.classi ?? [],
        scuola_id: SEDE,
      }),
    )
    const video = await POST(
      richiesta({
        ...CORPO_GALLERIA,
        destinatari: { tagAlunni: opzioni.tag, broadcast: opzioni.broadcast ?? false, classi: opzioni.classi ?? [] },
      }),
    )
    return { gallery, video, corpoGallery: await gallery.json(), corpoVideo: await video.json() }
  }

  it('403 bambino di un altro plesso: lo stesso corpo, e il suo `codice` (`TAG_FUORI_SEDE`)', async () => {
    const { gallery, video, corpoGallery, corpoVideo } = await confronta({ tag: [ALUNNO_ALTRA_SEDE] })
    expect(gallery.status).toBe(403)
    expect(video.status).toBe(403)
    expect(corpoVideo).toEqual(corpoGallery)
    expect(corpoVideo).toEqual({
      error: 'Uno o più bambini taggati non appartengono ai tuoi plessi.',
      codice: 'TAG_FUORI_SEDE',
    })
    // Dice QUANTI, mai QUALI: nominare l'uuid confermerebbe che quel bambino esiste.
    expect(JSON.stringify(corpoVideo)).not.toContain(ALUNNO_ALTRA_SEDE)
    expect(JSON.stringify(corpoVideo)).not.toContain('Cleo')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('403 broadcast per chi non è della Direzione: lo stesso corpo, SENZA `codice` (come oggi)', async () => {
    const { gallery, video, corpoGallery, corpoVideo } = await confronta({ ruolo: 'educator', tag: [], broadcast: true })
    expect(gallery.status).toBe(403)
    expect(video.status).toBe(403)
    expect(corpoVideo).toEqual(corpoGallery)
    expect(corpoVideo).toEqual({ error: 'Solo la Direzione (admin o coordinatore) può pubblicare in broadcast.' })
    expect(corpoVideo).not.toHaveProperty('codice')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('400 broadcast CON bambini: lo stesso corpo, SENZA `codice` (come oggi)', async () => {
    const { gallery, video, corpoGallery, corpoVideo } = await confronta({
      ruolo: 'admin',
      tag: [ALUNNO_A],
      broadcast: true,
    })
    expect(gallery.status).toBe(400)
    expect(video.status).toBe(400)
    expect(corpoVideo).toEqual(corpoGallery)
    expect(corpoVideo.error).toMatch(/non può taggare bambini/)
    expect(corpoVideo).not.toHaveProperty('codice')
    expect(h.rpc).not.toHaveBeenCalled()
  })

  it('422 liberatoria mancante: lo stesso corpo, con `nomi` e `ids`, e nessuna RPC', async () => {
    const { gallery, video, corpoGallery, corpoVideo } = await confronta({ tag: [ALUNNO_A, ALUNNO_B] })
    expect(gallery.status).toBe(422)
    expect(video.status).toBe(422)
    expect(corpoVideo).toEqual(corpoGallery)
    expect(corpoVideo.nomi).toEqual(['Bea Verdi'])
    expect(corpoVideo.ids).toEqual([ALUNNO_B])
    expect(corpoVideo.error).toMatch(/liberatoria foto/)
    expect(corpoVideo).not.toHaveProperty('codice')
    // Zero scritture: né un intento né un job per un video che non può uscire.
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('l’ORDINE dei cancelli è quello della galleria: la sede dei bambini prima del Privacy Lock', async () => {
    // Il 422 nomina dei minori e non deve pronunciarli su bambini che chi chiama non ha titolo di conoscere:
    // se uno è di un altro plesso la risposta è il 403 della sede, anche se un altro non ha la liberatoria.
    const { corpoVideo, video } = await confronta({ tag: [ALUNNO_B, ALUNNO_ALTRA_SEDE] })
    expect(video.status).toBe(403)
    expect(corpoVideo.codice).toBe('TAG_FUORI_SEDE')
    expect(JSON.stringify(corpoVideo)).not.toContain('Bea')
  })

  it('nei log del rifiuto passano i CONTEGGI, mai i nomi né gli id dei bambini', async () => {
    await confronta({ tag: [ALUNNO_A, ALUNNO_B] })
    const testo = tuttoIlLog()
    for (const vietato of [ALUNNO_A, ALUNNO_B, 'Bea', 'Verdi', 'Ada']) {
      expect(testo, `«${vietato}» nel log`).not.toContain(vietato)
    }
    // E i due rifiuti (galleria e video) hanno scritto la loro riga `liberatoria-mancante`, ciascuna con la sua operazione.
    const righe = eventiGalleria().filter((c) => c[2]?.esito === 'liberatoria-mancante')
    expect(righe.map((c) => c[2].operazione).sort()).toEqual(['gallery:POST', 'video-uploads:POST'])
    for (const r of righe) expect(r[2]).toMatchObject({ taggati: 2, senzaConsenso: 1 })
  })
})

describe('POST /api/video-uploads — il trasporto nativo (app 1.2): URL di PUT, token, e niente nei log', () => {
  const CORPO_NATIVO = {
    ...CORPO_GALLERIA,
    trasporto: 'put-nativo',
    file: [file('recita-1', { sha256: IMPRONTA.toUpperCase() })],
  }

  it('restituisce un URL di PUT firmato SENZA upsert e il token di rinnovo, e rispetta il contratto esteso', async () => {
    const res = await POST(richiesta(CORPO_NATIVO))
    expect(res.status).toBe(201)
    const corpo = await res.json()

    const letto = schemaRispostaAperturaVideo.safeParse(corpo)
    expect(letto.success, JSON.stringify(letto.error?.issues ?? [])).toBe(true)

    const job = corpo.job[0]
    expect(job.caricamento).toEqual({
      protocollo: 'put',
      url: 'https://storage.invalid/firmato?token=segreto-di-firma',
      metodo: 'PUT',
      intestazioni: { 'content-type': 'video/quicktime' },
    })
    // L'URL è già firmato: niente `x-signature`.
    expect(job.firma).toBe('')
    expect(job.needs_upload).toBe(true)
    expect(schemaTokenRinnovoVideo.safeParse(job.rinnovo.token).success).toBe(true)

    // ⚠️ SENZA UPSERT, ed è la proprietà che regge il token: una seconda PUT sullo stesso percorso prende
    // 409 invece di sovrascrivere l'originale già arrivato. Il default della libreria oggi è lo stesso, ma una
    // proprietà di sicurezza non si affida a un default: l'argomento è scritto per esteso e qui si legge.
    expect(h.opzioniFirma).toEqual([{ upsert: false }])
    expect(h.percorsiFirmati[0]).toBe(h.rpc.mock.calls[0][1].p_original_path)
  })

  it('alla RPC va l’HASH del token (mai il token), nella forma di un `bytea`, e l’impronta dichiarata', async () => {
    const res = await POST(richiesta(CORPO_NATIVO))
    const corpo = await res.json()
    const token = corpo.job[0].rinnovo.token as string
    const [nome, args] = h.rpc.mock.calls[0]
    expect(nome).toBe('video_galleria_intent_apri')

    const atteso = `\\x${createHash('sha256').update(token).digest('hex')}`
    expect(args.p_token_hash).toBe(atteso)
    expect(args.p_token_hash).toMatch(/^\\x[0-9a-f]{64}$/)
    expect(JSON.stringify(args)).not.toContain(token)
    // L'impronta del file, in minuscolo e come `bytea`.
    expect(args.p_sha256).toBe(`\\x${IMPRONTA}`)
    expect(args.p_trasporto).toBe('put-nativo')
    // La scadenza del token (48 ore) è la stessa che la risposta dichiara.
    expect(args.p_token_scade_il).toBe(corpo.job[0].rinnovo.scadeIl)
    const ore = (Date.parse(args.p_token_scade_il as string) - Date.now()) / 3_600_000
    expect(ore).toBeGreaterThan(47.9)
    expect(ore).toBeLessThanOrEqual(48)
  })

  it('il token e l’URL firmato NON entrano mai in un log, né in forma di hash', async () => {
    const res = await POST(richiesta(CORPO_NATIVO))
    const corpo = await res.json()
    const token = corpo.job[0].rinnovo.token as string
    const hash = createHash('sha256').update(token).digest('hex')
    const testo = tuttoIlLog()
    expect(testo).not.toContain(token)
    expect(testo).not.toContain(token.slice(4, 20))
    expect(testo).not.toContain(hash)
    expect(testo).not.toContain('segreto-di-firma')
    expect(testo).not.toContain('firmato?token')
    // E il successo c'è, col trasporto in una chiave che sopravvive alla redazione.
    expect(eventiGalleria().find((c) => c[2]?.esito === 'intento-aperto')?.[2]).toMatchObject({ tipo: 'put-nativo' })
  })

  it('il trasporto nativo SENZA l’impronta del file ⇒ 400 del contratto, nessuna RPC (#20)', async () => {
    const res = await POST(richiesta({ ...CORPO_NATIVO, file: [file('recita-1')] }))
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
  })

  it('una ripetizione che RUOTA il token restituisce quello nuovo, e la firma si conia di nuovo', async () => {
    h.rpc.mockResolvedValue({ data: esitoGalleria({ ripetuta: true, token_ruotato: true }), error: null })
    const corpo = await (await POST(richiesta(CORPO_NATIVO))).json()
    const token = corpo.job[0].rinnovo.token as string
    // È il token coniato in QUESTA chiamata: il suo hash è quello che la RPC ha ricevuto (e ruotato in tabella).
    expect(h.rpc.mock.calls[0][1].p_token_hash).toBe(`\\x${createHash('sha256').update(token).digest('hex')}`)
    expect(corpo.job[0].caricamento.protocollo).toBe('put')
  })

  it('una ripetizione dopo l’ARRIVO del file non ha né URL né token: `needs_upload` falso', async () => {
    h.rpc.mockResolvedValue({
      data: esitoGalleria({ ripetuta: true, token_ruotato: false }, {}, { status: 'queued' }),
      error: null,
    })
    const res = await POST(richiesta(CORPO_NATIVO))
    expect(res.status).toBe(201)
    const corpo = await res.json()
    expect(corpo.job[0]).toMatchObject({ status: 'queued', needs_upload: false, firma: '', expires_at: null })
    // Un token che il database non conosce, o già revocato, non si restituisce: lo schema lo vieta a caricamento finito.
    expect(corpo.job[0].rinnovo).toBeUndefined()
    expect(schemaRispostaAperturaVideo.safeParse(conEndpointDiProduzione(corpo)).success).toBe(true)
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    expect(h.info).not.toHaveBeenCalled()
  })

  it('un job ancora in attesa il cui token la RPC NON ha salvato è un difetto nostro: 500, nessuna firma', async () => {
    // `ripetuta: true, token_ruotato: false` su un job `awaiting_upload` non può succedere (la RPC ruota
    // sempre): se succede, restituire il token coniato qui darebbe un rinnovo che il database non conosce —
    // un caricamento che nessuno potrebbe rinnovare, e che nessuno vedrebbe fallire prima delle due ore.
    h.rpc.mockResolvedValue({ data: esitoGalleria({ ripetuta: true, token_ruotato: false }), error: null })
    const res = await POST(richiesta(CORPO_NATIVO))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('VIDEO_OPERAZIONE_NON_RIUSCITA')
    expect(h.createSignedUploadUrl).not.toHaveBeenCalled()
    expect(eventiGalleria().some((c) => c[1] === 'error' && c[2]?.esito === 'token-rinnovo-non-salvato')).toBe(true)
  })

  it('l’URL firmato non riuscito ⇒ 500 con codice, il motivo resta nel log e non esce', async () => {
    h.createSignedUploadUrl.mockResolvedValue({ data: null, error: { message: 'storage non raggiungibile' } })
    const res = await POST(richiesta(CORPO_NATIVO))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('storage non raggiungibile')
    expect(JSON.stringify(h.logErrore.mock.calls)).toContain('storage non raggiungibile')
  })

  it('il trasporto nativo di una News è respinto dal contratto, prima di tutto', async () => {
    const res = await POST(richiesta({ ...CORPO_NEWS, trasporto: 'put-nativo', file: [file('n-1', { sha256: IMPRONTA })] }))
    expect(res.status).toBe(400)
    expect(h.rpc).not.toHaveBeenCalled()
  })
})
