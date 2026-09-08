'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, X, Clock, LogIn, LogOut, Users, BarChart2 } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalAppello, syncPendingAppello } from '@/lib/offline/syncEngine';
import { DateField } from '@/components/ui/DateField';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { oraDiRomaAdesso } from '@/lib/presenze/orario';
import { OrarioCorreggibile, type CampoOrario } from '@/components/features/presenze/OrarioCorreggibile';
import { orariAmmessi } from '@/lib/presenze/orario-ammesso';
import { logClient, nomeErrore } from '@/lib/logging/client';

type Stato = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
interface Riga {
  id: string; nome: string; cognome: string; stato: Stato | null;
  orario_entrata: string | null; orario_uscita: string | null;
  presenza_id: string | null; giustificata: boolean;
  giustificazione_testo: string | null; giust_vista_il: string | null;
}
interface AlunnoLight { id: string; nome: string; cognome: string }
interface RiepilogoMateria { nome: string; minutiMancati: number; oreMancate: number }
interface RiepilogoAssenze {
  alunnoId: string; nome: string; cognome: string;
  oreAssenza: number; oreRitardo: number; orePermesso: number; oreTotali: number;
  perMateria?: Record<string, RiepilogoMateria>;
}

function annoScolasticoDefault(): { from: string; to: string } {
  // Il mese si legge da «oggi ITALIANO», non dai getter del dispositivo: a
  // cavallo del 31 agosto due utenti in due fusi diversi vedrebbero proposto un
  // anno scolastico diverso sulla stessa schermata.
  const [annoOggi, meseOggi] = oggiFiscaleISO().split('-').map(Number);
  const anno = meseOggi >= 9 ? annoOggi : annoOggi - 1;
  return { from: `${anno}-09-01`, to: `${anno + 1}-06-30` };
}

// HH:MM a Roma da un orario di presenza; '' se assente. Prima erano due copie di
// `getHours()` — l'ora del dispositivo — e su un tablet fuori fuso l'appello
// proponeva e mostrava un'ora che non era quella della scuola.
const oraCorrente = (): string => oraDiRomaAdesso();

// L'etichetta di stato è tradotta al render via t(`appelloStato_${key}`): l'array
// tiene solo la chiave (valore di stato lato API), l'icona e lo stile.
const STATI: { key: Stato; icon: React.ReactNode; cls: string }[] = [
  { key: 'presente', icon: <Check size={14} />, cls: 'bg-kidville-success text-white' },
  { key: 'assente', icon: <X size={14} />, cls: 'bg-kidville-error text-white' },
  { key: 'ritardo', icon: <Clock size={14} />, cls: 'bg-kidville-warn text-white' },
  { key: 'uscita_anticipata', icon: <LogOut size={14} />, cls: 'bg-kidville-info text-white' },
];

/**
 * «Oggi» nel fuso dell'istituto — la STESSA sorgente che usano le route chiamate
 * da questa pagina e il modulo del genitore.
 *
 * Qui c'era `new Date().toISOString().slice(0, 10)`, cioè UTC. Misurato dal
 * collaudo alle 01:2x italiane dell'8 agosto: il campo «Data dell'appello»
 * apriva sul **07/08/2026** mentre la pagina gemella dell'appello 0-6, nello
 * stesso istante e nello stesso browser, mostrava l'8. Le conseguenze erano due,
 * e la seconda è una SCRITTURA: (a) l'assenza comunicata dal genitore per oggi
 * non compariva nella schermata che la maestra apre — ed è la destinazione del
 * link della notifica «Assenza comunicata»; (b) segnando e salvando, l'appello
 * finiva sul giorno PRECEDENTE, sovrascrivendo righe già lavorate.
 * Lock: `__tests__/pages/teacher-appello-primaria-oggi.test.tsx`.
 */
function oggiIso() {
  return oggiFiscaleISO();
}

export default function AppelloPage() {
  const t = useTranslations('teacherPrimaria');
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [data, setData] = useState(oggiIso());
  const [righe, setRighe] = useState<Riga[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Il nome di chi ha subìto una rettifica non riuscita: un avviso che non nomina
  // nessuno, in una classe di venticinque righe, non dice a chi rifare il gesto.
  const [erroreOrario, setErroreOrario] = useState<string | null>(null);

  // Riepilogo ore assenze
  const defaultPeriodo = annoScolasticoDefault();
  const [alunniList, setAlunniList] = useState<AlunnoLight[]>([]);
  const [riepilogoAlunnoId, setRiepilogoAlunnoId] = useState('');
  const [riepilogoDal, setRiepilogoDal] = useState(defaultPeriodo.from);
  const [riepilogoAl, setRiepilogoAl] = useState(defaultPeriodo.to);
  const [riepilogo, setRiepilogo] = useState<RiepilogoAssenze | null>(null);
  const [riepilogoLoading, setRiepilogoLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/primaria/appello?sectionId=${sectionId}&data=${data}&userId=${userId}`);
      const d = await r.json();
      if (d.success) setRighe(d.data);
    } finally {
      setLoading(false);
    }
  }, [sectionId, data, userId]);

  // Carica lista alunni per il selettore riepilogo
  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setAlunniList(d.data.alunni ?? []); });
  }, [sectionId, userId]);

  const caricaRiepilogo = useCallback(async () => {
    if (!riepilogoAlunnoId) return;
    try {
      const r = await fetch(
        `/api/primaria/ore-assenza?sectionId=${sectionId}&alunnoId=${riepilogoAlunnoId}&from=${riepilogoDal}&to=${riepilogoAl}&includiMaterie=true&userId=${userId}`
      );
      const d = await r.json();
      if (d.success && d.data.length > 0) setRiepilogo(d.data[0]);
      else setRiepilogo(null);
    } finally {
      setRiepilogoLoading(false);
    }
  }, [sectionId, riepilogoAlunnoId, riepilogoDal, riepilogoAl, userId]);

  useEffect(() => { caricaRiepilogo(); }, [caricaRiepilogo]);

  useEffect(() => {
    load();
  }, [load]);

  // Flush della coda offline al ritorno della connessione.
  useEffect(() => {
    const flush = () => syncPendingAppello().then(load);
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [load]);

  // Invia (o riprova offline) lo stato di un alunno, con eventuali orari.
  const invia = async (alunnoId: string, stato: Stato, orarioEntrata?: string, orarioUscita?: string) => {
    // Senza identità risolta si accoda in locale come da offline (sync poi).
    if (!userId || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      await saveLocalAppello({ id: `${alunnoId}|${data}`, section_id: sectionId, alunno_id: alunnoId, data, stato, aggiornato_il: new Date().toISOString() });
      return;
    }
    try {
      const res = await fetch(`/api/primaria/appello?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ sectionId, data, alunnoId, stato, orarioEntrata, orarioUscita }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      await saveLocalAppello({ id: `${alunnoId}|${data}`, section_id: sectionId, alunno_id: alunnoId, data, stato, aggiornato_il: new Date().toISOString() });
    }
  };

  const setStato = async (alunnoId: string, stato: Stato) => {
    // Per ritardo/uscita anticipata propone l'ora corrente come default modificabile.
    const oraEntrata = stato === 'ritardo' ? oraCorrente() : '';
    const oraUscita = stato === 'uscita_anticipata' ? oraCorrente() : '';
    // In stato locale si tiene `HH:MM` NUDO, che `oraDiRoma` legge benissimo. Prima
    // qui si componeva `${data}T${ora}:00`: la forma ISO naïve, senza fuso — la stessa
    // stringa per le 08:45 di settembre e quelle di gennaio. Il formato canonico in
    // colonna lo scrive il SERVER, con `aOrarioIso`, che il fuso lo conosce.
    setRighe((prev) => prev.map((r) => (r.id === alunnoId
      ? { ...r, stato, orario_entrata: oraEntrata || null, orario_uscita: oraUscita || null }
      : r)));
    await invia(alunnoId, stato, oraEntrata || undefined, oraUscita || undefined);
  };

  /**
   * RETTIFICA di un orario già registrato — passa da `PATCH /api/attendance/daily`.
   *
   * Prima passava da `invia`, cioè dalla POST, cioè da un UPSERT DELLA RIGA INTERA che
   * non nominava `noteAppello`: correggere un'ora cancellava la nota che il docente
   * aveva scritto su quel giorno. In silenzio, e su un registro.
   *
   * La porta è quella dello 0-6 e non ne serviva una seconda: la tabella è la stessa
   * (`presenze`) e la sua chiave `(alunno_id, data)` non sa cosa sia un grado. La PATCH
   * tocca la SOLA colonna che il corpo nomina — è la differenza fra una patch e un
   * upsert — e l'istante lo compone il server con `aOrarioIso`, che sa il fuso.
   *
   * Ottimistico sul solo campo toccato, con rollback: se il server rifiuta, l'ora a
   * schermo torna quella di prima invece di raccontare una correzione mai avvenuta.
   */
  const setOrario = async (alunnoId: string, campo: CampoOrario, ora: string) => {
    if (!userId) return;
    const riga = righe.find((r) => r.id === alunnoId);
    if (!riga) return;
    const colonna = campo === 'entrata' ? 'orario_entrata' : 'orario_uscita';
    const precedente = riga[colonna] ?? null;

    // `HH:MM` nudo: `oraDiRoma` lo legge benissimo, e il formato canonico in colonna
    // lo scrive il server. Comporlo qui produrrebbe la forma naïve, senza fuso.
    setRighe((prev) => prev.map((r) => (r.id === alunnoId ? { ...r, [colonna]: ora } : r)));
    setErroreOrario(null);
    try {
      const res = await fetch(`/api/attendance/daily?userId=${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ alunno_id: alunnoId, data, [colonna]: ora }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch (err) {
      setRighe((prev) => prev.map((r) => (r.id === alunnoId ? { ...r, [colonna]: precedente } : r)));
      // Del guasto esce il codice: l'ora d'arrivo di un minore non entra nei log.
      logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-primaria-orario-non-salvato: ${nomeErrore(err)}`, route: '/teacher/primaria/appello' });
      setErroreOrario(`${riga.cognome} ${riga.nome}`);
    }
  };

  // Presa visione della giustifica inserita dal genitore.
  const presaVisione = async (presenzaId: string) => {
    if (!userId) return;
    await fetch(`/api/primaria/presenze/giust-vista?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ presenzaId }),
    });
    load();
  };

  const tuttiPresenti = async () => {
    if (!userId) return;
    setSaving(true);
    setRighe((prev) => prev.map((r) => ({ ...r, stato: 'presente', orario_entrata: null, orario_uscita: null })));
    await fetch(`/api/primaria/appello?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        sectionId,
        data,
        records: righe.map((r) => ({ alunnoId: r.id, stato: 'presente' })),
      }),
    });
    setSaving(false);
  };

  return (
    <div className="space-y-4">
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink">{t('appelloTitolo')}</h2>
        <div className="flex items-center gap-2">
          <DateField
            value={data}
            onChange={setData}
            aria-label={t('appelloDataAria')}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
          />
          <button
            onClick={tuttiPresenti}
            disabled={saving || righe.length === 0}
            className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50"
          >
            <Users size={14} /> {t('appelloTuttiPresenti')}
          </button>
        </div>
      </div>

      {/* La rettifica è ottimistica: se il server rifiuta, l'ora torna quella di
            prima — e va DETTO, altrimenti la correzione sembra riuscita e non lo è.
            L'avviso nomina il bambino: in una classe di venticinque righe, «errore di
            salvataggio» non dice a chi rifare il gesto. */}
      {erroreOrario && (
        <p role="alert" className="kv-appello-avviso font-maven mb-2 rounded-xl bg-kidville-error-soft px-3 py-2 text-xs text-kidville-error-strong">
          {t('appelloOrarioNonSalvato', { nome: erroreOrario })}
        </p>
      )}

      {loading ? (
        <p className="font-maven text-kidville-muted text-sm">{t('comuneCaricamento')}</p>
      ) : (
        <ul className="divide-y divide-kidville-line">
          {righe.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="font-maven text-kidville-ink">{r.cognome} {r.nome}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {STATI.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setStato(r.id, s.key)}
                    title={t(`appelloStato_${s.key}`)}
                    className={`font-maven inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition ${
                      r.stato === s.key ? s.cls : 'bg-kidville-cream text-kidville-muted hover:bg-kidville-cream-dark'
                    }`}
                  >
                    {s.icon}
                    <span className="hidden sm:inline">{t(`appelloStato_${s.key}`)}</span>
                  </button>
                ))}
                {/* GLI ORARI — lo stesso chip correggibile dell'appello 0-6.
                    Prima qui c'era un `<input type="time">` nudo, mostrato per il solo
                    stato «ritardo» o «uscita anticipata», e UNO ALLA VOLTA: chi usciva
                    prima non poteva più vedere né toccare la propria ora d'ingresso,
                    benché fosse comunque entrato. Quali campi hanno senso lo dice
                    `orariAmmessi`, la stessa tabella di verità del 422 del server. */}
                {orariAmmessi(r.stato).entrata && (
                  <OrarioCorreggibile
                    campo="entrata"
                    valore={r.orario_entrata}
                    etichetta={t('appelloOrarioEntrata')}
                    icona={<LogIn size={12} />}
                    alunno={r.id}
                    nomeAlunno={`${r.nome} ${r.cognome}`}
                    ariaKey="orarioIngressoAria"
                    inCorso={false}
                    onSalva={(ora) => setOrario(r.id, 'entrata', ora)}
                  />
                )}
                {orariAmmessi(r.stato).uscita && (
                  <OrarioCorreggibile
                    campo="uscita"
                    valore={r.orario_uscita}
                    etichetta={t('appelloOrarioUscita')}
                    icona={<LogOut size={12} />}
                    alunno={r.id}
                    nomeAlunno={`${r.nome} ${r.cognome}`}
                    ariaKey="orarioUscitaAria"
                    inCorso={false}
                    onSalva={(ora) => setOrario(r.id, 'uscita', ora)}
                  />
                )}
                {/* Stato giustificazione genitore + presa visione del docente. */}
                {r.giustificata && (
                  r.giust_vista_il ? (
                    <span className="font-maven text-[11px] text-kidville-success" title={r.giustificazione_testo ?? undefined}>{t('appelloGiustVista')}</span>
                  ) : (
                    <button
                      onClick={() => r.presenza_id && presaVisione(r.presenza_id)}
                      title={r.giustificazione_testo ?? t('appelloGiustificataDalGenitore')}
                      className="font-maven rounded-pill bg-kidville-warn-soft px-2.5 py-1 text-[11px] text-kidville-warn"
                    >
                      {t('appelloGiustificataPresaVisione')}
                    </button>
                  )
                )}
              </div>
            </li>
          ))}
          {righe.length === 0 && <li className="py-3 font-maven text-kidville-muted text-sm">{t('appelloNessunAlunno')}</li>}
        </ul>
      )}
    </div>

    {/* ── Riepilogo ore assenze per materia ───────────────────────── */}
    <div className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1 flex items-center gap-2">
        <BarChart2 size={16} className="text-kidville-green" /> {t('appelloRiepilogoTitolo')}
      </h3>
      <p className="font-maven text-xs text-kidville-muted mb-3">{t('appelloRiepilogoSub')}</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
        <select
          value={riepilogoAlunnoId}
          onChange={(e) => setRiepilogoAlunnoId(e.target.value)}
          className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm"
        >
          <option value="">{t('comuneAlunnoPlaceholder')}</option>
          {alunniList.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
        </select>
        <DateField value={riepilogoDal} onChange={setRiepilogoDal} aria-label={t('appelloRiepilogoDalAria')}
          className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm" />
        <DateField value={riepilogoAl} onChange={setRiepilogoAl} aria-label={t('appelloRiepilogoAlAria')}
          className="font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm" />
      </div>

      {!riepilogoAlunnoId ? (
        <p className="font-maven text-sm text-kidville-muted">{t('comuneSelezionaAlunno')}</p>
      ) : riepilogoLoading ? (
        <p className="font-maven text-sm text-kidville-muted">{t('appelloCalcoloInCorso')}</p>
      ) : !riepilogo ? (
        <p className="font-maven text-sm text-kidville-muted">{t('appelloNessunaAssenza')}</p>
      ) : (
        <div className="space-y-3">
          {/* Totale */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: t('appelloOreAssenze'), val: riepilogo.oreAssenza },
              { label: t('appelloOreRitardi'), val: riepilogo.oreRitardo },
              { label: t('appelloOrePermessi'), val: riepilogo.orePermesso },
              { label: t('appelloTotaleOre'), val: riepilogo.oreTotali },
            ].map((s) => (
              <div key={s.label} className="rounded-card bg-kidville-green/5 border border-kidville-green/20 px-3 py-2 text-center">
                <p className="font-maven text-[10px] text-kidville-muted mb-0.5">{s.label}</p>
                <p className="font-barlow text-xl font-bold text-kidville-green">{s.val.toFixed(1)}h</p>
              </div>
            ))}
          </div>
          {/* Per materia */}
          {riepilogo.perMateria && Object.keys(riepilogo.perMateria).length > 0 && (
            <table className="w-full font-maven text-sm">
              <thead>
                <tr className="border-b border-kidville-line">
                  <th className="text-left py-1.5 text-xs font-semibold text-kidville-muted">{t('appelloMateria')}</th>
                  <th className="text-right py-1.5 text-xs font-semibold text-kidville-muted">{t('appelloOreMancate')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(riepilogo.perMateria)
                  .sort((a, b) => b[1].oreMancate - a[1].oreMancate)
                  .map(([id, m]) => (
                    <tr key={id} className="border-b border-kidville-line">
                      <td className="py-1.5 text-kidville-ink">{m.nome}</td>
                      <td className="py-1.5 text-right font-semibold text-kidville-green">{m.oreMancate.toFixed(1)}h</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
