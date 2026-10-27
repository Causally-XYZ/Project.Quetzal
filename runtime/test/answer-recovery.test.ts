import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Msg } from '../src/providers/types.ts';
import type { ToolRecord } from '../../engine/src/loop.ts';
import { rebuildAnswerMessages } from '../src/mind/answer-recovery.ts';

test('恢复保留绑定输入对象，排除当轮草稿、工具正文、未绑定图片与提醒', () => {
  const initial: Msg[] = [{ role: 'system', content: '政策' }, { role: 'user', content: '原始问题' }];
  const incoming: Msg = { role: 'user', content: '用户补充' };
  const trajectory: Msg[] = [...initial, { role: 'assistant', content: 'OLD_DRAFT' },
    { role: 'tool', name: 'note_read', toolCallId: 'read', content: 'OLD_TOOL_BODY' },
    { role: 'user', content: 'OLD_TOOL_IMAGE', images: [{ mime: 'image/png', data: 'OLD_IMAGE_DATA' }] },
    { role: 'user', content: 'OLD_GENERATED_REMINDER' }, incoming];
  const base: ToolRecord = { call: 'read', session: 'turn', ts: 1, tool: 'note_read', args: { hidden: 'OLD_ARGS' }, result: 'OLD_RESULT', status: 'ok', ms: 1 };
  const records = [base, { ...base, call: 'write', tool: 'note_save' }];
  const refs: string[] = [];
  const result = rebuildAnswerMessages(initial, trajectory, records, (record) => { refs.push(record.call); return `reference:${record.call}`; }, (message) => message === incoming);
  assert.equal(result[1], initial[0]); assert.equal(result[2], initial[1]); assert.equal(result.at(-1), incoming);
  assert.deepEqual(refs, ['read']); assert.match(result[0].content, /note_save/); assert.match(result[0].content, /reference:read/);
  assert.ok(!JSON.stringify(result).includes('OLD_')); assert.deepEqual(initial.map((m) => m.content), ['政策', '原始问题']);
});

test('超长执行索引明确截断，旧操作正文不挤占恢复上下文', () => {
  const records: ToolRecord[] = Array.from({ length: 100 }, (_, i) => ({ call: `c${i}`, session: 'turn', ts: i, tool: 'note_read', args: {}, result: '旧正文'.repeat(1000), status: 'ok', ms: 1 }));
  const refs: string[] = [];
  const result = rebuildAnswerMessages([{ role: 'user', content: '继续核对' }], [], records, (record) => { refs.push(record.call); return record.call; }, () => false);
  assert.equal(refs.length, 64); assert.equal(refs[0], 'c36'); assert.match(result[0].content, /不代表完整执行清单/);
  assert.ok(!result[0].content.includes('旧正文')); assert.ok(result[0].content.length < 10000);
});
