// A3 — Il corredo minimo con cui una SEDE NUOVA deve nascere.
//
// IL DIFETTO CHE QUESTO MODULO CHIUDE. `provisiona_sede` creava la sede in
// `schools` + `scuole` e collegava gli admin, ma NON creava la riga
// `admin_settings`. Senza quella riga `loadGradoContext` legge `matrice = {}`
// (src/lib/auth/require-grado.ts:36-44) e `requireFunzione` risponde **403 su
// tutte le funzioni docente** della sede (:64-86): la sede nasce con il registro
// elettronico spento, e non c'è nessun errore da nessuna parte che lo dica.
//
// Questo file è la fonte di verità TypeScript del default. La stessa identica
// forma è replicata nella RPC SQL `public.provisiona_sede`
// (supabase/migrations/20260729114316_provisiona_sede_admin_settings.sql): le due
// copie servono perché il ramo di fallback della route gira sul DB E2E, dove la
// RPC non esiste. **Se cambi qui, cambia anche là** (e viceversa).

export type GradoRegistro = 'nido' | 'infanzia' | 'primaria'

/** I 3 gradi della griglia di Impostazioni → Funzioni per grado. */
export const GRADI_REGISTRO = ['nido', 'infanzia', 'primaria'] as const

/**
 * Le 13 funzioni della griglia — stesso elenco, stessi id, di
 * `src/components/features/admin/settings/FunzioniMatricePanel.tsx`.
 */
export const FUNZIONI_REGISTRO = [
  'registro',
  'valutazioni',
  'note',
  'orario',
  'appello',
  'diario',
  'gallery',
  'mensa',
  'chat',
  'avvisi',
  'armadietto',
  'modulistica',
  'pagelle',
] as const

/**
 * Matrice grado → funzioni con cui nasce una sede nuova.
 *
 * PERCHÉ UN DEFAULT ESPLICITO E NON «copio dalla sede più vecchia».
 *  1. `admin_settings` non ha `created_at` (solo `updated_at`): «la più vecchia»
 *     non è nemmeno definibile in modo affidabile.
 *  2. In produzione esiste già una riga con `funzioni_matrice = {}` (la sede di
 *     collaudo): copiare da lì propagherebbe esattamente il difetto che stiamo
 *     correggendo — una sede nuova col registro spento.
 *  3. Un default scritto qui è deterministico, si legge in code review e resta
 *     identico anche quando NON esiste nessun'altra sede.
 * La Direzione può comunque personalizzare tutto da Impostazioni → Funzioni per
 * grado: questo è il punto di partenza, non un vincolo.
 *
 * I valori riproducono la ripartizione già in uso a Kidville Giugliano: nido e
 * infanzia lavorano su diario/appello/mensa/comunicazione, la primaria aggiunge
 * registro, valutazioni, orario, note e pagelle.
 */
export const DEFAULT_FUNZIONI_MATRICE: Record<GradoRegistro, Record<string, boolean>> = {
  nido: {
    registro: false,
    valutazioni: false,
    note: false,
    orario: false,
    appello: true,
    diario: true,
    gallery: true,
    mensa: true,
    chat: true,
    avvisi: true,
    armadietto: true,
    modulistica: true,
    pagelle: false,
  },
  infanzia: {
    registro: false,
    valutazioni: false,
    note: false,
    orario: false,
    appello: true,
    diario: true,
    gallery: true,
    mensa: true,
    chat: true,
    avvisi: true,
    armadietto: true,
    modulistica: true,
    pagelle: false,
  },
  primaria: {
    registro: true,
    valutazioni: true,
    note: true,
    orario: true,
    appello: true,
    diario: false,
    gallery: true,
    mensa: true,
    chat: true,
    avvisi: true,
    armadietto: false,
    modulistica: true,
    pagelle: true,
  },
}

/**
 * A4 — Solleciti automatici di una sede NUOVA: **spenti**, ed è una scelta, non
 * una dimenticanza.
 *
 * Una sede appena provisionata sta ancora importando anagrafiche e pagamenti, e
 * `retta_auto_enabled` è `true` per default: le prime rette nascono con scadenze
 * anche retrodatate. Col cron acceso, il primo giro delle 06:00 manderebbe
 * solleciti di morosità VERI a famiglie vere per debiti che sono solo un artefatto
 * dell'import — e un'email spedita non si richiama. Il costo dell'errore opposto è
 * una spunta da mettere in Impostazioni → Solleciti («Cron attivo») quando i dati
 * sono verificati.
 *
 * Coerente con `DEFAULT_SOLLECITI_CONFIG.enabled = false`
 * (src/lib/pagamenti/solleciti.ts) e con il commento della route
 * `POST /api/pagamenti/solleciti/run` («SOLO per le scuole con
 * solleciti_config.enabled — default off»).
 *
 * Cadenza e testi dei 3 livelli NON si duplicano qui: `livelliEffettivi()` li
 * riempie già dai default del codice, e scriverli nel DB li congelerebbe alla
 * data della migrazione, facendoli divergere da quelli mostrati in Impostazioni.
 */
export const DEFAULT_SOLLECITI_SEDE_NUOVA = { enabled: false } as const

/** La riga `admin_settings` con cui provisionare una sede nuova. */
export function defaultAdminSettingsRow(scuolaId: string): {
  scuola_id: string
  funzioni_matrice: Record<string, Record<string, boolean>>
  solleciti_config: { enabled: boolean }
} {
  return {
    scuola_id: scuolaId,
    // Copie, non riferimenti: la riga finisce in una INSERT e nessuno deve poter
    // mutare il default globale passando di qui.
    funzioni_matrice: JSON.parse(JSON.stringify(DEFAULT_FUNZIONI_MATRICE)) as Record<string, Record<string, boolean>>,
    solleciti_config: { ...DEFAULT_SOLLECITI_SEDE_NUOVA },
  }
}
