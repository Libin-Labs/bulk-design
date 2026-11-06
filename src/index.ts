export type SlotValue = string | number | boolean;
export interface DesignSlot {
  readonly id: string;
  readonly kind: 'text' | 'number' | 'boolean';
  readonly required?: boolean;
  readonly default?: SlotValue;
}
export interface BulkTemplate {
  readonly slots: readonly DesignSlot[];
}
export interface BulkRecord {
  readonly id: string;
  readonly values: Readonly<Record<string, SlotValue>>;
}
export interface SlotBinding {
  readonly column: string;
  readonly slot: string;
}
export interface BoundDesign {
  readonly recordId: string;
  readonly slots: Readonly<Record<string, SlotValue>>;
}
export interface BulkOutput {
  readonly fileName: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}
export type BulkExporter = (
  design: BoundDesign,
  index: number,
  signal?: AbortSignal,
) => Promise<BulkOutput>;
export interface BulkLimits {
  readonly maxRecords?: number;
  readonly maxSlots?: number;
  readonly maxStringLength?: number;
}
export interface BulkOptions extends BulkLimits {
  readonly maxOutputBytes?: number;
  readonly continueOnError?: boolean;
  readonly signal?: AbortSignal;
}
export interface BulkSuccess {
  readonly index: number;
  readonly recordId: string;
  readonly output: BulkOutput;
}
export interface BulkFailure {
  readonly index: number;
  readonly recordId: string;
  readonly error: unknown;
}
export interface BulkResult {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly successes: readonly BulkSuccess[];
  readonly failures: readonly BulkFailure[];
  readonly attempted: number;
  readonly total: number;
}
export class BulkDesignError extends Error {
  constructor(
    readonly code: 'invalid' | 'capacity' | 'output',
    message: string,
  ) {
    super(message);
    this.name = 'BulkDesignError';
  }
}
function identifier(value: string, name: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new BulkDesignError(
      'invalid',
      `${name} must be nonempty text up to 128 characters without controls.`,
    );
  return value;
}
function integer(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new BulkDesignError('invalid', `${name} must be an integer in 1..${maximum}.`);
  return value;
}
function scalar(value: unknown, maxStringLength: number): SlotValue {
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return value;
  if (typeof value === 'string') {
    if (value.length > maxStringLength)
      throw new BulkDesignError('capacity', 'String exceeds maxStringLength.');
    return value;
  }
  throw new BulkDesignError(
    'invalid',
    'Record values and defaults must be strings, finite numbers or booleans.',
  );
}
function matches(value: SlotValue, slot: DesignSlot): void {
  const expected = slot.kind === 'text' ? 'string' : slot.kind;
  if (typeof value !== expected)
    throw new BulkDesignError('invalid', `Slot ${slot.id} requires ${slot.kind}.`);
}
function recordValues(
  value: unknown,
  maxSlots: number,
  maxStringLength: number,
): Readonly<Record<string, SlotValue>> {
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new BulkDesignError('invalid', 'values must be a plain record.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxSlots)
    throw new BulkDesignError('capacity', 'Record column capacity exceeded.');
  const copy: Record<string, SlotValue> = {};
  for (const key of keys) {
    if (typeof key !== 'string')
      throw new BulkDesignError('invalid', 'Column keys must be strings.');
    identifier(key, 'Column');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new BulkDesignError('invalid', 'Columns must be enumerable data properties.');
    Object.defineProperty(copy, key, {
      value: scalar(descriptor.value, maxStringLength),
      enumerable: true,
    });
  }
  return Object.freeze(copy);
}

export function bindRecords(
  template: BulkTemplate,
  records: readonly BulkRecord[],
  bindings: readonly SlotBinding[],
  options: BulkLimits = {},
): readonly BoundDesign[] {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new BulkDesignError('invalid', 'Options must be an object.');
  const maxRecords = integer(
    options.maxRecords === undefined ? 100 : options.maxRecords,
    'maxRecords',
    1000,
  );
  const maxSlots = integer(
    options.maxSlots === undefined ? 100 : options.maxSlots,
    'maxSlots',
    1000,
  );
  const maxStringLength = integer(
    options.maxStringLength === undefined ? 4096 : options.maxStringLength,
    'maxStringLength',
    65_536,
  );
  if (
    !template ||
    !Array.isArray(template.slots) ||
    !Array.isArray(records) ||
    !Array.isArray(bindings)
  )
    throw new BulkDesignError('invalid', 'Template slots, records and bindings must be arrays.');
  if (template.slots.length === 0)
    throw new BulkDesignError('invalid', 'Template must define at least one slot.');
  if (template.slots.length > maxSlots || bindings.length > maxSlots || records.length > maxRecords)
    throw new BulkDesignError('capacity', 'Record, binding or slot capacity exceeded.');
  const slots = new Map<string, DesignSlot>();
  for (const slot of template.slots) {
    if (!slot || typeof slot !== 'object')
      throw new BulkDesignError('invalid', 'Slot must be an object.');
    const id = identifier(slot.id, 'Slot ID');
    if (slots.has(id) || !['text', 'number', 'boolean'].includes(slot.kind))
      throw new BulkDesignError('invalid', 'Slots must be unique and use a supported kind.');
    if (slot.required !== undefined && typeof slot.required !== 'boolean')
      throw new BulkDesignError('invalid', 'required must be a boolean.');
    const normalized: DesignSlot = Object.freeze({
      id,
      kind: slot.kind,
      required: slot.required ?? false,
      ...(Object.hasOwn(slot, 'default') ? { default: scalar(slot.default, maxStringLength) } : {}),
    });
    if (normalized.default !== undefined) matches(normalized.default, normalized);
    slots.set(id, normalized);
  }
  const mapping = new Map<string, string>();
  const columns = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object')
      throw new BulkDesignError('invalid', 'Binding must be an object.');
    const slot = identifier(binding.slot, 'Binding slot');
    const column = identifier(binding.column, 'Binding column');
    if (!slots.has(slot) || mapping.has(slot) || columns.has(column))
      throw new BulkDesignError(
        'invalid',
        'Bindings must reference known slots with unique target slots and source columns.',
      );
    mapping.set(slot, column);
    columns.add(column);
  }
  const ids = new Set<string>();
  const designs: BoundDesign[] = [];
  for (const record of records) {
    if (!record || typeof record !== 'object')
      throw new BulkDesignError('invalid', 'Record must be an object.');
    const id = identifier(record.id, 'Record ID');
    if (ids.has(id)) throw new BulkDesignError('invalid', 'Record IDs must be unique.');
    ids.add(id);
    const values = recordValues(record.values, maxSlots, maxStringLength);
    for (const key of Object.keys(values))
      if (!columns.has(key)) throw new BulkDesignError('invalid', `Unbound column ${key}.`);
    const bound: Record<string, SlotValue> = {};
    for (const slot of slots.values()) {
      const column = mapping.get(slot.id);
      const present = column !== undefined && Object.hasOwn(values, column);
      const value = present ? values[column] : slot.default;
      if (value === undefined) {
        if (slot.required)
          throw new BulkDesignError('invalid', `Record ${id} is missing required slot ${slot.id}.`);
        continue;
      }
      matches(value, slot);
      Object.defineProperty(bound, slot.id, { value, enumerable: true });
    }
    designs.push(Object.freeze({ recordId: id, slots: Object.freeze(bound) }));
  }
  return Object.freeze(designs);
}
function normalizeOutput(output: BulkOutput, maxBytes: number): BulkOutput {
  if (!output || typeof output !== 'object')
    throw new BulkDesignError('output', 'Exporter must return an output object.');
  if (
    typeof output.fileName !== 'string' ||
    output.fileName.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(output.fileName) ||
    output.fileName.includes('..')
  )
    throw new BulkDesignError(
      'output',
      'fileName must be a safe basename of at most 128 characters.',
    );
  if (
    typeof output.mediaType !== 'string' ||
    output.mediaType.length > 128 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(output.mediaType)
  )
    throw new BulkDesignError(
      'output',
      'mediaType must be a lowercase MIME type without parameters.',
    );
  if (!(output.data instanceof Uint8Array) || output.data.byteLength === 0)
    throw new BulkDesignError('output', 'Output data must be nonempty Uint8Array bytes.');
  if (output.data.byteLength > maxBytes)
    throw new BulkDesignError('capacity', 'Output exceeds maxOutputBytes.');
  return Object.freeze({
    fileName: output.fileName,
    mediaType: output.mediaType,
    data: new Uint8Array(output.data),
  });
}
export async function runBulkDesign(
  template: BulkTemplate,
  records: readonly BulkRecord[],
  bindings: readonly SlotBinding[],
  exporter: BulkExporter,
  options: BulkOptions = {},
): Promise<BulkResult> {
  const designs = bindRecords(template, records, bindings, options);
  if (typeof exporter !== 'function')
    throw new BulkDesignError('invalid', 'An exporter function is required.');
  const maxBytes = integer(
    options.maxOutputBytes === undefined ? 1_048_576 : options.maxOutputBytes,
    'maxOutputBytes',
    16_777_216,
  );
  if (options.continueOnError !== undefined && typeof options.continueOnError !== 'boolean')
    throw new BulkDesignError('invalid', 'continueOnError must be boolean.');
  const continueOnError = options.continueOnError ?? false;
  const signal = options.signal;
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function')
  )
    throw new BulkDesignError('invalid', 'signal must be an AbortSignal.');
  const successes: BulkSuccess[] = [];
  const failures: BulkFailure[] = [];
  let attempted = 0;
  const finish = (status: BulkResult['status']): BulkResult =>
    Object.freeze({
      status,
      successes: Object.freeze(successes),
      failures: Object.freeze(failures),
      attempted,
      total: designs.length,
    });
  for (let index = 0; index < designs.length; index++) {
    if (signal?.aborted) return finish('cancelled');
    const design = designs[index]!;
    attempted++;
    try {
      const raw = await exporter(design, index, signal);
      if (signal?.aborted) return finish('cancelled');
      const output = normalizeOutput(raw, maxBytes);
      successes.push(Object.freeze({ index, recordId: design.recordId, output }));
    } catch (error) {
      if (signal?.aborted) return finish('cancelled');
      failures.push(Object.freeze({ index, recordId: design.recordId, error }));
      if (!continueOnError) return finish('failed');
    }
  }
  if (signal?.aborted) return finish('cancelled');
  return finish(failures.length > 0 ? 'failed' : 'completed');
}
