'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Ticket, ChevronLeft, ChevronRight, Check, X, Lock, CalendarOff, UtensilsCrossed, RefreshCw, AlertTriangle, Clock, LogIn } from 'lucide-react';
import { allergeniDelGiorno, allergeneLabel, allergeneEmoji, type AllergeniPortate } from '@/lib/mensa/allergeni';
import { SaveCelebration } from '@/components/ui/SaveConfirmation';
import { logClient } from '@/lib/logging/client';
import { fetchFigliIds } from '@/lib/auth/use-parent-identity';

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

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const GIORNI = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function lunediDella(d: Date): Date {
  const x = new Date(d);
  const wd = x.getDay() === 0 ? 7 : x.getDay();
  x.setDate(x.getDate() - (wd - 1));
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

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
  const [weekStart, setWeekStart] = useState<Date>(() => lunediDella(new Date()));
  const [menu, setMenu] = useState<MenuGiorno[]>([]);
  const [pren, setPren] = useState<Record<string, Prenotazione>>({});
  const [saldo, setSaldo] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [menuNome, setMenuNome] = useState<string | null>(null);
  // Orario limite (cutoff) per prenotare/disdire "oggi" (dalla config scuola).
  const [cutoffOra, setCutoffOra] = useState<string | null>(null);
  // Celebrazione festosa (spunta + coriandoli) su prenota/disdici riuscita.
  const [celebra, setCelebra] = useState<string | null>(null);
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
  const today = ymd(new Date());

  const load = useCallback(async () => {
    try {
      const [mRes, pRaw] = await Promise.all([
        fetch(`/api/mensa/menu?userId=${userId}&from=${from}&to=${to}&alunno_id=${activeStudent}`, { headers: hdr(userId) }).then(r => r.json()).catch(() => null),
        fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${activeStudent}&from=${from}&to=${to}`, { headers: hdr(userId) }).then(async r => ({ status: r.status, data: await r.json() })).catch(() => null),
      ]);
      if (mRes?.success) {
        setMenu(mRes.data);
        setMenuNome(mRes.meta?.menuNome ?? null);
      }

      const azione = pRaw ? decidiAzioneMensaAuth(pRaw.status, recuperoTentato.current) : ({ tipo: 'ok' } as const);

      if (azione.tipo === 'sessioneScaduta') {
        // Solo uuid nel messaggio (nessun nome/email): passano la redazione.
        logClient({ livello: 'warn', evento: 'fetch', stato: 401, messaggio: `mensa: 401 prenotazioni, sessione scaduta (genitore=${userId} alunno=${activeStudent})` });
        setAuthError({ tipo: 'scaduta' });
        setSaldo(null);
        return;
      }

      if (azione.tipo === 'autorecupero') {
        logClient({ livello: 'warn', evento: 'fetch', stato: 403, messaggio: `mensa: 403 prenotazioni, autorecupero figlio (genitore=${userId} alunno=${activeStudent})` });
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
        logClient({ livello: 'warn', evento: 'fetch', stato: 403, messaggio: `mensa: 403 prenotazioni persistente, alunno non collegato (genitore=${userId} alunno=${activeStudent})` });
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
    setBusy(data); setMsg(null);
    const res = await fetch('/api/mensa/prenotazioni', {
      method: 'POST', headers: hdr(userId),
      body: JSON.stringify({ alunno_id: activeStudent, date: [data] }),
    });
    const j = await res.json();
    setBusy(null);
    if (j.success) {
      const esito = j.data.esiti?.[0];
      if (esito && !esito.ok) { setMsg(esito.motivo ?? 'Operazione non riuscita'); }
      else { setCelebra('Pranzo prenotato!'); }
      await load();
    } else { setMsg(j.error ?? 'Errore'); }
  };

  const disdici = async (data: string) => {
    setBusy(data); setMsg(null);
    const res = await fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${activeStudent}&data=${data}`, {
      method: 'DELETE', headers: hdr(userId),
    });
    const j = await res.json();
    setBusy(null);
    if (j.success) { setCelebra('Prenotazione disdetta'); await load(); } else { setMsg(j.error ?? 'Errore'); }
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
            <span className="font-maven text-[11px] opacity-80">ticket</span>
          </div>
          {menuNome && (
            <span className="px-2.5 py-1 rounded-full bg-kidville-yellow/20 border border-kidville-yellow font-maven text-[10px] font-bold text-kidville-green">
              {menuNome}
            </span>
          )}
          <button
            onClick={() => load()}
            disabled={loading}
            title="Aggiorna saldo"
            className="w-8 h-8 rounded-full bg-white border-2 border-kidville-line flex items-center justify-center text-kidville-green disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="w-8 h-8 rounded-full bg-white border-2 border-kidville-line flex items-center justify-center text-kidville-green">
            <ChevronLeft size={16} />
          </button>
          <span className="font-maven text-xs text-kidville-muted w-28 text-center">
            {weekStart.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} – {addDays(weekStart, 6).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
          </span>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="w-8 h-8 rounded-full bg-white border-2 border-kidville-line flex items-center justify-center text-kidville-green">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {cutoffOra && !authError && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-kidville-info-soft border border-kidville-info/20 font-maven text-xs text-kidville-info flex items-center gap-2">
          <Clock size={13} className="flex-shrink-0" />
          <span>Prenota o disdici entro le <strong>{cutoffOra}</strong> del giorno stesso.</span>
        </div>
      )}

      {authError?.tipo === 'scaduta' && (
        <div role="alert" className="mb-3 px-3 py-2.5 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn-strong flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>Sessione scaduta: effettua di nuovo l&apos;accesso.</p>
            <a
              ref={accediRef}
              href="/auth/login"
              className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-full bg-kidville-green text-white font-maven text-xs font-bold"
            >
              <LogIn size={13} /> Accedi di nuovo
            </a>
          </div>
        </div>
      )}
      {authError?.tipo === 'nonCollegato' && (
        <div role="alert" className="mb-3 px-3 py-2.5 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn-strong flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>Questo alunno non risulta collegato al tuo account. Contatta la segreteria.</span>
        </div>
      )}
      {!authError && (saldo != null && saldo <= 0) && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-red-50 border border-red-200 font-maven text-xs text-red-600">
          Saldo ticket esaurito. Contatta la segreteria per ricaricare prima di prenotare.
        </div>
      )}
      {msg && (
        <div role="status" aria-live="polite" className="mb-3 px-3 py-2 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn-strong">{msg}</div>
      )}

      {loading ? (
        <div role="status" aria-busy="true" className="py-12 flex justify-center">
          <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
          <span className="sr-only">Caricamento…</span>
        </div>
      ) : (
        <div className="space-y-2.5">
          {giorni.length === 0 && (
            <p className="font-maven text-sm text-kidville-muted text-center py-8">Nessun giorno mensa in questa settimana.</p>
          )}
          {giorni.map((g, idx) => {
            const d = new Date(`${g.data}T00:00:00Z`);
            const wd = (d.getUTCDay() === 0 ? 7 : d.getUTCDay()) - 1;
            const p = pren[g.data];
            const prenotato = p?.stato === 'prenotato';
            const isPast = g.data < today;
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
                    <span className="font-barlow font-black text-[10px] uppercase leading-none">{GIORNI[wd]}</span>
                    <span className="font-barlow font-black text-lg leading-none">{d.getUTCDate()}</span>
                  </div>

                  <div className="flex-1 min-w-0">
                    {g.chiuso ? (
                      <div className="flex items-center gap-1.5 text-kidville-muted font-maven text-sm py-2">
                        <CalendarOff size={14} /> Mensa chiusa {g.note ? `· ${g.note}` : ''}
                      </div>
                    ) : g.portate ? (
                      <p className="font-maven text-[12px] text-kidville-sub leading-snug">
                        {[g.portate.primo, g.portate.secondo, g.portate.contorno, g.portate.frutta].filter(Boolean).join(' · ') || 'Menu non ancora pubblicato'}
                      </p>
                    ) : (
                      <p className="font-maven text-[12px] text-kidville-muted py-1 flex items-center gap-1">
                        <UtensilsCrossed size={13} /> Menu non ancora pubblicato
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
                            disabled={busy === g.data || isPast}
                            onClick={() => disdici(g.data)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border-2 border-kidville-success/30 text-kidville-success font-maven text-xs font-bold disabled:opacity-50"
                          >
                            {isPast ? <Lock size={13} /> : <X size={13} />}
                            {isPast ? 'Prenotato' : 'Disdici'}
                          </button>
                        ) : (
                          <button
                            disabled={busy === g.data || isPast || bloccaSaldo}
                            onClick={() => prenota(g.data)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-kidville-green text-white font-maven text-xs font-bold disabled:opacity-40"
                          >
                            <Check size={13} /> Prenota pranzo
                          </button>
                        )}
                        {p?.origine === 'segreteria' && (
                          <span className="ml-2 font-maven text-[10px] text-kidville-muted">inserito dalla segreteria</span>
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
