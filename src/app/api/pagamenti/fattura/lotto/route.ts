import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { zAdultScelto } from '@/lib/fatturazione/intestatario-scelto'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { TETTO_BLOCCO } from '@/lib/pagamenti/lotto-fatture'
import { eseguiBloccoFatture } from '@/lib/pagamenti/esegui-blocco-fatture'
import {
  contaEmesseUltimaOra,
  posizioniDisponibili,
  quanteSePossonoTentare,
  SOGLIA_ORARIA_APP,
} from '@/lib/pagamenti/tetto-orario-aruba'

/**
 * ─── UN BLOCCO DI FATTURE, EMESSO DAL SERVER ────────────────────────────────────────
 *
 * Prima il lotto viveva nel browser: una POST per riga, e fra una riga e l'altra novanta
 * secondi di attesa. Non erano gli upload a imporli — era il `signin`. Ogni POST è
 * un'invocazione serverless nuova, quindi ogni fattura si autenticava da capo, e Aruba
 * concede **un accesso al minuto per IP**. Sessanta fatture costavano ~87 minuti di
 * scheda presidiata.
 *
 * Qui l'accesso si fa **una volta per blocco** (`creaSessioneAruba`), e con esso la
 * lettura del progressivo: sessanta fatture diventano quattro blocchi, cioè ~6 minuti.
 *
 * ⚠️ SUL THROUGHPUT IL GUADAGNO È 1,5×, NON 5×, e vale la pena scriverlo. Aruba concede
 * **60 upload l'ora** e nessuna architettura può alzarlo: prima il tetto sostenibile era
 * ~41/ora, adesso è 60. Il guadagno vero è sul **tempo di una persona davanti a una
 * barra**: da ottantasette minuti a sei.
 *
 * ─── PERCHÉ A BLOCCHI E NON IN UNA CHIAMATA SOLA ────────────────────────────────────
 * Una POST che emettesse tutte e sessanta durerebbe ~2,5 minuti contro un muro di 5,
 * senza mostrare niente mentre lavora, e se scadesse a metà lascerebbe numeri consumati
 * **senza esito noto e senza che il browser sappia dove si è fermata**. Un blocco da
 * quindici dura ~40 secondi: sette volte di margine, e riprende da dove si era
 * interrotto. I tre minuti di differenza si pagano in attese fra i blocchi — obbligate
 * comunque, perché ogni blocco fa il suo accesso.
 *
 * ─── LE TRE COSE CHE RENDONO VERO «NESSUN NUMERO È STATO CONSUMATO» ─────────────────
 *  1. **L'accesso viene prima dell'allocazione.** Non serve farlo qui: da
 *     `emissione.ts` `ensureToken()` è chiamato prima della RPC anche a pavimento in
 *     cache, e la sessione lo riusa. Un `429` sull'accesso fa morire il blocco **senza
 *     che nessun numero sia stato preso**.
 *  2. **Il ritentativo dopo un `429` è spento** (`ritentaUpload: false`). Quei novanta
 *     secondi vivono dentro `arubaUpload`, dove non c'è nessun punto di controllo: una
 *     fattura che partisse con sessanta secondi di margine finirebbe oltre il muro col
 *     numero già allocato. Qui sul `429` il blocco si ferma e restituisce i rimanenti.
 *  3. **Il budget riserva il costo PEGGIORE di una fattura**, non la media
 *     (`RISERVA_PEGGIORE_MS`). Una guardia tarata sui tre secondi medi sarebbe una
 *     guardia che non guarda proprio il caso per cui esiste.
 *
 * ─── LA RIPRESA NON È GRATUITA, E VA DETTO ──────────────────────────────────────────
 * L'idempotenza di `emettiFatturaPagamento` copre i blocchi FINITI: una quota già a
 * registro non si riemette. **Non copre** il caso per cui servirebbe di più — morte fra
 * l'upload e l'INSERT — perché lì non c'è nessuna riga da leggere. Dopo un blocco senza
 * risposta leggibile **non si rilancia alla cieca**: si rifà il pre-volo
 * (`GET /api/pagamenti/fattura/anteprima`, che non spende quota Aruba) e si rilancia solo
 * ciò che risulta ancora da fatturare.
 */

/**
 * ⚠️ 300 SECONDI SCRITTI A MANO, e non la costante da cui il budget si deriva.
 *
 * Next analizza la configurazione di segmento **staticamente**: un valore importato non
 * è un letterale, e il build si ferma con «Invalid segment configuration export
 * detected». Non è una scelta di stile — è l'unica forma che la piattaforma accetta.
 *
 * Il prezzo è un numero scritto in due posti, e il prezzo di un numero scritto in due
 * posti è che diverge in silenzio: il budget resterebbe tarato su un muro che non
 * esiste più. A tenerli insieme c'è un test che legge QUESTO sorgente e confronta il
 * letterale con la costante.
 *
 * E resta comunque una RICHIESTA: se il piano dell'account la tosasse, il budget sarebbe
 * sbagliato senza che nessuno se ne accorga. Per questo `ms` finisce nel log di fine
 * blocco — una tosatura di piattaforma si vedrebbe lì.
 */
export const maxDuration = 300

const bodySchema = z.object({
  pagamenti: z
    .array(
      z.object({
        pagamento_id: zUuid,
        // Stessa semantica a tre valori della route singola: stringa ⇒ scrive la
        // correzione manuale, `null` ⇒ la toglie, assente ⇒ non tocca niente.
        causale: z.unknown().optional(),
        /**
         * L'intestatario proposto dal bonifico, riga per riga.
         *
         * ⚠️ NON È FACOLTATIVO PER COMODITÀ. `zod` è una lista bianca **in scrittura**:
         * un campo non dichiarato viene scartato **in silenzio**, con un 200. Se questa
         * riga mancasse, il pannello continuerebbe a mandare l'intestatario scelto e il
         * blocco lo butterebbe via, lasciando decidere al server la cascata predefinita
         * — fatture intestate a qualcun altro, e nessuna schermata che lo dica.
         *
         * ⚠️ SOLO IL RAMO `adult`, e non è una restrizione di gusto: fino al 2026-09-08
         * qui stava l'unione INTERA (`zIntestatarioScelto`), ramo `persona` compreso,
         * mentre il commento di `CorpoEmissione` dichiarava che «lo schema della POST lo
         * vieta per iscritto». Non lo vietava. Il lotto non ha nessun modulo da
         * compilare: accettare da qui nome, codice fiscale e residenza digitati nel
         * browser significherebbe farli finire su un documento fiscale che nessuno
         * rilegge — quindici alla volta. Adesso il commento è vero perché lo schema lo
         * rende vero.
         *
         * Dal browser viaggia solo l'id; nome, codice fiscale e residenza si rileggono
         * da `parents` lato server.
         */
        intestatario: zAdultScelto.optional(),
      }),
    )
    .min(1)
    .max(TETTO_BLOCCO),
})

/**
 * Il rifiuto che nasce qui, col suo codice.
 *
 * Costante LOCALE e letterale: il lock `errori-con-codice` risolve `codice: X` solo se
 * `X` è una stringa nel corpo oppure un `const X = '…'` di QUESTO file. Un valore che il
 * lock non sa leggere è un valore che nessuno controlla.
 *
 * (I codici delle righe fallite — `FATTURA_TRASPORTO_IGNOTO`, `FATTURA_PARTITA_NON_REGISTRATA`
 * — stanno col ciclo in `src/lib/pagamenti/esegui-blocco-fatture.ts` dal 2026-09-23.)
 */
const CODICE_TETTO_ORARIO = 'LOTTO_TETTO_ORARIO_RAGGIUNTO'

export const POST = withRoute('pagamenti/fattura/lotto:POST', async (request: Request) => {
  // Il gate PRIMA della lettura del corpo (lock `corpo-letto-dopo-il-gate`).
  const auth = await requireStaff(request)
  if (auth.response) return auth.response

  const b = await parseBody(request, bodySchema)
  if ('response' in b) return b.response
  const righe = b.data.pagamenti

  const supabase = await createAdminClient()

  // ─── ISOLAMENTO PER SEDE, RIGA PER RIGA ───────────────────────────────────────
  // Un lotto non è un lasciapassare per uscire dalla propria sede: il gate di ruolo non
  // basta, si opererebbe sulle rette di un altro plesso conoscendo un uuid. Basta UNA
  // riga fuori scope perché l'intera richiesta sia rifiutata — è malformata, non
  // parzialmente valida.
  for (const riga of righe) {
    const fuoriScope = await assertPagamentoInScope(supabase, auth.user, riga.pagamento_id)
    if (fuoriScope) return fuoriScope
  }

  // ─── LA GUARDIA SUL TETTO ORARIO ──────────────────────────────────────────────
  // Aruba concede 60 upload l'ora per IP, e ogni tentativo — anche rifiutato — riazzera
  // il TTL del secchio. Meglio un no leggibile adesso che un `429` che azzera la finestra
  // per tutti, compreso chi sta fatturando a mano dal pannello.
  const emesseUltimaOra = await contaEmesseUltimaOra(supabase)
  const disponibili = posizioniDisponibili(emesseUltimaOra)
  const quante = quanteSePossonoTentare(righe.length, disponibili)
  if (quante === 0) {
    return NextResponse.json(
      {
        error:
          `Aruba concede ${SOGLIA_ORARIA_APP} fatture all’ora e per quest’ora sono esaurite. ` +
          'Nessuna fattura è stata emessa e nessun numero è stato consumato: riprova fra un’ora.',
        codice: CODICE_TETTO_ORARIO,
        // Solo il conteggio, mai da quale sede vengano: un operatore di Giugliano non
        // deve leggere i volumi di Aversa da un messaggio d'errore.
        data: { disponibili: 0 },
      },
      { status: 429 },
    )
  }
  const daTentare = righe.slice(0, quante)
  const oltreQuota: string[] = righe.slice(quante).map((r) => r.pagamento_id)

  // ─── IL CICLO ─────────────────────────────────────────────────────────────────
  // Vive in `eseguiBloccoFatture` dal 2026-09-23: lo stesso ciclo lo usa il lavoratore
  // della coda, e due copie sarebbero due occasioni di perdere una delle guardie che lo
  // rendono sicuro (sessione unica, ritentativo spento, budget sul costo peggiore, stop su
  // 0/429/5xx). Qui il comportamento è quello di prima: stesso attore per ogni riga, e
  // il promemoria sulla scheda acceso per tutte (le cinque condizioni restano là dentro).
  const blocco = await eseguiBloccoFatture(
    supabase,
    daTentare.map((riga) => ({
      pagamento_id: riga.pagamento_id,
      causale: riga.causale,
      intestatario: riga.intestatario,
      attoreId: auth.user.id,
      attoreAudit: auth.user,
      ricordaSullaScheda: true,
    })),
    { operazione: 'pagamenti/fattura/lotto:POST' },
  )
  const { emesse, gia_emesse: giaEmesse, fallite, fermato, ms } = blocco
  // Prima le righe del blocco non tentate, poi quelle oltre la quota: lo stesso ordine di
  // quando il ciclo le rimetteva in testa con `unshift`.
  const restanti: string[] = [...blocco.restanti, ...oltreQuota]

  // ⚠️ `distingui` non è un vezzo: `app_log` deduplica per `(fingerprint, giorno)` e
  // somma le occorrenze SENZA aggiornare il contesto. Senza, quattro blocchi in un
  // pomeriggio diventerebbero UNA riga coi contatori del primo, e la verifica «da sette
  // pagine a due, da un accesso per fattura a uno per blocco» misurerebbe il primo
  // blocco della giornata credendo di misurare tutto.
  logEvento(
    'fattura',
    fallite.length > 0 ? 'warn' : 'info',
    {
      operazione: 'pagamenti/fattura/lotto:POST',
      esito: 'lotto-blocco-concluso',
      emesse: emesse.length,
      gia_emesse: giaEmesse.length,
      fallite: fallite.length,
      restanti: restanti.length,
      fermato,
      ms,
    },
    undefined,
    { distingui: ['emesse', 'fallite', 'restanti', 'fermato'] },
  )

  return NextResponse.json({
    success: true,
    data: { emesse, gia_emesse: giaEmesse, fallite, restanti, fermato },
  })
})
