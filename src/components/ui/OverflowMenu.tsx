'use client';

import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

// Menu generico a tre puntini (⋮). Trigger accessibile (aria-haspopup="menu",
// aria-expanded), chiusura con Escape e click-fuori. I `children` sono le voci
// del menu (tipicamente `<button role="menuitem">…`), lasciate al chiamante: il
// componente è puramente il contenitore/affordance, non conosce le azioni.
//
// A11y: il pannello ha role="menu" e un'etichetta accessibile; cliccare una voce
// chiude il menu (delega sul contenitore), coerente col comportamento atteso di
// un menu di azioni.

interface OverflowMenuProps {
  /** Etichetta accessibile del trigger (aria-label) e del pannello. */
  label: string;
  /** Allineamento del pannello rispetto al trigger. */
  align?: 'left' | 'right';
  /** Classe extra sul contenitore relativo (posizionamento). */
  className?: string;
  /** Sovrascrive lo stile del bottone trigger (es. contrasto su header verde). */
  triggerClassName?: string;
  children: React.ReactNode;
}

const TRIGGER_DEFAULT =
  'flex h-8 w-8 items-center justify-center rounded-full text-kidville-muted transition-colors hover:bg-kidville-neutral-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-kidville-yellow';

export function OverflowMenu({ label, align = 'right', className, triggerClassName, children }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className={triggerClassName ?? TRIGGER_DEFAULT}
      >
        <MoreVertical size={18} strokeWidth={2} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          onClick={() => setOpen(false)}
          className={`absolute top-[calc(100%+6px)] z-50 min-w-44 overflow-hidden rounded-2xl border border-kidville-line bg-white py-1 shadow-2xl ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
