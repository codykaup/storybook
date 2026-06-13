import { createHash } from 'node:crypto';
import { relative } from 'node:path';

// eslint-disable-next-line depend/ban-dependencies
import slash from 'slash';
import type { Plugin } from 'vite';

/**
 * PROTOTYPE — chunk-level TurboSnap signal, for head-to-head comparison with the module-level
 * `contentHash` graph emitted by {@link pluginWebpackStats}.
 *
 * Emits `chunk-graph.json` (the shape from the "chunk-diff" exploration): per-output-chunk content
 * hashes, the cross-chunk import graph, and a per-story set of the chunks it loads. A story
 * re-captures when any chunk in its set changes hash between builds.
 *
 * The entry (preview runtime) chunks are folded into every story's set, mirroring the design's
 * `preview-rt` chunk: a preview/global change moves the entry chunk hash and busts every story.
 *
 * Opt-in via `STORYBOOK_CHUNK_GRAPH=1` so normal builds are unaffected.
 */
type ChunkStatsPluginOptions = {
  workingDir: string;
};

const STORY_FILE = /\.stories\.[cm]?[jt]sx?$/;

export function pluginChunkStats({ workingDir }: ChunkStatsPluginOptions): Plugin {
  const normalize = (id: string) => `./${slash(relative(workingDir, id.split('?')[0]))}`;

  // Hash the shipped chunk code, normalized so the hash reflects *content* not *routing*:
  //  - drop the environment-specific sourcemap reference, and
  //  - neutralize hashed sibling-chunk filenames (`name-A1b2C3d4.js`). Without this, a leaf chunk's
  //    new hash rewrites every importer's filename references and cascades through the runtime
  //    chunk to every story (massive over-capture). This is the "normalize before hashing" the
  //    chunk-diff design calls for.
  const hashChunk = (code: string) =>
    createHash('sha256')
      .update(
        code
          .replace(/\n?\/\/# sourceMappingURL=.*$/gm, '')
          .replace(/-[\w-]{8}\.(js|css)/g, '-[hash].$1')
      )
      .digest('hex')
      .slice(0, 16);

  return {
    name: 'storybook:chunk-graph-stats',
    enforce: 'post',
    generateBundle(_options, bundle) {
      if (!process.env.STORYBOOK_CHUNK_GRAPH) {
        return;
      }

      // Output filenames embed a content hash, so they churn on every change. Key each chunk by a
      // stable identity (the hash of its module-id set) and carry the content hash separately, so a
      // build-to-build diff can tell "same chunk, new content" apart from re-chunking.
      const chunkKey = (moduleIds: string[]) =>
        createHash('sha256').update(moduleIds.slice().sort().join('\n')).digest('hex').slice(0, 16);

      const fileNameToKey = new Map<string, string>();
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') {
          fileNameToKey.set(file.fileName, chunkKey(Object.keys(file.modules)));
        }
      }

      const chunks: Record<
        string,
        { fileName: string; hash: string; imports: string[]; dynamicImports: string[] }
      > = {};
      const moduleToChunk = new Map<string, string>();
      const entryChunks: string[] = [];

      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') {
          continue;
        }
        const key = fileNameToKey.get(file.fileName)!;
        chunks[key] = {
          fileName: file.fileName,
          hash: hashChunk(file.code),
          imports: file.imports.map((f) => fileNameToKey.get(f)!).filter(Boolean),
          dynamicImports: file.dynamicImports.map((f) => fileNameToKey.get(f)!).filter(Boolean),
        };
        if (file.isEntry) {
          entryChunks.push(key);
        }
        for (const moduleId of Object.keys(file.modules)) {
          moduleToChunk.set(moduleId, key);
        }
      }

      // Transitive closure over static chunk imports (the chunks loaded synchronously with `start`).
      const reachable = (starts: string[]) => {
        const seen = new Set<string>();
        const stack = [...starts];
        while (stack.length > 0) {
          const chunk = stack.pop()!;
          if (!chunk || seen.has(chunk)) {
            continue;
          }
          seen.add(chunk);
          stack.push(...(chunks[chunk]?.imports ?? []));
        }
        return seen;
      };

      // Preview runtime / global section: every story loads the entry chunk graph.
      const sharedChunks = reachable(entryChunks);

      const stories: Record<string, { chunks: string[] }> = {};
      for (const [moduleId, chunkName] of moduleToChunk) {
        const bare = moduleId.split('?')[0];
        if (!STORY_FILE.test(bare) || bare.includes('node_modules')) {
          continue;
        }
        const set = reachable([chunkName]);
        for (const shared of sharedChunks) {
          set.add(shared);
        }
        stories[normalize(moduleId)] = { chunks: [...set].sort() };
      }

      this.emitFile({
        type: 'asset',
        fileName: 'chunk-graph.json',
        source: JSON.stringify({ stories, chunks }, null, 2),
      });
    },
  };
}
