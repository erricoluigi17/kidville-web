'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { useAnnoOpzionale } from '@/lib/context/anno-context';
import { SedeNotice, useSediAttive } from '@/lib/context/sede-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import type { CruscottoAnno } from '@/lib/anno/cruscotto-tipi';

/**
 * IL CRUSCOTTO DELL'ANNO PROSSIMO (PR 4.7, compito 4.7.3).
 *
 * Cinque blocchi (Posti, Risposte, Quote, Moduli e quota, Confronto) dallo stesso JSON della route
 * `GET /api/admin/anni/[annoSedeId]/cruscotto`; i moduli che mancano da `…/moduli-mancanti`; chi non ha firmato in app da
 * `…/senza-firma-app` (a pagine da 50). Il cruscotto mostra NUMERI: i nomi dei bambini compaiono solo nell'elenco «chi non ha
 * firmato», che è una lettura registrata nel registro degli accessi, e nelle liste della pagina Conferme a cui i numeri rimandano.
 *
 * ─── COSE CHE NON SI TOCCANO ─────────────────────────────────────────────────
 *  · Nessun conteggio si calcola qui: si riporta quello che il server risponde. Un numero che il server non dà non si inventa.
 *  · La stima del listino è una STIMA e lo dice; non si somma mai agli incassi.
 *  · Nessun nome nei log del client (`logClient` riceve solo la fase e lo stato HTTP).
 *  · Numeri e date con la lingua della pagina (`useLocale`), mai quella del browser.
 */

type Risposta = { stato: number; corpo: unknown };
type Lettura<T> = { fase: 'carico' } | { fase: 'ok'; dati: T } | { fase: 'errore'; stato: number };

type ModuloMancante = {
  modulo_id: string;
  codice: string;
  titolo?: string;
  lista: 'conferma' | 'nuova';
  mancanti: number;
  firma_in_app?: boolean;
};
type RigaSenzaFirma = { frequenza_id: string; alunno_id: string; nome: string | null; cognome: string | null; classe: string | null };

const PAGINA_SENZA_FIRMA = 50;
const PAGINA_CONFERME = '/admin/students/conferme';
/** «Tutte le iscrizioni dell'anno» in una lista sola: è la lista il cui totale è uguale ai numeri dell'incrocio e dei moduli. */
const TUTTO_L_ANNO = `${PAGINA_CONFERME}?vista=nuove&ambito=anno`;

/** Una GET. Non lancia mai: una rete caduta è `stato: 0`, e ogni esito non riuscito si registra (fisso, senza dati). */
async function leggi(url: string, userId: string): Promise<Risposta> {
  try {
    const res = await fetch(url, { headers: { 'x-user-id': userId } });
    const corpo: unknown = await res.json().catch(() => null);
    if (!res.ok) logClient({ livello: 'warn', evento: 'fetch', messaggio: 'admin/students/anno-prossimo:GET — richiesta non riuscita', stato: res.status });
    return { stato: res.status, corpo };
  } catch (err: unknown) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `admin/students/anno-prossimo:GET — ${nomeErrore(err)}` });
    return { stato: 0, corpo: null };
  }
}

const dataDi = (r: Risposta): Record<string, unknown> | null => {
  const d = (r.corpo as { data?: unknown } | null)?.data;
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
};

function useLettura<T>(url: string, userId: string, versione: number, estrai: (r: Risposta) => T | null): Lettura<T> {
  const [stato, setStato] = useState<{ chiave: string; lettura: Lettura<T> } | null>(null);
  const chiave = `${url}#${versione}`;
  useEffect(() => {
    let attivo = true;
    leggi(url, userId).then((r) => {
      if (!attivo) return;
      const dati = r.stato >= 200 && r.stato < 300 ? estrai(r) : null;
      setStato({ chiave, lettura: dati ? { fase: 'ok', dati } : { fase: 'errore', stato: r.stato } });
    });
    return () => {
      attivo = false;
    };
  }, [url, userId, chiave, estrai]);
  if (stato && stato.chiave === chiave) return stato.lettura;
  if (stato && stato.lettura.fase === 'ok') return stato.lettura;
  return { fase: 'carico' };
}

const estraiCruscotto = (r: Risposta): CruscottoAnno | null => {
  const d = dataDi(r);
  return d && Array.isArray(d.sezioni) && d.quota && d.incrocio && d.risposte ? (d as unknown as CruscottoAnno) : null;
};
const estraiModuli = (r: Risposta): ModuloMancante[] | null => {
  const m = dataDi(r)?.moduli;
  return Array.isArray(m) ? (m as ModuloMancante[]) : null;
};

const secondario =
  'inline-flex items-center gap-2 rounded-pill border-2 border-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.05em] text-kidville-green transition-transform hover:bg-kidville-green-soft active:scale-95 disabled:pointer-events-none disabled:opacity-45';
const collegamento = 'font-maven text-sm font-semibold text-kidville-green underline-offset-2 hover:underline focus-visible:underline';

export function CruscottoClient() {
  const t = useTranslations('annoCruscotto');
  const anno = useAnnoOpzionale();
  const { sedeCorrente, loading } = useSediAttive();
  const effettivo = anno?.effettivo ?? null;
  // Con più sedi attive l'anno non ha una sede: la cosa da chiedere è la SEDE, non l'anno (revisione finale, B2).
  if (loading) return <p role="status" className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>;
  if (!sedeCorrente) return <SedeNotice cosa={t('sedeCosa')} />;
  if (!effettivo || !effettivo.annoSedeId) return <p className="font-maven text-sm text-kidville-sub">{t('nessunAnno')}</p>;
  if (effettivo.attivo) return <p className="font-maven text-sm text-kidville-sub">{t('annoAttivo')}</p>;
  if (effettivo.stato !== 'iscrizioni_aperte') return <p className="font-maven text-sm text-kidville-sub">{t('annoNonAperto')}</p>;
  // `key`: cambiato l'anno si riparte da zero.
  return <Cruscotto key={effettivo.annoSedeId} annoSedeId={effettivo.annoSedeId} />;
}

function Blocco({ titolo, children }: { titolo: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-kidville-line bg-white p-5">
      <h2 className="mb-3 font-barlow text-lg font-extrabold uppercase tracking-[0.04em] text-kidville-ink">{titolo}</h2>
      {children}
    </section>
  );
}

function Numero({ valore, etichetta, href, avviso }: { valore: number; etichetta: string; href?: string; avviso?: boolean }) {
  const locale = useLocale();
  const t = useTranslations('annoCruscotto');
  const n = new Intl.NumberFormat(locale).format(valore);
  return (
    <div className="rounded-input border border-kidville-line px-3 py-2">
      <p className={`font-barlow text-2xl font-extrabold ${avviso ? 'text-kidville-error' : 'text-kidville-ink'}`}>{n}</p>
      <p className="font-maven text-sm text-kidville-sub">{etichetta}</p>
      {href && valore > 0 && (
        <Link href={href} className={collegamento} aria-label={`${etichetta}: ${t('apriLista')}`}>
          {t('apriLista')}
        </Link>
      )}
    </div>
  );
}

function Cruscotto({ annoSedeId }: { annoSedeId: string }) {
  const t = useTranslations('annoCruscotto');
  const tf = useTranslations('annoConferme');
  const locale = useLocale();
  const { userId } = useAdminIdentity();
  const uid = userId ?? '';
  const base = `/api/admin/anni/${annoSedeId}`;
  const [versione, setVersione] = useState(0);
  const rilegge = useCallback(() => setVersione((v) => v + 1), []);
  const lettura = useLettura(`${base}/cruscotto`, uid, versione, estraiCruscotto);
  const moduli = useLettura(`${base}/moduli-mancanti`, uid, versione, estraiModuli);

  if (lettura.fase === 'carico') return <p role="status" className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>;
  if (lettura.fase === 'errore') {
    const s = lettura.stato;
    const testo = s === 409 ? t('annoNonAperto') : s === 503 ? t('nonDisponibile') : s === 403 ? t('errorePermesso') : s === 0 ? t('erroreRete') : t('erroreGenerico');
    return (
      <div role="alert" className="rounded-card border border-kidville-line bg-white p-5">
        <p className="font-maven text-sm text-kidville-ink">{testo}</p>
        {s !== 409 && (
          <button type="button" className={`${secondario} mt-3`} onClick={rilegge}>
            {t('riprova')}
          </button>
        )}
      </div>
    );
  }

  const c = lettura.dati;
  const numero = new Intl.NumberFormat(locale);
  const euro = (v: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(v);
  const giorno = (iso: string, conAnno: boolean) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', ...(conAnno ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(d);
  };
  const fascia = (codice: string): string => {
    switch (codice) {
      case 'nido_1': return tf('fasciaNido1');
      case 'nido_2': return tf('fasciaNido2');
      case 'primavera': return tf('fasciaPrimavera');
      case 'infanzia': return tf('fasciaInfanzia');
      case 'primaria': return tf('fasciaPrimaria');
      case 'spazio_bambini': return tf('fasciaSpazioBambini');
      case 'senza_fascia': return tf('fasciaSenzaFascia');
      case 'senza_sezione': return tf('fasciaSenzaSezione');
      default: return codice;
    }
  };
  const q = c.quota;
  const inc = c.incrocio;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-maven text-sm text-kidville-sub">{t('periodo', { inizio: giorno(c.anno.inizio, true), fine: giorno(c.anno.fine, true) })}</p>
        <button type="button" className={secondario} onClick={rilegge}>
          {t('aggiorna')}
        </button>
      </div>

      <Blocco titolo={t('postiTitolo')}>
        {c.fasce.length === 0 ? (
          <p className="font-maven text-sm text-kidville-sub">{t('postiVuoto')}</p>
        ) : (
          <ul className="space-y-1">
            {c.fasce.map((f) => (
              <li key={f.fascia} className="font-maven text-sm text-kidville-ink">
                <strong>{fascia(f.fascia)}</strong>: {f.posti === null ? t('postiSenzaLimite', { iscritti: f.iscritti }) : t('postiRiga', { iscritti: f.iscritti, posti: f.posti })}
                {f.oltre && <span role="status" className="ml-2 font-semibold text-kidville-error">{t('postiOltre')}</span>}
              </li>
            ))}
          </ul>
        )}
        {c.sezioni.length > 0 && (
          <>
            <h3 className="mb-1 mt-4 font-maven text-sm font-semibold text-kidville-ink">{t('sezioniTitolo')}</h3>
            <ul className="grid gap-1 sm:grid-cols-2">
              {c.sezioni.map((s) => (
                <li key={s.section_id ?? 'senza'} className="flex justify-between gap-2 font-maven text-sm text-kidville-ink">
                  <span>{s.nome ?? t('sezioneSenza')}</span>
                  <span className="text-kidville-sub">{t('sezioneIscritti', { n: s.iscritti })}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Blocco>

      <Blocco titolo={t('risposteTitolo')}>
        <p className="mb-3 font-maven text-sm text-kidville-sub">{t('risposteIntro', { n: c.risposte.di_partenza })}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Numero valore={c.risposte.confermati} etichetta={t('rispostaConfermati')} href={`${PAGINA_CONFERME}?conferma=confermato`} />
          <Numero valore={c.risposte.no} etichetta={t('rispostaNo')} href={`${PAGINA_CONFERME}?conferma=no`} />
          <Numero valore={c.risposte.non_risposto} etichetta={t('rispostaNonRisposto')} href={`${PAGINA_CONFERME}?conferma=non_risposto`} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 font-maven text-sm text-kidville-ink">
          <span>
            <strong>{t('nuoveTitolo')}</strong>: {t('nuoveRiga', { n: c.nuove.totale })}
          </span>
          {c.nuove.totale > 0 && (
            <Link href={`${PAGINA_CONFERME}?vista=nuove`} className={collegamento}>
              {t('apriLista')}
            </Link>
          )}
        </div>
      </Blocco>

      <Blocco titolo={t('quoteTitolo')}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Numero valore={q.saldate} etichetta={t('quotaSaldate')} />
          <Numero valore={q.da_pagare} etichetta={t('quotaDaPagare')} />
          <Numero valore={q.assenti} etichetta={t('quotaAssenti')} />
        </div>
        <ul className="mt-3 space-y-1 font-maven text-sm text-kidville-ink">
          {q.senza_listino > 0 && (
            <li>
              {numero.format(q.senza_listino)} {t('quotaSenzaListino')}
            </li>
          )}
          <li>{t('quotaIncassati', { importo: euro(q.euro_incassati) })}</li>
          <li>{t('quotaDaIncassare', { importo: euro(q.euro_da_incassare) })}</li>
          {q.euro_assenti_stimati > 0 && <li className="text-kidville-sub">{t('quotaStima', { importo: euro(q.euro_assenti_stimati) })}</li>}
          {q.ritirati_con_voce > 0 && <li>{t('quotaRitirati', { n: q.ritirati_con_voce, importo: euro(q.euro_ritirati_incassati) })}</li>}
        </ul>
      </Blocco>

      <Blocco titolo={t('incrocioTitolo')}>
        <p className="mb-3 font-maven text-sm text-kidville-sub">{t('incrocioIntro', { n: inc.totale })}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Numero valore={inc.moduli_senza_quota} etichetta={t('incrocioModuliSenzaQuota')} href={`${TUTTO_L_ANNO}&conferma=moduli_senza_quota`} />
          <Numero valore={inc.quota_senza_moduli} etichetta={t('incrocioQuotaSenzaModuli')} href={`${TUTTO_L_ANNO}&conferma=quota_senza_moduli`} />
          <Numero valore={inc.entrambi} etichetta={t('incrocioEntrambi')} />
          <Numero valore={inc.nessuno_dei_due} etichetta={t('incrocioNessuno')} />
        </div>
        {inc.piu_voci > 0 && <p className="mt-3 font-maven text-sm text-kidville-ink">{t('incrocioPiuVoci', { n: inc.piu_voci })}</p>}

        <h3 className="mb-2 mt-5 font-maven text-sm font-semibold text-kidville-ink">{t('moduliTitolo')}</h3>
        {moduli.fase === 'carico' && <p role="status" className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>}
        {moduli.fase === 'errore' && (
          <p role="alert" className="font-maven text-sm text-kidville-ink">
            {t('erroreGenerico')}{' '}
            <button type="button" className={collegamento} onClick={rilegge}>
              {t('riprova')}
            </button>
          </p>
        )}
        {moduli.fase === 'ok' && moduli.dati.length === 0 && <p className="font-maven text-sm text-kidville-sub">{t('moduliVuoto')}</p>}
        {moduli.fase === 'ok' && moduli.dati.length > 0 && (
          <ul className="space-y-3">
            {moduli.dati.map((m) => (
              <li key={m.modulo_id} className="font-maven text-sm text-kidville-ink">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <strong>{m.titolo ?? m.codice}</strong>
                  <span className="text-kidville-sub">({m.lista === 'conferma' ? t('moduloListaConferma') : t('moduloListaNuova')})</span>
                  <span>{t('moduloMancanti', { n: m.mancanti })}</span>
                  {m.mancanti > 0 && (
                    <Link href={`${TUTTO_L_ANNO}&conferma=mancano_moduli&modulo=${m.modulo_id}`} className={collegamento}>
                      {t('moduloApriMancanti')}
                    </Link>
                  )}
                </div>
                {m.firma_in_app === true && <SenzaFirma annoSedeId={annoSedeId} modulo={m} userId={uid} />}
              </li>
            ))}
          </ul>
        )}
      </Blocco>

      <Blocco titolo={t('confrontoTitolo')}>
        {c.confronto === null ? (
          <p className="font-maven text-sm text-kidville-sub">{t('confrontoVuoto')}</p>
        ) : (
          <>
            <p className="mb-2 font-maven text-sm text-kidville-sub">{t('confrontoIntro', { giorno: giorno(c.confronto.giorno_anno_prima, false) })}</p>
            <ul className="space-y-1 font-maven text-sm text-kidville-ink">
              <li>{t('confrontoRiga', { anno: t('confrontoQuestoAnno'), domande: c.confronto.questo_anno.domande, conferme: c.confronto.questo_anno.conferme })}</li>
              <li>{t('confrontoRiga', { anno: c.confronto.anno_prima_etichetta, domande: c.confronto.anno_prima.domande, conferme: c.confronto.anno_prima.conferme })}</li>
            </ul>
            <p className="mt-2 font-maven text-sm text-kidville-sub">{t('confrontoNota')}</p>
            {c.confronto.ricostruito && <p className="mt-2 font-maven text-sm text-kidville-sub">{t('confrontoRicostruito')}</p>}
          </>
        )}
      </Blocco>
    </div>
  );
}

/** «Chi non ha firmato in app» per UN modulo del registro: a richiesta, a pagine da 50, con i nomi della sola pagina. */
function SenzaFirma({ annoSedeId, modulo, userId }: { annoSedeId: string; modulo: ModuloMancante; userId: string }) {
  const t = useTranslations('annoCruscotto');
  const [aperto, setAperto] = useState(false);
  const [righe, setRighe] = useState<RigaSenzaFirma[]>([]);
  const [totale, setTotale] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [fase, setFase] = useState<'fermo' | 'carico' | 'errore'>('fermo');

  const carica = async (prossima: number) => {
    setFase('carico');
    const r = await leggi(`/api/admin/anni/${annoSedeId}/senza-firma-app?modulo_id=${modulo.modulo_id}&pagina=${prossima}&limite=${PAGINA_SENZA_FIRMA}`, userId);
    const d = r.stato >= 200 && r.stato < 300 ? dataDi(r) : null;
    if (!d || !Array.isArray(d.righe)) {
      setFase('errore');
      return;
    }
    setRighe((v) => (prossima === 1 ? (d.righe as RigaSenzaFirma[]) : [...v, ...(d.righe as RigaSenzaFirma[])]));
    setTotale(typeof d.totale === 'number' ? d.totale : (d.righe as unknown[]).length);
    setPagina(prossima);
    setFase('fermo');
  };
  const alterna = () => {
    if (aperto) {
      setAperto(false);
      return;
    }
    setAperto(true);
    if (pagina === 0) void carica(1);
  };

  return (
    <div className="mt-1">
      <button type="button" className={collegamento} aria-expanded={aperto} onClick={alterna}>
        {aperto ? t('firmaNascondi') : t('firmaMostra')}
      </button>
      {aperto && (
        <div className="mt-2 rounded-input border border-kidville-line p-3">
          <h4 className="font-maven text-sm font-semibold">{t('firmaTitolo', { modulo: modulo.titolo ?? modulo.codice })}</h4>
          {fase === 'carico' && <p role="status" className="font-maven text-sm text-kidville-sub">{t('firmaCaricamento')}</p>}
          {fase === 'errore' && (
            <p role="alert" className="font-maven text-sm text-kidville-ink">
              {t('firmaErrore')}{' '}
              <button type="button" className={collegamento} onClick={() => void carica(Math.max(1, pagina + 1))}>
                {t('riprova')}
              </button>
            </p>
          )}
          {fase === 'fermo' && pagina > 0 && totale === 0 && <p className="font-maven text-sm text-kidville-sub">{t('firmaVuoto')}</p>}
          {totale > 0 && (
            <>
              <p className="mb-1 font-maven text-sm text-kidville-sub">{t('firmaTotale', { n: totale })}</p>
              <ul className="space-y-1">
                {righe.map((r) => {
                  const nome = `${r.cognome ?? ''} ${r.nome ?? ''}`.trim() || t('bambinoSenzaNome');
                  return (
                    <li key={r.frequenza_id} className="font-maven text-sm text-kidville-ink">
                      {nome}
                      {r.classe ? <span className="text-kidville-sub"> — {t('classe', { nome: r.classe })}</span> : null}
                    </li>
                  );
                })}
              </ul>
              {righe.length < totale && fase === 'fermo' && (
                <button type="button" className={`${secondario} mt-2`} onClick={() => void carica(pagina + 1)}>
                  {t('firmaAltri')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
