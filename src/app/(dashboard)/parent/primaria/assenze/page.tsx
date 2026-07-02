'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { CheckSquare, AlertCircle, Check } from 'lucide-react';

interface Presenza {
  id: string; data: string; stato: string;
  orario_entrata: string | null; orario_uscita: string | null;
  giustificata: boolean; giustificazione_testo: string | null;
  giustificata_il: string | null; note_appello: string | null;
}

const STATO_LABEL: Record<string, { label: string; cls: string }> = {
  assente: { label: 'Assente', cls: 'bg-kidville-error-soft text-kidville-error' },
  ritardo: { label: 'Ritardo', cls: 'bg-kidville-warn-soft text-kidville-warn' },
  uscita_anticipata: { label: 'Uscita anticipata', cls: 'bg-kidville-info-soft text-kidville-info' },
};

function oraDaTs(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function AssenzeGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [presenze, setPresenze] = useState<Presenza[]>([]);
  const [loading, setLoading] = useState(true);

  // Flusso giustifica con OTP/FES (backend esistente: /giustifica/otp + /giustifica).
  const [otpState, setOtpState] = useState<{ ticket: string; expiry: number; devCode?: string } | null>(null);
  const [otpTarget, setOtpTarget] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [motivo, setMotivo] = useState('');
  const [firmando, setFirmando] = useState(false);
  const [msg, setMsg] = useState('');

  const carica = useCallback(() => {
    if (!ready || !parentId || !studentId) return;
    fetch(`/api/parent/primaria/assenze?studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) setPresenze(d.data); })
      .finally(() => setLoading(false));
  }, [ready, studentId, parentId]);

  useEffect(() => { carica(); }, [carica]);

  const avviaGiustifica = async (presenzaId: string) => {
    if (!parentId) return;
    setMsg(''); setOtpTarget(presenzaId); setOtpCode(''); setMotivo('');
    const r = await fetch(`/api/parent/presenze/giustifica/otp?userId=${parentId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error || 'Errore invio OTP'); setOtpTarget(null); return; }
    setOtpState(d.data);
  };

  const confermaGiustifica = async (p: Presenza) => {
    if (!otpState || !parentId) return;
    setFirmando(true);
    const r = await fetch(`/api/parent/presenze/giustifica?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ studentId, data: p.data, motivo, code: otpCode, expiry: otpState.expiry, ticket: otpState.ticket }),
    });
    const d = await r.json();
    setFirmando(false);
    if (!r.ok) { setMsg(d.error || 'Giustifica non riuscita'); return; }
    setOtpState(null); setOtpCode(''); setOtpTarget(null); setMotivo('');
    setMsg('Assenza giustificata ✓');
    carica();
  };

  const annulla = () => { setOtpTarget(null); setOtpState(null); setOtpCode(''); setMotivo(''); };

  const nonGiustificate = presenze.filter((p) => !p.giustificata);

  return (
    <div className="px-4 pt-6 pb-24">
      <h1 className="font-barlow text-xl font-black text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2">
        <CheckSquare size={20} /> Presenze
      </h1>

      {loading ? (
        <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>
      ) : presenze.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">Nessuna assenza registrata.</p>
      ) : (
        <div className="space-y-3">
          {msg && (
            <p className={`font-maven text-sm rounded-2xl px-4 py-2 ${msg.includes('✓') ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-error-soft text-kidville-error'}`}>{msg}</p>
          )}
          {nonGiustificate.length > 0 && (
            <div className="rounded-2xl bg-kidville-warn-soft border border-kidville-warn/30 px-4 py-3 flex items-center gap-2">
              <AlertCircle size={16} className="text-kidville-warn shrink-0" />
              <p className="font-maven text-sm text-kidville-warn">
                {nonGiustificate.length} assenza{nonGiustificate.length > 1 ? '/e non ancora giustificate' : ' non ancora giustificata'}
              </p>
            </div>
          )}

          {presenze.map((p) => {
            const s = STATO_LABEL[p.stato] ?? { label: p.stato, cls: 'bg-kidville-neutral-soft text-kidville-muted' };
            return (
              <div key={p.id} className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-maven font-semibold ${s.cls}`}>{s.label}</span>
                    <span className="font-maven text-sm font-semibold text-kidville-ink">
                      {new Date(p.data).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                  <span className={`font-maven text-xs ${p.giustificata ? 'text-kidville-success' : 'text-kidville-warn'}`}>
                    {p.giustificata ? '✓ Giustificata' : 'Da giustificare'}
                  </span>
                </div>

                {(p.stato === 'ritardo' && p.orario_entrata) && (
                  <p className="font-maven text-xs text-kidville-muted">Entrata: {oraDaTs(p.orario_entrata)}</p>
                )}
                {(p.stato === 'uscita_anticipata' && p.orario_uscita) && (
                  <p className="font-maven text-xs text-kidville-muted">Uscita: {oraDaTs(p.orario_uscita)}</p>
                )}
                {p.giustificazione_testo && (
                  <p className="font-maven text-xs text-kidville-muted mt-1 italic">&ldquo;{p.giustificazione_testo}&rdquo;</p>
                )}
                {p.note_appello && (
                  <p className="font-maven text-xs text-kidville-muted mt-0.5">Nota docente: {p.note_appello}</p>
                )}

                {/* Azione giustifica (backend esistente con OTP) */}
                {!p.giustificata && otpTarget !== p.id && (
                  <button
                    onClick={() => avviaGiustifica(p.id)}
                    className="mt-3 font-maven inline-flex items-center gap-1.5 rounded-full bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
                  >
                    <Check size={14} /> Giustifica
                  </button>
                )}

                {/* Conferma OTP/FES inline */}
                {otpTarget === p.id && otpState && (
                  <div className="mt-3 border-t border-kidville-line pt-3 space-y-2">
                    <textarea
                      value={motivo} onChange={(e) => setMotivo(e.target.value)}
                      placeholder="Motivo (facoltativo)"
                      className="w-full h-16 resize-none rounded-xl border border-kidville-line p-2 font-maven text-sm focus:border-kidville-green focus:outline-none"
                    />
                    <p className="font-maven text-sm text-kidville-muted">Inserisci il codice OTP ricevuto via email:</p>
                    {otpState.devCode && (
                      <p className="font-maven text-xs text-kidville-warn">Dev: <b>{otpState.devCode}</b></p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text" value={otpCode} onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="000000"
                        className="font-maven rounded-full border border-kidville-line px-3 py-1.5 text-sm w-28 text-center tracking-widest"
                      />
                      <button
                        onClick={() => confermaGiustifica(p)}
                        disabled={firmando || !otpCode}
                        className="font-maven rounded-full bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
                      >
                        {firmando ? 'Invio…' : 'Conferma'}
                      </button>
                      <button onClick={annulla} className="font-maven text-xs text-kidville-muted">Annulla</button>
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

export default function AssenzeGenitorePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <AssenzeGenitore />
    </Suspense>
  );
}
