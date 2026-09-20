import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { residuoEffettivo, type AgingPagamento } from '@/lib/pagamenti/aging'
import {
  riconosciOrdinante,
  type CandidatoGenitore,
  type MotivoAbbinamentoOrdinante,
} from '@/lib/pagamenti/ordinante-genitore'
import { scegliPaganteComune } from '@/lib/pagamenti/pagante-comune'
import { pagantiAmmessiPerAlunni } from '@/lib/pagamenti/pagante-ammesso'
import { getFigliDiGenitoreEsito } from '@/lib/anagrafiche/legami'
import { eAncoraIscritto } from '@/lib/alunni/stato'

/**
 * ─── IL CONTESTO DI «COMPONI IL PAGAMENTO» ───────────────────────────────────
 *
 * Un bonifico di famiglia non paga quasi mai una voce sola: paga la retta, il
 * pomeridiano e la ricarica dei ticket, magari per due fratelli di plessi
 * diversi. Questa rotta è l'unico fornitore del pannello che fa quella
 * ripartizione. **Non scrive niente**: risponde a cinque domande e basta —
 * di chi è questo bonifico, quali figli ha quella famiglia, cosa hanno di
 * aperto, quali categorie esistono, quanto costa un ticket in quella sede.
 *
 * ─── COSA RIUSA, E PERCHÉ NON LO RISCRIVE ───────────────────────────────────
 *  · `riconosciOrdinante` (`@/lib/pagamenti/ordinante-genitore`) — CHI ha fatto
 *    il bonifico, per uguaglianza e mai per somiglianza. Una seconda regola qui
 *    dentro vorrebbe dire due verdetti diversi sullo stesso nome, e a valle c'è
 *    una fattura intestata a una persona vera.
 *  · `scegliPaganteComune` (`@/lib/pagamenti/pagante-comune`) — il genitore
 *    legato a TUTTI i bambini che il bonifico nomina, con l'intestatario di
 *    default a rompere la parità. È il ripiego quando la banca non ha scritto
 *    un nome leggibile, ed è già la funzione dell'«Incasso unico».
 *  · `residuoEffettivo` (`@/lib/pagamenti/aging`) — importo − sconto − incassato,
 *    **clampato a 0**. Non si rifà a mano: un sovraincasso con residuo negativo
 *    diventerebbe un credito che compensa in silenzio la voce di un altro figlio.
 *  · i legami genitore↔figlio dalle DUE sorgenti vive: `student_parents`
 *    (anagrafica) e `legame_genitori_alunni` (runtime, via `@/lib/anagrafiche/legami`).
 *    Con la sola anagrafica i tutori di un bambino arrivato dal modulo pubblico
 *    «non risultavano» — difetto già pagato una volta.
 *  · `pagantiAmmessiPerAlunni` (`@/lib/pagamenti/pagante-ammesso`) — l'unione di
 *    quelle due sorgenti, e da qui viene l'elenco dei candidati. **Fino al
 *    2026-09-13 quella regola stava scritta due volte**: qui, e nel modulo che la
 *    SCRITTURA (`…/componi:POST`) usa per rifiutare un pagante estraneo. Erano
 *    equivalenti — misurato su 2000 scenari, coppie identiche — ed è proprio per
 *    questo che sono state unite: due copie non divergono il giorno in cui
 *    nascono, divergono dopo, e quel giorno questa schermata offrirebbe un
 *    pagante che la scrittura rifiuta.
 *
 * La risposta è modellata su ciò che il motore `conciliazione-composita.ts` sa
 * già leggere: ogni voce esce nella forma di `VoceApertaDb`, così il pannello
 * chiama `rigaDaVoceAperta(voce)` senza nessun adattatore per strada. Un
 * adattatore nel browser è una seconda definizione di «residuo».
 *
 * ─── 🔴 I NOMI DEI MINORI ────────────────────────────────────────────────────
 * Stesso criterio del GET della lista (`../../route.ts`): il NOME è
 * arricchimento identificante e si mostra **solo per le sedi attive
 * dell'operatore**. Per un figlio di un altro plesso esce `nome: null` e il
 * nome del PLESSO (dalla busta `sedi`), mai il nome del bambino — e la riga
 * resta, perché due fratelli in due sedi sono il caso per cui questa
 * funzionalità esiste.
 *
 * I nomi delle sedi stanno nella BUSTA e non su ogni riga, come nella lista:
 * sono tre più le due di prova, e ripeterli su ogni figlio sarebbe la stessa
 * stringa moltiplicata per niente.
 *
 * ─── E IL NOME DI UN ADULTO? ESCE IN CHIARO, ED È UNA DECISIONE ──────────────
 * La minimizzazione qui sopra copre i MINORI, e solo quelli: va detto, perché
 * fino al 2026-09-13 questo blocco lasciava credere che coprisse tutto.
 * `pagante.candidati[].nome` esce in chiaro **anche quando tutti i figli di quel
 * genitore stanno in plessi che l'operatore non gestisce**. Le due ragioni:
 *  · serve alla decisione: il pagante si sceglie per NOME (`?pagante=` accetta
 *    solo i candidati di questa risposta). Un elenco di uuid non è una scelta, e
 *    un selettore vuoto manderebbe l'operatrice a indovinare su un documento che
 *    a valle porta un codice fiscale;
 *  · **lo stesso nome è già due righe sopra**, in `movimento.controparte`: è ciò
 *    che la banca ha scritto, esce per progetto (non si corregge, non si
 *    rimaneggia) e nel caso comune il pagante È l'ordinante. Nasconderlo nei
 *    candidati lasciandolo nella controparte sarebbe una protezione già vuota
 *    alla riga precedente — cioè la forma peggiore, perché sembra esserci.
 * La differenza con un minore non è di grado: un bambino non si sceglie da una
 * tendina, e il suo nome non serve a NESSUNA decisione di questa schermata.
 * Il comportamento è FISSATO da un test («il nome di un ADULTO attraversa il
 * perimetro, ed è dichiarato»), così il giorno in cui si deciderà di stringere
 * — `nome: null` sui candidati senza un figlio in sede — si vedrà esattamente
 * cosa si sta cambiando, invece di scoprirlo da un pannello che non nomina più
 * nessuno.
 *
 * ─── PERCHÉ `?pagante=` NON ACCETTA UN UUID QUALUNQUE ───────────────────────
 * La proposta si deve poter cambiare (lo chiede l'operatrice: la banca scrive
 * un nome, non un'anagrafe). Ma si cambia SCEGLIENDO fra i candidati che questa
 * stessa risposta elenca — i genitori dei bambini che il bonifico nomina.
 * Accettare un `parents.id` arbitrario farebbe di questa rotta un modo per
 * sfogliare le famiglie dell'intero archivio, voci aperte e importi compresi,
 * conoscendo un solo uuid. Fuori dai candidati è un 403, non un elenco vuoto.
 *
 * ─── PERCHÉ `?alunni=` VERIFICA LA SEDE PRIMA DI OGNI ALTRA COSA ────────────
 * Su un movimento ROSSO il matcher non ha suggerito niente: nessun pagamento
 * citato, quindi nessun bambino, quindi nessun genitore candidato, tendina dei
 * figli vuota e «Conferma» spento. **È il motivo per cui sui rossi non si
 * riesce a comporre**, e non c'entra il riconoscimento dell'ordinante: anche
 * riconoscendolo alla perfezione non avrebbe su cosa decidere. `?alunni=` è il
 * modo in cui l'operatrice dice DI CHI è quel bonifico; da lì in poi il resto
 * della rotta funziona già così com'è — candidati, ordinante, figli, voci
 * aperte, categorie, pacchetti.
 *
 * Ma un uuid arbitrario in query, senza verifica, farebbe di questa rotta
 * esattamente ciò che il paragrafo qui sopra nega a `?pagante=`: un modo per
 * sfogliare l'archivio — voci aperte, residui e nomi dei genitori di una
 * famiglia qualunque — conoscendo un solo id. Si accettano quindi solo i
 * bambini delle SEDI ATTIVE dell'operatore, e la verifica **sta nella query**
 * (`.in('scuola_id', …)`), PRIMA che quegli id diventino una chiave di lettura:
 * un perimetro controllato dopo aver letto è un perimetro che ha già risposto.
 *
 * E si risponde **404, non 403** — stessa grammatica del gate sul movimento in
 * `…/componi` (`CONCILIAZIONE_MOVIMENTO_NON_TROVATO`). Un 403 direbbe a chi
 * lavora a Cesa che quel bambino esiste a Giugliano, cioè regalerebbe metà
 * dell'informazione che il gate esiste per non dare. Nel log vanno solo
 * CONTEGGI — quanti chiesti, quanti dentro il perimetro — mai gli uuid, mai i nomi.
 *
 * ─── DEGRADO ────────────────────────────────────────────────────────────────
 * PostgREST **non lancia**: ritorna `{ error }`, e qui si guarda sempre. Le tre
 * letture SENZA le quali la risposta sarebbe una bugia (movimento, alunni,
 * voci) fermano con un 500 e il loro codice; le altre — ticket, categorie,
 * pacchetti, nomi di sede, candidati — degradano a vuoto e lasciano un `warn`:
 * meglio un pannello che sa di non sapere che un pannello sicuro di sé.
 * Sul DB E2E della CI, non migrato, `sconto` non esiste: `42703` sulla SELECT
 * si ritenta senza quella colonna (`residuoEffettivo` la tratta come 0).
 */

/** `pagamenti` con le colonne di Contabilità v2 (`sconto`) e quelle del residuo. */
const SEL_VOCI =
  'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, sconto, scadenza, stato, tipo, categoria_id, periodo_competenza'
/** La stessa SELECT senza `sconto`, per il DB E2E della CI (42703). */
const SEL_VOCI_BASE =
  'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, scadenza, stato, tipo, categoria_id, periodo_competenza'

/** Le colonne di `parents` che servono: il nome da mostrare e le due chiavi d'identità. */
const SEL_PARENTS = 'id, first_name, last_name, auth_user_id, intestatario_default'

const OPERAZIONE = 'pagamenti/riconciliazione/[id]/contesto:GET'

/**
 * Quanti bambini può nominare una richiesta con `?alunni=`.
 *
 * Il numero NON viene da una misura, e si dice invece di lasciarlo credere: è la
 * soglia oltre la quale «i figli di questa famiglia» smette di essere una
 * descrizione plausibile di ciò che si sta chiedendo, e la richiesta somiglia a
 * un'enumerazione. Tenerlo basso non protegge niente da solo — a proteggere è la
 * verifica di sede qui sotto — ma tiene corta la lista di un `.in(…)` che arriva
 * dal client.
 */
const MAX_ALUNNI_CHIESTI = 5

/**
 * `?alunni=uuid,uuid` — i bambini che l'operatrice indica a mano su un movimento
 * che il matcher non ha saputo abbinare.
 *
 * Il tetto si applica a ciò che è ARRIVATO, non a ciò che resta dopo aver tolto
 * i doppioni: sei uuid ripetuti sono comunque sei uuid chiesti, e un tetto che
 * si lasciasse aggirare ripetendo un valore non sarebbe un tetto.
 */
const zAlunniChiesti = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter((v) => v !== ''))
  .pipe(
    z.array(zUuid).max(MAX_ALUNNI_CHIESTI, `al massimo ${MAX_ALUNNI_CHIESTI} bambini per richiesta`),
  )

/**
 * ⚠️ NIENTE `.strict()`. La pagina di Contabilità appende `?userId=` a ogni GET:
 * con lo schema chiuso ogni richiesta sarebbe un 400. È la stessa ragione, e la
 * stessa nota, del GET della lista.
 */
const getQuerySchema = z.object({ pagante: zUuid.optional(), alunni: zAlunniChiesti.optional() })

/** Perché quel pagante è proposto. `scelto` = l'ha indicato l'operatrice. */
type MotivoPagante = MotivoAbbinamentoOrdinante | 'pagante_comune' | 'scelto'

interface MovimentoRiga {
  id: string
  scuola_id: string | null
  importo: number | string
  data_operazione: string
  causale: string | null
  controparte: string | null
  stato: string
  pagamento_id: string | null
  suggerimenti: { pagamento_id?: string | null }[] | null
}

interface VoceRiga extends AgingPagamento {
  id: string
  alunno_id?: string | null
  scuola_id?: string | null
  descrizione?: string | null
  categoria_id?: string | null
  [k: string]: unknown
}

interface ParentRiga {
  id: string
  first_name?: string | null
  last_name?: string | null
  auth_user_id?: string | null
  intestatario_default?: boolean | null
}

/** Il codice PostgREST di un errore, per il log. Mai il `message`: è prosa del DB. */
function codiceErroreDi(e: unknown): { error_code: string } {
  const err = e as { code?: unknown } | null
  const c = typeof err?.code === 'string' && err.code.trim() !== '' ? err.code.trim() : 'sconosciuto'
  return { error_code: c }
}

/** Risposta d'errore col suo codice di catalogo: mai prosa italiana nuda. */
function guasto(evento: string, err: unknown): NextResponse {
  logErrore({ operazione: OPERAZIONE, stato: 500, evento, ...codiceErroreDi(err) }, err)
  return NextResponse.json(
    {
      error: 'Non è stato possibile leggere il contesto di questo bonifico',
      codice: 'CONCILIAZIONE_CONTESTO_NON_LETTO',
    },
    { status: 500 },
  )
}

/**
 * Il rifiuto di un bambino chiesto in query, in un posto solo — perché i due
 * modi di non passare (fuori perimetro, oppure nessun perimetro) devono uscire
 * IDENTICI: due risposte diverse sarebbero esse stesse l'informazione.
 *
 * 404 e non 403: confermare l'esistenza direbbe a chi lavora in un plesso che
 * quel bambino c'è in un altro. Stessa grammatica — e stesso verso — del gate
 * sul movimento in `…/componi`.
 *
 * Il log porta SOLO conteggi: gli uuid chiesti sono di bambini che potrebbero
 * non essere di questo operatore, e scriverli qui li trasferirebbe in `app_log`,
 * dove restano 30 giorni e si interrogano in SQL.
 */
function alunnoNonTrovato(chiesti: number, dentro: number, sedi: number): NextResponse {
  logEvento('pagamento', 'info', {
    operazione: OPERAZIONE,
    esito: 'alunno-chiesto-fuori-perimetro',
    chiesti,
    dentro,
    sedi,
  })
  return NextResponse.json(
    { error: 'Bambino non trovato', codice: 'CONCILIAZIONE_ALUNNO_NON_TROVATO' },
    { status: 404 },
  )
}

const testo = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const nomeIntero = (p: ParentRiga): string => [p.first_name, p.last_name].filter(Boolean).join(' ').trim()

export const GET = withRoute(
  'pagamenti/riconciliazione/[id]/contesto:GET',
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    try {
      // ── 1 · IL GATE, PRIMA DI TUTTO (lock `corpo-letto-dopo-il-gate`) ──────
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      // ── 2 · zod su ciò che arriva dal client: il segmento e la query ───────
      const { id: rawId } = await context.params
      const idParsed = parseData(zUuid, rawId)
      if ('response' in idParsed) return idParsed.response
      const id = idParsed.data

      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response
      const paganteChiesto = q.data.pagante ?? null
      /** Gli uuid ARRIVATI, ancora senza titolo: diventano una chiave solo dopo il §3-bis. */
      const alunniChiesti = [...new Set(q.data.alunni ?? [])]

      const supabase = await createAdminClient()

      // ── 3 · Il movimento ──────────────────────────────────────────────────
      const mov = await supabase
        .from('riconciliazione_movimenti')
        .select('id, scuola_id, importo, data_operazione, causale, controparte, stato, pagamento_id, suggerimenti')
        .eq('id', id)
        .maybeSingle()
      if (mov.error) return guasto('movimento-non-letto', mov.error)
      if (!mov.data) {
        return NextResponse.json(
          { error: 'Bonifico non trovato', codice: 'CONCILIAZIONE_MOVIMENTO_NON_TROVATO' },
          { status: 404 },
        )
      }
      const movimento = mov.data as unknown as MovimentoRiga

      // Le sedi su cui questo operatore può leggere i NOMI dei minori. Il
      // registro bancario resta globale (l'estratto conto è uno solo): a essere
      // per sede è l'arricchimento identificante, non la riga.
      const sediAttive = new Set(await resolveScuoleAttive(request as NextRequest, supabase, auth.user))

      // ── 3-bis · I BAMBINI INDICATI A MANO, E LA SEDE PRIMA DI USARLI ──────
      // ⚠️ IL FILTRO DI SEDE STA NELLA QUERY, ed è l'unico punto di questa rotta
      // in cui ci sta: qui gli id arrivano dal CLIENT, e finché non sono
      // verificati non sono una chiave di lettura ma una domanda. Ovunque altro
      // i figli si leggono per id senza filtro di sede — è la decisione n. 10, un
      // bonifico di famiglia attraversa i plessi — e quegli id li ha prodotti il
      // server. La differenza è tutta qui, e per questo il controllo è qui.
      let alunniIndicati: string[] = []
      if (alunniChiesti.length > 0) {
        const sedi = [...sediAttive]
        // Lo scope vuoto ha qui il suo ramo esplicito, e NEGA. Senza nessuna sede
        // attiva non esiste un perimetro entro cui verificare, e `.in('scuola_id',
        // [])` non sarebbe una condizione: è il modo in cui un filtro smette di
        // restringere proprio dove serve di più. Si risponde di no prima della
        // query — non si manda al database una domanda di cui si conosce già la
        // risposta — così il filtro di sede, sotto, resta INCONDIZIONATO: è la
        // forma che il lock `scope-vuoto-nega` impone, e non ha allowlist.
        if (sedi.length === 0) return alunnoNonTrovato(alunniChiesti.length, 0, 0)

        const ver = await supabase.from('alunni').select('id').in('id', alunniChiesti).in('scuola_id', sedi)
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // uscirebbe come «quel bambino non esiste», cioè un 404 che manda a
        // cercare un errore di digitazione dove c'è un database che non risponde.
        if (ver.error) return guasto('alunni-chiesti-non-verificati', ver.error)
        const dentro = [
          ...new Set(
            ((ver.data ?? []) as { id?: string | null }[])
              .map((r) => r.id)
              .filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
          ),
        ]
        // Tutti o nessuno: una risposta parziale direbbe comunque, per differenza,
        // quali dei due erano fuori.
        if (dentro.length !== alunniChiesti.length) {
          return alunnoNonTrovato(alunniChiesti.length, dentro.length, sedi.length)
        }
        alunniIndicati = dentro
      }

      // ── 4 · I bambini che questo bonifico NOMINA ──────────────────────────
      // Sono quelli dei pagamenti citati: i suggerimenti, più il pagamento già
      // abbinato (che `annulla_transazione_contabile` lascia sul movimento
      // riaperto, ed è la memoria di ciò a cui era legato).
      const pagCitati = [
        ...(movimento.suggerimenti ?? []).map((s) => s?.pagamento_id),
        movimento.pagamento_id,
      ].filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      const pagIds = [...new Set(pagCitati)]

      let alunniDaiPagamenti: string[] = []
      if (pagIds.length > 0) {
        const citati = await supabase.from('pagamenti').select('id, alunno_id').in('id', pagIds)
        if (citati.error) {
          // Fail-open sull'AIUTO: senza questi id non si propone un pagante, ma
          // il pannello si apre lo stesso (l'operatrice sceglierà). Mai in
          // silenzio, però: «nessuna proposta» e «non ho potuto guardare» sono
          // due cose diverse e senza questa riga sarebbero la stessa.
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE,
            esito: 'pagamenti-citati-non-letti',
            n: pagIds.length,
            ...codiceErroreDi(citati.error),
          }, citati.error)
        }
        alunniDaiPagamenti = [
          ...new Set(
            ((citati.data ?? []) as { alunno_id?: string | null }[])
              .map((p) => p.alunno_id)
              .filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
          ),
        ]
      }

      // ⚠️ I BAMBINI INDICATI A MANO SI SOMMANO QUI, prima del §5: da questa riga
      // in giù «i bambini che il bonifico nomina» comprende anche quelli che
      // l'operatrice ha nominato, e tutto ciò che segue — candidati, pagante,
      // figli, voci — è già scritto per lavorarci. Su un movimento rosso questa
      // somma è l'UNICA sorgente: i suggerimenti sono zero per definizione.
      const alunniCitati = [...new Set([...alunniDaiPagamenti, ...alunniIndicati])]

      // ── 5 · I candidati: i genitori di QUEI bambini, dalle due sorgenti ────
      // L'insieme resta piccolissimo per la stessa ragione di
      // `ordinante-genitore.ts`: un omonimo, qui, non sbaglia una classe —
      // intesta una fattura a un estraneo, col suo codice fiscale.
      //
      // ⚠️ LA REGOLA NON È SCRITTA QUI, ed è la correzione del 2026-09-13. Le due
      // porte che decidono chi può essere pagante — questa, che lo MOSTRA, e
      // `…/componi:POST`, che lo SCRIVE — ne tenevano una copia per una. Adesso
      // passano tutt'e due da `pagantiAmmessiPerAlunni`: chi cambia la regola le
      // cambia insieme, che è l'unico modo in cui non possono più divergere.
      // I candidati sono i genitori LEGATI, non tutte le righe che una query ha
      // riportato: un `parents` senza legame con questi bambini non è un candidato,
      // e infatti `parentIds` è la derivata delle COPPIE, non una seconda query.
      const ammessi = await pagantiAmmessiPerAlunni(supabase, alunniCitati, OPERAZIONE)
      const legami = ammessi.legami
      const relazioni = ammessi.relazioni
      const parentIds = [...ammessi.parentIds]
      /**
       * Il `completo` del modulo, che questa rotta può solo PEGGIORARE con la sua
       * terza lettura (i nomi, qui sotto). Non ci si rifiuta niente: esce nella
       * riga di battito, e serve a distinguere «di questi bambini non si conosce
       * nessun genitore» da «non li abbiamo potuti leggere».
       *
       * ⚠️ UNA DIFFERENZA MISURATA, e dichiarata invece di essere nascosta: la
       * copia che stava qui abbassava questo flag anche sui codici «schema
       * assente» (42P01 · 42703 · PGRST204 · PGRST205), il modulo no — per la
       * ragione scritta lì, cioè che sul DB E2E della CI, mai migrato, quei
       * codici sono l'ambiente e non un guasto. Su 2000 scenari generati è
       * l'UNICA divergenza fra le due copie (coppie, id e relazioni: identici), e
       * tocca soltanto ciò che si legge nel log.
       */
      let candidatiCompleti = ammessi.completo
      const anagrafiche = new Map<string, ParentRiga>()
      const intestatariDefault = new Set<string>()
      if (parentIds.length > 0) {
        const reg = await supabase.from('parents').select(SEL_PARENTS).in('id', parentIds)
        if (reg.error) {
          candidatiCompleti = false
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE,
            esito: 'anagrafica-candidati-non-letta',
            n: parentIds.length,
            ...codiceErroreDi(reg.error),
          }, reg.error)
        }
        for (const p of (reg.data ?? []) as ParentRiga[]) {
          if (!p.id || !parentIds.includes(p.id)) continue
          anagrafiche.set(p.id, p)
          if (p.intestatario_default === true) intestatariDefault.add(p.id)
        }
      }

      const candidati = parentIds.map((pid) => ({
        parent_id: pid,
        nome: nomeIntero(anagrafiche.get(pid) ?? { id: pid }),
        relazione: relazioni.get(pid) ?? null,
      }))

      // ── 6 · Il pagante: scelto, riconosciuto, o comune. Mai «il primo» ─────
      let proposto: { parent_id: string; motivo: MotivoPagante } | null = null

      if (paganteChiesto) {
        if (!parentIds.includes(paganteChiesto)) {
          logEvento('pagamento', 'info', {
            operazione: OPERAZIONE,
            esito: 'pagante-fuori-dai-candidati',
            candidati: parentIds.length,
          })
          return NextResponse.json(
            {
              error: 'Il genitore indicato non è collegato ai bambini di questo bonifico',
              codice: 'CONCILIAZIONE_PAGANTE_NON_AMMESSO',
            },
            { status: 403 },
          )
        }
        proposto = { parent_id: paganteChiesto, motivo: 'scelto' }
      } else {
        // ⚠️ PRIMA IL NOME SCRITTO DALLA BANCA, POI IL LEGAME. Sono due prove di
        // forza diversa: `riconosciOrdinante` dice che quel nome è QUEL genitore;
        // il pagante comune dice solo che quel genitore è l'unico che copra tutti
        // i bambini. Invertire l'ordine farebbe vincere l'indizio più debole.
        const perRiconoscimento: CandidatoGenitore[] = candidati.map((c) => ({
          adultId: c.parent_id,
          nome: c.nome,
        }))
        const esito = riconosciOrdinante(movimento.controparte, perRiconoscimento)
        if (esito.tipo === 'unico') {
          proposto = { parent_id: esito.adultId, motivo: esito.motivo }
        } else {
          // Il ripiego. `scegliPaganteComune` è anche il punto in cui
          // l'intestatario di default rompe la parità: non si introduce qui una
          // terza nozione di «chi è l'intestatario».
          const comune = scegliPaganteComune(legami, alunniCitati, intestatariDefault)
          if (comune) proposto = { parent_id: comune, motivo: 'pagante_comune' }
        }
      }

      // IL BATTITO (AGENTS.md, regola 5): senza questa riga non si può contare
      // quanto vale l'aiuto — quante proposte automatiche contro quante a mano —
      // se non leggendo i nomi, che qui non entrano. Solo uuid, conteggi e un
      // `esito` enumerato.
      logEvento('pagamento', 'info', {
        operazione: OPERAZIONE,
        esito: proposto ? `proposta-${proposto.motivo}` : 'proposta-assente',
        movimento_id: movimento.id,
        candidati: candidati.length,
        // ⚠️ DA `?alunni=` IN POI QUESTO CAMPO È UNA SOMMA: i bambini che il
        // bonifico NOMINA più quelli che l'operatrice ha INDICATO (§3-bis). Il
        // nome non è cambiato, quindi le due sorgenti si separano soltanto col
        // conteggio qui sotto: senza, una riga di ieri e una di oggi sarebbero
        // indistinguibili in `app_log` — cioè un criterio che smette di valere
        // senza dirlo, esattamente ciò che questa rotta si vieta più giù.
        alunni_citati: alunniCitati.length,
        // Il SUCCESSO del parametro nuovo, non solo il suo rifiuto: senza questo
        // zero, «nessuna riga» non distinguerebbe «nessuno usa `?alunni=`» da
        // «lo usano tutti e funziona sempre». Conteggio, mai gli uuid.
        alunni_indicati: alunniIndicati.length,
        completo: candidatiCompleti,
      })

      // ── 7 · I FIGLI: tutti quelli della famiglia, non solo quelli di sede ──
      // È la decisione n. 10, e ha un motivo operativo: un bonifico di famiglia
      // salda i fratelli insieme, e i fratelli stanno anche in plessi diversi.
      // Senza pagante non si sa di quale famiglia parlare: restano i bambini che
      // il bonifico nomina, così il pannello si apre con qualcosa invece che vuoto.
      let figliIds: string[] = alunniCitati
      if (proposto) {
        const ids = new Set<string>()
        const sp = await supabase.from('student_parents').select('student_id').eq('parent_id', proposto.parent_id)
        if (sp.error) {
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE,
            esito: 'figli-anagrafica-non-letti',
            ...codiceErroreDi(sp.error),
          }, sp.error)
        }
        for (const r of (sp.data ?? []) as { student_id?: string | null }[]) {
          if (r.student_id) ids.add(r.student_id)
        }
        // ...e il ponte runtime, per i genitori arrivati dal modulo pubblico.
        const account = anagrafiche.get(proposto.parent_id)?.auth_user_id
        if (account) {
          const { figli, completo } = await getFigliDiGenitoreEsito(supabase, account)
          if (!completo) {
            logEvento('pagamento', 'warn', { operazione: OPERAZIONE, esito: 'figli-runtime-incompleti' })
          }
          for (const f of figli) ids.add(f)
        }
        // I bambini che il bonifico nomina restano comunque: se l'anagrafica non
        // li collega a questo pagante, il difetto è nell'anagrafica — e toglierli
        // qui li farebbe sparire dalla schermata in cui si sarebbe visto.
        for (const a of alunniCitati) ids.add(a)
        figliIds = [...ids]
      }

      if (figliIds.length === 0) {
        return rispondi(movimento, candidati, proposto, [], {}, [], {})
      }

      // ── 8 · Gli alunni ────────────────────────────────────────────────────
      // ⚠️ NESSUN FILTRO SU `stato`, ED È DELIBERATO: un bonifico può saldare
      // l'arretrato di un bambino che ha lasciato, e nasconderlo qui vorrebbe
      // dire non poterlo incassare. Stessa scelta di `GET /api/pagamenti/famiglia`.
      //
      // Lo stato però ESCE, come `attivo`, perché la scrittura lo usa:
      // `POST …/componi` rifiuta una voce NUOVA su un bambino non più iscritto
      // (`CONCILIAZIONE_ALUNNO_NON_ATTIVO`) e lascia passare l'incasso di una
      // voce già a registro. Senza questo campo il pannello offrirebbe «aggiungi
      // una voce» proprio dove la conferma risponderà 422 — cioè manderebbe
      // l'operatrice contro un muro che sappiamo già dov'è. Il confine è
      // `eAncoraIscritto` e non una stringa riscritta qui: uno solo, non due.
      //
      // ⚠️ `stato` è fra le colonne che il DB E2E della CI può NON avere
      // (`COLONNE_VISIBILITA` in `@/lib/alunni/attivo` esiste per questo, e ha il
      // suo ciclo di ripiego). Qui il degrado è APERTO, come là: senza la colonna
      // il criterio non si applica e tutti risultano attivi. È il verso giusto in
      // cui sbagliare — chiudere vorrebbe dire rispondere «nessuno può ricevere
      // una voce nuova» perché uno schema è indietro — ma non si degrada in
      // silenzio, o sarebbe un criterio che smette di valere senza dirlo.
      let alunniRes = await supabase
        .from('alunni')
        .select('id, nome, cognome, scuola_id, stato')
        .in('id', figliIds)
      let statoLetto = true
      if (alunniRes.error && (alunniRes.error as { code?: string }).code === '42703') {
        statoLetto = false
        logEvento('db', 'info', {
          operazione: OPERAZIONE,
          esito: 'colonna-stato-assente',
          entita_tipo: 'alunni',
          error_code: '42703',
        })
        alunniRes = (await supabase
          .from('alunni')
          .select('id, nome, cognome, scuola_id')
          .in('id', figliIds)) as typeof alunniRes
      }
      if (alunniRes.error) return guasto('alunni-non-letti', alunniRes.error)
      const alunni = ((alunniRes.data ?? []) as {
        id: string; nome?: string | null; cognome?: string | null; scuola_id?: string | null; stato?: string | null
      }[]).filter((a) => typeof a.id === 'string')
      const alunniIds = alunni.map((a) => a.id)

      // ── 9 · Le voci aperte ────────────────────────────────────────────────
      let vociRes = await supabase.from('pagamenti').select(SEL_VOCI).in('alunno_id', alunniIds)
      if (vociRes.error && (vociRes.error as { code?: string }).code === '42703') {
        // DB E2E della CI, non migrato: `sconto` non esiste. Si rilegge senza —
        // `residuoEffettivo` tratta lo sconto assente come 0 — e lo si dichiara,
        // perché un degrado muto è un calcolo che cambia senza dirlo.
        logEvento('db', 'info', {
          operazione: OPERAZIONE,
          esito: 'colonna-sconto-assente',
          entita_tipo: 'pagamenti',
          error_code: '42703',
        })
        vociRes = (await supabase.from('pagamenti').select(SEL_VOCI_BASE).in('alunno_id', alunniIds)) as typeof vociRes
      }
      if (vociRes.error) return guasto('voci-non-lette', vociRes.error)

      const vociAperte = ((vociRes.data ?? []) as VoceRiga[])
        // I contenitori `padre` non si incassano: sono la somma delle rate figlie.
        .filter((v) => v.tipo !== 'padre')
        .map((v) => ({ ...v, residuo: residuoEffettivo(v) }))
        .filter((v) => v.residuo > 0)
        // Più vecchie prima: è l'ordine in cui il motore propone l'allocazione.
        .sort((a, b) => String(a.scadenza ?? '9999-12-31').localeCompare(String(b.scadenza ?? '9999-12-31')))

      // ── 10 · Lo SLUG della categoria di ogni voce ─────────────────────────
      // Serve al motore: `retta` è l'àncora che vince su tutto. Lettura a parte
      // da quella della tendina, e per una ragione: qui servono le categorie
      // CITATE (anche disattivate, anche di un altro plesso), là quelle
      // SCEGLIBILI. Un'unica query dovrebbe mentire a una delle due.
      const catIds = [...new Set(vociAperte.map((v) => testo(v.categoria_id)).filter((v): v is string => !!v))]
      const slugPerCategoria = new Map<string, string | null>()
      if (catIds.length > 0) {
        const cat = await supabase.from('payment_categories').select('id, slug').in('id', catIds)
        if (cat.error) {
          // Degrado: senza slug l'àncora ricade su «la voce più grande», che
          // `proponiAncora` sa già fare. Si perde la preferenza per la retta,
          // non la composizione.
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE,
            esito: 'slug-categorie-non-letti',
            n: catIds.length,
            ...codiceErroreDi(cat.error),
          }, cat.error)
        }
        for (const c of (cat.data ?? []) as { id?: string; slug?: string | null }[]) {
          if (c.id) slugPerCategoria.set(c.id, c.slug ?? null)
        }
      }

      // ── 11 · Il saldo ticket ──────────────────────────────────────────────
      // ⚠️ SI INNESTA SUGLI ALUNNI, non sulla tabella dei saldi. Misurato il
      // 2026-09-13: `ticket_mensa` ha 84 righe su 727 alunni — copre solo chi ha
      // ricaricato almeno una volta. Partendo di là, Cesa e Aversa vedrebbero una
      // schermata vuota indistinguibile da un guasto. Chi non ha la riga vale 0.
      const saldoTicket = new Map<string, number>()
      if (alunniIds.length > 0) {
        const tk = await supabase.from('ticket_mensa').select('alunno_id, saldo_ticket').in('alunno_id', alunniIds)
        if (tk.error) {
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE,
            esito: 'saldo-ticket-non-letto',
            n: alunniIds.length,
            ...codiceErroreDi(tk.error),
          }, tk.error)
        }
        for (const t of (tk.data ?? []) as { alunno_id?: string; saldo_ticket?: number | null }[]) {
          if (t.alunno_id) saldoTicket.set(t.alunno_id, Number(t.saldo_ticket ?? 0))
        }
      }

      // ── 12 · Le sedi in cui si può davvero comporre ───────────────────────
      // Le sedi dei figli intersecate con quelle attive: una voce nuova o una
      // ricarica in un plesso che l'operatore non gestisce verrebbe rifiutata
      // dalla scrittura, e offrirne la tendina è mandarlo contro un muro.
      const sediComponibili = new Set(
        alunni.map((a) => testo(a.scuola_id)).filter((s): s is string => !!s && sediAttive.has(s)),
      )

      // ── 13 · Le categorie della voce nuova (decisione n. 3: solo esistenti) ─
      // ⚠️ LA SEDE SI DICHIARA NELLA QUERY, non a valle in JavaScript.
      //
      // `payment_categories` ha una `scuola_id` NULLABILE, e i due significati
      // sono diversi: `null` = categoria di tutto il registro (retta, iscrizione,
      // mensa, divisa, materiale — 5 righe in produzione, misurate il 2026-09-13),
      // valorizzata = categoria di un plesso solo (`pomeridiano` a Giugliano,
      // `doposcuola` a Cesa). La condizione è quindi «globale OPPURE di una di
      // queste sedi», che in PostgREST è un `.or` — e non si riscrive come filtro
      // in memoria: un filtro di sede che vive fuori dalla query è un filtro che
      // il prossimo `select` qui accanto non eredita. Lock:
      // `__tests__/architecture/isolamento-sede-coverage.test.ts`.
      //
      // Senza nessuna sede componibile restano le sole globali: `scuola_id.in.()`
      // con la lista vuota non è una condizione, ed è il modo in cui un `.or`
      // smette di restringere proprio dove serve di più.
      // ⚠️ L'ESPRESSIONE STA DENTRO `.or(…)`, non in una costante poche righe più
      // su: il lock legge la CATENA della query, e un filtro di sede che vive in
      // una variabile è invisibile a chi rilegge questo `select` — e al lock.
      const sediPerTendina = [...sediComponibili]
      const catRes = await supabase
        .from('payment_categories')
        .select('id, nome, slug, scuola_id, ordine')
        .eq('attivo', true)
        .or(
          sediPerTendina.length > 0
            ? `scuola_id.is.null,scuola_id.in.(${sediPerTendina.join(',')})`
            : 'scuola_id.is.null',
        )
      if (catRes.error) {
        logEvento('pagamento', 'warn', {
          operazione: OPERAZIONE,
          esito: 'categorie-non-lette',
          ...codiceErroreDi(catRes.error),
        }, catRes.error)
      }
      const categorie = ((catRes.data ?? []) as {
        id: string; nome: string; slug?: string | null; scuola_id?: string | null; ordine?: number | null
      }[])
        .sort((a, b) => (Number(a.ordine ?? 0) - Number(b.ordine ?? 0)) || String(a.nome).localeCompare(String(b.nome)))
        .map((c) => ({ id: c.id, nome: c.nome, slug: c.slug ?? null, scuola_id: c.scuola_id ?? null }))

      // ── 14 · I pacchetti ticket, per sede (decisione n. 7) ────────────────
      // Il costo di un pasto è della SEDE: una mappa per sede, non un numero
      // solo. Con due fratelli in due plessi, un costo unico sarebbe sbagliato
      // per uno dei due — e nessuno se ne accorgerebbe.
      //
      // ⚠️ OGNI SEDE COMPONIBILE HA LA SUA CHIAVE, anche vuota — e non è
      // pignoleria di forma: misurato il 2026-09-13, dei tre plessi di produzione
      // solo **Giugliano** ha un pacchetto configurato; **Cesa** (245 bambini) e
      // **Aversa** (120) ne hanno zero, e la sede di collaudo non ha nemmeno la
      // riga in `admin_settings`. «Chiave assente» e «elenco vuoto» sarebbero
      // quindi il caso NORMALE su due sedi su tre: darne due rappresentazioni
      // significa due rami di rendering, e uno dei due non lo prova nessuno.
      // Il costo unitario, là, lo digiterà l'operatrice — mai un numero inventato
      // qui, che sarebbe il prezzo di un altro plesso spacciato per il suo.
      const pacchetti: Record<string, { label: string; pezzi: number; costo: number }[]> = {}
      for (const sede of sediComponibili) pacchetti[sede] = []
      if (sediComponibili.size > 0) {
        const st = await supabase
          .from('admin_settings')
          .select('scuola_id, ticket_pacchetti')
          .in('scuola_id', [...sediComponibili])
        if (st.error) {
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE,
            esito: 'pacchetti-ticket-non-letti',
            n: sediComponibili.size,
            ...codiceErroreDi(st.error),
          }, st.error)
        }
        for (const s of (st.data ?? []) as { scuola_id?: string; ticket_pacchetti?: unknown }[]) {
          if (!s.scuola_id) continue
          const righe = Array.isArray(s.ticket_pacchetti) ? s.ticket_pacchetti : []
          pacchetti[s.scuola_id] = righe
            .map((p) => p as { label?: unknown; pezzi?: unknown; costo?: unknown })
            .filter((p) => Number.isFinite(Number(p?.pezzi)) && Number.isFinite(Number(p?.costo)))
            .map((p) => ({ label: String(p.label ?? ''), pezzi: Number(p.pezzi), costo: Number(p.costo) }))
        }
      }

      // ── 15 · I nomi delle sedi citate (la busta, non la riga) ─────────────
      const idSediCitate = [
        ...new Set([
          ...alunni.map((a) => testo(a.scuola_id)),
          ...categorie.map((c) => c.scuola_id),
        ].filter((s): s is string => !!s)),
      ]
      const sedi: Record<string, string> = {}
      if (idSediCitate.length > 0) {
        const sc = await supabase.from('scuole').select('id, nome').in('id', idSediCitate)
        if (sc.error) {
          // ⚠️ Il degrado è l'ASSENZA della chiave, mai una stringa inventata: la
          // schermata dirà «un altro plesso» senza nominarlo, che è vero.
          logEvento('pagamento', 'warn', {
            operazione: OPERAZIONE,
            esito: 'nomi-sedi-non-letti',
            n: idSediCitate.length,
            ...codiceErroreDi(sc.error),
          }, sc.error)
        }
        for (const s of (sc.data ?? []) as { id?: string; nome?: string | null }[]) {
          const nome = testo(s.nome)
          if (s.id && nome) sedi[s.id] = nome
        }
      }

      // ── 16 · I figli, con la MINIMIZZAZIONE del nome ──────────────────────
      const figli = alunni.map((a) => {
        const sede = testo(a.scuola_id)
        const inSede = sede != null && sediAttive.has(sede)
        return {
          alunno_id: a.id,
          /**
           * 🔴 Il nome di un minore esce solo per le sedi dell'operatore: stesso
           * criterio dei `label` dei suggerimenti nel GET della lista. Per un
           * figlio di un altro plesso resta `null`, e a dire di chi si tratta è
           * il nome della SEDE (`sedi[scuola_id]`).
           */
          nome: inSede ? [a.nome, a.cognome].filter(Boolean).join(' ').trim() || null : null,
          scuola_id: sede,
          in_sede: inSede,
          /**
           * Ancora iscritto: su un `false` la scrittura rifiuta le voci NUOVE.
           * Senza la colonna (`statoLetto === false`, DB E2E) il criterio non si
           * applica: tutti attivi, e il rifiuto resta quello della scrittura.
           */
          attivo: statoLetto ? eAncoraIscritto(a.stato) : true,
          saldo_ticket: saldoTicket.get(a.id) ?? 0,
          voci_aperte: vociAperte
            .filter((v) => v.alunno_id === a.id)
            .map((v) => ({
              ...v,
              // La forma che `rigaDaVoceAperta` legge: lo slug annidato come
              // arriverebbe da un join, così il pannello non adatta niente.
              payment_categories: { slug: slugPerCategoria.get(testo(v.categoria_id) ?? '') ?? null },
            })),
        }
      })

      return rispondi(movimento, candidati, proposto, figli, pacchetti, categorie, sedi)
    } catch (err) {
      // ⚠️ `withRoute` NON vede le eccezioni catturate: senza questa riga il 500
      // uscirebbe muto.
      logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
      return NextResponse.json(
        {
          error: 'Non è stato possibile leggere il contesto di questo bonifico',
          codice: 'CONCILIAZIONE_CONTESTO_NON_LETTO',
        },
        { status: 500 },
      )
    }
  },
)

/**
 * La busta. Esiste come funzione perché i due ritorni felici — famiglia ignota e
 * famiglia risolta — devono avere la STESSA forma: un pannello che riceve
 * `figli: undefined` in un caso e `figli: []` nell'altro finisce per avere due
 * rami di rendering per la stessa situazione, e uno dei due non lo prova nessuno.
 */
function rispondi(
  movimento: MovimentoRiga,
  candidati: { parent_id: string; nome: string; relazione: string | null }[],
  proposto: { parent_id: string; motivo: MotivoPagante } | null,
  figli: unknown[],
  pacchetti: Record<string, { label: string; pezzi: number; costo: number }[]>,
  categorie: { id: string; nome: string; slug: string | null; scuola_id: string | null }[],
  sedi: Record<string, string>,
): NextResponse {
  return NextResponse.json({
    success: true,
    data: {
      movimento: {
        id: movimento.id,
        importo: Number(movimento.importo),
        data_operazione: movimento.data_operazione,
        causale: movimento.causale ?? null,
        // L'ordinante come l'ha scritto la banca: non si corregge, non si
        // rimaneggia. È quello che l'operatrice confronta con l'anagrafica.
        controparte: movimento.controparte ?? null,
        stato: movimento.stato,
        scuola_id: movimento.scuola_id ?? null,
      },
      pagante: { proposto, candidati },
      figli,
      categorie,
      pacchetti_ticket: pacchetti,
      sedi,
    },
  })
}
