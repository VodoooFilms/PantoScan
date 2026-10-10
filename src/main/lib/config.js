'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'analicedocumental');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  llmEndpoint: null,
  llmCandidates: ['http://127.0.0.1:8081/v1', 'http://127.0.0.1:8080/v1'],
  llmModel: null,
  asrModel: null,
  ffmpegPath: null,
  whisperPath: null
};

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function saveConfig(partial) {
  const next = { ...loadConfig(), ...partial };
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { loadConfig, saveConfig, CONFIG_DIR, CONFIG_PATH, DEFAULTS };
