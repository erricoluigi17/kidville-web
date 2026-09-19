import type { SupabaseClient } from '@supabase/supabase-js'
import { dataCivile } from '@/i18n/config'
import { fineGiornoCivile, inizioGiornoCivile } from '@/lib/format/confini-giorno'
import { logEvento } from '@/lib/logging/logger'
import { tabellaMancante } from '@/lib/db/tolleranza-schema'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari'
import { DEFAULT_AVVISI_CONFIG } from '@/lib/scuole/admin-settings-default'
import { MAX_PAGINE, RIGHE_PER_PAGINA } from '@/lib/avvisi/statistiche'

// =============================================================================
// LA QUARTA SCANSIONE DI `notifiche-promemoria`: «mancano N giorni per aderire».
//
// ── PERCHÉ È UN MODULO E NON UN QUARTO BLOCCO DENTRO LA ROUTE ────────────────
//
// Perché la scansione è la parte che può sbagliare i conti — il fuso, il numero
// di giorni della SUA sede, chi ha già risposto — e una scansione che vive dentro
// un `export const POST` si può provare solo passando da HTTP, cioè costruendo
// una Request, un segreto cron e un finto `NextResponse` per misurare un `if`.
// Il precedente è identico e sta già nella stessa route: `riconciliaTutto`
// (`@/lib/armadietto/richieste`). Alla route restano il `try/catch`, il contatore
// e il battito; qui sta il lavoro.
//
// ── PERCHÉ LA ROUTE È QUELLA ESISTENTE E NON UNA NUOVA ──────────────────────
//
// Questa è la decisione che costa di più a chi la rifà, quindi va scritta una
// volta per tutte. `POST /api/notifiche/promemoria` ha GIÀ:
//   · il nome `notifiche/promemoria:POST` nel lock `logging-coverage`;
//   · il gruppo in `zod-coverage`;
//   · il gate `segretoCronValido`;
//   · lo schedule `notifiche-promemoria` in `JOB_CRON` (`@/lib/health/controlli`)
//     — e quello schedule è GIÀ APPLICATO in produzione.
// Una route nuova avrebbe voluto un `cron.schedule` in migrazione, una GUC da
// impostare a mano in produzione e un nome nuovo in `JOB_CRON`; e finché quella
// migrazione non è nella fotografia delle applicate, il lock
// `cron-sorvegliato-e-applicato` è ROSSO e `/api/health` resta `degradato` dal
// primo deploy — cioè un allarme che suona da solo, che è il modo più rapido di
// far smettere alla gente di guardarlo. Tre modi nuovi di rompersi in cambio di
// zero vantaggi: la scansione entra dove ce ne sono già tre.
//
// ── IL BUDGET DI QUERY, DICHIARATO ──────────────────────────────────────────
//
//   2 fisse  +  3 per AVVISO  —  e MAI una per famiglia.
//
//   A) una lettura di `admin_settings` (tutte le sedi insieme);
//   B) una lettura di `avvisi`;
//   poi, per ciascun avviso in finestra:
//   C) i destinatari (`genitoriDiScuola`/`genitoriDiClassi`, le stesse funzioni
//      della pubblicazione: hanno il proprio contratto «3 query fisse, mai N+1»);
//   D) chi ha già risposto (una lettura completa di `avvisi_risposte`);
//   E) chi ha già ricevuto il promemoria (una lettura di `notifiche`).
//
// Il lock è `__tests__/lib/avvisi-promemoria-query.test.ts`, gemello di
// `avvisi-niente-n-piu-uno`: conta le `from(…)` con 3 avvisi e 200 famiglie e
// verifica che il numero NON cambi aggiungendo una famiglia.
// =============================================================================

const MS_GIORNO = 86_400_000

/** Il ripiego quando la sede non ha (ancora) scritto la sua configurazione. */
const GIORNI_DEFAULT = DEFAULT_AVVISI_CONFIG.promemoria_giorni_prima

/**
 * LA TOLLERANZA DI QUESTA SCANSIONE È PIÙ LARGA DI `tabellaMancante`, E VA DETTO.
 *
 * `@/lib/db/tolleranza-schema` ammette due codici soli — `42P01`/`PGRST205`,
 * «la TABELLA non c'è» — e rifiuta di proposito `42703`, perché una colonna
 * mancante su una tabella che esiste è una migrazione applicata a metà, cioè un
 * guasto. È la regola giusta, ed è quella che `cron-battito.test.ts` protegge
 * sulle altre tre scansioni: `armadietto_richieste` esiste in produzione, quindi
 * lì un `42703` è un incidente.
 *
 * Qui la situazione è l'OPPOSTA, e per una ragione che ha una data di scadenza:
 * `avvisi.scadenza_adesione` NON ESISTE ANCORA IN NESSUN AMBIENTE. La migrazione
 * `20260919132612_avvisi_scadenze_posti_e_partecipanti.sql` la applica
 * l'integrazione al merge, e il database E2E della CI è un progetto separato che
 * non viene migrato mai (`.claude/rules/migrazioni.md`: «il codice nuovo deve
 * degradare in modo pulito, perché in CI le colonne nuove non esistono —
 * `SELECT` → `42703`»). Senza questa tolleranza la CI diventerebbe rossa su un
 * difetto che non c'è, e il cron risponderebbe 500 ogni notte fino al deploy.
 *
 * ⚠️ E NON DIVENTA SILENZIO: chi tollera qui torna `saltata: true`, la route
 * mette `adesioni` fra le `saltate` e il battito chiude `ok-parziale` NOMINANDO
 * la scansione. Se quella riga comparisse in PRODUZIONE dopo il deploy, sarebbe
 * un buco vero — e si legge, non si indovina.
 */
const CODICI_COLONNA_ASSENTE: ReadonlySet<string> = new Set([
  '42703', // Postgres, SELECT: «column … does not exist»
  'PGRST204', // PostgREST, INSERT/UPDATE: colonna sconosciuta allo schema cache
])

function schemaNonAncoraMigrato(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false
  return tabellaMancante(error) || CODICI_COLONNA_ASSENTE.has(error.code ?? '')
}

/**
 * PostgREST NON LANCIA: ritorna `{ error }` (regola 7 di AGENTS.md). La route che
 * chiama questa scansione la avvolge in un `try/catch` che logga — quindi la via
 * più corta perché l'errore di una query finisca in quel log è TRASFORMARLO in un
 * throw. Stessa forma, e stesso motivo, di `seFallita` in
 * `src/app/api/notifiche/promemoria/route.ts`: la `cause` non è decorativa,
 * `descriviErrore` la segue di un livello ed è da lì che la riga prende `code`,
 * `details` e `hint`. `PGRST301` non dice nulla, `PGRST301 "JWT expired"` dice tutto.
 */
function seFallita(error: { code?: string; message?: string } | null | undefined, azione: string): void {
  if (!error) return
  throw new Error(`promemoria-adesioni: ${azione} fallita`, { cause: error })
}

/**
 * «MANCANO N GIORNI», CONTATI IN GIORNI CIVILI ITALIANI.
 *
 * 🔴 QUESTO È IL PUNTO IN CUI LA FUNZIONE SI ROMPE SE SCRITTA COME VIENE
 * NATURALE. pg_cron schedula in **UTC**: `0 6 * * *` sono le 07:00 italiane
 * d'inverno e le 08:00 d'estate, e il giro può slittare. Con
 * `Math.floor((scadenza - adesso) / 86_400_000)` la stessa scadenza vale «2»
 * quando il giro parte alle 23:00 e «3» quando parte all'01:00 — cioè il
 * promemoria parte una notte sì e una no, o non parte affatto, a seconda
 * dell'ora. La domanda che la segreteria pone non è «quante volte 24 ore ci
 * stanno in mezzo»: è «quante albe mancano».
 *
 * Perciò si passa dai GIORNI CIVILI: `dataCivile` porta i due istanti al loro
 * `YYYY-MM-DD` romano, `inizioGiornoCivile` li riporta ai due mezzanotte, e la
 * differenza si misura fra quelle.
 *
 * ⚠️ `Math.round` E NON UNA DIVISIONE SECCA, e non è prudenza: nei due giorni in
 * cui l'ora cambia due mezzanotte consecutive distano **23 o 25 ore**, non 24.
 * Una divisione intera renderebbe `0` la vigilia del cambio d'ora — un giorno
 * all'anno in cui il promemoria dell'ultimo giorno arriva come quello di oggi, e
 * viceversa. È lo stesso calendario di `__tests__/lib/confini-giorno.test.ts`,
 * che quei due giorni li ha già fissati.
 *
 * `null` = «non c'è una scadenza utilizzabile»: colonna vuota o istante
 * illeggibile. Chi chiama le tratta allo stesso modo, e lo dichiara in un log.
 */
/**
 * `YYYY-MM-DD` + N giorni, sul calendario. L'aritmetica si fa in **UTC** apposta:
 * un giorno UTC dura sempre 86.400.000 ms, quindi «+7 giorni» è esatto anche
 * quando in mezzo c'è un cambio d'ora — mentre `istante + 7 × 86.400.000` letto
 * a Roma cade sul giorno SBAGLIATO nelle due settimane in cui un giorno civile
 * dura 23 o 25 ore. Qui non si rappresenta un istante: si conta sul calendario,
 * e il fuso rientra un attimo dopo con `fineGiornoCivile`.
 */
function giornoCivilePiu(ymd: string, giorni: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + giorni * MS_GIORNO
  return new Date(t).toISOString().slice(0, 10)
}

export function giorniCiviliMancanti(scadenzaISO: string | null | undefined, adessoISO: string): number | null {
  if (!scadenzaISO) return null
  const scadenza = new Date(scadenzaISO)
  const adesso = new Date(adessoISO)
  // `Intl.DateTimeFormat.format` su una Date invalida LANCIA (`RangeError`), e
  // `dataCivile` la chiama senza rete: il controllo va fatto prima, o una riga
  // storta del database farebbe morire l'intera scansione invece di saltare
  // l'avviso che la contiene.
  if (Number.isNaN(scadenza.getTime()) || Number.isNaN(adesso.getTime())) return null

  const mezzanotteOggi = inizioGiornoCivile(dataCivile(adesso))
  const mezzanotteScadenza = inizioGiornoCivile(dataCivile(scadenza))
  if (mezzanotteOggi === null || mezzanotteScadenza === null) return null

  return Math.round((Date.parse(mezzanotteScadenza) - Date.parse(mezzanotteOggi)) / MS_GIORNO)
}

/**
 * Il testo che il genitore legge sul telefono. Resta in ITALIANO e resta qui: la
 * testata di `@/lib/notifiche/tipi` lo dice per tutte — i CORPI delle notifiche
 * persistite non si traducono nel catalogo, che traduce solo le etichette del
 * pannello Impostazioni.
 *
 * I tre rami esistono perché «Mancano 1 giorni» e «Mancano 0 giorni» sono due
 * modi di far capire a una famiglia che il messaggio l'ha scritto una macchina.
 */
export function corpoPromemoria(mancano: number, titolo: string): string {
  if (mancano <= 0) return `Ultimo giorno per aderire a «${titolo}».`
  if (mancano === 1) return `Manca 1 giorno per aderire a «${titolo}».`
  return `Mancano ${mancano} giorni per aderire a «${titolo}».`
}

/**
 * CHI HA GIÀ RISPOSTO, TUTTI QUANTI — la lettura che non si può troncare.
 *
 * 🔴 Una pagina persa qui non produce un numero più basso: produce un SOLLECITO
 * SPEDITO A CHI HA GIÀ ADERITO. Non è un dato mancante, è un dato falso mandato
 * a una famiglia, ed è il motivo per cui l'incompletezza qui **lancia** invece di
 * degradare: meglio una scansione che si dichiara caduta (500, `giro-incompleto`)
 * che una che manda messaggi sbagliati dichiarando «ok». PostgREST tronca eccome:
 * su Supabase `db-max-rows` vale 1000 di default, e il `count: 'exact'` è il
 * totale VERO lato server, indipendente dal troncamento.
 *
 * ⚠️ E «MEGLIO LANCIARE CHE DEGRADARE» ERA UNA PROMESSA MAI VISTA FALLIRE. Fino
 * al 2026-09-19 nessun test percorreva una seconda pagina: ogni scenario stava
 * sotto le 1.000 righe, quindi il ciclo usciva sempre al primo giro e i tre
 * `throw` erano codice mai eseguito. Adesso due dei tre sono pinnati, e lo sono
 * su asserzioni diverse apposta:
 *
 *   · la seconda pagina ......... `__tests__/lib/avvisi-promemoria-query.test.ts`
 *     (1.500 risposte, 1.600 famiglie → 100 invii: perdendo la pagina ne
 *     partirebbero 600, cioè 500 solleciti a chi ha GIÀ aderito);
 *   · la pagina VUOTA col totale ancora alto →
 *     `__tests__/api/avvisi-promemoria-adesioni.test.ts`, dove si osserva il 500
 *     e il battito `giro-incompleto` con zero invii.
 *
 * ⚠️ E IL TERZO ERA DICHIARATO SCOPERTO CON UNA RAGIONE SBAGLIATA. Questa
 * docstring diceva, fino al 2026-09-19: «resta scoperto il tetto di `MAX_PAGINE`,
 * per esercitarlo servono 20.000 righe di finto». Non era vero, e il fatto che
 * nessuno l'abbia riletta è l'unica ragione per cui è rimasta: i due numeri non
 * sono cablati qui dentro, sono **importati** da `@/lib/avvisi/statistiche`.
 * Bastano quindi `vi.mock('@/lib/avvisi/statistiche', () => ({ MAX_PAGINE: 2,
 * RIGHE_PER_PAGINA: 2 }))` e CINQUE righe di risposte perché il ciclo esca dal
 * `for` senza aver coperto il totale. Un debito dichiarato con una motivazione
 * falsa è peggio di un debito taciuto: chiude la discussione invece di aprirla.
 *
 *   · il tetto di pagine ....... `__tests__/lib/avvisi-promemoria-tetto-pagine.test.ts`
 *     (MAX_PAGINE=2, RIGHE_PER_PAGINA=2, 5 risposte → la scansione LANCIA; con 4
 *     risposte, che il tetto copre, torna l'insieme completo).
 *
 * I tre punti d'uscita hanno adesso un test ciascuno.
 *
 * ⚠️ DEBITO DICHIARATO, E NON È UN DETTAGLIO DI STILE. Questa paginazione è la
 * GEMELLA di `leggiTutte` in `@/lib/avvisi/statistiche` — stessa regola, stesso
 * `count: 'exact'`, stesso avanzamento per `data.length`, e gli stessi due numeri
 * (`RIGHE_PER_PAGINA`, `MAX_PAGINE`) IMPORTATI da lì, così che almeno le
 * costanti non possano divergere. Non la si è riusata perché `leggiTutte` non è
 * esportata e il suo file appartiene a un altro cantiere di questo branch, che lo
 * ha già consegnato. **Il seguito è una riga sola**: esportare `leggiTutte` e
 * cancellare questa funzione. Finché non succede, chi corregge un difetto di
 * paginazione lo corregge in DUE posti — ed è esattamente la forma di guasto che
 * questo repo ha già pagato con `tabellaMancante` scritta tre volte.
 */
async function parentIdsCheHannoRisposto(supabase: SupabaseClient, avvisoId: string): Promise<Set<string>> {
  const out = new Set<string>()
  let letto = 0

  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const { data, count, error } = await supabase
      .from('avvisi_risposte')
      .select('parent_id', { count: 'exact' })
      .eq('avviso_id', avvisoId)
      .not('risposta', 'is', null)
      .range(letto, letto + RIGHE_PER_PAGINA - 1)
    seFallita(error as { code?: string; message?: string } | null, 'lettura avvisi_risposte (chi ha già risposto)')

    const pezzo = (data ?? []) as Array<{ parent_id?: unknown }>
    for (const r of pezzo) if (typeof r.parent_id === 'string' && r.parent_id !== '') out.add(r.parent_id)
    letto += pezzo.length

    const totale = count ?? letto
    if (letto >= totale) return out
    // Pagina vuota con il totale ancora più alto: continuare girerebbe a vuoto, e
    // l'insieme che si porta a casa è INCOMPLETO. Vedi il riquadro qui sopra.
    if (pezzo.length === 0) {
      throw new Error(`promemoria-adesioni: lettura avvisi_risposte incompleta (pagina vuota, letti ${letto} su ${totale})`)
    }
  }

  throw new Error(`promemoria-adesioni: lettura avvisi_risposte troncata al tetto di ${MAX_PAGINE} pagine`)
}

export interface EsitoPromemoriaAdesioni {
  /** Quante notifiche di promemoria sono state accodate (per DESTINATARIO). */
  inviati: number
  /** `true` = non ho guardato: lo schema di questo ambiente non ha le colonne A2. */
  saltata: boolean
}

/**
 * LA SCANSIONE. Torna il contatore e il terzo stato; NON logga il proprio battito
 * (lo fa la route, insieme a quello delle altre tre) e NON inghiotte gli errori:
 * un guasto di lettura risale come eccezione al `try/catch` del chiamante, che lo
 * registra come `scansione-fallita` e chiude il giro con `giro-incompleto`.
 *
 * `adessoISO` arriva dal chiamante e non da un `new Date()` sparso qui dentro: è
 * ciò che permette di provare la scansione senza congelare l'orologio dell'intera
 * suite, ed è ciò che garantisce che TUTTI i confronti di un giro usino lo stesso
 * istante invece di uno leggermente diverso per ciascun avviso. Stesso contratto
 * di `risolviScadenze` in `@/lib/avvisi/scadenze`.
 */
export async function promemoriaAdesioni(
  supabase: SupabaseClient,
  adessoISO: string = new Date().toISOString(),
): Promise<EsitoPromemoriaAdesioni> {
  const adesso = Date.parse(adessoISO)

  // ── A. UNA sola lettura di `admin_settings`, per TUTTE le sedi ──────────────
  //
  // Non `getModuleConfig` per sede: quella funzione fa una query per `scuola_id`,
  // e chiamata dentro il ciclo degli avvisi rimetterebbe in piedi la N+1 che la
  // scansione dei moduli qui accanto si porta dietro da sempre (lì è mitigata da
  // una cache locale, qui non serve nemmeno quella).
  const { data: righeCfg, error: errCfg } = await supabase
    .from('admin_settings')
    .select('scuola_id, avvisi_config')
  if (errCfg) {
    if (!schemaNonAncoraMigrato(errCfg)) {
      seFallita(errCfg as { code?: string; message?: string }, 'lettura admin_settings (avvisi_config)')
    }
    return { inviati: 0, saltata: true }
  }

  const giorniPerSede = new Map<string, number>()
  for (const r of (righeCfg ?? []) as Array<{ scuola_id?: unknown; avvisi_config?: unknown }>) {
    if (typeof r.scuola_id !== 'string') continue
    const cfg = (r.avvisi_config ?? {}) as { promemoria_giorni_prima?: unknown }
    const n = Number(cfg.promemoria_giorni_prima ?? GIORNI_DEFAULT)
    giorniPerSede.set(r.scuola_id, Number.isFinite(n) ? n : GIORNI_DEFAULT)
  }

  // ⚠️ `GIORNI_DEFAULT` ENTRA NEL MASSIMO ANCHE SE NESSUNA SEDE LO USA, e non è
  // una svista: una sede può non avere affatto una riga in `admin_settings` (è
  // successo davvero — Aversa e Cesa sono nate con `avvisi_config = {}`), e i
  // suoi avvisi devono comunque rientrare nella finestra grossolana, o il
  // ripiego applicato più sotto non avrebbe nulla su cui applicarsi.
  const nMax = Math.max(GIORNI_DEFAULT, ...giorniPerSede.values())

  // ── B. UNA sola lettura degli avvisi in finestra ───────────────────────────
  //
  // 🔴 `nMax` È SOLO UN FILTRO GROSSOLANO, MAI LA SOGLIA. Serve a non trascinare
  // dal database gli avvisi che nessuna sede potrebbe mai voler sollecitare; la
  // soglia VERA è il `giorni` della sede DI QUELL'AVVISO, riapplicato in memoria
  // poche righe più sotto. Con tre sedi e tre configurazioni diverse, usare
  // `nMax` come soglia significa mandare il promemoria della sede da 7 giorni
  // anche alle famiglie della sede da 3 — un messaggio giusto nel posto
  // sbagliato, che nessun test a sede singola può vedere. È la riga che un
  // successore «semplificherà»: il test delle due sedi (3 e 7) esiste per quello.
  //
  // `.gte` sul confine basso: si guardano solo gli avvisi ANCORA APERTI, e
  // «aperto» qui vuol dire che la scadenza NON è ancora passata.
  //
  // ⚠️ QUESTA RIGA È IL QUARTO PEZZO DELLO STESSO GEMELLO, CON LO STESSO
  // OPERATORE. La regola è arbitrata in `@/lib/avvisi/scadenze` — «la scadenza è
  // l'ultimo istante valido, INCLUSO» — e quel riquadro elenca i posti in cui
  // vive e ordina a chi ne cambia uno di cambiarli tutti:
  //
  //   1. `avvisoScaduto()` ........................  `adesso >  scadenza`
  //   2. la RPC `avviso_adesione_registra` ........  `v_ora  >  v_termine`
  //   3. il filtro del feed .......................  `.gte(…)`, **mai** `.gt`
  //   4. questa riga ..............................  `.gte(…)`
  //
  // Era scritta `.gt`, cioè con l'operatore proibito, e il commento che la
  // giustificava dichiarava una divergenza fra TypeScript e RPC che era GIÀ
  // stata chiusa il 2026-09-19 — attribuendo ad `avvisoScaduto` un «ramo
  // istante: `adesso >= scadenza`» che in quel file non c'è più. Un file che
  // spiega sé stesso con un fatto falso è peggio di un file che tace: è il
  // difetto che questo repo si porta dietro da mesi, ed è per questo che la
  // riga è stata allineata invece che annotata.
  //
  // L'effetto pratico è un millisecondo — all'istante esatto della scadenza
  // l'avviso entra ancora nella finestra, e il ramo in memoria qui sotto lo
  // conta come «Ultimo giorno per aderire», che è esattamente ciò che la RPC
  // permette ancora di fare. Per un giro notturno è invisibile; a contare è che
  // i quattro posti dicano la stessa cosa.
  //
  // 🔴 E IL CONFINE ALTO È LA FINE DI UN GIORNO CIVILE, NON «ADESSO + N × 24 ORE».
  // La prima scrittura di questa riga era `new Date(adesso + nMax * MS_GIORNO)`,
  // e il test l'ha trovata SBAGLIATA prima che arrivasse in produzione: il giro
  // parte alle 07:00 italiane, una scadenza «fra 3 giorni civili» sta alle 18:00
  // del terzo giorno, e 3 × 24 ore dalle 07:00 finiscono alle 07:00 — undici ore
  // PRIMA. Il filtro grossolano tagliava fuori esattamente gli avvisi che la
  // soglia voleva dentro, e lo faceva in silenzio: contatore a zero, battito
  // «ok». Un filtro di comodo non può mai essere più STRETTO della regola che
  // deve solo aiutare.
  //
  // ⚠️ E IL SUO LOCK È UN `it` TUTTO SUO — «il confine ALTO è la FINE del giorno
  // civile», in `__tests__/api/avvisi-promemoria-adesioni.test.ts`. Prima era
  // pinnato solo dal test «scadenza SPOSTATA IN AVANTI», che è lo STESSO che
  // pinna il cutoff della deduplica: due difetti diversi difesi da una sola
  // asserzione, cioè uno solo dei due protetto il giorno in cui qualcuno
  // «aggiusta» quel test.
  const oggi = dataCivile(new Date(adesso))
  const giornoLimite = giornoCivilePiu(oggi, nMax)
  const limite = (giornoLimite && fineGiornoCivile(giornoLimite)) ?? new Date(adesso + (nMax + 2) * MS_GIORNO).toISOString()
  const { data: avvisi, error: errAvvisi } = await supabase
    .from('avvisi')
    .select('id, titolo, scuola_id, target_scope, target_classes, scadenza_adesione')
    .eq('tipo', 'adesione')
    .not('scadenza_adesione', 'is', null)
    .gte('scadenza_adesione', adessoISO)
    .lte('scadenza_adesione', limite)
  if (errAvvisi) {
    if (!schemaNonAncoraMigrato(errAvvisi)) {
      seFallita(errAvvisi as { code?: string; message?: string }, 'lettura avvisi di adesione in scadenza')
    }
    return { inviati: 0, saltata: true }
  }

  let inviati = 0
  let senzaScadenza = 0

  for (const avviso of (avvisi ?? []) as Array<{
    id: string
    titolo: string
    scuola_id: string | null
    target_scope: string | null
    target_classes: string[] | null
    scadenza_adesione: string | null
  }>) {
    // Il gemello IN MEMORIA del `.not('scadenza_adesione','is',null)` qui sopra, e
    // non è un doppione inutile: `scadenza_adesione` è obbligatoria sugli avvisi
    // di adesione solo DOPO la migrazione di irrigidimento (che è un'altra PR), e
    // fino ad allora un avviso storico mai backfillato può esistere. Se una riga
    // così arrivasse fin qui, `giorniCiviliMancanti` renderebbe `null` e senza
    // questo ramo il corpo direbbe «Mancano NaN giorni». Si salta, e si CONTA:
    // il silenzio su un avviso che non verrà mai sollecitato è il guasto che
    // questa route intera esiste per non ripetere.
    const mancano = giorniCiviliMancanti(avviso.scadenza_adesione, adessoISO)
    if (mancano === null) {
      senzaScadenza += 1
      continue
    }

    const giorni = giorniPerSede.get(avviso.scuola_id ?? '') ?? GIORNI_DEFAULT
    if (giorni <= 0) continue // 0 = promemoria disattivato per quella sede
    // La soglia VERA, per sede. `mancano < 0` non dovrebbe arrivare (il `.gte` lo
    // esclude) ma resta scritto: fra la query e questo confronto passa il tempo
    // di una lettura, e un avviso che scade stanotte può attraversarlo.
    if (mancano < 0 || mancano > giorni) continue

    // ── C. Destinatari, identici alla pubblicazione ─────────────────────────
    const classi = (avviso.target_classes ?? []).filter(Boolean)
    const globale = (avviso.target_scope ?? 'globale') === 'globale' || classi.length === 0
    const target = globale
      ? await genitoriDiScuola(supabase, avviso.scuola_id, { operazione: 'avvisi/promemoria-adesioni' })
      : await genitoriDiClassi(supabase, avviso.scuola_id, classi, { operazione: 'avvisi/promemoria-adesioni' })
    if (target.length === 0) continue

    // ── D. Chi ha già risposto — `si` O `no`, indifferentemente ─────────────
    //
    // Il filtro è `risposta IS NOT NULL`, non `risposta = 'si'`: sollecitare chi
    // ha già scritto «no» non è un promemoria, è insistere. Una famiglia che ha
    // detto di no ha già fatto la sua parte, e il sistema che glielo richiede
    // ogni notte le insegna a spegnere le notifiche della scuola.
    const giaRisposto = await parentIdsCheHannoRisposto(supabase, avviso.id)

    // ── E. La DEDUPLICA, che è questa query e nessun'altra ──────────────────
    //
    // 🔴 `debounce: true` NON SERVE A QUESTO, E INFATTI NON C'È. Il debounce di
    // `notificaEvento` cancella le notifiche PENDING con lo stesso `tipo` +
    // `entita_id` e poi riaccoda: serve a far collassare una RAFFICA dentro la
    // finestra di buffer. Questo promemoria parte con `bufferMin: 0`, quindi una
    // riga pending da collassare non esiste mai — e al giro della notte dopo ne
    // nascerebbe comunque una nuova, perché il debounce guarda la coda, non lo
    // storico. Metterlo SEMBREREBBE una deduplica e non lo sarebbe: la finta
    // protezione che copre l'assenza di quella vera.
    //
    // La deduplica vera è questa lettura, con la finestra di `giorni` giorni: chi
    // ha già ricevuto il sollecito di QUESTO avviso in quella finestra non lo
    // riceve una seconda volta. E il `.gte('creato_il', cutoff)` è la riga che la
    // rende tale: toglierlo non fa fallire nessun tipo, fa partire lo stesso
    // sollecito ogni notte — il modo più rapido di insegnare a una famiglia a
    // ignorare le notifiche della scuola.
    //
    // NON ESISTE UN TERZO STRATO, e va detto perché. L'armadietto marca un flag
    // sulla riga della richiesta (`promemoria_inviato_il`); qui la riga di chi
    // NON ha risposto **non esiste**, e crearla vorrebbe dire fabbricare righe
    // vuote dentro una tabella di consensi di minori per ospitare una bandierina
    // d'invio. La colonna `notifiche.creato_il` quella data ce l'ha già.
    //
    // 🔴 `giorni + 1`, E IL `+1` È IL MARGINE — non un arrotondamento. Con la
    // finestra larga ESATTAMENTE `giorni` giorni, la deduplica dura quanto
    // l'intervallo fra un giro e il successivo: margine ZERO, e lo sbordo cade
    // dal lato sbagliato. Il margine reale sarebbe solo il δ fra il `new Date()`
    // di questa scansione e l'`INSERT` (`notifiche.creato_il` è `DEFAULT now()`),
    // mentre `adessoISO` si prende DOPO le altre tre scansioni, la cui durata
    // varia di secondi ogni notte. Misurato prima della correzione, non dedotto:
    // `giorni=1` con due giri a 24 h + 30 s → DUE notifiche; `giorni=3` con
    // quattro giri e un millisecondo di ritardo → esiti `[1,0,0,1]`. Cioè una
    // moneta lanciata su ogni avviso, all'ultimo giro — quello che dice «Ultimo
    // giorno per aderire». I due test stanno in
    // `__tests__/api/avvisi-promemoria-adesioni.test.ts`.
    //
    // 🔴 MA QUEI DUE TEST NON PINNANO PIÙ IL `+1`, E VA SCRITTO QUI. La misura
    // sopra è del codice che contava in MILLISECONDI (`adesso - (giorni+1) ×
    // 86.400.000`): lì trenta secondi di ritardo spostavano il cutoff e il
    // doppione usciva. Da quando il cutoff è un GIORNO CIVILE
    // (`inizioGiornoCivile`), quei trenta secondi non spostano più niente —
    // verificato: togliendo il `+1` entrambi i test restano VERDI. Difendono il
    // calendario, non il margine.
    //
    // Il `+1` si vede solo dove la finestra finisce: quando fra il sollecito
    // precedente e oggi sono passati ESATTAMENTE `giorni + 1` giorni civili. Con
    // `giorni+1` quel sollecito è ancora dentro e non si ripete; con `giorni`
    // secco è già fuori e riparte — un secondo messaggio alla stessa famiglia
    // sullo stesso avviso. È il test «🔴 il MARGINE: il sollecito di `giorni + 1`
    // giorni civili fa è ANCORA dentro la finestra» nello stesso file, che senza
    // il `+1` diventa rosso.
    //
    // ⚠️ E IL VERSO OPPOSTO HA UN TETTO: la finestra deve restare più STRETTA
    // dello spostamento che riapre legittimamente il sollecito, o una scadenza
    // rinviata dalla segreteria non avviserebbe più nessuno. Il test «scadenza
    // SPOSTATA IN AVANTI» sposta di 8 giorni con `giorni = 3`: `giorni + 1 = 4`
    // ci sta dentro, `giorni + 8` no. Chi allarga ancora questo margine lo
    // verifichi lì.
    //
    // Stesso CALENDARIO del confine alto, e per la stessa ragione: questo modulo
    // denuncia per tre riquadri l'aritmetica `× 86.400.000`, e usarla proprio
    // sulla riga che È la garanzia dell'invio unico sarebbe la peggiore delle
    // incoerenze. `inizioGiornoCivile` porta al primo istante del giorno civile
    // italiano; l'aritmetica in millisecondi resta solo come ripiego per una data
    // illeggibile, dove qualunque cutoff è meglio di nessun cutoff.
    const giornoCutoff = giornoCivilePiu(oggi, -(giorni + 1))
    const cutoff = (giornoCutoff && inizioGiornoCivile(giornoCutoff))
      ?? new Date(adesso - (giorni + 1) * MS_GIORNO).toISOString()
    const { data: recenti, error: errRecenti } = await supabase
      .from('notifiche')
      .select('utente_id')
      .eq('tipo', 'adesione_promemoria')
      .eq('entita_id', avviso.id)
      .gte('creato_il', cutoff)
    seFallita(errRecenti as { code?: string; message?: string } | null, 'lettura notifiche già inviate (adesioni)')
    const giaRicordati = new Set(
      ((recenti ?? []) as Array<{ utente_id?: unknown }>)
        .map((n) => n.utente_id)
        .filter((id): id is string => typeof id === 'string'),
    )

    const destinatari = target.filter((uid) => !giaRisposto.has(uid) && !giaRicordati.has(uid))
    if (destinatari.length === 0) continue

    // ⚠️ IL TITOLO DELL'AVVISO STA NEL CORPO DELLA NOTIFICA, e ci sta bene: è il
    // testo che il genitore legge sul telefono, non una riga di log. Sotto, nei
    // `logEvento`, passano solo conteggi.
    //
    // `entitaTipo: 'avviso'` NON è decorativo: è il RITIRO GRATUITO. La
    // cancellazione di un avviso (`DELETE /api/avvisi/[id]`) toglie le notifiche
    // filtrando proprio su `entita_tipo = 'avviso'` + `entita_id`, quindi un
    // promemoria di un avviso cancellato sparisce anche dalla campanella senza
    // che questo modulo debba saperne niente. È verificato da un test, non dato
    // per scontato.
    await notificaEvento(supabase, {
      tipo: 'adesione_promemoria',
      scuolaId: avviso.scuola_id,
      utenteIds: destinatari,
      titolo: 'Adesione in scadenza',
      corpo: corpoPromemoria(mancano, avviso.titolo),
      link: '/parent/avvisi',
      entitaTipo: 'avviso',
      entitaId: avviso.id,
      bufferMin: 0,
    })
    inviati += destinatari.length
  }

  if (senzaScadenza > 0) {
    // `warn` e non `info`: il canale `avvisi` persiste i `warn` per livello, ed è
    // l'unico posto da cui si può sapere che esistono avvisi di adesione che
    // nessun promemoria raggiungerà mai. Solo un CONTEGGIO: nessun titolo,
    // nessun uuid di famiglia.
    logEvento('avvisi', 'warn', {
      operazione: 'avvisi/promemoria-adesioni',
      esito: 'adesione-senza-scadenza',
      n: senzaScadenza,
    })
  }

  return { inviati, saltata: false }
}
