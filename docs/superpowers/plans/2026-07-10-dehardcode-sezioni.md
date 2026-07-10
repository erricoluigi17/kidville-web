# De-hardcode sezioni/dati dinamici + Anagrafica di sede (multi-sede) — Piano di implementazione

> **Per gli agenti esecutori:** SUB-SKILL RICHIESTA: usare superpowers:executing-plans (esecuzione inline in questa sessione, con checkpoint). Gli step usano checkbox `- [ ]`. All'avvio dell'esecuzione, copiare questo piano anche in `docs/superpowers/plans/2026-07-10-dehardcode-sezioni.md` (convenzione writing-plans).

**Goal:** (1) eliminare tutti i valori "di realtà" scritti fissi nel codice runtime (nomi sezione, anno scolastico, città, mapping email→sezione, liste classi finte) facendoli derivare dal DB/helper di scoping; (2) garantire che tutto funzioni in ottica MULTI-SEDE (oggi solo Giugliano, domani altre) aggiungendo un'**anagrafica di sede** completa (indirizzo, codice meccanografico, contatti…) gestibile dal pannello Direzione e usata nei certificati. Verifica con journey assertiva ≥50 loop verdi + gate completi.

**Architettura:** fix client con il pattern collaudato del locker (stato `''` + fetch `/api/educator-sections`); fix server con degrado a vuoto (mai nomi cablati); 3 nuovi moduli puri testabili (`anno-scolastico`, `certificati/self-service`, `scuole/anagrafica`); anagrafica sede in `scuole.config.anagrafica` (JSONB già esistente → **zero migrazioni DB**) con merge server-side nel PATCH (pattern Settings Hub) e form nel `SchoolsPanel`; `/api/parent/students` arricchita per-figlio con i dati della SUA scuola (multi-sede by design).

**Stack:** Next.js App Router + Supabase (service-role nelle route, gate requireStaff/requireDocente/requireUser, zod), vitest (`__tests__/lib/`), Playwright harness `e2e/primaria-360`.

**Vincoli assoluti:** branch `feat/logout-anagrafica-fullscreen` (MAI main, MAI branch nuovi) · **NESSUN commit e nessun deploy senza richiesta esplicita dell'utente** (le istruzioni utente prevalgono sui "frequent commits" della skill) · nessuna migrazione DB (design senza DDL; nessun UPDATE ai dati della sede reale — la scrittura di test avviene sulla sede "Kidville E2E" già esistente in prod) · `utenti.role/first_name/last_name` sono colonne GENERATE, mai scriverle · gate sempre dalla ROOT del repo · aggiornare `PRD REGISTRO ELETTRONICO.md` a fine lavoro.

---

## Contesto (perché questo lavoro)

Il test 360° ha rivelato che in alcuni punti l'app non legge i dati dal database ma usa valori scritti a mano nel codice, ereditati dal prototipo iniziale (scuola d'infanzia con sezioni Girasoli/Tulipani/…). Con la sede reale unica (Kidville Giugliano) e la classe primaria TEST 1A, questi valori producono schermate e documenti SBAGLIATI (es. certificato che dice "sezione dei Girasoli" e "Milano"). Inoltre l'utente ha chiesto di predisporre il sistema al multi-sede: ogni dato di sede (nome, indirizzo, codice meccanografico, contatti) deve avere una casa nel DB, essere gestibile da pannello e alimentare i documenti — mai essere scritto nel codice.

## Spiegazione in italiano semplice (tutti i passaggi)

**Il problema.** Immagina un modulo prestampato dove qualcuno, invece di lasciare gli spazi vuoti da riempire, ha già scritto a penna "classe Girasoli", "anno 2026/2027", "Milano". Chiunque usi quel modulo si ritrova quei dati, anche se suo figlio è in TEST 1A a Giugliano. Nel codice dell'app ci sono 6 situazioni così, più una mancanza strutturale:

1. **Bacheca avvisi del docente** — quando un docente crea un avviso "per classe", l'app gli propone un elenco di classi finto scritto nel codice (Girasoli, Margherite, Tulipani, 3A, 4B) invece delle SUE classi vere. In più, le statistiche di lettura degli avvisi vengono calcolate su quell'elenco finto.
2. **Certificati scaricabili dal genitore** — il certificato di frequenza dice sempre "sezione dei Girasoli", quello di iscrizione dice sempre "anno scolastico 2026/2027", ed entrambi dicono "Milano, lì …" anche se la scuola è a Giugliano.
3. **Pagina Foto del docente** — all'apertura parte già impostata su "Girasoli" e, se il docente non ha classi assegnate, resta su Girasoli per sempre.
4. **Quattro "porte di servizio" (API)** — se qualcuno le chiama senza dire quale classe vuole, rispondono con i dati di "Girasoli" invece di rispondere "niente". Oggi nessuna schermata le chiama così, ma è una porta lasciata socchiusa.
5. **Due indirizzi email cablati** — in due punti il codice dice "se il docente è maestra.anna@… allora la sua classe è Girasoli". Ho verificato nel database di produzione: quegli indirizzi NON esistono e tutti i docenti veri hanno il legame classe registrato nella tabella apposita. È un residuo morto ma pericoloso.
6. **Tre file vecchi mai usati** — resti del primo registro voti, con la classe "3A" scritta fissa. Nessuna pagina li usa: vanno cancellati (hai confermato tu).
7. **Manca l'anagrafica della sede** (tua richiesta) — oggi nel database ogni sede ha solo nome, città e indirizzo. Mancano codice meccanografico, CAP, provincia, telefono, email, PEC, ecc. E i documenti non usano nemmeno quel poco che c'è: l'intestazione del certificato è fissa.

**Cosa farò, passo per passo:**

- **Passo 1 — Fondamenta.** Creo tre piccoli "mattoni" riutilizzabili e testati: ① un calcolatore dell'anno scolastico con la TUA regola (l'anno va da settembre a luglio: fino al 31 luglio vale l'anno in corso, dal 1° agosto scatta il nuovo → oggi 10/7/2026 = "2025/2026"); ② un compositore del testo dei certificati che usa la classe vera del bambino, l'anno calcolato e i dati veri della scuola; ③ un lettore/validatore dell'anagrafica di sede. Per ognuno scrivo subito i test automatici.
- **Passo 2 — L'anagrafica di sede.** Ogni sede avrà una scheda anagrafica completa: denominazione ufficiale, codice meccanografico, indirizzo, CAP, città, provincia, telefono, email, PEC, P.IVA/CF. La salvo nel campo "config" che la tabella sedi HA GIÀ (quindi niente modifiche alla struttura del database, zero rischi). Nel pannello **Impostazioni → Gestione Multi-Sede** ogni sede avrà un bottone "Anagrafica" che apre il modulo per compilare questi dati. Il salvataggio è protetto (solo Direzione) e non cancella le altre impostazioni della sede (unione lato server). Per la sede di Giugliano: i dati veri li inserisci tu dal pannello (o me li detti e li inserisco io); i test scriveranno solo sulla sede fittizia "Kidville E2E" che esiste già.
- **Passo 3 — Il server dice la verità (multi-sede by design).** L'elenco figli che il server dà al genitore includerà, PER CIASCUN FIGLIO, i dati della SUA scuola (nome, città, indirizzo, codice meccanografico): due fratelli in sedi diverse avranno ciascuno i dati giusti. Le 4 API col difetto del punto 4 risponderanno "lista vuota" invece di "Girasoli". Le due mappe email→classe spariscono: si legge la tabella ufficiale docente↔classe.
- **Passo 4 — Le schermate leggono dal server.** La bacheca avvisi del docente chiede al server le SUE classi vere (stesso meccanismo già collaudato per l'armadietto). La pagina Foto parte "vuota" e si riempie con la classe vera. Il certificato del genitore usa: classe vera del figlio, anno calcolato, e in intestazione i dati veri della sede (nome, indirizzo, codice meccanografico — le righe mancanti si omettono, mai dati inventati); "Milano" sparisce a favore della città vera.
- **Passo 5 — Pulizia.** Cancello i 3 file vecchi con "3A" (dopo aver ricontrollato che nessuno li richiami).
- **Passo 6 — Collaudo.** Scrivo un nuovo test automatico (journey 90) che entra nell'app come docente della TEST 1A, come genitore e come segreteria: controlla che la bacheca proponga "TEST 1A" e MAI "Girasoli", che la pagina Foto mostri la classe vera, che il certificato si scarichi e i dati che lo alimentano siano giusti ("TEST 1A", "Giugliano"), che le API senza parametro rispondano vuoto, e che l'anagrafica di sede si salvi e si rilegga correttamente (sulla sede di test E2E). Lo ripeto 50 volte di fila: deve essere sempre verde; al primo rosso mi fermo, trovo la causa e riparto da capo. Poi rilancio i test di copertura generale (70-71-72 e 89), rigenero il report e passo i 4 controlli di qualità (lint, test, tipi, build).
- **Passo 7 — Documentazione.** Aggiorno il PRD con l'elenco di cosa era cablato, come ora deriva dal DB, e la nuova anagrafica di sede. **Non faccio commit né deploy**: te li lascio decidere.

**Cosa NON tocco (e perché):** i valori di default degli orari/soglie configurabili dall'admin (il DB viene già letto prima: ripieghi legittimi); i testi d'esempio "Es. Girasoli" nei campi da compilare; le route di seed/test; il fatto che il certificato esca sempre per il PRIMO figlio (comportamento esistente, fuori scope — lo segnalo); la configurazione SIDI globale (il suo codice meccanografico resta dov'è per non rompere l'integrazione ministeriale: nel PRD segnalo il futuro raccordo per-sede).

---

## Tabella audit completa (verdetti A/B/C)

Categoria: **A** = bug reale (cablato che finisce a schermo/scope/documento) · **B** = fallback benigno (DB letto prima / default irraggiungibile) · **C** = non-codice (commenti, placeholder, seed, dead code).

| # | file:riga | valore cablato | cat | perché | esito |
|---|---|---|---|---|---|
| 1 | `teacher/avvisi/page.tsx:10` | `AVAILABLE_CLASSES=['Girasoli','Margherite','Tulipani','3A','4B']` | **A** | lista finta → destinatari avviso + statistiche drawer | FIX T7 |
| 2 | `parent/modulistica/page.tsx:417` | "nella sezione dei Girasoli" | **A** | PDF frequenza sempre Girasoli; `classe_sezione` reale scartato dal tipo state | FIX T9 |
| 3 | `parent/modulistica/page.tsx:416` | "anno scolastico 2026/2027" | **A** | PDF iscrizione, anno fisso | FIX T1a+T9 |
| 4 | `parent/modulistica/page.tsx:424` | "Milano, lì" | **A** (nuovo, non in seed-list) | città sbagliata nel PDF; `scuole.citta`='Giugliano' disponibile in DB | FIX T2+T9 |
| 5 | `parent/modulistica/page.tsx:397` | intestazione PDF fissa (nessun dato sede) | **A** (ottica multi-sede) | il certificato non identifica la sede emittente | FIX T15-T17 (anagrafica) |
| 6 | `teacher/gallery/page.tsx:43` | `useState('Girasoli')` | **A** (minore) | fetch transitorio `?sezione=Girasoli` al mount; persiste con 0 sezioni | FIX T8 |
| 7 | `api/attendance/daily:20` · `attendance/monthly:33` · `diary/entries:21` | `.default('Girasoli')` | **A latente** | raggiungibile solo omettendo il param (nessun caller in-repo lo fa: verificato; `?sezione=` vuoto NON attiva il default per semantica parseQuery) | FIX T3 → `default('')` |
| 8 | `api/diary/students:75` | `?? 'Girasoli'` | **A latente** | idem | FIX T3 → `?? ''` |
| 9 | `api/tasks/route.ts:315-317` | mappa `maestra.anna/chiara@kidville.it → Girasoli/Tulipani` | **A latente** | fallback scope task; email INESISTENTI in prod (verificato via MCP), tutti i docenti hanno `utenti_sezioni` | FIX T4 → canonico |
| 10 | `api/educator-sections:89-91` | stessa mappa (Method 3) | **A latente** | ultimo di 4 metodi; stessa evidenza DB | FIX T5 → rimozione |
| 11 | `api/tasks/meta/route.ts:68` | `let classes=['Girasoli',…]` | B→irrobustito | sovrascritto da sections/alunni; resta solo con DB vuoto | FIX T6 → `[]` |
| 12 | `MonthlyAttendanceTable.tsx:244` (in `features/teacher/attendance/`) | prop `sezione='Girasoli'` | B (morto) → irrobustito | unico caller passa sempre la prop | FIX T10 → `''` |
| 13 | `AvvisoDetailsDrawer.tsx:19` · `AvvisoDetailsContent.tsx:37` | default param lista finta | B (morto) → irrobustito | i caller passano sempre la prop | FIX T7 → `[]` |
| 14 | `features/teacher/register/{GradesTab,NotesTab,LessonsTab}.tsx` | `CLASSE_SEZIONE='3A'` | **C** (dead code) | zero import nel repo; pagina register = redirect | DELETE T11 (deciso dall'utente) |
| 15 | `AvvisoForm.tsx:23` | — | ok | default GIÀ `[]` (scoperta in esplorazione) | nessuna modifica |
| 16 | Default orari/soglie config (`chat/config` 08:00/17:00, mensa 09:30, `timelock` 2/15, `oreAssenza` 08:30-13:30, TaskForm 23:59, OrarioManager 08:30) | vari | **B** | `admin_settings`/DB letto prima; default documentati dell'editor | documentati, nessuna modifica |
| 17 | Route seed (`seed-full`, `seed-db`: UUID 11111111-*, sezioni, email @example) · `test-relations` (id test, sealDangerous) · template CSV | vari | **C** | non-runtime utente / sigillate | documentati |
| 18 | Placeholder UI ("Es. Girasoli" in SectionsView:138, anagrafica-fields:118) · commenti/JSDoc `?sezione=Girasoli` · commenti "già de-cablato" | vari | **C** | solo testo d'esempio | documentati (aggiorno solo i commenti delle route toccate da T3) |
| 19 | `STANDARD_ENROLLMENT_MODEL_ID` (f0000000-…) · `.neq('id','00000000-…')` wipe · VAPID mailto fallback | vari | **B** | identità applicativa fissa / idiomi tecnici | documentati |
| 20 | Duplicazioni calcolo anno scolastico (`appello/page.tsx:24` mese≥8, `GeneratoreRette.tsx:15` mese≥9, PaymentsDashboard:64, ScrutinioPeriodiManager:12) | formule locali | **B** (nota) | micro-incoerenza solo in agosto tra le due formule | NON toccati (scope creep); nasce l'helper T1a per i NUOVI usi; follow-up nel PRD |
| 21 | `sidi_config.codice_meccanografico` (admin_settings, globale) | config, non hardcode | **B** (nota multi-sede) | il client SIDI legge config/env; per-sede andrà raccordato all'anagrafica quando ci sarà >1 sede accreditata | NON toccato; follow-up nel PRD |

Falsi positivi noti da NON confondere: dati `[E2E360]`/"AlunnoN", indicatore dev Next.js, date-input nativi en-US del browser headless.

---

## Decisioni prese con l'utente

1. **Anno scolastico**: va da settembre a luglio → `mese ≥ 8 → "y/y+1"`, altrimenti `"y-1/y"`. Oggi → "2025/2026" (il certificato di iscrizione cambia output rispetto all'hardcode "2026/2027": intenzionale).
2. **Città certificato**: dal DB (`scuole.citta`), degrado a "Lì <data>" senza città.
3. **File morti '3A'**: cancellarli.
4. **Multi-sede + anagrafica di sede** (richiesta al review del piano): anagrafica completa per sede (indirizzo, codice meccanografico, ecc.), gestibile da pannello, usata nei certificati; tutte le fix devono essere corrette con N sedi.

## Garanzie multi-sede (come ogni fix regge con N sedi)

- **Certificati**: i dati sede sono risolti PER FIGLIO dal suo `alunni.scuola_id` (mappa `scuolaById` per riga) → fratelli in sedi diverse = certificati con intestazioni diverse. Nessun "prima sede attiva".
- **Avvisi/Gallery/Locker**: classi da `/api/educator-sections` = legami `utenti_sezioni` del singolo docente (cross-sede se il docente opera su più plessi, già supportato).
- **Task**: scope da `nomiSezioniDiUtente` (canonico per utente), non da email né da liste globali.
- **Anagrafica**: una scheda per riga di `scuole`, CRUD via `/api/admin/schools` (che già lista tutte le sedi); il pannello mostra e modifica ogni sede separatamente.
- **Nessun UUID di sede cablato** viene introdotto: le costanti d'ambiente (Giugliano, TEST 1A) restano SOLO nel harness e2e (`config/accounts.ts`), che è fuori runtime.

## Ordine di esecuzione

```
FASE 1 (fondamenta):   T1a T1b T1c (helper) → T1d (unit test) · T15a (helper anagrafica) → T15b (unit test)
FASE 2 (server):       T2 (parent/students+scuola per figlio) · T3 (default zod ×4) · T4 (tasks, dipende T1c) · T5 (educator-sections) · T6 (tasks/meta) · T15c (PATCH schools merge anagrafica)
FASE 3 (client):       T7 (avvisi) · T8 (gallery) · T9 (modulistica: certificato con sede reale, dipende T1/T2/T15) · T10 (MonthlyAttendanceTable) · T16 (SchoolsPanel form anagrafica)
FASE 4 (pulizia):      T11 (delete file morti)
FASE 5 (collaudo):     T12 (journey 90 D1-D9 + loop) · T13 (loop 50× + sweep + report + gate)
FASE 6 (docs):         T14 (PRD changelog)
```
Checkpoint gate intermedi: dopo FASE 1 (`npx vitest run` verde con i nuovi test), dopo FASE 3 (`npx eslint . --max-warnings 0` + `npx tsc --noEmit`).

---

### Task T1 — Fondamenta: helper puri + unit test

**Files:**
- Create: `src/lib/anno-scolastico.ts`
- Create: `src/lib/certificati/self-service.ts` (la dir esiste già: contiene `stato.ts`)
- Modify: `src/lib/sezioni/docenti.ts` (append helper `nomiSezioniDiUtente` dopo `sezioniDiUtente`)
- Test: `__tests__/lib/anno-scolastico.test.ts`, `__tests__/lib/certificati-self-service.test.ts` (convenzione: test alla ROOT in `__tests__/lib/`, alias `@/` → `./src`)

- [ ] **T1a** `src/lib/anno-scolastico.ts`:
```ts
// Anno scolastico italiano: va da settembre a luglio (agosto fa già da ponte
// verso il nuovo anno). Regola: mese >= 8 (agosto) → `${y}/${y+1}`,
// altrimenti `${y-1}/${y}`. Es. 10 lug 2026 → "2025/2026"; 1 ago 2026 → "2026/2027".
export function annoScolasticoCorrente(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1 // 1..12
  return m >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`
}
```
- [ ] **T1b** `src/lib/certificati/self-service.ts` (include l'intestazione sede per T17):
```ts
export interface AlunnoCertificato {
  nome: string
  cognome: string
  classe_sezione?: string | null
}

export interface SedeCertificato {
  scuola_nome?: string | null
  scuola_indirizzo?: string | null
  scuola_cap?: string | null
  scuola_citta?: string | null
  scuola_provincia?: string | null
  scuola_codice_meccanografico?: string | null
}

export function buildCertificatoBody(
  type: 'iscrizione' | 'frequenza',
  s: AlunnoCertificato,
  anno: string
): string {
  if (type === 'iscrizione') {
    return `Si certifica che l'alunno/a ${s.cognome} ${s.nome} risulta regolarmente iscritto/a presso questa istituzione scolastica per l'anno scolastico ${anno}.`
  }
  // Clausola sezione solo se disponibile; "nella sezione X" (non "dei X":
  // con nomi tipo "TEST 1A" il partitivo è sgrammaticato).
  const sezione = s.classe_sezione?.trim()
  const clausolaSezione = sezione ? ` nella sezione ${sezione}` : ''
  return `Si certifica che l'alunno/a ${s.cognome} ${s.nome} frequenta regolarmente le attività didattiche di questa scuola${clausolaSezione} per l'anno scolastico ${anno}.`
}

// Righe di intestazione sede per il PDF (multi-sede): solo dati reali dal DB,
// righe omesse se mancanti — mai valori inventati.
export function buildIntestazioneSede(sede: SedeCertificato): string[] {
  const righe: string[] = []
  const nome = sede.scuola_nome?.trim()
  if (nome) righe.push(nome)
  const luogo = [
    sede.scuola_indirizzo?.trim(),
    [sede.scuola_cap?.trim(), sede.scuola_citta?.trim()].filter(Boolean).join(' '),
    sede.scuola_provincia?.trim() ? `(${sede.scuola_provincia!.trim()})` : '',
  ].filter(Boolean).join(' — ').replace(' — (', ' (')
  if (luogo) righe.push(luogo)
  const mecc = sede.scuola_codice_meccanografico?.trim()
  if (mecc) righe.push(`Cod. Mecc. ${mecc}`)
  return righe
}

// "<Città>, lì <data>" oppure "Lì <data>" se la città non è in DB.
export function rigaLuogoData(citta: string | null | undefined, dataIt: string): string {
  const c = citta?.trim()
  return c ? `${c}, lì ${dataIt}` : `Lì ${dataIt}`
}
```
- [ ] **T1c** `src/lib/sezioni/docenti.ts` — append (il file si dichiara già "fonte canonica che sostituisce le mappe email→sezione"; `sezioniDiUtente` esistente ritorna **id**, serve la variante nomi):
```ts
// Nomi (sections.name) delle sezioni assegnate a un utente — fonte canonica
// utenti_sezioni → sections. Nessun fallback euristico: senza legami → [].
export async function nomiSezioniDiUtente(supabase: SupabaseClient, utenteId: string): Promise<string[]> {
  const { data } = await supabase
    .from('utenti_sezioni')
    .select('sections(name)')
    .eq('utente_id', utenteId)
  type Row = { sections: { name?: string | null }[] | { name?: string | null } | null }
  return [...new Set(
    ((data ?? []) as Row[]).flatMap((r) => {
      const s = r.sections
      if (!s) return []
      return (Array.isArray(s) ? s : [s]).map((x) => x.name)
    }).filter((n): n is string => Boolean(n))
  )]
}
```
(select embedded `sections(name)` già usata identica in educator-sections:29 — la FK esiste; errore query → `[]`.)
- [ ] **T1d** Unit test (prima FAIL, poi PASS dopo T1a/T1b):
```ts
// __tests__/lib/anno-scolastico.test.ts
import { describe, it, expect } from 'vitest'
import { annoScolasticoCorrente } from '@/lib/anno-scolastico'

describe('annoScolasticoCorrente — set→lug (ago = nuovo anno)', () => {
  it('luglio → anno in chiusura', () => {
    expect(annoScolasticoCorrente(new Date(2026, 6, 10))).toBe('2025/2026')
    expect(annoScolasticoCorrente(new Date(2026, 6, 31))).toBe('2025/2026')
  })
  it('agosto → nuovo anno', () => {
    expect(annoScolasticoCorrente(new Date(2026, 7, 1))).toBe('2026/2027')
  })
  it('set–dic → nuovo anno', () => {
    expect(annoScolasticoCorrente(new Date(2026, 8, 15))).toBe('2026/2027')
    expect(annoScolasticoCorrente(new Date(2026, 11, 31))).toBe('2026/2027')
  })
  it('gen–giu → anno iniziato l\'autunno prima', () => {
    expect(annoScolasticoCorrente(new Date(2027, 0, 1))).toBe('2026/2027')
    expect(annoScolasticoCorrente(new Date(2027, 5, 30))).toBe('2026/2027')
  })
  it('senza argomento usa oggi', () => {
    expect(annoScolasticoCorrente()).toMatch(/^\d{4}\/\d{4}$/)
  })
})
```
```ts
// __tests__/lib/certificati-self-service.test.ts
import { describe, it, expect } from 'vitest'
import { buildCertificatoBody, buildIntestazioneSede, rigaLuogoData } from '@/lib/certificati/self-service'

const anna = { nome: 'Anna', cognome: 'Bianchi', classe_sezione: 'TEST 1A' }

describe('buildCertificatoBody', () => {
  it('frequenza: sezione reale, niente partitivo, niente Girasoli', () => {
    const txt = buildCertificatoBody('frequenza', anna, '2025/2026')
    expect(txt).toContain("l'alunno/a Bianchi Anna")
    expect(txt).toContain('nella sezione TEST 1A')
    expect(txt).not.toContain('Girasoli')
    expect(txt).toContain("per l'anno scolastico 2025/2026")
  })
  it('frequenza senza classe: clausola omessa', () => {
    const txt = buildCertificatoBody('frequenza', { nome: 'Anna', cognome: 'Bianchi' }, '2025/2026')
    expect(txt).not.toContain('nella sezione')
    expect(txt).toContain("di questa scuola per l'anno scolastico 2025/2026")
  })
  it('classe vuota/spazi = assente', () => {
    expect(buildCertificatoBody('frequenza', { ...anna, classe_sezione: '  ' }, '2025/2026'))
      .not.toContain('nella sezione')
  })
  it('iscrizione: anno dinamico', () => {
    const txt = buildCertificatoBody('iscrizione', anna, '2025/2026')
    expect(txt).toContain('regolarmente iscritto/a')
    expect(txt).toContain("per l'anno scolastico 2025/2026.")
  })
})

describe('buildIntestazioneSede (multi-sede)', () => {
  it('sede completa → 3 righe con dati reali', () => {
    const righe = buildIntestazioneSede({
      scuola_nome: 'Kidville Giugliano', scuola_indirizzo: 'Via Roma 1', scuola_cap: '80014',
      scuola_citta: 'Giugliano', scuola_provincia: 'NA', scuola_codice_meccanografico: 'NA1E123456',
    })
    expect(righe).toHaveLength(3)
    expect(righe[0]).toBe('Kidville Giugliano')
    expect(righe[1]).toContain('Via Roma 1')
    expect(righe[1]).toContain('80014 Giugliano')
    expect(righe[1]).toContain('(NA)')
    expect(righe[2]).toBe('Cod. Mecc. NA1E123456')
  })
  it('due sedi diverse → intestazioni diverse (multi-sede)', () => {
    const a = buildIntestazioneSede({ scuola_nome: 'Sede A', scuola_citta: 'Giugliano' })
    const b = buildIntestazioneSede({ scuola_nome: 'Sede B', scuola_citta: 'Napoli' })
    expect(a[0]).toBe('Sede A'); expect(b[0]).toBe('Sede B')
    expect(a).not.toEqual(b)
  })
  it('dati mancanti → righe omesse, mai inventate', () => {
    expect(buildIntestazioneSede({})).toEqual([])
    expect(buildIntestazioneSede({ scuola_nome: 'Solo Nome' })).toEqual(['Solo Nome'])
  })
})

describe('rigaLuogoData', () => {
  it('con città dal DB', () => {
    expect(rigaLuogoData('Giugliano', '10/07/2026')).toBe('Giugliano, lì 10/07/2026')
  })
  it('degrado senza città', () => {
    expect(rigaLuogoData(null, '10/07/2026')).toBe('Lì 10/07/2026')
    expect(rigaLuogoData(undefined, '10/07/2026')).toBe('Lì 10/07/2026')
    expect(rigaLuogoData('  ', '10/07/2026')).toBe('Lì 10/07/2026')
  })
})
```
- [ ] Run: `npx vitest run __tests__/lib/anno-scolastico.test.ts __tests__/lib/certificati-self-service.test.ts` → PASS.

### Task T15 — Anagrafica di sede: modello dati + validazione + PATCH (ZERO migrazioni)

L'anagrafica vive in **`scuole.config.anagrafica`** (colonna JSONB GIÀ esistente in prod — verificata; pattern Settings Hub del progetto: config JSONB + merge server-side nel PATCH). `citta`/`indirizzo` restano le colonne esistenti.

**Files:**
- Create: `src/lib/scuole/anagrafica.ts`
- Modify: `src/app/api/admin/schools/route.ts` (schema PATCH + merge)
- Test: `__tests__/lib/scuole-anagrafica.test.ts`

- [ ] **T15a** `src/lib/scuole/anagrafica.ts`:
```ts
import { z } from 'zod'

// Anagrafica di sede (multi-sede): vive in scuole.config.anagrafica (JSONB).
// Tutti i campi opzionali: righe/documenti omettono ciò che manca.
export const zAnagraficaSede = z.object({
  denominazione: z.string().max(160).nullish(),          // ragione sociale/denominazione ufficiale
  codice_meccanografico: z.string().max(20).nullish(),
  cap: z.string().max(10).nullish(),
  provincia: z.string().max(4).nullish(),                // sigla, es. NA
  telefono: z.string().max(30).nullish(),
  email: z.string().max(160).nullish(),
  pec: z.string().max(160).nullish(),
  piva_cf: z.string().max(20).nullish(),                 // P.IVA / CF ente gestore
})
export type AnagraficaSede = z.infer<typeof zAnagraficaSede>

const CAMPI = ['denominazione', 'codice_meccanografico', 'cap', 'provincia', 'telefono', 'email', 'pec', 'piva_cf'] as const

/** Trim; stringhe vuote → null; codice meccanografico in maiuscolo (convenzione MIM). */
export function normalizzaAnagraficaSede(input: AnagraficaSede): AnagraficaSede {
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? '').trim()
    return t.length > 0 ? t : null
  }
  const out: Record<string, string | null> = {}
  for (const k of CAMPI) out[k] = clean(input[k])
  if (out.codice_meccanografico) out.codice_meccanografico = out.codice_meccanografico.toUpperCase()
  return out as AnagraficaSede
}

/** Estrazione safe da scuole.config (JSONB non tipizzato dal DB). */
export function parseAnagraficaSede(config: unknown): AnagraficaSede {
  const raw = (config as { anagrafica?: unknown } | null | undefined)?.anagrafica
  const parsed = zAnagraficaSede.safeParse(raw ?? {})
  return normalizzaAnagraficaSede(parsed.success ? parsed.data : {})
}
```
- [ ] **T15b** `__tests__/lib/scuole-anagrafica.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { normalizzaAnagraficaSede, parseAnagraficaSede } from '@/lib/scuole/anagrafica'

describe('normalizzaAnagraficaSede', () => {
  it('trim, vuoti → null, cod. mecc. maiuscolo', () => {
    const n = normalizzaAnagraficaSede({ codice_meccanografico: ' na1e123456 ', cap: '  ', telefono: '081 123' })
    expect(n.codice_meccanografico).toBe('NA1E123456')
    expect(n.cap).toBeNull()
    expect(n.telefono).toBe('081 123')
    expect(n.pec).toBeNull()
  })
})

describe('parseAnagraficaSede', () => {
  it('estrae da config JSONB', () => {
    const a = parseAnagraficaSede({ anagrafica: { codice_meccanografico: 'NA1E123456', provincia: 'NA' }, altro: 1 })
    expect(a.codice_meccanografico).toBe('NA1E123456')
    expect(a.provincia).toBe('NA')
  })
  it('config null/malformata → tutti null (mai throw)', () => {
    expect(parseAnagraficaSede(null).codice_meccanografico).toBeNull()
    expect(parseAnagraficaSede({ anagrafica: 'stringa-sbagliata' }).cap).toBeNull()
    expect(parseAnagraficaSede(undefined).pec).toBeNull()
  })
})
```
- [ ] **T15c** `src/app/api/admin/schools/route.ts` — PATCH con merge server-side (NON sostituire l'intera config: altre chiavi di config sede vanno preservate):
  - import: `import { zAnagraficaSede, normalizzaAnagraficaSede } from '@/lib/scuole/anagrafica'`
  - `patchBodySchema`: aggiungere `anagrafica: zAnagraficaSede.optional(),`
  - nel PATCH: la select di esistenza (riga 103-107) diventa `.select('id, config')`; dopo il blocco `updates` esistente:
```ts
    if (b.data.anagrafica !== undefined) {
      const existingConfig = (existing.config && typeof existing.config === 'object') ? existing.config as Record<string, unknown> : {}
      updates.config = { ...existingConfig, anagrafica: normalizzaAnagraficaSede(b.data.anagrafica) }
    }
```
  (se il chiamante passa sia `config` grezza sia `anagrafica`, l'anagrafica normalizzata vince — ordine: assegnare `updates.config` dell'anagrafica DOPO il pass-through legacy. Audit `logScrittura` già copre `valoreDopo: updates`.)
- Gate: `requireStaff(['admin','coordinator'])` già presente; l'account harness `segreteria` ha ruolo `coordinator` in prod (verificato) → testabile.

### Task T2 — `/api/parent/students`: arricchimento scuola PER FIGLIO (multi-sede)

**Files:** Modify: `src/app/api/parent/students/route.ts:28-34`

- [ ] Sostituire il blocco select+return con lookup separato su `scuole` (soft-ref senza FK → NIENTE join embedded) e risposta additiva. Include `config` per estrarre l'anagrafica (cod. mecc. ecc.):
```ts
    const { data, error } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, scuola_id')
      .in('id', ids)

    if (error) throw error
    const rows = data ?? []

    // Arricchimento sede PER FIGLIO (multi-sede): scuola_id è soft-ref senza FK
    // → lookup separato sugli id distinti. Best-effort: un errore qui non fa
    // fallire la lista figli (campi a null) — regge anche il DB E2E CI non migrato.
    const scuolaIds = [...new Set(rows.map(r => r.scuola_id).filter(Boolean))] as string[]
    const scuolaById = new Map<string, { nome: string | null; citta: string | null; indirizzo: string | null; anagrafica: AnagraficaSede }>()
    if (scuolaIds.length > 0) {
      const { data: scuole } = await supabase
        .from('scuole')
        .select('id, nome, citta, indirizzo, config')
        .in('id', scuolaIds)
      for (const s of scuole ?? []) {
        scuolaById.set(s.id as string, {
          nome: (s.nome as string | null) ?? null,
          citta: (s.citta as string | null) ?? null,
          indirizzo: (s.indirizzo as string | null) ?? null,
          anagrafica: parseAnagraficaSede(s.config),
        })
      }
    }

    const enriched = rows.map(r => {
      const info = r.scuola_id ? scuolaById.get(r.scuola_id) : undefined
      return {
        ...r,
        scuola_nome: info?.nome ?? null,
        scuola_citta: info?.citta ?? null,
        scuola_indirizzo: info?.indirizzo ?? null,
        scuola_cap: info?.anagrafica.cap ?? null,
        scuola_provincia: info?.anagrafica.provincia ?? null,
        scuola_codice_meccanografico: info?.anagrafica.codice_meccanografico ?? null,
      }
    })

    return NextResponse.json({ success: true, data: enriched })
```
  - import: `import { parseAnagraficaSede, type AnagraficaSede } from '@/lib/scuole/anagrafica'`
Consumer verificati (tutti safe, campi additivi): `parent/modulistica:132`, `ChildSwitcher.tsx:24`, `use-parent-identity.ts:44`.

### Task T3 — Default zod: mai più 'Girasoli', degrado a vuoto

**Files:** Modify: `src/app/api/attendance/daily/route.ts:20`, `src/app/api/attendance/monthly/route.ts:33`, `src/app/api/diary/entries/route.ts:21`, `src/app/api/diary/students/route.ts:75` (+ commenti d'esempio nelle stesse route)

- [ ] Nelle prime 3: `sezione: z.string().default('')` (con `''` ognuna ha GIÀ l'early-return/risposta `[]`: daily → 0 righe→`[]`; monthly → early-return righe 69-71; entries → `json([])` riga 119). NB semantica `parseQuery`: il default scatta solo a chiave ASSENTE; `data` in daily ha già default "oggi" nell'handler (riga 40).
- [ ] diary/students riga 75: `const sezione = q.data.sezione ?? q.data.classeSezione ?? '';` (0 alunni → `json([])` già esistente righe 88-90).
- [ ] Aggiornare i commenti-esempio `?sezione=Girasoli` → `?sezione=<classe>` nelle 4 route toccate.

### Task T4 — `/api/tasks`: via la mappa email→sezione, dentro il canonico

**Files:** Modify: `src/app/api/tasks/route.ts` (righe 286-323 + import)

- [ ] Aggiungere import: `import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti';`
- [ ] Sostituire il blocco `if (!isManager) {...}` (righe 288-323) con cascata coerente a educator-sections — **canonico prima, euristica media come fallback esistente, mappa email RIMOSSA** (scelta conservativa: zero regressioni per task targetizzati via sezioni inferite dai media):
```ts
        // Sezioni del docente per il filtro `target_class`: fonte canonica
        // utenti_sezioni → sections.name; fallback legacy sui media taggati.
        // Nessuna mappa email→sezione (verificato in prod: email inesistenti,
        // tutti i docenti hanno legami in utenti_sezioni). Senza riscontri → []
        // (il docente vede comunque i task global/role/authored/assigned).
        let sectionNames: string[] = [];
        if (!isManager && userId) {
            sectionNames = await nomiSezioniDiUtente(supabase, userId);
        }
        if (!isManager && sectionNames.length === 0) {
            // Get sections from educator's media uploads (tagged students' classes)
            const { data: myMedia } = await supabase
                .from('galleria_media_v2')
                .select('tag_students')
                .eq('uploaded_by', userId ?? null)
                .not('tag_students', 'is', null);

            const myTaggedIds = (myMedia ?? [])
                .flatMap((m: { tag_students: string[] | null }) => m.tag_students ?? [])
                .filter(Boolean);

            if (myTaggedIds.length > 0) {
                const { data: students } = await supabase
                    .from('alunni')
                    .select('classe_sezione')
                    .in('id', myTaggedIds);
                sectionNames = [...new Set(
                    (students ?? []).map((s: { classe_sezione: string }) => s.classe_sezione).filter(Boolean)
                )];
            }
        }
```
Uso a valle verificato: `sectionNames` serve solo ai filtri `task.target_class && sectionNames.includes(...)` (righe ~383/394) → con `[]` mai un 500.

### Task T5 — `/api/educator-sections`: rimozione Method 3 + dedup Method 0

**Files:** Modify: `src/app/api/educator-sections/route.ts` (righe 19-21, 26-38, 81-98)

- [ ] Sostituire il commento fuorviante righe 19-21 con:
```ts
// Sezioni del docente: fonte canonica utenti_sezioni → sections.name (Method 0);
// in mancanza di legami restano due euristiche legacy (media taggati, eventi
// diario). Nessuna mappa hardcoded: senza riscontri → [].
```
- [ ] Method 0 (righe 27-38) → riuso helper: `import { nomiSezioniDiUtente } from '@/lib/sezioni/docenti';` e
```ts
    // Method 0 (canonico): legame docente↔sezione in utenti_sezioni → sections.name.
    const canonicalNames = await nomiSezioniDiUtente(supabase, userId);
    if (canonicalNames.length > 0) return canonicalNames;
```
- [ ] Cancellare Method 3 (righe 81-96: query `utenti.email` + `emailToSection`), chiusura:
```ts
    // Nessun legame né derivazione: nessuna sezione (il chiamante degrada a vuoto).
    return [];
```

### Task T6 — `/api/tasks/meta`: fallback finto → vuoto

**Files:** Modify: `src/app/api/tasks/meta/route.ts:68`

- [ ] `let classes: string[] = [];` (annotazione TS esplicita OBBLIGATORIA: `[]` nudo inferirebbe `never[]` e rompe righe 70/74). Cascata esistente sections→alunni intatta; consumer `useTasks.ts:150-156` → selettore classi vuoto = degrado pulito.

### Task T7 — Bacheca avvisi docente: classi reali

**Files:** Modify: `src/app/(dashboard)/teacher/avvisi/page.tsx` (righe 10, ~21, 149, 161), `src/components/features/avvisi/AvvisoDetailsDrawer.tsx:19`, `src/components/features/avvisi/AvvisoDetailsContent.tsx:37`. (`AvvisoForm.tsx` NON si tocca: default già `[]`.)

- [ ] Eliminare riga 10 (`AVAILABLE_CLASSES`).
- [ ] Dopo il blocco stati (riga ~21), pattern locker:
```ts
    // Classi reali del docente (utenti_sezioni via /api/educator-sections):
    // niente elenco hardcoded; con 0 sezioni le pill del form restano vuote.
    const [availableClasses, setAvailableClasses] = useState<string[]>([]);

    useEffect(() => {
        if (!teacherId) return;
        fetch(`/api/educator-sections?userId=${teacherId}`)
            .then(r => (r.ok ? r.json() : null))
            .then(d => setAvailableClasses(d?.sectionNames ?? []))
            .catch(() => {});
    }, [teacherId]);
```
- [ ] Righe 149 e 161: `availableClasses={availableClasses}`.
- [ ] Drawer/Content: default param → `= []`.
- Effetto voluto: le statistiche del drawer per avvisi `globale` si calcolano sulle classi reali del docente (prima: su 5 nomi finti). `admin/avvisi` e `admin/avvisi/[id]` passano già le proprie liste da `/api/admin/sections/scoped` → intoccate.

### Task T8 — Pagina Foto (gallery): init vuoto + spinner spento con 0 sezioni

**Files:** Modify: `src/app/(dashboard)/teacher/gallery/page.tsx` (righe 43, 82-100, 367)

- [ ] Riga 43: `const [sezione, setSezione] = useState<string>('');` (guardie `if (!sezione) return` nei loader GIÀ presenti alle righe 47 e 61 → con `''` nessun fetch al mount).
- [ ] `fetchSections` (righe 82-100) riscritto (pattern locker):
```ts
    useEffect(() => {
        const fetchSections = async () => {
            if (!teacherId) return;
            try {
                const res = await fetch(`/api/educator-sections?userId=${teacherId}`);
                const data = res.ok ? await res.json() : null;
                const sections: string[] = data?.sectionNames ?? [];
                setAvailableSections(sections);
                if (sections.length > 0) {
                    setSezione(prev => prev || sections[0]);
                } else {
                    // Nessuna sezione (o errore API): niente da caricare → spegni lo spinner.
                    setLoading(false);
                }
            } catch (err) {
                console.error('Errore caricamento sezioni educatore:', err);
                setLoading(false);
            }
        };
        fetchSections();
    }, [teacherId]);
```
- [ ] Riga 367: `della sezione {sezione || '…'}` (coerente con attendance).

### Task T9 — Certificati genitore: classe/anno/città/sede reali

**Files:** Modify: `src/app/(dashboard)/parent/modulistica/page.tsx` (import, riga 91, righe 389-400, 415-417, 424)

- [ ] Import: `annoScolasticoCorrente` + `buildCertificatoBody, buildIntestazioneSede, rigaLuogoData`.
- [ ] Riga 91 — tipo state esteso:
```ts
  const [children, setChildren] = useState<{
    id: string; nome: string; cognome: string;
    classe_sezione?: string | null;
    scuola_nome?: string | null; scuola_citta?: string | null; scuola_indirizzo?: string | null;
    scuola_cap?: string | null; scuola_provincia?: string | null; scuola_codice_meccanografico?: string | null;
  }[]>([]);
```
- [ ] In `generateSelfServiceCertificate`, dopo `const currentStudent = children[0];`:
```ts
      // NB: sempre children[0] — il tab Certificati non ha selettore figlio
      // (semantica esistente, fuori scope del de-hardcode).
      const anno = annoScolasticoCorrente();
```
- [ ] **Intestazione sede** (multi-sede) — dopo il blocco header verde (riga ~400), prima del titolo (y=65): righe reali della sede del figlio, omesse se mancanti:
```ts
      // Intestazione sede reale (dal DB, per-figlio): righe omesse se mancanti.
      const intestazione = buildIntestazioneSede(currentStudent);
      if (intestazione.length > 0) {
        doc.setTextColor(100, 100, 100);
        doc.setFont('Helvetica', 'normal');
        doc.setFontSize(9);
        intestazione.forEach((riga, i) => doc.text(riga, 20, 47 + i * 5));
      }
```
- [ ] Righe 415-417 → `const bodyText = buildCertificatoBody(type, currentStudent, anno);`
- [ ] Riga 424 → `doc.text(rigaLuogoData(currentStudent.scuola_citta, new Date().toLocaleDateString('it-IT')), 25, 160);`
- Note testo: la frequenza passa da "per l'anno scolastico corrente" a "per l'anno scolastico 2025/2026" (esplicito, formale) — intenzionale. L'header brand "KIDVILLE SCHOOLS" resta (brand aziendale); l'identità della SEDE sta nelle nuove righe di intestazione.

### Task T16 — SchoolsPanel: form Anagrafica per sede

**Files:** Modify: `src/components/features/admin/settings/SchoolsPanel.tsx`

- [ ] Estendere `interface Scuola` con `config?: unknown` (il GET la ritorna già).
- [ ] Nuovo stato: `const [anagId, setAnagId] = useState<string | null>(null);` + `const [draftAnag, setDraftAnag] = useState<AnagraficaSede>({});` + `const [draftSede, setDraftSede] = useState({ citta: '', indirizzo: '' });` (import `type AnagraficaSede, parseAnagraficaSede` da `@/lib/scuole/anagrafica`).
- [ ] Per ogni sede, nuovo bottone (accanto a Rinomina/Power, icona `IdCard` o `FileText` di lucide): apre/chiude il form inline `anagId === s.id`, precompilato con `parseAnagraficaSede(s.config)` e `citta`/`indirizzo` colonne.
- [ ] Form inline (stessi stili input del form "nuova sede", griglia 2 colonne): campi Città, Indirizzo, CAP, Provincia, Codice meccanografico, Denominazione ufficiale, Telefono, Email, PEC, P.IVA/CF. Bottone "Salva anagrafica" → `patch(s.id, { citta: draftSede.citta, indirizzo: draftSede.indirizzo, anagrafica: draftAnag })` (riusa `patch()` esistente con alert su 403); "Annulla" → chiude.
- [ ] Riga riassuntiva sede (riga 94): aggiungere il cod. mecc. se presente: `{[s.citta, s.indirizzo, mecc && `Cod. Mecc. ${mecc}`].filter(Boolean).join(' · ') || '—'}` con `const mecc = parseAnagraficaSede(s.config).codice_meccanografico`.
- Accessibilità/ESLint: input con `placeholder` come gli esistenti; nessun setState sincrono in effect (pattern del file già conforme).
- Dati REALI di Giugliano: NON inventarli — inserimento a cura dell'utente dal pannello (o su sua dettatura). I test scrivono SOLO sulla sede "Kidville E2E" (`e2e00000-0000-4000-8000-000000000001`, già esistente in prod).

### Task T10 — MonthlyAttendanceTable: default prop

**Files:** Modify: `src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx:244`

- [ ] `export function MonthlyAttendanceTable({ sezione = '' }: { sezione?: string }) {` — con `''` le 2 API (post-T3) rispondono `[]` → tabella vuota, `finally` spegne il loading. Caller unico passa sempre la prop.

### Task T11 — Cancellazione file morti '3A'

**Files:** Delete: `src/components/features/teacher/register/GradesTab.tsx`, `LessonsTab.tsx`, `NotesTab.tsx` (+ dir `register/` che resta vuota). Modify: commento `src/app/api/grades/route.ts:2`.

- [ ] Pre-check (rifare prima del delete): `grep -rn "GradesTab\|NotesTab\|LessonsTab" src __tests__ e2e` → atteso: solo il commento in grades/route.ts.
- [ ] `git rm` dei 3 file.
- [ ] Aggiornare il commento in `src/app/api/grades/route.ts:2` → "route legacy senza consumer UI (ex GradesTab, rimosso 2026-07-10)".
- [ ] **NON toccare** `/api/grades`, `/api/notes`, `/api/register/lessons`: importate da `__tests__/api/grades.test.ts:20` e `__tests__/api/p0-gates.test.ts:11-12`. (Follow-up nel PRD: deprecarle.)

### Task T12 — Journey assertiva 90 (D1-D9) + test per-caso

**Files:** Create: `e2e/primaria-360/journeys/90-dehardcode.spec.ts` (modello 89; harness: `storagePath`, `readAppIds`, `withUser`, `apiGet`, `apiPatch`, `httpOk`; docente1 = TEST 1A, genitore1 = figlio in TEST 1A, segreteria = coordinator; tab certificati = bottone "Certificati Self-Service" riga 503)

- [ ] Test D1-D7 come da blocco sotto; D8-D9 per l'anagrafica sede (PATCH sulla sede E2E `e2e00000-0000-4000-8000-000000000001`, MAI su Giugliano):
```ts
import { test, expect } from '@playwright/test';
import { storagePath } from '../config/accounts';
import { readAppIds, withUser, apiGet, apiPatch, httpOk } from '../lib/harness';

// Verifica de-hardcode + anagrafica sede (2026-07-10). Il contenuto testuale
// dei PDF è coperto dagli unit test vitest dei builder.

const SEDE_E2E = 'e2e00000-0000-4000-8000-000000000001'; // sede fittizia già in prod: MAI toccare Giugliano

test.describe('de-hardcode · docente1 (TEST 1A)', () => {
  test.use({ storageState: storagePath('docente1') });

  test('D1 · API educator-sections: TEST 1A presente, Girasoli assente', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const r = await apiGet(page, withUser('/api/educator-sections', uid));
    expect(httpOk(r.status), `educator-sections status ${r.status}`).toBeTruthy();
    const sects = (r.json as { sectionNames?: string[] }).sectionNames ?? [];
    expect(sects, 'sectionNames non contiene TEST 1A').toContain('TEST 1A');
    expect(sects, 'sectionNames contiene ancora Girasoli').not.toContain('Girasoli');
  });

  test('D2 · avvisi: il form "Nuovo" propone le classi reali del docente', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    await page.goto(withUser('/teacher/avvisi', uid), { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /nuovo/i }).click();
    const modal = page.locator('div')
      .filter({ has: page.getByRole('heading', { name: /nuovo avviso/i }) })
      .filter({ has: page.getByRole('button', { name: /per classe/i }) })
      .last();
    await modal.getByRole('button', { name: /per classe/i }).click();
    await expect(modal.getByRole('button', { name: 'TEST 1A', exact: true })).toBeVisible({ timeout: 20000 });
    // Scoped al modale: avvisi legacy in lista possono citare classi storiche.
    await expect(modal.getByText('Girasoli')).toHaveCount(0);
  });

  test('D3 · gallery: header con la sezione reale, niente Girasoli', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    await page.goto(withUser('/teacher/gallery', uid), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/della sezione TEST 1A/)).toBeVisible({ timeout: 35000 });
    await expect(page.getByText('Girasoli')).toHaveCount(0);
  });

  test("D4 · attendance/daily SENZA sezione: 200 e lista vuota (default '')", async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const r = await apiGet(page, withUser('/api/attendance/daily', uid)); // nessun param sezione
    expect(httpOk(r.status), `attendance/daily status ${r.status}`).toBeTruthy();
    expect(Array.isArray(r.json), 'attesa risposta array').toBeTruthy();
    expect((r.json as unknown[]).length, "senza sezione deve degradare a [] (non dati Girasoli)").toBe(0);
  });

  test('D5 · tasks: 200 dopo la rimozione della mappa email→sezione', async ({ page }) => {
    const uid = readAppIds()['docente1'];
    const r = await apiGet(page, `/api/tasks?userId=${uid}`);
    expect(httpOk(r.status), `tasks status ${r.status}`).toBeTruthy();
    expect(Array.isArray(r.json), 'attesa risposta array').toBeTruthy();
  });
});

test.describe('de-hardcode · genitore1 (Alunno1)', () => {
  test.use({ storageState: storagePath('genitore1') });

  test('D6 · API parent/students: classe reale e città della scuola (per figlio)', async ({ page }) => {
    const uid = readAppIds()['genitore1'];
    const r = await apiGet(page, withUser('/api/parent/students', uid));
    expect(httpOk(r.status), `parent/students status ${r.status}`).toBeTruthy();
    const data = (r.json as { data?: { classe_sezione?: string; scuola_citta?: string | null; scuola_nome?: string | null }[] }).data ?? [];
    expect(data.length, 'nessun figlio restituito').toBeGreaterThan(0);
    expect(data[0].classe_sezione, 'classe_sezione errata').toBe('TEST 1A');
    expect(data[0].scuola_citta, 'scuola_citta mancante/errata').toBe('Giugliano');
    expect(data[0].scuola_nome, 'scuola_nome mancante').toBe('Kidville Giugliano');
  });

  test('D7 · certificato frequenza: download PDF + toast di successo', async ({ page }) => {
    await page.goto('/parent/modulistica', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /certificati self-service/i }).click();
    const downloadPromise = page.waitForEvent('download', { timeout: 25000 });
    await page.getByRole('button', { name: /scarica pdf/i }).first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename(), 'nome file certificato').toContain('FREQUENZA');
    await expect(page.getByText(/Certificato scaricato con successo/)).toBeVisible({ timeout: 10000 });
  });
});

test.describe('anagrafica sede · segreteria (coordinator)', () => {
  test.use({ storageState: storagePath('segreteria') });

  test('D8 · PATCH anagrafica su sede E2E: salva, merge e rilettura', async ({ page }) => {
    const uid = readAppIds()['segreteria'];
    const r = await apiPatch(page, withUser('/api/admin/schools', uid), {
      id: SEDE_E2E,
      anagrafica: { codice_meccanografico: 'na1e000e2e', cap: '80100', provincia: 'na', pec: 'e2e@pec.test' },
    });
    expect(httpOk(r.status), `PATCH schools status ${r.status}`).toBeTruthy();
    const g = await apiGet(page, withUser('/api/admin/schools', uid));
    expect(httpOk(g.status)).toBeTruthy();
    const sede = (g.json as { id: string; config?: { anagrafica?: Record<string, unknown> } }[]).find(s => s.id === SEDE_E2E);
    expect(sede, 'sede E2E non trovata').toBeTruthy();
    expect(sede?.config?.anagrafica?.codice_meccanografico, 'cod. mecc. non normalizzato/salvato').toBe('NA1E000E2E');
    expect(sede?.config?.anagrafica?.provincia).toBe('NA');
    expect(sede?.config?.anagrafica?.pec).toBe('e2e@pec.test');
  });

  test('D9 · SchoolsPanel: il form Anagrafica si apre e mostra i campi', async ({ page }) => {
    const uid = readAppIds()['segreteria'];
    await page.goto(withUser('/admin/schools', uid), { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(/gestione multi-sede/i)).toBeVisible({ timeout: 35000 });
    await page.getByTitle('Anagrafica').first().click();
    await expect(page.getByPlaceholder(/codice meccanografico/i)).toBeVisible();
    await expect(page.getByPlaceholder(/pec/i)).toBeVisible();
  });
});
```
  (NB: verificare in esecuzione che `apiPatch` esista in `lib/harness.ts` — risulta esportato; la normalizzazione `na1e000e2e → NA1E000E2E` prova il passaggio per `normalizzaAnagraficaSede`. D9: adattare selettori al markup reale del form se differiscono; `/admin/schools` è la pagina che monta SchoolsPanel.)
- [ ] Regen storageState (~ogni ora): `npx playwright test -c e2e/primaria-360/playwright.primaria360.config.ts --project=setup` → "1 passed" (26 login; dev server :3000 riusato/avviato dalla config).
- [ ] Smoke: `... journeys/90-dehardcode.spec.ts --no-deps` → "9 passed". Al primo rosso: causa radice (file:riga), fix, riparti.
- [ ] Test per-caso (≥10 iterazioni): `... journeys/90-dehardcode.spec.ts --no-deps --repeat-each=10` → "90 passed".
- [ ] Riscontro DATABASE via MCP (5ª dimensione del protocollo): `utenti_sezioni` di docente1 → TEST 1A; `alunni.classe_sezione='TEST 1A'` per Alunno1; `scuole.citta='Giugliano'`; dopo D8: `scuole.config->anagrafica` della sede E2E valorizzata (e Giugliano INTATTA: `config` invariata).

### Task T13 — Verifica finale (≥50 loop) + sweep + report + gate

- [ ] **Loop 50×**: `npx playwright test -c e2e/primaria-360/playwright.primaria360.config.ts journeys/90-dehardcode.spec.ts --no-deps --repeat-each=50` → atteso "450 passed" consecutivi (9×50). Al primo rosso → causa radice → fix → RIPARTIRE il loop da zero.
- [ ] **Non-regressione**: journey 89 (`--no-deps`) → "8 passed" (copre locker/educator-sections toccati da T5); sweep `journeys/70... 71... 72... --no-deps` → "3 passed" e findings senza NUOVI difetti bloccanti/gravi/medi sulle pagine toccate (incl. /admin/schools); adversarial se in dubbio: journey 80 (IDOR→403, PII anonimo→401) — in particolare `/api/admin/schools` PATCH da genitore → 403.
- [ ] **Report**: `node e2e/primaria-360/scripts/build-report-fresh.mjs` → rigenera `run/report-360.html`.
- [ ] **Gate dalla ROOT** (attenzione cwd: MAI lanciarli da e2e/primaria-360):
  - `npx eslint . --max-warnings 0` → exit 0
  - `npx vitest run` → tutti verdi (801 attuali + ~17 nuovi)
  - `npx tsc --noEmit` → exit 0
  - `npm run build` → ok
- [ ] **Nativo**: NON eseguibile (nessun emulatore/simulatore disponibile) → dichiararlo nel riepilogo, non fingere.

### Task T14 — PRD

**Files:** Modify: `PRD REGISTRO ELETTRONICO.md`

- [ ] Voce changelog datata 2026-07-10: (a) de-hardcode — cosa era cablato (tabella A→fix) e come ora deriva dal DB (`utenti_sezioni`/`sections`, `alunni.classe_sezione`, `scuole.*`, helper `annoScolasticoCorrente` set→lug); (b) **anagrafica di sede** — nuovi campi in `scuole.config.anagrafica` (denominazione, cod. meccanografico, CAP, provincia, telefono, email, PEC, P.IVA/CF), form nel pannello Multi-Sede, merge server-side, uso nell'intestazione dei certificati self-service per-figlio (multi-sede); zero migrazioni DB; (c) B/C documentati come benigni; (d) evidenze di verifica (loop 50×, sweep, gate). Follow-up segnalati: route grades/notes/register-lessons orfane lato UI; duplicazioni formula anno scolastico (unificabili sull'helper); certificato sempre per il primo figlio; raccordo `sidi_config.codice_meccanografico` → anagrafica per-sede quando ci sarà >1 sede accreditata; inserimento dati anagrafici REALI di Giugliano a cura dell'utente dal pannello.

---

## Matrice rischi (superfici condivise)

| Fix | Chi altro la usa | Rischio residuo |
|---|---|---|
| T2 parent/students | ChildSwitcher, use-parent-identity, modulistica | nullo (campi additivi); +1 query `.in()` su scuole; lookup best-effort regge il DB E2E CI non migrato |
| T3 default `''` | nessun caller in-repo omette `sezione` | client esterni che omettevano il param ricevono `[]` invece dei dati Girasoli = chiusura leak voluta |
| T4 tasks | feed task docente | task con `target_class` raggiunti solo via euristica media restano visibili (fallback conservato) |
| T5 educator-sections | tutte le pagine teacher (locker, gallery, attendance, avvisi, modulistica, diary, mensa, useTasks) | nullo in prod (email inesistenti verificate); docente orfano → `[]` → empty-state già gestiti |
| T7 avvisi | `AvvisoForm`/`AvvisoDetailsContent` usati da admin/avvisi con liste proprie | admin intoccato; statistiche drawer docente su classi reali (è il fix) |
| T9 modulistica | solo tab Certificati | wording frequenza con anno esplicito; città null → "Lì <data>"; intestazione sede assente finché l'anagrafica non è compilata (righe omesse) |
| T15c PATCH schools | SchoolsPanel unico consumer del PATCH; config sede letta da parseAnagraficaSede | merge server-side preserva altre chiavi di config; anagrafica zod-validata (lock zod-coverage rispettato) |
| T16 SchoolsPanel | solo pagina /admin/schools (gate Direzione) | l'account segreteria harness è coordinator → può salvare; scritture di test SOLO su sede E2E |
| T11 delete | zero import verificati | zero (API legacy conservate per i test) |

## Falsi rossi noti in verifica
Dati `[E2E360]`/"AlunnoN" nei findings = dati di test, non bug; indicatore dev Next.js; date-input nativi en-US in headless; E2E CI su DB separato non migrato (il lookup scuole è best-effort → nessun 500). D2: asserzione anti-Girasoli scopata AL MODALE (avvisi legacy in lista possono citare nomi storici). D6: se `scuola_citta` risultasse diversa, allentare in `toMatch(/Giugliano/)`. D8: la sede E2E è fittizia e già presente — le scritture di test NON toccano Giugliano.
