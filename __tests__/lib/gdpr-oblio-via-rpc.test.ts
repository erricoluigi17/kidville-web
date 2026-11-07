import { describe, it, expect, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import {
  anonimizzaAlunno,
  obliaAllegatiChat,
  obliaFascicoloAlunno,
  obliaFotoAlunno,
  obliaIscrizioni,
  obliaPagelleAlunno,
  TABELLE_OBLIO_REGISTRO,
} from '@/lib/gdpr/esegui'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/logging/logger', async (originale) => {
  const vero = await originale<typeof import('@/lib/logging/logger')>()
  return { ...vero, logErrore: vi.fn(), logEvento: vi.fn() }
})

/**
 * COMPITO 3.6 · I SITI DI `esegui.ts` SCRIVONO IL REGISTRO SOLO DALL'RPC DELL'OBLIO.
 *
 * I test storici dell'oblio guardano la MUTAZIONE (che cosa resta nella riga) e restano verdi anche con una
 * `.from(tabella).update(…)` diretta: un finto che accetta tutte e due le strade è verde con e senza la correzione.
 * Questi invece mettono un'RPC `anno_oblio_scrivi` che NON scrive e registrano tutto: una scrittura diretta su una
 * tabella del registro dell'anno compare in `scritture` e fa rosso; l'azione e la coppia sbagliate fanno rosso.
 * Solo uuid e testi inventati.
 */

const AT = '2026-11-07T09:00:00Z'
const A = '44444444-4444-4444-8444-444444444441'
const B = '44444444-4444-4444-8444-444444444442'

/** Le tabelle del registro dell'anno che l'oblio tocca: nessuna `.from()` diretta in scrittura. */
const REGISTRO_TOCCATO = [
  'presenze', 'eventi_diario', 'chat_messages', 'galleria_media_v2', 'enrollment_submissions', 'student_documents', 'pagelle',
]

interface ArgsRpc { p_azione: string; p_tabella: string; p_colonna: string; p_valori: string[]; p_set: Record<string, unknown> | null; p_op: string }

function costruisci(db: DBFinto) {
  const chiamate: ArgsRpc[] = []
  const scritture: Scrittura[] = []
  const client = creaFintoSupabase(db, [], {
    scritture,
    rpc: {
      video_intent_oblio_alunno: () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }),
      anno_oblio_scrivi: (args) => {
        chiamate.push(args as unknown as ArgsRpc)
        return { data: (args.p_valori as unknown[]).length, error: null }
      },
    },
  }) as unknown as Record<string, unknown>
  client.storage = {
    from: () => ({
      remove: async (p: string[]) => ({ data: p.map((name) => ({ name })), error: null }),
      list: async () => ({ data: [], error: null }),
    }),
  }
  return { client: client as never, chiamate, scritture }
}

const dirette = (s: Scrittura[]) =>
  s.filter((x) => REGISTRO_TOCCATO.includes(x.tabella) && (x.operazione === 'update' || x.operazione === 'delete'))
    .map((x) => `${x.operazione} ${x.tabella}`)

describe('3.6 · esegui.ts scrive il registro dell\'anno solo da anno_oblio_scrivi', () => {
  it('foto del bambino: la foto solo sua si cancella (delete), la foto di gruppo perde il tag (update)', async () => {
    const db: DBFinto = {
      galleria_media_v2: [
        { id: 'md-1', file_url: 'uploads/u1/sola.jpg', tag_students: [A] },
        { id: 'md-2', file_url: 'uploads/u1/gruppo.jpg', tag_students: [A, B] },
      ],
    }
    const { client, chiamate, scritture } = costruisci(db)
    const r = await obliaFotoAlunno(client, A, 'test/oblio:POST')
    expect(dirette(scritture)).toEqual([])
    expect(chiamate).toContainEqual(expect.objectContaining({
      p_azione: 'update', p_tabella: 'galleria_media_v2', p_colonna: 'id', p_valori: ['md-2'], p_set: { tag_students: [B] }, p_op: 'test/oblio:POST',
    }))
    expect(chiamate).toContainEqual(expect.objectContaining({
      p_azione: 'delete', p_tabella: 'galleria_media_v2', p_colonna: 'id', p_valori: ['md-1'],
    }))
    // l'oblio NON usa la purga: `delete_cestino` ha una cintura e non vedrebbe le foto vive
    expect(chiamate.some((c) => c.p_azione === 'delete_cestino')).toBe(false)
    expect(r).toMatchObject({ fotoRimosse: 1, fotoSganciate: 1 })
  })

  it('pagelle (Ruling P42): delete|pagelle|id', async () => {
    const { client, chiamate, scritture } = costruisci({ pagelle: [{ id: 'pg-1', alunno_id: A, file_url: 'scr-1/al-1.pdf', file_ritirati: null }] })
    await obliaPagelleAlunno(client, A, 'test/oblio:POST')
    expect(dirette(scritture)).toEqual([])
    expect(chiamate).toContainEqual(expect.objectContaining({ p_azione: 'delete', p_tabella: 'pagelle', p_colonna: 'id', p_valori: ['pg-1'] }))
  })

  it('fascicolo: delete|student_documents|id (l\'oblio, non la purga)', async () => {
    const { client, chiamate, scritture } = costruisci({ student_documents: [{ id: 'sd-1', student_id: A, storage_path: 'fasc/x.pdf', file_url: null }] })
    await obliaFascicoloAlunno(client, A, 'test/oblio:POST')
    expect(dirette(scritture)).toEqual([])
    expect(chiamate).toContainEqual(expect.objectContaining({ p_azione: 'delete', p_tabella: 'student_documents', p_colonna: 'id', p_valori: ['sd-1'], p_op: 'test/oblio:POST' }))
    expect(chiamate.some((c) => c.p_azione === 'delete_cestino')).toBe(false)
  })

  it('allegati della chat: update|chat_messages|id con { attachment_url, attachment_type } a null', async () => {
    const { client, chiamate, scritture } = costruisci({
      chat_messages: [{ id: 'ms-1', thread_id: 'th-1', attachment_url: 'auth-9/uuid-referto.pdf', attachment_type: 'application/pdf' }],
    })
    await obliaAllegatiChat(client, ['th-1'], 'test/oblio:POST')
    expect(dirette(scritture)).toEqual([])
    expect(chiamate).toContainEqual(expect.objectContaining({
      p_azione: 'update', p_tabella: 'chat_messages', p_colonna: 'id', p_valori: ['ms-1'], p_set: { attachment_url: null, attachment_type: null },
    }))
  })

  it('domanda di iscrizione: update|enrollment_submissions|id, con `data` e `updated_at` nel set', async () => {
    const { client, chiamate, scritture } = costruisci({
      enrollment_submissions: [{ id: 'sub-1', data: { children: [{ codice_fiscale: 'AAABBB10A01H501X', allergie: 'inventate' }], adults: [] }, consents_log: null }],
    })
    await obliaIscrizioni(client, { codiciFiscali: ['AAABBB10A01H501X'], ramo: 'children' }, AT, 'test/oblio:POST')
    expect(dirette(scritture)).toEqual([])
    const c = chiamate.find((x) => x.p_tabella === 'enrollment_submissions')
    expect(c).toMatchObject({ p_azione: 'update', p_colonna: 'id', p_valori: ['sub-1'] })
    expect(Object.keys(c!.p_set ?? {}).sort()).toEqual(['data', 'updated_at'])
  })

  it('presenze e diario (anonimizzaAlunno): update|presenze|alunno_id, update|eventi_diario|alunno_id e per id', async () => {
    const db: DBFinto = {
      alunni: [{ id: A }],
      presenze: [{ id: 'p-1', alunno_id: A, giustificazione_testo: 'TESTO DI PROVA', note_appello: null }],
      eventi_diario: [
        { id: 'd-1', alunno_id: A, tipo_evento: 'pranzo', dettagli: {}, nota_bambino: 'NOTA DI PROVA', nota_libera: null },
        { id: 'd-2', alunno_id: A, tipo_evento: 'routine:d0d0d0d0', dettagli: { nome: 'Appunto', risposta: 'testo', valore: 'X' }, nota_bambino: null, nota_libera: null },
      ],
    }
    const { client, chiamate, scritture } = costruisci(db)
    await anonimizzaAlunno(client, { id: A }, AT, 'test/oblio:POST')
    expect(dirette(scritture)).toEqual([])
    expect(chiamate).toContainEqual(expect.objectContaining({
      p_azione: 'update', p_tabella: 'presenze', p_colonna: 'alunno_id', p_valori: [A], p_set: { giustificazione_testo: null, note_appello: null },
    }))
    expect(chiamate).toContainEqual(expect.objectContaining({
      p_azione: 'update', p_tabella: 'eventi_diario', p_colonna: 'alunno_id', p_valori: [A], p_set: { nota_bambino: null, nota_libera: null },
    }))
    expect(chiamate).toContainEqual(expect.objectContaining({
      p_azione: 'update', p_tabella: 'eventi_diario', p_colonna: 'id', p_valori: ['d-2'],
    }))
    // ogni chiamata porta l'`op` (finisce nel riepilogo che l'RPC scrive)
    expect(chiamate.every((c) => c.p_op === 'test/oblio:POST')).toBe(true)
  })
})

describe('3.6 · obliaFileDaTabella: l\'elenco letterale delle tabelle del registro', () => {
  it('contiene SOLO tabelle del registro dell\'anno (fixture tabelle-anno.json) e comprende pagelle e student_documents', () => {
    const registro = new Set(
      (JSON.parse(readFileSync(join(process.cwd(), '__tests__/fixtures/tabelle-anno.json'), 'utf8')) as { tabelle: { tabella: string }[] })
        .tabelle.map((t) => t.tabella),
    )
    for (const t of TABELLE_OBLIO_REGISTRO) expect(registro.has(t), `${t} non è nel registro dell'anno`).toBe(true)
    expect([...TABELLE_OBLIO_REGISTRO].sort()).toEqual(['pagelle', 'student_documents'])
    // le tabelle che la funzione riceve OGGI e che NON sono nel registro restano dirette
    expect(registro.has('certificati_medici')).toBe(false)
  })

  it('i chiamanti di obliaFileDaTabella passano solo queste tre tabelle (letti dal sorgente)', () => {
    const sorgente = readFileSync(join(process.cwd(), 'src/lib/gdpr/esegui.ts'), 'utf8')
    const chiamate = [...sorgente.matchAll(/obliaFileDaTabella\(supabase, \{\s*tabella: '([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(chiamate).toEqual(['certificati_medici', 'pagelle', 'student_documents'])
    for (const t of chiamate) {
      expect(TABELLE_OBLIO_REGISTRO.has(t) || t === 'certificati_medici', `tabella nuova passata a obliaFileDaTabella: ${t}`).toBe(true)
    }
  })
})
