'use client';

import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldCheck, KeyRound, Loader2 } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { Btn } from '@/components/ui/Btn';

// Onboarding genitore (DL-045): primo accesso → password + consensi GDPR.
// L'identità viene dalla sessione (URL → localStorage → /api/me), senza demo.
function Inner() {
  const router = useRouter();
  const t = useTranslations('parentForms');
  const { userId: parentId } = useSessionIdentity();

  const [password, setPassword] = useState('');
  const [privacy, setPrivacy] = useState(false);
  // C5 — consenso ai Termini di servizio: checkbox INDIPENDENTE dalla privacy,
  // bloccante lato client (il gate reale resta il 422 semantico server-side).
  const [termini, setTermini] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!privacy) { setError(t('erroreAccettaPrivacy')); return; }
    if (!termini) { setError(t('erroreAccettaTermini')); return; }
    if (password && password.length < 8) { setError(t('errorePasswordCorta')); return; }
    if (!parentId) { setError(t('erroreIdentita')); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/parent/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
        body: JSON.stringify({ consensi: { privacy, termini }, password: password || undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || t('erroreOperazione'));
        return;
      }
      router.push('/parent');
    } catch {
      setError(t('erroreRete'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-[80vh] flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-white rounded-card shadow-sm border border-kidville-line p-6 space-y-5">
        <div className="text-center">
          <ShieldCheck className="mx-auto text-kidville-green mb-2" size={36} />
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide">{t('titolo')}</h1>
          <p className="font-maven text-sm text-kidville-muted mt-1">{t('sottotitolo')}</p>
        </div>

        <div>
          <label className="block font-maven text-xs font-semibold text-kidville-green mb-1">{t('passwordLabel')}</label>
          <div className="relative">
            <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('passwordPlaceholder')}
              className="w-full pl-9 pr-3 py-2.5 border-2 border-kidville-line rounded-xl font-maven text-sm focus:outline-none focus:border-kidville-green"
            />
          </div>
        </div>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" checked={privacy} onChange={e => setPrivacy(e.target.checked)} className="mt-1 h-4 w-4 rounded text-kidville-green focus:ring-kidville-green" />
          <span className="font-maven text-sm text-kidville-ink leading-snug">
            {t.rich('consenso', {
              privacy: (chunks) => (
                <strong>
                  <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline">{chunks}</a>
                </strong>
              ),
            })}{' '}
            <span className="text-kidville-error">*</span>
          </span>
        </label>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" checked={termini} onChange={e => setTermini(e.target.checked)} className="mt-1 h-4 w-4 rounded text-kidville-green focus:ring-kidville-green" />
          <span className="font-maven text-sm text-kidville-ink leading-snug">
            {t.rich('consensoTermini', {
              termini: (chunks) => (
                <strong>
                  <a href="/termini" target="_blank" rel="noopener noreferrer" className="underline">{chunks}</a>
                </strong>
              ),
            })}{' '}
            <span className="text-kidville-error">*</span>
          </span>
        </label>

        {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}

        <Btn type="submit" variant="primary" size="md" disabled={saving} className="w-full">
          {saving && <Loader2 size={16} className="animate-spin" />}
          {t('completaAccesso')}
        </Btn>
      </form>
    </div>
  );
}

function OnboardingFallback() {
  const t = useTranslations('parentForms');
  return <div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>;
}

export default function ParentOnboardingPage() {
  return (
    <Suspense fallback={<OnboardingFallback />}>
      <Inner />
    </Suspense>
  );
}
