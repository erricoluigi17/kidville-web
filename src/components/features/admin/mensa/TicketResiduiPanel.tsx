'use client';

import { useState, useEffect, useCallback, useMemo, useId } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { Ticket, Search, ChevronDown, History, AlertTriangle, Users } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import { logClient, nomeErrore } from '@/lib/logging/client';

interface Props {
  userId: string;
  scuolaId: string;
  /**
   * Modalità insegnante: vincola l'elenco a una sola sezione. Il filtro non è
   * un'estetica — il server RIFIUTA la richiesta di un `educator` che non
   * dichiara la propria classe (400) o ne chiede un'altra (403).
   */
  sezione?: string;
}

interface RigaTicket {
  alunno_id: string;
  nome: string;
  cognome: string;
  classe: string | null;
  saldo_ticket: number;
  ultimo_carico: string | null;
}

interface Elenco {
  classi: string[];
  alunni: RigaTicket[];
  totale_residui: number;
  senza_ticket: number;
  saldi_non_disponibili: boolean;
}

interface Movimento {
  id: string;
  tipo: string;
  delta: number;
  saldo_dopo: number | null;
  data: string | null;
  origine: string | null;
}

interface Storico {
  saldo_ticket: number;
  ultimo_carico: string | null;
  movimenti: Movimento[];
  storico_non_disponibile: boolean;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

/**
 * «Quanti pasti restano a ogni bambino» — l'elenco della mensa e della cucina.
 *
 * Il filtro per classe e la ricerca lavorano sui dati GIÀ scaricati: la sede più
 * grande ha 305 iscritti, stanno in una risposta sola, e filtrare in locale
 * risponde all'istante invece di rifare il giro. L'unica eccezione è la modalità
 * insegnante (`sezione`), dove il vincolo di classe deve valere sul SERVER: un
 * filtro fatto solo qui sarebbe una tendina, non un permesso.
 */
export function TicketResiduiPanel({ userId, scuolaId, sezione }: Props) {
  const t = useTranslations('adminMensa');
  const f = useDateFormat();
  const idBase = useId();
  const [elenco, setElenco] = useState<Elenco | null>(null);
  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState<string | null>(null);
  const [classe, setClasse] = useState('');
  const [cerca, setCerca] = useState('');
  const [aperto, setAperto] = useState<string | null>(null);
  const [storici, setStorici] = useState<Record<string, Storico | 'errore'>>({});

  const dataIt = (s: string | null | undefined) => (s ? f.dataBreve(s) : '—');

  const load = useCallback(async () => {
    let esito: Elenco | null = null;
    let msg: string | null = null;
    try {
      const qs = new URLSearchParams({ userId, scuola_id: scuolaId });
      if (sezione) qs.set('classe', sezione);
      const res = await fetch(`/api/mensa/ticket-residui?${qs}`, { headers: hdr(userId) });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success) esito = j.data;
      else {
        msg = j?.error ?? t('ticketResiduiErrore');
        // Un elenco vuoto qui non è neutro: la cucina lo leggerebbe come «nessun
        // bambino ha pasti». Lo stato dell'errore si logga (solo numeri).
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'ticket-residui-non-caricati', stato: res.status });
      }
    } catch (err) {
      msg = t('ticketResiduiErrore');
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `ticket-residui-non-caricati: ${nomeErrore(err)}` });
    } finally {
      setElenco(esito);
      setErrore(msg);
      setLoading(false);
    }
  }, [userId, scuolaId, sezione, t]);

  useEffect(() => { load(); }, [load]);

  const apri = async (alunnoId: string) => {
    if (aperto === alunnoId) { setAperto(null); return; }
    setAperto(alunnoId);
    if (storici[alunnoId]) return; // già in mano: nessun giro inutile
    let esito: Storico | 'errore' = 'errore';
    try {
      const qs = new URLSearchParams({ userId, alunno_id: alunnoId });
      const res = await fetch(`/api/mensa/ticket-residui/storico?${qs}`, { headers: hdr(userId) });
      const j = await res.json().catch(() => null);
      if (res.ok && j?.success) esito = j.data as Storico;
      else logClient({ livello: 'warn', evento: 'fetch', messaggio: 'ticket-storico-non-caricato', stato: res.status });
    } catch (err) {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `ticket-storico-non-caricato: ${nomeErrore(err)}` });
    } finally {
      setStorici(s => ({ ...s, [alunnoId]: esito }));
    }
  };

  // L'ordine alfabetico arriva già dal server (localeCompare 'it'); qui si
  // filtra soltanto, così l'ordine non si perde per strada.
  const righe = useMemo(() => {
    const q = cerca.trim().toLowerCase();
    return (elenco?.alunni ?? []).filter(a =>
      (!classe || a.classe === classe) &&
      (!q || `${a.cognome} ${a.nome}`.toLowerCase().includes(q) || `${a.nome} ${a.cognome}`.toLowerCase().includes(q)));
  }, [elenco, classe, cerca]);

  const residuiMostrati = righe.reduce((n, r) => n + Math.max(0, r.saldo_ticket), 0);
  const senzaMostrati = righe.filter(r => r.saldo_ticket <= 0).length;

  const etichettaMovimento = (m: Movimento) => {
    if (m.tipo === 'ricarica') return `${t('ticketMovRicarica')} +${m.delta}`;
    if (m.tipo === 'disdetta') return `${t('ticketMovDisdetta')} +${m.delta}`;
    if (m.tipo === 'rettifica') return `${t('ticketMovRettifica')} ${m.delta >= 0 ? '+' : ''}${m.delta}`;
    return `${t('ticketMovConsumo')} ${m.delta}`;
  };
  const toneMovimento = (tipo: string): BadgeTone =>
    tipo === 'ricarica' ? 'success' : tipo === 'disdetta' ? 'warn' : tipo === 'rettifica' ? 'read' : 'neutral';

  return (
    <div>
      <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-1 flex items-center gap-2">
        <Ticket size={14} /> {t('ticketResiduiTitolo')}
      </h3>
      <p className="font-maven text-xs text-kidville-sub mb-4">{t('ticketResiduiSottotitolo')}</p>

      {/* Filtri + riepilogo */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        {!sezione && (
          <div>
            <label htmlFor={`${idBase}-classe`} className="font-maven text-xs text-kidville-sub block mb-1">{t('sezione')}</label>
            <select id={`${idBase}-classe`} value={classe} onChange={e => setClasse(e.target.value)}
              className="min-h-[44px] rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-1.5 font-maven text-sm text-kidville-ink outline-none transition-colors cursor-pointer hover:border-kidville-green/50 focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15">
              <option value="">{t('tutte')}</option>
              {(elenco?.classi ?? []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}
        <div className="grow min-w-[180px]">
          <label htmlFor={`${idBase}-cerca`} className="font-maven text-xs text-kidville-sub block mb-1">{t('cerca')}</label>
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub" aria-hidden="true" />
            <input id={`${idBase}-cerca`} type="search" value={cerca} onChange={e => setCerca(e.target.value)}
              placeholder={t('ticketCercaPlaceholder')}
              className="w-full min-h-[44px] rounded-input border-[1.5px] border-kidville-line bg-kidville-white pl-9 pr-3 py-1.5 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15" />
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-kidville-green text-white">
          <Users size={16} aria-hidden="true" />
          <span className="font-barlow font-black text-lg leading-none">{righe.length}</span>
          <span className="font-maven text-[11px] opacity-80">{t('ticketBambini')}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-kidville-cream border border-kidville-line text-kidville-green">
          <Ticket size={16} aria-hidden="true" />
          <span className="font-barlow font-black text-lg leading-none">{residuiMostrati}</span>
          <span className="font-maven text-[11px] opacity-80">{t('ticketPastiResidui')}</span>
        </div>
        {senzaMostrati > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-kidville-error-soft border border-kidville-error/30 text-kidville-error-strong">
            <AlertTriangle size={16} aria-hidden="true" />
            <span className="font-barlow font-black text-lg leading-none">{senzaMostrati}</span>
            <span className="font-maven text-[11px]">{t('ticketSenzaPasti')}</span>
          </div>
        )}
      </div>

      {/* «Non ho potuto leggere i saldi» non deve travestirsi da «tutti a zero». */}
      {elenco?.saldi_non_disponibili && (
        <p role="alert" className="font-maven text-sm text-kidville-error-strong bg-kidville-error-soft rounded-input px-3 py-2 mb-3">
          {t('ticketSaldiNonDisponibili')}
        </p>
      )}
      {errore && <p role="alert" className="font-maven text-sm text-kidville-error-strong mb-3">{errore}</p>}
      {loading && <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>}

      {!loading && !errore && righe.length === 0 && (
        <p className="font-maven text-sm text-kidville-sub">{t('ticketNessunAlunno')}</p>
      )}

      {righe.length > 0 && (
        <ul className="space-y-1.5">
          {righe.map(r => {
            const esaurito = r.saldo_ticket <= 0;
            const st = storici[r.alunno_id];
            const espanso = aperto === r.alunno_id;
            return (
              <li key={r.alunno_id} className="rounded-card border border-kidville-line bg-kidville-white overflow-hidden">
                <button
                  type="button"
                  onClick={() => apri(r.alunno_id)}
                  aria-expanded={espanso}
                  aria-controls={`${idBase}-storico-${r.alunno_id}`}
                  className={cx(
                    'w-full min-h-[44px] flex items-center gap-3 px-3 py-2 text-left transition-colors',
                    espanso ? 'bg-kidville-cream' : 'hover:bg-kidville-cream/60')}>
                  <ChevronDown size={16} aria-hidden="true"
                    className={cx('shrink-0 text-kidville-sub transition-transform', espanso && 'rotate-180')} />
                  <span className="min-w-0 grow">
                    <span className="font-maven text-sm text-kidville-ink block truncate">{r.cognome} {r.nome}</span>
                    <span className="font-maven text-[11px] text-kidville-sub">
                      {r.classe ?? t('ticketSenzaClasse')}
                      {r.ultimo_carico ? ` · ${t('ticketUltimaRicarica')} ${dataIt(r.ultimo_carico)}` : ''}
                    </span>
                  </span>
                  <Badge tone={esaurito ? 'error' : 'success'} className="shrink-0">
                    {r.saldo_ticket} {t('ticketPasti')}
                  </Badge>
                </button>

                {espanso && (
                  <div id={`${idBase}-storico-${r.alunno_id}`} className="border-t border-kidville-line px-3 py-3 bg-kidville-cream/30">
                    <p className="font-maven text-xs font-bold text-kidville-sub uppercase mb-2 flex items-center gap-1.5">
                      <History size={13} aria-hidden="true" /> {t('ticketStoricoTitolo')}
                    </p>
                    {!st ? (
                      <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
                    ) : st === 'errore' ? (
                      <p role="alert" className="font-maven text-sm text-kidville-error-strong">{t('ticketStoricoErrore')}</p>
                    ) : st.storico_non_disponibile ? (
                      <p role="alert" className="font-maven text-sm text-kidville-error-strong">{t('ticketStoricoNonDisponibile')}</p>
                    ) : st.movimenti.length === 0 ? (
                      <p className="font-maven text-sm text-kidville-sub">{t('ticketStoricoVuoto')}</p>
                    ) : (
                      <ul className="space-y-1 max-h-64 overflow-y-auto">
                        {st.movimenti.map(m => (
                          <li key={m.id} className="flex items-center justify-between gap-2 rounded-input bg-kidville-white px-3 py-1.5">
                            <span className="font-maven text-xs text-kidville-ink truncate">
                              {dataIt(m.data)}
                              {m.origine ? <span className="text-kidville-sub"> · {m.origine}</span> : null}
                              {m.saldo_dopo !== null ? <span className="text-kidville-sub"> · {t('ticketSaldoDopo')} {m.saldo_dopo}</span> : null}
                            </span>
                            <Badge tone={toneMovimento(m.tipo)} className="shrink-0">{etichettaMovimento(m)}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
