import { deveNotificareGenitori, type ContestoNotificaOperazione } from '@/lib/storici/retroattivita'
import type { SupabaseClient } from '@supabase/supabase-js'
import { genitoriDiScuola } from '@/lib/notifiche/destinatari'
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { isScuolaE2E } from '@/lib/scuole/reali'
import { sendEmailDetailed } from '@/lib/email/send'
import { logEvento, logErrore } from '@/lib/logging/logger'
import { messaggioDigestNews } from '@/lib/email/messaggi/digest-news'
import { risolviContestoSede, type ContestoSede } from '@/lib/email/contesto'
import { schemaAssente } from '@/lib/news/schema-assente'
import { MESI_IT } from '@/lib/news/tipi'
import { pausaFraEmail } from '@/lib/email/ritmo'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
import { createHash, randomUUID } from 'node:crypto'

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
// sede — comunicazione istituzionale: nessun opt-out della singola famiglia
// (decisione 14). L'unico interruttore che conta è quello della SCUOLA: il tipo
// `news` del pannello notifiche (`isNotificaAbilitata`). Spento ⇒ la sede si
// salta e l'edizione NON si marca inviata, così riparte se lo si riaccende.
// Invio SEQUENZIALE con throttle (~2/s) via sendEmailDetailed (che logga già via
// externalFetch). PostgREST non lancia: si controlla sempre `{ error }` — e un
// `{ error }` sui destinatari RIMANDA l'edizione invece di dichiararla inviata a
// zero persone (T17-F4).
//
// ── LA PRESA SULL'EDIZIONE (fase 8 della roadmap di robustezza, 2026-10-11) ──
//
// Fino a qui due giri sulla stessa edizione (il cron del 1° e il bottone
// «genera», o due clic) spedivano ENTRAMBI, e un giro troncato dal tetto della
// Function ripartiva dall'ultimo avanzamento SALVATO — che si salvava solo sul
// 429. Con ~866 famiglie a ~0,4 s l'una il muro dei 300 secondi è a portata:
// il giro dopo avrebbe rispedito a centinaia di famiglie. Ora:
//  · il giro PRENDE l'edizione (`presa_scade_il` + `presa_token`) con un UPDATE
//    condizionato: un secondo giro la trova presa e la lascia;
//  · l'avanzamento si salva ogni `AVANZAMENTO_OGNI` invii, col proprio token, e
//    ogni salvataggio rinnova la presa;
//  · un TETTO DI TEMPO ferma il giro prima del muro: avanzamento salvato, presa
//    lasciata SCADUTA, e il tick dei dieci minuti (`riprendiDigestInterrotti`)
//    riprende l'edizione da lì. Una Function morta davvero lascia la presa a
//    scadere da sola, e il tick la riprende lo stesso;
//  · ogni email porta una chiave d'idempotenza per destinatario: le poche spedite
//    dopo l'ultimo salvataggio, se il giro muore, Resend non le rispedisce (24 h).
// Senza le colonne (DB della CI, non migrato) si spedisce come prima, e lo si dice.
// =============================================================================

/** Quanto vale la presa di un giro sull'edizione. Più della vita massima della route
 *  (`maxDuration` 300 s): una presa che scade mentre il giro è vivo farebbe partire un
 *  secondo giro in parallelo. Ogni salvataggio dell'avanzamento la rinnova. */
export const PRESTITO_DIGEST_MS = 330_000
/** Il tetto di tempo di un giro, misurato dalla `scadenza` che passa il chiamante:
 *  oltre, si salva e si lascia l'edizione al tick. 60 s di margine sotto i 300. */
export const TETTO_GIRO_DIGEST_MS = 240_000
/** Ogni quanti invii si salva l'avanzamento (e si rinnova la presa). */
export const AVANZAMENTO_OGNI = 20
/** Per quanto, dopo che una presa è scaduta, il tick prova a riprendere l'edizione.
 *  Oltre resta al ripescaggio mensile di `eseguiDigest`: un'edizione che non riparte
 *  per un motivo fisso (sede spenta, nessun post) non si ritenta ogni dieci minuti
 *  per sempre. Un giro che avanza la rinnova a ogni tetto di tempo. */
export const FINESTRA_RIPRESA_MS = 2 * 60 * 60_000
/** Quante edizioni interrotte riprende un tick al massimo. */
const RIPRESE_PER_TICK = 3

/**
 * La chiave d'idempotenza dell'edizione per UN destinatario.
 *
 * L'indirizzo non entra in chiaro: ne entra l'impronta sha256 (Resend l'indirizzo ce
 * l'ha già, la chiave serve solo a riconoscere lo stesso invio). Non si usa
 * `hashCorrelabile` del logging: senza `LOG_HASH_SALT` restituisce una COSTANTE, e la
 * stessa chiave per famiglie diverse farebbe rifiutare da Resend tutte le email dopo la
 * prima («stessa chiave, contenuto diverso»).
 */
export function chiaveDigest(edizioneId: string, email: string): string {
  const impronta = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)
  return `digest:${edizioneId}:${impronta}`
}

export interface PostDigest {
  politica_operazione?: ContestoNotificaOperazione | null
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
  /**
   * L'identità della sede che scrive: nome, indirizzo, casella, informativa.
   *
   * Prima qui c'era il solo `nomeSede`, e il piè di pagina si limitava a una
   * riga generica. Dal 2026-08-15 il digest usa il layout comune delle email
   * transazionali, che nomina il plesso e ne porta i recapiti: con tre sedi,
   * una famiglia di Aversa deve leggere l'indirizzo di Aversa.
   */
  sede: ContestoSede
}

export interface DigestComposto {
  titolo: string
  /** Il gemello in testo semplice, generato dagli stessi articoli dell'HTML. */
  testo: string
  post_ids: string[]
  html: string
}

function nelMese(pubblicataIl: string | null, anno: number, mese: number): boolean {
  if (!pubblicataIl) return false
  const d = new Date(pubblicataIl)
  if (Number.isNaN(d.getTime())) return false
  return d.getUTCFullYear() === anno && d.getUTCMonth() + 1 === mese
}

/**
 * L'estratto di un articolo: una riga sola, tagliata a 160 caratteri con i
 * puntini. È il taglio che il design prevede per la scheda, e vale identico
 * nell'HTML e nel gemello testuale perché lo fa una volta sola, qui.
 */
function estratto(testo: string | null | undefined, max = 160): string | null {
  const t = (testo ?? '').replace(/\s+/g, ' ').trim()
  if (t === '') return null
  if (t.length <= max) return t
  return `${t.slice(0, max - 1).trimEnd()}…`
}

export function componiDigest(posts: PostDigest[], params: ComponiDigestParams): DigestComposto | null {
  const { anno, mese, sede } = params
  const delMese = (posts ?? []).filter((p) => p.stato === 'pubblicata' && deveNotificareGenitori(p.politica_operazione) && nelMese(p.pubblicata_il, anno, mese))
  if (delMese.length === 0) return null

  const ordinati = [...delMese].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const da = a.pubblicata_il ? Date.parse(a.pubblicata_il) : 0
    const db = b.pubblicata_il ? Date.parse(b.pubblicata_il) : 0
    return db - da
  })

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? null
  const messaggio = messaggioDigestNews({
    mese: MESI_IT[mese - 1] ?? '',
    anno,
    articoli: ordinati.map((p) => ({
      categoria: p.categoria_nome ?? null,
      titolo: p.titolo,
      estratto: estratto(p.contenuto_testo),
      url: baseUrl ? `${baseUrl}/parent/news/${encodeURIComponent(p.id)}` : null,
    })),
  }, sede)

  return {
    titolo: messaggio.oggetto,
    post_ids: ordinati.map((p) => p.id),
    html: messaggio.html,
    // Il gemello testuale nasce dagli STESSI articoli, non da una seconda
    // scrittura. Prima era `testoFallback`, che stampava i soli titoli mentre
    // l'HTML portava categoria, estratto e link: nell'unico posto del repo dove
    // i due corpi convivevano, avevano già divergiuto.
    testo: messaggio.testo,
  }
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

/**
 * Sedi a cui spedire il digest.
 *
 * LA SEDE FINTA DELLA CI NON È UNA SEDE. Qui c'era il solo `.eq('attiva', true)`,
 * e in produzione «Kidville E2E» ha `attiva = true`: entrava nel giro, generava
 * un'edizione e provava a spedirla ai suoi account `@kidville.test` — un TLD non
 * instradabile, quindi solo errori di invio contati come `errori_count`. Il
 * predicato «sede reale» è centralizzato in `@/lib/scuole/reali` proprio per non
 * averne due versioni: qui non veniva usato.
 *
 * Vale anche quando la sede arriva ESPLICITA (`/news/digest/genera`): si rifiuta
 * con un log invece di generare l'edizione in silenzio.
 */
async function sediBersaglio(
  supabase: SupabaseClient,
  scuolaId?: string,
): Promise<{ id: string; nome: string }[]> {
  if (scuolaId) {
    const { data, error } = await supabase.from('scuole').select('id, nome').eq('id', scuolaId).maybeSingle()
    if (error) {
      logEvento('news', 'warn', { operazione: 'news/digest:sedi', esito: 'query-fallita', scuola_id: scuolaId }, error)
      return []
    }
    if (!data) return []
    const sede = data as { id: string; nome: string }
    if (isScuolaE2E(sede)) {
      logEvento('news', 'warn', {
        operazione: 'news/digest:sedi', esito: 'sede-di-collaudo', scuola_id: sede.id,
      })
      return []
    }
    return [sede]
  }
  const { data, error } = await supabase.from('scuole').select('id, nome').eq('attiva', true)
  if (error) {
    logEvento('news', 'error', { operazione: 'news/digest:sedi', esito: 'query-fallita' }, error)
    return []
  }
  return (data ?? []).filter((s) => !isScuolaE2E(s as { id: string; nome: string })) as { id: string; nome: string }[]
}

function estremiMese(anno: number, mese: number): { inizio: string; fine: string } {
  const inizio = new Date(Date.UTC(anno, mese - 1, 1)).toISOString()
  const fine = new Date(Date.UTC(anno, mese, 1)).toISOString() // primo giorno del mese successivo (esclusivo)
  return { inizio, fine }
}

/** Esito della ricerca dei destinatari: `ok: false` = **non ho potuto leggere**. */
interface Destinatari {
  ok: boolean
  emails: string[]
}

/**
 * Le email delle famiglie della sede.
 *
 * «ZERO FAMIGLIE» E «NON HO POTUTO LEGGERE» NON SONO LA STESSA COSA, e qui lo
 * erano: `if (error || !data) return []`. Un errore PostgREST sulla tabella
 * `utenti` (che non lancia — AGENTS regola 7) usciva da questa funzione
 * travestito da elenco vuoto e senza una riga di log (regola 6). Il chiamante
 * spediva zero email, marcava `inviata_il` e l'edizione del mese era persa per
 * sempre: al giro dopo la guardia di idempotenza la saltava. Esito misurato dal
 * collaudo (T17-F4): `inviata true · destinatari_count 0 · errori_count 0`,
 * zero email, zero log.
 *
 * Ora il fallimento ha un valore suo (`ok: false`) e una riga di log con il
 * corpo dell'errore. La decisione su cosa farne è del chiamante.
 *
 * `genitoriDiScuola` ha la stessa ambiguità e non è correggibile da qui (la
 * usano nove chiamanti): ritorna `[]` sia con zero alunni sia con la query
 * fallita, loggando ma senza distinguere. Per questo, quando i genitori sono
 * zero, si RILEGGE il conteggio degli alunni della sede: se nemmeno quello si
 * legge, non sappiamo se ci sono famiglie, e non sapendo non si marca.
 */
async function emailFamiglie(supabase: SupabaseClient, scuolaId: string): Promise<Destinatari> {
  const genitori = await genitoriDiScuola(supabase, scuolaId)
  if (genitori.length === 0) {
    // `.eq('stato', …)` NON è una precauzione in più: è la condizione perché i
    // due numeri siano CONFRONTABILI. `genitoriDiScuola` conta i genitori dei
    // soli ISCRITTI (dal 2026-08-12); se qui si contassero anche gli archiviati,
    // una sede rimasta senza bambini in corso produrrebbe «alunni ce ne sono,
    // genitori collegati no» — un warn che accusa i legami di un guasto che non
    // c'è, e manda a cercare il difetto dalla parte sbagliata.
    const { count, error } = await supabase
      .from('alunni')
      .select('id', { count: 'exact', head: true })
      .eq('scuola_id', scuolaId)
      .in('stato', [...STATI_CON_CANALE_FAMIGLIA])
    if (error) {
      logEvento('news', 'error', {
        operazione: 'news/digest:destinatari', esito: 'alunni-non-letti', scuola_id: scuolaId,
      }, error)
      return { ok: false, emails: [] }
    }
    if ((count ?? 0) > 0) {
      // Alunni ce ne sono, genitori collegati no: non è un guasto di lettura, ma
      // un digest a zero destinatari va detto — altrimenti «nessuna email» e
      // «tutto a posto» hanno lo stesso aspetto.
      logEvento('news', 'warn', {
        operazione: 'news/digest:destinatari', esito: 'nessun-genitore-collegato',
        scuola_id: scuolaId, alunni: count ?? 0,
      })
    }
    return { ok: true, emails: [] }
  }
  const { data, error } = await supabase.from('utenti').select('email').in('id', genitori)
  if (error || !data) {
    logEvento('news', 'error', {
      operazione: 'news/digest:destinatari', esito: 'utenti-non-letti',
      scuola_id: scuolaId, genitori: genitori.length,
    }, error ?? undefined)
    return { ok: false, emails: [] }
  }
  const emails = (data as { email: string | null }[])
    .map((u) => (u.email ?? '').trim())
    .filter((e) => e.includes('@'))
  // ⚠️ ORDINATO, e non per estetica: `destinatari_count` fa da SEGNAPOSTO quando
  // un'edizione resta a metà per quota esaurita (vedi il ciclo d'invio). Un offset
  // dentro un elenco che PostgREST non promette di restituire nello stesso ordine
  // salterebbe famiglie diverse a ogni giro. `.sort()` costa nulla su qualche
  // centinaio di stringhe e rende la ripresa ripetibile.
  return { ok: true, emails: [...new Set(emails)].sort() }
}

/** L'esito della presa sull'edizione. `conPresa: false` = il DB non ha le colonne
 *  (CI non migrata): si spedisce come prima, senza presa. */
type Presa =
  | { esito: 'presa'; conPresa: boolean; token: string | null; destinatari_count: number | null; errori_count: number | null }
  | { esito: 'altrui' }
  | { esito: 'guasto' }

/**
 * Prende l'edizione per questo giro: UN `UPDATE` condizionato, atomico nel database.
 * Riesce solo se l'edizione non è inviata e nessun altro giro la tiene (presa assente
 * o scaduta). Restituisce l'avanzamento RILETTO nello stesso istante: quello letto
 * prima può essere già vecchio, se un altro giro ha appena salvato.
 */
async function prendiEdizione(
  supabase: SupabaseClient,
  edizioneId: string,
  campi: { scuola_id: string; anno: number; mese: number },
): Promise<Presa> {
  const token = randomUUID()
  const adesso = Date.now()
  const { data, error } = await supabase
    .from('news_digest_edizioni')
    .update({ presa_scade_il: new Date(adesso + PRESTITO_DIGEST_MS).toISOString(), presa_token: token })
    .eq('id', edizioneId)
    .is('inviata_il', null)
    // Le virgolette non sono decorative: nella sintassi di `or` il punto e i due punti
    // di una data ISO sono caratteri riservati di PostgREST.
    .or(`presa_scade_il.is.null,presa_scade_il.lt."${new Date(adesso).toISOString()}"`)
    .select('destinatari_count, errori_count')
  if (error) {
    if (colonnaNuovaAssente(error)) {
      logEvento('news', 'info', {
        operazione: 'digest', esito: 'presa-senza-colonne', edizione_id: edizioneId, ...campi,
        msg: 'news_digest_edizioni senza presa_scade_il/presa_token (migrazione della fase 8 non applicata): si spedisce senza presa',
      })
      return { esito: 'presa', conPresa: false, token: null, destinatari_count: null, errori_count: null }
    }
    // Non sapendo se un altro giro sta spedendo, non si spedisce: l'edizione resta in
    // coda (inviata_il null) e la riprende il giro successivo.
    logEvento('news', 'error', { operazione: 'digest', esito: 'presa-non-riuscita', edizione_id: edizioneId, ...campi }, error)
    return { esito: 'guasto' }
  }
  const riga = ((data ?? []) as { destinatari_count: number | null; errori_count: number | null }[])[0]
  if (!riga) {
    logEvento('news', 'info', {
      operazione: 'digest', esito: 'presa-altrui', edizione_id: edizioneId, ...campi,
      msg: 'un altro giro sta spedendo questa edizione, o l’ha appena chiusa: questo giro la lascia',
    })
    return { esito: 'altrui' }
  }
  return { esito: 'presa', conPresa: true, token, destinatari_count: riga.destinatari_count, errori_count: riga.errori_count }
}

/**
 * Scrive sull'edizione SOLO se è ancora di questo giro (stesso token, non inviata).
 * `campiPresa` si scrivono solo con la presa: senza le colonne un UPDATE che le nomina
 * fallirebbe con `PGRST204` e non salverebbe nemmeno l'avanzamento.
 *  · `ok`     — scritto;
 *  · `persa`  — zero righe: la presa è scaduta e un altro giro l'ha presa (o chiusa);
 *  · `guasto` — PostgREST ha risposto con un errore, già loggato qui.
 */
async function scriviSeMia(
  supabase: SupabaseClient,
  edizioneId: string,
  presa: { conPresa: boolean; token: string | null },
  campi: Record<string, unknown>,
  campiPresa: Record<string, unknown>,
  operazione: string,
): Promise<'ok' | 'persa' | 'guasto'> {
  if (!presa.conPresa || !presa.token) {
    const { error } = await supabase.from('news_digest_edizioni').update(campi).eq('id', edizioneId).is('inviata_il', null)
    if (error) {
      logErrore({ operazione, stato: 500, evento: 'news' }, error)
      return 'guasto'
    }
    return 'ok'
  }
  const { data, error } = await supabase
    .from('news_digest_edizioni')
    .update({ ...campi, ...campiPresa })
    .eq('id', edizioneId)
    .eq('presa_token', presa.token)
    .is('inviata_il', null)
    .select('id')
  if (error) {
    logErrore({ operazione, stato: 500, evento: 'news' }, error)
    return 'guasto'
  }
  return (data ?? []).length > 0 ? 'ok' : 'persa'
}

/**
 * Genera e invia il digest del mese per una o tutte le sedi. Idempotente:
 * un'edizione già inviata non viene re-inviata. Ritorna l'esito per sede.
 *
 * `scadenza` (epoch ms) è il tetto di tempo del giro, CONDIVISO fra le sedi e fra
 * chiamate successive nella stessa route: chi chiama più volte (il ripescaggio delle
 * arretrate) passa la stessa. Senza, vale `TETTO_GIRO_DIGEST_MS` da adesso.
 */
export async function generaEInviaDigest(
  supabase: SupabaseClient,
  opts: { anno: number; mese: number; scuolaId?: string; scadenza?: number },
): Promise<{ edizioni: EdizioneEsito[] }> {
  const { anno, mese } = opts
  const scadenza = opts.scadenza ?? Date.now() + TETTO_GIRO_DIGEST_MS
  const sedi = await sediBersaglio(supabase, opts.scuolaId)
  const edizioni: EdizioneEsito[] = []

  for (const sede of sedi) {
    const esito: EdizioneEsito = { scuola_id: sede.id, generata: false, inviata: false, destinatari_count: 0, errori_count: 0 }

    // 1) Carica i pubblicati del mese (della sede + globali).
    const { inizio, fine } = estremiMese(anno, mese)
    const { data: postRows, error: postErr } = await supabase
      .from('news_posts')
      .select('id, titolo, stato, pinned, pubblicata_il, contenuto_testo, categoria_id, target_scope, politica_operazione')
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

    const contestoSede = await risolviContestoSede(supabase, sede.id, 'news/digest')
    const composto = componiDigest((postRows ?? []) as PostDigest[], {
      scuolaId: sede.id, anno, mese, sede: contestoSede,
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

    // 3) L'INTERRUTTORE CHE L'ADMIN HA GIÀ IN MANO (T17-F5).
    //
    // Il tipo `news` esiste nel pannello notifiche (src/lib/notifiche/tipi.ts) e
    // il gate `isNotificaAbilitata` ha nove chiamanti: il digest non era fra
    // loro. Un admin che spegneva «News della scuola» continuava a vedere il
    // digest partire a tutte le famiglie — due impostazioni che dicono cose
    // opposte. `isNotificaAbilitata` è fail-open (config illeggibile ⇒ attiva),
    // quindi qui si salta SOLO su un «no» esplicito.
    //
    // Non si marca `inviata_il`: se il toggle viene riacceso, l'edizione riparte.
    if (!(await isNotificaAbilitata(supabase, 'news', sede.id))) {
      logEvento('news', 'info', {
        operazione: 'digest', esito: 'tipo-disattivato', scuola_id: sede.id, anno, mese,
      })
      edizioni.push(esito)
      continue
    }

    // 4) Invio a TUTTE le famiglie della sede (comunicazione istituzionale).
    const { ok: destinatariOk, emails: destinatari } = await emailFamiglie(supabase, sede.id)
    // SE NON SI È POTUTO NEMMENO TENTARE, NON SI MARCA. È la stessa regola del
    // dispatch delle push, in src/lib/push/dispatch.ts, passo 3 «LE RIMANDATE PER
    // CANALE SPENTO»: una notifica i cui destinatari non sono raggiungibili perché il
    // loro canale è spento non si prende e resta in coda (`rimandate++`). Marcare qui
    // significherebbe perdere l'edizione del mese per sempre.
    //
    // ⚠️ FINO AL 2026-08-20 QUI C'ERA SCRITTO «riparte al giro successivo (il cron
    // gira ogni giorno)». NON GIRA OGNI GIORNO: `news-digest` è schedulato
    // `'0 8 1 * *'` — una volta al mese, il primo
    // (`supabase/migrations/20260720191525_news_cron.sql:109`). Quello che gira ogni
    // dieci minuti è `news-tick`, che è un ALTRO lavoro, dieci righe sopra nella
    // stessa migrazione.
    //
    // La cautela era giusta, la ragione scritta accanto no — ed è la ragione che il
    // prossimo legge per decidere se fidarsi. Peggio: `generaEInviaDigest` lavora su
    // UN mese solo, quello che il chiamante gli passa, quindi un'edizione lasciata
    // in coda qui non veniva ripresa NEMMENO il mese dopo: restava orfana esattamente
    // come se fosse stata marcata. È `eseguiDigest`
    // (`src/app/api/news/cron/run/route.ts`) a ripescare ora le edizioni pendenti dei
    // mesi passati: senza quel ripescaggio questo `continue` è una perdita silenziosa
    // travestita da prudenza.
    if (!destinatariOk) {
      logEvento('news', 'error', {
        operazione: 'digest', esito: 'rimandata', scuola_id: sede.id, anno, mese,
      })
      edizioni.push(esito)
      continue
    }
    // ── IL TETTO DEL PROVIDER NON È UN FALLIMENTO: È UN «NON OGGI» ─────────────
    //
    // `sendEmailDetailed` distingue i due casi DA SEMPRE — `src/lib/email/send.ts`
    // ritorna `{ ok: false, rinviabile: true }` sul `429` e spiega accanto che «un
    // rifiuto definitivo consuma un tentativo, un `429` rinvia». Fino al 2026-08-20
    // questo ciclo NON guardava quel campo: scorreva tutti i destinatari
    // collezionando 429, e poi marcava `inviata_il` lo stesso. L'edizione risultava
    // inviata a chi non l'aveva ricevuta, e `inviata_il IS NULL` — l'unica guardia
    // che decide se rispedire — non sarebbe stata mai più vera. Nessun errore,
    // nessuno che se ne accorge tranne le famiglie che non ricevono niente.
    //
    // Al PRIMO `rinviabile` ci si ferma. La quota è finita per oggi: continuare
    // significa solo collezionare altri 429 e, col throttle di 500 ms, tenere
    // occupata la route per minuti a vuoto.
    //
    // ── LA RIPRESA, SENZA UNA COLONNA NUOVA ────────────────────────────────────
    //
    // `destinatari_count` fa da segnaposto. Non è un uso improprio: il suo
    // significato diventa «a quanti è arrivata FINORA», che a edizione completa
    // coincide col totale — cioè con ciò che ha sempre voluto dire. Il giro
    // successivo riprende da lì invece di ricominciare da capo e spedire due volte
    // a chi l'ha già ricevuto. Perché l'offset significhi qualcosa, `emailFamiglie`
    // restituisce l'elenco ORDINATO (vedi lì).
    //
    // ⚠️ IL PREZZO, che va conosciuto e non scoperto: se fra due giri l'elenco
    // cambia, l'offset è approssimato. Una famiglia che si iscrive nel frattempo e
    // ordina PRIMA dell'offset non riceve QUELL'edizione — ed è il verso giusto
    // dell'errore, perché è il digest di un mese in cui quella famiglia non c'era.
    // Il verso sbagliato (spedire due volte) resta possibile solo se un indirizzo
    // cambia: si è preferito così, perché una mail doppia è un fastidio e una mail
    // mancante è una comunicazione istituzionale persa.
    //
    // 5) LA PRESA (vedi la testata): l'avanzamento da cui si riparte è quello riletto
    //    DALLA presa, non quello letto all'inizio.
    const presa = await prendiEdizione(supabase, edizione.id, { scuola_id: sede.id, anno, mese })
    if (presa.esito !== 'presa') {
      edizioni.push(esito)
      continue
    }
    const giaFatti = Math.max(0, Math.min(presa.destinatari_count ?? edizione.destinatari_count ?? 0, destinatari.length))
    // Gli errori di un giro precedente restano contati: `errori_count` è dell'edizione,
    // non del giro (fino al 2026-10-11 ripartiva da zero a ogni ripresa).
    let errori = giaFatti > 0 ? (presa.errori_count ?? edizione.errori_count ?? 0) : 0
    let inviate = giaFatti
    let rimandata = false
    let fermataPerTempo = false
    let presaPersa = false
    let dalSalvataggio = 0
    for (let i = giaFatti; i < destinatari.length; i++) {
      if (Date.now() >= scadenza) {
        fermataPerTempo = true
        break
      }
      const res = await sendEmailDetailed({
        to: destinatari[i], subject: composto.titolo, text: composto.testo, html: composto.html,
        chiaveIdempotenza: chiaveDigest(edizione.id, destinatari[i]),
      })
      if (res.ok) {
        inviate++
      } else if (res.rinviabile) {
        rimandata = true
        break
      } else {
        errori++
        inviate++ // tentato e rifiutato in via definitiva: non si ritenta al giro dopo
      }
      // L'AVANZAMENTO A INTERVALLI. Se la Function muore fra due salvataggi, il giro
      // dopo riparte dall'ultimo: le email in mezzo (al massimo `AVANZAMENTO_OGNI`)
      // tornano a Resend con la STESSA chiave, e Resend non le rispedisce.
      if (++dalSalvataggio >= AVANZAMENTO_OGNI && i < destinatari.length - 1) {
        dalSalvataggio = 0
        const salvato = await scriviSeMia(
          supabase, edizione.id, presa,
          { destinatari_count: inviate, errori_count: errori },
          { presa_scade_il: new Date(Date.now() + PRESTITO_DIGEST_MS).toISOString() },
          'news/digest:avanzamento',
        )
        if (salvato === 'persa') {
          presaPersa = true
          break
        }
      }
      // Il passo fra due email vive in un posto solo: `@/lib/email/ritmo`.
      //
      // ⚠️ QUI IL PASSO NON È COSMESI. Il digest del 1° settembre è il primo che
      // scriverà a ~500 famiglie (sono gli account che l'import delle iscrizioni
      // sta creando in questi giorni). A 500 ms sarebbero 250 secondi di sola
      // attesa, contro un tetto di 300 per la funzione: il giro morirebbe prima
      // della fine, senza salvare l'avanzamento, e quello dopo RISPEDIREBBE a
      // chi aveva già ricevuto. A 150 ms sono ~75 secondi.
      if (i < destinatari.length - 1) await pausaFraEmail()
    }

    const lascia = { presa_scade_il: null, presa_token: null }
    const contatori = { scuola_id: sede.id, anno, mese, inviate, mancanti: destinatari.length - inviate, errori }

    if (presaPersa) {
      // La presa è scaduta mentre questo giro era vivo, e un altro l'ha presa: da qui
      // spedisce lui. Questo giro non scrive più niente sull'edizione. Le email di
      // questo giro dopo l'ultimo salvataggio l'altro le ritenta con la stessa chiave,
      // e Resend non le rispedisce.
      logEvento('news', 'warn', {
        operazione: 'digest', esito: 'presa-persa', ...contatori,
        msg: `digest ${anno}-${mese}: presa scaduta durante il giro, l’edizione la continua un altro giro`,
      })
      esito.destinatari_count = inviate
      esito.errori_count = errori
      edizioni.push(esito)
      continue
    }

    if (rimandata || fermataPerTempo) {
      // Si salva l'avanzamento e NON si marca `inviata_il`: l'edizione resta in coda.
      //  · QUOTA (429): la presa si LASCIA (null). Ritentare fra dieci minuti
      //    collezionerebbe solo altri 429: la ripesca `eseguiDigest` al giro mensile,
      //    o il bottone «genera».
      //  · TEMPO: la presa si lascia SCADUTA (adesso). È il segnale per il tick dei
      //    dieci minuti (`riprendiDigestInterrotti`), che la riprende da qui.
      // Se nemmeno l'avanzamento si scrive, il giro dopo ricomincia dall'ultimo
      // salvataggio: le chiavi d'idempotenza evitano il doppione, e `scriviSeMia` lo
      // ha già detto a livello `error` (regola 6).
      await scriviSeMia(
        supabase, edizione.id, presa,
        { destinatari_count: inviate, errori_count: errori },
        rimandata ? lascia : { presa_scade_il: new Date().toISOString(), presa_token: null },
        'news/digest:avanzamento',
      )
      // `warn` e non `error`: non è un guasto, è un tetto (del piano o del tempo) che
      // si è fatto sentire — la stessa scelta già fatta in `send.ts`. Ma resta scritto,
      // coi due numeri che contano: senza, «tutte le email» e «un terzo delle email»
      // hanno lo stesso aspetto nei log.
      logEvento('news', 'warn', {
        operazione: 'digest',
        esito: rimandata ? 'rimandata-quota' : 'rimandata-tempo',
        ...contatori,
        msg: rimandata
          ? `digest ${anno}-${mese}: quota email esaurita dopo ${inviate}/${destinatari.length}, edizione lasciata in coda`
          : `digest ${anno}-${mese}: tetto di tempo del giro dopo ${inviate}/${destinatari.length}, la riprende il tick`,
      })
      esito.destinatari_count = inviate
      esito.errori_count = errori
      edizioni.push(esito)
      continue
    }

    // 6) Marca inviata e lascia la presa (guardie: inviata_il IS NULL e il proprio token).
    const chiusa = await scriviSeMia(
      supabase, edizione.id, presa,
      { inviata_il: new Date().toISOString(), destinatari_count: destinatari.length, errori_count: errori },
      lascia,
      'news/digest:marca-inviata',
    )
    if (chiusa === 'persa') {
      // Tutte le email sono partite, ma la presa nel frattempo è passata a un altro
      // giro: sarà lui a marcare. Le sue email tornano a Resend con le stesse chiavi.
      logEvento('news', 'warn', {
        operazione: 'digest', esito: 'presa-persa', ...contatori,
        msg: `digest ${anno}-${mese}: spedita a tutti, ma la presa era scaduta: la marca il giro che l’ha presa`,
      })
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

/**
 * LE EDIZIONI INTERROTTE, riprese dal tick dei dieci minuti.
 *
 * Un'edizione con la presa SCADUTA e `inviata_il` ancora null è un giro che non ha
 * finito: fermato dal tetto di tempo (che la lascia scaduta apposta) o morto davvero
 * (la presa scade da sola). Senza questa ripresa la riprenderebbe solo il giro
 * mensile — un mese dopo — o qualcuno col bottone «genera».
 *
 * Solo prese scadute da meno di `FINESTRA_RIPRESA_MS`: oltre, l'edizione resta al
 * ripescaggio mensile (vedi la costante). Non c'è rischio di doppio invio: la ripresa
 * passa da `generaEInviaDigest`, cioè dalla stessa presa e dalle stesse chiavi.
 *
 * `disponibile: false` = il DB non ha le colonne (CI non migrata).
 */
export async function riprendiDigestInterrotti(
  supabase: SupabaseClient,
  opts: { scadenza: number },
): Promise<{ disponibile: boolean; riprese: number; inviate: number }> {
  const adesso = Date.now()
  const { data, error } = await supabase
    .from('news_digest_edizioni')
    .select('scuola_id, anno, mese')
    .is('inviata_il', null)
    .lt('presa_scade_il', new Date(adesso).toISOString())
    .gte('presa_scade_il', new Date(adesso - FINESTRA_RIPRESA_MS).toISOString())
    .order('presa_scade_il', { ascending: true })
    .limit(RIPRESE_PER_TICK)
  if (error) {
    if (colonnaNuovaAssente(error)) {
      logEvento('news', 'info', {
        operazione: 'digest:ripresa', esito: 'presa-senza-colonne',
        msg: 'news_digest_edizioni senza presa_scade_il (migrazione della fase 8 non applicata): nessuna ripresa',
      })
      return { disponibile: false, riprese: 0, inviate: 0 }
    }
    logEvento('news', 'error', { operazione: 'digest:ripresa', esito: 'interrotte-non-lette' }, error)
    return { disponibile: true, riprese: 0, inviate: 0 }
  }
  let riprese = 0
  let inviate = 0
  for (const e of (data ?? []) as { scuola_id: string; anno: number; mese: number }[]) {
    if (Date.now() >= opts.scadenza) break
    const { edizioni } = await generaEInviaDigest(supabase, {
      anno: e.anno, mese: e.mese, scuolaId: e.scuola_id, scadenza: opts.scadenza,
    })
    riprese++
    inviate += edizioni.filter((x) => x.inviata).length
  }
  if (riprese > 0) {
    // Il successo di un canale critico si logga (regola 5): senza, «nessuna edizione
    // interrotta» e «la ripresa non è mai partita» hanno lo stesso aspetto.
    logEvento('news', 'info', {
      operazione: 'digest:ripresa', esito: 'ok', riprese, chiuse: inviate,
      msg: `digest: riprese ${riprese} edizioni interrotte, ${inviate} chiuse`,
    })
  }
  return { disponibile: true, riprese, inviate }
}
