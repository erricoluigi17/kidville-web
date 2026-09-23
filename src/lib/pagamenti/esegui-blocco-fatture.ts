import type { SupabaseClient } from '@supabase/supabase-js'
import { creaSessioneAruba, emettiFatturaPagamento, type EsitoEmissione } from '@/lib/aruba/emissione'
import type { IntestatarioScelto } from '@/lib/fatturazione/intestatario-scelto'
import type { AppUser } from '@/lib/auth/require-staff'
import { ricordaIntestatarioSullaScheda } from '@/lib/pagamenti/intestatari'
import { MOTIVO_PARTITA_NON_REGISTRATA } from '@/lib/pagamenti/fattura-partita-non-registrata'
import { logScrittura } from '@/lib/audit/scrittura'
import { logEvento } from '@/lib/logging/logger'
import {
  BUDGET_BLOCCO_MS,
  PAUSA_FRA_UPLOAD_MS,
  RISERVA_PEGGIORE_MS,
  fermaIlLotto,
} from '@/lib/pagamenti/lotto-fatture'

/**
 * ─── IL CICLO DI UN BLOCCO DI FATTURE, IN UN POSTO SOLO ─────────────────────────────
 *
 * Estratto il 2026-09-23 da `src/app/api/pagamenti/fattura/lotto/route.ts` per la coda
 * delle fatture (nucleo, §2 punto 5). Lo usano DUE chiamanti:
 *
 *  · la route del lotto (`POST /api/pagamenti/fattura/lotto`), con un blocco pilotato dal
 *    browser — comportamento INVARIATO, e a dimostrarlo restano verdi i suoi test;
 *  · il lavoratore della coda (`src/lib/fatture-coda/giro.ts`), con un blocco preso dal
 *    database a ogni giro del cron.
 *
 * ⚠️ UNA COPIA SOLA, E NON PER ELEGANZA. Tutto ciò che rende sicuro un blocco — un accesso
 * ad Aruba per blocco, il ritentativo dell'upload spento, il budget che riserva il costo
 * PEGGIORE di una fattura, lo stop su 0/429/5xx — è stato conquistato un difetto alla
 * volta. Due copie del ciclo sono due occasioni di perderne uno, e la seconda copia sarebbe
 * quella che gira senza nessuno davanti allo schermo.
 *
 * Cosa NON sta qui: lo scope di sede (lo fa chi chiama, riga per riga, prima), la guardia
 * sul tetto orario (idem: il lotto tronca, la coda prende al massimo i posti liberi) e il
 * log di fine blocco (il lotto lo scrive coi restanti OLTRE la quota, che qui non si vedono).
 */

/**
 * Una riga da emettere.
 *
 * `causale` ha la semantica a tre valori della route singola: stringa ⇒ scrive la
 * correzione manuale, `null` ⇒ la toglie, assente ⇒ non tocca niente.
 */
export interface RigaBlocco {
  pagamento_id: string
  causale?: unknown
  /**
   * L'intestatario scelto per QUESTA fattura. Il lotto porta solo il ramo `adult`
   * (`zAdultScelto` nel suo schema); la coda porta ciò che è stato accodato.
   */
  intestatario?: IntestatarioScelto
  /** Chi ha chiesto l'emissione: l'attore di `emettiFatturaPagamento`. */
  attoreId: string
  /**
   * Lo stesso attore con ruolo e sede, per il registro immodificabile delle scritture
   * (`logScrittura`). `null` = non si è potuto leggere: in quel caso il promemoria
   * sulla scheda NON si scrive — una scrittura su `alunni` senza la sua riga di audit
   * è peggio di un promemoria mancato.
   */
  attoreAudit: AppUser | null
  /**
   * La riga può ricordare l'intestatario sulla scheda del bambino (le cinque condizioni
   * restano tutte, qui sotto). Il lotto passa sempre `true`, com'è sempre stato; la coda
   * lo passa solo per le voci con la proposta del bonifico CONFERMATA.
   */
  ricordaSullaScheda: boolean
}

/** L'esito di una riga del blocco, come lo legge il pannello del lotto. */
export interface RigaEsito {
  pagamento_id: string
  numero?: number
  numeroFattura?: string
  messaggio?: string
  codice?: string
  /** Lo status che la route singola avrebbe restituito: il pannello ci ragiona sopra. */
  statoHttp?: number
}

export interface EsitoBlocco {
  emesse: RigaEsito[]
  gia_emesse: RigaEsito[]
  fallite: RigaEsito[]
  /** Le righe NON tentate, nell'ordine in cui erano: per budget o per lo stop. */
  restanti: string[]
  fermato: 'budget' | 'errore' | null
  /** Quanto è durato il ciclo, in millisecondi. */
  ms: number
}

export interface OpzioniBlocco<R extends RigaBlocco> {
  /** L'`operazione` dei log scritti dal ciclo: dice CHI stava emettendo. */
  operazione: string
  /**
   * L'istante da cui si conta il budget. Predefinito: adesso. La coda passa l'inizio del
   * giro, perché il muro di `maxDuration` vale per l'INVOCAZIONE, non per il ciclo.
   */
  inizioMs?: number
  /**
   * Chiamato dopo OGNI riga tentata, con l'esito grezzo dell'emissione, e ATTESO prima
   * della riga successiva. Serve alla coda per chiudere la voce subito: se l'invocazione
   * morisse al quinto upload, le quattro già partite devono risultare emesse, non
   * «interrotte».
   */
  dopoRiga?: (riga: R, esito: EsitoEmissione) => Promise<void>
}

/**
 * I rifiuti che nascono qui, coi loro codici.
 *
 * Copiati dalla route singola: sono pezzi di contratto che viaggiano nel JSON del lotto.
 */
const CODICE_TRASPORTO_IGNOTO = 'FATTURA_TRASPORTO_IGNOTO'
/**
 * Copiato dalla route singola (D1§8.3): «partita ma non registrata». A differenza del
 * trasporto ignoto, questo 409 NON ferma il blocco — vedi `fermaIlLotto` — perché il
 * guasto è di QUEL pagamento, non del canale verso Aruba.
 */
const CODICE_PARTITA_NON_REGISTRATA = 'FATTURA_PARTITA_NON_REGISTRATA'

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Emette le righe una dopo l'altra, con UN accesso ad Aruba per tutto il blocco.
 *
 * Non lancia di suo: un'eccezione di `emettiFatturaPagamento` risale al chiamante così
 * com'è (nel lotto diventa il 500 di `withRoute`, com'è sempre stato).
 */
export async function eseguiBloccoFatture<R extends RigaBlocco>(
  supabase: SupabaseClient,
  righe: readonly R[],
  opzioni: OpzioniBlocco<R>,
): Promise<EsitoBlocco> {
  const { operazione, dopoRiga } = opzioni

  // La sessione è ciò per cui esiste il blocco: un accesso per blocco invece che uno per
  // fattura. La prima emissione lo apre — `ensureToken()` sta prima della RPC — e le
  // altre lo riusano.
  const sessione = creaSessioneAruba()
  const inizio = opzioni.inizioMs ?? Date.now()
  const emesse: RigaEsito[] = []
  const giaEmesse: RigaEsito[] = []
  const fallite: RigaEsito[] = []
  const restanti: string[] = []
  let fermato: 'budget' | 'errore' | null = null

  for (let i = 0; i < righe.length; i++) {
    const riga = righe[i]

    // Il budget si guarda PRIMA di ogni fattura, e riserva il costo peggiore di una
    // sola: quel che resta deve bastare anche alla fattura più sfortunata.
    if (Date.now() - inizio + RISERVA_PEGGIORE_MS > BUDGET_BLOCCO_MS) {
      fermato = 'budget'
      restanti.push(...righe.slice(i).map((r) => r.pagamento_id))
      break
    }

    // Il ritmo fra un upload e il successivo. Non prima del primo: sarebbe attesa
    // comprata per niente dentro un'invocazione a tempo.
    if (i > 0) await attendi(PAUSA_FRA_UPLOAD_MS)

    // La causale, con la stessa semantica a tre valori della route singola.
    // `fattura_causale` è appiccicoso: una volta scritto batte qualunque modello
    // configurato, per sempre. Il lotto non personalizza mai, quindi manda `null` e
    // toglie l'eventuale correzione rimasta da un'emissione precedente.
    const scriviCausale =
      typeof riga.causale === 'string' && riga.causale.trim()
        ? riga.causale.trim()
        : riga.causale === null
          ? null
          : undefined
    if (scriviCausale !== undefined) {
      // PostgREST non lancia (AGENTS.md, regola 7): l'esito va guardato. Non è
      // bloccante — la causale composta resta corretta — ma un fallimento muto qui
      // rimetterebbe in circolo una correzione congelata.
      const { error: errCausale } = await supabase
        .from('pagamenti')
        .update({ fattura_causale: scriviCausale })
        .eq('id', riga.pagamento_id)
      if (errCausale) {
        logEvento('fattura', 'warn', {
          operazione,
          esito: scriviCausale === null ? 'causale-manuale-non-rimossa' : 'causale-manuale-non-salvata',
          pagamento_id: riga.pagamento_id,
        }, errCausale)
      }
    }

    const esito = await emettiFatturaPagamento(
      supabase,
      riga.pagamento_id,
      { id: riga.attoreId },
      { sessione, ritentaUpload: false, intestatarioScelto: riga.intestatario },
    )

    if (esito.ok) {
      const voce: RigaEsito = {
        pagamento_id: riga.pagamento_id,
        numero: esito.numero,
        numeroFattura: esito.numeroFattura,
      }
      // «Già a registro» non è «emessa adesso»: contarle insieme farebbe dire al
      // pannello «emesse 15» quando le nuove erano tre.
      if (esito.gia) giaEmesse.push(voce)
      else emesse.push(voce)

      await ricordaChiHaPagato(supabase, riga, esito, operazione)
      if (dopoRiga) await dopoRiga(riga, esito)
      continue
    }

    const trasporto = esito.motivo === 'errore' && esito.httpStatus === 502
    const partitaNonRegistrata = esito.motivo === MOTIVO_PARTITA_NON_REGISTRATA
    fallite.push({
      pagamento_id: riga.pagamento_id,
      messaggio: esito.messaggio,
      statoHttp: esito.httpStatus,
      ...(trasporto ? { codice: CODICE_TRASPORTO_IGNOTO } : {}),
      ...(partitaNonRegistrata ? { codice: CODICE_PARTITA_NON_REGISTRATA } : {}),
    })
    if (dopoRiga) await dopoRiga(riga, esito)

    // `fermaIlLotto` è lo stesso verdetto che usava il browser, e resta lì: 0, 429 e
    // ogni 5xx dicono che il problema non è della riga ma del canale, e insistere
    // sulle successive è il modo di peggiorarlo.
    if (fermaIlLotto(esito.httpStatus)) {
      fermato = 'errore'
      restanti.push(...righe.slice(i + 1).map((r) => r.pagamento_id))
      break
    }
  }

  return { emesse, gia_emesse: giaEmesse, fallite, restanti, fermato, ms: Date.now() - inizio }
}

/**
 * ─── RICORDA CHI HA PAGATO ───────────────────────────────────────────────────────────
 * La fattura è uscita intestata al genitore riconosciuto dall'ordinante del bonifico: lo
 * si scrive sulla scheda del bambino, così il mese prossimo la cascata risponde da sola
 * senza dedurre niente.
 *
 * 🔴 QUESTA SCRITTURA NON DECIDE SOLO LE FATTURE. `alunni.intestatario_fatture` è il «CF
 * pagatore» della comunicazione all'Agenzia delle Entrate (`api/pagamenti/export`) e
 * l'intestatario dell'attestazione per il 730 (`api/pagamenti/attestazione`): prima della
 * scrittura quel bambino stava fra le «Escluse» per «codice fiscale del pagatore mancante»,
 * dopo la sua spesa viene comunicata a nome di quell'adulto. Decide una DETRAZIONE, non
 * una PDF.
 *
 * Le CINQUE condizioni sono tutte necessarie e nessuna è prudenza:
 *  · `!esito.gia` — una riga ripescata dal registro non dice niente su OGGI, e la sua
 *    fattura può essere stata intestata da tutt'altro;
 *  · `intestatario?.tipo === 'adult'` — se la riga non porta un intestatario ha deciso la
 *    cascata, cioè l'anagrafica sapeva già rispondere;
 *  · `esito.alunnoId` — `null` su un pagamento non legato a nessun bambino (una vendita di
 *    merchandise), e lì non c'è nessuna scheda;
 *  · `esito.cascataVuota` — NESSUNA fonte aveva saputo dire a chi intestare. Se una l'aveva
 *    detto ed era solo incompleta (uno split di genitori separati, il default di famiglia,
 *    una scelta di Segreteria), la fonte forte esiste già e una deduzione da un estratto
 *    conto non se ne appropria. È anche ciò che tiene fuori i genitori separati con una
 *    quota sola, che `ripartito` — definito come `quote.length > 1` — non vede;
 *  · `categoriaSlug === 'retta'` — chi salda una mensa, un grembiule o del materiale non
 *    deve diventare il pagatore fiscale permanente di quel bambino. Misurato il
 *    2026-09-08: 91 righe candidate non sono rette, e per 26 bambini l'UNICO candidato
 *    non lo è.
 * La sesta — «la scheda dev'essere vuota» — sta dentro la `WHERE` della UPDATE. E a monte
 * di tutte c'è `riga.ricordaSullaScheda`: la coda ricorda solo la proposta del bonifico
 * CONFERMATA, mai la scelta fatta a mano da chi aveva il nome sotto gli occhi.
 *
 * ⚠️ L'ALUNNO E LA CASCATA VENGONO DALL'ESITO, non da una seconda lettura: è la stessa riga
 * che ha appena prodotto il documento, e ha già passato il gate di sede.
 *
 * ⚠️ FAIL-OPEN, e va detto per intero: qui la fattura è GIÀ partita verso lo SdI e non si
 * disfa. Un promemoria non salvato è un fastidio; un'eccezione in questo punto uscirebbe
 * dal ciclo perdendo per strada l'elenco delle emesse, già costruito e mai restituito. Per
 * questo la chiamata sta dentro un `try`, e per questo si logga anche il SUCCESSO
 * (AGENTS.md, regola 5).
 */
async function ricordaChiHaPagato(
  supabase: SupabaseClient,
  riga: RigaBlocco,
  esito: Extract<EsitoEmissione, { ok: true }>,
  operazione: string,
): Promise<void> {
  if (
    !riga.ricordaSullaScheda ||
    esito.gia ||
    riga.intestatario?.tipo !== 'adult' ||
    !esito.alunnoId ||
    !esito.cascataVuota ||
    esito.categoriaSlug !== 'retta'
  ) {
    return
  }
  const alunnoId = esito.alunnoId
  const adultId = riga.intestatario.adult_id
  const attore = riga.attoreAudit
  if (!attore) {
    // Senza l'attore la scrittura non avrebbe la sua riga nel registro immodificabile:
    // alla domanda «chi ha deciso che la detrazione di questo bambino va a questo
    // genitore?» non risponderebbe nessuno. Si rinuncia al promemoria, e lo si dice.
    logEvento(
      'fattura',
      'warn',
      {
        operazione,
        esito: 'intestatario-non-ricordato-attore-ignoto',
        pagamento_id: riga.pagamento_id,
        alunno_id: alunnoId,
      },
      undefined,
      { distingui: ['alunno_id'] },
    )
    return
  }
  try {
    const { esito: ricordato, error: erroreRicorda } = await ricordaIntestatarioSullaScheda(
      supabase,
      alunnoId,
      adultId,
    )
    // ⚠️ `distingui: ['alunno_id']` NON è un vezzo: `app_log` deduplica per
    // `(fingerprint, giorno)` e l'`ON CONFLICT` somma le occorrenze SENZA aggiornare il
    // contesto. Senza, dodici schede scritte in un pomeriggio diventano UNA riga che nomina
    // il primo bambino e mente sugli altri undici — e questa è l'unica ricostruibilità di
    // una scrittura decisa da un'euristica su dati di minori. Il volume è già limitato dal
    // tetto orario di Aruba, quindi il costo della distinzione è dichiarabile.
    logEvento(
      'fattura',
      ricordato === 'non_salvato' ? 'warn' : 'info',
      {
        operazione,
        esito: `intestatario-${ricordato.replace(/_/g, '-')}`,
        pagamento_id: riga.pagamento_id,
        alunno_id: alunnoId,
      },
      erroreRicorda ?? undefined,
      { distingui: ['alunno_id'] },
    )
    // Il registro immodificabile delle scritture su `alunni` (DL-037): la stessa colonna,
    // quando la cambia una persona dalla scheda, ne lascia una.
    if (ricordato === 'salvato') {
      await logScrittura(supabase, {
        attore,
        entitaTipo: 'alunni',
        entitaId: alunnoId,
        azione: 'update',
        valoreDopo: { intestatario_fatture: { tipo: 'adult', adult_id: adultId } },
      })
    }
  } catch (err) {
    logEvento(
      'fattura',
      'warn',
      {
        operazione,
        esito: 'intestatario-non-ricordato',
        pagamento_id: riga.pagamento_id,
        alunno_id: alunnoId,
      },
      err,
      { distingui: ['alunno_id'] },
    )
  }
}
