// Stato condiviso per gli handshake cross-ruolo. L'orchestratore ci registra gli
// "handle" prodotti dagli agenti-scrittore (es. id/titolo di un avviso appena
// pubblicato) che gli agenti-lettore devono attendere prima di verificare.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const STATE = fileURLToPath(new URL('../run/state.json', import.meta.url));

export function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}
export function writeState(patch) {
  const next = { ...readState(), ...patch, _updated: 'set-at-runtime' };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(next, null, 2));
  return next;
}
