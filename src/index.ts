/**
 * 公開の入口。
 */
import { parse } from 'yaml';
import { evaluate, type EvaluateOptions } from './eval.js';
import type { Value } from './types.js';

export { evaluate, type EvaluateOptions } from './eval.js';
export { EffectfulYamlError, type Value } from './types.js';

/** YAML 文字列をパースして評価する薄いヘルパー。 */
export async function evaluateYaml(source: string, options?: EvaluateOptions): Promise<Value> {
  return evaluate(parse(source), options);
}
