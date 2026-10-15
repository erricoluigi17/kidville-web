// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import type { ContestoStorico, DocumentoStorico, GenerazioneStorico, SezioneStorico } from '@/lib/storici/tipi'
import { espandiCategorie, type CategoriaStorico } from '@/lib/storici/catalogo'
import { loadAppUser } from '@/lib/auth/require-staff'
import { preparaContestoStorico } from '@/lib/storici/scope'
import { raccogliScolastico } from '@/lib/storici/adattatori/scolastici'
import { creaPdfStorico } from '@/lib/storici/render'
import { eseguiGenerazione, pulisciGenerazioniScadute } from '@/lib/storici/generazioni'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }))
vi.mock('@/lib/auth/require-staff', () => ({ loadAppUser: vi.fn() }))
vi.mock('@/lib/storici/scope', () => ({ preparaContestoStorico: vi.fn(), appartieneNelGiorno: vi.fn() }))
vi.mock('@/lib/storici/adattatori/scolastici', () => ({ raccogliScolastico: vi.fn() }))
vi.mock('@/lib/storici/render', () => ({ creaPdfStorico: vi.fn(), creaExcelStorico: vi.fn() }))

const SEDE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALUNNO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PREFIX = `${SEDE}/${JOB}`
const FINALE = `${PREFIX}/storico.pdf`
const user: AppUser = { id: STAFF, role: 'admin', scuola_id: SEDE }

function sezione(categoria: CategoriaStorico): SezioneStorico {
  return { categoria, titolo: categoria, colonne: [], righe: [], allegati: [], avvisi: [] }
}
function lavoro(patch: Partial<GenerazioneStorico> = {}): GenerazioneStorico {
  return { id: JOB, scuola_id: SEDE, richiesto_da: STAFF, ruolo_richiedente: 'admin', alunni_ids: [ALUNNO],
    richiesta: { scuolaId: SEDE, alunnoId: ALUNNO, dal: '2026-01-01', al: '2026-12-31', categorie: ['diario_pasti'], formato: 'pdf', raggruppamento: 'classe' },
    stato: 'in_coda', cursore: 1, tentativi: 0, preso_il: null, creato_il: new Date().toISOString(),
    scade_il: new Date(Date.now() + 1000).toISOString(), file_path: null, errore: null, avvisi: [], titolo: 'Prova', ...patch }
}

/** Applica i filtri al momento dell'await: due lettori possono contendersi davvero lo stesso CAS. */
function archivio(iniziale: GenerazioneStorico) {
  let job: GenerazioneStorico | null = structuredClone(iniziale)
  const files = new Map<string, Uint8Array>([[`${PREFIX}/parti/0.json`, Buffer.from(JSON.stringify(sezione('diario_pasti'))) ]])
  const rimozioni: string[][] = []
  let duranteUpload: ((path: string) => Promise<void>) | undefined
  const db = {
    from(tabella: string) {
      if (tabella !== 'storici_generazioni') throw new Error(`Lettura inattesa di ${tabella}`)
      let operazione = 'select', patch: Record<string, unknown> = {}, singola = false
      const filtri: Array<(r: GenerazioneStorico) => boolean> = []
      const q = {
        select() { return q },
        eq(k: string, v: unknown) { filtri.push(r => (r as unknown as Record<string, unknown>)[k] === v); return q },
        in(k: string, vs: unknown[]) { filtri.push(r => vs.includes((r as unknown as Record<string, unknown>)[k])); return q },
        gt(k: string, v: string) { filtri.push(r => String((r as unknown as Record<string, unknown>)[k]) > v); return q },
        lte(k: string, v: string) { filtri.push(r => String((r as unknown as Record<string, unknown>)[k]) <= v); return q },
        or(filtro: string) {
          const prefisso = 'preso_il.is.null,preso_il.lt.'
          if (!filtro.startsWith(prefisso)) throw new Error(`Filtro OR inatteso: ${filtro}`)
          const scaduto = filtro.slice(prefisso.length)
          filtri.push(r => r.preso_il == null || r.preso_il < scaduto); return q
        },
        order() { return q }, limit() { return q },
        update(v: Record<string, unknown>) { operazione = 'update'; patch = v; return q },
        delete() { operazione = 'delete'; return q },
        maybeSingle() { singola = true; return q },
        then<T>(risolvi: (r: { data: unknown; error: null }) => T) {
          const righe = job && filtri.every(f => f(job!)) ? [job] : []
          const data = righe.map(r => structuredClone(r))
          if (operazione === 'update') for (const r of righe) Object.assign(r, patch)
          if (operazione === 'delete' && righe.length) job = null
          return Promise.resolve({ data: singola ? data[0] ?? null : data, error: null }).then(risolvi)
        },
      }
      return q
    },
    storage: { from: () => ({
      download: async (path: string) => ({ data: files.has(path) ? new Blob([Buffer.from(files.get(path)!)]) : null, error: null }),
      upload: async (path: string, contenuto: Uint8Array) => {
        await duranteUpload?.(path)
        files.set(path, new Uint8Array(contenuto)); return { error: null }
      },
      remove: async (paths: string[]) => { rimozioni.push(paths); paths.forEach(p => files.delete(p)); return { error: null } },
    }) },
  }
  const client = db as unknown as SupabaseClient
  const ctx: ContestoStorico = { db: client, utente: user, richiesta: iniziale.richiesta,
    alunni: [{ id: ALUNNO, scuola_id: SEDE, nome: 'Nome fittizio', cognome: 'Prova', section_id: null }],
    appartenenze: [], titolo: 'Prova', scuolaNome: 'Sede fittizia', avvisi: [] }
  vi.mocked(preparaContestoStorico).mockResolvedValue(ctx)
  return { db: client, ctx, files, rimozioni, job: () => job,
    duranteUpload: (fn: (path: string) => Promise<void>) => { duranteUpload = fn } }
}

beforeEach(() => {
  vi.clearAllMocks()
  // L'orologio controllato serve a intercalare scadenza, upload e cleanup senza attese reali.
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z'))
  vi.mocked(loadAppUser).mockResolvedValue(user)
  vi.mocked(raccogliScolastico).mockImplementation(async (_ctx, categoria) => categoria === 'documenti_protocolli' ? null : sezione(categoria))
  vi.mocked(creaPdfStorico).mockImplementation(async documento => ({ bytes: new Uint8Array([37, 80, 68, 70]), avvisi: [...documento.avvisi, ...documento.sezioni.flatMap(s => s.avvisi)] }))
})
afterEach(() => { vi.useRealTimers() })

describe('generazioni storiche, lease e recupero', () => {
  it('non pulisce il lavoro attivo che scade durante il rendering e poi lo elimina senza orfani', async () => {
    const a = archivio(lavoro())
    let rimossiDuranteRender: number | undefined
    vi.mocked(creaPdfStorico).mockImplementationOnce(async () => {
      vi.advanceTimersByTime(2000)
      rimossiDuranteRender = await pulisciGenerazioniScadute(a.db)
      return { bytes: new Uint8Array([37, 80]), avvisi: [] }
    })
    await eseguiGenerazione(a.db, JOB)
    expect(rimossiDuranteRender).toBe(0)
    expect(a.files.has(FINALE)).toBe(false)
    expect(a.job()?.preso_il).toBeNull()
    expect(await pulisciGenerazioniScadute(a.db)).toBe(1)
    expect(a.job()).toBeNull()
    expect(a.files.size).toBe(0)
  })

  it('rimuove anche un upload concluso dopo la scadenza prima del salvataggio del manifest', async () => {
    const a = archivio(lavoro())
    a.duranteUpload(async path => { if (path === FINALE) vi.advanceTimersByTime(2000) })
    await eseguiGenerazione(a.db, JOB)
    expect(a.files.has(FINALE)).toBe(true)
    expect(a.job()?.file_path).toBeNull()
    expect(a.job()?.preso_il).toBeNull()
    expect(await pulisciGenerazioniScadute(a.db)).toBe(1)
    expect(a.rimozioni[0]).toContain(FINALE)
    expect(a.files.size).toBe(0)
  })

  it('recupera un lease abbandonato ed elimina il finale anche senza manifest', async () => {
    const a = archivio(lavoro({ stato: 'in_corso', scade_il: new Date(Date.now() - 1).toISOString(), preso_il: new Date(Date.now() - 331_000).toISOString() }))
    a.files.set(FINALE, new Uint8Array([37, 80]))
    expect(await pulisciGenerazioniScadute(a.db)).toBe(1)
    expect(a.files.size).toBe(0)
  })

  it('due cleanup concorrenti prendono una sola volta lo stesso lavoro', async () => {
    const a = archivio(lavoro({ scade_il: new Date(Date.now() - 1).toISOString() }))
    expect((await Promise.all([pulisciGenerazioniScadute(a.db), pulisciGenerazioniScadute(a.db)])).sort()).toEqual([0, 1])
    expect(a.rimozioni).toHaveLength(1)
  })

  it('riparte dal cursore salvato conservando le sezioni già raccolte', async () => {
    const j = lavoro(); j.richiesta.categorie = ['diario_pasti', 'diario_sonno']
    const a = archivio(j)
    await eseguiGenerazione(a.db, JOB)
    expect(vi.mocked(raccogliScolastico).mock.calls.map(c => c[1])).toEqual(['diario_sonno'])
    expect(vi.mocked(creaPdfStorico).mock.calls[0][0].sezioni.map(s => s.categoria)).toEqual(['diario_pasti', 'diario_sonno'])
    expect(a.job()).toMatchObject({ stato: 'completato', cursore: 2, file_path: FINALE })
  })
  it('conta tre guasti consecutivi anche se il primo segue un avanzamento del cursore', async () => {
    const a = archivio(lavoro({ cursore: 0 }))
    vi.mocked(creaPdfStorico).mockRejectedValue(new Error('Errore simulato impaginazione'))
    for (let i = 1; i <= 3; i++) {
      await eseguiGenerazione(a.db, JOB)
      expect(a.job()?.tentativi).toBe(i)
    }
    expect(a.job()?.stato).toBe('errore')
    expect(vi.mocked(raccogliScolastico)).toHaveBeenCalledTimes(1)
    await eseguiGenerazione(a.db, JOB)
    expect(vi.mocked(creaPdfStorico)).toHaveBeenCalledTimes(3)
  })

  it('segnala parziale il dossier del coordinatore che esclude i protocolli riservati', async () => {
    const j = lavoro({ cursore: 0, ruolo_richiedente: 'coordinator' }); j.richiesta.categorie = ['dossier_completo']
    const a = archivio(j)
    a.ctx.utente = { ...user, role: 'coordinator' }
    vi.mocked(loadAppUser).mockResolvedValue(a.ctx.utente)
    await eseguiGenerazione(a.db, JOB)
    const documento = vi.mocked(creaPdfStorico).mock.calls[0]?.[0] as DocumentoStorico
    expect(documento.sezioni.map(s => s.categoria)).toEqual(espandiCategorie(['dossier_completo']))
    expect(documento.sezioni.find(s => s.categoria === 'documenti_protocolli')).toMatchObject({ righe: [], allegati: [], avvisi: [expect.stringContaining('riservato')] })
    expect(a.job()).toMatchObject({ stato: 'parziale', avvisi: [expect.stringContaining('riservato')] })
  })
})
