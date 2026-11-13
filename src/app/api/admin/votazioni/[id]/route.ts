import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { logScrittura } from '@/lib/audit/scrittura'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody, parseBodyFacoltativo, parseData } from '@/lib/validation/http'
import { resolveAnnoScrittura } from '@/lib/auth/scope'
import { annoDellaRiga } from '@/lib/anno/anno-della-riga'
import { erroreAnno } from '@/lib/anno/errori'
import { clientPerScrittura } from '@/lib/anno/gettone'
import type { Correzione } from '@/lib/anno/correzione'
import type { SupabaseClient } from '@supabase/supabase-js'
import { zUuid } from '@/lib/validation/common'
import { caricaVotazioneInScope, requireVotazioni } from '@/lib/votazioni/accesso'
import { genitoriDellaSede, genitoriDelleClassi, nomiGenitori } from '@/lib/votazioni/aventi-diritto'
import { contaVoti } from '@/lib/votazioni/conteggio'
import { rispostaErroreDbVotazioni } from '@/lib/votazioni/errori'
import { azioneVotazioneSchema, eliminaVotazioneSchema, scadenzaInIstante } from '@/lib/votazioni/schemi'
import { statoVotazione } from '@/lib/votazioni/stato'
import type {
  CandidatoConVoti,
  DettaglioVotazione,
  DettaglioVotazioneRisposta,
  GenitoreScheda,
  RigaChiHaVotato,
  RisultatoScheda,
} from '@/lib/votazioni/tipi'
import {
  NOME_ASSENTE,
  forma,
  idUnici,
  leggiClassi,
  leggiTutte,
  ordinaClassi,
  primoErrore,
  rifiutoVotazione,
  trovaConflitto,
} from '../condiviso'

/**
 * VOTAZIONI DEI RAPPRESENTANTI · UNA VOTAZIONE (segreteria).
 *
 * ── GET /api/admin/votazioni/[id] ────────────────────────────────────────────────────────────────────────
 * `DettaglioVotazioneRisposta`: per ogni scheda (una per classe, più l'istituto) gli aventi diritto, i votanti, i
 * candidati con i voti, gli eletti e «chi ha votato chi». Gli aventi diritto si calcolano ADESSO (`genitoriDelleClassi`
 * per le classi, `genitoriDellaSede` per l'istituto): un bambino che cambia classe sposta l'avente diritto, il
 * voto già dato resta, e `votanti` può superare `aventiDiritto`. Una classe senza genitori con account ha 0 aventi
 * diritto, 0 votanti e nessun eletto: il dettaglio si apre lo stesso.
 *
 * I NOMI vengono da `utenti` con l'account attivo: chi non c'è più compare come «—», ma il suo voto conta.
 * Se i genitori o i nomi non si riescono a leggere la risposta è 500: un elenco corto, o tutto «—», sembrerebbe
 * un risultato.
 *
 * ── PATCH /api/admin/votazioni/[id] ──────────────────────────────────────────────────────────────────────
 *  · Su un anno `chiuso` (PR 4.9) `chiudi` e `proroga` (e il DELETE) rispondono 409 `ANNO_CHIUSO` con `correzione_possibile`; con
 *    `correzione: { motivo }` nel corpo JSON (anche per il DELETE) la scrittura passa con un gettone.
 *  · `chiudi`: 409 `VOTAZIONE_CHIUSA` se è già chiusa a mano o scaduta; altrimenti `chiusa_il = adesso`. È
 *    DEFINITIVA (nessuna proroga la riapre).
 *  · `proroga`: 409 `VOTAZIONE_CHIUSA` se `chiusa_il` è valorizzato; 400 `VOTAZIONE_SCADENZA_PASSATA` se la nuova
 *    data non è futura; se la votazione era SCADUTA la proroga la riapre, e allora si rifanno i controlli di
 *    conflitto del POST (classi e istituto non già in un'altra votazione aperta), escludendo sé stessa.
 *  L'`update` porta `.is('chiusa_il', null)` e chiede indietro le righe toccate: se nel frattempo qualcuno l'ha
 *  chiusa, zero righe → 409, e la sua data di chiusura non si sovrascrive. Risponde 200 `{ ok: true }`.
 *
 * ── DELETE /api/admin/votazioni/[id] ─────────────────────────────────────────────────────────────────────
 * 409 `VOTAZIONE_CON_VOTI` se esiste anche un solo voto; altrimenti elimina (id E sede; le figlie cadono in
 * cascata) e risponde 200 `{ ok: true }`. Se i voti non si riescono a leggere NON si elimina: 500.
 * ⚠️ Fra il controllo e la cancellazione un voto potrebbe arrivare, e cadrebbe in cascata con la testata: la
 * finestra è di millisecondi su una votazione che non ha ancora un voto.
 *
 * Ogni scrittura lascia l'audit (senza il titolo) e un battito di successo `{ operazione, esito, votazione_id }`.
 */

const paramsSchema = z.object({ id: zUuid })
type Contesto = { params: Promise<{ id: string }> }

/**
 * Con quale client si scrive su una votazione GIÀ ESISTENTE (chiudi, proroga, elimina). L'anno è quello della testata (`anno_id`): si
 * dichiara a `resolveAnnoScrittura`, che su un anno `chiuso` risponde 409 `ANNO_CHIUSO` con `correzione_possibile` (la schermata apre
 * il dialogo) o, con la `correzione`, crea il gettone (UNO: l'`update` o il `delete` è una sola transazione, e le figlie in cascata
 * sono in modo `madre`). Anno corrente, testata senza `anno_id` o database senza lo schema dell'anno: il client di prima.
 * Va chiamata DOPO i rifiuti «a occhio»: una richiesta che si rifiuta non crea gettoni.
 */
async function clientPerVotazione(
  request: NextRequest,
  supabase: SupabaseClient,
  user: Parameters<typeof resolveAnnoScrittura>[2],
  v: { id: string; scuola_id: string },
  correzione: Correzione | undefined,
  guasto: (errore: unknown) => NextResponse,
): Promise<{ scrittura: SupabaseClient } | { response: NextResponse }> {
  const daAnno = await annoDellaRiga(supabase, 'votazioni', v.id)
  if ('guasto' in daAnno) return { response: guasto(daAnno.guasto) }
  if (!daAnno.annoId) return { scrittura: supabase }
  const esito = await resolveAnnoScrittura(request, supabase, user, v.scuola_id, { dichiarato: daAnno.annoId, correzione })
  if (esito instanceof NextResponse) return { response: esito }
  return { scrittura: await clientPerScrittura(supabase, esito) }
}

type RigaVoto = {
  id: string
  ambito: 'classe' | 'istituto'
  section_id: string | null
  elettore_id: string
  candidato_id: string
  votato_il: string
  aggiornato_il: string | null
}

/** Prima i nomi veri (per cognome e nome), poi gli «—»; a parità l'id. Deterministico. */
function confrontaNomi(nomeA: string, idA: string, nomeB: string, idB: string): number {
  const assenteA = nomeA === NOME_ASSENTE
  const assenteB = nomeB === NOME_ASSENTE
  if (assenteA !== assenteB) return assenteA ? 1 : -1
  return nomeA.localeCompare(nomeB, 'it') || (idA < idB ? -1 : idA > idB ? 1 : 0)
}

export const GET = withRoute('admin/votazioni/[id]:GET', async (request: NextRequest, ctx: Contesto) => {
  const auth = await requireVotazioni(request)
  if (auth.response) return auth.response

  const p = parseData(paramsSchema, await ctx.params)
  if ('response' in p) return p.response

  const operazione = 'admin/votazioni/[id]:GET'
  const guasto = (errore: unknown) => rispostaErroreDbVotazioni(errore as { code?: string; message?: string }, operazione)

  const supabase = await createAdminClient()
  const caricata = await caricaVotazioneInScope(supabase, auth.user, p.data.id)
  if ('response' in caricata) return caricata.response
  const v = caricata.votazione
  const scuolaId = v.scuola_id

  // 1. Quello che la votazione ha scritto: classi, candidati (se c'è l'istituto), voti, sede.
  const [classiLette, candidatiLetti, votiLetti, sedeLetta] = await Promise.all([
    leggiTutte<{ votazione_id: string; section_id: string }>(
      'votazioni-classi',
      () =>
        supabase
          .from('votazioni_classi')
          .select('votazione_id, section_id')
          .eq('votazione_id', v.id)
          .eq('scuola_id', scuolaId),
      ['votazione_id', 'section_id'],
    ),
    v.rappresentante_istituto
      ? leggiTutte<{ votazione_id: string; utente_id: string }>(
          'votazioni-candidati',
          () =>
            supabase
              .from('votazioni_candidati')
              .select('votazione_id, utente_id')
              .eq('votazione_id', v.id)
              .eq('scuola_id', scuolaId),
          ['votazione_id', 'utente_id'],
        )
      : Promise.resolve({ ok: true as const, valore: [] as { votazione_id: string; utente_id: string }[] }),
    leggiTutte<RigaVoto>('votazioni-voti', () =>
      supabase
        .from('votazioni_voti')
        .select('id, ambito, section_id, elettore_id, candidato_id, votato_il, aggiornato_il')
        .eq('votazione_id', v.id)
        .eq('scuola_id', scuolaId),
    ),
    v.rappresentante_istituto
      ? supabase.from('schools').select('nome').eq('id', scuolaId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  const errore = primoErrore([classiLette, candidatiLetti, votiLetti])
  if (errore !== null) return guasto(errore)
  if (sedeLetta.error) return guasto(sedeLetta.error)
  // I tre `ok` sono veri: `primoErrore` ha già risposto per gli altri. Il controllo serve al compilatore.
  if (!classiLette.ok || !candidatiLetti.ok || !votiLetti.ok) return guasto(new Error('votazioni:lettura-non-riuscita'))

  const sectionIds = idUnici(classiLette.valore.map((c) => c.section_id))
  const candidatiIds = idUnici(candidatiLetti.valore.map((c) => c.utente_id))
  const voti = votiLetti.valore
  const nomeSede = (sedeLetta.data as { nome?: unknown } | null)?.nome
  const nomeIstituto = typeof nomeSede === 'string' && nomeSede.trim() !== '' ? nomeSede : NOME_ASSENTE

  // 2. Le classi (nome, grado), gli aventi diritto di oggi e i nomi di chi compare.
  const [classi, aventiClassi, aventiSede, nomi] = await Promise.all([
    leggiClassi(supabase, [scuolaId], sectionIds),
    genitoriDelleClassi(supabase, scuolaId, sectionIds),
    v.rappresentante_istituto ? genitoriDellaSede(supabase, scuolaId) : Promise.resolve(null),
    nomiGenitori(supabase, [...voti.flatMap((r) => [r.elettore_id, r.candidato_id]), ...candidatiIds]),
  ])
  if (!classi.ok) return guasto(classi.errore)
  // Un avente diritto letto a metà sarebbe un numero sbagliato con l'aria di essere giusto.
  if (!aventiClassi.completo) return guasto(aventiClassi.errore)
  if (aventiSede && !aventiSede.completo) return guasto(aventiSede.errore)
  if (!nomi.completo) return guasto(nomi.errore)

  const nomePer = new Map<string, string>(nomi.valore.map((g) => [forma(g.utenteId), g.nome]))
  const nomeDi = (utenteId: string) => nomePer.get(forma(utenteId)) ?? NOME_ASSENTE

  // 3. Una scheda per ogni risultato.
  const costruisciScheda = (
    ambito: 'classe' | 'istituto',
    sectionId: string | null,
    nome: string,
    aventiDiritto: number,
    votiScheda: RigaVoto[],
    candidatiAZero: string[],
  ): RisultatoScheda => {
    const { conteggi, eletti } = contaVoti(
      votiScheda.map((r) => ({ candidatoId: r.candidato_id })),
      candidatiAZero,
    )
    const candidati: CandidatoConVoti[] = conteggi
      .map((c) => ({ utenteId: c.utenteId, nome: nomeDi(c.utenteId), voti: c.voti }))
      .sort((a, b) => b.voti - a.voti || confrontaNomi(a.nome, a.utenteId, b.nome, b.utenteId))
    const elettiInOrdine = candidati.filter((c) => eletti.includes(c.utenteId)).map((c) => c.utenteId)
    const chiHaVotato: RigaChiHaVotato[] = votiScheda
      .map((r) => ({
        elettoreId: r.elettore_id,
        elettoreNome: nomeDi(r.elettore_id),
        candidatoId: r.candidato_id,
        candidatoNome: nomeDi(r.candidato_id),
        votatoIl: r.votato_il,
        aggiornatoIl: r.aggiornato_il ?? null,
      }))
      .sort((a, b) => confrontaNomi(a.elettoreNome, a.elettoreId, b.elettoreNome, b.elettoreId))
    return {
      ambito,
      sectionId,
      nome,
      aventiDiritto,
      votanti: new Set(votiScheda.map((r) => forma(r.elettore_id))).size,
      candidati,
      eletti: elettiInOrdine,
      voti: chiHaVotato,
    }
  }

  const classiOrdinate = ordinaClassi(
    sectionIds.flatMap((s) => {
      const c = classi.valore.get(forma(s))
      return c ? [c] : []
    }),
  )
  const schede: RisultatoScheda[] = classiOrdinate.map((c) =>
    costruisciScheda(
      'classe',
      c.sectionId,
      c.nome,
      aventiClassi.valore.get(forma(c.sectionId))?.length ?? 0,
      voti.filter((r) => r.ambito === 'classe' && r.section_id !== null && forma(r.section_id) === forma(c.sectionId)),
      [],
    ),
  )

  let candidatiIstituto: GenitoreScheda[] = []
  if (v.rappresentante_istituto) {
    candidatiIstituto = candidatiIds
      .map((id) => ({ utenteId: id, nome: nomeDi(id) }))
      .sort((a, b) => confrontaNomi(a.nome, a.utenteId, b.nome, b.utenteId))
    schede.push(
      costruisciScheda(
        'istituto',
        null,
        nomeIstituto,
        aventiSede?.valore.length ?? 0,
        voti.filter((r) => r.ambito === 'istituto'),
        candidatiIds,
      ),
    )
  }

  const votazione: DettaglioVotazione = {
    id: v.id,
    scuolaId,
    titolo: v.titolo,
    scadenza: v.scadenza,
    chiusaIl: v.chiusa_il,
    stato: statoVotazione({ scadenza: v.scadenza, chiusaIl: v.chiusa_il }),
    rappresentanteIstituto: v.rappresentante_istituto,
    classi: classiOrdinate,
    votanti: new Set(voti.map((r) => forma(r.elettore_id))).size,
    creataIl: v.creata_il,
    candidatiIstituto,
    schede,
  }
  const corpo: DettaglioVotazioneRisposta = { votazione }
  return NextResponse.json(corpo)
})

export const PATCH = withRoute('admin/votazioni/[id]:PATCH', async (request: NextRequest, ctx: Contesto) => {
  const auth = await requireVotazioni(request)
  if (auth.response) return auth.response

  const p = parseData(paramsSchema, await ctx.params)
  if ('response' in p) return p.response
  const body = await parseBody(request, azioneVotazioneSchema)
  if ('response' in body) return body.response

  const operazione = 'admin/votazioni/[id]:PATCH'
  const guasto = (errore: unknown) => rispostaErroreDbVotazioni(errore as { code?: string; message?: string }, operazione)

  const supabase = await createAdminClient()
  const caricata = await caricaVotazioneInScope(supabase, auth.user, p.data.id)
  if ('response' in caricata) return caricata.response
  const v = caricata.votazione
  const scuolaId = v.scuola_id
  const adesso = new Date()
  const adessoIso = adesso.toISOString()

  // Il verdetto vero lo dà l'`update` qui sotto (guardato da `chiusa_il IS NULL`): questi sono i rifiuti «a occhio»,
  // con la risposta giusta prima di toccare qualunque riga.
  const azione = body.data
  let patch: Record<string, string>
  let esito: 'chiusa' | 'prorogata' | 'riaperta'

  if (azione.azione === 'chiudi') {
    if (statoVotazione({ scadenza: v.scadenza, chiusaIl: v.chiusa_il }, adesso) === 'chiusa') {
      return rifiutoVotazione('VOTAZIONE_CHIUSA')
    }
    patch = { chiusa_il: adessoIso, aggiornata_da: auth.user.id, aggiornata_il: adessoIso }
    esito = 'chiusa'
  } else {
    // La chiusura a mano è definitiva: la proroga non la annulla.
    if (v.chiusa_il !== null) return rifiutoVotazione('VOTAZIONE_CHIUSA')
    const nuova = scadenzaInIstante(azione.scadenza)
    if (nuova === null || Date.parse(nuova) <= adesso.getTime()) {
      return rifiutoVotazione('VOTAZIONE_SCADENZA_PASSATA')
    }
    const eraScaduta = statoVotazione({ scadenza: v.scadenza, chiusaIl: v.chiusa_il }, adesso) === 'chiusa'
    if (eraScaduta) {
      // Riaprirla la rimette fra le votazioni aperte della sede: stessi controlli del POST, senza sé stessa.
      const classiLette = await leggiTutte<{ votazione_id: string; section_id: string }>(
        'votazioni-classi',
        () =>
          supabase
            .from('votazioni_classi')
            .select('votazione_id, section_id')
            .eq('votazione_id', v.id)
            .eq('scuola_id', scuolaId),
        ['votazione_id', 'section_id'],
      )
      if (!classiLette.ok) return guasto(classiLette.errore)
      const conflitto = await trovaConflitto(
        supabase,
        scuolaId,
        classiLette.valore.map((c) => c.section_id),
        v.rappresentante_istituto,
        v.id,
      )
      if (!conflitto.ok) return guasto(conflitto.errore)
      if (conflitto.valore === 'classe') return rifiutoVotazione('VOTAZIONE_CLASSE_GIA_APERTA')
      if (conflitto.valore === 'istituto') return rifiutoVotazione('VOTAZIONE_ISTITUTO_GIA_APERTA')
    }
    patch = { scadenza: nuova, aggiornata_da: auth.user.id, aggiornata_il: adessoIso }
    esito = eraScaduta ? 'riaperta' : 'prorogata'
  }

  const dove = await clientPerVotazione(request, supabase, auth.user, v, azione.correzione, guasto)
  if ('response' in dove) return dove.response
  const { data: toccate, error } = await dove.scrittura
    .from('votazioni')
    .update(patch)
    .eq('id', v.id)
    .eq('scuola_id', scuolaId)
    .is('chiusa_il', null)
    .select('id')
  if (error) return erroreAnno(error, operazione) ?? guasto(error)
  // Zero righe: qualcuno l'ha chiusa fra la lettura e la scrittura. La sua data di chiusura resta com'è.
  if (!toccate || toccate.length === 0) return rifiutoVotazione('VOTAZIONE_CHIUSA')

  await logScrittura(supabase, {
    attore: auth.user,
    entitaTipo: 'votazione',
    entitaId: v.id,
    azione: 'update',
    scuolaId,
    valorePrima: { scadenza: v.scadenza, chiusa_il: v.chiusa_il },
    valoreDopo: {
      scadenza: patch.scadenza ?? v.scadenza,
      chiusa_il: patch.chiusa_il ?? v.chiusa_il,
    },
  })
  logEvento('votazioni', 'info', {
    operazione: azione.azione,
    esito,
    votazione_id: v.id,
  })
  return NextResponse.json({ ok: true })
})

export const DELETE = withRoute('admin/votazioni/[id]:DELETE', async (request: NextRequest, ctx: Contesto) => {
  const auth = await requireVotazioni(request)
  if (auth.response) return auth.response

  const p = parseData(paramsSchema, await ctx.params)
  if ('response' in p) return p.response
  const corpoElimina = await parseBodyFacoltativo(request, eliminaVotazioneSchema)
  if ('response' in corpoElimina) return corpoElimina.response

  const operazione = 'admin/votazioni/[id]:DELETE'
  const guasto = (errore: unknown) => rispostaErroreDbVotazioni(errore as { code?: string; message?: string }, operazione)

  const supabase = await createAdminClient()
  const caricata = await caricaVotazioneInScope(supabase, auth.user, p.data.id)
  if ('response' in caricata) return caricata.response
  const v = caricata.votazione
  const scuolaId = v.scuola_id

  // Anche UN solo voto la rende non eliminabile. Un guasto nel leggerli NON vale «nessun voto»: si ferma.
  const { data: conVoti, error: errVoti } = await supabase
    .from('votazioni_voti')
    .select('id')
    .eq('votazione_id', v.id)
    .eq('scuola_id', scuolaId)
    .limit(1)
  if (errVoti) return guasto(errVoti)
  if ((conVoti ?? []).length > 0) return rifiutoVotazione('VOTAZIONE_CON_VOTI')

  const dove = await clientPerVotazione(request, supabase, auth.user, v, corpoElimina.data.correzione, guasto)
  if ('response' in dove) return dove.response
  const { data: tolte, error } = await dove.scrittura
    .from('votazioni')
    .delete()
    .eq('id', v.id)
    .eq('scuola_id', scuolaId)
    .select('id')
  if (error) return erroreAnno(error, operazione) ?? guasto(error)
  // Zero righe: qualcun altro l'ha eliminata fra la lettura e la cancellazione.
  if (!tolte || tolte.length === 0) return rifiutoVotazione('VOTAZIONE_NON_TROVATA')

  await logScrittura(supabase, {
    attore: auth.user,
    entitaTipo: 'votazione',
    entitaId: v.id,
    azione: 'delete',
    scuolaId,
    valorePrima: { scadenza: v.scadenza, chiusa_il: v.chiusa_il, istituto: v.rappresentante_istituto },
  })
  logEvento('votazioni', 'info', { operazione: 'elimina', esito: 'eliminata', votazione_id: v.id })
  return NextResponse.json({ ok: true })
})
