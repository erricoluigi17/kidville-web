'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { doLogout } from '@/lib/auth/logout';

// Voce "Esci" riutilizzabile per i menu mobile/bottom-sheet (drawer Direzione,
// bottom nav Docente/Genitore). Il container decide lo stile via className; qui
// vivono solo icona + label + la logica di uscita (best-effort, vedi doLogout).

export function LogoutMenuButton({
  className,
  iconSize = 20,
}: {
  className?: string;
  iconSize?: number;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        setBusy(true);
        await doLogout();
      }}
      disabled={busy}
      aria-label="Esci"
      className={className}
    >
      <LogOut size={iconSize} strokeWidth={2.2} className="shrink-0" />
      <span>{busy ? 'Uscita…' : 'Esci'}</span>
    </button>
  );
}
