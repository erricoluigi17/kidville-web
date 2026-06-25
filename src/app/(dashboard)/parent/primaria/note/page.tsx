'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { AlertTriangle, Check } from 'lucide-react';

interface Nota {
  id: string; categoria: string; testo: string;
  richiede_firma: boolean; firmata_il: string | null; creato_il: string;
}

const CATEGORIE: Record<string, { label: string; cls: string }> = {
  disciplinare: { label: 'Disciplinare', cls: 'bg-red-100 text-red-700' },
  didattica: { label: 'Didattica', cls: 'bg-blue-100 text-blue-700' },
  compiti_non_svolti: { label: 'Compiti non svolti', cls: 'bg-amber-100 text-amber-700' },
};

function NoteGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [note, setNote] = useState<Nota[]>([]);
  const [loading, setLoading] = useState(true);
  const [firmando, setFirmando] = useState<string | null>(null);
  const [otpState, setOtpState] = useState<{ ticket: string; expiry: number; devCode?: string } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpTarget, setOtpTarget] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const carica = async () => {
    if (!ready || !studentId) return;
    setLoading(true);
    const r = await fetch(`/api/parent/primaria/note?studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
    const d = await r.json();
    if (d.success) setNote(d.data);
    setLoading(false);
  };

  useEffect(() => { carica(); }, [ready, studentId]);

  // Presa visione con firma OTP/FES (DL-014): invio codice → conferma → firma.
  const avviaFirma = async (notaId: string) => {
    setMsg(''); setOtpTarget(notaId); setOtpCode('');
    const r = await fetch(`/api/parent/primaria/note/firma/otp?userId=${parentId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error || 'Errore OTP'); setOtpTarget(null); return; }
    setOtpState(d.data);
  };

  const confermaFirma = async () => {
    if (!otpTarget || !otpState) return;
    setFirmando(otpTarget);
    const r = await fetch(`/api/parent/primaria/note/firma?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ notaId: otpTarget, code: otpCode, expiry: otpState.expiry, ticket: otpState.ticket }),
    });
    const d = await r.json();
    setFirmando(null);
    if (!r.ok) { setMsg(d.error || 'Firma non riuscita'); return; }
    setOtpState(null); setOtpCode(''); setOtpTarget(null);
    setMsg('Nota firmata ✓');
    carica();
  };

  const inAttesa = note.filter((n) => n.richiede_firma && !n.firmata_il);

  return (
    <div className="px-4 pt-6 pb-24">
      <h1 className="font-barlow text-xl font-black text-kidville-green uppercase tracking-wide mb-4 flex items-center gap-2">
        <AlertTriangle size={20} /> Note
      </h1>

      {loading ? (
        <p className="font-maven text-sm text-gray-400">Caricamento…</p>
      ) : note.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna nota registrata.</p>
      ) : (
        <div className="space-y-3">
          {msg && <p className={`font-maven text-sm rounded-2xl px-4 py-2 ${msg.includes('✓') ? 'bg-green-50 text-kidville-success' : 'bg-red-50 text-red-600'}`}>{msg}</p>}
          {inAttesa.length > 0 && (
            <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3">
              <p className="font-maven text-sm font-semibold text-amber-700">
                {inAttesa.length} nota{inAttesa.length > 1 ? ' in attesa' : ' in attesa'} di firma
              </p>
            </div>
          )}
          {note.map((n) => {
            const cat = CATEGORIE[n.categoria] ?? { label: n.categoria, cls: 'bg-gray-100 text-gray-500' };
            return (
              <div key={n.id} className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-maven font-semibold ${cat.cls}`}>{cat.label}</span>
                  <span className="font-maven text-xs text-gray-400">
                    {new Date(n.creato_il).toLocaleDateString('it-IT')}
                  </span>
                  {n.richiede_firma && (
                    n.firmata_il
                      ? <span className="font-maven text-xs text-kidville-success flex items-center gap-1"><Check size={11} /> Firmata</span>
                      : <span className="font-maven text-xs text-amber-600">In attesa di firma</span>
                  )}
                </div>
                <p className="font-maven text-sm text-gray-700">{n.testo}</p>
                {n.richiede_firma && !n.firmata_il && otpTarget !== n.id && (
                  <button
                    onClick={() => avviaFirma(n.id)}
                    className="mt-3 font-maven inline-flex items-center gap-1.5 rounded-full bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
                  >
                    <Check size={14} /> Firma presa visione
                  </button>
                )}

                {/* Conferma OTP/FES inline */}
                {otpTarget === n.id && otpState && (
                  <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
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
                        disabled={firmando === n.id || !otpCode}
                        className="font-maven rounded-full bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
                      >
                        {firmando === n.id ? 'Firma…' : 'Conferma'}
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

export default function NoteGenitorePage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <NoteGenitore />
    </Suspense>
  );
}
