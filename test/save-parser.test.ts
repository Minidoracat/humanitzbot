/**
 * Tests for save-parser.js — GVAS binary reader and save file parsing.
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _save_parser from '../src/parsers/save-parser.js';
const { parseSave, parseClanData, PERK_MAP, CLAN_RANK_MAP } = _save_parser as any;

import * as _gvas_reader from '../src/parsers/gvas-reader.js';
const { createReader, readProperty } = _gvas_reader as any;

// ── Helper: build a minimal GVAS buffer ──

function buildGvasHeader(): Buffer {
  const parts: Buffer[] = [];
  // Magic
  parts.push(Buffer.from('GVAS'));
  // Save version + package version
  parts.push(Buffer.alloc(8, 0));
  // Engine version (major U16, minor U16, patch U16)
  parts.push(Buffer.alloc(6, 0));
  // Build U32
  parts.push(Buffer.alloc(4, 0));
  // Branch FString (empty string — length = 1, then null byte)
  const branchLen = Buffer.alloc(4);
  branchLen.writeInt32LE(1);
  parts.push(branchLen);
  parts.push(Buffer.from('\0'));
  // Custom version format U32 + count U32 (0 custom versions)
  parts.push(Buffer.alloc(8, 0));
  // Save class FString (empty — length = 1, null)
  parts.push(branchLen);
  parts.push(Buffer.from('\0'));
  return Buffer.concat(parts);
}

function writeFString(str: string): Buffer {
  if (str === '') {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(0);
    return buf;
  }
  const encoded = Buffer.from(str + '\0', 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32LE(encoded.length);
  return Buffer.concat([lenBuf, encoded]);
}

// ── Constants ──

describe('PERK_MAP', () => {
  it('has 12 profession entries', () => {
    assert.equal(Object.keys(PERK_MAP).length, 12);
  });

  it('maps known enum values', () => {
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator0'], 'Unemployed');
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator14'], 'Military Veteran');
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator17'], 'Electrical Engineer');
  });

  it('returns undefined for unknown enumerators', () => {
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator99'], undefined);
  });
});

describe('CLAN_RANK_MAP', () => {
  it('has 5 rank entries', () => {
    assert.equal(Object.keys(CLAN_RANK_MAP).length, 5);
  });

  it('maps all ranks correctly', () => {
    assert.equal(CLAN_RANK_MAP['E_ClanRank::NewEnumerator0'], 'Recruit');
    assert.equal(CLAN_RANK_MAP['E_ClanRank::NewEnumerator4'], 'Leader');
  });
});

// ── parseSave ──

describe('parseSave', () => {
  it('throws on non-GVAS input', () => {
    assert.throws(() => parseSave(Buffer.from('NOT_GVAS_DATA')), /Not a GVAS save file/);
  });

  it('throws on empty buffer', () => {
    assert.throws(() => parseSave(Buffer.alloc(0)));
  });

  it('returns a Map for a valid but empty save (header only + no properties)', () => {
    const header = buildGvasHeader();
    // Add a "None" property terminator (FString "None" + type "None")
    const noneStr = writeFString('None');
    const buf = Buffer.concat([header, noneStr]);
    const result = parseSave(buf);
    assert.ok(result.players instanceof Map);
  });
});

// ── parseClanData ──

describe('parseClanData', () => {
  it('returns an array for a valid but empty save', () => {
    const header = buildGvasHeader();
    const noneStr = writeFString('None');
    const buf = Buffer.concat([header, noneStr]);
    const result = parseClanData(buf);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('throws on non-GVAS input', () => {
    assert.throws(() => parseClanData(Buffer.from('NOT_GVAS_DATA')), /Not a GVAS save file/);
  });
});

// ── readProperty: Transform with sub-properties ──

function writeU8(val: number): Buffer {
  const b = Buffer.alloc(1);
  b[0] = val;
  return b;
}
function writeI64(val: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeInt32LE(val, 0);
  b.writeInt32LE(0, 4);
  return b;
}
function writeF32(val: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(val);
  return b;
}

function buildStructProperty(name: string, structType: string, contentParts: Buffer[]): Buffer {
  const content = Buffer.concat(contentParts);
  return Buffer.concat([
    writeFString(name),
    writeFString('StructProperty'),
    writeI64(content.length),
    writeFString(structType),
    Buffer.alloc(16), // GUID
    writeU8(0), // flag
    content,
  ]);
}

function buildVectorStruct(name: string, x: number, y: number, z: number): Buffer {
  return buildStructProperty(name, 'Vector', [writeF32(x), writeF32(y), writeF32(z)]);
}

function buildQuatStruct(name: string, x: number, y: number, z: number, w: number): Buffer {
  return buildStructProperty(name, 'Quat', [writeF32(x), writeF32(y), writeF32(z), writeF32(w)]);
}

function buildTransformStruct(
  name: string,
  tx: number,
  ty: number,
  tz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): Buffer {
  const translationProp = buildVectorStruct('Translation', tx, ty, tz);
  const rotationProp = buildQuatStruct('Rotation', qx, qy, qz, qw);
  const noneTerm = writeFString('None');
  return buildStructProperty(name, 'Transform', [translationProp, rotationProp, noneTerm]);
}

describe('readProperty — Transform', () => {
  it('captures Translation and Rotation sub-properties', () => {
    const data = buildTransformStruct('ActorTransform', 100.5, -200.25, 50.0, 0, 0, 0.7071, 0.7071);
    const r = createReader(data);
    const prop = readProperty(r);

    assert.ok(prop);
    assert.equal(prop.name, 'ActorTransform');
    assert.equal(prop.type, 'StructProperty');
    assert.equal(prop.structType, 'Transform');

    // Translation should be captured
    assert.ok(prop.value.translation);
    assert.ok(Math.abs(prop.value.translation.x - 100.5) < 0.01);
    assert.ok(Math.abs(prop.value.translation.y - -200.25) < 0.01);
    assert.ok(Math.abs(prop.value.translation.z - 50.0) < 0.01);

    // Rotation should be captured
    assert.ok(prop.value.rotation);
    assert.ok(Math.abs(prop.value.rotation.z - 0.7071) < 0.01);
    assert.ok(Math.abs(prop.value.rotation.w - 0.7071) < 0.01);
  });

  it('children array includes sub-properties', () => {
    const data = buildTransformStruct('PlayerTransform', 1000, -2000, 300, 0, 0, 0, 1);
    const r = createReader(data);
    const prop = readProperty(r);

    assert.ok(Array.isArray(prop.children));
    const names = prop.children.map((c: { name: string }) => c.name);
    assert.ok(names.includes('Translation'));
    assert.ok(names.includes('Rotation'));
  });
});

// ── parseSave: coordinate extraction into player data ──

function buildStrProperty(name: string, value: string): Buffer {
  const valBuf = writeFString(value);
  return Buffer.concat([
    writeFString(name),
    writeFString('StrProperty'),
    writeI64(valBuf.length),
    writeU8(0), // flag
    valBuf,
  ]);
}

describe('parseSave — player coordinates', () => {
  it('extracts position from Transform after SteamID', () => {
    const header = buildGvasHeader();
    const steamIdProp = buildStrProperty('SteamID', '76561198000000001');
    const transformProp = buildTransformStruct('SavedTransform', 37377.63, -292189.0, 5014.04, 0, 0, -0.5, 0.866);
    const noneTerm = writeFString('None');

    const buf = Buffer.concat([header, steamIdProp, transformProp, noneTerm]);
    const { players } = parseSave(buf);

    assert.equal(players.size, 1);
    const p = players.get('76561198000000001');
    assert.ok(p);
    assert.ok(Math.abs(p.x - 37377.63) < 0.1);
    assert.ok(Math.abs(p.y - -292189.0) < 1);
    assert.ok(Math.abs(p.z - 5014.04) < 0.1);
    assert.ok(typeof p.rotationYaw === 'number');
  });

  it('defaults to null coordinates when no Transform present', () => {
    const header = buildGvasHeader();
    const steamIdProp = buildStrProperty('SteamID', '76561198000000001');
    const noneTerm = writeFString('None');

    const buf = Buffer.concat([header, steamIdProp, noneTerm]);
    const { players } = parseSave(buf);

    const p = players.get('76561198000000001');
    assert.ok(p);
    assert.equal(p.x, null);
    assert.equal(p.y, null);
    assert.equal(p.z, null);
    assert.equal(p.rotationYaw, null);
  });
});

// ── parseSave: per-player tamed horses (agent v5 structured extraction) ──
//
// A per-player .sav goes through the same parseSave() entry the remote agent
// bundles (_parsePlayerSaveFile), so this synthetic fixture covers the full
// binary path: GVAS → ArrayProperty(StructProperty) → _extractHorses.

function writeI32(val: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(val);
  return b;
}

/** GVAS UTF-16LE FString (negative length) — used for player-given CJK names. */
function writeFStringUtf16(str: string): Buffer {
  const chars = str.length + 1; // + null terminator
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32LE(-chars);
  return Buffer.concat([lenBuf, Buffer.from(str + '\0', 'utf16le')]);
}

function buildStrPropertyUtf16(name: string, value: string): Buffer {
  const valBuf = writeFStringUtf16(value);
  return Buffer.concat([writeFString(name), writeFString('StrProperty'), writeI64(valBuf.length), writeU8(0), valBuf]);
}

function buildObjectProperty(name: string, value: string): Buffer {
  const valBuf = writeFString(value);
  return Buffer.concat([
    writeFString(name),
    writeFString('ObjectProperty'),
    writeI64(valBuf.length),
    writeU8(0),
    valBuf,
  ]);
}

function buildFloatProperty(name: string, value: number): Buffer {
  return Buffer.concat([writeFString(name), writeFString('FloatProperty'), writeI64(4), writeU8(0), writeF32(value)]);
}

function buildIntProperty(name: string, value: number): Buffer {
  return Buffer.concat([writeFString(name), writeFString('IntProperty'), writeI64(4), writeU8(0), writeI32(value)]);
}

function buildSoftObjectProperty(name: string, assetPath: string): Buffer {
  // FSoftObjectPath payload: assetPath FString + empty subPath FString
  const payload = Buffer.concat([writeFString(assetPath), writeFString('')]);
  return Buffer.concat([
    writeFString(name),
    writeFString('SoftObjectProperty'),
    writeI64(payload.length),
    writeU8(0),
    payload,
  ]);
}

/** ArrayProperty(StructProperty) with property-list elements (generic path). */
function buildStructArrayProperty(name: string, structType: string, elements: Buffer[][]): Buffer {
  const noneTerm = writeFString('None');
  const body = Buffer.concat(elements.map((parts) => Buffer.concat([...parts, noneTerm])));
  const payload = Buffer.concat([
    writeI32(elements.length),
    writeFString(name), // arrName
    writeFString('StructProperty'), // arrType
    writeI64(body.length), // arrSize
    writeFString(structType),
    Buffer.alloc(16), // GUID
    writeU8(0),
    body,
  ]);
  return Buffer.concat([
    writeFString(name),
    writeFString('ArrayProperty'),
    writeI64(payload.length),
    writeFString('StructProperty'), // innerType
    writeU8(0),
    payload,
  ]);
}

describe('parseSave — per-player tamed horses', () => {
  const HORSE_CLASS = '/Game/TSS_Game/KaiWorldEffects/Horse/BP_Horse_Child3.BP_Horse_Child3_C';

  function buildPlayerSaveWithHorses(): Buffer {
    const tamedHorse = [
      buildObjectProperty('Class', 'None'),
      buildSoftObjectProperty('SoftClass', HORSE_CLASS),
      buildTransformStruct('Transform', 70235.7, -356085.3, 5685.5, 0, 0, -0.62, 0.79),
      buildFloatProperty('Health', 800),
      buildFloatProperty('Energy', 90.5),
      buildFloatProperty('Stamina', 1),
      buildStrProperty('Owner', '76561197962470657_+_|0002320d6d3a4a4ebec27796d1e72f2e'),
      buildIntProperty('Saddle', 4),
      buildStrPropertyUtf16('HorseName', '殺戮戰神'),
    ];
    const unnamedHorse = [
      buildObjectProperty('Class', 'None'),
      buildSoftObjectProperty('SoftClass', HORSE_CLASS),
      buildFloatProperty('Health', 500),
    ];
    return Buffer.concat([
      buildGvasHeader(),
      buildStrProperty('SteamID', 'P_76561197962470657'),
      buildStructArrayProperty('Horses', 'S_HorseSaveData', [tamedHorse, unnamedHorse]),
      // Trailing property proves the array left the stream aligned
      buildIntProperty('DayzSurvived', 42),
      writeFString('None'),
    ]);
  }

  it('extracts structured horses with a UTF-16 player-given name', () => {
    const { players } = parseSave(buildPlayerSaveWithHorses());
    const p = players.get('76561197962470657');
    assert.ok(p);
    assert.equal(p.horses.length, 2);

    const h = p.horses[0];
    assert.ok(h && !Array.isArray(h), 'horses must be structured objects, not raw GVAS arrays');
    assert.equal(h.name, '殺戮戰神');
    assert.equal(h.health, 800);
    assert.ok(Math.abs(h.energy - 90.5) < 0.01);
    assert.equal(h.stamina, 1);
    assert.equal(h.saddle, 4);
    assert.equal(h.ownerSteamId, '76561197962470657');
    assert.equal(h.class, HORSE_CLASS, 'SoftClass should backfill class when Class is None');
    assert.ok(h.displayName.length > 0);
    assert.ok(Math.abs(h.x - 70235.7) < 0.1);
    assert.ok(Math.abs(h.y - -356085.3) < 0.5);
  });

  it('keeps unnamed horses with empty name and parses the trailing property', () => {
    const { players } = parseSave(buildPlayerSaveWithHorses());
    const p = players.get('76561197962470657');
    assert.ok(p);

    const h2 = p.horses[1];
    assert.ok(h2 && !Array.isArray(h2));
    assert.equal(h2.name, '');
    assert.equal(h2.health, 500);
    assert.equal(h2.x, null);

    // Stream alignment: the property after the Horses array still parses
    assert.equal(p.daysSurvived, 42);
  });
});
