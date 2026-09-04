import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

/**
 * «ONBOARDING COMPLETATO» ARRIVA ALLA SEGRETERIA DEI FIGLI, NON A QUELLA DELL'ACCOUNT.
 *
 * ─── IL DIFETTO ──────────────────────────────────────────────────────────────
 * `POST /api/parent/onboarding` sceglieva così la sede della notifica:
 *
 *     const scuolaId = auth.user.scuola_id ?? (await scuolaUnicaReale(admin))
 *     const destinatari = await staffScuola(admin, scuolaId, [...])
 *
 * `auth.user.scuola_id` è la sede dell'ACCOUNT: il plesso in cui l'account è
 * stato aperto. Un genitore può avere due figli in due plessi — `parents` non ha
 * `scuola_id`, ed è una scelta esplicita — quindi quel valore è al più UNA delle
 * sue sedi. La segreteria dell'altro plesso non sapeva mai che quella famiglia
 * aveva completato la registrazione: nessun errore, nessun log, solo una
 * notifica che non arriva.
 *
 * `scuolaUnicaReale`, l'anello successivo, è DEPRECATA: con tre sedi risponde
 * sempre `null`, quindi non era un ripiego ma un anello morto.
 *
 * ─── PERCHÉ QUI SI AVVISANO TUTTE, INVECE DI RIFIUTARE ───────────────────────
 * Perché non si sta archiviando niente in un plesso: i consensi sono già scritti
 * su `parents`, che una sede non ce l'ha. Qui si decide solo CHI viene
 * informato, e una famiglia seguita da due plessi li riguarda entrambi.
 * Dove invece si SCRIVE una riga la regola resta l'opposta — `segnalazioni:POST`
 * rifiuta piuttosto che indovinare il plesso.
 *
 * ─── IL RIPIEGO CHE RESTA, E PERCHÉ ──────────────────────────────────────────
 * Un genitore può completare l'onboarding PRIMA che il legame col figlio sia
 * scritto. Lì di sedi non ce n'è nessuna da dedurre, e non avvisare nessuno
 * sarebbe peggio che avvisare la sede dell'account: si usa quella, ma **lo si
 * scrive nei log**, perché è una deduzione e non un dato.
 */

const ACCOUNT = 'bbbbbbbb-0000-4000-8000-000000000002'
const PARENT = 'aaaa1111-0000-4000-8000-000000000009'
const FIGLIO_A = 'cccccccc-0000-4000-8000-000000000003'
const FIGLIO_B = 'cccccccc-0000-4000-8000-000000000004'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  notificaEvento: vi.fn(),
  nomeUtente: vi.fn(),
  staffScuola: vi.fn(),
  logEvento: vi.fn(),
  db: {} as DBFinto,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: h.notificaEvento,
  nomeUtente: h.nomeUtente,
}))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: h.staffScuola,
  scuolaUnicaReale: vi.fn(async () => null),
}))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
// `getFigliDiGenitore` NON è mockata: gira davvero sul finto client, così il
// test prova anche che l'unione runtime+anagrafica venga interrogata sul serio.
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    Object.assign(creaFintoSupabase(h.db), {
      auth: { admin: { updateUserById: async () => ({ data: {}, error: null }) } },
    }),
}))

import { POST } from '@/app/api/parent/onboarding/route'

const req = () =>
  new Request('http://localhost/api/parent/onboarding', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ consensi: { privacy: true, termini: true } }),
  })

/** Le sedi con cui è stata accodata una notifica, nell'ordine in cui è successo. */
const sediNotificate = () =>
  h.notificaEvento.mock.calls.map((c) => (c[1] as { scuolaId?: string | null }).scuolaId ?? null)

function dbBase(): DBFinto {
  return {
    parents: [{ id: PARENT, auth_user_id: ACCOUNT, onboarded_at: null, consensi_gdpr: null }],
    consensi_accettazioni: [],
    legame_genitori_alunni: [],
    student_parents: [],
    alunni: [
      { id: FIGLIO_A, scuola_id: SEDE_A },
      { id: FIGLIO_B, scuola_id: SEDE_B },
    ],
    utenti: [{ id: ACCOUNT, ruolo: 'genitore', scuola_id: SEDE_A }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  // L'account è nato a SEDE_A: è il valore che il codice usava come verità.
  h.requireUser.mockResolvedValue({ user: { id: ACCOUNT, role: 'genitore', scuola_id: SEDE_A } })
  h.staffScuola.mockImplementation(async (_c: unknown, sede: string) => [`staff-di-${sede}`])
  h.nomeUtente.mockResolvedValue(null)
})

describe('POST /api/parent/onboarding — la segreteria avvisata viene dai figli', () => {
  it('DUE FIGLI IN DUE PLESSI ⇒ si avvisano ENTRAMBE le segreterie', async () => {
    // Il cuore della richiesta: la famiglia è seguita da due plessi, e nessuno
    // dei due deve restare all'oscuro.
    h.db.legame_genitori_alunni = [
      { genitore_id: ACCOUNT, alunno_id: FIGLIO_A },
      { genitore_id: ACCOUNT, alunno_id: FIGLIO_B },
    ]

    const res = await POST(req() as never)

    expect(res.status).toBe(200)
    expect(sediNotificate().sort()).toEqual([SEDE_A, SEDE_B].sort())
  })

  it('un figlio solo, in un plesso DIVERSO da quello dell\'account ⇒ vince il figlio', async () => {
    // L'account è nato a SEDE_A, il bambino sta a SEDE_B. Prima la notifica
    // andava a SEDE_A e la segreteria di SEDE_B non sapeva niente.
    h.db.legame_genitori_alunni = [{ genitore_id: ACCOUNT, alunno_id: FIGLIO_B }]

    await POST(req() as never)

    expect(sediNotificate()).toEqual([SEDE_B])
  })

  it('il legame passa anche per l\'ANAGRAFICA, non solo per il runtime', async () => {
    // `getFigliDiGenitore` unisce due tabelle ponte: un legame scritto solo in
    // `student_parents` deve contare come gli altri.
    h.db.student_parents = [{ parent_id: PARENT, student_id: FIGLIO_B }]

    await POST(req() as never)

    expect(sediNotificate()).toEqual([SEDE_B])
  })

  it('NESSUN figlio ⇒ si ripiega sulla sede dell\'account, ma lo si dichiara', async () => {
    // L'onboarding si può completare prima che il legame esista. Non avvisare
    // nessuno sarebbe peggio; ma un dato dedotto va scritto come tale.
    const res = await POST(req() as never)

    expect(res.status).toBe(200)
    expect(sediNotificate()).toEqual([SEDE_A])
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'sede-onboarding-dedotta-dall-account',
    )
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('info')
  })

  it('due figli nello STESSO plesso ⇒ una notifica sola, non una per figlio', async () => {
    h.db.alunni = [
      { id: FIGLIO_A, scuola_id: SEDE_B },
      { id: FIGLIO_B, scuola_id: SEDE_B },
    ]
    h.db.legame_genitori_alunni = [
      { genitore_id: ACCOUNT, alunno_id: FIGLIO_A },
      { genitore_id: ACCOUNT, alunno_id: FIGLIO_B },
    ]

    await POST(req() as never)

    expect(sediNotificate()).toEqual([SEDE_B])
  })

  it('nei log della sede non finisce nessun dato personale', async () => {
    h.db.legame_genitori_alunni = [{ genitore_id: ACCOUNT, alunno_id: FIGLIO_A }]
    await POST(req() as never)
    for (const [, , campi] of h.logEvento.mock.calls) {
      const testo = JSON.stringify(campi ?? {})
      expect(testo).not.toContain('@')
    }
  })
})
