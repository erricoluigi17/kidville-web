/**
 * `/api/attendance/daily` — che cosa esce dalla rotta dell'appello, e che cosa
 * il docente 0-6 deve poter leggere.
 *
 * ─── T22: SI CHIEDONO SEI COLONNE, NON VENTICINQUE ───────────────────────────
 *
 * La POST rispondeva con `.select()` nudo, che su PostgREST è `select *` — e su
 * un UPDATE restituisce ciò che C'ERA, non ciò che il chiamante ha scritto. Al
 * browser del docente (e della segreteria, e della Direzione del plesso)
 * arrivavano quindi `giustificazione_testo` — testo libero di natura sanitaria
 * di un minore, art. 9 GDPR — `note_appello`, e `giustificazione_firma`, che è
 * il log della firma elettronica del GENITORE e porta email, indirizzo IP e
 * user-agent. Nessuno di questi campi è mostrato dall'interfaccia: viaggiavano e
 * si fermavano nello stato React.
 *
 * La correzione gemella era già stata scritta due volte in questo ciclo —
 * `COLONNE_ESITO = 'id, data'` in `comunica-assenza`, `.select('id')` in
 * `giustifica`, entrambe con il commento «si chiedono due colonne, non
 * venticinque» — e non era arrivata alla rotta del docente, in un file che lo
 * stesso ciclo aveva modificato.
 *
 * ─── T24: IL MOTIVO, PER NIDO E INFANZIA, DEVE ARRIVARE A CHI L'HA CHIESTO ───
 *
 * Il modulo dice testualmente alla famiglia: «Il motivo lo leggono le insegnanti
 * della sezione». Per la primaria è vero (l'appello lo mostra); per nido e
 * infanzia — i due gradi che questo ciclo ha aperto per la prima volta — non lo
 * era: la GET che alimenta `/teacher/attendance` non restituiva affatto
 * `giustificazione_testo`, e nessuna schermata del personale lo mostrava. Si
 * raccoglieva un dato particolare di un minore per una finalità irrealizzabile,
 * dichiarandola al momento della raccolta.
 *
 * Le due cose tirano nella stessa direzione e non si contraddicono: il motivo
 * arriva DOVE viene mostrato (la GET dell'appello, che il docente della sezione
 * apre) e non dove nessuno lo guarda (l'eco di una POST di salvataggio).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const SEDE = 'e1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const DOCENTE = 'd1111111-1111-4111-8111-111111111111'
const ALUNNO = 'a1111111-1111-4111-8111-111111111111'

/** La riga come sta in tabella: venticinque colonne, tre delle quali non devono uscire. */
const RIGA_INTERA = {
  id: 'presenza-1',
  alunno_id: ALUNNO,
  scuola_id: SEDE,
  section_id: SEZIONE,
  data: '2026-08-10',
  stato: 'assente',
  orario_entrata: null,
  orario_uscita: null,
  note: null,
  utente_id: DOCENTE,
  registrato_da: DOCENTE,
  note_appello: 'nota interna del docente',
  giustificata: true,
  giustificazione_testo: 'febbre alta da tre giorni',
  giustificata_da: 'genitore-1',
  giustificazione_firma: { email: 'genitore@example.test', ip: '1.2.3.4', user_agent: 'iPhone' },
}

const h = vi.hoisted(() => ({
  /** Le stringhe passate a `.select(...)` per tabella. */
  select: [] as { tabella: string; colonne: string | undefined }[],
  /** Il ruolo di chi apre l'appello: decide se il motivo dell'assenza viaggia (Q1). */
  ruolo: 'educator' as string,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: DOCENTE, role: h.ruolo }, response: null })),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: vi.fn(async () => null),
  assertClasseNomeInScope: vi.fn(async () => null),
  resolveScuoleAttive: vi.fn(async () => [SEDE]),
  // Il vero `vedeTutteLeClassi`, non uno finto: è la funzione che decide se il motivo
  // dell'assenza esce da questa rotta (Q1), e riscriverla qui vorrebbe dire provare la
  // nostra copia invece della regola.
  vedeTutteLeClassi: (u: { role?: string }) =>
    u?.role === 'admin' || u?.role === 'coordinator' || u?.role === 'segreteria',
}))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: vi.fn(() => ({ plessi: [SEDE] })) }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined), nomeUtente: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['eq', 'in', 'is', 'order', 'limit', 'upsert', 'delete', 'update']) qb[m] = () => qb
      qb.select = (colonne?: string) => {
        h.select.push({ tabella, colonne })
        return qb
      }
      qb.maybeSingle = async () => {
        if (tabella === 'alunni') return { data: { nome: 'Bimbo', scuola_id: SEDE, section_id: SEZIONE }, error: null }
        return { data: null, error: null }
      }
      // L'unica `.single()` dell'handler è quella dell'upsert: risponde con la
      // riga INTERA, come farebbe PostgREST se il codice chiedesse `select *`.
      qb.single = async () => ({ data: RIGA_INTERA, error: null })
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: tabella === 'presenze' ? [{ ...RIGA_INTERA, alunni: { id: ALUNNO, nome: 'Bimbo', cognome: 'Test', classe_sezione: 'TEST Infanzia' } }] : [],
          error: null,
        }).then(res)
      return qb
    },
  })),
}))

import { GET, POST } from '@/app/api/attendance/daily/route'

const post = () =>
  new NextRequest('http://localhost/api/attendance/daily', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alunno_id: ALUNNO, data: '2026-08-10', stato: 'assente' }),
  })

const get = () =>
  new NextRequest('http://localhost/api/attendance/daily?data=2026-08-10&sezione=TEST%20Infanzia')

beforeEach(() => {
  vi.clearAllMocks()
  h.select = []
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T22 — la POST dell’appello non rimanda indietro l’intera riga', () => {
  it('la `select` dell’upsert dichiara le colonne, non è nuda', async () => {
    await POST(post())
    const sel = h.select.filter((s) => s.tabella === 'presenze').map((s) => s.colonne)
    expect(
      sel.some((c) => typeof c === 'string' && c.includes('stato')),
      '`.select()` senza argomenti è `select *`: la riga torna intera',
    ).toBe(true)
    expect(sel).not.toContain(undefined)
  })

  it('il corpo della risposta NON contiene il motivo dell’assenza (art. 9)', async () => {
    const res = await POST(post())
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('febbre alta da tre giorni')
    expect(corpo).not.toContain('giustificazione_testo')
  })

  it('il corpo NON contiene la firma del genitore (email, IP, user-agent)', async () => {
    const res = await POST(post())
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('genitore@example.test')
    expect(corpo).not.toContain('1.2.3.4')
    expect(corpo).not.toContain('giustificazione_firma')
  })

  it('il corpo NON contiene la nota interna del docente', async () => {
    const res = await POST(post())
    expect(JSON.stringify(await res.json())).not.toContain('nota interna del docente')
  })

  it('il corpo contiene ESATTAMENTE ciò che la schermata usa', async () => {
    const res = await POST(post())
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ['alunno_id', 'data', 'id', 'orario_entrata', 'orario_uscita', 'stato'].sort(),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('T24 — il motivo arriva all’appello 0-6, che è chi la famiglia crede lo legga', () => {
  it('la `select` della GET chiede `giustificazione_testo` per l’insegnante della sezione', async () => {
    h.ruolo = 'educator'
    await GET(get())
    const sel = h.select.find((s) => s.tabella === 'presenze')?.colonne ?? ''
    expect(
      sel,
      'il modulo promette «il motivo lo leggono le insegnanti della sezione»: per nido e infanzia non era vero',
    ).toContain('giustificazione_testo')
  })

  /**
   * Q1 — «LE INSEGNANTI DELLA SEZIONE» È UN INSIEME, e va rispettato.
   *
   * Misurato nel quarto collaudo: con la sessione di un `coordinator` NON assegnato alla
   * sezione, questa GET rispondeva 200 con il motivo per intero. `requireDocente` ammette
   * anche admin, coordinator e segreteria, e per loro `soloSezioniAssegnate` non restringe
   * niente. La frase mostrata al genitore mentre scrive il sintomo del figlio dichiarava
   * un'altra platea.
   */
  it.each(['admin', 'coordinator', 'segreteria'])(
    'e NON lo chiede per «%s», che vede tutte le classi del plesso',
    async (ruolo) => {
      h.ruolo = ruolo
      await GET(get())
      const sel = h.select.find((s) => s.tabella === 'presenze')?.colonne ?? ''
      expect(
        sel,
        `il motivo dell'assenza — dato sanitario di un minore — arriva a "${ruolo}" per ogni ` +
          `classe del plesso, mentre il modulo del genitore dice «le insegnanti della sezione»`,
      ).not.toContain('giustificazione_testo')
      // La schermata continua a funzionare: tutto il resto dell'appello c'è.
      expect(sel).toContain('stato')
      expect(sel).toContain('alunni!inner')
    },
  )

  it('la GET NON porta comunque la firma del genitore né la nota interna', async () => {
    h.ruolo = 'educator'
    await GET(get())
    const sel = h.select.find((s) => s.tabella === 'presenze')?.colonne ?? ''
    expect(sel).not.toContain('giustificazione_firma')
    expect(sel).not.toContain('note_appello')
  })
})
