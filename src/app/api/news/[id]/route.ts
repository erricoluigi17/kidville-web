import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { schemaAssente } from '@/lib/news/schema-assente'
import { sanificaContenuto } from '@/lib/news/sanitizza'
import { parseInstagramUrl } from '@/lib/news/instagram'
import { campiProva, gateConsensoFoto, scriviConDegradazione } from '@/lib/news/gate-consenso'
import { promuoviMediaBozza, riportaMediaInBozza } from '@/lib/news/media-bozza'
import {
  liberaFilePubbliciDelPost,
  liberaPercorsiPubblici,
  mediaEstranei,
  percorsiPubbliciDelPost,
} from '@/lib/news/permanenza-consenso'
import { NEWS_SCOPES, type NewsPost } from '@/lib/news/tipi'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** Vedi la costante gemella in `src/app/api/news/route.ts`. */
const MEDIA_NON_PROMOSSI =
  'Non è stato possibile pubblicare le immagini del post in questo momento: riprova fra qualche istante.'

/** La cancellazione si ferma finché i file restano nel bucket pubblico (vedi DELETE). */
const FILE_NON_RIMOSSI =
  'Non è stato possibile togliere le immagini del post dall’archivio pubblico: la news non è stata eliminata. Riprova fra qualche istante.'

/**
 * Stessa regola, sulla modifica: la riga non smette di nominare un file che è
 * ancora là (vedi PATCH).
 *
 * ⚠️ IL CODICE ACCANTO NON È QUELLO DELLA DELETE, e non può tornare a esserlo.
 * Questa prosa non arriva quasi mai a schermo: `messaggioDaCorpo`, appena
 * riconosce un `codice`, mostra il testo del CATALOGO e scarta l'`error`. Fino al
 * 2026-08-03 qui viaggiava `NEWS_FILE_NON_RIMOSSI` — il codice della
 * cancellazione — e a chi aveva appena sostituito una copertina l'interfaccia
 * rispondeva «la news non è stata eliminata»: il resoconto di una cancellazione
 * mai tentata, su una modifica che invece era stata rifiutata. Il codice era
 * dichiarato e tradotto in due lingue, quindi il lock `errori-con-codice` lo
 * vedeva a posto: un codice RIUSATO non è un codice mancante.
 */
const FILE_SOSTITUITI_NON_RIMOSSI =
  'Non è stato possibile togliere dall’archivio pubblico le immagini sostituite: la modifica non è stata salvata. Riprova fra qualche istante.'

/**
 * Un articolo non può cominciare a nominare l'immagine di un altro articolo.
 *
 * IL PASSO 1 DELL'ATTACCO (2026-08-03). Il bucket `news` è pubblico: l'indirizzo
 * dell'immagine di un altro post lo conosce chiunque legga il sito, e
 * `/api/news/feed` lo distribuisce in chiaro. Bastava metterlo dentro il
 * `contenuto_json` della propria bozza — accettato, riga scritta — e alla modifica
 * successiva quel percorso finiva fra gli `usciti`, cioè dentro una `remove()`
 * eseguita col service-role sul file di qualcun altro.
 *
 * La cancellazione è chiusa dall'altro capo, in `liberaPercorsiPubblici` («c'è
 * ancora qualcuno che lo nomina?»); questo rifiuto è la difesa complementare, e
 * arriva prima: impedisce che la riga adotti il file, invece di accorgersene
 * quando lo sta per buttare. Le due non si sostituiscono a vicenda.
 *
 * DUE BUCKET, NON UNO (giro 2). `mediaEstranei` guarda anche l'area di sosta
 * privata `news_bozze`: là `pathBozza` accettava l'indirizzo firmato del media di
 * un altro operatore senza chiedere di chi fosse, e la conseguenza era peggiore —
 * non la cancellazione del file altrui ma la sua PUBBLICAZIONE, con una `move()`
 * in service-role verso il bucket pubblico. E la stessa regola vale ora anche su
 * `news:POST`: scritta sulla sola PATCH, bastava creare il post invece di
 * modificarlo.
 */
const MEDIA_ESTRANEO =
  'Il contenuto richiama un’immagine che appartiene a un altro articolo: caricala di nuovo con il pulsante delle immagini.'

const patchBodySchema = z.object({
  titolo: z.string().min(1).optional(),
  contenuto_json: z.unknown().optional(),
  categoria_id: zUuid.nullish(),
  target_scope: z.enum(NEWS_SCOPES).optional(),
  target_gradi: z.array(z.enum(['nido', 'infanzia', 'primaria'])).nullish(),
  target_classes: z.array(z.string()).nullish(),
  copertina_url: z.string().nullish(),
  instagram_url: z.string().nullish(),
  invia_notifica: z.boolean().optional(),
  // Dichiarazione dei bambini RITRATTI, come in `POST /api/news`. Assente = la
  // modifica non la tocca (resta quella archiviata); `[]` = «nessun bambino è
  // ritratto», che è una dichiarazione e va archiviata come tale.
  bambini_ritratti: z.array(zUuid).nullish(),
})

/**
 * RC2 — carica il post per id e verifica lo SCOPE di sede prima di ogni azione.
 * `requireDocente` verifica il RUOLO, non il TENANT, e la route gira in service-role
 * (bypassa la RLS): senza questo, si potrebbe leggere/modificare un post di un'altra
 * sede conoscendone l'UUID. Post globale (`scuola_id` NULL) gestibile da staff.
 * Ritorna la riga completa oppure una NextResponse 4xx/5xx pronta.
 */
async function caricaPostConScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  id: string,
): Promise<{ post?: NewsPost; response?: NextResponse }> {
  const { data, error } = await supabase.from('news_posts').select('*').eq('id', id).maybeSingle()
  if (error) {
    if (schemaAssente(error)) {
      logEvento('news', 'info', { operazione: 'news/[id]:scope', esito: 'schema-assente' })
      return { response: NextResponse.json({ disponibile: false }, { status: 503 }) }
    }
    logErrore({ operazione: 'news/[id]:scope', stato: 500, evento: 'db' }, error)
    return { response: NextResponse.json({ error: 'Errore nella lettura della news' }, { status: 500 }) }
  }
  if (!data) return { response: NextResponse.json({ error: 'News non trovata' }, { status: 404 }) }
  const post = data as NewsPost
  if (post.scuola_id != null) {
    const sedi = await resolveScuoleAttive(request, supabase, user)
    if (!sedi.includes(post.scuola_id)) {
      return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
    }
  }
  return { post }
}

/**
 * Un educator gestisce SOLO i propri post; per le modifiche anche solo quelli
 * ancora in `bozza`|`proposta`. Staff/direzione non sono limitati. Ritorna una
 * NextResponse 403 pronta oppure null.
 */
function guardEducator(user: AppUser, post: NewsPost, richiediEditabile: boolean): NextResponse | null {
  if (user.role !== 'educator') return null
  if (post.author_id !== user.id) {
    return NextResponse.json({ error: 'Puoi gestire solo le tue news' }, { status: 403 })
  }
  if (richiediEditabile && post.stato !== 'bozza' && post.stato !== 'proposta') {
    return NextResponse.json({ error: 'Una news già inoltrata o pubblicata non è più modificabile' }, { status: 403 })
  }
  return null
}

// GET /api/news/[id] — dettaglio gestionale.
export const GET = withRoute('news/[id]:GET', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const guard = guardEducator(auth.user, sc.post!, false)
    if (guard) return guard

    return NextResponse.json({ disponibile: true, post: sc.post })
  } catch (err) {
    logErrore({ operazione: 'news/[id]:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/news/[id] — modifica. Ri-sanifica se arriva contenuto_json.
export const PATCH = withRoute('news/[id]:PATCH', async (request: NextRequest, { params }: RouteParams) => {
  // ─── LA QUARTA VIA D'USCITA: L'ECCEZIONE (W1-quater, 2026-08-03) ───────────
  // Vedi la testata gemella in `src/app/api/news/route.ts`. Le tre vie d'uscita
  // «ordinate» rimettevano già in sosta; questa non passa da nessun `if` e
  // restava aperta. Qui la strada più corta è `sanificaContenuto`, che gira sul
  // JSON del CLIENT ed è chiamata DOPO la promozione. L'elenco e il client vivono
  // perciò FUORI dal `try`, altrimenti il `catch` non li vedrebbe.
  let clientPerAnnullo: Parameters<typeof riportaMediaInBozza>[0] | null = null
  let promossiOra: string[] = []
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    clientPerAnnullo = supabase
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const guard = guardEducator(auth.user, sc.post!, true)
    if (guard) return guard

    const updates: Record<string, unknown> = {}
    for (const f of ['titolo', 'categoria_id', 'target_scope', 'target_gradi', 'target_classes', 'copertina_url', 'invia_notifica'] as const) {
      if (body[f] !== undefined) updates[f] = body[f]
    }
    // La SANIFICAZIONE non avviene qui ma più in basso, dopo la promozione dei
    // media: `contenuto_html`/`contenuto_testo` devono citare gli stessi
    // indirizzi del JSON che finisce nella riga, e la promozione li riscrive.
    if (body.contenuto_json !== undefined) {
      updates.contenuto_json = body.contenuto_json ?? null
    }
    if (body.instagram_url !== undefined) {
      updates.instagram_url = body.instagram_url ?? null
      updates.instagram_shortcode = body.instagram_url ? parseInstagramUrl(body.instagram_url) : null
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }

    // I file che la riga nomina ADESSO. Si leggono PRIMA di toccare qualunque
    // cosa: dopo la scrittura non esisterebbe più niente da cui ricavarli, ed è
    // esattamente il difetto W1 (vedi più sotto, dove si calcola la differenza).
    // Sono anche l'elenco di ciò che questo post ha il diritto di nominare.
    const postCorrente = sc.post!
    const primaDellaModifica = percorsiPubbliciDelPost(postCorrente)

    // ─── UN POST NON ADOTTA IL FILE DI UN ALTRO (vedi `MEDIA_ESTRANEO`) ──────
    // Prima del gate perché è il controllo più a buon mercato dei due — non tocca
    // il database — e perché rifiuta il corpo della richiesta, non il contenuto:
    // qui non si sta ancora decidendo se una foto si può pubblicare, si sta
    // dicendo che quel file non è di questo articolo.
    const estranei = mediaEstranei(
      { copertina_url: updates.copertina_url, contenuto_json: updates.contenuto_json },
      primaDellaModifica,
      auth.user.id,
    )
    if (estranei.length > 0) {
      // `warn` e non `info`: è un tentativo di far nominare alla propria riga il
      // file di un altro post, cioè il primo passo di una cancellazione altrui.
      // Nel log solo i conteggi e gli uuid: mai il percorso, che porta con sé
      // l'uuid di chi ha caricato e il nome del file scelto da una persona.
      logEvento('news', 'warn', {
        operazione: 'news/[id]:PATCH',
        esito: 'media-di-un-altro-post',
        post_id: p.data,
        utente_id: auth.user.id,
        n_file: estranei.length,
        msg: `news/[id]:PATCH: la modifica cita ${estranei.length} file pubblici che questo post non nomina e che non ha caricato chi sta scrivendo: rifiutata`,
      })
      return NextResponse.json({ error: MEDIA_ESTRANEO, codice: 'NEWS_MEDIA_ESTRANEO' }, { status: 403 })
    }

    // ─── Consenso fotografico sul canale PUBBLICO (privacy F4) ───────────────
    // QUI STAVA IL BUCO: il gate viveva solo su `POST /api/news`, e bastava
    // creare il post senza foto e aggiungere la copertina (o un nodo `image`) di
    // qui per pubblicare la foto di un bambino senza consenso al canale «sito».
    // La verifica gira sullo stato RISULTANTE — il post com'è dopo questa
    // modifica — non sui soli campi che arrivano nel corpo: un post che già
    // ritraeva bambini resta sotto controllo anche quando la PATCH cambia il
    // titolo, perché nel frattempo un consenso può essere stato revocato.
    const post = postCorrente
    const copertinaDopo = 'copertina_url' in updates ? updates.copertina_url : post.copertina_url
    const contenutoDopo = 'contenuto_json' in updates ? updates.contenuto_json : post.contenuto_json
    const sediVerifica = post.scuola_id
      ? [post.scuola_id]
      : await resolveScuoleAttive(request, supabase, auth.user)
    const gate = await gateConsensoFoto({
      supabase,
      copertinaUrl: copertinaDopo,
      contenutoJson: contenutoDopo,
      ritrattiRichiesti: body.bambini_ritratti,
      ritrattiArchiviati: post.bambini_ritratti ?? null,
      sedi: sediVerifica,
      attore: auth.user,
      operazione: 'news/[id]:PATCH',
    })
    if ('response' in gate) return gate.response
    Object.assign(updates, campiProva(gate.prova, auth.user.id))

    // Solo ORA i media possono diventare pubblici (vedi `@/lib/news/media-bozza`).
    // Si promuove ciò che questa PATCH sta scrivendo, non l'intero post: i media
    // già dentro la riga sono passati di qui la volta scorsa.
    //
    // W1-bis: la promozione precede la scrittura, e deve farlo — il contenuto
    // salvato deve citare gli indirizzi definitivi. Ma da qui in avanti ogni via
    // d'uscita che NON scrive la riga deve rimettere in sosta ciò che ha appena
    // reso pubblico: un file pubblico che nessuna riga nomina è irraggiungibile
    // da revoca e oblio, che partono entrambi dalla riga.
    if ('copertina_url' in updates || 'contenuto_json' in updates) {
      const promozione = await promuoviMediaBozza(
        supabase,
        { copertinaUrl: updates.copertina_url, contenutoJson: updates.contenuto_json },
        'news/[id]:PATCH',
      )
      // Da qui in avanti l'elenco è in mano anche al `catch`, dichiarato fuori dal
      // `try` proprio per poterlo leggere.
      promossiOra = promozione.promossiPercorsi
      if (promozione.errore) {
        // Fallita a metà: i file già spostati sono pubblici e la riga non si
        // scriverà. Si annulla lo spostamento prima di rispondere.
        await riportaMediaInBozza(supabase, promossiOra, 'news/[id]:PATCH')
        promossiOra = []
        return NextResponse.json({ error: MEDIA_NON_PROMOSSI, codice: 'MEDIA_NON_PROMOSSI' }, { status: 503 })
      }
      if ('copertina_url' in updates) updates.copertina_url = promozione.copertinaUrl ?? null
      if ('contenuto_json' in updates) updates.contenuto_json = promozione.contenutoJson ?? null
    }

    // Sanificazione (chokepoint) sul contenuto DEFINITIVO.
    if ('contenuto_json' in updates) {
      const s = updates.contenuto_json != null && typeof updates.contenuto_json === 'object'
        ? sanificaContenuto(updates.contenuto_json)
        : { html: null as string | null, testo: null as string | null }
      updates.contenuto_html = s.html
      updates.contenuto_testo = s.testo
    }

    // ─── IL FILE CHE ESCE DALLA RIGA ESCE ANCHE DAL BUCKET (difetto W1) ──────
    // Fino al 2026-08-03 questa rotta sostituiva o azzerava `copertina_url` (e
    // riscriveva il rich-text) senza toccare lo Storage. Da quel momento nessuna
    // riga nominava più il file vecchio, e il bucket `news` è PUBBLICO: né
    // `verificaPermanenzaConsenso` né `obliaFotoNewsAlunno` né la DELETE
    // potevano più arrivarci, perché calcolano i percorsi dalla riga CORRENTE.
    // La revoca del consenso e il diritto all'oblio smettevano di funzionare su
    // quella foto — che `/api/news/feed` aveva già distribuito in chiaro.
    //
    // Il conto è sulla DIFFERENZA fra i percorsi di PRIMA e quelli di DOPO, non
    // sul campo che è cambiato: la stessa immagine può stare in copertina e nel
    // testo, e liberare «la vecchia copertina» cancellerebbe un file che il
    // testo continua a citare.
    //
    // Si RICALCOLA invece di riusare `copertinaDopo`/`contenutoDopo` del gate:
    // quelli sono i valori di prima della promozione, che riscrive gli indirizzi.
    const dopoLaModifica = percorsiPubbliciDelPost({
      copertina_url: 'copertina_url' in updates ? updates.copertina_url : post.copertina_url,
      contenuto_json: 'contenuto_json' in updates ? updates.contenuto_json : post.contenuto_json,
    })
    const usciti = primaDellaModifica.filter((x) => !dopoLaModifica.includes(x))

    // ─── PRIMA IL FILE (VERIFICATO), POI LA RIGA ─────────────────────────────
    // La stessa regola della DELETE e del ritiro, e la stessa funzione: la
    // domanda è identica — «la riga può smettere di nominare un file che è
    // ancora nel bucket pubblico?» — e la risposta è no. Scriverla qui in un
    // ordine diverso significherebbe due regole per una domanda sola, che è
    // letteralmente la causa radice di questa serie di difetti.
    //
    // LA SCELTA, e il suo prezzo. Liberando prima della scrittura, un guasto
    // dello Storage costa un 503 con la riga intatta e i file al loro posto —
    // stato coerente, si ritenta. Resta una finestra stretta: rimozione
    // riuscita e scrittura fallita subito dopo lasciano l'articolo con
    // l'immagine rotta. È un guasto VISIBILE, che si sana rifacendo la modifica.
    // L'ordine opposto (riga prima, file poi) sposterebbe il costo su un file
    // pubblico che nessuna riga nomina: invisibile, permanente, e sopra la foto
    // di un minore. Fra un'immagine rotta e una foto pubblica per sempre, si
    // sceglie l'immagine rotta.
    if (usciti.length > 0) {
      const liberazione = await liberaPercorsiPubblici(supabase, usciti, p.data, 'news/[id]:PATCH')
      if (!liberazione.liberato) {
        // `liberaPercorsiPubblici` ha già gridato con il corpo dell'errore dello
        // Storage e con il post_id: qui si risponde soltanto, senza scrivere.
        await riportaMediaInBozza(supabase, promossiOra, 'news/[id]:PATCH')
        promossiOra = []
        return NextResponse.json(
          { error: FILE_SOSTITUITI_NON_RIMOSSI, codice: 'NEWS_FILE_SOSTITUITI_NON_RIMOSSI' },
          { status: 503 },
        )
      }
    }

    updates.updated_at = new Date().toISOString()

    const { data, error } = await scriviConDegradazione<NewsPost>(
      updates,
      (rec) => supabase.from('news_posts').update(rec).eq('id', p.data).select().single(),
      'news/[id]:PATCH',
    )
    if (error) {
      // W1-bis: la riga non è cambiata, quindi i media appena promossi non li
      // nomina nessuno. Tornano in sosta nel bucket privato.
      await riportaMediaInBozza(supabase, promossiOra, 'news/[id]:PATCH')
      promossiOra = []
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/[id]:PATCH', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'news/[id]:PATCH', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'aggiornamento della news' }, { status: 500 })
    }
    // LA RIGA È SCRITTA: adesso è LEI a nominare quei file, e riportarli in sosta
    // lascerebbe l'articolo con l'immagine rotta. Si azzera qui, prima di
    // qualunque altra cosa che possa lanciare.
    promossiOra = []
    // Evento critico → si logga anche il SUCCESSO, col numero di file usciti dal
    // bucket pubblico: senza quel conteggio «aggiornato» non distinguerebbe una
    // sostituzione che ha portato via la foto vecchia da una che l'ha lasciata.
    logEvento('news', 'info', {
      operazione: 'news/[id]:PATCH',
      esito: 'aggiornato',
      post_id: p.data,
      n_file: usciti.length,
    })
    return NextResponse.json({ disponibile: true, post: data as NewsPost })
  } catch (err) {
    // PRIMA la causa, POI il rimedio: vedi la gemella in `src/app/api/news/route.ts`.
    logErrore({ operazione: 'news/[id]:PATCH', stato: 500 }, err)
    if (clientPerAnnullo && promossiOra.length > 0) {
      await riportaMediaInBozza(clientPerAnnullo, promossiOra, 'news/[id]:PATCH')
    }
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// DELETE /api/news/[id] — CASCADE su media/visualizzazioni. Educator: solo i propri
// post ancora in bozza|proposta.
export const DELETE = withRoute('news/[id]:DELETE', async (request: NextRequest, { params }: RouteParams) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const p = parseData(zUuid, (await params).id)
    if ('response' in p) return p.response

    const supabase = await createAdminClient()
    const sc = await caricaPostConScope(request, supabase, auth.user, p.data)
    if (sc.response) return sc.response
    const guard = guardEducator(auth.user, sc.post!, true)
    if (guard) return guard

    // ─── PRIMA IL FILE (VERIFICATO), POI LA RIGA ─────────────────────────────
    // Fino al 2026-08-03 questa rotta cancellava la riga e non toccava il bucket
    // `news`, che è PUBBLICO e servito senza login: l'articolo spariva dal sito e
    // la foto del bambino restava al suo indirizzo — senza più nessuna riga che
    // la nominasse. Né il ritiro per consenso caduto (`verificaPermanenzaConsenso`,
    // che legge `news_posts`) né l'oblio del minore (`obliaFotoNewsAlunno`, che
    // cerca l'uuid dentro `bambini_ritratti`) potevano più arrivarci: un guasto
    // invisibile e PERMANENTE, prodotto dal gesto che sembra il più definitivo.
    //
    // La regola non è riscritta qui: è la stessa funzione che usa il ritiro. Una
    // regola valida per due strade deve vivere in un posto solo — è esattamente
    // la causa radice della serie di difetti che questo ciclo sta chiudendo.
    const liberazione = await liberaFilePubbliciDelPost(supabase, sc.post!, 'news/[id]:DELETE')
    if (!liberazione.liberato) {
      // `liberaFilePubbliciDelPost` ha già gridato con il corpo dell'errore dello
      // Storage e con il post_id: qui si risponde soltanto, senza cancellare.
      return NextResponse.json({ error: FILE_NON_RIMOSSI, codice: 'NEWS_FILE_NON_RIMOSSI' }, { status: 503 })
    }

    const { error } = await supabase.from('news_posts').delete().eq('id', p.data)
    if (error) {
      if (schemaAssente(error)) {
        logEvento('news', 'info', { operazione: 'news/[id]:DELETE', esito: 'schema-assente' })
        return NextResponse.json({ disponibile: false }, { status: 503 })
      }
      logErrore({ operazione: 'news/[id]:DELETE', stato: 500, evento: 'db' }, error)
      return NextResponse.json({ error: 'Errore nell\'eliminazione della news' }, { status: 500 })
    }
    // Evento critico → si logga anche il SUCCESSO, col numero di file usciti dal
    // bucket pubblico: senza quel conteggio «eliminato» non distinguerebbe una
    // cancellazione che ha portato via le foto da una che non ha tolto niente.
    logEvento('news', 'info', {
      operazione: 'news/[id]:DELETE',
      esito: 'eliminato',
      post_id: p.data,
      n_file: liberazione.rimossi,
    })
    return NextResponse.json({ disponibile: true })
  } catch (err) {
    logErrore({ operazione: 'news/[id]:DELETE', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
