// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// IL REGISTRO DEI CARICAMENTI AL PLURALE — due facce, una sola istruzione.
//
// Dal 2026-08-12 `/anagrafica-personale` chiede DUE scansioni del documento
// d'identità, fronte e retro, entrambe obbligatorie. Il registro
// (`caricamenti_personale`) nasceva per una faccia sola, e le sue funzioni erano
// singolari: una lettura per percorso, un `update` per percorso.
//
// ── PERCHÉ IL PLURALE NON È UNA COMODITÀ ────────────────────────────────────
//
// Con due chiamate separate il fronte può collegarsi e il retro no. Il risultato è
// una pratica MEZZA documentata — la spazzata toglie il retro entro 24 ore mentre la
// pratica lo nomina ancora — e DUE righe di log scoordinate che nessuno sa
// ricomporre: due `caricamento-non-collegato` con lo stesso `entita_id`, uno dei
// quali potrebbe non esserci affatto perché quella chiamata è riuscita.
//
// Con UN SOLO `update … .in(percorsi) … .is('pratica_id', null) .select('percorso')`
// il fallimento parziale smette di essere una race e diventa un'aritmetica: si legge
// dal NUMERO di righe tornate. Da qui i due campi che questi test inchiodano —
// `n_attesi` e `n_collegati` — su UNA riga di log sola.
//
// ── I DUE FATTI MISURATI OGGI (12/08/2026), che il file non sapeva ancora ────
//
//   select to_regclass('public.caricamenti_personale') is not null;  → true
//   select count(*) from information_schema.columns
//     where table_name='caricamenti_personale' and column_name='anagrafica_utente_id'; → 1
//
// Cioè: la tabella ESISTE in produzione (migrazione `20260811234334`, applicata) e
// ha già il secondo proprietario (`documento_fronte_retro`, registrata come
// `20260812194501`). I commenti del modulo dicevano il contrario, ed è la ragione per
// cui questi test misurano invece di fidarsi.
//
// ── IL TRABOCCHETTO, che è la prova più importante del file ─────────────────
//
// La porta admin carica una scansione che NON appartiene a nessuna pratica: appartiene
// a un'anagrafica. Se quella riga nasce senza `anagrafica_utente_id`, resta con
// `pratica_id is null` — cioè «in sospeso» — e `spazzaCaricamentiSospesi` cancella
// entro 24 ore il documento d'identità di una persona vera MENTRE
// `anagrafica_personale` lo nomina. Il fascicolo punterebbe a un file che non c'è.
// Due test lo chiudono da tutti e due i lati: chi scrive deve dichiarare il
// proprietario, e chi spazza deve GUARDARLO.
// =============================================================================

type Riga = {
  percorso: string
  caricato_il: string
  pratica_id: string | null
  anagrafica_utente_id: string | null
}

/** Ogni istruzione che il finto database ha davvero eseguito. È così che si conta. */
type Istruzione = {
  modo: 'select' | 'insert' | 'update' | 'delete'
  percorsi: string[] | null
  soloSenzaPratica: boolean
  soloSenzaAnagrafica: boolean
}

const h = vi.hoisted(() => ({
  /** La tabella `caricamenti_personale`, in memoria. */
  registro: [] as Riga[],
  /** Le righe passate a `.insert()`, così come sono. */
  inserts: [] as Record<string, unknown>[],
  /** Ogni istruzione arrivata al database: il conteggio È l'asserzione. */
  istruzioni: [] as Istruzione[],
  /** Errori iniettabili, per modo: PostgREST NON lancia, ritorna `{ error }`. */
  erroreLettura: null as { code?: string; message?: string } | null,
  erroreUpdate: null as { code?: string; message?: string } | null,
  erroreInsert: null as { code?: string; message?: string } | null,
  /**
   * Le colonne che questo database NON ha.
   *
   * Non è un dettaglio di comodo: è il DB E2E della CI, che non è migrato, e la
   * produzione fra la migrazione e il deploy. Una colonna assente non è un errore
   * generico — è `PGRST204` su INSERT/UPDATE e `42703` su SELECT, e il codice deve
   * degradare pulito su entrambi invece di esplodere.
   */
  colonneAssenti: new Set<string>(),
  /** Ogni `.remove([...])` visto dallo Storage. */
  rimozioni: [] as { bucket: string; percorsi: string[] }[],
  /** I log emessi: evento, livello, campi. */
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', async (orig) => {
  const reale = await orig<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
  }
})

import {
  BUCKET_DOCUMENTI_PERSONALE,
  ORE_CARICAMENTO_IN_SOSPESO,
  caricamentiReclamabili,
  caricamentoReclamabile,
  collegaCaricamenti,
  collegaCaricamento,
  facceChieste,
  registraCaricamento,
  spazzaCaricamentiSospesi,
} from '@/lib/personale/caricamenti'
import type { SupabaseClient } from '@supabase/supabase-js'

const OP = 'prova/caricamenti:POST'

/** Un percorso nella forma vera che la porta di caricamento produce. */
const percorsoFinto = () => `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.pdf`

const oreFa = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000).toISOString()

/**
 * Il finto database, con i FILTRI CHE FILTRANO DAVVERO.
 *
 * Un finto che rispondesse sempre lo stesso elenco renderebbe verdi queste prove
 * qualunque predicato il codice usasse — e i predicati sono l'intera regola:
 * `pratica_id is null` e `anagrafica_utente_id is null` (nessuno l'ha reclamato),
 * `.in('percorso', …)` (queste due facce e non altre).
 */
function finto() {
  return {
    from(tabella: string) {
      if (tabella !== 'caricamenti_personale') throw new Error(`tabella non prevista: ${tabella}`)
      let modo: Istruzione['modo'] = 'select'
      let percorsi: string[] | null = null
      let soloSenzaPratica = false
      let soloSenzaAnagrafica = false
      let soglia: string | null = null
      let tetto: number | null = null
      let patch: Record<string, unknown> = {}
      const colonneToccate: string[] = []

      const b: Record<string, unknown> = {}
      b.insert = (riga: Record<string, unknown>) => {
        modo = 'insert'
        patch = riga
        colonneToccate.push(...Object.keys(riga))
        return b
      }
      b.update = (riga: Record<string, unknown>) => {
        modo = 'update'
        patch = riga
        colonneToccate.push(...Object.keys(riga))
        return b
      }
      b.delete = () => {
        modo = 'delete'
        return b
      }
      b.select = () => b
      b.in = (colonna: string, valori: string[]) => {
        colonneToccate.push(colonna)
        if (colonna === 'percorso') percorsi = [...valori]
        return b
      }
      b.is = (colonna: string, valore: unknown) => {
        colonneToccate.push(colonna)
        if (colonna === 'pratica_id' && valore === null) soloSenzaPratica = true
        if (colonna === 'anagrafica_utente_id' && valore === null) soloSenzaAnagrafica = true
        return b
      }
      b.lt = (colonna: string, valore: unknown) => {
        colonneToccate.push(colonna)
        if (colonna === 'caricato_il') soglia = String(valore)
        return b
      }
      b.order = () => b
      b.limit = (n: number) => {
        tetto = n
        return b
      }

      const corrisponde = (r: Riga) =>
        (percorsi === null || percorsi.includes(r.percorso)) &&
        (!soloSenzaPratica || r.pratica_id === null) &&
        (!soloSenzaAnagrafica || r.anagrafica_utente_id === null) &&
        (soglia === null || r.caricato_il < soglia)

      b.then = (res: (v: unknown) => unknown) => {
        h.istruzioni.push({ modo, percorsi, soloSenzaPratica, soloSenzaAnagrafica })

        // Una colonna che questo database non ha: `PGRST204` se la si SCRIVE,
        // `42703` se la si legge o filtra. È la forma vera dell'errore.
        const mancante = colonneToccate.find((c) => h.colonneAssenti.has(c))
        if (mancante !== undefined) {
          const scrittura = modo === 'insert' || modo === 'update'
          const scritta = Object.keys(patch).includes(mancante)
          const code = scrittura && scritta ? 'PGRST204' : '42703'
          return Promise.resolve({
            data: null,
            error: {
              code,
              message:
                code === 'PGRST204'
                  ? `Could not find the '${mancante}' column of 'caricamenti_personale' in the schema cache`
                  : `column caricamenti_personale.${mancante} does not exist`,
            },
          }).then(res)
        }

        if (modo === 'insert') {
          h.inserts.push({ ...patch })
          if (h.erroreInsert) return Promise.resolve({ data: null, error: h.erroreInsert }).then(res)
          h.registro.push({
            percorso: String(patch.percorso),
            caricato_il: new Date().toISOString(),
            pratica_id: (patch.pratica_id as string | undefined) ?? null,
            anagrafica_utente_id: (patch.anagrafica_utente_id as string | undefined) ?? null,
          })
          return Promise.resolve({ data: null, error: null }).then(res)
        }

        if (modo === 'update') {
          if (h.erroreUpdate) return Promise.resolve({ data: null, error: h.erroreUpdate }).then(res)
          const toccate = h.registro.filter(corrisponde)
          for (const r of toccate) Object.assign(r, patch)
          return Promise.resolve({
            data: toccate.map((r) => ({ percorso: r.percorso })),
            error: null,
          }).then(res)
        }

        if (modo === 'delete') {
          h.registro = h.registro.filter((r) => !corrisponde(r))
          return Promise.resolve({ data: null, error: null }).then(res)
        }

        if (h.erroreLettura) return Promise.resolve({ data: null, error: h.erroreLettura }).then(res)
        const righe = h.registro
          .filter(corrisponde)
          .sort((x, y) => x.caricato_il.localeCompare(y.caricato_il))
          .slice(0, tetto ?? 1000)
          .map((r) => ({ percorso: r.percorso }))
        return Promise.resolve({ data: righe, error: null }).then(res)
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (percorsi: string[]) => {
          h.rimozioni.push({ bucket, percorsi: [...percorsi] })
          return { data: percorsi.map((p) => ({ name: p })), error: null }
        },
        // Dopo un `remove()` riuscito il file non c'è più: elenco vuoto.
        list: async () => ({ data: [], error: null }),
      }),
    },
  } as unknown as SupabaseClient
}

let db: SupabaseClient

beforeEach(() => {
  h.registro = []
  h.inserts = []
  h.istruzioni = []
  h.erroreLettura = null
  h.erroreUpdate = null
  h.erroreInsert = null
  h.colonneAssenti = new Set()
  h.rimozioni = []
  h.eventi = []
  db = finto()
})

/** Mette a registro un caricamento già avvenuto, come farebbe la porta di upload. */
function inRegistro(percorso: string, quando = new Date().toISOString()): string {
  h.registro.push({ percorso, caricato_il: quando, pratica_id: null, anagrafica_utente_id: null })
  return percorso
}

const esiti = () => h.eventi.map((e) => e.campi.esito)
const senzaPercorsi = () => expect(JSON.stringify(h.eventi)).not.toContain('documenti/')

// =============================================================================
describe('caricamentiReclamabili · una lettura sola per tutte le facce', () => {
  it('due percorsi liberi: ammessi, e con UNA sola istruzione', async () => {
    const fronte = inRegistro(percorsoFinto())
    const retro = inRegistro(percorsoFinto())

    const esito = await caricamentiReclamabili(db, [fronte, retro], OP)

    expect(esito).toEqual({ ammesso: true, assente: false, degradato: false, mancanti: [] })
    // ⚠️ L'ASSERZIONE CHE VALE PER TUTTO IL FILE: una interrogazione, non due. Con
    // due, fra la prima e la seconda c'è una finestra in cui l'altra faccia può
    // essere reclamata da qualcun altro.
    expect(h.istruzioni, 'due letture separate: il plurale non è stato rispettato').toHaveLength(1)
    expect(h.istruzioni[0].percorsi).toEqual([fronte, retro])
    expect(h.istruzioni[0].soloSenzaPratica, 'manca `is(pratica_id, null)`').toBe(true)
  })

  it('uno dei due è GIÀ DI QUALCUNO: cade tutto, e si sa QUALE', async () => {
    // È il caso normale del difetto, non un abuso: il retro è stato caricato e
    // reclamato da un invio precedente. Ammettere il fronte e basta darebbe una
    // pratica mezza documentata; rifiutare senza dire quale campo costringe la
    // persona a ricaricarli tutti e due.
    const fronte = inRegistro(percorsoFinto())
    const retro = inRegistro(percorsoFinto())
    h.registro[1].pratica_id = 'pratica-di-un-altro'

    const esito = await caricamentiReclamabili(db, [fronte, retro], OP)

    expect(esito.ammesso).toBe(false)
    // ⚠️ INDICI, NON PERCORSI. `mancanti` è l'unica cosa che esce da questo modulo per
    // finire in mano a chi risponde 400, e un percorso è la chiave con cui si firma la
    // fotografia di un documento d'identità: basta un `logEvento({ campi: reclamo })`
    // scritto in buona fede fra sei mesi perché finisca in `app_log` per 30 giorni.
    // L'indice dice QUALE faccia — che è tutto ciò che serve al 400 — e non apre niente.
    expect(esito.mancanti, 'il retro è la faccia n. 1').toEqual([1])
    expect(esito.assente).toBe(false)
    expect(esito.degradato).toBe(false)
    expect(h.istruzioni).toHaveLength(1)
  })

  it('un percorso INVENTATO non è reclamabile (la forma sta in un repo pubblico)', async () => {
    const fronte = inRegistro(percorsoFinto())
    const inventato = percorsoFinto()

    const esito = await caricamentiReclamabili(db, [fronte, inventato], OP)

    expect(esito.ammesso).toBe(false)
    expect(esito.mancanti).toEqual([1])
    // Il valore di ritorno esce dal modulo: se portasse i percorsi, la regola «mai il
    // percorso nei log» resterebbe vera qui dentro e falsa un file più in là.
    expect(JSON.stringify(esito), 'un percorso è uscito dal modulo').not.toContain('documenti/')
  })

  it('un percorso già di un’ANAGRAFICA non è reclamabile da una pratica', async () => {
    // «Un oggetto, un proprietario» vale per tutti e due i proprietari, non solo per
    // le pratiche. Senza questo predicato una pratica pubblica potrebbe nominare la
    // scansione che la Segreteria ha caricato nella scheda di una collega — cioè far
    // firmare a quella Segreteria il documento d'identità di un'altra persona — e il
    // `check (num_nonnulls(pratica_id, anagrafica_utente_id) <= 1)` se ne
    // accorgerebbe solo dopo, quando la pratica è già entrata.
    const fronte = inRegistro(percorsoFinto())
    const retro = inRegistro(percorsoFinto())
    h.registro[1].anagrafica_utente_id = crypto.randomUUID()

    const esito = await caricamentiReclamabili(db, [fronte, retro], OP)

    expect(esito.ammesso).toBe(false)
    expect(esito.mancanti).toEqual([1])
    expect(h.istruzioni[0].soloSenzaAnagrafica, 'manca `is(anagrafica_utente_id, null)`').toBe(true)
  })

  it('registro ASSENTE: blocca tutti, `error`, e il log nomina la migrazione', async () => {
    h.erroreLettura = { code: 'PGRST205', message: 'Could not find the table in the schema cache' }
    const fronte = percorsoFinto()
    const retro = percorsoFinto()

    const esito = await caricamentiReclamabili(db, [fronte, retro], OP)

    // In quello stato nessuna persona vera PUÒ avere un percorso valido — la porta di
    // caricamento, davanti allo stesso codice, ritira l'oggetto e risponde 500 — quindi
    // il fail-open proteggerebbe soltanto chi il percorso se lo inventa.
    expect(esito.ammesso).toBe(false)
    expect(esito.assente).toBe(true)
    expect(esito.degradato).toBe(false)
    expect(esito.mancanti, 'la porta è chiusa per tutte le facce').toEqual([0, 1])

    const grido = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-assente')
    expect(grido?.livello).toBe('error')
    expect(String(grido?.campi.msg), 'senza il numero della migrazione il 400 non è diagnosticabile')
      .toContain('20260811234334')
    senzaPercorsi()
  })

  it('le migrazioni NOMINATE nel messaggio esistono davvero in `supabase/migrations`', async () => {
    // Il messaggio manda chi indaga a cercare due file PER NOME, ed è l'unica cosa che
    // rende diagnosticabile un 400 sul documento. Il secondo file è già stato ri-datato
    // una volta durante questo stesso lavoro (`20260812120000` → `20260812194501`,
    // perché il nome deve coincidere con la versione registrata in
    // `schema_migrations`): senza questo lock, al prossimo rinomino il log manderebbe a
    // cercare un file che non c'è — cioè a concludere che il problema non c'è, che è
    // esattamente ciò che quella costante dice di voler evitare.
    h.erroreLettura = { code: 'PGRST205', message: 'Could not find the table in the schema cache' }

    await caricamentiReclamabili(db, [percorsoFinto()], OP)

    const msg = String(
      h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-assente')?.campi.msg,
    )
    const nominate = msg.match(/\d{14}_[a-z0-9_]+\.sql/g) ?? []
    expect(nominate.length, 'il messaggio non nomina nessuna migrazione').toBeGreaterThan(0)
    for (const file of nominate) {
      expect(
        existsSync(join(process.cwd(), 'supabase', 'migrations', file)),
        `il log manda a cercare ${file}, che in supabase/migrations non c'è`,
      ).toBe(true)
    }
  })

  it('registro DEGRADATO (guasto transitorio): NON blocca, ma lo dichiara', async () => {
    // Direzione opposta a quella qui sopra, e la ragione è misurabile: la tabella c'è,
    // quindi una persona vera PUÒ avere un percorso valido, e questo è un presidio in
    // più sopra il gate di forma — non deve diventare un modo nuovo di perdere
    // l'anagrafica di chi ha fatto tutto bene. Chi bussa non può provocare un `57014`.
    h.erroreLettura = { code: '57014', message: 'canceling statement due to statement timeout' }
    const fronte = percorsoFinto()
    const retro = percorsoFinto()

    const esito = await caricamentiReclamabili(db, [fronte, retro], OP)

    expect(esito.ammesso).toBe(true)
    expect(esito.assente).toBe(false)
    expect(esito.degradato).toBe(true)
    expect(esito.mancanti, 'niente è stato dimostrato mancante: non si accusa nessun campo').toEqual([])

    const nota = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-non-letto')
    expect(nota?.livello).toBe('error')
    expect(nota?.campi.error_code).toBe('57014')
    senzaPercorsi()
  })

  it('la singolare risponde ancora, e delega: una definizione sola della logica', async () => {
    const percorso = inRegistro(percorsoFinto())

    const esito = await caricamentoReclamabile(db, percorso, OP)

    expect(esito).toEqual({ ammesso: true, assente: false, degradato: false })
    // `.in()` e non `.eq()`: se la singolare avesse ancora la SUA query, questa
    // asserzione cadrebbe — ed è esattamente ciò che si vuole sapere.
    expect(h.istruzioni).toHaveLength(1)
    expect(h.istruzioni[0].percorsi).toEqual([percorso])
  })
})

// =============================================================================
describe('collegaCaricamenti · il fallimento parziale si LEGGE, non si indovina', () => {
  it('due facce, un `update` solo, nessun grido', async () => {
    const fronte = inRegistro(percorsoFinto())
    const retro = inRegistro(percorsoFinto())

    await collegaCaricamenti(db, [fronte, retro], 'pratica-nuova', OP)

    expect(h.istruzioni).toHaveLength(1)
    expect(h.istruzioni[0].modo).toBe('update')
    expect(h.istruzioni[0].percorsi).toEqual([fronte, retro])
    expect(h.registro.map((r) => r.pratica_id)).toEqual(['pratica-nuova', 'pratica-nuova'])
    expect(h.eventi, 'il caso normale non deve loggare un guasto').toHaveLength(0)
  })

  it('UNA sola faccia collegata: UNA sola riga di log, con n_attesi e n_collegati', async () => {
    // È il cuore del plurale. Con due chiamate separate qui uscivano due righe
    // scoordinate (o una sola, se l'altra chiamata era riuscita) e nessuna diceva
    // che la pratica è rimasta MEZZA documentata. Con un'istruzione sola il fatto è
    // un'aritmetica: 2 attesi, 1 collegato.
    const fronte = inRegistro(percorsoFinto())
    const retro = percorsoFinto() // mai passato dalla porta di caricamento

    await collegaCaricamenti(db, [fronte, retro], 'pratica-nuova', OP)

    const guasti = h.eventi.filter((e) => e.campi.esito === 'caricamento-non-collegato')
    expect(guasti, 'due righe per lo stesso fatto: nessuno saprebbe ricomporle').toHaveLength(1)
    expect(guasti[0].livello).toBe('error')
    // L'uuid della pratica è ciò che rende il guasto riparabile, e `redact()` lo lascia
    // passare per forma.
    expect(guasti[0].campi.entita_id).toBe('pratica-nuova')
    expect(guasti[0].campi.n_attesi).toBe(2)
    expect(guasti[0].campi.n_collegati).toBe(1)
    // Il percorso è la chiave con cui si firma la fotografia di un documento
    // d'identità, e `app_log` è interrogabile in SQL per 30 giorni.
    senzaPercorsi()
  })

  it('ZERO collegate: stessa riga sola, e dice che sono zero', async () => {
    const fronte = percorsoFinto()
    const retro = percorsoFinto()

    await collegaCaricamenti(db, [fronte, retro], 'pratica-nuova', OP)

    const guasti = h.eventi.filter((e) => e.campi.esito === 'caricamento-non-collegato')
    expect(guasti).toHaveLength(1)
    expect(guasti[0].campi.n_attesi).toBe(2)
    expect(guasti[0].campi.n_collegati).toBe(0)
    expect(String(guasti[0].campi.msg)).toContain(String(ORE_CARICAMENTO_IN_SOSPESO))
  })

  it('fronte e retro UGUALI contano una volta: nessun falso guasto', async () => {
    // La route vieta due percorsi identici, ma se cambiasse idea un `n_attesi: 2`
    // contro una riga sola griderebbe un guasto che non c'è. Il registro ha una PK
    // su `percorso`: due volte lo stesso percorso è UNA riga.
    const uno = inRegistro(percorsoFinto())

    await collegaCaricamenti(db, [uno, uno], 'pratica-nuova', OP)

    expect(h.istruzioni).toHaveLength(1)
    expect(h.eventi).toHaveLength(0)
  })

  it('elenco vuoto: nessuna istruzione, nessun log', async () => {
    await collegaCaricamenti(db, [], 'pratica-nuova', OP)

    expect(h.istruzioni, 'un `.in(percorso, [])` è un viaggio al database per nulla').toHaveLength(0)
    expect(h.eventi).toHaveLength(0)
  })

  it('registro ASSENTE: `warn`, non `error` — non c’è nessun collegamento da scrivere', async () => {
    h.erroreUpdate = { code: 'PGRST205', message: 'Could not find the table in the schema cache' }

    await collegaCaricamenti(db, [percorsoFinto()], 'pratica-nuova', OP)

    const riga = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-assente')
    expect(riga?.livello).toBe('warn')
    expect(esiti(), 'un guasto che non è un guasto').not.toContain('caricamento-non-collegato')
    senzaPercorsi()
  })

  it('la singolare delega, e resta compatibile con chi la chiama ancora', async () => {
    // `iscrizione/personale:POST` la usa su un percorso solo, e il suo log non deve
    // cambiare forma: `caricamento-non-collegato`, `error`, con l'uuid della pratica.
    await collegaCaricamento(db, percorsoFinto(), 'pratica-approvata', OP)

    expect(h.istruzioni).toHaveLength(1)
    const guasto = h.eventi.find((e) => e.campi.esito === 'caricamento-non-collegato')
    expect(guasto?.livello).toBe('error')
    expect(guasto?.campi.entita_id).toBe('pratica-approvata')
    expect(guasto?.campi.n_attesi).toBe(1)
    expect(guasto?.campi.n_collegati).toBe(0)
  })

  it('con UNA faccia sola la frase resta al SINGOLARE, per il chiamante che c’è', async () => {
    // Il plurale aveva peggiorato il messaggio proprio per l'unico chiamante in
    // produzione: «0 scansioni su 1 risultano collegate» è una frase al plurale su un
    // oggetto solo, e chi legge `app_log` alle tre di notte non deve fare l'aritmetica
    // per capire che il documento è uno. I due numeri restano nei campi; cambia la frase.
    await collegaCaricamento(db, percorsoFinto(), 'pratica-approvata', OP)

    const msg = String(
      h.eventi.find((e) => e.campi.esito === 'caricamento-non-collegato')?.campi.msg,
    )
    expect(msg).toContain('la scansione non risulta collegata alla pratica')
    expect(msg, 'una frase al plurale su un oggetto solo').not.toContain('scansioni su')
    expect(msg).toContain(String(ORE_CARICAMENTO_IN_SOSPESO))
  })
})

// =============================================================================
describe('LA FACCIA CHE NON È ARRIVATA · una stringa vuota è un percorso MANCANTE', () => {
  // ⚠️ È LA FORMA CON CUI IL CHIAMANTE PREVISTO COSTRUIRÀ L'ARRAY: due campi `file` del
  // modulo, e uno dei due può arrivare vuoto. `''` non vuol dire «niente da
  // verificare», vuol dire «il retro non c'è».
  //
  // Fino al 12/08/2026 la normalizzazione lo scartava PRIMA di contare `n_attesi`, e il
  // difetto colpiva il cuore del disegno: `caricamentiReclamabili(db, [fronte, ''], op)`
  // rispondeva `{ammesso: true, mancanti: []}` e `collegaCaricamenti(db, [fronte, ''], …)`
  // non emetteva NEMMENO UNA riga di log. L'aritmetica che secondo questo modulo
  // sostituisce la race — «n_attesi e n_collegati» — non poteva strutturalmente
  // accorgersi di una faccia mancante, perché la faccia mancante era già sparita
  // dall'aritmetica.

  it('fronte a posto e retro VUOTO: non ammesso, e dice QUALE', async () => {
    const fronte = inRegistro(percorsoFinto())

    const esito = await caricamentiReclamabili(db, [fronte, ''], OP)

    expect(esito.ammesso, 'una faccia vuota è passata per buona').toBe(false)
    expect(esito.mancanti).toEqual([1])
    expect(esito.assente).toBe(false)
    expect(esito.degradato).toBe(false)
  })

  it('spazi soli valgono vuoto, e non diventano un percorso da chiedere', async () => {
    const fronte = inRegistro(percorsoFinto())

    const esito = await caricamentiReclamabili(db, [fronte, '   '], OP)

    expect(esito.ammesso).toBe(false)
    expect(esito.mancanti).toEqual([1])
    // `.in('percorso', ['', …])` chiederebbe al registro di un percorso che non può
    // esistere: la PK non è mai vuota.
    expect(h.istruzioni[0]?.percorsi).toEqual([fronte])
  })

  it('TUTTE E DUE vuote: nessun viaggio al database, e la porta resta chiusa', async () => {
    const esito = await caricamentiReclamabili(db, ['', ''], OP)

    expect(esito.ammesso).toBe(false)
    expect(esito.mancanti, 'due facce vuote sono DUE facce mancanti').toEqual([0, 1])
    expect(h.istruzioni, 'non c’è niente da chiedere al registro').toHaveLength(0)
    // Arrivare qui vuol dire che il gate di forma di chi chiama ha lasciato passare un
    // campo vuoto: si dichiara, con i conteggi e senza percorsi.
    const nota = h.eventi.find((e) => e.campi.esito === 'faccia-senza-percorso')
    expect(nota?.livello).toBe('warn')
    expect(nota?.campi.n_attesi).toBe(2)
    expect(nota?.campi.n_vuote).toBe(2)
  })

  it('elenco VUOTO: resta un non-fatto, e non si confonde con una faccia vuota', async () => {
    // Confine da non spostare: «non mi hai chiesto niente» non è «mi hai chiesto una
    // faccia che non c'è». Chi non chiede non si vede rifiutare niente.
    const esito = await caricamentiReclamabili(db, [], OP)

    expect(esito).toEqual({ ammesso: true, assente: false, degradato: false, mancanti: [] })
    expect(h.istruzioni).toHaveLength(0)
    expect(h.eventi).toHaveLength(0)
  })

  it('guasto TRANSITORIO più una faccia vuota: il fail-open non copre la vuota', async () => {
    // Il fail-open copre ciò che non si è POTUTO verificare. Una faccia che non è mai
    // arrivata non ha bisogno del registro per essere assente, e ammetterla sarebbe il
    // difetto n. 2 di questo modulo — una pratica «completa» che punta a niente.
    h.erroreLettura = { code: '57014', message: 'canceling statement due to statement timeout' }

    const esito = await caricamentiReclamabili(db, [percorsoFinto(), ''], OP)

    expect(esito.ammesso).toBe(false)
    expect(esito.mancanti, 'si accusa solo la faccia dimostrata assente').toEqual([1])
    expect(esito.degradato).toBe(true)
    expect(esito.assente).toBe(false)

    // E il log non deve raccontare il contrario di ciò che è appena successo: il ramo
    // del guasto transitorio finiva con «e la pratica è stata accettata lo stesso»,
    // che qui è falso — la faccia vuota l'ha respinta. Un messaggio che mente su un
    // esito è peggio di nessun messaggio: è quello su cui, alle tre di notte, si
    // smette di cercare.
    const nota = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-non-letto')
    expect(String(nota?.campi.msg)).not.toContain('accettata lo stesso')
    expect(String(nota?.campi.msg)).toContain('senza percorso')
  })

  it('il SINGOLARE con la stringa vuota RIFIUTA, come faceva prima del plurale', async () => {
    // Regressione misurata su un gate che ha chiamanti in produzione: prima
    // `caricamentoReclamabile(db, '', op)` faceva `.eq('percorso','').maybeSingle()` →
    // nessuna riga → `ammesso: false`. Col plurale rispondeva `ammesso: true` senza
    // nemmeno interrogare il database. Che oggi non fosse raggiungibile dipendeva da un
    // filtro che sta in un ALTRO file (`testo()` della rotta pubblica): un gate la cui
    // tenuta vive nella disciplina di chi chiama è precisamente ciò che la migrazione di
    // questo lavoro dichiara inaccettabile.
    const esito = await caricamentoReclamabile(db, '', OP)

    expect(esito).toEqual({ ammesso: false, assente: false, degradato: false })
  })

  it('collegare una faccia vuota GRIDA, con l’aritmetica giusta', async () => {
    const fronte = inRegistro(percorsoFinto())

    await collegaCaricamenti(db, [fronte, ''], 'pratica-nuova', OP)

    const guasti = h.eventi.filter((e) => e.campi.esito === 'caricamento-non-collegato')
    expect(guasti, 'una riga sola per il fatto, come per ogni altro fallimento parziale')
      .toHaveLength(1)
    expect(guasti[0].campi.n_attesi, 'le facce chieste erano DUE').toBe(2)
    expect(guasti[0].campi.n_collegati).toBe(1)
    expect(guasti[0].campi.entita_id).toBe('pratica-nuova')
    senzaPercorsi()
  })

  it('il SINGOLARE con la stringa vuota grida, dove taceva', async () => {
    // Prima del plurale emetteva un `error` con l'`entita_id` della pratica; col
    // plurale tornava in silenzio, e il silenzio su una scansione non collegata è
    // esattamente il guasto che nessuno vede.
    await collegaCaricamento(db, '', 'pratica-nuova', OP)

    expect(h.istruzioni, 'non c’è niente da scrivere: nessun viaggio al database').toHaveLength(0)
    const guasto = h.eventi.find((e) => e.campi.esito === 'caricamento-non-collegato')
    expect(guasto?.livello).toBe('error')
    expect(guasto?.campi.entita_id).toBe('pratica-nuova')
    expect(guasto?.campi.n_attesi).toBe(1)
    expect(guasto?.campi.n_collegati).toBe(0)
  })
})

// =============================================================================
describe('facceChieste · la normalizzazione vive in UN POSTO SOLO', () => {
  // Il docstring diceva «la deduplica sta qui, in un posto solo, perché serve identica
  // alla lettura e alla scrittura», e nel momento in cui è stato scritto era già falso:
  // la funzione non era esportata, e `admin/pratiche-personale` aveva ricopiato la
  // regola — `[...new Set(percorsi)]`, senza `trim()`. Due copie divergenti alla
  // nascita. Adesso la definizione è una, ed è questa.

  it('taglia gli spazi, deduplica, e CONTA le facce vuote invece di scartarle', () => {
    const uno = percorsoFinto()

    const r = facceChieste([`  ${uno}  `, uno, '', '  '])

    expect(r.distinti, 'lo stesso percorso due volte è UNA riga: la PK è `percorso`').toEqual([uno])
    expect(r.vuote, 'gli indici delle facce arrivate senza percorso').toEqual([2, 3])
    expect(r.attese, 'un percorso ripetuto vale 1, due vuote valgono 2').toBe(3)
    expect(r.indici.get(uno), 'lo stesso percorso copre due campi del modulo').toEqual([0, 1])
  })

  it('un elenco vuoto non attende niente', () => {
    expect(facceChieste([])).toMatchObject({ distinti: [], vuote: [], attese: 0 })
  })
})

// =============================================================================
describe('registraCaricamento · l’oggetto che nasce già di proprietà', () => {
  it('senza proprietario resta in sospeso: è il caso della porta pubblica', async () => {
    const percorso = percorsoFinto()

    const esito = await registraCaricamento(db, percorso, OP)

    expect(esito).toEqual({ registrato: true, degradato: false })
    expect(h.inserts).toEqual([{ percorso }])
    expect(h.registro[0].anagrafica_utente_id).toBeNull()
  })

  it('con il proprietario, la riga nomina l’ANAGRAFICA: la porta admin', async () => {
    // Là non c'è nessuna pratica: l'oggetto appartiene a una persona già in
    // anagrafica, e nasce collegato nella stessa richiesta che carica il file.
    const percorso = percorsoFinto()
    const utente = crypto.randomUUID()

    const esito = await registraCaricamento(db, percorso, OP, { anagraficaUtenteId: utente })

    expect(esito).toEqual({ registrato: true, degradato: false })
    expect(h.inserts).toEqual([{ percorso, anagrafica_utente_id: utente }])
  })

  it('DB senza la colonna: degrada pulito (`PGRST204`), non esplode', async () => {
    // Il DB E2E della CI non è migrato, e in produzione c'è la finestra fra migrazione
    // e deploy. Qui NON si reinserisce «senza la colonna sconosciuta»: quella riga
    // sarebbe in sospeso, cioè spazzabile — vedi il trabocchetto qui sotto.
    h.colonneAssenti.add('anagrafica_utente_id')

    const esito = await registraCaricamento(db, percorsoFinto(), OP, {
      anagraficaUtenteId: crypto.randomUUID(),
    })

    expect(esito).toEqual({ registrato: false, degradato: true })
    expect(h.registro, 'una riga senza proprietario è peggio di nessuna riga').toHaveLength(0)
    const grido = h.eventi.find((e) => e.campi.esito === 'registro-caricamenti-assente')
    expect(grido?.livello).toBe('error')
    expect(grido?.campi.error_code).toBe('PGRST204')
    senzaPercorsi()
  })
})

// =============================================================================
describe('IL TRABOCCHETTO · la spazzata deve GUARDARE il secondo proprietario', () => {
  it('la scansione admin, registrata col proprietario, NON viene spazzata', async () => {
    // Il caso peggiore possibile, ed è quello che questo test esiste per impedire:
    // `anagrafica_personale` nomina un file che la spazzata ha tolto dal bucket
    // ventiquattro ore dopo. La riga NON è in sospeso — ha un proprietario — ma
    // `pratica_id` è NULL, quindi una spazzata che guardasse solo quella colonna la
    // prenderebbe. In produzione l'indice parziale conosce già entrambe le colonne
    // (`where pratica_id is null and anagrafica_utente_id is null`, misurato il
    // 12/08): un indice però non filtra, filtra la query.
    const percorso = percorsoFinto()
    await registraCaricamento(db, percorso, OP, { anagraficaUtenteId: crypto.randomUUID() })
    h.registro[0].caricato_il = oreFa(48)
    h.eventi = []

    const esito = await spazzaCaricamentiSospesi(db, OP)

    expect(h.rimozioni, 'il documento d’identità di una persona vera è uscito dal bucket').toHaveLength(0)
    expect(esito.rimossi).toBe(0)
    expect(h.registro, 'la riga che l’anagrafica usa è stata cancellata').toHaveLength(1)
  })

  it('lo stesso oggetto SENZA proprietario viene spazzato (controllo positivo)', async () => {
    // Senza questo controllo il test qui sopra sarebbe verde anche con una spazzata
    // che non spazza niente.
    const percorso = percorsoFinto()
    await registraCaricamento(db, percorso, OP)
    h.registro[0].caricato_il = oreFa(48)

    const esito = await spazzaCaricamentiSospesi(db, OP)

    expect(h.rimozioni).toHaveLength(1)
    expect(h.rimozioni[0].bucket).toBe(BUCKET_DOCUMENTI_PERSONALE)
    expect(h.rimozioni[0].percorsi).toEqual([percorso])
    expect(esito.rimossi).toBe(1)
    expect(h.registro).toHaveLength(0)
  })

  it('DB senza la colonna: la spazzata rinuncia e lo dichiara, invece di spazzare al buio', async () => {
    // Il verso in cui si sbaglia è dichiarato: su un database che non conosce il
    // secondo proprietario, «non spazzare niente» costa un po' di spazio; «spazzare
    // senza guardarlo» costa la carta d'identità di una dipendente.
    inRegistro(percorsoFinto(), oreFa(48))
    h.colonneAssenti.add('anagrafica_utente_id')

    const esito = await spazzaCaricamentiSospesi(db, OP)

    expect(h.rimozioni).toHaveLength(0)
    expect(esito.degradato).toBe(true)
    expect(esiti()).toContain('registro-caricamenti-assente')
  })
})
