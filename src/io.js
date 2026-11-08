import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let terminal = null;
let customAsk = null;
let customPickFile = null;
export function setAskHandler(handler) { customAsk = handler; terminal?.close(); terminal = null; }
export function setFilePicker(handler) { customPickFile = handler; }
export async function ask(question) {
  if (!customAsk && !terminal) terminal = readline.createInterface({ input: stdin, output: stdout });
  return (customAsk ? await customAsk(question) : await terminal.question(question)).trim();
}
export async function confirm(question) { return /^(y|yes)$/i.test(await ask(`${question} Type yes to continue: `)); }
export async function pickFile(purpose) {
  if (customPickFile) return customPickFile(purpose);
  return ask(`Choose a local file for ${purpose}. Enter its full path (blank to cancel): `);
}
export function closeTerminal() { if (!customAsk) terminal?.close(); }
