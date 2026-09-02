/**
 * IL LEGAME DI FAMIGLIA VINCE SUL RUOLO — e prima del ruolo.
 *
 * IL FATTO, misurato in produzione e non dedotto. Quattro persone hanno insieme
 * una riga `utenti` con ruolo `educator` E il ponte `parents.auth_user_id` sullo
 * stesso `auth.uid()`: sono insegnanti che sono anche genitori di un bambino
 * della scuola. **Sei** dei loro legami figlio↔genitore cadono fuori dalle sezioni
 * che insegnano e **uno** è in un'altra sede. Aprendo il diario del PROPRIO figlio
 * ricevono `403 «Alunno non nella tua classe»`.
 *
 * LA CAUSA. `requireParentOfStudent` biforcava sul RUOLO ATTIVO
 * (`auth.user.role === 'genitore'`), non sul LEGAME. Per un docente-genitore il
 * ramo di famiglia non veniva nemmeno tentato: si finiva su `assertAlunnoInScope`,
 * che confronta `utenti_sezioni`/`utenti_scuole` — cioè le classi che quella
 * persona INSEGNA, che col figlio non c'entrano niente.
 *
 * LA REGOLA CHE QUESTI TEST FISSANO (la stessa scritta in `require-staff.ts`):
 *   AUTORIZZAZIONE = ruoli REALI, letti dal database → `eFamiglia`
 *   PRESENTAZIONE  = ruolo ATTIVO, scelto col cookie → `agisceComeGenitore`
 *
 * E le cinque proprietà che NON devono cambiare, ognuna con il suo test qui sotto:
 *  1. un genitore puro non guadagna niente (stesso 403, stesso `warn`);
 *  2. un educator SENZA ponte non entra mai nel ramo di famiglia — 61 su 61 invariati;
 *  3. un educator CON ponte ma senza legame con QUEL bambino cade sullo scope staff;
 *  4. `non-deciso` resta 500, mai 403 (lezione T13, già pagata);
 *  5. `studentId` non-uuid → 404 prima di tutto (lezione T16).
 *
 * ⚠️ `require-staff` è mockato PER INTERO, ed è cambiato il 2026-09-01: fino ad
 * allora il mock era PARZIALE (`importOriginal` + spread) perché i predicati puri
 * vivevano dentro `require-staff.ts`, e un mock totale avrebbe sostituito anche la
 * regola di autorizzazione. Ora i predicati stanno in `@/lib/auth/predicati-ruolo`,
 * che non fa I/O e che nessuno mocka: si può sostituire l'I/O senza sostituire la
 * regola, che è tutto ciò che serviva.
 *
 * Il mock totale non è un dettaglio di forma: è la stessa identica forma dei **296
 * file** che mockano `require-staff` in questa suite. Questi 39 test girano quindi
 * nella condizione reale di tutti gli altri, con i predicati VERI in mano.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { AppRole, AppUser } from '@/lib/auth/predicati-ruolo'

const FIGLIO = 'f1f1f1f1-1111-4111-8111-ffffffffffff'
const ALTRO_BAMBINO = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const DOCENTE_GENITORE = '5d0ce07e-0000-4000-8000-000000000001'
const GENITORE_PURO = '9e17012e-0000-4000-8000-000000000002'
const EDUCATOR_PURO = 'ed00ca70-0000-4000-8000-000000000003'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  /** L'esito del legame che il finto `verificaLegameGenitore` restituisce. */
  esitoLegame: 'no' as 'si' | 'no' | 'non-deciso',
  /**
   * IL CONTATORE DEL COSTO. `verificaLegameGenitore` ha un fast-path a una query,
   * ma una query in più su ogni richiesta di 61 educator che non hanno nessun
   * legame è una tassa pagata per niente. Qui si conta, non si commenta.
   */
  chiamateLegame: 0,
  verificaLegameGenitore: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
}))

// TOTALE, come i 296: via l'I/O, e i predicati arrivano dal modulo puro. Vedi la testata.
vi.mock('@/lib/auth/require-staff', () => ({ requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({}),
  createClient: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  verificaLegameGenitore: (...a: unknown[]) => h.verificaLegameGenitore(...a),
  genitoreHasFiglio: async (...a: unknown[]) => (await h.verificaLegameGenitore(...a)) === 'si',
}))
vi.mock('@/lib/auth/scope', () => ({ assertAlunnoInScope: (...a: unknown[]) => h.assertAlunnoInScope(...a) }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: h.logEvento, logErrore: h.logErrore }
})

// Import STATICO, e non più `vi.importActual` dentro ogni caso: è la differenza che
// l'estrazione ha portato. `predicati-ruolo` non fa I/O, quindi nessuno lo mocka e
// non serve nessuna cerimonia per raggiungere le funzioni vere — che è esattamente
// la proprietà collaudata in `predicati-ruolo-fuori-dal-mock.test.ts`.
import { agisceComeGenitore, eFamiglia } from '@/lib/auth/predicati-ruolo'
import { requireParentOfStudent } from '@/lib/auth/require-parent'

const req = () => new Request('http://localhost/api/diary/entries?alunno_id=x')

/** Un utente della richiesta: `role` è la VESTE, `ruoli` sono i ruoli del DATABASE. */
const comeUtente = (id: string, role: AppRole, ruoli?: readonly AppRole[]) =>
  h.requireUser.mockResolvedValue({ user: { id, role, ...(ruoli ? { ruoli } : {}), scuola_id: null } })

/** I campi della riga `logEvento(evento, livello, campi, …)` con quel `tipo`. */
const riga = (tipo: string, livello: string) =>
  h.logEvento.mock.calls.find(
    (c) => c[1] === livello && (c[2] as { tipo?: string } | undefined)?.tipo === tipo,
  )

beforeEach(() => {
  vi.clearAllMocks()
  h.chiamateLegame = 0
  h.esitoLegame = 'no'
  h.verificaLegameGenitore.mockImplementation(async () => {
    h.chiamateLegame += 1
    return h.esitoLegame
  })
  // Default: lo scope staff AMMETTE. Così, quando un test finisce lì per sbaglio,
  // il fallimento si vede sul contatore e non su uno status che «sembra giusto».
  h.assertAlunnoInScope.mockResolvedValue(null)
})

// ─────────────────────────────────────────────────────────────────────────────
describe('il docente-genitore apre il diario del PROPRIO figlio', () => {
  it('veste DOCENTE, figlio fuori dalle sue sezioni: passa per il legame, non per lo scope', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    h.esitoLegame = 'si'
    // Lo scope staff, se interpellato, NEGHEREBBE: è il 403 misurato in produzione.
    h.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'Alunno non nella tua classe' }, { status: 403 }),
    )

    const r = await requireParentOfStudent(req(), FIGLIO)

    expect(r.response, 'è suo figlio: il ruolo di lavoro non c’entra niente').toBeUndefined()
    expect(r.user?.id).toBe(DOCENTE_GENITORE)
    expect(
      h.assertAlunnoInScope,
      'lo scope delle CLASSI CHE INSEGNA non ha voce sul figlio',
    ).not.toHaveBeenCalled()
  })

  it('veste GENITORE (cookie `kv-active-role`): passa esattamente allo stesso modo', async () => {
    comeUtente(DOCENTE_GENITORE, 'genitore', ['educator', 'genitore'])
    h.esitoLegame = 'si'
    const r = await requireParentOfStudent(req(), FIGLIO)
    expect(r.response).toBeUndefined()
    expect(r.user?.id).toBe(DOCENTE_GENITORE)
  })

  it('il ruolo ATTIVO non è mai una condizione dell’accesso, solo della vista', async () => {
    // La stessa persona, lo stesso figlio, le due vesti: due esiti identici.
    h.esitoLegame = 'si'
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    const conVesteDocente = await requireParentOfStudent(req(), FIGLIO)
    comeUtente(DOCENTE_GENITORE, 'genitore', ['educator', 'genitore'])
    const conVesteGenitore = await requireParentOfStudent(req(), FIGLIO)
    expect(conVesteDocente.response).toBeUndefined()
    expect(conVesteGenitore.response).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('il segnale: i quattro profili doppi stanno davvero usando la funzione?', () => {
  it('passaggio per legame in veste NON genitore: una riga `accesso-per-legame-famiglia`', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    h.esitoLegame = 'si'
    await requireParentOfStudent(req(), FIGLIO)
    expect(
      riga('accesso-per-legame-famiglia', 'info')?.[2],
      'senza questa riga, «l’abbiamo aggiustato» resta un’affermazione senza prova',
    ).toMatchObject({
      tipo: 'accesso-per-legame-famiglia',
      azione: 'requireParentOfStudent',
      utente: DOCENTE_GENITORE,
      ruolo: 'educator',
    })
  })

  it('la riga porta SOLO uuid ed enumerati: niente nomi, email o testo libero', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    h.esitoLegame = 'si'
    await requireParentOfStudent(req(), FIGLIO)
    expect(JSON.stringify(riga('accesso-per-legame-famiglia', 'info')?.[2])).not.toMatch(
      /@|nome|cognome|email/i,
    )
  })

  it('chi AGISCE da genitore non la scrive: sarebbe rumore su ogni accesso di famiglia', async () => {
    comeUtente(GENITORE_PURO, 'genitore')
    h.esitoLegame = 'si'
    await requireParentOfStudent(req(), FIGLIO)
    expect(riga('accesso-per-legame-famiglia', 'info')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('1. un genitore puro non guadagna e non perde niente', () => {
  it('legame assente: 403, e lo scope staff non gli apre una seconda strada', async () => {
    comeUtente(GENITORE_PURO, 'genitore')
    h.esitoLegame = 'no'
    const r = await requireParentOfStudent(req(), ALTRO_BAMBINO)
    expect(r.response?.status).toBe(403)
    expect(
      h.assertAlunnoInScope,
      'un genitore senza legame non deve cadere su un gate che non è il suo',
    ).not.toHaveBeenCalled()
  })

  it('il `warn` di IDOR è identico a prima: tipo, azione, alunno, stato e `distingui`', async () => {
    comeUtente(GENITORE_PURO, 'genitore')
    h.esitoLegame = 'no'
    await requireParentOfStudent(req(), ALTRO_BAMBINO)
    const w = riga('alunno-non-della-famiglia', 'warn')
    expect(w?.[2]).toMatchObject({
      tipo: 'alunno-non-della-famiglia',
      azione: 'requireParentOfStudent',
      utente: GENITORE_PURO,
      ruolo: 'genitore',
      alunno_id: ALTRO_BAMBINO,
      stato: 403,
    })
    // `app_log` deduplica per `(fingerprint, giorno)`: senza `distingui` venti
    // tentativi su venti bambini diversi restavano UNA riga, che ne nominava uno.
    expect((w?.[4] as { distingui?: string[] } | undefined)?.distingui).toContain('alunno_id')
  })

  it('legame presente: passa, e la sede non c’entra (fratelli in due plessi)', async () => {
    comeUtente(GENITORE_PURO, 'genitore')
    h.esitoLegame = 'si'
    const r = await requireParentOfStudent(req(), FIGLIO)
    expect(r.response).toBeUndefined()
    expect(h.assertAlunnoInScope).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('2. l’educator SENZA ponte non entra mai nel ramo di famiglia (61 su 61)', () => {
  it('nessuna lettura dei legami: ZERO chiamate, contate sul mock', async () => {
    comeUtente(EDUCATOR_PURO, 'educator')
    await requireParentOfStudent(req(), FIGLIO)
    expect(
      h.chiamateLegame,
      'una query in più su ogni richiesta di chi non ha legami è una tassa pagata per niente',
    ).toBe(0)
    expect(h.assertAlunnoInScope).toHaveBeenCalledTimes(1)
  })

  it('vale anche con `ruoli` esplicito e senza `genitore` dentro', async () => {
    comeUtente(EDUCATOR_PURO, 'educator', ['educator'])
    await requireParentOfStudent(req(), FIGLIO)
    expect(h.chiamateLegame).toBe(0)
    expect(h.assertAlunnoInScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: EDUCATOR_PURO, role: 'educator' }),
      FIGLIO,
    )
  })

  it('e vale per la cuoca, la segreteria e la direzione: nessuno di loro paga', async () => {
    for (const ruolo of ['cuoca', 'segreteria', 'admin', 'coordinator'] as AppRole[]) {
      vi.clearAllMocks()
      h.chiamateLegame = 0
      h.assertAlunnoInScope.mockResolvedValue(null)
      comeUtente(`00000000-0000-4000-8000-00000000000${ruolo.length}`, ruolo)
      await requireParentOfStudent(req(), FIGLIO)
      expect(h.chiamateLegame, `${ruolo} non ha legami di famiglia da leggere`).toBe(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('3. l’educator CON ponte, ma su un bambino che non è suo figlio', () => {
  it('cade sullo scope staff: sulla PROPRIA sezione passa, come oggi', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    h.esitoLegame = 'no'
    h.assertAlunnoInScope.mockResolvedValue(null) // l'alunno è nella sua sezione

    const r = await requireParentOfStudent(req(), ALTRO_BAMBINO)

    expect(r.response, 'insegna a quel bambino: il gate è quello di sempre').toBeUndefined()
    expect(h.assertAlunnoInScope).toHaveBeenCalledTimes(1)
  })

  it('fuori dalla propria sezione: 403 `alunno-fuori-sede`, non il `warn` di famiglia', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    h.esitoLegame = 'no'
    h.assertAlunnoInScope.mockResolvedValue(
      NextResponse.json({ error: 'Alunno non nella tua classe' }, { status: 403 }),
    )

    const r = await requireParentOfStudent(req(), ALTRO_BAMBINO)

    expect(r.response?.status).toBe(403)
    expect(riga('alunno-fuori-sede', 'warn')?.[2]).toMatchObject({ alunno_id: ALTRO_BAMBINO, stato: 403 })
    expect(
      riga('alunno-non-della-famiglia', 'warn'),
      'non stava cercando un figlio: contarlo fra i tentativi IDOR di famiglia falserebbe il contatore',
    ).toBeUndefined()
  })

  it('in veste GENITORE, invece, il diniego resta quello di famiglia e non passa dallo scope', async () => {
    // Chi guarda l'app come genitore vede i propri figli, punto: la vista sceglie
    // COSA si guarda, e in quella vista un bambino altrui è un bambino altrui.
    comeUtente(DOCENTE_GENITORE, 'genitore', ['educator', 'genitore'])
    h.esitoLegame = 'no'
    const r = await requireParentOfStudent(req(), ALTRO_BAMBINO)
    expect(r.response?.status).toBe(403)
    expect(riga('alunno-non-della-famiglia', 'warn')?.[2]).toMatchObject({ ruolo: 'genitore' })
    expect(h.assertAlunnoInScope).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('4. `non-deciso` resta 500, mai 403 (lezione T13)', () => {
  it('genitore puro: 500 con `logErrore`, e nessun `warn` di IDOR a suo nome', async () => {
    comeUtente(GENITORE_PURO, 'genitore')
    h.esitoLegame = 'non-deciso'
    const r = await requireParentOfStudent(req(), FIGLIO)
    expect(r.response?.status).toBe(500)
    expect(h.logErrore).toHaveBeenCalled()
    expect(riga('alunno-non-della-famiglia', 'warn')).toBeUndefined()
  })

  it('docente-genitore: 500 anche a lui — un guasto di lettura non diventa un diniego', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    h.esitoLegame = 'non-deciso'
    const r = await requireParentOfStudent(req(), FIGLIO)
    expect(r.response?.status).toBe(500)
    expect(
      h.assertAlunnoInScope,
      'con la lettura dei legami rotta non si sa se è suo figlio: negare per sezione sarebbe indovinare',
    ).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('5. uno `studentId` malformato è 404 prima di tutto (lezione T16)', () => {
  it('docente-genitore con id non-uuid: 404, e il database non viene sfiorato', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    h.esitoLegame = 'si'
    const r = await requireParentOfStudent(req(), 'non-un-uuid')
    expect(r.response?.status).toBe(404)
    expect(h.chiamateLegame).toBe(0)
    expect(h.assertAlunnoInScope).not.toHaveBeenCalled()
  })

  it('il 404 porta il suo `codice`: le schermate di famiglia mostrano solo frasi di catalogo', async () => {
    comeUtente(DOCENTE_GENITORE, 'educator', ['educator', 'genitore'])
    const r = await requireParentOfStudent(req(), "' or 1=1--")
    expect(await r.response!.json()).toMatchObject({ codice: 'ALUNNO_NON_TROVATO' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL LOCK CHE ANCORA IL GATE AI PREDICATI, E COSA È CAMBIATO SOTTO DI ESSO.
//
// Fino al 2026-09-01 questa tabella teneva insieme DUE COPIE della stessa regola:
// `require-parent.ts` ri-dichiarava `eFamiglia` e `agisceComeGenitore` in casa
// propria — per non far esplodere i 296 file che mockano `require-staff` per
// intero — e il lock verificava che la copia non divergesse dall'originale.
//
// La copia è sparita: i predicati vivono in `@/lib/auth/predicati-ruolo`, il gate
// li IMPORTA, e non c'è più niente da tenere allineato. Il lock però non si butta,
// perché non è mai stato un confronto fra due funzioni — sarebbe stata una
// tautologia. Confronta un COMPORTAMENTO con una REGOLA: prende i predicati veri e
// pretende che il gate biforchi esattamente dove biforcano loro.
//
// Ciò che resta a guardia, misurato e non promesso. Il 2026-09-01 la condizione di
// `require-parent.ts:155` è stata invertita apposta — `if (agisceComeGenitore(…))`
// al posto di `if (eFamiglia(…))`, che è ESATTAMENTE il difetto trovato in
// produzione sui quattro docenti-genitori — e questa tabella è diventata rossa su
// **2 casi su 20**.
//
// Due, e non venti, ed è il numero giusto: i due sono `docente-genitore in veste
// docente` e `admin con ponte genitore`, cioè gli unici della matrice su cui i due
// predicati DIVERGONO. Sugli altri otto la mutazione è invisibile perché veste e
// legame coincidono — ed è la ragione per cui il difetto è vissuto in produzione
// senza che un test lo vedesse. La matrice serve a contenere quei due casi: se
// qualcuno li togliesse perché «sono ridondanti», il lock tornerebbe cieco.
// ─────────────────────────────────────────────────────────────────────────────
describe('lock: il gate biforca dove biforcano i predicati veri', () => {
  const utenti: { titolo: string; user: AppUser }[] = [
    { titolo: 'genitore puro', user: { id: GENITORE_PURO, role: 'genitore' } },
    { titolo: 'educator puro', user: { id: EDUCATOR_PURO, role: 'educator' } },
    { titolo: 'educator con `ruoli` esplicito', user: { id: EDUCATOR_PURO, role: 'educator', ruoli: ['educator'] } },
    { titolo: 'docente-genitore in veste docente', user: { id: DOCENTE_GENITORE, role: 'educator', ruoli: ['educator', 'genitore'] } },
    { titolo: 'docente-genitore in veste genitore', user: { id: DOCENTE_GENITORE, role: 'genitore', ruoli: ['educator', 'genitore'] } },
    { titolo: 'genitore con `ruoli` che lo ripete', user: { id: GENITORE_PURO, role: 'genitore', ruoli: ['genitore'] } },
    { titolo: 'segreteria', user: { id: '00000000-0000-4000-8000-00000000000a', role: 'segreteria' } },
    { titolo: 'cuoca', user: { id: '00000000-0000-4000-8000-00000000000b', role: 'cuoca' } },
    { titolo: 'admin con ponte genitore', user: { id: '00000000-0000-4000-8000-00000000000c', role: 'admin', ruoli: ['admin', 'genitore'] } },
    { titolo: '`ruoli` vuoto: vale il ruolo attivo', user: { id: GENITORE_PURO, role: 'genitore', ruoli: [] } },
  ]

  it.each(utenti)('$titolo — legge i legami se e solo se `eFamiglia`', async ({ user }) => {
    h.requireUser.mockResolvedValue({ user })
    h.esitoLegame = 'si'
    await requireParentOfStudent(req(), FIGLIO)
    expect(
      h.chiamateLegame > 0,
      'chi non è famiglia nel DATABASE non deve pagare nemmeno una query di legami',
    ).toBe(eFamiglia(user))
  })

  it.each(utenti)('$titolo — nega di famiglia se e solo se `agisceComeGenitore`', async ({ user }) => {
    h.requireUser.mockResolvedValue({ user })
    h.esitoLegame = 'no'
    // Lo scope staff AMMETTE: così l'unico 403 possibile è quello di famiglia, e
    // il confronto non può essere superato per la ragione sbagliata.
    h.assertAlunnoInScope.mockResolvedValue(null)

    const r = await requireParentOfStudent(req(), ALTRO_BAMBINO)

    const negatoDaFamiglia = r.response?.status === 403
    expect(negatoDaFamiglia).toBe(eFamiglia(user) && agisceComeGenitore(user))
    expect(!!riga('alunno-non-della-famiglia', 'warn')).toBe(negatoDaFamiglia)
  })
})
