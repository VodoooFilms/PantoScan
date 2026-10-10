'use strict';

const path = require('path');
const { Store } = require('./main/lib/store');
const { createLibrary } = require('./main/lib/library');
const { createQueue } = require('./main/lib/queue');
const { createPipeline } = require('./main/lib/pipeline');
const { buildProject, writeProject } = require('./main/lib/project');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i += 1; } else { args[key] = true; }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function openContext(args) {
  const dbPath = typeof args.db === 'string' ? args.db : path.join(process.cwd(), 'work', 'library.db');
  const store = new Store(dbPath);
  return { store, library: createLibrary(store), queue: createQueue(store), dbPath };
}

function human(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function commandScan(args) {
  const target = args._[1];
  if (!target) { console.error('uso: scan <carpeta>'); process.exit(1); }
  const { store, library, queue } = openContext(args);
  const source = library.addSource(target);
  console.log(`fuente: ${source.name}  [${source.volumeName || 'volumen?'}]  ${source.relPath}`);
  const result = library.scanSource(source.id, {
    onProgress: ({ index, file }) => process.stdout.write(`\r  escaneando… ${index} (${file.slice(0, 40)})`)
  });
  process.stdout.write('\r                            \r');
  console.log(`  online=${result.online}  encontrados=${result.total}  nuevos=${result.added}  actualizados=${result.updated}  eliminados=${result.removed}`);
  if (args.enqueue) {
    const ids = library.listClips({ sourceId: source.id }).map((clip) => clip.id);
    const n = queue.enqueue(ids);
    console.log(`  en cola: ${n}`);
  }
  console.log(`  resumen biblioteca: ${JSON.stringify(library.summary())}`);
  store.close();
}

function commandSources(args) {
  const { store, library } = openContext(args);
  for (const source of library.listSources()) {
    console.log(`${source.online ? '●' : '○'} ${source.name}  [${source.volumeName || '—'}]  ${source.relPath}`);
  }
  store.close();
}

function commandClips(args) {
  const { store, library } = openContext(args);
  const sourceId = asString(args.source);
  const filter = sourceId ? { sourceId } : {};
  for (const clip of library.listClips(filter)) {
    console.log(`${clip.online ? '●' : '○'} ${human(clip.size).padStart(8)}  ${clip.mediaType.padEnd(5)}  ${clip.relPath}`);
  }
  store.close();
}

function commandEnqueue(args) {
  const { store, library, queue } = openContext(args);
  const sourceId = asString(args.source);
  const filter = sourceId ? { sourceId } : {};
  const ids = library.listClips(filter).map((clip) => clip.id);
  const n = queue.enqueue(ids, { force: Boolean(args.force) });
  console.log(`en cola: ${n} de ${ids.length}`);
  store.close();
}

function commandStatus(args) {
  const { store, library, queue } = openContext(args);
  console.log(`biblioteca: ${JSON.stringify(library.summary())}`);
  console.log(`cola: ${JSON.stringify(queue.stats())}`);
  store.close();
}

async function commandRun(args) {
  const { store, library, queue } = openContext(args);
  const outRoot = asString(args.out) || path.join(process.cwd(), 'out');
  const sourceId = asString(args.source);
  const filter = sourceId ? { sourceId } : {};
  const ids = library.listClips(filter)
    .filter((clip) => (args.online ? clip.online : true))
    .map((clip) => clip.id);
  const enqueued = queue.enqueue(ids, { force: Boolean(args.force) });
  console.log(`en cola: ${enqueued} (de ${ids.length} clips)  salida: ${outRoot}`);
  const pipeline = createPipeline({
    store, queue, library, outRoot,
    logger: (message) => console.log(message)
  });
  const processed = await pipeline.drain({
    force: Boolean(args.force),
    onDrained: (item) => console.log(item.ok ? `  OK  ${item.outDir}` : `  ERR ${item.clipId}: ${item.error}`)
  });
  const ok = processed.filter((item) => item.ok).length;
  console.log(`listo: ${ok}/${processed.length} ok  ·  ${JSON.stringify(queue.stats())}`);
  store.close();
}

async function commandResults(args) {
  const { store } = openContext(args);
  for (const row of store.listResults()) {
    console.log(`${row.clip_name}  →  ${row.guide_path}`);
    if (row.summary) console.log(`   ${row.summary}`);
  }
  store.close();
}

function commandGuide(args) {
  const { store } = openContext(args);
  const outRoot = asString(args.out) || path.join(process.cwd(), 'out');
  const bundle = buildProject(store);
  const written = writeProject(outRoot, bundle);
  console.log(`guía de proyecto: ${written['project-guide.md']}`);
  console.log(`  html: ${written['project-guide.html']}`);
  console.log(`  selects: ${written['selects.csv']}`);
  console.log(`  ${JSON.stringify(bundle.stats)}`);
  store.close();
}

function commandSearch(args) {
  const { store } = openContext(args);
  const query = asString(args.q) || args._.slice(1).join(' ');
  if (!query) { console.error('uso: search "términos"  (o --q "términos")'); process.exit(1); }
  const rows = store.search(query, args.limit ? Number(args.limit) : 50);
  for (const row of rows) {
    console.log(`${row.section.padEnd(7)} ${row.clip_name}  ${(row.start || 0).toFixed(1)}s  ${row.label || ''}  ${(row.text || '').replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  console.log(`  ${rows.length} coincidencias`);
  store.close();
}

const COMMANDS = {
  scan: commandScan,
  sources: commandSources,
  clips: commandClips,
  enqueue: commandEnqueue,
  status: commandStatus,
  run: commandRun,
  results: commandResults,
  guide: commandGuide,
  search: commandSearch
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === 'help') {
    console.log('comandos: scan <carpeta> [--enqueue] | sources | clips [--source id] | enqueue [--force] | status | run [--force] | results | guide [--out dir] | search "texto"');
    return;
  }
  const handler = COMMANDS[command];
  if (!handler) { console.error(`comando desconocido: ${command}`); process.exit(1); }
  handler(args);
}

main();
