'use client';

import { useState } from 'react';
import { isoToIt, itToIso, maskItDate } from '@/lib/format/data';

interface DateFieldProps {
  /** Valore ISO 'yyyy-mm-dd' (o '' se vuoto). */
  value: string;
  /** Chiamato con l'ISO ('' se la data è incompleta/non valida). */
  onChange: (iso: string) => void;
  id?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  'aria-label'?: string;
}

/**
 * Campo data in formato ITALIANO deterministico (gg/mm/aaaa), indipendente dal
 * locale del browser/OS (che sugli `<input type="date">` nativi mostrava
 * mm/dd/yyyy). Input mascherato numerico; espone/riceve sempre ISO 'yyyy-mm-dd'.
 *
 * Nessun setState-in-effect: la sincronizzazione col `value` esterno avviene con
 * il pattern React "adjust state during render" (setState condizionale in render).
 */
export function DateField({
  value,
  onChange,
  placeholder = 'gg/mm/aaaa',
  className,
  ...rest
}: DateFieldProps) {
  const [text, setText] = useState<string>(() => isoToIt(value));
  const [lastValue, setLastValue] = useState<string>(value);

  // Il value è cambiato dall'esterno: riallinea il testo mostrato.
  if (value !== lastValue) {
    setLastValue(value);
    setText(isoToIt(value));
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const masked = maskItDate(e.target.value);
    setText(masked);
    const iso = itToIso(masked);
    // Aggiorna lastValue per non far ri-sovrascrivere il testo durante la digitazione.
    setLastValue(iso ?? '');
    onChange(iso ?? '');
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder={placeholder}
      value={text}
      onChange={handleChange}
      className={className}
    />
  );
}
