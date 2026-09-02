/**
 * LA PROPRIETÀ PER CUI `predicati-ruolo.ts` ESISTE, PROVATA INVECE CHE DICHIARATA.
 *
 * ─── IL FATTO, CONTATO ─────────────────────────────────────────────────────────
 *
 * **296 file** di test contengono `vi.mock('@/lib/auth/require-staff', …)` con una
 * factory che sostituisce il modulo PER INTERO. Non lo fanno per cattiveria: è
 * l'unico modo che hanno di iniettare un'identità, perché `requireUser` fa I/O
 * (sessione Supabase + due letture). Ma `require-staff.ts` teneva insieme due cose
 * di natura diversa — le funzioni che fanno I/O e i predicati PURI sui ruoli — e
 * così quei 296 file sostituivano anche la REGOLA DI AUTORIZZAZIONE, che nessuno
 * di loro voleva toccare.
 *
 * Misurato da chi ci ha provato: importare `eFamiglia` da `@/lib/auth/require-staff`
 * dentro `require-parent.ts` faceva diventare rossi **46 test su 7 file**, 40 con lo
 * stesso identico errore —
 *   `[vitest] No "eFamiglia" export is defined on the "@/lib/auth/require-staff" mock`
 * — e quattro di quei file non c'entravano niente con l'autorizzazione.
 *
 * ─── COSA PROVA QUESTO FILE ────────────────────────────────────────────────────
 *
 * Riproduce ESATTAMENTE quella scena — mock TOTALE di `require-staff`, la stessa
 * forma dei 296 — e pretende che i predicati importati da `@/lib/auth/predicati-ruolo`
 * siano quelli VERI. Non `undefined`, non un doppione: la funzione di produzione.
 *
 * È la proprietà, e non un dettaglio d'implementazione: senza di essa ognuna delle
 * ~28 route che stanno per convertirsi a `agisceComeGenitore` pianterebbe la stessa
 * trappola nei propri test. Con essa, chi mocka l'I/O mocka l'I/O e basta.
 *
 * Il secondo `describe` chiude il cerchio sul call site che il problema l'ha
 * incontrato per primo: `requireParentOfStudent` ora IMPORTA i predicati invece di
 * ridichiararli, e sotto mock totale deve continuare a biforcare dove biforcava.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  verificaLegameGenitore: vi.fn(),
  assertAlunnoInScope: vi.fn(),
}))

// ⚠️ MOCK TOTALE, ED È IL PUNTO DEL FILE: nessun `importOriginal`, nessuno spread
// del modulo reale. È la forma letterale dei 296 file, e sostituisce `require-staff`
// con un oggetto che ha DUE chiavi. Se un giorno i predicati tornassero a vivere lì,
// tutto ciò che sta sotto diventerebbe rosso con l'errore citato nella testata.
vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: vi.fn(),
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: vi.fn().mockResolvedValue({}),
  createClient: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  verificaLegameGenitore: (...a: unknown[]) => h.verificaLegameGenitore(...a),
}))
vi.mock('@/lib/auth/scope', () => ({
  assertAlunnoInScope: (...a: unknown[]) => h.assertAlunnoInScope(...a),
}))

// L'import che deve sopravvivere al mock qui sopra. STATICO e non `importActual`:
// «nessuno lo mocka» dev'essere vero per l'import normale, quello che scriverebbe
// una route — se servisse un `importActual` la proprietà non ci sarebbe.
import {
  ruoliDi,
  haRuolo,
  haUnRuolo,
  agisceComeGenitore,
  eFamiglia,
  type AppUser,
} from '@/lib/auth/predicati-ruolo'
import * as requireStaffMockato from '@/lib/auth/require-staff'
import { requireParentOfStudent } from '@/lib/auth/require-parent'

const FIGLIO = 'f1f1f1f1-1111-4111-8111-ffffffffffff'
const ALTRO_BAMBINO = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const DOCENTE_GENITORE = '5d0ce07e-0000-4000-8000-000000000001'
const EDUCATOR_PURO = 'ed00ca70-0000-4000-8000-000000000003'

const req = () => new Request('http://localhost/api/diary/entries?alunno_id=x')

describe('i predicati puri sopravvivono al mock totale di `require-staff`', () => {
  it('la scena è davvero quella dei 296 file: il mock ha sostituito il modulo per intero', () => {
    // ⚠️ LA PROVA DI SANITÀ DEL FILE, e non è `toBeUndefined()` per una ragione che
    // vale la pena scrivere: vitest NON restituisce `undefined` per un export
    // assente da un mock, **lancia**. È letteralmente l'errore che ha aperto questo
    // lavoro, riprodotto qui a comando:
    //   `No "eFamiglia" export is defined on the "@/lib/auth/require-staff" mock`
    // Senza questa asserzione, se un giorno il mock qui sopra smettesse di essere
    // totale (uno spread di `importOriginal` aggiunto per comodità), tutti i test
    // sotto resterebbero verdi provando NIENTE.
    expect(
      () => (requireStaffMockato as Record<string, unknown>).eFamiglia,
      'se `eFamiglia` fosse raggiungibile da qui, il mock non sarebbe totale',
    ).toThrow(/No "eFamiglia" export is defined/)
    expect(() => (requireStaffMockato as Record<string, unknown>).requireStaff).toThrow(
      /No "requireStaff" export is defined/,
    )
    expect(typeof requireStaffMockato.requireUser).toBe('function')
  })

  it('`agisceComeGenitore` è la funzione VERA, non `undefined`', () => {
    expect(typeof agisceComeGenitore).toBe('function')
    expect(agisceComeGenitore({ id: 'x', role: 'genitore' })).toBe(true)
    expect(agisceComeGenitore({ id: 'x', role: 'educator', ruoli: ['educator', 'genitore'] })).toBe(
      false,
    )
  })

  it('e con lei gli altri quattro: `ruoliDi`, `haRuolo`, `haUnRuolo`, `eFamiglia`', () => {
    const doppio: AppUser = { id: 'x', role: 'educator', ruoli: ['educator', 'genitore'] }
    expect([...ruoliDi(doppio)]).toEqual(['educator', 'genitore'])
    expect([...ruoliDi({ id: 'x', role: 'cuoca' })]).toEqual(['cuoca'])
    expect(haRuolo(doppio, 'genitore')).toBe(true)
    expect(haRuolo(doppio, 'admin')).toBe(false)
    expect(haUnRuolo(doppio, ['admin', 'genitore'])).toBe(true)
    expect(haUnRuolo(doppio, ['admin', 'coordinator'])).toBe(false)
    expect(eFamiglia(doppio)).toBe(true)
    expect(eFamiglia({ id: 'x', role: 'educator' })).toBe(false)
  })
})

describe('il call site: `requireParentOfStudent` importa i predicati e non esplode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.assertAlunnoInScope.mockResolvedValue(null)
    h.verificaLegameGenitore.mockResolvedValue('si')
  })

  it('il docente-genitore passa per il LEGAME, con `require-staff` mockato per intero', async () => {
    h.requireUser.mockResolvedValue({
      user: { id: DOCENTE_GENITORE, role: 'educator', ruoli: ['educator', 'genitore'] },
    })
    const r = await requireParentOfStudent(req(), FIGLIO)
    expect(r.response).toBeUndefined()
    expect(h.assertAlunnoInScope, 'è suo figlio: lo scope delle classi non ha voce').not.toHaveBeenCalled()
  })

  it('l’educator senza ponte non paga nemmeno una lettura di legami', async () => {
    h.requireUser.mockResolvedValue({ user: { id: EDUCATOR_PURO, role: 'educator' } })
    await requireParentOfStudent(req(), ALTRO_BAMBINO)
    expect(h.verificaLegameGenitore).not.toHaveBeenCalled()
    expect(h.assertAlunnoInScope).toHaveBeenCalledTimes(1)
  })
})
