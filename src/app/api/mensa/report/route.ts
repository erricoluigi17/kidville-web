import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireKitchenRead } from '@/lib/auth/require-staff'
import { loadResolveOptions, loadMensaConfig, resolveMenuConfigId } from '@/lib/mensa/server'
import { resolveScuolaScrittura } from '@/lib/auth/scope'
import { resolveMenuGiorno, type MenuGiorno } from '@/lib/mensa/resolveMenu'
import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti'
import { allergeniAlunno, conflittiAllergie, allergeneLabel, type ConflittoAllergia } from '@/lib/mensa/allergeni'
import { parseQuery } from '@/lib/validation/http'
import { zDataYMD } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const getQuerySchema = z.object({
  // default dinamico (oggi) calcolato nell'handler
  data: zDataYMD.optional(),
  // stringa permissiva: oggi '' e valori non-uuid ricadono sui fallback `||` / query vuota
  scuola_id: z.string().optional(),
  sezione: z.string().optional(),
})

interface AlunnoRow {
  id: string
  nome: string
  cognome: string
  classe_sezione: string | null
  allergies: string | null
  allergeni: string[] | null
}

interface AlunnoReport {
  id: string
  nome: string
  classe: string
  allergeni: string[]            // allergeni effettivi dell'alunno
  conflitti: ConflittoAllergia[] // allergeni in conflitto col menu del giorno della SUA classe
}

// Alternativa automatica per allergia: un elemento per ogni prenotato con conflitti.
// Zero storage: derivata dal report. Solo metadati mostrabili, niente testo libero.
interface AlternativaAutomatica {
  alunno_id: string
  nome: string
  classe: string
  allergeni: string[]       // allergeni (chiavi) in conflitto col menu del giorno
  allergeni_label: string[] // etichette IT, per la UI
}

// Sentinella per il menu "legacy" (righe con menu_config_id null): una Map non
// può avere `null` come chiave stabile insieme a stringhe, quindi lo si mappa qui.
const MENU_LEGACY = '__legacy__'

// GET /api/mensa/report?userId=&data=&sezione=&scuola_id=
//   Pasti prenotati per classe CON i nomi dei bambini + allergie e conflitti
//   col menu del giorno RISOLTO PER CLASSE (mensa_class_menu_assignment).
//   - admin/coordinator/cuoca/segreteria: tutte le classi (filtro sezione opzionale)
//   - educator: SOLO la propria sezione (parametro `sezione` obbligatorio e verificato)
export const GET = withRoute('mensa/report:GET', async (request: NextRequest) => {
  try {
    const auth = await requireKitchenRead(request)
    if (auth.response) return auth.response
    const { user } = auth

    const qp = parseQuery(request, getQuerySchema)
    if ('response' in qp) return qp.response
    const data = qp.data.data ?? new Date().toISOString().slice(0, 10)
    const sezione = qp.data.sezione

    const supabase = await createAdminClient()

    // A8 — enforcement sezione docente: l'educator vede SOLO le proprie sezioni.
    // La sezione non è solo obbligatoria: deve appartenere all'insieme assegnato
    // (utenti_sezioni → sections.name). Altrimenti 403 + segnale di sicurezza.
    if (user.role === 'educator') {
      if (!sezione) {
        return NextResponse.json({ error: 'Parametro sezione obbligatorio per il ruolo insegnante' }, { status: 400 })
      }
      const mie = await nomiSezioniDiUtente(supabase, user.id)
      if (!mie.includes(sezione)) {
        // warn → persistito: «un docente ha chiesto il report di una sezione non sua».
        // Solo uuid utente + sezione richiesta: nessun nome, nessun dato di minori.
        logEvento('mensa', 'warn', { tipo: 'sezione-fuori-scope', utente: user.id, sezione })
        return NextResponse.json({ error: 'Sezione non assegnata al docente' }, { status: 403 })
      }
    }

    const sw = await resolveScuolaScrittura(request, supabase, user, qp.data.scuola_id ?? undefined)
    if (sw.response) return sw.response
    const scuolaId = sw.scuolaId as string

    // prenotazioni attive per la data
    const { data: pren, error: prenErr } = await supabase
      .from('mensa_prenotazioni')
      .select('alunno_id')
      .eq('data', data)
      .eq('stato', 'prenotato')
    if (prenErr) {
      logErrore({ operazione: 'mensa/report:GET', stato: 500 }, prenErr)
      return NextResponse.json({ error: 'Errore nel caricamento delle prenotazioni' }, { status: 500 })
    }
    const ids = (pren ?? []).map(p => p.alunno_id as string)
    if (ids.length === 0) {
      return NextResponse.json({ success: true, data: { data, totale: 0, perClasse: [], allergie: [], alternative_automatiche: [] } })
    }

    // anagrafica alunni prenotati (con allergie)
    let q = supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, allergies, allergeni')
      .in('id', ids)
      .eq('scuola_id', scuolaId)
    if (sezione) q = q.eq('classe_sezione', sezione)

    const { data: alunni, error: alunniErr } = await q
    if (alunniErr) {
      logErrore({ operazione: 'mensa/report:GET', stato: 500 }, alunniErr)
      return NextResponse.json({ error: 'Errore nel caricamento degli alunni' }, { status: 500 })
    }
    const rows = (alunni ?? []) as AlunnoRow[]

    // ── Menu PER CLASSE (B3) ─────────────────────────────────────────────────
    // I conflitti allergie vanno calcolati sul menu della classe di ciascun
    // alunno, non su un unico menu legacy. Si risolve UNA volta per classe
    // (configByClasse) e UNA volta per menu (menuByConfig), non per alunno.
    const config = await loadMensaConfig(supabase, scuolaId)

    const configByClasse = new Map<string | null, string | null>()
    for (const classe of new Set(rows.map(r => r.classe_sezione ?? null))) {
      configByClasse.set(classe, await resolveMenuConfigId(supabase, scuolaId, classe, data))
    }

    const menuByConfig = new Map<string, MenuGiorno>()
    for (const cfgId of new Set(configByClasse.values())) {
      const key = cfgId ?? MENU_LEGACY
      if (menuByConfig.has(key)) continue
      const options = await loadResolveOptions(supabase, scuolaId, config, cfgId)
      menuByConfig.set(key, resolveMenuGiorno(data, options))
    }

    // costruzione report per alunno
    const perClasseMap = new Map<string, AlunnoReport[]>()
    const allergie: { nome: string; classe: string; allergie: string; conflitto: boolean }[] = []
    const alternativeAutomatiche: AlternativaAutomatica[] = []

    for (const a of rows) {
      const classe = a.classe_sezione ?? '—'
      const cfgId = configByClasse.get(a.classe_sezione ?? null) ?? null
      const menu = menuByConfig.get(cfgId ?? MENU_LEGACY)
      const eff = allergeniAlunno({ allergeni: a.allergeni, allergies: a.allergies })
      const conflitti = (menu && menu.attivo && !menu.chiuso) ? conflittiAllergie(eff, menu.allergeni) : []

      const nome = `${a.nome} ${a.cognome}`.trim()
      const rep: AlunnoReport = { id: a.id, nome, classe, allergeni: eff, conflitti }
      const arr = perClasseMap.get(classe) ?? []
      arr.push(rep)
      perClasseMap.set(classe, arr)

      if ((a.allergies ?? '').trim().length > 0 || eff.length > 0) {
        allergie.push({
          nome, classe,
          allergie: (a.allergies ?? '').trim() || eff.join(', '),
          conflitto: conflitti.length > 0,
        })
      }

      // B3 automatica: chi ha un conflitto col menu del giorno riceve d'ufficio
      // un pasto alternativo. Derivato, nessuna riga scritta.
      if (conflitti.length > 0) {
        const allergeniConflitto = conflitti.map(c => c.allergene)
        alternativeAutomatiche.push({
          alunno_id: a.id,
          nome,
          classe,
          allergeni: allergeniConflitto,
          allergeni_label: allergeniConflitto.map(allergeneLabel),
        })
      }
    }

    const perClasse = Array.from(perClasseMap.entries())
      .map(([classe, alunni]) => ({
        classe,
        conteggio: alunni.length,
        alunni: alunni.sort((x, y) => x.nome.localeCompare(y.nome)),
      }))
      .sort((x, y) => x.classe.localeCompare(y.classe))

    alternativeAutomatiche.sort((x, y) => x.nome.localeCompare(y.nome))

    return NextResponse.json({
      success: true,
      data: { data, totale: rows.length, perClasse, allergie, alternative_automatiche: alternativeAutomatiche },
    })
  } catch (err) {
    logErrore({ operazione: 'mensa/report:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
