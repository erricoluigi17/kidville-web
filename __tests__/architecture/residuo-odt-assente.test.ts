import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * LOCK · sotto `src/` non deve restare niente delle due tabelle morte: né la MACCHINA
 * che le rifà, né — dal 2026-08-16, terza passata — la loro semplice lettura.
 *
 * ─── COSA ERA ───────────────────────────────────────────────────────────────────
 *
 * Una linguetta di `/admin/modulistica` prometteva alla Segreteria di caricare la carta
 * intestata della scuola in un formato di documento aperto. Era un mockup, e in modo
 * misurabile: i tre `onChange` salvavano il NOME del file scelto in uno `useState` e basta
 * — nessun caricamento, nessuna riga nel database, nessuno storage — e il badge verde
 * spariva al primo aggiornamento della pagina. Chi ci aveva trascinato dentro la carta
 * intestata credeva di averla consegnata al prodotto. La carta vera, da questo ramo, arriva
 * dal motore dei Prestampati (`src/lib/carta/`).
 *
 * Accanto, nella stessa schermata, la linguetta «Sala d'Attesa» leggeva `pre_inscriptions`.
 * È stata smontata lo stesso giorno: le domande di iscrizione si leggono da «Moduli
 * ricevuti», e quel pannello duplicava un lavoro che c'era già.
 *
 * ─── LA TERZA VOLTA, ED È QUELLA CHE PESAVA ─────────────────────────────────────
 *
 * Tolto il pannello, era rimasta in piedi la sua ROTTA INTERA
 * (`src/app/api/admin/pre-inscriptions/route.ts`), e la metà rimasta era quella
 * pericolosa: il `POST` era **pubblico e senza gate** — nessun `requireStaff`, nessun
 * tetto per IP, nessun honeypot — e accettava codice fiscale e indirizzo del genitore
 * più i dati dei figli. Falliva chiuso solo perché la tabella non c'è, e nel fallire
 * rimandava all'anonimo il messaggio di PostgREST verbatim, cioè il nome della
 * relazione mancante. Il `PATCH`, dall'altra parte, creava account auth e restituiva
 * una password in chiaro.
 *
 * Era la stessa classe di guasto del punto 2 qui sotto — «una rete tesa attorno a UN
 * CASO lascia passare il caso gemello» — applicata al livello sopra: chiusa la DDL,
 * restava la porta. E la difesa era la stessa che questo file rifiutava dieci righe
 * più giù per l'altro blocco: «tanto la tabella non esiste». *«Inerte» non basta a
 * giustificare la permanenza di una macchina che ricrea; non basta nemmeno per una
 * porta anonima che scrive.*
 *
 * La rotta è stata CANCELLATA il 2026-08-16. Aveva **zero chiamanti**: misurato con
 * `grep -rn "admin/pre-inscriptions" src/ __tests__/ e2e/ public/ scripts/` — solo la
 * rotta stessa, dei test e dei commenti, nessuna `fetch`. Il portale che la usava non
 * esiste più (`/onboarding` è un `redirect('/iscrizione')`) e le domande di iscrizione
 * arrivano da `/api/iscrizione` → `enrollment_submissions`.
 *
 * ─── PERCHÉ IL LOCK, E NON SOLO LA CANCELLAZIONE ────────────────────────────────
 *
 * Perché la cancellazione, DUE VOLTE di fila, non è stata completa e nessuno se n'è accorto.
 *
 * 1. Tolto il tab, la tabella `certificati_templates` è rimasta in `src/`: non come lettura
 *    o scrittura — quelle erano davvero zero, ed è la misura che aveva tranquillizzato tutti
 *    — ma come **`CREATE TABLE`**, dentro il SQL di `admin/apply-fase4-migration`, con
 *    indice, RLS e una `CREATE POLICY … FOR ALL USING (true)`.
 * 2. Scritta quella lezione, è rimasto **nello stesso file** il blocco gemello di
 *    `pre_inscriptions`: CREATE, due indici, RLS e la stessa policy aperta a tutti — cioè la
 *    macchina per rifare una tabella destinata a nome, cognome, email, telefono, codice
 *    fiscale e indirizzo del genitore, più i dati dei figli. Il primo lock non se n'era
 *    accorto perché guardava un NOME invece della classe del guasto.
 *
 * La lezione che questo file mette per iscritto, e la seconda che le dà il senso:
 *   • **«zero righe la leggono» non è «zero righe la nominano»**: un residuo che CREA è più
 *     vivo di uno che legge;
 *   • una rete tesa attorno a UN CASO lascia passare il caso gemello che sta nove righe
 *     sotto. Qui la rete è tesa attorno alla **classe**: la DDL che resuscita una tabella che
 *     la produzione non ha.
 *
 * ─── LA MISURA SU CUI POGGIA ────────────────────────────────────────────────────
 *
 * In produzione nessuna delle due tabelle esiste, e non è un'opinione (2026-08-16):
 *   to_regclass('public.certificati_templates') → null · 0 oggetti in qualunque schema
 *   to_regclass('public.pre_inscriptions')      → null · 0 oggetti in qualunque schema
 * Non c'è quindi nessun `DROP TABLE` da applicare: non c'è mai stato niente da droppare.
 * L'unico posto dove le due tabelle esistevano ancora era questo repo.
 *
 * ─── IL CONFINE DI QUESTO LOCK, DETTO INVECE CHE SOTTINTESO ─────────────────────
 *
 * Sotto `src/` restano **13 `CREATE TABLE`** in altre cinque route `apply-*-migration`, e
 * questo lock NON le vieta. Non è una svista: le sei tabelle che nominano (`forms_templates`,
 * `forms_submissions`, `certificati_medici`, `registro_orario`, `mensa_menu_config`,
 * `enrollment_submissions`) **esistono davvero in produzione** — misurato lo stesso giorno,
 * `to_regclass` non-null per tutte e sei. Il loro `CREATE TABLE IF NOT EXISTS` è ridondante,
 * non è una resurrezione. Che quelle route esistano ancora resta un debito, ed è scritto qui
 * perché un confine taciuto è il modo in cui un lock ricomincia a promettere più di quanto
 * misura.
 *
 * ─── COME SI RIMISURA A MANO (e deve dare la STESSA risposta) ───────────────────
 *
 *   grep -rniE 'certificati_templates|\bodt\b|vnd\.oasis\.opendocument|pre_inscriptions' src/
 *
 * → **zero righe**. Verificato su `grep` di macOS (BSD) il 2026-08-16: `\b` è supportato.
 * Questa riga esiste perché la prima versione del lock prometteva «dei template non deve
 * restare NIENTE» e vietava tre parole: chi rimisurava a mano trovava due righe di rosso
 * dove l'automazione diceva verde, e non sapeva a quale credere. **Un lock che pretende una
 * cosa diversa da quella che il grep misura è un lock che litiga con chi lo controlla.**
 *
 * ⚠️ Il divieto vale anche per i COMMENTI, e la scelta è stata pesata: l'esenzione della
 * prosa sarebbe stata più gentile — si spiega meglio ciò che si può nominare — ma renderebbe
 * il criterio impossibile da verificare a mano. Quindi i nomi esatti vivono **qui**, in
 * questo file, che è il posto dove si va a cercare il perché; là dove il blocco è stato tolto
 * si scrive in italiano che cosa c'era e si rimanda a questo lock. Cancellare non è
 * nascondere, se resta scritto dove.
 */

const RADICE = process.cwd()

/**
 * Le tracce che, sotto `src/`, non devono più comparire — e perché.
 *
 * Le due tabelle, l'estensione che il campo di caricamento accettava, il tipo MIME che gli
 * faceva da filtro, l'acronimo che li nominava.
 */
const RESIDUI_VIETATI: readonly { nome: string; pattern: RegExp; motivo: string }[] = [
  {
    nome: 'il nome della tabella dei modelli di certificato',
    pattern: /certificati_templates/,
    motivo:
      'non esiste in produzione e nessuno la legge — se ricompare, ricompare la macchina che la crea',
  },
  {
    nome: "l'acronimo del formato, e l'estensione dei tre campi del mockup",
    // `\b…\b` e non la sottostringa: misurato sui 998 sorgenti, la sottostringa prende 63
    // righe innocenti (`modToast…`, `ModelloElencoDTO`, `z.ZodType`, e persino un blocco
    // base64 in `src/lib/protocolli/assets.ts`), la parola ne prende zero. Un lock che
    // diventa rosso su `z.ZodType` non lo tiene acceso nessuno.
    pattern: /\bodt\b/i,
    motivo:
      'la carta intestata vera è un PDF e vive in `src/lib/carta/asset/`; il formato del ' +
      'mockup non deve restare nominato da nessuna parte sotto `src/`, nemmeno in prosa — ' +
      'è la sola forma in cui il criterio a mano e questo lock danno la stessa risposta',
  },
  {
    nome: 'il tipo MIME che filtrava il caricamento',
    pattern: /vnd\.oasis\.opendocument/i,
    motivo: 'filtrava il caricamento che non caricava niente',
  },
  {
    nome: 'il nome della tabella delle pre-iscrizioni, in qualunque forma',
    // PROMOSSO il 2026-08-16 da «niente DDL» a «niente affatto», che è la riga che la
    // versione precedente di questo file si era già scritta per il giorno in cui la
    // rotta fosse sparita. È sparita, e il divieto vale ora anche per le LETTURE:
    // `.from('pre_inscriptions')` non ha più nessun chiamante da proteggere, e
    // un'esenzione che nessuno invoca è solo un posto tenuto caldo per il prossimo.
    pattern: /pre_inscriptions/i,
    motivo:
      'la tabella non esiste in produzione e nessuna schermata la nomina più. CREATE/INDEX/' +
      'RLS/POLICY la ricreerebbero — destinata a nome, cognome, email, telefono, codice ' +
      "fiscale e indirizzo del genitore più i dati dei figli, con una policy `FOR ALL USING " +
      "(true)` — e una LETTURA `.from('pre_inscriptions')` è la traccia della rotta anonima " +
      'che è stata cancellata: chi la riscrive riapre la porta insieme alla query',
  },
]

function sorgenti(): string[] {
  const trovati: string[] = []
  const cammina = (dir: string) => {
    for (const voce of readdirSync(dir)) {
      const percorso = join(dir, voce)
      if (statSync(percorso).isDirectory()) cammina(percorso)
      else if (/\.(ts|tsx)$/.test(voce)) trovati.push(percorso)
    }
  }
  cammina(join(RADICE, 'src'))
  return trovati
}

const FILE = sorgenti()

/** Le righe di un testo che contengono il residuo, coi loro numeri. */
function righeColResiduo(testo: string, pattern: RegExp): number[] {
  return testo
    .split('\n')
    .map((riga, i) => (pattern.test(riga) ? i + 1 : 0))
    .filter((n) => n > 0)
}

describe('lock architettura · nessun residuo delle due tabelle morte sotto src/', () => {
  it('il lock sta guardando qualcosa: i sorgenti si leggono davvero', () => {
    // Senza questa riga i divieti qui sotto sarebbero verdi su una scansione che non
    // trova nessun file — cioè su niente.
    expect(FILE.length).toBeGreaterThan(500)
  })

  /**
   * Il controllo positivo: un campione di ciò che è stato tolto, riga per riga. Senza, i
   * divieti sarebbero verdi anche con regexp che non prendono niente — cioè su un lock che
   * non vieta. L'ultima riga è il controllo NEGATIVO: codice innocente, che nessuno dei
   * quattro divieti deve toccare.
   */
  const CAMPIONE = [
    /* 1 */ '    CREATE TABLE IF NOT EXISTS certificati_templates (',
    /* 2 */ ' * la tabella dei «Template Certificati ODT» — CREATE, indice, RLS',
    /* 3 */ "    accept: '.odt',",
    /* 4 */ "    type: 'application/vnd.oasis.opendocument.text',",
    /* 5 */ '    CREATE TABLE IF NOT EXISTS pre_inscriptions (',
    /* 6 */ '    CREATE INDEX IF NOT EXISTS idx_pre_inscriptions_scuola ON pre_inscriptions(scuola_id);',
    /* 7 */ '    ALTER TABLE pre_inscriptions ENABLE ROW LEVEL SECURITY;',
    /* 8 */ '    DROP POLICY IF EXISTS "Pre-iscrizioni accessibili a tutti" ON pre_inscriptions;',
    /* 9 */ '    CREATE POLICY "Pre-iscrizioni accessibili a tutti" ON pre_inscriptions FOR ALL USING (true);',
    /* 10 */ "      .from('pre_inscriptions')",
    /* 11 */ '    const nienteDaVedere = 1',
  ].join('\n')

  it('riconosce il residuo dov’era davvero: le due tabelle, la prosa, il campo, il filtro', () => {
    const [tabella, acronimo, mime, preIscrizioni] = RESIDUI_VIETATI.map((r) => r.pattern)
    expect(righeColResiduo(CAMPIONE, tabella)).toEqual([1])
    // la stessa parola nella prosa (riga 2) e nell'estensione del campo (riga 3)
    expect(righeColResiduo(CAMPIONE, acronimo)).toEqual([2, 3])
    expect(righeColResiduo(CAMPIONE, mime)).toEqual([4])
    // 5-9 sono la MACCHINA che ricrea la tabella; la 10 è la LETTURA, e dal 2026-08-16
    // è vietata anche quella — è la riga che distingue questo lock da quello di ieri.
    expect(righeColResiduo(CAMPIONE, preIscrizioni)).toEqual([5, 6, 7, 8, 9, 10])
  })

  it('la lettura della tabella morta NON è più esentata (e il divieto resta chirurgico)', () => {
    // Fino al 2026-08-15 questo test asseriva l'ESATTO CONTRARIO: che `.from('pre_inscriptions')`
    // dovesse passare, perché una rotta viva la interrogava e un lock rosso per impostazione
    // predefinita è un lock che si spegne. Quella rotta è stata cancellata, quindi l'esenzione
    // non protegge più nessun chiamante — proteggerebbe solo il prossimo che la riscrive.
    const lettura = "      .from('pre_inscriptions')"
    expect(RESIDUI_VIETATI[3].pattern.test(lettura)).toBe(true)

    // E il divieto resta CHIRURGICO: gli altri tre non devono prendere una riga che non è
    // loro, o il messaggio d'errore manderebbe chi lo legge a cercare la cosa sbagliata.
    for (const { nome, pattern } of RESIDUI_VIETATI.slice(0, 3)) {
      expect(pattern.test(lettura), `«${nome}» non c'entra con questa riga`).toBe(false)
    }
    // Controllo negativo vero e proprio: codice innocente, nessun divieto lo tocca.
    for (const { nome, pattern } of RESIDUI_VIETATI) {
      expect(
        pattern.test('    const nienteDaVedere = 1'),
        `«${nome}» diventa rosso su codice innocente`,
      ).toBe(false)
    }
  })

  for (const { nome, pattern, motivo } of RESIDUI_VIETATI) {
    it(`nessun sorgente porta ${nome}`, () => {
      const colpevoli: string[] = []
      for (const percorso of FILE) {
        for (const n of righeColResiduo(readFileSync(percorso, 'utf8'), pattern)) {
          colpevoli.push(`${relative(RADICE, percorso)}:${n}`)
        }
      }
      expect(
        colpevoli,
        `Residuo ritrovato in:\n  ${colpevoli.join('\n  ')}\n` +
          `Che cos'è: ${nome}.\nMotivo del divieto: ${motivo}.`,
      ).toEqual([])
    })
  }
})
