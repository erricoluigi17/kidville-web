-- =============================================================================
-- TRE RIGHE CHE DICHIARANO CANCELLATO UN BAMBINO CHE C'È ANCORA
--
-- ✅ APPLICATA il 2026-08-12, version `20260812194614`. Rimosse 3 righe.
--    Verificato DOPO: la SELECT di controllo torna 0, `app_log` porta una riga con
--    `esito = 'registro-modifiche-hard-delete-bonificate'` e `n_righe = 3`, e l'alunno
--    96399f3e-… È ANCORA IN `alunni` — che è il punto: quelle tre righe dicevano il
--    contrario, ed è per questo che sono state tolte.
--
--    ⚠️ IL PRIMO TENTATIVO È FALLITO, e vale la pena saperlo: `sorgente = 'sql'` viola
--    `app_log_sorgente_check`, che ammette solo 'server' | 'client'. La transazione ha
--    fatto rollback e le tre righe erano ancora tutte lì — verificato prima di riprovare.
--    È il motivo per cui una bonifica si scrive dentro una transazione: un fallimento a
--    metà, qui, avrebbe cancellato una parte delle prove e lasciato l'altra.
--
-- COSA È SUCCESSO — misurato, non ricostruito
--    `admin/students:DELETE` scriveva l'audit PRIMA di cancellare (route.ts:847) e non
--    lo annullava quando la cancellazione falliva. Il 2026-08-12 un admin ha premuto
--    tre volte «Elimina Alunno (GDPR)»; tre volte la DELETE è morta su una foreign
--    key (23503); tre volte l'audit era già stato scritto.
--
--    Risultato, letto in produzione prima di scrivere questa migrazione:
--        id   azione            record_id     alunno_ancora_presente   n_colonne
--        89   hard_delete_gdpr  96399f3e-…    true                     48
--        90   hard_delete_gdpr  96399f3e-…    true                     48
--        91   hard_delete_gdpr  96399f3e-…    true                     48
--
--    Quarantotto colonne per riga: è `select *` dell'anagrafica di un minore vivo —
--    codice fiscale, note mediche, BES — copiata tre volte dentro una tabella di
--    audit, sotto un'etichetta che dice «cancellato» a proposito di un bambino che
--    è ancora iscritto. Sono tre affermazioni false che portano con sé tre copie di
--    dati sanitari.
--
--    ⚠️ La verifica si fa SENZA far uscire `vecchio_valore`: si contano le chiavi,
--    non si leggono. Diagnosticare un problema di privacy stampando i dati è il modo
--    più rapido di aggiungerne un secondo.
--
-- L'AUTORIZZAZIONE
--    Rimozione autorizzata dal titolare il 2026-08-12, mostrate le righe prima di
--    toccarle. La causa a monte è estirpata nello stesso rilascio: `admin/students:DELETE`
--    viene rimossa del tutto, e il lock
--    `__tests__/architecture/registro-modifiche-senza-hard-delete.test.ts` impedisce
--    che il letterale `hard_delete_gdpr` rientri in `src/`.
--
-- PERCHÉ IL PREDICATO NON CABLA GLI ID 89, 90, 91
--    Perché una migrazione con tre numeri dentro è vera solo il giorno in cui la si
--    scrive. Questo predicato dice ciò che si intende davvero — «cancella le righe
--    che dichiarano eliminato un alunno ANCORA PRESENTE», cioè solo quelle false — e
--    resterebbe corretto anche se applicato fra sei mesi su uno stato diverso.
--    Un audit veritiero (alunno davvero sparito) non viene toccato: è la prova di una
--    cancellazione avvenuta, e quella si conserva.
-- =============================================================================

begin;

do $$
declare
  v_righe integer;
begin

  delete from public.registro_modifiche rm
   where rm.azione = 'hard_delete_gdpr'
     and rm.tabella_interessata = 'alunni'
     and exists (select 1 from public.alunni a where a.id = rm.record_id);

  get diagnostics v_righe = row_count;

  -- Il conteggio si logga SEMPRE, anche quando è zero.
  -- «Nessun log» non distingue «non c'era niente da bonificare» da «la migrazione non
  -- è mai partita» — ed è esattamente l'ambiguità che in questo progetto ha già
  -- nascosto un guasto per mesi (AGENTS.md, Logging obbligatorio §5).
  -- ⚠️ `sorgente` = 'server', non 'sql'.
  --    Il primo tentativo usava 'sql', che descriveva meglio chi scrive questa riga, e
  --    `app_log_sorgente_check` l'ha respinto: il vincolo ammette solo 'server' | 'client'.
  --    Vale la pena saperlo perché è il motivo per cui i lavori SQL di questo repo si
  --    presentano come 'server': chi li distingue è il `fingerprint` (prefisso `sql:`) e
  --    l'`operazione` nel contesto, non questa colonna.
  --
  -- ⚠️ E IL BATTITO SI SCRIVE SOLO SE `app_log` C'È.
  --    Sul database della CI quella tabella NON esiste (misurato il 13/08: la migrazione
  --    è caduta lì con `relation "public.app_log" does not exist`, e ha portato con sé
  --    la successiva, saltata). La bonifica però deve poter girare comunque: il suo
  --    lavoro è togliere righe false da `registro_modifiche`, e non può dipendere dalla
  --    presenza del registro dei log — che è osservabilità, non prodotto.
  --    Il verso è quello di AGENTS.md §9: «il logger non deve mai rompere l'app». Qui
  --    vale per un lavoro SQL, e la conseguenza è la stessa — se il posto dove scrivere
  --    non c'è, si fa il lavoro e non lo si annuncia, invece di non farlo.
  if to_regclass('public.app_log') is not null then
    insert into public.app_log (livello, evento, sorgente, messaggio, fingerprint, contesto)
    values (
      case when v_righe > 0 then 'warn' else 'info' end,
      'gdpr',
      'server',
      'bonifica registro_modifiche: rimosse le righe hard_delete_gdpr che dichiaravano '
        || 'eliminato un alunno ancora presente',
      'sql:bonifica-registro-modifiche-hard-delete',
      jsonb_build_object(
        'esito', 'registro-modifiche-hard-delete-bonificate',
        'n_righe', v_righe,
        'operazione', 'migrazione/bonifica_registro_modifiche_hard_delete'
      )
    );
  end if;

end $$;

commit;

-- =============================================================================
-- COME SI VERIFICA, DOPO
--
--   -- deve tornare 0 righe:
--   select count(*) from public.registro_modifiche rm
--    where rm.azione = 'hard_delete_gdpr' and rm.tabella_interessata = 'alunni'
--      and exists (select 1 from public.alunni a where a.id = rm.record_id);
--
--   -- deve tornare 1 riga, con n_righe = 3:
--   select contesto->>'n_righe' from public.app_log
--    where contesto->>'esito' = 'registro-modifiche-hard-delete-bonificate';
--
-- E COSA NON FA
--   • NON tocca `audit_scritture_docente`, che è l'altro registro e non ha il difetto.
--   • NON tocca le righe `hard_delete_gdpr` di alunni davvero cancellati: se un
--     giorno esistessero, sarebbero prove vere e si conservano.
--   • NON cambia lo schema: nessuna colonna, nessun vincolo, nessuna policy.
-- =============================================================================
