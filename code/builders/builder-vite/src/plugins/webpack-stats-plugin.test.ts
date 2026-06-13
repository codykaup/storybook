import { describe, expect, it } from 'vitest';

import { getResolvedVirtualModuleId } from '../virtual-file-names.ts';
import { type WebpackStatsPlugin, pluginWebpackStats } from './webpack-stats-plugin.ts';

const workingDir = '/project';

/** Minimal stand-in for a Rollup module in the build graph. */
interface FakeModule {
  importedIds?: string[];
  dynamicallyImportedIds?: string[];
  code?: string | null;
}

/**
 * Drives the plugin's `buildEnd` hook against a fake Rollup module graph and returns the emitted
 * stats. `graph` maps a module id to the ids it imports (and optionally its transformed code).
 */
function runPlugin(graph: Record<string, FakeModule>) {
  const plugin = pluginWebpackStats({ workingDir }) as WebpackStatsPlugin;
  const context = {
    getModuleIds: () => Object.keys(graph)[Symbol.iterator](),
    getModuleInfo: (id: string) => {
      const mod = graph[id];
      if (!mod) {
        return null;
      }
      return {
        id,
        importedIds: mod.importedIds ?? [],
        dynamicallyImportedIds: mod.dynamicallyImportedIds ?? [],
        code: 'code' in mod ? mod.code : `/* ${id} */`,
      };
    },
  };

  (plugin.buildEnd as any).call(context, undefined);
  return plugin.storybookGetStats().toJson() as {
    modules: Array<{
      id: string;
      name: string;
      reasons?: { moduleName: string }[];
      contentHash?: string;
    }>;
  };
}

const STORIES_VIRTUAL = getResolvedVirtualModuleId(
  'virtual:/@storybook/builder-vite/storybook-stories.js'
);
const APP_VIRTUAL = getResolvedVirtualModuleId('virtual:/@storybook/builder-vite/vite-app.js');
const PROJECT_ANNOTATIONS_VIRTUAL = getResolvedVirtualModuleId(
  'virtual:/@storybook/builder-vite/project-annotations.js'
);

describe('pluginWebpackStats', () => {
  it('bridges through internal virtual modules so the preview is not orphaned', () => {
    // vite-app -> (project-annotations virtual) -> .storybook/preview.ts -> theme.ts
    // The project-annotations virtual is `\0`-prefixed and must be bridged through, not dropped.
    const { modules } = runPlugin({
      [APP_VIRTUAL]: { importedIds: [PROJECT_ANNOTATIONS_VIRTUAL] },
      [PROJECT_ANNOTATIONS_VIRTUAL]: { importedIds: ['/project/.storybook/preview.ts'] },
      '/project/.storybook/preview.ts': { importedIds: ['/project/.storybook/theme.ts'] },
      '/project/.storybook/theme.ts': {},
    });

    const preview = modules.find((m) => m.name === './.storybook/preview.ts');
    expect(preview).toBeDefined();
    // The preview's real importer (the app virtual) is reconnected by bridging through the
    // dropped project-annotations virtual.
    expect(preview?.reasons).toContainEqual({
      moduleName: '/virtual:/@storybook/builder-vite/vite-app.js',
    });

    const theme = modules.find((m) => m.name === './.storybook/theme.ts');
    expect(theme?.reasons).toContainEqual({ moduleName: './.storybook/preview.ts' });

    // The dropped virtual module itself is not a node in the graph.
    expect(modules.some((m) => String(m.id).includes('project-annotations'))).toBe(false);
  });

  it('keeps node_modules and story files connected via the stories virtual', () => {
    const { modules } = runPlugin({
      [STORIES_VIRTUAL]: { importedIds: ['/project/src/Button.stories.tsx'] },
      '/project/src/Button.stories.tsx': {
        importedIds: ['/project/src/Button.tsx', '/project/node_modules/react/index.js'],
      },
      '/project/src/Button.tsx': { importedIds: ['/project/node_modules/react/index.js'] },
      '/project/node_modules/react/index.js': {},
    });

    const story = modules.find((m) => m.name === './src/Button.stories.tsx');
    expect(story?.reasons).toContainEqual({
      moduleName: '/virtual:/@storybook/builder-vite/storybook-stories.js',
    });

    // node_modules files are retained as nodes so they can be hashed.
    const react = modules.find((m) => m.name === './node_modules/react/index.js');
    expect(react).toBeDefined();
    expect(react?.reasons).toContainEqual({ moduleName: './src/Button.stories.tsx' });
    expect(react?.reasons).toContainEqual({ moduleName: './src/Button.tsx' });
  });

  it('emits a stable, normalized content hash per module', () => {
    const stableCode = 'export const x = 1;';
    const first = runPlugin({ '/project/src/a.ts': { code: stableCode } });
    const second = runPlugin({ '/project/src/a.ts': { code: stableCode } });

    const hashOf = (stats: ReturnType<typeof runPlugin>) =>
      stats.modules.find((m) => m.name === './src/a.ts')?.contentHash;

    expect(hashOf(first)).toBeDefined();
    expect(hashOf(first)).toBe(hashOf(second));

    // Sourcemap references and absolute project paths are stripped before hashing, so they don't
    // contribute machine-specific noise to the hash.
    const withNoise = runPlugin({
      '/project/src/a.ts': {
        code: `${stableCode}\n//# sourceMappingURL=data:application/json;base64,abc123`,
      },
    });
    expect(hashOf(withNoise)).toBe(hashOf(first));

    const differentContent = runPlugin({ '/project/src/a.ts': { code: 'export const x = 2;' } });
    expect(hashOf(differentContent)).not.toBe(hashOf(first));
  });

  it('omits the content hash for modules without code', () => {
    const { modules } = runPlugin({ '/project/src/external-ish.ts': { code: null } });
    const mod = modules.find((m) => m.name === './src/external-ish.ts');
    expect(mod).toBeDefined();
    expect(mod?.contentHash).toBeUndefined();
  });
});
