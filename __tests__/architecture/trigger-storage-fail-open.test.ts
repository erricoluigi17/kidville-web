// @vitest-environment node

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · UN TRIGGER SU `storage.objects` NON FA MAI FALLIRE UN UPLOAD.
 *
 * ─── IL RISCHIO, E PERCHÉ SERVE UN LOCK E NON UNA CONVENZIONE ────────────────────────────
 *
 * `storage.objects` è la tabella di TUTTI i bucket, e la riga di un oggetto la scrive l'API Storage
 * dentro una transazione sua. Un trigger `AFTER INSERT` che solleva un'eccezione annulla quella
 * transazione: il caricamento di un file — qualunque file, di qualunque bucket — fallisce con un
 * errore che l'utente legge come «il server non funziona» e che nessun test di questo repo vede,
 * perché in CI lo Storage non c'è. Il guasto non è del file che si stava caricando: è di una
 * funzione scritta per un altro bucket.
 *
 * La migrazione `…_video_arrivo_originale.sql` ha il suo trigger (porta in coda il video appena
 * arrivato) ed è il primo che questo repo mette su quella tabella. Il prossimo, scritto fra sei mesi
 * da chi non ha letto la sua testata, deve nascere con le stesse quattro difese, e il gate deve
 * dirgli quale gli manca:
 *
 *   1. **la clausola `WHEN (NEW.bucket_id = '<bucket>')`**: gli oggetti degli altri bucket non
 *      vedono nemmeno la chiamata. È la difesa che non dipende dal corpo: se il corpo è sbagliato,
 *      sbaglia solo per il suo bucket;
 *   2. **un blocco `BEGIN … EXCEPTION WHEN OTHERS THEN … RETURN NEW … END` che contiene TUTTO il
 *      lavoro**: qualunque passo fallisca, l'INSERT dell'oggetto riesce lo stesso. Il gestore non
 *      rilancia (`RAISE`), e ritorna `NEW`;
 *   3. **`SECURITY DEFINER` con `SET search_path = pg_catalog`**: la funzione gira coi privilegi del
 *      proprietario (il ruolo che inserisce l'oggetto non ha accesso alle tabelle del dominio) e non
 *      può essere dirottata da uno schema scritto da altri;
 *   4. **nessuna `DELETE`**, nella funzione e in ciò che chiama nello stesso file: `storage.objects`
 *      ha `protect_objects_delete` (42501, a livello di statement), e cancellare la riga toglie
 *      l'indice e lascia il binario. I file si tolgono dalla Storage API.
 *
 * ─── COME GUARDA ─────────────────────────────────────────────────────────────────────────
 *
 * Legge TUTTE le migrazioni, nell'ordine in cui si applicano, senza i commenti (anche quelli dentro
 * i corpi `$$ … $$`, dove un `--` è un commento vero: una difesa citata in un commento non è una
 * difesa). Per ogni `CREATE [OR REPLACE] TRIGGER … ON storage.objects`, nel testo o dentro una
 * stringa passata a `EXECUTE`, risale alla definizione EFFETTIVA della sua funzione (l'ultima
 * `CREATE OR REPLACE` di tutte le migrazioni: è quella viva dopo l'applicazione) e ne controlla le
 * quattro cose. Il blocco `EXCEPTION` si cerca con un piccolo lettore della struttura
 * `BEGIN`/`END`/`CASE`/`IF`/`LOOP` e non con una regex: un gestore dentro un blocco ANNIDATO non
 * protegge il resto del corpo, e una regex non sa la differenza.
 *
 * ─── L'INTERRUTTORE D'EMERGENZA ──────────────────────────────────────────────────────────
 *
 * Il trigger dell'arrivo non si può togliere né disabilitare (`postgres` non è proprietario di
 * `storage.objects`): lo si neutralizza riscrivendo il CORPO della sua funzione, con un'istruzione
 * pronta nella testata della migrazione. Sta in un commento, quindi nessun lock la guarda — ma il
 * giorno in cui qualcuno la incolla in una migrazione (o la applica a mano e poi la committa) questo
 * lock deve accettarla: se la testata la lasciasse nella forma senza gestore, quel giorno il gate
 * sarebbe rosso, in piena emergenza. L'ultimo blocco di prove la legge dalla testata e fa girare su di
 * lei la regola, come ultima migrazione del repo.
 *
 * ─── COSA NON PROVA ──────────────────────────────────────────────────────────────────────
 *
 * Che il gestore sia ESEGUITO lo prova `__tests__/lib/video-arrivo-originale.test.ts` su PGlite
 * (un'eccezione in ogni punto lascia l'INSERT riuscito, e la stessa istruzione d'emergenza viene
 * applicata davvero); qui si prova solo che la forma c'è, e che il rilevatore la sa riconoscere — le
 * prove in fondo lo mettono alla prova su testi scritti qui, una difesa tolta alla volta. Un lock che
 * non ha mai visto un colpevole non è un lock.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

// ─────────────────────────────────────────────────────────────────────────────
// L'ANALISI DELL'SQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il testo senza i commenti `--` e `/* … *\/`, con le stringhe `'…'` intatte e i corpi `$$ … $$`
 * trattati come CODICE (il loro `--` è un commento di plpgsql, e va tolto).
 *
 * Un apice dentro un commento non apre una stringa: i commenti si saltano PRIMA di guardare gli
 * apici, ed è per questo che i commenti italiani (`l'upload`, `un'eccezione`) non rompono niente.
 */
export function senzaCommentiSql(sql: string): string {
  let fuori = ''
  let i = 0
  let inStringa = false
  while (i < sql.length) {
    const c = sql[i]
    if (inStringa) {
      fuori += c
      if (c === "'") {
        if (sql[i + 1] === "'") {
          fuori += "'"
          i += 2
          continue
        }
        inStringa = false
      }
      i += 1
      continue
    }
    if (c === '-' && sql[i + 1] === '-') {
      const fine = sql.indexOf('\n', i)
      i = fine < 0 ? sql.length : fine
      continue
    }
    if (c === '/' && sql[i + 1] === '*') {
      const fine = sql.indexOf('*/', i + 2)
      i = fine < 0 ? sql.length : fine + 2
      fuori += ' '
      continue
    }
    if (c === "'") inStringa = true
    fuori += c
    i += 1
  }
  return fuori
}

export type Funzione = { nome: string; file: string; intestazione: string; corpo: string }

/** Le funzioni dichiarate in un testo (già senza commenti): intestazione e corpo `AS $tag$ … $tag$`. */
export function funzioniDi(file: string, sql: string): Funzione[] {
  const trovate: Funzione[] = []
  const testata = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = testata.exec(sql)) !== null) {
    const resto = sql.slice(m.index)
    const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(resto)
    if (!as) continue
    const inizio = m.index + as.index + as[0].length
    const fine = sql.indexOf(as[1], inizio)
    if (fine < 0) continue
    trovate.push({
      nome: m[1],
      file,
      intestazione: sql.slice(m.index, m.index + as.index),
      corpo: sql.slice(inizio, fine),
    })
  }
  return trovate
}

type Pezzo = { parola: string; indice: number }

/**
 * Le PAROLE di un corpo plpgsql (`A-Z0-9_`, in maiuscolo) e i punti e virgola, saltando le stringhe
 * `'…'` e quelle a dollaro annidate (`EXECUTE $q$ … $q$`): dentro non c'è struttura. I commenti sono
 * già tolti.
 */
function pezzi(corpo: string): Pezzo[] {
  const fuori: Pezzo[] = []
  let i = 0
  while (i < corpo.length) {
    const c = corpo[i]
    if (c === "'") {
      i += 1
      while (i < corpo.length) {
        if (corpo[i] === "'") {
          if (corpo[i + 1] === "'") {
            i += 2
            continue
          }
          break
        }
        i += 1
      }
      i += 1
      continue
    }
    if (c === '$') {
      const apertura = /^\$[A-Za-z_]*\$/.exec(corpo.slice(i))
      if (apertura) {
        const fine = corpo.indexOf(apertura[0], i + apertura[0].length)
        i = fine < 0 ? corpo.length : fine + apertura[0].length
        continue
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < corpo.length && /[A-Za-z0-9_]/.test(corpo[j])) j += 1
      fuori.push({ parola: corpo.slice(i, j).toUpperCase(), indice: i })
      i = j
      continue
    }
    if (c === ';') fuori.push({ parola: ';', indice: i })
    i += 1
  }
  return fuori
}

type Struttura = {
  /** Il corpo comincia con `BEGIN` (o con un `DECLARE` che lo precede) e le sue parentesi di blocco tornano. */
  leggibile: boolean
  /** L'indice, nel corpo, dell'`EXCEPTION` del blocco PIÙ ESTERNO, se c'è. */
  gestoreEsterno: number | null
}

/**
 * La struttura di blocco di un corpo plpgsql: dove sta l'`EXCEPTION` del blocco più esterno.
 *
 * Una pila di `BEGIN`, `CASE`, `IF` e `LOOP`: ogni `END` chiude l'ultimo aperto (`END IF`, `END LOOP`
 * e `END CASE` si portano via anche la parola che li segue). Un `CASE` è sia un'espressione SQL
 * (`… CASE WHEN … END`) sia un'istruzione (`END CASE`), e in entrambi i casi la pila lo vede. Un `IF`
 * apre un'istruzione solo a inizio di istruzione: `IF EXISTS` / `IF NOT EXISTS` dentro un DDL non è
 * un blocco. `RAISE EXCEPTION` non è un gestore.
 */
export function strutturaDi(corpo: string): Struttura {
  const t = pezzi(corpo)
  const pila: Array<'blocco' | 'case' | 'if' | 'loop'> = []
  let gestoreEsterno: number | null = null
  let squilibrio = false
  const INIZIO_ISTRUZIONE = new Set([';', 'THEN', 'ELSE', 'BEGIN', 'LOOP', 'DECLARE'])

  const prima = t[0]?.parola
  const comincia = prima === 'BEGIN' || prima === 'DECLARE'

  for (let k = 0; k < t.length; k += 1) {
    const parola = t[k].parola
    const precedente = k === 0 ? ';' : t[k - 1].parola
    if (parola === 'BEGIN') pila.push('blocco')
    else if (parola === 'CASE') pila.push('case')
    else if (parola === 'IF') {
      if (INIZIO_ISTRUZIONE.has(precedente)) pila.push('if')
    } else if (parola === 'LOOP') {
      if (precedente !== 'END') pila.push('loop')
    } else if (parola === 'END') {
      const seguente = t[k + 1]?.parola
      if (pila.length === 0) squilibrio = true
      pila.pop()
      if (seguente === 'IF' || seguente === 'LOOP' || seguente === 'CASE') k += 1
    } else if (parola === 'EXCEPTION') {
      if (precedente !== 'RAISE' && pila.length === 1 && pila[0] === 'blocco' && gestoreEsterno === null) {
        gestoreEsterno = t[k].indice
      }
    }
  }
  return { leggibile: comincia && !squilibrio && pila.length === 0, gestoreEsterno }
}

// ─────────────────────────────────────────────────────────────────────────────
// I TRIGGER SU storage.objects, E LE LORO QUATTRO DIFESE
// ─────────────────────────────────────────────────────────────────────────────

export type Perche =
  | 'senza-when-sul-bucket'
  | 'funzione-non-definita'
  | 'senza-security-definer'
  | 'senza-search-path'
  | 'struttura-illeggibile'
  | 'senza-gestore-fail-open'
  | 'gestore-che-rilancia'
  | 'con-delete'

export type Rilievo = { file: string; trigger: string; funzione: string; perche: Perche }

export type TriggerSuStorage = { file: string; nome: string; funzione: string; dopoOn: string }

/**
 * I `CREATE [OR REPLACE] TRIGGER … ON storage.objects … EXECUTE FUNCTION f()` di un testo (già senza
 * commenti). Si guarda anche dentro le stringhe: `EXECUTE 'CREATE OR REPLACE TRIGGER … ''x''…'` è il
 * modo in cui una migrazione idempotente lo scrive quando la tabella può non esserci, e un lock che
 * non lo vedesse lascerebbe passare proprio la forma più probabile. Il confine di un'istruzione è il
 * punto e virgola: il `[^;]` impedisce a un trigger su un'altra tabella di «arrivare» fino a un
 * `ON storage.objects` che sta tre istruzioni più in là.
 */
export function triggerSuStorageDi(file: string, sqlSenzaCommenti: string): TriggerSuStorage[] {
  const testo = sqlSenzaCommenti.replace(/''/g, "'")
  const re =
    /CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?[^;]*?\bON\s+storage\.objects\b([^;]*?)\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?(\w+)"?\s*\(/gi
  const trovati: TriggerSuStorage[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(testo)) !== null) trovati.push({ file, nome: m[1], funzione: m[3], dopoOn: m[2] })
  return trovati
}

/** Il contenuto (bilanciato) della prima parentesi che segue `WHEN`, o `null` se non c'è. */
export function clausolaWhen(dopoOn: string): string | null {
  const w = /\bWHEN\s*\(/i.exec(dopoOn)
  if (!w) return null
  let profondita = 1
  let i = w.index + w[0].length
  const inizio = i
  while (i < dopoOn.length && profondita > 0) {
    if (dopoOn[i] === '(') profondita += 1
    else if (dopoOn[i] === ')') profondita -= 1
    i += 1
  }
  return profondita === 0 ? dopoOn.slice(inizio, i - 1) : null
}

/** Le funzioni `public.X(` chiamate in un corpo, per nome. */
const chiamateIn = (corpo: string): string[] =>
  [...corpo.matchAll(/\bpublic\.(\w+)\s*\(/gi)].map((m) => m[1])

/**
 * I rilievi di un insieme di migrazioni, nell'ordine in cui si applicano. Pura: la usano la prova sul
 * repo e le prove su testi scritti qui.
 */
export function rilieviDi(migrazioni: ReadonlyArray<{ nome: string; sql: string }>): Rilievo[] {
  const pulite = migrazioni.map((m) => ({ nome: m.nome, sql: senzaCommentiSql(m.sql) }))

  // La definizione EFFETTIVA di ogni funzione: l'ultima `CREATE OR REPLACE` vince.
  const effettive = new Map<string, Funzione>()
  for (const m of pulite) for (const f of funzioniDi(m.nome, m.sql)) effettive.set(f.nome, f)

  const rilievi: Rilievo[] = []
  for (const m of pulite) {
    for (const t of triggerSuStorageDi(m.nome, m.sql)) {
      const segnala = (perche: Perche) =>
        rilievi.push({ file: m.nome, trigger: t.nome, funzione: t.funzione, perche })

      // 1. La clausola WHEN sul bucket.
      const when = clausolaWhen(t.dopoOn)
      if (when === null || !/\b(?:NEW|OLD)\.bucket_id\s*=\s*'[^']+'/i.test(when)) segnala('senza-when-sul-bucket')

      const f = effettive.get(t.funzione)
      if (!f) {
        segnala('funzione-non-definita')
        continue
      }

      // 3. SECURITY DEFINER e search_path.
      if (!/\bSECURITY\s+DEFINER\b/i.test(f.intestazione)) segnala('senza-security-definer')
      if (!/\bSET\s+search_path\s*(?:=|TO)\s*'?pg_catalog\b/i.test(f.intestazione)) segnala('senza-search-path')

      // 2. Il blocco più esterno ha un gestore OTHERS che ritorna NEW e non rilancia.
      const s = strutturaDi(f.corpo)
      if (!s.leggibile) {
        segnala('struttura-illeggibile')
      } else if (s.gestoreEsterno === null) {
        segnala('senza-gestore-fail-open')
      } else {
        const gestore = f.corpo.slice(s.gestoreEsterno)
        if (!/\bWHEN\s+OTHERS\s+THEN\b/i.test(gestore) || !/\bRETURN\s+NEW\s*;/i.test(gestore)) {
          segnala('senza-gestore-fail-open')
        } else if (/\bRAISE\b(?!\s+(?:NOTICE|WARNING|INFO|LOG|DEBUG)\b)/i.test(gestore)) {
          segnala('gestore-che-rilancia')
        }
      }

      // 4. Nessuna DELETE, nella funzione e in ciò che chiama nello stesso file (a qualunque profondità).
      const visitate = new Set<string>([f.nome])
      const daVedere: Funzione[] = [f]
      let conDelete = false
      while (daVedere.length > 0 && !conDelete) {
        const corrente = daVedere.pop() as Funzione
        if (/\bDELETE\b/i.test(corrente.corpo)) conDelete = true
        for (const nome of chiamateIn(corrente.corpo)) {
          const chiamata = effettive.get(nome)
          if (chiamata && chiamata.file === m.nome && !visitate.has(nome)) {
            visitate.add(nome)
            daVedere.push(chiamata)
          }
        }
      }
      if (conDelete) segnala('con-delete')
    }
  }
  return rilievi
}

// ─────────────────────────────────────────────────────────────────────────────
// LE PROVE SUL REPO
// ─────────────────────────────────────────────────────────────────────────────

const FILE_MIGRAZIONI = readdirSync(MIGRAZIONI)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const MIGRAZIONI_LETTE = FILE_MIGRAZIONI.map((nome) => ({ nome, sql: readFileSync(join(MIGRAZIONI, nome), 'utf8') }))
const TRIGGER_NEL_REPO = MIGRAZIONI_LETTE.flatMap((m) => triggerSuStorageDi(m.nome, senzaCommentiSql(m.sql)))

const SPIEGAZIONE: Record<Perche, string> = {
  'senza-when-sul-bucket':
    'manca la clausola `WHEN (NEW.bucket_id = \'<bucket>\')`: il trigger scatterebbe per OGNI oggetto di OGNI bucket, ' +
    'e un suo errore farebbe fallire anche il caricamento di una foto della galleria',
  'funzione-non-definita': 'la funzione del trigger non è definita in nessuna migrazione: non si può dire che sia fail-open',
  'senza-security-definer': 'la funzione non è `SECURITY DEFINER`: gira coi privilegi di chi inserisce l\'oggetto (il ruolo dello Storage), che non ha accesso alle tabelle del dominio',
  'senza-search-path': 'manca `SET search_path = pg_catalog`: una `SECURITY DEFINER` senza il percorso fissato si lascia dirottare da uno schema scritto da altri',
  'struttura-illeggibile': 'il corpo non comincia con `BEGIN`/`DECLARE` o le sue parentesi di blocco (`BEGIN`/`END`/`CASE`/`IF`/`LOOP`) non tornano: del codice può stare FUORI dal blocco protetto',
  'senza-gestore-fail-open':
    'il blocco più esterno non ha `EXCEPTION WHEN OTHERS THEN … RETURN NEW`: un\'eccezione in un punto qualunque annulla l\'INSERT dell\'oggetto, cioè fa fallire l\'upload (un gestore dentro un blocco annidato non basta)',
  'gestore-che-rilancia': 'il gestore contiene un `RAISE` che non è un messaggio (NOTICE/WARNING/INFO/LOG/DEBUG): ingoiare l\'errore e poi rilanciarlo è lo stesso che non ingoiarlo',
  'con-delete':
    'una `DELETE` nella funzione (o in ciò che chiama nello stesso file): `storage.objects` ha `protect_objects_delete` e cancellare la riga toglie l\'indice lasciando il binario. I file si tolgono dalla Storage API',
}

describe('lock architettura · ogni trigger su storage.objects è fail-open', () => {
  it('le fonti sono piene (se cade questa, tutto il resto è verde sul vuoto)', () => {
    expect(FILE_MIGRAZIONI.length, 'nessuna migrazione sotto supabase/migrations').toBeGreaterThan(60)
    expect(
      TRIGGER_NEL_REPO.length,
      'Lo scanner non trova nessun trigger su `storage.objects` nelle migrazioni: o la forma con cui si ' +
        'dichiara è cambiata (la regex qui sopra non la riconosce più), o il trigger dell\'arrivo dell\'originale ' +
        'è sparito. In entrambi i casi questo file direbbe «verde» senza aver guardato niente.',
    ).toBeGreaterThanOrEqual(1)
    expect(
      TRIGGER_NEL_REPO.some((t) => t.file.endsWith('_video_arrivo_originale.sql') && t.nome === 'trg_video_originale_arrivato'),
      'Il trigger `trg_video_originale_arrivato` non è fra quelli che il lock vede: ha cambiato forma, o la ' +
        'migrazione è stata rinominata senza il suffisso `_video_arrivo_originale.sql`.',
    ).toBe(true)
  })

  it('🔴 ogni trigger ha il WHEN sul bucket, il gestore fail-open, SECURITY DEFINER + search_path e nessuna DELETE', () => {
    const rilievi = rilieviDi(MIGRAZIONI_LETTE)
    expect(
      rilievi.map((r) => `${r.trigger}  (${r.funzione}, in ${r.file})  ←  ${SPIEGAZIONE[r.perche]}`),
      'Un trigger su `storage.objects` gira DENTRO la transazione dell\'API Storage, su una tabella che è di tutti i ' +
        'bucket: un\'eccezione che ne esce fa fallire un upload. Vedi la testata di questo file per le quattro difese.',
    ).toEqual([])
  })

  it('il trigger dell\'arrivo ha ESATTAMENTE la forma della spec: AFTER INSERT OR UPDATE OF metadata, per riga, solo video_originals', () => {
    const [t] = TRIGGER_NEL_REPO.filter((x) => x.nome === 'trg_video_originale_arrivato')
    expect(t, 'trigger non trovato').toBeDefined()
    expect(t.funzione).toBe('video_originale_arrivato')
    expect(clausolaWhen(t.dopoOn)?.replace(/\s+/g, ' ').trim()).toBe("NEW.bucket_id = 'video_originals'")
    expect(t.dopoOn).toMatch(/FOR\s+EACH\s+ROW/i)
    const file = MIGRAZIONI_LETTE.find((m) => m.nome === t.file)!
    const dichiarazione = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+trg_video_originale_arrivato\s+([^;]*?)\s+ON\s+storage\.objects/i.exec(
      senzaCommentiSql(file.sql),
    )
    expect(dichiarazione?.[1].replace(/\s+/g, ' ')).toMatch(/^AFTER INSERT OR UPDATE OF metadata$/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Un lock verde perché non trova violazioni e un lock verde perché non guarda più niente si
// somigliano moltissimo. Queste prove tengono ferme le forme che il rilevatore DEVE vedere — una
// difesa tolta alla volta — e quelle che NON deve segnalare, su testi scritti qui e non sul repo.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore vede ciò che deve vedere', () => {
  /** Una migrazione con tutte e quattro le difese. Ogni prova ne toglie UNA. */
  const buona = (
    p: Partial<{ when: string; intestazione: string; corpo: string; fuori: string }> = {},
  ): string => `
CREATE OR REPLACE FUNCTION public.fn_arrivo()
RETURNS trigger
LANGUAGE plpgsql
${p.intestazione ?? 'SECURITY DEFINER\nSET search_path = pg_catalog'}
AS $$
${
  p.corpo ??
  `DECLARE
  v_x integer;
BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM public.scrivi_il_log('errore');
  RETURN NEW;
END`
}
$$;
${p.fuori ?? ''}
DO $inst$
BEGIN
  CREATE OR REPLACE TRIGGER trg_arrivo
    AFTER INSERT OR UPDATE OF metadata ON storage.objects
    FOR EACH ROW
    ${p.when ?? "WHEN (NEW.bucket_id = 'video_originals')"}
    EXECUTE FUNCTION public.fn_arrivo();
END
$inst$;
`

  const perche = (sql: string): Perche[] => rilieviDi([{ nome: 'finto.sql', sql }]).map((r) => r.perche)

  it('NEGATIVO — la forma con tutte le difese non viene segnalata (se lo fosse, il lock sarebbe rosso per sempre)', () => {
    expect(perche(buona())).toEqual([])
  })

  it('POSITIVO — senza la clausola WHEN: senza-when-sul-bucket', () => {
    expect(perche(buona({ when: '' }))).toEqual(['senza-when-sul-bucket'])
  })

  it('POSITIVO — un WHEN che non riguarda il bucket (il nome, un altro campo) non vale', () => {
    expect(perche(buona({ when: "WHEN (NEW.name LIKE 'video/%')" }))).toEqual(['senza-when-sul-bucket'])
  })

  it('NEGATIVO — il WHEN può avere altre condizioni accanto a quella sul bucket', () => {
    expect(perche(buona({ when: "WHEN (NEW.bucket_id = 'video_originals' AND NEW.metadata IS NOT NULL)" }))).toEqual([])
  })

  it('POSITIVO — senza il gestore EXCEPTION: senza-gestore-fail-open', () => {
    const corpo = `BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual(['senza-gestore-fail-open'])
  })

  it('POSITIVO — un gestore che prende solo UN errore (non OTHERS) non copre il resto', () => {
    const corpo = `BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
EXCEPTION WHEN unique_violation THEN
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual(['senza-gestore-fail-open'])
  })

  it('POSITIVO — il gestore c\'è ma non ritorna NEW', () => {
    const corpo = `BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM public.scrivi_il_log('errore');
END`
    expect(perche(buona({ corpo }))).toEqual(['senza-gestore-fail-open'])
  })

  it('POSITIVO — il gestore ingoia e RILANCIA: gestore-che-rilancia (anche con un `RAISE;` nudo)', () => {
    const rilancia = (riga: string) => `BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM public.scrivi_il_log('errore');
  ${riga}
  RETURN NEW;
END`
    expect(perche(buona({ corpo: rilancia("RAISE EXCEPTION 'no';") }))).toEqual(['gestore-che-rilancia'])
    expect(perche(buona({ corpo: rilancia('RAISE;') }))).toEqual(['gestore-che-rilancia'])
    // Un messaggio non è un rilancio.
    expect(perche(buona({ corpo: rilancia("RAISE WARNING 'ho ingoiato un errore';") }))).toEqual([])
  })

  it('POSITIVO — un gestore dentro un blocco ANNIDATO non protegge il resto del corpo', () => {
    // Il lavoro vero sta FUORI dal sottoblocco che ha il gestore: un'eccezione lì uscirebbe.
    const corpo = `BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  BEGIN
    PERFORM public.solo_il_log(NEW.name);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual(['senza-gestore-fail-open'])
  })

  it('NEGATIVO — un gestore esterno con dentro un sottoblocco suo (il logger protetto) resta valido', () => {
    const corpo = `BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    PERFORM public.scrivi_il_log('errore');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual([])
  })

  it('POSITIVO — il gestore è citato SOLO in un commento: non vale', () => {
    const corpo = `BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  -- EXCEPTION WHEN OTHERS THEN RETURN NEW;
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual(['senza-gestore-fail-open'])
  })

  it('POSITIVO — `RAISE EXCEPTION` nel corpo non è un gestore', () => {
    const corpo = `BEGIN
  IF NEW.name IS NULL THEN
    RAISE EXCEPTION 'nome nullo';
  END IF;
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual(['senza-gestore-fail-open'])
  })

  it('NEGATIVO — CASE, IF, FOR…LOOP e IF EXISTS nel corpo non confondono la lettura della struttura', () => {
    const corpo = `DECLARE
  v_r record;
  v_n integer := 0;
BEGIN
  v_n := CASE WHEN NEW.name IS NULL THEN 0 ELSE 1 END;
  IF v_n > 0 THEN
    FOR v_r IN SELECT 1 AS x LOOP
      v_n := v_n + CASE v_r.x WHEN 1 THEN 1 ELSE 2 END;
    END LOOP;
  ELSIF v_n = 0 THEN
    NULL;
  END IF;
  CASE v_n
    WHEN 1 THEN NULL;
    ELSE NULL;
  END CASE;
  DROP TABLE IF EXISTS pg_temp.tmp_x;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual([])
  })

  it('POSITIVO — senza SECURITY DEFINER: senza-security-definer', () => {
    expect(perche(buona({ intestazione: 'SET search_path = pg_catalog' }))).toEqual(['senza-security-definer'])
  })

  it('POSITIVO — senza `SET search_path`: senza-search-path', () => {
    expect(perche(buona({ intestazione: 'SECURITY DEFINER' }))).toEqual(['senza-search-path'])
  })

  it('POSITIVO — un search_path diverso da pg_catalog (public) non vale', () => {
    expect(perche(buona({ intestazione: 'SECURITY DEFINER\nSET search_path = public' }))).toEqual(['senza-search-path'])
  })

  it('NEGATIVO — altri attributi accanto (lock_timeout, un search_path con pg_temp) non guastano', () => {
    expect(perche(buona({ intestazione: "SECURITY DEFINER\nSET search_path = pg_catalog\nSET lock_timeout = '2s'" }))).toEqual([])
    expect(perche(buona({ intestazione: 'SECURITY DEFINER\nSET search_path TO pg_catalog, pg_temp' }))).toEqual([])
  })

  it('POSITIVO — una DELETE nel corpo del trigger: con-delete', () => {
    const corpo = `BEGIN
  DELETE FROM public.tabella_a WHERE nome = NEW.name;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END`
    expect(perche(buona({ corpo }))).toEqual(['con-delete'])
  })

  it('POSITIVO — una DELETE in una funzione chiamata dal trigger, nello STESSO file (a qualunque profondità)', () => {
    const fuori = `
CREATE OR REPLACE FUNCTION public.fai_il_lavoro(p text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN PERFORM public.pulisci(p); END $f$;
CREATE OR REPLACE FUNCTION public.pulisci(p text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN DELETE FROM public.tabella_a WHERE nome = p; END $f$;`
    expect(perche(buona({ fuori }))).toEqual(['con-delete'])
  })

  it('NEGATIVO — una DELETE in una funzione che il trigger NON chiama (o definita in un altro file) non è affare di questo lock', () => {
    const altra = `
CREATE OR REPLACE FUNCTION public.pulizia_notturna() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN DELETE FROM public.tabella_a WHERE vecchia; END $f$;`
    expect(perche(buona({ fuori: altra }))).toEqual([])
    expect(
      rilieviDi([
        { nome: 'a.sql', sql: altra.replace('pulizia_notturna', 'fai_il_lavoro') },
        { nome: 'b.sql', sql: buona() },
      ]),
    ).toEqual([])
  })

  it('POSITIVO — la parola DELETE in un COMMENTO non conta, ma in un corpo vero sì (il comando e il commento non si confondono)', () => {
    const conCommento = `BEGIN
  -- niente DELETE qui: i file si tolgono dalla Storage API
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END`
    expect(perche(buona({ corpo: conCommento }))).toEqual([])
  })

  it('vale la definizione EFFETTIVA: una CREATE OR REPLACE successiva che toglie il gestore rende rosso il trigger della migrazione prima', () => {
    const rottura = `
CREATE OR REPLACE FUNCTION public.fn_arrivo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN PERFORM public.fai_il_lavoro(NEW.name); RETURN NEW; END $$;`
    expect(
      rilieviDi([
        { nome: '1.sql', sql: buona() },
        { nome: '2.sql', sql: rottura },
      ]).map((r) => r.perche),
    ).toEqual(['senza-gestore-fail-open'])
  })

  it('una funzione che nessuna migrazione definisce non si può dire fail-open: funzione-non-definita', () => {
    const solo = `
DO $inst$
BEGIN
  CREATE OR REPLACE TRIGGER trg_x AFTER INSERT ON storage.objects FOR EACH ROW
    WHEN (NEW.bucket_id = 'a') EXECUTE FUNCTION public.non_esiste();
END $inst$;`
    expect(perche(solo)).toEqual(['funzione-non-definita'])
  })

  it('un trigger su un\'ALTRA tabella non è affare di questo lock (anche vicino a uno su storage.objects)', () => {
    const altroTrigger = `
CREATE TRIGGER trg_altro AFTER INSERT ON public.tabella_a FOR EACH ROW EXECUTE FUNCTION public.fn_arrivo();`
    expect(rilieviDi([{ nome: 'a.sql', sql: buona() + altroTrigger }]).map((r) => r.trigger)).toEqual([])
    // E `public.tabella_a` non «trascina» un `ON storage.objects` che sta più in là, oltre il punto e virgola.
    const vicini = `
CREATE TRIGGER trg_prima AFTER INSERT ON public.tabella_a FOR EACH ROW EXECUTE FUNCTION public.fn_arrivo();
${buona()}`
    expect(rilieviDi([{ nome: 'a.sql', sql: vicini }]).map((r) => r.trigger)).toEqual([])
  })

  it('anche un trigger dichiarato dentro una STRINGA passata a EXECUTE è sorvegliato (la forma di una migrazione idempotente)', () => {
    const inStringa = `
CREATE OR REPLACE FUNCTION public.fn_arrivo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM public.fai_il_lavoro(NEW.name);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END $$;
DO $inst$
BEGIN
  EXECUTE 'CREATE OR REPLACE TRIGGER trg_arrivo AFTER INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.fn_arrivo()';
END $inst$;`
    expect(perche(inStringa)).toEqual(['senza-when-sul-bucket'])
    const conWhen = inStringa.replace(
      'FOR EACH ROW EXECUTE',
      "FOR EACH ROW WHEN (NEW.bucket_id = ''video_originals'') EXECUTE",
    )
    expect(perche(conWhen)).toEqual([])
  })

  it('più difese tolte insieme: ogni mancanza è un rilievo a sé', () => {
    const corpo = `BEGIN
  DELETE FROM public.tabella_a;
  RETURN NEW;
END`
    expect(perche(buona({ when: '', intestazione: 'LANGUAGE plpgsql', corpo })).sort()).toEqual(
      ['con-delete', 'senza-gestore-fail-open', 'senza-search-path', 'senza-security-definer', 'senza-when-sul-bucket'].sort(),
    )
  })

  it('un corpo che comincia con del codice FUORI dal blocco, o con parentesi che non tornano, è illeggibile e non passa', () => {
    expect(perche(buona({ corpo: `PERFORM 1;\nBEGIN\n  RETURN NEW;\nEXCEPTION WHEN OTHERS THEN\n  RETURN NEW;\nEND` }))).toEqual(['struttura-illeggibile'])
    expect(perche(buona({ corpo: `BEGIN\n  BEGIN\n  RETURN NEW;\nEXCEPTION WHEN OTHERS THEN\n  RETURN NEW;\nEND` }))).toEqual(['struttura-illeggibile'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'ISTRUZIONE D'EMERGENZA DELLA TESTATA PASSA QUESTO LOCK (#65)
// ─────────────────────────────────────────────────────────────────────────────

describe('l\'istruzione d\'emergenza della testata passa questo lock', () => {
  const ARRIVO = MIGRAZIONI_LETTE.find((m) => m.nome.endsWith('_video_arrivo_originale.sql'))
  const GESTORE = /EXCEPTION\s+WHEN\s+OTHERS\s+THEN\s+RETURN\s+NEW\s*;/i

  /** Le righe fra i due marcatori della testata, senza il prefisso di commento: ciò che chi è in emergenza incolla. */
  function istruzioneDiEmergenza(): string {
    expect(ARRIVO, 'la migrazione dell\'arrivo (`…_video_arrivo_originale.sql`) non è fra quelle lette').toBeDefined()
    const righeDellaMigrazione = (ARRIVO as { sql: string }).sql.split('\n')
    const inizio = righeDellaMigrazione.findIndex((r) => r.includes('>>> INTERRUTTORE: INIZIO'))
    const fine = righeDellaMigrazione.findIndex((r) => r.includes('>>> INTERRUTTORE: FINE'))
    expect(inizio, 'manca il marcatore di inizio dell\'interruttore nella testata').toBeGreaterThanOrEqual(0)
    expect(fine, 'manca il marcatore di fine dell\'interruttore nella testata').toBeGreaterThan(inizio)
    return righeDellaMigrazione
      .slice(inizio + 1, fine)
      .map((r) => r.replace(/^--\s?/, ''))
      .join('\n')
  }

  /** Il repo com'è, con l'istruzione come ULTIMA migrazione: la sua definizione della funzione è quella effettiva. */
  const conLEmergenza = (istruzione: string) => [...MIGRAZIONI_LETTE, { nome: 'zz_interruttore_di_emergenza.sql', sql: istruzione }]

  it('applicata come migrazione, la regola del lock non trova rilievi: il trigger dell\'arrivo resta fail-open con il corpo neutralizzato', () => {
    const istruzione = istruzioneDiEmergenza()
    // La prova gira sulla definizione EFFETTIVA: l'istruzione sostituisce davvero la funzione di quel trigger.
    expect(funzioniDi('zz_interruttore_di_emergenza.sql', senzaCommentiSql(istruzione)).map((f) => f.nome)).toEqual([
      'video_originale_arrivato',
    ])
    expect(
      rilieviDi(conLEmergenza(istruzione)).map((r) => `${r.trigger}  (${r.funzione})  ←  ${SPIEGAZIONE[r.perche]}`),
      'l\'istruzione d\'emergenza della testata renderebbe rosso questo lock se diventasse una migrazione',
    ).toEqual([])
  })

  it('CONTROPROVA — la forma di prima (`BEGIN RETURN NEW; END`, senza il gestore) verrebbe rifiutata: senza-gestore-fail-open', () => {
    const istruzione = istruzioneDiEmergenza()
    const senzaGestore = istruzione.replace(GESTORE, '')
    expect(senzaGestore, 'la controprova non ha tolto il gestore: la testata non ha più «EXCEPTION WHEN OTHERS THEN RETURN NEW;»').not.toBe(istruzione)
    expect(rilieviDi(conLEmergenza(senzaGestore)).map((r) => r.perche)).toEqual(['senza-gestore-fail-open'])
  })
})
