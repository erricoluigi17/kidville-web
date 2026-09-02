# Piano — «Lavora con noi»: via la Disponibilità, il curriculum diventa obbligatorio

**Data**: 2026-08-24 · **Autore**: scrittore-di-piani · **Perimetro**: modulo pubblico
`/lavora-con-noi` (`CandidaturaInsegnanteWizard`) + template `insegnanti-template.ts` + scheda
di segreteria delle candidature.

Due blocchi **indipendenti**, eseguiti **in quest'ordine da due esecutori diversi**:

- **BLOCCO A** — sparisce la domanda «Disponibilità» (rimozione secca).
- **BLOCCO B** — il curriculum diventa obbligatorio.

Il blocco B **non deve disfare niente** del blocco A. I punti in cui si toccano sono elencati
per esteso nella sezione «§ Punti di contatto», e vanno letti **prima** di cominciare B.

---

## 0. Quello che ho misurato prima di scrivere (non dedotto)

### 0.1 Il database di produzione — rimisurato il 2026-08-24

```sql
select count(*) as totali,
       count(*) filter (where disponibilita is not null)   as con_disponibilita,
       count(*) filter (where cv_path is null)             as senza_cv,
       count(*) filter (where copia_inviata_il is null)    as copia_mai_inviata,
       count(*) filter (where copia_inviata_il is null
                          and disponibilita is not null)   as arretrate_con_disponibilita
from candidature_insegnanti;
```

| | brief (misura precedente) | **misurato oggi** |
|---|---|---|
| righe totali | 228 | **230** |
| con `disponibilita` valorizzata | 219 | **221** |
| senza `cv_path` | 94 | **95** |
| `copia_inviata_il IS NULL` (coda dell'inoltro arretrato) | — | **0** |
| arretrate **con** disponibilità | — | **0** |

I numeri del brief erano di poche ore prima ed erano già cresciuti: **non ricopiarli**, e
non ricopiare nemmeno questi. La riga che conta per le decisioni qui sotto è l'ultima.

### 0.2 Il branch — ⚠️ IL PRIMO PROBLEMA DA RISOLVERE, PRIMA DI TOCCARE UN FILE

```
$ git rev-parse --abbrev-ref HEAD
main
```

Il brief dichiara `feat/candidature-cv-obbligatorio`; una delle quattro lenti aveva letto
`chore/registri-numerati-annullo`; **oggi la misura dice `main`**. Tre risposte diverse
significano che l'albero è condiviso e che qualcuno si è mosso nel frattempo.

**AGENTS.md punto 1 vieta di lavorare su `main`.** L'esecutore **non** fa `git checkout` (è
vietato in questa sessione): **segnala all'orchestratore** che il branch è `main` e aspetta
che sia lui a portare l'albero sul branch giusto. Se l'orchestratore conferma di volerci
lavorare comunque, la responsabilità del branch è sua e va scritta nel report.

### 0.3 Baseline dei test del perimetro — verde, e con l'esito catturato prima di ogni pipe

```bash
npx vitest run \
  __tests__/lib/insegnanti-template.test.ts \
  __tests__/components/CandidaturaInsegnanteWizard-riepilogo.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-posizioni.test.tsx \
  __tests__/components/CandidatureInsegnanti.test.tsx \
  __tests__/lib/email/candidatura-alla-sede.test.ts \
  > /tmp/base1.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; tail -8 /tmp/base1.txt
# ESITO=0 · Test Files 5 passed (5) · Tests 160 passed (160)

npx vitest run \
  __tests__/api/candidature-insegnanti-post.test.ts \
  __tests__/api/candidature-insegnanti-log-senza-pii.test.ts \
  __tests__/api/candidature-insegnanti-scope-sede.test.ts \
  __tests__/a11y/candidatura-insegnante-a11y.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-consensi.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-errore-invio.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-forma-visiva.test.tsx \
  > /tmp/base2.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; tail -8 /tmp/base2.txt
# ESITO=0 · Test Files 8 passed (8) · Tests 216 passed (216)
```

**Baseline del perimetro: 13 file, 376 test verdi.** Ogni volta che si rilancia una di queste
due righe si guarda **il numero dei test eseguiti**, non solo l'esito: `vitest -t 'nome-che-non-esiste'`
esce **0** senza eseguire niente, e un flag sbagliato (`--reporter=basic`) esce **1** senza
eseguire niente. Il conto è l'unica prova.

⚠️ `comando | tail; echo $?` **non verifica niente**: dopo una pipe `$?` è l'uscita di `tail`.
Le due righe qui sopra catturano `ESITO` **prima** della pipe, ed è il modello da usare sempre.

### 0.4 I campi del template sono 14, non 13

```
$ grep -c "^  { id: '" src/lib/forms/insegnanti-template.ts
14
```

Il commento a `src/app/api/iscrizione/insegnanti/route.ts:284` («Misurato sui **13** id … è
lungo **158** caratteri») **è già falso oggi**. Dopo il blocco A tornano 13 *per coincidenza*,
ma i 158 caratteri no. Vedi A-8.

---

## Cosa NON si tocca — in nessuno dei due blocchi

| Cosa | Perché |
|---|---|
| **La colonna `disponibilita` nel database** (`supabase/migrations/20260810094610_candidature_insegnanti.sql:41`) | 221 valori reali. **Nessuna migrazione, nessun `DROP COLUMN`, nessun `ALTER`.** Un DROP romperebbe anche `COLONNE_DETTAGLIO` (`42703` sul `GET ?id=` ⇒ scheda di segreteria in errore). |
| **La nullabilità di `cv_path` nel database** | 95 righe storiche con `cv_path IS NULL`. Un `NOT NULL` non si applicherebbe nemmeno. L'obbligatorietà è **applicativa**: template + client + server. |
| `__tests__/fixtures/candidature-schema-snapshot.json` | È la fotografia dello **schema del database**, non del template — protetta da `sha256`. 🔴 **QUESTA RIGA DICEVA IL FALSO, ed è stata corretta il 2026-08-25.** Diceva «25 colonne in tutto ⇒ la fotografia è già esatta ⇒ non toccare, non rigenerare»: le posizioni verificate erano giuste (`disponibilita` la **14**, `cv_path` la **16**), il TOTALE no. La misura era stata fatta **sulla fotografia stessa**, non contro la produzione, e da un controllo parziale si era concluso un «è esatta» pieno. Misurato contro il database il 2026-08-25: **26 colonne**. Mancava `copia_inviata_il`, aggiunta dalla migrazione `20260820141500` e mai fotografata — deriva nata il **2026-08-20**, non con questo lavoro, ma questo lavoro ci ha appoggiato sopra una difesa nuova (`COLONNE.has('disponibilita')`) dichiarandola verificata. **Rigenerata** (sola lettura sui cataloghi di sistema): 26 colonne, 7 check, enum invariato, `sha256` da `0c8acca9…` a `db7af055…`. La regola che resta: chi applica una migrazione su `candidature_insegnanti` rigenera la fotografia **nello stesso lavoro**, come aggiorna il PRD. |
| `CHIAVE_DISPONIBILITA` (`CandidatureInsegnanti.tsx:277-283`) e le **12 stringhe** i18n `candDisponibilita` + `candDisp*` (`messages/{it,en}/adminAltro.json:399-403, 412`) | Sono la strada con cui la segreteria legge le 221 candidature storiche. Cancellarle rimette in piedi il difetto corretto l'11/08/2026 (`tempo_pieno` con l'underscore a schermo). |
| `COLONNE_DETTAGLIO` (`src/app/api/admin/candidature-insegnanti/route.ts:294`), che contiene `disponibilita` e `cv_path` | È un elenco **scritto a mano**. Fino al 2026-08-25 nessun test lo guardava: togliendo `disponibilita` da lì la suite restava **tutta verde**. E la modifica di questo lavoro ha peggiorato il MODO in cui quell'anello si rompe: prima una proiezione mutilata faceva stampare «Disponibilità: Non indicato» su ogni scheda storica — un'anomalia visibile, che una segreteria segnala; col condizionale `{disponibilita && …}` la riga sparisce e basta, cioè prende **l'aspetto esatto del comportamento corretto** per le candidature nuove. ✅ **Chiuso il 2026-08-25** in `__tests__/api/candidature-insegnanti-scope-sede.test.ts`: (1) il dettaglio deve consegnare il VALORE (`body.data.disponibilita`), (2) la proiezione deve portare **ogni id di `INSEGNANTE_FIELDS`**, derivato e non ribattuto. Viste cadere entrambe, togliendo dalla proiezione prima `disponibilita` e poi `titolo_dettaglio`. |
| Il componente `Voce` (`CandidatureInsegnanti.tsx:1454-1465`) | **Misurato**: `Voce` **non** nasconde la riga vuota, stampa `t('candNonIndicato')`. La modifica va al **punto di chiamata** (riga 1742), mai dentro `Voce`, che è condiviso da una dozzina di altre voci dove «Non indicato» è informazione voluta. |
| Il debito delle **etichette non tradotte** del template (`insegnanti-template.ts:47-58`) | Dichiarato in testa al file. Si aggiorna solo l'elenco delle costanti citate (A-3), **non si apre il cantiere i18n**. |
| Il prestampato **`richiesta_disponibilita`** (modello 31, DPR 445, numerazione WORM) — `src/lib/prestampati/modelli/segreteria.ts`, `src/lib/prestampati/registro.ts`, `src/app/api/prestampati/banco.ts`, `messages/{it,en}/prestampatiSegreteria.json`, `docs/prestampati/31-richiesta-disponibilita.md`, e ~15 asserzioni in `__tests__/lib/prestampati-modelli-segreteria.test.ts` | **Omonimia.** Non c'entra niente col modulo delle candidature. **Vietato ogni find&replace su «disponibilit»**: il danno non si vedrebbe nel diff del modulo. |
| «disponibile / indisponibilità» come stato del **servizio** — `src/lib/auth/errore-accesso.ts`, `src/app/termini/page.tsx`, `CANDIDATURE_NON_DISPONIBILI` nell'E2E — e le disponibilità di **magazzino / credito / biometria / pagella / store** | Altre due famiglie di omonimi. Su ~100 occorrenze di «disponibilit» nel repo, **solo quelle elencate in A-0 riguardano questo campo**. |
| `src/app/privacy/page.tsx` | L'informativa non dichiara mai che il curriculum sia facoltativo (verificato riga per riga, 405-510). Zero modifiche. |
| `src/lib/email/messaggi/conferma-candidatura.ts` · `esito-candidatura.ts` | Nessuna delle due nomina la disponibilità né dichiara il CV facoltativo. Zero modifiche. |
| `src/lib/forms/validate-fields.ts` e `src/components/features/forms/FieldRenderer.tsx` (ramo `file`) | Vedi B-0: **funzionano già**. Aggiungere una seconda difesa è il difetto, non il rimedio. |
| I piani archiviati in `docs/superpowers/plans/` e le voci di **changelog datate** del PRD | Cronaca di rilasci avvenuti. Si aggiornano le **tabelle di stato**, non i changelog. |

---

## L'inventario dei punti da toccare — **derivato con grep, non dalla memoria**

```bash
grep -rn "disponibilita\|Disponibilità\|DISPONIBILITA" --include="*.ts" --include="*.tsx" \
  --include="*.json" src __tests__ e2e messages scripts \
  | grep -vi "richiesta_disponibilita\|non_disponibil\|indisponibil"
```

Se un elenco scritto a mano e questo grep divergono, **vince il grep**: rilancialo dopo ogni
passo. ⚠️ Se l'output finisce in un file e quel file dice «Output too large», l'elenco che ne
ricavi **non è l'elenco**: rilancia e conta.

---

# BLOCCO A — sparisce la domanda «Disponibilità»

**Decisione del titolare, non ridiscutibile**: rimozione **secca**. Niente riga informativa
sostitutiva, niente nota «le collaborazioni sono a tempo pieno». Il campo sparisce e basta.

**Decisione del titolare sullo storico**: nella scheda di segreteria la riga «Disponibilità»
continua a comparire **solo quando il valore c'è** (le 221 vecchie) e sparisce quando è NULL.

## A-0 · La forma del blocco, in una frase

C'è **un punto solo** da cui discende tutto — `insegnanti-template.ts:481` — e sei consumatori
che si adeguano da soli (wizard, riepilogo, validazione client, validazione server, INSERT,
email al plesso). Tutto il resto del blocco è: **una** modifica al componente admin (perché
`Voce` non nasconde), **una** riparazione di lock che altrimenti smette di difendere in
silenzio, e igiene di commenti e fixture.

## A-1 · (TEST PRIMA) L'asserzione POSITIVA che difende la rimozione

**Perché prima di tutto**: senza di essa, dopo la rimozione nessun test impedisce a
`disponibilita` di rientrare nel template. Il modello esiste già nello stesso file per `gradi`
(`__tests__/lib/insegnanti-template.test.ts:430-442`): si copia quello, non se ne inventa uno.

**File**: `__tests__/lib/insegnanti-template.test.ts`

1. Nel test **`it('titolo di studio e disponibilità sono select chiuse')`** (righe 286-295):
   - rinominare in **`it('il titolo di studio è una select chiusa')`** — il nome che resta
     mentirebbe;
   - **togliere le due righe 292-293** (`campo('disponibilita')?.type` e `options.length`);
   - **lasciare intatte** le quattro righe su `titolo_studio` (tipo, opzioni, `validateField`
     che respinge un valore inventato e accetta quello buono): non sono replicate altrove, e
     cancellare l'intero `it()` le porterebbe via.
2. **Aggiungere** un test nuovo, subito dopo, sul modello di quello di `gradi`:

```
it('il campo `disponibilita` è USCITO dal modulo, mentre la colonna `disponibilita` è rimasta', () => {
  expect(campo('disponibilita'), 'la domanda sulla disponibilità è tornata nel modulo: ' +
    'in Kidville si lavora solo a tempo pieno, chiederlo è chiedere una cosa già decisa').toBeUndefined()
  expect(
    INSEGNANTE_FIELDS.filter((f) => String(f.db_mapping).endsWith('.disponibilita')).map((f) => f.id),
    'un campo del modulo punta di nuovo alla colonna `disponibilita`',
  ).toEqual([])
  expect(COLONNE.has('disponibilita'), `la colonna \`disponibilita\` non c'è più. ${COME_RIGENERARE}`).toBe(true)
})
```

**Prova del rosso**: lanciare **prima** di toccare `insegnanti-template.ts`.

```bash
npx vitest run __tests__/lib/insegnanti-template.test.ts > /tmp/a1.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; grep -n "disponibilit" /tmp/a1.txt | head
```

Atteso: **ESITO=1**, e il fallimento è **solo** il test nuovo, con il messaggio «la domanda
sulla disponibilità è tornata nel modulo…» (`campo('disponibilita')` è ancora definito). La
terza riga (`COLONNE.has`) deve essere **verde già adesso**: se è rossa, qualcuno ha toccato
la fotografia dello schema — fermarsi e segnalarlo.

## A-2 · Rimuovere il campo e la sua costante — **insieme, mai una sola delle due**

**File**: `src/lib/forms/insegnanti-template.ts`

- **riga 481**: cancellare l'intera riga `{ id: 'disponibilita', … options: DISPONIBILITA },`;
- **righe 322-329**: cancellare il commento `/** Disponibilità dichiarata… */` **e** la
  costante `const DISPONIBILITA: FormFieldOption[] = [ … ]`.

⚠️ **La trappola che fa cadere il gate per prima, e per una ragione che sembra non c'entrare.**
`DISPONIBILITA` è un `const` **non esportato** (verificato con grep su `src`, `__tests__`,
`e2e`, `scripts`: nessun `import`, solo tre commenti che la nominano). Lasciandola dopo aver
tolto il campo resta una variabile non usata: `eslint-config-next/typescript` accende
`@typescript-eslint/no-unused-vars` come **warning**, e il gate del progetto è
`npx eslint . --max-warnings 0` ⇒ **ROSSO**. `npx tsc --noEmit` da solo **non lo vede**.
All'opposto, togliere la costante lasciando il campo è errore di compilazione.

⚠️ **`FormFieldOption` resta importato**: lo usano ancora `TITOLI_STUDIO` e `POSIZIONI_OPTIONS`.
Non togliere l'import.

**Verifica**:

```bash
npx vitest run __tests__/lib/insegnanti-template.test.ts > /tmp/a2.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; tail -6 /tmp/a2.txt
npx eslint src/lib/forms/insegnanti-template.ts --max-warnings 0; echo "ESLINT=$?"
```

Atteso: **ESITO=0** e **ESLINT=0**. Se ESLINT=1 con `no-unused-vars`, la costante è ancora lì.

## A-3 · I tre commenti che nominano `DISPONIBILITA` e diventerebbero falsi

Elenco **derivato** (`grep -rn "DISPONIBILITA" --include="*.ts" --include="*.tsx" src __tests__ e2e scripts | grep -v CHIAVE_`):

1. `src/lib/forms/insegnanti-template.ts:50` — «`TITOLI_STUDIO`, `DISPONIBILITA`,
   `POSIZIONI_OPTIONS`»: togliere `DISPONIBILITA` dall'elenco. **Non toccare il resto del
   blocco**: è il debito i18n dichiarato, e resta vero.
2. `src/components/features/public/CandidaturaInsegnanteWizard.tsx:162` — «i sette
   `TITOLI_STUDIO`, le **cinque `DISPONIBILITA`** e le sette `POSIZIONI_OPTIONS`»: togliere
   l'inciso sulle cinque disponibilità.
3. `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx:247-260` — il commento
   dice due cose che diventano **false**: che le etichette vengano da `DISPONIBILITA` in
   `insegnanti-template.ts` (la costante non esiste più) e che «il lock in coda al test
   verifica che ogni valore dell'enum abbia la sua chiave» (dopo A-6 il lock guarda il
   **template**, che non espone più quell'enum). Riscriverlo dicendo:
   - che la **domanda non si fa più** dal 2026-08-24;
   - che `CHIAVE_DISPONIBILITA` serve alle **221 candidature storiche** e per questo resta;
   - **chi la difende adesso**: il lock di `CandidatureInsegnanti.test.tsx` la importa da qui
     (vedi A-6), quindi cancellarla fa rosso.

⚠️ Un commento che promette una sorveglianza che non c'è più è **peggio** di nessun commento:
chi legge crede che togliere una chiave `candDisp*` faccia rosso, e non lo fa.

**Da NON toccare**: `CandidaturaInsegnanteWizard.tsx:105-110`, che racconta al **passato** il
difetto del riepilogo dell'11/08 e nomina la disponibilità fra i campi che allora mancavano.
Era vero allora. Riscriverlo cancellerebbe la ragione per cui il riepilogo completo esiste.

## A-4 · (TEST PRIMA) La scheda di segreteria: la riga compare solo se il valore c'è

**File del test**: `__tests__/components/CandidatureInsegnanti.test.tsx`

Nel test **`it('un titolo FUORI enum resta grezzo invece di sparire')`** (righe 1580-1591) la
fixture forza già `disponibilita: null`. Oggi l'asserzione è
`expect(screen.getAllByText('Non indicato').length).toBeGreaterThan(0)` col commento «E la
disponibilità vuota resta un dato mancante, non un errore».

⚠️ **TEST CHE PASSEREBBE PER IL MOTIVO SBAGLIATO.** Quell'asserzione resta verde comunque,
perché nella fixture `DETTAGLIO` anche `note` è assente e la riga «Presentazione»
(`CandidatureInsegnanti.tsx:1791-1793`) stampa già «Non indicato». Il conteggio `> 0` non
distingue le due sorgenti: **senza una nuova asserzione, la decisione del titolare non è
difesa da nessun test.**

Fare due cose:

1. **correggere il commento** (diventa falso);
2. **aggiungere** l'asserzione specifica, che nomina l'etichetta invece di contare i «Non
   indicato»:

```
// Dal 2026-08-24 la domanda non si fa più: sulle candidature che il valore non ce
// l'hanno la riga non compare affatto. «Disponibilità: Non indicato» accuserebbe chi
// si è candidato di un'omissione su una domanda che non gli è mai stata fatta — lo
// stesso difetto che il commento delle fasce, venti righe sotto, esiste per evitare.
expect(screen.queryByText(itAdminAltro.candDisponibilita)).not.toBeInTheDocument()
```

E **lasciare intatto** il test gemello `it('titolo di studio e disponibilità si leggono come
ETICHETTE, mai come valori di database')` (righe 1566-1578), che sulla fixture `DETTAGLIO`
(`disponibilita: 'tempo_pieno'`, riga 167) pretende `getByText('Tempo pieno')`: **è l'unico
test che difende la resa delle 221 storiche**. Proteggerlo, non ammorbidirlo.

**Prova del rosso**:

```bash
npx vitest run __tests__/components/CandidatureInsegnanti.test.tsx -t 'un titolo FUORI enum' > /tmp/a4.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; grep -c "✓\|×" /tmp/a4.txt
```

Atteso: **ESITO=1**, **1 test eseguito**, e il fallimento è che «Disponibilità» **è** nel
documento. ⚠️ Se i test eseguiti sono **0**, il filtro `-t` non ha agganciato niente e
`vitest` esce **0**: è un controllo che approva tutto. Correggi il filtro, non il codice.

## A-5 · La riga condizionale nella scheda di segreteria

**File**: `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx`, **riga 1742**.

Da:

```
<Voce etichetta={t('candDisponibilita')} valore={disponibilita} />
```

a un render condizionale sul modello **già presente nello stesso file 24 righe sotto**
(righe 1764-1768, `{cand.posizione_altro && (…)}`) — si copia quel pattern, non se ne inventa
uno:

```
{/* Dal 2026-08-24 la domanda non si fa più: la riga esiste solo per le candidature
    che quel valore ce l'hanno in tabella (221 al 2026-08-24). `Voce` non nasconde una
    riga vuota — stampa «Non indicato» — quindi il condizionale sta QUI e non dentro
    di lei, che serve a una dozzina di altre voci dove «Non indicato» è informazione. */}
{disponibilita && <Voce etichetta={t('candDisponibilita')} valore={disponibilita} />}
```

**Perché il predicato è già quello giusto**: `daCatalogo` (righe 618-624) restituisce **`null`**
su stringa vuota o fatta di soli spazi, e la prop è tipata `string | null` (riga 1490). Il
valore arriva da `daCatalogo(CHIAVE_DISPONIBILITA, selezionata.disponibilita)` (riga 1302).

**Non toccare**: `Voce`, `daCatalogo`, `CHIAVE_DISPONIBILITA`, `Candidatura.disponibilita`
(riga 160), la prop e il suo tipo (1469, 1490), `COLONNE_DETTAGLIO` nella route admin.

⚠️ **Effetto cosmetico atteso, da dichiarare nel report** perché il tester-design lo vedrà e
non è un guasto: la griglia del blocco «Profilo» (riga 1738, `grid-cols-1 sm:grid-cols-2`)
passa da 4 a 3 voci sulle candidature nuove, e su ≥`sm` l'ultima riga resta spaiata.

**Verifica**: il test di A-4 diventa **verde**, e il test delle 221 storiche (1566-1578) **resta
verde**. Se il secondo diventa rosso, il condizionale è stato scritto al contrario.

## A-6 · ⚠️ IL LOCK CHE SI SPEGNE DA SOLO — il punto più costoso del blocco

**File**: `__tests__/components/CandidatureInsegnanti.test.tsx`, righe **1622-1682**.

Il lock **`it('ogni valore dei TRE enum del modulo ha la sua etichetta in italiano e in
inglese')`** deriva il perimetro **dal template**:

```
const opzioni = (id) => (INSEGNANTE_FIELDS.find((f) => f.id === id)?.options ?? []).map(...)
…
expect(valori.length, 'il template non espone più le opzioni: il lock non guarda niente').toBe(20)
```

Tolto il campo, `opzioni('disponibilita')` torna `[]`, il conteggio scende a **15** (8 titoli +
7 posizioni) e il test va **rosso con un messaggio che manda fuori strada**: accusa il template
di non esporre più le opzioni, mentre il fatto è che un enum è stato tolto di proposito.
È **l'unico conteggio scritto a mano di tutto il perimetro**.

⚠️ **La correzione istintiva è la trappola.** Cancellare il blocco `attese.disponibilita` e
scrivere `15` riporta il verde **e spegne l'unica sorveglianza** sulle cinque chiavi
`candDispTempoPieno` … `candDispTirocinio` in **italiano e inglese**. Nessun altro lock le
copre: `messaggi-chiavi-orfane.test.ts` ha sotto tutela **solo** il namespace
`adminModulistica` (verificato: `SOTTO_TUTELA` è una `Map` con una sola voce), e
`messaggi-parita-cataloghi.test.ts` guarda namespace, chiavi e non-vuoto — **non l'uso**.
Basta che qualcuno tolga una di quelle chiavi da `en/adminAltro.json` e la segreteria torna a
leggere `tempo_pieno` con l'underscore sulle 221 storiche: il difetto corretto l'11/08/2026,
rimesso in piedi.

**Il rimedio: due controlli, due fonti — e la seconda fonte è il codice che le USA.**

1. In `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx`, **esportare**
   `CHIAVE_DISPONIBILITA` (riga 277: `const` → `export const`), con una riga di commento che
   dica **perché** è esportata: «la esporta il lock dei cataloghi, che dopo il 2026-08-24 non
   può più leggere queste cinque voci dal template — cancellarla fa rosso quel test».
2. Nel test:
   - rinominare in **`it('ogni valore dei DUE enum del modulo — e le cinque etichette storiche — ha la sua etichetta in italiano e in inglese')`**;
   - aggiornare il commento delle righe 1622-1633 («Dal 2026-08-15 gli enum sono TRE» →
     dire che dal 2026-08-24 sono **due**, e che le cinque voci della disponibilità
     sopravvivono al campo perché sopravvivono i **dati**);
   - togliere il blocco `attese.disponibilita` (righe 1648-1654) e portare `toBe(20)` a
     **`toBe(15)`**, aggiornando il messaggio d'errore;
   - **aggiungere**, nello stesso `it`, il secondo controllo:

```
// ── LE CINQUE ETICHETTE STORICHE, e la loro fonte NON è più il template ────
// Il campo «Disponibilità» è uscito dal modulo il 2026-08-24 (in Kidville si
// lavora solo a tempo pieno). Le 221 candidature che quel valore ce l'hanno in
// tabella continuano però a leggersi in segreteria, e queste cinque chiavi sono
// ciò che le traduce. La fonte è la mappa che le RISOLVE — non un elenco
// ribattuto qui, che divergerebbe dalla mappa senza che nulla lo dica.
expect(INSEGNANTE_FIELDS.find((f) => f.id === 'disponibilita'),
  'il campo è tornato nel template: le cinque voci vanno rimesse fra gli enum derivati',
).toBeUndefined()
expect(Object.keys(CHIAVE_DISPONIBILITA)).toHaveLength(5)
for (const [valore, chiave] of Object.entries(CHIAVE_DISPONIBILITA)) {
  expect(itAdminAltro, `it/adminAltro.json → ${chiave} (valore storico «${valore}»)`).toHaveProperty(chiave)
  expect(enAdminAltro, `en/adminAltro.json → ${chiave} (valore storico «${valore}»)`).toHaveProperty(chiave)
}
expect(itAdminAltro).toHaveProperty('candDisponibilita')
expect(enAdminAltro).toHaveProperty('candDisponibilita')
```

**Prova che il lock difende ancora davvero** (obbligatoria — *un test mai visto fallire non è
un test*): a modifica finita, **rompere apposta** e guardare che diventi rosso.

```bash
# 1) togliere una chiave dal catalogo INGLESE
python3 - <<'PY'
import json,io
p='messages/en/adminAltro.json'
d=json.load(open(p)); d.pop('candDispSupplenze'); json.dump(d,open(p,'w'),ensure_ascii=False,indent=2)
PY
npx vitest run __tests__/components/CandidatureInsegnanti.test.tsx > /tmp/a6.txt 2>&1; ESITO=$?; echo "ROTTO_ESITO=$ESITO"   # atteso 1
git checkout -- messages/en/adminAltro.json   # ⚠️ SOLO questo file, e SOLO se l'orchestratore lo consente
```

⚠️ `git checkout` è **vietato** in questa sessione. Alternativa senza git: **riscrivere a mano**
la chiave tolta (o fare la prova su una **copia** del catalogo in `/tmp` e non sul file vero).
Se non si può fare in sicurezza, la prova alternativa è: **commentare temporaneamente** una
riga di `CHIAVE_DISPONIBILITA`, lanciare (atteso ROSSO su `toHaveLength(5)`), rimetterla.
**Non saltare questa prova**: è l'unica cosa che distingue un lock da un commento.

## A-7 · I test che dopo la rimozione diventano rossi, e quelli che diventano **inaffondabili**

### A-7a · `__tests__/components/CandidaturaInsegnanteWizard-riepilogo.test.tsx` — tre rotture

⚠️ **Il file cade con ECCEZIONI, non con differenze di asserzione**: `campo(id)` (righe 106-111)
fa `throw new Error("campo «…» assente dal template")` e `screen.getByLabelText(/Disponibilità/)`
**lancia** quando non trova. `compilaTutto()` è chiamata da **11 test**: cade l'intero file, e
lo stack si legge come un guasto del wizard.

1. **righe 203-205** — togliere il blocco
   `if (!vuoti.includes('disponibilita')) { fireEvent.change(screen.getByLabelText(/Disponibilità/), …) }`.
2. **riga 331** — togliere `expect(sotto(String(campo('disponibilita').label))).toBe('Part-time mattina')`.
   Le righe gemelle su `titolo_studio` (che provano la stessa regola: si legge l'etichetta,
   non l'enum) **restano** e reggono il test da sole.
3. **riga 343** — togliere `'disponibilita'` dall'elenco `vuoti`. ⚠️ **In questo blocco
   `'cv_path'` RESTA** (è ancora facoltativo): lo toglie il blocco B. La riga 351
   (`toHaveLength(vuoti.length)`) è **derivata dalla lista** — verificato — quindi si
   riallinea da sé; ma proprio per questo un errore nella lista **non si vede**: ricontare a
   mano gli id rimasti (**7** dopo A, **6** dopo B).
4. **Non toccare**: la testata (riga 20, cronaca datata) e `const attesi =
   INSEGNANTE_FIELDS.filter((f) => !f.condition)` (righe 257-262) — è il pezzo che fa sparire
   la riga «Disponibilità» dal riepilogo **da solo**.

### A-7b · `__tests__/lib/email/candidatura-alla-sede.test.ts` — un rosso e un verde bugiardo

- **righe 68-69** (dentro `it('traduce i valori in codice nelle etichette leggibili del modulo')`):
  `expect(t).toContain('Tempo pieno')` va **rosso** (la riga non si stampa più).
  **Togliere entrambe** le righe (`toContain('Tempo pieno')` e `not.toContain('tempo_pieno')`):
  lasciare la seconda da sola sarebbe una guardia che non guarda niente. Restano le coppie su
  `laurea_magistrale` e `insegnante_infanzia`, che provano la stessa regola.
- **riga 38** — togliere `disponibilita: 'tempo_pieno'` dalla fixture `DATI`: diventa dato
  morto che nessuna asserzione tocca più (il test 74-82 itera il template e la salta).
- **riga 139** — ⚠️ **IL VERDE BUGIARDO.** `expect(scarno.testo).not.toContain('Disponibilità')`
  dopo la rimozione **non può più fallire in nessun caso**: smette di provare la regola
  dell'omissione, che è metà dello scopo del test. **Sostituire** con un'etichetta di un campo
  che esiste ancora e che nel caso `scarno` non è compilato — la fixture scarna è
  `{ nome, cognome, email, posizioni }`, quindi va bene
  **`expect(scarno.testo).not.toContain('Dettaglio del titolo')`** (oppure `'Comune di
  residenza'`). La riga gemella `not.toContain('Anni di esperienza')` resta ed è quella che
  regge il test.

**Prova che la sostituzione difende ancora**: aggiungere temporaneamente
`titolo_dettaglio: 'x'` alla fixture `scarno` e verificare che il test diventi **rosso**, poi
toglierlo. Se resta verde, hai scelto un'etichetta che non compare mai.

### A-7c · Igiene delle fixture — niente rosso, ma dati morti che raccontano il falso

- `__tests__/api/candidature-insegnanti-post.test.ts:389` — togliere `disponibilita: 'tempo_pieno'`
  dalla fixture `candidatura()`. Nessun rosso (`postBodySchema.data` è `.loose()`, la chiave
  viene accettata e ignorata), ma lasciata lì dice a chi legge che il modulo la chiede ancora.
- `__tests__/api/candidature-insegnanti-log-senza-pii.test.ts:178` — idem, dalla fixture
  `candidatura()`.
- `__tests__/api/candidature-insegnanti-log-senza-pii.test.ts:404` — togliere
  `disponibilita: 'quando-capita'`, che era **inserita apposta** fra i valori non validi.
  ⚠️ **Il test resta verde ma misura una cosa diversa**: quel valore smette di produrre un
  campo non valido (chiave sconosciuta, scartata da `.loose()`) e il conteggio cala di uno,
  mentre l'asserzione è `toBeGreaterThanOrEqual(6)` — **un test che approva più di quanto
  misuri**. Vedi A-8 per il conto esatto.

### A-7d · Quello che **resta verde e resta utile** — non toccarlo «per coerenza»

| File | Perché resta |
|---|---|
| `__tests__/api/candidature-insegnanti-scope-sede.test.ts:199` (`disponibilita: 'tempo_pieno'` nella fixture di **database**) e `:263` (il ciclo che pretende `undefined` **nell'elenco**) | La rotta admin legge dal DB, non dal template. Sono l'unica copertura della **metà storica** del blocco A: provano che la scheda continua a leggere la colonna e che l'elenco povero non la espone. La colonna esiste ancora ⇒ il controllo conserva il suo senso. |
| `__tests__/api/candidature-insegnanti-post.test.ts:1324` (`message: 'column "disponibilita" of relation "x" does not exist'`) | È il testo di un errore **finto** per il ramo `42703`, senza nessun legame col template. Lasciarlo. |
| `__tests__/lib/insegnanti-template.test.ts:164-182` («ogni id del template è una colonna vera») | Il controllo va **solo** template→schema, mai schema→template: un campo in meno non lo scalfisce. |
| `__tests__/lib/insegnanti-template.test.ts:197-230` (l'ordine dei campi **non** è quello delle colonne) | **Verificato per calcolo** sullo snapshot: gli ordinali passano da `[4,5,6,7,8,9,24,25,11,12,13,14,15,16]` a `[4,5,6,7,8,9,24,25,11,12,13,15,16]` — restano **non** ordinati, perché `posizioni`(24) e `posizione_altro`(25) precedono `titolo_studio`(11). Zero interventi. ⚠️ Non «difendere» `COLONNE.get(f.id)!` con un `?.`: si indebolirebbe un lock che funziona. |
| `__tests__/components/CandidaturaInsegnanteWizard-posizioni.test.tsx:507-560` (censimento «ogni campo del template è reso») | Deriva tutto dal template: si restringe da solo. È il modello a cui A-6 conforma il lock dei cataloghi. |
| `e2e/public-candidatura-insegnante.spec.ts` | Il percorso non tocca mai la disponibilità. Zero modifiche **in questo blocco** (ne ha una in B). |
| `src/app/api/iscrizione/insegnanti/route.ts:349, 368-401, 669` | `costruisciRiga` e `validatePage(campiVisibili(...))` iterano il template: si adeguano da soli. **Verificato in produzione**: `candidature_insegnanti.disponibilita` è `is_nullable = YES` con `column_default` nullo ⇒ l'omissione scrive NULL. **Nessuna migrazione, nessun `PGRST204`, nessun `42703`.** ⚠️ Un client con cache vecchia che continua a mandare `disponibilita: 'tempo_pieno'` **non** prende un 400: il valore viene scartato in silenzio da `.loose()`. È il comportamento voluto. |
| `src/lib/email/messaggi/candidatura-alla-sede.ts` | `righeDellaCopia` itera il template: la riga sparisce da sé. Vedi A-9. |
| `src/components/features/public/CandidaturaInsegnanteWizard.tsx:236-243` (`IDS_DATI`/`CAMPI_PROFILO`) | `CAMPI_PROFILO` si costruisce **per esclusione** da `INSEGNANTE_FIELDS` e `disponibilita` non è mai nominato: rendering, riepilogo e validazione del passo si adeguano da soli. Chi cerca «gli altri posti da toccare» nel wizard non trova niente, ed è giusto così. |
| `messages/{it,en}/public.json` | Non contengono nessuna chiave per la disponibilità (l'etichetta è cablata nel template). ⚠️ Chi cercasse una chiave da togliere «per parità» non la trova e rischierebbe di portare via quelle di `adminAltro`, che invece servono. |

## A-8 · Il commento che conta i campi — è **già falso oggi**, e va rifatto, non fatto coincidere

**File**: `src/app/api/iscrizione/insegnanti/route.ts:278-292`.

Dice: «Misurato sui **13** id di `INSEGNANTE_FIELDS`: `campi-non-validi-` più tutti gli id
ordinati è lungo **158** caratteri, e già con **sei** campi non validi si arriva a 78».
Misurati adesso i campi sono **14** (`grep -c "^  { id: '"`), e la concatenazione completa è
**179** caratteri, non 158. Dopo il blocco A i campi tornano 13 **per coincidenza**, ma la
lunghezza diventa **165**.

Il repo ha già pagato due volte per «un commento che conta cose mente entro un rilascio» — è
scritto testualmente in `insegnanti-template.ts`. **Togliere i due numeri**, non aggiornarli:
il ragionamento (l'elenco completo supera largamente il tetto di 64 caratteri di
`FORMA_ENUMERATO`, quindi il troncamento serve e il prefisso va garantito per costruzione)
resta valido senza cifre, e **la misura vera la fa il test**
(`candidature-insegnanti-log-senza-pii.test.ts`, `expect(String(avviso?.campi.esito).length).toBeLessThanOrEqual(64)`).
Rimandare a quel test nel commento. `ESITO_MAX = 64` **non cambia**.

**Conto verificato del caso «modulo quasi vuoto»** (`log-senza-pii.test.ts:394-415`), che
serve a sapere che l'asserzione `>= 6` **non morde**:

- oggi i campi respinti sono **8**: `nome`, `cognome`, `email`, `titolo_studio` (obbligatori
  vuoti) + `residence_province: 'XY'`, `residence_city` di 101 caratteri, `anni_esperienza: 999`,
  `disponibilita: 'quando-capita'`;
- dopo il **blocco A** ne esce uno (`disponibilita`) ⇒ **7**;
- dopo il **blocco B** ne entra uno (`cv_path` obbligatorio e vuoto, perché
  `const vuoti = Object.fromEntries(INSEGNANTE_FIELDS.map((f) => [f.id, '']))` lo include
  automaticamente) ⇒ **8**. Netto zero.

⚠️ Ma **l'elenco che finisce nel log cambia**, ed è la parte che va guardata a occhio invece
che fidandosi del `>=`. `esitoConElenco` **ordina alfabeticamente** e taglia a 64 caratteri
prenotando il marcatore `+N`:

| | esito registrato | lunghezza |
|---|---|---|
| oggi | `campi-non-validi-anni_esperienza.cognome.disponibilita.email+4` | 61 |
| dopo A+B | `campi-non-validi-anni_esperienza.cognome.cv_path.email.nome+3` | 60 |

Entrambi ≤ 64 ⇒ l'asserzione resta verde, **e `cv_path` compare fra gli id**: è la prova che
il rifiuto nuovo è **classificato** e non finisce in `[redatto:str/N]`. **Guardare l'esito
stampato**, non solo il verde.

## A-9 · La coda silenziosa sullo storico — **decisa con una misura, non subìta**

Due file costruiscono liste di colonne **derivandole dal template**:

- `src/app/api/admin/candidature-insegnanti/inoltro-arretrato/route.ts:92`
  (`const COLONNE_MODULO = INSEGNANTE_FIELDS.map((f) => f.id).join(', ')`, usato nella `.select()`
  di riga 152) e **riga 201** (`for (const f of INSEGNANTE_FIELDS) dati[f.id] = r[f.id]`);
- `src/lib/email/messaggi/candidatura-alla-sede.ts:99-107` (`righeDellaCopia`).

Tolto il campo dal template, la rotta di **re-inoltro ai plessi** smette di **leggere** la
colonna e l'email smette di **stampare** la riga «Disponibilità: Tempo pieno» — anche per le
candidature vecchie che quel valore ce l'hanno. **Nessun test diventa rosso.** È il tipo di
perdita che si scopre leggendo un'email.

**DECISIONE, presa sulla misura:** **si accetta, e non si tocca niente.**

```
copia_mai_inviata = 0        arretrate_con_disponibilita = 0     (2026-08-24)
```

La coda dell'inoltro arretrato è **vuota**: la rotta lavora **solo** su righe con
`copia_inviata_il IS NULL`, e ogni riga che ci entrerà da domani avrà `disponibilita` NULL per
costruzione. La perdita è quindi **esattamente zero**, adesso e in avanti. La memoria di
progetto parlava di «1 candidatura mai recapitata» al 2026-08-20: **oggi non c'è più**.

Aggiungere `disponibilita` a mano alla `select` **non basterebbe** comunque: l'email itera il
template, quindi servirebbe anche un caso speciale fuori dal ciclo in `candidatura-alla-sede.ts`
— cioè una **seconda regola** che vive fuori dalla derivazione, che nessun test difenderebbe,
per zero righe.

**Cosa fare invece** (una riga di commento, sopra `COLONNE_MODULO` in `inoltro-arretrato/route.ts:92`):

```
// ⚠️ Le colonne del modulo si DERIVANO dal template: un campo tolto di lì sparisce
// anche da questa lettura e dalla copia email, comprese le candidature storiche che
// quel valore ce l'hanno in tabella. Il 2026-08-24, togliendo «Disponibilità», la
// perdita è stata MISURATA prima di accettarla: `copia_inviata_il IS NULL` = 0 righe,
// e ogni riga futura di questa coda nascerà senza quel campo. Chi toglierà il
// prossimo campo rifaccia il conto invece di fidarsi di questa riga.
```

⚠️ **L'unico caso che riaprirebbe la questione** è un `UPDATE` manuale che riporti
`copia_inviata_il` a NULL su una candidatura storica per re-inoltrarla. Chi lo facesse deve
sapere che quella copia arriverà **senza** la riga «Disponibilità» — il dato resta comunque
leggibile in segreteria, che è la superficie su cui si decide.

`__tests__/api/candidature-inoltro-arretrato.test.ts` **non si tocca**: `curriculumNonPrevisto`
e `senza_curriculum` riguardano il CV, non la disponibilità.

## A-10 · Il PRD (parte della definizione di «fatto», AGENTS.md punto 2)

**File**: `PRD REGISTRO ELETTRONICO.md`.

- **riga 4429** — la riga «Facoltativi» elenca `disponibilità`: **toglierla**.
  ⚠️ Sulla **riga 4428**, che si tocca comunque in B, gli «Obbligatori» elencano ancora
  «**fasce d'età** (`gradi`, multi-valore)», sparite dal modulo il **15/08/2026**. È una bugia
  **preesistente**, non introdotta da questo lavoro: correggerla **nello stesso passaggio**
  (gli obbligatori veri sono nome, cognome, email, **posizioni**, titolo di studio) e dirlo nel
  changelog, invece di scriverci accanto un'altra modifica.
- **riga 78** (tabella di stato «Lavora con noi»): la voce descrive lo stato **corrente** del
  modulo. Non nomina la disponibilità, quindi in questo blocco **non cambia**; la tocca B.
- **riga 35** (tabella di stato `candidature_insegnanti`): descrive la tabella, che **non
  cambia**. Zero modifiche.
- **NON toccare** il changelog datato 2026-08-10 in cui la riga 4429 vive: era vero allora.
  Si **aggiunge** una voce di changelog nuova, datata — vedi la sezione «§ Changelog» in fondo,
  che vale per entrambi i blocchi.

## A-11 · Gate del blocco A

```bash
npx eslint . --max-warnings 0;                     echo "ESLINT=$?"    # atteso 0
npx tsc --noEmit;                                  echo "TSC=$?"       # atteso 0
npx vitest run > /tmp/a-vitest.txt 2>&1; ESITO=$?; echo "VITEST=$ESITO"; tail -6 /tmp/a-vitest.txt
npm run build > /tmp/a-build.txt 2>&1;  ESITO=$?; echo "BUILD=$ESITO"; tail -6 /tmp/a-build.txt
```

Tutti a **0**, e il numero di test eseguiti **non deve essere calato** rispetto al totale della
suite prima del blocco (i test tolti sono righe dentro `it()` esistenti, non `it()` interi;
l'unico `it()` **aggiunto** è quello di A-1).

**Criteri di accettazione verificabili del blocco A**

| # | Comando | Esito atteso |
|---|---|---|
| A.a | `grep -rn "disponibilita" src/lib/forms/insegnanti-template.ts` | **nessuna riga** |
| A.b | `grep -rn "DISPONIBILITA" --include="*.ts" --include="*.tsx" src \| grep -v CHIAVE_DISPONIBILITA` | **nessuna riga** (i tre commenti sono stati aggiornati) |
| A.c | `grep -c "^  { id: '" src/lib/forms/insegnanti-template.ts` | **13** |
| A.d | `grep -n "CHIAVE_DISPONIBILITA" src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx` | presente, ed **esportata** |
| A.e | `grep -n "candDisp" messages/it/adminAltro.json messages/en/adminAltro.json \| wc -l` | **10** (5 chiavi × 2 lingue), invariato |
| A.f | `npx vitest run __tests__/lib/insegnanti-template.test.ts` | 0, e il test «il campo `disponibilita` è USCITO dal modulo…» **eseguito e verde** |
| A.g | `npx vitest run __tests__/components/CandidatureInsegnanti.test.tsx` | 0, con `toBe(15)` e le 5 chiavi verificate da `CHIAVE_DISPONIBILITA` |
| A.h | prova del rosso di A-6 (chiave i18n rimossa a mano) | **1** |
| A.i | `mcp__supabase__execute_sql`: `select count(*) filter (where disponibilita is not null) from candidature_insegnanti;` | **≥ 221** — la colonna e i suoi dati sono intatti |
| A.j | apertura di `http://localhost:3100/lavora-con-noi`, passo «Il tuo profilo» | **nessun** campo «Disponibilità», **nessuna** riga informativa sostitutiva. ⚠️ **Non premere «Invia»**, non caricare file. |

---

# BLOCCO B — il curriculum diventa obbligatorio

## B-0 · ⚠️ LEGGERE PRIMA DI SCRIVERE: **una riga fa tutto il lavoro**

**Misurato lungo tutta la catena.** `required: true` sul template basta **sia sul client sia
sul server**. Non serve toccare `FileField`, non serve una regola nuova, non serve un asterisco
a mano, non serve un gate nella route.

| Anello | Dove | Cosa fa già |
|---|---|---|
| regola client | `FieldRenderer.tsx:509-511` | `const rules = { validate: (value) => validateField(field, value) ?? true }` |
| applicata al campo file | `FieldRenderer.tsx:695-700` | `<Controller name={field.id} rules={rules} defaultValue="">` sul ramo `field.type === 'file'` |
| asterisco | `FieldRenderer.tsx:524` | `{field.required && <span className="text-kidville-green">*</span>}` — **compare da sé** |
| motore condiviso | `validate-fields.ts:33, 57-62, 105-106` | `file` **non** è fra i `TIPI_DECORATIVI` (`section_header`/`paragraph`/`signature`); `eVuoto` cattura `null`/`undefined`/`''`; `if (field.required && vuoto) return 'Campo obbligatorio'` |
| server | `iscrizione/insegnanti/route.ts:669` | `validatePage(campiVisibili(INSEGNANTE_FIELDS, normalizzati), normalizzati)` — `cv_path` **non ha `condition`**, e `campoVisibile` (`conditional.ts:57-59`) fa `if (!field.condition) return true` ⇒ non viene mai filtrato via. Il 400 esce con `campi: { cv_path: 'Campo obbligatorio' }` |
| passi scavalcati | `CandidaturaInsegnanteWizard.tsx:817-841` (`prosegui`), `800-807` (`messaggioMancante`) | valida i passi scavalcati con `validateField(f, getValues(f.id))` e **non** con `trigger` — che «vale solo per i campi MONTATI» e «risponde `true` a qualunque cosa» (misurato, commento a 784-798). `cv_path` sta in `CAMPI_PROFILO` ⇒ il ritorno al riepilogo si ferma sul passo «profilo» |
| percorso lineare | `CandidaturaInsegnanteWizard.tsx:876-884` | `trigger(campi.map(f => f.id))` (qui il campo **è** montato) + `setFocus(primo.id)`, che funziona perché `FieldRenderer.tsx:721` passa `inputRef={rhf.ref}` all'`<input>` vero |

**Il rischio è l'opposto di quello che sembra**: chi non legge questa tabella scrive **tre
difese dove ce n'è già una**, e le tre divergono. Il repo ha già chiuso questo difetto per i
consensi (`devAccettare` vs «Campo obbligatorio»).

> 🔻 **SUPERATA IL 2026-08-25 — la riga qui sotto non descrive più il perimetro.** `FieldRenderer.tsx`
> e `validate-fields.ts` **sono stati toccati** (+1096/−51 e +92/−1): i giri di critica hanno spostato
> il lavoro dalla rifinitura del solo `/lavora-con-noi` a due difetti che vivono nei componenti
> condivisi — l'obbligo che si leggeva in italiano su una pagina inglese, e il messaggio dell'obbligo
> che era «la risposta di un database». La motivazione, con le misure, sta nel changelog del PRD
> (sezione «Le due modifiche» e quella del settimo giro). La riga resta scritta perché il perimetro
> di partenza era questo: **è il ribaltamento la parte utile, non la riscrittura della storia.**

**Da NON toccare, esplicitamente**: `FieldRenderer.tsx` (nessun ramo), `validate-fields.ts`,
`conditional.ts`, e il gate di **forma** del percorso in `route.ts:705-718`
(`percorsoCvAmmesso`), che gira **dopo** `validatePage` — assente ⇒ «Campo obbligatorio»,
presente ma malformato ⇒ il messaggio dedicato. ⚠️ **Non invertire quest'ordine**: col gate
prima, un `cv_path` assente cadrebbe nel ramo `cvPath !== null` (falso) e **passerebbe**.
⚠️ E non dare mai una `condition` a `cv_path`: uscirebbe dal filtro e l'obbligatorietà server
sparirebbe **in silenzio, con i test verdi**.

## B-1 · (TEST PRIMA) I due lock che devono diventare rossi per primi

### B-1a · Il template dichiara l'obbligo

**File**: `__tests__/lib/insegnanti-template.test.ts`, test
`it('nome, cognome ed email sono obbligatori; residenza e telefono no')` (righe 244-253).

- spostare `'cv_path'` dall'elenco dei **facoltativi** (riga 248) a quello degli
  **obbligatori** (riga 245);
- **rinominare** il test — oggi dice «residenza e telefono no» mentre l'elenco ne contiene
  quattro: `it('nome, cognome, email e CURRICULUM sono obbligatori; residenza e telefono no')`;
- lasciare `expect(campo('cv_path')?.type).toBe('file')`.

### B-1b · Il server rifiuta — **il test da capovolgere, non da cancellare**

**File**: `__tests__/api/candidature-insegnanti-post.test.ts`, righe **722-726**.

Oggi: `it('senza curriculum non cambia niente: il campo è FACOLTATIVO')` ⇒ 201 +
`h.inserts[0].cv_path` nullo. **Capovolgerlo**:

```
it('senza curriculum è 400, e il campo è NOMINATO: dal 2026-08-24 è OBBLIGATORIO', async () => {
  // In Kidville il curriculum non è più un allegato gradito: senza, la candidatura
  // non esiste. Il rifiuto arriva dalla ri-validazione server (`validatePage` sui
  // campi visibili), NON dal gate di forma del percorso — che gira dopo e guarda
  // un valore che qui non c'è. Due rifiuti diversi con lo stesso status: questo è
  // «Campo obbligatorio».
  const res = await inviaSenzaCv()
  expect(res.status).toBe(400)
  const j = await res.json()
  expect(Object.keys(j.campi), 'il campo respinto va NOMINATO').toContain('cv_path')
  expect(j.campi.cv_path).toBe('Campo obbligatorio')
  expect(h.inserts, 'una candidatura senza curriculum è entrata in tabella').toHaveLength(0)
})
```

dove `inviaSenzaCv()` manda il corpo della fixture **meno** `cv_path` (vedi B-3: la fixture
base d'ora in poi ce l'ha).

**⚠️ Cancellarlo invece di capovolgerlo** farebbe perdere l'unica prova diretta che il server
rifiuta un invio senza CV: resterebbe difeso solo dal client.

### B-1c · Prova del rosso, prima di toccare il template

```bash
npx vitest run __tests__/lib/insegnanti-template.test.ts __tests__/api/candidature-insegnanti-post.test.ts \
  > /tmp/b1.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; grep -n "cv_path\|obbligatori" /tmp/b1.txt | head -20
```

Atteso: **ESITO=1**, con **due** fallimenti — `cv_path dovrebbe essere obbligatorio` e il 201
ricevuto dove si aspettava 400. Se il secondo **non** è rosso, hai sbagliato la fixture o il
mock: fermati, non proseguire.

## B-2 · La riga che fa tutto — e la sua etichetta

**File**: `src/lib/forms/insegnanti-template.ts`.

⚠️ **Dopo il blocco A i numeri di riga sono cambiati** (~9 righe in meno): **cercare il campo
per contenuto**, non per riga.

```bash
grep -n "id: 'cv_path'" src/lib/forms/insegnanti-template.ts
```

Da:

```
{ id: 'cv_path', type: 'file', label: 'Curriculum (facoltativo)', required: false, … }
```

a:

```
{ id: 'cv_path', type: 'file', label: 'Curriculum', required: true, … }
```

**Solo `label` e `required`.** ⚠️ **Non toccare `accept` né `max_size_mb`**:
`src/lib/candidature/percorso-cv.ts:120-125` **legge le estensioni ammesse proprio da
`accept`** (`CV_ESTENSIONI`), e `__tests__/lib/insegnanti-template.test.ts:342-395` le confronta
con `ESTENSIONI_ALLEGATO_PUBBLICO`.

**L'etichetta è «Curriculum», senza aggiungere «(obbligatorio)»**: l'asterisco arriva comunque
da `FieldRenderer.tsx:524`, e «Curriculum (obbligatorio) *» sarebbe un doppio segnale.
⚠️ **L'ancora `^` di due selettori pretende che l'etichetta cominci per «Curriculum»**:
`CandidaturaInsegnanteWizard-posizioni.test.tsx:431` (`getByLabelText(/^Curriculum/)`) e
`a11y/candidatura-insegnante-a11y.test.tsx:356` (`toHaveAccessibleName(/Curriculum/)`, senza
ancora). Un'etichetta come «Allega il curriculum» romperebbe il primo con un errore di
selettore che **sembra** un problema di rendering.

### B-2b · Il commento che argomenta il CONTRARIO della decisione presa

Sopra il campo ci sono ~39 righe di commento che aprono con:

> «CV facoltativo: chi si candida dal telefono spesso il curriculum non ce l'ha sottomano, e un
> allegato obbligatorio farebbe abbandonare il modulo a chi i campi li ha già compilati tutti.»

È **un commento che mente in modo persuasivo** — il tipo peggiore: fra sei mesi qualcuno lo
legge e ripristina `required: false` «perché c'era una ragione». **Non cancellarlo e basta:
riscriverlo** dicendo cosa è stato deciso e quando (decisione del titolare, 2026-08-24), e
**tenendo** la contro-obiezione con la sua risposta: il rischio di abbandono resta reale, ed è
esattamente il motivo per cui la nota sotto il campo continua a dire che **va bene anche una
fotografia** (vedi B-4).

⚠️ **Il resto del blocco non si tocca**: le righe sull'`accept` misurato su
`storage.buckets` (`.doc`/`.docx` non ammessi, `.heic` sì), sul bucket `form_attachments` e
sulla prescrizione a `verificaAllegatoPubblico` sono **tutte ancora vere**.

**Verifica**: i due lock di B-1 diventano **verdi**; tutto il resto della suite **diventa rosso
in blocco** — è atteso, e i passi da B-3 a B-7 lo richiudono.

## B-3 · La fixture che vale ~55 test

**File**: `__tests__/api/candidature-insegnanti-post.test.ts`.

**Misurato**: **60** chiamate a `inviaValida(`, di cui **5** passano un `cv_path`. La factory
`candidatura()` (righe 375-393) **non** contiene `cv_path`. Con `required: true` ogni invio
senza quel campo prende 400 «Campo obbligatorio»: **circa 55 test rossi in un colpo**, che si
leggono come un guasto della route.

1. Portare il percorso buono a **livello di modulo** (oggi `CV_BUONO` è dichiarato **dentro**
   il `describe` di riga 649, quindi non è visibile alla factory):

```
/** La forma che la rotta di caricamento produce — `candidature/<uuid>-cv.<est>`. */
const CV_BUONO = 'candidature/0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f-cv.pdf'
```

   e far sì che il `const CV_BUONO` locale del `describe` del curriculum **riusi** quello (o
   sparisca): due costanti con lo stesso nome e lo stesso valore sono la coppia che diverge.
2. Aggiungere `cv_path: CV_BUONO` alla factory `candidatura()`.
3. Aggiungere l'aiutante per il caso di B-1b:

```
/** Lo stesso invio, senza il curriculum: dal 2026-08-24 è ciò che il server rifiuta. */
const inviaSenzaCv = () => {
  const { cv_path: _omesso, ...senza } = candidatura()
  return invia({ scuole_ids: [SEDE_A], data: senza })
}
```

   (adattare alla forma vera di `invia`/`inviaValida`, righe 395-412 e 404.)

⚠️ **`COLONNE_AMMESSE` (righe 326-332) è DERIVATO** da `INSEGNANTE_FIELDS` + `gradi`/`scuola_id`/
`consents_log`: si restringe da solo dopo il blocco A e il confronto sulle colonne dell'INSERT
resta verde. Non ribatterlo a mano.

⚠️ **Ricontrollare uno per uno i cinque casi che passano `cv_path` apposta** (righe 664, 675,
685, 703, 715, più 754/788 sui due `23505`, e 1526 nel blocco della copia alla sede): devono
continuare a fallire **dal gate di forma** e non da «Campo obbligatorio». Sono due rifiuti
diversi con lo stesso status, e l'unico modo di distinguerli è **leggere il messaggio**:

```bash
npx vitest run __tests__/api/candidature-insegnanti-post.test.ts -t 'percorso del curriculum' \
  > /tmp/b3.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; grep -cE "✓|×" /tmp/b3.txt
```

Atteso: ESITO=0 e **almeno 7 test eseguiti**. Se sono **0**, il filtro non ha agganciato nulla
e vitest esce **0** mentendo.

**Falso allarme da NON inseguire** (una lente lo dava per vero, la misura lo smentisce): il
test `it('un percorso SMISURATO è respinto…')` (righe 712-720) asserisce **già oggi**
`status 400` e `h.inserts` vuoto — **non** un INSERT con `cv_path` nullo. L'unico test che
pretendeva `h.inserts[0].cv_path` nullo è quello di B-1b, ed è quello che si capovolge.

## B-4 · La frase sotto il campo — **in tutte e due le lingue, nello stesso commit**

**File**: `messages/it/public.json:39` e `messages/en/public.json:39`. **La chiave `candCvNota`
resta**: la referenziano `NOTE_DEI_CAMPI` (wizard), `forma-visiva.test.tsx:436`,
`posizioni.test.tsx:444` e l'E2E `:294`, tutti **per chiave** — ed è per questo che cambiare il
**testo** non rompe niente.

| | oggi (diventa falso parola per parola) | nuovo |
|---|---|---|
| `it` | «Va bene un PDF oppure una foto del curriculum, purché si legga tutto. **È facoltativo: senza, la candidatura si invia lo stesso.**» | «Va bene un PDF oppure una foto del curriculum, purché si legga tutto. **Senza allegato la candidatura non si può inviare.**» |
| `en` | «A PDF or a photo of your CV is fine, as long as everything is readable. **It is optional: you can send the application without it.**» | «A PDF or a photo of your CV is fine, as long as everything is readable. **Without an attachment the application cannot be sent.**» |

**La prima metà si tiene**, ed è la parte che conta di più adesso: è ciò che impedisce
l'abbandono a chi non ha il PDF sottomano, cioè il rischio che il commento riscritto in B-2b
dichiara.

⚠️ **QUESTO È L'UNICO PUNTO DEL LAVORO CHE NESSUN CONTROLLO AUTOMATICO INTERCETTA.**
Verificato leggendo i lock: `messaggi-parita-cataloghi.test.ts` confronta **namespace**
(riga 148), **chiavi** (161) e **testo non vuoto** (172) — **mai il significato**;
`messaggi-chiavi-orfane.test.ts` ha sotto tutela **solo** `adminModulistica`. Cambiando solo
l'italiano l'albero resta **verde** e l'inglese continua a promettere «you can send the
application without it» su un modulo che rifiuta l'invio.

Aggiornare anche il commento di `NOTE_DEI_CAMPI` (`CandidaturaInsegnanteWizard.tsx:284-298`),
che dichiara come scopo della nota «che il curriculum **è facoltativo** e che va bene anche una
fotografia». ⚠️ **Non toccare** il debito dichiarato subito sotto (la nota è un `<p>` e non un
`aria-describedby`, perché quello è occupato dal messaggio d'errore): resta vero, ed è **una
cosa diversa** dall'`aria-required` di B-6.

`__tests__/components/CandidaturaInsegnanteWizard-forma-visiva.test.tsx:418-445` **resta
verde**: legge il testo dal catalogo ed è un test di **posizione** (la nota viene dopo
`#cv_path` nella stessa scatola). ⚠️ **Non conta come prova che il testo sia stato aggiornato**:
sarebbe verde qualunque cosa ci sia scritto. Il commento delle righe 400-410, che dice «è
facoltativo», va corretto.

## B-5 · I tre file di test che si rompono **senza mai nominare `cv_path`**

⚠️ **La rottura più voluminosa e la meno evidente: un `grep cv_path` non li trova.**
`CandidaturaInsegnanteWizard-consensi.test.tsx`, `-errore-invio.test.tsx` e `-sede.test.tsx`
(insieme: **55 test verdi** oggi) hanno ciascuno un elicottero che attraversa il passo
«profilo» compilando titolo di studio + una posizione, e poi preme «Avanti» **senza allegare
niente**. Falliranno **in blocco con timeout su `waitFor`**, che si legge come «il wizard è
rotto» invece che «manca un allegato».

Gli helper esatti:

| file | helper | riga del «profilo» |
|---|---|---|
| `-consensi.test.tsx` | `vaiAiConsensi()` | 96-101 |
| `-errore-invio.test.tsx` | `compilaFinoAlRiepilogo()` | 104-107 |
| `-sede.test.tsx` | `compilaFinoAlRiepilogo()` | 138-141 |

In ognuno servono **due** cose:

1. **il mock della rotta di caricamento**, sul modello già scritto in
   `-riepilogo.test.tsx:91-95`;
2. **l'allegato prima dell'«Avanti»**, sul modello di `allegaCurriculum()`
   (`-riepilogo.test.tsx:171-181`): `document.getElementById('cv_path')`, `fireEvent.change`
   con un `File`, e `await waitFor(() => expect(screen.getByText(NOME_FILE)).toBeInTheDocument())`
   — l'attesa è **obbligatoria**: il caricamento è asincrono, e senza di essa il campo non ha
   ancora preso il percorso quando si preme «Avanti».

### ⚠️ B-5b · LA TRAPPOLA CHE NESSUNA LENTE HA VISTO — l'ordine dei rami nel `fetchMock`

Nei tre file il `fetchMock` intercetta l'invio così:

```
if (url.includes('/api/iscrizione/insegnanti') && init?.method === 'POST') { corpiInviati.push(…); return 201 }
```

`'/api/iscrizione/insegnanti/upload'` **contiene** `'/api/iscrizione/insegnanti'` **ed è un
POST**: senza un ramo dedicato **messo PRIMA**, il caricamento finirebbe nel ramo dell'invio,
verrebbe spinto dentro `corpiInviati` e riceverebbe `{ id: 'c-1' }` invece di `{ path: … }`.
Conseguenze: il campo non prende mai il percorso (**timeout**) **e** le asserzioni
`expect(corpiInviati).toHaveLength(1)` / `toHaveLength(0)` misurerebbero un invio in più.

`-riepilogo.test.tsx` fa già la cosa giusta (`/upload` **prima** del ramo POST): **copiare
quell'ordine**, non inventarlo. Il ramo da inserire:

```
if (url.includes('/api/iscrizione/insegnanti/upload')) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ path: PERCORSO_CV }) })
}
```

**Verifica del blocco**:

```bash
npx vitest run __tests__/components/CandidaturaInsegnanteWizard-consensi.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-errore-invio.test.tsx \
  __tests__/components/CandidaturaInsegnanteWizard-sede.test.tsx \
  > /tmp/b5.txt 2>&1; ESITO=$?; echo "ESITO=$ESITO"; tail -6 /tmp/b5.txt
```

Atteso: **ESITO=0** e **55 test** eseguiti — non 54, non 3.

⚠️ **Non toccare** il caso `-errore-invio.test.tsx:309-340`: il campo «ignoto» del 400 è
`gradi` **di proposito** (con `cv_path` misurerebbe l'opposto di ciò per cui è scritto), e il
test verifica esso stesso che `gradi` non sia nel template.

## B-6 · Il riepilogo, l'accessibilità e la decisione sull'`aria-required`

### B-6a · Il riepilogo si adegua da solo — e **il ramo «Non indicato» non si cancella**

`CandidaturaInsegnanteWizard.tsx:1159-1188` calcola già
`mancante: obbligatorio && !allegato`: **si accende da sé** quando `required` diventa `true`.
Il ramo «Non indicato» del curriculum diventa **irraggiungibile dal wizard** (per arrivare al
riepilogo bisogna superare `passoAvanti('profilo')` **e** `prosegui()`, che ora lo bloccano
entrambi), ma **va tenuto**: `candRiepilogoNonIndicato` serve ancora a **sei** campi
facoltativi (telefono, comune, provincia, dettaglio del titolo, anni, presentazione), e il ramo
è l'unica cosa che direbbe **in rosso, sul riepilogo**, che il blocco a monte si è rotto —
invece di far partire un invio che il server rifiuta. **Zero modifiche al componente.**

### B-6b · `__tests__/components/CandidaturaInsegnanteWizard-riepilogo.test.tsx`

1. `compilaTutto` deve allegare **sempre**: togliere il parametro `allegaCv` e chiamare
   `await allegaCurriculum()` prima dell'`avanti()` del passo «profilo». Aggiornare la sola
   chiamata che passava `true` (`compilaTutto([], true)`, ~riga 424) in `compilaTutto()`.
   ⚠️ Senza questo, **ogni** `it()` che chiama `compilaTutto()` si ferma al passo «profilo».
2. **Riga 343**: togliere `'cv_path'` dall'elenco `vuoti` — un obbligatorio non può stare fra i
   vuoti, e col CV obbligatorio non si arriva più al riepilogo lasciandolo vuoto. Dopo il
   blocco A e questo passo la lista ha **6** id: `telefono`, `residence_city`,
   `residence_province`, `titolo_dettaglio`, `anni_esperienza`, `note`. Aggiornare il commento
   delle righe 339-342, che spiega perché `cv_path` era in elenco.
3. Il test «il curriculum allegato si dice “Allegato”, e il suo PERCORSO non compare da nessuna
   parte» (righe 423-452) **resta intatto** e diventa il caso normale.

### B-6c · `__tests__/components/CandidaturaInsegnanteWizard-posizioni.test.tsx`

- **riga 443**: `expect(dichiarato?.required ?? false).toBe(false)` → **`toBe(true)`**, e
  riscrivere il commento sopra («È facoltativo: chi si candida dal telefono…»), che argomenta
  il contrario di ciò che si sta implementando.
- **righe 501-510**: il commento del censimento dice che i campi ci sono tutti «e facoltativi»:
  correggerlo.
- **righe 536-559** (`obbligatoriVisibili`): **nessuna modifica al codice del test**, ma va
  saputo che **cambia significato**: `cv_path` entra fra gli obbligatori visibili e le righe
  `expect(...).toEqual([])` continuano a passare **solo perché il campo è reso**. Da qui in poi
  quel censimento è il guardiano che impedisce di rimettere `cv_path` in `IDS_NON_RESI` — cosa
  che renderebbe il modulo **impossibile da inviare per sempre** (il pericolo scritto a
  `CandidaturaInsegnanteWizard.tsx:232-238`). Scriverlo nel commento.

### B-6d · `__tests__/a11y/candidatura-insegnante-a11y.test.tsx` — e la decisione sull'`aria-required`

**Misurato**: `aria-required` **non esiste per nessun campo** tranne i `consent`
(`FieldRenderer.tsx:432`). `ariaProps` (267-269) contiene **solo** `aria-invalid` e
`aria-describedby`, e **solo quando c'è già un errore**. `jest-axe` **non lo segnala** — un
input senza `aria-required` non è una violazione axe, ed è la stessa classe di difetto che il
repo racconta a `FieldRenderer.tsx:296-298` per il `role="group"` di `gradi`.

> 🔻 **RIBALTATA IL 2026-08-25 — `aria-required` VIENE emesso.** La decisione qui sotto è caduta in un
> giro successivo: `FieldRenderer` lo emette ora per ogni campo `required`, e la ragione n. 2 («serve
> anche `/anagrafica-personale` e `/iscrizione`, fuori dal perimetro») è diventata l'argomento
> opposto — una regola uniforme su tutti i moduli invece di un'eccezione su uno. MISURATO il 25/08 su
> `/iscrizione`, passo «Bambino 1»: **10 controlli** con `aria-required="true"`, dove prima non ce
> n'era nessuno. Il racconto e il costo stanno nel PRD; qui resta la decisione di partenza, che è la
> cosa che serve a chi vuole capire perché è cambiata.

**DECISIONE: NON si emette `aria-required` in questo lavoro.** Tre ragioni, dette una volta:

1. sarebbe una regola nuova applicata a **un campo su sei obbligatori dello stesso passo**
   (`nome`, `cognome`, `email`, `posizioni`, `titolo_studio` non ce l'hanno): esattamente la
   «seconda regola destinata a divergere» contro cui questo repo ha una dottrina scritta;
2. `FieldRenderer` serve anche `/anagrafica-personale` e `/iscrizione`, **fuori dal perimetro**
   dichiarato di questo lavoro;
3. l'obbligo **è già nel nome accessibile**: l'asterisco di `FieldRenderer.tsx:524` sta dentro
   la `<label htmlFor>` esterna, che è una delle due label da cui il nome si compone.

**Quello che si fa invece — l'asserzione positiva che documenta lo stato misurato.** Nel test
`it('le SETTE posizioni sono un gruppo solo, e il curriculum resta raggiungibile da tastiera')`
(righe 326-360), accanto a `expect(cv).toHaveAccessibleName(/Curriculum/)` aggiungere:

```
// Dal 2026-08-24 il curriculum è OBBLIGATORIO, e chi ascolta lo deve sapere prima di
// premere «Avanti». L'obbligo viaggia nell'ASTERISCO, che sta dentro la <label> esterna
// e quindi dentro il nome accessibile — non in `aria-required`, che in questo modulo non
// ha nessuno dei sei campi obbligatori (`FieldRenderer` lo emette solo per i `consent`).
// È un debito DICHIARATO, non una svista: si chiude per tutti i campi insieme o per
// nessuno, altrimenti è una seconda regola che diverge. ⚠️ `jest-axe` non lo vede.
expect(cv).toHaveAccessibleName(/Curriculum\s*\*/)
```

**Prova del rosso e piano B**: questa asserzione dev'essere **rossa prima** di B-2 e **verde
dopo**. Se resta **rossa anche dopo** — cioè se l'asterisco non finisce nel nome accessibile —
**non forzare la regex**: ripiega su un'asserzione sulla `<label>` esterna
(`expect(document.querySelector('label[for="cv_path"]')?.textContent).toContain('*')`) e
**scrivi nel report che l'obbligo non è annunciato**, perché a quel punto la decisione
sull'`aria-required` va rimessa al titolare invece che risolta per inerzia.

## B-7 · L'E2E — **il passo che decide la CI, e va risolto qui e non a PR aperta**

**File**: `e2e/public-candidatura-insegnante.spec.ts`, test
`'percorso vero: due posizioni, consenso, 201 e pannello di conferma @solo-chromium'`.

Oggi il test **invia senza allegato e pretende 201**, e il commento delle righe 296-301 dichiara
che è «l'unica prova che il curriculum sia davvero facoltativo», spiegando accanto perché un
caricamento vero era stato **escluso di proposito**. Con l'obbligo, quel percorso non arriva più
al 201. **`E2E (Playwright)` è un check obbligatorio di merge su `main`.**

### B-7a · L'aritmetica del tetto — **misurata, e non è quella che le lenti temevano**

| fatto | dove | valore |
|---|---|---|
| tetto caricamenti | `src/lib/upload/allegati-pubblici.ts:145` | **6** ogni 10 min per IP |
| tetto invii | `iscrizione/insegnanti:POST` | **3** all'ora per IP |
| retry in CI | `playwright.config.ts:78` | **2** ⇒ fino a **3** tentativi |
| progetti che eseguono **questo** test | `playwright.config.ts:68, 121` — il titolo porta **`@solo-chromium`** e il progetto `webkit` ha `grepInvert: /@solo-chromium/` | **solo `chromium`** |

⇒ **3 caricamenti su 6 nel caso peggiore.** Il tetto degli **invii** (3/ora) era già il vincolo
più stretto e **non cambia**: il test faceva già 1 POST per tentativo. **La strada dell'upload
vero è praticabile**, con tre slot di margine.

### B-7b · Il bucket in CI funziona già — **verificato, non ipotizzato**

`e2e/public-anagrafica-personale.spec.ts:265-340` esegue **due caricamenti veri** su una rotta
pubblica gemella (`/api/iscrizione/personale/upload`, stesso bucket `form_attachments`) e gira
in CI. **Copiare quel modello**, compreso `PDF_MINIMO` (righe 83-90), che è un PDF valido e
minuscolo.

### B-7c · ⚠️ LA TRAPPOLA CHE FA FALLIRE IL TEST CON UN MESSAGGIO CHE SEMBRA UN BUG DELLA ROUTE

Il test registra, **prima della navigazione**:

```
const invio = page.waitForResponse(
  (r) => r.url().includes('/api/iscrizione/insegnanti') && r.request().method() === 'POST',
);
```

`'/api/iscrizione/insegnanti/upload'` **soddisfa quel predicato**. Aggiungendo un upload,
`invio` si risolverebbe sulla risposta **del caricamento** (200) e
`expect((await invio).status()).toBe(201)` fallirebbe con **200** — cioè accusando l'invio di
non aver risposto 201 quando l'invio non è nemmeno stato guardato.

**Il predicato va stretto sul pathname esatto** (la forma è già usata nello spec del personale,
riga 279):

```
const invio = page.waitForResponse(
  (r) => new URL(r.url()).pathname === '/api/iscrizione/insegnanti' && r.request().method() === 'POST',
);
```

### B-7d · Le modifiche, in ordine

1. **stringere il predicato** di `waitForResponse` come sopra;
2. aggiungere `PDF_MINIMO` (copiato da `public-anagrafica-personale.spec.ts:83-90`) e un nome
   file riconoscibile, es. `const NOME_CV = 'cv-candidatura-e2e.pdf'`;
3. **prima** di `setInputFiles`, registrare l'ascolto della risposta del caricamento
   (una presa agganciata dopo perde le risposte veloci):

```
const caricamento = page.waitForResponse(
  (r) => new URL(r.url()).pathname === '/api/iscrizione/insegnanti/upload',
);
await page.locator('#cv_path').setInputFiles({ name: NOME_CV, mimeType: 'application/pdf', buffer: PDF_MINIMO });
expect((await caricamento).status(), 'il caricamento del curriculum non ha risposto 200').toBe(200);
// Il riquadro mostra il nome del file LOCALE: è la sola conferma a schermo che
// l'allegato sia entrato nel campo, ed è il punto di sincronizzazione prima di «Avanti».
await expect(page.locator('#cv_path').locator('xpath=ancestor::label[1]'))
  .toContainText(NOME_CV, { timeout: 20_000 });
```

4. **riscrivere il commento delle righe 296-301**, che dichiara l'esatto contrario di ciò che il
   modulo farà. Il commento nuovo deve dire: che dal 2026-08-24 il curriculum è **obbligatorio**
   e che questo è l'**unico** punto in cui la catena vera (caricamento → percorso → invio) si
   prova end-to-end; e l'aritmetica **rifatta**: `@solo-chromium` + `retries: 2` ⇒ **fino a 3
   caricamenti su 6**, mentre il vincolo stretto resta il tetto degli **invii** (3/ora), che
   questo blocco consumava già prima.
5. **lasciare** le due asserzioni delle righe 293-294 (`#cv_path` attaccato, nota visibile).

⚠️ **L'E2E non si può provare in locale** (`npm run e2e` è in `deny`: il seed scriverebbe nel
database di **produzione**). Si verifica **in CI**. Perciò questo passo si scrive **con cura e
per primo fra quelli “non provabili”**, e nel report va scritto a chiare lettere che è l'unico
pezzo del lavoro la cui prova arriva dopo.

**Se in CI dovesse comunque fallire sul caricamento** (bucket, MIME, 429), il ripiego — da usare
**solo** dopo aver visto il fallimento vero, mai preventivamente — è `page.route()` sulla rotta
di upload che restituisce `{ path: 'candidature/<uuid>-cv.pdf' }`: il POST **non verifica che
l'oggetto esista** nello Storage (controlla solo lunghezza, forma e estensione,
`percorso-cv.ts:170-176`). ⚠️ In quel caso l'uuid **deve essere generato a ogni run**
(`crypto.randomUUID()`, minuscolo, conforme a `[0-9a-f]{8}-…`): un uuid fisso violerebbe
l'indice unico `candidature_insegnanti_cv_unico` **dalla seconda esecuzione in poi**, e il 400
si leggerebbe come un difetto della route.

### B-7e · Il lock del tetto: **resta verde, e la sua motivazione diventa stale**

`__tests__/architecture/upload-pubblico-con-tetto.test.ts:247-258, 283-330` non diventa rosso
(6 resta 6, e la derivazione `TETTO_UPLOAD_CANDIDATURE === invii * 2` è letta dal **codice**
della rotta degli invii, che non cambia). Ma la **motivazione** cambia di natura e va
aggiornata: fino a ieri il caricamento era un passo **opzionale** con due tentativi di margine;
da oggi è un passo **obbligatorio** senza il quale non esiste candidatura. **Un 429 su quella
porta oggi significa «non puoi candidarti», non più «non puoi allegare».**
⚠️ È un warning con verdetto PASS, cioè il tipo di nota che si salta — e lasciarla stale è
esattamente la definizione di documento che invecchia male in questo repo.

## B-8 · La frase che accuserebbe una persona di un guasto tecnico

**File**: `src/lib/email/messaggi/candidatura-alla-sede.ts:135-139` e
`src/lib/candidature/copia-alla-sede.ts:300-306`.

L'annuncio dell'allegato ha **tre rami**; il terzo dice:

> «Nessun curriculum allegato: chi si è candidato non ne ha caricato uno.»

**Misurato**: quel ramo si raggiunge **anche quando il file c'è e il download dallo Storage
fallisce** — `copia-alla-sede.ts:267-293` lascia `allegati` `undefined` sull'errore (o su
`{ data: null, error: null }`) e la riga 302 passa `conCurriculum: allegati !== undefined`,
**senza fermare l'email**. Con il curriculum obbligatorio, ogni volta che quella frase comparirà
su una candidatura nuova **sarà falsa**: accuserà una persona di un'omissione impossibile
mentre il fatto vero è un guasto tecnico, e la segreteria la scarterà. È **la classe di difetto
che questo repo ha già pagato con le email**: un messaggio che afferma una cosa e ne nasconde
un'altra, con i test verdi.

**Modifica minima, un segnale in più e un ramo in più:**

1. `copia-alla-sede.ts`, accanto ai due che già passa:

```
// Il curriculum c'era ma non è arrivato: `allegati` resta `undefined` anche quando lo
// scaricamento fallisce (vedi sopra, il warn `curriculum-non-allegato`). Dal 2026-08-24
// il campo è obbligatorio, quindi «non ne ha caricato uno» sarebbe una falsa accusa
// stampata sopra un guasto dello Storage.
curriculumNonAllegabile: allegati === undefined && d.cvPath !== null,
```

2. `candidatura-alla-sede.ts`: aggiungere il ramo **prima** dell'ultimo, e **tenere tutti e tre
   quelli esistenti**:

```
: d.curriculumNonAllegabile === true
  ? 'Il curriculum è stato caricato ma non è stato possibile allegarlo a questo messaggio: si apre dalla scheda della candidatura in Segreteria.'
```

⚠️ **Non cancellare il secondo ramo** («arrivata prima che il modulo permettesse di caricarne
uno»): serve alle candidature anteriori al 2026-08-15 (`CV_CARICABILE_DA`).
⚠️ **Non cancellare il terzo** «perché ormai il CV c'è sempre»: resta l'unico corretto per le
candidature del 15/08→24/08, quando il campo era reso **e** facoltativo — sono parte delle
**95** righe senza `cv_path` misurate oggi.

**Test (prima)**, in `__tests__/lib/email/candidatura-alla-sede.test.ts`, accanto ai casi
esistenti sui rami dell'allegato (righe 110-122):

```
it('curriculum caricato ma non allegabile: il messaggio dice il GUASTO, non un’omissione', () => {
  const m = messaggioCandidaturaAllaSede(
    { dati: DATI, consensi: { presa_visione_informativa: true }, sediScelte: ['Kidville Cesa'],
      inviataIl: '24/08/2026, 10:30', conCurriculum: false, curriculumNonAllegabile: true },
    SEDE,
  )
  expect(m.testo).toContain('non è stato possibile allegarlo')
  // ⚠️ Il controllo che conta: la sede NON deve leggere che la persona non l'ha caricato.
  expect(m.testo).not.toContain('non ne ha caricato uno')
})
```

**Prova del rosso**: lanciarlo prima della modifica ⇒ **ESITO=1**, e il messaggio dice che il
testo contiene «non ne ha caricato uno».

⚠️ **Zero modifiche** a `conferma-candidatura.ts` (`numeroAllegati` varrà sempre 1 e il ramo
`n === 0` diventa difensivo) e a `gdpr/retention-candidature/route.ts`. Ma **da sapere e da
scrivere nel report**: con il CV obbligatorio **gli orfani nel bucket cresceranno** — oggi chi
abbandona il modulo spesso non ha caricato nulla, da domani **ogni abbandono dopo il passo
“profilo” lascia un file** dentro `form_attachments`, cioè lo stesso bucket dei documenti dei
minori. La spazzata a 24 h (`spazzaCurriculumOrfani`) passa da **accessoria a portante**, il
termine è già dichiarato in `/privacy` (`src/app/privacy/page.tsx:499-508`) e **resta valido**:
cambia il **volume**, non la promessa. E il booleano `con_cv` del log
(`iscrizione/insegnanti/route.ts:1517`) perde valore diagnostico — sarà sempre `true` sui nuovi
invii: chi cercherà «quanti invii senza CV» in `app_log` troverà zero e non saprà se è perché
il campo è obbligatorio o perché il log si è rotto. **Dirlo nel report**, non «aggiustarlo».

## B-9 · Il PRD

- **riga 4428/4429** — spostare **`curriculum`** dai «Facoltativi» agli «Obbligatori». (Nella
  stessa passata: `disponibilità` è già uscita in A-10, e le «fasce d'età (`gradi`)» vanno tolte
  dagli obbligatori — bugia preesistente dal 15/08.)
- **righe 4873-4877** — il blocco «**Cosa il modulo NON rende, e perché**» descrive lo stato del
  **2026-08-11** ed è **falso da nove giorni**: dice che il curriculum non si rende perché
  nessuna rotta di caricamento produce il prefisso `candidature/`, e che «torna il giorno in cui
  nasce la rotta, togliendolo da `IDS_NON_RESI`». La rotta è nata il 15/08 e `IDS_NON_RESI` è
  **vuoto** da allora. **Riscrivere il blocco** dicendo lo stato vero: il curriculum si rende,
  si carica da `POST /api/iscrizione/insegnanti/upload`, ed è **obbligatorio** dal 2026-08-24.
  ⚠️ **Non toccare** il paragrafo su `AnimatePresence` che segue: è ancora vero.
- **riga 78** (tabella di stato «Lavora con noi») — «**curriculum allegabile**» →
  «**curriculum obbligatorio**», e togliere ogni traccia della domanda sulla disponibilità se
  ve n'è.
- **riga 2466** — racconta al **passato** i cinque giorni in cui il curriculum era facoltativo e
  non allegabile: **lasciare**, è cronaca.

## B-10 · Gate del blocco B

Identico ad A-11, più:

| # | Comando | Esito atteso |
|---|---|---|
| B.a | `grep -n "id: 'cv_path'" src/lib/forms/insegnanti-template.ts` | `label: 'Curriculum'`, `required: true`, `accept` e `max_size_mb` **invariati** |
| B.b | `grep -rn "facoltativ" src/lib/forms/insegnanti-template.ts` | nessuna riga che riferisca il **curriculum** |
| B.c | `grep -n "candCvNota" messages/it/public.json messages/en/public.json` | **due** righe, entrambe col testo nuovo, **nessuna** contiene «facoltativo» / «optional» |
| B.d | `npx vitest run __tests__/api/candidature-insegnanti-post.test.ts` | **0**, **86 test** eseguiti (baseline: 86) |
| B.e | `npx vitest run __tests__/components/CandidaturaInsegnanteWizard-*.test.tsx __tests__/a11y/candidatura-insegnante-a11y.test.tsx` | **0**, e il conto **non** cala rispetto alla baseline |
| B.f | `grep -n "waitForResponse" e2e/public-candidatura-insegnante.spec.ts` | il predicato dell'**invio** usa `new URL(r.url()).pathname === '/api/iscrizione/insegnanti'` |
| B.g | `grep -n "setInputFiles" e2e/public-candidatura-insegnante.spec.ts` | presente, prima del primo «Avanti» del passo profilo |
| B.h | `mcp__supabase__execute_sql`: `select count(*) filter (where cv_path is null) from candidature_insegnanti;` | **≥ 95** — le righe storiche senza CV sono intatte |
| B.i | prova del rosso: rimettere `required: false` e rilanciare `insegnanti-template.test.ts` + `candidature-insegnanti-post.test.ts` | **1**, con **due** fallimenti (template + 400 mancato). Poi rimettere `true`. **Se non diventa rosso, l'obbligatorietà non è stata applicata davvero.** |
| B.j | `http://localhost:3100/lavora-con-noi`, passo «Il tuo profilo»: premere «Avanti» **senza** allegare | il passo **non** avanza e sotto il campo compare «Campo obbligatorio». ⚠️ **Non caricare nessun file dal browser** (scriverebbe nello Storage di produzione) e **non premere «Invia»**. Lo stato «CV allegato» si guarda **solo** nei test a componente, con l'endpoint finto. |

---

# § Punti di contatto A ↔ B — leggere prima di cominciare B

| File | Cosa fa A | Cosa fa B | Collisione? |
|---|---|---|---|
| `src/lib/forms/insegnanti-template.ts` | toglie la riga `disponibilita` (481) e la costante (322-329); aggiorna il commento a 50 | cambia `label` e `required` di `cv_path` e riscrive il commento sopra | **No** — regioni diverse. ⚠️ **Ma i numeri di riga si spostano di ~9**: B cerca `cv_path` con `grep`, mai per riga. |
| `__tests__/lib/insegnanti-template.test.ts` | test «select chiuse» (286-295) + un `it` nuovo | test «obbligatori/facoltativi» (244-253) | **No** — `it()` diversi |
| `__tests__/components/CandidaturaInsegnanteWizard-riepilogo.test.tsx` | toglie 203-205, 331 e `'disponibilita'` da `vuoti` (343) ⇒ **7** id | `compilaTutto` allega sempre; toglie `'cv_path'` da `vuoti` ⇒ **6** id | ⚠️ **SÌ, sulla stessa riga 343 e sulla stessa funzione `compilaTutto`.** A la lascia in uno stato **coerente e verde** (`cv_path` è ancora facoltativo e resta fra i vuoti); B **non disfa** nulla di A, toglie solo il secondo id e cambia la firma. **Ricontare a mano gli id: 7 dopo A, 6 dopo B.** |
| `__tests__/api/candidature-insegnanti-post.test.ts` | toglie `disponibilita` dalla fixture (389) | aggiunge `cv_path: CV_BUONO` alla **stessa** fixture, promuove `CV_BUONO` a livello di modulo, capovolge il test 722-726 | ⚠️ **SÌ, stessa fixture.** Nessuna sovrapposizione di righe, ma B deve **rileggere** la fixture dopo A invece di ricopiarla dal piano. |
| `__tests__/api/candidature-insegnanti-log-senza-pii.test.ts` | toglie `disponibilita` dalla fixture (178) e dal caso invalido (404) | nessuna modifica al codice; **verifica** che l'esito loggato contenga `cv_path` e resti ≤ 64 caratteri | **No** — ma il conto dei campi respinti va guardato **dopo B** (7 → 8), non dopo A. |
| `PRD REGISTRO ELETTRONICO.md` righe 4428-4429 | toglie `disponibilità` dai facoltativi (+ corregge `gradi` fra gli obbligatori) | sposta `curriculum` da facoltativi a obbligatori | ⚠️ **SÌ, due righe adiacenti toccate due volte.** B rilegge il file, non applica una patch preparata prima. |
| `messages/{it,en}/adminAltro.json` / `public.json` | **nessuna modifica** (adminAltro resta intatto) | cambia il **testo** di `candCvNota` in due lingue | **No** |
| `e2e/public-candidatura-insegnante.spec.ts` | **nessuna modifica** | predicato + upload vero + commento | **No** |

---

# § Il changelog del PRD — uno solo, alla fine dei due blocchi

AGENTS.md punto 2: una voce **datata** in cima al file (le voci più recenti stanno intorno alla
riga 97), sul modello delle esistenti. Deve contenere, come minimo:

- **la decisione e chi l'ha presa**: in Kidville si lavora solo a tempo pieno ⇒ la domanda
  «Disponibilità» è **rimossa secca** dal modulo pubblico; il curriculum diventa
  **obbligatorio**;
- **le misure fatte prima**, con la data del 2026-08-24: 230 candidature, **221** con
  disponibilità valorizzata, **95** senza curriculum, **0** in coda all'inoltro arretrato — e
  la frase che conta: *non ricopiare questi numeri, la query è una sola*;
- **cosa NON è stato fatto e perché**: nessuna migrazione, la colonna `disponibilita` resta con
  i suoi 221 valori, `cv_path` resta **nullable** perché 95 righe storiche lo hanno NULL —
  l'obbligatorietà è **applicativa**;
- **la decisione sulle 221 storiche**: la riga «Disponibilità» compare in segreteria solo
  quando il valore c'è, e le cinque etichette i18n restano vive con un **guardiano nuovo**
  (`CHIAVE_DISPONIBILITA` esportata e verificata dal lock dei cataloghi), perché quello vecchio
  leggeva dal template e sarebbe morto col campo;
- **la coda accettata a occhi aperti**: l'inoltro arretrato ai plessi deriva le colonne dal
  template e perderebbe la riga «Disponibilità» sulle candidature storiche — misurato: **0
  righe in coda**, perdita effettiva zero;
- **le tre conseguenze da tenere d'occhio**: gli **orfani** nel bucket cresceranno (spazzata a
  24 h ora portante), il booleano `con_cv` del log perde valore diagnostico, e l'E2E consuma
  ora **fino a 3 caricamenti** su 6 per run;
- **le due bugie preesistenti sistemate nella stessa passata**: `gradi` fra gli obbligatori del
  modulo (falso dal 15/08) e il blocco «Cosa il modulo NON rende» (falso dal 15/08).

---

# § Il gate finale, e come si legge

```bash
npx eslint . --max-warnings 0;                      echo "ESLINT=$?"
npx tsc --noEmit;                                   echo "TSC=$?"
npx vitest run > /tmp/finale.txt 2>&1; ESITO=$?;    echo "VITEST=$ESITO"; tail -8 /tmp/finale.txt
npm run build > /tmp/build.txt 2>&1;   ESITO=$?;    echo "BUILD=$ESITO";  tail -8 /tmp/build.txt
```

Tutti **0**. E poi le tre cose che un `0` non dice:

1. **il numero dei test eseguiti** non è calato rispetto alla baseline;
2. **almeno una prova del rosso è stata vista davvero** per blocco (A-6 e B-i): *un test mai
   visto fallire non è un test*;
3. **l'E2E non è stato provato** — gira in CI, e va scritto nel report invece che sottinteso.

**Vietato in questa sessione**: `npm run e2e` / `e2e:seed` (il seed scrive in **produzione**),
`npm install`, `git commit/checkout/stash/push/reset`, l'invio vero del modulo, il caricamento
di file dal browser, e qualunque `UPDATE`/`DELETE`/`DROP`/`ALTER` sul database.

---

# § Esito reale — aggiornato il 2026-08-25, h 12:08

Il piano è stato eseguito **per intero nei due blocchi previsti**, ma non è finito nella giornata
per cui era scritto, e questa sezione serve a non lasciar credere il contrario.

## Cosa è cambiato rispetto al piano

| il piano diceva | com'è andata |
|---|---|
| changelog datato **2026-08-24** con 230 / 221 / 95 | il lavoro è scivolato al **2026-08-25** e la voce porta quella data. I numeri del piano erano già superati quando li si è scritti |
| due blocchi, due esecutori, poi il gate | ai due blocchi si sono aggiunti **sei giri di rifinitura** (fuoco, lingua, geometria, collegamento a `/privacy`, ordine di nota e link) non previsti qui |
| `PRD` righe 4428-4429 da rileggere prima di toccarle | fatto: le due righe adiacenti sono state riscritte una volta sola, dopo rilettura |
| **0 righe in coda** all'inoltro arretrato ⇒ perdita zero | **confermato**: 0 il 24, 0 il 25, a ogni rimisurazione. La previsione ha retto |

## Le cifre finali, rimisurate e non ricopiate

Il piano prescriveva *«non ricopiare questi numeri, la query è una sola»*, e la prescrizione è stata
applicata al piano stesso: i valori del § 0.1 (2026-08-24) sono **storia**, non stato.

| rimisurato il 2026-08-25 alle **12:08** | |
|---|---|
| candidature totali | **237** (erano 230 nel piano) |
| con `disponibilita` valorizzata | **227** (erano 221) |
| **senza** `cv_path` | **98** (erano 95) — il **41,4%** |
| con `cv_path` | **139** |

⚠️ **Una previsione del PRD è stata smentita dalla rimisurazione, ed è la parte che vale.** La voce
di changelog affermava «la percentuale è la sola cosa stabile»: è il contrario. Fra le 01:30 e le
12:08 sono arrivate tre candidature **tutte col curriculum**, l'assoluto è rimasto fermo a **98** e a
muoversi è stata la percentuale (41,9% → 41,4%). `98` conta un insieme che il rilascio **chiude**; la
percentuale ha il totale al denominatore e cala da sola. Chi misurerà l'effetto dell'obbligo guardi
**il 98 e il totale nel tempo**, mai la percentuale.

## Stato al momento di questa riga

- **Gate** (come registrato nella voce di changelog, esiti catturati prima di ogni pipe):
  `eslint` 0 · `tsc` 0 · `vitest` 0 con **983 file / 12.351 test** · `build` 0.
  **E2E ancora da confermare in CI** — non è stato eseguito in locale, per divieto.
- **Lo stato dell'albero NON si legge qui**, e questa riga è la prova del perché: diceva «HEAD
  risponde `main`» e «51 file modificati», ed era già falsa quando la si rileggeva — il ramo era
  stato rimesso a posto a mano e i file erano cresciuti. Si misura, non si ricopia:
  `git rev-parse --abbrev-ref HEAD` · `git log --oneline main..HEAD` · `git status --porcelain | wc -l`.
- ✅ **Deriva CHIUSA il 2026-08-25 alle 19:26** — questa voce diceva «🔻 deriva aperta». Il «41,9%»
  viveva in **16 commenti**, e il denominatore stantio «234» in altri **7 punti**: 23 in tutto su 15
  file. La rimisurazione ha mostrato che erano sbagliati **tutti e tre i numeri** (`98 su 234, il
  41,9%` → **`100 su 248`**): erano commenti, nessuna asserzione li leggeva, e il gate restava verde.
  La cura non è stata aggiornarli — sarebbe stato lo stesso difetto rinviato di una settimana. La
  cifra vive ora **in un posto solo**, l'àncora `MISURA-CV` in `src/lib/forms/insegnanti-template.ts`,
  con la sua ORA e la sua query; gli altri 22 punti la **nominano** invece di ribatterla, e dicono
  «quattro su dieci», che è un ordine di grandezza e non una misura. Il lock
  `__tests__/architecture/misura-cv-un-posto-solo.test.ts` fa cadere il gate se torna — ed è stato
  **visto fallire apposta**: rimessa la cifra in un file del perimetro, esito **1** con `file:riga`
  esatto; ripristinato, esito **0**.
