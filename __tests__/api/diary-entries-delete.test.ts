import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// DELETE /api/diary/entries — «ho segnato la nanna a un bambino per errore».
//
// PERCHÉ IL VERBO STA QUI E NON SU UNA ROTTA NUOVA. `eventi_diario` è la risorsa
// di questa rotta: aggiungere il verbo dove la risorsa già vive muove UN solo
// conteggio dell'inventario di `isolamento-sede-coverage` invece di due.
//
// PERCHÉ NON UNA POST CON `dettagli` VUOTO, che sarebbe costata zero righe di lock:
// la riga resterebbe in archivio, invisibile solo perché tre lettori si ricordano
// di filtrarla — cioè il difetto di oggi rimandato di un anno. In più la POST manda
// al genitore un push «diario aggiornato» e scriverebbe `azione: 'update'` su una
// cancellazione, cioè una colonna d'audit che mente.

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  assertAlunnoInScope: vi.fn(),
  logScrittura: vi.fn(),
  enqueueDiarioGenitori: vi.fn(),
  notificaTitolariScrittura: vi.fn(),
  // Le righe che la select trova prima di cancellare (servono all'audit).
  righe: [{ id: 'ev-1', alunno_id: 'a1', tipo_evento: 'nanna_inizio', dettagli: { orario_inizio: '13:05' } }] as unknown[],
  deleteChiamata: false,
  clausole: {} as Record<string, unknown>,
  erroreDelete: null as { message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireUser: vi.fn(), requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: vi.fn() }))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: h.assertAlunnoInScope,
  assertClasseNomeInScope: async () => null,
  resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/auth/sede-richiesta', () => ({ restringiASedeRichiesta: () => ({ plessi: ['sc-1'] }) }))
vi.mock('@/lib/sezioni/risoluzione', () => ({ risolviSezione: async () => ({ sectionIds: ['sez-1'] }) }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/primaria/notifiche', () => ({
  notificaTitolariScrittura: h.notificaTitolariScrittura,
  enqueueDiarioGenitori: h.enqueueDiarioGenitori,
}))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }))
vi.mock('@/lib/armadietto/richieste', () => ({ riconciliaRichieste: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = (col: string, v: unknown) => { h.clausole[col] = v; return b }
      // La finestra del giorno: interessa il VALORE, non il nome della colonna.
      b.gte = (_col: string, v: unknown) => { h.clausole.gte = v; return b }
      b.lte = (_col: string, v: unknown) => { h.clausole.lte = v; return b }
      b.in = () => b
      b.order = () => b
      b.maybeSingle = () => Promise.resolve({ data: { section_id: 'sez-1', scuola_id: 'sc-1' }, error: null })
      b.delete = () => { if (tabella === 'eventi_diario') h.deleteChiamata = true; return b }
      b.then = (res: (v: { data: unknown; error: unknown }) => unknown) =>
        res({ data: tabella === 'eventi_diario' ? h.righe : [], error: h.erroreDelete })
      return b
    },
  }),
}))

import { DELETE } from '@/app/api/diary/entries/route'

const req = (qs: string) => ({
  url: `http://test/api/diary/entries?${qs}`,
  nextUrl: { searchParams: new URLSearchParams(qs) },
  headers: new Headers(),
  cookies: { get: () => undefined },
  method: 'DELETE',
}) as never

const ALUNNO = '11111111-1111-1111-1111-111111111111'
const QS = `alunno_id=${ALUNNO}&tipo_evento=nanna_inizio&date=2026-09-07`

beforeEach(() => {
  vi.clearAllMocks()
  h.deleteChiamata = false
  h.clausole = {}
  h.erroreDelete = null
  h.righe = [{ id: 'ev-1', alunno_id: ALUNNO, tipo_evento: 'nanna_inizio', dettagli: { orario_inizio: '13:05' } }]
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: 'sc-1' } })
  h.assertAlunnoInScope.mockResolvedValue(null)
})

describe('DELETE /api/diary/entries', () => {
  it('cancella la registrazione e risponde con quante righe ha tolto', async () => {
    const res = await DELETE(req(QS))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ eliminati: 1 })
    expect(h.deleteChiamata).toBe(true)
  })

  it('la cancellazione nomina bambino, tipo evento e la finestra del giorno', async () => {
    await DELETE(req(QS))
    expect(h.clausole.alunno_id).toBe(ALUNNO)
    expect(h.clausole.tipo_evento).toBe('nanna_inizio')
    expect(String(h.clausole.gte)).toContain('2026-09-07')
    expect(String(h.clausole.lte)).toContain('2026-09-07')
  })

  it('il gate di ruolo viene PRIMA: negato ⇒ nessuna cancellazione', async () => {
    h.requireDocente.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await DELETE(req(QS))
    expect(res.status).toBe(403)
    expect(h.deleteChiamata).toBe(false)
  })

  it('alunno fuori dallo scope ⇒ nessuna cancellazione', async () => {
    h.assertAlunnoInScope.mockResolvedValue(NextResponse.json({}, { status: 403 }))
    const res = await DELETE(req(QS))
    expect(res.status).toBe(403)
    expect(h.deleteChiamata).toBe(false)
  })

  it('il perimetro resta un ENUM: `attivita` è 400, non una cancellazione', async () => {
    // Il gesto è «ho sbagliato a segnare», non «cancella una riga qualunque del
    // diario». `attivita` non è selettiva — si salva a tutti — quindi non ha la
    // trappola del no-op che rende necessario il cestino, e resta fuori.
    const res = await DELETE(req(`alunno_id=${ALUNNO}&tipo_evento=attivita&date=2026-09-07`))
    expect(res.status).toBe(400)
    expect(h.deleteChiamata).toBe(false)
  })

  it.each(['nanna_inizio', 'nanna_fine', 'bagno', 'pranzo', 'merenda'])(
    'ogni evento a salvataggio selettivo ha la sua porta d\'uscita: %s', async (tipo) => {
      // Dal 2026-09-08 bagno e pasti sono selettivi come la nanna. Con il filtro,
      // «azzera i contatori e risalva» non cancella più niente: la riga resta in
      // archivio mentre a schermo la ✅ è sparita e il toast è verde. Senza questa
      // porta il difetto sarebbe chiuso e riaperto dal suo stesso rimedio.
      h.deleteChiamata = false
      const res = await DELETE(req(`alunno_id=${ALUNNO}&tipo_evento=${tipo}&date=2026-09-07`))
      expect(res.status).not.toBe(400)
    })

  it('l\'audit registra una CANCELLAZIONE, col valore di prima', async () => {
    await DELETE(req(QS))
    expect(h.logScrittura).toHaveBeenCalled()
    const arg = h.logScrittura.mock.calls[0][1] as Record<string, unknown>
    expect(arg.azione).toBe('delete')
    expect(arg.entitaTipo).toBe('diario')
    expect(arg.valorePrima).toBeTruthy()
  })

  it('NON avvisa il genitore: con dieci minuti di buffer quella riga non l\'ha mai vista', async () => {
    await DELETE(req(QS))
    expect(h.enqueueDiarioGenitori).not.toHaveBeenCalled()
  })

  it('cancellare ciò che non c\'è è 200 con zero, non un 404', async () => {
    // Idempotenza: un 404 farebbe comparire un errore alla maestra che tocca
    // due volte il cestino, e il risultato voluto è già ottenuto.
    h.righe = []
    const res = await DELETE(req(QS))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ eliminati: 0 })
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('se lo storage rifiuta, è un 500 e l\'audit NON dichiara una cancellazione avvenuta', async () => {
    h.erroreDelete = { message: 'permission denied' }
    const res = await DELETE(req(QS))
    expect(res.status).toBe(500)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })
})
