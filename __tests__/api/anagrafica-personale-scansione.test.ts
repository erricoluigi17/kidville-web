// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// =============================================================================
// POST /api/admin/anagrafica-personale/scansione — LA PORTA DI CARICAMENTO ADMIN.
//
// È la porta che il commento di `admin/anagrafica-personale:PATCH` prometteva («la
// scansione si sostituisce caricandone una nuova, che è un'altra porta e ha il suo
// gate») e senza la quale l'archivio del personale non si può popolare: misurato in
// produzione il 12/08/2026, `anagrafica_personale` ha **zero righe** e gli account
// non-genitore sono **venti**.
//
// I difetti che questo file impedisce sono sette, e nessuno di loro fa rumore
// altrove:
//
//  1. LA SEGRETERIA CHIUSA FUORI. `requireStaff(request, ['admin','coordinator'])` si
//     scrive senza accorgersene copiando dalla route accanto, e chiuderebbe fuori
//     proprio chi sta al banco con il documento in mano. Il test guarda gli
//     ARGOMENTI della chiamata, non il solo esito.
//  2. IL CORPO LETTO PRIMA DEL GATE DI SEDE. Con `utenteId` nel multipart, il server
//     bufferizzerebbe fino a 4 MB spediti da uno staff di un'altra sede PRIMA di
//     sapere che non ne ha titolo. È il difetto di `primaria/fascicolo` (collaudo del
//     2026-08-02), qui misurato spiando `request.formData()`.
//  3. L'OGGETTO CHE ENTRA NEL BUCKET PRIMA DEI CONTROLLI. Un `.html` rinominato
//     `.png`, o un file da 5 MB, non devono toccare l'archivio dei documenti
//     d'identità nemmeno per un istante.
//  4. L'ORFANO INVISIBILE. Se la riga di `caricamenti_personale` non si scrive,
//     l'oggetto resta nel bucket senza che NESSUNA riga lo nomini: non è nemmeno
//     identificabile per cancellarlo su richiesta della persona.
//  5. LA SPAZZATA CHE CANCELLA UN DOCUMENTO IN SERVIZIO. La riga deve nascere con
//     `anagrafica_utente_id` valorizzato: senza, `spazzaCaricamentiSospesi` toglie
//     l'oggetto entro 24 ore mentre il fascicolo lo nomina.
//  6. LA COPIA PRECEDENTE DIMENTICATA. Sostituire la colonna senza togliere il
//     vecchio oggetto lascia nell'archivio una fotografia di carta d'identità che
//     nessuna riga nomina più — e la conservazione non la vedrà mai, perché parte
//     dalle righe.
//  7. LA CORSA FRA DUE OPERATORI. Due segreterie che sostituiscono la stessa faccia:
//     senza compare-and-swap, la seconda cancella il file della prima senza dirglielo.
//
// ⚠️ IL PERCORSO NON ESCE MAI: né nella risposta (il server lo scrive da sé, non c'è
// niente da rimandare indietro) né nei log. È la chiave con cui si firma la
// fotografia di un documento d'identità, e `app_log` è interrogabile in SQL per 30
// giorni.
// =============================================================================

type Riga = Record<string, unknown>

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  UN FILTRO PORTA IL SUO OPERATORE — e fino al 13/08/2026 non lo portava      ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * `op` è nato il 13/08/2026 da un rilievo che va scritto per intero, perché è il
 * genere di buco che rende verde un banco di prova mentre il prodotto è rotto.
 *
 * Il finto definiva `b.eq` e `b.is` come DUE LAMBDA IDENTICHE (`filtri.push({ col,
 * val })`), quindi il compare-and-swap di {@link scrivi} — `.is(colonna, null)`
 * quando la colonna è vuota, `.eq(colonna, attuale)` quando è piena — era
 * indistinguibile. La mutazione
 *
 *     const conVincolo = p.attuale === null ? base.is(p.colonna, null) : base.eq(…)
 *  →  const conVincolo = base.eq(p.colonna, p.attuale)
 *
 * lasciava **37 test su 37 verdi**. In produzione è un guasto totale: PostgREST
 * serializza `.eq(col, null)` in `col=eq.null`, cioè `col = NULL` in SQL, che con
 * la logica a tre valori **non è mai vero** — zero righe toccate, `esito: 'perso'`,
 * **409 `SCANSIONE_SOSTITUITA_ALTROVE` permanente**. E non su un caso di bordo: la
 * migrazione `20260812194501` lascia `anagrafica_personale` con ZERO righe, quindi
 * la prima faccia entra con l'INSERT e la seconda trova sempre `esiste = true` con
 * `attuale = null`. Tradotto: **«carica il retro» avrebbe smesso di funzionare per
 * tutte e venti le persone**, con un messaggio che manda a cercare un collega che
 * non esiste.
 *
 * ⚠️ NON BASTA REGISTRARE L'OPERATORE: il finto deve anche APPLICARLO diversamente,
 * altrimenti si sposta il buco di un passo. Lo fa {@link soddisfa}.
 */
type Filtro = { col: string; op: 'eq' | 'is'; val: unknown }

/**
 * Una riga soddisfa un filtro? Con la semantica di PostgREST, non con quella di
 * JavaScript — ed è tutta nel caso `null`:
 *
 *  · `is.null` → `col IS NULL` → **vero** su una colonna vuota;
 *  · `eq.null` → `col = NULL`  → **mai vero**, nemmeno su una colonna vuota.
 *
 * Sul valore pieno i due si comportano uguale: la differenza vive solo sul `null`, e
 * per questo un finto che li fondesse resterebbe verde su quasi tutto.
 *
 * `== null` e non `=== null` sul ramo `is`: una colonna non selezionata arriva
 * `undefined`, e in tabella quella colonna è comunque `NULL`.
 */
function soddisfa(r: Riga, f: Filtro): boolean {
  if (f.op === 'is') return f.val === null ? r[f.col] == null : r[f.col] === f.val
  return f.val === null ? false : r[f.col] === f.val
}

const SEDE = 'ffffffff-0000-4000-8000-00000000000f'
const ADMIN = { id: 'aaaaaaaa-1111-4000-8000-000000000001', role: 'admin', scuola_id: SEDE }
const SEGRETERIA = { id: 'bbbbbbbb-2222-4000-8000-000000000002', role: 'segreteria', scuola_id: SEDE }
const EDUCATOR = { id: 'cccccccc-3333-4000-8000-000000000003', role: 'educator', scuola_id: SEDE }
const MAESTRA = 'dddddddd-0000-4000-8000-00000000000a'

const RUOLI_DI_DEFAULT = ['admin', 'coordinator', 'segreteria']

const h = vi.hoisted(() => ({
  /** Chi bussa. Il finto gate applica su di lui la stessa lista di `requireStaff`. */
  utente: null as { id: string; role: string; scuola_id: string } | null,
  /** Le liste di ruoli con cui la rotta ha invocato il gate: è il punto 1. */
  allowedVisti: [] as (string[] | undefined)[],
  /** La risposta che `assertUtenteInScope` deve dare (null = in scope). */
  fuoriScope: false,
  /** Le righe di `anagrafica_personale`, per `utente_id`. */
  anagrafiche: [] as Riga[],
  /** L'errore che la LETTURA del fascicolo deve restituire. */
  erroreLettura: null as { code?: string; message?: string } | null,
  /** L'errore che la SCRITTURA (upsert/update) deve restituire. */
  erroreScrittura: null as { code?: string; message?: string } | null,
  /**
   * Simula la corsa: al momento dell'UPDATE la colonna vale già un'altra cosa,
   * quindi il vincolo `.eq(colonna, vecchio)` non trova nessuna riga.
   */
  corsaPersa: false,
  /**
   * LA CORSA DELLA RIGA CHE NASCE, che è l'altra e non si può simulare con `corsaPersa`.
   *
   * Fra il passo 5 (lettura: «riga assente») e il passo 12 un ALTRO operatore crea il
   * fascicolo. Il finto inietta questa riga in `h.anagrafiche` un istante prima di
   * eseguire l'INSERT, che è esattamente dove Postgres risponde `23505`. Senza questo
   * comando la finestra non è osservabile, e resta quella che ha prodotto l'orfano
   * invisibile.
   */
  rigaApparsa: null as Riga | null,
  /** Ogni scrittura vista sul fascicolo. */
  scritture: [] as { modo: 'insert' | 'upsert' | 'update'; patch: Riga; filtri: Filtro[] }[],
  /** Le letture viste sul fascicolo: colonne e filtri. */
  letture: [] as { tabella: string; cols: string; filtri: Filtro[] }[],
  /** Il registro dei caricamenti. */
  registroInserts: [] as Riga[],
  registroDelete: [] as string[],
  erroreRegistro: null as { code?: string; message?: string } | null,
  /** Lo storage. */
  uploads: [] as { bucket: string; path: string; contentType?: string; upsert?: boolean }[],
  rimozioni: [] as { bucket: string; percorsi: string[] }[],
  erroreUpload: null as unknown,
  erroreRimozione: null as unknown,
  /** I percorsi che `remove()` NON deve dichiarare usciti (restano nel bucket). */
  nonUsciti: [] as string[],
  /**
   * LA CRONOLOGIA dei fatti osservabili, nell'ordine in cui sono accaduti.
   *
   * Serve a una prova sola e non sostituibile: che la colonna nomini il file NUOVO
   * PRIMA che il vecchio esca dall'archivio. Guardando solo lo stato finale, i due
   * ordini sono indistinguibili — ed è l'ordine sbagliato a lasciare, se la scrittura
   * fallisce, il fascicolo di una persona in servizio che punta al nulla.
   */
  cronologia: [] as string[],
  /** Log. */
  eventi: [] as { evento: string; livello: string; campi: Riga }[],
  errori: [] as unknown[][],
  audit: [] as Riga[],
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (evento: string, livello: string, campi: Riga) => {
    h.eventi.push({ evento, livello, campi })
  },
  logErrore: (...a: unknown[]) => {
    h.errori.push(a)
  },
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  /**
   * Il finto gate applica DAVVERO la lista di ruoli che la rotta gli passa, col
   * default di `requireStaff`. Così «educator ⇒ 403» non è una risposta cablata nel
   * mock: è la conseguenza della stessa lista che il gate vero userebbe.
   */
  requireStaff: async (_req: unknown, allowed?: string[]) => {
    h.allowedVisti.push(allowed)
    const lista = allowed ?? RUOLI_DI_DEFAULT
    if (!h.utente) return { response: NextResponse.json({ error: 'non autenticato' }, { status: 401 }) }
    if (!lista.includes(h.utente.role)) {
      return { response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }) }
    }
    return { user: h.utente }
  },
}))

vi.mock('@/lib/auth/scope', () => ({
  assertUtenteInScope: async () =>
    h.fuoriScope ? NextResponse.json({ error: 'Utente fuori dal tuo plesso' }, { status: 403 }) : null,
}))

vi.mock('@/lib/audit/scrittura', () => ({
  logScrittura: async (_c: unknown, input: Riga) => {
    h.audit.push(input)
  },
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => finto(),
  createClient: async () => finto(),
}))

function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

function finto() {
  return {
    from(tabella: string) {
      const filtri: Filtro[] = []
      let cols = '*'
      let modo: 'select' | 'upsert' | 'update' | 'insert' | 'delete' = 'select'
      let patch: Riga = {}

      const esegui = (): { data: unknown; error: unknown } => {
        if (tabella === 'caricamenti_personale') {
          if (modo === 'insert') return { data: null, error: h.erroreRegistro }
          if (modo === 'delete') {
            for (const f of filtri) if (f.col === 'percorso') h.registroDelete.push(String(f.val))
            return { data: null, error: null }
          }
          return { data: [], error: null }
        }
        if (tabella !== 'anagrafica_personale') throw new Error(`tabella non prevista: ${tabella}`)

        if (modo === 'select') {
          h.letture.push({ tabella, cols, filtri: filtri.map((f) => ({ ...f })) })
          if (h.erroreLettura) return { data: null, error: h.erroreLettura }
          const trovate = h.anagrafiche.filter((r) => filtri.every((f) => soddisfa(r, f)))
          return { data: trovate.map((r) => proietta(r, cols)), error: null }
        }

        h.scritture.push({
          modo: modo as 'insert' | 'upsert' | 'update',
          patch: { ...patch },
          filtri: filtri.map((f) => ({ ...f })),
        })
        h.cronologia.push(`fascicolo:${modo}`)
        if (h.erroreScrittura) return { data: null, error: h.erroreScrittura }

        if (modo === 'insert') {
          // LA CORSA: la riga compare fra il passo 5 e questo INSERT. Si inietta QUI,
          // dentro l'esecuzione, perché è l'unico punto in cui il tempo del finto
          // coincide col tempo vero — la lettura è già avvenuta, la scrittura non
          // ancora.
          if (h.rigaApparsa) {
            h.anagrafiche.push({ ...h.rigaApparsa })
            h.rigaApparsa = null
          }
          const chiave = patch.utente_id
          if (h.anagrafiche.some((r) => r.utente_id === chiave)) {
            // Lo stesso codice che dà Postgres, e con esso il fatto che conta: **la
            // riga esistente NON è stata toccata**. Un finto che qui sovrascrivesse
            // renderebbe verde proprio la sostituzione che il `23505` impedisce.
            return {
              data: null,
              error: { code: '23505', message: 'duplicate key value violates unique constraint' },
            }
          }
          h.anagrafiche.push({ ...patch })
          return { data: [{ utente_id: chiave }], error: null }
        }

        if (modo === 'upsert') {
          const chiave = patch.utente_id
          const esistente = h.anagrafiche.find((r) => r.utente_id === chiave)
          if (esistente) Object.assign(esistente, patch)
          else h.anagrafiche.push({ ...patch })
          return { data: [{ utente_id: chiave }], error: null }
        }

        // UPDATE: il compare-and-swap vive QUI, ed è ciò che il finto deve saper
        // sbagliare. Con `h.corsaPersa` nessuna riga soddisfa il vincolo sul valore
        // attuale della colonna — che è esattamente ciò che succede quando qualcun
        // altro l'ha sostituita nel frattempo.
        // ⚠️ IL PREDICATO È {@link soddisfa}, con la semantica di PostgREST: qui un
        // `.eq(col, null)` deve trovare ZERO righe anche su una colonna vuota. Prima
        // del 13/08/2026 questa riga trattava `val === null` come «is null»
        // qualunque fosse l'operatore, ed è ciò che rendeva verde la mutazione
        // `.is → .eq` descritta su {@link Filtro}.
        const toccate = h.corsaPersa ? [] : h.anagrafiche.filter((r) => filtri.every((f) => soddisfa(r, f)))
        for (const r of toccate) Object.assign(r, patch)
        return { data: toccate.map((r) => ({ utente_id: r.utente_id })), error: null }
      }

      const b: Record<string, unknown> = {}
      b.select = (c?: string) => { if (typeof c === 'string') cols = c; return b }
      // I DUE OPERATORI SONO DIVERSI, e la differenza si registra: vedi {@link Filtro}.
      b.eq = (col: string, val: unknown) => { filtri.push({ col, op: 'eq', val }); return b }
      b.is = (col: string, val: unknown) => { filtri.push({ col, op: 'is', val }); return b }
      b.in = () => b
      b.limit = () => b
      b.order = () => b
      b.insert = (r: Riga) => {
        modo = 'insert'
        patch = r
        // Il registro dei caricamenti si spia all'invocazione (la sua riga interessa
        // anche quando la query poi fallisce); il fascicolo si valuta in `esegui()`.
        if (tabella === 'caricamenti_personale') h.registroInserts.push({ ...r })
        return b
      }
      b.delete = () => { modo = 'delete'; return b }
      b.upsert = (r: Riga) => { modo = 'upsert'; patch = r; return b }
      b.update = (r: Riga) => { modo = 'update'; patch = r; return b }
      b.maybeSingle = async () => { const r = esegui(); return { data: (r.data as Riga[] | null)?.[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: (r.data as Riga[] | null)?.[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _corpo: unknown, opzioni?: { contentType?: string; upsert?: boolean }) => {
          h.uploads.push({ bucket, path, contentType: opzioni?.contentType, upsert: opzioni?.upsert })
          return { error: h.erroreUpload }
        },
        remove: async (percorsi: string[]) => {
          h.rimozioni.push({ bucket, percorsi: [...percorsi] })
          for (const p of percorsi) h.cronologia.push(`rimozione:${p}`)
          if (h.erroreRimozione) return { data: null, error: h.erroreRimozione }
          const usciti = percorsi.filter((p) => !h.nonUsciti.includes(p))
          return { data: usciti.map((p) => ({ name: p })), error: null }
        },
        list: async (cartella: string, opzioni?: { search?: string }) => {
          const nome = opzioni?.search ?? ''
          const presente = h.nonUsciti.includes(`${cartella}/${nome}`)
          return { data: presente ? [{ name: nome }] : [], error: null }
        },
      }),
    },
  }
}

import { POST } from '@/app/api/admin/anagrafica-personale/scansione/route'
import { resetRateLimit } from '@/lib/security/rate-limit'
import { COLONNE_DOCUMENTO } from '@/lib/personale/percorso-documento'
import { LIMITE_UPLOAD_BYTE } from '@/lib/upload/limite-piattaforma'

const URL_ROUTE = 'http://localhost/api/admin/anagrafica-personale/scansione'

/** Un file di byte VERI: la richiesta viaggia in multipart e una taglia finta si perderebbe. */
const fileDa = (nome: string, tipo: string, byte = 32): File =>
  new File([Buffer.alloc(byte, 0x78)], nome, { type: tipo })

const documento = () => fileDa('carta-identita-prova.pdf', 'application/pdf')

/**
 * Una richiesta con la spia su `formData()`: è così che si misura il punto 2 — «il
 * corpo non è stato nemmeno letto» — invece di dedurlo dallo stato HTTP.
 */
function richiesta(
  file: File | null,
  qs = `?utenteId=${MAESTRA}&lato=fronte`,
): Request & { corpoLetto: () => boolean } {
  const fd = new FormData()
  if (file) fd.append('file', file)
  const req = new Request(`${URL_ROUTE}${qs}`, { method: 'POST', body: fd })
  const vero = req.formData.bind(req)
  let letto = false
  Object.defineProperty(req, 'formData', {
    value: () => { letto = true; return vero() },
    configurable: true,
  })
  return Object.assign(req, { corpoLetto: () => letto })
}

const chiama = (r: Request) => POST(r as never)

/** Un percorso nella forma che la porta pubblica produce: serve come «vecchio». */
const percorsoFinto = () => `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.pdf`

/** Il fascicolo di `MAESTRA`, con le due facce come si vogliono. */
function fascicolo(fronte: string | null = null, retro: string | null = null): Riga {
  return { utente_id: MAESTRA, documento_fronte_path: fronte, documento_retro_path: retro }
}

const rigaMaestra = () => h.anagrafiche.find((r) => r.utente_id === MAESTRA)

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = ADMIN
  h.allowedVisti = []
  h.fuoriScope = false
  h.anagrafiche = []
  h.erroreLettura = null
  h.erroreScrittura = null
  h.corsaPersa = false
  h.rigaApparsa = null
  h.scritture = []
  h.letture = []
  h.registroInserts = []
  h.registroDelete = []
  h.erroreRegistro = null
  h.uploads = []
  h.rimozioni = []
  h.erroreUpload = null
  h.erroreRimozione = null
  h.nonUsciti = []
  h.cronologia = []
  h.eventi = []
  h.errori = []
  h.audit = []
  resetRateLimit()
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST admin/anagrafica-personale/scansione · il gate', () => {
  it('la SEGRETERIA carica: 200, e il gate è quello di default (non `[admin, coordinator]`)', async () => {
    h.utente = SEGRETERIA
    const res = await chiama(richiesta(documento()))

    expect(res.status, 'la segreteria — chi sta al banco — non può caricare la scansione').toBe(200)
    // ⚠️ L'ASSERZIONE CHE CONTA non è il 200: è che la rotta NON abbia ristretto la
    // lista. Con `['admin','coordinator']` scritto a mano il test sopra sarebbe rosso,
    // ma con qualunque altro ruolo di prova resterebbe verde — e la segreteria
    // resterebbe fuori senza che nessuno lo veda.
    expect(h.allowedVisti).toEqual([undefined])
  })

  it('un `educator` non entra: 403 e niente nel bucket', async () => {
    h.utente = EDUCATOR
    const res = await chiama(richiesta(documento()))
    expect(res.status).toBe(403)
    expect(h.uploads).toHaveLength(0)
  })

  it('l’anonimo non entra: 401', async () => {
    h.utente = null
    expect((await chiama(richiesta(documento()))).status).toBe(401)
    expect(h.uploads).toHaveLength(0)
  })

  it('bersaglio di UN’ALTRA SEDE: 403 — e il corpo NON è stato nemmeno letto', async () => {
    // È il punto 2, e si misura sulla spia: senza `utenteId` in query il server
    // bufferizzerebbe fino a 4 MB prima di sapere che chi bussa non ne ha titolo.
    h.fuoriScope = true
    const req = richiesta(documento())
    const res = await chiama(req)

    expect(res.status).toBe(403)
    expect(
      req.corpoLetto(),
      'il multipart è stato letto prima del gate di sede: 4 MB da uno staff di un’altra sede ' +
        'arrivano al server prima del diniego (lock `corpo-letto-dopo-il-gate`)',
    ).toBe(false)
    expect(h.uploads).toHaveLength(0)
  })

  it('`utenteId` che non è un uuid, o `lato` inventato: 400 e nessun caricamento', async () => {
    expect((await chiama(richiesta(documento(), '?utenteId=pippo&lato=fronte'))).status).toBe(400)
    expect((await chiama(richiesta(documento(), `?utenteId=${MAESTRA}&lato=sinistra`))).status).toBe(400)
    expect((await chiama(richiesta(documento(), `?utenteId=${MAESTRA}`))).status).toBe(400)
    expect(h.uploads).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST admin/anagrafica-personale/scansione · ciò che non deve entrare nel bucket', () => {
  it('5 MB: 413, e l’archivio dei documenti d’identità non viene toccato', async () => {
    const grosso = fileDa('scansione.pdf', 'application/pdf', LIMITE_UPLOAD_BYTE + 1)
    const res = await chiama(richiesta(grosso))

    expect(res.status).toBe(413)
    expect((await res.json()).codice).toBe('ALLEGATO_OLTRE_LIMITE_PIATTAFORMA')
    expect(h.uploads, 'un file oltre il limite è entrato nel bucket').toHaveLength(0)
    expect(h.registroInserts).toHaveLength(0)
  })

  it('un `.html` rinominato `.png`: 415, e nessun oggetto nel bucket', async () => {
    // Il tipo dichiarato dal client non è una prova: l'estensione dice `png` e il
    // tipo dice `text/html`, quindi non concordano e il gate condiviso respinge.
    const finto = fileDa('innocuo.png', 'text/html')
    const res = await chiama(richiesta(finto))

    expect(res.status).toBe(415)
    expect((await res.json()).codice).toBe('ALLEGATO_PDF_O_IMMAGINE')
    expect(h.uploads).toHaveLength(0)
    expect(h.registroInserts).toHaveLength(0)
  })

  it('nessun file nel multipart: 400', async () => {
    expect((await chiama(richiesta(null))).status).toBe(400)
    expect(h.uploads).toHaveLength(0)
  })

  it('richiesta non multipart: 400 e non 500 (è un errore del CLIENT)', async () => {
    const req = new Request(`${URL_ROUTE}?utenteId=${MAESTRA}&lato=fronte`, {
      method: 'POST',
      body: '{"file":"eccolo"}',
      headers: { 'content-type': 'application/json' },
    })
    expect((await chiama(req)).status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST admin/anagrafica-personale/scansione · il percorso felice', () => {
  it('persona SENZA anagrafica: 200, la riga NASCE e la colonna del fronte è scritta', async () => {
    // È il caso normale del primo giorno: in produzione `anagrafica_personale` ha
    // zero righe e venti persone in servizio. Un UPDATE risponderebbe «fatto» senza
    // scrivere niente proprio qui.
    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(200)
    // ⚠️ `insert` e NON `upsert`: un upsert su `utente_id` fonderebbe la propria riga
    // sopra quella che un altro operatore potrebbe aver creato nel frattempo, e il
    // passo 13 — che lavora su `vecchio`, qui `null` — non toglierebbe la sua copia
    // dall'archivio. Vedi la testata di `scrivi`.
    expect(h.scritture.at(-1)?.modo).toBe('insert')
    const riga = rigaMaestra()
    expect(riga, 'la riga di anagrafica non è stata creata').toBeTruthy()
    expect(String(riga?.documento_fronte_path)).toBe(h.uploads[0].path)
    expect(riga?.documento_retro_path ?? null, 'l’altra faccia è stata toccata').toBeNull()
  })

  it('`lato=retro` scrive l’ALTRA colonna, e non tocca il fronte', async () => {
    const fronte = percorsoFinto()
    h.anagrafiche = [fascicolo(fronte, null)]
    const res = await chiama(richiesta(documento(), `?utenteId=${MAESTRA}&lato=retro`))

    expect(res.status).toBe(200)
    expect(rigaMaestra()?.documento_fronte_path).toBe(fronte)
    expect(rigaMaestra()?.documento_retro_path).toBe(h.uploads[0].path)
  })

  it('il percorso ha la forma della porta pubblica, e il NOME del file non sopravvive', async () => {
    // Stessa forma = un gate di forma solo e un `check (… like 'documenti/%')` solo,
    // validi per tutte e due le porte. E «carta-identita-<cognome>.pdf» è il cognome
    // di una persona: non deve finire in una colonna né in un URL firmato.
    await chiama(richiesta(fileDa('carta-identita-prova.pdf', 'application/pdf')))
    const path = h.uploads[0].path
    expect(path).toMatch(
      /^documenti\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/,
    )
    for (const frammento of ['carta', 'identita', 'prova']) {
      expect(path, `il nome del file è sopravvissuto nel percorso («${frammento}»)`).not.toContain(frammento)
    }
  })

  it('il bucket è quello del personale, `upsert:false`, e il tipo viene dal gate', async () => {
    await chiama(richiesta(fileDa('DOCUMENTO.JPEG', 'image/jpeg')))
    expect(h.uploads[0].bucket).toBe('documenti_personale')
    expect(h.uploads[0].bucket).not.toBe('form_attachments')
    expect(h.uploads[0].upsert).toBe(false)
    expect(h.uploads[0].contentType).toBe('image/jpeg')
    // L'estensione la decide il TIPO, non il nome: un formato, una scrittura sola.
    expect(h.uploads[0].path.endsWith('.jpg')).toBe(true)
  })

  it('la riga di registro nasce GIÀ di proprietà dell’anagrafica', async () => {
    // Senza `anagrafica_utente_id` la riga sarebbe «in sospeso» e la spazzata
    // toglierebbe il documento di una dipendente in servizio entro 24 ore, mentre il
    // fascicolo lo nomina ancora.
    await chiama(richiesta(documento()))
    expect(h.registroInserts).toHaveLength(1)
    expect(h.registroInserts[0].percorso).toBe(h.uploads[0].path)
    expect(
      h.registroInserts[0].anagrafica_utente_id,
      'la riga nasce senza proprietario: la spazzata la cancellerà entro 24 ore',
    ).toBe(MAESTRA)
  })

  it('la risposta NON contiene il percorso: qui non c’è niente da rimandare indietro', async () => {
    const res = await chiama(richiesta(documento()))
    const corpo = await res.text()
    expect(JSON.parse(corpo)).toEqual({ success: true })
    expect(corpo).not.toContain('documenti/')
  })

  it('l’audit dice CHE COSA è stato fatto, e non il percorso', async () => {
    await chiama(richiesta(documento()))
    expect(h.audit).toHaveLength(1)
    expect(h.audit[0].entitaTipo).toBe('anagrafica_personale')
    expect(h.audit[0].entitaId).toBe(MAESTRA)
    expect(JSON.stringify(h.audit[0]), 'il percorso è finito nel registro IMMUTABILE').not.toContain('documenti/')
  })

  it('il SUCCESSO si logga, con `lato` in una chiave che la redazione lascia passare', async () => {
    await chiama(richiesta(documento()))
    const riga = h.eventi.find((e) => e.campi.esito === 'scansione-caricata')
    expect(riga, 'nessun log di successo: «nessun log» non distinguerebbe «va tutto bene» da «non parte niente»').toBeTruthy()
    expect(riga?.livello).toBe('info')
    expect(riga?.campi.azione).toBe('scansione-fronte')
    expect(riga?.campi.bucket).toBe('documenti_personale')
    expect(riga?.campi.entita_id).toBe(MAESTRA)
  })

  it('NESSUN log della richiesta riuscita contiene un percorso', async () => {
    await chiama(richiesta(documento()))
    const testo = JSON.stringify(h.eventi) + JSON.stringify(h.errori)
    expect(testo, 'un percorso nei log è la chiave che apre un documento d’identità, per 30 giorni in SQL').not.toContain('documenti/')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST admin/anagrafica-personale/scansione · la SOSTITUZIONE', () => {
  it('la colonna passa al nuovo percorso E il VECCHIO oggetto esce dal bucket', async () => {
    const vecchio = percorsoFinto()
    h.anagrafiche = [fascicolo(vecchio, null)]

    const res = await chiama(richiesta(documento()))
    expect(res.status).toBe(200)

    const nuovo = h.uploads[0].path
    expect(rigaMaestra()?.documento_fronte_path).toBe(nuovo)
    expect(
      h.rimozioni.flatMap((r) => r.percorsi),
      'la copia precedente è rimasta nell’archivio: una fotografia di documento d’identità che nessuna riga nomina più',
    ).toContain(vecchio)
    // E la sua riga di registro esce con lei: un registro che nomina un file
    // inesistente impedisce di riusare quel percorso e non serve a nessuno.
    expect(h.registroDelete).toContain(vecchio)
  })

  it('il VECCHIO esce DOPO che la colonna nomina il nuovo, mai prima', async () => {
    // L'ordine è l'opposto di `retention-personale` («prima i file, poi le righe»)
    // perché qui la riga RESTA: se il file uscisse prima e la scrittura fallisse, il
    // fascicolo di una persona in servizio punterebbe al nulla. Guardando solo lo
    // stato finale i due ordini sono indistinguibili — per questo il finto tiene una
    // cronologia.
    const vecchio = percorsoFinto()
    h.anagrafiche = [fascicolo(vecchio, null)]

    await chiama(richiesta(documento()))

    const scritta = h.cronologia.indexOf('fascicolo:update')
    const tolta = h.cronologia.indexOf(`rimozione:${vecchio}`)
    expect(scritta, 'il fascicolo non è stato scritto').toBeGreaterThanOrEqual(0)
    expect(tolta, 'la copia precedente non è stata tolta').toBeGreaterThanOrEqual(0)
    expect(
      scritta < tolta,
      'la copia precedente è uscita dall’archivio PRIMA che la colonna nominasse la nuova: ' +
        'se la scrittura fallisse, il fascicolo punterebbe a un file che non esiste',
    ).toBe(true)

    // E il compare-and-swap c'era: l'UPDATE portava il vincolo sul valore ATTUALE,
    // con `eq` — su una colonna PIENA è `is` a essere l'operatore sbagliato.
    const update = h.scritture.find((s) => s.modo === 'update')
    expect(
      update?.filtri.some((f) => f.col === 'documento_fronte_path' && f.op === 'eq' && f.val === vecchio),
    ).toBe(true)
  })

  it('la sostituzione ha un `esito` suo nel log: «caricata» e «sostituita» non sono lo stesso fatto', async () => {
    h.anagrafiche = [fascicolo(percorsoFinto(), null)]
    await chiama(richiesta(documento()))
    expect(h.eventi.some((e) => e.campi.esito === 'scansione-sostituita')).toBe(true)
    expect(h.eventi.some((e) => e.campi.esito === 'scansione-caricata')).toBe(false)
  })

  it('la colonna VUOTA non è una sostituzione: nessuna rimozione, e il vincolo è `is null`', async () => {
    h.anagrafiche = [fascicolo(null, percorsoFinto())]
    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(200)
    expect(h.rimozioni, 'si è tolto dal bucket un file che questa faccia non nominava').toHaveLength(0)
    const update = h.scritture.find((s) => s.modo === 'update')
    // ⚠️ L'OPERATORE FA PARTE DELL'ASSERZIONE, e fino al 13/08/2026 non ne faceva
    // parte: il titolo di questo test prometteva «`is null`» mentre la misura
    // guardava il solo valore, che `eq` e `is` hanno identico. Vedi {@link Filtro}.
    expect(
      update?.filtri.some((f) => f.col === 'documento_fronte_path' && f.op === 'is' && f.val === null),
      'il vincolo non è `is null`: `.eq(col, null)` in SQL è `col = NULL`, che non è mai vero',
    ).toBe(true)
    // …e nessun `eq` su quella colonna: il vincolo è UNO, non due sovrapposti.
    expect(update?.filtri.some((f) => f.col === 'documento_fronte_path' && f.op === 'eq')).toBe(false)
    // La colonna ha davvero preso il nuovo percorso: senza questo, un vincolo che
    // non trova nessuna riga si confonderebbe con una scrittura riuscita.
    expect(String(rigaMaestra()?.documento_fronte_path)).toBe(h.uploads[0].path)
  })

  // ── IL PERCORSO PIÙ COMUNE DI TUTTI, ed è quello che la mutazione spegneva ────
  //
  // In produzione `anagrafica_personale` ha ZERO righe (misurato il 12/08/2026):
  // la PRIMA faccia nasce con l'INSERT, la SECONDA trova sempre la riga con la
  // propria colonna vuota. Cioè il ramo `is null` non è un caso di bordo: è la
  // strada di ogni «carica il retro» del primo giorno, venti persone su venti.
  it('🔴 la SECONDA faccia entra sulla riga appena nata: 200, non un 409 che accusa un collega inesistente', async () => {
    const fronte = percorsoFinto()
    h.anagrafiche = [fascicolo(fronte, null)]

    const res = await chiama(richiesta(documento(), `?utenteId=${MAESTRA}&lato=retro`))

    expect(res.status, 'la seconda faccia risponde 409: `col = NULL` non trova mai la riga').toBe(200)
    expect(String(rigaMaestra()?.documento_retro_path)).toBe(h.uploads[0].path)
    // Il fronte del collega non è stato toccato né tolto dall'archivio.
    expect(rigaMaestra()?.documento_fronte_path).toBe(fronte)
    expect(h.rimozioni).toHaveLength(0)
  })

  // ── LA COLONNA CHE CONTIENE `''`: un 409 permanente che accusava un collega ─────
  //
  // Il `check` della migrazione `20260812194501` è `is null or length(…) <= 200`:
  // AMMETTE la stringa vuota. Fino al 13/08/2026 `leggiStato` la normalizzava a `null`
  // lasciando però `esiste = true`, quindi il vincolo diventava `.is(colonna, null)` —
  // che in SQL **non matcha `''`**. Zero righe toccate ⇒ `esito: 'perso'` ⇒ 409
  // «questa scansione è stata sostituita da qualcun altro nel frattempo», **per
  // sempre**, su una faccia che nessuno aveva toccato e con un messaggio che manda a
  // cercare un collega che non esiste.
  //
  // Misurato in produzione il 13/08/2026: zero righe con `''` su entrambe le tabelle,
  // quindi era latente. Un difetto latente è un difetto che aspetta il primo dato che
  // lo attiva, e questa è la riga che gli toglie l'attesa.
  it.each([
    ['stringa vuota', ''],
    ['soli spazi', '   '],
  ])('🔴 colonna a %s: si scrive (200), NON un 409 che accusa un collega inesistente', async (_nome, valore) => {
    h.anagrafiche = [fascicolo(valore, null)]

    const res = await chiama(richiesta(documento()))

    expect(res.status, 'un 409 permanente su una faccia che nessuno ha toccato').toBe(200)
    // Il vincolo di compare-and-swap deve confrontare il valore GREZZO con `eq`, non
    // `is null`: è la sola forma che in SQL trova quella riga.
    const update = h.scritture.find((s) => s.modo === 'update')
    expect(
      update?.filtri.some((f) => f.col === 'documento_fronte_path' && f.op === 'eq' && f.val === valore),
      '`.is(colonna, null)` non trova mai una colonna che contiene la stringa vuota',
    ).toBe(true)
    expect(String(rigaMaestra()?.documento_fronte_path)).toBe(h.uploads[0].path)

    // ── E `vecchio` È NORMALIZZATO: `'   '` NON È UN FILE DA TOGLIERE ──────────
    //
    // ⚠️ `h.rimozioni` vuoto NON basta a misurarlo, ed è il rilievo del 13/08/2026:
    // `rimuoviEVerifica` (`@/lib/storage/rimozione-verificata`) fa `trim()` e scarta
    // le stringhe vuote per conto suo, quindi il `remove(['   '])` sarebbe comunque
    // impedito da un ALTRO modulo. Con `const vecchio = attuale` — cioè senza la
    // normalizzazione di `leggiStato` — `togliVecchia` verrebbe invocata lo stesso, e
    // le sue DUE conseguenze si vedono qui e non nel bucket:
    //
    //  · un `delete` su `caricamenti_personale where percorso = '   '`, che toglie
    //    dal registro una riga di cui nessuno sa niente;
    //  · e soprattutto `esito: 'scansione-precedente-rimossa'`, cioè — parole del
    //    commento che quella riga porta — «la sola prova che la copia sostituita esce
    //    davvero dall'archivio», scritta per una rimozione che non è mai partita.
    //    Un log che certifica un fatto non avvenuto è peggio di nessun log.
    expect(h.rimozioni, 'si è chiesto allo storage di rimuovere una stringa vuota').toHaveLength(0)
    expect(
      h.registroDelete,
      'si è cancellata dal registro dei caricamenti una riga il cui percorso è vuoto',
    ).toHaveLength(0)
    expect(
      h.eventi.some((e) => e.campi.esito === 'scansione-precedente-rimossa'),
      'il log dichiara rimossa una copia precedente che non esisteva: la colonna conteneva spazi',
    ).toBe(false)
  })

  // ── LA FINESTRA FRA IL PASSO 5 E IL PASSO 12, e l'orfano che ci nasceva ────────
  //
  // Due operatori aprono la scheda della stessa persona SENZA fascicolo: entrambi
  // leggono «riga assente». Il primo arriva in fondo e crea la riga. Il secondo, con
  // l'`upsert` che qui c'era fino al 13/08/2026, fondeva la propria sopra quella —
  // e il passo 13 non toglieva niente, perché il suo `vecchio` era `null`.
  //
  // Il file del primo restava nel bucket **senza nessuna colonna che lo nominasse**, e
  // fuori dalla portata di `spazzaCaricamentiSospesi`, che raccoglie solo le righe
  // senza proprietario: la sua ha `anagrafica_utente_id`. È letteralmente l'orfano
  // invisibile che il passo 11 dichiara di esistere per impedire, prodotto dal passo 12.
  it('🔴 la riga NASCE mentre carico, sulla STESSA faccia: 409 e il file del collega resta al suo posto', async () => {
    const suo = percorsoFinto()
    h.rigaApparsa = fascicolo(suo, null)

    const res = await chiama(richiesta(documento()))
    const mio = h.uploads[0].path

    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SCANSIONE_SOSTITUITA_ALTROVE')
    // LA PROVA CHE CONTA: la colonna nomina ANCORA il file del collega…
    expect(rigaMaestra()?.documento_fronte_path).toBe(suo)
    // …il suo oggetto non è stato toccato…
    expect(
      h.rimozioni.flatMap((r) => r.percorsi),
      'il file del collega è uscito dall’archivio senza che nessuno glielo dicesse',
    ).not.toContain(suo)
    // …e il MIO è stato ritirato, insieme alla sua riga di registro: nessun oggetto
    // resta nel bucket senza una colonna che lo nomini.
    expect(h.rimozioni.flatMap((r) => r.percorsi)).toContain(mio)
    expect(h.registroDelete).toContain(mio)
  })

  it('🔴 la riga NASCE mentre carico, sull’ALTRA faccia: la mia si scrive lo stesso (nessun 409 a vuoto)', async () => {
    // L'altra metà della stessa finestra, e senza questa prova la correzione potrebbe
    // essere «rispondi sempre 409 quando la riga appare»: sicura e inutilizzabile —
    // due operatori che caricano fronte e retro della stessa persona si bloccherebbero
    // a vicenda. Il testimone del compare-and-swap è «questa colonna non aveva niente»,
    // e sul retro del collega quella condizione è ancora vera.
    const suoRetro = percorsoFinto()
    h.rigaApparsa = fascicolo(null, suoRetro)

    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(200)
    expect(String(rigaMaestra()?.documento_fronte_path)).toBe(h.uploads[0].path)
    expect(rigaMaestra()?.documento_retro_path, 'il retro del collega è stato sovrascritto').toBe(suoRetro)
    expect(h.rimozioni, 'si è tolto dall’archivio un file che il fascicolo nomina').toHaveLength(0)
  })

  it('se il vecchio NON esce davvero, la richiesta riesce ma il fatto si GRIDA', async () => {
    // `remove()` non fallisce sui percorsi che non escono: guardare solo `error`
    // farebbe passare per successo uno «zero file rimossi su uno».
    const vecchio = percorsoFinto()
    h.anagrafiche = [fascicolo(vecchio, null)]
    h.nonUsciti = [vecchio]

    const res = await chiama(richiesta(documento()))
    expect(res.status, 'un guasto della pulizia è diventato un caricamento fallito').toBe(200)
    const grido = h.eventi.find((e) => e.campi.esito === 'scansione-precedente-non-rimossa')
    expect(grido?.livello).toBe('error')
    expect(String(grido?.campi.msg)).toContain('nessuna riga la nomina')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST admin/anagrafica-personale/scansione · quando qualcosa non collabora', () => {
  it('registro NON scrivibile: l’oggetto si RITIRA, 500, e la colonna resta com’era', async () => {
    const vecchio = percorsoFinto()
    h.anagrafiche = [fascicolo(vecchio, null)]
    h.erroreRegistro = { code: 'XX000', message: 'registro giù' }

    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ALLEGATO_NON_CARICATO')
    const nuovo = h.uploads[0].path
    expect(
      h.rimozioni.flatMap((r) => r.percorsi),
      'un oggetto senza riga di registro è l’orfano invisibile: nessuno sa di averlo',
    ).toContain(nuovo)
    expect(rigaMaestra()?.documento_fronte_path, 'il fascicolo è stato aggiornato con un oggetto non registrato').toBe(vecchio)
    expect(h.rimozioni.flatMap((r) => r.percorsi), 'è stato tolto il vecchio invece del nuovo').not.toContain(vecchio)
  })

  it('CORSA PERSA: 409 col codice nuovo, oggetto ritirato, colonna invariata', async () => {
    const vecchio = percorsoFinto()
    h.anagrafiche = [fascicolo(vecchio, null)]
    h.corsaPersa = true

    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('SCANSIONE_SOSTITUITA_ALTROVE')
    const nuovo = h.uploads[0].path
    expect(h.rimozioni.flatMap((r) => r.percorsi)).toContain(nuovo)
    expect(h.registroDelete, 'la riga di registro del nuovo oggetto è rimasta a nominare un file ritirato').toContain(nuovo)
    expect(
      h.rimozioni.flatMap((r) => r.percorsi),
      'sovrascrivere avrebbe cancellato il file appena caricato da un collega',
    ).not.toContain(vecchio)
    expect(rigaMaestra()?.documento_fronte_path).toBe(vecchio)
  })

  it('scrittura del fascicolo in errore: 503, oggetto ritirato, colonna invariata', async () => {
    h.anagrafiche = [fascicolo(null, null)]
    h.erroreScrittura = { code: 'XX000', message: 'giù' }

    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SCANSIONE_NON_REGISTRATA')
    expect(h.rimozioni.flatMap((r) => r.percorsi)).toContain(h.uploads[0].path)
    expect(rigaMaestra()?.documento_fronte_path ?? null).toBeNull()
  })

  it('lo Storage rifiuta il caricamento: 500, e il messaggio del fornitore resta nel LOG', async () => {
    h.erroreUpload = { message: 'mime type text/plain is not supported' }
    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('mime type')
    expect(h.errori.length).toBeGreaterThan(0)
    expect(h.registroInserts, 'si è registrato un oggetto che nel bucket non è entrato').toHaveLength(0)
  })

  it.each([
    ['tabella assente', '42P01'],
    ['tabella sconosciuta a PostgREST', 'PGRST205'],
    ['colonna assente', '42703'],
  ])('DB non migrato (%s): 503 e ZERO chiamate allo storage', async (_nome, code) => {
    // È lo stato del DB E2E della CI. La lettura sta PRIMA del bucket proprio per
    // questo: fallire senza aver caricato niente.
    h.erroreLettura = { code, message: 'non c’è' }
    const res = await chiama(richiesta(documento()))

    expect(res.status).toBe(503)
    expect((await res.json()).codice).toBe('SCANSIONE_ARCHIVIO_NON_DISPONIBILE')
    expect(h.uploads, 'un oggetto è entrato nel bucket su un database che non ha il fascicolo').toHaveLength(0)
    expect(h.rimozioni).toHaveLength(0)
    expect(h.registroInserts).toHaveLength(0)
  })

  it('lettura del fascicolo in errore GENERICO: 503 fail-closed, niente nel bucket', async () => {
    h.erroreLettura = { code: 'XX000', message: 'giù' }
    const res = await chiama(richiesta(documento()))
    expect(res.status).toBe(503)
    expect(h.uploads).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST admin/anagrafica-personale/scansione · il tetto per UTENTE', () => {
  it('oltre il tetto arriva un 429 con `Retry-After`, e il conto è PER PERSONA', async () => {
    // Il tetto è tarato sul popolamento dell'archivio (20 persone × 2 facce = 40) e
    // conta l'UTENTE, non l'IP: due operatori nello stesso ufficio non si rubano il
    // tetto a vicenda — è il difetto che la porta pubblica ha già pagato.
    h.utente = SEGRETERIA
    let ultima: Response | null = null
    for (let i = 0; i < 41; i++) ultima = await chiama(richiesta(documento()))

    expect(ultima?.status).toBe(429)
    expect(ultima?.headers.get('Retry-After')).toBeTruthy()

    // L'altro operatore passa: ha il suo contatore.
    h.utente = ADMIN
    expect((await chiama(richiesta(documento()))).status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST admin/anagrafica-personale/scansione · i nomi delle colonne non divergono', () => {
  it('le due facce che la rotta sa scrivere sono ESATTAMENTE quelle del template', async () => {
    // ⚠️ IL LOCK CHE TIENE INSIEME ROTTA E TEMPLATE. `COLONNE_DOCUMENTO` discende da
    // `PERSONALE_FIELDS`; la rotta scrive due nomi per esteso (l'ordine di un array
    // non è un contratto). Il giorno in cui una colonna venisse rinominata di nuovo —
    // è già successo il 12/08/2026, e ha tolto alla Segreteria l'accesso a OGNI
    // scansione — questa riga diventa rossa qui, invece di diventare un `42703` in
    // produzione.
    h.anagrafiche = [fascicolo(null, null)]
    await chiama(richiesta(documento(), `?utenteId=${MAESTRA}&lato=fronte`))
    await chiama(richiesta(documento(), `?utenteId=${MAESTRA}&lato=retro`))

    const scritte = new Set(
      h.scritture.flatMap((s) => Object.keys(s.patch).filter((k) => k.startsWith('documento_'))),
    )
    expect([...scritte].sort()).toEqual([...COLONNE_DOCUMENTO].sort())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('CONTROLLO POSITIVO · il banco di prova sa distinguere `is` da `eq`', () => {
  /**
   * ⚠️ SI COLLAUDA IL FINTO, e non è ozio: fino al 13/08/2026 questo file conteneva
   * un test intitolato «…e il vincolo è `is null`» che NON POTEVA misurarlo, perché
   * `b.eq` e `b.is` erano due lambda identiche. Un banco di prova che non sa
   * distinguere due operatori rende verde una rotta rotta, e nessuno dei suoi test
   * lo dichiara: l'unico modo di accorgersene è chiederglielo qui.
   *
   * La regola che questo blocco difende: **quando la difesa È un dettaglio di
   * scrittura, il finto deve saperlo vedere.**
   */
  const riga: Riga = { documento_fronte_path: null, documento_retro_path: 'documenti/a/b.pdf' }

  it('`is null` trova la colonna vuota, `eq null` non trova MAI niente', () => {
    // È la logica a tre valori di SQL, ed è tutta la differenza fra un 200 e un 409
    // permanente su ogni seconda faccia.
    expect(soddisfa(riga, { col: 'documento_fronte_path', op: 'is', val: null })).toBe(true)
    expect(soddisfa(riga, { col: 'documento_fronte_path', op: 'eq', val: null })).toBe(false)
    // E su una colonna PIENA `is null` è falso: i due non sono uno il negato dell'altro.
    expect(soddisfa(riga, { col: 'documento_retro_path', op: 'is', val: null })).toBe(false)
  })

  it('sul valore PIENO i due operatori coincidono: la differenza vive solo sul `null`', () => {
    // Da qui si capisce perché fonderli restava verde su quasi tutto: il ramo della
    // SOSTITUZIONE — colonna piena, vincolo `eq` — non li distingue nemmeno in SQL.
    for (const op of ['eq', 'is'] as const) {
      expect(soddisfa(riga, { col: 'documento_retro_path', op, val: 'documenti/a/b.pdf' })).toBe(true)
      expect(soddisfa(riga, { col: 'documento_retro_path', op, val: 'documenti/x/y.pdf' })).toBe(false)
    }
  })

  it('una colonna NON SELEZIONATA vale `null`: `undefined` non è un valore diverso', () => {
    // `leggiStato` proietta `utente_id, <colonna>`: l'altra faccia non torna affatto.
    // Se `is null` non la riconoscesse, un fascicolo letto in proiezione stretta
    // risponderebbe «non è vuota» su una colonna che in tabella è `NULL`.
    expect(soddisfa({ utente_id: MAESTRA }, { col: 'documento_fronte_path', op: 'is', val: null })).toBe(true)
  })
})
