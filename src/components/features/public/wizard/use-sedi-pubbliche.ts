'use client'

import { useEffect, useState } from 'react'
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  L'ELENCO DELLE SEDI DEI MODULI PUBBLICI — scritto UNA volta sola        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Questa logica è nata su `EnrollmentWizard`, è stata RICOPIATA su
 * `CandidaturaInsegnanteWizard` il 10/08/2026, e sta per esserlo una terza volta
 * (`/anagrafica-personale`). Ogni copia ha ereditato i difetti della precedente
 * e ne ha aggiunto uno suo: è l'unico pezzo di guscio che, in questo repo, ha
 * già prodotto vicoli ciechi in produzione. Da qui in avanti si scrive qui.
 *
 * ── LE TRE COSE CHE UNA COPIA SBAGLIA SEMPRE ────────────────────────────────
 *
 *   · `!r.ok` NON è un'eccezione. Il `catch` di una promise non scatta su un
 *     429, e fino al 2026-08-02 il rate-limit di `/api/iscrizione/sedi` passava
 *     in silenzio: l'elenco restava vuoto, «vuoto» valeva «una sede sola», e la
 *     domanda partiva per non poter essere inviata;
 *   · un 200 con un corpo SENZA l'array `data` non è «nessuna sede»: è «elenco
 *     non ottenuto». `null` non è `[]`, e confonderli è lo stesso difetto con
 *     un'altra faccia;
 *   · un elenco VUOTO non è «una sede sola, vai avanti». Con tre plessi dedurre
 *     la sede vuol dire archiviare i dati nel posto sbagliato in silenzio, e le
 *     rotte pubbliche pretendono `scuola_id` come uuid OBBLIGATORIO: senza sede
 *     non c'è nessun invio possibile, quindi il modulo non comincia.
 *
 * ── PERCHÉ `?sede=` NON BASTA, E L'ELENCO SI CHIEDE COMUNQUE ────────────────
 *
 * Fino al 2026-08-11 un link «targato» (`?sede=<uuid>`) faceva saltare del tutto
 * la fetch dell'elenco: la sede era «già decisa», il passo di scelta non poteva
 * esistere e un uuid che la rotta non accetta diventava un vicolo cieco DOPO
 * quattro passi compilati — riepilogo «Sede scelta —», e all'invio il 400
 * `SEDE_DA_SPECIFICARE`, cioè un ordine («scegli la sede») che l'interfaccia non
 * permetteva di eseguire (zero `radio` in pagina).
 *
 * E un uuid che la rotta non accetta NON è un caso di scuola: le rotte pubbliche
 * validano `scuola_id` contro `sediReali`, che applica `scuole.attiva` ed esclude
 * la sede di collaudo. Un plesso soft-deleted, la sede E2E, un volantino stampato
 * l'anno prima, un uuid ritoccato a mano: quattro strade per lo stesso vicolo.
 *
 * Adesso l'elenco è l'AUTORITÀ e si chiede sempre; `?sede=` è un suggerimento
 * che vale solo se l'elenco lo conferma:
 *
 *   · elenco ottenuto e il link c'è dentro → nessun passo di scelta (com'era), e
 *     in più il riepilogo può dire il NOME del plesso invece di un trattino;
 *   · elenco ottenuto e il link NON c'è dentro → il link si abbandona PRIMA che
 *     sia stato compilato alcunché, e il passo «sede» torna al suo posto: chi
 *     apre il volantino vecchio sceglie, e non se ne accorge nemmeno;
 *   · elenco NON ottenuto (429, rete giù, corpo strano) → il link si tiene e il
 *     modulo parte lo stesso. È la proprietà che va difesa a ogni costo: nessun
 *     guasto dell'elenco può impedire un invio;
 *   · e se in quel caso il server rifiuta comunque con `SEDE_DA_SPECIFICARE`
 *     (link davvero morto, oppure plesso disattivato mentre si compilava), il
 *     rifiuto è AZIONABILE: `sedeSmentitaDalServer()` abbandona il link, richiede
 *     l'elenco, e il passo «sede» ricompare davanti.
 *
 * ── E DOPO IL RIFIUTO IL MODULO NON SI SMONTA PIÙ, QUALUNQUE COSA DICA L'ELENCO
 *
 * La rete residua qui sopra non copriva il caso per cui era nata.
 * `sedeSmentitaDalServer()` richiede l'elenco, e finché quella richiesta è in
 * volo la forma dei passi tornava «non decisa»: il ramo dei passi — l'UNICO che
 * contiene il pannello dell'errore d'invio — veniva smontato, e se il
 * ri-caricamento falliva di nuovo si cadeva sulla schermata «Non riusciamo a
 * caricare le sedi / Controlla la connessione». MISURATO sullo scenario esatto
 * (`?sede=` morto + elenco illeggibile): messaggio della sede rifiutata in
 * pagina, `false`; pannello generico delle sedi, `true`.
 *
 * E non è il caso raro: la causa documentata per cui il link viene creduto è il
 * 429 di `/api/iscrizione/sedi`, che dura DIECI MINUTI — il tentativo che parte
 * subito dopo il rifiuto cade quasi certamente nella stessa finestra. Chi aveva
 * compilato quattro passi leggeva una schermata che non diceva che l'invio era
 * fallito, non nominava la sede del collegamento, dava la colpa a una
 * connessione che non ne aveva, e offriva un bottone destinato a ripetere lo
 * stesso errore fino allo scadere del tetto.
 *
 * Da qui in avanti vale una regola sola, ed è `sedeRifiutata !== null`
 * (`giaCompilato`): quando il server ha rifiutato la sede, il modulo è GIÀ
 * COMINCIATO ed è già compilato. La forma dei passi resta decisa (il passo
 * «sede» ci sarà comunque), e le tre notizie sull'elenco — attesa, guasto,
 * elenco vuoto — si danno DENTRO il passo «sede» invece che al posto dell'intera
 * pagina.
 */

/** Da dove si legge l'elenco pubblico dei plessi. È la stessa per tutti i moduli. */
export const ROTTA_SEDI = '/api/iscrizione/sedi'

/**
 * Stato dell'elenco sedi. Sono TRE, e il difetto nasceva dall'averne due:
 * «elenco vuoto» e «elenco non ottenuto» finivano nella stessa variabile, e
 * `sedi.length` non poteva distinguerli.
 */
export type StatoSedi = 'caricamento' | 'pronto' | 'errore'

export interface SedePubblica {
  id: string
  nome: string
}

/**
 * Estrae `[{ id, nome }]` dalla risposta di `/api/iscrizione/sedi`, scartando le
 * voci di forma inattesa.
 *
 * `null` = **elenco NON ottenuto** (il corpo non contiene affatto un array
 * `data`), che NON è la stessa cosa di un elenco vuoto: `[]` è una risposta
 * valida — è ciò che risponde il database della CI — e va detta con la sua
 * frase; `null` è un guasto, e si può riprovare.
 */
export function sediValide(payload: unknown): SedePubblica[] | null {
  const data = (payload as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return null
  return data
    .filter(
      (s): s is SedePubblica =>
        s !== null && typeof s === 'object' &&
        typeof (s as SedePubblica).id === 'string' && (s as SedePubblica).id.length > 0 &&
        typeof (s as SedePubblica).nome === 'string' && (s as SedePubblica).nome.length > 0,
    )
    .map((s) => ({ id: s.id, nome: s.nome }))
}

/**
 * Il corpo JSON di una risposta, senza mai lanciare e senza mai tacere.
 *
 * Non si usa `.catch(() => null)`: un `catch` che non logga è un bug (AGENTS.md,
 * regola 6), e qui il caso vero esiste — un 500 di piattaforma senza corpo, o
 * l'HTML di un proxy. Il livello è `warn` perché il fatto è «il server ha
 * risposto e non l'abbiamo capito», che è diverso dal guasto vero e proprio.
 *
 * `etichetta` è lo slug del modulo che sta chiedendo (`candidatura`, …): il
 * messaggio di un log del client è anche la chiave del throttle di `logClient`,
 * e due moduli pubblici che spedissero lo stesso slug si dedurrebbero a vicenda
 * proprio mentre uno dei due è guasto.
 */
export async function corpoDellaRisposta(res: Response, etichetta: string): Promise<unknown> {
  try {
    return await res.json()
  } catch (err) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `${etichetta}-corpo-illeggibile: ${nomeErrore(err)}`,
      stato: res.status,
    })
    return null
  }
}

/** Ciò che un modulo pubblico sa delle sedi, e i comandi con cui lo cambia. */
export interface SediPubbliche {
  /** L'elenco ottenuto. Vuoto anche quando l'elenco NON è arrivato: vedi `statoSedi`. */
  sedi: SedePubblica[]
  statoSedi: StatoSedi
  /** L'elenco è arrivato ed è leggibile — vuoto o no. */
  elencoPronto: boolean
  /** Richiede l'elenco da capo. È ciò che sta sotto il bottone «Riprova». */
  riprova: () => void
  /** La sede spuntata da chi compila (auto-decisa quando il plesso è uno solo). */
  sedeScelta: string | null
  scegliSede: (id: string) => void
  /** L'uuid che il SERVER ha rifiutato, se c'è stato. */
  sedeRifiutata: string | null
  /** Il server ha rifiutato la sede: si abbandona il link e si richiede l'elenco. */
  sedeSmentitaDalServer: (sede: string) => void
  /** La sede decisa dal link, se il link vale ancora qualcosa. */
  sedeDaLink: string | null
  /** Il link è smentito dall'elenco o dal server: da qui in poi non è mai esistito. */
  linkSmentito: boolean
  /** La sede che partirà nel POST: il link se regge, altrimenti la scelta. */
  sedeDecisa: string | null
  /** Il NOME del plesso indicato dal collegamento, quando si sa. */
  nomeSedeDalLink: string | null
  /** Il NOME del plesso che partirà nel POST, quando si sa. */
  nomeSedeDecisa: string | null
  /** Un rifiuto del server è arrivato: il modulo è già cominciato ed è già compilato. */
  giaCompilato: boolean
  /** Il passo «sede» esiste. */
  mostraSede: boolean
  /** La FORMA dei passi è definitiva e si può dipingere il primo. */
  formaDecisa: boolean
  /** L'elenco non è arrivato e non c'è un link su cui ripiegare: si offre «Riprova». */
  sediNonCaricate: boolean
  /** L'elenco è ARRIVATO ed è VUOTO: nessun plesso riceve questo modulo. */
  sediVuote: boolean
  /** Il modulo non può nemmeno cominciare, e si dice perché. */
  nonPuoCominciare: boolean
  /** Nel passo «sede» c'è davvero una scelta da fare. */
  sedeSceglibile: boolean
}

export function useSediPubbliche({
  sedeId = null,
  etichetta,
}: {
  /**
   * La sede arrivata dal link (`?sede=`). La stringa VUOTA vale come ASSENTE: è
   * falsy ma non `null`, e trattata come «sede già decisa» farebbe partire
   * l'invio senza sede dopo aver fatto scegliere il plesso.
   */
  sedeId?: string | null
  /** Lo slug del modulo, per i log: `candidatura`, `anagrafica-personale`, … */
  etichetta: string
}): SediPubbliche {
  /** L'uuid arrivato dal link, normalizzato. È un SUGGERIMENTO, non una decisione. */
  const sedeLink = sedeId !== null && sedeId.trim().length > 0 ? sedeId.trim() : null

  const [sedi, setSedi] = useState<SedePubblica[]>([])
  const [statoSedi, setStatoSedi] = useState<StatoSedi>('caricamento')
  /** Cambia a ogni «Riprova»: è ciò che fa ripartire la fetch dell'elenco. */
  const [tentativoSedi, setTentativoSedi] = useState(0)
  const [sedeScelta, setSedeScelta] = useState<string | null>(null)
  /**
   * La sede che il SERVER ha appena rifiutato (400 `SEDE_DA_SPECIFICARE`), se
   * c'è stata. Non è un doppione dell'elenco: è l'unico modo di sapere che quel
   * plesso non vale più anche quando l'elenco non si è potuto leggere.
   */
  const [sedeRifiutata, setSedeRifiutata] = useState<string | null>(null)

  useEffect(() => {
    // L'elenco si chiede SEMPRE, anche col link targato: è l'unica autorità su
    // quali plessi ricevono il modulo, ed è lo stesso predicato (`sediReali`)
    // che la rotta d'invio applica a `scuola_id`. Chiederlo qui costa una
    // richiesta e vale la differenza fra un link vecchio che si corregge da solo
    // al primo schermo e un vicolo cieco dopo quattro passi compilati.
    let annullato = false
    fetch(ROTTA_SEDI)
      .then(async (r) => {
        // `!r.ok` NON è un'eccezione: il `catch` qui sotto non scatterebbe, ed è
        // esattamente da qui che il 429 del rate-limit passava in silenzio.
        if (!r.ok) {
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: `${etichetta}-sedi-non-caricate`,
            stato: r.status,
          })
          return null
        }
        const lista = sediValide(await corpoDellaRisposta(r, etichetta))
        if (lista === null) {
          // 200 con un corpo che non contiene l'elenco: l'elenco non c'è lo
          // stesso, e trattarlo come «nessuna sede» sarebbe una bugia diversa.
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: `${etichetta}-sedi-corpo-inatteso`,
            stato: r.status,
          })
        }
        return lista
      })
      .then((lista) => {
        if (annullato) return
        if (lista === null) {
          setStatoSedi('errore')
          return
        }
        setSedi(lista)
        // Con UNA sola sede non si fa scegliere niente, ma la sede va DECISA lo
        // stesso: `scuola_id` è obbligatorio sulla rotta, e lasciarlo `null`
        // qui significherebbe un 400 all'invio dopo quattro passi compilati.
        if (lista.length === 1) setSedeScelta(lista[0].id)
        setStatoSedi('pronto')
      })
      .catch((err) => {
        // Rete giù, o JSON illeggibile. Un catch che non logga è un bug, e
        // `logClient` non lancia mai.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `${etichetta}-sedi-non-caricate: ${nomeErrore(err)}`,
          stack: err instanceof Error ? err.stack : undefined,
        })
        if (annullato) return
        setStatoSedi('errore')
      })
    return () => {
      annullato = true
    }
  }, [tentativoSedi, etichetta])

  const elencoPronto = statoSedi === 'pronto'
  /**
   * Il link è SMENTITO: l'elenco è arrivato e non lo contiene, oppure il server
   * ha rifiutato proprio quell'uuid. In entrambi i casi smette di valere, e da
   * qui in poi il modulo si comporta come se il link non ci fosse mai stato.
   */
  const linkSmentito =
    sedeLink !== null &&
    (sedeLink === sedeRifiutata || (elencoPronto && !sedi.some((s) => s.id === sedeLink)))
  const sedeDaLink = sedeLink !== null && !linkSmentito ? sedeLink : null
  const sedeDecisa = sedeDaLink ?? sedeScelta
  /**
   * Il NOME del plesso indicato dal collegamento, quando si sa.
   *
   * Con `?sede=<uuid>` il passo di scelta non esiste e fino all'11/08/2026 la
   * scuola non veniva nominata da nessuna parte fino al riepilogo: si compilavano
   * tre passi su quattro senza sapere per quale sede — e il collegamento targato è
   * proprio quello che una sede manda su WhatsApp. Il nome c'è già in casa: dal
   * 2026-08-11 l'elenco si chiede SEMPRE, anche col link (vedi il blocco in testa
   * al file), quindi non costa nemmeno una richiesta in più.
   * Resta `null` nell'unico caso in cui il nome non è noto — elenco non arrivato
   * (429, rete giù) — e allora non si scrive niente: un uuid non dice nulla a chi
   * lo legge, ed è meglio nessuna riga che una riga vuota.
   */
  const nomeSedeDalLink =
    sedeDaLink !== null ? (sedi.find((s) => s.id === sedeDaLink)?.nome ?? null) : null
  const nomeSedeDecisa = sedi.find((s) => s.id === sedeDecisa)?.nome ?? null

  /**
   * IL MODULO È GIÀ COMINCIATO, ED È GIÀ COMPILATO.
   *
   * Un rifiuto `SEDE_DA_SPECIFICARE` si può ricevere solo dal riepilogo, cioè
   * dopo aver riempito tutti i passi. Da quel momento nessuna notizia
   * sull'elenco può più smontare il modulo: le schermate che «non fanno
   * cominciare» sono giuste all'apertura e sarebbero una perdita di lavoro qui.
   */
  const giaCompilato = sedeRifiutata !== null

  /**
   * La sede si sceglie quando c'è davvero da scegliere — e SEMPRE dopo un
   * rifiuto del server sulla sede, anche con un plesso solo, anche mentre
   * l'elenco si sta ricaricando: lì la frase d'errore parla della sede, e una
   * frase che nomina un passo che non c'è è precisamente il vicolo cieco che
   * questo ramo esiste per chiudere.
   */
  const mostraSede = sedeDaLink === null && (giaCompilato || sedi.length > 1)

  /**
   * La FORMA dei passi è definitiva e si può dipingere il primo.
   *
   * `errore` non decide la forma DA SOLO: con l'elenco ignoto non si sa se il
   * passo sede serva, e far cominciare il modulo significherebbe farlo compilare
   * per intero per poi rifiutarlo. Col link ancora in piedi però la forma È
   * decisa (nessuna scelta da fare), e il modulo parte: un guasto dell'elenco non
   * può impedire un invio.
   *
   * Dopo un rifiuto sulla sede la forma è decisa una volta per tutte: il passo
   * «sede» c'è, e ci resta qualunque cosa risponda il ri-caricamento. È la riga
   * che impedisce al modulo compilato di sparire mentre l'elenco è in volo.
   */
  const formaDecisa =
    (elencoPronto && sedi.length > 0) || (statoSedi === 'errore' && sedeDaLink !== null) || giaCompilato
  /** L'elenco non è arrivato e non c'è un link su cui ripiegare: si offre «Riprova». */
  const sediNonCaricate = statoSedi === 'errore' && sedeDaLink === null && !giaCompilato
  /**
   * L'elenco è ARRIVATO ed è VUOTO: non esiste nessuna sede a cui rivolgersi, e
   * la rotta pretende `scuola_id`. Quindi il modulo non comincia, e si dice
   * perché — senza «Riprova»: ricaricare darebbe la stessa risposta, e un
   * pulsante che ripete la stessa risposta insegna a non fidarsi dei pulsanti.
   *
   * Vale anche col link targato: se nessun plesso riceve il modulo, quel link
   * non ne indica uno valido per definizione (è lo stesso predicato).
   *
   * NON vale a modulo già compilato: la stessa notizia si dà dentro il passo
   * «sede», che a quel punto esiste, senza buttare via quattro passi di lavoro.
   */
  const sediVuote = elencoPronto && sedi.length === 0 && !giaCompilato
  const nonPuoCominciare = sediNonCaricate || sediVuote
  /**
   * Nel passo «sede» c'è davvero una scelta da fare. Quando l'elenco è in volo,
   * guasto o vuoto non c'è: «Avanti» prometterebbe un passaggio che non esiste e
   * risponderebbe solo «Scegli una sede per proseguire», davanti a zero sedi.
   */
  const sedeSceglibile = elencoPronto && sedi.length > 0

  function riprova(): void {
    setStatoSedi('caricamento')
    setTentativoSedi((n) => n + 1)
  }

  /**
   * IL SERVER HA RIFIUTATO LA SEDE (400 `SEDE_DA_SPECIFICARE`).
   *
   * È il ramo che trasforma un vicolo cieco in un rifiuto azionabile, e fa
   * tre cose in un ordine che conta:
   *  1. segna l'uuid come rifiutato — così il link targato smette di valere e
   *     `mostraSede` diventa vero anche se i plessi sono uno solo;
   *  2. dimentica la scelta, che il server ha appena smentito;
   *  3. RICHIEDE l'elenco. È l'unica autorità su quali plessi accettano, ed è lo
   *     stesso predicato che la rotta applica: dopo l'aggiornamento, ciò che si
   *     può scegliere è ciò che il server accetta.
   *
   * Il ritorno al primo passo lo fa il chiamante: è l'unico a sapere che numero
   * ha, e i dati compilati NON si toccano — react-hook-form li conserva anche
   * mentre il pannello dei campi è smontato dall'attesa dell'elenco.
   */
  function sedeSmentitaDalServer(sede: string): void {
    setSedeRifiutata(sede)
    setSedeScelta(null)
    riprova()
  }

  function scegliSede(id: string): void {
    setSedeScelta(id)
  }

  return {
    sedi,
    statoSedi,
    elencoPronto,
    riprova,
    sedeScelta,
    scegliSede,
    sedeRifiutata,
    sedeSmentitaDalServer,
    sedeDaLink,
    linkSmentito,
    sedeDecisa,
    nomeSedeDalLink,
    nomeSedeDecisa,
    giaCompilato,
    mostraSede,
    formaDecisa,
    sediNonCaricate,
    sediVuote,
    nonPuoCominciare,
    sedeSceglibile,
  }
}
