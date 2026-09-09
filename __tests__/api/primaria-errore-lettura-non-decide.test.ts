import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ─── L11 · «Il ritorno { error } che cambia una decisione» ────────────────────
 *
 * PostgREST NON lancia: ritorna `{ data, error }`. Un `try/catch` attorno a
 * `await supabase.from(...)` non scatta mai, e un `const { data } = await …`
 * che butta via l'`error` non produce «errore»: produce `data === null`, che
 * a valle diventa `?? []`, cioè **elenco vuoto**.
 *
 * Nella maggior parte dei casi un elenco vuoto è solo una schermata povera.
 * Nei casi qui sotto è una DECISIONE DIVERSA, presa dal codice al posto di chi
 * lavora:
 *
 *  - `scrutinio/chiudi` — nessun alunno e nessuna materia significa «nessun
 *    giudizio mancante», cioè scrutinio COMPLETO. La riga passa a `stato =
 *    'chiuso'` con `chiuso_da`/`chiuso_il`, e la rotta gemella
 *    (`/scrutinio` POST e PATCH) da quel momento risponde **423** a ogni
 *    modifica. Un guasto di lettura di due secondi chiude uno scrutinio
 *    incompleto in modo che l'interfaccia non sa più riaprire.
 *  - `pagella/batch` — zero alunni significa zero PDF da generare, e la
 *    risposta è `{ success: true, generate: 0, totale: 0, errori: [] }`: la
 *    dirigenza legge «fatto» dove non è partito niente.
 *  - `scrutinio/import` — la scala dei giudizi ufficiali letta a vuoto
 *    DISATTIVA il controllo `scalaSet.size > 0`, e un CSV entra con giudizi
 *    che la scuola non ha mai configurato.
 *  - `scrutinio` POST — l'elenco dei giudizi già proposti letto a vuoto fa
 *    perdere `proposto_da`, cioè il «vero valutatore» (vincolo FEA): la
 *    segreteria che salva riscrive l'attribuzione di TUTTI i giudizi.
 *  - `scrutinio` POST — le materie della sezione e le materie del docente
 *    lette a vuoto diventano **403** («non appartenente alla sezione»,
 *    «non assegnata al docente»): al docente si dice che non ha il permesso,
 *    mentre il fatto è che il database non ha risposto.
 *
 * Ogni test qui sotto è stato visto ROSSO sul codice di prima: il verdetto
 * atteso è quello di dopo, e i commenti dicono che cosa faceva prima.
 */

const h = vi.hoisted(() => {
  const state = {
    queues: {} as Record<string, Array<{ data: unknown; error: unknown }>>,
    used: {} as Record<string, number>,
    captured: { insert: [] as unknown[], update: [] as unknown[], upsert: [] as unknown[] },
  }
  function take(table: string) {
    const q = state.queues[table] || []
    const i = state.used[table] ?? 0
    state.used[table] = i + 1
    return q[i] ?? { data: null, error: null }
  }
  function makeClient() {
    return {
      from(table: string) {
        const qb: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order', 'limit', 'in', 'not', 'gte', 'lte', 'is', 'neq']) qb[m] = () => qb
        qb.insert = (v: unknown) => { state.captured.insert.push({ table, v }); return qb }
        qb.update = (v: unknown) => { state.captured.update.push({ table, v }); return qb }
        qb.upsert = (v: unknown) => { state.captured.upsert.push({ table, v }); return qb }
        qb.single = () => Promise.resolve(take(table))
        qb.maybeSingle = () => Promise.resolve(take(table))
        qb.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(take(table)).then(res, rej)
        return qb
      },
    }
  }
  return { state, makeClient }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue(h.makeClient()),
}))

const authMock = vi.hoisted(() => ({ requireStaff: vi.fn(), requireDocente: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: authMock.requireStaff,
  requireDocente: authMock.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
  assertAlunnoInScope: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/audit/valutatore', () => ({
  titolareDiMateria: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: vi.fn().mockResolvedValue(undefined),
  notificaTitolariScrittura: vi.fn().mockResolvedValue(undefined),
}))
const pagellaMock = vi.hoisted(() => ({ generaPagella: vi.fn() }))
vi.mock('@/lib/primaria/pagella-store', () => ({ generaPagella: pagellaMock.generaPagella }))

import { POST as CHIUDI } from '@/app/api/primaria/scrutinio/chiudi/route'
import { POST as BATCH } from '@/app/api/primaria/pagella/batch/route'
import { POST as IMPORTA } from '@/app/api/primaria/scrutinio/import/route'
import { POST as PROPONI, PATCH as COMPORTAMENTO } from '@/app/api/primaria/scrutinio/route'
import { NextRequest } from 'next/server'

// Uuid finti, generati a mano: nessuno di questi esiste in produzione.
const SCRUTINIO = 'a0000000-0000-4000-8000-000000000001'
const SEZIONE = 'b0000000-0000-4000-8000-000000000002'
const ALUNNO = 'c0000000-0000-4000-8000-000000000003'
const MATERIA = 'd0000000-0000-4000-8000-000000000004'
const DOCENTE = 'e0000000-0000-4000-8000-000000000005'

const GUASTO = { message: 'canceling statement due to statement timeout', code: '57014' }

function req(url: string, body: unknown, metodo: 'POST' | 'PATCH' = 'POST'): NextRequest {
  return new NextRequest(url, {
    method: metodo,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

const scritture = () => h.state.captured.upsert.concat(h.state.captured.update, h.state.captured.insert) as Array<{ table: string; v: unknown }>

beforeEach(() => {
  vi.clearAllMocks()
  h.state.queues = {}
  h.state.used = {}
  h.state.captured = { insert: [], update: [], upsert: [] }
  authMock.requireStaff.mockResolvedValue({
    user: { id: DOCENTE, role: 'admin', scuola_id: 'sc-1' }, response: null,
  })
  authMock.requireDocente.mockResolvedValue({
    user: { id: DOCENTE, role: 'educator', scuola_id: 'sc-1' }, response: null,
  })
  pagellaMock.generaPagella.mockResolvedValue({ error: null })
})

// ═════════════════════════════════════════════════════════════════════════════
// scrutinio/chiudi — la chiusura è IRREVERSIBILE dall'interfaccia
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/primaria/scrutinio/chiudi — una lettura fallita non chiude lo scrutinio', () => {
  // Le due righe di `scrutini`: la SELECT del gate e poi l'UPDATE di chiusura,
  // che qui si finge riuscito apposta — così, se il codice ci arriva, il test
  // vede una 200 e non un 500 di rimbalzo.
  function seedScrutinioApertoEChiusuraRiuscita() {
    h.state.queues.scrutini = [
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p-1', stato: 'aperto' }, error: null },
      { data: { id: SCRUTINIO, stato: 'chiuso' }, error: null },
    ]
  }

  it('l’elenco alunni non letto NON diventa «nessun giudizio mancante»', async () => {
    seedScrutinioApertoEChiusuraRiuscita()
    h.state.queues.alunni = [{ data: null, error: GUASTO }]
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.scrutinio_giudizi = [{ data: [], error: null }]
    h.state.queues.scrutinio_comportamento = [{ data: [], error: null }]

    const res = await CHIUDI(req('http://localhost/api/primaria/scrutinio/chiudi', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(500)
    // Il fatto che conta: la riga `scrutini` NON è stata portata a 'chiuso'.
    expect(scritture().filter((c) => c.table === 'scrutini')).toEqual([])
  })

  it('l’elenco materie non letto NON diventa «nessuna disciplina da valutare»', async () => {
    seedScrutinioApertoEChiusuraRiuscita()
    h.state.queues.alunni = [{ data: [{ id: ALUNNO }], error: null }]
    h.state.queues.materie = [{ data: null, error: GUASTO }]
    // Comportamento presente: senza materie, `mancanti` resterebbe vuoto.
    h.state.queues.scrutinio_giudizi = [{ data: [], error: null }]
    h.state.queues.scrutinio_comportamento = [{ data: [{ alunno_id: ALUNNO, giudizio_testo: 'ok' }], error: null }]

    const res = await CHIUDI(req('http://localhost/api/primaria/scrutinio/chiudi', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(500)
    expect(scritture().filter((c) => c.table === 'scrutini')).toEqual([])
  })

  it('lo scrutinio non letto è 500, non 404: «non trovato» accusa chi ha cliccato', async () => {
    h.state.queues.scrutini = [{ data: null, error: GUASTO }]

    const res = await CHIUDI(req('http://localhost/api/primaria/scrutinio/chiudi', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(500)
  })

  // Le altre DUE del `Promise.all`. Non chiudono niente — falliscono chiuse, con un
  // 422 — ma quel 422 non è meno sbagliato: è l'elenco dei «mancanti» che diventa
  // TUTTA la classe per TUTTE le discipline, cioè il lavoro già fatto dichiarato da
  // rifare a chi l'aveva fatto. Un guasto nostro raccontato come un buco suo.
  it('i giudizi non letti NON diventano «mancano tutti» in faccia al docente', async () => {
    seedScrutinioApertoEChiusuraRiuscita()
    h.state.queues.alunni = [{ data: [{ id: ALUNNO }], error: null }]
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.scrutinio_giudizi = [{ data: null, error: GUASTO }]
    h.state.queues.scrutinio_comportamento = [{ data: [{ alunno_id: ALUNNO, giudizio_testo: 'Corretto' }], error: null }]

    const res = await CHIUDI(req('http://localhost/api/primaria/scrutinio/chiudi', { scrutinioId: SCRUTINIO }))

    // Prima: 422 con `incompleto: true` e `mancanti` pieno di giudizi che ci sono.
    expect(res.status).toBe(500)
    expect(await res.json()).not.toHaveProperty('incompleto')
    expect(scritture().filter((c) => c.table === 'scrutini')).toEqual([])
  })

  it('il comportamento non letto NON diventa «manca il comportamento di tutti»', async () => {
    seedScrutinioApertoEChiusuraRiuscita()
    h.state.queues.alunni = [{ data: [{ id: ALUNNO }], error: null }]
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.scrutinio_giudizi = [{ data: [{ alunno_id: ALUNNO, materia_id: MATERIA, giudizio_sintetico: 'Buono' }], error: null }]
    h.state.queues.scrutinio_comportamento = [{ data: null, error: GUASTO }]

    const res = await CHIUDI(req('http://localhost/api/primaria/scrutinio/chiudi', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(500)
    expect(await res.json()).not.toHaveProperty('incompleto')
    expect(scritture().filter((c) => c.table === 'scrutini')).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// pagella/batch — «fatto» non si dice quando non è partito niente
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/primaria/pagella/batch — zero alunni letti non è «zero pagelle da fare»', () => {
  it('l’elenco alunni non letto NON risponde success con totale 0', async () => {
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, section_id: SEZIONE, stato: 'chiuso' }, error: null }]
    h.state.queues.alunni = [{ data: null, error: GUASTO }]

    const res = await BATCH(req('http://localhost/api/primaria/pagella/batch', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(500)
    expect(pagellaMock.generaPagella).not.toHaveBeenCalled()
  })

  it('lo scrutinio non letto è 500, non 404', async () => {
    h.state.queues.scrutini = [{ data: null, error: GUASTO }]

    const res = await BATCH(req('http://localhost/api/primaria/pagella/batch', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(500)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// scrutinio/import — la scala non letta disattivava il controllo di scala
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/primaria/scrutinio/import — una lettura fallita non allarga ciò che è ammesso', () => {
  function seedAnagrafiche() {
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, section_id: SEZIONE, stato: 'aperto' }, error: null }]
    h.state.queues.alunni = [{ data: [{ id: ALUNNO, nome: 'Alfa', cognome: 'Beta' }], error: null }]
    h.state.queues.materie = [{ data: [{ id: MATERIA, nome: 'Matematica', codice: 'MAT' }], error: null }]
    h.state.queues.sections = [{ data: { scuola_id: 'sc-1' }, error: null }]
  }
  const riga = { alunnoId: ALUNNO, materiaId: MATERIA, giudizioSintetico: 'FUORI SCALA' }

  it('la scala non letta NON fa passare un giudizio che la scuola non ha configurato', async () => {
    seedAnagrafiche()
    h.state.queues.giudizi_sintetici_scala = [{ data: null, error: GUASTO }]
    h.state.queues.scrutinio_giudizi = [{ data: [{ id: 'g-1' }], error: null }]

    const res = await IMPORTA(req('http://localhost/api/primaria/scrutinio/import', { scrutinioId: SCRUTINIO, righe: [riga] }))

    expect(res.status).toBe(500)
    expect(scritture().filter((c) => c.table === 'scrutinio_giudizi')).toEqual([])
  })

  it('la sezione non letta NON aggira la scala per la via del `scuola_id` mancante', async () => {
    seedAnagrafiche()
    h.state.queues.sections = [{ data: null, error: GUASTO }]
    h.state.queues.scrutinio_giudizi = [{ data: [{ id: 'g-1' }], error: null }]

    const res = await IMPORTA(req('http://localhost/api/primaria/scrutinio/import', { scrutinioId: SCRUTINIO, righe: [riga] }))

    expect(res.status).toBe(500)
    expect(scritture().filter((c) => c.table === 'scrutinio_giudizi')).toEqual([])
  })

  it('l’anagrafica non letta NON diventa «Alunno non trovato» riga per riga', async () => {
    seedAnagrafiche()
    h.state.queues.alunni = [{ data: null, error: GUASTO }]

    const res = await IMPORTA(req('http://localhost/api/primaria/scrutinio/import', { scrutinioId: SCRUTINIO, righe: [riga] }))

    expect(res.status).toBe(500)
    const corpo = await res.json()
    // Prima: 200 con `errori: [{ riga: 1, messaggio: 'Alunno non trovato: …' }]`,
    // cioè la colpa addossata al file caricato dall'insegnante.
    expect(JSON.stringify(corpo)).not.toContain('Alunno non trovato')
  })

  it('il catalogo materie non letto NON diventa «Materia non trovata» riga per riga', async () => {
    seedAnagrafiche()
    h.state.queues.materie = [{ data: null, error: GUASTO }]

    const res = await IMPORTA(req('http://localhost/api/primaria/scrutinio/import', { scrutinioId: SCRUTINIO, righe: [riga] }))

    expect(res.status).toBe(500)
    // Gemello del test qui sopra, e sbagliato allo stesso modo: prima usciva 200
    // con «Materia non trovata: Matematica» su una materia che c'è.
    expect(JSON.stringify(await res.json())).not.toContain('Materia non trovata')
  })

  it('lo scrutinio non letto è 500, non 404 (l’import non è un indirizzo sbagliato)', async () => {
    h.state.queues.scrutini = [{ data: null, error: GUASTO }]

    const res = await IMPORTA(req('http://localhost/api/primaria/scrutinio/import', { scrutinioId: SCRUTINIO, righe: [riga] }))

    expect(res.status).toBe(500)
    expect(scritture().filter((c) => c.table === 'scrutinio_giudizi')).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// scrutinio POST — 403 al posto di 500, e l'attribuzione FEA riscritta
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/primaria/scrutinio — una lettura fallita non è un permesso negato', () => {
  const body = { scrutinioId: SCRUTINIO, giudizi: [{ alunnoId: ALUNNO, materiaId: MATERIA, giudizioSintetico: 'Buono' }] }
  const url = 'http://localhost/api/primaria/scrutinio'

  function seedScrutinioAperto() {
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, stato: 'aperto', section_id: SEZIONE }, error: null }]
  }

  it('le materie della sezione non lette sono 500, non 403 «non appartenente alla sezione»', async () => {
    seedScrutinioAperto()
    h.state.queues.materie = [{ data: null, error: GUASTO }]

    const res = await PROPONI(req(url, body))

    expect(res.status).toBe(500)
    expect(scritture().filter((c) => c.table === 'scrutinio_giudizi')).toEqual([])
  })

  it('le materie del docente non lette sono 500, non 403 «non assegnata al docente»', async () => {
    seedScrutinioAperto()
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.utenti_sezioni_materie = [{ data: null, error: GUASTO }]

    const res = await PROPONI(req(url, body))

    expect(res.status).toBe(500)
    expect(scritture().filter((c) => c.table === 'scrutinio_giudizi')).toEqual([])
  })

  it('i giudizi già proposti non letti NON fanno riscrivere `proposto_da` (vincolo FEA)', async () => {
    // Ramo segreteria/staff: `proposto_da` esistente va PRESERVATO. Con la lettura
    // fallita la mappa resta vuota, ogni giudizio sembra nuovo e l'attribuzione
    // passa al titolare della materia — o a `null` — su TUTTA la classe.
    authMock.requireDocente.mockResolvedValue({
      user: { id: DOCENTE, role: 'segreteria', scuola_id: 'sc-1' }, response: null,
    })
    seedScrutinioAperto()
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.scrutinio_giudizi = [
      { data: null, error: GUASTO },              // lettura dei proponenti esistenti
      { data: [{ id: 'g-1' }], error: null },     // upsert, se il codice ci arrivasse
    ]

    const res = await PROPONI(req(url, body))

    expect(res.status).toBe(500)
    expect(scritture().filter((c) => c.table === 'scrutinio_giudizi')).toEqual([])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// scrutinio PATCH — il guasto di scrittura non parla inglese a chi lavora
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/primaria/scrutinio — il `message` di PostgREST resta nel log', () => {
  const url = 'http://localhost/api/primaria/scrutinio'
  const body = { scrutinioId: SCRUTINIO, comportamento: [{ alunnoId: ALUNNO, giudizioTesto: 'Corretto' }] }

  it('l’upsert respinto non rimanda al browser il testo di PostgREST', async () => {
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, stato: 'aperto', section_id: SEZIONE }, error: null }]
    h.state.queues.scrutinio_comportamento = [{ data: null, error: GUASTO }]

    const res = await COMPORTAMENTO(req(url, body, 'PATCH'))

    expect(res.status).toBe(500)
    const corpo = (await res.json()) as { error?: string }
    // Il 2026-09-05 la stessa forma (`{ error: error.message }` su un upsert) ha
    // messo davanti alla segreteria di Cesa «there is no unique or exclusion
    // constraint matching the ON CONFLICT specification», nove volte di fila.
    expect(corpo.error).not.toBe(GUASTO.message)
    expect(corpo.error).not.toContain('statement')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// CONTROLLI POSITIVI — le guardie non devono essere «sempre accese».
//
// Una guardia che scatta anche quando l'`error` è `null` renderebbe verdi tutti i
// test qui sopra rompendo la route: «500 su una lettura fallita» e «500 sempre»
// hanno lo stesso colore. Questi cinque dicono che il comportamento normale è
// rimasto quello di prima, validazione di completezza compresa.
// ═════════════════════════════════════════════════════════════════════════════
describe('controlli positivi — a letture riuscite la route fa quello che faceva', () => {
  it('chiudi: scrutinio completo → 200 e la riga passa a chiuso', async () => {
    h.state.queues.scrutini = [
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p-1', stato: 'aperto' }, error: null },
      { data: { id: SCRUTINIO, stato: 'chiuso' }, error: null },
    ]
    h.state.queues.alunni = [{ data: [{ id: ALUNNO }], error: null }]
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.scrutinio_giudizi = [{ data: [{ alunno_id: ALUNNO, materia_id: MATERIA, giudizio_sintetico: 'Buono' }], error: null }]
    h.state.queues.scrutinio_comportamento = [{ data: [{ alunno_id: ALUNNO, giudizio_testo: 'Corretto' }], error: null }]

    const res = await CHIUDI(req('http://localhost/api/primaria/scrutinio/chiudi', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(200)
    const scritto = scritture().find((c) => c.table === 'scrutini')
    expect((scritto?.v as { stato?: string } | undefined)?.stato).toBe('chiuso')
  })

  it('chiudi: manca il comportamento di un alunno → 422, non 500 (la validazione è viva)', async () => {
    h.state.queues.scrutini = [
      { data: { id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'p-1', stato: 'aperto' }, error: null },
      { data: { id: SCRUTINIO, stato: 'chiuso' }, error: null },
    ]
    h.state.queues.alunni = [{ data: [{ id: ALUNNO }], error: null }]
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.scrutinio_giudizi = [{ data: [{ alunno_id: ALUNNO, materia_id: MATERIA, giudizio_sintetico: 'Buono' }], error: null }]
    h.state.queues.scrutinio_comportamento = [{ data: [], error: null }]

    const res = await CHIUDI(req('http://localhost/api/primaria/scrutinio/chiudi', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(422)
    expect(scritture().filter((c) => c.table === 'scrutini')).toEqual([])
  })

  it('pagella/batch: alunni letti → 200 e una pagella per alunno', async () => {
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, section_id: SEZIONE, stato: 'chiuso' }, error: null }]
    h.state.queues.alunni = [{ data: [{ id: ALUNNO }], error: null }]

    const res = await BATCH(req('http://localhost/api/primaria/pagella/batch', { scrutinioId: SCRUTINIO }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, generate: 1, totale: 1 })
    expect(pagellaMock.generaPagella).toHaveBeenCalledTimes(1)
  })

  it('import: giudizio IN scala → 200 e riga scritta', async () => {
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, section_id: SEZIONE, stato: 'aperto' }, error: null }]
    h.state.queues.alunni = [{ data: [{ id: ALUNNO, nome: 'Alfa', cognome: 'Beta' }], error: null }]
    h.state.queues.materie = [{ data: [{ id: MATERIA, nome: 'Matematica', codice: 'MAT' }], error: null }]
    h.state.queues.sections = [{ data: { scuola_id: 'sc-1' }, error: null }]
    h.state.queues.giudizi_sintetici_scala = [{ data: [{ etichetta: 'Avanzato' }], error: null }]
    h.state.queues.scrutinio_giudizi = [{ data: [{ id: 'g-1' }], error: null }]

    const res = await IMPORTA(req('http://localhost/api/primaria/scrutinio/import', {
      scrutinioId: SCRUTINIO,
      righe: [{ alunnoId: ALUNNO, materiaId: MATERIA, giudizioSintetico: 'Avanzato' }],
    }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, importate: 1, errori: [] })
  })

  it('scrutinio POST (staff): i proponenti letti restano quelli di prima', async () => {
    const TITOLARE_VERO = '99999999-9999-4999-8999-999999999999'
    authMock.requireDocente.mockResolvedValue({
      user: { id: DOCENTE, role: 'segreteria', scuola_id: 'sc-1' }, response: null,
    })
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, stato: 'aperto', section_id: SEZIONE }, error: null }]
    h.state.queues.materie = [{ data: [{ id: MATERIA }], error: null }]
    h.state.queues.scrutinio_giudizi = [
      { data: [{ alunno_id: ALUNNO, materia_id: MATERIA, proposto_da: TITOLARE_VERO }], error: null },
      { data: [{ id: 'g-1' }], error: null },
    ]

    const res = await PROPONI(req('http://localhost/api/primaria/scrutinio', {
      scrutinioId: SCRUTINIO,
      giudizi: [{ alunnoId: ALUNNO, materiaId: MATERIA, giudizioSintetico: 'Buono' }],
    }))

    expect(res.status).toBe(200)
    const righe = (scritture().find((c) => c.table === 'scrutinio_giudizi')?.v ?? []) as Array<{ proposto_da: string | null }>
    // Il valore che conta: NON quello che `titolareDiMateria` avrebbe restituito.
    expect(righe[0]?.proposto_da).toBe(TITOLARE_VERO)
  })

  it('scrutinio PATCH: upsert riuscito → 200 e la riga di comportamento scritta', async () => {
    h.state.queues.scrutini = [{ data: { id: SCRUTINIO, stato: 'aperto', section_id: SEZIONE }, error: null }]
    h.state.queues.scrutinio_comportamento = [{ data: [{ id: 'c-1' }], error: null }]

    const res = await COMPORTAMENTO(req('http://localhost/api/primaria/scrutinio', {
      scrutinioId: SCRUTINIO,
      comportamento: [{ alunnoId: ALUNNO, giudizioTesto: 'Corretto' }],
    }, 'PATCH'))

    expect(res.status).toBe(200)
    const scritto = scritture().find((c) => c.table === 'scrutinio_comportamento')
    expect((scritto?.v as Array<{ giudizio_testo?: string }> | undefined)?.[0]?.giudizio_testo).toBe('Corretto')
  })
})
