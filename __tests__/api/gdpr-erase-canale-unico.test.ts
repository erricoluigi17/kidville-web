import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// IL TERZO CANALE DELL'OBLIO — quello della Direzione — AVEVA LA SUA COPIA.
//
// IL FATTO, misurato il 2026-08-02. `POST /api/admin/gdpr/erase` non chiamava
// `anonimizzaAlunno`/`anonimizzaParent`: riscriveva a mano la stessa procedura.
// Solo che la copia era rimasta indietro di sei mesi di correzioni, e svuotava
// DUE magazzini su sei. Dopo un oblio eseguito dalla Direzione — cioè dal canale
// che risponde alle richieste vere delle famiglie — restavano nell'archivio:
//
//   · le PAGELLE del bambino (giudizi, comportamento, giudizio globale);
//   · i CERTIFICATI MEDICI (dato sanitario dell'art. 9, di un minore);
//   · gli ALLEGATI di chat (dove «passano certificati medici, foto di bambini»);
//   · i PDF delle CREDENZIALI, che contengono una password in chiaro;
//   · il registro delle scritture con il record integrale del bambino.
//
// Il lock dei bucket (`gdpr-oblio-completo.test.ts`) verificava la copertura su
// `anonimizzaAlunno`/`anonimizzaParent` — che erano giusti — e quindi restava
// verde mentre il canale realmente usato lasciava tutto dentro.
//
// LA LEZIONE È GIÀ SCRITTA IN QUESTO BRANCH: «una regola valida per due strade
// deve vivere in un posto solo, altrimenti diverge in silenzio». Qui le strade
// erano tre. Questo file pretende che la terza passi dalle stesse funzioni: non
// «che faccia le stesse cose», che è ciò che si diceva anche prima.
// =============================================================================

const spie = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: spie.logEvento, logErrore: spie.logErrore }
})

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  alunno: null as Record<string, unknown> | null,
  parents: [] as Record<string, unknown>[],
  pagelle: [] as { id: string; file_url: string | null }[],
  certificati: [] as { id: string; file_path: string | null }[],
  media: [] as Record<string, unknown>[],
  threadAlunno: [] as { id: string }[],
  threadGenitore: [] as { id: string }[],
  messaggi: [] as { id: string; attachment_url: string | null }[],
  updates: [] as Record<string, unknown>[],
  // Gli `in(colonna, valori)` visti passare: senza, un'asserzione «l'audit è
  // stato bonificato» resterebbe verde anche quando a bonificarlo è soltanto il
  // ramo del GENITORE e il bambino resta scritto per intero. Verificato: senza
  // questo filtro il test passava con la copia locale rimessa al suo posto.
  filtriIn: [] as { table: string; col: string; vals: unknown }[],
  deleted: [] as string[],
  removed: [] as { bucket: string; paths: string[] }[],
  archivio: new Map<string, Set<string>>(),
  rimuoveDavvero: true,
  // Errori PostgREST per tabella. Serve a misurare il caso «non ho potuto
  // leggere», che non è «non c'era niente»: senza, ogni SELECT del finto client
  // riesce sempre e la differenza fra i due non si può nemmeno mettere alla prova.
  err: {} as Record<string, { code: string; message?: string }>,
}))

function scomponi(p: string) {
  const i = p.lastIndexOf('/')
  return i < 0 ? { cartella: '', nome: p } : { cartella: p.slice(0, i), nome: p.slice(i + 1) }
}

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/gdpr/orfano', () => ({
  leggiAltriFigliIscritti: vi.fn(async () => ({ ok: true, haAltriFigli: false })),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const st: { isDelete?: boolean; eq: Record<string, unknown> } = { eq: {} }
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, val: unknown) => { st.eq[col] = val; return b }
      b.neq = () => b
      b.not = () => b
      b.in = (col: string, vals: unknown) => {
        h.filtriIn.push({ table, col, vals })
        if (st.isDelete) h.deleted.push(table)
        return b
      }
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => { st.isDelete = true; return b }
      b.update = (row: Record<string, unknown>) => { h.updates.push({ table, ...row }); return b }
      b.maybeSingle = async () => ({
        data: table === 'alunni' ? h.alunno : table === 'parents' ? (h.parents[0] ?? null) : null,
        error: null,
      })
      b.then = (res: (v: unknown) => unknown) => {
        const error = h.err[table] ?? null
        if (error) return Promise.resolve({ data: null, error }).then(res)
        let data: unknown[] = []
        if (table === 'student_parents') data = [{ parent_id: 'p-1' }]
        if (table === 'parents') data = h.parents
        if (table === 'pagelle') data = h.pagelle
        if (table === 'certificati_medici') data = h.certificati
        if (table === 'galleria_media_v2') data = h.media
        if (table === 'chat_threads') data = ('student_id' in st.eq ? h.threadAlunno : h.threadGenitore)
        if (table === 'chat_messages') data = h.messaggi
        return Promise.resolve({ data, error: null }).then(res)
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          h.removed.push({ bucket, paths })
          const dentro = h.archivio.get(bucket) ?? new Set<string>()
          const usciti = h.rimuoveDavvero ? paths.filter((p) => dentro.delete(p)) : []
          return { data: usciti.map((p) => ({ name: p })), error: null }
        },
        list: async (cartella: string, opts?: { search?: string }) => {
          const cerca = opts?.search ?? ''
          const righe = [...(h.archivio.get(bucket) ?? new Set<string>())]
            .map(scomponi)
            .filter((s) => s.cartella === cartella && s.nome.startsWith(cerca))
            .map((s) => ({ name: s.nome }))
          return { data: righe, error: null }
        },
      }),
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/erase/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/gdpr/erase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const esegui = () => POST(req({ alunno_id: 'al-1', mode: 'execute', confirm: 'diprova bambino' }))

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  h.alunno = {
    id: 'al-1', nome: 'Bambino', cognome: 'DiProva', stato: 'ritirato', anonimizzato_il: null,
    documento_path: null, codice_fiscale: null, fiscal_code: null, scuola_id: 'sc-1', section_id: null,
  }
  h.parents = [{ id: 'p-1', auth_user_id: 'auth-1', fiscal_code: null, documento_path: null }]
  h.pagelle = [{ id: 'pg-1', file_url: 'scr-1/al-1.pdf' }]
  h.certificati = [{ id: 'cm-1', file_path: 'al-1/cert.pdf' }]
  h.media = []
  h.threadAlunno = [{ id: 'th-1' }]
  h.threadGenitore = [{ id: 'th-9' }]
  h.messaggi = [{ id: 'ms-1', attachment_url: 'auth-9/uuid-referto.pdf' }]
  h.updates = []
  h.filtriIn = []
  h.deleted = []
  h.removed = []
  h.rimuoveDavvero = true
  h.err = {}
  h.archivio = new Map<string, Set<string>>([
    ['pagelle', new Set(['scr-1/al-1.pdf'])],
    ['certificati-medici', new Set(['al-1/cert.pdf'])],
    ['chat-allegati', new Set(['auth-9/uuid-referto.pdf'])],
    ['credenziali', new Set(['p-1-1700000000000.pdf'])],
  ])
})

const bucketSvuotati = () =>
  [...new Set(h.removed.filter((r) => r.paths.length > 0).map((r) => r.bucket))].sort()

describe('POST /api/admin/gdpr/erase — un canale solo, le stesse funzioni', () => {
  it('svuota i magazzini che la copia locale non conosceva (pagelle, certificati, chat, credenziali)', async () => {
    const res = await esegui()
    expect(res.status).toBe(200)
    for (const bucket of ['pagelle', 'certificati-medici', 'chat-allegati', 'credenziali']) {
      expect(
        bucketSvuotati(),
        `il canale della Direzione non manda nessuna \`remove()\` su \`${bucket}\`: ` +
          `dopo l'oblio quei file di un minore restano nell'archivio`,
      ).toContain(bucket)
    }
    // Non basta chiamare: l'archivio deve risultare VUOTO alla fine.
    for (const bucket of ['pagelle', 'certificati-medici', 'chat-allegati', 'credenziali']) {
      expect(h.archivio.get(bucket)?.size ?? 0, `\`${bucket}\` è ancora pieno`).toBe(0)
    }
  })

  it('bonifica il registro delle scritture DEL BAMBINO, non solo quello dei genitori', async () => {
    await esegui()
    const audit = h.updates.find((u) => u.table === 'audit_scritture_docente')
    expect(
      audit,
      'il diff delle modifiche su quel bambino — nome, codice fiscale, allergie — resta in `audit_scritture_docente`',
    ).toBeTruthy()
    expect(audit!.valore_prima).toBeNull()
    expect(audit!.valore_dopo).toBeNull()
    // L'asserzione che conta: il filtro deve contenere l'id dell'ALUNNO. Il ramo
    // del genitore bonifica comunque le SUE righe, e senza questo controllo il
    // test resterebbe verde con il record del minore ancora scritto per intero.
    const filtro = h.filtriIn.find(
      (f) => f.table === 'audit_scritture_docente' && f.col === 'entita_id',
    )
    expect(filtro, 'nessuna bonifica dell’audit per entità').toBeTruthy()
    expect(filtro!.vals as string[]).toContain('al-1')
  })

  it('lo Storage risponde bene e non toglie niente → `n_file_non_rimossi` lo dice e `oblio-parziale` scatta', async () => {
    h.rimuoveDavvero = false
    const res = await esegui()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(
      json.n_file_non_rimossi,
      'la risposta dichiara l’oblio completo mentre nell’archivio non è uscito niente',
    ).toBeGreaterThan(0)
    const parziale = spie.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'oblio-parziale',
    )
    expect(parziale, 'nessuna riga `oblio-parziale`: un oblio a metà non lascia traccia').toBeTruthy()
    expect(parziale![1]).toBe('error')
  })

  it('tutto uscito → risposta pulita e log di SUCCESSO (senza, «nessun log» è ambiguo)', async () => {
    const res = await esegui()
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.n_file_non_rimossi).toBe(0)
    expect(json.file_rimossi).toBeGreaterThan(0)
    const ok = spie.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'oblio-eseguito',
    )
    expect(ok, 'l’oblio riuscito non lascia nessuna riga: «nessun log» non distingue «fatto» da «mai partito»').toBeTruthy()
    expect(ok![0]).toBe('gdpr')
  })

  it('archivio NON LETTO → non si dice «eseguito»: `oblio-parziale` scatta con zero file non rimossi', async () => {
    // ⚠️ IL CASO CHE PASSAVA DAL RAMO DEL SUCCESSO, e il motivo per cui è grave.
    //
    // Un `42501 permission denied` su `student_documents` non è «questo bambino non
    // ha documenti»: è «non ho potuto guardare». Fino al 2026-08-16
    // `anonimizzaAlunno` restituiva gli stessi zeri nei due casi, `nFileNonRimossi`
    // valeva 0, e questa rotta scriveva `oblio-eseguito` rispondendo
    // `n_file_non_rimossi: 0`. La Direzione leggeva «oblio completo» mentre la scheda
    // sanitaria firmata — allergeni, terapie e posologie in chiaro dentro il PDF —
    // non era stata nemmeno aperta.
    h.err = { student_documents: { code: '42501', message: 'permission denied' } }
    const res = await esegui()
    expect(res.status).toBe(200)
    const json = await res.json()

    // Il numero storico resta ZERO, ed è giusto: non c'è nessun file che si sapeva
    // esserci e non è uscito. È esattamente il motivo per cui da solo non basta.
    expect(json.n_file_non_rimossi).toBe(0)
    expect(
      json.letture_fallite,
      'la risposta non dice che un archivio non è stato letto: chi la legge conclude ' +
        '«oblio completo» su un magazzino che nessuno ha aperto',
    ).toBeGreaterThan(0)

    const parziale = spie.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'oblio-parziale',
    )
    expect(parziale, 'nessuna riga `oblio-parziale` su un oblio che non ha letto un archivio').toBeTruthy()
    expect(parziale![1]).toBe('error')
    expect((parziale![2] as { n_letture_fallite?: number }).n_letture_fallite).toBeGreaterThan(0)

    // E soprattutto: la riga di successo NON deve esserci. È quella che, riletta fra
    // sei mesi in `app_log`, risponde «sì, è stato fatto».
    const successo = spie.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'oblio-eseguito',
    )
    expect(successo, '`oblio-eseguito` scritto su un oblio che non ha potuto leggere un archivio').toBeFalsy()
  })

  it('lettura riuscita ⇒ `letture_fallite` resta 0 (il numero deve restare informativo)', async () => {
    const json = await (await esegui()).json()
    expect(json.letture_fallite).toBe(0)
  })

  it('i conteggi storici della risposta restano quelli (chi legge la risposta non cambia)', async () => {
    const res = await esegui()
    const json = await res.json()
    for (const campo of [
      'alunno', 'parents', 'file_rimossi', 'n_file_non_rimossi', 'iscrizioni_scrubbate',
      'foto_rimosse', 'foto_sganciate', 'riconciliazione_bonificati', 'incassi_bonificati',
      'cassa_bonificati', 'news_visualizzazioni_rimosse', 'consensi_prova_bonificati',
    ]) {
      expect(json, `campo sparito dalla risposta: ${campo}`).toHaveProperty(campo)
    }
    expect(h.logScrittura).toHaveBeenCalled()
  })

  it('dice anche quante presenze ha bonificato: il motivo dell’assenza è un dato sanitario', async () => {
    // Aggiunto il 2026-08-07 con la copertura di `presenze.giustificazione_testo`
    // e `presenze.note_appello`. Sta nella RISPOSTA, non solo nei log, per la
    // stessa ragione di `push_subscriptions_rimosse`: chi esegue l'oblio deve
    // poter dire alla famiglia CHE COSA è stato tolto. Il finto client di questo
    // file non ha righe di presenza, quindi il numero atteso è 0 — ciò che si
    // pretende è che il campo ESISTA, cioè che il canale della Direzione passi
    // dalla funzione condivisa anche per questa tabella.
    const res = await esegui()
    const json = await res.json()
    expect(
      json,
      'la risposta non dichiara `presenze_bonificate`: il motivo dell’assenza è testo libero ' +
        'di natura sanitaria di un minore, e un oblio che non lo nomina non si può verificare',
    ).toHaveProperty('presenze_bonificate')
    // E l'UPDATE dev'essere davvero partito verso `presenze`: senza, il campo
    // sarebbe un numero che non descrive nessuna scrittura.
    expect(
      h.updates.some((u) => u.table === 'presenze'),
      'nessun UPDATE su `presenze`: l’oblio non raggiunge il motivo dell’assenza',
    ).toBe(true)
    // E il conteggio dev'essere INTERROGABILE: `gdpr` è in `EVENTI_PERSISTITI`,
    // quindi la riga di successo finisce in `app_log`. Senza il numero lì dentro,
    // fra sei mesi la domanda «quel testo è stato tolto?» ha per sola risposta
    // una riga di audit che bisogna sapere di dover cercare.
    const ok = spie.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'oblio-eseguito',
    )
    expect(ok, 'nessuna riga di successo `oblio-eseguito`').toBeTruthy()
    expect(
      ok![2] as Record<string, unknown>,
      'il log di successo non dice quante presenze sono state bonificate',
    ).toHaveProperty('n_presenze')
  })
})
