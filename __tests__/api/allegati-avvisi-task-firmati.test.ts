import { describe, it, expect, vi, beforeEach } from 'vitest'

// Bucket `avvisi_allegati` e `task_allegati` PRIVATI (2026-07-31).
//
// Erano `public: true`: l'allegato di un avviso — il modulo di una gita con i
// nomi dei bambini, un certificato, un verbale — si scaricava con il solo
// indirizzo, senza login e per sempre. Qui si collauda il percorso applicativo
// completo, sulle route:
//
//  - `avvisi/upload:POST` e `tasks/upload:POST` non possono più rispondere con
//    `getPublicUrl` (un indirizzo che ora NON funziona): restituiscono il
//    PERCORSO nel bucket più un link firmato per l'anteprima immediata;
//  - le route di LETTURA (`avvisi:GET`, `avvisi/[id]:GET`, `tasks:GET`,
//    `tasks/[id]:PUT`) firmano l'allegato al momento, dietro al loro gate;
//  - le route di SCRITTURA archiviano il PERCORSO, non un indirizzo che scade.

const SEDE = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const AVVISO_ID = 'cccccccc-0000-4000-8000-000000000003'
const TASK_ID = 'dddddddd-0000-4000-8000-000000000004'
const PROGETTO = 'https://abcdefgh.supabase.co'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  resolveScuolaScrittura: vi.fn(),
  scuoleDiUtente: vi.fn(),
  nomiSezioniDiUtente: vi.fn(),
  getFigliDiGenitore: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(),
  getModuleConfig: vi.fn(),
  notificaEvento: vi.fn(),
  genitoriDiScuola: vi.fn(),
  genitoriDiClassi: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  // "DB" simulato
  alunni: [] as Array<Record<string, unknown>>,
  avvisi: [] as Array<Record<string, unknown>>,
  task: [] as Array<Record<string, unknown>>,
  sezioni: [] as Array<Record<string, unknown>>,
  lastInsert: null as Record<string, unknown> | null,
  lastUpdate: null as Record<string, unknown> | null,
  // Storage simulato
  uploadPath: null as string | null,
  publicUrlChiamato: 0,
  firmaSingola: [] as Array<{ bucket: string; percorso: string; ttl: number }>,
  rispostaSingola: null as unknown,
  firmaBlocco: [] as Array<{ bucket: string; percorsi: string[]; ttl: number }>,
  rispostaBlocco: null as unknown,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: (...a: unknown[]) => h.requireUser(...a),
  requireDocente: (...a: unknown[]) => h.requireDocente(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: (...a: unknown[]) => h.resolveScuolaScrittura(...a),
  scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a),
}))
vi.mock('@/lib/sezioni/docenti', () => ({ nomiSezioniDiUtente: (...a: unknown[]) => h.nomiSezioniDiUtente(...a) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: (...a: unknown[]) => h.getFigliDiGenitore(...a) }))
vi.mock('@/lib/avvisi/target-gate', () => ({ verificaTargetAvvisoDocente: (...a: unknown[]) => h.verificaTargetAvvisoDocente(...a) }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: (...a: unknown[]) => h.getModuleConfig(...a) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: (...a: unknown[]) => h.notificaEvento(...a) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiScuola: (...a: unknown[]) => h.genitoriDiScuola(...a),
  genitoriDiClassi: (...a: unknown[]) => h.genitoriDiClassi(...a),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: (...a: unknown[]) => h.logScrittura(...a) }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
}))

const storage = {
  from: (bucket: string) => ({
    upload: async (path: string) => {
      h.uploadPath = path
      return { error: null }
    },
    // I bucket sono privati: un indirizzo "pubblico" non funziona più. Se il
    // codice lo chiedesse ancora, il test deve accorgersene.
    getPublicUrl: (path: string) => {
      h.publicUrlChiamato++
      return { data: { publicUrl: `${PROGETTO}/storage/v1/object/public/${bucket}/${path}` } }
    },
    createSignedUrl: async (percorso: string, ttl: number) => {
      h.firmaSingola.push({ bucket, percorso, ttl })
      return h.rispostaSingola
    },
    createSignedUrls: async (percorsi: string[], ttl: number) => {
      h.firmaBlocco.push({ bucket, percorsi, ttl })
      return h.rispostaBlocco
    },
  }),
}

const adminClient = {
  storage,
  from(table: string) {
    const st: { count: boolean; notNull: string | null; filters: Record<string, unknown>; inserted: Record<string, unknown> | null; updated: Record<string, unknown> | null } =
      { count: false, notNull: null, filters: {}, inserted: null, updated: null }
    const result = () => {
      if (table === 'alunni') return { data: h.alunni, error: null }
      if (table === 'avvisi') return { data: h.avvisi, error: null }
      if (table === 'task_interni') return { data: h.task, error: null }
      if (table === 'sections') return { data: h.sezioni, error: null }
      if (table === 'utenti') return { data: null, error: null }
      if (table === 'avvisi_risposte') return st.count ? { count: 0 } : { data: [], error: null }
      return { data: null, error: null }
    }
    const unaRiga = () => {
      if (table === 'avvisi') {
        const id = st.filters.id as string | undefined
        return { data: h.avvisi.find((a) => a.id === id) ?? null, error: null }
      }
      if (table === 'task_interni') {
        const id = st.filters.id as string | undefined
        return { data: h.task.find((t) => t.id === id) ?? null, error: null }
      }
      return result()
    }
    const b: Record<string, unknown> = {}
    b.select = (_s?: string, opts?: { count?: string; head?: boolean }) => { if (opts?.count) st.count = true; return b }
    b.order = () => b
    b.eq = (c: string, v: unknown) => { st.filters[c] = v; return b }
    b.in = () => b
    b.not = (c: string) => { st.notNull = c; return b }
    b.limit = () => b
    b.insert = (rec: Record<string, unknown>) => { h.lastInsert = rec; st.inserted = rec; return b }
    b.update = (rec: Record<string, unknown>) => { h.lastUpdate = rec; st.updated = rec; return b }
    b.single = async () => {
      if (st.inserted) return { data: { id: 'nuovo', ...st.inserted }, error: null }
      if (st.updated) {
        const base = (unaRiga().data ?? {}) as Record<string, unknown>
        return { data: { ...base, ...st.updated }, error: null }
      }
      return unaRiga()
    }
    b.maybeSingle = async () => unaRiga()
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(result()).then(onF, onR)
    return b
  },
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => adminClient,
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}))

import { GET as AVVISI_GET, POST as AVVISI_POST } from '@/app/api/avvisi/route'
import { GET as AVVISO_GET, PUT as AVVISO_PUT } from '@/app/api/avvisi/[id]/route'
import { POST as AVVISI_UPLOAD } from '@/app/api/avvisi/upload/route'
import { GET as TASKS_GET } from '@/app/api/tasks/route'
import { PUT as TASK_PUT } from '@/app/api/tasks/[id]/route'
import { POST as TASKS_UPLOAD } from '@/app/api/tasks/upload/route'
import { TTL_FIRMA_ALLEGATI_S } from '@/lib/allegati/storage'

const getReq = (base: string, qs = '') => ({
  url: `http://test${base}${qs ? `?${qs}` : ''}`,
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams(qs) },
  cookies: { get: () => undefined },
}) as never

const bodyReq = (base: string, body: unknown, method = 'POST') => ({
  url: `http://test${base}`,
  method,
  headers: new Headers(),
  json: async () => body,
}) as never

/** Request multipart minimale: la route legge solo `formData().get('file')`. */
const uploadReq = (file: File): Request =>
  ({
    headers: new Headers(),
    url: 'http://test/api/upload',
    formData: async () => ({ get: (k: string) => (k === 'file' ? file : null) }),
  }) as unknown as Request

const pdf = () =>
  new File([new Uint8Array([1, 2, 3]) as unknown as BlobPart], 'modulo-gita.pdf', { type: 'application/pdf' })

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE } })
  h.resolveScuoleAttive.mockResolvedValue([SEDE])
  h.resolveScuolaScrittura.mockResolvedValue({ scuolaId: SEDE })
  h.scuoleDiUtente.mockResolvedValue([SEDE])
  h.nomiSezioniDiUtente.mockResolvedValue([])
  h.getFigliDiGenitore.mockResolvedValue(['s1'])
  h.verificaTargetAvvisoDocente.mockResolvedValue(null)
  h.getModuleConfig.mockResolvedValue({ ruoli_pubblicazione: ['admin', 'teacher'] })
  h.notificaEvento.mockResolvedValue(undefined)
  h.genitoriDiScuola.mockResolvedValue([])
  h.genitoriDiClassi.mockResolvedValue([])
  h.alunni = [{ id: 's1', nome: 'Bruna', classe_sezione: '1A', scuola_id: SEDE }]
  h.avvisi = []
  h.task = []
  h.sezioni = [{ name: '1A' }]
  h.lastInsert = null
  h.lastUpdate = null
  h.uploadPath = null
  h.publicUrlChiamato = 0
  h.firmaSingola = []
  h.firmaBlocco = []
  h.rispostaSingola = { data: { signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/anteprima?token=T` }, error: null }
  h.rispostaBlocco = { data: [], error: null }
})

describe('POST /api/avvisi/upload — niente più indirizzi pubblici', () => {
  it('restituisce il PERCORSO nel bucket e non chiama mai getPublicUrl', async () => {
    const res = await AVVISI_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(200)
    const j = await res.json()

    // CONTROLLO POSITIVO: il percorso c'è, ed è quello davvero caricato.
    expect(h.uploadPath).toMatch(/\.pdf$/)
    expect(j.path).toBe(h.uploadPath)
    expect(h.publicUrlChiamato).toBe(0)
    expect(JSON.stringify(j)).not.toContain('/object/public/')
  })

  it('accompagna il percorso con un link FIRMATO per l\'anteprima immediata', async () => {
    const res = await AVVISI_UPLOAD(uploadReq(pdf()))
    const j = await res.json()
    expect(j.previewUrl).toContain('/object/sign/')
    expect(h.firmaSingola).toHaveLength(1)
    expect(h.firmaSingola[0]).toMatchObject({ bucket: 'avvisi_allegati', percorso: h.uploadPath as string })
    expect(h.firmaSingola[0].ttl).toBe(TTL_FIRMA_ALLEGATI_S)
  })

  it('`fileUrl` resta per i client vecchi, ma vale il PERCORSO (niente token da salvare)', async () => {
    const res = await AVVISI_UPLOAD(uploadReq(pdf()))
    const j = await res.json()
    expect(j.fileUrl).toBe(h.uploadPath)
    expect(j.fileUrl).not.toContain('token=')
  })

  it('firma fallita: il file è salvo (200 + path), anteprima nulla, log `error` col corpo', async () => {
    h.rispostaSingola = { data: null, error: { message: 'Object not found', status: 404 } }
    const res = await AVVISI_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.path).toBe(h.uploadPath)
    expect(j.previewUrl).toBeNull()
    const ev = h.logEvento.mock.calls.filter((c) => c[0] === 'storage')
    expect(ev).toHaveLength(1)
    expect(ev[0][1]).toBe('error')
    expect(ev[0][2]).toMatchObject({ operazione: 'avvisi/upload:POST', bucket: 'avvisi_allegati' })
  })
})

describe('POST /api/tasks/upload — niente più indirizzi pubblici', () => {
  it('restituisce il PERCORSO da archiviare e conserva i metadati del file', async () => {
    const res = await TASKS_UPLOAD(uploadReq(pdf()))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.path).toBe(h.uploadPath)
    expect(j.url).toBe(h.uploadPath)
    expect(h.publicUrlChiamato).toBe(0)
    expect(JSON.stringify(j)).not.toContain('/object/public/')
    // CONTROLLO POSITIVO: la risposta resta quella che il client si aspetta.
    expect(j).toMatchObject({ name: 'modulo-gita.pdf', size: 3, type: 'application/pdf' })
  })

  it('`fileUrl` porta il link FIRMATO: è quello che il client mostra come anteprima', async () => {
    // `TaskCard` e `StudentDetailPanel` leggono `att.fileUrl || att.url` per
    // l'immagine e per il link. Se qui ci mettessimo il percorso, l'allegato
    // appena caricato apparirebbe rotto finché non si salva e si ricarica.
    // Il percorso resta in `url`/`path`, ed è quello che finisce in tabella —
    // e comunque la scrittura normalizza tutte le chiavi.
    const res = await TASKS_UPLOAD(uploadReq(pdf()))
    const j = await res.json()
    expect(j.fileUrl).toContain('/object/sign/')
    expect(j.previewUrl).toBe(j.fileUrl)
  })

  it('firma l\'anteprima sul bucket degli incarichi, col TTL del modello', async () => {
    await TASKS_UPLOAD(uploadReq(pdf()))
    expect(h.firmaSingola).toHaveLength(1)
    expect(h.firmaSingola[0].bucket).toBe('task_allegati')
    expect(h.firmaSingola[0].ttl).toBe(TTL_FIRMA_ALLEGATI_S)
  })
})

describe('GET /api/avvisi — l\'allegato esce FIRMATO', () => {
  const avvisoConAllegato = (attachment_url: string) => ({
    id: AVVISO_ID, author_id: 'aut1', titolo: 'Gita', contenuto: 'x', tipo: 'presa_visione',
    target_scope: 'globale', target_classes: null, scadenza: null, attachment_url,
    created_at: '2026-07-31', scuola_id: SEDE,
  })

  it('ramo STAFF: il percorso salvato diventa un link firmato', async () => {
    h.avvisi = [avvisoConAllegato(JSON.stringify({ file: 'modulo.pdf', link: null }))]
    h.rispostaBlocco = {
      data: [{ path: 'modulo.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/modulo.pdf?token=T`, error: null }],
      error: null,
    }
    const res = await AVVISI_GET(getReq('/api/avvisi'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<{ id: string; attachment_url: string }>
    // CONTROLLO POSITIVO: l'avviso c'è e l'allegato nomina il file giusto, firmato.
    expect(j).toHaveLength(1)
    const dec = JSON.parse(j[0].attachment_url)
    expect(dec.file).toContain('/object/sign/avvisi_allegati/modulo.pdf')
    expect(dec.file).toContain('token=')
    expect(dec.file).not.toContain('/object/public/')
    expect(h.firmaBlocco).toHaveLength(1)
    expect(h.firmaBlocco[0]).toMatchObject({ bucket: 'avvisi_allegati', percorsi: ['modulo.pdf'] })
  })

  it('ramo GENITORE: idem, e l\'URL pubblico storico viene ri-firmato', async () => {
    h.requireUser.mockResolvedValue({ user: { id: PARENT_ID, role: 'genitore', scuola_id: null } })
    h.avvisi = [avvisoConAllegato(`${PROGETTO}/storage/v1/object/public/avvisi_allegati/storico.pdf`)]
    h.rispostaBlocco = {
      data: [{ path: 'storico.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/storico.pdf?token=T`, error: null }],
      error: null,
    }
    const res = await AVVISI_GET(getReq('/api/avvisi'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<{ id: string; attachment_url: string }>
    expect(j).toHaveLength(1)
    expect(j[0].attachment_url).toContain('/object/sign/avvisi_allegati/storico.pdf')
    expect(j[0].attachment_url).not.toContain('/object/public/')
  })
})

describe('GET /api/avvisi/[id] — anche il dettaglio firma', () => {
  it('il singolo avviso esce con l\'allegato firmato', async () => {
    h.avvisi = [{
      id: AVVISO_ID, author_id: 'aut1', titolo: 'Gita', contenuto: 'x',
      attachment_url: JSON.stringify({ file: 'modulo.pdf', link: null }), scuola_id: SEDE,
    }]
    h.rispostaBlocco = {
      data: [{ path: 'modulo.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/modulo.pdf?token=T`, error: null }],
      error: null,
    }
    const res = await AVVISO_GET(getReq(`/api/avvisi/${AVVISO_ID}`), params(AVVISO_ID))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.id).toBe(AVVISO_ID)
    const dec = JSON.parse(j.attachment_url)
    expect(dec.file).toContain('/object/sign/avvisi_allegati/modulo.pdf')
    expect(dec.file).not.toContain('/object/public/')
  })
})

describe('Scrittura avvisi — in tabella il PERCORSO, non un indirizzo che scade', () => {
  it('POST: un URL firmato rimandato dal client viene normalizzato a percorso', async () => {
    const res = await AVVISI_POST(bodyReq('/api/avvisi', {
      titolo: 'T', contenuto: 'C', target_scope: 'globale',
      attachment_url: JSON.stringify({
        file: `${PROGETTO}/storage/v1/object/sign/avvisi_allegati/modulo.pdf?token=SCADUTO`,
        link: 'https://comune.example/bando',
      }),
    }))
    expect(res.status).toBe(201)
    const salvato = JSON.parse(h.lastInsert?.attachment_url as string)
    expect(salvato.file).toBe('modulo.pdf')
    // CONTROLLO POSITIVO: il link esterno non viene toccato.
    expect(salvato.link).toBe('https://comune.example/bando')
  })

  it('PUT: idem sull\'aggiornamento', async () => {
    h.avvisi = [{ id: AVVISO_ID, scuola_id: SEDE, author_id: 'aut1' }]
    const res = await AVVISO_PUT(
      bodyReq(`/api/avvisi/${AVVISO_ID}`, {
        titolo: 'T', contenuto: 'C',
        attachment_url: `${PROGETTO}/storage/v1/object/public/avvisi_allegati/modulo.pdf`,
      }, 'PUT'),
      params(AVVISO_ID),
    )
    expect(res.status).toBe(200)
    expect(h.lastUpdate?.attachment_url).toBe('modulo.pdf')
  })
})

describe('Incarichi — gli allegati escono firmati e si archiviano come percorso', () => {
  const contenutoTask = (attachments: unknown) => JSON.stringify({
    real_author_id: 'seg-1', assignees: ['seg-1'], descrizione: 'd', status: 'todo',
    priority: 'medium', category: 'generale', deadline: null, compiti: [],
    target_scope: 'global', target_role: null, student_id: null,
    resolved_by: null, resolution_notes: null, resolved_at: null,
    attachments, commenti: [],
  })

  it('GET /api/tasks: l\'allegato del task esce firmato', async () => {
    h.task = [{
      id: TASK_ID, author_id: 'seg-1', assigned_to: null, target_class: null, titolo: 'Verifica',
      contenuto: contenutoTask([{ name: 'verbale.pdf', url: 'verbale.pdf', size: 10, type: 'application/pdf' }]),
      completato: false, created_at: '2026-07-31', scuola_id: SEDE,
    }]
    h.rispostaBlocco = {
      data: [{ path: 'verbale.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=T`, error: null }],
      error: null,
    }
    const res = await TASKS_GET(getReq('/api/tasks', 'userId=seg-1'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<{ id: string; attachments: Array<{ url: string; name: string }> }>
    expect(j).toHaveLength(1)
    // CONTROLLO POSITIVO: l'allegato c'è, col suo nome, e l'URL è firmato sul file giusto.
    expect(j[0].attachments[0].name).toBe('verbale.pdf')
    expect(j[0].attachments[0].url).toContain('/object/sign/task_allegati/verbale.pdf')
    expect(j[0].attachments[0].url).not.toContain('/object/public/')
    expect(h.firmaBlocco[0]).toMatchObject({ bucket: 'task_allegati', percorsi: ['verbale.pdf'] })
  })

  it('GET /api/tasks?studentId: anche il pannello del bambino firma (è un ramo a parte)', async () => {
    // Ramo separato dentro la stessa route (`StudentDetailPanel`): esce PRIMA
    // del ritorno principale, quindi firmare solo là in fondo lo lascerebbe
    // scoperto — e nessun test se ne accorgerebbe.
    h.task = [{
      id: TASK_ID, author_id: 'seg-1', assigned_to: null, target_class: null, titolo: 'Verifica',
      contenuto: JSON.stringify({
        real_author_id: 'seg-1', assignees: ['seg-1'], descrizione: 'd', status: 'todo',
        student_id: 's1', compiti: [], commenti: [],
        attachments: [{ name: 'referto.pdf', url: 'referto.pdf', size: 10, type: 'application/pdf' }],
      }),
      completato: false, created_at: '2026-07-31', scuola_id: SEDE,
    }]
    h.rispostaBlocco = {
      data: [{ path: 'referto.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/referto.pdf?token=T`, error: null }],
      error: null,
    }
    const res = await TASKS_GET(getReq('/api/tasks', 'studentId=s1'))
    expect(res.status).toBe(200)
    const j = (await res.json()) as Array<{ attachments: Array<{ url: string; name: string }> }>
    expect(j).toHaveLength(1)
    expect(j[0].attachments[0].name).toBe('referto.pdf')
    expect(j[0].attachments[0].url).toContain('/object/sign/task_allegati/referto.pdf')
    expect(j[0].attachments[0].url).not.toContain('/object/public/')
  })

  it('PUT /api/tasks/[id]: archivia il percorso e risponde col link firmato', async () => {
    h.task = [{
      id: TASK_ID, author_id: 'seg-1', assigned_to: null, target_class: null, titolo: 'Verifica',
      contenuto: contenutoTask([]), completato: false, created_at: '2026-07-31', scuola_id: SEDE,
    }]
    h.rispostaBlocco = {
      data: [{ path: 'verbale.pdf', signedUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=T`, error: null }],
      error: null,
    }
    const res = await TASK_PUT(
      bodyReq(`/api/tasks/${TASK_ID}`, {
        // La forma REALE che il client rimanda: l'oggetto restituito dall'upload,
        // con `fileUrl` firmato accanto al percorso.
        attachments: [{
          name: 'verbale.pdf',
          path: 'verbale.pdf',
          url: 'verbale.pdf',
          fileUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=SCADUTO`,
          previewUrl: `${PROGETTO}/storage/v1/object/sign/task_allegati/verbale.pdf?token=SCADUTO`,
          size: 10, type: 'application/pdf',
        }],
      }, 'PUT'),
      params(TASK_ID),
    )
    expect(res.status).toBe(200)

    // In tabella il PERCORSO, su OGNI chiave che porta un indirizzo.
    const salvato = JSON.parse(h.lastUpdate?.contenuto as string)
    expect(salvato.attachments[0].url).toBe('verbale.pdf')
    expect(salvato.attachments[0].fileUrl).toBe('verbale.pdf')
    expect(salvato.attachments[0].previewUrl).toBe('verbale.pdf')
    expect(salvato.attachments[0].name).toBe('verbale.pdf')
    expect(h.lastUpdate?.contenuto as string).not.toContain('token=SCADUTO')

    // Al client il link FIRMATO (altrimenti l'allegato appena caricato non si apre
    // finché non si ricarica la pagina).
    const j = await res.json()
    expect(j.attachments[0].url).toContain('/object/sign/task_allegati/verbale.pdf')
    expect(j.attachments[0].fileUrl).toContain('/object/sign/task_allegati/verbale.pdf')
    expect(j.attachments[0].url).not.toContain('token=SCADUTO')
  })
})
