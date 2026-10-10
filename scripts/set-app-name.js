'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NAME = 'PantoScan';
const plist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist');

if (process.platform !== 'darwin' || !fs.existsSync(plist)) process.exit(0);

function read(key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, plist]).toString().trim();
  } catch (_) {
    return '';
  }
}

function write(key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
}

const appBundle = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

try {
  let changed = false;
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    if (read(key) !== NAME) { write(key, NAME); changed = true; }
  }
  if (changed) {
    const now = new Date();
    fs.utimesSync(appBundle, now, now);
    if (fs.existsSync(LSREGISTER)) {
      execFileSync(LSREGISTER, ['-f', appBundle]);
    }
    execFileSync('/usr/bin/killall', ['Dock']);
    console.log(`[set-app-name] nombre del dock -> ${NAME}`);
  }
} catch (error) {
  console.warn('[set-app-name] no se pudo ajustar el nombre:', error.message);
}
