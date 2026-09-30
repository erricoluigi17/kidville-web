import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { RUOLI_DIREZIONE, profiloStaffRevocato } from '@/lib/auth/predicati-ruolo';
import { resolveScuoleAttive, restringiSedi } from '@/lib/auth/scope';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { parseQuery } from '@/lib/validation/http';
import { zUuid, zOpzionale, zLimite } from '@/lib/validation/common';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { schemaAssente } from '@/lib/news/schema-assente';
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi';
import { descriviTetto, leggiABlocchi, type EsitoABlocchi } from '@/lib/pagamenti/leggi-a-blocchi';
import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit';

/* ════════════════════════════════════════════════════════════════════════════
 * GET /api/admin/chat/docenti-senza-push — chi non riceve NIENTE, e quanto la
 * aspetta.
 *
 * ─── PERCHÉ (segnalazione del 2026-09-29) ───────────────────────────────────
 *
 * «I messaggi dei genitori non arrivano alle maestre». Fra le cause misurate: le
 * docenti che hanno negato il permesso delle notifiche non ricevono NESSUNA
 * push, e nessuno lo sa — né loro né la Direzione. Una maestra su Android ha
 * ricevuto 137 messaggi in 30 giorni senza una sola notifica.
 *
 * L'avviso nella home della docente (`AvvisoNotificheDocente`) chiude metà del
 * problema: lo dice a lei. Questa lettura chiude l'altra metà — lo dice alla
 * Direzione, che può andare a parlarle di persona. I due numeri accanto al nome
 * servono a stabilire da chi cominciare: una maestra con 137 messaggi in attesa
 * non è lo stesso caso di una che non ne ha ricevuto nessuno.
 *
 * ⚠️ NON MANDA NIENTE A NESSUNO. Il promemoria automatico alle maestre è stato
 * escluso dal titolare: questa è una lettura, e resta una lettura.
 *
 * ─── IL GATE È QUELLO DELLA DIREZIONE, non `requireStaff` predefinito ───────
 *
 * Come il registro di vigilanza (`admin/chat/vigilanza`), e per una ragione
 * vicina: l'elenco dice, nome per nome, chi in questa scuola non sta ricevendo
 * le notifiche e quanti messaggi ha in attesa. È una misura del lavoro di una
 * collega, e chi interviene è la Direzione. Aprirlo alla segreteria è una
 * decisione del titolare, non un adeguamento: finché non c'è, il gate è stretto.
 *
 * ─── CHI ENTRA NELL'ELENCO: le educator NON ARCHIVIATE delle sedi in scope ──
 *
 * `ruolo = 'educator'` + `archiviato_il IS NULL`. Due criteri, non tre, e la
 * differenza è stata misurata.
 *
 * ⚠️ NON si filtra su `utenti.attivo`, e la tentazione è forte. Quella
 * colonna è INERTE: `predicati-ruolo.ts:95-98` lo dice per esteso («nessun gate
 * la legge, e al 2026-09-20 porta 26 righe a `false` su account tutti vivi — fra
 * cui un amministratore e la Direzione»), e la migrazione
 * `20260920001032_docente_archiviato_e_cancella_fascicolo.sql:10-31` conta nove
 * docenti a `attivo = false` con accessi RECENTI. Una maestra viva, con le sue
 * conversazioni aperte e nessun dispositivo, sarebbe sparita dall'elenco per una
 * casella messa male anni prima: cioè esattamente il caso che questo elenco
 * esiste per far vedere.
 *
 * ⚠️ E NON è «la popolazione di chi un genitore può scrivere». `rubricaDiFamiglia`
 * decide chi compare in «Nuova chat» — la PORTA — e non tocca i thread GIÀ
 * aperti: `POST /api/chat/messages` non ricontrolla l'abbinamento, quindi un
 * genitore continua a scrivere in una conversazione esistente anche a una
 * docente che dalla rubrica è uscita. I messaggi arrivano, e le notifiche
 * servono. Quello che si legge qui è il personale docente non archiviato delle
 * sedi nel perimetro, e basta.
 *
 * Il filtro dell'ARCHIVIAZIONE invece resta, e non è simmetrico al primo:
 * archiviare una docente CANCELLA le sue `push_subscriptions`
 * (`admin/staff/eliminazione/route.ts:287-292`). Senza quel filtro ogni persona
 * archiviata comparirebbe «senza notifiche» per sempre — un elenco che cresce di
 * gente che non lavora più qui, dentro cui i casi veri si perdono.
 *
 * Sta in JS e non nella query perché `archiviato_il` può non esistere
 * nell'ambiente (vedi il ripiego al passo 1), e «non ho potuto leggere» non vale
 * «è archiviata». Il filtro di SEDE e quello di RUOLO sono nella query, perché
 * quelli restringono la lettura e non la decidono.
 *
 * ─── ⚠️ QUESTA LETTURA LASCIA UNA RIGA NEL REGISTRO DI VIGILANZA ────────────
 *
 * Non legge il `content` di nessun messaggio — le colonne sono due, e `content`
 * non c'è — ma attraversa `chat_messages` delle conversazioni fra famiglie e
 * maestre, e ne restituisce una misura col nome della docente accanto. Il lock
 * `__tests__/architecture/vigilanza-chat-tracciata.test.ts` non fa distinzione
 * fra leggere e contare, e non ha allowlist: «una voce qui vorrebbe dire questa
 * route può leggere di nascosto». Non è un cavillo da aggirare — è la regola
 * scritta dopo che `admin/chat/messages:GET` ha servito 1.577 messaggi in trenta
 * giorni senza lasciare traccia — quindi si registra, e la registrazione è
 * BLOCCANTE: se la riga non si scrive, i conteggi non escono (503).
 *
 * UNA riga PER SEDE LETTA — le sedi delle conversazioni effettivamente
 * attraversate, nessuna riga se non se n'è letta nessuna — non una per
 * conversazione: il registro serve a far vedere gli accessi, e riempirlo di
 * rumore lo rende illeggibile quanto lasciarlo vuoto (è la stessa ragione del
 * debounce sulla ricerca). La scheda non fa polling: la apre una persona, quando
 * le serve.
 *
 * ⚠️ PERCHÉ PER SEDE, e non una riga sola con `scuola_id` nullo. Chi legge il
 * registro lo legge da `admin/chat/vigilanza:GET`, che filtra
 * `.in('scuola_id', scope)` (riga 77 di quel file): una riga con `scuola_id`
 * nullo non corrisponde a nessun `IN`, e dalla scheda «Registro» non si vede
 * mai. Con tre sedi capiterebbe a ogni apertura — lettura tracciata e traccia
 * invisibile, che è peggio di non tracciare, perché sembra tracciato.
 *
 * Non è «indovinare la sede»: la Direzione ha attraversato le conversazioni di
 * CIASCUNA di quelle sedi, e ciascuna riga dice il vero. `n_messaggi` è
 * ripartito per sede, letta dal join sui thread, non un totale ripetuto.
 *
 * ⚠️ LIMITE DICHIARATO, per il titolare. `chat_vigilanza_accessi.azione` ammette
 * due valori — `CHECK (azione IN ('lettura','ricerca'))` — quindi questa riga si
 * scrive come `lettura` con `thread_id` nullo. Il registro la riconosce da quella
 * combinazione e la mostra con la sua etichetta («Ha consultato l'elenco delle
 * maestre senza notifiche (solo conteggi)», `RegistroVigilanza.tsx`), ma il FILTRO
 * per azione ha ancora due voci. Un terzo valore vorrebbe una migrazione sul
 * vincolo, il tipo `AzioneVigilanza` e la tendina del filtro: fuori perimetro.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Il nome dell'operazione per i log. ⚠️ In `withRoute` sta scritto il LETTERALE,
 * non questa costante: il lock `logging-coverage` legge il sorgente come testo e
 * confronta quel nome carattere per carattere col percorso del file — una
 * costante lì dentro gli risulta una route senza nome.
 */
const OPERAZIONE = 'admin/chat/docenti-senza-push:GET';

/**
 * La finestra dei messaggi RICEVUTI. Trenta giorni, come la segnalazione.
 *
 * ⚠️ NON vale per i NON LETTI, e ricavarli dalla stessa query sarebbe comodo. Un
 * messaggio mai letto però non scade: quello di quaranta giorni fa è lì, aspetta
 * ancora, e fuori dal conteggio toglierebbe peso proprio alla maestra più in
 * difficoltà — nel numero che ORDINA l'elenco.
 * «Ricevuti» misura il traffico recente, «non letti» misura l'arretrato: due
 * domande diverse, due letture diverse.
 */
const GIORNI_FINESTRA = 30;

/**
 * Il ruolo delle insegnanti. Un valore solo, e non l'elenco storico
 * (`['maestra','educator','docente',…]`) che sopravvive in tre route legacy:
 * la rubrica chat — cioè il codice che decide chi riceve i messaggi dei
 * genitori — guarda `ruolo === 'educator'` e nient'altro dal 2026-09-07.
 */
const RUOLO_DOCENTE = 'educator';

/**
 * Quante head-query dei non letti viaggiano insieme.
 *
 * Una per maestra: sul database è un conteggio sull'indice parziale, sulla rete
 * è una richiesta. Con sessanta docenti, tutte insieme sarebbero sessanta
 * connessioni in volo verso Supabase per una schermata che non ha fretta; una
 * alla volta sarebbero sessanta round trip in serie. Otto è il compromesso, e
 * non è un numero misurato: è un tetto prudente, da rivedere se un giorno questa
 * lettura risultasse lenta nei log.
 */
const CONTEGGI_IN_PARALLELO = 8;

const getQuerySchema = z.object({
  scuolaId: zOpzionale(zUuid),
  limite: zLimite({ predefinito: 100, max: 500 }),
  offset: z.coerce.number().int().min(0).default(0),
});

interface RigaDocente {
  id: string;
  nome?: string | null;
  cognome?: string | null;
  /** `undefined` = colonna non letta (schema non migrato) ⇒ «non archiviata». */
  archiviato_il?: string | null;
}

/**
 * Le colonne che si leggono di un messaggio: DUE, e `content` non c'è.
 *
 * `read_at` non serve nemmeno: il filtro dei non letti lo fa il database
 * (`.is('read_at', null)`), quindi di una conversazione fra una famiglia e una
 * maestra questa route porta in memoria il thread e chi ha scritto. Il nome sta
 * in una costante perché è UN posto solo da guardare — e da mutare, quando si
 * vuole vedere il test diventare rosso.
 */
const COLONNE_MESSAGGIO = 'thread_id, sender_id';

interface RigaMessaggio {
  thread_id: string;
  sender_id: string;
}

/**
 * Un thread con la sede del bambino, che arriva dal join `alunni!inner`.
 *
 * ⚠️ La forma del nodo annidato NON è una sola: PostgREST serve un OGGETTO per
 * una relazione to-one e un ARRAY quando la deduce to-many. (Una relazione
 * AMBIGUA è un'altra cosa e non arriva fin qui: risponde `PGRST201` e chiede di
 * disambiguare il nome dell'embed, quindi si presenta come errore e non come
 * forma inattesa.) Qui si accettano entrambe invece di fidarsi: se la forma
 * cambiasse,
 * un accesso a `.scuola_id` su un array darebbe `undefined` in silenzio — e la
 * riga di registro tornerebbe senza sede, cioè invisibile nella scheda che la
 * deve mostrare.
 */
interface RigaThread {
  id: string;
  teacher_id: string;
  alunni?: { scuola_id?: string | null } | { scuola_id?: string | null }[] | null;
}

const sedeDi = (t: RigaThread): string | null => {
  const nodo = Array.isArray(t.alunni) ? t.alunni[0] : t.alunni;
  return nodo?.scuola_id ?? null;
};

const nomeDi = (u?: { nome?: string | null; cognome?: string | null }) =>
  `${u?.cognome ?? ''} ${u?.nome ?? ''}`.trim() || '—';

/**
 * ⚠️ LE LETTURE PASSANO DA `leggiABlocchi`, NON DA UN CICLO SCRITTO QUI.
 *
 * `db-max-rows` su Supabase vale 1000: oltre quella soglia la risposta è
 * TRONCATA e non c'è nessun `error`, nessun avviso — la query «è andata bene» e
 * i dati sono metà. Su questo elenco morderebbe nel verso peggiore: un elenco di
 * dispositivi troncato farebbe comparire come «senza notifiche» maestre che le
 * hanno, cioè accuserebbe qualcuno per una riga non arrivata.
 *
 * `@/lib/pagamenti/leggi-a-blocchi` fa la stessa cosa e in più distingue i due
 * esiti che contano: `motivo: 'errore'` (una pagina ha risposto `{ error }`) e
 * `motivo: 'tetto'` (oltre 50.000 righe, verificato con una riga di prova, non
 * indovinato). Qui il TETTO È UN GUASTO — 500 — e non un elenco servito a metà:
 * nessuna sede della Kidville ha cinquantamila messaggi in trenta giorni, quindi
 * quel ramo significa «qualcosa non torna», non «l'elenco è grande».
 *
 * Sta sotto `lib/pagamenti/` per come è nato (l'export dello scadenzario), ma di
 * pagamenti non parla: è la paginazione di PostgREST, e duplicarla qui avrebbe
 * significato riscrivere anche la riga di prova del tetto — cioè la parte che
 * distingue «pieno per caso» da «troncato».
 */
const guastoLettura = (
  esito: Extract<EsitoABlocchi<unknown>, { ok: false }>,
  tipo: string,
): NextResponse => {
  if (esito.motivo === 'tetto') {
    // Solo il nome della lettura e dei conteggi: mai dati (AGENTS.md, regola 8).
    logErrore(
      { operazione: OPERAZIONE, stato: 500, evento: 'lettura-troncata' },
      new Error(`${descriviTetto(tipo, esito)}, rifiutata per intero`),
    );
  } else {
    logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, esito.error);
  }
  return letturaFallita();
};

const letturaFallita = () =>
  NextResponse.json(
    { error: "L'elenco non si è potuto leggere. Riprova fra poco.", codice: 'LETTURA_FALLITA' },
    { status: 500 },
  );

export const GET = withRoute('admin/chat/docenti-senza-push:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request, RUOLI_DIREZIONE);
  if (auth.response) return auth.response;
  const q = parseQuery(request, getQuerySchema);
  if ('response' in q) return q.response;

  try {
    const supabase = await createAdminClient();

    const attive = await resolveScuoleAttive(request, supabase, auth.user);
    const scope = restringiSedi(attive, q.data.scuolaId);
    if (!scope) return rifiutoSede('SEDE_NON_ACCESSIBILE');
    if (scope.length === 0) {
      return NextResponse.json({
        success: true,
        data: [],
        totale: 0,
        docentiTotali: 0,
        giorni: GIORNI_FINESTRA,
        limite: q.data.limite,
        offset: q.data.offset,
      });
    }

    // ── 1. LE DOCENTI DELLE SEDI NEL PERIMETRO ──────────────────────────────
    // `archiviato_il` esiste in produzione dal 2026-09-20 e può mancare sul DB
    // E2E della CI: PostgREST, su una colonna assente, non omette il campo —
    // fallisce la SELECT INTERA con `42703`. Il ripiego rilegge senza, come fa
    // `require-staff` per l'identità, e «non ho potuto leggere» non vale «è
    // archiviata»: nessuno viene escluso da un guasto di schema.
    // `leggiABlocchi` aggiunge da sé `.order('id')` e i `.range()`: la query si
    // COSTRUISCE a ogni blocco, perché il builder di PostgREST si modifica.
    const leggiDocenti = (colonne: string) =>
      leggiABlocchi<RigaDocente>(() =>
        supabase.from('utenti').select(colonne).eq('ruolo', RUOLO_DOCENTE).in('scuola_id', scope),
      );

    let lette = await leggiDocenti('id, nome, cognome, archiviato_il');
    if (!lette.ok && lette.motivo === 'errore' && schemaAssente(lette.error)) {
      logEvento(
        'chat',
        'warn',
        { operazione: OPERAZIONE, esito: 'archiviazione-non-leggibile', sedi: scope.length },
        lette.error,
      );
      lette = await leggiDocenti('id, nome, cognome');
    }
    if (!lette.ok) return guastoLettura(lette, 'docenti-senza-push-docenti');
    // Solo l'archiviazione: `utenti.attivo` è una casella che nessun gate legge
    // e che in produzione è a `false` su nove docenti con accessi recenti (vedi
    // la testata). Filtrarci sopra farebbe sparire dall'elenco le maestre vive
    // che l'elenco esiste per trovare.
    const docenti = lette.righe.filter((d) => !profiloStaffRevocato(d.archiviato_il));
    // ⚠️ NIENTE USCITA ANTICIPATA su «nessuna docente», e non per distrazione:
    // il codice che segue con `docenti = []` fa già esattamente la cosa giusta —
    // `aBlocchi([])` non produce blocchi, quindi nessuna query parte, nessuna
    // riga di registro si scrive e la risposta è la stessa. Un `if` in più
    // sarebbe un ramo che nessun test può distinguere dall'altro (provato: il
    // mutante che lo toglie resta verde), e un ramo indistinguibile è un posto
    // dove un domani si può scrivere una divergenza che nessuno vede.

    // ── 2. CHI HA ALMENO UN DISPOSITIVO ISCRITTO ────────────────────────────
    // Gli endpoint NON si leggono: serve sapere se sono zero, e l'endpoint è
    // l'indirizzo di un telefono. `push_subscriptions` non ha `scuola_id` — un
    // dispositivo appartiene a una persona, non a un plesso — e il perimetro
    // qui sono gli id già ristretti per sede al passo 1.
    const conDispositivo = new Set<string>();
    for (const blocco of aBlocchi(docenti.map((d) => d.id), ID_PER_QUERY)) {
      const esito = await leggiABlocchi<{ utente_id: string }>(() =>
        supabase.from('push_subscriptions').select('utente_id').in('utente_id', blocco),
      );
      // Un guasto qui NON degrada a «nessun dispositivo», e nemmeno il tetto:
      // direbbero alla Direzione che quelle maestre sono senza notifiche.
      if (!esito.ok) return guastoLettura(esito, 'docenti-senza-push-dispositivi');
      for (const r of esito.righe) conDispositivo.add(r.utente_id);
    }
    const senzaPush = docenti.filter((d) => !conDispositivo.has(d.id));

    // ── 3. LE LORO CONVERSAZIONI, dentro le sedi del perimetro ──────────────
    // `chat_threads` non ha `scuola_id`: la sede è del BAMBINO, e si deriva dal
    // join (`alunni!inner`) esattamente come nella supervisione.
    const docenteDelThread = new Map<string, string>();
    // La sede si porta dietro perché serve al REGISTRO: una riga per sede, con
    // il suo conteggio. Il join la dà già — è il filtro stesso — e riprenderla
    // con una seconda query sarebbe leggere due volte lo stesso dato.
    const sedeDelThread = new Map<string, string | null>();
    if (senzaPush.length > 0) {
      for (const blocco of aBlocchi(senzaPush.map((d) => d.id), ID_PER_QUERY)) {
        const esito = await leggiABlocchi<RigaThread>(() =>
          supabase
            .from('chat_threads')
            .select('id, teacher_id, alunni!inner(scuola_id)')
            .in('teacher_id', blocco)
            .in('alunni.scuola_id', scope),
        );
        if (!esito.ok) return guastoLettura(esito, 'docenti-senza-push-conversazioni');
        for (const t of esito.righe) {
          docenteDelThread.set(t.id, t.teacher_id);
          sedeDelThread.set(t.id, sedeDi(t));
        }
      }
    }

    // ── 4. I MESSAGGI: due domande, due letture di forma diversa ────────────
    //  (a) RICEVUTI negli ultimi 30 giorni — quanto traffico ha adesso. Si
    //      LEGGONO le righe, perché servono per ripartire i conteggi fra le sedi
    //      (il registro vuole l'`n_messaggi` di ciascuna) e la finestra tiene
    //      l'insieme piccolo;
    //  (b) NON LETTI, senza nessuna finestra — quanto arretrato le è rimasto. Si
    //      CONTANO con una head-query per maestra: `count: 'exact', head: true`,
    //      nessuna riga trasferita.
    //
    // ⚠️ PERCHÉ LE DUE FORME SONO DIVERSE. L'arretrato non ha limite di tempo:
    // trasferire tutte le righe con `read_at` nullo di tutti i thread, dei due
    // versi e da sempre, per poi scartare in JS quelle scritte dalla maestra, è
    // il conteggio più caro possibile del numero più piccolo. La stessa domanda
    // il badge della chat la fa già così (`src/lib/chat/non-letti.ts:171-177`):
    // `.neq('sender_id', …).is('read_at', null)`, che è anche la forma
    // dell'indice parziale dei non letti.
    //
    // ⚠️ NIENTE FUNZIONE SQL al posto di queste query, anche se sarebbe un giro
    // solo: il lock `vigilanza-chat-tracciata` riconosce chi tocca i messaggi da
    // `.from('chat_messages')`, e dentro una RPC questa route gli diventerebbe
    // invisibile — cioè potrebbe contare senza lasciare traccia.
    //
    // ⚠️ I «NON LETTI» QUI SONO QUELLI CHE LA MAESTRA DEVE LEGGERE, lato docente:
    // i messaggi che ha ricevuto e non ha ancora aperto. Il badge della chat
    // (`leggiChatNonLetti`) conta invece i non letti di TUTTE le conversazioni
    // della persona, nei due ruoli — e quattro insegnanti sono anche genitori di
    // un bambino della scuola. I due numeri possono non coincidere, ed è giusto:
    // questa scheda misura il lavoro che aspetta la maestra, non la sua campanella.
    const dalGiorno = new Date(Date.now() - GIORNI_FINESTRA * 86_400_000).toISOString();
    const ricevuti = new Map<string, number>();
    const nonLetti = new Map<string, number>();
    /** Messaggi ricevuti per SEDE: è l'`n_messaggi` delle righe di registro. */
    const messaggiPerSede = new Map<string, number>();
    /**
     * Somma per docente, saltando i messaggi scritti da lei: contarli
     * gonfierebbe proprio la maestra che risponde di più.
     */
    const accumula = (righe: RigaMessaggio[]) => {
      for (const m of righe) {
        const docente = docenteDelThread.get(m.thread_id);
        if (!docente || m.sender_id === docente) continue;
        ricevuti.set(docente, (ricevuti.get(docente) ?? 0) + 1);
        const sede = sedeDelThread.get(m.thread_id);
        if (sede) messaggiPerSede.set(sede, (messaggiPerSede.get(sede) ?? 0) + 1);
      }
    };

    for (const blocco of aBlocchi([...docenteDelThread.keys()], ID_PER_QUERY)) {
      const recenti = await leggiABlocchi<RigaMessaggio>(() =>
        supabase
          .from('chat_messages')
          .select(COLONNE_MESSAGGIO)
          .in('thread_id', blocco)
          .gte('created_at', dalGiorno),
      );
      if (!recenti.ok) return guastoLettura(recenti, 'docenti-senza-push-messaggi');
      accumula(recenti.righe);
    }

    // I thread di ciascuna maestra, per la head-query: sono già filtrati per
    // sede al passo 3, quindi qui non si allarga niente.
    const threadPerDocente = new Map<string, string[]>();
    for (const [thread, docente] of docenteDelThread) {
      threadPerDocente.set(docente, [...(threadPerDocente.get(docente) ?? []), thread]);
    }

    /**
     * I non letti di UNA maestra: `count` e nessuna riga.
     *
     * `null` = non si è potuto contare, e il chiamante rifiuta: mai il parziale,
     * che sarebbe un numero sbagliato per difetto indistinguibile da quello
     * giusto (è la stessa scelta di `leggiChatNonLetti`).
     */
    const contaNonLetti = async (docente: string, threads: string[]): Promise<number | null> => {
      let totale = 0;
      for (const blocco of aBlocchi(threads, ID_PER_QUERY)) {
        const { count, error } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .in('thread_id', blocco)
          .neq('sender_id', docente)
          .is('read_at', null);
        if (error) {
          logErrore({ operazione: OPERAZIONE, stato: 500, evento: 'db' }, error);
          return null;
        }
        totale += count ?? 0;
      }
      return totale;
    };

    // In parallelo, ma con un TETTO: una head-query per maestra è economica sul
    // database e cara sulla rete, e sessanta richieste tutte insieme non le fa
    // nessuno. `CONTEGGI_IN_PARALLELO` è il numero di richieste in volo.
    const daContare = senzaPush.filter((d) => (threadPerDocente.get(d.id) ?? []).length > 0);
    for (let i = 0; i < daContare.length; i += CONTEGGI_IN_PARALLELO) {
      const lotto = daContare.slice(i, i + CONTEGGI_IN_PARALLELO);
      const conteggi = await Promise.all(
        lotto.map((d) => contaNonLetti(d.id, threadPerDocente.get(d.id) ?? [])),
      );
      if (conteggi.some((c) => c === null)) return letturaFallita();
      lotto.forEach((d, k) => nonLetti.set(d.id, conteggi[k] as number));
    }

    // ── 5. LE RIGHE DI REGISTRO, prima che i numeri escano ──────────────────
    // Bloccante: `registraAccessoVigilanza` RIFERISCE se ha tracciato, e qui si
    // sceglie di non far uscire niente se non l'ha fatto — la stessa scelta di
    // `admin/chat/messages:GET`. La tabella assente (DB E2E della CI non
    // migrato) NON è un guasto: quella funzione risponde `tracciato: true`.
    //
    // UNA RIGA PER SEDE DAVVERO LETTA, ognuna con la SUA `scuola_id` e il suo
    // conteggio. Due cose, entrambe misurabili:
    //  · la sede si scrive perché chi legge il registro filtra
    //    `.in('scuola_id', scope)`: una riga senza sede non comparirebbe mai in
    //    quella scheda, cioè sarebbe tracciata e invisibile;
    //  · le sedi sono quelle dei THREAD letti, non tutto il perimetro. La
    //    Direzione di tre sedi che apre la scheda quando solo Giugliano ha
    //    conversazioni non ha guardato i messaggi di Aversa e Cesa: due righe in
    //    più direbbero di uno sguardo che non c'è stato. Nessun thread letto ⇒
    //    nessuna riga, e quindi nessun 503: non c'è niente da tracciare.
    //
    // Si scrivono TUTTE e poi si decide: un 503 solo, se almeno una è mancata —
    // fermarsi alla prima rinuncerebbe alle tracce delle altre sedi, che sono
    // proprio quelle che si vorrebbero avere quando qualcosa va storto.
    //
    // ⚠️ IN SERIE, e non con un `Promise.all`, per una ragione che si vede solo
    // leggendo il lock: `vigilanza-chat-tracciata` riconosce la registrazione
    // bloccante da una FORMA — `const { tracciato } = await
    // registraAccessoVigilanza(` — perché una chiamata di cui non si guarda
    // l'esito, o che vive solo nel ramo che nega, è già passata per corretta in
    // questo repo. Dentro un `Promise.all(sedi.map(…))` quella forma non c'è, e
    // il lock tornava rosso: la risposta giusta è scrivere il codice nella forma
    // che il lock sa leggere, non allargare la sua regex. Tre sedi sono tre
    // INSERT: il costo è trascurabile, la verifica no.
    //
    // ⚠️ `n_messaggi` SONO LE RIGHE DAVVERO TRASFERITE di quella sede: i
    // messaggi ricevuti nei trenta giorni. L'arretrato più vecchio non c'è
    // dentro, e non è una dimenticanza — quello si conta con una head-query, che
    // non porta nessuna riga: non è stato letto niente, e il registro non deve
    // dire il contrario.
    const sediLette = [...new Set([...sedeDelThread.values()].filter((x): x is string => !!x))];
    let tutteTracciate = true;
    for (const sede of sediLette) {
      const { tracciato } = await registraAccessoVigilanza(supabase, {
        operatore: auth.user,
        azione: 'lettura',
        nMessaggi: messaggiPerSede.get(sede) ?? 0,
        scuolaId: sede,
        request,
      });
      if (!tracciato) tutteTracciate = false;
    }
    if (!tutteTracciate) {
      return NextResponse.json(
        {
          error: 'La consultazione non si è potuta registrare: riprova fra poco.',
          codice: 'VIGILANZA_NON_TRACCIABILE',
        },
        { status: 503 },
      );
    }

    // ── 6. L'ELENCO, dal caso più urgente ───────────────────────────────────
    const elenco = senzaPush
      .map((d) => ({
        id: d.id,
        nome: nomeDi(d),
        ricevuti30g: ricevuti.get(d.id) ?? 0,
        nonLetti: nonLetti.get(d.id) ?? 0,
      }))
      .sort(
        (a, b) =>
          b.nonLetti - a.nonLetti ||
          b.ricevuti30g - a.ricevuti30g ||
          a.nome.localeCompare(b.nome),
      );

    const totMessaggi = elenco.reduce((s, r) => s + r.ricevuti30g, 0);
    const totNonLetti = elenco.reduce((s, r) => s + r.nonLetti, 0);
    // Il SUCCESSO si logga (regola 5 di AGENTS.md): senza, «nessun log» non
    // distingue «nessuna maestra senza notifiche» da «la schermata non è mai
    // stata aperta». Solo numeri e uuid: nessun nome, nessun testo.
    logEvento('chat', 'info', {
      operazione: OPERAZIONE,
      esito: 'ok',
      sedi: scope.length,
      docenti: docenti.length,
      senza_push: elenco.length,
      messaggi: totMessaggi,
      non_letti: totNonLetti,
      giorni: GIORNI_FINESTRA,
    });

    return NextResponse.json({
      success: true,
      data: elenco.slice(q.data.offset, q.data.offset + q.data.limite),
      totale: elenco.length,
      docentiTotali: docenti.length,
      giorni: GIORNI_FINESTRA,
      limite: q.data.limite,
      offset: q.data.offset,
    });
  } catch (err) {
    // `withRoute` non vede le eccezioni catturate: la riga la scrive questo ramo.
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err);
    return letturaFallita();
  }
});
