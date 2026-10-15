import { oraDiRoma } from '@/lib/presenze/orario'
import { intervalloGiornoRoma } from '../retroattivita'
import type { CategoriaStorico } from '../catalogo'
import type { ContestoStorico, SezioneStorico } from '../tipi'
import { ammesso, cella, elenco, giorno, idsAlunni, nome, nuovaSezione, oggetto, perIds, persone, testo } from './scolastici-comune'

const TIPI: Partial<Record<CategoriaStorico, string[]>> = {
  diario_pasti: ['pranzo', 'merenda'], diario_sonno: ['nanna', 'nanna_inizio', 'nanna_fine'],
  diario_bagno: ['bagno'], diario_attivita: ['attivita'], diario_umore: ['umore'],
}
const NOMI: Record<string, string> = { pranzo: 'Pranzo', merenda: 'Merenda', nanna: 'Sonno', nanna_inizio: 'Inizio sonno', nanna_fine: 'Fine sonno', bagno: 'Bagno e cambio', attivita: 'Attività', umore: 'Umore' }
const UMORI: Record<string, string> = { felice: 'Felice', sereno: 'Sereno', cosi_cosi: 'Così così', triste: 'Triste', agitato: 'Agitato' }

export async function diario(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data', alunno: 'Alunno', tipo: 'Voce', inizio: 'Inizio', fine: 'Fine',
    dettaglio: 'Dettaglio', valore: 'Valore registrato', notaIndividuale: 'Nota individuale', notaSezione: 'Nota di sezione', autore: 'Registrato da' })
  const inizio = intervalloGiornoRoma(ctx.richiesta.dal).startOfDay
  const fine = intervalloGiornoRoma(ctx.richiesta.al).endOfDay
  const righe = await perIds(ctx, 'eventi_diario', 'alunno_id', idsAlunni(ctx), q => q.gte('orario_inizio', inizio).lte('orario_inizio', fine))
  const autori = await persone(ctx, righe.map(r => testo(r.maestra_id)))
  righe.sort((a, b) => testo(a.orario_inizio).localeCompare(testo(b.orario_inizio)) || testo(a.id).localeCompare(testo(b.id)))
  for (const r of righe) {
    const data = giorno(r.orario_inizio), id = testo(r.alunno_id), tipo = testo(r.tipo_evento)
    if (!ammesso(ctx, id, data) || (TIPI[categoria] && !TIPI[categoria]?.includes(tipo))) continue
    if (categoria === 'diario_routine' && !tipo.startsWith('routine:')) continue
    if (categoria === 'diario_note' && !testo(r.nota_bambino) && !testo(r.nota_libera)) continue
    const d = oggetto(r.dettagli)
    const base = { _alunno_id: id, data, alunno: nome(ctx, id), tipo: NOMI[tipo] ?? (testo(d.nome) || tipo), inizio: oraDiRoma(testo(r.orario_inizio)),
      fine: oraDiRoma(testo(r.orario_fine)), dettaglio: null, valore: null,
      notaIndividuale: testo(r.nota_bambino), notaSezione: testo(r.nota_libera), autore: autori.get(testo(r.maestra_id)) ?? '' }
    if (tipo === 'attivita' && categoria !== 'diario_note') {
      for (const a of elenco(d.activities)) s.righe.push({ ...base, tipo: testo(a.tipo) || 'Attività', dettaglio: testo(a.descrizione),
        valore: cella(a.partecipazione), inizio: testo(a.ora_inizio) || base.inizio, fine: testo(a.ora_fine) || base.fine })
      if (!elenco(d.activities).length) s.righe.push({ ...base, dettaglio: testo(d.descrizione), valore: cella(d.partecipazione) })
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
  if (categoria === 'diario_bagno') s.colonne.push({ chiave: 'pipi', titolo: 'Pipì' }, { chiave: 'cacca', titolo: 'Cacca' }, { chiave: 'cambi', titolo: 'Cambi' }, { chiave: 'vasino', titolo: 'Vasino' })
  return s
}
