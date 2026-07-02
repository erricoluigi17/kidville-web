'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Ticket, ChevronLeft, ChevronRight, Check, X, Lock, CalendarOff, UtensilsCrossed, RefreshCw, AlertTriangle } from 'lucide-react';
import { allergeniDelGiorno, allergeneLabel, allergeneEmoji, type AllergeniPortate } from '@/lib/mensa/allergeni';

interface Props { userId: string; studentId: string }

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

export function MensaCalendar({ userId, studentId }: Props) {
  const [weekStart, setWeekStart] = useState<Date>(() => lunediDella(new Date()));
  const [menu, setMenu] = useState<MenuGiorno[]>([]);
  const [pren, setPren] = useState<Record<string, Prenotazione>>({});
  const [saldo, setSaldo] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [menuNome, setMenuNome] = useState<string | null>(null);

  const from = ymd(weekStart);
  const to = ymd(addDays(weekStart, 6));
  const today = ymd(new Date());

  const load = useCallback(async () => {
    setLoading(true);
    setAuthError(null);
    try {
      const [mRes, pRaw] = await Promise.all([
        fetch(`/api/mensa/menu?userId=${userId}&from=${from}&to=${to}&alunno_id=${studentId}`, { headers: hdr(userId) }).then(r => r.json()),
        fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${studentId}&from=${from}&to=${to}`, { headers: hdr(userId) }).then(async r => ({ status: r.status, data: await r.json() })),
      ]);
      if (mRes.success) {
        setMenu(mRes.data);
        setMenuNome(mRes.meta?.menuNome ?? null);
      }
      if (pRaw.status === 401 || pRaw.status === 403) {
        setAuthError('Sessione non valida. Torna alla home e riapri la mensa dal menu principale.');
        setSaldo(null);
      } else if (pRaw.data?.success) {
        setSaldo(pRaw.data.saldo);
        const map: Record<string, Prenotazione> = {};
        for (const p of (pRaw.data.prenotazioni ?? []) as Prenotazione[]) map[p.data] = p;
        setPren(map);
      }
    } finally { setLoading(false); }
  }, [userId, studentId, from, to]);

  useEffect(() => { load(); }, [load]);

  const prenota = async (data: string) => {
    setBusy(data); setMsg(null);
    const res = await fetch('/api/mensa/prenotazioni', {
      method: 'POST', headers: hdr(userId),
      body: JSON.stringify({ alunno_id: studentId, date: [data] }),
    });
    const j = await res.json();
    setBusy(null);
    if (j.success) {
      const esito = j.data.esiti?.[0];
      if (esito && !esito.ok) { setMsg(esito.motivo ?? 'Operazione non riuscita'); }
      await load();
    } else { setMsg(j.error ?? 'Errore'); }
  };

  const disdici = async (data: string) => {
    setBusy(data); setMsg(null);
    const res = await fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${studentId}&data=${data}`, {
      method: 'DELETE', headers: hdr(userId),
    });
    const j = await res.json();
    setBusy(null);
    if (j.success) { await load(); } else { setMsg(j.error ?? 'Errore'); }
  };

  const giorni = menu.filter(g => {
    // mostra solo giorni attivi (feriali configurati) o chiusi esplicitamente
    return g.attivo || g.chiuso;
  });

  return (
    <div>
      {/* Saldo + navigazione settimana */}
      <div className="flex items-center justify-between mb-4">
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
            className="w-8 h-8 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center text-kidville-green disabled:opacity-40"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="w-8 h-8 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center text-kidville-green">
            <ChevronLeft size={16} />
          </button>
          <span className="font-maven text-xs text-gray-500 w-28 text-center">
            {weekStart.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} – {addDays(weekStart, 6).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
          </span>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="w-8 h-8 rounded-full bg-white border-2 border-gray-200 flex items-center justify-center text-kidville-green">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {authError && (
        <div className="mb-3 px-3 py-2.5 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-orange-700 flex items-start gap-2">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <span>{authError}</span>
        </div>
      )}
      {!authError && (saldo != null && saldo <= 0) && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-red-50 border border-red-200 font-maven text-xs text-red-600">
          Saldo ticket esaurito. Contatta la segreteria per ricaricare prima di prenotare.
        </div>
      )}
      {msg && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-kidville-warn-soft border border-kidville-warn/30 font-maven text-xs text-kidville-warn">{msg}</div>
      )}

      {loading ? (
        <div className="py-12 flex justify-center">
          <div className="w-7 h-7 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-2.5">
          {giorni.length === 0 && (
            <p className="font-maven text-sm text-gray-400 text-center py-8">Nessun giorno mensa in questa settimana.</p>
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
                className={`rounded-2xl border p-3 ${prenotato ? 'bg-kidville-success-soft/70 border-kidville-success/30' : 'bg-white border-gray-100'}`}
              >
                <div className="flex items-start gap-3">
                  <div className={`flex flex-col items-center justify-center w-12 h-12 rounded-xl flex-shrink-0 ${prenotato ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-green'}`}>
                    <span className="font-barlow font-black text-[10px] uppercase leading-none">{GIORNI[wd]}</span>
                    <span className="font-barlow font-black text-lg leading-none">{d.getUTCDate()}</span>
                  </div>

                  <div className="flex-1 min-w-0">
                    {g.chiuso ? (
                      <div className="flex items-center gap-1.5 text-gray-400 font-maven text-sm py-2">
                        <CalendarOff size={14} /> Mensa chiusa {g.note ? `· ${g.note}` : ''}
                      </div>
                    ) : g.portate ? (
                      <p className="font-maven text-[12px] text-gray-600 leading-snug">
                        {[g.portate.primo, g.portate.secondo, g.portate.contorno, g.portate.frutta].filter(Boolean).join(' · ') || 'Menu non ancora pubblicato'}
                      </p>
                    ) : (
                      <p className="font-maven text-[12px] text-gray-400 py-1 flex items-center gap-1">
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
                          <span className="ml-2 font-maven text-[10px] text-gray-400">inserito dalla segreteria</span>
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
