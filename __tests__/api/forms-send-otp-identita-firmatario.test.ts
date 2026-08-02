import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { NextResponse } from 'next/server'

// =============================================================================
// LA FIRMA ELETTRONICA CHE CHIUNQUE POTEVA CHIEDERE.
//
// `POST /api/forms/send-otp` non verificava NESSUNA identità e accettava un
// `signerEmail` ARBITRARIO su una submission ALTRUI. La catena completa,
// misurata il 2026-08-02:
//
//   POST { submissionId: <di un altro genitore>, signerEmail: "attaccante@…" }
//     → 200, `otp_secret` della vittima sovrascritto, codice recapitato
//       all'attaccante
//   PATCH { submissionId, code: <quello ricevuto> }
//     → 200, `status='completed'`, `signed_at`, riga in `fea_signatures` e
//       `signature_log` costruito con l'email della VITTIMA.
//
// Il modulo risultava firmato dal genitore. Con valore legale (CAD Art. 20 /
// DPR 445/2000). Il tetto per IP che la route aveva già difendeva dal *tirare a
// indovinare* il codice, non dal *farselo mandare*: chi dirotta l'email il
// codice lo conosce al primo tentativo.
//
// La regola che questi test bloccano: **l'identità del firmatario viene dal
// DATO GIÀ REGISTRATO** — la submission e i tutori dell'alunno — **non dal
// corpo della richiesta**. Vale sul POST e sul PATCH, perché una regola su una
// strada sola non è una regola (lezione del ciclo precedente: PUT/POST avvisi).
//
// Il secondo blocco tiene fermo che il messaggio interno di PostgREST — nome di
// tabella e di vincolo — si LOGGA e non si RACCONTA: è la forma di
// `erroreLettura()` in `src/app/api/diary/route.ts`, qui applicata ai quattro
// punti di questo file.
// =============================================================================

const G_TITOLARE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11'
const G_ESTRANEO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99'
const G_COGENITORE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa22'
const STAFF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa77'
const SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12'
const MODEL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10'
const MODEL_INESISTENTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa66'
const ALUNNO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb20'
const PARENT_ANAGRAFICO = 'cccccccc-cccc-4ccc-8ccc-cccccccccc30'

const EMAIL_TITOLARE = 'mamma@example.invalid'
const EMAIL_COGENITORE = 'papa@example.invalid'
const EMAIL_ATTACCANTE = 'attaccante@example.invalid'

const h = vi.hoisted(() => ({
  /** L'identità di sessione: `null` = ANONIMO (nessun cookie). */
  chiamante: null as { id: string; role: string } | null,
  /** Righe del finto database, filtrate da un mini-engine `eq`/`in`. */
  db: {} as Record<string, Record<string, unknown>[]>,
  /** Errore PostgREST iniettato sulla prossima operazione della tabella. */
  erroriUpdate: {} as Record<string, { code: string; message: string; details?: string } | null>,
  erroriInsert: {} as Record<string, { code: string; message: string; details?: string } | null>,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  upserts: [] as { table: string; row: Record<string, unknown> }[],
  email: [] as { to: string; text: string }[],
  errori: [] as { campi: unknown; err: unknown }[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () =>
    h.chiamante
      ? { user: { id: h.chiamante.id, role: h.chiamante.role, scuola_id: null } }
      : { response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) }
  ),
}))

vi.mock('@/lib/supabase/server-client', () => {
  let nuovoId = 0
  function client() {
    return {
      from(table: string) {
        const filtri: ((r: Record<string, unknown>) => boolean)[] = []
        let inserita: Record<string, unknown> | null = null
        const qb: Record<string, unknown> = {}
        qb.select = () => qb
        qb.order = () => qb
        qb.limit = () => qb
        qb.eq = (col: string, val: unknown) => { filtri.push((r) => r[col] === val); return qb }
        qb.in = (col: string, vals: unknown[]) => { filtri.push((r) => vals.includes(r[col])); return qb }
        const righe = () => (h.db[table] ?? []).filter((r) => filtri.every((f) => f(r)))
        qb.insert = (row: Record<string, unknown>) => {
          inserita = { id: `ins-${++nuovoId}`, ...row }
          h.inserts.push({ table, row })
          return qb
        }
        qb.update = (row: Record<string, unknown>) => { h.updates.push({ table, row }); return qb }
        qb.upsert = (row: Record<string, unknown>) => {
          h.upserts.push({ table, row })
          return { select: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }
        }
        qb.maybeSingle = async () => ({ data: righe()[0] ?? null, error: null })
        qb.single = async () =>
          inserita
            ? { data: h.erroriInsert[table] ? null : inserita, error: h.erroriInsert[table] ?? null }
            : { data: righe()[0] ?? null, error: null }
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(
            h.updates.some((u) => u.table === table) && h.erroriUpdate[table]
              ? { data: null, error: h.erroriUpdate[table] }
              : { data: righe(), error: null }
          ).then(res, rej)
        return qb
      },
    }
  }
  return { createAdminClient: async () => client(), createClient: async () => client() }
})

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(async (m: { to: string; text: string }) => { h.email.push(m); return true }),
}))
vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, remaining: 7, retryAfterMs: 0 }),
  clientIp: () => 'ip-test',
}))
vi.mock('@/lib/security/otp-rate-limit', () => ({ limitaVerificaOtpOggetto: () => null }))
vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospesoSalvoEssenziale: async () => null,
}))
vi.mock('@/lib/fea/audit', () => ({ logFeaEvent: async () => {} }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...vero,
    logErrore: vi.fn((campi: unknown, err: unknown) => { h.errori.push({ campi, err }) }),
    logEvento: vi.fn((evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    }),
  }
})

import { POST, PATCH } from '@/app/api/forms/send-otp/route'

const hashOtp = (id: string, code: string) =>
  createHash('sha256').update(`${id}:${code}`).digest('hex')

const req = (body: unknown, method: 'POST' | 'PATCH' = 'POST') =>
  new Request('http://localhost/api/forms/send-otp', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Lo stato di partenza: una submission del genitore titolare, in attesa di firma. */
function scenarioBase(codice = '424242') {
  h.db = {
    form_submissions: [{
      id: SUB,
      status: 'pending_signature',
      user_id: G_TITOLARE,
      model_id: MODEL,
      otp_secret: hashOtp(SUB, codice),
    }],
    form_models: [{ id: MODEL, schema: { pages: [] }, signature_mode: 'single', sempre_firmabile: false }],
    utenti: [
      { id: G_TITOLARE, email: EMAIL_TITOLARE },
      { id: G_COGENITORE, email: EMAIL_COGENITORE },
      { id: G_ESTRANEO, email: EMAIL_ATTACCANTE },
    ],
    // Il legame REGISTRATO: entrambi i genitori sono tutori dello stesso alunno.
    legame_genitori_alunni: [
      { genitore_id: G_TITOLARE, alunno_id: ALUNNO },
      { genitore_id: G_COGENITORE, alunno_id: ALUNNO },
    ],
    student_parents: [{ student_id: ALUNNO, parent_id: PARENT_ANAGRAFICO }],
    parents: [{ id: PARENT_ANAGRAFICO, auth_user_id: G_COGENITORE, emails: [EMAIL_COGENITORE] }],
    fea_signatures: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamante = null
  h.erroriUpdate = {}
  h.erroriInsert = {}
  h.inserts = []; h.updates = []; h.upserts = []; h.email = []; h.errori = []; h.eventi = []
  scenarioBase()
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. CHI può chiedere il codice
// ─────────────────────────────────────────────────────────────────────────────
describe('POST send-otp — il codice di firma non si chiede da anonimi', () => {
  it('anonimo → 401, e nessun codice parte', async () => {
    h.chiamante = null
    const res = await POST(req({ submissionId: SUB, signerEmail: EMAIL_ATTACCANTE }))
    expect(res.status).toBe(401)
    expect(h.email).toEqual([])
    expect(h.updates.filter((u) => u.table === 'form_submissions')).toEqual([])
  })

  it("genitore ESTRANEO sulla submission di un altro → 403, l'otp_secret della vittima resta intatto", async () => {
    h.chiamante = { id: G_ESTRANEO, role: 'genitore' }
    const res = await POST(req({ submissionId: SUB, signerEmail: EMAIL_ATTACCANTE }))
    expect(res.status).toBe(403)
    expect(h.email).toEqual([])
    expect(h.updates.filter((u) => u.table === 'form_submissions')).toEqual([])
  })

  it('il rifiuto LASCIA UNA RIGA: `warn` persistito, con uuid e ruolo, senza email né nomi', async () => {
    // Un tentativo di firmare al posto di un altro che non lascia traccia è un
    // tentativo che nessuno conterà mai. `warn` perché è ciò che `vaPersistito`
    // manda in tabella: su Vercel soltanto, durerebbe un giorno.
    h.chiamante = { id: G_ESTRANEO, role: 'genitore' }
    await POST(req({ submissionId: SUB, signerEmail: EMAIL_ATTACCANTE }))
    const ev = h.eventi.find((e) => e.campi.tipo === 'firma-senza-titolo')
    expect(ev).toBeTruthy()
    expect(ev!.evento).toBe('fea')
    expect(ev!.livello).toBe('warn')
    expect(ev!.campi).toMatchObject({ utente: G_ESTRANEO, ruolo: 'genitore', submission: SUB })
    // Mai PII nei log: nell'evento non compare nessun indirizzo email.
    expect(JSON.stringify(ev!.campi)).not.toContain('@')
  })

  it('titolare → 200: il reinvio al proprio indirizzo continua a funzionare', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    const res = await POST(req({ submissionId: SUB }))
    expect(res.status).toBe(200)
    expect(h.email.map((e) => e.to)).toEqual([EMAIL_TITOLARE])
  })

  it('staff di segreteria → 200: lo sportello può reinviare per conto del genitore', async () => {
    h.chiamante = { id: STAFF, role: 'segreteria' }
    const res = await POST(req({ submissionId: SUB }))
    expect(res.status).toBe(200)
    expect(h.email.map((e) => e.to)).toEqual([EMAIL_TITOLARE])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. A QUALE INDIRIZZO arriva il codice
// ─────────────────────────────────────────────────────────────────────────────
describe('POST send-otp — il destinatario esce dal dato registrato, non dal body', () => {
  it('signerEmail estranea ai tutori dell\'alunno → 403, e nessuna email parte', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    const res = await POST(req({ submissionId: SUB, signerEmail: EMAIL_ATTACCANTE }))
    expect(res.status).toBe(403)
    expect(h.email).toEqual([])
    expect(h.updates.filter((u) => u.table === 'form_submissions')).toEqual([])
    // Anche questo rifiuto lascia una riga, e senza l'indirizzo richiesto:
    // sarebbe l'email di una persona, e finirebbe in tabella.
    const ev = h.eventi.find((e) => e.campi.tipo === 'destinatario-otp-non-registrato')
    expect(ev).toMatchObject({ evento: 'fea', livello: 'warn' })
    expect(JSON.stringify(ev!.campi)).not.toContain('@')
  })

  it('signerEmail del 2° genitore REGISTRATO → 200 e il codice va lì (firma congiunta, DL-031)', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    const res = await POST(req({ submissionId: SUB, signerEmail: EMAIL_COGENITORE }))
    expect(res.status).toBe(200)
    expect(h.email.map((e) => e.to)).toEqual([EMAIL_COGENITORE])
  })

  it('2° genitore SENZA account: vale la sua email in anagrafica `parents`', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    // Nessun account per il co-genitore: solo il record anagrafico.
    h.db.parents = [{ id: PARENT_ANAGRAFICO, auth_user_id: null, emails: ['tutore.senza.account@example.invalid'] }]
    h.db.legame_genitori_alunni = [{ genitore_id: G_TITOLARE, alunno_id: ALUNNO }]
    const res = await POST(req({ submissionId: SUB, signerEmail: 'tutore.senza.account@example.invalid' }))
    expect(res.status).toBe(200)
    expect(h.email.map((e) => e.to)).toEqual(['tutore.senza.account@example.invalid'])
  })

  it('il confronto non si fa distrarre da maiuscole e spazi', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    const res = await POST(req({ submissionId: SUB, signerEmail: `  ${EMAIL_COGENITORE.toUpperCase()} ` }))
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. La CREAZIONE: `userId` non è più un'autorità del client
// ─────────────────────────────────────────────────────────────────────────────
describe('POST send-otp — la submission nasce a nome di chi la firma', () => {
  it('anonimo → 401, nessuna riga creata', async () => {
    h.chiamante = null
    const res = await POST(req({ modelId: MODEL, userId: G_TITOLARE, data: { campo: 'x' } }))
    expect(res.status).toBe(401)
    expect(h.inserts.filter((i) => i.table === 'form_submissions')).toEqual([])
  })

  it('genitore che dichiara un userId ALTRUI → 403, nessuna riga creata', async () => {
    h.chiamante = { id: G_ESTRANEO, role: 'genitore' }
    const res = await POST(req({ modelId: MODEL, userId: G_TITOLARE, data: { campo: 'x' } }))
    expect(res.status).toBe(403)
    expect(h.inserts.filter((i) => i.table === 'form_submissions')).toEqual([])
  })

  it('genitore su se stesso → 200 e la riga porta il SUO id, non quello del body', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    const res = await POST(req({ modelId: MODEL, data: { campo: 'x' } }))
    expect(res.status).toBe(200)
    const ins = h.inserts.find((i) => i.table === 'form_submissions')
    expect(ins?.row.user_id).toBe(G_TITOLARE)
    expect(h.email.map((e) => e.to)).toEqual([EMAIL_TITOLARE])
  })

  it('modelId inesistente → 404 senza nemmeno provare la INSERT', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    const res = await POST(req({ modelId: MODEL_INESISTENTE, data: {} }))
    expect(res.status).toBe(404)
    expect(h.inserts.filter((i) => i.table === 'form_submissions')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Il PATCH: la firma si finalizza solo da chi ha titolo
// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH send-otp — finalizzare una firma legale non è per chiunque', () => {
  it('anonimo, anche col codice giusto → 401 e nulla viene firmato', async () => {
    h.chiamante = null
    const res = await PATCH(req({ submissionId: SUB, code: '424242' }, 'PATCH'))
    expect(res.status).toBe(401)
    expect(h.updates.filter((u) => u.table === 'form_submissions')).toEqual([])
  })

  it('genitore estraneo, anche col codice giusto → 403 e la submission NON diventa completed', async () => {
    h.chiamante = { id: G_ESTRANEO, role: 'genitore' }
    const res = await PATCH(req({ submissionId: SUB, code: '424242' }, 'PATCH'))
    expect(res.status).toBe(403)
    expect(h.updates.some((u) => u.table === 'form_submissions' && u.row.status === 'completed')).toBe(false)
    expect(h.upserts.filter((u) => u.table === 'fea_signatures')).toEqual([])
  })

  it('titolare col codice giusto → 200 e la firma si completa', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    const res = await PATCH(req({ submissionId: SUB, code: '424242' }, 'PATCH'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, completed: true })
  })

  it('co-genitore CON account: firma anche lui (firma congiunta dal proprio dispositivo)', async () => {
    h.chiamante = { id: G_COGENITORE, role: 'genitore' }
    const res = await PATCH(req({ submissionId: SUB, code: '424242' }, 'PATCH'))
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Il messaggio interno di PostgREST si LOGGA, non si RACCONTA
//    (la forma di `erroreLettura()` in `src/app/api/diary/route.ts`)
// ─────────────────────────────────────────────────────────────────────────────
const MSG_INTERNO = 'insert or update on table "form_submissions" violates foreign key constraint "form_submissions_model_id_fkey"'

describe('send-otp — il dettaglio interno non esce mai dalla risposta', () => {
  it('POST reinvio, update fallita: 500 con messaggio fisso e l\'errore INTERO nel log', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    h.erroriUpdate.form_submissions = { code: '23503', message: MSG_INTERNO }
    const res = await POST(req({ submissionId: SUB }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('form_submissions')
    expect(body.error).toBe('Errore interno del server')
    expect(h.errori.at(-1)?.err).toMatchObject({ code: '23503' })
  })

  it('POST creazione, insert fallita: 500 con messaggio fisso e l\'errore INTERO nel log', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    h.erroriInsert.form_submissions = { code: '23503', message: MSG_INTERNO }
    const res = await POST(req({ modelId: MODEL, data: { campo: 'x' } }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('form_submissions')
    expect(h.errori.at(-1)?.err).toMatchObject({ code: '23503' })
  })

  it('PATCH, update fallita: 500 con messaggio fisso e l\'errore INTERO nel log', async () => {
    h.chiamante = { id: G_TITOLARE, role: 'genitore' }
    h.erroriUpdate.form_submissions = { code: '23503', message: MSG_INTERNO }
    const res = await PATCH(req({ submissionId: SUB, code: '424242' }, 'PATCH'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('form_submissions')
    expect(h.errori.at(-1)?.err).toMatchObject({ code: '23503' })
  })
})
