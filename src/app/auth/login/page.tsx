'use client';

import { Suspense, useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { getSupabase } from '@/lib/supabase/browser-client';
import { useAccessibility } from '@/lib/accessibility/useAccessibility';
import { areaFromPath, homePathForRole, isAreaAllowed } from '@/lib/auth/active-role';
import { labelRuolo } from '@/lib/auth/ruoli';
import styles from './page.module.css';

/* ───────── Iconcine inline (leading/eye + decori) ───────── */
function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M4 7l8 6 8-6" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.6" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  );
}
function EyeIcon({ off }: { off: boolean }) {
  return off ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a15.5 15.5 0 0 1-3 4M6.2 6.2C3.9 7.6 2.4 9.7 2 12c1 2.5 5 7 10 7a10 10 0 0 0 4.2-.9" />
      <path d="M9.5 9.6a3.4 3.4 0 0 0 4.9 4.7" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7s-9-4.5-10-7z" />
      <circle cx="12" cy="12" r="3.1" />
    </svg>
  );
}

/** Sfondo decorativo (blob organici + iconcine), nascosto in Alto Contrasto. */
function BackgroundDeco() {
  return (
    <div className={styles.deco} aria-hidden="true">
      <svg className={`${styles.blob} ${styles.blobTR}`} viewBox="0 0 200 200" fill="currentColor">
        <path d="M40,0 C120,0 200,0 200,80 C200,150 150,190 90,180 C30,170 0,120 10,60 C16,22 8,0 40,0 Z" />
      </svg>
      <svg className={`${styles.blob} ${styles.blobBL}`} viewBox="0 0 200 200" fill="currentColor">
        <path d="M0,60 C40,150 100,200 160,200 L0,200 Z" />
      </svg>
      <svg className={`${styles.blob} ${styles.blobBR}`} viewBox="0 0 200 200" fill="currentColor">
        <path d="M200,70 C120,80 60,130 50,200 L200,200 Z" />
      </svg>
      <svg className={`${styles.ico} ${styles.icoStar}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round">
        <path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17.8 6.4 20.1l1.4-6.3L3 9.5l6.4-.6L12 3z" />
      </svg>
      <svg className={`${styles.ico} ${styles.icoCloud}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round">
        <path d="M7 18h10a3.8 3.8 0 0 0 .5-7.6 5.4 5.4 0 0 0-10.5-1.3A3.7 3.7 0 0 0 7 18z" />
      </svg>
      <svg className={`${styles.ico} ${styles.icoRing}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <circle cx="12" cy="12" r="9" />
      </svg>
      <svg className={`${styles.ico} ${styles.icoHouse}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11l8-6 8 6" />
        <path d="M6 10v9h12v-9" />
        <path d="M10 19v-5h4v5" />
      </svg>
    </div>
  );
}

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
  const [showForgot, setShowForgot] = useState(false);
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
    <div className={styles.page}>
      {!highContrast && <BackgroundDeco />}

      <div className={styles.scene}>
        {!highContrast && (
          <>
            {/* logo trim su next/image; il CSS decide la larghezza reale */}
            <div className={styles.logo}>
              <Image src="/logo-kidville.png" alt="Kidville" width={2227} height={571} priority />
            </div>
            {/* mascotte a figura intera (cutout trasparente), sporge sulla card */}
            <div className={styles.mascot}>
              <Image src="/mascot-hero.png" alt="" aria-hidden width={665} height={994} priority />
            </div>
          </>
        )}

        <form onSubmit={onSubmit} className={styles.card} aria-label="Accesso a Kidville">
          <h1 className={styles.title}>Ciao!</h1>
          <p className={styles.subtitle}>
            {profili ? (
              <>Sei registrato con più profili. Scegli con quale ruolo entrare.</>
            ) : (
              <>
                Riservato a personale e famiglie. Accesso <strong>solo su invito</strong> della Segreteria.
              </>
            )}
          </p>

          {error && (
            <div role="alert" className={styles.alert}>
              {error}
            </div>
          )}

          {attesa ? null : profili ? (
            <div role="group" aria-label="Scelta del ruolo" style={{ marginTop: 24 }}>
              {profili.map((p) => (
                <button
                  key={p.ruolo}
                  type="button"
                  disabled={loading}
                  onClick={() => void scegliRuolo(p.ruolo)}
                  className={styles.roleBtn}
                >
                  {etichettaProfilo(p.ruolo)}
                </button>
              ))}
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="email">
                  Email
                </label>
                <div className={styles.inwrap}>
                  <span className={styles.lead}>
                    <MailIcon />
                  </span>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="nome@esempio.it"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={styles.input}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="password">
                  Password
                </label>
                <div className={`${styles.inwrap} ${styles.hasEye}`}>
                  <span className={styles.lead}>
                    <LockIcon />
                  </span>
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    placeholder="La tua password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={styles.input}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className={styles.eye}
                    aria-pressed={showPassword}
                    aria-label={showPassword ? 'Nascondi password' : 'Mostra password'}
                  >
                    <EyeIcon off={showPassword} />
                  </button>
                </div>
              </div>

              <button type="button" className={styles.forgot} onClick={() => setShowForgot((s) => !s)} aria-expanded={showForgot}>
                Password dimenticata?
              </button>
              {showForgot && (
                <p className={styles.forgotNote}>
                  Contatta la Segreteria: riemette le credenziali via email. L’accesso è solo su invito.
                </p>
              )}

              <button type="submit" disabled={loading} className={styles.accedi}>
                {loading ? 'Accesso…' : 'Accedi'}
              </button>
            </>
          )}

          <button type="button" onClick={toggleContrast} className={styles.contrast} aria-pressed={highContrast}>
            {highContrast ? 'Disattiva alto contrasto' : 'Attiva alto contrasto'}
          </button>
        </form>
      </div>
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
