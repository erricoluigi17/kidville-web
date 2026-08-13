import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// NEWS «per tutte le sedi»: notificava ZERO genitori e si marcava INVIATA.
//
// Audit 2026-07-31 (F5+F6, R82). `news_posts.scuola_id = NULL` è una funzione
// esplicita e riservata alla Direzione: «pubblica per tutti i plessi». Ma i
// risolutori di destinatari leggono lo stesso NULL con il significato opposto —
// «sede sconosciuta, nega» — quindi `genitoriDiScuola(supabase, null)` usciva a
// lista vuota. `notificaEvento` esce in silenzio sui destinatari a zero, e poi
// `notifica_inviata_il` veniva scritto lo stesso: la guardia di idempotenza
// impediva per sempre qualunque ritentativo. La comunicazione a tutte e tre le
// sedi non sarebbe mai arrivata a nessuno, e nei log si leggeva
// `esito: 'inviata', destinatari: 0`.
//
// Due significati opposti dello stesso valore: si scioglie CHIEDENDO «tutte le
// sedi» ed espandendo sull'elenco delle sedi REALI (la finta E2E esclusa).
// =============================================================================

const logEvento = vi.fn()
const logErrore = vi.fn()
const notificaEvento = vi.fn()

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: (...a: unknown[]) => logErrore(...a),
  logOk: vi.fn(),
}))
vi.mock('@/lib/notifiche/triggers', () => ({
  notificaEvento: (...a: unknown[]) => notificaEvento(...a),
}))
// I genitori di un alunno: `gen-<id alunno>`, così la lista dei destinatari dice
// da quali BAMBINI è stata derivata.
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, [`gen-${id}`])
    return m
  }),
}))

import { notificaNewsPubblicata, type PostDaNotificare } from '@/lib/news/notifiche'

const POST_ID = 'ffffffff-0000-4000-8000-00000000000f'

/** Due sedi reali + la finta E2E; un bambino per sede, tutti in «2 ANNI». */
function dbBase(): DBFinto {
  return {
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ],
    scuole: [
      { id: SEDE_A, nome: NOME_SEDE_A, attiva: true },
      { id: SEDE_B, nome: NOME_SEDE_B, attiva: true },
    ],
    sections: [
      { id: 'sez-a', name: '2 ANNI', scuola_id: SEDE_A, school_type: 'nido' },
      { id: 'sez-b', name: '2 ANNI', scuola_id: SEDE_B, school_type: 'nido' },
      { id: 'sez-e2e', name: '2 ANNI', scuola_id: SEDE_E2E, school_type: 'nido' },
    ],
    alunni: [
      // `stato` esplicito su ogni riga: dal 2026-08-12 i risolutori di destinatari
      // filtrano gli iscritti, e una fixture che tace lo stato non descrive più un
      // bambino che frequenta — descrive una riga che nessun avviso raggiunge.
      { id: 'al-a', classe_sezione: '2 ANNI', section_id: 'sez-a', scuola_id: SEDE_A, stato: 'iscritto' },
      { id: 'al-b', classe_sezione: '2 ANNI', section_id: 'sez-b', scuola_id: SEDE_B, stato: 'iscritto' },
      { id: 'al-e2e', classe_sezione: '2 ANNI', section_id: 'sez-e2e', scuola_id: SEDE_E2E, stato: 'iscritto' },
    ],
    news_posts: [{ id: POST_ID, notifica_inviata_il: null }],
  }
}

function post(over: Partial<PostDaNotificare> = {}): PostDaNotificare {
  return {
    id: POST_ID,
    titolo: 'Chiusura per ponte',
    scuola_id: null,
    target_scope: 'globale',
    target_gradi: null,
    target_classes: null,
    contenuto_testo: 'Testo',
    invia_notifica: true,
    notifica_inviata_il: null,
    ...over,
  }
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

const destinatariInviati = () =>
  [...((notificaEvento.mock.calls[0]?.[1] as { utenteIds: string[] })?.utenteIds ?? [])].sort()

beforeEach(() => vi.clearAllMocks())

describe('notificaNewsPubblicata — post «tutte le sedi»', () => {
  it('scope globale ⇒ genitori di TUTTE le sedi reali, la finta E2E esclusa', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    await notificaNewsPubblicata(creaFintoSupabase(db, [], { scritture }), post())

    expect(notificaEvento).toHaveBeenCalledTimes(1)
    expect(destinatariInviati()).toEqual(['gen-al-a', 'gen-al-b'])
    // Marcata inviata, perché è davvero partita.
    expect(db.news_posts[0].notifica_inviata_il).toEqual(expect.any(String))
    expect(scritture.some((s) => s.tabella === 'news_posts' && s.operazione === 'update')).toBe(true)
    expect(logDi('inviata')).toBeDefined()
  })

  it('scope per CLASSE ⇒ l\'omonimia non porta dentro l\'altra sede due volte', async () => {
    const db = dbBase()
    await notificaNewsPubblicata(
      creaFintoSupabase(db),
      post({ target_scope: 'classi', target_classes: ['2 ANNI'] }),
    )
    // Un genitore per sede reale, ciascuno una volta sola.
    expect(destinatariInviati()).toEqual(['gen-al-a', 'gen-al-b'])
  })

  it('scope per GRADO ⇒ espanso sede per sede, E2E esclusa', async () => {
    const db = dbBase()
    await notificaNewsPubblicata(
      creaFintoSupabase(db),
      post({ target_scope: 'grado', target_gradi: ['nido'] }),
    )
    expect(destinatariInviati()).toEqual(['gen-al-a', 'gen-al-b'])
  })

  it('scope per GRADO ⇒ un RITIRATO della sezione NON riceve la news (2026-08-13)', async () => {
    // IL TERZO RAMO DELLO STESSO DISPATCHER, e l'unico rimasto cieco fino al
    // 2026-08-13. `destinatariDiSede` smista su tre strade — `classi`, `grado`,
    // `scuola`: le altre due hanno preso il filtro di stato il 12/08, questa no.
    //
    // Perché il lock non poteva vederla: `genitoriDiGrado` risolve prima le
    // sezioni del grado e poi filtra `.in('section_id', …)`, quindi per
    // `elenchi-operativi-solo-iscritti` è una query «per sezione» ed è esente
    // per costruzione. L'esenzione vale per la strada dell'ARCHIVIAZIONE, che la
    // classe la sgancia; non vale per la TENDINA della scheda alunno, che porta
    // lo `stato` a `'ritirato'` lasciando il bambino agganciato alla sezione.
    // È quella la riga che questo test mette: `al-a-rit` ha `section_id` valido.
    const db = dbBase()
    db.alunni.push({
      id: 'al-a-rit', classe_sezione: '2 ANNI', section_id: 'sez-a', scuola_id: SEDE_A, stato: 'ritirato',
    })
    await notificaNewsPubblicata(
      creaFintoSupabase(db),
      post({ target_scope: 'grado', target_gradi: ['nido'] }),
    )
    expect(destinatariInviati()).toEqual(['gen-al-a', 'gen-al-b'])
    expect(destinatariInviati()).not.toContain('gen-al-a-rit')
  })

  it('scope per GRADO ⇒ un SOSPESO la riceve: frequenta ancora (2026-08-13)', async () => {
    // Il confine dei canali verso le famiglie è `STATI_CON_CANALE_FAMIGLIA`, e
    // `'sospeso'` ci sta dentro perché `LATO_DEL_CONFINE` lo classifica
    // «ancora-iscritto»: è un bambino che frequenta, la cui pratica è ferma.
    // Con `.eq('stato', STATO_ISCRITTO)` in senso stretto questa famiglia
    // sparirebbe da news, agenda, rubrica e digest tutta insieme.
    const db = dbBase()
    db.alunni.push({
      id: 'al-a-sos', classe_sezione: '2 ANNI', section_id: 'sez-a', scuola_id: SEDE_A, stato: 'sospeso',
    })
    await notificaNewsPubblicata(
      creaFintoSupabase(db),
      post({ target_scope: 'grado', target_gradi: ['nido'] }),
    )
    expect(destinatariInviati()).toEqual(['gen-al-a', 'gen-al-a-sos', 'gen-al-b'])
  })

  it('scope per GRADO ⇒ lettura alunni fallita: [] MA una riga `error` (non «zero destinatari»)', async () => {
    // `genitoriDiGrado` controllava `{ error }` e tornava `[]` SENZA loggare: la
    // news finiva sul ramo «nessun-destinatario» e nei log una query rotta si
    // leggeva identica a una sede senza bambini. PostgREST non lancia, quindi
    // nessun `catch` di nessun chiamante avrebbe mai potuto dirlo.
    const db = dbBase()
    await notificaNewsPubblicata(
      creaFintoSupabase(db, [], { errori: { alunni: { code: '42703' } } }),
      post({ scuola_id: SEDE_A, target_scope: 'grado', target_gradi: ['nido'] }),
    )
    expect(notificaEvento).not.toHaveBeenCalled()
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'alunni-non-letti',
    )
    expect(riga?.[1]).toBe('error')
    expect((riga?.[2] as { operazione?: string })?.operazione).toBe('news/notifiche:genitoriDiGrado')
  })

  it('scope per GRADO ⇒ lettura SEZIONI fallita: [] MA una riga `error`', async () => {
    // L'altra metà della stessa funzione: senza le sezioni del grado non si sa
    // quali bambini siano, e il ramo taceva allo stesso modo.
    const db = dbBase()
    await notificaNewsPubblicata(
      creaFintoSupabase(db, [], { errori: { sections: { code: '42703' } } }),
      post({ scuola_id: SEDE_A, target_scope: 'grado', target_gradi: ['nido'] }),
    )
    expect(notificaEvento).not.toHaveBeenCalled()
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'sezioni-non-lette',
    )
    expect(riga?.[1]).toBe('error')
  })

  it('ZERO destinatari ⇒ NON si marca inviata, e resta una riga di log', async () => {
    const db = dbBase()
    db.alunni = [] // nessun bambino a sistema: nessuno da avvisare
    const scritture: Scrittura[] = []
    await notificaNewsPubblicata(creaFintoSupabase(db, [], { scritture }), post())

    expect(notificaEvento.mock.calls.length).toBe(0)
    // È l'asserzione che conta: la guardia di idempotenza non deve chiudersi su
    // una notifica mai partita, altrimenti non si ripeterà MAI più.
    expect(db.news_posts[0].notifica_inviata_il).toBeNull()
    expect(scritture.filter((s) => s.tabella === 'news_posts')).toEqual([])
    const riga = logDi('nessun-destinatario')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('news')
    expect(riga?.[1]).toBe('warn')
  })

  it('elenco sedi illeggibile ⇒ non si marca inviata (si riproverà)', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    await notificaNewsPubblicata(
      creaFintoSupabase(db, [], { scritture, errori: { schools: { code: 'PGRST301' } } }),
      post(),
    )
    expect(notificaEvento.mock.calls.length).toBe(0)
    expect(db.news_posts[0].notifica_inviata_il).toBeNull()
    expect(logDi('sedi-non-risolte')?.[1]).toBe('error')
  })
})

describe('notificaNewsPubblicata — post di UNA sede (comportamento invariato)', () => {
  it('notifica solo i genitori della sua sede', async () => {
    const db = dbBase()
    await notificaNewsPubblicata(creaFintoSupabase(db), post({ scuola_id: SEDE_A }))
    expect(destinatariInviati()).toEqual(['gen-al-a'])
    expect(db.news_posts[0].notifica_inviata_il).toEqual(expect.any(String))
  })

  it('già notificata ⇒ nessun invio (idempotenza)', async () => {
    const db = dbBase()
    await notificaNewsPubblicata(
      creaFintoSupabase(db),
      post({ scuola_id: SEDE_A, notifica_inviata_il: '2026-07-01T00:00:00Z' }),
    )
    expect(notificaEvento.mock.calls.length).toBe(0)
  })
})
