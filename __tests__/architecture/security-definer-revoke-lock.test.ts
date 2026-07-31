import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK di sicurezza — ogni funzione SECURITY DEFINER revoca EXECUTE da anon/authenticated
//
// In Supabase i ruoli `anon` e `authenticated` ricevono EXECUTE sulle funzioni via
// GRANT ESPLICITO (ALTER DEFAULT PRIVILEGES), NON tramite PUBLIC: un
// `REVOKE ... FROM PUBLIC` non li tocca. Una funzione `SECURITY DEFINER` (gira come
// owner, bypassa la RLS) senza REVOKE resta quindi chiamabile in anonimo via
// `/rest/v1/rpc/<fn>` con la sola anon key pubblica → IDOR / bypass del gate applicativo.
// È esattamente la regressione delle RPC mensa (2026-07-18): la difesa è
// `REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC, anon, authenticated;`.
//
// Questo lock impedisce che una NUOVA migrazione introduca una SECURITY DEFINER senza
// revocarne l'esecuzione ad anon/authenticated.
//
// COME GUARDA (riscritto il 2026-08-01, collaudo debug F2). Fino a ieri cercava due stringhe nel
// file intero: «SECURITY DEFINER» insieme a «CREATE FUNCTION», e da qualche parte «REVOKE … anon».
// Una traccia della cosa, non la cosa. Bastava che le parole ci fossero, non che facessero
// qualcosa: `ALTER FUNCTION … SECURITY DEFINER` — l'altro modo, del tutto legittimo, di promuovere
// una funzione ai privilegi del proprietario — non contiene nessuna `CREATE` e passava il gate;
// un `REVOKE … FROM PUBLIC` seguito da un `GRANT … TO authenticated` conteneva tutte le parole
// giuste e non revocava niente; un `REVOKE` sulla tabella `t` valeva come revoca dell'EXECUTE; e
// con due funzioni definite nello stesso file bastava revocarne una.
// Ora si legge l'SQL statement per statement e si tiene il conto dei privilegi FUNZIONE PER
// FUNZIONE: chi resta scoperta viene detta per nome.
// ─────────────────────────────────────────────────────────────────────────────

// Eccezioni storiche, dichiarate **funzione per funzione** (non per file intero: un file in
// allowlist smetterebbe di essere sorvegliato anche per le funzioni che qualcuno gli aggiunge
// domani). NON aggiungere qui una migrazione NUOVA per aggirare il lock: si aggiunge il REVOKE.
//
// Stato reale misurato sul database di **produzione** il 2026-08-01, in sola lettura
// (`pg_proc` + `has_function_privilege`): delle 30 funzioni SECURITY DEFINER dello schema
// `public`, **nessuna** è eseguibile da `anon`, e l'unica eseguibile da `authenticated` è
// `current_parent_student_ids()`. Le eccezioni qui sotto sono quindi carta vecchia del
// versionamento, non porte aperte — ma restano scritte perché il lock deve dire la verità su
// cosa NON sta controllando.
const AMMESSE = new Map<string, readonly string[]>([
  // Dump `pg_dump` del 2026-07-04: riproduce l'ACL che le funzioni avevano già e revoca solo
  // `FROM PUBLIC`, l'unica forma che pg_dump emette. Quattro di queste sono state poi revocate
  // per nome da 20260706210352 (fn_form_submission_etl, notifiche_dispatch_tick, rls_auto_enable,
  // mensa_check_allergie_giornaliero) e is_staff_or_admin da 20260731102245.
  // `current_parent_student_ids()` resta deliberatamente eseguibile da `authenticated`: ritorna i
  // SOLI figli di chi chiama ed è il perno delle policy «parents space» (una sottoquery dentro
  // un'espressione di policy è a sua volta soggetta alla RLS: senza di lei quelle policy non
  // funzionerebbero).
  // Tre — `exec_sql`, `prossimo_numero_fattura`, `fatture_sdi_sync_tick` — non hanno un REVOKE
  // nominativo in NESSUNA migrazione: in produzione risultano chiuse perché il GRANT non è mai
  // stato dato, non perché qualcuno l'abbia tolto. Su un progetto Supabase ricostruito da zero
  // con `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE … TO anon, authenticated` attive, nascerebbero
  // aperte. Va sanato con una migrazione dedicata, non allargando questa lista.
  [
    '20260704120000_baseline.sql',
    [
      'current_parent_student_ids',
      'exec_sql',
      'fatture_sdi_sync_tick',
      'fn_form_submission_etl',
      'is_staff_or_admin',
      'mensa_check_allergie_giornaliero',
      'notifiche_dispatch_tick',
      'prossimo_numero_fattura',
      'rls_auto_enable',
    ],
  ],
  // `CREATE OR REPLACE` del trigger ETL dell'anagrafica, il giorno dopo la baseline. L'EXECUTE è
  // revocato per nome poche ore più tardi da 20260706210352, e di nuovo da 20260731101818.
  ['20260706105201_anagrafiche_residenza_provincia_civico.sql', ['fn_form_submission_etl']],
  // `CREATE OR REPLACE` di quattro funzioni **già esistenti**, per farle leggere la configurazione
  // dal vault. In Postgres `CREATE OR REPLACE FUNCTION` NON reimposta i privilegi: l'ACL resta
  // quella che era, e per tutte e quattro era già stata chiusa (20260706210352 e 20260712180000).
  // Confermato in produzione il 2026-08-01: anon=false, authenticated=false su tutte e quattro.
  [
    '20260712220000_cron_config_vault.sql',
    ['notifiche_dispatch_tick', 'notifiche_promemoria_tick', 'mensa_check_allergie_giornaliero', 'fatture_sdi_sync_tick'],
  ],
])

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/**
 * Via i commenti prima di cercare `SECURITY DEFINER`.
 *
 * Il lock cercava la stringa nel file intero, prosa compresa: una migrazione che
 * NON crea nessuna funzione ma SPIEGA nel proprio commento perché passa da
 * `current_parent_student_ids()` (che è `SECURITY DEFINER`) veniva accusata di non
 * revocare l'EXECUTE di una funzione che non esiste. Un lock che punisce chi
 * documenta insegna a non documentare — e, peggio, la scorciatoia per farlo tacere
 * è scrivere la parola in modo diverso, cioè nascondere proprio l'informazione che
 * il lock esiste per sorvegliare. Qui si guarda l'SQL che viene eseguito.
 */
function sqlSenzaCommenti(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * L'SQL spezzato in statement, rispettando le stringhe `'…'` e i corpi `$$…$$` / `$tag$…$tag$`.
 *
 * È il pezzo che rende il lock diverso da un `grep`. Cercare `REVOKE … anon` nel file intero
 * significa accettare come prova una stringa che sta in un ALTRO comando: un
 * `REVOKE … FROM PUBLIC` seguito da un `GRANT … TO authenticated` è, per una regex sul file,
 * indistinguibile da una revoca. Il punto e virgola è il confine oltre il quale una parola
 * smette di parlare del comando precedente — e va cercato fuori dai corpi delle funzioni, che
 * di punti e virgola ne contengono a decine.
 */
function statementSql(sql: string): string[] {
  const fuori: string[] = []
  let corrente = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j++
      }
      corrente += sql.slice(i, Math.min(j + 1, sql.length))
      i = j + 1
      continue
    }
    if (c === '$') {
      const apertura = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))
      if (apertura) {
        const tag = apertura[0]
        const fine = sql.indexOf(tag, i + tag.length)
        const j = fine === -1 ? sql.length : fine + tag.length
        corrente += sql.slice(i, j)
        i = j
        continue
      }
    }
    if (c === ';') {
      fuori.push(corrente)
      corrente = ''
      i++
      continue
    }
    corrente += c
    i++
  }
  fuori.push(corrente)
  return fuori.filter((s) => s.trim().length > 0)
}

/** Identificatore SQL: nudo o fra virgolette. */
const NOME = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`

/** `public.f` → `f`. Lo schema non entra nel confronto: le funzioni del repo vivono in `public`. */
function nomeSemplice(qualificato: string): string {
  const pezzi = qualificato.split('.')
  return (pezzi[pezzi.length - 1] ?? '').trim().replace(/"/g, '').toLowerCase()
}

/** Le voci di un elenco SQL separate da virgola, ignorando le virgole dentro le parentesi
 *  (una firma è `f(uuid, int)`: la virgola dei tipi non separa due funzioni). */
function separaLivelloZero(testo: string): string[] {
  const voci: string[] = []
  let corrente = ''
  let profondita = 0
  for (const c of testo) {
    if (c === '(') profondita++
    if (c === ')') profondita--
    if (c === ',' && profondita === 0) {
      voci.push(corrente)
      corrente = ''
      continue
    }
    corrente += c
  }
  voci.push(corrente)
  return voci.map((v) => v.trim()).filter(Boolean)
}

/**
 * I nomi delle funzioni **definite come `SECURITY DEFINER` da questo statement**.
 *
 * Il legame fra la clausola e il comando che la porta è ciò che tiene il lock onesto in
 * entrambe le direzioni. Da un lato non basta NOMINARE `SECURITY DEFINER` dentro un
 * `COMMENT ON … IS '…'` — spiegare a chi legge il database perché una policy passa da
 * `current_parent_student_ids()` — per essere accusati di non aver revocato una funzione mai
 * creata. Dall'altro il privilegio non si acquista solo creando: `ALTER FUNCTION … SECURITY
 * DEFINER` promuove una funzione già esistente e non contiene nessuna `CREATE`. Cercare la
 * `CREATE` come conferma obbligatoria — la forma del lock fino al 2026-07-31 — rendeva quella
 * seconda strada invisibile: una migrazione che promuove e non revoca passava il gate.
 */
function definizioniSecurityDefiner(statement: string): string[] {
  if (!/SECURITY\s+DEFINER/i.test(statement)) return []
  const re = new RegExp(
    String.raw`\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|ALTER\s+FUNCTION)\s+((?:${NOME}\s*\.\s*)?${NOME})`,
    'gi',
  )
  return [...statement.matchAll(re)].map((m) => nomeSemplice(m[1]))
}

/** I nomi delle funzioni eliminate da questo statement (`DROP FUNCTION`): con la funzione
 *  sparisce la sua ACL, quindi un REVOKE precedente non vale più per quella ricreata dopo. */
function eliminazioni(statement: string): string[] {
  const re = new RegExp(String.raw`\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?((?:${NOME}\s*\.\s*)?${NOME})`, 'gi')
  return [...statement.matchAll(re)].map((m) => nomeSemplice(m[1]))
}

type Concessione = {
  verso: 'revoke' | 'grant'
  tutteLeFunzioni: boolean
  funzioni: string[]
  anon: boolean
  authenticated: boolean
}

/**
 * Che cosa fa questo statement ai privilegi di `anon`/`authenticated` su una FUNZIONE.
 *
 * Tre cose che una regex sul file non sa distinguere e qui contano:
 * — un `REVOKE … ON TABLE …` non revoca l'EXECUTE di nessuna funzione;
 * — un `REVOKE` che nomina la funzione `f` non copre la `g` definita accanto;
 * — un `GRANT` è l'operazione inversa, e vale quanto un REVOKE: se arriva dopo, riapre.
 */
function concessione(statement: string): Concessione | null {
  const m = /^\s*(REVOKE|GRANT)\b([\s\S]*?)\b(?:FROM|TO)\b([\s\S]*)$/i.exec(statement)
  if (!m) return null
  const bersaglio = m[2]
  const ruoli = m[3]
  const anon = /\banon\b/i.test(ruoli)
  const authenticated = /\bauthenticated\b/i.test(ruoli)
  if (!anon && !authenticated) return null
  const verso = m[1].toUpperCase() === 'REVOKE' ? 'revoke' : 'grant'
  if (/\bON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\b/i.test(bersaglio)) {
    return { verso, tutteLeFunzioni: true, funzioni: [], anon, authenticated }
  }
  const suFunzione = /\bON\s+FUNCTION\b([\s\S]*)$/i.exec(bersaglio)
  if (!suFunzione) return null // tabella, sequenza, schema: non è l'EXECUTE di una funzione
  const funzioni = separaLivelloZero(suFunzione[1])
    .map((voce) => new RegExp(String.raw`^\s*((?:${NOME}\s*\.\s*)?${NOME})`).exec(voce))
    .filter((esito): esito is RegExpExecArray => esito !== null)
    .map((esito) => nomeSemplice(esito[1]))
  return { verso, tutteLeFunzioni: false, funzioni, anon, authenticated }
}

/**
 * Quali funzioni `SECURITY DEFINER` definite in questo SQL restano eseguibili da
 * `anon` o `authenticated` — **per nome**, non «una funzione di questo file».
 *
 * Si rilegge lo statement in ordine tenendo il conto dei privilegi funzione per funzione:
 * l'ultimo comando che parla di quella funzione è quello che vale. Il confronto è sul NOME,
 * non sulla firma, perché il REVOKE si scrive coi soli tipi (`f(uuid, int)`) mentre la CREATE
 * ha anche i nomi dei parametri (`f(p_scuola uuid, p_anno int)`): pretendere l'uguaglianza
 * della firma trasformerebbe il lock in un generatore di falsi rossi. Il limite che ne segue è
 * dichiarato: due overload omonimi si coprono a vicenda.
 */
function funzioniSenzaRevoke(testo: string): string[] {
  let definite: string[] = []
  const revocato = new Map<string, { anon: boolean; authenticated: boolean }>()
  const privilegi = (nome: string) => revocato.get(nome) ?? { anon: false, authenticated: false }

  for (const statement of statementSql(sqlSenzaCommenti(testo))) {
    for (const nome of eliminazioni(statement)) {
      revocato.delete(nome)
      definite = definite.filter((d) => d !== nome)
    }
    for (const nome of definizioniSecurityDefiner(statement)) {
      if (!definite.includes(nome)) definite.push(nome)
    }
    const atto = concessione(statement)
    if (!atto) continue
    const revoca = atto.verso === 'revoke'
    const bersagli = atto.tutteLeFunzioni ? [...new Set([...revocato.keys(), ...definite])] : atto.funzioni
    for (const nome of new Set(bersagli)) {
      const prima = privilegi(nome)
      revocato.set(nome, {
        anon: atto.anon ? revoca : prima.anon,
        authenticated: atto.authenticated ? revoca : prima.authenticated,
      })
    }
  }

  // Revocare al solo `anon` non basta: `authenticated` è ogni utente loggato, e un genitore
  // con la propria sessione è un utente loggato.
  return definite.filter((nome) => {
    const p = privilegi(nome)
    return !(p.anon && p.authenticated)
  })
}

/** Tutte le `SECURITY DEFINER` definite nel file, revocate o no (serve a scegliere i file da controllare). */
function funzioniSecurityDefiner(testo: string): string[] {
  const nomi: string[] = []
  for (const statement of statementSql(sqlSenzaCommenti(testo))) {
    for (const nome of definizioniSecurityDefiner(statement)) if (!nomi.includes(nome)) nomi.push(nome)
  }
  return nomi
}

describe('il lock guarda la cosa, non la traccia della cosa', () => {
  it('CREATE … SECURITY DEFINER senza REVOKE → la funzione è scoperta, e il lock sa dirne il nome', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;`),
    ).toEqual(['f'])
  })

  it('ALTER FUNCTION … SECURITY DEFINER senza REVOKE → scoperta (si promuove anche così)', () => {
    expect(funzioniSenzaRevoke('alter function public.f(uuid) security definer;')).toEqual(['f'])
  })

  it('il REVOKE non attraversa il punto e virgola: `FROM PUBLIC` + un GRANT ad authenticated più sotto non è una revoca', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;
       revoke all on function public.f() from public;
       grant select on table public.t to authenticated;`),
    ).toEqual(['f'])
  })

  it('un REVOKE su una TABELLA non revoca l’EXECUTE della funzione', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;
       revoke all on table public.t from anon, authenticated;`),
    ).toEqual(['f'])
  })

  it('due funzioni, un solo REVOKE → resta scoperta quella che nessuno ha nominato', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;
       create or replace function public.g() returns void
         language plpgsql security definer as $$ begin end; $$;
       revoke all on function public.f() from public, anon, authenticated;`),
    ).toEqual(['g'])
  })

  it('revocare al solo `anon` lascia dentro ogni utente loggato: non basta', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;
       revoke execute on function public.f() from public, anon;`),
    ).toEqual(['f'])
  })

  it('la clausola nominata dentro una stringa SQL non definisce niente (COMMENT ON … IS …)', () => {
    expect(
      funzioniSenzaRevoke(`comment on policy p on public.t is
         'passa da current_parent_student_ids() (SECURITY DEFINER, salta la RLS)';
       create or replace function public.innocua() returns int language sql as $$ select 1 $$;`),
    ).toEqual([])
  })

  it('un GRANT più sotto riapre quello che il REVOKE aveva chiuso: vale l’ultimo, non il primo', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;
       revoke all on function public.f() from public, anon, authenticated;
       grant execute on function public.f() to authenticated;`),
    ).toEqual(['f'])
  })

  it('un DROP azzera i privilegi: il REVOKE di prima non vale per la funzione ricreata dopo', () => {
    expect(
      funzioniSenzaRevoke(`revoke all on function public.f() from public, anon, authenticated;
       drop function if exists public.f();
       create function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;`),
    ).toEqual(['f'])
  })

  it('`ALTER FUNCTION … OWNER TO postgres` non promuove niente (la baseline ne è piena)', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;
       revoke all on function public.f() from public, anon, authenticated;
       alter function public.f() owner to postgres;`),
    ).toEqual([])
  })

  // ── Controlli positivi: il lock non deve diventare severo a vuoto ──────────
  it('il REVOKE vale anche se la firma è scritta con i soli tipi (è così in tutto il repo)', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f(p_scuola uuid, p_anno int) returns int
         language plpgsql security definer as $$ begin return 1; end; $$;
       revoke execute on function public.f(uuid, int) from public;
       revoke execute on function public.f(uuid, int) from anon, authenticated;`),
    ).toEqual([])
  })

  it('una funzione senza SECURITY DEFINER non è affare di questo lock', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns int language sql as $$ select 1 $$;`),
    ).toEqual([])
  })

  it('`REVOKE … ON ALL FUNCTIONS IN SCHEMA public` copre anche quella appena creata', () => {
    expect(
      funzioniSenzaRevoke(`create or replace function public.f() returns void
         language plpgsql security definer as $$ begin end; $$;
       revoke all on all functions in schema public from public, anon, authenticated;`),
    ).toEqual([])
  })
})

describe('lock architettura · SECURITY DEFINER senza EXECUTE per anon/authenticated', () => {
  const migrazioni = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, testo: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }))

  const conSecurityDefiner = migrazioni.filter((m) => funzioniSecurityDefiner(m.testo).length > 0)

  it('esistono migrazioni con SECURITY DEFINER da controllare (sanity)', () => {
    expect(conSecurityDefiner.length).toBeGreaterThan(0)
  })

  for (const { file, testo } of conSecurityDefiner) {
    it(`${file}: ogni SECURITY DEFINER ha il suo REVOKE per anon E authenticated`, () => {
      const ammesse = AMMESSE.get(file) ?? []
      const scoperte = funzioniSenzaRevoke(testo).filter((fn) => !ammesse.includes(fn))
      expect(
        scoperte,
        `${file} definisce ${scoperte.length === 1 ? 'una funzione SECURITY DEFINER' : 'funzioni SECURITY DEFINER'} ` +
          `senza revocarne l'EXECUTE ad anon e authenticated: ${scoperte.join(', ')}. ` +
          `In Supabase REVOKE ... FROM PUBLIC non basta (anon/authenticated ricevono l'EXECUTE per GRANT ` +
          `esplicito): aggiungi, per OGNUNA, ` +
          `"REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC, anon, authenticated;" ` +
          `(+ "GRANT EXECUTE ON FUNCTION public.<fn>(...) TO service_role;"). ` +
          `Se una di esse è legittimamente per authenticated (usa auth.uid() e ritorna il solo scope del ` +
          `chiamante), aggiungi QUELLA funzione — non il file — ad AMMESSE, con la motivazione scritta.`,
      ).toEqual([])
    })
  }

  it('nessuna eccezione di AMMESSE è morta: un permesso che non serve più acceca il lock', () => {
    // Il rischio di ogni allowlist è invecchiare in una direzione sola: la funzione viene
    // revocata davvero, la riga resta, e da quel momento il lock non guarda più un pezzo di
    // repo che nessuno gli ha chiesto di ignorare. Qui l'eccezione deve ancora servire.
    const morte: string[] = []
    for (const [file, funzioni] of AMMESSE) {
      const migrazione = migrazioni.find((m) => m.file === file)
      if (!migrazione) {
        morte.push(`${file} (migrazione inesistente)`)
        continue
      }
      const scoperte = funzioniSenzaRevoke(migrazione.testo)
      for (const fn of funzioni) if (!scoperte.includes(fn)) morte.push(`${file} → ${fn}`)
    }
    expect(morte, `eccezioni di AMMESSE che non servono più (toglierle): ${morte.join(' · ')}`).toEqual([])
  })
})
