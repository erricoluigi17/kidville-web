'use client';

import { useState } from 'react';
import { Ban, RotateCcw } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import type { SospensioneInfo } from '@/components/features/chat/ChatThreadList';

// =============================================================================
// ChatSuspensionBanner (C5 §2) — banner di stato "conversazione sospesa".
// Dichiarato (non silenzioso):
//  · chi HA sospeso vede "Hai sospeso questa conversazione" + "Riapri";
//  · chi è sospesa_verso vede "Conversazione sospesa" e NESSUN "Riapri"
//    (riaprire spetta solo al sospendente o alla Direzione, da Moderazione).
// Il `motivo` è mostrato SOLO a chi ha sospeso (la GET lo azzera per l'altro).
// =============================================================================

type Tfn = (key: string, values?: Record<string, string | number>) => string;

export interface ChatSuspensionBannerProps {
  t: Tfn;
  currentUserId: string;
  threadId: string;
  sospensione: SospensioneInfo;
  /** Chiamato dopo una riapertura andata a buon fine. */
  onReopened: () => void;
}

export function ChatSuspensionBanner({ t, currentUserId, threadId, sospensione, onReopened }: ChatSuspensionBannerProps) {
  const [reopening, setReopening] = useState(false);
  const [error, setError] = useState(false);
  const iSuspended = sospensione.sospesaDa === currentUserId;

  const riapri = async () => {
    setReopening(true);
    setError(false);
    try {
      const res = await fetch(`/api/chat/threads/${threadId}/riapri`, { method: 'POST' });
      if (res.ok) {
        onReopened();
        return;
      }
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'chat-riapri-fallito', route: '/chat/riapri' });
      setError(true);
    } catch {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'chat-riapri-eccezione', route: '/chat/riapri' });
      setError(true);
    } finally {
      setReopening(false);
    }
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 border-b border-kidville-warn/40 bg-kidville-warn-soft px-4 py-3"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kidville-warn/15 text-kidville-warn">
        <Ban size={17} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-warn-dark">
          {iSuspended ? t('ugcBannerISuspendedTitle') : t('ugcBannerSuspendedTitle')}
        </p>
        <p className="font-maven text-xs text-kidville-warn-dark/80">
          {iSuspended ? t('ugcBannerISuspendedBody') : t('ugcBannerSuspendedBody')}
        </p>
        {iSuspended && sospensione.motivo && (
          <p className="mt-0.5 font-maven text-xs italic text-kidville-warn-dark/70">
            {t('ugcBannerMotivo', { motivo: sospensione.motivo })}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 font-maven text-xs text-kidville-error">{t('ugcReopenError')}</p>
        )}
      </div>
      {iSuspended && (
        <button
          type="button"
          onClick={riapri}
          disabled={reopening}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-kidville-green px-4 py-2 font-barlow text-xs font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green-dark disabled:opacity-60"
        >
          <RotateCcw size={14} strokeWidth={2.4} />
          {reopening ? t('ugcReopening') : t('ugcReopen')}
        </button>
      )}
    </div>
  );
}
