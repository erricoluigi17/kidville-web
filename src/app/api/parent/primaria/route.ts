import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { limitaAiFatti } from '@/lib/presenze/finestra-trascorsa'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { firmaPercorsi, percorsoNelBucket } from '@/lib/allegati/storage'

// ─── IL CONTENITORE DEGLI ALLEGATI DEL REGISTRO ──────────────────────────────
//
// È PRIVATO (`public: false`, deciso in `primaria/allegati:POST`), e in tabella
// `allegati_registro.file_url` porta il PERCORSO dentro il contenitore
// (`registro/<uuid>/<timestamp>-<rnd>.jpg`), non un indirizzo: l'indirizzo lo
// genera la LETTURA, firmato e a scadenza breve, dietro al gate della route che
// lo serve. Stesso modello di galleria, avvisi, incarichi e chat.
//
// Il nome è ripetuto qui perché `primaria/allegati/route.ts` lo tiene in una
// `const` non esportata. Due stringhe uguali in due file sono due cose da tenere
// allineate: la casa giusta è `@/lib/allegati/storage`, accanto a
// `BUCKET_AVVISI_ALLEGATI` e `BUCKET_TASK_ALLEGATI`, insieme alle altre due
// route che lo nominano (`primaria/allegati`, `primaria/registro`).
const BUCKET_REGISTRO_ALLEGATI = 'registro-allegati'

/** Un allegato come esce dal join `allegati_registro(...)`. */
type AllegatoRegistro = {
  id: string
  tipo: string | null
  file_url: string | null
  file_name: string | null
}

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi degrada a 404 dalla
// query su `alunni` — stesso criterio di parent/competenze.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
})

// GET /api/parent/primaria?studentId=&userId=
// Vista genitore (read-only) del registro primaria del figlio, con OSCURAMENTO:
// gli argomenti/compiti "propri" del docente di sostegno sono visibili solo se il
// figlio è tra i destinatari. Valutazioni mostrate dopo il buffer notifica.
export const GET = withRoute('parent/primaria:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId } = q.data

    // ─── IL CONTROLLO ERA SCRITTO COME UN PERMESSO, E PER METÀ DEGLI ATTORI
    //     NON CONTROLLAVA NIENTE ─────────────────────────────────────────────
    //
    // Diceva:
    //   `if (agisceComeGenitore(auth.user)) { …serve il legame col bambino… }`
    // cioè «se stai guardando in veste di famiglia e quel bambino non è tuo
    // figlio, ti nego». Per chiunque NON agisse da genitore — un educator di
    // un'altra sezione o di un'altra sede, la cuoca, la segreteria di un altro
    // plesso — il controllo non era permissivo: NON C'ERA. Il gate a monte era
    // `requireUser`, che ammette OGNI utente autenticato, e il client è
    // `createAdminClient()` (service-role), che scavalca la RLS: questa riga era
    // l'unica cosa fra un account qualunque e il registro di un minore indicato
    // per uuid — lezioni, valutazioni, NOTE DISCIPLINARI in testo libero e
    // assenze con lo stato della giustificazione.
    //
    // Il rimedio NON è scambiare il predicato con `eFamiglia`: lascerebbe in
    // piedi la stessa forma (nego a un genitore, non chiedo niente agli altri).
    // La domanda giusta non è «di che ruolo sei» ma «questo bambino ti è
    // raggiungibile?», e `requireParentOfStudent` la risponde per TUTTI: legame
    // di famiglia per chi è famiglia — biforcando sul LEGAME e non sulla veste,
    // così le cinque docenti-genitori aprono il registro del proprio figlio
    // anche fuori dalle sezioni che insegnano — plesso e sezione per tutti gli
    // altri, che è il perimetro con cui l'educator continua a leggere i bambini
    // delle proprie classi e la segreteria tutte le classi del proprio plesso.
    //
    // Era l'ULTIMA delle otto route della primaria senza questo gate: le sette
    // sorelle (`{assenze,note,orario,pagella,scrutinio,valutazioni}:GET` e
    // `pagella/firma:POST`) ci passano già, e servono gli stessi dati.
    //
    // Il gate sta PRIMA di `createAdminClient()`: dopo un 403 non deve partire
    // nemmeno una lettura.
    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    const { data: alunno } = await supabase
      .from('alunni')
      .select('id, nome, cognome, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    // Tipo scuola della sezione (per la vista adattiva lato client).
    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez } = await supabase.from('sections').select('school_type').eq('id', alunno.section_id).maybeSingle()
      schoolType = sez?.school_type ?? null
    }

    if (schoolType !== 'primaria') {
      return NextResponse.json({ success: true, data: { schoolType, child: alunno, lezioni: [], valutazioni: [], note: [], assenze: [], materie: [] } })
    }

    // Buffer notifica (per la visibilità delle valutazioni).
    const { data: settings } = await supabase
      .from('admin_settings')
      .select('notif_buffer_valutazioni_min')
      .eq('scuola_id', alunno.scuola_id)
      .maybeSingle()
    const bufferMin = settings?.notif_buffer_valutazioni_min ?? 10
    const sogliaVal = new Date(Date.now() - bufferMin * 60_000).toISOString()

    // Ultimi 14 giorni di registro per la sezione.
    const da = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)

    const [{ data: registro }, { data: valutazioni }, { data: note }, { data: assenze }, { data: materie }] = await Promise.all([
      supabase
        .from('registro_orario')
        .select(`
          id, data, ora_lezione, materia, argomento, compiti, data_consegna_compiti,
          materie(nome),
          firme_docenti(id, argomento_proprio, compiti_propri),
          registro_destinatari(firma_id, alunno_id),
          allegati_registro(id, tipo, file_url, file_name)
        `)
        .eq('section_id', alunno.section_id)
        .gte('data', da)
        .order('data', { ascending: false })
        .order('ora_lezione'),
      supabase
        .from('valutazioni')
        .select('id, materia, tipo, modalita, argomento, giudizio_sintetico, giudizio_testo, creato_il')
        .eq('alunno_id', studentId)
        .not('modalita', 'is', null)
        .lte('creato_il', sogliaVal)
        .order('creato_il', { ascending: false }),
      supabase
        .from('note_disciplinari')
        .select('id, categoria, testo, richiede_firma, firmata_il, creato_il')
        .eq('alunno_id', studentId)
        .order('creato_il', { ascending: false }),
      // Assenze/ritardi/uscite degli ultimi 30 giorni, con stato giustificazione.
      //
      // Il tetto a OGGI (rilievo T26): questa lettura non aveva alcun limite
      // superiore, e da quando «Comunica un'assenza» scrive nel futuro un giorno
      // non ancora arrivato sarebbe comparso fra le assenze del bambino. Oggi è
      // latente — il suo unico consumatore, `PrimariaParentView`, non è montato
      // da nessuna pagina — ma è una porta aperta, e la regola sta in un posto
      // solo (`@/lib/presenze/finestra-trascorsa`). Con Q4 il tetto porta anche
      // il secondo asse (la SORGENTE): il solo `data <= oggi` non esclude
      // l'assenza annunciata per il giorno corrente.
      limitaAiFatti(
        supabase
          .from('presenze')
          .select('id, data, stato, giustificata, giustificazione_testo, giust_vista_il')
          .eq('alunno_id', studentId)
          .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
          .gte('data', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)),
      ).order('data', { ascending: false }),
      // Materie della sezione (per il selettore della giustifica didattica).
      supabase
        .from('materie')
        .select('id, nome')
        .eq('section_id', alunno.section_id)
        .eq('attiva', true)
        .order('ordine'),
    ])

    // ─── L'ALLEGATO USCIVA COME PERCORSO, CIOÈ COME LINK MORTO ───────────────
    //
    // `file_url` è un percorso dentro un contenitore PRIVATO. Restituito grezzo,
    // il browser della famiglia lo risolveva come indirizzo RELATIVO
    // (`https://app.kidville.it/parent/compiti/registro/<uuid>/…`) e rispondeva
    // 404: nessun errore, nessun log, soltanto un allegato che non si apre.
    //
    // Si firma IN BLOCCO — una chiamata allo Storage per pagina, non una per
    // allegato — con la stessa funzione di avvisi, incarichi e chat: stesso TTL
    // (10 minuti), stesso log col corpo dell'errore del provider, stessa
    // gestione del fallimento. Una firma inventata qui sarebbe una quinta forma
    // da tenere allineata.
    //
    // Il percorso si calcola UNA volta per allegato e si riusa: la funzione che
    // decide che cosa firmare dev'essere la stessa che decide che cosa
    // sostituire, altrimenti le due strade possono divergere in silenzio.
    const percorsoPerAllegato = new Map<string, string | null>()
    for (const r of registro ?? []) {
      for (const a of (r.allegati_registro ?? []) as AllegatoRegistro[]) {
        percorsoPerAllegato.set(a.id, percorsoNelBucket(BUCKET_REGISTRO_ALLEGATI, a.file_url))
      }
    }
    const percorsi = [...new Set([...percorsoPerAllegato.values()].filter((p): p is string => p !== null))]
    // `firmaPercorsi` con l'elenco vuoto non tocca lo Storage: la lezione senza
    // allegati non paga niente.
    const urlFirmato = await firmaPercorsi(
      supabase,
      BUCKET_REGISTRO_ALLEGATI,
      percorsi,
      'parent/primaria:GET',
    )

    // Applica oscuramento: contenuti "propri" visibili solo se il figlio è destinatario.
    const lezioni = (registro ?? []).map((r) => {
      const firme = (r.firme_docenti ?? []) as { id: string; argomento_proprio: string | null; compiti_propri: string | null }[]
      const dest = (r.registro_destinatari ?? []) as { firma_id: string; alunno_id: string }[]
      const extra = firme
        .filter((f) => (f.argomento_proprio || f.compiti_propri) && dest.some((d) => d.firma_id === f.id && d.alunno_id === studentId))
        .map((f) => ({ argomento: f.argomento_proprio, compiti: f.compiti_propri }))
      return {
        id: r.id,
        data: r.data,
        ora_lezione: r.ora_lezione,
        materia: (r.materie as { nome?: string } | null)?.nome ?? r.materia,
        argomento: r.argomento,
        compiti: r.compiti,
        data_consegna_compiti: r.data_consegna_compiti,
        // Chi non si è potuto firmare esce con `file_url: null` — MAI il
        // percorso grezzo, che come indirizzo non funziona lo stesso e
        // maschererebbe un guasto dello Storage da «allegato rotto». Il client
        // non rende nessuna ancora per un allegato senza indirizzo.
        allegati: ((r.allegati_registro ?? []) as AllegatoRegistro[]).map((a) => {
          const p = percorsoPerAllegato.get(a.id) ?? null
          return {
            id: a.id,
            tipo: a.tipo,
            file_name: a.file_name,
            file_url: p === null ? null : (urlFirmato.get(p) ?? null),
          }
        }),
        individualizzate: extra,
      }
    })

    return NextResponse.json({
      success: true,
      data: { schoolType, child: alunno, lezioni, valutazioni: valutazioni ?? [], note: note ?? [], assenze: assenze ?? [], materie: materie ?? [] },
    })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
