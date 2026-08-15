import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addReviewInsight,
  clearReviewInsights,
  getReviewInsights,
  setReviewStorageBackend,
} from '../../shared/experienceReview';

test('experience gate drops empty and generic reflections, keeps evidence-backed lessons, and warns', () => {
  const storage = new Map<string, string>();
  setReviewStorageBackend({
    get: (key) => storage.get(key) ?? null,
    set: (key, value) => storage.set(key, value),
  });
  clearReviewInsights('wolf');
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '));

  try {
    assert.equal(addReviewInsight('wolf', ''), false);
    assert.equal(addReviewInsight('wolf', '下一局认真复盘，重视证据和沟通。'), false);
    assert.equal(
      addReviewInsight('wolf', '查验到狼人后应及时对齐票型，避免把已知查杀拖成分票。', { tags: ['查验'] }),
      true,
    );
    assert.deepEqual(getReviewInsights('wolf'), ['查验到狼人后应及时对齐票型，避免把已知查杀拖成分票。']);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /无可验证事件引用/);
  } finally {
    console.warn = originalWarn;
    clearReviewInsights('wolf');
    setReviewStorageBackend(null);
  }
});

test('persisted review migration removes old generic entries but preserves event-backed lessons', () => {
  const storage = new Map<string, string>([
    [
      'wolf-exp-review-v1',
      JSON.stringify({
        wolf: [
          '复盘时只保留可验证的行动和票型，下一局根据新证据更新判断。',
          '查验到狼人后应及时对齐票型，避免把已知查杀拖成分票。',
          '本局关键在于把公开票型和夜间信息对齐；下一局先核对证据链，再决定归票。',
        ],
        seer: ['被投票出局后优先把查验结果完整留给场上。'],
      }),
    ],
  ]);
  setReviewStorageBackend({
    get: (key) => storage.get(key) ?? null,
    set: (key, value) => storage.set(key, value),
  });

  try {
    assert.deepEqual(getReviewInsights('wolf'), [
      '查验到狼人后应及时对齐票型，避免把已知查杀拖成分票。',
    ]);
    assert.deepEqual(getReviewInsights('seer'), [
      '被投票出局后优先把查验结果完整留给场上。',
    ]);
    const persisted = JSON.parse(storage.get('wolf-exp-review-v1') || '{}') as Record<string, string[]>;
    assert.deepEqual(persisted.wolf, [
      '查验到狼人后应及时对齐票型，避免把已知查杀拖成分票。',
    ]);
    assert.deepEqual(persisted.seer, [
      '被投票出局后优先把查验结果完整留给场上。',
    ]);
  } finally {
    setReviewStorageBackend(null);
  }
});
