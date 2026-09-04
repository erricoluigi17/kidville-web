'use client';

import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldCheck, KeyRound, Loader2 } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { Btn } from '@/components/ui/Btn';
// `LinkInterno` e non `<a target="_blank">`: nel guscio Capacitor un `_blank`
// consegna la pagina al browser di sistema, e il genitore che sta accettando i
// consensi al PRIMO accesso si ritroverebbe fuori dall'app a metà onboarding (R25).
import { LinkInterno } from '@/components/ui/LinkInterno';
import { soloCatalogoDaCorpo, type CodiceErrore } from '@/lib/ui/esito-fetch';
// LA REGOLA DELLA PASSWORD STA IN UN POSTO SOLO, ed è questa. Fino al 2026-09-01
// qui c'era `password.length < 8` mentre la route ne pretendeva dieci con una
// lettera e una cifra: chi ne scriveva nove passava di qui e veniva respinto dal
// server — con «Operazione non riuscita», perché questa schermata la prosa del
// server non la mostra. Il modulo non importa nulla (né Node né server) proprio
// per poter essere chiamato anche da qui: lo verifica
// `__tests__/lib/regole-password.test.ts`.
import { valutaPasswordNuova } from '@/lib/auth/regole-password';

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
    // La password è FACOLTATIVA: chi accetta solo i consensi non viene giudicato.
    // Ciò che si giudica, si giudica con lo STESSO verdetto del server, perché è
    // la stessa funzione — è il punto di tutto questo.
    if (password) {
      const regola = valutaPasswordNuova(password);
      if (!regola.ok) {
        // I quattro motivi della regola hanno lo stesso nome dei quattro codici
        // d'errore dichiarati in `CODICI_ERRORE`, e questa riga è il punto in cui
        // il compilatore lo verifica: se un domani la regola ne aggiungesse uno
        // senza dichiararlo, `tsc` diventerebbe rosso qui invece di lasciare che
        // il genitore legga la frase generica.
        const codice: CodiceErrore = regola.codice;
        // `soloCatalogoDaCorpo` è la stessa strada del rifiuto che arriva dal
        // server: codice → frase tradotta nella lingua dell'interfaccia. Il
        // ripiego non è più «operazione non riuscita» ma i requisiti, che almeno
        // dicono che cosa si sta chiedendo.
        setError(soloCatalogoDaCorpo({ codice }, t('passwordRequisiti')));
        return;
      }
    }
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
        // Niente prosa del server: è italiana per costruzione (T10-F1).
        const frase = soloCatalogoDaCorpo(j, t('erroreOperazione'));
        // ⚠️ «I consensi sono salvi» è una rassicurazione che vale SOLO qui, e per
        // questo non sta nella frase di catalogo: quella è condivisa con il cambio
        // password, dove di consensi non ce ne sono. Il server la dichiara come
        // fatto (`consensi_salvati`), la pagina la traduce. Senza, chi vede il
        // rifiuto crede di aver perso anche le spunte appena messe, e le rimette.
        const consensiSalvi = (j as { consensi_salvati?: unknown })?.consensi_salvati === true;
        setError(consensiSalvi ? `${frase} ${t('consensiComunqueSalvati')}` : frase);
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
          {/* `htmlFor`/`id`: senza il legame, chi usa uno screen reader arriva su
              un campo password senza nome — e nessuno legge i requisiti qui sotto. */}
          <label htmlFor="onboarding-password" className="block font-maven text-xs font-semibold text-kidville-green mb-1">{t('passwordLabel')}</label>
          <div className="relative">
            <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-muted" />
            <input
              id="onboarding-password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('passwordPlaceholder')}
              aria-describedby="onboarding-password-requisiti"
              className="w-full pl-9 pr-3 py-2.5 border-2 border-kidville-line rounded-xl font-maven text-sm focus:outline-none focus:border-kidville-green"
            />
          </div>
          {/* I requisiti si leggono PRIMA di sbagliare. Il placeholder da solo non
              basta: sparisce al primo carattere digitato, cioè un istante prima del
              momento in cui servirebbe. */}
          {/* `text-kidville-sub` e NON `-muted`, che è il grigio dei tre vicini in
              questa stessa schermata: 2,51:1 su bianco, sotto il 4,5:1 di WCAG AA
              (lock `__tests__/a11y/testo-muted-allowlist.test.ts`). Una riga che
              esiste per essere letta PRIMA di sbagliare non può essere quella che si
              legge peggio. */}
          <p id="onboarding-password-requisiti" className="mt-1.5 font-maven text-xs text-kidville-sub leading-snug">
            {t('passwordRequisiti')}
          </p>
        </div>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" checked={privacy} onChange={e => setPrivacy(e.target.checked)} className="mt-1 h-4 w-4 rounded text-kidville-green focus:ring-kidville-green" />
          <span className="font-maven text-sm text-kidville-ink leading-snug">
            {t.rich('consenso', {
              privacy: (chunks) => (
                <strong>
                  <LinkInterno href="/privacy" className="underline">{chunks}</LinkInterno>
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
                  <LinkInterno href="/termini" className="underline">{chunks}</LinkInterno>
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
