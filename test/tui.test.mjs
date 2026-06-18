import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import htm from 'htm';
import { render } from 'ink-testing-library';
import { App } from '../lib/tui/app.js';

const html = htm.bind(React.createElement);
const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

test('TUI mounts and renders the main menu', async () => {
  const { lastFrame, unmount } = render(html`<${App} />`);
  await tick();
  const frame = lastFrame();
  unmount();
  assert.match(frame, /visually-3d/);
  assert.match(frame, /Create new scene/);
  assert.match(frame, /Continue existing/);
  assert.match(frame, /Quit/);
});

test('selecting "Create new" opens the subject form', async () => {
  const { lastFrame, stdin, unmount } = render(html`<${App} />`);
  await tick(80);
  stdin.write('\r'); // Enter on the first (highlighted) item → Create new
  await tick(80);
  const frame = lastFrame();
  unmount();
  assert.match(frame, /Subject/, 'should show the subject prompt');
});

test('navigating down to "Continue existing" opens the scene picker', async () => {
  const { lastFrame, stdin, unmount } = render(html`<${App} />`);
  await tick(80);
  stdin.write('[B'); // down arrow
  await tick(40);
  stdin.write('\r');       // Enter → Continue existing
  await tick(80);
  const frame = lastFrame();
  unmount();
  // either lists scenes ("Pick a scene") or shows the empty-state message
  assert.ok(/Pick a scene|No saved scenes/.test(frame), `unexpected frame:\n${frame}`);
});
