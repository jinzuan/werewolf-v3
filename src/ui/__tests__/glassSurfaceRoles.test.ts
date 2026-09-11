import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge } from '../Badge';
import { Button } from '../Button';
import { Card } from '../Card';
import { ChatBubble } from '../ChatBubble';
import { DragSegmented } from '../DragSegmented';
import { Input } from '../Input';
import { Modal } from '../Modal';
import { Status } from '../Status';

const workspace = process.cwd();

function openingTagFor(markup: string, classToken: string) {
  const classOffset = markup.indexOf(classToken);
  assert.notEqual(classOffset, -1, `missing ${classToken}`);
  const start = markup.lastIndexOf('<', classOffset);
  const end = markup.indexOf('>', classOffset);
  assert.notEqual(start, -1, `missing opening tag for ${classToken}`);
  assert.notEqual(end, -1, `unterminated opening tag for ${classToken}`);
  return markup.slice(start, end + 1);
}

function assertGlassContract(
  markup: string,
  classToken: string,
  role: string,
  motion?: string,
) {
  const tag = openingTagFor(markup, classToken);
  assert.match(tag, new RegExp(`data-glass-role="${role}"`));
  if (motion) assert.match(tag, new RegExp(`data-glass-motion="${motion}"`));
}

test('shared primitives render explicit material roles on their existing semantic hosts', () => {
  assertGlassContract(
    renderToStaticMarkup(createElement(Button, null, '保存')),
    'v3-button',
    'control',
    'control',
  );
  assertGlassContract(
    renderToStaticMarkup(createElement(Card, null, '设置')),
    'v3-card',
    'panel',
  );
  assertGlassContract(
    renderToStaticMarkup(createElement(Input, { 'aria-label': '房间号' })),
    'v3-input',
    'field',
  );
  assertGlassContract(
    renderToStaticMarkup(createElement(Badge, null, '在线')),
    'v3-badge',
    'item',
  );
  assertGlassContract(
    renderToStaticMarkup(createElement(Status, { label: '已准备' })),
    'ww-status',
    'item',
  );
});

test('composite surfaces put roles on the visible surface without adding layout wrappers', () => {
  const chat = renderToStaticMarkup(createElement(ChatBubble, {
    author: '阿宁',
    time: '21:00',
    children: '先听后置位。',
  }));
  assertGlassContract(chat, 'v3-chat-bubble', 'item');
  assert.match(chat, /^<div class="v3-chat-row/);

  const systemChat = renderToStaticMarkup(createElement(ChatBubble, {
    author: '系统',
    time: '21:01',
    variant: 'system',
    children: '天亮了。',
  }));
  assertGlassContract(systemChat, 'v3-chat-system', 'item');

  const modal = renderToStaticMarkup(createElement(Modal, {
    open: true,
    title: '确认',
    onClose: () => undefined,
    children: '是否继续？',
  }));
  assertGlassContract(modal, 'v3-modal v3-modal--default', 'panel');
  assert.match(openingTagFor(modal, 'v3-modal v3-modal--default'), /data-glass-priority="high"/);
  assert.match(modal, /^<div class="v3-modal-backdrop"/);

});

test('asset-backed primitives declare roles on their existing visible hosts', async () => {
  const [seat, roleCard, roleReveal] = await Promise.all([
    readFile(path.join(workspace, 'src/ui/Seat.tsx'), 'utf8'),
    readFile(path.join(workspace, 'src/ui/RoleCard.tsx'), 'utf8'),
    readFile(path.join(workspace, 'src/ui/RoleRevealCard.tsx'), 'utf8'),
  ]);

  assert.match(
    seat,
    /<button[\s\S]*?className=\{cn\([\s\S]*?['"]ww-seat['"][\s\S]*?data-glass-role="item"[\s\S]*?data-glass-motion="control"[\s\S]*?>/,
  );
  assert.equal((roleCard.match(/data-glass-role="panel"/g) ?? []).length, 2);
  assert.match(
    roleCard,
    /<button[\s\S]*?className=\{cn\(['"]ww-role-card['"][\s\S]*?data-glass-role="panel"[\s\S]*?data-glass-motion="control"/,
  );
  assert.match(
    roleCard,
    /<article[\s\S]*?className=\{cn\(['"]ww-role-card['"][\s\S]*?data-glass-role="panel"/,
  );
  assert.match(
    roleReveal,
    /className="ww-role-reveal__card"[\s\S]*?data-glass-role="panel"[\s\S]*?data-glass-motion="control"/,
  );
  assert.match(
    roleReveal,
    /className="ww-role-reveal__info-button"[\s\S]*?data-glass-role="control"[\s\S]*?data-glass-motion="control"/,
  );
  assert.match(
    roleReveal,
    /className=\{`ww-role-reveal__popover[\s\S]*?data-glass-role="item"/,
  );
});

test('segmented control gives optical ownership only to its base and moving slider', () => {
  const markup = renderToStaticMarkup(createElement(DragSegmented, {
    value: 'day',
    ariaLabel: '场景',
    options: [
      { value: 'day', label: '白天' },
      { value: 'night', label: '夜晚' },
    ] as const,
    onChange: (_value: 'day' | 'night') => undefined,
  }));

  const base = openingTagFor(markup, 'drag-segmented');
  assert.match(base, /data-glass-role="segmented"/);
  assert.match(base, /data-glass-owner="self"/);

  const slider = openingTagFor(markup, 'drag-segmented__slider');
  assert.match(slider, /data-glass-role="control"/);
  assert.match(slider, /data-glass-owner="self"/);
  assert.match(slider, /data-glass-motion="slider"/);

  const optionTags = [...markup.matchAll(/<button[^>]*class="drag-segmented__option[^"]*"[^>]*>/g)]
    .map((match) => match[0]);
  assert.equal(optionTags.length, 2);
  for (const option of optionTags) {
    assert.match(option, /data-glass-owner="none"/);
    assert.match(option, /data-glass-motion="none"/);
    assert.doesNotMatch(option, /data-glass-role=/);
  }

  assert.equal((markup.match(/data-glass-owner="self"/g) ?? []).length, 2);
});

test('all target source primitives declare roles instead of depending on CSS discovery', async () => {
  const targets = [
    'Badge.tsx',
    'Button.tsx',
    'Card.tsx',
    'ChatBubble.tsx',
    'DragSegmented.tsx',
    'Input.tsx',
    'Modal.tsx',
    'RoleCard.tsx',
    'RoleRevealCard.tsx',
    'Seat.tsx',
    'Status.tsx',
  ];
  const sources = await Promise.all(targets.map((target) => (
    readFile(path.join(workspace, 'src/ui', target), 'utf8')
  )));

  for (const [index, source] of sources.entries()) {
    assert.match(source, /data-glass-role=/, `${targets[index]} lacks an explicit glass role`);
  }
});
