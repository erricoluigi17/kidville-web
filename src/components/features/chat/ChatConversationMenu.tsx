'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Flag, UserX, Ban } from 'lucide-react';
import { OverflowMenu } from '@/components/ui/OverflowMenu';
import { Modal } from '@/components/ui/Modal';
import { logClient } from '@/lib/logging/client';
import type { SospensioneInfo } from '@/components/features/chat/ChatThreadList';

// =============================================================================
// ChatConversationMenu (C5 §2) — menu ⋮ dell'header di una conversazione 1:1.
// Tre voci ETICHETTATE (mai solo icona): segnala messaggio, segnala utente,
// sospendi conversazione. I dialoghi (segnalazione / sospensione) vivono FUORI
// dall'OverflowMenu: il menu si chiude al clic sulla voce, ma il modal resta
// montato perché è un fratello, non un figlio del menu.
//
// PRIVACY: il body della segnalazione porta solo id + categoria + motivo; il
// motivo è testo libero e NON finisce mai nei log (si logga generico su errore).
// Il motivo della sospensione va solo nel body del POST, mai nei log del client.
// =============================================================================

type Tfn = (key: string, values?: Record<string, string | number>) => string;

const CATEGORIE = [
  'contenuto_inappropriato',
  'molestie_bullismo',
  'informazione_falsa',
  'spam',
  'altro',
] as const;
type Categoria = (typeof CATEGORIE)[number];

export interface ChatConversationMenuProps {
  /** Traduzioni del contesto (parentChat / teacherComunicazioni). */
  t: Tfn;
  currentUserId: string;
  threadId: string;
  /** L'altro partecipante (per "Segnala utente"). */
  controparteId: string;
  /** Ultimo messaggio in ARRIVO (per "Segnala messaggio"); null = niente da segnalare. */
  lastIncomingMessageId: string | null;
  /** Conversazione già sospesa: nasconde la voce "Sospendi". */
  isSuspended: boolean;
  /** Chiamato dopo una sospensione andata a buon fine, con lo stato nuovo. */
  onSuspended: (s: SospensioneInfo) => void;
  /** Stile del trigger ⋮ (contrasto su header verde vs chiaro). */
  triggerClassName?: string;
}

export function ChatConversationMenu({
  t,
  currentUserId,
  threadId,
  controparteId,
  lastIncomingMessageId,
  isSuspended,
  onSuspended,
  triggerClassName,
}: ChatConversationMenuProps) {
  const s = useTranslations('shared');

  // Dialog segnalazione: 'messaggio' | 'utente' | null
  const [reportMode, setReportMode] = useState<'messaggio' | 'utente' | null>(null);
  const [categoria, setCategoria] = useState<Categoria>('contenuto_inappropriato');
  const [reportNote, setReportNote] = useState('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportError, setReportError] = useState(false);
  const [reportDone, setReportDone] = useState(false);

  // Dialog sospensione
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendMotivo, setSuspendMotivo] = useState('');
  const [suspendSubmitting, setSuspendSubmitting] = useState(false);
  const [suspendError, setSuspendError] = useState<'generico' | 'gia' | null>(null);

  const resetReport = () => {
    setReportMode(null);
    setCategoria('contenuto_inappropriato');
    setReportNote('');
    setReportSubmitting(false);
    setReportError(false);
    setReportDone(false);
  };

  const inviaSegnalazione = async () => {
    setReportSubmitting(true);
    setReportError(false);
    const body =
      reportMode === 'utente'
        ? { tipo_oggetto: 'utente', segnalato_id: controparteId, categoria }
        : { tipo_oggetto: 'messaggio_chat', oggetto_id: lastIncomingMessageId, thread_id: threadId, categoria };
    try {
      const res = await fetch('/api/segnalazioni', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ...(reportNote.trim() ? { motivo: reportNote.trim() } : {}) }),
      });
      if (!res.ok) {
        // Mai il motivo nei log (dati di minori): messaggio generico.
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'chat-segnalazione-invio-fallito', route: '/segnalazioni' });
        setReportError(true);
        return;
      }
      setReportDone(true);
    } catch {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'chat-segnalazione-invio-eccezione', route: '/segnalazioni' });
      setReportError(true);
    } finally {
      setReportSubmitting(false);
    }
  };

  const resetSuspend = () => {
    setSuspendOpen(false);
    setSuspendMotivo('');
    setSuspendSubmitting(false);
    setSuspendError(null);
  };

  const inviaSospensione = async () => {
    setSuspendSubmitting(true);
    setSuspendError(null);
    try {
      const res = await fetch(`/api/chat/threads/${threadId}/sospendi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(suspendMotivo.trim() ? { motivo: suspendMotivo.trim() } : {}),
      });
      if (res.ok) {
        onSuspended({
          sospesaDa: currentUserId,
          sospesaVerso: controparteId,
          // Solo l'autore vede il proprio motivo (coerente con la GET).
          motivo: suspendMotivo.trim() || null,
          sospesaIl: new Date().toISOString(),
        });
        resetSuspend();
        return;
      }
      if (res.status === 409) {
        setSuspendError('gia');
        return;
      }
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'chat-sospendi-fallito', route: '/chat/sospendi' });
      setSuspendError('generico');
    } catch {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'chat-sospendi-eccezione', route: '/chat/sospendi' });
      setSuspendError('generico');
    } finally {
      setSuspendSubmitting(false);
    }
  };

  const voceClass =
    'flex w-full items-center gap-2.5 px-4 py-2.5 font-maven text-sm font-semibold text-kidville-ink transition-colors hover:bg-kidville-green-soft';

  return (
    <>
      <OverflowMenu label={t('ugcMenuLabel')} triggerClassName={triggerClassName}>
        {lastIncomingMessageId && (
          <button type="button" role="menuitem" onClick={() => setReportMode('messaggio')} className={voceClass}>
            <Flag size={16} strokeWidth={2.2} />
            {t('ugcReportMessage')}
          </button>
        )}
        <button type="button" role="menuitem" onClick={() => setReportMode('utente')} className={voceClass}>
          <UserX size={16} strokeWidth={2.2} />
          {t('ugcReportUser')}
        </button>
        {!isSuspended && (
          <button
            type="button"
            role="menuitem"
            onClick={() => setSuspendOpen(true)}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 font-maven text-sm font-semibold text-kidville-error transition-colors hover:bg-kidville-error-soft"
          >
            <Ban size={16} strokeWidth={2.2} />
            {t('ugcSuspend')}
          </button>
        )}
      </OverflowMenu>

      {/* Dialog segnalazione (messaggio o utente) */}
      <Modal
        open={reportMode !== null}
        onClose={resetReport}
        title={reportMode === 'utente' ? t('ugcReportUserTitle') : t('ugcReportMessageTitle')}
        className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"
      >
        {reportDone ? (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-kidville-success-soft text-2xl">✅</div>
            <h2 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">{s('segnalaSuccessoTitolo')}</h2>
            <p className="mt-1 font-maven text-sm text-kidville-muted">{s('segnalaSuccessoCorpo')}</p>
            <button
              type="button"
              onClick={resetReport}
              className="mt-5 w-full rounded-full bg-kidville-green py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green/90"
            >
              {s('segnalaChiudi')}
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-kidville-warn-soft text-kidville-warn">
                <Flag size={18} strokeWidth={2.5} />
              </span>
              <div>
                <h2 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">
                  {reportMode === 'utente' ? t('ugcReportUserTitle') : t('ugcReportMessageTitle')}
                </h2>
                <p className="mt-0.5 font-maven text-xs text-kidville-muted">{s('segnalaSottotitolo')}</p>
              </div>
            </div>

            <fieldset className="mb-4">
              <legend className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-ink">{s('segnalaCategoriaLabel')}</legend>
              <div className="space-y-1.5">
                {CATEGORIE.map((c) => (
                  <label
                    key={c}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 font-maven text-sm transition-colors ${
                      categoria === c
                        ? 'border-kidville-green bg-kidville-green-soft text-kidville-green font-semibold'
                        : 'border-kidville-line text-kidville-ink hover:bg-kidville-neutral-soft'
                    }`}
                  >
                    <input
                      type="radio"
                      name="chat-segnala-categoria"
                      value={c}
                      checked={categoria === c}
                      onChange={() => setCategoria(c)}
                      className="accent-kidville-green"
                    />
                    <span>{s(`segnalaCat_${c}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="mb-4 block">
              <span className="mb-1.5 block font-barlow text-xs font-bold uppercase tracking-wide text-kidville-ink">{s('segnalaNoteLabel')}</span>
              <textarea
                value={reportNote}
                onChange={(e) => setReportNote(e.target.value)}
                maxLength={1000}
                rows={3}
                placeholder={s('segnalaNotePlaceholder')}
                className="w-full resize-none rounded-xl border border-kidville-line bg-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/20"
              />
            </label>

            {reportError && (
              <p role="alert" className="mb-3 rounded-xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error">{s('segnalaErrore')}</p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={resetReport}
                disabled={reportSubmitting}
                className="rounded-full px-4 py-2 font-maven text-sm font-semibold text-kidville-muted transition-colors hover:bg-kidville-neutral-soft disabled:opacity-60"
              >
                {s('segnalaAnnulla')}
              </button>
              <button
                type="button"
                onClick={inviaSegnalazione}
                disabled={reportSubmitting}
                className="flex items-center gap-2 rounded-full bg-kidville-green px-5 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-green/90 disabled:opacity-60"
              >
                <Flag size={14} strokeWidth={2.5} />
                {reportSubmitting ? s('segnalaInvio') : s('segnalaInvia')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Dialog sospensione */}
      <Modal
        open={suspendOpen}
        onClose={resetSuspend}
        title={t('ugcSuspendTitle')}
        className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"
      >
        <div>
          <div className="mb-4 flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-kidville-error-soft text-kidville-error">
              <Ban size={18} strokeWidth={2.5} />
            </span>
            <div>
              <h2 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">{t('ugcSuspendTitle')}</h2>
              <p className="mt-0.5 font-maven text-xs text-kidville-muted">{t('ugcSuspendExplain')}</p>
            </div>
          </div>

          <label className="mb-4 block">
            <span className="mb-1.5 block font-barlow text-xs font-bold uppercase tracking-wide text-kidville-ink">{t('ugcSuspendMotivoLabel')}</span>
            <textarea
              value={suspendMotivo}
              onChange={(e) => setSuspendMotivo(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder={t('ugcSuspendMotivoPlaceholder')}
              className="w-full resize-none rounded-xl border border-kidville-line bg-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/20"
            />
          </label>

          {suspendError && (
            <p role="alert" className="mb-3 rounded-xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error">
              {suspendError === 'gia' ? t('ugcSuspendAlready') : t('ugcSuspendError')}
            </p>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={resetSuspend}
              disabled={suspendSubmitting}
              className="rounded-full px-4 py-2 font-maven text-sm font-semibold text-kidville-muted transition-colors hover:bg-kidville-neutral-soft disabled:opacity-60"
            >
              {t('ugcSuspendCancel')}
            </button>
            <button
              type="button"
              onClick={inviaSospensione}
              disabled={suspendSubmitting}
              className="flex items-center gap-2 rounded-full bg-kidville-error px-5 py-2.5 font-barlow text-sm font-bold uppercase tracking-wide text-white transition-colors hover:bg-kidville-error/90 disabled:opacity-60"
            >
              <Ban size={14} strokeWidth={2.5} />
              {suspendSubmitting ? t('ugcSuspendSending') : t('ugcSuspendConfirm')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
