import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUnifiedDiff, unquote } from '../src/change/hunks.ts';

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,0 +11,3 @@ export function a() {
+  const x = 1;
+  const y = 2;
+  return x + y;
@@ -30 +33 @@ export function b() {
-  return 1;
+  return 2;
@@ -40,2 +43,0 @@ export function c() {
-  gone();
-  gone2();
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1;
+export const m = 2;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
`;

test('parseUnifiedDiff keeps added and modified new-side ranges, drops pure deletions and deleted files', () => {
  assert.deepEqual(parseUnifiedDiff(diff), [
    { path: 'src/a.ts', status: 'modified', ranges: [{ start: 11, end: 13 }, { start: 33, end: 33 }] },
    { path: 'src/new.ts', status: 'added', ranges: [{ start: 1, end: 2 }] },
  ]);
});

test('parseUnifiedDiff returns nothing for an empty diff', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('parseUnifiedDiff does not mistake a "++ " content line for a file header', () => {
  const text = `diff --git a/src/plus.ts b/src/plus.ts
new file mode 100644
--- /dev/null
+++ b/src/plus.ts
@@ -0,0 +1,2 @@
+++ weird
+more
`;
  assert.deepEqual(parseUnifiedDiff(text), [{ path: 'src/plus.ts', status: 'added', ranges: [{ start: 1, end: 2 }] }]);
});

test('parseUnifiedDiff unquotes a C-quoted header path', () => {
  const text = `diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1 +1 @@
-x
+y
`;
  assert.deepEqual(parseUnifiedDiff(text).map((f) => f.path), ['src/café.ts']);
  assert.equal(unquote('"a\\tb\\"c"'), 'a\tb"c');
  assert.equal(unquote('plain'), 'plain');
});
