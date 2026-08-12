import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { STATI_NON_PIU_ISCRITTO, STATO_ISCRITTO, eNonPiuIscritto } from '@/lib/alunni/stato'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// Lista "diritto all'oblio" (DL-034): alunni NON iscritti e non ancora
// anonimizzati, con i genitori collegati. Riservata alla Direzione.

const DIREZIONE = ['admin', 'coordinator'] as const

/** Il nome dell'operazione nei log applicativi. */
const OP = 'admin/gdpr/candidates:GET'

export const GET = withRoute('admin/gdpr/candidates:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request, [...DIREZIONE])
  if (auth.response) return auth.response

  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response

  const supabase = await createAdminClient()

  // Isolamento per sede: `coordinator` è mono-plesso per progetto, ma senza
  // questo filtro vedeva nomi e cognomi dei minori non iscritti — e dei loro
  // genitori — di TUTTE le sedi. L'admin resta multi-plesso, ristretto alle sedi
  // attive nel selettore. Scope vuoto ⇒ nessun candidato.
  const plessi = await resolveScuoleAttive(request, supabase, auth.user)

  // `scuola_id` è nella proiezione perché il pannello lo MOSTRA: l'oblio è
  // irreversibile e si conferma digitando un nominativo, che con tre plessi non
  // è più univoco. Senza questa colonna la Direzione anonimizzerebbe un minore
  // senza aver mai visto in quale sede si trova.
  const { data: alunni, error } = await supabase
    .from('alunni')
    .select('id, nome, cognome, classe_sezione, stato, scuola_id')
    .in('scuola_id', plessi)
    // ELENCO, non negazione. Fino al 2026-08-12 qui c'era `.neq('stato',
    // 'iscritto')`: la tendina dello stato offre anche `sospeso`, quindi un
    // bambino soltanto sospeso — iscritto a tutti gli effetti — compariva fra i
    // candidati a un'anonimizzazione che non ha annulla. Una negazione accoglie
    // ogni valore futuro senza chiedere il permesso; questo elenco no.
    .in('stato', [...STATI_NON_PIU_ISCRITTO])
    .is('anonimizzato_il', null)
    .order('cognome', { ascending: true })
  // La lettura che decide l'elenco: se fallisce, la Direzione vede una schermata
  // d'errore e nessuno sa perché. `withRoute` marca il 5xx ma non ne conosce la
  // causa — il corpo dell'errore ce l'ha solo chi lo riceve, ed è la stessa
  // ragione per cui `403` senza corpo tenne nascosto per mesi il guasto delle
  // email. La risposta resta identica: qui si aggiunge la riga, non un canale.
  if (error) {
    logErrore({ operazione: OP, stato: 500, evento: 'db' }, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const ids = (alunni ?? []).map((a: { id: string }) => a.id)
  let links: { student_id: string; parent_id: string }[] = []
  let parents: { id: string; first_name: string | null; last_name: string | null }[] = []
  if (ids.length > 0) {
    const { data: l } = await supabase
      .from('student_parents')
      .select('student_id, parent_id')
      .in('student_id', ids)
    links = (l as typeof links) ?? []
    const parentIds = Array.from(new Set(links.map((x) => x.parent_id)))
    if (parentIds.length > 0) {
      const { data: p } = await supabase
        .from('parents')
        .select('id, first_name, last_name')
        .in('id', parentIds)
      parents = (p as typeof parents) ?? []
    }
  }

  // ─── CHI L'ELENCO CHIUSO HA LASCIATO FUORI ─────────────────────────────────
  //
  // È QUI che un bambino sparisce in silenzio, e fino al 2026-08-12 questa route
  // non lo diceva a nessuno. La Direzione apre il pannello, legge «Nessun alunno
  // non iscritto da anonimizzare» e chiude: se un minore aveva uno stato fuori
  // dall'allowlist — un `trasferito`, un refuso, uno stato che qualcuno
  // aggiungerà alla tendina — non compariva, e non esisteva UNA riga che dicesse
  // quanti fossero né con quale stato. Il 409 di `erase` non copre questo caso:
  // dall'interfaccia non si raggiunge, perché al POST arrivano solo gli `id` che
  // QUESTA lista ha già ammesso.
  //
  // La sonda è volutamente povera: legge la sola colonna `stato` (nessun nome,
  // nessun cognome, nessuna PII) delle righe non ancora anonimizzate degli
  // stessi plessi, e conta quelle che non sono né iscritte né nell'allowlist.
  // Un guasto di questa lettura non deve rompere l'elenco: si logga e si tira
  // dritto — l'elenco dei candidati l'ha già prodotto la query sopra, che il suo
  // errore lo controlla.
  //
  // `count: 'exact'` non è ornamento: PostgREST può tagliare le righe a un tetto
  // di configurazione, e un conteggio fatto sulle sole righe ARRIVATE mentirebbe
  // verso il basso — cioè direbbe «nessuno escluso» proprio quando ce ne sono
  // troppi. Se i due numeri divergono si logga `troncato`, invece di far finta.
  const { data: tutti, count, error: errStati } = await supabase
    .from('alunni')
    .select('stato', { count: 'exact' })
    .in('scuola_id', plessi)
    .is('anonimizzato_il', null)
  if (errStati) {
    logErrore({ operazione: OP, evento: 'db' }, errStati)
  } else {
    const letti = (tutti ?? []) as { stato: string | null }[]
    const fuoriElenco = letti
      .map((a) => a.stato ?? STATO_ISCRITTO)
      .filter((s: string) => s !== STATO_ISCRITTO && !eNonPiuIscritto(s))

    // ⚠️ IL SEPARATORE NON È UNA SCELTA ESTETICA. `tipo` è in lista bianca, ma
    // «la chiave apre, il VALORE conferma»: esce in chiaro solo se ha la forma di
    // un enumerato (`FORMA_ENUMERATO` in `@/lib/logging/redact` — niente spazi,
    // massimo 64 caratteri, e un alfabeto che NON contiene la barra verticale).
    // Con un `|` in mezzo la riga sarebbe arrivata in tabella redatta: il log ci
    // sarebbe e non direbbe niente, che è il modo peggiore di avere un log.
    // Oltre i 64 caratteri si perderebbe TUTTO, quindi si prendono gli stati che
    // ci stanno e a dire quanti erano davvero ci pensa `n_stati`.
    const distinti = Array.from(new Set(fuoriElenco)).sort()
    const nominati: string[] = []
    for (const s of distinti) {
      if ([...nominati, s].join('/').length > 64) break
      nominati.push(s)
    }
    // Si logga anche lo ZERO. Con i soli casi diversi da zero, «nessuna riga»
    // non distingue «non c'era nessuno da escludere» da «la sonda non è mai
    // partita» — l'ambiguità che ha nascosto per mesi il guasto delle email.
    // `gdpr` è in EVENTI_PERSISTITI, quindi la domanda «l'elenco era vuoto
    // davvero?» ha una query invece di un'opinione.
    logEvento('gdpr', fuoriElenco.length > 0 ? 'warn' : 'info', {
      operazione: OP,
      esito: fuoriElenco.length > 0 ? 'candidati-esclusi-fuori-elenco' : 'candidati-elencati',
      entita_tipo: 'alunni',
      n_candidati: ids.length,
      n_esclusi: fuoriElenco.length,
      // Vero solo se la sonda ha visto meno righe di quante ce ne siano: allora
      // `n_esclusi` è un minimo, non il numero. Meglio saperlo che crederci.
      troncato: typeof count === 'number' && count > letti.length,
      // Gli stati esclusi, distinti e ordinati: senza, «3 esclusi» non dice se
      // manca una voce all'allowlist o se qualcuno ha scritto un refuso in
      // colonna. Uno stato non è un dato personale — e se mai lo diventasse
      // (testo libero, spazi) la redazione lo copre da sola.
      tipo: nominati.join('/') || 'nessuno',
      n_stati: distinti.length,
    })
  }

  const parentById = new Map(parents.map((p) => [p.id, p]))
  const result = (alunni ?? []).map((a: { id: string }) => {
    const genitori = links
      .filter((x) => x.student_id === a.id)
      .map((x) => parentById.get(x.parent_id))
      .filter(Boolean)
      .map((p) => ({ id: p!.id, nome: `${p!.first_name ?? ''} ${p!.last_name ?? ''}`.trim() }))
    return { ...a, genitori }
  })

  return NextResponse.json(result)
})
