import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { PRESA_VISIONE_AZZERATA, puoAnnullarePresaVisione } from '@/lib/presenze/presa-visione'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const postBodySchema = z.object({
  presenzaId: zUuid,
})

// POST /api/primaria/presenze/giust-vista?userId=
// body: { presenzaId }
// Il docente registra la presa visione della giustifica del genitore.
export const POST = withRoute('primaria/presenze/giust-vista:POST', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { presenzaId } = b.data

    const supabase = await createAdminClient()
    // Risolve la presenza → section_id e ne verifica lo scope prima dell'update.
    const { data: presenza } = await supabase
      .from('presenze')
      .select('id, section_id')
      .eq('id', presenzaId)
      .maybeSingle()
    if (!presenza) return NextResponse.json({ error: 'Presenza non trovata' }, { status: 404 })
    const scopeErr = await assertSezioneInScope(supabase, auth.user, presenza.section_id as string)
    if (scopeErr) return scopeErr

    // SI CHIEDONO SEI COLONNE, NON VENTICINQUE. `.select()` nudo è `select *`, e
    // su un UPDATE PostgREST restituisce la riga INTERA: `giustificazione_firma`
    // (email, indirizzo IP e user-agent del genitore firmatario) e
    // `giustificazione_testo` (dato sanitario del minore) tornavano al browser
    // del docente senza che nessuna schermata li usasse — la pagina della presa
    // visione controlla `res.ok` e ricarica. `giustificata_da` e `alunno_id`
    // restano: servono qui sotto per avvisare il genitore che ha giustificato.
    const { data: updated, error } = await supabase
      .from('presenze')
      .update({ giust_vista_il: new Date().toISOString(), giust_vista_da: userId })
      .eq('id', presenzaId)
      .eq('giustificata', true)
      .select('id, alunno_id, data, giustificata, giustificata_da, giust_vista_il')
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!updated) return NextResponse.json({ error: 'Presenza non giustificata o inesistente' }, { status: 404 })

    // Conferma al genitore che ha giustificato (best-effort).
    try {
      const genitoreId = (updated as { giustificata_da?: string | null }).giustificata_da
      const alunnoId = (updated as { alunno_id?: string | null }).alunno_id
      if (genitoreId && genitoreId !== userId) {
        const { data: alunno } = await supabase
          .from('alunni')
          .select('nome, scuola_id')
          .eq('id', alunnoId)
          .maybeSingle()
        await notificaEvento(supabase, {
          tipo: 'giustifica_vista',
          scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
          utenteIds: [genitoreId],
          titolo: 'Giustifica presa in visione',
          corpo: `La giustifica${alunno?.nome ? ` di ${alunno.nome}` : ''} è stata presa in visione dal docente.`,
          link: '/parent/primaria/assenze',
          entitaTipo: 'presenza',
          entitaId: presenzaId,
        })
      }
    } catch (e) {
      logEvento('notifica', 'error', {
        operazione: 'primaria/presenze/giust-vista:POST',
        tipo: 'giustifica_vista',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, data: updated })
  } catch (err) {
    logErrore({ operazione: 'primaria/presenze/giust-vista:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})

/**
 * ─── DELETE /api/primaria/presenze/giust-vista?presenzaId=&vistaIl= — ANNULLA LA PRESA VISIONE ─
 *
 * Spec 2026-09-24, punto 2 (primaria): «Annulla presa visione» della giustifica.
 * Azzera INSIEME `giust_vista_il` e `giust_vista_da` (`PRESA_VISIONE_AZZERATA`: le
 * due colonne viaggiano sempre in coppia, vedi `@/lib/presenze/presa-visione`).
 * Giustifica, motivo e firma del genitore restano intatti: si toglie la LETTURA,
 * non la comunicazione.
 *
 * CHI: il docente che l'ha presa (`giust_vista_da`), oppure Segreteria e Direzione
 * (`segreteria`/`admin`/`coordinator`, sui ruoli REALI — il cookie del ruolo attivo
 * sceglie una vista, non apre una porta). Sempre dentro lo scope della classe.
 * NESSUN TERMINE: la spec non ne pone per questo gesto.
 *
 * Nessun avviso al genitore (spec: «nessun avviso quando si modifica o elimina»).
 *
 * QUALE presa visione: la pagina manda `vistaIl`, il `giust_vista_il` che la GET
 * dell'appello le ha dato — la lettura che la persona AVEVA A SCHERMO quando ha
 * confermato. La finestra che conta è quella di minuti fra il caricamento della
 * pagina e il clic, non quella di millisecondi dentro la route: se nel frattempo la
 * presa visione è stata tolta e rifatta (da un altro docente, o dallo stesso), la
 * riga in tabella non è più quella e si risponde 409 `PRESA_VISIONE_CAMBIATA` PRIMA
 * del permesso — altrimenti la Segreteria, che passa il permesso su qualunque
 * presa visione, cancellerebbe una lettura che non ha mai visto, con un 200 e un
 * messaggio che dice di aver tolto quella che aveva davanti. La UPDATE è
 * condizionata allo stesso valore, così anche la corsa fra lettura e scrittura
 * finisce in 409 senza toccare niente.
 */
const deleteQuerySchema = z.object({
  presenzaId: zUuid,
  // Stringa data-ora con fuso, come la scrive PostgREST (`…T07:30:00.123456+00:00`).
  vistaIl: z.iso.datetime({ offset: true, error: 'Presa visione non valida (atteso data e ora)' }),
})

/**
 * Stesso istante al microsecondo, anche se scritto in due forme (`Z` o `+00:00`,
 * decimali con o senza zeri in coda). PostgREST scrive lo stesso valore sempre
 * nella stessa forma, quindi di norma basta il confronto fra stringhe; il resto
 * evita un 409 falso se un giorno la forma cambiasse fra la GET e questa lettura.
 */
function stessoIstante(a: string, b: string): boolean {
  if (a === b) return true
  const micro = (s: string): string | null => {
    const decimali = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(s)?.[1] ?? ''
    const secondi = Date.parse(s.replace(/(T\d{2}:\d{2}:\d{2})\.\d+/, '$1'))
    if (Number.isNaN(secondi)) return null
    return `${secondi}.${decimali.padEnd(6, '0').slice(0, 6)}`
  }
  const ma = micro(a)
  return ma !== null && ma === micro(b)
}

const OP_DELETE = 'primaria/presenze/giust-vista:DELETE'

/** Il guasto (lettura o scrittura): al client il codice, il `message` resta nel log. */
function presaVisioneNonAnnullata(): NextResponse {
  return NextResponse.json(
    { error: 'Presa visione non annullata', codice: 'PRESA_VISIONE_NON_ANNULLATA' },
    { status: 500 },
  )
}

export const DELETE = withRoute('primaria/presenze/giust-vista:DELETE', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, deleteQuerySchema)
    if ('response' in q) return q.response
    const { presenzaId, vistaIl: vistaIlVista } = q.data

    const supabase = await createAdminClient()

    // Solo le colonne che servono a decidere: né il motivo (dato sanitario di un
    // minore) né la firma del genitore escono da questa lettura.
    const { data: riga, error: letturaErr } = await supabase
      .from('presenze')
      .select('id, section_id, scuola_id, giustificata, giust_vista_il, giust_vista_da')
      .eq('id', presenzaId)
      .maybeSingle()
    if (letturaErr) {
      logEvento('db', 'error', { operazione: OP_DELETE, esito: 'presenza-non-letta', presenza: presenzaId }, letturaErr)
      return presaVisioneNonAnnullata()
    }
    if (!riga) {
      return NextResponse.json(
        { error: 'Presenza non trovata', codice: 'PRESA_VISIONE_PRESENZA_NON_TROVATA' },
        { status: 404 },
      )
    }

    // LO SCOPE PRIMA DEL PERMESSO: fuori dalla propria classe (o dal proprio plesso)
    // non si scopre nemmeno se la presa visione c'è e di chi è.
    const sectionId = riga.section_id as string
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    const vistaIl = (riga.giust_vista_il as string | null) ?? null
    const vistaDa = (riga.giust_vista_da as string | null) ?? null
    if (!vistaIl) {
      return NextResponse.json(
        { error: 'Nessuna presa visione da annullare', codice: 'PRESA_VISIONE_ASSENTE' },
        { status: 409 },
      )
    }

    // La presa visione in tabella deve essere QUELLA che la persona aveva a schermo.
    // Prima del permesso: se è cambiata, il permesso andrebbe deciso su una lettura
    // che nessuno ha visto, e la risposta giusta non è un 403 né un 200 ma «rileggi».
    if (!stessoIstante(vistaIl, vistaIlVista)) {
      logEvento('registro', 'warn', {
        operazione: OP_DELETE,
        esito: 'presa-visione-cambiata-dalla-lettura',
        presenza: presenzaId,
        sezione: sectionId,
      })
      return NextResponse.json(
        { error: 'Presa visione cambiata nel frattempo', codice: 'PRESA_VISIONE_CAMBIATA' },
        { status: 409 },
      )
    }

    // La regola sta in `@/lib/presenze/presa-visione`: è la stessa che la GET
    // dell'appello usa per decidere se offrire il comando.
    const autore = vistaDa !== null && vistaDa === auth.user.id
    if (!puoAnnullarePresaVisione(auth.user, { giust_vista_il: vistaIl, giust_vista_da: vistaDa })) {
      logEvento('auth', 'warn', {
        operazione: OP_DELETE,
        esito: 'presa-visione-altrui',
        presenza: presenzaId,
        sezione: sectionId,
        ruolo: auth.user.role,
      })
      return NextResponse.json(
        { error: 'Presa visione di un altro docente', codice: 'PRESA_VISIONE_NON_TUA' },
        { status: 403 },
      )
    }

    // Stessa riga letta qui sopra (id + classe verificata), e la presa visione
    // deve essere ANCORA quella che la persona aveva a schermo. Il valore del filtro
    // è quello letto, che qui sopra è risultato lo STESSO istante di `vistaIl` della
    // richiesta: si usa la forma scritta da PostgREST, che è quella della colonna.
    const { data: aggiornata, error: scritturaErr } = await supabase
      .from('presenze')
      .update({ ...PRESA_VISIONE_AZZERATA })
      .eq('id', presenzaId)
      .eq('section_id', sectionId)
      .eq('giust_vista_il', vistaIl)
      .select('id, giust_vista_il')
      .maybeSingle()
    if (scritturaErr) {
      logEvento('db', 'error', { operazione: OP_DELETE, esito: 'presa-visione-non-azzerata', presenza: presenzaId }, scritturaErr)
      return presaVisioneNonAnnullata()
    }
    if (!aggiornata) {
      logEvento('registro', 'warn', { operazione: OP_DELETE, esito: 'presa-visione-cambiata', presenza: presenzaId })
      return NextResponse.json(
        { error: 'Presa visione cambiata nel frattempo', codice: 'PRESA_VISIONE_CAMBIATA' },
        { status: 409 },
      )
    }

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'presenze',
      entitaId: presenzaId,
      azione: 'update',
      sectionId,
      // La sede è quella della RIGA, non quella dell'utente.
      scuolaId: (riga.scuola_id as string | null) ?? null,
      valorePrima: { id: presenzaId, giust_vista_il: vistaIl, giust_vista_da: vistaDa },
      valoreDopo: { id: presenzaId, ...PRESA_VISIONE_AZZERATA },
    })

    // Il successo si logga: senza, «nessun log» non distingue «annullata» da «mai partita».
    logEvento('registro', 'info', {
      operazione: OP_DELETE,
      esito: 'presa-visione-annullata',
      presenza: presenzaId,
      sezione: sectionId,
      da_autore: autore,
    })

    return NextResponse.json({ success: true, presenza: { id: presenzaId, giust_vista_il: null } })
  } catch (err) {
    logErrore({ operazione: OP_DELETE, stato: 500 }, err)
    return presaVisioneNonAnnullata()
  }
})
