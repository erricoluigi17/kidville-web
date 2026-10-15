import { logEvento } from '@/lib/logging/logger'
import type { CategoriaStorico } from '../catalogo'
import type { ContestoStorico, SezioneStorico } from '../tipi'
import { diario } from './scolastici-diario'
import { presenze } from './scolastici-presenze'
import { competenze, firme, note, orario, pagelle, prospetti, registro, scrutini, valutazioni } from './scolastici-primaria'
import { anagrafica, consensi, iscrizioni, moduli, sanitari } from './scolastici-documenti'
import { avvisaCoperturaAppartenenze } from './scolastici-comune'

type Adattatore = (ctx: ContestoStorico, categoria: CategoriaStorico) => Promise<SezioneStorico>
const PRIMARIA: Partial<Record<CategoriaStorico, Adattatore>> = {
  primaria_registro: registro, primaria_compiti: registro, primaria_valutazioni: valutazioni, primaria_prospetti: prospetti,
  primaria_note: note, primaria_firme: firme, primaria_scrutini: scrutini, primaria_pagelle: pagelle,
  primaria_competenze: competenze, primaria_orario: orario,
}
const DOCUMENTI: Partial<Record<CategoriaStorico, Adattatore>> = {
  anagrafica_scheda: anagrafica, anagrafica_classe: anagrafica, documenti_iscrizioni: iscrizioni, documenti_moduli: moduli,
  documenti_consensi: consensi, documenti_certificati: sanitari, documenti_alimentazione: sanitari,
  documenti_fascicolo: sanitari, documenti_didattici: registro,
}

/** I contenitori «completo» sono espansi dal catalogo prima dell’invocazione. */
export async function raccogliScolastico(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico | null> {
  const adattatore = categoria.startsWith('diario_') ? diario : categoria.startsWith('presenze_') ? presenze : PRIMARIA[categoria] ?? DOCUMENTI[categoria]
  if (!adattatore) return null
  try {
    const sezione = await adattatore(ctx, categoria)
    avvisaCoperturaAppartenenze(ctx, sezione)
    sezione.avvisi = [...new Set(sezione.avvisi)]
    logEvento('registro', 'info', { operazione: 'storici/scolastici', esito: 'sezione-raccolta', tipo: categoria, n: sezione.righe.length, n_allegati: sezione.allegati.length })
    return sezione
  } catch (error) {
    logEvento('registro', 'error', { operazione: 'storici/scolastici', esito: 'sezione-fallita', tipo: categoria }, error)
    throw error
  }
}
