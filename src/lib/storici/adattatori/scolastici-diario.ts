import { oraDiRoma } from '@/lib/presenze/orario'
import { logEvento } from '@/lib/logging/logger'
import { intervalloGiornoRoma } from '../retroattivita'
import type { CategoriaStorico } from '../catalogo'
import type { CellaStorico, ContestoStorico, SezioneStorico } from '../tipi'
import { ammesso, cella, elenco, giorno, idsAlunni, nome, nuovaSezione, oggetto, perIds, persone, testo } from './scolastici-comune'

const TIPI: Partial<Record<CategoriaStorico, string[]>> = {
  diario_pasti: ['pranzo', 'merenda'], diario_sonno: ['nanna', 'nanna_inizio', 'nanna_fine'],
  diario_bagno: ['bagno'], diario_attivita: ['attivita'], diario_umore: ['umore'],
}
const NOMI: Record<string, string> = { pranzo: 'Pranzo', merenda: 'Merenda', nanna: 'Sonno', nanna_inizio: 'Inizio sonno', nanna_fine: 'Fine sonno', bagno: 'Bagno e cambio', attivita: 'Attività', umore: 'Umore' }
const UMORI: Record<string, string> = { felice: 'Felice', sereno: 'Sereno', cosi_cosi: 'Così così', triste: 'Triste', agitato: 'Agitato' }

type RigaDiario = Record<string, CellaStorico>
interface Partecipante { id: string; valore: string; nota: string }
interface AttivitaDiClasse { riga: RigaDiario; partecipanti: Map<string, Partecipante>; autori: Set<string> }

const bambini = (n: number) => n === 1 ? '1 bambino' : `${n} bambini`

/** Il gruppo più numeroso a conteggio, gli altri per nome; nel dossier per alunno solo conteggi. */
function partecipazione(ctx: ContestoStorico, partecipanti: Partecipante[], conNomi: boolean): string {
  const gruppi = new Map<string, string[]>()
  for (const p of partecipanti) gruppi.set(p.valore, [...(gruppi.get(p.valore) ?? []), p.id])
  const ordinati = [...gruppi.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  if (ordinati.length === 1) {
    const [valore, ids] = ordinati[0]
    if (!valore) return bambini(ids.length)
    return `${valore}: ${ids.length === 1 ? (conNomi ? nome(ctx, ids[0]) : bambini(1)) : `tutti i ${bambini(ids.length)}`}`
  }
  return ordinati.map(([valore, ids], i) =>
    `${valore || 'Senza indicazione'}: ${i === 0 || !conNomi ? bambini(ids.length) : ids.map(id => nome(ctx, id)).join(', ')}`).join(' · ')
}

export async function diario(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data', alunno: 'Alunno', tipo: 'Voce', inizio: 'Inizio', fine: 'Fine',
    dettaglio: 'Dettaglio', valore: 'Valore registrato', notaIndividuale: 'Nota individuale', autore: 'Registrato da' })
  const inizio = intervalloGiornoRoma(ctx.richiesta.dal).startOfDay
  const fine = intervalloGiornoRoma(ctx.richiesta.al).endOfDay
  const righe = await perIds(ctx, 'eventi_diario', 'alunno_id', idsAlunni(ctx), q => q.gte('orario_inizio', inizio).lte('orario_inizio', fine))
  const autori = await persone(ctx, righe.map(r => testo(r.maestra_id)))
  righe.sort((a, b) => testo(a.orario_inizio).localeCompare(testo(b.orario_inizio)) || testo(a.id).localeCompare(testo(b.id)))
  // L'app delle educatrici salva attività e nota di sezione su ogni bambino: nella stampa di
  // classe si leggono una volta. La stampa di un solo alunno resta riga per riga.
  const diClasse = !ctx.richiesta.alunnoId
  const perAlunno = diClasse && ctx.richiesta.raggruppamento === 'alunno'
  const attivitaDiClasse = new Map<string, AttivitaDiClasse>()
  const noteDelGiorno = new Set<string>()
  let lette = 0
  const notaDiSezione = (data: string, nota: string, autore: string) => {
    const chiave = JSON.stringify([data, nota])
    if (!nota || noteDelGiorno.has(chiave)) return
    noteDelGiorno.add(chiave)
    s.righe.push({ _ambito: 'classe', _nota_giorno: true, data, alunno: '', tipo: 'Nota di sezione', inizio: null, fine: null,
      dettaglio: nota, valore: null, notaIndividuale: '', autore })
  }
  const attivita = (base: RigaDiario, voce: string, dettaglio: string, valore: CellaStorico, oraInizio: CellaStorico, oraFine: CellaStorico) => {
    const propria = { ...base, tipo: voce, dettaglio, valore, inizio: oraInizio, fine: oraFine }
    if (!diClasse) { s.righe.push(propria); return }
    lette++
    const chiave = JSON.stringify([base.data, voce, oraInizio, oraFine, dettaglio])
    let gruppo = attivitaDiClasse.get(chiave)
    if (!gruppo) {
      gruppo = { riga: { _ambito: 'classe', data: base.data, alunno: '', tipo: voce, inizio: oraInizio, fine: oraFine, dettaglio,
        valore: '', notaIndividuale: '', autore: '' }, partecipanti: new Map(), autori: new Set() }
      attivitaDiClasse.set(chiave, gruppo)
      s.righe.push(gruppo.riga)
    }
    const id = testo(base._alunno_id)
    if (!gruppo.partecipanti.has(id)) gruppo.partecipanti.set(id, { id, valore: testo(valore), nota: testo(base.notaIndividuale) })
    if (testo(base.autore)) gruppo.autori.add(testo(base.autore))
    if (perAlunno) s.righe.push({ ...propria, dettaglio: '' })
  }
  for (const r of righe) {
    const data = giorno(r.orario_inizio), id = testo(r.alunno_id), tipo = testo(r.tipo_evento)
    if (!ammesso(ctx, id, data) || (TIPI[categoria] && !TIPI[categoria]?.includes(tipo))) continue
    if (categoria === 'diario_routine' && !tipo.startsWith('routine:')) continue
    if (categoria === 'diario_note' && !testo(r.nota_bambino) && !testo(r.nota_libera)) continue
    const d = oggetto(r.dettagli)
    const base: RigaDiario = { _alunno_id: id, data, alunno: nome(ctx, id), tipo: NOMI[tipo] ?? (testo(d.nome) || tipo), inizio: oraDiRoma(testo(r.orario_inizio)),
      fine: oraDiRoma(testo(r.orario_fine)), dettaglio: null, valore: null,
      notaIndividuale: testo(r.nota_bambino), autore: autori.get(testo(r.maestra_id)) ?? '' }
    notaDiSezione(data, testo(r.nota_libera), testo(base.autore))
    // Fra le note restano per bambino soltanto quelle individuali.
    if (categoria === 'diario_note' && !testo(r.nota_bambino)) continue
    if (tipo === 'attivita' && categoria !== 'diario_note') {
      for (const a of elenco(d.activities)) attivita(base, testo(a.tipo) || 'Attività', testo(a.descrizione), cella(a.partecipazione), testo(a.ora_inizio) || base.inizio, testo(a.ora_fine) || base.fine)
      if (!elenco(d.activities).length) attivita(base, testo(base.tipo), testo(d.descrizione), cella(d.partecipazione), base.inizio, base.fine)
    } else if (['pranzo', 'merenda'].includes(tipo)) {
      const corsi = oggetto(d.corsi)
      const porzioni = ['primo', 'secondo', 'contorno', 'frutta', 'pane', 'acqua', 'merenda'].map(k => `${k}: ${testo(corsi[k]) || testo(d[k])}`).filter(t => !t.endsWith(': '))
      s.righe.push({ ...base, dettaglio: porzioni.join('; ') || testo(d.menu) || testo(d.descrizione), valore: cella(d.quantita ?? d.valore ?? d.pasto) })
    } else if (tipo === 'bagno') {
      s.righe.push({ ...base, dettaglio: [d.tipo, d.consistenza, d.note].map(testo).filter(Boolean).join('; '), valore: cella(d.volte ?? d.quantita ?? d.count ?? d.valore),
        pipi: cella(d.pipi), cacca: cella(d.cacca), cambi: cella(d.cambi), vasino: cella(d.vasino) })
    } else if (tipo.startsWith('nanna')) {
      s.righe.push({ ...base, inizio: testo(d.orario_inizio) || null, fine: testo(d.orario_fine) || null, dettaglio: testo(d.qualita) || testo(d.note), valore: cella(d.durata) })
    } else if (tipo === 'umore') s.righe.push({ ...base, valore: UMORI[testo(d.umore)] ?? testo(d.umore) })
    else s.righe.push({ ...base, dettaglio: testo(d.nome) || testo(d.descrizione),
      valore: Array.isArray(d.valore) ? d.valore.map(cella).filter(v => v !== null).join(', ') : cella(d.valore) })
  }
  for (const g of attivitaDiClasse.values()) {
    const partecipanti = [...g.partecipanti.values()]
    g.riga.valore = partecipazione(ctx, partecipanti, !perAlunno)
    g.riga.notaIndividuale = perAlunno ? '' : partecipanti.filter(p => p.nota).map(p => `${nome(ctx, p.id)}: ${p.nota}`).join(' · ')
    g.riga.autore = [...g.autori].join(', ')
  }
  if (attivitaDiClasse.size) logEvento('registro', 'info', { operazione: 'storici/diario-accorpa', esito: 'attivita-di-classe', n: lette, gruppi: attivitaDiClasse.size })
  if (categoria === 'diario_bagno') s.colonne.push({ chiave: 'pipi', titolo: 'Pipì' }, { chiave: 'cacca', titolo: 'Cacca' }, { chiave: 'cambi', titolo: 'Cambi' }, { chiave: 'vasino', titolo: 'Vasino' })
  return s
}
