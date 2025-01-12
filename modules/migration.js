/**
 * Perform a system migration for the entire World, applying migrations for Actors, Items, and Compendium packs
 * @return {Promise}      A Promise which resolves once the migration is completed
 */
export const migrateWorld = async function() {
  ui.notifications.info(`Applying AGE System Migration for version ${game.system.data.version}. Please be patient and do not close your game or shut down your server.`, {permanent: true});

  // Migrate World Actors
  for ( let a of game.actors.entities ) {
    try {
      const updateData = migrateActorData(a.data);
      if ( !isObjectEmpty(updateData) ) {
        console.log(`Migrating Actor entity ${a.name}`);
        await a.update(updateData, {enforceTypes: false});
      }
    } catch(err) {
      err.message = `Failed AGE System migration for Actor ${a.name}: ${err.message}`;
      console.error(err);
    }
  }

  // Migrate World Items
  for ( let i of game.items.entities ) {
    try {
      const updateData = migrateItemData(i.data);
      if ( !isObjectEmpty(updateData) ) {
        console.log(`Migrating Item entity ${i.name}`);
        await i.update(updateData, {enforceTypes: false});
      }
    } catch(err) {
      err.message = `Failed AGE System migration for Item ${i.name}: ${err.message}`;
      console.error(err);
    }
  }

  // Migrate Actor Override Tokens
  for ( let s of game.scenes.entities ) {
    try {
      const updateData = migrateSceneData(s.data);
      if ( !isObjectEmpty(updateData) ) {
        console.log(`Migrating Scene entity ${s.name}`);
        await s.update(updateData, {enforceTypes: false});
      }
    } catch(err) {
      err.message = `Failed age-system migration for Scene ${s.name}: ${err.message}`;
      console.error(err);
    }
  }

  // Migrate World Compendium Packs
  for ( let p of game.packs ) {
    if ( p.metadata.package !== "world" ) continue;
    if ( !["Actor", "Item", "Scene"].includes(p.metadata.entity) ) continue;
    await migrateCompendium(p);
  }

  // Set the migration as complete
  game.settings.set("age-system", "systemMigrationVersion", game.system.data.version);
  ui.notifications.info(`AGE System Migration to version ${game.system.data.version} completed!`, {permanent: true});
};

/* -------------------------------------------- */

/**
 * Apply migration rules to all Entities within a single Compendium pack
 * @param pack
 * @return {Promise}
 */
export const migrateCompendium = async function(pack) {
  const entity = pack.metadata.entity;
  if ( !["Actor", "Item", "Scene"].includes(entity) ) return;

  // Unlock the pack for editing
  const wasLocked = pack.locked;
  await pack.configure({locked: false});

  // Begin by requesting server-side data model migration and get the migrated content
  await pack.migrate();
  const content = await pack.getContent();

  // Iterate over compendium entries - applying fine-tuned migration functions
  for ( let ent of content ) {
    let updateData = {};
    try {
      switch (entity) {
        case "Actor":
          updateData = migrateActorData(ent.data);
          break;
        case "Item":
          updateData = migrateItemData(ent.data);
          break;
        case "Scene":
          updateData = migrateSceneData(ent.data);
          break;
      }
      if ( isObjectEmpty(updateData) ) continue;

      // Save the entry, if data was changed
      updateData["_id"] = ent._id;
      await pack.updateEntity(updateData);
      console.log(`Migrated ${entity} entity ${ent.name} in Compendium ${pack.collection}`);
    }

    // Handle migration failures
    catch(err) {
      err.message = `Failed age-system system migration for entity ${ent.name} in pack ${pack.collection}: ${err.message}`;
      console.error(err);
    }
  }

  // Apply the original locked status for the pack
  pack.configure({locked: wasLocked});
  console.log(`Migrated all ${entity} entities from Compendium ${pack.collection}`);
};

/* -------------------------------------------- */
/*  Entity Type Migration Helpers               */
/* -------------------------------------------- */

/**
 * Migrate a single Actor entity to incorporate latest data model changes
 * Return an Object of updateData to be applied
 * @param {Actor} actor   The actor to Update
 * @return {Object}       The updateData to apply
 */
export const migrateActorData = function(actor) {
  const updateData = {};

  // Actor Data Updates
  _addActorConditions(actor, updateData);
  _addVehicleCustomDmg(actor, updateData);

  // Migrate Owned Items
  if ( !actor.items ) return updateData;
  let hasItemUpdates = false;
  const items = actor.items.map(i => {
    // Migrate the Owned Item
    let itemUpdate = migrateItemData(i);

    // Update the Owned Item
    if ( !isObjectEmpty(itemUpdate) ) {
      hasItemUpdates = true;
      return mergeObject(i, itemUpdate, {enforceTypes: false, inplace: false});
    } else return i;
  });
  if ( hasItemUpdates ) updateData.items = items;
  return updateData;
};

/* -------------------------------------------- */


/**
 * Migrate a single Item entity to incorporate latest data model changes
 * @param item
 */
export const migrateItemData = function(item) {
  const updateData = {};
  _addItemModSpeed(item, updateData);
  _addItemValidResistedDmgAbl(item, updateData);
  _addExtraPowerData(item, updateData);
  _addItemForceAbl(item, updateData);
  return updateData;
};

/* -------------------------------------------- */

/**
 * Migrate a single Scene entity to incorporate changes to the data model of it's actor data overrides
 * Return an Object of updateData to be applied
 * @param {Object} scene  The Scene data to Update
 * @return {Object}       The updateData to apply
 */
export const migrateSceneData = function(scene) {
  const tokens = duplicate(scene.tokens);
  return {
    tokens: tokens.map(t => {
      if (!t.actorId || t.actorLink || !t.actorData.data) {
        t.actorData = {};
        return t;
      }
      const token = new Token(t);
      if ( !token.actor ) {
        t.actorId = null;
        t.actorData = {};
      } else if ( !t.actorLink ) {
        const updateData = migrateActorData(token.data.actorData);
        t.actorData = mergeObject(token.data.actorData, updateData);
      }
      return t;
    })
  };
};

/* -------------------------------------------- */
/*  Low level migration utilities
/* -------------------------------------------- */

/**
 * Add actor conditions
 * @private
 */
function _addActorConditions(actor, updateData) {
  if (actor.type !== "char") return updateData;
  
  const conditions = ["blinded", "deafened", "exhausted", "fatigued", "freefalling", "helpless", "hindred",
  "prone", "restrained", "injured", "wounded", "unconscious", "dying"];

  // Add Conditions - added a fix
  if (actor.data.conditions) {
    if (typeof actor.data.conditions === "object") {
      let complete = true;
      for (let c = 0; c < conditions.length; c++) {
        const condition = conditions[c];
        if (!actor.data.conditions.hasOwnProperty(condition)) complete = false;
      }
      if (complete) return updateData;
    } else {
      delete actor.data.conditions;
    };
  }
  
  if (!actor.data.conditions) {
    updateData["data.conditions"] = {};
    for (let c = 0; c < conditions.length; c++) {
      const cond = conditions[c];
      const condString = `data.conditions.${cond}`;
      udpateData[condString] = false;    
    }
  };

  return updateData
}
/* -------------------------------------------- */

/**
 * Add vehicle custom damage
 * @private
 */
function _addVehicleCustomDmg(actor, updateData) {
  if (actor.type !== "vehicle") return updateData;

  if (!actor.data.hasOwnProperty(customSideswipeDmg)) updateData["data.customSideswipeDmg"] = 1;
  if (!actor.data.hasOwnProperty(customCollisionDmg)) updateData["data.customCollisionDmg"] = 1;

  return updateData
}
/* -------------------------------------------- */

/**
 * Add Speed Modificator option to item
 * @private
 */
function _addItemModSpeed(item, updateData) {
  if (item.type === "focus" || item.type === "honorifics" || item.type === "relationship" || item.type === "membership" || item.type === "stunts") return updateData;
  if (item.data.itemMods.speed) return updateData;

  updateData["data.itemMods.speed"] = {};
  updateData["data.itemMods.speed.isActive"] = false;
  updateData["data.itemMods.speed.value"] = 0;

  return updateData
}
/* -------------------------------------------- */

/**
 * Add extra Power elements to address resist Test
 * and half damage when spell is resisted
 * @private
 */
function _addExtraPowerData(item, updateData) {
  if (item.type !== "power") return updateData;
  if (item.data.ablFatigue) return updateData;

  updateData["data.causeHealing"] = false;
  updateData["data.ablFatigue"] = "will";
  updateData["data.hasTest"] = false;
  updateData["data.testAbl"] = "will";
  updateData["data.testFocus"] = "";
  updateData["data.damageResisted"] = {};
  updateData["data.damageResisted.nrDice"] = 1;
  updateData["data.damageResisted.diceType"] = 6;
  updateData["data.damageResisted.extraValue"] = 0;
  updateData["data.damageResisted.dmgAbl"] = "will";

  return updateData;
}

/**
 * Fix imported values for Ability to Resist Power
 * @private
 */
function _addItemValidResistedDmgAbl(item, updateData) {
  if (item.type !== "power") return updateData;
  if (item.data.damageResisted) {
    if (!item.data.damageResisted.dmgAbl) {
      updateData["data.damageResisted.dmgAbl"] = "will";  
    }
  }
  return updateData;
}
/* -------------------------------------------- */

/**
 * Add itemForceAbl field for powers
 * @private
 */
function _addItemForceAbl(item, updateData) {
  if (item.type !== "power") return updateData;
  if (item.data.itemForceAbl) return updateData;

  updateData["data.itemForceAbl"] = "will";

  return updateData
}
/* -------------------------------------------- */