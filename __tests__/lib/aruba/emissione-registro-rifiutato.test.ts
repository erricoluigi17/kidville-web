import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  INDICE_NUMERO_SERIE,
  INDICE_PAGAMENTO_QUOTA,
  VINCOLO_NUMERO_PER_SEDE,
} from '@/lib/fatturazione/vincolo-registro'

/**
 * IL 23505 A REGISTRO NON È SEMPRE UNA DOPPIA EMISSIONE.
 *
 * ─── IL DIFETTO CHE QUESTO TEST È ROSSO PER PROVARE ────────────────────────────────
 * `emissione.ts` oggi riconosce un solo caso: `code === '23505'` ⇒ «DOPPIA EMISSIONE».
 * Ma su `fatture_emesse` insistono TRE vincoli unici diversi (più uno storico ancora
 * vivo sui database non migrati), e solo UNO di loro dice davvero «per questo
 * pagamento esiste già un documento»:
 *
 *   - `fatture_emesse_pagamento_quota_uidx` (pagamento-quota) — è la vera doppia
 *     emissione: la segreteria ha rifatturato la stessa retta. Ci VUOLE una nota di
 *     variazione.
 *   - `fatture_emesse_sezionale_anno_numero_uidx` (numero-serie) — non è un secondo
 *     documento per lo stesso pagamento: è la NUMERAZIONE che si è ripetuta. Nessuna
 *     nota di variazione: va solo capito quale dei due lo SdI ha accettato.
 *   - `fatture_emesse_scuola_id_anno_numero_key` (numero-per-sede) — il vincolo
 *     storico, tolto dalla migrazione di D1 ma ancora vivo sui DB non migrati (CI):
 *     confonde due serie diverse della STESSA sede che condividono un numero. Il
 *     documento è VALIDO, non è una doppia emissione, nessuna nota di variazione: va
 *     solo registrata (`scripts/fatture-orfane.mjs`).
 *   - qualunque altro nome ⇒ `ignoto`: non si sa cosa sia, si va a guardare su Aruba.
 *
 * Etichettare i tre casi buoni come «DOPPIA EMISSIONE» manda la segreteria a
 * preparare una nota di variazione per un documento che non ne ha bisogno — o, nel
 * caso per-sede, a metterla su un documento perfettamente valido.
 *
 * Vedi D1§7.1-7.2 e D1§12 Test 3 della spec
 * `docs/superpowers/specs/2026-09-22-coda-fatture-aruba/d1-correzione-urgente.md`.
 * Resta rosso finché R1-2.1 non riscrive il ramo `errRegistro` di `emissione.ts`
 * usando `vincoloDelRifiuto` (R1-1.2) al posto del confronto piatto sul `code`.
 *
 * COME SI OSSERVA: stesso modello di `emissione-idempotenza.test.ts` ed
 * `emissione-log.test.ts` — `carica()` ricarica il grafo con `VITEST=''` (il logger è
 * silenzioso sotto vitest) e `app-log` MOCKATO, un finto Supabase, nessun database.
 */

type Riga = Record<string, unknown>

const SCUOLA = '11111111-1111-1111-1111-111111111111'

let appLog: ReturnType<typeof vi.fn>

interface ClientFinto {
  arubaSignin?: unknown
  arubaUpload?: unknown
  arubaUltimoNumeroFattura?: unknown
}

async function carica(finto: ClientFinto) {
  appLog = vi.fn(async () => {})
  vi.resetModules()
  vi.doMock('@/lib/logging/app-log', () => ({ appLog }))
  vi.doMock('@/lib/aruba/client', async (originale) => {
    const actual = await originale<typeof import('@/lib/aruba/client')>()
    return { ...actual, ...finto }
  })
  return await import('@/lib/aruba/emissione')
}

async function righe(minimo = 1): Promise<Riga[]> {
  await vi.waitFor(() => expect(appLog.mock.calls.length).toBeGreaterThanOrEqual(minimo))
  return appLog.mock.calls.map((c) => c[0] as Riga)
}

async function rigaCon(evento: string, livello: string): Promise<Riga> {
  await vi.waitFor(async () => {
    const trovate = (await righe(1)).filter((r) => r.evento === evento && r.livello === livello)
    expect(trovate.length, `nessuna riga ${evento}/${livello} in app_log`).toBeGreaterThan(0)
  })
  return (await righe()).find((r) => r.evento === evento && r.livello === livello) as Riga
}

/** I `campi` di dominio di una riga `app_log` (`esito`, `pagamento_id`, `pavimento`, …):
 * stesso accesso di `pavimento-implausibile.test.ts:104` ed
 * `emissione-multi-quota-estranea.test.ts:571` — `logEvento` li scrive dentro
 * `contestoExtra.campi`, passati da `redact()`; `livello` e `messaggio` restano invece
 * colonne di primo livello. */
function campiDi(riga: Riga | undefined): Record<string, unknown> {
  return (riga?.contestoExtra as { campi?: Record<string, unknown> } | undefined)?.campi ?? {}
}

interface Cfg {
  esistenti?: Record<string, unknown>[]
  erroreInsert?: unknown
  /** Chiave = nome tabella (`pagamenti`), letta da `single()` con `cfg[table]`. */
  pagamenti?: unknown
  settings?: unknown
  parents?: unknown
  /** `fatture_numerazione_sezionale.ultimo_numero`: diventa `contatore_prima` nel log. */
  contatorePrima?: number
  rpc?: number
}

/**
 * Stesso finto di `emissione-idempotenza.test.ts`, con in più
 * `fatture_numerazione_sezionale` (la lettura del contatore che precede la RPC, e
 * che qui diventa `contatore_prima` nel log del ramo `errRegistro`).
 */
function makeSupabase(cfg: Cfg) {
  const inserts: { table: string; row: unknown }[] = []
  const rpc = vi.fn(async () => ({ data: cfg.rpc ?? 2328, error: null }))
  const api = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        limit: () => builder,
        single: async () => ({
          data: (cfg as Record<string, unknown>)[table] ?? null,
          error: null,
        }),
        maybeSingle: async () => {
          if (table === 'admin_settings') return { data: cfg.settings ?? null, error: null }
          if (table === 'parents') return { data: cfg.parents ?? null, error: null }
          if (table === 'fatture_numerazione_sezionale')
            return {
              data: cfg.contatorePrima != null ? { ultimo_numero: cfg.contatorePrima } : null,
              error: null,
            }
          return { data: null, error: null }
        },
        insert: async (row: unknown) => {
          inserts.push({ table, row })
          return { error: table === 'fatture_emesse' ? (cfg.erroreInsert ?? null) : null }
        },
        update: () => ({ eq: async () => ({ error: null }) }),
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'fatture_emesse') return resolve({ data: cfg.esistenti ?? [], error: null })
          return resolve({ data: [], error: null })
        },
      }
      return builder
    },
    rpc,
    _inserts: inserts,
    _rpc: rpc,
  }
  return api
}

// UUID vero: `redact()` lascia in chiaro solo le stringhe «auto-descrittive» (uuid, data
// ISO) — un id come `pag-1` uscirebbe mascherato (`[redatto:str/N]`) e il test non
// potrebbe più leggere `campi.pagamento_id`.
const PAGAMENTO_ID = '22222222-2222-2222-2222-222222222222'

const pagamentoSaldato = {
  id: PAGAMENTO_ID,
  descrizione: 'Retta di Marzo',
  importo: 150,
  stato: 'pagato',
  scadenza: '2026-03-10',
  periodo_competenza: '2026-03-01',
  scuola_id: SCUOLA,
  fattura_causale: null,
  categoria_id: null,
  alunno_id: 'al-1',
  payment_categories: null,
  alunni: {
    id: 'al-1',
    nome: 'Mario',
    cognome: 'Rossi',
    // Dati SINTETICI: repository pubblico, e sono dati di un minore.
    codice_fiscale: null,
    data_nascita: '2019-03-15',
    genitori_separati: false,
    retta_split_config: null,
    intestatario_fatture: { tipo: 'adult', nome: 'Giulia Farina', adult_id: 'parent-1' },
  },
}

const settingsConfig = {
  aruba_config: {
    username: 'utente@scuola.it',
    password_ref: 'ARUBA_PASSWORD',
    abilitato: true,
    ambiente: 'demo',
    fiscal: {
      piva: '03394870616',
      ragione_sociale: "SCUOLA DELL'INFANZIA LA FAVOLA SOCIETA' COOPERATIVA",
      regime: 'RF01',
      indirizzo: 'Via Silvio Pellico 7',
      cap: '81030',
      comune: 'Cesa',
      provincia: 'CE',
    },
  },
}

/** Intestatario SINTETICO e completo: passa il gate del cessionario. */
const parentCompleto = {
  id: 'parent-1',
  first_name: 'Giulia',
  last_name: 'Farina',
  fiscal_code: 'FRNGLI80A41H501Z',
  residence_address: 'Via delle Prove 9',
  residence_city: 'Cesa',
  zip_code: '81030',
}

const tokenOk = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }

/** Pavimento letto da Aruba (→ `pavimento` nel log) e contatore a registro (→ `contatore_prima`). */
const PAVIMENTO = 2327
const CONTATORE_PRIMA = 2320

beforeEach(() => {
  vi.stubEnv('VITEST', '')
  vi.stubEnv('KV_LOG_LEVEL', '')
  vi.stubEnv('ARUBA_PASSWORD', 'segretissima')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.doUnmock('@/lib/logging/app-log')
  vi.doUnmock('@/lib/aruba/client')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

/** Costruisce l'errore Postgres che `vincoloDelRifiuto` deve riconoscere dal `message`. */
function erroreVincolo(nomeVincolo: string) {
  return {
    message: `duplicate key value violates unique constraint "${nomeVincolo}"`,
    code: '23505',
  }
}

async function emetti(erroreInsert: unknown, uploadFileName: string) {
  const { emettiFatturaPagamento } = await carica({
    arubaSignin: vi.fn(async () => tokenOk),
    arubaUltimoNumeroFattura: vi.fn(async () => PAVIMENTO),
    arubaUpload: vi.fn(async () => ({ ok: true, uploadFileName, errorCode: '0000' })),
  })
  const sb = makeSupabase({
    pagamenti: pagamentoSaldato,
    settings: settingsConfig,
    parents: parentCompleto,
    esistenti: [],
    contatorePrima: CONTATORE_PRIMA,
    rpc: 2328,
    erroreInsert,
  })
  await emettiFatturaPagamento(sb as never, PAGAMENTO_ID, { id: 'staff-1' })
  return rigaCon('fattura', 'error')
}

describe('emissione.ts — il 23505 a registro, distinto per VINCOLO (D1§7.2)', () => {
  it('pagamento-quota → registro-doppione-rifiutato, «DOPPIA EMISSIONE»', async () => {
    const r = await emetti(erroreVincolo(INDICE_PAGAMENTO_QUOTA), 'IT_quota.xml.p7m')
    const c = campiDi(r)

    expect(c.esito).toBe('registro-doppione-rifiutato')
    expect(c.pagamento_id).toBe(PAGAMENTO_ID)
    expect(c.pavimento).toBe(PAVIMENTO)
    expect(c.contatore_prima).toBe(CONTATORE_PRIMA)
    expect(String(r.messaggio)).toContain('DOPPIA EMISSIONE')
    expect(String(r.messaggio)).toContain('IT_quota.xml.p7m')
  })

  it('numero-serie → registro-numero-serie-duplicato, nessuna «DOPPIA» né nota di variazione', async () => {
    const r = await emetti(erroreVincolo(INDICE_NUMERO_SERIE), 'IT_serie.xml.p7m')
    const c = campiDi(r)

    expect(c.esito).toBe('registro-numero-serie-duplicato')
    expect(c.pagamento_id).toBe(PAGAMENTO_ID)
    expect(c.pavimento).toBe(PAVIMENTO)
    expect(c.contatore_prima).toBe(CONTATORE_PRIMA)
    expect(String(r.messaggio)).not.toContain('DOPPIA')
    // È la NUMERAZIONE che si è ripetuta, non un secondo documento per lo stesso
    // pagamento: nessun invito a preparare una nota di variazione.
    expect(String(r.messaggio)).not.toContain('prepara la nota di variazione')
    expect(String(r.messaggio)).toContain('IT_serie.xml.p7m')
  })

  it('numero-per-sede (vincolo storico) → registro-vincolo-per-sede, documento VALIDO', async () => {
    const r = await emetti(erroreVincolo(VINCOLO_NUMERO_PER_SEDE), 'IT_sede.xml.p7m')
    const c = campiDi(r)

    expect(c.esito).toBe('registro-vincolo-per-sede')
    expect(c.pagamento_id).toBe(PAGAMENTO_ID)
    expect(c.pavimento).toBe(PAVIMENTO)
    expect(c.contatore_prima).toBe(CONTATORE_PRIMA)
    expect(String(r.messaggio)).not.toContain('DOPPIA')
    // Il documento è valido: il messaggio lo dice esplicitamente e non invita a
    // preparare una nota di variazione (D1§7.2, riga numero-per-sede).
    expect(String(r.messaggio)).not.toContain('prepara la nota di variazione')
    expect(String(r.messaggio)).toContain('IT_sede.xml.p7m')
  })

  it('vincolo non riconosciuto → registro-vincolo-ignoto, nessuna «DOPPIA»', async () => {
    const r = await emetti(erroreVincolo('un_vincolo_mai_visto'), 'IT_ignoto.xml.p7m')
    const c = campiDi(r)

    expect(c.esito).toBe('registro-vincolo-ignoto')
    expect(c.pagamento_id).toBe(PAGAMENTO_ID)
    expect(c.pavimento).toBe(PAVIMENTO)
    expect(c.contatore_prima).toBe(CONTATORE_PRIMA)
    expect(String(r.messaggio)).not.toContain('DOPPIA')
    expect(String(r.messaggio)).not.toContain('prepara la nota di variazione')
    expect(String(r.messaggio)).toContain('IT_ignoto.xml.p7m')
    // Il nome del vincolo non riconosciuto resta leggibile: è l'unico appiglio per
    // capire su Aruba cosa sia successo.
    expect(String(r.messaggio)).toContain('un_vincolo_mai_visto')
  })

  it('restano verdi i due casi già coperti altrove (controllo di non regressione)', async () => {
    // `emissione-idempotenza.test.ts:311-339`: un 23505 col nome dell'indice per
    // quota nel `message` resta «DOPPIA EMISSIONE» — è esattamente il primo caso
    // sopra, letto dal `message` e non da un fallback.
    // `emissione-log.test.ts:223-248`: un 23505 senza nome affatto (`message` senza
    // `constraint "…"` e `details` assente) deve restare interrogabile come
    // «registro», livello error, nome file nel messaggio — col nuovo esito che
    // D1§7.2 assegna al ramo non riconosciuto.
    const r = await emetti({ message: 'duplicate key value violates unique constraint', code: '23505' }, 'IT_senzanome.xml.p7m')
    const c = campiDi(r)

    expect(r.livello).toBe('error')
    expect(c.esito).toBe('registro-vincolo-ignoto')
    expect(String(r.messaggio)).toContain('registro')
    expect(String(r.messaggio)).toContain('IT_senzanome.xml.p7m')
  })
})
