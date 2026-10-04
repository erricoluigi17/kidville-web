# Anagrafica alunni in sola lettura per le insegnanti — piano d'implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** l'insegnante apre «Alunni» dal menu, filtra i propri bambini e ne consulta la scheda anagrafica completa (senza dati economici e senza documenti d'identità), senza poterla modificare.

**Architecture:** due route solo `GET` sotto `/api/teacher/alunni`, con un controllo di visibilità unico (sezioni assegnate direttamente **e** per materia), colonne scritte a mano e una proiezione pura a lista bianca; audit in `fascicolo_accessi_audit` sulla scheda. Lato client il motore dei filtri condiviso (`useFiltri` + `BarraFiltri`), esteso con un flag `maiNellUrl` perché la ricerca per nome non finisca nell'indirizzo, e componenti di sola visualizzazione.

**Tech Stack:** Next.js 16 App Router (route handler + pagine client), Supabase service-role (`createAdminClient`), zod, next-intl, vitest + Testing Library + finto Supabase, Playwright (CI).

**Spec:** `docs/superpowers/specs/2026-10-04-anagrafica-docente-design.md`. **Branch:** `feat/anagrafica-docente` (già creato).

> **Valori di prova.** Nei blocchi di codice dei test, i valori accanto alle colonne di dati personali (`codice_fiscale`, `data_nascita`, `allergies`, `note_mediche`, `indirizzo`…) sono sostituiti da `[VALORE_DI_PROVA: …]`: il lock `__tests__/architecture/pii-nei-file-tracciati.test.ts` vieta la forma «colonna: valore» nei documenti tracciati, perché è quella di una query incollata. Il codice vero dei test, con i suoi valori palesemente inventati, sta nei file `__tests__/` citati da ogni task.


---

## Scostamenti del codice finale dal piano (dopo le revisioni)

Il piano qui sotto è quello eseguito; ogni task è passato da due revisioni (conformità e qualità,
con mutanti) e le correzioni hanno cambiato il codice in questi punti. **Vale il codice.**

- **Proiezione:** parentela anche `'delegato'`; ordine deterministico dei genitori (delegati in
  fondo, poi referente, madre, padre, parentela assente, altro, poi cognome e nome); un delegato non
  è mai «referente principale»; `sesso` normalizzato in maiuscolo.
- **Visibilità:** codici d'errore con costanti locali e corpi letterali (lock `errori-con-codice`);
  `sediAnagrafica()` estratta e condivisa da elenco e scheda (nessuna sede: admin → 500, altri →
  403 `ANAGRAFICA_SENZA_SEDE`); `warn` anche per il «fuori sede»; log con l'id canonico (`riga.id`).
- **Elenco:** `LIMITE_ELENCO_ALUNNI` con `warn` al tetto; `resolveScuoleAttive` ha un quarto
  parametro opzionale `accessibili` per non rileggere `utenti_scuole`.
- **Scheda:** la seconda lettura rifiltra `stato` e `anonimizzato_il`; caricamento con funzione di
  modulo + effetto (`setState` nel `.then`), non con `try/finally` vuoto; esito «sessione» (401);
  il client legge il `codice` dei 403; regione `aria-live`; delegati come elenco col nome in
  evidenza; «Tutti gli alunni» fisso in alto.
- **Elenco (UI):** stessa forma di caricamento; 401, 403 col codice, assenza di rete; niente barra
  su elenco vuoto; anello di focus con `outline-offset` `!important`; righe `prefetch={false}`.
- **Fuori dalla cartella della funzione:** `AppBar.tsx` (`suppressBack` sulla scheda),
  `FascicoloAuditViewer.tsx` + `api/admin/primaria/fascicolo-audit` (etichetta «Scheda
  anagrafica» e filtro `conAnagrafica`), `esito-fetch.ts` e `shared.json` (7 codici),
  `adminPrimaria.json`, `public/sw.js` (`v13`), conteggi-fotografia del lock
  `isolamento-sede-coverage`, `scope.ts`.
- **Testi inglesi** allineati al catalogo (BES/DSA, diapers, Gender, Postal Code, Enrollment
  date); «sede» → «location».

## Regole del repo che valgono per OGNI task

- Si legge con `Read`, si cerca con `Grep`/`Glob`; ogni comando che stampa molto passa da `tail`.
- **Mai `console.*`** in `src/`: `logEvento` / `logErrore` (server), `logClient` (client).
- **PostgREST non lancia**: si controlla sempre `{ error }`.
- **Un `catch` che non logga è un bug.**
- `react-hooks/set-state-in-effect` è un **errore**: in un effetto si chiama solo una funzione asincrona che fa `setState` **dopo** un `await`.
- Ogni test nuovo si **vede fallire** prima di scrivere il codice; dopo, si controlla la riga `Test Files N passed` (un file inesistente esce 0 senza dirlo).
- In zsh `PIPESTATUS` non esiste: l'esito di `vitest` si legge dalla riga del riepilogo, non da `$?` dopo una pipe.
- Il repository è **pubblico**: nei test solo dati palesemente finti (`…-E2E`, `TST…`, `example.test`).

## Mappa dei file

| File | Azione | Responsabilità |
|---|---|---|
| `src/lib/ui/filtri/tipi.ts` | modifica | flag `maiNellUrl` sui campi |
| `src/lib/ui/filtri/motore.ts` | modifica | `versoUrl` lo salta, `valoriIniziali` lo ignora |
| `src/lib/anagrafiche/docente/tipi.ts` | crea | forme di risposta di elenco e scheda |
| `src/lib/anagrafiche/docente/proiezione.ts` | crea | funzioni pure riga DB → risposta (lista bianca) |
| `src/lib/anagrafiche/docente/colonne.ts` | crea | colonne lette, una per una |
| `src/lib/anagrafiche/docente/visibilita.ts` | crea | `sezioniAnagraficaVisibili` + `assertAlunnoAnagraficaInScope` |
| `src/lib/anagrafiche/docente/ritorno-elenco.ts` | crea | query dell'elenco da ritrovare tornando dalla scheda |
| `src/lib/primaria/fascicolo-rbac.ts` | modifica | commento che punta al lock vero |
| `src/app/api/teacher/alunni/route.ts` | crea | `GET` elenco |
| `src/app/api/teacher/alunni/[id]/route.ts` | crea | `GET` scheda |
| `src/components/features/teacher/anagrafica/filtri-alunni.ts` | crea | campi della barra filtri |
| `src/components/features/teacher/anagrafica/CampoLettura.tsx` | crea | riga «etichetta: valore» |
| `src/components/features/teacher/anagrafica/RiquadroScheda.tsx` | crea | blocco con titolo |
| `src/components/features/teacher/anagrafica/SchedaGenitore.tsx` | crea | un genitore, telefoni ed email toccabili |
| `src/components/features/teacher/anagrafica/SchedaAlunnoLettura.tsx` | crea | carica e impagina la scheda |
| `src/components/features/teacher/anagrafica/PannelloAlunni.tsx` | crea | barra filtri + elenco raggruppato |
| `src/components/features/teacher/anagrafica/ElencoAlunniDocente.tsx` | crea | carica l'elenco, poi monta il pannello |
| `src/app/(dashboard)/teacher/alunni/page.tsx` | crea | pagina elenco |
| `src/app/(dashboard)/teacher/alunni/[id]/page.tsx` | crea | pagina scheda |
| `src/components/features/teacher/TeacherBottomNav.tsx` | modifica | voce «Alunni» |
| `src/lib/ui/tinte-funzioni.ts` | modifica | tinta `alunni` |
| `messages/{it,en}/teacherServizi.json`, `teacherNav.json`, `offline.json` | modifica | testi |
| `__tests__/…` (8 file nuovi, 1 modificato), `e2e/teacher-anagrafica.spec.ts` | crea | test |
| `PRD REGISTRO ELETTRONICO.md` | modifica | changelog + §2.1 |

---

### Task 1: il motore dei filtri impara `maiNellUrl`

**Files:**
- Modify: `src/lib/ui/filtri/tipi.ts` (interfaccia `Comune`, righe 66-88)
- Modify: `src/lib/ui/filtri/motore.ts` (`valoriIniziali` riga ~116, `versoUrl` riga ~257)
- Test: `__tests__/lib/filtri-mai-nell-url.test.ts`

- [ ] **Step 1: scrivi il test che fallisce**

```ts
import { describe, it, expect } from 'vitest'
import { parametriGovernati, valoriIniziali, versoUrl } from '@/lib/ui/filtri/motore'
import type { CampoFiltro } from '@/lib/ui/filtri/tipi'

// La ricerca per nome dell'anagrafica docente porta il NOME di un bambino: non deve
// finire nell'indirizzo, che resta nella cronologia del browser e che i log di accesso
// registrano a ogni ricarica. Gli altri filtri restano nell'URL come sempre.

interface Riga {
  nome: string
  classe: string
}

const campi: CampoFiltro<Riga>[] = [
  { tipo: 'ricerca', chiave: 'q', etichetta: 'Cerca', dove: 'client', maiNellUrl: true, testiDi: (r) => [r.nome] },
  {
    tipo: 'scelta',
    chiave: 'classe',
    etichetta: 'Classe',
    dove: 'client',
    opzioni: [{ valore: 'A', etichetta: 'A' }],
    valoreDi: (r) => r.classe,
  },
]

describe('motore filtri — `maiNellUrl`', () => {
  it('il campo non esce nell’indirizzo, gli altri sì', () => {
    const p = versoUrl(campi, { q: 'Rossi', classe: 'A' })
    expect(p.get('q')).toBeNull()
    expect(p.get('classe')).toBe('A')
  })

  it('il campo non si legge dall’indirizzo, gli altri sì', () => {
    const v = valoriIniziali(campi, new URLSearchParams('q=Rossi&classe=A'))
    expect(v.q).toBe('')
    expect(v.classe).toBe('A')
  })

  it('resta GOVERNATO: un `q` arrivato nell’indirizzo la barra lo cancella', () => {
    expect(parametriGovernati(campi)).toContain('q')
  })

  it('CONTROLLO POSITIVO — senza il flag la ricerca esce e si legge come prima', () => {
    const senza = campi.map((c) => (c.chiave === 'q' ? { ...c, maiNellUrl: undefined } : c)) as CampoFiltro<Riga>[]
    expect(versoUrl(senza, { q: 'Rossi', classe: '' }).get('q')).toBe('Rossi')
    expect(valoriIniziali(senza, new URLSearchParams('q=Rossi')).q).toBe('Rossi')
  })
})
```

- [ ] **Step 2: verifica che fallisca**

Run: `npx vitest run __tests__/lib/filtri-mai-nell-url.test.ts 2>&1 | tail -15`
Expected: FAIL (`expected 'Rossi' to be null` sui primi due casi; `tsc` segnalerebbe anche `maiNellUrl` sconosciuto).

- [ ] **Step 3: aggiungi il flag al tipo** — in `src/lib/ui/filtri/tipi.ts`, dentro `interface Comune`, dopo `nascondiSeVuoto?: boolean;`:

```ts
  /**
   * Il valore può contenere un DATO PERSONALE (un nome digitato nella ricerca): non
   * si scrive mai nell'indirizzo e non si legge da lì. L'URL completo resta nella
   * cronologia del browser e nei log di accesso a ogni ricarica, e viaggia in un
   * indirizzo condiviso: un nome di bambino non deve starci. Il parametro resta comunque
   * GOVERNATO (`parametriGovernati`), quindi se un indirizzo lo porta la barra lo
   * cancella.
   */
  maiNellUrl?: boolean;
```

- [ ] **Step 4: applicalo nel motore** — in `src/lib/ui/filtri/motore.ts`:

in `valoriIniziali`, sostituisci

```ts
    if (!daUrl) {
```

con

```ts
    if (!daUrl || campo.maiNellUrl) {
```

e in `versoUrl` sostituisci

```ts
    if (!campoAttivo(campo, valori)) continue;
```

con

```ts
    if (campo.maiNellUrl || !campoAttivo(campo, valori)) continue;
```

- [ ] **Step 5: verifica che passi, e che il resto del motore non si rompa**

Run: `npx vitest run __tests__/lib/filtri-mai-nell-url.test.ts __tests__/lib/filtri-motore.test.ts __tests__/components/barra-filtri.test.tsx 2>&1 | tail -8`
Expected: `Test Files  3 passed (3)`.

- [ ] **Step 6: commit**

```bash
git add src/lib/ui/filtri/tipi.ts src/lib/ui/filtri/motore.ts __tests__/lib/filtri-mai-nell-url.test.ts
git commit -m "Filtri: il flag maiNellUrl tiene un campo fuori dall'indirizzo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: tipi e proiezione a lista bianca

**Files:**
- Create: `src/lib/anagrafiche/docente/tipi.ts`
- Create: `src/lib/anagrafiche/docente/proiezione.ts`
- Test: `__tests__/lib/anagrafica-docente-proiezione.test.ts`

- [ ] **Step 1: crea i tipi** — `src/lib/anagrafiche/docente/tipi.ts`:

```ts
/**
 * LE FORME CHE L'ANAGRAFICA DOCENTE RESTITUISCE — e nient'altro.
 *
 * Sono la lista bianca scritta come tipo: un campo che non sta qui non può uscire
 * dalle due route `/api/teacher/alunni`, perché la proiezione (`proiezione.ts`)
 * costruisce questi oggetti campo per campo e non copia mai una riga intera.
 * Restano fuori per decisione del titolare (2026-10-04): retta, fatturazione,
 * intestatari, sospensioni, documenti d'identità, nascita e residenza dei genitori.
 */

export type Grado = 'nido' | 'infanzia' | 'primaria'

export interface SezioneElenco {
  id: string
  nome: string
  grado: Grado | null
}

/** Una riga dell'elenco: quanto basta a riconoscere il bambino e a filtrare. */
export interface VoceElencoAlunno {
  id: string
  nome: string
  cognome: string
  sectionId: string | null
  grado: Grado | null
  dataNascita: string | null
  annoNascita: number | null
  sesso: 'M' | 'F' | null
  /** Chiavi degli allergeni (anche fuori dai 14 UE): MAI il testo libero. */
  allergeni: string[]
  haAllergie: boolean
  besDsa: boolean
  usaPannolino: boolean
  /** `null` = consenso non registrato, che per chi pubblica vale «senza consenso». */
  consensoFotoSito: boolean | null
  consensoFotoSocial: boolean | null
}

export interface ElencoAlunniRisposta {
  sezioni: SezioneElenco[]
  alunni: VoceElencoAlunno[]
}

export type Parentela = 'madre' | 'padre' | 'altro'

export interface GenitoreScheda {
  nome: string
  cognome: string
  parentela: Parentela | null
  principale: boolean
  telefoni: string[]
  email: string[]
  codiceFiscale: string | null
}

export interface DelegatoScheda {
  nome: string
  cognome: string
  parentela: string | null
}

export interface SchedaAlunnoDocente {
  id: string
  nome: string
  cognome: string
  sesso: 'M' | 'F' | null
  dataNascita: string | null
  luogoNascita: { comune: string | null; provincia: string | null; nazione: string | null }
  cittadinanza: string | null
  codiceFiscale: string | null
  residenza: {
    indirizzo: string | null
    civico: string | null
    cap: string | null
    comune: string | null
    provincia: string | null
  }
  sezione: SezioneElenco | null
  dataIscrizione: string | null
  salute: {
    allergeni: string[]
    /** Solo il testo che le chiavi non dicono già (`testoResiduoAllergie`). */
    allergieAltro: string | null
    haAllergie: boolean
    noteMediche: string | null
    besDsa: boolean
    usaPannolino: boolean
  }
  consensi: { privacy: boolean | null; fotoSito: boolean | null; fotoSocial: boolean | null }
  genitori: GenitoreScheda[]
  delegati: DelegatoScheda[]
}
```

- [ ] **Step 2: scrivi il test che fallisce** — `__tests__/lib/anagrafica-docente-proiezione.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  proiettaDelegati,
  proiettaGenitori,
  proiettaScheda,
  proiettaSezione,
  proiettaVoceElenco,
} from '@/lib/anagrafiche/docente/proiezione'

// La proiezione È la lista bianca. Il finto Supabase restituisce righe INTERE
// (non emula la proiezione di `select`), e anche il database vero lo farebbe se
// qualcuno scrivesse `select('*')`: qui si prova che, comunque arrivi la riga, i
// campi economici e i documenti non escono.

const SEZIONE_ID = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'

const RIGA_PIENA: Record<string, unknown> = {
  id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa',
  nome: '  Alfa ',
  cognome: 'Prova-E2E',
  gender: 'F',
  data_nascita: '[VALORE_DI_PROVA: nel file di test]',
  birth_city: 'Testville',
  birth_province: 'TV',
  birth_nation: 'Italia',
  citizenship: 'Italiana',
  codice_fiscale: '[VALORE_DI_PROVA: nel file di test]',
  residence_address: 'Via Finta',
  residence_street_number: '1',
  zip_code: '00000',
  residence_city: 'Testville',
  residence_province: 'TV',
  section_id: SEZIONE_ID,
  data_iscrizione: '2025-09-01',
  allergies: '[VALORE_DI_PROVA: nel file di test]',
  allergeni: ['latte'],
  note_mediche: '[VALORE_DI_PROVA: nel file di test]',
  is_bes_dsa: true,
  usa_pannolino: false,
  consenso_privacy: true,
  consenso_foto_sito: false,
  consenso_foto_social: null,
  scuola_id: 'e2e00000-0000-4000-8000-000000000001',
  stato: 'iscritto',
  // ── campi che NON devono uscire mai ──
  importo_retta_mensile: 987,
  retta_split_config: { quota: 'SPLIT-FINTO' },
  retta_a_carico_di: 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb',
  genitori_separati: true,
  intestatario_fatture: 'INTESTATARIO-FINTO',
  invoice_holder_name: 'TITOLARE-FATTURA-FINTO',
  fiscale_config: { regime: 'FISCALE-FINTO' },
  opposizione_ade: true,
  bollo_virtuale: true,
  giorno_scadenza_pagamenti: 10,
  sospeso: true,
  sospeso_motivo: 'MOROSITA-FINTA',
  documento_path: 'documenti/DOCUMENTO-FINTO.pdf',
  numero_domanda_sidi: 'SIDI-FINTO',
  archiviato_motivo: 'ARCHIVIO-FINTO',
}

const VIETATI = [
  'SPLIT-FINTO',
  'INTESTATARIO-FINTO',
  'TITOLARE-FATTURA-FINTO',
  'FISCALE-FINTO',
  'MOROSITA-FINTA',
  'DOCUMENTO-FINTO',
  'SIDI-FINTO',
  'ARCHIVIO-FINTO',
  '987',
  'b2b2b2b2',
]

describe('proiettaVoceElenco', () => {
  it('le chiavi in uscita sono ESATTAMENTE queste', () => {
    const voce = proiettaVoceElenco(RIGA_PIENA, 'infanzia')
    expect(Object.keys(voce).sort()).toEqual([
      'allergeni', 'annoNascita', 'besDsa', 'cognome', 'consensoFotoSito', 'consensoFotoSocial',
      'dataNascita', 'grado', 'haAllergie', 'id', 'nome', 'sectionId', 'sesso', 'usaPannolino',
    ])
  })

  it('niente economia, niente documenti, niente testo libero (allergie e note)', () => {
    const json = JSON.stringify(proiettaVoceElenco(RIGA_PIENA, 'infanzia'))
    for (const v of [...VIETATI, 'fragole', 'Riga uno', 'TSTPRV', 'Via Finta']) expect(json).not.toContain(v)
  })

  it('normalizza i valori', () => {
    const voce = proiettaVoceElenco(RIGA_PIENA, 'infanzia')
    expect(voce).toMatchObject({
      nome: 'Alfa',
      sectionId: SEZIONE_ID,
      grado: 'infanzia',
      dataNascita: '2021-03-04',
      annoNascita: 2021,
      sesso: 'F',
      allergeni: ['latte'],
      haAllergie: true,
      besDsa: true,
      usaPannolino: false,
      consensoFotoSito: false,
      consensoFotoSocial: null,
    })
  })

  it('allergeni dedotti dal testo quando l’archivio è vuoto; «fragole» resta un’allergia operativa', () => {
    expect(proiettaVoceElenco({ id: 'x', allergies: '[VALORE_DI_PROVA: nel file di test]', allergeni: [] }, null).allergeni).toEqual(['uova'])
    const soloFragole = proiettaVoceElenco({ id: 'x', allergies: '[VALORE_DI_PROVA: nel file di test]', allergeni: [] }, null)
    expect(soloFragole.allergeni).toEqual([])
    expect(soloFragole.haAllergie).toBe(true)
    expect(proiettaVoceElenco({ id: 'x', allergies: '[VALORE_DI_PROVA: nel file di test]', allergeni: [] }, null).haAllergie).toBe(false)
  })

  it('valori assenti o storti diventano null, non stringhe vuote né eccezioni', () => {
    const voce = proiettaVoceElenco({ id: 'x', gender: 'X', data_nascita: '[VALORE_DI_PROVA: nel file di test]', section_id: '' }, null)
    expect(voce).toMatchObject({ nome: '', sesso: null, dataNascita: null, annoNascita: null, sectionId: null })
  })
})

describe('proiettaScheda', () => {
  const genitori = proiettaGenitori([])
  const scheda = () =>
    proiettaScheda(RIGA_PIENA, {
      sezione: proiettaSezione({ id: SEZIONE_ID, name: 'Girasoli', school_type: 'infanzia', scuola_id: 'x' }),
      genitori,
      delegati: [],
    })

  it('le chiavi in uscita sono ESATTAMENTE queste', () => {
    expect(Object.keys(scheda()).sort()).toEqual([
      'cittadinanza', 'codiceFiscale', 'cognome', 'consensi', 'dataIscrizione', 'dataNascita',
      'delegati', 'genitori', 'id', 'luogoNascita', 'nome', 'residenza', 'salute', 'sesso', 'sezione',
    ])
  })

  it('niente economia, niente documenti', () => {
    const json = JSON.stringify(scheda())
    for (const v of VIETATI) expect(json).not.toContain(v)
  })

  it('anagrafica, salute e consensi come li vede l’insegnante', () => {
    const s = scheda()
    expect(s.codiceFiscale).toBe('TSTPRV21C44Z999Q')
    expect(s.luogoNascita).toEqual({ comune: 'Testville', provincia: 'TV', nazione: 'Italia' })
    expect(s.residenza).toEqual({ indirizzo: '[VALORE_DI_PROVA: nel file di test]', civico: '1', cap: '00000', comune: 'Testville', provincia: 'TV' })
    expect(s.sezione).toEqual({ id: SEZIONE_ID, nome: 'Girasoli', grado: 'infanzia' })
    expect(s.salute).toEqual({
      allergeni: ['latte'],
      allergieAltro: 'fragole',
      haAllergie: true,
      noteMediche: 'Riga uno\nRiga due',
      besDsa: true,
      usaPannolino: false,
    })
    expect(s.consensi).toEqual({ privacy: true, fotoSito: false, fotoSocial: null })
  })
})

describe('proiettaGenitori / proiettaDelegati', () => {
  it('esclude i genitori anonimizzati, normalizza la parentela, mette prima il referente', () => {
    const genitori = proiettaGenitori([
      { relation_type: 'father', is_primary: false, parents: { first_name: 'Papà', last_name: 'Prova-E2E', phone_numbers: ['333 000 0001'], emails: [], fiscal_code: null } },
      { relation_type: 'mother', is_primary: true, parents: [{ first_name: 'Mamma', last_name: 'Prova-E2E', phone_numbers: ['333 000 0000', ' '], emails: ['mamma@example.test'], fiscal_code: 'tstmmm80a41z999q', document_number: 'DOC-FINTO', documento_path: 'doc/finto.pdf', residence_address: 'Via Genitore' } }],
      { relation_type: 'mother', is_primary: false, parents: { first_name: 'Ex', last_name: 'Anonima', anonimizzato_il: '2026-01-01T00:00:00Z' } },
      { relation_type: 'nonna', is_primary: false, parents: null },
    ])
    expect(genitori.map((g) => g.nome)).toEqual(['Mamma', 'Papà'])
    expect(genitori[0]).toEqual({
      nome: 'Mamma',
      cognome: 'Prova-E2E',
      parentela: 'madre',
      principale: true,
      telefoni: ['333 000 0000'],
      email: ['mamma@example.test'],
      codiceFiscale: 'TSTMMM80A41Z999Q',
    })
    const json = JSON.stringify(genitori)
    for (const v of ['DOC-FINTO', 'doc/finto.pdf', 'Via Genitore', 'Anonima']) expect(json).not.toContain(v)
  })

  it('una parentela sconosciuta è «altro», una assente è null', () => {
    const [a, b] = proiettaGenitori([
      { relation_type: 'delegate', parents: { first_name: 'Zia', last_name: 'X' } },
      { relation_type: null, parents: { first_name: 'Y', last_name: 'X' } },
    ])
    expect(a.parentela).toBe('altro')
    expect(b.parentela).toBeNull()
  })

  it('i delegati portano nome e parentela, mai il documento', () => {
    const delegati = proiettaDelegati([
      { first_name: 'Nonna', last_name: 'Prova-E2E', relation: 'Nonna', document_number: 'DOC-DELEGATO', document_url: 'u' },
    ])
    expect(delegati).toEqual([{ nome: 'Nonna', cognome: 'Prova-E2E', parentela: 'Nonna' }])
  })

  it('un grado sconosciuto della sezione è null', () => {
    expect(proiettaSezione({ id: 's', name: 'X', school_type: 'liceo' }).grado).toBeNull()
  })
})
```

- [ ] **Step 3: verifica che fallisca**

Run: `npx vitest run __tests__/lib/anagrafica-docente-proiezione.test.ts 2>&1 | tail -8`
Expected: FAIL, `Failed to resolve import "@/lib/anagrafiche/docente/proiezione"`.

- [ ] **Step 4: implementa** — `src/lib/anagrafiche/docente/proiezione.ts`:

```ts
import {
  allergeniAlunno,
  chiaviAllergeni,
  haAllergiaOperativa,
  testoResiduoAllergie,
} from '@/lib/mensa/allergeni'
import type {
  DelegatoScheda,
  GenitoreScheda,
  Grado,
  Parentela,
  SchedaAlunnoDocente,
  SezioneElenco,
  VoceElencoAlunno,
} from './tipi'

/**
 * RIGA DEL DATABASE → RISPOSTA, campo per campo.
 *
 * Qui non si copia mai una riga intera: ogni campo in uscita è scritto a mano.
 * È la seconda metà della lista bianca (la prima sono le colonne di `colonne.ts`):
 * se un giorno la `select` si allargasse, anche a `*`, retta, intestatari e
 * documenti resterebbero comunque fuori. Le funzioni sono pure: niente database,
 * niente React, si provano da sole.
 */

/** Una riga come arriva da PostgREST: di nessun campo si dà per scontato il tipo. */
export type RigaDb = Record<string, unknown>

function testo(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function testi(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map(testo).filter((t): t is string => t !== null)
}

const vero = (v: unknown): boolean => v === true
const booleanoONull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const sesso = (v: unknown): 'M' | 'F' | null => (v === 'M' || v === 'F' ? v : null)

function dataIso(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

export function grado(v: unknown): Grado | null {
  return v === 'nido' || v === 'infanzia' || v === 'primaria' ? v : null
}

/**
 * Le allergie con la STESSA regola della home docente: le chiavi come stanno in
 * archivio (anche fuori dai 14 UE) più quelle dedotte dal testo libero, e del testo
 * solo ciò che le chiavi non dicono già. «Ha allergie» è il criterio OPERATIVO del
 * motore unico: in classe un «fragole» fuori dai 14 non si nasconde.
 */
function allergieDi(riga: RigaDb) {
  const opts = { allergeni: testi(riga.allergeni), allergies: testo(riga.allergies) }
  const chiavi = Array.from(new Set([...chiaviAllergeni(opts), ...allergeniAlunno(opts)]))
  return {
    chiavi,
    residuo: testoResiduoAllergie(opts.allergies, chiavi),
    operativa: haAllergiaOperativa(opts),
  }
}

export function proiettaSezione(riga: RigaDb): SezioneElenco {
  return { id: String(riga.id), nome: testo(riga.name) ?? '', grado: grado(riga.school_type) }
}

export function proiettaVoceElenco(riga: RigaDb, gradoSezione: Grado | null): VoceElencoAlunno {
  const allergie = allergieDi(riga)
  const nascita = dataIso(riga.data_nascita)
  return {
    id: String(riga.id),
    nome: testo(riga.nome) ?? '',
    cognome: testo(riga.cognome) ?? '',
    sectionId: testo(riga.section_id),
    grado: gradoSezione,
    dataNascita: nascita,
    annoNascita: nascita ? Number(nascita.slice(0, 4)) : null,
    sesso: sesso(riga.gender),
    allergeni: allergie.chiavi,
    haAllergie: allergie.operativa,
    besDsa: vero(riga.is_bes_dsa),
    usaPannolino: vero(riga.usa_pannolino),
    consensoFotoSito: booleanoONull(riga.consenso_foto_sito),
    consensoFotoSocial: booleanoONull(riga.consenso_foto_social),
  }
}

const ORDINE_PARENTELA: Record<Parentela, number> = { madre: 0, padre: 1, altro: 2 }

function parentela(v: unknown): Parentela | null {
  const r = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (r === '') return null
  if (r === 'mother' || r === 'madre') return 'madre'
  if (r === 'father' || r === 'padre') return 'padre'
  return 'altro'
}

/**
 * I genitori dai legami `student_parents` con `parents` incorporato (oggetto o
 * array, secondo come PostgREST risolve la relazione). Un genitore anonimizzato
 * (diritto all'oblio) non compare. Prima il referente principale, poi madre, padre,
 * altri.
 */
export function proiettaGenitori(legami: readonly RigaDb[]): GenitoreScheda[] {
  const genitori: GenitoreScheda[] = []
  for (const legame of legami) {
    const grezzo = Array.isArray(legame.parents) ? legame.parents[0] : legame.parents
    if (!grezzo || typeof grezzo !== 'object') continue
    const p = grezzo as RigaDb
    if (p.anonimizzato_il) continue
    genitori.push({
      nome: testo(p.first_name) ?? '',
      cognome: testo(p.last_name) ?? '',
      parentela: parentela(legame.relation_type),
      principale: vero(legame.is_primary),
      telefoni: testi(p.phone_numbers),
      email: testi(p.emails),
      codiceFiscale: testo(p.fiscal_code)?.toUpperCase() ?? null,
    })
  }
  return genitori.sort(
    (a, b) =>
      Number(b.principale) - Number(a.principale) ||
      ORDINE_PARENTELA[a.parentela ?? 'altro'] - ORDINE_PARENTELA[b.parentela ?? 'altro'],
  )
}

export function proiettaDelegati(righe: readonly RigaDb[]): DelegatoScheda[] {
  return righe.map((r) => ({
    nome: testo(r.first_name) ?? '',
    cognome: testo(r.last_name) ?? '',
    parentela: testo(r.relation),
  }))
}

export function proiettaScheda(
  riga: RigaDb,
  contorno: { sezione: SezioneElenco | null; genitori: GenitoreScheda[]; delegati: DelegatoScheda[] },
): SchedaAlunnoDocente {
  const allergie = allergieDi(riga)
  return {
    id: String(riga.id),
    nome: testo(riga.nome) ?? '',
    cognome: testo(riga.cognome) ?? '',
    sesso: sesso(riga.gender),
    dataNascita: dataIso(riga.data_nascita),
    luogoNascita: {
      comune: testo(riga.birth_city),
      provincia: testo(riga.birth_province),
      nazione: testo(riga.birth_nation),
    },
    cittadinanza: testo(riga.citizenship),
    codiceFiscale: testo(riga.codice_fiscale)?.toUpperCase() ?? null,
    residenza: {
      indirizzo: testo(riga.residence_address),
      civico: testo(riga.residence_street_number),
      cap: testo(riga.zip_code),
      comune: testo(riga.residence_city),
      provincia: testo(riga.residence_province),
    },
    sezione: contorno.sezione,
    dataIscrizione: dataIso(riga.data_iscrizione),
    salute: {
      allergeni: allergie.chiavi,
      allergieAltro: allergie.residuo === '' ? null : allergie.residuo,
      haAllergie: allergie.operativa,
      noteMediche: testo(riga.note_mediche),
      besDsa: vero(riga.is_bes_dsa),
      usaPannolino: vero(riga.usa_pannolino),
    },
    consensi: {
      privacy: booleanoONull(riga.consenso_privacy),
      fotoSito: booleanoONull(riga.consenso_foto_sito),
      fotoSocial: booleanoONull(riga.consenso_foto_social),
    },
    genitori: contorno.genitori,
    delegati: contorno.delegati,
  }
}
```

> ⚠️ Il lock `allergie-un-motore-solo` segna una riga che contiene **sia** `.note_mediche` **sia** «allerg». Ogni campo sta sulla sua riga, chiusa da una virgola: non unire `noteMediche` alle righe delle allergie.

- [ ] **Step 5: verifica che passi**

Run: `npx vitest run __tests__/lib/anagrafica-docente-proiezione.test.ts __tests__/architecture/allergie-un-motore-solo.test.ts 2>&1 | tail -8`
Expected: `Test Files  2 passed (2)`.

- [ ] **Step 6: prova di rottura** — in `proiettaVoceElenco` aggiungi temporaneamente `...riga,` in testa all'oggetto restituito, rilancia lo Step 5: i test «chiavi ESATTAMENTE» e «niente economia» devono diventare rossi. Togli la riga e riverifica il verde.

- [ ] **Step 7: commit**

```bash
git add src/lib/anagrafiche/docente/tipi.ts src/lib/anagrafiche/docente/proiezione.ts __tests__/lib/anagrafica-docente-proiezione.test.ts
git commit -m "Anagrafica docente: tipi e proiezione a lista bianca

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: chi vede quali alunni — controllo unico + lock sulle tabelle di assegnazione

**Files:**
- Create: `src/lib/anagrafiche/docente/visibilita.ts`
- Create: `src/lib/anagrafiche/docente/colonne.ts`
- Modify: `src/lib/primaria/fascicolo-rbac.ts` (commento sopra `sezioniContitolari`, righe ~78-88)
- Test: `__tests__/lib/anagrafica-docente-visibilita.test.ts`
- Test: `__tests__/architecture/assegnazioni-docente-coerenti.test.ts`

- [ ] **Step 1: crea le colonne** — `src/lib/anagrafiche/docente/colonne.ts`:

```ts
/**
 * LE COLONNE CHE L'ANAGRAFICA DOCENTE LEGGE, una per una. Mai `select('*')`.
 *
 * `COLONNE_GATE` sono tutte del baseline e non passano da `selectResiliente`: è la
 * lettura che decide se aprire, e non deve mai «degradare». Le altre sì — il
 * database E2E della CI non riceve le migrazioni da solo, e una colonna recente che
 * manca deve diventare un campo «Non indicato», non un 500.
 */

export const COLONNE_GATE = 'id, section_id, scuola_id, stato, anonimizzato_il'

export const COLONNE_ELENCO = [
  'id', 'nome', 'cognome', 'section_id', 'data_nascita', 'gender',
  'allergies', 'allergeni', 'is_bes_dsa', 'usa_pannolino',
  'consenso_foto_sito', 'consenso_foto_social',
] as const

export const COLONNE_SCHEDA = [
  'id', 'nome', 'cognome', 'gender', 'data_nascita',
  'birth_city', 'birth_province', 'birth_nation', 'citizenship', 'codice_fiscale',
  'residence_address', 'residence_street_number', 'zip_code', 'residence_city', 'residence_province',
  'section_id', 'data_iscrizione',
  'allergies', 'allergeni', 'note_mediche', 'is_bes_dsa', 'usa_pannolino',
  'consenso_privacy', 'consenso_foto_sito', 'consenso_foto_social',
] as const

/** I campi di `parents` incorporati nei legami: niente documento, nascita, residenza. */
export const COLONNE_LEGAMI =
  'relation_type, is_primary, parents ( first_name, last_name, phone_numbers, emails, fiscal_code, anonimizzato_il )'

/** I delegati al ritiro: niente numero né file del documento. */
export const COLONNE_DELEGATI = 'first_name, last_name, relation'
```

- [ ] **Step 2: scrivi il test che fallisce** — `__tests__/lib/anagrafica-docente-visibilita.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { creaFintoSupabase, type DBFinto, type OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))

import {
  assertAlunnoAnagraficaInScope,
  sezioniAnagraficaVisibili,
} from '@/lib/anagrafiche/docente/visibilita'

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_MATERIA = 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'
const ALU_MIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ALTRUI = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const ALU_MATERIA = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'
const ALU_B = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const ALU_RITIRATO = 'a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa'
const ALU_ANONIMO = 'a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa'
const ALU_SENZA_SEZIONE = 'a6a6a6a6-6666-4666-8666-aaaaaaaaaaaa'

const EDUCATOR: AppUser = { id: 'ed1', role: 'educator', scuola_id: SEDE_A }
const SEGRETERIA: AppUser = { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A }

let db: DBFinto
let tabelle: string[]
let opzioni: OpzioniFinto

const alunno = (id: string, section_id: string | null, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, section_id, scuola_id, stato: 'iscritto', anonimizzato_il: null, ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  tabelle = []
  opzioni = {}
  db = {
    utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
    // La stessa sezione anche per materia: l'unione non deve produrre doppioni.
    utenti_sezioni_materie: [
      { utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' },
      { utente_id: 'ed1', section_id: SEZ_MIA, materia_id: 'm2' },
    ],
    utenti_scuole: [],
    alunni: [
      alunno(ALU_MIO, SEZ_MIA, SEDE_A),
      alunno(ALU_ALTRUI, SEZ_ALTRUI, SEDE_A),
      alunno(ALU_MATERIA, SEZ_MATERIA, SEDE_A),
      alunno(ALU_B, SEZ_B, SEDE_B),
      alunno(ALU_RITIRATO, SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
      alunno(ALU_ANONIMO, SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
      alunno(ALU_SENZA_SEZIONE, null, SEDE_A),
    ],
  }
})

const client = () => creaFintoSupabase(db, tabelle, opzioni)

describe('sezioniAnagraficaVisibili', () => {
  it('segreteria: tutte le sezioni della sede, senza leggere le assegnazioni', async () => {
    expect(await sezioniAnagraficaVisibili(client(), SEGRETERIA)).toEqual({ esito: 'tutte' })
    expect(tabelle).toEqual([])
  })

  it('educator: unione di assegnazioni dirette e per materia, senza doppioni', async () => {
    const esito = await sezioniAnagraficaVisibili(client(), EDUCATOR)
    expect(esito.esito).toBe('sezioni')
    expect(esito.esito === 'sezioni' && [...esito.sezioni].sort()).toEqual([SEZ_MIA, SEZ_MATERIA].sort())
  })

  it('educator senza assegnazioni: elenco vuoto (nega per difetto)', async () => {
    db.utenti_sezioni = []
    db.utenti_sezioni_materie = []
    expect(await sezioniAnagraficaVisibili(client(), EDUCATOR)).toEqual({ esito: 'sezioni', sezioni: [] })
  })

  it('un guasto su una delle due letture è un ERRORE con log, mai «nessuna sezione»', async () => {
    opzioni = { errori: { utenti_sezioni_materie: { code: '57P01', message: 'terminating connection' } } }
    expect(await sezioniAnagraficaVisibili(client(), EDUCATOR)).toEqual({ esito: 'errore' })
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'error',
      expect.objectContaining({ tipo: 'anagrafica-sezioni-non-lette', utente: 'ed1' }),
      expect.objectContaining({ code: '57P01' }),
    )
  })
})

describe('assertAlunnoAnagraficaInScope', () => {
  const stato = async (user: AppUser, id: string) => {
    const esito = await assertAlunnoAnagraficaInScope(client(), user, id)
    return esito.ok ? 200 : esito.response.status
  }

  it('apre al docente della sezione e a quello di sola materia', async () => {
    expect(await stato(EDUCATOR, ALU_MIO)).toBe(200)
    expect(await stato(EDUCATOR, ALU_MATERIA)).toBe(200)
  })

  it('restituisce sezione e sede dell’alunno', async () => {
    const esito = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_MIO)
    expect(esito).toEqual({ ok: true, alunno: { id: ALU_MIO, sectionId: SEZ_MIA, scuolaId: SEDE_A } })
  })

  it('403 per una sezione non sua della stessa sede, con una traccia warn per bambino', async () => {
    const esito = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_ALTRUI)
    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.response.status).toBe(403)
    expect((await esito.response.json()).codice).toBe('ANAGRAFICA_FUORI_SEZIONE')
    expect(h.logEvento).toHaveBeenCalledWith(
      'auth',
      'warn',
      expect.objectContaining({ tipo: 'anagrafica-fuori-sezione', utente: 'ed1', alunno_id: ALU_ALTRUI }),
      undefined,
      { distingui: ['alunno_id'] },
    )
  })

  it('403 per un alunno senza sezione (educator) e per un’altra sede', async () => {
    expect(await stato(EDUCATOR, ALU_SENZA_SEZIONE)).toBe(403)
    const esito = await assertAlunnoAnagraficaInScope(client(), EDUCATOR, ALU_B)
    expect(!esito.ok && (await esito.response.json()).codice).toBe('ANAGRAFICA_FUORI_SEDE')
  })

  it('404 per inesistente, non iscritto, anonimizzato — prima di guardare le sezioni', async () => {
    for (const id of ['c0c0c0c0-0000-4000-8000-cccccccccccc', ALU_RITIRATO, ALU_ANONIMO]) {
      tabelle = []
      expect(await stato(EDUCATOR, id)).toBe(404)
      expect(tabelle).not.toContain('utenti_sezioni')
    }
  })

  it('segreteria: ogni alunno della propria sede, nessuno delle altre', async () => {
    expect(await stato(SEGRETERIA, ALU_ALTRUI)).toBe(200)
    expect(await stato(SEGRETERIA, ALU_SENZA_SEZIONE)).toBe(200)
    expect(await stato(SEGRETERIA, ALU_B)).toBe(403)
  })

  it('500 se l’alunno non si riesce a leggere, o se le assegnazioni non si leggono', async () => {
    opzioni = { errori: { alunni: { code: '57P01' } } }
    expect(await stato(EDUCATOR, ALU_MIO)).toBe(500)
    opzioni = { errori: { utenti_sezioni: { code: '57P01' } } }
    expect(await stato(EDUCATOR, ALU_MIO)).toBe(500)
  })
})
```

- [ ] **Step 3: verifica che fallisca**

Run: `npx vitest run __tests__/lib/anagrafica-docente-visibilita.test.ts 2>&1 | tail -8`
Expected: FAIL, `Failed to resolve import "@/lib/anagrafiche/docente/visibilita"`.

- [ ] **Step 4: implementa** — `src/lib/anagrafiche/docente/visibilita.ts`:

```ts
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { scuoleDiUtente, vedeTutteLeClassi } from '@/lib/auth/scope'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { logEvento } from '@/lib/logging/logger'
import { COLONNE_GATE } from './colonne'

/**
 * «QUESTO BAMBINO È UNO DEI TUOI?» — una risposta sola, per l'elenco e per la scheda.
 *
 * Perché non `assertAlunnoInScope`: per l'educator conta solo `utenti_sezioni`, e il
 * docente assegnato a una classe della primaria per una sola materia (inglese,
 * religione, motoria) ne resterebbe fuori. Il titolare ha deciso (2026-10-04) che
 * l'anagrafica la vedono TUTTI i docenti della classe: è la regola di
 * `puoAccedereFascicolo` / `sezioniContitolari`, che leggono le stesse due tabelle.
 * Il lock `__tests__/architecture/assegnazioni-docente-coerenti.test.ts` tiene le tre
 * funzioni d'accordo.
 *
 * Perché non quelle due: non controllano l'`error` di PostgREST, e un guasto esce
 * come «nessuna sezione» — cioè come un permesso negato o un elenco vuoto, senza
 * traccia. Su un dato di minori «non sono riuscito a leggere» e «non è tuo» non
 * possono avere la stessa risposta: qui il primo è un 500 con log `error`.
 */

export type SezioniVisibili =
  | { esito: 'tutte' }
  | { esito: 'sezioni'; sezioni: string[] }
  | { esito: 'errore' }

export async function sezioniAnagraficaVisibili(
  supabase: SupabaseClient,
  user: AppUser,
): Promise<SezioniVisibili> {
  if (vedeTutteLeClassi(user)) return { esito: 'tutte' }
  const [dirette, perMateria] = await Promise.all([
    supabase.from('utenti_sezioni').select('section_id').eq('utente_id', user.id),
    supabase.from('utenti_sezioni_materie').select('section_id').eq('utente_id', user.id),
  ])
  const guasto = dirette.error ?? perMateria.error
  if (guasto) {
    logEvento(
      'auth',
      'error',
      { tipo: 'anagrafica-sezioni-non-lette', azione: 'sezioniAnagraficaVisibili', utente: user.id },
      guasto,
    )
    return { esito: 'errore' }
  }
  const sezioni = new Set<string>()
  for (const riga of [...(dirette.data ?? []), ...(perMateria.data ?? [])]) {
    const id = (riga as { section_id?: string | null }).section_id
    if (id) sezioni.add(id)
  }
  return { esito: 'sezioni', sezioni: [...sezioni] }
}

export interface AlunnoInScope {
  id: string
  sectionId: string | null
  scuolaId: string
}

export type EsitoScope = { ok: true; alunno: AlunnoInScope } | { ok: false; response: NextResponse }

const rifiuto = (status: number, error: string, codice: string): EsitoScope => ({
  ok: false,
  response: NextResponse.json({ error, codice }, { status, headers: { 'Cache-Control': 'no-store' } }),
})

/**
 * Il controllo della scheda. L'ordine conta: si legge solo la riga minima del
 * bambino (colonne del baseline), si risponde 404 a ciò che non è un iscritto vivo,
 * poi sede, poi sezione. Nessun dato anagrafico si legge prima che tutto sia passato.
 * Il nome segue il contratto `assert…InScope` che il lock dell'isolamento per sede
 * riconosce.
 */
export async function assertAlunnoAnagraficaInScope(
  supabase: SupabaseClient,
  user: AppUser,
  alunnoId: string,
): Promise<EsitoScope> {
  const { data, error } = await supabase.from('alunni').select(COLONNE_GATE).eq('id', alunnoId).maybeSingle()
  if (error) {
    logEvento(
      'auth',
      'error',
      { tipo: 'anagrafica-alunno-non-letto', azione: 'assertAlunnoAnagraficaInScope', utente: user.id },
      error,
    )
    return rifiuto(500, 'Verifica di accesso non riuscita', 'ANAGRAFICA_SCOPE_NON_RISOLTO')
  }
  const riga = data as {
    id: string
    section_id: string | null
    scuola_id: string | null
    stato: string | null
    anonimizzato_il: string | null
  } | null
  if (!riga || riga.stato !== STATO_ISCRITTO || riga.anonimizzato_il) {
    return rifiuto(404, 'Alunno non trovato', 'ANAGRAFICA_NON_TROVATA')
  }

  const plessi = await scuoleDiUtente(supabase, user)
  if (!riga.scuola_id || !plessi.includes(riga.scuola_id)) {
    return rifiuto(403, 'Alunno fuori dalla tua sede', 'ANAGRAFICA_FUORI_SEDE')
  }

  const visibili = await sezioniAnagraficaVisibili(supabase, user)
  if (visibili.esito === 'errore') {
    return rifiuto(500, 'Verifica di accesso non riuscita', 'ANAGRAFICA_SCOPE_NON_RISOLTO')
  }
  if (visibili.esito === 'sezioni' && (!riga.section_id || !visibili.sezioni.includes(riga.section_id))) {
    // Una riga per (utente, bambino, giorno): è la traccia di chi prova ad aprire
    // schede non sue. Il volume lo limita il gesto stesso (un tocco per scheda).
    logEvento(
      'auth',
      'warn',
      { tipo: 'anagrafica-fuori-sezione', azione: 'assertAlunnoAnagraficaInScope', utente: user.id, alunno_id: alunnoId },
      undefined,
      { distingui: ['alunno_id'] },
    )
    return rifiuto(403, 'Alunno non nella tua classe', 'ANAGRAFICA_FUORI_SEZIONE')
  }

  return { ok: true, alunno: { id: riga.id, sectionId: riga.section_id, scuolaId: riga.scuola_id } }
}
```

- [ ] **Step 5: verifica che passi**

Run: `npx vitest run __tests__/lib/anagrafica-docente-visibilita.test.ts 2>&1 | tail -8`
Expected: `Test Files  1 passed (1)`.

- [ ] **Step 6: scrivi il lock** — `__tests__/architecture/assegnazioni-docente-coerenti.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * LE TRE FUNZIONI CHE DICONO «QUESTA CLASSE È TUA» LEGGONO LE STESSE TABELLE.
 *
 * `puoAccedereFascicolo` e `sezioniContitolari` (fascicolo, documenti sanitari) e
 * `sezioniAnagraficaVisibili` (anagrafica docente) devono contare sia le
 * assegnazioni dirette (`utenti_sezioni`) sia quelle per materia
 * (`utenti_sezioni_materie`). Se una delle tre perdesse una tabella, un docente
 * vedrebbe un bambino nell'elenco e non ne aprirebbe la scheda, o il contrario —
 * senza che niente diventi rosso. Il commento di `fascicolo-rbac.ts` prometteva questo
 * controllo in un file che non è mai esistito: ora esiste, ed è questo.
 *
 * Si leggono i sorgenti SENZA i commenti: un nome di tabella citato in un commento
 * non è una lettura.
 */

const TABELLE = ["'utenti_sezioni'", "'utenti_sezioni_materie'"]

const FUNZIONI = [
  { file: 'src/lib/primaria/fascicolo-rbac.ts', nome: 'puoAccedereFascicolo' },
  { file: 'src/lib/primaria/fascicolo-rbac.ts', nome: 'sezioniContitolari' },
  { file: 'src/lib/anagrafiche/docente/visibilita.ts', nome: 'sezioniAnagraficaVisibili' },
]

function senzaCommenti(codice: string): string {
  return codice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Il corpo di `export async function <nome>(` fino alla dichiarazione esportata successiva. */
function corpoDi(sorgente: string, nome: string): string | null {
  const inizio = sorgente.indexOf(`export async function ${nome}(`)
  if (inizio < 0) return null
  const fine = sorgente.indexOf('\nexport ', inizio + 1)
  return senzaCommenti(sorgente.slice(inizio, fine < 0 ? undefined : fine))
}

const mancanti = (corpo: string) => TABELLE.filter((t) => !corpo.includes(t))

describe('LOCK · le assegnazioni docente↔classe si leggono ovunque dalle stesse due tabelle', () => {
  it.each(FUNZIONI)('$nome legge entrambe le tabelle', ({ file, nome }) => {
    const corpo = corpoDi(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), nome)
    expect(corpo, `${nome} non trovata in ${file}: il lock non sta misurando niente`).not.toBeNull()
    expect(mancanti(corpo ?? ''), `${nome} non legge: ${mancanti(corpo ?? '').join(', ')}`).toEqual([])
  })

  it('CONTROLLO POSITIVO — una funzione che ne legge una sola viene vista', () => {
    const finto =
      "export async function x(s) {\n  // 'utenti_sezioni_materie' citata solo qui\n  return s.from('utenti_sezioni')\n}\n"
    expect(mancanti(corpoDi(finto, 'x') ?? '')).toEqual(["'utenti_sezioni_materie'"])
  })
})
```

- [ ] **Step 7: correggi il commento bugiardo** — in `src/lib/primaria/fascicolo-rbac.ts` sostituisci

```ts
 * ⚠️ Le due funzioni devono restare d'accordo. Se un giorno nasce una terza
 * tabella di assegnazione, va aggiunta in entrambe — un elenco più generoso del
```

con

```ts
 * ⚠️ Le due funzioni devono restare d'accordo, e con loro `sezioniAnagraficaVisibili`
 * (`src/lib/anagrafiche/docente/visibilita.ts`). Se un giorno nasce un'altra
 * tabella di assegnazione, va aggiunta in tutte e tre — un elenco più generoso del
```

e sostituisci

```ts
 * Il lock `__tests__/lib/documenti-registro-rbac.test.ts` verifica che leggano
 * le stesse due tabelle.
```

con

```ts
 * Il lock `__tests__/architecture/assegnazioni-docente-coerenti.test.ts` verifica
 * che leggano le stesse due tabelle (fino al 2026-10-04 questo commento citava un
 * file che non è mai esistito).
```

- [ ] **Step 8: verifica**

Run: `npx vitest run __tests__/architecture/assegnazioni-docente-coerenti.test.ts __tests__/lib/anagrafica-docente-visibilita.test.ts 2>&1 | tail -8`
Expected: `Test Files  2 passed (2)`. Prova di rottura: togli temporaneamente la lettura di `utenti_sezioni_materie` da `sezioniAnagraficaVisibili` → il lock e il test «unione» diventano rossi. Ripristina.

- [ ] **Step 9: commit**

```bash
git add src/lib/anagrafiche/docente/colonne.ts src/lib/anagrafiche/docente/visibilita.ts src/lib/primaria/fascicolo-rbac.ts __tests__/lib/anagrafica-docente-visibilita.test.ts __tests__/architecture/assegnazioni-docente-coerenti.test.ts
git commit -m "Anagrafica docente: controllo unico di visibilità e lock sulle assegnazioni

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `GET /api/teacher/alunni` — l'elenco

**Files:**
- Create: `src/app/api/teacher/alunni/route.ts`
- Test: `__tests__/api/teacher-alunni.test.ts`
- Modify: `src/lib/ui/esito-fetch.ts`, `messages/{it,en}/shared.json` (codice d'errore)

- [ ] **Step 1: scrivi il test che fallisce** — `__tests__/api/teacher-alunni.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_MATERIA = 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  opzioni: {} as Record<string, unknown>,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, h.opzioni as OpzioniFinto) }
})

import * as rotta from '@/app/api/teacher/alunni/route'

const riga = (id: string, nome: string, cognome: string, section_id: string, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, nome, cognome, section_id, scuola_id,
  stato: 'iscritto', anonimizzato_il: null, gender: 'F', data_nascita: '[VALORE_DI_PROVA: nel file di test]',
  allergies: null, allergeni: [], is_bes_dsa: false, usa_pannolino: false,
  consenso_foto_sito: true, consenso_foto_social: true,
  note_mediche: '[VALORE_DI_PROVA: nel file di test]', codice_fiscale: '[VALORE_DI_PROVA: nel file di test]', importo_retta_mensile: 987,
  ...extra,
})

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_MIA, scuola_id: SEDE_A, name: 'Girasoli', school_type: 'infanzia' },
    { id: SEZ_MATERIA, scuola_id: SEDE_A, name: '3A', school_type: 'primaria' },
    { id: SEZ_ALTRUI, scuola_id: SEDE_A, name: 'Tulipani', school_type: 'infanzia' },
    { id: SEZ_B, scuola_id: SEDE_B, name: 'Girasoli', school_type: 'infanzia' },
  ],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
  utenti_sezioni_materie: [{ utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' }],
  utenti_scuole: [],
  alunni: [
    riga('a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', 'Alfa', 'Zeta', SEZ_MIA, SEDE_A),
    riga('a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa', 'Beta', 'Alfieri', SEZ_MATERIA, SEDE_A, { allergeni: ['latte'] }),
    riga('a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa', 'Gamma', 'Altrui', SEZ_ALTRUI, SEDE_A),
    riga('b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb', 'Delta', 'Sedeb', SEZ_B, SEDE_B),
    riga('a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa', 'Eta', 'Ritirato', SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
    riga('a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa', 'Teta', 'Anonimo', SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
  ],
})

const chiama = () => rotta.GET(new NextRequest('http://localhost/api/teacher/alunni'))

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.opzioni = {}
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/teacher/alunni', () => {
  it('educator: solo i bambini iscritti delle sue sezioni (dirette e per materia), in ordine di cognome', async () => {
    const res = await chiama()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const corpo = await res.json()
    expect(corpo.alunni.map((a: { cognome: string }) => a.cognome)).toEqual(['Alfieri', 'Zeta'])
    expect(corpo.sezioni.map((s: { id: string }) => s.id).sort()).toEqual([SEZ_MIA, SEZ_MATERIA].sort())
    expect(corpo.alunni[0]).toMatchObject({ grado: 'primaria', allergeni: ['latte'], haAllergie: true })
  })

  it('niente testo sanitario, codice fiscale o economia nell’elenco', async () => {
    const testo = await (await chiama()).text()
    for (const v of ['NOTA-RISERVATA', 'TSTCFX', '987']) expect(testo).not.toContain(v)
  })

  it('educator senza assegnazioni: elenco vuoto SENZA interrogare gli alunni', async () => {
    h.db.utenti_sezioni = []
    h.db.utenti_sezioni_materie = []
    const res = await chiama()
    expect(await res.json()).toEqual({ sezioni: [], alunni: [] })
    expect(h.tabelle).not.toContain('alunni')
  })

  it('segreteria: tutti gli iscritti della propria sede, nessuno dell’altra', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const corpo = await (await chiama()).json()
    expect(corpo.alunni.map((a: { cognome: string }) => a.cognome)).toEqual(['Alfieri', 'Altrui', 'Zeta'])
  })

  it('il rifiuto del gate di ruolo passa intatto e non legge niente', async () => {
    h.requireDocente.mockResolvedValue({ response: new Response('{}', { status: 403 }) })
    expect((await chiama()).status).toBe(403)
    expect(h.tabelle).toEqual([])
  })

  it('500 se gli alunni non si leggono', async () => {
    h.opzioni = { errori: { alunni: { code: '57P01' } } }
    const res = await chiama()
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ANAGRAFICA_ELENCO_NON_LETTO')
  })

  it('500 se le assegnazioni non si leggono, senza toccare gli alunni', async () => {
    h.opzioni = { errori: { utenti_sezioni: { code: '57P01' } } }
    expect((await chiama()).status).toBe(500)
    expect(h.tabelle).not.toContain('alunni')
  })

  it('sola lettura: il modulo esporta SOLO `GET`', () => {
    const metodi = Object.keys(rotta).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    expect(metodi).toEqual(['GET'])
  })
})
```

- [ ] **Step 2: verifica che fallisca**

Run: `npx vitest run __tests__/api/teacher-alunni.test.ts 2>&1 | tail -8`
Expected: FAIL, `Failed to resolve import "@/app/api/teacher/alunni/route"`.

- [ ] **Step 3: implementa** — `src/app/api/teacher/alunni/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireEnv } from '@/lib/security/require-env'
import { requireDocente } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { STATO_ISCRITTO } from '@/lib/alunni/stato'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { selectResiliente } from '@/lib/supabase/select-resiliente'
import { sezioniAnagraficaVisibili } from '@/lib/anagrafiche/docente/visibilita'
import { COLONNE_ELENCO } from '@/lib/anagrafiche/docente/colonne'
import { proiettaSezione, proiettaVoceElenco, type RigaDb } from '@/lib/anagrafiche/docente/proiezione'
import type { ElencoAlunniRisposta } from '@/lib/anagrafiche/docente/tipi'

/**
 * GET /api/teacher/alunni — l'elenco dei bambini di cui l'utente vede l'anagrafica.
 *
 * SOLA LETTURA: questo modulo esporta solo `GET`, e un test lo verifica. Educator →
 * gli iscritti delle sezioni assegnate direttamente o per materia; direzione,
 * coordinamento e segreteria → gli iscritti della propria sede. L'elenco porta solo
 * ciò che serve a riconoscere e filtrare (nessun testo sanitario, nessun codice
 * fiscale): la scheda completa sta in `[id]`, che scrive nel registro degli accessi.
 */

/** Nessun parametro: lo schema vuoto lo dichiara, e `parseQuery` scarta il resto. */
const getQuerySchema = z.object({})

const OPERAZIONE = 'teacher/alunni:GET'
const SENZA_CACHE = { 'Cache-Control': 'no-store' }
const VUOTO: ElencoAlunniRisposta = { sezioni: [], alunni: [] }

const erroreLettura = () =>
  NextResponse.json(
    { error: 'Elenco degli alunni non letto', codice: 'ANAGRAFICA_ELENCO_NON_LETTO' },
    { status: 500, headers: SENZA_CACHE },
  )

export const GET = withRoute(OPERAZIONE, async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response
    const user = auth.user

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const configurazione = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
    if (configurazione) return configurazione
    const supabase = await createAdminClient()

    const plessi = await resolveScuoleAttive(request, supabase, user)
    if (plessi.length === 0) return NextResponse.json(VUOTO, { headers: SENZA_CACHE })

    // Le sezioni PRIMA della query: un educator senza assegnazioni esce di qui senza
    // aver chiesto niente agli alunni, e un guasto non diventa un elenco vuoto.
    const visibili = await sezioniAnagraficaVisibili(supabase, user)
    if (visibili.esito === 'errore') return erroreLettura()
    if (visibili.esito === 'sezioni' && visibili.sezioni.length === 0) {
      return NextResponse.json(VUOTO, { headers: SENZA_CACHE })
    }

    const { data: righe, error: erroreAlunni } = await selectResiliente(
      COLONNE_ELENCO,
      (colonne) => {
        let query = supabase
          .from('alunni')
          .select(colonne.join(', '))
          .in('scuola_id', plessi)
          .eq('stato', STATO_ISCRITTO)
          .is('anonimizzato_il', null)
        if (visibili.esito === 'sezioni') query = query.in('section_id', visibili.sezioni)
        return query.order('cognome', { ascending: true }).order('nome', { ascending: true }).limit(1000)
      },
      OPERAZIONE,
      { livello: 'warn' },
    )
    if (erroreAlunni) {
      logErrore({ operazione: OPERAZIONE, stato: 500 }, erroreAlunni)
      return erroreLettura()
    }
    const alunni = (righe ?? []) as unknown as RigaDb[]

    const idSezioni = [...new Set(alunni.map((a) => a.section_id).filter((s): s is string => typeof s === 'string'))]
    let sezioni: ElencoAlunniRisposta['sezioni'] = []
    if (idSezioni.length > 0) {
      const { data: righeSezioni, error: erroreSezioni } = await supabase
        .from('sections')
        .select('id, name, school_type')
        .in('id', idSezioni)
        .in('scuola_id', plessi)
        .order('name', { ascending: true })
      if (erroreSezioni) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, erroreSezioni)
        return erroreLettura()
      }
      sezioni = ((righeSezioni ?? []) as RigaDb[]).map(proiettaSezione)
    }
    const gradoDi = new Map(sezioni.map((s) => [s.id, s.grado]))

    const risposta: ElencoAlunniRisposta = {
      sezioni,
      alunni: alunni.map((a) => proiettaVoceElenco(a, gradoDi.get(String(a.section_id)) ?? null)),
    }
    return NextResponse.json(risposta, { headers: SENZA_CACHE })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return erroreLettura()
  }
})
```

- [ ] **Step 3b: dichiara il codice d'errore** — il lock `errori-con-codice` pretende che ogni codice che esce da `src/` sia dichiarato e tradotto. In `src/lib/ui/esito-fetch.ts`, dentro `CODICI_ERRORE`, accanto alle voci `ANAGRAFICA_*` del Task 3:

```ts
    /** 500 — l'elenco dell'anagrafica docente non si è potuto leggere (`api/teacher/alunni`). */
    ANAGRAFICA_ELENCO_NON_LETTO: 'erroreAnagraficaElencoNonLetto',
```

e nei due cataloghi condivisi, accanto alle altre voci `erroreAnagrafica…`:

```json
  "erroreAnagraficaElencoNonLetto": "Non è stato possibile caricare l’elenco degli alunni.",
```

(`messages/it/shared.json`) e

```json
  "erroreAnagraficaElencoNonLetto": "The student list could not be loaded.",
```

(`messages/en/shared.json`).

- [ ] **Step 4: verifica che passi, insieme ai lock delle route**

Run: `npx vitest run __tests__/api/teacher-alunni.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/elenchi-operativi-solo-iscritti.test.ts __tests__/architecture/scope-vuoto-nega.test.ts __tests__/architecture/identita-della-classe.test.ts 2>&1 | tail -12`
Expected: `Test Files  8 passed (8)`. Se un lock è rosso, leggi il suo messaggio: dice esattamente quale forma vuole (per esempio il filtro di sede nella stessa catena della query). Correggi la route, **mai** il lock.

- [ ] **Step 5: commit**

```bash
git add src/app/api/teacher/alunni/route.ts __tests__/api/teacher-alunni.test.ts src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json
git commit -m "Anagrafica docente: GET /api/teacher/alunni (elenco in sola lettura)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/teacher/alunni/[id]` — la scheda, con audit

**Files:**
- Create: `src/app/api/teacher/alunni/[id]/route.ts`
- Test: `__tests__/api/teacher-alunni-scheda.test.ts`
- Modify: `src/lib/ui/esito-fetch.ts`, `messages/{it,en}/shared.json` (codice d'errore)

- [ ] **Step 1: scrivi il test che fallisce** — `__tests__/api/teacher-alunni-scheda.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, OpzioniFinto, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

const SEZ_MIA = 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_ALTRUI = 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa'
const SEZ_MATERIA = 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa'
const SEZ_B = 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb'
const ALU_MIO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ALTRUI = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const ALU_MATERIA = 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa'
const ALU_B = 'b1b1b1b1-1111-4111-8111-bbbbbbbbbbbb'
const ALU_RITIRATO = 'a4a4a4a4-4444-4444-8444-aaaaaaaaaaaa'
const ALU_ANONIMO = 'a5a5a5a5-5555-4555-8555-aaaaaaaaaaaa'
const CF_MIO = 'TSTMIO21C44Z999Q'

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: undefined as Record<string, { code: string }> | undefined,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { errori: h.errori, scritture: h.scritture } as OpzioniFinto),
  }
})

import * as rotta from '@/app/api/teacher/alunni/[id]/route'

const alunno = (id: string, section_id: string, scuola_id: string, extra: Record<string, unknown> = {}) => ({
  id, section_id, scuola_id, nome: 'Alfa', cognome: 'Prova-E2E', stato: 'iscritto', anonimizzato_il: null,
  gender: 'F', data_nascita: '[VALORE_DI_PROVA: nel file di test]', codice_fiscale: `[VALORE_DI_PROVA: nel file di test]`,
  allergies: null, allergeni: [], note_mediche: null, is_bes_dsa: false, usa_pannolino: false,
  consenso_privacy: true, consenso_foto_sito: true, consenso_foto_social: false,
  importo_retta_mensile: 987, intestatario_fatture: 'INTESTATARIO-FINTO', documento_path: 'doc/ALUNNO-FINTO.pdf',
  ...extra,
})

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_MIA, scuola_id: SEDE_A, name: 'Girasoli', school_type: 'infanzia' },
    { id: SEZ_ALTRUI, scuola_id: SEDE_A, name: 'Tulipani', school_type: 'infanzia' },
    { id: SEZ_MATERIA, scuola_id: SEDE_A, name: '3A', school_type: 'primaria' },
    { id: SEZ_B, scuola_id: SEDE_B, name: 'Girasoli', school_type: 'infanzia' },
  ],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: SEZ_MIA }],
  utenti_sezioni_materie: [{ utente_id: 'ed1', section_id: SEZ_MATERIA, materia_id: 'm1' }],
  utenti_scuole: [],
  alunni: [
    alunno(ALU_MIO, SEZ_MIA, SEDE_A, { codice_fiscale: CF_MIO.toLowerCase(), allergies: '[VALORE_DI_PROVA: nel file di test]', allergeni: ['latte'] }),
    alunno(ALU_ALTRUI, SEZ_ALTRUI, SEDE_A),
    alunno(ALU_MATERIA, SEZ_MATERIA, SEDE_A),
    alunno(ALU_B, SEZ_B, SEDE_B),
    alunno(ALU_RITIRATO, SEZ_MIA, SEDE_A, { stato: 'ritirato' }),
    alunno(ALU_ANONIMO, SEZ_MIA, SEDE_A, { anonimizzato_il: '2026-09-01T00:00:00Z' }),
  ],
  student_parents: [
    {
      student_id: ALU_MIO, relation_type: 'mother', is_primary: true,
      parents: { first_name: 'Mamma', last_name: 'Prova-E2E', phone_numbers: ['333 000 0000'], emails: ['mamma@example.test'], fiscal_code: 'tstmmm80a41z999q', anonimizzato_il: null, document_number: 'DOC-GENITORE-FINTO', documento_path: 'doc/GENITORE-FINTO.pdf' },
    },
    { student_id: ALU_MIO, relation_type: 'father', is_primary: false, parents: { first_name: 'Ex', last_name: 'Anonimo', anonimizzato_il: '2026-01-01T00:00:00Z' } },
    { student_id: ALU_ALTRUI, relation_type: 'mother', is_primary: true, parents: { first_name: 'Altra', last_name: 'Mamma', anonimizzato_il: null } },
  ],
  delegates: [
    { id: 'd1', student_id: ALU_MIO, first_name: 'Nonna', last_name: 'Prova-E2E', relation: 'Nonna', document_number: 'DOC-DELEGATO-FINTO', document_url: 'u', created_at: '2026-09-01T00:00:00Z' },
  ],
  fascicolo_accessi_audit: [],
})

const chiama = (id: string) =>
  rotta.GET(new NextRequest(`http://localhost/api/teacher/alunni/${id}`), { params: Promise.resolve({ id }) })

const audit = () => (h.scritture as Scrittura[]).filter((s) => s.tabella === 'fascicolo_accessi_audit')

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = undefined
  h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
})

describe('GET /api/teacher/alunni/[id] — si apre', () => {
  it('educator della sezione: scheda completa, senza economia né documenti, e una riga di audit', async () => {
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const testo = await res.text()
    for (const v of ['987', 'INTESTATARIO-FINTO', 'ALUNNO-FINTO', 'DOC-GENITORE-FINTO', 'GENITORE-FINTO', 'DOC-DELEGATO-FINTO', 'Anonimo']) {
      expect(testo).not.toContain(v)
    }
    const scheda = JSON.parse(testo)
    expect(scheda.codiceFiscale).toBe(CF_MIO)
    expect(scheda.sezione).toEqual({ id: SEZ_MIA, nome: 'Girasoli', grado: 'infanzia' })
    expect(scheda.salute).toMatchObject({ allergeni: ['latte'], allergieAltro: 'fragole', haAllergie: true })
    expect(scheda.genitori).toEqual([
      { nome: 'Mamma', cognome: 'Prova-E2E', parentela: 'madre', principale: true, telefoni: ['333 000 0000'], email: ['mamma@example.test'], codiceFiscale: 'TSTMMM80A41Z999Q' },
    ])
    expect(scheda.delegati).toEqual([{ nome: 'Nonna', cognome: 'Prova-E2E', parentela: 'Nonna' }])

    expect(audit()).toHaveLength(1)
    expect(audit()[0].valori[0]).toMatchObject({ alunno_id: ALU_MIO, utente_id: 'ed1', azione: 'view', finalita: 'anagrafica-docente' })
  })

  it('educator assegnato per sola materia', async () => {
    expect((await chiama(ALU_MATERIA)).status).toBe(200)
  })

  it('segreteria: ogni bambino della propria sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    expect((await chiama(ALU_ALTRUI)).status).toBe(200)
  })

  it('se l’audit fallisce la scheda si mostra lo stesso, e il guasto va nei log', async () => {
    h.errori = { 'fascicolo_accessi_audit:insert': { code: '57P01' } }
    expect((await chiama(ALU_MIO)).status).toBe(200)
    expect(h.logEvento).toHaveBeenCalledWith('fascicolo', 'error', expect.objectContaining({ esito: 'audit-non-registrato', alunno_id: ALU_MIO }), expect.anything())
  })
})

describe('GET /api/teacher/alunni/[id] — non si apre', () => {
  it('403 su un bambino di un’altra sezione, SENZA leggerne l’anagrafica', async () => {
    const res = await chiama(ALU_ALTRUI)
    expect(res.status).toBe(403)
    expect(h.tabelle.filter((t) => t === 'alunni')).toHaveLength(1)
    expect(h.tabelle).not.toContain('student_parents')
    expect(h.tabelle).not.toContain('delegates')
    expect(audit()).toHaveLength(0)
    const testo = await res.text()
    expect(testo).not.toContain('tsta2a2')
    expect(testo).not.toContain('Altra')
  })

  it('403 su un bambino di un’altra sede', async () => {
    const res = await chiama(ALU_B)
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('ANAGRAFICA_FUORI_SEDE')
  })

  it('404 per non iscritto, anonimizzato, inesistente', async () => {
    for (const id of [ALU_RITIRATO, ALU_ANONIMO, 'c0c0c0c0-0000-4000-8000-cccccccccccc']) {
      expect((await chiama(id)).status).toBe(404)
    }
    expect(h.tabelle).not.toContain('student_parents')
  })

  it('400 per un id che non è un uuid, senza toccare il database', async () => {
    expect((await chiama('non-un-uuid')).status).toBe(400)
    expect(h.tabelle).toEqual([])
  })

  it('il rifiuto del gate di ruolo passa intatto e non legge niente', async () => {
    h.requireDocente.mockResolvedValue({ response: new Response('{}', { status: 401 }) })
    expect((await chiama(ALU_MIO)).status).toBe(401)
    expect(h.tabelle).toEqual([])
  })

  it('500 se genitori o delegati non si leggono, e nessuna riga di audit', async () => {
    h.errori = { 'student_parents:select': { code: '57P01' } }
    const res = await chiama(ALU_MIO)
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('ANAGRAFICA_NON_LETTA')
    expect(audit()).toHaveLength(0)
  })

  it('sola lettura: il modulo esporta SOLO `GET`', () => {
    const metodi = Object.keys(rotta).filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    expect(metodi).toEqual(['GET'])
  })
})
```

- [ ] **Step 2: verifica che fallisca**

Run: `npx vitest run __tests__/api/teacher-alunni-scheda.test.ts 2>&1 | tail -8`
Expected: FAIL, `Failed to resolve import "@/app/api/teacher/alunni/[id]/route"`.

- [ ] **Step 3: implementa** — `src/app/api/teacher/alunni/[id]/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireEnv } from '@/lib/security/require-env'
import { requireDocente } from '@/lib/auth/require-staff'
import { parseData } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore } from '@/lib/logging/logger'
import { selectResiliente } from '@/lib/supabase/select-resiliente'
import { logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { assertAlunnoAnagraficaInScope } from '@/lib/anagrafiche/docente/visibilita'
import { COLONNE_DELEGATI, COLONNE_LEGAMI, COLONNE_SCHEDA } from '@/lib/anagrafiche/docente/colonne'
import {
  proiettaDelegati,
  proiettaGenitori,
  proiettaScheda,
  proiettaSezione,
  type RigaDb,
} from '@/lib/anagrafiche/docente/proiezione'

/**
 * GET /api/teacher/alunni/[id] — la scheda anagrafica di un bambino, in sola lettura.
 *
 * Questo modulo esporta solo `GET`: un'insegnante può guardare, non modificare.
 * Ordine vincolante: ruolo → id valido → controllo di scope (sede e sezione, con le
 * assegnazioni per materia) → lettura → audit. Nessun dato anagrafico si legge prima
 * che il controllo sia passato.
 *
 * L'AUDIT è dovuto: la scheda porta codice fiscale, salute e recapiti di un minore.
 * Si scrive DOPO una lettura riuscita — una riga sopra un 403 racconterebbe un accesso
 * mai avvenuto — ed è lo stesso registro che si mostra a un genitore che chiede chi
 * ha aperto il fascicolo di suo figlio (`app_log` ha trenta giorni, non basta). Se la
 * scrittura fallisce la scheda si mostra comunque e il guasto va in log `error`:
 * negare a un'insegnante le allergie di un bambino per un guasto del registro sarebbe
 * peggio del registro mancante.
 */

const OPERAZIONE = 'teacher/alunni/[id]:GET'
const FINALITA_AUDIT = 'anagrafica-docente'
const SENZA_CACHE = { 'Cache-Control': 'no-store' }

const erroreLettura = () =>
  NextResponse.json(
    { error: 'Scheda dell’alunno non letta', codice: 'ANAGRAFICA_NON_LETTA' },
    { status: 500, headers: SENZA_CACHE },
  )

export const GET = withRoute(
  OPERAZIONE,
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    try {
      const auth = await requireDocente(request)
      if (auth.response) return auth.response
      const user = auth.user

      const { id } = await context.params
      const parsed = parseData(zUuid, id)
      if ('response' in parsed) return parsed.response
      const alunnoId = parsed.data

      const configurazione = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
      if (configurazione) return configurazione
      const supabase = await createAdminClient()

      const scope = await assertAlunnoAnagraficaInScope(supabase, user, alunnoId)
      if (!scope.ok) return scope.response
      const { alunno } = scope

      const [anagrafica, legami, delegati, sezione] = await Promise.all([
        selectResiliente(
          COLONNE_SCHEDA,
          (colonne) =>
            supabase
              .from('alunni')
              .select(colonne.join(', '))
              .eq('id', alunnoId)
              .eq('scuola_id', alunno.scuolaId)
              .maybeSingle(),
          OPERAZIONE,
          { livello: 'warn' },
        ),
        supabase.from('student_parents').select(COLONNE_LEGAMI).eq('student_id', alunnoId),
        supabase
          .from('delegates')
          .select(COLONNE_DELEGATI)
          .eq('student_id', alunnoId)
          .order('created_at', { ascending: true }),
        alunno.sectionId
          ? supabase
              .from('sections')
              .select('id, name, school_type')
              .eq('id', alunno.sectionId)
              .eq('scuola_id', alunno.scuolaId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ])

      const guasto = anagrafica.error ?? legami.error ?? delegati.error ?? sezione.error
      if (guasto) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, guasto)
        return erroreLettura()
      }
      // Fra il controllo e la lettura la riga può essere sparita (archiviazione, oblio).
      if (!anagrafica.data) {
        return NextResponse.json(
          { error: 'Alunno non trovato', codice: 'ANAGRAFICA_NON_TROVATA' },
          { status: 404, headers: SENZA_CACHE },
        )
      }

      const scheda = proiettaScheda(anagrafica.data as unknown as RigaDb, {
        sezione: sezione.data ? proiettaSezione(sezione.data as RigaDb) : null,
        genitori: proiettaGenitori((legami.data ?? []) as unknown as RigaDb[]),
        delegati: proiettaDelegati((delegati.data ?? []) as unknown as RigaDb[]),
      })

      await logAccessoFascicolo(supabase, {
        alunnoId,
        utenteId: user.id,
        azione: 'view',
        finalita: FINALITA_AUDIT,
        request,
      })

      return NextResponse.json(scheda, { headers: SENZA_CACHE })
    } catch (err) {
      logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
      return erroreLettura()
    }
  },
)
```

- [ ] **Step 3b: dichiara il codice d'errore** — il lock `errori-con-codice` pretende che ogni codice che esce da `src/` sia dichiarato e tradotto. In `src/lib/ui/esito-fetch.ts`, dentro `CODICI_ERRORE`, accanto alle voci `ANAGRAFICA_*` del Task 3:

```ts
    /** 500 — la scheda dell'anagrafica docente non si è potuta leggere (`api/teacher/alunni/[id]`). */
    ANAGRAFICA_NON_LETTA: 'erroreAnagraficaNonLetta',
```

e nei due cataloghi condivisi, accanto alle altre voci `erroreAnagrafica…`:

```json
  "erroreAnagraficaNonLetta": "Non è stato possibile caricare la scheda dell’alunno.",
```

(`messages/it/shared.json`) e

```json
  "erroreAnagraficaNonLetta": "The student record could not be loaded.",
```

(`messages/en/shared.json`).

- [ ] **Step 4: verifica che passi, insieme ai lock**

Run: `npx vitest run __tests__/api/teacher-alunni-scheda.test.ts __tests__/api/zod-coverage.test.ts __tests__/architecture/logging-coverage.test.ts __tests__/architecture/gate-coverage.test.ts __tests__/architecture/isolamento-sede-coverage.test.ts __tests__/architecture/supabase-client-strumentato.test.ts 2>&1 | tail -10`
Expected: `Test Files  6 passed (6)`. Un lock rosso si corregge nella route seguendo il suo messaggio, mai nel lock.

- [ ] **Step 5: prova di rottura** — sposta temporaneamente la riga `const scope = await assertAlunnoAnagraficaInScope(…)` (e il suo `if`) **dopo** il `Promise.all`: il test «403 … SENZA leggerne l'anagrafica» deve diventare rosso. Ripristina.

- [ ] **Step 6: commit**

```bash
git add "src/app/api/teacher/alunni/[id]/route.ts" __tests__/api/teacher-alunni-scheda.test.ts src/lib/ui/esito-fetch.ts messages/it/shared.json messages/en/shared.json
git commit -m "Anagrafica docente: GET /api/teacher/alunni/[id] con audit degli accessi

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: testi, menu, tinta, pagina offline

**Files:**
- Modify: `messages/it/teacherServizi.json`, `messages/en/teacherServizi.json`
- Modify: `messages/it/teacherNav.json`, `messages/en/teacherNav.json`
- Modify: `messages/it/offline.json`, `messages/en/offline.json`
- Modify: `src/lib/ui/tinte-funzioni.ts` (`TINTA_FUNZIONE`)
- Modify: `src/components/features/teacher/TeacherBottomNav.tsx` (import icone + gruppo «In classe»)
- Test: `__tests__/ui/teacher-nav-profilo-raggiungibile.test.tsx` (aggiungi un `describe`)

- [ ] **Step 1: scrivi il test che fallisce** — in fondo a `__tests__/ui/teacher-nav-profilo-raggiungibile.test.tsx`:

```tsx
describe('TeacherBottomNav — «Alunni» porta all’anagrafica', () => {
  it('è un LINK verso /teacher/alunni, nel gruppo «In classe»', () => {
    apriIlMenu();
    const voce = screen.getByRole('link', { name: new RegExp(NAV.voceAlunniLabel, 'i') });
    expect(voce.getAttribute('href')).toBe('/teacher/alunni');
    expect(voce.textContent).toContain(NAV.voceAlunniSub);
  });
});
```

- [ ] **Step 2: verifica che fallisca**

Run: `npx vitest run __tests__/ui/teacher-nav-profilo-raggiungibile.test.tsx 2>&1 | tail -8`
Expected: FAIL (la chiave `voceAlunniLabel` non esiste: `new RegExp(undefined)` non trova il link).

- [ ] **Step 3: testi del menu** — in `messages/it/teacherNav.json`, subito dopo `"vocePresenzeSub": …,`:

```json
  "voceAlunniLabel": "Alunni",
  "voceAlunniSub": "Anagrafica dei tuoi bambini",
```

in `messages/en/teacherNav.json`, nella stessa posizione:

```json
  "voceAlunniLabel": "Students",
  "voceAlunniSub": "Your children’s records",
```

- [ ] **Step 4: testi della funzione** — in `messages/it/teacherServizi.json`, prima della `}` finale (dopo l'ultima chiave esistente, aggiungendo la virgola):

```json
  "anagraficaEyebrow": "In classe",
  "anagraficaTitolo": "Alunni",
  "anagraficaSottotitolo": "L’anagrafica dei tuoi bambini, in sola lettura",
  "anagraficaFiltroCerca": "Cerca un bambino",
  "anagraficaFiltroCercaSegnaposto": "Nome o cognome",
  "anagraficaFiltroSezione": "Sezione o classe",
  "anagraficaFiltroGrado": "Grado",
  "anagraficaGradoNido": "Nido",
  "anagraficaGradoInfanzia": "Infanzia",
  "anagraficaGradoPrimaria": "Primaria",
  "anagraficaFiltroConAllergie": "Solo con allergie",
  "anagraficaFiltroAllergene": "Allergene",
  "anagraficaFiltroBes": "BES/DSA",
  "anagraficaFiltroPannolino": "Usa il pannolino",
  "anagraficaFiltroSenzaFotoSito": "Senza consenso foto sul sito",
  "anagraficaFiltroSenzaFotoSocial": "Senza consenso foto sui social",
  "anagraficaFiltroAnno": "Anno di nascita",
  "anagraficaFiltroSesso": "Sesso",
  "anagraficaSessoM": "Maschio",
  "anagraficaSessoF": "Femmina",
  "anagraficaVuotoTitolo": "Nessun bambino da mostrare",
  "anagraficaVuotoCorpo": "Se ti aspettavi di vedere la tua classe, chiedi alla segreteria di assegnartela.",
  "anagraficaSenzaSezione": "Senza sezione",
  "anagraficaConteggioSezione": "{n, plural, one {# bambino} other {# bambini}}",
  "anagraficaBadgeAllergie": "Allergie",
  "anagraficaSchedaTitolo": "Scheda alunno",
  "anagraficaSolaLettura": "Sola lettura",
  "anagraficaIndietro": "Tutti gli alunni",
  "anagraficaCaricamento": "Caricamento della scheda…",
  "anagraficaAvvisoAllergie": "Allergie e intolleranze",
  "anagraficaRiquadroDati": "Dati anagrafici",
  "anagraficaRiquadroResidenza": "Residenza",
  "anagraficaRiquadroClasse": "Classe",
  "anagraficaRiquadroSalute": "Salute",
  "anagraficaRiquadroConsensi": "Consensi",
  "anagraficaRiquadroFamiglia": "Famiglia",
  "anagraficaRiquadroDelegati": "Delegati al ritiro",
  "anagraficaCampoSesso": "Sesso",
  "anagraficaCampoDataNascita": "Data di nascita",
  "anagraficaCampoLuogoNascita": "Luogo di nascita",
  "anagraficaCampoCittadinanza": "Cittadinanza",
  "anagraficaCampoCodiceFiscale": "Codice fiscale",
  "anagraficaCampoIndirizzo": "Indirizzo",
  "anagraficaCampoCap": "CAP",
  "anagraficaCampoComune": "Comune",
  "anagraficaCampoSezione": "Sezione o classe",
  "anagraficaCampoGrado": "Grado",
  "anagraficaCampoDataIscrizione": "Data di iscrizione",
  "anagraficaCampoAllergie": "Allergie",
  "anagraficaCampoNoteMediche": "Note mediche",
  "anagraficaCampoBes": "BES/DSA",
  "anagraficaCampoPannolino": "Pannolino",
  "anagraficaCampoConsensoPrivacy": "Privacy",
  "anagraficaCampoConsensoFotoSito": "Foto sul sito",
  "anagraficaCampoConsensoFotoSocial": "Foto sui social",
  "anagraficaCampoTelefono": "Telefono",
  "anagraficaCampoEmail": "Email",
  "anagraficaCampoParentela": "Parentela",
  "anagraficaParentelaMadre": "Madre",
  "anagraficaParentelaPadre": "Padre",
  "anagraficaParentelaAltro": "Altro adulto di riferimento",
  "anagraficaParentelaDelegato": "Delegato al ritiro",
  "anagraficaPrincipale": "Referente principale",
  "anagraficaSi": "Sì",
  "anagraficaNo": "No",
  "anagraficaNonIndicato": "Non indicato",
  "anagraficaNessunaAllergia": "Nessuna allergia segnalata",
  "anagraficaNessunGenitore": "Nessun genitore collegato",
  "anagraficaNessunDelegato": "Nessun delegato al ritiro",
  "anagraficaCorrezione": "Un dato è sbagliato? Rivolgiti alla segreteria.",
  "anagraficaErroreNegato": "Questo bambino non è in una delle tue classi.",
  "anagraficaErroreNonTrovata": "Scheda non trovata.",
  "anagraficaErroreLettura": "Non è stato possibile caricare la scheda.",
  "anagraficaErroreOffline": "Serve la connessione per aprire la scheda.",
  "anagraficaRiprova": "Riprova"
```

e in `messages/en/teacherServizi.json`, stesse chiavi e stessa posizione:

```json
  "anagraficaEyebrow": "In class",
  "anagraficaTitolo": "Students",
  "anagraficaSottotitolo": "Your children’s records, read-only",
  "anagraficaFiltroCerca": "Search for a child",
  "anagraficaFiltroCercaSegnaposto": "First or last name",
  "anagraficaFiltroSezione": "Section or class",
  "anagraficaFiltroGrado": "School level",
  "anagraficaGradoNido": "Nursery",
  "anagraficaGradoInfanzia": "Preschool",
  "anagraficaGradoPrimaria": "Primary",
  "anagraficaFiltroConAllergie": "Only with allergies",
  "anagraficaFiltroAllergene": "Allergen",
  "anagraficaFiltroBes": "BES/DSA",
  "anagraficaFiltroPannolino": "Uses diapers",
  "anagraficaFiltroSenzaFotoSito": "No consent for website photos",
  "anagraficaFiltroSenzaFotoSocial": "No consent for social media photos",
  "anagraficaFiltroAnno": "Year of birth",
  "anagraficaFiltroSesso": "Gender",
  "anagraficaSessoM": "Male",
  "anagraficaSessoF": "Female",
  "anagraficaVuotoTitolo": "No children to show",
  "anagraficaVuotoCorpo": "If you expected to see your class, ask the school office to assign it to you.",
  "anagraficaSenzaSezione": "No section",
  "anagraficaConteggioSezione": "{n, plural, one {# child} other {# children}}",
  "anagraficaBadgeAllergie": "Allergies",
  "anagraficaSchedaTitolo": "Student record",
  "anagraficaSolaLettura": "Read-only",
  "anagraficaIndietro": "All students",
  "anagraficaCaricamento": "Loading the record…",
  "anagraficaAvvisoAllergie": "Allergies and intolerances",
  "anagraficaRiquadroDati": "Personal details",
  "anagraficaRiquadroResidenza": "Residence",
  "anagraficaRiquadroClasse": "Class",
  "anagraficaRiquadroSalute": "Health",
  "anagraficaRiquadroConsensi": "Consents",
  "anagraficaRiquadroFamiglia": "Family",
  "anagraficaRiquadroDelegati": "Authorised for pick-up",
  "anagraficaCampoSesso": "Gender",
  "anagraficaCampoDataNascita": "Date of birth",
  "anagraficaCampoLuogoNascita": "Place of birth",
  "anagraficaCampoCittadinanza": "Citizenship",
  "anagraficaCampoCodiceFiscale": "Tax code",
  "anagraficaCampoIndirizzo": "Address",
  "anagraficaCampoCap": "Postal Code",
  "anagraficaCampoComune": "Town",
  "anagraficaCampoSezione": "Section or class",
  "anagraficaCampoGrado": "School level",
  "anagraficaCampoDataIscrizione": "Enrollment date",
  "anagraficaCampoAllergie": "Allergies",
  "anagraficaCampoNoteMediche": "Medical notes",
  "anagraficaCampoBes": "BES/DSA",
  "anagraficaCampoPannolino": "Diapers",
  "anagraficaCampoConsensoPrivacy": "Privacy",
  "anagraficaCampoConsensoFotoSito": "Photos on the website",
  "anagraficaCampoConsensoFotoSocial": "Photos on social media",
  "anagraficaCampoTelefono": "Phone",
  "anagraficaCampoEmail": "Email",
  "anagraficaCampoParentela": "Relationship",
  "anagraficaParentelaMadre": "Mother",
  "anagraficaParentelaPadre": "Father",
  "anagraficaParentelaAltro": "Other responsible adult",
  "anagraficaParentelaDelegato": "Authorised for pick-up",
  "anagraficaPrincipale": "Main contact",
  "anagraficaSi": "Yes",
  "anagraficaNo": "No",
  "anagraficaNonIndicato": "Not provided",
  "anagraficaNessunaAllergia": "No allergies reported",
  "anagraficaNessunGenitore": "No parent linked",
  "anagraficaNessunDelegato": "No one authorised for pick-up",
  "anagraficaCorrezione": "Is something wrong? Contact the school office.",
  "anagraficaErroreNegato": "This child is not in one of your classes.",
  "anagraficaErroreNonTrovata": "Record not found.",
  "anagraficaErroreLettura": "The record could not be loaded.",
  "anagraficaErroreOffline": "You need a connection to open the record.",
  "anagraficaRiprova": "Try again"
```

> Le chiavi ancora non usate nel codice faranno diventare rosso `messaggi-chiavi-orfane` fino al Task 8-9: è atteso. Il gate intero si lancia al Task 11.

- [ ] **Step 5: etichetta offline** — in `messages/it/offline.json`, in `etichette.segmenti`, in ordine alfabetico prima di `"appello"`: `"alunni": "Alunni",`; in `messages/en/offline.json`: `"alunni": "Students",`.

- [ ] **Step 6: tinta** — in `src/lib/ui/tinte-funzioni.ts`, in `TINTA_FUNZIONE` dopo `attivita: …,`:

```ts
  alunni: TINTE_SORGENTE['kv-subj-geografia'],
```

- [ ] **Step 7: la voce di menu** — in `src/components/features/teacher/TeacherBottomNav.tsx` aggiungi `Contact` all'import di `lucide-react`, e nel gruppo `gruppoInClasse`, dopo la voce `presenze`:

```tsx
        // L'anagrafica dei propri bambini, in SOLA LETTURA: la route esporta solo GET,
        // e il perimetro (sezioni assegnate, anche per materia) lo decide il server.
        { id: 'alunni', label: t('voceAlunniLabel'), sub: t('voceAlunniSub'), icon: Contact, href: '/teacher/alunni', tint: tintaFunzione('alunni'), grado: 'comune' },
```

- [ ] **Step 8: verifica**

Run: `npx vitest run __tests__/ui/teacher-nav-profilo-raggiungibile.test.tsx __tests__/architecture/tinte-funzioni-uniche.test.ts __tests__/architecture/offline-etichette-rotte.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts 2>&1 | tail -10`
Expected: `Test Files  4 passed (4)`. Se `offline-etichette-rotte` è rosso perché la pagina non esiste ancora, rilancialo al Task 9.

- [ ] **Step 9: commit**

```bash
git add messages src/lib/ui/tinte-funzioni.ts src/components/features/teacher/TeacherBottomNav.tsx __tests__/ui/teacher-nav-profilo-raggiungibile.test.tsx
git commit -m "Anagrafica docente: testi, voce «Alunni» nel menu, tinta ed etichetta offline

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: i campi della barra filtri e il ritorno all'elenco

**Files:**
- Create: `src/components/features/teacher/anagrafica/filtri-alunni.ts`
- Create: `src/lib/anagrafiche/docente/ritorno-elenco.ts`
- Test: `__tests__/lib/filtri-alunni-docente.test.ts`
- Test: `__tests__/lib/ritorno-elenco-alunni.test.ts`

- [ ] **Step 1: scrivi i test che falliscono** — `__tests__/lib/filtri-alunni-docente.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'use-intl'
import { filtraRighe, valoriIniziali, versoUrl } from '@/lib/ui/filtri/motore'
import type { ValoriFiltri } from '@/lib/ui/filtri/tipi'
import { campiAlunni } from '@/components/features/teacher/anagrafica/filtri-alunni'
import type { SezioneElenco, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'

// Il motore è quello vero: qui si prova che i CAMPI dicono la cosa giusta.
// Il traduttore usa il catalogo vero e LANCIA su una chiave mancante.
const CATALOGO = JSON.parse(readFileSync(join(process.cwd(), 'messages/it/teacherServizi.json'), 'utf8'))
const t = createTranslator({
  locale: 'it',
  messages: { teacherServizi: CATALOGO } as never,
  namespace: 'teacherServizi' as never,
  onError: (errore) => {
    throw errore
  },
}) as unknown as (chiave: string, valori?: Record<string, string | number>) => string

const voce = (v: Partial<VoceElencoAlunno> & { id: string }): VoceElencoAlunno => ({
  nome: 'N', cognome: 'C', sectionId: 'S1', grado: 'infanzia', dataNascita: '2021-01-01', annoNascita: 2021,
  sesso: 'F', allergeni: [], haAllergie: false, besDsa: false, usaPannolino: false,
  consensoFotoSito: true, consensoFotoSocial: true, ...v,
})

const SEZIONI: SezioneElenco[] = [
  { id: 'S1', nome: 'Girasoli', grado: 'infanzia' },
  { id: 'S2', nome: '3A', grado: 'primaria' },
]
const ALUNNI = [
  voce({ id: 'a', nome: 'Niccolò', cognome: 'D’Amico', allergeni: ['latte'], haAllergie: true }),
  voce({ id: 'b', nome: 'Bruno', cognome: 'Rossi', sectionId: 'S2', grado: 'primaria', annoNascita: 2018, dataNascita: '2018-05-05', sesso: 'M', besDsa: true, consensoFotoSocial: false }),
  voce({ id: 'c', nome: 'Carla', cognome: 'Verdi', usaPannolino: true, consensoFotoSito: null, consensoFotoSocial: null, allergeni: ['uova'], haAllergie: true }),
]

const campi = campiAlunni(t, { sezioni: SEZIONI, alunni: ALUNNI, etichettaAllergene: (k) => `allergene:${k}` })
const filtra = (valori: ValoriFiltri) =>
  filtraRighe(campi, { ...valoriIniziali(campi, null), ...valori }, ALUNNI).map((r) => r.id)

describe('campiAlunni — ricerca per nome', () => {
  it('nessun filtro ⇒ tutti', () => expect(filtra({})).toEqual(['a', 'b', 'c']))
  it('senza accenti, apostrofi o maiuscole', () => {
    expect(filtra({ q: 'NICCOLO' })).toEqual(['a'])
    expect(filtra({ q: "d'amico niccolò" })).toEqual(['a'])
  })
  it('nome e cognome insieme, nei due ordini', () => {
    expect(filtra({ q: 'bruno rossi' })).toEqual(['b'])
    expect(filtra({ q: 'rossi bruno' })).toEqual(['b'])
  })
  it('la ricerca NON finisce nell’indirizzo, gli altri filtri sì', () => {
    const url = versoUrl(campi, { ...valoriIniziali(campi, null), q: 'rossi', bes: true })
    expect(url.get('q')).toBeNull()
    expect(url.get('bes')).toBe('1')
  })
})

describe('campiAlunni — ogni filtro', () => {
  it('sezione e grado (OR dentro il campo)', () => {
    expect(filtra({ sezione: ['S2'] })).toEqual(['b'])
    expect(filtra({ sezione: ['S1', 'S2'] })).toEqual(['a', 'b', 'c'])
    expect(filtra({ grado: ['primaria'] })).toEqual(['b'])
  })
  it('salute', () => {
    expect(filtra({ allergie: true })).toEqual(['a', 'c'])
    expect(filtra({ allergene: ['uova'] })).toEqual(['c'])
    expect(filtra({ allergene: ['latte', 'uova'] })).toEqual(['a', 'c'])
    expect(filtra({ bes: true })).toEqual(['b'])
    expect(filtra({ pannolino: true })).toEqual(['c'])
  })
  it('consensi foto: un consenso ASSENTE conta come «senza consenso»', () => {
    expect(filtra({ senzaFotoSito: true })).toEqual(['c'])
    expect(filtra({ senzaFotoSocial: true })).toEqual(['b', 'c'])
  })
  it('età e sesso', () => {
    expect(filtra({ anno: ['2018'] })).toEqual(['b'])
    expect(filtra({ sesso: ['M'] })).toEqual(['b'])
  })
  it('AND fra campi diversi', () => {
    expect(filtra({ sezione: ['S1'], allergene: ['uova'] })).toEqual(['c'])
    expect(filtra({ allergie: true, sesso: ['M'] })).toEqual([])
  })
})

describe('campiAlunni — le opzioni', () => {
  it('nascono dai dati, con le etichette del catalogo e dell’allergene', () => {
    const grado = campi.find((c) => c.chiave === 'grado')
    expect(grado && 'opzioni' in grado ? grado.opzioni.map((o) => o.etichetta) : []).toEqual(['Infanzia', 'Primaria'])
    const allergene = campi.find((c) => c.chiave === 'allergene')
    expect(allergene && 'opzioni' in allergene ? allergene.opzioni.map((o) => o.etichetta) : []).toEqual(['allergene:latte', 'allergene:uova'])
  })
  it('con una sezione sola (e un grado solo) quei due filtri non si offrono', () => {
    const una = campiAlunni(t, { sezioni: SEZIONI, alunni: [ALUNNI[0], ALUNNI[2]], etichettaAllergene: (k) => k })
    for (const chiave of ['sezione', 'grado']) {
      const campo = una.find((c) => c.chiave === chiave)
      expect(campo && 'opzioni' in campo ? campo.opzioni : null).toEqual([])
    }
  })
})
```

e `__tests__/lib/ritorno-elenco-alunni.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

import { leggiRitornoElenco, ripulisciRitorno, salvaRitornoElenco } from '@/lib/anagrafiche/docente/ritorno-elenco'

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
})
afterEach(() => vi.restoreAllMocks())

describe('ripulisciRitorno', () => {
  it('toglie la ricerca per nome e tiene gli altri filtri', () => {
    expect(ripulisciRitorno('?sezione=S1&q=rossi&bes=1')).toBe('?sezione=S1&bes=1')
  })
  it('vuoto, solo `q`, troppo lungo o non stringa ⇒ nessun ritorno', () => {
    expect(ripulisciRitorno('')).toBe('')
    expect(ripulisciRitorno('?q=rossi')).toBe('')
    expect(ripulisciRitorno(`?sezione=${'x'.repeat(700)}`)).toBe('')
    expect(ripulisciRitorno(undefined as unknown as string)).toBe('')
  })
})

describe('salva / leggi', () => {
  it('andata e ritorno, già ripulita', () => {
    salvaRitornoElenco('?anno=2021&q=rossi')
    expect(leggiRitornoElenco()).toBe('?anno=2021')
  })
  it('un valore scritto a mano con un nome dentro esce ripulito anche in lettura', () => {
    window.sessionStorage.setItem('kv-teacher-alunni-ritorno', '?q=rossi')
    expect(leggiRitornoElenco()).toBe('')
  })
  it('sessionStorage che lancia: nessun ritorno, un solo warn per sessione', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloccato')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloccato')
    })
    salvaRitornoElenco('?anno=2021')
    expect(leggiRitornoElenco()).toBe('')
    expect(leggiRitornoElenco()).toBe('')
    expect(h.logClient).toHaveBeenCalledTimes(1)
    expect(h.logClient.mock.calls[0][0]).toMatchObject({ livello: 'warn' })
  })
})
```

- [ ] **Step 2: verifica che falliscano**

Run: `npx vitest run __tests__/lib/filtri-alunni-docente.test.ts __tests__/lib/ritorno-elenco-alunni.test.ts 2>&1 | tail -8`
Expected: FAIL, import non risolti.

- [ ] **Step 3: implementa i campi** — `src/components/features/teacher/anagrafica/filtri-alunni.ts`:

```ts
import { opzioniDerivate } from '@/lib/ui/filtri/motore'
import type { CampoFiltro, Traduttore } from '@/lib/ui/filtri/tipi'
import type { Grado, SezioneElenco, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'

/**
 * I FILTRI DELL'ANAGRAFICA DOCENTE — tutti `dove: 'client'`: l'elenco di una
 * insegnante sono poche decine di righe già in memoria, e anche quello della
 * segreteria resta sotto il migliaio.
 *
 * Le opzioni nascono dai DATI (`opzioniDerivate`), quindi chi monta questi campi lo
 * fa DOPO aver caricato l'elenco: `useFiltri` legge l'indirizzo una volta sola e
 * scarta un valore che non è fra le opzioni.
 *
 * La ricerca per nome è `maiNellUrl`: un nome di bambino non va nell'indirizzo.
 * Sezione e grado si offrono solo se c'è davvero una scelta (più di una voce).
 * Un consenso foto ASSENTE conta come «senza consenso»: per chi sta per pubblicare
 * una foto, è la direzione prudente.
 */

export interface ContestoFiltriAlunni {
  sezioni: readonly SezioneElenco[]
  alunni: readonly VoceElencoAlunno[]
  /** L'etichetta di un allergene nella lingua della pagina (`useAllergeneLabel`). */
  etichettaAllergene: (chiave: string) => string
}

export function campiAlunni(t: Traduttore, contesto: ContestoFiltriAlunni): CampoFiltro<VoceElencoAlunno>[] {
  const { alunni } = contesto
  const nomeSezione = new Map(contesto.sezioni.map((s) => [s.id, s.nome]))
  const etichettaGrado: Record<Grado, string> = {
    nido: t('anagraficaGradoNido'),
    infanzia: t('anagraficaGradoInfanzia'),
    primaria: t('anagraficaGradoPrimaria'),
  }
  const etichettaSesso: Record<'M' | 'F', string> = { M: t('anagraficaSessoM'), F: t('anagraficaSessoF') }

  const sezioni = opzioniDerivate(alunni, (a) => a.sectionId, { etichettaDi: (id) => nomeSezione.get(id) ?? id })
  const gradi = opzioniDerivate(alunni, (a) => a.grado, { etichettaDi: (g) => etichettaGrado[g as Grado] ?? g })
  const soloSeScelta = <T,>(opzioni: T[]): T[] => (opzioni.length > 1 ? opzioni : [])

  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('anagraficaFiltroCerca'),
      segnaposto: t('anagraficaFiltroCercaSegnaposto'),
      dove: 'client',
      primario: true,
      maiNellUrl: true,
      testiDi: (a) => [a.nome, a.cognome, `${a.nome} ${a.cognome}`, `${a.cognome} ${a.nome}`],
    },
    {
      tipo: 'multi',
      chiave: 'sezione',
      etichetta: t('anagraficaFiltroSezione'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: soloSeScelta(sezioni),
      valoriDi: (a) => [a.sectionId],
    },
    {
      tipo: 'multi',
      chiave: 'grado',
      etichetta: t('anagraficaFiltroGrado'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: soloSeScelta(gradi),
      valoriDi: (a) => [a.grado],
    },
    {
      tipo: 'interruttore',
      chiave: 'allergie',
      etichetta: t('anagraficaFiltroConAllergie'),
      dove: 'client',
      predicato: (a) => a.haAllergie,
    },
    {
      tipo: 'multi',
      chiave: 'allergene',
      etichetta: t('anagraficaFiltroAllergene'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: opzioniDerivate(alunni, (a) => a.allergeni, { etichettaDi: contesto.etichettaAllergene }),
      valoriDi: (a) => a.allergeni,
    },
    { tipo: 'interruttore', chiave: 'bes', etichetta: t('anagraficaFiltroBes'), dove: 'client', predicato: (a) => a.besDsa },
    {
      tipo: 'interruttore',
      chiave: 'pannolino',
      etichetta: t('anagraficaFiltroPannolino'),
      dove: 'client',
      predicato: (a) => a.usaPannolino,
    },
    {
      tipo: 'interruttore',
      chiave: 'senzaFotoSito',
      etichetta: t('anagraficaFiltroSenzaFotoSito'),
      dove: 'client',
      predicato: (a) => a.consensoFotoSito !== true,
    },
    {
      tipo: 'interruttore',
      chiave: 'senzaFotoSocial',
      etichetta: t('anagraficaFiltroSenzaFotoSocial'),
      dove: 'client',
      predicato: (a) => a.consensoFotoSocial !== true,
    },
    {
      tipo: 'multi',
      chiave: 'anno',
      etichetta: t('anagraficaFiltroAnno'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: opzioniDerivate(alunni, (a) => (a.annoNascita === null ? null : String(a.annoNascita))),
      valoriDi: (a) => (a.annoNascita === null ? [] : [String(a.annoNascita)]),
    },
    {
      tipo: 'multi',
      chiave: 'sesso',
      etichetta: t('anagraficaFiltroSesso'),
      dove: 'client',
      nascondiSeVuoto: true,
      opzioni: opzioniDerivate(alunni, (a) => a.sesso, { etichettaDi: (s) => etichettaSesso[s as 'M' | 'F'] ?? s }),
      valoriDi: (a) => [a.sesso],
    },
  ]
}
```

- [ ] **Step 4: implementa il ritorno** — `src/lib/anagrafiche/docente/ritorno-elenco.ts`:

```ts
import { logClient, nomeErrore } from '@/lib/logging/client'

/**
 * LA QUERY DELL'ELENCO, DA RITROVARE TORNANDO DALLA SCHEDA.
 *
 * Il tasto «indietro» del telefono o del browser i filtri li ritrova da solo
 * (`useFiltri` li tiene nell'indirizzo). Il pulsante «Tutti gli alunni» della scheda
 * invece naviga in avanti: senza un appunto, riaprirebbe l'elenco senza filtri.
 *
 * L'appunto sta in `sessionStorage` (la sola scheda del browser, si perde chiudendola)
 * e non contiene MAI la ricerca per nome: `q` si toglie sia salvando sia leggendo.
 * Uno storage che non risponde (navigazione privata, permessi) non rompe niente: si
 * torna all'elenco senza filtri, con un solo `warn` per sessione.
 */

const CHIAVE = 'kv-teacher-alunni-ritorno'
const LUNGHEZZA_MASSIMA = 600

let storageGiaSegnalato = false

function segnalaStorage(operazione: 'lettura' | 'scrittura', e: unknown): void {
  if (storageGiaSegnalato) return
  storageGiaSegnalato = true
  logClient({
    livello: 'warn',
    evento: 'js',
    messaggio: `anagrafica-ritorno-storage-inutilizzabile: ${operazione} (${nomeErrore(e)})`,
    route: '/teacher/alunni',
  })
}

/** Una query d'elenco ripulita: niente ricerca per nome, niente di malformato. */
export function ripulisciRitorno(search: string): string {
  if (typeof search !== 'string' || search.length > LUNGHEZZA_MASSIMA) return ''
  const parametri = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  parametri.delete('q')
  const pulita = parametri.toString()
  return pulita === '' ? '' : `?${pulita}`
}

export function salvaRitornoElenco(search: string): void {
  try {
    window.sessionStorage.setItem(CHIAVE, ripulisciRitorno(search))
  } catch (e) {
    segnalaStorage('scrittura', e)
  }
}

export function leggiRitornoElenco(): string {
  try {
    return ripulisciRitorno(window.sessionStorage.getItem(CHIAVE) ?? '')
  } catch (e) {
    segnalaStorage('lettura', e)
    return ''
  }
}
```

> Il test «un solo warn per sessione» dipende dallo stato del modulo: se nello stesso file un caso precedente avesse già segnalato, il conteggio sarebbe 0. L'ordine dei casi nel test è quello scritto (lo storage che lancia è l'ultimo).

- [ ] **Step 5: verifica**

Run: `npx vitest run __tests__/lib/filtri-alunni-docente.test.ts __tests__/lib/ritorno-elenco-alunni.test.ts 2>&1 | tail -8`
Expected: `Test Files  2 passed (2)`. Prova di rottura: togli `maiNellUrl: true` dal campo `q` → il test «la ricerca NON finisce nell'indirizzo» diventa rosso. Ripristina.

- [ ] **Step 6: commit**

```bash
git add src/components/features/teacher/anagrafica/filtri-alunni.ts src/lib/anagrafiche/docente/ritorno-elenco.ts __tests__/lib/filtri-alunni-docente.test.ts __tests__/lib/ritorno-elenco-alunni.test.ts
git commit -m "Anagrafica docente: campi della barra filtri e ritorno all'elenco

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: la scheda in sola lettura

**Files:**
- Create: `src/components/features/teacher/anagrafica/CampoLettura.tsx`
- Create: `src/components/features/teacher/anagrafica/RiquadroScheda.tsx`
- Create: `src/components/features/teacher/anagrafica/SchedaGenitore.tsx`
- Create: `src/components/features/teacher/anagrafica/SchedaAlunnoLettura.tsx`
- Create: `src/app/(dashboard)/teacher/alunni/[id]/page.tsx`
- Test: `__tests__/components/SchedaAlunnoLettura.test.tsx`

- [ ] **Step 1: scrivi il test che fallisce** — `__tests__/components/SchedaAlunnoLettura.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import servizi from '../../messages/it/teacherServizi.json'
import etichette from '../../messages/it/etichette.json'
import type { SchedaAlunnoDocente } from '@/lib/anagrafiche/docente/tipi'

const T = servizi as Record<string, string>
const E = etichette as Record<string, string>

const h = vi.hoisted(() => ({ push: vi.fn(), logClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }) }))
vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  }
})
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

import { SchedaAlunnoLettura } from '@/components/features/teacher/anagrafica/SchedaAlunnoLettura'

const ID = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'

const SCHEDA: SchedaAlunnoDocente = {
  id: ID,
  nome: 'Aurora',
  cognome: 'Arcobaleno-E2E',
  sesso: 'F',
  dataNascita: '2022-04-10',
  luogoNascita: { comune: 'Testville', provincia: 'TV', nazione: 'Italia' },
  cittadinanza: 'Italiana',
  codiceFiscale: 'TSTRCB22D50Z999Q',
  residenza: { indirizzo: null, civico: null, cap: null, comune: null, provincia: null },
  sezione: { id: 's', nome: 'Girasoli', grado: 'infanzia' },
  dataIscrizione: '2025-09-01',
  salute: { allergeni: ['latte'], allergieAltro: 'fragole', haAllergie: true, noteMediche: 'Riga uno\nRiga due', besDsa: false, usaPannolino: true },
  consensi: { privacy: true, fotoSito: false, fotoSocial: null },
  genitori: [
    { nome: 'Mamma', cognome: 'Arcobaleno-E2E', parentela: 'madre', principale: true, telefoni: ['333 000 0000'], email: ['mamma@example.test'], codiceFiscale: 'TSTMMM80A41Z999Q' },
  ],
  delegati: [{ nome: 'Nonna', cognome: 'Arcobaleno-E2E', parentela: 'Nonna' }],
}

const risposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SchedaAlunnoLettura — pronta', () => {
  beforeEach(() => fetchMock.mockResolvedValue(risposta(200, SCHEDA)))

  it('mostra anagrafica, salute, famiglia e delegati', async () => {
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(`/api/teacher/alunni/${ID}`, expect.objectContaining({ cache: 'no-store' }))
    expect(screen.getByText(T.anagraficaSolaLettura)).toBeTruthy()
    expect(screen.getByText('TSTRCB22D50Z999Q')).toBeTruthy()
    expect(screen.getByText('10/04/2022')).toBeTruthy()
    expect(screen.getByText('Testville (TV), Italia')).toBeTruthy()
    const avviso = screen.getByRole('note', { name: T.anagraficaAvvisoAllergie })
    expect(avviso.textContent).toContain(E.allergene_latte)
    expect(avviso.textContent).toContain('fragole')
    expect(screen.getByText(/Riga uno/).textContent).toBe('Riga uno\nRiga due')
    expect(screen.getByText('Nonna', { selector: 'p, span, dd' })).toBeTruthy()
  })

  it('telefono ed email sono toccabili', async () => {
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    const tel = await screen.findByRole('link', { name: /333 000 0000/ })
    expect(tel.getAttribute('href')).toBe('tel:3330000000')
    expect(screen.getByRole('link', { name: /mamma@example\.test/ }).getAttribute('href')).toBe('mailto:mamma@example.test')
  })

  it('i campi assenti dicono «Non indicato», i consensi Sì/No/Non indicato', async () => {
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    await screen.findByRole('heading', { level: 1 })
    expect(screen.getAllByText(T.anagraficaNonIndicato).length).toBeGreaterThanOrEqual(4)
  })

  it('SOLA LETTURA: nessun campo modificabile, nessun salvataggio', async () => {
    const { container } = render(<SchedaAlunnoLettura alunnoId={ID} />)
    await screen.findByRole('heading', { level: 1 })
    expect(container.querySelectorAll('input, textarea, select, [contenteditable="true"]')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /salva|modifica|elimina/i })).toBeNull()
  })

  it('«Tutti gli alunni» torna all’elenco con i filtri di prima', async () => {
    window.sessionStorage.setItem('kv-teacher-alunni-ritorno', '?sezione=S1')
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    await screen.findByRole('heading', { level: 1 })
    fireEvent.click(screen.getByRole('link', { name: T.anagraficaIndietro }))
    expect(h.push).toHaveBeenCalledWith('/teacher/alunni?sezione=S1')
  })
})

describe('SchedaAlunnoLettura — non si apre', () => {
  it('403 ⇒ «non è in una delle tue classi»', async () => {
    fetchMock.mockResolvedValue(risposta(403, { codice: 'ANAGRAFICA_FUORI_SEZIONE' }))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreNegato)).toBeTruthy()
  })

  it('404 ⇒ «Scheda non trovata»', async () => {
    fetchMock.mockResolvedValue(risposta(404, {}))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreNonTrovata)).toBeTruthy()
  })

  it('un id che non è un uuid non parte nemmeno', async () => {
    render(<SchedaAlunnoLettura alunnoId="" />)
    expect(await screen.findByText(T.anagraficaErroreNonTrovata)).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('500 ⇒ errore con «Riprova», che ricarica davvero', async () => {
    fetchMock.mockResolvedValueOnce(risposta(500, {})).mockResolvedValueOnce(risposta(200, SCHEDA))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    fireEvent.click(await screen.findByRole('button', { name: T.anagraficaRiprova }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'warn', stato: 500 }))
  })

  it('senza rete ⇒ «Serve la connessione»', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreOffline)).toBeTruthy()
    onLine.mockRestore()
  })

  it('rete giù ma «online» ⇒ errore, con un log `error`', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<SchedaAlunnoLettura alunnoId={ID} />)
    expect(await screen.findByText(T.anagraficaErroreLettura)).toBeTruthy()
    await waitFor(() => expect(h.logClient).toHaveBeenCalledWith(expect.objectContaining({ livello: 'error' })))
  })
})
```

> `messages/it/etichette.json` contiene `allergene_latte: "Latte / lattosio"` (verificato): è ciò che `useAllergeneLabel` mostra. `isoToIt('2022-04-10')` restituisce `10/04/2022`.

- [ ] **Step 2: verifica che fallisca**

Run: `npx vitest run __tests__/components/SchedaAlunnoLettura.test.tsx 2>&1 | tail -8`
Expected: FAIL, import non risolto.

- [ ] **Step 3: `CampoLettura.tsx`**

```tsx
import type { ReactNode } from 'react'
import { cx } from '@/lib/ui/cx'

interface CampoLetturaProps {
  etichetta: string
  /** `null`, `undefined` o stringa vuota ⇒ si mostra `nonIndicato`, mai una riga che sparisce. */
  valore: ReactNode
  nonIndicato: string
  /** Testo su più righe (note mediche): conserva gli a capo. */
  aCapo?: boolean
}

/** Una riga «etichetta: valore» dentro un `<dl>`. Non c'è niente da modificare. */
export function CampoLettura({ etichetta, valore, nonIndicato, aCapo }: CampoLetturaProps) {
  const vuoto = valore === null || valore === undefined || valore === ''
  return (
    <div className="py-2.5 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4">
      <dt className="font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-sub">{etichetta}</dt>
      <dd
        className={cx(
          'mt-0.5 font-maven text-sm sm:mt-0',
          vuoto ? 'italic text-kidville-sub' : 'text-kidville-ink',
          aCapo && 'whitespace-pre-line break-words',
        )}
      >
        {vuoto ? nonIndicato : valore}
      </dd>
    </div>
  )
}
```

- [ ] **Step 4: `RiquadroScheda.tsx`**

```tsx
'use client'

import { useId, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/** Un blocco della scheda: titolo visibile che dà anche il nome alla regione. */
export function RiquadroScheda({ titolo, icona: Icona, children }: { titolo: string; icona: LucideIcon; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="rounded-card border border-kidville-line bg-kidville-white p-4 sm:p-5">
      <h2 id={id} className="flex items-center gap-2 font-barlow text-base font-extrabold uppercase tracking-[0.02em] text-kidville-green">
        <Icona size={18} aria-hidden="true" />
        {titolo}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  )
}
```

- [ ] **Step 5: `SchedaGenitore.tsx`**

```tsx
'use client'

import { Mail, Phone } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { GenitoreScheda } from '@/lib/anagrafiche/docente/tipi'
import { CampoLettura } from './CampoLettura'

const LINK =
  'inline-flex min-h-[44px] items-center gap-1.5 font-semibold text-kidville-green underline-offset-2 hover:underline'

/** Il numero come lo vuole il compositore: solo cifre e `+`. */
const hrefTelefono = (numero: string) => `tel:${numero.replace(/[^\d+]/g, '')}`

export function SchedaGenitore({ genitore }: { genitore: GenitoreScheda }) {
  const t = useTranslations('teacherServizi')
  const nonIndicato = t('anagraficaNonIndicato')
  const parentela =
    genitore.parentela === 'madre'
      ? t('anagraficaParentelaMadre')
      : genitore.parentela === 'padre'
        ? t('anagraficaParentelaPadre')
        : genitore.parentela === 'delegato'
          ? t('anagraficaParentelaDelegato')
          : genitore.parentela === 'altro'
            ? t('anagraficaParentelaAltro')
            : null
  const sottotitolo = [parentela, genitore.principale ? t('anagraficaPrincipale') : null].filter(Boolean).join(' · ')

  return (
    <article data-testid="scheda-genitore" className="rounded-input border border-kidville-line p-3">
      <h3 className="font-barlow text-sm font-extrabold uppercase text-kidville-ink">
        {genitore.cognome} {genitore.nome}
      </h3>
      {sottotitolo && <p className="font-maven text-xs text-kidville-sub">{sottotitolo}</p>}
      <dl className="mt-1 divide-y divide-kidville-line">
        <CampoLettura
          etichetta={t('anagraficaCampoTelefono')}
          nonIndicato={nonIndicato}
          valore={
            genitore.telefoni.length === 0 ? null : (
              <ul>
                {genitore.telefoni.map((numero, i) => (
                  <li key={`${i}-${numero}`}>
                    <a href={hrefTelefono(numero)} className={LINK}>
                      <Phone size={14} aria-hidden="true" />
                      {numero}
                    </a>
                  </li>
                ))}
              </ul>
            )
          }
        />
        <CampoLettura
          etichetta={t('anagraficaCampoEmail')}
          nonIndicato={nonIndicato}
          valore={
            genitore.email.length === 0 ? null : (
              <ul>
                {genitore.email.map((indirizzo, i) => (
                  <li key={`${i}-${indirizzo}`}>
                    <a href={`mailto:${indirizzo}`} className={`${LINK} break-all`}>
                      <Mail size={14} aria-hidden="true" />
                      {indirizzo}
                    </a>
                  </li>
                ))}
              </ul>
            )
          }
        />
        <CampoLettura etichetta={t('anagraficaCampoCodiceFiscale')} nonIndicato={nonIndicato} valore={genitore.codiceFiscale} />
      </dl>
    </article>
  )
}
```

- [ ] **Step 6: `SchedaAlunnoLettura.tsx`**

```tsx
'use client'

import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, GraduationCap, HeartPulse, House, IdCard, ShieldCheck, TriangleAlert, UserCheck, Users } from 'lucide-react'
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'
import { Badge } from '@/components/ui/Badge'
import { allergeneEmoji, useAllergeneLabel } from '@/lib/mensa/allergeni'
import { isoToIt } from '@/lib/format/data'
import { logClient } from '@/lib/logging/client'
import { leggiRitornoElenco } from '@/lib/anagrafiche/docente/ritorno-elenco'
import type { SchedaAlunnoDocente } from '@/lib/anagrafiche/docente/tipi'
import { CampoLettura } from './CampoLettura'
import { RiquadroScheda } from './RiquadroScheda'
import { SchedaGenitore } from './SchedaGenitore'

/**
 * LA SCHEDA ANAGRAFICA, IN SOLA LETTURA.
 *
 * Qui non c'è nessun campo modificabile e nessun salvataggio: la route esporta solo
 * `GET`, e un test verifica che nel DOM non compaia un `input`. I dati non si salvano
 * sul telefono (né service worker né Dexie): senza rete la scheda non si apre, e lo
 * dice.
 */

type Esito =
  | { tipo: 'caricamento' }
  | { tipo: 'pronta'; scheda: SchedaAlunnoDocente }
  | { tipo: 'negata' | 'nonTrovata' | 'errore' | 'offline' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROTTA = '/teacher/alunni/[id]'

export function SchedaAlunnoLettura({ alunnoId }: { alunnoId: string }) {
  const t = useTranslations('teacherServizi')
  const router = useRouter()
  const etichettaAllergene = useAllergeneLabel()
  const idValido = UUID.test(alunnoId)
  const [esito, setEsito] = useState<Esito>({ tipo: 'caricamento' })

  const carica = useCallback(async () => {
    // Il fallimento della rete è un VALORE, non un `catch` che scrive lo stato:
    // `react-hooks/set-state-in-effect` vuole ogni `setState` dopo un `await`.
    const res = await fetch(`/api/teacher/alunni/${encodeURIComponent(alunnoId)}`, { cache: 'no-store' }).catch(() => null)
    if (!res) {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      setEsito({ tipo: offline ? 'offline' : 'errore' })
      if (!offline) logClient({ livello: 'error', evento: 'fetch', messaggio: 'scheda anagrafica non raggiunta', route: ROTTA })
      return
    }
    // 403 e 404 sono risposte di merito: il server le ha già registrate.
    if (res.status === 403) return setEsito({ tipo: 'negata' })
    if (res.status === 404) return setEsito({ tipo: 'nonTrovata' })
    const corpo = res.ok ? ((await res.json().catch(() => null)) as SchedaAlunnoDocente | null) : null
    if (!corpo || typeof corpo.id !== 'string') {
      setEsito({ tipo: 'errore' })
      logClient({ livello: 'warn', evento: 'fetch', messaggio: 'scheda anagrafica non letta', route: ROTTA, stato: res.status })
      return
    }
    setEsito({ tipo: 'pronta', scheda: corpo })
  }, [alunnoId])

  useEffect(() => {
    if (idValido) void carica()
  }, [carica, idValido])

  const riprova = () => {
    setEsito({ tipo: 'caricamento' })
    void carica()
  }

  // In avanti verso l'elenco, ma con i filtri che c'erano (il tasto indietro del
  // telefono li ritrova da solo; questo pulsante no, senza l'appunto).
  const tornaAllElenco = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    router.push(`/teacher/alunni${leggiRitornoElenco()}`)
  }

  const indietro = (
    <Link
      href="/teacher/alunni"
      onClick={tornaAllElenco}
      className="inline-flex min-h-[44px] items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t('anagraficaIndietro')}
    </Link>
  )

  const stato: Esito = idValido ? esito : { tipo: 'nonTrovata' }

  if (stato.tipo !== 'pronta') {
    const messaggio =
      stato.tipo === 'negata'
        ? t('anagraficaErroreNegato')
        : stato.tipo === 'nonTrovata'
          ? t('anagraficaErroreNonTrovata')
          : stato.tipo === 'offline'
            ? t('anagraficaErroreOffline')
            : stato.tipo === 'errore'
              ? t('anagraficaErroreLettura')
              : null
    return (
      <div className="space-y-4">
        {indietro}
        <PageHeaderCard eyebrow={t('anagraficaTitolo')} icon={IdCard} title={t('anagraficaSchedaTitolo')} compatta />
        {stato.tipo === 'caricamento' ? (
          <div role="status" className="flex items-center justify-center gap-3 py-12">
            <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
            <p className="font-maven text-sm text-kidville-sub">{t('anagraficaCaricamento')}</p>
          </div>
        ) : (
          <div data-testid="scheda-esito" data-esito={stato.tipo} className="flex flex-col items-center gap-3 py-12 text-center">
            <TriangleAlert size={34} aria-hidden="true" className="text-kidville-error-strong" />
            <p className="max-w-md font-maven text-sm text-kidville-ink">{messaggio}</p>
            {(stato.tipo === 'errore' || stato.tipo === 'offline') && (
              <button
                type="button"
                onClick={riprova}
                className="inline-flex min-h-[44px] items-center rounded-pill border border-kidville-line px-4 font-maven text-sm font-semibold text-kidville-ink/80 hover:border-kidville-green"
              >
                {t('anagraficaRiprova')}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const s = stato.scheda
  const nonIndicato = t('anagraficaNonIndicato')
  const siNo = (v: boolean | null) => (v === null ? null : v ? t('anagraficaSi') : t('anagraficaNo'))
  const data = (v: string | null) => (v ? isoToIt(v) : null)
  const conProvincia = (comune: string | null, provincia: string | null) =>
    comune && provincia ? `${comune} (${provincia})` : (comune ?? provincia)
  const luogo = [conProvincia(s.luogoNascita.comune, s.luogoNascita.provincia), s.luogoNascita.nazione].filter(Boolean).join(', ')
  const indirizzo = [s.residenza.indirizzo, s.residenza.civico].filter(Boolean).join(', ')
  const sesso = s.sesso === 'M' ? t('anagraficaSessoM') : s.sesso === 'F' ? t('anagraficaSessoF') : null
  const grado =
    s.sezione?.grado === 'nido'
      ? t('anagraficaGradoNido')
      : s.sezione?.grado === 'infanzia'
        ? t('anagraficaGradoInfanzia')
        : s.sezione?.grado === 'primaria'
          ? t('anagraficaGradoPrimaria')
          : null
  const chipAllergie = (
    <ul className="flex flex-wrap gap-1.5">
      {s.salute.allergeni.map((k) => (
        <li key={k} className="inline-flex items-center gap-1 rounded-pill bg-kidville-error-soft px-2.5 py-1 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-ink">
          <span aria-hidden="true">{allergeneEmoji(k)}</span> {etichettaAllergene(k)}
        </li>
      ))}
      {s.salute.allergieAltro && (
        <li className="inline-flex items-center rounded-pill bg-kidville-cream-dark px-2.5 py-1 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-ink">
          {s.salute.allergieAltro}
        </li>
      )}
    </ul>
  )

  return (
    <div data-testid="scheda-alunno" className="space-y-4">
      {indietro}
      <PageHeaderCard
        eyebrow={t('anagraficaTitolo')}
        icon={IdCard}
        title={`${s.cognome} ${s.nome}`}
        subtitle={s.sezione?.nome}
        badge={<Badge tone="neutral">{t('anagraficaSolaLettura')}</Badge>}
        compatta
      />

      {s.salute.haAllergie && (
        <div role="note" aria-label={t('anagraficaAvvisoAllergie')} className="rounded-card border-2 border-kidville-error bg-kidville-error-soft p-4">
          <p className="mb-2 flex items-center gap-2 font-barlow text-sm font-extrabold uppercase text-kidville-ink">
            <TriangleAlert size={18} aria-hidden="true" className="text-kidville-error-strong" />
            {t('anagraficaAvvisoAllergie')}
          </p>
          {chipAllergie}
        </div>
      )}

      <RiquadroScheda titolo={t('anagraficaRiquadroDati')} icona={IdCard}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoSesso')} valore={sesso} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoDataNascita')} valore={data(s.dataNascita)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoLuogoNascita')} valore={luogo} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoCittadinanza')} valore={s.cittadinanza} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoCodiceFiscale')} valore={s.codiceFiscale} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroResidenza')} icona={House}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoIndirizzo')} valore={indirizzo} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoCap')} valore={s.residenza.cap} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoComune')} valore={conProvincia(s.residenza.comune, s.residenza.provincia)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroClasse')} icona={GraduationCap}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoSezione')} valore={s.sezione?.nome} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoGrado')} valore={grado} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoDataIscrizione')} valore={data(s.dataIscrizione)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroSalute')} icona={HeartPulse}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura
            etichetta={t('anagraficaCampoAllergie')}
            valore={s.salute.haAllergie ? chipAllergie : t('anagraficaNessunaAllergia')}
            nonIndicato={nonIndicato}
          />
          <CampoLettura etichetta={t('anagraficaCampoNoteMediche')} valore={s.salute.noteMediche} nonIndicato={nonIndicato} aCapo />
          <CampoLettura etichetta={t('anagraficaCampoBes')} valore={siNo(s.salute.besDsa)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoPannolino')} valore={siNo(s.salute.usaPannolino)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroConsensi')} icona={ShieldCheck}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoConsensoPrivacy')} valore={siNo(s.consensi.privacy)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoConsensoFotoSito')} valore={siNo(s.consensi.fotoSito)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoConsensoFotoSocial')} valore={siNo(s.consensi.fotoSocial)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroFamiglia')} icona={Users}>
        {s.genitori.length === 0 ? (
          <p className="py-2 font-maven text-sm italic text-kidville-sub">{t('anagraficaNessunGenitore')}</p>
        ) : (
          <div className="space-y-3">
            {s.genitori.map((g, i) => (
              <SchedaGenitore key={`${i}-${g.cognome}-${g.nome}`} genitore={g} />
            ))}
          </div>
        )}
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroDelegati')} icona={UserCheck}>
        {s.delegati.length === 0 ? (
          <p className="py-2 font-maven text-sm italic text-kidville-sub">{t('anagraficaNessunDelegato')}</p>
        ) : (
          <dl className="divide-y divide-kidville-line">
            {s.delegati.map((d, i) => (
              <CampoLettura
                key={`${i}-${d.cognome}-${d.nome}`}
                etichetta={`${d.cognome} ${d.nome}`}
                valore={d.parentela}
                nonIndicato={nonIndicato}
              />
            ))}
          </dl>
        )}
      </RiquadroScheda>

      <p className="pb-2 text-center font-maven text-xs text-kidville-sub">{t('anagraficaCorrezione')}</p>
    </div>
  )
}
```

> Nel test, il delegato «Nonna» compare come valore (`dd`) della riga intestata «Arcobaleno-E2E Nonna»: il selettore `'p, span, dd'` lo trova lì. Se `getByText` trovasse più di un nodo, restringi con `within(screen.getByRole('region', { name: T.anagraficaRiquadroDelegati }))`.

- [ ] **Step 7: la pagina** — `src/app/(dashboard)/teacher/alunni/[id]/page.tsx`:

```tsx
'use client'

import { useParams } from 'next/navigation'
import { SchedaAlunnoLettura } from '@/components/features/teacher/anagrafica/SchedaAlunnoLettura'

/**
 * Insegnante — la scheda di un bambino. Un guscio: i dati arrivano dall'API, mai
 * nell'HTML (che il service worker salva per l'offline). Il perimetro lo decide la
 * route, non questa pagina.
 */
export default function TeacherSchedaAlunnoPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : ''
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 sm:px-6">
      <SchedaAlunnoLettura alunnoId={id} />
    </div>
  )
}
```

- [ ] **Step 8: verifica**

Run: `npx vitest run __tests__/components/SchedaAlunnoLettura.test.tsx 2>&1 | tail -10`
Expected: `Test Files  1 passed (1)`. Prova di rottura: aggiungi temporaneamente `<input readOnly value={s.nome} />` dentro la scheda → il test «SOLA LETTURA» diventa rosso. Togli.

- [ ] **Step 9: commit**

```bash
git add src/components/features/teacher/anagrafica/CampoLettura.tsx src/components/features/teacher/anagrafica/RiquadroScheda.tsx src/components/features/teacher/anagrafica/SchedaGenitore.tsx src/components/features/teacher/anagrafica/SchedaAlunnoLettura.tsx "src/app/(dashboard)/teacher/alunni/[id]/page.tsx" __tests__/components/SchedaAlunnoLettura.test.tsx
git commit -m "Anagrafica docente: la scheda in sola lettura

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: l'elenco con la barra filtri

**Files:**
- Create: `src/components/features/teacher/anagrafica/PannelloAlunni.tsx`
- Create: `src/components/features/teacher/anagrafica/ElencoAlunniDocente.tsx`
- Create: `src/app/(dashboard)/teacher/alunni/page.tsx`
- Test: `__tests__/components/ElencoAlunniDocente.test.tsx`

- [ ] **Step 1: scrivi il test che fallisce** — `__tests__/components/ElencoAlunniDocente.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import servizi from '../../messages/it/teacherServizi.json'
import condivisi from '../../messages/it/shared.json'
import type { ElencoAlunniRisposta, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'

const T = servizi as Record<string, string>
const S = condivisi as Record<string, string>

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
      React.createElement('a', { href, ...rest }, children),
  }
})

import { ElencoAlunniDocente } from '@/components/features/teacher/anagrafica/ElencoAlunniDocente'

const voce = (v: Partial<VoceElencoAlunno> & { id: string; nome: string; cognome: string }): VoceElencoAlunno => ({
  sectionId: 'S1', grado: 'infanzia', dataNascita: '2021-01-01', annoNascita: 2021, sesso: 'F',
  allergeni: [], haAllergie: false, besDsa: false, usaPannolino: false,
  consensoFotoSito: true, consensoFotoSocial: true, ...v,
})

const DATI: ElencoAlunniRisposta = {
  sezioni: [
    { id: 'S1', nome: 'Girasoli', grado: 'infanzia' },
    { id: 'S2', nome: 'Tulipani', grado: 'infanzia' },
  ],
  alunni: [
    voce({ id: 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa', nome: 'Aurora', cognome: 'Arcobaleno-E2E', allergeni: ['latte'], haAllergie: true }),
    voce({ id: 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa', nome: 'Bruno', cognome: 'Baleno-E2E' }),
    voce({ id: 'a3a3a3a3-3333-4333-8333-aaaaaaaaaaaa', nome: 'Clara', cognome: 'Cometa-E2E', sectionId: 'S2' }),
  ],
}

const fetchMock = vi.fn()
const risposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/teacher/alunni')
  window.sessionStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ElencoAlunniDocente', () => {
  it('raggruppa per sezione, con il conteggio e il link alla scheda', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    const girasoli = await screen.findByRole('region', { name: /Girasoli/ })
    expect(within(girasoli).getAllByRole('link')).toHaveLength(2)
    expect(within(girasoli).getByText('2 bambini')).toBeTruthy()
    const aurora = within(girasoli).getByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    expect(aurora.getAttribute('href')).toBe('/teacher/alunni/a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa')
    expect(within(aurora).getByText(T.anagraficaBadgeAllergie)).toBeTruthy()
    expect(screen.getByRole('region', { name: /Tulipani/ })).toBeTruthy()
  })

  it('la ricerca per nome restringe l’elenco, il contatore lo dice, e NON va nell’indirizzo', async () => {
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })
    fireEvent.change(screen.getByLabelText(T.anagraficaFiltroCerca), { target: { value: 'clara' } })
    expect(screen.queryByRole('link', { name: /Arcobaleno-E2E Aurora/ })).toBeNull()
    expect(screen.getByRole('link', { name: /Cometa-E2E Clara/ })).toBeTruthy()
    expect(screen.getByTestId('conteggio-risultati').textContent).toMatch(/1/)
    expect(new URLSearchParams(window.location.search).get('q')).toBeNull()
  })

  it('un filtro dall’indirizzo vale fin dal primo disegno (si monta DOPO i dati)', async () => {
    window.history.replaceState(null, '', '/teacher/alunni?sezione=S2')
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByRole('link', { name: /Cometa-E2E Clara/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Arcobaleno-E2E Aurora/ })).toBeNull()
  })

  it('toccando un bambino salva i filtri per il ritorno (senza la ricerca per nome)', async () => {
    window.history.replaceState(null, '', '/teacher/alunni?sezione=S1')
    fetchMock.mockResolvedValue(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    fireEvent.click(await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ }))
    expect(window.sessionStorage.getItem('kv-teacher-alunni-ritorno')).toBe('?sezione=S1')
  })

  it('elenco vuoto: il messaggio per chi non ha classi assegnate', async () => {
    fetchMock.mockResolvedValue(risposta(200, { sezioni: [], alunni: [] }))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(T.anagraficaVuotoTitolo)).toBeTruthy()
    expect(screen.getByText(T.anagraficaVuotoCorpo)).toBeTruthy()
  })

  it('lettura fallita: errore con «Riprova», mai «nessun bambino»', async () => {
    fetchMock.mockResolvedValueOnce(risposta(500, {})).mockResolvedValueOnce(risposta(200, DATI))
    render(<ElencoAlunniDocente />)
    expect(await screen.findByText(S.filtriErroreTitolo)).toBeTruthy()
    expect(screen.queryByText(T.anagraficaVuotoTitolo)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: S.paginaErroreRiprova }))
    expect(await screen.findByRole('link', { name: /Arcobaleno-E2E Aurora/ })).toBeTruthy()
  })
})
```

- [ ] **Step 2: verifica che fallisca**

Run: `npx vitest run __tests__/components/ElencoAlunniDocente.test.tsx 2>&1 | tail -8`
Expected: FAIL, import non risolto.

- [ ] **Step 3: `PannelloAlunni.tsx`**

```tsx
'use client'

import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { BarraFiltri, testiBarraFiltri } from '@/components/ui/BarraFiltri'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { Badge } from '@/components/ui/Badge'
import { decidiStatoElenco } from '@/lib/ui/filtri/motore'
import { useFiltri } from '@/lib/ui/filtri/use-filtri'
import { useAllergeneLabel } from '@/lib/mensa/allergeni'
import { isoToIt } from '@/lib/format/data'
import { salvaRitornoElenco } from '@/lib/anagrafiche/docente/ritorno-elenco'
import type { ElencoAlunniRisposta, SezioneElenco, VoceElencoAlunno } from '@/lib/anagrafiche/docente/tipi'
import { campiAlunni } from './filtri-alunni'

interface Gruppo {
  chiave: string
  nome: string
  alunni: VoceElencoAlunno[]
}

/** I bambini (già filtrati) per sezione, nell'ordine delle sezioni; chi non ne ha va in fondo. */
function raggruppa(alunni: readonly VoceElencoAlunno[], sezioni: readonly SezioneElenco[], senzaSezione: string): Gruppo[] {
  const perSezione = new Map<string, VoceElencoAlunno[]>()
  const orfani: VoceElencoAlunno[] = []
  const note = new Set(sezioni.map((s) => s.id))
  for (const a of alunni) {
    if (a.sectionId && note.has(a.sectionId)) perSezione.set(a.sectionId, [...(perSezione.get(a.sectionId) ?? []), a])
    else orfani.push(a)
  }
  const gruppi = sezioni.flatMap((s) => {
    const membri = perSezione.get(s.id)
    return membri ? [{ chiave: s.id, nome: s.nome, alunni: membri }] : []
  })
  if (orfani.length > 0) gruppi.push({ chiave: 'senza-sezione', nome: senzaSezione, alunni: orfani })
  return gruppi
}

/**
 * Barra filtri + elenco. Si monta SOLO a dati arrivati: le opzioni dei filtri
 * nascono dai dati, e `useFiltri` legge l'indirizzo una volta sola.
 */
export function PannelloAlunni({ dati }: { dati: ElencoAlunniRisposta }) {
  const t = useTranslations('teacherServizi')
  const ts = useTranslations('shared')
  const etichettaAllergene = useAllergeneLabel()
  const campi = campiAlunni(t, { sezioni: dati.sezioni, alunni: dati.alunni, etichettaAllergene })
  const stato = useFiltri<VoceElencoAlunno>(campi)

  const visibili = stato.filtra(dati.alunni)
  const schermata = decidiStatoElenco({
    caricamento: false,
    errore: false,
    totale: dati.alunni.length,
    mostrati: visibili.length,
  })
  const gruppi = raggruppa(visibili, dati.sezioni, t('anagraficaSenzaSezione'))

  return (
    <div className="space-y-4">
      <BarraFiltri
        campi={campi}
        stato={stato}
        testi={testiBarraFiltri(ts)}
        totale={dati.alunni.length}
        mostrati={visibili.length}
        variante="compatta"
      />

      <StatoElenco
        stato={schermata}
        testi={{
          ...testiStatoElenco(ts),
          vuotoTitolo: t('anagraficaVuotoTitolo'),
          vuotoCorpo: t('anagraficaVuotoCorpo'),
        }}
        attivi={stato.attivi}
        onPulisci={stato.pulisci}
      />

      {gruppi.map((g) => (
        <section key={g.chiave} aria-labelledby={`sezione-${g.chiave}`} className="space-y-2">
          <h2 id={`sezione-${g.chiave}`} className="flex items-baseline justify-between px-1 font-barlow text-sm font-extrabold uppercase tracking-[0.03em] text-kidville-green">
            <span>{g.nome}</span>
            <span className="font-maven text-xs font-semibold normal-case tracking-normal text-kidville-sub">
              {t('anagraficaConteggioSezione', { n: g.alunni.length })}
            </span>
          </h2>
          <ul className="divide-y divide-kidville-line overflow-hidden rounded-card border border-kidville-line bg-kidville-white">
            {g.alunni.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/teacher/alunni/${a.id}`}
                  // I filtri attuali (mai la ricerca per nome) per il pulsante di ritorno.
                  onClick={() => salvaRitornoElenco(window.location.search)}
                  className="flex min-h-[56px] items-center gap-3 px-4 py-3 transition-colors hover:bg-kidville-cream"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-barlow text-sm font-extrabold uppercase text-kidville-green">
                      {a.cognome} {a.nome}
                    </p>
                    {a.dataNascita && <p className="font-maven text-xs text-kidville-sub">{isoToIt(a.dataNascita)}</p>}
                  </div>
                  {a.haAllergie && <Badge tone="error">{t('anagraficaBadgeAllergie')}</Badge>}
                  <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-kidville-sub" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: `ElencoAlunniDocente.tsx`**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { logClient } from '@/lib/logging/client'
import type { ElencoAlunniRisposta } from '@/lib/anagrafiche/docente/tipi'
import { PannelloAlunni } from './PannelloAlunni'

/**
 * Carica l'elenco e solo dopo monta il pannello coi filtri. Una lettura fallita è
 * un errore con «Riprova», mai «nessun bambino»: manderebbe a chiedere alla
 * segreteria una classe che c'è già.
 */

type Lettura = { ok: true; dati: ElencoAlunniRisposta } | { ok: false }

/** La lettura, fuori dal componente: restituisce un esito e logga, non tocca lo stato. */
async function leggiElenco(): Promise<Lettura> {
  const res = await fetch('/api/teacher/alunni', { cache: 'no-store' }).catch(() => null)
  const corpo = res?.ok ? ((await res.json().catch(() => null)) as ElencoAlunniRisposta | null) : null
  if (!corpo || !Array.isArray(corpo.alunni) || !Array.isArray(corpo.sezioni)) {
    logClient({
      livello: res ? 'warn' : 'error',
      evento: 'fetch',
      messaggio: 'elenco anagrafiche docente non letto',
      route: '/teacher/alunni',
      ...(res ? { stato: res.status } : null),
    })
    return { ok: false }
  }
  return { ok: true, dati: corpo }
}

export function ElencoAlunniDocente() {
  const ts = useTranslations('shared')
  const [lettura, setLettura] = useState<Lettura | null>(null)
  const [tentativo, setTentativo] = useState(0)

  // Il `setState` sta nel `.then`: è la forma che `react-hooks/set-state-in-effect`
  // accetta (la stessa di `parent/primaria/valutazioni`). `vivo` scarta una risposta
  // arrivata dopo lo smontaggio o dopo un «Riprova».
  useEffect(() => {
    let vivo = true
    void leggiElenco().then((esito) => {
      if (vivo) setLettura(esito)
    })
    return () => {
      vivo = false
    }
  }, [tentativo])

  const riprova = () => {
    setLettura(null)
    setTentativo((n) => n + 1)
  }

  if (lettura && !lettura.ok) return <StatoElenco stato="errore" testi={testiStatoElenco(ts)} onRiprova={riprova} />
  if (!lettura) return <StatoElenco stato="caricamento" testi={testiStatoElenco(ts)} />
  return <PannelloAlunni dati={lettura.dati} />
}
```

- [ ] **Step 5: la pagina** — `src/app/(dashboard)/teacher/alunni/page.tsx`:

```tsx
'use client'

import { Suspense } from 'react'
import { useTranslations } from 'next-intl'
import { Contact } from 'lucide-react'
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'
import { ElencoAlunniDocente } from '@/components/features/teacher/anagrafica/ElencoAlunniDocente'

/**
 * Insegnante — l'anagrafica dei propri bambini, in sola lettura. Il perimetro lo
 * impone la route (sezioni assegnate, anche per materia), non questa pagina.
 * `<Suspense>`: il pannello monta `useFiltri`, che legge `useSearchParams()`.
 */
export default function TeacherAlunniPage() {
  const t = useTranslations('teacherServizi')
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-4 sm:px-6">
      <PageHeaderCard
        eyebrow={t('anagraficaEyebrow')}
        icon={Contact}
        title={t('anagraficaTitolo')}
        subtitle={t('anagraficaSottotitolo')}
        compatta
      />
      <div className="mt-4">
        <Suspense fallback={null}>
          <ElencoAlunniDocente />
        </Suspense>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: verifica**

Run: `npx vitest run __tests__/components/ElencoAlunniDocente.test.tsx __tests__/architecture/offline-etichette-rotte.test.ts __tests__/architecture/messaggi-chiavi-orfane.test.ts __tests__/architecture/messaggi-parita-cataloghi.test.ts 2>&1 | tail -10`
Expected: `Test Files  4 passed (4)`. Se `messaggi-chiavi-orfane` segnala una chiave mai usata, o la usi dove serve o la togli da **entrambi** i cataloghi.

- [ ] **Step 7: commit**

```bash
git add src/components/features/teacher/anagrafica/PannelloAlunni.tsx src/components/features/teacher/anagrafica/ElencoAlunniDocente.tsx "src/app/(dashboard)/teacher/alunni/page.tsx" __tests__/components/ElencoAlunniDocente.test.tsx
git commit -m "Anagrafica docente: elenco con ricerca e filtri avanzati

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9b: il registro degli accessi dice «Scheda anagrafica»

**Perché.** Ogni scheda aperta dal Task 5 scrive in `fascicolo_accessi_audit` una riga
`azione: 'view'`, `finalita: 'anagrafica-docente'`. La segreteria legge quel registro in
Direzione → Primaria → «Fascicoli» (`FascicoloAuditViewer`), che oggi mostra solo data, azione,
utente, alunno e IP: un'insegnante che apre l'anagrafica comparirebbe come «Visualizzazione» del
fascicolo — dove «fascicolo» vuol dire PEI, PDP e documenti sanitari. Va detto che cosa è stato
aperto.

**Files:**
- Modify: `src/lib/anagrafiche/docente/tipi.ts` (costante condivisa)
- Modify: `src/app/api/teacher/alunni/[id]/route.ts` (usa la costante al posto del letterale locale)
- Modify: `src/components/features/admin/primaria/FascicoloAuditViewer.tsx`
- Modify: `messages/it/adminPrimaria.json`, `messages/en/adminPrimaria.json`
- Test: `__tests__/components/FascicoloAuditViewer-finalita.test.tsx`

- [ ] **Step 1: la costante condivisa** — in fondo a `src/lib/anagrafiche/docente/tipi.ts`:

```ts
/**
 * Il valore di `fascicolo_accessi_audit.finalita` con cui la scheda docente registra
 * ogni apertura. È un contratto fra la route che scrive (`api/teacher/alunni/[id]`) e il
 * registro che la segreteria legge (`FascicoloAuditViewer`): una sola definizione, perché
 * se le due copie divergessero il registro tornerebbe a mostrare una «visualizzazione del
 * fascicolo» qualunque.
 */
export const FINALITA_AUDIT_ANAGRAFICA = 'anagrafica-docente'
```

Nella route `src/app/api/teacher/alunni/[id]/route.ts` togli `const FINALITA_AUDIT = 'anagrafica-docente'`
e usa `FINALITA_AUDIT_ANAGRAFICA` importato da `@/lib/anagrafiche/docente/tipi` (i test della
route continuano ad asserire il valore letterale `'anagrafica-docente'`: devono restare verdi).

- [ ] **Step 2: scrivi il test che fallisce** — `__tests__/components/FascicoloAuditViewer-finalita.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import primaria from '../../messages/it/adminPrimaria.json'
import { FascicoloAuditViewer } from '@/components/features/admin/primaria/FascicoloAuditViewer'

const T = primaria as Record<string, string>

const riga = (id: string, finalita: string | null, cognome: string) => ({
  id,
  azione: 'view',
  finalita,
  ip: null,
  creato_il: '2026-10-04T08:00:00.000Z',
  utenti: { nome: 'Docente', cognome: 'Prova-E2E' },
  alunni: { nome: 'Bimbo', cognome },
})

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        data: [riga('r1', 'anagrafica-docente', 'Anagrafica-E2E'), riga('r2', 'stampa del modulo', 'Altro-E2E'), riga('r3', null, 'Nulla-E2E')],
      }),
    })),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('FascicoloAuditViewer — la finalità «anagrafica docente»', () => {
  it('la riga della scheda anagrafica dice che cosa è stato aperto', async () => {
    render(<FascicoloAuditViewer scuolaId="s" userId="u" />)
    const cella = (await screen.findByText(/Anagrafica-E2E/)).closest('tr') as HTMLElement
    expect(within(cella).getByText(T.fascicoloFinalitaAnagraficaDocente)).toBeTruthy()
  })

  it('le altre righe restano come prima', async () => {
    render(<FascicoloAuditViewer scuolaId="s" userId="u" />)
    for (const cognome of [/Altro-E2E/, /Nulla-E2E/]) {
      const tr = (await screen.findByText(cognome)).closest('tr') as HTMLElement
      expect(within(tr).queryByText(T.fascicoloFinalitaAnagraficaDocente)).toBeNull()
      expect(within(tr).getByText(T.fascicoloAzioneView)).toBeTruthy()
    }
  })
})
```

- [ ] **Step 3: verifica che fallisca**

Run: `npx vitest run __tests__/components/FascicoloAuditViewer-finalita.test.tsx 2>&1 | tail -8`
Expected: FAIL (la chiave `fascicoloFinalitaAnagraficaDocente` non esiste: il primo test non trova il testo).

- [ ] **Step 4: testi** — in `messages/it/adminPrimaria.json`, dopo `"fascicoloAzioneDelete": …,`:
`"fascicoloFinalitaAnagraficaDocente": "Scheda anagrafica",`; in `messages/en/adminPrimaria.json`, stessa posizione:
`"fascicoloFinalitaAnagraficaDocente": "Student record",`.

- [ ] **Step 5: il visualizzatore** — in `FascicoloAuditViewer.tsx` importa
`import { FINALITA_AUDIT_ANAGRAFICA } from '@/lib/anagrafiche/docente/tipi';` e, nella cella
dell'azione, subito dopo lo `<span>` del badge:

```tsx
                  {/* Un'apertura della scheda anagrafica dal docente non è una visione dei
                      documenti del fascicolo (PEI/PDP, sanitari): lo si dice. Le altre
                      finalità restano come prima. */}
                  {r.finalita === FINALITA_AUDIT_ANAGRAFICA && (
                    <span className="ml-1.5 font-maven text-[11px] text-kidville-muted">
                      {t('fascicoloFinalitaAnagraficaDocente')}
                    </span>
                  )}
```

- [ ] **Step 6: verifica**

Run: `npx vitest run __tests__/components/FascicoloAuditViewer-finalita.test.tsx __tests__/api/teacher-alunni-scheda.test.ts 2>&1 | tail -8`
Expected: `Test Files  2 passed (2)`. Poi tutti i lock (regole comuni), eslint sui file toccati, tsc.

- [ ] **Step 7: commit**

```bash
git add src/lib/anagrafiche/docente/tipi.ts "src/app/api/teacher/alunni/[id]/route.ts" src/components/features/admin/primaria/FascicoloAuditViewer.tsx messages/it/adminPrimaria.json messages/en/adminPrimaria.json __tests__/components/FascicoloAuditViewer-finalita.test.tsx
git commit -m "Registro degli accessi: l'apertura della scheda anagrafica si riconosce

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: E2E Playwright (gira in CI)

**Files:**
- Create: `e2e/teacher-anagrafica.spec.ts`

> In locale `npm run e2e` è in `deny` (il `.env.local` punta alla produzione): questo spec si scrive qui e si collauda **in CI**. Dati del seed: `docente.e2e` insegna in «Girasoli» (Aurora Arcobaleno-E2E `IDS.A1`, Bruno Baleno-E2E `IDS.A2`); Clara Cometa-E2E (`IDS.A3`) sta in «Tulipani», che non è sua.

- [ ] **Step 1: scrivi lo spec**

```ts
import { test, expect } from '@playwright/test'
import { IDS, STORAGE } from './fixtures'

test.describe('Docente — anagrafica dei propri alunni, in sola lettura', () => {
  test.use({ storageState: STORAGE.docente })

  test('elenco della propria sezione, ricerca per nome, scheda senza campi modificabili', async ({ page }) => {
    await page.goto('/teacher/alunni')
    const aurora = page.getByRole('link', { name: /^Arcobaleno-E2E Aurora/ })
    await expect(aurora).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole('link', { name: /^Baleno-E2E Bruno/ })).toBeVisible()
    // Dopo una PRESENZA, l'assenza: Clara è di un'altra sezione.
    await expect(page.getByRole('link', { name: /Cometa-E2E/ })).toHaveCount(0)

    await page.getByRole('searchbox').fill('aurora')
    await expect(page.getByRole('link', { name: /^Baleno-E2E Bruno/ })).toHaveCount(0)
    await expect(aurora).toBeVisible()
    expect(new URL(page.url()).searchParams.get('q')).toBeNull()

    await aurora.click()
    await expect(page).toHaveURL(new RegExp(`/teacher/alunni/${IDS.A1}$`))
    const scheda = page.getByTestId('scheda-alunno')
    await expect(scheda.getByRole('heading', { level: 1, name: 'Arcobaleno-E2E Aurora' })).toBeVisible({ timeout: 15_000 })
    await expect(scheda.locator('input, textarea, select, [contenteditable="true"]')).toHaveCount(0)
  })

  test('la scheda di un bambino di un’altra sezione è negata', async ({ page }) => {
    await page.goto(`/teacher/alunni/${IDS.A3}`)
    await expect(page.getByTestId('scheda-esito')).toHaveAttribute('data-esito', 'negata', { timeout: 15_000 })
    await expect(page.getByText('Cometa-E2E')).toHaveCount(0)
  })
})
```

- [ ] **Step 2: verifica che compili e passi il lint** — `tsconfig.json` include `**/*.ts` (esclusa solo `e2e/primaria-360`), quindi lo spec è nel progetto TypeScript:

Run: `npx tsc --noEmit 2>&1 | tail -5 && npx eslint e2e/teacher-anagrafica.spec.ts --max-warnings 0`
Expected: nessun errore, nessun avviso.

- [ ] **Step 3: commit**

```bash
git add e2e/teacher-anagrafica.spec.ts
git commit -m "E2E: il docente consulta l'anagrafica dei suoi alunni e non quella degli altri

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: i bambini `sospeso` sono visibili alle insegnanti

**Decisione del titolare (04/10):** un bambino con `alunni.stato = 'sospeso'` frequenta ancora
(`LATO_DEL_CONFINE` in `src/lib/alunni/stato.ts` lo classifica `'ancora-iscritto'`): l'insegnante
deve vederne elenco e scheda, allergie comprese. Nessuna etichetta «sospeso» a schermo.
⚠️ Non confondere con la colonna BOOLEANA `alunni.sospeso` (sospensione per morosità, dato
economico): resta esclusa da colonne e proiezione.

**Files (da verificare leggendo il codice):**
- Modify: `src/lib/anagrafiche/docente/visibilita.ts` (il controllo della scheda oggi risponde 404 se `stato !== STATO_ISCRITTO`)
- Modify: `src/app/api/teacher/alunni/route.ts` (elenco: `.eq('stato', STATO_ISCRITTO)`)
- Modify: `src/app/api/teacher/alunni/[id]/route.ts` (seconda lettura della scheda: `.eq('stato', STATO_ISCRITTO)`)
- Test: `__tests__/lib/anagrafica-docente-visibilita.test.ts`, `__tests__/api/teacher-alunni.test.ts`, `__tests__/api/teacher-alunni-scheda.test.ts`

**Regola:** gli stati ammessi sono quelli con `LATO_DEL_CONFINE[s] === 'ancora-iscritto'`. In
`stato.ts` esiste già la costante derivata `STATI_CON_CANALE_FAMIGLIA` (stesso filtro), ma il suo
nome parla dei canali verso le famiglie. Valuta (e dichiara nel rapporto) la soluzione più pulita:
- (preferita) aggiungere in `stato.ts` una costante dal nome giusto, per esempio
  `STATI_CHE_FREQUENTANO`, DERIVATA da `LATO_DEL_CONFINE` esattamente come le altre (mai una lista
  scritta a mano), con un commento che dica a chi serve (anagrafica docente) e perché non è
  `STATO_ISCRITTO` in senso stretto; controlla i test di `stato.ts`
  (`__tests__/lib/alunni-stato.test.ts`) e i lock `stati-alunno-classificati` /
  `elenchi-operativi-solo-iscritti` (che cosa accettano come filtro di stato);
- oppure riusare `STATI_CON_CANALE_FAMIGLIA` se aggiungere una costante creasse un doppione che un
  lock vieta.
Nelle query: `.in('stato', [...COSTANTE])`, INCONDIZIONATO (il lock `elenchi-operativi-solo-iscritti`
vuole un filtro di stato positivo e senza `if`). Nel controllo della scheda: 404 se lo stato NON è
fra quelli ammessi (un `ritirato` resta 404).

**Test (TDD, rossi prima):**
- visibilità: un alunno `sospeso` della sezione dell'educator → apre (200); un `ritirato` → 404 come
  prima;
- elenco: un `sospeso` della sezione compare; un `ritirato` no;
- scheda: un `sospeso` apre con 200 e riga di audit; la seconda lettura rifiltra con gli stessi stati
  (corsa: un bambino che passa a `ritirato` fra controllo e lettura → 404, già coperto: verifica che
  resti verde);
- il campo booleano `sospeso: true` (morosità) su una riga NON compare nella risposta (aggiungilo al
  fixture di un bambino e cerca la chiave/valore nel testo della risposta).

**Prova di rottura:** rimetti `.eq('stato', STATO_ISCRITTO)` nell'elenco → il test del sospeso
diventa rosso; ripristina.

**Commit:** un commit con i file toccati, messaggio
«Anagrafica docente: anche i bambini sospesi (frequentano) sono visibili alle insegnanti».

---

### Task 13: gli IP del registro degli accessi si conservano un anno

**Decisione del titolare (04/10):** l'IP di chi consulta i dati dei bambini, registrato in
`fascicolo_accessi_audit.ip`, si conserva **un anno**. Insieme all'IP si azzera `user_agent` (il
dispositivo: stessa natura). Il resto della riga (`alunno_id`, `documento_id`, `utente_id`,
`azione`, `finalita`, `creato_il`) RESTA: è il registro che risponde a «chi ha aperto la scheda di
mio figlio». Vale per TUTTO il registro, non solo per le aperture della scheda. L'informativa per
le famiglie NON cambia (decisione del titolare).

**Modello da seguire alla lettera:** la scadenza dei motivi d'assenza.
- La funzione e il battito: `supabase/migrations/20260808042814_retention_battito_leggibile.sql`
  (`presenze_giustificazioni_retention_tick` e `notifiche_retention_tick`: `SECURITY DEFINER`,
  `SET search_path = public, pg_temp`, `v_mesi constant int := 12`, `INSERT INTO public.app_log …
  ON CONFLICT (fingerprint, giorno) DO UPDATE`, `REVOKE … FROM PUBLIC, anon, authenticated`,
  `GRANT EXECUTE … TO service_role`). Leggila per intero, e trova con Grep la migrazione che fa il
  `cron.schedule('presenze-giustificazioni-retention', …)` e copiane la forma (idempotente:
  `cron.unschedule` se esiste, poi `cron.schedule`).
- Il lock: `__tests__/architecture/informativa-conservazione-dichiarata.test.ts` (blocco
  «il motivo dell'assenza scade e si dimentica» e `BATTITI_DA_LEGGERE`).
- La sorveglianza: `src/lib/health/controlli.ts` (voce `presenze-giustificazioni-retention`,
  finestra 26 h).

**Files:**
- Create: `supabase/migrations/<YYYYMMDDHHMMSS>_fascicolo_audit_ip_retention.sql` — timestamp
  successivo all'ultima migrazione presente (`ls supabase/migrations | tail -1`), formato identico.
  Contenuto:
  - `CREATE OR REPLACE FUNCTION public.fascicolo_audit_ip_retention_tick() RETURNS void` con
    `v_mesi constant int := 12`; `UPDATE public.fascicolo_accessi_audit SET ip = NULL, user_agent = NULL
    WHERE creato_il < now() - make_interval(months => v_mesi) AND (ip IS NOT NULL OR user_agent IS NOT NULL)`;
    conteggio delle righe (`GET DIAGNOSTICS`); battito in `app_log` con fingerprint
    `cron:fascicolo-audit-ip-retention`, messaggio con i mesi letti da `v_mesi`, contesto con i soli
    conteggi (nessun IP, nessun uuid di persona);
  - `REVOKE`/`GRANT` come nel modello;
  - `cron.schedule('fascicolo-audit-ip-retention', '<un orario notturno libero, es. 17 4 * * *>', 'SELECT public.fascicolo_audit_ip_retention_tick()')`, idempotente;
  - commento di testata in italiano: decisione del titolare con la data, perché la riga resta, perché
    anche `user_agent`, perché una funzione SQL e non una route (nessun file nello Storage);
  - TUTTO idempotente (la migrazione può essere rilanciata dal workflow «DB migrate (CI)»);
  - nessun uuid di sede cablato (lock `migrazioni-senza-sede-cablata`).
- Modify: `src/lib/health/controlli.ts` — `{ nome: 'fascicolo-audit-ip-retention', finestraMs: 26 * ORA }`
  con un commento come le voci vicine (verifica come il controllo legge i battiti, per esempio dal
  fingerprint `cron:<nome>`, e che il nome combaci).
- Modify/Create test: un lock (nel file `informativa-conservazione-dichiarata.test.ts` o in uno nuovo
  in `__tests__/architecture/`, segui ciò che è più coerente) che verifichi: la funzione è definita
  da una migrazione; dichiara `v_mesi constant int := 12`; azzera `ip = NULL` e `user_agent = NULL`;
  NON cancella righe (nessun `DELETE FROM public.fascicolo_accessi_audit`); è schedulata con
  `cron.schedule('fascicolo-audit-ip-retention'`; e aggiungi il job a `BATTITI_DA_LEGGERE` se quel
  lock lo prevede per i lavori di scadenza. Controllo positivo: il lock fallirebbe su un SQL senza
  `user_agent = NULL`.
- Se esiste un test di `controlli.ts` che elenca i job attesi, aggiornalo.

**NON applicare la migrazione in produzione né sul DB della CI.** In produzione la applica
l'integrazione Supabase al merge (con la `version` del file: applicarla a mano farebbe due righe in
`schema_migrations`). Riporta nel rapporto l'SQL completo, così il coordinatore lo mostra al
titolare prima del merge.

**Verifiche:** i lock (`__tests__/architecture`), i test di health (`Grep "controlli" __tests__`),
eslint/tsc sui file TS toccati. Se riesci, verifica la sintassi SQL leggendo con attenzione il
modello (in locale non c'è Postgres: non provare a connetterti a nessun database).

**Commit:** «Registro degli accessi: gli IP si conservano un anno (decisione del titolare)».

---

### Task 11: PRD, gate intero, revisione, PR, rilascio

**Files:**
- Modify: `PRD REGISTRO ELETTRONICO.md` (in testa, e §2.1 «Anagrafica Alunno»)

- [ ] **Step 1: changelog in testa al PRD** — inserisci **prima** della riga 1:

```markdown
## 🪪 Changelog — Le insegnanti consultano l'anagrafica dei propri alunni, in sola lettura — 2026-10-04 (branch `feat/anagrafica-docente`)

**Stato.** 🟡 Sul branch, gate da eseguire (vedi in fondo). **Nessuna migrazione, nessun cambio di RLS.**

**La richiesta (04/10).** «Le insegnanti devono poter vedere le anagrafiche dei propri alunni, non modificarle, solo visionarle.» Fino a oggi un docente riceveva a pezzi, in route diverse, solo nome, allergie, note mediche, email dei genitori e delegati: una scheda per lui non esisteva.

**Le decisioni del titolare (04/10).**
1. **Scheda completa senza economia**: dati anagrafici, codice fiscale, nascita, cittadinanza, residenza, salute (allergie, note mediche, BES/DSA, pannolino), consensi, genitori con telefoni, email e codice fiscale, delegati al ritiro. **Mai**: retta, fatturazione, intestatari, sospensioni, documenti d'identità (file e numero), nascita e residenza dei genitori.
2. **Alla primaria la vedono tutti i docenti della classe**: assegnazione diretta (`utenti_sezioni`) **e** per materia (`utenti_sezioni_materie`), la stessa regola del fascicolo.
3. **Nuova voce «Alunni»** nel menu docente → elenco → scheda.
4. **Ricerca per nome e ricerca avanzata**: sezione e grado, salute (con allergie, allergene preciso, BES/DSA, pannolino), consensi foto (senza consenso sito/social), anno di nascita, sesso.

**Cosa c'è nel codice.**
- `GET /api/teacher/alunni` (elenco) e `GET /api/teacher/alunni/[id]` (scheda): **esportano solo `GET`**, e un test lo verifica. `requireDocente`, `zod`, `withRoute`, `Cache-Control: no-store`.
- `src/lib/anagrafiche/docente/`: `visibilita.ts` (una funzione sola decide elenco e scheda; un guasto di lettura è un **500 con log**, mai «nessuna sezione»), `colonne.ts` (colonne una per una, mai `*`), `proiezione.ts` (lista bianca campo per campo), `ritorno-elenco.ts`.
- Audit: ogni scheda aperta scrive una riga in `fascicolo_accessi_audit` (`azione: 'view'`, `finalita: 'anagrafica-docente'`), **dopo** i controlli e la lettura. Un 403 «fuori sezione» lascia un `warn` `anagrafica-fuori-sezione` con i soli uuid.
- Letture con `selectResiliente`: sul DB E2E della CI una colonna recente mancante diventa «Non indicato».
- Filtri: motore condiviso (`useFiltri` + `BarraFiltri`). Nuovo flag `maiNellUrl` sui campi: la ricerca per nome **non entra nell'indirizzo**, perché l'URL completo resta nella cronologia del browser e nei log di accesso a ogni ricarica (la cache del service worker usa solo il percorso).
- Lock nuovo `__tests__/architecture/assegnazioni-docente-coerenti.test.ts`: le tre funzioni «questa classe è tua» leggono le stesse due tabelle. Il commento di `fascicolo-rbac.ts` citava un lock che **non è mai esistito**.
- UI: `src/components/features/teacher/anagrafica/`, pagine `/teacher/alunni` e `/teacher/alunni/[id]`, nessun campo modificabile. Testi in `teacherServizi`/`teacherNav` (it/en), etichetta offline, tinta `alunni`.

**Dopo il deploy, in produzione (sola lettura).**

```sql
-- Le schede aperte dalle insegnanti: atteso > 0 dopo il primo uso vero.
SELECT count(*) FROM fascicolo_accessi_audit WHERE finalita = 'anagrafica-docente';
```

E `app_log` per `anagrafica-fuori-sezione` (tentativi su schede non proprie) e `anagrafica-sezioni-non-lette` (guasti di lettura delle assegnazioni: atteso 0).

```

- [ ] **Step 2: §2.1 del PRD** — cerca la riga `***Dati Didattici:** Profilo BES (Si/No), Storico valutazioni,` nel blocco `### 2.1 Anagrafica Alunno (StudentModel)` e, dopo il paragrafo che la contiene, aggiungi:

```markdown
***Consultazione da parte del docente (dal 2026-10-04):** sola lettura, da «Alunni» nel menu docente. La vedono i docenti assegnati alla classe direttamente o per materia; mai retta, fatturazione e documenti d'identità. Ogni apertura è registrata in `fascicolo_accessi_audit` (`finalita = 'anagrafica-docente'`).
```

- [ ] **Step 3: gate intero** (dalla radice del repo):

```bash
npx eslint . --max-warnings 0 2>&1 | tail -15
```
Expected: nessun output di errori.

```bash
npx tsc --noEmit 2>&1 | tail -15
```
Expected: nessun errore.

```bash
npx vitest run > /tmp/claude-vitest-anagrafica.log 2>&1; grep -E "Test Files|Tests " /tmp/claude-vitest-anagrafica.log
```
Expected: `Test Files  N passed (N)`, nessun `failed`. Un rosso in un file **non** toccato si indaga (rilancia quel file da solo: il job Unit ha già dato falsi rossi casuali, vedi memoria `ci_unit_job_instabile`), non si ignora.

```bash
npm run build 2>&1 | tail -20
```
Expected: build completata, le rotte `/teacher/alunni` e `/teacher/alunni/[id]` nell'elenco.

- [ ] **Step 4: commit del PRD**

```bash
git add "PRD REGISTRO ELETTRONICO.md"
git commit -m "PRD: anagrafica alunni in sola lettura per le insegnanti

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: revisione del codice** — skill `superpowers:requesting-code-review` sul diff `main...feat/anagrafica-docente`; i rilievi si valutano con `superpowers:receiving-code-review` e si correggono con test.

- [ ] **Step 6: PR** — `git push -u origin feat/anagrafica-docente`, poi `gh pr create` con titolo «Le insegnanti consultano l'anagrafica dei propri alunni (sola lettura)» e corpo: riassunto, decisioni del titolare, test, query di verifica post-deploy, `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Poi `ccd_pr get_status` / `bind_pr`.

- [ ] **Step 7: CI** — attendere **tutti** i job verdi (Unit, E2E, build). Un E2E rosso si legge dal punto d'arresto. Merge **a mano** (niente auto-merge).

- [ ] **Step 8: dopo il deploy** — verificare che Vercel abbia rilasciato `main`, eseguire la `SELECT` dello Step 1 (sola lettura), aggiornare lo **Stato** del changelog nel PRD con l'esito (in un branch nuovo, se serve), e cancellare i branch secondari locali e remoti.
```
