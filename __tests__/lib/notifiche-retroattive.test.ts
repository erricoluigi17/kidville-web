import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { politicaNotificaOperazione } from '@/lib/storici/retroattivita'

vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))
vi.mock('@/lib/settings/module-config', () => ({ getModuleConfig: async () => ({}) }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: async () => ['docente'] }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunni: async () => new Map([['figlio', ['genitore']]]), getGenitoriDiAlunniEsito: async () => ({ completo: true, perAlunno: new Map([['figlio', ['genitore']]]) }) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ genitoriDiAlunni: async () => ['genitore'] }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

import { enqueueDiarioGenitori, enqueueNotifichePerAlunni, notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { enqueueNotifiche } from '@/lib/push/enqueue'

const staff: AppUser = { id: 'segreteria', role: 'segreteria' }
const docente: AppUser = { id: 'docente', role: 'educator' }
const ora = new Date('2026-10-14T22:30:00Z')
const contesto = (giornoCompetenza: string, attore = staff) => politicaNotificaOperazione({ attore, giornoCompetenza, ora })
let db: DBFinto
let tabelle: string[]
const client = () => creaFintoSupabase(db, tabelle)
const righe = () => db.notifiche as Record<string, unknown>[]

beforeEach(() => {
  tabelle = []
  db = { notifiche: [
    { id: 'ieri', utente_id: 'genitore', tipo: 'diario', entita_tipo: 'diario', entita_id: 'figlio', giorno_competenza: '2026-10-14', push_inviata_il: null },
    { id: 'oggi', utente_id: 'genitore', tipo: 'diario', entita_tipo: 'diario', entita_id: 'figlio', giorno_competenza: '2026-10-15', push_inviata_il: null },
  ] }
})

describe('silenzio storico delle nuove notifiche e delle pending originali', () => {
  it('una voce storica staff ritira ieri e preserva la pending di oggi senza nuovi avvisi', async () => {
    await enqueueDiarioGenitori(client(), { alunnoId: 'figlio', scuolaId: 'sede', operazione: contesto('2026-10-14') })
    expect(righe().map(r => r.id)).toEqual(['oggi'])
  })
  it('il salvataggio odierno debouncia solo oggi e conserva politica originale nella differita', async () => {
    const originale = contesto('2026-10-15')
    await enqueueDiarioGenitori(client(), { alunnoId: 'figlio', scuolaId: 'sede', operazione: originale })
    expect(righe().find(r => r.id === 'ieri')).toBeDefined()
    expect(righe().find(r => r.id === 'oggi')).toBeUndefined()
    expect(righe().filter(r => r.id !== 'ieri')).toEqual([
      expect.objectContaining({ utente_id: 'genitore', giorno_competenza: '2026-10-15', politica_operazione: originale }),
    ])
  })
  it('il docente conserva la notifica nel passato entro i propri permessi', async () => {
    await enqueueNotifichePerAlunni(client(), { alunnoIds: ['figlio'], tipo: 'valutazione', titolo: 'Aggiornamento', scuolaId: 'sede', operazione: contesto('2026-10-14', docente) })
    expect(righe()).toHaveLength(3)
  })
  it('il titolare continua a ricevere le scritture staff storiche', async () => {
    await notificaTitolariScrittura(client(), { attore: staff, sectionId: 'classe', scuolaId: 'sede', area: 'diario' })
    expect(righe().at(-1)).toMatchObject({ utente_id: 'docente', tipo: 'segreteria_scrittura' })
  })
  it('il trigger misto conserva il personale e sopprime i soli genitori risolti dagli alunni', async () => {
    await notificaEvento(client(), { tipo: 'diario', titolo: 'Aggiornamento', utenteIds: ['personale'], alunnoIds: ['figlio'], operazione: contesto('2026-10-14') })
    expect(righe().at(-1)).toMatchObject({ utente_id: 'personale' })
    expect(righe()).toHaveLength(3)
  })
  it('anche genitori con id espliciti vengono soppressi prima del debounce', async () => {
    await notificaEvento(client(), { tipo: 'diario', titolo: 'Aggiornamento', utenteIds: ['genitore'], destinatario: 'genitore', debounce: true, entitaId: 'figlio', operazione: contesto('2026-10-14') })
    expect(righe().map(r => r.id)).toEqual(['oggi'])
  })
  it('la coda protegge anche i chiamanti diretti', async () => {
    expect(await enqueueNotifiche(client(), { tipo: 'diario', titolo: 'Aggiornamento', utenteIds: ['genitore'], destinatario: 'genitore', operazione: contesto('2026-10-14') })).toBe(false)
    expect(righe()).toHaveLength(2)
    expect(tabelle).toEqual([])
  })
})
