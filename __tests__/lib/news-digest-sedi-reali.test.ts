import { describe, it, expect, vi, beforeEach } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_E2E, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_E2E } from '../fixtures/sedi'

// =============================================================================
// DIGEST MENSILE — il giro iterava anche sulla sede FINTA della CI.
//
// Audit 2026-07-31 (F7, R87). `sediBersaglio` senza argomento leggeva `scuole`
// col solo `.eq('attiva', true)`, e la sede «Kidville E2E» in produzione ha
// `attiva = true`: entrava nel ciclo, generava un'edizione e provava a spedirla
// ai suoi account `@kidville.test` (un dominio non instradabile: solo errori di
// invio contati come `errori_count`). Il predicato «sede reale» è centralizzato
// in `src/lib/scuole/reali.ts` proprio per non averne due versioni — il digest
// non lo usava.
//
// Secondo ramo: `scuolaId` passato ESPLICITAMENTE. Se è la sede di collaudo si
// rifiuta e si logga, invece di generare l'edizione in silenzio.
// =============================================================================

const logEvento = vi.fn()
const sendEmailDetailed = vi.fn(async (p: { to: string }) => ({ ok: true, error: null, to: p.to }))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))
vi.mock('@/lib/email/send', () => ({
  sendEmailDetailed: (p: { to: string }) => sendEmailDetailed(p),
}))
vi.mock('@/lib/anagrafiche/legami', () => ({
  getGenitoriDiAlunni: vi.fn(async (_s: unknown, ids: string[]) => {
    const m = new Map<string, string[]>()
    for (const id of ids) m.set(id, [`gen-${id}`])
    return m
  }),
}))

import { generaEInviaDigest } from '@/lib/news/digest'

const PUBBLICATA = '2026-06-15T10:00:00.000Z'

/** Due sedi reali + la finta E2E, ciascuna con un post pubblicato a giugno. */
function dbBase(): DBFinto {
  return {
    scuole: [
      { id: SEDE_A, nome: NOME_SEDE_A, attiva: true },
      { id: SEDE_B, nome: NOME_SEDE_B, attiva: true },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E, attiva: true },
    ],
    news_posts: [
      { id: 'p-a', titolo: 'Gita', stato: 'pubblicata', pinned: false, pubblicata_il: PUBBLICATA, scuola_id: SEDE_A, target_scope: 'globale', contenuto_testo: 'x' },
      { id: 'p-b', titolo: 'Saggio', stato: 'pubblicata', pinned: false, pubblicata_il: PUBBLICATA, scuola_id: SEDE_B, target_scope: 'globale', contenuto_testo: 'y' },
      { id: 'p-e', titolo: 'Finto', stato: 'pubblicata', pinned: false, pubblicata_il: PUBBLICATA, scuola_id: SEDE_E2E, target_scope: 'globale', contenuto_testo: 'z' },
    ],
    news_digest_edizioni: [],
    alunni: [
      // `stato` esplicito: `genitoriDiScuola` legge i soli iscritti dal 2026-08-12.
      { id: 'al-a', scuola_id: SEDE_A, stato: 'iscritto' },
      { id: 'al-b', scuola_id: SEDE_B, stato: 'iscritto' },
      { id: 'al-e', scuola_id: SEDE_E2E, stato: 'iscritto' },
    ],
    utenti: [
      { id: 'gen-al-a', email: 'a@example.test' },
      { id: 'gen-al-b', email: 'b@example.test' },
      { id: 'gen-al-e', email: 'e@example.test' },
    ],
  }
}

const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => vi.clearAllMocks())

describe('generaEInviaDigest — sedi bersaglio', () => {
  it('senza scuolaId ⇒ una edizione per ogni sede REALE, nessuna per la finta E2E', async () => {
    const db = dbBase()
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db), { anno: 2026, mese: 6 })

    expect(edizioni.map((e) => e.scuola_id).sort()).toEqual([SEDE_A, SEDE_B].sort())
    // E nel «database» non nasce nessuna edizione per la sede di collaudo.
    expect(db.news_digest_edizioni.map((r) => r.scuola_id).sort()).toEqual([SEDE_A, SEDE_B].sort())
    // Nessuna email verso un account della sede finta.
    const destinatari = sendEmailDetailed.mock.calls.map((c) => c[0].to)
    expect(destinatari.sort()).toEqual(['a@example.test', 'b@example.test'])
  })

  it('scuolaId ESPLICITO della sede di collaudo ⇒ rifiuto + log, nessuna edizione', async () => {
    const db = dbBase()
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db), {
      anno: 2026, mese: 6, scuolaId: SEDE_E2E,
    })

    expect(edizioni).toEqual([])
    expect(db.news_digest_edizioni).toEqual([])
    expect(sendEmailDetailed.mock.calls.length).toBe(0)
    const riga = logDi('sede-di-collaudo')
    expect(riga).toBeDefined()
    expect(riga?.[0]).toBe('news')
    expect(riga?.[1]).toBe('warn')
  })

  it('scuolaId esplicito di una sede reale ⇒ solo quella', async () => {
    const db = dbBase()
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db), {
      anno: 2026, mese: 6, scuolaId: SEDE_B,
    })
    expect(edizioni.map((e) => e.scuola_id)).toEqual([SEDE_B])
    expect(edizioni[0].inviata).toBe(true)
  })

  it('sede disattivata ⇒ fuori dal giro (invariato)', async () => {
    const db = dbBase()
    db.scuole = [
      { id: SEDE_A, nome: NOME_SEDE_A, attiva: true },
      { id: SEDE_B, nome: NOME_SEDE_B, attiva: false },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E, attiva: true },
    ]
    const { edizioni } = await generaEInviaDigest(creaFintoSupabase(db), { anno: 2026, mese: 6 })
    expect(edizioni.map((e) => e.scuola_id)).toEqual([SEDE_A])
  })
})
