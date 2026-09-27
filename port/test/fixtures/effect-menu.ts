// The one deliberate difference between the Effect_GetMenu the port serves with an ENE and the vendor's
// DisplayEffectMenu.Default("34M2C8600") (fixture 20-enum-valuelist-catalog §6.1, 3962 bytes): the FollowVideo
// item's speed fields (impl-ambiglow §5 deviation 17, src/backend/ambiglow/menu.ts FOLLOW_VIDEO_SPEED_MENU).
// The tests assert the served menu against the vendor fixture EXCEPT those fields: vendorMenuText() checks that
// the served text carries exactly the port's values there and puts the vendor's back, and the result must then
// be the fixture byte for byte. Not a test file itself.

/** The vendor's FollowVideo item (SupSpeed false; the BaseEffectMenuItem range 1..3 step 1). */
export const VENDOR_FOLLOW_VIDEO_SPEED = '"SupSpeed":false,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,';
/** The port's FollowVideo item with an ENE: the Speed slider 1..3 (Low / Normal / High). */
export const PORT_FOLLOW_VIDEO_SPEED = '"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,';

// The FollowVideo item: its Effect enum item, SupSync, then the four speed members (BaseEffectMenuItem order).
const FOLLOW_VIDEO_ITEM = /(\{"Effect":\{"Name":"FollowVideo","Text":"[^"]*","Value":1\},"SupSync":(?:true|false),)("SupSpeed":(?:true|false),"MinSpeed":-?\d+,"MaxSpeed":-?\d+,"SpeedStep":-?\d+,)/g;

/**
 * The compact UI JSON of a served ENE menu with the FollowVideo item's speed fields set back to the vendor's.
 * Throws unless the text has exactly one FollowVideo item and it carries exactly the port's speed fields.
 */
export function vendorMenuText(served: string): string {
  const items = [...served.matchAll(FOLLOW_VIDEO_ITEM)];
  if (items.length !== 1) throw new Error(`expected one FollowVideo menu item, found ${items.length}`);
  if (items[0][2] !== PORT_FOLLOW_VIDEO_SPEED) throw new Error(`FollowVideo speed fields are ${items[0][2]}, expected ${PORT_FOLLOW_VIDEO_SPEED}`);
  return served.replace(FOLLOW_VIDEO_ITEM, (_all, head: string) => head + VENDOR_FOLLOW_VIDEO_SPEED);
}
