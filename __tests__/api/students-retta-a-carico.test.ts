import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `PATCH /api/admin/students` — «LA RETTA LA PAGA IL FRATELLO», dalla scheda.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE. `alunni.retta_a_carico_di` esiste dal 2026-08-16 ed è
 * rispettata da entrambe le strade che generano le rette (la RPC `genera_rette_mensili`
 * e l'anteprima TS). Ma si poteva valorizzare SOLO dall'import delle iscrizioni: non era
 * né in `patchBodySchema` né in `allowedFields` di questa route. Al 2026-09-04 in
 * produzione **44 alunni** l'avevano valorizzata senza che nessuno potesse vederla o
 * correggerla — e la route dell'import lo sapeva, tanto che il suo messaggio d'errore
 * diceva «Va corretto dalla scheda dell'alunno», una schermata che non esisteva.
 *
 * 🔴 Che cosa costa non vederla, misurato: a Giugliano un bambino con retta 250 € era
 * marcato a carico di un fratello che aveva **0,01 €**. La RPC salta chi è a carico di
 * un altro, quindi la famiglia è stata addebitata di **un centesimo** per settembre 2026
 * invece di 250 €. Nessun errore, nessun log, nessuna schermata: un anello rovesciato è
 * invisibile finché il campo non si vede.
 *
 * Le due facce dello stesso fatto — il legame e l'importo — le scrive la ROUTE, insieme:
 * lasciarle al client vuol dire lasciarle divergere, ed è la coppia che in produzione è
 * già incoerente su tre righe.
 *
 * ⚠️ REPOSITORY PUBBLICO: nessuna persona vera, nessun uuid di produzione.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  /** Le righe di `alunni`, per uuid: il finto PostgREST risponde per id, non «una sola». */
  alunni: {} as Record<string, Record<string, unknown> | null>,
  aggiornati: [] as Array<Record<string, unknown>>,
  riallineaImporto: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
  assertAlunnoInScope: async () => null,
  scuoleDiUtente: async () => ['sc-1'],
  // ⚠️ Serve davvero: in Postgres `uuid` è un TIPO e 'AAAA…' vale 'aaaa…', mentre in
  // JavaScript sono due stringhe diverse. Senza questa riga il mock restituiva
  // `undefined`, il confronto di sede lanciava, e i cinque casi che verificano le
  // guardie fallivano tutti con un 500 — cioè misuravano il mock, non la route.
  formaConfronto: (v: string) => String(v ?? '').trim().toLowerCase(),
}))
vi.mock('@/lib/pagamenti/scadenze', () => ({
  riallineaScadenzeRetteFuture: async () => undefined,
  riallineaImportoRetteFuture: h.riallineaImporto,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: async () => [] }))
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return { ...m, logEvento: h.logEvento }
})

/**
 * Finto PostgREST che RICORDA l'id chiesto.
 *
 * ⚠️ Un mock piatto — stessa riga per qualunque `eq('id', …)` — qui direbbe sempre di
 * sì: il fratello indicato risulterebbe sempre esistente, nella sede giusta e iscritto,
 * cioè le quattro guardie che questo file esiste per misurare sarebbero verdi anche
 * senza il codice che le implementa.
 */
function makeClient() {
  return {
    from(table: string) {
      let idChiesto: string | null = null
      let aCaricoDi: string | null = null
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => {
        if (col === 'id') idChiesto = String(val)
        if (col === 'retta_a_carico_di') aCaricoDi = String(val)
        return b
      }
      b.in = () => b
      b.is = () => b
      b.neq = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'alunni' ? (idChiesto ? h.alunni[idChiesto] ?? null : null) : null,
        error: null,
      })
      b.single = async () => ({ data: table === 'alunni' ? h.alunni[idChiesto ?? ''] ?? null : null, error: null })
      b.update = (row: Record<string, unknown>) => {
        h.aggiornati.push({ ...row })
        return {
          eq: () => ({
            in: () => ({ select: () => ({ single: async () => ({ data: { id: 'al-1', scuola_id: 'sc-1', ...row }, error: null }) }) }),
          }),
        }
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        // «Chi ha la retta a carico di X»: la query che scopre gli anelli.
        const righe = table === 'alunni' && aCaricoDi
          ? Object.values(h.alunni).filter((a) => a && a.retta_a_carico_di === aCaricoDi)
          : []
        return resolve({ data: righe, error: null })
      }
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => makeClient() }))

import { PATCH } from '@/app/api/admin/students/route'

const AL = 'al-1'
const FRATELLO = 'al-2'

// `as never`: la route è tipizzata `NextRequest`, e un `Request` nudo basta a tutto
// ciò che tocca (url, headers, json). Stessa scorciatoia degli altri test di questa
// route — v. `admin-students-belfiore.test.ts`.
function patch(body: Record<string, unknown>) {
  return new Request('http://x/api/admin/students', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'u-1' },
    body: JSON.stringify(body),
  })
}

/** L'ultima `update` sulla riga dell'alunno (l'audit ne scrive altre). */
function ultimoUpdate(): Record<string, unknown> {
  return h.aggiornati[h.aggiornati.length - 1] ?? {}
}

beforeEach(() => {
  h.requireStaff.mockResolvedValue({ user: { id: 'u-1', role: 'segreteria', scuola_id: 'sc-1' } })
  h.aggiornati = []
  h.riallineaImporto.mockReset()
  h.alunni = {
    [AL]: { id: AL, scuola_id: 'sc-1', stato: 'iscritto', archiviato_il: null, importo_retta_mensile: 150, retta_a_carico_di: null },
    [FRATELLO]: { id: FRATELLO, scuola_id: 'sc-1', stato: 'iscritto', archiviato_il: null, importo_retta_mensile: 250, retta_a_carico_di: null },
  }
})

describe('PATCH students · retta a carico di un fratello', () => {
  it('scrive il legame E porta l’importo a 0, nella stessa update', async () => {
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: FRATELLO }) as never)
    expect(res.status).toBe(200)

    const u = ultimoUpdate()
    expect(u.retta_a_carico_di).toBe(FRATELLO)
    // Sono due facce dello stesso fatto: separarle è come sono nate le tre righe
    // incoerenti che oggi stanno in produzione.
    expect(u.importo_retta_mensile).toBe(0)
  })

  it('lo zero NON scende sui pagamenti già generati', async () => {
    await PATCH(patch({ id: AL, retta_a_carico_di: FRATELLO }) as never)

    // Il riallineamento viene invocato — è giusto, la colonna è cambiata — ma con 0.
    const conZero = h.riallineaImporto.mock.calls.filter((c) => Number(c[2]) === 0)
    expect(conZero.length).toBeGreaterThan(0)

    // E il vero `riallineaImportoRetteFuture` rifiuta gli zeri: sulla colonna
    // dell'alunno lo 0 significa «usa il default di sede», su un pagamento
    // significherebbe «non deve niente». Tradurre l'una nell'altra è il modo di
    // regalare (o addebitare) una retta. La regola sta in un posto solo, dentro la
    // funzione: qui si verifica che quel posto sia davvero quello, invece di
    // copiarne una seconda versione nella route.
    const scritture: unknown[] = []
    const spia = {
      from: () => ({
        select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: 'cat-retta' }, error: null }) }) }) }),
        update: (row: unknown) => { scritture.push(row); return { eq: async () => ({ error: null }) } },
      }),
    }
    const { riallineaImportoRetteFuture } = await vi.importActual<typeof import('@/lib/pagamenti/scadenze')>('@/lib/pagamenti/scadenze')
    expect(await riallineaImportoRetteFuture(spia as never, AL, 0)).toBe(0)
    expect(scritture).toEqual([])
  })

  it('togliere il legame (`null`) riabilita l’importo e non lo azzera', async () => {
    h.alunni[AL]!.retta_a_carico_di = FRATELLO
    h.alunni[AL]!.importo_retta_mensile = 0
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: null, importo_retta_mensile: 200 }) as never)
    expect(res.status).toBe(200)
    const u = ultimoUpdate()
    expect(u.retta_a_carico_di).toBeNull()
    expect(u.importo_retta_mensile).toBe(200)
  })

  it('RIFIUTA un fratello che non esiste', async () => {
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: 'al-inesistente' }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('RETTA_FRATELLO_NON_DISPONIBILE')
  })

  it('RIFIUTA un fratello di un’altra sede', async () => {
    h.alunni[FRATELLO]!.scuola_id = 'sc-2'
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: FRATELLO }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('RETTA_FRATELLO_NON_DISPONIBILE')
  })

  it('RIFIUTA un fratello non più iscritto', async () => {
    h.alunni[FRATELLO]!.stato = 'ritirato'
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: FRATELLO }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('RETTA_FRATELLO_NON_DISPONIBILE')
  })

  it('RIFIUTA se stesso', async () => {
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: AL }) as never)
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('RETTA_FRATELLO_NON_DISPONIBILE')
  })

  it('RIFIUTA una CATENA: il pagante è a sua volta a carico di un terzo', async () => {
    h.alunni[FRATELLO]!.retta_a_carico_di = 'al-3'
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: FRATELLO }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('RETTA_CICLO_FRATELLI')
  })

  it('RIFIUTA un ANELLO: chi sta per diventare a carico ha già dei figli a suo carico', async () => {
    // È letteralmente il caso di Giugliano: A a carico di B mentre B è a carico di A
    // ⇒ nessuno dei due genera una retta, e la famiglia paga zero.
    h.alunni['al-3'] = { id: 'al-3', scuola_id: 'sc-1', stato: 'iscritto', archiviato_il: null, retta_a_carico_di: AL }
    const res = await PATCH(patch({ id: AL, retta_a_carico_di: FRATELLO }) as never)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('RETTA_CICLO_FRATELLI')
  })
})
