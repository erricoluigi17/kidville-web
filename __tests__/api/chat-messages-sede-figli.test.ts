import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

/**
 * LA SEDE DELLA NOTIFICA DI CHAT È QUELLA DEL BAMBINO DEL THREAD, NON QUELLA DI CHI SCRIVE.
 *
 * ─── IL DIFETTO MISURATO ─────────────────────────────────────────────────────
 * `POST /api/chat/messages` prendeva la sede della notifica così:
 *
 *     const [nome, mittente] = await Promise.all([
 *       nomeUtente(supabase, sender_id),
 *       supabase.from('utenti').select('scuola_id').eq('id', sender_id).maybeSingle(),
 *     ])
 *     await notificaEvento(supabase, { …, scuolaId: mittente.data?.scuola_id ?? null, … })
 *
 * cioè: la sede dell'ACCOUNT DI CHI PREME INVIA. Un genitore può avere due figli
 * in due plessi — `parents` non ha `scuola_id`, ed è una scelta esplicita — e
 * `utenti.scuola_id` di un genitore è al più UNA delle sue sedi: quella con cui
 * l'account è nato. Scrivendo alla maestra dell'ALTRO figlio, la notifica nasceva
 * etichettata col plesso sbagliato. Lo stesso per un docente che lavora su più sedi.
 *
 * ─── PERCHÉ NON È UN'ETICHETTA DECORATIVA ────────────────────────────────────
 * `notificaEvento` passa la sede a `isNotificaAbilitata(supabase, tipo, scuolaId)`,
 * che legge i **toggle di QUEL plesso** (`notifiche_config`). Con la sede sbagliata
 * è l'interruttore di Giugliano a decidere se parte la spinta per un messaggio che
 * riguarda un bambino di Aversa: se Giugliano ha spento `chat_genitore`, il genitore
 * di Aversa non riceve niente e la route risponde comunque 201. La riga finisce
 * anche in `notifiche.sede_id`, cioè nei conteggi per plesso.
 *
 * ─── IL DATO CHE CE L'HA DAVVERO ─────────────────────────────────────────────
 * Il bambino del thread NON è ambiguo: una conversazione parla sempre di UN bambino,
 * e quel bambino ha UN plesso. In mancanza (anagrafica monca) la sede del DOCENTE
 * del thread — lo staff una sede propria ce l'ha sempre, i genitori no. Mai quella
 * del mittente: è il valore che ha creato il guasto.
 *
 * ─── MISURATO IN PRODUZIONE, 2026-09-03 ──────────────────────────────────────
 * 639 account genitore su 639 hanno `utenti.scuola_id` valorizzata (zero a `null`):
 * il ramo sbagliato non è un caso limite, scatta sempre. In 6 di quegli account la
 * sede dell'account contraddice almeno un figlio, e 4 genitori hanno figli in due
 * plessi diversi.
 */

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const ALUNNO = 'cccccccc-0000-4000-8000-000000000003'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  assertGenitore: vi.fn(),
  controparteThread: vi.fn(),
  nomeUtente: vi.fn(),
  notificaEvento: vi.fn(),
  logEvento: vi.fn(),
  inserted: null as Record<string, unknown> | null,
  thread: null as Record<string, unknown> | null,
  /** Sede del bambino del thread. `null` = anagrafica incompleta. */
  sedeAlunno: null as string | null,
  /** Sede dell'account, per uuid: il mittente e il docente ne hanno una DIVERSA. */
  sedePerUtente: {} as Record<string, string | null>,
  /** Errore PostgREST da restituire su una tabella (PostgREST non lancia). */
  erroreSu: null as { tabella: string; code: string } | null,
  /** Ogni `.eq(colonna, valore)` osservato, tabella per tabella. */
  filtri: [] as Array<{ tabella: string; colonna: string; valore: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
vi.mock('@/lib/chat/delivered', () => ({ marcaConsegnati: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ controparteThread: h.controparteThread }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: h.nomeUtente }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

const adminClient = {
  from(table: string) {
    const st = { id: null as unknown }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = (colonna: string, valore: unknown) => {
      h.filtri.push({ tabella: table, colonna, valore })
      if (colonna === 'id') st.id = valore
      return b
    }
    b.is = () => b
    b.maybeSingle = async () => {
      if (h.erroreSu?.tabella === table) return { data: null, error: { code: h.erroreSu.code, message: 'iniettato' } }
      if (table === 'chat_threads') return { data: h.thread, error: null }
      if (table === 'conversazioni_sospensioni') return { data: null, error: null }
      if (table === 'parents') return { data: { consensi_gdpr: { privacy: true, termini: true } }, error: null }
      // `alunni` e `utenti` rispondono PER UUID: è l'unico modo di sapere da
      // quale delle due letture viene la sede che il codice poi usa.
      if (table === 'alunni') return { data: h.sedeAlunno ? { scuola_id: h.sedeAlunno } : null, error: null }
      if (table === 'utenti') {
        const sede = h.sedePerUtente[String(st.id)] ?? null
        return { data: sede ? { scuola_id: sede } : null, error: null }
      }
      return { data: null, error: null }
    }
    b.insert = (row: Record<string, unknown>) => {
      h.inserted = { id: 'msg-new', ...row }
      return { select: () => ({ single: async () => ({ data: h.inserted, error: null }) }) }
    }
    b.update = () => ({ eq: async () => ({ error: null }) })
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/messages/route'

const postReq = (body: unknown) =>
  new Request('http://localhost/api/chat/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** La sede con cui la notifica è stata accodata. */
const sedeNotificata = () =>
  (h.notificaEvento.mock.calls[0]?.[1] as { scuolaId?: string | null } | undefined)?.scuolaId ?? null

beforeEach(() => {
  vi.clearAllMocks()
  // Il genitore ha due figli in due plessi: l'account è nato a Giugliano (SEDE_A)…
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: SEDE_A } })
  h.assertGenitore.mockResolvedValue(null)
  h.controparteThread.mockResolvedValue({ utenteId: TEACHER, versoGenitore: false })
  h.nomeUtente.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
  h.inserted = null
  h.erroreSu = null
  h.filtri = []
  h.thread = { teacher_id: TEACHER, parent_id: PARENT, student_id: ALUNNO }
  // …ma QUESTA conversazione parla del figlio di Aversa (SEDE_B).
  h.sedeAlunno = SEDE_B
  h.sedePerUtente = { [PARENT]: SEDE_A, [TEACHER]: SEDE_B }
})

describe('POST /api/chat/messages — due figli, due sedi', () => {
  it('la notifica porta la sede del BAMBINO del thread, non quella dell’account di chi scrive', async () => {
    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno maestra' }))

    expect(res.status).toBe(201)
    expect(sedeNotificata()).toBe(SEDE_B)
    expect(sedeNotificata()).not.toBe(SEDE_A)
  })

  it('vale anche quando a scrivere è il DOCENTE: decide il bambino, non chi preme', async () => {
    // Una maestra che lavora su più plessi, con l'account nato a Giugliano.
    h.requireUser.mockResolvedValue({ user: { id: TEACHER, role: 'educator', scuola_id: SEDE_A } })
    h.controparteThread.mockResolvedValue({ utenteId: PARENT, versoGenitore: true })
    h.sedePerUtente = { [PARENT]: SEDE_A, [TEACHER]: SEDE_A }
    // Il bambino resta ad Aversa: è l'unica grandezza che vale SEDE_B, quindi
    // se il risultato è SEDE_B può venire solo da lui.
    h.sedeAlunno = SEDE_B

    const res = await POST(postReq({ thread_id: THREAD, content: 'ricevuto' }))

    expect(res.status).toBe(201)
    expect(sedeNotificata()).toBe(SEDE_B)
  })

  it('anagrafica incompleta: ripiega sulla sede del DOCENTE del thread, mai su quella del mittente', async () => {
    h.sedeAlunno = null
    // Le due sedi sono INCROCIATE apposta: il mittente (genitore) sta in A, la
    // maestra del thread in B. Un ripiego sul mittente darebbe A e farebbe rosso.
    h.sedePerUtente = { [PARENT]: SEDE_A, [TEACHER]: SEDE_B }

    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno' }))

    expect(res.status).toBe(201)
    expect(sedeNotificata()).toBe(SEDE_B)
    // …e la lettura di ripiego interroga il DOCENTE, non il mittente.
    const utentiLetti = h.filtri.filter((f) => f.tabella === 'utenti' && f.colonna === 'id').map((f) => f.valore)
    expect(utentiLetti).toContain(TEACHER)
    expect(utentiLetti).not.toContain(PARENT)
  })

  it('nessuna sede attribuibile: il messaggio si salva lo stesso, ma la riga è dichiarata a `error`', async () => {
    // Il messaggio è già in tabella quando si arriva qui: rifiutarlo per una
    // sede mancante butterebbe via una comunicazione fra una famiglia e la
    // scuola per un guasto della NOSTRA anagrafica.
    h.sedeAlunno = null
    h.sedePerUtente = {}

    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno' }))

    expect(res.status).toBe(201)
    expect(sedeNotificata()).toBeNull()
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'sede-non-attribuibile',
    )
    expect(riga).toBeDefined()
    expect(riga![1]).toBe('error')
    expect(riga![2]).toMatchObject({ operazione: 'chat/messages:POST', threadId: THREAD })
  })

  it('PostgREST non lancia: una lettura fallita della sede lascia una riga, non il silenzio', async () => {
    // `{ error }` è l'unico modo di sapere che la lettura è andata male: senza
    // il controllo, «il bambino non ha plesso» e «non ho potuto leggerlo»
    // sarebbero lo stesso valore, `null`.
    h.erroreSu = { tabella: 'alunni', code: '42703' }

    const res = await POST(postReq({ thread_id: THREAD, content: 'buongiorno' }))

    expect(res.status).toBe(201)
    const riga = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'sede-bambino-non-letta',
    )
    expect(riga).toBeDefined()
    expect(riga![2]).toMatchObject({ error_code: '42703' })
    // …e si ripiega sul docente invece di restare senza plesso.
    expect(sedeNotificata()).toBe(SEDE_B)
  })

  it('nei log della sede non finisce nessun dato personale: solo uuid e codici', async () => {
    h.sedeAlunno = null
    h.sedePerUtente = {}
    await POST(postReq({ thread_id: THREAD, content: 'il pediatra ha detto che Marco ha la varicella' }))

    const tutto = JSON.stringify(h.logEvento.mock.calls)
    expect(tutto).not.toContain('varicella')
    expect(tutto).not.toContain('Marco')
    expect(tutto).not.toContain(ALUNNO)
  })
})
