'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { LinkInterno } from '@/components/ui/LinkInterno';
import { IdCard, ShieldCheck, FileText, LifeBuoy, Loader2, AlertTriangle, Trash2, RotateCcw, Fingerprint } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { doLogout } from '@/lib/auth/logout';
import { LanguageSwitcher } from '@/components/features/i18n/LanguageSwitcher';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { biometriaDisponibile, biometriaAttiva, impostaBiometria, verificaBiometria } from '@/lib/native/biometric';

// Pagina «Profilo e deleghe» (attiva il placeholder della BottomNav). Contiene i
// link legali e la CANCELLAZIONE ACCOUNT self-service (App Store 5.1.1(v) + GDPR):
// il genitore invia una richiesta (doppia conferma digitando ELIMINA), la Direzione
// la evade. La richiesta è REVOCABILE finché è "in lavorazione".
const CONFERMA = 'ELIMINA';

interface RichiestaStato {
  id: string;
  stato: string;
  creata_il: string;
  evasa_il: string | null;
}

function Inner() {
  const t = useTranslations('profilo');
  // I testi del prompt NATIVO stanno nel namespace condiviso (li usa anche il
  // BiometricGate): una copia sola, così non possono divergere.
  const tShared = useTranslations('shared');
  const { userId } = useSessionIdentity();
  const [richiesta, setRichiesta] = useState<RichiestaStato | null>(null);
  const [loading, setLoading] = useState(true);
  const [conferma, setConferma] = useState('');
  const [busy, setBusy] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  // Sblocco biometrico opt-in (nativo). `bioSupportata`: null = in verifica,
  // false = non disponibile (web o device senza biometria), true = disponibile.
  const [bioSupportata, setBioSupportata] = useState<boolean | null>(null);
  const [bioAttiva, setBioAttiva] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);

  const hdr = (uid: string) => ({ 'Content-Type': 'application/json', 'x-user-id': uid });

  const controllaBio = useCallback(async () => {
    // try/finally + setState dopo l'await: è il pattern che la regola
    // react-hooks/set-state-in-effect accetta (prior art: `carica` più sotto).
    try {
      const disp = await biometriaDisponibile();
      setBioSupportata(disp);
      setBioAttiva(biometriaAttiva());
    } finally {
      // nessuna azione: il ramo esiste solo per delimitare l'async boundary
    }
  }, []);

  useEffect(() => { void controllaBio(); }, [controllaBio]);

  const toggleBio = async () => {
    if (bioBusy) return;
    setBioBusy(true);
    try {
      if (bioAttiva) {
        impostaBiometria(false);
        setBioAttiva(false);
      } else {
        // Verifica di prova prima di attivare l'opt-in.
        const { ok } = await verificaBiometria({
          motivo: t('bioPromptVerifica'),
          annulla: tShared('bioAnnulla'),
          titoloAndroid: tShared('bioTitoloAndroid'),
          sottotitoloAndroid: tShared('bioSottotitoloAndroid'),
          fallbackIos: tShared('bioFallbackIos'),
        });
        if (ok) {
          impostaBiometria(true);
          setBioAttiva(true);
        }
      }
    } finally {
      setBioBusy(false);
    }
  };

  const carica = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch('/api/parent/account/richiesta-cancellazione', { headers: { 'x-user-id': userId } });
      const j = await res.json();
      setRichiesta(j?.richiesta ?? null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { carica(); }, [carica]);

  const invia = async () => {
    if (!userId) return;
    setErrore(null);
    setBusy(true);
    try {
      const res = await fetch('/api/parent/account/richiesta-cancellazione', {
        method: 'POST', headers: hdr(userId), body: JSON.stringify({ conferma }),
      });
      const j = await res.json();
      // Niente prosa del server: è italiana per costruzione (T10-F1).
      if (!res.ok) { setErrore(soloCatalogoDaCorpo(j, t('erroreGenerico'))); return; }
      setConferma('');
      await carica();
    } catch {
      setErrore(t('erroreRete'));
    } finally {
      setBusy(false);
    }
  };

  const revoca = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      const res = await fetch('/api/parent/account/richiesta-cancellazione', { method: 'DELETE', headers: hdr(userId) });
      if (res.ok) await carica();
    } finally {
      setBusy(false);
    }
  };

  const pending = richiesta?.stato === 'pending';

  return (
    <div className="mx-auto max-w-xl px-4 py-6 pb-28 space-y-5">
      <header className="text-center">
        <IdCard className="mx-auto mb-2 text-kidville-green" size={34} />
        <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green">{t('titolo')}</h1>
        <p className="mt-1 font-maven text-sm text-kidville-muted">{t('sottotitolo')}</p>
      </header>

      <div className="flex justify-center">
        <LanguageSwitcher />
      </div>

      {/* Link legali / assistenza.
          `LinkInterno` e non `<Link target="_blank">`: nella WebView di Capacitor
          le schede non esistono, quindi il sistema consegnava queste tre pagine a
          Safari/Chrome e il genitore usciva dall'app senza un comando per
          rientrare (R25). Sul web restano una scheda nuova, com'erano. */}
      <section className="rounded-card border border-kidville-line bg-white p-2">
        <LinkInterno href="/privacy" className="flex items-center gap-3 rounded-xl px-3 py-3 active:bg-kidville-cream">
          <ShieldCheck size={20} className="text-kidville-green" />
          <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('linkPrivacy')}</span>
        </LinkInterno>
        <LinkInterno href="/termini" className="flex items-center gap-3 rounded-xl px-3 py-3 border-t border-kidville-line active:bg-kidville-cream">
          <FileText size={20} className="text-kidville-green" />
          <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('linkTermini')}</span>
        </LinkInterno>
        <LinkInterno href="/assistenza" className="flex items-center gap-3 rounded-xl px-3 py-3 border-t border-kidville-line active:bg-kidville-cream">
          <LifeBuoy size={20} className="text-kidville-green" />
          <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('linkAssistenza')}</span>
        </LinkInterno>
      </section>

      {/* Sblocco biometrico (opt-in) — solo se il dispositivo lo supporta */}
      {bioSupportata !== null && (
        <section className="rounded-card border border-kidville-line bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Fingerprint size={20} className="mt-0.5 flex-shrink-0 text-kidville-green" />
              <div>
                <h2 className="font-barlow text-sm font-extrabold uppercase text-kidville-green">
                  {t('bioTitolo')}
                </h2>
                <p className="mt-1 font-maven text-[13px] leading-relaxed text-kidville-ink/70">
                  {bioSupportata
                    ? t('bioDescDisponibile')
                    : t('bioDescNonDisponibile')}
                </p>
              </div>
            </div>
            {bioSupportata && (
              <button
                type="button"
                role="switch"
                aria-checked={bioAttiva}
                aria-label={t('bioSwitchAria')}
                onClick={() => void toggleBio()}
                disabled={bioBusy}
                className={`relative mt-0.5 h-7 w-12 flex-shrink-0 rounded-pill transition-colors disabled:opacity-50 ${
                  bioAttiva ? 'bg-kidville-green' : 'bg-kidville-line'
                }`}
              >
                <span
                  className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                    bioAttiva ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            )}
          </div>
        </section>
      )}

      {/* Cancellazione account */}
      <section className="rounded-card border-t-4 border-kidville-error bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 font-barlow text-lg font-black uppercase tracking-wide text-kidville-error">
          <AlertTriangle size={18} /> {t('eliminaTitolo')}
        </h2>

        {loading ? (
          <div className="mt-3 flex items-center gap-2 font-maven text-sm text-kidville-muted"><Loader2 className="animate-spin" size={14} /> {t('caricamento')}</div>
        ) : pending ? (
          <div className="mt-3 space-y-3">
            <div className="rounded-xl bg-kidville-warn-soft p-3.5 font-maven text-[13px] text-kidville-ink/80">
              {t.rich('pendingBody', { strong: (chunks) => <strong>{chunks}</strong> })}
            </div>
            <button
              onClick={revoca}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-pill border border-kidville-line px-4 py-2.5 font-barlow text-sm font-extrabold uppercase text-kidville-green active:bg-kidville-cream disabled:opacity-50"
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <RotateCcw size={15} />} {t('annullaRichiesta')}
            </button>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="font-maven text-[13px] leading-relaxed text-kidville-ink/80">
              {t.rich('eliminaSpiegazione', { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
            <label className="block font-maven text-xs font-semibold text-kidville-muted">
              {t('confermaIstruzione')} <span className="font-mono text-kidville-error">{CONFERMA}</span>
            </label>
            <input
              value={conferma}
              onChange={(e) => setConferma(e.target.value)}
              placeholder={CONFERMA}
              className="w-full rounded-xl border-2 border-kidville-line px-3 py-2.5 font-maven text-sm outline-none focus:border-kidville-error"
            />
            {errore && <p className="font-maven text-xs text-kidville-error">{errore}</p>}
            <button
              onClick={invia}
              disabled={busy || conferma.trim().toUpperCase() !== CONFERMA}
              className="flex w-full items-center justify-center gap-2 rounded-pill bg-kidville-error px-5 py-2.5 font-barlow text-sm font-black uppercase tracking-wider text-kidville-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 className="animate-spin" size={15} /> : <Trash2 size={15} />} {t('richiediCancellazione')}
            </button>
          </div>
        )}
      </section>

      <button
        onClick={() => doLogout()}
        className="w-full rounded-pill px-4 py-2.5 font-barlow text-sm font-extrabold uppercase text-kidville-muted active:bg-kidville-cream"
      >
        {t('esci')}
      </button>
    </div>
  );
}

export default function ParentProfiloPage() {
  const t = useTranslations('profilo');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>}>
      <Inner />
    </Suspense>
  );
}
