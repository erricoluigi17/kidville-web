import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// GET /api/avvisi/[id]/risposte — LE DUE COLONNE SU CUI POGGIA L'INTERA
// SCHERMATA, E IL DEGRADO CHE LE PUÒ TOGLIERE SENZA UN ERRORE.
//
// ─── IL DIFETTO CHE QUESTO FILE ESISTE PER TENERE CHIUSO ────────────────────
//
// Questa rotta alimenta il riepilogo delle adesioni della segreteria. Fino al
// 2026-09-19 la sua proiezione era ferma alle sei colonne storiche: dalla
// migrazione `20260919132612` in poi `numero_partecipanti` e `stato_adesione`
// esistevano nel database, la rotta di esportazione li leggeva già, e questa
// no. Il risultato NON era un errore: era «0 persone · su N posti · 0 in lista
// d'attesa», nessun chip «N persone» accanto ai nomi, nessun «In lista
// d'attesa», **nessun bottone «Ammetti»** — perché nessuna riga risultava in
// coda. Una schermata intera spenta, con il gate verde e nessun log rosso.
//
// ─── E IL RIPIEGO, CHE È L'ALTRA METÀ DELLO STESSO PROBLEMA ─────────────────
//
// 🔴 Allargare la `select` senza ripiego avrebbe spostato il silenzio, non
// tolto: sul DB E2E della CI (progetto separato, NON migrato) quelle due
// colonne non esistono, un `42703` fa tornare **zero righe**, e zero righe su
// questa schermata si legge «nessuno ha risposto». Per questo il ripiego sulla
// proiezione storica c'è, ed è vincolato ai due soli codici di colonna
// mancante — con un `warn` che dichiara il degrado, nella stessa forma di
// `statistiche-proiezione-ridotta` e `degrado-proiezione-capienza-spenta`.
//
// ─── IL FINTO IMITA POSTGREST SULLA PROIEZIONE, NON SULLA TABELLA ───────────
//
// 🔑 L'errore dipende da QUALI COLONNE si chiedono, non da quale tabella: è
// l'unico modo di far FALLIRE il primo tentativo e RIUSCIRE il secondo. Un
// finto che sbaglia sempre proverebbe solo che il warn parte prima del 500,
// cioè metà della proprietà.
//
// ─── LE DUE PROVE DI ROTTURA, ESEGUITE (2026-09-19) ─────────────────────────
//
//  1. tolte `numero_partecipanti, stato_adesione` dalla proiezione della rotta
//     → ROSSO su «le due colonne arrivano al client» (e sul controllo che il
//     riepilogo non sia spento). È il difetto originale, ricreato.
//  2. tolto il ramo di ripiego (il solo `if` sul codice) → ROSSO su «il ripiego
//     restituisce comunque le righe» e su «il degrado si dichiara»: senza,
//     tornavano 0 righe e un 500.
// =============================================================================

const AVVISO_ID = '11111111-1111-1111-1111-111111111111'
const ALTRA_SEDE = 'bbbbbbbb-0000-4000-8000-00000000000b'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  scuoleDiUtente: vi.fn(),
  logEvento: vi.fn(),
  /** Le colonne che su QUESTO database non esistono (il DB E2E non migrato). */
  assenti: [] as string[],
  /** Il codice con cui il finto annuncia la colonna mancante: `42703` o `PGRST204`. */
  codiceColonna: '42703',
  /** Un guasto di lettura che NON è una colonna mancante (nessun ripiego atteso). */
  erroreRisposte: null as { code: string; message: string } | null,
  righe: [] as Array<Record<string, unknown>>,
  genitori: [] as Array<Record<string, unknown>>,
  alunni: [] as Array<Record<string, unknown>>,
  /** Un guasto sulla lettura dei nomi: il ripiego è `'?'`, ma deve lasciare traccia. */
  erroreNomi: { utenti: false, alunni: false },
  // ⚠️ `vi.hoisted` gira PRIMA degli import: qui non si può leggere `SEDE_A`
  // («Cannot access before initialization»). La sede si mette in `beforeEach`.
  sedeAvviso: null as string | null,
  /** Le proiezioni chieste a `avvisi_risposte`, in ordine: la prova del ripiego. */
  proiezioni: [] as string[],
  /** Query per tabella: è il dato che il budget qui sotto esiste per pinnare. */
  query: {} as Record<string, number>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: h.requireDocente,
  requireUser: vi.fn(),
}))
vi.mock('@/lib/auth/scope', async (originale) => {
  const vero = await originale<typeof import('@/lib/auth/scope')>()
  return { ...vero, scuoleDiUtente: (...a: unknown[]) => h.scuoleDiUtente(...a) }
})
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: vi.fn() }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: vi.fn() }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})

/**
 * Un PostgREST che conosce le colonne che HA: `.select()` che ne nomina una
 * assente → `42703`; altrimenti le righe tornano RITAGLIATE sulla proiezione,
 * che è ciò che rende i due campi davvero assenti dal payload degradato invece
 * che semplicemente uguali a `null`.
 */
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      // Una riga per ogni `from(…)`: è così che si misura un N+1, contando le
      // query e non guardando il cronometro (con dieci righe il cronometro tace).
      h.query[tabella] = (h.query[tabella] ?? 0) + 1
      let proiezione = '*'
      let ids: string[] = []
      const b: Record<string, unknown> = {}
      const colonne = () => proiezione.split(',').map((c) => c.trim()).filter((c) => c && c !== '*')
      const risposta = () => {
        const assente = colonne().find((c) => h.assenti.includes(c))
        if (assente) {
          return {
            data: null,
            error: { code: h.codiceColonna, message: `column ${tabella}.${assente} does not exist`, details: null, hint: null },
          }
        }
        if (tabella === 'avvisi') {
          return { data: [{ id: AVVISO_ID, scuola_id: h.sedeAvviso }], error: null }
        }
        if (tabella === 'avvisi_risposte') {
          if (h.erroreRisposte) return { data: null, error: h.erroreRisposte }
          const chieste = colonne()
          const ritagliate = chieste.length === 0
            ? h.righe
            : h.righe.map((r) => Object.fromEntries(chieste.filter((c) => c in r).map((c) => [c, r[c]])))
          return { data: ritagliate, error: null }
        }
        // 🔑 `utenti` e `alunni` FILTRANO DAVVERO sugli id chiesti. Un finto che
        // restituisse sempre la stessa riga renderebbe verde anche una lettura in
        // blocco che distribuisce il primo nome a tutti — il difetto classico di
        // chi passa da N query a una sola senza riassociare.
        if (tabella === 'utenti') {
          if (h.erroreNomi.utenti) return { data: null, error: { code: '42501', message: 'permission denied for table utenti' } }
          return { data: h.genitori.filter((u) => ids.includes(u.id as string)), error: null }
        }
        if (tabella === 'alunni') {
          if (h.erroreNomi.alunni) return { data: null, error: { code: '42501', message: 'permission denied for table alunni' } }
          return { data: h.alunni.filter((a) => ids.includes(a.id as string)), error: null }
        }
        return { data: [], error: null }
      }

      b.select = (cols?: string) => {
        if (typeof cols === 'string') proiezione = cols
        if (tabella === 'avvisi_risposte') h.proiezioni.push(proiezione)
        return b
      }
      b.in = (_c: string, v: string[]) => { ids = v; return b }
      for (const m of ['eq', 'is', 'not', 'order', 'limit']) b[m] = () => b
      b.maybeSingle = async () => {
        const r = risposta()
        return { data: ((r.data as unknown[]) ?? [])[0] ?? null, error: r.error }
      }
      b.single = b.maybeSingle
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(risposta()).then(ok, ko)
      return b
    },
  }),
}))

import { GET } from '@/app/api/avvisi/[id]/risposte/route'

type RigaUscita = {
  id: string
  numero_partecipanti?: number | null
  stato_adesione?: string | null
}

const ctx = (id = AVVISO_ID) => ({ params: Promise.resolve({ id }) })
const req = () => new Request(`http://localhost/api/avvisi/${AVVISO_ID}/risposte?userId=doc-1`)

function warn(): Array<Record<string, unknown>> {
  return h.logEvento.mock.calls
    .filter((c) => c[1] === 'warn')
    .map((c) => (c[2] ?? {}) as Record<string, unknown>)
}

function rigaRisposta(i: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `r-${i}`,
    parent_id: `gen-${i}`,
    student_id: `alu-${i}`,
    letto_il: '2026-09-18T09:00:00.000Z',
    risposta: 'si',
    risposto_il: '2026-09-18T09:01:00.000Z',
    numero_partecipanti: 4,
    stato_adesione: 'ammessa',
    ...patch,
  }
}

/**
 * N risposte di N famiglie DIVERSE: il caso peggiore per la lettura in blocco, e
 * l'unico in cui una riassociazione sbagliata si vede.
 */
function preparaRisposte(n: number) {
  h.righe = Array.from({ length: n }, (_, i) => rigaRisposta(i + 1))
  h.genitori = Array.from({ length: n }, (_, i) => ({
    id: `gen-${i + 1}`, nome: `Genitore${i + 1}`, cognome: `Cognome${i + 1}`, first_name: null, last_name: null,
  }))
  h.alunni = Array.from({ length: n }, (_, i) => ({
    id: `alu-${i + 1}`, nome: `Alunno${i + 1}`, cognome: `Cognome${i + 1}`,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.assenti = []
  h.codiceColonna = '42703'
  h.erroreRisposte = null
  h.erroreNomi = { utenti: false, alunni: false }
  h.sedeAvviso = SEDE_A
  h.proiezioni = []
  h.query = {}
  preparaRisposte(2)
  h.righe[1] = rigaRisposta(2, { numero_partecipanti: 2, stato_adesione: 'in_attesa' })
  h.requireDocente.mockResolvedValue({ user: { id: 'doc-1', role: 'admin', scuola_id: SEDE_A }, response: null })
  h.scuoleDiUtente.mockResolvedValue([SEDE_A])
})

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/avvisi/[id]/risposte — le due colonne del riepilogo adesioni', () => {
  it('🔴 `numero_partecipanti` e `stato_adesione` ARRIVANO al client', async () => {
    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    const righe = (await res.json()) as RigaUscita[]
    expect(righe).toHaveLength(2)
    // I due campi sono quelli che accendono il chip «N persone» e il chip
    // «In lista d'attesa»: senza, la schermata è muta ma non rotta.
    expect(righe.map((r) => r.numero_partecipanti)).toEqual([4, 2])
    expect(righe.map((r) => r.stato_adesione)).toEqual(['ammessa', 'in_attesa'])
  })

  it('il riepilogo si può CALCOLARE: 6 persone, una riga in coda (era 0 · 0)', async () => {
    // Il danno del difetto non era un campo mancante: era un TOTALE. Questo `it`
    // misura ciò che la segreteria legge davvero, e fallisce per il motivo giusto
    // se i campi tornano `undefined` — la somma diventa 0 e la coda sparisce.
    const righe = (await (await GET(req(), ctx())).json()) as RigaUscita[]

    const persone = righe.reduce((s, r) => s + (typeof r.numero_partecipanti === 'number' ? r.numero_partecipanti : 0), 0)
    const inCoda = righe.filter((r) => r.stato_adesione === 'in_attesa').length
    expect(persone).toBe(6)
    expect(inCoda, 'senza una riga in coda non c’è nessun bottone «Ammetti»').toBe(1)
  })

  it('i nomi e la forma storica della risposta restano invariati', async () => {
    const righe = (await (await GET(req(), ctx())).json()) as Array<Record<string, unknown>>

    expect(righe[0].parent_name).toBe('Genitore1 Cognome1')
    expect(righe[0].student_name).toBe('Alunno1 Cognome1')
    expect(righe[0].risposta).toBe('si')
    expect(righe[0].letto_il).toBe('2026-09-18T09:00:00.000Z')
  })

  it('sul percorso felice non si dichiara nessun degrado', async () => {
    await GET(req(), ctx())
    expect(warn()).toEqual([])
  })

  it('il gate di sede non si è mosso: un avviso di un altro plesso resta 403', async () => {
    h.sedeAvviso = ALTRA_SEDE
    const res = await GET(req(), ctx())
    expect(res.status).toBe(403)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/avvisi/[id]/risposte — il degrado sul DB non migrato si DICHIARA', () => {
  const ASSENTI = ['numero_partecipanti', 'stato_adesione']

  it('🔑 con un `42703` il ripiego restituisce COMUNQUE le righe (non zero, non 500)', async () => {
    h.assenti = ASSENTI

    const res = await GET(req(), ctx())

    expect(res.status, 'un DB non migrato non deve spegnere la schermata intera').toBe(200)
    const righe = (await res.json()) as RigaUscita[]
    expect(righe).toHaveLength(2)
    expect(righe[0].id).toBe('r-1')
  })

  it('i due campi restano ASSENTI, mai zero: `undefined` vale «non misurato»', async () => {
    h.assenti = ASSENTI

    const righe = (await (await GET(req(), ctx())).json()) as RigaUscita[]

    // 🔴 La differenza che conta: un `?? 0` avrebbe scritto «0 persone» e
    // «nessuno in coda» come se fossero stati calcolati — lo stesso `?? 0` che
    // ha congelato per sempre lo stato SDI di una fattura.
    for (const r of righe) {
      expect(r.numero_partecipanti).toBeUndefined()
      expect(r.stato_adesione).toBeUndefined()
      expect(Object.keys(r)).not.toContain('numero_partecipanti')
      expect(Object.keys(r)).not.toContain('stato_adesione')
    }
  })

  it('…e la riga di degrado c’è, con il nome giusto', async () => {
    h.assenti = ASSENTI

    await GET(req(), ctx())

    expect(warn()).toContainEqual({
      operazione: 'avvisi/[id]/risposte:GET',
      esito: 'degrado-proiezione-adesioni-spenta',
      avviso: AVVISO_ID,
      n: 2,
      error_code: '42703',
    })
    // Solo uuid, conteggi e nomi di esito: nessun nome di famiglia (regola 8).
    const riga = warn().find((r) => r.esito === 'degrado-proiezione-adesioni-spenta')!
    expect(Object.keys(riga).sort()).toEqual(['avviso', 'error_code', 'esito', 'n', 'operazione'])
  })

  it('vale anche per `PGRST204` (la schema cache che non conosce la colonna)', async () => {
    h.assenti = ASSENTI
    h.codiceColonna = 'PGRST204'

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    expect((await res.json()) as RigaUscita[]).toHaveLength(2)
    expect(warn().map((r) => r.error_code)).toContain('PGRST204')
  })

  it('il ripiego chiede DAVVERO una proiezione più corta (due tentativi, non due volte la stessa)', async () => {
    h.assenti = ASSENTI

    await GET(req(), ctx())

    expect(h.proiezioni).toHaveLength(2)
    expect(h.proiezioni[0]).toContain('numero_partecipanti')
    expect(h.proiezioni[0]).toContain('stato_adesione')
    for (const colonna of ASSENTI) expect(h.proiezioni[1]).not.toContain(colonna)
  })

  it('il degrado NON tocca i nomi: restano una query per tabella', async () => {
    h.assenti = ASSENTI
    preparaRisposte(30)

    await GET(req(), ctx())

    expect(h.query.utenti).toBe(1)
    expect(h.query.alunni).toBe(1)
  })

  it('🔴 un guasto che NON è una colonna mancante resta un 500: il ripiego non è una scusa', async () => {
    // Senza questo `it` un ripiego scritto su QUALUNQUE errore sarebbe verde:
    // trasformerebbe ogni guasto di lettura in un elenco a metà, e la schermata
    // mostrerebbe dati parziali come se fossero completi.
    h.erroreRisposte = { code: '57014', message: 'canceling statement due to statement timeout' }

    const res = await GET(req(), ctx())

    expect(res.status).toBe(500)
    expect(h.proiezioni, 'un solo tentativo: nessun ripiego su un codice estraneo').toHaveLength(1)
    expect(warn()).toEqual([])
  })

  it('🔴 quel 500 porta un `codice` e NON il messaggio grezzo del database', async () => {
    // ── LA FUGA DI SCHEMA CHE NESSUN GATE VEDE ────────────────────────────
    //
    // Fino al 2026-09-19 questo ramo rispondeva `{ error: error.message }`, cioè
    // il `message` di PostgREST rimandato al client. Due difetti in uno:
    //
    //  · senza `codice` non è localizzabile — `messaggioDaCorpo` ricade sulla
    //    prosa del server, e una segretaria con l'interfaccia in inglese legge
    //    una frase italiana o tecnica;
    //  · quel messaggio PUÒ NOMINARE UNA COLONNA. È già successo qui:
    //    `500 {"error":"value too long for type character varying(255)"}`
    //    raccontava al client il tipo esatto della colonna, ed è il rilievo da
    //    cui è nato `src/lib/validation/avvisi.ts`.
    //
    // ⚠️ IL LOCK `errori-con-codice` NON PUÒ VEDERLO: vieta i nomi di colonna nei
    // LETTERALI e nel catalogo, non in una stringa costruita a runtime. La sola
    // difesa è misurare il CORPO che esce, ed è ciò che fa questo `it`.
    //
    // Il messaggio finto imita la forma vera: nomi di colonna e di tabella
    // dentro. Un `'errore'` generico renderebbe questo test verde con e senza la
    // correzione — la prima delle cinque forme di verde falso.
    h.erroreRisposte = {
      code: '57014',
      message: 'column avvisi_risposte.numero_partecipanti is of type integer but expression is of type text',
    }

    const res = await GET(req(), ctx())
    const corpo = (await res.json()) as { error?: string; codice?: string }

    expect(res.status, 'era un 500 e deve restare un 500: un guasto nostro non è un 503').toBe(500)
    expect(corpo.codice, 'senza codice il messaggio non è traducibile').toBe('LETTURA_FALLITA')
    // Il corpo INTERO, non solo `error`: un `dettaglio`/`message` aggiunto domani
    // riaprirebbe la fuga da un campo diverso e questo controllo lo prende lo stesso.
    const uscito = JSON.stringify(corpo)
    for (const vietato of ['numero_partecipanti', 'avvisi_risposte', 'integer', 'expression']) {
      expect(uscito, `il client ha ricevuto un pezzo di schema: ${vietato}`).not.toContain(vietato)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// IL BUDGET DELLE QUERY — LOCK, sul modello di `avvisi-niente-n-piu-uno`.
//
// Il difetto misurato dall'altro cantiere: `utenti` e `alunni` letti DENTRO il
// `.map()` delle risposte, cioè **due query per riga**. Su un avviso di plesso
// con centinaia di adesioni sono centinaia di richieste per una sola apertura di
// schermata, e il `Promise.all` esterno le parallelizzava — il che nasconde il
// problema a chi guarda il cronometro con dieci righe e lo rende un incidente
// con trecento.
//
// 🔑 Il tetto è ASSOLUTO e il confronto è fra 2 righe e 30: «meno di prima» non
// è un lock, e due conteggi uguali sono l'unica cosa che dimostra che il numero
// di query NON dipende dalle righe.
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/avvisi/[id]/risposte — le query non crescono con le risposte', () => {
  it('30 famiglie diverse: 1 lettura di `utenti` e 1 di `alunni` (col difetto erano 30 e 30)', async () => {
    preparaRisposte(30)

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    expect(h.query.avvisi_risposte).toBe(1)
    expect(h.query.utenti).toBe(1)
    expect(h.query.alunni).toBe(1)
    expect(h.query.avvisi).toBe(1)
  })

  it('il conteggio delle query è IDENTICO con 2 e con 30 risposte', async () => {
    preparaRisposte(2)
    await GET(req(), ctx())
    const conDue = { ...h.query }

    h.query = {}
    preparaRisposte(30)
    await GET(req(), ctx())

    expect({ ...h.query }).toEqual(conDue)
  })

  it('i nomi restano RIASSOCIATI alla riga giusta, non distribuiti dal primo', async () => {
    // La manomissione che una sola query non protegge da sé: leggere in blocco e
    // poi dare a tutti il primo nome trovato. Con trenta famiglie diverse si
    // vede; con una riga sola no.
    preparaRisposte(30)

    const righe = (await (await GET(req(), ctx())).json()) as Array<Record<string, string>>

    expect(righe).toHaveLength(30)
    expect(righe[0].parent_name).toBe('Genitore1 Cognome1')
    expect(righe[0].student_name).toBe('Alunno1 Cognome1')
    expect(righe[29].parent_name).toBe('Genitore30 Cognome30')
    expect(righe[29].student_name).toBe('Alunno30 Cognome30')
  })

  it('un id senza riga corrispondente resta `?` — il fallback storico non si è mosso', async () => {
    preparaRisposte(2)
    h.genitori = []
    h.alunni = []

    const righe = (await (await GET(req(), ctx())).json()) as Array<Record<string, string>>

    expect(righe.map((r) => r.parent_name)).toEqual(['?', '?'])
    expect(righe.map((r) => r.student_name)).toEqual(['?', '?'])
  })

  it('🔴 un guasto sulla lettura dei nomi non è più muto: `?` a schermo, ma una riga nei log', async () => {
    // Prima erano due `const { data: parent } = …`: l'errore veniva destrutturato
    // via, e il `?` a schermo non si distingueva da «quel genitore non c'è».
    // PostgREST non lancia — un `try/catch` lì attorno non sarebbe mai scattato.
    h.erroreNomi = { utenti: true, alunni: true }
    preparaRisposte(2)

    const res = await GET(req(), ctx())

    expect(res.status, 'un elenco senza nomi regge; un 500 spegnerebbe la schermata').toBe(200)
    const righe = (await res.json()) as Array<Record<string, string>>
    expect(righe.map((r) => r.parent_name)).toEqual(['?', '?'])
    const esiti = h.logEvento.mock.calls.filter((c) => c[1] === 'error').map((c) => (c[2] as { esito?: string })?.esito)
    expect(esiti).toContain('nomi-genitori-non-letti')
    expect(esiti).toContain('nomi-alunni-non-letti')
  })
})
