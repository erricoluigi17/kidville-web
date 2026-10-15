import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { haUnRuolo } from '@/lib/auth/predicati-ruolo'
import { scuoleDiUtente } from '@/lib/auth/scope'
import type { RichiestaStorico } from './catalogo'
import type { AlunnoStorico, AppartenenzaStorica, ContestoStorico } from './tipi'
import { ErroreStorico, erroreQueryStorico, leggiTutte } from './db'
import { utenteStaffStorico } from './permessi'

export function appartieneNelGiorno(appartenenze: AppartenenzaStorica[], alunnoId: string, giorno: string, sectionId?: string): boolean {
  return appartenenze.some(a => a.alunno_id === alunnoId && (!sectionId || a.section_id === sectionId) && a.dal <= giorno && (!a.al || giorno < a.al))
}

export async function preparaContestoStorico(db: SupabaseClient, utente: AppUser, richiesta: RichiestaStorico): Promise<ContestoStorico> {
  if (!haUnRuolo(utente, ['admin', 'coordinator', 'segreteria'])) throw new ErroreStorico(403, 'ACCESSO_NEGATO', 'Accesso riservato a segreteria e direzione.')
  const sedi = await scuoleDiUtente(db, utenteStaffStorico(utente))
  if (!sedi.some(id => id.toLowerCase() === richiesta.scuolaId.toLowerCase())) throw new ErroreStorico(403, 'SEDE_NON_AUTORIZZATA', 'Sede non accessibile.')
  const { data: sede, error: errSede } = await db.from('schools').select('id,nome').eq('id', richiesta.scuolaId).maybeSingle()
  if (errSede) erroreQueryStorico('sede', errSede)
  if (!sede) throw new ErroreStorico(404, 'SEDE_NON_TROVATA', 'Sede non trovata.')
  let titolo = ''
  if (richiesta.sectionId) {
    const { data: sezione, error } = await db.from('sections').select('id,name').eq('id', richiesta.sectionId).eq('scuola_id', richiesta.scuolaId).maybeSingle()
    if (error) erroreQueryStorico('classe', error)
    if (sezione) titolo = sezione.name
    else {
      const { data: storica, error: errStorica } = await db.from('alunni_classi_storico').select('section_nome').eq('section_id', richiesta.sectionId).eq('scuola_id', richiesta.scuolaId).order('dal', { ascending: false }).limit(1).maybeSingle()
      if (errStorica) erroreQueryStorico('classe-storica', errStorica)
      if (!storica) throw new ErroreStorico(404, 'CLASSE_NON_TROVATA', 'Classe non trovata nella sede scelta.')
      titolo = storica.section_nome || 'Classe archiviata'
    }
  }
  const appartenenze = await leggiTutte<AppartenenzaStorica>((dal, al) => {
    let q = db.from('alunni_classi_storico').select('alunno_id,scuola_id,section_id,section_nome,dal,al').eq('scuola_id', richiesta.scuolaId).lte('dal', richiesta.al).or(`al.is.null,al.gt.${richiesta.dal}`).order('id').range(dal, al)
    if (richiesta.sectionId) q = q.eq('section_id', richiesta.sectionId)
    if (richiesta.alunnoId) q = q.eq('alunno_id', richiesta.alunnoId)
    return q
  }, 'appartenenze')
  const ids = richiesta.alunnoId ? [richiesta.alunnoId] : [...new Set(appartenenze.map(a => a.alunno_id))]
  const alunni: AlunnoStorico[] = []
  // Blocchi piccoli: evita URL PostgREST troppo lunghi su più anni di una classe.
  for (let i = 0; i < ids.length; i += 100) {
    const lotto = ids.slice(i, i + 100)
    const lette = await leggiTutte<AlunnoStorico>((dal, al) => db.from('alunni').select('id,nome,cognome,scuola_id,section_id,archiviato_il').in('id', lotto).is('anonimizzato_il', null).order('cognome').order('id').range(dal, al), 'alunni')
    alunni.push(...lette.filter(a => a.scuola_id === richiesta.scuolaId || appartenenze.some(p => p.alunno_id === a.id)))
  }
  if (richiesta.alunnoId) {
    if (alunni.length !== 1) throw new ErroreStorico(404, 'ALUNNO_NON_TROVATO', 'Alunno non trovato nella sede scelta.')
    titolo = `${alunni[0].cognome} ${alunni[0].nome}`
  }
  const avvisi: string[] = []
  if (richiesta.sectionId) {
    const prima = appartenenze.map(a => a.dal).sort()[0]
    if (!prima || richiesta.dal < prima) avvisi.push('La composizione della classe non è documentata per tutto il periodo. Completa le appartenenze storiche prima di considerare completo il dossier.')
  }
  return { db, utente, richiesta, alunni, appartenenze, titolo, scuolaNome: sede.nome, avvisi }
}
