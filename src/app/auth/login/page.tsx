'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/browser-client';
import { useAccessibility } from '@/lib/accessibility/useAccessibility';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Alto contrasto: stato globale (provider + cookie SSR), non più locale.
  const { highContrast, toggle: toggleContrast } = useAccessibility();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const supabase = getSupabase();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError('Credenziali non valide. L’accesso è solo su invito della Segreteria.');
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError('Errore di connessione. Riprova.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className={
        (highContrast ? 'bg-black text-white' : 'bg-kidville-cream text-kidville-ink') +
        ' min-h-screen flex items-center justify-center px-4'
      }
    >
      <form
        onSubmit={onSubmit}
        className={
          (highContrast ? 'bg-black border-white' : 'bg-white border-kidville-line') +
          ' font-maven w-full max-w-sm rounded-card border p-6 shadow-sm'
        }
        aria-label="Accesso a Kidville"
      >
        {!highContrast && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/logo_green.png" alt="Kidville" className="mb-4 h-7 w-auto" />
        )}
        <h1 className={(highContrast ? '' : 'text-kidville-green') + ' font-barlow text-2xl font-black uppercase tracking-wide mb-1'}>Accesso Kidville</h1>
        <p className={(highContrast ? 'text-zinc-300' : 'text-kidville-muted') + ' text-sm mb-5'}>
          Riservato a personale e famiglie. Accesso <strong>solo su invito</strong> della Segreteria.
        </p>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-kidville-error/30 bg-kidville-error-soft px-3 py-2 text-sm text-kidville-error"
          >
            {error}
          </div>
        )}

        <label className="block text-sm font-medium mb-1" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-4 w-full rounded-input border border-kidville-line px-3 py-2 text-kidville-ink focus:outline-none focus:border-kidville-green"
        />

        <label className="block text-sm font-medium mb-1" htmlFor="password">
          Password
        </label>
        <div className="mb-2 flex gap-2">
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-input border border-kidville-line px-3 py-2 text-kidville-ink focus:outline-none focus:border-kidville-green"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className="rounded-input border border-kidville-line px-3 text-sm text-kidville-green"
            aria-pressed={showPassword}
          >
            {showPassword ? 'Nascondi' : 'Mostra'}
          </button>
        </div>

        <p className={(highContrast ? "text-zinc-300" : "text-kidville-muted") + " mb-4 text-xs"}>
          Password dimenticata? Contatta la Segreteria: riemette le credenziali via email.
        </p>

        <button
          type="submit"
          disabled={loading}
          className={
            (highContrast ? 'bg-[#FFE500] text-black border border-white' : 'bg-kidville-green text-kidville-yellow') +
            ' w-full rounded-pill px-4 py-2.5 font-barlow font-bold uppercase tracking-wide disabled:opacity-60'
          }
        >
          {loading ? 'Accesso…' : 'Entra'}
        </button>

        <button
          type="button"
          onClick={toggleContrast}
          className="mt-4 w-full text-center text-xs underline"
          aria-pressed={highContrast}
        >
          {highContrast ? 'Disattiva alto contrasto' : 'Attiva alto contrasto'}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
