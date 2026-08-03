import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// V3 — DUE DECISIONI DEL TITOLARE, A UN GIORNO DI DISTANZA, CHE SI CONTRADDICONO.
//
//  · 2026-07-31, migrazione `20260731165941`, sulle 93 domande arrivate prima che
//    il modulo registrasse l'accettazione dell'informativa. Testuale: «ormai sono
//    genitori che hanno compilato e non voglio assolutamente perdere questi dati,
//    quindi voglio che siano valutati come gli altri e dovranno diventare
//    effettivi». E la migrazione conclude: «nessuna cancellazione, NESSUNA
//    RETENTION su questa tabella».
//
//  · 2026-08-01, un giorno dopo, in `retention-iscrizioni/route.ts`:
//    «24 MESI: decisione del titolare del 2026-08-01, non un default tecnico».
//
// La seconda è più recente e parla esplicitamente di retention; la prima è più
// specifica e riguarda righe precise, con una ragione scritta. Nessuna delle due
// nomina l'altra.
//
// ─── PERCHÉ QUI SI SCEGLIE DI NON CANCELLARE ────────────────────────────────
//
// Perché la cancellazione è IRREVERSIBILE e il disaccordo è reale. È lo stesso
// principio che questo repo applica già dove il danno non si torna indietro — «"non
// lo so" non vale "demolisci"» (`liberaPercorsiPubblici`): davanti a due regole che
// non concordano, si sceglie il verso che lascia decidere un essere umano, non
// quello che distrugge e poi si scusa.
//
// E c'è una ragione in più, che è quella che pesa: sono esattamente le domande
// raccolte SENZA informativa. Cancellarle in automatico significherebbe far sparire
// la prova dell'unico episodio noto di raccolta senza informativa — cioè il fatto
// che la migrazione `20260731165941` esiste apposta per conservare.
//
// NON È UN «NON FARE NIENTE»: quando una di queste righe supera la soglia, la route
// lo GRIDA con un `warn` e il conteggio. Una decisione rimandata che nessuno vede è
// una decisione presa in silenzio.
//
// ⚠️ Nessuna urgenza di calendario: le 93 righe sono del 2026-07-16, la soglia dei
// 24 mesi cade nel 2028. L'urgenza era che il codice e la migrazione dicessero la
// stessa cosa.
// =============================================================================

const CRON_SECRET = 'segreto-di-prova-non-usato-altrove'

const h = vi.hoisted(() => ({
  scadute: [] as Record<string, unknown>[],
  cancellati: [] as string[],
  colonneSelezionate: [] as string[],
  filtriEq: [] as { colonna: string; valore: unknown }[],
  eventi: [] as { livello: string; campi: Record<string, unknown> }[],
  colonnaAssente: false,
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (_evento: string, livello: string, campi: Record<string, unknown>) => {
    h.eventi.push({ livello, campi })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn().mockResolvedValue({ user: { id: 'staff' }, response: null }),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const qb: Record<string, unknown> = {}
      qb.select = (cols: string) => {
        h.colonneSelezionate.push(cols)
        return qb
      }
      qb.eq = (colonna: string, valore: unknown) => {
        h.filtriEq.push({ colonna, valore })
        return qb
      }
      for (const m of ['in', 'lt']) qb[m] = () => qb
      qb.delete = () => ({
        in: (_c: string, ids: unknown) => {
          h.cancellati.push(...(ids as string[]))
          return Promise.resolve({ error: null })
        },
      })
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          h.colonnaAssente
            ? { data: null, error: { code: '42703', message: 'column does not exist' } }
            : { data: h.scadute, error: null },
        ).then(res)
      return qb
    },
    storage: {
      from: () => ({
        remove: (p: string[]) => Promise.resolve({ data: p.map((x) => ({ name: x })), error: null }),
        list: () => Promise.resolve({ data: [], error: null }),
      }),
    },
  }),
}))

import { POST } from '@/app/api/gdpr/retention-iscrizioni/route'

const chiama = () =>
  POST(
    new Request('http://localhost/api/gdpr/retention-iscrizioni', {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }),
  )

const domanda = (id: string, senzaInformativa: boolean) => ({
  id,
  data: { children: [], adults: [] },
  raccolta_senza_informativa: senzaInformativa,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.scadute = []
  h.cancellati = []
  h.colonneSelezionate = []
  h.filtriEq = []
  h.eventi = []
  h.colonnaAssente = false
  process.env.CRON_SECRET = CRON_SECRET
})

describe('retention iscrizioni · le domande raccolte senza informativa non si cancellano da sole', () => {
  it('una domanda marcata `raccolta_senza_informativa` NON viene cancellata', async () => {
    h.scadute = [domanda('sub-93', true)]
    await chiama()
    expect(
      h.cancellati,
      'la retention automatica ha cancellato una delle 93 domande raccolte senza informativa: ' +
        'è irreversibile, e contraddice la decisione del titolare del 2026-07-31',
    ).toEqual([])
  })

  it('CONTROLLO POSITIVO — una domanda normale scaduta viene cancellata', async () => {
    // Senza questo caso, «non cancella mai niente» passerebbe il test qui sopra —
    // ed è il difetto 3 già pagato su questa stessa route.
    h.scadute = [domanda('sub-normale', false)]
    await chiama()
    expect(h.cancellati).toEqual(['sub-normale'])
  })

  it('le due si distinguono nello stesso lotto: cade quella normale, resta l’altra', async () => {
    h.scadute = [domanda('sub-93', true), domanda('sub-normale', false)]
    await chiama()
    expect(h.cancellati).toEqual(['sub-normale'])
  })

  it('il rinvio si VEDE: un `warn` con il conteggio, non un silenzio', async () => {
    h.scadute = [domanda('sub-93', true), domanda('sub-93b', true)]
    await chiama()
    const avvisi = h.eventi.filter(
      (e) => e.livello === 'warn' && e.campi.esito === 'trattenute-senza-informativa',
    )
    expect(
      avvisi,
      'una decisione rimandata che nessuno vede è una decisione presa in silenzio',
    ).toHaveLength(1)
    expect(avvisi[0].campi.n_domande).toBe(2)
  })

  it('il filtro sta ANCHE nella query, non solo in memoria', async () => {
    h.scadute = []
    await chiama()
    expect(h.colonneSelezionate.join(' ')).toContain('raccolta_senza_informativa')
    expect(h.filtriEq).toContainEqual({ colonna: 'raccolta_senza_informativa', valore: false })
  })

  it('DB E2E non migrato (42703) → si degrada senza cancellare a caso', async () => {
    // Il database E2E della CI è un progetto separato e non migrato: là la colonna
    // può non esistere. Un `42703` non deve diventare «nessuna domanda protetta».
    h.colonnaAssente = true
    const res = await chiama()
    expect(h.cancellati).toEqual([])
    expect(res.status).toBe(500)
  })
})
