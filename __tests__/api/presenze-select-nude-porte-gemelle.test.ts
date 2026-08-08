/**
 * T22, seguito — «dopo averla chiusa, cercala nelle altre».
 *
 * La forma è `.select()` NUDO su `presenze`, che in PostgREST è `select *` e su
 * un UPSERT restituisce ciò che C'ERA: le venticinque colonne, fra cui
 * `giustificazione_testo` (testo libero sanitario di un minore, art. 9) e
 * `giustificazione_firma`, che porta EMAIL, INDIRIZZO IP e USER-AGENT del
 * genitore firmatario.
 *
 * Cercata in tutto `src/`, la forma resta su `presenze` in due altre porte, ed
 * entrambe sono del personale della PRIMARIA:
 *
 *  · `POST /api/primaria/appello` — e qui è PEGGIO che nella rotta del rilievo,
 *    perché le righe non finiscono solo nello stato React: finiscono in
 *    `audit_scritture_docente` come `valorePrima`/`valoreDopo`. Cioè la firma
 *    elettronica del genitore e il motivo sanitario del bambino venivano
 *    ARCHIVIATI in una seconda tabella, che l'oblio deve poi ripulire
 *    (`bonificaAuditScritture` esiste esattamente per questo).
 *  · `POST /api/primaria/presenze/giust-vista` — la presa visione della
 *    giustifica: la riga intera torna al browser del docente.
 *
 * Nessuna delle due pagine USA quei corpi (`/teacher/primaria/[id]/appello`
 * controlla `res.ok` e ricarica), quindi la correzione non toglie niente a
 * nessuno: toglie solo ciò che viaggiava per inerzia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const DOCENTE = 'd1111111-1111-4111-8111-111111111111'
const ALUNNO = 'a1111111-1111-4111-8111-111111111111'
const SEDE = 'e1111111-1111-4111-8111-111111111111'

/** La riga come sta in tabella: tre colonne non devono uscire da nessuna porta. */
const RIGA_INTERA = {
  id: 'presenza-1',
  alunno_id: ALUNNO,
  section_id: SEZIONE,
  scuola_id: SEDE,
  data: '2026-08-10',
  stato: 'assente',
  orario_entrata: null,
  orario_uscita: null,
  note_appello: null,
  registrato_da: DOCENTE,
  giustificata: true,
  giust_vista_il: null,
  giustificata_da: 'genitore-1',
  giustificazione_testo: 'febbre alta da tre giorni',
  giustificazione_firma: { email: 'genitore@example.test', ip: '1.2.3.4', user_agent: 'iPhone' },
}

const h = vi.hoisted(() => ({
  select: [] as { tabella: string; colonne: string | undefined }[],
  audit: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireDocente: vi.fn(async () => ({ user: { id: DOCENTE, role: 'educator' }, response: null })),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertSezioneInScope: vi.fn(async () => null),
  assertAlunniInSezione: vi.fn(async () => null),
}))
vi.mock('@/lib/audit/scrittura', () => ({
  logScrittura: vi.fn(async (_c: unknown, v: Record<string, unknown>) => { h.audit.push(v) }),
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined), nomeUtente: vi.fn() }))
vi.mock('@/lib/primaria/notifiche', () => ({
  notificaTitolariScrittura: vi.fn(async () => undefined),
  enqueueNotifichePerAlunni: vi.fn(async () => undefined),
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))

/**
 * Il finto client PROIETTA come PostgREST: se il chiamante chiede sei colonne,
 * ne tornano sei. Senza, il banco di prova restituirebbe la riga intera anche
 * dopo la correzione, e il test resterebbe rosso su un difetto già chiuso —
 * oppure, peggio, verde su uno aperto.
 */
const proietta = (riga: Record<string, unknown>, colonne?: string) => {
  if (!colonne || colonne.trim() === '*') return riga
  const chiavi = colonne.split(',').map((c) => c.trim()).filter(Boolean)
  return Object.fromEntries(chiavi.filter((k) => k in riga).map((k) => [k, riga[k]]))
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn(async () => ({
    from(tabella: string) {
      const qb: Record<string, unknown> = {}
      let colonne: string | undefined
      for (const m of ['eq', 'in', 'is', 'order', 'limit', 'upsert', 'update', 'insert', 'delete']) qb[m] = () => qb
      qb.select = (c?: string) => {
        colonne = c
        h.select.push({ tabella, colonne: c })
        return qb
      }
      qb.maybeSingle = async () => {
        if (tabella === 'sections') return { data: { scuola_id: SEDE, id: SEZIONE }, error: null }
        if (tabella === 'alunni') return { data: { nome: 'Bimbo', scuola_id: SEDE }, error: null }
        return { data: proietta(RIGA_INTERA, colonne), error: null }
      }
      qb.single = async () => ({ data: proietta(RIGA_INTERA, colonne), error: null })
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({
          data: tabella === 'presenze' ? [proietta(RIGA_INTERA, colonne)] : [],
          error: null,
        }).then(res)
      return qb
    },
  })),
}))

import { POST as Appello } from '@/app/api/primaria/appello/route'
import { POST as GiustVista } from '@/app/api/primaria/presenze/giust-vista/route'

beforeEach(() => {
  vi.clearAllMocks()
  h.select = []
  h.audit = []
})

const colonnePresenze = () =>
  h.select.filter((s) => s.tabella === 'presenze').map((s) => s.colonne)

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/primaria/appello — le colonne si dichiarano, anche verso l’audit', () => {
  const req = () =>
    new NextRequest('http://localhost/api/primaria/appello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sectionId: SEZIONE, data: '2026-08-10', alunnoId: ALUNNO, stato: 'presente' }),
    })

  it('nessuna `select` nuda e nessun `select(*)` su `presenze`', async () => {
    await Appello(req())
    const c = colonnePresenze()
    expect(c.length).toBeGreaterThan(0)
    expect(c, '`.select()` e `.select("*")` sono la stessa cosa: la riga torna intera').not.toContain(undefined)
    expect(c).not.toContain('*')
  })

  it('la firma del genitore NON entra nel diff d’audit', async () => {
    await Appello(req())
    const scritto = JSON.stringify(h.audit)
    expect(scritto, 'l’audit conserva il diff per ANNI: ciò che ci entra va scelto').not.toContain('genitore@example.test')
    expect(scritto).not.toContain('giustificazione_firma')
  })

  it('il motivo sanitario NON entra nel diff d’audit', async () => {
    await Appello(req())
    expect(JSON.stringify(h.audit)).not.toContain('febbre alta da tre giorni')
  })

  it('il corpo della risposta non porta firma né motivo', async () => {
    const res = await Appello(req())
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('genitore@example.test')
    expect(corpo).not.toContain('febbre alta da tre giorni')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /api/primaria/presenze/giust-vista — la presa visione non rimanda la firma', () => {
  // `presenzaId` è `zUuid`: con un id finto la rotta risponde 400 PRIMA di
  // toccare il database, e ogni asserzione «il corpo non contiene X» passerebbe
  // per la ragione sbagliata. È la trappola che questo ciclo ha già pagato tre
  // volte — un'asserzione vera in ogni caso non è una difesa.
  const PRESENZA = 'f1111111-1111-4111-8111-111111111111'
  const req = () =>
    new NextRequest('http://localhost/api/primaria/presenze/giust-vista', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presenzaId: PRESENZA }),
    })

  it('la `select` dell’update dichiara le colonne', async () => {
    const res = await GiustVista(req())
    expect(res.status, 'la prova vale solo se la rotta è arrivata in fondo').toBe(200)
    expect(colonnePresenze()).not.toContain(undefined)
  })

  it('email, IP e user-agent del genitore non tornano al browser del docente', async () => {
    const res = await GiustVista(req())
    expect(res.status).toBe(200)
    const corpo = JSON.stringify(await res.json())
    expect(corpo).not.toContain('genitore@example.test')
    expect(corpo).not.toContain('1.2.3.4')
  })
})
