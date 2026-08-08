/**
 * `POST /api/parent/presenze/giustifica` — la quarta lezione che la porta
 * gemella aveva già imparato.
 *
 * IL FATTO (terzo collaudo, rilievo T14). Il file dichiara in testa «LE TRE COSE
 * CHE LA PORTA GEMELLA AVEVA GIÀ IMPARATO» e ne elenca tre: il motivo vuoto che
 * non cancella, la `select` di due colonne invece di venticinque, la prosa di
 * PostgREST che non esce. La quarta — **PostgREST non lancia, ritorna
 * `{ error }`** (AGENTS.md, regola 7) — era rimasta fuori, su una rotta con una
 * firma elettronica appesa:
 *
 *   const { data: alunno } = await supabase.from('alunni')…      → 404 «Alunno non trovato»
 *   const { data: sez }    = await supabase.from('sections')…    → 403 «solo per la primaria»
 *   const { data: anagrafica } = await supabase.from('alunni')…  → notifica con «un alunno»
 *
 * Un guasto di lettura usciva quindi da due porte di MERITO: al genitore di
 * primaria, con l'OTP appena verificato, si diceva che suo figlio non esiste
 * oppure che la giustifica non spetta al suo grado — e la firma non veniva
 * registrata, senza una riga che lo spiegasse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const GENITORE = 'a0000000-0000-4000-8000-000000000001'
const ALUNNO = 'b0000000-0000-4000-8000-000000000002'
const SEZIONE = 'c0000000-0000-4000-8000-000000000003'
const SEDE = 'd0000000-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({
  erroreAlunno: null as { code: string; message: string } | null,
  alunnoAssente: false,
  erroreSezione: null as { code: string; message: string } | null,
  schoolType: 'primaria' as string | null,
  erroreAnagrafica: null as { code: string; message: string } | null,
  /** Le tabelle su cui è stata chiamata `.update()`: la scrittura è avvenuta? */
  scritture: [] as string[],
}))

vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: vi.fn(async () => ({ user: { id: GENITORE, role: 'genitore' }, response: null })),
}))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: vi.fn(async () => null) }))
vi.mock('@/lib/auth/otp-ticket', () => ({
  getUserEmail: vi.fn(async () => 'genitore@example.test'),
  verifyTicket: vi.fn(() => ({ ok: true })),
  codeHash: vi.fn(() => 'hash'),
}))
vi.mock('@/lib/fea/signature-log', () => ({
  buildSignatureLog: vi.fn(() => ({ method: 'OTP_EMAIL', hash: 'hash' })),
  extractRequestMeta: vi.fn(() => ({ ip: '0.0.0.0', userAgent: 'test' })),
}))
vi.mock('@/lib/fea/slots', () => ({ recordSignerSlot: vi.fn(async () => undefined) }))
vi.mock('@/lib/fea/audit', () => ({ logFeaEvent: vi.fn(async () => undefined) }))
vi.mock('@/lib/settings/module-config', () => ({
  getModuleConfig: vi.fn(async () => ({ giustifica_max_giorni_retroattivi: 3650, giustifica_richiede_firma_otp: false })),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined), nomeUtente: vi.fn() }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: vi.fn(async () => []) }))
vi.mock('@/lib/security/otp-rate-limit', () => ({ limitaVerificaOtp: vi.fn(async () => null) }))

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      let colonne = ''
      let scrittura = false
      for (const m of ['eq', 'in', 'order', 'limit', 'is', 'not']) qb[m] = () => qb
      qb.select = (c?: string) => {
        colonne = c ?? ''
        return qb
      }
      qb.update = () => {
        scrittura = true
        h.scritture.push(tabella)
        return qb
      }
      qb.maybeSingle = async () => {
        if (scrittura) return { data: { id: 'presenza-1' }, error: null }
        if (tabella === 'sections') {
          return h.erroreSezione
            ? { data: null, error: h.erroreSezione }
            : { data: { school_type: h.schoolType }, error: null }
        }
        // `alunni`: due letture diverse, distinte dalle colonne richieste.
        if (colonne.includes('nome')) {
          return h.erroreAnagrafica
            ? { data: null, error: h.erroreAnagrafica }
            : { data: { nome: 'Bimbo', cognome: 'Test' }, error: null }
        }
        if (h.erroreAlunno) return { data: null, error: h.erroreAlunno }
        if (h.alunnoAssente) return { data: null, error: null }
        return { data: { id: ALUNNO, section_id: SEZIONE, scuola_id: SEDE }, error: null }
      }
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return qb
    },
  })),
}))

import { POST } from '@/app/api/parent/presenze/giustifica/route'

const req = () =>
  new NextRequest('http://localhost/api/parent/presenze/giustifica', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentId: ALUNNO, data: '2026-08-06', motivo: 'febbre' }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  h.erroreAlunno = null
  h.alunnoAssente = false
  h.erroreSezione = null
  h.schoolType = 'primaria'
  h.erroreAnagrafica = null
  h.scritture = []
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T14 — l’anagrafica non letta non è «Alunno non trovato»', () => {
  it('lettura fallita → 500, mai il 404 che mente', async () => {
    h.erroreAlunno = { code: '42501', message: 'permission denied for table alunni' }
    const res = await POST(req())
    expect(res.status).toBe(500)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('Alunno non trovato')
    expect(corpo, 'la prosa di PostgREST resta nel log').not.toContain('permission denied')
  })

  it('lettura fallita → una riga `error` con il codice PostgREST, e NESSUNA scrittura', async () => {
    h.erroreAlunno = { code: '42501', message: 'permission denied for table alunni' }
    await POST(req())
    expect(JSON.stringify(logErrore.mock.calls)).toContain('42501')
    expect(h.scritture, 'niente firma su una riga scelta al buio').toHaveLength(0)
  })

  it('alunno davvero assente: resta il 404 di sempre', async () => {
    h.alunnoAssente = true
    const res = await POST(req())
    expect(res.status).toBe(404)
    expect(JSON.stringify(await res.json())).toContain('Alunno non trovato')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T14 — il grado non letto non è «non sei della primaria»', () => {
  it('lettura di `sections` fallita → NON il 403 di merito', async () => {
    h.erroreSezione = { code: '42501', message: 'permission denied for table sections' }
    const res = await POST(req())
    const corpo = JSON.stringify(await res.json())
    expect(
      corpo,
      'un guasto di lettura non può travestirsi da «giustifica riservata alla primaria»',
    ).not.toContain('solo per la scuola primaria')
    expect(res.status).toBe(500)
  })

  it('lettura di `sections` fallita → resta una riga di log che dice perché', async () => {
    h.erroreSezione = { code: '42501', message: 'permission denied for table sections' }
    await POST(req())
    const tutto = JSON.stringify([...logEvento.mock.calls, ...logErrore.mock.calls])
    expect(tutto).toContain('42501')
  })

  it('grado davvero diverso dalla primaria: resta il 403 di merito', async () => {
    h.schoolType = 'infanzia'
    const res = await POST(req())
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).toContain('solo per la scuola primaria')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T14 — l’anagrafica della notifica: degrada, ma non in silenzio', () => {
  it('lettura fallita → la giustifica resta registrata (200) e la lacuna si logga', async () => {
    h.erroreAnagrafica = { code: '42501', message: 'permission denied for table alunni' }
    const res = await POST(req())
    expect(res.status).toBe(200)
    const riga = logEvento.mock.calls.find((c) => JSON.stringify(c[2]).includes('anagrafica-non-letta'))
    expect(riga, 'il docente riceve «un alunno» al posto del nome: va detto perché').toBeTruthy()
  })
})
