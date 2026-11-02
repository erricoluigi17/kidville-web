import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import it from '../../../../../messages/it/shared.json'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'
import { descriviTetto, leggiABlocchi, type QueryABlocchi } from '@/lib/db/leggi-a-blocchi'
import { CODICI_ERRORE, type CodiceErrore } from '@/lib/ui/esito-fetch'
import { statoVotazione } from '@/lib/votazioni/stato'
import type { ClasseVotazione, RigaVotazione, RiepilogoVotazione } from '@/lib/votazioni/tipi'

/**
 * VOTAZIONI (segreteria) · QUELLO CHE LE ROUTE DI `admin/votazioni/` HANNO IN COMUNE.
 *
 * Non è una route (Next serve solo i `route.ts`): sta qui perché le letture a blocchi, il riepilogo di una
 * votazione e il controllo dei conflitti li usano PIÙ handler (l'elenco, il POST, la proroga del PATCH), e una
 * regola scritta due volte è una regola che prima o poi diverge. Il precedente è `src/app/api/gallery/proiezione.ts`.
 * Il client Supabase arriva sempre dal chiamante: qui dentro non se ne apre nessuno, così il lock del gate
 * (`votazioni-gate-requirevotazioni`) continua a guardare solo gli handler.
 *
 * ── L'ESITO ──────────────────────────────────────────────────────────────────
 *
 * PostgREST non lancia: ritorna `{ error }`. Ogni lettura qui restituisce `{ ok: true, valore }` oppure
 * `{ ok: false, errore }`, e non decide la risposta HTTP: la decide la route, perché la stessa lettura rotta
 * vale 503/500 in una (`rispostaErroreDbVotazioni`) e «degrada a `disponibile: false`» nell'altra (l'elenco).
 * Al tetto di `leggiABlocchi` la lettura è un guasto (`Error`), mai un elenco troncato che sembra intero.
 */

export type Esito<T> = { ok: true; valore: T } | { ok: false; errore: unknown }

/** Le colonne di `RigaVotazione`, nello stesso ordine dell'interfaccia. */
export const COLONNE_VOTAZIONE =
  'id, scuola_id, titolo, scadenza, chiusa_il, rappresentante_istituto, creata_da, creata_il, aggiornata_da, aggiornata_il'

/** Il nome che compare dove un account non c'è più (spento): il voto resta, la persona no. */
export const NOME_ASSENTE = '—'

const CATALOGO_IT = it as Record<string, string>
const prosa = (codice: CodiceErrore): string => CATALOGO_IT[CODICI_ERRORE[codice]]

/**
 * I rifiuti delle route, ciascuno con il suo `codice` SCRITTO COME LETTERALE: il lock `errori-con-codice` non sa
 * leggere un `codice` che arriva da una variabile, e proprio per questo verifica che ogni codice letterale sia
 * dichiarato in `CODICI_ERRORE` e tradotto nelle due lingue. La prosa è quella del catalogo italiano, la stessa
 * di `rifiutoSede` e di `rispostaErroreDbVotazioni`: le strade non possono divergere.
 */
const RIFIUTI = {
  VOTAZIONE_NON_TROVATA: {
    status: 404,
    corpo: { error: prosa('VOTAZIONE_NON_TROVATA'), codice: 'VOTAZIONE_NON_TROVATA' },
  },
  VOTAZIONE_CHIUSA: { status: 409, corpo: { error: prosa('VOTAZIONE_CHIUSA'), codice: 'VOTAZIONE_CHIUSA' } },
  VOTAZIONE_CON_VOTI: { status: 409, corpo: { error: prosa('VOTAZIONE_CON_VOTI'), codice: 'VOTAZIONE_CON_VOTI' } },
  VOTAZIONE_CLASSE_GIA_APERTA: {
    status: 409,
    corpo: { error: prosa('VOTAZIONE_CLASSE_GIA_APERTA'), codice: 'VOTAZIONE_CLASSE_GIA_APERTA' },
  },
  VOTAZIONE_ISTITUTO_GIA_APERTA: {
    status: 409,
    corpo: { error: prosa('VOTAZIONE_ISTITUTO_GIA_APERTA'), codice: 'VOTAZIONE_ISTITUTO_GIA_APERTA' },
  },
  VOTAZIONE_SENZA_SCHEDE: {
    status: 400,
    corpo: { error: prosa('VOTAZIONE_SENZA_SCHEDE'), codice: 'VOTAZIONE_SENZA_SCHEDE' },
  },
  VOTAZIONE_SCADENZA_PASSATA: {
    status: 400,
    corpo: { error: prosa('VOTAZIONE_SCADENZA_PASSATA'), codice: 'VOTAZIONE_SCADENZA_PASSATA' },
  },
  VOTAZIONE_CLASSE_FUORI_SEDE: {
    status: 400,
    corpo: { error: prosa('VOTAZIONE_CLASSE_FUORI_SEDE'), codice: 'VOTAZIONE_CLASSE_FUORI_SEDE' },
  },
  VOTAZIONE_CANDIDATI_MANCANTI: {
    status: 400,
    corpo: { error: prosa('VOTAZIONE_CANDIDATI_MANCANTI'), codice: 'VOTAZIONE_CANDIDATI_MANCANTI' },
  },
  VOTAZIONE_CANDIDATO_NON_VALIDO: {
    status: 400,
    corpo: { error: prosa('VOTAZIONE_CANDIDATO_NON_VALIDO'), codice: 'VOTAZIONE_CANDIDATO_NON_VALIDO' },
  },
} as const

/** Una risposta d'errore col `codice` stabile e lo stato HTTP che gli compete. */
export function rifiutoVotazione(nome: keyof typeof RIFIUTI): NextResponse {
  const rifiuto = RIFIUTI[nome]
  return NextResponse.json(rifiuto.corpo, { status: rifiuto.status })
}

/** Uuid in forma di confronto: in Postgres è un tipo, non una stringa, e la maiuscola non lo distingue. */
export const forma = (id: string): string => id.trim().toLowerCase()

/** Un elenco di id senza vuoti né doppioni, in minuscolo. */
export function idUnici(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((i) => typeof i === 'string' && i.trim() !== '').map(forma))]
}

/**
 * Legge TUTTE le righe di una query, a blocchi (PostgREST taglia a `max_rows` senza dirlo). `chiave` è la
 * chiave UNICA che chiude l'ordine di ogni blocco (default `id`) e deve stare fra le colonne selezionate.
 */
export async function leggiTutte<T>(
  tipo: string,
  costruisci: () => QueryABlocchi,
  chiave?: readonly string[],
): Promise<Esito<T[]>> {
  const esito = await leggiABlocchi<T>(costruisci, chiave ? { chiave } : {})
  if (esito.ok) return { ok: true, valore: esito.righe }
  return { ok: false, errore: esito.motivo === 'errore' ? esito.error : new Error(descriviTetto(tipo, esito)) }
}

/** Il primo errore di un gruppo di esiti (letti in parallelo), o `null` se sono tutti riusciti. */
export function primoErrore(esiti: readonly Esito<unknown>[]): unknown | null {
  for (const e of esiti) if (!e.ok) return e.errore
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Le classi
// ─────────────────────────────────────────────────────────────────────────────

/** «1 PRIMARIA» prima di «2 ANNI» prima di «10 ANNI»: l'ordine è numerico, e l'id chiude i pari. */
export function ordinaClassi(classi: ClasseVotazione[]): ClasseVotazione[] {
  return [...classi].sort(
    (a, b) =>
      a.nome.localeCompare(b.nome, 'it', { numeric: true }) ||
      (a.sectionId < b.sectionId ? -1 : a.sectionId > b.sectionId ? 1 : 0),
  )
}

/**
 * Le classi di QUESTE sedi fra gli id dati, per id (in minuscolo). Una classe che non è di una di queste sedi
 * non compare: è così che il POST riconosce una classe di un'altra sede (`VOTAZIONE_CLASSE_FUORI_SEDE`).
 */
export async function leggiClassi(
  supabase: SupabaseClient,
  scuole: string[],
  sectionIds: readonly string[],
): Promise<Esito<Map<string, ClasseVotazione>>> {
  const mappa = new Map<string, ClasseVotazione>()
  const blocchi = await Promise.all(
    aBlocchi(idUnici(sectionIds), ID_PER_QUERY).map((blocco) =>
      supabase.from('sections').select('id, name, school_type').in('scuola_id', scuole).in('id', blocco),
    ),
  )
  for (const { data, error } of blocchi) {
    if (error) return { ok: false, errore: error }
    for (const r of (data ?? []) as { id?: unknown; name?: unknown; school_type?: unknown }[]) {
      if (typeof r.id !== 'string') continue
      mappa.set(forma(r.id), {
        sectionId: r.id,
        nome: typeof r.name === 'string' ? r.name : NOME_ASSENTE,
        grado: typeof r.school_type === 'string' ? r.school_type : null,
      })
    }
  }
  return { ok: true, valore: mappa }
}

// ─────────────────────────────────────────────────────────────────────────────
// Il riepilogo (l'elenco)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dalle righe di `votazioni` ai `RiepilogoVotazione`: aggiunge le classi (nome e grado) e i votanti, cioè gli
 * elettori DISTINTI su tutte le schede. Ogni lettura porta il filtro delle sedi; i voti si leggono a blocchi,
 * perché una sede ne ha più di mille. Non riordina le votazioni: lo fa chi chiama.
 */
export async function riepilogaVotazioni(
  supabase: SupabaseClient,
  votazioni: RigaVotazione[],
  scuole: string[],
): Promise<Esito<RiepilogoVotazione[]>> {
  if (votazioni.length === 0) return { ok: true, valore: [] }
  const blocchiId = aBlocchi(
    votazioni.map((v) => v.id),
    ID_PER_QUERY,
  )

  const [classiLette, votiLetti] = await Promise.all([
    Promise.all(
      blocchiId.map((blocco) =>
        leggiTutte<{ votazione_id: string; section_id: string }>(
          'votazioni-classi',
          () =>
            supabase
              .from('votazioni_classi')
              .select('votazione_id, section_id')
              .in('scuola_id', scuole)
              .in('votazione_id', blocco),
          ['votazione_id', 'section_id'],
        ),
      ),
    ),
    Promise.all(
      blocchiId.map((blocco) =>
        leggiTutte<{ id: string; votazione_id: string; elettore_id: string }>('votazioni-voti', () =>
          supabase
            .from('votazioni_voti')
            .select('id, votazione_id, elettore_id')
            .in('scuola_id', scuole)
            .in('votazione_id', blocco),
        ),
      ),
    ),
  ])
  const errore = primoErrore([...classiLette, ...votiLetti])
  if (errore !== null) return { ok: false, errore }

  const sectionPerVotazione = new Map<string, string[]>()
  for (const lettura of classiLette) {
    if (!lettura.ok) continue
    for (const r of lettura.valore) {
      const lista = sectionPerVotazione.get(forma(r.votazione_id)) ?? []
      lista.push(r.section_id)
      sectionPerVotazione.set(forma(r.votazione_id), lista)
    }
  }
  const elettoriPerVotazione = new Map<string, Set<string>>()
  for (const lettura of votiLetti) {
    if (!lettura.ok) continue
    for (const r of lettura.valore) {
      const set = elettoriPerVotazione.get(forma(r.votazione_id)) ?? new Set<string>()
      set.add(forma(r.elettore_id))
      elettoriPerVotazione.set(forma(r.votazione_id), set)
    }
  }

  const classi = await leggiClassi(supabase, scuole, [...sectionPerVotazione.values()].flat())
  if (!classi.ok) return classi

  const adesso = new Date()
  return {
    ok: true,
    valore: votazioni.map((v) => ({
      id: v.id,
      scuolaId: v.scuola_id,
      titolo: v.titolo,
      scadenza: v.scadenza,
      chiusaIl: v.chiusa_il,
      stato: statoVotazione({ scadenza: v.scadenza, chiusaIl: v.chiusa_il }, adesso),
      rappresentanteIstituto: v.rappresentante_istituto,
      classi: ordinaClassi(
        (sectionPerVotazione.get(forma(v.id)) ?? []).flatMap((s) => {
          const c = classi.valore.get(forma(s))
          return c ? [c] : []
        }),
      ),
      votanti: elettoriPerVotazione.get(forma(v.id))?.size ?? 0,
      creataIl: v.creata_il,
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// I conflitti (POST e riapertura con la proroga)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Una classe sta in UNA sola votazione aperta alla volta, e lo stesso vale per l'istituto di una sede. «Aperta»
 * è `chiusa_il IS NULL` e scadenza futura (la stessa definizione di `statoVotazione`, scritta come filtro).
 *
 * Torna `'classe'` se una delle classi date è già in un'altra votazione aperta DELLA SEDE, `'istituto'` se
 * `istituto` è vero e la sede ha già un'altra votazione aperta con il rappresentante d'istituto, altrimenti
 * `null`. La classe viene prima dell'istituto. `escludiId` è la votazione che si sta riaprendo: non confligge
 * con sé stessa.
 *
 * ⚠️ È un controllo, non un vincolo: fra la lettura e la scrittura una seconda richiesta può passare. Il
 * database non ha un indice che lo impedisca (le due condizioni stanno su tabelle diverse).
 */
export async function trovaConflitto(
  supabase: SupabaseClient,
  scuolaId: string,
  sectionIds: readonly string[],
  istituto: boolean,
  escludiId: string | null,
): Promise<Esito<'classe' | 'istituto' | null>> {
  const adesso = new Date().toISOString()
  const lette = await leggiTutte<{ id: string; rappresentante_istituto: boolean }>('votazioni-aperte', () =>
    supabase
      .from('votazioni')
      .select('id, rappresentante_istituto')
      .eq('scuola_id', scuolaId)
      .is('chiusa_il', null)
      .gt('scadenza', adesso),
  )
  if (!lette.ok) return lette
  const escluso = escludiId === null ? null : forma(escludiId)
  const aperte = lette.valore.filter((v) => forma(v.id) !== escluso)
  if (aperte.length === 0) return { ok: true, valore: null }

  const classi = idUnici(sectionIds)
  if (classi.length > 0) {
    const coppie = aBlocchi(
      aperte.map((v) => v.id),
      ID_PER_QUERY,
    ).flatMap((bloccoVotazioni) =>
      aBlocchi(classi, ID_PER_QUERY).map((bloccoClassi) =>
        leggiTutte<{ votazione_id: string; section_id: string }>(
          'votazioni-classi-aperte',
          () =>
            supabase
              .from('votazioni_classi')
              .select('votazione_id, section_id')
              .eq('scuola_id', scuolaId)
              .in('votazione_id', bloccoVotazioni)
              .in('section_id', bloccoClassi),
          ['votazione_id', 'section_id'],
        ),
      ),
    )
    const letture = await Promise.all(coppie)
    const errore = primoErrore(letture)
    if (errore !== null) return { ok: false, errore }
    if (letture.some((l) => l.ok && l.valore.length > 0)) return { ok: true, valore: 'classe' }
  }

  if (istituto && aperte.some((v) => v.rappresentante_istituto)) return { ok: true, valore: 'istituto' }
  return { ok: true, valore: null }
}
