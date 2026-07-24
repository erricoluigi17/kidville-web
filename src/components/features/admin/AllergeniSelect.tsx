'use client';

import { useTranslations } from 'next-intl';
import { ALLERGENI, useAllergeneLabel } from '@/lib/mensa/allergeni';

// Selettore degli allergeni strutturati (14 allergeni UE) di un alunno.
// Usato in anagrafica accanto al testo libero `allergies`. Il valore è una
// lista di chiavi canoniche, confrontata col menu mensa per gli alert.
export function AllergeniSelect({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const t = useTranslations('adminStudents');
  const allergeneLabel = useAllergeneLabel();
  const toggle = (k: string) => {
    onChange(value.includes(k) ? value.filter(x => x !== k) : [...value, k]);
  };
  return (
    <div>
      <p className="font-maven text-xs text-kidville-muted mb-1.5">{t('allergSelectLabel')}</p>
      <div className="flex flex-wrap gap-1.5">
        {ALLERGENI.map(a => {
          const on = value.includes(a.key);
          return (
            <button key={a.key} type="button" onClick={() => toggle(a.key)} title={allergeneLabel(a.key)}
              className={`px-2.5 py-1 rounded-full font-maven text-[11px] font-bold border-2 transition-colors ${on ? 'bg-kidville-error text-white border-kidville-error' : 'bg-white text-kidville-muted border-kidville-line'}`}>
              {a.emoji} {allergeneLabel(a.key)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
