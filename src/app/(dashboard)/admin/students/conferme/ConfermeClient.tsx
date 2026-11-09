'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { btnPrimary, hint, input, label } from '@/components/features/admin/settings/ui';
import { Tabs } from '@/components/ui/cockpit';
import { useAdminIdentity, useRuoloCockpit } from '@/lib/context/admin-identity';
import { useAnnoOpzionale } from '@/lib/context/anno-context';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

/**
 * LE CONFERME PER L'ANNO PROSSIMO (PR 4.5, compiti 4.5.6 e 4.5.10).
 *
 * Il selettore dell'anno (4.2) sceglie l'anno nuovo: qui compare solo se ha le iscrizioni aperte. Due viste:
 *  · «Conferme» — per ogni bambino dell'anno in corso la segreteria vede se la famiglia ha confermato, ha detto «no» o non ha
 *    risposto, a che punto sono moduli e quota, e può registrare la conferma o il «non rinnova»;
 *  · «Nuove iscrizioni» — i bambini che arrivano da fuori: senza questa vista non avrebbero un posto dove spuntare i moduli, e la loro
 *    iscrizione non diventerebbe mai «iscritto».
 * In tutte e due, chi ha una frequenza dell'anno nuovo ha il pannello dei moduli: la segreteria spunta, il DATABASE ricalcola i flag e lo
 * stato (qui non si scrive mai `moduli_completi`, `quota_saldata` o `stato`: si riporta quello che il server risponde).
 * Le regole stanno nel database e nelle route `/api/admin/anni/[annoSedeId]/conferme*` e `/api/admin/frequenze/[id]/moduli`.
 *
 * ─── COSE CHE NON SI TOCCANO ─────────────────────────────────────────────────
 *  · I nomi li porta la route, solo della pagina (mai nei log): questa pagina non scarica più l'elenco delle schede.
 *  · Chi cambia grado sceglie la sezione e spunta «va alla primaria»: nessuna sezione può dire da sola che il bambino cambia scuola.
 *  · I posti sono un avviso, mai un blocco. Annullare una conferma NON ha un pulsante: la frequenza dell'anno prossimo si ritira dalla scheda.
 *  · L'ESITO NON VIVE DENTRO LA RIGA. Un filtro («Mancano moduli», «Non hanno risposto») fa uscire dall'elenco la riga appena lavorata, e con
 *    lei il messaggio: l'esito sta in un posto sopra la tabella, e resta leggibile finché la segreteria non cambia vista, filtro o pagina.
 *    Una spunta NON rilegge l'elenco: la riga si aggiorna con la risposta del server e resta dov'è finché non si ricarica (pulsante
 *    «Aggiorna l'elenco»), così la segreteria non vede sparire sotto le dita la riga su cui sta lavorando.
 *  · Un rifiuto non cancella la scelta fatta nella riga, e la casella di un modulo resta com'era.
 */

type Conferma = 'confermato' | 'no' | 'non_risposto';
type Vista = 'conferme' | 'nuove';
type Filtro = 'tutti' | Conferma | 'mancano_moduli';
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
  stato_frequenza: string | null;
  nome: string | null;
  cognome: string | null;
  classe: string | null;
};
type Posti = { fascia: string; iscritti: number; posti: number | null; oltre: boolean };
type Elenco = { righe: RigaApi[]; totale: number; limite: number; posti: Posti[] };
type Sezione = { id: string; name: string; school_type: string };
type ModuloApi = {
  modulo_id: string;
  codice: string;
  titolo: string;
  ordine: number;
  spuntato: boolean;
  spuntato_il: string | null;
  firmato_in_app_il: string | null;
};
/** Ciò che il server ha risposto a una spunta, applicato alla riga senza rileggere l'elenco. */
/** L'esito della voce della quota che il server ha risposto all'ultima conferma di una riga (I1, 4.5.15). */
type EsitoQuota = 'senza_listino' | 'piu_voci';
type Aggiornamento = { fatti: number; stato: string; quotaSaldata: boolean };
type Esito = { tipo: 'ok' | 'errore'; testo: string };

type Risposta = { stato: number; corpo: unknown };
type Lettura<T> = { fase: 'carico' } | { fase: 'ok'; dati: T } | { fase: 'errore'; stato: number; corpo: unknown };

/** Una chiamata. Non lancia mai: una rete caduta è `stato: 0`, e ogni esito non riuscito si registra (fisso, senza dati). */
async function chiama(metodo: 'GET' | 'POST' | 'PUT', url: string, userId: string, corpo?: Record<string, unknown>): Promise<Risposta> {
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

/** Le sezioni dell'anno scelto nel selettore (la route legge il cookie dell'anno): servono quelle della primaria. */
const estraiSezioni = (r: Risposta): Sezione[] | null => {
  const gruppi = (r.corpo as { data?: unknown } | null)?.data;
  if (!Array.isArray(gruppi)) return null;
  return (gruppi as Array<{ sezioni?: Sezione[] }>).flatMap((g) => (Array.isArray(g.sezioni) ? g.sezioni : []));
};

const estraiModuli = (r: Risposta): ModuloApi[] | null => {
  const m = dataDi(r)?.moduli;
  return Array.isArray(m) ? (m as ModuloApi[]) : null;
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
  const [vista, setVista] = useState<Vista>('conferme');
  const [filtro, setFiltro] = useState<Filtro>('tutti');
  // Le righe lavorate dopo l'ultima lettura: quello che il server ha risposto a una spunta, per frequenza.
  const [aggiornate, setAggiornate] = useState<Record<string, Aggiornamento>>({});
  // L'esito dell'ultima operazione: qui sopra la tabella, non dentro la riga (vedi la testata).
  const [esito, setEsito] = useState<Esito | null>(null);
  // L'esito della quota per riga, finché la pagina è aperta: una rilettura NON lo toglie (dal server si legge solo «assente»).
  const [esitiQuota, setEsitiQuota] = useState<Record<string, EsitoQuota | null>>({});
  const ricordaQuota = useCallback((frequenzaId: string, e: EsitoQuota | null) => setEsitiQuota((v) => ({ ...v, [frequenzaId]: e })), []);

  const lettura = useLettura(`${base}/conferme?pagina=${pagina}&vista=${vista}&conferma=${filtro}`, uid, versione, estraiElenco);
  const sezioni = useLettura('/api/admin/sections/scoped?grado=primaria', uid, 0, estraiSezioni);
  const primarie = useMemo(() => (sezioni.fase === 'ok' ? sezioni.dati.filter((s) => s.school_type === 'primaria') : []), [sezioni]);
  // Una rilettura (dopo una conferma) NON toglie l'esito: la riga può uscire dal filtro, il messaggio no.
  const rilegge = useCallback(() => {
    setAggiornate({});
    setVersione((v) => v + 1);
  }, []);
  const riparti = useCallback(() => {
    setAggiornate({});
    setEsito(null);
    setEsitiQuota({});
  }, []);
  const aggiorna = useCallback((frequenzaId: string, a: Aggiornamento) => setAggiornate((x) => ({ ...x, [frequenzaId]: a })), []);

  const fascia = (codice: string): string => {
    switch (codice) {
      case 'nido_1': return t('fasciaNido1');
      case 'nido_2': return t('fasciaNido2');
      case 'primavera': return t('fasciaPrimavera');
      case 'infanzia': return t('fasciaInfanzia');
      case 'primaria': return t('fasciaPrimaria');
      case 'spazio_bambini': return t('fasciaSpazioBambini');
      case 'senza_fascia': return t('fasciaSenzaFascia');
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
  // Bambini in classi che non hanno la fascia: i posti per fascia non li contano (si sceglie la fascia nella scheda Classi).
  const senzaFascia = posti.find((p) => p.fascia === 'senza_fascia')?.iscritti ?? 0;
  const filtri: Array<{ id: Filtro; label: string }> =
    vista === 'conferme'
      ? [
          { id: 'tutti', label: t('filtroTutti') },
          { id: 'confermato', label: t('filtroConfermati') },
          { id: 'no', label: t('filtroNo') },
          { id: 'non_risposto', label: t('filtroNonRisposto') },
          { id: 'mancano_moduli', label: t('filtroManca') },
        ]
      : [
          { id: 'tutti', label: t('filtroTutti') },
          { id: 'mancano_moduli', label: t('filtroManca') },
        ];

  return (
    <div>
      {oltre.map((p) => (
        <p key={p.fascia} role="status" className="mb-3 rounded-input border border-kidville-line bg-kidville-yellow-soft px-3 py-2 font-maven text-sm text-kidville-ink">
          {t('avvisoPosti', { fascia: fascia(p.fascia), iscritti: p.iscritti, posti: p.posti ?? 0 })}
        </p>
      ))}

      {senzaFascia > 0 && (
        <p role="status" className="mb-3 rounded-input border border-kidville-line bg-kidville-yellow-soft px-3 py-2 font-maven text-sm text-kidville-ink">
          {t('avvisoSenzaFascia', { n: senzaFascia })}
        </p>
      )}

      <div role="group" aria-label={t('vistaEtichetta')}>
        <Tabs
          value={vista}
          onChange={(v) => {
            setVista(v as Vista);
            setFiltro('tutti');
            setPagina(1);
            riparti();
          }}
          options={[
            { id: 'conferme', label: t('vistaConferme') },
            { id: 'nuove', label: t('vistaNuove') },
          ]}
        />
      </div>
      <Tabs
        value={filtro}
        onChange={(v) => {
          setFiltro(v as Filtro);
          setPagina(1);
          riparti();
        }}
        options={filtri}
      />
      {vista === 'nuove' && <p className={hint}>{t('nuoveNota')}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <p className={hint}>{t('totaleBambini', { totale })}</p>
        <button type="button" className={secondario} onClick={rilegge}>{t('azioneAggiorna')}</button>
      </div>

      {esito && (
        <p
          role={esito.tipo === 'errore' ? 'alert' : 'status'}
          aria-label={t('esitoRegione')}
          className={`mt-3 rounded-input border border-kidville-line px-3 py-2 font-maven text-sm ${esito.tipo === 'errore' ? 'text-kidville-error' : 'text-kidville-success'}`}
        >
          {esito.testo}
        </p>
      )}

      {visibili.length === 0 ? (
        <p className="mt-4 font-maven text-sm text-kidville-sub">{vista === 'nuove' ? t('vuotoNuove') : t('vuoto')}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left font-maven text-sm text-kidville-green">
            <thead>
              <tr className="border-b border-kidville-line text-xs uppercase text-kidville-sub">
                <th scope="col" className="py-2 pr-3">{t('colBambino')}</th>
                <th scope="col" className="py-2 pr-3">{vista === 'conferme' ? t('colRisposta') : t('colStato')}</th>
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
                  vista={vista}
                  aggiornata={aggiornate[r.nuova_frequenza_id ?? r.frequenza_id] ?? null}
                  annoSedeId={annoSedeId}
                  userId={uid}
                  primarie={primarie}
                  rilegge={rilegge}
                  segnala={setEsito}
                  aggiorna={aggiorna}
                  esitoQuota={esitiQuota[r.frequenza_id] ?? null}
                  ricordaQuota={ricordaQuota}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className={`${hint} mt-3`}>{t('annullareNota')}</p>

      {pagine > 1 && (
        <nav className="mt-4 flex items-center gap-3" aria-label={t('paginaDi', { pagina, pagine })}>
          <button type="button" className={secondario} disabled={pagina <= 1} onClick={() => { setPagina((p) => p - 1); riparti(); }}>{t('precedente')}</button>
          <span className="font-maven text-sm text-kidville-sub">{t('paginaDi', { pagina, pagine })}</span>
          <button type="button" className={secondario} disabled={pagina >= pagine} onClick={() => { setPagina((p) => p + 1); riparti(); }}>{t('successiva')}</button>
        </nav>
      )}
    </div>
  );
}

function RigaConferma({
  r,
  vista,
  aggiornata,
  annoSedeId,
  userId,
  primarie,
  rilegge,
  segnala,
  aggiorna,
  esitoQuota,
  ricordaQuota,
}: {
  r: RigaApi;
  vista: Vista;
  aggiornata: Aggiornamento | null;
  annoSedeId: string;
  userId: string;
  primarie: Sezione[];
  rilegge: () => void;
  segnala: (e: Esito) => void;
  aggiorna: (frequenzaId: string, a: Aggiornamento) => void;
  esitoQuota: EsitoQuota | null;
  ricordaQuota: (frequenzaId: string, e: EsitoQuota | null) => void;
}) {
  const t = useTranslations('annoConferme');
  const id = useId();
  const [vaPrimaria, setVaPrimaria] = useState(false);
  const [sezione, setSezione] = useState('');
  const [motivo, setMotivo] = useState('');
  const [occupata, setOccupata] = useState(false);
  // Togliere una conferma tocca la contabilità: lo fanno solo admin e segreteria (come l'eliminazione di una voce), e la
  // coordinatrice non vede il pulsante (la route risponde 403 comunque). Sbaglia verso il nascondere: ruolo ignoto = nascosto.
  const puoRitirare = ['admin', 'segreteria'].includes(useRuoloCockpit());
  const [chiediRitiro, setChiediRitiro] = useState(false);
  const [moduliAperti, setModuliAperti] = useState(false);

  const nome = `${r.cognome ?? ''} ${r.nome ?? ''}`.trim() || t('bambinoSenzaNome');
  const motivi: Array<[string, string]> = [
    ['', t('motivoNessuno')],
    [MOTIVI[0], t('motivoAltraScuola')],
    [MOTIVI[1], t('motivoTrasloco')],
    [MOTIVI[2], t('motivoFineCiclo')],
    [MOTIVI[3], t('motivoEconomici')],
    [MOTIVI[4], t('motivoAltro')],
  ];
  const statoTesto = r.conferma === 'confermato' ? t('statoConfermato') : r.conferma === 'no' ? t('statoNo') : t('statoNonRisposto');
  // Quello che il server ha risposto a una spunta vale più della lettura di prima.
  const statoFrequenza = aggiornata?.stato ?? r.stato_frequenza;
  const statoFrequenzaTesto = statoFrequenza === 'iscritto' ? t('statoIscritto') : statoFrequenza === 'in_attesa' ? t('statoInAttesa') : null;
  const fatti = aggiornata?.fatti ?? r.moduli.fatti;
  const quota: StatoQuota = aggiornata ? (aggiornata.quotaSaldata ? 'saldata' : r.quota === 'saldata' ? 'da_pagare' : r.quota) : r.quota;
  // «Assente» ha tre significati: la riga non è ancora confermata («Non ancora»), la quota non è nata perché il listino non c'era
  // («Quota da generare»), o ci sono più voci da guardare («Più voci»). Solo il secondo e il terzo hanno un'azione.
  const confermata = r.conferma === 'confermato' || vista === 'nuove';
  // Il pulsante c'è solo nella vista delle conferme: la route riparte dalla frequenza dell'anno in corso. Le «nuove» non ne hanno una.
  const quotaDaGenerare = vista === 'conferme' && quota === 'assente' && confermata && esitoQuota !== 'piu_voci';
  const quotaTesto =
    quota === 'saldata'
      ? t('quotaSaldata')
      : quota === 'da_pagare'
        ? t('quotaDaPagare')
        : esitoQuota === 'piu_voci'
          ? t('quotaPiuVoci')
          : confermata
            ? t('quotaDaGenerare')
            : t('quotaAssente');

  const scrivi = async (
    url: string,
    corpo: Record<string, unknown>,
    ok: (d: Record<string, unknown> | null) => string,
    dopo?: (d: Record<string, unknown> | null) => void,
  ): Promise<void> => {
    setOccupata(true);
    const risposta = await chiama('POST', url, userId, corpo);
    setOccupata(false);
    if (!riuscita(risposta)) {
      segnala({ tipo: 'errore', testo: t('esitoDi', { nome, testo: testoErrore(t, risposta) }) });
      return;
    }
    segnala({ tipo: 'ok', testo: t('esitoDi', { nome, testo: ok(dataDi(risposta)) }) });
    dopo?.(dataDi(risposta));
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
          d?.quota === 'senza_listino' ? t('esitoQuotaSenzaListino') : '',
          d?.quota === 'piu_voci' ? t('esitoQuotaPiuVoci') : '',
        ]
          .filter(Boolean)
          .join(' '),
      (d) => ricordaQuota(r.frequenza_id, d?.quota === 'senza_listino' || d?.quota === 'piu_voci' ? d.quota : null),
    );
  const ritira = async () => {
    setChiediRitiro(false);
    await scrivi(
      `/api/admin/anni/${annoSedeId}/conferme/ritira`,
      { frequenza_id: r.nuova_frequenza_id ?? '' },
      (d) =>
        [
          t('esitoRitirata'),
          d?.quota === 'tolta' ? t('esitoRitirataQuotaTolta') : '',
          d?.quota === 'resta-pagata' ? t('esitoRitirataQuotaPagata') : '',
          d?.quota === 'errore' ? t('esitoRitirataQuotaErrore') : '',
        ]
          .filter(Boolean)
          .join(' '),
    );
  };
  // Stessa route della conferma: ripetibile, la voce nasce solo se manca.
  const generaQuota = () =>
    scrivi(
      `/api/admin/anni/${annoSedeId}/conferme`,
      { frequenza_id: r.frequenza_id },
      (d) => (d?.quota === 'senza_listino' ? t('esitoQuotaSenzaListino') : d?.quota === 'piu_voci' ? t('esitoQuotaPiuVoci') : t('esitoQuotaGenerata')),
      (d) => ricordaQuota(r.frequenza_id, d?.quota === 'senza_listino' || d?.quota === 'piu_voci' ? d.quota : null),
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
          {/* Nelle «nuove» il bambino è `in_arrivo`: non sta in «Alunni» e la sua scheda si apre da qui (4.5.15, C2). */}
          {vista === 'nuove' ? (
            <Link
              href={`/admin/students/${r.alunno_id}?kind=child`}
              aria-label={t('apriScheda', { nome })}
              className="underline-offset-2 hover:underline focus-visible:underline"
            >
              <strong>{nome}</strong>
            </Link>
          ) : (
            <strong>{nome}</strong>
          )}
          <span className="block text-xs text-kidville-sub">{r.classe ? t('classeOggi', { classe: r.classe }) : t('senzaClasse')}</span>
        </td>
        <td className="py-3 pr-3">
          {vista === 'conferme' && <span>{statoTesto}</span>}
          {vista === 'conferme' && r.cambia_grado && <span className="block text-xs text-kidville-sub">{t('cambiaGrado')}</span>}
          {statoFrequenzaTesto && (vista === 'nuove' ? <span>{statoFrequenzaTesto}</span> : <span className="block text-xs text-kidville-sub">{statoFrequenzaTesto}</span>)}
        </td>
        <td className="py-3 pr-3">{t('moduliFatti', { fatti, richiesti: r.moduli.richiesti })}</td>
        <td className="py-3 pr-3">{quotaTesto}</td>
        <td className="py-3">
          <div className="flex flex-col gap-2">
            {vista === 'conferme' && r.conferma !== 'confermato' && (
              <>
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
              </>
            )}
            {vista === 'conferme' && r.conferma === 'confermato' && r.nuova_frequenza_id && puoRitirare && (
              chiediRitiro ? (
                <div role="group" aria-label={t('ritiraEtichetta', { nome })} className="rounded-input border border-kidville-line p-2">
                  <p className={hint}>{t('ritiraDomanda', { nome })}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className={btnPrimary} disabled={occupata} onClick={ritira}>{t('ritiraSi')}</button>
                    <button type="button" className={secondario} onClick={() => setChiediRitiro(false)}>{t('ritiraAnnulla')}</button>
                  </div>
                </div>
              ) : (
                <button type="button" className={secondario} disabled={occupata} onClick={() => setChiediRitiro(true)}>{t('azioneRitiraConferma')}</button>
              )
            )}
            {quotaDaGenerare && (
              <button type="button" className={secondario} disabled={occupata} onClick={generaQuota}>{t('azioneGeneraQuota')}</button>
            )}
            {r.nuova_frequenza_id && (
              <button
                type="button"
                className={secondario}
                aria-expanded={moduliAperti}
                aria-controls={`${id}-moduli`}
                onClick={() => setModuliAperti((v) => !v)}
              >
                {moduliAperti ? t('moduliChiudi') : t('moduliApri')}
              </button>
            )}
          </div>
        </td>
      </tr>
      {moduliAperti && r.nuova_frequenza_id && (
        <tr id={`${id}-moduli`} className="border-b border-kidville-line">
          <td colSpan={5} className="pb-3">
            <PannelloModuli
              frequenzaId={r.nuova_frequenza_id}
              nome={nome}
              userId={userId}
              segnala={segnala}
              aggiorna={aggiorna}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function testoErrore(t: ReturnType<typeof useTranslations>, r: Risposta): string {
  if (r.stato === 0) return t('erroreRete');
  if (r.stato === 403) return t('errorePermesso');
  return messaggioDaCorpo(r.corpo, t('erroreGenerico'));
}

/**
 * Il pannello dei moduli di una frequenza dell'anno nuovo. Sta nella riga, ma NON più largo dello schermo: dentro una tabella che scorre in
 * orizzontale resta appiccicato a sinistra e largo al massimo quanto la finestra, così su un tablet o un telefono non esce dal bordo.
 * Le caselle sono alte almeno 44 px (bersaglio da toccare con un dito).
 */
function PannelloModuli({
  frequenzaId,
  nome,
  userId,
  segnala,
  aggiorna,
}: {
  frequenzaId: string;
  nome: string;
  userId: string;
  segnala: (e: Esito) => void;
  aggiorna: (frequenzaId: string, a: Aggiornamento) => void;
}) {
  const t = useTranslations('annoConferme');
  const locale = useLocale();
  const url = `/api/admin/frequenze/${frequenzaId}/moduli`;
  const [versione, setVersione] = useState(0);
  const lettura = useLettura(url, userId, versione, estraiModuli);
  // Le caselle cambiate in questa sessione: valgono finché il server non risponde diversamente.
  const [cambiati, setCambiati] = useState<Record<string, boolean>>({});
  const [occupato, setOccupato] = useState<string | null>(null);

  const giorno = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  };

  const cambia = async (m: ModuloApi, moduli: ModuloApi[], nuovo: boolean): Promise<void> => {
    setOccupato(m.modulo_id);
    const risposta = await chiama('PUT', url, userId, { modulo_id: m.modulo_id, spuntato: nuovo });
    setOccupato(null);
    if (!riuscita(risposta)) {
      // La casella resta com'era: il rifiuto non cambia niente, e lo dice in italiano (`MODULO_NON_RICHIESTO`, `ANNO_CHIUSO`…).
      segnala({ tipo: 'errore', testo: t('esitoDi', { nome, testo: testoErrore(t, risposta) }) });
      return;
    }
    const d = dataDi(risposta);
    const stato = typeof d?.stato === 'string' ? d.stato : 'in_attesa';
    const dopo = { ...cambiati, [m.modulo_id]: nuovo };
    const fatti = moduli.filter((x) => (dopo[x.modulo_id] ?? x.spuntato)).length;
    setCambiati(dopo);
    aggiorna(frequenzaId, { fatti, stato, quotaSaldata: d?.quota_saldata === true });
    segnala({
      tipo: 'ok',
      testo: t('esitoDi', {
        nome,
        testo: `${nuovo ? t('esitoModuloSpuntato', { titolo: m.titolo }) : t('esitoModuloTolto', { titolo: m.titolo })} ${t('esitoStatoOra', { stato: stato === 'iscritto' ? t('statoIscritto') : t('statoInAttesa') })}`,
      }),
    });
  };

  return (
    <div className="sticky left-0 w-[min(100%,calc(100vw-2.5rem))] rounded-input border border-kidville-line bg-kidville-white p-3">
      {lettura.fase === 'carico' && <p role="status" className="font-maven text-sm text-kidville-sub">{t('moduliCaricamento')}</p>}
      {lettura.fase === 'errore' && (
        <div>
          <p role="alert" className="font-maven text-sm text-kidville-error">{testoErrore(t, { stato: lettura.stato, corpo: lettura.corpo })}</p>
          <button type="button" className={`${secondario} mt-3`} onClick={() => setVersione((v) => v + 1)}>{t('riprova')}</button>
        </div>
      )}
      {lettura.fase === 'ok' && (
        lettura.dati.length === 0 ? (
          <p className="font-maven text-sm text-kidville-sub">{t('moduliNessuno')}</p>
        ) : (
          <ul aria-label={t('moduliElenco', { nome })} className="m-0 flex list-none flex-col gap-1 p-0">
            {lettura.dati.map((m) => {
              const spuntato = cambiati[m.modulo_id] ?? m.spuntato;
              return (
                <li key={m.modulo_id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 py-1 font-maven text-sm text-kidville-green">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 rounded accent-kidville-green"
                      checked={spuntato}
                      disabled={occupato !== null}
                      onChange={(e) => cambia(m, lettura.dati, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block break-words">{m.titolo}</span>
                      {m.firmato_in_app_il && (
                        <span className="block text-xs text-kidville-sub">
                          {t('firmatoInApp', { data: giorno(m.firmato_in_app_il) })}. {t('firmatoInAppNota')}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )
      )}
    </div>
  );
}
