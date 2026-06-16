import type { SupabaseClient } from '@supabase/supabase-js'
import { buildPagellaPdf, type PagellaData } from '@/lib/primaria/pagella-pdf'

export const PAGELLE_BUCKET = 'pagelle'

interface LoadResult {
  data?: PagellaData
  error?: string
  status?: number
  scuolaId?: string | null
}

// Raccoglie tutti i dati necessari alla pagella di un alunno per uno scrutinio
// chiuso: discipline → giudizio sintetico, con obiettivo della classe e giudizio
// descrittivo (derivati a runtime → si aggiornano in automatico), comportamento,
// giudizio globale e firma applicativa del dirigente.
export async function loadPagellaData(
  supabase: SupabaseClient,
  scrutinioId: string,
  alunnoId: string
): Promise<LoadResult> {
  const { data: scrutinio } = await supabase
    .from('scrutini')
    .select('id, section_id, periodo_id, stato, chiuso_da, chiuso_il')
    .eq('id', scrutinioId)
    .single()
  if (!scrutinio) return { error: 'Scrutinio non trovato', status: 404 }
  if (scrutinio.stato !== 'chiuso') return { error: 'Pagella disponibile solo a scrutinio chiuso', status: 409 }

  const [{ data: sezione }, { data: periodo }, { data: alunno }, { data: materie }, { data: giudizi }, { data: comp }, { data: obAssoc }] =
    await Promise.all([
      supabase.from('sections').select('id, name, scuola_id').eq('id', scrutinio.section_id).single(),
      supabase.from('scrutinio_periodi').select('nome, anno_scolastico').eq('id', scrutinio.periodo_id).single(),
      supabase.from('alunni').select('id, nome, cognome').eq('id', alunnoId).single(),
      supabase.from('materie').select('id, nome, codice, ordine').eq('section_id', scrutinio.section_id).eq('attiva', true).order('ordine'),
      supabase.from('scrutinio_giudizi').select('materia_id, giudizio_sintetico').eq('scrutinio_id', scrutinioId).eq('alunno_id', alunnoId),
      supabase.from('scrutinio_comportamento').select('giudizio_testo, giudizio_globale').eq('scrutinio_id', scrutinioId).eq('alunno_id', alunnoId).maybeSingle(),
      supabase.from('sezione_materia_obiettivo').select('materia_id, obiettivi_apprendimento(codice, descrizione)').eq('section_id', scrutinio.section_id),
    ])

  if (!alunno) return { error: 'Alunno non trovato', status: 404 }

  // Mappa giudizio_descrittivo per etichetta dalla scala della scuola (fallback
  // generico, usato quando manca il testo specifico di scrutinio).
  const scalaDescr = new Map<string, string>()
  if (sezione?.scuola_id) {
    const { data: scala } = await supabase
      .from('giudizi_sintetici_scala')
      .select('etichetta, giudizio_descrittivo')
      .eq('scuola_id', sezione.scuola_id)
    for (const s of scala ?? []) {
      if (s.giudizio_descrittivo) scalaDescr.set(s.etichetta, s.giudizio_descrittivo)
    }
  }

  // Giudizi descrittivi di scrutinio specifici per livello × materia × periodo ×
  // voto. Chiave: `${materia_codice}|${etichetta_voto}`. Hanno priorità sulla
  // scala generica. Il livello si deduce dal nome sezione (es. "3A" → 3).
  const scrutDescr = new Map<string, string>()
  const livello = Number(sezione?.name?.match(/[1-5]/)?.[0] ?? 0)
  if (sezione?.scuola_id && livello) {
    const { data: descr } = await supabase
      .from('scrutinio_giudizio_descrittivo')
      .select('materia_codice, etichetta_voto, giudizio_descrittivo')
      .eq('scuola_id', sezione.scuola_id)
      .eq('livello', livello)
      .eq('periodo_id', scrutinio.periodo_id)
    for (const d of descr ?? []) {
      scrutDescr.set(`${d.materia_codice}|${d.etichetta_voto}`, d.giudizio_descrittivo)
    }
  }

  // Mappa obiettivo per materia.
  type ObRow = { codice: string | null; descrizione: string }
  const obMap = new Map<string, string>()
  for (const row of (obAssoc ?? []) as { materia_id: string; obiettivi_apprendimento: ObRow | ObRow[] | null }[]) {
    const ob = Array.isArray(row.obiettivi_apprendimento) ? row.obiettivi_apprendimento[0] : row.obiettivi_apprendimento
    if (ob) obMap.set(row.materia_id, `${ob.codice ? ob.codice + ' · ' : ''}${ob.descrizione}`)
  }

  const giudMap = new Map((giudizi ?? []).map((g) => [g.materia_id, g.giudizio_sintetico]))
  const discipline = (materie ?? []).map((m) => {
    const giudizio = giudMap.get(m.id) ?? '—'
    // Priorità: testo specifico di scrutinio (livello×materia×periodo×voto),
    // poi descrittivo generico della scala.
    const specifico = m.codice ? scrutDescr.get(`${m.codice}|${giudizio}`) : undefined
    return {
      materia: m.nome,
      giudizio,
      obiettivo: obMap.get(m.id) ?? null,
      descrittivo: giudizio ? specifico ?? scalaDescr.get(giudizio) ?? null : null,
    }
  })

  let scuola: { nome?: string | null } | null = null
  if (sezione?.scuola_id) {
    const { data: s } = await supabase.from('schools').select('nome').eq('id', sezione.scuola_id).maybeSingle()
    scuola = { nome: (s as { nome?: string } | null)?.nome ?? null }
  }

  let dirigente: { nome?: string | null; cognome?: string | null } | null = null
  if (scrutinio.chiuso_da) {
    const { data: u } = await supabase.from('utenti').select('nome, cognome').eq('id', scrutinio.chiuso_da).maybeSingle()
    dirigente = u ?? null
  }

  return {
    scuolaId: sezione?.scuola_id ?? null,
    data: {
      scuolaNome: scuola?.nome ?? 'Istituto',
      classe: sezione?.name ?? '',
      anno: periodo?.anno_scolastico ?? '',
      periodo: periodo?.nome ?? '',
      alunno: `${alunno.cognome ?? ''} ${alunno.nome ?? ''}`.trim(),
      discipline,
      comportamento: comp?.giudizio_testo ?? null,
      giudizioGlobale: comp?.giudizio_globale ?? null,
      dirigente: dirigente ? `${dirigente.nome ?? ''} ${dirigente.cognome ?? ''}`.trim() : null,
      chiusoIl: scrutinio.chiuso_il ?? null,
    },
  }
}

// Archivia la pagella in Storage (bucket privato) + traccia in tabella pagelle.
export async function persistPagella(
  supabase: SupabaseClient,
  scrutinioId: string,
  alunnoId: string,
  pdf: Buffer,
  userId: string,
  data: PagellaData
): Promise<void> {
  const { data: buckets } = await supabase.storage.listBuckets()
  if (!buckets?.some((b) => b.name === PAGELLE_BUCKET)) {
    await supabase.storage.createBucket(PAGELLE_BUCKET, { public: false, allowedMimeTypes: ['application/pdf'], fileSizeLimit: 10 * 1024 * 1024 })
  }
  const path = `${scrutinioId}/${alunnoId}.pdf`
  await supabase.storage.from(PAGELLE_BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: true })
  await supabase.from('pagelle').upsert(
    {
      scrutinio_id: scrutinioId,
      alunno_id: alunnoId,
      file_url: path,
      generata_da: userId,
      firma_applicativa: { dirigente: data.dirigente, chiuso_il: data.chiusoIl, metodo: 'firma_applicativa' },
    },
    { onConflict: 'scrutinio_id,alunno_id' }
  )
}

// Genera + archivia la pagella di un alunno, ritorna il PDF.
export async function generaPagella(
  supabase: SupabaseClient,
  scrutinioId: string,
  alunnoId: string,
  userId: string,
  persist: boolean
): Promise<{ pdf?: Buffer; error?: string; status?: number }> {
  const loaded = await loadPagellaData(supabase, scrutinioId, alunnoId)
  if (loaded.error) return { error: loaded.error, status: loaded.status }
  const pdf = buildPagellaPdf(loaded.data!)
  if (persist) {
    try { await persistPagella(supabase, scrutinioId, alunnoId, pdf, userId, loaded.data!) }
    catch (e) { console.error('persist pagella:', e) }
  }
  return { pdf }
}
