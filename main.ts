// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3)                                  */
/* ------------------------------------------------------------------ */

interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function modelOf(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC.md section 5)                   */
/* ------------------------------------------------------------------ */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** All positions where O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eof: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    if (eof && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eof = false,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from, eof);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: `text`, and the index into O when it is a context line (written as the file's own line). */
interface NLine {
  text: string;
  ctx: number | null;
}

function reindent(s: string, p: string, f: string): string {
  if (s === '' || /^[ \t]+$/.test(s)) return s;
  if (s.startsWith(p)) return f + s.slice(p.length);
  return s;
}

/** Build the replacement lines: context lines as the file's own, other lines re-indented at tier 2. */
function buildN(o: string[], n: NLine[], fileLines: string[], pos: number, tier: number): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  return n.map((e) => {
    if (e.ctx !== null) return fileLines[pos + e.ctx]!;
    if (tier === 2) return reindent(e.text, p, f);
    return e.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UBody {
  kind: ' ' | '-' | '+';
  text: string;
  noNl: boolean;
}
interface UHunk {
  a: number;
  body: UBody[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: UHunk[];
}

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function parseDiffPath(l: string): string {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let state: 'outside' | 'header' | 'hunk' = 'outside';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const rest = l.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const sep = rest.indexOf(' b/', 2);
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      const x = rest.slice(2, sep).trim();
      const y = rest.slice(sep + 3).trim();
      if (x === '' || y === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: null,
        newPath: null,
        renameFrom: null,
        renameTo: null,
        diffOld: x,
        diffNew: y,
        creation: false,
        deletion: false,
        hunks: [],
      };
      sections.push(cur);
      state = 'header';
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEADER.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const body: UBody[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          body.push({ kind: b[0] as ' ' | '-' | '+', text: b.slice(1), noNl: false });
          i += 1;
          continue;
        }
        if (b.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1]!.noNl = true;
          i += 1;
          continue;
        }
        if (b === '') {
          body.push({ kind: ' ', text: '', noNl: false });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a, body });
      state = 'hunk';
      continue;
    }
    if (state === 'header' && cur !== null && l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        cur.oldPath = parseDiffPath(l);
        cur.newPath = parseDiffPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (state === 'header' && cur !== null && l.startsWith('+++ ')) {
      cur.newPath = parseDiffPath(l);
      i += 1;
      continue;
    }
    if ((state === 'hunk' || state === 'outside') && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = {
        oldPath: null,
        newPath: null,
        renameFrom: null,
        renameTo: null,
        diffOld: null,
        diffNew: null,
        creation: false,
        deletion: false,
        hunks: [],
      };
      sections.push(cur);
      state = 'header';
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.creation = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.deletion = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Split a hunk/chunk body into O (context + `-` lines) and N (context + `+` lines, context lines tagged with their O index). */
function splitBody(body: Array<{ kind: ' ' | '-' | '+'; text: string }>): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line (or its last `+` line, when only `+` counts). */
function lastNoNl(body: UBody[], plusOnly: boolean): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === '+') return b.noNl;
    if (!plusOnly && b.kind === ' ') return b.noNl;
  }
  return false;
}

function applyHunks(model: FileModel, hunks: UHunk[], strict: boolean, path: string): FileModel {
  let lines = [...model.lines];
  let finalBreak = model.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    if (o.length > 0) {
      const found = findTier(lines, o, 0, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.occ) {
        const dd = Math.abs(q - target);
        if (dd < best) {
          best = dd;
          pos = q;
        }
      }
      const runsToEnd = pos + o.length === lines.length;
      const seg = buildN(o, n, lines, pos, found.tier);
      lines.splice(pos, o.length, ...seg);
      if (runsToEnd) finalBreak = !lastNoNl(h.body, false);
      d += n.length - o.length;
    } else {
      const at = Math.min(h.a + d, lines.length);
      lines.splice(at, 0, ...n.map((e) => e.text));
      if (at === lines.length) finalBreak = !lastNoNl(h.body, true);
      d += n.length;
    }
  }
  return { lines, br: model.br, finalBreak };
}

function unifiedEdits(sections: USection[], strict: boolean, noteMove: (o: string, n: string) => void): Edit[] {
  return sections.map((s) => {
    const oldP = s.oldPath ?? s.renameFrom ?? s.diffOld ?? '';
    const newP = s.newPath ?? s.renameTo ?? s.diffNew ?? '';
    const creation = s.creation || oldP === '/dev/null';
    const deletion = !creation && (s.deletion || newP === '/dev/null');
    if (creation) {
      return (tree: Tree): void => {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastNoNl = false;
        for (const h of s.hunks) {
          for (const b of h.body) {
            if (b.kind === '+') {
              plus.push(b.text);
              lastNoNl = b.noNl;
            }
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastNoNl ? '' : '\n'));
      };
    }
    if (deletion) {
      return (tree: Tree): void => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      };
    }
    if (oldP !== newP) {
      return (tree: Tree): void => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const after = applyHunks(modelOf(tree.get(oldP)!), s.hunks, strict, oldP);
        tree.now.set(newP, renderModel(after));
        tree.now.set(oldP, null);
        noteMove(oldP, newP);
      };
    }
    return (tree: Tree): void => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      const after = applyHunks(modelOf(tree.get(oldP)!), s.hunks, strict, oldP);
      tree.now.set(oldP, renderModel(after));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
        path = prevPath;
      }
      let k = i + 1;
      let eq = -1;
      while (k < n) {
        if (lines[k]!.trimEnd() === '=======') {
          eq = k;
          break;
        }
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
        k += 1;
      }
      if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
      let rep = -1;
      let m = eq + 1;
      while (m < n) {
        if (lines[m]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = m;
          break;
        }
        m += 1;
      }
      if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevEnd = rep + 1;
      prevPath = path;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(b.path);
      if (cur === null) throw new Fail('missing', b.path);
      const model = modelOf(cur);
      const found = findTier(model.lines, b.oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.occ[0]!;
      const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
      const seg = buildN(b.oldLines, n, model.lines, pos, found.tier);
      const next = [...model.lines];
      next.splice(pos, b.oldLines.length, ...seg);
      tree.now.set(b.path, renderModel({ lines: next, br: model.br, finalBreak: model.finalBreak }));
    };
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VBody {
  kind: ' ' | '-' | '+';
  text: string;
}
interface VChunk {
  anchor: string | null;
  body: VBody[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): /;

function parseV4a(lines: string[], strict: boolean, noteMove: (o: string, n: string) => void): Edit[] {
  const n = lines.length;
  let f = -1;
  for (let k = 0; k < n; k++) {
    if (!blank(lines[k]!)) {
      f = k;
      break;
    }
  }
  if (f < 0) throw new Exit2('error: parse 1');
  if (lines[f]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${f + 1}`);
  let e = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      e = k;
      break;
    }
  }
  if (lines[e]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: VSection[] = [];
  let i = f + 1;
  while (i < e) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < e) {
        if (V4A_SECTION.test(lines[j]!)) break;
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let k = 0; k < raw.length; k++) {
        const x = raw[k]!;
        if (!(x.startsWith('+') || x === '')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      sections.push({ kind: 'add', path, moveTo: null, addLines: raw.map((x) => (x === '' ? '' : x.slice(1))), chunks: [] });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < e) {
        if (V4A_SECTION.test(lines[j]!)) break;
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      sections.push({ kind: 'delete', path, moveTo: null, addLines: [], chunks: [] });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < e) {
        if (V4A_SECTION.test(lines[j]!)) break;
        raw.push(lines[j]!);
        j += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const x = raw[k]!;
        if (x.startsWith('@@')) {
          const anchor = x.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
        } else if (x.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          cur.eof = true;
          cur = null;
        } else if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+') || x === '') {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          cur.body.push({ kind: x === '' ? ' ' : (x[0] as ' ' | '-' | '+'), text: x === '' ? '' : x.slice(1) });
        } else {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'update', path, moveTo, addLines: [], chunks });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => {
    if (s.kind === 'add') {
      return (tree: Tree): void => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      return (tree: Tree): void => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      };
    }
    return (tree: Tree): void => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      const cur = tree.get(s.path);
      if (cur === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const after = applyV4aChunks(modelOf(cur), s.chunks, strict, s.path);
      const text = renderModel(after);
      if (s.moveTo !== null) {
        tree.now.set(s.moveTo, text);
        tree.now.set(s.path, null);
        noteMove(s.path, s.moveTo);
      } else {
        tree.now.set(s.path, text);
      }
    };
  });
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findSingleLine(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let k = from; k < lines.length; k++) {
      if (normLine(lines[k]!, t) === normLine(anchor, t)) return k;
    }
  }
  return null;
}

function applyV4aChunks(model: FileModel, chunks: VChunk[], strict: boolean, path: string): FileModel {
  let lines = [...model.lines];
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const idx = findSingleLine(lines, c.anchor, cursor, strict);
      if (idx === null) throw new Fail('no-match', path);
      cursor = idx + 1;
    }
    const { o, n } = splitBody(c.body);
    if (o.length === 0) {
      const at = c.eof ? lines.length : cursor;
      lines.splice(at, 0, ...n.map((e) => e.text));
      cursor = at + n.length;
    } else {
      const found = findTier(lines, o, cursor, strict, c.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const seg = buildN(o, n, lines, pos, found.tier);
      lines.splice(pos, o.length, ...seg);
      cursor = pos + seg.length;
    }
  }
  return { lines, br: model.br, finalBreak: model.finalBreak };
}

/* ------------------------------------------------------------------ */
/* Run (SPEC.md sections 1, 2, 10)                                     */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Array<[string, string]> = [];
  const noteMove = (o: string, n: string): void => {
    moves.push([o, n]);
  };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') {
      const sections = parseUnified(lines);
      if (sections.length === 0) throw new Exit2('error: parse 1');
      edits = unifiedEdits(sections, strict, noteMove);
    } else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, noteMove);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of moves) {
    if (movedOld.has(o) && movedNew.has(n)) rows.push({ key: n, line: `R ${o} -> ${n}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (movedOld.has(p) || movedNew.has(p)) continue;
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    for (const [o, n] of moves) {
      if (!movedOld.has(o) || !movedNew.has(n)) continue;
      rmSync(o, { force: true });
      mkdirSync(dirname(n), { recursive: true });
      writeFileSync(n, tree.now.get(n)!);
    }
  }
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
