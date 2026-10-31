import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertBambinoInScope, assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { agganciaAlunno } from '@/lib/crm/aggancio-alunno'
import { rispostaCrmNonInstallato, rispostaCrmNonRiuscita, rispostaErroreDbSchema } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

/**
 * CRM della segreteria · il collegamento a mano fra un bambino della scheda e il suo ALUNNO in anagrafica.
 *
 * È ciò che fa passare la quota d'iscrizione in contabilità quando il bambino non arriva da una domanda
 * importata: un fratello o un rinnovo già in anagrafica, oppure la domanda importata che la ricerca
 * automatica non ha saputo abbinare (`alunnoDaDomandaImportata`).
 *
 *  · `PUT    { alunnoId }` → `200 { data: { collegato, passaggio } }`. Collega il bambino all'alunno e, se la
 *    quota era in attesa o bloccata, la passa in contabilità nella stessa transazione (`passaggio` dice com'è
 *    andata; è nullo se non c'era niente da passare). `collegato` è falso se il bambino era già collegato a
 *    QUELL'alunno (la richiesta ripetuta non rifà niente). Al genitore NON parte nessuna notifica: la voce nasce
 *    da un aggancio, non da un incasso fatto in quel momento.
 *  · `DELETE` → `200 { data: { scollegato } }`. Toglie il collegamento, ma solo finché la quota non è in
 *    contabilità (da lì in poi il collegamento tiene insieme la voce e l'alunno). `scollegato` è falso se il
 *    bambino non era collegato a nessuno: non si scrive niente e non si inventa una riga di storico.
 *
 * L'unica scrittura del PUT sta nella funzione SQL `crm_aggancia_alunno` (una transazione sola, riga del
 * bambino bloccata): la route valida, verifica la sede e traduce gli esiti.
 *
 * ── La sede ────────────────────────────────────────────────────────────────────────────────────
 * Non arriva dal client: è quella della SCHEDA (`assertSchedaInScope`), e il bambino deve essere di quella
 * scheda E di quella sede, nella stessa query (`assertBambinoInScope`). Che l'ALUNNO sia della stessa sede lo
 * decide la funzione SQL (`sede_diversa`): un collegamento non attraversa i plessi.
 *
 * ── Gli errori (ogni `codice` è dichiarato in `CODICI_ERRORE` e tradotto nelle due lingue) ──────
 *  · 400 — corpo o id illeggibili;
 *  · 404 `SCHEDA_NON_TROVATA` — bambino non della scheda/sede, o sparito mentre si scriveva;
 *  · 409 `ALUNNO_GIA_COLLEGATO` — il bambino è già di un ALTRO alunno, oppure l'alunno è già di un altro
 *    bambino del CRM (la UNIQUE sull'alunno: l'import e un collegamento a mano arrivano insieme). Mai un 500,
 *    e mai `GIA_COLLEGATO`, che parla delle domande di iscrizione;
 *  · 409 `QUOTA_GIA_IN_CONTABILITA` (DELETE) — la quota è già una voce dell'alunno;
 *  · 422 `ALUNNO_NON_DELLA_SEDE` — l'alunno è di un'altra sede (o non esiste);
 *  · 503 `CRM_NON_INSTALLATO` — tabelle, colonne o funzioni del CRM assenti (il database E2E della CI);
 *  · 500 `CRM_OPERAZIONE_NON_RIUSCITA` — qualunque altro guasto.
 */

const OP_PUT = 'admin/crm/schede/[id]/bambini/[bambinoId]/alunno:PUT'
const OP_DELETE = 'admin/crm/schede/[id]/bambini/[bambinoId]/alunno:DELETE'

const putBodySchema = z.object({ alunnoId: zUuid })

type Contesto = { params: Promise<{ id: string; bambinoId: string }> }

const bambinoSparito = () =>
  NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })

export const PUT = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]/alunno:PUT',
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

    const supabase = await createAdminClient()
    const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
    if ('response' in ambito) return ambito.response
    const trovato = await assertBambinoInScope(supabase, ambito.scheda, bambinoP.data, OP_PUT)
    if ('response' in trovato) return trovato.response

    // `trovato.bambino.id` è l'id che `assertBambinoInScope` ha appena verificato: la funzione SQL gira con la
    // service-role e si fida di chi la chiama. `agganciaAlunno` non lancia e lascia lei la sua riga di log.
    const esito = await agganciaAlunno(supabase, trovato.bambino.id, body.data.alunnoId, auth.user.id)

    switch (esito.esito) {
      case 'ok':
        return NextResponse.json({ data: { collegato: esito.collegato, passaggio: esito.passaggio } })
      case 'sede_diversa':
        return NextResponse.json(
          { error: 'L’alunno scelto non fa parte di questa sede.', codice: 'ALUNNO_NON_DELLA_SEDE' },
          { status: 422 },
        )
      case 'gia_collegato_altro':
      case 'alunno_gia_collegato':
        return NextResponse.json(
          {
            error: 'Il bambino o l’alunno scelto sono già collegati: togli prima il collegamento esistente.',
            codice: 'ALUNNO_GIA_COLLEGATO',
          },
          { status: 409 },
        )
      case 'non_trovato':
        return bambinoSparito()
      case 'non_installato':
        return rispostaCrmNonInstallato()
      case 'errore':
        return rispostaCrmNonRiuscita()
    }
  },
)

export const DELETE = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]/alunno:DELETE',
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
    const { scuola_id: scuolaId } = ambito.scheda
    const trovato = await assertBambinoInScope(supabase, ambito.scheda, bambinoP.data, OP_DELETE)
    if ('response' in trovato) return trovato.response
    const { id: bambinoId, alunno_id: alunnoPrima } = trovato.bambino

    // Niente da togliere: la richiesta ripetuta è una risposta normale, e non lascia una riga di storico che
    // racconterebbe uno scollegamento mai avvenuto.
    if (alunnoPrima === null) return NextResponse.json({ data: { scollegato: false } })

    // `is distinct from 'in_contabilita'`: una quota assente (NULL) o in qualunque altro stato si scollega; quella
    // già diventata voce dell'alunno no. Il filtro sta NELLA STESSA istruzione dell'update: fra la lettura e la
    // scrittura la quota può essere passata in contabilità, e allora le righe toccate sono zero.
    const { data: righe, error } = await supabase
      .from('crm_bambini')
      .update({ alunno_id: null, alunno_collegato_il: null, aggiornata_il: new Date().toISOString() })
      .eq('id', bambinoId)
      .eq('scheda_id', ambito.scheda.id)
      .eq('scuola_id', scuolaId)
      .or('quota_stato.is.null,quota_stato.neq.in_contabilita')
      .select('id')
    if (error) return rispostaErroreDbSchema(error, OP_DELETE)
    if (!righe || righe.length === 0) {
      return NextResponse.json(
        {
          error: 'La quota è già in contabilità: il bambino non si può più scollegare dall’alunno.',
          codice: 'QUOTA_GIA_IN_CONTABILITA',
        },
        { status: 409 },
      )
    }

    await registraEvento(supabase, {
      schedaId: ambito.scheda.id,
      scuolaId,
      tipo: 'alunno_scollegato',
      autore: auth.user.id,
      autoreVia: 'segreteria',
      dati: { bambino_id: bambinoId, alunno_id: alunnoPrima },
    })
    logEvento('crm', 'info', {
      operazione: OP_DELETE,
      esito: 'alunno-scollegato',
      entita_id: bambinoId,
      scuola_id: scuolaId,
      alunno_id: alunnoPrima,
    })
    return NextResponse.json({ data: { scollegato: true } })
  },
)
