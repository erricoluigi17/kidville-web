-- ═══════════════════════════════════════════════════════════════════════════════
-- Il legame che il codice vede e la RLS no.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DISALLINEAMENTO, in una riga: **il codice unisce due sorgenti, il database
-- ne legge una sola.**
--
--   · `src/lib/anagrafiche/legami.ts` → `getFigliDiGenitoreEsito()` unisce
--     `legame_genitori_alunni` (runtime) **e** `student_parents` (anagrafica).
--   · `current_parent_student_ids()` — la funzione SECURITY DEFINER su cui poggia
--     ogni policy «(parents space)» — legge **solo `student_parents`**.
--
-- Quindi un legame che vive soltanto nel runtime è **invisibile alla RLS**: il gate
-- applicativo dice sì, e poi ogni lettura fatta col client di sessione (orario
-- settimanale, obiettivi di materia, e in genere tutto ciò che passa dalle policy
-- di famiglia) torna vuota. Non un errore: un vuoto, che è peggio, perché si legge
-- come «non c'è niente» invece che come «non ti è stato mostrato».
--
-- ─── MISURATO IN PRODUZIONE IL 2026-09-01, PRIMA DI SCRIVERE ───────────────────
--   profili doppi (utenti staff + ponte parents) ............... 5
--   legami di staff in legame_genitori_alunni ................. 8
--   di cui INVISIBILI alla RLS ................................ 1   ← questa migrazione
--
-- Un caso solo. Si ripara lo stesso, e non per pignoleria: è il caso in cui una
-- persona vede il gate aprirsi e la schermata restare vuota, cioè il difetto più
-- difficile da segnalare perché non somiglia a un guasto.
--
-- ─── PERCHÉ `relation_type` RESTA NULL, invece di dire «tutore» ────────────────
--
-- Non sappiamo se quella persona sia il padre o la madre: `parents.gender` non è
-- indicato, e non ha altre righe in `student_parents` da cui dedurlo. Il vocabolario
-- realmente presente nella tabella è `father | madre | mother | padre` — quattro
-- valori, già misti fra italiano e inglese perché vengono da due importazioni
-- diverse. Non c'è nessun CHECK, quindi «tutore» **si potrebbe** scrivere: ed è
-- esattamente per questo che non lo si scrive. Sarebbe un quinto valore inventato
-- qui, che afferma una cosa che nessuno ha verificato.
--
-- NULL non è una rinuncia: è il caso NORMALE di questa tabella — **569 righe su
-- 687 hanno già `relation_type` NULL** (83%). E l'interfaccia lo gestisce già:
-- `ParentDetailPanel.tsx:673` rende mother→«Madre», father→«Padre», e qualunque
-- altra cosa → «Delegato».
--
-- `is_primary = false` invece è esplicito, perché `is_primary` non è mai NULL in
-- questa tabella (0 righe su 687) e perché una riparazione non è il contatto
-- principale di nessuno: quello lo decide la Segreteria, non una migrazione.
--
-- ─── COSA NON FA ───────────────────────────────────────────────────────────────
-- `ON CONFLICT DO NOTHING` sulla PK `(student_id, parent_id)`: **non tocca nessuna
-- riga esistente**, né `relation_type` né `is_primary` di chi ce l'ha già — sono
-- dati inseriti da una persona in Segreteria, e valgono più di questa deduzione.
-- Non crea legami: ne rende visibili di già esistenti, copiandoli dal runtime
-- all'anagrafica. Non tocca `legame_genitori_alunni`. È idempotente.
-- ═══════════════════════════════════════════════════════════════════════════════

INSERT INTO public.student_parents (student_id, parent_id, relation_type, is_primary)
SELECT l.alunno_id, p.id, NULL, false
  FROM public.legame_genitori_alunni l
  JOIN public.utenti  u ON u.id = l.genitore_id AND u.ruolo <> 'genitore'
  JOIN public.parents p ON p.auth_user_id = u.id
ON CONFLICT (student_id, parent_id) DO NOTHING;

-- ─── COME SI VERIFICA, dopo l'apply ────────────────────────────────────────────
--   -- deve dare 0: nessun legame di staff resta invisibile alla RLS
--   SELECT count(*) FROM public.legame_genitori_alunni l
--     JOIN public.utenti  u ON u.id = l.genitore_id AND u.ruolo <> 'genitore'
--     JOIN public.parents p ON p.auth_user_id = u.id
--    WHERE NOT EXISTS (SELECT 1 FROM public.student_parents sp
--                       WHERE sp.parent_id = p.id AND sp.student_id = l.alunno_id);
--
-- ─── ROLLBACK ──────────────────────────────────────────────────────────────────
-- Toglie SOLO le righe con la firma di questa migrazione (relation_type NULL e
-- is_primary false), quindi non può cancellare un legame inserito a mano.
--   DELETE FROM public.student_parents sp
--    USING public.parents p, public.utenti u, public.legame_genitori_alunni l
--    WHERE sp.parent_id = p.id AND p.auth_user_id = u.id AND u.ruolo <> 'genitore'
--      AND sp.student_id = l.alunno_id AND l.genitore_id = u.id
--      AND sp.relation_type IS NULL AND sp.is_primary = false;
