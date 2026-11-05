'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { oggiRoma } from '@/lib/storici/retroattivita';

/**
 * «Data della prova» di un voto o di un impreparato della primaria.
 *
 * La docente registra oggi l'interrogazione di venerdì con la data di venerdì: il campo parte
 * da oggi, vale per tutte, e NON può superare il giorno di ROMA (`max`). Il server rifiuta
 * comunque una data futura (`DATA_FUTURA`): il `max` evita solo di arrivarci dal telefono.
 *
 * L'avviso «una giornata passata non manda avvisi alla famiglia» è dello staff
 * (`avvisoStorico`) e solo per un giorno passato: per la docente, che registra con la sua data,
 * non si dice niente.
 */
export function DataVoce({ valore, onCambia, avvisoStorico = false, id }: {
  valore: string;
  onCambia: (d: string) => void;
  avvisoStorico?: boolean;
  id?: string;
}) {
  const t = useTranslations('teacherPrimaria');
  const generato = useId();
  const campo = id ?? `${generato}-data`;
  const oggi = oggiRoma();
  return (
    <div>
      <label htmlFor={campo} className="block font-maven text-xs text-kidville-sub">
        {t('valutazioniDataProvaLabel')}
      </label>
      <input
        id={campo}
        type="date"
        required
        max={oggi}
        value={valore}
        // Un campo svuotato non cancella la data: il voto ne ha sempre una.
        onChange={(e) => { if (e.target.value) onCambia(e.target.value); }}
        className="font-maven mt-1 block min-h-11 w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
      />
      {avvisoStorico && valore < oggi && (
        <p role="status" className="mt-1 font-maven text-xs text-kidville-sub">{t('storicoSenzaAvvisiFamiglia')}</p>
      )}
    </div>
  );
}
