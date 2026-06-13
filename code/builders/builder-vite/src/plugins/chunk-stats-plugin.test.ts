import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pluginChunkStats } from './chunk-stats-plugin.ts';

const workingDir = '/project';

interface FakeChunk {
  type: 'chunk';
  fileName: string;
  code: string;
  imports?: string[];
  dynamicImports?: string[];
  isEntry?: boolean;
  modules: Record<string, unknown>;
}

/** Runs the plugin's `generateBundle` against a fake Rollup output bundle and returns the emitted graph. */
function runPlugin(bundle: Record<string, FakeChunk>) {
  const plugin = pluginChunkStats({ workingDir });
  let emitted: any;
  const context = { emitFile: (file: any) => (emitted = file) };
  (plugin as any).generateBundle.call(context, {}, bundle);
  return emitted ? JSON.parse(emitted.source) : undefined;
}

const chunk = (fileName: string, code: string, extra: Partial<FakeChunk> = {}): FakeChunk => ({
  type: 'chunk',
  fileName,
  code,
  imports: [],
  dynamicImports: [],
  modules: {},
  ...extra,
});

describe('pluginChunkStats (prototype)', () => {
  beforeEach(() => {
    process.env.STORYBOOK_CHUNK_GRAPH = '1';
  });
  afterEach(() => {
    delete process.env.STORYBOOK_CHUNK_GRAPH;
  });

  it('emits nothing unless STORYBOOK_CHUNK_GRAPH is set', () => {
    delete process.env.STORYBOOK_CHUNK_GRAPH;
    const graph = runPlugin({
      'story.js': chunk('story.js', 'a', { modules: { '/project/src/Button.stories.tsx': {} } }),
    });
    expect(graph).toBeUndefined();
  });

  // Chunks are keyed by a stable module-set identity, so resolve a story's chunk keys to filenames.
  const fileNames = (graph: any, story: string) =>
    graph.stories[story].chunks.map((key: string) => graph.chunks[key].fileName).sort();

  it('maps each story to its chunk plus the chunks it statically imports', () => {
    const graph = runPlugin({
      'story.js': chunk('story.js', 'story', {
        imports: ['vendor.js'],
        modules: { '/project/src/Button.stories.tsx': {} },
      }),
      'vendor.js': chunk('vendor.js', 'vendor', {
        modules: { '/project/node_modules/react/index.js': {} },
      }),
    });
    expect(fileNames(graph, './src/Button.stories.tsx')).toEqual(['story.js', 'vendor.js']);
    expect(Object.values(graph.chunks).every((c: any) => typeof c.hash === 'string')).toBe(true);
  });

  it('folds entry (preview runtime) chunks into every story so a preview change busts all', () => {
    const graph = runPlugin({
      'iframe.js': chunk('iframe.js', 'preview-runtime', {
        isEntry: true,
        imports: ['preview-deps.js'],
        modules: { '/project/.storybook/preview.ts': {} },
      }),
      'preview-deps.js': chunk('preview-deps.js', 'deps', {}),
      'a.js': chunk('a.js', 'a', { modules: { '/project/src/A.stories.tsx': {} } }),
      'b.js': chunk('b.js', 'b', { modules: { '/project/src/B.stories.tsx': {} } }),
    });
    for (const story of ['./src/A.stories.tsx', './src/B.stories.tsx']) {
      expect(fileNames(graph, story)).toContain('iframe.js');
      expect(fileNames(graph, story)).toContain('preview-deps.js');
    }
  });

  it('hashes chunk content and ignores sourcemap references', () => {
    const a = runPlugin({
      's.js': chunk('s.js', 'code', { modules: { '/project/s.stories.ts': {} } }),
    });
    const b = runPlugin({
      's.js': chunk('s.js', 'code\n//# sourceMappingURL=s.js.map', {
        modules: { '/project/s.stories.ts': {} },
      }),
    });
    const hashes = (g: any) => Object.values(g.chunks).map((c: any) => c.hash);
    expect(hashes(a)).toEqual(hashes(b));
  });
});
