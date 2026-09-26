import { describe, it, expect, vi, beforeEach } from 'vitest'

// GET /api/pagamenti compone `causale_suggerita` PER PAGAMENTO col modello per-categoria
// (admin_settings.causali_config, indicizzato per slug) reso coi dati della voce.
//
// ─── E CI METTE DENTRO IL CODICE DELLA VOCE ─────────────────────────────────────
// La route compone con `causaleBonifico`, non con `renderCausale`: è la sola porta che
// applica `conCodiceVoce`, cioè la garanzia che il `{codice}` esca anche dai modelli
// che le tre sedi hanno scritto quando il codice non esisteva. È anche la porta da cui
// passa il motore dei solleciti — e due porte diverse per la stessa stringa mandano al
// genitore due causali per lo stesso pagamento, una in app e una nell'email.
const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  pagamenti: [] as Record<string, unknown>[],
  scuole: [] as Record<string, unknown>[],
  /** Le quote di uno split: servono al ramo genitore, che senza filtra via la riga. */
  quote: [] as Record<string, unknown>[],
  settingsRow: {} as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  assertAlunnoInScope: vi.fn(async () => null),
}))
// Il ramo genitore parte da qui: senza figli la route esce subito con `data: []`,
// e i due casi in veste di famiglia non eserciterebbero niente.
vi.mock('@/lib/anagrafiche/legami', () => ({ getFigliDiGenitore: vi.fn(async () => ['al-1']) }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      // La mappa si legge a ogni `from()`, cioè al momento della query: i `beforeEach`
      // riassegnano le liste, e una copia presa all'import resterebbe quella vuota.
      const righe: Record<string, Record<string, unknown>[]> = {
        pagamenti: h.pagamenti,
        scuole: h.scuole,
        pagamenti_quote: h.quote,
      }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.order = () => b
      // La GET legge a blocchi (`range`, K1): qui le righe sono poche, un blocco solo.
      b.range = () => b
      b.gte = () => b
      b.lte = () => b
      b.maybeSingle = async () => ({ data: table === 'admin_settings' ? h.settingsRow : null, error: null })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: righe[table] ?? [], error: null })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/route'
// Si importa SOLO per la prova «due voci, due codici diversi»: le stringhe attese qui
// sotto sono scritte a mano, una per una. Comporle chiamando la stessa funzione che la
// route chiama renderebbe il test una tautologia — verde anche con la funzione rotta.
import { codiceVoce } from '@/lib/pagamenti/codice-voce'

const url = (qs = '') => new Request(`http://localhost/api/pagamenti?${qs}`) as unknown as import('next/server').NextRequest

// CF SINTETICO — nessuna persona reale (repo pubblico, dati di minori mai reali).
const CF = 'ABCDEF00A00A000A'

/**
 * I VALORI D'ORO, scritti a mano una volta sola e mai ricalcolati qui dentro.
 *
 * Sono `codiceVoce('pg-1')` e `codiceVoce('pg-2')` — ma trascritti, non invocati: il
 * codice deve restare lo stesso per sempre (sta nelle causali già copiate nell'home
 * banking e nei solleciti già spediti), e un valore cablato è l'unica asserzione che
 * diventa rossa il giorno in cui qualcuno tocca la mescola di `codice-voce.ts`.
 * Il lock del formato vive in `__tests__/lib/pagamenti/codice-voce.test.ts`; questo
 * file prova soltanto che quel codice arriva fino alla risposta del genitore.
 */
const COD_1 = '#KMRTH95'
const COD_2 = '#3KPK27V'
/**
 * Gli altri quattro, trascritti allo stesso modo: il contenitore rateale
 * (`codiceVoce('pg-padre')`), la sua rata (`'pg-rata'`), la voce divisa fra due
 * genitori separati (`'pg-split'`) e la QUOTA di quella voce (`'q-1'`).
 *
 * Gli ultimi due sono una coppia, e servono in coppia: il codice deve essere
 * quello del PAGAMENTO, mai quello della quota. Scritti a mano perché è la
 * differenza fra i due valori a essere la prova, e ricalcolarli qui dentro
 * renderebbe verde anche la route che li scambia.
 */
const COD_PADRE = '#T6X9T74'
const COD_RATA = '#M4X2XH5'
const COD_SPLIT = '#F7XNRKV'
const COD_QUOTA = '#RFFFTR7'

const pagRetta = () => ({
  id: 'pg-1', alunno_id: 'al-1', scuola_id: 'sc-1', descrizione: 'Retta Settembre 2026',
  importo: 150, importo_pagato: 0, scadenza: '2026-09-30', stato: 'da_pagare', tipo: 'singolo',
  periodo_competenza: '2026-09-01',
  payment_categories: { id: 'c-1', nome: 'Rette', slug: 'rette', colore: null, icona: null },
  alunni: { id: 'al-1', nome: 'Mara', cognome: 'Bianchi', codice_fiscale: CF, classe_sezione: null, sospeso: false },
})

/** La seconda voce dello stesso alunno: stessa sede, stessa categoria, altro id. */
const pagMensa = () => ({
  ...pagRetta(), id: 'pg-2', descrizione: 'Mensa Settembre 2026', importo: 80,
})

/** Il contenitore rateale: lo staff lo vede, il genitore no (è filtrato via). */
const pagPadre = () => ({
  ...pagRetta(), id: 'pg-padre', tipo: 'padre', descrizione: 'Retta annuale 2026/27', importo: 1350,
})
/** La rata figlia: è LA riga che il genitore legge, con la propria scadenza. */
const pagRata = () => ({
  ...pagRetta(), id: 'pg-rata', tipo: 'rata', parent_id: 'pg-padre',
})
/** La voce divisa fra due genitori separati: ognuno vede la propria quota. */
const pagSplit = () => ({
  ...pagRetta(), id: 'pg-split', tipo: 'split',
})

describe('GET /api/pagamenti — causale_suggerita per categoria', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pagamenti = [pagRetta()]
    h.scuole = [{ id: 'sc-1', nome: 'Kidville Giugliano' }]
    h.quote = []
    h.settingsRow = null
  })

  it('usa il MODELLO della categoria (slug) reso coi dati della voce (mese/anno/importo)', async () => {
    h.settingsRow = { causali_config: { rette: 'Retta {mese} {anno} - {nome_completo} - {codice_fiscale} - {sede} - {importo}' } }
    const res = await GET(url())
    expect(res.status).toBe(200)
    const j = await res.json()
    // Il modello non cita `{codice}`: l'append lo mette in testa, nel segmento della
    // descrizione (qui il primo), mai in coda — il campo causale della banca si taglia
    // da destra, e in coda il codice sarebbe il primo pezzo a sparire.
    expect(j.data[0].causale_suggerita).toBe(`Retta settembre 2026 ${COD_1} - Mara Bianchi - ${CF} - GIUGLIANO - € 150,00`)
  })

  it('config assente → ricade sul modello PREDEFINITO (formato storico + codice)', async () => {
    h.settingsRow = null // nessuna riga impostazioni
    const res = await GET(url())
    const j = await res.json()
    expect(j.data[0].causale_suggerita).toBe(`Retta Settembre 2026 ${COD_1} - per il minore Mara Bianchi - ${CF} - GIUGLIANO`)
  })

  it('categoria senza modello dedicato → usa il modello «default» della config', async () => {
    h.settingsRow = { causali_config: { default: 'BONIFICO {descrizione} / {sede}' } }
    const res = await GET(url())
    const j = await res.json()
    expect(j.data[0].causale_suggerita).toBe(`BONIFICO Retta Settembre 2026 / GIUGLIANO ${COD_1}`)
  })

  it('periodo_competenza null → {mese}/{anno} spariscono con grazia (il resto del segmento resta)', async () => {
    h.settingsRow = { causali_config: { rette: '{descrizione} {mese} {anno} - {nome_completo}' } }
    h.pagamenti = [{ ...pagRetta(), periodo_competenza: null }]
    const res = await GET(url())
    const j = await res.json()
    // {mese}/{anno} vuoti collassano, ma {descrizione} tiene in vita il segmento.
    expect(j.data[0].causale_suggerita).toBe(`Retta Settembre 2026 ${COD_1} - Mara Bianchi`)
  })
})

// =============================================================================
// IL CODICE DELLA VOCE ARRIVA FINO AL GENITORE
//
// La causale che la famiglia ricopia porta il codice fiscale del minore: dice di CHI è
// il pagamento, non di CHE COSA. Con due voci aperte dello stesso importo — le rette
// sono tutte uguali — la riconciliazione deve indovinare. Il codice toglie l'ambiguità
// nel testo che il genitore ha già in mano, e questo blocco prova che ci arriva davvero.
// =============================================================================
describe('GET /api/pagamenti — il codice della voce dentro la causale', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
    h.pagamenti = [pagRetta()]
    h.scuole = [{ id: 'sc-1', nome: 'Kidville Giugliano' }]
    h.quote = []
    h.settingsRow = null
  })

  it('la causale contiene il codice della PROPRIA voce, in forma canonica col sigillo', async () => {
    const j = await (await GET(url())).json()
    // Le due asserzioni dicono cose diverse e servono entrambe: la prima lega la
    // risposta all'id della riga (se la route calcolasse il codice da un altro campo,
    // questa diventa rossa), la seconda inchioda il valore letterale.
    expect(j.data[0].causale_suggerita).toContain(codiceVoce('pg-1'))
    expect(j.data[0].causale_suggerita).toContain(COD_1)
  })

  it('DUE voci nella stessa risposta → DUE codici diversi (contro la costante cablata)', async () => {
    // Un mock piatto — o un codice cablato in route — resta verde su una riga sola.
    // Qui le righe sono due, identiche in tutto tranne l'id: se il codice non dipende
    // dall'id, i due codici coincidono e questo test è rosso.
    h.pagamenti = [pagRetta(), pagMensa()]
    const j = await (await GET(url())).json()
    expect(j.data).toHaveLength(2)
    expect(j.data[0].causale_suggerita).toBe(
      `Retta Settembre 2026 ${COD_1} - per il minore Mara Bianchi - ${CF} - GIUGLIANO`,
    )
    expect(j.data[1].causale_suggerita).toBe(
      `Mensa Settembre 2026 ${COD_2} - per il minore Mara Bianchi - ${CF} - GIUGLIANO`,
    )
    expect(COD_1).not.toBe(COD_2)
  })

  it('modello di categoria SENZA {codice} → il codice ci finisce lo stesso', async () => {
    // È il caso per cui l'inserimento automatico esiste: le tre sedi hanno modelli
    // propri, scritti prima che il codice esistesse, e il pannello li riscrive per
    // intero a ogni ritocco — migrare il JSONB darebbe una riga giusta oggi e sbagliata
    // alla prima modifica dell'admin. La garanzia sta in LETTURA.
    h.settingsRow = { causali_config: { rette: '{descrizione} - {nome_completo} - {sede}' } }
    const j = await (await GET(url())).json()
    expect(j.data[0].causale_suggerita).toBe(`Retta Settembre 2026 ${COD_1} - Mara Bianchi - GIUGLIANO`)
  })

  it('modello che cita {codice} IN MEZZO → compare lì, e una volta sola', async () => {
    // La garanzia non è un'imposizione: chi scrive `{codice}` nel proprio modello
    // decide dove sta, e non riceve un secondo codice appiccicato alla descrizione.
    h.settingsRow = { causali_config: { rette: '{descrizione} - pagamento {codice} - {nome_completo}' } }
    const j = await (await GET(url())).json()
    const causale = j.data[0].causale_suggerita as string
    expect(causale).toBe(`Retta Settembre 2026 - pagamento ${COD_1} - Mara Bianchi`)
    expect(causale.split(COD_1)).toHaveLength(2) // una sola occorrenza
  })

  // ─── IN VESTE DI GENITORE ───────────────────────────────────────────────────
  // I casi qui sopra montano un'utenza di segreteria: il ramo `agisceComeGenitore`
  // della route — quello che nasconde i contenitori rateali e sostituisce l'importo
  // di uno split con la propria quota — non ci gira mai. Ma è il ramo per cui il
  // codice esiste: la causale che la famiglia ricopia nell'home banking nasce lì, su
  // righe che lo staff non vede nella stessa forma.
  //
  // I due casi qui sotto inchiodano le due affermazioni che finora stavano solo nel
  // commento della route: il contenitore il genitore non lo vede affatto, e per la
  // quota di uno split il codice resta quello del pagamento. Una riscrittura
  // plausibile della proiezione (`id: q.quota_id` al posto di `quota_id: q.id`)
  // romperebbe la seconda in silenzio, con tutta la suite verde.

  it('in veste di GENITORE il contenitore rateale sparisce: il codice è quello della RATA', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
    h.pagamenti = [pagPadre(), pagRata()]
    const j = await (await GET(url())).json()
    // Il contenitore è filtrato PRIMA della causale: il genitore non legge mai il
    // codice di una riga che non ha davanti. Se lo leggesse, il sollecito — che parte
    // dalla rata — gli direbbe un codice diverso da quello dell'app.
    expect(j.data).toHaveLength(1)
    expect(j.data[0].id).toBe('pg-rata')
    expect(j.data[0].causale_suggerita).toBe(
      `Retta Settembre 2026 ${COD_RATA} - per il minore Mara Bianchi - ${CF} - GIUGLIANO`,
    )
    expect(j.data[0].causale_suggerita).not.toContain(COD_PADRE)
  })

  it('in veste di GENITORE la quota di uno split porta il codice del PAGAMENTO, non della quota', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' } })
    h.pagamenti = [pagSplit()]
    h.quote = [{ id: 'q-1', pagamento_id: 'pg-split', importo: 75 }]
    const j = await (await GET(url())).json()
    expect(j.data).toHaveLength(1)
    // Queste due righe provano che la proiezione dello split è DAVVERO girata (senza
    // quota propria la riga sarebbe stata filtrata via) e che `q-1` era a portata di
    // mano: solo così l'asserzione dopo dice qualcosa, cioè che non l'ha usato.
    expect(j.data[0].quota_id).toBe('q-1')
    expect(j.data[0].importo).toBe(75)
    // Due genitori separati pagano la stessa voce: se il codice seguisse la quota ne
    // riceverebbero due diversi per la stessa cosa, e la riconciliazione tornerebbe a
    // indovinare — esattamente il guasto che il codice della voce esiste per chiudere.
    expect(j.data[0].causale_suggerita).toBe(
      `Retta Settembre 2026 ${COD_SPLIT} - per il minore Mara Bianchi - ${CF} - GIUGLIANO`,
    )
    expect(j.data[0].causale_suggerita).not.toContain(COD_QUOTA)
  })
})
