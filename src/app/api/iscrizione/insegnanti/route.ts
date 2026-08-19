import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { rateLimit, clientIp } from '@/lib/security/rate-limit'
import { parseBody } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { staffScuola } from '@/lib/notifiche/destinatari'
import {
  INSEGNANTE_FIELDS,
  CONSENSI_INSEGNANTI_FIELDS,
  CONSENSI_INSEGNANTI_VERSIONE,
  POSIZIONI_AMMESSE,
  gradiDallePosizioni,
} from '@/lib/forms/insegnanti-template'
import { estraiConsensi, consensiObbligatoriMancanti } from '@/lib/forms/consensi'
import { validatePage, isProvinceField } from '@/lib/forms/validate-fields'
import { percorsoCvAmmesso } from '@/lib/candidature/percorso-cv'
import { campiVisibili } from '@/lib/forms/conditional'
import { normalizzaProvincia } from '@/lib/anagrafiche/province'
import { extractRequestMeta } from '@/lib/fea/signature-log'
import { VERSIONE_PRIVACY } from '@/lib/legal/versioni'
import { sediReali } from '@/lib/scuole/reali'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede } from '@/lib/email/contesto'
import { messaggioConfermaCandidatura } from '@/lib/email/messaggi/conferma-candidatura'
import { inviaCopiaAllaSede } from '@/lib/candidature/copia-alla-sede'
import { formattaIstante } from '@/i18n/config'
import type { FormPage } from '@/types/database.types'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  POST /api/iscrizione/insegnanti — la porta pubblica di «Lavora con noi» ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Chiunque, senza account, propone la propria candidatura come insegnante. È la
 * rotta con la platea più larga e meno assistita di tutta l'applicazione: si
 * compila dal telefono, senza login, e chi la usa non ha una segreteria a cui
 * chiedere che cosa voglia dire quello che ha appena letto.
 *
 * ── PERCHÉ STA SOTTO `/api/iscrizione` ──────────────────────────────────────
 *
 * Non è una comodità di cartella: `/api/iscrizione` è già in `PUBLIC_PREFIXES`
 * (`src/lib/auth/middleware-rules.ts`), quindi il middleware non la reindirizza
 * al login, ed è già dentro il perimetro di `zod-coverage`. Metterla altrove
 * avrebbe voluto dire aggiungere un prefisso pubblico nuovo — cioè allargare la
 * superficie anonima dell'applicazione per una questione di nomi.
 *
 * ── LA FORMA È COPIATA DA `POST /api/iscrizione`, NON REINVENTATA ───────────
 *
 * Ogni pezzo di quella rotta esiste perché un difetto è arrivato in produzione:
 * tetto prima di leggere il corpo, `.loose()` per non perdere le chiavi del
 * wizard, ri-validazione server con le STESSE regole del client, gate dei
 * consensi, `consents_log`, degrado dichiarato su `PGRST204`/`42703`, notifica
 * alla segreteria, successo loggato. Qui cambiano i dati, non l'impianto.
 *
 * ── LA DIFFERENZA CHE CONTA: IL DOPPIO INVIO RISPONDE 201 ───────────────────
 *
 * Vedi il blocco `23505` in fondo. In una riga: un 409 «l'abbiamo già ricevuta»
 * su un modulo anonimo è un oracolo di enumerazione sul lavoro di qualcuno.
 */

/**
 * Il nome della rotta: finisce nella colonna `app_log.operazione` ed è la chiave
 * con cui si chiede «quale route ha fallito».
 *
 * ⚠️ Sotto, in `withRoute(…)`, lo stesso valore è scritto LETTERALE e non con
 * questa costante — non è una svista. Il lock `logging-coverage` legge il
 * SORGENTE e pretende una stringa letterale che combaci col percorso del file
 * (`src/app/api/iscrizione/insegnanti/route.ts` → `iscrizione/insegnanti:POST`):
 * con una costante non vedrebbe nessun `withRoute` affatto. Le due scritture
 * devono coincidere, e se divergono è il lock a dirlo.
 */
const OPERAZIONE = 'iscrizione/insegnanti:POST'

/** L'unico posto in cui si nomina il cockpit di segreteria. */
const LINK_COCKPIT = '/admin/modulistica?tab=candidature'

/** I ruoli che in segreteria leggono le candidature. */
const RUOLI_SEGRETERIA = ['admin', 'coordinator', 'segreteria']

/**
 * I tre corpi dell'avviso alla segreteria, in un posto solo.
 *
 * Sono tre e non uno perché tre sono i fatti che la segreteria deve poter
 * distinguere aprendo la notifica, e nessuno dei tre nomina la persona: un
 * avviso è un oggetto che viaggia su più canali (in-app, push, email) e non è il
 * posto dove si scrive chi si è candidato.
 */
const CORPO_AVVISO = {
  /** Primo invio: c'è una riga nuova, ed è di questa sede. */
  nuova: 'È arrivata una candidatura spontanea dal modulo pubblico «Lavora con noi».',
  /** Doppio invio con la riga viva NELLA STESSA sede: la scheda è già qui. */
  duplicataQui:
    'La stessa persona ha inviato di nuovo la candidatura dal modulo pubblico «Lavora con noi»: ' +
    'la scheda in valutazione è quella collegata a questo avviso.',
  /**
   * Doppio invio con la riga viva ALTROVE (o non leggibile). È il caso che prima
   * non avvisava nessuno: chi cerca lavoro si candida a più plessi della stessa
   * cooperativa, l'indice unico è globale e l'INSERT viene rifiutato.
   */
  duplicataAltrove:
    'È arrivata una candidatura dal modulo pubblico «Lavora con noi» per questa sede. La stessa ' +
    'persona ha già una candidatura in valutazione per la cooperativa: la scheda è nella sede ' +
    'che l’ha ricevuta per prima.',
} as const

/**
 * L'AVVISO ALLA SEGRETERIA, in una funzione sola — e best-effort per scelta.
 *
 * Stava scritto dentro il percorso felice, e questo era metà del difetto: il
 * ramo del doppio invio usciva con `return` PRIMA di arrivarci, quindi rispondeva
 * «ricevuta» senza che nessuno, da nessuna parte, venisse avvisato. Una funzione
 * sola rende impossibile che un ramo nuovo se ne dimentichi per omissione.
 *
 * ⚠️ I DESTINATARI ARRIVANO DA FUORI, e non è un'inversione di comodo. Chiamare
 * `staffScuola(supabase, scuolaId, …)` qui dentro — che è la prima stesura, e
 * sembrava la più pulita — toglie dall'handler l'unica lettura che nomina una
 * sede, e il lock `isolamento-sede-coverage` diventa rosso con
 * `handler-senza-scope su candidature_insegnanti`. Il lock ha ragione a essere
 * severo: la regola d'insieme guarda il CORPO dell'handler, e un presidio di
 * sede nascosto in un helper è un presidio che chi rilegge la route non vede.
 * Perciò la sede si risolve dove la si decide, sotto gli occhi di chi legge il
 * flusso, e qui arriva già risolta.
 *
 * `staffScuola` non lancia mai (cattura e restituisce `[]` loggando, vedi
 * `src/lib/notifiche/destinatari.ts`): chiamarla fuori da questo `try` non
 * riapre la strada a un 500 dopo che la riga è stata scritta.
 *
 * `error` e non `warn` quando fallisce: la riga c'è, il suo annuncio è perso — e
 * una candidatura che nessuno sa di aver ricevuto è una persona che resta senza
 * risposta. Non è un dettaglio saltato, è una consegna mancata.
 */
async function avvisaSegreteria(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  scuolaId: string,
  destinatari: string[],
  avviso: { corpo: string; entitaId: string | null },
): Promise<void> {
  try {
    // ⚠️ La sede è la STESSA di quella con cui sono stati scelti i destinatari:
    // `staffScuola` decide CHI riceve, `scuolaId` dice a chi è indirizzato. Con
    // tre plessi, due sedi diverse fra le due righe consegnerebbero l'avviso di
    // un plesso alla scrivania di un altro senza che nessun controllo se ne
    // accorga — ed è la ragione per cui il collaudo asserisce entrambe.
    await notificaEvento(supabase, {
      tipo: 'candidatura_ricevuta',
      scuolaId,
      utenteIds: destinatari,
      titolo: 'Nuova candidatura ricevuta',
      corpo: avviso.corpo,
      link: LINK_COCKPIT,
      entitaTipo: 'candidatura',
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
 * Le posizioni ammesse, LETTE dal template e non ribattute.
 *
 * Non è pignoleria: `candidature_insegnanti.posizioni` ha un `CHECK` di
 * appartenenza (migrazione `20260814225302`), e un valore fuori elenco non fa un
 * 400 — arriva all'INSERT e prende `23514`, cioè un 500 opaco davanti a una
 * persona che non ha nessuno a cui chiedere. Il template prescrive alla route di
 * FILTRARE contro `POSIZIONI_AMMESSE`, ed è quello che fa lo `z.enum` qui sotto:
 * il rifiuto arriva sotto il campo, prima di toccare il database.
 *
 * Derivato invece che scritto a mano di proposito: se un domani si aggiunge una
 * posizione (qui E nel `CHECK`, con una migrazione), un letterale in questa rotta
 * la respingerebbe in silenzio.
 *
 * ⚠️ QUI NON C'È PIÙ NESSUN `GRADI_AMMESSI`, e non è una semplificazione: le
 * fasce non arrivano più dal client affatto. Prima erano un campo del modulo e
 * questa costante era la difesa contro il `22P02` dell'enum `school_type_enum`;
 * adesso `gradi` lo COSTRUISCE la route con `gradiDallePosizioni()` a partire da
 * valori che questo `z.enum` ha già filtrato. Un'enumerazione in più
 * sorveglierebbe un ingresso che non esiste.
 */
const POSIZIONI_ZOD = POSIZIONI_AMMESSE as [string, ...string[]]

/**
 * Il numero dei plessi reali. Un elenco più lungo di così o è un errore, o è
 * qualcuno che prova a far partire N email con un invio solo: in entrambi i casi
 * la risposta è no. Non è cablato su tre a caso — è `sediReali` che decide chi
 * accetta candidature, e questo è solo il tetto oltre il quale non si guarda
 * nemmeno.
 */
const MAX_SEDI_PER_CANDIDATURA = 3

/**
 * Lo schema d'ingresso.
 *
 * ─── LE SEDI SONO UN ELENCO, dal 2026-08-19 ─────────────────────────────────
 * Una persona può proporsi a più plessi con un invio solo, e ogni plesso valuta
 * per conto suo (`candidature_sedi`). Prima qui c'era `scuola_id`, uno solo.
 *
 * ⚠️ Resta OBBLIGATORIO averne ALMENO UNA, e la rotta resta più severa della
 * sorella `POST /api/iscrizione`, che ammette l'assenza e poi deduce quando la
 * sede è una sola. Le sedi sono tre: dedurre significherebbe archiviare la
 * candidatura nel plesso sbagliato in silenzio, e chi si candida non ha modo di
 * accorgersene.
 *
 * ⚠️ UN ELENCO DI UNO È UN ELENCO, e non ha un ramo suo. È il caso di
 * `?sede=<uuid>`, il link targato, che non è cambiato: quando c'è, il modulo
 * salta il passo di scelta e invia quella sola sede. Un ramo che si percorre
 * quasi sempre e uno che si percorre di rado divergono, e a divergere è sempre
 * quello di rado — cioè quello che nessuno guarda.
 *
 * `data` è `.loose()` come nel modulo d'iscrizione: il wizard può portare chiavi
 * che qui non si conoscono (e che NON finiscono nell'INSERT — vedi `costruisciRiga`).
 */
const postBodySchema = z.object({
  scuole_ids: z
    .array(z.string().uuid({ message: 'Indicare la sede della candidatura' }), {
      error: 'Indicare la sede della candidatura',
    })
    .min(1, 'Indicare la sede della candidatura')
    .max(MAX_SEDI_PER_CANDIDATURA, 'Troppe sedi indicate'),
  data: z
    .object(
      {
        posizioni: z
          .array(z.enum(POSIZIONI_ZOD), { error: 'Indica almeno una posizione' })
          .min(1, 'Indica almeno una posizione'),
      },
      { error: 'Dati della candidatura non validi' },
    )
    .loose(),
  /**
   * L'ESCA. Due nomi, entrambi facoltativi, entrambi da lasciare vuoti.
   *
   * `sito_web` è quello che il modulo rende (nascosto agli occhi e agli screen
   * reader); `honeypot` è accettato come sinonimo perché il costo di riconoscere
   * due nomi è zero e quello di un modulo e una route che non si accordano sul
   * nome è un'esca che non scatta mai — cioè una difesa che sembra esserci.
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
 * L'ESITO DI UN RAMO DI RIFIUTO: un enumerato che ci sta in 64 caratteri.
 *
 * ⚠️ PERCHÉ NON SI CONCATENA E BASTA. `redact()` lascia in chiaro il valore di
 * `esito` solo se rispetta `FORMA_ENUMERATO` (`src/lib/logging/redact.ts`), che
 * impone al massimo 64 caratteri. Misurato sui 13 id di `INSEGNANTE_FIELDS`:
 * `campi-non-validi-` più tutti gli id ordinati è lungo **158** caratteri, e già
 * con **sei** campi non validi si arriva a 78. Sopra il tetto non si perde il
 * dettaglio: si perde TUTTO, perché l'intero valore diventa `[redatto:str/N]` e
 * nel log non resta nemmeno la parola «campi-non-validi». Cioè si perde la
 * classificazione del ramo — e il caso che lo innesca è il modulo spedito quasi
 * vuoto, che è la forma più comune di invio fallito.
 *
 * Qui il prefisso è garantito per costruzione (è corto e viene prima di tutto),
 * gli id entrano finché ci stanno, e i tagliati si CONTANO: `+7` dice che sopra
 * ce n'erano altri sette. Un elenco troncato senza il conteggio direbbe una
 * cosa falsa — che i campi respinti erano quelli e basta.
 *
 * L'alternativa (id in un campo separato) non regge alla misura: `campi_ko` non
 * è una chiave in lista bianca, quindi ogni id uscirebbe `[redatto:str/N]`. La
 * lista bianca sta in un file condiviso e non si allarga per comodità di una
 * rotta.
 */
const ESITO_MAX = 64

function esitoConElenco(prefisso: string, ids: string[]): string {
  const ordinati = [...ids].sort()
  let testo = prefisso
  let messi = 0
  for (const id of ordinati) {
    const candidato = messi === 0 ? `${prefisso}-${id}` : `${testo}.${id}`
    const restanti = ordinati.length - (messi + 1)
    // Il marcatore di taglio si prenota PRIMA di aggiungere: se aggiungere un id
    // lasciasse fuori il `+N`, il valore direbbe di essere completo mentendo.
    const coda = restanti > 0 ? `+${restanti}`.length : 0
    if (candidato.length + coda > ESITO_MAX) break
    testo = candidato
    messi++
  }
  const tagliati = ordinati.length - messi
  return tagliati > 0 ? `${testo}+${tagliati}` : testo
}

/**
 * Normalizza PRIMA di validare. Due campi, due ragioni diverse.
 *
 * ── LE PROVINCE: «Napoli» → «NA», «na» → «NA» ───────────────────────────────
 * La colonna è `varchar(2)`: senza questo passaggio una provincia scritta per
 * esteso arriverebbe al database e verrebbe troncata o rifiutata a valle. Un
 * valore irriconoscibile resta com'è, così `validateField` lo segnala sotto il
 * campo giusto invece di sparire.
 *
 * ── L'EMAIL: minuscola, sempre ──────────────────────────────────────────────
 * L'indice che decide se una candidatura è un doppione è
 * `unique (lower(email)) where stato in ('pending','in_approvazione')`
 * (`20260810094610_candidature_insegnanti.sql`). Se la colonna conservasse le
 * maiuscole digitate, il DATO in tabella e la CHIAVE che lo rende unico
 * sarebbero due cose diverse, e ogni rilettura per email dovrebbe indovinare
 * quale delle due sta guardando — con l'esito che «Ines.Prova@…» prende `23505`
 * ma non si ritrova cercando «Ines.Prova@…», perché in tabella c'è
 * «ines.prova@…». Normalizzando qui, il valore scritto e il valore riletto sono
 * lo stesso per costruzione, e i dati in tabella rispettano l'unicità dichiarata
 * invece di dipendere da una funzione applicata solo dall'indice.
 *
 * Il tipo si legge dal TEMPLATE (`f.type === 'email'`) e non dal nome del campo:
 * un secondo recapito aggiunto domani sarebbe normalizzato senza toccare questa
 * riga — che è l'unico modo in cui una regola del genere sopravvive.
 */
function normalizzaRecord(dati: Record<string, unknown>): Record<string, unknown> {
  const r = { ...dati }
  for (const f of INSEGNANTE_FIELDS) {
    if (f.type === 'email') {
      const v = testo(r[f.id])
      if (v !== null) r[f.id] = v.toLowerCase()
      continue
    }
    if (!isProvinceField(f)) continue
    const grezzo = r[f.id]
    if (grezzo === null || grezzo === undefined || String(grezzo).trim() === '') continue
    const sigla = normalizzaProvincia(grezzo)
    if (sigla) r[f.id] = sigla
  }
  return r
}

/**
 * La riga da inserire, costruita SOLO dai campi del template.
 *
 * Non si fa lo spread di `data`: è `.loose()`, quindi porta con sé le chiavi del
 * wizard (i consensi, per dirne una) e qualunque cosa un client possa aggiungere.
 * Spargerle nell'INSERT vorrebbe dire un `PGRST204` sul primo invio vero — o,
 * peggio, scrivere in una colonna che nessuno aveva deciso di far scrivere a un
 * anonimo.
 */
function costruisciRiga(
  dati: Record<string, unknown>,
  posizioni: string[],
): Record<string, unknown> {
  const riga: Record<string, unknown> = {}
  // I campi VISIBILI dato ciò che è stato scelto. Vedi il blocco al punto 4:
  // `posizione_altro` esiste solo quando «Altro» è spuntato.
  const visibili = new Set(campiVisibili(INSEGNANTE_FIELDS, dati).map((f) => f.id))
  for (const f of INSEGNANTE_FIELDS) {
    if (f.id === 'posizioni') continue
    // ⚠️ UN CAMPO NASCOSTO SCRIVE `null`, NON IL SUO VALORE. Chi spunta «Altro»,
    // scrive «psicomotricista», poi cambia idea e toglie la spunta lascerebbe
    // altrimenti in tabella un mestiere che non ha dichiarato — e la riga
    // verrebbe respinta dal `CHECK` di coerenza
    // (`candidature_insegnanti_posizione_altro_coerente`), cioè un 500 opaco
    // sull'ultimo tocco di un modulo compilato per intero. `null` esplicito e
    // non `undefined`: PostgREST omette le chiavi `undefined`, e su un `UPDATE`
    // — che qui non c'è, ma la funzione non lo sa — omettere non è azzerare.
    if (!visibili.has(f.id)) {
      riga[f.id] = null
      continue
    }
    if (f.type === 'number') {
      const n = Number(String(dati[f.id] ?? '').replace(',', '.'))
      riga[f.id] = testo(dati[f.id]) === null || !Number.isFinite(n) ? null : n
      continue
    }
    riga[f.id] = testo(dati[f.id])
  }
  // `posizioni` SEMPRE esplicito, e mai vuoto: il `CHECK` in tabella è
  // `cardinality(posizioni) >= 1`, che su un array vuoto vale FALSO (a
  // differenza di `array_length`, che vale NULL e quindi PASSA — è il difetto
  // che `gradi` ha avuto per mesi, misurato in produzione il 2026-08-10).
  riga.posizioni = posizioni
  // ── `gradi` NON ARRIVA PIÙ DAL CLIENT: SI DERIVA ──────────────────────────
  //
  // È la colonna che `admin/candidature-insegnanti:PATCH` travasa in
  // `utenti.gradi` all'approvazione, quindi deve restare popolata; ma il suo
  // valore adesso discende dalle posizioni docenti, che lo `z.enum` ha già
  // filtrato. Due conseguenze, e vanno dette:
  //   · il `22P02` dell'enum `school_type_enum` diventa INESPRIMIBILE invece che
  //     difeso — nessuna stringa esterna raggiunge più quella colonna;
  //   · per una candidatura non docente (cuoca, segreteria, collaboratrice,
  //     altro) l'array è VUOTO, e va bene così: una cuoca non ha una fascia
  //     d'età. Il `CHECK` di `gradi` non è stato stretto proprio per questo —
  //     stringerlo respingerebbe le candidature che questo lavoro accoglie.
  riga.gradi = gradiDallePosizioni(posizioni)
  return riga
}

/** Il codice PostgREST/Postgres di un errore che NON è stato lanciato ma restituito. */
function codiceDi(errore: unknown): string {
  return (errore as { code?: string } | null)?.code ?? ''
}

/**
 * Il nome della colonna che il database dice di non avere.
 *
 * Due formulazioni, perché due sono le sorgenti: PostgREST («Could not find the
 * 'x' column of …», `PGRST204`) e Postgres («column "x" of relation …», `42703`).
 * Il nome si accetta SOLO se è davvero una colonna che stiamo scrivendo: un
 * messaggio che cambia forma non deve poter far cadere un campo a caso.
 */
function colonnaMancante(messaggio: string | undefined, colonne: string[]): string | null {
  const t = messaggio ?? ''
  const nome = /'([A-Za-z0-9_]+)'\s+column/.exec(t)?.[1] ?? /column\s+"([A-Za-z0-9_]+)"/.exec(t)?.[1] ?? null
  return nome && colonne.includes(nome) ? nome : null
}

/** La pagina dei consensi, nella forma che `consensi.ts` sa leggere. */
const PAGINA_CONSENSI: FormPage[] = [
  { id: 'consensi', title: 'Consensi', fields: CONSENSI_INSEGNANTI_FIELDS },
]

/*
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  `cv_path`: un campo ANONIMO che è la CHIAVE DI UN GATE                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── IL DIFETTO, prima della regola ──────────────────────────────────────────
 *
 * Fino al 2026-08-10 questo valore entrava in tabella senza NESSUN controllo:
 * `costruisciRiga` faceva `riga.cv_path = testo(dati.cv_path)` e basta.
 * `validateField` sul tipo `file` non applica né `pattern` né `max_length` — il
 * campo del template dichiara `accept` e `max_size_mb`, che valgono per il
 * SELETTORE DEL BROWSER, non per il server. Quindi chiunque, senza login,
 * scriveva nella colonna una stringa arbitraria di lunghezza arbitraria.
 *
 * Il problema non è la colonna. È che quella colonna È LA CHIAVE con cui il
 * cockpit autorizza la firma di un oggetto dello Storage:
 * `assertCurriculumInScope` (`src/app/api/admin/candidature-insegnanti/route.ts`)
 * ragiona così — «esiste una candidatura di una MIA sede con quel `cv_path`?» ⇒
 * `createSignedUrl(docPath, 600)`. E il bucket è `form_attachments`, LO STESSO
 * dei documenti d'iscrizione dei minori (`iscrizione/upload:POST`, ~961 oggetti
 * al 02/08).
 *
 * Il percorso d'attacco è corto: un URL firmato contiene il percorso IN CHIARO,
 * quindi basta un link inoltrato — o essere personale di un'altra sede — per
 * conoscerlo. Si invia una candidatura anonima sulla sede A con quel percorso
 * dentro `cv_path`; la segreteria di A preme «Curriculum» e riceve un URL
 * firmato per un documento che non è di A e non è un curriculum. Il gate
 * cross-sede costruito nel cockpit non viene forzato: viene AGGIRATO dalla porta
 * pubblica, che è l'unico posto in cui quel valore nasce.
 *
 * ── LA REGOLA ───────────────────────────────────────────────────────────────
 *
 * Si accetta SOLO la forma che una rotta di caricamento delle candidature può
 * produrre — prefisso dedicato, uuid generato dal server, nome sanificato,
 * estensione fra quelle che il bucket ammette — e si rifiuta tutto il resto
 * NOMINANDO il campo. Il prefisso è la parte che porta il peso: `iscrizioni/…`,
 * cioè tutto ciò che l'altra porta pubblica ha scritto in quel bucket, non
 * combacia e non può più essere indicato da qui.
 *
 * ⚠️ DAL 2026-08-15 LA ROTTA DI CARICAMENTO ESISTE, ed è `POST
 * /api/iscrizione/insegnanti/upload`. Fino a quel giorno non ce n'era nessuna
 * (misurato il 2026-08-10: in `src/app/api` non c'era nulla che producesse
 * `candidature/…`), quindi nessun valore legittimo di questo campo poteva
 * esistere e questo gate lo rifiutava in blocco — l'unico che potesse riempirlo
 * era chi se lo inventava. La prescrizione scritta allora («quando la rotta di
 * caricamento nascerà, dovrà produrre questa forma») è stata mantenuta alla
 * lettera: quella rotta importa `CV_PREFISSO` da qui e costruisce il percorso
 * con la stessa `crypto.randomUUID()` e la stessa sanificazione del nome, così
 * la forma che si accetta e la forma che si produce non possono divergere.
 *
 * ⚠️ E DAL 2026-08-15 IL PERCORSO È ANCHE UNICO IN TABELLA
 * (`candidature_insegnanti_cv_unico`). Non è ridondanza con questo gate: la
 * forma dice «questo percorso qualcuno POTREBBE averlo prodotto», l'indice dice
 * «e nessun'altra candidatura l'ha già dichiarato».
 *
 * Serve la seconda perché il gate di firma del cockpit risolve percorso ⇒ riga
 * e, con due righe che dichiarano lo stesso percorso, non fallisce: ne prende
 * UNA A CASO. Misurato, e non supposto: `assertCurriculumInScope` chiamava
 * `.limit(1)` PRIMA di `.maybeSingle()`, e `maybeSingle()` sintetizza `PGRST116`
 * solo quando `data.length > 1`
 * (`node_modules/@supabase/postgrest-js/dist/index.cjs:471`) — quindi quel ramo
 * era irraggiungibile per costruzione. Senza l'indice, chi conosce un percorso
 * (un URL firmato lo porta IN CHIARO: basta un link inoltrato) invia una
 * candidatura anonima sulla PROPRIA sede dichiarando il `cv_path` di una
 * candidatura di un'altra, e da lì la Segreteria della prima riceve un URL
 * firmato per il curriculum di chi si era proposto alla seconda — con la riga di
 * sorveglianza che attribuisce la lettura alla candidatura sbagliata.
 *
 * La difesa NON sostituisce quella dell'altra parte: `assertCurriculumInScope`
 * fa bene a restare fail-closed. Due porte chiuse non sono una ridondanza quando
 * dietro ci sono i documenti dei minori.
 *
 * ── LA PRESCRIZIONE DEL TEMPLATE, E QUALE METÀ TOCCA A CHI ──────────────────
 *
 * `insegnanti-template.ts`, blocco «la difesa che tocca alla route», prescrive
 * due cose: scrivere nel bucket `form_attachments` e passare da
 * `verificaAllegatoPubblico`. Nominarle qui non è una formalità — non erano
 * menzionate da nessuna parte in questo file, e una prescrizione che nessuno
 * ripete è una prescrizione che si scopre non applicata.
 *
 * ⚠️ MA NESSUNA DELLE DUE PUÒ VIVERE IN QUESTA ROUTE, ed è una misura, non
 * un'opinione: `verificaAllegatoPubblico(file: File, …)`
 * (`src/lib/upload/allegati-pubblici.ts`) vuole un `File` — ne legge `type`,
 * `name` e `size` — e questa rotta un file non lo riceve mai. Legge un corpo
 * JSON con `parseBody`, e di quel file conosce soltanto un percorso che qualcun
 * altro dice di aver caricato. Chiamare qui il gate degli allegati vorrebbe dire
 * fabbricare un finto `File` da una stringa: una verifica che non verifica
 * niente e che, esistendo, farebbe credere che il controllo ci sia.
 *
 * Le due prescrizioni sono della ROTTA DI CARICAMENTO (quella che il template
 * chiama «la rotta di upload che serve questo campo», e che oggi non esiste
 * ancora): è lei che ha il `File` in mano, è lei che deve passare da
 * `verificaAllegatoPubblico` e scrivere in `form_attachments` — con il prefisso
 * `candidature/` che questo gate pretende. Qui resta l'altra metà, quella che
 * solo qui si può fare: rifiutare un riferimento che nessuna rotta di
 * caricamento potrebbe aver prodotto.
 */
/**
 * ⚠️ LE COSTANTI E IL GATE DEL PERCORSO NON VIVONO PIÙ QUI: stanno in
 * `@/lib/candidature/percorso-cv`, dal 2026-08-15.
 *
 * Non è un riordino. Quella regola vale per QUATTRO strade — questa, la rotta di
 * caricamento che i percorsi li costruisce, il pannello di Segreteria che li
 * firma e il cron che li cancella — e finché è vissuta qui dentro le altre due
 * si ribattevano a mano il nome del bucket, con due nomi diversi (`BUCKET_CV` e
 * `BUCKET_ALLEGATI`) per lo stesso archivio: uno firma ciò che l'altro cancella.
 * In questo repo una regola in quattro posti diverge alla prima modifica, ed è
 * la lezione già pagata su `@/lib/allegati/mime` e su `gallery` (50 MB nel
 * bucket, 200 nella route, per mesi).
 *
 * Quel modulo porta anche la ragione per cui il nome del file NON sopravvive più
 * alla richiesta: su questa porta si chiama `cv-<cognome>.pdf`, e un percorso
 * finisce in una colonna, dentro un URL firmato in chiaro e — se qualcuno si
 * distrae — dentro un log.
 */

/**
 * Il nome dell'indice unico su `cv_path` (migrazione `20260814225302`).
 *
 * Sta QUI e non nel modulo condiviso perché serve a una cosa sola, e solo a
 * questa rotta: su di essa i `23505` sono DUE fatti diversi e si distinguono
 * unicamente per nome — l'indice sull'email (doppio invio della stessa persona
 * ⇒ 201, per non fare da oracolo) e questo (un curriculum già dichiarato da
 * un'altra candidatura ⇒ 400 sul campo). Nessun altro file inserisce in questa
 * tabella, quindi nessun altro può incontrare quel conflitto.
 */
const INDICE_CV_UNICO = 'candidature_insegnanti_cv_unico'

/**
 * Il `23505` riguarda il curriculum e non l'email?
 *
 * Si guarda in `message`, `details` e `hint` insieme: Postgres mette il nome del
 * vincolo nel messaggio («duplicate key value violates unique constraint "…"»),
 * ma PostgREST non garantisce quale dei tre campi lo porti, e cercare in uno
 * solo è il modo in cui questa distinzione smetterebbe di funzionare senza che
 * nessun test se ne accorga. Il confronto è su un nome che conosciamo NOI: non
 * si legge testo di un terzo per decidere, si cerca dentro di esso una stringa
 * chiusa.
 */
function violaIndiceCv(errore: unknown): boolean {
  const e = errore as { message?: unknown; details?: unknown; hint?: unknown } | null
  return [e?.message, e?.details, e?.hint]
    .map((v) => (typeof v === 'string' ? v : ''))
    .join(' ')
    .includes(INDICE_CV_UNICO)
}

export const POST = withRoute('iscrizione/insegnanti:POST', async (request: NextRequest) => {
  try {
    // ── 1. IL TETTO, PRIMA DI LEGGERE IL CORPO ──────────────────────────────
    //
    // Tre l'ora, non cinque ogni dieci minuti come l'iscrizione: le candidature
    // spontanee sono rare, e un tetto basso non costa niente a chi è vero — chi
    // si candida lo fa una volta, non tre.
    //
    // ⚠️ `rateLimit` degrada a un contatore IN MEMORIA e PER ISTANZA quando il
    // contatore su Postgres non risponde (vedi la testata di `rate-limit.ts`):
    // in quel caso il tetto reale è N × 3, con N istanze calde. Questo alza il
    // COSTO di un abuso, non lo azzera, ed è scritto qui perché nessuno legga
    // «3» come una promessa.
    const rl = await rateLimit(`candidature-insegnanti:${clientIp(request)}`, {
      limit: 3,
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
    // La risposta è un 400 con un codice, NON un finto 201: un successo
    // inventato è una bugia scritta in grande — direbbe «ricevuta» quando non
    // c'è nessuna riga, e il giorno in cui l'esca scattasse per errore su una
    // persona vera nessuno lo saprebbe mai. Il 400 non dice però *perché*: la
    // frase è quella generica del guasto, così l'esca non si autodenuncia.
    const esca = testo(b.data.sito_web) ?? testo(b.data.honeypot)
    if (esca !== null) {
      logEvento('candidatura', 'warn', { operazione: OPERAZIONE, esito: 'honeypot' })
      return NextResponse.json(
        {
          error: 'Non siamo riusciti a registrare la candidatura.',
          codice: 'CANDIDATURA_NON_INVIATA',
        },
        { status: 400 },
      )
    }

    const supabase = await createAdminClient()

    // ── 4. RI-VALIDAZIONE SERVER DEI CAMPI ──────────────────────────────────
    //
    // Il wizard valida già, con QUESTE stesse funzioni. La ripetizione non è
    // ridondanza: un invio fatto fuori dal wizard non esegue una riga di codice
    // del client, e questa è l'ultima difesa prima che un dato malformato
    // arrivi al database (una provincia per esteso in una `varchar(2)` è già
    // successa, sull'altro modulo pubblico).
    const normalizzati = normalizzaRecord(dati)
    // ⚠️ I CAMPI **VISIBILI**, non il template intero — ed è un cambiamento del
    // 2026-08-15, non una sfumatura. `validatePage` documenta di sé che «sul
    // client si passano i soli campi VISIBILI (logica condizionale); sul server
    // si passa il template completo»: era vero finché nessun campo di questo
    // modulo aveva una `condition`. Da oggi `posizione_altro` ne ha una
    // (`posizioni contains 'altro'`) ed è `required`, quindi passare il template
    // completo rifiuterebbe con «Campo obbligatorio» OGNI candidatura che non ha
    // spuntato «Altro» — cioè quasi tutte, e per un campo che chi compila non ha
    // nemmeno visto.
    //
    // `campiVisibili` legge da `@/lib/forms/conditional`, che è lo STESSO motore
    // del wizard: le due parti valutano la stessa condizione con la stessa
    // funzione, che è l'unico modo in cui client e server non divergono su cosa
    // sia obbligatorio.
    const campi = validatePage(campiVisibili(INSEGNANTE_FIELDS, normalizzati), normalizzati)
    if (Object.keys(campi).length > 0) {
      // Nel log SOLO gli id dei campi, mai i valori: `campi_ko` è una chiave
      // fuori dalla lista bianca di `redact()`, quindi anche questo verrebbe
      // ridotto in tabella — ma la regola vale a monte, non si delega la
      // privacy a chi redige.
      logEvento('candidatura', 'warn', {
        operazione: OPERAZIONE,
        esito: esitoConElenco('campi-non-validi', Object.keys(campi)),
        n: Object.keys(campi).length,
      })
      return NextResponse.json(
        {
          error: 'Alcuni campi non sono validi. Controlla i dati e riprova.',
          codice: 'CANDIDATURA_NON_INVIATA',
          // Forma PIATTA (`idCampo → messaggio`): il modulo non ha né record
          // ripetuti né pagine, e una struttura annidata costringerebbe
          // l'interfaccia a disfarla per niente.
          campi,
        },
        { status: 400 },
      )
    }

    // ── 4-bis. IL PERCORSO DEL CURRICULUM ───────────────────────────────────
    //
    // Il gate sta QUI e non in `costruisciRiga`, perché è un rifiuto che deve
    // arrivare a chi compila SOTTO IL CAMPO, come gli altri, e non una riga
    // scartata in silenzio. La ragione per esteso è nella testata di
    // `percorsoCvAmmesso`: quel valore è la chiave con cui il cockpit fa firmare
    // un oggetto del bucket dei documenti dei minori.
    //
    // ⚠️ NEL LOG NON VA IL PERCORSO. Contiene il nome del file, che su questa
    // porta è quasi sempre il nome di una persona, e `redact()` non ha `cv_path`
    // in lista bianca — ma la regola vale a monte: la privacy non si delega a chi
    // redige. Si registra che è stato respinto, non che cosa era.
    const cvPath = testo(normalizzati.cv_path)
    if (cvPath !== null && !percorsoCvAmmesso(cvPath)) {
      logEvento('candidatura', 'warn', { operazione: OPERAZIONE, esito: 'cv-path-non-ammesso' })
      return NextResponse.json(
        {
          error: 'Alcuni campi non sono validi. Controlla i dati e riprova.',
          codice: 'CANDIDATURA_NON_INVIATA',
          campi: {
            cv_path: 'Allega di nuovo il curriculum dal modulo: questo riferimento non è valido.',
          },
        },
        { status: 400 },
      )
    }

    // ── 5. I CONSENSI ───────────────────────────────────────────────────────
    //
    // La verifica sta QUI e non solo nel wizard, per la stessa ragione del
    // punto 4. L'unico blocco obbligatorio è la PRESA VISIONE dell'informativa
    // (art. 13): la base giuridica della valutazione è l'art. 6.1.b — misure
    // precontrattuali su richiesta dell'interessato — e chiedere il consenso
    // per fare la cosa che la persona ci ha appena chiesto di fare sarebbe una
    // domanda senza risposta possibile. Il consenso vero, facoltativo e
    // revocabile, è quello sulla CONSERVAZIONE oltre la selezione.
    const consensiMancanti = consensiObbligatoriMancanti(PAGINA_CONSENSI, dati)
    if (consensiMancanti.length > 0) {
      // Stessa funzione del ramo dei campi, benché OGGI l'unico consenso
      // obbligatorio sia `presa_visione_informativa` e l'esito misuri 43
      // caratteri, cioè stia largo. È il «oggi» a essere il problema: il tetto
      // si supera al SECONDO consenso obbligatorio, che è una riga in
      // `insegnanti-template.ts`, e chi la scriverà non starà pensando a
      // `FORMA_ENUMERATO`.
      logEvento('candidatura', 'warn', {
        operazione: OPERAZIONE,
        esito: esitoConElenco('consensi-mancanti', consensiMancanti),
        n: consensiMancanti.length,
      })
      return NextResponse.json(
        {
          error: 'Per proseguire è necessario dichiarare di aver letto l’informativa sulla privacy.',
          codice: 'CANDIDATURA_NON_INVIATA',
          consensi: consensiMancanti,
        },
        { status: 400 },
      )
    }

    // ── 6. LA PROVA DELL'INFORMATIVA ────────────────────────────────────────
    //
    // Stessa forma di `enrollment_submissions.consents_log`: il TESTO mostrato
    // si congela dentro la riga, perché la prova deve dire *cosa* è stato
    // accettato, non solo *che* qualcosa è stato accettato. Fra due anni si
    // saprà a quale formulazione la persona ha risposto — e se quella
    // formulazione prometteva davvero i mesi di conservazione che il cron
    // applicherà.
    //
    // Le due versioni vengono dalle COSTANTI SERVER, mai dal client: un client
    // datato o manomesso potrebbe dichiarare una versione arbitraria, e la
    // prova varrebbe zero.
    const accettatoIl = new Date().toISOString()
    const consentsLog = {
      versione_informativa: VERSIONE_PRIVACY,
      versione_consensi: CONSENSI_INSEGNANTI_VERSIONE,
      accettato_il: accettatoIl,
      ...extractRequestMeta(request),
      blocchi: estraiConsensi(PAGINA_CONSENSI, dati, accettatoIl),
    }

    // ── 7. LA SEDE ──────────────────────────────────────────────────────────
    //
    // Si accetta `scuola_id` SOLO se compare fra le sedi REALI e ATTIVE.
    //
    // ⚠️ QUI PRIMA C'ERA `tutte`, E LA RAGIONE SCRITTA ACCANTO ERA FALSA. Diceva:
    // «comprende la sede fittizia del seed E2E … senza aprire niente in
    // produzione (quella sede in produzione non esiste)». Misurato il 2026-08-10
    // sul database di produzione:
    //
    //   select id, nome from public.schools where id::text like 'e2e%';
    //   → e2e00000-… · «Kidville E2E» (una riga)
    //
    // ⚠️ L'uuid è TRONCATO, e non per eleganza: il lock
    // `__tests__/architecture/migrazioni-senza-sede-cablata.test.ts` vieta l'uuid
    // COMPLETO della sede di collaudo in `src/`, `scripts/` e `supabase/migrations`,
    // commenti inclusi. La ragione della regola vale anche qui dentro: il prodotto
    // riconosce quella sede dal PREDICATO `isScuolaE2E` (prefisso `e2e00000` o «e2e»
    // nel nome, `src/lib/scuole/reali.ts`), mai da un uuid intero — così un secondo
    // ambiente di prova resta fuori dagli elenchi pubblici senza che nessuno tocchi
    // il codice. Un uuid intero scritto in un commento è pronto da incollare: è
    // esattamente così che `d53b0fbc-…` era finito in 30 file, due dei quali
    // scrivevano in produzione. Il prefisso basta a dire quale sede è.
    //
    // Esiste, ed è collegata a 4 utenti, uno dei quali con `ruolo = 'admin'`.
    // Cioè l'unica ragione addotta per allargare la validazione su una SCRITTURA
    // ANONIMA era smentibile con una query. AGENTS.md dice il contrario di quel
    // commento: la sede fittizia «va ESCLUSA da ogni elenco pubblico».
    //
    // E `tutte` taceva la sua seconda metà: non applica nemmeno il flag
    // `scuole.attiva` (`src/lib/scuole/reali.ts`), quindi la rotta accettava
    // candidature su plessi soft-deleted — che il selettore del wizard
    // (`iscrizione/sedi:GET`, che usa `reali`) non mostra e non mostrerà mai.
    // Accettare una sede che nessuno ha potuto scegliere è la divergenza che
    // `sediReali` esiste per chiudere: l'elenco che si mostra e il predicato che
    // accetta devono essere lo stesso.
    //
    // Il precedente di `iscrizione:POST` (route.ts:230-235) resta su `tutte` per
    // una ragione che QUI non vale: là i test E2E inviano con l'id della sede di
    // prova. Su questa rotta non c'è niente da preservare — il DB della CI non è
    // migrato, `candidature_insegnanti` non esiste e la risposta è 503 prima di
    // arrivare a scrivere. Quando la CI sarà migrata, la sede di collaudo si
    // indicherà per altra via: aprire una scrittura anonima su un plesso finto
    // che in produzione ESISTE non è un modo di rendere collaudabile una rotta.
    //
    // Nessun default silenzioso, mai. Le sedi sono tre: una route che
    // «indovina» archivia la candidatura nel plesso sbagliato senza che nessuno
    // se ne accorga, e la segreteria che l'aspetta crede che non sia arrivata.
    const { reali, error: erroreSedi } = await sediReali(supabase, OPERAZIONE)
    if (erroreSedi) {
      // `sediReali` ha già loggato a livello `error`. Senza l'elenco delle sedi
      // non si può validare niente: è un guasto nostro, non un dato sbagliato
      // di chi compila — quindi 500 e non 400.
      return NextResponse.json(
        {
          error: 'Non siamo riusciti a registrare la candidatura.',
          codice: 'CANDIDATURA_NON_INVIATA',
        },
        { status: 500 },
      )
    }
    // La deduplica viene PRIMA della verifica, e non è cosmesi: due volte lo
    // stesso plesso è un elenco di uno, e due righe uguali significherebbero due
    // copie identiche nella stessa casella e un `23505` sulla chiave primaria di
    // `candidature_sedi`.
    const scuoleRichieste = [...new Set(b.data.scuole_ids)]
    // ⚠️ SI VERIFICA OGNI SEDE, non solo la prima. Un elenco che ne controlla una
    // su tre è peggio di uno che non ne controlla nessuna: sembra difeso, e il
    // giorno in cui la seconda è un uuid inventato la riga di sede va a una FK
    // che non esiste — o, senza FK, sparisce da ogni filtro senza un errore.
    const sedeNonValida = scuoleRichieste.find((id) => !reali.some((s) => s.id === id))
    if (sedeNonValida !== undefined) {
      logEvento('candidatura', 'warn', {
        operazione: OPERAZIONE,
        esito: 'sede-non-valida',
        // Un conteggio, non l'elenco: dice se il rifiuto riguarda un invio a una
        // sede o a più sedi, senza portare uuid che non servono a nessuno.
        n_sedi: scuoleRichieste.length,
      })
      return NextResponse.json(
        { error: 'Indicare la sede della candidatura.', codice: 'SEDE_DA_SPECIFICARE' },
        { status: 400 },
      )
    }
    /**
     * La sede di PRIMO ARRIVO, quella che resta sulla candidatura.
     *
     * ⚠️ Da oggi questa colonna NON AUTORIZZA PIÙ NIENTE: è un dato storico
     * («da dove è arrivata per prima»), non un criterio d'accesso. Il cockpit
     * filtra da `candidature_sedi`. Due criteri di sede per la stessa risorsa
     * sono due risposte diverse alla stessa domanda, e quella sbagliata la si
     * scopre solo quando qualcuno vede ciò che non deve.
     */
    const scuolaId = scuoleRichieste[0]

    // ── 8. L'INSERIMENTO ────────────────────────────────────────────────────
    //
    // Le posizioni si deduplicano E si RIORDINANO, e il riordino non è vezzo:
    // filtrando `POSIZIONI_AMMESSE` (che è l'ordine del template) invece di
    // ricopiare l'array ricevuto, due candidature identiche producono lo stesso
    // valore in tabella anche se le caselle sono state spuntate in ordine
    // diverso. Con `[...new Set(ricevute)]` l'ordine sarebbe quello dei clic, e
    // ogni conteggio o confronto su quella colonna dipenderebbe da come una
    // persona ha mosso il dito.
    const scelte = new Set((dati.posizioni as unknown[] | undefined ?? []).map((p) => String(p)))
    const posizioni = POSIZIONI_AMMESSE.filter((p) => scelte.has(p))
    const riga: Record<string, unknown> = {
      ...costruisciRiga(normalizzati, posizioni),
      scuola_id: scuolaId,
      consents_log: consentsLog,
    }

    let { data: creata, error } = await supabase
      .from('candidature_insegnanti')
      .insert(riga)
      .select('id')
      .single()

    // ── COLONNA ASSENTE (`PGRST204`/`42703`) ────────────────────────────────
    //
    // Il DB E2E della CI non è migrato: qui il degrado dev'essere DICHIARATO.
    // Si ritenta senza la colonna caduta — una candidatura persa perché manca
    // una colonna sarebbe peggio — ma NON in silenzio, e il `warn` la NOMINA:
    // «si è degradato» senza dire *cosa* è caduto è un log che non serve a
    // nessuno il giorno in cui a cadere è la prova del consenso.
    //
    // ⚠️ È UN CICLO, e fino al 2026-08-15 era UN SOLO RITENTO. La differenza si
    // vede solo quando le colonne mancanti sono DUE, ed è esattamente ciò che è
    // successo il giorno in cui `posizioni` e `posizione_altro` sono nate:
    // PostgREST ne nomina UNA per volta, quindi il primo ritento cadeva sulla
    // seconda e la rotta rispondeva 500. MISURATO in CI, non dedotto: l'E2E
    // `public-candidatura-insegnante.spec.ts` — che su `main` era verde —
    // aspettava 201 e ne prendeva un altro.
    //
    // Il tetto è cinque giri: `riga` ha 15 chiavi e un database che ne perde
    // cinque non è «non migrato», è un altro database. Senza tetto, un errore
    // `PGRST204` che nominasse una colonna che non stiamo scrivendo — o che non
    // sappiamo leggere — farebbe girare l'INSERT all'infinito.
    //
    // ⚠️ SI LAVORA SU UNA COPIA E NON SI MUTA `riga`, e non è pulizia: `riga` è
    // ciò che il ramo `23505` più sotto rilegge per ritrovare la candidatura viva
    // («si rilegge con lo STESSO valore che si è provato a scrivere»). Togliendo
    // le colonne dall'originale, quel ramo cercherebbe per `email` una chiave che
    // nel frattempo qualcuno gli ha cancellato di sotto.
    let daScrivere: Record<string, unknown> = riga
    let giri = 0
    while (error && ['PGRST204', '42703'].includes(codiceDi(error)) && giri < 5) {
      const colonna =
        colonnaMancante((error as { message?: string }).message, Object.keys(daScrivere)) ??
        'consents_log'
      // La colonna che non si può togliere perché non c'è: senza questa uscita il
      // ciclo ritenterebbe lo STESSO INSERT fino al tetto, per cinque volte.
      if (!(colonna in daScrivere)) break
      logEvento('candidatura', 'warn', {
        operazione: OPERAZIONE,
        esito: `colonna-assente-${colonna}`,
        error_code: codiceDi(error),
      })
      const ridotta = { ...daScrivere }
      delete ridotta[colonna]
      daScrivere = ridotta
      const ritento = await supabase
        .from('candidature_insegnanti')
        .insert(daScrivere)
        .select('id')
        .single()
      creata = ritento.data
      error = ritento.error
      giri++
    }

    if (error) {
      const codice = codiceDi(error)

      // ── TABELLA ASSENTE (`PGRST205`/`42P01`) ────────────────────────────
      //
      // È lo stato del database della CI, che non è migrato. Qui NON si finge
      // un 201: una persona a cui si dice «ricevuta» non riprova, e la sua
      // candidatura non esiste da nessuna parte. Il 503 con
      // `CANDIDATURE_NON_DISPONIBILI` dice l'unica cosa vera — adesso non
      // possiamo riceverla — e manda alla segreteria, che è l'unica via
      // d'uscita: `CANDIDATURA_NON_INVIATA` inviterebbe a ritentare fra
      // qualche minuto una cosa che non può riuscire.
      if (['PGRST205', '42P01'].includes(codice)) {
        logEvento(
          'candidatura',
          'warn',
          { operazione: OPERAZIONE, esito: 'tabella-assente', error_code: codice },
        )
        return NextResponse.json(
          {
            error: 'In questo momento non possiamo ricevere candidature.',
            codice: 'CANDIDATURE_NON_DISPONIBILI',
          },
          { status: 503 },
        )
      }

      // ── DOPPIO INVIO (`23505`) ⇒ 201, COME AL PRIMO ─────────────────────
      //
      // L'indice `candidature_insegnanti_email_viva` è unico su `lower(email)`
      // per gli stati vivi (`pending`, `in_approvazione`), e l'unicità è
      // GLOBALE: una candidatura viva vale per l'intera cooperativa, che è un
      // solo datore di lavoro con una sola Direzione che valuta.
      //
      // ⚠️ LA MIGRAZIONE PRESCRIVE LA STESSA COSA, E LO DICE CON QUESTE PAROLE.
      // `20260810094610_candidature_insegnanti.sql`, righe 60-71, sopra l'indice
      // `candidature_insegnanti_email_viva`: «COME LA ROUTE PUBBLICA DEVE
      // TRADURLO, e la prima stesura di questo commento diceva la cosa
      // sbagliata: NON con un 409 … Quindi il modulo PUBBLICO risponde 201 come
      // al primo invio … Il 409 esplicito (`CANDIDATURA_GIA_INVIATA`) resta al
      // cockpit AUTENTICATO».
      //
      // La nota che stava qui diceva l'opposto — «la migrazione prescrive un
      // 409, e noi divergiamo di proposito» — ed era falsa già quando è stata
      // scritta: quella migrazione è tracciata e non modificata (`f31dd75`), e
      // il suo commento concorda riga per riga con questo ramo. Un file che
      // descrive un ALTRO file sbagliando manda chi legge a «correggere» una
      // migrazione già allineata, oppure a concludere che uno dei due è stale
      // senza sapere quale: è il costo che questo repo ha già pagato, ed è il
      // motivo per cui la frase è stata sostituita invece che ammorbidita.
      //
      // La ragione, che i due file condividono: qui non c'è nessun login, e
      // chiunque — digitando l'indirizzo di una maestra — leggerebbe da un 409
      // se quella persona ha una candidatura aperta presso questa scuola. Per
      // un'insegnante impiegata altrove è precisamente l'informazione che non
      // deve uscire, e nessuno la cercherebbe apposta: la si troverebbe per
      // caso. Il 409 ha senso nel COCKPIT AUTENTICATO, dove chi guarda ha già
      // titolo per sapere chi si è candidato e il conflitto gli fa aprire la
      // scheda esistente invece di crearne una seconda. La decisione è scritta
      // per esteso accanto a `CANDIDATURA_GIA_INVIATA` in
      // `src/lib/ui/esito-fetch.ts`.
      //
      // ── E IL 201 NON È UNA BUGIA ────────────────────────────────────────
      // La candidatura ESISTE davvero ed è davvero in valutazione: la risposta
      // che chi ha premuto «invia» stava cercando è «ricevuta», e questa è
      // vera. Si restituisce l'id della riga VIVA, non `null`, perché una
      // risposta di forma diversa sarebbe essa stessa l'oracolo che si sta
      // togliendo.
      //
      // ── IL LIVELLO È `warn`, E NON `info` ───────────────────────────────
      // Il doppione NON è rumore: dice che quella persona ha bussato una
      // seconda volta, e — con tre plessi e un indice globale — magari a
      // un'altra porta, dove la segreteria non vedrà mai niente. Un `warn` si
      // persiste PER LIVELLO, senza dipendere da nessuna allowlist, quindi
      // resta interrogabile in SQL proprio quando serve: quando la seconda
      // segreteria chiede «è arrivata?». Nel log vanno la sede RICHIESTA ora,
      // l'uuid della riga già viva e `error_code` — mai l'email, che nel
      // `message` di Postgres c'è per costruzione.
      if (codice === '23505') {
        // ── PRIMA DI TUTTO: QUALE DEI DUE INDICI UNICI? ──────────────────────
        //
        // Dal 2026-08-15 su questa tabella ce ne sono DUE, e il ramo qui sotto
        // — quello che risponde 201 — è scritto per uno solo di essi. Se un
        // `23505` del curriculum finisse lì, la rotta risponderebbe «ricevuta»
        // a una candidatura che NON è stata scritta da nessuna parte: la bugia
        // più costosa che questo file possa dire, perché chi la legge non
        // riprova.
        //
        // Il caso: `candidature_insegnanti_cv_unico` scatta quando il
        // `cv_path` dichiarato è GIÀ di un'altra candidatura. Non succede a chi
        // usa il modulo — ogni caricamento genera un uuid nuovo — e infatti
        // l'indice esiste per l'altro caso: qualcuno che riusa un percorso
        // altrui, e con ciò fa firmare alla Segreteria della PROPRIA sede il
        // curriculum di chi si era proposto a un'altra. La ragione per esteso, e
        // la misura che smentisce la prima stesura di questa nota, stanno nella
        // migrazione `20260814225302`.
        //
        // Qui la risposta è un 400 SUL CAMPO, e non il 201 del doppio invio:
        // non c'è nessun oracolo da chiudere — un percorso contiene un uuid
        // generato dal server, quindi chi lo possiede o l'ha caricato lui (e
        // allora non collide) o l'ha avuto da qualcun altro. E la frase dice
        // l'unica cosa azionabile: riallega.
        if (violaIndiceCv(error)) {
          // NEL LOG NON VA IL PERCORSO: contiene il nome del file, che su questa
          // porta è quasi sempre il nome di una persona. Si registra il fatto.
          logEvento('candidatura', 'warn', {
            operazione: OPERAZIONE,
            esito: 'cv-path-gia-dichiarato',
            scuola_id: scuolaId,
            error_code: '23505',
          })
          return NextResponse.json(
            {
              error: 'Alcuni campi non sono validi. Controlla i dati e riprova.',
              codice: 'CANDIDATURA_NON_INVIATA',
              campi: {
                cv_path: 'Allega di nuovo il curriculum dal modulo: questo riferimento non è valido.',
              },
            },
            { status: 400 },
          )
        }

        // ⚠️ SI RILEGGE CON LO STESSO VALORE CHE SI È PROVATO A SCRIVERE, non con
        // una seconda normalizzazione che gli somiglia.
        //
        // L'indice confronta `lower(email)`; `.eq` confronta i byte. Finché
        // l'email entrava in tabella come era stata digitata, i due predicati
        // divergevano: «Ines.Prova@…» prendeva il `23505` (per l'indice è la
        // stessa persona di «ines.prova@…») e poi non si ritrovava, perché in
        // tabella c'era l'altra forma. `maybeSingle()` tornava `null`, la
        // risposta diventava `{"id": null}` — una FORMA DIVERSA da quella del
        // primo invio, cioè esattamente l'oracolo di enumerazione che rispondere
        // 201 serve a togliere — e il log perdeva il puntatore alla riga viva,
        // che è l'unica cosa da avere in mano quando la seconda segreteria
        // chiede «è arrivata?».
        //
        // La riparazione sta a monte (`normalizzaRecord` scrive l'email in
        // minuscolo); qui si chiude il cerchio prendendo il valore da `riga`,
        // cioè dall'oggetto passato all'INSERT. Due normalizzazioni parallele
        // possono divergere; un valore solo, no.
        const emailScritta = typeof riga.email === 'string' ? riga.email : ''
        // Si legge ANCHE `scuola_id`, e non è un campo in più per curiosità:
        // decide se l'uuid della riga viva può entrare nell'avviso di QUESTA
        // sede (vedi sotto). Senza, l'unica scelta sarebbe fra tacere l'uuid
        // sempre o farlo uscire sempre.
        const { data: viva, error: erroreViva } = await supabase
          .from('candidature_insegnanti')
          .select('id, scuola_id')
          .eq('email', emailScritta)
          .in('stato', ['pending', 'in_approvazione'])
          .maybeSingle()
        const rigaViva = viva as { id?: string; scuola_id?: string } | null
        const idVivo = rigaViva?.id ?? null
        const sedeViva = rigaViva?.scuola_id ?? null

        if (erroreViva) {
          // PostgREST non lancia: senza questo controllo il ramo sarebbe muto.
          logEvento(
            'candidatura',
            'warn',
            { operazione: OPERAZIONE, esito: 'duplicata-riga-viva-non-letta', scuola_id: scuolaId },
          )
        } else if (idVivo === null) {
          // Il `23505` c'è stato ma la riga viva non si trova: resta un caso
          // vero — fra l'INSERT e questa lettura la candidatura è stata approvata
          // o rifiutata, e il filtro sugli stati vivi non la vede più. Non si
          // inventa un uuid per far tornare la forma della risposta, e non si
          // lascia un `entita_id: null` mescolato agli altri: un esito DIVERSO è
          // ciò che distingue «duplicata e tracciata» da «duplicata e persa di
          // vista» quando qualcuno interroga `app_log` un mese dopo.
          logEvento(
            'candidatura',
            'warn',
            { operazione: OPERAZIONE, esito: 'duplicata-riga-viva-non-trovata', scuola_id: scuolaId },
          )
        }

        // ── E LA SEGRETERIA DI QUESTA SEDE VA AVVISATA LO STESSO ────────────
        //
        // ⚠️ QUI IL RAMO USCIVA CON `return` PRIMA DEL PUNTO 9, cioè senza
        // nessuna notifica, ed era la crepa da cui usciva un percorso utente
        // intero. Le due affermazioni non si accordavano: l'indice unico è
        // GLOBALE (`unique (lower(email)) where stato in ('pending',
        // 'in_approvazione')`, migrazione `20260810094610` — una candidatura viva
        // vale per l'intera cooperativa), mentre l'avviso è PER SEDE. Esito
        // misurato sul codice: una maestra con una candidatura viva su un plesso
        // si candida su un altro, il database rifiuta l'INSERT, la route risponde
        // «ricevuta» — e alla seconda segreteria non arriva niente, con l'unica
        // traccia in un `warn` che nessuno guarda in tempo reale. Candidarsi a
        // più plessi della stessa cooperativa è il comportamento normale di chi
        // cerca lavoro. E vale anche il verso ostile: chi invia per primo con
        // l'email di un'altra persona ne blocca in silenzio la candidatura vera.
        //
        // La riparazione sta DIETRO il 201, non davanti: la risposta al chiamante
        // anonimo resta identica al primo invio, perché cambiarla rimetterebbe
        // l'oracolo di enumerazione che si è appena tolto.
        //
        // L'`entitaId` esce SOLO se la riga viva è di questa sede. Altrimenti
        // sarebbe l'uuid di una candidatura che questa segreteria non ha titolo
        // per aprire — il cockpit filtra per sede — e un link che porta a un
        // diniego è peggio di nessun link: sposta il difetto dove non si vede.
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

        logEvento('candidatura', 'warn', {
          operazione: OPERAZIONE,
          esito: 'duplicata',
          scuola_id: scuolaId,
          entita_id: idVivo,
          // Booleano, quindi passa `redact()` per tipo: è la differenza fra «ha
          // bussato due volte alla stessa porta» e «ha bussato a una porta
          // diversa», cioè l'unico modo di contare in SQL quante candidature
          // stanno cercando un secondo plesso.
          stessa_sede: stessaSede,
          error_code: '23505',
        })
        return NextResponse.json({ id: idVivo }, { status: 201 })
      }

      // ── TUTTO IL RESTO ⇒ 500 ────────────────────────────────────────────
      //
      // Il `message` grezzo di PostgREST è prosa inglese con dentro nomi di
      // colonne e di vincoli — e, sul `23505`, l'indirizzo email. Resta nel
      // LOG (passato come errore, dove la sanificazione lo prende) e non esce
      // mai nella risposta: non è un'informazione per chi sta cercando lavoro.
      logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'candidatura' }, error)
      return NextResponse.json(
        {
          error: 'Non siamo riusciti a registrare la candidatura.',
          codice: 'CANDIDATURA_NON_INVIATA',
        },
        { status: 500 },
      )
    }

    const entitaId = (creata as { id?: string } | null)?.id ?? null

    // ── 8bis. LE RIGHE DI SEDE ──────────────────────────────────────────────
    //
    // Una riga per plesso scelto, ciascuna col proprio stato: è da qui che il
    // cockpit filtra, ed è qui che ogni sede valuta per conto suo. Lo `stato`
    // della candidatura lo ricalcola il TRIGGER `candidature_sedi_aggrega` — non
    // si scrive a mano, e scriverlo qui vorrebbe dire due autorità sulla stessa
    // colonna.
    //
    // ⚠️ IL DB E2E DELLA CI NON È MIGRATO. Se la tabella non c'è (`42P01` /
    // `PGRST205`) la candidatura resta registrata sulla sede di primo arrivo e il
    // 201 resta un 201: chi si candida non deve pagare una migrazione mancante, e
    // un 500 qui butterebbe via un modulo appena compilato per intero. Con la
    // tabella assente il cockpit si comporta come prima del 19/08 — legge la
    // colonna sulla candidatura — quindi il degrado non nasconde niente.
    //
    // Un errore DIVERSO da «tabella assente» è invece un guasto vero e si logga a
    // `error`: significa che la candidatura esiste ma nessuna sede la vedrà.
    if (entitaId !== null) {
      const { error: errSedi } = await supabase
        .from('candidature_sedi')
        .insert(scuoleRichieste.map((sid) => ({ candidatura_id: entitaId, scuola_id: sid })))
      if (errSedi) {
        const codice = (errSedi as { code?: string }).code ?? null
        const tabellaAssente = codice === '42P01' || codice === 'PGRST205'
        logEvento(
          'candidatura',
          tabellaAssente ? 'warn' : 'error',
          {
            operazione: OPERAZIONE,
            esito: 'sedi-multiple-non-registrate',
            entita_id: entitaId,
            scuola_id: scuolaId,
            n_sedi: scuoleRichieste.length,
          },
          errSedi,
        )
      }
    }

    // ── 9. LA SEGRETERIA VA AVVISATA (best-effort) ──────────────────────────
    //
    // `error` benché la candidatura sia registrata (201): la riga c'è, il suo
    // annuncio è perso — e una candidatura che nessuno sa di aver ricevuto è
    // una persona che resta senza risposta. Non è un dettaglio saltato, è una
    // consegna mancata.
    //
    // ⚠️ UNA NOTIFICA PER OGNI SEDE SCELTA, dal 2026-08-19. La segreteria di
    // Aversa deve sapere di una candidatura rivolta ad Aversa anche quando la
    // stessa persona ha indicato pure Giugliano: è Aversa a doverla valutare, e
    // nel suo pannello quella scheda c'è. Avvisare solo la sede di primo arrivo
    // avrebbe lasciato l'altra con una pratica nel cockpit e nessuno che glielo
    // dice — cioè il difetto che questo blocco esiste per impedire, spostato di
    // un plesso.
    //
    // In SEQUENZA e non in parallelo: sono al massimo tre, e i destinatari si
    // risolvono per sede con una lettura ciascuna. Una raffica parallela contro
    // un tetto di quota è il modo più rapido di prendersi un rifiuto su tutte e
    // tre invece che su una.
    for (const sid of scuoleRichieste) {
      await avvisaSegreteria(
        supabase,
        sid,
        await staffScuola(supabase, sid, RUOLI_SEGRETERIA),
        { corpo: CORPO_AVVISO.nuova, entitaId },
      )
    }

    // ── 10. IL SUCCESSO SI LOGGA ────────────────────────────────────────────
    //
    // Non c'è una schermata che si riempie a vista, non c'è una famiglia che
    // telefona se non arriva niente: una candidatura che non parte non se ne
    // accorge nessuno. Senza questa riga «nessun log» significherebbe insieme
    // «non si candida nessuno» e «il modulo è rotto» — l'ambiguità che ha
    // nascosto per mesi il guasto delle email di credenziali.
    logEvento('candidatura', 'info', {
      operazione: OPERAZIONE,
      esito: 'candidatura-ricevuta',
      entita_id: entitaId,
      // `scuola_id`, che è il nome della COLONNA — e quello che `esito-fetch.ts`
      // prescrive per i log di questa funzionalità. Prima qui c'era `sede_id`:
      // due nomi per la stessa cosa nella stessa rotta costringono chi interroga
      // `app_log` a conoscerli entrambi, e a scoprire il secondo quando la query
      // torna vuota. Passano tutti e due da `redact()` come uuid: il costo non è
      // in tabella, è di chi legge.
      scuola_id: scuolaId,
      // `n_posizioni` e non più `n_gradi`: le fasce sono derivate, quindi il
      // loro conteggio non dice più niente che le posizioni non dicano già — e
      // per una cuoca varrebbe zero, che si leggerebbe come «candidatura senza
      // fasce», cioè il difetto che il numero serviva a scoprire. Numeri e basta,
      // niente quali: `redact()` li lascia passare per tipo, e a chi interroga
      // `app_log` serve sapere se il modulo raccoglie, non chi cerca che lavoro.
      n_posizioni: posizioni.length,
      // Booleano, quindi passa `redact()` per tipo. È la sola cosa che distingue
      // una candidatura che all'approvazione farà nascere un account docente da
      // una che non ne farà nascere nessuno: senza, quel bivio non è contabile.
      docente: gradiDallePosizioni(posizioni).length > 0,
      // Il modulo raccoglie curriculum, oppure li perde? Prima di oggi la
      // domanda non aveva senso — nessuna rotta di caricamento esisteva — e da
      // oggi è la misura che dice se la funzione appena aperta funziona.
      con_cv: cvPath !== null,
    })

    // ─── LA CONFERMA ALLA CANDIDATA ─────────────────────────────────────────
    // Best-effort: la candidatura è già registrata, e un'email che non parte non
    // deve trasformare un 201 in un 500. Ma non tace: ogni esito lascia una riga,
    // perché «nessun log» non distingua «tutte partite» da «non è mai partito
    // niente».
    //
    // ⚠️ NON sta nel ramo del duplicato: dire «abbiamo ricevuto la sua
    // candidatura» a chi è stato respinto perché ne ha già una aperta sarebbe
    // falso, e le farebbe credere di averne due in corsa.
    if (typeof riga.email === 'string' && riga.email.includes('@')) {
      try {
        const sede = await risolviContestoSede(supabase, scuolaId, OPERAZIONE)
        const messaggio = messaggioConfermaCandidatura({
          nome: typeof riga.nome === 'string' ? riga.nome : null,
          inviataIl: formattaIstante(new Date(), 'it', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
          }),
          // Le posizioni scelte, come testo: è quello che la persona ha indicato.
          ruolo: posizioni.length > 0 ? posizioni.join(', ') : null,
          // Un CONTEGGIO, mai i nomi dei file: un nome di file può contenere di
          // tutto — il codice fiscale, la data di nascita, il datore precedente —
          // e questa email non ha nessun motivo di ripeterlo a chi l'ha caricato.
          numeroAllegati: cvPath !== null ? 1 : 0,
          giorniRisposta: 30,
        }, sede)
        const invio = await sendEmailDetailed({
          to: riga.email,
          subject: messaggio.oggetto,
          text: messaggio.testo,
          html: messaggio.html,
        })
        logEvento('candidatura', invio.ok ? 'info' : 'warn', {
          operazione: OPERAZIONE,
          esito: invio.ok ? 'conferma-inviata' : 'conferma-non-inviata',
          canale: 'email',
          entita_id: entitaId,
          scuola_id: scuolaId,
        }, invio.ok ? undefined : new Error(invio.error ?? 'motivo sconosciuto'))
      } catch (e) {
        logEvento('candidatura', 'warn', {
          operazione: OPERAZIONE,
          esito: 'conferma-non-inviata',
          entita_id: entitaId,
          scuola_id: scuolaId,
        }, e)
      }
    }

    // ─── LA COPIA COMPLETA ALLA SEDE ────────────────────────────────────────
    // La segreteria lavora dalla posta, non dal pannello: una candidatura che
    // esiste solo dentro l'applicazione è una candidatura che qualcuno deve
    // ricordarsi di andare a cercare. Qui il modulo intero — dati, consensi e
    // curriculum in allegato — arriva nella casella del plesso.
    //
    // Stessa disciplina della conferma qui sopra, e per le stesse due ragioni:
    // best-effort (la candidatura è già registrata, e `inviaCopiaAllaSede` non
    // lancia mai) e mai muta (ogni esito lascia la sua riga).
    //
    // ⚠️ E come la conferma, NON sta nel ramo del duplicato. Mandare alla
    // segreteria la copia di una candidatura respinta perché ce n'è già una
    // aperta le farebbe istruire una pratica che non esiste — e quella persona
    // ne avrebbe due in valutazione senza averne inviate due.
    //
    // ⚠️ `sediScelte` porta i NOMI, non gli uuid: questa email la legge una
    // persona, e un uuid in una casella di posta non dice niente a nessuno. Il
    // nome si prende da `reali`, che è già in mano — nessuna query in più.
    //
    // ⚠️ UNA COPIA PER OGNI SEDE, e ognuna dichiara TUTTE le sedi scelte. Chi
    // valuta ad Aversa deve sapere che la stessa persona è in gioco anche a
    // Giugliano: senza, due segreterie istruiscono la stessa pratica senza
    // sapere l'una dell'altra, e la persona riceve due convocazioni scoordinate.
    //
    // In SEQUENZA, non in `Promise.all`. Sono al massimo tre, e il tetto Resend
    // è di circa cento email al giorno già conteso con le iscrizioni: una
    // raffica parallela contro una quota è il modo più rapido di prendersi un
    // 429 su tutte e tre invece che su una — e un 429 è «non oggi», che si
    // gestisce, mentre tre 429 insieme sono tre copie perse.
    const nomiSediScelte = scuoleRichieste.map(
      (sid) => reali.find((s) => s.id === sid)?.nome ?? 'Kidville',
    )
    // I consensi si ricostruiscono dal TEMPLATE e non dal corpo ricevuto: così un
    // consenso non spuntato viaggia come `false` esplicito invece di sparire, e
    // nella copia la sede legge «No» invece di non leggere niente. «Non gliel'ho
    // chiesto» e «ha detto no» non sono la stessa cosa.
    const consensiPerLaCopia = Object.fromEntries(
      CONSENSI_INSEGNANTI_FIELDS.map((c) => [c.id, normalizzati[c.id] === true]),
    )
    const inviataIl = formattaIstante(new Date(), 'it', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    for (const sid of scuoleRichieste) {
      await inviaCopiaAllaSede(supabase, {
        scuolaId: sid,
        dati: normalizzati,
        consensi: consensiPerLaCopia,
        sediScelte: nomiSediScelte,
        inviataIl,
        entitaId,
        cvPath,
      })
    }

    return NextResponse.json({ id: entitaId }, { status: 201 })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'candidatura' }, err)
    return NextResponse.json(
      { error: 'Non siamo riusciti a registrare la candidatura.', codice: 'CANDIDATURA_NON_INVIATA' },
      { status: 500 },
    )
  }
})
