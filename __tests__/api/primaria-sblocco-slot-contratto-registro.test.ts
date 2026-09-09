import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { ErrorePostgrest, Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// IL CONTRATTO FRA CHI SBLOCCA E CHI LEGGE LO SBLOCCO — e perché uno dei cinque
// test qui sotto è ROSSO di proposito.
//
// ─── CHE COSA PROVA QUESTO FILE ──────────────────────────────────────────────
// `primaria/sblocca:POST` SCRIVE una riga in `sblocchi_audit`.
// `primaria/registro:POST` la LEGGE, ed è l'unico che la legge (`grep -rn
// "sblocchi_audit" src` dà due soli chiamanti: la route che scrive e questa).
// Fra i due non c'è nessuna funzione condivisa, nessun tipo, nessun import: il
// medium è una TABELLA, e una tabella non ha una firma che il compilatore possa
// controllare. Quindi il contratto o lo prova un test che esegue TUTTE E DUE le
// route sullo stesso database, o non lo prova niente.
//
// Qui girano davvero entrambe, sullo stesso `h.db`: la prima ci scrive, la
// seconda ci legge. `creaFintoSupabase` filtra e scrive per davvero, quindi
// «il registro ritrova l'autorizzazione» è una proprietà VERIFICATA, non un
// `mockResolvedValue` che sarebbe verde con e senza il lettore.
//
// ─── PERCHÉ UN TEST È ROSSO, E PERCHÉ VA LASCIATO ROSSO ──────────────────────
// Lo sblocco per SLOT (l'ora MAI firmata, che una riga di registro non ce l'ha)
// oggi si scrive ma non si legge: `primaria/registro:POST` cerca l'override
// dentro `if (esistente)` e solo `.eq('entita_id', esistente.id)`. Un'ora mai
// firmata non ha `esistente`, quindi quel ramo non viene nemmeno imboccato.
//
// Il risultato, per chi usa il prodotto: il dirigente preme «Sblocca l'ora»,
// legge «autorizzato», e la maestra continua a prendere 423. **Un'operazione che
// dichiara successo senza fare niente** — la stessa forma di guasto che questo
// repo ha già pagato tre volte (le email 403, le foto a una famiglia sola, le
// tre operazioni del collaudo che «hanno dichiarato successo senza far niente»).
//
// Il lettore per slot appartiene al lotto L4, che sta lavorando su quel file
// mentre questo viene scritto. Finché non arriva, questo test è la SOLA cosa che
// impedisce di mandare in produzione lo sblocco a metà: senza di lui il vincolo
// vive nella prosa di un rapporto, e i rapporti non fermano un merge.
//
//   🔴 SE QUESTO FILE È ROSSO, IL RILASCIO NON È PRONTO — non è il test a essere
//      rotto. Verde lo fa L4 aggiungendo il ramo per slot; il rosso si spegne da
//      solo, senza toccare una riga di qui.
//
// ─── COSA NON SI PROVA QUI, E DOVE SI PROVA ──────────────────────────────────
// Lo SCOPE è mockato di proposito, in tutte e due le direzioni: con il modulo
// vero un errore iniettato su `sections` verrebbe intercettato dal gate e non
// arriverebbe mai al ramo del lock. Gira per intero, col modulo reale, in
// `primaria-sblocca-slot.test.ts` (lato sblocco: «lo slot di un'altra sede è
// respinto») e in `primaria-registro-supplenza.test.ts` (lato firma).
// =============================================================================

const SEZ = 'aaaa1111-0000-4000-8000-0000000000a1'
const MATERIA = '22222222-1111-4111-8111-aaaaaaaaaaaa'
const MAESTRA = 'd0ce0001-0000-4000-8000-000000000002'
const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000001'
const RIGA_REGISTRO = 'e9157200-0000-4000-8000-000000000001'
/** Il lunedì della lezione: una data fissa, non «oggi meno tre». */
const LUNEDI = '2026-09-07'
const ORA = 3

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  isOltreScadenza: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logScrittura: vi.fn(),
  enqueue: vi.fn(),
  notificaTitolari: vi.fn(),
  db: {} as Record<string, Riga[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, ErrorePostgrest>,
}))

// Solo i due emettitori sono sostituiti: il resto di `logger` resta REALE, perché
// `withRoute` ne usa altri pezzi e un mock totale collauderebbe l'impalcatura.
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (...a: unknown[]) => h.logEvento(...a),
    logErrore: (...a: unknown[]) => h.logErrore(...a),
  }
})

vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn().mockResolvedValue(null),
  assertAlunniInSezione: vi.fn().mockResolvedValue(null),
  assertSezionePrimariaFirmabile: vi.fn().mockResolvedValue({ response: null, supplenza: false }),
}))
vi.mock('@/lib/auth/require-grado', () => ({ assertGradoDocente: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/audit/valutatore', () => ({
  risolviValutatore: vi.fn().mockImplementation(async () => ({ valutatoreId: MAESTRA, response: null })),
}))
vi.mock('@/lib/primaria/timelock', () => ({ isOltreScadenza: h.isOltreScadenza }))
vi.mock('@/lib/primaria/notifiche', () => ({
  enqueueNotifichePerAlunni: h.enqueue,
  notificaTitolariScrittura: h.notificaTitolari,
}))

// UN SOLO database finto per le due route: è il medium del contratto.
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () =>
    creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { POST as FIRMA } from '@/app/api/primaria/registro/route'
import { POST as SBLOCCA } from '@/app/api/primaria/sblocca/route'

/** La maestra firma l'ora: sempre con un contenuto, o sarebbe una «firma vuota» (400). */
const firma = () =>
  FIRMA(
    new NextRequest('http://localhost/api/primaria/registro?userId=' + MAESTRA, {
      method: 'POST',
      body: JSON.stringify({
        sectionId: SEZ,
        data: LUNEDI,
        oraLezione: ORA,
        materiaId: MATERIA,
        argomento: 'Le frazioni',
        tipoCompresenza: 'principale',
        destinatariIds: [],
      }),
      headers: { 'content-type': 'application/json', 'x-user-id': MAESTRA },
    }),
  )

/** Il dirigente autorizza. `corpo` è la forma dello sblocco: per slot o per riga. */
const sblocca = (corpo: Record<string, unknown>) =>
  SBLOCCA(
    new NextRequest('http://localhost/api/primaria/sblocca?userId=' + DIRIGENTE, {
      method: 'POST',
      body: JSON.stringify({ entitaTipo: 'registro', motivazione: 'Assenza della maestra: recupero autorizzato', ...corpo }),
      headers: { 'content-type': 'application/json', 'x-user-id': DIRIGENTE },
    }),
  )

/** La riga che il registro avrebbe se l'ora fosse già stata firmata una volta. */
const rigaGiaFirmata = (): Riga => ({
  id: RIGA_REGISTRO,
  section_id: SEZ,
  classe_sezione: '1A',
  scuola_id: SEDE_A,
  data: LUNEDI,
  ora_lezione: ORA,
  materia_id: MATERIA,
  argomento: 'Le frazioni',
  locked_il: '2026-09-09T06:00:00.000Z',
})

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.logScrittura.mockResolvedValue(undefined)
  h.enqueue.mockResolvedValue(undefined)
  h.notificaTitolari.mockResolvedValue(undefined)
  // LA SCENA: `timelock_giorni_classe_orale` vale 2 su tutte e quattro le sedi
  // (letto in produzione il 2026-09-09). Firmare giovedì la lezione di lunedì è
  // fuori termine, ed è l'unico caso in cui uno sblocco significa qualcosa.
  h.isOltreScadenza.mockResolvedValue({ locked: true, giorniLimite: 2 })
  h.requireDocente.mockResolvedValue({
    user: { id: MAESTRA, role: 'educator', ruolo: 'educator', scuola_id: SEDE_A },
    response: null,
  })
  h.requireStaff.mockResolvedValue({
    user: { id: DIRIGENTE, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A },
    response: null,
  })
  h.db = {
    sections: [{ id: SEZ, name: '1A', scuola_id: SEDE_A, school_type: 'primaria' }],
    registro_orario: [],
    firme_docenti: [],
    registro_destinatari: [],
    sblocchi_audit: [],
    campanelle: [],
    orario_settimanale: [],
    utenti: [{ id: MAESTRA, nome: 'M', cognome: 'M' }],
    alunni: [],
    valutazioni: [],
    note_disciplinari: [],
  }
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Il termine scaduto, prima che qualcuno sblocchi', () => {
  it('senza autorizzazione la firma tardiva è 423 — sia sull’ora mai firmata…', async () => {
    const res = await firma()
    expect(res.status).toBe(423)
    expect(h.db.sblocchi_audit).toHaveLength(0)
  })

  it('…sia sulla riga già scritta che si vorrebbe correggere', async () => {
    h.db.registro_orario = [rigaGiaFirmata()]
    const res = await firma()
    expect(res.status).toBe(423)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Lo sblocco arriva davvero fino alla firma', () => {
  // Il controllo che rende non-vuoto tutto il resto del file: se questo fosse
  // rosso, il banco di prova non collegherebbe le due route e il test qui sotto
  // sarebbe rosso per un motivo qualunque invece che per quello dichiarato.
  it('RIGA ESISTENTE — il dirigente sblocca per `entitaId` e la correzione tardiva passa', async () => {
    h.db.registro_orario = [rigaGiaFirmata()]

    const autorizzazione = await sblocca({ entitaId: RIGA_REGISTRO })
    expect(autorizzazione.status).toBe(200)
    expect(h.db.sblocchi_audit).toHaveLength(1)

    const res = await firma()
    expect(res.status).toBe(200)
  })

  // 🔴 IL TEST CHE OGGI È ROSSO. Vedi il banner in cima al file.
  it('SLOT MAI FIRMATO — il dirigente sblocca per coordinate e la firma tardiva DEVE passare', async () => {
    // Nessuna riga di registro: è precisamente il caso per cui lo sblocco per
    // slot esiste. Il dirigente non ha nessun uuid da indicare.
    expect(h.db.registro_orario).toHaveLength(0)

    const autorizzazione = await sblocca({ sectionId: SEZ, data: LUNEDI, oraLezione: ORA })
    expect(autorizzazione.status).toBe(200)

    // L'autorizzazione è agli atti, con le coordinate al posto dell'uuid.
    const audit = h.db.sblocchi_audit[0]
    expect(audit.entita_tipo).toBe('registro')
    expect(audit.entita_id ?? null).toBeNull()
    expect(audit.section_id).toBe(SEZ)
    expect(audit.data).toBe(LUNEDI)
    expect(Number(audit.ora_lezione)).toBe(ORA)

    const res = await firma()
    expect(
      res.status,
      "L'autorizzazione è scritta e nessuno la legge: `primaria/registro:POST` cerca lo sblocco " +
        "solo dentro `if (esistente)` e solo per `entita_id`. Serve il ramo per SLOT (lotto L4): " +
        ".from('sblocchi_audit').select('id').eq('entita_tipo','registro').eq('section_id', sectionId)" +
        ".eq('data', data).eq('ora_lezione', oraLezione).limit(1).maybeSingle(). " +
        'Finché manca, il dirigente legge «autorizzato» e la maestra prende 423.',
    ).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('Il database della CI, che non riceve le migrazioni', () => {
  // ⚠️ ONESTÀ SU QUESTO TEST: oggi è verde A VUOTO, perché la ricerca dello
  // sblocco per slot non esiste ancora e quindi l'errore iniettato non viene mai
  // prodotto. Non è una prova: è una GUARDIA, e morde nel momento esatto in cui
  // L4 aggiunge la query. Il DB E2E della CI è un progetto separato e non
  // migrato: `section_id`, `data` e `ora_lezione` su `sblocchi_audit` là non
  // esistono, e una `select` che le nomina risponde `42703`. Trattarlo come
  // guasto darebbe **500 dove oggi la CI prende 423** — cioè una regressione
  // introdotta dal lettore, non dalla firma.
  //
  // Che il 500 sia il rischio vero è MISURATO, non temuto: iniettando lo stesso
  // `42703` nel caso in cui la query oggi viene fatta davvero (con la riga di
  // registro già esistente), `primaria/registro:POST` risponde **500**. È il ramo
  // `sbloccoErr → LETTURA_FALLITA`, giusto per un guasto vero e sbagliato per una
  // colonna che su quel database non c'è: il lettore per slot deve distinguerli.
  it('la ricerca dello sblocco che cade su `42703` vale «nessuno sblocco», non «guasto»', async () => {
    h.errori = {
      'sblocchi_audit:select': {
        code: '42703',
        message: 'column sblocchi_audit.section_id does not exist',
      },
    }

    const res = await firma()
    expect(res.status).not.toBe(500)
    expect(res.status).toBe(423)
  })
})
