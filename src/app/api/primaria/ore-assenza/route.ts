import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertSezioneInScope, assertAlunniInSezione } from '@/lib/auth/scope'
import {
  calcolaOreAssenza,
  calcolaOreAssenzaPerMateria,
  giornataDaCampanelle,
  type PresenzaInput,
  type PresenzaConData,
} from '@/lib/primaria/oreAssenza'
import { limitaAiFatti } from '@/lib/presenze/finestra-trascorsa'
import { parseQuery } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  sectionId: zUuid,
  // '' ammesso sui filtri opzionali: ?from=&to=&alunnoId= (vuoti) equivalgono ad assenti,
  // come oggi (la UI invia i filtri anche quando i campi data sono svuotati).
  from: zDataYMD.or(z.literal('')).optional(),
  to: zDataYMD.or(z.literal('')).optional(),
  alunnoId: zUuid.or(z.literal('')).optional(),
  // Semantica storica: solo il literal 'true' attiva il breakdown per materia.
  includiMaterie: z.string().optional(),
})

// GET /api/primaria/ore-assenza?sectionId=&from=&to=&alunnoId=&userId=&includiMaterie=true
// Monte ore di assenza (assenze intere + ritardi + permessi) per alunno.
// Con includiMaterie=true aggiunge il breakdown per materia.
export const GET = withRoute('primaria/ore-assenza:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { sectionId, from, to, alunnoId } = q.data
    const includiMaterie = q.data.includiMaterie === 'true'

    const supabase = await createAdminClient()
    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr
    if (alunnoId) {
      const alunnoErr = await assertAlunniInSezione(supabase, [alunnoId], sectionId)
      if (alunnoErr) return alunnoErr
    }

    // PostgREST NON LANCIA: ritorna `{ error }` (AGENTS.md, regola 7), e il
    // `try/catch` di questo handler su quel ramo non scatta mai. Le tre letture
    // qui sotto scartavano l'errore: una lettura fallita usciva come «monte ore
    // 0» dentro un 200 formalmente valido — «questo bambino non ha perso ore»
    // detto quando la query non ha funzionato, sul numero con cui si valuta la
    // validità dell'anno scolastico. Il degrado resta (la schermata mostra ciò
    // che ha), ma smette di essere MUTO.
    const degrado = (esito: string, err: unknown) => {
      logEvento('registro', 'error', {
        operazione: 'primaria/ore-assenza:GET',
        esito,
        sezione_id: sectionId,
      }, err)
    }

    // Campanelle della sezione (con id per il calcolo per materia).
    const { data: campanelle, error: campErr } = await supabase
      .from('campanelle')
      .select('id, giorno_settimana, ordine, ora_inizio, ora_fine, tipo')
      .eq('section_id', sectionId)
    if (campErr) degrado('campanelle-non-lette', campErr)
    const giornata = giornataDaCampanelle(campanelle ?? [])

    // Alunni della sezione.
    let alunniQuery = supabase.from('alunni').select('id, nome, cognome').eq('section_id', sectionId).order('cognome')
    if (alunnoId) alunniQuery = alunniQuery.eq('id', alunnoId)
    const { data: alunni, error: alunniErr } = await alunniQuery
    if (alunniErr) degrado('alunni-non-letti', alunniErr)

    // Presenze nel periodo.
    //
    // ─── SI CONTA CIÒ CHE È GIÀ ACCADUTO (rilievo T26) ─────────────────────
    //
    // Il tetto a OGGI non è ridondante rispetto al `to`: il `to` lo sceglie chi
    // guarda — la UI dell'appello lascia impostare «Dal/Al» a mano e il default
    // `annoScolasticoDefault()` arriva al 30/06 dell'anno successivo. Con
    // «Comunica un'assenza» il genitore può scrivere righe fino a sessanta
    // giorni nel futuro, e senza questa riga finivano nel monte ore: misurate
    // 5,25 ore perse per un giorno che non è ancora arrivato.
    //
    // La regola sta in `@/lib/presenze/finestra-trascorsa`, non qui: è la stessa
    // per tutti i lettori che AGGREGANO, e finora era stata scritta a mano su
    // due rotte su cinque.
    //
    // ⚠️ E IL TETTO TEMPORALE DA SOLO NON BASTA (Q4). `data <= oggi` non può
    // escludere una riga che cade su OGGI, che è il giorno preimpostato dal
    // modulo del genitore: misurate di nuovo 5,25 ore perse per un appello che
    // nessun docente aveva fatto. `limitaAiFatti` aggiunge il secondo asse — la
    // SORGENTE — allo stesso tetto.
    let presQuery = supabase
      .from('presenze')
      .select('alunno_id, data, stato, orario_entrata, orario_uscita')
      .eq('section_id', sectionId)
      .in('stato', ['assente', 'ritardo', 'uscita_anticipata'])
    if (from) presQuery = presQuery.gte('data', from)
    if (to) presQuery = presQuery.lte('data', to)
    presQuery = limitaAiFatti(presQuery)
    if (alunnoId) presQuery = presQuery.eq('alunno_id', alunnoId)
    const { data: presenze, error: presErr } = await presQuery
    if (presErr) degrado('presenze-non-lette', presErr)

    const perAlunnoBase = new Map<string, PresenzaInput[]>()
    const perAlunnoConData = new Map<string, PresenzaConData[]>()
    for (const p of presenze ?? []) {
      const base = perAlunnoBase.get(p.alunno_id) ?? []
      base.push({ stato: p.stato, orario_entrata: p.orario_entrata, orario_uscita: p.orario_uscita })
      perAlunnoBase.set(p.alunno_id, base)

      const conData = perAlunnoConData.get(p.alunno_id) ?? []
      conData.push({ stato: p.stato, orario_entrata: p.orario_entrata, orario_uscita: p.orario_uscita, data: p.data })
      perAlunnoConData.set(p.alunno_id, conData)
    }

    // Dati per il calcolo per materia (solo se richiesto).
    let orario: { campanella_id: string; giorno_settimana: number; materia_id: string | null }[] = []
    let materie: { id: string; nome: string }[] = []
    if (includiMaterie) {
      const [orarioRes, materieRes] = await Promise.all([
        supabase
          .from('orario_settimanale')
          .select('campanella_id, giorno_settimana, materia_id')
          .eq('section_id', sectionId),
        supabase
          .from('materie')
          .select('id, nome')
          .eq('section_id', sectionId)
          .eq('attiva', true),
      ])
      if (orarioRes.error) degrado('orario-non-letto', orarioRes.error)
      if (materieRes.error) degrado('materie-non-lette', materieRes.error)
      orario = orarioRes.data ?? []
      materie = materieRes.data ?? []
    }

    const data = (alunni ?? []).map((a) => {
      const riepilogo = calcolaOreAssenza(perAlunnoBase.get(a.id) ?? [], giornata)
      const entry: Record<string, unknown> = { alunnoId: a.id, nome: a.nome, cognome: a.cognome, ...riepilogo }
      if (includiMaterie) {
        const perMateria = calcolaOreAssenzaPerMateria(
          perAlunnoConData.get(a.id) ?? [],
          campanelle ?? [],
          orario,
          materie,
        )
        entry.perMateria = perMateria.perMateria
      }
      return entry
    })

    return NextResponse.json({ success: true, data, giornata })
  } catch (err) {
    logErrore({ operazione: 'primaria/ore-assenza:GET', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
