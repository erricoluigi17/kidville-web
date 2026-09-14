/**
 * IL BAMBINO GEMELLO — lo stesso bambino, arrivato con un codice fiscale diverso.
 *
 * ─── IL GUASTO, MISURATO IL 2026-09-14 ──────────────────────────────────────
 * Nella stessa sede c'erano sette coppie di alunni doppi (sanate a mano quel
 * giorno: `docs/sanatoria-doppioni-e-account-orfano-2026-09-14.md`). In tutte e
 * sette: stesso nome, cognome e data di nascita; codici fiscali diversi per UN
 * carattere, e uno dei due col carattere di controllo sbagliato. Spesso la famiglia
 * aveva inviato il modulo due volte, una delle due col refuso.
 *
 * I due import riconoscevano un bambino SOLO per codice fiscale identico. Il
 * refuso faceva nascere un secondo alunno — e a volte un secondo genitore —, i
 * genitori vedevano due figli e due rette, i solleciti partivano per la retta
 * fantasma, e un bonifico è stato riconciliato sulla copia sbagliata. Nessun
 * errore, nessun log: dal punto di vista del codice era un bambino nuovo.
 *
 * ─── COSA FA QUESTO MODULO, E COSA NO ───────────────────────────────────────
 * TROVA, e basta. Non decide niente: che cosa fare di un gemello lo decide chi
 * chiama, perché le due strade hanno risposte diverse — quella manuale ferma
 * l'import e chiede alla segreteria, quella automatica mette la domanda fra le
 * «da controllare». Qui si scrive un log solo quando la LETTURA fallisce, che è
 * l'unico fatto di cui questo modulo è testimone.
 *
 * Una lettura fallita non boccia un'iscrizione (`non_verificabile`): è la stessa
 * regola della deduplica per codice fiscale. Non sapere non può voler dire «no».
 *
 * ─── CHE COS'È «LO STESSO NOME» ─────────────────────────────────────────────
 * La stessa uguaglianza con cui l'import abbina un bambino all'elenco di classe
 * (`./import/abbinamento.ts`), provata nelle stesse tre forme: il nome
 * normalizzato, le stesse parole in un altro ordine, lo stesso nome con gli spazi
 * altrove. Nessuna soglia di somiglianza: `EMNA` per `EMMA` è un refuso da far
 * vedere a una persona, non una grafia da perdonare — e due gemelli veri hanno lo
 * stesso cognome e la stessa data, ma nomi diversi.
 *
 * ─── NEI LOG ────────────────────────────────────────────────────────────────
 * Solo uuid, indici e codici d'errore. Mai nomi, codici fiscali o date di
 * nascita: sono i tre dati con cui qui si cerca, e sono di minori.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { SCHEMA_ASSENTE } from '@/lib/alunni/sezione'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'
import { logEvento } from '@/lib/logging/logger'
import { normalizzaNome, senzaSpazi, stessiToken, tokenNome } from './import/normalizza'

/** Chi si sta cercando, come arriva dalla domanda: niente è garantito. */
export interface PersonaDaRiconoscere {
  nome: unknown
  cognome: unknown
  dataNascita: unknown
  /**
   * Il codice fiscale della domanda, COSÌ COME l'import lo cercherà.
   *
   * Chi porta esattamente quel codice non è un gemello: è la stessa scheda, e la
   * ritrova la ricerca per codice fiscale. Il confronto toglie soltanto gli spazi
   * in coda — `alunni.codice_fiscale` è `character(16)` e torna impaginato — e NON
   * le maiuscole: un codice scritto in minuscolo che la ricerca esatta non
   * ritroverebbe resta un gemello, cioè finisce davanti a una persona invece di
   * diventare un secondo alunno.
   */
  codiceFiscale?: unknown
}

export interface ContestoRicerca {
  /** L'operazione nei log, es. `admin/iscrizioni:PATCH`. */
  operazione: string
  /** La posizione della persona nella domanda, da 1: solo per i log. */
  indice?: number
  /** La domanda che si sta importando, se c'è. */
  domandaId?: string
}

export interface SchedaAlunnoGemella {
  id: string
  /**
   * Il codice fiscale della scheda esistente supera il carattere di controllo?
   * `null` se la scheda non ne ha uno. È il discriminante delle sette coppie: in
   * cinque casi su sette il codice sbagliato era sulla copia ATTIVA, cioè quello
   * che finisce in fattura.
   */
  codiceFiscaleValido: boolean | null
}

export interface SchedaGenitoreGemella {
  id: string
  authUserId: string | null
  /** Le email della SCHEDA, non della domanda: vedi la route d'import manuale. */
  emails: string[]
}

export type EsitoGemello<S> =
  | { esito: 'nessuno' }
  | { esito: 'trovato'; schede: S[] }
  | { esito: 'non_verificabile'; errore: unknown }

function testo(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Lo stesso nome, nelle tre forme dell'abbinamento all'elenco.
 *
 * Nome e cognome si uniscono prima di confrontarli, come fa `abbina`: così un
 * modulo che li ha scambiati di casella ritrova lo stesso bambino. Un nome vuoto
 * non combacia con niente — nemmeno con un altro vuoto.
 */
export function stessoNome(
  a: { nome: unknown; cognome: unknown },
  b: { nome: unknown; cognome: unknown },
): boolean {
  if (!normalizzaNome(testo(a.nome)) || !normalizzaNome(testo(a.cognome))) return false
  if (!normalizzaNome(testo(b.nome)) || !normalizzaNome(testo(b.cognome))) return false
  const x = normalizzaNome(`${testo(a.cognome)} ${testo(a.nome)}`)
  const y = normalizzaNome(`${testo(b.cognome)} ${testo(b.nome)}`)
  if (x === y) return true
  if (stessiToken(tokenNome(x), tokenNome(y))) return true
  return senzaSpazi(x) === senzaSpazi(y)
}

/**
 * Il giorno di nascita come lo confronta il database (`YYYY-MM-DD`), oppure
 * `null` se il valore non ne contiene uno. Una data mancante o illeggibile non si
 * manda a PostgREST: risponderebbe con un errore di formato, e un dato incompleto
 * della domanda diventerebbe un «guasto» nei log.
 */
function giornoDiNascita(v: unknown): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(testo(v).trim())
  return m ? m[1] : null
}

/** Stesso codice, a meno degli spazi in coda di `character(16)`. */
function stessoCodice(daScheda: unknown, cercato: unknown): boolean {
  const c = testo(cercato).trimEnd()
  return c !== '' && testo(daScheda).trimEnd() === c
}

/** La lettura fallita si scrive qui: è l'unico fatto di cui il modulo è testimone. */
function registraNonVerificabile(
  entita: 'bambino' | 'genitore',
  errore: { code?: string } | null,
  contesto: ContestoRicerca,
  sedeId?: string,
): void {
  const codice = errore?.code ?? null
  // `info` quando lo schema non c'è (il DB E2E della CI non è migrato: un ambiente
  // diverso, non un guasto), `error` in tutti gli altri casi.
  logEvento(
    'iscrizione',
    codice && SCHEMA_ASSENTE.has(codice) ? 'info' : 'error',
    {
      operazione: contesto.operazione,
      esito: 'gemello-non-verificabile',
      entita,
      entita_tipo: entita === 'bambino' ? 'alunni' : 'parents',
      indice: contesto.indice,
      entita_id: contesto.domandaId,
      sede_id: sedeId,
      error_code: codice,
    },
    errore ?? new Error('risposta non conforme: nessun elenco di righe'),
  )
}

/**
 * Gli alunni della STESSA sede con la stessa data di nascita e lo stesso nome,
 * non anonimizzati — ARCHIVIATI COMPRESI: una copia archiviata è ancora legata a
 * genitori e rette, ed è esattamente il doppione che i genitori continuavano a
 * vedere. Chi porta esattamente il codice cercato è escluso (vedi
 * `PersonaDaRiconoscere.codiceFiscale`).
 *
 * La sede è nella query, non dopo: un bambino con lo stesso nome in un altro plesso
 * è un trasferimento o un omonimo, e lo gestisce la regola sul codice fiscale in
 * altra sede.
 */
export async function cercaGemelloAlunno(
  supabase: SupabaseClient,
  persona: PersonaDaRiconoscere & { scuolaId: string },
  contesto: ContestoRicerca = { operazione: 'iscrizioni/doppioni' },
): Promise<EsitoGemello<SchedaAlunnoGemella>> {
  const giorno = giornoDiNascita(persona.dataNascita)
  if (!giorno || !normalizzaNome(testo(persona.nome)) || !normalizzaNome(testo(persona.cognome))) {
    return { esito: 'nessuno' }
  }

  // Si legge per sede e data, e il nome si confronta qui: la normalizzazione del
  // nome (accenti, apostrofi, parole invertite) non ha un equivalente in un filtro
  // PostgREST, e i nati nello stesso giorno in un plesso sono una manciata.
  // `anonimizzato_il` si legge e si scarta qui invece di filtrarlo nella query:
  // stesso risultato, e le righe tornano comunque senza dati — l'oblio le ha già
  // sostituite con un segnaposto.
  const { data, error } = await supabase
    .from('alunni')
    .select('id, nome, cognome, codice_fiscale, anonimizzato_il')
    .eq('scuola_id', persona.scuolaId)
    .eq('data_nascita', giorno)
  if (error || !Array.isArray(data)) {
    registraNonVerificabile('bambino', error as { code?: string } | null, contesto, persona.scuolaId)
    return { esito: 'non_verificabile', errore: error ?? new Error('risposta non conforme') }
  }

  const schede: SchedaAlunnoGemella[] = []
  for (const r of data as Record<string, unknown>[]) {
    if (typeof r.id !== 'string' || r.anonimizzato_il) continue
    if (stessoCodice(r.codice_fiscale, persona.codiceFiscale)) continue
    if (!stessoNome({ nome: r.nome, cognome: r.cognome }, persona)) continue
    const cf = testo(r.codice_fiscale).trim()
    schede.push({ id: r.id, codiceFiscaleValido: cf === '' ? null : validaCodiceFiscale(cf).valido })
  }
  return schede.length > 0 ? { esito: 'trovato', schede } : { esito: 'nessuno' }
}

/**
 * Le schede genitore con lo stesso nome e la stessa data di nascita, non
 * anonimizzate. NESSUN vincolo di sede, e non è una svista: `parents` non ha una
 * sede propria — un adulto può avere figli in due plessi — ed è la stessa scelta
 * della deduplica per codice fiscale dei due import.
 */
export async function cercaGemelloGenitore(
  supabase: SupabaseClient,
  persona: PersonaDaRiconoscere,
  contesto: ContestoRicerca = { operazione: 'iscrizioni/doppioni' },
): Promise<EsitoGemello<SchedaGenitoreGemella>> {
  const giorno = giornoDiNascita(persona.dataNascita)
  if (!giorno || !normalizzaNome(testo(persona.nome)) || !normalizzaNome(testo(persona.cognome))) {
    return { esito: 'nessuno' }
  }

  const { data, error } = await supabase
    .from('parents')
    .select('id, first_name, last_name, fiscal_code, auth_user_id, emails, anonimizzato_il')
    .eq('birth_date', giorno)
  if (error || !Array.isArray(data)) {
    registraNonVerificabile('genitore', error as { code?: string } | null, contesto)
    return { esito: 'non_verificabile', errore: error ?? new Error('risposta non conforme') }
  }

  const schede: SchedaGenitoreGemella[] = []
  for (const r of data as Record<string, unknown>[]) {
    if (typeof r.id !== 'string' || r.anonimizzato_il) continue
    if (stessoCodice(r.fiscal_code, persona.codiceFiscale)) continue
    if (!stessoNome({ nome: r.first_name, cognome: r.last_name }, persona)) continue
    schede.push({
      id: r.id,
      authUserId: typeof r.auth_user_id === 'string' ? r.auth_user_id : null,
      emails: Array.isArray(r.emails) ? r.emails.filter((e): e is string => typeof e === 'string' && e.trim() !== '') : [],
    })
  }
  return schede.length > 0 ? { esito: 'trovato', schede } : { esito: 'nessuno' }
}

/** Un bambino della domanda, nella forma in cui lo porta l'import massivo. */
export interface BambinoDaControllare {
  /** La posizione nella domanda, da 0. */
  indice: number
  nome: unknown
  cognome: unknown
  dataNascita: unknown
  codiceFiscale: unknown
}

/**
 * Il primo bambino della domanda che ha un gemello in sede, oppure `null`.
 *
 * Una lettura fallita su un bambino non ferma la domanda: è già scritta nel log da
 * `cercaGemelloAlunno`, e si passa al bambino dopo.
 */
export async function primoGemelloFraIBambini(
  supabase: SupabaseClient,
  scuolaId: string,
  bambini: readonly BambinoDaControllare[],
  contesto: Omit<ContestoRicerca, 'indice'>,
): Promise<{ indice: number; schede: SchedaAlunnoGemella[] } | null> {
  for (const b of bambini) {
    const esito = await cercaGemelloAlunno(
      supabase,
      { scuolaId, nome: b.nome, cognome: b.cognome, dataNascita: b.dataNascita, codiceFiscale: b.codiceFiscale },
      { ...contesto, indice: b.indice + 1 },
    )
    if (esito.esito === 'trovato') return { indice: b.indice, schede: esito.schede }
  }
  return null
}
