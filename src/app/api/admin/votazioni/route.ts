import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveAnnoScrittura, resolveScuoleAttive, resolveScuolaScrittura, restringiSedi } from '@/lib/auth/scope'
import { conAnno } from '@/lib/anno/tipi'
import { erroreAnno } from '@/lib/anno/errori'
import { clientPerScrittura } from '@/lib/anno/gettone'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { logScrittura } from '@/lib/audit/scrittura'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { requireVotazioni } from '@/lib/votazioni/accesso'
import { genitoriDellaSede } from '@/lib/votazioni/aventi-diritto'
import { rispostaErroreDbVotazioni, schemaVotazioniAssente } from '@/lib/votazioni/errori'
import { creaVotazioneSchema, elencoQuerySchema, scadenzaInIstante } from '@/lib/votazioni/schemi'
import type { CreaVotazioneRisposta, ElencoVotazioniRisposta, RigaVotazione } from '@/lib/votazioni/tipi'
import {
  COLONNE_VOTAZIONE,
  forma,
  leggiClassi,
  leggiTutte,
  riepilogaVotazioni,
  rifiutoVotazione,
  trovaConflitto,
} from './condiviso'

/**
 * VOTAZIONI DEI RAPPRESENTANTI · L'ELENCO E L'APERTURA (segreteria).
 *
 * ── GET /api/admin/votazioni?scuolaId? ───────────────────────────────────────────────────────────────────
 * `ElencoVotazioniRisposta` per le sedi dell'utente (o per quella indicata, che deve essere una delle sue:
 * una sede altrui è un 403, non un elenco vuoto), dalla più recente. Ogni lettura porta il filtro di sede, anche
 * con lo scope vuoto (`.in('scuola_id', [])` non restituisce niente: non si toglie mai il filtro per «nessun
 * plesso»). Schema assente → 200 `{ disponibile: false }`: la pagina dice «non disponibile» invece di rompersi.
 * Qualunque altro guasto è 500: un elenco vuoto per un database in difficoltà sembrerebbe «nessuna votazione».
 *
 * ── POST /api/admin/votazioni ────────────────────────────────────────────────────────────────────────────
 * Apre una votazione. I controlli sono, nell'ordine del piano: gate di ruolo · body · sede (`resolveScuolaScrittura`:
 * 400 se resta ambigua) · almeno una scheda · scadenza futura · classi della sede · candidati d'istituto presenti
 * e validi (genitori della sede con un account attivo) · classi e istituto non già in una votazione aperta (409).
 * Poi la testata e le figlie; se una figlia non si scrive, la testata si toglie e la risposta è 500.
 *
 * Gli ISTANTI: la scadenza arriva come `YYYY-MM-DDTHH:MM` (ora di Roma) e la converte il server.
 * La persona che apre non è nei log né nell'audit con il nome; il titolo (testo libero) nemmeno.
 */

export const GET = withRoute('admin/votazioni:GET', async (request: NextRequest) => {
  const auth = await requireVotazioni(request)
  if (auth.response) return auth.response

  const q = parseQuery(request, elencoQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()
  const attive = await resolveScuoleAttive(request, supabase, auth.user)
  const scuole = restringiSedi(attive, q.data.scuolaId)
  if (scuole === null) {
    logEvento('multi_sede', 'warn', {
      operazione: 'admin/votazioni:GET',
      esito: 'sede-filtro-fuori-scope',
      utente: auth.user.id,
      ruolo: auth.user.role,
      sede_id: q.data.scuolaId,
      sedi_attive: attive.length,
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }

  const lette = await leggiTutte<RigaVotazione>('votazioni', () =>
    supabase.from('votazioni').select(COLONNE_VOTAZIONE).in('scuola_id', scuole),
  )
  if (!lette.ok) return risposteElenco(lette.errore)

  // Dalla più recente; a parità l'id, perché l'uscita non dipenda da come risponde il database.
  const righe = [...lette.valore].sort(
    (a, b) => b.creata_il.localeCompare(a.creata_il) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const riepiloghi = await riepilogaVotazioni(supabase, righe, scuole)
  if (!riepiloghi.ok) return risposteElenco(riepiloghi.errore)

  const corpo: ElencoVotazioniRisposta = { disponibile: true, votazioni: riepiloghi.valore }
  return NextResponse.json(corpo)
})

/** Un errore dell'elenco: schema assente → 200 «non disponibile» (con un warn), il resto 500. */
function risposteElenco(errore: unknown): NextResponse {
  if (schemaVotazioniAssente(errore)) {
    logEvento('votazioni', 'warn', { operazione: 'admin/votazioni:GET', esito: 'schema-votazioni-assente' }, errore)
    const corpo: ElencoVotazioniRisposta = { disponibile: false, votazioni: [] }
    return NextResponse.json(corpo)
  }
  return rispostaErroreDbVotazioni(errore as { code?: string; message?: string }, 'admin/votazioni:GET')
}

export const POST = withRoute('admin/votazioni:POST', async (request: NextRequest) => {
  const auth = await requireVotazioni(request)
  if (auth.response) return auth.response

  const body = await parseBody(request, creaVotazioneSchema)
  if ('response' in body) return body.response
  const dati = body.data

  const supabase = await createAdminClient()
  const sede = await resolveScuolaScrittura(request, supabase, auth.user, dati.scuolaId)
  if (sede.response) return sede.response
  const scuolaId = sede.scuolaId as string
  // L'anno della votazione: dichiarato, o quello del cookie, o l'unico `corrente`. Le figlie (classi e
  // candidati) sono in modo `madre`: l'anno lo prendono dalla testata e non lo scrivono.
  // Un gettone vale UNA richiesta di scrittura: testata, classi (se ci sono), candidati (se ci sono) e, se una
  // figlia cade, il disfacimento della testata. Tutte tabelle del registro (`dichiarato` o `madre`).
  const candidatiDaScrivere = dati.rappresentanteIstituto ? dati.candidatiIstituto : []
  const usi = 1 + (dati.sectionIds.length > 0 ? 1 : 0) + (candidatiDaScrivere.length > 0 ? 1 : 0) + 1
  const esito = await resolveAnnoScrittura(request, supabase, auth.user, scuolaId, { dichiarato: dati.annoId, usi, correzione: dati.correzione })
  if (esito instanceof NextResponse) return esito
  const operazione = 'admin/votazioni:POST'
  const guasto = (errore: unknown) => rispostaErroreDbVotazioni(errore as { code?: string; message?: string }, operazione)

  // 4. Qualcosa da votare.
  if (dati.sectionIds.length === 0 && !dati.rappresentanteIstituto) {
    return rifiutoVotazione('VOTAZIONE_SENZA_SCHEDE')
  }

  // 5. La scadenza: leggibile e nel futuro.
  const scadenza = scadenzaInIstante(dati.scadenza)
  if (scadenza === null || Date.parse(scadenza) <= Date.now()) {
    return rifiutoVotazione('VOTAZIONE_SCADENZA_PASSATA')
  }

  // 6. Le classi sono della sede (non di un'altra, non inesistenti).
  if (dati.sectionIds.length > 0) {
    const classi = await leggiClassi(supabase, [scuolaId], dati.sectionIds)
    if (!classi.ok) return guasto(classi.errore)
    if (dati.sectionIds.some((s) => !classi.valore.has(forma(s)))) {
      return rifiutoVotazione('VOTAZIONE_CLASSE_FUORI_SEDE')
    }
  }

  // 7. e 8. I candidati d'istituto: almeno uno, e tutti genitori della sede con un account attivo. I candidati
  //    mandati con l'istituto spento si ignorano (non si scrivono e non si validano).
  const candidati = candidatiDaScrivere
  if (dati.rappresentanteIstituto && candidati.length === 0) {
    return rifiutoVotazione('VOTAZIONE_CANDIDATI_MANCANTI')
  }
  if (candidati.length > 0) {
    const genitori = await genitoriDellaSede(supabase, scuolaId)
    // Una lettura incompleta NON è «candidato non valido»: è un guasto, e dirlo non è pedanteria (la segreteria
    // correggerebbe un candidato giusto).
    if (!genitori.completo) return guasto(genitori.errore)
    const ammessi = new Set(genitori.valore.map((g) => forma(g.utenteId)))
    if (candidati.some((c) => !ammessi.has(forma(c)))) {
      return rifiutoVotazione('VOTAZIONE_CANDIDATO_NON_VALIDO')
    }
  }

  // 9. e 10. Una classe, e l'istituto, in una sola votazione aperta alla volta.
  const conflitto = await trovaConflitto(supabase, scuolaId, dati.sectionIds, dati.rappresentanteIstituto, null)
  if (!conflitto.ok) return guasto(conflitto.errore)
  if (conflitto.valore === 'classe') return rifiutoVotazione('VOTAZIONE_CLASSE_GIA_APERTA')
  if (conflitto.valore === 'istituto') return rifiutoVotazione('VOTAZIONE_ISTITUTO_GIA_APERTA')

  // 11. La testata, poi le figlie.
  const scrittura = await clientPerScrittura(supabase, esito)
  const { data: creata, error: errTestata } = await scrittura
    .from('votazioni')
    .insert({
      scuola_id: scuolaId,
      titolo: dati.titolo,
      scadenza,
      rappresentante_istituto: dati.rappresentanteIstituto,
      creata_da: auth.user.id,
      ...conAnno(esito),
    })
    .select('id')
    .single()
  if (errTestata) {
    const anno = erroreAnno(errTestata, operazione)
    if (anno) return anno
  }
  if (errTestata || !creata) return guasto(errTestata ?? new Error('votazioni:insert-senza-riga'))
  const id = (creata as { id: string }).id

  if (dati.sectionIds.length > 0) {
    const { error } = await scrittura
      .from('votazioni_classi')
      .insert(dati.sectionIds.map((section_id) => ({ votazione_id: id, scuola_id: scuolaId, section_id })))
    if (error) return annullaTestata(scrittura, id, scuolaId, error, operazione)
  }
  if (candidati.length > 0) {
    const { error } = await scrittura
      .from('votazioni_candidati')
      .insert(candidati.map((utente_id) => ({ votazione_id: id, scuola_id: scuolaId, utente_id })))
    if (error) return annullaTestata(scrittura, id, scuolaId, error, operazione)
  }

  // 12. L'audit (senza il titolo: testo libero) e il battito di successo.
  await logScrittura(supabase, {
    attore: auth.user,
    entitaTipo: 'votazione',
    entitaId: id,
    azione: 'insert',
    scuolaId,
    valoreDopo: {
      scadenza,
      classi: dati.sectionIds.length,
      istituto: dati.rappresentanteIstituto,
      candidati: candidati.length,
    },
  })
  logEvento('votazioni', 'info', { operazione: 'crea', esito: 'creata', votazione_id: id })

  const corpo: CreaVotazioneRisposta = { id }
  return NextResponse.json(corpo, { status: 201 })
})

/**
 * Una figlia non si è scritta: la testata appena creata non deve restare, vuota, nell'elenco della segreteria.
 * Si toglie con id E sede (le figlie, se qualcuna è entrata, cadono in cascata). Se anche il ripristino
 * fallisce la testata resta orfana: la risposta è comunque 500, e il guasto si scrive due volte (con lo stack, e
 * con l'id per trovarla) invece di sparire.
 */
async function annullaTestata(
  supabase: SupabaseClient,
  votazioneId: string,
  scuolaId: string,
  errore: unknown,
  operazione: string,
): Promise<NextResponse> {
  const { error: errRipristino } = await supabase
    .from('votazioni')
    .delete()
    .eq('id', votazioneId)
    .eq('scuola_id', scuolaId)
  if (errRipristino) {
    logErrore({ operazione, stato: 500, evento: 'votazione-orfana' }, errRipristino)
    logEvento(
      'votazioni',
      'error',
      { operazione, esito: 'testata-orfana', votazione_id: votazioneId },
      errRipristino,
    )
  }
  return (
    erroreAnno(errore as { code?: string; message?: string }, operazione) ??
    rispostaErroreDbVotazioni(errore as { code?: string; message?: string }, operazione)
  )
}
