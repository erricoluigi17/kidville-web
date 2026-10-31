import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope'
import { requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDbSchema } from '@/lib/crm/errori'
import { giorniDiAttesa } from '@/lib/crm/quota'
import {
  QUOTA_METODI,
  QUOTA_MOTIVI_BLOCCO,
  QUOTA_STATI_IN_ATTESA,
  type MetodoQuota,
  type MotivoBloccoQuota,
  type QuotaInAttesa,
} from '@/lib/crm/tipi'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zUuid } from '@/lib/validation/common'
import { parseQuery } from '@/lib/validation/http'

/**
 * CRM della segreteria · la lista «Quote dal CRM» della contabilità (spec 2026-10-31, §5.6).
 *
 * `GET /api/admin/crm/quote[?scuolaId=<uuid>]` → `200 { data: QuotaInAttesa[] }`.
 *
 * Le quote d'iscrizione segnate nel CRM che NON sono ancora diventate la voce «Iscrizione» dell'alunno:
 *  · `in_attesa`      il bambino non è ancora un alunno (o lo è, ma il passaggio non è ancora andato);
 *  · `senza_importo`  la vecchia spunta, da completare dalla scheda;
 *  · `bloccata`       il passaggio non si può fare da solo, e `motivo` dice perché.
 * Una quota sparisce dalla lista nel momento in cui passa in contabilità (`in_contabilita`).
 *
 * ── LA SEDE ───────────────────────────────────────────────────────────────────────────────────
 * Senza `scuolaId` valgono le sedi attive dell'utente (`resolveScuoleAttive`: le spuntate nel selettore,
 * ri-validate contro le sue); con `scuolaId` si guarda quella sola (`restringiSedi`), e una sede che non è fra
 * le proprie è un 403 `SEDE_NON_ACCESSIBILE`, mai un elenco vuoto. Il filtro sta nella STESSA query
 * (`.in('scuola_id', sedi)`): le righe di un altro plesso non vengono nemmeno lette. Chi non ha nessuna sede
 * riceve l'elenco vuoto senza toccare il database.
 *
 * ── L'ORDINE ──────────────────────────────────────────────────────────────────────────────────
 * Per giorno del pagamento, dal più vecchio: in cima chi aspetta da più tempo. Senza giorno (la vecchia
 * spunta mai completata) in fondo.
 *
 * ── DATI DI MINORI ────────────────────────────────────────────────────────────────────────────
 * La risposta porta il `nome` del bambino (serve alla segreteria per riconoscere la riga); il LOG no: solo
 * uuid della sede e conteggi.
 *
 * ── DATABASE NON MIGRATO ──────────────────────────────────────────────────────────────────────
 * Tabelle o colonne della quota assenti (il DB E2E della CI non ha le tabelle `crm_*`, e fra il deploy e la
 * migrazione mancano le colonne) → 503 `CRM_NON_INSTALLATO`, non 500.
 */

/** Lo stesso nome che sta in `withRoute` (il lock `logging-coverage` vuole la stringa letterale lì): serve ai log. */
const OPERAZIONE = 'admin/crm/quote:GET'

/**
 * Un tetto alla lettura, pari al massimo di righe che PostgREST restituisce comunque: se lo si tocca, l'elenco
 * potrebbe essere stato tagliato, e non lo si lascia passare in silenzio (avviso nel log).
 */
const LIMITE_RIGHE = 1000

const querySchema = z.object({ scuolaId: zUuid.optional() })

type Riga = {
  id: string
  scheda_id: string
  scuola_id: string
  nome: string | null
  alunno_id: string | null
  quota_importo: number | string | null
  quota_metodo: string | null
  quota_anno: number | null
  quota_stato: QuotaInAttesa['stato']
  quota_blocco_motivo: string | null
  quota_saldata_il: string | null
}

/** `numeric` arriva da PostgREST come numero o come stringa. */
function comeNumero(v: number | string | null): number | null {
  if (v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export const GET = withRoute('admin/crm/quote:GET', async (request: NextRequest) => {
  const auth = await requireCrm(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, querySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const sedi = restringiSedi(attive, q.data.scuolaId)
  if (sedi === null) {
    logEvento('multi_sede', 'warn', {
      operazione: OPERAZIONE,
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }
  // Nessuna sede: non c'è niente da leggere, e un `.in('scuola_id', [])` non è una domanda da fare.
  if (sedi.length === 0) return NextResponse.json({ data: [] satisfies QuotaInAttesa[] })

  const { data, error } = await supabase
    .from('crm_bambini')
    .select(
      'id, scheda_id, scuola_id, nome, alunno_id, quota_importo, quota_metodo, quota_anno, quota_stato, quota_blocco_motivo, quota_saldata_il',
    )
    .in('scuola_id', sedi)
    .in('quota_stato', [...QUOTA_STATI_IN_ATTESA])
    .order('quota_saldata_il', { ascending: true, nullsFirst: false })
    .order('id')
    .limit(LIMITE_RIGHE)
  if (error) return rispostaErroreDbSchema(error, OPERAZIONE)

  const righe = (data ?? []) as Riga[]
  const oggi = dataCivile()

  const elenco: QuotaInAttesa[] = righe.map((r) => ({
    bambinoId: r.id,
    schedaId: r.scheda_id,
    scuolaId: r.scuola_id,
    nome: r.nome ?? null,
    anno: typeof r.quota_anno === 'number' ? r.quota_anno : null,
    importo: comeNumero(r.quota_importo),
    metodo: (QUOTA_METODI as readonly unknown[]).includes(r.quota_metodo) ? (r.quota_metodo as MetodoQuota) : null,
    giorno: r.quota_saldata_il ?? null,
    giorniAttesa: giorniDiAttesa(r.quota_saldata_il, oggi),
    stato: r.quota_stato,
    motivo: (QUOTA_MOTIVI_BLOCCO as readonly unknown[]).includes(r.quota_blocco_motivo)
      ? (r.quota_blocco_motivo as MotivoBloccoQuota)
      : null,
    alunnoCollegato: r.alunno_id !== null && r.alunno_id !== undefined,
  }))

  // Solo uuid e conteggi: mai il nome del bambino.
  const bloccate = elenco.filter((v) => v.stato === 'bloccata').length
  logEvento('crm', 'info', {
    operazione: OPERAZIONE,
    esito: 'quote-in-attesa-lette',
    utente: auth.user.id,
    sedi: sedi.length,
    totale: elenco.length,
    bloccate,
  })
  if (righe.length >= LIMITE_RIGHE) {
    logEvento('crm', 'warn', { operazione: OPERAZIONE, esito: 'quote-elenco-al-tetto', utente: auth.user.id, tetto: LIMITE_RIGHE })
  }

  return NextResponse.json({ data: elenco })
})
