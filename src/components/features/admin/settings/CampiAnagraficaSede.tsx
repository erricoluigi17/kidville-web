'use client';

import { useTranslations } from 'next-intl';
import type { AnagraficaSede } from '@/lib/scuole/anagrafica';

/**
 * I campi dell'anagrafica di una sede, in un posto solo.
 *
 * Erano scritti dentro `SchoolsPanel`, in una pagina (`/admin/schools`) che non
 * compare in nessuna voce di menu: ci si arriva soltanto digitando l'URL. Nel
 * frattempo i prestampati rifiutavano di uscire dicendo «aggiungilo nelle
 * impostazioni della sede» — e nelle Impostazioni non c'era niente da aggiungere.
 *
 * Estrarli qui serve a impedire il seguito naturale di quella storia: due form
 * per lo stesso oggetto, in due schermate diverse, che dopo il primo campo nuovo
 * smettono di avere gli stessi campi.
 *
 * `citta` e `indirizzo` sono nella stessa griglia ma NON stanno in
 * `config.anagrafica`: sono colonne di `scuole`, e il PATCH le vuole in cima al
 * body. Per chi compila sono la stessa scheda, e vanno mostrate insieme.
 */
export interface ValoriSede {
  citta: string;
  indirizzo: string;
}

const CLASSE_INPUT =
  'w-full border-2 border-kidville-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-kidville-green';

export function CampiAnagraficaSede({
  anagrafica,
  onAnagrafica,
  sede,
  onSede,
}: {
  anagrafica: AnagraficaSede;
  onAnagrafica: (aggiorna: (prev: AnagraficaSede) => AnagraficaSede) => void;
  sede: ValoriSede;
  onSede: (aggiorna: (prev: ValoriSede) => ValoriSede) => void;
}) {
  const t = useTranslations('adminSettings');
  const aut = anagrafica.autorizzazione_nido ?? {};

  /** Un campo dell'autorizzazione: l'oggetto annidato si riscrive intero. */
  const setAut = (chiave: 'numero' | 'data' | 'comune', valore: string) =>
    onAnagrafica((prev) => ({
      ...prev,
      autorizzazione_nido: { ...(prev.autorizzazione_nido ?? {}), [chiave]: valore },
    }));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <input
          value={anagrafica.denominazione ?? ''}
          onChange={(e) => onAnagrafica((p) => ({ ...p, denominazione: e.target.value }))}
          placeholder={t('scDenominazioneUfficiale')}
          aria-label={t('scDenominazioneUfficiale')}
          className={CLASSE_INPUT}
        />
        <div className="grid grid-cols-2 gap-2">
          <input value={sede.citta} onChange={(e) => onSede((p) => ({ ...p, citta: e.target.value }))} placeholder={t('scCitta')} aria-label={t('scCitta')} className={CLASSE_INPUT} />
          <input value={sede.indirizzo} onChange={(e) => onSede((p) => ({ ...p, indirizzo: e.target.value }))} placeholder={t('scIndirizzo')} aria-label={t('scIndirizzo')} className={CLASSE_INPUT} />
          <input value={anagrafica.cap ?? ''} onChange={(e) => onAnagrafica((p) => ({ ...p, cap: e.target.value }))} placeholder={t('scCap')} aria-label={t('scCap')} className={CLASSE_INPUT} />
          <input value={anagrafica.provincia ?? ''} onChange={(e) => onAnagrafica((p) => ({ ...p, provincia: e.target.value }))} placeholder={t('scProvincia')} aria-label={t('scProvincia')} className={CLASSE_INPUT} />
          <input value={anagrafica.codice_meccanografico ?? ''} onChange={(e) => onAnagrafica((p) => ({ ...p, codice_meccanografico: e.target.value }))} placeholder={t('scCodiceMeccanografico')} aria-label={t('scCodiceMeccanografico')} className={CLASSE_INPUT} />
          <input value={anagrafica.piva_cf ?? ''} onChange={(e) => onAnagrafica((p) => ({ ...p, piva_cf: e.target.value }))} placeholder={t('scPivaCf')} aria-label={t('scPivaCf')} className={CLASSE_INPUT} />
          <input value={anagrafica.telefono ?? ''} onChange={(e) => onAnagrafica((p) => ({ ...p, telefono: e.target.value }))} placeholder={t('scTelefono')} aria-label={t('scTelefono')} className={CLASSE_INPUT} />
          <input value={anagrafica.email ?? ''} onChange={(e) => onAnagrafica((p) => ({ ...p, email: e.target.value }))} placeholder={t('scEmail')} aria-label={t('scEmail')} className={CLASSE_INPUT} />
        </div>
        <input value={anagrafica.pec ?? ''} onChange={(e) => onAnagrafica((p) => ({ ...p, pec: e.target.value }))} placeholder={t('scPec')} aria-label={t('scPec')} className={CLASSE_INPUT} />
      </div>

      {/* Chi firma i documenti della scuola. Senza, i prestampati che si chiudono
          con «IL LEGALE RAPPRESENTANTE» non escono affatto. */}
      <div className="space-y-1.5">
        <label htmlFor="anag-legale" className="font-barlow font-bold text-[11px] text-kidville-sub uppercase tracking-wider">
          {t('scLegaleRappresentante')}
        </label>
        <input
          id="anag-legale"
          value={anagrafica.legale_rappresentante ?? ''}
          onChange={(e) => onAnagrafica((p) => ({ ...p, legale_rappresentante: e.target.value }))}
          placeholder={t('scLegaleRappresentantePlaceholder')}
          className={CLASSE_INPUT}
        />
        <p className="font-maven text-xs text-kidville-sub">{t('scLegaleRappresentanteAiuto')}</p>
      </div>

      {/* Autorizzazione comunale al nido: una per sede, e i tre pezzi servono
          tutti — il certificato per il Bonus INPS non esce se ne manca uno. */}
      <div className="space-y-1.5">
        <p className="font-barlow font-bold text-[11px] text-kidville-sub uppercase tracking-wider">
          {t('scAutorizzazioneNido')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input value={aut.numero ?? ''} onChange={(e) => setAut('numero', e.target.value)} placeholder={t('scAutNumero')} aria-label={t('scAutNumero')} className={CLASSE_INPUT} />
          <input type="date" value={aut.data ?? ''} onChange={(e) => setAut('data', e.target.value)} aria-label={t('scAutData')} className={CLASSE_INPUT} />
          <input value={aut.comune ?? ''} onChange={(e) => setAut('comune', e.target.value)} placeholder={t('scAutComune')} aria-label={t('scAutComune')} className={CLASSE_INPUT} />
        </div>
        <p className="font-maven text-xs text-kidville-sub">{t('scAutorizzazioneNidoAiuto')}</p>
      </div>
    </div>
  );
}
