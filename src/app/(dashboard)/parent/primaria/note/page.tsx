'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { Check } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';

interface Nota {
  id: string; categoria: string; testo: string;
  richiede_firma: boolean; firmata_il: string | null; creato_il: string;
}

const CATEGORIE: Record<string, { labelKey: string; cls: string }> = {
  disciplinare: { labelKey: 'noteCat_disciplinare', cls: 'bg-kidville-error-soft text-kidville-error' },
  didattica: { labelKey: 'noteCat_didattica', cls: 'bg-kidville-info-soft text-kidville-info' },
  compiti_non_svolti: { labelKey: 'noteCat_compiti_non_svolti', cls: 'bg-kidville-warn-soft text-kidville-warn' },
};

function NoteGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const t = useTranslations('parentPrimaria');
  const f = useDateFormat();
  const [note, setNote] = useState<Nota[]>([]);
  const [loading, setLoading] = useState(true);
  const [firmando, setFirmando] = useState<string | null>(null);
  const [otpState, setOtpState] = useState<{ ticket: string; expiry: number; devCode?: string } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpTarget, setOtpTarget] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const carica = useCallback(async () => {
    if (!ready || !parentId || !studentId) return;
    try {
      const r = await fetch(`/api/parent/primaria/note?studentId=${studentId}&userId=${parentId}`, {
        headers: { 'x-user-id': parentId },
      });
      const d = await r.json();
      if (d.success) setNote(d.data);
    } finally {
      setLoading(false);
    }
  }, [ready, studentId, parentId]);

  useEffect(() => { carica(); }, [carica]);

  // Presa visione con firma OTP/FES (DL-014): invio codice → conferma → firma.
  const avviaFirma = async (notaId: string) => {
    if (!parentId) return;
    setMsg(''); setOtpTarget(notaId); setOtpCode('');
    const r = await fetch(`/api/parent/primaria/note/firma/otp?userId=${parentId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    // Niente prosa del server: è italiana per costruzione (T10-F1).
    if (!r.ok) { setMsg(soloCatalogoDaCorpo(d, t('noteErroreOtp'))); setOtpTarget(null); return; }
    setOtpState(d.data);
  };

  const confermaFirma = async () => {
    if (!otpTarget || !otpState || !parentId) return;
    setFirmando(otpTarget);
    const r = await fetch(`/api/parent/primaria/note/firma?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ notaId: otpTarget, code: otpCode, expiry: otpState.expiry, ticket: otpState.ticket }),
    });
    const d = await r.json();
    setFirmando(null);
    if (!r.ok) { setMsg(soloCatalogoDaCorpo(d, t('noteFirmaNonRiuscita'))); return; }
    setOtpState(null); setOtpCode(''); setOtpTarget(null);
    setMsg(t('noteFirmata'));
    carica();
  };

  const inAttesa = note.filter((n) => n.richiede_firma && !n.firmata_il);

  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard eyebrow={t('eyebrow')} title={t('noteTitolo')} subtitle={t('noteSottotitolo')} className="mb-4" />

      {loading ? (
        <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>
      ) : note.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{t('noteVuoto')}</p>
      ) : (
        <div className="space-y-3">
          {msg && <p className={`font-maven text-sm rounded-2xl px-4 py-2 ${msg.includes('✓') ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-error-soft text-kidville-error'}`}>{msg}</p>}
          {inAttesa.length > 0 && (
            <div className="rounded-2xl bg-kidville-warn-soft border border-kidville-warn/30 px-4 py-3">
              <p className="font-maven text-sm font-semibold text-kidville-warn">
                {t('noteInAttesaBanner', { count: inAttesa.length })}
              </p>
            </div>
          )}
          {note.map((n) => {
            const meta = CATEGORIE[n.categoria];
            const catLabel = meta ? t(meta.labelKey) : n.categoria;
            const catCls = meta ? meta.cls : 'bg-kidville-neutral-soft text-kidville-muted';
            return (
              <div key={n.id} className="rounded-card border border-kidville-line bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-maven font-semibold ${catCls}`}>{catLabel}</span>
                  <span className="font-maven text-xs text-kidville-muted">
                    {f.dataBreve(n.creato_il)}
                  </span>
                  {n.richiede_firma && (
                    n.firmata_il
                      ? <span className="font-maven text-xs text-kidville-success flex items-center gap-1"><Check size={11} /> {t('firmata')}</span>
                      : <span className="font-maven text-xs text-kidville-warn">{t('noteInAttesaFirma')}</span>
                  )}
                </div>
                <p className="font-maven text-sm text-kidville-ink">{n.testo}</p>
                {n.richiede_firma && !n.firmata_il && otpTarget !== n.id && (
                  <Btn variant="primary" size="sm" onClick={() => avviaFirma(n.id)} className="mt-3">
                    <Check size={14} /> {t('noteFirmaPresaVisione')}
                  </Btn>
                )}

                {/* Conferma OTP/FES inline */}
                {otpTarget === n.id && otpState && (
                  <div className="mt-3 border-t border-kidville-line pt-3 space-y-2">
                    <p className="font-maven text-sm text-kidville-muted">{t('otpIstruzione')}</p>
                    {otpState.devCode && (
                      <p className="font-maven text-xs text-kidville-warn">{t('devLabel')} <b>{otpState.devCode}</b></p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text" value={otpCode} onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="000000"
                        className="font-maven rounded-full border border-kidville-line px-3 py-1.5 text-sm w-28 text-center tracking-widest"
                      />
                      <Btn
                        variant="primary"
                        size="sm"
                        onClick={confermaFirma}
                        disabled={firmando === n.id || !otpCode}
                      >
                        {firmando === n.id ? t('firmando') : t('conferma')}
                      </Btn>
                      <button onClick={() => { setOtpTarget(null); setOtpState(null); setOtpCode(''); }}
                        className="font-maven text-xs text-kidville-muted">{t('annulla')}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function NoteGenitorePage() {
  const t = useTranslations('parentPrimaria');
  return (
    <Suspense fallback={<div className="px-4 pt-5 pb-24 font-maven text-kidville-muted">{t('caricamento')}</div>}>
      <NoteGenitore />
    </Suspense>
  );
}
