import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { residuoEffettivo } from '@/lib/pagamenti/aging'
import { formatEuro } from '@/lib/format/valuta'
// «QUESTO DOCUMENTO È ANCORA VIVO?» HA UNA DEFINIZIONE SOLA, e non sta più qui.
// Fino al 2026-09-13 la rotta ne teneva una copia locale (`fatturaViva`,
// `etichettaFattura`, `RigaFattura`), nata quando `componi` non poteva toccarla.
// Le due espressioni erano identiche — misurato: stesso verdetto su tutti gli
// stati SDI 0-20, su `null` e sui fuori scala, e stessa etichetta su 100
// combinazioni di numero/anno/sezionale — ed è per questo che sono state unite.
// Le due porte che arrivano allo stesso riabbinamento sono QUESTA (la conferma a
// voce singola) e `…/componi:POST` (la composizione): due definizioni di «viva»
// direbbero due cose diverse dello stesso documento, una fermerebbe e l'altra
// lascerebbe passare — la seconda con un 200 sopra.
import { fatturaViva, etichettaFattura, type RigaFatturaEmessa } from '@/lib/pagamenti/fattura-viva'

// ─────────────────────────────────────────────────────────────────────────────
// LA CONFERMA DI UN BONIFICO SU UNA VOCE SOLA — fuori dalla rotta che la chiama.
//
// ─── PERCHÉ NON STA PIÙ DENTRO `riconciliazione/[id]:PATCH` ─────────────────
// Le porte che arrivano a questo stesso riabbinamento stanno per diventare più
// d'una: l'import dell'estratto conto dovrà confermare da sé i bonifici che
// riconosce, e un endpoint nuovo dovrà annullarli in blocco. Nessuna di quelle
// due passa da `requireStaff`, da `parseBody` o da una `Request` — ma tutte e due
// devono passare dalle GUARDIE che stanno qui sotto, che sono le stesse.
//
// Ricopiarle è il modo certo di farle divergere, e in questo repository è già
// successo: quando un predicato è scritto in linea in due punti, la correzione è
// una funzione esportata, non due modifiche gemelle. La copia più cara costata
// finora era proprio qui accanto — `fatturaViva` riscritta in casa — e l'ha
// pagata il lock `annullo-riapre-movimento` con un riquadro suo.
//
// ─── DUE SCELTE DI PROGETTO, E VALGONO PER CHI ARRIVERÀ DOPO ────────────────
//
//  1. IL PERIMETRO DI SEDE ARRIVA COME PARAMETRO (`sediAmmesse`), non si risolve
//     qui dentro. `resolveScuoleAttive` vuole la `Request` — che l'automatismo
//     non ha — ma soprattutto la differenza fra i due percorsi è una DECISIONE e
//     non un dettaglio: il percorso manuale registra sulle sedi dell'operatore,
//     quello automatico su un perimetro che chi lo scriverà dovrà dichiarare. Un
//     modulo che se lo risolvesse da sé sceglierebbe per tutt'e due, e la
//     differenza diventerebbe accidentale invece che scritta.
//
//  2. QUI NON SI FA AUDIT, NON SI NOTIFICA, NON SI REVOCA LA SOSPENSIONE e non
//     si logga l'esito complessivo. Non perché siano dettagli: perché solo il
//     chiamante sa se sta rispondendo a una persona davanti a uno schermo o
//     chiudendo un import notturno — e «Pagamento registrato» mandato a una
//     famiglia è una cosa che non si disfa. Il chiamante riceve in `ok` tutto ciò
//     che gli serve per farlo.
//
// L'esito è `{ status, body }` come `eseguiStornoIncasso`: nessuna
// `NextResponse` qui dentro, perché la forma della risposta HTTP è della rotta.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il movimento bancario che si sta per confermare, ridotto ai campi che questa
 * conferma legge davvero. La riga intera — con la prosa che spiega ogni colonna —
 * resta della rotta, che la legge dal database: qui si dichiara il contratto, non
 * lo schema.
 */
export interface MovimentoDaConfermare {
  id: string
  importo: number | string
  data_operazione: string
  causale: string | null
  /** Lo stato letto: è il valore del compare-and-swap, non un'etichetta. */
  stato: string
  /**
   * Il pagamento a cui questo bonifico era già abbinato. Valorizzato NON vuol
   * dire «riga confermata»: la riapertura lo CONSERVA apposta, ed è la memoria su
   * cui poggia la guardia qui sotto.
   */
  pagamento_id: string | null
}

/** Ciò che la conferma ha scritto, per chi deve ancora fare audit e notifica. */
export interface ConfermaRiuscita {
  incassoId: string
  pagamentoId: string
  pagamento: {
    scuolaId: string
    alunnoId: string | null
    descrizione: string | null
  }
}

export interface EsitoConferma {
  status: number
  body: Record<string, unknown>
  /** Presente SOLO quando l'incasso è stato registrato e il movimento legato. */
  ok?: ConfermaRiuscita
}

// SELECT del pagamento con le colonne Contabilità v2 (sconto) e quelle per il residuo effettivo.
// Sul DB E2E CI (non migrato) `sconto` non esiste → 42703: si ritenta senza (residuoEffettivo
// tratta sconto assente come 0). Stesso pattern di /api/pagamenti.
const PAG_SELECT_BASE = 'id, scuola_id, stato, alunno_id, descrizione, importo, importo_pagato, scadenza'
const PAG_SELECT_V2 = 'id, scuola_id, stato, alunno_id, descrizione, importo, importo_pagato, sconto, scadenza'

/**
 * Abbina un bonifico a UNA voce: guardie, incasso, compare-and-swap.
 *
 * L'ordine dei passi non è un caso e non si riordina — ogni guardia sta davanti a
 * tutto ciò che scrive o legge per conto suo, e il perché sta scritto sopra
 * ciascuna.
 */
export async function confermaSuVoceSingola(
  supabase: SupabaseClient,
  args: {
    movimento: MovimentoDaConfermare
    pagamentoId: string
    /** Le sedi su cui il chiamante può registrare un incasso. Vedi la scelta n. 1 in testata. */
    sediAmmesse: string[]
    /**
     * Chi firma l'incasso e la conferma (`registrato_da`, `confermato_da`).
     *
     * ⚠️ RESTA VALORIZZATO ANCHE QUANDO `automatico` è vero, e non è un ripiego:
     * quell'uuid finisce in `incassi.registrato_da`, cioè in un registro
     * contabile. Scriverlo a NULL per distinguere la macchina avrebbe
     * risparmiato una colonna al prezzo di un registro anonimo — e sarebbe
     * anche falso: qualcuno ha comunque premuto «Importa».
     */
    attoreId: string
    /** Il nome dell'operazione nei log: lo dichiara il chiamante, che è l'unico a saperlo. */
    operazione: string
    /**
     * `true` quando a decidere questo abbinamento è stata l'APPLICAZIONE, senza
     * un click: la riga si marca con `abbinato_auto_il`, dentro lo stesso
     * compare-and-swap che la conferma.
     *
     * Default `false` = il comportamento di oggi, colonna non toccata. Il verso
     * è scelto: chi arriva da una schermata non deve sapere che questa marca
     * esiste, e un `undefined` non deve mai voler dire «forse automatico».
     *
     * 🔴 CHI LO METTE A `true` DEVE AVER CHIESTO PRIMA `marcaAutomaticaDisponibile`.
     * Non si controlla qui, e non per pigrizia: se la colonna non c'è
     * l'abbinamento automatico non deve PARTIRE — non «partire senza marca» —
     * perché senza la marca non esiste l'annullamento in blocco, e un
     * automatismo che non si può disfare non è quello che è stato chiesto.
     * Decidere quello qui dentro, a incasso già scritto, sarebbe troppo tardi:
     * la decisione sta a monte, dove si sceglie se far partire l'automatismo.
     */
    automatico?: boolean
  },
): Promise<EsitoConferma> {
  const { movimento: mov, pagamentoId, sediAmmesse, attoreId, operazione, automatico } = args

  // ── 🔴 UN BONIFICO NON SI FATTURA DUE VOLTE ──────────────────────────────
  // La fattura si emette per `pagamento_id`, e la guardia contro il secondo
  // documento (`emettiFatturaPagamento`) confronta le righe vive di
  // `fatture_emesse` DELLO STESSO pagamento. Non vede niente, quindi, quando è
  // il BONIFICO a cambiare pagamento sotto di lei: il movimento che aveva
  // saldato la retta P1 — già fatturata — viene riabbinato a P2, e P2 nasce
  // libero da fatture. Restano in circolazione un documento fiscale senza
  // l'incasso che lo giustifica e un avviso «Pagamento registrato» al genitore,
  // entrambi con un 200 sopra e nessuna riga d'errore da nessuna parte.
  //
  // ⚠️ NON È PIÙ UNA GUARDIA DIFENSIVA: dal 2026-09-12 sta sulla strada
  // principale — e fino a quel giorno qui era scritto il contrario.
  // Prima, lo stato che la fa scattare era irraggiungibile: `pagamento_id` lo
  // scriveva solo la conferma qui sotto, e un confermato non tornava indietro
  // (`ignora` e `riapri` rispondono 409 su un confermato). Adesso
  // `annulla_transazione_contabile` riapre il movimento della transazione
  // annullata — `stato` torna `da_abbinare` — e gli LASCIA `pagamento_id`; e
  // l'annullo non è un intervento a mano, è un pulsante del registro
  // (`TransazioniPanel` → `pagamenti/transazioni/[id]/annulla:POST`).
  // Il percorso «il bonifico M salda la transazione T, la cui voce di
  // ancoraggio è P1 → su P1 si emette la fattura → si annulla T → M torna in
  // coda → l'operatore lo riabbina a P2» è quindi normale amministrazione, non
  // un'ipotesi: questo `if` è l'unica cosa che lo ferma, e la migrazione
  // conserva `pagamento_id` PROPRIO perché lui lo legga — le due metà le tiene
  // insieme il lock `__tests__/architecture/annullo-riapre-movimento.test.ts`.
  // Costa una lettura, e solo quando il pagamento cambia davvero.
  //
  // Sta QUI, prima di ogni altra lettura e di ogni scrittura, per una ragione
  // sola: finché una guardia sta in fondo, tutto ciò che le sta davanti ha già
  // letto, scritto o notificato quando lei dice di no.
  if (mov.pagamento_id != null && mov.pagamento_id !== pagamentoId) {
    const { data: righeFattura, error: errFatture } = await supabase
      .from('fatture_emesse')
      .select('numero, anno, sezionale, sdi_stato')
      .eq('pagamento_id', mov.pagamento_id)
    // PostgREST non lancia: ritorna `{ error }`. Con l'errore scartato, `data`
    // vale null, «nessuna fattura» e «non l'abbiamo potuta leggere» diventano
    // la stessa cosa, e un guasto di lettura si trasforma in un secondo
    // incasso. Fail-closed, come l'idempotenza del motore: se non è
    // VERIFICABILE, non si riabbina.
    if (errFatture) {
      logErrore(
        { operazione, evento: 'fatture_del_movimento_non_lette', stato: 503 },
        errFatture,
      )
      return {
        status: 503,
        body: {
          error:
            'Non è stato possibile verificare se questo bonifico sia già stato fatturato: il ' +
            'riabbinamento è stato fermato per non rischiare un secondo documento. Riprova fra qualche minuto.',
          codice: 'BONIFICO_FATTURA_NON_VERIFICABILE',
        },
      }
    }
    const righe = (righeFattura ?? []) as RigaFatturaEmessa[]
    // Le righe VIVE: il predicato sta in `fatturaViva`, in un posto solo — lo
    // legge anche l'avviso della riapertura, e due definizioni di «viva»
    // direbbero due cose diverse dello stesso documento.
    const viva = righe.find(fatturaViva)
    if (viva) {
      const annoViva = viva.anno ?? new Date().getFullYear()
      const numeroFattura = etichettaFattura(viva)
      // `esito` è in lista bianca e resta in chiaro: «quante volte si è tentato
      // di spostare un bonifico già fatturato» diventa una query. Numeri e
      // uuid, niente altro: la causale del bonifico porta i nomi delle famiglie.
      logEvento('pagamento', 'warn', {
        operazione,
        esito: 'bonifico-gia-fatturato-fermato',
        pagamento_id: mov.pagamento_id,
        numero: viva.numero,
        anno: annoViva,
      })
      // La prosa dice il FATTO col numero — che il catalogo non può conoscere,
      // ed è l'unica cosa che dica quale documento andare a guardare; la
      // conseguenza e il rimedio stanno nella frase tradotta
      // (`BONIFICO_GIA_FATTURATO` è in `CODICI_CON_DETTAGLIO`, quindi a schermo
      // si leggono tutte e due).
      return {
        status: 409,
        body: {
          error: `Fattura viva sulla voce attualmente abbinata: ${numeroFattura}.`,
          codice: 'BONIFICO_GIA_FATTURATO',
        },
      }
    }
  }

  let { data: pag, error: errPag } = await supabase
    .from('pagamenti')
    .select(PAG_SELECT_V2)
    .eq('id', pagamentoId)
    .maybeSingle()
  if (errPag?.code === '42703') {
    // DB E2E CI non migrato: colonna `sconto` assente → ritenta senza.
    ;({ data: pag, error: errPag } = await supabase
      .from('pagamenti')
      .select(PAG_SELECT_BASE)
      .eq('id', pagamentoId)
      .maybeSingle())
  }
  // Vincolo di SCRITTURA: una segreteria registra un incasso solo sulla PROPRIA sede.
  if (!pag || !sediAmmesse.includes((pag as { scuola_id: string }).scuola_id)) {
    return { status: 404, body: { error: 'Pagamento non trovato' } }
  }
  const pagDett = pag as {
    scuola_id: string; alunno_id: string | null; descrizione: string | null; stato: string
    importo: number | string; importo_pagato?: number | string | null
    sconto?: number | string | null; scadenza?: string | null
  }

  // GUARD unificato sul residuo: si evita OGNI sovra-incasso (importo_pagato che sfonda importo).
  //  • residuo ≤ 0 → voce già saldata (es. incasso a mano): niente secondo incasso.
  //  • bonifico > residuo → registrare l'INTERO bonifico come incasso su questa voce sfonderebbe
  //    l'importo, senza 409 e con notifica «Pagamento registrato» al genitore. Si blocca e si
  //    rimanda all'«Incasso unico», che gestisce l'eccedenza come credito.
  const residuo = Math.round(residuoEffettivo(pagDett) * 100) / 100
  if (residuo <= 0) {
    return {
      status: 409,
      body: { error: 'Pagamento già saldato: ignora la riga o scegli un\'altra voce' },
    }
  }
  if (Number(mov.importo) > residuo) {
    return {
      status: 409,
      body: {
        error: `L'importo del bonifico (${formatEuro(mov.importo)}) supera il residuo (${formatEuro(residuo)}): usa «Incasso unico» per gestire l'eccedenza/credito`,
      },
    }
  }

  const { data: incasso, error: errInc } = await supabase
    .from('incassi')
    .insert({
      pagamento_id: pagamentoId,
      importo: mov.importo,
      data_incasso: mov.data_operazione,
      metodo: 'bonifico',
      note: `Riconciliazione: ${(mov.causale ?? '').slice(0, 160)}`.trim(),
      registrato_da: attoreId,
    })
    .select()
    .single()
  if (errInc) {
    return {
      status: 500,
      body: { error: 'Errore nella registrazione dell’incasso', details: errInc.message },
    }
  }

  // CAS ottimistico: conferma solo se il movimento è ancora nello stato letto.
  // Due conferme concorrenti creerebbero due incassi per lo stesso bonifico
  // (#12): se la corsa è persa, storna l'incasso appena inserito.
  //
  // ── 🔴 LA MARCA STA DENTRO QUESTO `update`, E NON IN UNO DOPO ────────────
  // Un secondo UPDATE non sarebbe atomico con la conferma, e l'esito parziale
  // ha un nome preciso: una riga confermata dalla macchina e NON marcata, cioè
  // una riga che l'annullamento in blocco — il solo motivo per cui la marca
  // esiste — non troverà mai più. Qui invece la marca vive o muore con il CAS:
  // se la corsa è persa, l'`update` non tocca nessuna riga e l'incasso appena
  // inserito viene cancellato subito sotto.
  //
  // E la chiave si AGGIUNGE solo quando serve, invece di scrivere sempre
  // `abbinato_auto_il: automatico ? … : null`: sul DB E2E della CI la colonna
  // non esiste, e una chiave sconosciuta fa fallire l'intero UPDATE con
  // `PGRST204` — cioè la conferma manuale, che con questa marca non c'entra
  // niente, cadrebbe su ogni ambiente non migrato. Il percorso manuale non ha
  // niente da spegnere: una riga che si sta confermando non è confermata, e
  // l'unico modo di arrivarci marcata sarebbe passare da una riapertura, che la
  // marca la azzera (`riapertura-movimento.ts` e
  // `annulla_transazione_contabile`).
  //
  // ⚠️ QUELLA FRASE POGGIA SU UN'INVARIANTE, e va detta invece di darla per
  // scontata: la riapertura azzera la marca SEMPRE, o rifiuta. Il 2026-09-20 non
  // era così — su un guasto qualunque della lettura la rotta proseguiva
  // «senza marca», cioè lasciandola ACCESA su una riga tornata `da_abbinare` — e
  // quel ramo rendeva falsa questa riga. Adesso in `…/[id]/route.ts` la marca si
  // chiede dentro la lettura del movimento: `42703`/`PGRST204` degradano,
  // qualunque altro errore esce 500 PRIMA dello storno. Chi tocca quel ramo
  // rilegga questa riga: sono la stessa decisione scritta in due posti.
  //
  // ⚠️ E LE DUE PORTE MANUALI RESTANO ASIMMETRICHE, per una scelta misurata.
  // `registraConciliazione` manda `abbinato_auto: false` alla RPC, che AZZERA la
  // marca anche sul percorso manuale; qui non si scrive niente. Renderle uguali
  // vorrebbe dire un `abbinato_auto_il: null` incondizionato, che su un DB non
  // migrato fa cadere la conferma a voce singola con `PGRST204` — quindi
  // servirebbe un parametro `colonnaMarca` in più, portato fin qui da chi chiama.
  // Non si paga, perché non c'è niente da correggere: data l'invariante qui
  // sopra, una riga `da_abbinare` marcata non esiste. Il giorno in cui quella
  // invariante cadesse, questa asimmetria diventerebbe un difetto — ed è scritto
  // qui perché non lo si scopra a incidente avvenuto.
  const patch: Record<string, unknown> = {
    stato: 'confermato',
    pagamento_id: pagamentoId,
    incasso_id: (incasso as { id: string }).id,
    // Il movimento (finora globale/senza sede) assume la sede del pagamento confermato.
    scuola_id: pagDett.scuola_id,
    confermato_da: attoreId,
    confermato_il: new Date().toISOString(),
  }
  if (automatico) patch.abbinato_auto_il = new Date().toISOString()
  const { data: updated, error: errUpd } = await supabase
    .from('riconciliazione_movimenti')
    .update(patch)
    .eq('id', mov.id)
    .eq('stato', mov.stato)
    .select('id')
  if (errUpd || !updated || updated.length === 0) {
    await supabase.from('incassi').delete().eq('id', (incasso as { id: string }).id)
    return { status: 409, body: { error: 'Movimento già riconciliato da un altro operatore' } }
  }

  return {
    status: 200,
    body: { success: true, data: { incasso_id: (incasso as { id: string }).id } },
    ok: {
      incassoId: (incasso as { id: string }).id,
      pagamentoId,
      pagamento: {
        scuolaId: pagDett.scuola_id,
        alunnoId: pagDett.alunno_id,
        descrizione: pagDett.descrizione,
      },
    },
  }
}
