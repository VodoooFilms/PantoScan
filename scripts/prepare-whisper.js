#!/usr/bin/env node
'use strict';

/**
 * Prepares the whisper.cpp engine for Panto SRT.
 *
 * - Windows: downloads whisper-bin-Win32.zip from the latest GitHub release
 *   and extracts whisper-cli.exe into build/whisper/.
 * - macOS: prefers a static source build (self-contained, only Apple system
 *   frameworks) via CMake. Falls back to the Homebrew `whisper-cpp` binary
 *   with its dylibs bundled into build/whisper/lib and load paths rewritten
 *   to @executable_path, so the engine still works outside the brew prefix.
 *
 * Models are NOT downloaded here; the app downloads them on demand and shows
 * progress in the UI (keeps the install lightweight). Pass --model=<name> to
 * also pre-download a GGML model next to the binary.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WHISPER_DIR = path.join(ROOT, 'build', 'whisper');
const ENGINE_REPO = 'ggml-org/whisper.cpp';
const MODEL_HOST = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const MODELS = {
  tiny: 'ggml-tiny.bin',
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  medium: 'ggml-medium.bin',
  turbo: 'ggml-large-v3-turbo.bin',
  'large-v3': 'ggml-large-v3.bin'
};

const log = (message, ...rest) => process.stdout.write(`  ${message}\n`.padStart(1, ' '), ...rest);
const error = (message) => { process.stderr.write(`✖ ${message}\n`); process.exitCode = 1; };

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'panto-srt' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (cause) { reject(new Error(`Invalid JSON from ${url}`, { cause })); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destination);
    https.get(url, { headers: { 'User-Agent': 'panto-srt' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        writer.destroy();
        if (redirects >= 5) return reject(new Error('Demasiadas redirecciones.'));
        return downloadFile(new URL(res.headers.location, url).toString(), destination, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        writer.destroy();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(writer);
      writer.on('finish', () => writer.close(resolve));
      writer.on('error', reject);
    }).on('error', reject);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function execCapture(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 30000 }, (err, stdout) => resolve(Boolean(stdout && !err)));
  });
}

async function latestReleaseAsset(pattern) {
  const releases = await httpGetJson(`https://api.github.com/repos/${ENGINE_REPO}/releases?per_page=10`);
  for (const release of releases) {
    const match = release.assets.find((asset) => asset.name === pattern);
    if (match) return match;
  }
  return null;
}

async function prepareWindows() {
  const asset = await latestReleaseAsset('whisper-bin-Win32.zip');
  if (!asset) throw new Error('No se encontró whisper-bin-Win32.zip en los releases de whisper.cpp.');
  const zipPath = path.join(WHISPER_DIR, 'whisper-bin-Win32.zip');
  log(`Descargando ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)…`);
  await downloadFile(asset.browser_download_url, zipPath);
  log('Extrayendo whisper-cli.exe…');
  const extractPath = path.join(WHISPER_DIR, 'win32-tmp');
  fs.mkdirSync(extractPath, { recursive: true });
  const { default: extract } = await import('extract-zip');
  await extract(zipPath, { dir: extractPath });
  const binary = ['whisper-cli.exe', 'whisper.cpp'].map((name) => path.join(extractPath, name)).find((candidate) => fs.existsSync(candidate));
  if (!binary) throw new Error('whisper-cli.exe no está dentro del zip.');
  fs.copyFileSync(binary, path.join(WHISPER_DIR, 'whisper-cli.exe'));
  fs.rmSync(extractPath, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  log('✓ Motor listo: build/whisper/whisper-cli.exe');
}

async function brewBinaryPath() {
  const candidates = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((candidate) => fs.existsSync(candidate));
  if (!brew) return null;
  const ok = await execCapture(brew, ['list', '--versions', 'whisper-cpp']);
  return ok ? candidates.find((candidate) => fs.existsSync(candidate)) || null : null;
}

async function installViaHomebrew() {
  log('Instalando whisper.cpp via Homebrew (whisper-cpp)…');
  const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((candidate) => fs.existsSync(candidate));
  if (!brew) return null;
  await run(brew, ['install', 'whisper-cpp'], { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' } });
  return brewBinaryPath();
}

async function resolveCmake() {
  if (await execCapture('cmake', ['--version'])) return 'cmake';
  const candidates = ['/opt/homebrew/bin/cmake', '/usr/local/bin/cmake', '/opt/local/bin/cmake', '/usr/bin/cmake'];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * Builds whisper-cli from source with static libraries so the binary only
 * depends on Apple's system frameworks (Accelerate, Metal, …) and can be
 * shipped inside the app bundle without extra dylibs.
 */
async function buildFromSource() {
  log('Compilando whisper.cpp desde fuente (binario estático)…');
  const cmake = await resolveCmake();
  if (!cmake) {
    log('cmake no está instalado (brew install cmake).');
    return null;
  }
  const src = path.join(os.tmpdir(), 'whisper-cpp-src');
  fs.rmSync(src, { recursive: true, force: true });
  await run('git', ['clone', '--depth', '1', 'https://github.com/ggml-org/whisper.cpp.git', src]);
  await run(cmake, ['-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF', '-DWHISPER_COREML=OFF'], { cwd: src });
  await run(cmake, ['--build', 'build', '--config', 'Release', '--parallel', String(Math.max(2, Math.floor(os.cpus().length / 2)))], { cwd: src });
  const binary = path.join(src, 'build', 'bin', 'whisper-cli');
  return fs.existsSync(binary) ? binary : null;
}

async function installedInstallNameTool() {
  return (await execCapture('/usr/bin/install_name_tool', ['-help'])) ? '/usr/bin/install_name_tool' : null;
}

function nonSystemDylibs(binary) {
  return new Promise((resolve) => {
    execFile('/usr/bin/otool', ['-L', binary], { timeout: 30000 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const libs = [];
      for (const line of stdout.split('\n').slice(1)) {
        const match = line.match(/^\t(.+?)\s+\(compatibility/);
        if (!match) continue;
        const load = match[1];
        if (/^\/usr\/lib\/|^\/System\/|^\/usr\/Apple\/|^\/Library\/Frameworks\/|^@(rpath|executable_path)\//.test(load)) continue;
        libs.push(load);
      }
      resolve(libs);
    });
  });
}

function resolveDylib(loadName) {
  if (fs.existsSync(loadName)) return loadName;
  const name = path.basename(loadName);
  const roots = [
    '/opt/homebrew/lib', '/usr/local/lib', '/opt/local/lib',
    '/opt/homebrew/opt/whisper-cpp/lib', '/opt/homebrew/opt/ggml/lib',
    '/opt/homebrew/opt/whisper/lib'
  ];
  return roots.map((root) => path.join(root, name)).find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * Copies a Homebrew whisper-cli plus its non-system dylibs into
 * build/whisper/ and rewrites the load paths to @executable_path so the
 * engine also works outside of the brew prefix.
 */
async function bundleBrewBinary(source) {
  log(`Aplicando ajuste de librerías sobre ${path.basename(source)}…`);
  const destBinary = path.join(WHISPER_DIR, 'whisper-cli');
  fs.copyFileSync(source, destBinary);
  fs.chmodSync(destBinary, 0o755);

  const installNameTool = await installedInstallNameTool();
  const libDir = path.join(WHISPER_DIR, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const bundled = new Map();
  const queue = [destBinary];
  const changes = [];

  while (queue.length) {
    const file = queue.pop();
    const libs = await nonSystemDylibs(file);
    for (const loadName of libs) {
      const resolved = resolveDylib(loadName);
      if (!resolved) continue;
      const basename = path.basename(resolved);
      if (!bundled.has(basename)) {
        const destination = path.join(libDir, basename);
        fs.copyFileSync(resolved, destination);
        fs.chmodSync(destination, 0o755);
        bundled.set(basename, destination);
        queue.push(destination);
      }
      const target = `@executable_path/lib/${basename}`;
      if (loadName !== target) changes.push([file, loadName, target]);
    }
  }

  if (!installNameTool) {
    log('⚠ install_name_tool no está disponible; el binario copiado puede no ser portable.');
  } else {
    for (const [file, from, to] of changes) {
      await run(installNameTool, ['-change', from, to, file]);
    }
    if (execCapture('/usr/bin/codesign', ['--help'])) {
      await run('/usr/bin/codesign', ['--force', '--sign', '-', destBinary]);
    }
  }
  return destBinary;
}

async function engineReady() {
  const binary = path.join(WHISPER_DIR, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  if (!fs.existsSync(binary)) return false;
  if (process.platform === 'win32') return true;
  const external = await nonSystemDylibs(binary);
  return external.length === 0;
}

async function prepareMac() {
  if (await engineReady()) {
    log('✓ Motor ya presente (autocontenido): build/whisper/whisper-cli');
    return;
  }
  let engine = await buildFromSource();
  if (!engine) {
    log('Compilación no disponible. Buscando Homebrew…');
    let source = await brewBinaryPath();
    if (!source) source = await installViaHomebrew();
    if (!source) {
      log('whisper-cli no está instalado (brew install whisper-cpp para usar el fallback).');
      throw new Error('No se pudo obtener el binario whisper-cli.');
    }
    engine = await bundleBrewBinary(source);
    log('⚠ Binario empaquetado desde Homebrew. Para una distribución autocontenida ejecuta de nuevo con Xcode Command Line Tools y cmake instalados.');
  } else {
    fs.copyFileSync(engine, path.join(WHISPER_DIR, 'whisper-cli'));
    fs.chmodSync(path.join(WHISPER_DIR, 'whisper-cli'), 0o755);
  }
  log('✓ Motor listo: build/whisper/whisper-cli');
}

async function prepareModel(modelId) {
  const filename = MODELS[modelId];
  if (!filename) throw new Error(`Modelo desconocido: ${modelId}. Usa uno de: ${Object.keys(MODELS).join(', ')}`);
  const destination = path.join(WHISPER_DIR, filename);
  if (fs.existsSync(destination)) {
    log(`✓ Modelo ya presente: ${filename}`);
    return;
  }
  log(`Descargando modelo ${modelId} (${filename})…`);
  await downloadFile(`${MODEL_HOST}/${filename}`, destination);
  log(`✓ Modelo listo: ${filename}`);
}

async function main() {
  const modelArg = process.argv.slice(2).find((arg) => arg.startsWith('--model='));
  const modelId = modelArg ? modelArg.slice('--model='.length) : null;
  fs.mkdirSync(WHISPER_DIR, { recursive: true });
  try {
    if (await engineReady()) {
      log(`✓ Motor ya presente: ${path.basename(path.join(WHISPER_DIR, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'))}`);
    } else if (process.platform === 'win32') {
      await prepareWindows();
    } else {
      await prepareMac();
    }
    if (modelId) await prepareModel(modelId);
  } catch (cause) {
    error(cause.message);
  }
}

main();
