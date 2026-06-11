/**
 * Tests for gvas-reader.ts — SoftObjectProperty payload handling and
 * MapProperty capture (Params / Stats / Time), added for the 2026-06 save
 * audit fixes. Uses small synthetic GVAS property buffers.
 * Run: npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _gvas_reader from '../src/parsers/gvas-reader.js';
const { createReader, readProperty, MAP_CAPTURE } = _gvas_reader as any;

// ── Binary helpers ──────────────────────────────────────────────────────────

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

function writeI32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(n);
  return buf;
}

function writeI64(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(n);
  return buf;
}

function writeF32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(n);
  return buf;
}

const SEP = Buffer.from([0]);

/** UE4 FSoftObjectPath payload: assetPath FString + subPath FString (empty). */
function softObjectPayload(assetPath: string, subPath = ''): Buffer {
  return Buffer.concat([writeFString(assetPath), writeFString(subPath)]);
}

/** name + SoftObjectProperty + dataSize + sep + payload */
function softObjectProp(name: string, assetPath: string): Buffer {
  const payload = softObjectPayload(assetPath);
  return Buffer.concat([
    writeFString(name),
    writeFString('SoftObjectProperty'),
    writeI64(BigInt(payload.length)),
    SEP,
    payload,
  ]);
}

/** Trailing IntProperty used to prove the stream stays aligned. */
function intProp(name: string, value: number): Buffer {
  return Buffer.concat([writeFString(name), writeFString('IntProperty'), writeI64(4n), SEP, writeI32(value)]);
}

// ── SoftObjectProperty ──────────────────────────────────────────────────────

describe('readProperty — SoftObjectProperty', () => {
  it('reads assetPath and consumes the full payload (incl. empty subPath)', () => {
    const asset = '/Game/TSS_Game/Vehicles/BP_Car_Sedan.BP_Car_Sedan_C';
    const buf = Buffer.concat([softObjectProp('SoftClass', asset), intProp('Marker', 42)]);
    const r = createReader(buf);

    const prop = readProperty(r);
    assert.equal(prop.name, 'SoftClass');
    assert.equal(prop.type, 'SoftObjectProperty');
    assert.equal(prop.value, asset);

    // The 4-byte empty subPath must have been consumed — the next property
    // parses cleanly. Pre-fix this desynced the stream by 4 bytes.
    const next = readProperty(r);
    assert.equal(next.name, 'Marker');
    assert.equal(next.value, 42);
  });

  it('realigns via dataSize even with a non-empty subPath', () => {
    const payload = softObjectPayload('/Game/Thing.Thing_C', 'SubObject');
    const buf = Buffer.concat([
      writeFString('SoftClass'),
      writeFString('SoftObjectProperty'),
      writeI64(BigInt(payload.length)),
      SEP,
      payload,
      intProp('Marker', 7),
    ]);
    const r = createReader(buf);

    const prop = readProperty(r);
    assert.equal(prop.value, '/Game/Thing.Thing_C');
    const next = readProperty(r);
    assert.equal(next.name, 'Marker');
    assert.equal(next.value, 7);
  });

  it('parses arrays of SoftObjectProperty without desync', () => {
    const paths = ['/Game/A.A_C', '/Game/B.B_C', '/Game/C.C_C'];
    const elements = Buffer.concat(paths.map((p) => softObjectPayload(p)));
    const payload = Buffer.concat([writeI32(paths.length), elements]);
    const buf = Buffer.concat([
      writeFString('SoftClasses'),
      writeFString('ArrayProperty'),
      writeI64(BigInt(payload.length)),
      writeFString('SoftObjectProperty'),
      SEP,
      payload,
      intProp('Marker', 99),
    ]);
    const r = createReader(buf);

    const prop = readProperty(r);
    assert.equal(prop.type, 'ArrayProperty');
    assert.equal(prop.innerType, 'SoftObjectProperty');
    assert.deepEqual(prop.value, paths);

    const next = readProperty(r);
    assert.equal(next.name, 'Marker');
    assert.equal(next.value, 99);
  });
});

// ── MapProperty capture ─────────────────────────────────────────────────────

function mapProp(name: string, keyType: string, valType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    writeFString(name),
    writeFString('MapProperty'),
    writeI64(BigInt(payload.length)),
    writeFString(keyType),
    writeFString(valType),
    SEP,
    payload,
  ]);
}

describe('readProperty — MapProperty capture', () => {
  it('MAP_CAPTURE includes the audit-fix names', () => {
    for (const name of ['Params', 'Stats', 'Data', 'Time']) {
      assert.ok(MAP_CAPTURE.has(name), `MAP_CAPTURE missing ${name}`);
    }
  });

  it('captures Params as Name → Float entries', () => {
    const payload = Buffer.concat([
      writeI32(0), // removedCount
      writeI32(2), // count
      writeFString('Hunger'),
      writeF32(0.5),
      writeFString('ZombieDiff'),
      writeF32(2),
    ]);
    const buf = Buffer.concat([mapProp('Params', 'NameProperty', 'FloatProperty', payload), intProp('Marker', 1)]);
    const r = createReader(buf);

    const prop = readProperty(r);
    assert.equal(prop.type, 'MapProperty');
    assert.equal((prop.value as Record<string, number>)['Hunger'], 0.5);
    assert.equal((prop.value as Record<string, number>)['ZombieDiff'], 2);

    const next = readProperty(r);
    assert.equal(next.name, 'Marker');
    assert.equal(next.value, 1);
  });

  it('captures GUID-suffixed Params names (cleanName applied)', () => {
    const payload = Buffer.concat([writeI32(0), writeI32(1), writeFString('LootMulti'), writeF32(1.5)]);
    const buf = mapProp('Params_4_8327725544A5FDD6F1253EADFFE4023C', 'NameProperty', 'FloatProperty', payload);
    const r = createReader(buf);

    const prop = readProperty(r);
    assert.equal(prop.name, 'Params');
    assert.equal((prop.value as Record<string, number>)['LootMulti'], 1.5);
  });

  it('captures Stats as Name → Str entries (companion stats)', () => {
    const payload = Buffer.concat([
      writeI32(0),
      writeI32(3),
      writeFString('health'),
      writeFString('1600.0'),
      writeFString('Food'),
      writeFString('90.68'),
      writeFString('Name'),
      writeFString('Rex'),
    ]);
    const buf = Buffer.concat([mapProp('Stats', 'NameProperty', 'StrProperty', payload), intProp('Marker', 2)]);
    const r = createReader(buf);

    const prop = readProperty(r);
    const stats = prop.value as Record<string, string>;
    assert.equal(stats['health'], '1600.0');
    assert.equal(stats['Food'], '90.68');
    assert.equal(stats['Name'], 'Rex');

    const next = readProperty(r);
    assert.equal(next.value, 2);
  });

  it('captures Time as Name → raw inline DateTime ticks (quest timers)', () => {
    // 638263293618830000 ticks = 2023-07-30T15:56:01.883Z
    const ticks = 638263293618830000n;
    const payload = Buffer.concat([writeI32(0), writeI32(1), writeFString('TradeSpawn'), writeI64(ticks)]);
    const buf = Buffer.concat([mapProp('Time', 'NameProperty', 'StructProperty', payload), intProp('Marker', 3)]);
    const r = createReader(buf);

    const prop = readProperty(r);
    assert.equal(prop.type, 'MapProperty');
    assert.equal((prop.value as Record<string, number>)['TradeSpawn'], Number(ticks));

    // Raw int64 values are untagged — pre-fix the tagged-struct reader would
    // have desynced here. The trailing marker proves alignment.
    const next = readProperty(r);
    assert.equal(next.name, 'Marker');
    assert.equal(next.value, 3);
  });

  it('skips uncaptured maps and stays aligned', () => {
    const payload = Buffer.concat([writeI32(0), writeI32(1), writeFString('K'), writeF32(1)]);
    const buf = Buffer.concat([mapProp('NotCaptured', 'NameProperty', 'FloatProperty', payload), intProp('Marker', 4)]);
    const r = createReader(buf);

    const prop = readProperty(r);
    assert.equal(prop.value, null);
    const next = readProperty(r);
    assert.equal(next.value, 4);
  });
});
