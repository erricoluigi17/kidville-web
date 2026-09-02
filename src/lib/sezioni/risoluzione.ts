import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { assertClasseNomeInScope, assertSezioneInScope } from '@/lib/auth/scope'
import { logEvento } from '@/lib/logging/logger'
import type { NextResponse } from 'next/server'

/**
 * L'IDENTITÀ DI UNA CLASSE È IL SUO UUID, MAI IL SUO NOME.
 *
 * ─── IL GUASTO CHE QUESTO MODULO ESISTE PER CHIUDERE ────────────────────────
 * `alunni` tiene la classe in due colonne: `section_id` (uuid, la FK vera) e
 * `classe_sezione` (testo). L'area docente 0-6 cercava i bambini per TESTO
 * (`.eq('classe_sezione', sections.name)`); la primaria, da sempre, per uuid.
 * Il trigger `sync_alunno_section_id` va solo testo → uuid e confronta senza
 * spazi né maiuscole — quindi il testo può divergere dal nome della sezione
 * MENTRE `section_id` resta giusto.
 *
 * Misurato in produzione il 2026-09-02: cinque sezioni di Kidville Giugliano
 * avevano il testo scritto dal foglio di iscrizione (`4 anni  a` con due spazi,
 * `3 ANNI B ` con lo spazio finale, `5 anni b` minuscolo). Il gate risolveva il
 * nome, la query non trovava nessuno, e la route rispondeva **200 con `[]`**:
 * nessun errore, nessun log, schermata bianca. Tre di quelle classi si aprivano
 * PARZIALI — 1 bambino su 14, 1 su 12, 4 su 16 — e una classe quasi vuota
 * sembra vera, mentre una vuota fa telefonare.
 *
 * ─── PERCHÉ IL NOME NON SI PUÒ TENERE COME CHIAVE ───────────────────────────
 * 1. Non è univoco fra sedi: «2 ANNI A» esiste a Giugliano e ad Aversa, «3 ANNI»
 *    ad Aversa e (con altro suffisso) a Cesa.
 * 2. Rinominare una sezione da `admin/sections:PATCH` — o da una migrazione, come
 *    hanno fatto Aversa il 31/08 e Cesa il 20/08 — cambia `sections.name` e NON
 *    `alunni.classe_sezione`: da quell'istante la classe è vuota per la maestra.
 * 3. L'unicità che esiste (`sections_nome_per_sede` su `(scuola_id, name)`) NON
 *    copre la forma normalizzata, che è quella che il trigger usa.
 *
 * ─── COSA FA QUESTO MODULO, E COSA NON FA ───────────────────────────────────
 * Traduce «la classe di cui il client parla» in un insieme di `sections.id`,
 * applicando PRIMA il gate giusto per la forma in cui l'identità è arrivata.
 * Non sostituisce un gate con l'altro: se arriva il nome resta il gate del nome
 * (che è quello che sa negare l'omonimia cross-sede), e la risoluzione a uuid
 * viene DOPO. Non allarga mai: insieme vuoto ⇒ si nega o si risponde vuoto.
 */

/**
 * Le sezioni, dentro i plessi dati, che portano un dato NOME.
 *
 * Promozione di `sezioniConNome`, che viveva privata dentro
 * `src/app/api/locker/materials/route.ts` — l'unica route 0-6 che era già
 * corretta, e che quindi è il modello di tutte le altre.
 *
 * ⚠️ Ritorna un ARRAY e non un id singolo: fra sedi diverse il nome si ripete, e
 * un admin multi-plesso che chiede «2 ANNI A» ne ha legittimamente due. Chi
 * chiama filtra con `.in('section_id', …)`, mai con `.eq`.
 *
 * PostgREST non lancia: l'errore si guarda e si logga, e si degrada a `[]` —
 * cioè a «nessuna sezione», che tutti i chiamanti trattano come diniego.
 */
export async function sezioniDiNome(
  supabase: SupabaseClient,
  nome: string,
  plessi: readonly string[],
): Promise<string[]> {
  if (!nome || plessi.length === 0) return []
  const { data, error } = await supabase
    .from('sections')
    .select('id')
    .eq('name', nome)
    .in('scuola_id', plessi as string[])
  if (error) {
    logEvento('auth', 'error', {
      tipo: 'sezioni-di-nome-non-risolte', azione: 'sezioniDiNome', sezione: nome,
    }, error)
    return []
  }
  return (data ?? []).map((s) => s.id as string)
}

/** Esito di `risolviSezione`: o una risposta 4xx pronta, o gli id delle sezioni. */
export type EsitoRisoluzione =
  | { response: NextResponse; sectionIds?: undefined }
  | { response?: undefined; sectionIds: string[] }

/**
 * Il ponte unico fra «la classe di cui il client parla» e gli uuid su cui si
 * filtra. **È l'unico posto in cui si sceglie quale gate applicare**, e il
 * motivo per cui è uno solo è che la scelta sbagliata non si vede: passare al
 * gate dell'uuid senza portarsi dietro `soloSezioniAssegnate` allarga i permessi
 * di un educator a tutto il plesso, e nessun test che conti righe se ne accorge.
 *
 * - `sectionId` presente → `assertSezioneInScope`, che per chi non vede tutte le
 *   classi verifica **anche** `utenti_sezioni`. È il gate corretto: nomina la
 *   sezione senza ambiguità.
 * - solo `nome` → `assertClasseNomeInScope` con `{ soloSezioniAssegnate: true }`,
 *   che è ciò che impedisce di NOMINARE la classe di un altro, **e subito dopo**
 *   la risoluzione a uuid dentro i plessi.
 *
 * ⚠️ `assertSezioneInScope` risponde **400** se l'id manca (`scope.ts:465-467`),
 * mentre le route 0-6 hanno il contratto storico «senza sezione → `[]`, mai un
 * 400»: la UI le chiama anche prima di aver risolto la classe. Per questo il
 * ramo dell'uuid si imbocca solo quando il parametro c'è davvero, e l'assenza di
 * entrambi è un caso che il chiamante gestisce PRIMA (rispondendo `[]`), non qui.
 */
export async function risolviSezione(
  supabase: SupabaseClient,
  user: AppUser,
  identita: { sectionId?: string | null; nome?: string | null },
  plessi: readonly string[],
): Promise<EsitoRisoluzione> {
  if (identita.sectionId) {
    const fuori = await assertSezioneInScope(supabase, user, identita.sectionId)
    if (fuori) return { response: fuori }
    return { sectionIds: [identita.sectionId] }
  }

  const nome = identita.nome ?? ''
  const fuori = await assertClasseNomeInScope(supabase, user, nome, { soloSezioniAssegnate: true })
  if (fuori) return { response: fuori }

  const ids = await sezioniDiNome(supabase, nome, plessi)
  if (ids.length === 0) {
    // Il gate è passato (la sezione ESISTE nei plessi dell'utente) ma la
    // risoluzione non trova niente: significa che i due insiemi di plessi non
    // coincidono — il gate usa `scuoleDiUtente`, questa usa le sedi ATTIVE del
    // SedeSelector. È uno stato legittimo (la maestra ha deselezionato la sede
    // della classe), ma se resta muto torna a essere lo stesso guasto di prima:
    // 200 con lista vuota e nessuno che sappia perché.
    logEvento('auth', 'warn', {
      tipo: 'sezione-non-risolta-nei-plessi-attivi', azione: 'risolviSezione',
      utente: user.id, ruolo: user.role, sezione: nome,
    })
  }
  return { sectionIds: ids }
}
