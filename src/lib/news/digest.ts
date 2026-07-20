import type { SupabaseClient } from '@supabase/supabase-js'
import { genitoriDiScuola } from '@/lib/notifiche/destinatari'
import { sendEmailDetailed } from '@/lib/email/send'
import { logEvento, logErrore } from '@/lib/logging/logger'
import { costruisciDigestHtml } from '@/lib/news/digest-email'
import { schemaAssente } from '@/lib/news/schema-assente'
import { MESI_IT } from '@/lib/news/tipi'

// =============================================================================
// Digest mensile «Kidville News».
//
// `componiDigest` è PURA: seleziona i pubblicati del mese, li ordina (pinned poi
// data DESC) e produce {titolo, post_ids, html}. Include anche i post a target
// classi (decisione 14). Mese vuoto → null (nessuna edizione).
//
// `generaEInviaDigest` è l'orchestratore usato da /news/cron/run e
// /news/digest/genera: per ogni sede compone, persiste con ON CONFLICT DO NOTHING
// (idempotente), poi invia SOLO se `inviata_il IS NULL` a TUTTE le famiglie della
// sede — comunicazione istituzionale, indipendente dai toggle (decisione 14).
// Invio SEQUENZIALE con throttle (~2/s) via sendEmailDetailed (che logga già via
// externalFetch). PostgREST non lancia: si controlla sempre `{ error }`.
// =============================================================================

export interface PostDigest {
  id: string
  titolo: string
  stato: string
  pinned: boolean
  pubblicata_il: string | null
  contenuto_testo?: string | null
  categoria_nome?: string | null
  target_scope?: string
}

export interface ComponiDigestParams {
  scuolaId: string
  anno: number
  mese: number
  nomeSede: string
}

export interface DigestComposto {
  titolo: string
  post_ids: string[]
  html: string
}

function nelMese(pubblicataIl: string | null, anno: number, mese: number): boolean {
  if (!pubblicataIl) return false
  const d = new Date(pubblicataIl)
  if (Number.isNaN(d.getTime())) return false
  return d.getUTCFullYear() === anno && d.getUTCMonth() + 1 === mese
}

export function componiDigest(posts: PostDigest[], params: ComponiDigestParams): DigestComposto | null {
  const { anno, mese, nomeSede } = params
  const delMese = (posts ?? []).filter((p) => p.stato === 'pubblicata' && nelMese(p.pubblicata_il, anno, mese))
  if (delMese.length === 0) return null

  const ordinati = [...delMese].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const da = a.pubblicata_il ? Date.parse(a.pubblicata_il) : 0
    const db = b.pubblicata_il ? Date.parse(b.pubblicata_il) : 0
    return db - da
  })

  const titolo = `Kidville News — ${MESI_IT[mese - 1] ?? ''} ${anno}`.trim()
  const html = costruisciDigestHtml({
    titolo,
    nomeSede,
    posts: ordinati.map((p) => ({
      id: p.id,
      titolo: p.titolo,
      categoria_nome: p.categoria_nome ?? null,
      contenuto_testo: p.contenuto_testo ?? null,
    })),
  })

  return { titolo, post_ids: ordinati.map((p) => p.id), html }
}

// ── Orchestratore ────────────────────────────────────────────────────────────

export interface EdizioneEsito {
  scuola_id: string
  generata: boolean
  inviata: boolean
  destinatari_count: number
  errori_count: number
}

type EdizioneRow = {
  id: string
  inviata_il: string | null
  destinatari_count: number | null
  errori_count: number | null
}

async function sediBersaglio(
  supabase: SupabaseClient,
  scuolaId?: string,
): Promise<{ id: string; nome: string }[]> {
  if (scuolaId) {
    const { data, error } = await supabase.from('scuole').select('id, nome').eq('id', scuolaId).maybeSingle()
    if (error || !data) return []
    return [data as { id: string; nome: string }]
  }
  const { data, error } = await supabase.from('scuole').select('id, nome').eq('attiva', true)
  if (error || !data) return []
  return data as { id: string; nome: string }[]
}

function estremiMese(anno: number, mese: number): { inizio: string; fine: string } {
  const inizio = new Date(Date.UTC(anno, mese - 1, 1)).toISOString()
  const fine = new Date(Date.UTC(anno, mese, 1)).toISOString() // primo giorno del mese successivo (esclusivo)
  return { inizio, fine }
}

async function emailFamiglie(supabase: SupabaseClient, scuolaId: string): Promise<string[]> {
  const genitori = await genitoriDiScuola(supabase, scuolaId)
  if (genitori.length === 0) return []
  const { data, error } = await supabase.from('utenti').select('email').in('id', genitori)
  if (error || !data) return []
  const emails = (data as { email: string | null }[])
    .map((u) => (u.email ?? '').trim())
    .filter((e) => e.includes('@'))
  return [...new Set(emails)]
}

function testoFallback(titolo: string, posts: PostDigest[]): string {
  const righe = posts.map((p) => `• ${p.titolo}`).join('\n')
  return `${titolo}\n\n${righe}\n\nApri l'app Kidville per leggere le novità.`
}

/**
 * Genera e invia il digest del mese per una o tutte le sedi. Idempotente:
 * un'edizione già inviata non viene re-inviata. Ritorna l'esito per sede.
 */
export async function generaEInviaDigest(
  supabase: SupabaseClient,
  opts: { anno: number; mese: number; scuolaId?: string },
): Promise<{ edizioni: EdizioneEsito[] }> {
  const { anno, mese } = opts
  const sedi = await sediBersaglio(supabase, opts.scuolaId)
  const edizioni: EdizioneEsito[] = []

  for (const sede of sedi) {
    const esito: EdizioneEsito = { scuola_id: sede.id, generata: false, inviata: false, destinatari_count: 0, errori_count: 0 }

    // 1) Carica i pubblicati del mese (della sede + globali).
    const { inizio, fine } = estremiMese(anno, mese)
    const { data: postRows, error: postErr } = await supabase
      .from('news_posts')
      .select('id, titolo, stato, pinned, pubblicata_il, contenuto_testo, categoria_id, target_scope')
      .eq('stato', 'pubblicata')
      .or(`scuola_id.eq.${sede.id},scuola_id.is.null`)
      .gte('pubblicata_il', inizio)
      .lt('pubblicata_il', fine)
    if (postErr) {
      if (schemaAssente(postErr)) {
        logEvento('news', 'info', { operazione: 'digest', esito: 'schema-assente', scuola_id: sede.id })
        edizioni.push(esito)
        continue
      }
      logErrore({ operazione: 'news/digest:posts', stato: 500, evento: 'news' }, postErr)
      edizioni.push(esito)
      continue
    }

    const composto = componiDigest((postRows ?? []) as PostDigest[], {
      scuolaId: sede.id, anno, mese, nomeSede: sede.nome,
    })
    if (!composto) {
      edizioni.push(esito) // nessun post: niente edizione
      continue
    }
    esito.generata = true

    // 2) Persisti l'edizione (idempotente). Se esiste già, la si riusa.
    const { data: gia, error: giaErr } = await supabase
      .from('news_digest_edizioni')
      .select('id, inviata_il, destinatari_count, errori_count')
      .eq('scuola_id', sede.id).eq('anno', anno).eq('mese', mese)
      .maybeSingle()
    // Best-effort (l'upsert ON CONFLICT sotto copre comunque l'esistenza), ma
    // l'errore non si ingoia (regola 7): senza log un guasto qui è invisibile.
    if (giaErr && !schemaAssente(giaErr)) {
      logEvento('news', 'warn', { operazione: 'news/digest:esistenza', esito: 'query-fallita', scuola_id: sede.id }, giaErr)
    }

    let edizione = gia as EdizioneRow | null
    if (!edizione) {
      const { error: insErr } = await supabase
        .from('news_digest_edizioni')
        .upsert(
          { scuola_id: sede.id, anno, mese, titolo: composto.titolo, post_ids: composto.post_ids, html: composto.html },
          { onConflict: 'scuola_id,anno,mese', ignoreDuplicates: true },
        )
      if (insErr) {
        if (schemaAssente(insErr)) {
          logEvento('news', 'info', { operazione: 'digest', esito: 'schema-assente', scuola_id: sede.id })
          edizioni.push(esito)
          continue
        }
        logErrore({ operazione: 'news/digest:insert', stato: 500, evento: 'news' }, insErr)
        edizioni.push(esito)
        continue
      }
      const { data: dopo, error: dopoErr } = await supabase
        .from('news_digest_edizioni')
        .select('id, inviata_il, destinatari_count, errori_count')
        .eq('scuola_id', sede.id).eq('anno', anno).eq('mese', mese)
        .maybeSingle()
      if (dopoErr && !schemaAssente(dopoErr)) {
        logEvento('news', 'warn', { operazione: 'news/digest:rilettura', esito: 'query-fallita', scuola_id: sede.id }, dopoErr)
      }
      edizione = dopo as EdizioneRow | null
    }

    if (!edizione) {
      edizioni.push(esito)
      continue
    }
    if (edizione.inviata_il) {
      // Già inviata: idempotenza. Riporta i conteggi persistiti.
      esito.destinatari_count = edizione.destinatari_count ?? 0
      esito.errori_count = edizione.errori_count ?? 0
      edizioni.push(esito)
      continue
    }

    // 3) Invio a TUTTE le famiglie della sede (comunicazione istituzionale).
    const destinatari = await emailFamiglie(supabase, sede.id)
    const testo = testoFallback(composto.titolo, (postRows ?? []) as PostDigest[])
    let errori = 0
    for (let i = 0; i < destinatari.length; i++) {
      const res = await sendEmailDetailed({ to: destinatari[i], subject: composto.titolo, text: testo, html: composto.html })
      if (!res.ok) errori++
      if (i < destinatari.length - 1) await new Promise((r) => setTimeout(r, 500)) // throttle ~2/s
    }

    // 4) Marca inviata (guardia inviata_il IS NULL contro doppio invio concorrente).
    const { error: updErr } = await supabase
      .from('news_digest_edizioni')
      .update({ inviata_il: new Date().toISOString(), destinatari_count: destinatari.length, errori_count: errori })
      .eq('id', edizione.id)
      .is('inviata_il', null)
    if (updErr) {
      logErrore({ operazione: 'news/digest:marca-inviata', stato: 500, evento: 'news' }, updErr)
    }

    esito.inviata = true
    esito.destinatari_count = destinatari.length
    esito.errori_count = errori
    // Successo del canale critico: va in app_log (news ∈ EVENTI_PERSISTITI).
    logEvento('news', 'info', {
      operazione: 'digest',
      esito: 'inviata',
      scuola_id: sede.id,
      anno,
      mese,
      destinatari: destinatari.length,
      errori,
    })
    edizioni.push(esito)
  }

  return { edizioni }
}
