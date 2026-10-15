import { it, expect, vi } from 'vitest'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { preparaContestoStorico } from '@/lib/storici/scope'
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn() }))

it('con i resolver reali la veste genitore conserva le sedi amministrative effettive', async () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', UT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const db = creaFintoSupabase({ utenti_scuole: [{ utente_id: UT, scuola_id: B }], schools: [{ id: B, nome: 'Sede B fittizia' }], alunni_classi_storico: [], alunni: [{ id: ID, scuola_id: B, nome: 'Nome', cognome: 'Fittizio', anonimizzato_il: null }] })
  const q = { scuolaId: B, alunnoId: ID, dal: '2020-01-01', al: '2020-01-31', categorie: ['diario_note'] as const, formato: 'pdf' as const, raggruppamento: 'alunno' as const }
  const utente = { id: UT, role: 'admin' as const, ruoli: ['admin', 'genitore'] as const, scuola_id: A }
  expect((await preparaContestoStorico(db, utente, { ...q, categorie: [...q.categorie] })).alunni).toHaveLength(1)
  expect((await preparaContestoStorico(db, { ...utente, role: 'genitore' }, { ...q, categorie: [...q.categorie] })).alunni).toHaveLength(1)
  await expect(preparaContestoStorico(db, { ...utente, role: 'admin', ruoli: ['genitore'] }, { ...q, categorie: [...q.categorie] })).rejects.toMatchObject({ stato: 403 })
})
