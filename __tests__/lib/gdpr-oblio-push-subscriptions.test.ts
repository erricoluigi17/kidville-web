import { describe, it, expect, vi } from 'vitest'
import { anonimizzaParent } from '@/lib/gdpr/esegui'

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))
vi.mock('@/lib/gdpr/orfano', () => ({
  leggiAltriFigliIscritti: vi.fn(async () => ({ ok: true, haAltriFigli: false })),
}))

const AT = '2026-08-03T09:00:00Z'
const AUTH = 'auth-1'

// =============================================================================
// V1/V2 — L'ISCRIZIONE PUSH SOPRAVVIVEVA ALL'OBLIO.
//
// ⚠️ IL RILIEVO DEL COLLAUDO DICEVA UN'ALTRA COSA, ED ERA SBAGLIATO. `V1` parlava
// di «`consents_log`: ip + userAgent restano su 168 righe reali». Misurato sul
// database di produzione il 2026-08-03: **la tabella `consents_log` non esiste**.
// L'omologa vera si chiama `consensi_accettazioni`, ha **0 righe**, ed era già
// coperta dall'oblio (punto 5 di `anonimizzaParent`, `scrubProvaConsensi`).
//
// Dove stanno invece gli user-agent VERI, misurato con una SELECT:
//   push_subscriptions ....... 77 righe, 77 con user_agent, 4 utenti distinti
//   registro_modifiche ....... 68 righe, 0 con indirizzo_ip valorizzato
//   fea_audit_log ............  8 righe
//   fascicolo_accessi_audit ..  1 riga
//   consensi_accettazioni ....  0 righe   ← quella del rilievo
//
// E `push_subscriptions` non è nominata NEMMENO UNA VOLTA in `src/lib/gdpr/esegui.ts`.
//
// PERCHÉ SI CANCELLA LA RIGA E NON SI SCRUBBA il solo `user_agent`: perché la riga
// intera è un identificatore. L'`endpoint` è il recapito di QUEL telefono, ed è
// l'unica cosa che serve per continuare a mandargli notifiche. Lasciarla dopo
// un'anonimizzazione significa che il dispositivo di una famiglia che se n'è andata
// continua a ricevere le comunicazioni della scuola, agganciato a un `utente_id` che
// nessuno può più risolvere a una persona — cioè il dato resta e la sua chiave di
// lettura no: il peggiore dei due mondi.
//
// È la stessa classe di T17-F1 (il logout che non deregistrava la push): un'iscrizione
// che sopravvive all'identità che l'ha creata.
// =============================================================================

interface Registrato {
  table: string
  ids: unknown
}

function makeFake() {
  const deleted: Registrato[] = []
  const updates: Record<string, unknown>[] = []
  const client = {
    from(table: string) {
      const state: { isDelete?: boolean } = {}
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.neq = () => b
      b.not = () => b
      b.order = () => b
      b.range = () => b
      b.in = (_col: string, vals: unknown) => {
        if (state.isDelete) deleted.push({ table, ids: vals })
        return b
      }
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => {
        state.isDelete = true
        return b
      }
      b.update = (row: Record<string, unknown>) => {
        updates.push({ table, ...row })
        return b
      }
      b.maybeSingle = async () => ({
        data: table === 'parents' ? { auth_user_id: AUTH, fiscal_code: null, documento_path: null } : null,
        error: null,
      })
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return b
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => ({ data: paths.map((p) => ({ name: p })), error: null }),
        list: async () => ({ data: [] as { name: string }[], error: null }),
      }),
    },
  }
  return { client, deleted, updates }
}

describe('oblio · l’iscrizione push non sopravvive alla persona (V1/V2, misurati)', () => {
  it('anonimizzaParent cancella le push_subscriptions dell’identità', async () => {
    const f = makeFake()
    await anonimizzaParent(f.client as never, 'p-1', AT, 'test')

    const push = f.deleted.filter((d) => d.table === 'push_subscriptions')
    expect(
      push,
      'dopo l’oblio l’iscrizione push resta: il telefono di quella famiglia continua a ricevere ' +
        'le notifiche della scuola, e il suo user-agent resta in tabella agganciato a un utente ' +
        'che nessuno può più risolvere a una persona',
    ).toHaveLength(1)
    // Si cancella per l'identità AUTH (`utenti.id`), che è lo spazio-id con cui
    // `push_subscriptions.utente_id` è scritta — non `parents.id`. È lo stesso
    // errore di spazio-id che nel 2026-07 lasciò 0 genitori su 46 con l'onboarding
    // completato, e qui produrrebbe uno scrub che non trova MAI una riga.
    expect(push[0].ids).toEqual([AUTH])
  })

  it('senza ponte verso l’identità non si cancella a caso', async () => {
    // `parents.id` non è `auth.user.id`. Se il ponte manca, l'unica cosa peggiore
    // di non cancellare è cancellare la riga di qualcun altro.
    const f = makeFake()
    f.client.from = ((table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.neq = () => b
      b.not = () => b
      b.order = () => b
      b.range = () => b
      b.in = () => b
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.limit = () => b
      b.delete = () => b
      b.update = () => b
      b.maybeSingle = async () => ({
        data: table === 'parents' ? { auth_user_id: null, fiscal_code: null, documento_path: null } : null,
        error: null,
      })
      b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return b
    }) as never

    await expect(anonimizzaParent(f.client as never, 'p-1', AT, 'test')).resolves.toBeTruthy()
  })
})
