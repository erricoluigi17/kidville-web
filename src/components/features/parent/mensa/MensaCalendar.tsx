'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { motion } from 'framer-motion';
import { Ticket, ChevronLeft, ChevronRight, Check, X, Lock, CalendarOff, UtensilsCrossed, RefreshCw, AlertTriangle, Clock, LogIn } from 'lucide-react';
import { allergeniDelGiorno, useAllergeneLabel, allergeneEmoji, type AllergeniPortate } from '@/lib/mensa/allergeni';
import { SaveCelebration } from '@/components/ui/SaveConfirmation';
import { OfflineBadge } from '@/components/ui/OfflineBadge';
import { logClient } from '@/lib/logging/client';
import { fetchConCache } from '@/lib/offline/read-cache';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { fetchFigliIds } from '@/lib/auth/use-parent-identity';
import { entroCutoff, oggiRoma } from '@/lib/mensa/cutoff';
// `HH:MM:SS` della colonna `time` → `HH:MM` per il testo: un lettore solo degli
// orari (lo stesso modulo su cui poggia `@/lib/mensa/cutoff`), che rifiuta anche
// un orario fuori scala invece di stamparlo.
import { oraDiRoma } from '@/lib/presenze/orario';

interface Props { userId: string; studentId: string }

/** Errore d'autenticazione della mensa, distinto per poter mostrare l'azione giusta. */
type AuthError = { tipo: 'scaduta' } | { tipo: 'nonCollegato' };

/** Azione da intraprendere in base allo status della GET prenotazioni. */
export type AzioneMensaAuth =
  | { tipo: 'ok' }                // nessun problema d'auth
  | { tipo: 'sessioneScaduta' }   // 401 → serve un nuovo accesso
  | { tipo: 'autorecupero' }      // 403 primo tentativo → prova a recuperare il figlio giusto
  | { tipo: 'nonCollegato' };     // 403 dopo il recupero → l'alunno non è collegato

/**
 * Classifica lo status della GET /api/mensa/prenotazioni. PURA e testabile.
 * 401 = sessione scaduta (colpa dell'auth). 403 = genitoreHasFiglio ha negato:
 * l'alunno richiesto non è (più) tra i figli del genitore → un solo autorecupero,
 * poi si è onesti sul fatto che l'alunno non risulta collegato.
 */
export function decidiAzioneMensaAuth(status: number, recuperoGiaTentato: boolean): AzioneMensaAuth {
  if (status === 401) return { tipo: 'sessioneScaduta' };
  if (status === 403) return recuperoGiaTentato ? { tipo: 'nonCollegato' } : { tipo: 'autorecupero' };
  return { tipo: 'ok' };
}

interface Portate { primo?: string; secondo?: string; contorno?: string; frutta?: string }
interface MenuGiorno { data: string; attivo: boolean; chiuso: boolean; portate: Portate | null; ingredienti?: Portate | null; allergeni?: AllergeniPortate | null; note?: string | null }
interface Prenotazione { data: string; stato: string; origine: string }
/** Forma della risposta di GET /api/mensa/menu (per la cache offline tipizzata). */
interface MenuResponse { success: boolean; data: MenuGiorno[]; meta?: { menuNome?: string | null } | null }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function lunediDella(d: Date): Date {
  const x = new Date(d);
  const wd = x.getDay() === 0 ? 7 : x.getDay();
  x.setDate(x.getDate() - (wd - 1));
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** Il codice con cui il server rifiuta un giorno passato o «oggi» dopo l'orario limite. */
const CODICE_OLTRE_CUTOFF = 'MENSA_OLTRE_CUTOFF';

/**
 * Ogni quanto si ricontrolla l'orologio mentre la pagina resta aperta. Il blocco
 * di «oggi» scatta al minuto del cutoff: 30 s di ritardo al massimo, e il
 * ricontrollo al tocco (in `prenota`/`disdici`) chiude anche quella finestra.
 */
export const RICONTROLLO_CUTOFF_MS = 30_000;

/**
 * Perché il genitore non può più prenotare/disdire quel giorno. PURA e testabile.
 *   - `'passato'`     → la data è prima di oggi nel calendario di ROMA: sempre bloccata;
 *   - `'oltreCutoff'` → è oggi (a Roma) e l'ora italiana ha superato il cutoff;
 *   - `null`          → prenotabile/disdicibile.
 * Stessa regola del server (`entroCutoff` di `@/lib/mensa/cutoff`, un modulo solo),
 * così il pulsante non resta acceso su una data che la route rifiuterebbe.
 * Senza `cutoffOra` (GET non ancora arrivata o senza sede) «oggi» NON si blocca qui:
 * lo schermo non inventa un orario, e il server resta comunque l'arbitro.
 */
export function bloccoGiorno(data: string, cutoffOra: string | null, adesso: Date): 'passato' | 'oltreCutoff' | null {
  const oggi = oggiRoma(adesso);
  if (data < oggi) return 'passato';
  if (data === oggi && cutoffOra && !entroCutoff(data, cutoffOra, adesso)) return 'oltreCutoff';
  return null;
}

/**
 * Autorecupero dopo un 403: la cache può puntare a un alunno non più collegato.
 * Pulisce kv_student_id e ri-risolve il primo figlio reale del genitore. Ritorna
 * null se non ce ne sono o la rete è giù (fetchFigliIds non lancia mai).
 */
async function recuperaPrimoFiglio(parentId: string): Promise<string | null> {
  try { localStorage.removeItem('kv_student_id'); } catch { /* ignore */ }
  const ids = await fetchFigliIds(parentId);
  return ids?.[0] ?? null;
}

export function MensaCalendar({ userId, studentId }: Props) {
  const t = useTranslations('mensa');
  const allergeneLabel = useAllergeneLabel();
  // La lingua attiva regge sia le abbreviazioni dei giorni sia la formattazione
  // dell'intervallo settimana (mese abbreviato) — altrimenti in EN si vedrebbero
  // i mesi in italiano. In IT (default e nei test) resta 'it-IT', invariato.
  //
  // La REGIONE non si decide più qui: questo file la sceglieva a mano ('en-GB')
  // mentre tutto il resto dell'app usava 'en' nudo (che Intl risolve su en-US),
  // e lo stesso prodotto leggeva «8/10/2026» in due modi opposti. Ora la mappa
  // è una sola, in `@/i18n/config`, e `intlDateTime` dichiara anche il fuso.
  const locale = useLocale();
  const [weekStart, setWeekStart] = useState<Date>(() => lunediDella(new Date()));
  const [menu, setMenu] = useState<MenuGiorno[]>([]);
  const [pren, setPren] = useState<Record<string, Prenotazione>>({});
  const [saldo, setSaldo] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [menuNome, setMenuNome] = useState<string | null>(null);
  // true quando il menu mostrato viene dalla cache offline (rete assente).
  const [menuOffline, setMenuOffline] = useState(false);
  // Orario limite (cutoff) per prenotare/disdire "oggi" (dalla config scuola).
  const [cutoffOra, setCutoffOra] = useState<string | null>(null);
  // Celebrazione festosa (spunta + coriandoli) su prenota/disdici riuscita.
  const [celebra, setCelebra] = useState<string | null>(null);
  // L'istante con cui si decide cosa è bloccato. Si aggiorna da solo (timer leggero
  // + ritorno in primo piano) così il blocco di «oggi» scatta anche se la pagina
  // resta aperta oltre il cutoff, e a mezzanotte italiana «oggi» diventa passato.
  const [adesso, setAdesso] = useState<Date>(() => new Date());
  // Alunno effettivo: la prop iniziale può essere stantia (cache non ancora
  // rivalidata, deep-link vecchio). Su un 403 l'autorecupero la sostituisce.
  const [overrideStudent, setOverrideStudent] = useState<string | null>(null);
  // Un solo autorecupero per montaggio: senza guardia il 403 farebbe un ciclo.
  const recuperoTentato = useRef(false);
  // Alla scadenza della sessione portiamo il focus sull'azione di recupero, così
  // tastiera e screen reader atterrano direttamente sul link "Accedi di nuovo".
  const accediRef = useRef<HTMLAnchorElement>(null);
  const activeStudent = overrideStudent ?? studentId;

  const from = ymd(weekStart);
  const to = ymd(addDays(weekStart, 6));
  // «Oggi» e «passato» si decidono in `bloccoGiorno` con la data di ROMA, non con
  // quella UTC di `toISOString()`: fra mezzanotte e le 2 italiane la seconda è ancora
  // ieri, e il giorno appena passato restava prenotabile.

  useEffect(() => {
    const aggiorna = () => setAdesso(new Date());
    const id = setInterval(aggiorna, RICONTROLLO_CUTOFF_MS);
    const suVisibilita = () => { if (document.visibilityState === 'visible') aggiorna(); };
    document.addEventListener('visibilitychange', suVisibilita);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', suVisibilita);
    };
  }, []);

  /** Il testo per «oggi oltre il cutoff», con l'ora della sede. */
  const testoOltreCutoff = (ora: string) => t('oltreCutoffOggi', { ora: oraDiRoma(ora) ?? ora });

  /**
   * L'UNICO punto che sceglie il testo di un giorno bloccato dal cutoff, sia al tocco
   * sia dopo un rifiuto `MENSA_OLTRE_CUTOFF` del server. Per «oggi» la frase con l'ora
   * della sede; per un giorno ormai passato (pagina rimasta aperta oltre la mezzanotte)
   * la frase del catalogo, che non dice «oggi». Aggiorna anche l'orologio dello stato,
   * così il pulsante si spegne subito.
   */
  const testoBloccoCutoff = (data: string): string => {
    const ora = new Date();
    setAdesso(ora);
    return cutoffOra && data === oggiRoma(ora)
      ? testoOltreCutoff(cutoffOra)
      : soloCatalogoDaCorpo({ codice: CODICE_OLTRE_CUTOFF }, t('errore'));
  };

  /**
   * Ricontrollo al tocco: l'orologio dello stato può essere fermo da fino a 30 s.
   * Se nel frattempo il giorno è diventato bloccato, niente chiamata: si spiega
   * perché con `testoBloccoCutoff`. Ritorna true se ha bloccato.
   */
  const bloccatoAlTocco = (data: string): boolean => {
    if (!bloccoGiorno(data, cutoffOra, new Date())) return false;
    setMsg(testoBloccoCutoff(data));
    return true;
  };

  const load = useCallback(async () => {
    try {
      // Menu con cache offline: la chiave è per-alunno/settimana. In fallback offline
      // serve l'ultima copia salvata (menuOff=true). Il .catch(() => null) tiene la
      // Promise.all resiliente se manca rete E cache (nessun menu, come prima). Le
      // prenotazioni (saldo/ticket) NON si cachano: sono stato mutabile, non contenuto.
      let menuOff = false;
      const menuChiave = `menu:${activeStudent}:${from}:${to}`;
      const menuUrl = `/api/mensa/menu?userId=${userId}&from=${from}&to=${to}&alunno_id=${activeStudent}`;
      const [mRes, pRaw] = await Promise.all([
        fetchConCache<MenuResponse>(menuChiave, menuUrl, { headers: hdr(userId) })
          .then(r => { menuOff = r.offline; return r.data; })
          .catch(() => null),
        fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${activeStudent}&from=${from}&to=${to}`, { headers: hdr(userId) }).then(async r => ({ status: r.status, data: await r.json() })).catch(() => null),
      ]);
      if (mRes?.success) {
        setMenu(mRes.data);
        setMenuNome(mRes.meta?.menuNome ?? null);
      }
      setMenuOffline(menuOff);

      const azione = pRaw ? decidiAzioneMensaAuth(pRaw.status, recuperoTentato.current) : ({ tipo: 'ok' } as const);

      if (azione.tipo === 'sessioneScaduta') {
        /*
         * Messaggio-SLUG, senza gli uuid che stavano qui dentro. Non perché fossero PII —
         * un uuid passa la lista bianca di `redact` — ma perché il `messaggio` è anche la
         * CHIAVE del throttle di `logClient` (`evento|messaggio|stato`): con l'id
         * dell'alunno nel testo la chiave è diversa per ogni famiglia, quindi la deduplica
         * a 60 secondi non scatta mai e la mappa `visti` cresce a ogni utente nuovo — cioè
         * il contrario di quello che serve quando la sessione scade a tutti insieme.
         * L'identità non si perde: `flush()` la spedisce come `?userId=`, ed è il SERVER a
         * decidere quale sia (`getRequestUserId`), che è l'unico che può rifiutarla.
         */
        logClient({ livello: 'warn', evento: 'fetch', stato: 401, messaggio: 'mensa-prenotazioni-sessione-scaduta' });
        setAuthError({ tipo: 'scaduta' });
        setSaldo(null);
        return;
      }

      if (azione.tipo === 'autorecupero') {
        logClient({ livello: 'warn', evento: 'fetch', stato: 403, messaggio: 'mensa-prenotazioni-autorecupero-figlio' });
        recuperoTentato.current = true;
        const nuovo = await recuperaPrimoFiglio(userId);
        if (nuovo && nuovo !== activeStudent) {
          // Cambia l'alunno effettivo → load si ricrea (dep) e l'effect ricarica.
          setOverrideStudent(nuovo);
          return;
        }
        // Recupero impossibile (nessun figlio / rete) o stesso id: onesti.
        setAuthError({ tipo: 'nonCollegato' });
        setSaldo(null);
        return;
      }

      if (azione.tipo === 'nonCollegato') {
        logClient({ livello: 'warn', evento: 'fetch', stato: 403, messaggio: 'mensa-prenotazioni-alunno-non-collegato' });
        setAuthError({ tipo: 'nonCollegato' });
        setSaldo(null);
        return;
      }

      // Nessun problema d'auth.
      setAuthError(null);
      if (pRaw?.data?.success) {
        // La fetch avvolge la risposta in { status, data: <body> } e il body è
        // { success, data: { saldo, prenotazioni, cutoffOra } } → il payload è pRaw.data.data.
        const payload = pRaw.data.data ?? {};
        setSaldo(payload.saldo ?? 0);
        setCutoffOra(payload.cutoffOra ?? null);
        const map: Record<string, Prenotazione> = {};
        for (const p of (payload.prenotazioni ?? []) as Prenotazione[]) map[p.data] = p;
        setPren(map);
      }
    } finally { setLoading(false); }
  }, [userId, activeStudent, from, to]);

  useEffect(() => { load(); }, [load]);

  // Sessione scaduta → sposta il focus sul link di recupero (solo client, nessun
  // rischio d'hydration: l'effect gira dopo il mount).
  useEffect(() => {
    if (authError?.tipo === 'scaduta') accediRef.current?.focus();
  }, [authError]);

  const prenota = async (data: string) => {
    if (bloccatoAlTocco(data)) return;
    setBusy(data); setMsg(null);
    const res = await fetch('/api/mensa/prenotazioni', {
      method: 'POST', headers: hdr(userId),
      body: JSON.stringify({ alunno_id: activeStudent, date: [data] }),
    });
    const j = await res.json();
    setBusy(null);
    if (j.success) {
      const esito = j.data.esiti?.[0];
      // Il motivo «oltre l'orario» ha il suo codice (`MENSA_OLTRE_CUTOFF`) e lo
      // gestisce il primo ramo con `testoBloccoCutoff`, tradotto in it/en.
      // ⚠️ Restano prosa italiana dell'API solo gli altri motivi per giorno
      // («Giorno non attivo o mensa chiusa», «Saldo ticket esaurito», e gli
      // errori dello scalo «Errore prenotazione»/«Errore saldo»), finché il
      // server non manderà un codice anche per loro. È l'ultimo residuo di T10-F1
      // in questa schermata, ed è dichiarato invece che nascosto — a differenza
      // di `j.error`, che sotto passa dal catalogo.
      if (esito && !esito.ok && esito.codice === CODICE_OLTRE_CUTOFF) { setMsg(testoBloccoCutoff(data)); }
      else if (esito && !esito.ok) { setMsg(esito.motivo ?? t('operazioneNonRiuscita')); }
      else { setCelebra(t('pranzoPrenotato')); }
      await load();
    } else { setMsg(soloCatalogoDaCorpo(j, t('errore'))); }
  };

  const disdici = async (data: string) => {
    if (bloccatoAlTocco(data)) return;
    setBusy(data); setMsg(null);
    const res = await fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${activeStudent}&data=${data}`, {
      method: 'DELETE', headers: hdr(userId),
    });
    const j = await res.json();
    setBusy(null);
    // Niente prosa del server: è italiana per costruzione (T10-F1).
    if (j.success) { setCelebra(t('prenotazioneDisdetta')); await load(); }
    else if (j?.codice === CODICE_OLTRE_CUTOFF) { setMsg(testoBloccoCutoff(data)); }
    else { setMsg(soloCatalogoDaCorpo(j, t('errore'))); }
  };

  const giorni = menu.filter(g => {
    // mostra solo giorni attivi (feriali configurati) o chiusi esplicitamente
    return g.attivo || g.chiuso;
  });

  return (
    <div>
      <SaveCelebration show={!!celebra} message={celebra ?? ''} onDone={() => setCelebra(null)} />

      {/* Saldo + navigazione settimana — wrap sugli schermi stretti (320px) */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 mb-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-kidville-green text-white">
            <Ticket size={15} />
            <span className="font-maven text-sm font-bold">{saldo ?? '—'}</span>
            <span className="font-maven text-[11px] opacity-80">{t('ticket')}</span>
          </div>
          {menuNome && (
            <span className="px-2.5 py-1 rounded-full bg-kidville-yellow/20 border border-kidville-yellow font-maven text-[10px] font-bold text-kidville-green">
              {menuNome}
            </span>
          )}
          <button
            onClick={() => load()}
            disabled={loading}
            title={t('aggiornaSaldo')}
            className="w-8 h-8 rounded-full bg-white border-2 border-kidville-line flex items-center justify-center text-kidville-green disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label={t('settimanaPrecedente')} className="w-8 h-8 rounded-full bg-white border-2 border-kidville-line flex items-center justify-center text-kidville-green">
            <ChevronLeft size={16} />
          </button>
          <span className="font-maven text-xs text-kidville-muted w-28 text-center">
            {intlDateTime(locale, { day: 'numeric', month: 'short' }).format(weekStart)} – {intlDateTime(locale, { day: 'numeric', month: 'short' }).format(addDays(weekStart, 6))}
          </span>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label={t('settimanaSuccessiva')} className="w-8 h-8 rounded-full bg-white border-2 border-kidville-line flex items-center justify-center text-kidville-green">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {menuOffline && !loading && (
        <div className="mb-3 flex">
          <OfflineBadge />
        </div>
      )}

      {cutoffOra && !authError && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-kidville-info-soft border border-kidville-info/20 font-maven text-xs text-kidville-info flex items-center gap-2">
          <Clock size={13} className="flex-shrink-0" />
          <span>{t.rich('cutoffNota', { ora: oraDiRoma(cutoffOra) ?? cutoffOra, strong: (c) => <strong>{c}</strong> })}</span>
        </div>
      )}

      {authError?.tipo === 'scaduta' && (
        <div role="alert" className="mb-3 px-3 py-2.5 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn-strong flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>{t('sessioneScaduta')}</p>
            <a
              ref={accediRef}
              href="/auth/login"
              className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-full bg-kidville-green text-white font-maven text-xs font-bold"
            >
              <LogIn size={13} /> {t('accediDiNuovo')}
            </a>
          </div>
        </div>
      )}
      {authError?.tipo === 'nonCollegato' && (
        <div role="alert" className="mb-3 px-3 py-2.5 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn-strong flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{t('nonCollegato')}</span>
        </div>
      )}
      {!authError && (saldo != null && saldo <= 0) && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-kidville-error-soft border border-kidville-error/40 font-maven text-xs text-kidville-error-strong">
          {t('saldoEsaurito')}
        </div>
      )}
      {msg && (
        <div role="status" aria-live="polite" className="mb-3 px-3 py-2 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn-strong">{msg}</div>
      )}

      {loading ? (
        <div role="status" aria-busy="true" className="py-12 flex justify-center">
          <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
          <span className="sr-only">{t('caricamento')}</span>
        </div>
      ) : (
        <div className="space-y-2.5">
          {giorni.length === 0 && (
            <p className="font-maven text-sm text-kidville-sub text-center py-8">{t('nessunGiorno')}</p>
          )}
          {giorni.map((g, idx) => {
            const d = new Date(`${g.data}T00:00:00Z`);
            const p = pren[g.data];
            const prenotato = p?.stato === 'prenotato';
            const blocco = bloccoGiorno(g.data, cutoffOra, adesso);
            // Passato (data di Roma) o oggi oltre il cutoff: nessuna prenotazione né disdetta.
            const bloccato = blocco !== null;
            const oggiOltreCutoff = blocco === 'oltreCutoff';
            // Un pulsante `disabled` esce dal Tab e non dice perché: la ragione è nel
            // <p> sotto, e i pulsanti la richiamano con `aria-describedby` (solo quando
            // il <p> esiste davvero, altrimenti punterebbero a un id inesistente).
            const idOltreCutoff = oggiOltreCutoff && cutoffOra ? `oltre-cutoff-${g.data}` : undefined;
            const bloccaSaldo = !prenotato && (saldo ?? 0) <= 0;

            return (
              <motion.div
                key={g.data}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.03 }}
                className={`rounded-2xl border p-3 ${prenotato ? 'bg-kidville-success-soft/70 border-kidville-success/30' : 'bg-white border-kidville-line'}`}
              >
                <div className="flex items-start gap-3">
                  <div className={`flex flex-col items-center justify-center w-12 h-12 rounded-xl flex-shrink-0 ${prenotato ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-green'}`}>
                    <span className="font-barlow font-black text-[10px] uppercase leading-none">{intlDateTime(locale, { weekday: 'short', timeZone: 'UTC' }).format(d)}</span>
                    <span className="font-barlow font-black text-lg leading-none">{d.getUTCDate()}</span>
                  </div>

                  <div className="flex-1 min-w-0">
                    {g.chiuso ? (
                      <div className="flex items-center gap-1.5 text-kidville-muted font-maven text-sm py-2">
                        <CalendarOff size={14} /> {t('mensaChiusa')} {g.note ? `· ${g.note}` : ''}
                      </div>
                    ) : g.portate ? (
                      <p className="font-maven text-[12px] text-kidville-sub leading-snug">
                        {[g.portate.primo, g.portate.secondo, g.portate.contorno, g.portate.frutta].filter(Boolean).join(' · ') || t('menuNonPubblicato')}
                      </p>
                    ) : (
                      <p className="font-maven text-[12px] text-kidville-muted py-1 flex items-center gap-1">
                        <UtensilsCrossed size={13} /> {t('menuNonPubblicato')}
                      </p>
                    )}

                    {!g.chiuso && allergeniDelGiorno(g.allergeni).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {allergeniDelGiorno(g.allergeni).map(k => (
                          <span key={k} title={allergeneLabel(k)}
                            className="px-1.5 py-0.5 rounded-full bg-kidville-warn-soft border border-kidville-warn/30 text-kidville-warn font-maven text-[10px] font-bold">
                            {allergeneEmoji(k)} {allergeneLabel(k)}
                          </span>
                        ))}
                      </div>
                    )}

                    {!g.chiuso && (
                      <div className="mt-2">
                        {prenotato ? (
                          <button
                            disabled={busy === g.data || bloccato}
                            onClick={() => disdici(g.data)}
                            aria-describedby={idOltreCutoff}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border-2 border-kidville-success/30 text-kidville-success font-maven text-xs font-bold disabled:opacity-50"
                          >
                            {bloccato ? <Lock size={13} /> : <X size={13} />}
                            {bloccato ? t('prenotato') : t('disdici')}
                          </button>
                        ) : (
                          <button
                            disabled={busy === g.data || bloccato || bloccaSaldo}
                            onClick={() => prenota(g.data)}
                            aria-describedby={idOltreCutoff}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-kidville-green text-white font-maven text-xs font-bold disabled:opacity-40"
                          >
                            {bloccato ? <Lock size={13} /> : <Check size={13} />} {t('prenotaPranzo')}
                          </button>
                        )}
                        {p?.origine === 'segreteria' && (
                          <span className="ml-2 font-maven text-[10px] text-kidville-muted">{t('inseritoSegreteria')}</span>
                        )}
                        {idOltreCutoff && cutoffOra && (
                          <p id={idOltreCutoff} className="mt-1.5 font-maven text-[11px] text-kidville-muted flex items-center gap-1">
                            <Clock size={12} className="flex-shrink-0" /> {testoOltreCutoff(cutoffOra)}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
