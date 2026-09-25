import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody, parseData, parseMultipart, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { statoVoci, chiaveVoce } from '@/lib/primaria/permesso-voce'
import { allegatiRegistroVivi } from '@/lib/primaria/cestino-allegati-registro'
import { ripristinabileFinoAlAllegato } from '@/lib/primaria/cestino-registro'
import {
  BUCKET_ALLEGATI_REGISTRO,
  CESTINO_ASSENTE,
  IMG_TYPES_ALLEGATO,
  MAX_PDF_ALLEGATO,
  allegatoDaGestire,
  codiceErrore,
  dataLezione,
  leggiLezione,
  percorsoAllegato,
  risposte,
  validaFileAllegato,
  type AllegatoRegistro,
} from '@/lib/primaria/allegati-registro'

/**
 * GLI ALLEGATI DI UNA LEZIONE DEL REGISTRO DELLA PRIMARIA.
 *
 *   GET    ?registroId=          — gli allegati VIVI della lezione, con link firmati a
 *                                  10' e, per ciascuno, se chi guarda può modificarlo;
 *   POST   multipart             — carica un allegato (file, registroId, ambito?);
 *   PATCH  { id, nome }          — RINOMINA (il nome mostrato, `file_name`);
 *   DELETE ?id=                  — mette l'allegato nel CESTINO per 7 giorni.
 *
 * La sostituzione del file sta in `./sostituisci`, il cestino (elenco e ripristino)
 * in `./cestino`. Le regole comuni (chi, fino a quando, i limiti del file) stanno in
 * `@/lib/primaria/allegati-registro`.
 */

const getQuerySchema = z.object({
  registroId: zUuid,
})

const postFormSchema = z.object({
  file: z.instanceof(File, { error: 'file obbligatorio' }),
  registroId: zUuid,
  ambito: z.string().default('argomento'),
})

/**
 * Il nome MOSTRATO. Si toglie lo spazio ai bordi e si rifiuta il vuoto; il tetto è
 * largo (200) ma c'è: è testo che finisce in ogni elenco del registro.
 */
const patchBodySchema = z.object({
  id: zUuid,
  nome: z
    .string()
    .trim()
    .min(1, 'Il nome non può essere vuoto')
    .max(200, 'Nome troppo lungo (al massimo 200 caratteri)'),
})

const deleteQuerySchema = z.object({
  id: zUuid,
})

// GET /api/primaria/allegati?registroId=
export const GET = withRoute('primaria/allegati:GET', async (request: NextRequest) => {
  const operazione = 'primaria/allegati:GET'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { registroId } = q.data

    const supabase = await createAdminClient()
    const { lezione, errore: lezErr } = await leggiLezione(supabase, registroId)
    if (lezErr) {
      logEvento('registro', 'error', { operazione, esito: 'lezione-non-letta', registro_id: registroId }, lezErr)
      return risposte.letturaFallita()
    }
    if (!lezione) return risposte.lezioneNonTrovata()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, lezione.section_id)
    if (scopeErr) return scopeErr

    // Solo i VIVI: un allegato nel cestino per il registro non esiste più.
    const { data, error } = await allegatiRegistroVivi(
      supabase.from('allegati_registro').select('*').eq('registro_id', registroId),
    ).order('creato_il')
    if (error) {
      logEvento('registro', 'error', { operazione, esito: 'allegati-non-letti', registro_id: registroId }, error)
      return risposte.letturaFallita()
    }
    const righe = (data ?? []) as AllegatoRegistro[]

    // Il permesso per ciascuno, in una passata sola: la UI mostra Modifica/Elimina
    // solo dove la route li accetterebbe, e «Sblocca» alla Direzione dove servono.
    const stati = await statoVoci(
      supabase,
      auth.user,
      righe.map((r) => ({
        tipo: 'allegato' as const,
        id: r.id,
        autoreId: r.caricato_da,
        sectionId: lezione.section_id,
        scuolaId: lezione.scuola_id,
        dataEvento: dataLezione(lezione),
      })),
    )
    if (!stati.ok) return risposte.letturaFallita()

    // Link firmati a 10 minuti, generati solo per chi ha superato il gate.
    // Le righe storiche con un URL completo (`http…`) restano com'erano: in
    // produzione non ce n'è nessuna, ma non si riscrive un dato che non si è
    // certi di saper interpretare.
    const conLink = await Promise.all(righe.map(async (riga) => {
      const stato = stati.esiti.get(chiaveVoce('allegato', riga.id))
      const permessi = {
        modificabile: stato?.modificabile ?? false,
        bloccata: stato?.bloccata ?? false,
        giorniLimite: stato?.giorniLimite ?? null,
      }
      const percorso = riga.file_url
      if (!percorso || percorso.startsWith('http')) return { ...riga, ...permessi }
      const { data: firmato, error: errFirma } = await supabase
        .storage.from(BUCKET_ALLEGATI_REGISTRO).createSignedUrl(percorso, 600)
      if (errFirma) {
        logEvento('storage', 'error', {
          operazione, esito: 'link-non-firmato', bucket: BUCKET_ALLEGATI_REGISTRO,
        }, errFirma)
        return { ...riga, ...permessi, file_url: null }
      }
      return { ...riga, ...permessi, file_url: firmato?.signedUrl ?? null }
    }))
    return NextResponse.json({ success: true, data: conLink })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
})

// POST /api/primaria/allegati  (multipart: file, registroId, ambito?)
export const POST = withRoute('primaria/allegati:POST', async (request: NextRequest) => {
  const operazione = 'primaria/allegati:POST'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    // Identità dal gate (sessione o header legacy), MAI dal formData:
    // il campo multipart 'userId' permetterebbe di impersonare chiunque.
    const userId = auth.user.id

    // Content-Type sbagliato = errore del CLIENT: 400, e non l'eccezione al `catch`
    // (`request.formData()` LANCIA). La regola vive in `parseMultipart`.
    const form = await parseMultipart(request)
    if ('response' in form) return form.response
    const formData = form.data
    const f = parseData(postFormSchema, {
      file: formData.get('file'),
      registroId: formData.get('registroId'),
      // formData.get restituisce null se assente: normalizza per il default zod
      ambito: formData.get('ambito') ?? undefined,
    })
    if ('response' in f) return f.response
    const { file, registroId, ambito } = f.data

    const ammesso = validaFileAllegato(file)
    if (!ammesso.ok) return ammesso.risposta

    const supabase = await createAdminClient()
    const { lezione, errore: lezErr } = await leggiLezione(supabase, registroId)
    if (lezErr) {
      logEvento('registro', 'error', { operazione, esito: 'lezione-non-letta', registro_id: registroId }, lezErr)
      return risposte.letturaFallita()
    }
    if (!lezione) return risposte.lezioneNonTrovata()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, lezione.section_id)
    if (scopeErr) return scopeErr

    // Assicura il bucket.
    try {
      const { data: buckets } = await supabase.storage.listBuckets()
      // Bucket PRIVATO. Era `public: true` e il percorso veniva salvato come
      // `getPublicUrl`: un allegato del registro — compiti, verifiche, foto di
      // lavagne con nomi di bambini — era leggibile da CHIUNQUE avesse (o
      // indovinasse) l'indirizzo, senza login e SENZA SCADENZA. Ora si serve un
      // link firmato a tempo, dietro lo stesso gate del resto della route.
      const opts = {
        public: false,
        allowedMimeTypes: ['application/pdf', ...IMG_TYPES_ALLEGATO],
        fileSizeLimit: MAX_PDF_ALLEGATO,
      }
      if (!buckets?.some((b) => b.name === BUCKET_ALLEGATI_REGISTRO)) {
        await supabase.storage.createBucket(BUCKET_ALLEGATI_REGISTRO, opts)
      } else {
        // Se esiste già ed era pubblico, `createBucket` non lo cambierebbe.
        await supabase.storage.updateBucket(BUCKET_ALLEGATI_REGISTRO, { public: false })
      }
    } catch (e) {
      // Passo idempotente di garanzia: se il bucket c'è già, l'upload qui sotto riesce
      // lo stesso e nulla è perduto. Se davvero manca, è l'upload a fallire con il suo
      // 500. Qui non si è ancora rotto niente: `warn`.
      logEvento('storage', 'warn', {
        operazione,
        bucket: BUCKET_ALLEGATI_REGISTRO,
        esito: 'bucket_non_verificato',
      }, e)
    }

    const path = percorsoAllegato(registroId, file.name)
    const buf = await file.arrayBuffer()
    const { error: upErr } = await supabase.storage.from(BUCKET_ALLEGATI_REGISTRO).upload(path, Buffer.from(buf), {
      contentType: file.type,
      upsert: true,
    })
    if (upErr) {
      logEvento('storage', 'error', { operazione, esito: 'upload-fallito', bucket: BUCKET_ALLEGATI_REGISTRO, registro_id: registroId }, upErr)
      return NextResponse.json(
        { error: 'Non è stato possibile caricare il file', codice: 'ALLEGATO_NON_CARICATO' },
        { status: 500 },
      )
    }

    // Si salva il PERCORSO, non un URL: l'indirizzo firmato viene generato al
    // momento della lettura, con scadenza breve, da chi ha superato il gate.
    const { data, error } = await supabase
      .from('allegati_registro')
      .insert({
        registro_id: registroId,
        ambito,
        tipo: ammesso.tipo,
        file_url: path,
        file_name: file.name,
        dimensione_byte: file.size,
        caricato_da: userId,
      })
      .select()
      .single()
    if (error || !data) {
      logEvento('registro', 'error', { operazione, esito: 'allegato-non-registrato', registro_id: registroId }, error)
      return risposte.scritturaFallita()
    }
    const nuovo = data as AllegatoRegistro

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'allegato',
      entitaId: nuovo.id,
      azione: 'insert',
      scuolaId: lezione.scuola_id,
      sectionId: lezione.section_id,
      valoreDopo: { id: nuovo.id, registro_id: registroId, ambito, tipo: ammesso.tipo, file_name: file.name },
    })
    logEvento('registro', 'info', {
      operazione, esito: 'allegato-caricato', allegato_id: nuovo.id, registro_id: registroId, tipo: ammesso.tipo,
    })

    return NextResponse.json({ success: true, data: nuovo }, { status: 201 })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'ALLEGATO_REGISTRO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})

// PATCH /api/primaria/allegati  { id, nome } — rinomina
export const PATCH = withRoute('primaria/allegati:PATCH', async (request: NextRequest) => {
  const operazione = 'primaria/allegati:PATCH'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const { id, nome } = b.data

    const supabase = await createAdminClient()
    const g = await allegatoDaGestire(supabase, auth.user, id, operazione)
    if (!g.ok) return g.risposta
    const { allegato, lezione } = g

    // Condizionata a «ancora vivo»: fra la lettura e qui l'allegato può essere
    // finito nel cestino (eliminato o sostituito da un'altra scheda).
    const { data: aggiornato, error } = await allegatiRegistroVivi(
      supabase.from('allegati_registro').update({ file_name: nome }).eq('id', id),
    ).select('id, registro_id, ambito, tipo, file_name, dimensione_byte, caricato_da, creato_il').maybeSingle()
    if (error) {
      logEvento('registro', 'error', { operazione, esito: 'allegato-non-rinominato', allegato_id: id }, error)
      return risposte.scritturaFallita()
    }
    if (!aggiornato) return risposte.cambiato()

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'allegato',
      entitaId: id,
      azione: 'update',
      scuolaId: lezione.scuola_id,
      sectionId: lezione.section_id,
      valorePrima: { id, file_name: allegato.file_name },
      valoreDopo: { id, file_name: nome },
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user, sectionId: lezione.section_id, scuolaId: lezione.scuola_id,
      area: 'registro', link: `/teacher/primaria/${lezione.section_id}/registro`,
    })
    logEvento('registro', 'info', { operazione, esito: 'allegato-rinominato', allegato_id: id, registro_id: lezione.id })

    return NextResponse.json({ success: true, data: aggiornato })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'ALLEGATO_REGISTRO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})

// DELETE /api/primaria/allegati?id= — nel cestino per 7 giorni
export const DELETE = withRoute('primaria/allegati:DELETE', async (request: NextRequest) => {
  const operazione = 'primaria/allegati:DELETE'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { id } = q.data

    const supabase = await createAdminClient()
    const g = await allegatoDaGestire(supabase, auth.user, id, operazione)
    if (!g.ok) return g.risposta
    const { allegato, lezione } = g

    // IL CESTINO. Il file resta nello Storage: lo toglie la purga, dopo i giorni di
    // custodia. Lo slot d'origine si scrive dalla lezione anche se il trigger
    // `trg_allegati_registro_copia_slot` l'ha già copiato all'aggancio: è lo stesso
    // valore, e un allegato nel cestino non deve dipendere dalla memoria di un
    // trigger per poter tornare alla sua lezione. Condizionato a «ancora vivo»: di
    // due «Elimina» simultanei ne passa uno.
    const adesso = new Date().toISOString()
    const { data: cestinato, error } = await allegatiRegistroVivi(
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
    if (error) {
      if (CESTINO_ASSENTE.has(codiceErrore(error))) {
        // DB NON MIGRATO (l'E2E della CI): le colonne del cestino non esistono. Non si
        // cancella «per ripiego»: l'allegato resta dov'è, e lo si dice.
        logEvento('registro', 'warn', { operazione, esito: 'cestino-allegati-non-disponibile-schema', allegato_id: id }, error)
        return risposte.cestinoNonDisponibile()
      }
      logEvento('registro', 'error', { operazione, esito: 'allegato-non-cestinato', allegato_id: id }, error)
      return risposte.scritturaFallita()
    }
    if (!cestinato) return risposte.cambiato()

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'allegato',
      entitaId: id,
      azione: 'delete',
      scuolaId: lezione.scuola_id,
      sectionId: lezione.section_id,
      valorePrima: {
        id, registro_id: allegato.registro_id, ambito: allegato.ambito, tipo: allegato.tipo,
        file_name: allegato.file_name, caricato_da: allegato.caricato_da,
      },
      valoreDopo: { id, cestino: true, eliminato_il: adesso },
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user, sectionId: lezione.section_id, scuolaId: lezione.scuola_id,
      area: 'registro', link: `/teacher/primaria/${lezione.section_id}/registro`,
    })
    logEvento('registro', 'info', { operazione, esito: 'allegato-nel-cestino', allegato_id: id, registro_id: lezione.id })

    return NextResponse.json({
      success: true,
      data: {
        id,
        eliminatoIl: adesso,
        // Il primo che scade fra custodia e conservazione (decisione del titolare del
        // 2026-09-25): un allegato caricato quasi un anno fa non resta sette giorni.
        ripristinabileFinoAl: ripristinabileFinoAlAllegato(adesso, allegato.creato_il)?.toISOString() ?? null,
      },
    })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'ALLEGATO_REGISTRO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})
