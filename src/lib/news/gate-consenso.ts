// =============================================================================
// IL GATE DEL CONSENSO FOTOGRAFICO — un posto solo, quattro rotte.
//
// PERCHÉ ESISTE QUESTO FILE. Il controllo nasce il 2026-08-01 dentro
// `POST /api/news` e ci resta chiuso dentro. Il collaudo dello stesso giorno lo
// ha scavalcato in due mosse: si crea il post SENZA foto (nessun gate), poi si
// aggiunge la copertina con `PATCH /api/news/[id]`, che non controllava niente.
// Il bucket `news` è pubblico e servito senza login: la foto di un bambino senza
// consenso al canale «sito» finiva online con il gate formale verde.
//
// È la terza volta in questa sessione che lo stesso difetto si presenta con
// un'altra faccia: la regola chiusa su una strada e lasciata aperta su quella
// accanto. La contromisura non è «aggiungere il controllo anche di là» — sarebbe
// una quarta copia da tenere allineata a mano — ma toglierlo da entrambe e
// metterlo qui, dove chi aggiunge una rotta lo trova già scritto.
//
// QUATTRO PUNTI DI PASSAGGIO, e non è ridondanza:
//   · `POST /api/news`            — il contenuto NASCE;
//   · `PATCH /api/news/[id]`      — il contenuto CAMBIA (qui stava il buco);
//   · `POST /api/news/[id]/pubblica` — il contenuto DIVENTA VISIBILE, e fra la
//     creazione e la pubblicazione una famiglia può aver revocato (art. 7 §3
//     GDPR: revocare deve essere facile quanto acconsentire);
//   · `POST /api/news/[id]/approva` — la segreteria approva la PROPOSTA di un
//     docente e, nel ramo normale (`pubblica_subito !== false`), la rende
//     visibile nello stesso istante. Aggiunto il 2026-08-03: erano tre, e la
//     quarta rotta pubblicava senza chiedere niente a nessuno.
//
// ERANO TRE, POI QUATTRO — E LA PROSSIMA? Il 2026-08-03 il conteggio di questa
// testata è stato smentito dal codice per la seconda volta. Perciò la promessa
// non vive più qui dentro: `__tests__/architecture/news-pubblicazione-gated.test.ts`
// enumera da solo le rotte di `news` che mettono un post in `pubblicata` (o che
// inseriscono una riga di `news_posts`) e pretende che ciascuna nomini questo
// gate. Se un giorno la quinta strada esiste, a dirlo è quel test — non un
// collaudo, non un incidente, e non un commento che qualcuno ricorda di aggiornare.
//
// L'ALTRA METÀ, che sta altrove: `src/lib/news/permanenza-consenso.ts`. Il gate
// risponde a «questa foto può entrare?»; la permanenza risponde a «questa foto
// può ancora stare qui?» e alla domanda che chiude il cerchio — «quando la riga
// se ne va, il FILE dov'è finito?» (`liberaFilePubbliciDelPost`, usata dal ritiro
// e dalla `DELETE`).
//
// COSA NON FA. Non decide la sede e non guarda i ruoli: quelli restano nelle
// route, dove `requireDocente`/`requireStaff` e `resolveScuoleAttive` sono già
// passati. Qui si risponde a una sola domanda: «questo contenuto, così com'è
// dopo la modifica, ritrae bambini che hanno detto sì al SITO?».
// =============================================================================

import { NextResponse } from 'next/server'
import { logEvento } from '@/lib/logging/logger'
import { CONSENSI_VERSIONE } from '@/lib/forms/enrollment-template'
import { contieneFoto } from './foto-nel-post'
import { verificaConsensoSito } from './consenso-foto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (t: string) => any }

/**
 * Le colonne della PROVA della dichiarazione. Il DB E2E della CI non è migrato e
 * non le ha: `scriviConDegradazione` le toglie una alla volta e ritenta.
 */
export const COLONNE_CONSENSO = [
  'bambini_ritratti',
  'consenso_dichiarato_da',
  'consenso_dichiarato_il',
  'consenso_versione',
] as const

export const DICHIARAZIONE_MANCANTE =
  'Il post contiene una foto: indicare quali bambini sono ritratti, oppure dichiarare che non ne è ritratto nessuno.'
export const CONSENSO_SITO_MANCANTE =
  'Alcuni bambini ritratti non hanno il consenso alla pubblicazione sul sito. Il consenso della galleria riservata non vale per il sito pubblico.'
export const CONSENSO_NON_VERIFICABILE =
  'Il consenso alla pubblicazione sul sito non è verificabile in questo momento: la pubblicazione è sospesa.'

/** La dichiarazione da archiviare accanto al post: chi, quando, su chi, su quale testo. */
export interface ProvaConsenso {
  bambini: string[]
  il: string
}

export interface RichiestaGate {
  supabase: Db
  /** Copertina RISULTANTE dopo la modifica (non quella di prima). */
  copertinaUrl: unknown
  /** Rich-text RISULTANTE dopo la modifica. */
  contenutoJson: unknown
  /**
   * La dichiarazione portata da QUESTA chiamata. `undefined` = la chiamata non la
   * tocca (PATCH di un altro campo, pubblicazione); `null` = dichiarazione
   * esplicitamente assente; `[]` = «nessun bambino è ritratto», che è una
   * dichiarazione a tutti gli effetti e va archiviata come tale.
   */
  ritrattiRichiesti?: string[] | null
  /** La dichiarazione GIÀ archiviata sul post (PATCH e pubblicazione). */
  ritrattiArchiviati?: string[] | null
  /** Sedi entro cui verificare: mai più larghe di quelle di chi opera. */
  sedi: string[]
  attore: { id: string; role?: string | null }
  /** `news:POST`, `news/[id]:PATCH`, … — finisce nei log così com'è. */
  operazione: string
  /**
   * Se `false`, un post con foto e SENZA nessuna dichiarazione non viene bloccato:
   * si registra un warn e si prosegue.
   *
   * Serve solo alla PUBBLICAZIONE, e la ragione è pratica: i post creati prima
   * del 2026-08-01 non hanno dichiarazione, e pretenderla lì renderebbe
   * impossibile ripubblicare (o ritirare e rimettere) l'archivio storico. Dove il
   * contenuto NASCE o CAMBIA la dichiarazione resta obbligatoria — che è il punto
   * in cui una foto nuova può entrare.
   */
  dichiarazioneObbligatoria?: boolean
}

export type EsitoGate = { response: NextResponse } | { prova: ProvaConsenso | null }

/**
 * Decide se il contenuto può essere scritto/pubblicato.
 *
 * Ritorna `{ response }` con il rifiuto già pronto, oppure `{ prova }`: la
 * dichiarazione da archiviare (`null` quando non c'è niente di nuovo da
 * archiviare — post senza foto, o chiamata che non tocca la dichiarazione).
 */
export async function gateConsensoFoto(r: RichiestaGate): Promise<EsitoGate> {
  const conFoto = contieneFoto(r.copertinaUrl, r.contenutoJson)
  if (!conFoto) return { prova: null }

  // `undefined` (campo assente) e `null` (assenza dichiarata) NON sono la stessa
  // cosa: il primo lascia in piedi la dichiarazione già archiviata, il secondo la
  // nega. Distinguerli è tutto il punto di questo gate.
  const dichiaratoOra = r.ritrattiRichiesti !== undefined && r.ritrattiRichiesti !== null
  const ritratti = dichiaratoOra
    ? [...new Set(r.ritrattiRichiesti as string[])]
    : (r.ritrattiArchiviati ?? null)

  if (ritratti === null) {
    if (r.dichiarazioneObbligatoria === false) {
      // Post anteriore al gate: non si blocca, ma non si tace nemmeno. Senza
      // questa riga «nessun log» direbbe insieme «verificato» e «mai verificato».
      logEvento('news', 'warn', {
        operazione: r.operazione,
        esito: 'dichiarazione-ritratti-assente-post-storico',
        utente: r.attore.id,
        ruolo: r.attore.role ?? null,
      })
      return { prova: null }
    }
    logEvento('news', 'warn', {
      operazione: r.operazione,
      esito: 'dichiarazione-ritratti-mancante',
      utente: r.attore.id,
      ruolo: r.attore.role ?? null,
    })
    return {
      response: NextResponse.json(
        { error: DICHIARAZIONE_MANCANTE, codice: 'CONSENSO_FOTO_DICHIARAZIONE_MANCANTE' },
        { status: 422 },
      ),
    }
  }

  const esito = await verificaConsensoSito(r.supabase, ritratti, r.sedi)
  if (esito.esito === 'non-verificabile') {
    // «Non lo so» non vale «sì». Il log dettagliato lo lascia già
    // `verificaConsensoSito` a livello error.
    return {
      response: NextResponse.json(
        { error: CONSENSO_NON_VERIFICABILE, codice: 'CONSENSO_FOTO_NON_VERIFICABILE' },
        { status: 503 },
      ),
    }
  }
  if (esito.esito === 'bloccato') {
    // Nel log solo i CONTEGGI: i nomi e gli id sono di minori. All'operatore —
    // che quei bambini li ha appena scelti — il nome serve per toglierli.
    logEvento('news', 'warn', {
      operazione: r.operazione,
      esito: 'consenso-sito-mancante',
      utente: r.attore.id,
      ruolo: r.attore.role ?? null,
      dichiarati: ritratti.length,
      senza_consenso: esito.bambini.length,
    })
    return {
      response: NextResponse.json(
        { error: CONSENSO_SITO_MANCANTE, codice: 'CONSENSO_FOTO_SITO_MANCANTE', bambini: esito.bambini },
        { status: 422 },
      ),
    }
  }

  // Si archivia solo ciò che è stato dichiarato ADESSO: una PATCH del titolo non
  // deve riscrivere data e autore di una dichiarazione fatta da un altro, un'altra
  // volta. La prova è di chi l'ha resa.
  return { prova: dichiaratoOra ? { bambini: ritratti, il: new Date().toISOString() } : null }
}

/** I quattro campi della prova, pronti per un `insert`/`update`. */
export function campiProva(prova: ProvaConsenso | null, attoreId: string): Record<string, unknown> {
  if (!prova) return {}
  return {
    bambini_ritratti: prova.bambini,
    consenso_dichiarato_da: attoreId,
    consenso_dichiarato_il: prova.il,
    consenso_versione: CONSENSI_VERSIONE,
  }
}

type ErrorePg = { code?: string; message: string } | null
type Risultato<T> = { data: T | null; error: ErrorePg }
/**
 * Il risultato GREZZO di PostgREST. `data` è `unknown` di proposito: le tabelle
 * non sono tipizzate e l'inferenza lo ridurrebbe a `null`, facendo cadere il
 * `as NewsPost` dei chiamanti su un errore che non c'entra niente col codice.
 */
type RisultatoGrezzo = { data: unknown; error: ErrorePg }

/**
 * Esegue una scrittura su `news_posts` togliendo, una alla volta, le colonne
 * della prova che il database non conosce (`PGRST204` su INSERT/UPDATE, `42703`
 * su SELECT: il DB E2E della CI non è migrato).
 *
 * Si tolgono SOLO le colonne della dichiarazione, mai un campo del post: qui si
 * sta perdendo la PROVA, non il controllo — il gate è già passato.
 */
export async function scriviConDegradazione<T = unknown>(
  record: Record<string, unknown>,
  esegui: (rec: Record<string, unknown>) => PromiseLike<RisultatoGrezzo>,
  operazione: string,
): Promise<Risultato<T>> {
  let res = await esegui(record)
  for (let i = 0; res.error && i < COLONNE_CONSENSO.length; i++) {
    const code = res.error.code ?? ''
    if (!['PGRST204', '42703'].includes(code)) break
    const col = COLONNE_CONSENSO.find((c) => c in record && res.error!.message.includes(c))
    if (!col) break
    logEvento('news', 'warn', {
      operazione,
      esito: 'colonna-consenso-assente',
      colonna: col,
      error_code: code,
    })
    delete record[col]
    res = await esegui(record)
  }
  return { data: (res.data ?? null) as T | null, error: res.error }
}
