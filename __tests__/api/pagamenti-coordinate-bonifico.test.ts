// @vitest-environment node
/**
 * `GET /api/pagamenti` risponde anche COME SI PAGA: `sedi: [{ id, nome, iban, intestatario }]`.
 *
 * ─── PERCHÉ STA NELLA STESSA RISPOSTA ───────────────────────────────────────
 * La pagina del genitore mostra già la causale consigliata, che il GET compone
 * per ogni voce leggendo `causali_config` in un loop per sede. L'IBAN e
 * l'intestatario abitano la stessa riga di `admin_settings` e servono alla
 * stessa card: una seconda chiamata li leggerebbe di nuovo, e una famiglia con
 * figli in due plessi vedrebbe due card o — peggio — una sola con le coordinate
 * di uno dei due.
 *
 * ⚠️ IL PERIMETRO DELLE SEDI È QUELLO DELLE RIGHE, non «tutte le sedi». Le
 * righe sono già filtrate (`.in('scuola_id', sediAttive)` per lo staff,
 * `.in('alunno_id', figli)` per il genitore): da lì escono le sedi distinte e
 * nient'altro. Un elenco più largo direbbe a un genitore che esistono plessi
 * dove non ha figli.
 *
 * Il finto client APPLICA i filtri (`__tests__/fixtures/finto-supabase.ts`): se
 * la lettura di `fiscale_config` non filtrasse per sede, la sede B qui
 * riceverebbe le coordinate della sede A e il test sarebbe ROSSO. È la
 * differenza con un mock piatto, che risponde la stessa riga a ogni tabella e
 * resta verde con e senza il filtro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// IBAN SINTETICI: l'esempio pubblico della Banca d'Italia e una sua variante con
// una cifra cambiata. Nessuno dei due appartiene a un conto reale.
const IBAN_A = 'IT60X0542811101000000123456'
const IBAN_A_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456'
const IBAN_STORTO = 'IT60X0542811101000000123457'
// CF SINTETICO — nessuna persona reale (repo pubblico, dati di minori mai reali).
const CF = 'ABCDEF00A00A000A'

const GENITORE = '33333333-3333-4333-8333-333333333333'
const STAFF = '11111111-1111-4111-8111-111111111111'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireStaff: vi.fn(),
  sediAttive: vi.fn(async () => [] as string[]),
  figli: vi.fn(async () => [] as string[]),
  db: {} as DBFinto,
  tabelle: [] as string[],
  logEvento: vi.fn(),
}))

// Il logger vero con la sola `logEvento` sostituita: `withRoute` continua a
// girare per intero, e qui si misurano le CHIAMATE, non il testo della riga.
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser, requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: (...a: unknown[]) => h.sediAttive(...(a as [])),
  assertAlunnoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: (...a: unknown[]) => h.figli(...(a as [])),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle) as never }
})

import { GET } from '@/app/api/pagamenti/route'
// La redazione VERA: è lei a decidere cosa di una riga si legge davvero in `app_log`.
import { redact } from '@/lib/logging/redact'
// La regola VERA di persistenza (il mock qui sopra sostituisce la sola `logEvento`):
// serve a provare che l'opzione `persisti: false` porta il suo peso, e non è
// decorazione su un canale che in tabella non ci sarebbe finito comunque.
import { vaPersistito } from '@/lib/logging/logger'

const url = (qs = '') =>
  new Request(`http://localhost/api/pagamenti?${qs}`) as unknown as import('next/server').NextRequest

const pagamento = (id: string, alunno: string, sede: string) => ({
  id,
  alunno_id: alunno,
  scuola_id: sede,
  descrizione: 'Retta Settembre 2026',
  importo: 150,
  importo_pagato: 0,
  scadenza: '2026-09-30',
  stato: 'da_pagare',
  tipo: 'singolo',
  periodo_competenza: '2026-09-01',
  visibile_dal: null,
  payment_categories: { id: 'c-1', nome: 'Rette', slug: 'rette', colore: null, icona: null },
  alunni: { id: alunno, nome: 'Mara', cognome: 'Bianchi', codice_fiscale: CF, classe_sezione: null, sospeso: false },
})

/** Due plessi: A con le coordinate compilate, B con l'IBAN sbagliato di una cifra. */
const dbDueSedi = (): DBFinto => ({
  pagamenti: [pagamento('pg-a', ALU_A, SEDE_A), pagamento('pg-b', ALU_B, SEDE_B)],
  scuole: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  admin_settings: [
    {
      scuola_id: SEDE_A,
      fiscale_config: { denominazione: 'Scuola La Favola soc. coop.', iban: IBAN_A },
      aruba_config: {},
      causali_config: {},
    },
    {
      scuola_id: SEDE_B,
      fiscale_config: { denominazione: 'Sede Beta', iban: IBAN_STORTO },
      aruba_config: {},
      causali_config: {},
    },
  ],
  pagamenti_quote: [],
})

/** La forma di una voce di `sedi`: è il contratto che la card «Come pagare» consuma. */
type VoceSede = { id: string; nome: string; iban: string | null; intestatario: string | null }

/** L'ordine di `sedi` segue quello delle righe: qui si confronta il CONTENUTO, non l'ordine. */
const perId = (sedi: VoceSede[]): VoceSede[] => [...sedi].sort((a, b) => a.id.localeCompare(b.id))

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.db = dbDueSedi()
  h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'genitore' } })
  h.figli.mockResolvedValue([ALU_A, ALU_B])
  h.sediAttive.mockResolvedValue([SEDE_A, SEDE_B])
})

describe('GET /api/pagamenti — le coordinate del bonifico, una per sede', () => {
  it('genitore con figli in DUE sedi: due voci in `sedi`, ognuna con le PROPRIE coordinate', async () => {
    const res = await GET(url())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.sedi).toHaveLength(2)
    expect(perId(j.sedi)).toEqual([
      { id: SEDE_A, nome: NOME_SEDE_A, iban: IBAN_A_LEGGIBILE, intestatario: 'Scuola La Favola soc. coop.' },
      // L'IBAN della sede B ha una cifra sbagliata: non si mostra affatto.
      { id: SEDE_B, nome: NOME_SEDE_B, iban: null, intestatario: 'Sede Beta' },
    ])
  })

  it('sede senza riga di impostazioni → `iban` e `intestatario` a `null`, non spariti', async () => {
    h.db.admin_settings = []
    const j = await (await GET(url())).json()
    expect(perId(j.sedi)).toEqual([
      { id: SEDE_A, nome: NOME_SEDE_A, iban: null, intestatario: null },
      { id: SEDE_B, nome: NOME_SEDE_B, iban: null, intestatario: null },
    ])
  })

  it('sede senza nome in `scuole` → `nome` stringa vuota (la card resta, l’etichetta no)', async () => {
    h.db.scuole = [{ id: SEDE_A, nome: NOME_SEDE_A }]
    const j = await (await GET(url())).json()
    expect(perId(j.sedi).map((s) => s.nome)).toEqual([NOME_SEDE_A, ''])
  })

  it('staff con `?scuola_id=`: `sedi` porta SOLO quella sede, nessuna in più', async () => {
    h.requireUser.mockResolvedValue({ user: { id: STAFF, role: 'segreteria' } })
    const j = await (await GET(url(`scuola_id=${SEDE_A}`))).json()
    expect(j.data.map((r: { scuola_id: string }) => r.scuola_id)).toEqual([SEDE_A])
    expect(j.sedi).toEqual([
      { id: SEDE_A, nome: NOME_SEDE_A, iban: IBAN_A_LEGGIBILE, intestatario: 'Scuola La Favola soc. coop.' },
    ])
  })

  it('nessuna riga → `data: []` e `sedi: []` (la forma della risposta non cambia)', async () => {
    h.db.pagamenti = []
    const j = await (await GET(url())).json()
    expect(j).toMatchObject({ success: true, data: [], sedi: [] })
  })

  it('genitore SENZA figli: il ritorno anticipato porta comunque `sedi: []`', async () => {
    // Senza questo, la pagina riceverebbe `sedi` undefined proprio nel caso in
    // cui non ha niente da mostrare, e il componente andrebbe letto due volte.
    h.figli.mockResolvedValue([])
    const j = await (await GET(url())).json()
    expect(j).toEqual({ success: true, data: [], sedi: [] })
  })

  it('`data` resta quello di prima: causale consigliata e nome sede intatti', async () => {
    h.db.pagamenti = [pagamento('pg-a', ALU_A, SEDE_A)]
    h.figli.mockResolvedValue([ALU_A])
    const j = await (await GET(url())).json()
    expect(j.data).toHaveLength(1)
    expect(j.data[0]).toMatchObject({
      id: 'pg-a',
      scuola_nome: NOME_SEDE_A,
      causale_suggerita: `Retta Settembre 2026 - per il minore Mara Bianchi - ${CF} - ALFA`,
      residuo: 150,
    })
  })
})

/** Quante volte è stata interrogata `admin_settings` in questa richiesta. */
const lettureImpostazioni = () => h.tabelle.filter((t) => t === 'admin_settings').length

/** Le chiamate a `logEvento` del gruppo `pagamento` con quell'esito. */
type ChiamataLog = [string, string, Record<string, unknown>, unknown?, { persisti?: boolean }?]
const riepiloghi = () =>
  (h.logEvento.mock.calls as ChiamataLog[]).filter(
    (c) => c[0] === 'pagamento' && c[2]?.esito === 'coordinate-bonifico',
  )

// =============================================================================
// LE COORDINATE SI LEGGONO SOLO PER CHI LE GUARDA (collaudo 2026-09-05, rilievo c)
//
// L'IBAN è nato per la card «Come pagare» del genitore. Ma `GET /api/pagamenti`
// serve anche il pannello dei pagamenti aperti della segreteria, che la chiama
// con `?solo_aperti=true` per riempire una tabella di righe da incassare: lì
// nessuno guarda l'IBAN, e ogni sede in elenco costava due letture in più di
// `admin_settings`.
//
// La condizione dice quando NON servono, non quando servono: così un chiamante
// non previsto (una docente che è anche genitore e sta guardando in veste di
// lavoro) ricade nel comportamento generoso, non nel vuoto.
// =============================================================================
describe('GET /api/pagamenti — le coordinate si leggono solo dove servono', () => {
  it('staff con `?solo_aperti=true`: `sedi` vuoto e NESSUNA lettura in più di `admin_settings`', async () => {
    h.requireUser.mockResolvedValue({ user: { id: STAFF, role: 'segreteria' } })
    const j = await (await GET(url('solo_aperti=true'))).json()

    // Le righe ci sono (sono tutte da pagare): a mancare sono le sole coordinate.
    expect(j.data).toHaveLength(2)
    expect(j.sedi).toEqual([])
    // Una lettura per sede — `causali_config`, che serve alla causale di ogni
    // riga — e nient'altro: con le coordinate sarebbero tre per sede.
    expect(lettureImpostazioni()).toBe(2)
    expect(riepiloghi()).toEqual([])
  })

  it('lo stesso staff SENZA `solo_aperti`: le coordinate tornano, e con loro le tre letture', async () => {
    // Il controllo negativo del test qui sopra: senza, «zero letture» e «zero
    // coordinate» avrebbero lo stesso colore anche se la route fosse rotta.
    h.requireUser.mockResolvedValue({ user: { id: STAFF, role: 'segreteria' } })
    const j = await (await GET(url())).json()
    expect(j.sedi).toHaveLength(2)
    expect(lettureImpostazioni()).toBe(6)
  })

  it('il genitore le riceve anche con `?solo_aperti=true` in coda alla query', async () => {
    // Il ramo genitore ignora i filtri dello staff: la card «Come pagare» non
    // può dipendere da cosa c'è scritto nella query string.
    const j = await (await GET(url('solo_aperti=true'))).json()
    expect(j.sedi).toHaveLength(2)
  })

  it('chi non è staff né genitore attivo (docente in veste di lavoro) le riceve comunque', async () => {
    h.requireUser.mockResolvedValue({ user: { id: GENITORE, role: 'educator' } })
    const j = await (await GET(url())).json()
    expect(j.sedi).toHaveLength(2)
  })
})

// ─── LA RISPOSTA PORTA UN IBAN: NON SI METTE IN CACHE (rilievo d) ────────────
describe('GET /api/pagamenti — `Cache-Control` sulla risposta che porta le coordinate', () => {
  it('la risposta piena dichiara `private, no-store`', async () => {
    const res = await GET(url())
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('anche il ritorno anticipato del genitore senza figli lo dichiara', async () => {
    // È la stessa risposta, con dentro meno roba: se l'intestazione dipendesse da
    // QUANTO c'è nel corpo, sarebbe una regola che nessuno può ricordare.
    h.figli.mockResolvedValue([])
    const res = await GET(url())
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

// ─── QUANTE VOLTE LA CARD È USCITA COL RIPIEGO (rilievo f) ──────────────────
// Senza questa riga, «l'IBAN manca su due sedi su tre» è una cosa che si scopre
// solo aprendo l'app con l'account di una famiglia.
//
// ⚠️ MA LA RIGA VIVE SU VERCEL, NON IN `app_log`. Qui prima c'era scritto che
// «`app_log` deduplica per giorno: è una riga al giorno», e non è vero: deduplica
// per **(impronta, giorno)**, e `utente_id` è dentro l'impronta. Su una pagina che
// ogni genitore apre, «una al giorno» diventa «una al giorno PER GENITORE». Il test
// in fondo a questo blocco è il lock di quella scelta.
describe('GET /api/pagamenti — il riepilogo delle coordinate servite', () => {
  it('una sede con IBAN e una senza → i due conteggi, e nessun dato di nessuno', async () => {
    await GET(url())
    expect(riepiloghi()).toHaveLength(1)
    const [evento, livello, campi] = riepiloghi()[0]
    expect(evento).toBe('pagamento')
    expect(livello).toBe('info')
    expect(campi).toMatchObject({
      operazione: 'pagamenti:GET',
      esito: 'coordinate-bonifico',
      sedi_con_coordinate: 1,
      sedi_senza_coordinate: 1,
    })
    // Né l'IBAN, né i nomi delle sedi, né gli uuid dei bambini.
    const testo = JSON.stringify(campi)
    expect(testo).not.toContain(IBAN_A)
    expect(testo).not.toContain(IBAN_A_LEGGIBILE)
    expect(testo).not.toContain(NOME_SEDE_A)
    expect(testo).not.toContain(ALU_A)
  })

  /**
   * ⚠️ QUESTO NON È (PIÙ) IL LOCK DELLA REDAZIONE, e il nome lo dice.
   *
   * L'asserzione era nata come «i campi sopravvivono a `redact()`», cioè come
   * guardia contro una fuga. Non può esserlo: la riga esce con `persisti: false`
   * (lock in fondo al file) e `redact()` sta sul ramo della PERSISTENZA — su
   * questa riga non gira, quindi nessuna fuga vera la farebbe diventare rossa.
   * Chiamarla lock della redazione sarebbe un motivo scritto falso, ed è il modo
   * in cui un lock si sfila da solo: chi legge il nome, misura, e conclude che è
   * un doppione da togliere.
   *
   * Ciò che verifica davvero è i NOMI dei campi, ed è un controllo che serve: i
   * primi nomi erano `sedi_con_iban` / `sedi_senza_iban` e uscivano
   * **`[redatto]`**, perché `iban` è una RADICE SEGRETA di `redact()` e la
   * corrispondenza è per contenimento — vale anche sui numeri, e il redatto secco
   * cancella pure la forma. `coordinate` descrive la stessa cosa senza toccare la
   * radice.
   *
   * Il giorno in cui la valvola si richiudesse (`persisti: false` tolto, o
   * `redact()` spostato prima del ramo), questa stessa riga tornerebbe a
   * sorvegliare la redazione per davvero — e i nomi sono già quelli giusti,
   * invece di scoprirlo da una colonna piena di `[redatto]`.
   */
  it('i nomi dei campi non toccano la radice segreta `iban`: `redact()` li lascia passare', async () => {
    await GET(url())
    const [, , campi] = riepiloghi()[0]
    expect(redact(campi)).toMatchObject({
      esito: 'coordinate-bonifico',
      operazione: 'pagamenti:GET',
      sedi_con_coordinate: 1,
      sedi_senza_coordinate: 1,
    })
  })

  it('nessuna sede → nessuna riga (un conteggio di zero non è una notizia)', async () => {
    h.db.pagamenti = []
    await GET(url())
    expect(riepiloghi()).toEqual([])
  })

  it('la riga NON si persiste: `persisti: false`, perché l’impronta di `app_log` include l’utente', async () => {
    // PERCHÉ QUESTA ASSERZIONE COMINCIA DA `vaPersistito`.
    //
    // `pagamento` sta in `EVENTI_PERSISTITI`: senza l'opzione questa riga finisce
    // in tabella PER ELENCO, non per livello — un `info` qualunque non ci
    // arriverebbe. Se un giorno qualcuno togliesse `pagamento` dall'elenco,
    // «non persiste» resterebbe vero per la ragione sbagliata e l'opzione
    // diventerebbe decorazione: questa prima riga la tiene onesta.
    expect(vaPersistito('info', 'pagamento')).toBe(true)

    // E IL VOLUME CHE SI EVITA, in numeri. `app_log` deduplica per (impronta,
    // giorno) e `utente_id` è una delle parti dell'impronta (`impronta()` in
    // `app-log.ts`): su un percorso che ogni famiglia apre, la riga sarebbe una
    // PER GENITORE al giorno — nel giorno di punta 286 utenti distinti contro
    // 1.733 righe totali in tabella: un ordine di grandezza di +16% di volume da
    // questa sola. I due conteggi sono misurati, il +16% è l'inferenza che ci si
    // costruisce sopra (vale se ognuno di quei 286 apre la pagina dei pagamenti,
    // e i 286 stanno in `app_log` per qualunque motivo): è la taglia, non la misura.
    // In cambio la tabella non risponderebbe nemmeno alla domanda: l'`ON CONFLICT`
    // somma le occorrenze ma NON aggiorna il `contesto`, quindi i due conteggi
    // resterebbero quelli della PRIMA apertura di quel genitore.
    //
    // Il segnale durevole su «dove manca l'IBAN» resta, ed è migliore: le righe
    // per-sede di `coordinateBonificoSede` (`warn iban-non-configurato`,
    // `error iban-non-valido`) portano lo `scuola_id` e si persistono per livello.
    await GET(url())
    const [, , , errore, opzioni] = riepiloghi()[0]
    expect(errore).toBeUndefined()
    expect(opzioni).toEqual({ persisti: false })
  })
})
