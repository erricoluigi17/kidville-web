import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// `POST /api/admin/gdpr/erase` — L'ESITO DEGLI ACCOUNT ARRIVA ALLA DIREZIONE.
//
// Dal 2026-09-14 `anonimizzaParent` libera anche l'account di accesso del genitore
// e dice com'è andata (`account`). Questa route evade l'oblio per un bambino e per
// OGNI genitore rimasto senza altri figli iscritti: gli esiti vanno SOMMATI e
// finiscono nella risposta, nell'audit e nel log. Un account che non si è potuto
// liberare lascia email e nome di una persona: l'oblio è PARZIALE, e non si può
// scrivere `oblio-eseguito`.
//
// `anonimizzaParent`/`anonimizzaAlunno` sono mockate: qui interessa la SOMMA che la
// route fa dei loro esiti. La loro logica sta in `__tests__/lib/gdpr-oblio-account.test.ts`.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  anonimizzaAlunno: vi.fn(),
  anonimizzaParent: vi.fn(),
  links: [] as { parent_id: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logEvento: h.logEvento }
})
vi.mock('@/lib/gdpr/esegui', () => ({
  anonimizzaAlunno: h.anonimizzaAlunno,
  anonimizzaParent: h.anonimizzaParent,
}))
vi.mock('@/lib/gdpr/orfano', () => ({
  leggiAltriFigliIscritti: vi.fn(async () => ({ ok: true, haAltriFigli: false })),
}))

const ALUNNO = {
  id: 'al-1', nome: 'Bambino', cognome: 'DiProva', stato: 'ritirato', anonimizzato_il: null,
  documento_path: null, codice_fiscale: null, fiscal_code: null, scuola_id: 'sc-1', section_id: 'sez-1',
}

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      // Il controllo del registro della primaria (2026-10-08) legge con
      // `.limit(1)`: qui il registro è VUOTO (ogni tabella non nominata risponde `[]`).
      b.limit = () => b
      b.maybeSingle = async () => ({ data: table === 'alunni' ? ALUNNO : null, error: null })
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'student_parents' ? h.links : [], error: null }).then(res)
      return b
    },
  }),
}))

import { POST } from '@/app/api/admin/gdpr/erase/route'

const esegui = () =>
  POST(new Request('http://localhost/api/admin/gdpr/erase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alunno_id: 'al-1', mode: 'execute', confirm: 'diprova bambino' }),
  }))

/** L'esito di `anonimizzaParent` con tutti i conteggi a zero e l'account indicato. */
const parent = (account: string) => ({
  newsVisualizzazioniRimosse: 0, pushSubscriptionsRimosse: 0, segnalazioniBonificate: 0,
  sospensioniBonificate: 0, provaConsensiScrubbate: 0, iscrizioniScrubbate: 0, fileRimossi: 0,
  fileNonRimossi: 0, notificheRimosse: 0, lettureFallite: 0, account,
})

const riga = (esito: string) =>
  h.logEvento.mock.calls.find((c) => (c[2] as { esito?: string } | undefined)?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.requireStaff.mockResolvedValue({ user: { id: 'dir-1', role: 'admin', scuola_id: 'sc-1' } })
  h.links = [{ parent_id: 'p-1' }, { parent_id: 'p-2' }]
  h.anonimizzaAlunno.mockResolvedValue({
    riconciliazione: 0, incassi: 0, cassa: 0, file: 0, fileNonRimossi: 0, segnalazioniBonificate: 0,
    sospensioniBonificate: 0, iscrizioniScrubbate: 0, fotoRimosse: 0, fotoSganciate: 0,
    presenzeBonificate: 0, notificheRimosse: 0, lettureFallite: 0,
  })
})

describe('POST /api/admin/gdpr/erase — l’esito degli account dei genitori', () => {
  it('somma gli esiti di OGNI genitore orfano nella risposta e nell’audit', async () => {
    h.anonimizzaParent
      .mockResolvedValueOnce(parent('rimosso'))
      .mockResolvedValueOnce(parent('anonimizzato'))
    const res = await esegui()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({ account_rimossi: 1, account_anonimizzati: 1, account_non_liberati: 0 })
    const audit = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(audit.valoreDopo).toMatchObject({ account_rimossi: 1, account_anonimizzati: 1, account_non_liberati: 0 })
    expect(riga('oblio-eseguito'), 'tutti gli account liberati: l’oblio è completo').toBeTruthy()
    expect(riga('oblio-parziale')).toBeFalsy()
  })

  it('un account NON liberato rende l’oblio parziale: `oblio-parziale`, mai `oblio-eseguito`', async () => {
    h.anonimizzaParent
      .mockResolvedValueOnce(parent('rimosso'))
      .mockResolvedValueOnce(parent('non-riuscito'))
    const json = await (await esegui()).json()
    expect(json.account_non_liberati).toBe(1)
    const parziale = riga('oblio-parziale')
    expect(parziale, 'email e nome di una persona restano, e il log non lo dice').toBeTruthy()
    expect(parziale![1]).toBe('error')
    expect(parziale![2]).toMatchObject({ n_account_non_liberati: 1 })
    expect(riga('oblio-eseguito'), '`oblio-eseguito` scritto con un account ancora in chiaro').toBeFalsy()
  })

  it('le scelte deliberate (personale, figli vivi) non sono un oblio parziale', async () => {
    h.anonimizzaParent
      .mockResolvedValueOnce(parent('non-toccato-personale'))
      .mockResolvedValueOnce(parent('non-toccato-figli-vivi'))
    const json = await (await esegui()).json()
    expect(json).toMatchObject({ account_rimossi: 0, account_anonimizzati: 0, account_non_liberati: 0 })
    expect(riga('oblio-eseguito')).toBeTruthy()
  })
})

// =============================================================================
// LE CHIAVI CONDIVISE CON UN DOPPIONE (2026-10-09).
//
// Se il codice fiscale o il documento del bambino (o del genitore) sono anche di
// un'altra scheda viva, `anonimizzaAlunno`/`anonimizzaParent` NON li usano per
// ripulire domande d'iscrizione, bonifici e cassa — di proposito, perché sono
// anche dell'altra persona — e lo dicono in `chiaviCondiviseEscluse`. Quei dati
// restano in chiaro: l'oblio è PARZIALE, e va detto con il motivo.
// =============================================================================
describe('POST /api/admin/gdpr/erase — chiavi condivise con un’altra scheda', () => {
  const MOTIVO = 'chiave condivisa con un’altra scheda: risolvere prima il doppione'
  const alunnoCon = (chiaviCondiviseEscluse: { codiceFiscale: number; documento: number }) => ({
    riconciliazione: 0, incassi: 0, cassa: 0, file: 0, fileNonRimossi: 0, segnalazioniBonificate: 0,
    sospensioniBonificate: 0, iscrizioniScrubbate: 0, fotoRimosse: 0, fotoSganciate: 0,
    presenzeBonificate: 0, notificheRimosse: 0, lettureFallite: 0, chiaviCondiviseEscluse,
  })

  it('chiave del BAMBINO condivisa → parziale, con il motivo nella risposta e nell’audit', async () => {
    h.anonimizzaAlunno.mockResolvedValue(alunnoCon({ codiceFiscale: 1, documento: 1 }))
    h.anonimizzaParent.mockResolvedValue(parent('rimosso'))
    const json = await (await esegui()).json()
    expect(json).toMatchObject({ chiavi_condivise_escluse: 2, chiavi_condivise_motivo: MOTIVO })
    const audit = h.logScrittura.mock.calls[0][1] as { valoreDopo: Record<string, unknown> }
    expect(audit.valoreDopo).toMatchObject({ chiavi_condivise_escluse: 2, chiavi_condivise_motivo: MOTIVO })
    const parziale = riga('oblio-parziale')
    expect(parziale, 'le domande del bambino vero restano in chiaro e il log dice «eseguito»').toBeTruthy()
    expect(parziale![1]).toBe('error')
    expect(parziale![2]).toMatchObject({ n_chiavi_condivise: 2 })
    expect(riga('oblio-eseguito')).toBeFalsy()
  })

  it('chiave di un GENITORE condivisa → parziale anche se quella del bambino è sua', async () => {
    h.anonimizzaParent
      .mockResolvedValueOnce({ ...parent('rimosso'), chiaviCondiviseEscluse: { codiceFiscale: 1, documento: 0 } })
      .mockResolvedValueOnce(parent('rimosso'))
    const json = await (await esegui()).json()
    expect(json.chiavi_condivise_escluse).toBe(1)
    expect(riga('oblio-parziale')).toBeTruthy()
  })

  it('controllo: nessuna chiave condivisa → invariato, `oblio-eseguito` e nessun motivo', async () => {
    h.anonimizzaAlunno.mockResolvedValue(alunnoCon({ codiceFiscale: 0, documento: 0 }))
    h.anonimizzaParent.mockResolvedValue(parent('rimosso'))
    const json = await (await esegui()).json()
    expect(json).toMatchObject({ chiavi_condivise_escluse: 0, chiavi_condivise_motivo: null })
    expect(riga('oblio-eseguito')).toBeTruthy()
    expect(riga('oblio-parziale')).toBeFalsy()
  })
})
