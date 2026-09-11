import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DragSegmented } from '../DragSegmented';

const componentPath = path.join(process.cwd(), 'src/ui/DragSegmented.tsx');

test('renders a labelled group of real pressed-state buttons with stable classes', () => {
  const markup = renderToStaticMarkup(createElement(DragSegmented, {
    value: 'day',
    ariaLabel: '场景',
    options: [
      { value: 'day', label: '白天' },
      { value: 'night', label: '夜晚', disabled: true },
    ] as const,
    onChange: (_value: 'day' | 'night') => undefined,
  }));

  assert.match(markup, /role="group"/);
  assert.match(markup, /aria-label="场景"/);
  assert.match(markup, /class="drag-segmented/);
  assert.match(markup, /class="drag-segmented__slider"/);
  assert.match(markup, /class="drag-segmented__ghost"/);
  assert.match(markup, /class="drag-segmented__bridge"/);
  assert.match(markup, /<button[^>]*type="button"[^>]*aria-pressed="true"/);
  assert.match(markup, /drag-segmented__option--selected/);
  assert.match(markup, /<button[^>]*disabled=""/);
});

test('implements any-option captured dragging and controlled selection', async () => {
  const source = await readFile(componentPath, 'utf8');

  assert.doesNotMatch(source, /option\.value !== valueRef\.current/);
  assert.match(source, /option\.value === valueRef\.current/);
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /hasPointerCapture\(event\.pointerId\)/);
  assert.match(source, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(source, /nearestEnabledSegment/);
  assert.match(source, /onChangeRef\.current\(nearest\.value\)/);
  assert.match(source, /onPointerCancel/);
  assert.match(source, /onLostPointerCapture/);
  assert.match(source, /reconcileControlledValue/);
  assert.match(source, /valueRef\.current !== requestedValue/);
});

test('uses RAF spring following, inertial impulse and underdamped settling', async () => {
  const source = await readFile(componentPath, 'utf8');

  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /cancelAnimationFrame/);
  assert.match(source, /pointerVelocity \* 0\.07/);
  assert.match(source, /const stiffness = isFollowingPointer \? 420 : 180/);
  assert.match(source, /const damping = isFollowingPointer \? 20 : 13/);
  assert.match(source, /rubberBand/);
  assert.match(source, /const maxExcursion = selectedHeight/);
  assert.match(source, /const targetY = clamp/);
  assert.match(source, /velocityRef\.current\.y/);
  assert.match(source, /isSpringSettled/);
});

test('honours explicit, inherited and system reduced motion and cleans listeners', async () => {
  const source = await readFile(componentPath, 'utf8');

  assert.match(source, /dataMotion === 'none'/);
  assert.match(source, /closest\("\[data-motion='none'\], \[data-motion='reduced'\]"\)/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /snapTo\(targetRef\.current\)/);
  assert.match(source, /if \(motionIsReduced\(\)\) return/);
  assert.match(source, /removeEventListener\?\.\('change'/);
  assert.match(source, /observer\?\.disconnect\(\)/);
  assert.match(source, /window\.removeEventListener\('resize'/);
});

test('keeps native keyboard activation and adds roving arrow navigation', async () => {
  const source = await readFile(componentPath, 'utf8');

  assert.match(source, /type="button"/);
  assert.match(source, /tabIndex=\{option\.value === keyboardEntryValue \? 0 : -1\}/);
  assert.match(source, /event\.key === 'ArrowLeft'/);
  assert.match(source, /event\.key === 'ArrowRight'/);
  assert.match(source, /event\.key === 'Home'/);
  assert.match(source, /event\.key === 'End'/);
  assert.match(source, /onClick=\{\(\) => activateOption\(option\)\}/);
  assert.match(source, /keyboardEntryValue/);
  assert.match(source, /!option\.disabled/);
});
