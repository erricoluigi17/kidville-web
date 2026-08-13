/**
 * `assertTagStudentsInScope` — il gate di sede dei `tag_students`, provato DA SOLO.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE (2026-08-03) ─────────────────────────────────
 * Il gate nasce il 2026-08-03 come primitiva condivisa fra `POST` e `PATCH` di
 * `/api/gallery`, e finora era provato SOLO attraverso i due handler. Sembra più
 * severo — «lo provo dove vive davvero» — ma su un ramo si è rivelato il
 * contrario: il caso «scope di sede VUOTO» passava per un 403 che i due handler
 * producono **a monte** (`media-fuori-sede`), quindi l'asserzione restava verde
 * anche togliendo il ramo dello scope vuoto. Un test che non può diventare rosso
 * non prova niente, e il suo nome diceva il contrario.
 *
 * La correzione ha due metà, e questa è la prima: i rami che appartengono alla
 * PRIMITIVA si provano sulla primitiva, dove niente li può mascherare. La
 * seconda metà sta in `__tests__/api/gallery-tag-students-scope.test.ts`, dove
 * si prova ciò che appartiene agli handler — e cioè QUALE sede gli passano.
 *
 * Nota sullo scope vuoto: dal 2026-08-03 nessuno dei due handler può più
 * passarlo (la POST usa la sede risolta da `resolveScuolaScrittura`, la PATCH
 * quella del media, e nessuna delle due può essere l'elenco vuoto). Il ramo
 * resta, ed è giusto che resti: è la difesa che viaggia con la primitiva per il
 * terzo chiamante che nascerà. Ma allora va provato QUI, non là.
 *
 * ─── E IL DEGRADO SU DB NON MIGRATO (secondo giro, 2026-08-03) ──────────────
 * Questo gate trattava OGNI `{ error }` di PostgREST come un guasto: anche
 * `42703`, cioè «la colonna `scuola_id` non esiste», che sul DB E2E della CI —
 * un progetto separato e non migrato — è una condizione dichiarata e attesa. Ed
 * è una dipendenza di schema NUOVA: prima che questo gate nascesse, il `PATCH`
 * della galleria `alunni.scuola_id` non lo interrogava mai. `gallery:GET`, nello
 * stesso file di route, quel caso lo tratta già da giorni con
 * `colonnaSedeAssente` + `degradoSedeLecito`; qui no.
 *
 * La regola adottata è quella stretta della modulistica, non «allora niente
 * filtro»: si prosegue senza vincolo di sede SOLO se non c'è niente da isolare
 * (al più una sede reale), altrimenti si NEGA — perché un fail-open proprio
 * quando l'isolamento non è disponibile è il peggior momento per aprirsi. E
 * nella rilettura cade solo il vincolo di SEDE: `.in('id', ids)` resta, quindi
 * un uuid che non è di nessun bambino continua a essere respinto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'

const MINORE_A = '66666666-6666-4666-8666-666666666666'
const MINORE_B = '44444444-4444-4444-8444-444444444444'
/** Della sede A come `MINORE_A`, ma ARCHIVIATO: non frequenta più. */
const ARCHIVIATO_A = '11111111-1111-4111-8111-111111111111'
/** Della sede B e archiviato: serve a provare QUALE dei due rifiuti arriva prima. */
const ARCHIVIATO_B = '22222222-2222-4222-8222-222222222222'
/** `'sospeso'` è un bambino che FREQUENTA: la sua pratica è ferma, lui no. */
const SOSPESO_A = '33333333-3333-4333-8333-333333333333'
/** Un uuid ben formato che non corrisponde a nessun bambino. */
const NESSUNO = '77777777-7777-4777-8777-777777777777'

const h = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))

import { assertTagStudentsInScope } from '@/lib/gallery/tag-scope'

let db: DBFinto
let lette: string[]

beforeEach(() => {
  vi.clearAllMocks()
  lette = []
  db = {
    alunni: [
      // ⚠️ Le due righe storiche restano SENZA `stato`, ed è una scelta: provano
      // che il gate è fail-open sullo stato mancante. `eNonPiuIscritto` è
      // un'allowlist — blocca solo ciò che riconosce — e nella direzione «rifiuto
      // un'operazione a una maestra» si sbaglia dalla parte di chi lascia
      // lavorare. Se un giorno questo diventasse un blocco, questi due test
      // diventerebbero rossi ed è esattamente quello che devono fare.
      { id: MINORE_A, nome: 'Nome', cognome: 'Cognome A', scuola_id: SEDE_A },
      { id: MINORE_B, nome: 'Nome', cognome: 'Cognome B', scuola_id: SEDE_B },
      { id: ARCHIVIATO_A, nome: 'Nome', cognome: 'Archiviato A', scuola_id: SEDE_A, stato: 'ritirato' },
      { id: ARCHIVIATO_B, nome: 'Nome', cognome: 'Archiviato B', scuola_id: SEDE_B, stato: 'ritirato' },
      { id: SOSPESO_A, nome: 'Nome', cognome: 'Sospeso A', scuola_id: SEDE_A, stato: 'sospeso' },
    ],
  }
})

const client = (errori?: Record<string, { code: string }>) =>
  creaFintoSupabase(db, lette, { errori })

/**
 * Un client dove la colonna `scuola_id` di `alunni` NON ESISTE.
 *
 * Non è l'iniezione di errore per tabella (`{ errori: { alunni: … } }`): quella
 * farebbe fallire anche la RILETTURA, e il ramo del degrado non si potrebbe
 * osservare. Una colonna che manca si comporta in modo più preciso — fallisce
 * la query che la NOMINA, e solo quella — ed è esattamente ciò che serve per
 * distinguere «ha degradato» da «ha smesso di controllare».
 */
const ERRORE_COLONNA = { code: '42703', message: 'column alunni.scuola_id does not exist' }

function clientSenzaColonnaSede(errori?: Record<string, { code: string }>) {
  const vero = creaFintoSupabase(db, lette, { errori }) as unknown as { from: (t: string) => object }
  const avvolgi = (bersaglio: object): object => {
    let nominaLaSede = false
    const finto: object = new Proxy(bersaglio, {
      get(b, prop, receiver) {
        const valore = Reflect.get(b, prop, receiver)
        if (prop === 'then' && nominaLaSede) {
          return (ok: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: ERRORE_COLONNA, count: null, status: 400 }).then(ok)
        }
        if (typeof valore !== 'function') return valore
        return (...args: unknown[]) => {
          if (prop === 'in' && args[0] === 'scuola_id') nominaLaSede = true
          const esito = (valore as (...a: unknown[]) => unknown).apply(b, args)
          // I metodi incatenabili restituiscono lo stesso builder: va riavvolto,
          // altrimenti il `then` tornerebbe a essere quello vero.
          return esito === b ? finto : esito
        }
      },
    })
    return finto
  }
  return new Proxy(vero, {
    get(t, prop, receiver) {
      if (prop !== 'from') return Reflect.get(t, prop, receiver)
      return (tabella: string) => avvolgi(t.from(tabella))
    },
  }) as unknown as Parameters<typeof assertTagStudentsInScope>[0]
}

/** Le sedi del deployment, come le legge `sediReali` (la `e2e…` non conta). */
const conSedi = (...reali: string[]) => {
  db.schools = [
    { id: 'e2e00000-0000-4000-8000-000000000000', nome: 'Scuola E2E' },
    ...reali.map((id, i) => ({ id, nome: `Sede ${i + 1}` })),
  ]
}

describe('assertTagStudentsInScope — i rami della primitiva', () => {
  it('nessun tag ⇒ si passa, e l’anagrafica non viene nemmeno letta', async () => {
    expect(await assertTagStudentsInScope(client(), [], [SEDE_A], 'gallery:POST')).toBeNull()
    expect(await assertTagStudentsInScope(client(), null, [SEDE_A], 'gallery:POST')).toBeNull()
    expect(lette).toEqual([])
  })

  it('tutti i tag nella sede indicata ⇒ si passa', async () => {
    expect(await assertTagStudentsInScope(client(), [MINORE_A], [SEDE_A], 'gallery:POST')).toBeNull()
  })

  it('un tag di un’altra sede ⇒ 403, senza nomi né id nel corpo', async () => {
    const res = await assertTagStudentsInScope(client(), [MINORE_A, MINORE_B], [SEDE_A], 'gallery:PATCH')
    expect(res?.status).toBe(403)
    const corpo = JSON.stringify(await res!.json())
    expect(corpo).toContain('TAG_FUORI_SEDE')
    expect(corpo).not.toContain(MINORE_B)
    expect(corpo).not.toContain('Cognome B')
  })

  /**
   * IL RAMO CHE IL TEST DEGLI HANDLER NON POTEVA PROVARE.
   * Elenco di sedi VUOTO ⇒ si nega, e non si legge nemmeno l'anagrafica: uno
   * scope vuoto non è «nessun vincolo», è «nessun permesso».
   */
  it('scope di sede VUOTO ⇒ 403, senza toccare l’anagrafica', async () => {
    const res = await assertTagStudentsInScope(client(), [MINORE_A], [], 'gallery:POST')
    expect(res?.status).toBe(403)
    expect(lette).toEqual([])
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'warn',
      expect.objectContaining({ esito: 'tag-fuori-sede', motivo: 'scope-vuoto', taggati: 1, fuoriSede: 1 }),
    )
  })

  it('…e il diniego per scope vuoto è INDISTINGUIBILE da quello per tag altrui', async () => {
    const vuoto = await assertTagStudentsInScope(client(), [MINORE_A], [], 'gallery:POST')
    const altrui = await assertTagStudentsInScope(client(), [MINORE_B], [SEDE_A], 'gallery:POST')
    expect(await vuoto!.json()).toEqual(await altrui!.json())
    expect(vuoto!.status).toBe(altrui!.status)
  })

  it('lettura fallita (PostgREST ritorna { error }) ⇒ 500, mai un 403 che accusa', async () => {
    // Un guasto VERO — non la colonna assente, che ha un ramo suo qui sotto:
    // `57014` è la query annullata per timeout.
    const res = await assertTagStudentsInScope(
      client({ alunni: { code: '57014' } }),
      [MINORE_A],
      [SEDE_A],
      'gallery:POST',
    )
    expect(res?.status).toBe(500)
    const corpo = (await res!.json()) as { codice?: string }
    expect(corpo.codice).toBe('VERIFICA_TAG_NON_RIUSCITA')
    expect(h.logErrore).toHaveBeenCalled()
  })

  it('il log del diniego porta SOLO conteggi (né nomi né uuid di minori)', async () => {
    await assertTagStudentsInScope(client(), [MINORE_A, MINORE_B], [SEDE_A], 'gallery:POST')
    const scritto = JSON.stringify(h.logEvento.mock.calls)
    expect(scritto).not.toContain(MINORE_B)
    expect(scritto).not.toContain('Cognome')
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'warn',
      expect.objectContaining({ operazione: 'gallery:POST', esito: 'tag-fuori-sede', taggati: 2, fuoriSede: 1 }),
    )
  })
})

// =============================================================================
// LA COLONNA `scuola_id` ASSENTE — il DB E2E della CI non è migrato.
//
// `42703` non è un guasto: è una condizione dichiarata di quell'ambiente. Prima
// finiva nel ramo «lettura fallita» e usciva un 500, cioè «guasto nostro» —
// e il `PATCH` della galleria quella colonna ha cominciato a interrogarla solo
// il 2026-08-03, con la nascita di questo gate.
// =============================================================================
describe('assertTagStudentsInScope — colonna `scuola_id` assente (DB non migrato)', () => {
  it('una sola sede reale ⇒ si prosegue senza il vincolo di sede: non c’è niente da isolare', async () => {
    conSedi(SEDE_A)
    // Il bambino è della sede A, ma qui la sede NON è interrogabile: senza il
    // degrado questa chiamata risponderebbe 500 su un ambiente dove il difetto
    // non esiste.
    const res = await assertTagStudentsInScope(clientSenzaColonnaSede(), [MINORE_A], [SEDE_A], 'gallery:PATCH')

    expect(res).toBeNull()
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'info',
      expect.objectContaining({ operazione: 'gallery:PATCH', esito: 'degrado-scuola-id-assente', taggati: 1 }),
    )
  })

  it('…e il degrado toglie SOLO la sede: un uuid che non è di nessun bambino resta 403', async () => {
    conSedi(SEDE_A)
    const res = await assertTagStudentsInScope(clientSenzaColonnaSede(), [NESSUNO], [SEDE_A], 'gallery:POST')

    expect(res?.status).toBe(403)
    expect((await res!.json()).codice).toBe('TAG_FUORI_SEDE')
  })

  it('DUE sedi reali ⇒ si NEGA: mai un fail-open proprio quando l’isolamento non c’è', async () => {
    conSedi(SEDE_A, SEDE_B)
    const res = await assertTagStudentsInScope(clientSenzaColonnaSede(), [MINORE_A], [SEDE_A], 'gallery:POST')

    expect(res?.status).toBe(500)
    expect((await res!.json()).codice).toBe('VERIFICA_TAG_NON_RIUSCITA')
    // `error`, non `info`: la colonna d'isolamento assente su un impianto
    // multi-sede è un incidente.
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'error',
      expect.objectContaining({ operazione: 'gallery:POST', esito: 'colonna-sede-assente-degrado-negato' }),
    )
  })

  it('sedi NON contabili (lettura di `schools` fallita) ⇒ si NEGA, come per due sedi', async () => {
    // «Non so quante sedi ci sono» e «ce n'è al più una» non sono la stessa cosa,
    // ed è la trappola che `degradoSedeLecito` ha già chiuso una volta: `reali`
    // vale `[]` in tutti e due i casi, e `0 <= 1` è vero.
    conSedi(SEDE_A)
    const res = await assertTagStudentsInScope(
      clientSenzaColonnaSede({ schools: { code: '08006' } }),
      [MINORE_A],
      [SEDE_A],
      'gallery:POST',
    )

    expect(res?.status).toBe(500)
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'error',
      expect.objectContaining({ esito: 'colonna-sede-assente-degrado-negato' }),
    )
  })
})

// =============================================================================
// UN ARCHIVIATO NON SI TAGGA IN UNA FOTO NUOVA (2026-08-12)
//
// L'archiviazione toglie un alunno dagli elenchi sganciandolo dalla CLASSE. Un
// tag però non passa da nessun elenco: arriva come un elenco di uuid scelti da
// chi pubblica, e questa primitiva è l'unica strettoia che li vede tutti. Senza
// un controllo qui si continuerebbe a creare dato personale NUOVO su un minore
// che non frequenta più, mentre l'altra metà del modello — «libera spazio» —
// cancella le sue foto: le due parti si contraddirebbero a vicenda.
// =============================================================================
describe('assertTagStudentsInScope — l’alunno archiviato', () => {
  it('archiviato della PROPRIA sede ⇒ 403 con un codice suo, non quello della sede', async () => {
    const res = await assertTagStudentsInScope(client(), [ARCHIVIATO_A], [SEDE_A], 'gallery:POST')
    expect(res?.status).toBe(403)
    const corpo = (await res!.json()) as { codice?: string; error?: string }
    // ⚠️ Il punto del test è il CODICE, non il rifiuto. Sarebbe bastato un
    // `.eq('stato', …)` nella stessa query per far sparire il bambino come uno di
    // un altro plesso — e la maestra avrebbe letto «non appartengono ai tuoi
    // plessi» su un bambino della sua sede, cercando un errore che non esiste.
    expect(corpo.codice).toBe('TAG_ALUNNO_NON_ISCRITTO')
    expect(corpo.codice).not.toBe('TAG_FUORI_SEDE')
  })

  it('un archiviato in mezzo a tag legittimi basta a fermare tutto', async () => {
    const res = await assertTagStudentsInScope(
      client(),
      [MINORE_A, ARCHIVIATO_A],
      [SEDE_A],
      'gallery:PATCH',
    )
    expect((await res!.json()).codice).toBe('TAG_ALUNNO_NON_ISCRITTO')
  })

  it('la SEDE viene prima: su un archiviato di un ALTRO plesso il motivo resta muto', async () => {
    // È la difesa che tiene insieme le due risposte. Il motivo preciso («non è
    // più iscritto») si pronuncia SOLO su uuid già dimostrati dentro le sedi di
    // chi chiede: altrimenti diventerebbe un modo per sondare l'esistenza — e lo
    // stato — di minori altrui, che è il difetto T05-F1 con un'altra faccia.
    const res = await assertTagStudentsInScope(client(), [ARCHIVIATO_B], [SEDE_A], 'gallery:POST')
    expect(res?.status).toBe(403)
    const corpo = JSON.stringify(await res!.json())
    expect(corpo).toContain('TAG_FUORI_SEDE')
    expect(corpo).not.toContain('NON_ISCRITTO')
    expect(corpo).not.toContain(ARCHIVIATO_B)
  })

  it('`sospeso` NON è archiviato: quel bambino frequenta e si tagga', async () => {
    // `@/lib/alunni/stato` mette `'sospeso'` dalla parte di chi frequenta, per
    // decisione scritta. Il gate usa l'allowlist `eNonPiuIscritto`, quindi qui
    // deve passare — se un giorno qualcuno spostasse quello stato di lato, questo
    // test lo direbbe prima che una maestra si veda rifiutare una foto.
    expect(await assertTagStudentsInScope(client(), [SOSPESO_A], [SEDE_A], 'gallery:POST')).toBeNull()
  })

  it('stato ASSENTE ⇒ si passa: l’allowlist blocca ciò che riconosce, non ciò che non capisce', async () => {
    expect(await assertTagStudentsInScope(client(), [MINORE_A], [SEDE_A], 'gallery:POST')).toBeNull()
  })

  it('il log porta SOLO conteggi: gli id sono di minori', async () => {
    await assertTagStudentsInScope(client(), [MINORE_A, ARCHIVIATO_A], [SEDE_A], 'gallery:POST')
    const scritto = JSON.stringify(h.logEvento.mock.calls)
    expect(scritto).not.toContain(ARCHIVIATO_A)
    expect(scritto).not.toContain('Archiviato')
    expect(h.logEvento).toHaveBeenCalledWith(
      'galleria',
      'warn',
      expect.objectContaining({
        operazione: 'gallery:POST',
        esito: 'tag-alunno-non-iscritto',
        taggati: 2,
        nonIscritti: 1,
      }),
    )
  })

  it('anche col degrado su DB non migrato lo stato continua a bloccare', async () => {
    // La rilettura del degrado toglie il vincolo di SEDE, non il controllo: se
    // avesse perso `stato` dalla proiezione, il blocco sarebbe sparito proprio
    // sull'ambiente dove nessuno lo guarda.
    conSedi(SEDE_A)
    const res = await assertTagStudentsInScope(
      clientSenzaColonnaSede(),
      [ARCHIVIATO_A],
      [SEDE_A],
      'gallery:PATCH',
    )
    expect(res?.status).toBe(403)
    expect((await res!.json()).codice).toBe('TAG_ALUNNO_NON_ISCRITTO')
  })
})
