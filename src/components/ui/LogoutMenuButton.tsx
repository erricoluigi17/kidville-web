'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LogOut } from 'lucide-react';
import { doLogout } from '@/lib/auth/logout';
import { ConfermaUscita } from '@/components/ui/ConfermaUscita';

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
  const t = useTranslations('shared');
  const [busy, setBusy] = useState(false);
  // Il tocco su «Esci» NON esce più: apre la conferma (vedi `ConfermaUscita`). Esce solo il secondo tocco.
  const [conferma, setConferma] = useState(false);
  // Safari/iOS non dà il focus a un `<button>` al tocco: senza questo, dopo «Annulla» il focus finirebbe su <body>.
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConferma(true)}
        disabled={busy}
        aria-label={t('esci')}
        aria-haspopup="dialog"
        className={className}
      >
        <LogOut size={iconSize} strokeWidth={2.2} className="shrink-0" />
        <span>{busy ? t('uscita') : t('esci')}</span>
      </button>
      <ConfermaUscita
        open={conferma}
        busy={busy}
        returnFocusRef={triggerRef}
        onAnnulla={() => setConferma(false)}
        onConferma={async () => {
          setBusy(true);
          await doLogout();
        }}
      />
    </>
  );
}
