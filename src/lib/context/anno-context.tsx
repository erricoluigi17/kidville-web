'use client';

/**
 * Contesto dell'ANNO SCOLASTICO scelto dal cockpit Direzione/Segreteria (PR 4.2).
 *
 * Imita `sede-context.tsx` (cookie, epoca, potatura solo su elenco attendibile) ma NON scarica niente:
 * la fonte è il `CalendarioProvider` della 4.1 (`useCalendario`), le sedi attive sono quelle di
 * `SedeProvider`. Va montato DENTRO entrambi.
 *
 * Il cookie `anno_attivo` contiene `anni_scolastici.id` (non `anni_sede.id`: l'anno è lo stesso per tutte
 * le sedi, quindi la scelta vale anche con più sedi attive). Non è un segreto: il server lo ri-valida
 * (`resolveAnnoScrittura`/`resolveAnnoLettura` in @/lib/auth/scope, che esporta la stessa costante: un
 * test li tiene allineati — qui non si importa scope.ts perché porterebbe codice server nel client).
 *
 * Espone:
 *  - `anni`       → gli anni scegliibili, dal più recente. Con UNA sede sono i suoi; con più sedi
 *                   l'INTERSEZIONE (quelli che le hanno tutte) e `annoSedeId` è `null`;
 *  - `selezionato`→ l'anno scelto dall'utente, `null` se non ha scelto (o se la scelta non è più valida);
 *  - `effettivo`  → l'anno su cui si lavora: la scelta, altrimenti l'anno attivo della sede. Con più sedi
 *                   e nessuna scelta è `null`: ogni sede usa il proprio anno attivo;
 *  - `eAttivo`    → `false` solo se si guarda un anno diverso da quello attivo (accende `AnnoNotice`);
 *  - `epocaAnno`  → avanza SOLO quando l'utente sceglie: è la chiave di `<AnnoScopeBoundary>`;
 *  - `ricarica`   → rilegge il calendario (lo userà la sezione «Anno scolastico» dopo un salvataggio).
 */

import { Fragment, createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { annoAttivoDelCalendario, etichettaAnno, type Calendario } from '@/lib/anno-scolastico';
import type { StatoAnno } from '@/lib/anno/tipi';
import { logClient } from '@/lib/logging/client';
import { useRuoloCockpit } from './admin-identity';
import { useCalendario } from './calendario-context';
import { useSediAttive } from './sede-context';

/** Lo stesso nome di `COOKIE_ANNO` in @/lib/auth/scope (lato server). */
export const COOKIE_ANNO_CLIENT = 'anno_attivo';
const SETTE_GIORNI = 604800;
/** Chi sceglie l'anno: Direzione e segreteria. Docenti e genitori lavorano sempre sull'anno attivo. */
const RUOLI_CHE_SCELGONO = new Set(['admin', 'coordinator', 'segreteria']);
const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AnnoScelta {
  annoId: string;
  /** `anni_sede.id`; `null` con più sedi attive (ogni sede ha la sua riga). */
  annoSedeId: string | null;
  annoInizio: number;
  etichetta: string;
  etichettaBreve: string;
  stato: StatoAnno;
  attivo: boolean;
}

export interface AnnoContextValue {
  anni: AnnoScelta[];
  selezionato: string | null;
  effettivo: AnnoScelta | null;
  eAttivo: boolean;
  epocaAnno: number;
  loading: boolean;
  errore: boolean;
  scegli(annoId: string): void;
  usaAttivo(): void;
  ricarica(): void;
}

const AnnoContext = createContext<AnnoContextValue | null>(null);

// ─── Cookie (client-side; non httpOnly, ri-validato dal server) ──────────────
function leggiCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const voce = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE_ANNO_CLIENT}=`));
  const raw = voce ? decodeURIComponent(voce.slice(COOKIE_ANNO_CLIENT.length + 1)).trim() : '';
  return FORMA_UUID.test(raw) ? raw.toLowerCase() : null;
}

function scriviCookie(annoId: string) {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE_ANNO_CLIENT}=${annoId}; path=/; samesite=lax; max-age=${SETTE_GIORNI}`;
}

function cancellaCookie() {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE_ANNO_CLIENT}=; path=/; samesite=lax; max-age=0`;
}

// ─── Gli anni scegliibili ────────────────────────────────────────────────────
function calcolaAnni(sedi: string[], perSede: Record<string, Calendario>): AnnoScelta[] {
  if (sedi.length === 0) return [];
  const calendari: Calendario[] = [];
  for (const s of sedi) {
    const cal = perSede[s];
    // Una sede senza calendario (database non migrato, risposta mancante) non ha anni in comune con nessuna.
    if (!cal) return [];
    calendari.push(cal);
  }
  const attiviDelleSedi = calendari.map((cal) => annoAttivoDelCalendario(cal)?.annoId ?? null);
  const comuni = calendari[0].filter((r) =>
    calendari.every((cal) => cal.some((x) => x.annoId === r.annoId)),
  );
  const unaSola = sedi.length === 1;
  return comuni
    .map<AnnoScelta>((r) => ({
      annoId: r.annoId,
      annoSedeId: unaSola ? r.annoSedeId : null,
      annoInizio: r.annoInizio,
      etichetta: etichettaAnno(r.annoInizio, 'estesa'),
      etichettaBreve: etichettaAnno(r.annoInizio, 'breve'),
      // Con più sedi lo stato è quello della prima: l'avviso lo mostra, non decide nulla.
      stato: r.stato,
      attivo: attiviDelleSedi.every((a) => a === r.annoId),
    }))
    .sort((a, b) => b.annoInizio - a.annoInizio);
}

export function AnnoProvider({ children }: { children: React.ReactNode }) {
  const { perSede, loading: caricaCalendario, errore: erroreCalendario, ricarica } = useCalendario();
  const { effettive, loading: caricaSedi, errore: erroreSedi } = useSediAttive();
  const [scelto, setScelto] = useState<string | null>(leggiCookie);
  const [epocaAnno, setEpocaAnno] = useState(0);

  const anni = useMemo(() => calcolaAnni(effettive, perSede), [effettive, perSede]);

  /*
   * Cookie stantio (un anno che non è più nell'elenco: la `DELETE` fatta dal titolare in Demo, oppure una
   * sede senza quell'anno dopo un cambio sede). Lo si pota SOLO su un elenco attendibile: potare su `[]`
   * per un errore di rete cancellerebbe la scelta dell'utente.
   *
   * È fatto durante il render, e non in un effetto, per due motivi: la regola `set-state-in-effect`, e
   * l'ordine degli effetti — quelli dei figli girano PRIMA di quelli del genitore, quindi dopo un cambio
   * sede le pagine rimontate scaricherebbero ancora col cookie stantio (403 ANNO_NON_ACCESSIBILE).
   * È idempotente: dipende solo dai dati.
   */
  const attendibile = !caricaCalendario && !erroreCalendario && !caricaSedi && !erroreSedi && effettive.length > 0;
  if (attendibile && scelto !== null && !anni.some((a) => a.annoId === scelto)) {
    cancellaCookie();
    setScelto(null);
  }

  const scegli = useCallback(
    (annoId: string) => {
      if (!anni.some((a) => a.annoId === annoId)) {
        logClient({ livello: 'warn', evento: 'react', messaggio: 'anno-scelta-fuori-elenco' });
        return;
      }
      setScelto(annoId);
      scriviCookie(annoId);
      setEpocaAnno((n) => n + 1);
    },
    [anni],
  );

  const usaAttivo = useCallback(() => {
    setScelto(null);
    cancellaCookie();
    setEpocaAnno((n) => n + 1);
  }, []);

  const value = useMemo<AnnoContextValue>(() => {
    const scelta = scelto ? (anni.find((a) => a.annoId === scelto) ?? null) : null;
    const attivoComune = anni.find((a) => a.attivo) ?? null;
    const effettivo = scelta ?? (effettive.length === 1 ? attivoComune : null);
    return {
      anni,
      selezionato: scelta?.annoId ?? null,
      effettivo,
      eAttivo: effettivo ? effettivo.attivo : true,
      epocaAnno,
      loading: caricaCalendario || caricaSedi,
      errore: erroreCalendario,
      scegli,
      usaAttivo,
      ricarica,
    };
  }, [anni, scelto, effettive.length, epocaAnno, caricaCalendario, caricaSedi, erroreCalendario, scegli, usaAttivo, ricarica]);

  return <AnnoContext.Provider value={value}>{children}</AnnoContext.Provider>;
}

/** Deve stare dentro <AnnoProvider>. */
export function useAnno(): AnnoContextValue {
  const ctx = useContext(AnnoContext);
  if (!ctx) throw new Error('useAnno deve essere usato dentro <AnnoProvider>');
  return ctx;
}

/** `null` fuori dal provider: docenti e genitori non ne hanno uno, e i componenti non montano nulla. */
export function useAnnoOpzionale(): AnnoContextValue | null {
  return useContext(AnnoContext);
}

/**
 * Confine di ri-caricamento al cambio di anno, gemello di `SedeScopeBoundary`: cambiato l'anno il
 * contenuto si smonta e si rimonta, così ogni pagina riscarica. La chiave è `epocaAnno` e non l'anno
 * effettivo: il primo caricamento del calendario (da nessun anno a N) non deve rimontare nulla.
 */
export function AnnoScopeBoundary({ children }: { children: React.ReactNode }) {
  const { epocaAnno } = useAnno();
  return <Fragment key={epocaAnno}>{children}</Fragment>;
}

/** `true` per chi può scegliere l'anno. `''` (ruolo non ancora arrivato) nasconde, come gli altri comandi riservati. */
export function useVedeAnno(): boolean {
  return RUOLI_CHE_SCELGONO.has(useRuoloCockpit());
}

/** Lo stato di un anno in parole (non solo colore). */
export function useTestoStatoAnno(): (stato: StatoAnno) => string {
  const t = useTranslations('shared');
  return useCallback(
    (stato: StatoAnno) => {
      switch (stato) {
        case 'corrente':
          return t('annoStatoInCorso');
        case 'in_chiusura':
          return t('annoStatoInChiusura');
        case 'iscrizioni_aperte':
          return t('annoStatoIscrizioniAperte');
        case 'in_preparazione':
          return t('annoStatoInPreparazione');
        case 'chiuso':
          return t('annoStatoChiuso');
      }
    },
    [t],
  );
}

/**
 * Avviso persistente: si guarda un anno che non è quello attivo. In flusso, non si chiude — sparisce solo
 * tornando all'anno in corso (`usaAttivo`). Lo vedono Direzione e segreteria; senza `AnnoProvider` (docenti,
 * genitori) non monta nulla.
 */
export function AnnoNotice() {
  const ctx = useAnnoOpzionale();
  const visibile = useVedeAnno();
  const t = useTranslations('shared');
  const testoStato = useTestoStatoAnno();
  if (!ctx || !visibile || !ctx.effettivo || ctx.eAttivo) return null;
  const { effettivo } = ctx;
  const stato = effettivo.stato === 'chiuso' ? t('annoAvvisoChiusoDettaglio') : testoStato(effettivo.stato);
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-kidville-line bg-kidville-yellow-soft px-4 py-2.5 font-maven text-[14px] text-kidville-ink"
    >
      <p>{t('annoAvvisoTesto', { anno: effettivo.etichettaBreve, stato })}</p>
      <button
        type="button"
        onClick={ctx.usaAttivo}
        className="min-h-[44px] rounded-full bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-white transition-colors hover:bg-kidville-green-dark"
      >
        {t('annoAvvisoTorna')}
      </button>
    </div>
  );
}
