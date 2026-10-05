'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { METODI_AMMESSI, type MetodoAmmesso } from '@/lib/pagamenti/metodi-ammessi';

/**
 * Le due caselle «Contanti / Bonifico». Controllato: lo stato lo tiene il
 * chiamante. Zero caselle è uno stato raggiungibile (l'utente le toglie
 * entrambe) e si DICE con un messaggio collegato al gruppo, invece di
 * impedirlo in silenzio: chi salva vede perché non può.
 */
export function ScegliMetodiAmmessi({
  valore, onChange, disabled,
}: {
  valore: MetodoAmmesso[];
  onChange: (v: MetodoAmmesso[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('adminContabilita');
  const id = useId();
  const vuoto = valore.length === 0;
  const etichetta: Record<MetodoAmmesso, string> = {
    contanti: t('metodiAmmessiContanti'),
    bonifico: t('metodiAmmessiBonifico'),
  };
  const cambia = (m: MetodoAmmesso, on: boolean) => {
    const set = new Set(valore);
    if (on) set.add(m); else set.delete(m);
    // L'ordine è sempre quello canonico: il chiamante confronta i valori come stringa.
    onChange(METODI_AMMESSI.filter((x) => set.has(x)));
  };
  return (
    <fieldset aria-describedby={`${id}-aiuto${vuoto ? ` ${id}-errore` : ''}`} className="space-y-1">
      <legend className="font-maven text-xs text-kidville-muted mb-1">{t('metodiAmmessiLegenda')}</legend>
      <div className="flex flex-wrap gap-4">
        {METODI_AMMESSI.map((m) => (
          <label key={m} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={valore.includes(m)}
              disabled={disabled}
              onChange={(e) => cambia(m, e.target.checked)}
              className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green"
            />
            <span className="font-maven text-xs text-kidville-green">{etichetta[m]}</span>
          </label>
        ))}
      </div>
      <p id={`${id}-aiuto`} className="font-maven text-[11px] text-kidville-muted">{t('metodiAmmessiAiuto')}</p>
      {vuoto && (
        <p id={`${id}-errore`} role="alert" className="font-maven text-xs text-kidville-error-strong">
          {t('metodiAmmessiAlmenoUno')}
        </p>
      )}
    </fieldset>
  );
}
