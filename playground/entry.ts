/**
 * サイト用バンドルのエントリ。ここから esbuild が site/effectful-yaml.js を作る。
 */
export { evaluateYaml, EffectfulYamlError, OperationFailure } from '../src/index.js';
export { parse, stringify } from 'yaml';

import hljs from 'highlight.js/lib/core';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('yaml', (api) => {
  const language = yaml(api);
  // highlight.js の YAML はキーの先頭を英数字と * @ に限るので、`$` で始まるキーもキーとして色付ける。
  const key = language.contains!.find((mode) => mode.className === 'attr')!;
  key.variants![0]!.begin = /[\w*@$][\w*@ :()\./-]*:(?=[ \t]|$)/;
  return language;
});

/** YAML をハイライト済みの（エスケープ済み）HTML にする。 */
export const highlightYaml = (source: string): string =>
  hljs.highlight(source, { language: 'yaml' }).value;
