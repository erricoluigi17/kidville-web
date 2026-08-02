-- ============================================================================
-- La bacheca interna dichiara la sua sede — `task_interni.scuola_id` NOT NULL
-- ============================================================================
--
-- COSA FA
--   Rende OBBLIGATORIA la colonna `scuola_id` sulla tabella `task_interni`,
--   cioè i promemoria/incarichi che lo staff si assegna fra colleghi. E si
--   assicura che quel valore punti davvero a una sede esistente (chiave esterna
--   verso `schools`), creando il vincolo solo se manca.
--
-- PERCHÉ ADESSO
--   Dal 2026-07-29 le sedi sono tre. Finché `scuola_id` resta facoltativa, un
--   promemoria può nascere senza plesso: non compare nella bacheca di NESSUNA
--   sede. Non è una fuga di dati, è una sparizione silenziosa — nessun errore,
--   nessun avviso, nessuno che se ne accorga. Da oggi la route che crea i
--   promemoria dichiara sempre la sede su cui si sta lavorando
--   (`resolveScuolaScrittura`, che risponde 400 quando la sede è ambigua invece
--   di indovinarla): questo vincolo non toglie niente a nessuno, mette il
--   database in condizione di rifiutare ciò che il codice non scrive più.
--
-- PERCHÉ OGGI COSTA ZERO
--   `public.task_interni` è VUOTA in produzione: 0 righe (verificato il
--   2026-07-31, sola lettura). Nessun dato da spostare, nessun promemoria da
--   riattribuire a mano, nessun rischio di assegnare una riga alla sede
--   sbagliata. Fra qualche mese, con la bacheca in uso, la stessa identica
--   migrazione costerebbe una riconciliazione riga per riga.
--
-- COSA NON FA
--   · non cancella, non modifica e non sposta NESSUNA riga (non ce ne sono);
--   · non tocca il testo, gli assegnatari, lo stato o le scadenze dei
--     promemoria, né le altre tabelle;
--   · non cambia permessi, RLS o funzioni;
--   · non ricrea la chiave esterna se c'è già (in produzione c'è, dal baseline).
--
-- SE VA STORTA
--   L'unico modo in cui può fallire è trovare promemoria senza sede: in quel
--   caso si ferma sul primo controllo, dice quanti sono e NON cambia niente —
--   una migrazione è una transazione, o passa tutta o non passa. Si assegna la
--   sede a quelle righe e si riapplica.
--   Per tornare indietro basta una riga:
--     alter table public.task_interni alter column scuola_id drop not null;
-- ============================================================================

-- 1. Il controllo prima del vincolo. Serve al messaggio, non alla sicurezza:
--    senza, `set not null` fallirebbe comunque, ma con un errore che non dice
--    QUANTE righe siano rimaste indietro né cosa farne.
do $$
declare
    senza_sede bigint;
begin
    select count(*) into senza_sede from public.task_interni where scuola_id is null;
    if senza_sede > 0 then
        raise exception
            'task_interni: % promemoria senza sede. Assegna la sede a quelle righe prima di applicare questa migrazione — nessuna modifica è stata fatta.',
            senza_sede;
    end if;
end $$;

-- 2. La chiave esterna verso le sedi. In produzione esiste già
--    (`task_interni_scuola_id_fkey`, dal baseline del 2026-07-04): il blocco la
--    crea SOLO dove manca, così questo file resta valido anche su un database
--    ricostruito da zero o su un ambiente di collaudo più vecchio.
--    Senza FK, `scuola_id` sarebbe un uuid libero: una riga con un valore che
--    non corrisponde a nessuna sede sparirebbe da ogni filtro per plesso.
do $$
begin
    if not exists (
        select 1
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = 'public'
          and t.relname = 'task_interni'
          and c.contype = 'f'
          and c.conname = 'task_interni_scuola_id_fkey'
    ) then
        alter table public.task_interni
            add constraint task_interni_scuola_id_fkey
            foreign key (scuola_id) references public.schools(id) on delete cascade;
    end if;
end $$;

-- 3. Il vincolo vero e proprio.
alter table public.task_interni
    alter column scuola_id set not null;

comment on column public.task_interni.scuola_id is
    'Sede (schools.id) a cui appartiene il promemoria interno. Obbligatoria dal 2026-07-31: con tre plessi un promemoria senza sede non comparirebbe nella bacheca di nessuno. La dichiara chi lo crea (resolveScuolaScrittura), mai un ripiego sulla sede primaria dell''autore.';
