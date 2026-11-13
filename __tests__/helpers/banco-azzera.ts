import { creaBancoPassaggio, type BancoPassaggio } from './passaggio-banco'

/**
 * Il banco di prova dell'AZZERAMENTO della Demo: il banco del passaggio (M49b) più le tabelle e le colonne che nascono accogliendo una
 * domanda e che lo script deve conoscere (giro 1 della revisione del 13/11/2026: O1, O4), con le chiavi esterne e le azioni
 * `ON DELETE` VERE di produzione (lette dal catalogo con una SELECT il 13/11/2026):
 *
 *  · `legame_genitori_alunni.alunno_id → alunni` NO ACTION · `student_parents.student_id → alunni` e `.parent_id → parents` CASCADE;
 *  · `iscrizioni_inviti_credenziali.submission_id → enrollment_submissions` e `.parent_id → parents` SET NULL;
 *  · `crm_bambini.alunno_id → alunni` e `.domanda_id → enrollment_submissions` SET NULL · `crm_schede.domanda_da_associare` SET NULL;
 *  · `valutazioni.materia_id → materie` NO ACTION · `incassi.quota_id → pagamenti_quote` SET NULL · `incassi.pagamento_id → pagamenti` RESTRICT.
 *
 * Le colonne che lo script nomina devono esistere anche in produzione: lo controlla `anno-azzera-colonne.test.ts`.
 */
export async function creaBancoAzzera(): Promise<BancoPassaggio> {
  const b = await creaBancoPassaggio({ fino: 'M49b' })
  await b.db.exec(`
    ALTER TABLE public.parents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE public.utenti ADD COLUMN IF NOT EXISTS creato_il timestamptz NOT NULL DEFAULT now();
    -- i genitori: la chiave verso gli alunni c'è in produzione (il banco del passaggio non la metteva)
    ALTER TABLE public.legame_genitori_alunni ADD CONSTRAINT legame_genitori_alunni_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id);
    ALTER TABLE public.student_parents ADD CONSTRAINT student_parents_student_id_fkey FOREIGN KEY (student_id) REFERENCES public.alunni(id) ON DELETE CASCADE;
    ALTER TABLE public.student_parents ADD CONSTRAINT student_parents_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.parents(id) ON DELETE CASCADE;
    CREATE TABLE public.iscrizioni_inviti_credenziali (
      submission_id uuid REFERENCES public.enrollment_submissions(id) ON DELETE SET NULL,
      parent_id uuid REFERENCES public.parents(id) ON DELETE SET NULL,
      auth_user_id uuid,
      creato_il timestamptz NOT NULL DEFAULT now()
    );
    -- il CRM: la scheda del genitore e i bambini che le appartengono
    CREATE TABLE public.crm_schede (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scuola_id uuid NOT NULL,
      domanda_da_associare uuid REFERENCES public.enrollment_submissions(id) ON DELETE SET NULL
    );
    ALTER TABLE public.crm_bambini
      ADD COLUMN alunno_id uuid REFERENCES public.alunni(id) ON DELETE SET NULL,
      ADD COLUMN domanda_id uuid REFERENCES public.enrollment_submissions(id) ON DELETE SET NULL;
    -- i figli di secondo livello: ciò che punta a una materia (che va via a cascata con la sezione) e a una quota (che va via con la voce)
    ALTER TABLE public.valutazioni ADD COLUMN materia_id uuid REFERENCES public.materie(id);
    ALTER TABLE public.incassi
      ADD COLUMN quota_id uuid REFERENCES public.pagamenti_quote(id) ON DELETE SET NULL,
      ADD CONSTRAINT incassi_pagamento_id_fkey FOREIGN KEY (pagamento_id) REFERENCES public.pagamenti(id) ON DELETE RESTRICT;
    -- l'alunno con una voce: la chiave c'è in produzione (NOT VALID: il banco del passaggio ha voci con alunni di prova)
    ALTER TABLE public.pagamenti ADD CONSTRAINT pagamenti_alunno_id_fkey FOREIGN KEY (alunno_id) REFERENCES public.alunni(id) NOT VALID;
  `)
  return b
}
