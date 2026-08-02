-- ═══════════════════════════════════════════════════════════════════════════════
-- Chat: l'allegato in tabella torna a essere un PERCORSO, non un link eterno
-- Collaudo del 2026-07-31, rilievo debug W3. Step S32.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- IL DIFETTO. Quando qualcuno allegava un file a un messaggio di chat, il server
-- ne creava un indirizzo firmato valido **365 giorni** e salvava QUELL'INDIRIZZO
-- dentro `chat_messages.attachment_url`. Sembrava un link a scadenza, ma un anno
-- è come dire «per sempre»: chi lo copiava, lo inoltrava o se lo ritrovava in una
-- copia di sicurezza apriva il file senza entrare nell'applicazione, senza
-- password, senza che contasse più il suo ruolo o la sua sede.
--
-- In chat fra scuola e famiglia passano certificati medici, foto di bambini,
-- questioni personali. Il magazzino dei file era già chiuso a chiave: era la
-- chiave a stare scritta in chiaro dentro il database, e a durare un anno.
--
-- Gli allegati degli avvisi e degli incarichi erano usciti da questo stesso
-- schema il 2026-07-31. La chat era rimasta l'ultima.
--
-- COSA FA QUESTA MIGRAZIONE. Una cosa sola: nei messaggi già scritti sostituisce
-- l'indirizzo firmato con il solo NOME DEL FILE dentro il magazzino (il
-- «percorso»). Da lì in poi è il programma a costruire un indirizzo nuovo ogni
-- volta che qualcuno apre la conversazione, e quell'indirizzo dura dieci minuti.
--
-- Oggi in tutto il database c'è UN SOLO messaggio con un allegato (misurato il
-- 2026-08-01: 30 messaggi, 1 con allegato, con indirizzo firmato). Questa
-- migrazione tocca quella riga.
--
-- COSA NON FA.
--  · Non cancella e non sposta nessun file: i 27 file nel magazzino della chat
--    restano dove sono, intatti.
--  · Non cancella nessun messaggio e non ne cambia il testo.
--  · Non tocca gli allegati di altre parti del programma (avvisi, incarichi,
--    galleria): quelli sono già a posto.
--  · NON FA SCADERE gli indirizzi già consegnati. Un indirizzo firmato dato a
--    qualcuno in passato continua a funzionare fino alla sua scadenza naturale:
--    per annullarlo davvero servirebbe cambiare la chiave di firma di tutto il
--    magazzino, che spegnerebbe anche foto, fatture e pagelle. Questa migrazione
--    toglie il lasciapassare dal database — dove non serviva a niente ed era il
--    posto più facile da cui farselo scappare — e impedisce che se ne creino di
--    nuovi. Sono due cose diverse, e la seconda è quella che conta da domani.
--  · Non decide per quanto tempo si conservano gli allegati della chat: quella è
--    una scelta del titolare, e oggi non c'è ancora (i file restano finché non li
--    si cancella a mano).
--
-- SE VA STORTO. Il rischio è uno solo e non è la perdita di dati: se il percorso
-- venisse ricavato male dall'indirizzo, quel messaggio mostrerebbe «allegato non
-- disponibile» — si vede subito, non rompe nient'altro e il file è ancora nel
-- magazzino. La riscrittura avviene solo sulle righe che contengono davvero un
-- indirizzo del magazzino della chat, e il programma sa comunque leggere
-- entrambe le forme (vecchia e nuova), quindi anche se questa migrazione non
-- venisse mai applicata la chat continuerebbe a funzionare.
--
-- SI PUÒ RIPETERE. Applicarla due volte non cambia niente: la seconda volta non
-- trova più nessuna riga da riscrivere.

do $$
declare
  n_prima  integer;
  n_dopo   integer;
begin
  -- Sul database di collaudo della CI le tabelle applicative possono non esserci:
  -- in quel caso non c'è niente da fare e la migrazione esce in silenzio.
  if to_regclass('public.chat_messages') is null then
    raise notice 'chat_messages assente: nessuna riscrittura';
    return;
  end if;

  select count(*) into n_prima
  from public.chat_messages
  where attachment_url like '%/storage/v1/object/%/chat-allegati/%';

  update public.chat_messages
  set attachment_url = regexp_replace(
        split_part(attachment_url, '?', 1),          -- via la firma (`?token=…`)
        '^.*/storage/v1/object/(?:public|sign|authenticated)/chat-allegati/',
        ''
      )
  where attachment_url like '%/storage/v1/object/%/chat-allegati/%';

  select count(*) into n_dopo
  from public.chat_messages
  where attachment_url like '%/storage/v1/object/%/chat-allegati/%';

  raise notice 'chat_messages: % indirizzi firmati riportati a percorso (residui: %)',
    n_prima - n_dopo, n_dopo;
end $$;
