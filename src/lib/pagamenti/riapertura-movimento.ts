import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
// «QUESTO DOCUMENTO È ANCORA VIVO?» HA UNA DEFINIZIONE SOLA: quella di
// `@/lib/pagamenti/fattura-viva`. Qui serve all'AVVISO della riapertura, che non
// ferma niente ma DICE quali documenti restano vivi: se questa riga tornasse a
// derivare «viva» in casa, l'avviso della riapertura e il 409 del riabbinamento
// direbbero due cose diverse dello stesso documento.
import { fatturaViva, etichettaFattura, type RigaFatturaEmessa } from '@/lib/pagamenti/fattura-viva'
// LO STORNO DI UN INCASSO SINGOLO HA UN POSTO SOLO, ed è quello. `eseguiStornoIncasso`
// crea il contro-incasso NEGATIVO tracciato (`storno_di`), marca l'originale, ricalcola
// lo stato del pagamento e scrive l'audit col motivo: riscriverne una copia qui
// significherebbe avere due idee diverse di che cos'è uno storno, e la seconda nascerebbe
// senza il ramo che degrada quando l'enum `storno` non esiste sul DB non migrato.
import { eseguiStornoIncasso } from '@/app/api/pagamenti/incassi/storno/route'

// ─────────────────────────────────────────────────────────────────────────────
// LO STORNO E LA RIAPERTURA DI UN MOVIMENTO CONFERMATO — fuori dalla rotta.
//
// ─── PERCHÉ NON STA PIÙ DENTRO `riconciliazione/[id]:PATCH` ─────────────────
// Un endpoint nuovo dovrà riaprire i bonifici IN BLOCCO, e un blocco non ha una
// `Request` per movimento né un operatore che guarda una schermata. Deve però
// passare esattamente di qui: lo storno idempotente, la mappa degli errori della
// RPC e il compare-and-swap sono le tre cose che impediscono a un bonifico
// riaperto di essere incassato due volte. Ricopiarle è il modo certo di farle
// divergere — e la seconda copia nascerebbe senza i rami che questa fetta ha
// dovuto imparare a suon di incidenti (il 409 del ritentativo, la marcatura muta
// di `stornato_il`, la RPC vecchia che non riapre).
//
// ─── COSA RESTA FUORI, E NON PER DIMENTICANZA ───────────────────────────────
//  · IL GATE DI SEDE resta nel corpo dell'handler, prima di questa chiamata:
//    riaprire è uno storno, cioè un movimento contabile definitivo su denaro di
//    una sede, e chi legge la rotta deve vederci il gate — come lo vede il lock
//    che sorveglia l'isolamento fra i plessi. Qui arrivano solo i suoi VERDETTI
//    (`transazioneGiaAnnullata`).
//  · L'AUDIT, il log di esito e la risposta al client sono del chiamante: `ok`
//    porta i numeri che gli servono. Le notifiche non ci sono e non è una svista
//    — è una decisione del titolare, scritta sopra il `return` della rotta.
// ─────────────────────────────────────────────────────────────────────────────

type ClientAdmin = SupabaseClient

/** La RPC non esiste su questo ambiente (DB E2E della CI, mai migrato). */
const RPC_ASSENTE = new Set(['PGRST202', '42883'])
/**
 * La colonna non esiste (DB non migrato): si ritenta senza, non si cade.
 *
 * ⚠️ ESPORTATA, e non per comodità. Nella rotta era UNA costante sola, letta sia
 * dalla lettura del movimento (`transazione_id` assente sul DB E2E della CI) sia
 * dallo storno qui sotto. Lo spostamento l'avrebbe sdoppiata in due dichiarazioni
 * identiche, cioè proprio la forma che questa estrazione esiste per togliere: il
 * giorno in cui arriva un terzo codice di colonna assente lo si aggiungerebbe in
 * uno dei due posti, e l'altro ramo cadrebbe invece di degradare.
 */
export const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])

/**
 * Il motivo che finisce in `pagamenti_transazioni.annullo_motivo` e in
 * `incassi.storno_motivo` quando la riapertura scioglie un abbinamento.
 *
 * NON si chiede all'operatrice: la riapertura è un pulsante della coda, non un
 * modulo. Ma un motivo la RPC lo pretende (min 3 caratteri) e soprattutto lo
 * pretende chi domani aprirà il registro delle transazioni e troverà un annullo:
 * «annullata» senza un perché manda a cercare un'operazione che nessuno ricorda.
 * Testo fisso e generico: in quelle due colonne non deve finire niente che
 * riguardi una famiglia.
 */
export const MOTIVO_RIAPERTURA = 'Riapertura del movimento bancario dal registro di riconciliazione'

/**
 * L'avviso che viaggia SU UNA RISPOSTA 200, accanto a `success: true`.
 *
 * ⚠️ Non è un errore travestito, ed è progettato per essere MOSTRATO. I numeri
 * stanno anche in un campo loro (`numeri`) e non solo dentro la frase, perché chi
 * disegna il pannello possa elencarli senza fare il parsing di una prosa; il
 * `codice` c'è perché la frase di contorno sia traducibile come tutte le altre
 * (`CODICI_ERRORE`), e `messaggio` porta il dettaglio che il catalogo non può
 * conoscere. È la stessa forma di `{ error, codice }`, spostata sul verso del
 * successo.
 */
export interface AvvisoRiapertura {
  codice: 'RIAPERTURA_CON_FATTURA_VIVA' | 'RIAPERTURA_FATTURE_NON_VERIFICATE'
  messaggio: string
  /** I numeri dei documenti rimasti vivi. Vuoto quando non si è potuto leggerli. */
  numeri: string[]
}

/**
 * Il movimento da riaprire, ridotto ai campi che questa fetta legge. Lo schema
 * intero — con la prosa che spiega ogni colonna — resta della rotta, che la riga
 * la legge dal database.
 */
export interface MovimentoDaRiaprire {
  id: string
  pagamento_id: string | null
  /** L'incasso creato dalla conferma: è la riga che la riapertura deve stornare. */
  incasso_id?: string | null
  /** La transazione composita saldata da questo bonifico, quando ce n'è una. */
  transazione_id?: string | null
}

/** Ciò che la riapertura ha fatto, per chi deve ancora scrivere l'audit. */
export interface RiaperturaRiuscita {
  transazioneAnnullata: boolean
  incassiStornati: number
  movimentiRiaperti: number
  fattureVive: number
}

export interface EsitoRiapertura {
  status: number
  body: Record<string, unknown>
  /** Presente SOLO quando la riga è tornata in coda. */
  ok?: RiaperturaRiuscita
}

/**
 * ─── LO STORNO DI QUESTO INCASSO È GIÀ STATO REGISTRATO? ─────────────────────
 *
 * ⚠️ ESISTE PERCHÉ L'IDEMPOTENZA DELLA RIAPERTURA NON PUÒ POGGIARE SU
 * `incassi.stornato_il`. Quella marcatura, dentro `eseguiStornoIncasso`, è un
 * `.then(() => {}, () => {})`: best-effort **muto**, e il motivo per cui è muto è
 * legittimo (sul DB non migrato le colonne S3 non ci sono). Ma la riapertura ne
 * è diventata un chiamante che DIPENDE da quella marcatura: se fallisce in
 * silenzio, l'originale resta «vivo» in ogni campo e il ritentativo lo storna una
 * seconda volta — due contro-incassi sullo stesso denaro, con un 200 sopra.
 *
 * Quella funzione non si riscrive: è di un'altra rotta, e il difetto è
 * preesistente. Ma questo ramo deve reggere lo stesso, e ci riesce guardando la
 * riga che quella funzione scrive DAVVERO, non quella che marca in silenzio: il
 * **contro-incasso** (`storno_di` = l'originale) è la sua scrittura primaria,
 * l'unica il cui errore viene restituito invece che inghiottito. Se c'è, lo
 * storno è avvenuto — che `stornato_il` sia stato scritto o no.
 *
 * Misurato in produzione il 2026-09-13: 4 contro-incassi, **0** originali
 * stornati e non marcati, **0** originali con due storni. Il caso non si è ancora
 * verificato: questa lettura serve perché non si verifichi.
 *
 * Fail-CLOSED su un guasto di lettura (stessa scelta della guardia del
 * riabbinamento): «non lo so» non è «non c'è», e stornare alla cieca è la strada
 * che porta al doppio contro-incasso. Unica eccezione, il DB non migrato: senza
 * la colonna `storno_di` la domanda non ha nemmeno senso, e un 500 lì
 * trasformerebbe una rete di sicurezza in un guasto.
 */
async function stornoGiaRegistrato(
  supabase: ClientAdmin,
  incassoId: string,
  operazione: string,
): Promise<{ esito: EsitoRiapertura } | { presente: boolean }> {
  const { data, error } = await supabase
    .from('incassi')
    .select('id')
    .eq('storno_di', incassoId)
    .limit(1)
  if (error) {
    const code = (error as { code?: string }).code ?? ''
    if (COLONNA_ASSENTE.has(code)) {
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'storno-non-verificabile-colonna-assente',
        incasso_id: incassoId,
      })
      return { presente: false }
    }
    // PostgREST non lancia: senza questo controllo l'errore verrebbe scartato dalla
    // destrutturazione e «non l'ho potuto leggere» diventerebbe «non c'è».
    logErrore(
      { operazione, evento: 'storno_gia_registrato_non_letto', stato: 500 },
      error,
    )
    return {
      esito: {
        status: 500,
        body: {
          error:
            'Non è stato possibile verificare se l’incasso di questo bonifico fosse già stato stornato: ' +
            'la riapertura è stata fermata per non stornarlo due volte.',
          codice: 'RIAPERTURA_NON_RIUSCITA',
        },
      },
    }
  }
  return { presente: ((data ?? []) as unknown[]).length > 0 }
}

/**
 * Storna ciò che la conferma aveva scritto e riporta la riga bancaria in coda.
 *
 * L'ordine — avviso, storno, riapertura — non si riordina: l'avviso si legge
 * PRIMA di scrivere, e la riapertura viene DOPO lo storno perché nel verso
 * opposto un movimento libero con l'incasso ancora vivo si fa riabbinare, cioè
 * incassare due volte.
 */
export async function riapriMovimento(
  supabase: ClientAdmin,
  args: {
    movimento: MovimentoDaRiaprire
    /** Il verdetto del gate di sede: la transazione era GIÀ annullata. */
    transazioneGiaAnnullata: boolean
    /** `true` se il database HA la colonna `transazione_id`: decide se si può scriverla. */
    colonnaTransazione: boolean
    /** Chi firma l'annullo nella RPC e lo storno. */
    attoreId: string
    /** Il nome dell'operazione nei log: lo dichiara il chiamante. */
    operazione: string
  },
): Promise<EsitoRiapertura> {
  const { movimento: mov, transazioneGiaAnnullata, colonnaTransazione, attoreId, operazione } = args
  const id = mov.id

  // ── 1. L'AVVISO: quali documenti restano vivi ─────────────────────────
  // Si legge PRIMA di scrivere, così l'avviso racconta lo stato su cui
  // l'operatrice decide, e un guasto qui non lascia niente a metà.
  // ⚠️ NON è una guardia: non ferma niente. Decisione esplicita del titolare
  // («riapri comunque, avvisando»), presa davanti alla misura: 167 movimenti
  // confermati su 174, in produzione, hanno una fattura viva sul pagamento
  // abbinato. Un 409 qui avrebbe vietato il 96% delle riaperture.
  let avviso: AvvisoRiapertura | undefined
  let fattureVive = 0
  if (mov.pagamento_id) {
    const { data: righeFattura, error: errFatture } = await supabase
      .from('fatture_emesse')
      .select('numero, anno, sezionale, sdi_stato')
      .eq('pagamento_id', mov.pagamento_id)
    if (errFatture) {
      // PostgREST non lancia. Con l'errore scartato, «nessuna fattura» e «non
      // l'abbiamo potuta leggere» diventerebbero la stessa cosa — e siccome
      // qui non si ferma niente, il silenzio non costerebbe un rifiuto: ne
      // uscirebbe una riapertura che DICHIARA di non aver trovato documenti
      // senza averli cercati.
      logErrore(
        {
          operazione,
          evento: 'fatture_del_movimento_non_lette_riapertura',
          stato: 200,
        },
        errFatture,
      )
      avviso = {
        codice: 'RIAPERTURA_FATTURE_NON_VERIFICATE',
        messaggio:
          'Non è stato possibile leggere le fatture della voce a cui questo bonifico era abbinato.',
        numeri: [],
      }
    } else {
      const numeri = ((righeFattura ?? []) as RigaFatturaEmessa[]).filter(fatturaViva).map(etichettaFattura)
      fattureVive = numeri.length
      if (numeri.length > 0) {
        avviso = {
          codice: 'RIAPERTURA_CON_FATTURA_VIVA',
          // La prosa dice il FATTO coi numeri — che il catalogo non può
          // conoscere, e sono l'unica cosa che dica quale documento andare a
          // guardare; la conseguenza sta nella frase tradotta.
          messaggio: `Fatture ancora valide sulla voce abbinata: ${numeri.join(', ')}.`,
          numeri,
        }
      }
    }
  }

  // ── 2. LO STORNO ──────────────────────────────────────────────────────
  let incassiStornati = 0
  let transazioneAnnullata = false
  let riapertaDallaRpc = false
  /** Quante righe bancarie sono tornate in coda: 1 di norma, di più se la
   *  transazione era stata saldata da più bonifici. Il numero viaggia fino
   *  alla risposta perché è l'unica cosa che dica all'operatrice quanti
   *  movimenti dovrà rilavorare. */
  let movimentiRiaperti = 1
  if (mov.transazione_id && transazioneGiaAnnullata) {
    // Il RITENTATIVO del ramo composito. Gli storni sono già stati commessi
    // da un giro precedente (o dal pulsante del registro transazioni): la RPC
    // non si richiama — risponderebbe comunque `KV409` — e si va a riaprire,
    // che è l'unica metà rimasta da fare.
    transazioneAnnullata = true
    // `incassi_stornati` resta 0, e non è pignoleria: quel numero dice
    // all'operatrice quante righe questo giro ha toccato, e gonfiarlo con
    // storni fatti prima le farebbe contare due volte lo stesso denaro.
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'riapertura-transazione-gia-annullata',
      movimento_id: id,
    })
  } else if (mov.transazione_id) {
    // Composito: si annulla la TRANSAZIONE intera, che è l'unico modo di
    // stornare insieme incassi, ricariche mensa ed eccedenza a credito —
    // e in una transazione atomica sola. La RPC riapre da sé il movimento.
    const { data: esitoRpc, error: rpcErr } = await supabase.rpc('annulla_transazione_contabile', {
      p: { transazione_id: mov.transazione_id, motivo: MOTIVO_RIAPERTURA, annullato_da: attoreId },
    })
    if (rpcErr) {
      const code = (rpcErr as { code?: string }).code ?? ''
      // RPC assente → 503 SENZA storni parziali: nulla è stato scritto,
      // perché storno e riapertura vivono entrambi dentro quella chiamata.
      if (RPC_ASSENTE.has(code)) {
        logEvento(
          'pagamento',
          'error',
          { operazione, esito: 'riapertura-rpc-assente' },
          rpcErr,
        )
        return {
          status: 503,
          body: {
            error: 'Riapertura non disponibile su questo ambiente: nessuno storno è stato registrato.',
            codice: 'RIAPERTURA_NON_DISPONIBILE',
          },
        }
      }
      if (code === 'KV410') {
        logEvento('pagamento', 'warn', {
          operazione,
          esito: 'riapertura-credito-gia-speso',
          movimento_id: id,
        })
        return {
          status: 409,
          body: {
            error:
              'Il credito generato da questo bonifico è già stato utilizzato: la riapertura è stata ' +
              'fermata prima di qualunque storno.',
            codice: 'RIAPERTURA_CREDITO_GIA_SPESO',
          },
        }
      }
      // KV404 — la transazione NON ESISTE. Qui non si riapre, ed è voluto:
      // la RPC trova gli incassi da stornare PER `transazione_id`, quindi se
      // la transazione non c'è quegli incassi non sono stati stornati.
      // Liberare il bonifico lo farebbe riabbinare a un'altra voce con
      // l'incasso ancora vivo — lo stesso denaro incassato due volte.
      if (code === 'KV404') {
        return {
          status: 409,
          body: {
            error: 'La transazione di questo bonifico non esiste più.',
            codice: 'CONCILIAZIONE_MOVIMENTO_CAMBIATO',
          },
        }
      }
      // KV409 — «già annullata», cioè la stessa condizione del pre-check del
      // gate di sede, raggiunta però in GARA (fra la lettura e la RPC). Gli
      // storni ci sono: si PROSEGUE alla riapertura invece di rifiutare. Fino al
      // 2026-09-13 anche questo era un 409, e lasciava una riga `confermato`
      // sopra incassi che non esistevano più.
      if (code !== 'KV409') {
        logErrore(
          { operazione, evento: 'riapertura_rpc_fallita', stato: 500 },
          rpcErr,
        )
        return {
          status: 500,
          body: { error: 'Errore durante la riapertura del movimento', codice: 'RIAPERTURA_NON_RIUSCITA' },
        }
      }
      transazioneAnnullata = true
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'riapertura-transazione-annullata-in-gara',
        movimento_id: id,
      })
    } else {
      const conteggi = (esitoRpc ?? {}) as { incassi_stornati?: number; movimenti_riaperti?: number }
      transazioneAnnullata = true
      incassiStornati = conteggi.incassi_stornati ?? 0
      // ⚠️ `movimenti_riaperti` può MANCARE, e non è teoria: è lo stato del
      // database fra il rilascio della colonna e quello della RPC estesa. Con la
      // funzione vecchia lo storno avviene e il movimento resta `confermato` —
      // cioè una riga che mente, il difetto che questa fetta esiste per chiudere.
      // Chi non lo trova, riapre di sua mano qui sotto.
      riapertaDallaRpc = (conteggi.movimenti_riaperti ?? 0) >= 1
      if (riapertaDallaRpc) movimentiRiaperti = conteggi.movimenti_riaperti as number
      if (!riapertaDallaRpc) {
        logEvento('pagamento', 'warn', {
          operazione,
          esito: 'riapertura-non-fatta-dalla-rpc',
          movimento_id: id,
        })
      }
    }
  } else if (mov.incasso_id) {
    // ── LO STORNO È GIÀ STATO REGISTRATO? Si chiede alla riga giusta ────
    // Non a `incassi.stornato_il`, che `eseguiStornoIncasso` marca in
    // best-effort MUTO: al CONTRO-INCASSO, che è la sua scrittura primaria.
    // Senza questa lettura l'idempotenza di questo ramo dipenderebbe da una
    // `update` il cui fallimento nessuno vede — e un ritentativo stornerebbe
    // due volte lo stesso denaro. Il perché per esteso sta su
    // `stornoGiaRegistrato`.
    const gia = await stornoGiaRegistrato(supabase, mov.incasso_id, operazione)
    if ('esito' in gia) return gia.esito
    if (gia.presente) {
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'riapertura-storno-gia-registrato',
        movimento_id: id,
        incasso_id: mov.incasso_id,
      })
      // `incassiStornati` resta 0: questo giro non ha stornato niente.
    } else {
      // Voce singola: si storna l'incasso che la conferma aveva creato.
      const esitoStorno = await eseguiStornoIncasso(supabase, {
        incassoId: mov.incasso_id,
        motivo: MOTIVO_RIAPERTURA,
        userId: attoreId,
      })
      if (esitoStorno.status === 200) {
        incassiStornati = 1
      } else if (esitoStorno.status === 404 || esitoStorno.status === 409) {
        // 404 «incasso non trovato» e 409 «già stornato / è uno storno» dicono
        // la stessa cosa ai fini della riapertura: quella riga NON è più viva.
        // Proseguire rende il ritentativo idempotente — ed è ciò che serve
        // quando un giro precedente ha stornato e non è riuscito a riaprire.
        // ⚠️ È la rete SECONDA, non la prima: scatta quando `stornato_il` è
        // stato marcato davvero. Quando quella marcatura muta fallisce, qui
        // non si arriva nemmeno — ferma prima `stornoGiaRegistrato`.
        logEvento('pagamento', 'warn', {
          operazione,
          esito: 'riapertura-incasso-gia-non-vivo',
          movimento_id: id,
          // `stato` numerico → `logEvento` lo promuove alla colonna `statoHttp`,
          // che è il primo filtro di qualunque query sui log.
          stato: esitoStorno.status,
        })
      } else {
        // Lo storno non è riuscito: NON si riapre. Un movimento libero con
        // l'incasso ancora vivo si fa riabbinare a un'altra voce, cioè incassare
        // due volte lo stesso denaro. Qui non è stato scritto niente.
        logErrore(
          { operazione, evento: 'riapertura_storno_fallito', stato: 500 },
          new Error(String((esitoStorno.body as { error?: string }).error ?? 'storno non riuscito')),
        )
        return {
          status: 500,
          body: {
            error: 'Non è stato possibile stornare l’incasso: il movimento non è stato riaperto.',
            codice: 'RIAPERTURA_NON_RIUSCITA',
          },
        }
      }
    }
  } else {
    // Confermato senza incasso: non dovrebbe esistere (la conferma li scrive
    // insieme), ma se esiste non è un motivo per non riaprire — è un motivo
    // per lasciarne traccia.
    logEvento('pagamento', 'warn', {
      operazione,
      esito: 'riapertura-senza-incasso',
      movimento_id: id,
    })
  }

  // ── 3. LA RIAPERTURA ──────────────────────────────────────────────────
  // Solo se non l'ha già fatta la RPC. Si azzerano i legami MORTI e si
  // CONSERVA `pagamento_id`: è la memoria di ciò a cui il bonifico era
  // legato, ed è l'unica cosa che, al riabbinamento successivo, faccia
  // scattare la guardia `BONIFICO_GIA_FATTURATO`. Si conserva anche
  // `scuola_id`, per la ragione scritta nella migrazione dell'annullo: a NULL
  // la riga sparirebbe dalla vista di sede di chi deve rilavorarla.
  if (!riapertaDallaRpc) {
    const patch: Record<string, unknown> = {
      stato: 'da_abbinare',
      incasso_id: null,
      confermato_da: null,
      confermato_il: null,
    }
    // Si scrive solo se la colonna esiste: su un DB non migrato un
    // `transazione_id: null` farebbe fallire l'UPDATE con `PGRST204`.
    if (colonnaTransazione) patch.transazione_id = null
    const { data: upd, error: errUpd } = await supabase
      .from('riconciliazione_movimenti')
      .update(patch)
      .eq('id', id)
      // CAS ottimistico: si riapre solo se la riga è ancora quella letta.
      .eq('stato', 'confermato')
      .select('id')
    if (errUpd || !upd?.length) {
      // ⚠️ QUI LO STORNO È GIÀ AVVENUTO, e la risposta lo DICE invece di
      // tacerlo. L'ordine storno → riapertura è scelto: nel verso opposto un
      // movimento libero con l'incasso ancora vivo si fa riabbinare, cioè
      // incassare due volte. Così invece resta uno storno senza riapertura,
      // che si ripara ritentando (il secondo giro trova l'incasso già
      // stornato e prosegue).
      logErrore(
        {
          operazione,
          evento: 'riapertura_non_scritta_dopo_storno',
          stato: 409,
        },
        errUpd ?? new Error('nessuna riga riaperta: il movimento è cambiato sotto la richiesta'),
      )
      return {
        status: 409,
        body: {
          error:
            'Il movimento è cambiato mentre lo si riapriva: lo storno è stato registrato, la riga ' +
            'non è tornata in coda. Ricarica l’elenco e riprova.',
          // ⚠️ NON `CONCILIAZIONE_MOVIMENTO_CAMBIATO`, e fino al 2026-09-13 lo
          // era — proprio su una risposta progettata per DICHIARARE lo storno.
          // Quel codice non sta in `CODICI_CON_DETTAGLIO`: `messaggioDaCorpo`
          // scarta la prosa appena lo riconosce, e la frase qui sopra — l'unica
          // che nomini il denaro restituito — non arrivava MAI a schermo. Al suo
          // posto usciva «un altro operatore ha appena modificato questo
          // bonifico: ricarica l'elenco e ricomponi il pagamento». Misurato
          // eseguendo `messaggioDaCorpo`, non dedotto.
          codice: 'RIAPERTURA_STORNATA_NON_RIAPERTA',
          data: { incassi_stornati: incassiStornati, transazione_annullata: transazioneAnnullata },
        },
      }
    }
  }

  // NESSUNA notifica al genitore: decisione esplicita del titolare. La
  // conferma avvisa («Pagamento registrato»), lo storno no — un avviso
  // «il tuo pagamento non risulta più» su una correzione di segreteria
  // sarebbe allarmante e quasi sempre sbagliato (la riga viene rilavorata
  // subito dopo).
  return {
    status: 200,
    body: {
      success: true,
      data: {
        stato: 'da_abbinare',
        transazione_annullata: transazioneAnnullata,
        movimenti_riaperti: movimentiRiaperti,
        incassi_stornati: incassiStornati,
      },
      ...(avviso ? { avviso } : {}),
    },
    ok: { transazioneAnnullata, incassiStornati, movimentiRiaperti, fattureVive },
  }
}
