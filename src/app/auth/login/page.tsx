'use client';

import { Suspense, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/browser-client';
import { useAccessibility } from '@/lib/accessibility/useAccessibility';
import { areaFromPath, homePathForRole, isAreaAllowed } from '@/lib/auth/active-role';
import { labelRuolo } from '@/lib/auth/ruoli';

// M4B.3 — login unico con smistamento per ruolo: dopo l'accesso si atterra
// sulla dashboard del proprio ruolo; chi ha più profili (docente che è anche
// genitore) sceglie il ruolo in uno step inline nella stessa card.

interface ProfiloDisponibile {
  ruolo: string;
  area: string;
}

const ETICHETTE: Record<string, string> = { genitore: 'Genitore' };

function etichettaProfilo(ruolo: string): string {
  return ETICHETTE[ruolo] ?? labelRuolo(ruolo);
}

/** Destinazione post-login: `?next=` onorato solo se coerente col ruolo attivo. */
function destinazione(ruolo: string, next: string | null): string {
  if (next) {
    const area = areaFromPath(next);
    if (area && isAreaAllowed(ruolo, area)) return next;
  }
  return homePathForRole(ruolo);
}

function persisti(chiave: string, valore: string) {
  try {
    window.localStorage.setItem(chiave, valore);
  } catch {
    /* ignore */
  }
}

async function impostaRuoloAttivo(ruolo: string): Promise<boolean> {
  const res = await fetch('/api/auth/active-role', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ruolo }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next');
  // Arrivo dalla guardia d'area (M4B.4): utente già autenticato con doppio
  // profilo ma senza ruolo attivo → salta le credenziali, mostra la scelta.
  const scegli = params.get('scegli') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Alto contrasto: stato globale (provider + cookie SSR), non più locale.
  const { highContrast, toggle: toggleContrast } = useAccessibility();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // ≥2 profili → step inline di scelta ruolo nella stessa card.
  const [profili, setProfili] = useState<ProfiloDisponibile[] | null>(null);
  // Con ?scegli=1 il primo paint attende /api/me: niente flash del form
  // credenziali prima del picker (resta la card con titolo e sottotitolo).
  const [attesa, setAttesa] = useState(scegli);

  useEffect(() => {
    if (!scegli) return;
    let cancelled = false;
    const load = async () => {
      let profs: ProfiloDisponibile[] | null = null;
      let id: string | null = null;
      let ruoloUnico: string | null = null;
      try {
        const res = await fetch('/api/me').catch(() => null);
        if (res?.ok) {
          const me = await res.json().catch(() => null);
          if (me?.id) id = String(me.id);
          if (Array.isArray(me?.profili) && me.profili.length > 0) {
            profs = me.profili as ProfiloDisponibile[];
            if (profs.length === 1) ruoloUnico = profs[0].ruolo;
          }
        }
      } finally {
        if (!cancelled) {
          if (id) persisti('kv_user_id', id);
          if (ruoloUnico) {
            // Auto-riparazione: un profilo solo non ha nulla da scegliere.
            const ruolo = ruoloUnico;
            persisti('kv_user_role', ruolo);
            void impostaRuoloAttivo(ruolo).then(() => {
              router.replace(destinazione(ruolo, next));
              router.refresh();
            });
          } else if (profs && profs.length >= 2) {
            setProfili(profs);
            setAttesa(false);
          } else {
            // Nessuna sessione/profilo: resta il form credenziali.
            setAttesa(false);
          }
          // NB: nel caso auto-riparazione (ruolo unico) attesa resta true:
          // si sta già navigando via, niente flash del form.
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [scegli, next, router]);

  async function scegliRuolo(ruolo: string) {
    setError(null);
    setLoading(true);
    try {
      const ok = await impostaRuoloAttivo(ruolo);
      if (!ok) {
        setError('Non riesco a impostare il ruolo. Riprova.');
        return;
      }
      persisti('kv_user_role', ruolo);
      router.replace(destinazione(ruolo, next));
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

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

      // Smistamento (M4B.3): profili disponibili da /api/me; identità
      // persistita per coerenza con useSessionIdentity (kv_user_id/kv_user_role).
      const res = await fetch('/api/me').catch(() => null);
      const me = res?.ok ? await res.json().catch(() => null) : null;
      if (me?.id) persisti('kv_user_id', String(me.id));
      if (me?.role) persisti('kv_user_role', String(me.role));

      const profs: ProfiloDisponibile[] = Array.isArray(me?.profili) ? me.profili : [];
      if (profs.length >= 2) {
        setProfili(profs); // step inline di scelta ruolo
        return;
      }
      const ruolo = profs[0]?.ruolo ?? (me?.role ? String(me.role) : null);
      if (ruolo) {
        persisti('kv_user_role', ruolo);
        await impostaRuoloAttivo(ruolo); // best-effort: la guardia ha il fallback ruolo unico
        router.replace(destinazione(ruolo, next));
        router.refresh();
        return;
      }

      // Degrado graceful: profili non disponibili. Mai next grezzo (open
      // redirect): si onorano solo path interni alle aree; per il resto si va
      // alla radice e le guardie server-side faranno il loro lavoro.
      router.replace(next && areaFromPath(next) ? next : '/');
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
          // M9.5: logo statico su next/image (intrinseco 16:9 in scala; la resa
          // la decide il CSS h-12 w-auto, identica all'<img>).
          <Image src="/logo_green.png" alt="Kidville" width={192} height={108} priority className="mb-4 h-12 w-auto" />
        )}
        <h1 className={(highContrast ? '' : 'text-kidville-green') + ' font-barlow text-2xl font-black uppercase tracking-wide mb-1'}>Accesso Kidville</h1>
        <p className={(highContrast ? 'text-zinc-300' : 'text-kidville-muted') + ' text-sm mb-5'}>
          {profili ? (
            <>Sei registrato con più profili. Scegli con quale ruolo entrare.</>
          ) : (
            <>Riservato a personale e famiglie. Accesso <strong>solo su invito</strong> della Segreteria.</>
          )}
        </p>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-kidville-error/30 bg-kidville-error-soft px-3 py-2 text-sm text-kidville-error"
          >
            {error}
          </div>
        )}

        {attesa ? null : profili ? (
          <div role="group" aria-label="Scelta del ruolo">
            {profili.map((p) => (
              <button
                key={p.ruolo}
                type="button"
                disabled={loading}
                onClick={() => void scegliRuolo(p.ruolo)}
                className={
                  (highContrast ? 'bg-[#FFE500] text-black border border-white' : 'bg-kidville-green text-kidville-yellow') +
                  ' mb-2 w-full rounded-pill px-4 py-2.5 font-barlow font-bold uppercase tracking-wide disabled:opacity-60'
                }
              >
                {etichettaProfilo(p.ruolo)}
              </button>
            ))}
          </div>
        ) : (
          <>
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
          </>
        )}

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
