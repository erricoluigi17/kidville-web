import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { esitoConElenco } from '@/lib/logging/esito-elenco'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import {
  PERSONALE_FIELDS,
  CONSENSI_PERSONALE_FIELDS,
  CONSENSI_PERSONALE_VERSIONE,
} from '@/lib/forms/personale-template'
import { GRADI_OPTIONS } from '@/lib/forms/insegnanti-template'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { validatePage, isProvinceField } from '@/lib/forms/validate-fields'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { normalizzaCodiceFiscale, validaCodiceFiscale } from '@/lib/fiscale/validazione'
import type { MotivoCfNonValido } from '@/lib/fiscale/validazione'
import { verificaCoerenza } from '@/lib/fiscale/coerenza'
import { extractRequestMeta } from '@/lib/fea/signature-log'
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni'
import { sediReali } from '@/lib/scuole/reali'
import { caricamentiReclamabili, collegaCaricamenti } from '@/lib/personale/caricamenti'
import { COLONNE_DOCUMENTO, percorsoDocumentoAmmesso } from '@/lib/personale/percorso-documento'
import type { FormPage } from '@/types/database.types'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POST /api/iscrizione/personale — l'anagrafica di chi già lavora qui     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * La Segreteria manda il link a una maestra IN SERVIZIO, lei compila, e solo
 * quando una persona in Segreteria riconosce la pratica quei dati diventano
 * anagrafica vera (`anagrafica_personale`) e — se serve — un account.
 *
 * ── NON È «LAVORA CON NOI», E LA DIFFERENZA NON È DI ETICHETTA ──────────────
 *
 * `/lavora-con-noi` raccoglie CANDIDATURE: persone di cui la Scuola non sa ancora
 * niente, e per cui il codice fiscale non serve (la finalità è valutare una
 * proposta). Qui il contratto di lavoro c'è già: la base è l'art. 6.1.b insieme
 * agli obblighi del datore (art. 6.1.c — UNILAV, libro unico, INPS/INAIL,
 * sostituto d'imposta), e senza codice fiscale NESSUNO di quegli adempimenti è
 * eseguibile. Per questo qui si chiede, e là no.
 *
 * ── ⚠️ LA PORTA È ANONIMA, PER DECISIONE DEL TITOLARE (11/08/2026) ──────────
 *
 * Chi bussa non ha un account e non deve averlo: il link si condivide, e non c'è
 * nessuna verifica dell'email prima dei campi sensibili (l'alternativa — un OTP
 * prima del codice fiscale — è stata valutata e scartata). Quindi la difesa non è
 * la porta, è ciò che sta dietro, ed è scritta in `personale-template.ts` come
 * elenco di REQUISITI: tetto per IP ed esca, la pratica che non è né un account né
 * l'anagrafica, la scansione in un bucket separato da quello dei documenti dei
 * minori, l'avviso alla Segreteria a ogni invio. Più una che il template non poteva
 * prevedere e che è nata dal collaudo: il registro dei caricamenti, senza il quale
 * un modulo abbandonato lasciava nel bucket la fotografia di una carta d'identità
 * che nessuna riga nominava.
 *
 * ── PERCHÉ STA SOTTO `/api/iscrizione` ──────────────────────────────────────
 *
 * `/api/iscrizione` è già in `PUBLIC_PREFIXES` (`src/lib/auth/middleware-rules.ts`)
 * ed è già dentro il perimetro di `zod-coverage`. Un prefisso nuovo avrebbe voluto
 * dire allargare la superficie anonima dell'applicazione per una questione di nomi.
 *
 * ── LA FORMA È COPIATA DA `iscrizione/insegnanti:POST`, NON REINVENTATA ─────
 *
 * Quella rotta ha già pagato tutti i difetti di questa corsia: tetto prima di
 * leggere il corpo, `.loose()` per non perdere le chiavi del wizard, ri-validazione
 * server con le STESSE regole del client, gate dei consensi, `consents_log`,
 * degrado dichiarato su `PGRST204`/`42703`, notifica alla Segreteria anche nel ramo
 * del doppio invio, successo loggato. Qui cambiano i dati, non l'impianto.
 *
 * Le cose che QUI sono in più, e che là non potevano esserci, sono il codice fiscale
 * (due livelli distinti, vedi il punto 6) e il percorso della scansione del documento
 * d'identità — che si verifica in DUE tempi: la forma al punto 7, e l'esistenza
 * insieme all'appartenenza al punto 9-bis, contro il registro dei caricamenti.
 */

/**
 * Il nome della rotta: finisce nella colonna `app_log.operazione` ed è la chiave
 * con cui si chiede «quale route ha fallito».
 *
 * ⚠️ Sotto, in `withRoute(…)`, lo stesso valore è scritto LETTERALE e non con
 * questa costante — non è una svista. Il lock `logging-coverage` legge il SORGENTE
 * e pretende una stringa letterale che combaci col percorso del file
 * (`src/app/api/iscrizione/personale/route.ts` → `iscrizione/personale:POST`): con
 * una costante non vedrebbe nessun `withRoute` affatto.
 */
const OPERAZIONE = 'iscrizione/personale:POST'

/**
 * Il tetto di invii per indirizzo IP, in un'ora. La ragione — misurata — sta nel
 * punto 1 dell'handler, che è il posto in cui si legge insieme al codice che lo usa.
 *
 * ⚠️ NON si esporta: un file di route Next.js accetta soltanto gli export previsti
 * (i metodi HTTP e poche voci di configurazione), e qualunque altro fa fallire il
 * `build` con «is not a valid Route export field». Il test lo misura leggendo le
 * opzioni con cui la route chiama `rateLimit`, che è il valore VERO invece di una
 * costante ricopiata.
 */
const TETTO_INVII_ORA = 20

/** L'unico posto in cui si nomina il pannello di Segreteria. */
const LINK_COCKPIT = '/admin/modulistica?tab=personale'

/** I ruoli che in Segreteria valutano le pratiche del personale. */
const RUOLI_SEGRETERIA = ['admin', 'coordinator', 'segreteria']

/**
 * GLI STATI IN CUI UNA PRATICA «ESISTE» PER L'INDICE UNICO, in un posto solo.
 *
 * L'indice è `unique (lower(email)) where stato in ('pending','in_approvazione')`, e
 * questi due valori servono in DUE punti di questo file: la rilettura della riga viva
 * dopo un `23505`, e il riconoscimento del proprio secondo invio al punto 9-bis.
 * Ribatterli sarebbe la forma di difetto che questo repo ha già pagato («una regola
 * valida per due strade deve vivere in un posto solo»): scritti due volte divergono
 * alla prima modifica dell'indice, e a divergere sarebbe esattamente il ramo che
 * decide se una persona legge «ricevuta» o un errore sul proprio documento.
 */
const STATI_VIVI = ['pending', 'in_approvazione'] as const

/**
 * I tre corpi dell'avviso alla Segreteria, in un posto solo.
 *
 * Nessuno dei tre NOMINA la persona, ed è una regola e non uno stile: un avviso è
 * un oggetto che viaggia su più canali (in-app, push, email) e non è il posto dove
 * si scrive di chi è il codice fiscale appena arrivato.
 */
const CORPO_AVVISO = {
  /** Primo invio: c'è una pratica nuova, ed è di questa sede. */
  nuova:
    'È arrivata un’anagrafica del personale dal modulo pubblico: va verificata e approvata ' +
    'prima di diventare una scheda vera.',
  /** Doppio invio con la pratica viva NELLA STESSA sede: la scheda è già qui. */
  duplicataQui:
    'La stessa persona ha inviato di nuovo la propria anagrafica dal modulo pubblico: ' +
    'la pratica da valutare è quella collegata a questo avviso.',
  /**
   * Doppio invio con la pratica viva ALTROVE (o non leggibile). L'indice unico è
   * GLOBALE (`unique (lower(email)) where stato in ('pending','in_approvazione')`),
   * mentre l'avviso è PER SEDE: senza questo ramo la seconda Segreteria non vedrebbe
   * niente e crederebbe che la pratica non sia mai arrivata.
   */
  duplicataAltrove:
    'È arrivata un’anagrafica del personale per questa sede. La stessa persona ha già una ' +
    'pratica in valutazione per la cooperativa: la scheda è nella sede che l’ha ricevuta ' +
    'per prima.',
} as const

/**
 * L'AVVISO ALLA SEGRETERIA, in una funzione sola — e best-effort per scelta.
 *
 * Sul gemello questo pezzo stava dentro il percorso felice, e quella era metà del
 * difetto: il ramo del doppio invio usciva con `return` PRIMA di arrivarci, quindi
 * rispondeva «ricevuta» senza che nessuno venisse avvisato. Una funzione sola rende
 * impossibile che un ramo nuovo se ne dimentichi per omissione.
 *
 * ⚠️ I DESTINATARI ARRIVANO DA FUORI, e non è un'inversione di comodo. Risolverli
 * qui dentro toglierebbe dall'handler l'unica lettura che nomina una sede, e il lock
 * `isolamento-sede-coverage` ha ragione a essere severo: la regola d'insieme guarda
 * il CORPO dell'handler, e un presidio di sede nascosto in un helper è un presidio
 * che chi rilegge la route non vede.
 *
 * `staffScuola` non lancia mai (cattura e restituisce `[]` loggando): chiamarla
 * fuori da questo `try` non riapre la strada a un 500 dopo che la riga è scritta.
 *
 * `error` e non `warn` quando fallisce: la pratica c'è, il suo annuncio è perso — e
 * un'anagrafica che nessuno sa di aver ricevuto è una maestra che ha consegnato il
 * proprio documento d'identità a un sistema che non lo mostrerà a nessuno.
 */
async function avvisaSegreteria(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  scuolaId: string,
  destinatari: string[],
  avviso: { corpo: string; entitaId: string | null },
): Promise<void> {
  try {
    // ⚠️ La sede è la STESSA con cui sono stati scelti i destinatari: `staffScuola`
    // decide CHI riceve, `scuolaId` dice a chi è indirizzato. Con tre plessi, due
    // sedi diverse fra le due righe consegnerebbero l'avviso di un plesso alla
    // scrivania di un altro senza che nessun controllo se ne accorga.
    await notificaEvento(supabase, {
      tipo: 'pratica_personale_ricevuta',
      scuolaId,
      utenteIds: destinatari,
      titolo: 'Nuova anagrafica del personale da approvare',
      corpo: avviso.corpo,
      link: LINK_COCKPIT,
      entitaTipo: 'pratica_personale',
      entitaId: avviso.entitaId,
      bufferMin: 0,
    })
  } catch (e) {
    logEvento(
      'notifica',
      'error',
      { operazione: OPERAZIONE, esito: 'notifica-segreteria-non-accodata', scuola_id: scuolaId },
      e,
    )
  }
}

/**
 * Le fasce ammesse, LETTE dal template e non ribattute.
 *
 * `pratiche_personale.gradi` è di tipo `school_type_enum[]`, e un valore fuori enum
 * non fa un 400: arriva all'INSERT e prende `22P02`, cioè un 500 opaco davanti a una
 * persona che non ha nessuno a cui chiedere. Lo `z.enum` qui sotto fa arrivare il
 * rifiuto sotto il campo, prima di toccare il database.
 *
 * Derivato invece che scritto a mano di proposito: se un domani si aggiungerà una
 * quarta fascia (qui E nell'enum, con una migrazione), un letterale in questa rotta
 * la respingerebbe in silenzio.
 */
const GRADI_AMMESSI = GRADI_OPTIONS.map((o) => String(o.value)) as [string, ...string[]]

/** Gli stessi valori, come insieme: serve al secondo filtro prima dell'INSERT. */
const GRADI_VALIDI = new Set(GRADI_AMMESSI)

/**
 * Lo schema d'ingresso.
 *
 * `scuola_id` è un uuid OBBLIGATORIO. Le sedi sono tre: dedurre la sede
 * significherebbe archiviare la pratica nel plesso sbagliato in silenzio, e chi
 * compila non ha modo di accorgersene — mentre la Segreteria che l'aspetta crede
 * che non sia arrivata.
 *
 * `data` è `.loose()` come sugli altri due moduli pubblici: il wizard può portare
 * chiavi che qui non si conoscono (i consensi, per dirne una) e che NON finiscono
 * nell'INSERT — vedi `costruisciRiga`.
 */
const postBodySchema = z.object({
  scuola_id: z.string().uuid({ message: 'Indicare la sede in cui si lavora' }),
  data: z
    .object(
      {
        gradi: z
          .array(z.enum(GRADI_AMMESSI), { error: 'Indica almeno una fascia d’età' })
          .min(1, 'Indica almeno una fascia d’età'),
      },
      { error: 'Dati dell’anagrafica non validi' },
    )
    .loose(),
  /**
   * L'ESCA. Due nomi, entrambi facoltativi, entrambi da lasciare vuoti.
   *
   * `sito_web` è quello che il modulo rende (nascosto agli occhi e agli screen
   * reader); `honeypot` è accettato come sinonimo perché il costo di riconoscere due
   * nomi è zero, e quello di un modulo e una route che non si accordano sul nome è
   * un'esca che non scatta mai — cioè una difesa che sembra esserci.
   */
  sito_web: z.string().optional(),
  honeypot: z.string().optional(),
})

/** Il valore di un campo di testo, ridotto: stringa non vuota oppure `null`. */
function testo(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * Normalizza PRIMA di validare. Tre campi, tre ragioni diverse.
 *
 * ── LE PROVINCE: «Napoli» → «NA», «na» → «NA» ───────────────────────────────
 * Le colonne sono `varchar(2)`: senza questo passaggio una provincia scritta per
 * esteso verrebbe troncata o rifiutata a valle. Un valore irriconoscibile resta
 * com'è, così `validateField` lo segnala sotto il campo giusto invece di sparire.
 *
 * ── L'EMAIL: minuscola, sempre ──────────────────────────────────────────────
 * È la chiave DUE volte: l'indice che decide se una pratica è un doppione
 * (`unique (lower(email)) where stato in ('pending','in_approvazione')`) e la chiave
 * con cui l'approvazione decide se AGGIORNARE l'anagrafica di chi ha già un account
 * o aprirne uno nuovo. Se la colonna conservasse le maiuscole digitate, il DATO in
 * tabella e la CHIAVE che lo rende unico sarebbero due cose diverse: «Maria.Rossi@…»
 * prenderebbe `23505` ma non si ritroverebbe cercando «Maria.Rossi@…», perché in
 * tabella c'è «maria.rossi@…».
 *
 * ── IL CODICE FISCALE: maiuscolo, senza spazi ───────────────────────────────
 * `normalizzaCodiceFiscale` toglie anche gli spazi INTERNI, compreso lo spazio
 * unificatore U+00A0 — che è quello che i PDF usano davvero e che a schermo è
 * indistinguibile da uno normale. Un codice incollato da una mail o da un documento
 * arriva spezzato in gruppi, e senza questo passaggio verrebbe respinto come
 * «formato non valido» a una persona che l'ha scritto giusto.
 *
 * ⚠️ Se il campo è VUOTO non si tocca: `normalizzaCodiceFiscale` restituisce `''` per
 * qualunque cosa non sia una stringa, e scriverlo indietro trasformerebbe un «Campo
 * obbligatorio» in un «Inserisci un codice fiscale valido» — cioè direbbe che quello
 * che non hai scritto è scritto male.
 *
 * Il tipo si legge dal TEMPLATE (`f.type === 'email'`) e non dal nome del campo: un
 * secondo recapito aggiunto domani sarebbe normalizzato senza toccare questa riga.
 */
function normalizzaRecord(dati: Record<string, unknown>): Record<string, unknown> {
  const r = { ...dati }
  for (const f of PERSONALE_FIELDS) {
    if (f.type === 'email') {
      const v = testo(r[f.id])
      if (v !== null) r[f.id] = v.toLowerCase()
      continue
    }
    if (isProvinceField(f)) {
      const grezzo = r[f.id]
      if (grezzo === null || grezzo === undefined || String(grezzo).trim() === '') continue
      const sigla = normalizzaProvincia(grezzo)
      if (sigla) r[f.id] = sigla
    }
  }
  if (testo(r.fiscal_code) !== null) r.fiscal_code = normalizzaCodiceFiscale(r.fiscal_code)
  return r
}

/**
 * La riga da inserire, costruita SOLO dai campi del template.
 *
 * Non si fa lo spread di `data`: è `.loose()`, quindi porta con sé le chiavi del
 * wizard e qualunque cosa un client possa aggiungere. Spargerle nell'INSERT vorrebbe
 * dire un `PGRST204` sul primo invio vero — o, peggio, permettere a un ANONIMO di
 * scrivere `stato: 'approvata'`, `utente_id` o `evasa_da`, cioè di consegnarsi da
 * solo una pratica già accolta e già collegata a un account.
 */
function costruisciRiga(dati: Record<string, unknown>, gradi: string[]): Record<string, unknown> {
  const riga: Record<string, unknown> = {}
  for (const f of PERSONALE_FIELDS) {
    if (f.id === 'gradi') continue
    riga[f.id] = testo(dati[f.id])
  }
  // `gradi` SEMPRE esplicito, e mai vuoto. Il CHECK in tabella è
  // `cardinality(gradi) >= 1`, che a differenza di `array_length` morde davvero anche
  // sull'array vuoto — ma la difesa doppia costa zero, e le fasce decidono quali
  // funzioni la persona vedrà nell'app.
  riga.gradi = gradi
  return riga
}

/** Il codice PostgREST/Postgres di un errore che NON è stato lanciato ma restituito. */
function codiceDi(errore: unknown): string {
  return (errore as { code?: string } | null)?.code ?? ''
}

/**
 * Il nome della colonna che il database dice di non avere.
 *
 * Due formulazioni, perché due sono le sorgenti: PostgREST («Could not find the 'x'
 * column of …», `PGRST204`) e Postgres («column "x" of relation …», `42703`). Il nome
 * si accetta SOLO se è davvero una colonna che stiamo scrivendo: un messaggio che
 * cambia forma non deve poter far cadere un campo a caso.
 */
function colonnaMancante(messaggio: string | undefined, colonne: string[]): string | null {
  const t = messaggio ?? ''
  const nome =
    /'([A-Za-z0-9_]+)'\s+column/.exec(t)?.[1] ?? /column\s+"([A-Za-z0-9_]+)"/.exec(t)?.[1] ?? null
  return nome && colonne.includes(nome) ? nome : null
}

/** «Questa colonna qui non c'è»: PostgREST (`PGRST204`) e Postgres (`42703`). */
const CODICI_COLONNA_ASSENTE = ['PGRST204', '42703']

/**
 * LE COLONNE CHE UN DATABASE INDIETRO PUÒ LEGITTIMAMENTE NON AVERE — e quindi quante
 * volte al massimo il ramo di degrado può ritentare.
 *
 * ⚠️ LE FACCE DEL DOCUMENTO NON SONO QUI DENTRO, ED È IL PUNTO DI TUTTO IL BLOCCO.
 * Per qualche ora, il 13/08/2026, questo elenco è stato `['consents_log',
 * ...COLONNE_DOCUMENTO]`: cioè dichiarava che una colonna che tiene la fotografia di
 * una carta d'identità è «una colonna che un database indietro può legittimamente non
 * avere», e il ciclo la toglieva per far entrare la riga. Il risultato era un **201**
 * su una pratica SENZA scansione — e il seguito è al punto 10-bis, dove gli oggetti
 * vengono comunque collegati alla pratica: da quel momento `spazzaCaricamentiSospesi`
 * non li vede più (filtra `pratica_id is null`) e `gdpr/retention-personale` nemmeno
 * (scopre i file leggendo le colonne, che in quella riga non ci sono). Una fotografia
 * di documento d'identità nel bucket, non spazzabile e non conservabile: esattamente
 * ciò che `personale-template.ts` chiama «conservata per sempre e irrintracciabile».
 *
 * La migrazione `20260812194501` lo aveva scritto per esteso, nel riquadro «ORDINE DI
 * RILASCIO VINCOLANTE», e prescriveva il contrario: *«il suo ramo di degrado TOGLIE la
 * colonna sconosciuta e inserisce la pratica SENZA il percorso: la scansione si perde
 * in silenzio, che è il modo peggiore di perderla… migrazione prima del codice = 503
 * per il tempo del deploy. È l'errore giusto: rumoroso e reversibile.»*
 *
 * ⚠️ SERVE IL NUMERO, NON L'APPARTENENZA. Il degrado toglie la colonna che il DATABASE
 * nomina, non una scelta da questo elenco: se un giorno mancasse `titolo_studio` la
 * rotta toglierebbe quella, ed è giusto — una pratica persa perché il database è
 * indietro di una colonna sarebbe peggio del degrado. Questo elenco misura solo quanto
 * lontano ci si spinge prima di dire che il database è rotto in un modo che non
 * sappiamo leggere. L'unica appartenenza che conta è quella NEGATIVA, e sta poco più
 * in basso in `COLONNE_INDEGRADABILI`.
 */
const COLONNE_FACOLTATIVE = ['consents_log']

/**
 * LE COLONNE CHE NON SI TOLGONO MAI, nemmeno per far entrare la riga.
 *
 * Si DERIVA da `COLONNE_DOCUMENTO`, quindi una terza faccia dichiarata nel template
 * entrerebbe qui da sola: il nome di una colonna che tiene un documento non si scrive
 * due volte, e questo è uno dei posti in cui il costo di riscriverlo sarebbe una
 * scansione persa.
 *
 * COSA SUCCEDE AGLI OGGETTI GIÀ CARICATI quando questo ramo scatta, detto invece che
 * lasciato dedurre: nessuna riga nasce, quindi nessuno li reclama, quindi restano
 * `pratica_id is null` e `spazzaCaricamentiSospesi` li toglie dal bucket entro 24 ore.
 * È il verso giusto in cui sbagliare — meglio una scansione da rifare che una
 * scansione che nessuno può più né trovare né cancellare.
 */
const COLONNE_INDEGRADABILI: readonly string[] = COLONNE_DOCUMENTO

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  L'ERRORE COM'È SCRIVIBILE IN UN LOG: tutto, tranne `details`             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── IL DIFETTO, MISURATO E NON DEDOTTO (12/08/2026) ────────────────────────
 *
 * Quando Postgres rifiuta una riga per un vincolo che non è un'unicità, il campo
 * `details` NON è una spiegazione: è la RIGA. Comincia con `Failing row contains (`
 * e prosegue con i valori delle colonne, in ordine di tabella.
 *
 * `descriviErrore` (`src/lib/logging/serialize.ts`) legge `o.details` e lo passa a
 * `sanificaMessaggio`, che maschera `Key (col)=(val)`, le quattro frasi con cui
 * Postgres echeggia un input rifiutato, le email e i codici fiscali — e NON conosce
 * `Failing row contains`. Eseguito su un dump di questa tabella, ecco cosa sopravvive
 * dentro il cap di 500 caratteri: mascherati `[email]` e `[cf]`; **in chiaro** nome,
 * cognome, sesso, data e comune di nascita, cittadinanza, indirizzo di casa con
 * civico CAP e provincia, telefono, tipo e NUMERO del documento d'identità, e i
 * percorsi delle DUE facce (`documento_fronte_path` e `documento_retro_path`, che il
 * dump del 12/08 mostrava ancora come l'unica `documento_path`) — cioè le chiavi con
 * cui si firmano le fotografie di quel documento. In `app_log`, persistito 30 giorni
 * e interrogabile in SQL.
 *
 * Questa rotta dichiara TRE VOLTE che nel log il percorso non va mai. Il ramo
 * generico dei 500 la contraddiceva, da una porta senza login.
 *
 * ── PERCHÉ SI TOGLIE SEMPRE, E NON SOLO SUI `23xxx` ────────────────────────
 *
 * Perché una condizione su un elenco di codici noti è la forma di difetto che questo
 * repo ha già pagato due volte: «una regola giusta applicata a una lista chiusa di
 * pattern». `Failing row contains` lo emettono almeno `23502` e `23514`, e la lista
 * cambia con la versione di Postgres — mentre il criterio «`details` non serve mai
 * quanto costa» non cambia mai.
 *
 * ── E NON È IL CORPO DELL'ERRORE BUTTATO VIA (AGENTS §3) ───────────────────
 *
 * §3 dice di non perdere il corpo della risposta di un provider ESTERNO, perché
 * `403` non dice niente e `403 "the domain is not verified"` dice tutto. Qui non si
 * perde: `message`, `code` e `hint` passano interi, e il `message` di un `23514`
 * NOMINA il vincolo saltato — «… violates check constraint
 * "pratiche_personale_document_expiry_check"» — che è esattamente l'informazione che
 * serve alle tre di notte. È `details` a non aggiungere nulla che non sia la riga di
 * una persona.
 *
 * ── DOVE ANDREBBE LA VERSIONE GENERALE (segnalato, non fatto) ──────────────
 *
 * In `sanificaMessaggio`, come quinta frase ancorata accanto alle quattro che già ci
 * sono. È un file condiviso di un altro elemento: sta nel rapporto, non qui.
 */
function erroreSenzaLaRiga(errore: unknown): Record<string, string> {
  const e = (errore ?? {}) as Record<string, unknown>
  const fuori: Record<string, string> = {}
  for (const chiave of ['code', 'message', 'hint']) {
    const v = e[chiave]
    if (typeof v === 'string' && v !== '') fuori[chiave] = v
  }
  return fuori
}

/** La pagina dei consensi, nella forma che `consensi.ts` sa leggere. */
const PAGINA_CONSENSI: FormPage[] = [
  { id: 'consensi', title: 'Consensi', fields: CONSENSI_PERSONALE_FIELDS },
]

/*
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  DUE CAMPI ANONIMI che puntano a un documento d'identità                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ⚠️ QUESTO RIQUADRO SI INTITOLAVA `documento_path` E PARLAVA AL SINGOLARE fino al
 * 13/08/2026, cioè descriveva un prodotto che non esiste più da un giorno: la
 * migrazione `20260812194501` ha rinominato quella colonna in `documento_fronte_path`
 * e ne ha aggiunta una seconda, e il template ne dichiara DUE, entrambe `required`.
 * Un commento che nomina una colonna cancellata, in un file di sicurezza, è la stessa
 * classe di difetto che quel giorno ha tolto alla Segreteria l'accesso a ogni
 * scansione: il codice era stato aggiornato, la frase che lo spiegava no.
 *
 * I valori sono le CHIAVI con cui il pannello di Segreteria farà firmare due oggetti
 * dello Storage. Chi compila non carica i file dentro questa richiesta: manda due
 * stringhe che dicono «li ho già caricati là». Senza un gate, quelle stringhe sono
 * testo libero di lunghezza arbitraria scritto da un anonimo dentro il database —
 * e `validateField` sul tipo `file` non applica né `pattern` né `max_length`
 * (`accept` e `max_size_mb` valgono per il SELETTORE DEL BROWSER, non per il server).
 *
 * Il bucket separato (`documenti_personale`, migrazione `20260811205643`) rende
 * impossibile PER COSTRUZIONE che di qui si indichi un documento d'iscrizione di un
 * minore: quelli stanno in `form_attachments`, e un percorso `documenti/…` non si
 * risolve mai a una riga di iscrizione. Ma dentro lo stesso bucket la difesa deve
 * essere questa: si accetta SOLO la forma che `iscrizione/personale/upload:POST`
 * produce — prefisso dedicato, DUE uuid generati dal server, estensione decisa dal
 * gate — e si rifiuta tutto il resto.
 *
 * ── ⚠️ E IL RIFIUTO NON DICE QUALE DELLE DUE FACCE È IL COLPEVOLE ──────────
 *
 * Qui c'era scritto «si rifiuta tutto il resto NOMINANDO il campo», ed era vero
 * quando il campo era uno. Con due, nominare il colpevole sarebbe un ORACOLO:
 * `rispostaDocumentoNonValido()` risponde deliberatamente su TUTTE E DUE le facce,
 * perché contestare solo il retro direbbe a chi sta provando percorsi inventati che
 * il fronte è stato ACCETTATO — cioè che quell'oggetto esiste nel registro dei
 * caricamenti. Il ragionamento per esteso sta nella testata di quella funzione, ed è
 * lo stesso con cui il doppione risponde 201 invece di 409. Il campo continua a
 * essere nominato — il wizard ha due riquadri da colorare e li colora entrambi — ma
 * il messaggio non distingue, e non deve.
 *
 * ⚠️ MA LA FORMA, DA SOLA, NON BASTA — e va detto invece di lasciarlo dedurre. Gli
 * uuid non sono indovinabili, ma sono anche l'unica cosa che questo gate guarda, e da
 * qui discendono due buchi che il gate NON chiude:
 *
 *  · l'oggetto potrebbe NON ESISTERE. I campi sono `required: true` nel template e
 *    sono la ragione per cui questo modulo esiste, ma si soddisferebbero con due
 *    stringhe inventate `documenti/<uuid>/<uuid>.pdf` — e questa forma è documentata
 *    in un repository PUBBLICO. La Segreteria vedrebbe una pratica «completa» e lo
 *    scoprirebbe solo cliccando.
 *  · l'oggetto potrebbe essere GIÀ DI QUALCUN ALTRO. Un URL firmato contiene il
 *    percorso in chiaro: basta un link inoltrato per conoscerlo. Il gemello
 *    `iscrizione/insegnanti:POST` chiude quella catena spostando il prefisso
 *    (`candidature/` non è ciò che l'altra porta produce); qui il prefisso
 *    `documenti/` è LO STESSO che genera l'unica rotta di caricamento, quindi quella
 *    difesa non c'è. Chi conosce un percorso legittimo potrebbe allegarlo a una
 *    pratica per un'ALTRA sede, e la Segreteria di quel plesso si farebbe firmare il
 *    documento d'identità di una persona che non è sua.
 *
 * Entrambi si chiudono al punto 9-bis con UNA lettura sola sul registro dei
 * caricamenti (`@/lib/personale/caricamenti`), non qui: questo resta il gate di
 * forma, che è a costo zero e respinge il grosso prima di toccare il database.
 *
 * ⚠️ NEL LOG NON VA MAI NESSUNO DEI DUE PERCORSI. Non contengono il nome del file — la
 * rotta di caricamento lo butta via apposta — ma restano le chiavi che aprono il
 * documento d'identità di una persona, e `redact()` non ha quelle colonne in lista
 * bianca. La regola vale a monte: la privacy non si delega a chi redige. Si registra
 * CHE è stato respinto, non che cosa era.
 */
/*
 * ⚠️ LA FORMA NON ABITA PIÙ QUI: sta in `@/lib/personale/percorso-documento` (12/08/2026).
 *
 * È rimasta in questo file finché il chiamante era uno solo. Col documento fronte/retro i
 * chiamanti diventano quattro — questa rotta più i gate del pannello di Segreteria — e il
 * modulo esiste soprattutto per LORO: là il percorso arriva dalla QUERY STRING e finisce
 * dentro un filtro PostgREST che confronta due colonne, dove una virgola non rompe il filtro
 * ma lo RISCRIVE. Copiare queste righe sarebbe stata la copia che diverge, e a divergere
 * sarebbe stato un gate di sicurezza. Le prove, rifiuto per rifiuto, sono in
 * `__tests__/lib/percorso-documento.test.ts`.
 */

/**
 * IL RIFIUTO DEL PERCORSO, UNO SOLO PER TUTTI E QUATTRO I MOTIVI.
 *
 * I motivi sono «forma sbagliata», «quell'oggetto non esiste», «quell'oggetto è già
 * di un'altra pratica» e — dal 12/08/2026 — «il registro dei caricamenti non c'è su
 * questo database, quindi nessun percorso è verificabile». La risposta deve essere
 * IDENTICA per tutti e quattro: stesso testo, stesso codice, stesso stato.
 * Distinguerli sarebbe un oracolo — chi prova un percorso inventato saprebbe dalla
 * risposta se ha indovinato un oggetto vero, cioè si trasformerebbe la verifica in
 * uno strumento per censire le scansioni caricate. È lo stesso ragionamento con cui
 * il doppione risponde 201 invece di 409.
 *
 * Il quarto motivo non è un guasto che si nasconde a chi compila: nello stato in cui
 * scatta, la rotta di upload non consegna nemmeno un percorso (ritira l'oggetto e
 * risponde 500), quindi la frase qui sotto — «allega di nuovo il documento» — è già
 * quella giusta, e il PERCHÉ tecnico sta nel log `error` che nomina la migrazione.
 *
 * La frase dice l'unica cosa utile a chi ha compilato in buona fede — riallega il
 * documento — e non spiega niente a chi sta tentando.
 */
function rispostaDocumentoNonValido(): NextResponse {
  return NextResponse.json(
    {
      error: 'Alcuni campi non sono validi. Controlla i dati e riprova.',
      codice: 'PRATICA_NON_INVIATA',
      // I CAMPI SI DERIVANO, e sono SEMPRE TUTTI E DUE — qualunque delle due facce
      // sia il colpevole. Non è pigrizia, ed è la parte da capire.
      //
      // Rispondere `campi: { documento_retro_path: … }` direbbe a chi sta provando
      // percorsi inventati che **il fronte è stato accettato**, cioè che quell'oggetto
      // esiste nel registro dei caricamenti. Chi tenta manda due percorsi per volta,
      // legge quale dei due gli viene contestato, e in due richieste sa quale dei
      // quattro esiste: la verifica diventerebbe uno strumento per CENSIRE le scansioni
      // caricate, che è esattamente ciò che il registro esiste per proteggere. È lo
      // stesso ragionamento con cui il doppione risponde 201 invece di 409, e con cui i
      // quattro motivi di rifiuto condividono una risposta sola.
      //
      // La seconda ragione riguarda il rinomino: una chiave scritta a mano qui dentro
      // sopravvive a un rinomino del campo puntando al nulla — il messaggio uscirebbe
      // dal server e il wizard non avrebbe più nessun campo da colorare, quindi chi
      // compila leggerebbe «alcuni campi non sono validi» senza vedere quali.
      campi: Object.fromEntries(
        COLONNE_DOCUMENTO.map((campo) => [
          campo,
          'Allega di nuovo il documento dal modulo: questo riferimento non è valido.',
        ]),
      ),
    },
    { status: 400 },
  )
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  «QUEL PERCORSO È GIÀ MIO?» — l'eccezione che il reclamo deve conoscere   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── IL DIFETTO CHE QUESTA FUNZIONE CHIUDE, RIPRODOTTO ESEGUENDO ─────────────
 *
 * Il reclamo del punto 9-bis, così com'era, respingeva con 400 OGNI percorso già
 * collegato — compreso quello della stessa persona che rimanda il proprio modulo — e
 * lo faceva PRIMA dell'INSERT, quindi il ramo `23505` non veniva mai raggiunto.
 * Misurato sul finto della suite: primo invio `201` con l'oggetto collegato; secondo
 * invio IDENTICO → `400 {"codice":"PRATICA_NON_INVIATA","campi":{"documento_path":…}}`
 * (la misura è dell'11/08, quando la colonna era una e si chiamava così; oggi la stessa
 * risposta nominerebbe le due facce),
 * ZERO tentativi di INSERT, nessun avviso alla Segreteria.
 *
 * È il difetto gemello di quello che `iscrizione/insegnanti:POST` ha già pagato, e
 * con la stessa forma — «il ramo del doppio invio usciva con `return` PRIMA di
 * arrivarci» — rimesso davanti alla notifica da un presidio nuovo. Le tre conseguenze,
 * in ordine di gravità:
 *
 *  · chi preme «Invia» due volte (connessione lenta, retry del browser, un campo
 *    corretto dopo il primo invio) vede un ERRORE mentre la sua pratica È stata
 *    ricevuta: è la bugia che il commento «il 201 non è una bugia» esisteva per
 *    impedire, rovesciata;
 *  · l'errore punta al campo del documento, che è l'unica cosa che non ha niente di
 *    sbagliato — quindi quella persona ricarica la scansione della propria carta
 *    d'identità e ne lascia una SECONDA copia nel bucket;
 *  · la Segreteria di questa sede non riceve nessuno dei due avvisi del doppio invio,
 *    cioè si perde di nuovo il percorso utente che quel ramo era stato scritto per
 *    riparare.
 *
 * ── LA DOMANDA GIUSTA, E PERCHÉ NON È «HA UNA PRATICA VIVA?» ────────────────
 *
 * Si chiede al database l'unica cosa che rende l'eccezione SICURA: esiste una pratica
 * VIVA, con QUESTA email, che nomina già UNO dei percorsi presentati? Se sì, la riga
 * che possiede l'oggetto è la stessa riga con cui l'INSERT sta per collidere: il
 * `23505` è garantito, nessuna riga nuova nascerà, e l'invariante «un oggetto, un
 * proprietario» non viene toccata. L'eccezione è legata alla propria garanzia, non a
 * un'ipotesi.
 *
 * ── ⚠️ «UNO DEI DUE» E NON «TUTTI E DUE», ED È MISURATO ────────────────────
 *
 * Con due facce, il secondo invio dello stesso modulo NON ripresenta gli stessi due
 * percorsi: il wizard ricarica ciò che la persona riallega, quindi tipicamente arriva
 * un fronte già suo (la pratica viva lo nomina) e un retro NUOVO, appena caricato e
 * ancora di nessuno. Pretendere che ENTRAMBI fossero già della pratica viva
 * respingerebbe proprio quel caso — cioè rimetterebbe in piedi il difetto che questa
 * funzione esiste per chiudere, dopo averlo riparato per il caso a una faccia sola.
 *
 * E non allarga la superficie, perché ciò che rende l'eccezione sicura resta intero:
 * la riga viva con questa email c'è (l'ha appena trovata questa lettura), quindi
 * l'INSERT collide e nessuna riga nuova nasce; e nel ramo dell'eccezione NON si
 * collega niente, quindi nessun oggetto cambia proprietario. Le altre facce, qualunque
 * cosa siano — appena caricate o di qualcun altro — restano dove sono.
 *
 * La versione più comoda — «questa email ha una pratica viva?», senza guardare il
 * percorso — sarebbe stata sbagliata in modo grave: rimetterebbe in piedi l'ORACOLO DI
 * ENUMERAZIONE che il ramo `23505` esiste per togliere. Chi prova un percorso qualsiasi
 * insieme a un'email leggerebbe dalla risposta se quella persona lavora qui.
 *
 * ── COSA RESTA LEGGIBILE, DETTO INVECE CHE NASCOSTO ────────────────────────
 *
 * Chi possiede già un percorso legittimo (un URL firmato inoltrato) può capire, dalla
 * differenza fra 400 e 201, QUALE email lo possiede. È un residuo accettato e non un
 * dettaglio dimenticato: per arrivarci bisogna avere in mano il documento d'identità
 * stesso, che contiene il nome — cioè si scoprirebbe l'email di una persona di cui si
 * ha già la carta d'identità. Chi NON ha un percorso vero non distingue niente: con un
 * percorso appena caricato la risposta è 201 in tutti i casi.
 *
 * ── L'ERRORE DI LETTURA NON APRE, CHIUDE ───────────────────────────────────
 *
 * Al contrario del reclamo (che è un presidio IN PIÙ e in caso di guasto lascia
 * passare), qui si sta cercando una RAGIONE PER AMMETTERE un percorso che è già di
 * qualcuno: se non la si può dimostrare non la si presume. Un guasto lascia quindi il
 * rifiuto in piedi — che è il comportamento di prima di questa funzione — e lascia
 * una riga per dire che il verdetto è stato dato senza la prova.
 */
const SELECT_PRATICA_VIVA = ['id', ...COLONNE_DOCUMENTO].join(', ')

/**
 * Quante righe vive per la stessa email si leggono al massimo.
 *
 * L'indice `unique (lower(email)) where stato in ('pending','in_approvazione')` ne
 * garantisce UNA. Questo numero non serve al database che ce l'ha: serve a quello che
 * NON ce l'ha — e questa rotta è scritta apposta per tollerare un database indietro
 * con le migrazioni, il che rende «l'indice c'è di sicuro» esattamente il presupposto
 * che non può darsi. Cinque è un tetto, non una previsione: chiude la lettura senza
 * scansione illimitata, e se davvero l'oggetto appartenesse alla sesta riga viva la
 * risposta sarebbe `false`, cioè il rifiuto — fail-closed, come tutto il resto qui.
 */
const MAX_PRATICHE_VIVE_LETTE = 5

async function documentiDiUnaPraticaViva(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  percorsi: readonly string[],
  email: string,
  scuolaId: string,
): Promise<boolean> {
  // ── ⚠️ UN SOLO ROUND TRIP, E NESSUN `.or(…)` CON UN VALORE INTERPOLATO ─────
  //
  // Questa lettura era `.eq('documento_path', percorso)`, e col rinomino del 12/08/2026
  // interrogava una colonna che non esiste più: rispondeva `42703`, la funzione tornava
  // sempre `false`, e chi rimandava il PROPRIO modulo si vedeva un 400 sull'unico campo
  // che non aveva niente di sbagliato. La riparazione immediata è stata un CICLO — una
  // `.eq()` per colonna del documento — che però costa due viaggi al database su ogni
  // secondo invio, e ne costerà tre alla faccia successiva.
  //
  // La forma che verrebbe naturale per farne uno solo è quella da NON usare:
  //
  //     .or(`documento_fronte_path.eq.${p},documento_retro_path.eq.${p}`)
  //
  // In quella sintassi la virgola SEPARA le condizioni e le parentesi le RAGGRUPPANO,
  // e `p` qui è testo scritto da un anonimo: un percorso con una virgola non romperebbe
  // il filtro, lo RISCRIVEREBBE. Non è un'iniezione SQL (PostgREST non concatena SQL) —
  // è un'iniezione di FILTRO, e il danno è lo stesso: la funzione che decide se
  // ammettere il documento di qualcun altro risponderebbe di sì. La ragione per esteso
  // sta nella testata di `@/lib/personale/percorso-documento`.
  //
  // La terza strada — quella scritta qui — non filtra affatto sui percorsi: chiede le
  // pratiche vive DI QUESTA EMAIL e confronta i percorsi IN MEMORIA. Un viaggio,
  // nessun valore di fuori dentro un filtro, e il confronto lo fa JavaScript con
  // `===`, dove una virgola è una virgola.
  //
  // ── ⚠️ PERCHÉ `.limit()` E NON `.maybeSingle()` ───────────────────────────
  //
  // Qui c'era `.maybeSingle()`, giustificato così: «l'indice `unique (lower(email))
  // where stato in (…)` garantisce al massimo una riga, quindi `.maybeSingle()` è
  // esatto e non un'approssimazione». La frase è vera sul database di produzione e
  // FALSA proprio dove questa rotta si sforza di funzionare: su un database indietro
  // con le migrazioni — che è il senso del ramo di degrado dell'INSERT, sessanta
  // righe più in basso — l'indice può non esistere. Là due righe vive con la stessa
  // email fanno rispondere `PGRST116` («multiple rows returned»), il ramo d'errore
  // torna `false`, e chi rimanda in buona fede il PROPRIO modulo prende un 400 sul
  // campo del documento: cioè esattamente il difetto che questa funzione esiste per
  // chiudere, riaperto in un caso più stretto. Non era un buco di sicurezza (il verso
  // dell'errore è quello giusto), ma era una difesa appoggiata a un presupposto che
  // il resto del file dichiara di non poter dare per buono.
  //
  // Col tetto la funzione non dipende più dall'indice: legge fino a
  // `MAX_PRATICHE_VIVE_LETTE` righe e guarda le facce di tutte. E la sicurezza
  // dell'eccezione non si allarga di un millimetro — se le righe vive fossero
  // davvero due, l'INSERT NON collide, quindi il `23505` non arriva e la riga nuova
  // nasce: quel caso è già nominato e loggato `error` al punto 10-ter
  // (`documento-condiviso-con-altra-pratica`), che è il presidio giusto per lui.
  //
  // ⚠️ IL RAMO `23505` CONTINUA A USARE `.maybeSingle()`, ed è corretto: là il
  // `23505` è appena arrivato, cioè l'indice esiste per dimostrazione.
  //
  // PostgREST NON lancia: ritorna `{ data, error }`, e un `try/catch` attorno non
  // scatterebbe mai (AGENTS §7).
  const { data, error } = await supabase
    .from('pratiche_personale')
    .select(SELECT_PRATICA_VIVA)
    .eq('email', email)
    .in('stato', STATI_VIVI)
    .limit(MAX_PRATICHE_VIVE_LETTE)

  if (error) {
    // Nel log l'esito e il codice, MAI il percorso e MAI l'email. `warn` e non
    // `error`: il rifiuto che ne segue è quello corretto per difetto — questa funzione
    // cerca una ragione per AMMETTERE, e non trovarla lascia le cose come stavano.
    // ⚠️ Il grido, se il database è messo male, l'ha già emesso il reclamo: da quando
    // il registro assente non ammette più (12/08/2026) si arriva qui anche in quello
    // stato, e lì `caricamentiReclamabili` ha già scritto un `error` che nomina la
    // migrazione mancante. Due `error` per lo stesso guasto sarebbero rumore.
    logEvento('personale', 'warn', {
      operazione: OPERAZIONE,
      esito: 'documento-path-proprietario-non-letto',
      scuola_id: scuolaId,
      error_code: codiceDi(error),
    })
    return false
  }

  const vive = (data ?? []) as unknown as Record<string, unknown>[]
  if (vive.length === 0) return false

  // Le facce che le pratiche vive NOMINANO già. `testo()` e non il valore grezzo: una
  // colonna vuota o assente non deve diventare una chiave dell'insieme, altrimenti una
  // faccia arrivata vuota combacerebbe con una colonna vuota e l'eccezione si
  // concederebbe da sola.
  const sue = new Set(
    vive
      .flatMap((viva) => COLONNE_DOCUMENTO.map((colonna) => testo(viva[colonna])))
      .filter((percorso): percorso is string => percorso !== null),
  )
  return percorsi.some((percorso) => sue.has(percorso))
}

/**
 * PERCHÉ IL CODICE FISCALE SBAGLIATO BLOCCA, E QUELLO INCOERENTE NO.
 *
 * Sono due domande diverse, e confonderle costa in tutte e due le direzioni.
 *
 * · `validaCodiceFiscale` chiede «è scritto bene?» e verifica il CARATTERE DI
 *   CONTROLLO. Un codice che non torna è un refuso di battitura — non esiste
 *   nessuna persona con quel codice — e farlo entrare significa scriverlo su un
 *   contratto, su una comunicazione UNILAV e su una denuncia INPS. Blocca.
 *
 * · `verificaCoerenza` chiede «è di QUESTA persona?» confrontandolo con nome,
 *   cognome, data, sesso e comune di nascita. NON blocca: bloccare respingerebbe
 *   omocodie (codici veri, assegnati dall'Agenzia quando due persone collidono) e
 *   comuni soppressi, cioè persone vere a cui si direbbe che il proprio codice
 *   fiscale non esiste. La regola del repo è «segnala sempre, non blocca mai», ed è
 *   la stessa che tiene grigio invece che rosso il pannello dei codici fiscali.
 */
const MESSAGGIO_CF: Record<MotivoCfNonValido, string> = {
  vuoto: 'Inserisci il codice fiscale',
  lunghezza: 'Il codice fiscale ha 16 caratteri: controlla di non averne saltato uno',
  forma: 'Questo codice fiscale non è scritto in una forma valida: ricontrollalo',
  giorno: 'Le due cifre del giorno di nascita non sono valide: ricontrolla il codice fiscale',
  'data-inesistente':
    'La data di nascita scritta nel codice fiscale non esiste sul calendario: ricontrollalo',
  checksum:
    'L’ultima lettera del codice fiscale non torna: di solito è un carattere digitato male',
}

/*
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LE DUE DATE: il calendario, e il limite che la TABELLA dichiara          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── IL DIFETTO, RIPRODOTTO ESEGUENDO (12/08/2026) ──────────────────────────
 *
 * `birth_date` e `document_expiry` sono `type: 'date'` nel template e non hanno
 * oggetto `validation` — e non possono averlo: `FormField.validation` sa dire
 * `pattern`, `min_length`, `max_length` e `min`/`max` NUMERICI, e nessuna di queste
 * esprime «una data che esiste sul calendario» o «dopo il 1990». Quindi su un campo
 * `date` tutto ciò che `validateField` applica è `/^\d{4}-\d{2}-\d{2}$/`.
 *
 * Misurato con l'imbracatura di questa suite, cinque invii per esteso:
 *   document_expiry: '1899-01-01' → 201, e '1899-01-01' scritto nell'INSERT
 *   '9999-99-99' · '0000-00-00' · '2030-02-31' · '2030-13-45' → 201, tutte
 *
 * ── E NON È UN PROBLEMA DI QUALITÀ DEL DATO: È UN DOSSIER NEL LOG ──────────
 *
 * La tabella DICHIARA `check (document_expiry is null or document_expiry >
 * date '1990-01-01')` — riletto in produzione il 12/08/2026 con `pg_constraint`, ed è
 * su ENTRAMBE le tabelle (`pratiche_personale` e `anagrafica_personale`). Postgres
 * rifiuta con **`23514`**, che non è in nessuno dei tre elenchi di codici gestiti più
 * in basso: la riga cadeva sul ramo generico dei 500, che passava l'oggetto PostgREST
 * GREZZO a `logErrore` — e il `details` di un `23514` è `Failing row contains (…)`,
 * cioè LA RIGA INTERA. Il seguito sta nella testata di `erroreSenzaLaRiga`.
 *
 * Chi lo innesca legge per giunta `PRATICA_NON_INVIATA`, cioè il codice che questa
 * stessa rotta condanna sessanta righe più in basso perché «inviterebbe a ritentare
 * fra qualche minuto una cosa che non può riuscire».
 *
 * ── DUE RIMEDI, E SERVONO ENTRAMBI ─────────────────────────────────────────
 *
 * Questo è il primo: il limite della tabella rispecchiato nella rotta, perché il
 * rifiuto arrivi sotto il campo invece che come un 500 del database. Il secondo è
 * `erroreSenzaLaRiga`: chiude la CLASSE invece del caso, per i CHECK che un domani
 * nessuno rispecchierà.
 *
 * ⚠️ QUI C'ERA UN PRECEDENTE CITATO CHE NON ESISTE PIÙ, ed è il motivo per cui la
 * frase è stata riscritta: diceva «esattamente come già si fa per il tetto di 200
 * caratteri di `documento_path`». Quel controllo è stato CANCELLATO lo stesso giorno,
 * nello stesso lavoro (`percorso-documento.ts`, `DOC_MAX_LUNGHEZZA`: «NON È PIÙ UN
 * CONTROLLO DI `percorsoDocumentoAmmesso` … una mutazione ha dimostrato che era codice
 * morto»). Citare come precedente un presidio che si è appena tolto è il modo in cui
 * un commento comincia a raccontare un prodotto diverso da quello che c'è —
 * `DOC_MAX_LUNGHEZZA` oggi agisce negli schemi `zod` di `?doc=` delle due rotte admin,
 * che è un'altra porta e un altro meccanismo.
 *
 * ── DOVE ANDREBBE LA VERSIONE GENERALE (segnalato, non fatto) ──────────────
 *
 * Il controllo di calendario è di `validateField` (`@/lib/forms/validate-fields`):
 * riguarda OGNI campo `date` di OGNI modulo pubblico, non questi due. È un file
 * condiviso di un altro elemento, quindi sta nel rapporto e non qui.
 */

/** Il limite inferiore che la colonna dichiara, in un posto solo. Stretto: `>`. */
const DOC_EXPIRY_MINIMO = '1990-01-01'

/**
 * La data esiste sul calendario?
 *
 * Il round-trip su `toISOString()` è l'unica verifica che se ne accorge: il parser
 * ISO di JavaScript rifiuta i componenti fuori intervallo (`2030-02-31` → `NaN`), e
 * il confronto con la stringa di partenza chiude anche le forme che il parser
 * accetterebbe allargando (`+02030-01-01`). Verificato con node: `2024-02-29` passa
 * perché il 2024 è bisestile, `2025-02-29` no.
 */
function eDataDiCalendario(valore: string): boolean {
  const d = new Date(`${valore}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valore
}

/**
 * I rifiuti sulle date, nella STESSA FORMA PIATTA di `validatePage` per essere fusi
 * nella sua mappa: chi compila deve vedere tutti i campi sbagliati insieme, non uno
 * per invio.
 *
 * Si guardano i campi `date` del TEMPLATE e non due nomi ribattuti: il giorno in cui
 * il modulo guadagnerà una terza data questa funzione la coprirà senza essere
 * toccata, e una copia dei nomi qui dentro sarebbe la copia che diverge.
 *
 * ⚠️ Su un campo VUOTO non si scrive niente: l'obbligatorietà l'ha già detta
 * `validateField`, e un secondo messaggio sullo stesso campo direbbe a una persona
 * che quello che non ha scritto è scritto male.
 */
function dateNonValide(dati: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of PERSONALE_FIELDS) {
    if (f.type !== 'date') continue
    const v = testo(dati[f.id])
    if (v === null) continue
    if (!eDataDiCalendario(v)) {
      out[f.id] = 'Questa data non esiste sul calendario: ricontrollala'
      continue
    }
    // ⚠️ IL LIMITE È SOLO INFERIORE, e la ragione è scritta nella migrazione: un
    // CHECK sul futuro rifiuterebbe esattamente le righe per cui l'allarme di
    // scadenza esiste — il documento GIÀ SCADUTO dev'essere registrabile, altrimenti
    // la Segreteria non può nemmeno annotare il problema che deve risolvere.
    //
    // Confronto fra STRINGHE e non fra `Date`: due date ISO `YYYY-MM-DD` della stessa
    // larghezza si ordinano lessicograficamente come cronologicamente, e così il
    // confronto è lo stesso che fa Postgres, `>` stretto compreso — con `>=` la rotta
    // ammetterebbe `1990-01-01`, che la tabella rifiuta.
    if (f.id === 'document_expiry' && !(v > DOC_EXPIRY_MINIMO)) {
      out[f.id] = 'Controlla l’anno di scadenza: dev’essere successivo al 1990'
    }
  }
  return out
}

export const POST = withRoute('iscrizione/personale:POST', async (request: NextRequest) => {
  try {
    // ── 1. IL TETTO, PRIMA DI LEGGERE IL CORPO ──────────────────────────────
    //
    // ⚠️ IL TETTO CONTA GLI INDIRIZZI IP, MA LA RAGIONE DEVE PARLARE DI QUESTA
    // PORTA — ed è qui che la prima stesura aveva sbagliato. Diceva «tre l'ora, come
    // Lavora con noi: una maestra compila la propria anagrafica una volta, non tre»,
    // che è un ragionamento sulla PERSONA applicato a un contatore per RETE. Sul
    // gemello le due cose coincidono: una candidatura spontanea arriva da casa, una
    // per indirizzo. Qui no. `personale-template.ts` dichiara il modo previsto di
    // usare questo modulo — «la Segreteria manda il link alle maestre in servizio» —
    // cioè più dipendenti che compilano lo stesso pomeriggio dal wifi della sede,
    // dietro un solo NAT. Con tre l'ora, dalla quarta in poi prendevano un 429
    // («Troppe richieste. Riprova più tardi») indistinguibile da un servizio rotto,
    // e riprovando restavano ferme: il caso d'uso dichiarato che sbatte contro la
    // propria difesa.
    //
    // VENTI, E IL NUMERO È MISURATO. In produzione, l'11/08/2026:
    //   Giugliano 13 account di personale (8 educator, 2 admin, 1 segreteria,
    //   1 coordinatrice, 1 cuoca) · Aversa 2 · Cesa 2.
    // La sede più grande sta in tredici, e il modulo esiste PROPRIO perché le altre
    // non sono nel sistema: venti coprono l'intera sede in un pomeriggio, con margine
    // per chi sbaglia un campo e ricompila. Restano comunque sotto il tetto del
    // modulo pubblico d'iscrizione (5 ogni 10 minuti = 30 l'ora), che dalla stessa
    // porta anonima riceve i dati di famiglie vere.
    //
    // E ciò che questo tetto NON è: la difesa di questa porta. Quelle sono l'esca,
    // l'avviso alla Segreteria a ogni invio, la pratica che non è né un account né
    // l'anagrafica, e il registro dei caricamenti (punto 9-bis). Un tetto per IP su
    // un modulo che si compila in gruppo dietro un NAT può solo scegliere quale dei
    // due errori fare, e fra respingere una maestra vera e ammettere un invio in più
    // la scelta è dichiarata.
    //
    // ⚠️ `rateLimit` degrada a un contatore IN MEMORIA e PER ISTANZA quando il
    // contatore su Postgres non risponde (vedi la testata di `rate-limit.ts`): in
    // quel caso il tetto reale è N × 20, con N istanze calde. Questo alza il COSTO di
    // un abuso, non lo azzera, ed è scritto qui perché nessuno legga «20» come una
    // promessa.
    const rl = await rateLimit(`pratiche-personale:${clientIp(request)}`, {
      limit: TETTO_INVII_ORA,
      windowMs: 60 * 60 * 1000,
    })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Troppe richieste. Riprova più tardi.', codice: 'TROPPE_RICHIESTE' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
      )
    }

    // ── 2. ZOD ──────────────────────────────────────────────────────────────
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const dati = b.data.data as Record<string, unknown>

    // ── 3. L'ESCA ───────────────────────────────────────────────────────────
    //
    // Un campo che una persona non vede e non compila. Se arriva pieno, chi ha
    // mandato la richiesta non stava guardando il modulo.
    //
    // La risposta è un 400 con un codice, NON un finto 201: un successo inventato è
    // una bugia scritta in grande — direbbe «ricevuta» quando non c'è nessuna riga, e
    // il giorno in cui l'esca scattasse per errore su una persona vera nessuno lo
    // saprebbe mai. Il 400 non dice però *perché*: la frase è quella generica del
    // guasto, così l'esca non si autodenuncia.
    const esca = testo(b.data.sito_web) ?? testo(b.data.honeypot)
    if (esca !== null) {
      logEvento('personale', 'warn', { operazione: OPERAZIONE, esito: 'honeypot' })
      return NextResponse.json(
        { error: 'Non siamo riusciti a registrare i dati.', codice: 'PRATICA_NON_INVIATA' },
        { status: 400 },
      )
    }

    const supabase = await createAdminClient()

    // ── 4. RI-VALIDAZIONE SERVER DEI CAMPI ──────────────────────────────────
    //
    // Il wizard valida già, con QUESTE stesse funzioni. La ripetizione non è
    // ridondanza: un invio fatto fuori dal wizard non esegue una riga di codice del
    // client, e questa è l'ultima difesa prima che un dato malformato arrivi al
    // database (una provincia per esteso in una `varchar(2)` è già successa, sul
    // modulo pubblico d'iscrizione).
    //
    // ⚠️ E `validatePage` DA SOLA NON BASTA SULLE DATE. Su un campo `date` applica la
    // sola forma ISO, che accetta `9999-99-99` e — peggio — le date che la tabella
    // rifiuta con un `23514`: la ragione per esteso, con la misura, sta nella testata
    // di `dateNonValide`. Le due mappe si FONDONO invece di essere due rifiuti in fila,
    // così chi compila vede tutti i campi sbagliati insieme; `validatePage` è messa
    // dopo perché su un campo che entrambe nominassero «Campo obbligatorio» è la cosa
    // più utile da leggere.
    const normalizzati = normalizzaRecord(dati)
    const campi = {
      ...dateNonValide(normalizzati),
      ...validatePage(PERSONALE_FIELDS, normalizzati),
    }
    if (Object.keys(campi).length > 0) {
      // Nel log SOLO gli id dei campi, mai i valori.
      logEvento('personale', 'warn', {
        operazione: OPERAZIONE,
        esito: esitoConElenco('campi-non-validi', Object.keys(campi)),
        n: Object.keys(campi).length,
      })
      return NextResponse.json(
        {
          error: 'Alcuni campi non sono validi. Controlla i dati e riprova.',
          codice: 'PRATICA_NON_INVIATA',
          // Forma PIATTA (`idCampo → messaggio`): il modulo non ha né record
          // ripetuti né pagine, e una struttura annidata costringerebbe
          // l'interfaccia a disfarla per niente.
          campi,
        },
        { status: 400 },
      )
    }

    // L'email normalizzata, presa UNA VOLTA SOLA e dalla stessa fonte che finirà
    // nell'INSERT (`costruisciRiga` fa esattamente `testo(normalizzati.email)` su
    // questo campo). Serve al punto 9-bis per riconoscere il secondo invio della
    // stessa persona, e deve essere lo STESSO valore che l'indice unico confronterà:
    // due normalizzazioni parallele possono divergere, un valore solo no. È
    // obbligatoria nel template, quindi qui — dopo `validatePage` — non può essere
    // vuota; il `?? ''` è la forma, non un ripiego semantico.
    const emailNormalizzata = testo(normalizzati.email) ?? ''

    // ── 5. IL CODICE FISCALE, PRIMO LIVELLO: È SCRITTO BENE? ────────────────
    //
    // Blocca (vedi la testata di `MESSAGGIO_CF`). Il motivo NON esce nel log come
    // testo ma come enumerato — `cf-checksum`, `cf-giorno` — così si può contare in
    // SQL quale tipo di refuso arriva davvero, senza che il codice ci finisca dentro:
    // sedici caratteri senza spazi sono un enumerato perfetto, e `redact()` li
    // riconosce e li redige solo grazie a `FORMA_CODICE_FISCALE`. Non ci si appoggia
    // a quella rete: qui il valore non si scrive proprio.
    const cf = testo(normalizzati.fiscal_code)
    const esitoCf = validaCodiceFiscale(cf)
    if (!esitoCf.valido) {
      const motivo = esitoCf.motivi[0] ?? 'forma'
      logEvento('personale', 'warn', {
        operazione: OPERAZIONE,
        esito: `codice-fiscale-non-valido-${motivo}`,
      })
      return NextResponse.json(
        {
          error: 'Alcuni campi non sono validi. Controlla i dati e riprova.',
          codice: 'PRATICA_NON_INVIATA',
          campi: { fiscal_code: MESSAGGIO_CF[motivo] },
        },
        { status: 400 },
      )
    }

    // ── 5-bis. SECONDO LIVELLO: È DI QUESTA PERSONA? ────────────────────────
    //
    // Non blocca, e la risposta li riporta come `avvisi` perché il modulo li mostri
    // accanto ai campi discordanti. Il valore si calcola QUI, prima dell'INSERT,
    // apposta: dipende solo dai dati inviati, quindi è lo stesso nel percorso felice
    // e nel ramo del doppio invio — ed è la condizione perché le due risposte abbiano
    // la STESSA FORMA (vedi il blocco `23505`). Una `avvisi` presente solo sul primo
    // invio sarebbe essa stessa l'oracolo di enumerazione che quel ramo esiste per
    // togliere.
    const coerenza = verificaCoerenza(cf, {
      nome: testo(normalizzati.nome),
      cognome: testo(normalizzati.cognome),
      sesso: testo(normalizzati.gender),
      dataNascita: testo(normalizzati.birth_date),
      codiceBelfiore: testo(normalizzati.codice_belfiore_nascita),
    })
    const avvisi = coerenza.motivi

    // ── 6. I CONSENSI ───────────────────────────────────────────────────────
    //
    // Tre PRESE VISIONE obbligatorie e nessun consenso al trattamento, ed è una
    // decisione argomentata in `personale-template.ts`: fra datore e dipendente il
    // potere è squilibrato per presunzione, e un consenso che non si può rifiutare
    // senza mettere a rischio il rapporto non è libero (art. 7 §4 e cons. 43) — cioè
    // non vale nulla. Quello che serve, e che qui è obbligatorio, è l'informativa al
    // punto di raccolta (art. 13) e la prova che sia stata data.
    //
    // La verifica sta QUI e non solo nel wizard, per la stessa ragione del punto 4.
    const consensiMancanti = consensiObbligatoriMancanti(PAGINA_CONSENSI, dati)
    if (consensiMancanti.length > 0) {
      // Con TRE consensi obbligatori il tetto dei 64 caratteri di `FORMA_ENUMERATO` si
      // supera già con due id (`consensi-mancanti-dichiarazione_veridicita.presa_…`):
      // senza `esitoConElenco` il valore uscirebbe `[redatto:str/N]` e nel log non
      // resterebbe nemmeno la parola «consensi-mancanti».
      logEvento('personale', 'warn', {
        operazione: OPERAZIONE,
        esito: esitoConElenco('consensi-mancanti', consensiMancanti),
        n: consensiMancanti.length,
      })
      return NextResponse.json(
        {
          error: 'Per proseguire è necessario spuntare tutte le dichiarazioni.',
          codice: 'PRATICA_NON_INVIATA',
          consensi: consensiMancanti,
        },
        { status: 400 },
      )
    }

    // ── 7. I PERCORSI DELLE SCANSIONI — UNO PER FACCIA ──────────────────────
    //
    // Il gate sta QUI e non in `costruisciRiga`, perché è un rifiuto che deve arrivare
    // a chi compila SOTTO IL CAMPO, come gli altri, e non una riga scartata in
    // silenzio. La ragione per esteso è nella testata di `percorsoDocumentoAmmesso`.
    //
    // ⚠️ I CAMPI SI LEGGONO DA `COLONNE_DOCUMENTO`, NON PER NOME. Si chiama «colonne»
    // perché è di là che serve — nei gate che interrogano il database — ed è lo stesso
    // elenco: in questo repo `PERSONALE_FIELDS[].id` È il nome della colonna, e la
    // migrazione `20260812194501` lo dichiara come la ragione per cui ha rinominato
    // invece di affiancare. Qui quegli id sono le chiavi del payload.
    //
    // È la correzione di un difetto vero: dal 12/08/2026 il documento è due facce, il
    // campo del template non si chiama più `documento_path`, e questa riga leggeva
    // ancora quel nome.
    // `testo(normalizzati.documento_path)` restituiva `null` a ogni richiesta, quindi
    // la condizione qui sotto era sempre falsa: il gate ESISTEVA e non girava mai.
    // Misurato forzando la funzione a `return true` — porta spalancata a
    // `documenti/../../etc/passwd` — e ottenendo dai test del chiamante gli stessi
    // identici numeri del codice buono. Un elenco derivato dal template non può
    // ripetere quell'errore: il rinomino lo segue da solo.
    //
    // ⚠️ NEL LOG NON VA IL PERCORSO: è la chiave che apre il documento d'identità di
    // una persona. Si registra che è stato respinto, non che cosa era — e nemmeno
    // QUALE faccia, che sarebbe già un frammento in più su un tentativo.
    const percorsiDocumento = COLONNE_DOCUMENTO.map((campo) => testo(normalizzati[campo])).filter(
      (percorso): percorso is string => percorso !== null,
    )
    for (const percorso of percorsiDocumento) {
      if (!percorsoDocumentoAmmesso(percorso)) {
        logEvento('personale', 'warn', {
          operazione: OPERAZIONE,
          esito: 'documento-path-non-ammesso',
        })
        return rispostaDocumentoNonValido()
      }
    }

    // LE DUE FACCE NON POSSONO ESSERE LO STESSO OGGETTO.
    //
    // La migrazione `20260812194501` lo dichiara come un fatto — «I due percorsi non
    // possono essere uguali — lo impone la route, non il database, perché il confronto
    // serve PRIMA di scrivere» — e questa è la riga che lo impone. Senza, il modo più
    // facile di «finire» il modulo sarebbe allegare due volte la stessa foto: la
    // Segreteria si ritroverebbe una pratica completa con il retro mancante e nessuna
    // riga che lo dica. Il database non può accorgersene (nessun vincolo lega due
    // colonne di una riga sola) e il client non basta: qui si entra anche senza di lui.
    if (new Set(percorsiDocumento).size !== percorsiDocumento.length) {
      logEvento('personale', 'warn', {
        operazione: OPERAZIONE,
        esito: 'documento-facce-uguali',
      })
      return rispostaDocumentoNonValido()
    }

    // ── 8. LA PROVA DELL'INFORMATIVA ────────────────────────────────────────
    //
    // Stessa forma di `enrollment_submissions.consents_log`: il TESTO mostrato si
    // congela dentro la riga, perché la prova deve dire *cosa* è stato accettato, non
    // solo *che* qualcosa è stato accettato. Fra dieci anni si saprà a quale
    // formulazione la persona ha risposto — e se quella formulazione prometteva
    // davvero i dodici mesi di conservazione della copia del documento che il cron
    // applicherà.
    //
    // Le due versioni vengono dalle COSTANTI SERVER, mai dal client: un client datato
    // o manomesso potrebbe dichiarare una versione arbitraria, e la prova varrebbe
    // zero.
    const accettatoIl = new Date().toISOString()
    const consentsLog = {
      versione_informativa: VERSIONE_PRIVACY,
      versione_consensi: CONSENSI_PERSONALE_VERSIONE,
      accettato_il: accettatoIl,
      ...extractRequestMeta(request),
      blocchi: estraiConsensi(PAGINA_CONSENSI, dati, accettatoIl),
    }

    // ── 9. LA SEDE ──────────────────────────────────────────────────────────
    //
    // Si accetta `scuola_id` SOLO se compare fra le sedi REALI e ATTIVE. `sediReali`
    // esclude la sede fittizia del seed E2E — che in produzione ESISTE, con quattro
    // utenti collegati — e applica il flag `scuole.attiva`, così l'elenco che il
    // modulo mostra e il predicato che accetta sono lo stesso.
    //
    // Nessun default silenzioso, mai. Le sedi sono tre: una route che «indovina»
    // archivia l'anagrafica nel plesso sbagliato senza che nessuno se ne accorga.
    const { reali, error: erroreSedi } = await sediReali(supabase, OPERAZIONE)
    if (erroreSedi) {
      // `sediReali` ha già loggato a livello `error`. Senza l'elenco delle sedi non si
      // può validare niente: è un guasto nostro, non un dato sbagliato di chi compila
      // — quindi 500 e non 400.
      return NextResponse.json(
        { error: 'Non siamo riusciti a registrare i dati.', codice: 'PRATICA_NON_INVIATA' },
        { status: 500 },
      )
    }
    const scuolaId = b.data.scuola_id
    if (!reali.some((s) => s.id === scuolaId)) {
      logEvento('personale', 'warn', { operazione: OPERAZIONE, esito: 'sede-non-valida' })
      return NextResponse.json(
        { error: 'Indicare la sede in cui si lavora.', codice: 'SEDE_DA_SPECIFICARE' },
        { status: 400 },
      )
    }

    // ── 9-bis. I PERCORSI ESISTONO, E SONO ANCORA DI NESSUNO ────────────────
    //
    // Una lettura sola PER TUTTE LE FACCE, l'ultima prima di scrivere, che risponde a
    // due domande che il gate di FORMA (punto 7) non può porsi: gli oggetti sono
    // passati davvero dalla nostra porta di caricamento, e nessun'altra pratica li
    // nomina già.
    //
    // ⚠️ UNA CHIAMATA SOLA, E IL PLURALE NON È UNO STILE. Con una lettura per faccia,
    // fra la prima e la seconda si apre una finestra in cui l'altra può essere reclamata
    // da qualcun altro; e soprattutto **non esiste la pratica MEZZA documentata**: se
    // anche una sola faccia non è reclamabile, la pratica si respinge tutta. Metterla in
    // tabella con una faccia sola significherebbe una scheda che la Segreteria apre e
    // trova incompleta senza sapere perché — e con l'altra scansione nel bucket senza
    // nessuna riga che la nomini, cioè spazzata entro 24 ore.
    //
    // La seconda è l'invariante che la migrazione `20260811205643` dichiara come un
    // fatto — «Un oggetto, un proprietario: è ciò che impedisce alla retention della
    // pratica di cancellare il file che l'anagrafica sta ancora usando» — e che fino
    // all'11/08/2026 nessuno imponeva: sulle colonne del documento non c'è nessun
    // vincolo di unicità — non ce l'aveva `documento_path` e non ce l'hanno le due
    // colonne che l'hanno sostituita — e due righe con lo stesso percorso significano
    // che la conservazione della prima cancella il documento che la seconda sta ancora
    // usando.
    //
    // ⚠️ STA DOPO IL GATE DI FORMA E DOPO LA SEDE, non prima: quelle due difese non
    // costano niente e respingono il grosso senza toccare il database. E sta PRIMA
    // dell'INSERT perché il rifiuto deve arrivare sotto il campo, non essere una riga
    // scritta e poi rimpianta.
    //
    // ⚠️ E NON BLOCCA SE IL REGISTRO NON RISPONDE (`degradato`): è un presidio IN PIÙ
    // sopra il gate di forma, e non deve diventare un modo nuovo di perdere
    // l'anagrafica di una persona vera per un guasto che è nostro. La scelta è sicura
    // perché chi bussa non può PROVOCARE quel guasto: nessun parametro della
    // richiesta decide se quella query riesce.
    //
    // ⚠️ MA IL REGISTRO ASSENTE È UN ALTRO STATO, E LÌ SI BLOCCA (`assente`). Fino al
    // 12/08/2026 i due erano indistinguibili e il fail-open valeva per entrambi, con
    // una giustificazione che due misure hanno smontato: lo stato «tabella assente»
    // è quello della PRODUZIONE di oggi (`pg_class`: `caricamenti_personale` assente,
    // bucket `documenti_personale` presente), non della CI — e sulla CI quel ramo non
    // ci si arriva mai, perché il punto 9 qui sopra esclude la sede E2E e risponde 400
    // prima. In quello stato nessuna persona vera PUÒ avere un percorso valido: la
    // rotta di upload, davanti allo stesso codice d'errore, ritira l'oggetto e
    // risponde 500. Accettare sulla sola forma non proteggeva nessuno e ammetteva un
    // percorso INVENTATO — la forma sta scritta in un repository pubblico — cioè una
    // pratica «completa» che punta a un oggetto inesistente. La ragione per esteso, e
    // le due misure, stanno nella testata di `caricamentiReclamabili`.
    //
    // ⚠️ E HA UN'ECCEZIONE SOLA, che non è una comodità ma la riparazione di un
    // difetto misurato: uno dei percorsi può essere già di una pratica VIVA DI QUESTA
    // STESSA PERSONA, cioè può essere il secondo invio dello stesso modulo. Senza
    // l'eccezione quel caso usciva con un 400 sul campo del documento — l'unico campo
    // che non aveva niente di sbagliato — mentre la pratica era stata ricevuta, e il
    // ramo `23505` (che risponde 201 e avvisa la Segreteria) non veniva mai raggiunto.
    // La ragione per esteso, e il residuo che l'eccezione lascia leggibile, stanno
    // nella testata di `documentiDiUnaPraticaViva`.
    let caricamentiDaCollegare: string[] = []
    let riusaIlProprioDocumento = false
    if (percorsiDocumento.length > 0) {
      const reclamo = await caricamentiReclamabili(supabase, percorsiDocumento, OPERAZIONE)
      if (!reclamo.ammesso) {
        riusaIlProprioDocumento = await documentiDiUnaPraticaViva(
          supabase,
          percorsiDocumento,
          emailNormalizzata,
          scuolaId,
        )
        if (!riusaIlProprioDocumento) {
          // Nel log l'esito, MAI il percorso: è la chiave che apre il documento
          // d'identità di una persona. E l'esito è distinto da quello del punto 7 —
          // «non ha la forma» e «non esiste o è già di un altro» sono due fatti diversi
          // per chi legge `app_log`, mentre per chi ha mandato la richiesta la risposta
          // è la stessa (vedi `rispostaDocumentoNonValido`).
          //
          // `registro_assente` rende la riga leggibile DA SOLA: senza, questo rifiuto e
          // quello di un percorso davvero inventato sono lo stesso esito, e il giorno in
          // cui la migrazione manca in produzione si leggerebbe «mi mandano percorsi
          // falsi» invece di «ho chiuso la porta a tutti». È un booleano, quindi passa
          // per tipo dalla lista bianca di `redact()` senza aggiungere nessuna chiave.
          logEvento('personale', 'warn', {
            operazione: OPERAZIONE,
            esito: 'documento-path-non-reclamabile',
            scuola_id: scuolaId,
            registro_assente: reclamo.assente,
            // QUANTE facce sono cadute, mai QUALI e mai i loro percorsi: è un numero,
            // quindi passa `redact()` per tipo, e distingue in `app_log` «una faccia
            // inventata su due» da «tutte». Nella RISPOSTA quella distinzione non esce
            // — sarebbe l'oracolo che `rispostaDocumentoNonValido` esiste per togliere —
            // ma chi indaga alle tre di notte non è chi sta tentando.
            n_mancanti: reclamo.mancanti.length,
          })
          return rispostaDocumentoNonValido()
        }
        // `warn` e non `info`, per la stessa ragione dell'esito `duplicata`: non è
        // rumore, è l'unica riga che dice che un percorso GIÀ DI QUALCUNO è stato
        // ripresentato — e con tre plessi magari a un'altra porta. Un `warn` si
        // persiste per livello, quindi resta interrogabile in SQL il giorno in cui
        // qualcuno chiede quante volte è successo e da dove.
        logEvento('personale', 'warn', {
          operazione: OPERAZIONE,
          esito: 'documento-path-della-propria-pratica',
          scuola_id: scuolaId,
        })
      } else {
        // ⚠️ NESSUNA GUARDIA SUL `degradato`, e la sua assenza è la correzione di un
        // secondo difetto misurato. C'era `if (!reclamo.degradato)`: quando la lettura
        // del registro falliva per un guasto TRANSITORIO (tabella presente, query in
        // errore — riprodotto con `57014`) la pratica veniva accettata ma il
        // collegamento non si tentava MAI. Esito: `201`, `documento_path` scritto nella
        // riga, riga di registro ancora `pratica_id = null` — quindi la spazzata
        // raccoglie quell'oggetto e lo toglie dal bucket entro 24 ore mentre la pratica
        // (e, dopo l'approvazione, l'anagrafica) continua a nominarlo. La scansione del
        // documento d'identità di una persona vera spariva dall'archivio senza che
        // nessuna riga di log dicesse quale pratica l'avesse persa: l'unico log che
        // porta l'`entita_id` è proprio quello che non veniva emesso.
        //
        // E qui dentro non ci si arriva mai col registro ASSENTE — quello esce da
        // `ammesso: false` — quindi l'unico modo di tentare un collegamento «al buio» è
        // un guasto TRANSITORIO della lettura, che è esattamente il caso in cui il
        // collegamento va tentato: la scrittura può riuscire dove la lettura ha fallito.
        // Il log di `collegaCaricamenti` porta l'`entita_id` che quello del reclamo non
        // ha — cioè non è la ripetizione dello stesso fatto, è il fatto detto per la
        // prima volta con dentro la pratica a cui si riferisce.
        //
        // ⚠️ TUTTE LE FACCE, non la prima: `reclamo.ammesso` è vero solo quando lo sono
        // tutte, e lasciarne indietro una vorrebbe dire consegnarla alla spazzata entro
        // 24 ore mentre la pratica la nomina ancora.
        caricamentiDaCollegare = percorsiDocumento
      }
    }

    // ── 10. L'INSERIMENTO ───────────────────────────────────────────────────
    //
    // `gradi` deduplicato E rifiltrato contro `GRADI_OPTIONS`. Lo `z.enum` ha già
    // respinto i valori fuori elenco: il secondo filtro costa una riga e chiude
    // l'unica strada che resterebbe se un domani lo schema venisse allargato — un
    // valore fuori dall'enum di Postgres non fa un 400, fa `22P02`, cioè un 500 opaco.
    const gradi = [...new Set((dati.gradi as string[]) ?? [])].filter((g) => GRADI_VALIDI.has(g))
    const riga: Record<string, unknown> = {
      ...costruisciRiga(normalizzati, gradi),
      scuola_id: scuolaId,
      consents_log: consentsLog,
    }

    let { data: creata, error } = await supabase
      .from('pratiche_personale')
      .insert(riga)
      .select('id')
      .single()

    // ── COLONNE ASSENTI (`PGRST204`/`42703`) — UN CICLO, NON UN SOLO RITENTATIVO ──
    //
    // Il DB E2E della CI non è migrato: qui il degrado dev'essere DICHIARATO. Si
    // ritenta senza la colonna caduta — un'anagrafica persa perché manca una colonna
    // sarebbe peggio — ma NON in silenzio, e il `warn` la NOMINA: «si è degradato»
    // senza dire *cosa* è caduto è un log che non serve a nessuno il giorno in cui a
    // cadere è la prova del consenso.
    //
    // ── ⛔ E IL DOCUMENTO NON SI DEGRADA MAI ──────────────────────────────────
    //
    // La prima guardia del ciclo non è il tetto: è `COLONNE_INDEGRADABILI`. Se a
    // mancare è una faccia del documento, qui NON si toglie e NON si ritenta — si
    // risponde **503 `PRATICHE_NON_DISPONIBILI`**, che è il 503 che la migrazione
    // `20260812194501` prescrive per esteso («rumoroso e reversibile») e lo stesso
    // che questa rotta già dà quando la tabella manca del tutto. Il perché sta nel
    // riquadro di `COLONNE_FACOLTATIVE`; la conseguenza pratica è che nessuna riga
    // nasce, quindi gli oggetti già caricati restano senza proprietario e la spazzata
    // li toglie entro 24 ore, invece di restare per sempre in un bucket senza che
    // nessuna riga li nomini.
    //
    // ── ⚠️ PERCHÉ UN CICLO, E COS'È SUCCESSO CON UN `if` SOLO ─────────────────
    //
    // Questo blocco toglieva UNA colonna e ritentava UNA volta. Con due colonne nuove
    // il secondo `PGRST204` sopravviveva al ramo e cadeva nel generico: **500** su una
    // rotta che dichiara di degradare. Il ciclo serve ancora — le colonne facoltative
    // possono tornare a essere più d'una — ma il caso che l'aveva motivato (le due
    // facce assenti sul DB della CI) adesso NON passa di qui: esce dal 503.
    //
    // Il tetto è il numero di colonne che su un database indietro possono
    // legittimamente mancare — non un `while (true)`: un ciclo senza tetto, davanti a un
    // database che risponde `PGRST204` per una ragione che non sappiamo leggere,
    // martellerebbe la tabella una volta per colonna della riga. Il tetto si valuta
    // DOPO la guardia sul documento, perché un tetto esaurito non deve poter
    // trasformare una faccia mancante in un 500 muto che non nomina la migrazione.
    //
    // Si esce anche quando la colonna da togliere non c'è più nella riga ridotta: senza
    // quella guardia, un messaggio irriconoscibile due volte di fila farebbe ripartire
    // lo STESSO INSERT identico, cioè lo stesso errore, fino al tetto.
    let ridotta = riga
    let giro = 0
    while (error && CODICI_COLONNA_ASSENTE.includes(codiceDi(error))) {
      // L'elenco su cui si riconosce il nome è quello della riga RIDOTTA, non della
      // riga di partenza: una colonna già caduta non deve poter essere nominata due
      // volte da un messaggio che si ripete.
      const colonna =
        colonnaMancante((error as { message?: string }).message, Object.keys(ridotta)) ??
        'consents_log'

      if (COLONNE_INDEGRADABILI.includes(colonna)) {
        // `error` e non `warn`: è una configurazione mancante in produzione, cioè un
        // incidente (AGENTS §4), ed è l'unica riga che dice PERCHÉ un modulo pubblico
        // ha smesso di ricevere. Il nome della colonna e quello della migrazione
        // bastano a ripararlo; il percorso della scansione non c'è, come ovunque qui.
        logEvento('personale', 'error', {
          operazione: OPERAZIONE,
          esito: `colonna-documento-assente-${colonna}`,
          error_code: codiceDi(error),
          scuola_id: scuolaId,
          msg:
            `${OPERAZIONE}: il database non ha la colonna «${colonna}». La pratica NON è ` +
            `stata scritta di proposito: inserirla senza quella colonna perderebbe la ` +
            `scansione del documento d'identità in silenzio. Applicare la migrazione ` +
            `20260812194501 (documento_fronte_retro) su questo database.`,
        })
        return NextResponse.json(
          {
            error: 'In questo momento non possiamo registrare i dati del personale.',
            codice: 'PRATICHE_NON_DISPONIBILI',
          },
          { status: 503 },
        )
      }

      if (giro >= COLONNE_FACOLTATIVE.length) break
      if (!(colonna in ridotta)) break
      giro++
      // UNA RIGA DI LOG PER COLONNA CADUTA, col suo nome: due degradi in silenzio sono
      // indistinguibili da uno, e il giorno in cui a cadere è la prova del consenso
      // nessuno saprebbe che è successo due volte.
      logEvento('personale', 'warn', {
        operazione: OPERAZIONE,
        esito: `colonna-assente-${colonna}`,
        error_code: codiceDi(error),
      })
      ridotta = { ...ridotta }
      delete ridotta[colonna]
      const ritento = await supabase
        .from('pratiche_personale')
        .insert(ridotta)
        .select('id')
        .single()
      creata = ritento.data
      error = ritento.error
    }

    if (error) {
      const codice = codiceDi(error)

      // ── TABELLA ASSENTE (`PGRST205`/`42P01`) ────────────────────────────
      //
      // È lo stato del database della CI, che non è migrato. Qui NON si finge un 201:
      // una persona a cui si dice «ricevuta» non riprova, e la sua anagrafica non
      // esiste da nessuna parte. Il 503 con `PRATICHE_NON_DISPONIBILI` dice l'unica
      // cosa vera — adesso non possiamo riceverla — e manda alla segreteria, che è
      // l'unica via d'uscita: `PRATICA_NON_INVIATA` inviterebbe a ritentare fra
      // qualche minuto una cosa che non può riuscire.
      if (['PGRST205', '42P01'].includes(codice)) {
        logEvento('personale', 'warn', {
          operazione: OPERAZIONE,
          esito: 'tabella-assente',
          error_code: codice,
        })
        return NextResponse.json(
          {
            error: 'In questo momento non possiamo registrare i dati del personale.',
            codice: 'PRATICHE_NON_DISPONIBILI',
          },
          { status: 503 },
        )
      }

      // ── DOPPIO INVIO (`23505`) ⇒ 201, COME AL PRIMO ─────────────────────
      //
      // L'indice `pratiche_personale_email_viva` è unico su `lower(email)` per gli
      // stati vivi (`pending`, `in_approvazione`), e l'unicità è GLOBALE: una pratica
      // viva vale per l'intera cooperativa, che è un solo datore di lavoro con una
      // sola Direzione che valuta. La migrazione `20260811205643` prescrive la stessa
      // traduzione, e con queste parole: «NON con un 409 … il modulo risponde 201 come
      // al primo invio … e il duplicato si registra in `app_log` con esito
      // `duplicata`».
      //
      // LA RAGIONE, che i due file condividono: qui non c'è nessun login, e chiunque —
      // digitando l'indirizzo di una maestra — leggerebbe da un 409 se quella persona
      // LAVORA in questa scuola. Per chi è impiegata altrove è precisamente
      // l'informazione che non deve uscire, e nessuno la cercherebbe apposta: la si
      // troverebbe per caso.
      //
      // ── E IL 201 NON È UNA BUGIA ────────────────────────────────────────
      // La pratica ESISTE davvero ed è davvero in valutazione: la risposta che chi ha
      // premuto «invia» stava cercando è «ricevuta», e questa è vera. Si restituisce
      // l'id della riga VIVA, non `null`, e con LA STESSA FORMA del primo invio
      // (`{ id, avvisi }`) — perché una risposta di forma diversa sarebbe essa stessa
      // l'oracolo che si sta togliendo.
      //
      // ── IL LIVELLO È `warn`, E NON `info` ───────────────────────────────
      // Il doppione NON è rumore: dice che quella persona ha bussato una seconda
      // volta, e — con tre plessi e un indice globale — magari a un'altra porta, dove
      // la Segreteria non vedrebbe mai niente. Un `warn` si persiste PER LIVELLO,
      // senza dipendere da nessuna allowlist, quindi resta interrogabile in SQL
      // proprio quando serve: quando la seconda Segreteria chiede «è arrivata?».
      if (codice === '23505') {
        // ⚠️ SI RILEGGE CON LO STESSO VALORE CHE SI È PROVATO A SCRIVERE, non con una
        // seconda normalizzazione che gli somiglia. L'indice confronta `lower(email)`;
        // `.eq` confronta i byte. Prendere il valore da `riga` — l'oggetto passato
        // all'INSERT — chiude il cerchio: due normalizzazioni parallele possono
        // divergere, un valore solo no.
        const emailScritta = typeof riga.email === 'string' ? riga.email : ''
        // Si legge ANCHE `scuola_id`: decide se l'uuid della pratica viva può entrare
        // nell'avviso di QUESTA sede (vedi sotto). Senza, l'unica scelta sarebbe fra
        // tacere l'uuid sempre o farlo uscire sempre.
        const { data: viva, error: erroreViva } = await supabase
          .from('pratiche_personale')
          .select('id, scuola_id')
          .eq('email', emailScritta)
          .in('stato', STATI_VIVI)
          .maybeSingle()
        const rigaViva = viva as { id?: string; scuola_id?: string } | null
        const idVivo = rigaViva?.id ?? null
        const sedeViva = rigaViva?.scuola_id ?? null

        if (erroreViva) {
          // PostgREST non lancia: senza questo controllo il ramo sarebbe muto.
          logEvento('personale', 'warn', {
            operazione: OPERAZIONE,
            esito: 'duplicata-riga-viva-non-letta',
            scuola_id: scuolaId,
          })
        } else if (idVivo === null) {
          // Il `23505` c'è stato ma la pratica viva non si trova: resta un caso vero —
          // fra l'INSERT e questa lettura è stata approvata o rifiutata, e il filtro
          // sugli stati vivi non la vede più. Non si inventa un uuid per far tornare la
          // forma della risposta, e un esito DIVERSO è ciò che distingue «duplicata e
          // tracciata» da «duplicata e persa di vista» quando qualcuno interroga
          // `app_log` un mese dopo.
          logEvento('personale', 'warn', {
            operazione: OPERAZIONE,
            esito: 'duplicata-riga-viva-non-trovata',
            scuola_id: scuolaId,
          })
        }

        // ── E LA SEGRETERIA DI QUESTA SEDE VA AVVISATA LO STESSO ────────────
        //
        // La riparazione sta DIETRO il 201, non davanti: la risposta al chiamante
        // anonimo resta identica al primo invio, perché cambiarla rimetterebbe
        // l'oracolo di enumerazione che si è appena tolto.
        //
        // L'`entitaId` esce SOLO se la pratica viva è di questa sede. Altrimenti
        // sarebbe l'uuid di una pratica che questa Segreteria non ha titolo per aprire,
        // e un link che porta a un diniego è peggio di nessun link.
        const stessaSede = sedeViva !== null && sedeViva === scuolaId
        await avvisaSegreteria(
          supabase,
          scuolaId,
          await staffScuola(supabase, scuolaId, RUOLI_SEGRETERIA),
          {
            corpo: stessaSede ? CORPO_AVVISO.duplicataQui : CORPO_AVVISO.duplicataAltrove,
            entitaId: stessaSede ? idVivo : null,
          },
        )

        logEvento('personale', 'warn', {
          operazione: OPERAZIONE,
          esito: 'duplicata',
          scuola_id: scuolaId,
          entita_id: idVivo,
          // Booleano, quindi passa `redact()` per tipo: è la differenza fra «ha bussato
          // due volte alla stessa porta» e «ha bussato a una porta diversa».
          stessa_sede: stessaSede,
          error_code: '23505',
        })
        return NextResponse.json({ id: idVivo, avvisi }, { status: 201 })
      }

      // ── TUTTO IL RESTO ⇒ 500 ────────────────────────────────────────────
      //
      // Il `message` grezzo di PostgREST è prosa inglese con dentro nomi di colonne e
      // di vincoli — e, sul `23505`, l'indirizzo email. Resta nel LOG (passato come
      // errore, dove la sanificazione lo prende) e non esce mai nella risposta.
      //
      // ⚠️ MA NON L'OGGETTO INTERO: `erroreSenzaLaRiga` toglie `details`, che su una
      // violazione di CHECK o di NOT NULL è la riga di una persona ricopiata per
      // intero — `documento_path` compreso — e che `sanificaMessaggio` non riconosce.
      // La misura e la ragione stanno nella testata di quella funzione.
      logErrore(
        { operazione: OPERAZIONE, stato: 500, evento: 'personale' },
        erroreSenzaLaRiga(error),
      )
      return NextResponse.json(
        { error: 'Non siamo riusciti a registrare i dati.', codice: 'PRATICA_NON_INVIATA' },
        { status: 500 },
      )
    }

    const entitaId = (creata as { id?: string } | null)?.id ?? null

    // ── 10-ter. L'ECCEZIONE DEL 9-bis DOVEVA FINIRE IN UN `23505` ───────────
    //
    // Si è ammesso un percorso GIÀ DI QUALCUNO perché la riga che lo possiede era la
    // stessa con cui l'INSERT stava per collidere: il `23505` era la garanzia, non un
    // augurio. Se l'INSERT è invece RIUSCITO, quella garanzia è saltata — l'unico modo
    // è che fra la verifica e la scrittura la pratica viva sia stata approvata o
    // rifiutata, uscendo dagli stati vivi e liberando l'indice.
    //
    // Adesso due righe nominano lo stesso oggetto, ed è precisamente l'invariante «un
    // oggetto, un proprietario» che la migrazione `20260811205643` dichiara come «ciò
    // che impedisce alla retention della pratica di cancellare il file che l'anagrafica
    // sta ancora usando». Non si può disfare qui (la riga esiste, e cancellarla
    // perderebbe l'anagrafica di una persona vera), ma si può NOMINARE: senza questa
    // riga la finestra sarebbe invisibile, e si scoprirebbe fra 90 giorni da un
    // documento sparito. `error` perché è un guasto, con l'uuid della pratica nuova —
    // che è ciò che lo rende riparabile a mano.
    if (riusaIlProprioDocumento) {
      logEvento('personale', 'error', {
        operazione: OPERAZIONE,
        esito: 'documento-condiviso-con-altra-pratica',
        entita_id: entitaId,
        scuola_id: scuolaId,
        msg:
          `${OPERAZIONE}: la pratica viva che possedeva la scansione è stata evasa fra la ` +
          `verifica e l'INSERT, quindi ora due righe nominano lo stesso oggetto: la ` +
          `conservazione della prima cancellerebbe il file che la seconda usa ancora`,
      })
    }

    // ── 10-bis. GLI OGGETTI ADESSO HANNO UN PROPRIETARIO ────────────────────
    //
    // Da qui in poi quei percorsi non sono più reclamabili da nessun'altra pratica, e
    // la spazzata degli orfani smette di vederli — che è l'esito voluto: adesso c'è una
    // riga che li nomina, e la conservazione di QUELLA riga decide quando i file
    // escono (90 giorni se la pratica non viene approvata, 12 mesi dalla cessazione se
    // diventa anagrafica).
    //
    // ⚠️ UNA CHIAMATA SOLA PER TUTTE LE FACCE, e non una per faccia: con due `update`
    // il fronte può collegarsi e il retro no, e restano due righe di log scoordinate
    // che nessuno sa ricomporre — mentre la spazzata toglie il retro entro 24 ore
    // mentre la pratica lo nomina ancora. `collegaCaricamenti` fa un `update` solo e,
    // quando il conto non torna, emette UNA riga con `n_attesi` e `n_collegati`.
    //
    // Si collega DOPO che la riga esiste, e non prima, perché il collegamento vuole
    // l'uuid della pratica. La conseguenza è dichiarata: fra il reclamo e questo
    // istante c'è una finestra in cui due invii SIMULTANEI con lo stesso percorso
    // passerebbero entrambi. Non è la catena d'attacco del punto 9-bis — chi arriva
    // secondo su un percorso già collegato viene respinto, a meno che quella pratica
    // non sia la SUA — ma il doppio clic della stessa persona, che è precisamente il
    // caso in cui i due invii DEVONO passare entrambi (il secondo prende `23505` e
    // risponde 201 come il primo, vedi sotto).
    //
    // ⚠️ Il ramo `23505` NON arriva qui, e non è una dimenticanza: là nessuna riga
    // nuova è stata scritta, quindi non c'è nessun proprietario da registrare. I
    // percorsi di quel secondo invio restano in sospeso e la spazzata li toglie, che è
    // giusto — sono oggetti che nessuna pratica nominerà mai.
    if (caricamentiDaCollegare.length > 0 && entitaId !== null) {
      await collegaCaricamenti(supabase, caricamentiDaCollegare, entitaId, OPERAZIONE)
    }

    // ── 11. LA SEGRETERIA VA AVVISATA (best-effort) ─────────────────────────
    //
    // Ogni invio avvisa: è il requisito 6 di `personale-template.ts` — «così una
    // pratica falsa si vede il giorno stesso» — ed è l'unica difesa che questa porta
    // anonima ha contro qualcuno che invii l'anagrafica di un'altra persona.
    await avvisaSegreteria(
      supabase,
      scuolaId,
      await staffScuola(supabase, scuolaId, RUOLI_SEGRETERIA),
      { corpo: CORPO_AVVISO.nuova, entitaId },
    )

    // ── 12. IL SUCCESSO SI LOGGA ────────────────────────────────────────────
    //
    // Non c'è una schermata che si riempie a vista e non c'è nessuno che telefona se
    // non arriva niente: una pratica che non parte non se ne accorge nessuno. Senza
    // questa riga «nessun log» significherebbe insieme «nessuna maestra ha compilato»
    // e «il modulo è rotto» — l'ambiguità che ha nascosto per mesi il guasto delle
    // email di credenziali.
    //
    // ⚠️ `personale` è in `EVENTI_PERSISTITI` (`src/lib/logging/logger.ts`) proprio
    // per questa riga: un `info` su un evento fuori allowlist vive qualche giorno sui
    // Runtime Logs di Vercel e poi sparisce, cioè non è interrogabile in SQL.
    logEvento('personale', 'info', {
      operazione: OPERAZIONE,
      esito: 'pratica-ricevuta',
      entita_id: entitaId,
      scuola_id: scuolaId,
      n_gradi: gradi.length,
      // Quante contraddizioni fra codice fiscale e anagrafica sono state SEGNALATE
      // senza bloccare. È un numero, quindi passa `redact()` per tipo, e serve a
      // rispondere «quante pratiche stiamo accettando con un codice che non torna?»
      // senza aprire nessuna riga.
      n_avvisi_cf: avvisi.length,
    })

    return NextResponse.json({ id: entitaId, avvisi }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'personale' }, err)
    return NextResponse.json(
      { error: 'Non siamo riusciti a registrare i dati.', codice: 'PRATICA_NON_INVIATA' },
      { status: 500 },
    )
  }
})
