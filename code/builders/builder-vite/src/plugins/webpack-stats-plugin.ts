// This plugin is a direct port of https://github.com/IanVS/vite-plugin-turbosnap
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { relative } from 'node:path';

import type { BuilderStats } from 'storybook/internal/types';

// eslint-disable-next-line depend/ban-dependencies
import slash from 'slash';
import type { Plugin } from 'vite';

import { SB_VIRTUAL_FILES, getOriginalVirtualModuleId } from '../virtual-file-names.ts';

/*
 * Reason, Module are copied from chromatic types
 * https://github.com/chromaui/chromatic-cli/blob/145a5e295dde21042e96396c7e004f250d842182/bin-src/types.ts#L265-L276
 */
interface Reason {
  moduleName: string;
}
interface Module {
  id: string | number;
  name: string;
  modules?: Array<Pick<Module, 'name'>>;
  reasons?: Reason[];
  /**
   * Stable hash of this module's normalized, post-transform content. Lets hash-based TurboSnap
   * reduce a story to a single hash by rolling up the hashes of its reachable modules, instead of
   * git-diffing. Absent for modules with no code (e.g. unresolved externals).
   */
  contentHash?: string;
}

type WebpackStatsPluginOptions = {
  workingDir: string;
};

/**
 * Strips off query params added by rollup/vite to ids, to make paths compatible for comparison with
 * git.
 */
function stripQueryParams(filePath: string): string {
  return filePath.split('?')[0];
}

/**
 * Modules we keep as nodes in the emitted graph: user code, node_modules, and Storybook's own
 * virtual entry files. Vite/Rollup infrastructure and internal `\0`-prefixed virtual modules are
 * not kept — but the graph is bridged *through* them (see {@link resolveKeptImports}) so the real
 * modules they connect (notably `.storybook/preview.*` via the project-annotations virtual) are not
 * orphaned out of the graph.
 */
function isKept(moduleName: string) {
  if (!moduleName) {
    return false;
  }

  // keep Storybook's virtual files because they import the story files, so they are essential to the module graph
  if (Object.values(SB_VIRTUAL_FILES).includes(getOriginalVirtualModuleId(moduleName))) {
    return true;
  }

  return Boolean(
    !moduleName.startsWith('vite/') &&
    !moduleName.startsWith('\0') &&
    moduleName !== 'react/jsx-runtime'
  );
}

export type WebpackStatsPlugin = Plugin & { storybookGetStats: () => BuilderStats };

export function pluginWebpackStats({ workingDir }: WebpackStatsPluginOptions): WebpackStatsPlugin {
  const workingDirSlash = slash(workingDir);
  const homeDirSlash = slash(homedir());

  /** Convert an absolute path name to a path relative to the vite root, with a starting `./` */
  function normalize(filename: string) {
    // Do not try to resolve virtual files
    if (filename.startsWith('virtual:')) {
      // We have to append a forward slash because otherwise we break turbosnap.
      // As soon as the chromatic-cli supports `virtual:` id's without a starting forward slash,
      // we can remove adding the forward slash here
      // Reference: https://github.com/chromaui/chromatic-cli/blob/v11.25.2/node-src/lib/getDependentStoryFiles.ts#L53
      return `/${filename}`;
    }
    // ! Maintain backwards compatibility with the old virtual file names
    // ! to ensure that the stats file doesn't change between the versions
    // ! Turbosnap is also only compatible with the old virtual file names
    // ! the old virtual file names did not start with the obligatory \0 character
    if (Object.values(SB_VIRTUAL_FILES).includes(getOriginalVirtualModuleId(filename))) {
      // We have to append a forward slash because otherwise we break turbosnap.
      // As soon as the chromatic-cli supports `virtual:` id's without a starting forward slash,
      // we can remove adding the forward slash here
      // Reference: https://github.com/chromaui/chromatic-cli/blob/v11.25.2/node-src/lib/getDependentStoryFiles.ts#L53
      return `/${getOriginalVirtualModuleId(filename)}`;
    }

    // Otherwise, we need them in the format `./path/to/file.js`.
    else {
      const relativePath = relative(workingDir, stripQueryParams(filename));
      // This seems hacky, got to be a better way to add a `./` to the start of a path.
      return `./${slash(relativePath)}`;
    }
  }

  /**
   * Normalize a module's transformed code before hashing so the hash is deterministic across
   * machines/CI: drop sourcemap references (their paths/contents are environment-specific) and
   * rewrite absolute project/home paths to stable placeholders.
   */
  function normalizeCode(code: string) {
    return slash(code)
      .replace(/\n?\/\/# sourceMappingURL=.*$/gm, '')
      .replace(/\/\*# sourceMappingURL=[\s\S]*?\*\//g, '')
      .split(workingDirSlash)
      .join('.')
      .split(homeDirSlash)
      .join('~');
  }

  function hashCode(code: string | null | undefined): string | undefined {
    if (code == null) {
      return undefined;
    }
    return createHash('sha256').update(normalizeCode(code)).digest('hex').slice(0, 16);
  }

  const statsMap = new Map<string, Module>();

  return {
    name: 'storybook:rollup-plugin-webpack-stats',
    // We want this to run after the vite build plugins (https://vitejs.dev/guide/api-plugin.html#plugin-ordering)
    enforce: 'post',
    // Build the graph from Rollup's complete module info at the end of the build, rather than
    // incrementally in `moduleParsed`. This lets us bridge *through* the internal virtual modules
    // that Storybook wires the preview config through, so `.storybook/preview.*` and addon preview
    // entries are no longer orphaned out of the Vite graph (the "preview gap").
    buildEnd() {
      const importsOf = (id: string): readonly string[] => {
        const info = this.getModuleInfo(id);
        if (!info) {
          return [];
        }
        return info.importedIds.concat(info.dynamicallyImportedIds);
      };

      /**
       * The kept modules that `id` really imports, bridging through any non-kept modules in
       * between (e.g. connecting a virtual module's real importers to its real imports).
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

      const ensureModule = (rawId: string): Module => {
        const name = normalize(rawId);
        let mod = statsMap.get(name);
        if (!mod) {
          mod = {
            id: name,
            name,
            reasons: [],
            contentHash: hashCode(this.getModuleInfo(rawId)?.code),
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
        if (!isKept(id)) {
          continue;
        }
        const importer = ensureModule(id);
        for (const depId of resolveKeptImports(id)) {
          addReason(ensureModule(depId), importer.name);
        }
      }
    },

    storybookGetStats() {
      const stats = { modules: Array.from(statsMap.values()) };
      return { ...stats, toJson: () => stats };
    },
  };
}
