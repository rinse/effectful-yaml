import { describe, expect, it } from 'vitest';
import { evalExpr, hasPathRef, interpolate, MissingPathError } from '../src/expr.js';
import { EffectfulYamlError, emptyEnv, extendEnv, type Env, type Value } from '../src/types.js';

function envOf(vars: Record<string, Value>): Env {
  let env = emptyEnv;
  for (const [k, v] of Object.entries(vars)) {
    env = extendEnv(env, k, v);
  }
  return env;
}

describe('evalExpr: literals', () => {
  it('evaluates numbers, strings, booleans, null', () => {
    expect(evalExpr('42', emptyEnv)).toBe(42);
    expect(evalExpr('3.14', emptyEnv)).toBe(3.14);
    expect(evalExpr("'hello'", emptyEnv)).toBe('hello');
    expect(evalExpr('true', emptyEnv)).toBe(true);
    expect(evalExpr('false', emptyEnv)).toBe(false);
    expect(evalExpr('null', emptyEnv)).toBe(null);
  });

  it('supports string escapes for quote and backslash', () => {
    expect(evalExpr("'it\\'s'", emptyEnv)).toBe("it's");
    expect(evalExpr("'back\\\\slash'", emptyEnv)).toBe('back\\slash');
  });
});

describe('evalExpr: arithmetic', () => {
  it('computes +, -, *, /, %', () => {
    expect(evalExpr('1 + 2', emptyEnv)).toBe(3);
    expect(evalExpr('5 - 2', emptyEnv)).toBe(3);
    expect(evalExpr('3 * 4', emptyEnv)).toBe(12);
    expect(evalExpr('7 / 2', emptyEnv)).toBe(3.5);
    expect(evalExpr('7 % 2', emptyEnv)).toBe(1);
  });

  it('respects precedence and parens', () => {
    expect(evalExpr('1 + 2 * 3', emptyEnv)).toBe(7);
    expect(evalExpr('(1 + 2) * 3', emptyEnv)).toBe(9);
  });

  it('errors on division and modulo by zero', () => {
    expect(() => evalExpr('1 / 0', emptyEnv)).toThrow(EffectfulYamlError);
    expect(() => evalExpr('1 % 0', emptyEnv)).toThrow(EffectfulYamlError);
  });

  it('errors when operands are not numbers', () => {
    expect(() => evalExpr("'a' + 1", emptyEnv)).toThrow(EffectfulYamlError);
    expect(() => evalExpr("1 * 'a'", emptyEnv)).toThrow(EffectfulYamlError);
  });
});

describe('evalExpr: comparison', () => {
  it('compares numbers', () => {
    expect(evalExpr('1 < 2', emptyEnv)).toBe(true);
    expect(evalExpr('2 <= 2', emptyEnv)).toBe(true);
    expect(evalExpr('3 > 2', emptyEnv)).toBe(true);
    expect(evalExpr('3 >= 4', emptyEnv)).toBe(false);
  });

  it('errors comparing non-numbers with < <= > >=', () => {
    expect(() => evalExpr("'a' < 'b'", emptyEnv)).toThrow(EffectfulYamlError);
    expect(() => evalExpr('true > false', emptyEnv)).toThrow(EffectfulYamlError);
  });

  it('== and != are structural, including across mismatched types', () => {
    expect(evalExpr("1 == '1'", emptyEnv)).toBe(false);
    expect(evalExpr("1 != '1'", emptyEnv)).toBe(true);
    expect(evalExpr('1 == 1', emptyEnv)).toBe(true);
    expect(evalExpr("'x' == 'x'", emptyEnv)).toBe(true);
  });

  it('== and != deep-compare lists and mappings', () => {
    const env = envOf({
      xs: [1, 2, { a: 1 }],
      ys: [1, 2, { a: 1 }],
      zs: [1, 2, { a: 2 }],
      m1: { a: 1, b: [1, 2] },
      m2: { b: [1, 2], a: 1 },
    });
    expect(evalExpr('xs == ys', env)).toBe(true);
    expect(evalExpr('xs == zs', env)).toBe(false);
    expect(evalExpr('xs != zs', env)).toBe(true);
    expect(evalExpr('m1 == m2', env)).toBe(true);
  });
});

describe('evalExpr: logical operators', () => {
  it('evaluates && || !', () => {
    expect(evalExpr('true && false', emptyEnv)).toBe(false);
    expect(evalExpr('true && true', emptyEnv)).toBe(true);
    expect(evalExpr('false || true', emptyEnv)).toBe(true);
    expect(evalExpr('false || false', emptyEnv)).toBe(false);
    expect(evalExpr('!true', emptyEnv)).toBe(false);
    expect(evalExpr('!false', emptyEnv)).toBe(true);
  });

  it('short-circuits && and ||', () => {
    // right side would throw (division by zero / undefined ref) if evaluated
    expect(evalExpr('false && (1 / 0 > 0)', emptyEnv)).toBe(false);
    expect(evalExpr('true || (1 / 0 > 0)', emptyEnv)).toBe(true);
  });

  it('errors when operands are not booleans', () => {
    expect(() => evalExpr("1 && true", emptyEnv)).toThrow(EffectfulYamlError);
    expect(() => evalExpr("'a' || false", emptyEnv)).toThrow(EffectfulYamlError);
    expect(() => evalExpr('!1', emptyEnv)).toThrow(EffectfulYamlError);
    // right side type errors still surface once left side requires evaluation
    expect(() => evalExpr('true && 1', emptyEnv)).toThrow(EffectfulYamlError);
  });
});

describe('evalExpr: references and paths', () => {
  it('looks up a bound name', () => {
    expect(evalExpr('x', envOf({ x: 5 }))).toBe(5);
  });

  it('errors on undefined names', () => {
    expect(() => evalExpr('nope', emptyEnv)).toThrow(EffectfulYamlError);
  });

  it('resolves .name mapping keys and [n] list indices, including chains', () => {
    const env = envOf({
      obj: { a: { b: [10, 20, { c: 'deep' }] } },
    });
    expect(evalExpr('obj.a.b[0]', env)).toBe(10);
    expect(evalExpr('obj.a.b[2].c', env)).toBe('deep');
  });

  it('missing keys and out-of-range indices are MissingPathError (the evaluator turns them into std.fail)', () => {
    const env = envOf({ obj: { a: 1 }, xs: [1, 2] });
    expect(() => evalExpr('obj.missing', env)).toThrow(MissingPathError);
    expect(() => evalExpr('xs[5]', env)).toThrow(MissingPathError);
  });

  it('walking a non-container is a hard error, not data partiality', () => {
    const env = envOf({ obj: { a: 1 }, xs: [1, 2] });
    for (const src of ['obj[0]', 'xs.a']) {
      expect(() => evalExpr(src, env)).toThrow(EffectfulYamlError);
      expect(() => evalExpr(src, env)).not.toThrow(MissingPathError);
    }
  });
});

describe('hasPathRef（作用の推論が std.fail を数える条件）', () => {
  it('パスをたどる参照だけを見つける', () => {
    expect(hasPathRef('${x.y}')).toBe(true);
    expect(hasPathRef('${xs[0]}')).toBe(true);
    expect(hasPathRef('prefix ${a + b.c} suffix')).toBe(true);
  });

  it('裸の参照・補間なし・パースできない文字列は数えない', () => {
    expect(hasPathRef('${x}')).toBe(false);
    expect(hasPathRef('${x + 1}')).toBe(false);
    expect(hasPathRef('plain text')).toBe(false);
    expect(hasPathRef('costs $$5')).toBe(false);
    expect(hasPathRef('${')).toBe(false);
    expect(hasPathRef('${!!!}')).toBe(false);
  });
});

describe('interpolate', () => {
  it('returns the value as-is (any type) when the whole scalar is one ${expr}', () => {
    expect(interpolate('${x}', envOf({ x: 5 }))).toBe(5);
    expect(interpolate('${x}', envOf({ x: true }))).toBe(true);
    expect(interpolate('${x}', envOf({ x: [1, 2, 3] }))).toEqual([1, 2, 3]);
    expect(interpolate('${x}', envOf({ x: { a: 1 } }))).toEqual({ a: 1 });
    expect(interpolate('${x}', envOf({ x: null }))).toBe(null);
  });

  it('stringifies embedded expressions for partial interpolation', () => {
    expect(interpolate('item-${n}', envOf({ n: 3 }))).toBe('item-3');
    expect(interpolate('${a}${b}', envOf({ a: 'foo', b: 'bar' }))).toBe('foobar');
    expect(interpolate('flag=${b}', envOf({ b: true }))).toBe('flag=true');
  });

  it('returns plain strings unchanged when there is no interpolation', () => {
    expect(interpolate('just a plain string', emptyEnv)).toBe('just a plain string');
  });

  it('errors stringifying lists, mappings, and null in partial interpolation', () => {
    expect(() => interpolate('x=${xs}!', envOf({ xs: [1, 2] }))).toThrow(EffectfulYamlError);
    expect(() => interpolate('x=${m}!', envOf({ m: { a: 1 } }))).toThrow(EffectfulYamlError);
    expect(() => interpolate('x=${n}!', envOf({ n: null }))).toThrow(EffectfulYamlError);
  });

  it('handles $$ escaping to a literal $, including multiple occurrences', () => {
    expect(interpolate('costs $$5', emptyEnv)).toBe('costs $5');
    expect(interpolate('$$5 and $$10', emptyEnv)).toBe('$5 and $10');
    expect(interpolate('$$${x}', envOf({ x: 1 }))).toBe('$1');
  });

  it('leaves $${x} as a literal string per the left-to-right scan rule', () => {
    expect(interpolate('$${x}', envOf({ x: 1 }))).toBe('${x}');
  });
});
