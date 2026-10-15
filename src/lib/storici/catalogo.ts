import { z } from 'zod'
import { zDataYMD, zUuid } from '@/lib/validation/common'

export const CATALOGO_STORICI = [
  { id: 'diario_completo', gruppo: 'diario', titolo: 'Diario completo' },
  { id: 'diario_pasti', gruppo: 'diario', titolo: 'Pranzo e merende' },
  { id: 'diario_sonno', gruppo: 'diario', titolo: 'Sonno' },
  { id: 'diario_bagno', gruppo: 'diario', titolo: 'Bagno e cambi' },
  { id: 'diario_attivita', gruppo: 'diario', titolo: 'Attività svolte' },
  { id: 'diario_umore', gruppo: 'diario', titolo: 'Umore della giornata' },
  { id: 'diario_note', gruppo: 'diario', titolo: 'Note individuali e di sezione' },
  { id: 'diario_routine', gruppo: 'diario', titolo: 'Routine personalizzate' },
  { id: 'presenze_registro', gruppo: 'presenze', titolo: 'Registro presenze' },
  { id: 'presenze_orari', gruppo: 'presenze', titolo: 'Entrate e uscite' },
  { id: 'presenze_ritardi', gruppo: 'presenze', titolo: 'Ritardi e uscite anticipate' },
  { id: 'presenze_giustifiche', gruppo: 'presenze', titolo: 'Assenze e giustificazioni' },
  { id: 'presenze_riepilogo', gruppo: 'presenze', titolo: 'Riepilogo frequenza' },
  { id: 'presenze_comunicazioni', gruppo: 'presenze', titolo: 'Comunicazioni delle assenze' },
  { id: 'primaria_registro', gruppo: 'primaria', titolo: 'Registro delle lezioni' },
  { id: 'primaria_compiti', gruppo: 'primaria', titolo: 'Compiti assegnati' },
  { id: 'primaria_valutazioni', gruppo: 'primaria', titolo: 'Valutazioni dettagliate' },
  { id: 'primaria_prospetti', gruppo: 'primaria', titolo: 'Prospetti interni per materia e obiettivo' },
  { id: 'primaria_note', gruppo: 'primaria', titolo: 'Note disciplinari e didattiche' },
  { id: 'primaria_firme', gruppo: 'primaria', titolo: 'Firme e prese visione' },
  { id: 'primaria_scrutini', gruppo: 'primaria', titolo: 'Scrutini' },
  { id: 'primaria_pagelle', gruppo: 'primaria', titolo: 'Pagelle' },
  { id: 'primaria_competenze', gruppo: 'primaria', titolo: 'Certificazioni delle competenze' },
  { id: 'primaria_orario', gruppo: 'primaria', titolo: 'Orario salvato' },
  { id: 'primaria_completo', gruppo: 'primaria', titolo: 'Registro completo della primaria' },
  { id: 'anagrafica_scheda', gruppo: 'documenti', titolo: 'Scheda alunno e famiglia' },
  { id: 'anagrafica_classe', gruppo: 'documenti', titolo: 'Elenco della classe' },
  { id: 'documenti_iscrizioni', gruppo: 'documenti', titolo: 'Domande di iscrizione' },
  { id: 'documenti_moduli', gruppo: 'documenti', titolo: 'Moduli e autorizzazioni' },
  { id: 'documenti_consensi', gruppo: 'documenti', titolo: 'Consensi e accettazioni' },
  { id: 'documenti_certificati', gruppo: 'documenti', titolo: 'Certificati medici' },
  { id: 'documenti_alimentazione', gruppo: 'documenti', titolo: 'Indicazioni alimentari' },
  { id: 'documenti_fascicolo', gruppo: 'documenti', titolo: 'Fascicolo e originali' },
  { id: 'documenti_didattici', gruppo: 'documenti', titolo: 'Allegati didattici' },
  { id: 'mensa_pasti', gruppo: 'contabilita', titolo: 'Prenotazioni e pasti' },
  { id: 'mensa_ticket', gruppo: 'contabilita', titolo: 'Movimenti ticket mensa' },
  { id: 'mensa_menu', gruppo: 'contabilita', titolo: 'Menù e alternative' },
  { id: 'contabilita_addebiti', gruppo: 'contabilita', titolo: 'Rette e servizi addebitati' },
  { id: 'contabilita_incassi', gruppo: 'contabilita', titolo: 'Pagamenti e incassi' },
  { id: 'contabilita_situazione', gruppo: 'contabilita', titolo: 'Situazione contabile' },
  { id: 'contabilita_ricevute', gruppo: 'contabilita', titolo: 'Ricevute di pagamento' },
  { id: 'contabilita_fatture', gruppo: 'contabilita', titolo: 'Fatture originali' },
  { id: 'contabilita_solleciti', gruppo: 'contabilita', titolo: 'Solleciti' },
  { id: 'contabilita_attestazioni', gruppo: 'contabilita', titolo: 'Attestazioni dei pagamenti' },
  { id: 'comunicazioni_avvisi', gruppo: 'servizi', titolo: 'Avvisi e circolari' },
  { id: 'comunicazioni_risposte', gruppo: 'servizi', titolo: 'Risposte e adesioni agli avvisi' },
  { id: 'comunicazioni_chat', gruppo: 'servizi', titolo: 'Conversazioni scuola–famiglia' },
  { id: 'comunicazioni_notifiche', gruppo: 'servizi', titolo: 'Notifiche ai genitori' },
  { id: 'comunicazioni_galleria', gruppo: 'servizi', titolo: 'Galleria fotografica' },
  { id: 'comunicazioni_news', gruppo: 'servizi', titolo: 'News della scuola' },
  { id: 'servizi_armadietto', gruppo: 'servizi', titolo: 'Armadietto e materiali' },
  { id: 'servizi_ordini', gruppo: 'servizi', titolo: 'Divise e ordini' },
  { id: 'documenti_protocolli', gruppo: 'servizi', titolo: 'Documenti protocollati' },
  { id: 'servizi_audit', gruppo: 'servizi', titolo: 'Registro interno delle modifiche' },
  { id: 'dossier_completo', gruppo: 'servizi', titolo: 'Dossier completo' },
] as const

export type CategoriaStorico = typeof CATALOGO_STORICI[number]['id']
export type GruppoStorico = typeof CATALOGO_STORICI[number]['gruppo']
const ids = CATALOGO_STORICI.map(c => c.id) as [CategoriaStorico, ...CategoriaStorico[]]
export const richiestaStoricoSchema = z.object({
  scuolaId: zUuid,
  alunnoId: zUuid.optional(),
  sectionId: zUuid.optional(),
  dal: zDataYMD,
  al: zDataYMD,
  categorie: z.array(z.enum(ids)).min(1).max(55),
  formato: z.enum(['pdf', 'xlsx']),
  raggruppamento: z.enum(['classe', 'alunno']).default('classe'),
}).superRefine((v, ctx) => {
  if (Boolean(v.alunnoId) === Boolean(v.sectionId)) ctx.addIssue({ code: 'custom', path: ['alunnoId'], message: 'Scegli un alunno oppure una classe' })
  if (v.dal > v.al) ctx.addIssue({ code: 'custom', path: ['dal'], message: 'Il periodo termina prima di iniziare' })
})
export type RichiestaStorico = z.infer<typeof richiestaStoricoSchema>

export function espandiCategorie(categorie: readonly CategoriaStorico[]): CategoriaStorico[] {
  const espanse = new Set<CategoriaStorico>()
  for (const id of categorie) {
    const gruppo = id === 'diario_completo' ? 'diario' : id === 'primaria_completo' ? 'primaria' : null
    if (gruppo || id === 'dossier_completo') {
      for (const voce of CATALOGO_STORICI) if ((!gruppo || voce.gruppo === gruppo) && !['diario_completo', 'primaria_completo', 'dossier_completo'].includes(voce.id)) espanse.add(voce.id)
    } else espanse.add(id)
  }
  return [...espanse]
}
