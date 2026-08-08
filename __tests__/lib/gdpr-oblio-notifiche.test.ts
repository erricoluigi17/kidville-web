/**
 * T23 — l'oblio su richiesta (art. 17) deve togliere il nome del minore anche
 * dalla CAMPANELLA.
 *
 * IL FATTO (terzo collaudo). `src/lib/gdpr/esegui.ts` tratta sedici tabelle e
 * `notifiche` non era fra queste. Dopo un'anonimizzazione, il nome e il cognome
 * del bambino restavano leggibili nelle notifiche dei docenti — «<Nome Cognome>
 * sarà assente il <data>» — fino alla scadenza automatica.
 *
 * Ed è il canale che QUESTO ciclo ha riacceso: le notifiche `assenza_comunicata`
 * erano zero da sempre, e in un giorno sono diventate novantaquattro, ciascuna
 * con il nome del bambino nel corpo.
 *
 * ⚠️ LA SCADENZA A DODICI MESI NON È L'ART. 17, e la migrazione che l'ha
 * introdotta lo dice per iscritto: «questa migrazione chiude il "per sempre", non
 * il "subito, su richiesta". Il complemento applicativo è lavoro di chi tiene
 * src/lib/gdpr/esegui.ts». L'art. 17 chiede la cancellazione «senza
 * ingiustificato ritardo», non entro dodici mesi.
 *
 * SI CANCELLA LA RIGA, non si svuota il testo: al contrario di `presenze` — dove
 * la riga è il dato di frequenza e ciò che scade è il motivo — qui la riga È il
 * messaggio. Una notifica senza titolo e senza corpo non è un dato conservato: è
 * una riga vuota che occupa la campanella. È la stessa scelta, e la stessa
 * motivazione, della migrazione `notifiche_retention`.
 */
import { describe, it, expect } from 'vitest'
import { anonimizzaParent, anonimizzaAlunno } from '@/lib/gdpr/esegui'

interface Cfg {
  parentAuth?: string | null
  /** Le presenze del bambino: le notifiche le puntano via `entita_id`. */
  presenze?: { id: string }[]
  /** Righe di `notifiche` che la cancellazione restituisce. */
  notifiche?: { id: string }[]
  err?: Record<string, { code: string }>
}

function makeFake(cfg: Cfg) {
  const deleted: { table: string; filtri: { col: string; val: unknown }[] }[] = []
  const updates: Record<string, unknown>[] = []
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {}
      let cancella = false
      const filtri: { col: string; val: unknown }[] = []
      b.select = () => b
      b.eq = (col: string, val: unknown) => { filtri.push({ col, val }); return b }
      b.neq = () => b
      b.not = () => b
      b.in = (col: string, val: unknown) => { filtri.push({ col, val }); return b }
      b.is = () => b
      b.or = () => b
      b.ilike = () => b
      b.contains = () => b
      b.delete = () => { cancella = true; return b }
      b.update = (row: Record<string, unknown>) => { updates.push({ table, ...row }); return b }
      b.maybeSingle = async () => ({
        data: table === 'parents' ? { auth_user_id: cfg.parentAuth ?? null } : null,
        error: null,
      })
      b.then = (res: (v: unknown) => unknown) => {
        if (cancella) deleted.push({ table, filtri })
        const error = cfg.err?.[table] ?? null
        const dati = table === 'notifiche' ? (cfg.notifiche ?? []) : table === 'presenze' ? (cfg.presenze ?? []) : []
        return Promise.resolve({ data: error ? null : dati, error }).then(res)
      }
      return b
    },
    storage: { from: () => ({ remove: async () => ({ error: null }), list: async () => ({ data: [], error: null }) }) },
  }
  return { client, deleted, updates }
}

const AT = '2026-08-08T00:00:00Z'
const ALUNNO = { id: 'al-1', stato: 'non_iscritto', anonimizzato_il: null, scuola_id: 'sc-1', documento_path: null, codice_fiscale: null, fiscal_code: null }

// ─────────────────────────────────────────────────────────────────────────────
describe('anonimizzaAlunno — le notifiche che nominano il bambino', () => {
  it('cancella le righe di `notifiche` che puntano al bambino', async () => {
    const f = makeFake({ presenze: [{ id: 'pr-1' }, { id: 'pr-2' }], notifiche: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }] })
    await anonimizzaAlunno(f.client as never, ALUNNO as never, AT, 'test')
    const del = f.deleted.find((d) => d.table === 'notifiche')
    expect(del, 'dopo l’oblio il nome del minore resta in campanella fino a dodici mesi').toBeTruthy()
  })

  it('il filtro comprende l’id del bambino E gli id delle sue presenze', async () => {
    const f = makeFake({ presenze: [{ id: 'pr-1' }, { id: 'pr-2' }], notifiche: [{ id: 'n1' }] })
    await anonimizzaAlunno(f.client as never, ALUNNO as never, AT, 'test')
    const del = f.deleted.find((d) => d.table === 'notifiche')!
    const bersagli = del.filtri.find((x) => x.col === 'entita_id')?.val as unknown[]
    // `assenza_comunicata` e `giustifica_ricevuta` puntano alla PRESENZA;
    // `assenza_non_comunicata` e `mensa_saldo_basso` puntano all'ALUNNO.
    // Sono due spazi-id diversi nella stessa colonna: servono entrambi.
    expect(bersagli).toContain('al-1')
    expect(bersagli).toContain('pr-1')
    expect(bersagli).toContain('pr-2')
  })

  it('il conteggio delle notifiche rimosse arriva al chiamante', async () => {
    const f = makeFake({ presenze: [], notifiche: [{ id: 'n1' }, { id: 'n2' }] })
    const r = await anonimizzaAlunno(f.client as never, ALUNNO as never, AT, 'test')
    expect(
      (r as { notificheRimosse?: number }).notificheRimosse,
      'un oblio che non si conta non è dimostrabile a chi l’ha chiesto',
    ).toBe(2)
  })

  it('schema assente (DB E2E non migrato): degrada senza far fallire l’oblio', async () => {
    const f = makeFake({ notifiche: [], err: { notifiche: { code: 'PGRST205' } } })
    const r = await anonimizzaAlunno(f.client as never, ALUNNO as never, AT, 'test')
    expect((r as { notificheRimosse?: number }).notificheRimosse).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('anonimizzaParent — le notifiche RICEVUTE dal genitore', () => {
  it('cancella le notifiche indirizzate all’account del genitore', async () => {
    const f = makeFake({ parentAuth: 'auth-1', notifiche: [{ id: 'n1' }, { id: 'n2' }] })
    const r = await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    const del = f.deleted.find((d) => d.table === 'notifiche')
    expect(del, 'la campanella del genitore porta il nome di suo figlio').toBeTruthy()
    // Spazio-id: `notifiche.utente_id` è un `utenti.id`, non un `parents.id` —
    // la stessa trappola già pagata su `news_visualizzazioni` e `push_subscriptions`.
    expect(del!.filtri.find((x) => x.col === 'utente_id')?.val).toEqual(['auth-1'])
    expect((r as { notificheRimosse?: number }).notificheRimosse).toBe(2)
  })

  it('genitore senza account: nessuna cancellazione (non c’è un utente da colpire)', async () => {
    const f = makeFake({ parentAuth: null, notifiche: [{ id: 'n1' }] })
    await anonimizzaParent(f.client as never, 'p-1', AT, 'test')
    expect(f.deleted.find((d) => d.table === 'notifiche')).toBeFalsy()
  })
})
