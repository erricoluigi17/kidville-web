import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * LA SEDE DELLA SOSPENSIONE È QUELLA DEL BAMBINO DEL THREAD, MAI QUELLA DELL'ACCOUNT.
 *
 * ─── IL DIFETTO MISURATO ─────────────────────────────────────────────────────
 * `POST /api/chat/threads/[id]/sospendi` sceglieva la sede così:
 *
 *     let scuolaId = auth.user.scuola_id ?? null
 *     if (!scuolaId && thread.student_id) { … sede del bambino … }
 *     if (!scuolaId) scuolaId = await scuolaUnicaReale(supabase)
 *
 * cioè: la sede dell'ACCOUNT per prima, e il bambino solo come ripiego. Un
 * genitore può avere due figli in due plessi — `parents` non ha `scuola_id`, ed è
 * una scelta esplicita — quindi `utenti.scuola_id` di un genitore è, nel migliore
 * dei casi, UNA delle sue sedi: quella con cui l'account è nato. Sospendendo la
 * conversazione col docente dell'ALTRO figlio, la riga nasceva nel plesso
 * sbagliato e la notifica «Conversazione sospesa» arrivava alla Direzione che su
 * quella conversazione non ha titolo — mentre quella competente non sapeva nulla.
 *
 * Il bambino del thread NON è ambiguo: un thread di chat parla sempre di UN
 * bambino, e quel bambino ha UN plesso. È il dato che ce l'ha davvero.
 *
 * `scuolaUnicaReale` è DEPRECATA (con tre sedi risponde sempre `null`): non è più
 * un ripiego, è un anello morto — e qui, prima, era l'ultimo anello di una catena
 * che partiva dal dato sbagliato.
 */

const TEACHER = 'aaaaaaaa-0000-4000-8000-000000000001'
const PARENT = 'bbbbbbbb-0000-4000-8000-000000000002'
const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const ALUNNO = 'cccccccc-0000-4000-8000-000000000003'

/** Le tre sedi reali. L'account del genitore è nato a Giugliano… */
const GIUGLIANO = '11111111-0000-4000-8000-00000000aaaa'
/** …ma il bambino di QUESTA conversazione sta ad Aversa. */
const AVERSA = '22222222-0000-4000-8000-00000000bbbb'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  staffScuola: vi.fn(),
  scuolaUnicaReale: vi.fn(),
  notificaEvento: vi.fn(),
  thread: null as Record<string, unknown> | null,
  /** Sede del bambino del thread: `null` = anagrafica incompleta. */
  sedeAlunno: null as string | null,
  /**
   * Sede dell'account, PER UUID.
   *
   * ⚠️ Era un singolo `sedeDocente`, e la tabella `utenti` rispondeva quel
   * valore a QUALUNQUE id. Con un finto client che non guarda chi gli viene
   * chiesto, «leggo la sede del docente del thread» e «leggo la sede di chi
   * preme il pulsante» sono la stessa cosa: sostituendo `thread.teacher_id` con
   * `uid` nella route — cioè ripiantando esattamente il difetto che questo file
   * dichiara di coprire — la suite restava verde 5 su 5. Rispondere per uuid è
   * l'unico modo di sapere DA QUALE lettura viene la sede che il codice poi usa.
   */
  sedePerUtente: {} as Record<string, string | null>,
  inserted: null as Record<string, unknown> | null,
  tabelleLette: [] as string[],
  /** Ogni `.eq(colonna, valore)` osservato, tabella per tabella. */
  filtri: [] as Array<{ tabella: string; colonna: string; valore: unknown }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  staffScuola: h.staffScuola,
  scuolaUnicaReale: h.scuolaUnicaReale,
}))

const adminClient = {
  from(table: string) {
    h.tabelleLette.push(table)
    const st = { didInsert: false, id: null as unknown }
    const b: Record<string, unknown> = {}
    b.select = () => b
    // I filtri si REGISTRANO, come in `chat-messages-sede-figli.test.ts`: un
    // `b.eq = () => b` accetta e dimentica, e un mock che dimentica certifica
    // qualunque cosa.
    b.eq = (colonna: string, valore: unknown) => {
      h.filtri.push({ tabella: table, colonna, valore })
      if (colonna === 'id') st.id = valore
      return b
    }
    b.is = () => b
    b.insert = (row: Record<string, unknown>) => {
      st.didInsert = true
      h.inserted = row
      return b
    }
    b.maybeSingle = async () => {
      if (table === 'chat_threads') return { data: h.thread, error: null }
      if (table === 'alunni') return { data: h.sedeAlunno ? { scuola_id: h.sedeAlunno } : null, error: null }
      if (table === 'utenti') {
        // Risponde PER UUID: la sede che esce dice quale account è stato letto.
        const sede = h.sedePerUtente[String(st.id)] ?? null
        return { data: sede ? { scuola_id: sede } : null, error: null }
      }
      if (table === 'conversazioni_sospensioni') {
        if (st.didInsert) return { data: { id: 'sosp-new' }, error: null }
        return { data: null, error: null }
      }
      return { data: null, error: null }
    }
    return b
  },
}
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => adminClient }))

import { POST } from '@/app/api/chat/threads/[id]/sospendi/route'

const req = (body: unknown) =>
  new Request(`http://localhost/api/chat/threads/${THREAD}/sospendi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const ctx = { params: Promise.resolve({ id: THREAD }) }

beforeEach(() => {
  vi.clearAllMocks()
  // Il genitore ha DUE figli in DUE plessi: il suo account porta Giugliano.
  h.requireUser.mockResolvedValue({ user: { id: PARENT, role: 'genitore', scuola_id: GIUGLIANO } })
  h.staffScuola.mockResolvedValue(['direzione-1'])
  h.scuolaUnicaReale.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
  h.thread = { teacher_id: TEACHER, parent_id: PARENT, student_id: ALUNNO }
  h.sedeAlunno = AVERSA
  // Le due sedi sono INCROCIATE apposta: l'account di chi preme (il genitore)
  // porta Giugliano, la maestra del thread Aversa. Un ripiego su chi preme darebbe
  // Giugliano, e ogni asserzione su Aversa diventerebbe rossa.
  h.sedePerUtente = { [PARENT]: GIUGLIANO, [TEACHER]: AVERSA }
  h.inserted = null
  h.tabelleLette = []
  h.filtri = []
})

/** I valori con cui è stata interrogata una tabella per `id`. */
const lettiPerId = (tabella: string) =>
  h.filtri.filter((f) => f.tabella === tabella && f.colonna === 'id').map((f) => f.valore)

describe('POST /api/chat/threads/[id]/sospendi — due figli, due sedi', () => {
  it('archivia la sospensione nel plesso del BAMBINO del thread, non in quello dell’account', async () => {
    const res = await POST(req({ motivo: 'toni sgradevoli' }), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ thread_id: THREAD, scuola_id: AVERSA })
    expect((h.inserted as { scuola_id?: string }).scuola_id).not.toBe(GIUGLIANO)
    // …e la sede è stata chiesta al BAMBINO DEL THREAD, per uuid.
    expect(lettiPerId('alunni')).toEqual([ALUNNO])
  })

  it('notifica la Direzione della sede del bambino, non quella dell’account', async () => {
    await POST(req({}), ctx)
    expect(h.staffScuola).toHaveBeenCalledWith(expect.anything(), AVERSA, expect.any(Array))
    expect(h.staffScuola).not.toHaveBeenCalledWith(expect.anything(), GIUGLIANO, expect.any(Array))
    expect(h.notificaEvento).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tipo: 'conversazione_sospesa', scuolaId: AVERSA }),
    )
  })

  it('vale anche quando a sospendere è il DOCENTE: decide il bambino, non chi preme', async () => {
    // Il docente lavora su più plessi e il suo account porta Giugliano.
    h.requireUser.mockResolvedValue({ user: { id: TEACHER, role: 'educator', scuola_id: GIUGLIANO } })
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ scuola_id: AVERSA })
  })

  it('anagrafica incompleta: ripiega sulla sede del DOCENTE del thread, mai su quella di chi preme', async () => {
    // Il bambino non porta il plesso, quindi si arriva al ripiego. Le sedi degli
    // account sono incrociate (genitore→Giugliano, docente→Aversa): il risultato
    // dice, da solo, quale dei due è stato letto.
    h.sedeAlunno = null
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ scuola_id: AVERSA })
    // …e non è una coincidenza aritmetica: `utenti` è stata interrogata con
    // l'uuid del DOCENTE DEL THREAD, mai con quello di chi ha premuto.
    expect(lettiPerId('utenti')).toContain(TEACHER)
    expect(lettiPerId('utenti')).not.toContain(PARENT)
    // L'anello morto non si interroga più: con tre sedi risponde sempre `null`.
    expect(h.scuolaUnicaReale).not.toHaveBeenCalled()
  })

  it('nessuna sede attribuibile: la sospensione si scrive lo stesso (è una tutela), ma la riga è dichiarata', async () => {
    // Bloccare la sospensione perché manca un plesso significherebbe lasciare due
    // persone dentro una conversazione che una delle due ha chiesto di fermare.
    h.sedeAlunno = null
    h.sedePerUtente = {}
    const res = await POST(req({}), ctx)
    expect(res.status).toBe(201)
    expect(h.inserted).toMatchObject({ scuola_id: null })
  })
})
