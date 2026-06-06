'use client';

import { ALLERGENI } from '@/lib/mensa/allergeni';

// Selettore degli allergeni strutturati (14 allergeni UE) di un alunno.
// Usato in anagrafica accanto al testo libero `allergies`. Il valore è una
// lista di chiavi canoniche, confrontata col menu mensa per gli alert.
export function AllergeniSelect({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (k: string) => {
    onChange(value.includes(k) ? value.filter(x => x !== k) : [...value, k]);
  };
  return (
    <div>
      <p className="font-maven text-xs text-gray-500 mb-1.5">Allergeni (per match automatico col menu mensa)</p>
      <div className="flex flex-wrap gap-1.5">
        {ALLERGENI.map(a => {
          const on = value.includes(a.key);
          return (
            <button key={a.key} type="button" onClick={() => toggle(a.key)} title={a.label}
              className={`px-2.5 py-1 rounded-full font-maven text-[11px] font-bold border-2 transition-colors ${on ? 'bg-red-500 text-white border-red-500' : 'bg-white text-gray-400 border-gray-200'}`}>
              {a.emoji} {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
