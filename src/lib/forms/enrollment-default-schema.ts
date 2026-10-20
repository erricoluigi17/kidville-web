import type { SupabaseClient } from '@supabase/supabase-js';
import type { FormSchemaConfig } from '@/types/database.types';
import { CHILD_FIELDS, ADULT_FIELDS } from './enrollment-template';

// =============================================================================
// "Modulo d'iscrizione standard" come modello editabile dal form-builder.
//
// Il modulo standard resta servito su /iscrizione (wizard) con invio a
// enrollment_submissions e revisione nella tab "Ricevute": qui NON cambia il
// flusso. Cambia solo che i suoi CAMPI diventano modificabili dalla segreteria
// (builder) e ripristinabili al set base con "Reimposta".
//
// Lo schema di base è single-source: due pagine (bambino/adulto) costruite dai
// template CHILD_FIELDS/ADULT_FIELDS. Il wizard legge queste due pagine come
// template ripetibili (N figli, N adulti). "Reimposta" riscrive lo schema con
// ENROLLMENT_DEFAULT_SCHEMA.
// =============================================================================

// Id stabile del modello standard (seed idempotente).
export const STANDARD_ENROLLMENT_MODEL_ID = 'f0000000-0000-4000-8000-000000000001';
export const STANDARD_ENROLLMENT_TITLE = "Modulo d'iscrizione standard";

export const ENROLLMENT_CHILD_PAGE_ID = 'bambino';
export const ENROLLMENT_ADULT_PAGE_ID = 'adulto';

export function buildEnrollmentDefaultSchema(): FormSchemaConfig {
  return {
    version: '1',
    pages: [
      { id: ENROLLMENT_CHILD_PAGE_ID, title: 'Dati del bambino', fields: CHILD_FIELDS },
      { id: ENROLLMENT_ADULT_PAGE_ID, title: 'Adulto di riferimento', fields: ADULT_FIELDS },
    ],
    settings: { show_progress_bar: true },
  };
}

export const ENROLLMENT_DEFAULT_SCHEMA: FormSchemaConfig = buildEnrollmentDefaultSchema();

/**
 * Crea la riga `form_models` del modulo standard se non esiste ancora.
 * NON sovrascrive lo schema se il modello è già presente (preserva le modifiche
 * fatte dalla segreteria). Il ripristino esplicito passa da POST /form-models/reset.
 *
 * Un guasto del database LANCIA (errore con `cause`: il `logErrore` del chiamante lo registra
 * col codice Postgres). Prima un guasto in lettura diventava «non c'è» e un insert fallito
 * passava muto: il reset che segue aggiornava ZERO righe e rispondeva `success: true`.
 */
export async function ensureStandardEnrollmentModel(supabase: SupabaseClient): Promise<void> {
  const { data, error: erroreLettura } = await supabase
    .from('form_models')
    .select('id')
    .eq('id', STANDARD_ENROLLMENT_MODEL_ID)
    .maybeSingle();
  if (erroreLettura) {
    throw new Error("Lettura del modulo d'iscrizione standard non riuscita", { cause: erroreLettura });
  }
  if (data) return;
  const { error: erroreInsert } = await supabase.from('form_models').insert({
    id: STANDARD_ENROLLMENT_MODEL_ID,
    title: STANDARD_ENROLLMENT_TITLE,
    schema: ENROLLMENT_DEFAULT_SCHEMA,
    is_active: true,
    is_enrollment_form: true,
  });
  // `23505`: un'altra richiesta l'ha creato fra la lettura e l'insert — il modello c'è, che è
  // ciò che questa funzione promette.
  if (erroreInsert && erroreInsert.code !== '23505') {
    throw new Error("Creazione del modulo d'iscrizione standard non riuscita", { cause: erroreInsert });
  }
}

/** Estrae i template child/adult dallo schema di un modello d'iscrizione. */
export function extractEnrollmentTemplates(schema: FormSchemaConfig | null | undefined): {
  child: typeof CHILD_FIELDS;
  adult: typeof ADULT_FIELDS;
} {
  const pages = schema?.pages ?? [];
  const child = pages.find((p) => p.id === ENROLLMENT_CHILD_PAGE_ID)?.fields;
  const adult = pages.find((p) => p.id === ENROLLMENT_ADULT_PAGE_ID)?.fields;
  return {
    child: child && child.length ? child : CHILD_FIELDS,
    adult: adult && adult.length ? adult : ADULT_FIELDS,
  };
}
