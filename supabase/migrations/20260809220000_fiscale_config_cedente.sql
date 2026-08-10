-- ANAGRAFICA DEL CEDENTE in `admin_settings.fiscale_config` — la fonte unica,
-- riempita per le sedi che non l'hanno mai compilata.
--
-- PERCHÉ SERVE. `fiscale_config` è `{}` su tutte le righe di `admin_settings`:
-- ricevute e attestazioni escono senza intestazione (è già successo, W4-A/R124) e
-- la fattura elettronica non può proprio partire, perché senza CAP e comune lo SDI
-- la scarta. La struttura dati esisteva da luglio; nessuno l'aveva riempita perché
-- il pannello raccoglieva la sede legale ALTROVE, come stringa libera
-- (`aruba_config.fiscal.sede`), e in una forma che il tracciato non sa leggere.
--
-- COSA FA, ESATTAMENTE. Propone l'anagrafica della cooperativa (gli stessi dati
-- delle fatture già emesse) SOLO alle righe in cui non c'è nessuna anagrafica:
-- né `denominazione` né `piva`. È lo stesso identico predicato del pannello
-- (`SettingsPanel.tsx`, `const vuota = … && !salvata.denominazione && !salvata.piva`),
-- ed è deliberato: **o si propone tutta l'anagrafica, o niente.**
--
-- Fino al 2026-08-10 questa migrazione completava invece CHIAVE PER CHIAVE
-- (`v_cedente || p.config`, con la `where` che scattava se mancava anche una sola
-- chiave). Il commento diceva «non sovrascrive nemmeno un carattere» — vero alla
-- lettera, fuorviante nella sostanza: non sovrascriveva, **aggiungeva dati altrui**.
-- Una sede con `denominazione: 'ALTRA COOPERATIVA'` e il CAP non ancora inserito si
-- sarebbe ritrovata `cap 81030`, `comune Cesa`, `provincia CE` e `numero_civico 7`,
-- cioè la sede di Cesa attaccata a una ragione sociale diversa — su una fattura,
-- che è un documento irreversibile. Il pannello si rifiuta di farlo da luglio; da
-- oggi la migrazione si rifiuta con la stessa regola.
--
-- Sulle righe che qualificano, l'anagrafica proposta VINCE su ciò che c'era
-- (`p.config || v_cedente`), sempre come il pannello, che fa
-- `{ ...salvata, ...CEDENTE_COOPERATIVA }`: se `denominazione` e `piva` mancano
-- entrambe, un `cap` rimasto lì da solo non è «la configurazione di qualcuno», è un
-- residuo — e mescolarlo con l'anagrafica di Cesa è proprio ciò che si vuole evitare.
-- Le chiavi che NON sono anagrafica (`bollo_enabled`, `bollo_soglia`,
-- `bollo_importo`, `dicitura_bollo_ricevuta`) sopravvivono tutte: stanno in
-- `p.config` e `v_cedente` non le nomina.
--
-- COSA NON FA: non tocca il BOLLO. Resta spento finché il commercialista non si
-- pronuncia — attivarlo cambia gli importi delle fatture, e non è una decisione
-- che si prende in una migrazione.
--
-- Idempotente: dopo la prima esecuzione `denominazione` e `piva` ci sono, e la
-- seconda non trova più righe da aggiornare.
-- Additiva e senza rischio sui dati delle famiglie: `admin_settings` non contiene
-- dati personali, e qui si scrivono solo dati societari pubblici (visura).
--
-- La sede fittizia della CI (`e2e00000-…`) resta fuori: non emette fatture.

do $$
declare
  v_cedente jsonb := jsonb_build_object(
    'denominazione', 'SCUOLA DELL''INFANZIA LA FAVOLA SOCIETA'' COOPERATIVA',
    'piva',          '03394870616',
    'codice_fiscale','03394870616',
    'indirizzo',     'Via Silvio Pellico',
    'numero_civico', '7',
    'cap',           '81030',
    'comune',        'Cesa',
    'provincia',     'CE',
    'regime_fiscale','RF01'
  );
  v_righe int;
begin
  with pulita as (
    -- Una chiave salvata come STRINGA VUOTA è "non configurata", non "configurata
    -- a nulla": va tolta, altrimenti una `denominazione: ''` farebbe sembrare
    -- configurata una riga che non lo è, e la sede resterebbe senza anagrafica
    -- esattamente come prima.
    select
      s.scuola_id,
      coalesce(
        (
          select jsonb_object_agg(e.chiave, e.valore)
          from jsonb_each(coalesce(s.fiscale_config, '{}'::jsonb)) as e(chiave, valore)
          where jsonb_typeof(e.valore) <> 'string' or btrim(e.valore #>> '{}') <> ''
        ),
        '{}'::jsonb
      ) as config
    from public.admin_settings s
    where s.scuola_id::text not like 'e2e00000%'
  )
  update public.admin_settings s
     set fiscale_config = p.config || v_cedente
    from pulita p
   where p.scuola_id = s.scuola_id
     -- Solo le righe SENZA anagrafica: chi si è già identificato non si tocca, e
     -- non gli si completa il resto con i dati di un'altra sede.
     -- Scritto con `->>` e non con l'operatore `?&`: il punto interrogativo è
     -- ambiguo per alcuni client SQL, e una migrazione deve poter essere applicata
     -- da qualunque strada (CLI, MCP, psql) senza sorprese.
     and p.config->>'denominazione' is null
     and p.config->>'piva'          is null;

  get diagnostics v_righe = row_count;
  raise notice 'fiscale_config: anagrafica del cedente proposta su % sedi senza anagrafica', v_righe;
end $$;
