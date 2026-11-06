import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bindRecords, runBulkDesign, BulkDesignError } from '../dist/esm/index.js';

const template = {
  slots: [
    { id: 'title', kind: 'text', required: true },
    { id: 'count', kind: 'number', default: 0 },
    { id: 'visible', kind: 'boolean', default: false },
    { id: 'optional', kind: 'text' },
  ],
};
const records = () => [
  { id: 'a', values: { name: 'Alice' } },
  { id: 'b', values: { name: 'Bob' } },
  { id: 'c', values: { name: 'Carol' } },
];
const bindings = [{ column: 'name', slot: 'title' }];
const output = (design) => ({
  fileName: `${design.recordId}.txt`,
  mediaType: 'text/plain',
  data: new TextEncoder().encode(design.slots.title),
});
const code = (expected) => (error) => error instanceof BulkDesignError && error.code === expected;
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('bindings produce exact detached slot values and defaults without undefined placeholders', () => {
  const source = records();
  const result = bindRecords(template, source, bindings);
  source[0].values.name = 'External';
  assert.deepEqual(result[0], {
    recordId: 'a',
    slots: { title: 'Alice', count: 0, visible: false },
  });
  assert.equal(Object.hasOwn(result[0].slots, 'optional'), false);
  assert.throws(() => {
    result[0].slots.title = 'Changed';
  }, TypeError);
  assert.throws(() => {
    result.push({});
  }, TypeError);
});

test('required, type, mapping, duplicate ID and unknown column errors are precise', () => {
  for (const [t, r, b] of [
    [template, [{ id: 'a', values: {} }], bindings],
    [template, [{ id: 'a', values: { name: 1 } }], bindings],
    [template, [{ id: 'a', values: { name: 'A', extra: true } }], bindings],
    [template, [records()[0], records()[0]], bindings],
    [template, records(), [{ column: 'name', slot: 'missing' }]],
    [template, records(), [...bindings, ...bindings]],
    [template, records(), [...bindings, { column: 'name', slot: 'optional' }]],
    [{ slots: [{ id: 'x', kind: 'text', default: undefined }] }, [], []],
    [{ slots: [{ id: 'x', kind: 'number', default: 'not number' }] }, [], []],
    [{ slots: [{ id: 'x', kind: 'text', required: 'yes' }] }, [], []],
    [
      {
        slots: [
          { id: 'x', kind: 'text' },
          { id: 'x', kind: 'text' },
        ],
      },
      [],
      [],
    ],
    [{ slots: [] }, [], []],
  ])
    assert.throws(() => bindRecords(t, r, b), code('invalid'));
});

test('record data rejects getters, symbols, nonfinite numbers and nonplain records', () => {
  const getter = Object.defineProperty({}, 'name', {
    enumerable: true,
    get() {
      throw new Error('must not run');
    },
  });
  for (const values of [
    getter,
    { [Symbol('x')]: 'A' },
    new Date(),
    { name: NaN },
    { name: undefined },
  ])
    assert.throws(() => bindRecords(template, [{ id: 'a', values }], bindings), code('invalid'));
});

test('record, slot, column and string capacities are bounded', () => {
  assert.throws(
    () => bindRecords(template, records(), bindings, { maxRecords: 2 }),
    code('capacity'),
  );
  assert.throws(() => bindRecords(template, [], bindings, { maxSlots: 3 }), code('capacity'));
  assert.throws(
    () => bindRecords(template, records(), bindings, { maxStringLength: 4 }),
    code('capacity'),
  );
  for (const options of [
    null,
    [],
    { maxRecords: 0 },
    { maxRecords: null },
    { maxSlots: Infinity },
    { maxStringLength: 65537 },
  ])
    assert.throws(() => bindRecords(template, [], [], options), code('invalid'));
});

test('prototype-sensitive columns and slots remain data without pollution', () => {
  const result = bindRecords(
    { slots: [{ id: '__proto__', kind: 'text' }] },
    [{ id: 'a', values: JSON.parse('{"__proto__":"safe"}') }],
    [{ column: '__proto__', slot: '__proto__' }],
  );
  assert.equal(Object.hasOwn(result[0].slots, '__proto__'), true);
  assert.equal(result[0].slots.__proto__, 'safe');
  assert.equal({}.safe, undefined);
});

test('sequential export emits actual bytes in record order and never overlaps', async () => {
  let active = 0;
  const calls = [];
  const result = await runBulkDesign(template, records(), bindings, async (design, index) => {
    active++;
    assert.equal(active, 1);
    calls.push([design.recordId, index]);
    await Promise.resolve();
    active--;
    return output(design);
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, [
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
  assert.deepEqual(
    result.successes.map((entry) => new TextDecoder().decode(entry.output.data)),
    ['Alice', 'Bob', 'Carol'],
  );
  assert.equal(result.attempted, 3);
  assert.equal(result.total, 3);
});

test('all records validate before any exporter side effect', async () => {
  let calls = 0;
  const source = records();
  source[2].values.name = 99;
  await assert.rejects(
    runBulkDesign(template, source, bindings, async (design) => {
      calls++;
      return output(design);
    }),
    code('invalid'),
  );
  assert.equal(calls, 0);
});

test('default failure contract returns precise partial success and stops at failed record', async () => {
  const failure = new Error('renderer failed');
  const calls = [];
  const result = await runBulkDesign(template, records(), bindings, async (design, index) => {
    calls.push(design.recordId);
    if (index === 1) throw failure;
    return output(design);
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(
    result.successes.map((item) => item.recordId),
    ['a'],
  );
  assert.deepEqual(result.failures, [{ index: 1, recordId: 'b', error: failure }]);
  assert.equal(result.attempted, 2);
  assert.equal(result.total, 3);
});

test('continueOnError preserves failures and processes later records', async () => {
  const result = await runBulkDesign(
    template,
    records(),
    bindings,
    async (design, index) => {
      if (index === 1) throw 'failure';
      return output(design);
    },
    { continueOnError: true },
  );
  assert.equal(result.status, 'failed');
  assert.deepEqual(
    result.successes.map((item) => item.recordId),
    ['a', 'c'],
  );
  assert.equal(result.failures[0].index, 1);
  assert.equal(result.attempted, 3);
});

test('invalid adapter outputs become per-record failures with output/capacity codes', async () => {
  for (const invalid of [
    null,
    { ...output({ recordId: 'a', slots: { title: 'A' } }), fileName: '../a.txt' },
    { fileName: 'a.txt', mediaType: 'TEXT/plain', data: new Uint8Array([1]) },
    { fileName: 'a.txt', mediaType: 'text/plain', data: [] },
    { fileName: 'a.txt', mediaType: 'text/plain', data: new Uint8Array() },
  ]) {
    const result = await runBulkDesign(template, records(), bindings, async () => invalid);
    assert.equal(result.status, 'failed');
    assert.equal(result.failures[0].error.code, 'output');
    assert.equal(result.attempted, 1);
  }
  const oversized = await runBulkDesign(
    template,
    records(),
    bindings,
    async (design) => output(design),
    { maxOutputBytes: 1 },
  );
  assert.equal(oversized.failures[0].error.code, 'capacity');
});

test('cancel while adapter is pending omits in-flight output and never starts next record', async () => {
  const wait = deferred();
  const controller = new AbortController();
  const calls = [];
  const pending = runBulkDesign(
    template,
    records(),
    bindings,
    async (design, index, signal) => {
      calls.push(design.recordId);
      assert.equal(signal, controller.signal);
      if (index === 1) await wait.promise;
      return output(design);
    },
    { signal: controller.signal },
  );
  await Promise.resolve();
  assert.deepEqual(calls, ['a', 'b']);
  controller.abort();
  wait.resolve();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(
    result.successes.map((entry) => entry.recordId),
    ['a'],
  );
  assert.equal(result.failures.length, 0);
  assert.equal(result.attempted, 2);
  assert.equal(result.total, 3);
});

test('abort takes precedence over in-flight rejection and pre-abort attempts nothing', async () => {
  const wait = deferred();
  const controller = new AbortController();
  const pending = runBulkDesign(template, records(), bindings, () => wait.promise, {
    signal: controller.signal,
  });
  controller.abort();
  wait.reject(new Error('aborted render'));
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.failures.length, 0);
  const pre = await runBulkDesign(
    template,
    records(),
    bindings,
    async () => {
      throw new Error('never called');
    },
    { signal: controller.signal },
  );
  assert.equal(pre.attempted, 0);
});

test('caller mutation during export does not alter later bound designs; bytes are copied', async () => {
  const source = records();
  const wait = deferred();
  const bytes = new Uint8Array([65]);
  const pending = runBulkDesign(template, source, bindings, async (design, index) => {
    if (index === 0) {
      await wait.promise;
      return { fileName: 'a.txt', mediaType: 'text/plain', data: bytes };
    }
    return output(design);
  });
  source[1].values.name = 'Changed';
  wait.resolve();
  const result = await pending;
  bytes[0] = 90;
  assert.equal(result.successes[0].output.data[0], 65);
  assert.equal(new TextDecoder().decode(result.successes[1].output.data), 'Bob');
});

test('empty records complete; malformed run settings reject before exporting', async () => {
  assert.equal(
    (await runBulkDesign(template, [], bindings, async (design) => output(design))).status,
    'completed',
  );
  for (const options of [{ continueOnError: 1 }, { signal: {} }, { maxOutputBytes: 0 }])
    await assert.rejects(
      runBulkDesign(template, [], bindings, async (design) => output(design), options),
      code('invalid'),
    );
  await assert.rejects(runBulkDesign(template, [], bindings, null), code('invalid'));
});

test('Node Buffer output is copied without retaining a shared view', async () => {
  const data = Buffer.from([65, 66]);
  const result = await runBulkDesign(template, [records()[0]], bindings, async () => ({
    fileName: 'a.txt',
    mediaType: 'text/plain',
    data,
  }));
  data[0] = 90;
  assert.equal(result.successes[0].output.data[0], 65);
  result.successes[0].output.data[1] = 91;
  assert.equal(data[1], 66);
});

test('failure policy is captured and cannot be changed during an in-flight export', async () => {
  const wait = deferred();
  const options = { continueOnError: false };
  let calls = 0;
  const pending = runBulkDesign(
    template,
    records(),
    bindings,
    async () => {
      calls++;
      await wait.promise;
      throw new Error('failed');
    },
    options,
  );
  options.continueOnError = true;
  wait.resolve();
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.attempted, 1);
  assert.equal(calls, 1);
});

test('standalone CJS exports equivalent binding and run APIs', () => {
  const cjs = createRequire(import.meta.url)('../dist/cjs/index.js');
  assert.deepEqual(Object.keys(cjs).sort(), ['BulkDesignError', 'bindRecords', 'runBulkDesign']);
  assert.deepEqual(
    cjs.bindRecords(template, records(), bindings),
    bindRecords(template, records(), bindings),
  );
});
