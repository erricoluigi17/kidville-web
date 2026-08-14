import { createHash, randomUUID } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import {
  codeHash,
  consumeTicket,
  getUserEmail,
  sendOtp,
  ticketJti,
  verifyTicket,
} from '@/lib/auth/otp-ticket'
import { limitaInvioOtp, limitaVerificaOtp } from '@/lib/security/otp-rate-limit'
import { assertGenitoreNonSospesoSalvoEssenziale } from '@/lib/pagamenti/sospensione'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { caricaPrefillAlunno } from '@/lib/prestampati/prefill'
import {
  allegatiFuoriPerimetro,
  attesaAccettazioneDirezione,
  BUCKET_CERTIFICATI,
  BUCKET_FASCICOLO,
  campiDaCorreggere,
  campoSceltaDelegato,
  campoTesto,
  emailMancante,
  fineAnnoScolastico,
  ilFileRestaNelBucket,
  motivoMancatoArchivioDa,
  motivoNonFirmabile,
  motivoNonFirmabileSubito,
  nonFirmabileOra,
  percorsiAllegati,
  riferimentiAllegati,
  rifiutoDelRender,
  scaduto,
  scadeAFineAnnoScolastico,
  sconosciuto,
  sempreFirmabiliDa,
  serveIlPrecompilato,
  soloFamiglia,
  voceDelGenitore,
  zSlug,
  type RiferimentoAllegato,
} from '@/app/api/parent/prestampati/banco-famiglia'
import { scadenzaDaRisposte } from '@/app/api/prestampati/banco'
import { getModuleConfig } from '@/lib/settings/module-config'
import {
  ACCOMPAGNATORE_GENITORE,
  modelloGenitore,
  type DatiPrestampato,
} from '@/lib/prestampati/modelli/genitore'
import { cartaDaDati, renderPrestampatoGenitore } from '@/lib/prestampati/render'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { formattaIstante } from '@/i18n/config'
import { withRoute } from '@/lib/logging/with-route'
import { impostaPayload, impostaPayloadEsito } from '@/lib/logging/context'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * LA FIRMA DEL GENITORE SUI PRESTAMPATI — `POST` manda il codice, `PATCH` lo verifica,
 * genera il PDF e lo archivia.
 *
 * È lo stesso flusso di `parent/forms/otp`, che è in produzione da mesi e che questa rotta
 * ricalca riga per riga dove può: `sendOtp`/`verifyTicket`/`consumeTicket` (ticket HMAC,
 * uso singolo), i due tetti di frequenza condivisi con le altre porte OTP, la morosità con
 * l'eccezione dei moduli essenziali, `buildSignatureLog` per la traccia FEA. Ciò che cambia
 * è il seguito: là si scriveva una riga di `forms_submissions`, qui si compone un
 * documento su carta intestata e lo si archivia nel fascicolo del bambino.
 *
 * ─── DOVE L'ORDINE DEI PASSI SI DISCOSTA, E PERCHÉ ──────────────────────────────
 *
 * In `parent/forms/otp:PATCH` il ticket si consuma subito dopo la verifica HMAC, perché lì
 * le risposte sono un `jsonb` pass-through: non c'è niente che possa ancora rifiutarle.
 * Qui invece lo schema `zod` del modello è reale e può dire di no — una data di fine
 * terapia che precede l'inizio, un accompagnatore che non è fra i delegati. Consumare il
 * codice prima di quella validazione significherebbe bruciarlo per un refuso e rimandare
 * la famiglia a rifare tutto l'OTP.
 *
 * Perciò: verifica → composizione del PDF (che è PURA: non scrive niente) → **consumo** →
 * traccia di firma → archiviazione. Il consumo resta prima di ogni effetto collaterale,
 * che è la sola cosa che conta contro il replay; e chi perde la corsa prende 409 senza
 * aver archiviato nulla. La difesa dal tentativo a forza bruta non cambia di una virgola:
 * un codice sbagliato non ha mai consumato il ticket, e il tetto sui tentativi è lo stesso.
 *
 * ─── E IL CONSUMO SI RILEGGE, PERCHÉ LA DIPENDENZA FALLISCE APERTO ──────────────
 *
 * «Prima di ogni effetto collaterale» protegge dal replay solo se il consumo, quando dice
 * sì, ha davvero consumato. `consumeTicket` non lo garantisce: su un errore DB inatteso è
 * **fail-open dichiarato** (`src/lib/auth/otp-ticket.ts`), e la ragione scritta lì — «il
 * vincolo unique su `forms_submissions` impedisce comunque la firma duplicata» — parla del
 * flusso dei moduli, non di questo.
 *
 * Misurato in sola lettura su `pg_indexes` di produzione il 2026-08-14: l'unicità che rende
 * atomico il consumo esiste ed è `otp_ticket_consumati_pkey`, che sta **sul `jti`** — è per
 * questo che un replay collide con 23505 quando l'INSERT arriva a destinazione. A valle
 * invece non c'è niente: `firme_documenti` e `student_documents` hanno la sola chiave
 * primaria sul proprio `id` generato (più due indici non unici su `student_id` e
 * `section_id`). Quindi se l'INSERT del jti NON arriva a destinazione e la firma prosegue
 * lo stesso, lo stesso codice produce due PDF, due righe FEA e due documenti d'archivio.
 *
 * Perciò dopo il consumo si rilegge il jti (`consumoSmentito`), e si rifiuta quando la
 * rilettura RIESCE e la riga non c'è. Ciò che resta scoperto, detto invece che promesso: se
 * lo store dei jti non esiste (DB della CI non migrato) la rilettura fallisce come l'INSERT,
 * si prosegue — è il degrado che `consumeTicket` sceglie — e su quell'ambiente l'uso singolo
 * non è garantito da niente. In produzione la tabella c'è.
 *
 * ─── L'ORDINE DEI TRE EFFETTI, CHE NON È INDIFFERENTE ───────────────────────────
 *
 * `firme_documenti` PRIMA del bucket, e la riga d'archivio per ultima. Il foglio stampa
 * «Riferimento firma: <uuid>», cioè l'id della riga FEA, e lo stampa prima di sapere se
 * quella riga nascerà: registrarla per ultima voleva dire poter consegnare alla famiglia
 * un documento che rimanda a un registro dove non c'è niente. Registrandola per prima,
 * quando fallisce non è ancora stato caricato nessun file — si risponde 500 e non resta
 * niente in giro. Il verso opposto (traccia scritta, file mancante) è una riga che dice
 * «questa persona ha firmato questo contenuto»: è un fatto vero, e non porta con sé dati
 * dell'art. 9.
 *
 * ⚠️ UN QUARTO EFFETTO NON C'È: in `delegates` questa rotta non scrive. Sarebbe la
 * scrittura del n. 08, e sarebbe codice irraggiungibile — `motivoNonFirmabile` rifiuta quel
 * modello con `allegato-non-caricabile` prima di qualunque altra cosa (la scansione del
 * documento di un terzo non ha una porta da cui entrare, vedi `banco-famiglia.ts`), quindi
 * nessuna richiesta ci arriverebbe e nessun test la eserciterebbe senza spegnere la regola
 * che il prodotto applica. Nascerà insieme alla porta che la rende raggiungibile.
 *
 * ─── I GATE: TRE NEL PATCH, DUE NEL POST (TRE SUL SOLO N. 08), DUE NEL GET ──────
 *
 * Non è distrazione, ed è scritto per esteso accanto a ciascuno: nel PATCH i tre giri
 * sulla stessa identità sono tenuti fermi da tre regole diverse — R2 del lock sul corpo
 * (il gate prima della lettura), `isolamento-sede-coverage` (un presidio RICONOSCIUTO
 * accanto alla query sui delegati) e la difesa interna di `prefill.ts`. Nel POST i giri
 * sono due, e diventano tre per la sola delega al ritiro: là il verdetto «si firma oggi?»
 * dipende da quanti tutori ci sono in anagrafica, quindi il precompilato si carica — e
 * `caricaPrefillAlunno` rifà il gate per conto suo. Nel GET, che non legge un corpo, il
 * ruolo si prende dall'utente che il gate restituisce e i giri sono due.
 *
 * `requireParentOfStudent` e non `genitoreHasFiglio`: sono la
 * stessa domanda a due profondità diverse, e la differenza si vede quando il database ha
 * un singhiozzo. `genitoreHasFiglio` è un `boolean` e appiattisce su `false` anche il caso
 * «non l'ho potuto leggere» — che diventerebbe un 403 «Accesso negato» addosso al genitore
 * TITOLARE, più una riga nel contatore degli IDOR a suo nome (rilievo T13, misurato in
 * produzione: `legame_genitori_alunni` rispose con una pagina HTML di Cloudflare).
 *
 * ─── ART. 9 GDPR ────────────────────────────────────────────────────────────────
 *
 * Da questa rotta passano la scheda sanitaria, l'autorizzazione ai farmaci e la richiesta
 * di dieta speciale: allergie, diagnosi, nomi di farmaci di un minore. Nelle righe di log
 * di questo file ci sono uuid, conteggi, codici PostgREST e lo slug del modello — che è un
 * enumerato. **Mai una risposta**, mai un allergene, nemmeno «solo il nome del farmaco».
 *
 * E non basta scriverle bene, le righe: il corpo GREZZO della richiesta entra nel contesto
 * da solo, e da lì finisce in tabella su ogni riga persistita. Vedi `dimenticaLeRisposte`,
 * che è la sola difesa che questa rotta può darsi da sé.
 */

/**
 * Il bucket privato del fascicolo, con la sua dichiarazione — 🔴 compresa la lacuna
 * dell'oblio, che è bloccante — in testa a `BUCKET_FASCICOLO` (`banco-famiglia.ts`).
 *
 * Sta là e non qui perché lo nominano tutte e due le porte della famiglia e perché la scelta
 * dei magazzini ammessi è una regola, non una costante di questa rotta. L'alias locale resta
 * per leggibilità: in questo file `BUCKET` è il bucket in cui si SCRIVE.
 *
 * Ciò che invece È coperto dall'oblio, e vale la pena saperlo: gli ALLEGATI che la famiglia
 * carica — la prescrizione del n. 06, il certificato del n. 07 — vivono in `certificati-medici`
 * (`BUCKET_CERTIFICATI`), che l'oblio raggiunge davvero. La lacuna riguarda il PDF firmato,
 * non i documenti che porta con sé.
 */
const BUCKET = BUCKET_FASCICOLO

/**
 * I parametri del bucket CONDIVISO, copiati da `primaria/fascicolo:POST` — e il motivo per
 * cui una rotta che carica solo PDF dichiara anche tre tipi di immagine.
 *
 * `sensitive_documents` non esiste ancora in produzione (misurato in sola lettura il
 * 2026-08-14: `storage.buckets` ha quattordici righe e nessuna è questa), quindi lo crea
 * **chi arriva primo**, e i parametri di quel primo restano per tutti. Se a crearlo fosse
 * questa rotta con `['application/pdf']`, il fascicolo della primaria — che carica
 * documenti d'identità in JPEG/PNG/WebP con `contentType: file.type` — comincerebbe a
 * prendere un rifiuto dallo storage e a rispondere 500, per una scelta fatta qui dentro.
 *
 * Un bucket condiviso è una risorsa di tutti: o si dichiara in un posto solo, o chi lo
 * crea lo crea per il caso di tutti. Finché il primo non c'è, vale il secondo.
 */
const BUCKET_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const BUCKET_DIMENSIONE_MAX = 15 * 1024 * 1024

/** Il tempo di aprire il file appena firmato, non di girarlo. */
const TTL_LINK = 60

const postBodySchema = z.object({
  slug: zSlug,
  alunnoId: zUuid,
})

const patchBodySchema = z.object({
  slug: zSlug,
  alunnoId: zUuid,
  // `code` ed `expiry` arrivano dal client anche come numero: si normalizzano con
  // String()/Number() prima della verifica HMAC, esattamente come in `parent/forms/otp`.
  code: z.union([z.string(), z.number()]),
  expiry: z.union([z.number(), z.string()]),
  ticket: z.string(),
  /**
   * Le risposte del modulo, pass-through: lo schema VERO è quello del modello, e la
   * validazione avviene dentro `componi()` insieme alla composizione — i due passi non si
   * separano, o si firma un foglio che dichiara cose che nessuno ha controllato.
   */
  risposte: z.unknown(),
})

// ─── Il corpo della richiesta esce dal contesto di log ──────────────────────────

/**
 * ⚠️ LE RISPOSTE DEL MODULO NON RESTANO NEL CONTESTO DI `withRoute`. Va fatto a mano, e
 * questa funzione è il punto in cui si fa.
 *
 * COSA SUCCEDE SENZA. `parseBody` deposita il corpo GREZZO nel contesto **prima** di zod
 * (`impostaPayload('body', raw)` in `src/lib/validation/http.ts`), e ogni riga persistita
 * se lo porta dietro dentro `contestoExtra.payload` (`logger.ts`). Righe persistite ce ne
 * sono, e non sono rare: il 409 del replay (doppio tocco su «Firma» — `ANOMALIE_4XX` di
 * `with-route.ts`), il 400 di validazione da una sessione aperta, i 500, e — finché
 * `document_type_enum` non contiene i diciassette slug — l'`error` di
 * `archivio-non-scritto`, che oggi esce sul 100% delle firme.
 *
 * PERCHÉ LA REDAZIONE NON BASTA, MISURATO invece che supposto. Eseguito `redactInput()` sul
 * corpo del n. 05 (script in scratchpad, `npx tsx`, 2026-08-14): `allergie`,
 * `intolleranze` e `patologie` escono `[redatto:bool]`, ma **`terapie: true`,
 * `vaccinazioni: false` e `ausili: true` escono in chiaro**, accanto ad `alunnoId` che è un
 * uuid e passa per forma. Le tre chiavi sfuggono perché `RADICI_TESTO_LIBERO`
 * (`src/lib/logging/redact.ts`) contiene `terapia` e non `terapi` — «terapie» non contiene
 * «terapia» — e non ha nessuna radice per `vaccin` né per `ausil`. Tradotto in italiano:
 * *questo minore è in terapia farmacologica, non è vaccinato, usa ausili*. Art. 9, in
 * tabella, trenta giorni, interrogabile in SQL. Vale identico per i booleani del 06 e del 07.
 *
 * COSA RESTA. Lo slot `body` si RISCRIVE (`deposita()` sovrascrive la chiave, non ne
 * aggiunge una seconda) con l'uuid dell'alunno e nient'altro: è ciò che serve a diagnosticare
 * un 409 o un 400 — QUALE bambino, QUALE richiesta — senza portarsi dietro che cosa ha
 * dichiarato la famiglia. Lo slug non ci va perché non ci starebbe comunque: sotto
 * `payload` la chiave non apre la lista bianca (`redactInput` è la variante non fidata) e
 * qualunque stringa esce `[redatto:str/N]`; il tipo di modulo è già su ogni riga di questa
 * rotta come `tipo`, che è chiave in chiaro perché la scriviamo noi.
 *
 * SUL RAMO DEL 400 l'alunno non c'è ancora — il corpo non ha passato lo schema — e si
 * deposita un enumerato NOSTRO con `impostaPayloadEsito`, che passa da `redact` fidato e
 * sopravvive in chiaro: «il corpo c'era, non lo si è registrato». Il silenzio direbbe
 * un'altra cosa, cioè che un corpo non c'era.
 *
 * ⚠️ RESTA DA FARE FUORI DI QUI, ed è la riparazione vera: le radici `terapi`, `vaccin` e
 * `ausil` in `src/lib/logging/redact.ts`, più una passata su tutti i booleani degli schemi
 * 05/06/07. Non è file di questa mano — segnalato all'orchestratore. Questa difesa vale per
 * QUESTA rotta; quella varrebbe per tutte.
 */
function dimenticaLeRisposte(alunnoId: string | null): void {
  if (alunnoId) impostaPayload('body', { alunnoId })
  else impostaPayloadEsito('body', 'corpo-non-valido-risposte-non-registrate')
}

// ─── Gli allegati: una casella spuntata deve corrispondere a un file che esiste ──

/**
 * Gli allegati del bucket del FASCICOLO che non ci sono — e la differenza fra «non c'è» e
 * «non l'ho potuto guardare», che qui vale una risposta diversa.
 *
 * `list()` è la sola forma che distingue i due casi con un FATTO invece che con una stringa:
 * un elenco vuoto è un elenco vuoto, mentre `createSignedUrl` avrebbe costretto a leggere il
 * messaggio d'errore del provider per capire se «Object not found» valesse «manca» o «storage
 * in avaria» — lo stesso anti-pattern per cui il campo `motivo` dell'OTP è stato riscritto in
 * questo stesso lavoro.
 *
 * ⚠️ QUI DENTRO NON SI GUARDANO I CERTIFICATI MEDICI, e non è una dimenticanza: quelli si
 * verificano sulla RIGA (`certificati_medici`, `alunno_id` + `file_path`), e una query su una
 * tabella ancorata all'alunno deve stare DENTRO l'handler, accanto al gate che ha verificato
 * `alunnoId`. Non è una preferenza di stile: il lock `isolamento-sede-coverage` legge i nomi
 * delle funzioni chiamate nell'handler per riconoscere i presidi, e una lettura di
 * `certificati_medici` in un helper di file diventa «handler-senza-scope» (misurato:
 * spostandola qui il lock è diventato rosso).
 *
 * `stato: 'non-verificabile'` risale al chiamante e diventa un 503: su un'autorizzazione a
 * somministrare un farmaco «non sono riuscito a controllare l'allegato» non può diventare
 * né un rifiuto («l'hai caricato e ti dico di no») né un sì.
 */
async function allegatiAssenti(
  supabase: SupabaseClient,
  allegati: readonly RiferimentoAllegato[],
): Promise<{ stato: 'verificato'; assenti: string[] } | { stato: 'non-verificabile' }> {
  const assenti: string[] = []
  for (const { campo, bucket, chiave } of allegati) {
    const taglio = chiave.lastIndexOf('/')
    const cartella = taglio > 0 ? chiave.slice(0, taglio) : ''
    const nome = chiave.slice(taglio + 1)
    // L'API dello storage non lancia: ritorna `{ data, error }`, come PostgREST.
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(cartella, { limit: 100, search: nome })
    if (error) {
      logEvento(
        'storage',
        'error',
        { operazione: 'parent/prestampati/firma:PATCH', esito: 'allegato-non-verificato', bucket },
        error,
      )
      return { stato: 'non-verificabile' }
    }
    // `search` è una ricerca PARZIALE: il nome esatto va confrontato, o un file che comincia
    // per lo stesso prefisso passerebbe per un altro.
    const esiste = (data ?? []).some((o) => (o as { name?: string }).name === nome)
    if (!esiste) assenti.push(campo)
  }
  return { stato: 'verificato', assenti }
}

// ─── La scadenza dell'archivio (`student_documents.expiry_date`) ────────────────
//
// ⚠️ LA REGOLA SI IMPORTA, NON SI RICOPIA.
//
// `scadenzaDaRisposte()` vive in `src/app/api/prestampati/banco.ts`, che è la strada della
// segreteria sugli stessi diciassette modelli, ed è **esportata**: importarla non scrive una
// riga in un file di un'altra mano. Una copia sarebbe il difetto silenzioso — due funzioni
// identiche divergono al primo schema che cambia, e allora lo stesso permesso archiviato
// dalla famiglia scade e archiviato dalla segreteria no, col cron
// `notifiche/scadenze-documenti` che avvisa in un caso e tace nell'altro.
//
// Che cosa fa: legge `al` dalle risposte GIÀ VALIDATE che il render restituisce, che è il
// campo con cui la delega al ritiro (08) e il permesso a periodo (09) dichiarano fin quando
// valgono. `ricorrenzaFino` NON è una scadenza — `expiry_date` fa scadere il DOCUMENTO,
// `ricorrenzaFino` dice fin quando si ripete un permesso già concesso.
//
// ⚠️ IL N. 05 NON PASSA DA LÌ. La scheda sanitaria dichiara la propria scadenza nel
// calendario, non nelle risposte: `05-scheda-sanitaria.md:78-79` chiede `expiry_date` = fine
// anno scolastico, «va riconfermata ogni anno». `scadenzaDaRisposte` legge `al`,
// `ricorrenzaFino` e `giorno`, e nello schema del n. 05 non c'è nessuno dei tre: passando di
// là il valore sarebbe `null` SEMPRE — una scheda sanitaria archiviata come se non scadesse
// mai, e il cron che non chiede mai la riconferma. La calcola
// `fineAnnoScolastico(prefill.dati.annoScolastico)`, che è il dato già in mano.
//
// 🔴 IL N. 07 RESTA SENZA SCADENZA, E VA DETTO INVECE CHE LASCIATO SUCCEDERE. Il contratto
// dichiarato in `modelli/genitore.ts` promette che `expiry_date` nasca «dall'`al` del 06 e
// dell'08, dalla `validita` del 07»: la `validita` del 07 però è TESTO LIBERO
// (`z.string().trim().max(120)`) — «fino a fine anno scolastico», «fino a nuova
// certificazione» — e da lì una `date` non si ricava senza indovinare. Estrarre una data
// quando il testo ne contiene una la ricaverebbe **solo su questa strada**, e le due
// tornerebbero a divergere: la stessa richiesta di dieta speciale emessa dalla segreteria
// resterebbe comunque senza scadenza. Perciò oggi il n. 07 si archivia con `expiry_date`
// nullo e il cron non avvisa — è una lacuna dichiarata e collaudata, non un caso dimenticato;
// il rimedio è un campo `data` sul modello, che è file di un'altra mano, ed è segnalato
// all'orchestratore. La differenza col n. 05 è che là la fine dell'anno scolastico è un
// FATTO del calendario, qui sarebbe una data estratta da una frase scritta da un medico.

// ─── La morosità: quali moduli questa sede non blocca mai ───────────────────────

/**
 * L'elenco dei moduli che restano firmabili anche da un genitore SOSPESO, letto dalle
 * impostazioni della sede.
 *
 * ⚠️ SI LEGGE, NON SI DECIDE QUI: quali moduli la scuola non blocca mai è una regola di
 * CREDITO, e un elenco scritto dentro una rotta la mette in mano a chi rilascia il codice
 * invece che al titolare. La fonte è
 * `admin_settings.modulistica_config.prestampati_sempre_firmabili` — la stessa colonna jsonb
 * per sede da cui la modulistica legge già `promemoria_giorni`, scrivibile da
 * `PATCH /api/admin/settings` e quindi modificabile **senza un rilascio** (il controllo
 * visibile nel pannello va ancora aggiunto: vedi `SEMPRE_FIRMABILI_PREDEFINITI`).
 * Il valore di partenza, e il perché di quei tre slug, stanno in
 * `SEMPRE_FIRMABILI_PREDEFINITI` (`banco-famiglia.ts`), insieme alla dichiarazione che è un
 * predefinito in attesa della conferma del titolare e non una citazione della specifica.
 *
 * `getModuleConfig` non lancia e non rifiuta: su una lettura fallita logga il proprio `warn`
 * con la colonna e la sede e restituisce `{}`, che qui vale «nessuna configurazione» e ricade
 * sul predefinito. È voluto: un singhiozzo nella lettura delle impostazioni non può impedire
 * a un genitore di autorizzare un farmaco per suo figlio.
 */
async function moduliSempreFirmabili(
  supabase: SupabaseClient,
  scuolaId: string | null,
): Promise<ReadonlySet<string>> {
  return sempreFirmabiliDa(await getModuleConfig(supabase, 'modulistica_config', scuolaId))
}

// ─── POST: manda il codice ──────────────────────────────────────────────────────

export const POST = withRoute('parent/prestampati/firma:POST', async (request: NextRequest) => {
  try {
    // ⚠️ QUI L'IDENTITÀ SI RISOLVE CON `requireUser`, e nel PATCH no: la differenza è il
    // TETTO. Questa rotta SPEDISCE, e la disciplina di `parent/forms/otp:POST` è che il
    // tetto venga prima di qualunque query e di qualunque invio — quindi va messo appena
    // si sa chi limitare, cioè prima di poter leggere `alunnoId` dal corpo e prima del
    // gate della famiglia. Nel PATCH non parte niente verso l'esterno, e il tetto può
    // stare un gradino più in basso.
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    if (auth.user.role !== 'genitore') return soloFamiglia()
    const parentId = auth.user.id

    // Tetto di frequenza PRIMA di ogni query e di ogni invio: il budget è uno solo per
    // tutte le porte OTP, perché la casella del genitore è una sola.
    const troppi = await limitaInvioOtp(parentId)
    if (troppi) return troppi

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { slug, alunnoId } = b.data

    const voce = voceDelGenitore(slug)
    if (!voce) return sconosciuto()

    // ── NON SI SPEDISCE UN CODICE PER UNA FIRMA CHE IL PATCH RIFIUTERÀ ──────────────
    //
    // Il solo «lo firma il genitore o la Scuola?» non basta: i due moduli che il PATCH non
    // genera mai — il n. 10 senza i dati dell'uscita, il n. 08 con due tutori in anagrafica —
    // passerebbero di qui, farebbero partire l'email e si schianterebbero dopo. Non è solo un
    // giro a vuoto: `LIMITE_OTP_INVIO` è di **5 invii per finestra di dieci minuti** ed è un
    // budget CONDIVISO fra tutte le porte OTP (`otp-rate-limit.ts`), quindi cinque tentativi
    // sulla gita lascerebbero il genitore senza modo di firmare l'autorizzazione a un farmaco.
    //
    // Il verdetto arriva in due tempi, e l'ordine è la disciplina «ciò che non si legge non
    // si può perdere»: prima quello che non ha bisogno di nessuna query — e che quindi
    // rifiuta i due certificati e il n. 10 senza aver toccato l'anagrafica di un minore —
    // poi, solo per il modulo che lo pretende, quello che guarda il precompilato.
    const subito = motivoNonFirmabileSubito(voce)
    if (subito) return nonFirmabileOra(subito)

    // IDOR: il codice si chiede per UN bambino, e dev'essere il proprio. Qui il gate è
    // esplicito perché è l'unico che c'è per la maggior parte dei modelli — il precompilato,
    // che lo rifà per conto suo, si carica solo per il n. 08 — e senza, un'email partirebbe
    // a chi sta sondando id altrui.
    const portata = await requireParentOfStudent(request, alunnoId)
    if (portata.response) return portata.response

    const supabase = await createAdminClient()

    // Il precompilato SOLO per chi ne ha bisogno: quante firme pretende la delega al ritiro
    // lo dice l'anagrafica della famiglia, non il modello. Per gli altri sette resta `null` e
    // il verdetto non lo guarda — otto query di anagrafica per ogni richiesta di codice
    // sarebbero dati di un minore letti per mandare un'email.
    let datiFamiglia: DatiPrestampato | null = null
    let sedeDelBambino: string | null = null
    if (serveIlPrecompilato(voce)) {
      const esitoPrefill = await caricaPrefillAlunno(request, supabase, alunnoId)
      if (esitoPrefill.response) return esitoPrefill.response
      datiFamiglia = esitoPrefill.prefill.dati
      sedeDelBambino = esitoPrefill.prefill.scuolaId
    }
    const motivo = motivoNonFirmabile(voce, datiFamiglia)
    if (motivo) {
      // Si conta, e serve: è la misura di quante famiglie chiedono un foglio che oggi non
      // si può firmare, cioè la sola prova che dice se le due strade mancanti (le uscite
      // pubblicate dalla segreteria, la raccolta della seconda firma) valgono la pena.
      // Il motivo viaggia in `azione`, che è nella lista bianca di `redact` e accetta la
      // forma di un enumerato: `motivo` — che sarebbe il nome giusto — non è fra le chiavi
      // in chiaro e uscirebbe `[redatto]` proprio nella riga che esiste per contare.
      logEvento('modulistica', 'info', {
        operazione: 'parent/prestampati/firma:POST',
        esito: 'firma-non-disponibile',
        azione: motivo,
        tipo: voce.slug,
        utente: parentId,
        alunno_id: alunnoId,
      })
      return nonFirmabileOra(motivo)
    }

    // ── LA SEDE DEL BAMBINO, che qui serve per una cosa sola: la politica della morosità ──
    //
    // La query vive DENTRO l'handler perché è ancorata ad `alunnoId`, che il gate della
    // famiglia ha verificato in questo stesso handler: è la stessa disciplina delle letture
    // del PATCH, e il legame fra il permesso e la lettura che ne approfitta si deve poter
    // leggere senza saltare in un'altra funzione.
    //
    // ⚠️ NON SI PRENDE DALLA SESSIONE, e va detto perché sarebbe stato gratis:
    // `auth.user.scuola_id` è la sede dell'ACCOUNT, e un genitore può avere due figli in due
    // plessi diversi — la rotta gemella lo dichiara in testa («per un genitore lo scope è la
    // FAMIGLIA e non la sede»). Prendere quella sarebbe una route che «indovina» la sede,
    // cioè il difetto che AGENTS.md nomina per esteso.
    //
    // Il precompilato, quando c'era, l'ha già portata: sul n. 08 non si rilegge.
    if (sedeDelBambino === null) {
      // PostgREST non lancia: il valore di ritorno va controllato, sempre.
      const { data: rigaSede, error: erroreSede } = await supabase
        .from('alunni')
        .select('scuola_id')
        .eq('id', alunnoId)
        .maybeSingle()
      if (erroreSede) {
        // Non ferma la richiesta: senza sede la politica ricade sul predefinito, che è il
        // comportamento di prima. Ciò che non può succedere è che questo passi in silenzio.
        logEvento(
          'modulistica',
          'warn',
          {
            operazione: 'parent/prestampati/firma:POST',
            esito: 'sede-non-letta',
            alunno_id: alunnoId,
            error_code: (erroreSede as { code?: string }).code ?? null,
          },
          erroreSede,
        )
      }
      sedeDelBambino = (rigaSede as unknown as { scuola_id?: string | null } | null)?.scuola_id ?? null
    }

    // Morosità: chiedere il codice per firmare è un'azione di servizio. Qui lo slug è già
    // noto — a differenza di `parent/forms/otp:POST`, che non lo conosce — quindi
    // l'eccezione dei moduli essenziali si valuta subito, e un genitore sospeso può
    // comunque autorizzare un farmaco per suo figlio. Quali siano quei moduli lo dicono le
    // impostazioni della sede, non questa rotta (vedi `moduliSempreFirmabili`).
    const sempreFirmabili = await moduliSempreFirmabili(supabase, sedeDelBambino)
    const sospeso = await assertGenitoreNonSospesoSalvoEssenziale(supabase, parentId, {
      sempreFirmabile: sempreFirmabili.has(voce.slug),
    })
    if (sospeso) return sospeso

    const res = await sendOtp(supabase, parentId, {
      subject: `Codice di firma — ${voce.etichetta}`,
      intro: `Il tuo codice per firmare «${voce.etichetta}» è`,
    })
    if ('error' in res) return emailMancante()

    // Successo loggato: con i soli errori, «nessun log» non distingue «tutto ok» da «non è
    // mai partito niente» — l'ambiguità esatta che ha nascosto per mesi il guasto delle
    // email di credenziali. `sent` dice se il provider ha accettato la consegna.
    logEvento('modulistica', 'info', {
      operazione: 'parent/prestampati/firma:POST',
      esito: res.sent ? 'codice-inviato' : 'codice-non-consegnato',
      tipo: voce.slug,
      utente: parentId,
      alunno_id: alunnoId,
    })

    return NextResponse.json({ success: true, ...res })
  } catch (err) {
    logErrore({ operazione: 'parent/prestampati/firma:POST', stato: 500 }, err)
    return NextResponse.json(
      {
        error: 'Non è stato possibile inviare il codice di firma. Riprova fra qualche minuto.',
        codice: 'PRESTAMPATO_NON_GENERATO',
      },
      { status: 500 },
    )
  }
})

// ─── PATCH: verifica, genera, archivia ──────────────────────────────────────────

export const PATCH = withRoute('parent/prestampati/firma:PATCH', async (request: NextRequest) => {
  try {
    // ── PRIMO GIRO: chi sei. Prima del corpo, e non è una preferenza ────────────────
    //
    // Il lock `__tests__/architecture/corpo-letto-dopo-il-gate.test.ts` (regola R2) pretende
    // che un handler che ha un gate lo chiami PRIMA di leggere il corpo, e la ragione l'ha
    // pagata `primaria/fascicolo`: il server non deve bufferizzare quello che gli manda uno
    // sconosciuto per poi scoprire che è uno sconosciuto. Qui serve anche a sapere CHI
    // limitare: il tetto viene subito dopo, e un tetto ha bisogno di un nome.
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    if (auth.user.role !== 'genitore') return soloFamiglia()
    const parentId = auth.user.id

    // Tetto sui TENTATIVI di verifica, su un budget separato da quello degli invii: qui
    // non si difende una casella, si difende una firma con valore legale. Il codice è di
    // sei cifre e un confronto HMAC fallito NON consuma il ticket: senza tetto, provarli
    // tutti sarebbe gratis.
    const troppi = await limitaVerificaOtp(parentId)
    if (troppi) return troppi

    const b = await parseBody(request, patchBodySchema)
    // ⚠️ SUBITO, e su tutti e due i rami: `parseBody` ha appena depositato nel contesto il
    // corpo grezzo — cioè la scheda sanitaria di un minore — e da lì finirebbe in `app_log`
    // su ogni riga persistita, 409 di replay compreso. Vedi `dimenticaLeRisposte`.
    dimenticaLeRisposte('response' in b ? null : b.data.alunnoId)
    if ('response' in b) return b.response
    const { slug, alunnoId, code, expiry, ticket, risposte } = b.data

    const voce = voceDelGenitore(slug)
    if (!voce) return sconosciuto()
    // Il verdetto che non ha bisogno di leggere niente, prima del gate e del precompilato:
    // gli stessi due tempi del POST, con le stesse parole. Quello che guarda l'anagrafica
    // arriva dopo, appena il precompilato è in mano — e comunque PRIMA della verifica del
    // codice, così un client vecchio che insiste su un modulo non firmabile prende un 409
    // senza bruciare il ticket.
    const subito = motivoNonFirmabileSubito(voce)
    if (subito) return nonFirmabileOra(subito)
    const modello = modelloGenitore(voce.slug)
    // Difensivo: registro e modelli sono due file diversi, e un modello del genitore che
    // fosse nel registro e non fra i modelli genererebbe un 500 nudo invece di un 404.
    if (!modello) return sconosciuto()

    // ── SECONDO GIRO: di quale bambino. IL TICKET NON È UN LASCIAPASSARE ────────────
    //
    // Il ticket firma `email:code:expiry` e non nomina nessun alunno: senza questa riga un
    // codice chiesto per il proprio figlio firmerebbe il documento di chiunque altro. Non
    // poteva stare più in alto — `alunnoId` arriva dal corpo, e il corpo si legge dopo il
    // primo gate.
    //
    // ⚠️ TRE GIRI SULLA STESSA IDENTITÀ, E OGNUNO È TENUTO FERMO DA UNA REGOLA DIVERSA.
    // Vanno nominate, perché tolto uno qualunque qualcosa diventa rosso e chi ci riprova
    // deve poterlo sapere prima invece che dopo:
    //  1. `requireUser` qui sopra — regola R2 del lock sul corpo, più il tetto che ha
    //     bisogno di un'identità e non può aspettare `alunnoId`;
    //  2. questo `requireParentOfStudent` — è la portata sulla famiglia, ed è anche la sola
    //     forma che `isolamento-sede-coverage` RICONOSCE come presidio: quel lock legge i
    //     nomi delle funzioni chiamate dentro l'handler, `caricaPrefillAlunno` non è fra
    //     quelli, e togliendo questa riga l'handler diventa «handler-senza-scope su
    //     `delegates`» (misurato). Il permesso di leggere il delegato al ritiro si deve
    //     vedere accanto alla query che ne approfitta;
    //  3. quello che `caricaPrefillAlunno` rifà per conto suo — vive dentro `prefill.ts`,
    //     che si difende anche dalle route che dimenticassero la propria, e da qui non si
    //     toglie.
    // Nel GET, dove il corpo non c'è e il tetto nemmeno, i giri sono due: là il ruolo si
    // legge dall'utente che il gate restituisce, e `requireUser` non serve.
    const portata = await requireParentOfStudent(request, alunnoId)
    if (portata.response) return portata.response

    const supabase = await createAdminClient()

    // Il precompilato porta i rifiuti già pronti per il bambino archiviato, anonimizzato o
    // senza sede: un prestampato su un bambino che quest'anno non frequenta è una
    // dichiarazione falsa su carta intestata.
    const esitoPrefill = await caricaPrefillAlunno(request, supabase, alunnoId)
    if (esitoPrefill.response) return esitoPrefill.response
    const { prefill } = esitoPrefill

    // Il secondo tempo del verdetto, ora che l'anagrafica della famiglia è nota: con due
    // tutori la delega al ritiro pretende due sottoscrizioni e questa rotta ne raccoglie
    // una. Il render arriverebbe alla stessa conclusione — la regola è sua
    // (`verificaContesto` del n. 08) e da qui si chiama la SUA `richiedeDueFirme`, non una
    // copia — ma direbbe «campo mancante» con un 422, cioè manderebbe la famiglia a
    // correggere un modulo che è compilato bene. Qui il rifiuto dice la cosa vera, con le
    // stesse parole del POST e dell'elenco.
    const motivo = motivoNonFirmabile(voce, prefill.dati)
    if (motivo) return nonFirmabileOra(motivo)

    // La stessa politica del POST, con la stessa fonte: qui la sede la porta il precompilato,
    // che è già in mano. Due verdetti diversi sullo stesso modulo — codice spedito e firma
    // rifiutata — sarebbero il difetto che `banco-famiglia.ts` esiste per chiudere.
    const sempreFirmabili = await moduliSempreFirmabili(supabase, prefill.scuolaId)
    const sospeso = await assertGenitoreNonSospesoSalvoEssenziale(supabase, parentId, {
      sempreFirmabile: sempreFirmabili.has(voce.slug),
    })
    if (sospeso) return sospeso

    const email = await getUserEmail(supabase, parentId)
    if (!email) return emailMancante()

    // Scadenza + HMAC ricalcolato sull'email AUTOREVOLE, quella in tabella: non quella che
    // il client dice di avere.
    const check = verifyTicket(email, String(code), Number(expiry), ticket)
    if (!check.ok) {
      return NextResponse.json(
        {
          error: check.error,
          codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
          // ⚠️ L'ENUMERATO SI RICAVA DA UN FATTO, NON DALLA PROSA DELLA DIPENDENZA. Qui
          // c'era `/scadut/i.test(check.error)`: `verifyTicket` restituisce tre MESSAGGI
          // italiani e nessun codice, e il giorno in cui «Codice scaduto, richiedine uno
          // nuovo» viene riscritto questo campo comincia a dire `non-valido` a un codice
          // scaduto, senza che niente diventi rosso. È l'anti-pattern che
          // `src/lib/prestampati/render.ts` denuncia per iscritto — «la frase si riscrive,
          // il codice no» — e la scadenza è l'unico dei tre casi che si può misurare senza
          // leggere una parola: `expiry` viaggia nel corpo ed è la stessa soglia che
          // `verifyTicket` confronta. Gli altri due (HMAC che non torna, parametri
          // mancanti) restano `non-valido`, che è ciò che sono.
          motivo: scaduto(expiry) ? 'scaduto' : 'non-valido',
        },
        { status: 400 },
      )
    }

    // ── Il blocco di firma (§3a di `docs/prestampati/00-impaginazione.md`) ──────────
    //
    // Il RIFERIMENTO si genera PRIMA del PDF perché finisce stampato dentro il PDF: è l'id
    // della riga di `firme_documenti`, cioè il modo in cui chi ha in mano il foglio ritrova
    // la firma nel registro. Perché quella riga esista davvero, vedi l'ordine dei tre
    // effetti in testata: si scrive prima del bucket, e se non si scrive non esce niente.
    //
    // Sul foglio non finiscono né l'hash dell'OTP né l'email né l'indirizzo IP: quelli
    // vivono nel log di firma, che è un altro documento.
    const firmaId = randomUUID()
    const adesso = new Date()
    // UN SOLO ORDINE PER IL FIRMATARIO, e composto in un posto solo. Il corpo del documento
    // stampa `richiedente.nomeCompleto`, che il precompilato compone come «cognome nome»:
    // prendendo qui `[nome, cognome]` dalla sessione, lo stesso genitore compariva come
    // «Anna Verdi» nel riquadro di firma e «Verdi Anna» tre righe più su, sullo stesso
    // foglio. Vince l'anagrafica, che è la grafia che il documento usa già; la sessione è
    // il ripiego per l'account non ancora legato a una riga di `parents`, e segue lo stesso
    // ordine.
    const firmatario =
      prefill.dati.richiedente?.nomeCompleto?.trim() ||
      [auth.user.cognome, auth.user.nome].filter(Boolean).join(' ').trim()
    const istante = `${formattaIstante(adesso, 'it', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })} alle ${formattaIstante(adesso, 'it', { hour: '2-digit', minute: '2-digit' })}`

    // ── Il delegato che ritira il bambino (n. 09), risolto in un NOME ───────────────
    //
    // Lo risolve la ROUTE e non il modello, ed è il modello stesso a dirlo
    // (`nomeAccompagnatore`): là dentro Supabase non entra. Il valore convenzionale «io
    // stesso» non passa di qui — quel ramo legge il richiedente, che il precompilato porta.
    //
    // ⚠️ SI CHIEDE AL MODELLO QUALE CAMPO SCEGLIE UN DELEGATO, e non si legge
    // `accompagnatore` dal corpo per tutti e otto. È lo stesso predicato del GET
    // (`campoSceltaDelegato`, `banco-famiglia.ts`), e la differenza è misurabile: leggendo la
    // chiave a mano, una firma di `scheda_sanitaria` con `risposte.accompagnatore` valorizzato
    // interrogava `delegates` — l'anagrafica di terzi letta per un documento che non la usa —
    // e un guasto su quella tabella la rendeva irrealizzabile col 503 qui sotto.
    //
    // La query vive dentro l'handler perché è ancorata ad `alunnoId`, che il gate della
    // famiglia ha appena verificato in questo stesso handler: un id di delegato scelto dal
    // client non basta a leggere il delegato di un altro bambino, e il legame fra il gate e
    // la query che ne approfitta si deve poter leggere senza saltare in un'altra funzione.
    //
    // ⚠️ LA FORMA SI GUARDA PRIMA DI CHIEDERE. `accompagnatore` è
    // `z.string().trim().max(120)` — una stringa qualunque — e `delegates.id` è un `uuid`:
    // passare a Postgres una scelta che uuid non è produce un `22P02`, cioè un ERRORE di
    // lettura per un dato che è semplicemente sbagliato. Distinguere le due cose qui è ciò
    // che permette al ramo sotto di trattare l'errore per quello che è.
    const campoDelegato = campoSceltaDelegato(modello.campi)
    const sceltaAccompagnatore = campoDelegato ? campoTesto(risposte, campoDelegato) : null
    const idDelegato =
      sceltaAccompagnatore &&
      sceltaAccompagnatore !== ACCOMPAGNATORE_GENITORE &&
      zUuid.safeParse(sceltaAccompagnatore).success
        ? sceltaAccompagnatore
        : null
    let accompagnatore: string | null = null
    if (idDelegato) {
      const { data: delegato, error: erroreDelegato } = await supabase
        .from('delegates')
        .select('first_name, last_name')
        .eq('student_id', alunnoId)
        .eq('id', idDelegato)
        .maybeSingle()
      if (erroreDelegato) {
        // ⚠️ PostgREST non lancia, e «non ho potuto leggere» NON diventa «non esiste»: con
        // `accompagnatore` lasciato a `null` il modello rifiuterebbe con «Il delegato indicato
        // non risulta fra i delegati attivi» — un'affermazione FALSA, detta alla famiglia sul
        // foglio che dice chi porta via il bambino da scuola.
        //
        // È la stessa situazione degli allegati, ed è trattata allo stesso modo e per la
        // stessa ragione (`allegatiAssenti` → `non-verificabile` → 503): «non sono riuscito
        // a controllare» non può diventare né un rifiuto né un sì. Il ticket a questo punto
        // non è ancora consumato, quindi la famiglia non perde niente e la risposta lo dice.
        logEvento(
          'modulistica',
          'error',
          {
            operazione: 'parent/prestampati/firma:PATCH',
            esito: 'delegato-non-letto',
            entita_tipo: 'delegates',
            tipo: voce.slug,
            alunno_id: alunnoId,
            error_code: (erroreDelegato as { code?: string }).code ?? null,
          },
          erroreDelegato,
        )
        return NextResponse.json(
          {
            error:
              'Non è stato possibile verificare chi ritira il bambino: riprova fra qualche minuto. Il codice di firma non è stato utilizzato.',
            codice: 'PRESTAMPATO_NON_GENERATO',
          },
          { status: 503 },
        )
      }
      const riga = delegato as unknown as { first_name: string | null; last_name: string | null } | null
      accompagnatore = riga
        ? [riga.last_name, riga.first_name].filter(Boolean).join(' ').trim() || null
        : null
    }

    const dati: DatiPrestampato = {
      ...prefill.dati,
      ...(accompagnatore ? { accompagnatore } : {}),
      // Le sottoscrizioni raccolte finora: questa, ed è **l'unica che questa rotta sa
      // raccogliere**. Il n. 08 ne pretende due quando in anagrafica ci sono due tutori, e
      // con una sola il suo `verificaContesto` rifiuta — e ha ragione: una delega al ritiro
      // firmata da un genitore solo autorizza un terzo a portare via un bambino col consenso
      // di metà famiglia. Quel caso qui non ci arriva più: `motivoNonFirmabile` lo ferma più
      // in alto, con la stessa regola e con un messaggio che dice la cosa vera. Questa riga
      // resta com'è, ed è il punto in cui la seconda firma entrerà il giorno in cui esisterà
      // un posto dove raccoglierla.
      sottoscrizioni: [{ firmatario, istante }],
    }

    const esito = renderPrestampatoGenitore(modello, dati, risposte, {
      carta: cartaDaDati(dati),
      // §4.1: la copia che la famiglia si scarica da sé non consuma numerazione e lo DICE.
      // Sui sei fogli che escono dalla scuola è obbligatorio dirlo; sugli altri il render
      // la ignora, ed è il motivo per cui qui si può mettere sempre.
      copiaFamiglia: true,
      firma: { firmatario, istante, metodo: 'Firmato con codice OTP verificato', riferimento: firmaId },
    })
    if (!esito.ok) return rifiutoDelRender(esito)

    // ── Gli allegati esistono davvero? PRIMA di spendere il codice ──────────────────
    //
    // Il foglio è composto (il render è puro: non ha scritto niente) ma il ticket non è
    // ancora consumato, ed è qui che il controllo deve stare: un allegato che manca è un
    // modulo da correggere, non una firma da bruciare. Le risposte si leggono VALIDATE —
    // rileggerle dal corpo grezzo sarebbe una seconda lettura degli stessi campi con due
    // esiti possibili.
    //
    // ⚠️ CHI ARRIVA FIN QUI, e chi non ci arriva più. Il n. 06 e il n. 07 sanitario ci
    // arrivano davvero, e il 422 di campo è per loro la risposta giusta: la porta per
    // caricare l'allegato esiste (`POST /api/parent/medical-certificates`), quindi «il file
    // non risulta caricato» è un modulo da correggere e non un vicolo cieco. Il n. 08 no:
    // la scansione del documento del delegato non ha nessuna porta, e un 422 sistematico
    // costava un invio del budget OTP — 5 ogni dieci minuti, condiviso fra tutte le porte —
    // per una cosa che non poteva riuscire. Quel modello si ferma prima, con
    // `allegato-non-caricabile` (`banco-famiglia.ts`), e il rifiuto «seconda firma mancante»
    // resta raggiungibile perché lo si valuta per primo.
    //
    // ⚠️ E IL MAGAZZINO AMMESSO È PER CAMPO, non per rotta: `certificati-medici` è l'archivio
    // dei certificati sanitari DEL BAMBINO, quindi lo possono nominare la prescrizione del
    // n. 06 e il certificato del n. 07, non il documento d'identità di un terzo. È la riga
    // che rende vera la ragione per cui il n. 08 è spento — vedi `magazziniAmmessi`.
    //
    // `garantisciBucket` UNA VOLTA SOLA, e qui: `sensitive_documents` in produzione non
    // esiste ancora (misurato il 2026-08-14), e senza, `list()` risponderebbe «Bucket not
    // found» — cioè `non-verificabile`, cioè 503 — su ogni modulo con allegato, per sempre.
    // Prima ce n'erano due — una qui dentro e una prima dell'upload — cioè due `listBuckets()`
    // per ogni firma con allegati. È idempotente e non scrive nessun dato: chiamarla anche
    // per i moduli che allegati non ne hanno costa la stessa `listBuckets()` che l'upload
    // avrebbe fatto tre passi più giù, e garantisce il bucket a tutti e due i punti che ne
    // hanno bisogno.
    await garantisciBucket(supabase)

    const allegati = riferimentiAllegati(percorsiAllegati(modello.campi, esito.risposte))
    if (allegati.length > 0) {
      // IL PERIMETRO PRIMA DELL'ESISTENZA: un riferimento che nomina un magazzino non
      // ammesso, o una chiave che non comincia per `${alunnoId}/`, non è di questo bambino —
      // e non si va nemmeno a guardare se esiste, perché quella lettura sarebbe già un
      // oracolo. Vedi `allegatiFuoriPerimetro`.
      const fuori = allegatiFuoriPerimetro(allegati, alunnoId)
      if (fuori.length > 0) {
        // Il percorso NON entra nella riga: porta l'uuid di un altro bambino, che è un dato
        // personale altrui. Il conteggio sì, ed è ciò che serve per accorgersi che qualcuno
        // ci prova.
        logEvento('modulistica', 'warn', {
          operazione: 'parent/prestampati/firma:PATCH',
          esito: 'allegato-fuori-perimetro',
          tipo: voce.slug,
          utente: parentId,
          alunno_id: alunnoId,
          n: fuori.length,
        })
        return campiDaCorreggere(fuori)
      }
      // ── I CERTIFICATI MEDICI SI VERIFICANO SULLA RIGA, E LA QUERY STA QUI ───────────
      //
      // `alunno_id` **e** `file_path` insieme: è la stessa riga che
      // `obliaCertificatiMediciAlunno` cancella, quindi accettare solo ciò che è nominato lì
      // significa accettare solo un allegato che il giorno della richiesta di oblio se ne
      // andrà davvero. Il legame col bambino lo dichiara la tabella, non il prefisso del
      // percorso — che è una convenzione — e un file rimosso dalla riga smette di passare.
      //
      // La query vive DENTRO l'handler, come quelle dei delegati e per la stessa ragione: è
      // ancorata ad `alunnoId`, che il gate della famiglia ha verificato in questo stesso
      // handler. Fuori, quel legame non sarebbe più leggibile — né da chi rilegge il file né
      // dal lock `isolamento-sede-coverage`, che l'ha misurato: con la lettura dentro
      // `allegatiAssenti` l'handler diventa «handler-senza-scope su `certificati_medici`».
      const assenti: string[] = []
      let nonVerificabile = false
      for (const { campo, chiave } of allegati.filter((a) => a.bucket === BUCKET_CERTIFICATI)) {
        // PostgREST non lancia: il valore di ritorno va controllato, sempre.
        const { data: certificato, error: erroreCertificato } = await supabase
          .from('certificati_medici')
          .select('id')
          .eq('alunno_id', alunnoId)
          .eq('file_path', chiave)
          .maybeSingle()
        if (erroreCertificato) {
          logEvento(
            'storage',
            'error',
            {
              operazione: 'parent/prestampati/firma:PATCH',
              esito: 'allegato-non-verificato',
              bucket: BUCKET_CERTIFICATI,
              entita_tipo: 'certificati_medici',
              alunno_id: alunnoId,
              error_code: (erroreCertificato as { code?: string }).code ?? null,
            },
            erroreCertificato,
          )
          nonVerificabile = true
          break
        }
        if (!certificato) assenti.push(campo)
      }

      // Gli altri stanno nel bucket del fascicolo, dove una riga che li nomini non c'è: là
      // l'unica prova è lo storage.
      if (!nonVerificabile) {
        const verifica = await allegatiAssenti(
          supabase,
          allegati.filter((a) => a.bucket !== BUCKET_CERTIFICATI),
        )
        if (verifica.stato === 'non-verificabile') nonVerificabile = true
        else assenti.push(...verifica.assenti)
      }

      if (nonVerificabile) {
        return NextResponse.json(
          {
            error:
              'Non è stato possibile verificare i file allegati: riprova fra qualche minuto. Il codice di firma non è stato utilizzato.',
            codice: 'PRESTAMPATO_NON_GENERATO',
          },
          { status: 503 },
        )
      }
      if (assenti.length > 0) {
        logEvento('modulistica', 'warn', {
          operazione: 'parent/prestampati/firma:PATCH',
          esito: 'allegato-mancante',
          tipo: voce.slug,
          alunno_id: alunnoId,
          n: assenti.length,
        })
        return campiDaCorreggere(
          assenti.map((campo) => ({
            campo,
            messaggio:
              'Il file allegato non risulta caricato: caricalo da «Certificati medici» nell’area della famiglia e riprova.',
          })),
        )
      }
    }

    // ── Il consumo del ticket: l'ultimo gesto prima del primo effetto ────────────────
    const consumo = await consumeTicket(supabase, ticket, 'parent/prestampati/firma:PATCH')
    if ('replay' in consumo) {
      return NextResponse.json(
        {
          error: 'Codice già utilizzato, richiedine uno nuovo',
          codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
          motivo: 'gia-usato',
        },
        { status: 409 },
      )
    }
    // E il consumo si rilegge, perché `consumeTicket` su un errore DB inatteso FALLISCE
    // APERTO: dice sì senza aver scritto niente (vedi la testata). Qui, dove il passo dopo
    // produce un atto firmato, «non sono sicuro di aver consumato» vale «no».
    if (await consumoSmentito(supabase, ticket)) {
      return NextResponse.json(
        {
          error:
            'Non è stato possibile registrare l’uso del codice di firma: richiedine uno nuovo e riprova fra qualche minuto.',
          codice: 'PRESTAMPATO_NON_GENERATO',
        },
        { status: 500 },
      )
    }

    const { ip, userAgent } = extractRequestMeta(request)
    const signature_log = buildSignatureLog({
      method: 'OTP_EMAIL',
      email,
      ip,
      userAgent,
      hash: codeHash(email, String(code), Number(expiry)),
      signedAt: adesso.toISOString(),
    })

    const pdf = esito.pdf
    const impronta = createHash('sha256').update(pdf).digest('hex')

    // ── 1. La traccia FEA, prima di tutto il resto ───────────────────────────────────
    //
    // Il foglio composto qui sopra dichiara «Riferimento firma: <firmaId>». Se la riga non
    // nasce, quel riferimento non risolve — e un riferimento che non risolve è peggio di
    // nessun riferimento: chi ha in mano il documento crede di poterlo verificare. Perciò
    // qui si RIFIUTA, e si rifiuta ora che nel bucket non c'è ancora niente: nessun file
    // orfano, nessuna riga d'archivio a metà. Il codice è speso e la famiglia dovrà
    // chiederne uno nuovo, e la risposta lo dice.
    const firmaRegistrata = await registraFirma(supabase, {
      firmaId,
      parentId,
      slug: voce.slug,
      impronta,
      log: signature_log,
    })
    if (!firmaRegistrata) {
      return NextResponse.json(
        {
          error:
            'La firma non è stata registrata nel registro elettronico: richiedi un nuovo codice e riprova fra qualche minuto.',
          codice: 'PRESTAMPATO_NON_GENERATO',
        },
        { status: 500 },
      )
    }

    // ── IL N. 06 SI FERMA QUI: firmato, consegnato, e non depositato da nessuna parte ──
    //
    // `docs/prestampati/README.md:27` dichiara la firma del n. 06 «OTP + accettazione
    // direzione», e `06-autorizzazione-farmaci.md:69-72` è testuale: «lo stato è
    // `in_attesa_accettazione` finché la Direzione non accetta: un'autorizzazione firmata dal
    // solo genitore non abilita nessuno a somministrare niente. **All'accettazione** → PDF in
    // `student_documents`, `expiry_date = AL`».
    //
    // In `student_documents` non si entra perché lo stato non esiste — la tabella non ha una
    // colonna di stato (baseline: `id, student_id, document_type, file_url, expiry_date,
    // created_at, section_id, caricato_da, descrizione, file_name, storage_path`) e
    // aggiungerla è una migrazione, vietata in questo lavoro. La `descrizione` non è un
    // ripiego: è testo libero, e nessun consumatore della tabella — elenchi del fascicolo,
    // esportazioni, il cron `notifiche/scadenze-documenti` — può distinguere
    // un'autorizzazione valida da una che non autorizza niente analizzando una frase italiana.
    //
    // ⚠️ E NEL BUCKET NON SI CARICA, che è la conseguenza della riga qui sopra: nessuna riga
    // durevole nominerebbe quel percorso. `student_documents` non si scrive, `firme_documenti`
    // non ha una colonna di percorso (misurato) e `app_log` ha trenta giorni di ritenzione.
    // Passati quelli, il file — farmaco, dosaggio e riferimento alla prescrizione di un
    // minore, art. 9 — sarebbe irraggiungibile **e** incancellabile, in un bucket che l'oblio
    // non raggiunge (testata di `BUCKET_FASCICOLO`). Non sarebbe il caso raro: è il 100% delle
    // firme del n. 06. La copia che la famiglia riceve è `pdfBase64`, che è comunque l'unica
    // certa; la copia della Direzione nascerà con la schermata che la accetta, insieme alla
    // riga che la nomina — dichiarato all'orchestratore fra le funzioni mancanti.
    if (attesaAccettazioneDirezione(voce.slug)) {
      // `info` e non `warn`: `modulistica` è in `EVENTI_PERSISTITI` (`logger.ts:188`), quindi
      // la riga va in tabella lo stesso — ed è la stessa scelta della riga di successo in
      // fondo all'handler. `warn` è il canale dei problemi, e un'autorizzazione che aspetta un
      // passo di prodotto non lo è: alzarla di livello gonfierebbe l'unico canale in cui si
      // cercano i guasti veri per un esito normale e atteso.
      logEvento('modulistica', 'info', {
        operazione: 'parent/prestampati/firma:PATCH',
        esito: 'prestampato-firmato-in-attesa-accettazione',
        tipo: voce.slug,
        utente: parentId,
        alunno_id: alunnoId,
        scuola_id: prefill.scuolaId,
        riferimento: firmaId,
      })

      return NextResponse.json(
        {
          success: true,
          documentoId: null,
          archiviato: false,
          inAttesaAccettazione: true,
          /**
           * `null` e non un enumerato di fallimento: niente è andato storto, l'archivio non
           * è stato tentato. Il perché lo dice `inAttesaAccettazione`.
           */
          motivoMancatoArchivio: null,
          riferimentoFirma: firmaId,
          titolo: esito.titolo,
          url: null,
          /** L'unica copia del foglio: nel bucket non è salito, e nessun elenco lo nomina. */
          pdfBase64: Buffer.from(pdf).toString('base64'),
          signature_log,
        },
        { status: 201 },
      )
    }

    // ── 2. Il file nel bucket privato ────────────────────────────────────────────────
    //
    // Nel percorso non c'è niente di personale: uuid del bambino, slug del modello e uuid
    // della firma. Un nome dentro la chiave di un oggetto sarebbe un nome dentro ogni URL
    // firmato che l'app manda al browser.
    // Il bucket è già garantito più in alto, prima del controllo degli allegati: una sola
    // `listBuckets()` per richiesta.
    const percorso = `${alunnoId}/prestampati/${voce.slug}-${firmaId}.pdf`
    const { error: erroreUpload } = await supabase.storage
      .from(BUCKET)
      .upload(percorso, Buffer.from(pdf), { contentType: 'application/pdf', upsert: false })
    if (erroreUpload) {
      // Il documento non esiste da nessuna parte: qui il 500 è la risposta onesta, e la
      // frase di catalogo di `PRESTAMPATO_NON_GENERATO` dice proprio «non è stato archiviato
      // niente». Resta la riga di `firme_documenti`, che attesta un fatto vero — quella
      // persona ha firmato quel contenuto — e non porta con sé dati dell'art. 9.
      logEvento(
        'storage',
        'error',
        {
          operazione: 'parent/prestampati/firma:PATCH',
          esito: 'pdf-non-caricato',
          bucket: BUCKET,
          tipo: voce.slug,
          alunno_id: alunnoId,
          riferimento: firmaId,
        },
        erroreUpload,
      )
      return NextResponse.json(
        {
          error:
            'Il documento non è stato archiviato: richiedi un nuovo codice e riprova fra qualche minuto.',
          codice: 'PRESTAMPATO_NON_GENERATO',
        },
        { status: 500 },
      )
    }

    // ── 3. La riga d'archivio, quella che fa comparire il foglio nell'«Archivio firmati» ──
    //
    // 🔴 `document_type` È UN ENUMERATO, E OGGI NON CONTIENE I DICIASSETTE SLUG. Misurato in
    // produzione il 2026-08-14, in sola lettura: `document_type_enum` ha quattro valori —
    // `diagnosi`, `pei`, `104`, `pdp` — e nessuno è un prestampato. Postgres rifiuta quindi
    // l'INSERT, e dal codice non si aggira: allargare l'enumerato è una migrazione, e le
    // migrazioni su questo database sono vietate dal titolare. Non è un caso limite: finché
    // dura, è il 100% del traffico di questa rotta.
    //
    // COSA SUCCEDE QUANDO LA RIGA NON NASCE — e perché il file si toglie SOLO A VOLTE.
    //
    // Un PDF che resta nel bucket senza una riga che lo nomini è un documento invisibile:
    // nessun elenco lo mostra, nessuna query lo ritrova (`firme_documenti` non ha una
    // colonna di percorso — misurato: `id, utente_id, tipo_documento, impronta_digitale,
    // indirizzo_ip, user_agent, firmato_il`), e l'oblio non lo raggiunge — vedi la
    // dichiarazione in testa a `BUCKET_FASCICOLO`, che è la lacuna vera e non un dettaglio di
    // questo ramo. Su questa rotta quel file contiene una scheda sanitaria, una terapia o una dieta
    // di un minore: dati dell'art. 9 che nessuno sa di avere e nessuno sa cancellare.
    //
    // Che cosa se ne fa del file, quando la riga non nasce, NON lo decide questa rotta: lo
    // decide `ilFileRestaNelBucket` (`banco-famiglia.ts`), che porta la stessa regola della
    // gemella della segreteria — **il file si toglie solo quando ritentare ha senso**. Sui
    // codici dello schema il PDF resta, perché è l'unica copia recuperabile il giorno in cui
    // l'enumerato si allarga; su un singhiozzo se ne va, perché il tentativo dopo ne
    // caricherà un altro e questo resterebbe orfano per niente.
    //
    // La regola la porta `ilFileRestaNelBucket` (`banco-famiglia.ts`), che è la stessa della
    // gemella della segreteria: sui codici dello schema il PDF resta, perché è l'unica copia
    // recuperabile il giorno in cui l'enumerato si allarga; su un singhiozzo se ne va, perché
    // il tentativo dopo ne caricherà un altro e questo resterebbe orfano per niente.
    //
    // E siccome qui la firma è già stata raccolta e il codice speso, **il PDF si consegna
    // comunque nella stessa risposta** (`pdfBase64`): la famiglia ha diritto al foglio che
    // ha firmato, qualunque cosa succeda all'archivio. La risposta lo dichiara con
    // `archiviato: false`, così il client non promette un archivio che non c'è.
    //
    // ⚠️ «NON PUÒ» E «NON È RIUSCITA» NON SONO LA STESSA COSA. Un `08006` di connessione, un
    // `23503`, un timeout — cioè un singhiozzo del database — non sono «tipo di documento non
    // ammesso»: dirlo alla famiglia sarebbe una frase falsa, e il codice d'errore vero è già
    // in mano (`error_code` nella riga di log qui sotto). L'enumerato si ricava da un FATTO,
    // come `motivo: 'scaduto'` trenta righe più su.
    //
    // Le due strade sbagliate, dette perché nessuno le prenda credendole ovvie:
    //  · **ripiegare su un valore ammesso** («una scheda sanitaria è quasi una diagnosi»)
    //    metterebbe nel fascicolo di un minore un tipo di documento FALSO;
    //  · **rispondere 500 e basta** butterebbe via una firma già raccolta, cioè
    //    trasformerebbe una lacuna dello schema nella perdita di un atto.
    //
    // Il giorno in cui i diciassette slug entrano nell'enumerato, questo codice comincia ad
    // archiviare senza che nessuno lo tocchi.
    //
    // La scadenza: il n. 05 la prende dal CALENDARIO (fine anno scolastico, §05: «va
    // riconfermata ogni anno»), tutti gli altri dalle risposte con la regola condivisa della
    // segreteria. Vedi il blocco «La scadenza dell'archivio» più in alto.
    const scadenza = scadeAFineAnnoScolastico(voce.slug)
      ? fineAnnoScolastico(prefill.dati.annoScolastico)
      : scadenzaDaRisposte(esito.risposte)
    let documentoId: string | null = null
    let codiceArchivio: string | null = null
    // ⚠️ LA GUARDIA OGGI È SEMPRE VERA, e va scritto invece che lasciato scoprire: tutte e
    // otto le voci del banco «genitore» hanno `archiviazione: 'student_documents'`
    // (`src/lib/prestampati/registro.ts`), quindi il ramo `else` è irraggiungibile. Resta
    // perché il registro può cambiare — il n. 31 della segreteria, per dire, esce dalla
    // scuola e si protocolla — e il giorno in cui una voce del genitore archiviasse altrove
    // questo punto dovrà rispondere con un enumerato SUO (`archiviazione-non-supportata`) e
    // togliere comunque il file: là la riga non nascerebbe mai, e chiamarlo
    // `archivio-non-scritto` — che è dove cade oggi, con `codiceArchivio` a `null` — direbbe
    // «non è riuscita» a una cosa che non è nemmeno stata tentata.
    if (voce.archiviazione === 'student_documents') {
      // PostgREST non lancia: il valore di ritorno va controllato, sempre.
      const { data: riga, error: erroreArchivio } = await supabase
        .from('student_documents')
        .insert({
          student_id: alunnoId,
          section_id: prefill.sezioneId,
          document_type: voce.slug,
          descrizione: voce.etichetta,
          file_name: `${voce.slug}.pdf`,
          storage_path: percorso,
          // Percorso privato, non un indirizzo: il download passa da un URL firmato.
          file_url: percorso,
          expiry_date: scadenza,
          caricato_da: parentId,
        })
        .select('id')
        .single()
      if (erroreArchivio) {
        // Lo stesso codice che finisce nella riga di log decide l'enumerato e la sorte del
        // file: letto una volta, usato per tutti e due, così non possono divergere.
        codiceArchivio = (erroreArchivio as { code?: string }).code ?? null
        logEvento(
          'modulistica',
          'error',
          {
            operazione: 'parent/prestampati/firma:PATCH',
            esito: 'archivio-non-scritto',
            entita_tipo: 'student_documents',
            tipo: voce.slug,
            alunno_id: alunnoId,
            riferimento: firmaId,
            error_code: codiceArchivio,
          },
          erroreArchivio,
        )
      }
      documentoId = (riga as unknown as { id: string } | null)?.id ?? null
    }

    // ── IL REGISTRO DEGLI ACCESSI AL FASCICOLO ───────────────────────────────────────
    //
    // Regola 5 di `docs/prestampati/README.md` — «ogni lettura del fascicolo passa da
    // `fascicolo_accessi_audit`» — e vale anche quando nel fascicolo si DEPOSITA: è la
    // stessa riga che scrivono `prestampati/genera` sul proprio INSERT e
    // `primaria/fascicolo:POST` sul suo. Senza, alla famiglia che chiede «chi ha toccato il
    // fascicolo di mio figlio» si risponderebbe con metà degli eventi: la stessa scheda
    // sanitaria emessa allo sportello lascia traccia, emessa da casa no. `app_log` non è un
    // sostituto — trenta giorni di ritenzione, e non è il registro che il Garante chiede.
    //
    // Dopo l'INSERT riuscito e non prima: si registra un deposito AVVENUTO. Quando la riga
    // d'archivio non nasce (l'enumerato, oggi) non c'è nessun documento nel fascicolo, e una
    // riga d'audit racconterebbe un caricamento che non c'è stato.
    if (documentoId !== null) {
      await logAccessoFascicolo(supabase, {
        alunnoId,
        utenteId: parentId,
        azione: 'upload',
        documentoId,
        finalita: `Prestampato ${voce.slug} firmato dalla famiglia`,
        request,
      })
    }

    // ── IL FOGLIO È FIRMATO MA NON È ENTRATO IN ARCHIVIO ─────────────────────────────
    if (documentoId === null) {
      // ⚠️ IL FILE RESTA QUANDO È LO SCHEMA A NON REGGERE, e se ne va quando ritentare ha
      // senso: la regola è quella della gemella (`ilFileRestaNelBucket`). Il costo del ramo
      // «resta» è dichiarato e non è piccolo: quel file è un orfano dell'art. 9 in un bucket
      // che l'oblio non raggiunge (testata di `BUCKET_FASCICOLO`), e la riga di log qui sotto
      // è ciò che permette di ritrovarlo — `alunno_id`, `tipo` e `riferimento` SONO il
      // percorso (`<alunno_id>/prestampati/<tipo>-<riferimento>.pdf`).
      const motivoMancatoArchivio = motivoMancatoArchivioDa(codiceArchivio)
      const restaNelBucket = ilFileRestaNelBucket(motivoMancatoArchivio)
      if (!restaNelBucket) await togliDalBucket(supabase, percorso, voce.slug, firmaId)

      // Due esiti distinti e tutti e due `error`, come la gemella: il primo è la lacuna
      // dello schema — si conta, non si indaga — il secondo è un guasto vero. Con un esito
      // solo, la riga che segnala un difetto sarebbe sepolta sotto quelle che segnalano il
      // noto; con un livello più basso sul primo, il fatto che oggi NESSUNA firma entri in
      // archivio non comparirebbe fra gli errori di `/api/health`.
      logEvento('modulistica', 'error', {
        operazione: 'parent/prestampati/firma:PATCH',
        esito: restaNelBucket
          ? 'prestampato-firmato-non-archiviato'
          : 'archivio-non-scritto-file-rimosso',
        // L'enumerato viaggia in `azione`, che è nella lista bianca di `redact`: è la stessa
        // scelta del rifiuto «firma non disponibile» del POST, e per la stessa ragione —
        // `motivo` non è fra le chiavi in chiaro e uscirebbe `[redatto]`.
        azione: motivoMancatoArchivio,
        tipo: voce.slug,
        utente: parentId,
        alunno_id: alunnoId,
        scuola_id: prefill.scuolaId,
        riferimento: firmaId,
      })

      return NextResponse.json(
        {
          success: true,
          documentoId: null,
          archiviato: false,
          /** Falso per costruzione: chi aspetta la Direzione è già uscito più in alto. */
          inAttesaAccettazione: false,
          /**
           * Enumerato, non una frase: il client non deve leggere prosa per capire. E con
           * un nome suo, non `motivo`: quella chiave in questa rotta dice già un'altra cosa
           * (perché l'OTP è stato rifiutato), e due significati sotto lo stesso nome si
           * leggono sbagliati una volta e non si rileggono mai più.
           */
          motivoMancatoArchivio,
          riferimentoFirma: firmaId,
          titolo: esito.titolo,
          url: null,
          /**
           * Il foglio firmato, consegnato qui perché nel bucket può non essere rimasto — e
           * perché anche quando resta, nessun elenco lo nomina: è l'unica copia che la
           * famiglia riceve con certezza.
           */
          pdfBase64: Buffer.from(pdf).toString('base64'),
          signature_log,
        },
        { status: 201 },
      )
    }

    // ⚠️ `riferimento` E NON `firma_id`: `redact` redige per RADICE (`firma` è fra le
    // `RADICI_SEGRETE`) e la politica per nome sta sopra il ramo per tipo, quindi qualunque
    // chiave che cominci per `firma` esce `[redatto]` — anche un booleano, anche un uuid — e
    // resterebbe una riga di successo che non dice QUALE firma è stata apposta, cioè l'unica
    // chiave con cui si ricostruisce il nome del file. `riferimento` porta un uuid, che la
    // lista bianca lascia passare per FORMA: la prova è un test che legge l'uscita di
    // `redact()`, non il nome che sembrava innocuo.
    logEvento('modulistica', 'info', {
      operazione: 'parent/prestampati/firma:PATCH',
      esito: 'prestampato-firmato',
      tipo: voce.slug,
      utente: parentId,
      alunno_id: alunnoId,
      scuola_id: prefill.scuolaId,
      documento_id: documentoId,
      riferimento: firmaId,
    })

    const { data: link, error: erroreLink } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(percorso, TTL_LINK)
    if (erroreLink) {
      // L'API dello storage non lancia: ritorna `{ data, error }`. Il documento è
      // archiviato e l'Archivio firmati lo ritrova comunque — qui si perde solo l'apertura
      // immediata — ma senza questa riga si perderebbe anche il perché.
      logEvento(
        'storage',
        'warn',
        {
          operazione: 'parent/prestampati/firma:PATCH',
          esito: 'link-non-firmato',
          bucket: BUCKET,
          tipo: voce.slug,
          riferimento: firmaId,
        },
        erroreLink,
      )
    }

    return NextResponse.json(
      {
        success: true,
        /** L'id della riga di `student_documents`. */
        documentoId,
        archiviato: true,
        /**
         * Falso per costruzione: ciò che aspetta la Direzione non arriva fin qui, perché non
         * si archivia affatto. La chiave resta nella risposta di tutti e tre i rami così il
         * client la legge in un posto solo, invece di dedurne l'assenza.
         */
        inAttesaAccettazione: false,
        riferimentoFirma: firmaId,
        titolo: esito.titolo,
        url: link?.signedUrl ?? null,
        signature_log,
      },
      { status: 201 },
    )
  } catch (err) {
    logErrore({ operazione: 'parent/prestampati/firma:PATCH', stato: 500 }, err)
    return NextResponse.json(
      {
        error: 'Non è stato possibile completare la firma. Riprova fra qualche minuto.',
        codice: 'PRESTAMPATO_NON_GENERATO',
      },
      { status: 500 },
    )
  }
})

// ─── L'uso singolo del codice ───────────────────────────────────────────────────

/**
 * Il jti del ticket NON è nello store, e la rilettura è riuscita a dirlo: `true`.
 *
 * ⚠️ IL NOME DICE ESATTAMENTE CIÒ CHE LA FUNZIONE MISURA, e non «il ticket è consumato»:
 * una rilettura fallita non smentisce niente, e chiamarla al contrario avrebbe costretto a
 * restituire `true` (= consumato) proprio nel caso in cui non si sa. Qui l'unico `true` è
 * quello certo: la query è andata a buon fine e la riga non c'è.
 *
 * PERCHÉ ESISTE. `consumeTicket` (`src/lib/auth/otp-ticket.ts`) su un errore DB inatteso
 * dello store dei jti è **fail-open dichiarato**, e la ragione scritta lì — «il vincolo
 * unique su `forms_submissions` impedisce comunque la firma duplicata» — vale per il flusso
 * dei moduli, non per questo: qui a valle si scrivono `firme_documenti`, un PDF nel bucket e
 * `student_documents`, e nessuno dei tre ha un indice unico che leghi due righe allo stesso
 * ticket (misurato in sola lettura su produzione il 2026-08-14: tutte e tre le chiavi
 * primarie sono su un `id` generato). Con lo store in avaria, lo stesso codice produrrebbe
 * due atti firmati.
 *
 * IL DEGRADO, che è lo stesso della dipendenza e non uno nuovo: se la rilettura FALLISCE —
 * ed è ciò che accade sul DB della CI, dove la tabella non esiste e l'INSERT è fallito per
 * la stessa ragione — si prosegue, perché fermarsi vorrebbe dire rendere infirmabile ogni
 * prestampato su un ambiente non migrato. Su quell'ambiente l'uso singolo non è garantito da
 * niente, ed è scritto in testata invece che promesso.
 */
async function consumoSmentito(supabase: SupabaseClient, ticket: string): Promise<boolean> {
  const jti = ticketJti(ticket)
  // PostgREST non lancia: il valore di ritorno va controllato, sempre.
  const { data, error } = await supabase
    .from('otp_ticket_consumati')
    .select('jti')
    .eq('jti', jti)
    .maybeSingle()
  if (error) {
    logEvento(
      'otp',
      'warn',
      {
        operazione: 'parent/prestampati/firma:PATCH',
        esito: 'consumo-non-riletto',
        error_code: (error as { code?: string }).code ?? null,
      },
      error,
    )
    return false
  }
  if (data) return false

  // Qui `consumeTicket` ha detto sì e la riga non c'è: è il ramo fail-open della
  // dipendenza, e su questa strada è l'unica cosa che separa un codice da due documenti
  // firmati. `error` e non `warn`: è il guasto che la regola 4 di AGENTS.md chiama incidente.
  logEvento('otp', 'error', {
    operazione: 'parent/prestampati/firma:PATCH',
    esito: 'consumo-non-registrato',
  })
  return true
}

// ─── L'archiviazione ────────────────────────────────────────────────────────────

/**
 * Il bucket privato esiste, o si crea — con i parametri di TUTTI, non con i propri.
 *
 * ⚠️ L'ESITO SI CONTROLLA: `listBuckets()` e `createBucket()` **ritornano `{ data, error }`**,
 * non lanciano — stessa forma di PostgREST, AGENTS.md regola 7. Un `try/catch` da solo non
 * scatterebbe mai su quel caso, e la causa che spiega i caricamenti falliti («il bucket non
 * c'era e non si è potuto creare») andrebbe persa insieme al corpo dell'errore del provider,
 * che è il difetto che AGENTS.md §3 nomina per nome. Il `try/catch` resta per ciò che
 * un'eccezione la solleva davvero (rete, fetch interrotta).
 *
 * L'errore non ferma la richiesta: l'upload subito dopo ha il proprio, e sarà quello a
 * decidere. Qui si registra soltanto.
 */
async function garantisciBucket(supabase: SupabaseClient): Promise<void> {
  try {
    const { data: elenco, error: erroreElenco } = await supabase.storage.listBuckets()
    if (erroreElenco) {
      logEvento(
        'storage',
        'error',
        { operazione: 'parent/prestampati/firma:PATCH', bucket: BUCKET, esito: 'bucket-non-elencato' },
        erroreElenco,
      )
      return
    }
    if (elenco?.some((b) => b.name === BUCKET)) return

    const { error: erroreCreazione } = await supabase.storage.createBucket(BUCKET, {
      public: false,
      allowedMimeTypes: BUCKET_MIME,
      fileSizeLimit: BUCKET_DIMENSIONE_MAX,
    })
    if (erroreCreazione) {
      logEvento(
        'storage',
        'error',
        { operazione: 'parent/prestampati/firma:PATCH', bucket: BUCKET, esito: 'bucket-non-creato' },
        erroreCreazione,
      )
    }
  } catch (e) {
    logEvento(
      'storage',
      'warn',
      { operazione: 'parent/prestampati/firma:PATCH', bucket: BUCKET, esito: 'bucket-non-verificato' },
      e,
    )
  }
}

/**
 * Toglie dal bucket il PDF che nessuna riga nominerà.
 *
 * `storage.remove()` ritorna `{ data, error }` come tutto il resto: se anche il ritiro
 * fallisce il file resta lì davvero, e allora la riga di log è l'unico posto in cui quel
 * percorso esiste ancora scritto da qualche parte — per questo `riferimento` ci va, ed è
 * un uuid che la redazione lascia passare.
 */
async function togliDalBucket(
  supabase: SupabaseClient,
  percorso: string,
  slug: string,
  firmaId: string,
): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([percorso])
  if (error) {
    logEvento(
      'storage',
      'error',
      {
        operazione: 'parent/prestampati/firma:PATCH',
        esito: 'pdf-orfano-non-rimosso',
        bucket: BUCKET,
        tipo: slug,
        riferimento: firmaId,
      },
      error,
    )
  }
}

/**
 * La traccia di firma in `firme_documenti` — il registro FEA che il baseline descrive come
 * «valore legale per autorizzazioni e gite», con l'impronta SHA-256 del documento firmato.
 *
 * I campi arrivano dal `signature_log` canonico (`buildSignatureLog`) e non da letture
 * fatte a mano: è la stessa forma delle firme di `forms_submissions`, e il giorno in cui i
 * prestampati avranno una colonna `jsonb` il log ci finisce dentro senza doverlo ricomporre.
 *
 * ─── 🔴 LA REGOLA 2 È FATTA A METÀ, E LA METÀ MANCANTE È LA RICEVUTA ────────────
 *
 * `docs/prestampati/README.md` chiede che ogni firma «scriva in `firme_documenti` **e renda
 * scaricabile la ricevuta FEA** di `src/lib/fea/receipt-pdf.ts`». La prima metà è questa
 * funzione; la seconda non esiste, e non per dimenticanza di una riga. Misurato il
 * 2026-08-14:
 *
 *  · `GET /api/fea/receipt` accetta `entita: z.enum(['pagella','giustifica','forms'])` e non
 *    conosce i prestampati: `resolveEntita` legge `pagella_ricezioni`, `presenze`,
 *    `forms_submissions` — tre tabelle che qui non c'entrano;
 *  · `firme_documenti` ha `id, utente_id, tipo_documento, impronta_digitale, indirizzo_ip,
 *    user_agent, firmato_il` e **nessuna colonna `jsonb`**: l'email del firmatario e l'hash
 *    del codice, che la ricevuta stampa, non vengono conservati da nessuna parte — il
 *    `signature_log` composto nel PATCH viaggia solo dentro la risposta 201;
 *  · il client la ricevuta la promette già: `messages/it/prestampatiGenitore.json` ha la
 *    voce `scaricaRicevuta` («Scarica la ricevuta della firma»).
 *
 * Quindi la ricevuta di una firma su prestampato non è ricostruibile né oggi né domani, e
 * serve: un ramo `prestampato` in `resolveEntita` che legga `firme_documenti` per id, più la
 * colonna dove mettere il log. Sono file di altre mani e una migrazione: dichiarato
 * all'orchestratore fra le funzioni mancanti, non lasciato all'inferenza di chi rilegge.
 *
 * ⚠️ `indirizzo_ip` è `inet NOT NULL`, e `extractRequestMeta` restituisce `'N.D.'` quando
 * l'intestazione non c'è: passarlo così farebbe rifiutare l'INSERT con `22P02` e la firma
 * resterebbe fuori dal registro per una riga di intestazione mancante. `0.0.0.0` è il
 * segnaposto, e la riga di log dichiara quando è stato usato — così «indirizzo ignoto» non
 * si confonde con un indirizzo vero.
 */
async function registraFirma(
  supabase: SupabaseClient,
  a: {
    firmaId: string
    parentId: string
    slug: string
    impronta: string
    log: ReturnType<typeof buildSignatureLog>
  },
): Promise<boolean> {
  const ip = /^[0-9a-f.:]+$/i.test(a.log.ip) ? a.log.ip : '0.0.0.0'
  if (ip !== a.log.ip) {
    logEvento('fea', 'warn', {
      operazione: 'parent/prestampati/firma:PATCH',
      esito: 'indirizzo-ip-non-pervenuto',
      tipo: a.slug,
    })
  }

  const { error } = await supabase.from('firme_documenti').insert({
    id: a.firmaId,
    utente_id: a.parentId,
    tipo_documento: a.slug,
    impronta_digitale: `SHA256-${a.impronta}`,
    indirizzo_ip: ip,
    user_agent: a.log.user_agent,
    firmato_il: a.log.signed_at,
  })
  if (error) {
    logEvento(
      'fea',
      'error',
      {
        operazione: 'parent/prestampati/firma:PATCH',
        esito: 'firma-non-registrata',
        entita_tipo: 'firme_documenti',
        tipo: a.slug,
        riferimento: a.firmaId,
        error_code: (error as { code?: string }).code ?? null,
      },
      error,
    )
    return false
  }
  return true
}
