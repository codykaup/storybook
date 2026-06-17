# Hash-based TurboSnap Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable, path-independent `contentHash` to each module in the Vite builder's emitted `preview-stats.json`, and connect Storybook's preview subgraph into the graph, so the Chromatic CLI can decide story recapture by rolling up per-story hashes across two builds.

**Architecture:** A single Rollup/Vite plugin (`webpack-stats-plugin.ts`) builds the dependency graph in `buildEnd` from Rollup's complete module info. Each kept module gets a `contentHash` = sha256 of its normalized transformed code. The graph bridges *through* Storybook's `\0`-prefixed internal virtual modules (keeping the project-annotations virtual module as a node) so `.storybook/preview.*` and its dependencies are no longer orphaned. The plugin stays "dumb": rollup and comparison live in the CLI.

**Tech Stack:** TypeScript, Vite/Rollup plugin API, `node:crypto` (`createHash`), `node:os` (`homedir`), `slash`. Validation by building the Chromatic CLI's Storybook (`~/Projects/chromatic-cli-codykaup`) and inspecting `storybook-static/preview-stats.json`.

## Global Constraints

- **Additive only.** Never change the format or values of the existing `id` / `name` / `reasons` fields. The only new field is `Module.contentHash?: string`.
- **Hash spec.** `sha256` over normalized transformed code, hex, truncated to 16 chars. Absent (`undefined`) for modules with no code.
- **Normalization (exact order).** `slash()` → CRLF→LF → strip `sourceMappingURL` comments → rewrite `workingDir` prefix to `.` → rewrite `homedir` prefix to `~`. `workingDir` MUST be rewritten before `homedir` (workingDir is nested under homedir).
- **No unit tests for this work.** Validation is building the builder and inspecting the stats. Do not add `*.test.ts`.
- **Logging.** Temporary `console.log` is allowed during development so the build output is followable, but every temporary log MUST be removed in the final cleanup task.
- **Base branch.** Work stays on `cody/turbosnap-plugin`; PRs target `next`.
- **Do not touch** the untracked scratch file `code/builders/builder-vite/src/plugins/PR-HASH-BASED-TURBOSNAP.ts` (user's reference; leave it untracked, do not commit or delete).
- **Build commands (used by every task):**
  - Compile: `cd ~/Projects/storybook-codykaup && yarn nx run-many -t compile`
  - Build stats: `cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook`
  - Stats file: `~/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json`
- **Finalize (cleanup task):** `cd code && yarn fmt:write`, then `yarn --cwd code lint:js:cmd builders/builder-vite/src/plugins/webpack-stats-plugin.ts --fix`, then `yarn nx run-many -t check`.

---

## Task 1: Verification gates (empirical; nothing committed)

Confirm the two assumptions the design rests on before writing implementation code. This task commits **no** code — any probe edits are reverted at the end.

**Files:**
- Temporarily modify: `code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts` (probe logging, reverted before the task ends)

**Interfaces:**
- Consumes: nothing.
- Produces: a written findings note appended to this plan under "Gate findings" covering (a) what absolute paths / sourcemap refs appear in `ModuleInfo.code`, (b) whether comment-only edits yield identical `.code`, (c) the exact import chain `vite-app → project-annotations → preview.ts → … → ansi-html` and where it currently breaks, (d) how `ansi-html` is reachable (via `.storybook/preview.ts` or via an addon preview entry).

- [ ] **Step 1: Baseline build**

```bash
cd ~/Projects/storybook-codykaup && yarn nx run-many -t compile
cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook
```

Expected: build succeeds; `~/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json` exists.

- [ ] **Step 2: Inspect the graph for the preview gap**

Run (prints whether key modules are present and what their `reasons` are):

```bash
node -e '
const s = require("/Users/cody/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json");
const find = (sub) => s.modules.filter((m) => String(m.name).includes(sub));
for (const sub of ["preview.ts", "ansi-html", "vite-app.js", "storybook-stories.js", "project-annotations"]) {
  const hits = find(sub);
  console.log(`\n=== ${sub} (${hits.length}) ===`);
  for (const m of hits.slice(0, 3)) console.log(m.name, "<=", (m.reasons||[]).map((r)=>r.moduleName));
}
console.log("\ntotal modules:", s.modules.length);
'
```

Expected: `preview.ts` and `ansi-html` appear, but their `reasons` do NOT chain up to `vite-app.js` (the `\0`-prefixed `project-annotations` module is dropped, so the preview branch is orphaned). Record the actual `reasons` chains and how `ansi-html` is reached.

- [ ] **Step 3: Probe the transformed code that will be hashed**

Temporarily add this to `webpack-stats-plugin.ts` inside the plugin object (it does not yet have a `buildEnd`; add one for the probe):

```ts
buildEnd() {
  for (const id of this.getModuleIds()) {
    if (id.includes('ansi-html') || id.includes('auth.stories')) {
      const code = this.getModuleInfo(id)?.code ?? '';
      console.log(`\n##### CODE ${id}\n` + code.slice(0, 400));
    }
  }
},
```

Run the compile + build commands from Step 1 and read the printed code.

Expected/record: whether the body contains absolute `workingDir`/`homedir` paths, and whether a `//# sourceMappingURL=` comment is present. (Story import targets are absolute in the virtual stories module specifically — verify there too if present.)

- [ ] **Step 4: Probe comment stripping**

Add a comment-only edit to a dependency, rebuild, and confirm the transformed code is unchanged:

```bash
# add a throwaway comment line to ansi-html's entry
node -e 'const fs=require("fs");const p="/Users/cody/Projects/chromatic-cli-codykaup/node_modules/ansi-html/index.js";fs.writeFileSync(p,"// probe comment\n"+fs.readFileSync(p,"utf8"))'
cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook
```

Expected: the `##### CODE …ansi-html…` output is byte-identical to Step 3 (the comment was stripped by transform). Record the result, then restore the file:

```bash
cd ~/Projects/chromatic-cli-codykaup && git checkout -- node_modules/ansi-html/index.js 2>/dev/null || git -C node_modules/ansi-html checkout . 2>/dev/null || true
```

(If `ansi-html` is not git-tracked, reinstall it or remove the probe line by hand.)

- [ ] **Step 5: Record findings and revert the probe**

Append a "Gate findings" section to this plan summarizing Steps 2–4. Then revert the probe logging:

```bash
cd ~/Projects/storybook-codykaup && git checkout -- code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts
```

Expected: `git status` shows the plugin file unchanged from its committed state (only the import-tweak that already existed remains).

- [ ] **Step 6: Decision check**

Confirm the plan still holds:
- If Step 4 showed comments stripped → normalization needs no comment-stripping (keep spec as-is). If comments survived in some path → add a comment-stripping rule to `normalizeCode` in Task 2.
- If Step 2 confirmed the preview branch is orphaned → proceed with Tasks 2 + 3 as written.

No commit (this task produces only the findings note).

---

## Task 2: Emit `contentHash` from a `buildEnd` graph

Replace the incremental `moduleParsed` graph construction with an equivalent `buildEnd` construction (kept-module nodes + direct kept-import reasons) and attach a `contentHash` to every node. This covers determinism (#1), story/dep edits (#2, #4), comment-only (#3), add/remove (#8, #9), and out-of-graph (#10). The preview scenarios (#5/#6/#7) are handled in Task 3.

**Files:**
- Modify: `code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts`

**Interfaces:**
- Consumes: `SB_VIRTUAL_FILES`, `getOriginalVirtualModuleId` from `../virtual-file-names.ts` (already imported).
- Produces: `Module.contentHash?: string`; helper `hashContent(code: string | null | undefined): string | undefined`; helper `normalizeCode(code: string): string`. The plugin still exports `pluginWebpackStats({ workingDir })` and `storybookGetStats()` unchanged.

- [ ] **Step 1: Add imports and the `contentHash` field**

At the top of the file, add the Node imports alongside the existing `relative` import:

```ts
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { relative } from 'node:path';
```

Extend the `Module` interface:

```ts
interface Module {
  id: string | number;
  name: string;
  modules?: Array<Pick<Module, 'name'>>;
  reasons?: Reason[];
  /**
   * Stable hash of this module's normalized, post-transform content. Lets hash-based TurboSnap
   * reduce a story to a single hash by rolling up its reachable modules instead of git-diffing.
   * Absent for modules with no code (e.g. unresolved externals).
   */
  contentHash?: string;
}
```

- [ ] **Step 2: Add the normalization + hashing helpers**

Inside `pluginWebpackStats`, near the top of the function body (before `normalize`), add the slashed dir prefixes and the helpers:

```ts
const workingDirSlash = slash(workingDir);
const homeDirSlash = slash(homedir());

/**
 * Normalize transformed code before hashing so the hash is deterministic across machines/CI:
 * normalize separators and line endings, drop sourcemap references (environment-specific), and
 * rewrite absolute project/home paths to stable placeholders. workingDir is rewritten before
 * homedir because workingDir is nested under homedir.
 */
function normalizeCode(code: string) {
  return slash(code)
    .replace(/\r\n/g, '\n')
    .replace(/\n?\/\/# sourceMappingURL=.*$/gm, '')
    .replace(/\/\*# sourceMappingURL=[\s\S]*?\*\//g, '')
    .split(workingDirSlash)
    .join('.')
    .split(homeDirSlash)
    .join('~');
}

function hashContent(code: string | null | undefined): string | undefined {
  if (code == null) {
    return undefined;
  }
  return createHash('sha256').update(normalizeCode(code)).digest('hex').slice(0, 16);
}
```

- [ ] **Step 3: Replace `moduleParsed` with a `buildEnd` graph builder**

Delete the `createReasons`, `createStatsMapModule`, and `moduleParsed` members. Keep `statsMap` and `storybookGetStats`. Add this `buildEnd` (note `enforce: 'post'` stays):

```ts
buildEnd() {
  const importsOf = (id: string): readonly string[] => {
    const info = this.getModuleInfo(id);
    return info ? info.importedIds.concat(info.dynamicallyImportedIds) : [];
  };

  const ensureModule = (rawId: string): Module => {
    const name = normalize(rawId);
    let mod = statsMap.get(name);
    if (!mod) {
      mod = {
        id: name,
        name,
        reasons: [],
        contentHash: hashContent(this.getModuleInfo(rawId)?.code),
      };
      statsMap.set(name, mod);
    }
    return mod;
  };

  const addReason = (target: Module, importerName: string) => {
    if (importerName === target.name) {
      return;
    }
    if (!target.reasons!.some((r) => r.moduleName === importerName)) {
      target.reasons!.push({ moduleName: importerName });
    }
  };

  for (const id of this.getModuleIds()) {
    if (!isUserCode(id)) {
      continue;
    }
    const importer = ensureModule(id);
    for (const depId of importsOf(id)) {
      if (!isUserCode(depId)) {
        continue;
      }
      addReason(ensureModule(depId), importer.name);
    }
  }
},
```

- [ ] **Step 4: Compile and rebuild**

```bash
cd ~/Projects/storybook-codykaup && yarn nx run-many -t compile
cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook
```

Expected: build succeeds.

- [ ] **Step 5: Verify hashes are present and deterministic (#1)**

```bash
cp ~/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json /tmp/stats-a.json
cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook
node -e '
const a = require("/tmp/stats-a.json").modules;
const b = require("/Users/cody/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json").modules;
const withHash = a.filter((m)=>m.contentHash).length;
const map = (xs)=>Object.fromEntries(xs.map((m)=>[m.name,m.contentHash]));
const ma = map(a), mb = map(b);
const changed = Object.keys(ma).filter((k)=>ma[k]!==mb[k]);
console.log("modules:", a.length, "withHash:", withHash, "changedAcrossRebuild:", changed.length);
'
```

Expected: `withHash` is a large fraction of `modules`; `changedAcrossRebuild` is `0` (determinism #1).

- [ ] **Step 6: Verify story/dep/comment/README behavior at the module level**

Substantive edit (#2): append a real statement to a story, rebuild, confirm exactly that module's hash changed:

```bash
cp ~/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json /tmp/stats-base.json
node -e 'const fs=require("fs");const p="/Users/cody/Projects/chromatic-cli-codykaup/node-src/ui/tasks/auth.stories.ts";fs.appendFileSync(p,"\nexport const __probe = 1;\n")'
cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook
node -e '
const base = Object.fromEntries(require("/tmp/stats-base.json").modules.map((m)=>[m.name,m.contentHash]));
const now = Object.fromEntries(require("/Users/cody/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json").modules.map((m)=>[m.name,m.contentHash]));
console.log("changed:", Object.keys(base).filter((k)=>base[k]!==now[k]));
'
cd ~/Projects/chromatic-cli-codykaup && git checkout -- node-src/ui/tasks/auth.stories.ts
```

Expected: only the `auth.stories.ts` module hash changed.

Comment-only (#3): repeat with a comment instead of a statement and confirm `changed` is empty. README (#10): confirm `README.md` never appears in `stats.modules`.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/storybook-codykaup
git add code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts
git commit -m "feat(builder-vite): emit per-module contentHash in turbosnap stats"
```

---

## Task 3: Connect the preview subgraph

Keep the project-annotations virtual module as a graph node and bridge *through* the remaining `\0`/internal modules so `vite-app → project-annotations → preview.ts → … → ansi-html` is connected. This lets the CLI globalize the preview subgraph (#5/#6/#7). Keeping `project-annotations` as a node (rather than bridging straight to the entry) prevents real preview/addon modules from being misclassified as story files (`csfGlobs`).

**Files:**
- Modify: `code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts`

**Interfaces:**
- Consumes: `VIRTUAL_ID` from `./storybook-project-annotations-plugin.ts` (value `virtual:/@storybook/builder-vite/project-annotations.js`); `getOriginalVirtualModuleId`.
- Produces: an `isKept` predicate replacing `isUserCode`; a `resolveKeptImports(id)` bridge. Graph node set now includes the project-annotations module and the connected preview subgraph.

- [ ] **Step 1: Import the project-annotations virtual id**

Add to the imports:

```ts
import { VIRTUAL_ID as PROJECT_ANNOTATIONS_VIRTUAL_ID } from './storybook-project-annotations-plugin.ts';
```

- [ ] **Step 2: Extend the kept-module predicate**

Rename `isUserCode` to `isKept` (update its callers in `buildEnd`) and keep the project-annotations virtual module:

```ts
/**
 * Modules we keep as nodes in the emitted graph: user code, node_modules, and Storybook's own
 * virtual entry + project-annotations files. Vite/Rollup infrastructure and other internal
 * `\0`-prefixed virtual modules are bridged *through* (see resolveKeptImports), not kept, so the
 * real modules they connect are not orphaned.
 */
function isKept(moduleName: string) {
  if (!moduleName) {
    return false;
  }
  const original = getOriginalVirtualModuleId(moduleName);
  if (Object.values(SB_VIRTUAL_FILES).includes(original)) {
    return true;
  }
  // Keep the project-annotations bridge so preview.* and its deps connect to the entry.
  if (original === PROJECT_ANNOTATIONS_VIRTUAL_ID) {
    return true;
  }
  return Boolean(
    !moduleName.startsWith('vite/') &&
      !moduleName.startsWith('\0') &&
      moduleName !== 'react/jsx-runtime'
  );
}
```

- [ ] **Step 3: Bridge through non-kept modules**

In `buildEnd`, add `resolveKeptImports` and use it in place of the direct-import loop:

```ts
/**
 * The kept modules that `id` really imports, bridging through any non-kept modules in between
 * (e.g. connecting the project-annotations virtual module's real imports to their importers).
 */
const resolveKeptImports = (id: string): string[] => {
  const result = new Set<string>();
  const visited = new Set<string>();
  const stack = [...importsOf(id)];
  while (stack.length > 0) {
    const dep = stack.pop()!;
    if (visited.has(dep)) {
      continue;
    }
    visited.add(dep);
    if (isKept(dep)) {
      result.add(dep);
    } else {
      stack.push(...importsOf(dep));
    }
  }
  return [...result];
};
```

Replace the inner loop:

```ts
for (const id of this.getModuleIds()) {
  if (!isKept(id)) {
    continue;
  }
  const importer = ensureModule(id);
  for (const depId of resolveKeptImports(id)) {
    addReason(ensureModule(depId), importer.name);
  }
}
```

- [ ] **Step 4: Confirm `normalize` handles the project-annotations id**

No code change expected: its resolved id is `\0virtual:/@storybook/builder-vite/project-annotations.js`, so `getOriginalVirtualModuleId` strips the `\0` and the existing `virtual:` branch of `normalize` returns `/virtual:/@storybook/builder-vite/project-annotations.js`. Verify by reading the build output in Step 6.

- [ ] **Step 5: Compile and rebuild**

```bash
cd ~/Projects/storybook-codykaup && yarn nx run-many -t compile
cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook
```

Expected: build succeeds.

- [ ] **Step 6: Verify connectivity (the preview gap is closed)**

```bash
node -e '
const s = require("/Users/cody/Projects/chromatic-cli-codykaup/storybook-static/preview-stats.json");
const by = Object.fromEntries(s.modules.map((m)=>[m.name, m]));
const show = (sub) => s.modules.filter((m)=>String(m.name).includes(sub)).slice(0,3)
  .forEach((m)=>console.log(m.name, "<=", (m.reasons||[]).map((r)=>r.moduleName)));
console.log("== project-annotations =="); show("project-annotations");
console.log("== preview.ts =="); show("preview.ts");
console.log("== ansi-html =="); show("ansi-html");
'
```

Expected: `project-annotations` lists the vite-app entry in its `reasons`; `preview.ts` lists `project-annotations`; `ansi-html` chains (directly or transitively) back toward `project-annotations`/`preview.ts`. Story files must still list `storybook-stories.js` as a reason (no regression).

- [ ] **Step 7: Verify preview/preview-dep edits propagate (#5/#6/#7)**

Edit `.storybook/preview.ts` substantively, rebuild, confirm its module hash changed and it is connected; repeat substantive + comment-only edits to `ansi-html`. (Whether the CLI converts these to `changed: 115` is the CLI's rollup job; here confirm the plugin gives it a connected, hash-changed preview subgraph.) Restore edited files with `git checkout --` afterward.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/storybook-codykaup
git add code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts
git commit -m "feat(builder-vite): connect preview subgraph in turbosnap stats"
```

---

## Task 4: Validate the full scenario table

Run the build → edit → rebuild → compare loop for all 11 scenarios using the Chromatic CLI's hash comparison (the source of truth for the changed/added/removed counts). Record results against the table.

**Files:**
- No source changes (validation only). Edits to fixture files in `~/Projects/chromatic-cli-codykaup` are reverted after each scenario.

**Interfaces:**
- Consumes: the committed plugin from Tasks 2–3; the Chromatic CLI's hash-based comparison.
- Produces: a results table appended to this plan; a list of any scenarios that miss, with the observed graph/hash evidence.

- [ ] **Step 1: Map scenario files to fixture paths**

Record the concrete paths in `~/Projects/chromatic-cli-codykaup` for each row: `auth.stories.ts` → `node-src/ui/tasks/auth.stories.ts`; `tasks/auth.ts` → `node-src/ui/tasks/auth.ts`; `.storybook/preview.ts`; `ansi-html` (node_modules); `components/link.stories.ts` (remove); `components/extra.stories.ts` (add); `README.md`.

- [ ] **Step 2: Run each scenario**

For each row: snapshot baseline stats, apply the edit/add/remove/relocate, rebuild, run the CLI's compare to produce changed/added/removed, revert. For #11, simulate path relocation (e.g. install/resolve a dependency from a different absolute location, or temporarily move the dep and re-point resolution) with identical content and confirm `0/0/0`.

- [ ] **Step 3: Record results**

Append a results table (scenario, expected, observed) to this plan. For any mismatch, capture the relevant `reasons`/`contentHash` evidence and note whether the fix is plugin-side (graph/hash) or CLI-side (rollup/global scoping).

- [ ] **Step 4: Commit the results note**

```bash
cd ~/Projects/storybook-codykaup
git add docs/superpowers/plans/2026-06-17-hash-based-turbosnap-stats.md
git commit -m "docs(builder-vite): record hash-based turbosnap validation results"
```

---

## Task 5: Cleanup and quality gates

**Files:**
- Modify (only if temporary logs remain): `code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts`

- [ ] **Step 1: Remove temporary logging**

Search the plugin for any leftover `console.log` and remove them:

```bash
grep -n "console.log" ~/Projects/storybook-codykaup/code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts
```

Expected after cleanup: no matches.

- [ ] **Step 2: Format, lint, typecheck**

```bash
cd ~/Projects/storybook-codykaup/code && yarn fmt:write
yarn --cwd ~/Projects/storybook-codykaup/code lint:js:cmd builders/builder-vite/src/plugins/webpack-stats-plugin.ts --fix
cd ~/Projects/storybook-codykaup && yarn nx run-many -t check
```

Expected: formatting applied, lint clean, no TypeScript errors.

- [ ] **Step 3: Final build sanity check**

```bash
cd ~/Projects/storybook-codykaup && yarn nx run-many -t compile
cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook
```

Expected: build succeeds; stats contain `contentHash` and the connected preview subgraph.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/storybook-codykaup
git add code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts
git commit -m "chore(builder-vite): remove temporary turbosnap stats logging"
```

---

## Self-review notes

- **Spec coverage:** #1 (Task 2 Step 5), #2/#3/#10 (Task 2 Step 6), #4 (Task 2 Step 6 pattern on `tasks/auth.ts`), #5/#6/#7 (Task 3 Steps 6–7), #8/#9 (story set-diff — verified via the CLI compare in Task 4; module appears/disappears in the graph), #11 (Task 4 Step 2). Normalization rules → Task 2 Step 2. Connectivity → Task 3. CLI rollup model → documented in the spec, exercised in Task 4.
- **Watch-item (CLI-side):** keeping `project-annotations` as a node makes it (and `setup-addons`) match the CLI's `csfGlob` heuristic (reasons include the entry). These are constant across builds and benign for added/removed, but if Task 4 shows miscounts, the fix is excluding virtual modules from `csfGlobs` in the CLI — not the plugin.
- **#11 keying:** holds only if the CLI rollup keys on the multiset of `contentHash`es, not `name:hash` pairs (paths in `name` are not machine-stable for global-cache deps).

---

## Validation results (2026-06-17)

**Setup.** Validated against the `chromatic-cli` repo (`@storybook/html-vite`, 115 story files /
342 stories). The locally-built `@storybook/builder-vite` was linked into the CLI by replacing
`node_modules/@storybook/builder-vite` with a symlink to the monorepo package, then running
`yarn build-storybook` and inspecting `storybook-static/preview-stats.json`. The changed/added/removed
counts were computed with a standalone harness implementing the spec's CLI-side rollup model (the CLI
itself does not yet ship hash-based comparison): story files = modules imported by the stories entry;
preview subgraph = modules reachable from the project-annotations virtual module; per-story rollup =
sha256 over the sorted multiset of reachable modules' `contentHash`es (keyed on content, not paths);
globalize-on-preview-change → all stories.

**Gate findings.**

- _Connectivity (old plugin)._ Baseline with published `@storybook/builder-vite` confirmed the gap:
  `project-annotations` was absent (dropped as a `\0` virtual), and `.storybook/preview.ts` appeared
  only as a `reason` with no node of its own, so the preview branch never chained to `vite-app.js`.
  After Task 3 the chain is connected: `./iframe.html → vite-app.js → project-annotations.js →
  ./.storybook/preview.ts → ./node_modules/ansi-html/index.js`.
- _Transformed code._ `ModuleInfo.code` for `.ts` modules is comment-free (esbuild strips them), but
  the CommonJS→ESM wrapper for plain-JS node_modules deps (e.g. `ansi-html`) keeps source comments
  verbatim. The ESM facade also embeds an absolute `workingDir` path in an import specifier, confirming
  the path-rewrite step is load-bearing. This drove two normalization fixes beyond the original spec:
  comment stripping in `normalizeCode` (literals preserved) and whitespace collapse (so the blank line
  left by a removed comment does not change the hash).
- _Naming._ The project-annotations resolved id (`\0virtual:…`) was not handled by `normalize()` and
  produced a name with an embedded null byte; it is now normalized like the other virtual files.

**Scenario table (observed = expected).**

| #  | Scenario                                    | changed | added | removed |
|----|---------------------------------------------|:------:|:----:|:------:|
| 1  | rebuild, no edit (determinism)              | 0      | 0    | 0      |
| 2  | story file — substantive (`auth.stories.ts`)| 3      | 0    | 0      |
| 3  | story file — comment-only                   | 0      | 0    | 0      |
| 4  | used dependency — code change (`tasks/auth.ts`)| 3   | 0    | 0      |
| 5  | preview config (`.storybook/preview.ts`)    | 115    | 0    | 0      |
| 6  | preview dependency — substantive (`ansi-html`)| 115  | 0    | 0      |
| 7  | preview dependency — comment-only (`ansi-html`)| 0   | 0    | 0      |
| 8  | add 1 story (`components/extra.stories.ts`) | 0      | 1    | 0      |
| 9  | remove 1 story (`components/link.stories.ts`)| 0     | 0    | 1      |
| 10 | `README.md` (out of graph)                  | 0      | 0    | 0      |
| 11 | dependency paths relocated, content identical| 0     | 0    | 0      |

All 11 rows match. #2/#4 yield 3 because `auth.stories.ts` (and `tasks/auth.ts`, which it imports) is
re-imported by `workflows/uploadBuild.stories.ts` and `workflows/uploadBuildE2E.stories.ts`, so three
story files roll up the changed hash. #11 was simulated by relocating every `./node_modules/` path to a
`./.yarn/global-cache/` path with identical content (155 modules); the content-keyed rollup reports
0/0/0.
