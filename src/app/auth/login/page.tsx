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
        (highContrast ? 'bg-black text-white' : 'bg-zinc-50 text-zinc-900') +
        ' min-h-screen flex items-center justify-center px-4'
      }
    >
      <form
        onSubmit={onSubmit}
        className={
          (highContrast ? 'bg-black border-white' : 'bg-white border-zinc-200') +
          ' w-full max-w-sm rounded-2xl border p-6 shadow-sm'
        }
        aria-label="Accesso a Kidville"
      >
        <h1 className="text-2xl font-semibold mb-1">Accesso Kidville</h1>
        <p className={(highContrast ? 'text-zinc-300' : 'text-zinc-500') + ' text-sm mb-5'}>
          Riservato a personale e famiglie. Accesso <strong>solo su invito</strong> della Segreteria.
        </p>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
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
          className="mb-4 w-full rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900"
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
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-zinc-900"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className="rounded-lg border border-zinc-300 px-3 text-sm"
            aria-pressed={showPassword}
          >
            {showPassword ? 'Nascondi' : 'Mostra'}
          </button>
        </div>

        <p className={(highContrast ? 'text-zinc-300' : 'text-zinc-500') + ' mb-4 text-xs'}>
          Password dimenticata? Contatta la Segreteria: riemette le credenziali via email.
        </p>

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white disabled:opacity-60"
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
