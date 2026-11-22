// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits,
// matches named lines at three tiers (exact, trailing-whitespace,
// leading-and-trailing whitespace), and writes every change or none.
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

/** A file split into lines at its own line break (SPEC.md section 3). */
interface FileData {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileData {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(f: FileData): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Section 5: the three matching tiers. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leading = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (!tierEq(tier, lines[i + j]!, oldLines[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which old lines occur at least once, with its positions. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, oldLines, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order, as [old, new] pairs. */
  moves: Array<[string, string]> = [];
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

/** One new-line item of N: a context line (written as the file's own matched
 * line, at O index oIdx) or a fresh line (written as it is, re-indented at
 * tier 2). */
interface NewItem {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Split body items into O (old lines) and N (new lines with context marks). */
function splitOldNew(items: Array<{ k: string; text: string }>): { o: string[]; n: NewItem[] } {
  const o: string[] = [];
  const n: NewItem[] = [];
  for (const it of items) {
    if (it.k === 'ctx') {
      n.push({ text: it.text, ctx: true, oIdx: o.length });
      o.push(it.text);
    } else if (it.k === 'old') {
      o.push(it.text);
    } else if (it.k === 'new') {
      n.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Build the replacement lines for N at occurrence `at` of O at `tier`. */
function buildReplacement(n: NewItem[], fileLines: string[], at: number, o: string[], tier: number): string[] {
  const f = leading(fileLines[at] ?? '');
  const p = o.length > 0 ? leading(o[0]!) : '';
  return n.map((item) => {
    if (item.ctx) return fileLines[at + item.oIdx]!;
    if (tier !== 2) return item.text;
    const t = item.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
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

/* ---- Unified diffs (SPEC.md section 6) ---- */

interface BodyLine {
  k: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function emptySection(): Section {
  return {
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld: undefined,
    diffNew: undefined,
    newFile: false,
    deletedFile: false,
    hasPair: false,
    hunks: [],
  };
}

/** The path after `--- ` / `+++ `: up to the first tab, trimmed, a/ or b/ stripped; /dev/null is null. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** A `\` line follows the hunk's last context or `+` line. */
function backslashSuppress(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i += 1) {
    if (h.body[i]!.k === 'ctx' || h.body[i]!.k === 'new') last = i;
  }
  if (last < 0) return false;
  return h.body[last + 1] !== undefined && h.body[last + 1]!.k === 'bs';
}

function parseHunkHeader(line: string, lineNo: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return Number(m[1]);
}

function parseDiffGit(line: string, lineNo: number): [string, string] {
  const m = DIFF_GIT_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return [m[1]!, m[2]!];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'body' = 'outside';
  let curHunk: Hunk | null = null;

  const finishBody = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0 && curHunk.body[curHunk.body.length - 1]!.raw === '') curHunk.body.pop();
    }
    curHunk = null;
  };
  const startSectionDiff = (i: number): void => {
    const [o, n] = parseDiffGit(lines[i]!, i + 1);
    const s = emptySection();
    s.diffOld = o;
    s.diffNew = n;
    sections.push(s);
    cur = s;
    state = 'header';
  };
  const startSectionPair = (i: number): void => {
    const s = emptySection();
    s.pairOld = diffPath(lines[i]!);
    s.pairNew = diffPath(lines[i + 1]!);
    s.hasPair = true;
    sections.push(s);
    cur = s;
    state = 'header';
  };
  const startHunk = (i: number): void => {
    const a = parseHunkHeader(lines[i]!, i + 1);
    const h: Hunk = { a, body: [] };
    cur!.hunks.push(h);
    curHunk = h;
    state = 'body';
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        finishBody();
        startSectionDiff(i);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishBody();
        startSectionPair(i);
        i += 2;
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        const k = line === '' || line.startsWith(' ') ? 'ctx' : line.startsWith('-') ? 'old' : line.startsWith('+') ? 'new' : 'bs';
        curHunk!.body.push({ k, text: line === '' ? '' : line.slice(1), raw: line });
        i += 1;
        continue;
      }
      finishBody();
      state = 'outside';
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        startSectionDiff(i);
        i += 1;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur!.hasPair) {
            startSectionPair(i);
            i += 2;
          } else {
            cur!.pairOld = diffPath(line);
            cur!.pairNew = diffPath(lines[i + 1]!);
            cur!.hasPair = true;
            i += 2;
          }
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('@@')) {
        startHunk(i);
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur!.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur!.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur!.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur!.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    // outside
    if (line.startsWith('diff --git ')) {
      startSectionDiff(i);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSectionPair(i);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      startHunk(i);
      i += 1;
      continue;
    }
    i += 1;
  }
  if (state === 'body') finishBody();

  const edits: Edit[] = sections.map((sec) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = !isCreate && (newP === null || sec.deletedFile);
    const isMove = !isCreate && !isDelete && oldP !== newP;
    // Section 10: every path the edit names is checked for safety before
    // anything else about it, even a path the kind of edit does not use.
    const checkPaths = (): void => {
      if (oldP !== null && oldP !== undefined && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== undefined && !safe(newP)) throw new Fail('unsafe', newP);
    };
    if (isCreate) {
      const p = newP === null || newP === undefined ? '' : newP;
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.k === 'new') plus.push(b.text);
      let final = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = sec.hunks[hi]!;
        if (h.body.some((b) => b.k === 'new')) {
          final = !backslashSuppress(h);
          break;
        }
      }
      return (tree: Tree) => {
        checkPaths();
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      };
    }
    if (isDelete) {
      const p = oldP === null || oldP === undefined ? '' : oldP;
      return (tree: Tree) => {
        checkPaths();
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    if (isMove) {
      const o = oldP as string;
      const n = newP as string;
      return (tree: Tree) => {
        checkPaths();
        const curText = tree.get(o);
        if (curText === null) throw new Fail('missing', o);
        if (tree.get(n) !== null) throw new Fail('exists', n);
        const out = applyHunks(curText, sec.hunks, strict, o);
        tree.now.set(n, out);
        tree.now.set(o, null);
        tree.moves.push([o, n]);
      };
    }
    const p = oldP as string;
    return (tree: Tree) => {
      checkPaths();
      if (!safe(p)) throw new Fail('unsafe', p);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(curText, sec.hunks, strict, p));
    };
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitOldNew(h.body);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...n.map((x) => x.text));
      if (atEnd) f.final = !backslashSuppress(h);
      d += n.length;
      continue;
    }
    const found = findTier(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const at = best;
    const atEnd = at + o.length === f.lines.length;
    const repl = buildReplacement(n, f.lines, at, o, found.tier);
    f.lines.splice(at, o.length, ...repl);
    if (atEnd) f.final = !backslashSuppress(h);
    d += n.length - o.length;
  }
  return serializeFile(f);
}

/* ---- SEARCH/REPLACE blocks (SPEC.md section 7) ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine}`);
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const repl = buildReplacement(
      newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      f.lines,
      at,
      oldLines,
      found.tier,
    );
    f.lines.splice(at, oldLines.length, ...repl);
    tree.now.set(path, serializeFile(f));
  };
}

/* ---- V4A patches (SPEC.md section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ k: string; text: string }>;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  lines: string[];
  startIdx: number[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const start = i;
    i += 1;
    const body: string[] = [];
    const idx: number[] = [];
    while (
      i < last &&
      !lines[i]!.startsWith('*** Add File: ') &&
      !lines[i]!.startsWith('*** Delete File: ') &&
      !lines[i]!.startsWith('*** Update File: ')
    ) {
      body.push(lines[i]!);
      idx.push(i);
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) {
      body.pop();
      idx.pop();
    }
    sections.push({ kind, path, lineNo: start + 1, lines: body, startIdx: idx });
  }

  const edits: Edit[] = sections.map((sec) => {
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < sec.lines.length; k += 1) {
        const l = sec.lines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${sec.startIdx[k]! + 1}`);
      }
      const p = sec.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      if (sec.lines.length > 0) throw new Exit2(`error: parse ${sec.startIdx[0]! + 1}`);
      const p = sec.path;
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    // update
    let moveTo: string | undefined;
    let at = 0;
    if (sec.lines.length > 0 && sec.lines[0]!.startsWith('*** Move to: ')) {
      moveTo = sec.lines[0]!.slice(13).trim();
      at = 1;
    }
    const chunks: V4aChunk[] = [];
    let curChunk: V4aChunk | null = null;
    let started = false;
    for (; at < sec.lines.length; at += 1) {
      const l = sec.lines[at]!;
      const lineNo = sec.startIdx[at]! + 1;
      if (l.startsWith('@@')) {
        curChunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
        chunks.push(curChunk);
        started = true;
      } else if (l === '*** End of File') {
        if (curChunk === null) throw new Exit2(`error: parse ${lineNo}`);
        curChunk.eof = true;
        curChunk = null;
      } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (curChunk === null) {
          if (started) throw new Exit2(`error: parse ${lineNo}`);
          curChunk = { anchor: null, eof: false, body: [] };
          chunks.push(curChunk);
          started = true;
        }
        const k = l === '' || l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new';
        curChunk.body.push({ k, text: l === '' ? '' : l.slice(1) });
      } else {
        throw new Exit2(`error: parse ${lineNo}`);
      }
    }
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${sec.lineNo}`);
    const p = sec.path;
    const mv = moveTo;
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== undefined && !safe(mv)) throw new Fail('unsafe', mv);
      const curText = tree.get(p);
      if (curText === null) throw new Fail('missing', p);
      if (mv !== undefined && tree.get(mv) !== null) throw new Fail('exists', mv);
      const f = parseFile(curText);
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null && chunk.anchor !== '') {
          let foundIdx = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          outer: for (const t of tiers) {
            for (let j = cursor; j < f.lines.length; j += 1) {
              if (tierEq(t, f.lines[j]!, chunk.anchor)) {
                foundIdx = j;
                break outer;
              }
            }
          }
          if (foundIdx === -1) throw new Fail('no-match', p);
          cursor = foundIdx + 1;
        }
        const { o, n } = splitOldNew(chunk.body);
        if (o.length === 0) {
          const pos = chunk.eof ? f.lines.length : cursor;
          const ins = n.map((x) => x.text);
          f.lines.splice(pos, 0, ...ins);
          cursor = pos + ins.length;
          continue;
        }
        let found: { tier: number; at: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = findOccurrences(f.lines, o, t).filter((pos) => pos >= cursor && (!chunk.eof || pos + o.length === f.lines.length));
          if (occ.length > 0) {
            found = { tier: t, at: occ[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const repl = buildReplacement(n, f.lines, found.at, o, found.tier);
        f.lines.splice(found.at, o.length, ...repl);
        cursor = found.at + repl.length;
      }
      const out = serializeFile(f);
      if (mv !== undefined) {
        tree.now.set(mv, out);
        tree.now.set(p, null);
        tree.moves.push([p, mv]);
      } else {
        tree.now.set(p, out);
      }
    };
  });
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (o === n) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      covered.add(o);
      covered.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
