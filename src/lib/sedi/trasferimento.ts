/* ════════════════════════════════════════════════════════════════════════════
 * VERSO QUALI SEDI SI PUÒ SPOSTARE UNA PERSONA.
 *
 * ─── PERCHÉ NON BASTAVA `resolveScuolaScrittura` ────────────────────────────
 *
 * `resolveScuolaScrittura` (src/lib/auth/scope.ts) risolve la sede di una riga
 * NUOVA, e per farlo pretende che la sede dichiarata sia fra quelle
 * dell'utente: fuori scope risponde 403 `SEDE_NON_ACCESSIBILE`. Per un
 * TRASFERIMENTO quella regola nega esattamente il caso per cui la funzione
 * esiste — il bambino che passa da Cesa ad Aversa — perché la sede di
 * destinazione è, per definizione, quella in cui la riga NON è ancora.
 *
 * Da qui la separazione, decisa dal titolare il 2026-09-03:
 *
 *   · la DIREZIONE (`admin`, `coordinator`) sposta fra TUTTE le sedi reali,
 *     comprese quelle che non sono fra le proprie;
 *   · la SEGRETERIA sposta solo dentro le sedi a cui ha già accesso. Se
 *     potesse spostare altrove, manderebbe un'anagrafica in un plesso che poi
 *     non può nemmeno più leggere, e nessuno di quel plesso saprebbe che è
 *     arrivata.
 *
 * Il perimetro in ENTRATA non lo decide questo modulo: chi si sposta deve
 * essere già dentro lo scope di chi lo sposta, e a garantirlo restano
 * `assertAlunnoInScope` / `assertUtenteInScope`. Qui si decide solo il DOVE.
 *
 * ─── FAIL-CLOSED, E LA DIFFERENZA FRA «VUOTO» E «ROTTO» ─────────────────────
 *
 * Un ruolo che questo modulo non conosce non è «staff generico»: è NEGATO.
 * E un elenco vuoto per GUASTO non è un elenco vuoto per ruolo — per questo
 * `destinazioniDiTrasferimento` restituisce anche `error`: senza quella
 * distinzione l'interfaccia scriverebbe «nessuna sede disponibile» davanti a
 * un permesso negato dal database, che è una bugia con l'aria di un fatto.
 * ════════════════════════════════════════════════════════════════════════════ */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type AppRole,
  type AppUser,
  RUOLI_DIREZIONE,
  haRuolo,
  haUnRuolo,
} from '@/lib/auth/predicati-ruolo'
import { formaConfronto, scuoleDiUtente } from '@/lib/auth/scope'
import { type SedeMinima, isScuolaE2E, sediReali } from '@/lib/scuole/reali'
import { logEvento } from '@/lib/logging/logger'

/** Le destinazioni di un trasferimento, e il motivo per cui potrebbero essere zero. */
export interface EsitoDestinazioni {
  /** Le sedi verso cui si può spostare, nell'ordine in cui vanno mostrate. */
  sedi: SedeMinima[]
  /** Guasto di lettura (PostgREST NON lancia: ritorna `{ error }`). `null` se
   *  l'elenco è vuoto perché il ruolo non ne ha diritto, che non è un errore. */
  error: { message: string; code?: string } | null
}

/**
 * Le destinazioni consentite, come funzione PURA: nessun I/O, nessun mock.
 *
 * `reali` sono le sedi già filtrate da `sediReali`. La sede E2E viene esclusa
 * **di nuovo** qui — difesa in profondità, non ridondanza: questa funzione è
 * pura e chiamabile, e domani qualcuno potrebbe passarle l'elenco GREZZO di
 * `schools`. Costa un `filter`; la sede finta della CI fra le destinazioni di un
 * bambino vero costerebbe molto di più.
 *
 * L'ordine è quello di `reali` (alfabetico per nome, deciso da `sediReali`),
 * mai quello delle sedi dell'utente: è un elenco da mostrare a una persona.
 */
export function destinazioniConsentite(
  ruolo: string | null | undefined,
  proprie: readonly string[],
  reali: readonly SedeMinima[],
): SedeMinima[] {
  const candidate = reali.filter((s) => !isScuolaE2E(s))

  // La Direzione muove ovunque: è il caso d'uso, non un privilegio di comodo.
  if (ruolo === 'admin' || ruolo === 'coordinator') return [...candidate]

  // La segreteria resta dentro il proprio perimetro.
  if (ruolo === 'segreteria') {
    const mie = new Set(proprie.map(formaConfronto))
    return candidate.filter((s) => mie.has(formaConfronto(s.id)))
  }

  // Tutto il resto — educator, cuoca, genitore, un ruolo mai visto, la stringa
  // vuota, `null` — non sposta nessuno. Si nega ciò che non si è capito.
  return []
}

/**
 * La sede chiesta è fra quelle ammesse? Se sì, torna nella forma **canonica**
 * del database.
 *
 * Il confronto passa da `formaConfronto` perché in Postgres `uuid` è un TIPO e
 * `'AAAA…'` è lo stesso valore di `'aaaa…'`, mentre in JavaScript sono due
 * stringhe diverse: questo repo ha già pagato quel difetto con un 403 sulla
 * PROPRIA sede. Ciò che esce da qui è sempre il valore letto dal database, mai
 * la stringa arrivata dal client.
 *
 * Una sede assente è `null`, non un ripiego sulla prima: «non me l'hai detta»
 * non è «vale la prima», e indovinare una sede archivia i dati nel plesso
 * sbagliato in silenzio.
 */
export function destinazioneConsentita(
  destinazioni: readonly SedeMinima[],
  richiesta: string | null | undefined,
): SedeMinima | null {
  if (!richiesta || !richiesta.trim()) return null
  const cercata = formaConfronto(richiesta)
  return destinazioni.find((s) => formaConfronto(s.id) === cercata) ?? null
}

/** Il ruolo con cui si decide, scelto fra i ruoli REALI e non fra le vesti.
 *
 *  Una direttrice che sta guardando l'app come genitore non perde il potere di
 *  trasferire: `role` è presentazione, `ruoli` è autorizzazione. */
function ruoloCheDecide(user: AppUser): AppRole | null {
  const direzione = RUOLI_DIREZIONE.find((r) => haRuolo(user, r))
  if (direzione) return direzione
  if (haRuolo(user, 'segreteria')) return 'segreteria'
  return null
}

/**
 * Le destinazioni vere, lette dal database.
 *
 * `operazione` è il nome della route chiamante (`admin/students:PATCH`): finisce
 * nella colonna `operazione` di `app_log` ed è la chiave con cui si chiede
 * "quale route ha fallito".
 *
 * ─── NEI LOG, `ruolo` È IL RUOLO CHE HA DECISO ──────────────────────────────
 *
 * Tutte e tre le righe qui sotto portano la stessa coppia, e vuol dire sempre la
 * stessa cosa:
 *
 *   · `ruolo` → il ruolo con cui si è deciso (`ruoloCheDecide`), `null` quando
 *     nessuno dei ruoli reali poteva decidere;
 *   · `stato` → la VESTE indossata in quel momento (`user.role`).
 *
 * Prima ci finiva `user.role` da solo, sotto il nome `ruolo`: per la direttrice
 * che guarda l'app come genitore usciva `destinazioni-risolte · ruolo:
 * 'genitore' · n: 2`. Ma queste righe sono un segnale di sicurezza da contare —
 * «chi ha risolto delle destinazioni di trasferimento» — e un genitore in quel
 * conteggio è un falso allarme; peggio, è il travestimento perfetto di un
 * allarme vero, perché l'autorizzazione l'ha data un ruolo che nella riga non
 * compare.
 *
 * ⚠️ PERCHÉ `stato` E NON `ruolo_attivo`, che si leggerebbe meglio: la redazione
 * (`@/lib/logging/redact`) è a lista bianca e `ruolo_attivo` non ci sta —
 * uscirebbe `[redatto:str/8]`, cioè la riga direbbe che una veste c'era, non
 * QUALE. Allargare la lista bianca «perché sarebbe comodo vederlo» è proprio ciò
 * che la regola 8 di AGENTS.md vieta, e non è una formalità: `redact()` gira
 * anche sul BODY GREZZO delle richieste, quindi ogni chiave in più è un canale di
 * testo libero verso `app_log`. `stato` è in lista bianca da sempre e in questo
 * repo porta già enumerati di questo genere.
 */
export async function destinazioniDiTrasferimento(
  supabase: SupabaseClient,
  user: AppUser,
  operazione: string,
): Promise<EsitoDestinazioni> {
  const ruolo = ruoloCheDecide(user)

  // Chi non può spostare non fa nemmeno partire le due letture. Il warn resta:
  // un tentativo negato è un segnale di sicurezza, e va contato.
  if (!ruolo) {
    logEvento('multi_sede', 'warn', {
      operazione,
      esito: 'destinazioni-nessuna',
      utente: user.id,
      // `null`: nessuno dei ruoli REALI poteva decidere. La veste sta in `stato`.
      ruolo,
      stato: user.role,
    })
    return { sedi: [], error: null }
  }

  const { reali, error } = await sediReali(supabase, operazione)
  if (error) {
    // Fail-closed: senza l'elenco delle sedi non si sposta niente. E l'errore
    // si restituisce, perché «vuoto» e «rotto» non sono la stessa cosa.
    return { sedi: [], error }
  }

  const proprie = ruolo === 'segreteria' ? await scuoleDiUtente(supabase, user) : []
  const sedi = destinazioniConsentite(ruolo, proprie, reali)

  if (sedi.length === 0) {
    logEvento('multi_sede', 'warn', {
      operazione,
      esito: 'destinazioni-nessuna',
      utente: user.id,
      ruolo,
      stato: user.role,
    })
    return { sedi: [], error: null }
  }

  // Il successo si logga: con i soli errori, "nessun log" non distingue
  // "tutto ok" da "non è mai partito niente".
  logEvento('multi_sede', 'info', {
    operazione,
    esito: 'destinazioni-risolte',
    utente: user.id,
    ruolo,
    stato: user.role,
    n: sedi.length,
  })
  return { sedi, error: null }
}

/** Ri-esportato perché chi decide una destinazione ha quasi sempre bisogno di
 *  sapere se l'attore è Direzione (l'interfaccia lo spiega all'utente). */
export function eDirezionePerTrasferimento(user: AppUser): boolean {
  return haUnRuolo(user, RUOLI_DIREZIONE)
}
