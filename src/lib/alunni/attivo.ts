import type { SupabaseClient } from '@supabase/supabase-js';
import { eAncoraIscritto } from './stato';
import { logEvento } from '@/lib/logging/logger';

/**
 * QUANDO UN BAMBINO NON DEVE PIÙ COMPARIRE ALLA SUA FAMIGLIA — in un posto solo.
 *
 * ─── IL DIFETTO, misurato il 2026-09-05 ─────────────────────────────────────
 *
 * `GET /api/parent/students` leggeva `alunni` con il solo `.in('id', ids)`, senza
 * un filtro su `section_id`, `stato`, `archiviato_il`. Quella rotta alimenta
 * `useParentIdentity` → `ChildSwitcher` → lo `studentId` di TUTTA l'app di
 * famiglia: un bambino senza classe entrava dappertutto e poi perdeva in silenzio
 * — moduli e avvisi di classe, news di grado, agenda di sezione, materiali
 * dell'armadietto, l'intera area primaria (blocco duro su `section_id` in quattro
 * rotte) e le RETTE, che `genera-rette` non produce per chi non ha classe.
 * Presente e non funzionante: la combinazione peggiore, perché non lascia nemmeno
 * un errore da cercare.
 *
 * ─── PERCHÉ UN MODULO SUO, E NON DENTRO `anagrafiche/legami` ────────────────
 *
 * Perché la regola serve a DUE strade — l'elenco dei figli
 * (`getFigliAttiviDiGenitore`) e il gate delle venti rotte
 * (`requireParentOfStudent`) — e in questo repo *una regola valida per due strade
 * deve vivere in un posto solo*.
 *
 * E perché `@/lib/anagrafiche/legami` è sostituito da `vi.mock` in **48 file di
 * test**: metterla lì rendeva rossi 17 test che con questo lavoro non c'entrano
 * niente, tutti con lo stesso errore —
 *   `[vitest] No "verificaAlunnoAttivo" export is defined on the mock`.
 * È la lezione già scritta in testa a `require-parent.ts` per `eFamiglia`, e il
 * rimedio è lo stesso: il pezzo che serve a tutti vive dove nessuno lo mocka.
 *
 * ⚠️ NON È IL CONFINE DELL'OBLIO, e non è quello dei canali verso le famiglie.
 * Quelli stanno in `./stato` (`eNonPiuIscritto`, `STATI_CON_CANALE_FAMIGLIA`) e
 * rispondono ad altre due domande. Qui la domanda è una sola: *questo bambino lo
 * mostro nell'app di suo padre?*. Il vocabolario degli stati però NON si
 * riscrive: lo decide `eAncoraIscritto`, che sta di là. Un `'sospeso'` frequenta e
 * resta visibile; uno stato sconosciuto non autorizza a nascondere niente.
 */

/** Perché un figlio non compare. Tre motivi, e restano distinti nei log. */
export type MotivoFiglioNascosto = 'archiviato' | 'ritirato' | 'senza-sezione';

/**
 * Le tre colonne che decidono la visibilità. Non escono mai verso il client:
 * servono solo a questo modulo.
 */
export const COLONNE_VISIBILITA = ['section_id', 'stato', 'archiviato_il'] as const;

/**
 * Il motivo per cui questa riga non si mostra, o `null` se si mostra.
 *
 * `presenti` è l'insieme delle colonne DAVVERO lette: il DB E2E della CI non è
 * migrato e su `SELECT` risponde `42703`. Una colonna assente non applica il suo
 * criterio — si degrada APERTI, che è il verso giusto in cui sbagliare: chiudere
 * vorrebbe dire svuotare l'app a 662 famiglie perché uno schema è indietro.
 *
 * L'ordine è una PRECEDENZA, non un caso: un archiviato ha quasi sempre anche
 * `stato = 'ritirato'` e `section_id` nullo (misurato: 5 su 5 in produzione), e
 * contarlo tre volte gonfierebbe proprio il numero che i log servono a leggere.
 */
export function motivoNascosto(
  riga: Record<string, unknown>,
  presenti: ReadonlySet<string>,
): MotivoFiglioNascosto | null {
  if (presenti.has('archiviato_il') && riga.archiviato_il != null) return 'archiviato';
  const stato = typeof riga.stato === 'string' ? riga.stato : null;
  if (presenti.has('stato') && !eAncoraIscritto(stato)) return 'ritirato';
  if (presenti.has('section_id') && riga.section_id == null) return 'senza-sezione';
  return null;
}

/**
 * Tre esiti e non due, per la stessa ragione di `verificaLegameGenitore`:
 * `'non-letto'` NON è `'nascosto'`. Chi decide un accesso non può concludere
 * niente da una lettura fallita.
 */
export type EsitoAlunnoAttivo = 'attivo' | 'nascosto' | 'non-letto';

const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Solo conteggi e codici PostgREST: mai un id di minore in una riga di guasto. */
function segnala(esito: string, err: unknown): void {
  logEvento('db', 'error', {
    operazione: 'alunni/attivo',
    esito,
    entita_tipo: 'alunni',
    error_code: (err as { code?: string } | null)?.code ?? null,
  }, err);
}

/**
 * Questo alunno è ancora fra quelli che la sua famiglia deve vedere?
 *
 * ⚠️ UNA LETTURA FALLITA LASCIA PASSARE, e va detto per esteso perché è la
 * decisione più discutibile di questo modulo. Il perimetro di SICUREZZA non è
 * questo: è il legame di famiglia, che `requireParentOfStudent` ha già verificato
 * prima di chiamare qui. Questo è un filtro di PRESENTAZIONE, e negarlo su un
 * guasto significherebbe chiudere l'app in faccia a un genitore titolare per un
 * blip del database — il difetto T13 che `anagrafiche/legami` ha già pagato una
 * volta. Il guasto non è però silenzioso: lascia una riga di livello `error`.
 *
 * ⚠️ IL `try/catch` NON È QUELLO VIETATO DALLA REGOLA 7. PostgREST non lancia:
 * l'errore di merito arriva nel valore di ritorno ed è gestito lì sotto. Questo
 * `catch` prende ciò che lancia DAVVERO — rete, client non inizializzato — e
 * logga prima di degradare.
 */
export async function verificaAlunnoAttivo(
  supabase: SupabaseClient,
  alunnoId: string,
): Promise<EsitoAlunnoAttivo> {
  // Un id che non è un uuid non è un alunno: nascondere è la risposta prudente, e
  // mandarlo a PostgREST produrrebbe un `22P02` contato come guasto del server.
  if (!FORMA_UUID.test(alunnoId ?? '')) return 'nascosto';

  let colonne: string[] = ['id', ...COLONNE_VISIBILITA];
  const leggi = () =>
    supabase.from('alunni').select(colonne.join(', ')).eq('id', alunnoId).maybeSingle();

  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await leggi());
    let tentativi = 0;
    while (error && (error as { code?: string }).code === '42703' && tentativi < 5) {
      const col = /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist/i.exec(
        (error as { message?: string }).message ?? '',
      )?.[1];
      if (!col || col === 'id' || !colonne.includes(col)) break;
      colonne = colonne.filter((c) => c !== col);
      ({ data, error } = await leggi());
      tentativi += 1;
    }
  } catch (e) {
    segnala('alunno-attivo-non-letto', e);
    return 'non-letto';
  }

  if (error) {
    segnala('alunno-attivo-non-letto', error);
    return 'non-letto';
  }
  // Riga assente: non c'è niente da nascondere. Il 404 lo dà la rotta, che sa di
  // che cosa stava parlando.
  if (!data) return 'attivo';

  const presenti = new Set(colonne);
  return motivoNascosto(data as Record<string, unknown>, presenti) ? 'nascosto' : 'attivo';
}
