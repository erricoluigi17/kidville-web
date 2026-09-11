import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, requireUser } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { assertFatturaInScope } from '@/lib/pagamenti/scope-fattura'
import { emettiFatturaPagamento } from '@/lib/aruba/emissione'
import { mapStatoAruba } from '@/lib/aruba/stato'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { zIntestatarioScelto } from '@/lib/fatturazione/intestatario-scelto'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * IL TEMPO MASSIMO DELLA FUNZIONE, DICHIARATO E NON EREDITATO.
 *
 * ─── IL CONTO, NEL CASO TIPICO: UN SOLO `429`, E SULL'UPLOAD ─────────────────
 * Un'emissione parla con Aruba con un ritmo che Aruba impone (SLA §3: 12 ricerche
 * al minuto per IP ⇒ una ogni 5 s, vedi `PAUSA_FRA_PAGINE_MS` in
 * `src/lib/aruba/client.ts`):
 *
 *     1 `signin`
 *   + 7 pagine di `findByUsername`, cioè 6 pause da 5 s        →   30 s
 *   + la pausa prima dell'upload, della stessa durata          →    5 s
 *   + 1 `upload`
 *   + il `429` sull'upload: attesa e UN ritentativo            →   90 s
 *                                                              ─────────
 *                                    ~125 s di sola attesa, più le risposte
 *
 * ⚠️ NON È IL MASSIMO TEORICO, e chiamarlo «caso peggiore» sarebbe una di quelle
 * frasi che dichiarano un tetto che non è un tetto. Anche la LETTURA ritenta una
 * volta dopo un `429` (`paginaConRitentativo`, in `client.ts`): ogni pagina che lo
 * prende aggiunge 90 s, e con abbastanza pagine sfortunate si sfonda qualunque
 * valore si scriva qui.
 *
 * ─── PERCHÉ IL MASSIMO TEORICO NON È IL BUDGET CHE CONTA ─────────────────────
 * Un `429` in lettura cade PRIMA che `prossimo_numero_fattura_sezionale` abbia
 * scritto il contatore, e lì un troncamento non costa niente: nessun numero
 * consumato, nessuna riga a registro, si ripreme e basta. DOPO l'allocazione un
 * troncamento significa invece un numero bruciato, nessuna riga a registro e
 * nessuno in grado di dire se la fattura sia partita — cioè il danno che tutto
 * questo lavoro esiste per evitare.
 *
 * Quel tratto è il budget da coprire: pausa da 5 s + `signin` + `upload` + i 90 s
 * dell'unico ritentativo + il secondo `upload`, cioè **~100 s più le risposte**
 * (tetto di 30 s ciascuna, in pratica molto meno). Trecento secondi lo coprono con
 * margine, senza dipendere da un default di piattaforma che nessuno ha scelto e
 * che può cambiare con un aggiornamento del piano. È lo stesso ragionamento
 * dell'import massivo, dove l'unico altro `maxDuration` del repository sta scritto
 * per esteso (`src/app/api/iscrizione/import-massivo/route.ts`).
 */
export const maxDuration = 300

// causale: il comportamento pre-esistente accetta qualsiasi tipo e la usa solo
// se è una stringa non vuota → unknown().optional(), il typeof resta nell'handler.
const postBodySchema = z.object({
  pagamento_id: zUuid,
  causale: z.unknown().optional(),
  /**
   * L'intestatario scelto a mano dalla segreteria. ASSENTE = comportamento di
   * sempre: la cascata di `determinaQuoteFatturazione` decide da sola.
   *
   * L'unione discriminata rende irrappresentabile l'ibrido «adult_id + campi
   * anagrafici»: sul ramo `adult` viaggia solo l'id, e nome, codice fiscale e
   * residenza si rileggono da `parents` lato server. Accettare l'anagrafica dal
   * client per una persona che abbiamo in archivio vorrebbe dire lasciar
   * intestare una fattura a un genitore vero con un codice fiscale forgiato dal
   * browser.
   */
  intestatario: zIntestatarioScelto.optional(),
})

/**
 * I due rifiuti che nascono con il selettore, e i loro codici.
 *
 * Costanti LOCALI e letterali, non un accesso a una mappa: il lock
 * `errori-con-codice` risolve `codice: X` solo se `X` è una stringa nel corpo
 * oppure un `const X = '…'` di QUESTO file. Un valore che il lock non sa leggere
 * è un valore che nessuno controlla.
 */
const CODICE_CONFLITTO_QUOTE = 'INTESTATARIO_IN_CONFLITTO_CON_QUOTE'
const CODICE_GIA_EMESSA_ALTRO = 'FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO'
const CODICE_NON_DEL_BAMBINO = 'INTESTATARIO_NON_DEL_BAMBINO'
/**
 * 409 — multi-quota: a registro c'è una fattura viva che non corrisponde alle
 * quote di oggi. Codice distinto da `FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO`
 * perché diverso è ciò che chi lo riceve deve andare a guardare: là
 * l'intestatario scelto, qui le QUOTE del pagamento (e la fattura di ieri).
 */
const CODICE_RIGA_ESTRANEA = 'FATTURA_RIGA_VIVA_ESTRANEA_ALLE_QUOTE'
/**
 * 502 — RIFIUTO DI TRASPORTO: il numero è stato consumato e nessuno sa se il
 * documento sia partito (429 sopravvissuto al ritentativo, 401, 5xx, timeout).
 *
 * È l'unico rifiuto di questa rotta dopo il quale ripremere «Emetti» è la cosa
 * SBAGLIATA — ogni altro si chiude con «nessun numero è stato consumato» — e fino
 * a oggi usciva dal ramo generico, cioè senza `codice`: in inglese si leggeva la
 * prosa italiana, e nessun chiamante poteva distinguerlo da un rifiuto qualunque
 * per decidere di fermarsi. Con un lotto in corso
 * (`src/lib/pagamenti/lotto-fatture.ts`) quella distinzione vale undici numeri di
 * fattura consumati per niente.
 *
 * ⚠️ La condizione è `motivo === 'errore' && httpStatus === 502`, e le due metà
 * servono entrambe: `motivo: 'errore'` da solo comprende anche il 500 dell'XML
 * non composto (dove ripremere è giusto), e `502` da solo comprende lo SCARTO di
 * merito (`motivo: 'scartata'`), dove il rimedio è correggere e riemettere.
 */
const CODICE_TRASPORTO_IGNOTO = 'FATTURA_TRASPORTO_IGNOTO'

/**
 * 404 — il PDF della fattura non c'è: non è ancora tornato dallo SDI, oppure la
 * chiave a registro non corrisponde a nessun oggetto nel bucket `fatture`.
 *
 * ⚠️ FINO A OGGI QUESTO RIFIUTO NON ESISTEVA, e al suo posto usciva **un altro
 * documento**. La rotta ne disegnava uno al volo — una «copia di cortesia» con
 * intestazione, numero, causale, importo — e la serviva con `Content-Type:
 * application/pdf` e `status: 200`. Chi premeva «Scarica fattura» riceveva un
 * foglio che *sembra* una fattura, non è la fattura elettronica trasmessa allo
 * SDI, e non lo distingue nessuno: né il genitore che se lo salva sul telefono,
 * né il commercialista che se lo vede allegare alla dichiarazione.
 *
 * Il surrogato è stato tolto. Da oggi nessun percorso di questa rotta può
 * rispondere `application/pdf` senza aver letto byte dal bucket `fatture`: o si
 * consegna il documento vero, o si dice che non c'è.
 */
const CODICE_PDF_NON_DISPONIBILE = 'FATTURA_PDF_NON_DISPONIBILE'
/** 409 — per questo pagamento non è ancora stata emessa nessuna fattura. */
const CODICE_NON_EMESSA = 'FATTURA_NON_EMESSA'
/**
 * 409 — il pagamento ha PIÙ fatture vive (genitori separati: una quota per
 * ciascuno) e la richiesta non dice quale. Non si sceglie per conto di chi
 * chiede: vedi il blocco lungo accanto alla lettura del registro, nel `GET`.
 */
const CODICE_PIU_QUOTE = 'FATTURA_PIU_QUOTE'
/**
 * 404 — la riga di `pagamenti` non c'è.
 *
 * ⚠️ La frase resta «Pagamento non trovato» ed è la stessa scritta a mano in
 * altri punti di `src/app/api/pagamenti/**` che il codice non ce l'hanno: il
 * lock `errori-con-codice` guarda le frasi del CATALOGO, non questa, quindi la
 * voce i18n di questo codice dev'essere una frase SUA — se le si desse
 * «Pagamento non trovato» renderebbe rossi quei punti, che questo lavoro non
 * tocca. È la stessa ragione già scritta accanto a `PAGAMENTO_INESISTENTE` in
 * `src/lib/ui/esito-fetch.ts`.
 */
const CODICE_PAGAMENTO_NON_TROVATO = 'PAGAMENTO_NON_TROVATO'
/**
 * 404 — la riga di `fatture_emesse` indicata da `fattura_id` non esiste, oppure
 * non è di questo pagamento: le due cose si dicono uguali di proposito, per non
 * confermare a nessuno l'esistenza della fattura di un'altra famiglia.
 */
const CODICE_FATTURA_NON_TROVATA = 'FATTURA_NON_TROVATA'
/**
 * 500 — una lettura di PostgREST non è riuscita. `LETTURA_FALLITA` è già
 * dichiarato e tradotto in entrambe le lingue: un codice nuovo sarebbe stata una
 * frase in più che dice la stessa cosa.
 */
const CODICE_LETTURA_FALLITA = 'LETTURA_FALLITA'

const getQuerySchema = z.object({
  pagamento_id: zUuid,
  // opzionale: scarica il PDF di UNA specifica fattura (quota) del pagamento.
  fattura_id: zUuid.optional(),
  /**
   * `1` → il browser SALVA il file (`attachment`); assente o `0` → lo apre nella
   * pagina (`inline`). Enumerato e non booleano: in una query string `?download=`
   * arriva sempre come stringa, e `z.coerce.boolean()` considera vera qualunque
   * stringa non vuota — `?download=0` diventerebbe «sì».
   */
  download: z.enum(['0', '1']).optional(),
})

/** Una riga del registro `fatture_emesse`, ridotta a ciò che serve per servire il PDF. */
interface RigaRegistro {
  id: string
  numero: number | string | null
  anno: number | string | null
  pdf_path: string | null
  sdi_stato: number | null
}

/**
 * Una riga di registro è VIVA se non risulta SCARTATA.
 *
 * Stessa regola di `viveNonScartate` (`src/lib/aruba/emissione.ts:1184-1185`), e
 * va tenuta identica: là decide se si può riemettere, qui se un documento si può
 * consegnare. Una fattura scartata dallo SDI o rifiutata dal destinatario è un
 * numero bruciato, non un documento da mettere in mano a una famiglia.
 *
 * `sdi_stato` nullo NON è scarto: è la riga «trasporto fallito» (numero
 * consumato, esito ignoto), e conta come viva esattamente come in `emissione.ts`.
 */
function eViva(r: RigaRegistro): boolean {
  return !(r.sdi_stato != null && mapStatoAruba(Number(r.sdi_stato)).isScarto)
}

/**
 * SOLO CIFRE, sempre — e non è pignoleria.
 *
 * Il nome del file finisce nel foglio di condivisione di un telefono, nella
 * cartella Download, negli allegati di una mail inoltrata al commercialista. Lì
 * non ci va mai il nome di un bambino, e nemmeno un frammento di uuid che
 * qualcuno possa incollare in un indirizzo. Numero e anno di una fattura sono
 * pubblici per definizione: stanno stampati sul documento.
 *
 * Il ripiego è `0` e non la stringa vuota: `fattura--2026.pdf` sembra un file
 * rotto, `fattura-0-2026.pdf` si legge.
 */
function cifre(v: unknown): string {
  const solo = String(v ?? '').replace(/\D+/g, '')
  return solo || '0'
}

/**
 * La risposta col PDF VERO — l'unico punto del file che può dire
 * `application/pdf`.
 *
 * `Cache-Control: no-store`: è un documento fiscale intestato a una persona, e
 * non deve restare in nessuna cache condivisa (proxy, CDN, service worker).
 * `X-Content-Type-Options: nosniff`: il browser non prova a indovinare il tipo
 * di byte che arrivano da un bucket.
 *
 * Il NOME è identico nei due casi (`inline` e `attachment`): cambia dove finisce
 * il file, non come si chiama. Un nome che cambia col pulsante premuto è un modo
 * sicuro di ritrovarsi due copie della stessa fattura con due nomi diversi.
 */
function rispostaPdf(byte: ArrayBuffer, riga: RigaRegistro, comeAllegato: boolean): NextResponse {
  const nome = `fattura-${cifre(riga.numero)}-${cifre(riga.anno)}.pdf`
  return new NextResponse(byte, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${comeAllegato ? 'attachment' : 'inline'}; filename="${nome}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * I byte del PDF dal bucket `fatture`, oppure `null`.
 *
 * ⚠️ `supabase-storage-js` NON LANCIA: `download` ritorna `{ data, error }`, e
 * l'`error` qui veniva scartato dalla destrutturazione — il `try/catch` attorno
 * non scattava mai. Adesso si guarda, e il livello è `error` e non più `warn`:
 * finché c'era il surrogato il risultato era DEGRADATO (l'utente riceveva un
 * altro documento), ora l'utente non ottiene NIENTE. Un guasto che si vede a
 * schermo va contato fra i guasti.
 */
async function scaricaPdf(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  chiave: string,
): Promise<ArrayBuffer | null> {
  try {
    const { data: file, error } = await supabase.storage.from('fatture').download(chiave)
    if (error || !file) {
      logEvento('storage', 'error', {
        operazione: 'pagamenti/fattura:GET',
        bucket: 'fatture',
        esito: 'pdf-non-scaricato',
      }, error ?? undefined)
      return null
    }
    return await file.arrayBuffer()
  } catch (e) {
    // Resta a coprire ciò che può lanciare davvero: `arrayBuffer()` su un Blob
    // corrotto, o un guasto di trasporto.
    logEvento('storage', 'error', {
      operazione: 'pagamenti/fattura:GET',
      bucket: 'fatture',
      esito: 'pdf-non-scaricato',
    }, e)
    return null
  }
}

// POST /api/pagamenti/fattura  (staff) — "Invia Fattura" → emissione REALE Aruba/SDI.
// Body: { userId, pagamento_id, causale? }. Richiede pagamento saldato.
export const POST = withRoute('pagamenti/fattura:POST', async (request: Request) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { pagamento_id, causale, intestatario } = b.data

    const supabase = await createAdminClient()

    // Isolamento per sede: il gate di ruolo non bastava — si operava sulle rette
    // di un'altra sede conoscendo l'uuid del pagamento. `pagamenti` ha gia'
    // `scuola_id`, che per la contabilita' e' il dato che conta.
    const fuoriScopePag = await assertPagamentoInScope(supabase, auth.user, pagamento_id)
    if (fuoriScopePag) return fuoriScopePag

    // ─── LA CORREZIONE MANUALE, E COME SI TOGLIE ──────────────────────────────
    // `pagamenti.fattura_causale` batte qualunque modello configurato: è una
    // correzione che un umano scrive su QUESTO documento. Fino al 2026-09-04 si
    // poteva solo scrivere, mai cancellare — e siccome il modale precompilava la
    // casella con la descrizione del pagamento, ogni emissione ci lasciava dentro
    // l'eco della descrizione. Quel pagamento restava congelato per sempre:
    // cambiare il modello in Contabilità → Causali non aveva più alcun effetto su
    // di lui, e nessuno poteva sapere perché.
    //
    //   stringa non vuota → si scrive la correzione
    //   `null`           → si TOGLIE (il modale lo manda quando non si personalizza)
    //   `undefined`      → non si tocca (chiamanti vecchi)
    const scriviCausale =
      typeof causale === 'string' && causale.trim()
        ? causale.trim()
        : causale === null
          ? null
          : undefined
    if (scriviCausale !== undefined) {
      // PostgREST NON LANCIA (AGENTS.md, regola 7): l'esito va guardato. Non è
      // bloccante — la causale composta resta corretta anche senza questa riga — ma
      // un fallimento muto qui rimetterebbe in circolo esattamente il difetto sopra.
      const { error: errCausale } = await supabase
        .from('pagamenti')
        .update({ fattura_causale: scriviCausale })
        .eq('id', pagamento_id)
      if (errCausale) {
        logEvento('fattura', 'warn', {
          operazione: 'pagamenti/fattura:POST',
          esito: scriviCausale === null ? 'causale-manuale-non-rimossa' : 'causale-manuale-non-salvata',
          pagamento_id,
        }, errCausale)
      }
    }

    // ⚠️ L'intestatario scelto NON viene scritto su `alunni.intestatario_fatture`:
    // vale per QUESTO documento e basta. Persisterlo qui vorrebbe dire che una
    // fattura andata storta lascia dietro di sé un intestatario nuovo su tutte le
    // rette future del bambino, senza che nessuno l'abbia deciso. La scheda si
    // cambia dalla scheda — e per l'anagrafica DIGITATA la casella «Ricorda sulla
    // scheda» di `FatturaButton` esiste già, con la sua spunta esplicita.
    //
    // ⚠️ IL LOTTO INVECE SCRIVE, dal 2026-09-08, e la differenza non è una svista:
    // `POST …/fattura/lotto` chiama `ricordaIntestatarioSullaScheda` SOLO dopo
    // un'emissione riuscita e NUOVA, SOLO su una scheda ancora vuota, e SOLO quando a
    // decidere l'intestatario è stata la proposta dell'ordinante del bonifico — cioè
    // quando l'anagrafica non sapeva rispondere (16 righe su 20, misurate quel
    // giorno). L'obiezione qui sopra — «una fattura andata storta» — non lo tocca,
    // perché lì non si scrive niente se la fattura non è uscita.
    //
    // Qui, dove un essere umano ha appena letto il nome sullo schermo, il promemoria
    // non serve: la volta dopo rileggerà. Nel lotto non c'è nessuno che legga.
    const esito = await emettiFatturaPagamento(supabase, pagamento_id, { id: auth.user.id }, {
      intestatarioScelto: intestatario,
    })
    if (!esito.ok) {
      // I due rifiuti del selettore nascono CON il codice: senza, l'utente inglese
      // leggerebbe la prosa italiana del server (lock `errori-con-codice`). Gli
      // altri restano come sono — il loro debito è dichiarato in allowlist e si
      // paga a parte, non di straforo dentro un lavoro che parla d'altro.
      if (esito.motivo === 'intestatario_in_conflitto') {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_CONFLITTO_QUOTE, data: { motivo: esito.motivo } },
          { status: esito.httpStatus }
        )
      }
      if (esito.motivo === 'gia_emessa_altro_intestatario') {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_GIA_EMESSA_ALTRO, data: { motivo: esito.motivo } },
          { status: esito.httpStatus }
        )
      }
      if (esito.motivo === 'quota_estranea') {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_RIGA_ESTRANEA, data: { motivo: esito.motivo } },
          { status: esito.httpStatus }
        )
      }
      if (esito.motivo === 'intestatario_non_del_bambino') {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_NON_DEL_BAMBINO, data: { motivo: esito.motivo } },
          { status: esito.httpStatus }
        )
      }
      // ⚠️ PRIMA del ritorno generico: `motivo: 'errore'` finirebbe lì dentro, e
      // il rifiuto che dice «NON ripremere» uscirebbe indistinguibile da quelli
      // che dicono il contrario.
      if (esito.motivo === 'errore' && esito.httpStatus === 502) {
        return NextResponse.json(
          { error: esito.messaggio, codice: CODICE_TRASPORTO_IGNOTO, data: { motivo: esito.motivo } },
          { status: 502 }
        )
      }
      return NextResponse.json(
        { error: esito.messaggio, data: { motivo: esito.motivo } },
        { status: esito.httpStatus }
      )
    }
    return NextResponse.json({
      success: true,
      data: { fattura_stato: esito.fatturaStato, numero: esito.numero, fattura_id: esito.uploadFileName },
    })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura:POST', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

/**
 * GET /api/pagamenti/fattura?pagamento_id=&fattura_id=&download=
 *
 * Serve il PDF della fattura elettronica — quello VERO, letto dal bucket
 * `fatture`. Accesso: la famiglia del bambino (per LEGAME, non per sede) oppure
 * la contabilità del plesso; lo decide `assertFatturaInScope`.
 *
 * ⚠️ NON ESISTE PIÙ NESSUN RIPIEGO. Fino a oggi, quando il PDF dello SDI non
 * c'era, questa rotta ne DISEGNAVA uno al volo e lo serviva come
 * `application/pdf` con `200`: chi premeva «Scarica fattura» si ritrovava in mano
 * un documento che non è la fattura, senza modo di accorgersene. Adesso, se i
 * byte non arrivano dal bucket, si risponde 404 con un `codice`.
 */
export const GET = withRoute('pagamenti/fattura:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { pagamento_id: pagamentoId, fattura_id: fatturaId, download } = q.data
    const comeAllegato = download === '1'

    const supabase = await createAdminClient()

    // ─── LA RIGA DEL PAGAMENTO SI LEGGE PRIMA DEL GATE ────────────────────────
    //
    // Non è un'inversione di comodo: il gate ha bisogno di `alunno_id`, perché per
    // chi è famiglia il perimetro è il LEGAME col bambino e non il plesso. Prima
    // qui c'era `assertPagamentoInScope` applicata A TUTTI, e siccome
    // `scuoleDiUtente` per un non-admin ritorna la sola sede primaria, un genitore
    // con due figli in due plessi prendeva 403 sulla fattura di uno dei due.
    // La lettura non espone niente: quello che esce lo decide il gate qui sotto.
    const { data: pag, error: errPag } = await supabase
      .from('pagamenti')
      .select('id, fattura_stato, fattura_pdf_path, alunno_id')
      .eq('id', pagamentoId)
      .maybeSingle()
    // PostgREST NON LANCIA (AGENTS.md, regola 7): senza questo controllo un guasto
    // di lettura sarebbe uscito come «Pagamento non trovato», cioè un'affermazione
    // su un dato che non si è letto.
    if (errPag) {
      logErrore({ operazione: 'pagamenti/fattura:GET', stato: 500, evento: 'db' }, errPag)
      return NextResponse.json(
        { error: 'Lettura del pagamento non riuscita', codice: CODICE_LETTURA_FALLITA },
        { status: 500 },
      )
    }
    if (!pag) {
      return NextResponse.json(
        { error: 'Pagamento non trovato', codice: CODICE_PAGAMENTO_NON_TROVATO },
        { status: 404 },
      )
    }

    const fuoriScope = await assertFatturaInScope(supabase, auth.user, pagamentoId, pag.alunno_id as string | null)
    if (fuoriScope) return fuoriScope

    // Percorso LEGACY (nessun `fattura_id`): la fattura dev'essere emessa. Il
    // controllo resta PRIMA della lettura del registro, come è sempre stato: a chi
    // chiede la fattura di una retta non ancora fatturata si risponde «non c'è
    // ancora», non «non l'ho trovata».
    if (!fatturaId && pag.fattura_stato !== 'emessa') {
      return NextResponse.json(
        { error: 'Fattura non ancora emessa per questo pagamento', codice: CODICE_NON_EMESSA },
        { status: 409 },
      )
    }

    // ─── LA RIGA DI REGISTRO: numero, anno e la chiave nel bucket ─────────────
    //
    // È `fatture_emesse` a sapere il NUMERO e l'ANNO del documento, e sono le due
    // sole cose che finiscono nel nome del file. Con `fattura_id` si prende
    // QUELLA riga, e solo se è di QUESTO pagamento.
    //
    // ⚠️ SENZA `fattura_id` NON SI SCEGLIE PER CONTO DI CHI CHIEDE. Qui c'era
    // `.order('numero', { ascending: false }).limit(1)`, con accanto un commento
    // che si autorizzava così: «nel caso legacy è anche l'unica, perché
    // `pagamenti.fattura_pdf_path` lo scrive `fattura/sync` soltanto quando la
    // fattura è singola» (`fattura/sync/route.ts:275`, `pdfSingola`). La premessa
    // reggeva finché la CHIAVE del ramo legacy ERA `pagamenti.fattura_pdf_path`:
    // con due quote quella colonna resta vuota, e il ramo non poteva consegnare
    // niente. Ma questa lettura interroga `fatture_emesse` senza richiederla,
    // quindi con genitori separati — due quote, due documenti, DUE INTESTATARI —
    // pescava una delle due. `GET /api/pagamenti/fattura?pagamento_id=X` (un link
    // vecchio, un segnalibro, una chiamata diretta) serviva al padre la fattura
    // intestata alla madre: suo codice fiscale, sua residenza, suo importo,
    // consegnata come documento ufficiale e per giunta base della detrazione 730.
    //
    // E «la più recente» era falso per costruzione: l'ordinamento è su `numero`,
    // che riparte da 1 a ogni anno e a ogni sezionale — fra un 120/2025 e un
    // 3/2026 sceglieva il più VECCHIO.
    //
    // Quindi si leggono TUTTE le righe del pagamento, si tengono le VIVE, e se ne
    // resta più d'una si risponde 409: quale scaricare lo dice il chiamante con
    // `fattura_id`, e l'elenco per intestatario ce l'ha già da `…/fattura/list`.
    const base = supabase
      .from('fatture_emesse')
      .select('id, numero, anno, pdf_path, sdi_stato')
      .eq('pagamento_id', pagamentoId)
    const { data: righe, error: errFatt } = fatturaId
      ? await base.eq('id', fatturaId).limit(1)
      : await base
    if (errFatt) {
      logErrore({ operazione: 'pagamenti/fattura:GET', stato: 500, evento: 'db' }, errFatt)
      return NextResponse.json(
        { error: 'Lettura del registro fatture non riuscita', codice: CODICE_LETTURA_FALLITA },
        { status: 500 },
      )
    }
    const tutte = (righe ?? []) as RigaRegistro[]
    let fatt: RigaRegistro | undefined
    if (fatturaId) {
      fatt = tutte[0]
    } else {
      const vive = tutte.filter(eViva)
      if (vive.length > 1) {
        // `warn` e persistito: è un chiamante che chiede un documento fiscale
        // senza dire quale, cioè un punto dell'app (o un link salvato) rimasto
        // indietro rispetto al multi-quota. Vale la pena poterlo cercare.
        // SOLO uuid e numeri: `quote` è un conteggio, non un'anagrafica.
        logEvento('fattura', 'warn', {
          operazione: 'pagamenti/fattura:GET',
          esito: 'piu-quote-senza-fattura-id',
          pagamento_id: pagamentoId,
          quote: vive.length,
        }, undefined, { distingui: ['pagamento_id'] })
        return NextResponse.json(
          {
            error: 'Questo pagamento ha più fatture: indicare quale scaricare',
            codice: CODICE_PIU_QUOTE,
          },
          { status: 409 },
        )
      }
      fatt = vive[0]
    }
    if (!fatt) {
      // Con `fattura_id`: la riga indicata non esiste, o non è di questo pagamento
      // — e le due cose si dicono uguali di proposito, per non confermare a
      // nessuno l'esistenza della fattura di un'altra famiglia.
      if (fatturaId) {
        return NextResponse.json(
          { error: 'Fattura non trovata', codice: CODICE_FATTURA_NON_TROVATA },
          { status: 404 },
        )
      }
      // Senza: il pagamento risulta «emessa» ma a registro non c'è niente. È una
      // divergenza fra due tabelle, non un errore dell'utente: il PDF non c'è.
      //
      // ⚠️ E se il pagamento porta anche una CHIAVE nel bucket, la divergenza è
      // grave e va detta: c'è un file pagato dallo SdI che nessuna riga di
      // registro rivendica, quindi non se ne conoscono numero e anno — cioè le due
      // sole cose che possono stare nel nome. Servirlo come `fattura-0-0.pdf`
      // sarebbe consegnare un documento fiscale senza saper dire quale.
      if (pag.fattura_pdf_path) {
        logEvento('fattura', 'error', {
          operazione: 'pagamenti/fattura:GET',
          esito: 'pdf-senza-riga-a-registro',
          pagamento_id: pagamentoId,
        }, undefined, { distingui: ['pagamento_id'] })
      }
      return NextResponse.json(
        { error: 'Il PDF della fattura non è disponibile', codice: CODICE_PDF_NON_DISPONIBILE },
        { status: 404 },
      )
    }

    // ─── LA CHIAVE NEL BUCKET, E IL RIPIEGO CHE SI CONCEDE UNA CONDIZIONE ─────
    //
    // Sta sulla riga di registro. Il ripiego su `pagamenti.fattura_pdf_path` vale
    // solo nel percorso legacy E solo se il pagamento ha UNA riga a registro,
    // perché quella è la condizione esatta con cui la colonna viene scritta:
    // `fattura/sync/route.ts:275` calcola `pdfSingola = righeAgg.length <= 1 ?
    // … : null` su TUTTE le righe del pagamento, scartate comprese.
    //
    // Ricopiare qui la stessa condizione non è pignoleria: senza, con due righe
    // (una viva e una scartata) si sarebbe usata una chiave che appartiene a un
    // documento diverso da quello di cui si sono appena letti numero e anno — e il
    // file uscirebbe col nome sbagliato, che su una fattura è il documento
    // sbagliato.
    const unaSolaARegistro = tutte.length <= 1
    const chiave =
      fatt.pdf_path ?? (!fatturaId && unaSolaARegistro ? (pag.fattura_pdf_path as string | null) : null)
    if (!chiave) {
      return NextResponse.json(
        { error: 'Il PDF della fattura non è ancora disponibile', codice: CODICE_PDF_NON_DISPONIBILE },
        { status: 404 },
      )
    }

    const byte = await scaricaPdf(supabase, chiave)
    if (!byte) {
      // 404 e non 500, ed è una scelta: per chi ha premuto il pulsante il fatto è
      // «il documento non c'è», e la causa vera (oggetto sparito o Storage giù) è
      // già nella riga `error` che `scaricaPdf` ha appena scritto. Quello che NON
      // si fa più è consegnare un altro documento al posto suo.
      return NextResponse.json(
        { error: 'Il PDF della fattura non è disponibile', codice: CODICE_PDF_NON_DISPONIBILE },
        { status: 404 },
      )
    }

    // ─── IL SUCCESSO SI LOGGA (AGENTS.md, regola 5) ───────────────────────────
    //
    // Senza questa riga, «nessun log» non distingue «nessuno ha scaricato una
    // fattura» da «i download non partono più» — l'ambiguità esatta che ha tenuto
    // nascosto per mesi il guasto delle email di credenziali. `fattura` è in
    // `EVENTI_PERSISTITI`, quindi anche l'`info` finisce in tabella ed è
    // interrogabile.
    //
    // SOLO UUID, NUMERI E BOOLEANI: mai il nome del file (che è comunque solo
    // cifre), mai l'intestatario, mai l'importo. Sono dati di minori e delle loro
    // famiglie, e per sapere che il download funziona non servono.
    logEvento('fattura', 'info', {
      operazione: 'pagamenti/fattura:GET',
      esito: 'pdf-servito',
      pagamento_id: pagamentoId,
      fattura_id: fatt.id,
      numero: Number(fatt.numero) || null,
      anno: Number(fatt.anno) || null,
      download: comeAllegato,
    })
    return rispostaPdf(byte, fatt, comeAllegato)
  } catch (err) {
    logErrore({ operazione: 'pagamenti/fattura:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
