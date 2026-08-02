/**
 * Gli endpoint pericolosi sono sigillati OVUNQUE, non solo in produzione.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL GUASTO. Collaudo del 2026-07-31, sicurezza W11: `sealDangerous` decideva su
 * `process.env.NODE_ENV === 'production'`. Sembra prudente, e in questo repo è il
 * contrario, per una ragione che sta scritta in AGENTS.md e in `.env.local`: **il dev
 * server locale gira in `development` e parla col database di PRODUZIONE**. In quella
 * configurazione — che è la configurazione normale di chi sviluppa qui —
 * `/api/admin/wipe`, `/api/admin/apply-migration`, `/api/debug-supabase` e gli altri sei
 * NON rispondevano 404: rispondevano al gate `requireStaff(['admin'])` e agivano sui dati
 * veri. Il collaudo l'ha misurato: anon, genitore, segreteria ed educator erano respinti,
 * quindi il presidio reggeva — ma «il margine è un solo account admin», e
 * `admin/wipe:POST` cancella `pagamenti`, `presenze`, `eventi_diario`, `valutazioni` e
 * `galleria_media` di 152 minori veri.
 *
 * IL VERSO GIUSTO. Un sigillo che si apre da solo nell'ambiente meno controllato è un
 * sigillo al contrario. Ora è chiuso ovunque e l'UNICA eccezione è `NODE_ENV === 'test'`,
 * cioè vitest — dove non esiste nessun database: i client Supabase sono mock, e l'unica
 * cosa che questi test possono dimostrare è che il gate di ruolo esiste ancora.
 *
 * COSA ASSERISCE QUESTO FILE. Non lo status da solo: la **mutazione**. Sotto il sigillo
 * `requireStaff` non viene nemmeno interrogata e `createClient` non viene mai chiamato —
 * nessuna connessione al database di produzione viene aperta. Un 404 restituito DOPO aver
 * cancellato le tabelle passerebbe un test scritto sullo status.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-08-01): rimettendo
 * `if (process.env.NODE_ENV === 'production')` in `src/lib/security/seal.ts` il caso
 * «development» torna rosso — 403 invece di 404, `requireStaff` chiamata, cioè la rotta
 * arriva viva fino al gate esattamente com'era.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: vi.fn() }))

const supa = vi.hoisted(() => ({ createClient: vi.fn(() => ({})) }))
vi.mock('@supabase/supabase-js', () => supa)

import { requireStaff } from '@/lib/auth/require-staff'
import * as wipe from '@/app/api/admin/wipe/route'
import * as debugSupabase from '@/app/api/debug-supabase/route'

/** Il gate risponderebbe 403: se lo si vede, vuol dire che il sigillo ha lasciato passare. */
const negato = () => ({ response: NextResponse.json({ error: 'denied' }, { status: 403 }) }) as never

/** Il gate risponderebbe OK: serve a dimostrare che sotto il sigillo non viene nemmeno chiesto. */
const ammesso = () => ({ user: { id: 'admin-1', role: 'admin' } }) as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireStaff).mockResolvedValue(ammesso())
})
afterEach(() => vi.unstubAllEnvs())

describe('sigillo degli endpoint pericolosi — chiuso ovunque, non solo in produzione', () => {
  it.each(['development', 'production'] as const)(
    'admin/wipe in NODE_ENV=%s → 404, gate mai interrogato, nessuna connessione al DB',
    async (ambiente) => {
      vi.stubEnv('NODE_ENV', ambiente)

      const res = await wipe.POST(new Request('http://localhost/api/admin/wipe', { method: 'POST' }))

      expect(res.status).toBe(404)
      // Le due asserzioni che contano: il sigillo arriva PRIMA di tutto.
      expect(
        requireStaff,
        'il sigillo ha lasciato arrivare la richiesta fino al gate di ruolo',
      ).not.toHaveBeenCalled()
      expect(
        supa.createClient,
        'è stata aperta una connessione al database (che in locale è quello di PRODUZIONE)',
      ).not.toHaveBeenCalled()
    },
  )

  it('debug-supabase in NODE_ENV=development → 404 (era la rotta rimasta viva)', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const res = await debugSupabase.GET(new Request('http://localhost/api/debug-supabase'))
    expect(res.status).toBe(404)
    expect(requireStaff).not.toHaveBeenCalled()
  })

  it('il sigillo NON è un 404 incondizionato: sotto vitest il gate di ruolo c’è ancora (controllo positivo)', () => {
    // Senza questo controllo, `return 404` scritto in cima alla funzione renderebbe verdi
    // tutte le asserzioni qui sopra pur avendo cancellato il gate: «respinto dal sigillo» e
    // «respinto dal gate» hanno lo stesso colore, e solo uno dei due sopravvive a un
    // domani in cui il sigillo si allenta.
    expect(process.env.NODE_ENV).toBe('test')
  })

  it('sotto vitest la richiesta arriva al gate, che nega ai non-admin', async () => {
    vi.mocked(requireStaff).mockResolvedValue(negato())
    const res = await debugSupabase.GET(new Request('http://localhost/api/debug-supabase'))
    expect(res.status).toBe(403)
    expect(requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin'])
  })
})
