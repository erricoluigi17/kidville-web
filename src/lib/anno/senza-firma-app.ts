import type { SupabaseClient } from '@supabase/supabase-js'
import { leggiABlocchi, type ErroreLettura } from '@/lib/anno/lettura-a-blocchi'
import { fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'
import { firmatoInAppIl, type FirmaDelFascicolo } from '@/lib/prestampati/firma-per-anno'

/**
 * «CHI NON HA FIRMATO IN APP» — il calcolo (PR 4.7, compito 4.7.2).
 *
 * La pagina Conferme mostra, accanto alla spunta, se la famiglia ha già firmato in app UN modulo (`firmato_in_app_il`). Il cruscotto
 * dell'anno prossimo fa la domanda inversa, per tutti: di questo modulo del registro dei prestampati, chi fra le frequenze vive
 * dell'anno con la lista del modulo NON ha una firma che valga per quell'anno?
 *
 * Una sola regola: la decide `firmatoInAppIl` (`firma-per-anno.ts`), la stessa funzione della spunta. Qui si leggono i dati.
 *  · le frequenze vive dell'anno con `tipo` = lista del modulo, a blocchi (PostgREST taglia in silenzio);
 *  · dal fascicolo SOLO `student_id, document_type, created_at` — mai il contenuto, mai il nome del file — dei soli documenti VIVI
 *    (`fascicoloVivo`), a blocchi da `ALUNNI_PER_RICHIESTA` bambini;
 *  · il giorno di Roma di una firma, mai l'istante.
 *
 * Non lancia: PostgREST ritorna `{ error }` e lo ritorna anche questa funzione. Un elenco INCOMPLETO non si restituisce: se una
 * lettura cade, tutto l'esito è l'errore (un elenco monco spacciato per completo direbbe «tutti hanno firmato»).
 * Nessun nome qui dentro: le righe sono uuid. I nomi li aggiunge la route, e solo per la pagina che mostra.
 */

const VIVE = ['in_attesa', 'iscritto']
/** Quanti bambini per richiesta al fascicolo: l'URL di PostgREST ha un tetto, e gli uuid sono lunghi. */
export const ALUNNI_PER_RICHIESTA = 200

export interface ModuloDelRegistro {
  id: string
  codice: string
  lista: 'conferma' | 'nuova'
}

export interface FrequenzaSenzaFirma {
  frequenza_id: string
  alunno_id: string
  section_id: string | null
}

export type EsitoSenzaFirma =
  | { ok: true; righe: FrequenzaSenzaFirma[]; viveDellaLista: number }
  | { ok: false; error: ErroreLettura }

/** Le frequenze vive dell'anno per la lista del modulo che NON hanno una firma in app valida per quell'anno, in ordine di id. */
export async function senzaFirmaInApp(
  supabase: SupabaseClient,
  { annoSedeId, modulo }: { annoSedeId: string; modulo: ModuloDelRegistro },
): Promise<EsitoSenzaFirma> {
  // L'anno e quello prima: servono a dire a quale anno vale una firma (stessa lettura della spunta dei moduli).
  const a = await supabase.from('anni_sede').select('id, scuola_id, inizio, fine').eq('id', annoSedeId).maybeSingle()
  if (a.error) return { ok: false, error: a.error }
  const anno = a.data as { id: string; scuola_id: string; inizio: string; fine: string } | null
  if (!anno) return { ok: false, error: { code: 'PGRST116', message: 'ANNO_NON_TROVATO' } }
  const prima = await supabase
    .from('anni_sede')
    .select('ultimo_giorno_aperto')
    .eq('scuola_id', anno.scuola_id)
    .lt('fine', anno.inizio)
    .order('fine', { ascending: false })
    .limit(1)
  if (prima.error) return { ok: false, error: prima.error }
  const righePrima = (Array.isArray(prima.data) ? prima.data : []) as Array<{ ultimo_giorno_aperto: string | null }>
  const ultimoGiornoAnnoPrima = righePrima[0]?.ultimo_giorno_aperto ?? null

  const f = await leggiABlocchi<{ id: string; alunno_id: string; section_id: string | null }>((da, a2) =>
    supabase
      .from('frequenze')
      .select('id, alunno_id, section_id')
      .eq('anno_sede_id', annoSedeId)
      .eq('tipo', modulo.lista)
      .in('stato', VIVE)
      .order('id', { ascending: true })
      .range(da, a2),
  )
  if ('error' in f) return { ok: false, error: f.error }

  // Il fascicolo, poche colonne, per chunk di bambini. Niente `document_type` dentro la query: sul DB della CI uno slug fuori
  // dall'enumerazione risponde `22P02`; il filtro sta in `firmatoInAppIl`.
  const firmePer = new Map<string, FirmaDelFascicolo[]>()
  const alunni = [...new Set(f.righe.map((r) => r.alunno_id))]
  for (let i = 0; i < alunni.length; i += ALUNNI_PER_RICHIESTA) {
    const gruppo = alunni.slice(i, i + ALUNNI_PER_RICHIESTA)
    const d = await leggiABlocchi<FirmaDelFascicolo & { student_id: string }>((da, a2) =>
      fascicoloVivo(supabase.from('student_documents').select('student_id, document_type, created_at').in('student_id', gruppo))
        .order('id', { ascending: true })
        .range(da, a2),
    )
    if ('error' in d) return { ok: false, error: d.error }
    for (const x of d.righe) {
      const lista = firmePer.get(x.student_id) ?? []
      lista.push({ document_type: x.document_type, created_at: x.created_at })
      firmePer.set(x.student_id, lista)
    }
  }

  const righe: FrequenzaSenzaFirma[] = []
  for (const r of f.righe) {
    const firmato = firmatoInAppIl(modulo.codice, firmePer.get(r.alunno_id) ?? [], {
      inizio: anno.inizio,
      fine: anno.fine,
      ultimoGiornoAnnoPrima,
    })
    if (firmato === null) righe.push({ frequenza_id: r.id, alunno_id: r.alunno_id, section_id: r.section_id })
  }
  return { ok: true, righe, viveDellaLista: f.righe.length }
}
