// Driving the vendor renderer (work/app-pretty/renderer/assets, 1.13.0) the way a user does: through its
// own components, located by the class names of the vendor's shared UI kit (main-CDosWiM3.js):
//   Select    .vc-select > .vc-select-dropdown; options teleported to #component-teleport-container
//             .select-expand-wrap .select-item (main-CDosWiM3.js:2730-2880)
//   Slider    .vc-slider .slider-bar-wrap: mousedown sets round((x - runway.x) * range / width) + min and
//             emits "change" at once (main-CDosWiM3.js:3290-3310)
//   Switch    .vc-switch .switch-button
//   Menu      .vc-menu .menu-item (page tabs: GameMode/System/Setup menus, Settings tabs)
//   Icon      .vc-icon > .icon-image.icon-<name>[__actived] (sidebar, toolbar)
//   ActionBox .vc-action-box footer buttons "Cancel"/"Ok" (main-CDosWiM3.js:2204-2262)
//   Loading   .vc-loading, shown with v-show while the vu() loading counter is non-zero (styles:8290-8309)
//   Tutorials .tutorials-view .next-btn ("Next"/"GotIt"), per route: DeviceOverview 3, MonitorView 1,
//             Dashboard 1 (main-CDosWiM3.js:886-940)

import type { Locator, Page } from 'playwright-core';

/** Sidebar icon names of the monitor section (main-CDosWiM3.js:283-325). */
export type MonitorNav = 'nav_smart_image' | 'nav_game_mode' | 'nav_ambiglow' | 'nav_input' | 'nav_audio' | 'nav_system' | 'nav_setup' | 'nav_sync';

export function sidebarIcon(w: Page, name: MonitorNav): Locator {
  return w.locator(`.sidebar .view-item .vc-icon:has(.icon-image[class*="icon-${name}"])`);
}

/** Toolbar: home, dashboard, setting (main-CDosWiM3.js "toolbar"). */
export function toolbarIcon(w: Page, name: 'home' | 'dashboard' | 'setting'): Locator {
  return w.locator(`.toolbar .view-icon-wrap .vc-icon:has(.icon-image[class*="icon-${name}"])`);
}

export function menuItem(w: Page, text: string): Locator {
  return w.locator('.vc-menu .menu-item').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) });
}

export async function menuTexts(w: Page): Promise<string[]> {
  return (await w.locator('.vc-menu .menu-item').allInnerTexts()).map((t) => t.trim());
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk the vendor's first-run tutorial of the current route ("Next" … "GotIt"); returns the steps taken.
 * The overlay renders after the route change settled, so with `expectShown` it is awaited first (up to
 * 10 s); otherwise it is given 1 s to (not) appear.
 */
export async function walkTutorial(w: Page, expectShown: boolean): Promise<number> {
  await w
    .locator('.tutorials-view .next-btn')
    .waitFor({ state: 'visible', timeout: expectShown ? 10_000 : 1_000 })
    .catch(() => undefined);
  let steps = 0;
  for (; steps < 10; steps++) {
    const next = w.locator('.tutorials-view .next-btn');
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await w.waitForTimeout(200);
  }
  return steps;
}

/** Open a Select and pick the option with exactly this text. */
export async function chooseOption(w: Page, select: Locator, text: string): Promise<void> {
  await select.locator('.vc-select-dropdown').click();
  const option = w
    .locator('#component-teleport-container .select-expand-wrap .select-item')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`) });
  await option.first().click();
}

/** Set a Slider to `value` by pressing the mouse on the runway where the vendor's rounding lands on it. */
export async function setSlider(w: Page, slider: Locator, value: number, min: number, max: number): Promise<void> {
  const runway = slider.locator('.slider-runway').first();
  const box = await runway.boundingBox();
  if (!box) throw new Error('slider runway not visible');
  const x = box.x + ((value - min) / (max - min)) * box.width;
  const y = box.y + box.height / 2;
  await w.mouse.move(x, y);
  await w.mouse.down();
  await w.mouse.up();
}

/** Every loading overlay hidden (the app-wide .vc-loading and the startup .loading-screen). */
export async function overlaysHidden(w: Page): Promise<boolean> {
  return w.evaluate(() =>
    // checkVisibility(): false when the element or an ancestor is display:none (v-show) or not rendered
    [...document.querySelectorAll('.vc-loading, .loading-screen')].every((e) => !e.checkVisibility({ visibilityProperty: true })),
  );
}
