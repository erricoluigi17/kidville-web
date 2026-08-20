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
  const delMese = (posts ?? []).filter((p) => p.stato === 'pubblicata' && nelMese(p.pubblicata_il, anno, mese))
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
    // SE NON SI È POTUTO NEMMENO TENTARE, NON SI MARCA. È la stessa regola già
    // scritta e provata in src/app/api/push/dispatch/route.ts (~281): «saltate > 0
    // e tentate === 0 ⇒ rimandate++ e si continua». Marcare qui significherebbe
    // perdere l'edizione del mese per sempre.
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
    const giaFatti = Math.max(0, Math.min(edizione.destinatari_count ?? 0, destinatari.length))
    let errori = 0
    let inviate = giaFatti
    let rimandata = false
    for (let i = giaFatti; i < destinatari.length; i++) {
      const res = await sendEmailDetailed({ to: destinatari[i], subject: composto.titolo, text: composto.testo, html: composto.html })
      if (res.ok) {
        inviate++
      } else if (res.rinviabile) {
        rimandata = true
        break
      } else {
        errori++
        inviate++ // tentato e rifiutato in via definitiva: non si ritenta al giro dopo
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

    if (rimandata) {
      // Si salva l'avanzamento e NON si marca `inviata_il`: l'edizione resta in coda
      // e `eseguiDigest` la ripesca al giro successivo.
      const { error: parzErr } = await supabase
        .from('news_digest_edizioni')
        .update({ destinatari_count: inviate, errori_count: errori })
        .eq('id', edizione.id)
        .is('inviata_il', null)
      if (parzErr) {
        // Se nemmeno l'avanzamento si scrive, il giro dopo ricomincia da `giaFatti`: si
        // rispedisce a qualcuno, non si perde nessuno. Ma va detto (regola 6).
        logErrore({ operazione: 'news/digest:avanzamento', stato: 500, evento: 'news' }, parzErr)
      }
      // `warn` e non `error`: non è un guasto, è il tetto del piano che si è fatto
      // sentire — la stessa scelta già fatta in `send.ts`. Ma resta scritto, coi due
      // numeri che contano: senza, «tutte le email» e «un terzo delle email» hanno
      // lo stesso aspetto nei log.
      logEvento('news', 'warn', {
        operazione: 'digest',
        esito: 'rimandata-quota',
        scuola_id: sede.id,
        anno,
        mese,
        inviate,
        mancanti: destinatari.length - inviate,
        errori,
        msg: `digest ${anno}-${mese}: quota email esaurita dopo ${inviate}/${destinatari.length}, edizione lasciata in coda`,
      })
      esito.destinatari_count = inviate
      esito.errori_count = errori
      edizioni.push(esito)
      continue
    }

    // 5) Marca inviata (guardia inviata_il IS NULL contro doppio invio concorrente).
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
