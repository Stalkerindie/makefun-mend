// Extra checks for mend, beyond the kit's 100 practice checks: sentences of
// SPEC.md the practice set does not show. Run: node tests/run.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');
let pass = 0;
let fail = 0;
const failures = [];

const mod = (base, changes) => {
  const o = { ...base };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete o[k];
    else o[k] = v;
  }
  return o;
};

function runCase(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-test-'));
  try {
    for (const [p, text] of Object.entries(t.files || {})) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...(t.argv || [])], { cwd: dir, input: t.stdin ?? '', encoding: 'utf8', timeout: 10000 });
    const gotFiles = {};
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) gotFiles[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    const problems = [];
    if (r.status !== t.exit) problems.push(`exit ${r.status} != ${t.exit}`);
    if ((r.stdout ?? '') !== t.stdout) problems.push(`stdout ${JSON.stringify(r.stdout)} != ${JSON.stringify(t.stdout)}`);
    if (r.stderr && r.status !== 0 && r.status !== 1 && r.status !== 2) problems.push(`stderr: ${String(r.stderr).slice(0, 300)}`);
    const want = t.after;
    for (const p of new Set([...Object.keys(want), ...Object.keys(gotFiles)])) {
      if (want[p] === undefined) problems.push(`${p} should not exist (got ${JSON.stringify(gotFiles[p])})`);
      else if (gotFiles[p] === undefined) problems.push(`${p} missing`);
      else if (gotFiles[p] !== want[p]) problems.push(`${p}: got ${JSON.stringify(gotFiles[p])}, want ${JSON.stringify(want[p])}`);
    }
    if (problems.length === 0) pass += 1;
    else {
      fail += 1;
      failures.push(`${t.name}: ${problems.join(' | ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T = [];

// ---- unified ----
T.push({ name: 'u-hunk-before-section', argv: ['--format=unified'], stdin: '@@ -1,1 +1,1 @@\n-a\n+b\n', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'u-hunk-auto-format', argv: [], stdin: '@@ -1,1 +1,1 @@\n-a\n+b\n', files: {}, exit: 2, stdout: 'error: format\n', after: {} });
T.push({ name: 'u-bad-hunk-header', argv: [], stdin: '--- a/x\n+++ b/x\n@@ 1,1 +1,1 @@\n-a\n+b\n', files: { x: 'a\n' }, exit: 2, stdout: 'error: parse 3\n', after: { x: 'a\n' } });
T.push({ name: 'u-bad-diff-git', argv: [], stdin: 'diff --git a/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: { x: 'a\n' }, exit: 2, stdout: 'error: parse 1\n', after: { x: 'a\n' } });
T.push({ name: 'u-dangling-dashes-eof', argv: [], stdin: 'diff --git a/x b/x\n--- a/x\n', files: { x: 'a\n' }, exit: 2, stdout: 'error: parse 3\n', after: { x: 'a\n' } });
T.push({ name: 'u-dangling-dashes-2', argv: [], stdin: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\ndiff --git a/y b/y\n--- a/y\nnot-plus-plus\n', files: { x: 'a\n' }, exit: 2, stdout: 'error: parse 8\n', after: { x: 'a\n' } });
T.push({ name: 'u-rename-only', argv: [], stdin: 'diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: { 'old.txt': 'a\n' }, exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', after: { 'new.txt': 'b\n' } });
T.push({ name: 'u-newfile-nodashes', argv: [], stdin: 'diff --git a/n.txt b/n.txt\nnew file mode 100644\n@@ -0,0 +1,1 @@\n+hi\n', files: {}, exit: 0, stdout: 'A n.txt\nok: 1 file\n', after: { 'n.txt': 'hi\n' } });
T.push({ name: 'u-delfile-nodashes-noread', argv: [], stdin: 'diff --git a/d.txt b/d.txt\ndeleted file mode 100644\n@@ -1,1 +0,0 @@\n-x\n-y\n', files: { 'd.txt': 'x\n' }, exit: 0, stdout: 'D d.txt\nok: 1 file\n', after: {} });
T.push({ name: 'u-create-noeol', argv: [], stdin: '--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n', files: {}, exit: 0, stdout: 'A c.txt\nok: 1 file\n', after: { 'c.txt': 'one\ntwo' } });
T.push({ name: 'u-create-empty', argv: [], stdin: '--- /dev/null\n+++ b/e.txt\n@@ -0,0 +0,0 @@\n', files: {}, exit: 0, stdout: 'A e.txt\nok: 1 file\n', after: { 'e.txt': '' } });
T.push({ name: 'u-nohunks-change', argv: [], stdin: '--- a/x\n+++ b/x\n', files: { x: 'a\n' }, exit: 0, stdout: 'ok: 0 files\n', after: { x: 'a\n' } });
T.push({ name: 'u-nohunks-missing', argv: [], stdin: '--- a/zzz\n+++ b/zzz\n', files: {}, exit: 1, stdout: 'error: missing zzz\nfailed: 1 of 1 edits\n', after: {} });
T.push({ name: 'u-move-exists', argv: [], stdin: '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: { 'a.txt': 'a\n', 'b.txt': 'b\n' }, exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n', after: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
T.push({ name: 'u-move-missing', argv: [], stdin: '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: {}, exit: 1, stdout: 'error: missing a.txt\nfailed: 1 of 1 edits\n', after: {} });
T.push({ name: 'u-unsafe-new', argv: [], stdin: 'diff --git a/a.txt b/../evil\n--- a/a.txt\n+++ b/../evil\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: { 'a.txt': 'a\n' }, exit: 1, stdout: 'error: unsafe ../evil\nfailed: 1 of 1 edits\n', after: { 'a.txt': 'a\n' } });
T.push({ name: 'u-unsafe-old-del', argv: [], stdin: 'diff --git a/x b/x\ndeleted file mode 100644\n--- a/../x\n+++ b/x\n', files: { x: 'a\n' }, exit: 1, stdout: 'error: unsafe ../x\nfailed: 1 of 1 edits\n', after: { x: 'a\n' } });
T.push({ name: 'u-empty-insert-end-noeol', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -2,0 +3,1 @@\n+c\n\\ No newline at end of file\n', files: { f: 'a\nb' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\nb\nc' } });
T.push({ name: 'u-empty-insert-end-break', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -2,0 +3,1 @@\n+c\n', files: { f: 'a\nb' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\nb\nc\n' } });
T.push({ name: 'u-insert-beyond', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -99,0 +100,1 @@\n+z\n', files: { f: 'a\nb\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\nb\nz\n' } });
T.push({ name: 'u-insert-negative-d', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -1,2 +1,0 @@\n-l1\n-l2\n@@ -1,0 +1,1 @@\n+top\n', files: { f: 'l1\nl2\nl3\nl4\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'top\nl3\nl4\n' } });
T.push({ name: 'u-d-shift', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -2,2 +2,3 @@\n b\n-b2\n+B1\n+B2\n@@ -6,1 +6,1 @@\n-e\n+E\n', files: { f: 'a\nb\nb2\nc\nd\ne\nf\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\nb\nB1\nB2\nc\nd\nE\nf\n' } });
T.push({ name: 'u-nearest-tie', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -3,1 +3,1 @@\n-A\n+B\n', files: { f: 'x\nA\nx\nA\nx\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'x\nB\nx\nA\nx\n' } });
T.push({ name: 'u-tier2-prepend', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B2\n c\n', files: { f: '  a\n  b\n  c\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: '  a\n  B2\n  c\n' } });
T.push({ name: 'u-backslash-after-minus', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -2,2 +2,1 @@\n b\n-c\n\\ No newline at end of file\n', files: { f: 'a\nb\nc\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\nb\n' } });
T.push({ name: 'u-body-trailing-blanks', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+A\n\n@@ -3,1 +3,1 @@\n-c\n+C\n', files: { f: 'a\nb\nc\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'A\nb\nC\n' } });
T.push({ name: 'u-tab-path', argv: [], stdin: '--- a/x\t1234\n+++ b/x\t5678\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: { x: 'a\n' }, exit: 0, stdout: 'M x\nok: 1 file\n', after: { x: 'b\n' } });
T.push({ name: 'u-crlf-eof-noeol', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -3,1 +3,1 @@\n-c\n+C\n\\ No newline at end of file\n', files: { f: 'a\r\nb\r\nc' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\r\nb\r\nC' } });
T.push({ name: 'u-crlf-eof-break', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -3,1 +3,1 @@\n-c\n+C\n', files: { f: 'a\r\nb\r\nc' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\r\nb\r\nC\r\n' } });
T.push({ name: 'u-second-pair-new-section', argv: [], stdin: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/y\n+++ b/y\n@@ -1,1 +1,1 @@\n-p\n+Q\n', files: { x: 'a\n', y: 'p\n' }, exit: 0, stdout: 'M x\nM y\nok: 2 files\n', after: { x: 'A\n', y: 'Q\n' } });
T.push({ name: 'u-prose-dashes', argv: [], stdin: 'Some prose\n--- a/x\nnot plus plus\n--- a/y\n+++ b/y\n@@ -1,1 +1,1 @@\n-p\n+Q\n', files: { y: 'p\n' }, exit: 0, stdout: 'M y\nok: 1 file\n', after: { y: 'Q\n' } });
T.push({ name: 'u-empty-patch-forced', argv: ['--format=unified'], stdin: 'hello\nworld\n', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'u-move-nomatch', argv: [], stdin: '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-zzz\n+yyy\n', files: { 'a.txt': 'a\n' }, exit: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', after: { 'a.txt': 'a\n' } });
T.push({ name: 'u-create-exists', argv: [], stdin: '--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+hi\n', files: { x: 'old\n' }, exit: 1, stdout: 'error: exists x\nfailed: 1 of 1 edits\n', after: { x: 'old\n' } });
T.push({ name: 'u-delete-missing', argv: [], stdin: '--- a/zzz\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n', files: {}, exit: 1, stdout: 'error: missing zzz\nfailed: 1 of 1 edits\n', after: {} });
T.push({ name: 'u-path-a-strip', argv: [], stdin: '--- a/a/b\n+++ b/a/b\n@@ -1,1 +1,1 @@\n-x\n+y\n', files: { 'a/b': 'x\n' }, exit: 0, stdout: 'M a/b\nok: 1 file\n', after: { 'a/b': 'y\n' } });

// ---- SEARCH/REPLACE ----
T.push({ name: 's-path-inherit', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n\n```\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n```\n', files: { 'f.txt': 'a\nb\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'A\nB\n' } });
T.push({ name: 's-first-no-path', argv: [], stdin: '```\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', files: {}, exit: 2, stdout: 'error: parse 2\n', after: {} });
T.push({ name: 's-no-equals', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n', files: { 'f.txt': 'a\n' }, exit: 2, stdout: 'error: parse 2\n', after: { 'f.txt': 'a\n' } });
T.push({ name: 's-no-replace', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\na\n=======\nA\n', files: { 'f.txt': 'a\n' }, exit: 2, stdout: 'error: parse 2\n', after: { 'f.txt': 'a\n' } });
T.push({ name: 's-replace-before-equals', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n=======\nA\n>>>>>>> REPLACE\n', files: { 'f.txt': 'a\n' }, exit: 2, stdout: 'error: parse 2\n', after: { 'f.txt': 'a\n' } });
T.push({ name: 's-create-empty', argv: [], stdin: 'n.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n', files: {}, exit: 0, stdout: 'A n.txt\nok: 1 file\n', after: { 'n.txt': '' } });
T.push({ name: 's-marker-trailing-ws', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH  \na\n=======   \nA\n>>>>>>> REPLACE\t\n', files: { 'f.txt': 'a\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'A\n' } });
T.push({ name: 's-marker-leading-ws', argv: ['--format=search-replace'], stdin: 'f.txt\n  <<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n', files: { 'f.txt': 'a\n' }, exit: 2, stdout: 'error: parse 1\n', after: { 'f.txt': 'a\n' } });
T.push({ name: 's-tier2-reindent', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\nx\ny\n=======\nx2\ny2\n>>>>>>> REPLACE\n', files: { 'f.txt': '    x\n    y\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': '    x2\n    y2\n' } });
T.push({ name: 's-crlf-nofinal', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n', files: { 'f.txt': 'a\r\nb' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'a\r\nB' } });
T.push({ name: 's-sequential', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n\nf.txt\n<<<<<<< SEARCH\nb\n=======\nc\n>>>>>>> REPLACE\n', files: { 'f.txt': 'a\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'c\n' } });
T.push({ name: 's-ambiguous-tier1', argv: [], stdin: 'f.txt\n<<<<<<< SEARCH\na \n=======\nb\n>>>>>>> REPLACE\n', files: { 'f.txt': 'a\na\n' }, exit: 1, stdout: 'error: ambiguous f.txt\nfailed: 1 of 1 edits\n', after: { 'f.txt': 'a\na\n' } });
T.push({ name: 's-unsafe', argv: [], stdin: '../x\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n', files: {}, exit: 1, stdout: 'error: unsafe ../x\nfailed: 1 of 1 edits\n', after: {} });
T.push({ name: 's-create-nested', argv: [], stdin: 'sub/dir/n.txt\n<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n', files: {}, exit: 0, stdout: 'A sub/dir/n.txt\nok: 1 file\n', after: { 'sub/dir/n.txt': 'hello\n' } });

// ---- V4A ----
T.push({ name: 'v-first-line-wrong', argv: ['--format=v4a'], stdin: 'hello\n*** Begin Patch\n*** End Patch\n', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'v-first-line-wrong-auto', argv: [], stdin: 'hello\n*** Begin Patch\n*** End Patch\n', files: {}, exit: 2, stdout: 'error: format\n', after: {} });
T.push({ name: 'v-first-line-wrong-2', argv: ['--format=v4a'], stdin: '\n\nfoo\n*** Begin Patch\n*** End Patch\n', files: {}, exit: 2, stdout: 'error: parse 3\n', after: {} });
T.push({ name: 'v-no-end', argv: [], stdin: '*** Begin Patch\n*** Add File: a.txt\n+x\n', files: {}, exit: 2, stdout: 'error: parse 4\n', after: {} });
T.push({ name: 'v-empty', argv: [], stdin: '*** Begin Patch\n*** End Patch\n', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'v-stray-line', argv: [], stdin: '*** Begin Patch\nhello\n*** End Patch\n', files: {}, exit: 2, stdout: 'error: parse 2\n', after: {} });
T.push({ name: 'v-add-bad-line', argv: [], stdin: '*** Begin Patch\n*** Add File: a.txt\n+ok\nbad\n*** End Patch\n', files: {}, exit: 2, stdout: 'error: parse 4\n', after: {} });
T.push({ name: 'v-del-with-lines', argv: [], stdin: '*** Begin Patch\n*** Delete File: a.txt\n+x\n*** End Patch\n', files: { 'a.txt': 'x\n' }, exit: 2, stdout: 'error: parse 3\n', after: { 'a.txt': 'x\n' } });
T.push({ name: 'v-update-no-chunk', argv: [], stdin: '*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n', files: { 'a.txt': 'x\n' }, exit: 2, stdout: 'error: parse 2\n', after: { 'a.txt': 'x\n' } });
T.push({ name: 'v-move-only', argv: [], stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n', files: { 'a.txt': 'hello\n' }, exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', after: { 'b.txt': 'hello\n' } });
T.push({ name: 'v-move-exists', argv: [], stdin: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n@@ x\n-a\n+b\n*** End Patch\n', files: { 'a.txt': 'a\n', 'b.txt': 'b\n' }, exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n', after: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
T.push({ name: 'v-anchor-tier1', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n@@ anchor line \n-a\n+b\n*** End Patch\n', files: { 'f.txt': 'anchor line\na\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'anchor line\nb\n' } });
T.push({ name: 'v-anchor-missing', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n@@ nope\n-a\n+b\n*** End Patch\n', files: { 'f.txt': 'a\n' }, exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', after: { 'f.txt': 'a\n' } });
T.push({ name: 'v-empty-o-cursor', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n@@ def f():\n+    # hi\n*** End Patch\n', files: { 'f.txt': 'def f():\n    pass\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'def f():\n    # hi\n    pass\n' } });
T.push({ name: 'v-empty-o-eof', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n@@\n+Z\n*** End of File\n*** End Patch\n', files: { 'f.txt': 'a\nb\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'a\nb\nZ\n' } });
T.push({ name: 'v-eof-must-end', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n a\n b\n*** End of File\n*** End Patch\n', files: { 'f.txt': 'a\nb\nc\n' }, exit: 1, stdout: 'error: no-match f.txt\nfailed: 1 of 1 edits\n', after: { 'f.txt': 'a\nb\nc\n' } });
T.push({ name: 'v-cursor-second-occurrence', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n foo\n-bar\n+BAR\n foo\n-bar\n+BAR2\n*** End Patch\n', files: { 'f.txt': 'foo\nbar\nfoo\nbar\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'foo\nBAR\nfoo\nBAR2\n' } });
T.push({ name: 'v-add-trailing-blanks', argv: [], stdin: '*** Begin Patch\n*** Add File: a.txt\n+one\n\n\n*** End Patch\n', files: {}, exit: 0, stdout: 'A a.txt\nok: 1 file\n', after: { 'a.txt': 'one\n' } });
T.push({ name: 'v-body-after-eof', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n a\n*** End of File\n b\n*** End Patch\n', files: { 'f.txt': 'a\n' }, exit: 2, stdout: 'error: parse 5\n', after: { 'f.txt': 'a\n' } });
T.push({ name: 'v-eof-no-chunk', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n*** End of File\n*** End Patch\n', files: { 'f.txt': 'a\n' }, exit: 2, stdout: 'error: parse 3\n', after: { 'f.txt': 'a\n' } });
T.push({ name: 'v-move-nonfirst', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n x\n*** Move to: b.txt\n*** End Patch\n', files: { 'f.txt': 'x\n' }, exit: 2, stdout: 'error: parse 4\n', after: { 'f.txt': 'x\n' } });
T.push({ name: 'v-crlf', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n a\n-b\n+B\n*** End Patch\n', files: { 'f.txt': 'a\r\nb\r\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'a\r\nB\r\n' } });
T.push({ name: 'v-add-plus-empty', argv: [], stdin: '*** Begin Patch\n*** Add File: a.txt\n+a\n+\n+b\n*** End Patch\n', files: {}, exit: 0, stdout: 'A a.txt\nok: 1 file\n', after: { 'a.txt': 'a\n\nb\n' } });

// ---- JSON ----
T.push({ name: 'j-array-fault', argv: [], stdin: '[{"command":"create","path":"x","file_text":"a"}, {"command":"bogus","path":"y"}]\n', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'j-array-multiline-fault', argv: [], stdin: '\n[\n  {"command":"create","path":"x","file_text":"a"},\n  {"command":"bogus","path":"y"}\n]\n', files: {}, exit: 2, stdout: 'error: parse 2\n', after: {} });
T.push({ name: 'j-insert-oob', argv: [], stdin: '{"command":"insert","path":"f","insert_line":5,"new_str":"x"}\n', files: { f: 'a\nb\n' }, exit: 1, stdout: 'error: no-match f\nfailed: 1 of 1 edits\n', after: { f: 'a\nb\n' } });
T.push({ name: 'j-insert-neg', argv: [], stdin: '{"command":"insert","path":"f","insert_line":-1,"new_str":"x"}\n', files: { f: 'a\nb\n' }, exit: 1, stdout: 'error: no-match f\nfailed: 1 of 1 edits\n', after: { f: 'a\nb\n' } });
T.push({ name: 'j-str-overlap', argv: [], stdin: '{"command":"str_replace","path":"f","old_str":"aa","new_str":"b"}\n', files: { f: 'aaa\n' }, exit: 1, stdout: 'error: ambiguous f\nfailed: 1 of 1 edits\n', after: { f: 'aaa\n' } });
T.push({ name: 'j-create-crlf-bytes', argv: [], stdin: '{"command":"create","path":"x","file_text":"a\\r\\nb\\r\\n"}\n', files: {}, exit: 0, stdout: 'A x\nok: 1 file\n', after: { x: 'a\r\nb\r\n' } });
T.push({ name: 'j-single-object-multiline', argv: [], stdin: '{\n"command":"create",\n"path":"x",\n"file_text":"a"\n}\n', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'j-array-nonobject', argv: [], stdin: '[1,2]\n', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'j-missing-newstr-insert', argv: [], stdin: '{"command":"insert","path":"f","insert_line":0}\n', files: { f: 'a\n' }, exit: 2, stdout: 'error: parse 1\n', after: { f: 'a\n' } });
T.push({ name: 'j-empty-oldstr', argv: [], stdin: '{"command":"str_replace","path":"f","old_str":"","new_str":"x"}\n', files: { f: 'a\n' }, exit: 2, stdout: 'error: parse 1\n', after: { f: 'a\n' } });

// ---- CLI ----
T.push({ name: 'c-usage-beats-nopatch', argv: ['--bogus', 'missing.patch'], stdin: null, files: {}, exit: 2, stdout: 'error: usage\n', after: {} });
T.push({ name: 'c-nopatch-beats-format', argv: ['missing.patch'], stdin: null, files: {}, exit: 2, stdout: 'error: no-patch\n', after: {} });
T.push({ name: 'c-parse-beats-file', argv: ['p.diff'], stdin: null, files: { 'p.diff': '--- a/zzz\n+++ b/zzz\n@@ bad\n' }, exit: 2, stdout: 'error: parse 3\n', after: { 'p.diff': '--- a/zzz\n+++ b/zzz\n@@ bad\n' } });
T.push({ name: 'c-double-dash', argv: ['--', '--check'], stdin: null, files: {}, exit: 2, stdout: 'error: no-patch\n', after: {} });
T.push({ name: 'c-format-twice', argv: ['--format=json', '--format=v4a', 'p'], stdin: null, files: {}, exit: 2, stdout: 'error: usage\n', after: {} });
T.push({ name: 'c-check-twice', argv: ['--check', '--check'], stdin: null, files: {}, exit: 2, stdout: 'error: usage\n', after: {} });
T.push({ name: 'c-sort-bytes', argv: [], stdin: '[{"command":"create","path":"a.txt","file_text":"a"},{"command":"create","path":"B.txt","file_text":"b"}]\n', files: {}, exit: 0, stdout: 'A B.txt\nA a.txt\nok: 2 files\n', after: { 'a.txt': 'a', 'B.txt': 'b' } });
T.push({ name: 'c-r-sort', argv: [], stdin: '--- a/b.txt\n+++ b/z.txt\n@@ -1,1 +1,1 @@\n-b\n+z\n--- a/a.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-a\n+m\n', files: { 'b.txt': 'b\n', 'a.txt': 'a\n' }, exit: 0, stdout: 'R a.txt -> m.txt\nR b.txt -> z.txt\nok: 2 files\n', after: { 'z.txt': 'z\n', 'm.txt': 'm\n' } });
T.push({ name: 'c-create-delete-same', argv: [], stdin: '--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+hi\ndiff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-hi\n', files: {}, exit: 0, stdout: 'ok: 0 files\n', after: {} });
T.push({ name: 'c-delete-create-same', argv: [], stdin: 'diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old\ndiff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+new\n', files: { x: 'old\n' }, exit: 0, stdout: 'M x\nok: 1 file\n', after: { x: 'new\n' } });
T.push({ name: 'c-move-then-edit', argv: [], stdin: '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-a\n+B\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-B\n+C\n', files: { 'a.txt': 'a\n' }, exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', after: { 'b.txt': 'C\n' } });
T.push({ name: 'c-empty-stdin-auto', argv: ['-'], stdin: '', files: {}, exit: 2, stdout: 'error: format\n', after: {} });
T.push({ name: 'c-empty-stdin-forced-json', argv: ['--format=json', '-'], stdin: '', files: {}, exit: 2, stdout: 'error: parse 1\n', after: {} });
T.push({ name: 'c-noop-move', argv: [], stdin: '--- a/a.txt\n+++ b/b.txt\n', files: { 'a.txt': 'same\n' }, exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', after: { 'b.txt': 'same\n' } });
T.push({ name: 'c-unsafe-backslash', argv: [], stdin: '{"command":"create","path":"a\\\\b","file_text":"x"}\n', files: {}, exit: 1, stdout: 'error: unsafe a\\b\nfailed: 1 of 1 edits\n', after: {} });
T.push({ name: 'c-unsafe-dot-seg', argv: [], stdin: '{"command":"create","path":"a/./b","file_text":"x"}\n', files: {}, exit: 1, stdout: 'error: unsafe a/./b\nfailed: 1 of 1 edits\n', after: {} });
T.push({ name: 'c-unsafe-empty-seg', argv: [], stdin: '{"command":"create","path":"a//b","file_text":"x"}\n', files: {}, exit: 1, stdout: 'error: unsafe a//b\nfailed: 1 of 1 edits\n', after: {} });


// ---- second batch: remaining spec sentences ----
T.push({ name: 'u-hunk-trailing-text', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@ func hello\n-a\n+b\n', files: { f: 'a\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'b\n' } });
T.push({ name: 'u-header-ignored-lines', argv: [], stdin: 'diff --git a/f b/f\nindex abc..def 100644\nold mode 100644\nnew mode 100644\nIndex: f\n--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: { f: 'a\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'b\n' } });
T.push({ name: 'u-create-mid-backslash', argv: [], stdin: '--- /dev/null\n+++ b/c.txt\n@@ -0,0 +1,1 @@\n+one\n\\ No newline at end of file\n@@ -0,0 +1,1 @@\n+two\n', files: {}, exit: 0, stdout: 'A c.txt\nok: 1 file\n', after: { 'c.txt': 'one\ntwo\n' } });
T.push({ name: 'u-insert-empty-file', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -0,0 +1,1 @@\n+x\n', files: { f: '' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'x\n' } });
T.push({ name: 'u-tier2-ws-only-new', argv: [], stdin: '--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n+   \n+B\n', files: { f: '  a\n  b\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: '  a\n   \n  B\n' } });
T.push({ name: 'v-begin-ws', argv: [], stdin: '  *** Begin Patch  \n*** Update File: f.txt\n a\n-b\n+B\n*** End Patch  \n', files: { 'f.txt': 'a\nb\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'a\nB\n' } });
T.push({ name: 'v-blank-between-sections', argv: [], stdin: '*** Begin Patch\n*** Add File: a.txt\n+hi\n\n\n*** Delete File: d.txt\n*** End Patch\n', files: { 'd.txt': 'x\n' }, exit: 0, stdout: 'A a.txt\nD d.txt\nok: 2 files\n', after: { 'a.txt': 'hi\n' } });
T.push({ name: 'v-add-path-trim', argv: [], stdin: '*** Begin Patch\n*** Add File:   spaced.txt  \n+x\n*** End Patch\n', files: {}, exit: 0, stdout: 'A spaced.txt\nok: 1 file\n', after: { 'spaced.txt': 'x\n' } });
T.push({ name: 'v-anchor-tier2', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n@@   anchor\n-a\n+b\n*** End Patch\n', files: { 'f.txt': '  anchor\na\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': '  anchor\nb\n' } });
T.push({ name: 'v-eof-empty-o-empty-file', argv: [], stdin: '*** Begin Patch\n*** Update File: f.txt\n+Z\n*** End of File\n*** End Patch\n', files: { 'f.txt': '' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'Z' } });
T.push({ name: 'j-str-nonstr-absent', argv: [], stdin: '{"command":"str_replace","path":"f","old_str":"b"}\n', files: { f: 'ab\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\n' } });
T.push({ name: 'j-insert-crlf-newstr', argv: [], stdin: '{"command":"insert","path":"f","insert_line":1,"new_str":"x\\r\\ny"}\n', files: { f: 'a\nb\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'a\nx\ny\nb\n' } });
T.push({ name: 'c-format-auto-explicit', argv: ['--format=auto'], stdin: '--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n+b\n', files: { f: 'a\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', after: { f: 'b\n' } });
T.push({ name: 'c-check-success-no-write', argv: ['--check'], stdin: 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n', files: { 'f.txt': 'a\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', after: { 'f.txt': 'a\n' } });

for (const t of T) runCase(t);
for (const f of failures) console.log(`FAIL ${f}`);
console.log(`${pass} of ${T.length} passed`);
process.exitCode = fail === 0 ? 0 : 1;
