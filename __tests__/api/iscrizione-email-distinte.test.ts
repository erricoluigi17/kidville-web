// @vitest-environment node
// =============================================================================
// UN GENITORE, UNA CASELLA — la difesa che sta sul SERVER.
//
// ─── PERCHÉ QUESTO TEST ESISTE ──────────────────────────────────────────────
// Decisione del titolare (2026-08-16): ogni genitore deve avere il suo accesso
// all'app, e l'accesso nasce dall'email. Due genitori sulla stessa casella non
// possono averne due — `utenti.email` è UNIQUE e GoTrue rifiuta un indirizzo già
// registrato — quindi la coppia finisce a condividere un account, cioè uno dei
// due non entra mai come sé.
//
// Il wizard fa lo stesso controllo mentre l'utente scrive, ma il modulo
// d'iscrizione è ANONIMO: chiunque può spedire a questa route un corpo JSON
// scritto a mano, e in quel caso il codice del client non gira. La difesa vera è
// quella qui misurata; quella del wizard è cortesia.
//
// ─── LA FORMA DELLA RISPOSTA È PARTE DEL COMPORTAMENTO ──────────────────────
// Non basta che il 400 esca: deve uscire come `{ error, campi }`, con il
// messaggio dentro `campi.adults[i].email`. Il wizard sa attaccare a un campo
// SOLO quella forma; un errore emesso da `validationError` (`{ error, details }`)
// diventerebbe un modulo che rifiuta senza dire dove, e il genitore riproverebbe
// identico. Per questo il controllo non è un `superRefine` di zod, e per questo
// qui si asserisce anche l'ASSENZA di `details`.
//
// Nessun indirizzo qui dentro è reale: il repository è pubblico e il modulo
// raccoglie dati di minori. Domini `.test`, nomi inventati.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

const SEDE = SEDE_A

const h = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  emailInviate: [] as { to: string }[],
}))

// Modello minimale: al server servono solo un bambino con un nome e un adulto
// con nome + email. Gli altri campi del modulo standard hanno i loro test; qui
// si prova il confronto FRA adulti, che nessun campo può fare da solo.
const minimalModel = {
  schema: {
    version: '1',
    pages: [
      {
        id: 'bambino',
        title: 'B',
        fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }],
      },
      {
        id: 'adulto',
        title: 'A',
        fields: [
          { id: 'nome', type: 'text', label: 'Nome', required: true },
          // `required: false` come nel template standard: l'email è FACOLTATIVA,
          // ed è esattamente ciò che rende il caso «due vuote» non un duplicato.
          { id: 'email', type: 'email', label: 'Email', required: false },
        ],
      },
    ],
  },
}

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: () => ({ ok: true, remaining: 4, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.9',
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn().mockResolvedValue([]) }))
// La ricevuta alla famiglia è best-effort e non è l'oggetto di questo test: si
// intercetta perché nessun test deve uscire dalla macchina, e perché così si può
// verificare che una domanda RESPINTA non spedisca nemmeno una ricevuta.
vi.mock('@/lib/email/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/send')>()
  return {
    ...actual,
    sendEmailDetailed: async (p: { to: string }) => {
      h.emailInviate.push({ to: p.to })
      return { ok: true, error: null }
    },
  }
})
vi.mock('@/lib/email/contesto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/contesto')>()
  return { ...actual, risolviContestoSede: async () => actual.contestoSenzaSede(NOME_SEDE_A) }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      // `sediReali` legge `schools` e `scuole` con catene diverse: il builder è
      // thenable, così `await` risolve comunque nel risultato preparato.
      if (table === 'schools' || table === 'scuole') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.in = () => b
        b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: SEDE, nome: NOME_SEDE_A, attiva: true }], error: null }).then(res, rej)
        return b
      }
      if (table === 'form_models') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.eq = () => b
        b.maybeSingle = async () => ({ data: minimalModel, error: null })
        return b
      }
      // enrollment_submissions
      const b: Record<string, unknown> = {}
      b.insert = (row: Record<string, unknown>) => { h.inserts.push(row); return b }
      b.select = () => b
      b.single = async () => ({ data: { id: '11111111-2222-4333-8444-555555555555' }, error: null })
      return b
    },
  }),
}))

import { NextRequest } from 'next/server'
import { POST } from '@/app/api/iscrizione/route'
import { EMAIL_RIPETUTA_FRA_GENITORI } from '@/lib/iscrizioni/email-genitori'

/** Corpo del modulo: un bambino e gli adulti che il caso vuole provare. */
const invia = (adults: Record<string, unknown>[]) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({
        scuola_id: SEDE,
        data: {
          presa_visione_informativa: true,
          children: [{ nome: 'Tino' }],
          adults,
        },
      }),
    }),
  )

type RispostaCampi = {
  error?: string
  details?: unknown
  campi?: { adults?: Record<string, Record<string, string>> }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.emailInviate = []
})

describe('POST /api/iscrizione — due genitori non possono indicare la stessa casella', () => {
  it('stessa email per i due adulti: 400 e il messaggio è attaccato al SECONDO', async () => {
    const res = await invia([
      { nome: 'Ines', email: 'genitore.uno@example.test' },
      { nome: 'Ivo', email: 'genitore.uno@example.test' },
    ])
    expect(res.status).toBe(400)
    const j = (await res.json()) as RispostaCampi
    expect(j.campi?.adults?.['1']?.email).toBe(EMAIL_RIPETUTA_FRA_GENITORI)
    // Si segnala chi RIPETE, non chi ha compilato per primo: l'errore va messo
    // sul campo che l'utente deve cambiare.
    expect(j.campi?.adults?.['0']).toBeUndefined()
    // Una domanda respinta non arriva al database e non manda ricevute.
    expect(h.inserts).toHaveLength(0)
    expect(h.emailInviate).toHaveLength(0)
  })

  it('la risposta ha la forma `{ error, campi }`, MAI `{ error, details }` di zod', async () => {
    // Se un giorno questo controllo migrasse dentro uno zod `superRefine`, il
    // 400 continuerebbe a uscire e questo file resterebbe verde a metà: il
    // wizard però non saprebbe più dove appendere il messaggio, e il genitore
    // vedrebbe un rifiuto senza campo evidenziato. È il difetto che questa
    // asserzione tiene fuori.
    const res = await invia([
      { nome: 'Ines', email: 'genitore.uno@example.test' },
      { nome: 'Ivo', email: 'genitore.uno@example.test' },
    ])
    const j = (await res.json()) as RispostaCampi
    expect(typeof j.error).toBe('string')
    expect(j.campi).toBeTruthy()
    expect(j.details).toBeUndefined()
  })

  it('maiuscole diverse: è la stessa casella, e il modulo la rifiuta lo stesso', async () => {
    // Il confronto è sull'email NORMALIZZATA (`lower(btrim(...))`, la stessa
    // regola della colonna generata a database). Qui la forma è impeccabile —
    // `GENITORE.UNO@EXAMPLE.TEST` passa la validazione del campo — quindi
    // l'unico motivo possibile del 400 è il duplicato.
    const res = await invia([
      { nome: 'Ines', email: 'genitore.uno@example.test' },
      { nome: 'Ivo', email: 'GENITORE.UNO@EXAMPLE.TEST' },
    ])
    expect(res.status).toBe(400)
    const j = (await res.json()) as RispostaCampi
    expect(Object.keys(j.campi?.adults?.['1'] ?? {})).toEqual(['email'])
    expect(j.campi?.adults?.['1']?.email).toBe(EMAIL_RIPETUTA_FRA_GENITORI)
    expect(h.inserts).toHaveLength(0)
  })

  it('spazi in testa e in coda: nemmeno quelli fanno passare un doppione', async () => {
    // Incollare l'indirizzo dal telefono ci porta dentro gli spazi: senza il
    // `trim` della normalizzazione, `' Genitore.Uno@Example.test '` sembrerebbe
    // una casella diversa e i due genitori resterebbero sulla stessa.
    const res = await invia([
      { nome: 'Ines', email: 'genitore.uno@example.test' },
      { nome: 'Ivo', email: '  Genitore.Uno@Example.test  ' },
    ])
    expect(res.status).toBe(400)
    const j = (await res.json()) as RispostaCampi
    // Il messaggio è quello del duplicato, non un generico «email non valida»:
    // dice al genitore COSA deve cambiare, non solo che qualcosa è storto.
    expect(j.campi?.adults?.['1']?.email).toBe(EMAIL_RIPETUTA_FRA_GENITORI)
    expect(h.inserts).toHaveLength(0)
  })

  it('email diverse: la domanda passa, e questo controllo non c\'entra nulla', async () => {
    const res = await invia([
      { nome: 'Ines', email: 'genitore.uno@example.test' },
      { nome: 'Ivo', email: 'genitore.due@example.test' },
    ])
    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(1)
    const salvato = h.inserts[0].data as { adults: Record<string, unknown>[] }
    expect(salvato.adults.map((a) => a.email)).toEqual([
      'genitore.uno@example.test',
      'genitore.due@example.test',
    ])
  })

  it('due adulti SENZA email: passa — il campo è facoltativo, due vuoti non sono un doppione', async () => {
    // Misurato sulle domande già arrivate: alcune famiglie non lasciano nessun
    // indirizzo. Trattare due vuoti come una ripetizione bloccherebbe una
    // domanda legittima, ed è l'errore facile da commettere scrivendo il
    // confronto senza pensarci.
    const res = await invia([{ nome: 'Ines' }, { nome: 'Ivo', email: '' }])
    expect(res.status).toBe(201)
    expect(h.inserts).toHaveLength(1)
    // Nessun indirizzo → nessuna ricevuta da mandare (e non è un errore).
    expect(h.emailInviate).toHaveLength(0)
  })

  it('l\'errore si SOMMA agli altri dello stesso adulto invece di cancellarli', async () => {
    // Il duplicato viene calcolato dopo la validazione campo per campo e scrive
    // dentro la stessa mappa. Sovrascrivendo l'oggetto invece di estenderlo, il
    // genitore correggerebbe l'email, rispedirebbe, e si vedrebbe respingere di
    // nuovo per il nome mancante — un errore per volta, un viaggio per volta.
    const res = await invia([
      { nome: 'Ines', email: 'genitore.uno@example.test' },
      { email: 'genitore.uno@example.test' }, // niente nome: campo obbligatorio
    ])
    expect(res.status).toBe(400)
    const j = (await res.json()) as RispostaCampi
    const secondo = j.campi?.adults?.['1'] ?? {}
    expect(secondo.nome).toBe('Campo obbligatorio')
    expect(secondo.email).toBe(EMAIL_RIPETUTA_FRA_GENITORI)
    expect(Object.keys(secondo).sort()).toEqual(['email', 'nome'])
  })

  it('tre adulti sulla stessa casella: si segnalano il secondo e il terzo, non il primo', async () => {
    // La regola non è «due»: è «una casella una volta sola». Con un tutore in
    // più il modulo deve indicare tutti i campi da cambiare, altrimenti la
    // correzione richiede tanti invii quanti sono i doppioni.
    const res = await invia([
      { nome: 'Ines', email: 'genitore.uno@example.test' },
      { nome: 'Ivo', email: 'genitore.uno@example.test' },
      { nome: 'Ida', email: 'GENITORE.UNO@example.test' },
    ])
    expect(res.status).toBe(400)
    const j = (await res.json()) as RispostaCampi
    expect(j.campi?.adults?.['1']?.email).toBe(EMAIL_RIPETUTA_FRA_GENITORI)
    expect(j.campi?.adults?.['2']?.email).toBe(EMAIL_RIPETUTA_FRA_GENITORI)
    expect(j.campi?.adults?.['0']).toBeUndefined()
  })
})
