import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enqueueDiarioGenitori } from '@/lib/primaria/notifiche'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { oggiRoma } from '@/lib/storici/retroattivita'
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))

// P4/DL-040: la notifica diario al genitore ha buffer 10' (= finestra di modifica)
// con DEBOUNCE: i salvataggi successivi entro 10' rimuovono la notifica pending e
// ne ri-accodano una sola, così il genitore riceve un'unica notifica con lo stato finale.

const h = vi.hoisted(() => ({ db: {} as DBFinto, scritture: [] as Scrittura[] }))
const makeClient = () => creaFintoSupabase(h.db, [], { scritture: h.scritture })
const inserts = () => h.scritture.filter(s => s.tabella === 'notifiche' && s.operazione === 'insert').flatMap(s => s.valori)
const deletes = () => h.scritture.filter(s => s.tabella === 'notifiche' && s.operazione === 'delete')

beforeEach(() => {
  h.scritture = []
  h.db = {
    alunni: [{ id: 'a1', scuola_id: 'sede' }],
    legame_genitori_alunni: [{ genitore_id: 'p1', alunno_id: 'a1' }],
    notifiche: [{ id: 'pending', tipo: 'diario', utente_id: 'p1', entita_id: 'a1', entita_tipo: 'diario', push_inviata_il: null, giorno_competenza: oggiRoma() }],
  }
})

describe('enqueueDiarioGenitori', () => {
  it('il debounce ordinario lascia intatta la notifica presa in carico dal dispatcher', async () => {
    h.db.notifiche.push({ id: 'claim', tipo: 'diario', utente_id: 'p1', entita_id: 'a1', entita_tipo: 'diario', giorno_competenza: oggiRoma(), push_inviata_il: new Date().toISOString(), push_presa_scade_il: new Date(Date.now() + 600_000).toISOString() })
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Nome fittizio' })
    expect(h.db.notifiche.find(n => n.id === 'claim')).toBeDefined()
    expect(h.db.notifiche.find(n => n.id === 'pending')).toBeUndefined()
    expect(inserts()).toHaveLength(1)
  })
  it('debounce: rimuove le notifiche diario pending del figlio prima di accodare', async () => {
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Sofia' })
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].colpite.map(r => r.id)).toEqual(['pending'])
    expect(h.db.notifiche.find(r => r.id === 'pending')).toBeUndefined()
  })

  it('accoda 1 notifica al genitore con entita_id=alunno e buffer 10′', async () => {
    const before = Date.now()
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Sofia' })
    expect(inserts()).toHaveLength(1)
    const row = inserts()[0]
    expect(row).toMatchObject({ utente_id: 'p1', tipo: 'diario', entita_tipo: 'diario', entita_id: 'a1' })
    const programmato = new Date(row.invio_programmato_il as string).getTime()
    expect(programmato).toBeGreaterThanOrEqual(before + 9 * 60_000)
    expect(programmato).toBeLessThanOrEqual(before + 11 * 60_000)
  })

  it('il tocco sulla notifica apre il diario DI QUEL figlio, non la home', async () => {
    // 2026-09-28: le 10.247 notifiche diario dal 21/09 avevano tutte `link` NULL, e il
    // dispatcher manda allora `url: '/'`. Il genitore finiva sulla home, e con due figli
    // sulla pagina di quello selezionato l'ultima volta — magari l'altro.
    // `?id=` è la convenzione di `withIdentity`: `useParentIdentity` lo rivalida contro i
    // figli veri del genitore, quindi un id non suo non apre niente di altrui.
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Sofia' })
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0].link).toBe('/parent/diary?id=a1')
  })

  it('nessun genitore verificato → nessun insert e nessuna cancellazione della coda altrui', async () => {
    h.db.legame_genitori_alunni = []
    await enqueueDiarioGenitori(makeClient() as never, { alunnoId: 'a1', nome: 'Sofia' })
    expect(inserts()).toHaveLength(0)
    expect(deletes()).toHaveLength(0)
    expect(h.db.notifiche.map(r => r.id)).toEqual(['pending'])
  })
})
