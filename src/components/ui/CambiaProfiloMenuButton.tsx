'use client';

import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Repeat } from 'lucide-react';
import { Modal } from './Modal';
import { useProfili } from '@/lib/auth/use-profili';
import { cambiaRuoloAttivo } from '@/lib/auth/ruolo-attivo-client';
import { areaForRole, homePathForArea } from '@/lib/auth/active-role';
import { useLabelRuolo } from '@/lib/auth/ruoli';
import { logClient, nomeErrore } from '@/lib/logging/client';
import type { AppRole } from '@/lib/auth/predicati-ruolo';

/* ════════════════════════════════════════════════════════════════════════════
 * «PASSA A GENITORE» — lo switch di veste, dentro l'app.
 *
 * Gemello dichiarato di `LogoutMenuButton` e `ContrastMenuButton`: stesso
 * contratto `{ className?, iconSize? }`, il contenitore decide lo stile, qui
 * vivono solo icona, etichetta e il gesto.
 *
 * ─── LA REGOLA CHE VIENE PRIMA DI TUTTE ─────────────────────────────────────
 * Misurato in produzione il 2026-09-01: **cinque** persone hanno due profili
 * (insegnanti che sono anche genitori di un bambino iscritto). **617** ne hanno
 * uno solo. Un'affordance morta mostrata a 617 persone su 622 non è una
 * funzione in più: è rumore in un menu che quelle persone aprono ogni giorno.
 *   → con meno di due profili questo componente non renderizza NIENTE.
 *
 * ─── E CON DUE PROFILI, UN TOCCO ────────────────────────────────────────────
 * Due è l'unico caso reale. Un picker che elenca due voci, di cui una è quella
 * che stai già indossando, è un passaggio in più senza informazione: l'etichetta
 * dice già la destinazione. Il ramo del picker esiste comunque — per tre o più
 * profili, e per il caso in cui la veste attiva sia AMBIGUA — e usa
 * `ui/Modal`, che ha già focus trap ciclico, Escape, scroll-lock, sfondo
 * `inert`, tasto Indietro di Android e ripristino del focus.
 *
 * ─── PERCHÉ QUI NON C'È NÉ `router.refresh()` NÉ UN SECONDO `replace` ───────
 * Una sola navigazione per cambio di veste. Il `refresh()` in coda a un
 * `replace` è precisamente ciò che sul simulatore iOS produceva
 * `NSURLErrorCancelled (-999)` in un accesso su sei (S28, vedi
 * `auth/login/page.tsx:120-133`; lock `ios-navigazione-annullata.test.ts`). Non
 * serve: i layout d'area sono dinamici — chiamano `cookies()` — e in Next 16
 * `staleTimes.dynamic` vale 0, quindi la Router Cache non li riusa e il payload
 * RSC viene ripreso col cookie di veste appena scritto.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Errore in linea: si resta dove si è, e lo si dice. Colori dai token. */
const AVVISO_CLS =
  'mt-1 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong';

/** Id dell'intestazione che dà il nome al dialogo del picker (WCAG: nome visibile). */
const ID_TITOLO_PICKER = 'kv-cambia-profilo-titolo';

/** Le voci del picker (≥3 profili): stessa riga delle sorelle, dentro il dialogo. */
const VOCE_PICKER_CLS =
  'flex w-full items-center gap-2.5 rounded-card bg-white px-3 py-[13px] font-barlow text-base ' +
  'font-extrabold uppercase tracking-wide text-kidville-green active:bg-kidville-green-soft ' +
  'disabled:opacity-60';

export function CambiaProfiloMenuButton({
  className,
  iconSize = 20,
}: {
  className?: string;
  iconSize?: number;
}) {
  const t = useTranslations('shared');
  const labelRuolo = useLabelRuolo();
  const router = useRouter();
  const { profili, ruoloAttivo, pronta } = useProfili();

  const [busy, setBusy] = useState(false);
  const [guasto, setGuasto] = useState(false);
  const [annuncio, setAnnuncio] = useState('');
  const [pickerAperto, setPickerAperto] = useState(false);
  /**
   * Il trigger a cui restituire il focus alla chiusura del dialogo (WCAG 2.4.3).
   * Serve PROPRIO qui: durante la POST il bottone è `disabled`, quindi a quel
   * punto `document.activeElement` è già `<body>` e il capture interno di
   * `Modal` non avrebbe niente da ripristinare.
   */
  const triggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Il guasto: nessuna navigazione, un messaggio, e una riga in `app_log`.
   *
   * ⚠️ `stato` resta `undefined` DI PROPOSITO, e lo status vive nel messaggio.
   * `livelloEvento` (`logging/client.ts`) applica `livelloFetch` a qualunque
   * evento che porti uno `stato` fra 400 e 599: un 403 non è fra le
   * `ANOMALIE_4XX`, quindi passarlo qui farebbe **scartare l'evento in
   * silenzio** — con questo test verde e nessuna riga in tabella. È la stessa
   * trappola già documentata su `registraCredenzialiRifiutate` nella login.
   *
   * `warn` e non `error`: `controlloTassoErrore` dichiara `/api/health`
   * degradato a cinque impronte `error` distinte in un quarto d'ora, e un
   * cambio di veste che non riesce è un disservizio per una persona, non un
   * guasto dell'applicazione.
   */
  function segnalaGuasto(errore: unknown, stato: number | undefined) {
    setGuasto(true);
    setBusy(false);
    logClient({
      livello: 'warn',
      evento: 'accesso',
      messaggio: `cambio veste non riuscito — http=${stato ?? 'nessuno'} errore=${nomeErrore(errore)}`,
    });
  }

  async function passaA(ruolo: string) {
    setGuasto(false);
    setBusy(true);
    let esito;
    try {
      esito = await cambiaRuoloAttivo(ruolo as AppRole);
    } catch (err) {
      // `cambiaRuoloAttivo` non rifiuta (`passoDiRete` non lascia passare niente),
      // ma un `catch` che manca è peggio di uno che tace: qui finirebbe qualunque
      // eccezione inattesa, e senza questo ramo il bottone resterebbe inattivo
      // per sempre — il sintomo W8, di nuovo.
      segnalaGuasto(err, undefined);
      return;
    }
    if (!esito.ok) {
      segnalaGuasto(esito.errore, esito.stato);
      return;
    }

    setPickerAperto(false);
    /*
     * L'ANNUNCIO VA DIPINTO PRIMA DI NAVIGARE, non «insieme».
     *
     * `router.replace` smonta l'intero albero dell'area di partenza, e con esso
     * questa regione `role="status"`. Una regione viva che cambia testo viene
     * messa in coda dallo screen reader e letta anche se sparisce subito dopo;
     * una regione che nasce già piena, nell'area di destinazione, non viene
     * annunciata affatto (le live region annunciano i CAMBI, non il contenuto
     * iniziale). `flushSync` forza il commit del DOM prima della navigazione: è
     * l'unico modo di garantire quell'ordine senza affidarlo a un effetto — che
     * qui vorrebbe dire un `setState` dentro un effetto, cioè il difetto che
     * `react-hooks/set-state-in-effect` vieta in questo repo.
     */
    flushSync(() => setAnnuncio(t('oraUsiComeAria', { ruolo: labelRuolo(ruolo) })));
    try {
      router.replace(homePathForArea(areaForRole(ruolo)));
    } catch (err) {
      // `replace` LANCIA se la navigazione viene rifiutata: senza questo ramo
      // resterebbe un `unhandledrejection` e il bottone inattivo, con la veste
      // già cambiata sul server e nessuna spiegazione a schermo.
      segnalaGuasto(err, undefined);
    }
  }

  // ⚠️ Tutti gli hook stanno SOPRA questa riga: il ritorno anticipato non deve
  // mai cambiare il numero di hook fra un render e l'altro.
  if (!pronta || profili.length < 2) return null;

  const alternativi = profili.filter((p) => p.ruolo !== ruoloAttivo);
  if (alternativi.length === 0) return null;
  /** Una sola destinazione possibile ⇒ l'etichetta la nomina e il bottone È l'azione. */
  const unTocco = alternativi.length === 1;

  const regioneAnnuncio = (
    <p role="status" aria-live="polite" className="sr-only">
      {annuncio}
    </p>
  );
  const avviso = guasto ? (
    <p role="alert" className={AVVISO_CLS}>
      {t('erroreCambioProfilo')}
    </p>
  ) : null;

  if (unTocco) {
    const meta = alternativi[0].ruolo;
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => void passaA(meta)}
          disabled={busy}
          aria-busy={busy}
          className={className}
        >
          <Repeat size={iconSize} strokeWidth={2.2} className="shrink-0" />
          <span>{t('passaA', { ruolo: labelRuolo(meta) })}</span>
        </button>
        {regioneAnnuncio}
        {avviso}
      </>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPickerAperto(true)}
        disabled={busy}
        aria-busy={busy}
        aria-haspopup="dialog"
        aria-expanded={pickerAperto}
        className={className}
      >
        <Repeat size={iconSize} strokeWidth={2.2} className="shrink-0" />
        <span>{t('cambiaProfilo')}</span>
      </button>
      {regioneAnnuncio}
      <Modal
        open={pickerAperto}
        onClose={() => setPickerAperto(false)}
        title={t('cambiaProfilo')}
        /* Il dialogo prende il nome dall'intestazione VISIBILE, non da una
           stringa parallela: così chi vede e chi ascolta leggono la stessa cosa,
           ed è lo stesso schema di `AdminMenuSheet`. */
        labelledBy={ID_TITOLO_PICKER}
        returnFocusRef={triggerRef}
        className="w-full max-w-[360px] rounded-[26px] bg-kidville-cream p-4 shadow-2xl"
      >
        {/* `sub` e non `muted`: #9AA6A2 vale 2,51:1 su bianco, cioè sotto AA —
            il debito di `text-kidville-muted` si smaltisce e non si rifinanzia
            (lock `__tests__/a11y/testo-muted-allowlist.test.ts`). */}
        <p
          id={ID_TITOLO_PICKER}
          className="mb-3 px-1 font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-sub"
        >
          {t('cambiaProfilo')}
        </p>
        <div className="flex flex-col gap-2">
          {alternativi.map((p) => (
            <button
              key={p.ruolo}
              type="button"
              onClick={() => void passaA(p.ruolo)}
              disabled={busy}
              aria-busy={busy}
              className={VOCE_PICKER_CLS}
            >
              <Repeat size={iconSize} strokeWidth={2.2} className="shrink-0" />
              <span>{t('passaA', { ruolo: labelRuolo(p.ruolo) })}</span>
            </button>
          ))}
        </div>
        {avviso}
      </Modal>
      {pickerAperto ? null : avviso}
    </>
  );
}
