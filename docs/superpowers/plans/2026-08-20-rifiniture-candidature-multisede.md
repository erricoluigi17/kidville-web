# Le quattro cose rimaste aperte dopo `candidature-multisede` — piano

> **Per chi esegue:** SKILL RICHIESTA — `superpowers:executing-plans`, con
> `test-driven-development` su ogni task che tocca comportamento e
> `systematic-debugging` sulla Fase D. Gli step hanno le caselle (`- [ ]`).

**Obiettivo:** chiudere i quattro punti che il titolare ha elencato il 2026-08-20 —
la sorveglianza mancante sul filtro di sede, la conservazione GDPR per riga di sede,
i due test instabili, e lo scaglione «minore» dei quattro fronti — più un difetto
**trovato durante la stesura di questo piano** e misurato sulla produzione.

**Architettura:** nessuna nuova astrazione. Due lock nuovi (uno funzionale nel finto,
uno strutturale sul sorgente), una funzione di scadenza che cambia forma, e
diciotto correzioni puntuali. Niente migrazioni di schema: la conservazione per riga
di sede si calcola in lettura, non si materializza.

**Stack:** Next.js App Router · Supabase/PostgREST · zod · Vitest + Testing Library
· next-intl · Claude in Chrome (per l'unica misura che va fatta in un browser vero).

**Specifica:** `docs/superpowers/specs/2026-08-20-rifiniture-candidature-multisede-design.md`

---

## Ordine, e perché è questo

La Fase B dipende dalla Fase A: il difetto nuovo — l'elenco che non riceve lo stato
di sede — **oggi non è dimostrabile**, perché il finto non materializza l'embed
filtrato. Prima si costruisce lo strumento di misura, poi si misura. Invertire
l'ordine significherebbe correggere alla cieca.

Tutto il resto è indipendente e può procedere in qualunque ordine.

---

# FASE A · La sorveglianza che manca sul filtro di sede

### Task A1: Il finto impara la semantica posizionale degli embed

**File:**
- Modifica: `__tests__/api/candidature-insegnanti-scope-sede.test.ts:95-145`
- Modifica (lo stesso finto, se duplicato): `__tests__/api/candidature-insegnanti-approva.test.ts`,
  `__tests__/api/candidature-insegnanti-rifiuta.test.ts`, `__tests__/api/candidature-insegnanti-gate.test.ts`
  — **verificare con `grep -n "sedi:candidature_sedi" __tests__/api/*.ts` quali lo contengono**

- [ ] **Step 1: censire i finti da istruire**

```bash
grep -ln "candidature_sedi" __tests__/api/*.ts __tests__/components/*.tsx
```

Se il finto è ricopiato in più file, **estrarlo in un helper condiviso**
`__tests__/helpers/finto-postgrest-embed.ts` prima di modificarlo: una regola valida
per due strade deve vivere in un posto solo (è la lezione di `shipcycle_ciclo2`).

- [ ] **Step 2: scrivere il test che il finto di oggi NON può passare**

In `__tests__/api/candidature-insegnanti-scope-sede.test.ts`, dentro un `describe`
nuovo «il finto riproduce la semantica posizionale di PostgREST»:

```ts
it('il filtro si lega al PRIMO embed della select, e solo a quello', async () => {
  // Una candidatura rivolta a DUE sedi, di cui chi guarda ne ha una sola.
  preparaCandidaturaSuDueSedi(SEDE_A, SEDE_B)

  const q = finto().from('candidature_insegnanti')
    .select(`id, candidature_sedi!inner(scuola_id, stato), sedi:candidature_sedi(scuola_id, stato)`)
    .in('candidature_sedi.scuola_id', [SEDE_A])
  const { data } = await q

  // L'embed FILTRATO porta solo la sede di chi guarda…
  expect(data[0].candidature_sedi.map((x: Riga) => x.scuola_id)).toEqual([SEDE_A])
  // …e quello DESCRITTIVO le porta tutte e due.
  expect(data[0].sedi.map((x: Riga) => x.scuola_id).sort()).toEqual([SEDE_A, SEDE_B].sort())
})

it('invertendo i due embed il filtro cambia bersaglio, e l’isolamento sparisce', async () => {
  preparaCandidaturaSuDueSedi(SEDE_A, SEDE_B)

  // ⚠️ L'ORDINE È SCAMBIATO: il descrittivo davanti, l'`!inner` dietro.
  const q = finto().from('candidature_insegnanti')
    .select(`id, sedi:candidature_sedi(scuola_id, stato), candidature_sedi!inner(scuola_id, stato)`)
    .in('candidature_sedi.scuola_id', [SEDE_A])
  const { data } = await q

  // Ora è `sedi` a essere filtrato — e `candidature_sedi`, che è l'array su cui
  // il codice si fida, porta TUTTE le sedi, compresa quella che non è di chi
  // guarda. È esattamente il difetto che questo finto deve saper vedere.
  expect(data[0].sedi.map((x: Riga) => x.scuola_id)).toEqual([SEDE_A])
  expect(data[0].candidature_sedi).toHaveLength(2)
})
```

- [ ] **Step 3: eseguirlo e vederlo FALLIRE**

```bash
npx vitest run __tests__/api/candidature-insegnanti-scope-sede.test.ts -t 'semantica posizionale'
```

Atteso: rosso. Il finto di oggi popola `sedi` cablato e non produce mai
`candidature_sedi` nella proiezione.

- [ ] **Step 4: implementare la semantica posizionale nel finto**

Sostituire il blocco `const conSedi = /sedi:candidature_sedi\s*\(/.test(cols)` e la
proiezione che segue con:

```ts
/**
 * GLI EMBED SU `candidature_sedi`, NELL'ORDINE IN CUI COMPAIONO NELLA `select`.
 *
 * ⚠️ L'ORDINE È IL PUNTO. PostgREST lega `.in('candidature_sedi.scuola_id', …)`
 * al PRIMO embed di quella tabella nella stringa, non a quello con `!inner`.
 * Un finto che ignorasse l'ordine non saprebbe distinguere la query giusta da
 * quella con le due costanti scambiate — e siccome è l'unico posto in cui la
 * differenza si può vedere, l'isolamento di sede resterebbe senza guardiano.
 * Misurato sulla produzione il 2026-08-20.
 */
const RE_EMBED = /(?:(\w+):)?candidature_sedi(!inner)?\s*\(([^)]*)\)/g
const embed = [...cols.matchAll(RE_EMBED)].map((m) => ({
  alias: m[1] ?? 'candidature_sedi',
  inner: m[2] === '!inner',
  colonne: m[3].split(',').map((c) => c.trim()).filter(Boolean),
}))
```

e la proiezione:

```ts
data: pagina.map((r) => {
  const proiettata = proietta(r, cols)
  const tutte = sediDi(h, r.id)
  embed.forEach((e, i) => {
    // Solo il PRIMO riceve il filtro: è la regola di PostgREST, non una scelta.
    const righe = i === 0 ? tutte.filter(passaIlFiltroDiSede) : tutte
    proiettata[e.alias] = righe.map((s) => proiettaColonne(s, e.colonne))
  })
  return proiettata
}),
```

dove `passaIlFiltroDiSede` legge i filtri con il punto (`candidature_sedi.<col>`) e
`proiettaColonne` tiene solo le colonne dichiarate nell'embed — **è questa seconda
cosa che rende visibile il difetto della Fase B**: un embed che non chiede `stato`
non lo consegna, come fa il database vero.

Lo scarto della riga quando il primo embed è `!inner` e l'insieme filtrato è vuoto
resta dove sta oggi (il predicato `corrisponde`), ma va reso coerente: se il primo
embed **non** è `!inner`, il filtro **non deve** scartare la riga.

- [ ] **Step 5: eseguire i due test nuovi e TUTTI quelli di scope**

```bash
npx vitest run __tests__/api/candidature-insegnanti-scope-sede.test.ts
npx vitest run __tests__/api/candidature-insegnanti-
```

Atteso: verdi. Se cade un test esistente, **non adattare l'asserzione**: quel test
stava misurando il finto cieco, e ciò che dice va riletto.

- [ ] **Step 6: commit**

```bash
git add __tests__/
git commit -m "Il finto impara che PostgREST lega il filtro al PRIMO embed"
```

---

### Task A2: Il lock d'architettura sull'ordine dei due embed

**File:** Crea `__tests__/architecture/embed-sede-posizionale.test.ts`

- [ ] **Step 1: scrivere il lock**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * L'ORDINE DEI DUE EMBED È UN CONTRATTO, E QUESTO LO SORVEGLIA.
 *
 * `.in('candidature_sedi.scuola_id', scuole)` si lega al PRIMO embed di quella
 * tabella nella stringa `select`, per POSIZIONE — non a quello con `!inner`.
 * Scambiare le due costanti sposta il filtro sull'embed descrittivo: l'`!inner`
 * smette di restringere e l'elenco mostra candidature di plessi che chi guarda
 * non ha. Nessun errore, nessun avviso: solo dati di più.
 *
 * Misurato sulla produzione il 2026-08-20 con una candidatura su due sedi.
 *
 * ⚠️ ROTTO APPOSTA per vederlo cadere: invertendo `EMBED_FILTRO_SCHEDA` ed
 * `EMBED_TUTTE` alla riga 393 della rotta, questo file diventa rosso con il
 * messaggio «l'embed che restringe non è il primo». Rimesso a posto, torna verde.
 */
const ROTTA = 'src/app/api/admin/candidature-insegnanti/route.ts'

describe('il filtro di sede si lega al primo embed: l’ordine è sorvegliato', () => {
  const src = readFileSync(join(process.cwd(), ROTTA), 'utf8')

  // Ogni catena `.select(...)` del file, con il suo intorno fino a `.maybeSingle`
  // o alla fine dell'espressione.
  const SELECT = /\.select\(\s*`([^`]+)`/g

  for (const m of [...src.matchAll(SELECT)]) {
    const proiezione = m[1]
    const embed = [...proiezione.matchAll(/(?:\$\{)?(\w+)(?:\})?/g)]
    // …risolve i riferimenti alle costanti `EMBED_*` leggendo le loro definizioni
    // dal sorgente, e poi verifica l'ordine.
  }
})
```

⚠️ **La risoluzione delle costanti va fatta e va fatta bene**: la `select` è un
template literal che interpola `${EMBED_FILTRO}`, non la stringa. Il lock legge le
definizioni `const EMBED_… = '…'` dallo stesso file e sostituisce. Se una costante
non si risolve, il lock **fallisce** invece di ignorarla — un rilevatore che tace su
ciò che non capisce non è un rilevatore.

Le due asserzioni, per ogni `select` con **due o più** embed su `candidature_sedi`:

1. il primo embed della stringa porta `!inner`;
2. nella stessa catena compare `.in('candidature_sedi.scuola_id'` — scritto per
   esteso, com'è già il contratto di `isolamento-sede-coverage`.

- [ ] **Step 2: eseguirlo — deve essere VERDE sul codice di oggi**

```bash
npx vitest run __tests__/architecture/embed-sede-posizionale.test.ts
```

- [ ] **Step 3: ROMPERLO APPOSTA e vederlo cadere**

```bash
# invertire i due embed alla riga 393 della rotta
npx vitest run __tests__/architecture/embed-sede-posizionale.test.ts   # atteso: ROSSO
git checkout -- src/app/api/admin/candidature-insegnanti/route.ts
npx vitest run __tests__/architecture/embed-sede-posizionale.test.ts   # atteso: verde
```

Scrivere nell'intestazione del file **che cosa si è visto**, non che si è provato.

- [ ] **Step 4: commit**

---

# FASE B · Il difetto trovato scrivendo questo piano

> **Non è nei rapporti dei quattro fronti.** È emerso rileggendo il codice per
> costruire il lock della Fase A, ed è stato **misurato sulla produzione** il
> 2026-08-20 (`scratchpad/verifica-embed-elenco.mjs`).

### Task B1: L'elenco non riceve lo stato della propria sede — e ripiega sull'aggregato

**Il difetto.** `statoDiRiga` (`CandidatureInsegnanti.tsx:942-945`) legge
`r.candidature_sedi[…].stato`. Ma l'elenco interroga con
`EMBED_FILTRO = 'candidature_sedi!inner(scuola_id)'` — **senza `stato`**. Il campo è
sempre `undefined`, la catena di `??` scivola fino a `r.stato`, e i tre contatori e
il badge d'elenco mostrano **l'aggregato**: cioè esattamente il difetto che il commit
`84a91ef5` dichiara chiuso. TypeScript non lo vede perché il tipo dichiara `stato?`
opzionale.

Misura, contro la produzione:

```
candidatura a16c6bc3 | aggregato: pending
  | embed FILTRATO: [{"scuola_id":"d53b0fbc-…"}]   ← nessun `stato`
  | embed sedi:      [{"stato":"pending","scuola_id":"d53b0fbc-…"}]
```

**Files:**
- Modifica: `src/app/api/admin/candidature-insegnanti/route.ts:193, 221, 423`
- Test: `__tests__/api/candidature-insegnanti-scope-sede.test.ts`

- [ ] **Step 1: il test rosso** (possibile solo dopo A1)

```ts
it('l’elenco porta lo stato DELLA PROPRIA SEDE, non l’aggregato', async () => {
  // Giugliano ha già approvato, Aversa sta ancora valutando: l'aggregato è
  // `pending`, ma chi guarda da Giugliano ha chiuso.
  preparaCandidatura({ aggregato: 'pending', sedi: [
    { scuola_id: SEDE_A, stato: 'approvata' },
    { scuola_id: SEDE_B, stato: 'pending' },
  ] })
  const res = await GET(richiestaElenco({ sedi: [SEDE_A] }))
  const { righe } = await res.json()
  expect(righe[0].candidature_sedi[0].stato).toBe('approvata')
})
```

- [ ] **Step 2: eseguirlo, vederlo rosso** (`stato` è `undefined`)

- [ ] **Step 3: la correzione**

```ts
/**
 * L'embed che RESTRINGE **per l'elenco**: il plesso e il suo stato.
 *
 * ⚠️ `stato` NON È FACOLTATIVO, ed è il difetto che questa riga chiude. Prima qui
 * c'era solo `scuola_id`, mentre `statoDiRiga` nel componente legge
 * `candidature_sedi[…].stato`: il campo arrivava `undefined`, la catena di `??`
 * scivolava fino all'aggregato, e i tre contatori mostravano il numero che il
 * commit `84a91ef5` dichiarava di aver corretto. Il tipo lo dichiara opzionale,
 * quindi TypeScript non poteva dirlo. Misurato sulla produzione il 2026-08-20.
 *
 * È FILTRATO, quindi lo stato che porta è solo quello delle proprie sedi: non è
 * la stessa cosa di `EMBED_ELENCO`, che li portava tutti.
 */
const EMBED_FILTRO_ELENCO = 'candidature_sedi!inner(scuola_id, stato)'
```

e alla riga 423: `.select(\`${colonne}, ${EMBED_FILTRO_ELENCO}\`, { count: 'exact' })`
— **senza `EMBED_ELENCO`**, che chiude anche il rilievo `F5-m2` (vedi Task E2b).

`EMBED_FILTRO` (solo `scuola_id`) resta per le righe 465 e 659, dove lo stato non
serve.

- [ ] **Step 4: verde, e verificare che il lock A2 regga** (una `select` con UN solo
      embed non deve far cadere il lock)

- [ ] **Step 5: misurare di nuovo contro la produzione**, in sola lettura, con la
      `select` nuova, e incollare l'esito nel commento.

- [ ] **Step 6: commit**

---

# FASE C · La conservazione GDPR per riga di sede

### Task C1: La scadenza si calcola per riga e si prende la più lontana

**Files:**
- Modifica: `src/app/api/gdpr/retention-candidature/route.ts` (`termine()`, la lettura, le costanti)
- Test: `__tests__/api/gdpr-retention-candidature.test.ts`

- [ ] **Step 1: il test rosso — il caso misto**

```ts
it('il caso MISTO conserva fino a dodici mesi dall’ULTIMA decisione, non dalla ricezione', async () => {
  // Ricevuta 13 mesi fa; Aversa ha rifiutato UN MESE FA; Giugliano ha approvato.
  // L'aggregato dice `approvata` → la regola vecchia farebbe decorrere il termine
  // dalla RICEZIONE e la cancellerebbe oggi, portandosi via il verbale del
  // rifiuto di Aversa dodici mesi prima del dovuto.
  preparaCandidatura({
    creata_il: mesiFa(13), stato: 'approvata', evasa_il: mesiFa(1),
    sedi: [
      { scuola_id: SEDE_A, stato: 'approvata', evasa_il: mesiFa(1) },
      { scuola_id: SEDE_B, stato: 'rifiutata', evasa_il: mesiFa(1) },
    ],
  })
  const res = await POST(richiestaCron())
  const corpo = await res.json()
  expect(corpo.candidature_scadute).toBe(0)
})

it('e quando ANCHE l’ultima decisione ha più di dodici mesi, si cancella', async () => {
  preparaCandidatura({
    creata_il: mesiFa(30), stato: 'approvata', evasa_il: mesiFa(14),
    sedi: [
      { scuola_id: SEDE_A, stato: 'approvata', evasa_il: mesiFa(14) },
      { scuola_id: SEDE_B, stato: 'rifiutata', evasa_il: mesiFa(14) },
    ],
  })
  const corpo = await (await POST(richiestaCron())).json()
  expect(corpo.candidature_scadute).toBe(1)
})

it('senza `candidature_sedi` (CI non migrata) degrada alla regola di oggi e LO DICE', async () => {
  finto.erroreRelazione = { code: 'PGRST200', message: 'Could not find a relationship' }
  preparaCandidatura({ creata_il: mesiFa(13), stato: 'approvata' })
  const corpo = await (await POST(richiestaCron())).json()
  expect(corpo.candidature_scadute).toBe(1)
  expect(logEvento).toHaveBeenCalledWith('gdpr', 'warn',
    expect.objectContaining({ esito: 'sedi-non-leggibili', codice: 'PGRST200' }))
})
```

- [ ] **Step 2: eseguirli, vederli rossi** (il primo passa `1` invece di `0`)

- [ ] **Step 3: la lettura porta le righe di sede**

Aggiungere l'embed **non filtrato** alla `select` (il cron gira come cron, non per
sede: deve vedere tutte le decisioni):

```ts
const EMBED_SEDI = 'candidature_sedi(stato, evasa_il)'
```

con degrado: se la lettura fallisce con `PGRST200`/`42P01`/`PGRST205`, **rifarla
senza l'embed** e loggare `warn` con `esito: 'sedi-non-leggibili'` e il codice. Mai
saltare la spazzata: una conservazione che non gira è peggio di una approssimata.

- [ ] **Step 4: `termine()` diventa `scadenza()`**

```ts
/**
 * LA SCADENZA DELLA CANDIDATURA È LA PIÙ LONTANA FRA QUELLE DELLE SUE SEDI.
 *
 * ─── PERCHÉ NON BASTA UNA DATA SOLA ─────────────────────────────────────────
 * `candidature_insegnanti.evasa_il` è UNA colonna e porta il termine di PIÙ
 * trattamenti: una candidatura rivolta a tre plessi porta tre decisioni. Il
 * trigger ci scrive `max()`, che è il verso che conserva di più — ma
 * l'aggregato `stato` è un'altra cosa ancora, e nel caso MISTO le due cose
 * insieme sbagliano.
 *
 * Aversa rifiuta a novembre, Giugliano approva a dicembre, la candidatura è
 * arrivata a gennaio. L'aggregato vale `approvata`, quindi il termine decorre
 * dalla RICEZIONE: si cancella a gennaio, DUE MESI dopo il rifiuto di Aversa
 * invece dei dodici promessi dall'informativa. Il verbale sparisce prima del
 * dovuto — la stessa classe di difetto che la migrazione `20260820004500` ha
 * chiuso su un altro percorso.
 *
 * ─── LA REGOLA, PER RIGA ────────────────────────────────────────────────────
 *   riga `rifiutata`  → dalla SUA decisione
 *   riga `approvata`  → dalla ricezione
 *   riga `pending`    → dalla ricezione
 * e la candidatura si cancella quando è scaduta l'ULTIMA.
 *
 * La DURATA (12 / 24 mesi) resta una proprietà della PERSONA, non della riga:
 * dipende dal consenso, e il consenso è uno solo.
 *
 * ⚠️ Nei casi non misti non cambia NIENTE: tutte rifiutate → l'ultima decisione,
 * identico a `max(evasa_il)`; tutte approvate o mai valutate → la ricezione,
 * identico a prima. Cambia solo il misto, e nel verso che conserva.
 */
function scadenza(riga: Candidatura, consensoIgnoto: boolean): Date | null
```

Senza righe di sede (degrado), `scadenza` ricade sulla regola di oggi — la funzione
`termine()` resta, privata, e diventa il ramo di ripiego.

- [ ] **Step 5: verdi, e la suite del file intera**

```bash
npx vitest run __tests__/api/gdpr-retention-candidature.test.ts
```

- [ ] **Step 6: aggiornare il commento della migrazione che oggi rimanda a questo lavoro**

`supabase/migrations/20260820020000_candidature_sede_decisione_intera.sql:130-132`
dice «la correzione onesta sarebbe la conservazione per riga di sede. Quando la si
farà, questa colonna diventerà derivata e questo commento si potrà cancellare».
**La si è fatta.** Il commento va riscritto: da oggi `max(evasa_il)` sulla madre è
un valore di comodo per l'interfaccia, e **non è più la base di un termine di
legge** — chi conserva legge le righe.

⚠️ Il file di migrazione è già applicato in produzione: **non si riscrive una
migrazione applicata**. Il commento aggiornato va in una migrazione NUOVA che
ridefinisce la funzione con lo stesso corpo e il commento corretto, oppure — più
onesto e più economico — con `comment on function` e una nota nel file nuovo che
rimanda a questo lavoro. Scegliere la seconda.

- [ ] **Step 7: commit**

---

# FASE D · I due test instabili

> **Skill: `systematic-debugging`.** Riprodurre prima di correggere. Non correggere
> ciò che non si riproduce.

### Task D1: La campagna di riproduzione

- [ ] **Step 1: i due file da soli, dieci volte ciascuno**

```bash
for i in $(seq 1 10); do
  npx vitest run __tests__/components/CandidatureInsegnanti.test.tsx --reporter=dot \
    || echo "CADUTO al giro $i"
done
for i in $(seq 1 10); do
  npx vitest run __tests__/components/StaffDetailPanel-anagrafica.test.tsx --reporter=dot \
    || echo "CADUTO al giro $i"
done
```

- [ ] **Step 2: i due insieme, e in ordine invertito** (l'ipotesi più probabile è una
      dipendenza d'ordine: fuoco lasciato sporco, `cleanup` mancante, timer non finto)

```bash
npx vitest run __tests__/components/CandidatureInsegnanti.test.tsx __tests__/components/StaffDetailPanel-anagrafica.test.tsx
npx vitest run __tests__/components/StaffDetailPanel-anagrafica.test.tsx __tests__/components/CandidatureInsegnanti.test.tsx
```

- [ ] **Step 3: la suite intera, tre volte, con `--sequence.shuffle`**

```bash
for i in 1 2 3; do npx vitest run --sequence.shuffle --reporter=dot | tail -5; done
```

- [ ] **Step 4a — SE si riproduce:** isolare la causa (quale test precedente lascia il
      fuoco, quale `afterEach` manca), correggere **alla radice**, e aggiungere
      l'asserzione che la sorveglia. Poi rieseguire la campagna.

- [ ] **Step 4b — SE non si riproduce** in tutti i tentativi sopra: **non toccare
      niente.** Scrivere in `docs/collaudo/` (o nel PRD) quante volte si è provato,
      con quali comandi e con quale esito, e dichiararlo al titolare come **non
      riprodotto**, non come risolto. Inventare una correzione per un difetto che non
      si sa riprodurre significa aggiungere codice che nessuno può falsificare.

- [ ] **Step 5: commit** (anche solo della nota, se l'esito è 4b)

---

# FASE E · Lo scaglione «minore», e i medi rimasti sotto

Ogni task qui è indipendente. Commit per task o per gruppo coerente.

### Task E1: L'uuid confrontato come stringa grezza

**File:** `src/app/api/admin/candidature-insegnanti/route.ts:511` ·
`src/lib/auth/scope.ts` (esportare `formaConfronto`, se non lo è)
**Test:** `__tests__/api/candidature-insegnanti-scope-sede.test.ts`

- [ ] **Step 1: il test rosso** — un PATCH con `scuola_id` in **MAIUSCOLO** sulla
      propria sede deve riuscire, non dare 404.

```ts
it('accetta la PROPRIA sede anche scritta in maiuscolo (un uuid non è una stringa)', async () => {
  const res = await PATCH(richiestaPatch({ id, action: 'approva', scuola_id: SEDE_A.toUpperCase() }))
  expect(res.status).toBe(200)
})
it('e continua a negare la sede ALTRUI, maiuscola o no', async () => {
  const res = await PATCH(richiestaPatch({ id, action: 'approva', scuola_id: SEDE_ALTRUI.toUpperCase() }))
  expect(res.status).toBe(404)
})
```

Il secondo è il **controllo negativo**, e non è facoltativo: normalizzare è un
confronto, non un permesso.

- [ ] **Step 2: rosso** — `z.guid()` accetta il maiuscolo e `.includes()` lo rifiuta.
- [ ] **Step 3:** esportare `formaConfronto` da `scope.ts` e usarla:
      `scuole.some((s) => formaConfronto(s) === formaConfronto(sedeDichiarata))`,
      e **portare avanti la forma canonica**, non quella del client.
- [ ] **Step 4: verdi.** **Step 5: commit.**

### Task E2: I dati che viaggiano senza che nessuno li disegni

**(a) `motivo_rifiuto` fuori da `COLONNE_DETTAGLIO`** — `route.ts:254`.

- [ ] Test: la GET `?id=` **non** contiene `motivo_rifiuto` al primo livello (quello
      della sede lo porta l'embed filtrato, e resta).
- [ ] Togliere la voce dall'array e scrivere accanto perché: è testo libero di
      giudizio su una persona, non filtrato per sede, che nessuno scrive più e
      nessuno rende — e il giorno di un import tornerebbe a uscire verso ogni plesso
      in scope senza che una riga di codice cambi.
- [ ] Verificare che `mia.motivo_rifiuto` (embed filtrato, `route.ts:1600` del
      componente) continui ad arrivare: **è quello che il pannello disegna**.

**(b) `EMBED_ELENCO` fuori dall'elenco** — già fatto nel Task B1 Step 3. Qui si
verifica soltanto, e si toglie la costante se non ha più chiamanti.

- [ ] `grep -n "EMBED_ELENCO" src/` → nessun uso ⇒ cancellarla, spostando la sua
      dottrina («l'elenco è povero») nel commento di `EMBED_FILTRO_ELENCO`.

### Task E3: I commenti che dicono il falso

Nessuno di questi cambia comportamento. **Nessuno di questi è cosmetico**: in questo
repo i commenti sono il posto dove vive la memoria delle misure, e uno che mente
costa più di nessun commento — è già successo due volte in questo stesso lavoro.

- [ ] **(a)** `__tests__/components/PublicPageHeader-logo.test.tsx:99-102` — riscrivere:
      la pagina che passa `children` è `/cancellazione-account`, non `/iscrizione`;
      `/iscrizione` non usa questo componente e non ha nessun `LanguageSwitcher`;
      via «delle cinque». Correggere anche «renso» → «reso».
- [ ] **(b)** `src/components/ui/MarchioKidville.tsx` — tre affermazioni da correggere:
      le testate sono **tre** (la terza ricopiata a mano in
      `/cancellazione-account/conferma`); la `grep` prescritta **non può** rilevare
      la classe di difetto per cui il file è nato — il metodo giusto è quello di
      `prefissi-pubblici.test.ts`, che parte da `PUBLIC_PREFIXES` e cammina
      `src/app`; e «definito UNA volta» è falso finché
      `src/app/auth/login/page.tsx:758` monta l'`<Image>` a mano.
- [ ] **(c)** `src/app/api/admin/candidature-insegnanti/route.ts:1043-1048` — `rifiuta()`
      passa `da: ['pending', 'in_approvazione']` a `candidature_sedi`, il cui `CHECK`
      ammette solo `pending|approvata|rifiutata`. Togliere il valore morto e
      riscrivere il commento: quello stato su **quella** tabella non può esistere.
      ⚠️ Verificare prima che `cambiaStato` non usi lo stesso array anche sulla
      tabella madre — se sì, il valore va tolto **solo** dal ramo delle righe di sede.
- [ ] Commit dei tre insieme.

### Task E4: Il singolare rimasto in un flusso diventato plurale

**File:** `messages/it/public.json`, `messages/en/public.json`

- [ ] Sei chiavi: `candContestoTempi`, `candInviataCorpo`, `candRiepilogoNota`,
      `candRiepilogoControllaEmail`, `candSedeRifiutataNota` / `…NotaAttesa`,
      `candSedeRifiutataCorpoScelta`. Portarle al plurale coerente con
      `candContestoDirezione` («ciascuna la valuta per conto suo»), **it e en**.
- [ ] ⚠️ Verificare che non esista un lock di parità fra i due cataloghi che cade
      (`grep -rn "public.json" __tests__/`), e che nessuna delle sei sia usata anche
      in un flusso a sede singola dove il plurale stonerebbe.
- [ ] Commit.

### Task E5: La conferma alla candidata

**File:** `src/lib/email/messaggi/conferma-candidatura.ts:63` ·
`src/app/api/iscrizione/insegnanti/route.ts:1477-1482`

- [ ] **(a) Il piede.** `motivo` dice «hai inviato una candidatura a ${sede.nome}»
      mentre il corpo elenca tre sedi. Deve nominare **le sedi scelte**, con il
      ripiego su `sede.nome` quando l'elenco è vuoto. La **carta intestata** resta di
      una sede sola e va bene: una email, una carta — ma va scritto nel commento che
      è una scelta, non una dimenticanza.
- [ ] **(b) Il ruolo «Altro».** Chi spunta «Altro» legge «Ruolo: Altro (specifica qui
      sotto)» — l'istruzione del modulo al posto del mestiere — e ciò che ha scritto
      (`posizione_altro`) non compare. Quando il valore è `altro` e
      `posizione_altro` è compilato, stampare **quello**. Test su entrambi i rami,
      compreso `altro` con `posizione_altro` vuoto (ripiego su un'etichetta pulita,
      mai sull'istruzione).
- [ ] Commit.

### Task E6: Il 400 che non dice quale sede ha rifiutato

**File:** `src/app/api/iscrizione/insegnanti/route.ts:828-845` ·
`src/components/features/public/CandidaturaInsegnanteWizard.tsx:995`

- [ ] **Step 1: il test rosso** — con `[valida, non_valida]`, il corpo del 400 deve
      elencare **la non valida**, e il client deve marcare quella.
- [ ] **Step 2:** il server aggiunge `sedi_rifiutate: string[]` al corpo. ⚠️ Non è una
      fuga: sono gli uuid **che il client ha appena mandato**. Il log resta un
      conteggio, come oggi.
- [ ] **Step 3:** il client chiama `sedeSmentitaDalServer` su **quelle**, non su
      `sedi[0]`; con l'elenco assente (server vecchio) ripiega sul comportamento di
      oggi e lo dice nel commento.
- [ ] **Step 4:** il messaggio al singolare/plurale segue il numero di sedi rifiutate
      (si appoggia alle chiavi del Task E4).
- [ ] **Step 5: verdi. Step 6: commit.**

### Task E7: Tetti e forme di risposta

**File:** `src/app/api/iscrizione/insegnanti/route.ts:196-239, 1272`

- [ ] **(a) Il tetto derivato.** `MAX_SEDI_PER_CANDIDATURA = 3` è cablato mentre il
      commento accanto dice che decide `sediReali`. Zod non può conoscerle: tenere
      in zod un **tetto strutturale** alla lunghezza grezza (`.max(50)` — chiude
      anche il rilievo (b)) e spostare il tetto **vero** dopo `sediReali`, dove il
      numero è noto, con un codice d'errore proprio (`TROPPE_SEDI`).
- [ ] **(b) Il messaggio arriva.** `mappaErroriServer` cerca `campi`/`consensi` e
      `scuole_ids` non è un campo del modulo: oggi il rifiuto diventa «Si è
      verificato un errore durante l'invio». Aggiungere `TROPPE_SEDI` al catalogo e
      una chiave in `messages/{it,en}/public.json` che **nomina la causa**.
- [ ] **(c) `{ "id": null }`.** Nel ramo `duplicata-riga-viva-non-trovata` la
      risposta esce con `id: null`, contro la dottrina scritta nello stesso file
      («una risposta di forma diversa È l'oracolo»). Restituire una forma
      **dichiaratamente diversa** — `{ esito: 'gia-presente' }`, 200 — e adeguare il
      client, che oggi non legge il corpo. ⚠️ Verificare che nessun altro chiamante
      si aspetti `id`.
- [ ] **(d) `stessa_sede` guarda solo la prima.** `route.ts:1275` confronta la sede
      viva con `scuoleRichieste[0]`: deve dire se è fra **quelle richieste**. È la
      metrica citata come «l'unico modo di contare in SQL quante candidature cercano
      un secondo plesso», quindi oggi quel conteggio è sbagliato.
- [ ] Test per ognuno. Commit.

### Task E8: Il pannello sopravvive al cambio di sedi

**File:** `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx:636`

- [ ] **Step 1: il test rosso** — aperto il pannello su una candidatura di Cesa, si
      toglie Cesa dalle sedi attive: il pannello deve **chiudersi**.
- [ ] **Step 2:** l'effetto che ricarica su `reFetchKey` azzera anche `selezionata` e
      `sedeScelta`. ⚠️ Non azzerarli quando `reFetchKey` cambia per una ragione che
      **non** è il cambio di sedi (una ricarica dopo una decisione): verificare da
      che cosa è composto `reFetchKey` prima di scrivere, e se contiene anche altro,
      distinguere.
- [ ] **Step 3: verde. Step 4: commit.**

### Task E9: I pulsanti accesi su un percorso che non può riuscire

**File:** `src/components/features/admin/iscrizioni/CandidatureInsegnanti.tsx:1328-1331`

- [ ] **Step 1: il test rosso** — senza righe di sede (ambiente non migrato), i due
      pulsanti sono **disabilitati** e il motivo è scritto a schermo.
- [ ] **Step 2:** il **badge** può continuare a ripiegare sull'aggregato — dice una
      cosa vera, anche se grossolana. I **pulsanti** no: `cambiaStato` degrada solo
      sulla colonna assente, non sulla tabella assente, quindi ogni «Approva»
      prenderebbe `42P01` e tornerebbe 503. Un ordine ineseguibile dato all'infinito
      è il difetto che il commento sopra denuncia: qui è la stessa cosa da un'altra
      porta.
- [ ] **Step 3:** riscrivere il commento del ripiego, che oggi promette un servizio
      che non c'è.
- [ ] **Step 4: verde. Step 5: commit.**

---

# FASE F · L'unica misura che va fatta in un browser

### Task F1: `/iscrizione` a 320 e 360 px

Il marchio aggiunge ~250 px a una riga `flex` **senza `flex-wrap`**, contro 320 px
disponibili. È aritmetica su valori dichiarati in commenti: **non è una misura**.

- [ ] **Step 1: avviare il server locale** con la chiave che funziona (la
      `SUPABASE_SERVICE_ROLE_KEY` di `.env.local` non è quella del progetto):

```bash
K=$(supabase projects api-keys --project-ref uimulkjyekgemjakmepp --experimental -o json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(r=>r.name==='service_role').api_key))")
SUPABASE_SERVICE_ROLE_KEY="$K" npx next dev --port 3100
```

- [ ] **Step 2: misurare** con Claude in Chrome (`claude --chrome` + `select_browser`),
      a 320 e 360 px di viewport:

```js
const c = document.querySelector('main .max-w-2xl') ?? document.querySelector('main')
JSON.stringify({ scrollWidth: c.scrollWidth, clientWidth: c.clientWidth,
                 bodyScroll: document.body.scrollWidth, innerWidth: window.innerWidth })
```

- [ ] **Step 3a — SE la riga trabocca:** `flex-wrap` sul contenitore e `shrink-0` dove
      serve, poi **rimisurare**. La correzione è verde solo quando la misura lo dice,
      non quando il codice sembra giusto.
- [ ] **Step 3b — SE non trabocca:** scrivere nel commento di `MarchioKidville.tsx`
      **la misura**, con la data — così il prossimo che fa quell'aritmetica trova la
      risposta invece di rifarla.
- [ ] **Step 4: commit.**

---

# FASE G · Chiusura

### Task G1: Il gate, e la suite tre volte

- [ ] `npx eslint . --max-warnings 0`
- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run` — **tre volte di fila**, tutte verdi (è la prova della Fase D)
- [ ] `npm run build`

### Task G2: Il PRD

- [ ] Voce di changelog datata **2026-08-20** in `PRD REGISTRO ELETTRONICO.md`, che
      dica anche **che cosa è stato trovato**, non solo che cosa funziona: il difetto
      della Fase B (l'embed senza `stato`) è la cosa più utile da sapere fra sei
      mesi, perché è un lock che *sembrava* chiuso.

### Task G3: I due punti che restano aperti, dichiarati

- [ ] Il **tetto delle email** resta una decisione del titolare.
- [ ] Il **marchio** su `/cancellazione-account/conferma` e `/m/[token]` e il **lock
      derivato da `PUBLIC_PREFIXES`** restano debito preesistente, fuori da questo
      diff. Scriverlo, non lasciarlo intendere.
