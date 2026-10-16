// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import type { ContestoStorico, DocumentoStorico, GenerazioneStorico, SezioneStorico } from '@/lib/storici/tipi'
import { espandiCategorie, type CategoriaStorico } from '@/lib/storici/catalogo'
import { loadAppUser } from '@/lib/auth/require-staff'
import { preparaContestoStorico } from '@/lib/storici/scope'
import { raccogliScolastico } from '@/lib/storici/adattatori/scolastici'
import { creaExcelStorico, creaPdfStorico } from '@/lib/storici/render'
import { eseguiGenerazione, pulisciGenerazioniScadute, raggruppaPerAlunno } from '@/lib/storici/generazioni'
import { firmaRuoliStorico } from '@/lib/storici/permessi'
import { logEvento } from '@/lib/logging/logger'

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
const CATEGORIE_REGISTRO = ['primaria_registro', 'primaria_compiti', 'primaria_firme', 'documenti_didattici'] as const

function sezione(categoria: CategoriaStorico): SezioneStorico {
  return { categoria, titolo: categoria, colonne: [], righe: [], allegati: [], avvisi: [],
    ...((CATEGORIE_REGISTRO as readonly CategoriaStorico[]).includes(categoria) ? { _versione_raccolta: 1 } : {}) }
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
  it('mette le lezioni comuni in testa una volta e crea solo schede con contenuti personali', () => {
    const a = archivio(lavoro()), altro = 'altro-alunno'
    a.ctx.richiesta = { ...a.ctx.richiesta, alunnoId: undefined, sectionId: SEDE, raggruppamento: 'alunno' }
    a.ctx.alunni.push({ ...a.ctx.alunni[0], id: altro, nome: 'Altro' })
    const s = sezione('primaria_registro')
    s.righe = [{ _ambito: 'classe', _registro_id: 'lezione', argomento: 'Comune' },
      { _ambito: 'alunno', _alunno_id: ALUNNO, _firma_id: 'firma', argomento: 'Personale' }]
    s.allegati = [{ bucket: 'registro-allegati', percorso: 'comune.pdf', nome: 'comune.pdf' },
      { bucket: 'registro-allegati', percorso: 'personale.pdf', nome: 'personale.pdf', alunnoId: ALUNNO }]
    const risultato = raggruppaPerAlunno([s], a.ctx)
    expect(risultato).toHaveLength(2)
    expect(risultato[0].righe).toEqual([s.righe[0]])
    expect(risultato[0].allegati).toEqual([s.allegati[0]])
    expect(risultato[1].titolo).toContain('Prova Nome fittizio')
    expect(risultato[1].righe).toEqual([s.righe[1]])
    expect(risultato[1].allegati).toEqual([s.allegati[1]])
  })

  it('non genera schede vuote quando il registro contiene solo lezioni comuni', () => {
    const a = archivio(lavoro())
    a.ctx.richiesta = { ...a.ctx.richiesta, alunnoId: undefined, sectionId: SEDE, raggruppamento: 'alunno' }
    a.ctx.alunni.push({ ...a.ctx.alunni[0], id: 'altro-alunno' })
    const s = sezione('primaria_registro')
    s.righe = [{ _ambito: 'classe', _registro_id: 'lezione', argomento: 'Comune' }]
    expect(raggruppaPerAlunno([s], a.ctx).map(s => s.righe)).toEqual([s.righe])
  })

  it('conserva righe senza ambito esplicito e sezioni vuote delle altre categorie', () => {
    const a = archivio(lavoro())
    a.ctx.richiesta = { ...a.ctx.richiesta, alunnoId: undefined, sectionId: SEDE, raggruppamento: 'alunno' }
    const s = sezione('diario_pasti'), vuota = sezione('diario_sonno')
    s.righe = [{ valore: 'Dato condiviso legacy' }]
    expect(raggruppaPerAlunno([s, vuota], a.ctx)).toEqual([
      { ...s, titolo: `Prova Nome fittizio — ${s.titolo}`, generati: undefined },
      { ...vuota, titolo: `Prova Nome fittizio — ${vuota.titolo}`, generati: undefined },
    ])
  })

  it('non moltiplica le categorie registro vuote e raccoglie una sola volta anche i soli allegati comuni', () => {
    const a = archivio(lavoro())
    a.ctx.richiesta = { ...a.ctx.richiesta, alunnoId: undefined, sectionId: SEDE, raggruppamento: 'alunno' }
    a.ctx.alunni = Array.from({ length: 25 }, (_, i) => ({ ...a.ctx.alunni[0], id: `alunno-${i}` }))
    const s = sezione('primaria_registro')
    s.allegati = [{ bucket: 'registro-allegati', percorso: 'solo-allegato.pdf', nome: 'solo-allegato.pdf' }]
    const risultato = raggruppaPerAlunno([s, sezione('primaria_compiti'), sezione('primaria_firme'), sezione('documenti_didattici')], a.ctx)
    expect(risultato).toHaveLength(1)
    expect(risultato[0].allegati).toEqual(s.allegati)
    expect(risultato[0].titolo).toContain('contenuti comuni di classe')
  })

  it('mantiene la sezione comune nel dossier di un singolo alunno', () => {
    const a = archivio(lavoro()), s = sezione('primaria_registro')
    a.ctx.richiesta.raggruppamento = 'alunno'
    s.righe = [{ _ambito: 'classe', _registro_id: 'lezione', argomento: 'Comune' }]
    expect(raggruppaPerAlunno([s], a.ctx)).toEqual([s])
  })

  it('riporta gli avvisi di copertura una volta anche con sole firme personali e ignora schede vuote', () => {
    const a = archivio(lavoro())
    a.ctx.richiesta = { ...a.ctx.richiesta, alunnoId: undefined, sectionId: SEDE, raggruppamento: 'alunno' }
    a.ctx.alunni.push({ ...a.ctx.alunni[0], id: 'altro-alunno' })
    const s = sezione('primaria_firme')
    s.righe = [{ _ambito: 'alunno', _alunno_id: ALUNNO, argomento: 'Personale' }]
    s.avvisi = ['Copertura delle appartenenze incompleta']
    const risultato = raggruppaPerAlunno([s], a.ctx)
    expect(risultato.filter(s => s.titolo.includes('contenuti comuni'))).toHaveLength(1)
    expect(risultato.filter(s => s.titolo.includes('Prova Nome fittizio'))).toHaveLength(1)
    expect(risultato.filter(s => s.titolo.includes('altro-alunno'))).toHaveLength(0)
    expect(risultato.flatMap(s => s.avvisi)).toEqual(s.avvisi)
    expect(risultato).toHaveLength(2)
  })

  it('ricostruisce dalla fonte le parti registro legacy prima del rendering', async () => {
    const j = lavoro({ cursore: 4 }); j.richiesta.categorie = [...CATEGORIE_REGISTRO]
    const a = archivio(j)
    CATEGORIE_REGISTRO.forEach((categoria, i) => a.files.set(`${PREFIX}/parti/${i}.json`, Buffer.from(JSON.stringify({
      categoria, titolo: categoria, colonne: [], righe: [{ _alunno_id: ALUNNO, argomento: 'Legacy duplicato' }], allegati: [], avvisi: [],
    }))))
    vi.mocked(raccogliScolastico).mockImplementation(async (_ctx, categoria) => ({ ...sezione(categoria), righe: [{ _ambito: 'classe', _registro_id: categoria, argomento: 'Raccolto dalla fonte' }] }))
    await eseguiGenerazione(a.db, JOB)
    expect(vi.mocked(raccogliScolastico).mock.calls.map(c => c[1])).toEqual(CATEGORIE_REGISTRO)
    const documento = vi.mocked(creaPdfStorico).mock.calls[0][0]
    expect(documento.sezioni.every(s => s._versione_raccolta === 1 && s.righe.length === 1 && s.righe[0]._ambito === 'classe')).toBe(true)
    expect(JSON.stringify(documento)).not.toContain('Legacy duplicato')
    CATEGORIE_REGISTRO.forEach((categoria, i) => {
      expect(JSON.parse(Buffer.from(a.files.get(`${PREFIX}/parti/${i}.json`)!).toString())).toMatchObject({ categoria, _versione_raccolta: 1 })
      expect(logEvento).toHaveBeenCalledWith('registro', 'info', expect.objectContaining({ operazione: 'storici/ricostruisci-parte', tipo: categoria, entita_id: JOB }))
    })
    expect(a.job()).toMatchObject({ stato: 'completato', cursore: 4, preso_il: null })
  })

  it('riusa le parti registro già raccolte con la versione corrente', async () => {
    const j = lavoro(); j.richiesta.categorie = ['primaria_registro']
    const a = archivio(j)
    a.files.set(`${PREFIX}/parti/0.json`, Buffer.from(JSON.stringify(sezione('primaria_registro'))))
    await eseguiGenerazione(a.db, JOB)
    expect(raccogliScolastico).not.toHaveBeenCalled()
    expect(a.job()?.stato).toBe('completato')
  })

  it('non sovrascrive una parte legacy se il lease cambia durante la ricostruzione', async () => {
    const j = lavoro(); j.richiesta.categorie = ['primaria_registro']
    const a = archivio(j), vecchiaParte = Buffer.from(JSON.stringify({ ...sezione('primaria_registro'), _versione_raccolta: undefined }))
    a.files.set(`${PREFIX}/parti/0.json`, vecchiaParte)
    vi.mocked(raccogliScolastico).mockImplementationOnce(async (_ctx, categoria) => {
      a.job()!.preso_il = 'lease-di-un-altro-processo'
      return sezione(categoria)
    })
    await eseguiGenerazione(a.db, JOB)
    expect(a.files.get(`${PREFIX}/parti/0.json`)).toEqual(vecchiaParte)
    expect(creaPdfStorico).not.toHaveBeenCalled()
    expect(a.job()?.preso_il).toBe('lease-di-un-altro-processo')
  })

  it('salva la parte legacy ricostruita e rilascia il lease quando esaurisce il tempo', async () => {
    const j = lavoro({ cursore: 2 }); j.richiesta.categorie = ['primaria_registro', 'primaria_compiti']
    const a = archivio(j)
    j.richiesta.categorie.forEach((categoria, i) => a.files.set(`${PREFIX}/parti/${i}.json`, Buffer.from(JSON.stringify({
      ...sezione(categoria), _versione_raccolta: undefined,
    }))))
    vi.mocked(raccogliScolastico).mockImplementation(async (_ctx, categoria) => {
      vi.advanceTimersByTime(11)
      return sezione(categoria)
    })
    await eseguiGenerazione(a.db, JOB, 10)
    expect(vi.mocked(raccogliScolastico).mock.calls.map(c => c[1])).toEqual(['primaria_registro'])
    expect(creaPdfStorico).not.toHaveBeenCalled()
    expect(a.job()).toMatchObject({ stato: 'in_coda', cursore: 2, tentativi: 0, preso_il: null })
    expect(JSON.parse(Buffer.from(a.files.get(`${PREFIX}/parti/0.json`)!).toString())._versione_raccolta).toBe(1)
    await eseguiGenerazione(a.db, JOB)
    expect(vi.mocked(raccogliScolastico).mock.calls.map(c => c[1])).toEqual(['primaria_registro', 'primaria_compiti'])
    expect(a.job()?.stato).toBe('completato')
  })

  it('attende il renderer Excel asincrono prima di caricare il file', async () => {
    const j = lavoro(); j.richiesta.formato = 'xlsx'
    const a = archivio(j), bytes = new Uint8Array([80, 75, 3, 4])
    vi.mocked(creaExcelStorico).mockImplementation(async () => bytes)
    await eseguiGenerazione(a.db, JOB)
    expect(a.files.get(`${PREFIX}/storico.xlsx`)).toEqual(bytes)
    expect(a.job()?.stato).toBe('completato')
  })

  it('genera un lavoro creato nella veste genitore quando il loader rilegge solo il ruolo di lavoro', async () => {
    const attore: AppUser = { ...user, role: 'genitore', ruoli: ['admin', 'genitore'] }
    const a = archivio(lavoro({ ruolo_richiedente: firmaRuoliStorico(attore) }))
    vi.mocked(loadAppUser).mockResolvedValue({ ...user, role: 'admin' })
    await eseguiGenerazione(a.db, JOB)
    expect(a.job()).toMatchObject({ stato: 'completato', file_path: FINALE })
  })
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

  it('la cancellazione dell’account durante l’upload conserva il lease e permette di eliminare ogni file', async () => {
    const a = archivio(lavoro())
    a.duranteUpload(async path => {
      if (path !== FINALE) return
      Object.assign(a.job()!, { richiesto_da: null, stato: 'errore', scade_il: new Date(Date.now() - 1).toISOString() })
      expect(await pulisciGenerazioniScadute(a.db)).toBe(0)
    })
    await eseguiGenerazione(a.db, JOB)
    expect(a.files.has(FINALE)).toBe(true)
    expect(a.job()?.richiesto_da).toBeNull()
    expect(a.job()?.preso_il).toBeNull()
    expect(await pulisciGenerazioniScadute(a.db)).toBe(1)
    expect(a.job()).toBeNull()
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
