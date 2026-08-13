import type { SupabaseClient } from '@supabase/supabase-js'
import { obliaAllegatiChat, obliaFotoAlunno } from '@/lib/gdpr/esegui'
import { sorteDellaFoto, type RigaMedia } from '@/lib/gdpr/foto-partizione'
import { obliaFotoNewsAlunno } from '@/lib/news/permanenza-consenso'
import { schemaAssente } from '@/lib/news/schema-assente'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// LIBERA SPAZIO — il secondo tempo del ciclo di vita di un alunno.
//
// ─── PERCHÉ ESISTE, E PERCHÉ NON È L'OBLIO ──────────────────────────────────
//
// Il modello deciso dal titolare il 2026-08-12 ha due tempi, e questo è il
// secondo:
//   1. ARCHIVIA — il bambino esce dagli elenchi operativi, l'anagrafica resta
//      INTATTA (nome, cognome, codice fiscale), così registri e pagamenti
//      restano leggibili per i dieci anni di conservazione. È reversibile.
//   2. LIBERA SPAZIO — solo da quell'elenco: se ne vanno foto, video e i
//      messaggi PER INTERO. Restano pagamenti, presenze, voti, pagelle, note,
//      diario e certificati medici.
//
// NON è l'art. 17. L'oblio (`admin/gdpr/erase`) è una richiesta della famiglia e
// azzera l'IDENTITÀ; questo è una scelta della Scuola, che tiene l'identità e
// toglie il PESO — le immagini e le conversazioni, cioè ciò che occupa i bucket
// e ciò che, restando, continua a raccontare un bambino che non frequenta più
// (art. 5 §1 lett. e: i dati si conservano per il tempo necessario, e per una
// foto quel tempo finisce con l'iscrizione — è ciò che `/privacy` dichiara).
//
// ─── PERCHÉ IL MOTORE STA QUI E NON IN `@/lib/gdpr/esegui` ──────────────────
//
// Quel file è sotto il lock `gdpr-oblio-completo`, che pretende che ogni bucket
// dello Storage sia dichiarato COPERTO o ESCLUSO dai due canali dell'oblio
// (`alunno`, `genitore`). «Libera spazio» non è nessuno dei due: gonfiarlo con
// un canale che non è l'art. 17 renderebbe illeggibile proprio la domanda che
// quel registro esiste per far rispondere — «chi svuota questo magazzino quando
// la famiglia se ne va?». Le tre funzioni che tolgono i file si RIUSANO da lì,
// così com'è scritto: una regola valida per due strade deve vivere in un posto
// solo, altrimenti diverge in silenzio (già successo in questo repo, tre volte).
// =============================================================================

/**
 * CIÒ CHE «LIBERA SPAZIO» NON TOCCA — l'elenco, scritto, che torna al client.
 *
 * Non è documentazione di cortesia: è il contratto che l'operatore legge nel
 * riquadro di conferma prima di premere un pulsante senza annulla, ed è ciò che
 * `__tests__/lib/libera-spazio-perimetro.test.ts` verifica riga per riga su un
 * client finto — nessuna scrittura su nessuna di queste tabelle. Un elenco che
 * dichiara e non fa è peggio del silenzio: chi lo legge ci costruisce sopra una
 * decisione.
 *
 * Le prime nove sono lì per un obbligo di conservazione (registri didattici e
 * pagamenti, dieci anni); `alunni` perché l'anagrafica è il punto di tutto il
 * modello — il nome del bambino esiste in un posto solo, e togliendolo si
 * renderebbero illeggibili in un colpo i registri di ogni anno passato;
 * `chat_threads` per un motivo suo, scritto sotto `liberaSpazio`.
 *
 * ⚠️ SU `alunni` C'È UNA SOLA ECCEZIONE, ed è meglio dirla che nasconderla: a
 * lavoro finito si scrive `spazio_liberato_il`. Non è un dato del bambino — è la
 * data del gesto, che serve a non ripeterlo e a saperlo dire fra dieci anni.
 * Nome, cognome, codice fiscale e tutto il resto non si toccano, e il test del
 * perimetro verifica proprio questo: sull'anagrafica quella colonna è l'UNICA
 * chiave che può comparire in una scrittura.
 *
 * ⚠️ `audit_scritture_docente` NON È PIÙ IN QUESTO ELENCO — tolto il 2026-08-13,
 * ed è il rilievo di un critico che aveva ragione. Ci stava per dire una cosa
 * vera («il registro d'audit non si distrugge»), ma l'elenco viaggia al client
 * sotto il nome `non_tocca` e la rotta, subito dopo aver liberato lo spazio,
 * fa `logScrittura` — che è un `INSERT` proprio lì dentro. La promessa era vera
 * dove il test la provava (la libreria non ci scrive) e falsa dove veniva
 * spedita (la rotta ci scrive). Fra riscrivere la promessa e toglierne la voce,
 * si toglie la voce: `non_tocca` deve poter essere letto alla lettera. Che il
 * registro d'audit non venga DISTRUTTO è vero e resta provato — vedi
 * `TABELLE_CHE_RESTANO_LEGGIBILI`.
 */
export const TABELLE_INTATTE: readonly string[] = [
  'pagamenti',
  'incassi',
  'presenze',
  'valutazioni',
  'pagelle',
  'note_disciplinari',
  'eventi_diario',
  'certificati_medici',
  'certificati_competenze',
  'armadietto',
  'ticket_mensa',
  'legame_genitori_alunni',
  'student_parents',
  'enrollment_submissions',
  'alunni',
  'chat_threads',
  'segnalazioni',
  'registro_modifiche',
]

/**
 * IL REGISTRO IMMUTABILE: non si distrugge, ma si SCRIVE — e le due cose non
 * sono la stessa promessa.
 *
 * `admin/students/libera-spazio:POST` chiama `logScrittura` a lavoro finito, che
 * inserisce in `audit_scritture_docente` la riga «chi ha liberato lo spazio di
 * chi, e quando». Nessuna delle sue righe viene cancellata o modificata; una ne
 * viene aggiunta. Perciò questa tabella sta qui e non in `TABELLE_INTATTE`: il
 * test del perimetro pretende su quelle **zero scritture**, e una voce che
 * pretende zero mentre la rotta ne fa una è la promessa che si scopre falsa il
 * giorno in cui qualcuno la verifica.
 */
export const TABELLE_CHE_RESTANO_LEGGIBILI: readonly string[] = ['audit_scritture_docente']

/** I bucket che restano intatti insieme alle loro tabelle. */
export const BUCKET_INTATTI: readonly string[] = [
  'fatture',
  'cassa-giustificativi',
  'pagelle',
  'certificati-medici',
]

/** Quello che il dry-run misura, e che l'operatore legge prima di confermare. */
export interface ContiSpazio {
  /** Media taggati SOLO a lui, non video: se ne va il file e se ne va la riga. */
  foto_sole_sue: number
  /** Video taggati SOLO a lui: stesso trattamento delle foto, contati a parte. */
  video_soli_suoi: number
  /** Media che ritraggono anche altri bambini: si toglie solo il suo tag. */
  media_di_gruppo: number
  /**
   * Media taggati solo a lui il cui INDIRIZZO non è riconoscibile in questo
   * archivio: l'esecuzione non toglie né il file né la riga (`sorteDellaFoto`
   * → `trattenuta`). Stanno in un numero loro perché sommarli a `foto_sole_sue`
   * prometterebbe una distruzione che non avviene — è la stessa distinzione di
   * `ConteggiOblio.foto_non_rimovibili`, e per la stessa ragione.
   */
  media_non_rimovibili: number
  /** Messaggi di chat dei suoi thread, testo compreso: se ne vanno tutti. */
  messaggi: number
  /** Quanti di quei messaggi portano un allegato da togliere dal bucket. */
  allegati: number
  /** Le conversazioni interessate. NON si cancellano: vedi `liberaSpazio`. */
  thread: number
  /** Articoli del sito PUBBLICO che lo dichiarano fra i ritratti. */
  articoli_pubblici: number
}

/** L'esito dell'esecuzione: solo conteggi, mai un nome e mai un percorso. */
export interface EsitoSpazio {
  foto_rimosse: number
  foto_sganciate: number
  file_rimossi: number
  n_file_non_rimossi: number
  messaggi_cancellati: number
  messaggi_trattenuti: number
  articoli_ritirati: number
  /**
   * Quanti archivi NON si sono potuti LEGGERE durante l'esecuzione (galleria,
   * sito pubblico). Non è un file rimasto dentro: è un magazzino su cui non si
   * sa nemmeno se ci fosse qualcosa — e vale come bloccante per lo stesso motivo,
   * anzi per uno peggiore. Vedi `liberaSpazio`.
   */
  letture_fallite: number
  /** `true` se anche un solo file non è uscito: il timestamp NON è stato scritto. */
  parziale: boolean
  /** Quando lo spazio è stato liberato, oppure `null` se l'esito è parziale. */
  spazio_liberato_il: string | null
}

const VUOTI: ContiSpazio = {
  foto_sole_sue: 0,
  video_soli_suoi: 0,
  media_di_gruppo: 0,
  media_non_rimovibili: 0,
  messaggi: 0,
  allegati: 0,
  thread: 0,
  articoli_pubblici: 0,
}

/** Una riga di `galleria_media_v2`: `RigaMedia` più il tipo, che serve solo a contare. */
interface MediaTaggato extends RigaMedia {
  file_type?: string | null
}

/** Gli id dei thread di chat del bambino. `chat_threads` è UNIQUE (teacher, parent, student). */
async function leggiThread(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{ ok: true; ids: string[] } | { ok: false; errore: unknown }> {
  const { data, error } = await supabase.from('chat_threads').select('id').eq('student_id', alunnoId)
  if (error) {
    // Schema assente = DB E2E della CI non migrato: si degrada a «nessun thread».
    // Su tutto il resto ci si ferma, perché «non l'ho potuto leggere» e «non ce
    // ne sono» qui portano a due gesti opposti: il secondo autorizza a cancellare.
    if (schemaAssente(error)) return { ok: true, ids: [] }
    logErrore({ operazione: op, evento: 'spazio_thread_non_letti' }, error)
    return { ok: false, errore: error }
  }
  return { ok: true, ids: ((data ?? []) as { id?: unknown }[]).map((t) => String(t.id ?? '')).filter((s) => s !== '') }
}

/**
 * IL DRY-RUN — sole `SELECT`, nessuna scrittura, nessuna `remove()`.
 *
 * È ciò che l'operatore legge prima di digitare il nominativo, quindi un
 * conteggio inventato è una conferma inventata: se una lettura fallisce non si
 * risponde «zero», ci si ferma. La stessa ragione per cui il dry-run dell'oblio
 * restituisce 500 quando non riesce a contare i genitori orfani.
 *
 * Le tabelle che il DB della CI non ha ancora (`news_posts`) degradano a zero e
 * basta: lì l'assenza è un fatto, non un guasto.
 *
 * ─── PERCHÉ RESTITUISCE ANCHE GLI ID DEI THREAD ─────────────────────────────
 *
 * Perché `liberaSpazio` chiama QUESTA funzione come prima cosa (vedi lì il
 * perché) e senza gli id dovrebbe rileggere `chat_threads` — cioè fare due volte
 * la stessa domanda e poter ricevere due risposte diverse. Il dry-run della rotta
 * li ignora e non li spedisce a nessuno: sono uuid di conversazioni, non un dato
 * che serva a chi conferma.
 */
export async function contaSpazio(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{ ok: true; conti: ContiSpazio; threadIds: string[] } | { ok: false; errore: unknown }> {
  const conti: ContiSpazio = { ...VUOTI }

  // `file_url` NON è di lusso: la sorte di un media dipende anche dall'indirizzo.
  // Se non è riconoscibile in questo archivio l'esecuzione non lo toglie, e
  // annunciarlo fra le distruzioni sarebbe una promessa vuota.
  const { data: media, error: errMedia } = await supabase
    .from('galleria_media_v2')
    .select('id, file_url, file_type, tag_students')
    .contains('tag_students', [alunnoId])
  if (errMedia && !schemaAssente(errMedia)) {
    logErrore({ operazione: op, evento: 'spazio_galleria_non_letta' }, errMedia)
    return { ok: false, errore: errMedia }
  }
  for (const riga of (media ?? []) as MediaTaggato[]) {
    // ⚠️ LA REGOLA È UNA SOLA, ed è `sorteDellaFoto` — la STESSA funzione che
    // esegue `obliaFotoAlunno`. Qui viveva una seconda copia (`soloSuo`), e le
    // due erano GIÀ divergenti: quella locale filtrava i tag con
    // `typeof t === 'string'`, `sorteDellaFoto` con `uuidDichiarati`, che fa
    // anche il `trim()`. Un tag di scarto (`'   '`) accanto al suo faceva dire
    // al dry-run «di gruppo, resta» e all'esecuzione «solo sua, la cancello»:
    // il numero che l'operatore conferma e ciò che accade non coincidevano.
    // La testata di questo file dice che una regola valida per due strade deve
    // vivere in un posto solo; la copia è stata tolta il 2026-08-13.
    const sorte = sorteDellaFoto(riga, alunnoId)
    if (sorte.sorte === 'sganciata') {
      conti.media_di_gruppo++
      continue
    }
    if (sorte.sorte === 'trattenuta') {
      conti.media_non_rimovibili++
      continue
    }
    if ((riga.file_type ?? '').trim().toLowerCase() === 'video') conti.video_soli_suoi++
    else conti.foto_sole_sue++
  }

  const thread = await leggiThread(supabase, alunnoId, op)
  if (!thread.ok) return { ok: false, errore: thread.errore }
  conti.thread = thread.ids.length

  if (thread.ids.length > 0) {
    const { data: messaggi, error: errMsg } = await supabase
      .from('chat_messages')
      .select('id, attachment_url')
      .in('thread_id', thread.ids)
    if (errMsg && !schemaAssente(errMsg)) {
      logErrore({ operazione: op, evento: 'spazio_messaggi_non_letti' }, errMsg)
      return { ok: false, errore: errMsg }
    }
    const righe = (messaggi ?? []) as { attachment_url?: string | null }[]
    conti.messaggi = righe.length
    conti.allegati = righe.filter((r) => (r.attachment_url ?? '').trim() !== '').length
  }

  const { data: posts, error: errPost } = await supabase
    .from('news_posts')
    .select('id')
    .contains('bambini_ritratti', [alunnoId])
  if (errPost) {
    // `news_posts` può mancare del tutto sul DB della CI: lì zero è la risposta
    // giusta. Altrove no — un articolo pubblico non contato è un'immagine che
    // l'operatore non sa di stare per togliere (o di stare per lasciare online).
    if (!schemaAssente(errPost)) {
      logErrore({ operazione: op, evento: 'spazio_news_non_lette' }, errPost)
      return { ok: false, errore: errPost }
    }
  } else {
    conti.articoli_pubblici = (posts ?? []).length
  }

  return { ok: true, conti, threadIds: thread.ids }
}

/**
 * L'ESECUZIONE — irreversibile, e per questo scritta in un ordine solo.
 *
 * ─── L'ORDINE, E PERCHÉ NON È INDIFFERENTE ─────────────────────────────────
 *
 *  1. si CONTA prima di ogni gesto (`contaSpazio`): senza i thread non si sa
 *     quali messaggi guardare e si finirebbe per cancellare a tentoni, e senza
 *     una lettura riuscita della galleria e del sito pubblico non si può
 *     nemmeno dire se ci fosse qualcosa da togliere;
 *  2. i media di galleria (foto **e** video, stesso bucket) e gli articoli del
 *     sito pubblico: file fuori, poi la riga — la regola vive in `esegui.ts`;
 *  3. gli allegati di chat: prima il file, poi il percorso in tabella;
 *  4. i messaggi, per INTERO e solo alla fine, perché la loro cancellazione è
 *     l'unico gesto che può rendere irrecuperabile un file rimasto dentro.
 *
 * ─── I THREAD NON SI CANCELLANO, E NON È UNA DIMENTICANZA ───────────────────
 *
 * `conversazioni_sospensioni.thread_id` è `ON DELETE CASCADE`: cancellare un
 * thread porterebbe via la prova che una conversazione è stata moderata, che la
 * policy UGC di Google Play pretende si conservi. Un thread vuoto è innocuo — il
 * bambino è già fuori da ogni elenco contatti — mentre una prova di moderazione
 * distrutta non torna. Si tocca il TESTO scritto dentro quei thread, e quello è
 * l'unico perimetro dichiarato: `chat_threads` è UNIQUE (teacher_id, parent_id,
 * student_id), quindi un thread appartiene a UN bambino solo e nessun'altra
 * famiglia viene sfiorata.
 *
 * ─── LA PRUDENZA STA SUL PERCORSO CHE DISTRUGGE ─────────────────────────────
 *
 * Fino al 2026-08-13 questa funzione era più fiduciosa del dry-run, che è
 * l'inverso di come dovrebbe stare il mondo. `contaSpazio`, davanti a una
 * galleria illeggibile, si ferma e la rotta risponde 500; qui `obliaFotoAlunno` e
 * `obliaFotoNewsAlunno` tornavano zeri sia quando non c'era niente da togliere
 * sia quando non erano riuscite a GUARDARE, e di loro si prendevano solo i
 * contatori. Esito misurato con una sonda: `42501 permission denied` su
 * `galleria_media_v2` → `parziale: false`, `spazio_liberato_il` scritto, log di
 * SUCCESSO a livello `info`, due righe di galleria e i loro file ancora al loro
 * posto, e il bambino col badge «spazio liberato» accanto al nome. Nessuno ci
 * sarebbe più tornato — che è letteralmente ciò che il commento sull'esito
 * parziale, qui sotto, promette di non fare.
 *
 * Il rimedio è in due tempi, perché i due guasti non stanno nello stesso punto:
 *
 *  · PRIMA di toccare qualunque cosa si esegue `contaSpazio`, cioè le stesse
 *    letture del dry-run. Se una non riesce si esce con `ok: false` e NIENTE è
 *    stato distrutto: è la garanzia più forte, e costa quattro `SELECT` su righe
 *    già indicizzate. Serve anche a un'altra cosa — i messaggi «prima» e gli id
 *    dei thread arrivano da lì, quindi la lettura non si fa due volte.
 *  · le funzioni che ESEGUONO dichiarano adesso se hanno potuto leggere
 *    (`letto`). È la rete per la finestra fra il conteggio e il gesto: un
 *    permesso che cade nel mezzo non può più travestirsi da «non c'era niente».
 *    Lì il lavoro è già cominciato, quindi non si mente in nessuna delle due
 *    direzioni: l'esito è PARZIALE, il timestamp non si scrive, la riga resta
 *    azionabile e il log lo dice a livello `error`.
 */
export async function liberaSpazio(
  supabase: SupabaseClient,
  alunnoId: string,
  op: string,
): Promise<{ ok: true; esito: EsitoSpazio } | { ok: false; errore: unknown }> {
  // ── LO STESSO SGUARDO DEL DRY-RUN, PRIMA DI QUALUNQUE GESTO ──
  // `contaSpazio` si ferma su ogni lettura che decide (galleria, thread,
  // messaggi, sito pubblico) e degrada solo sullo schema assente. Se non si passa
  // di qui non si distrugge niente: si riprova.
  const prima = await contaSpazio(supabase, alunnoId, op)
  if (!prima.ok) return { ok: false, errore: prima.errore }
  const thread = { ids: prima.threadIds }

  // Quanti messaggi ci sono PRIMA, per poter dire quanti ne restano dopo. È una
  // differenza misurata sullo stesso client dentro la stessa richiesta; resta
  // clampata a zero perché fra la lettura e la cancellazione una maestra può
  // scrivere ancora — raro su un bambino archiviato, ma un conteggio negativo
  // sarebbe una bugia più visibile del caso che lo genera.
  const messaggiPrima = prima.conti.messaggi

  // 1. GALLERIA — bucket `gallery`, foto e video insieme. Sole sue: prima il
  //    file, poi la riga. Di gruppo: si toglie il tag e il file resta, perché
  //    dentro c'è l'immagine di altri bambini e su quelli nessuno ha deciso nulla.
  const foto = await obliaFotoAlunno(supabase, alunnoId, op)

  // 2. IL SITO PUBBLICO — l'unico bucket servito senza login. Una foto che resta
  //    lì non è «spazio occupato»: è l'immagine di un bambino non più iscritto a
  //    un indirizzo che conosce chiunque.
  const news = await obliaFotoNewsAlunno(supabase, alunnoId, op)

  // 3. GLI ALLEGATI DI CHAT — prima il file, poi il puntatore in tabella.
  const allegati = await obliaAllegatiChat(supabase, thread.ids, op)

  // 4. I MESSAGGI, PER INTERO — testo compreso, ed è il punto di «libera spazio»:
  //    l'oblio lasciava in piedi il messaggio (una conversazione è di due
  //    persone), qui il bambino non frequenta più e la conversazione con la sua
  //    famiglia non ha più ragione di esistere.
  //
  //    ⚠️ IL FILTRO `.is('attachment_url', null)` È IL PRESIDIO, non un dettaglio
  //    di efficienza. Cancellare la riga di un messaggio il cui allegato è
  //    rimasto nel bucket produrrebbe «un file invisibile e non cancellato»,
  //    cioè il guasto peggiore secondo la testata di `esegui.ts`: nessuna riga lo
  //    nominerebbe più, e non ci sarebbe niente da cui ripartire per toglierlo.
  //    `obliaAllegatiChat` azzera il percorso ESATTAMENTE dei messaggi il cui
  //    file è uscito davvero: dopo di lei, «percorso nullo» significa «non c'è
  //    niente là fuori che questa riga stia trattenendo».
  //
  //    Perché non ci si fonda su `allegati.fermi`, che pure dice quali sono
  //    rimasti agganciati: quell'elenco è vuoto sia quando è uscito tutto sia
  //    quando la lettura interna è fallita — vuoto per ignoranza, non per
  //    successo. Lo stato in tabella regge in entrambi i casi. `fermi` resta la
  //    SPIEGAZIONE che finisce nei log, non la condizione che autorizza.
  let messaggiCancellati = 0
  if (thread.ids.length > 0) {
    const { data, error } = await supabase
      .from('chat_messages')
      .delete()
      .in('thread_id', thread.ids)
      .is('attachment_url', null)
      .select('id')
    if (error) {
      // PostgREST non lancia: senza questo controllo una cancellazione respinta
      // (RLS, vincolo, colonna assente) passerebbe per «nessun messaggio da
      // togliere», e il timestamp verrebbe scritto su un lavoro non fatto.
      if (!schemaAssente(error)) logErrore({ operazione: op, evento: 'spazio_messaggi_non_cancellati' }, error)
    } else {
      messaggiCancellati = (data ?? []).length
    }
  }
  const messaggiTrattenuti = Math.max(0, messaggiPrima - messaggiCancellati)

  // I BLOCCANTI, tutti insieme. `fileTrattenuti` di `news` sono i file rimasti
  // nel bucket PUBBLICO perché un altro articolo li nomina ancora: non è un
  // guasto di trasporto, ma il file c'è, quindi lo spazio non è stato liberato.
  const nFileNonRimossi =
    foto.fileNonRimossi + allegati.nonRimossi + news.fileNonRimossi + news.fileTrattenuti

  // ⚠️ E GLI ARCHIVI CHE NON SI SONO POTUTI GUARDARE. Un magazzino illeggibile è
  // PEGGIO di un file rimasto dentro: del file si sa che c'è, di questo non si sa
  // nemmeno quanto ce n'era. `0` è ciò che ritornano queste funzioni sia quando
  // non c'era niente sia quando non hanno potuto leggere, e prendere solo i
  // contatori — com'era fino al 2026-08-13 — significa scrivere «fatto» su un
  // lavoro mai cominciato.
  const lettureFallite = (foto.letto ? 0 : 1) + (news.letto ? 0 : 1)
  const parziale = nFileNonRimossi > 0 || messaggiTrattenuti > 0 || lettureFallite > 0

  const esito: EsitoSpazio = {
    foto_rimosse: foto.fotoRimosse,
    foto_sganciate: foto.fotoSganciate,
    // I file di galleria NON sono qui dentro: `obliaFotoAlunno` non restituisce
    // un conteggio di file, perché su quel bucket riga e file vanno via insieme e
    // il numero è `foto_rimosse`. Sommarli qui li conterebbe due volte.
    file_rimossi: allegati.rimossi + news.fileRimossi,
    n_file_non_rimossi: nFileNonRimossi,
    messaggi_cancellati: messaggiCancellati,
    messaggi_trattenuti: messaggiTrattenuti,
    articoli_ritirati: news.ritirati,
    letture_fallite: lettureFallite,
    parziale,
    spazio_liberato_il: null,
  }

  if (parziale) {
    // ESITO PARZIALE: il timestamp NON si scrive, e la riga resta azionabile —
    // si riprova. Scriverlo qui vorrebbe dire togliere dall'elenco «da liberare»
    // un bambino le cui foto sono ancora nell'archivio, e nessuno tornerebbe a
    // guardarle mai più. Riga PERSISTITA (`gdpr` è in `EVENTI_PERSISTITI`) con
    // soli conteggi e uuid.
    logEvento('gdpr', 'error', {
      operazione: op,
      esito: 'spazio-liberato-parziale',
      entita_tipo: 'alunni',
      entita_id: alunnoId,
      n_file: nFileNonRimossi,
      n_messaggi: messaggiTrattenuti,
      // Il PERCHÉ, distinto dal quanto: quanti messaggi sono rimasti agganciati
      // al loro allegato. Con questo numero si legge da fuori la differenza fra
      // «il file è ancora nel bucket» (qui > 0) e «la cancellazione è stata
      // respinta dal database» (qui 0, ma `n_messaggi` > 0) — due guasti con due
      // rimedi diversi, che senza questa riga si somigliano troppo.
      n_allegati_fermi: allegati.fermi.length,
      // Il terzo guasto, che non è né un file fermo né una cancellazione
      // respinta: un archivio che non si è potuto aprire. Senza questo numero
      // sarebbe indistinguibile da «non c'era niente là dentro», e chi legge la
      // riga a mesi di distanza deve poter dire quale dei tre è successo.
      n_archivi_non_letti: lettureFallite,
      msg: `${op}: ${nFileNonRimossi} file e ${messaggiTrattenuti} messaggi di un alunno archiviato NON sono usciti dall'archivio; ${lettureFallite} archivi non si sono potuti leggere`,
    })
    return { ok: true, esito }
  }

  const at = new Date().toISOString()
  const { error: errStamp } = await supabase
    .from('alunni')
    .update({ spazio_liberato_il: at })
    .eq('id', alunnoId)
  if (errStamp) {
    // Il lavoro è stato fatto, il segno no: la riga resterà nell'elenco «da
    // liberare» e una seconda esecuzione non troverà più niente da togliere.
    // È il verso giusto in cui sbagliare, ma non è muto.
    if (!schemaAssente(errStamp)) logErrore({ operazione: op, evento: 'spazio_timestamp_non_scritto' }, errStamp)
  } else {
    esito.spazio_liberato_il = at
  }

  // Evento critico → si logga anche il SUCCESSO: con i soli errori, «nessun log»
  // non distingue «tutto a posto» da «non è mai partito niente».
  logEvento('gdpr', 'info', {
    operazione: op,
    esito: 'spazio-liberato',
    entita_tipo: 'alunni',
    entita_id: alunnoId,
    n_file: esito.file_rimossi,
    n_foto: esito.foto_rimosse,
    n_messaggi: esito.messaggi_cancellati,
  })
  return { ok: true, esito }
}
