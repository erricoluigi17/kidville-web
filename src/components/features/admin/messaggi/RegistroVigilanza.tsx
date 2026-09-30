'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Loader2, Eye, Search, ListChecks } from 'lucide-react';
import { CockpitSelect } from '@/components/ui/cockpit';
import { formattaIstante } from '@/i18n/config';
import { logClient, nomeErrore } from '@/lib/logging/client';

/**
 * Il registro delle letture di vigilanza — visibile SOLO alla Direzione.
 *
 * La supervisione delle conversazioni genitore↔insegnante è silenziosa: i due
 * interlocutori non vedono nulla. Questa tabella è il contrappeso, e non ha
 * eccezioni — anche le letture di chi la sta guardando ci sono dentro.
 *
 * Il gate vero è nella route (`requireStaff(request, RUOLI_DIREZIONE)`): questa
 * scheda si nasconde alla segreteria per non offrirle un pulsante che darebbe
 * 403, non per proteggere il dato.
 */

interface RigaRegistro {
  id: string;
  lettoIl: string;
  azione: 'lettura' | 'ricerca' | string;
  esito: 'ok' | 'fuori-scope' | string;
  operatore: { id: string; nome: string; ruolo: string };
  threadId: string | null;
  alunno: { nome: string; classe: string | null } | null;
  nMessaggi: number | null;
  termine: string | null;
  ip: string | null;
}

/**
 * UNA RIGA CHE NON È UNA CONVERSAZIONE APERTA.
 *
 * `chat_vigilanza_accessi.azione` ammette due valori — `CHECK (azione IN
 * ('lettura','ricerca'))` — quindi anche chi guarda soltanto dei CONTEGGI scrive
 * `lettura`. Senza distinguerla, quella riga si leggeva «Ha aperto una
 * conversazione · Su che cosa: — · Quanti: 137»: tre righe per apertura con tre
 * sedi, e l'impressione che qualcuno avesse letto centotrentasette messaggi di
 * famiglie. Un registro che racconta più di quello che è successo è peggio di un
 * registro muto — perché gli si crede.
 *
 * ⚠️ IL CRITERIO È `azione === 'lettura'` SENZA `threadId`, e sta in piedi su un
 * fatto verificabile: chi legge una conversazione passa SEMPRE il `thread_id`
 * (`admin/chat/messages:GET`, che lo riceve in query e lo scrive nella riga,
 * anche sul ramo «fuori-scope»). L'unica strada che scrive `lettura` senza
 * thread è `admin/chat/docenti-senza-push:GET`, che conta e non legge niente. Se
 * un domani nascesse una seconda lettura senza thread, la cosa giusta è
 * distinguerle con un valore proprio di `azione` — una migrazione sul `CHECK`,
 * il tipo `AzioneVigilanza`, questa etichetta e il filtro — non allargare questo
 * ripiego a significare «tutto ciò che non ha un thread».
 */
const soloConteggi = (r: RigaRegistro) => r.azione === 'lettura' && !r.threadId;

export function RegistroVigilanza() {
  const t = useTranslations('adminComunicazioni');
  const locale = useLocale();
  const [righe, setRighe] = useState<RigaRegistro[]>([]);
  const [totale, setTotale] = useState(0);
  const [caricamento, setCaricamento] = useState(true);
  const [disponibile, setDisponibile] = useState(true);
  const [errore, setErrore] = useState('');
  const [fAzione, setFAzione] = useState('');
  const [fDa, setFDa] = useState('');
  const [fA, setFA] = useState('');

  /**
   * ⚠️ L'ETICHETTA SI RISOLVE QUI, FUORI DA `carica`.
   *
   * `useTranslations` non promette un'identità stabile fra i render: con `t`
   * nelle dipendenze, `carica` cambia a ogni render e `useEffect` lo rivede
   * nuovo, quindi la richiesta riparte. Misurato mentre si collaudava questa
   * scheda dalla pagina (`__tests__/pages/admin-messaggi-scheda-notifiche`): un
   * solo click produceva centinaia di GET a `/api/admin/chat/vigilanza`, tutte
   * in un turno di render. In produzione next-intl memoizza `t` e il ciclo non
   * parte — cioè è un difetto LATENTE che dipende dall'implementazione di una
   * libreria, ed è esattamente il genere di cosa che si scopre il giorno in cui
   * quella libreria cambia. La stringa invece è stabile.
   */
  const erroreLabel = t('registroErrore');

  const carica = useCallback(() => {
    const p = new URLSearchParams();
    if (fAzione) p.set('azione', fAzione);
    if (fDa) p.set('da', fDa);
    if (fA) p.set('a', fA);
    fetch(`/api/admin/chat/vigilanza?${p.toString()}`)
      .then(async (r) => ({ ok: r.ok, corpo: await r.json() }))
      .then(({ ok, corpo }) => {
        if (!ok || !corpo.success) {
          setErrore(erroreLabel);
          return;
        }
        setErrore('');
        setDisponibile(corpo.disponibile !== false);
        setRighe(corpo.data ?? []);
        setTotale(corpo.totale ?? 0);
      })
      .catch((e) => {
        // Un catch muto qui vorrebbe dire una tabella vuota indistinguibile da
        // «nessun accesso registrato» — sul registro degli accessi è la
        // differenza fra «nessuno ha guardato» e «non l'abbiamo chiesto».
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `registro-vigilanza-lettura-fallita: ${nomeErrore(e)}`,
          route: '/admin/messaggi',
        });
        setErrore(erroreLabel);
      })
      .finally(() => setCaricamento(false));
  }, [fAzione, fDa, fA, erroreLabel]);

  useEffect(() => { carica(); }, [carica]);

  const quando = (iso: string) => {
    try {
      return formattaIstante(new Date(iso), locale, {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  };

  return (
    <>
      <div className="mb-3 rounded-card bg-kidville-white p-4 shadow-sm">
        <p className="font-barlow font-bold text-kidville-green">{t('registroTitolo')}</p>
        <p className="mt-1 font-maven text-xs text-kidville-sub">{t('registroSottotitolo')}</p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <CockpitSelect
          value={fAzione}
          onChange={setFAzione}
          options={[
            { value: '', label: t('registroFiltroTutteAzioni') },
            { value: 'lettura', label: t('registroAzioneLettura') },
            { value: 'ricerca', label: t('registroAzioneRicerca') },
          ]}
        />
        <label className="font-maven text-xs text-kidville-sub">
          {t('messaggiPeriodoDa')}{' '}
          <input
            type="date"
            value={fDa}
            onChange={(e) => setFDa(e.target.value)}
            className="rounded-input border-2 border-kidville-line px-2 py-1 font-maven text-sm focus:border-kidville-green focus:outline-none"
          />
        </label>
        <label className="font-maven text-xs text-kidville-sub">
          {t('messaggiPeriodoA')}{' '}
          <input
            type="date"
            value={fA}
            onChange={(e) => setFA(e.target.value)}
            className="rounded-input border-2 border-kidville-line px-2 py-1 font-maven text-sm focus:border-kidville-green focus:outline-none"
          />
        </label>
        <span className="font-maven text-xs font-semibold text-kidville-ink">{t('registroTotale', { n: totale })}</span>
      </div>

      <div className="rounded-card bg-kidville-white p-3 shadow-sm">
        {caricamento ? (
          <p className="flex items-center gap-2 p-2 font-maven text-sm text-kidville-sub">
            <Loader2 size={14} className="animate-spin" /> {t('caricamento')}
          </p>
        ) : errore ? (
          <p role="alert" className="rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">{errore}</p>
        ) : !disponibile ? (
          <p className="p-2 font-maven text-sm text-kidville-sub">{t('registroNonDisponibile')}</p>
        ) : righe.length === 0 ? (
          <p className="p-2 font-maven text-sm text-kidville-sub">{t('registroVuoto')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="border-b border-kidville-line text-left">
                  {['registroColQuando', 'registroColChi', 'registroColAzione', 'registroColOggetto', 'registroColQuanti', 'registroColIp'].map((k) => (
                    <th key={k} className="px-2 py-2 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-sub">{t(k)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {righe.map((r) => (
                  <tr key={r.id} className="border-b border-kidville-line/60 align-top">
                    <td className="whitespace-nowrap px-2 py-2 font-maven text-xs text-kidville-sub">{quando(r.lettoIl)}</td>
                    <td className="px-2 py-2 font-maven text-sm text-kidville-ink">
                      {r.operatore.nome}
                      <span className="block font-maven text-[11px] text-kidville-sub">{r.operatore.ruolo}</span>
                    </td>
                    <td className="px-2 py-2 font-maven text-xs text-kidville-ink">
                      <span className="inline-flex items-center gap-1">
                        {r.azione === 'ricerca' ? <Search size={12} /> : soloConteggi(r) ? <ListChecks size={12} /> : <Eye size={12} />}
                        {r.azione === 'ricerca'
                          ? t('registroAzioneRicerca')
                          : soloConteggi(r)
                            ? t('registroAzioneElencoNotifiche')
                            : t('registroAzioneLettura')}
                      </span>
                      {r.esito === 'fuori-scope' && (
                        <span className="ml-1 inline-flex items-center rounded-full bg-kidville-warn-soft px-2 py-0.5 font-barlow text-[9px] font-bold uppercase tracking-wide text-kidville-warn">
                          {t('registroEsitoFuoriScope')}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 font-maven text-xs text-kidville-ink">
                      {r.alunno ? `${r.alunno.nome}${r.alunno.classe ? ` · ${r.alunno.classe}` : ''}` : '—'}
                      {r.termine && <span className="block text-kidville-sub">{t('registroTermine', { termine: r.termine })}</span>}
                    </td>
                    <td className="px-2 py-2 font-maven text-xs text-kidville-ink">
                      {r.nMessaggi == null
                        ? '—'
                        : soloConteggi(r)
                          ? t('registroQuantiConteggiati', { n: r.nMessaggi })
                          : r.nMessaggi}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 font-maven text-[11px] text-kidville-sub">{r.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
