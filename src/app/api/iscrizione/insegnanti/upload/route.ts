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
  TETTO_UPLOAD_CANDIDATURE,
  estensioneArchiviata,
  rispostaTroppiCaricamenti,
  verificaAllegatoPubblico,
} from '@/lib/upload/allegati-pubblici'
import {
  BUCKET_CURRICULUM,
  costruisciPercorsoCv,
  percorsoCvAmmesso,
} from '@/lib/candidature/percorso-cv'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POST /api/iscrizione/insegnanti/upload — il curriculum di chi si candida ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * La chiama il modulo pubblico `/lavora-con-noi`: chi si propone allega il proprio
 * curriculum e lo manda da qui, senza login. La rotta risponde con il PERCORSO, che
 * il modulo mette poi in `cv_path` quando invia la candidatura a
 * `iscrizione/insegnanti:POST`.
 *
 * ── ⚠️ QUESTA ROTTA COLMA UN VUOTO DICHIARATO, NON NE APRE UNO NUOVO ────────
 *
 * Il campo `cv_path` esiste nel template dal 2026-08-10 e il suo gate pure. Ciò che
 * NON esisteva era la porta da cui un percorso legittimo potesse nascere: la
 * testata di `iscrizione/insegnanti:POST` lo scriveva a chiare lettere — «oggi
 * NESSUN valore legittimo di questo campo esiste, e questo gate lo rifiuta in
 * blocco … quando la rotta di caricamento nascerà, dovrà produrre questa forma».
 * Per undici giorni il modulo ha quindi avuto un curriculum FACOLTATIVO che non si
 * poteva allegare: il wizard teneva il campo in `IDS_NON_RESI` proprio per non far
 * caricare un file e poi respingerlo all'invio.
 *
 * Questo file è la metà mancante, e la prescrizione è stata mantenuta alla lettera:
 * la forma non è ricopiata, è IMPORTATA (`costruisciPercorsoCv` e
 * `percorsoCvAmmesso` vivono nello stesso modulo, `@/lib/candidature/percorso-cv`,
 * e un test verifica che ciò che la prima produce la seconda lo accetti). Con due
 * scritture della stessa forma, il giorno in cui una cambia si ottiene un
 * caricamento riuscito e un invio rifiutato — dopo che il modulo è stato compilato
 * per intero. È il difetto «bucket più stretto del gate» che questo repo ha già
 * pagato una volta, e per cui il template offriva `.doc`/`.docx` che lo Storage non
 * ammette.
 *
 * ── È LA COPIA STRUTTURALE DI `iscrizione/personale/upload:POST` ────────────
 *
 * Stesso ordine dei controlli — tetto per IP prima di leggere il corpo, taglia,
 * gate condiviso sui tipi, estensione derivata dal TIPO e non dal nome — con due
 * differenze e nessuna delle due è cosmetica.
 *
 * ── 1. IL BUCKET È `form_attachments`, e stavolta è la scelta giusta ────────
 *
 * La porta del personale ha un bucket suo (`documenti_personale`) perché là il
 * rischio era che il risolutore di percorso di un modulo firmasse l'oggetto
 * dell'altro, e i due moduli erano gemelli. Qui no: il prefisso `candidature/` non
 * è risolvibile da nessuna delle rotte che leggono `iscrizioni/…`, e viceversa. La
 * ragione per esteso — compreso il fatto che questo bucket custodisce 1389 oggetti
 * fra cui documenti di minori — sta nella testata di `@/lib/candidature/percorso-cv`.
 *
 * ── 2. IL TETTO È SEI, ED È IL PIÙ BASSO DELLE TRE PORTE ────────────────────
 *
 * Perché l'INVIO di una candidatura è già limitato a 3 all'ora per IP: sopra i sei
 * caricamenti in dieci minuti non c'è nessuna candidatura in più da raccogliere,
 * solo oggetti in più dentro il bucket dei minori. L'aritmetica sta accanto alla
 * costante, in `@/lib/upload/allegati-pubblici`, e non dentro questa rotta.
 *
 * ── ⚠️ L'ORFANO: QUESTA ROTTA PUÒ CREARLO, E CHI LO TOGLIE STA ALTROVE ──────
 *
 * Il curriculum si carica PRIMA che la candidatura esista: fra i due gesti c'è una
 * persona che può chiudere la pagina, e l'oggetto resterebbe nel bucket senza
 * nessuna riga che lo nomini — invisibile a `gdpr/retention-candidature:POST`, che
 * parte dalle righe. È lo stesso stato che il modulo del personale ha pagato
 * l'11/08/2026 e che là è chiuso da un registro (`caricamenti_personale`).
 *
 * Qui la soluzione è un'altra e più leggera, e va detto perché: il prefisso
 * `candidature/` contiene ESCLUSIVAMENTE oggetti prodotti da questa rotta (nessun
 * altro codice ci scrive), quindi «elencato sotto il prefisso e non nominato da
 * nessuna riga» è già una definizione esatta di orfano — non serve una tabella per
 * ricostruirla. La spazzata vive nel cron di conservazione che c'era già
 * (`gdpr/retention-candidature:POST`, sezione «gli orfani del prefisso»), gira ogni
 * notte e tocca solo gli oggetti più vecchi di una soglia dichiarata, così un
 * curriculum caricato dieci minuti fa da qualcuno che sta ancora compilando non
 * viene mai portato via da sotto le mani.
 *
 * ── PERCHÉ NON UN GATE DI SESSIONE ─────────────────────────────────────────
 *
 * Perché chi si candida un account non ce l'ha, e non deve averlo: nasce, semmai,
 * quando la Direzione approva. Il perimetro di una porta che deve restare aperta è
 * tetto per IP + lista dei tipi + limite di dimensione, e vive in
 * `@/lib/upload/allegati-pubblici` — non qui dentro, perché la stessa regola vale
 * per quattro strade e in questo repo una regola in quattro posti diverge alla
 * prima modifica.
 */

/**
 * Il file si valida come presenza/istanza; dimensione e contenuto restano controlli
 * manuali (non materia di zod).
 *
 * ⚠️ NIENTE `folder`, come sulla porta del personale e a differenza di
 * `iscrizione/upload`. Qui non c'è niente da scegliere: il percorso lo decide
 * interamente il server, e un parametro in più sarebbe solo un secondo posto da cui
 * un anonimo può influenzare dove finisce il file. Il client ne manda uno lo stesso
 * — `caricaFile` accoda `extra: { folder: modelId }` — e viene semplicemente
 * ignorato: `parseData` legge le sole chiavi che questo schema dichiara.
 */
const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'Nessun file ricevuto' }),
})

/**
 * Il nome della rotta in `app_log.operazione`, in un posto solo.
 *
 * ⚠️ Sotto, in `withRoute(…)`, lo stesso valore è scritto LETTERALE e non con questa
 * costante — non è una svista. Il lock `logging-coverage` legge il SORGENTE e
 * pretende una stringa letterale che combaci col percorso del file
 * (`src/app/api/iscrizione/insegnanti/upload/route.ts` →
 * `iscrizione/insegnanti/upload:POST`): con una costante non vedrebbe nessun
 * `withRoute` affatto.
 */
const OPERAZIONE = 'iscrizione/insegnanti/upload:POST'

export const POST = withRoute('iscrizione/insegnanti/upload:POST', async (request: NextRequest) => {
  // IL TETTO PRIMA DI TUTTO, anche prima di leggere il corpo: un allegato costa molto
  // più di un JSON, e la difesa che si paga dopo aver letto 4 MB non ha difeso niente.
  const rl = await rateLimit(`candidature-upload:${clientIp(request)}`, {
    limit: TETTO_UPLOAD_CANDIDATURE,
    windowMs: FINESTRA_UPLOAD_PUBBLICO_MS,
  })
  if (!rl.ok) {
    // `warn` e non `error`: è un uso sbagliato, non un guasto nostro. Ma la riga ci
    // vuole — senza, un abuso in corso su una porta anonima non lascerebbe traccia.
    logEvento('storage', 'warn', {
      operazione: OPERAZIONE,
      esito: 'tetto-ip-raggiunto',
      bucket: BUCKET_CURRICULUM,
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
    // leggibile.
    //
    // ⚠️ IL CODICE È `ALLEGATO_OLTRE_LIMITE_PIATTAFORMA`, non `ALLEGATO_TROPPO_GRANDE`:
    // la frase di quest'ultimo, in entrambi i cataloghi, dice «al massimo 10 MB» — cioè
    // il limite di un ALTRO bucket. Qui direbbe a chi si candida che ha ancora margine
    // mentre il caricamento è già stato respinto. Il numero vero viaggia nella prosa,
    // interpolato dalla costante condivisa.
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
    // entrare in un bucket che contiene i documenti d'iscrizione dei minori.
    //
    // ⚠️ QUI CADE IL `.docx`, ed è il rifiuto più frequente che questa porta servirà:
    // è il formato in cui la maggioranza dei curriculum viaggia, e `form_attachments`
    // ammette cinque tipi che non lo comprendono (misurato). Il 415 arriva SUBITO, col
    // suo codice traducibile, invece che all'invio dopo tutto il modulo compilato — che
    // è esattamente la ragione per cui il template ha smesso di offrire `.doc`/`.docx`
    // nel selettore il 2026-08-10.
    const gate = verificaAllegatoPubblico(file, {
      operazione: OPERAZIONE,
      bucket: BUCKET_CURRICULUM,
    })
    if (!gate.ok) return gate.risposta

    // L'estensione la decide il TIPO (già normalizzato dal gate), mai il nome del file:
    // qui il nome è «cv-<cognome>.pdf», e non deve sopravvivere alla richiesta. La
    // mappa sta in `@/lib/upload/allegati-pubblici` perché le altre porte scrivono allo
    // stesso modo: due mappe per la stessa regola sono due mappe che divergono.
    const estensione = estensioneArchiviata(gate.contentType)
    if (!estensione) {
      // FAIL-CLOSED, e non è un ramo teorico: è ciò che accadrebbe il giorno in cui il
      // gate condiviso ammettesse un tipo che quella mappa non conosce. Meglio un
      // rifiuto comprensibile che un oggetto archiviato con un'estensione inventata —
      // che poi `percorsoCvAmmesso` rifiuterebbe, lasciando un file caricato e un
      // modulo che non lo accetta.
      logEvento('storage', 'error', {
        operazione: OPERAZIONE,
        esito: 'estensione-non-derivabile',
        bucket: BUCKET_CURRICULUM,
        mime: gate.contentType,
      })
      return rispostaAllegatoNonCaricato()
    }

    // `candidature/<uuid>-cv.<estensione>`: un identificativo generato dal server e
    // nient'altro. Il nome scelto dal browser non entra, per la ragione scritta in
    // testa a `@/lib/candidature/percorso-cv`.
    const path = costruisciPercorsoCv(estensione)

    // ⚠️ SI VERIFICA CIÒ CHE SI È APPENA COSTRUITO, e non è un controllo ridondante:
    // è la sutura fra le due metà di questo lavoro. Se un domani la forma prodotta e
    // la forma accettata divergessero — sono nello stesso modulo proprio per rendere
    // difficile che accada, ma «difficile» non è «impossibile» — il difetto sarebbe
    // invisibile QUI e visibile a chi si candida: caricamento riuscito, e poi un
    // rifiuto sull'invio del modulo compilato per intero. Fallire adesso costa un
    // messaggio d'errore sul campo; fallire lì costa la candidatura.
    if (!percorsoCvAmmesso(path)) {
      logEvento('storage', 'error', {
        operazione: OPERAZIONE,
        esito: 'percorso-costruito-non-ammesso',
        bucket: BUCKET_CURRICULUM,
        mime: gate.contentType,
        msg:
          `${OPERAZIONE}: il percorso costruito non supera il gate di forma di ` +
          '@/lib/candidature/percorso-cv — costruttore e validatore sono divergenti, ' +
          'e nessun curriculum potrà più essere allegato finché non tornano a coincidere',
      })
      return rispostaAllegatoNonCaricato()
    }

    const supabase = await createAdminClient()
    const arrayBuffer = await file.arrayBuffer()
    const { error } = await supabase.storage.from(BUCKET_CURRICULUM).upload(path, arrayBuffer, {
      cacheControl: '3600',
      // Un percorso generato dal server non deve poterne sostituire un altro.
      upsert: false,
      // Il tipo NORMALIZZATO dal gate, mai `application/octet-stream`: il bucket
      // DICHIARA i suoi cinque tipi ammessi, quindi un file valido spedito come
      // `octet-stream` verrebbe respinto DOPO il caricamento, con un 500 opaco.
      contentType: gate.contentType,
    })

    if (error) {
      // Il corpo dell'errore del fornitore resta nel LOG e non torna al client
      // (AGENTS §3): porta fuori il nome del bucket, i vincoli e le policy — e qui il
      // destinatario sarebbe un anonimo. Al client un codice traducibile.
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'storage' }, error)
      return rispostaAllegatoNonCaricato()
    }

    // IL CARICAMENTO RIUSCITO LASCIA UNA RIGA (AGENTS §5). Con i soli errori, «nessun
    // log di upload» non distingue «nessuno allega il curriculum» da «gli allegati non
    // partono più» — ed è l'ambiguità che ha tenuto invisibile per mesi il guasto delle
    // email di credenziali. Su questa porta la distinzione conta il doppio: la funzione
    // è nata oggi, e senza questa riga non ci sarebbe modo di sapere se è mai partita.
    //
    // ⚠️ SOLO METADATI, e nemmeno il PERCORSO. Il nome del file non c'è più per
    // costruzione, ma il percorso è la chiave con cui si firma il curriculum di una
    // persona: `bucket`, `mime` e `byte` bastano a rispondere «gli allegati partono?»,
    // che è la domanda per cui questa riga esiste.
    logEvento('storage', 'info', {
      operazione: OPERAZIONE,
      esito: 'curriculum-caricato',
      bucket: BUCKET_CURRICULUM,
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
