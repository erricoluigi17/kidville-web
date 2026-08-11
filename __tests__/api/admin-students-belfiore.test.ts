import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST`/`PATCH /api/admin/students` — IL CODICE CATASTALE ARRIVA IN ARCHIVIO.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ PERCHÉ QUESTO FILE ESISTE, e perché non bastavano i collaudi delle tre schede.
 * Fino all'11 agosto `codice_belfiore_nascita` usciva dalle schede dell'ALUNNO,
 * viaggiava nel corpo della richiesta, e spariva dentro questa rotta su ENTRAMBE le
 * strade di scrittura: `postBodySchema` è uno `z.object` NON strict, quindi zod
 * rimuoveva la chiave extra senza errore e senza log; `allowedFields` del PATCH non
 * la conteneva, quindi `updates` non la portava. L'operatore sceglieva il comune
 * dalla tendina, premeva Salva, riceveva `201`/`200` — e il dato non esisteva.
 *
 * 🔴 E il testo mostrato a schermo prescriveva ESATTAMENTE quel gesto:
 * `cfMancaLuogoNascita` («scegli il comune dall'elenco del luogo di nascita per
 * registrarlo»). Un'istruzione scritta all'operatore che fallisce in silenzio su
 * dati di minori è la definizione di bug che AGENTS.md vieta. Il gemello ADULTO era
 * già completo (`buildParentRecord`): la stessa schermata funzionava sui genitori e
 * mentiva sui bambini.
 *
 * ⚠️ LA LEZIONE DI METODO, che è il motivo per cui questo file sta accanto agli
 * altri e non al loro posto. `StudentDetailPanel-codice-fiscale.test.tsx` §3/§4 e
 * `ScrollableStudentForm-codice-fiscale.test.tsx` §4 misurano il PAYLOAD — la chiave
 * presente nel corpo della richiesta, valorizzata anche a `null`. Sono corretti e
 * protettivi, ma un payload corretto contro una rotta che lo scarta resta VERDE in
 * perpetuo mentre in archivio non arriva niente: è la suite che certifica metà
 * catena. Qui si misura l'altra metà — il campo che sopravvive fino alla riga
 * scritta — e le due insieme chiudono il giro.
 *
 * La colonna `alunni.codice_belfiore_nascita` esiste in produzione ed è NULLABLE
 * (migrazione `20260810094625`, verificata l'11 agosto su
 * `information_schema.columns` insieme alla gemella su `parents`).
 *
 * ⚠️ REPOSITORY PUBBLICO: nessuna persona vera, nessun codice fiscale con checksum
 * valida. Toponimi e codici catastali sono dati aperti dell'Agenzia.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  /** Le colonne che questo «database» non ha (il DB E2E della CI, non migrato). */
  assenti: new Set<string>(),
  /** Ogni corpo passato a `insert()`, in ordine. */
  inseriti: [] as Array<Record<string, unknown>>,
  /** Ogni corpo passato a `update()`, in ordine. */
  aggiornati: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
  assertAlunnoInScope: async () => null,
  scuoleDiUtente: async () => ['sc-1'],
}))
vi.mock('@/lib/pagamenti/scadenze', () => ({ riallineaScadenzeRetteFuture: async () => undefined }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: async () => undefined }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: async () => [] }))
vi.mock('@/lib/logging/logger', async (orig) => {
  const m = await orig<typeof import('@/lib/logging/logger')>()
  return { ...m, logEvento: h.logEvento }
})

/**
 * Il finto PostgREST rifiuta le colonne che non conosce ESATTAMENTE come fa quello
 * vero: una alla volta, col proprio codice. `PGRST204` è il codice che arriva
 * DAVVERO su una scrittura — PostgREST valida il corpo contro la propria cache dello
 * schema prima di parlare col database — e il messaggio è quello vero: la regex che
 * estrae il nome della colonna legge `'x' column`, non `column "x" of relation`.
 */
function makeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {}
      const errorePer = (row: Record<string, unknown>) => {
        const col = Object.keys(row).find((k) => h.assenti.has(k))
        return col
          ? {
              data: null,
              error: {
                code: 'PGRST204',
                message: `Could not find the '${col}' column of 'alunni' in the schema cache`,
              },
            }
          : { data: { id: 'al-1', scuola_id: 'sc-1', section_id: null, ...row }, error: null }
      }
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      // Stato PRIMA, per l'audit del PATCH.
      b.maybeSingle = async () => ({
        data: table === 'alunni' ? { id: 'al-1', scuola_id: 'sc-1', allergies: null, allergeni: [] } : null,
        error: null,
      })
      b.insert = (row: Record<string, unknown>) => {
        h.inseriti.push({ ...row })
        const esito = errorePer(row)
        return { select: () => ({ single: async () => esito }) }
      }
      b.update = (row: Record<string, unknown>) => {
        h.aggiornati.push({ ...row })
        const esito = errorePer(row)
        return { eq: () => ({ in: () => ({ select: () => ({ single: async () => esito }) }) }) }
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
  }
}

vi.mock('@/lib/supabase/server-client', () => ({ createAdminClient: async () => makeClient() }))

import { POST, PATCH } from '@/app/api/admin/students/route'

const ID = '22222222-2222-4222-8222-222222222222'

const req = (metodo: string, body: unknown) =>
  new Request('http://localhost/api/admin/students', {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/**
 * Il payload VERO che produce `ScrollableStudentForm.validate()`, ridotto ai campi
 * che contano qui. I nomi delle chiavi sono quelli del form (`comune_nascita`,
 * `codice_belfiore_nascita`), non quelli delle colonne: è la traduzione che fa la
 * rotta, ed è dove il campo si perdeva.
 */
const NUOVO = {
  nome: 'Ada',
  cognome: 'Verdi',
  data_nascita: '2019-03-07',
  sesso: 'F',
  comune_nascita: 'NAPOLI',
  provincia_nascita: 'NA',
  codice_belfiore_nascita: 'H501',
  nazione_nascita: 'Italia',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.assenti.clear()
  h.inseriti = []
  h.aggiornati = []
  h.requireStaff.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } })
})

describe('POST /api/admin/students · il codice catastale entra nella riga scritta', () => {
  it('§1 la chiave sopravvive a zod e arriva nel record dell’INSERT', async () => {
    // Prima dell'11 agosto: `postBodySchema` non la dichiarava, `z.object` non strict
    // la rimuoveva in silenzio, e questa asserzione trovava `undefined` con un 201.
    const res = await POST(req('POST', NUOVO) as never)

    expect(res.status).toBe(201)
    expect(h.inseriti).toHaveLength(1)
    expect(h.inseriti[0]).toHaveProperty('codice_belfiore_nascita', 'H501')
    // E i vicini della stessa sezione non sono stati toccati.
    expect(h.inseriti[0]).toMatchObject({ birth_city: 'NAPOLI', birth_province: 'NA' })
  })

  it('§2 assente non è un errore: senza comune scelto la colonna vale `null`, non `""`', async () => {
    // 18 alunni su 33 in produzione non hanno il comune di nascita. `''` su una
    // colonna è un valore come un altro; `null` dice «non lo sappiamo».
    const res = await POST(req('POST', { ...NUOVO, codice_belfiore_nascita: null }) as never)

    expect(res.status).toBe(201)
    expect(h.inseriti[0]).toHaveProperty('codice_belfiore_nascita', null)
  })

  it('§3 comune scritto a mano che la tendina non riconosce: il testo resta, il codice è `null`', async () => {
    const res = await POST(
      req('POST', { ...NUOVO, comune_nascita: 'Borgo Inesistente', codice_belfiore_nascita: '' }) as never,
    )

    expect(res.status).toBe(201)
    expect(h.inseriti[0]).toMatchObject({ birth_city: 'Borgo Inesistente', codice_belfiore_nascita: null })
  })

  it('§4 colonna assente (il DB E2E della CI, non migrato) → 201, non 500', async () => {
    // Senza il ramo `PGRST204` nella resilienza, aggiungere il campo al record
    // avrebbe reso 500 OGNI creazione di alunno in CI: un campo in più si sarebbe
    // portato via un'intera funzionalità.
    h.assenti.add('codice_belfiore_nascita')

    const res = await POST(req('POST', NUOVO) as never)

    expect(res.status).toBe(201)
    expect(h.inseriti).toHaveLength(2)
    expect(h.inseriti[0]).toHaveProperty('codice_belfiore_nascita')
    expect(h.inseriti[1]).not.toHaveProperty('codice_belfiore_nascita')
    // Il resto dell'anagrafica è arrivato lo stesso: il bambino è iscritto.
    expect(h.inseriti[1]).toMatchObject({ nome: 'Ada', cognome: 'Verdi', birth_city: 'NAPOLI' })
  })

  it('§5 la colonna scartata si LOGGA — e a log va il nome, mai un dato di persona', async () => {
    h.assenti.add('codice_belfiore_nascita')

    await POST(req('POST', NUOVO) as never)

    expect(h.logEvento).toHaveBeenCalledTimes(1)
    const [evento, livello, campi] = h.logEvento.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(evento).toBe('anagrafica')
    expect(livello).toBe('warn')
    expect(campi).toMatchObject({
      operazione: 'admin/students:POST',
      azione: 'colonna-assente-scartata',
      esito: 'codice_belfiore_nascita',
    })
    // AGENTS.md punto 8: mai dati personali nei log.
    expect(JSON.stringify(campi)).not.toContain('Ada')
    expect(JSON.stringify(campi)).not.toContain('Verdi')
    expect(JSON.stringify(campi)).not.toContain('2019-03-07')
  })

  // ⚠️ §6 è un caso di CONTROLLO, non una protezione, e va detto invece di lasciarlo
  // contare come gli altri: togliendo il campo dalla rotta questo caso resta VERDE
  // (nessun ritentativo e nessun log sono veri anche quando la chiave viene scartata).
  // Serve a escludere che i casi §4/§5 passino per un ritentativo che avviene sempre.
  // Provato l'11 agosto: sulla mutazione «rotta senza il campo» 10 casi su 11 di questo
  // file diventano rossi, e l'undicesimo è questo.
  it('§6 col database migrato non si ritenta niente e non si logga nessun degrado', async () => {
    await POST(req('POST', NUOVO) as never)

    expect(h.inseriti).toHaveLength(1)
    expect(h.logEvento).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/admin/students · il codice catastale entra nell’UPDATE', () => {
  it('§7 la chiave supera `patchBodySchema` E `allowedFields` e arriva nel corpo scritto', async () => {
    // Due filtri in fila, e prima dell'11 agosto la chiave moriva nel primo: zod la
    // rimuoveva, quindi `allowedFields` non l'avrebbe vista comunque. Servivano
    // entrambe le righe, ed è per questo che il caso le attraversa tutte e due.
    const res = await PATCH(req('PATCH', { id: ID, codice_belfiore_nascita: 'H501' }) as never)

    expect(res.status).toBe(200)
    expect(h.aggiornati).toHaveLength(1)
    expect(h.aggiornati[0]).toHaveProperty('codice_belfiore_nascita', 'H501')
  })

  it('§8 cancellare il codice è un gesto legittimo: `null` viaggia e viene scritto', async () => {
    // Correggere un comune sbagliato passa da qui: se `null` non arrivasse, il
    // valore vecchio resterebbe in archivio e il badge resterebbe verde su un dato
    // che l'operatore ha appena tolto.
    const res = await PATCH(req('PATCH', { id: ID, codice_belfiore_nascita: null }) as never)

    expect(res.status).toBe(200)
    expect(h.aggiornati[0]).toHaveProperty('codice_belfiore_nascita', null)
  })

  it('§9 colonna assente → 200, non 500, e il resto della scheda si salva', async () => {
    h.assenti.add('codice_belfiore_nascita')

    const res = await PATCH(
      req('PATCH', { id: ID, codice_belfiore_nascita: 'H501', nome: 'Ada' }) as never,
    )

    expect(res.status).toBe(200)
    expect(h.aggiornati).toHaveLength(2)
    expect(h.aggiornati[0]).toHaveProperty('codice_belfiore_nascita')
    expect(h.aggiornati[1]).not.toHaveProperty('codice_belfiore_nascita')
    expect(h.aggiornati[1]).toMatchObject({ nome: 'Ada' })
    expect(h.logEvento).toHaveBeenCalledWith('anagrafica', 'warn', expect.objectContaining({
      operazione: 'admin/students:PATCH',
      azione: 'colonna-assente-scartata',
      esito: 'codice_belfiore_nascita',
    }))
  })

  it('§10 se il campo era l’UNICO chiesto e la colonna non c’è: 400 onesto, non un UPDATE nudo', async () => {
    h.assenti.add('codice_belfiore_nascita')

    const res = await PATCH(req('PATCH', { id: ID, codice_belfiore_nascita: 'H501' }) as never)

    expect(res.status).toBe(400)
    // Un solo tentativo: non si manda `update({})` al database.
    expect(h.aggiornati).toHaveLength(1)
  })

  it('§11 un errore che NON è una colonna assente resta un errore: non si ritenta all’infinito', async () => {
    const client = {
      from() {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.in = () => b
        b.maybeSingle = async () => ({ data: { id: 'al-1', scuola_id: 'sc-1' }, error: null })
        b.update = (row: Record<string, unknown>) => {
          h.aggiornati.push({ ...row })
          return {
            eq: () => ({
              in: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: '23505', message: 'duplicate key value violates unique constraint "alunni_codice_fiscale_key"' },
                  }),
                }),
              }),
            }),
          }
        }
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
        return b
      },
    }
    const mod = await import('@/lib/supabase/server-client')
    const spia = vi.spyOn(mod, 'createAdminClient').mockResolvedValue(client as never)

    const res = await PATCH(req('PATCH', { id: ID, codice_belfiore_nascita: 'H501' }) as never)

    expect(res.status).toBe(500)
    expect(h.aggiornati).toHaveLength(1)
    expect(h.logEvento).not.toHaveBeenCalled()
    spia.mockRestore()
  })
})
