# Hash-based TurboSnap: content hashing in the Vite builder stats

- **Date:** 2026-06-17
- **Branch:** `cody/turbosnap-plugin`
- **Status:** Approved design, pre-implementation
- **File of record:** `code/builders/builder-vite/src/plugins/webpack-stats-plugin.ts`

## Problem

The Vite builder emits `preview-stats.json` — a dependency graph (`{ modules: [{ id, name, reasons }] }`)
that the Chromatic CLI's TurboSnap walks to decide which stories to recapture. Today that decision is
driven by **git diff**: the CLI finds changed files, then traces `reasons` (importer edges) up to the
story files that depend on them.

Git-diff tracing is fragile across environments (path differences, lockfile churn, base-commit
selection). We want a more direct signal: a **stable content hash per module**, so the CLI can reduce
each story to a single rolled-up hash and compare hashes between two builds — recapture exactly the
stories whose rolled-up hash changed.

## Goal

Add a per-module `contentHash` to the emitted stats such that, when the CLI rolls hashes up per story
and compares two builds, the changed/added/removed counts match the table below.

The fixture is the **chromatic-cli repo** (`~/Projects/chromatic-cli-codykaup`), which dogfoods
Storybook for its own UI (~115 stories) and builds with the locally-built `@storybook/builder-vite`.

| #  | Scenario | changed | added | removed |
|----|----------|:------:|:----:|:------:|
| 1  | rebuild, no edit (determinism) | 0 | 0 | 0 |
| 2  | story file — substantive (`auth.stories.ts`) | 3 | 0 | 0 |
| 3  | story file — comment-only (`auth.stories.ts`) | 0 | 0 | 0 |
| 4  | used dependency — code change (`tasks/auth.ts`) | 3 | 0 | 0 |
| 5  | preview config (`.storybook/preview.ts`) | 115 | 0 | 0 |
| 6  | preview dependency — substantive (`ansi-html`) | 115 | 0 | 0 |
| 7  | preview dependency — comment-only (`ansi-html`, plain JS) | 115 | 0 | 0 |
| 8  | add 1 story (`components/extra.stories.ts`) | 0 | 1 | 0 |
| 9  | remove 1 story (`components/link.stories.ts`) | 0 | 0 | 1 |
| 10 | `README.md` (out of graph) | 0 | 0 | 0 |
| 11 | dependency paths relocated, content identical (cross-machine / global cache) | 0 | 0 | 0 |

## Non-goals

- The per-story **rollup** and the changed/added/removed comparison live in the **Chromatic CLI**, not
  the plugin. The plugin only emits per-module data.
- No change to the existing `id` / `name` / `reasons` fields or their format. Released CLI versions and
  the existing graph-walker depend on them; this change is purely **additive**.
- No new plugin options or configuration surface.

## Design

### Output format (additive)

Add one optional field to the emitted `Module`:

```ts
interface Module {
  id: string | number;
  name: string;
  reasons?: Reason[];
  contentHash?: string; // new — stable hash of normalized transformed code
}
```

`contentHash` is absent for modules with no code (e.g. unresolved externals).

### Hash source: transformed code, not source

The hash is computed over the module's **transformed** code (Rollup `ModuleInfo.code`), not the raw
file on disk. This is the load-bearing choice for the comment-only criteria (#3, #7): esbuild/Vite
strips comments during transform, so a comment-only edit yields identical transformed output → identical
hash → 0 changed. Hashing raw source would fail #3 and #7.

The hash is over **code only**. A module's `name`/`id` (which are paths) are *not* folded into
`contentHash`, so a module's hash does not change merely because the file moved.

### Normalization before hashing

To make the hash deterministic across machines / CI (#1) and independent of dependency relocation
(#11), normalize the transformed code before hashing:

1. `slash()` — normalize path separators that may appear in the code.
2. CRLF → LF — a Windows checkout must hash identically to a Linux one.
3. Strip `sourceMappingURL` comments (`//# …` and `/*# … */`) — inline base64 maps can decode to
   absolute `sources[]`; external map references can carry environment-specific paths. Stripping
   removes the map from the hash regardless of whether its paths are relative or absolute.
4. Rewrite absolute `workingDir` and `homedir` prefixes to stable placeholders — belt-and-suspenders
   for any absolute path a transform might bake into the body.

Hash with `sha256`, truncate to 16 hex chars.

### Graph connectivity (the "preview gap") — verify, then fix only if needed

For #5/#6 (edit `.storybook/preview.ts` or a transitive preview dep like `ansi-html` → all 115 stories),
those modules must be present in the stats and connected via `reasons` up to the entry the CLI treats as
global. The current plugin builds the graph incrementally in `moduleParsed`, and preview is a *sibling*
of stories under the iframe entry (not an importer of them), so the preview subgraph may be orphaned.

**This is gated on an empirical probe (see Verification Gates).** If the probe shows `preview.ts` +
`ansi-html` already present and connected, keep `moduleParsed` and the diff stays minimal. If they are
orphaned, switch graph construction to `buildEnd` using `this.getModuleInfo`, bridging *through*
Storybook's `\0`-prefixed virtual modules so the preview subgraph is included rather than dropped.

## How each criterion is satisfied

- **#1 determinism** — identical normalized code → identical hash; no time/path/random inputs.
- **#2 / #4 substantive edit (=3)** — edited module's hash changes; CLI rolls it into the 3 stories that
  reach it through the graph.
- **#3 / #7 comment-only (=0)** — comments stripped by transform → identical transformed code → identical
  hash.
- **#5 / #6 preview + preview dep (=115)** — preview subgraph present and `reasons`-connected so the CLI
  identifies it as global and marks all stories. (Depends on the connectivity gate.)
- **#8 / #9 add / remove story (=1)** — module appears / disappears in the graph; CLI set-diffs stories.
- **#10 README (=0)** — never imported → never in the graph.
- **#11 relocated deps, identical content (=0)** — `contentHash` is path-independent (deps appear as
  source specifiers, not resolved paths; absolute prefixes stripped). See CLI-side requirement below.

## CLI-side requirement for #11

Because the plugin keeps `name`/`id` untouched for back-compat, those still contain machine-specific
paths for dependencies resolved from a **global cache** (e.g. `../../.yarn/cache/ansi-html…`). Content
hashes match across machines, but #11 holds only if the **CLI's per-story rollup keys on the multiset of
`contentHash`es (content), not on `name:hash` pairs**. If names were mixed into the rollup, relocated
deps would diff despite identical content. This is owned by the CLI; noted here so the rollup is
implemented accordingly.

## Verification gates (run before finalizing implementation)

The repo rule is "verify environment assumptions empirically before encoding them." Before relying on
the design, run a baseline build of the chromatic-cli storybook and confirm:

1. **`ModuleInfo.code` content** — dump samples for one story and one node_modules dep. Confirm: no
   absolute paths in the body; observe the actual sourcemap situation; confirm a comment-only edit
   yields byte-identical `.code`. Adjust normalization if reality differs.
2. **Preview connectivity** — inspect `preview-stats.json` for `.storybook/preview.ts` and `ansi-html`
   and their `reasons`. Decide `moduleParsed` vs `buildEnd` + virtual-module bridging based on the
   result.

## Validation plan

Loop, per scenario:

```
(cd ~/Projects/storybook-codykaup && yarn nx run-many -t compile) && \
  (cd ~/Projects/chromatic-cli-codykaup && yarn build-storybook)
```

1. Build baseline → snapshot `preview-stats.json`.
2. Apply the scenario's edit (or add/remove/relocate).
3. Rebuild → second `preview-stats.json`.
4. Roll up per-story content hashes and compute changed/added/removed; compare to the table.

Temporary `console.log`s during development surface graph size, hash deltas, and the preview subgraph so
behavior is followable from build output. Remove them before finalizing.

## Implementation steps

1. Baseline build + run **both verification gates**; record findings.
2. Add `contentHash` to the `Module` interface and emit it (hash of normalized transformed code).
3. Implement the normalization helper exactly as specified.
4. If the connectivity gate requires it, move graph construction to `buildEnd` + virtual-module bridging;
   otherwise leave `moduleParsed` in place.
5. Walk the validation loop across all 11 scenarios; iterate until the table matches.
6. Remove temporary logging; `cd code && yarn fmt:write`; lint; typecheck.

## Risks / open questions

- **Transform may not strip all comments in every loader path.** Mitigation: gate #1 confirms it; if a
  path preserves comments, add comment-stripping to normalization.
- **`buildEnd` graph rebuild** (if needed) is a larger change than `moduleParsed` and must reproduce the
  existing `reasons` edges exactly to avoid regressing git-based TurboSnap for older CLIs.
- **Hash truncation collisions** — 16 hex chars (64 bits) is ample for per-build module counts; not a
  practical concern.
