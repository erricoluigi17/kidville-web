'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { Download, Check, Award, ShieldCheck } from 'lucide-react';

interface PagellaItem { scrutinioId: string; periodo: string; anno: string; chiusoIl: string | null; firmato: boolean }
interface CertItem { id: string; anno: string; stato: string; downloadUrl: string | null }
interface ScrutinioView {
  materie: { nome: string; giudizio: string | null }[];
  comportamento: string | null;
  giudizioGlobale: string | null;
}

function PagelleGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [pagelle, setPagelle] = useState<PagellaItem[]>([]);
  const [certificati, setCertificati] = useState<CertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dettaglio, setDettaglio] = useState<Record<string, ScrutinioView | null>>({});
  const [firmando, setFirmando] = useState<string | null>(null);
  const [otpState, setOtpState] = useState<{ ticket: string; expiry: number; devCode?: string } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpTarget, setOtpTarget] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const carica = useCallback(async () => {
    if (!ready || !studentId) return;
    setLoading(true);
    const r = await fetch(`/api/parent/primaria/pagella?studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
    const d = await r.json();
    if (d.success) setPagelle(d.data);
    try {
      const rc = await fetch(`/api/parent/competenze?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } });
      const dc = await rc.json();
      if (dc.success) setCertificati(dc.data ?? []);
    } catch { /* no-op */ }
    setLoading(false);
  }, [ready, studentId, parentId]);

  useEffect(() => { carica(); }, [carica]);

  const apriPDF = (scrutinioId: string) => {
    if (!studentId) return;
    window.open(`/api/primaria/pagella?scrutinioId=${scrutinioId}&alunnoId=${studentId}&userId=${parentId}`, '_blank');
  };

  const caricaDettaglio = async (scrutinioId: string) => {
    if (dettaglio[scrutinioId] !== undefined) { setDettaglio((p) => ({ ...p, [scrutinioId]: dettaglio[scrutinioId] === null ? undefined as unknown as null : null })); return; }
    const r = await fetch(`/api/parent/primaria/scrutinio?scrutinioId=${scrutinioId}&studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
    const d = await r.json();
    setDettaglio((p) => ({ ...p, [scrutinioId]: d.success ? d.data : null }));
  };

  const avviaFirma = async (scrutinioId: string) => {
    setMsg(''); setOtpTarget(scrutinioId);
    const r = await fetch(`/api/parent/primaria/pagella/firma/otp?userId=${parentId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error || 'Errore OTP'); return; }
    setOtpState(d.data);
  };

  const confermaFirma = async () => {
    if (!otpTarget || !otpState) return;
    setFirmando(otpTarget);
    const r = await fetch(`/api/parent/primaria/pagella/firma?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ scrutinioId: otpTarget, studentId, code: otpCode, expiry: otpState.expiry, ticket: otpState.ticket }),
    });
    const d = await r.json();
    setFirmando(null);
    if (!r.ok) { setMsg(d.error || 'Firma non riuscita'); return; }
    setOtpState(null); setOtpCode(''); setOtpTarget(null);
    setMsg('Pagella firmata ✓');
    carica();
  };

  return (
    <div className="px-4 pt-6 pb-24">
      <div className="mb-4">
        <p className="font-barlow font-bold text-[11px] uppercase tracking-[0.14em] text-kidville-yellow-dark">
          Didattica · Primaria
        </p>
        <h1 className="font-barlow text-2xl font-black text-kidville-green uppercase tracking-wide leading-none">
          Pagelle
        </h1>
      </div>

      {/* Banner conformità O.M. 3/2025 (DR PagelleScreen) */}
      <div className="mb-4 flex items-start gap-2.5 rounded-[16px] bg-kidville-green-soft px-4 py-3">
        <ShieldCheck size={18} className="mt-0.5 flex-shrink-0 text-kidville-green" />
        <p className="font-maven text-[12.5px] leading-snug text-kidville-green/80">
          Documento ufficiale di valutazione in <strong>giudizi sintetici</strong> (O.M. 3/2025): nessun voto numerico.
        </p>
      </div>

      {loading ? (
        <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>
      ) : pagelle.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">Nessuna pagella disponibile.</p>
      ) : (
        <div className="space-y-3">
          {msg && <p className={`font-maven text-sm rounded-2xl px-4 py-2 ${msg.includes('✓') ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-error-soft text-kidville-error'}`}>{msg}</p>}

          {pagelle.map((p) => {
            const det = dettaglio[p.scrutinioId];
            return (
              <div key={p.scrutinioId} className="rounded-card border border-kidville-line bg-white shadow-sm overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-4 py-3.5">
                  <div>
                    <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{p.periodo}</p>
                    <p className="font-maven text-xs text-kidville-muted">A.S. {p.anno}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.firmato
                      ? <span className="font-maven text-xs text-kidville-success flex items-center gap-1"><Check size={11} /> Firmata</span>
                      : (
                        <button
                          onClick={() => avviaFirma(p.scrutinioId)}
                          className="font-maven rounded-full bg-kidville-green px-3 py-1.5 text-xs text-kidville-yellow"
                        >
                          Firma
                        </button>
                      )}
                    <button
                      onClick={() => apriPDF(p.scrutinioId)}
                      className="font-maven inline-flex items-center gap-1 rounded-full bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green"
                    >
                      <Download size={12} /> PDF
                    </button>
                    {p.firmato && (
                      <button
                        onClick={() => caricaDettaglio(p.scrutinioId)}
                        className="font-maven text-xs text-kidville-muted underline"
                      >
                        {det !== undefined ? 'Nascondi' : 'Dettaglio'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Dettaglio giudizi (solo dopo firma) */}
                {p.firmato && det && (
                  <div className="border-t border-kidville-line px-4 py-3 space-y-1.5">
                    {det.materie.map((m, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <span className="font-maven text-sm text-kidville-ink">{m.nome}</span>
                        <span className="font-maven text-sm font-semibold text-kidville-green">{m.giudizio ?? '—'}</span>
                      </div>
                    ))}
                    {det.comportamento && (
                      <p className="font-maven text-xs text-kidville-muted mt-2">Comportamento: {det.comportamento}</p>
                    )}
                    {det.giudizioGlobale && (
                      <p className="font-maven text-xs text-kidville-muted italic mt-1">{det.giudizioGlobale}</p>
                    )}
                  </div>
                )}

                {/* OTP firma inline */}
                {otpTarget === p.scrutinioId && otpState && (
                  <div className="border-t border-kidville-line px-4 py-3 space-y-2">
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
                        onClick={confermaFirma}
                        disabled={firmando === p.scrutinioId || !otpCode}
                        className="font-maven rounded-full bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
                      >
                        {firmando === p.scrutinioId ? 'Firma…' : 'Conferma'}
                      </button>
                      <button onClick={() => { setOtpTarget(null); setOtpState(null); setOtpCode(''); }}
                        className="font-maven text-xs text-kidville-muted">Annulla</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {certificati.length > 0 && (
        <div className="mt-6">
          <h2 className="font-barlow text-lg font-black text-kidville-green uppercase tracking-wide mb-3 flex items-center gap-2">
            <Award size={18} /> Certificato delle Competenze
          </h2>
          <div className="space-y-2">
            {certificati.map((c) => (
              <div key={c.id} className="rounded-card border border-kidville-line bg-white shadow-sm px-4 py-3.5 flex items-center justify-between">
                <div>
                  <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">Classe quinta</p>
                  <p className="font-maven text-xs text-kidville-muted">A.S. {c.anno}</p>
                </div>
                {c.downloadUrl ? (
                  <a href={c.downloadUrl} target="_blank" rel="noreferrer" className="font-maven inline-flex items-center gap-1 rounded-full bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green">
                    <Download size={12} /> Scarica
                  </a>
                ) : (
                  <span className="font-maven text-xs text-kidville-muted">In preparazione</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PagelleGenitorePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <PagelleGenitore />
    </Suspense>
  );
}
