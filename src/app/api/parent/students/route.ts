import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { getFigliAttiviDiGenitore } from '@/lib/anagrafiche/legami'
import type { MotivoFiglioNascosto } from '@/lib/alunni/attivo'
import { parseAnagraficaSede, type AnagraficaSede } from '@/lib/scuole/anagrafica'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `userId` in query è consumato dal gate identità (requireUser), non dall'handler.
const getQuerySchema = z.object({}) // nessun parametro in ingresso

// GET /api/parent/students?userId=  — lista degli alunni collegati al genitore.
export const GET = withRoute('parent/students:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    // ── CHI ENTRA IN QUESTA LISTA ENTRA IN TUTTA L'APP DI FAMIGLIA ───────────
    //
    // Unione runtime (legame_genitori_alunni) + anagrafica (student_parents via
    // parents.auth_user_id): risolve i figli anche se il legame è presente in una
    // sola delle due tabelle (fix contesto figlio per mensa/chat/pagamenti).
    //
    // Ma i legami da soli NON bastavano, e fino al 2026-09-05 qui c'era il solo
    // `.in('id', ids)`: nessun filtro su `section_id`, `stato`, `archiviato_il`.
    // Da questa risposta escono lo `studentId` di `useParentIdentity` e le chip
    // del `ChildSwitcher`, quindi un bambino senza classe — o archiviato — entrava
    // in ogni schermata e poi spariva a pezzi: moduli e avvisi di classe, news di
    // grado, agenda di sezione, materiali dell'armadietto, l'area primaria intera
    // e le rette, che `genera-rette` non produce per chi non ha classe. Nessun
    // errore, nessun log: solo schermate vuote sparse.
    //
    // Il filtro sta in `getFigliAttiviDiGenitore` e NON dentro `getFigliDiGenitore`
    // (14 chiamanti, tre dei quali economici): un figlio ritirato con pagamenti
    // aperti deve restare visibile a `api/pagamenti`, e lo resta.
    const esito = await getFigliAttiviDiGenitore(supabase, auth.user.id)
    if (esito.errore) throw esito.errore
    const rows = esito.righe

    // ── «NESSUN FIGLIO» E «FIGLI NON ANCORA VISIBILI» NON SONO LA STESSA COSA ─
    //
    // Misurato in produzione: 4 account genitore vedrebbero SOLO figli filtrati.
    // Senza questo campo la loro app sarebbe identica a quella di chi non ha
    // proprio figli — cioè vuota e senza spiegazione, mentre la risposta giusta è
    // «l'iscrizione è in lavorazione, si rivolga alla segreteria». È additivo:
    // chi legge solo `data` non se ne accorge.
    const inAttesa = rows.length === 0 && esito.totaleLegami > 0

    // ── UN BOOLEANO SOLO DICEVA IL FALSO A UN QUARTO DI QUELLE FAMIGLIE ──────
    //
    // I motivi per cui un figlio sparisce sono TRE, e il repo li tiene distinti
    // apposta (`MotivoFiglioNascosto` in `@/lib/alunni/attivo`: archiviato ·
    // ritirato · senza-sezione). `in_attesa` li collassava in un `true`, e da un
    // `true` esce UNA frase sola: «Stiamo completando l'iscrizione: appena la
    // classe è assegnata qui compare tutto».
    //
    // Rimisurato sul database di produzione il 2026-09-06 (conteggi soli, nessuna
    // riga di anagrafica letta): dei 4 account senza figli visibili, 3 hanno
    // l'unico figlio SENZA SEZIONE — per loro quella frase è vera — e 1 ce l'ha
    // ARCHIVIATO. A quella famiglia l'app prometteva il completamento di
    // un'iscrizione che non esiste e una classe che non arriverà: la stessa
    // classe di difetto che il filtro doveva chiudere, rimasta aperta su un
    // quarto delle persone. Il dato per distinguerle era già calcolato qui
    // accanto (`esito.nascosti`): veniva solo buttato via.
    //
    // ⚠️ LA PRECEDENZA È ROVESCIATA RISPETTO A `motivoNascosto`, e non per
    // distrazione. Là si classifica UNA riga, e `archiviato` viene per primo
    // perché un archiviato ha quasi sempre anche `stato='ritirato'` e
    // `section_id` nullo: contarlo tre volte gonfierebbe i conteggi. Qui si
    // sceglie quale FRASE leggerà una famiglia che può avere più figli nascosti
    // per motivi diversi, e «l'iscrizione è in lavorazione» resta VERA appena UNO
    // dei figli sta aspettando la classe — mentre «non risulta più iscritto»
    // mentirebbe al fratello che invece si sta iscrivendo. Fra le due si dice
    // quella che non mente a nessuno. Oggi in produzione nessun account ha motivi
    // misti (misurato: 0 su 4), quindi questa riga non cambia niente adesso:
    // decide il giorno in cui il primo comparirà.
    //
    // ⚠️ `null` ANCHE CON `in_attesa` VERO, ed è un caso reale: un legame che
    // punta a una riga di `alunni` che non c'è più non produce nessun motivo
    // (`nascosti` tutti a zero). Il client cade allora sulla frase di prima, cioè
    // sul comportamento di ieri — un campo nuovo non deve poter svuotare una
    // schermata che oggi funziona.
    const motivoAssenza: MotivoFiglioNascosto | null = !inAttesa
      ? null
      : esito.nascosti['senza-sezione'] > 0
        ? 'senza-sezione'
        : esito.nascosti.ritirato > 0
          ? 'ritirato'
          : esito.nascosti.archiviato > 0
            ? 'archiviato'
            : null

    if (rows.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        in_attesa: inAttesa,
        // `in_attesa` resta, e non è ridondanza: è il campo che i chiamanti già
        // scritti leggono. Toglierlo per «tenere un campo solo» spegnerebbe la
        // schermata di cortesia su ogni client più vecchio del server, cioè
        // durante ogni rilascio.
        motivo_assenza: motivoAssenza,
      })
    }

    // Arricchimento sede PER FIGLIO (multi-sede): scuola_id è soft-ref senza FK
    // → lookup separato sugli id distinti. Best-effort: un errore qui non fa
    // fallire la lista figli (campi a null) — regge anche il DB E2E CI non migrato.
    const scuolaIds = [...new Set(rows.map(r => r.scuola_id).filter(Boolean))] as string[]
    const scuolaById = new Map<string, { nome: string | null; citta: string | null; indirizzo: string | null; anagrafica: AnagraficaSede }>()
    if (scuolaIds.length > 0) {
      const { data: scuole } = await supabase
        .from('scuole')
        .select('id, nome, citta, indirizzo, config')
        .in('id', scuolaIds)
      for (const s of scuole ?? []) {
        scuolaById.set(s.id as string, {
          nome: (s.nome as string | null) ?? null,
          citta: (s.citta as string | null) ?? null,
          indirizzo: (s.indirizzo as string | null) ?? null,
          anagrafica: parseAnagraficaSede(s.config),
        })
      }
    }

    // Contratto additivo: shape esistente ({ success, data }) + campi scuola_*.
    const enriched = rows.map(r => {
      const info = r.scuola_id ? scuolaById.get(r.scuola_id) : undefined
      return {
        ...r,
        scuola_nome: info?.nome ?? null,
        scuola_citta: info?.citta ?? null,
        scuola_indirizzo: info?.indirizzo ?? null,
        scuola_cap: info?.anagrafica.cap ?? null,
        scuola_provincia: info?.anagrafica.provincia ?? null,
        scuola_codice_meccanografico: info?.anagrafica.codice_meccanografico ?? null,
      }
    })

    return NextResponse.json({ success: true, data: enriched, in_attesa: false, motivo_assenza: null })
  } catch (err) {
    logErrore({ operazione: 'parent/students:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
