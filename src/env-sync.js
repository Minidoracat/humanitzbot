/**
 * Smart .env synchronization utility
 * 
 * Keeps .env in sync with .env.example without losing user data:
 * - Adds new keys from .env.example with their default values
 * - Preserves all existing user-configured values
 * - Comments out deprecated keys (in .env but not in .example)
 * - Maintains section comments and organization
 * - Tracks schema version to detect when updates are needed
 * 
 * Usage:
 *   const { syncEnv, needsSync } = require('./env-sync');
 *   if (needsSync()) {
 *     const changes = syncEnv();
 *     console.log(`Updated .env: ${changes.added} added, ${changes.deprecated} deprecated`);
 *   }
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const EXAMPLE_PATH = path.join(__dirname, '..', '.env.example');
const ENV_VERSION_KEY = 'ENV_SCHEMA_VERSION';

/**
 * Parse .env file into structured data
 * @returns {{ version: string|null, entries: Map<key, { value, comment, line }>, raw: string }}
 */
function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return { version: null, entries: new Map(), raw: '' };
  
  const raw = fs.readFileSync(filePath, 'utf8');
  const entries = new Map();
  let version = null;
  
  const lines = raw.split('\n');
  let currentComment = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Capture comments
    if (line.startsWith('#')) {
      currentComment.push(line);
      continue;
    }
    
    // Parse key=value
    const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      entries.set(key, {
        value: value.trim(),
        comment: currentComment.join('\n'),
        line: i + 1,
      });
      
      if (key === ENV_VERSION_KEY) {
        version = value.trim();
      }
      
      currentComment = [];
    }
  }
  
  return { version, entries, raw };
}

/**
 * Extract section headers from .env.example
 * Returns array of { title, startKey, endKey }
 */
function extractSections(examplePath) {
  const content = fs.readFileSync(examplePath, 'utf8');
  const sections = [];
  let currentSection = null;
  let lastKey = null;
  
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    
    // Section header: # ── Section Name ──────...
    if (/^#\s*──\s*(.+?)\s*──+/.test(trimmed)) {
      if (currentSection) {
        currentSection.endKey = lastKey;
        sections.push(currentSection);
      }
      currentSection = {
        title: trimmed,
        startKey: null,
        keys: [],
      };
    }
    
    // Key=value
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (match) {
      const key = match[1];
      lastKey = key;
      if (currentSection) {
        if (!currentSection.startKey) currentSection.startKey = key;
        currentSection.keys.push(key);
      }
    }
  }
  
  if (currentSection) {
    currentSection.endKey = lastKey;
    sections.push(currentSection);
  }
  
  return sections;
}

/**
 * Check if .env needs sync with .env.example
 * @returns {boolean}
 */
function needsSync() {
  if (!fs.existsSync(ENV_PATH)) return true;
  if (!fs.existsSync(EXAMPLE_PATH)) return false;
  
  const env = parseEnv(ENV_PATH);
  const example = parseEnv(EXAMPLE_PATH);
  
  // Check version mismatch
  if (env.version !== example.version) return true;
  
  // Check for missing keys
  for (const key of example.entries.keys()) {
    if (!env.entries.has(key)) return true;
  }
  
  return false;
}

/**
 * Sync .env with .env.example, preserving user values
 * @returns {{ added: number, deprecated: number, updated: number }}
 */
function syncEnv() {
  if (!fs.existsSync(EXAMPLE_PATH)) {
    throw new Error('.env.example not found');
  }
  
  const env = parseEnv(ENV_PATH);
  const example = parseEnv(EXAMPLE_PATH);
  const sections = extractSections(EXAMPLE_PATH);
  
  const result = { added: 0, deprecated: 0, updated: 0 };
  const output = [];
  
  // Process each section from .env.example
  for (const section of sections) {
    output.push(section.title);
    output.push('');
    
    for (const key of section.keys) {
      const exampleEntry = example.entries.get(key);
      const envEntry = env.entries.get(key);
      
      // Add comment block from example
      if (exampleEntry.comment) {
        output.push(exampleEntry.comment);
      }
      
      if (envEntry) {
        // Preserve existing value
        output.push(`${key}=${envEntry.value}`);
      } else {
        // Add new key with example value
        output.push(`${key}=${exampleEntry.value}`);
        result.added++;
      }
      
      output.push('');
    }
  }
  
  // Handle deprecated keys (in .env but not in .example)
  const deprecatedKeys = [];
  for (const key of env.entries.keys()) {
    if (!example.entries.has(key) && key !== ENV_VERSION_KEY) {
      deprecatedKeys.push(key);
    }
  }
  
  if (deprecatedKeys.length > 0) {
    output.push('# ── Deprecated Keys (no longer used) ──────────────────────────');
    output.push('# These keys are from an older version and can be safely removed.');
    output.push('');
    
    for (const key of deprecatedKeys) {
      const entry = env.entries.get(key);
      output.push(`# ${key}=${entry.value}`);
      result.deprecated++;
    }
    output.push('');
  }
  
  // Write updated .env
  const newContent = output.join('\n');
  
  // Backup old .env
  if (fs.existsSync(ENV_PATH)) {
    const backup = `${ENV_PATH}.backup.${Date.now()}`;
    fs.copyFileSync(ENV_PATH, backup);
    console.log(`[ENV-SYNC] Backed up old .env to: ${path.basename(backup)}`);
  }
  
  fs.writeFileSync(ENV_PATH, newContent, 'utf8');
  
  return result;
}

/**
 * Get current .env schema version
 */
function getVersion() {
  const env = parseEnv(ENV_PATH);
  return env.version || '0';
}

/**
 * Get .env.example schema version
 */
function getExampleVersion() {
  const example = parseEnv(EXAMPLE_PATH);
  return example.version || '0';
}

module.exports = {
  needsSync,
  syncEnv,
  getVersion,
  getExampleVersion,
  parseEnv,
};
