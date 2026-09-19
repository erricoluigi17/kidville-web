import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'

/**
 * I DUE DEGRADI DEGLI AVVISI CHE NON SI DICHIARAVANO.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE ──────────────────────────────────────────────
 *
 * Il cantiere delle scadenze ha lasciato cinque ricadute sulle colonne storiche
 * per il DB E2E della CI, che è un progetto separato e **non è migrato**. Tre
 * dichiaravano il proprio degrado con un `logEvento`; due no:
 *
 *  · `GET /api/avvisi`, ramo STAFF — la proiezione ridotta;
 *  · `PUT /api/avvisi/[id]` — la pre-lettura dello «stato risultante».
 *
 * ─── PERCHÉ IL PRIMO È IL PEGGIORE DEI CINQUE ───────────────────────────────
 *
 * 🔴 Quando la proiezione dello staff degrada, `posti_totali` non arriva più, e
 * `sopra_capienza` diventa **`false` per ogni avviso**. Non è un dato mancante:
 * è un indicatore di sicurezza che si spegne **mostrando il valore
 * rassicurante**. La segreteria legge «nessun avviso sopra capienza» e non ha
 * niente da guardare per sapere che quel numero non è stato calcolato — nessun
 * errore, nessun 500, nessuna riga. È la forma esatta di silenzio falso che ha
 * tenuto nascosto per mesi il guasto delle email di credenziali, dove «nessun
 * log» non distingueva «tutto ok» da «non è mai partito niente».
 *
 * Il secondo è più quieto ma della stessa famiglia: senza le colonne nuove, il
 * PUT decide come se il corpo della richiesta fosse l'unica verità — le due
 * scadenze non si confrontano più fra loro quando il corpo ne manda una sola —
 * e risponde 200. Una modifica degradata è indistinguibile da una andata bene.
 *
 * ─── IL FINTO IMITA POSTGREST SULLA PROIEZIONE, NON SULLA TABELLA ───────────
 *
 * 🔑 L'errore non dipende da QUALE tabella si legge, ma da QUALI COLONNE si
 * chiedono: è così che si comporta un database a cui manca una colonna, ed è
 * l'unico modo di far RIUSCIRE il secondo tentativo dopo aver fatto fallire il
 * primo. Un finto che sbaglia sempre sulla stessa tabella proverebbe solo che il
 * warn parte prima del 500 — cioè metà della proprietà. Qui il ripiego funziona
 * davvero, e si può misurare che cosa resta in mano a chi guarda.
 *
 * ─── LE PROVE DI ROTTURA, ESEGUITE (2026-09-19) ─────────────────────────────
 *
 *  1. tolto il `logEvento` del ramo staff → ROSSO su «il degrado della capienza
 *     si dichiara», e — questo è il punto — TUTTO IL RESTO RESTAVA VERDE, incluso
 *     `sopra_capienza: false`. Il difetto non ha colore finché nessuno lo nomina.
 *  2. tolto il `logEvento` della pre-lettura del PUT → ROSSO solo sul suo `it`.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  verificaTargetAvvisoDocente: vi.fn(async () => null),
  resolveScuoleAttive: vi.fn(),
  logEvento: vi.fn(),
  /** Le colonne che su QUESTO database non esistono (il DB E2E non migrato). */
  assenti: [] as string[],
  avvisi: [] as Array<Record<string, unknown>>,
  /** Le proiezioni chieste a `avvisi`, in ordine: la prova che il ripiego è avvenuto. */
  proiezioni: [] as string[],
  aggiornato: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
  verificaTargetAvvisoDocente: h.verificaTargetAvvisoDocente,
}))
// ⚠️ `@/lib/auth/predicati-ruolo` NON si mocka, e c'è un lock che lo vieta
// (`__tests__/architecture/predicati-ruolo-non-mockabili.test.ts`): i predicati sui
// ruoli hanno una casa sola proprio perché nessuno possa sostituirli per sbaglio.
// Qui basta dare a `requireUser` un ruolo che non sia `genitore`, e la route
// prende il ramo staff da sé — cioè si prova il codice vero invece di un finto.
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.resolveScuoleAttive(...a),
  resolveScuolaScrittura: vi.fn(),
}))
vi.mock('@/lib/auth/scope-avvisi', () => ({
  assertAvvisoInScope: async () => null,
  assertSedeRigaInScope: async () => null,
  scopeRigaNonRisolta: vi.fn(),
  rigaNonTrovata: vi.fn(),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: async () => [] }))
vi.mock('@/lib/allegati/storage', () => ({
  firmaAllegatiAvvisi: async (_s: unknown, righe: unknown) => righe,
  normalizzaAllegatoAvviso: (v: unknown) => v ?? null,
}))
vi.mock('@/lib/allegati/rimozione', () => ({
  percorsoAllegatoAvviso: () => null,
  percorsoAllegatoArchiviatoAvviso: async () => null,
  rimuoviAllegatoAvvisoSeOrfano: async () => 0,
  rimuoviAllegatoNonPubblicato: async () => 0,
  rimuoviDalBucket: async () => 0,
}))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: async () => undefined }))
// Le statistiche hanno i loro test (e il loro degrado, già dichiarato con
// `statistiche-proiezione-ridotta`): qui devono solo fornire un numero stabile,
// così che `sopra_capienza` dipenda SOLO dalla colonna che il degrado sfila.
vi.mock('@/lib/avvisi/statistiche', async (originale) => {
  const vero = await originale<typeof import('@/lib/avvisi/statistiche')>()
  return {
    ...vero,
    statistichePerAvviso: async (_s: unknown, ids: string[]) =>
      new Map(ids.map((id) => [id, { ...vero.STATS_ZERO, persone_ammesse: 7 }])),
    autoriDegliAvvisi: async () => new Map(),
    rispostePerAvvisoDelGenitore: async () => new Map(),
  }
})
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})

/**
 * Il finto: un PostgREST che conosce le colonne che HA.
 *
 * `.select(proiezione)` che nomina una colonna assente → `42703`, come il database
 * vero; altrimenti le righe tornano ritagliate sulla proiezione — che è l'altra
 * metà del comportamento reale, e quella che rende `posti_totali` davvero assente
 * dal payload degradato invece che semplicemente uguale a `null`.
 */
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (tabella: string) => {
      let proiezione = '*'
      const b: Record<string, unknown> = {}
      const colonne = () =>
        proiezione.split(',').map((c) => c.trim()).filter((c) => c && c !== '*')
      const mancante = () => colonne().find((c) => h.assenti.includes(c))
      const risposta = () => {
        const assente = mancante()
        if (assente) {
          return {
            data: null,
            count: null,
            error: { code: '42703', message: `column ${tabella}.${assente} does not exist`, details: null, hint: null },
          }
        }
        const righe = tabella === 'avvisi' ? h.avvisi : []
        const chieste = colonne()
        const ritagliate = chieste.length === 0
          ? righe
          : righe.map((r) => Object.fromEntries(chieste.filter((c) => c in r).map((c) => [c, r[c]])))
        return { data: ritagliate, count: ritagliate.length, error: null }
      }

      b.select = (cols?: string) => {
        if (typeof cols === 'string') proiezione = cols
        if (tabella === 'avvisi') h.proiezioni.push(proiezione)
        return b
      }
      for (const m of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'order', 'limit']) {
        b[m] = () => b
      }
      b.update = (patch: Record<string, unknown>) => {
        h.aggiornato = patch
        // L'update ha il suo degrado, con il suo test (`degrado-colonna-sfilata`):
        // qui riesce, o il rumore di quel ciclo coprirebbe ciò che si sta misurando.
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'x', ...patch }, error: null }) }) }) }
      }
      b.maybeSingle = async () => {
        const r = risposta()
        return { data: ((r.data as unknown[]) ?? [])[0] ?? null, error: r.error }
      }
      b.single = b.maybeSingle
      b.range = async () => risposta()
      b.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(risposta()).then(ok, ko)
      return b
    },
  }),
}))

import { GET } from '@/app/api/avvisi/route'
import { PUT } from '@/app/api/avvisi/[id]/route'

const AVVISO = 'cccccccc-0000-4000-8000-00000000000c'
/** Le sette colonne che il cantiere A2 aggiunge, e che sul DB E2E non esistono. */
const COLONNE_A2 = [
  'scadenza_avviso', 'scadenza_adesione', 'chiedi_numero', 'etichetta_numero',
  'numero_min', 'numero_max', 'posti_totali',
]

function rigaAvviso(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AVVISO,
    author_id: 'aut-1',
    titolo: 'Gita al museo',
    contenuto: 'c',
    tipo: 'presa_visione',
    target_scope: 'globale',
    target_classes: null,
    scadenza: '2026-10-01',
    attachment_url: null,
    created_at: '2026-08-01T00:00:00.000Z',
    scuola_id: SEDE_A,
    form_model_id: null,
    scadenza_avviso: '2026-10-01T10:00:00.000Z',
    scadenza_adesione: null,
    chiedi_numero: false,
    etichetta_numero: null,
    numero_min: 1,
    numero_max: 20,
    // Cinque posti contro sette persone ammesse: SOPRA capienza, quando si può
    // vedere. È il numero che il degrado spegne.
    posti_totali: 5,
    ...patch,
  }
}

const reqGet = () => ({
  url: 'http://test/api/avvisi',
  method: 'GET',
  headers: new Headers(),
  nextUrl: { searchParams: new URLSearchParams() },
  cookies: { get: () => undefined },
}) as never

const reqPut = (body: unknown) =>
  new Request(`http://localhost/api/avvisi/${AVVISO}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

function warn(): Array<Record<string, unknown>> {
  return h.logEvento.mock.calls
    .filter((c) => c[1] === 'warn')
    .map((c) => (c[2] ?? {}) as Record<string, unknown>)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.assenti = []
  h.avvisi = [rigaAvviso(), rigaAvviso({ id: 'altro-avviso', titolo: 'Recita' })]
  h.proiezioni = []
  h.aggiornato = null
  h.requireUser.mockResolvedValue({ user: { id: 'seg-1', role: 'segreteria', scuola_id: SEDE_A }, response: null })
  h.requireDocente.mockResolvedValue({ user: { id: 'seg-1', role: 'admin', scuola_id: SEDE_A }, response: null })
  h.resolveScuoleAttive.mockResolvedValue([SEDE_A])
})

// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/avvisi — ramo STAFF: la proiezione ridotta spegne `sopra_capienza`, e lo DICE', () => {
  it('CONTROLLO POSITIVO: con le colonne al loro posto, `sopra_capienza` è VERO e non si dichiara niente', async () => {
    // Senza questo `it`, il test qui sotto sarebbe verde anche con un
    // `sopra_capienza` che vale `false` sempre — «falso dopo il degrado» e «falso
    // e basta» hanno lo stesso colore.
    const res = await GET(reqGet())

    expect(res.status).toBe(200)
    const righe = (await res.json()) as Array<{ sopra_capienza: boolean; posti_totali?: number }>
    expect(righe.every((r) => r.sopra_capienza)).toBe(true)
    expect(righe[0].posti_totali).toBe(5)
    expect(warn(), 'sul percorso felice non si dichiara nessun degrado').toEqual([])
  })

  it('🔴 senza le colonne A2 l’indicatore si spegne su TUTTI gli avvisi — e la riga del degrado c’è', async () => {
    h.assenti = COLONNE_A2

    const res = await GET(reqGet())

    expect(res.status).toBe(200)
    const righe = (await res.json()) as Array<{ sopra_capienza: boolean; posti_totali?: number }>
    // Il danno, misurato: sette persone ammesse contro cinque posti, e il booleano
    // dice di no. Con `posti_totali` fuori dalla proiezione non è «non lo so»,
    // è «va tutto bene».
    expect(righe).toHaveLength(2)
    expect(righe.every((r) => r.sopra_capienza === false)).toBe(true)
    expect(righe[0].posti_totali).toBeUndefined()

    // …e questa è l'unica cosa che resta a chi sorveglia.
    expect(warn()).toContainEqual({
      operazione: 'avvisi:GET',
      esito: 'degrado-proiezione-capienza-spenta',
      n: 2,
    })
  })

  it('il ripiego chiede DAVVERO una proiezione più corta (due tentativi, non due volte la stessa)', async () => {
    h.assenti = COLONNE_A2

    await GET(reqGet())

    expect(h.proiezioni).toHaveLength(2)
    expect(h.proiezioni[0]).toContain('posti_totali')
    // Il secondo tentativo NON deve richiedere le colonne che hanno appena
    // prodotto il 42703: sarebbe lo stesso errore due volte, cioè un ripiego che
    // non ripiega. È il difetto che il ramo GENITORE aveva davvero, con un
    // gradino di mezzo che non poteva riuscire mai.
    for (const colonna of COLONNE_A2) expect(h.proiezioni[1]).not.toContain(colonna)
  })

  it('`n` conta gli avvisi che hanno ricevuto il booleano non calcolato', async () => {
    // Non è un ornamento: è la differenza fra «è degradato» e «è degradato, e ha
    // riguardato duecento avvisi». Una riga senza numero non si può interrogare.
    h.assenti = COLONNE_A2
    h.avvisi = [rigaAvviso()]

    await GET(reqGet())

    expect(warn()).toContainEqual({
      operazione: 'avvisi:GET',
      esito: 'degrado-proiezione-capienza-spenta',
      n: 1,
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('PUT /api/avvisi/[id] — la pre-lettura degradata si dichiara', () => {
  const corpo = {
    titolo: 'Gita al museo (rinviata)',
    contenuto: 'Nuova data',
    scadenza_avviso: '2026-10-05T10:00',
  }

  it('CONTROLLO POSITIVO: con le colonne al loro posto la pre-lettura non dichiara niente', async () => {
    const res = await PUT(reqPut(corpo), { params: Promise.resolve({ id: AVVISO }) })

    expect(res.status).toBe(200)
    expect(warn().filter((r) => r.esito === 'degrado-prelettura-colonne-storiche')).toEqual([])
  })

  it('🔑 senza le colonne A2 la modifica RIESCE (200) — ed è proprio per questo che deve dirlo', async () => {
    h.assenti = COLONNE_A2

    const res = await PUT(reqPut(corpo), { params: Promise.resolve({ id: AVVISO }) })

    // Il 200 è giusto: una modifica legittima non deve fallire perché la CI gira
    // su un database non migrato. Ma un 200 degradato e un 200 pieno sono
    // indistinguibili da fuori, e da qui in poi il PUT ha deciso le scadenze
    // guardando solo il corpo della richiesta.
    expect(res.status).toBe(200)
    expect(warn()).toContainEqual({
      operazione: 'avvisi/[id]:PUT',
      esito: 'degrado-prelettura-colonne-storiche',
      entitaId: AVVISO,
    })
    // Solo uuid e nomi di esito: nessun titolo, nessun dato di famiglia (regola 8).
    const riga = warn().find((r) => r.esito === 'degrado-prelettura-colonne-storiche')!
    expect(Object.keys(riga).sort()).toEqual(['entitaId', 'esito', 'operazione'])
  })

  it('la pre-lettura degradata chiede la proiezione STORICA, non di nuovo quella nuova', async () => {
    h.assenti = COLONNE_A2

    await PUT(reqPut(corpo), { params: Promise.resolve({ id: AVVISO }) })

    const prelettura = h.proiezioni.filter((p) => p.includes('target_scope'))
    expect(prelettura.length).toBeGreaterThanOrEqual(2)
    expect(prelettura[0]).toContain('scadenza_adesione')
    expect(prelettura[1]).not.toContain('scadenza_adesione')
  })
})
