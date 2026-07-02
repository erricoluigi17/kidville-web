'use client';

import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, KeyRound, Loader2 } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// Onboarding genitore (DL-045): primo accesso → password + consensi GDPR.
// L'identità viene dalla sessione (URL → localStorage → /api/me), senza demo.
function Inner() {
  const router = useRouter();
  const { userId: parentId } = useSessionIdentity();

  const [password, setPassword] = useState('');
  const [privacy, setPrivacy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!privacy) { setError('Per continuare devi accettare l’informativa sulla privacy.'); return; }
    if (password && password.length < 8) { setError('La password deve avere almeno 8 caratteri.'); return; }
    if (!parentId) { setError('Identità non risolta: accedi di nuovo dal link ricevuto.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/parent/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
        body: JSON.stringify({ consensi: { privacy }, password: password || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || 'Operazione non riuscita. Riprova.');
        return;
      }
      router.push('/parent');
    } catch {
      setError('Errore di rete. Riprova.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-card shadow-sm border border-kidville-line p-6 space-y-5">
        <div className="text-center">
          <ShieldCheck className="mx-auto text-kidville-green mb-2" size={36} />
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide">Benvenuto/a</h1>
          <p className="font-maven text-sm text-kidville-muted mt-1">Completa il primo accesso: imposta la password e accetta i consensi.</p>
        </div>

        <div>
          <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">Nuova password (opzionale)</label>
          <div className="relative">
            <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Almeno 8 caratteri"
              className="w-full pl-9 pr-3 py-2.5 border-2 border-kidville-line rounded-xl font-maven text-sm focus:outline-none focus:border-kidville-green"
            />
          </div>
        </div>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" checked={privacy} onChange={e => setPrivacy(e.target.checked)} className="mt-1 h-4 w-4 rounded text-kidville-green focus:ring-kidville-green" />
          <span className="font-maven text-sm text-kidville-ink leading-snug">
            Ho letto e accetto l’<strong>informativa sulla privacy</strong> (GDPR, Reg. UE 2016/679) e il trattamento dei dati per le finalità scolastiche. <span className="text-kidville-error">*</span>
          </span>
        </label>

        {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="w-full h-11 rounded-pill bg-kidville-green text-kidville-yellow font-barlow font-black uppercase tracking-wider text-sm hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
        >
          {saving && <Loader2 size={16} className="animate-spin" />}
          Completa l’accesso
        </button>
      </form>
    </div>
  );
}

export default function ParentOnboardingPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <Inner />
    </Suspense>
  );
}
