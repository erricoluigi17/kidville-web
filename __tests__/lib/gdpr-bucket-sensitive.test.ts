import { describe, it, expect, vi, beforeEach } from 'vitest'
import { REGISTRO_BUCKET_OBLIO, anonimizzaAlunno, anonimizzaParent } from '@/lib/gdpr/esegui'
import { contaCosaDistrugge, OBLIO_DISTRUGGE } from '@/lib/gdpr/cosa-distrugge'

// =============================================================================
// IL QUINDICESIMO MAGAZZINO — `sensitive_documents`, e ci stanno i dati dell'art. 9.
//
// IL FATTO, misurato in sola lettura il 2026-08-14 e scritto per esteso nella
// testata di `src/app/api/parent/prestampati/banco-famiglia.ts`:
//
//   · `grep -c sensitive_documents src/lib/gdpr/esegui.ts` → **0**;
//   · `REGISTRO_BUCKET_OBLIO` elencava quattordici magazzini e questo non c'era.
//
// Non era un'esclusione motivata: era un bucket NON NOMINATO, cioè la forma in cui
// il dato di un minore resta per sempre senza che nessuno lo abbia deciso. Dentro
// ci sono, da due porte diverse:
//
//   · `POST /api/primaria/fascicolo` → diagnosi, PEI, PDP, verbali della legge 104;
//   · `parent/prestampati/firma` e `prestampati/genera` → scheda sanitaria,
//     autorizzazione alla somministrazione di farmaci, dieta speciale.
//
// Allergeni, terapie e posologie IN CHIARO dentro il PDF, di un bambino. Art. 9
// GDPR. Dopo una richiesta di cancellazione restavano nel bucket **e** restavano
// indicizzati in `student_documents`.
//
// PERCHÉ IL LOCK ESISTENTE NON SE N'ERA ACCORTO. `gdpr-oblio-completo.test.ts`
// misura l'elenco dei bucket CLASSIFICATI e la fotografia della PRODUZIONE, e
// questo in produzione non esiste ancora: lo crea `garantisciBucket` alla prima
// archiviazione. Un bucket che nascerà è invisibile a un inventario di ciò che c'è.
//
// PERCHÉ QUESTO FILE NON SI ACCONTENTA DELLA RIGA DI REGISTRO. Perché il registro
// stesso dichiara che «un registro che dichiara e non fa sarebbe peggio del
// silenzio», ed è già successo qui dentro: la voce `news` ha portato per due giorni
// una motivazione FALSA superando il lock. Quindi qui l'archivio finto è un
// archivio vero — `remove()` toglie (o non toglie) e `list()` dice com'è andata — e
// si guarda lo STATO: che cosa è rimasto nel bucket, quale riga è sopravvissuta.
// =============================================================================

const spie = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: spie.logEvento, logErrore: spie.logErrore }
})

const AT = '2026-08-15T09:00:00Z'
const BUCKET = 'sensitive_documents'

/** Un fascicolo verosimile nella FORMA. Nessun dato vero: il repo è pubblico. */
const SCHEDA_SANITARIA = {
  id: 'sd-1',
  student_id: 'al-1',
  document_type: 'scheda_sanitaria',
  storage_path: 'al-1/1700000000000-scheda.pdf',
  file_url: 'al-1/1700000000000-scheda.pdf',
}
const DIETA_SPECIALE = {
  id: 'sd-2',
  student_id: 'al-1',
  document_type: 'dieta_speciale',
  storage_path: 'al-1/1700000000001-dieta.pdf',
  file_url: 'al-1/1700000000001-dieta.pdf',
}
/** Il fascicolo di un ALTRO bambino, che non ha chiesto niente. */
const PEI_DI_UN_ALTRO = {
  id: 'sd-9',
  student_id: 'al-9',
  document_type: 'pei',
  storage_path: 'al-9/1700000000002-pei.pdf',
  file_url: 'al-9/1700000000002-pei.pdf',
}

interface Cfg {
  /** Le righe di `student_documents`, comprese quelle di altri bambini. */
  documenti?: Record<string, unknown>[]
  /** Che cosa c'è DAVVERO nell'archivio, bucket per bucket. */
  presenti?: Record<string, string[]>
  /** `false` = `remove()` risponde bene e non toglie niente (il difetto storico). */
  rimuoveDavvero?: boolean
  /** Codici d'errore PostgREST per tabella (`PGRST205` = DB E2E non migrato). */
  err?: Record<string, { code: string; message?: string }>
}

/**
 * Un finto Supabase con un ARCHIVIO e un DATABASE veri in memoria: `remove()`
 * toglie sul serio, `list()` racconta com'è andata, e `delete().in('id', …)`
 * cancella davvero le righe. Contare le chiamate non basterebbe — il difetto che
 * questo file chiude è per definizione uno stato che sopravvive a un'operazione
 * dichiarata riuscita.
 */
function makeFake(cfg: Cfg) {
  const archivio: Record<string, Set<string>> = {}
  for (const [b, files] of Object.entries(cfg.presenti ?? {})) archivio[b] = new Set(files)
  const tabelle: Record<string, Record<string, unknown>[]> = {
    student_documents: [...(cfg.documenti ?? [])],
  }
  const rimosseDaTabella: { tabella: string; ids: string[] }[] = []

  const client = {
    from(table: string) {
      const st: { isDelete?: boolean; eq: Record<string, unknown> } = { eq: {} }
      const b: Record<string, unknown> = {}
      const righe = () => {
        const base = tabelle[table] ?? []
        return base.filter((r) => Object.entries(st.eq).every(([c, v]) => r[c] === v))
      }
      b.select = () => b
      b.eq = (col: string, val: unknown) => { st.eq[col] = val; return b }
      b.neq = () => b
      b.not = () => b
      b.order = () => b
      b.range = () => b
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => { st.isDelete = true; return b }
      b.update = () => b
      b.in = (col: string, vals: unknown) => {
        if (st.isDelete && Array.isArray(vals)) {
          const ids = vals.map(String)
          rimosseDaTabella.push({ tabella: table, ids })
          if (tabelle[table]) {
            tabelle[table] = tabelle[table].filter((r) => !ids.includes(String(r.id)))
          }
        }
        return b
      }
      b.maybeSingle = async () => ({ data: null, error: cfg.err?.[table] ?? null })
      b.then = (res: (v: unknown) => unknown) => {
        const error = cfg.err?.[table] ?? null
        return Promise.resolve({ data: error ? null : righe(), error }).then(res)
      }
      return b
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          const dentro = archivio[bucket] ?? new Set<string>()
          const usciti: { name: string }[] = []
          for (const p of paths) {
            if (!dentro.has(p)) continue
            // `rimuoveDavvero: false` è il caso del difetto: `remove()` risponde
            // `error: null` e non nomina niente, mentre il file resta al suo posto.
            if (cfg.rimuoveDavvero === false) continue
            dentro.delete(p)
            usciti.push({ name: p })
          }
          return { data: usciti, error: null }
        },
        list: async (cartella: string, opzioni?: { search?: string }) => {
          const dentro = [...(archivio[bucket] ?? new Set<string>())]
          const prefisso = cartella ? `${cartella}/` : ''
          const nomi = dentro
            .filter((p) => p.startsWith(prefisso))
            .map((p) => p.slice(prefisso.length))
            .filter((n) => !opzioni?.search || n.startsWith(opzioni.search))
          return { data: nomi.map((name) => ({ name })), error: null }
        },
      }),
    },
  }
  return { client, archivio, tabelle, rimosseDaTabella }
}

/** Che cosa è RIMASTO nel bucket. La sola domanda che conta. */
const restaNelBucket = (f: ReturnType<typeof makeFake>) => [...(f.archivio[BUCKET] ?? [])].sort()

beforeEach(() => {
  spie.logEvento.mockClear()
  spie.logErrore.mockClear()
})

describe('registro dell’oblio · `sensitive_documents` ha finalmente un responsabile', () => {
  it('è nel registro: non «non nominato», che è la forma in cui il dato resta per sempre', () => {
    expect(
      Object.keys(REGISTRO_BUCKET_OBLIO),
      'il bucket che custodisce schede sanitarie, terapie farmacologiche e diete speciali di ' +
        'BAMBINI non è nel registro dell’oblio: una richiesta di cancellazione non lo tocca',
    ).toContain(BUCKET)
  })

  it('è dichiarato COPERTO dal canale ALUNNO, e la voce dice da dove passa l’aggancio', () => {
    const voce = REGISTRO_BUCKET_OBLIO[BUCKET]
    expect(voce.stato).toBe('coperto')
    const canali = voce.stato === 'coperto' ? voce.canali : []
    // È il fascicolo di UN bambino: l'aggancio è `student_documents.student_id`.
    // Il canale genitore non ci arriva, e dirlo qui è la differenza fra una
    // copertura misurata e una promessa.
    expect(canali).toContain('alunno')
    const come = voce.stato === 'coperto' ? voce.come : ''
    expect(come).toMatch(/student_documents/)
  })
})

describe('oblio · il fascicolo sanitario del minore esce davvero dall’archivio', () => {
  it('ALUNNO · il PDF esce dal bucket e la riga che lo indicizza sparisce', async () => {
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA, DIETA_SPECIALE],
      presenti: {
        [BUCKET]: [SCHEDA_SANITARIA.storage_path, DIETA_SPECIALE.storage_path],
      },
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')

    expect(
      restaNelBucket(f),
      'la scheda sanitaria firmata resta nel bucket: allergeni, terapie e posologie in chiaro ' +
        'di un bambino di cui è stata chiesta la cancellazione',
    ).toEqual([])
    // La riga va via insieme al file: `student_documents` senza file è un indice
    // che punta al vuoto, e continua a dire che quel bambino ha una dieta speciale.
    expect(f.tabelle.student_documents).toEqual([])
    expect(r.fileNonRimossi).toBe(0)
  })

  it('CONTROLLO NEGATIVO · il fascicolo di un ALTRO bambino non si tocca', async () => {
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA, PEI_DI_UN_ALTRO],
      presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path, PEI_DI_UN_ALTRO.storage_path] },
    })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    // Senza questo controllo, un oblio che svuota il bucket intero passerebbe il
    // test qui sopra: cancellerebbe il PEI di un bambino che non ha chiesto niente.
    expect(restaNelBucket(f)).toEqual([PEI_DI_UN_ALTRO.storage_path])
    expect(f.tabelle.student_documents.map((r) => r.id)).toEqual([PEI_DI_UN_ALTRO.id])
  })

  it('riga STORICA con il solo `file_url`: il file esce lo stesso, la riga non si cancella a vuoto', async () => {
    // `storage_path` è stata aggiunta dopo, e i lettori del fascicolo leggono
    // `storage_path || file_url` (`documenti-firmati/dettaglio`). Un oblio che
    // guardasse la sola colonna nuova tratterebbe la riga storica come «senza
    // allegato»: cancellerebbe l'indice e lascerebbe il PDF nell'archivio, cioè
    // il guasto INVISIBILE che la testata di `esegui.ts` esiste per impedire.
    const storica = {
      id: 'sd-vecchia',
      student_id: 'al-1',
      document_type: 'autorizzazione_farmaci',
      storage_path: null,
      file_url: 'al-1/1690000000000-farmaci.pdf',
    }
    const f = makeFake({
      documenti: [storica],
      presenti: { [BUCKET]: [storica.file_url] },
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(
      restaNelBucket(f),
      'la riga storica indicizzava il PDF solo in `file_url`: l’autorizzazione ai farmaci è ' +
        'rimasta nell’archivio mentre l’indice che la nominava è stato cancellato',
    ).toEqual([])
    expect(f.tabelle.student_documents).toEqual([])
    expect(r.fileNonRimossi).toBe(0)
  })

  it('storage che NON toglie: la riga resta e l’oblio parziale è VISIBILE nel conteggio', async () => {
    // `remove()` risponde `error: null` senza togliere niente — il difetto del
    // 2026-08-02. La riga NON si può cancellare: sarebbe un file di dati sanitari
    // che nessuno può più ritrovare per toglierlo.
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path] },
      rimuoveDavvero: false,
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(restaNelBucket(f)).toEqual([SCHEDA_SANITARIA.storage_path])
    expect(
      f.tabelle.student_documents.map((x) => x.id),
      'la riga è stata cancellata mentre il PDF è ancora nell’archivio: invisibile e non cancellato',
    ).toEqual([SCHEDA_SANITARIA.id])
    expect(r.fileNonRimossi).toBeGreaterThan(0)
  })

  it('schema assente (DB E2E della CI non migrato) → nessun file, nessun rumore', async () => {
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path] },
      err: { student_documents: { code: 'PGRST205', message: 'schema cache' } },
    })
    const r = await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    expect(r.fileNonRimossi).toBe(0)
    const rumore = spie.logErrore.mock.calls.filter(
      ([ctx]) => String((ctx as { evento?: string })?.evento ?? '').includes('fascicolo'),
    )
    expect(rumore).toEqual([])
  })

  it('GENITORE · l’oblio dell’adulto non svuota il fascicolo sanitario del figlio', async () => {
    // Non è una lacuna, è la regola: il fascicolo è del BAMBINO, e la richiesta di
    // un genitore non cancella i dati sanitari di un minore che resta iscritto. Chi
    // volesse cambiarla deve cambiare anche questa riga, di proposito.
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path] },
    })
    await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(restaNelBucket(f)).toEqual([SCHEDA_SANITARIA.storage_path])
  })
})

describe('avviso · la Direzione legge il fascicolo PRIMA di confermare', () => {
  // Svuotare un magazzino in silenzio è la seconda metà dello stesso difetto: il
  // riquadro di `/admin/gdpr` elenca ciò che l'operazione DISTRUGGE, e finché
  // `sensitive_documents` non c'era, chi confermava non poteva sapere che se ne
  // andava anche la scheda sanitaria del bambino. Il lock
  // `__tests__/architecture/oblio-avviso-dichiarato.test.ts` tiene insieme i due
  // elenchi; qui si misura il NUMERO, che è la parte che cambia la decisione.

  it('la voce esiste, passa dal canale ALUNNO e non finisce in fondo all’elenco', () => {
    const voce = OBLIO_DISTRUGGE.find((v) => v.bucket === 'sensitive_documents')
    expect(voce, 'l’avviso non nomina il fascicolo sanitario').toBeTruthy()
    expect(voce!.canale).toBe('alunno')
    expect(voce!.campo).toBe('fascicolo_sanitario')
    // Subito dopo pagelle e certificati medici (che il lock inchioda ai primi due
    // posti): sono dati dell'art. 9 di un minore, non una nota a piè di elenco.
    expect(OBLIO_DISTRUGGE.indexOf(voce!)).toBe(2)
  })

  it('conta i documenti di QUEL bambino, non quelli di tutta la scuola', async () => {
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA, DIETA_SPECIALE, PEI_DI_UN_ALTRO],
      presenti: { [BUCKET]: [] },
    })
    const c = await contaCosaDistrugge(f.client as never, 'al-1', 'test')
    expect(
      c.fascicolo_sanitario,
      'il numero annunciato comprende il fascicolo di un altro bambino',
    ).toBe(2)
  })

  it('lettura FALLITA ⇒ «non misurato» (`null`), mai zero', async () => {
    // `42501 permission denied` non è «zero documenti»: è «non l'ho potuto
    // leggere». Un dry-run che risponde 0 a una lettura fallita RASSICURA, e la
    // conferma verrebbe data su un numero che nessuno ha misurato.
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      err: { student_documents: { code: '42501', message: 'permission denied' } },
    })
    const c = await contaCosaDistrugge(f.client as never, 'al-1', 'test')
    expect(c.fascicolo_sanitario).toBeNull()
  })

  it('schema assente (DB E2E della CI non migrato) ⇒ zero misurato, non «non misurato»', async () => {
    // Se la tabella non esiste, «nessun documento» è la risposta VERA.
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      err: { student_documents: { code: 'PGRST205', message: 'schema cache' } },
    })
    const c = await contaCosaDistrugge(f.client as never, 'al-1', 'test')
    expect(c.fascicolo_sanitario).toBe(0)
  })

  it('il numero annunciato è quello che l’oblio cancella davvero', async () => {
    // Non si crede al commento: si contano e si obliano gli STESSI documenti su
    // due client identici. Due copie della stessa regola divergono — è già
    // successo qui dentro con la partizione delle foto.
    const materiale = { documenti: [SCHEDA_SANITARIA, DIETA_SPECIALE], presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path, DIETA_SPECIALE.storage_path] } }
    const c = await contaCosaDistrugge(makeFake(materiale).client as never, 'al-1', 'test')
    const f = makeFake(materiale)
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const indice = spie.logEvento.mock.calls
      .filter(([, , d]) => (d as { esito?: string })?.esito === 'oblio-indice-rimosso')
      .filter(([, , d]) => (d as { bucket?: string })?.bucket === BUCKET)
    expect(c.fascicolo_sanitario).toBe((indice[0]?.[2] as { n_righe?: number })?.n_righe)
    expect(c.fascicolo_sanitario).toBe(2)
  })
})

describe('oblio · il percorso di cancellazione logga anche il SUCCESSO', () => {
  it('una riga `info` dice che i file sono usciti da `sensitive_documents`', async () => {
    // Con i soli errori, «nessun log» non distingue «tutto ok» da «non è mai
    // partito niente»: è l'ambiguità che ha nascosto per mesi il guasto delle
    // email, e su un bucket di dati sanitari di minori costerebbe di più.
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path] },
    })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const successi = spie.logEvento.mock.calls.filter(
      ([canale, livello, dati]) =>
        canale === 'gdpr' &&
        livello === 'info' &&
        (dati as { bucket?: string })?.bucket === BUCKET,
    )
    expect(
      successi.length,
      'nessuna riga di successo sul bucket del fascicolo: chi legge `app_log` non può ' +
        'distinguere «uscito tutto» da «non è mai partito niente»',
    ).toBeGreaterThan(0)
    const dati = successi[0][2] as { esito?: string; n_file?: number }
    expect(dati.esito).toBe('oblio-file-rimossi')
    expect(dati.n_file).toBe(1)
  })

  it('INDICE SENZA FILE · la riga sparisce lo stesso, e una riga `info` lo dice', async () => {
    // IL BUCO CHE RESTAVA, misurato il 2026-08-16. Il log di successo lo scrive
    // `rimuoviFileOblio`, che però esce PRIMA di scrivere quando non c'è nemmeno un
    // percorso da togliere (`percorsiUnici` → elenco vuoto → `return` immediato).
    // Una riga di `student_documents` senza allegato veniva quindi cancellata in
    // TOTALE SILENZIO: nessun errore, nessun successo, niente in `app_log`. E quella
    // riga non è vuota — porta `document_type`, cioè la frase «questo bambino ha una
    // dieta speciale». Su un archivio di dati sanitari di minori «nessun log» deve
    // significare «non è successo niente», non «è successo e non lo saprai mai».
    const senzaFile = {
      id: 'sd-senza-file',
      student_id: 'al-1',
      document_type: 'dieta_speciale',
      storage_path: null,
      file_url: null,
    }
    const f = makeFake({ documenti: [senzaFile], presenti: { [BUCKET]: [] } })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')

    expect(f.tabelle.student_documents).toEqual([])
    const righe = spie.logEvento.mock.calls.filter(
      ([canale, livello, dati]) =>
        canale === 'gdpr' &&
        livello === 'info' &&
        (dati as { esito?: string })?.esito === 'oblio-indice-rimosso' &&
        (dati as { bucket?: string })?.bucket === BUCKET,
    )
    expect(
      righe.length,
      'l’indice del fascicolo è stato cancellato senza lasciare una sola riga di log: ' +
        'chi rilegge `app_log` non può dire se quell’oblio è stato eseguito',
    ).toBe(1)
    const dati = righe[0][2] as { n_righe?: number; evento?: string }
    expect(dati.n_righe).toBe(1)
    // Il nome dell'archivio va detto: `bucket` ed `evento` passano in chiaro nella
    // lista bianca di `redact`, `tabella` no (uscirebbe `[redatto:str/…]`).
    expect(dati.evento).toBe('oblio_fascicolo')
  })

  it('il successo si logga anche quando il file c’è: due righe, i file e l’indice', async () => {
    // Le due righe rispondono a due domande diverse — «è uscito dall'archivio?» e
    // «l'indice che lo nominava è sparito?» — e la seconda mancava del tutto. Un oblio
    // che togliesse i PDF lasciando le righe (o il contrario) va letto da `app_log`
    // senza dover ricostruire niente.
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path] },
    })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const esiti = spie.logEvento.mock.calls
      .filter(([canale, , dati]) => canale === 'gdpr' && (dati as { bucket?: string })?.bucket === BUCKET)
      .map(([, , dati]) => (dati as { esito?: string })?.esito)
    expect(esiti).toContain('oblio-file-rimossi')
    expect(esiti).toContain('oblio-indice-rimosso')
  })

  it('niente da cancellare ⇒ NESSUNA riga di successo (il silenzio deve restare informativo)', async () => {
    // Il contrario del test qui sopra, e conta quanto quello: se il log di successo
    // scattasse anche a mani vuote, `app_log` si riempirebbe di righe che dicono
    // «fatto» su un bambino che non aveva nessun documento — e una riga che c'è
    // sempre non distingue più niente, esattamente come una che non c'è mai.
    const f = makeFake({ documenti: [PEI_DI_UN_ALTRO], presenti: { [BUCKET]: [PEI_DI_UN_ALTRO.storage_path] } })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const righe = spie.logEvento.mock.calls.filter(
      ([, , dati]) => (dati as { esito?: string })?.esito === 'oblio-indice-rimosso',
    )
    expect(righe).toEqual([])
  })

  it('MAI il percorso nel log: dentro c’è l’uuid del bambino e il nome del documento', async () => {
    const f = makeFake({
      documenti: [SCHEDA_SANITARIA],
      presenti: { [BUCKET]: [SCHEDA_SANITARIA.storage_path] },
    })
    await anonimizzaAlunno(f.client as never, { id: 'al-1' }, AT, 'test')
    const tutto = JSON.stringify([...spie.logEvento.mock.calls, ...spie.logErrore.mock.calls])
    expect(tutto).not.toContain('scheda.pdf')
    expect(tutto).not.toContain(SCHEDA_SANITARIA.storage_path)
  })
})
