// =============================================================================
// LA GALLERIA DI UNA SEDE INTERA — le tre domande della vista di segreteria.
//
// ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
// `GET /api/gallery` ha sempre risposto **400** a chi non nominava né una classe
// né un bambino, e il commento sopra quella riga spiega che non è una svista:
// senza uno dei due lo SCOPE DI SEDE non esisteva, e la lista sarebbe uscita sui
// trenta media più recenti di TUTTE le sedi. Il muro era giusto; quello che
// mancava era una porta.
//
// La porta è `?scope=sede&scuolaId=<uuid>`: la sede non si indovina, si
// DICHIARA — regola del progetto, e con tre plessi di produzione più la sede
// fittizia della CI una rotta che indovina archivia (o mostra) il plesso
// sbagliato **in silenzio**.
//
// ─── COSA STA QUI E COSA NO ─────────────────────────────────────────────────
// Qui stanno le tre domande che la vista di sede pone e che la route non deve
// riscrivere a mano:
//   1. «questo plesso è di chi sta chiedendo?»      → `risolviSedeDellaVista`
//   2. «questo bambino è del plesso dichiarato?»    → `assertAlunnoNellaSede`
//   3. «come si chiamano i bambini taggati?»        → `alunniTaggatiDellaSede`
//
// Nessuna delle tre risolve le sedi per conto suo: la prima chiede a
// `scuoleDiUtente` (`@/lib/auth/scope`) quali plessi l'operatore PUÒ vedere e a
// `restringiSedi` di intersecarli con quello dichiarato; la seconda chiede a
// `sedeDiAlunno` (`@/lib/anagrafiche/sedi`) di che plesso è il bambino. Tre
// copie della stessa domanda sono tre occasioni di correggerne una e
// dimenticarne due, ed è già successo in questo repo.
//
// ⚠️ IL CONFRONTO FRA UUID PASSA SEMPRE DA `restringiSedi`, MAI DA `===`. In
// Postgres `uuid` è un TIPO: `'AAAA…'` e `'aaaa…'` sono lo stesso valore e la
// riga si trova; in JavaScript sono due stringhe diverse. Il 2026-07-31 quel
// `===` ha risposto **403 sulla PROPRIA sede** a una segreteria che la scriveva
// in maiuscolo. Ciò che esce da qui è sempre la forma CANONICA del database, mai
// la stringa arrivata dal client.
//
// ⚠️ SCOPE VUOTO ⇒ SI NEGA. Un elenco di plessi vuoto non è «nessun vincolo», è
// «nessun permesso»: è la regola del progetto, ed è il difetto che
// `if (plessi.length > 0)` ha lasciato vivo per mesi proprio su questa rotta.
//
// ⚠️ E SEDE NON DICHIARATA ⇒ SI NEGA QUI DENTRO, non nello schema di chi chiama.
// `restringiSedi(attive, undefined)` restituisce `attive`, cioè TUTTI i plessi
// accessibili: una sede vuota, in questa primitiva, sarebbe un fail-OPEN che si
// manifesta solo su chi ha più di un plesso. Fino al 2026-09-06 la garanzia
// viveva in un altro file (lo `superRefine` della rotta) e passava per un cast
// `as string` che toglieva al compilatore l'unica domanda che poteva fare.
//
// ⚠️ NEI LOG SOLO UUID E CONTEGGI. Da qui passano anagrafiche di minori: la
// redazione (`@/lib/logging/redact`) è a lista bianca e i nomi non si loggano
// mai, nemmeno «per capire meglio».
// =============================================================================

import type { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { restringiSedi, scuoleDiUtente } from '@/lib/auth/scope'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { sedeDiAlunno } from '@/lib/anagrafiche/sedi'
import { logEvento } from '@/lib/logging/logger'

/** L'operazione che compare nei log: sempre l'handler di `withRoute`. */
const OPERAZIONE = 'gallery:GET'

/** O i plessi su cui leggere (uno solo), o la risposta da restituire subito. */
export type EsitoSedeVista =
  | { plessi: string[]; response?: undefined }
  | { response: NextResponse; plessi?: undefined }

/**
 * «Il plesso che hai dichiarato è fra i tuoi?»
 *
 * `scuoleDiUtente` dice quali plessi l'operatore PUÒ vedere ed è **fail-closed**
 * (una lettura fallita del ponte `utenti_scuole` non è un permesso: torna `[]`);
 * `restringiSedi` interseca con la sede dichiarata e non allarga mai — un uuid
 * scritto a mano nella query può soltanto restringere.
 *
 * ⚠️ NON si usa `resolveScuoleAttive`, cioè la selezione del SedeSelector, e la
 * scelta va detta: quel cookie è una **preferenza di visualizzazione**, e qui la
 * sede è DICHIARATA per esteso dal chiamante. Farla filtrare da una selezione
 * stantìa vorrebbe dire negare 403 (o peggio, rispondere 200 con l'elenco vuoto)
 * una lettura legittima ed esplicita — che è esattamente il difetto pagato due
 * volte su questa stessa rotta: la docente-genitore che riceveva `media: []` sul
 * figlio, e la segreteria che riceveva 403 sulla propria sede. I PERMESSI li
 * decide `scuoleDiUtente`; il cookie decide che cosa mostrare a chi non ha
 * chiesto niente.
 *
 * @returns i plessi su cui filtrare (sempre **uno**, in forma canonica); oppure
 *   **400 `SEDE_DA_SPECIFICARE`** se la sede non è stata dichiarata; oppure
 *   **403 `SEDE_NON_ACCESSIBILE`** — senza dire quali plessi l'utente abbia, che
 *   sarebbe raccontare a chi tenta com'è andata la risoluzione.
 */
export async function risolviSedeDellaVista(
  supabase: SupabaseClient,
  user: AppUser,
  // `string | null | undefined` e non `string`: questo valore arriva da una
  // query string, e un tipo che promette una sede sempre presente costringe il
  // chiamante a un cast — cioè a spegnere l'unico controllo che il compilatore
  // potrebbe fare. Si passi ciò che si ha; a negare pensa la riga qui sotto.
  scuolaId: string | null | undefined,
): Promise<EsitoSedeVista> {
  // ⚠️ SEDE MANCANTE ⇒ SI NEGA, e la guardia sta QUI perché è l'unico punto che
  // vale per ogni chiamante. `restringiSedi` comincia con
  // `if (!scuolaId) return attive`: passargli una sede vuota non restringe
  // niente, restituisce l'INTERO elenco dei plessi accessibili. Oggi non accade
  // perché lo `superRefine` dello schema della rotta pretende `scuolaId` con
  // `scope=sede`, ma è una riga in un altro file: tolta quella sola regola,
  // `tsc` resta verde e un admin di due plessi riceve **200 con le foto di
  // entrambe le sedi** (misurato il 2026-09-06). «La sede non si indovina, si
  // DICHIARA» è la regola del progetto, e a pretenderla dev'essere la primitiva
  // che la usa, non chi la chiama.
  //
  // **400**, non 403, seguendo la distinzione che `rifiutoSede` tiene separata:
  // qui non c'è nessun tentativo cross-sede da contare, c'è una richiesta che
  // non dice dove. Mescolare i due codici rende illeggibili entrambi i
  // contatori. E il log resta `warn`: se questa riga compare, la validazione a
  // monte è saltata.
  if (!scuolaId) {
    logEvento('galleria', 'warn', {
      operazione: OPERAZIONE,
      esito: 'vista-sede-senza-sede',
      utente: user.id,
      ruolo: user.role,
    })
    return { response: rifiutoSede('SEDE_DA_SPECIFICARE') }
  }
  const accessibili = await scuoleDiUtente(supabase, user)
  const dentro = restringiSedi(accessibili, scuolaId)
  // `null` = «hai chiesto un plesso che non è tuo»; `[]` = «non hai plessi».
  // Sono due storie diverse e la stessa risposta: leggere non si può in nessuno
  // dei due casi, e il motivo preciso resta nel log, non nel corpo.
  if (!dentro || dentro.length === 0) {
    logEvento('galleria', 'warn', {
      operazione: OPERAZIONE,
      esito: 'vista-sede-non-accessibile',
      utente: user.id,
      ruolo: user.role,
      // Solo il CONTEGGIO dei plessi: quali siano non è affare della risposta.
      accessibili: accessibili.length,
    })
    return { response: rifiutoSede('SEDE_NON_ACCESSIBILE') }
  }
  return { plessi: dentro }
}

/**
 * «Il bambino che hai chiesto è del plesso che hai dichiarato?»
 *
 * Senza questo controllo la risposta sarebbe comunque SICURA — la lista dei
 * media è già ristretta alla sede dichiarata, quindi l'uuid di un minore di un
 * altro plesso non porterebbe indietro niente — ma sarebbe **muta**: un 200 con
 * l'elenco vuoto, che a schermo si legge «questo bambino non ha foto» e non
 * «stai guardando nel plesso sbagliato». In questo repo il 200 vuoto è il
 * difetto più costoso che esista: cinque classi di Giugliano sono rimaste
 * invisibili per giorni proprio così.
 *
 * Il rifiuto è **403 `SEDE_NON_ACCESSIBILE`**: la coppia (sede, bambino) nomina
 * due plessi diversi, e quello del bambino non è quello che si sta leggendo.
 * Non dice a quale sede il bambino appartenga — un uuid non è un segreto, ma
 * confermare dov'è iscritto un minore lo sarebbe.
 *
 * @returns `null` se il bambino è nella sede, altrimenti la risposta da dare.
 */
export async function assertAlunnoNellaSede(
  supabase: SupabaseClient,
  alunnoId: string,
  plessi: string[],
): Promise<NextResponse | null> {
  const sede = await sedeDiAlunno(supabase, alunnoId, { gruppo: 'galleria', operazione: OPERAZIONE })
  // `sede === null` significa «non l'ho potuta stabilire» (riga assente, colonna
  // vuota, lettura fallita — `sedeDiAlunno` logga da sé quale dei tre): non
  // sapere non può valere «sì».
  if (sede === null || restringiSedi(plessi, sede) === null) {
    logEvento('galleria', 'warn', {
      operazione: OPERAZIONE,
      esito: sede === null ? 'vista-sede-alunno-senza-sede' : 'vista-sede-alunno-fuori-sede',
      // Nessun id di minore: sarebbe l'unico dato personale di questa riga.
    })
    return rifiutoSede('SEDE_NON_ACCESSIBILE')
  }
  return null
}

/** Un bambino taggato in una foto, come lo vede la segreteria della sua sede. */
export interface AlunnoTaggato {
  id: string
  /** Nome e cognome, per l'etichetta sotto la foto. Mai nei log. */
  nome: string
  /** `alunni.classe_sezione`, la classe scritta per testo. `null` se sganciato. */
  classe: string | null
}

type RigaConTag = { tag_students?: unknown }

/**
 * Attacca a ogni foto i bambini taggati **della sede dichiarata**.
 *
 * PERCHÉ NELLA RISPOSTA E NON A CARICO DELLA PAGINA. `tag_students` è un elenco
 * di uuid: senza i nomi la schermata mostrerebbe identificatori, e la pagina
 * dovrebbe interrogare l'anagrafica una volta per foto (N+1) o scaricare l'intera
 * sede per fare la mappa. Qui è UNA query per pagina di galleria, già ristretta
 * al plesso.
 *
 * ⚠️ È RISTRETTA AL PLESSO, e questo è il punto. Un tag che punta fuori dalla
 * sede non torna indietro: il nome di un minore di un altro plesso non esce
 * MAI, nemmeno da una riga anomala. Il fatto però non resta muto — un tag fuori
 * sede è un'anomalia (i gate di POST e PATCH non dovrebbero permetterla) e
 * finisce nel log a `warn`, coi soli conteggi.
 *
 * ⚠️ SI DEGRADA, NON FALLISCE. Se l'anagrafica non è leggibile (sul DB E2E della
 * CI, non migrato, `alunni.scuola_id` può non esistere: `42703`) le foto si
 * vedono lo stesso, con l'elenco vuoto — e il guasto si logga col codice del
 * provider. Una galleria che risponde 500 perché non ha trovato dei NOMI
 * sarebbe un danno più grande del difetto.
 */
export async function alunniTaggatiDellaSede<T extends RigaConTag>(
  supabase: SupabaseClient,
  righe: T[],
  plessi: string[],
  operazione: string,
): Promise<(T & { alunni_taggati: AlunnoTaggato[] })[]> {
  const tagDi = (r: T): string[] =>
    Array.isArray(r.tag_students) ? (r.tag_students as unknown[]).filter((v): v is string => typeof v === 'string') : []

  const ids = [...new Set(righe.flatMap(tagDi))]
  const senzaNomi = () => righe.map((r) => ({ ...r, alunni_taggati: [] as AlunnoTaggato[] }))
  if (ids.length === 0) return senzaNomi()

  // `.in('id', ids)` viene dai media GIÀ filtrati per sede; `.in('scuola_id',
  // plessi)` è comunque incondizionato, perché un invariante che vale «per
  // costruzione» è un invariante che il giorno in cui la costruzione cambia non
  // c'è più — e qui il prezzo sarebbe il nome di un bambino altrui.
  const { data, error } = await supabase
    .from('alunni')
    .select('id, nome, cognome, classe_sezione')
    .in('id', ids)
    .in('scuola_id', plessi)

  // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo una lettura
  // fallita diventerebbe «nessun bambino trovato», cioè un elenco vuoto
  // indistinguibile da una foto senza tag.
  if (error) {
    logEvento('galleria', 'warn', {
      operazione,
      esito: 'vista-sede-nomi-non-letti',
      // Solo il conteggio: gli id sono di minori.
      taggati: ids.length,
      error_code: (error as { code?: string }).code ?? null,
    }, error)
    return senzaNomi()
  }

  const righeAlunni = (data ?? []) as Array<{
    id: string
    nome?: string | null
    cognome?: string | null
    classe_sezione?: string | null
  }>
  const perId = new Map<string, AlunnoTaggato>(
    righeAlunni.map((a) => [
      a.id,
      { id: a.id, nome: `${a.nome ?? ''} ${a.cognome ?? ''}`.trim(), classe: a.classe_sezione ?? null },
    ]),
  )

  const fuoriSede = ids.filter((id) => !perId.has(id)).length
  if (fuoriSede > 0) {
    logEvento('galleria', 'warn', {
      operazione,
      esito: 'vista-sede-tag-fuori-sede',
      taggati: ids.length,
      fuoriSede,
    })
  }

  return righe.map((r) => ({
    ...r,
    alunni_taggati: tagDi(r)
      .map((id) => perId.get(id))
      .filter((a): a is AlunnoTaggato => a !== undefined),
  }))
}
