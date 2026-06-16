import type { SupabaseClient } from '@supabase/supabase-js'
import { loadResolveOptions } from '@/lib/mensa/server'
import { resolveMenuGiorno, type ResolveOptions } from '@/lib/mensa/resolveMenu'
import { allergeniAlunno, conflittiAllergie } from '@/lib/mensa/allergeni'
import { notificaAllergie } from '@/lib/mensa/notify'

interface AlunnoAllergie {
  id: string
  nome: string
  cognome: string
  classe_sezione: string | null
  section_id: string | null
  scuola_id: string | null
  allergies: string | null
  allergeni: string[] | null
}

// Verifica i conflitti allergia↔menu per un alunno in una data e, se presenti,
// invia l'alert (segreteria/cuoca/insegnanti). Idempotente lato notifica.
// Accetta un alunno già caricato + opzioni menu opzionali (per il batch).
export async function controllaAllergie(
  supabase: SupabaseClient,
  alunno: AlunnoAllergie,
  data: string,
  scuolaId: string,
  options?: ResolveOptions
): Promise<boolean> {
  const opts = options ?? (await loadResolveOptions(supabase, scuolaId))
  const menu = resolveMenuGiorno(data, opts)
  if (!menu.attivo || menu.chiuso || !menu.allergeni) return false

  const allergeni = allergeniAlunno({ allergeni: alunno.allergeni, allergies: alunno.allergies })
  if (allergeni.length === 0) return false

  const conflitti = conflittiAllergie(allergeni, menu.allergeni)
  if (conflitti.length === 0) return false

  const res = await notificaAllergie(supabase, {
    alunnoId: alunno.id,
    nomeAlunno: `${alunno.nome} ${alunno.cognome}`.trim(),
    classeSezione: alunno.classe_sezione,
    sezioneId: alunno.section_id,
    scuolaId,
    data,
    conflitti,
  })
  return res.inviata
}

// Variante che carica l'alunno per id (usata dalla prenotazione).
export async function controllaAllergiePerId(
  supabase: SupabaseClient,
  alunnoId: string,
  data: string,
  scuolaId: string,
  options?: ResolveOptions
): Promise<boolean> {
  const { data: al } = await supabase
    .from('alunni')
    .select('id, nome, cognome, classe_sezione, section_id, scuola_id, allergies, allergeni')
    .eq('id', alunnoId)
    .single()
  if (!al) return false
  return controllaAllergie(supabase, al as AlunnoAllergie, data, scuolaId, options)
}
