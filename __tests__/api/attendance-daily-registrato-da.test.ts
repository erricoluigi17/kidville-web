/**
 * `POST /api/attendance/daily` — l'appello dello 0-6 registra CHI l'ha fatto.
 *
 * IL PUNTO. Serve un segno deterministico, nella riga `presenze`, che distingua
 * «riga scritta dal genitore e mai toccata» da «riga su cui il docente ha
 * lavorato»: è la condizione che regge l'annullamento dell'assenza comunicata
 * (il genitore può ritirarla finché l'insegnante non ha fatto l'appello).
 *
 * MISURATO PRIMA DI SCRIVERE IL CODICE (2026-08-07, DB di produzione, sola lettura):
 *
 *     SELECT count(*), count(registrato_da), count(giustificata_da) FROM presenze;
 *     →  49 righe · 13 con registrato_da · 0 con giustificata_da
 *
 * Le 13 righe con `registrato_da` sono tutte e sole quelle scritte dall'appello
 * della PRIMARIA (`primaria/appello/route.ts:161`, `registrato_da: userId`). Le
 * altre 36 vengono da questa route, che la colonna non la scriveva: dopo un
 * appello 0-6 la riga era indistinguibile da una riga mai toccata da nessuno.
 *
 * PERCHÉ NON BASTAVA `aggiornato_il`: ha `DEFAULT now()`, quindi si valorizza
 * anche sull'INSERT del genitore. Non separa i due casi. `registrato_da IS NULL`
 * sì — ed è coerente col nome della colonna.
 *
 * L'IDENTITÀ VIENE DAL GATE, NON DAL CLIENT. `presenze.registrato_da` ha una FK
 * verso `utenti(id)` (verificata su ENTRAMBI i progetti Supabase, prod e CI:
 * `presenze_registrato_da_fkey FOREIGN KEY (registrato_da) REFERENCES utenti(id)`).
 * `requireDocente` → `loadAppUser` **legge la riga di `utenti`** e ne restituisce
 * l'`id`: se il gate passa, `auth.user.id` È un `utenti.id` esistente, e l'upsert
 * non può violare la chiave esterna. Nessuna risoluzione aggiuntiva serve — ed è
 * la stessa garanzia su cui poggia già la primaria.
 *
 * PROVA DI VALIDITÀ (eseguita): togliendo `registrato_da` dal record dell'upsert,
 * i primi due casi tornano rossi (`undefined` invece dell'id del docente).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  assertClasseNomeInScope: vi.fn(),
  resolveScuoleAttive: vi.fn(),
  restringiASedeRichiesta: vi.fn(),
  notificaEvento: vi.fn(),
  upsert: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  assertClasseNomeInScope: h.assertClasseNomeInScope,
  resolveScuoleAttive: h.resolveScuoleAttive,
}))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: h.restringiASedeRichiesta }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento, nomeUtente: vi.fn() }))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) qb[m] = () => qb
      // Nessuna riga preesistente per il giorno ⇒ prima marcatura.
      qb.maybeSingle = async () =>
        tabella === 'alunni'
          ? { data: { nome: 'X', scuola_id: SEDE, section_id: SEZIONE }, error: null }
          : { data: null, error: null }
      qb.single = async () => ({ data: { id: 'riga-1' }, error: null })
      qb.upsert = (v: Record<string, unknown>) => {
        if (tabella === 'presenze') h.upsert.push(v)
        return qb
      }
      qb.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return qb
    },
  })),
}))

import { POST } from '@/app/api/attendance/daily/route'

const DOCENTE = 'd0000000-0000-4000-8000-0000000000d1'
const IMPOSTORE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const ALUNNO = '11111111-1111-4111-8111-111111111111'
const SEDE = 'aaaa0000-0000-4000-8000-00000000a001'
const SEZIONE = 'bbbb0000-0000-4000-8000-00000000b001'
const GIORNO = '2026-08-07'

function richiesta(corpo: unknown, qs = ''): NextRequest {
  return new NextRequest(`http://localhost/api/attendance/daily${qs}`, {
    method: 'POST',
    body: JSON.stringify(corpo),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.upsert = []
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE } })
  h.assertAlunnoInScope.mockResolvedValue(null)
  h.notificaEvento.mockResolvedValue(undefined)
})

describe('POST /api/attendance/daily — l\'appello 0-6 registra chi l\'ha fatto', () => {
  it('la riga `presenze` porta `registrato_da` = id del docente autenticato', async () => {
    const res = await POST(richiesta({ alunno_id: ALUNNO, data: GIORNO, stato: 'presente' }))

    expect(res.status).toBe(200)
    expect(h.upsert).toHaveLength(1)
    expect(h.upsert[0].registrato_da).toBe(DOCENTE)
  })

  it('vale anche quando l\'appello segna ASSENTE — è il caso che regge l\'annullamento del genitore', async () => {
    // La riga del genitore nasce senza `registrato_da`; se l'appello 0-6 non lo
    // scrivesse nemmeno lui, `registrato_da IS NULL` direbbe «il docente non ha
    // ancora fatto l'appello» a appello già fatto, e il genitore potrebbe
    // ritirare un'assenza che l'insegnante ha già lavorato.
    await POST(richiesta({ alunno_id: ALUNNO, data: GIORNO, stato: 'assente' }))

    expect(h.upsert[0].registrato_da).toBe(DOCENTE)
  })

  it('l\'id viene dal gate, non da `?userId=` né dal corpo (la FK punta a `utenti`)', async () => {
    // Modello di auth app-level: `?userId=` è un input del client. `requireDocente`
    // lo risolve e lo verifica su `utenti`; la route deve prendere l'id da lì e
    // non fidarsi di nulla che arrivi dalla richiesta.
    await POST(
      richiesta({ alunno_id: ALUNNO, data: GIORNO, stato: 'presente', registrato_da: IMPOSTORE }, `?userId=${IMPOSTORE}`),
    )

    expect(h.upsert[0].registrato_da).toBe(DOCENTE)
    expect(h.upsert[0].registrato_da).not.toBe(IMPOSTORE)
  })

  it('nient\'altro del record cambia: sede, sezione e notifica di assenza restano quelli', async () => {
    // Guardia di non-regressione: la colonna in più non deve aver spostato la
    // sede della riga né spento il trigger `assenza_non_comunicata`.
    await POST(richiesta({ alunno_id: ALUNNO, data: GIORNO, stato: 'assente' }))

    expect(h.upsert[0]).toMatchObject({
      alunno_id: ALUNNO,
      data: GIORNO,
      stato: 'assente',
      scuola_id: SEDE,
      section_id: SEZIONE,
    })
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    expect(h.notificaEvento.mock.calls[0][1]).toMatchObject({ tipo: 'assenza_non_comunicata' })
  })
})
