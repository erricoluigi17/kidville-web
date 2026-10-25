import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type StaffRole } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { colonnaNuovaAssente } from '@/lib/db/colonna-assente'
import { PAGELLE_BUCKET } from '@/lib/primaria/pagella-store'
import { percorsoPagellaRitirata } from '@/lib/primaria/pagelle-ritirate'
import { copiaNelBucket, type CoppiaCopia } from '@/lib/storage/copia-verificata'

// Il nome della route, per i log. `withRoute` lo riceve come LETTERALE (il lock
// `logging-coverage` lo legge dal sorgente e lo confronta col percorso del file).
const OP = 'primaria/scrutinio/riapri:POST'

/**
 * Chi può riaprire: Segreteria e Direzione (decisione del titolare, spec
 * 2026-09-24 §2 Primaria). Il docente no — la chiusura è un atto della
 * dirigenza, e la riapertura ritira documenti già consegnati alle famiglie.
 */
const RUOLI_RIAPERTURA: readonly StaffRole[] = ['admin', 'coordinator', 'segreteria']

/** Tetto di sicurezza della lettura della cartella: una classe ha ~30 alunni. */
const LIMITE_ELENCO_FILE = 1000

const postBodySchema = z.object({
  scrutinioId: zUuid,
})

/**
 * Guasto → 500 con codice. `area` sceglie l'evento del log: i guasti del bucket
 * vanno sotto 'storage' (chi cerca in `app_log` perché i PDF non si cancellano
 * filtra su quello), quelli di PostgREST sotto 'db'.
 */
function nonRiuscita(esito: string, error: unknown, area: 'db' | 'storage' = 'db'): NextResponse {
  logEvento(area, 'error', { operazione: OP, esito }, error)
  return NextResponse.json(
    { error: 'Riapertura non riuscita', codice: 'SCRUTINIO_RIAPERTURA_NON_RIUSCITA' },
    { status: 500 },
  )
}

function giaAperto(): NextResponse {
  return NextResponse.json(
    { error: 'Lo scrutinio non è chiuso', codice: 'SCRUTINIO_RIAPERTURA_NON_CHIUSO' },
    { status: 409 },
  )
}

/**
 * Toglie le copie in `ritirate/` che QUESTA richiesta ha creato e che nessuna riga nomina (una
 * riapertura interrotta a metà). Se non ci riesce lo dice: restano file in più, mai pagelle perse.
 */
async function togliCopie(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  copie: string[],
): Promise<void> {
  if (copie.length === 0) return
  try {
    const { error } = await supabase.storage.from(PAGELLE_BUCKET).remove(copie)
    if (error) logEvento('storage', 'error', { operazione: OP, esito: 'copie-ritirate-orfane', n_file: copie.length }, error)
  } catch (e) {
    logEvento('storage', 'error', { operazione: OP, esito: 'copie-ritirate-orfane', n_file: copie.length }, e)
  }
}

type RigaScrutinio = {
  id: string
  section_id: string
  stato: string
  pubblicato: boolean | null
  chiuso_il: string | null
  pubblicato_il: string | null
  sections: { scuola_id: string | null } | { scuola_id: string | null }[] | null
}

type RigaPagella = { id: string; alunno_id: string; file_url: string | null; file_ritirati?: string[] | null }

/**
 * POST /api/primaria/scrutinio/riapri — body: { scrutinioId }
 *
 * Riporta uno scrutinio CHIUSO ad APERTO. Tre passi, in quest'ordine, e l'ordine
 * è la sostanza:
 *
 *  1. **Ritiro della pubblicazione** (se era pubblicato): `pubblicato=false`; e
 *     l'avviso «Pagella disponibile» ancora in coda si ritira SEMPRE, anche se lo
 *     scrutinio risulta già non pubblicato (nessuna rettifica se è già partito).
 *     È il passo che toglie la pagella agli occhi dei genitori
 *     — tutti i lettori dei genitori filtrano su `pubblicato = true` — e va per
 *     PRIMO: se dopo qualcosa si rompe, i genitori non vedono comunque più niente.
 *  2. **Ritiro delle pagelle PDF** (sessione 10 della seconda serie di robustezza):
 *     2a. ogni PDF della cartella dello scrutinio citato da una riga in vigore si
 *         COPIA in `ritirate/<scrutinio>/<alunno>-<istante>.pdf`, prima di qualunque
 *         scrittura;
 *     2b. ogni riga si MARCA ritirata (`ritirata_il`, la copia in `file_url` e in coda
 *         a `file_ritirati`), solo se ancora in vigore;
 *     2c. solo adesso i PDF escono dalla cartella dello scrutinio (quelli citati dalle
 *         righe PIÙ quelli presenti senza riga, se l'upsert era fallito).
 *     Un guasto in 2a o 2b toglie le sole copie create qui e lascia tutto com'era.
 *     `pagella_ricezioni` NON si tocca: dipende da `scrutinio_id`, non dalle pagelle,
 *     ed è lo storico delle firme di ricezione. Senza le colonne del ritiro (DB della
 *     CI) si cancellano file e righe come prima, e lo si dice.
 *  3. **Riapertura**: `stato='aperto'`, `chiuso_da`/`chiuso_il` azzerati.
 *
 * Se il passo 2 fallisce, lo scrutinio resta CHIUSO e non pubblicato: la stessa
 * richiesta si può ripetere (le righe già ritirate non si rileggono, i PDF rimasti
 * nella cartella si tolgono). Se si riaprisse prima, un guasto a metà lascerebbe uno
 * scrutinio aperto con PDF vecchi che una seconda chiamata non potrebbe più pulire
 * (risponderebbe 409 «non chiuso»).
 */
export const POST = withRoute('primaria/scrutinio/riapri:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, RUOLI_RIAPERTURA)
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { scrutinioId } = b.data

    const supabase = await createAdminClient()

    const { data: letto, error: errScrutinio } = await supabase
      .from('scrutini')
      .select('id, section_id, stato, pubblicato, chiuso_il, pubblicato_il, sections(scuola_id)')
      .eq('id', scrutinioId)
      .maybeSingle()
    if (errScrutinio) return nonRiuscita('scrutinio-non-letto', errScrutinio)
    if (!letto) {
      return NextResponse.json(
        { error: 'Scrutinio inesistente', codice: 'SCRUTINIO_RIAPERTURA_NON_TROVATO' },
        { status: 404 },
      )
    }
    const scrutinio = letto as unknown as RigaScrutinio

    // Sede PRIMA dello stato: la Segreteria e la Direzione riaprono solo scrutini
    // del proprio plesso, e a chi è fuori sede la risposta non deve dipendere
    // dallo stato di uno scrutinio che non le appartiene (409 vs 403).
    const scopeErr = await assertSezioneInScope(supabase, auth.user, scrutinio.section_id)
    if (scopeErr) return scopeErr

    if (scrutinio.stato !== 'chiuso') return giaAperto()

    const sez = Array.isArray(scrutinio.sections) ? scrutinio.sections[0] : scrutinio.sections
    const scuolaId = sez?.scuola_id ?? null

    // ── 1. Ritiro della pubblicazione ───────────────────────────────────────
    if (scrutinio.pubblicato) {
      const { error: errRitiro } = await supabase
        .from('scrutini')
        .update({ pubblicato: false, pubblicato_da: null, pubblicato_il: null })
        .eq('id', scrutinioId)
        .eq('section_id', scrutinio.section_id)
        .eq('stato', 'chiuso')
      if (errRitiro) return nonRiuscita('pubblicazione-non-ritirata', errRitiro)
    }

    // Avviso «Pagella disponibile» ancora in coda: si ritira SEMPRE, non solo se
    // lo scrutinio risulta pubblicato adesso. Può restare in coda con
    // `pubblicato=false` in due casi: un tentativo precedente ha ritirato la
    // pubblicazione ma non l'avviso (e poi è fallito più avanti), oppure la
    // pubblicazione è stata ritirata con /scrutinio/pubblica, che gli avvisi non
    // li tocca. Il delete è idempotente e costa una query.
    let avvisiRitirati = 0
    const { data: ritirati, error: errAvvisi } = await supabase
      .from('notifiche')
      .delete()
      .eq('tipo', 'pagella')
      .eq('entita_tipo', 'scrutinio')
      .eq('entita_id', scrutinioId)
      .is('push_inviata_il', null)
      .select('id')
    if (errAvvisi) {
      // Non blocca: la pubblicazione è ritirata, ma l'avviso «Pagella
      // disponibile» resta in coda e partirà per una pagella che non c'è più.
      logEvento('notifica', 'error', {
        operazione: OP,
        esito: 'avviso-pagella-non-ritirato',
        tipo: 'pagella',
        scrutinio_id: scrutinioId,
      }, errAvvisi)
    } else {
      avvisiRitirati = ((ritirati ?? []) as unknown[]).length
    }

    // ── 2. Ritiro delle pagelle PDF ─────────────────────────────────────────
    // Solo le righe IN VIGORE: una ripetizione dopo un guasto non rimarca quelle già ritirate.
    const vigenti = await supabase
      .from('pagelle')
      .select('id, alunno_id, file_url, file_ritirati')
      .eq('scrutinio_id', scrutinioId)
      .is('ritirata_il', null)
    const ripiegoSchema = !!vigenti.error && colonnaNuovaAssente(vigenti.error)
    if (ripiegoSchema) {
      logEvento('db', 'info', { operazione: OP, esito: 'colonna-ritiro-assente', scrutinio_id: scrutinioId })
    }
    const lettura = ripiegoSchema
      ? await supabase.from('pagelle').select('id, alunno_id, file_url').eq('scrutinio_id', scrutinioId)
      : vigenti
    if (lettura.error) return nonRiuscita('pagelle-non-lette', lettura.error)
    const pagelle = (lettura.data ?? []) as RigaPagella[]

    const bucket = supabase.storage.from(PAGELLE_BUCKET)
    const { data: elenco, error: errElenco } = await bucket.list(scrutinioId, { limit: LIMITE_ELENCO_FILE })
    if (errElenco) return nonRiuscita('cartella-pagelle-non-letta', errElenco, 'storage')

    // Solo percorsi DENTRO la cartella di questo scrutinio: un `file_url` che
    // puntasse altrove non si copia e non si cancella da qui.
    const prefisso = `${scrutinioId}/`
    const nellaCartella = (p: string | null): p is string => !!p && p.startsWith(prefisso)
    const daRimuovere = new Set<string>()
    for (const p of pagelle) {
      if (nellaCartella(p.file_url)) daRimuovere.add(p.file_url)
    }
    for (const f of (elenco ?? []) as { name: string }[]) {
      if (f.name && !f.name.includes('/')) daRimuovere.add(`${prefisso}${f.name}`)
    }

    let righeRitirate = 0
    let righeEliminate = 0
    let fileConservati = 0
    let fileEliminati = 0

    if (ripiegoSchema) {
      // DB senza le colonne del ritiro (la CI): file e righe cancellati, come prima.
      if (daRimuovere.size > 0) {
        const { data: rimossi, error: errRimozione } = await bucket.remove([...daRimuovere])
        if (errRimozione) return nonRiuscita('file-pagelle-non-eliminati', errRimozione, 'storage')
        fileEliminati = ((rimossi ?? []) as unknown[]).length
      }
      if (pagelle.length > 0) {
        const { data: cancellate, error: errCancella } = await supabase
          .from('pagelle')
          .delete()
          .eq('scrutinio_id', scrutinioId)
          .select('id')
        if (errCancella) return nonRiuscita('righe-pagelle-non-eliminate', errCancella)
        righeEliminate = ((cancellate ?? []) as unknown[]).length
      }
    } else {
      // 2a. Le copie, PRIMA di qualunque scrittura sulle pagelle.
      const adesso = new Date()
      const copiaDi = new Map<string, string>()
      const coppie: CoppiaCopia[] = []
      for (const p of pagelle) {
        if (!nellaCartella(p.file_url)) continue
        const a = percorsoPagellaRitirata(scrutinioId, p.alunno_id, adesso)
        copiaDi.set(p.id, a)
        coppie.push({ da: p.file_url, a })
      }
      const esitoCopie = await copiaNelBucket(supabase, PAGELLE_BUCKET, coppie, OP)
      const arrivate = new Set([...esitoCopie.copiati, ...esitoCopie.giaPresenti].map((c) => c.a))
      // Le sole copie che QUESTA richiesta ha creato: una «già presente» è di qualcun altro.
      const nostre = new Set(esitoCopie.copiati.map((c) => c.a))
      if (esitoCopie.falliti.length > 0) {
        await togliCopie(supabase, [...nostre])
        return nonRiuscita('pagelle-non-ritirate', esitoCopie.primoErrore, 'storage')
      }

      // 2b. Le marcature, riga per riga, solo se ancora in vigore.
      const trattate = new Set<string>()
      for (const p of pagelle) {
        const copia = copiaDi.get(p.id)
        const conservata = copia && arrivate.has(copia) ? copia : null
        const precedenti = Array.isArray(p.file_ritirati) ? p.file_ritirati : []
        const { data: marcate, error: errMarca } = await supabase
          .from('pagelle')
          .update({
            ritirata_il: adesso.toISOString(),
            file_url: conservata ?? p.file_url,
            file_ritirati: conservata ? [...precedenti, conservata] : precedenti,
          })
          .eq('id', p.id)
          .eq('scrutinio_id', scrutinioId)
          .is('ritirata_il', null)
          .select('id')
        if (errMarca) {
          const senzaRiga = pagelle
            .filter((q) => !trattate.has(q.id))
            .map((q) => copiaDi.get(q.id))
            .filter((c): c is string => !!c && nostre.has(c))
          await togliCopie(supabase, senzaRiga)
          return nonRiuscita('pagelle-non-marcate', errMarca)
        }
        trattate.add(p.id)
        if (((marcate ?? []) as unknown[]).length === 0) {
          // Un'altra riapertura l'ha già ritirata: vale la sua copia, la nostra si toglie.
          if (conservata && nostre.has(conservata)) await togliCopie(supabase, [conservata])
          continue
        }
        righeRitirate++
        if (conservata) fileConservati++
      }

      // 2c. Solo adesso i PDF escono dalla cartella dello scrutinio.
      if (daRimuovere.size > 0) {
        const { data: rimossi, error: errRimozione } = await bucket.remove([...daRimuovere])
        if (errRimozione) return nonRiuscita('file-pagelle-non-eliminati', errRimozione, 'storage')
        fileEliminati = ((rimossi ?? []) as unknown[]).length
      }
    }

    // ── 3. Riapertura ───────────────────────────────────────────────────────
    const { data: riaperto, error: errRiapri } = await supabase
      .from('scrutini')
      .update({
        stato: 'aperto',
        chiuso_da: null,
        chiuso_il: null,
        pubblicato: false,
        pubblicato_da: null,
        pubblicato_il: null,
      })
      .eq('id', scrutinioId)
      .eq('section_id', scrutinio.section_id)
      .eq('stato', 'chiuso')
      .select('id, section_id, periodo_id, stato, pubblicato')
      .maybeSingle()
    if (errRiapri) return nonRiuscita('scrutinio-non-riaperto', errRiapri)
    // Nessuna riga: un'altra riapertura è passata nel frattempo.
    if (!riaperto) return giaAperto()

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'scrutinio',
      entitaId: scrutinioId,
      azione: 'update',
      scuolaId,
      sectionId: scrutinio.section_id,
      valorePrima: {
        stato: 'chiuso',
        pubblicato: !!scrutinio.pubblicato,
        chiuso_il: scrutinio.chiuso_il,
        pubblicato_il: scrutinio.pubblicato_il,
        pagelle: pagelle.map((p) => ({ id: p.id, alunno_id: p.alunno_id })),
      },
      valoreDopo: {
        stato: 'aperto',
        pubblicato: false,
        pagelle_ritirate: righeRitirate,
        pagelle_eliminate: righeEliminate,
        file_conservati: fileConservati,
        file_eliminati: fileEliminati,
      },
    })

    // Il SUCCESSO si logga: riaprire uno scrutinio ritira documenti già
    // consegnati alle famiglie. Solo uuid, numeri e booleani.
    logEvento('registro', 'info', {
      operazione: OP,
      esito: 'scrutinio-riaperto',
      scrutinio_id: scrutinioId,
      section_id: scrutinio.section_id,
      scuola_id: scuolaId,
      attore_id: auth.user.id,
      era_pubblicato: !!scrutinio.pubblicato,
      avvisi_ritirati: avvisiRitirati,
      pagelle_ritirate: righeRitirate,
      pagelle_eliminate: righeEliminate,
      file_conservati: fileConservati,
      file_eliminati: fileEliminati,
      ripiego_schema: ripiegoSchema,
    }, undefined, { distingui: ['scrutinio_id'] })

    return NextResponse.json({
      success: true,
      data: riaperto,
      pagelleRitirate: righeRitirate,
      pagelleEliminate: righeEliminate,
      fileConservati,
      fileEliminati,
      avvisiRitirati,
    })
  } catch (err) {
    logErrore({ operazione: OP, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Riapertura non riuscita', codice: 'SCRUTINIO_RIAPERTURA_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})
