/**
 * Filesystem paths shared by the web-map server and its route modules.
 *
 * Extracted from web-map/server.ts (P1-1 god-file split). This file lives at
 * the same directory depth as server.ts (src/web-map/), so `__dirname` resolves
 * identically and the path expressions are byte-for-byte the originals.
 */

import path from 'path';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

export const DATA_DIR = path.join(__dirname, '..', '..', 'data');
export const SERVERS_DIR = path.join(DATA_DIR, 'servers');
export const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
export const PUBLIC_DIR = path.join(__dirname, 'public');
export const CALIBRATION_FILE = path.join(DATA_DIR, 'map-calibration.json');
