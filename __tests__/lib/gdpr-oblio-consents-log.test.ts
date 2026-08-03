import { describe, it, expect, vi } from 'vitest'
import { obliaIscrizioni } from '@/lib/gdpr/esegui'

vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn() }))

const AT = '2026-08-03T09:00:00Z'
const CF = 'AAABBB10A01H501X'

// =============================================================================
// V1 — L'IP E LO USER-AGENT DELLA FAMIGLIA SOPRAVVIVEVANO ALL'OBLIO.
//
// `enrollment_submissions.consents_log` è una colonna JSONB con la prova
// dell'accettazione dell'informativa. Forma misurata in produzione il 2026-08-03
// (sole CHIAVI, nessun valore letto):
//     { accettato_il, blocchi, ip, userAgent, versione_informativa }
//
// Quante righe la portano, misurato lo stesso giorno: **170 su 263**, tutte e 170
// con `ip` E `userAgent`. Il tester ne aveva contate 168 due giorni prima: il
// rilievo era ESATTO, ed è cresciuto di due mentre lo si discuteva.
//
// `obliaIscrizioni` riscriveva `data` — nome, codice fiscale, allergie, note
// mediche — e lasciava `consents_log` intatto. Dopo un oblio la domanda risultava
// anonimizzata e l'indirizzo di rete da cui quella famiglia l'aveva compilata
// restava in tabella, agganciato a una riga che nessun altro dato identifica più.
//
// COSA RESTA E PERCHÉ. Si tolgono `ip` e `userAgent`; restano `accettato_il`,
// `versione_informativa` e `blocchi`. Sono LORO la prova che l'informativa è stata
// accettata (art. 5 §2 e art. 7 §1 GDPR) — non l'indirizzo di rete, che non
// dimostra niente di più e identifica una persona. È la stessa scelta già fatta
// per `consensi_accettazioni` in `scrubProvaConsensi`: una regola valida per due
// archivi non deve avere due risposte diverse.
// =============================================================================

interface Riga {
  id: string
  data: unknown
  consents_log: unknown
}

function makeFake(righe: Riga[]) {
  const updates: { id: string; row: Record<string, unknown> }[] = []
  let ultimoId = ''
  const client = {
    from() {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.contains = () => b
      b.eq = (_c: string, v: string) => {
        ultimoId = v
        return b
      }
      b.update = (row: Record<string, unknown>) => {
        // `eq` arriva DOPO `update` nella catena PostgREST: l'id si legge alla
        // risoluzione, non qui.
        Promise.resolve().then(() => undefined)
        b.__row = row
        return b
      }
      b.then = (res: (v: unknown) => unknown) => {
        const row = b.__row as Record<string, unknown> | undefined
        if (row) {
          updates.push({ id: ultimoId, row })
          b.__row = undefined
          return Promise.resolve({ data: null, error: null }).then(res)
        }
        return Promise.resolve({ data: righe, error: null }).then(res)
      }
      return b
    },
  }
  return { client, updates }
}

const domanda = () => ({
  children: [{ nome: 'Bambino', cognome: 'DiProva', codice_fiscale: CF, allergie: 'inventate' }],
  adults: [],
})

const provaConsenso = () => ({
  accettato_il: '2026-07-20T10:00:00Z',
  versione_informativa: 'v2',
  blocchi: { trattamento: true, foto: false },
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
})

describe('oblio · la prova del consenso resta, l’indirizzo di rete no (V1, misurato)', () => {
  it('toglie ip e userAgent da consents_log quando scrubba la domanda', async () => {
    const f = makeFake([{ id: 'sub-1', data: domanda(), consents_log: provaConsenso() }])
    await obliaIscrizioni(f.client as never, { codiciFiscali: [CF], documentoPaths: [] }, AT, 'test')

    const scritte = f.updates.filter((u) => u.row.consents_log !== undefined)
    expect(
      scritte,
      'dopo l’oblio l’ip e lo user-agent della famiglia restano in `consents_log`: la domanda ' +
        'risulta anonimizzata e l’indirizzo da cui è stata compilata è ancora lì',
    ).toHaveLength(1)

    const log = scritte[0].row.consents_log as Record<string, unknown>
    expect(log.ip, 'l’indirizzo di rete non è la prova del consenso').toBeUndefined()
    expect(log.userAgent).toBeUndefined()
    // La PROVA resta: è quella che regge l'art. 7 §1, non l'ip.
    expect(log.accettato_il).toBe('2026-07-20T10:00:00Z')
    expect(log.versione_informativa).toBe('v2')
    expect(log.blocchi).toEqual({ trattamento: true, foto: false })
  })

  it('una domanda senza consents_log non viene toccata su quella colonna', async () => {
    // Sono le 93 raccolte prima dell'informativa: `consents_log IS NULL`. Scrivere
    // `{}` al posto di `null` cancellerebbe la differenza fra «non accettata» e
    // «accettata e poi ripulita» — cioè il fatto storico che la migrazione
    // 20260731165941 esiste apposta per conservare.
    const f = makeFake([{ id: 'sub-2', data: domanda(), consents_log: null }])
    await obliaIscrizioni(f.client as never, { codiciFiscali: [CF], documentoPaths: [] }, AT, 'test')

    const scritte = f.updates.filter((u) => u.row.consents_log !== undefined)
    expect(scritte).toHaveLength(0)
  })
})
