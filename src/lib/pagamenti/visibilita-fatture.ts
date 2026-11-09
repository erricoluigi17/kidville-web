import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { haRuolo, haUnRuolo, type AppRole, type AppUser } from '@/lib/auth/predicati-ruolo'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * Lo snapshot scritto sulla singola riga al momento dell'emissione.
 *
 * `null` identifica lo storico che la Segreteria non ha ancora potuto
 * classificare: quando il filtro è attivo non è una prova di accesso e resta
 * quindi nascosto alla famiglia.
 */
export interface RigaVisibilitaFattura {
  id: string
  modalita_emissione: 'ordinaria' | 'quote_separate' | null
  /** PK canonica `parents.id`, già normalizzata durante l'emissione. */
  parent_registry_id: string | null
}

export type EsitoVisibilitaFatture =
  | { esito: 'ok'; puoVedere: (riga: RigaVisibilitaFattura) => boolean }
  | { esito: 'errore'; response: Response }

const RUOLI_CONTABILITA: readonly AppRole[] = ['admin', 'coordinator', 'segreteria']

const sempre = () => true

const stessoUuid = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())

function erroreLettura(operazione: string, errore: unknown): EsitoVisibilitaFatture {
  logErrore({ operazione, stato: 500, evento: 'db' }, errore)
  return {
    esito: 'errore',
    response: NextResponse.json(
      {
        error: 'Verifica della visibilità delle fatture non riuscita',
        codice: 'LETTURA_FALLITA',
      },
      { status: 500 },
    ),
  }
}

/**
 * Carica una volta il contesto necessario e restituisce il predicato da
 * applicare a TUTTE le righe della risposta.
 *
 * Non sostituisce il gate sul pagamento: il chiamante deve avere già eseguito
 * `assertFatturaInScope`. Questo helper aggiunge soltanto la visibilità per
 * documento, usando la sede del pagamento già verificato dal caller.
 *
 * Regole:
 *  - contabilità nel proprio scope di sede → tutte le righe, su ogni voce;
 *  - voce divisa (`pagamenti.tipo = 'split'`), famiglia e staff fuori scope →
 *    solo le righe col proprio `parents.id` in `parent_registry_id`, qualunque
 *    sia `modalita_emissione`, a filtro di sede acceso o spento: il titolare il
 *    04/11, «ognuno riceve solo la propria fattura». Una riga con
 *    `parent_registry_id` nullo non la vede nessuna famiglia: la consegna la
 *    segreteria;
 *  - ogni altra voce, famiglia e staff fuori scope → le righe `quote_separate`
 *    solo col proprio `parents.id`, a filtro di sede acceso o spento: la
 *    divisione in due documenti la decide `genitori_separati`, non `tipo`, e una
 *    voce `singolo` di genitori separati ne produce due. Le ordinarie restano
 *    condivise; lo storico non classificato si vede a filtro spento e si
 *    nasconde a filtro acceso.
 *
 * La contabilità si ferma prima di leggere `parents`: la lettura serve solo a
 * famiglia e staff fuori scope, e un suo guasto dà 500 come gli altri.
 *
 * `tipoVoce` è obbligatorio di proposito, anche se può valere `null`: una route
 * che lo dimentica non compila, e una route che lo perde per strada farebbe
 * uscire il PDF dell'altro genitore, con codice fiscale e residenza.
 *
 * Ogni errore di lettura necessario produce un 500. Un guasto non viene mai
 * trasformato in un consenso o in un falso «non sei autorizzato».
 */
export async function caricaVisibilitaFatture(
  supabase: SupabaseClient,
  user: AppUser,
  scuolaId: string,
  tipoVoce: string | null | undefined,
): Promise<EsitoVisibilitaFatture> {
  const { data: impostazioni, error: erroreImpostazioni } = await supabase
    .from('admin_settings')
    .select('fatture_visibilita_attiva_il')
    .eq('scuola_id', scuolaId)
    .maybeSingle()

  if (erroreImpostazioni) {
    return erroreLettura('caricaVisibilitaFatture:impostazioni', erroreImpostazioni)
  }

  const filtroAttivo = Boolean(
    (impostazioni as { fatture_visibilita_attiva_il?: string | null } | null)
      ?.fatture_visibilita_attiva_il,
  )
  const voceDivisa = tipoVoce === 'split'

  const contabile = haUnRuolo(user, RUOLI_CONTABILITA)
  if (contabile && stessoUuid(user.scuola_id, scuolaId)) {
    return { esito: 'ok', puoVedere: sempre }
  }

  // Solo gli admin possono avere sedi contabili aggiuntive nel ponte. Si guarda
  // il ruolo REALE, non la veste attiva: un admin che sta usando l'app come
  // genitore conserva lo scope di lavoro nei plessi che gli sono assegnati.
  if (contabile && haRuolo(user, 'admin')) {
    const { data: sedeAggiuntiva, error: erroreSedi } = await supabase
      .from('utenti_scuole')
      .select('scuola_id')
      .eq('utente_id', user.id)
      .eq('scuola_id', scuolaId)
      .maybeSingle()

    if (erroreSedi) {
      return erroreLettura('caricaVisibilitaFatture:sedi', erroreSedi)
    }
    if (sedeAggiuntiva) return { esito: 'ok', puoVedere: sempre }
  }

  // Se lo staff non è nel perimetro lavorativo di questa sede, il gate base può
  // averlo ammesso soltanto come familiare del bambino. Da qui in poi valgono le
  // stesse regole di ogni altro genitore, senza privilegi cross-plesso.
  const { data: genitore, error: erroreGenitore } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle()

  if (erroreGenitore) {
    return erroreLettura('caricaVisibilitaFatture:parents', erroreGenitore)
  }

  const parentId = (genitore as { id?: string | null } | null)?.id ?? null

  if (voceDivisa) {
    // `fattura` è in `EVENTI_PERSISTITI`: dice che la regola scatta, ed è il solo
    // modo di sapere che una route le passa ancora il `tipo`. `distingui` perché
    // `app_log` deduplica per giorno senza guardare il contesto: senza, la riga
    // porterebbe la sede della prima chiamata per tutte e tre.
    logEvento('fattura', 'info', {
      operazione: 'caricaVisibilitaFatture:voce-divisa',
      esito: 'solo-la-propria',
      scuola_id: scuolaId,
    }, undefined, { distingui: ['scuola_id'] })
    return { esito: 'ok', puoVedere: (riga) => stessoUuid(parentId, riga.parent_registry_id) }
  }

  // Niente log qui: questo ramo gira a ogni apertura di una voce qualunque.
  return {
    esito: 'ok',
    puoVedere: (riga) => {
      if (riga.modalita_emissione === 'quote_separate') return stessoUuid(parentId, riga.parent_registry_id)
      if (riga.modalita_emissione === 'ordinaria') return true
      return !filtroAttivo
    },
  }
}
