import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { reviewBudget, canReview, reserveReview } from '../src/memory/adaptive-review-budget.ts';

test('第五次调用后跨重启保留冷却，届时无新输入也自动续做第六个目标', () => {
  const b = reviewBudget(null, 123, 1000), ids = Array.from({ length: 6 }, () => crypto.randomUUID());
  for (const id of ids.slice(0, 5)) reserveReview(b, id, 1000);
  const saved = JSON.stringify(b);
  assert.equal(canReview(reviewBudget(JSON.parse(saved), 123, 60_999), ids[5]), false);
  const resumed = reviewBudget(JSON.parse(saved), 123, 61_000);
  assert.equal(canReview(resumed, ids[5]), true);
  reserveReview(resumed, ids[5], 61_000);
  assert.equal(Object.keys(resumed.attempts).length, 6);
});

test('循环修订即使产生新任务键，同一目标五次后仍有限额，独立目标不被饿死', () => {
  const id = crypto.randomUUID(), other = crypto.randomUUID(), b = reviewBudget(null, 123, 1000);
  for (let n = 0; n < 5; n++) reserveReview(b, id, 1000);
  const resumed = reviewBudget(JSON.parse(JSON.stringify(b)), 123, 61_000);
  assert.equal(canReview(resumed, id), false); assert.throws(() => reserveReview(resumed, id), /预算/);
  assert.equal(canReview(resumed, other), true);
  const fresh = reviewBudget(resumed, 124, 61_000);
  assert.equal(canReview(fresh, id), true); assert.equal(Object.keys(fresh.attempts).length, 0);
});

test('新造目标也不能无限扩充同轮预算；最多登记 1000 个目标', () => {
  let b = reviewBudget(null, 123, 1000), now = 1000;
  const first = crypto.randomUUID(); reserveReview(b, first, now);
  for (let n = 1; n < 1000; n++) {
    now += 60_000; b = reviewBudget(b, 123, now); reserveReview(b, crypto.randomUUID(), now);
  }
  b = reviewBudget(b, 123, now + 60_000);
  assert.equal(canReview(b, crypto.randomUUID()), false);
  assert.equal(canReview(b, first), true);
});

test('旧预算一次升级；损坏的新预算不能默默重置而重新资助调用', () => {
  assert.equal(reviewBudget({ epoch: 123, remaining: 0 }, 123, 1000).remaining, 5);
  for (const bad of [{ version: 3 }, { version: 2 }, { ...reviewBudget(null, 123), remaining: 9 },
    { ...reviewBudget(null, 123), attempts: { bad: 1 } }]) assert.throws(() => reviewBudget(bad, 123));
});
