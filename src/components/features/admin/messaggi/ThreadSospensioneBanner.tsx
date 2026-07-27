'use client';

import { useTranslations } from 'next-intl';
import { Loader2, PauseCircle, RotateCcw } from 'lucide-react';

// =============================================================================
// Banner di sospensione nella supervisione chat (C5 §2).
//
// Rende visibile lo stato "dichiarato" di una conversazione sospesa nella vista
// di supervisione della Direzione. Il bottone «Riapri» compare SOLO quando la
// conversazione è sospesa E il lettore è Direzione (`canReopen`): il gate vero
// resta comunque nella route POST /api/chat/threads/[id]/riapri.
//
// Il `motivo` è mostrato in chiaro: questa è la vista interna della Direzione,
// non un log. Se la conversazione non è sospesa il componente non rende nulla.
// =============================================================================

export interface SospensioneInfo {
  sospesaIl: string;
  motivo: string | null;
}

export function ThreadSospensioneBanner({
  sospensione,
  canReopen,
  onRiapri,
  busy = false,
}: {
  sospensione: SospensioneInfo | null;
  canReopen: boolean;
  onRiapri: () => void;
  busy?: boolean;
}) {
  const t = useTranslations('adminComunicazioni');
  if (!sospensione) return null;

  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3 rounded-xl border border-kidville-warn/30 bg-kidville-warn-soft p-3">
      <div className="flex items-start gap-2">
        <PauseCircle size={18} className="mt-0.5 shrink-0 text-kidville-warn" />
        <div>
          <p className="font-maven text-[13px] font-semibold text-kidville-ink">{t('messaggiSospesaBanner')}</p>
          {sospensione.motivo?.trim() && (
            <p className="font-maven text-[12px] text-kidville-ink/70">
              {t('messaggiSospesaMotivo', { motivo: sospensione.motivo })}
            </p>
          )}
        </div>
      </div>
      {canReopen && (
        <button
          onClick={onRiapri}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-white hover:bg-kidville-green-dark disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
          {busy ? t('messaggiRiapriInCorso') : t('messaggiRiapri')}
        </button>
      )}
    </div>
  );
}
