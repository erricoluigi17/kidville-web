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
 *  - `anni`       → gli anni selezionabili (senza i `chiuso`, fino alla 4.9), dal più recente. Con UNA sede sono i suoi; con più sedi
 *                   l'INTERSEZIONE (quelli che le hanno tutte) e `annoSedeId` è `null`;
 *  - `selezionato`→ l'anno scelto dall'utente, `null` se non ha scelto (o se la scelta non è più valida);
 *  - `effettivo`  → l'anno su cui si lavora: la scelta, altrimenti l'anno attivo della sede. Con più sedi
 *                   e nessuna scelta è `null`: ogni sede usa il proprio anno attivo;
 *  - `eAttivo`    → `false` solo se si guarda un anno diverso da quello attivo (accende `AnnoNotice`);
 *  - `epocaAnno`  → avanza SOLO quando l'utente sceglie: è la chiave di `<AnnoScopeBoundary>`;
 *  - `ricarica`   → rilegge il calendario (lo userà la sezione «Anno scolastico» dopo un salvataggio).
 */

import { Fragment, createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { annoAttivoDelCalendario, etichettaAnno, type Calendario } from '@/lib/anno-scolastico';
import type { StatoAnno } from '@/lib/anno/tipi';
import { logClient } from '@/lib/logging/client';
import { AvvisoAnnoInChiusura } from '@/components/features/anno/AvvisoAnnoInChiusura';
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
  /** Lo stato dell'anno; con più sedi attive, quello comune a tutte. `null` se le sedi non concordano. */
  stato: StatoAnno | null;
  /** È l'anno attivo (con più sedi: in TUTTE). */
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

// ─── Gli anni selezionabili ────────────────────────────────────────────────────
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
  // Gli anni `chiuso` non si scelgono (fino alla 4.9): scrivere lì vorrebbe una correzione con un motivo, che
  // non esiste ancora, e la scrittura finirebbe nell'anno sbagliato senza che nessuno se ne accorga. Un anno
  // chiuso anche in UNA sola delle sedi attive esce dalle scelte comuni. Un cookie rimasto su un anno così non
  // è più nell'elenco, quindi lo pota la stessa regola di qualunque anno che non c'è più.
  const comuni = calendari[0].filter((r) =>
    calendari.every((cal) => cal.some((x) => x.annoId === r.annoId && x.stato !== 'chiuso')),
  );
  const unaSola = sedi.length === 1;
  return comuni
    .map<AnnoScelta>((r) => ({
      annoId: r.annoId,
      annoSedeId: unaSola ? r.annoSedeId : null,
      annoInizio: r.annoInizio,
      etichetta: etichettaAnno(r.annoInizio, 'estesa'),
      etichettaBreve: etichettaAnno(r.annoInizio, 'breve'),
      // Con più sedi lo stato è quello COMUNE; se le sedi non concordano è `null`, e chi lo mostra scrive
      // una dicitura neutra invece di uno stato preso a caso.
      stato: calendari.every((cal) => cal.find((x) => x.annoId === r.annoId)?.stato === r.stato) ? r.stato : null,
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
   * DUE PEZZI, perché sono due cose diverse:
   *  · lo STATO (`scelto`) si azzera durante il render, col pattern «aggiusta lo stato quando cambiano i
   *    dati» (condizionato, converge subito): niente effetto che copia stato, e una scelta potata non
   *    risorge se più tardi quell'anno ricompare nell'elenco;
   *  · il COOKIE si cancella in un `useLayoutEffect`, non in un `useEffect`: gli effetti di layout di un
   *    commit girano tutti PRIMA di quelli passivi, e le pagine rimontate da `SedeScopeBoundary` scaricano
   *    in un `useEffect` passivo. Con un `useEffect` qui dopo un cambio sede scaricherebbero ancora col
   *    cookie stantio (403 ANNO_NON_ACCESSIBILE). L'effetto non fa `setState`: legge il cookie e lo
   *    confronta con l'elenco, quindi è idempotente (e copre anche un cookie scritto da un'altra scheda).
   */
  // Ogni sede attiva deve avere un calendario CON righe: il calendario può rispondere senza errore e senza
  // righe per una sede (`fonte: 'non_disponibile'`, zero righe valide, sede aggiunta dopo il primo
  // caricamento), e un elenco vuoto così non è un elenco.
  const attendibile =
    !caricaCalendario &&
    !erroreCalendario &&
    !caricaSedi &&
    !erroreSedi &&
    effettive.length > 0 &&
    effettive.every((s) => (perSede[s]?.length ?? 0) > 0);
  if (attendibile && scelto !== null && !anni.some((a) => a.annoId === scelto)) {
    setScelto(null);
    // Le pagine montate hanno letto (o stanno leggendo) con l'anno sparito: senza far avanzare l'epoca restano
    // lì fino alla prossima navigazione. Dalla 4.3 le liste filtrano per anno, e si vedrebbe.
    setEpocaAnno((n) => n + 1);
  }
  useLayoutEffect(() => {
    if (!attendibile) return;
    const nelCookie = leggiCookie();
    if (nelCookie !== null && !anni.some((a) => a.annoId === nelCookie)) cancellaCookie();
  }, [attendibile, anni]);

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

  const selezionato = scelto !== null && anni.some((a) => a.annoId === scelto) ? scelto : null;
  const usaAttivo = useCallback(() => {
    // Senza una scelta in corso il predefinito c'è già: niente cookie da cancellare, niente rimontaggio.
    if (selezionato === null) return;
    setScelto(null);
    cancellaCookie();
    setEpocaAnno((n) => n + 1);
  }, [selezionato]);

  const value = useMemo<AnnoContextValue>(() => {
    const scelta = selezionato ? (anni.find((a) => a.annoId === selezionato) ?? null) : null;
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
  }, [anni, selezionato, effettive.length, epocaAnno, caricaCalendario, caricaSedi, erroreCalendario, scegli, usaAttivo, ricarica]);

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
  return puoScegliAnno(useRuoloCockpit());
}

/** Per chi ha già il ruolo in mano (il foglio «Menu» lo riceve come prop). */
export function puoScegliAnno(ruolo: string): boolean {
  return RUOLI_CHE_SCELGONO.has(ruolo);
}

/** Lo stato di un anno in parole (non solo colore). */
export function useTestoStatoAnno(): (stato: StatoAnno | null) => string {
  const t = useTranslations('shared');
  return useCallback(
    (stato: StatoAnno | null) => {
      switch (stato) {
        case null:
          return t('annoStatoDiverso');
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
 * Avviso persistente: si lavora su un anno che non è quello attivo. Dice la verità della 4.2: cambiano solo le
 * NUOVE registrazioni (classi, votazioni, elenchi caricati); gli elenchi mostrano ancora l'anno in corso. In flusso, non si chiude — sparisce solo
 * tornando all'anno in corso (`usaAttivo`). Lo vedono Direzione e segreteria; senza `AnnoProvider` (docenti,
 * genitori) non monta nulla.
 */
export function AnnoNotice() {
  const ctx = useAnnoOpzionale();
  const visibile = useVedeAnno();
  const t = useTranslations('shared');
  const testoStato = useTestoStatoAnno();
  const [perche, setPerche] = useState(false);
  if (!ctx || !visibile || !ctx.effettivo) return null;
  const { effettivo } = ctx;
  // PR 4.9: l'anno che si sta guardando è `in_chiusura` o `chiuso` (anche se è l'anno attivo): una riga fissa, in flusso, che lo dice.
  const inChiusura = effettivo.stato === 'in_chiusura' || effettivo.stato === 'chiuso';
  const rigaChiusura = inChiusura ? <AvvisoAnnoInChiusura etichetta={effettivo.etichetta} /> : null;
  if (ctx.eAttivo) {
    return rigaChiusura ? <div className="px-4 pt-3">{rigaChiusura}</div> : null;
  }
  // `stato` è `null` quando le sedi attive non concordano: dicitura neutra (nel testo di `testoStato`).
  const stato = testoStato(effettivo.stato);
  // In FLUSSO (mai `fixed`): spinge giù il contenuto invece di coprirlo. `sticky` perché resti visibile
  // scorrendo, appoggiato sotto la barra: sul telefono quella verde (`--kv-appbar-h`), da 744 px la
  // topbar desktop alta 64 px (`top-16`, la stessa che regge il binario e la sidebar). `z-30`: sotto le
  // barre (z-40 / z-105) e i fogli (z-110).
  return (
    <>
    <div
      role="status"
      data-kv-anno-avviso
      className="sticky top-[var(--kv-appbar-h)] z-30 flex flex-wrap tablet:top-16 items-center justify-between gap-x-3 gap-y-1 border-b border-kidville-line bg-kidville-yellow-soft px-4 py-2 font-maven text-[14px] text-kidville-ink min-[640px]:py-2.5"
    >
      {/* Sotto i 640px (telefono) compatto: sopra l'anno guardato e il suo stato, sotto «Perché?» (il testo
          lungo sta lì dietro) e il pulsante per tornare. `basis-full` costringe il pulsante ad andare a capo
          invece di schiacciare il testo (con `flex-1` da solo restavano ~106px a 390 e ~36px a 320).
          Da 640px in su l'avviso è quello intero di sempre, testo e pulsante sulla stessa riga. */}
      <div className="min-w-0 basis-full min-[640px]:flex-1 min-[640px]:basis-0">
        <p>
          <span className="min-[640px]:hidden">{t('annoAvvisoBreve', { anno: effettivo.etichettaBreve, stato })}</span>
          <span className="hidden min-[640px]:inline">{t('annoAvvisoTesto', { anno: effettivo.etichettaBreve, stato })}</span>
        </p>
        {perche && (
          <p id="kv-anno-avviso-perche" className="mt-1 text-[13px] min-[640px]:hidden">
            {t('annoAvvisoPercheTesto', { anno: effettivo.etichettaBreve })}
          </p>
        )}
      </div>
      {/* Area di tocco di 44px per COSTRUZIONE (min-h), non per un'estensione che dipende dal font: sta sulla sua
          riga accanto a «Torna» (o sopra, a 320px) e le due aree non si sovrappongono mai. */}
      <button
        type="button"
        onClick={() => setPerche((v) => !v)}
        aria-expanded={perche}
        aria-controls="kv-anno-avviso-perche"
        className="min-h-[44px] px-2 font-bold underline min-[640px]:hidden"
      >
        {t('annoAvvisoPerche')}
      </button>
      <button
        type="button"
        onClick={ctx.usaAttivo}
        className="min-h-[44px] rounded-full bg-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase text-kidville-white transition-colors hover:bg-kidville-green-dark"
      >
        {t('annoAvvisoTorna')}
      </button>
    </div>
    {rigaChiusura ? <div className="px-4 pt-3">{rigaChiusura}</div> : null}
    </>
  );
}
