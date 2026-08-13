import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseData, parseMultipart } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
import { rispostaAllegatoNonCaricato } from '@/lib/allegati/risposte'
import {
  FINESTRA_UPLOAD_PUBBLICO_MS,
  TETTO_UPLOAD_PERSONALE,
  estensioneArchiviata,
  rispostaTroppiCaricamenti,
  verificaAllegatoPubblico,
} from '@/lib/upload/allegati-pubblici'
import {
  BUCKET_DOCUMENTI_PERSONALE,
  registraCaricamento,
  spazzaCaricamentiSospesi,
} from '@/lib/personale/caricamenti'
import { DOC_PREFISSO } from '@/lib/personale/percorso-documento'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POST /api/iscrizione/personale/upload — la scansione del documento      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * La riceve il modulo pubblico `/anagrafica-personale`: una maestra in servizio
 * fotografa la propria carta d'identità e la manda da qui, senza login. La rotta
 * risponde con il PERCORSO, che il modulo mette poi in `documento_fronte_path` o in
 * `documento_retro_path` quando invia l'anagrafica a `iscrizione/personale:POST`.
 * ⚠️ Qui c'era scritto `documento_path`, al singolare: quel campo non esiste più dal
 * 12/08/2026 (migrazione `20260812194501`), e il documento si consegna a due facce —
 * cioè questa rotta viene chiamata DUE VOLTE per persona, che è anche l'aritmetica da
 * cui discende il suo tetto per IP.
 *
 * È la copia strutturale di `iscrizione/upload:POST` — tetto per IP, limite di
 * dimensione, gate condiviso sui tipi — con tre differenze, e nessuna delle tre è
 * cosmetica.
 *
 * ── 1. IL BUCKET È SEPARATO: `documenti_personale`, non `form_attachments` ──
 *
 * `form_attachments` custodisce gli allegati delle domande d'iscrizione, cioè carte
 * d'identità di genitori e fotografie di MINORI (~961 oggetti al 02/08/2026): due
 * popolazioni diverse, due basi giuridiche diverse, due termini di conservazione
 * diversi. Tenerli insieme significherebbe che il risolutore di percorso di un
 * modulo può, sbagliando, firmare l'oggetto dell'altro. Separati, quel fallimento è
 * impossibile per costruzione — un percorso `documenti/…` non si risolve MAI a una
 * riga di iscrizione, e viceversa. La ragione per esteso sta nella migrazione
 * `20260811205643_anagrafica_personale.sql`, che dichiara il bucket privato, a 4 MB
 * e con i cinque tipi di `MIME_ALLEGATO_PUBBLICO`.
 *
 * ── 2. IL NOME DEL FILE NON SOPRAVVIVE ALLA RICHIESTA ───────────────────────
 *
 * `iscrizione/upload:POST` costruisce `iscrizioni/<cartella>/<uuid>-<nome sanificato>`:
 * conserva il nome scelto dal browser. Su QUESTA porta quel nome è quasi sempre
 * `carta-identita-<cognome>.pdf`, cioè il cognome di una persona scritto dentro un
 * percorso che finirà in una colonna del database, in un URL firmato e — se qualcuno
 * si distrae — in un log. Perciò il percorso è `documenti/<uuid>/<uuid>.<estensione>`:
 * due identificativi generati dal server e nient'altro.
 *
 * L'estensione, in particolare, NON si legge da `file.name`: si deriva dal
 * `contentType` che il gate ha già normalizzato e verificato. È la stessa cosa nei
 * fatti — il gate pretende che estensione e tipo concordino — ma per costruzione, e
 * non per fiducia: da `file.name` non passa un solo byte.
 *
 * ── 3. L'OGGETTO NASCE INSIEME ALLA RIGA CHE LO NOMINA ──────────────────────
 *
 * La scansione si carica al TERZO passo del wizard e la pratica nasce al QUARTO:
 * fra i due c'è una persona che può chiudere la pagina. Fino all'11/08/2026 chi lo
 * faceva lasciava la fotografia della propria carta d'identità nel bucket a tempo
 * indeterminato — senza il nome del file (buttato via apposta) e senza nessuna riga
 * che dicesse di chi fosse, cioè nemmeno identificabile per cancellarla su
 * richiesta. E `gdpr/retention-personale:POST` non poteva vederla: parte da
 * `pratiche_personale` e `anagrafica_personale`, quindi guarda solo ciò che è GIÀ
 * referenziato. Non è il caso dell'abuso, è quello normale di chi si interrompe.
 *
 * Da qui il registro (`@/lib/personale/caricamenti`): l'oggetto e la riga che lo
 * nomina nascono insieme, e **se la riga non si scrive l'oggetto si ritira**. La
 * spazzata degli orfani vive nello stesso modulo e gira qui sotto, dopo ogni
 * caricamento riuscito.
 *
 * ── PERCHÉ NON UN GATE DI SESSIONE ──────────────────────────────────────────
 *
 * Perché chi compila non ha un account: l'account nasce, semmai, quando la Segreteria
 * approva la pratica. Il perimetro di una porta che deve restare aperta è quello di
 * `iscrizione/upload`: tetto per IP, lista dei tipi, limite di dimensione — e vive in
 * `@/lib/upload/allegati-pubblici`, non qui dentro, perché la stessa regola vale per
 * tre strade e in questo repo una regola in tre posti diverge alla prima modifica.
 */

/**
 * Il bucket, letto da `@/lib/personale/caricamenti` e non ribattuto: quel modulo lo
 * usa per la spazzata degli orfani, e due nomi per lo stesso archivio significano
 * una pulizia che gira su un bucket diverso da quello in cui si scrive.
 */
const BUCKET = BUCKET_DOCUMENTI_PERSONALE

/**
 * Il file si valida come presenza/istanza; dimensione e contenuto restano controlli
 * manuali (non materia di zod).
 *
 * ⚠️ NIENTE `folder`, a differenza della rotta gemella. Là il chiamante sceglie una
 * cartella e la route la sanifica; qui non c'è niente da scegliere: il percorso lo
 * decide interamente il server, e un parametro in più sarebbe solo un secondo posto
 * da cui un anonimo può influenzare dove finisce il file.
 */
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
})

/**
 * Il nome della rotta in `app_log.operazione`, in un posto solo.
 *
 * ⚠️ Sotto, in `withRoute(…)`, lo stesso valore è scritto LETTERALE e non con questa
 * costante — non è una svista. Il lock `logging-coverage` legge il SORGENTE e
 * pretende una stringa letterale che combaci col percorso del file: con una costante
 * non vedrebbe nessun `withRoute` affatto.
 */
const OPERAZIONE = 'iscrizione/personale/upload:POST'

export const POST = withRoute('iscrizione/personale/upload:POST', async (request: NextRequest) => {
  // IL TETTO PRIMA DI TUTTO, anche prima di leggere il corpo: un allegato costa molto
  // più di un JSON, e la difesa che si paga dopo aver letto 4 MB non ha difeso niente.
  // ⚠️ `TETTO_UPLOAD_PERSONALE` e NON `TETTO_UPLOAD_PUBBLICO`: questa porta ha un
  // fabbisogno suo (13 dipendenti × 2 facce dietro un solo NAT), e per un giorno —
  // il 12/08/2026 — quel fabbisogno è stato soddisfatto alzando il numero CONDIVISO,
  // cioè allentando anche le due porte delle famiglie. L'aritmetica sta accanto alla
  // costante.
  const rl = await rateLimit(`personale-upload:${clientIp(request)}`, {
    limit: TETTO_UPLOAD_PERSONALE,
    windowMs: FINESTRA_UPLOAD_PUBBLICO_MS,
  })
  if (!rl.ok) {
    // `warn` e non `error`: è un uso sbagliato, non un guasto nostro. Ma la riga ci
    // vuole — senza, un abuso in corso su una porta anonima non lascerebbe traccia.
    logEvento('storage', 'warn', {
      operazione: OPERAZIONE,
      esito: 'tetto-ip-raggiunto',
      bucket: BUCKET,
    })
    return rispostaTroppiCaricamenti(rl.retryAfterMs)
  }

  try {
    // Content-Type sbagliato = errore del CLIENT: 400, non 500. `request.formData()`
    // LANCIA quando il Content-Type non è multipart, e senza `parseMultipart`
    // l'eccezione finirebbe nel `catch` in fondo — che è tarato sui guasti del server
    // — restituendo a un ANONIMO il messaggio interno del runtime.
    const form = await parseMultipart(request)
    if ('response' in form) return form.response

    const parsed = parseData(postFormSchema, { file: form.data.get('file') })
    if ('response' in parsed) return parsed.response
    const { file } = parsed.data

    // Limite di dimensione: quello VERO, che è della piattaforma e non nostro. Sopra i
    // ~4,5 MB il corpo lo rifiuta Vercel (413 `FUNCTION_PAYLOAD_TOO_LARGE`, corpo di
    // testo) e questo handler non viene mai eseguito — 41 occorrenze in un giorno sul
    // modulo pubblico d'iscrizione, il 31/07/2026, prima che qualcuno lo misurasse.
    //
    // 413 e non 400: è lo stesso codice che darebbe la piattaforma — così il client ha
    // una sola cosa da riconoscere — e a differenza di quello ha un corpo JSON
    // leggibile. È anche lo stesso tetto che il bucket dichiara in migrazione
    // (`file_size_limit = 4194304`): un bucket che promette più di quanto la funzione
    // lascia arrivare è una promessa che nessuno può mantenere.
    //
    // ⚠️ IL CODICE È `ALLEGATO_OLTRE_LIMITE_PIATTAFORMA`, non `ALLEGATO_TROPPO_GRANDE`:
    // la frase di quest'ultimo, in entrambi i cataloghi, dice «al massimo 10 MB» — cioè
    // il limite di un ALTRO bucket. Su questa porta direbbe a una maestra che ha ancora
    // margine mentre il caricamento è già stato respinto. Il numero vero viaggia nella
    // prosa, interpolato dalla costante condivisa, e non è ribattuto in nessun catalogo.
    if (file.size > LIMITE_UPLOAD_BYTE) {
      return NextResponse.json(
        {
          error: `File troppo grande (max ${LIMITE_UPLOAD_MB} MB)`,
          codice: 'ALLEGATO_OLTRE_LIMITE_PIATTAFORMA',
        },
        { status: 413 },
      )
    }

    // IL TIPO DICHIARATO DAL CLIENT NON È UNA PROVA, e qui il client è chiunque. Il
    // gate sta PRIMA dello Storage: un eseguibile o un finto `.html` non devono nemmeno
    // entrare nel bucket. `.heic` è ammesso perché è ciò che produce un iPhone
    // fotografando una carta d'identità, cioè il modo in cui questo allegato arriverà
    // quasi sempre.
    const gate = verificaAllegatoPubblico(file, {
      operazione: OPERAZIONE,
      bucket: BUCKET,
    })
    if (!gate.ok) return gate.risposta

    // L'estensione la decide il TIPO (già normalizzato dal gate), mai il nome del file:
    // qui il nome è «carta-identita-<cognome>.pdf», e non deve sopravvivere alla
    // richiesta. La mappa sta in `@/lib/upload/allegati-pubblici` perché la rotta di
    // caricamento del pannello admin scrive nello STESSO bucket e deve archiviare allo
    // stesso modo: due mappe per un bucket solo sono due mappe che divergono.
    const estensione = estensioneArchiviata(gate.contentType)
    if (!estensione) {
      // FAIL-CLOSED, e non è un ramo teorico: è ciò che accadrebbe il giorno in cui il
      // gate condiviso ammettesse un tipo che questa mappa non conosce. Meglio un
      // rifiuto comprensibile che un oggetto archiviato con un'estensione inventata.
      logEvento('storage', 'error', {
        operazione: OPERAZIONE,
        esito: 'estensione-non-derivabile',
        bucket: BUCKET,
        mime: gate.contentType,
      })
      return rispostaAllegatoNonCaricato()
    }

    // DUE uuid e nessun frammento del nome originale. Il primo separa un caricamento
    // dall'altro (così due invii della stessa persona non si sovrascrivono nemmeno per
    // errore), il secondo è il nome dell'oggetto. `upsert: false`: un percorso
    // generato dal server non deve poterne sostituire un altro.
    //
    // ⚠️ IL PREFISSO SI IMPORTA, non si riscrive: `percorsoDocumentoAmmesso` respinge
    // qualunque percorso non cominci per `DOC_PREFISSO`, quindi il giorno in cui questa
    // riga cambiasse cartella il modulo pubblico rifiuterebbe i percorsi che ha appena
    // prodotto lui stesso. Con l'import quella divergenza non è esprimibile.
    const path = `${DOC_PREFISSO}${crypto.randomUUID()}/${crypto.randomUUID()}.${estensione}`

    const supabase = await createAdminClient()
    const arrayBuffer = await file.arrayBuffer()
    const { error } = await supabase.storage.from(BUCKET).upload(path, arrayBuffer, {
      cacheControl: '3600',
      upsert: false,
      // Il tipo NORMALIZZATO dal gate, mai `application/octet-stream`: il bucket
      // DICHIARA i suoi cinque tipi ammessi (migrazione `20260811205643`), quindi un
      // file valido spedito come `octet-stream` verrebbe respinto DOPO il caricamento,
      // con un 500 opaco.
      contentType: gate.contentType,
    })

    if (error) {
      // Il corpo dell'errore del fornitore resta nel LOG e non torna al client
      // (AGENTS §3): porta fuori il nome del bucket, i vincoli e le policy — e qui il
      // destinatario sarebbe un anonimo. Al client un codice traducibile.
      logErrore(
        { operazione: OPERAZIONE, stato: 500, evento: 'storage' },
        error,
      )
      return rispostaAllegatoNonCaricato()
    }

    // ── LA RIGA CHE NOMINA L'OGGETTO, SUBITO DOPO L'OGGETTO ─────────────────
    //
    // Da qui l'oggetto è sorvegliato: o una pratica lo reclama, o la spazzata lo
    // toglie. È l'unica differenza fra un documento d'identità conservato e uno
    // dimenticato — e, per chi lo chiedesse, fra una copia cancellabile e una che
    // nessuno sa nemmeno di avere.
    const registro = await registraCaricamento(supabase, path, OPERAZIONE)

    // ⚠️ SE LA RIGA NON SI SCRIVE, L'OGGETTO SI RITIRA. Un allegato senza registro è
    // esattamente l'orfano invisibile che questo giro esiste per impedire, e fra i
    // due mali la scelta non è dubbia: un caricamento fallito costa a una maestra un
    // secondo tentativo, un oggetto non registrato costa la fotografia del suo
    // documento conservata per sempre e da nessuno cancellabile.
    //
    // ── QUI C'ERA UN'ECCEZIONE, E LA SUA PREMESSA ERA FALSA (misurata) ──────
    //
    // La condizione era `!registro.registrato && !registro.degradato`: col registro
    // ASSENTE l'oggetto restava, e la ragione scritta era «su un database senza quella
    // tabella non c'è nemmeno questo bucket». Verificato in produzione il 12/08/2026
    // con una query su `pg_class` e `storage.buckets`: bucket `documenti_personale`
    // **presente**, tabella `caricamenti_personale` **assente**. Le due cose non
    // viaggiano insieme — il bucket nasce da `20260811205643`, che è applicata, e la
    // tabella da `20260811234334`, che non lo è ancora — e la finestra in cui
    // l'eccezione si apriva era esattamente l'unico stato in cui poteva scattare.
    //
    // La premessa giusta non ha bisogno di sapere che cosa c'è nel database: se
    // `storage.upload` è riuscito, l'oggetto ESISTE, e c'è sempre qualcosa da
    // ritirare. Il degrado resta DICHIARATO — `registraCaricamento` grida a livello
    // `error` e nomina la migrazione da applicare — ma non è più il permesso di
    // lasciare nell'archivio la carta d'identità di qualcuno: su un database senza il
    // registro questa porta si chiude rumorosamente invece di riempirsi in silenzio,
    // che è la scelta già scritta due paragrafi sopra.
    if (!registro.registrato) {
      // `remove()` non lancia sui percorsi che non esistono e `rimuoviEVerifica` non
      // serve qui: non si sta cancellando la riga di nessuno, si sta annullando un
      // caricamento appena fatto. L'esito si guarda comunque — PostgREST e la
      // Storage API non lanciano — perché un ritiro fallito è la riga che resta
      // scritta e che permette di andarlo a togliere a mano.
      const { error: erroreRitiro } = await supabase.storage.from(BUCKET).remove([path])
      logEvento(
        'storage',
        'error',
        {
          operazione: OPERAZIONE,
          esito: erroreRitiro ? 'documento-non-ritirato' : 'documento-ritirato',
          bucket: BUCKET,
          mime: gate.contentType,
          byte: file.size,
          msg: erroreRitiro
            ? `${OPERAZIONE}: registro non scritto E ritiro non riuscito: nel bucket resta un oggetto che nessuna riga nomina`
            : `${OPERAZIONE}: registro non scritto, oggetto ritirato dal bucket`,
        },
        erroreRitiro ?? undefined,
      )
      return rispostaAllegatoNonCaricato()
    }

    // ── LA SPAZZATA DEGLI ORFANI ────────────────────────────────────────────
    //
    // Gira QUI, e non è il posto ovvio: la casa naturale sarebbe un ramo del cron di
    // `gdpr/retention-personale:POST`, che è dove va messa (vedi il rapporto di
    // consegna). Sta qui perché nel frattempo deve girare da qualche parte, e questa
    // è l'UNICA porta che scrive in questo bucket: se non si carica niente non
    // nascono orfani nuovi, quindi il momento in cui c'è più bisogno di spazzare è
    // esattamente quello in cui qualcuno carica.
    //
    // Costa una `select` su un indice PARZIALE (`caricamenti_personale_sospesi_idx`,
    // solo le righe con `pratica_id` NULL) che nel caso normale torna vuota: una
    // andata e ritorno, dopo che il file è già stato scritto. È tetto-limitata a
    // `TETTO_SPAZZATA` oggetti per giro e **non lancia mai** — un guasto della
    // pulizia non può diventare un caricamento fallito per chi ha fatto tutto bene.
    await spazzaCaricamentiSospesi(supabase, OPERAZIONE)

    // IL CARICAMENTO RIUSCITO LASCIA UNA RIGA (AGENTS §5). Con i soli errori, «nessun
    // log di upload» non distingue «nessuna maestra ha allegato niente» da «gli
    // allegati non partono più» — ed è l'ambiguità che ha tenuto invisibile per mesi il
    // guasto delle email di credenziali.
    //
    // ⚠️ SOLO METADATI, e nemmeno il PERCORSO. Il nome del file non c'è più per
    // costruzione, ma il percorso è la chiave con cui si firma il documento d'identità
    // di una persona: `bucket`, `mime` e `byte` bastano a rispondere «gli allegati
    // partono?», che è la domanda per cui questa riga esiste.
    logEvento('storage', 'info', {
      operazione: OPERAZIONE,
      esito: 'documento-caricato',
      bucket: BUCKET,
      mime: gate.contentType,
      byte: file.size,
    })

    return NextResponse.json({ path })
  } catch (err) {
    // `withRoute` non vede le eccezioni CATTURATE: il log lo fa questo ramo, di suo. E
    // al client va un messaggio fisso — non `err.message`, che è il testo interno del
    // runtime verso un chiamante anonimo.
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return rispostaAllegatoNonCaricato()
  }
})
