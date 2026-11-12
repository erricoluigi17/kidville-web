// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Il middleware lascia a questi handler la verifica della chiave di integrazione.
// Il gate deve aprire l'handler, seguito subito dal ritorno dell'eventuale rifiuto.
const RADICE = path.join(process.cwd(), 'src', 'app', 'api', 'crm', 'ai')
const METODI = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const SENZA_WRAPPER = 'serve export const con withRoute'
const SENZA_GATE = 'serve requireIntegrazioneAi sulla richiesta come prima istruzione'
const SENZA_RIFIUTO = 'serve restituire subito la risposta del gate in caso di rifiuto'

type Verifica = { metodo: string; errore?: string }

function identificatore(nodo: ts.Node | undefined, nome: string): nodo is ts.Identifier {
  return !!nodo && ts.isIdentifier(nodo) && nodo.text === nome
}

function chiamaImportato(controllo: ts.TypeChecker, funzione: ts.Expression, modulo: string, nome: string): boolean {
  if (!identificatore(funzione, nome)) return false
  const [dichiarazione] = controllo.getSymbolAtLocation(funzione)?.declarations ?? []
  if (!dichiarazione || !ts.isImportSpecifier(dichiarazione) || dichiarazione.isTypeOnly ||
      (dichiarazione.propertyName ?? dichiarazione.name).text !== nome) return false
  const clausola = dichiarazione.parent.parent
  const importazione = clausola.parent
  return !clausola.isTypeOnly && ts.isImportDeclaration(importazione) &&
    ts.isStringLiteral(importazione.moduleSpecifier) && importazione.moduleSpecifier.text === modulo
}

function nomiDichiarati(nome: ts.BindingName): string[] {
  if (ts.isIdentifier(nome)) return [nome.text]
  return nome.elements.flatMap(elemento => ts.isBindingElement(elemento) ? nomiDichiarati(elemento.name) : [])
}

function restituisceRifiuto(controllo: ts.Statement | undefined, risultato: string): boolean {
  if (!controllo || !ts.isIfStatement(controllo)) return false
  const condizione = controllo.expression
  if (!ts.isBinaryExpression(condizione) || condizione.operatorToken.kind !== ts.SyntaxKind.InKeyword ||
      !ts.isStringLiteral(condizione.left) || condizione.left.text !== 'response' ||
      !identificatore(condizione.right, risultato)) return false

  const ramo = controllo.thenStatement
  const ritorno = ts.isBlock(ramo) && ramo.statements.length === 1 ? ramo.statements[0] : ramo
  const risposta = ts.isReturnStatement(ritorno) ? ritorno.expression : undefined
  return !!risposta && ts.isPropertyAccessExpression(risposta) &&
    identificatore(risposta.expression, risultato) && risposta.name.text === 'response'
}

function verificaHandler(controllo: ts.TypeChecker, inizializzatore: ts.Expression | undefined): string | undefined {
  if (!inizializzatore || !ts.isCallExpression(inizializzatore) ||
      !chiamaImportato(controllo, inizializzatore.expression, '@/lib/logging/with-route', 'withRoute')) return SENZA_WRAPPER

  const callback = inizializzatore.arguments[1]
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isBlock(callback.body)) return SENZA_WRAPPER

  const richiesta = callback.parameters[0]?.name
  const [prima, seconda] = callback.body.statements
  const lista = prima && ts.isVariableStatement(prima) ? prima.declarationList : undefined
  const gate = lista?.declarations.length === 1 ? lista.declarations[0] : undefined
  const attesa = gate?.initializer
  if (!gate || !ts.isIdentifier(gate.name) || !richiesta || !ts.isIdentifier(richiesta) ||
      !attesa || !ts.isAwaitExpression(attesa) || !ts.isCallExpression(attesa.expression) ||
      !identificatore(attesa.expression.arguments[0], richiesta.text) ||
      !chiamaImportato(controllo, attesa.expression.expression, '@/lib/crm/ai/accesso', 'requireIntegrazioneAi')) return SENZA_GATE

  if (!restituisceRifiuto(seconda, gate.name.text)) return SENZA_RIFIUTO
}

function verificaExport(sorgente: string, nomeFile = 'route.ts'): Verifica[] {
  const file = ts.createSourceFile(nomeFile, sorgente, ts.ScriptTarget.Latest, true)
  // Risolve i nomi nel file, così una funzione locale omonima non conta come gate.
  const opzioni = { noResolve: true, noLib: true, types: [], allowJs: true }
  const controllo = ts.createProgram([nomeFile], opzioni, {
    ...ts.createCompilerHost(opzioni),
    getSourceFile: nome => nome === nomeFile ? file : undefined,
  }).getTypeChecker()
  const esiti: Verifica[] = []
  function verifica(metodo: string, inizializzatore?: ts.Expression) {
    if (!METODI.has(metodo)) return
    const errore = verificaHandler(controllo, inizializzatore)
    esiti.push(errore ? { metodo, errore } : { metodo })
  }

  for (const istruzione of file.statements) {
    // Gli export indiretti devono essere esplicitati nella route per controllare il gate.
    if (ts.isExportDeclaration(istruzione) && !istruzione.isTypeOnly) {
      const clausola = istruzione.exportClause
      if (!clausola) esiti.push({ metodo: 'export *', errore: SENZA_WRAPPER })
      else if (ts.isNamespaceExport(clausola)) verifica(clausola.name.text)
      else clausola.elements.filter(elemento => !elemento.isTypeOnly)
        .forEach(elemento => verifica(elemento.name.text))
      continue
    }

    const modificatori = ts.canHaveModifiers(istruzione) ? ts.getModifiers(istruzione) : undefined
    if (!modificatori?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ||
        modificatori.some(m => m.kind === ts.SyntaxKind.DefaultKeyword || m.kind === ts.SyntaxKind.DeclareKeyword)) continue

    if (ts.isVariableStatement(istruzione)) {
      const lista = istruzione.declarationList
      for (const dichiarazione of lista.declarations) {
        const inizializzatore = (lista.flags & ts.NodeFlags.Const) && ts.isIdentifier(dichiarazione.name)
          ? dichiarazione.initializer
          : undefined
        nomiDichiarati(dichiarazione.name).forEach(nome => verifica(nome, inizializzatore))
      }
    } else if (ts.isFunctionDeclaration(istruzione) || ts.isClassDeclaration(istruzione) ||
               ts.isEnumDeclaration(istruzione)) {
      if (istruzione.name) verifica(istruzione.name.text)
    }
  }
  return esiti
}

describe('CRM AI: ogni handler HTTP verifica la chiave di integrazione', () => {
  it('controlla tutti gli export HTTP sotto /api/crm/ai', () => {
    const file = fs.readdirSync(RADICE, { recursive: true, withFileTypes: true })
      .filter(voce => voce.isFile() && /^route\.(?:tsx?|jsx?)$/.test(voce.name))
      .map(voce => path.join(voce.parentPath, voce.name))
    const controlli = file.flatMap(nome => verificaExport(fs.readFileSync(nome, 'utf8'), nome)
      .map(esito => ({ ...esito, file: path.relative(RADICE, nome) })))
    expect(controlli.filter(esito => esito.errore)).toEqual([])
    expect(controlli.length).toBeGreaterThanOrEqual(2)
  })

  const IMPORT = `
    import { withRoute } from '@/lib/logging/with-route'
    import { requireIntegrazioneAi } from '@/lib/crm/ai/accesso'
  `
  const CORPO = `
    const g = await requireIntegrazioneAi(request, 'slot')
    if ('response' in g) return g.response
    return Response.json({ ok: true })
  `
  const GET = `export const GET = withRoute('crm/ai/slot:GET', async (request) => { ${CORPO} })`

  it('riconosce più metodi protetti nello stesso file', () => {
    const post = GET.replaceAll('GET', 'POST').replace('return g.response', '{ return g.response }')
    expect(verificaExport(IMPORT + GET + '\nexport const runtime = "nodejs"\n' + post))
      .toEqual([{ metodo: 'GET' }, { metodo: 'POST' }])
  })

  it.each([
    ['gate di sessione', `import { requireUser } from '@/lib/auth/require-staff'\n` +
      GET.replace("requireIntegrazioneAi(request, 'slot')", 'requireUser(request)'), SENZA_GATE],
    ['gate tardivo', GET.replace('const g', 'await request.json(); const g'), SENZA_GATE],
    ['richiesta diversa', GET.replace('requireIntegrazioneAi(request', 'requireIntegrazioneAi(altra'), SENZA_GATE],
    ['gate locale omonimo', GET.replace('return Response.json',
      'function requireIntegrazioneAi() { return { ai: {} } }\nreturn Response.json'), SENZA_GATE],
    ['rifiuto ignorato', GET.replace('return g.response', 'g.response'), SENZA_RIFIUTO],
    ['rifiuto solo in un commento', GET.replace('return g.response', '{ /* return g.response */ }'), SENZA_RIFIUTO],
    ['rifiuto sostituito', GET.replace('return g.response', 'return Response.json({ ok: true })'), SENZA_RIFIUTO],
    ['funzione non avvolta', `export async function GET(request) { ${CORPO} }`, SENZA_WRAPPER],
    ['const non avvolta', `export const GET = async (request) => { ${CORPO} }`, SENZA_WRAPPER],
    ['export rinominato', `const gestore = async (request) => { ${CORPO} }\nexport { gestore as GET }`, SENZA_WRAPPER],
  ])('individua %s', (_caso, sorgente, errore) => {
    expect(verificaExport(IMPORT + sorgente)).toEqual([{ metodo: 'GET', errore }])
  })

  it.each([
    ['@/lib/logging/with-route', SENZA_WRAPPER],
    ['@/lib/crm/ai/accesso', SENZA_GATE],
  ])('rifiuta un omonimo importato al posto di %s', (modulo, errore) => {
    expect(verificaExport(IMPORT.replace(modulo, './altro') + GET)).toEqual([{ metodo: 'GET', errore }])
  })

  it('segnala anche un metodo nudo accanto a uno protetto', () => {
    expect(verificaExport(IMPORT + GET + '\nexport function DELETE() {}'))
      .toEqual([{ metodo: 'GET' }, { metodo: 'DELETE', errore: SENZA_WRAPPER }])
  })

  it('segnala la riesportazione con un asterisco', () => {
    expect(verificaExport("export * from './altro'"))
      .toEqual([{ metodo: 'export *', errore: SENZA_WRAPPER }])
  })
})
