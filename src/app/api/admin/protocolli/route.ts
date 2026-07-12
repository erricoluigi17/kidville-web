import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid, zDataYMD, zPaginazione } from '@/lib/validation/common'
import { annoFiscale } from '@/lib/format/fiscal-date'
import {
  MIME_AMMESSI,
  PROTOCOLLO_BUCKET,
  PROTOCOLLO_MAX_BYTES,
  PROTOCOLLO_MAX_MB,
  SCHEMA_MANCANTE,
  registraProtocollo,
  type AllegatoInput,
} from '@/lib/protocolli/store'
import { immagineInPdf } from '@/lib/protocolli/timbro'
import {
  denominazioneScuola,
  eliminaStagingBestEffort,
  firmaDownload,
  pareUnPdf,
  rispostaErroreProtocollo,
  scaricaProtocolloBytes,
  zStagingPath,
} from '@/lib/protocolli/server'

// Registro protocolli (spec docs/superpowers/specs/2026-07-12-registro-protocolli-design.md).
// Gate: SOLO admin + segreteria (decisione utente); DELETE solo admin, senza
// alcuna traccia (decisioni #2/#6). Registrazioni immutabili: il PATCH tocca
// solo note/categoria/collegamento o esegue l'annullamento a norma art. 54
// (il trigger WORM a DB fa da rete di sicurezza).

const GATE: ('admin' | 'segreteria')[] = ['admin', 'segreteria']

/** '' / null / assente → undefined (i form inviano stringhe vuote). */
const zOpzionale = <S extends z.ZodType>(schema: S) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional())

const zTipo = z.enum(['ingresso', 'uscita', 'interno'])
const zMime = z.enum(MIME_AMMESSI)

const STATS_VUOTE = { totale: 0, ingresso: 0, uscita: 0, interno: 0, annullate: 0, ultimoNumero: 0 }

const SELECT_LISTA =
  '*, categoria:protocolli_categorie(id,nome), allegati:protocolli_allegati(id,nome,mime,size,ordine)'

// ─── GET: lista con filtri (default anno corrente) o dettaglio con ?id= ───────
const getQuerySchema = z.object({
  id: zOpzionale(zUuid),
  anno: zOpzionale(z.coerce.number().int().min(2000).max(2100)),
  tipo: zOpzionale(zTipo),
  categoria_id: zOpzionale(zUuid),
  da: zOpzionale(zDataYMD),
  a: zOpzionale(zDataYMD),
  q: zOpzionale(z.string().max(200)),
  ...zPaginazione.shape,
})

export async function GET(request: NextRequest) {
  try {
    const auth = await requireStaff(request, GATE)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    if (sedi.length === 0) {
      return NextResponse.json({ success: true, data: [], stats: STATS_VUOTE })
    }

    // Dettaglio singolo (scheda): registrazione + collegamenti nei due sensi.
    if (q.data.id) {
      const { data, error } = await supabase
        .from('protocolli')
        .select(SELECT_LISTA)
        .eq('id', q.data.id)
        .in('scuola_id', sedi)
        .maybeSingle()
      if (error) {
        if (SCHEMA_MANCANTE.has(error.code ?? '')) {
          return NextResponse.json({ success: true, data: null, nonMigrato: true })
        }
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      if (!data) {
        return NextResponse.json({ error: 'Registrazione non trovata' }, { status: 404 })
      }
      const record = data as Record<string, unknown>
      const RIF = 'id, anno, numero, tipo, oggetto'
      let collegato: unknown = null
      if (record.collegato_a_id) {
        const r = await supabase
          .from('protocolli')
          .select(RIF)
          .eq('id', record.collegato_a_id as string)
          .maybeSingle()
        collegato = r.data ?? null
      }
      const risposte = await supabase
        .from('protocolli')
        .select(RIF)
        .eq('collegato_a_id', record.id as string)
        .order('numero', { ascending: true })
      return NextResponse.json({
        success: true,
        data: { ...record, collegato, risposte: risposte.data ?? [] },
      })
    }

    const anno = q.data.anno ?? annoFiscale()
    let query = supabase
      .from('protocolli')
      .select(SELECT_LISTA)
      .in('scuola_id', sedi)
      .eq('anno', anno)
      .order('numero', { ascending: false })
      .range(q.data.offset, q.data.offset + q.data.limit - 1)
    if (q.data.tipo) query = query.eq('tipo', q.data.tipo)
    if (q.data.categoria_id) query = query.eq('categoria_id', q.data.categoria_id)
    // Confini giornata in UTC: approssimazione accettata (±2h su registrazioni notturne).
    if (q.data.da) query = query.gte('data_registrazione', `${q.data.da}T00:00:00`)
    if (q.data.a) query = query.lte('data_registrazione', `${q.data.a}T23:59:59.999`)
    if (q.data.q) {
      // Niente virgole/parentesi/percento nel filtro .or() (sintassi PostgREST).
      const testo = q.data.q.replace(/[,()%]/g, ' ').trim()
      if (testo) {
        const like = `%${testo}%`
        const condizioni = [
          `oggetto.ilike.${like}`,
          `mittente.ilike.${like}`,
          `destinatario.ilike.${like}`,
        ]
        if (/^\d+$/.test(testo)) condizioni.push(`numero.eq.${Number(testo)}`)
        query = query.or(condizioni.join(','))
      }
    }

    const { data, error } = await query
    if (error) {
      // DB E2E CI mai migrato: la pagina deve rendere l'empty-state, mai 500.
      if (SCHEMA_MANCANTE.has(error.code ?? '')) {
        return NextResponse.json({ success: true, data: [], stats: STATS_VUOTE, nonMigrato: true })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Contatori dell'anno (solo in prima pagina: alimentano le StatCard).
    let stats: typeof STATS_VUOTE | undefined
    if (q.data.offset === 0) {
      const { data: righe, error: eStats } = await supabase
        .from('protocolli')
        .select('tipo, numero, annullata_at')
        .in('scuola_id', sedi)
        .eq('anno', anno)
        .order('numero', { ascending: false })
        .limit(10000)
      if (!eStats && Array.isArray(righe)) {
        const r = righe as { tipo: string; numero: number; annullata_at: string | null }[]
        stats = {
          totale: r.length,
          ingresso: r.filter((x) => x.tipo === 'ingresso').length,
          uscita: r.filter((x) => x.tipo === 'uscita').length,
          interno: r.filter((x) => x.tipo === 'interno').length,
          annullate: r.filter((x) => x.annullata_at != null).length,
          ultimoNumero: r[0]?.numero ?? 0,
        }
      }
    }

    return NextResponse.json({ success: true, data: data ?? [], stats, anno })
  } catch (err) {
    console.error('Errore API GET protocolli:', err)
    return rispostaErroreProtocollo(err)
  }
}

// ─── POST: registrazione di protocollo ────────────────────────────────────────
const postBodySchema = z
  .object({
    scuola_id: zOpzionale(zUuid),
    stagingPath: zStagingPath,
    nomeFile: z.string().min(1).max(200),
    mime: zMime,
    tipo: zTipo,
    oggetto: z.string({ error: "L'oggetto è obbligatorio" }).trim().min(1).max(500),
    mittente: zOpzionale(z.string().max(300)),
    destinatario: zOpzionale(z.string().max(300)),
    mezzo: zOpzionale(z.string().max(100)),
    rifProtMittente: zOpzionale(z.string().max(60)),
    rifDataMittente: zOpzionale(zDataYMD),
    categoriaId: zOpzionale(zUuid),
    collegatoAId: zOpzionale(zUuid),
    noteInterne: zOpzionale(z.string().max(2000)),
    emergenza: z.boolean().optional(),
    emergenzaDichiarataIl: zOpzionale(z.string().max(40)),
    allegatiDescrizione: zOpzionale(z.string().max(500)),
    allegati: z
      .array(
        z.object({
          stagingPath: zStagingPath,
          nome: z.string().min(1).max(200),
          mime: zMime,
        })
      )
      .max(10)
      .default([]),
  })
  .superRefine((v, ctx) => {
    if (v.tipo === 'ingresso' && !v.mittente) {
      ctx.addIssue({
        code: 'custom',
        path: ['mittente'],
        message: 'Il mittente è obbligatorio per i documenti in ingresso (art. 53)',
      })
    }
    if (v.tipo === 'uscita' && !v.destinatario) {
      ctx.addIssue({
        code: 'custom',
        path: ['destinatario'],
        message: 'Il destinatario è obbligatorio per i documenti in uscita (art. 53)',
      })
    }
    if (v.emergenza && !v.emergenzaDichiarataIl) {
      ctx.addIssue({
        code: 'custom',
        path: ['emergenzaDichiarataIl'],
        message: "Indicare data e ora dell'evento per il registro di emergenza",
      })
    }
  })

export async function POST(request: NextRequest) {
  try {
    const auth = await requireStaff(request, GATE)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sw = await resolveScuolaScrittura(request, supabase, auth.user, body.scuola_id)
    if (sw.response) return sw.response
    if (!sw.scuolaId) {
      return NextResponse.json({ error: 'Sede non risolta' }, { status: 400 })
    }
    const scuolaId = sw.scuolaId

    const bytesOriginale = await scaricaProtocolloBytes(supabase, body.stagingPath)
    if (bytesOriginale.byteLength > PROTOCOLLO_MAX_BYTES) {
      return NextResponse.json(
        { error: `File troppo grande (max ${PROTOCOLLO_MAX_MB} MB)` },
        { status: 400 }
      )
    }

    // La conversione avviene SEMPRE server-side (mai fidarsi di un PDF "già
    // convertito" dal client): PDF → verifica magic bytes; immagine → wrap A4.
    let pdfDaTimbrare: Uint8Array
    if (body.mime === 'application/pdf') {
      if (!pareUnPdf(bytesOriginale)) {
        return NextResponse.json({ error: 'Il file non è un PDF valido' }, { status: 400 })
      }
      pdfDaTimbrare = bytesOriginale
    } else {
      pdfDaTimbrare = await immagineInPdf(bytesOriginale, body.mime)
    }

    const allegati: AllegatoInput[] = []
    for (const a of body.allegati) {
      const bytes = await scaricaProtocolloBytes(supabase, a.stagingPath)
      if (bytes.byteLength > PROTOCOLLO_MAX_BYTES) {
        return NextResponse.json(
          { error: `Allegato "${a.nome}" troppo grande (max ${PROTOCOLLO_MAX_MB} MB)` },
          { status: 400 }
        )
      }
      allegati.push({ bytes, nome: a.nome, mime: a.mime })
    }

    const denominazione = await denominazioneScuola(supabase, scuolaId)
    const esito = await registraProtocollo(supabase, {
      scuolaId,
      denominazione,
      tipo: body.tipo,
      oggetto: body.oggetto,
      mittente: body.mittente ?? null,
      destinatario: body.destinatario ?? null,
      mezzo: body.mezzo ?? null,
      rifProtMittente: body.rifProtMittente ?? null,
      rifDataMittente: body.rifDataMittente ?? null,
      categoriaId: body.categoriaId ?? null,
      collegatoAId: body.collegatoAId ?? null,
      noteInterne: body.noteInterne ?? null,
      emergenza: body.emergenza ?? false,
      emergenzaDichiarataIl: body.emergenzaDichiarataIl ?? null,
      allegatiDescrizione: body.allegatiDescrizione ?? null,
      createdBy: auth.user.id,
      originale: { bytes: bytesOriginale, nomeFile: body.nomeFile, mime: body.mime },
      pdfDaTimbrare,
      allegati,
    })

    await eliminaStagingBestEffort(supabase, [
      body.stagingPath,
      ...body.allegati.map((a) => a.stagingPath),
    ])

    const nomeDownload = `Prot-${String(esito.numero).padStart(7, '0')}-${esito.anno}.pdf`
    const downloadTimbrato = await firmaDownload(supabase, esito.pathTimbrato, nomeDownload).catch(
      () => null
    )

    return NextResponse.json(
      {
        success: true,
        data: {
          record: esito.record,
          numeroFormattato: esito.numeroFormattato,
          impronta: esito.impronta,
          downloadTimbrato,
        },
      },
      { status: 201 }
    )
  } catch (err) {
    console.error('Errore API POST protocolli:', err)
    return rispostaErroreProtocollo(err)
  }
}

// ─── PATCH: campi mutabili (note/categoria/collegamento) o annullamento ───────
const patchBodySchema = z
  .object({
    id: zUuid,
    azione: z.enum(['aggiorna', 'annulla']),
    noteInterne: z.string().max(2000).nullable().optional(),
    categoriaId: zUuid.nullable().optional(),
    collegatoAId: zUuid.nullable().optional(),
    motivo: z.string().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.azione === 'annulla' && (v.motivo ?? '').trim().length < 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['motivo'],
        message: "Il motivo dell'annullamento è obbligatorio (art. 54 DPR 445/2000)",
      })
    }
  })

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireStaff(request, GATE)
    if (auth.response) return auth.response
    const b = await parseBody(request, patchBodySchema)
    if ('response' in b) return b.response
    const body = b.data

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    const { data: record, error } = await supabase
      .from('protocolli')
      .select('id, annullata_at')
      .eq('id', body.id)
      .in('scuola_id', sedi)
      .maybeSingle()
    if (error) return rispostaErroreProtocollo(error)
    if (!record) {
      return NextResponse.json({ error: 'Registrazione non trovata' }, { status: 404 })
    }

    if (body.azione === 'annulla') {
      if ((record as { annullata_at: string | null }).annullata_at) {
        return NextResponse.json(
          { error: 'Registrazione già annullata (annullamento definitivo)' },
          { status: 409 }
        )
      }
      const { data, error: eAnnullo } = await supabase
        .from('protocolli')
        .update({
          annullata_at: new Date().toISOString(),
          annullata_da: auth.user.id,
          annullo_motivo: (body.motivo ?? '').trim(),
        })
        .eq('id', body.id)
        .select()
        .single()
      if (eAnnullo) return rispostaErroreProtocollo(eAnnullo)
      return NextResponse.json({ success: true, data })
    }

    const patch: Record<string, unknown> = {}
    if (body.noteInterne !== undefined) patch.note_interne = body.noteInterne
    if (body.categoriaId !== undefined) patch.categoria_id = body.categoriaId
    if (body.collegatoAId !== undefined) patch.collegato_a_id = body.collegatoAId
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nessun campo da aggiornare' }, { status: 400 })
    }
    const { data, error: eUpdate } = await supabase
      .from('protocolli')
      .update(patch)
      .eq('id', body.id)
      .select()
      .single()
    if (eUpdate) return rispostaErroreProtocollo(eUpdate)
    return NextResponse.json({ success: true, data })
  } catch (err) {
    console.error('Errore API PATCH protocolli:', err)
    return rispostaErroreProtocollo(err)
  }
}

// ─── DELETE: eliminazione totale, SOLO admin, nessuna traccia (decisioni #2/#6)
const deleteQuerySchema = z.object({ id: zUuid })

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireStaff(request, ['admin'])
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sedi = await resolveScuoleAttive(request, supabase, auth.user)
    const { data: record, error } = await supabase
      .from('protocolli')
      .select('id, scuola_id')
      .eq('id', q.data.id)
      .in('scuola_id', sedi)
      .maybeSingle()
    if (error) return rispostaErroreProtocollo(error)
    if (!record) {
      return NextResponse.json({ error: 'Registrazione non trovata' }, { status: 404 })
    }

    // Unico percorso di DELETE ammesso dal trigger WORM (GUC transaction-locale).
    const { data: paths, error: eElimina } = await supabase.rpc('protocollo_elimina', {
      p_id: q.data.id,
    })
    if (eElimina) return rispostaErroreProtocollo(eElimina)

    const daRimuovere = Array.isArray(paths) ? (paths as string[]).filter(Boolean) : []
    if (daRimuovere.length > 0) {
      await supabase.storage
        .from(PROTOCOLLO_BUCKET)
        .remove(daRimuovere)
        .then(
          () => undefined,
          () => undefined
        )
    }

    // Decisione #6: nessun logScrittura, nessuna traccia tecnica.
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Errore API DELETE protocolli:', err)
    return rispostaErroreProtocollo(err)
  }
}
