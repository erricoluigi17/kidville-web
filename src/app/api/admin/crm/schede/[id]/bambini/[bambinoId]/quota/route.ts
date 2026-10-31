import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import type { AppUser } from '@/lib/auth/require-staff'
import { assertBambinoInScope, assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { codiceErroreDb, rispostaCrmNonRiuscita, rispostaErroreDb, rispostaErroreDbSchema } from '@/lib/crm/errori'
import {
  annoDellaQuota,
  esitoPassaggioDa,
  etichettaAnno,
  giornoContantiAmmesso,
  registraEsitoPassaggio,
  statoDopoPassaggio,
} from '@/lib/crm/quota'
import { QUOTA_METODI } from '@/lib/crm/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { logEvento } from '@/lib/logging/logger'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { politicaNotificaServizio } from '@/lib/storici/notifiche-servizi'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { parseBody, parseData, validationError } from '@/lib/validation/http'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * CRM della segreteria · la quota d'iscrizione di un bambino: segnarla, correggerla, toglierla.
 *
 *  · `PUT    { importo, giorno?, metodo }` → `200 { data: { stato, passaggio } }`. Segna la quota (o la
 *    corregge, se c'era già). `giorno` vuoto = oggi a Roma, mai nel futuro. L'anno NON si sceglie: si ricava
 *    dall'anno di ingresso del bambino. Se il bambino è già un alunno la quota passa subito in contabilità
 *    (`passaggio` dice com'è andata); altrimenti resta «in attesa» e `passaggio` è nullo.
 *  · `DELETE`                              → `200 { data: { stornato } }`. Toglie la quota (per i contanti
 *    storna l'entrata di cassa con un contro-movimento). È anche «È lo stesso pagamento» della spec §5.5.
 *
 * Le due operazioni scrivono SOLO attraverso una funzione SQL (`crm_quota_segna`, `crm_quota_togli`): una
 * transazione, con la riga del bambino bloccata (il doppio clic non lascia due entrate in cassa). La route
 * non fa nessun `insert`/`update` da sé: valida, verifica la sede, traduce gli esiti.
 *
 * ── La sede ────────────────────────────────────────────────────────────────────────────────────
 * Non arriva dal client: è quella della SCHEDA (`assertSchedaInScope`), e il bambino deve essere di quella
 * scheda E di quella sede, nella stessa query (`assertBambinoInScope`). Le funzioni SQL girano con la
 * service-role e non conoscono la sede di chi chiede: se la route non la verifica, non la verifica nessuno.
 *
 * ── Gli errori (ogni `codice` è dichiarato in `CODICI_ERRORE` e tradotto nelle due lingue) ──────
 *  · 400 — corpo illeggibile (importo non positivo, con più di due decimali, oltre i 100.000 €; metodo fuori
 *    elenco; giorno inesistente) o argomenti che il database rifiuta (`22023`, che la validazione dovrebbe
 *    aver già fermato: se arriva fin lì è un avviso nel log);
 *  · 404 `SCHEDA_NON_TROVATA` — bambino non della scheda/sede, o sparito mentre si scriveva;
 *  · 409 `QUOTA_GIA_IN_CONTABILITA` — la quota è già una voce dell'alunno: si corregge in contabilità;
 *  · 409 `QUOTA_CASSA_CHIUSA` (+ `giornoProposto`) — contanti datati a un giorno già chiuso in cassa;
 *  · 422 `QUOTA_GIORNO_FUTURO`, 422 `QUOTA_ANNO_MANCANTE`;
 *  · 503 `CRM_NON_INSTALLATO` — tabelle, colonne o funzioni del CRM assenti (il database E2E della CI);
 *  · 500 `CRM_OPERAZIONE_NON_RIUSCITA` — qualunque altro guasto, comprese le categorie di sistema assenti.
 *
 * ── La notifica al genitore ────────────────────────────────────────────────────────────────────
 * Solo se in QUESTA richiesta il passaggio in contabilità ha registrato un incasso (contanti o carta, mai
 * il bonifico, che lo chiude la banca): è la stessa conferma «Pagamento registrato» della contabilità
 * (`pagamenti/incassi`), con la stessa politica per i giorni passati. Un errore della notifica non fa
 * fallire la richiesta: si logga.
 */

const OP_PUT = 'admin/crm/schede/[id]/bambini/[bambinoId]/quota:PUT'
const OP_DELETE = 'admin/crm/schede/[id]/bambini/[bambinoId]/quota:DELETE'

const putBodySchema = z.object({
  // Due decimali al massimo (zod 4.4.3 non sbaglia sui float: 150.5, 19.99 e 1234.56 passano, 150.555 no —
  // lo prova il test), almeno un centesimo, al massimo 100.000 €. La virgola all'italiana è affare del campo.
  importo: z.number().positive().multipleOf(0.01).max(100000),
  giorno: zDataYMD.nullish(),
  metodo: z.enum(QUOTA_METODI),
})

type Contesto = { params: Promise<{ id: string; bambinoId: string }> }

const bambinoSparito = () =>
  NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })

const giaInContabilita = () =>
  NextResponse.json(
    { error: 'La quota è già in contabilità: si corregge da lì.', codice: 'QUOTA_GIA_IN_CONTABILITA' },
    { status: 409 },
  )

/** `importo` come lo legge una segretaria: `150,50`. */
const importoInEuro = (importo: number) => importo.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * La conferma al genitore (best-effort): lo stato della voce si rilegge per dire «Pagamento» o «Acconto»
 * (la voce che l'alunno aveva già può valere più della quota). Mai bloccante, mai silenziosa.
 */
async function notificaPagamentoRegistrato(
  supabase: SupabaseClient,
  user: AppUser,
  p: { scuolaId: string; alunnoId: string; pagamentoId: string; importo: number; anno: number; giorno: string },
): Promise<void> {
  try {
    const { data: voce, error } = await supabase
      .from('pagamenti')
      .select('stato')
      .eq('id', p.pagamentoId)
      .eq('scuola_id', p.scuolaId)
      .maybeSingle()
    if (error) {
      logEvento('pagamento', 'warn', { operazione: OP_PUT, esito: 'stato_non_riletto', pagamento_id: p.pagamentoId }, error)
    }
    const saldato = (voce as { stato?: string } | null)?.stato === 'pagato'
    await notificaEvento(supabase, {
      tipo: 'pagamento_registrato',
      operazione: politicaNotificaServizio(user, p.giorno),
      scuolaId: p.scuolaId,
      alunnoIds: [p.alunnoId],
      titolo: saldato ? 'Pagamento registrato' : 'Acconto registrato',
      corpo: `Iscrizione ${etichettaAnno(p.anno)}: registrato un incasso di ${importoInEuro(p.importo)} €.`,
      link: '/parent/pagamenti',
      entitaTipo: 'pagamento',
      entitaId: p.pagamentoId,
      debounce: true,
    })
  } catch (e) {
    // La quota è già in contabilità, ma la conferma al genitore NON è stata accodata: una scrittura persa,
    // e senza riavvii. Perciò `error`, non `warn`.
    logEvento('notifica', 'error', { operazione: OP_PUT, tipo: 'pagamento_registrato', esito: 'notifica_non_inviata' }, e)
  }
}

export const PUT = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]/quota:PUT',
  async (request: NextRequest, context: Contesto) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const parametri = await context.params
    const idP = parseData(zUuid, parametri.id)
    if ('response' in idP) return idP.response
    const bambinoP = parseData(zUuid, parametri.bambinoId)
    if ('response' in bambinoP) return bambinoP.response
    const body = await parseBody(request, putBodySchema)
    if ('response' in body) return body.response
    const { giorno: giornoScelto, metodo } = body.data
    // Un float uscito da un calcolo (0.1 + 0.2) è valido per `multipleOf`, ma il database confronta l'importo
    // con la sua versione a due decimali e lo rifiuterebbe: si porta a due decimali prima di inviarlo.
    const importo = Math.round(body.data.importo * 100) / 100

    const supabase = await createAdminClient()
    const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
    if ('response' in ambito) return ambito.response
    const { scuola_id: scuolaId } = ambito.scheda
    const trovato = await assertBambinoInScope(supabase, ambito.scheda, bambinoP.data, OP_PUT)
    if ('response' in trovato) return trovato.response
    const { bambino } = trovato
    const bambinoId = bambino.id

    // Il giorno si conta a Roma: alle 23:30 UTC del 31/10 è già l'1/11, e quel giorno va accettato.
    const adesso = new Date()
    const oggi = dataCivile(adesso)
    const giorno = giornoScelto ?? oggi
    if (giorno > oggi) {
      return NextResponse.json(
        { error: 'Il giorno del pagamento non può essere nel futuro.', codice: 'QUOTA_GIORNO_FUTURO' },
        { status: 422 },
      )
    }

    const anno = annoDellaQuota(bambino.anno_ingresso, adesso)
    if (anno === null) {
      return NextResponse.json(
        { error: 'Indica l’anno di ingresso del bambino prima di segnare la quota.', codice: 'QUOTA_ANNO_MANCANTE' },
        { status: 422 },
      )
    }

    if (metodo === 'contanti') {
      // L'ultima chiusura di cassa della SEDE: un'entrata datata a un giorno già chiuso conterebbe due volte.
      const { data: chiusure, error: erroreChiusura } = await supabase
        .from('cassa_chiusure')
        .select('eseguita_il')
        .eq('scuola_id', scuolaId)
        .order('eseguita_il', { ascending: false })
        .limit(1)
      if (erroreChiusura) return rispostaErroreDb(erroreChiusura, OP_PUT)
      const ultimaChiusuraIl = ((chiusure?.[0] as { eseguita_il?: string | null } | undefined)?.eseguita_il ?? null) as
        | string
        | null
      if (!giornoContantiAmmesso(giorno, ultimaChiusuraIl, oggi)) {
        return NextResponse.json(
          {
            error: 'La cassa di quel giorno è già chiusa. Scegli un giorno dopo l’ultima chiusura, oppure oggi.',
            codice: 'QUOTA_CASSA_CHIUSA',
            giornoProposto: oggi,
          },
          { status: 409 },
        )
      }
    }

    // `bambinoP.data` è l'id che `assertBambinoInScope` ha appena verificato: la funzione SQL gira con la
    // service-role e si fida di chi la chiama.
    const { data, error } = await supabase.rpc('crm_quota_segna', {
      p_bambino_id: bambinoP.data,
      p_importo: importo,
      p_metodo: metodo,
      p_giorno: giorno,
      p_anno: anno,
      p_eseguito_da: auth.user.id,
    })
    if (error) {
      if (codiceErroreDb(error) === '22023') {
        // La validazione di sopra dovrebbe averlo fermato: se il database lo rifiuta, qualcosa non torna fra le
        // due. Non è un guasto del server (500) ma nemmeno una cosa da far passare in silenzio.
        logEvento('crm', 'warn', { operazione: OP_PUT, esito: 'quota-argomenti-non-validi', entita_id: bambinoId }, error)
        return validationError([{ path: ['quota'], message: 'Dati non validi' }])
      }
      return rispostaErroreDbSchema(error, OP_PUT)
    }

    const esito = (data ?? {}) as Record<string, unknown>
    if (esito.esito === 'in_contabilita') return giaInContabilita()
    if (esito.esito === 'non_trovato') return bambinoSparito()
    if (esito.esito === 'categoria_assente') {
      // Manca la categoria di sistema «iscrizione»: è la configurazione, non la richiesta. Un incidente.
      logEvento('crm', 'error', { operazione: OP_PUT, esito: 'quota-categoria-assente', entita_id: bambinoId })
      return rispostaCrmNonRiuscita()
    }
    if (esito.esito !== 'ok') {
      logEvento('crm', 'error', { operazione: OP_PUT, esito: 'quota-risposta-illeggibile', entita_id: bambinoId })
      return rispostaCrmNonRiuscita()
    }

    logEvento('crm', 'info', {
      operazione: OP_PUT,
      esito: esito.corretta === true ? 'quota-corretta' : 'quota-segnata',
      entita_id: bambinoId,
      scuola_id: scuolaId,
      importo,
      metodo,
      anno,
    })

    // Il bambino era già un alunno: la funzione ha provato il passaggio nella stessa transazione.
    const passaggio = esito.passaggio == null ? null : esitoPassaggioDa(esito.passaggio)
    if (passaggio) registraEsitoPassaggio(passaggio, bambinoId, OP_PUT)

    if (passaggio?.esito === 'ok' && passaggio.incassoId !== null && bambino.alunno_id) {
      await notificaPagamentoRegistrato(supabase, auth.user, {
        scuolaId,
        alunnoId: bambino.alunno_id,
        pagamentoId: passaggio.pagamentoId,
        importo,
        anno,
        giorno,
      })
    }

    return NextResponse.json({ data: { stato: statoDopoPassaggio(passaggio), passaggio } })
  },
)

export const DELETE = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]/quota:DELETE',
  async (request: NextRequest, context: Contesto) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const parametri = await context.params
    const idP = parseData(zUuid, parametri.id)
    if ('response' in idP) return idP.response
    const bambinoP = parseData(zUuid, parametri.bambinoId)
    if ('response' in bambinoP) return bambinoP.response

    const supabase = await createAdminClient()
    const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
    if ('response' in ambito) return ambito.response
    const trovato = await assertBambinoInScope(supabase, ambito.scheda, bambinoP.data, OP_DELETE)
    if ('response' in trovato) return trovato.response
    const bambinoId = trovato.bambino.id

    const { data, error } = await supabase.rpc('crm_quota_togli', {
      p_bambino_id: bambinoP.data,
      p_eseguito_da: auth.user.id,
    })
    if (error) return rispostaErroreDbSchema(error, OP_DELETE)

    const esito = (data ?? {}) as Record<string, unknown>
    if (esito.esito === 'in_contabilita') return giaInContabilita()
    if (esito.esito === 'non_trovato') return bambinoSparito()
    if (esito.esito !== 'ok') {
      logEvento('crm', 'error', { operazione: OP_DELETE, esito: 'quota-risposta-illeggibile', entita_id: bambinoId })
      return rispostaCrmNonRiuscita()
    }

    const stornato = esito.stornato === true
    logEvento('crm', 'info', {
      operazione: OP_DELETE,
      esito: 'quota-tolta',
      entita_id: bambinoId,
      scuola_id: ambito.scheda.scuola_id,
      stornato,
    })
    return NextResponse.json({ data: { stornato } })
  },
)
