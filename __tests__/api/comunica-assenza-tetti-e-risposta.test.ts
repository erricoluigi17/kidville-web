import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { resetRateLimit } from '@/lib/security/rate-limit'

// =============================================================================
// I TRE CONFINI CHE LA ROTTA NON AVEVA — e la risposta che diceva troppo.
//
// Misurato dai tester il 2026-08-07 sulla rotta appena aperta a tutte e 32 le
// famiglie:
//
//  · `data: '2099-12-31'` → 201. L'unico confronto temporale (`data <
//    oggiFiscaleISO()`) è un limite INFERIORE: sul futuro non c'era niente, e
//    ogni riga accodava una notifica ai docenti della sezione.
//  · un `motivo` di 200.000 caratteri → 201, e la GET successiva restituiva
//    200 KB. `z.unknown()` era permissivo sul TIPO, ed è stato letto come
//    permissivo sulla DIMENSIONE. È un dato sanitario di un minore: la
//    minimizzazione (art. 5.1.c) si impone alla fonte, non si spera.
//  · dodici chiamate di fila non costavano niente: nessun tetto di frequenza su
//    una rotta di SCRITTURA che accoda una push immediata a ogni colpo.
//
// E la risposta della POST restituiva l'INTERA riga di `presenze` — 25 colonne,
// fra cui `giustificazione_firma`, che contiene EMAIL, INDIRIZZO IP e USER AGENT
// del genitore che ha firmato. Al modulo servono `id` e `data`.
//
// ─── L'ORDINE È PARTE DELLA PROVA ───────────────────────────────────────────
//
// I due tetti di dominio stanno DOPO `requireParentOfStudent`, mai in zod: in
// zod risponderebbero 400 prima del gate, e la prova adversarial dell'E2E
// pretende **403** su un figlio altrui. È una trappola già pagata in questo
// ciclo, e qui c'è un test che la tiene chiusa.
// =============================================================================

const STUDENT = 'a1111111-1111-4111-8111-111111111111'
const PARENT = 'b1111111-1111-4111-8111-111111111111'
const ALTRO_PARENT = 'b2222222-2222-4222-8222-222222222222'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const MAESTRA = 'd1111111-1111-4111-8111-111111111111'
const SCUOLA = 'e1111111-1111-4111-8111-111111111111'

const ADESSO = '2026-08-10T09:00:00Z'
const OGGI = '2026-08-10'
const DOMANI = '2026-08-11'

const h = vi.hoisted(() => ({
  requireParent: vi.fn(),
  assertGenitore: vi.fn(),
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))

const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

let db: DBFinto
let scritture: Scrittura[]
/**
 * UN SOLO finto client per test, non uno per chiamata.
 *
 * Il fixture genera le chiavi primarie mancanti con un contatore INTERNO al
 * client (`finto-1`, `finto-2`, …): con un client nuovo a ogni
 * `createAdminClient()` due POST su GIORNI DIVERSI ottengono la stessa `id` di
 * presenza, quindi lo stesso `entita_id`, e il debounce le collassa — un
 * artefatto del banco di prova che si leggerebbe come un difetto del prodotto.
 */
let client: ReturnType<typeof creaFintoSupabase>

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => client,
}))

import {
  POST,
  DELETE,
  GIORNI_MASSIMI_IN_ANTICIPO,
  MOTIVO_MAX_CARATTERI,
  TETTO_SCRITTURE_FINESTRA,
} from '@/app/api/parent/presenze/comunica-assenza/route'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

/** `2026-08-10` + n giorni, in aritmetica di calendario UTC (nessun fuso in gioco). */
function piuGiorni(iso: string, n: number): string {
  const [a, m, g] = iso.split('-').map(Number)
  return new Date(Date.UTC(a, m - 1, g + n)).toISOString().slice(0, 10)
}

function dbBase(): DBFinto {
  return {
    alunni: [{ id: STUDENT, nome: 'Sofia', cognome: 'Rossi', section_id: SEZIONE, scuola_id: SCUOLA }],
    sections: [{ id: SEZIONE, school_type: 'infanzia', scuola_id: SCUOLA }],
    utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZIONE }],
    utenti: [{ id: MAESTRA, attivo: true }],
    admin_settings: [],
    presenze: [],
    notifiche: [],
  }
}

const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/comunica-assenza', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const deleteReq = (q: Record<string, string>) =>
  new NextRequest(
    `http://localhost/api/parent/presenze/comunica-assenza?${new URLSearchParams(q).toString()}`,
    { method: 'DELETE' },
  )

const logScritti = () =>
  JSON.stringify([...logEvento.mock.calls, ...logErrore.mock.calls], (_k, v) =>
    v instanceof Error ? `${v.name}: ${v.message}` : v,
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  invalidateNotificheConfigCache()
  // Il contatore del tetto vive nel modulo: senza questo, i colpi di un test
  // arrivano dentro la finestra del successivo e il tetto scatta dove non c'entra.
  resetRateLimit()
  db = dbBase()
  scritture = []
  client = creaFintoSupabase(db, [], { scritture })
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.assertGenitore.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — la risposta porta solo ciò che il modulo usa', () => {
  /**
   * La riga di `presenze` come può essere davvero in produzione: giustificata e
   * FIRMATA da un genitore (la firma è un jsonb con email, IP e user agent),
   * con la nota del docente e gli identificativi del personale.
   *
   * È il caso concreto del rilievo: la riga futura esiste già, il SECONDO
   * genitore della stessa famiglia rifà la comunicazione — cosa consentita,
   * `registrato_da` è nullo — e nella risposta si ritrova email, IP e user agent
   * dell'ALTRO.
   */
  function rigaConFirma() {
    db.presenze = [
      {
        id: 'p-1',
        alunno_id: STUDENT,
        scuola_id: SCUOLA,
        section_id: SEZIONE,
        data: DOMANI,
        stato: 'assente',
        giustificata: true,
        giustificata_da: ALTRO_PARENT,
        giustificazione_testo: 'febbre',
        note_appello: 'la maestra ha annotato qualcosa',
        registrato_da: null,
        utente_id: MAESTRA,
        giustificazione_firma: {
          method: 'otp_email',
          email: 'mamma.rossi@example.test',
          ip: '203.0.113.7',
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
          hash: 'abcdef',
        },
      },
    ]
  }

  it('aggiornamento di una riga già firmata: nel corpo SOLO `id` e `data`', async () => {
    rigaConFirma()
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'visita' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(Object.keys(body.data ?? {}).sort()).toEqual(['data', 'id'])
    expect(body.data).toMatchObject({ id: 'p-1', data: DOMANI })
  })

  it('email, IP e user agent della firma NON escono dalla risposta', async () => {
    rigaConFirma()
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    const testo = JSON.stringify(await res.json())
    expect(testo).not.toContain('mamma.rossi@example.test')
    expect(testo).not.toContain('203.0.113.7')
    expect(testo).not.toContain('iPhone')
  })

  it('nemmeno la nota del docente e gli id del personale', async () => {
    rigaConFirma()
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    const testo = JSON.stringify(await res.json())
    expect(testo).not.toContain('la maestra ha annotato qualcosa')
    expect(testo).not.toContain(MAESTRA)
  })

  it('riga NUOVA: stesso contratto, `id` e `data` e nient’altro', async () => {
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'visita medica' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(Object.keys(body.data ?? {}).sort()).toEqual(['data', 'id'])
    // Il motivo è un dato sanitario di un minore: non serve al modulo e non torna.
    expect(JSON.stringify(body)).not.toContain('visita medica')
  })

  it('DELETE: la risposta non porta nessun campo della riga cancellata', async () => {
    rigaConFirma()
    const res = await DELETE(deleteReq({ studentId: STUDENT, data: DOMANI }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['annullata', 'success'])
    expect(JSON.stringify(body)).not.toContain('203.0.113.7')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — la data ha anche un tetto SUPERIORE', () => {
  it('l’ultimo giorno ammesso passa (201)', async () => {
    const limite = piuGiorni(OGGI, GIORNI_MASSIMI_IN_ANTICIPO)
    const res = await POST(postReq({ studentId: STUDENT, data: limite }))
    expect(res.status).toBe(201)
  })

  it('il giorno dopo il limite → 400 `ASSENZA_DATA_TROPPO_LONTANA`, e NESSUNA scrittura', async () => {
    const oltre = piuGiorni(OGGI, GIORNI_MASSIMI_IN_ANTICIPO + 1)
    const res = await POST(postReq({ studentId: STUDENT, data: oltre }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ASSENZA_DATA_TROPPO_LONTANA')
    expect(db.presenze).toHaveLength(0)
    expect(scritture.filter((s) => s.tabella === 'presenze')).toHaveLength(0)
  })

  it('`2099-12-31` non è più un 201 (è il caso misurato dai tester)', async () => {
    const res = await POST(postReq({ studentId: STUDENT, data: '2099-12-31' }))
    expect(res.status).toBe(400)
    expect(db.presenze).toHaveLength(0)
    // …e nessuna notifica accodata ai docenti.
    expect(db.notifiche).toHaveLength(0)
  })

  it('il rifiuto lascia una riga `warn` col codice e col solo uuid dell’alunno', async () => {
    await POST(postReq({ studentId: STUDENT, data: '2099-12-31', motivo: 'ricovero per crisi asmatica' }))
    const riga = logEvento.mock.calls.find(
      (c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_DATA_TROPPO_LONTANA'),
    )
    expect(riga, 'un rifiuto che nessuno può contare è un rifiuto che nessuno scopre').toBeTruthy()
    expect(riga?.[2]).toMatchObject({
      operazione: 'parent/presenze/comunica-assenza:POST',
      alunno_id: STUDENT,
      stato: 400,
    })
    expect(logScritti()).not.toContain('asmatica')
  })

  it('IL TETTO STA DOPO IL GATE: figlio altrui + data lontanissima → 403, non 400', async () => {
    // In zod la data risponderebbe 400 PRIMA di `requireParentOfStudent`, e la
    // prova adversarial dell'E2E pretende 403 su un figlio che non è tuo.
    h.requireParent.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
    })
    const res = await POST(postReq({ studentId: STUDENT, data: '2099-12-31' }))
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — il motivo ha una lunghezza massima', () => {
  it('un motivo al limite esatto passa (201) e viene salvato per intero', async () => {
    const motivo = 'x'.repeat(MOTIVO_MAX_CARATTERI)
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo }))
    expect(res.status).toBe(201)
    expect(String(db.presenze[0].giustificazione_testo)).toHaveLength(MOTIVO_MAX_CARATTERI)
  })

  it('un carattere in più → 400 `ASSENZA_MOTIVO_TROPPO_LUNGO`, e NIENTE in tabella', async () => {
    const motivo = 'x'.repeat(MOTIVO_MAX_CARATTERI + 1)
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ASSENZA_MOTIVO_TROPPO_LUNGO')
    expect(db.presenze).toHaveLength(0)
  })

  it('i 200.000 caratteri misurati in produzione sono respinti', async () => {
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'a'.repeat(200_000) }))
    expect(res.status).toBe(400)
    expect(db.presenze).toHaveLength(0)
  })

  it('il rifiuto lascia un `warn` con la LUNGHEZZA, mai il testo', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'crisi asmatica '.repeat(100) }))
    const riga = logEvento.mock.calls.find(
      (c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_MOTIVO_TROPPO_LUNGO'),
    )
    expect(riga?.[2]).toMatchObject({ operazione: 'parent/presenze/comunica-assenza:POST', stato: 400 })
    expect(riga?.[2]).toHaveProperty('n')
    expect(logScritti()).not.toContain('asmatica')
  })

  it('IL TETTO STA DOPO IL GATE anche qui: figlio altrui → 403, non 400', async () => {
    h.requireParent.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
    })
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'x'.repeat(200_000) }))
    expect(res.status).toBe(403)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST/DELETE — il tetto di frequenza per utente', () => {
  it('oltre il tetto la POST risponde 429 `TROPPE_RICHIESTE` con `Retry-After`', async () => {
    for (let i = 0; i < TETTO_SCRITTURE_FINESTRA; i++) {
      const res = await POST(postReq({ studentId: STUDENT, data: piuGiorni(OGGI, i + 1) }))
      expect(res.status, `colpo ${i + 1} dentro il tetto`).toBe(201)
    }
    const res = await POST(postReq({ studentId: STUDENT, data: piuGiorni(OGGI, 59) }))
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  it('il colpo respinto NON scrive e NON accoda notifiche', async () => {
    for (let i = 0; i < TETTO_SCRITTURE_FINESTRA; i++) {
      await POST(postReq({ studentId: STUDENT, data: piuGiorni(OGGI, i + 1) }))
    }
    const righePrima = db.presenze.length
    const notifichePrima = db.notifiche.length
    await POST(postReq({ studentId: STUDENT, data: piuGiorni(OGGI, 59) }))
    expect(db.presenze).toHaveLength(righePrima)
    expect(db.notifiche).toHaveLength(notifichePrima)
  })

  it('anche la DELETE ha il suo tetto', async () => {
    for (let i = 0; i < TETTO_SCRITTURE_FINESTRA; i++) {
      const res = await DELETE(deleteReq({ studentId: STUDENT, data: DOMANI }))
      expect(res.status, `colpo ${i + 1} dentro il tetto`).toBe(200)
    }
    const res = await DELETE(deleteReq({ studentId: STUDENT, data: DOMANI }))
    expect(res.status).toBe(429)
    expect((await res.json()).codice).toBe('TROPPE_RICHIESTE')
  })

  it('IL TETTO STA DOPO IL GATE: chi non è genitore di quel bambino prende 403', async () => {
    h.requireParent.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
    })
    for (let i = 0; i < TETTO_SCRITTURE_FINESTRA + 2; i++) {
      const res = await POST(postReq({ studentId: STUDENT, data: DOMANI }))
      expect(res.status).toBe(403)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNA RAFFICA SULLO STESSO GIORNO È UNA NOTIFICA SOLA.
//
// `notificaEvento` era chiamata senza `debounce: true`: ogni POST produceva una
// riga `notifiche` per docente e una push immediata. Il gemello
// `attendance/daily:POST` collassa già le raffiche sullo stesso `entitaId`.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST — le comunicazioni ripetute sullo stesso giorno collassano', () => {
  it('tre POST sulla stessa data lasciano UNA sola notifica pendente per docente', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'febbre' }))
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'febbre alta' }))
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'visita medica' }))
    const pendenti = db.notifiche.filter(
      (n) => n.tipo === 'assenza_comunicata' && n.push_inviata_il == null,
    )
    expect(pendenti).toHaveLength(1)
    expect(pendenti[0].utente_id).toBe(MAESTRA)
  })

  it('due GIORNI diversi restano due notifiche: il debounce non le confonde', async () => {
    await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    await POST(postReq({ studentId: STUDENT, data: piuGiorni(OGGI, 2) }))
    expect(db.notifiche.filter((n) => n.tipo === 'assenza_comunicata')).toHaveLength(2)
  })
})
