'use client';

/**
 * Contesto delle SEDI ATTIVE del cockpit Direzione/Segreteria (Fase B multi-scuola).
 *
 * Modello (deciso col committente): la Direzione vede SOLO le sedi che seleziona,
 * e può selezionarne più d'una contemporaneamente (letture combinate). La
 * selezione è una preferenza UI persistita nel cookie `sedi_attive` (lista di
 * UUID separati da virgola, vuoto = tutte le sedi accessibili). Il cookie NON è
 * un segreto: il server lo ri-valida SEMPRE contro `scuoleDiUtente`
 * (`resolveScuoleAttive`/`resolveScuolaScrittura` in @/lib/auth/scope), quindi
 * manometterlo non dà accesso a plessi non propri.
 *
 * Espone:
 *  - `sedi`         → sedi accessibili (id+nome) da /api/admin/sedi;
 *  - `errore`       → l'elenco NON è arrivato (route non-ok o rete giù). È ciò
 *                     che distingue «non so quali sedi hai» da «non ne hai»:
 *                     senza, `[]` significava entrambe le cose e l'utente
 *                     riceveva un'istruzione impossibile (vedi `SedeNotice`);
 *  - `ricarica`     → ritenta il caricamento: è il «Riprova» dell'avviso;
 *  - `selezionate`  → subset scelto (vuoto = tutte);
 *  - `effettive`    → subset ∩ accessibili, o tutte: quello che il server scopa;
 *  - `sedeCorrente` → UNA sede per le pagine di configurazione (null se ambiguo,
 *                     cioè più sedi accessibili e nessuna singola scelta);
 *  - `reFetchKey`   → dipendenza stabile per i useEffect delle liste multi-sede;
 *  - `epocaSede`    → contatore che avanza SOLO quando l'utente cambia sede: è
 *                     la chiave di rimontaggio di `<SedeScopeBoundary>`;
 *  - `loading`      → true finché non ho caricato le sedi accessibili.
 *
 * NB: `userId` arriva da <AdminIdentityProvider> (two-pass SSR-safe), non da
 * `useSessionIdentity`/`useSearchParams`, così l'intera shell admin non sospende;
 * se assente il server risolve comunque l'identità dalla sessione.
 */

import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useAdminIdentity } from './admin-identity';

const COOKIE = 'sedi_attive';

export interface Sede {
  id: string;
  nome: string;
}

export interface SediContextValue {
  sedi: Sede[];
  /**
   * L'ELENCO NON È ARRIVATO — che NON è «non hai sedi».
   *
   * Fino al 2026-08-12 i due casi erano lo stesso valore: `sedi = []`. Con la
   * route non-`ok` o la rete giù, `[]` diceva contemporaneamente «non ho saputo
   * quali sedi hai» e «non ne hai», e l'utente finiva su `SedeNotice` — cioè su
   * un avviso che gli chiedeva di scegliere una sede dal menu in alto, mentre
   * `SedeSelector` con `sedi.length <= 1` non si monta affatto (`cockpit.tsx`).
   * Un'istruzione impossibile da eseguire, su almeno 7 pagine, senza una riga di
   * log da nessuna parte.
   *
   * Questo flag è ciò che separa le due letture di `[]`: quando è vero lo si
   * DICE all'utente e si offre `ricarica()`, invece di chiedergli una scelta.
   */
  errore: boolean;
  selezionate: string[];
  effettive: string[];
  sedeCorrente: string | null;
  reFetchKey: string;
  /**
   * Quante volte l'utente ha cambiato sede in questa sessione. NON cambia al
   * primo caricamento delle sedi accessibili (che pure fa passare `effettive`
   * da [] a N): è la differenza fra «adesso so quali sedi hai» e «hai deciso di
   * guardare un'altra sede», e solo la seconda deve ricaricare il cockpit.
   */
  epocaSede: number;
  loading: boolean;
  toggle: (id: string) => void;
  soloSede: (id: string) => void;
  tutte: () => void;
  /**
   * Ritenta il caricamento delle sedi accessibili. È il «Riprova» di
   * `SedeNotice`: l'unico rimedio che abbia senso offrire quando l'elenco non è
   * arrivato — e uno che RIPROVA per davvero, invece di ricaricare la pagina.
   * NON tocca `epocaSede`: non è un cambio di sede, è lo stesso scope di prima.
   */
  ricarica: () => void;
}

const SediContext = createContext<SediContextValue | null>(null);

// ─── Cookie helpers (client-side; non httpOnly, ri-validato server-side) ──────
function readCookie(): string[] {
  if (typeof document === 'undefined') return [];
  const entry = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`));
  if (!entry) return [];
  const raw = decodeURIComponent(entry.slice(COOKIE.length + 1) ?? '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function writeCookie(ids: string[]) {
  if (typeof document === 'undefined') return;
  // 1 anno; path=/ così viaggia su /api/*; SameSite=Lax. Vuoto = "tutte".
  document.cookie = `${COOKIE}=${encodeURIComponent(ids.join(','))}; path=/; max-age=31536000; samesite=lax`;
}

export function SedeProvider({ children }: { children: React.ReactNode }) {
  // userId dall'identità condivisa del cockpit (niente più lettura duplicata).
  const { userId } = useAdminIdentity();
  const [sedi, setSedi] = useState<Sede[]>([]);
  const [errore, setErrore] = useState(false);
  const [selezionate, setSelezionate] = useState<string[]>(readCookie);
  const [loading, setLoading] = useState(true);
  /** Avanza a ogni «Riprova»: è ciò che fa ripartire la fetch dell'elenco. */
  const [tentativo, setTentativo] = useState(0);
  // Avanza SOLO nelle azioni dell'utente (persist/toggle), mai nel caricamento
  // iniziale delle sedi: vedi `epocaSede` in SediContextValue.
  const [epocaSede, setEpocaSede] = useState(0);

  /**
   * Carica le sedi accessibili — e dice quando NON ci è riuscito.
   *
   * ─── LA FORMA, E PERCHÉ È QUESTA ────────────────────────────────────────
   *
   * `guasto` parte da `true` e diventa `false` SOLO quando la risposta è
   * arrivata ed era buona. Sembra al contrario, e invece è l'unico modo di
   * tenere insieme due vincoli che si scontrano:
   *
   *  · `react-hooks/set-state-in-effect` (react-hooks 7, severità error) vieta
   *    il `setState` dentro un `catch` di una async chiamata dall'effetto — è
   *    la ragione per cui questo blocco era nato `try/finally` senza `catch`,
   *    ed è la ragione per cui il ramo d'errore era muto;
   *  · un guasto NON può passare per uno stato normale (AGENTS.md §6).
   *
   * Il `finally` gira PRIMA che l'eccezione si propaghi: quando la fetch lancia,
   * lo stato d'errore è già committato quando il rigetto esce. Al `run()` resta
   * solo da LOGGARE, e lo fa il `.catch` qui sotto — che è anche ciò che
   * raccoglie il rigetto (`void run()` da solo lo lasciava uscire come
   * `unhandledrejection`, misurato: `TypeError: Failed to fetch`; nella WebView
   * quello diventa un `pageerror` che accusa la pagina invece della rete).
   */
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      let list: Sede[] = [];
      let guasto = true;
      try {
        const res = await fetch('/api/admin/sedi', {
          headers: userId ? { 'x-user-id': userId } : undefined,
        });
        if (res.ok) {
          const d = await res.json();
          const arr = Array.isArray(d) ? d : d?.data ?? [];
          list = (arr as Sede[]).filter((s) => s && s.id);
          guasto = false;
        } else {
          // `!res.ok` NON è un'eccezione: nessun `catch` scatterebbe, e fin qui
          // un 500 su questa route era indistinguibile da «non hai sedi».
          // Niente `route`: `logClient` ripiega su `location.pathname`, che dice
          // su QUALE pagina del cockpit l'utente è rimasto bloccato — l'unico
          // che lo sappia è il client, e questo è l'ultimo punto in cui lo sa.
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: 'sedi-accessibili-non-caricate',
            stato: res.status,
          });
        }
      } finally {
        if (!cancelled) {
          setSedi(list);
          setErrore(guasto);
          // Scarta dal cookie sedi non più accessibili (cookie stantìo) — ma
          // SOLO su un elenco attendibile. Potare su `[]` per errore
          // significherebbe cancellare la sede che l'utente aveva scelto:
          // tornata la rete si ritroverebbe l'avviso di scelta al posto della
          // sua sede, e il guasto di rete avrebbe cambiato le sue preferenze.
          if (!guasto) {
            const accessibili = new Set(list.map((s) => s.id));
            setSelezionate((prev) => prev.filter((id) => accessibili.has(id)));
          }
          setLoading(false);
        }
      }
    };
    void run().catch((e: unknown) => {
      // La fetch ha lanciato (rete giù, DNS, CORS) o il corpo era illeggibile.
      // Lo stato d'errore l'ha già scritto il `finally`; qui si LOGGA e si
      // RACCOGLIE il rigetto. Un `catch` che non logga è un bug — e questo è il
      // guasto che per mesi ha chiuso fuori la Direzione senza lasciare traccia.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `sedi-accessibili-non-caricate: ${nomeErrore(e)}`,
        stack: e instanceof Error ? e.stack : undefined,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, tentativo]);

  /** «Riprova»: rimette lo stato in caricamento e rifà la richiesta. */
  const ricarica = useCallback(() => {
    setLoading(true);
    setErrore(false);
    setTentativo((n) => n + 1);
  }, []);

  const persist = useCallback((ids: string[]) => {
    // Se coincide con "tutte" le accessibili, memorizzo vuoto (= nessun filtro).
    setSelezionate(ids);
    writeCookie(ids);
    setEpocaSede((n) => n + 1);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      setSelezionate((prev) => {
        const has = prev.includes(id);
        const next = has ? prev.filter((x) => x !== id) : [...prev, id];
        // Se ho selezionato tutte le sedi accessibili, normalizzo a [] (= tutte).
        const tutteAcc = sedi.length > 0 && next.length === sedi.length;
        const finale = tutteAcc ? [] : next;
        writeCookie(finale);
        return finale;
      });
      setEpocaSede((n) => n + 1);
    },
    [sedi]
  );

  const soloSede = useCallback((id: string) => persist([id]), [persist]);
  const tutte = useCallback(() => persist([]), [persist]);

  const value = useMemo<SediContextValue>(() => {
    const ids = sedi.map((s) => s.id);
    const set = new Set(ids);
    const validSel = selezionate.filter((id) => set.has(id));
    const effettive = validSel.length > 0 ? validSel : ids;
    const sedeCorrente = effettive.length === 1 ? effettive[0] : null;
    return {
      sedi,
      errore,
      selezionate: validSel,
      effettive,
      sedeCorrente,
      reFetchKey: effettive.join(','),
      epocaSede,
      loading,
      toggle,
      soloSede,
      tutte,
      ricarica,
    };
  }, [sedi, errore, selezionate, epocaSede, loading, toggle, soloSede, tutte, ricarica]);

  return <SediContext.Provider value={value}>{children}</SediContext.Provider>;
}

/** Hook per leggere le sedi attive. Deve stare dentro <SedeProvider>. */
export function useSediAttive(): SediContextValue {
  const ctx = useContext(SediContext);
  if (!ctx) throw new Error('useSediAttive deve essere usato dentro <SedeProvider>');
  return ctx;
}

/**
 * Confine di ri-caricamento del cockpit al cambio di sede.
 *
 * PERCHÉ ESISTE. `reFetchKey` era nato come convenzione — «mettilo nelle deps
 * dei tuoi useEffect» — e su tutto il cockpit lo referenziavano DUE file. Le
 * altre pagine (dashboard, avvisi, messaggi, staff, sezioni, protocolli…)
 * scaricano con dipendenze `[userId]`, `[tab]` o `[]`: dopo un cambio di sede
 * restavano sui dati della sede precedente, senza dirlo. In home convivevano
 * due numeri di alunni diversi, e quello grande — quello che si legge — era di
 * un'altra sede. Una convenzione che nessuno può far rispettare non è un
 * meccanismo: qui il ri-caricamento diventa STRUTTURALE. Cambiata la sede, il
 * contenuto viene smontato e rimontato, quindi OGNI effetto di caricamento
 * riparte, qualunque siano le sue dipendenze.
 *
 * La chiave è `epocaSede` e non `reFetchKey` di proposito: `reFetchKey` cambia
 * anche quando arrivano le sedi accessibili (da `[]` a N) subito dopo il primo
 * render, e userebbe un rimontaggio — cioè un doppio caricamento — all'apertura
 * di ogni pagina.
 *
 * Sta DENTRO il provider e sopra il solo contenuto (`<main>`), non sopra la
 * shell: topbar, sidebar e bottom-nav non devono sbattere le palpebre — e il
 * menu da cui hai appena scelto la sede deve restare aperto.
 */
export function SedeScopeBoundary({ children }: { children: React.ReactNode }) {
  const { epocaSede } = useSediAttive();
  return <Fragment key={epocaSede}>{children}</Fragment>;
}

/**
 * Avviso "seleziona una sola sede" per le pagine mono-sede quando sono attive
 * più sedi (selezione ambigua). Specchia lato UI il 400 di `resolveScuolaScrittura`.
 *
 * È AZIONABILE. Fino al 2026-07-31 diceva «scegline una sola dal menu in alto»,
 * ma sotto i 1024px quel menu non esisteva: sul telefono e nell'app nativa
 * l'avviso chiedeva una cosa impossibile, e con tre sedi in produzione questo
 * chiudeva fuori l'intera Direzione da sei pagine e da ogni scrittura. I bottoni
 * qui sotto rendono la scelta possibile OVUNQUE l'avviso compaia, che ci sia o
 * no un selettore nei paraggi.
 */
export function SedeNotice({ cosa }: { cosa?: string }) {
  const t = useTranslations('shared');
  const { sedi, errore, soloSede, ricarica } = useSediAttive();

  /*
   * L'ELENCO NON È ARRIVATO — e allora si dice quello, non «scegline una».
   *
   * Prima del 2026-08-12 questo caso finiva nel ramo `sedi.length <= 1` qui
   * sotto: «Hai più sedi attive. Scegline una sola dal menu in alto», senza
   * bottoni (li dipinge solo `sedi.length > 1`) e senza quel menu (con `sedi`
   * vuoto `SedeSelector` non si monta). Tre frasi, tutte false, e nessuna
   * eseguibile: chi le leggeva poteva solo ricaricare la pagina alla cieca.
   *
   * `role="alert"`: è un guasto sopraggiunto, e va annunciato anche a chi non
   * guarda lo schermo. Gli altri due rami restano senza — lì non è successo
   * niente di anomalo, c'è solo una scelta da fare.
   */
  if (errore) {
    return (
      <div role="alert" className="rounded-2xl border border-kidville-line bg-kidville-white p-8 text-center">
        <p className="font-barlow text-lg font-extrabold uppercase text-kidville-green">{t('sedeNoticeErroreTitolo')}</p>
        {/* `sub` e non `muted`: il debito di `text-kidville-muted` si smaltisce e non
            si rifinanzia (lock `__tests__/a11y/testo-muted-allowlist.test.ts`), e per un
            testo che spiega un guasto il contrasto conta il doppio. */}
        <p className="mt-2 font-maven text-[14px] text-kidville-sub">{t('sedeNoticeErroreCorpo')}.</p>
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={ricarica}
            className="min-h-[44px] rounded-full bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-white transition-colors hover:bg-kidville-green-dark"
          >
            {t('sedeNoticeRiprova')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-kidville-line bg-kidville-white p-8 text-center">
      <p className="font-barlow text-lg font-extrabold uppercase text-kidville-green">{t('selezionaUnaSede')}</p>
      <p className="mt-2 font-maven text-[14px] text-kidville-muted">
        {sedi.length > 1 ? (
          t('sedeNoticeScegliQui')
        ) : (
          t.rich('sedeNoticeCorpo', { strong: (chunks) => <strong>{chunks}</strong> })
        )}
        {/* La clausola «per gestire {cosa}» è opzionale; `cosa` arriva già tradotto
            dal namespace della pagina chiamante. Il punto finale resta sempre fuori. */}
        {cosa ? <> {t('sedeNoticePerGestire', { cosa })}</> : null}.
      </p>
      {sedi.length > 1 && (
        <div role="group" aria-label={t('selezionaUnaSede')} className="mt-4 flex flex-wrap justify-center gap-2">
          {sedi.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => soloSede(s.id)}
              className="min-h-[44px] rounded-full bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-white transition-colors hover:bg-kidville-green-dark"
            >
              {s.nome}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Guard per le pagine di CONFIGURAZIONE mono-sede (pagamenti, mensa, modulistica,
 * primaria, impostazioni): queste operano su UNA sede alla volta. Rende i figli
 * solo quando è attiva una singola sede, passandone l'id via render-prop; se sono
 * selezionate più sedi (ambiguo) mostra `SedeNotice`. Con una sola sede accessibile
 * è sempre "pronto".
 */
export function SedeRequired({
  cosa,
  children,
}: {
  cosa?: string;
  children: (scuolaId: string) => React.ReactNode;
}) {
  const { sedeCorrente, loading } = useSediAttive();
  const t = useTranslations('shared');
  if (loading) {
    return <div className="p-8 font-maven text-kidville-muted">{t('caricamentoPuntini')}</div>;
  }
  if (!sedeCorrente) {
    return <SedeNotice cosa={cosa} />;
  }
  return <>{children(sedeCorrente)}</>;
}
