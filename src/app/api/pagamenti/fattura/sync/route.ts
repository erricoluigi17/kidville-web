import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import {
  arubaSignin,
  arubaGetByFilename,
  resolveArubaCredentials,
  PAUSA_FRA_PAGINE_MS,
  type ArubaConfig,
  type ArubaInvoiceStatus,
} from '@/lib/aruba/client'
import {
  mapStatoAruba,
  aggregaFatturaStato,
  etichettaStatoAruba,
  motivoScartoAruba,
  type RigaFatturaAgg,
} from '@/lib/aruba/stato'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { segretoCronValido } from '@/lib/security/segreto-cron'

// POST /api/pagamenti/fattura/sync — polling stato SDI delle fatture in volo.
// SERVICE-TO-SERVICE: richiede header `x-cron-secret` (pattern push/dispatch).
// Lo invoca il cron pg_cron (vedi migrazione). Per ogni fattura non terminale
// interroga Aruba, mappa lo stato (DL-020) e, su scarto, notifica la Segreteria.
/**
 * Gli stati che il cron rinterroga. Lo `0` è la voce importante, ed è entrata il 2026-09-11.
 *
 * `0` è «non ancora interpretato» (vedi `CODICE_NON_INTERPRETATO` in `stato.ts`): non è uno
 * stato che Aruba abbia mai risposto, è ciò che scriviamo quando NON abbiamo capito la sua
 * risposta. Fino al 2026-09-11 il client leggeva lo stato dal posto sbagliato e scriveva `0`
 * ogni volta; `0` non era in questa lista, quindi ogni fattura veniva interrogata UNA volta
 * sola — la prima — e restava congelata per sempre. **153 righe** erano ferme così, e quattro
 * di quelle risultavano SCARTATE su Aruba: fatture NON emesse, da correggere e ritrasmettere,
 * che in Segreteria apparivano come tutte le altre.
 *
 * Corretta la lettura (client.ts), lo `0` nasce ormai solo da una dicitura che Aruba ha
 * risposto e che la nostra tabella non conosce — un caso raro e già gridato a livello `error`
 * dal client — quindi la coda non cresce senza controllo. Ma le righe storiche non
 * rientrerebbero da sole: è questa riga che le ripesca.
 */
const STATI_IN_VOLO = [0, 1, 3, 5]

const postQuerySchema = z.object({}) // nessun parametro in ingresso

// Battito cardiaco del cron: pg_net chiama in fire-and-forget con `EXCEPTION WHEN OTHERS
// THEN null`, quindi un job che non parte non lascia traccia — si sorveglia l'ASSENZA.
// `operazione` e non `job` (lista bianca di `redact`), e il nome nel `msg` perché
// `app_log` deduplica per (fingerprint, giorno) e il `contesto` NON è nell'impronta.
// La spiegazione per esteso è in `src/app/api/push/dispatch/route.ts`.
const JOB = 'fattura-sync'

/* ────────────────────────────────────────────────────────────────────────────
 * IL RITMO DEL GIRO. Aggiunto il 2026-09-11 insieme allo `0` in `STATI_IN_VOLO`.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ LO `0` IN CODA HA RIEMPITO UNA CODA CHE ERA VUOTA, e questo giro non era
 * dimensionato per una coda piena.
 *
 * Prima del 2026-09-11 `STATI_IN_VOLO` era `[1, 3, 5]` e in produzione trovava
 * **zero righe**: il ciclo non partiva mai, quindi nessuno si era accorto che
 * dentro non c'è **nessuna pausa** fra una chiamata ad Aruba e la successiva,
 * con un `.limit(200)`. Ammesso lo `0`, al primo giro dopo il rilascio
 * rientrano in coda le **153 righe** congelate — cioè fino a 200
 * `getByFilename` di fila, a raffica.
 *
 * Il tetto vero: SLA §3 di Aruba dà **12 richieste al minuto per IP** sulla
 * ricerca delle fatture inviate — **una ogni cinque secondi** — e «rifiuta
 * istantaneamente con HTTP 429» senza accodare (la citazione per esteso sta su
 * `PAUSA_FRA_PAGINE_MS`, in `client.ts`). Duecento richieste senza pause sono
 * due ordini di grandezza sopra, e i `429` non li prenderebbe solo questo giro:
 * il secchio è per IP, quindi si porterebbe via anche lo slot di chi in quel
 * momento sta emettendo dal pannello.
 *
 * La mitigazione è in tre pezzi, e sono tutti e tre necessari:
 *
 *  1. `TETTO_PER_GIRO` — quante righe al massimo si toccano in un tick;
 *  2. `PAUSA_FRA_PAGINE_MS` prima di OGNI `getByFilename` (la stessa costante
 *     che governa la paginazione, perché è lo stesso secchio);
 *  3. `TETTO_TEMPO_MS` — si smette prima che sia la piattaforma a interrompere
 *     a metà di una scrittura.
 *
 * ⏱️ IL CONTO, detto prima che qualcuno lo scopra: 30 righe × 5 s = 150 s di
 * sole attese, più il tempo di risposta e le scritture. Le 153 righe congelate
 * rientrano quindi in **~6 tick**, cioè circa tre ore con il cron ogni trenta
 * minuti. È lento di proposito: la coda si sta svuotando di un arretrato, non
 * inseguendo un evento.
 */
const TETTO_PER_GIRO = 30

/**
 * Quando si smette di prendere righe nuove, anche se il tetto qui sopra non è
 * stato raggiunto.
 *
 * `maxDuration` è 300 s: senza questo margine, un giro lento verrebbe
 * interrotto DALLA PIATTAFORMA in un punto qualunque — magari fra l'UPDATE di
 * `fatture_emesse` e quello di `pagamenti`, che è esattamente la divergenza
 * permanente fra le due tabelle contro cui questo file mette una guardia più
 * sotto. Sessanta secondi di margine coprono l'ultima iterazione (il tetto di
 * `externalFetch` per Aruba è 30 s per singola richiesta) e la sua coda di
 * scritture.
 */
const TETTO_TEMPO_MS = 240_000

/**
 * `maxDuration` è la dichiarazione di quanto può durare la route, e con le pause
 * qui sopra questo giro dura minuti, non secondi. Senza, la piattaforma taglia
 * al default e la coda non si svuota mai.
 *
 * 300 è il valore già usato dalle altre tre route lunghe del repository
 * (`fattura`, `fattura/lotto`, `riconciliazione`): stesso limite, stessa ragione.
 */
export const maxDuration = 300

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Query fallita → riga d'errore parlante + 500, e NESSUN battito «ok».
 *
 * PostgREST non lancia, ritorna `{ error }` (regola 7 di AGENTS.md): il `try/catch` di questo
 * handler non scatta mai su una query rotta. Qui il ramo non controllato è particolarmente
 * insidioso perché la route ha già una nozione legittima di «salto questa scuola»
 * (`credenziali-mancanti`): una lettura fallita ci si travestirebbe dentro, e il giro
 * chiuderebbe «ok» mentre uno scarto SDI resta invisibile. La spiegazione per esteso è in
 * `src/app/api/push/dispatch/route.ts`.
 */
function queryFallita(azione: string, error: unknown, t0: number, scuolaId?: string): NextResponse {
  // `scuola_id` è un uuid: `redact` lascia in chiaro i valori auto-descrittivi, quindi anche
  // nella riga persistita si legge QUALE scuola stava fallendo.
  logEvento(
    'cron',
    'error',
    {
      operazione: JOB,
      esito: 'query-fallita',
      azione,
      scuola_id: scuolaId,
      ms: Date.now() - t0,
      msg: `${JOB}: ${azione} fallita`,
    },
    error,
  )
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
}

export const POST = withRoute('pagamenti/fattura/sync:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!segretoCronValido(secret)) {
      // Si grida SOLO se l'header c'è ma non torna: quello è un cron che bussa con la chiave
      // sbagliata, ed è il guasto invisibile (se questo giro non parte, le fatture restano «in
      // volo» per sempre e nessuno si accorge di uno scarto SDI). Sul POST ANONIMO si tace: la
      // route è pubblica e senza rate-limit, e una riga `error` per ogni `curl` fabbricherebbe
      // dal nulla proprio il segnale «il cron è rotto» che questa riga serve a portare.
      // Il messaggio separa i due incidenti veri (secret sbagliato nel Vault del DB;
      // `CRON_SECRET` assente su Vercel — quest'ultimo già gridato dal preflight di
      // `src/instrumentation.ts`).
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }
    logEvento('cron', 'info', { operazione: JOB, esito: 'avviato', msg: `${JOB}: avviato` })

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const { data: pendenti, error: errPendenti } = await supabase
      .from('fatture_emesse')
      .select('id, pagamento_id, scuola_id, numero, aruba_filename, sdi_stato')
      .in('sdi_stato', STATI_IN_VOLO)
      .not('aruba_filename', 'is', null)
      // Era 200. Vedi `TETTO_PER_GIRO`: con lo `0` in `STATI_IN_VOLO` questa query
      // ha smesso di tornare vuota, e duecento chiamate ad Aruba senza pause sono
      // ~17 volte il limite dichiarato di 12/min.
      .limit(TETTO_PER_GIRO)
    // Senza questo controllo «la query è fallita» e «nessuna fattura in volo» sono lo stesso
    // ramo — e il secondo chiude con un «ok».
    if (errPendenti) return queryFallita('lettura fatture_emesse', errPendenti, t0)

    const righe = (pendenti ?? []) as {
      id: string
      pagamento_id: string
      scuola_id: string
      numero: number
      aruba_filename: string
      sdi_stato: number
    }[]
    if (righe.length === 0) {
      // Nessuna fattura in volo: è il caso normale, e ha comunque bisogno del suo «ok» —
      // senza, il giro più frequente sembrerebbe partito e mai finito.
      logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'ok',
        ms: Date.now() - t0,
        processate: 0,
        scartate: 0,
        skipped: 0,
        msg: `${JOB}: ok`,
      })
      return NextResponse.json({ success: true, data: { processate: 0, scartate: 0, skipped: 0 } })
    }

    const configCache = new Map<string, ArubaConfig | null>()
    /**
     * ⚠️ LA CHIAVE È L'UTENZA ARUBA, NON LA SCUOLA, e la differenza vale dei `429`.
     *
     * Era `scuola_id`, e su tre sedi produceva **tre `signin` di fila** — mentre Aruba
     * ne concede **uno al minuto per IP**. Il secondo e il terzo prendevano `429` da
     * soli, e il giro si portava via anche lo slot di chiunque altro stesse emettendo:
     * il 2026-09-07 un `signin` del lotto ha preso `429` con novanta secondi di
     * intervallo, e questo cron gira ogni trenta minuti.
     *
     * Le tre sedi usano **una sola utenza** (`aruba_config->>'username'` distinto = 1
     * su 3, misurato): chiavare sull'utenza fa un accesso solo e non aspetta niente.
     * Se un giorno le utenze diventassero davvero tre, la chiave le distinguerebbe da
     * sé — ed è il motivo per cui non è semplicemente una variabile fuori dal ciclo.
     */
    const tokenCache = new Map<string, string>()
    const chiaveUtenza = (ambiente: string | undefined, username: string) => `${ambiente ?? 'demo'}|${username}`
    // Scuole saltate per gating credenziali: MAI in silenzio (M2.4) — contate,
    // loggate e riportate nella risposta con il motivo.
    const scuoleSkipped = new Set<string>()
    let processate = 0
    let scartate = 0
    let esaminate = 0
    /** Vero se si è usciti dal ciclo per tempo, non per esaurimento delle righe. */
    let interrottoPerTempo = false

    for (const f of righe) {
      // ── SI SMETTE PRIMA CHE SIA LA PIATTAFORMA A INTERROMPERE ────────────────
      // `maxDuration` tagliato a metà di una riga lascerebbe `fatture_emesse`
      // aggiornata e `pagamenti` no: la divergenza permanente contro cui questo
      // file mette una guardia esplicita duecento righe più sotto. Le righe non
      // toccate NON si perdono — restano in `STATI_IN_VOLO` e il tick successivo
      // le ripesca — ma il fatto di aver smesso va detto, altrimenti un giro
      // parziale si legge come un giro completo.
      if (Date.now() - t0 > TETTO_TEMPO_MS) {
        interrottoPerTempo = true
        break
      }
      // config + credenziali per scuola
      if (!configCache.has(f.scuola_id)) {
        const { data: settings, error } = await supabase
          .from('admin_settings')
          .select('aruba_config')
          .eq('scuola_id', f.scuola_id)
          .maybeSingle()
        // Una lettura fallita darebbe `cfg = null` → la scuola verrebbe saltata con il `warn`
        // `credenziali-mancanti`, cioè con una DIAGNOSI SBAGLIATA: chi legge quella riga va a
        // configurare Aruba per una scuola che Aruba ce l'ha già. Un log che accusa il posto
        // sbagliato fa perdere più tempo di un log che manca.
        if (error) return queryFallita('lettura admin_settings', error, t0, f.scuola_id)
        configCache.set(f.scuola_id, (settings?.aruba_config ?? null) as ArubaConfig | null)
      }
      const cfg = configCache.get(f.scuola_id)
      const creds = cfg ? resolveArubaCredentials(cfg) : null
      if (!cfg?.abilitato || !creds) {
        if (!scuoleSkipped.has(f.scuola_id)) {
          scuoleSkipped.add(f.scuola_id)
          // `warn` e non `error`: una scuola con Aruba deliberatamente spento è la
          // normalità, non un incidente. Ma non può sparire in silenzio (M2.4) — le sue
          // fatture restano in volo per sempre e il giro chiude comunque «ok».
          // `scuola_id` è un uuid: `redact` lascia in chiaro i valori auto-descrittivi,
          // quindi si legge QUALE scuola anche nella riga persistita.
          logEvento('cron', 'warn', {
            operazione: JOB,
            esito: 'credenziali-mancanti',
            scuola_id: f.scuola_id,
            abilitato: Boolean(cfg?.abilitato),
            msg: `${JOB}: scuola saltata, credenziali Aruba non configurate`,
          })
        }
        continue
      }

      // token (uno per scuola)
      const chiave = chiaveUtenza(cfg.ambiente, creds.username)
      let token = tokenCache.get(chiave)
      if (!token) {
        try {
          token = (await arubaSignin(cfg.ambiente, creds)).accessToken
          tokenCache.set(chiave, token)
        } catch (e) {
          // Era un `catch { continue }` MUTO, ed è il divieto n° 6 di AGENTS.md: se il
          // login ad Aruba fallisce (password ruotata, ambiente sbagliato, SDI giù) le
          // fatture di questa scuola non vengono più interrogate — e la route risponde
          // 200 con `processate: 0`, che si legge come «niente da fare».
          logEvento('cron', 'error', { operazione: JOB, esito: 'aruba-signin-fallita', scuola_id: f.scuola_id }, e)
          continue
        }
      }

      // stato Aruba
      // Il tipo del client, non una copia locale: la copia era ferma a `{ stato, pdfBase64 }` e
      // avrebbe fatto sparire in silenzio la dicitura di Aruba appena aggiunta.
      let stato: ArubaInvoiceStatus
      // ── UNA OGNI CINQUE SECONDI, PERCHÉ IL SECCHIO È PER IP ─────────────────
      // SLA §3: 12 ricerche al minuto per IP, rifiuto istantaneo con `429`, nessun
      // accodamento. Qui non c'era nessuna pausa, e non si vedeva perché la coda era
      // vuota: con lo `0` ammesso in `STATI_IN_VOLO` il ciclo gira davvero, e al primo
      // tick dopo il rilascio ci sono 153 righe che rientrano.
      //
      // FRA una chiamata e l'altra, non PRIMA della prima: è la stessa forma di
      // `arubaUltimiNumeriFattura` (`client.ts`, `if (!primaRichiesta) await attendi(…)`).
      // La pausa serve a distanziare due richieste consecutive; davanti alla prima non c'è
      // niente da distanziare dentro questa invocazione, e il tick precedente è a trenta
      // minuti di distanza. Il `signin` appena fatto porta il burst a due richieste in
      // tutto — la misura del 2026-09-02 vedeva il `429` alla NONA. Cinque secondi
      // spesi lì non comprerebbero niente e li pagherebbe ogni giro, anche quello che
      // trova una riga sola.
      if (esaminate > 0) await attendi(PAUSA_FRA_PAGINE_MS)
      esaminate++
      try {
        stato = await arubaGetByFilename(cfg.ambiente, token, f.aruba_filename, { includePdf: true })
      } catch (e) {
        // Stesso argomento del signin: senza questa riga, una fattura che Aruba non sa più
        // rileggere resta in volo all'infinito senza che nessuno sappia perché.
        logEvento('cron', 'error', { operazione: JOB, esito: 'aruba-stato-fallito', scuola_id: f.scuola_id }, e)
        continue
      }
      if (stato.stato === f.sdi_stato) continue // nessun cambiamento

      const m = mapStatoAruba(stato.stato)
      // LA PAROLA DI ARUBA ARRIVA FINO AL REGISTRO. `m.label` è la NOSTRA traduzione; quando
      // diverge dalla dicitura del provider si scrivono tutte e due — «Recapito impossibile
      // (depositata) — Aruba: «Non consegnata»». Il corpo del provider non si butta via
      // (AGENTS.md, regola 3): una traduzione che cancella l'originale toglie l'unico modo di
      // accorgersi che è sbagliata — ed è appunto il difetto che si sta chiudendo.
      //
      // ⚠️ NON PER IL WORM, e la precisazione serve perché qui c'era scritto il contrario.
      // Una versione di questo commento sosteneva che `sdi_stato_label` e `sdi_scarto_motivo`
      // fossero immutabili «dove ciò che si scrive non si corregge più». È falso:
      // `supabase/migrations/20260711150000_worm_registri_fiscali.sql` elenca le colonne che il
      // trigger blocca (numero, anno, importo, scuola_id, pagamento_id, xml_inviato,
      // quota_adult_id, progressivo_invio, intestatario, bollo_virtuale, creato_il) e queste due
      // NON ci sono — l'intestazione della migrazione dice l'opposto esatto, che lo stato SDI
      // «resta modificabile, aggiornato dal polling/sync». È questa route a riscriverle a ogni
      // tick, e non potrebbe funzionare altrimenti. Il WORM vieta il DELETE della RIGA e il
      // cambio dei campi FISCALI: è una protezione vera, e attribuirle una copertura che non ha
      // è il modo in cui poi qualcuno si fida della protezione sbagliata.
      const etichetta = etichettaStatoAruba(m, stato.statoAruba)
      // IL MOTIVO DELLO SCARTO È UN CAMPO A PARTE, e non è una copia dell'etichetta.
      // Fino al 2026-09-11 qui andava `m.isScarto ? etichetta : null`, cioè «Scartata dallo SDI
      // — Aruba: «Scartata»»: la stessa frase già presente in `sdi_stato_label`, e zero
      // informazione su PERCHÉ. Per le quattro fatture che al 2026-09-11 risultano scartate su
      // Aruba quel campo è il dato con cui la Segreteria le corregge e le ritrasmette.
      // `emissione.ts:2166` scrive già `errorDescription` in questa stessa colonna sul percorso
      // di upload: qui il polling smette di essere incoerente col proprio file.
      const motivo = motivoScartoAruba(m, stato.statoAruba, {
        descrizioneAruba: stato.descrizioneAruba,
        errorCode: stato.errorCode,
        errorDescription: stato.errorDescription,
      })
      const nowIso = new Date().toISOString()

      // copia di cortesia PDF (best-effort) su stato valido. Chiave PER RIGA
      // (${pagamento}-${numero}.pdf): con più quote la 2ª non sovrascrive la 1ª.
      let pdfPath: string | null = null
      // ── TRE CAUSE DIVERSE, TRE RIGHE DIVERSE ───────────────────────────────────
      // Le prime due versioni del blocco qui sotto scrivevano `esito` e `msg` IDENTICI su
      // due rami diversi, ed era un difetto per conto suo: `messaggio` entra nell'impronta
      // di `app_log` e il `contesto` NO (vedi `logger.ts`), quindi le due cause collassavano
      // in una sola riga `(fingerprint, giorno)` — che conserva contesto ed errore della
      // PRIMA occorrenza. Un bucket che rifiuta la chiave e un base64 corrotto diventavano
      // indistinguibili, e la riga superstite attribuiva l'accaduto alla causa sbagliata.
      //
      // La funzione sta FUORI dal `try` perché la usa anche il `catch`: dichiarata dentro,
      // nel ramo d'eccezione non esisterebbe.
      //
      // `evento: 'cron'` e non `'storage'`: queste righe appartengono al giro del job, e chi
      // sorveglia il job interroga `where evento = 'cron'`. Spostarle altrove le toglierebbe
      // proprio dalla query in cui servono.
      //
      // ⚠️ `numero` e `fattura_id` stanno nei CAMPI e non nel `msg`, ed è deliberato: nel
      // messaggio renderebbero ogni fattura un'impronta a sé — cioè la fine della deduplica,
      // che esiste per non farsi sommergere. Nei campi si legge la PRIMA occorrenza del
      // giorno, col contatore `occorrenze` accanto. È lo stesso compromesso già preso dal log
      // `scarto-senza-destinatari` più sotto. Sono un intero e un uuid: `redact` li lascia in
      // chiaro anche nella riga persistita, ed è ciò che rende la riga azionabile — senza,
      // dice solo «in questa sede una fattura è senza PDF».
      const pdfNonCaricato = (esitoLog: string, testo: string, errore?: unknown) => {
        pdfPath = null
        logEvento(
          'cron',
          'error',
          {
            operazione: JOB,
            esito: esitoLog,
            scuola_id: f.scuola_id,
            fattura_id: f.id,
            numero: f.numero,
            bucket: 'fatture',
            msg: `${JOB}: ${testo}`,
          },
          errore,
        )
      }
      if (!m.isScarto && stato.pdfBase64) {
        pdfPath = `${f.pagamento_id}-${f.numero}.pdf` // chiave relativa al bucket "fatture"
        try {
          const storage = (
            supabase as {
              storage?: {
                from: (b: string) => {
                  upload: (
                    p: string,
                    d: Buffer,
                    o?: unknown,
                  ) => Promise<{ error?: unknown } | null | undefined>
                }
              }
            }
          ).storage
          const esitoUpload = await storage?.from('fatture').upload(
            pdfPath,
            Buffer.from(stato.pdfBase64, 'base64'),
            { contentType: 'application/pdf', upsert: true },
          )
          // ⚠️ `supabase-storage-js` NON LANCIA: `upload` ritorna `{ data, error }`, esattamente
          // come PostgREST (AGENTS.md, regola 7). Il valore di ritorno era SCARTATO, quindi il
          // `catch` qui sotto — che azzera `pdfPath` e scrive `pdf-copia-fallita` — non scattava
          // MAI per un errore dello Storage: bucket pieno, chiave rifiutata, permesso negato
          // uscivano tutti da questo blocco come un successo, `pdf_path` finiva a registro, e
          // `/api/pagamenti/fattura` andava poi a cercare un file che non c'era. Nessun log.
          // È lo STESSO difetto che `fattura/route.ts` dichiara già corretto sul `download`
          // (vedi il commento di `scaricaPdf`): era rimasto in piedi sull'`upload`.
          //
          // Un esito ASSENTE conta come fallimento: se `storage` non c'è, `storage?.` corto-
          // circuita e l'upload non è mai partito — scrivere `pdf_path` sarebbe una bugia.
          //
          // Livello `error` e non più `warn`, per la stessa ragione di `scaricaPdf`: non è un
          // risultato degradato, è un risultato ASSENTE. Il genitore apre la fattura e non
          // ottiene niente, e lo stato SDI (che intanto viene salvato lo stesso, ed è giusto
          // così) non basta a fargliela avere.
          if (!esitoUpload) {
            // Il client dello Storage non c'è: `storage?.` ha corto-circuitato e l'upload
            // non è MAI PARTITO. Non è un rifiuto del bucket, è una forma inattesa del
            // client Supabase — diagnosi opposta, e mandarci dietro chi legge a
            // controllare i permessi del bucket è tempo buttato.
            pdfNonCaricato(
              'pdf-storage-assente',
              'client Storage non disponibile, upload del PDF mai partito',
            )
          } else if (esitoUpload.error) {
            // Lo Storage ha risposto e ha detto di no: bucket pieno, chiave rifiutata,
            // permesso negato. Il corpo dell'errore del provider viaggia come `cause`
            // (AGENTS.md, regola 3): senza, resterebbe «non caricato» e basta.
            pdfNonCaricato(
              'pdf-copia-rifiutata',
              'lo Storage ha rifiutato il PDF, la fattura resta senza copia',
              esitoUpload.error,
            )
          }
        } catch (e) {
          // Resta a coprire ciò che può lanciare davvero: `Buffer.from` su un base64 corrotto,
          // o un guasto di trasporto sotto il client dello Storage. `esito` e `msg` diversi da
          // quelli dei due rami qui sopra: è un'altra causa, e deve restare un'altra riga.
          pdfNonCaricato(
            'pdf-copia-eccezione',
            'eccezione durante la copia del PDF, la fattura resta senza copia',
            e,
          )
        }
      }

      const { error: errUpdFattura } = await supabase
        .from('fatture_emesse')
        .update({
          sdi_stato: stato.stato,
          sdi_stato_label: etichetta,
          sdi_scarto_motivo: motivo,
          ...(pdfPath ? { pdf_path: pdfPath } : {}),
          aggiornata_il: nowIso,
        })
        .eq('id', f.id)
      // Se questa UPDATE salta in silenzio, la fattura resta «in volo» e il giro dopo la
      // ripesca: si ripete all'infinito senza che nessuno sappia perché.
      if (errUpdFattura) return queryFallita('aggiornamento fatture_emesse', errUpdFattura, t0, f.scuola_id)

      // Stato aggregato del pagamento dalle sue quote. Rileggo tutte le righe e
      // sostituisco in memoria quella appena aggiornata (la SELECT potrebbe non
      // riflettere ancora l'update appena fatto).
      const { data: tutte, error: errTutte } = await supabase
        .from('fatture_emesse')
        .select('id, numero, sdi_stato, quota_adult_id, pdf_path')
        .eq('pagamento_id', f.pagamento_id)
      // LA LETTURA PIÙ VELENOSA DEL FILE, perché il suo fallimento non si limita a tacere: SCRIVE
      // IL FALSO. Con `tutte` a `null`, `righeAgg` è `[]` → `aggregaFatturaStato([])` vale
      // `in_attesa` → il pagamento verrebbe riscritto «in attesa» anche per una fattura appena
      // CONSEGNATA o SCARTATA, con una conseguenza fiscale. Un aggregato calcolato su una lettura
      // fallita non è un aggregato: è un'invenzione. Si esce prima di scrivere.
      if (errTutte) return queryFallita('rilettura quote fattura', errTutte, t0, f.scuola_id)
      const righeAgg = ((tutte ?? []) as (RigaFatturaAgg & { id: string; pdf_path: string | null })[]).map((r) =>
        r.id === f.id ? { ...r, sdi_stato: stato.stato, pdf_path: pdfPath ?? r.pdf_path } : r
      )
      const statoAgg = aggregaFatturaStato(righeAgg)
      // fattura_pdf_path resta sul pagamento SOLO per fattura singola (compat legacy);
      // con più quote il download è per-fattura (vedi /api/pagamenti/fattura?fattura_id=).
      const pdfSingola = righeAgg.length <= 1 ? righeAgg[0]?.pdf_path ?? null : null

      const { error: errUpdPagamento } = await supabase
        .from('pagamenti')
        .update({ fattura_stato: statoAgg, ...(pdfSingola ? { fattura_pdf_path: pdfSingola } : {}) })
        .eq('id', f.pagamento_id)
      // La fattura è già stata marcata terminale qui sopra: se questa UPDATE salta e tace, il
      // pagamento resta «in attesa» per sempre — e il giro successivo NON lo ripesca (la fattura
      // non è più in volo). Divergenza permanente fra le due tabelle, e nessuno lo saprebbe.
      if (errUpdPagamento) return queryFallita('aggiornamento pagamenti', errUpdPagamento, t0, f.scuola_id)
      processate++

      if (m.isScarto) {
        scartate++
        // L'APPARTENENZA A UNA SEDE NON È `utenti.scuola_id`: è l'unione fra quella colonna e
        // il ponte `utenti_scuole`. Qui c'era la query nuda, e per una fattura delle sedi
        // aperte il 2026-07-29 tornava zero righe: `enqueueNotifiche` esce muto sulla lista
        // vuota (enqueue.ts:42) e il battito chiudeva «ok, scartate: 1». `staffScuola` guarda
        // il ponte, controlla `{ error }` da sé (PostgREST non lancia) e logga i suoi degradi.
        const utenteIds = await staffScuola(supabase, f.scuola_id, ['admin', 'coordinator', 'segreteria'])
        if (utenteIds.length === 0) {
          // `error`, e qui più che altrove: lo stato terminale della fattura è GIÀ stato
          // scritto qui sopra, quindi la riga esce da `STATI_IN_VOLO` e il giro successivo
          // non la ripesca. Non è un avviso rimandato: è un avviso perso per sempre, su un
          // dato con conseguenza fiscale. `scuola_id` è un uuid: resta in chiaro anche in tabella.
          logEvento('cron', 'error', {
            operazione: JOB,
            esito: 'scarto-senza-destinatari',
            scuola_id: f.scuola_id,
            numero: f.numero,
            msg: `${JOB}: fattura scartata e nessuno da avvisare`,
          })
          continue
        }
        await enqueueNotifiche(supabase, {
          utenteIds,
          tipo: 'fattura_scartata',
          titolo: 'Fattura scartata dallo SDI',
          // `m.label` e non `etichetta`: nella notifica la dicitura di Aruba («Scartata»)
          // ripeterebbe la nostra («Scartata dallo SDI») senza aggiungere niente, e una push
          // si legge in due secondi. La parola esatta del provider resta a registro
          // (`sdi_stato_label`, `sdi_scarto_motivo`), che è dove si va a guardare per
          // ritrasmettere — ed è il posto che questo link apre.
          corpo: `Fattura n. ${f.numero}: ${m.label}. Verifica i dati e reinvia.`,
          link: '/admin/pagamenti',
          entitaTipo: 'fattura',
          entitaId: f.id,
          scuolaId: f.scuola_id,
        })
      }
    }

    // I contatori sono NUMERI: passano in chiaro anche in tabella. `scartate` soprattutto —
    // è l'unico numero di questo giro che ha una conseguenza fiscale.
    //
    // ⚠️ `esaminate` conta le fatture per cui si è DAVVERO chiamato Aruba, non le righe lette
    // dalla query: le due divergono appena una scuola viene saltata per credenziali o appena
    // il tetto di tempo interrompe il ciclo. Contare le righe lette farebbe sembrare
    // interrogate anche quelle che nessuno ha toccato.
    //
    // Un giro interrotto per tempo NON è un giro completo, e ha un `esito` suo: le righe
    // rimaste sono ancora in coda e il tick dopo le riprende, ma chi legge `esito: 'ok'` con
    // `processate: 3` su una coda da 153 deve poter distinguere «non c'era altro da fare» da
    // «non ho fatto in tempo». Il `msg` è diverso perché entra nell'impronta di `app_log`:
    // con lo stesso messaggio i due esiti finirebbero nella stessa riga del giorno.
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: interrottoPerTempo ? 'ok-parziale' : 'ok',
      ms: Date.now() - t0,
      lette: righe.length,
      esaminate,
      processate,
      scartate,
      skipped: scuoleSkipped.size,
      msg: interrottoPerTempo
        ? `${JOB}: tetto di tempo raggiunto, le fatture restanti tornano al giro successivo`
        : `${JOB}: ok`,
    })
    return NextResponse.json({
      success: true,
      data: {
        processate,
        scartate,
        skipped: scuoleSkipped.size,
        esaminate,
        ...(interrottoPerTempo ? { interrotto: 'tetto_tempo' } : {}),
        ...(scuoleSkipped.size > 0 ? { motivo: 'credenziali_non_configurate' } : {}),
      },
    })
  } catch (err) {
    // `evento: 'cron'`: il fallimento totale del job resta nello stesso flusso dei battiti
    // (`where evento = 'cron'`). `logErrore` emette anche l'Error nativo con lo stack VERO.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
