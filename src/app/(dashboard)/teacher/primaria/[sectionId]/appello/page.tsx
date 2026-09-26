'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, X, Clock, LogIn, LogOut, Users, BarChart2, RotateCcw, EyeOff, ShieldCheck } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalAppello, syncPendingAppello } from '@/lib/offline/syncEngine';
import { ritiraCambioAppelloInCoda, rimettiCambioAppelloInCoda } from '@/lib/offline/coda-appello-primaria';
import { DateField } from '@/components/ui/DateField';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { oraDiRoma, oraDiRomaAdesso } from '@/lib/presenze/orario';
import { OrarioCorreggibile, type CampoOrario } from '@/components/features/presenze/OrarioCorreggibile';
import {
  FinestraOrarioAppello,
  type StatoConOrario,
  type ValoriFinestraOrario,
} from '@/components/features/primaria/FinestraOrarioAppello';
import { orariAmmessi } from '@/lib/presenze/orario-ammesso';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { erroreDaRisposta } from '@/lib/ui/esito-fetch';

type Stato = 'presente' | 'assente' | 'ritardo' | 'uscita_anticipata';
interface Riga {
  id: string; nome: string; cognome: string; stato: Stato | null;
  orario_entrata: string | null; orario_uscita: string | null;
  presenza_id: string | null; giustificata: boolean;
  giustificazione_testo: string | null; giust_vista_il: string | null;
  /**
   * L'appello di questo alunno l'ha fatto qualcuno della scuola (`registrato_da` non
   * NULL sul server: la GET espone solo il booleano). È la condizione di «Annulla»:
   * una riga con la sola comunicazione del genitore ha uno stato («assente») ma
   * niente da annullare — il server risponderebbe sempre `NIENTE_DA_ANNULLARE`.
   * Stesso criterio di `appelloFatto` nell'appello 0-6.
   */
  appello_fatto: boolean;
  /**
   * Chi guarda può togliere la presa visione di questa riga (l'ha presa lui, oppure
   * è Segreteria o Direzione): lo decide la GET con la STESSA regola della DELETE
   * (`puoAnnullarePresaVisione`), ed espone solo il booleano, mai chi l'ha presa.
   * In primaria una classe ha più docenti: agli altri il comando finirebbe sempre
   * in `PRESA_VISIONE_NON_TUA`, quindi non si offre.
   */
  presa_visione_annullabile: boolean;
  /** La nota del docente sul giorno (`presenze.note_appello`): è il motivo del ritardo giustificato. */
  note_appello: string | null;
  /**
   * Ritardo / uscita anticipata GIUSTIFICATI (es. terapia): le ore non contano nelle ore
   * di assenza, ma lo stato resta quello vero. La GET lo dà sempre booleano (contratto A3).
   */
  assenza_oraria_giustificata: boolean;
}
/**
 * I campi facoltativi della POST oltre a stato e alunno. Ciò che resta `undefined` non
 * entra nel corpo, e il server lo conserva; `noteAppello: null` è il comando «togli la
 * nota». ⚠️ `assenzaOrariaGiustificata` assente vale `false` (contratto A3): chi tocca un
 * alunno con la giustificazione accesa e vuole tenerla deve RIMANDARLA — la finestra lo fa.
 */
interface CampiAppello {
  orarioEntrata?: string;
  orarioUscita?: string;
  noteAppello?: string | null;
  assenzaOrariaGiustificata?: boolean;
}
/** La finestra aperta: per chi, per quale stato, e da quali valori parte. */
interface FinestraAperta {
  alunnoId: string;
  nome: string;
  stato: StatoConOrario;
  iniziale: ValoriFinestraOrario;
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

/**
 * I rifiuti dell'annullamento dopo i quali la riga a schermo non è quella che il
 * server ha visto: si rilegge l'elenco invece di indovinare. Stesso insieme
 * dell'appello 0-6 (`AppelloGiornaliero`).
 */
const CODICI_DA_RILEGGERE = new Set([
  'PRESENZA_NON_TROVATA',
  'NIENTE_DA_ANNULLARE',
  'APPELLO_CAMBIATO_NEL_FRATTEMPO',
]);

/**
 * I rifiuti di «Annulla presa visione» dopo i quali la riga a schermo non dice più
 * il vero, e si rilegge l'elenco: presenza sparita (`…_PRESENZA_NON_TROVATA`),
 * presa visione già tolta (`…_ASSENTE`), tolta e rifatta dopo il caricamento della
 * pagina (`…_CAMBIATA`: il server confronta `vistaIl` con la riga), oppure il
 * permesso che la GET aveva concesso non vale più (`…_NON_TUA`: i ruoli sono
 * cambiati fra lettura e clic). In tutti i casi la GET rimette
 * `presa_visione_annullabile` al valore vero, e un comando che il server
 * rifiuterebbe sempre sparisce invece di restare offerto.
 */
const CODICI_PRESA_VISIONE_DA_RILEGGERE = new Set([
  'PRESA_VISIONE_PRESENZA_NON_TROVATA',
  'PRESA_VISIONE_ASSENTE',
  'PRESA_VISIONE_CAMBIATA',
  'PRESA_VISIONE_NON_TUA',
]);

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
  // Annullamento dell'appello: l'alunno in corso e l'esito da mostrare.
  const [annullaInCorso, setAnnullaInCorso] = useState<string | null>(null);
  const [avvisoAnnulla, setAvvisoAnnulla] = useState<{ tipo: 'ok' | 'errore'; testo: string } | null>(null);
  // «Annulla presa visione»: l'alunno la cui DELETE è in volo (l'esito va in `avvisoAnnulla`).
  const [presaVisioneInCorso, setPresaVisioneInCorso] = useState<string | null>(null);
  // Gli alunni il cui cambio di stato (POST singola, o salvataggio in coda) è
  // ancora in volo, con quanti ne hanno. Serve a fermare «Annulla» su QUELLA
  // riga: vedi `setStato`.
  const [salvataggioInCorso, setSalvataggioInCorso] = useState<ReadonlyMap<string, number>>(() => new Map());
  // La finestra di ritardo / uscita anticipata (A4): `null` = chiusa.
  const [finestra, setFinestra] = useState<FinestraAperta | null>(null);
  // Un salvataggio che il server ha RIFIUTATO nel merito (422): si dice a chi, e perché.
  const [erroreSalvataggio, setErroreSalvataggio] = useState<string | null>(null);

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

  // Invia (o riprova offline) lo stato di un alunno, con i campi della finestra.
  const invia = async (alunnoId: string, stato: Stato, campi: CampiAppello = {}) => {
    // La riga della coda porta GLI STESSI campi della POST: il flush li rispedisce con
    // `corpoPostAppelloDaCoda`. Senza, un ritardo giustificato salvato offline arriverebbe
    // al server senza flag — e il contratto A3 lo spegnerebbe. Solo i campi nominati:
    // un `undefined` qui resta «non nominato» anche dopo il viaggio in IndexedDB.
    const accoda = () => saveLocalAppello({
      id: `${alunnoId}|${data}`,
      section_id: sectionId,
      alunno_id: alunnoId,
      data,
      stato,
      ...(campi.orarioEntrata !== undefined ? { orario_entrata: campi.orarioEntrata } : {}),
      ...(campi.orarioUscita !== undefined ? { orario_uscita: campi.orarioUscita } : {}),
      ...(campi.noteAppello !== undefined ? { note_appello: campi.noteAppello } : {}),
      ...(campi.assenzaOrariaGiustificata !== undefined ? { assenza_oraria_giustificata: campi.assenzaOrariaGiustificata } : {}),
      aggiornato_il: new Date().toISOString(),
    });
    // Senza identità risolta si accoda in locale come da offline (sync poi).
    if (!userId || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      await accoda();
      return;
    }
    // Lo stato HTTP fuori dal `try`: il `catch` deve poter dire se il server ha risposto
    // (e con che cosa) o se la fetch non è mai arrivata — come fa `annulla`.
    let statoHttp: number | undefined;
    try {
      const res = await fetch(`/api/primaria/appello?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ sectionId, data, alunnoId, stato, ...campi }),
      });
      statoHttp = res.status;
      if (res.status === 422) {
        // Rifiuto NEL MERITO (giustificazione senza nota, o su uno stato che non la
        // ammette): rispedirlo dalla coda darebbe lo stesso 422 per sempre. Si dice a
        // schermo, a chi, e si rilegge la riga vera dal server — quella ottimistica
        // racconterebbe un salvataggio mai avvenuto.
        const esito = await erroreDaRisposta(res, '');
        const riga = righe.find((r) => r.id === alunnoId);
        const alunno = riga ? `${riga.cognome} ${riga.nome}` : '';
        setErroreSalvataggio(
          esito.codice === 'GIUSTIFICAZIONE_SENZA_NOTA'
            ? t('appelloNonSalvatoSenzaNota', { alunno })
            : esito.codice === 'GIUSTIFICAZIONE_STATO_NON_AMMESSO'
              ? t('appelloNonSalvatoStatoNonAmmesso', { alunno })
              : t('appelloNonSalvato', { alunno }),
        );
        // Del rifiuto esce il codice: la nota (spesso un motivo sanitario) non entra nei log.
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: 'appello-primaria-salvataggio-rifiutato',
          route: '/teacher/primaria/appello',
          stato: 422,
          campi: { error_code: esito.codice ?? 'senza-codice' },
        });
        try {
          await load();
        } catch (err) {
          logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-primaria-rilettura-dopo-rifiuto-fallita: ${nomeErrore(err)}`, route: '/teacher/primaria/appello' });
        }
        return;
      }
      if (!res.ok) throw new Error('save failed');
    } catch (err) {
      // Accodare senza dirlo farebbe sparire il motivo: un 400 sui campi della finestra,
      // un 403, un 500 o la rete finirebbero in coda muti, e il flush li scarterebbe muti.
      // `error` se la fetch non è partita o il server è guasto (>= 500: un dato su un minore
      // resta non scritto — stessa convenzione di `annulla` e `annullaPresaVisione`), `warn`
      // per un 4xx diverso da 422. Solo nome dell'errore e stato: né nota, né orario, né nome.
      logClient({
        livello: statoHttp === undefined || statoHttp >= 500 ? 'error' : 'warn',
        evento: 'fetch',
        messaggio: `appello-primaria-salvataggio-accodato: ${statoHttp === undefined ? nomeErrore(err) : 'risposta-non-ok'}`,
        route: '/teacher/primaria/appello',
        ...(statoHttp === undefined ? {} : { stato: statoHttp }),
      });
      await accoda();
    }
  };

  /**
   * Segna lo stato di un alunno. «Presente» e «Assente» arrivano qui dal tocco; «Ritardo»
   * e «Uscita anticipata» dalla finestra (`salvaFinestra`), con l'ora scelta, la spunta e
   * la nota in `dettagli`.
   */
  const setStato = async (alunnoId: string, stato: Stato, dettagli?: ValoriFinestraOrario) => {
    const giustificabile = stato === 'ritardo' || stato === 'uscita_anticipata';
    // L'ora della finestra; senza finestra (non dovrebbe capitare per questi due stati)
    // si propone l'ora corrente, come prima.
    const ora = giustificabile ? (dettagli?.ora ?? oraCorrente()) : undefined;
    const orarioEntrata = stato === 'ritardo' ? ora : undefined;
    const orarioUscita = stato === 'uscita_anticipata' ? ora : undefined;
    const giustificato = giustificabile && dettagli?.giustificato === true;
    // La finestra MOSTRA la nota del giorno e la rimanda com'è: vuota diventa `null`
    // («togli la nota»), che è ciò che il docente ha visto a schermo. Senza finestra la
    // nota non si nomina e il server la conserva.
    const nota = dettagli ? (dettagli.nota.trim() || null) : undefined;
    // In stato locale si tiene `HH:MM` NUDO, che `oraDiRoma` legge benissimo. Prima
    // qui si componeva `${data}T${ora}:00`: la forma ISO naïve, senza fuso — la stessa
    // stringa per le 08:45 di settembre e quelle di gennaio. Il formato canonico in
    // colonna lo scrive il SERVER, con `aOrarioIso`, che il fuso lo conosce.
    // L'orario che il corpo NON nomina resta quello che c'era: è ciò che fa il server
    // (un assente invece non ne ha nessuno, anche lì).
    // `appello_fatto: true`: la riga ora la scrive il docente (subito, o dalla coda
    // offline), quindi «Annulla» ha di nuovo qualcosa da togliere.
    setErroreSalvataggio(null);
    setRighe((prev) => prev.map((r) => (r.id === alunnoId
      ? {
        ...r,
        stato,
        orario_entrata: stato === 'assente' ? null : (orarioEntrata ?? r.orario_entrata),
        orario_uscita: stato === 'assente' ? null : (orarioUscita ?? r.orario_uscita),
        note_appello: nota === undefined ? r.note_appello : nota,
        assenza_oraria_giustificata: giustificato,
        appello_fatto: true,
      }
      : r)));
    // Finché questo salvataggio è in volo, «Annulla» di questa riga è fermo. La
    // riga qui sopra accende subito `appello_fatto`, quindi il bottone comparirebbe
    // cliccabile mentre la POST non è ancora arrivata. Le due corse possibili:
    //  · la POST arriva DOPO la DELETE → sul server resta lo stato appena segnato,
    //    mentre la schermata (svuotata dall'esito) dice «da registrare»;
    //  · la POST fallisce → `invia` accoda il cambio con `saveLocalAppello` DOPO che
    //    l'annullamento l'ha già ritirato dalla coda, e il primo flush riscrive
    //    l'appello annullato.
    // È lo stesso scopo di `loadingStudentId` nell'appello 0-6 (`isLoading` sulla
    // riga toglie anche «Annulla»). `finally`: una `invia` che lanciasse non deve
    // lasciare la riga bloccata fino al ricaricamento.
    // Un CONTATORE per alunno, non un insieme: con due tocchi rapidi sulla stessa
    // riga, la prima POST che finisce non deve riattivare «Annulla» mentre la
    // seconda è ancora in volo.
    setSalvataggioInCorso((prev) => new Map(prev).set(alunnoId, (prev.get(alunnoId) ?? 0) + 1));
    try {
      await invia(alunnoId, stato, {
        orarioEntrata,
        orarioUscita,
        noteAppello: nota,
        // Solo dove ha senso: su presente/assente il campo non si nomina (vale `false`).
        assenzaOrariaGiustificata: giustificabile ? giustificato : undefined,
      });
    } finally {
      setSalvataggioInCorso((prev) => {
        const next = new Map(prev);
        const resto = (next.get(alunnoId) ?? 1) - 1;
        if (resto > 0) next.set(alunnoId, resto);
        else next.delete(alunnoId);
        return next;
      });
    }
  };

  /**
   * «Ritardo» e «Uscita anticipata» aprono la finestra invece di salvare (A4).
   *
   * Se la riga è GIÀ in quello stato, la finestra riparte dai valori salvati (dalla GET):
   * l'ora registrata, la spunta, la nota. Altrimenti dall'ora di Roma di adesso e senza
   * spunta. La nota del giorno si mostra in entrambi i casi: la finestra la rimanda, e
   * rimandarla vuota senza averla fatta vedere la cancellerebbe.
   */
  const apriFinestra = (r: Riga, stato: StatoConOrario) => {
    const giaInStato = r.stato === stato;
    const salvata = oraDiRoma(stato === 'ritardo' ? r.orario_entrata : r.orario_uscita);
    setFinestra({
      alunnoId: r.id,
      nome: `${r.cognome} ${r.nome}`,
      stato,
      iniziale: {
        ora: giaInStato && salvata ? salvata : oraCorrente(),
        giustificato: giaInStato && r.assenza_oraria_giustificata === true,
        nota: r.note_appello ?? '',
      },
    });
  };

  const salvaFinestra = (valori: ValoriFinestraOrario) => {
    if (!finestra) return;
    const { alunnoId, stato } = finestra;
    setFinestra(null);
    void setStato(alunnoId, stato, valori);
  };

  /**
   * ── ANNULLA L'APPELLO DI UN ALUNNO ─────────────────────────────────────────
   *
   * Torna a «da registrare» (spec 2026-09-24, punto 6) con
   * `DELETE /api/primaria/appello`, la gemella dell'appello 0-6. Due esiti buoni:
   *  · `cancellata` — la riga non c'è più: l'alunno torna senza stato;
   *  · `ripristinata-comunicazione` — sotto l'appello c'era l'assenza comunicata
   *    dal genitore, e la riga torna a quella (assente, senza orari, giustifica
   *    e presa visione intatte).
   *
   * Solo OGGI (data di Roma): il bottone non compare sugli altri giorni, e il
   * server lo rifiuta comunque (`APPELLO_ANNULLA_SOLO_OGGI`).
   *
   * NESSUNA CODA OFFLINE (convenzioni di esecuzione della spec): senza rete non si
   * chiede nemmeno la conferma, si dice che serve la connessione. E niente
   * aggiornamento ottimistico: la riga cambia solo quando il server ha detto come.
   *
   * «Tutti presenti» resta com'è: ogni alunno si annulla da sé.
   */
  const annulla = async (alunnoId: string) => {
    if (!userId) return;
    const riga = righe.find((r) => r.id === alunnoId);
    const nome = riga ? `${riga.cognome} ${riga.nome}` : '';

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setAvvisoAnnulla({ tipo: 'errore', testo: t('appelloAnnullaServeConnessione') });
      return;
    }
    if (!window.confirm(t('appelloAnnullaConferma', { alunno: nome }))) return;

    setAvvisoAnnulla(null);
    // Il rifiuto di un salvataggio precedente non riguarda l'annullamento che parte ora.
    setErroreSalvataggio(null);
    setAnnullaInCorso(alunnoId);
    let statoHttp: number | undefined;
    // PRIMA si ritira dalla coda offline il cambio ancora in attesa per questo
    // alunno e questo giorno. Altrimenti, al primo evento `online`, la coda
    // rispedirebbe la sua POST e riscriverebbe l'appello appena annullato — in
    // silenzio, con uno stato vecchio. Vedi `ritiraCambioAppelloInCoda`.
    // Fuori dal `try`: l'helper non lancia, e il `catch` qui sotto deve poter
    // RIMETTERE in coda quello che si è ritirato.
    const ritiro = await ritiraCambioAppelloInCoda(alunnoId, data);
    const cambioRitirato = ritiro.esito === 'ritirato' ? ritiro.riga : null;
    // Se la DELETE non va a buon fine, il cambio ritirato torna in coda: lo stato a
    // schermo è quello segnato e non ancora spedito, e senza questo passo non
    // sarebbe più né sul server né in coda — la schermata fingerebbe uno stato che
    // non esiste da nessuna parte.
    const rimettiInCoda = async () => {
      if (cambioRitirato) await rimettiCambioAppelloInCoda(cambioRitirato);
    };
    // Diventa vero appena la risposta della DELETE è stata letta e il destino del
    // cambio ritirato è deciso: tolto per sempre (annullamento riuscito) o già
    // rimesso in coda (rifiuto). Da lì in poi il `catch` NON deve più rimetterlo in
    // coda: farlo dopo un annullamento riuscito farebbe riscrivere al primo flush
    // l'appello appena tolto — proprio ciò che il ritiro dalla coda impedisce.
    let codaDecisa = false;
    // La rilettura dell'elenco dopo un esito. `load` non ha un `catch` suo e rilancia
    // (GET che lancia, 502 HTML del gateway che non è JSON): qui NON deve arrivare al
    // `catch` dell'annullamento, perché l'annullamento è già avvenuto (o già
    // rifiutato) e l'avviso già detto. Si registra e basta: la riga resta quella
    // aggiornata dall'esito, e la prossima lettura la riallinea.
    const rileggi = async () => {
      try {
        await load();
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-primaria-rilettura-dopo-annullamento-fallita: ${nomeErrore(err)}`, route: '/teacher/primaria/appello' });
      }
    };

    const svuotaRiga = () => setRighe((prev) => prev.map((r) => (r.id === alunnoId
      ? {
        ...r,
        presenza_id: null,
        stato: null,
        orario_entrata: null,
        orario_uscita: null,
        giustificata: false,
        giustificazione_testo: null,
        giust_vista_il: null,
        appello_fatto: false,
        presa_visione_annullabile: false,
        // La riga non c'è più: con lei la nota del giorno e la giustificazione oraria.
        note_appello: null,
        assenza_oraria_giustificata: false,
      }
      : r)));

    // La riga torna alla sola assenza comunicata dal genitore: assente, senza
    // orari, `appello_fatto` falso. Si FONDE sulla riga: giustifica, motivo e
    // presa visione del GENITORE non viaggiano nella risposta e restano quelli già
    // letti. La nota del DOCENTE (`note_appello`) invece si azzera, come la azzera il
    // ripristino sul server (`annullaAppelloAlunno`): lasciarla a schermo la farebbe
    // riproporre dalla finestra di ritardo/uscita, e «Salva» riscriverebbe una nota —
    // spesso un dato sanitario — che l'annullamento aveva tolto.
    // Serve a due esiti che dicono la stessa cosa: il 2xx `ripristinata-comunicazione`
    // e il 409 NIENTE_DA_ANNULLARE dopo aver ritirato un cambio dalla coda (lì la nota
    // a schermo veniva dal cambio in coda, che il server non ha mai avuto).
    const tornaAllaComunicazione = (presenzaId?: string) => setRighe((prev) => prev.map((r) => (r.id === alunnoId
      ? {
        ...r,
        presenza_id: presenzaId ?? r.presenza_id,
        stato: 'assente',
        orario_entrata: null,
        orario_uscita: null,
        appello_fatto: false,
        note_appello: null,
        // Un assente non ha ritardo né uscita da giustificare (il trigger del DB lo spegne).
        assenza_oraria_giustificata: false,
      }
      : r)));

    try {
      const qs = new URLSearchParams({ sectionId, alunnoId, data, userId });
      const res = await fetch(`/api/primaria/appello?${qs.toString()}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      });
      statoHttp = res.status;
      const corpo = (await res.json().catch(() => null)) as {
        codice?: string;
        esito?: string;
        presenza?: { id?: string; stato?: string | null } | null;
      } | null;

      if (!res.ok) {
        const codice = typeof corpo?.codice === 'string' ? corpo.codice : '';

        // L'appello di quell'alunno stava SOLO nella coda: sul server non c'era
        // (404) o c'era solo la comunicazione del genitore (409 NIENTE_DA_ANNULLARE).
        // Ritirarlo dalla coda È l'annullamento, ed è riuscito: dirlo come errore —
        // o, peggio, rimettere il cambio in coda — riscriverebbe l'appello che il
        // docente ha appena chiesto di togliere. Si rilegge la riga dal server.
        if (cambioRitirato && (codice === 'PRESENZA_NON_TROVATA' || codice === 'NIENTE_DA_ANNULLARE')) {
          codaDecisa = true;
          if (codice === 'PRESENZA_NON_TROVATA') {
            svuotaRiga();
            setAvvisoAnnulla({ tipo: 'ok', testo: t('appelloAnnullaCancellata', { alunno: nome }) });
          } else {
            // La riga si aggiorna SUBITO, senza aspettare la rilettura: lo stato a
            // schermo era il cambio appena tolto dalla coda, che non esiste più da
            // nessuna parte. Se la rilettura fallisse (rete instabile: si arriva qui
            // proprio dopo una POST fallita), resterebbe a schermo un appello finto
            // accanto all'avviso verde — e un secondo «Annulla» darebbe un errore rosso.
            tornaAllaComunicazione();
            setAvvisoAnnulla({ tipo: 'ok', testo: t('appelloAnnullaRipristinata', { alunno: nome }) });
          }
          // `warn` (il client non ha `info`): non è un guasto, ma dice che un
          // appello era rimasto in coda senza mai arrivare al server.
          logClient({
            livello: 'warn',
            evento: 'offline',
            messaggio: 'appello-primaria-annullato-solo-in-coda',
            route: '/teacher/primaria/appello',
            stato: res.status,
            campi: { error_code: codice },
          });
          await rileggi();
          return;
        }

        await rimettiInCoda();
        codaDecisa = true;
        setAvvisoAnnulla({ tipo: 'errore', testo: messaggioAnnulla(codice) });
        if (codice === 'NIENTE_DA_ANNULLARE') {
          // C'è solo la comunicazione del genitore: niente da annullare. La
          // rilettura qui sotto lo conferma, ma il bottone sparisce subito.
          setRighe((prev) => prev.map((r) => (r.id === alunnoId ? { ...r, appello_fatto: false } : r)));
        }
        // Il server ha visto una riga diversa da quella a schermo: si rilegge.
        if (CODICI_DA_RILEGGERE.has(codice)) await rileggi();
        logClient({
          // Un rifiuto motivato (409/404) è una risposta, non un guasto.
          livello: res.status >= 500 ? 'error' : 'warn',
          evento: 'fetch',
          messaggio: 'appello-primaria-annullamento-rifiutato',
          route: '/teacher/primaria/appello',
          stato: res.status,
          // `error_code`: è la chiave in chiaro della redazione per i codici.
          campi: { error_code: codice || 'senza-codice' },
        });
        return;
      }

      // 2xx: l'annullamento è avvenuto sul server, il cambio ritirato resta fuori.
      codaDecisa = true;
      if (corpo?.esito === 'ripristinata-comunicazione') {
        // Sotto resta la sola comunicazione del genitore (vedi `tornaAllaComunicazione`).
        tornaAllaComunicazione(corpo.presenza?.id);
        setAvvisoAnnulla({ tipo: 'ok', testo: t('appelloAnnullaRipristinata', { alunno: nome }) });
      } else if (corpo?.esito === 'cancellata') {
        svuotaRiga();
        setAvvisoAnnulla({ tipo: 'ok', testo: t('appelloAnnullaCancellata', { alunno: nome }) });
      } else {
        // Un 200 con un esito che questa schermata non conosce: non si inventa lo
        // stato della riga, lo si rilegge — e l'anomalia si registra.
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: 'appello-primaria-annullamento-esito-sconosciuto',
          route: '/teacher/primaria/appello',
          stato: res.status,
          campi: { esito: typeof corpo?.esito === 'string' ? corpo.esito : 'assente' },
        });
        await rileggi();
      }
    } catch (err) {
      if (codaDecisa) {
        // L'esito del server c'era già, ed è stato applicato: quello che ha lanciato
        // viene DOPO (non la rete dell'annullamento). Né coda né avviso cambiano.
        logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-primaria-annullamento-dopo-esito: ${nomeErrore(err)}`, route: '/teacher/primaria/appello', stato: statoHttp });
        return;
      }
      // La `fetch` che LANCIA è la rete che non c'è (o che è caduta a metà):
      // l'annullamento non è avvenuto, il cambio ritirato torna in coda.
      await rimettiInCoda();
      logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-primaria-annullamento-fallito: ${nomeErrore(err)}`, route: '/teacher/primaria/appello', stato: statoHttp });
      setAvvisoAnnulla({ tipo: 'errore', testo: t('appelloAnnullaServeConnessione') });
    } finally {
      setAnnullaInCorso(null);
    }
  };

  const messaggioAnnulla = (codice: string): string => {
    switch (codice) {
      case 'APPELLO_ANNULLA_SOLO_OGGI': return t('appelloAnnullaSoloOggi');
      case 'PRESENZA_NON_TROVATA': return t('appelloAnnullaNonTrovato');
      case 'NIENTE_DA_ANNULLARE': return t('appelloAnnullaNienteDaAnnullare');
      case 'APPELLO_CAMBIATO_NEL_FRATTEMPO': return t('appelloAnnullaCambiato');
      default: return t('appelloAnnullaErrore');
    }
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

  /**
   * ── ANNULLA LA PRESA VISIONE DELLA GIUSTIFICA ──────────────────────────────
   *
   * Spec 2026-09-24, punto 2: `DELETE /api/primaria/presenze/giust-vista`. Toglie la
   * sola LETTURA del docente: la giustifica e il motivo del genitore restano, e la
   * riga torna a mostrare «Giustificata · presa visione» da rifare.
   *
   * Chi può farlo (chi l'ha presa, oppure Segreteria e Direzione) lo dice la GET
   * col booleano `presa_visione_annullabile`: il comando si offre solo a loro. Il
   * server lo verifica comunque. QUALE presa visione si toglie lo dice `vistaIl`:
   * il `giust_vista_il` della riga a schermo, quella che la persona ha confermato.
   * Se in tabella nel frattempo ce n'è un'altra (tolta e rifatta da un collega) il
   * server risponde 409 `PRESA_VISIONE_CAMBIATA` e non tocca niente.
   *
   * Ogni rifiuto si mostra tradotto dal catalogo; quelli dopo cui la riga non dice
   * più il vero (`CODICI_PRESA_VISIONE_DA_RILEGGERE`, compreso `…_NON_TUA` quando i
   * ruoli sono cambiati fra lettura e clic) rileggono l'elenco, così il comando
   * sparisce se il server non lo accetterebbe più.
   *
   * Nessun termine, nessuna coda offline: senza rete si dice che serve la
   * connessione. Niente aggiornamento ottimistico: la riga cambia solo col 2xx.
   */
  const annullaPresaVisione = async (alunnoId: string, presenzaId: string, vistaIl: string) => {
    if (!userId) return;
    const riga = righe.find((r) => r.id === alunnoId);
    const nome = riga ? `${riga.cognome} ${riga.nome}` : '';

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setAvvisoAnnulla({ tipo: 'errore', testo: t('appelloAnnullaPresaVisioneServeConnessione') });
      return;
    }
    if (!window.confirm(t('appelloAnnullaPresaVisioneConferma', { alunno: nome }))) return;

    setAvvisoAnnulla(null);
    setPresaVisioneInCorso(alunnoId);
    let rileggere = false;
    try {
      const qs = new URLSearchParams({ presenzaId, vistaIl, userId });
      const res = await fetch(`/api/primaria/presenze/giust-vista?${qs.toString()}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      });
      if (!res.ok) {
        const esito = await erroreDaRisposta(res, t('appelloAnnullaPresaVisioneErrore'));
        setAvvisoAnnulla({ tipo: 'errore', testo: esito.testo });
        // La riga a schermo non è quella che il server ha visto: si rilegge.
        rileggere = esito.codice !== null && CODICI_PRESA_VISIONE_DA_RILEGGERE.has(esito.codice);
        logClient({
          // Un rifiuto motivato (403/404/409) è una risposta, non un guasto.
          livello: (esito.stato ?? 500) >= 500 ? 'error' : 'warn',
          evento: 'fetch',
          messaggio: 'appello-primaria-presa-visione-non-annullata',
          route: '/teacher/primaria/appello',
          stato: esito.stato,
          campi: { error_code: esito.codice ?? 'senza-codice' },
        });
      } else {
        setRighe((prev) => prev.map((r) => (r.id === alunnoId ? { ...r, giust_vista_il: null, presa_visione_annullabile: false } : r)));
        setAvvisoAnnulla({ tipo: 'ok', testo: t('appelloAnnullaPresaVisioneFatto', { alunno: nome }) });
      }
    } catch (err) {
      // La `fetch` che LANCIA è la rete che non c'è: sul server non è cambiato niente.
      logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-primaria-presa-visione-annullamento-fallito: ${nomeErrore(err)}`, route: '/teacher/primaria/appello' });
      setAvvisoAnnulla({ tipo: 'errore', testo: t('appelloAnnullaPresaVisioneServeConnessione') });
    } finally {
      setPresaVisioneInCorso(null);
    }
    if (rileggere) {
      try {
        await load();
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-primaria-rilettura-dopo-presa-visione-fallita: ${nomeErrore(err)}`, route: '/teacher/primaria/appello' });
      }
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
    // `appello_fatto: true` su ogni riga: l'appello in blocco lo scrive il docente,
    // e ogni alunno si può di nuovo annullare singolarmente — anche quello che un
    // annullamento aveva appena riportato alla sola comunicazione del genitore.
    // `assenza_oraria_giustificata: false`: un presente non ha ore da giustificare, e la
    // POST in blocco non nomina il flag — che per contratto (A3) vale `false`. È l'unico
    // valore coerente: il server rifiuterebbe (422) un flag acceso su «presente». La nota
    // del giorno invece non si nomina, e il server la conserva.
    setErroreSalvataggio(null);
    setRighe((prev) => prev.map((r) => ({ ...r, stato: 'presente', orario_entrata: null, orario_uscita: null, appello_fatto: true, assenza_oraria_giustificata: false })));
    // `finally`: ora `saving` ferma anche ogni «Annulla»; se la POST lanciasse, un
    // `saving` rimasto acceso li bloccherebbe fino al ricaricamento della pagina.
    try {
      await fetch(`/api/primaria/appello?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({
          sectionId,
          data,
          records: righe.map((r) => ({ alunnoId: r.id, stato: 'presente' })),
        }),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink">{t('appelloTitolo')}</h2>
        <div className="flex items-center gap-2">
          <DateField
            value={data}
            // L'esito di un annullamento, un salvataggio rifiutato (422) e un orario
            // non salvato riguardano il giorno su cui sono avvenuti: sull'elenco di un
            // altro giorno direbbero il falso, e con `role=alert`.
            onChange={(v) => { setAvvisoAnnulla(null); setErroreSalvataggio(null); setErroreOrario(null); setData(v); }}
            // Fermo mentre una DELETE è in volo: cambiando giorno, `load()` porterebbe
            // le righe del giorno nuovo e l'esito in arrivo (`svuotaRiga`, o la fusione
            // di `ripristinata-comunicazione`), che cerca la riga per SOLO `alunnoId`,
            // la modificherebbe sul giorno sbagliato — «da registrare» su un giorno
            // che sul server non è cambiato, con l'avviso sul giorno nuovo.
            disabled={annullaInCorso !== null}
            aria-label={t('appelloDataAria')}
            className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
          />
          <button
            onClick={tuttiPresenti}
            // Ferma anche durante un annullamento: la POST in blocco, se arrivasse
            // dopo la DELETE, riscriverebbe «presente» sull'alunno appena annullato
            // mentre la schermata, svuotata dall'esito, direbbe «da registrare».
            disabled={saving || annullaInCorso !== null || righe.length === 0}
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

      {/* Un salvataggio rifiutato nel merito (422): la riga è già stata riletta dal
            server, e va detto a chi rifare il gesto e perché. */}
      {erroreSalvataggio && (
        <p role="alert" className="kv-appello-avviso font-maven mb-2 rounded-xl bg-kidville-error-soft px-3 py-2 text-xs text-kidville-error-strong">
          {erroreSalvataggio}
        </p>
      )}

      {/* L'esito dell'annullamento, riuscito o no: il bambino a schermo cambia
            riga (o non la cambia), e va detto perché. */}
      {avvisoAnnulla && (
        <p
          id="avviso-annulla-appello"
          role={avvisoAnnulla.tipo === 'errore' ? 'alert' : 'status'}
          className={`kv-appello-avviso font-maven mb-2 rounded-xl px-3 py-2 text-xs ${
            avvisoAnnulla.tipo === 'errore'
              ? 'bg-kidville-error-soft text-kidville-error-strong'
              : 'bg-kidville-success-soft text-kidville-success-strong'
          }`}
        >
          {avvisoAnnulla.testo}
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
                {/* Durante l'annullamento di QUESTO alunno la riga è ferma: uno stato
                      segnato adesso partirebbe come POST in parallelo alla DELETE, e se
                      arrivasse dopo il server avrebbe quello stato mentre la schermata,
                      svuotata dall'esito dell'annullamento, direbbe «da registrare».
                      Come nell'appello 0-6 (`isLoading` sulla riga). */}
                {/* «Ritardo» e «Uscita» aprono la finestra dell'ora (A4): `aria-haspopup`
                      lo annuncia prima del tocco. «Presente» e «Assente» salvano subito. */}
                {STATI.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => (s.key === 'ritardo' || s.key === 'uscita_anticipata'
                      ? apriFinestra(r, s.key)
                      : setStato(r.id, s.key))}
                    aria-haspopup={s.key === 'ritardo' || s.key === 'uscita_anticipata' ? 'dialog' : undefined}
                    disabled={annullaInCorso === r.id}
                    title={t(`appelloStato_${s.key}`)}
                    className={`font-maven inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition disabled:opacity-50 ${
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
                    inCorso={annullaInCorso === r.id}
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
                    inCorso={annullaInCorso === r.id}
                    onSalva={(ora) => setOrario(r.id, 'uscita', ora)}
                  />
                )}
                {/* RITARDO / USCITA GIUSTIFICATI (A4): le ore non contano nelle assenze, e
                      la riga lo dice insieme al motivo. La nota è troncata a schermo ma
                      intera nel `title` e per lo screen reader. */}
                {r.assenza_oraria_giustificata && (r.stato === 'ritardo' || r.stato === 'uscita_anticipata') && (
                  <span
                    title={r.note_appello ?? undefined}
                    className="font-maven inline-flex max-w-[16rem] items-center gap-1 rounded-pill bg-kidville-success-soft px-2.5 py-1 text-[11px] text-kidville-success-strong"
                  >
                    <ShieldCheck size={11} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">
                      {r.note_appello ? t('appelloGiustificatoConNota', { nota: r.note_appello }) : t('appelloGiustificato')}
                    </span>
                  </span>
                )}
                {/* ANNULLA — solo oggi (data di Roma) e solo dove l'appello l'ha fatto
                      la scuola (`appello_fatto`): su una riga con la sola comunicazione
                      del genitore il comando non potrebbe mai riuscire. Il server
                      rifiuta comunque ogni altro caso. */}
                {data === oggiIso() && r.appello_fatto && (
                  <button
                    id={`btn-annulla-appello-${r.id}`}
                    type="button"
                    onClick={() => annulla(r.id)}
                    // Fermo anche mentre «Tutti presenti» è in volo: stessa corsa vista
                    // dall'altro lato (DELETE prima, POST in blocco dopo). E fermo
                    // mentre il cambio di stato di QUESTO alunno è in volo: la stessa
                    // corsa sulla POST singola (vedi `setStato`).
                    disabled={annullaInCorso !== null || saving || salvataggioInCorso.has(r.id)}
                    aria-label={t('appelloAnnullaAria', { alunno: `${r.cognome} ${r.nome}` })}
                    className="font-maven inline-flex items-center gap-1 rounded-pill border border-kidville-line px-2.5 py-1 text-xs text-kidville-ink hover:bg-kidville-cream disabled:opacity-50"
                  >
                    <RotateCcw size={12} />
                    <span className="hidden sm:inline">{t('appelloAnnulla')}</span>
                  </button>
                )}
                {/* Stato giustificazione genitore + presa visione del docente. */}
                {r.giustificata && (
                  r.giust_vista_il ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-maven text-[11px] text-kidville-success" title={r.giustificazione_testo ?? undefined}>{t('appelloGiustVista')}</span>
                      {/* ANNULLA PRESA VISIONE — solo a chi il server lo lascerebbe fare
                            (`presa_visione_annullabile`: chi l'ha presa, Segreteria,
                            Direzione). Fermo mentre è in volo un annullamento, di questo
                            gesto o dell'appello. Icona `EyeOff`, non `RotateCcw`: su
                            telefono l'etichetta è nascosta, e due ↺ identiche sulla
                            stessa riga sarebbero due gesti diversi con la stessa faccia. */}
                      {r.presenza_id && r.presa_visione_annullabile && (
                        <button
                          id={`btn-annulla-presa-visione-${r.id}`}
                          type="button"
                          onClick={() => r.presenza_id && r.giust_vista_il && annullaPresaVisione(r.id, r.presenza_id, r.giust_vista_il)}
                          disabled={presaVisioneInCorso !== null || annullaInCorso === r.id}
                          aria-label={t('appelloAnnullaPresaVisioneAria', { alunno: `${r.cognome} ${r.nome}` })}
                          className="font-maven inline-flex items-center gap-1 rounded-pill border border-kidville-line px-2 py-0.5 text-[11px] text-kidville-ink hover:bg-kidville-cream disabled:opacity-50"
                        >
                          <EyeOff size={11} aria-hidden="true" />
                          <span className="hidden sm:inline">{t('appelloAnnullaPresaVisione')}</span>
                        </button>
                      )}
                    </span>
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

      {/* La `key` per alunno e stato: ogni apertura riparte dai valori iniziali. */}
      {finestra && (
        <FinestraOrarioAppello
          key={`${finestra.alunnoId}|${finestra.stato}`}
          stato={finestra.stato}
          nomeAlunno={finestra.nome}
          iniziale={finestra.iniziale}
          onSalva={salvaFinestra}
          onAnnulla={() => setFinestra(null)}
        />
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
