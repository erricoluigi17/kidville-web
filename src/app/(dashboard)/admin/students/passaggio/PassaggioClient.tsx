'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { btnPrimary, hint, input, label } from '@/components/features/admin/settings/ui';
import { Tabs } from '@/components/ui/cockpit';
import { Modal } from '@/components/ui/Modal';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { useAnnoOpzionale } from '@/lib/context/anno-context';
import { useSediAttive } from '@/lib/context/sede-context';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

/**
 * IL PASSAGGIO D'ANNO (PR 4.8, compito 4.8.9). Una pagina, quattro stati che si leggono dall'alto:
 *  · NON ANCORA — l'anteprima c'è ma la data non è arrivata: «Il passaggio si può fare dal {data}», il pulsante di conferma è spento
 *    (la data è `apribile_dal` del SERVER; quella di oggi qui serve solo a spegnere il pulsante, la guardia vera è la route: 409);
 *  · ANTEPRIMA — contatori che filtrano l'elenco, bambini con classe di partenza e di arrivo, tendina per correggere la classe o far
 *    uscire, blocco «Da decidere» per le righe con un avviso aperto, docenti delle classi nuove da aggiungere o togliere;
 *  · CONFERMATO — riepilogo, «Annulla il passaggio» (finché il server lo ammette: il 409 si mostra con la sua frase) e, per chi è
 *    uscito, «Conferma tardiva»;
 *  · ANNULLATO — si può rifare l'anteprima.
 *
 * ─── COSE CHE NON SI TOCCANO ─────────────────────────────────────────────────
 *  · Le route danno SOLO uuid e stati. I nomi si compongono qui, dalle schede degli alunni, per la sola pagina in vista (e per le righe
 *    «Da decidere»): chi non è in vista non entra mai nello stato né nel DOM. Nessun nome e nessun uuid finisce nei log.
 *  · Qui non si decide niente: l'esito di ogni bambino lo calcola il database, la pagina riporta ciò che il server risponde.
 *  · La conferma è dietro un dialogo che dice cosa succede. Con righe da decidere il pulsante è spento.
 *  · L'esito di un'operazione sta in un posto solo sopra l'elenco, e resta leggibile finché non se ne fa un'altra.
 */

type EsitoRiga = 'continua' | 'cambia_grado' | 'nuova' | 'esce' | 'non_risposto';
type Avviso = 'ritirato_tendina' | 'senza_sezione';
type Filtro = 'tutti' | EsitoRiga;
type RigaApi = {
  alunno_id: string;
  esito: EsitoRiga;
  avviso: Avviso | null;
  eccezione: boolean;
  sezione_da_id: string | null;
  sezione_a_id: string | null;
  frequenza_a_id: string | null;
};
type DocenteApi = { utente_id: string; sezione_a_id: string; origine: 'copiata' | 'aggiunta' | 'tolta' };
type PassaggioApi = { id: string; stato: 'anteprima' | 'confermato' | 'annullato'; conteggi: Record<string, number>; apribile_dal: string | null; inizio_anno_nuovo?: string | null };
type Letta = { passaggio: PassaggioApi | null; righe: RigaApi[]; totale: number; docenti: DocenteApi[] };
type Sezione = { id: string; name: string; school_type: string; scuola_id?: string };
type Staff = { id: string; nome: string | null; cognome: string | null; ruolo?: string | null; scuola_id?: string | null };
type Nome = { nome: string; cognome: string };
type Contatori = { esiti: Record<EsitoRiga, number>; daDecidere: RigaApi[]; daDecidereTotale: number; quoteSuUsciti: number | null };
type Messaggio = { tipo: 'ok' | 'errore'; testo: string; codice: string | null };

type Risposta = { stato: number; corpo: unknown };
type Esito<T> = { ok: true; dati: T } | { ok: false; stato: number; corpo: unknown };
type Lettura<T> = { fase: 'carico' } | { fase: 'ok'; dati: T } | { fase: 'errore'; stato: number; corpo: unknown };

const ESITI: readonly EsitoRiga[] = ['continua', 'cambia_grado', 'nuova', 'esce', 'non_risposto'];
const AVVISI: readonly Avviso[] = ['ritirato_tendina', 'senza_sezione'];
/** Righe per pagina dell'elenco, e quante righe «Da decidere» si portano in vista per tipo di avviso. */
const PER_PAGINA = 25;
const RIGHE_DA_DECIDERE_MAX = 50;
const VALORE_ESCE = '__esce__';
const PERCORSO_CONFERME = '/admin/students/conferme';

/** Una chiamata. Non lancia mai: una rete caduta è `stato: 0`, e ogni esito non riuscito si registra (fisso, senza dati). */
async function chiama(metodo: 'GET' | 'POST' | 'PUT', url: string, userId: string, corpo?: Record<string, unknown>): Promise<Risposta> {
  const operazione = `admin/students/passaggio:${metodo}`;
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
/** Il carico utile: `{ data: … }` (la forma delle route admin) oppure il corpo stesso. */
const dati = (corpo: unknown): unknown => {
  const d = (corpo as { data?: unknown } | null)?.data;
  return d !== undefined ? d : corpo;
};
const eOggetto = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null && !Array.isArray(d);

const estraiLetta = (r: Risposta): Letta | null => {
  const d = dati(r.corpo);
  if (!eOggetto(d) || !Array.isArray(d.righe)) return null;
  const p = d.passaggio;
  return {
    passaggio: eOggetto(p) && typeof p.id === 'string' ? (p as unknown as PassaggioApi) : null,
    righe: d.righe as RigaApi[],
    totale: typeof d.totale === 'number' ? d.totale : d.righe.length,
    docenti: Array.isArray(d.docenti) ? (d.docenti as DocenteApi[]) : [],
  };
};

/** Legge una volta per `chiave`; finché non arriva la risposta nuova resta in vista quella di prima. `chiave` nulla = non legge. */
function useLettura<T>(chiave: string | null, leggi: () => Promise<Esito<T>>): Lettura<T> {
  const [stato, setStato] = useState<{ chiave: string; lettura: Lettura<T> } | null>(null);
  useEffect(() => {
    if (chiave === null) return;
    let attivo = true;
    leggi().then((e) => {
      if (!attivo) return;
      setStato({ chiave, lettura: e.ok ? { fase: 'ok', dati: e.dati } : { fase: 'errore', stato: e.stato, corpo: e.corpo } });
    });
    return () => {
      attivo = false;
    };
  }, [chiave, leggi]);
  if (chiave === null) return { fase: 'carico' };
  if (stato && stato.chiave === chiave) return stato.lettura;
  if (stato && stato.lettura.fase === 'ok') return stato.lettura;
  return { fase: 'carico' };
}

function testoErrore(t: ReturnType<typeof useTranslations>, r: Risposta): string {
  if (r.stato === 0) return t('erroreRete');
  if (r.stato === 403) return t('errorePermesso');
  return messaggioDaCorpo(r.corpo, t('erroreGenerico'));
}

/** «presenze: 12, foto e video: 3»: i conteggi di un annullo rifiutato, con il nome leggibile della tabella (se non lo conosce, il nome stesso). */
const TABELLE_USO = [
  'presenze', 'eventi_diario', 'valutazioni', 'note_disciplinari', 'registro_orario', 'giustifiche_didattiche', 'armadietto',
  'armadietto_richieste', 'mensa_prenotazioni', 'mensa_alternative', 'galleria_media_v2', 'video_intents', 'avvisi', 'forms_submissions',
  'form_submissions', 'chat_messages', 'student_documents', 'frequenze_dopo_la_conferma',
] as const;
function elencoUso(t: ReturnType<typeof useTranslations>, conteggi: unknown): string {
  if (!conteggi || typeof conteggi !== 'object') return '';
  return Object.entries(conteggi as Record<string, unknown>)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([tab, n]) => `${(TABELLE_USO as readonly string[]).includes(tab) ? t(`uso_${tab}` as never) : tab}: ${n as number}`)
    .join(', ');
}

const secondario =
  'inline-flex items-center gap-2 rounded-pill border-2 border-kidville-green px-4 py-2 font-barlow text-sm font-extrabold uppercase tracking-[0.05em] text-kidville-green transition-transform hover:bg-kidville-green-soft active:scale-95 disabled:pointer-events-none disabled:opacity-45';

export function PassaggioClient() {
  const t = useTranslations('annoPassaggio');
  const anno = useAnnoOpzionale();
  const effettivo = anno?.effettivo ?? null;
  if (!effettivo || !effettivo.annoSedeId) return <p className="font-maven text-sm text-kidville-sub">{t('nessunAnno')}</p>;
  // `key`: cambiato l'anno si riparte da zero (filtro, pagina, esito).
  return <Passaggio key={effettivo.annoSedeId} annoSedeId={effettivo.annoSedeId} puoCalcolare={!effettivo.attivo && effettivo.stato === 'iscrizioni_aperte'} />;
}

function Passaggio({ annoSedeId, puoCalcolare }: { annoSedeId: string; puoCalcolare: boolean }) {
  const t = useTranslations('annoPassaggio');
  const locale = useLocale();
  const { userId } = useAdminIdentity();
  const uid = userId ?? '';
  const base = `/api/admin/anni/${annoSedeId}/passaggio`;
  const { sedeCorrente } = useSediAttive();

  const [versione, setVersione] = useState(0);
  const [filtro, setFiltro] = useState<Filtro>('tutti');
  const [pagina, setPagina] = useState(1);
  const [messaggio, setMessaggio] = useState<Messaggio | null>(null);
  const [annullato, setAnnullato] = useState(false);
  const [dialogo, setDialogo] = useState<'conferma' | 'annulla' | null>(null);
  const [occupato, setOccupato] = useState(false);
  const rilegge = useCallback(() => setVersione((v) => v + 1), []);

  // ── le letture ────────────────────────────────────────────────────────────────────────────
  const leggiElenco = useCallback(async (): Promise<Esito<Letta>> => {
    const q = new URLSearchParams();
    if (filtro !== 'tutti') q.set('esito', filtro);
    q.set('pagina', String(pagina));
    q.set('tetto', String(PER_PAGINA));
    const r = await chiama('GET', `${base}?${q.toString()}`, uid);
    const d = riuscita(r) ? estraiLetta(r) : null;
    return d ? { ok: true, dati: d } : { ok: false, stato: r.stato, corpo: r.corpo };
  }, [base, uid, filtro, pagina]);
  const elenco = useLettura(`${base}|${filtro}|${pagina}|${versione}`, leggiElenco);

  const passaggioId = elenco.fase === 'ok' ? (elenco.dati.passaggio?.id ?? null) : null;
  // I contatori e il blocco «Da decidere» si leggono dal server con richieste piccole (un solo bambino per esito, una manciata di
  // righe per avviso): così i numeri sono sempre quelli del database e non dipendono da come l'anteprima ha scritto i conteggi.
  const leggiContatori = useCallback(async (): Promise<Esito<Contatori>> => {
    const r = await chiama('GET', `${base}?pagina=1&tetto=1&contatori=${RIGHE_DA_DECIDERE_MAX}`, uid);
    const c = riuscita(r) ? (dati(r.corpo) as { contatori?: { esiti?: Record<string, number>; avvisi?: Record<string, number>; daDecidere?: RigaApi[]; quoteSuUsciti?: number | null } } | null)?.contatori : null;
    if (!c || !c.esiti || !c.avvisi) return { ok: false, stato: r.stato, corpo: r.corpo };
    const esiti = {} as Record<EsitoRiga, number>;
    ESITI.forEach((e) => {
      esiti[e] = c.esiti?.[e] ?? 0;
    });
    const daDecidereTotale = AVVISI.reduce((somma, a) => somma + (c.avvisi?.[a] ?? 0), 0);
    return { ok: true, dati: { esiti, daDecidere: Array.isArray(c.daDecidere) ? c.daDecidere : [], daDecidereTotale, quoteSuUsciti: typeof c.quoteSuUsciti === 'number' ? c.quoteSuUsciti : null } };
  }, [base, uid]);
  const contatori = useLettura(passaggioId ? `${base}|c|${versione}` : null, leggiContatori);

  const leggiSezioni = useCallback(async (): Promise<Esito<Sezione[]>> => {
    const r = await chiama('GET', '/api/admin/sections/scoped', uid);
    const gruppi = dati(r.corpo);
    if (!riuscita(r) || !Array.isArray(gruppi)) return { ok: false, stato: r.stato, corpo: r.corpo };
    const tutte = (gruppi as Array<{ scuolaId?: string; sezioni?: Sezione[] }>).flatMap((g) =>
      Array.isArray(g.sezioni) ? g.sezioni.map((x) => ({ ...x, scuola_id: g.scuolaId })) : [],
    );
    return { ok: true, dati: tutte };
  }, [uid]);
  const sezioniLette = useLettura('sezioni', leggiSezioni);
  const sezioni = useMemo(
    () => (sezioniLette.fase === 'ok' ? sezioniLette.dati.filter((s) => !sedeCorrente || !s.scuola_id || s.scuola_id === sedeCorrente) : []),
    [sezioniLette, sedeCorrente],
  );
  const nomeSezione = useCallback((id: string | null): string | null => sezioni.find((s) => s.id === id)?.name ?? null, [sezioni]);

  const leggiStaff = useCallback(async (): Promise<Esito<Staff[]>> => {
    const r = await chiama('GET', '/api/admin/staff', uid);
    const d = dati(r.corpo);
    return riuscita(r) && Array.isArray(d) ? { ok: true, dati: d as Staff[] } : { ok: false, stato: r.stato, corpo: r.corpo };
  }, [uid]);
  const staffLetto = useLettura(passaggioId ? 'staff' : null, leggiStaff);
  // (giro 1, B5) Nella tendina solo il personale della sede dell'anno, non i genitori né i colleghi delle altre sedi: la route lo rifiuta comunque.
  const staff = useMemo(
    () => (staffLetto.fase === 'ok' ? staffLetto.dati.filter((x) => x.ruolo !== 'genitore' && (!sedeCorrente || !x.scuola_id || x.scuola_id === sedeCorrente)) : []),
    [staffLetto, sedeCorrente],
  );

  // I NOMI: solo dei bambini di cui la pagina mostra una riga. Le route danno uuid; qui si cercano nelle schede (prima chi frequenta,
  // poi chi arriva, poi chi non è più iscritto) e di tutto l'elenco si tiene soltanto ciò che serve a queste righe.
  const daDecidere = useMemo(() => (contatori.fase === 'ok' ? contatori.dati.daDecidere : []), [contatori]);
  const idInVista = useMemo(() => {
    const righe = elenco.fase === 'ok' ? elenco.dati.righe : [];
    return Array.from(new Set([...righe.map((r) => r.alunno_id), ...daDecidere.map((r) => r.alunno_id)])).sort();
  }, [elenco, daDecidere]);
  const chiaveNomi = idInVista.join(',');
  const leggiNomi = useCallback(async (): Promise<Esito<Record<string, Nome>>> => {
    const cercati = chiaveNomi ? chiaveNomi.split(',') : [];
    const trovati: Record<string, Nome> = {};
    // (giro 1, S20; giro 2, N7) Solo nome e cognome, dei soli bambini di queste righe: a blocchi di 100.
    for (let da = 0; da < cercati.length; da += 100) {
      const blocco = cercati.slice(da, da + 100);
      const r = await chiama('GET', `/api/admin/anni/${annoSedeId}/passaggio/nomi?ids=${blocco.join(',')}`, uid);
      const lista = dati(r.corpo);
      if (!riuscita(r) || !Array.isArray(lista)) continue;
      for (const a of lista as Array<{ id: string; nome?: string | null; cognome?: string | null }>) {
        trovati[a.id] = { nome: a.nome ?? '', cognome: a.cognome ?? '' };
      }
    }
    return { ok: true, dati: trovati };
  }, [base, chiaveNomi, uid]);
  const nomiLetti = useLettura(chiaveNomi ? `nomi|${chiaveNomi}` : null, leggiNomi);
  const nomi = nomiLetti.fase === 'ok' ? nomiLetti.dati : {};
  const nomeDi = (id: string): string => {
    const n = nomi[id];
    return (n ? `${n.cognome} ${n.nome}`.trim() : '') || t('bambinoSenzaNome');
  };

  // ── le scritture ──────────────────────────────────────────────────────────────────────────
  const scrivi = async (
    metodo: 'POST' | 'PUT',
    percorso: string,
    corpo: Record<string, unknown>,
    ok: string | ((dati: unknown) => string),
    dopo?: () => void,
  ): Promise<boolean> => {
    setOccupato(true);
    // Gli indirizzi stanno scritti per intero: il lock `anno-route-con-chiamante` cerca la route nel testo di chi la chiama.
    const indirizzi: Record<string, string> = {
      '': `/api/admin/anni/${annoSedeId}/passaggio`,
      '/righe': `/api/admin/anni/${annoSedeId}/passaggio/righe`,
      '/docenti': `/api/admin/anni/${annoSedeId}/passaggio/docenti`,
      '/conferma': `/api/admin/anni/${annoSedeId}/passaggio/conferma`,
      '/annulla': `/api/admin/anni/${annoSedeId}/passaggio/annulla`,
      '/conferma-tardiva': `/api/admin/anni/${annoSedeId}/passaggio/conferma-tardiva`,
    };
    const r = await chiama(metodo, indirizzi[percorso] ?? `${base}${percorso}`, uid, corpo);
    setOccupato(false);
    if (!riuscita(r)) {
      const c = (r.corpo as { codice?: unknown } | null)?.codice;
      // (giro 1, S7) L'annullo rifiutato dice anche COSA c'è nell'anno nuovo: i conteggi per tabella, con un nome leggibile.
      const uso = c === 'PASSAGGIO_NON_ANNULLABILE' ? elencoUso(t, (r.corpo as { conteggi?: unknown } | null)?.conteggi) : '';
      setMessaggio({ tipo: 'errore', testo: uso ? `${testoErrore(t, r)} ${t('annulloMotivi', { elenco: uso })}` : testoErrore(t, r), codice: typeof c === 'string' ? c : null });
      return false;
    }
    setMessaggio({ tipo: 'ok', testo: typeof ok === 'function' ? ok(dati(r.corpo)) : ok, codice: null });
    dopo?.();
    rilegge();
    return true;
  };

  const calcola = () =>
    scrivi('POST', '', { azione: 'anteprima' }, t('esitoAnteprimaFatta'), () => {
      setAnnullato(false);
      setFiltro('tutti');
      setPagina(1);
    });

  const corregge = (r: RigaApi, valore: string) => {
    if (!passaggioId || valore === '') return;
    const corpo: Record<string, unknown> =
      valore === VALORE_ESCE
        ? { alunno_id: r.alunno_id, esito: 'esce' }
        : { alunno_id: r.alunno_id, esito: r.esito === 'esce' ? 'continua' : r.esito, section_id: valore };
    return scrivi('PUT', '/righe', corpo, t('esitoCorretto', { nome: nomeDi(r.alunno_id) }));
  };

  const impostaDocente = (utenteId: string, sezioneId: string, origine: 'aggiunta' | 'tolta') =>
    passaggioId ? scrivi('PUT', '/docenti', { utente_id: utenteId, section_id: sezioneId, origine }, (d) =>
      origine === 'tolta' && (d as { resta_assegnato?: boolean } | null)?.resta_assegnato ? t('esitoDocenteRestaAssegnato') : t('esitoDocente')) : undefined;

  const conferma = async () => {
    setDialogo(null);
    if (passaggioId) await scrivi('POST', '/conferma', {}, t('esitoConfermato'));
  };
  const annulla = async () => {
    setDialogo(null);
    if (passaggioId) await scrivi('POST', '/annulla', {}, t('esitoAnnullato'), () => setAnnullato(true));
  };
  const scarta = async () => {
    setDialogo(null);
    if (passaggioId) await scrivi('POST', '/annulla', {}, t('esitoScartata'), () => setAnnullato(true));
  };
  const tardiva = (r: RigaApi, sezioneId: string) =>
    passaggioId
      ? scrivi(
          'POST',
          '/conferma-tardiva',
          { alunno_id: r.alunno_id, ...(sezioneId ? { section_id: sezioneId } : {}) },
          t('esitoTardiva', { nome: nomeDi(r.alunno_id) }),
        )
      : undefined;

  const giornoPrima = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : new Date(d.getTime() - 86_400_000).toISOString().slice(0, 10);
  };
  const giorno = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
  };

  // ── il disegno ────────────────────────────────────────────────────────────────────────────
  if (elenco.fase === 'carico') return <p role="status" className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>;
  if (elenco.fase === 'errore') {
    return (
      <div>
        <p role="alert" className="font-maven text-sm text-kidville-error">{testoErrore(t, { stato: elenco.stato, corpo: elenco.corpo })}</p>
        <button type="button" className={`${secondario} mt-3`} onClick={rilegge}>{t('riprova')}</button>
      </div>
    );
  }

  const { passaggio, righe, totale, docenti } = elenco.dati;
  const esitoMessaggio = messaggio && (
    <div
      role={messaggio.tipo === 'errore' ? 'alert' : 'status'}
      aria-label={t('esitoRegione')}
      className={`mt-3 rounded-input border border-kidville-line px-3 py-2 font-maven text-sm ${messaggio.tipo === 'errore' ? 'text-kidville-error' : 'text-kidville-success'}`}
    >
      <p className="m-0">{messaggio.testo}</p>
      {messaggio.codice === 'ANTEPRIMA_VECCHIA' && (
        <button type="button" className={`${secondario} mt-2`} disabled={occupato} onClick={calcola}>{t('azioneRicalcola')}</button>
      )}
    </div>
  );

  // Nessun passaggio vivo: mai calcolato, oppure annullato.
  if (!passaggio) {
    return (
      <div>
        <p className="font-maven text-sm text-kidville-green">{annullato ? t('statoAnnullato') : t('nessunaAnteprima')}</p>
        {/* (giro 1, S17) Il passaggio si calcola sull'anno con le iscrizioni aperte: dall'anno in corso si rimanda al selettore. */}
        {puoCalcolare || annullato ? (
          <button type="button" className={`${btnPrimary} mt-3`} disabled={occupato} onClick={calcola}>{t('azioneCalcola')}</button>
        ) : (
          <p className={hint}>{t('rimandoSelettore')}</p>
        )}
        {esitoMessaggio}
      </div>
    );
  }

  const inAnteprima = passaggio.stato === 'anteprima';
  const confermato = passaggio.stato === 'confermato';
  const esiti = contatori.fase === 'ok' ? contatori.dati.esiti : null;
  const numeroDaDecidere = contatori.fase === 'ok' ? contatori.dati.daDecidereTotale : 0;
  const tuttiContati = esiti ? ESITI.reduce((somma, e) => somma + esiti[e], 0) : undefined;
  // La data di OGGI serve solo a spegnere il pulsante; la guardia vera è del server (409 PASSAGGIO_TROPPO_PRESTO).
  const nonAncora = !!passaggio.apribile_dal && oggiFiscaleISO() < passaggio.apribile_dal;
  // (giro 2, N4) Se il nuovo anno è già cominciato non si citano date già passate; (S5) le quote ancora da pagare su chi esce.
  const annoGiaCominciato = !!passaggio.inizio_anno_nuovo && oggiFiscaleISO() >= passaggio.inizio_anno_nuovo;
  const quoteSuUsciti = contatori.fase === 'ok' ? contatori.dati.quoteSuUsciti : null;
  const confermaSpenta = occupato || nonAncora || contatori.fase !== 'ok' || numeroDaDecidere > 0;
  const pagine = Math.max(1, Math.ceil(totale / PER_PAGINA));

  const opzioniFiltro: Array<{ id: Filtro; label: string; count?: number }> = [
    { id: 'tutti', label: t('contTutti'), count: tuttiContati },
    { id: 'continua', label: t('contContinua'), count: esiti?.continua },
    { id: 'cambia_grado', label: t('contCambiaGrado'), count: esiti?.cambia_grado },
    { id: 'nuova', label: t('contNuova'), count: esiti?.nuova },
    { id: 'esce', label: t('contEsce'), count: esiti?.esce },
    { id: 'non_risposto', label: t('contNonRisposto'), count: esiti?.non_risposto },
  ];

  return (
    <div>
      <p className="font-barlow text-sm font-extrabold uppercase tracking-[0.05em] text-kidville-green">
        {confermato ? t('statoConfermato') : t('statoAnteprima')}
      </p>
      {inAnteprima && nonAncora && passaggio.apribile_dal && (
        <p role="status" className="mt-2 rounded-input border border-kidville-line bg-kidville-yellow-soft px-3 py-2 font-maven text-sm text-kidville-ink">
          {t('nonAncora', { data: giorno(passaggio.apribile_dal) })} {t('nonAncoraNota')}
        </p>
      )}

      {confermato && (
        <section aria-label={t('riepilogoTitolo')} className="mt-3 rounded-input border border-kidville-line p-3">
          <h2 className="m-0 font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('riepilogoTitolo')}</h2>
          <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 font-maven text-sm text-kidville-green">
            <li>{t('riepilogoContinuano', { n: passaggio.conteggi.continuano ?? 0 })}</li>
            <li>{t('riepilogoNuovi', { n: passaggio.conteggi.nuovi ?? 0 })}</li>
            <li>{t('riepilogoUsciti', { n: passaggio.conteggi.usciti ?? 0 })}</li>
            <li>{t('riepilogoCambiaGrado', { n: passaggio.conteggi.cambia_grado ?? 0 })}</li>
            <li>{t('riepilogoDocenti', { n: passaggio.conteggi.docenti_copiati ?? 0 })}</li>
            {quoteSuUsciti !== null && quoteSuUsciti > 0 && <li>{t('quoteSuUsciti', { n: quoteSuUsciti })}</li>}
          </ul>
          <button type="button" className={`${secondario} mt-3`} disabled={occupato} onClick={() => setDialogo('annulla')}>{t('azioneAnnulla')}</button>
        </section>
      )}

      {esitoMessaggio}

      {inAnteprima && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className={btnPrimary} disabled={confermaSpenta} aria-describedby={numeroDaDecidere > 0 ? 'passaggio-spenta' : undefined} onClick={() => setDialogo('conferma')}>
            {t('azioneConferma')}
          </button>
          <button type="button" className={secondario} disabled={occupato} onClick={calcola}>{t('azioneRicalcola')}</button>
          <button type="button" className={secondario} disabled={occupato} onClick={scarta}>{t('azioneScarta')}</button>
          <button type="button" className={secondario} onClick={rilegge}>{t('azioneAggiorna')}</button>
          {numeroDaDecidere > 0 && <span id="passaggio-spenta" className={hint}>{t('azioneConfermaSpentaDecidere')}</span>}
        </div>
      )}

      {inAnteprima && (
        <BloccoDaDecidere
          t={t}
          righe={daDecidere}
          numero={numeroDaDecidere}
          caricato={contatori.fase === 'ok'}
          nomeDi={nomeDi}
          nomeSezione={nomeSezione}
          sezioni={sezioni}
          occupato={occupato}
          corregge={corregge}
        />
      )}

      <div role="group" aria-label={t('contatoriEtichetta')} className="mt-4">
        <Tabs
          value={filtro}
          onChange={(v) => {
            setFiltro(v as Filtro);
            setPagina(1);
          }}
          options={opzioniFiltro}
        />
      </div>
      <p className={hint}>{t('totaleBambini', { totale })}</p>
      {inAnteprima && (
        <p className={hint}>
          {t('rimandoConfermeNota')}{' '}
          <Link href={PERCORSO_CONFERME} className="underline underline-offset-2">{t('rimandoConferme')}</Link>
        </p>
      )}

      {righe.length === 0 ? (
        <p className="mt-4 font-maven text-sm text-kidville-sub">{t('vuoto')}</p>
      ) : (
        <ul className="m-0 mt-3 list-none p-0">
          {righe.map((r) => (
            <RigaElenco
              key={r.alunno_id}
              t={t}
              r={r}
              nome={nomeDi(r.alunno_id)}
              classeDa={nomeSezione(r.sezione_da_id)}
              classeA={nomeSezione(r.sezione_a_id)}
              sezioni={sezioni}
              puoCorreggere={inAnteprima}
              puoTardiva={confermato && (r.esito === 'esce' || r.esito === 'non_risposto')}
              occupato={occupato}
              corregge={corregge}
              tardiva={tardiva}
            />
          ))}
        </ul>
      )}

      {pagine > 1 && (
        <nav className="mt-4 flex flex-wrap items-center gap-3" aria-label={t('paginaDi', { pagina, pagine })}>
          <button type="button" className={secondario} disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>{t('precedente')}</button>
          <span className="font-maven text-sm text-kidville-sub">{t('paginaDi', { pagina, pagine })}</span>
          <button type="button" className={secondario} disabled={pagina >= pagine} onClick={() => setPagina((p) => p + 1)}>{t('successiva')}</button>
        </nav>
      )}

      {inAnteprima && (
        <PannelloDocenti t={t} docenti={docenti} staff={staff} sezioni={sezioni} nomeSezione={nomeSezione} occupato={occupato} imposta={impostaDocente} />
      )}

      <Modal open={dialogo === 'conferma'} onClose={() => setDialogo(null)} title={t('dialogoConfermaTitolo')}>
        <div className="p-5 font-maven text-sm text-kidville-green">
          <h2 className="m-0 font-barlow text-base font-extrabold uppercase">{t('dialogoConfermaTitolo')}</h2>
          <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0">
            {(esiti?.non_risposto ?? 0) > 0 && <li>{t('dialogoNonRisposto', { n: esiti?.non_risposto ?? 0 })}</li>}
            {(esiti?.esce ?? 0) > 0 && <li>{t('dialogoEsce', { n: esiti?.esce ?? 0 })}</li>}
            {(esiti?.cambia_grado ?? 0) > 0 && <li>{t('dialogoCambiaGrado', { n: esiti?.cambia_grado ?? 0 })}</li>}
            {annoGiaCominciato ? (
              <li>{t('dialogoGiaCominciato')}</li>
            ) : passaggio.inizio_anno_nuovo ? (
              <li>{t('dialogoFinestra', { fino: giorno(giornoPrima(passaggio.inizio_anno_nuovo)), dal: giorno(passaggio.inizio_anno_nuovo) })}</li>
            ) : (
              <li>{t('dialogoFamiglie')}</li>
            )}
            {!annoGiaCominciato && ((esiti?.esce ?? 0) + (esiti?.non_risposto ?? 0)) > 0 && (
              <li>{t('dialogoAccessoSubito', { n: (esiti?.esce ?? 0) + (esiti?.non_risposto ?? 0) })}</li>
            )}
            {quoteSuUsciti !== null && quoteSuUsciti > 0 && <li>{t('quoteSuUsciti', { n: quoteSuUsciti })}</li>}
          </ul>
          <p className={hint}>{t('dialogoNota')}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={occupato} onClick={conferma}>{t('dialogoSi')}</button>
            <button type="button" className={secondario} onClick={() => setDialogo(null)}>{t('dialogoNo')}</button>
          </div>
        </div>
      </Modal>

      <Modal open={dialogo === 'annulla'} onClose={() => setDialogo(null)} title={t('dialogoAnnullaTitolo')}>
        <div className="p-5 font-maven text-sm text-kidville-green">
          <h2 className="m-0 font-barlow text-base font-extrabold uppercase">{t('dialogoAnnullaTitolo')}</h2>
          <p className="mt-3">{t('dialogoAnnullaCorpo')}</p>
          {annoGiaCominciato && passaggio.inizio_anno_nuovo && (
            <p className="mt-2">{t('dialogoAnnullaStorico', { dal: giorno(passaggio.inizio_anno_nuovo) })}</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={occupato} onClick={annulla}>{t('dialogoAnnullaSi')}</button>
            <button type="button" className={secondario} onClick={() => setDialogo(null)}>{t('dialogoNo')}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

function etichettaEsito(t: T, e: EsitoRiga): string {
  switch (e) {
    case 'continua': return t('esitoContinua');
    case 'cambia_grado': return t('esitoCambiaGrado');
    case 'nuova': return t('esitoNuova');
    case 'esce': return t('esitoEsce');
    default: return t('esitoNonRisposto');
  }
}

/** Una classe nuova si può correggere solo su chi continua, cambia grado o è nuovo; `esce` solo se non è «nuovo» (si ritira da «Conferme»). */
const correggibile = (r: RigaApi) => r.esito === 'continua' || r.esito === 'cambia_grado' || r.esito === 'nuova' || (r.esito === 'esce' && r.eccezione);

function RigaElenco({
  t, r, nome, classeDa, classeA, avviso, sezioni, puoCorreggere, puoTardiva, occupato, corregge, tardiva,
}: {
  t: T;
  r: RigaApi;
  avviso?: string;
  nome: string;
  classeDa: string | null;
  classeA: string | null;
  sezioni: Sezione[];
  puoCorreggere: boolean;
  puoTardiva: boolean;
  occupato: boolean;
  corregge: (r: RigaApi, valore: string) => unknown;
  tardiva: (r: RigaApi, sezioneId: string) => unknown;
}) {
  const id = useId();
  const [sezioneTardiva, setSezioneTardiva] = useState('');
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-b border-kidville-line py-3 font-maven text-sm text-kidville-green">
      <div className="min-w-0 flex-1 basis-56">
        <strong className="break-words">{nome}</strong>
        <span className="block text-xs text-kidville-sub">{etichettaEsito(t, r.esito)}{r.eccezione ? ` · ${t('deciso')}` : ''}</span>
        <span className="block text-xs text-kidville-sub">{t('classeDa', { classe: classeDa ?? t('senzaClasse') })}</span>
        <span className="block text-xs text-kidville-sub">{t('classeA', { classe: classeA ?? t('senzaClasse') })}</span>
        {avviso && <span className="block text-xs text-kidville-error">{avviso}</span>}
      </div>
      {puoCorreggere && correggibile(r) && (
        <div className="min-w-0 basis-56">
          <label className="sr-only" htmlFor={`${id}-sezione`}>{t('correggiEtichetta', { nome })}</label>
          <select
            id={`${id}-sezione`}
            className={`${input} min-h-11 w-full`}
            value={r.sezione_a_id ?? ''}
            disabled={occupato}
            onChange={(e) => corregge(r, e.target.value)}
          >
            <option value="">{r.esito === 'esce' ? t('correggiRiporta') : t('correggiScegli')}</option>
            {sezioni.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {r.esito !== 'nuova' && r.esito !== 'esce' && <option value={VALORE_ESCE}>{t('correggiEsce')}</option>}
          </select>
        </div>
      )}
      {puoCorreggere && r.avviso === 'ritirato_tendina' && r.sezione_a_id && (
        // (giro 1, S14) «Resta nella classe proposta» è un gesto: riselezionare la stessa opzione di una tendina non genera nessun evento.
        <div className="min-w-0 basis-56">
          <button type="button" className={secondario} disabled={occupato} onClick={() => corregge(r, r.sezione_a_id as string)}>
            {t('correggiContinuaQui')}
          </button>
        </div>
      )}
      {puoTardiva && (
        <div className="flex min-w-0 basis-56 flex-col gap-2">
          <label className="sr-only" htmlFor={`${id}-tardiva`}>{t('tardivaClasse', { nome })}</label>
          <select id={`${id}-tardiva`} className={`${input} min-h-11 w-full`} value={sezioneTardiva} onChange={(e) => setSezioneTardiva(e.target.value)}>
            <option value="">{t('tardivaClasseScegli')}</option>
            {sezioni.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <button type="button" className={secondario} disabled={occupato || sezioneTardiva === ''} onClick={() => tardiva(r, sezioneTardiva)}>{t('azioneTardiva')}</button>
        </div>
      )}
    </li>
  );
}

function BloccoDaDecidere({
  t, righe, numero, caricato, nomeDi, nomeSezione, sezioni, occupato, corregge,
}: {
  t: T;
  righe: RigaApi[];
  numero: number;
  caricato: boolean;
  nomeDi: (id: string) => string;
  nomeSezione: (id: string | null) => string | null;
  sezioni: Sezione[];
  occupato: boolean;
  corregge: (r: RigaApi, valore: string) => unknown;
}) {
  const titoloId = useId();
  return (
    <section aria-labelledby={titoloId} className="mt-4 rounded-input border border-kidville-line p-3">
      <h2 id={titoloId} className="m-0 font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('daDecidereTitolo', { n: numero })}</h2>
      {caricato && numero === 0 ? (
        <p className={hint}>{t('daDecidereVuoto')}</p>
      ) : (
        <>
          <p className={hint}>{t('daDecidereNota')}</p>
          <ul className="m-0 mt-2 list-none p-0">
            {righe.map((r) => (
              <RigaElenco
                key={r.alunno_id}
                t={t}
                r={r}
                nome={nomeDi(r.alunno_id)}
                classeDa={nomeSezione(r.sezione_da_id)}
                classeA={nomeSezione(r.sezione_a_id)}
                avviso={r.avviso === 'ritirato_tendina' ? t('avvisoRitiratoTendina') : t('avvisoSenzaSezione')}
                sezioni={sezioni}
                puoCorreggere
                puoTardiva={false}
                occupato={occupato}
                corregge={corregge}
                tardiva={() => undefined}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function PannelloDocenti({
  t, docenti, staff, sezioni, nomeSezione, occupato, imposta,
}: {
  t: T;
  docenti: DocenteApi[];
  staff: Staff[];
  sezioni: Sezione[];
  nomeSezione: (id: string | null) => string | null;
  occupato: boolean;
  imposta: (utenteId: string, sezioneId: string, origine: 'aggiunta' | 'tolta') => unknown;
}) {
  const id = useId();
  const [utente, setUtente] = useState('');
  const [sezione, setSezione] = useState('');
  const nomeStaff = (uid: string): string => {
    const s = staff.find((x) => x.id === uid);
    return (s ? `${s.cognome ?? ''} ${s.nome ?? ''}`.trim() : '') || t('docenteSenzaNome');
  };
  const origineTesto = (o: DocenteApi['origine']) => (o === 'copiata' ? t('docenteCopiata') : o === 'aggiunta' ? t('docenteAggiunta') : t('docenteTolta'));
  return (
    <section aria-labelledby={`${id}-titolo`} className="mt-6 rounded-input border border-kidville-line p-3">
      <h2 id={`${id}-titolo`} className="m-0 font-barlow text-sm font-extrabold uppercase text-kidville-green">{t('docentiTitolo')}</h2>
      <p className={hint}>{t('docentiNota')}</p>
      {docenti.length === 0 ? (
        <p className={hint}>{t('docentiVuoto')}</p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0">
          {docenti.map((d) => {
            const nome = nomeStaff(d.utente_id);
            const classe = nomeSezione(d.sezione_a_id) ?? t('senzaClasse');
            const tolta = d.origine === 'tolta';
            return (
              <li key={`${d.utente_id}-${d.sezione_a_id}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-kidville-line py-2 font-maven text-sm text-kidville-green">
                <span className="min-w-0 break-words">
                  <strong className={tolta ? 'line-through' : undefined}>{nome}</strong> · {classe} · <span className="text-xs text-kidville-sub">{origineTesto(d.origine)}</span>
                </span>
                <button
                  type="button"
                  className={secondario}
                  disabled={occupato}
                  onClick={() => imposta(d.utente_id, d.sezione_a_id, tolta ? 'aggiunta' : 'tolta')}
                >
                  {tolta ? t('docenteRipristina', { nome, classe }) : t('docenteToglie', { nome, classe })}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <h3 className="m-0 mt-4 font-barlow text-xs font-extrabold uppercase text-kidville-green">{t('docenteAggiungiTitolo')}</h3>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-0 basis-48">
          <label className={label} htmlFor={`${id}-utente`}>{t('docenteScegli')}</label>
          <select id={`${id}-utente`} className={`${input} min-h-11 w-full`} value={utente} onChange={(e) => setUtente(e.target.value)}>
            <option value="">{t('docenteScegli')}</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{`${s.cognome ?? ''} ${s.nome ?? ''}`.trim() || t('docenteSenzaNome')}</option>)}
          </select>
        </div>
        <div className="min-w-0 basis-48">
          <label className={label} htmlFor={`${id}-classe`}>{t('docenteClasseScegli')}</label>
          <select id={`${id}-classe`} className={`${input} min-h-11 w-full`} value={sezione} onChange={(e) => setSezione(e.target.value)}>
            <option value="">{t('docenteClasseScegli')}</option>
            {sezioni.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <button
          type="button"
          className={btnPrimary}
          disabled={occupato || !utente || !sezione}
          onClick={() => {
            imposta(utente, sezione, 'aggiunta');
            setUtente('');
            setSezione('');
          }}
        >
          {t('docenteAggiungi')}
        </button>
      </div>
    </section>
  );
}
