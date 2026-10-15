import { eFattoDelRegistro } from '@/lib/presenze/finestra-trascorsa'
import { oraDiRoma } from '@/lib/presenze/orario'
import { calcolaOreAssenza, giornataDaCampanelle, type PresenzaInput } from '@/lib/primaria/oreAssenza'
import type { CategoriaStorico } from '../catalogo'
import type { ContestoStorico, SezioneStorico } from '../tipi'
import { ammesso, cella, giorno, idsAlunni, nome, nuovaSezione, perIds, persone, sezioni, testo } from './scolastici-comune'

const STATI: Record<string, string> = { presente: 'Presente', assente: 'Assente', ritardo: 'Ritardo', uscita_anticipata: 'Uscita anticipata' }
export async function presenze(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data', alunno: 'Alunno', stato: 'Stato', entrata: 'Entrata', uscita: 'Uscita',
    nota: 'Nota appello', giustificata: 'Giustificata', giustificazione: 'Motivo giustificazione', giustificataIl: 'Giustificata il',
    vistaIl: 'Presa visione docente', oreGiustificate: 'Ritardo/uscita esclusi dal monte ore', registratoDa: 'Registrato da' })
  const lette = await perIds(ctx, 'presenze', 'alunno_id', idsAlunni(ctx), q => q.gte('data', ctx.richiesta.dal).lte('data', ctx.richiesta.al)
    .or(`scuola_id.is.null,scuola_id.eq.${ctx.richiesta.scuolaId}`).is('deleted_at', null))
  const righe = lette.filter(r => ammesso(ctx, testo(r.alunno_id), giorno(r.data), testo(r.section_id) || undefined, testo(r.scuola_id) || undefined)
    && (categoria === 'presenze_comunicazioni' ? r.giustificata_da != null : eFattoDelRegistro({ data: testo(r.data), stato: testo(r.stato),
      registrato_da: testo(r.registrato_da) || null, giustificata_da: testo(r.giustificata_da) || null })))
  righe.sort((a, b) => testo(a.data).localeCompare(testo(b.data)) || testo(a.id).localeCompare(testo(b.id)))
  if (categoria === 'presenze_riepilogo') {
    s.colonne = Object.entries({ alunno: 'Alunno', presenti: 'Presenze', assenti: 'Assenze', ritardi: 'Ritardi', uscite: 'Uscite anticipate',
      ore: 'Ore di assenza stimate', giorni: 'Giornate registrate' }).map(([chiave, titolo]) => ({ chiave, titolo }))
    const classi = await sezioni(ctx)
    const campanelle = await perIds(ctx, 'campanelle', 'section_id', classi.map(c => testo(c.id)))
    for (const a of ctx.alunni) {
      const proprie = righe.filter(r => r.alunno_id === a.id)
      let ore = 0
      for (const r of proprie) {
        const data = giorno(r.data)
        const classe = testo(r.section_id) || ctx.appartenenze.find(x => x.alunno_id === a.id && x.dal <= data && (!x.al || data < x.al))?.section_id
        const giornoSettimana = new Date(`${data}T12:00:00Z`).getUTCDay() || 7
        const camp = campanelle.filter(c => c.section_id === classe && Number(c.giorno_settimana) === giornoSettimana)
          .map(c => ({ ora_inizio: testo(c.ora_inizio), ora_fine: testo(c.ora_fine), tipo: testo(c.tipo) }))
        ore += calcolaOreAssenza([{ stato: testo(r.stato) as PresenzaInput['stato'], orario_entrata: testo(r.orario_entrata), orario_uscita: testo(r.orario_uscita),
          assenza_oraria_giustificata: r.assenza_oraria_giustificata === true }], giornataDaCampanelle(camp)).oreTotali
      }
      s.righe.push({ _alunno_id: a.id, alunno: nome(ctx, a.id), presenti: proprie.filter(r => r.stato === 'presente').length,
        assenti: proprie.filter(r => r.stato === 'assente').length, ritardi: proprie.filter(r => r.stato === 'ritardo').length,
        uscite: proprie.filter(r => r.stato === 'uscita_anticipata').length, giorni: proprie.length, ore: Math.round(ore * 100) / 100 })
    }
    s.avvisi.push('Le ore sono una stima calcolata con le campanelle attualmente salvate per la classe e per il giorno della settimana dell’evento; se assenti, con la giornata standard 08:30–13:30. La configurazione storica degli orari non è archiviata.')
    return s
  }
  const autori = await persone(ctx, righe.map(r => testo(r.registrato_da)))
  for (const r of righe) {
    if (categoria === 'presenze_ritardi' && !['ritardo', 'uscita_anticipata'].includes(testo(r.stato))) continue
    if (categoria === 'presenze_giustifiche' && r.stato !== 'assente' && r.giustificata !== true) continue
    const id = testo(r.alunno_id)
    s.righe.push({ _alunno_id: id, data: giorno(r.data), alunno: nome(ctx, id), stato: STATI[testo(r.stato)] ?? testo(r.stato),
      entrata: oraDiRoma(testo(r.orario_entrata)), uscita: oraDiRoma(testo(r.orario_uscita)), nota: testo(r.note_appello) || testo(r.note),
      giustificata: cella(r.giustificata), giustificazione: testo(r.giustificazione_testo), giustificataIl: testo(r.giustificata_il),
      vistaIl: testo(r.giust_vista_il), oreGiustificate: r.assenza_oraria_giustificata === true, registratoDa: autori.get(testo(r.registrato_da)) ?? '' })
  }
  if (categoria === 'presenze_comunicazioni') s.avvisi.push('Sono incluse le assenze comunicate dal genitore, anche per giorni futuri; le comunicazioni non ancora divenute fatti non alimentano il riepilogo della frequenza.')
  return s
}
