import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente, type AppUser } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { haUnRuolo } from '@/lib/auth/predicati-ruolo'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { notificaTitolariScrittura } from '@/lib/primaria/notifiche'
import { rispostaPermessoNegato } from '@/lib/primaria/permesso-voce'
import { allegatiRegistroNelCestino } from '@/lib/primaria/cestino-allegati-registro'
import {
  cestinoScaduto,
  giorniResiduiCestino,
  scadenzaCestino,
  sogliaPurgaCestinoRegistro,
} from '@/lib/primaria/cestino-registro'
import {
  COLONNE_ALLEGATO,
  COLONNE_LEZIONE_ALLEGATO,
  leggiLezione,
  risposte,
  type AllegatoRegistro,
  type LezioneAllegato,
} from '@/lib/primaria/allegati-registro'

/**
 * IL CESTINO DEGLI ALLEGATI DEL REGISTRO (spec 2026-09-24, R2).
 *
 *   GET  /api/primaria/allegati/cestino?sectionId=   — gli allegati eliminati (o
 *        sostituiti, o rimasti senza lezione) della CLASSE che si possono ANCORA
 *        ripristinare, coi giorni residui;
 *   POST /api/primaria/allegati/cestino  { id }      — RIPRISTINA un allegato.
 *
 * ─── IL RIPRISTINO E LA LEZIONE ─────────────────────────────────────────────
 * Un allegato eliminato da solo conserva il suo `registro_id`: torna alla sua
 * lezione. Uno la cui lezione è stata ELIMINATA ha `registro_id` NULL (la FK è `ON
 * DELETE SET NULL`) e porta lo slot d'origine (`slot_section_id`, `slot_data`,
 * `slot_ora_lezione`): torna SOLO se nello stesso slot c'è di nuovo una lezione
 * firmata, e vi si riaggancia nello stesso UPDATE che lo toglie dal cestino (il
 * vincolo `allegati_registro_senza_lezione_nel_cestino_check` rifiuterebbe un
 * allegato vivo senza lezione). Senza lezione: `409 LEZIONE_DA_RIFIRMARE`.
 *
 * ─── CHI, E FINO A QUANDO ───────────────────────────────────────────────────
 * CHI è la stessa regola della modifica (`permesso-voce`, tipo `allegato`): l'autore
 * (`caricato_da`), o Segreteria e Direzione, e la classe nello scope. Altrimenti
 * `403 VOCE_NON_AUTORE`, con la stessa forma di `rispostaPermessoNegato`.
 *
 * FINO A QUANDO è la CUSTODIA del cestino, e basta: il termine sulla data della
 * lezione (2 giorni, poi lo sblocco della Direzione) la spec lo mette su modifica ed
 * eliminazione, non sul ripristino. Applicarlo qui ridurrebbe i 7 giorni del cestino
 * a pochi giorni al massimo, e lo sblocco non aiuterebbe: `primaria/sblocca` legge
 * solo gli allegati VIVI. Per questo il GET non dice `bloccata`: un «Sblocca» su una
 * voce del cestino fallirebbe sempre.
 *
 * Un docente vede nel cestino i SOLI allegati che ha caricato lui: sono gli unici che
 * può riportare indietro, e un elenco di voci su cui ogni pulsante risponde 403 non è
 * un elenco, è un inganno.
 *
 * I giorni di custodia vengono da `GIORNI_CESTINO_REGISTRO` (`cestino-registro.ts`),
 * la stessa costante che applica la purga: la voce che la purga può già aver tolto
 * non si elenca e non si ripristina. La scadenza si controlla PRIMA di tutto il resto:
 * un allegato scaduto ha quasi sempre una lezione vecchia, e nessun'altra risposta
 * deve coprire «è scaduto».
 */

const getQuerySchema = z.object({
  sectionId: zUuid,
})

const postBodySchema = z.object({
  id: zUuid,
})

/** Chi vede nel cestino, e ripristina, anche gli allegati degli altri (gli stessi di `permesso-voce`). */
const RUOLI_STAFF = ['segreteria', 'admin', 'coordinator'] as const

type RigaCestino = AllegatoRegistro & { eliminato_il: string }

/** CHI può ripristinare: l'autore o lo staff. Il termine sulla lezione qui non conta. */
function puoRipristinare(utente: AppUser, allegato: Pick<AllegatoRegistro, 'caricato_da'>): boolean {
  return haUnRuolo(utente, RUOLI_STAFF) || (allegato.caricato_da != null && allegato.caricato_da === utente.id)
}

export const GET = withRoute('primaria/allegati/cestino:GET', async (request: NextRequest) => {
  const operazione = 'primaria/allegati/cestino:GET'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId } = q.data

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // Il cestino della CLASSE: per slot d'origine, che ogni allegato ha per costruzione
    // (trigger `trg_allegati_registro_copia_slot`, riempimento della migrazione P0) —
    // anche quello la cui lezione non esiste più.
    let query = allegatiRegistroNelCestino(
      supabase
        .from('allegati_registro')
        .select(COLONNE_ALLEGATO)
        .eq('slot_section_id', sectionId)
        .gte('eliminato_il', sogliaPurgaCestinoRegistro()),
    )
    const staff = haUnRuolo(auth.user, RUOLI_STAFF)
    if (!staff) query = query.eq('caricato_da', auth.user.id)
    const { data, error } = await query.order('eliminato_il', { ascending: false })
    if (error) {
      logEvento('registro', 'error', { operazione, esito: 'cestino-non-letto', sezione: sectionId }, error)
      return risposte.letturaFallita()
    }
    const righe = (data ?? []) as unknown as RigaCestino[]

    // Le lezioni presenti negli slot degli allegati SENZA lezione: dice alla UI se
    // «Ripristina» funziona o se prima va rifirmata la lezione. Una lettura sola.
    const orfani = righe.filter((r) => !r.registro_id && r.slot_data)
    const slotPresenti = new Set<string>()
    if (orfani.length) {
      const date = [...new Set(orfani.map((r) => String(r.slot_data).slice(0, 10)))]
      const { data: lezioni, error: lezErr } = await supabase
        .from('registro_orario')
        .select(COLONNE_LEZIONE_ALLEGATO)
        .eq('section_id', sectionId)
        .in('data', date)
      if (lezErr) {
        logEvento('registro', 'error', { operazione, esito: 'lezioni-slot-non-lette', sezione: sectionId }, lezErr)
        return risposte.letturaFallita()
      }
      for (const l of (lezioni ?? []) as LezioneAllegato[]) {
        slotPresenti.add(`${String(l.data).slice(0, 10)}|${Number(l.ora_lezione)}`)
      }
    }

    const adesso = new Date()
    const voci = righe.map((r) => {
      const lezioneDaRifirmare =
        !r.registro_id && !slotPresenti.has(`${String(r.slot_data).slice(0, 10)}|${Number(r.slot_ora_lezione)}`)
      return {
        id: r.id,
        registro_id: r.registro_id,
        ambito: r.ambito,
        tipo: r.tipo,
        file_name: r.file_name,
        dimensione_byte: r.dimensione_byte,
        caricato_da: r.caricato_da,
        creato_il: r.creato_il,
        eliminato_il: r.eliminato_il,
        eliminato_da: r.eliminato_da,
        slot_data: r.slot_data,
        slot_ora_lezione: r.slot_ora_lezione,
        ripristinabileFinoAl: scadenzaCestino(r.eliminato_il)?.toISOString() ?? null,
        giorniResidui: giorniResiduiCestino(r.eliminato_il, adesso),
        lezioneDaRifirmare,
        // Solo CHI e la lezione: il termine sulla data della lezione non vale per il
        // ripristino (vedi la testata), quindi niente `bloccata` né «Sblocca».
        ripristinabile: puoRipristinare(auth.user, r) && !lezioneDaRifirmare,
      }
    })

    logEvento('registro', 'info', { operazione, esito: 'cestino-elencato', sezione: sectionId, n: voci.length })
    return NextResponse.json({ success: true, data: voci })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'LETTURA_FALLITA' }, { status: 500 })
  }
})

export const POST = withRoute('primaria/allegati/cestino:POST', async (request: NextRequest) => {
  const operazione = 'primaria/allegati/cestino:POST'
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { id } = b.data

    const supabase = await createAdminClient()

    // ── 1. La riga, NEL CESTINO ──────────────────────────────────────────────
    const { data: letto, error: erroreLettura } = await allegatiRegistroNelCestino(
      supabase.from('allegati_registro').select(COLONNE_ALLEGATO).eq('id', id),
    ).maybeSingle()
    if (erroreLettura) {
      logEvento('registro', 'error', { operazione, esito: 'allegato-non-letto', allegato_id: id }, erroreLettura)
      return risposte.letturaFallita()
    }
    const allegato = letto as RigaCestino | null
    if (!allegato) {
      return NextResponse.json(
        { error: "L'allegato non è nel cestino", codice: 'ALLEGATO_REGISTRO_NON_NEL_CESTINO' },
        { status: 409 },
      )
    }

    // ── 2. La lezione a cui torna: la sua, oppure quella rifirmata nello slot ──
    let lezione: LezioneAllegato | null = null
    if (allegato.registro_id) {
      const letta = await leggiLezione(supabase, allegato.registro_id)
      if (letta.errore) {
        logEvento('registro', 'error', { operazione, esito: 'lezione-non-letta', registro_id: allegato.registro_id }, letta.errore)
        return risposte.letturaFallita()
      }
      lezione = letta.lezione
    }
    const sectionId = lezione?.section_id ?? allegato.slot_section_id
    if (!sectionId) return risposte.allegatoNonTrovato()

    // ── 3. La classe nello scope, PRIMA di dire qualunque cosa sulla lezione ──
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // ── 4. Oltre la custodia: non si ripristina (la purga può averlo già tolto).
    //    PRIMA di ogni altra risposta: un allegato scaduto ha quasi sempre una lezione
    //    vecchia, e un 423 o un «rifirma la lezione» nasconderebbero il vero motivo.
    if (cestinoScaduto(allegato.eliminato_il)) {
      logEvento('registro', 'info', { operazione, esito: 'ripristino-cestino-scaduto', allegato_id: id, sezione: sectionId })
      return NextResponse.json(
        {
          error: 'Il tempo per ripristinare questo allegato è scaduto',
          codice: 'ALLEGATO_REGISTRO_CESTINO_SCADUTO',
        },
        { status: 409 },
      )
    }

    // ── 5. CHI: l'autore o lo staff. Nessun termine sulla data della lezione: il
    //    limite del ripristino è la custodia del cestino, già controllata sopra. Si
    //    decide PRIMA di dire «rifirma la lezione» a chi comunque non potrebbe.
    if (!puoRipristinare(auth.user, allegato)) {
      logEvento('registro', 'info', { operazione, esito: 'ripristino-non-autore', allegato_id: id, sezione: sectionId })
      return rispostaPermessoNegato({ ok: false, stato: 403, codice: 'VOCE_NON_AUTORE' })
    }

    if (!lezione && allegato.slot_data && allegato.slot_ora_lezione != null) {
      const { data: nelloSlot, error: slotErr } = await supabase
        .from('registro_orario')
        .select(COLONNE_LEZIONE_ALLEGATO)
        .eq('section_id', sectionId)
        .eq('data', String(allegato.slot_data).slice(0, 10))
        .eq('ora_lezione', allegato.slot_ora_lezione)
        .order('id')
        .limit(1)
        .maybeSingle()
      if (slotErr) {
        logEvento('registro', 'error', { operazione, esito: 'lezione-slot-non-letta', sezione: sectionId }, slotErr)
        return risposte.letturaFallita()
      }
      lezione = (nelloSlot as LezioneAllegato | null) ?? null
    }

    if (!lezione) {
      logEvento('registro', 'info', { operazione, esito: 'ripristino-lezione-da-rifirmare', allegato_id: id, sezione: sectionId })
      return NextResponse.json(
        {
          error: 'La lezione di questo allegato è stata eliminata: rifirmala nella stessa ora, poi ripristina.',
          codice: 'LEZIONE_DA_RIFIRMARE',
        },
        { status: 409 },
      )
    }

    // ── 6. Il ripristino, condizionato: ancora nel cestino E ancora entro la
    //    custodia. Fra la lettura e qui può essere passata la purga, o un secondo
    //    «Ripristina». Il `registro_id` si rimette nello STESSO update: un allegato
    //    vivo senza lezione il database lo rifiuta (23514).
    const riagganciato = allegato.registro_id !== lezione.id
    const { data: tornato, error: erroreRipristino } = await allegatiRegistroNelCestino(
      supabase
        .from('allegati_registro')
        .update({ eliminato_il: null, eliminato_da: null, registro_id: lezione.id })
        .eq('id', id)
        .gte('eliminato_il', sogliaPurgaCestinoRegistro()),
    ).select('id, registro_id, ambito, tipo, file_name, dimensione_byte, caricato_da, creato_il').maybeSingle()
    if (erroreRipristino) {
      logEvento('registro', 'error', { operazione, esito: 'allegato-non-ripristinato', allegato_id: id }, erroreRipristino)
      return risposte.scritturaFallita()
    }
    if (!tornato) {
      return NextResponse.json(
        { error: "L'allegato non è nel cestino", codice: 'ALLEGATO_REGISTRO_NON_NEL_CESTINO' },
        { status: 409 },
      )
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'allegato',
      entitaId: id,
      azione: 'update',
      scuolaId: lezione.scuola_id,
      sectionId: lezione.section_id,
      valorePrima: {
        id, cestino: true, registro_id: allegato.registro_id,
        eliminato_il: allegato.eliminato_il, eliminato_da: allegato.eliminato_da,
      },
      valoreDopo: { id, cestino: false, ripristinato: true, registro_id: lezione.id },
    })
    await notificaTitolariScrittura(supabase, {
      attore: auth.user, sectionId: lezione.section_id, scuolaId: lezione.scuola_id,
      area: 'registro', link: `/teacher/primaria/${lezione.section_id}/registro`,
    })
    logEvento('registro', 'info', {
      operazione, esito: 'allegato-ripristinato', allegato_id: id, registro_id: lezione.id, riagganciato,
    })

    return NextResponse.json({ success: true, data: tornato, riagganciato })
  } catch (err) {
    logErrore({ operazione, stato: 500 }, err)
    return NextResponse.json({ error: 'Errore interno', codice: 'ALLEGATO_REGISTRO_SCRITTURA_FALLITA' }, { status: 500 })
  }
})
