'use client';

import { useId, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';

// Conferma prima di uscire. «Esci» chiude la sessione (`doLogout` → `auth.signOut()`): un tocco sbagliato
// mentre un foglio scorre per inerzia (successo davvero nel collaudo del 13/11) non deve poterla chiudere.
// Il testo dice «su questo dispositivo» perché la decisione è presa (titolare, 13/11/2026): `doLogout` chiude solo la
// sessione locale (`signOut({ scope: 'local' })`). Se cambiasse, vanno cambiati INSIEME scope e chiave
// `uscitaConfermaTitolo` (it/en in `shared.json`).
// «Annulla» è il PRIMO controllo del dialogo, quindi il predefinito: `Modal` mette il focus sul primo.
// Esc o un tocco fuori chiudono senza uscire (`Modal`). Aree di tocco da 44px.
export function ConfermaUscita({
  open,
  onAnnulla,
  onConferma,
  busy = false,
  returnFocusRef,
}: {
  open: boolean;
  onAnnulla: () => void;
  onConferma: () => void;
  busy?: boolean;
  /** Dove torna il focus alla chiusura: un elemento che RESTA montato (il pulsante che ha aperto il menu o «Esci»). */
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations('shared');
  const titoloId = useId();
  // Senza `document` (render sul server) non c'è dove montare: `open` è comunque falso fino al primo tocco.
  if (typeof document === 'undefined') return null;
  // PORTALE su `document.body`: `Modal` è `fixed`, ma dentro un foglio con `transform`/`translate` (il foglio Menu
  // della segreteria, i bottom sheet di docente e genitore) il foglio diventa il blocco contenitore e il dialogo
  // non copre più lo schermo (nel foglio scorso in fondo finiva fuori vista). In body non eredita transform,
  // overflow né stacking context: sta sopra tutto, come in `z-[120]`. Il comportamento di `Modal` per le altre
  // pagine non cambia.
  return createPortal(
    <Modal open={open} onClose={busy ? () => {} : onAnnulla} title={t('uscitaConfermaTitolo')} labelledBy={titoloId} safeArea returnFocusRef={returnFocusRef}>
      <div className="w-[min(92vw,22rem)] rounded-card bg-kidville-white p-5 shadow-xl">
        <h2 id={titoloId} className="font-barlow text-xl font-extrabold uppercase text-kidville-green">
          {t('uscitaConfermaTitolo')}
        </h2>
        <div className="mt-5 flex flex-col-reverse gap-2 min-[400px]:flex-row min-[400px]:justify-end">
          <button
            type="button"
            onClick={onAnnulla}
            disabled={busy}
            className="min-h-[44px] rounded-pill border border-kidville-line px-5 py-2.5 font-barlow text-sm font-extrabold uppercase text-kidville-green hover:bg-kidville-green-soft disabled:opacity-60"
          >
            {t('uscitaConfermaAnnulla')}
          </button>
          <button
            type="button"
            onClick={onConferma}
            disabled={busy}
            className="min-h-[44px] rounded-pill bg-kidville-error-strong px-5 py-2.5 font-barlow text-sm font-extrabold uppercase text-kidville-white hover:opacity-90 disabled:opacity-60"
          >
            {busy ? t('uscita') : t('esci')}
          </button>
        </div>
      </div>
    </Modal>,
    document.body,
  );
}
