'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { btnPrimary, hint, input, label } from '@/components/features/admin/settings/ui';
import { Tabs } from '@/components/ui/cockpit';
import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { useAnnoOpzionale } from '@/lib/context/anno-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

/**
 * LE CONFERME PER L'ANNO PROSSIMO (PR 4.5, compito 4.5.6).
 *
 * Il selettore dell'anno (4.2) sceglie l'anno nuovo: qui compare solo se ha le iscrizioni aperte. Per ogni bambino dell'anno in
 * corso la segreteria vede se la famiglia ha confermato, ha detto «no» o non ha risposto, a che punto sono moduli e quota, e può
 * registrare la conferma o il «non rinnova». Le regole stanno nel database e nelle route `/api/admin/anni/[annoSedeId]/conferme*`.
 *
 * ─── COSE CHE NON SI TOCCANO ─────────────────────────────────────────────────
 *  · La route risponde SOLO con uuid, stati e numeri: i nomi li compone questa pagina dall'anagrafica che ha già (mai nei log).
 *  · Chi cambia grado sceglie la sezione e spunta «va alla primaria»: nessuna sezione può dire da sola che il bambino cambia scuola.
 *  · I posti sono un avviso, mai un blocco. Annullare una conferma NON ha un pulsante: la frequenza dell'anno prossimo si ritira dalla scheda.
 *  · Un rifiuto non cancella la scelta fatta nella riga: l'errore compare sotto la riga.
 */

type Conferma = 'confermato' | 'no' | 'non_risposto';
type Filtro = 'tutti' | Conferma;
type StatoQuota = 'saldata' | 'da_pagare' | 'assente';

type RigaApi = {
  frequenza_id: string;
  alunno_id: string;
  section_id: string | null;
  nuova_frequenza_id: string | null;
  nuova_section_id: string | null;
  conferma: Conferma;
  non_rinnova_motivo: string | null;
  moduli: { fatti: number; richiesti: number };
  quota: StatoQuota;
  cambia_grado: boolean;
};
type Posti = { fascia: string; iscritti: number; posti: number | null; oltre: boolean };
type Elenco = { righe: RigaApi[]; totale: number; limite: number; posti: Posti[] };
type Nome = { nome: string; classe: string | null };
type Sezione = { id: string; name: string; school_type: string };

type Risposta = { stato: number; corpo: unknown };
type Lettura<T> = { fase: 'carico' } | { fase: 'ok'; dati: T } | { fase: 'errore'; stato: number; corpo: unknown };

/** Una chiamata. Non lancia mai: una rete caduta è `stato: 0`, e ogni esito non riuscito si registra (fisso, senza dati). */
async function chiama(metodo: 'GET' | 'POST', url: string, userId: string, corpo?: Record<string, unknown>): Promise<Risposta> {
  const operazione = `admin/students/conferme:${metodo}`;
  try {
    const res = await fetch(url, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json', 'x-user-id': userId } : { 'x-user-id': userId },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    });
    const letto: unknown = await res.json().catch(() => null);
    if (!res.ok) logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — richiesta non riuscita`, stato: res.status });
    return { stato: res.status, corpo: letto };
  } catch (err: unknown) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — ${nomeErrore(err)}` });
    return { stato: 0, corpo: null };
  }
}

const riuscita = (r: Risposta) => r.stato >= 200 && r.stato < 300;
const dataDi = (r: Risposta): Record<string, unknown> | null => {
  const d = (r.corpo as { data?: unknown } | null)?.data;
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
};

/** Legge una volta per `chiave` (l'URL e la versione); finché non arriva la risposta nuova resta in vista quella di prima. */
function useLettura<T>(url: string, userId: string, versione: number, estrai: (r: Risposta) => T | null): Lettura<T> {
  const [stato, setStato] = useState<{ chiave: string; lettura: Lettura<T> } | null>(null);
  const chiave = `${url}#${versione}`;
  useEffect(() => {
    let attivo = true;
    chiama('GET', url, userId).then((r) => {
      if (!attivo) return;
      const dati = riuscita(r) ? estrai(r) : null;
      setStato({ chiave, lettura: dati ? { fase: 'ok', dati } : { fase: 'errore', stato: r.stato, corpo: r.corpo } });
    });
    return () => {
      attivo = false;
    };
  }, [url, userId, chiave, estrai]);
  if (stato && stato.chiave === chiave) return stato.lettura;
  if (stato && stato.lettura.fase === 'ok') return stato.lettura;
  return { fase: 'carico' };
}

const estraiElenco = (r: Risposta): Elenco | null => {
  const d = dataDi(r);
  if (!d || !Array.isArray(d.righe)) return null;
  return {
    righe: d.righe as RigaApi[],
    totale: typeof d.totale === 'number' ? d.totale : (d.righe as unknown[]).length,
    limite: typeof d.limite === 'number' && d.limite > 0 ? d.limite : 100,
    posti: Array.isArray(d.posti) ? (d.posti as Posti[]) : [],
  };
};

/** L'anagrafica dei bambini (nome e classe di oggi), una volta sola: la route delle conferme non porta nomi. */
const estraiNomi = (r: Risposta): Map<string, Nome> | null => {
  const righe = r.corpo;
  if (!Array.isArray(righe)) return null;
  const nomi = new Map<string, Nome>();
  for (const s of righe as Array<{ id?: string; nome?: string; cognome?: string; classe_sezione?: string | null }>) {
    if (typeof s.id === 'string') {
      nomi.set(s.id, { nome: `${s.cognome ?? ''} ${s.nome ?? ''}`.trim(), classe: s.classe_sezione ?? null });
    }
  }
  return nomi;
};

/** Le sezioni dell'anno scelto nel selettore (la route legge il cookie dell'anno): servono quelle della primaria. */
const estraiSezioni = (r: Risposta): Sezione[] | null => {
  const gruppi = (r.corpo as { data?: unknown } | null)?.data;
  if (!Array.isArray(gruppi)) return null;
  return (gruppi as Array<{ sezioni?: Sezione[] }>).flatMap((g) => (Array.isArray(g.sezioni) ? g.sezioni : []));
};

const secondario =
  'inline-flex items-center gap-2 rounded-pill border-2 border-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.05em] text-kidville-green transition-transform hover:bg-kidville-green-soft active:scale-95 disabled:pointer-events-none disabled:opacity-45';
const MOTIVI = ['altra_scuola', 'trasloco', 'fine_ciclo', 'motivi_economici', 'altro'] as const;

export function ConfermeClient() {
  const t = useTranslations('annoConferme');
  const anno = useAnnoOpzionale();
  const effettivo = anno?.effettivo ?? null;
  if (!effettivo || !effettivo.annoSedeId) return <p className="font-maven text-sm text-kidville-sub">{t('nessunAnno')}</p>;
  if (effettivo.attivo) return <p className="font-maven text-sm text-kidville-sub">{t('annoAttivo')}</p>;
  if (effettivo.stato !== 'iscrizioni_aperte') return <p className="font-maven text-sm text-kidville-sub">{t('annoNonAperto')}</p>;
  // `key`: cambiato l'anno si riparte da zero (pagina, filtro, righe).
  return <ElencoConferme key={effettivo.annoSedeId} annoSedeId={effettivo.annoSedeId} />;
}

function ElencoConferme({ annoSedeId }: { annoSedeId: string }) {
  const t = useTranslations('annoConferme');
  const { userId } = useAdminIdentity();
  const uid = userId ?? '';
  const base = `/api/admin/anni/${annoSedeId}`;
  const [pagina, setPagina] = useState(1);
  const [versione, setVersione] = useState(0);
  const [filtro, setFiltro] = useState<Filtro>('tutti');

  const lettura = useLettura(`${base}/conferme?pagina=${pagina}&conferma=${filtro}`, uid, versione, estraiElenco);
  const nomi = useLettura(`/api/admin/students?elenco=frequentanti&limit=${LIMITE_ELENCO_ALUNNI}`, uid, 0, estraiNomi);
  const sezioni = useLettura('/api/admin/sections/scoped?grado=primaria', uid, 0, estraiSezioni);
  const primarie = useMemo(() => (sezioni.fase === 'ok' ? sezioni.dati.filter((s) => s.school_type === 'primaria') : []), [sezioni]);
  const rilegge = useCallback(() => setVersione((v) => v + 1), []);

  const fascia = (codice: string): string => {
    switch (codice) {
      case 'nido_1': return t('fasciaNido1');
      case 'nido_2': return t('fasciaNido2');
      case 'primavera': return t('fasciaPrimavera');
      case 'infanzia': return t('fasciaInfanzia');
      case 'primaria': return t('fasciaPrimaria');
      case 'spazio_bambini': return t('fasciaSpazioBambini');
      default: return t('fasciaSenzaSezione');
    }
  };

  if (lettura.fase === 'carico') return <p role="status" className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>;
  if (lettura.fase === 'errore') {
    return (
      <div>
        <p role="alert" className="font-maven text-sm text-kidville-error">
          {lettura.stato === 0 ? t('erroreRete') : lettura.stato === 403 ? t('errorePermesso') : messaggioDaCorpo(lettura.corpo, t('erroreGenerico'))}
        </p>
        <button type="button" className={`${secondario} mt-3`} onClick={rilegge}>{t('riprova')}</button>
      </div>
    );
  }

  const { righe, totale, limite, posti } = lettura.dati;
  const pagine = Math.max(1, Math.ceil(totale / limite));
  // Il filtro lo applica la route: `righe` è già la pagina giusta e `totale` è il totale del filtro.
  const visibili = righe;
  const oltre = posti.filter((p) => p.oltre);

  return (
    <div>
      {oltre.map((p) => (
        <p key={p.fascia} role="status" className="mb-3 rounded-input border border-kidville-line bg-kidville-yellow-soft px-3 py-2 font-maven text-sm text-kidville-ink">
          {t('avvisoPosti', { fascia: fascia(p.fascia), iscritti: p.iscritti, posti: p.posti ?? 0 })}
        </p>
      ))}

      <Tabs
        value={filtro}
        onChange={(v) => {
          setFiltro(v as Filtro);
          setPagina(1);
        }}
        options={[
          { id: 'tutti', label: t('filtroTutti') },
          { id: 'confermato', label: t('filtroConfermati') },
          { id: 'no', label: t('filtroNo') },
          { id: 'non_risposto', label: t('filtroNonRisposto') },
        ]}
      />
      <p className={hint}>{t('totaleBambini', { totale })}</p>

      {visibili.length === 0 ? (
        <p className="mt-4 font-maven text-sm text-kidville-sub">{t('vuoto')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left font-maven text-sm text-kidville-green">
            <thead>
              <tr className="border-b border-kidville-line text-xs uppercase text-kidville-sub">
                <th scope="col" className="py-2 pr-3">{t('colBambino')}</th>
                <th scope="col" className="py-2 pr-3">{t('colRisposta')}</th>
                <th scope="col" className="py-2 pr-3">{t('colModuli')}</th>
                <th scope="col" className="py-2 pr-3">{t('colQuota')}</th>
                <th scope="col" className="py-2">{t('colAzioni')}</th>
              </tr>
            </thead>
            <tbody>
              {visibili.map((r) => (
                <RigaConferma
                  key={r.frequenza_id}
                  r={r}
                  annoSedeId={annoSedeId}
                  userId={uid}
                  nome={nomi.fase === 'ok' ? (nomi.dati.get(r.alunno_id) ?? null) : null}
                  primarie={primarie}
                  rilegge={rilegge}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={`${hint} mt-3`}>{t('annullareNota')}</p>

      {pagine > 1 && (
        <nav className="mt-4 flex items-center gap-3" aria-label={t('paginaDi', { pagina, pagine })}>
          <button type="button" className={secondario} disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>{t('precedente')}</button>
          <span className="font-maven text-sm text-kidville-sub">{t('paginaDi', { pagina, pagine })}</span>
          <button type="button" className={secondario} disabled={pagina >= pagine} onClick={() => setPagina((p) => p + 1)}>{t('successiva')}</button>
        </nav>
      )}
    </div>
  );
}

type Esito = { tipo: 'ok' | 'errore'; testo: string };

function RigaConferma({
  r,
  annoSedeId,
  userId,
  nome,
  primarie,
  rilegge,
}: {
  r: RigaApi;
  annoSedeId: string;
  userId: string;
  nome: Nome | null;
  primarie: Sezione[];
  rilegge: () => void;
}) {
  const t = useTranslations('annoConferme');
  const id = useId();
  const [vaPrimaria, setVaPrimaria] = useState(false);
  const [sezione, setSezione] = useState('');
  const [motivo, setMotivo] = useState('');
  const [occupata, setOccupata] = useState(false);
  const [esito, setEsito] = useState<Esito | null>(null);

  const motivi: Array<[string, string]> = [
    ['', t('motivoNessuno')],
    [MOTIVI[0], t('motivoAltraScuola')],
    [MOTIVI[1], t('motivoTrasloco')],
    [MOTIVI[2], t('motivoFineCiclo')],
    [MOTIVI[3], t('motivoEconomici')],
    [MOTIVI[4], t('motivoAltro')],
  ];
  const statoTesto = r.conferma === 'confermato' ? t('statoConfermato') : r.conferma === 'no' ? t('statoNo') : t('statoNonRisposto');
  const quotaTesto = r.quota === 'saldata' ? t('quotaSaldata') : r.quota === 'da_pagare' ? t('quotaDaPagare') : t('quotaAssente');

  const scrivi = async (url: string, corpo: Record<string, unknown>, ok: (d: Record<string, unknown> | null) => string): Promise<void> => {
    setOccupata(true);
    setEsito(null);
    const risposta = await chiama('POST', url, userId, corpo);
    setOccupata(false);
    if (!riuscita(risposta)) {
      setEsito({
        tipo: 'errore',
        testo: risposta.stato === 0 ? t('erroreRete') : risposta.stato === 403 ? t('errorePermesso') : messaggioDaCorpo(risposta.corpo, t('erroreGenerico')),
      });
      return;
    }
    setEsito({ tipo: 'ok', testo: ok(dataDi(risposta)) });
    rilegge();
  };

  const conferma = () =>
    scrivi(
      `/api/admin/anni/${annoSedeId}/conferme`,
      { frequenza_id: r.frequenza_id, ...(vaPrimaria ? { section_id: sezione, cambia_grado: true } : {}) },
      (d) =>
        [
          d?.creata === false ? t('esitoGiaConfermato') : t('esitoConfermato'),
          d?.posti_oltre === true ? t('esitoPostiOltre') : '',
          d?.retta_personalizzata_precedente === true ? t('esitoRettaPersonalizzata') : '',
        ]
          .filter(Boolean)
          .join(' '),
    );
  const nonRinnova = (attivo: boolean) =>
    scrivi(
      `/api/admin/anni/${annoSedeId}/conferme/non-rinnova`,
      { frequenza_id: r.frequenza_id, attivo, ...(attivo && motivo ? { motivo } : {}) },
      () => (attivo ? t('esitoNoSegnato') : t('esitoNoTolto')),
    );

  return (
    <>
      <tr className="border-b border-kidville-line align-top">
        <td className="py-3 pr-3">
          <strong>{nome?.nome || t('bambinoSenzaNome')}</strong>
          <span className="block text-xs text-kidville-sub">{nome?.classe ? t('classeOggi', { classe: nome.classe }) : t('senzaClasse')}</span>
        </td>
        <td className="py-3 pr-3">
          <span>{statoTesto}</span>
          {r.cambia_grado && <span className="block text-xs text-kidville-sub">{t('cambiaGrado')}</span>}
        </td>
        <td className="py-3 pr-3">{t('moduliFatti', { fatti: r.moduli.fatti, richiesti: r.moduli.richiesti })}</td>
        <td className="py-3 pr-3">{quotaTesto}</td>
        <td className="py-3">
          {r.conferma !== 'confermato' && (
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2" htmlFor={`${id}-primaria`}>
                <input id={`${id}-primaria`} type="checkbox" className="h-4 w-4 rounded accent-kidville-green" checked={vaPrimaria} onChange={(e) => setVaPrimaria(e.target.checked)} />
                <span>{t('vaAllaPrimaria')}</span>
              </label>
              {vaPrimaria && (
                primarie.length === 0 ? (
                  <p className={hint}>{t('nessunaPrimaria')}</p>
                ) : (
                  <div>
                    <label className={label} htmlFor={`${id}-sezione`}>{t('sezioneArrivo')}</label>
                    <select id={`${id}-sezione`} className={input} value={sezione} onChange={(e) => setSezione(e.target.value)}>
                      <option value="">{t('sezioneScegli')}</option>
                      {primarie.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                )
              )}
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={btnPrimary} disabled={occupata || (vaPrimaria && !sezione)} onClick={conferma}>{t('azioneConferma')}</button>
                {r.conferma === 'no' ? (
                  <button type="button" className={secondario} disabled={occupata} onClick={() => nonRinnova(false)}>{t('azioneAnnullaNo')}</button>
                ) : (
                  <>
                    <label className="sr-only" htmlFor={`${id}-motivo`}>{t('motivoEtichetta')}</label>
                    <select id={`${id}-motivo`} className={input} value={motivo} onChange={(e) => setMotivo(e.target.value)}>
                      {motivi.map(([valore, testo]) => <option key={valore} value={valore}>{testo}</option>)}
                    </select>
                    <button type="button" className={secondario} disabled={occupata} onClick={() => nonRinnova(true)}>{t('azioneNonRinnova')}</button>
                  </>
                )}
              </div>
            </div>
          )}
        </td>
      </tr>
      {esito && (
        <tr>
          <td colSpan={5} className="pb-2">
            <p role={esito.tipo === 'errore' ? 'alert' : 'status'} className={`font-maven text-sm ${esito.tipo === 'errore' ? 'text-kidville-error' : 'text-kidville-success'}`}>
              {esito.testo}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
