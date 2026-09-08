import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { creaSessioneAruba, emettiFatturaPagamento } from '@/lib/aruba/emissione'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { zAdultScelto } from '@/lib/fatturazione/intestatario-scelto'
import { ricordaIntestatarioSullaScheda } from '@/lib/pagamenti/intestatari'
import { logScrittura } from '@/lib/audit/scrittura'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import {
  BUDGET_BLOCCO_MS,
  PAUSA_FRA_UPLOAD_MS,
  RISERVA_PEGGIORE_MS,
  TETTO_BLOCCO,
  fermaIlLotto,
} from '@/lib/pagamenti/lotto-fatture'
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
 * I rifiuti che nascono qui, coi loro codici.
 *
 * Costanti LOCALI e letterali: il lock `errori-con-codice` risolve `codice: X` solo se
 * `X` è una stringa nel corpo oppure un `const X = '…'` di QUESTO file. Un valore che il
 * lock non sa leggere è un valore che nessuno controlla.
 */
const CODICE_TETTO_ORARIO = 'LOTTO_TETTO_ORARIO_RAGGIUNTO'
/** Copiato dalla route singola: è un pezzo di contratto che viaggia nel JSON. */
const CODICE_TRASPORTO_IGNOTO = 'FATTURA_TRASPORTO_IGNOTO'

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** L'esito di una riga del blocco, come lo legge il pannello. */
interface RigaEsito {
  pagamento_id: string
  numero?: number
  numeroFattura?: string
  messaggio?: string
  codice?: string
  /** Lo status che la route singola avrebbe restituito: il pannello ci ragiona sopra. */
  statoHttp?: number
}

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
  const restanti: string[] = righe.slice(quante).map((r) => r.pagamento_id)

  // ─── IL CICLO ─────────────────────────────────────────────────────────────────
  // La sessione è ciò per cui esiste questa route: un accesso per blocco invece che uno
  // per fattura. La prima emissione lo apre — `ensureToken()` sta prima della RPC — e le
  // altre lo riusano.
  const sessione = creaSessioneAruba()
  const inizio = Date.now()
  const emesse: RigaEsito[] = []
  const giaEmesse: RigaEsito[] = []
  const fallite: RigaEsito[] = []
  let fermato: 'budget' | 'errore' | null = null

  for (let i = 0; i < daTentare.length; i++) {
    const riga = daTentare[i]

    // Il budget si guarda PRIMA di ogni fattura, e riserva il costo peggiore di una
    // sola: quel che resta deve bastare anche alla fattura più sfortunata.
    if (Date.now() - inizio + RISERVA_PEGGIORE_MS > BUDGET_BLOCCO_MS) {
      fermato = 'budget'
      restanti.unshift(...daTentare.slice(i).map((r) => r.pagamento_id))
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
          operazione: 'pagamenti/fattura/lotto:POST',
          esito: scriviCausale === null ? 'causale-manuale-non-rimossa' : 'causale-manuale-non-salvata',
          pagamento_id: riga.pagamento_id,
        }, errCausale)
      }
    }

    const esito = await emettiFatturaPagamento(
      supabase,
      riga.pagamento_id,
      { id: auth.user.id },
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

      // ─── RICORDA CHI HA PAGATO ───────────────────────────────────────────────
      // La fattura è uscita intestata al genitore riconosciuto dall'ordinante del
      // bonifico: lo si scrive sulla scheda del bambino, così il mese prossimo la
      // cascata risponde da sola senza dedurre niente.
      //
      // 🔴 QUESTA SCRITTURA NON DECIDE SOLO LE FATTURE. `alunni.intestatario_fatture`
      // è il «CF pagatore» della comunicazione all'Agenzia delle Entrate
      // (`api/pagamenti/export`) e l'intestatario dell'attestazione per il 730
      // (`api/pagamenti/attestazione`): prima della scrittura quel bambino stava fra
      // le «Escluse» per «codice fiscale del pagatore mancante», dopo la sua spesa
      // viene comunicata a nome di quell'adulto. Decide una DETRAZIONE, non una PDF.
      //
      // Le CINQUE condizioni sono tutte necessarie e nessuna è prudenza:
      //  · `!esito.gia` — una riga ripescata dal registro non dice niente su OGGI, e
      //    la sua fattura può essere stata intestata da tutt'altro;
      //  · `intestatario?.tipo === 'adult'` — se il corpo non porta un intestatario ha
      //    deciso la cascata, cioè l'anagrafica sapeva già rispondere;
      //  · `esito.alunnoId` — `null` su un pagamento non legato a nessun bambino (una
      //    vendita di merchandise), e lì non c'è nessuna scheda;
      //  · `esito.cascataVuota` — NESSUNA fonte aveva saputo dire a chi intestare. Se
      //    una l'aveva detto ed era solo incompleta (uno split di genitori separati,
      //    il default di famiglia, una scelta di Segreteria), la fonte forte esiste
      //    già e una deduzione da un estratto conto non se ne appropria. È anche ciò
      //    che tiene fuori i genitori separati con una quota sola, che `ripartito`
      //    — definito come `quote.length > 1` — non vede;
      //  · `categoriaSlug === 'retta'` — chi salda una mensa, un grembiule o del
      //    materiale non deve diventare il pagatore fiscale permanente di quel
      //    bambino. Misurato il 2026-09-08: 91 righe candidate non sono rette, e per
      //    26 bambini l'UNICO candidato non lo è.
      // La sesta — «la scheda dev'essere vuota» — sta dentro la `WHERE` della UPDATE.
      //
      // ⚠️ L'ALUNNO E LA CASCATA VENGONO DALL'ESITO, non da una seconda lettura: è la
      // stessa riga che ha appena prodotto il documento, e ha già passato il gate di
      // sede. Una lettura a parte sarebbe una seconda fonte di verità su «di chi è
      // questo pagamento», e per giunta senza quel gate.
      //
      // ⚠️ FAIL-OPEN, e va detto per intero: qui la fattura è GIÀ partita verso lo SdI
      // e non si disfa. Un promemoria non salvato è un fastidio; un'eccezione in
      // questo punto uscirebbe dal ciclo e da `withRoute` come 500, il pannello
      // leggerebbe `stato = 0`, e `numeroInDubbio(0)` fermerebbe il lotto dicendo «il
      // numero potrebbe essere stato consumato» su fatture che erano uscite bene —
      // perdendo per strada l'elenco delle emesse, già costruito e mai restituito.
      // Per questo la chiamata sta dentro un `try`, e per questo si logga anche il
      // SUCCESSO (AGENTS.md, regola 5).
      if (
        !esito.gia &&
        riga.intestatario?.tipo === 'adult' &&
        esito.alunnoId &&
        esito.cascataVuota &&
        esito.categoriaSlug === 'retta'
      ) {
        const alunnoId = esito.alunnoId
        const adultId = riga.intestatario.adult_id
        try {
          const { esito: ricordato, error: erroreRicorda } = await ricordaIntestatarioSullaScheda(
            supabase,
            alunnoId,
            adultId,
          )
          // ⚠️ `distingui: ['alunno_id']` NON è un vezzo: `app_log` deduplica per
          // `(fingerprint, giorno)` e l'`ON CONFLICT` somma le occorrenze SENZA
          // aggiornare il contesto. Senza, dodici schede scritte in un pomeriggio
          // diventano UNA riga che nomina il primo bambino e mente sugli altri
          // undici — e questa è l'unica ricostruibilità di una scrittura decisa da
          // un'euristica su dati di minori. Il volume è già limitato dal tetto
          // orario di Aruba, quindi il costo della distinzione è dichiarabile.
          logEvento(
            'fattura',
            ricordato === 'non_salvato' ? 'warn' : 'info',
            {
              operazione: 'pagamenti/fattura/lotto:POST',
              esito: `intestatario-${ricordato.replace(/_/g, '-')}`,
              pagamento_id: riga.pagamento_id,
              alunno_id: alunnoId,
            },
            erroreRicorda ?? undefined,
            { distingui: ['alunno_id'] },
          )
          // Il registro immodificabile delle scritture su `alunni` (DL-037): la
          // stessa colonna, quando la cambia una persona dalla scheda, ne lascia
          // una. Senza, alla domanda «chi ha deciso che la detrazione di questo
          // bambino va a questo genitore, e quando?» non risponde nessuno.
          if (ricordato === 'salvato') {
            await logScrittura(supabase, {
              attore: auth.user,
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
              operazione: 'pagamenti/fattura/lotto:POST',
              esito: 'intestatario-non-ricordato',
              pagamento_id: riga.pagamento_id,
              alunno_id: alunnoId,
            },
            err,
            { distingui: ['alunno_id'] },
          )
        }
      }
      continue
    }

    const trasporto = esito.motivo === 'errore' && esito.httpStatus === 502
    fallite.push({
      pagamento_id: riga.pagamento_id,
      messaggio: esito.messaggio,
      statoHttp: esito.httpStatus,
      ...(trasporto ? { codice: CODICE_TRASPORTO_IGNOTO } : {}),
    })

    // `fermaIlLotto` è lo stesso verdetto che usava il browser, e resta lì: 0, 429 e
    // ogni 5xx dicono che il problema non è della riga ma del canale, e insistere
    // sulle successive è il modo di peggiorarlo.
    if (fermaIlLotto(esito.httpStatus)) {
      fermato = 'errore'
      restanti.unshift(...daTentare.slice(i + 1).map((r) => r.pagamento_id))
      break
    }
  }

  const ms = Date.now() - inizio
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
