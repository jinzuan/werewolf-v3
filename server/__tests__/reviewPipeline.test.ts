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
