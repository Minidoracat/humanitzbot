const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cleanName, cleanItemName } = require('../src/ue4-names');

describe('cleanName', () => {
  it('handles Door_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(
      cleanName('Door_GEN_VARIABLE_BP_LockedMetalShutter_C_CAT_2147206852'),
      'Locked Metal Shutter'
    );
  });

  it('handles ChildActor_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(
      cleanName('ChildActor_GEN_VARIABLE_BP_VehicleStorage_C_CAT_2147253396'),
      'Vehicle Storage'
    );
  });

  it('handles Storage_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(
      cleanName('Storage_GEN_VARIABLE_BP_WoodCrate_C_2147261242'),
      'Wood Crate'
    );
  });

  it('handles BuildContainer_NNN', () => {
    assert.equal(cleanName('BuildContainer_147'), 'Container');
    assert.equal(cleanName('BuildContainer'), 'Container');
  });

  it('handles simple BP_ prefix', () => {
    assert.equal(cleanName('BP_WoodWall_C_12345'), 'Wood Wall');
  });

  it('handles BP_ prefix with _C suffix', () => {
    assert.equal(cleanName('BP_SandbagWall_C'), 'Sandbag Wall');
  });

  it('handles CupboardContainer', () => {
    assert.equal(
      cleanName('ChildActor_GEN_VARIABLE_BP_CupboardContainer_C_CAT_12345'),
      'Cupboard'
    );
  });

  it('handles VehicleStorage in actor name', () => {
    assert.equal(
      cleanName('Storage_GEN_VARIABLE_BP_VehicleStorage_C_2147261242'),
      'Vehicle Storage'
    );
  });

  it('handles Fridge', () => {
    assert.equal(
      cleanName('ChildActor_GEN_VARIABLE_BP_Fridge_C_CAT_999'),
      'Fridge'
    );
  });

  it('handles already clean names', () => {
    assert.equal(cleanName('Wood Wall'), 'Wood Wall');
    assert.equal(cleanName('Barrel'), 'Barrel');
  });

  it('handles CamelCase without underscores', () => {
    assert.equal(cleanName('LockedMetalShutter'), 'Locked Metal Shutter');
  });

  it('handles null/undefined/empty', () => {
    assert.equal(cleanName(null), 'Unknown');
    assert.equal(cleanName(undefined), 'Unknown');
    assert.equal(cleanName(''), 'Unknown');
  });

  it('handles full blueprint path', () => {
    assert.equal(
      cleanName('/Game/BuildingSystem/Blueprints/Buildings/BP_WoodWall.BP_WoodWall_C'),
      'Wood Wall'
    );
  });

  it('handles Window_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(
      cleanName('Window_GEN_VARIABLE_BP_GlassWindow_C_CAT_999'),
      'Glass Window'
    );
  });

  it('handles Lamp_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(
      cleanName('Lamp_GEN_VARIABLE_BP_FloorLamp_C_CAT_123'),
      'Floor Lamp'
    );
  });

  it('handles StorageContainer', () => {
    assert.equal(
      cleanName('ChildActor_GEN_VARIABLE_BP_StorageContainer_C_2147000000'),
      'Storage Container'
    );
  });

  it('strips trailing numeric IDs', () => {
    assert.equal(cleanName('BP_Item_Name_42'), 'Item Name');
  });
});

describe('cleanItemName', () => {
  it('handles BP_ prefix items', () => {
    assert.equal(cleanItemName('BP_WoodPlank_C'), 'Wood Plank');
  });

  it('handles CamelCase items', () => {
    assert.equal(cleanItemName('WaterPurifyPills'), 'Water Purify Pills');
  });

  it('handles full paths', () => {
    assert.equal(
      cleanItemName('/Game/Items/BP_Bandage.BP_Bandage_C'),
      'Bandage'
    );
  });

  it('handles null/undefined', () => {
    assert.equal(cleanItemName(null), 'Unknown');
    assert.equal(cleanItemName(undefined), 'Unknown');
  });

  it('handles simple names', () => {
    assert.equal(cleanItemName('Nails'), 'Nails');
  });
});
