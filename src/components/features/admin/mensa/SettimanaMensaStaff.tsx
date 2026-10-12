'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Ticket, Plus, X, CalendarOff, AlertTriangle, Info } from 'lucide-react';
import { useDateFormat, conIniziale } from '@/lib/i18n/date';
import { formattaIstante } from '@/i18n/config';
import { oggiRoma } from '@/lib/mensa/cutoff';
import { lunediDi, piuGiorni } from '@/lib/mensa/settimana';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { ConfermaAnnullaPasto } from './ConfermaAnnullaPasto';

interface Portate { primo?: string; secondo?: string; contorno?: string; frutta?: string }
interface MenuGiorno { data: string; attivo: boolean; chiuso: boolean; portate: Portate | null; note?: string | null }
interface Prenotazione { data: string; stato: string; origine: string }
interface Settimana { menu: MenuGiorno[]; pren: Record<string, Prenotazione>; saldo: number | null }
type Esito =
  | { tipo: 'aggiunto' | 'annullato'; data: string; saldo: number }
  | { tipo: 'rifiuto'; motivo?: string }
  | { tipo: 'rete' }
  | { tipo: 'caricamento' };

interface Props { userId: string; alunno: { id: string; nome: string; cognome: string } }

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const ROUTE = '/admin/mensa';

/**
 * Menu e prenotazioni di una settimana. Funzione di MODULO: l'effetto la chiama e
 * mette lo stato nei `.then`, mai in modo sincrono (react-hooks/set-state-in-effect).
 * `null` = il server ha detto no (sessione, sede): lo dice l'interfaccia.
 */
async function caricaSettimana(userId: string, alunnoId: string, from: string, to: string): Promise<Settimana | null> {
  const qs = `userId=${userId}&alunno_id=${alunnoId}&from=${from}&to=${to}`;
  const [m, p] = await Promise.all([
    fetch(`/api/mensa/menu?${qs}`, { headers: hdr(userId) }).then(r => r.json()),
    fetch(`/api/mensa/prenotazioni?${qs}`, { headers: hdr(userId) }).then(r => r.json()),
  ]);
  if (!p?.success) return null;
  const pren: Record<string, Prenotazione> = {};
  for (const x of (p.data?.prenotazioni ?? []) as Prenotazione[]) pren[x.data] = x;
  return { menu: m?.success ? (m.data as MenuGiorno[]) : [], pren, saldo: p.data?.saldo ?? null };
}

/**
 * La settimana mensa di UN bambino, vista dalla segreteria: per ogni giorno aperto
 * «Aggiungi» o «Annulla», sempre attivi — anche oggi dopo l'orario limite e nei
 * giorni passati. Il server lo permette ai ruoli di `RUOLI_GESTIONE_MENSA` dal
 * primo giorno; mancava solo il pulsante (2026-10-12): le disdette in produzione
 * erano 61, tutte di genitori, nessuna dello staff.
 */
export function SettimanaMensaStaff({ userId, alunno }: Props) {
  const t = useTranslations('adminMensa');
  const f = useDateFormat();
  const [lunedi, setLunedi] = useState(() => lunediDi(oggiRoma()));
  const [dati, setDati] = useState<Settimana | null>(null);
  const [caricando, setCaricando] = useState(true);
  // Cambiarla ricarica la settimana (dopo ogni Aggiungi/Annulla).
  const [versione, setVersione] = useState(0);
  const [esito, setEsito] = useState<Esito | null>(null);
  const [inVolo, setInVolo] = useState<string | null>(null);
  const [daAnnullare, setDaAnnullare] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    caricaSettimana(userId, alunno.id, lunedi, piuGiorni(lunedi, 6))
      .then(d => {
        if (!vivo) return;
        setDati(d);
        if (!d) setEsito({ tipo: 'caricamento' });
      })
      .catch(err => {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-staff-settimana-non-caricata: ${nomeErrore(err)}`, route: ROUTE });
        if (vivo) setEsito({ tipo: 'rete' });
      })
      .finally(() => { if (vivo) setCaricando(false); });
    return () => { vivo = false; };
  }, [userId, alunno.id, lunedi, versione]);

  const giornoLeggibile = (data: string) =>
    conIniziale(formattaIstante(`${data}T12:00:00Z`, f.locale, { weekday: 'long', day: 'numeric', month: 'long' }));

  const aggiungi = async (data: string) => {
    setInVolo(data); setEsito(null);
    try {
      const res = await fetch('/api/mensa/prenotazioni', {
        method: 'POST', headers: hdr(userId),
        body: JSON.stringify({ alunno_id: alunno.id, date: [data] }),
      });
      const j = await res.json();
      const delGiorno = j?.data?.esiti?.[0];
      if (j?.success && delGiorno?.ok) setEsito({ tipo: 'aggiunto', data, saldo: Number(j.data.saldo) });
      else setEsito({ tipo: 'rifiuto', motivo: delGiorno?.motivo ?? j?.error });
    } catch (err) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-staff-aggiungi-fallita: ${nomeErrore(err)}`, route: ROUTE });
      setEsito({ tipo: 'rete' });
    } finally {
      setInVolo(null);
      setVersione(v => v + 1);
    }
  };

  const annulla = async (data: string) => {
    setDaAnnullare(null); setInVolo(data); setEsito(null);
    try {
      const res = await fetch(`/api/mensa/prenotazioni?userId=${userId}&alunno_id=${alunno.id}&data=${data}`, {
        method: 'DELETE', headers: hdr(userId),
      });
      const j = await res.json();
      if (j?.success) setEsito({ tipo: 'annullato', data, saldo: Number(j.data.saldo) });
      else setEsito({ tipo: 'rifiuto', motivo: j?.error });
    } catch (err) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `mensa-staff-annulla-fallita: ${nomeErrore(err)}`, route: ROUTE });
      setEsito({ tipo: 'rete' });
    } finally {
      setInVolo(null);
      setVersione(v => v + 1);
    }
  };

  const testoEsito = (() => {
    if (!esito) return null;
    switch (esito.tipo) {
      case 'aggiunto': return t('pastoAggiuntoIl', { data: giornoLeggibile(esito.data), saldo: esito.saldo });
      case 'annullato': return t('pastoAnnullatoIl', { data: giornoLeggibile(esito.data), saldo: esito.saldo });
      case 'rifiuto': return esito.motivo ?? t('operazioneNonRiuscita');
      case 'rete': return t('erroreReteMensa');
      case 'caricamento': return t('errore');
    }
  })();

  const saldo = dati?.saldo ?? null;
  const oggi = oggiRoma();
  const giorni = (dati?.menu ?? []).filter(g => g.attivo || g.chiuso);
  const navCls = 'flex h-11 w-11 items-center justify-center rounded-full border-2 border-kidville-line bg-white text-kidville-green';

  return (
    <div className="bg-kidville-cream/60 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <span className="font-maven text-sm text-kidville-green font-bold">{alunno.nome} {alunno.cognome}</span>
        <span className="font-maven text-sm text-kidville-sub flex items-center gap-1">
          <Ticket size={13} /> {t('saldoLabel')}{' '}
          <b className={saldo != null && saldo < 0 ? 'text-kidville-error' : 'text-kidville-green'}>{saldo ?? '—'}</b>
        </span>
      </div>

      <div className="flex items-center gap-1 mb-3">
        <button type="button" onClick={() => setLunedi(piuGiorni(lunedi, -7))} aria-label={t('settimanaPrecedente')} className={navCls}>
          <ChevronLeft size={16} />
        </button>
        <span className="flex-1 text-center font-maven text-xs text-kidville-sub">
          {f.giornoMese(`${lunedi}T12:00:00Z`)} – {f.giornoMese(`${piuGiorni(lunedi, 6)}T12:00:00Z`)}
        </span>
        <button type="button" onClick={() => setLunedi(piuGiorni(lunedi, 7))} aria-label={t('settimanaSuccessiva')} className={navCls}>
          <ChevronRight size={16} />
        </button>
        <button type="button" onClick={() => setLunedi(lunediDi(oggiRoma()))}
          className="min-h-[44px] rounded-full border-2 border-kidville-line bg-white px-3 font-maven text-xs font-bold text-kidville-green">
          {t('tornaAOggi')}
        </button>
      </div>

      <p className="mb-2 font-maven text-[11px] text-kidville-sub flex items-start gap-1">
        <Info size={12} className="mt-0.5 flex-shrink-0" /> {t('notaSegreteriaSenzaOrario')}
      </p>
      {saldo != null && saldo <= 0 && (
        <p className="mb-2 font-maven text-[11px] text-kidville-warn-strong flex items-start gap-1">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {t('notaForzaInserimento')}
        </p>
      )}
      {testoEsito && (
        <p role="status" aria-live="polite" className="mb-2 font-maven text-xs text-kidville-green">{testoEsito}</p>
      )}

      {caricando ? (
        <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
      ) : giorni.length === 0 ? (
        <p className="font-maven text-sm text-kidville-sub">{t('nessunGiornoSettimana')}</p>
      ) : (
        <ul className="space-y-2">
          {giorni.map(g => {
            const p = dati?.pren[g.data];
            const prenotato = p?.stato === 'prenotato';
            const giorno = giornoLeggibile(g.data);
            const portate = g.portate
              ? [g.portate.primo, g.portate.secondo, g.portate.contorno, g.portate.frutta].filter(Boolean).join(' · ')
              : '';
            return (
              <li key={g.data} className={`rounded-xl border p-3 ${prenotato ? 'bg-kidville-success-soft/70 border-kidville-success/30' : 'bg-white border-kidville-line'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-maven text-sm font-bold text-kidville-green">
                      {giorno}{g.data === oggi ? ` · ${t('tornaAOggi')}` : ''}
                    </p>
                    {g.chiuso ? (
                      <p className="font-maven text-xs text-kidville-sub flex items-center gap-1">
                        <CalendarOff size={13} /> {t('mensaChiusaGiorno')}{g.note ? ` · ${g.note}` : ''}
                      </p>
                    ) : (
                      <>
                        <p className="font-maven text-[12px] text-kidville-sub">{portate || t('menuNonPubblicato')}</p>
                        <p className="font-maven text-[11px] text-kidville-sub">
                          {prenotato ? t('pastoPrenotato') : t('pastoNonPrenotato')}
                          {prenotato && p?.origine === 'segreteria' ? ` · ${t('inseritoSegreteria')}` : ''}
                        </p>
                      </>
                    )}
                  </div>
                  {!g.chiuso && (prenotato ? (
                    <button type="button" disabled={inVolo === g.data} onClick={() => setDaAnnullare(g.data)}
                      aria-label={t('annullaPastoDel', { data: giorno })}
                      className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border-2 border-kidville-error/40 bg-white px-3 font-maven text-xs font-bold text-kidville-error-strong disabled:opacity-50">
                      <X size={13} /> {t('annullaPasto')}
                    </button>
                  ) : (
                    <button type="button" disabled={inVolo === g.data} onClick={() => aggiungi(g.data)}
                      aria-label={t('aggiungiPastoDel', { data: giorno })}
                      className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full bg-kidville-green px-3 font-maven text-xs font-bold text-white disabled:opacity-50">
                      <Plus size={13} /> {t('aggiungiPasto')}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfermaAnnullaPasto
        richiesta={daAnnullare ? { nome: `${alunno.nome} ${alunno.cognome}`, dataLeggibile: giornoLeggibile(daAnnullare) } : null}
        inCorso={inVolo !== null}
        onConferma={() => { if (daAnnullare) void annulla(daAnnullare); }}
        onChiudi={() => setDaAnnullare(null)}
      />
    </div>
  );
}
