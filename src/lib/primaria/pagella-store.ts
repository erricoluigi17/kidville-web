import type { SupabaseClient } from '@supabase/supabase-js'
import { buildPagellaPdf, type PagellaData } from '@/lib/primaria/pagella-pdf'
import { logEvento } from '@/lib/logging/logger'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
import { tabellaMancante } from '@/lib/db/tolleranza-schema'
import { guastoLetturaAccessoria } from '@/lib/db/guasto'

export const PAGELLE_BUCKET = 'pagelle'

/**
 * UN GUASTO NON È UNA PAGELLA PIÙ CORTA (fase 11, «errori non ignorati»).
 *
 * PostgREST non lancia. Qui un `{ data: null, error }` diventava «Scrutinio non trovato» (404),
 * discipline senza giudizio («—»), descrittivi assenti, «Istituto» al posto del nome della
 * scuola, una firma del dirigente vuota — su un documento ufficiale che si archivia e che la
 * famiglia firma per ricevuta. Il contratto resta `{ error, status }`: un guasto è `status: 500`
 * con la sua riga `error`.
 *
 * `PGRST116` è il «nessuna riga» di `.single()`: resta il 404 (o il ripiego) di prima.
 * Le tre letture di TESTI DI CORREDO (scala dei descrittivi, descrittivi di scrutinio, obiettivi)
 * degradano come prima solo se allo schema manca la tabella o la colonna (il DB E2E della CI non
 * è migrato), con una riga `info`; ogni altro guasto ferma la pagella.
 */
const OPERAZIONE_LOAD = 'primaria/pagella-store:loadPagellaData'
const NESSUNA_RIGA = 'PGRST116'

function codiceDi(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code
}

function guastoDb(esito: string, error: unknown): { error: string; status: number } {
  logEvento('pagella', 'error', { operazione: OPERAZIONE_LOAD, esito }, error)
  return { error: 'Lettura dal database non riuscita', status: 500 }
}

/** `true` = si prosegue col ripiego (schema indietro, riga `info`); `false` = guasto vero. */
function corredoDegradabile(esito: string, error: unknown): boolean {
  const e = error as { code?: string } | null
  if (!colonnaNuovaAssente(e) && !tabellaMancante(e)) return false
  guastoLetturaAccessoria('pagella', OPERAZIONE_LOAD, esito, error)
  return true
}

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
  const { data: scrutinio, error: errScrutinio } = await supabase
    .from('scrutini')
    .select('id, section_id, periodo_id, stato, chiuso_da, chiuso_il')
    .eq('id', scrutinioId)
    .single()
  if (errScrutinio && codiceDi(errScrutinio) !== NESSUNA_RIGA) return guastoDb('scrutinio-non-letto', errScrutinio)
  if (!scrutinio) return { error: 'Scrutinio non trovato', status: 404 }
  if (scrutinio.stato !== 'chiuso') return { error: 'Pagella disponibile solo a scrutinio chiuso', status: 409 }

  const [
    { data: sezione, error: errSezione },
    { data: periodo, error: errPeriodo },
    { data: alunno, error: errAlunno },
    { data: materie, error: errMaterie },
    { data: giudizi, error: errGiudizi },
    { data: comp, error: errComp },
    { data: obAssoc, error: errObAssoc },
  ] =
    await Promise.all([
      supabase.from('sections').select('id, name, scuola_id').eq('id', scrutinio.section_id).single(),
      supabase.from('scrutinio_periodi').select('nome, anno_scolastico').eq('id', scrutinio.periodo_id).single(),
      supabase.from('alunni').select('id, nome, cognome').eq('id', alunnoId).single(),
      supabase.from('materie').select('id, nome, codice, ordine').eq('section_id', scrutinio.section_id).eq('attiva', true).order('ordine'),
      supabase.from('scrutinio_giudizi').select('materia_id, giudizio_sintetico').eq('scrutinio_id', scrutinioId).eq('alunno_id', alunnoId),
      supabase.from('scrutinio_comportamento').select('giudizio_testo, giudizio_globale').eq('scrutinio_id', scrutinioId).eq('alunno_id', alunnoId).maybeSingle(),
      supabase.from('sezione_materia_obiettivo').select('materia_id, obiettivi_apprendimento(codice, descrizione)').eq('section_id', scrutinio.section_id),
    ])

  if (errSezione && codiceDi(errSezione) !== NESSUNA_RIGA) return guastoDb('sezione-non-letta', errSezione)
  if (errPeriodo && codiceDi(errPeriodo) !== NESSUNA_RIGA) return guastoDb('periodo-non-letto', errPeriodo)
  if (errAlunno && codiceDi(errAlunno) !== NESSUNA_RIGA) return guastoDb('alunno-non-letto', errAlunno)
  if (errMaterie) return guastoDb('materie-non-lette', errMaterie)
  if (errGiudizi) return guastoDb('giudizi-non-letti', errGiudizi)
  if (errComp) return guastoDb('comportamento-non-letto', errComp)
  if (errObAssoc && !corredoDegradabile('obiettivi-non-letti', errObAssoc)) return guastoDb('obiettivi-non-letti', errObAssoc)

  if (!alunno) return { error: 'Alunno non trovato', status: 404 }

  // Mappa giudizio_descrittivo per etichetta dalla scala della scuola (fallback
  // generico, usato quando manca il testo specifico di scrutinio).
  const scalaDescr = new Map<string, string>()
  if (sezione?.scuola_id) {
    const { data: scala, error: errScala } = await supabase
      .from('giudizi_sintetici_scala')
      .select('etichetta, giudizio_descrittivo')
      .eq('scuola_id', sezione.scuola_id)
    if (errScala && !corredoDegradabile('scala-descrittivi-non-letta', errScala)) {
      return guastoDb('scala-descrittivi-non-letta', errScala)
    }
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
    const { data: descr, error: errDescr } = await supabase
      .from('scrutinio_giudizio_descrittivo')
      .select('materia_codice, etichetta_voto, giudizio_descrittivo')
      .eq('scuola_id', sezione.scuola_id)
      .eq('livello', livello)
      .eq('periodo_id', scrutinio.periodo_id)
    if (errDescr && !corredoDegradabile('descrittivi-scrutinio-non-letti', errDescr)) {
      return guastoDb('descrittivi-scrutinio-non-letti', errDescr)
    }
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
    // Il nome della scuola è nell'intestazione: «Istituto» è il ripiego di una sede senza nome.
    const { data: s, error: errScuola } = await supabase.from('schools').select('nome').eq('id', sezione.scuola_id).maybeSingle()
    if (errScuola) return guastoDb('scuola-non-letta', errScuola)
    scuola = { nome: (s as { nome?: string } | null)?.nome ?? null }
  }

  let dirigente: { nome?: string | null; cognome?: string | null } | null = null
  if (scrutinio.chiuso_da) {
    // Il nome del dirigente è la firma applicativa della pagella: non può uscire vuoto per un guasto.
    const { data: u, error: errDirigente } = await supabase.from('utenti').select('nome, cognome').eq('id', scrutinio.chiuso_da).maybeSingle()
    if (errDirigente) return guastoDb('dirigente-non-letto', errDirigente)
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
  const { data: buckets, error: erroreElenco } = await supabase.storage.listBuckets()
  if (erroreElenco) {
    // Senza l'elenco non si crea alla cieca: l'upload qui sotto ha il suo errore.
    logEvento('storage', 'warn', {
      operazione: 'persistPagella',
      bucket: PAGELLE_BUCKET,
      esito: 'bucket_non_verificato',
      entita_id: scrutinioId,
    }, erroreElenco)
  } else if (!buckets?.some((b) => b.name === PAGELLE_BUCKET)) {
    await supabase.storage.createBucket(PAGELLE_BUCKET, { public: false, allowedMimeTypes: ['application/pdf'], fileSizeLimit: 10 * 1024 * 1024 })
  }
  const path = `${scrutinioId}/${alunnoId}.pdf`
  const { error: errUpload } = await supabase.storage
    .from(PAGELLE_BUCKET)
    .upload(path, pdf, { contentType: 'application/pdf', upsert: true })
  // Senza il file, la riga `pagelle` prometterebbe una copia archiviata che non c'è. Si lancia:
  // `generaPagella` lo registra come `pagella-non-archiviata`.
  if (errUpload) throw new Error('Caricamento del PDF della pagella non riuscito', { cause: errUpload })
  // `ritirata_il: null`: una pagella rigenerata dopo una riapertura torna IN VIGORE. È la stessa
  // riga (vincolo di unicità su scrutinio e alunno) e `file_ritirati` non si tocca: è lo storico
  // delle versioni consegnate.
  const riga =
    {
      scrutinio_id: scrutinioId,
      alunno_id: alunnoId,
      file_url: path,
      generata_da: userId,
      firma_applicativa: { dirigente: data.dirigente, chiuso_il: data.chiusoIl, metodo: 'firma_applicativa' },
    }
  const primo = await supabase.from('pagelle').upsert({ ...riga, ritirata_il: null }, { onConflict: 'scrutinio_id,alunno_id' })
  let errRiga = primo.error
  if (errRiga && colonnaNuovaAssente(errRiga)) {
    // DB della CI senza la colonna del ritiro: lì la riapertura cancella ancora le righe.
    logEvento('db', 'info', {
      operazione: 'primaria/pagella-store:persistPagella',
      esito: 'colonna-ritiro-assente',
      scrutinio_id: scrutinioId,
    })
    const secondo = await supabase.from('pagelle').upsert(riga, { onConflict: 'scrutinio_id,alunno_id' })
    errRiga = secondo.error
  }
  if (errRiga) throw new Error('Registrazione della pagella archiviata non riuscita', { cause: errRiga })
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
    catch (e) {
      // Il PDF torna comunque al chiamante, ma la copia archiviata non c'è: la
      // pagella "esiste" per chi l'ha scaricata e non per il fascicolo. A log
      // solo gli id (uuid): `loaded.data` porta i giudizi dell'alunno.
      logEvento(
        'pagella',
        'error',
        {
          operazione: 'generaPagella:persist',
          esito: 'pagella-non-archiviata',
          scrutinio_id: scrutinioId,
          alunno_id: alunnoId,
        },
        e,
      )
    }
  }
  return { pdf }
}
