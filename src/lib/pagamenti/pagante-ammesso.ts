import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { getGenitoriDiAlunniEsito } from '@/lib/anagrafiche/legami'

// ─── Chi può essere il PAGANTE di un incasso, e perché serve un modulo ───────
//
// `pagamenti_transazioni.pagante_parent_id` è un `parents.id`, e la sua FK è
// `REFERENCES parents(id)`: verifica che quella riga ESISTA, nient'altro.
// `parents` non ha nemmeno `scuola_id`, quindi neanche il gate di sede lo
// restringe. Da quell'uuid `src/lib/pagamenti/ricevute.ts` prende NOME e CODICE
// FISCALE dell'intestatario del documento fiscale: un id sbagliato non è un
// campo sbagliato, è una fattura a nome di un estraneo — con la sua detrazione
// 730 e il suo dato personale addosso a un'altra famiglia.
//
// ─── LE DUE PORTE, E DAL 2026-09-13 UNA SOLA REGOLA ─────────────────────────
// Questo modulo è nato mentre `pagamenti/riconciliazione/[id]/contesto:GET` era
// in verifica: la regola stava là (sezione «5 · I candidati»), qui era stata
// RISCRITTA, e la testata prometteva la migrazione a verifica chiusa. È stata
// fatta. Oggi le due porte che decidono chi può essere il pagante passano di qui:
//   · `…/contesto:GET` — costruisce l'elenco che la schermata MOSTRA, e risponde
//     403 `CONCILIAZIONE_PAGANTE_NON_AMMESSO` a un `?pagante=` fuori elenco;
//   · la SCRITTURA, con lo stesso 403 — che dal 2026-09-20 non è più la rotta
//     `…/componi:POST` ma `@/lib/pagamenti/conciliazione-registra`, dove i suoi
//     nove gate si sono spostati per essere attraversati anche dall'import che
//     concilierà da sé. La porta è la stessa, il file no: il lock qui sotto è
//     stato spostato con lei, perché un lock che punta al file da cui il codice
//     è uscito non sorveglia più niente restando verde.
// Erano equivalenti il giorno della migrazione, ed è proprio questo che rendeva
// urgente chiuderle in una: due copie non divergono il giorno in cui nascono —
// divergono dopo, e quel giorno la schermata offre un pagante che la scrittura
// rifiuta, o peggio il contrario. Chi tocca questa funzione le cambia ENTRAMBE,
// ed è il punto. Il lock che lo tiene fermo è
// `__tests__/architecture/pagante-ammesso-un-motore-solo.test.ts`.
//
// ─── E DAL 2026-09-20 UN TERZO CHIAMANTE, CHE PORTA NON È ───────────────────
// `pagamenti/riconciliazione/alunni:GET` — la ricerca del bambino da cui
// comporre un bonifico — chiama questa funzione per un solo booleano,
// `ha_pagante`: non concede e non nega, ANTICIPA. Serve a non offrire come
// pronto un bambino per cui la conferma non troverebbe nessun intestatario.
// È dichiarato nel lock insieme alle due porte, e sotto le stesse tre regole,
// perché un lettore è esattamente il chiamante che si scriverebbe in casa una
// query «giusto per sapere se c'è un genitore»: sarebbe la terza traduzione del
// ponte account→`parents`, cioè la divergenza di sempre entrata di servizio.
// ⚠️ Chi legge quel booleano deve distinguere `false` da `null`: `null` è
// `completo === false`, cioè «una delle due sorgenti non si è letta», e dirlo
// `false` manderebbe la segreteria a creare un genitore che esiste già.
//
// ─── DUE PONTI, E DIVERGONO DAVVERO ─────────────────────────────────────────
// Misurato sul database di produzione il 2026-09-13, confrontando coppia per
// coppia `student_parents` con `legame_genitori_alunni` risolta via
// `parents.auth_user_id`:
//
//   · 937 legami stanno in TUTTE E DUE le sorgenti
//   ·  81 stanno nella SOLA anagrafica (`student_parents`)
//   ·   4 stanno nel SOLO runtime (`legame_genitori_alunni`)
//
// Una guardia su un ponte solo rifiuterebbe 4 incassi legittimi, o 81. L'UNIONE
// è un sovrainsieme di ciascuno dei due: non può rifiutarne nessuno. È la
// ragione per cui questa funzione esiste invece di una query sola.
//
// I `parents` SENZA account (72 su 856, misurati) esistono solo nell'anagrafica:
// `getGenitoriDiAlunniEsito` li scarta per costruzione (restituisce `utenti.id`,
// e senza `auth_user_id` non ce n'è uno). Sono intestatari legittimi, ed è il
// motivo per cui `student_parents` si legge anche DIRETTAMENTE e non solo
// attraverso quell'helper.

/**
 * Una coppia (genitore, bambino) come la vede questa regola: `parents.id` e
 * `alunni.id`, mai l'account. È la forma che `scegliPaganteComune` legge.
 */
export interface LegamePagante {
  parent_id: string
  student_id: string
}

/** L'esito della risoluzione: l'insieme, e quanto ci si può fidare del suo essere completo. */
export interface PagantiAmmessi {
  /**
   * I `parents.id` legati ad ALMENO UNO dei bambini richiesti, dalle due sorgenti.
   *
   * ⚠️ NON è calcolato a parte: è DERIVATO da `legami`. Chi rifiuta guarda questo
   * insieme, chi propone guarda le coppie — e se i due si calcolassero per conto
   * loro potrebbero un giorno dire cose diverse dello stesso genitore.
   */
  parentIds: Set<string>
  /**
   * Le coppie da cui `parentIds` è derivato, nell'ordine in cui sono state
   * trovate: prima l'anagrafica, poi il ponte runtime. Possono ripetersi — 937
   * legami veri stanno in TUTTE E DUE le sorgenti — e chi le consuma
   * (`scegliPaganteComune`) lavora già per insiemi.
   */
  legami: LegamePagante[]
  /**
   * `parents.id` → `relation_type` dell'ANAGRAFICA («madre», «padre», …), che è
   * ciò che la schermata mostra accanto al nome. Un genitore noto al solo
   * runtime non c'è: l'assenza è la verità, e inventare «genitore» sarebbe un
   * dato scritto da noi su una riga che non ce l'ha.
   */
  relazioni: Map<string, string | null>
  /**
   * `false` = una lettura non è riuscita, quindi l'insieme può essere CORTO.
   * Chi rifiuta deve guardarlo: un gate che dice no quando non sa scarica sul
   * banco della segreteria un guasto del database. Stessa semantica — e stessa
   * ragione — di `getFigliDiGenitoreEsito` (`@/lib/anagrafiche/legami`).
   */
  completo: boolean
}

/**
 * Codici che non sono un guasto ma un ambiente: sul DB E2E della CI, mai
 * migrato, una delle due sorgenti può non esistere affatto. Trattarli da guasto
 * renderebbe `completo: false` ovunque, cioè spegnerebbe il gate in CI e basta.
 * Stesso elenco di `@/lib/anagrafiche/legami` (lì è privato).
 */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

/** Un identificatore utile: stringa, non vuota. Tutto il resto è rumore di una riga rotta. */
const idBuono = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null

/**
 * I `parents.id` che possono essere il PAGANTE di un incasso che riguarda questi
 * bambini: l'unione dei due ponti genitore↔alunno, con le coppie da cui viene.
 *
 * Non decide niente: restituisce l'insieme e dice se è affidabile. Il rifiuto —
 * con il suo codice, il suo stato HTTP e la sua riga di log — appartiene alla
 * route, che è l'unica a sapere che cosa stava facendo l'operatrice. Allo stesso
 * modo non SCEGLIE il pagante: dà le coppie a chi lo fa (`scegliPaganteComune`,
 * `riconosciOrdinante`), perché «chi PUÒ pagare» e «chi PROBABILMENTE ha pagato»
 * sono due domande diverse e solo la prima è un permesso.
 *
 * `operazione` serve solo ai log: le righe di questo modulo devono raggrupparsi
 * sotto la rotta che l'ha chiamato, non sotto un nome suo.
 */
export async function pagantiAmmessiPerAlunni(
  supabase: SupabaseClient,
  alunnoIds: (string | null | undefined)[],
  operazione: string,
): Promise<PagantiAmmessi> {
  const legami: LegamePagante[] = []
  const relazioni = new Map<string, string | null>()
  /** L'insieme è la DERIVATA delle coppie: si calcola in fondo, mai in parallelo. */
  const esito = (completo: boolean): PagantiAmmessi => ({
    parentIds: new Set(legami.map((l) => l.parent_id)),
    legami,
    relazioni,
    completo,
  })

  const unici = [
    ...new Set(alunnoIds.filter((a): a is string => typeof a === 'string' && a.trim() !== '')),
  ]
  if (unici.length === 0) return esito(true)

  let completo = true
  /**
   * PostgREST non lancia: ritorna `{ error }`. Senza questo controllo una lettura
   * fallita uscirebbe come «questo genitore non è di questa famiglia» — cioè un
   * guasto del database travestito da rifiuto di merito, addosso a chi lavora.
   */
  const registra = (esito: string, tabella: string, n: number, err: unknown) => {
    const code = (err as { code?: string } | null | undefined)?.code ?? null
    if (!code || !SCHEMA_ASSENTE.has(code)) completo = false
    logEvento('pagamento', 'warn', { operazione, esito, entita_tipo: tabella, n, error_code: code }, err)
  }

  // ── 1 · L'ANAGRAFICA, letta diretta: `student_parents` dà già il `parents.id`.
  // `relation_type` esce di qui e da nessun'altra parte: è l'unica sorgente che
  // dica in che rapporto sta quell'adulto col bambino.
  const sp = await supabase
    .from('student_parents')
    .select('parent_id, student_id, relation_type')
    .in('student_id', unici)
  if (sp.error) registra('pagante-legami-anagrafica-non-letti', 'student_parents', unici.length, sp.error)
  for (const r of (sp.data ?? []) as {
    parent_id?: unknown
    student_id?: unknown
    relation_type?: unknown
  }[]) {
    const parentId = idBuono(r.parent_id)
    const studentId = idBuono(r.student_id)
    if (!parentId || !studentId) continue
    legami.push({ parent_id: parentId, student_id: studentId })
    relazioni.set(parentId, typeof r.relation_type === 'string' ? r.relation_type : null)
  }

  // ── 2 · IL PONTE RUNTIME, portato nello spazio di `parents`.
  // `getGenitoriDiAlunniEsito` restituisce ACCOUNT (`utenti.id`): l'ultimo passo
  // li ritraduce in `parents.id`, che è ciò che la transazione scrive.
  const runtime = await getGenitoriDiAlunniEsito(supabase, unici)
  if (!runtime.completo) completo = false
  const accountIds = [...new Set([...runtime.perAlunno.values()].flat())]
  if (accountIds.length > 0) {
    const ponte = await supabase.from('parents').select('id, auth_user_id').in('auth_user_id', accountIds)
    if (ponte.error) registra('pagante-ponte-non-letto', 'parents', accountIds.length, ponte.error)
    // account → `parents.id`. Un `parents` per account, e non è un'assunzione:
    // `parents_auth_user_id_key` è un indice UNIQUE PIENO su `auth_user_id`
    // (verificato su `pg_indexes` il 2026-09-13 — `pg_constraint` non vede gli
    // indici parziali, e qui si guarda la tabella giusta).
    const perAccount = new Map<string, string>()
    for (const p of (ponte.data ?? []) as { id?: unknown; auth_user_id?: unknown }[]) {
      const account = idBuono(p.auth_user_id)
      const parentId = idBuono(p.id)
      if (account && parentId) perAccount.set(account, parentId)
    }
    // Si ricostruisce la COPPIA, non il solo id: senza il bambino, «questo
    // genitore è di questa famiglia» non si potrebbe più distinguere da «questo
    // genitore è di UNO dei bambini», ed è la differenza su cui si sceglie il
    // pagante comune di un bonifico che salda due fratelli.
    for (const [alunnoId, accounts] of runtime.perAlunno) {
      for (const acc of accounts) {
        const parentId = perAccount.get(acc)
        if (parentId) legami.push({ parent_id: parentId, student_id: alunnoId })
      }
    }
  }

  return esito(completo)
}
