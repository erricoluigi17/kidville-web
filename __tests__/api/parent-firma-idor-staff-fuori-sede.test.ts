import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { makeTicket } from '@/lib/auth/otp-ticket'

/**
 * L'IDOR CHE NON ERA UNA CONVERSIONE — due righe scritte come un permesso, che
 * per tutti tranne uno non controllavano niente.
 *
 * `parent/submissions:POST` e `parent/forms/otp:PATCH` avevano entrambe questa
 * forma:
 *
 *     if (student_id && auth.user.role === 'genitore' && !haIlLegame(...)) → 403
 *
 * Letta ad alta voce: «se sei un genitore e quel bambino non è tuo figlio, ti
 * nego». Il che significa, letteralmente, che per chiunque NON avesse il ruolo
 * attivo `genitore` — la cuoca, la segreteria di un altro plesso, l'educator di
 * un'altra sede, e la docente-genitore che stesse guardando in veste di lavoro —
 * il controllo NON ESISTEVA. Non era permissivo: era assente. E le due rotte non
 * leggono: la prima ARCHIVIA una compilazione a nome di quel bambino, la seconda
 * FIRMA un modulo con valore legale (FES, art. 20 CAD).
 *
 * Il fatto che la vittima tipica fosse improbabile non toglie niente al difetto:
 * `requireUser` ammette ogni utente autenticato, e questi `if` erano l'unica cosa
 * fra un account qualunque e il fascicolo di un minore indicato per uuid.
 *
 * ─── PERCHÉ IL RIMEDIO NON È `eFamiglia` ──────────────────────────────────────
 *
 * Perché scambiare il predicato lascerebbe intatta la forma del difetto: si
 * negherebbe al genitore senza legame e si continuerebbe a non chiedere niente a
 * tutti gli altri. La domanda giusta non è «di che ruolo sei», è «questo bambino
 * ti è raggiungibile?» — che è esattamente ciò che `requireParentOfStudent`
 * risponde: legame di famiglia per chi è famiglia, plesso e sezione per tutti gli
 * altri, e la biforcazione è sul LEGAME, non sulla veste.
 *
 * ─── COSA ASSERISCE QUESTO FILE, E COME L'HA VISTO FALLIRE ────────────────────
 *
 * Asserisce lo STATO della risposta, non che una funzione sia stata chiamata.
 * Prima del rimedio, con il gate mockato a 403 (cioè: «bambino non raggiungibile
 * da costui»), entrambe le rotte rispondevano `201` e `persistSignedSubmission`
 * veniva invocata — perché la riga `role === 'genitore'` non scattava mai su una
 * segreteria. Il test è nato ROSSO su quattro asserzioni, ed è la ragione per cui
 * esiste.
 */

const STAFF_ALTRA_SEDE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01'
const GENITORE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11'
const FORM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10'
/** Il minore di un'altra sede: per lo staff che chiede, un uuid e nient'altro. */
const STUDENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa20'

const h = vi.hoisted(() => ({
  /** Chi bussa: identità restituita da `requireUser`. */
  utente: { id: '', role: '' as string, scuola_id: null as string | null },
  /** `true` = il gate sull'alunno risponde 403 (bambino non raggiungibile). */
  gateNega: false,
  /** Quante volte il gate sull'alunno è stato interrogato. */
  gateChiamate: 0,
  /** Quante submission sono state davvero persistite. */
  persistCalls: 0,
  consumati: new Set<string>(),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({
    from(table: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit', 'in', 'update']) qb[m] = () => qb
      qb.maybeSingle = () =>
        Promise.resolve({ data: { email: 'p@x.it', nome: 'N', cognome: 'C', scuola_id: null }, error: null })
      qb.single = () => Promise.resolve({ data: { email: 'p@x.it' }, error: null })
      qb.insert = (v: { jti?: string }) => {
        if (table === 'otp_ticket_consumati') {
          const jti = String(v.jti)
          if (h.consumati.has(jti)) return Promise.resolve({ error: { code: '23505' } })
          h.consumati.add(jti)
          return Promise.resolve({ error: null })
        }
        return Promise.resolve({ error: null })
      }
      return qb
    },
  }),
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn().mockImplementation(async () => ({ user: { ...h.utente } })),
}))

vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: vi.fn().mockImplementation(async () => {
    h.gateChiamate++
    return h.gateNega
      ? { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
      : { user: { ...h.utente } }
  }),
}))

// Il legame «grezzo»: risponde SEMPRE di sì. Se il rimedio si limitasse a
// scambiare il predicato lasciando in piedi questa chiamata, il test resterebbe
// rosso — è la sua utilità.
vi.mock('@/lib/anagrafiche/legami', () => ({
  genitoreHasFiglio: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/pagamenti/sospensione', () => ({
  assertGenitoreNonSospeso: vi.fn().mockResolvedValue(null),
  assertGenitoreNonSospesoSalvoEssenziale: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/forms/sempre-firmabile', () => ({
  leggiSempreFirmabile: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/forms/persist-submission', () => ({
  persistSignedSubmission: vi.fn().mockImplementation(async () => {
    h.persistCalls++
    return { submission: { id: 'sub-1' }, status: 201 }
  }),
}))

vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: vi.fn().mockResolvedValue([]),
  scuolaUnicaReale: vi.fn().mockResolvedValue(null),
}))

vi.mock('@/lib/security/otp-rate-limit', () => ({
  limitaInvioOtp: vi.fn().mockResolvedValue(null),
  limitaVerificaOtp: vi.fn().mockResolvedValue(null),
}))

import { POST as SUBMISSIONS_POST } from '@/app/api/parent/submissions/route'
import { PATCH as OTP_PATCH } from '@/app/api/parent/forms/otp/route'

function req(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never
}

function submissionsReq(studentId?: string) {
  return req('http://localhost/api/parent/submissions', 'POST', {
    form_id: FORM_ID,
    student_id: studentId,
    answers: { a: 1 },
  })
}

function otpReq(studentId?: string) {
  const code = '424242'
  const expiry = Date.now() + 10 * 60 * 1000
  return req('http://localhost/api/parent/forms/otp', 'PATCH', {
    code,
    expiry,
    ticket: makeTicket('p@x.it', code, expiry),
    form_id: FORM_ID,
    student_id: studentId,
    answers: { a: 1 },
  })
}

beforeEach(() => {
  h.utente = { id: GENITORE, role: 'genitore', scuola_id: null }
  h.gateNega = false
  h.gateChiamate = 0
  h.persistCalls = 0
  h.consumati = new Set()
})

describe('IDOR: uno staff fuori sede compila a nome di un minore non suo', () => {
  beforeEach(() => {
    h.utente = { id: STAFF_ALTRA_SEDE, role: 'segreteria', scuola_id: null }
    h.gateNega = true
  })

  it('POST /api/parent/submissions → 403, e NIENTE viene archiviato', async () => {
    const r = await SUBMISSIONS_POST(submissionsReq(STUDENT_ID))
    expect(r.status).toBe(403)
    expect(h.persistCalls, 'una compilazione archiviata è già il danno').toBe(0)
  })

  it('PATCH /api/parent/forms/otp → 403, e NESSUNA firma con valore legale', async () => {
    const r = await OTP_PATCH(otpReq(STUDENT_ID))
    expect(r.status).toBe(403)
    expect(h.persistCalls, 'una firma FES a nome del genitore di un altro bambino').toBe(0)
  })
})

describe('il perimetro legittimo non si stringe', () => {
  it('il genitore col legame firma e archivia come prima (201)', async () => {
    const r1 = await SUBMISSIONS_POST(submissionsReq(STUDENT_ID))
    expect(r1.status).toBe(201)
    const r2 = await OTP_PATCH(otpReq(STUDENT_ID))
    expect(r2.status).toBe(201)
    expect(h.persistCalls).toBe(2)
  })

  it('senza `student_id` (onboarding) il gate sull’alunno non si interroga affatto', async () => {
    // Il modulo di onboarding si compila PRIMA che esista un bambino a cui
    // riferirlo: chiedere «di chi è figlio» non avrebbe risposta, e negare qui
    // chiuderebbe fuori ogni nuova famiglia. Il gate resta legato a `student_id`.
    h.gateNega = true
    const r = await SUBMISSIONS_POST(submissionsReq(undefined))
    expect(r.status).toBe(201)
    expect(h.gateChiamate).toBe(0)
  })

  it('anche un utente di staff con titolo su quel bambino passa (il gate risolve la sede)', async () => {
    // `requireParentOfStudent` non è «solo per i genitori»: per chi non è
    // famiglia verifica plesso e sezione. Una segreteria del plesso GIUSTO deve
    // continuare a poter compilare per quel bambino — è il suo mestiere.
    h.utente = { id: STAFF_ALTRA_SEDE, role: 'segreteria', scuola_id: null }
    h.gateNega = false
    const r = await SUBMISSIONS_POST(submissionsReq(STUDENT_ID))
    expect(r.status).toBe(201)
    expect(h.gateChiamate).toBe(1)
  })
})
