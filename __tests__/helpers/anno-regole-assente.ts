/**
 * Un client finto fatto a mano (non il `creaFintoSupabase`) non conosce `anno_regole`: lo specchio fase B
 * (`conFaseB`, in `@/lib/anno/scrittura`) la legge con `.select().limit(1).maybeSingle()`. Dalla correzione 3 dell'ondata
 * 4.3 un guasto di lettura dell'interruttore NON è più la fase A (torna fase B, e se il database è giù la scrittura si
 * ferma), quindi un finto che lancia o risponde a caso su quella tabella cambierebbe strada ai test che parlano d'altro.
 *
 * `conSchemaIndietro(client)` dice la verità sul DB della CI: la tabella non c'è (42P01 = schema indietro = fase A), e
 * ogni altra tabella passa al client vero. Lo schema assente NON è un guasto: è il caso che la fase A esiste per coprire.
 */
type ConFrom = { from: (...argomenti: never[]) => unknown }

export const lettureAnnoRegoleAssente = {
  select: () => ({
    limit: () => ({
      maybeSingle: async () => ({ data: null, error: { code: '42P01', message: 'relation "anno_regole" does not exist' } }),
    }),
  }),
}

export function conSchemaIndietro<T extends ConFrom>(client: T): T {
  const from = client.from as unknown as (tabella: string) => unknown
  return {
    ...client,
    from: (tabella: string) => (tabella === 'anno_regole' ? lettureAnnoRegoleAssente : from.call(client, tabella)),
  } as unknown as T
}
