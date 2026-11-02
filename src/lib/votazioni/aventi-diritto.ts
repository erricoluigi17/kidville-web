import type { SupabaseClient } from '@supabase/supabase-js'
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato'
import { getFigliAttiviDiGenitore, getGenitoriDiAlunniEsito } from '@/lib/anagrafiche/legami'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'
import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/db/leggi-a-blocchi'
import { logEvento } from '@/lib/logging/logger'
import type { GenitoreScheda } from './tipi'

/**
 * VOTAZIONI · GLI AVENTI DIRITTO, LETTI DAL DATABASE.
 *
 * Un avente diritto è un GENITORE CON UN ACCOUNT (e attivo) che ha un figlio ancora a scuola in una delle
 * classi della votazione. Tutte le letture di questo file nascono da quella frase:
 *
 *  · gli ALUNNI si filtrano per `section_id` (l'identità della classe: il nome «2 ANNI» esiste in più sedi,
 *    lock `identita-della-classe`), per `scuola_id`, per `stato IN STATI_CON_CANALE_FAMIGLIA` (il sospeso
 *    frequenta, il ritirato no: lock `elenchi-operativi-solo-iscritti`) e per `archiviato_il IS NULL`;
 *  · dagli alunni ai genitori si passa da `getGenitoriDiAlunniEsito`, che unisce il legame runtime
 *    (`legame_genitori_alunni`) e l'anagrafica (`student_parents` → `parents.auth_user_id`). Un `parents`
 *    senza account non produce nessun elettore;
 *  · i NOMI vengono da `utenti` con `attivo = true`, SENZA filtrare `ruolo`: una docente che è anche madre
 *    di un alunno ha un account con `ruolo = 'docente'` e ha diritto di voto come tutti.
 *
 * ── «COMPLETO» E L'ERRORE ────────────────────────────────────────────────────
 *
 * PostgREST non lancia: ritorna `{ error }`, e una lettura fallita non è «nessun avente diritto». Ogni
 * funzione restituisce `EsitoGenitori`: `valore` è ciò che si è letto, `completo: false` dice che può essere
 * CORTO, `errore` dice perché. Vale sempre `completo === false` ⇒ `errore !== null`, così la route che ha
 * bisogno di un oggetto da passare a `rispostaErroreDbVotazioni` ce l'ha. Chi RIFIUTA (un voto non ammesso)
 * deve guardare `completo`; chi mostra un elenco può mostrare meno, mai di più.
 *
 * ── A BLOCCHI ────────────────────────────────────────────────────────────────
 *
 * Gli alunni si leggono con `leggiABlocchi` (PostgREST taglia a `max_rows` senza dirlo: una sede può averne
 * più di mille) e gli elenchi di id nell'URL vanno a blocchi di `ID_PER_QUERY` (un `.in()` con mille uuid
 * è un 414). Un blocco caduto fa fallire l'alunno-lettura per intero: un elenco a metà non si consegna.
 *
 * ── COSA SI LOGGA ────────────────────────────────────────────────────────────
 *
 * Un guasto lascia UNA riga `error` sul canale `votazioni`, con l'operazione e il codice del database. MAI
 * un nome, mai l'uuid di un bambino (AGENTS.md, regola 8). Il successo non si logga qui: sono letture, il
 * battito di successo sta nelle route che scrivono.
 */

export interface EsitoGenitori<T> {
  valore: T
  completo: boolean
  errore: unknown | null
}

/** Uuid in forma di confronto: in Postgres è un tipo, non una stringa, e la maiuscola non lo distingue. */
const forma = (id: string): string => id.trim().toLowerCase()

/** Un elenco di id senza vuoti né doppioni, in minuscolo, nell'ordine d'arrivo. */
function idUnici(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((i) => typeof i === 'string' && i.trim() !== '').map(forma))]
}

/** L'errore da riferire quando `leggiABlocchi` non ha consegnato le righe (un blocco caduto, oppure il tetto). */
function erroreDaBlocchi(esito: Extract<EsitoABlocchi<unknown>, { ok: false }>, tipo: string): unknown {
  return esito.motivo === 'errore' ? esito.error : new Error(descriviTetto(tipo, esito))
}

/** UNA riga per guasto: canale `votazioni`, operazione e codice. Niente nomi, niente uuid di bambini. */
function segnalaGuasto(operazione: string, errore: unknown): void {
  logEvento('votazioni', 'error', { operazione, esito: 'lettura-non-riuscita' }, errore)
}

// ─────────────────────────────────────────────────────────────────────────────
// Nomi
// ─────────────────────────────────────────────────────────────────────────────

/** Il nome mostrato a schermo: «Cognome Nome». */
function nomeScheda(cognome: string | null, nome: string | null): string {
  return [cognome, nome]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

interface RigaNome {
  utenteId: string
  cognome: string
  nome: string
}

/** Cognome, poi nome, poi id: l'id chiude l'ordine perché l'uscita non dipenda da come risponde il database. */
function confrontaRigheNome(a: RigaNome, b: RigaNome): number {
  return (
    a.cognome.localeCompare(b.cognome, 'it') ||
    a.nome.localeCompare(b.nome, 'it') ||
    (a.utenteId < b.utenteId ? -1 : a.utenteId > b.utenteId ? 1 : 0)
  )
}

/** Legge i nomi SENZA loggare: chi chiama decide quando e quante volte. */
async function leggiNomi(supabase: SupabaseClient, utenteIds: readonly string[]): Promise<EsitoGenitori<GenitoreScheda[]>> {
  const unici = idUnici(utenteIds)
  if (unici.length === 0) return { valore: [], completo: true, errore: null }

  const blocchi = await Promise.all(
    aBlocchi(unici, ID_PER_QUERY).map((blocco) =>
      supabase.from('utenti').select('id, nome, cognome').in('id', blocco).eq('attivo', true),
    ),
  )

  const righe: RigaNome[] = []
  let errore: unknown | null = null
  for (const { data, error } of blocchi) {
    if (error) {
      errore = errore ?? error
      continue
    }
    for (const r of (data ?? []) as { id?: unknown; nome?: unknown; cognome?: unknown }[]) {
      if (typeof r.id !== 'string') continue
      righe.push({
        utenteId: r.id,
        cognome: typeof r.cognome === 'string' ? r.cognome : '',
        nome: typeof r.nome === 'string' ? r.nome : '',
      })
    }
  }

  righe.sort(confrontaRigheNome)
  return {
    valore: righe.map((r) => ({ utenteId: r.utenteId, nome: nomeScheda(r.cognome, r.nome) })),
    completo: errore === null,
    errore,
  }
}

/**
 * I genitori con un account attivo fra questi `utenti.id`, nella forma delle schede: «Cognome Nome», per
 * cognome e poi nome. Nessun filtro su `ruolo`. Gli id che non corrispondono a un account attivo
 * semplicemente non ci sono.
 *
 * Serve anche per validare i candidati: un id che non torna da qui non è un candidato possibile.
 */
export async function nomiGenitori(
  supabase: SupabaseClient,
  utenteIds: string[],
): Promise<EsitoGenitori<GenitoreScheda[]>> {
  const esito = await leggiNomi(supabase, utenteIds)
  if (esito.errore !== null) segnalaGuasto('votazioni/aventi-diritto:nomiGenitori', esito.errore)
  return esito
}

// ─────────────────────────────────────────────────────────────────────────────
// Genitori delle classi
// ─────────────────────────────────────────────────────────────────────────────

interface GenitoriCalcolati {
  /** `sectionId` → genitori con account attivo. Ha TUTTE le classi chieste, anche quelle a 0. */
  perClasse: Map<string, GenitoreScheda[]>
  /** Tutti i genitori distinti, nell'ordine di cognome e nome. */
  tutti: GenitoreScheda[]
  completo: boolean
  errore: unknown | null
}

async function calcolaGenitoriDelleClassi(
  supabase: SupabaseClient,
  scuolaId: string,
  sectionIds: readonly string[],
): Promise<GenitoriCalcolati> {
  const classi = idUnici(sectionIds)
  const perClasse = new Map<string, GenitoreScheda[]>(classi.map((c) => [c, []]))
  if (classi.length === 0) return { perClasse, tutti: [], completo: true, errore: null }

  // 1. Gli alunni che frequentano, nelle classi chieste, di QUESTA sede.
  const lettureAlunni = await Promise.all(
    aBlocchi(classi, ID_PER_QUERY).map((blocco) =>
      leggiABlocchi<{ id: string; section_id: string }>(() =>
        supabase
          .from('alunni')
          .select('id, section_id')
          .eq('scuola_id', scuolaId)
          .in('section_id', blocco)
          .in('stato', [...STATI_CON_CANALE_FAMIGLIA])
          .is('archiviato_il', null),
      ),
    ),
  )
  const sezionePerAlunno = new Map<string, string>()
  for (const lettura of lettureAlunni) {
    if (!lettura.ok) {
      // Tutto o niente: un elenco di alunni a metà darebbe aventi diritto a metà, con l'aria di essere interi.
      return { perClasse, tutti: [], completo: false, errore: erroreDaBlocchi(lettura, 'votazioni-alunni') }
    }
    for (const a of lettura.righe) {
      if (typeof a.id === 'string' && typeof a.section_id === 'string') sezionePerAlunno.set(a.id, forma(a.section_id))
    }
  }
  if (sezionePerAlunno.size === 0) return { perClasse, tutti: [], completo: true, errore: null }

  // 2. Dagli alunni ai loro genitori (account), a blocchi: sono tre query fisse per blocco.
  const legami = await Promise.all(
    aBlocchi([...sezionePerAlunno.keys()], ID_PER_QUERY).map((blocco) => getGenitoriDiAlunniEsito(supabase, blocco)),
  )
  let completo = true
  const genitoriPerAlunno = new Map<string, string[]>()
  for (const l of legami) {
    if (!l.completo) completo = false
    for (const [alunnoId, accountIds] of l.perAlunno) genitoriPerAlunno.set(alunnoId, accountIds)
  }
  let errore: unknown | null = completo ? null : new Error('lettura-legami-genitori-incompleta')

  // 3. I nomi, e con loro il filtro sugli account attivi.
  const tuttiGliAccount = idUnici([...genitoriPerAlunno.values()].flat())
  const nomi = await leggiNomi(supabase, tuttiGliAccount)
  if (nomi.errore !== null) {
    completo = false
    errore = errore ?? nomi.errore
  }

  // 4. Per classe: un genitore compare UNA volta anche con più figli nella stessa classe, e in ogni
  //    classe in cui ha un figlio. L'ordine è quello di `nomi.valore` (cognome, nome).
  const accountPerClasse = new Map<string, Set<string>>()
  for (const [alunnoId, sectionId] of sezionePerAlunno) {
    const set = accountPerClasse.get(sectionId) ?? new Set<string>()
    for (const accountId of genitoriPerAlunno.get(alunnoId) ?? []) set.add(forma(accountId))
    accountPerClasse.set(sectionId, set)
  }
  for (const classe of classi) {
    const set = accountPerClasse.get(classe)
    perClasse.set(classe, set ? nomi.valore.filter((g) => set.has(forma(g.utenteId))) : [])
  }
  const inAlmenoUnaClasse = new Set([...perClasse.values()].flat().map((g) => g.utenteId))

  return {
    perClasse,
    tutti: nomi.valore.filter((g) => inAlmenoUnaClasse.has(g.utenteId)),
    completo,
    errore,
  }
}

/**
 * Gli aventi diritto di ciascuna classe: `sectionId` → i genitori con un account attivo che hanno un figlio
 * ancora a scuola in quella classe, in ordine di cognome e nome.
 *
 * La Map ha TUTTE le classi chieste, anche quelle senza genitori (lista vuota, cioè «aventi diritto 0», e
 * non una classe assente). Un genitore con due figli nella stessa classe compare una volta; con figli in
 * due classi compare in entrambe.
 *
 * Una lista di classi vuota non interroga il database.
 */
export async function genitoriDelleClassi(
  supabase: SupabaseClient,
  scuolaId: string,
  sectionIds: string[],
): Promise<EsitoGenitori<Map<string, GenitoreScheda[]>>> {
  const c = await calcolaGenitoriDelleClassi(supabase, scuolaId, sectionIds)
  if (c.errore !== null) segnalaGuasto('votazioni/aventi-diritto:genitoriDelleClassi', c.errore)
  return { valore: c.perClasse, completo: c.completo, errore: c.errore }
}

/**
 * I genitori con un account attivo di TUTTA la sede (l'unione delle sue classi), senza doppioni, in ordine
 * di cognome e nome. Sono i candidati possibili del rappresentante d'istituto.
 *
 * Le classi vengono da `sections` per `scuola_id`; poi valgono le stesse regole di `genitoriDelleClassi`.
 */
export async function genitoriDellaSede(
  supabase: SupabaseClient,
  scuolaId: string,
): Promise<EsitoGenitori<GenitoreScheda[]>> {
  const sezioni = await leggiABlocchi<{ id: string }>(() =>
    supabase.from('sections').select('id').eq('scuola_id', scuolaId),
  )
  if (!sezioni.ok) {
    const errore = erroreDaBlocchi(sezioni, 'votazioni-classi-della-sede')
    segnalaGuasto('votazioni/aventi-diritto:genitoriDellaSede', errore)
    return { valore: [], completo: false, errore }
  }
  const c = await calcolaGenitoriDelleClassi(
    supabase,
    scuolaId,
    sezioni.righe.map((s) => s.id),
  )
  if (c.errore !== null) segnalaGuasto('votazioni/aventi-diritto:genitoriDellaSede', c.errore)
  return { valore: c.tutti, completo: c.completo, errore: c.errore }
}

// ─────────────────────────────────────────────────────────────────────────────
// Le schede di un genitore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I figli ancora a scuola di UN genitore (`utenti.id`), con la classe e la sede: il punto di partenza delle
 * sue schede. Da qui la route ricava le classi distinte (due figli nella stessa classe sono UNA scheda) e
 * le sedi (l'istituto, una scheda per sede).
 *
 * Passa da `getFigliAttiviDiGenitore`, lo stesso criterio che decide quali figli la sua app mostra: un
 * archiviato, un ritirato o un bambino senza classe non genera una scheda. I figli senza `section_id` o
 * senza `scuola_id` non si possono collocare in nessuna scheda e non compaiono.
 */
export async function figliAttiviConClasse(
  supabase: SupabaseClient,
  utenteId: string,
): Promise<EsitoGenitori<{ alunnoId: string; sectionId: string; scuolaId: string }[]>> {
  const esito = await getFigliAttiviDiGenitore(supabase, utenteId)
  const valore: { alunnoId: string; sectionId: string; scuolaId: string }[] = []
  for (const r of esito.righe) {
    if (r.section_id && r.scuola_id) valore.push({ alunnoId: r.id, sectionId: r.section_id, scuolaId: r.scuola_id })
  }
  // Il guasto lo ha già registrato `getFigliAttiviDiGenitore` (`segnalaLetturaLegami`): qui non si raddoppia.
  const errore = esito.errore ?? (esito.completo ? null : new Error('lettura-figli-incompleta'))
  return { valore, completo: errore === null, errore }
}
