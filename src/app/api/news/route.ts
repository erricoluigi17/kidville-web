import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'
import { sanificaContenuto } from '@/lib/news/sanitizza'
import { parseInstagramUrl } from '@/lib/news/instagram'
import { notificaNewsPubblicata, type PostDaNotificare } from '@/lib/news/notifiche'
import { campiProva, gateConsensoFoto, scriviConDegradazione } from '@/lib/news/gate-consenso'
import { contieneFoto } from '@/lib/news/foto-nel-post'
import { promuoviMediaBozza } from '@/lib/news/media-bozza'
import { NEWS_SCOPES, NEWS_STATI, NEWS_TIPI, type NewsPost } from '@/lib/news/tipi'

// Query param «vuoto» → undefined (i <select> mandano '' per "nessun filtro").
const zVuotoUndefined = <T extends z.ZodTypeAny>(s: T) => z.preprocess((v) => (v === '' ? undefined : v), s.optional())

const getQuerySchema = z.object({
  stato: zVuotoUndefined(z.enum(NEWS_STATI)),
  tipo: zVuotoUndefined(z.enum(NEWS_TIPI)),
  categoria_id: zVuotoUndefined(zUuid),
  scuola_id: zVuotoUndefined(zUuid),
})

const zGradi = z.array(z.enum(['nido', 'infanzia', 'primaria'])).nullish()
const zClassi = z.array(z.string()).nullish()

const postBodySchema = z.object({
  tipo: z.enum(NEWS_TIPI, { error: 'tipo non valido' }),
  titolo: z.string({ error: 'titolo è obbligatorio' }).min(1, 'titolo è obbligatorio'),
  contenuto_json: z.unknown().optional(),
  categoria_id: zUuid.nullish(),
  target_scope: z.enum(NEWS_SCOPES).default('globale'),
  target_gradi: zGradi,
  target_classes: zClassi,
  copertina_url: z.string().nullish(),
  instagram_url: z.string().nullish(),
  invia_notifica: z.boolean().optional(),
  // `scuola_id: null` = «tutte le sedi» (solo admin). Assente = risolto server-side.
  scuola_id: zUuid.nullish(),
  stato: z.enum(NEWS_STATI).optional(),
  // Dichiarazione dei bambini RITRATTI nelle foto del post. Distingue tre casi,
  // e la distinzione è tutto il punto: `undefined` = «non dichiarato» (rifiuto),
  // `[]` = «nessun bambino è ritratto» (dichiarazione esplicita, archiviata),
  // elenco = «sono ritratti questi», ciascuno da verificare sul canale «sito».
  bambini_ritratti: z.array(zUuid).nullish(),
})

const STATI_STAFF = new Set(['bozza', 'proposta', 'programmata', 'pubblicata'])

/**
 * Il gate del consenso è passato, ma il media non si è potuto spostare
 * nell'archivio pubblico. Si rifiuta: una riga salvata adesso mostrerebbe
 * un'immagine rotta (il file è ancora privato) o un indirizzo che scade.
 */
const MEDIA_NON_PROMOSSI =
  'Non è stato possibile pubblicare le immagini del post in questo momento: riprova fra qualche istante.'

// GET /api/news — elenco gestionale (staff: sede + globali; educator: solo i propri).
export const GET = withRoute('news:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)

    // Scope vuoto ⇒ si NEGA. Qui c'era `else query.is('scuola_id', null)`: col
    // cookie `sedi_attive` puntato a una sede non (più) accessibile la risposta
    // non era «niente» ma «tutti i post globali». Il ramo globale è voluto, ma
    // vale DENTRO il filtro di sede, non come ripiego quando il filtro manca:
    // «vale per tutte le sedi» presuppone che una sede ce l'abbia, chi legge.
    // Il motivo è già a log (`resolveScuoleAttive` → warn `sedi-attive-non-accessibili`).
    if (sedi.length === 0) {
      return NextResponse.json({ disponibile: true, posts: [] })
    }

    let query = supabase.from('news_posts').select('*').order('created_at', { ascending: false })
    // Isolamento di sede: le proprie sedi + i post globali (scuola_id NULL, riservati ad admin).
    query = query.or(`scuola_id.in.(${sedi.join(',')}),scuola_id.is.null`)
    if (q.data.stato) query = query.eq('stato', q.data.stato)
    if (q.data.tipo) query = query.eq('tipo', q.data.tipo)
    if (q.data.categoria_id) query = query.eq('categoria_id', q.data.categoria_id)
    // Un educator vede solo i post di cui è autore (proprie bozze/proposte).
    if (auth.user.role === 'educator') query = query.eq('author_id', auth.user.id)

    const { data, error } = await query
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news:GET', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false, posts: [] })
      }
      logErrore({ operazione: 'news:GET', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nel recupero delle news' }, { status: 500 })
    }
    return NextResponse.json({ disponibile: true, posts: (data ?? []) as NewsPost[] })
  } catch (err) {
    logErrore({ operazione: 'news:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// POST /api/news — crea un post. Il client invia SOLO contenuto_json; il server
// sanifica (chokepoint) e salva html/testo. Educator: stato forzato a bozza|proposta.
export const POST = withRoute('news:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const isEducator = auth.user.role === 'educator'
    const isAdmin = auth.user.role === 'admin'

    // tipo instagram → shortcode obbligatorio (mai fidarsi dell'URL grezzo).
    let instagramShortcode: string | null = null
    if (body.tipo === 'instagram') {
      instagramShortcode = body.instagram_url ? parseInstagramUrl(body.instagram_url) : null
      if (!instagramShortcode) {
        return NextResponse.json({ error: 'URL Instagram non valido' }, { status: 400 })
      }
    }

    const supabase = await createAdminClient()

    // Sede: `scuola_id: null` esplicito = «tutte le sedi», solo admin. Altrimenti
    // la sede si risolve server-side (mai fidarsi del client per il tenant).
    let scuolaId: string | null
    if (body.scuola_id === null) {
      if (!isAdmin) {
        return NextResponse.json({ error: 'Solo la direzione può pubblicare per tutte le sedi' }, { status: 403 })
      }
      scuolaId = null
    } else {
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id ?? undefined)
      if (sw.response) return sw.response
      scuolaId = sw.scuolaId ?? null
    }

    // ─── Consenso fotografico sul canale PUBBLICO (privacy F4) ───────────────
    // Il bucket `news` è pubblico e senza login: è il «sito web della Scuola»
    // per cui le famiglie danno (o negano) un consenso DISTINTO da quello della
    // galleria riservata. Il gate sta PRIMA dell'insert: una riga scritta e poi
    // rifiutata sarebbe una pubblicazione con un altro nome. E vive in
    // `@/lib/news/gate-consenso`, non qui: la stessa regola vale per la PATCH e
    // per la pubblicazione, e fino al 2026-08-01 valeva solo per questa rotta.
    // Sede della verifica: quella del post; per «tutte le sedi» (solo admin), le
    // sedi attive di chi pubblica.
    const sediVerifica = scuolaId ? [scuolaId] : await resolveScuoleAttive(request, supabase, auth.user)
    const gate = await gateConsensoFoto({
      supabase,
      copertinaUrl: body.copertina_url,
      contenutoJson: body.contenuto_json,
      ritrattiRichiesti: body.bambini_ritratti,
      sedi: sediVerifica,
      attore: auth.user,
      operazione: 'news:POST',
    })
    if ('response' in gate) return gate.response
    const dichiarazione = gate.prova

    // ─── Solo ORA il file può diventare pubblico ─────────────────────────────
    // I media sostano nel bucket privato `news_bozze` fino a questo punto: la
    // pubblicità è la conseguenza del consenso verificato, non la sua premessa.
    // Se lo spostamento fallisce non si scrive niente — una riga con l'indirizzo
    // pubblico di un file rimasto privato è un'immagine rotta sul sito.
    const promozione = await promuoviMediaBozza(
      supabase,
      { copertinaUrl: body.copertina_url, contenutoJson: body.contenuto_json },
      'news:POST',
    )
    if (promozione.errore) {
      return NextResponse.json({ error: MEDIA_NON_PROMOSSI, codice: 'MEDIA_NON_PROMOSSI' }, { status: 503 })
    }
    const copertinaFinale = promozione.copertinaUrl
    const contenutoFinale = promozione.contenutoJson

    // Stato: educator vincolato a bozza|proposta; staff libero (default bozza).
    let stato: string
    if (isEducator) {
      stato = body.stato === 'proposta' ? 'proposta' : 'bozza'
    } else {
      stato = body.stato && STATI_STAFF.has(body.stato) ? body.stato : 'bozza'
    }

    // Contenuto rich-text: SOLO dal JSON, passato dal chokepoint di sanificazione.
    // Si sanifica il contenuto DOPO la promozione: è quello che verrà salvato, e
    // html/testo devono citare gli stessi indirizzi del JSON.
    let contenutoHtml: string | null = null
    let contenutoTesto: string | null = null
    if (contenutoFinale != null && typeof contenutoFinale === 'object') {
      const s = sanificaContenuto(contenutoFinale)
      contenutoHtml = s.html
      contenutoTesto = s.testo
    }

    const record: Record<string, unknown> = {
      tipo: body.tipo,
      stato,
      titolo: body.titolo,
      contenuto_json: contenutoFinale ?? null,
      contenuto_html: contenutoHtml,
      contenuto_testo: contenutoTesto,
      categoria_id: body.categoria_id ?? null,
      target_scope: body.target_scope,
      target_gradi: body.target_gradi ?? null,
      target_classes: body.target_classes ?? null,
      copertina_url: copertinaFinale ?? null,
      instagram_url: body.instagram_url ?? null,
      instagram_shortcode: instagramShortcode,
      invia_notifica: body.invia_notifica ?? true,
      scuola_id: scuolaId,
      author_id: auth.user.id,
      // La PROVA della dichiarazione: chi, quando, su quale versione del testo,
      // su quali bambini. Senza riga non c'è prova, e un consenso che non si può
      // dimostrare non vale (art. 5 §2 e art. 7 §1 GDPR). `null` sui post senza
      // foto: niente da dichiarare, e la differenza deve restare leggibile.
      bambini_ritratti: null,
      consenso_dichiarato_da: null,
      consenso_dichiarato_il: null,
      consenso_versione: null,
      ...campiProva(dichiarazione, auth.user.id),
    }
    if (stato === 'pubblicata') record.pubblicata_il = new Date().toISOString()

    // Insert resiliente alla colonna mancante: il DB E2E della CI non è migrato
    // e risponde `PGRST204`. Si rimuovono SOLO le colonne della dichiarazione —
    // mai un campo del post — e si ritenta.
    const res = await scriviConDegradazione<NewsPost>(
      record,
      (rec) => supabase.from('news_posts').insert(rec).select().single(),
      'news:POST',
    )
    const { data, error } = res
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news:POST', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'news:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nella creazione della news' }, { status: 500 })
    }

    const post = data as NewsPost
    // Evento critico → si logga anche il SUCCESSO: senza, «nessun log» non
    // distingue «consenso verificato» da «non è mai partita nessuna verifica».
    logEvento('news', 'info', {
      operazione: 'news:POST',
      esito: 'creato',
      post_id: post.id,
      stato,
      con_foto: contieneFoto(body.copertina_url, body.contenuto_json),
      bambini_ritratti: dichiarazione?.bambini.length ?? 0,
    })

    if (stato === 'pubblicata') {
      await notificaNewsPubblicata(supabase, {
        id: post.id,
        titolo: post.titolo,
        scuola_id: post.scuola_id,
        target_scope: post.target_scope,
        target_gradi: post.target_gradi,
        target_classes: post.target_classes,
        contenuto_testo: post.contenuto_testo,
        invia_notifica: post.invia_notifica,
        notifica_inviata_il: post.notifica_inviata_il ?? null,
      } as PostDaNotificare)
    }

    return NextResponse.json({ disponibile: true, post }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: 'news:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
