import type { SupabaseClient } from '@supabase/supabase-js'
import { figliAttiviConClasse, genitoriDelleClassi, type EsitoGenitori } from './aventi-diritto'
import type { GenitoreScheda } from './tipi'

/**
 * VOTAZIONI · L'AMMISSIONE DI UN GENITORE, GIUDICATA CON UNA REGOLA SOLA.
 *
 * Il GET (`/api/parent/votazioni`, che mostra le schede) e il POST (`/api/parent/votazioni/[id]/voto`, che
 * registra il voto) devono rispondere alla stessa domanda — «questo genitore può votare in questa scheda?» —
 * con la stessa risposta. Se le due route la giudicassero in due modi, il genitore vedrebbe una scheda e poi
 * si vedrebbe rifiutare il voto (o, peggio, voterebbe in una scheda che non ha mai visto). La regola sta quindi
 * qui, scritta una volta, e le due route la chiamano.
 *
 * ── LA REGOLA ────────────────────────────────────────────────────────────────
 *
 * Si parte dai figli ancora a scuola dell'elettore (`figliAttiviConClasse`): da lì le sedi e, per sede, le
 * classi dei figli. Poi:
 *
 *  · CLASSE S della sede X: ammesso se l'elettore compare fra i genitori di S (`genitoriDelleClassi(X, [S])`).
 *    Un'elezione di classe non è un'elezione di sede: la lista dei genitori che si legge è quella di S.
 *  · ISTITUTO della sede X: ammesso se l'elettore compare nell'unione dei genitori delle classi dei SUOI figli
 *    in X (`genitoriDelleClassi(X, <le classi dei suoi figli in X>)`). Non si legge tutta la sede: il conto
 *    parte dalle sue classi, che sono poche, e basta una per essere ammesso.
 *
 * L'elettore deve comparire nella lista perché la lista è fatta di ACCOUNT ATTIVI (`utenti.attivo = true`)
 * con un figlio in `STATI_CON_CANALE_FAMIGLIA` non archiviato: il figlio sospeso per morosità c'è, il ritirato
 * no, l'account disattivato no. Non c'è nessun gate di morosità: è una decisione del titolare.
 *
 * ── UNA LETTURA, DUE DOMANDE ─────────────────────────────────────────────────
 *
 * `leggiAmmissione` fa le letture (a blocchi, nelle funzioni di `aventi-diritto.ts`) e restituisce una
 * fotografia (`AmmissioneGenitore`). Le due domande — `ammessoInClasse` / `candidatiDellaClasse` e
 * `ammessoAllIstituto` — sono funzioni PURE su quella fotografia: il GET la legge una volta per tutte le
 * schede di tutte le sedi, il POST per la sola scheda su cui si vota, e le due risposte non possono divergere
 * perché la domanda è la stessa funzione sugli stessi dati.
 *
 * ── «COMPLETO» ───────────────────────────────────────────────────────────────
 *
 * Come in `aventi-diritto.ts`: `completo: false` ⇒ `errore !== null`, e vuol dire che la fotografia può essere
 * CORTA. Una fotografia corta fa dire «non ammesso» a chi lo è: chi RIFIUTA (il POST) deve guardare `completo`
 * e, se è falso, rispondere con un guasto e non con un diniego; chi MOSTRA (il GET) non deve consegnare un
 * elenco a metà con l'aria di essere intero, e risponde con un guasto anche lui.
 *
 * ── UUID ─────────────────────────────────────────────────────────────────────
 *
 * Tutte le chiavi sono in minuscolo (in Postgres `uuid` è un tipo e la maiuscola non lo distingue): `formaId`.
 * Le funzioni accettano un uuid in qualunque maiuscola.
 */

/** Un figlio ancora a scuola, nella forma di `figliAttiviConClasse`. */
export interface FiglioConClasse {
  alunnoId: string
  sectionId: string
  scuolaId: string
}

export interface AmmissioneGenitore {
  /** L'elettore (`utenti.id`, minuscolo). */
  utenteId: string
  /** Le sedi in cui ha almeno un figlio ancora a scuola (minuscole, senza doppioni). */
  sedi: string[]
  /** Per sede, le classi dei suoi figli (minuscole, senza doppioni): due figli nella stessa classe sono UNA classe. */
  classiDeiFigli: Map<string, string[]>
  /** Per sede e per classe, i genitori con un account attivo (la lista di `genitoriDelleClassi`). Solo le classi lette. */
  genitori: Map<string, Map<string, GenitoreScheda[]>>
}

export interface OpzioniAmmissione {
  /**
   * I figli già letti da chi chiama (`figliAttiviConClasse`): si evita di rileggerli. Chi li passa ha già
   * guardato `completo`. Senza questa opzione li legge `leggiAmmissione` da sé.
   */
  figli?: readonly FiglioConClasse[]
  /** Si considerano solo queste sedi (il POST: la sede della votazione). Senza, tutte quelle dei figli. */
  sedi?: readonly string[]
  /**
   * Si considerano solo queste classi (il POST di CLASSE: la classe della scheda). Con questa opzione
   * `ammessoAllIstituto` risponde sulle sole classi indicate: non usarla per decidere sull'istituto.
   */
  classi?: readonly string[]
}

/** Uuid in forma di confronto. */
export function formaId(id: string): string {
  return id.trim().toLowerCase()
}

/** Una fotografia vuota: nessun figlio, nessuna sede. */
function fotografiaVuota(utenteId: string): AmmissioneGenitore {
  return { utenteId: formaId(utenteId), sedi: [], classiDeiFigli: new Map(), genitori: new Map() }
}

/**
 * Legge ciò che serve a giudicare l'ammissione di `utenteId`: le sedi e le classi dei suoi figli e, per ogni
 * sede, i genitori di quelle classi. Una sede senza classi da leggere (nessun figlio, o nessuna classe fra
 * quelle chieste) non interroga il database per i genitori.
 */
export async function leggiAmmissione(
  supabase: SupabaseClient,
  utenteId: string,
  opzioni: OpzioniAmmissione = {},
): Promise<EsitoGenitori<AmmissioneGenitore>> {
  let figli: readonly FiglioConClasse[]
  if (opzioni.figli) {
    figli = opzioni.figli
  } else {
    const letti = await figliAttiviConClasse(supabase, formaId(utenteId))
    if (!letti.completo) {
      // Un elenco di figli a metà darebbe sedi e classi a metà: si consegna la fotografia vuota e il guasto.
      return {
        valore: fotografiaVuota(utenteId),
        completo: false,
        errore: letti.errore ?? new Error('lettura-figli-incompleta'),
      }
    }
    figli = letti.valore
  }

  const soloSedi = opzioni.sedi ? new Set(opzioni.sedi.map(formaId)) : null
  const soloClassi = opzioni.classi ? new Set(opzioni.classi.map(formaId)) : null

  const ammissione = fotografiaVuota(utenteId)
  const classiPerSede = new Map<string, Set<string>>()
  for (const figlio of figli) {
    const sede = formaId(figlio.scuolaId)
    const classe = formaId(figlio.sectionId)
    if (soloSedi && !soloSedi.has(sede)) continue
    if (!classiPerSede.has(sede)) classiPerSede.set(sede, new Set())
    if (soloClassi && !soloClassi.has(classe)) continue
    classiPerSede.get(sede)?.add(classe)
  }
  ammissione.sedi = [...classiPerSede.keys()]
  for (const [sede, classi] of classiPerSede) ammissione.classiDeiFigli.set(sede, [...classi])

  // Una lettura per sede: i genitori delle sole classi dei suoi figli in quella sede.
  const daLeggere = [...classiPerSede].filter(([, classi]) => classi.size > 0)
  const letture = await Promise.all(
    daLeggere.map(async ([sede, classi]) => ({ sede, esito: await genitoriDelleClassi(supabase, sede, [...classi]) })),
  )

  let completo = true
  let errore: unknown | null = null
  for (const { sede, esito } of letture) {
    ammissione.genitori.set(sede, esito.valore)
    if (!esito.completo) {
      completo = false
      errore = errore ?? esito.errore ?? new Error('lettura-genitori-incompleta')
    }
  }
  return { valore: ammissione, completo, errore }
}

/** La lista dei genitori di una classe, se la fotografia l'ha letta. */
function listaDellaClasse(a: AmmissioneGenitore, scuolaId: string, sectionId: string): GenitoreScheda[] | undefined {
  return a.genitori.get(formaId(scuolaId))?.get(formaId(sectionId))
}

const compare = (a: AmmissioneGenitore, lista: readonly GenitoreScheda[]): boolean =>
  lista.some((g) => formaId(g.utenteId) === a.utenteId)

/**
 * CLASSE: l'elettore è ammesso nella classe `sectionId` della sede `scuolaId` se compare fra i genitori di
 * quella classe. Una classe che la fotografia non ha letto (non è una classe dei suoi figli) non ammette nessuno.
 */
export function ammessoInClasse(a: AmmissioneGenitore, scuolaId: string, sectionId: string): boolean {
  const lista = listaDellaClasse(a, scuolaId, sectionId)
  return lista !== undefined && compare(a, lista)
}

/**
 * I candidati di una scheda di CLASSE: tutti i genitori della classe (lui compreso: ci si può votare da soli),
 * e SOLO se l'elettore è ammesso — la lista dei genitori di una classe non si consegna a chi non ci ha un
 * figlio. Vuota se non è ammesso.
 */
export function candidatiDellaClasse(a: AmmissioneGenitore, scuolaId: string, sectionId: string): GenitoreScheda[] {
  const lista = listaDellaClasse(a, scuolaId, sectionId)
  return lista !== undefined && compare(a, lista) ? lista : []
}

/**
 * ISTITUTO: l'elettore è ammesso per la sede `scuolaId` se compare fra i genitori di almeno una delle classi
 * dei suoi figli in quella sede. Chi ha figli solo in un'altra sede non vota qui.
 */
export function ammessoAllIstituto(a: AmmissioneGenitore, scuolaId: string): boolean {
  const perClasse = a.genitori.get(formaId(scuolaId))
  if (!perClasse) return false
  for (const lista of perClasse.values()) if (compare(a, lista)) return true
  return false
}
