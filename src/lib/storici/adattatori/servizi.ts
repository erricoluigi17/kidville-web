import type { ContestoStorico, SezioneStorico } from '../tipi'
import type { CategoriaStorico } from '../catalogo'
import { logEvento } from '@/lib/logging/logger'
import { raccogliContabilita } from './servizi-contabilita'
import { raccogliComunicazioni } from './servizi-comunicazioni'
import { raccogliOperativi } from './servizi-operativi'

/** Sorgenti esplicite e paginate: nessun dump JSON né emissione di nuovi documenti. */
export async function raccogliServizio(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico | null> {
  let risultato: SezioneStorico | null
  if (categoria.startsWith('mensa_') || categoria.startsWith('contabilita_')) risultato = await raccogliContabilita(ctx, categoria)
  else if (categoria.startsWith('comunicazioni_')) risultato = await raccogliComunicazioni(ctx, categoria)
  else if (categoria.startsWith('servizi_') || categoria === 'documenti_protocolli') risultato = await raccogliOperativi(ctx, categoria)
  else return null
  if (risultato) {
    risultato.avvisi = [...new Set(risultato.avvisi)]
    risultato.righe.sort((a, b) => String(a.data ?? a.scadenza ?? '').localeCompare(String(b.data ?? b.scadenza ?? '')) || String(a._alunno_id ?? '').localeCompare(String(b._alunno_id ?? '')))
    logEvento('registro', 'info', { operazione: 'storici/raccogli-servizio', esito: 'lettura-completata', scuola_id: ctx.richiesta.scuolaId, n_righe: risultato.righe.length, n_allegati: risultato.allegati.length, n_avvisi: risultato.avvisi.length })
  }
  return risultato
}
