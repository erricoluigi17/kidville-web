import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { resolveIdentity, loadAppUser, requireStaff, type StaffRole } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, assertAlunniInSezione, assertSezioneInScope } from '@/lib/auth/scope'
import { generaPagella, PAGELLE_BUCKET } from '@/lib/primaria/pagella-store'
import { parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { rispostaGuastoDb } from '@/lib/db/guasto'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'

const getQuerySchema = z.object({
  scrutinioId: zUuid,
  alunnoId: zUuid,
  // Flag storico: attivo SOLO con '1' (qualsiasi altro valore = false).
  persist: z.string().optional(),
})

// GET /api/primaria/pagella?scrutinioId=&alunnoId=&userId=[&persist=1]
// Genera (e opzionalmente archivia) il PDF della pagella e lo restituisce.
export const GET = withRoute('primaria/pagella:GET', async (request: NextRequest) => {
  try {
    const { userId } = await resolveIdentity(request)
    if (!userId) return NextResponse.json({ error: 'Non autenticato' }, { status: 401 })
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { scrutinioId, alunnoId } = q.data
    const persist = q.data.persist === '1'

    const supabase = await createAdminClient()

    // Gate visibilità: lo staff (admin/coordinator/segreteria) può generare/anteprima
    // anche prima della pubblicazione, ma SOLO per gli alunni del proprio plesso;
    // il genitore solo se pubblicato E dopo aver firmato la ricezione (OTP/FES).
    const appUser = await loadAppUser(userId)
    const isStaff = !!appUser && ['admin', 'coordinator', 'segreteria'].includes(appUser.role)
    if (isStaff) {
      const scopeErr = await assertAlunnoInScope(supabase, appUser, alunnoId)
      if (scopeErr) return scopeErr
      // Lo scrutinio deve essere quello della classe dell'alunno: blocca scrutinioId
      // di altre sezioni/plessi (leak dati nel PDF, persist incoerente).
      const { data: scr, error: errScr } = await supabase.from('scrutini').select('section_id').eq('id', scrutinioId).maybeSingle()
      // Un guasto non è «scrutinio non trovato».
      if (errScr) return rispostaGuastoDb('primaria/pagella:GET', 'db:scrutini', errScr)
      if (!scr) return NextResponse.json({ error: 'Scrutinio non trovato' }, { status: 404 })
      const coerenzaErr = await assertAlunniInSezione(supabase, [alunnoId], scr.section_id as string)
      if (coerenzaErr) return coerenzaErr
    } else {
      // Un guasto NON è «non pubblicata» né «firma richiesta»: il genitore che ha già
      // firmato si vedrebbe chiedere di nuovo la firma, o negare una pagella pubblicata.
      const { data: scr, error: errScr } = await supabase.from('scrutini').select('pubblicato').eq('id', scrutinioId).maybeSingle()
      if (errScr) return rispostaGuastoDb('primaria/pagella:GET', 'db:scrutini', errScr)
      if (!scr?.pubblicato) return NextResponse.json({ error: 'Pagella non ancora pubblicata' }, { status: 403 })
      const { data: firma, error: errFirma } = await supabase
        .from('pagella_ricezioni')
        .select('id')
        .eq('scrutinio_id', scrutinioId)
        .eq('alunno_id', alunnoId)
        .eq('genitore_id', userId)
        .maybeSingle()
      if (errFirma) return rispostaGuastoDb('primaria/pagella:GET', 'db:pagella_ricezioni', errFirma)
      if (!firma) return NextResponse.json({ error: 'Firma di ricezione richiesta' }, { status: 403 })
    }

    const { pdf, error, status } = await generaPagella(supabase, scrutinioId, alunnoId, userId, persist)
    if (error) return NextResponse.json({ error }, { status: status ?? 500 })

    return new NextResponse(new Uint8Array(pdf!), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="pagella-${alunnoId.slice(0, 8)}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    logErrore({ operazione: 'primaria/pagella:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

// ─── DELETE: eliminazione di UNA pagella (compito S2) ─────────────────────────

const OP_DELETE = 'primaria/pagella:DELETE'

/**
 * Chi può eliminare una singola pagella: Segreteria e Direzione (spec
 * 2026-09-24 §2 Primaria). Il docente no, come per la riapertura dello scrutinio.
 */
const RUOLI_ELIMINAZIONE: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria']

const deleteQuerySchema = z.object({
  scrutinioId: zUuid,
  alunnoId: zUuid,
})

type ScrutinioDaEliminare = {
  id: string
  section_id: string
  sections: { scuola_id: string | null } | { scuola_id: string | null }[] | null
}

type PagellaArchiviata = {
  id: string
  file_url: string | null
  generata_il: string | null
  generata_da: string | null
  /** Sessione 10: valorizzata quando una riapertura ha ritirato la pagella. Assente nel DB della CI. */
  ritirata_il?: string | null
  /** Sessione 10: le copie in `ritirate/` delle versioni consegnate, dalla più vecchia. */
  file_ritirati?: string[] | null
}

/**
 * Guasto → 500 con codice, mai il messaggio grezzo. `area` sceglie l'evento del
 * log: il bucket sotto 'storage', PostgREST sotto 'db'.
 */
function eliminazioneNonRiuscita(esito: string, error: unknown, area: 'db' | 'storage' = 'db'): NextResponse {
  logEvento(area, 'error', { operazione: OP_DELETE, esito }, error)
  return NextResponse.json(
    { error: 'Eliminazione della pagella non riuscita', codice: 'PAGELLA_ELIMINAZIONE_NON_RIUSCITA' },
    { status: 500 },
  )
}

/**
 * DELETE /api/primaria/pagella?scrutinioId=&alunnoId=
 *
 * Elimina la pagella archiviata di UN alunno per UNO scrutinio: il PDF nel
 * bucket `pagelle` e la riga di `pagelle`. `pagella_ricezioni` NON si tocca:
 * dipende da `scrutinio_id`, non dalle pagelle, ed è lo storico delle firme.
 * Non si tocca nemmeno lo scrutinio (stato e pubblicazione restano), né l'avviso
 * «Pagella disponibile», che è per scrutinio e non per alunno.
 *
 * Ordine: prima il file, poi la riga (come la riapertura). Se la rimozione del
 * file fallisce la riga resta e la richiesta si ripete; se fallisce la
 * cancellazione della riga, il file è già via e la ripetizione la completa (la
 * rimozione di un percorso assente non è un errore). Il percorso del file si
 * ricava sempre da scrutinio e alunno, così anche un PDF rimasto senza riga
 * (upsert fallito in `persistPagella`) si elimina.
 *
 * Le versioni RITIRATE (sessione 10). Una riapertura copia la pagella consegnata in
 * `ritirate/<scrutinio>/…` e ne tiene il percorso in `file_ritirati`, che è l'unico indice di
 * quelle copie. Se la pagella in vigore ha versioni ritirate alle spalle, la riga NON si
 * cancella: si ritira (`ritirata_il`) e torna a nominare l'ultima versione consegnata. Una riga
 * già ritirata non è «la pagella» di questa richiesta: si tratta come assente.
 */
export const DELETE = withRoute('primaria/pagella:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, RUOLI_ELIMINAZIONE)
    if (auth.response) return auth.response

    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { scrutinioId, alunnoId } = q.data

    const supabase = await createAdminClient()

    const { data: letto, error: errScrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, sections(scuola_id)')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (errScrutinio) return eliminazioneNonRiuscita('scrutinio-non-letto', errScrutinio)
    if (!letto) {
      return NextResponse.json(
        { error: 'Scrutinio inesistente', codice: 'PAGELLA_ELIMINAZIONE_SCRUTINIO_NON_TROVATO' },
        { status: 404 },
      )
    }
    const scrutinio = letto as unknown as ScrutinioDaEliminare

    // Sede PRIMA di ogni altra lettura e di ogni scrittura: Segreteria e
    // Direzione eliminano solo pagelle di classi del proprio plesso.
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id)
    if (scopeErr) return scopeErr

    const sez = Array.isArray(scrutinio.sections) ? scrutinio.sections[0] : scrutinio.sections
    const scuolaId = sez?.scuola_id ?? null

    // Prima con le colonne del ritiro; senza (DB della CI, 42703) come prima, e lo si dice.
    const conRitiro = await supabase
      .from('pagelle')
      .select('id, file_url, generata_il, generata_da, ritirata_il, file_ritirati')
      .eq('scrutinio_id', scrutinioId)
      .eq('alunno_id', alunnoId)
      .maybeSingle()
    const ripiegoSchema = !!conRitiro.error && colonnaNuovaAssente(conRitiro.error)
    if (ripiegoSchema) {
      logEvento('db', 'info', { operazione: OP_DELETE, esito: 'colonna-ritiro-assente', scrutinio_id: scrutinioId })
    }
    const lettura = ripiegoSchema
      ? await supabase
          .from('pagelle')
          .select('id, file_url, generata_il, generata_da')
          .eq('scrutinio_id', scrutinioId)
          .eq('alunno_id', alunnoId)
          .maybeSingle()
      : conRitiro
    if (lettura.error) return eliminazioneNonRiuscita('pagella-non-letta', lettura.error)
    const letta = (lettura.data ?? null) as PagellaArchiviata | null
    // Una riga già ritirata non è in vigore: per questa richiesta è come se non ci fosse.
    const riga = letta && !letta.ritirata_il ? letta : null
    const storico = riga && Array.isArray(riga.file_ritirati) ? riga.file_ritirati : []
    const ultima = storico.length > 0 ? storico[storico.length - 1] : null

    // Percorsi: quello canonico di `persistPagella` più quello scritto nella
    // riga, ma SOLO se è un file di questo alunno nella cartella di questo
    // scrutinio — un `file_url` che puntasse altrove (o al PDF di un compagno)
    // non si cancella da qui. Le copie in `ritirate/` sono fuori dalla cartella.
    const cartella = `${scrutinioId}/`
    const percorsi = new Set<string>([`${cartella}${alunnoId}.pdf`])
    const fileDellaRiga = riga?.file_url ?? null
    if (
      fileDellaRiga &&
      fileDellaRiga.startsWith(`${cartella}${alunnoId}`) &&
      !fileDellaRiga.slice(cartella.length).includes('/')
    ) {
      percorsi.add(fileDellaRiga)
    }

    const { data: rimossi, error: errRimozione } = await supabase.storage
      .from(PAGELLE_BUCKET)
      .remove([...percorsi])
    if (errRimozione) return eliminazioneNonRiuscita('file-pagella-non-eliminato', errRimozione, 'storage')
    const fileEliminati = ((rimossi ?? []) as unknown[]).length

    let rigaEliminata = false
    let rigaConservata = false
    const adesso = new Date().toISOString()
    if (riga && ultima) {
      // Versioni ritirate alle spalle: la riga resta, ritirata, e torna a nominare l'ultima
      // versione consegnata. Il PDF in vigore è già fuori dall'archivio (sopra).
      const { data: ritirate, error: errRitira } = await supabase
        .from('pagelle')
        .update({ ritirata_il: adesso, file_url: ultima })
        .eq('id', riga.id)
        .eq('scrutinio_id', scrutinioId)
        .eq('alunno_id', alunnoId)
        .is('ritirata_il', null)
        .select('id')
      if (errRitira) return eliminazioneNonRiuscita('riga-pagella-non-ritirata', errRitira)
      rigaConservata = ((ritirate ?? []) as unknown[]).length > 0
    } else if (riga) {
      const { data: cancellate, error: errCancella } = await supabase
        .from('pagelle')
        .delete()
        .eq('id', riga.id)
        .eq('scrutinio_id', scrutinioId)
        .eq('alunno_id', alunnoId)
        .select('id')
      if (errCancella) return eliminazioneNonRiuscita('riga-pagella-non-eliminata', errCancella)
      rigaEliminata = ((cancellate ?? []) as unknown[]).length > 0
    }

    // Niente riga e niente file: non c'era nessuna pagella da eliminare.
    if (!rigaEliminata && !rigaConservata && fileEliminati === 0) {
      return NextResponse.json(
        { error: 'Pagella inesistente', codice: 'PAGELLA_ELIMINAZIONE_NON_TROVATA' },
        { status: 404 },
      )
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'pagella',
      entitaId: riga?.id ?? null,
      azione: rigaConservata ? 'update' : 'delete',
      scuolaId,
      sectionId: scrutinio.section_id,
      valorePrima: {
        scrutinio_id: scrutinioId,
        alunno_id: alunnoId,
        file_url: riga?.file_url ?? null,
        generata_il: riga?.generata_il ?? null,
        generata_da: riga?.generata_da ?? null,
      },
      valoreDopo: rigaConservata ? { ritirata_il: adesso, file_url: ultima } : null,
    })

    // Il SUCCESSO si logga: si toglie un documento già consegnabile alla
    // famiglia. Solo uuid, numeri e booleani.
    logEvento('registro', 'info', {
      operazione: OP_DELETE,
      esito: rigaConservata ? 'pagella-eliminata-storico-conservato' : 'pagella-eliminata',
      scrutinio_id: scrutinioId,
      alunno_id: alunnoId,
      section_id: scrutinio.section_id,
      scuola_id: scuolaId,
      attore_id: auth.user.id,
      riga_eliminata: rigaEliminata,
      file_eliminati: fileEliminati,
      ...(rigaConservata ? { riga_conservata: true } : {}),
    }, undefined, { distingui: ['scrutinio_id', 'alunno_id'] })

    return NextResponse.json({
      success: true,
      rigaEliminata,
      fileEliminati,
      ...(rigaConservata ? { rigaConservata: true } : {}),
    })
  } catch (err) {
    logErrore({ operazione: OP_DELETE, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Eliminazione della pagella non riuscita', codice: 'PAGELLA_ELIMINAZIONE_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})
