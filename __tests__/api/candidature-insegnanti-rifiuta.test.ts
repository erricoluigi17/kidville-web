import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { madreSopravvive, materializzaEmbedSede, togliGliEmbed } from '../helpers/embed-sede'

// =============================================================================
// «RIFIUTA»: il gesto che NON crea niente.
//
//  · nessun account, nessuna riga `utenti`: una candidatura rifiutata non deve
//    lasciare dietro di sé un accesso;
//  · il claim vale anche qui — chi arriva secondo prende 409, non sovrascrive in
//    silenzio la decisione di una collega;
//  · il MOTIVO è una nota interna: sta in tabella, NON nell'audit e NON nei log
//    (`redact` lo redigerebbe comunque, ma un testo libero non si spedisce a un
//    canale che si legge tutti i giorni);
//  · l'email di cortesia parte SOLO se l'operatore l'ha chiesto, e non riporta
//    nessuna motivazione: quello che si scrive in segreteria non è quello che si
//    dice alla persona.
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }
const CANDIDATURA_ID = 'dddddddd-0000-4000-8000-00000000000a'
const EMAIL = 'prova.candidata@example.test'
const MOTIVO = 'Nota interna di prova: profilo non adatto alla fascia richiesta'

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    inserimenti: [] as { table: string; row: Riga }[],
    aggiornamenti: [] as { table: string; patch: Riga }[],
    creazioniAuth: [] as { email: string }[],
    /** Colonne che il DB (finto) dichiara assenti sull'UPDATE (CI non migrata). */
    colonneAssentiUpdate: [] as string[],
  }
  return { state, requireStaff: vi.fn(), logScrittura: vi.fn(), logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn(), sendEmail: vi.fn() }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// ⚠️ `formaConfronto` è quella VERA, non un finto. È la funzione che decide se
// un uuid del client è la stessa sede di una letta dal database, e sostituirla
// con `(x) => x` renderebbe verde proprio il difetto che il caso «maiuscolo»
// esiste per provare: un mock che semplifica la regola prova la semplificazione.
vi.mock('@/lib/auth/scope', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/auth/scope')>()
  return { formaConfronto: vero.formaConfronto, resolveScuoleAttive: async () => h.state.scuole }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.logEvento, logErrore: h.logErrore, logOk: h.logOk }))
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>()
  return { ...actual, sendEmailDetailed: h.sendEmail }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  const senzaEmbed = togliGliEmbed(cols)
  for (const c of senzaEmbed.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

/** Le righe di sede di una candidatura, dal magazzino del finto. */
function sediFinteDi(tabelle: Record<string, Riga[]>, idCandidatura: unknown): Riga[] {
  return (tabelle['candidature_sedi'] ?? []).filter((s) => s.candidatura_id === idCandidatura)
}

/**
 * La riga proiettata PIÙ i suoi array incorporati, come li consegna PostgREST:
 * ogni embed col proprio alias e le SOLE colonne che ha chiesto, il primo
 * ristretto dal filtro di sede. Vedi `__tests__/helpers/embed-sede.ts`.
 */
function conEmbed(r: Riga, cols: string, filtri: Filtro[]): Riga {
  return {
    ...proietta(r, cols),
    ...materializzaEmbedSede(cols, sediFinteDi(h.state.tabelle, r.id), filtri),
  }
}

/**
 * IL TRIGGER `candidature_sedi_aggrega`, RIFATTO NEL FINTO.
 *
 * In produzione lo stato di `candidature_insegnanti` non lo scrive più la rotta:
 * lo ricalcola un trigger dalle righe di sede. Un finto che non lo simulasse
 * lascerebbe la candidatura a `pending` per sempre — e qualcuno, per far passare
 * i test, rimetterebbe nella rotta la scrittura diretta, reintroducendo le due
 * autorità sulla stessa colonna che la migrazione ha appena tolto.
 */
function aggregaComeIlTrigger(tabelle: Record<string, Riga[]>, idCandidatura: unknown): void {
  const sedi = sediFinteDi(tabelle, idCandidatura)
  if (sedi.length === 0) return
  const stato = sedi.some((s) => s.stato === 'pending')
    ? 'pending'
    : sedi.some((s) => s.stato === 'approvata')
      ? 'approvata'
      : 'rifiutata'
  /**
   * ⚠️ IL FINTO PROPAGA ANCHE `evasa_il` ED `evasa_da`, e prima no.
   *
   * Riprodurre il solo `stato` lasciava senza copertura la metà del trigger che
   * esiste per il GDPR: `retention-candidature` legge `candidature_insegnanti.evasa_il`
   * per far decorrere i dodici mesi dalla DECISIONE invece che dalla ricezione.
   * Un ritorno alla versione del 19/08 — quella che riportava solo lo stato —
   * sarebbe rimasto verde, e la cancellazione anticipata sarebbe tornata senza
   * che un test lo dicesse.
   *
   * Stessa regola del database: la data è la PIÙ RECENTE, e solo quando nessuna
   * sede è più in valutazione; i due campi si muovono insieme, senza `coalesce`.
   */
  const decise = sedi.filter((s) => s.stato !== 'pending')
  const nessunaInAttesa = decise.length === sedi.length
  const ultima = nessunaInAttesa
    ? decise
        .filter((s) => s.evasa_il)
        .sort((a, b) => String(b.evasa_il).localeCompare(String(a.evasa_il)))[0]
    : undefined
  const madre = (tabelle['candidature_insegnanti'] ?? []).find((c) => c.id === idCandidatura)
  if (madre) {
    madre.stato = stato
    madre.evasa_il = ultima?.evasa_il ?? null
    madre.evasa_da = ultima?.evasa_da ?? null
  }
}

function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      let cols = '*'
      let patch: Riga | null = null
      let inserimento: Riga | null = null
      const corrisponde = (r: Riga) =>
        // I filtri sulle colonne della madre, uno per uno…
        filtri.every((f) => (f.col.includes('.') ? true : f.vals.some((v) => r[f.col] === v))) &&
        // …e quelli sull'EMBED, che seguono la regola POSIZIONALE di PostgREST:
        // il filtro va al PRIMO embed della `select`, e la madre sparisce solo
        // se quello porta `!inner`. La regola vive in un posto solo — era
        // ricopiata in quattro finti, e in tutti e quattro era la stessa
        // approssimazione cieca. Vedi `__tests__/helpers/embed-sede.ts`.
        madreSopravvive(cols, sediFinteDi(h.state.tabelle, r.id), filtri)
      const esegui = () => {
        if (inserimento) {
          const riga = { ...inserimento }
          righeDi(table).push(riga)
          h.state.inserimenti.push({ table, row: riga })
          return { data: [riga], error: null, count: null as number | null }
        }
        if (patch) {
          const assente = h.state.colonneAssentiUpdate.find((c) => c in (patch as Riga))
          if (assente) {
            return {
              data: [] as Riga[],
              error: { code: 'PGRST204', message: `Could not find the '${assente}' column of '${table}' in the schema cache` },
              count: null as number | null,
            }
          }
        }
        const trovate = righeDi(table).filter(corrisponde)
        if (patch) {
          for (const r of trovate) Object.assign(r, patch)
          h.state.aggiornamenti.push({ table, patch: { ...patch } })
          // Il trigger: dopo una scrittura sulle righe di sede, lo stato della
          // candidatura si ricalcola. Vedi `aggregaComeIlTrigger`.
          if (table === 'candidature_sedi') {
            for (const r of trovate) aggregaComeIlTrigger(h.state.tabelle, r.candidatura_id)
          }
          return { data: trovate.map((r) => conEmbed(r, cols, filtri)), error: null, count: null }
        }
        return { data: trovate.map((r) => conEmbed(r, cols, filtri)), error: null, count: null }
      }
      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { if (typeof c === 'string') cols = c; return b }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.order = () => b
      b.range = () => b
      b.limit = () => b
      b.update = (v: Riga) => { patch = v; return b }
      b.insert = (v: Riga) => { inserimento = v; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://x' }, error: null }) }) },
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async ({ email }: { email: string }) => {
          h.state.creazioniAuth.push({ email })
          return { data: { user: { id: 'auth-1' } }, error: null }
        },
      },
    },
  }
}

import { PATCH } from '@/app/api/admin/candidature-insegnanti/route'

const URL_ROUTE = 'http://localhost/api/admin/candidature-insegnanti'
const patch = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
/** ⚠️ `scuola_id` nel corpo: vedi il gemello in `-approva.test.ts`. */
const rifiuta = (extra: Riga = {}) =>
  PATCH(patch({ id: CANDIDATURA_ID, action: 'rifiuta', scuola_id: SEDE_A, ...extra }))

beforeEach(() => {
  vi.clearAllMocks()
  h.state.utente = ADMIN
  h.state.scuole = [SEDE_A, SEDE_B]
  h.state.inserimenti = []
  h.state.aggiornamenti = []
  h.state.creazioniAuth = []
  h.state.colonneAssentiUpdate = []
  h.state.tabelle = {
    // ⚠️ Le righe di sede si seminano SEMPRE insieme alle candidature: dal
    // 2026-08-19 sono il criterio d'accesso del cockpit ED è lì che il verdetto
    // si scrive. Senza, ogni lettura è vuota e ogni scrittura non tocca niente:
    // i test misurerebbero un magazzino vuoto credendo di misurare la rotta.
    // (Le righe vere si aggiungono in coda a questo blocco, vedi `sediPerLeCandidature`.)
    candidature_insegnanti: [
      {
        id: CANDIDATURA_ID,
        scuola_id: SEDE_A,
        stato: 'pending',
        nome: 'Prova',
        cognome: 'Cognome',
        email: EMAIL,
        telefono: null,
        gradi: ['infanzia'],
        creata_il: '2026-08-10T08:00:00.000Z',
      },
    ],
    schools: [{ id: SEDE_A, nome: 'Kidville Sede di Prova' }],
    utenti: [],
    parents: [],
  }
  h.sendEmail.mockResolvedValue({ ok: true, error: null })
  h.state.tabelle.candidature_sedi = (h.state.tabelle.candidature_insegnanti ?? []).map((c) => ({
    candidatura_id: c.id,
    scuola_id: c.scuola_id,
    stato: c.stato ?? 'pending',
  }))

  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    const u = h.state.utente
    if (!u) return { response: NextResponse.json({ error: 'x' }, { status: 401 }) }
    if (!ammessi.includes(u.role)) return { response: NextResponse.json({ error: 'x' }, { status: 403 }) }
    return { user: u }
  })
})

describe('candidature insegnanti · rifiuto', () => {
  it('marca la candidatura come rifiutata e non crea NESSUN account', async () => {
    const res = await rifiuta({ motivo: MOTIVO })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)

    // Lo stato della CANDIDATURA arriva per aggregazione dal trigger…
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('rifiutata')
    // …mentre chi ha deciso, quando, e con quale nota interna stanno sulla RIGA
    // DI SEDE: è la sede che rifiuta, e con tre plessi «chi ha deciso» senza «per
    // quale plesso» è un'informazione a metà.
    const rigaDiSede = h.state.tabelle.candidature_sedi[0]
    expect(rigaDiSede.stato).toBe('rifiutata')
    expect(rigaDiSede.evasa_da).toBe(ADMIN.id)
    expect(rigaDiSede.evasa_il).toBeTruthy()
    expect(rigaDiSede.motivo_rifiuto).toBe(MOTIVO)

    expect(h.state.creazioniAuth).toEqual([])
    expect(h.state.inserimenti.filter((i) => i.table === 'utenti')).toEqual([])
    expect(h.state.tabelle.utenti).toEqual([])
  })

  it('il MOTIVO non finisce né nell’audit né nei log: solo il fatto che ci sia', async () => {
    await rifiuta({ motivo: MOTIVO })

    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = JSON.stringify(h.logScrittura.mock.calls[0][1])
    expect(audit, 'il testo del motivo è finito in audit').not.toContain(MOTIVO)
    expect(audit).toContain('rifiutata')

    const log = JSON.stringify(h.logEvento.mock.calls)
    expect(log, 'il testo del motivo è finito nei log').not.toContain(MOTIVO)
    // …ma il rifiuto lascia comunque una riga: un'evasione muta non si distingue
    // da un'evasione mai avvenuta.
    expect(h.logEvento.mock.calls.some((c) => c[0] === 'candidatura')).toBe(true)
  })

  it('colonna `motivo_rifiuto` assente: l’audit non dichiara un motivo che non è stato scritto', async () => {
    // Stesso ramo di degrado dell'approvazione, stessa regola: il motivo cade dal
    // patch, l'UPDATE passa lo stesso (`stato` è protetto) e `motivo_presente`
    // continuerebbe a dire `true` per una nota che in tabella non c'è. È poco
    // rispetto a un legame con un account, ma è la stessa cosa: l'audit non
    // afferma ciò che non è stato scritto.
    h.state.colonneAssentiUpdate = ['motivo_rifiuto']
    const res = await rifiuta({ motivo: MOTIVO })
    expect(res.status).toBe(200)

    const cand = h.state.tabelle.candidature_insegnanti[0]
    expect(cand.stato).toBe('rifiutata')
    expect(cand.motivo_rifiuto, 'la colonna non esiste: non può esserci finito niente').toBeUndefined()

    const audit = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(audit.valoreDopo.stato).toBe('rifiutata')
    expect(audit.valoreDopo.motivo_presente).toBe(false)

    // …e chi ha scritto quella nota lo viene a sapere, con il nome della colonna.
    expect((await res.json()).warnings.join(' ')).toMatch(/motivo_rifiuto/)
  })

  it('senza `inviaEmailEsito` non parte nessuna email', async () => {
    await rifiuta({ motivo: MOTIVO })
    expect(h.sendEmail).not.toHaveBeenCalled()
  })

  it('con `inviaEmailEsito: true` parte un’email neutra, SENZA la motivazione', async () => {
    const res = await rifiuta({ motivo: MOTIVO, inviaEmailEsito: true })
    expect(res.status).toBe(200)
    expect(h.sendEmail).toHaveBeenCalledTimes(1)
    const invio = h.sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string }
    expect(invio.to).toBe(EMAIL)
    expect(invio.text).not.toContain(MOTIVO)
    expect(invio.text).not.toMatch(/password/i)
    expect(invio.text.length).toBeGreaterThan(20)
  })

  it('seconda evasione: 409, e la decisione della collega resta quella che era', async () => {
    expect((await rifiuta()).status).toBe(200)
    const res = await rifiuta({ motivo: 'un secondo motivo' })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_GIA_EVASA')
    expect(h.state.tabelle.candidature_insegnanti[0].motivo_rifiuto).toBeFalsy()
  })

  it('una candidatura GIÀ APPROVATA non si rifiuta: 409', async () => {
    // ⚠️ Lo stato di partenza si mette sulla RIGA DI SEDE, che è ciò che il
    // `WHERE` del passaggio guarda; sulla candidatura ci arriva per aggregazione.
    // Metterlo solo sulla candidatura lascerebbe la riga di sede a `pending`, il
    // rifiuto passerebbe, e il test misurerebbe il contrario di ciò che dice.
    h.state.tabelle.candidature_sedi[0].stato = 'approvata'
    h.state.tabelle.candidature_insegnanti[0].stato = 'approvata'
    const res = await rifiuta()
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('CANDIDATURA_GIA_EVASA')
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('approvata')
  })

  it('una candidatura di un’altra sede non si rifiuta: 404 e niente scritture', async () => {
    h.state.scuole = [SEDE_B]
    const res = await rifiuta()
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('CANDIDATURA_NON_TROVATA')
    expect(h.state.tabelle.candidature_insegnanti[0].stato).toBe('pending')
    expect(h.state.aggiornamenti).toEqual([])
  })
})

describe('candidature insegnanti · la DECISIONE arriva sulla candidatura, per il GDPR', () => {
  /**
   * 🔴 IL TEST CHE MANCAVA, e la sua assenza era la parte peggiore del difetto.
   *
   * `gdpr/retention-candidature` legge `candidature_insegnanti.evasa_il` per far
   * decorrere i dodici mesi dalla DECISIONE invece che dalla ricezione. Quando
   * il verdetto è passato sulle righe di sede, quella colonna ha smesso di
   * essere scritta — e ogni candidatura respinta si sarebbe cancellata PRIMA del
   * dovuto, distruggendo dati che /privacy promette di conservare, con la prima
   * scadenza fra dodici mesi e nessuno che se ne accorga.
   *
   * Il trigger la riporta. Senza questo test, tornare alla versione che
   * riportava il solo `stato` lascerebbe la suite verde.
   */
  it('rifiutando, `evasa_il` arriva sulla CANDIDATURA e non solo sulla riga di sede', async () => {
    await rifiuta({ motivo: MOTIVO })
    const madre = h.state.tabelle.candidature_insegnanti[0]
    expect(madre.stato).toBe('rifiutata')
    expect(
      madre.evasa_il,
      'evasa_il non arriva sulla candidatura: il cron GDPR cancellerebbe dalla data di RICEZIONE',
    ).toBeTruthy()
    expect(madre.evasa_da).toBe(ADMIN.id)
  })

  it('finché una sede è ancora in valutazione, `evasa_il` resta NULLO su entrambe', async () => {
    // Non è una sottigliezza: con `evasa_il` valorizzato mentre un plesso guarda
    // ancora, il termine di conservazione decorrerebbe da una decisione che la
    // cooperativa non ha ancora preso.
    h.state.tabelle.candidature_sedi.push({
      candidatura_id: h.state.tabelle.candidature_insegnanti[0].id,
      scuola_id: SEDE_B,
      stato: 'pending',
    })
    await rifiuta({ motivo: MOTIVO })
    const madre = h.state.tabelle.candidature_insegnanti[0]
    expect(madre.stato).toBe('pending')
    expect(madre.evasa_il ?? null).toBeNull()
    expect(madre.evasa_da ?? null).toBeNull()
  })
})
