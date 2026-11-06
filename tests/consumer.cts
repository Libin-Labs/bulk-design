import { bindRecords, runBulkDesign, BulkDesignError } from '@lp-labs/bulk-design';
import type {
  SlotValue,
  DesignSlot,
  BulkTemplate,
  BulkRecord,
  SlotBinding,
  BoundDesign,
  BulkOutput,
  BulkExporter,
  BulkLimits,
  BulkOptions,
  BulkSuccess,
  BulkFailure,
  BulkResult,
} from '@lp-labs/bulk-design';
const value: SlotValue = 'A';
const slot: DesignSlot = { id: 'title', kind: 'text', required: true };
const template: BulkTemplate = { slots: [slot] };
const record: BulkRecord = { id: 'a', values: { name: value } };
const binding: SlotBinding = { column: 'name', slot: 'title' };
const limits: BulkLimits = { maxRecords: 10 };
const bound: readonly BoundDesign[] = bindRecords(template, [record], [binding], limits);
const output: BulkOutput = {
  fileName: 'a.txt',
  mediaType: 'text/plain',
  data: new Uint8Array([65]),
};
const exporter: BulkExporter = async () => output;
const options: BulkOptions = { ...limits, continueOnError: true };
const result: Promise<BulkResult> = runBulkDesign(template, [record], [binding], exporter, options);
const success: BulkSuccess = { index: 0, recordId: 'a', output };
const failure: BulkFailure = { index: 0, recordId: 'a', error: new Error('failed') };
void [bound, result, success, failure, new BulkDesignError('output', 'bad output')];
// @ts-expect-error records do not accept arbitrary JSON objects
const invalid: SlotValue = {};
void invalid;
