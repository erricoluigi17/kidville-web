/**
 * IL DATABASE FINTO DEL COCKPIT DELLE PRATICHE DEL PERSONALE.
 *
 * ─── PERCHÉ UN FINTO E NON UN MOCK PER CHIAMATA ──────────────────────────────
 *
 * Perché quasi tutto ciò che questa route deve garantire è una PROPRIETÀ DELLO
 * STATO, non una chiamata: «l'account esiste una volta sola», «`utenti.ruolo` non
 * è cambiato», «la pratica è tornata `pending`». Con un mock per chiamata quelle
 * frasi diventano «`update` è stato invocato con…», che è vera anche quando il
 * risultato è sbagliato — e infatti `ensureStaffIdentity` NON è mockata in questi
 * test: gira davvero, perché è metà dell'oggetto della prova.
 *
 * ─── COSA REGISTRA, E PERCHÉ CIASCUNA COSA ───────────────────────────────────
 *
 *  · `aggiornamenti` porta i FILTRI oltre al patch: la sede nell'istruzione che
 *    scrive è metà del presidio d'isolamento, e senza guardarla toglierla
 *    resterebbe verde;
 *  · `upserts` è separato dagli `inserimenti` perché la 1:1 di
 *    `anagrafica_personale` si regge sull'`onConflict`, e una prova che non lo
 *    guarda non distingue «aggiorna il fascicolo» da «prende un 23505»;
 *  · `urlFirmate` porta i SECONDI: la durata di una URL firmata su una fotografia
 *    di carta d'identità è una decisione, e una decisione che nessuno misura
 *    torna al valore di prima al primo copincolla.
 */

export type Riga = Record<string, unknown>
export interface Filtro { col: string; vals: unknown[] }

export interface StatoFinto {
  /** Le tabelle, per nome. Ogni test semina le sue. */
  tabelle: Record<string, Riga[]>
  inserimenti: { table: string; row: Riga }[]
  aggiornamenti: { table: string; patch: Riga; filtri: Filtro[] }[]
  upserts: { table: string; row: Riga; onConflict: string | null }[]
  authUsers: { id: string; email: string }[]
  creazioniAuth: { email: string; password?: string }[]
  cancellazioniAuth: string[]
  /** Guasto PER TABELLA: è così che si prova un fail-closed su una LETTURA. */
  erroriTabella: Record<string, { code?: string; message: string }>
  /**
   * Guasto PER TABELLA ma SOLO sull'`update` — le letture della stessa tabella
   * continuano a riuscire.
   *
   * Serve perché il caso vero non è «la tabella `utenti` è irraggiungibile»: è che la
   * lettura pre-claim riesce (quindi la route decide di RIUSARE l'account, e prosegue)
   * e poi l'UPDATE finale non passa — un `CHECK` violato, un trigger, un permesso su
   * quella singola istruzione. Con `erroriTabella` quel percorso non è raggiungibile:
   * la lettura fallirebbe per prima e la route uscirebbe a 503 molto prima di arrivarci.
   */
  erroriAggiornamento?: Record<string, { code?: string; message: string }>
  /**
   * Guasto dell'`update` MIRATO SUL PATCH, non sulla tabella: scatta solo quando la
   * scrittura porta quella coppia colonna/valore.
   *
   * Serve all'unico stato che nessuno degli altri due strumenti sa costruire: la
   * pratica è stata CLAIMATA — un `update` su `pratiche_personale` che ha scritto
   * `stato: 'in_approvazione'`, e che deve RIUSCIRE — e poi la CHIUSURA, che è un
   * secondo `update` sulla STESSA tabella, non passa. Con `erroriAggiornamento` quel
   * percorso non è raggiungibile: fallirebbe già il claim e la route uscirebbe a 503
   * molto prima di arrivare al rilascio delle scansioni.
   *
   * ⚠️ È lo stato in cui la risposta può DICHIARARE un rilascio mai avvenuto: il
   * fascicolo ha preso i percorsi, ma la pratica non li ha azzerati perché l'istruzione
   * non è passata. Senza questo strumento quel ramo non è collaudabile, e infatti non
   * lo era.
   */
  erroreAggiornamentoSuPatch?: {
    table: string
    colonna: string
    valore: unknown
    error: { code?: string; message: string }
  } | null
  /** Colonne che il database (finto) dichiara assenti, per tabella. */
  colonneAssenti: Record<string, string[]>
  /** `createSignedUrl` che non riesce: il gate è già passato, il guasto è dopo. */
  erroreStorage: { message: string } | null
  urlFirmate: { path: string; secondi: number }[]
  erroreCreazioneAuth: { message: string; status?: number } | null
}

export function statoVuoto(): StatoFinto {
  return {
    tabelle: {},
    inserimenti: [],
    aggiornamenti: [],
    upserts: [],
    authUsers: [],
    creazioniAuth: [],
    cancellazioniAuth: [],
    erroriTabella: {},
    erroriAggiornamento: {},
    erroreAggiornamentoSuPatch: null,
    colonneAssenti: {},
    erroreStorage: null,
    urlFirmate: [],
    erroreCreazioneAuth: null,
  }
}

function proietta(r: Riga, cols: string): Riga {
  if (!cols || cols.trim() === '*') return { ...r }
  const fuori: Riga = {}
  for (const c of cols.split(',').map((s) => s.trim()).filter(Boolean)) if (c in r) fuori[c] = r[c]
  return fuori
}

/** L'errore con cui PostgREST dice «questa colonna qui non c'è». */
function colonnaAssente(tabella: string, colonna: string) {
  return {
    code: 'PGRST204',
    message: `Could not find the '${colonna}' column of '${tabella}' in the schema cache`,
  }
}

/**
 * Il client finto. Copre ciò che la route usa davvero: `select` con proiezione e
 * conteggio esatto, `eq`/`in`/`is`, `order`/`range`/`limit`, `maybeSingle`/`single`,
 * `insert`, `update`, `upsert` con `onConflict`, lo storage e `auth.admin`.
 */
export function costruisciClient(state: StatoFinto) {
  const righeDi = (t: string) => (state.tabelle[t] ??= [])
  return {
    from(table: string) {
      const filtri: Filtro[] = []
      let cols = '*'
      let conteggio = false
      let patch: Riga | null = null
      let inserimento: Riga | null = null
      let upsert: Riga | null = null
      let onConflict: string | null = null

      const corrisponde = (r: Riga) => filtri.every((f) => f.vals.some((v) => r[f.col] === v))
      const mancante = (riga: Riga) => (state.colonneAssenti[table] ?? []).find((c) => c in riga)

      const esegui = () => {
        const guasto = state.erroriTabella[table]
        if (guasto) return { data: [] as Riga[], error: guasto, count: null as number | null }

        if (inserimento) {
          const col = mancante(inserimento)
          if (col) return { data: [] as Riga[], error: colonnaAssente(table, col), count: null }
          const riga = { ...inserimento }
          righeDi(table).push(riga)
          state.inserimenti.push({ table, row: riga })
          return { data: [riga], error: null, count: null }
        }

        if (upsert) {
          const col = mancante(upsert)
          if (col) return { data: [] as Riga[], error: colonnaAssente(table, col), count: null }
          const chiave = (onConflict ?? 'id').split(',')[0].trim()
          const esistente = righeDi(table).find((r) => r[chiave] === (upsert as Riga)[chiave])
          const riga = esistente ?? ({} as Riga)
          Object.assign(riga, upsert)
          if (!esistente) righeDi(table).push(riga)
          state.upserts.push({ table, row: { ...upsert }, onConflict })
          return { data: [proietta(riga, cols)], error: null, count: null }
        }

        if (patch) {
          const col = mancante(patch)
          if (col) return { data: [] as Riga[], error: colonnaAssente(table, col), count: null }
          // Il guasto della SOLA scrittura: la riga in tabella resta com'era, ed è
          // esattamente ciò che il chiamante deve poter distinguere da «riuscito».
          const guastoScrittura = state.erroriAggiornamento?.[table]
          if (guastoScrittura) return { data: [] as Riga[], error: guastoScrittura, count: null }
          // Il guasto MIRATO: dopo il degrado sulla colonna assente, perché anche in
          // PostgREST l'errore di schema arriva prima di qualunque vincolo sui dati.
          const mirato = state.erroreAggiornamentoSuPatch
          if (mirato && mirato.table === table && (patch as Riga)[mirato.colonna] === mirato.valore) {
            return { data: [] as Riga[], error: mirato.error, count: null }
          }
          const trovate = righeDi(table).filter(corrisponde)
          for (const r of trovate) Object.assign(r, patch)
          // I FILTRI si registrano insieme al patch: la sede nell'istruzione che
          // scrive è metà del presidio, e senza guardarla toglierla resterebbe verde.
          state.aggiornamenti.push({ table, patch: { ...patch }, filtri: filtri.map((f) => ({ ...f })) })
          return { data: trovate.map((r) => proietta(r, cols)), error: null, count: null }
        }

        const trovate = righeDi(table).filter(corrisponde)
        return {
          data: trovate.map((r) => proietta(r, cols)),
          error: null,
          count: conteggio ? trovate.length : null,
        }
      }

      const b: Record<string, unknown> = {}
      b.select = (c?: string, opts?: { count?: string }) => {
        if (typeof c === 'string') cols = c
        if (opts?.count === 'exact') conteggio = true
        return b
      }
      b.eq = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.in = (col: string, vals: unknown[]) => { filtri.push({ col, vals }); return b }
      b.is = (col: string, val: unknown) => { filtri.push({ col, vals: [val] }); return b }
      b.order = () => b
      b.range = () => b
      b.limit = () => b
      b.update = (v: Riga) => { patch = v; return b }
      b.insert = (v: Riga) => { inserimento = v; return b }
      b.upsert = (v: Riga, opts?: { onConflict?: string }) => {
        upsert = v
        onConflict = opts?.onConflict ?? null
        return b
      }
      b.maybeSingle = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.single = async () => { const r = esegui(); return { data: r.data[0] ?? null, error: r.error } }
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(esegui()).then(res)
      return b
    },

    storage: {
      from: () => ({
        createSignedUrl: async (path: string, secondi: number) => {
          if (state.erroreStorage) return { data: null, error: state.erroreStorage }
          state.urlFirmate.push({ path, secondi })
          return { data: { signedUrl: `https://storage.example.test/${encodeURIComponent(path)}` }, error: null }
        },
      }),
    },

    auth: {
      admin: {
        listUsers: async () => ({ data: { users: state.authUsers }, error: null }),
        createUser: async ({ email, password }: { email: string; password?: string }) => {
          if (state.erroreCreazioneAuth) return { data: null, error: state.erroreCreazioneAuth }
          state.creazioniAuth.push({ email, password })
          const u = { id: `auth-${state.creazioniAuth.length}`, email }
          state.authUsers.push(u)
          return { data: { user: u }, error: null }
        },
        deleteUser: async (id: string) => {
          state.cancellazioniAuth.push(id)
          state.authUsers = state.authUsers.filter((u) => u.id !== id)
          return { data: null, error: null }
        },
      },
    },
  }
}
