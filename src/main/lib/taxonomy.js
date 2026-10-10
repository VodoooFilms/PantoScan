'use strict';

const fs = require('fs');

const DEFAULT_TAXONOMY = {
  topics: [
    'origen y comienzos',
    'proceso creativo',
    'identidad y territorio',
    'conflicto interno',
    'relaciones y colaboración',
    'pérdida y duelo',
    'logro y reconocimiento',
    'contexto social y político',
    'técnica y oficio',
    'gira y escenario',
    'futuro y sueños'
  ],
  emotions: [
    'alegría', 'euforia', 'calma', 'nostalgia', 'melancolía',
    'tensión', 'rabia', 'miedo', 'esperanza', 'ternura', 'orgullo'
  ],
  roles: [
    'gancho', 'contexto', 'conflicto', 'giro', 'insight',
    'resolución', 'cierre', 'ambiente', 'música'
  ],
  rushes: [
    'declaración', 'anédota', 'descripción', 'reflexión', 'acción', 'paisaje', 'material de archivo'
  ]
};

const ROLE_COLORS = {
  gancho: '#e74c3c',
  conflicto: '#c0392b',
  giro: '#e67e22',
  insight: '#9b59b6',
  resolución: '#27ae60',
  cierre: '#16a085',
  contexto: '#3498db',
  ambiente: '#95a5a6',
  'música': '#8e44ad'
};

const EMOTION_COLORS = {
  tensión: '#c0392b',
  rabia: '#e74c3c',
  miedo: '#8e44ad',
  melancolía: '#34495e',
  nostalgia: '#7f8c8d',
  alegría: '#f1c40f',
  euforia: '#e67e22',
  calma: '#1abc9c',
  esperanza: '#2ecc71',
  ternura: '#ff7675',
  orgullo: '#d35400'
};

function loadTaxonomy(filePath) {
  if (!filePath) return { ...DEFAULT_TAXONOMY };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { ...DEFAULT_TAXONOMY, ...raw };
  } catch (_) {
    return { ...DEFAULT_TAXONOMY };
  }
}

module.exports = { DEFAULT_TAXONOMY, ROLE_COLORS, EMOTION_COLORS, loadTaxonomy };
