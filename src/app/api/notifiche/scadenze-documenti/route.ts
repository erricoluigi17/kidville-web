import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { sendEmailDetailed } from '@/lib/email/send'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { segretoCronValido } from '@/lib/security/segreto-cron'
import { tabellaMancante } from '@/lib/db/tolleranza-schema'
import { dataCivile } from '@/i18n/config'
import {
  MAX_RISOLLECITI_EMAIL,
  SOGLIA_MAX,
  SOGLIA_SCADUTO,
  aggiungiGiorni,
  emailRisollecitoDovuta,
  giorniResidui,
  sogliaRaggiunta,
  vaAvvisato,
} from '@/lib/anagrafica/scadenze'
import { TIPI_DOCUMENTO } from '@/lib/forms/personale-template'

/**
 * POST /api/notifiche/scadenze-documenti — L'ALLARME DI SCADENZA DEI DOCUMENTI
 * D'IDENTITÀ DEL PERSONALE IN SERVIZIO.
 *
 * SERVICE-TO-SERVICE: header `x-cron-secret`, come tutti i lavori notturni. Lo
 * invoca pg_cron (migrazione `…_scadenze_documenti_cron.sql`).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * PERCHÉ UN JOB DEDICATO, E NON UNA QUARTA SCANSIONE DENTRO
 * `notifiche/promemoria`
 *
 * Quella route chiude con un battito UNICO per tutte e tre le sue scansioni: se
 * una cade, l'esito diventa `giro-incompleto` e il battito `ok` non viene
 * emesso — per TUTTE. È la scelta giusta lì dentro («il battito non può
 * mentire»), e diventa sbagliata nel momento in cui si aggiunge una quarta
 * scansione che riguarda un'altra popolazione: un guasto sui documenti del
 * PERSONALE spegnerebbe il battito dei promemoria alle FAMIGLIE, e
 * `/api/health` direbbe che i moduli non compilati non vengono più ricordati.
 * Un allarme che punta alla cosa sbagliata manda chi risponde a cercare nel
 * posto sbagliato, ed è un costo che si paga di notte.
 *
 * Da qui: job suo, battito suo, voce sua in `JOB_CRON` (`controlli.ts`), fessura
 * oraria sua.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * COSA NON ESCE DA QUI — e qui conta più del solito
 *
 * Questa tabella contiene codici fiscali, residenze, numeri di documento e il
 * percorso della scansione di una carta d'identità. Nei log escono **uuid,
 * conteggi, soglie, codici d'errore**: mai un nome, mai un'email, mai il numero
 * di un documento, mai un percorso di storage. Nel corpo delle email e delle
 * notifiche escono il tipo di documento e la data di scadenza — mai il numero,
 * mai il codice fiscale: un'email non è un canale riservato, e il numero del
 * documento non serve a chi lo possiede né a chi glielo deve chiedere.
 */

/** Il nome con cui questo lavoro si presenta in `app_log` e in `JOB_CRON`. */
const JOB = 'scadenze-documenti-personale'

/**
 * Nessun parametro in ingresso — schema VUOTO, e non è una formalità: il lock
 * `__tests__/api/zod-coverage.test.ts` riconosce i presidi per nome testuale nel
 * sorgente, e una route senza `parseQuery`/`parseBody` gli risulta non validata.
 */
const postQuerySchema = z.object({})

/**
 * IL TETTO DEL LOTTO. In produzione il personale con un'anagrafica è dell'ordine
 * delle decine, quindi questo tetto non taglierà mai — ed è esattamente il
 * motivo per cui va scritto adesso: una lettura senza `.limit()` non è «tutte le
 * righe», è «tutte finché qualcun altro non decide di tagliare», e il taglio di
 * PostgREST (`db-max-rows`) arriva muto. Con un tetto esplicito il taglio è
 * nostro e si legge nel battito (`lotto_pieno`).
 */
const TETTO_LOTTO = 500

/**
 * Chi, nella sede, deve vedere che un documento sta per scadere. Gli stessi tre
 * ruoli con cui il repo avvisa la segreteria ovunque (`iscrizione`,
 * `forms/submit`, `notifiche/promemoria`): non è un elenco nuovo.
 */
const RUOLI_SEGRETERIA = ['admin', 'coordinator', 'segreteria']

/**
 * LE SOGLIE CHE MERITANO ANCHE UN'EMAIL, e perché non tutte.
 *
 * La notifica in-app arriva SEMPRE (all'interessata e alla segreteria della sua
 * sede): è gratuita, resta nel centro notifiche e non disturba nessuno.
 * L'email costa attenzione, e l'attenzione si consuma: mandarne una a 90 giorni
 * — quando non c'è ancora niente da fare — è il modo più rapido di insegnare a
 * cestinare anche quella dei 7 giorni.
 *
 *  · a 60 e 30 giorni l'email va all'INTERESSATA: è lei che deve prenotare in
 *    Comune, e due mesi sono il preavviso realistico per un appuntamento;
 *  · a 7 giorni e a documento SCADUTO va anche alla SEGRETERIA: da lì in poi non
 *    è più un promemoria personale, è una non conformità del datore di lavoro —
 *    senza un documento valido gli adempimenti obbligatori (UNILAV, libro unico,
 *    denunce) non si possono eseguire.
 *
 * Una soglia aggiunta domani in `PERSONALE_LIMITI` non compare in questi due
 * insiemi, quindi nasce «solo in-app»: è il ripiego giusto — un canale in meno,
 * non un canale in più deciso da nessuno.
 */
const SOGLIE_EMAIL_INTERESSATA = new Set<number>([60, 30, 7, SOGLIA_SCADUTO])
const SOGLIE_EMAIL_SEGRETERIA = new Set<number>([7, SOGLIA_SCADUTO])

/**
 * L'INTERRUTTORE DEL PANNELLO IMPOSTAZIONI, PRIMA DI OGNI CANALE — e non solo
 * di quello che passa da `notificaEvento`.
 *
 * ⚠️ IL DIFETTO CHE QUESTA FUNZIONE CHIUDE (rilievo del revisore, 2026-08-12):
 * `notificaEvento` consulta `isNotificaAbilitata` per conto suo, quindi
 * spegnendo «documento_personale_in_scadenza» le notifiche in-app si fermavano —
 * mentre `sendEmailDetailed` veniva invocata FUORI da qualunque gate e le email
 * partivano lo stesso. Metà allarme si spegneva e metà no: l'unica leva che il
 * pannello offre non fermava il canale più rumoroso, cioè un avviso che non si
 * può zittire — e un avviso che non si può zittire si impara a ignorare.
 *
 * Il precedente del repo è esattamente questo, in due posti diversi:
 * `src/lib/mensa/notify.ts:90` e `src/lib/news/digest.ts:330` mettono il gate
 * PRIMA di ogni canale, email compresa.
 *
 * DUE CONSEGUENZE volute, e vanno dette perché sono scelte:
 *
 *  1. spento ⇒ NON si scrive `scadenza_soglia_avvisata`. È la stessa regola di
 *     `digest.ts` («non si marca `inviata_il`: se il toggle viene riacceso,
 *     l'edizione riparte»): marcare significherebbe bruciare la soglia mentre
 *     nessuno l'ha ricevuta, e alla riaccensione quella persona resterebbe senza
 *     il suo preavviso — con lo stato che dichiara di averglielo dato.
 *  2. una lettura per SEDE, non per persona. `isNotificaAbilitata` ha già una
 *     cache a TTL, ma la memoizzazione qui è dichiarativa: dice che la decisione
 *     è della sede, non della riga.
 *
 * `isNotificaAbilitata` è fail-open (config illeggibile ⇒ si avvisa) e risponde
 * `true` su sede assente: su un obbligo del datore di lavoro il verso giusto è
 * quello, e il suo `warn` lo dice.
 */
function gateDelTipo(supabase: Awaited<ReturnType<typeof createAdminClient>>) {
  const cache = new Map<string | null, boolean>()
  return async (sedeId: string | null): Promise<boolean> => {
    const gia = cache.get(sedeId)
    if (gia !== undefined) return gia
    const abilitata = await isNotificaAbilitata(supabase, 'documento_personale_in_scadenza', sedeId)
    cache.set(sedeId, abilitata)
    return abilitata
  }
}

/**
 * DOVE ATTERRA LA SEGRETERIA — e perché senza parametri.
 *
 * Questa funzione restituiva `/admin/staff?tab=scadenze&stato=scaduto`, cioè
 * «il pannello col filtro già applicato». MISURATO: quel pannello non esiste.
 * `src/app/(dashboard)/admin/staff/page.tsx` (27 righe) monta `StaffPanel` e non
 * legge nessun `searchParams`; `StaffPanel.tsx` (185 righe) non contiene né
 * `useSearchParams`, né una scheda `scadenze`, né un filtro `stato`. I due
 * parametri erano INERTI: chi cliccava atterrava sull'elenco del personale.
 *
 * ⚠️ E NON POTEVA ACCORGERSENE NESSUN TEST DI QUESTA ROUTE. Un parametro che la
 * destinazione ignora è verde per costruzione: la stringa parte, la stringa
 * arriva, l'asserzione confronta la stringa con sé stessa. È la differenza fra
 * «il link è quello che volevo scrivere» e «il link porta dove dice» — e la
 * seconda si prova solo guardando la PAGINA. Da qui il lock «il link della
 * segreteria PORTA da qualche parte» (`__tests__/api/scadenze-documenti-cron.test.ts`):
 * risolve il percorso su un `page.tsx` vero e, per ogni parametro di query,
 * pretende che la destinazione lo legga davvero (`.get('x')` o `searchParams.x`).
 *
 * `/admin/staff` NUDO invece che `link: null` (la scelta fatta per l'interessata,
 * che un pannello suo non ce l'ha): questa pagina esiste, il ruolo di chi riceve
 * l'avviso la può aprire, ed è l'anagrafica in cui quella persona sta. Il fatto —
 * chi, quale documento, quale data — è già nel corpo della notifica e dell'email:
 * la pagina serve per agire, non per sapere.
 *
 * Quando il pannello delle scadenze arriverà, il filtro si rimette QUI e il lock
 * lo lascerà passare da solo, perché a quel punto la pagina lo leggerà.
 */
function linkPannello(): string {
  return '/admin/staff'
}

/**
 * Lo stesso indirizzo, ASSOLUTO, per il corpo di un'email.
 *
 * `/admin/staff` dentro un'email non è un link: è un pezzo di testo che nessun
 * client sa aprire. Di ripieghi il repo ne ha DUE, e non sono equivalenti:
 *
 *  · il debole — `NEXT_PUBLIC_APP_URL` oppure il percorso nudo — in
 *    `email/send.ts` e `admin/regenerate-credentials`;
 *  · il forte — `NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin` — in
 *    `public/cancellazione-account/route.ts:87`.
 *
 * Qui si usa il forte, e la differenza si vede solo nel caso che conta: con la
 * variabile non configurata il debole manda un'email che contiene `/admin/staff`,
 * cioè un link che NESSUN destinatario può aprire, e lo fa in silenzio. Il forte
 * ricava l'origine dalla richiesta che è appena arrivata — che in questa route è
 * sempre presente, perché ci si arriva solo da una POST (pg_cron via `net.http_post`
 * sull'origine del Vault, o una staffer dal pannello): in entrambi i casi
 * `request.url` porta l'host vero da cui si sta servendo.
 *
 * Resta il `try`: `new URL` lancia su un `request.url` malformato, e un'email non
 * spedita per un URL storto sarebbe il logging che rompe il prodotto (AGENTS,
 * regola 9). In quel caso si torna al percorso nudo, che è brutto ma innocuo —
 * mai `undefined/admin/staff`.
 */
function linkAssoluto(request: Request): string {
  const base = process.env.NEXT_PUBLIC_APP_URL
  if (base) return `${base}${linkPannello()}`
  try {
    return `${new URL(request.url).origin}${linkPannello()}`
  } catch {
    return linkPannello()
  }
}

/** `2026-11-09` → `09/11/2026`. Solo stringhe: nessun `Date`, nessun fuso. */
function dataIT(ymd: string): string {
  return ymd.split('-').reverse().join('/')
}

/** L'etichetta italiana del tipo di documento (`CI`/`PP`/`DL`), dal template. */
function etichettaDocumento(tipo: string | null | undefined): string {
  return TIPI_DOCUMENTO.find((t) => t.value === tipo)?.label ?? 'documento d’identità'
}

interface RigaAnagrafica {
  utente_id: string
  document_expiry: string | null
  document_type: string | null
  scadenza_soglia_avvisata: number | null
  scadenza_avvisata_il: string | null
  /**
   * Quando l'anagrafica è nata. Serve SOLO al tetto dei risolleciti via email
   * (`inizioSerieScaduto`): la serie non può essere cominciata prima che la riga
   * esistesse, e senza questa colonna una dipendente storica inserita con la
   * carta d'identità già scaduta nasceva col contatore esaurito.
   */
  creata_il: string | null
}

interface Persona {
  id: string
  nome: string | null
  cognome: string | null
  email: string | null
  scuola_id: string | null
}

/** Il testo che legge l'interessata. Niente numero del documento, niente CF. */
function corpoInteressata(nome: string | null, tipo: string | null, scadenza: string, soglia: number): string {
  const saluto = nome ? `Gentile ${nome},` : 'Gentile collega,'
  const doc = etichettaDocumento(tipo).toLowerCase()
  const fatto =
    soglia === SOGLIA_SCADUTO
      ? `il ${doc} che hai depositato in Segreteria risulta SCADUTO dal ${dataIT(scadenza)}.`
      : `il ${doc} che hai depositato in Segreteria scade il ${dataIT(scadenza)}.`
  return [
    saluto,
    '',
    fatto,
    '',
    'Quando avrai il documento rinnovato, portalo o inviane una copia alla Segreteria: ' +
      'serve per gli adempimenti obbligatori legati al tuo rapporto di lavoro.',
    '',
    'Grazie,',
    'La Segreteria',
  ].join('\n')
}

/** Il testo che legge la segreteria: il nome serve, il numero del documento no. */
function corpoSegreteria(
  request: Request,
  persona: Persona,
  tipo: string | null,
  scadenza: string,
  soglia: number,
): string {
  const chi = [persona.nome, persona.cognome].filter(Boolean).join(' ') || 'una persona in servizio'
  const doc = etichettaDocumento(tipo).toLowerCase()
  return [
    soglia === SOGLIA_SCADUTO
      ? `Il ${doc} di ${chi} è SCADUTO dal ${dataIT(scadenza)}.`
      : `Il ${doc} di ${chi} scade il ${dataIT(scadenza)}.`,
    '',
    'Finché il documento non viene aggiornato la persona non è identificabile per gli ' +
      'adempimenti obbligatori del datore di lavoro.',
    '',
    `Anagrafica del personale: ${linkAssoluto(request)}`,
  ].join('\n')
}

export const POST = withRoute('notifiche/scadenze-documenti:POST', async (request: Request) => {
  const t0 = Date.now()

  // ── I CONTATORI DEL BATTITO ───────────────────────────────────────────────
  // Vivono QUI, fuori da ogni ramo che può fallire, e si scrivono nel `finally`.
  // Senza, «nessun log» non distingue «nessuna scadenza» da «il cron non parte
  // più» — e su un allarme la seconda è l'unica ipotesi che conta.
  let esitoBattito = 'ok'
  let nLette = 0
  let nDaAvvisare = 0
  let nAvvisate = 0
  let nScaduti = 0
  let nEmail = 0
  let nEmailFallite = 0
  let nSenzaUtente = 0
  let nSenzaEmail = 0
  /** Persone non avvisate perché la sede ha spento questo tipo di notifica. */
  let nDisattivate = 0
  /**
   * Documenti scaduti che la posta ha già sollecitato abbastanza volte: da qui in
   * poi resta la notifica in-app. NON «scaduti da tanto tempo» — la differenza fra
   * le due frasi è il difetto chiuso il 2026-08-12, vedi `emailRisollecitoDovuta`.
   * Senza questo numero nel battito, «la segreteria non riceve più niente su
   * quella persona» sarebbe indistinguibile da «il documento è stato rinnovato».
   */
  let nEmailOltreIlTetto = 0
  /**
   * QUANTE PERSONE IN SERVIZIO QUESTO ALLARME NON PUÒ COPRIRE.
   *
   * `null` = non misurato (tabella assente, lettura fallita, o giro morto prima):
   * `0` significherebbe «misurato zero», ed è una cosa diversa. `Valore` ammette
   * `null` e `redact` lo lascia passare così com'è.
   */
  let nSenzaScadenza: number | null = null
  let nStatoNonAggiornato = 0
  let lottoPieno = false
  /**
   * Conteggi PER SEDE — la granularità più fine che questo lavoro può scrivere.
   *
   * Una riga per PERSONA significherebbe tenere in `app_log` — 30 giorni,
   * interrogabile in SQL — l'elenco di chi ha il documento scaduto: un registro
   * delle non conformità del personale, costruito da un lavoro che nessuno ha
   * chiesto di costruire. Con tre sedi, «per sede» risponde comunque alla
   * domanda operativa vera («dove si è accumulato il problema?») senza nominare
   * nessuno.
   */
  const perSede = new Map<
    string | null,
    { avvisate: number; scaduti: number; email: number; disattivate: number }
  >()

  const contaSede = (sedeId: string | null, campo: 'avvisate' | 'scaduti' | 'email' | 'disattivate') => {
    const v = perSede.get(sedeId) ?? { avvisate: 0, scaduti: 0, email: 0, disattivate: 0 }
    v[campo] += 1
    perSede.set(sedeId, v)
  }

  try {
    const secret = request.headers.get('x-cron-secret')
    if (!segretoCronValido(secret)) {
      // Si grida SOLO se l'header c'è ed è sbagliato: quello è un cron che bussa
      // con la chiave sbagliata, cioè il guasto invisibile (smette di avvisare e
      // non lo dice a nessuno). Su un POST ANONIMO si tace: la route è pubblica e
      // senza rate-limit, e una riga `error` per ogni `curl` fabbricherebbe dal
      // nulla proprio il segnale «il cron è rotto» che serve a portare.
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      esitoBattito = 'non-autorizzato'
      // `{ ok, motivo }` e non `{ error: 'Non autorizzato' }`: questa route la
      // chiama pg_net, non un browser. Una prosa italiana qui non la legge
      // nessun utente — sarebbe solo una stringa in più da tradurre, e il lock
      // `errori-con-codice` la vedrebbe come un messaggio senza codice che un
      // utente inglese leggerebbe in italiano.
      return NextResponse.json({ ok: false, motivo: esitoBattito }, { status: 401 })
    }

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) {
      esitoBattito = 'richiesta-non-valida'
      return q.response
    }

    const supabase = await createAdminClient()
    const tipoAbilitato = gateDelTipo(supabase)
    const adessoISO = new Date().toISOString()
    // `dataCivile()` e NON `toISOString().slice(0, 10)`: `document_expiry` è una
    // colonna `date`, cioè un giorno del calendario italiano. Fra mezzanotte e le
    // due, con il processo in UTC su Vercel, le due forme danno due giorni diversi
    // — e questo giro parte proprio di notte.
    const oggi = dataCivile()
    const limite = aggiungiGiorni(oggi, SOGLIA_MAX)

    // ── 1. Le anagrafiche dentro la finestra del preavviso più lungo ────────
    // `lte(document_expiry, oggi + 90)` percorre l'indice parziale
    // `anagrafica_personale_scadenza_idx` (che vive su `document_expiry` where not
    // null), e include per costruzione tutto ciò che è già scaduto.
    const { data: righe, error: erroreLettura } = await supabase
      .from('anagrafica_personale')
      // `creata_il` è nel DDL fin dalla prima migrazione di questa tabella
      // (`20260811205643`, `timestamptz not null default now()`): non aggiunge
      // nessuna dipendenza da una migrazione da applicare. Sul database della CI,
      // dove la tabella intera non esiste, questa lettura degrada come le altre
      // (`PGRST205` ⇒ scansione saltata), non con un `42703` in più.
      .select(
        'utente_id, document_expiry, document_type, scadenza_soglia_avvisata, scadenza_avvisata_il, creata_il',
      )
      .lte('document_expiry', limite)
      // CHI NON LAVORA PIÙ QUI NON RICEVE PROMEMORIA. `cessato_il` valorizzato
      // significa rapporto chiuso: continuare a scrivere a quella persona (e alla
      // segreteria, su di lei) non serve a nessun adempimento e tratta il dato di
      // un'ex dipendente per una finalità che non esiste più.
      .is('cessato_il', null)
      // Le più scadute per prime: se il tetto taglia, taglia le meno urgenti.
      .order('document_expiry', { ascending: true })
      .limit(TETTO_LOTTO)

    if (erroreLettura) {
      if (tabellaMancante(erroreLettura)) {
        // Il DB E2E della CI non è migrato: la scansione non è CADUTA, non ha
        // GUARDATO. Resta 200 (non c'è niente da riparare stanotte) ma l'esito
        // NON è `ok`, che è la stringa con cui `/api/health` certifica una notte
        // andata bene: dichiararla qui coprirebbe una funzionalità assente.
        esitoBattito = 'ok-parziale'
        logEvento('cron', 'warn', {
          operazione: JOB,
          esito: esitoBattito,
          error_code: (erroreLettura as { code?: string }).code ?? '',
          msg: `${JOB}: la tabella anagrafica_personale non esiste su questo database, scansione saltata`,
        })
        return NextResponse.json({ ok: true, saltata: true, motivo: 'tabella-assente' })
      }
      // Qualunque altro codice — `42703` compreso — è uno schema a metà o un
      // guasto vero: non si finge di aver guardato. PostgREST NON lancia, quindi
      // senza questo ramo un errore di lettura diventerebbe «nessuna scadenza».
      esitoBattito = 'lettura-fallita'
      logEvento('cron', 'error', {
        operazione: JOB,
        esito: esitoBattito,
        error_code: (erroreLettura as { code?: string }).code ?? '',
        ms: Date.now() - t0,
        msg: `${JOB}: lettura delle anagrafiche in scadenza non riuscita`,
      })
      return NextResponse.json({ ok: false, motivo: esitoBattito }, { status: 500 })
    }

    const lette = (righe ?? []) as RigaAnagrafica[]
    nLette = lette.length
    lottoPieno = nLette >= TETTO_LOTTO

    if (lottoPieno) {
      // STESSO ARGOMENTO di `senza-data-di-scadenza` qui sotto, e per simmetria
      // stesso livello. Un lotto pieno significa che stanotte il giro NON ha
      // guardato tutti: le righe oltre la cinquecentesima non sono state lette,
      // e se una di quelle attraversava una soglia la persona non è stata
      // avvisata — senza che nulla sia «fallito». È un buco di copertura, non un
      // errore, ed è la ragione per cui non può vivere solo dentro la riga `info`
      // del battito: chi cerca i guasti interroga `warn`/`error`, e lì non lo
      // troverebbe. Il campo `lotto_pieno` resta anche nel battito, perché chi
      // legge il battito non deve dedurlo da un'altra riga.
      logEvento('cron', 'warn', {
        operazione: JOB,
        esito: 'lotto-pieno',
        n_lette: nLette,
        msg:
          `${JOB}: la lettura ha riempito il tetto di ${TETTO_LOTTO} righe: le anagrafiche ` +
          'oltre il tetto non sono state esaminate stanotte',
      })
    }

    // ── 1b. LA PARTE DI PERSONALE CHE QUESTO ALLARME NON PUÒ COPRIRE ────────
    //
    // Una riga con `document_expiry IS NULL` non è nel lotto qui sopra e non ci
    // sarà mai: `lte(document_expiry, …)` confronta con NULL, e un confronto con
    // NULL non è mai vero. Fin qui è corretto — senza data non c'è niente da
    // contare alla rovescia. Il difetto è un altro, ed è il guasto che questo
    // job deve temere più di ogni altro: quella persona non riceve nessun
    // avviso, non compare in nessun conteggio, e il battito continua a scrivere
    // `esito: 'ok'`. Cioè «nessuna email» diventa indistinguibile da «nessuna
    // scadenza», che è esattamente la firma che il `finally` esiste per togliere.
    //
    // E l'ordine di grandezza rende il buco grande: su una ventina di persone in
    // servizio bastano TRE righe senza data perché l'allarme copra l'85 % del
    // personale mentre si dichiara intero. Il numero non è deducibile dagli
    // altri — `n_lette` conta chi è nella finestra, non chi è in servizio.
    //
    // ⚠️ LA COLONNA È NULLABLE NEL DDL ma OBBLIGATORIA nel modulo pubblico
    // (`personale-template.ts`): la discrepanza si chiude solo se ogni percorso
    // di scrittura la valorizza, e i percorsi sono tre. Finché è aperta, l'unica
    // difesa possibile è MISURARLA — un conteggio non ripara niente, ma toglie
    // al guasto la sua unica arma, che è di non lasciare traccia.
    //
    // `head: true`: nessuna riga trasferita, solo il numero — e nessun dato
    // personale che attraversa questo processo per essere buttato via subito.
    const { count: conteggioSenzaScadenza, error: erroreSenzaScadenza } = await supabase
      .from('anagrafica_personale')
      .select('utente_id', { count: 'exact', head: true })
      .is('document_expiry', null)
      .is('cessato_il', null)
    if (erroreSenzaScadenza) {
      // NON è fatale: il giro può fare il suo lavoro su chi la data ce l'ha.
      // Ma `nSenzaScadenza` resta `null` — «non misurato» — invece di 0, perché
      // uno zero inventato qui sarebbe la stessa bugia che questo blocco esiste
      // per impedire, scritta dal codice che doveva smascherarla.
      logEvento('cron', 'warn', {
        operazione: JOB,
        esito: 'copertura-non-misurata',
        error_code: (erroreSenzaScadenza as { code?: string }).code ?? '',
        msg: `${JOB}: conteggio delle anagrafiche senza data di scadenza non riuscito`,
      })
    } else {
      nSenzaScadenza = conteggioSenzaScadenza ?? 0
      if (nSenzaScadenza > 0) {
        // Il battito è `info`, e chi cerca i guasti interroga `warn`/`error`: un
        // buco di copertura che vivesse solo dentro una riga `info` non lo
        // troverebbe nessuno. Una riga al giorno, non una per persona — `app_log`
        // deduplica per `(fingerprint, giorno)` e qui non serve `distingui`,
        // perché la domanda («quante persone restano scoperte?») è una sola per
        // tutte le sedi e la risposta sta nel numero.
        logEvento('cron', 'warn', {
          operazione: JOB,
          esito: 'senza-data-di-scadenza',
          n_senza_scadenza: nSenzaScadenza,
          msg:
            `${JOB}: ${nSenzaScadenza} anagrafiche in servizio non hanno la data di scadenza del ` +
            'documento: per quelle persone questo allarme non può suonare',
        })
      }
    }

    // ── 2. Chi va avvisato stanotte, e a quale soglia ───────────────────────
    const daAvvisare: { riga: RigaAnagrafica; soglia: number; scadenza: string }[] = []
    for (const riga of lette) {
      const scadenza = riga.document_expiry
      if (!scadenza) continue
      const soglia = sogliaRaggiunta(giorniResidui(scadenza, oggi))
      if (soglia === null) continue
      if (!vaAvvisato(soglia, riga.scadenza_soglia_avvisata, riga.scadenza_avvisata_il, adessoISO)) continue
      daAvvisare.push({ riga, soglia, scadenza })
    }
    nDaAvvisare = daAvvisare.length
    if (nDaAvvisare === 0) {
      return NextResponse.json({ ok: true, lette: nLette, avvisate: 0, senza_scadenza: nSenzaScadenza })
    }

    // ── 3. Le persone, IN BLOCCO ────────────────────────────────────────────
    // Una lettura sola per tutto il lotto: una per riga sarebbe N+1 su una
    // tabella che ogni gate di ruolo interroga a ogni richiesta.
    const { data: utenti, error: erroreUtenti } = await supabase
      .from('utenti')
      .select('id, nome, cognome, email, scuola_id')
      .in('id', daAvvisare.map((d) => d.riga.utente_id))
    if (erroreUtenti) {
      // Senza le persone non si sa né a chi scrivere né in quale sede: il giro
      // non può fare il suo lavoro, e dichiararlo riuscito sarebbe la bugia
      // peggiore possibile su un allarme.
      esitoBattito = 'utenti-non-letti'
      logEvento('cron', 'error', {
        operazione: JOB,
        esito: esitoBattito,
        error_code: (erroreUtenti as { code?: string }).code ?? '',
        n_da_avvisare: nDaAvvisare,
        ms: Date.now() - t0,
        msg: `${JOB}: lettura di utenti non riuscita, nessun avviso inviato`,
      })
      return NextResponse.json({ ok: false, motivo: esitoBattito }, { status: 500 })
    }
    const persone = new Map<string, Persona>()
    for (const u of (utenti ?? []) as Persona[]) persone.set(u.id, u)

    // ── 4. La segreteria di ogni sede coinvolta, una volta sola ─────────────
    const sedi = new Set<string>()
    for (const d of daAvvisare) {
      const sede = persone.get(d.riga.utente_id)?.scuola_id
      if (sede) sedi.add(sede)
    }
    const segreteriaDiSede = new Map<string, string[]>()
    for (const sede of sedi) {
      segreteriaDiSede.set(sede, await staffScuola(supabase, sede, RUOLI_SEGRETERIA))
    }
    // Le email della segreteria: un'altra lettura in blocco, non una per sede.
    const emailSegreteria = new Map<string, string>()
    const idsSegreteria = [...new Set([...segreteriaDiSede.values()].flat())]
    if (idsSegreteria.length > 0) {
      const { data: staff, error: erroreStaff } = await supabase
        .from('utenti')
        .select('id, email')
        .in('id', idsSegreteria)
      if (erroreStaff) {
        // NON è fatale: le notifiche in-app partono lo stesso, e sono il canale
        // che la segreteria vede comunque. Ma va detto, perché a 7 giorni e a
        // documento scaduto l'email alla segreteria è prevista — e la sua assenza
        // sarebbe altrimenti indistinguibile da «non c'era niente da mandare».
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'email-segreteria-non-risolte',
          error_code: (erroreStaff as { code?: string }).code ?? '',
          n_destinatari: idsSegreteria.length,
          msg: `${JOB}: lettura delle email della segreteria non riuscita, restano le notifiche in-app`,
        })
      }
      for (const s of (staff ?? []) as { id: string; email: string | null }[]) {
        if (s.email) emailSegreteria.set(s.id, s.email)
      }
    }

    // ── 5. Avvisi, uno per persona ──────────────────────────────────────────
    /** Chi è stato annunciato, raggruppato per soglia: l'UPDATE è per gruppo. */
    const annunciate = new Map<number, string[]>()
    /** Le sedi che hanno già detto la loro riga «tipo spento»: una, non una per persona. */
    const spenteAnnotate = new Set<string | null>()

    for (const { riga, soglia, scadenza } of daAvvisare) {
      const persona = persone.get(riga.utente_id)
      if (!persona) {
        // La chiave esterna è `on delete cascade`, quindi questa riga non
        // dovrebbe esistere: se esiste, è uno stato che nessun percorso
        // applicativo produce e va visto. Solo l'uuid — nient'altro.
        nSenzaUtente += 1
        logEvento('cron', 'warn', {
          operazione: JOB,
          esito: 'utente-assente',
          utente_id: riga.utente_id,
          msg: `${JOB}: anagrafica senza il suo utente, avviso non inviabile`,
        })
        continue
      }
      const sede = persona.scuola_id

      // L'INTERRUTTORE, PRIMA DI OGNI CANALE — vedi `gateDelTipo`. Sta qui, e non
      // più in basso attorno alla sola email, perché «spento» deve valere per
      // l'avviso INTERO: notifica in-app, email all'interessata, email alla
      // segreteria. E si esce PRIMA di `annunciate`, così la soglia non viene
      // bruciata e alla riaccensione l'avviso riparte.
      if (!(await tipoAbilitato(sede))) {
        nDisattivate += 1
        contaSede(sede, 'disattivate')
        if (!spenteAnnotate.has(sede)) {
          spenteAnnotate.add(sede)
          // `info` come in `news/digest.ts`: è una scelta umana registrata nel
          // pannello, non un guasto. Ma va registrata, perché senza questa riga
          // «zero avvisi» in una sede con documenti scaduti si legge come «niente
          // da segnalare» — e il conteggio da solo non dice DOVE.
          logEvento(
            'cron',
            'info',
            {
              operazione: JOB,
              esito: 'tipo-disattivato',
              sede_id: sede,
              msg: `${JOB}: la sede ha spento «documento_personale_in_scadenza», nessun avviso su questo giro`,
            },
            undefined,
            { distingui: ['sede_id'] },
          )
        }
        continue
      }

      if (soglia === SOGLIA_SCADUTO) {
        nScaduti += 1
        contaSede(sede, 'scaduti')
      }
      const destinatariStaff = sede ? (segreteriaDiSede.get(sede) ?? []) : []

      // 5a. In-app all'INTERESSATA. Senza link: la schermata da cui una docente
      // aggiorna il proprio documento non esiste ancora, e un collegamento a
      // `/admin/staff` — che il suo ruolo non può aprire — la manderebbe su un
      // 403. Meglio nessun link di un link che non si apre.
      await notificaEvento(supabase, {
        tipo: 'documento_personale_in_scadenza',
        scuolaId: sede,
        utenteIds: [persona.id],
        titolo:
          soglia === SOGLIA_SCADUTO
            ? 'Il tuo documento d’identità è scaduto'
            : 'Il tuo documento d’identità sta per scadere',
        corpo:
          soglia === SOGLIA_SCADUTO
            ? `Risulta scaduto dal ${dataIT(scadenza)}. Porta in Segreteria una copia del documento rinnovato.`
            : `Scade il ${dataIT(scadenza)}. Quando lo rinnovi, porta una copia in Segreteria.`,
        link: null,
        entitaTipo: 'anagrafica_personale',
        entitaId: persona.id,
        bufferMin: 0,
      })

      // 5b. In-app alla SEGRETERIA della sede.
      if (destinatariStaff.length > 0) {
        await notificaEvento(supabase, {
          tipo: 'documento_personale_in_scadenza',
          scuolaId: sede,
          utenteIds: destinatariStaff,
          titolo:
            soglia === SOGLIA_SCADUTO
              ? 'Documento del personale scaduto'
              : 'Documento del personale in scadenza',
          corpo: corpoSegreteria(request, persona, riga.document_type, scadenza, soglia).split('\n')[0],
          link: linkPannello(),
          entitaTipo: 'anagrafica_personale',
          entitaId: persona.id,
          bufferMin: 0,
        })
      }
      contaSede(sede, 'avvisate')
      nAvvisate += 1

      // 5c. Le email previste per questa soglia — se la posta ha ancora senso.
      //
      // Il risollecito del documento SCADUTO non ha un termine (`vaAvvisato` +
      // `giorniRisollecitoScaduto`): senza questo tetto, una persona che per mesi
      // non riesce a rinnovare — o un rapporto chiuso senza `cessato_il` — produce
      // un'email a settimana a lei e a OGNI membro della segreteria, per sempre.
      // Vedi `MAX_RISOLLECITI_EMAIL`: dopo ~due mesi resta la notifica in-app, che
      // è dove una non conformità aperta deve restare visibile senza occupare le
      // caselle di posta.
      //
      // ⚠️ SI PASSA LO STATO DELLA RIGA, non i giorni di scadenza (rilievo del
      // revisore, 2026-08-12): il tetto conta i SOLLECITI MANDATI, e il primo
      // annuncio non è un sollecito. Con `scadenza_soglia_avvisata` diversa da 0 la
      // posta parte comunque, qualunque cosa dica il calendario — è il caso della
      // dipendente storica inserita con la carta d'identità già scaduta da mesi,
      // dove il conto derivato dalla sola `document_expiry` nasceva esaurito e
      // sopprimeva la PRIMA email, non l'ennesima.
      //
      // UN FLAG SOLO PER I DUE CANALI DI POSTA, ed è voluto: il tetto è una scelta
      // sul MEZZO («la casella non è più il posto giusto per questo avviso»), non
      // sul destinatario. Interessata e segreteria ricevono la stessa notizia sullo
      // stesso fatto; farle divergere significherebbe che una delle due smette di
      // sapere quello che sa l'altra, senza che nessuno l'abbia deciso.
      const emailDovuta = emailRisollecitoDovuta({
        soglia,
        ultimaSoglia: riga.scadenza_soglia_avvisata,
        scadenzaYMD: scadenza,
        creataISO: riga.creata_il,
        oggiYMD: oggi,
      })
      if (!emailDovuta) nEmailOltreIlTetto += 1
      const invii: { a: string; oggetto: string; testo: string; chi: 'interessata' | 'segreteria' }[] = []
      if (emailDovuta && SOGLIE_EMAIL_INTERESSATA.has(soglia)) {
        if (persona.email) {
          invii.push({
            a: persona.email,
            oggetto:
              soglia === SOGLIA_SCADUTO
                ? 'Il tuo documento d’identità risulta scaduto'
                : `Il tuo documento d’identità scade il ${dataIT(scadenza)}`,
            testo: corpoInteressata(persona.nome, riga.document_type, scadenza, soglia),
            chi: 'interessata',
          })
        } else {
          // Un account senza email è un canale in meno che nessuno vedrebbe: la
          // notifica in-app è già partita, ma l'email prevista da questa soglia
          // non partirà mai e la riga lo dice. Solo l'uuid.
          nSenzaEmail += 1
          logEvento('cron', 'warn', {
            operazione: JOB,
            esito: 'senza-email',
            utente_id: persona.id,
            msg: `${JOB}: nessun indirizzo per l'interessata, resta la sola notifica in-app`,
          })
        }
      }
      if (emailDovuta && SOGLIE_EMAIL_SEGRETERIA.has(soglia)) {
        for (const id of destinatariStaff) {
          const indirizzo = emailSegreteria.get(id)
          if (!indirizzo) continue
          invii.push({
            a: indirizzo,
            oggetto:
              soglia === SOGLIA_SCADUTO
                ? 'Personale: documento d’identità scaduto'
                : 'Personale: documento d’identità in scadenza',
            testo: corpoSegreteria(request, persona, riga.document_type, scadenza, soglia),
            chi: 'segreteria',
          })
        }
      }

      for (const invio of invii) {
        const esito = await sendEmailDetailed({ to: invio.a, subject: invio.oggetto, text: invio.testo })
        if (esito.ok) {
          nEmail += 1
          contaSede(sede, 'email')
          continue
        }
        nEmailFallite += 1
        // IL CORPO DEL RIFIUTO NON SI BUTTA VIA (AGENTS, regola 3): `esito.error`
        // porta lo status E il messaggio del provider — «403» non dice niente,
        // «403 the domain is not verified» dice tutto. `msg` finisce in chiaro
        // nella colonna `app_log.messaggio`, che è sanificata; l'indirizzo non
        // c'è, e non deve esserci.
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'email-non-inviata',
          canale: invio.chi,
          utente_id: persona.id,
          sede_id: sede,
          msg: `${JOB}: email di scadenza rifiutata dal provider — ${esito.error ?? 'motivo non riportato'}`,
        })
      }

      annunciate.set(soglia, [...(annunciate.get(soglia) ?? []), persona.id])
    }

    if (nEmailOltreIlTetto > 0) {
      // UNA riga per giro, non una per persona: `app_log` deduplica per
      // (fingerprint, giorno) e qui non serve `distingui` — la domanda («su
      // quante persone la posta ha smesso?») ha una risposta sola, e il DOVE
      // starebbe in un uuid che su questa tabella non si scrive.
      //
      // `warn` e non `info`: chi cerca i buchi di copertura interroga
      // `warn`/`error`, e questo è un buco voluto ma pur sempre un buco — la
      // segreteria non riceve più posta su documenti che restano scaduti.
      logEvento('cron', 'warn', {
        operazione: JOB,
        esito: 'email-oltre-il-tetto',
        n_email_oltre_tetto: nEmailOltreIlTetto,
        n_risolleciti_max: MAX_RISOLLECITI_EMAIL,
        // IL TESTO DICEVA IL FALSO, ed è la metà del rilievo che si chiude qui:
        // «resta la sola notifica in-app, l'email non riparte» descrive un allarme
        // CONSUMATO, e lo scriveva anche nel caso in cui l'email non era mai
        // partita — un'anagrafica appena creata con un documento scaduto da mesi.
        // Ora questo ramo si raggiunge solo dopo che lo scaduto è stato annunciato
        // almeno una volta (`emailRisollecitoDovuta`, ramo 2), quindi «già mandate»
        // è un fatto e non una supposizione: si può scriverlo.
        msg:
          `${JOB}: su ${nEmailOltreIlTetto} documenti scaduti la posta ha già fatto i suoi ` +
          `${MAX_RISOLLECITI_EMAIL} solleciti: da qui in poi resta la sola notifica in-app`,
      })
    }

    // ── 6. Lo stato del promemoria, DOPO l'invio ───────────────────────────
    //
    // Un UPDATE per soglia, non uno per persona: al massimo cinque scritture.
    //
    // ⚠️ NON si tocca `document_expiry` e non si replica l'azzeramento: quello lo
    // fa il trigger `anagrafica_personale_tocca_trg` quando la scadenza cambia, e
    // vive lì apposta perché i punti che scrivono quella colonna sono tre.
    //
    // ⚠️ SI SEGNA ANCHE SE UN'EMAIL È STATA RIFIUTATA, ed è una scelta, non una
    // dimenticanza. Il fatto che queste due colonne registrano è «questa soglia è
    // stata annunciata», e l'annuncio — la notifica in-app — è partito. Non
    // segnare significherebbe rimandare l'avviso OGNI NOTTE finché quella casella
    // non torna a funzionare: la segreteria e l'interessata riceverebbero la
    // stessa notifica per settimane, cioè esattamente «l'allarme quotidiano che
    // si impara a ignorare» che la migrazione di queste colonne dice di voler
    // evitare. L'email rifiutata ha già il suo allarme, ed è di livello `error`:
    // la riga qui sopra, più quella che `externalFetch` scrive col corpo del
    // provider, più il conteggio `n_email_fallite` nel battito.
    for (const [soglia, ids] of annunciate) {
      const { error: erroreUpdate } = await supabase
        .from('anagrafica_personale')
        .update({ scadenza_soglia_avvisata: soglia, scadenza_avvisata_il: adessoISO })
        .in('utente_id', ids)
      if (!erroreUpdate) continue
      // PostgREST NON lancia: senza questo controllo l'avviso ripartirebbe ogni
      // notte e il giro si dichiarerebbe riuscito.
      nStatoNonAggiornato += ids.length
      logEvento('cron', 'error', {
        operazione: JOB,
        esito: 'stato-non-aggiornato',
        error_code: (erroreUpdate as { code?: string }).code ?? '',
        n_destinatari: ids.length,
        msg: `${JOB}: avvisi inviati ma stato del promemoria non aggiornato: il prossimo giro li rimanderà`,
      })
    }
    if (nStatoNonAggiornato > 0) {
      esitoBattito = 'stato-non-aggiornato'
      return NextResponse.json(
        { ok: false, motivo: esitoBattito, avvisate: nAvvisate, non_aggiornate: nStatoNonAggiornato },
        { status: 500 },
      )
    }

    return NextResponse.json({
      ok: true,
      lette: nLette,
      avvisate: nAvvisate,
      scadute: nScaduti,
      email: nEmail,
      email_fallite: nEmailFallite,
      disattivate: nDisattivate,
      email_oltre_tetto: nEmailOltreIlTetto,
      senza_scadenza: nSenzaScadenza,
      lotto_pieno: lottoPieno,
    })
  } catch (err) {
    // IL GIRO CHE MUORE PRIMA DI COMINCIARE. `createAdminClient()` costruisce il
    // client con `SUPABASE_SERVICE_ROLE_KEY!`, e quel `!` è una promessa al
    // type-checker, non al runtime: con la chiave assente o ruotata male lancia, e
    // da lì non gira più niente. Senza questo `catch` l'eccezione risalirebbe a
    // Next e finirebbe in `app_log` con `evento: 'unhandled'` — cioè fuori da
    // `where evento = 'cron'`, che è la query con cui si sorvegliano i lavori
    // notturni: il guasto TOTALE sarebbe l'unico invisibile a chi lo cerca.
    esitoBattito = 'eccezione'
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ ok: false, motivo: esitoBattito }, { status: 500 })
  } finally {
    // ── IL BATTITO ──
    // SEMPRE, anche a zero righe, anche quando tutto è fallito. Senza, «nessun
    // log» non distingue «nessun documento in scadenza» da «il cron non parte
    // più» — e la prima è la condizione NORMALE di questo job, quindi il silenzio
    // sarebbe indistinguibile dalla salute per mesi.
    //
    // `esito: 'ok'` solo quando il giro ha davvero finito: `controlloBattitoCron`
    // (`/api/health`) conta soltanto i battiti con quella stringa, quindi un
    // lavoro che fallisce ogni notte diventa visibile come «job senza battito»
    // oltre la finestra di 26 ore.
    //
    // ── I CONTEGGI PER SEDE ──
    // Una riga per sede, e SOLO se quella sede ha qualcosa da riportare: nella
    // notte normale (nessun documento che attraversa una soglia) non se ne
    // scrive nessuna, e il battito qui sotto resta l'unica riga.
    //
    // `distingui: ['sede_id']` non è un dettaglio: `app_log` deduplica per
    // (fingerprint, giorno) e il `contesto` NON è nell'impronta — senza,
    // Giugliano, Aversa e Cesa collasserebbero in UNA riga che dichiara i numeri
    // della prima e li attribuisce a tutte. È lo stesso difetto già pagato sui
    // rifiuti (rilievi T9, T10, T29).
    //
    // `esito: 'per-sede'` e non `'ok'`: `controlloBattitoCron` conta come battito
    // solo l'`ok`, e queste righe sono un dettaglio, non la dichiarazione che il
    // giro è andato bene.
    for (const [sedeId, conteggi] of perSede) {
      logEvento(
        'cron',
        'info',
        {
          operazione: JOB,
          esito: 'per-sede',
          sede_id: sedeId,
          n_avvisate: conteggi.avvisate,
          n_scaduti: conteggi.scaduti,
          n_email: conteggi.email,
          n_disattivate: conteggi.disattivate,
          msg:
            `${JOB}: ${conteggi.avvisate} avvisi in una sede, di cui ${conteggi.scaduti} su documenti già scaduti` +
            // Senza questa coda, «0 avvisi» in una sede che ha spento il tipo si
            // legge come «non c'era niente da dire»: due fatti opposti, la stessa riga.
            (conteggi.disattivate > 0
              ? `, e ${conteggi.disattivate} taciuti perché la sede ha spento questo tipo di notifica`
              : ''),
        },
        undefined,
        { distingui: ['sede_id'] },
      )
    }

    logEvento('cron', 'info', {
      operazione: JOB,
      esito: esitoBattito,
      n_lette: nLette,
      n_da_avvisare: nDaAvvisare,
      n_avvisate: nAvvisate,
      n_scaduti: nScaduti,
      n_email: nEmail,
      n_email_fallite: nEmailFallite,
      n_senza_utente: nSenzaUtente,
      n_senza_email: nSenzaEmail,
      // I DUE MODI IN CUI QUESTO ALLARME TACE DI PROPOSITO, contati nella riga
      // che si legge per sapere com'è andata: l'interruttore della sede e il
      // tetto dei risolleciti. Senza, un allarme spento e un allarme che non
      // aveva niente da dire scrivono lo stesso battito.
      n_disattivate: nDisattivate,
      n_email_oltre_tetto: nEmailOltreIlTetto,
      // La copertura dell'allarme, nella riga che si legge per sapere se è
      // andata bene: `null` = non misurato, non «zero». Vedi il passo 1b.
      n_senza_scadenza: nSenzaScadenza,
      n_stato_non_aggiornato: nStatoNonAggiornato,
      n_sedi: perSede.size,
      lotto_pieno: lottoPieno,
      ms: Date.now() - t0,
      msg: `${JOB}: ${nAvvisate} avvisi su ${nLette} anagrafiche nella finestra di ${SOGLIA_MAX} giorni`,
    })
  }
})
