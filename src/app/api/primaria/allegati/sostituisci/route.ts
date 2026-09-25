import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { parseData, parseMultipart } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { allegatiRegistroNelCestino, allegatiRegistroVivi } from '@/lib/primaria/cestino-allegati-registro'
import { scadenzaCestino } from '@/lib/primaria/cestino-registro'
import {
  BUCKET_ALLEGATI_REGISTRO,
  CESTINO_ASSENTE,
  allegatoDaGestire,
  codiceErrore,
  dataLezione,
  percorsoAllegato,
  risposte,
  validaFileAllegato,
} from '@/lib/primaria/allegati-registro'

/**
 * POST /api/primaria/allegati/sostituisci  (multipart: id, file)
 *
 * SOSTITUISCE il file di un allegato del registro (spec 2026-09-24, «Decisioni
 * aggiunte»: «File sostituito → il vecchio va nel cestino per 7 giorni»). Il file
 * nuovo nasce in una RIGA NUOVA sulla STESSA lezione, con lo stesso `ambito`; la riga
 * vecchia va nel CESTINO col suo file, ripristinabile per i giorni di custodia.
 * Ripristinarla la riaggiunge ACCANTO alla nuova, non al suo posto.
 *
 * ─── L'ORDINE DEI PASSI, E PERCHÉ ───────────────────────────────────────────
 *  1. validazione del file, poi riga viva + lezione + classe + permesso sulla voce
 *     (autore o staff, termine sulla data della lezione) — niente è ancora cambiato;
 *  2. upload del file nuovo a un percorso NUOVO (mai sovrascrivere: il vecchio file è
 *     ciò che il cestino promette di custodire);
 *  3. la riga vecchia va nel cestino con un UPDATE condizionato a `eliminato_il IS
 *     NULL`: è la PRESA. Di due sostituzioni simultanee ne passa una; l'altra riceve
 *     409 e il suo file appena caricato viene tolto — altrimenti nascerebbero due
 *     copie «nuove» dello stesso allegato;
 *  4. insert della riga nuova. Se fallisce si COMPENSA: la vecchia torna viva e il
 *     file nuovo esce dal bucket. La lezione resta com'era, e lo si dice.
 */

const formSchema = z.object({
  id: zUuid,
  file: z.instanceof(File, { error: 'file obbligatorio' }),
})

const OP = 'primaria/allegati/sostituisci:POST'

/** Toglie dal bucket il file appena caricato. Un fallimento si LOGGA: sarebbe un file orfano. */
async function togliFileCaricato(supabase: SupabaseClient, percorso: string, allegatoId: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(BUCKET_ALLEGATI_REGISTRO).remove([percorso])
    if (error) {
      logEvento('storage', 'error', { operazione: OP, esito: 'file-nuovo-orfano', bucket: BUCKET_ALLEGATI_REGISTRO, allegato_id: allegatoId }, error)
    }
  } catch (e) {
    logEvento('storage', 'error', { operazione: OP, esito: 'file-nuovo-orfano', bucket: BUCKET_ALLEGATI_REGISTRO, allegato_id: allegatoId }, e)
  }
}

export const POST = withRoute('primaria/allegati/sostituisci:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const form = await parseMultipart(request)
    if ('response' in form) return form.response
    const parsed = parseData(formSchema, { id: form.data.get('id'), file: form.data.get('file') })
    if ('response' in parsed) return parsed.response
    const { id, file } = parsed.data

    const ammesso = validaFileAllegato(file)
    if (!ammesso.ok) return ammesso.risposta

    const supabase = await createAdminClient()

    // ── 1. La riga VIVA, la sua lezione, la classe, il permesso ───────────────
    const g = await allegatoDaGestire(supabase, auth.user, id, OP)
    if (!g.ok) return g.risposta
    const { allegato: vecchio, lezione } = g
    const registroId = lezione.id

    // ── 2. Il file nuovo, a un percorso nuovo ───────────────────────────────
    const percorso = percorsoAllegato(registroId, file.name)
    const { error: erroreUpload } = await supabase.storage
      .from(BUCKET_ALLEGATI_REGISTRO)
      .upload(percorso, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false })
    if (erroreUpload) {
      logEvento('storage', 'error', { operazione: OP, esito: 'upload-fallito', bucket: BUCKET_ALLEGATI_REGISTRO, allegato_id: id }, erroreUpload)
      return NextResponse.json(
        { error: 'Non è stato possibile caricare il file', codice: 'ALLEGATO_NON_CARICATO' },
        { status: 500 },
      )
    }

    // ── 3. La PRESA: la riga vecchia nel cestino, solo se è ancora viva ─────
    const adesso = new Date().toISOString()
    const { data: presa, error: errorePresa } = await allegatiRegistroVivi(
      supabase
        .from('allegati_registro')
        .update({
          eliminato_il: adesso,
          eliminato_da: auth.user.id,
          slot_section_id: lezione.section_id,
          slot_data: dataLezione(lezione),
          slot_ora_lezione: lezione.ora_lezione,
        })
        .eq('id', id),
    ).select('id').maybeSingle()
    if (errorePresa || !presa) {
      await togliFileCaricato(supabase, percorso, id)
      if (errorePresa) {
        if (CESTINO_ASSENTE.has(codiceErrore(errorePresa))) {
          logEvento('registro', 'warn', { operazione: OP, esito: 'cestino-allegati-non-disponibile-schema', allegato_id: id }, errorePresa)
          return risposte.cestinoNonDisponibile()
        }
        logEvento('registro', 'error', { operazione: OP, esito: 'allegato-vecchio-non-cestinato', allegato_id: id }, errorePresa)
        return risposte.scritturaFallita()
      }
      return risposte.cambiato()
    }

    // ── 4. La riga nuova, sulla stessa lezione e con lo stesso ambito ────────
    const { data: nuovo, error: erroreInsert } = await supabase
      .from('allegati_registro')
      .insert({
        registro_id: registroId,
        ambito: vecchio.ambito ?? 'argomento',
        tipo: ammesso.tipo,
        file_url: percorso,
        file_name: file.name,
        dimensione_byte: file.size,
        caricato_da: auth.user.id,
      })
      .select('id, registro_id, ambito, tipo, file_url, file_name, dimensione_byte, caricato_da, creato_il')
      .single()
    if (erroreInsert || !nuovo) {
      logEvento('registro', 'error', { operazione: OP, esito: 'allegato-nuovo-non-registrato', allegato_id: id }, erroreInsert ?? undefined)
      // COMPENSAZIONE: la vecchia torna viva (solo se è ancora la NOSTRA presa) e il
      // file nuovo esce dal bucket. Se anche questo fallisce l'allegato resta nel
      // cestino, ripristinabile a mano: lo si dice a livello `error`.
      const { data: tornata, error: erroreRitorno } = await allegatiRegistroNelCestino(
        supabase
          .from('allegati_registro')
          .update({ eliminato_il: null, eliminato_da: null })
          .eq('id', id)
          .eq('eliminato_il', adesso),
      ).select('id').maybeSingle()
      if (erroreRitorno || !tornata) {
        logEvento(
          'registro',
          'error',
          { operazione: OP, esito: 'compensazione-fallita-allegato-nel-cestino', allegato_id: id },
          erroreRitorno ?? undefined,
        )
      }
      await togliFileCaricato(supabase, percorso, id)
      return risposte.scritturaFallita()
    }
    const nuovoId = (nuovo as { id: string }).id

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'allegato',
      entitaId: nuovoId,
      azione: 'insert',
      scuolaId: lezione.scuola_id,
      sectionId: lezione.section_id,
      valoreDopo: { id: nuovoId, registro_id: registroId, tipo: ammesso.tipo, file_name: file.name, sostituisce: id },
    })
    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'allegato',
      entitaId: id,
      azione: 'delete',
      scuolaId: lezione.scuola_id,
      sectionId: lezione.section_id,
      valorePrima: { id, registro_id: registroId, tipo: vecchio.tipo, file_name: vecchio.file_name },
      valoreDopo: { id, cestino: true, eliminato_il: adesso, sostituito_da: nuovoId },
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user, sectionId: lezione.section_id, scuolaId: lezione.scuola_id,
      area: 'registro', link: `/teacher/primaria/${lezione.section_id}/registro`,
    })
    logEvento('registro', 'info', {
      operazione: OP, esito: 'allegato-sostituito', allegato_id: id, nuovo_id: nuovoId, registro_id: registroId,
    })

    return NextResponse.json(
      {
        success: true,
        data: nuovo,
        sostituito: { id, eliminatoIl: adesso, ripristinabileFinoAl: scadenzaCestino(adesso)?.toISOString() ?? null },
      },
      { status: 201 },
    )
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'ALLEGATO_REGISTRO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})
