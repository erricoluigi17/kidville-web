---
paths:
  - "src/app/api/**/*.ts"
---

# Route API — il pattern, e i due lock che lo impongono

Ogni route nasce con **tre** cose separate: l'involucro di osservabilità, il gate di ruolo, la
validazione. `withRoute` è **solo** osservabilità: non autentica e non valida niente.

```ts
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/http'
import { withRoute } from '@/lib/logging/with-route'

const getQuerySchema = z.object({ /* … */ })

export const GET = withRoute('gruppo/route:GET', async (request: Request) => {
  const q = parseQuery(request, getQuerySchema)
  if ('response' in q) return q.response      // ParseResult: o `data` o `response`
  // … gate di ruolo, poi il lavoro
})
```

## I due lock che falliscono se sbagli

- **`__tests__/architecture/logging-coverage.test.ts`** — fallisce se un export HTTP resta **nudo**,
  cioè non avvolto in `withRoute`.
- **`__tests__/api/zod-coverage.test.ts`** — *attenzione: sta in `__tests__/api/`, non in
  `architecture/`* — impone la validazione `zod` sugli ingressi.

Helper in `@/lib/validation/http`: `parseBody` · `parseQuery` · `parseMultipart` · `parseData` ·
`validationError`. Tornano `ParseResult<T>`, mai un'eccezione: si controlla con `'response' in x`.

## Gate di ruolo — dentro il corpo, non nell'involucro

Disponibili in `src/lib`: `requireStaff` · `requireDocente` · `requireArea` · `requireFunzione` ·
`requireKitchenRead` · `requireParentOfStudent` · `requireSessioneAuth` · `requireUser`
(e `requireEnv`, che è un'altra cosa: variabili d'ambiente).

Le route admin usano il pattern **service-role**: `createAdminClient` da
`@/lib/supabase/server-client` **+** gate applicativo. La service-role scavalca le RLS: senza il
gate la route è aperta a chiunque sia autenticato.

## 🔴 PostgREST non lancia: ritorna `{ error }`

Un `try/catch` attorno a `await supabase.from(…)` **non scatta mai**. Va controllato il valore di
ritorno. Il `fetch` strumentato logga ogni `!res.ok`, ma il codice deve *gestire* l'errore, non
lasciarlo solo registrare.

## 🔴 Tre sedi di produzione: ogni scrittura dichiara la sua

Giugliano, Aversa, Cesa — più la sede fittizia `e2e00000-…` della CI, da **escludere** da ogni
elenco pubblico. (Gli uuid non si scrivono qui: il lock `migrazioni-senza-sede-cablata` vieta di
cablarli, e scansiona anche `.claude/`.) `resolveScuolaScrittura` risponde **400** quando
l'utente ha più di una sede e nessuna è indicata. Una route che *indovina* la sede archivia i dati
nel plesso sbagliato **in silenzio**: non c'è errore, non c'è log, e te ne accorgi mesi dopo.

## Logging (le regole intere stanno in AGENTS.md)

- Mai `console.*`: `logOk` / `logErrore` / `logEvento` da `@/lib/logging/logger`.
- Provider esterni **solo** via `externalFetch()`, e **il corpo dell'errore non si butta mai via**:
  `403` non dice niente, `403 "the domain is not verified"` dice tutto.
- Un `catch` che non logga è un bug. Configurazione mancante = livello `error`, mai `info`.
- Gli eventi critici loggano **anche il successo**: senza, «nessun log» non distingue «tutto ok» da
  «non è mai partito niente».
- Mai dati personali nei log: `@/lib/logging/redact` è a **lista bianca**. Non aggiungerci un campo
  «perché sarebbe comodo vederlo»: sono dati di minori.

## Note

- `utenti.role` è una colonna **generata** da `ruolo`: non scriverla mai.
- Il repository è **pubblico**: mai segreti, mai PII reali in codice, test o commenti.
