import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// «COMUNICA UN'ASSENZA» — LA FUNZIONE CHE NESSUNO HA MAI POTUTO USARE.
//
// Misurato in produzione il 2026-08-07: 0 notifiche `assenza_comunicata` mai
// emesse, 0 righe `presenze` con `giustificata_da` su 49. Non è che la funzione
// fosse poco usata: era irraggiungibile per costruzione. La dashboard portava
// alla pagina SOLO a nido e infanzia, e la route rispondeva 403 «Disponibile
// solo per la scuola primaria» a chiunque non fosse primaria. I due filtri erano
// complementari e nessuno dei due era sbagliato da solo.
//
// ─── PERCHÉ QUESTO FILE ESISTE ACCANTO A `comunica-assenza-sospensione` ─────
//
// Quel test c'era già, e passava. Mockava però `notificaEvento` e
// `docentiDiSezione`: verificava che la route CHIAMASSE la funzione di notifica,
// non che una riga arrivasse in `notifiche`. Con quel disegno il link poteva
// puntare a una rotta della primaria per un bambino del nido — cosa che faceva —
// e il test restava verde: il mock accetta qualunque `link`.
//
// Qui il trigger NON è mockato. Sotto c'è `notificaEvento` →
// `enqueueNotifiche` → `insert` su `notifiche`, e il finto client APPLICA i
// filtri e ESEGUE le scritture: le righe che si ispezionano sono quelle che il
// database avrebbe davvero. È il modello di `__tests__/api/appello-notifiche.ts`,
// portato sul finto client che filtra.
// =============================================================================

const STUDENT_INFANZIA = 'a1111111-1111-4111-8111-111111111111'
const STUDENT_PRIMARIA = 'a2222222-2222-4222-8222-222222222222'
const STUDENT_NIDO = 'a3333333-3333-4333-8333-333333333333'
const STUDENT_SENZA_SEZIONE = 'a4444444-4444-4444-8444-444444444444'
const SCONOSCIUTO = 'a9999999-9999-4999-8999-999999999999'

const PARENT = 'b1111111-1111-4111-8111-111111111111'
const ALTRO_PARENT = 'b2222222-2222-4222-8222-222222222222'

const SEZ_INFANZIA = 'c1111111-1111-4111-8111-111111111111'
const SEZ_PRIMARIA = 'c2222222-2222-4222-8222-222222222222'
const SEZ_NIDO = 'c3333333-3333-4333-8333-333333333333'

const MAESTRA_A = 'd1111111-1111-4111-8111-111111111111'
const MAESTRA_B = 'd2222222-2222-4222-8222-222222222222'
const MAESTRO_PRIMARIA = 'd3333333-3333-4333-8333-333333333333'

const SCUOLA = 'e1111111-1111-4111-8111-111111111111'

// Orologio fermo alle 09:00 UTC: a Roma è lo stesso giorno, così i casi che non
// parlano di fuso restano leggibili. Il fuso ha i suoi due casi dedicati.
const ADESSO = '2026-08-10T09:00:00Z'
const OGGI = '2026-08-10'
const IERI = '2026-08-09'
const DOMANI = '2026-08-11'

const h = vi.hoisted(() => ({
  requireParent: vi.fn(),
  assertGenitore: vi.fn(),
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))

// Il logger è mockato per ISPEZIONARLO (i rifiuti devono lasciare una riga, e
// nessuna riga deve contenere il motivo dell'assenza). `withRoute` importa
// esattamente queste tre funzioni.
const logEvento = vi.fn()
const logErrore = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))

let db: DBFinto
let scritture: Scrittura[]
let errori: Record<string, { code: string; message?: string }>
/** La riga che «qualcun altro» scrive fra la nostra UPDATE e la nostra INSERT. */
let corsa: Record<string, unknown> | null

/**
 * IL VINCOLO UNICO CHE IL FINTO CLIENT NON HA.
 *
 * `unique_presenza_giornaliera (alunno_id, data)` è ciò che, in produzione, fa
 * perdere la corsa all'INSERT invece di lasciar nascere una seconda riga per lo
 * stesso giorno. Il fixture dichiara di non emulare i vincoli, quindi la corsa la
 * si inietta: alla prima `insert` su `presenze` la riga concorrente compare nel
 * database e PostgREST risponde `23505`, esattamente come farebbe.
 */
function conCorsa(client: SupabaseClient): SupabaseClient {
  return new Proxy(client, {
    get(bersaglio, prop, ricevitore) {
      if (prop !== 'from') return Reflect.get(bersaglio, prop, ricevitore)
      return (tabella: string) => {
        const qb = client.from(tabella) as unknown as Record<string, unknown>
        if (tabella !== 'presenze') return qb
        return new Proxy(qb, {
          get(q, p, r) {
            if (p !== 'insert' || !corsa) return Reflect.get(q, p, r)
            return () => {
              ;(db.presenze ??= []).push({ ...corsa })
              corsa = null
              const error = {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "unique_presenza_giornaliera"',
              }
              const esito = { data: null, error }
              const finto: Record<string, unknown> = {
                select: () => finto,
                single: async () => esito,
                maybeSingle: async () => esito,
                then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                  Promise.resolve(esito).then(ok, ko),
              }
              return finto
            }
          },
        })
      }
    },
  })
}

/** Arma la corsa per il prossimo POST. */
function corsaSullInsert(riga: Record<string, unknown>) {
  corsa = riga
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => conCorsa(creaFintoSupabase(db, [], { scritture, errori })),
}))

import { POST, DELETE } from '@/app/api/parent/presenze/comunica-assenza/route'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'
import { resetRateLimit } from '@/lib/security/rate-limit'

function dbBase(): DBFinto {
  return {
    alunni: [
      { id: STUDENT_INFANZIA, nome: 'Sofia', cognome: 'Rossi', section_id: SEZ_INFANZIA, scuola_id: SCUOLA },
      { id: STUDENT_PRIMARIA, nome: 'Marco', cognome: 'Bianchi', section_id: SEZ_PRIMARIA, scuola_id: SCUOLA },
      { id: STUDENT_NIDO, nome: 'Giulia', cognome: 'Verdi', section_id: SEZ_NIDO, scuola_id: SCUOLA },
      { id: STUDENT_SENZA_SEZIONE, nome: 'Luca', cognome: 'Neri', section_id: null, scuola_id: SCUOLA },
    ],
    sections: [
      { id: SEZ_INFANZIA, school_type: 'infanzia', scuola_id: SCUOLA },
      { id: SEZ_PRIMARIA, school_type: 'primaria', scuola_id: SCUOLA },
      { id: SEZ_NIDO, school_type: 'nido', scuola_id: SCUOLA },
    ],
    utenti_sezioni: [
      { utente_id: MAESTRA_A, section_id: SEZ_INFANZIA },
      { utente_id: MAESTRA_B, section_id: SEZ_INFANZIA },
      { utente_id: MAESTRO_PRIMARIA, section_id: SEZ_PRIMARIA },
    ],
    utenti: [
      { id: MAESTRA_A, attivo: true },
      { id: MAESTRA_B, attivo: true },
      { id: MAESTRO_PRIMARIA, attivo: true },
    ],
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

/** Le righe realmente finite in `notifiche` per un tipo. */
const notifiche = (tipo: string) => (db.notifiche ?? []).filter((n) => n.tipo === tipo)

/**
 * L'annullamento viaggia sullo STESSO tipo della comunicazione — «titolo
 * diverso, stesso canale»: un tipo nuovo sarebbe un toggle nuovo nel pannello
 * Impostazioni, e una scuola che spegne «Assenza comunicata dal genitore» si
 * ritroverebbe comunque gli annullamenti. Si riconosce dal titolo.
 */
const annullamenti = () =>
  notifiche('assenza_comunicata').filter((n) => String(n.titolo).toLowerCase().includes('annull'))

/** Tutto ciò che è stato loggato, in una stringa sola: serve a provare le ASSENZE. */
const logScritti = () =>
  JSON.stringify([...logEvento.mock.calls, ...logErrore.mock.calls], (_k, v) =>
    v instanceof Error ? `${v.name}: ${v.message}` : v,
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  invalidateNotificheConfigCache()
  // Il tetto di frequenza della rotta (20 scritture in 10 minuti per utente)
  // vive nel MODULO, e qui l'orologio è fermo: senza questo azzeramento i colpi
  // dei casi precedenti stanno tutti nella stessa finestra e il 429 scatta a
  // metà file, su un test che parla d'altro. Ogni caso è una raffica sua.
  resetRateLimit()
  db = dbBase()
  scritture = []
  errori = {}
  corsa = null
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.assertGenitore.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — la funzione è aperta a tutti e tre i gradi', () => {
  it('INFANZIA: 201, e una riga `notifiche` per OGNI docente della sezione', async () => {
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(res.status).toBe(201)

    const righe = notifiche('assenza_comunicata')
    expect(righe.map((r) => r.utente_id).sort()).toEqual([MAESTRA_A, MAESTRA_B].sort())
  })

  it('INFANZIA: il link porta all’appello 0-6, non a una rotta della primaria', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    const righe = notifiche('assenza_comunicata')
    // Senza questa riga il `for` qui sotto non itera e il test è verde sul vuoto:
    // è esattamente il modo in cui il difetto è passato la prima volta.
    expect(righe.length).toBeGreaterThan(0)
    for (const r of righe) {
      expect(r.link).toBe('/teacher/attendance')
    }
  })

  it('NIDO: 201 (era 403 «Disponibile solo per la scuola primaria»)', async () => {
    const res = await POST(postReq({ studentId: STUDENT_NIDO, data: OGGI }))
    expect(res.status).toBe(201)
  })

  it('PRIMARIA: il link resta quello dell’appello di classe', async () => {
    await POST(postReq({ studentId: STUDENT_PRIMARIA, data: OGGI }))
    const righe = notifiche('assenza_comunicata')
    expect(righe).toHaveLength(1)
    expect(righe[0].link).toBe(`/teacher/primaria/${SEZ_PRIMARIA}/appello`)
    expect(righe[0].utente_id).toBe(MAESTRO_PRIMARIA)
  })

  it('il corpo della notifica cita il bambino (la legge solo la sua maestra)', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(String(notifiche('assenza_comunicata')[0].corpo)).toContain('Sofia Rossi')
  })

  it('`entita_id` è la RIGA di presenza, non l’alunno (due date sono due entità)', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    const presenza = db.presenze[0]
    const riga = notifiche('assenza_comunicata')[0]
    expect(riga.entita_id).toBe(presenza.id)
    expect(riga.entita_id).not.toBe(STUDENT_INFANZIA)
  })

  it('alunno senza sezione: si registra in silenzio, nessun destinatario', async () => {
    const res = await POST(postReq({ studentId: STUDENT_SENZA_SEZIONE, data: OGGI }))
    expect(res.status).toBe(201)
    expect(db.presenze).toHaveLength(1)
    expect(notifiche('assenza_comunicata')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — la data la valida il SERVER, nel fuso di Roma', () => {
  it('ieri → 400 `ASSENZA_DATA_PASSATA`, e NESSUN upsert', async () => {
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: IERI }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ASSENZA_DATA_PASSATA')
    expect(scritture.filter((s) => s.tabella === 'presenze')).toHaveLength(0)
    expect(db.presenze).toHaveLength(0)
  })

  it('una data passata NON ribalta l’appello che il docente ha già fatto', async () => {
    // Il caso che rende il rifiuto una questione di dati, non di forma: con
    // l'upsert su (alunno_id, data) una data di ieri riscriverebbe la riga.
    db.presenze = [
      { id: 'p-storica', alunno_id: STUDENT_INFANZIA, data: IERI, stato: 'presente', registrato_da: MAESTRA_A, scuola_id: SCUOLA },
    ]
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: IERI }))
    expect(db.presenze[0].stato).toBe('presente')
    expect(db.presenze[0].registrato_da).toBe(MAESTRA_A)
  })

  it('oggi e domani passano', async () => {
    expect((await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))).status).toBe(201)
    expect((await POST(postReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))).status).toBe(201)
  })

  it('a mezzanotte e mezza italiana «oggi» è il giorno ITALIANO, non quello UTC', async () => {
    // 22:30 UTC del 10 = 00:30 del giorno 11 a Roma. Con `new Date()` grezzo il
    // server direbbe che l'11 è domani (accettandolo) e che il 10 è oggi —
    // accettando così una data che in Italia è già ieri.
    vi.setSystemTime(new Date('2026-08-10T22:30:00Z'))

    const oggiItaliano = await POST(postReq({ studentId: STUDENT_INFANZIA, data: '2026-08-11' }))
    expect(oggiItaliano.status).toBe(201)

    const ieriItaliano = await POST(postReq({ studentId: STUDENT_INFANZIA, data: '2026-08-10' }))
    expect(ieriItaliano.status).toBe(400)
    expect((await ieriItaliano.json()).codice).toBe('ASSENZA_DATA_PASSATA')
  })

  it('una data inesistente nel calendario è respinta dallo schema (400)', async () => {
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: '2026-02-30' }))
    expect(res.status).toBe(400)
    expect(db.presenze).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — la riga nasce con la sua sede', () => {
  it('la riga NUOVA dichiara `scuola_id` (debito dell’allowlist isolamento-sede)', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    const nuova = scritture.find((s) => s.tabella === 'presenze' && s.operazione === 'insert')
    expect(nuova?.valori[0]).toMatchObject({
      alunno_id: STUDENT_INFANZIA,
      scuola_id: SCUOLA,
      section_id: SEZ_INFANZIA,
      stato: 'assente',
      giustificata: true,
      giustificata_da: PARENT,
    })
  })

  it('anche la RISCRITTURA di una comunicazione già inviata dichiara la sede', async () => {
    // La sede non è una proprietà del solo INSERT: se un domani la riga venisse
    // creata altrove senza plesso, la seconda comunicazione del genitore è
    // l'unica occasione di rimetterlo.
    db.presenze = [
      {
        id: 'p-mia',
        alunno_id: STUDENT_INFANZIA,
        data: OGGI,
        stato: 'assente',
        giustificata: true,
        giustificata_da: PARENT,
        registrato_da: null,
      },
    ]
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    const riscrittura = scritture.find((s) => s.tabella === 'presenze' && s.operazione === 'update')
    expect(riscrittura?.valori[0]).toMatchObject({ scuola_id: SCUOLA, section_id: SEZ_INFANZIA })
    expect(db.presenze).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'APPELLO GIÀ REGISTRATO NON SI SOVRASCRIVE — NEMMENO OGGI.
//
// La difesa del POST era la sola DATA (`data < oggiFiscaleISO()`): copriva IERI
// e lasciava scoperto OGGI, che è il giorno in cui l'appello si fa, ed è il
// valore PREIMPOSTATO nel modulo. Un bambino segnato «presente» alle 08:45 dalla
// maestra diventava «assente giustificato» con un 201, con l'orario di entrata
// ancora nella riga: `upsert` fa ON CONFLICT DO UPDATE sulle sole colonne del
// payload, quindi `registrato_da` e `orario_entrata` restavano del docente.
//
// Il danno peggiore veniva DOPO: quella riga risulta «già registrata», quindi il
// genitore non poteva più annullarla (409) e non la vedeva nemmeno in elenco
// (`comunicate` filtra `registrato_da IS NULL`), mentre il docente si ritrovava
// un'assenza che non aveva scritto. Nessuno dei due poteva rimediare.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST — l’appello del docente non si sovrascrive (nemmeno OGGI)', () => {
  /** La riga come la scrive l'APPELLO: registrata da un docente, mai giustificata. */
  function appelloFatto(data: string, extra: Record<string, unknown> = {}) {
    db.presenze = [
      {
        id: 'p-appello',
        alunno_id: STUDENT_INFANZIA,
        section_id: SEZ_INFANZIA,
        scuola_id: SCUOLA,
        data,
        stato: 'presente',
        orario_entrata: '08:45',
        registrato_da: MAESTRA_A,
        giustificata_da: null,
        ...extra,
      },
    ]
  }

  it('OGGI con appello già fatto → 409 `ASSENZA_GIA_REGISTRATA`', async () => {
    appelloFatto(OGGI)
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ASSENZA_GIA_REGISTRATA')
  })

  it('la riga del docente resta INTATTA, in ogni campo', async () => {
    appelloFatto(OGGI)
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI, motivo: 'febbre' }))
    expect(db.presenze).toHaveLength(1)
    expect(db.presenze[0]).toMatchObject({
      stato: 'presente',
      registrato_da: MAESTRA_A,
      orario_entrata: '08:45',
      giustificata_da: null,
    })
    expect(db.presenze[0].giustificazione_testo).toBeUndefined()
  })

  it('nessuna notifica «sarà assente» parte per una comunicazione rifiutata', async () => {
    appelloFatto(OGGI)
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(notifiche('assenza_comunicata')).toHaveLength(0)
  })

  it('DOMANI con appello già registrato: stesso rifiuto (la difesa non è la data)', async () => {
    appelloFatto(DOMANI)
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(409)
    expect(db.presenze[0].stato).toBe('presente')
  })

  it('il rifiuto lascia una riga `warn` col codice, e MAI il motivo', async () => {
    appelloFatto(OGGI)
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI, motivo: 'ricovero per crisi asmatica' }))
    const riga = logEvento.mock.calls.find(
      (c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_GIA_REGISTRATA'),
    )
    expect(riga, 'un rifiuto che nessuno può contare è un rifiuto che nessuno scopre').toBeTruthy()
    expect(riga?.[2]).toMatchObject({
      operazione: 'parent/presenze/comunica-assenza:POST',
      alunno_id: STUDENT_INFANZIA,
      presenza_id: 'p-appello',
      stato: 409,
    })
    expect(logScritti()).not.toContain('asmatica')
  })

  it('la riga comunicata DA UN GENITORE si aggiorna: una sola riga, motivo nuovo', async () => {
    db.presenze = [
      {
        id: 'p-mia',
        alunno_id: STUDENT_INFANZIA,
        section_id: SEZ_INFANZIA,
        scuola_id: SCUOLA,
        data: OGGI,
        stato: 'assente',
        giustificata: true,
        giustificata_da: ALTRO_PARENT,
        registrato_da: null,
        giustificazione_testo: 'primo motivo',
      },
    ]
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI, motivo: 'secondo motivo' }))
    expect(res.status).toBe(201)
    expect(db.presenze).toHaveLength(1)
    expect(db.presenze[0]).toMatchObject({
      id: 'p-mia',
      giustificazione_testo: 'secondo motivo',
      giustificata_da: PARENT,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA CORSA FRA L'APPELLO E LA COMUNICAZIONE.
//
// Leggere e poi scrivere lascia una finestra: fra le due istruzioni la maestra
// può fare l'appello, ed è la stessa mezz'ora del mattino. La condizione vive
// perciò anche DENTRO la WHERE dell'UPDATE (`registrato_da IS NULL`) e, quando
// la riga non c'è ancora, la fa rispettare il vincolo unico
// `unique_presenza_giornaliera (alunno_id, data)`: l'INSERT perde la corsa con un
// `23505` invece di scrivere una seconda riga.
//
// Il finto client non emula i vincoli del database (lo dichiara in testa al
// fixture), quindi la corsa la si inietta: `corsaSullInsert` fa comparire la riga
// concorrente ESATTAMENTE fra la nostra UPDATE e la nostra INSERT, e risponde
// come risponderebbe PostgREST.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST — la corsa fra l’appello e la comunicazione (TOCTOU)', () => {
  it('appello inserito nel frattempo → 409, e nessuna seconda riga', async () => {
    corsaSullInsert({
      id: 'p-corsa',
      alunno_id: STUDENT_INFANZIA,
      data: OGGI,
      stato: 'presente',
      registrato_da: MAESTRA_A,
      giustificata_da: null,
    })
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ASSENZA_GIA_REGISTRATA')
    expect(db.presenze).toHaveLength(1)
    expect(db.presenze[0].stato).toBe('presente')
  })

  it('comunicazione dell’ALTRO genitore nel frattempo → 201 sulla riga sua, non una seconda', async () => {
    // La corsa persa contro un docente e quella persa contro l'altro genitore
    // hanno esiti opposti: la seconda è un aggiornamento legittimo, e un 409
    // secco direbbe «l'insegnante ha già registrato» a una famiglia in cui
    // nessun insegnante ha toccato niente — lo stesso messaggio falso che il
    // ciclo ha appena finito di togliere dall'annullamento.
    corsaSullInsert({
      id: 'p-corsa',
      alunno_id: STUDENT_INFANZIA,
      data: OGGI,
      stato: 'assente',
      giustificata_da: ALTRO_PARENT,
      registrato_da: null,
    })
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI, motivo: 'visita' }))
    expect(res.status).toBe(201)
    expect(db.presenze).toHaveLength(1)
    expect(db.presenze[0]).toMatchObject({ id: 'p-corsa', giustificata_da: PARENT, giustificazione_testo: 'visita' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// «STA FUNZIONANDO? QUALCUNO STA COMUNICANDO ASSENZE?»
//
// È la domanda che ha aperto questo ciclo, e per un mese non ha avuto risposta
// interrogabile: `withRoute` emette un `KV_OK` che non dice per quale alunno né
// a quanti docenti è partito l'avviso, e `logOk` non si persiste MAI. Con i soli
// errori, «nessun log» non distingue «tutto ok» da «non è mai partito niente».
// ─────────────────────────────────────────────────────────────────────────────
describe('POST — il percorso felice lascia una traccia di dominio', () => {
  const successo = () =>
    logEvento.mock.calls.find((c) => c[1] === 'info' && JSON.stringify(c[2]).includes('assenza-comunicata'))

  it('una riga `info` con l’alunno, la riga, l’attore e il CONTEGGIO dei docenti avvisati', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    const riga = successo()
    expect(riga, 'nessuna riga di successo: «nessun log» resta ambiguo').toBeTruthy()
    expect(riga?.[0]).toBe('registro')
    expect(riga?.[2]).toMatchObject({
      operazione: 'parent/presenze/comunica-assenza:POST',
      esito: 'assenza-comunicata',
      alunno_id: STUDENT_INFANZIA,
      attore_id: PARENT,
      sezione_id: SEZ_INFANZIA,
      grado: 'infanzia',
      // Senza il conteggio, «la maestra non ha ricevuto niente» resta
      // indistinguibile da «l'avviso è partito e la push non è arrivata».
      n_docenti: 2,
    })
    expect(riga?.[2]).toHaveProperty('presenza_id', db.presenze[0].id)
  })

  it('il conteggio è quello VERO: alunno senza sezione → zero destinatari', async () => {
    await POST(postReq({ studentId: STUDENT_SENZA_SEZIONE, data: OGGI }))
    expect(successo()?.[2]).toMatchObject({ n_docenti: 0, sezione_id: null, grado: null })
  })

  it('la riga di successo NON contiene il motivo dell’assenza', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI, motivo: 'terapia antibiotica' }))
    expect(successo()).toBeTruthy()
    expect(logScritti()).not.toContain('antibiotica')
  })

  it('nessuna riga di successo quando la comunicazione è stata RIFIUTATA', async () => {
    db.presenze = [
      { id: 'p-appello', alunno_id: STUDENT_INFANZIA, data: OGGI, stato: 'presente', registrato_da: MAESTRA_A },
    ]
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(successo()).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LA DATA CHE LEGGE IL DOCENTE.
//
// Il corpo della notifica è l'UNICO testo che questa funzione produce per il
// docente, ed è il motivo per cui la funzione esiste. Usciva con la data ISO
// grezza (`sarà assente il 2026-08-10`) mentre la stessa data, sulla schermata
// del genitore, si legge `10/08/2026`: due formati per lo stesso giorno a due
// utenti diversi. Le notifiche sono PERSISTITE e lette dalla campanella: non
// passano da `useTranslations`, quindi il formato lo decide il server.
// ─────────────────────────────────────────────────────────────────────────────
describe('la data nelle notifiche è italiana, non ISO', () => {
  it('POST: «sarà assente il 10/08/2026»', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    const corpo = String(notifiche('assenza_comunicata')[0].corpo)
    expect(corpo).toContain('10/08/2026')
    expect(corpo).not.toContain(OGGI)
  })

  it('DELETE: anche l’annullamento parla italiano', async () => {
    db.presenze = [
      {
        id: 'p-1',
        alunno_id: STUDENT_INFANZIA,
        section_id: SEZ_INFANZIA,
        scuola_id: SCUOLA,
        data: DOMANI,
        stato: 'assente',
        giustificata_da: PARENT,
        registrato_da: null,
      },
    ]
    db.notifiche = [
      { id: 'n-1', tipo: 'assenza_comunicata', entita_id: 'p-1', utente_id: MAESTRA_A, push_inviata_il: ADESSO },
    ]
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    const corpo = String(annullamenti()[0].corpo)
    expect(corpo).toContain('11/08/2026')
    expect(corpo).not.toContain(DOMANI)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST — ogni rifiuto ha un codice e lascia una traccia', () => {
  it('alunno non trovato → 404 `ALUNNO_NON_TROVATO`', async () => {
    const res = await POST(postReq({ studentId: SCONOSCIUTO, data: OGGI }))
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('ALUNNO_NON_TROVATO')
  })

  it('upsert fallito → 500 `ASSENZA_NON_SALVATA`, e il messaggio di PostgREST NON esce', async () => {
    errori.presenze = { code: '42703', message: 'column presenze.scuola_id does not exist' }
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.codice).toBe('ASSENZA_NON_SALVATA')
    expect(JSON.stringify(body)).not.toContain('does not exist')
    // …ma nel LOG c'è, col codice PostgREST: è ciò che dice perché.
    expect(logScritti()).toContain('42703')
  })

  it('il rifiuto lascia una riga `warn` col codice (i 4xx di `withRoute` sono `info`, e non si persistono)', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: IERI }))
    const riga = logEvento.mock.calls.find((c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_DATA_PASSATA'))
    expect(riga, 'nessun warn sul rifiuto: il difetto è vissuto un mese senza una riga di log').toBeTruthy()
    expect(riga?.[2]).toMatchObject({ operazione: 'parent/presenze/comunica-assenza:POST' })
  })

  it('il MOTIVO dell’assenza non entra in nessun log: è un dato sanitario di un minore', async () => {
    await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI, motivo: 'ricovero per crisi asmatica' }))
    errori.presenze = { code: '42501', message: 'permission denied' }
    await POST(postReq({ studentId: STUDENT_PRIMARIA, data: OGGI, motivo: 'ricovero per crisi asmatica' }))
    expect(logScritti()).not.toContain('asmatica')
  })

  it('il genitore sospeso resta fuori (403) e non scrive niente', async () => {
    h.assertGenitore.mockResolvedValue(NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }))
    const res = await POST(postReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(res.status).toBe(403)
    expect(db.presenze).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE — il genitore annulla ciò che ha comunicato', () => {
  /** La riga come la scrive il POST: giustificata dal genitore, mai lavorata. */
  function comunicata(extra: Record<string, unknown> = {}) {
    db.presenze = [
      {
        id: 'p-1',
        alunno_id: STUDENT_INFANZIA,
        section_id: SEZ_INFANZIA,
        scuola_id: SCUOLA,
        data: DOMANI,
        stato: 'assente',
        giustificata: true,
        giustificata_da: PARENT,
        registrato_da: null,
        ...extra,
      },
    ]
  }

  it('riga propria mai toccata: la riga viene CANCELLATA, non neutralizzata', async () => {
    comunicata()
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(200)
    expect(db.presenze).toHaveLength(0)
  })

  it('dopo l’appello del docente (`registrato_da`): 409 e la riga RESTA', async () => {
    comunicata({ registrato_da: MAESTRA_A })
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ASSENZA_GIA_REGISTRATA')
    expect(db.presenze).toHaveLength(1)
  })

  // ─── AMBITO FAMIGLIA, NON AMBITO AUTORE ───────────────────────────────────
  //
  // Fino a questo ciclo la condizione era `riga.giustificata_da !== userId`: si
  // annullava solo ciò che si era scritto di persona. Misurato in produzione il
  // 2026-08-07: **10 alunni su 26 hanno due genitori in anagrafica**
  // (`student_parents`), e la GET che alimenta l'elenco — `parent/presenze` —
  // NON filtra su chi ha comunicato. Cioè il secondo genitore vedeva la riga,
  // premeva «Annulla» e leggeva «La presenza di questo giorno è già stata
  // registrata»: un messaggio d'errore che dice il falso, mentre l'insegnante
  // non aveva toccato niente.
  //
  // La garanzia è il gate: `requireParentOfStudent` ha già verificato il legame
  // con il bambino, e per un genitore quello scope è la FAMIGLIA (nemmeno la
  // sede si applica: due fratelli possono stare in due plessi). L'identità
  // dell'autore materiale della riga non aggiunge niente a quella verifica.
  it('riga comunicata dall’ALTRO genitore dello stesso alunno: si annulla (ambito FAMIGLIA)', async () => {
    comunicata({ giustificata_da: ALTRO_PARENT })
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ annullata: true })
    expect(db.presenze).toHaveLength(0)
  })

  it('riga NATA DALL’APPELLO (`giustificata_da` nullo): 409, e la riga RESTA', async () => {
    // È il residuo che il controllo di sola ESISTENZA deve continuare a fermare:
    // una riga senza `giustificata_da` non è mai nata da una comunicazione di un
    // genitore. In produzione sono TUTTE E 49 (misurato il 2026-08-07:
    // `count(giustificata_da) = 0`), comprese le 36 che non hanno nemmeno
    // `registrato_da` — quindi nessun backfill serve.
    comunicata({ giustificata_da: null })
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('ASSENZA_GIA_REGISTRATA')
    expect(db.presenze).toHaveLength(1)
  })

  it('il 409 dice nel log QUALE dei due rifiuti è (l’esito non può mentire)', async () => {
    // Un solo codice a schermo, due diagnosi diverse nel log: si correggono in
    // due modi diversi, e la differenza non si legge dallo status.
    comunicata({ registrato_da: MAESTRA_A })
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(
      logEvento.mock.calls.find((c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_GIA_REGISTRATA'))?.[2],
    ).toMatchObject({ esito: 'appello-gia-fatto' })

    vi.clearAllMocks()
    comunicata({ giustificata_da: null })
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(
      logEvento.mock.calls.find((c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_GIA_REGISTRATA'))?.[2],
    ).toMatchObject({ esito: 'non-nata-da-comunicazione' })
  })

  it('il successo porta nel log l’uuid di CHI ha annullato, non di chi aveva comunicato', async () => {
    // Con l'ambito famiglia «chi l'ha tolta» smette di essere deducibile dalla
    // riga cancellata: se non lo scrive il log non lo sa più nessuno.
    comunicata({ giustificata_da: ALTRO_PARENT })
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    const riga = logEvento.mock.calls.find(
      (c) => c[1] === 'info' && JSON.stringify(c[2]).includes('assenza-annullata'),
    )
    expect(riga, 'nessuna riga di successo: «nessun log» tornerebbe ambiguo').toBeTruthy()
    expect(riga?.[2]).toMatchObject({ attore_id: PARENT, alunno_id: STUDENT_INFANZIA })
  })

  it('niente da annullare: 200 idempotente, nessun errore inventato', async () => {
    db.presenze = []
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ annullata: false })
  })

  it('revoca le notifiche ANCORA IN CODA e lascia stare quelle già partite', async () => {
    comunicata()
    db.notifiche = [
      { id: 'n-1', tipo: 'assenza_comunicata', entita_id: 'p-1', utente_id: MAESTRA_A, push_inviata_il: null },
      { id: 'n-2', tipo: 'assenza_comunicata', entita_id: 'p-altro', utente_id: MAESTRA_B, push_inviata_il: null },
      { id: 'n-3', tipo: 'nota_disciplinare', entita_id: 'p-1', utente_id: MAESTRA_A, push_inviata_il: null },
    ]
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(db.notifiche.map((n) => n.id).sort()).toEqual(['n-2', 'n-3'])
  })

  it('push già partita → i docenti ricevono l’ANNULLAMENTO (meglio una in più)', async () => {
    comunicata()
    db.notifiche = [
      { id: 'n-1', tipo: 'assenza_comunicata', entita_id: 'p-1', utente_id: MAESTRA_A, push_inviata_il: '2026-08-10T08:00:00Z' },
    ]
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))

    const righe = annullamenti()
    expect(righe.map((n) => n.utente_id).sort()).toEqual([MAESTRA_A, MAESTRA_B].sort())
    expect(righe[0].link).toBe('/teacher/attendance')
    expect(String(righe[0].corpo)).toContain('Sofia Rossi')
  })

  it('push non ancora partita e revocata: nessuna notifica di annullamento', async () => {
    comunicata()
    db.notifiche = [
      { id: 'n-1', tipo: 'assenza_comunicata', entita_id: 'p-1', utente_id: MAESTRA_A, push_inviata_il: null },
    ]
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(annullamenti()).toHaveLength(0)
  })

  it('il genitore sospeso non annulla (403) e la riga resta', async () => {
    comunicata()
    h.assertGenitore.mockResolvedValue(NextResponse.json({ motivo: 'account_sospeso' }, { status: 403 }))
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(403)
    expect(db.presenze).toHaveLength(1)
  })

  it('parametri non validi → 400, e il gate non viene nemmeno interpellato a vuoto', async () => {
    const res = await DELETE(deleteReq({ studentId: 'non-un-uuid', data: 'boh' }))
    expect(res.status).toBe(400)
    expect(db.presenze).toHaveLength(0)
  })

  it('lettura della riga fallita → 500 con codice, mai un «niente da annullare» falso', async () => {
    comunicata()
    errori.presenze = { code: '42501', message: 'permission denied for table presenze' }
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBeTruthy()
    expect(logScritti()).toContain('42501')
  })

  it('il rifiuto 409 lascia una riga `warn` con l’uuid della riga, mai il motivo', async () => {
    comunicata({ registrato_da: MAESTRA_A, giustificazione_testo: 'terapia antibiotica' })
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: DOMANI }))
    const riga = logEvento.mock.calls.find((c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_GIA_REGISTRATA'))
    expect(riga?.[2]).toMatchObject({ operazione: 'parent/presenze/comunica-assenza:DELETE' })
    expect(logScritti()).not.toContain('antibiotica')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // SI ANNULLA CIÒ CHE DEVE ANCORA ACCADERE, NON CIÒ CHE È GIÀ STATO.
  //
  // La regola temporale viveva in UNO SOLO dei due versi del gesto: il POST
  // rifiutava le date passate, il DELETE no. Il criterio di annullabilità
  // (`registrato_da` nullo + `giustificata_da` valorizzato) è esattamente la
  // forma che assume un'assenza dello 0-6 registrata prima di questo ciclo e poi
  // GIUSTIFICATA dal genitore — `parent/presenze/giustifica` scrive
  // `giustificata_da` su qualunque riga passata. Bastava quello perché una riga
  // vera del registro sparisse fisicamente, insieme alla sua firma elettronica.
  // ───────────────────────────────────────────────────────────────────────────
  it('data PASSATA → 400 `ASSENZA_DATA_PASSATA`, e la riga storica RESTA', async () => {
    db.presenze = [
      {
        id: 'p-storica',
        alunno_id: STUDENT_INFANZIA,
        section_id: SEZ_INFANZIA,
        scuola_id: SCUOLA,
        data: IERI,
        stato: 'assente',
        giustificata: true,
        giustificata_da: PARENT,
        giustificazione_firma: 'firma-otp-2026',
        registrato_da: null,
      },
    ]
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: IERI }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('ASSENZA_DATA_PASSATA')
    expect(db.presenze).toHaveLength(1)
    expect(db.presenze[0].giustificazione_firma).toBe('firma-otp-2026')
  })

  it('il rifiuto per data passata non tocca nemmeno la tabella, e lascia un `warn`', async () => {
    await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: IERI }))
    expect(scritture.filter((s) => s.tabella === 'presenze')).toHaveLength(0)
    const riga = logEvento.mock.calls.find(
      (c) => c[1] === 'warn' && JSON.stringify(c[2]).includes('ASSENZA_DATA_PASSATA'),
    )
    expect(riga?.[2]).toMatchObject({ operazione: 'parent/presenze/comunica-assenza:DELETE', stato: 400 })
  })

  it('oggi resta annullabile: la regola è «da oggi in avanti», non «solo il futuro»', async () => {
    comunicata({ data: OGGI })
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: OGGI }))
    expect(res.status).toBe(200)
    expect(db.presenze).toHaveLength(0)
  })

  it('a mezzanotte e mezza italiana il confine è quello ROMANO', async () => {
    // 22:30 UTC del 10 = 00:30 dell'11 a Roma: il 10 è già ieri, e non si annulla
    // più, mentre con la data grezza UTC sarebbe ancora «oggi» per due ore.
    vi.setSystemTime(new Date('2026-08-10T22:30:00Z'))
    comunicata({ data: '2026-08-10' })
    const res = await DELETE(deleteReq({ studentId: STUDENT_INFANZIA, data: '2026-08-10' }))
    expect(res.status).toBe(400)
    expect(db.presenze).toHaveLength(1)
  })
})
