import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { madreSopravvive, materializzaEmbedSede, togliGliEmbed } from '../helpers/embed-sede'

// =============================================================================
// LA ROTTA CHE ETICHETTA UN CURRICULUM — collaudo funzionale.
//
// ─── PERCHÉ QUESTO FILE ESISTE ───────────────────────────────────────────────
//
// Il lavoro che ha introdotto l'etichetta portava con sé UN SOLO test, e quel
// test verificava un'ASSENZA: che dalla rotta non si potesse raggiungere un
// percorso d'invio email. È un ottimo lock e non si tocca — ma «non manda email»
// non dice niente su chi può scrivere, su cosa succede dove la colonna non
// esiste, e su quante colonne la UPDATE tocca davvero.
//
// Questa è una rotta di SCRITTURA su dati di selezione del personale: le
// domande che merita sono tre, e sono tutte qui sotto.
//
//   1. IL PERIMETRO DI SEDE. Una candidatura di un altro plesso risponde 404 —
//      lo stesso identico 404 di una che non è mai esistita. Distinguerli
//      direbbe a chi non ha titolo che quella persona si è candidata, e da lì
//      si arriva al suo curriculum. E soprattutto: NON deve scrivere niente.
//
//   2. IL DEGRADO SU COLONNA ASSENTE. Il database E2E della CI è un progetto
//      separato e non è migrato: là `etichetta` non esiste e PostgREST risponde
//      `42703`. Deve uscirne una mappa vuota che DICE di essere vuota
//      (`colonnaAssente: true`), non un 500 — e nemmeno un 200 muto, che il
//      pannello leggerebbe come «nessuno ha etichettato niente» disegnando un
//      menu che non salva. ⚠️ E il degrado deve essere STRETTO: un errore
//      qualunque non può travestirsi da ambiente non migrato, o il giorno in cui
//      la tabella si rompe davvero nessuno lo saprà.
//
//   3. IL CORPO CHIUSO. `.strict()` non è formalismo: un campo in più che passa
//      è un campo in più che qualcuno, un giorno, farà arrivare alla `update`.
//
// ─── E UNA QUARTA, CHE NON È UNA REGOLA MA UNA CICATRICE ────────────────────
//
// La UPDATE scrive TRE colonne. Se ne toccasse una quarta — `copia_inviata_il`,
// che sta lì accanto — la candidatura rientrerebbe nella coda di
// `inoltro-arretrato`, che rispedisce alla casella del plesso il modulo
// compilato e il CURRICULUM. Il test guarda le CHIAVI dell'oggetto passato a
// `update`, non l'esito: è l'unico punto in cui quella quarta colonna si vede.
//
// ⚠️ Nomi e uuid inventati: il repository è pubblico e queste sono persone vere.
// =============================================================================

type Riga = Record<string, unknown>
interface Filtro { col: string; vals: unknown[] }

const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE_A }

/** Candidature: due della mia sede (una etichettata), una di un altro plesso. */
const MIA_ETICHETTATA = 'dddddddd-0000-4000-8000-00000000000a'
const MIA_NUDA = 'dddddddd-0000-4000-8000-00000000000b'
const ALTRUI = 'dddddddd-0000-4000-8000-00000000000c'
const MAI_ESISTITA = 'dddddddd-0000-4000-8000-00000000000f'

const h = vi.hoisted(() => {
  const state = {
    utente: null as { id: string; role: string; scuola_id: string } | null,
    scuole: [] as string[],
    tabelle: {} as Record<string, Riga[]>,
    /**
     * L'errore che PostgREST RITORNA (non lancia): è il modo in cui la colonna
     * assente si presenta, ed è anche il motivo per cui un `try/catch` attorno
     * a `await supabase.from(…)` non scatterebbe mai.
     */
    erroreLettura: null as null | { code?: string; message: string },
    erroreScrittura: null as null | { code?: string; message: string },
    /** Ogni `update` osservata. Del patch interessano le CHIAVI, non i valori. */
    aggiornamenti: [] as { table: string; patch: Riga }[],
  }
  return {
    state,
    requireStaff: vi.fn(),
    logScrittura: vi.fn(),
    logEvento: vi.fn(),
    logErrore: vi.fn(),
    logOk: vi.fn(),
  }
})

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// ⚠️ `restringiSedi` e `formaConfronto` restano QUELLE VERE: sostituirle con un
// finto che dice sempre sì proverebbe il finto, non il perimetro.
vi.mock('@/lib/auth/scope', async (importOriginal) => {
  const vero = await importOriginal<typeof import('@/lib/auth/scope')>()
  return {
    formaConfronto: vero.formaConfronto,
    restringiSedi: vero.restringiSedi,
    resolveScuoleAttive: async () => h.state.scuole,
  }
})
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: h.logEvento,
  logErrore: h.logErrore,
  logOk: h.logOk,
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

/** Proiezione: `select('a, b')` restituisce SOLO quelle chiavi. */
function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  for (const c of togliGliEmbed(cols).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (c in r) fuori[c] = r[c]
  }
  return fuori
}

/** Le righe di sede di una candidatura: sono LORO il criterio d'accesso. */
const sediDi = (id: unknown) =>
  (h.state.tabelle['candidature_sedi'] ?? []).filter((s) => s.candidatura_id === id)

/**
 * Il finto client. Sa fare quattro cose che qui contano:
 *  · il filtro sull'EMBED `candidature_sedi!inner(...)` (via l'helper condiviso:
 *    un finto che ignorasse il punto in `candidature_sedi.scuola_id` non
 *    escluderebbe NIENTE, e ogni test d'isolamento sarebbe verde per costruzione);
 *  · `.not('etichetta','is',null)`, che è ciò che tiene la mappa piccola;
 *  · `limit` + `count: 'exact'` SEPARATI, che è l'unico modo di vedere una mappa
 *    tagliata (`total > data.length`);
 *  · ritornare un errore invece di lanciarlo, come fa PostgREST.
 */
function finto() {
  const righeDi = (t: string) => (h.state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      /** I `not(col, 'is', null)`: le colonne che devono essere valorizzate. */
      const nonNulle: string[] = []
      let cols = '*'
      let conteggio = false
      let limite: number | null = null
      let patch: Riga | null = null

      const corrisponde = (r: Riga) =>
        filtri.every((f) => (f.col.includes('.') ? true : f.vals.some((v) => r[f.col] === v))) &&
        nonNulle.every((c) => r[c] !== null && r[c] !== undefined) &&
        madreSopravvive(cols, sediDi(r.id), filtri)

      const conEmbed = (r: Riga) => ({
        ...proietta(r, cols),
        ...materializzaEmbedSede(cols, sediDi(r.id), filtri),
      })

      const esegui = () => {
        if (patch) {
          if (h.state.erroreScrittura) return { data: [] as Riga[], error: h.state.erroreScrittura, count: null }
          const trovate = righeDi(table).filter(corrisponde)
          h.state.aggiornamenti.push({ table, patch: { ...patch } })
          for (const r of trovate) Object.assign(r, patch)
          return { data: trovate.map(conEmbed), error: null, count: null as number | null }
        }
        if (h.state.erroreLettura) return { data: [] as Riga[], error: h.state.erroreLettura, count: null }
        const trovate = righeDi(table).filter(corrisponde)
        // `count` è il totale che CORRISPONDE, `data` è la pagina: è esattamente
        // la differenza fra «la mappa è intera» e «la mappa è tagliata».
        const pagina = limite === null ? trovate : trovate.slice(0, limite)
        return {
          data: pagina.map(conEmbed),
          error: null,
          count: conteggio ? trovate.length : null,
        }
      }

      const b: Record<string, unknown> = {}
      b.select = (c?: string, o?: { count?: string }) => {
        if (typeof c === 'string') cols = c
        if (o?.count === 'exact') conteggio = true
        return b
      }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.not = (col: string, op: string, val: unknown) => {
        if (op === 'is' && val === null) nonNulle.push(col)
        return b
      }
      b.order = () => b
      b.limit = (n: number) => { limite = n; return b }
      b.update = (v: Riga) => { patch = v; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
  }
}

import { GET, PATCH } from '@/app/api/admin/candidature-insegnanti/etichetta/route'

const URL_ROUTE = 'http://localhost/api/admin/candidature-insegnanti/etichetta'
const get = (qs = '') => new NextRequest(`${URL_ROUTE}${qs}`)
const patch = (body: unknown) =>
  new NextRequest(URL_ROUTE, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Gli `esito` dei log di evento: è lì che il degrado si dichiara. */
const esitiLoggati = () =>
  h.logEvento.mock.calls.map((c) => (c[2] as { esito?: string } | undefined)?.esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.state.utente = ADMIN
  h.state.scuole = [SEDE_A]
  h.state.erroreLettura = null
  h.state.erroreScrittura = null
  h.state.aggiornamenti = []
  h.state.tabelle = {
    candidature_insegnanti: [
      {
        id: MIA_ETICHETTATA,
        scuola_id: SEDE_A,
        etichetta: 'da_richiamare',
        etichetta_aggiornata_il: '2026-09-05T09:00:00.000Z',
        etichetta_aggiornata_da: ADMIN.id,
        // La colonna che questa rotta NON deve toccare, seminata con un valore
        // riconoscibile: se sparisse, la candidatura tornerebbe nella coda che
        // rispedisce il curriculum alla casella del plesso.
        copia_inviata_il: '2026-09-01T07:00:00.000Z',
      },
      {
        id: MIA_NUDA,
        scuola_id: SEDE_A,
        etichetta: null,
        etichetta_aggiornata_il: null,
        etichetta_aggiornata_da: null,
        copia_inviata_il: '2026-09-01T07:05:00.000Z',
      },
      {
        id: ALTRUI,
        scuola_id: SEDE_B,
        etichetta: 'assunta',
        etichetta_aggiornata_il: '2026-09-05T10:00:00.000Z',
        etichetta_aggiornata_da: ADMIN.id,
        copia_inviata_il: '2026-09-01T07:10:00.000Z',
      },
    ],
  }
  // ⚠️ Le righe di sede si seminano SEMPRE: dal 2026-08-19 sono il criterio
  // d'accesso del cockpit. Senza, ogni lettura è vuota e i test misurerebbero
  // un magazzino vuoto credendo di misurare la rotta.
  h.state.tabelle.candidature_sedi = h.state.tabelle.candidature_insegnanti.map((c) => ({
    candidatura_id: c.id,
    scuola_id: c.scuola_id,
    stato: 'pending',
  }))
  h.requireStaff.mockImplementation(async (_req: unknown, allowed?: string[]) => {
    const ammessi = allowed ?? ['admin', 'coordinator', 'segreteria']
    const u = h.state.utente
    if (!u) return { response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) }
    if (!ammessi.includes(u.role)) return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    return { user: u }
  })
})

describe('etichetta candidatura · GET — la mappa', () => {
  it('porta le sole righe ETICHETTATE della propria sede, col totale esatto', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    // Una sola: la nuda è esclusa da `.not('etichetta','is',null)`, l'altrui dal
    // filtro di sede sull'embed. Se una delle due comparisse, il pannello
    // disegnerebbe un'etichetta su una riga che non deve nemmeno vedere.
    expect(body.data.map((r: { id: string }) => r.id)).toEqual([MIA_ETICHETTATA])
    expect(body.data[0].etichetta).toBe('da_richiamare')
    expect(body.total).toBe(1)
    expect(body.colonnaAssente).toBe(false)
  })

  it('🔴 la mappa TAGLIATA lo dice: `total` resta il conteggio esatto, non la pagina', async () => {
    // Due righe etichettate in scope, `limit=1`: `data` ne porta una e `total`
    // dice due. È l'unico segnale con cui il pannello sa di dover SPEGNERE il
    // filtro invece di mostrare un elenco più corto del vero.
    ;(h.state.tabelle.candidature_insegnanti[1] as Riga).etichetta = 'assunta'
    const res = await GET(get('?limit=1'))
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.total).toBe(2)
  })

  it('🔴 `42703` (CI non migrata) degrada PULITO: 200, mappa vuota, `colonnaAssente: true`', async () => {
    h.state.erroreLettura = { code: '42703', message: 'column candidature_insegnanti.etichetta does not exist' }
    const res = await GET(get())
    // Non 500 e non 503: là la colonna non esiste, e «nessuna etichetta» è la
    // verità dell'ambiente, non un guasto.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ data: [], total: 0, colonnaAssente: true })
    // E lo dice anche al registro, altrimenti un ambiente non migrato in
    // PRODUZIONE sarebbe indistinguibile da uno migrato e vuoto.
    expect(esitiLoggati()).toContain('colonna-etichetta-assente')
  })

  it('🔴 e il degrado è STRETTO: un errore qualunque NON si traveste da mappa vuota', async () => {
    // Senza questo, il giorno in cui la tabella si rompe davvero il pannello
    // mostrerebbe «nessuna etichetta» a tutti, per sempre, senza un rosso.
    h.state.erroreLettura = { code: '57014', message: 'canceling statement due to statement timeout' }
    const res = await GET(get())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(body.colonnaAssente).toBeUndefined()
    expect(esitiLoggati()).toContain('etichette-non-lette')
  })
})

describe('etichetta candidatura · PATCH — la scrittura', () => {
  it('🔴 candidatura di un ALTRO plesso: 404 col suo codice, e NIENTE viene scritto', async () => {
    const res = await PATCH(patch({ id: ALTRUI, etichetta: 'non_idonea' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Candidatura non trovata', codice: 'CANDIDATURA_NON_TROVATA' })
    // La parte che conta: il 404 non è un messaggio, è un divieto. Una `update`
    // partita comunque avrebbe marcato «non idonea» il curriculum di una persona
    // che sta in un altro plesso.
    expect(h.state.aggiornamenti).toEqual([])
    expect((h.state.tabelle.candidature_insegnanti[2] as Riga).etichetta).toBe('assunta')
    // Il warn di sicurezza resta: è il segnale che qualcuno ha bussato fuori scope.
    expect(esitiLoggati()).toContain('candidatura-non-in-scope')
  })

  it('🔴 e un id MAI esistito risponde esattamente uguale: il 404 non rivela chi esiste', async () => {
    const fuoriSede = await PATCH(patch({ id: ALTRUI, etichetta: 'non_idonea' }))
    const inesistente = await PATCH(patch({ id: MAI_ESISTITA, etichetta: 'non_idonea' }))
    expect(inesistente.status).toBe(fuoriSede.status)
    expect(await inesistente.json()).toEqual(await fuoriSede.json())
  })

  it('🔴 un campo in PIÙ nel corpo: 400 dallo `.strict()`, e niente viene scritto', async () => {
    const res = await PATCH(
      patch({ id: MIA_NUDA, etichetta: 'assunta', copia_inviata_il: null }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Dati non validi')
    expect(h.state.aggiornamenti).toEqual([])
  })

  it('🔴 un valore FUORI dal vocabolario: 400, non una colonna con dentro una parola nuova', async () => {
    const res = await PATCH(patch({ id: MIA_NUDA, etichetta: 'Gia chiamata' }))
    expect(res.status).toBe(400)
    expect(h.state.aggiornamenti).toEqual([])
  })

  it('🔴 scrive TRE colonne e nessun’altra (`copia_inviata_il` resta dov’è)', async () => {
    const res = await PATCH(patch({ id: MIA_NUDA, etichetta: 'in_valutazione' }))
    expect(res.status).toBe(200)
    expect(h.state.aggiornamenti).toHaveLength(1)
    expect(Object.keys(h.state.aggiornamenti[0].patch).sort()).toEqual([
      'etichetta',
      'etichetta_aggiornata_da',
      'etichetta_aggiornata_il',
    ])
    const riga = h.state.tabelle.candidature_insegnanti[1] as Riga
    expect(riga.etichetta).toBe('in_valutazione')
    expect(riga.etichetta_aggiornata_da).toBe(ADMIN.id)
    // La quarta colonna, quella che rispedirebbe il curriculum al plesso.
    expect(riga.copia_inviata_il).toBe('2026-09-01T07:05:00.000Z')
    expect(await res.json()).toMatchObject({
      colonneScritte: ['etichetta', 'etichetta_aggiornata_il', 'etichetta_aggiornata_da'],
    })
  })

  it('`etichetta: null` TOGLIE l’etichetta, e chi/quando la seguono', async () => {
    // «Mai etichettata» e «etichettata e poi ripulita» sono due fatti diversi:
    // il secondo ha un autore, e l'audit deve poterlo nominare.
    const res = await PATCH(patch({ id: MIA_ETICHETTATA, etichetta: null }))
    expect(res.status).toBe(200)
    const riga = h.state.tabelle.candidature_insegnanti[0] as Riga
    expect(riga.etichetta).toBeNull()
    expect(riga.etichetta_aggiornata_da).toBe(ADMIN.id)
    expect(riga.etichetta_aggiornata_il).not.toBe('2026-09-05T09:00:00.000Z')
    // L'audit porta il PRIMA e il DOPO: la domanda che si farà a questo registro
    // è «chi l'ha marcata non idonea, e quando».
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    expect(h.logScrittura.mock.calls[0][1]).toMatchObject({
      entitaTipo: 'candidatura',
      entitaId: MIA_ETICHETTATA,
      valorePrima: { etichetta: 'da_richiamare' },
      valoreDopo: { etichetta: null },
    })
  })

  it('🔴 `42703` in scrittura: 503 DICHIARATO, non un 500 e non un falso successo', async () => {
    h.state.erroreLettura = { code: '42703', message: 'column candidature_insegnanti.etichetta does not exist' }
    const res = await PATCH(patch({ id: MIA_NUDA, etichetta: 'assunta' }))
    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('CANDIDATURE_OPERAZIONE_NON_RIUSCITA')
    expect(h.state.aggiornamenti).toEqual([])
    expect(esitiLoggati()).toContain('colonna-etichetta-assente')
  })
})
