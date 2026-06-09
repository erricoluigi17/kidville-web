'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { FileText, Download, Check } from 'lucide-react';

interface PagellaItem { scrutinioId: string; periodo: string; anno: string; chiusoIl: string | null; firmato: boolean }
interface ScrutinioView {
  materie: { nome: string; giudizio: string | null }[];
  comportamento: string | null;
  giudizioGlobale: string | null;
}

export default function PagelleGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [pagelle, setPagelle] = useState<PagellaItem[]>([]);
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
      <h1 className="font-barlow text-xl font-black text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2">
        <FileText size={20} /> Pagelle
      </h1>

      {loading ? (
        <p className="font-maven text-sm text-gray-400">Caricamento…</p>
      ) : pagelle.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna pagella disponibile.</p>
      ) : (
        <div className="space-y-3">
          {msg && <p className={`font-maven text-sm rounded-2xl px-4 py-2 ${msg.includes('✓') ? 'bg-green-50 text-kidville-success' : 'bg-red-50 text-red-600'}`}>{msg}</p>}

          {pagelle.map((p) => {
            const det = dettaglio[p.scrutinioId];
            return (
              <div key={p.scrutinioId} className="rounded-2xl bg-white shadow-sm overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-4 py-3.5">
                  <div>
                    <p className="font-barlow text-base font-bold text-gray-800">{p.periodo}</p>
                    <p className="font-maven text-xs text-gray-400">A.S. {p.anno}</p>
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
                        className="font-maven text-xs text-gray-400 underline"
                      >
                        {det !== undefined ? 'Nascondi' : 'Dettaglio'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Dettaglio giudizi (solo dopo firma) */}
                {p.firmato && det && (
                  <div className="border-t border-gray-100 px-4 py-3 space-y-1.5">
                    {det.materie.map((m, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <span className="font-maven text-sm text-gray-700">{m.nome}</span>
                        <span className="font-maven text-sm font-semibold text-kidville-green">{m.giudizio ?? '—'}</span>
                      </div>
                    ))}
                    {det.comportamento && (
                      <p className="font-maven text-xs text-gray-500 mt-2">Comportamento: {det.comportamento}</p>
                    )}
                    {det.giudizioGlobale && (
                      <p className="font-maven text-xs text-gray-500 italic mt-1">{det.giudizioGlobale}</p>
                    )}
                  </div>
                )}

                {/* OTP firma inline */}
                {otpTarget === p.scrutinioId && otpState && (
                  <div className="border-t border-gray-100 px-4 py-3 space-y-2">
                    <p className="font-maven text-sm text-gray-600">Inserisci il codice OTP ricevuto via email:</p>
                    {otpState.devCode && (
                      <p className="font-maven text-xs text-amber-600">Dev: <b>{otpState.devCode}</b></p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text" value={otpCode} onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="000000"
                        className="font-maven rounded-full border border-gray-200 px-3 py-1.5 text-sm w-28 text-center tracking-widest"
                      />
                      <button
                        onClick={confermaFirma}
                        disabled={firmando === p.scrutinioId || !otpCode}
                        className="font-maven rounded-full bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
                      >
                        {firmando === p.scrutinioId ? 'Firma…' : 'Conferma'}
                      </button>
                      <button onClick={() => { setOtpTarget(null); setOtpState(null); setOtpCode(''); }}
                        className="font-maven text-xs text-gray-400">Annulla</button>
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
