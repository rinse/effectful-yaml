/**
 * 関数値の流れの検査（0CFA 流のフロー解析）と、演算の事前検査。
 * 仕様: docs/grammar.md（草案 0.8）「関数値の流れと停止性」「演算」。
 *
 * 閉包を作るのは文書内の `$fn` だけである（パラメータとホスト演算の結果は常にデータ）。
 * したがって文書の有限個の `$fn` を抽象閉包とするフロー解析は、追跡不能を持たない全域の解析になる。
 * 各構文を一度だけ走査して「どのセルにどの閉包が流れうるか」の制約を組み立て、
 * ワークリストで不動点まで伝播させ、`$fn` の間の到達グラフに循環があれば評価前にエラーにする。
 *
 * 走査は演算のサイトも余さず数えるので、文書の作用シグネチャ（要求するハンドラの一覧）も
 * ここで得られる。実装の要る演算が供給されていない文書は、同じ走査の結果から拒否する。
 *
 * データは追わない（Data の原子は持たず、閉包を運びうる原子だけをセルに入れる）。
 * 出現主義：$if の選ばれない側や $default の中の適用も数える。
 * エラーの位置は評価時の位置と違い、`$` 式の内側へも降りる構文上の位置で報告する。
 */
import { refPathOf } from './expr.js';
import {
  fnParamsOf,
  localDeclsOf,
  mappingShapeOfNode,
  statementFormOf,
  unescapeDollar,
  unhandledOpMessage,
} from './forms.js';
import { empty, get, insert, type PMap } from './pmap.js';
import { BUILTIN_OPS, EffectfulYamlError } from './types.js';

type NodeMap = Record<string, unknown>;
const isNodeMap = (n: unknown): n is NodeMap =>
  typeof n === 'object' && n !== null && !Array.isArray(n);

// ---------------------------------------------------------------------------
// 原子とセル
// ---------------------------------------------------------------------------

/**
 * セルに入る原子。Data は原子にしない（閉包を運べない値は流れに参加しない）。
 * - clo: `$fn` ノード f のカリー化第 stage 段の閉包。blessed は $resume の結果から出た
 *   継続由来の印（ハンドラの畳み込みで停止が保証される適用を、循環の辺から除くため）。
 * - struct: リテラルのマッピング・リスト。フィールドごとのセルを持つ（キーの精度を保つ）。
 * - soup: 中身のキーが静的に分からない容れ物（ハンドラの値のリストなど）。要素は一つのセルに合流する。
 */
type Atom =
  | { readonly kind: 'clo'; readonly fn: FnInfo; readonly stage: number; readonly blessed: boolean }
  | {
      readonly kind: 'struct';
      readonly source: 'list' | 'mapping';
      readonly fields: ReadonlyMap<string, Cell>;
    }
  | { readonly kind: 'soup'; readonly elems: Cell };

interface Cell {
  readonly atoms: Set<Atom>;
  readonly succs: Set<Cell>;
  readonly listeners: ((a: Atom) => void)[];
}

/** 文書内の一つの `$fn`。カリー化の全段のパラメータセルと、本体の値（Cod）のセルを持つ。 */
interface FnInfo {
  readonly params: readonly string[];
  readonly defPath: string;
  readonly paramCells: readonly Cell[];
  readonly cod: Cell;
  /** 到達グラフの辺（この $fn から見えている $fn）。検査の対象。 */
  readonly edges: Set<FnInfo>;
  /** (stage, blessed) ごとに一意な閉包原子。原子の同一性で伝播の重複を除くため intern する。 */
  readonly stageAtoms: Map<number, Atom>;
}

type Scope = PMap<Cell>;

/** $resume が見える文脈（ハンドラの節の本体）。opName は節の演算名、res はハンドラの値のセル。 */
interface ResumeCtx {
  readonly opName: string;
  readonly res: Cell;
}

const childPath = (p: string, key: string): string => (p === '' ? key : `${p}.${key}`);

// ---------------------------------------------------------------------------
// 検査器
// ---------------------------------------------------------------------------

class Checker {
  private readonly fns = new Map<object, { info: FnInfo; cell: Cell }>();
  private readonly argPools = new Map<string, Cell>();
  private readonly resumePools = new Map<string, Cell>();
  /** 既定ハンドラの状態セルへ書かれうる値の合流先（std.set の引数のフィールド値、$std.state の初期値）。 */
  private readonly stateSoup = this.cell();
  /** 文書のどこかに節として現れる演算名。ホスト演算の引数検査の除外に使う。 */
  private readonly clauseNames = new Set<string>();
  /** 今どの `$fn` の本体を走査しているか。適用と演算の位置をその $fn の辺に数えるため。 */
  private currentFn: FnInfo | undefined;
  private currentResume: ResumeCtx | undefined;

  // --- 伝播の機構。add がためて drain がほどくので、深さは文書に依存しない。 ---

  private readonly pending: { cell: Cell; atom: Atom }[] = [];
  private draining = false;

  private cell(): Cell {
    return { atoms: new Set(), succs: new Set(), listeners: [] };
  }

  private add(cell: Cell, atom: Atom): void {
    if (cell.atoms.has(atom)) return;
    cell.atoms.add(atom);
    this.pending.push({ cell, atom });
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    while (this.pending.length > 0) {
      const { cell, atom } = this.pending.pop()!;
      for (const s of cell.succs) this.add(s, atom);
      for (const l of cell.listeners) l(atom);
    }
    this.draining = false;
  }

  /** 部分集合の辺 from ⊆ to。既存の原子は即座に流し込む。 */
  private flow(from: Cell, to: Cell): void {
    if (from === to || from.succs.has(to)) return;
    from.succs.add(to);
    for (const a of [...from.atoms]) this.add(to, a);
  }

  /** 原子が届くたびに呼ばれる制約。既存の原子にも即座に発火する。 */
  private listen(cell: Cell, f: (a: Atom) => void): void {
    cell.listeners.push(f);
    for (const a of [...cell.atoms]) f(a);
  }

  /**
   * セルから struct のフィールドと soup の要素を透過的にたどり、到達しうる閉包原子ごとに cb を呼ぶ。
   * パラメータと演算の位置の「その $fn から見えている閉包」を集める。
   */
  private watchClosures(cell: Cell, cb: (a: Extract<Atom, { kind: 'clo' }>) => void): void {
    const visited = new Set<Cell>();
    const walk = (c: Cell): void => {
      if (visited.has(c)) return;
      visited.add(c);
      this.listen(c, (a) => {
        if (a.kind === 'clo') cb(a);
        else if (a.kind === 'struct') for (const f of a.fields.values()) walk(f);
        else walk(a.elems);
      });
    };
    walk(cell);
  }

  private argPool(name: string): Cell {
    let c = this.argPools.get(name);
    if (c === undefined) {
      c = this.cell();
      this.argPools.set(name, c);
    }
    return c;
  }

  private resumePool(name: string): Cell {
    let c = this.resumePools.get(name);
    if (c === undefined) {
      c = this.cell();
      this.resumePools.set(name, c);
    }
    return c;
  }

  private stageAtom(fn: FnInfo, stage: number, blessed: boolean): Atom {
    const key = stage * 2 + (blessed ? 1 : 0);
    let a = fn.stageAtoms.get(key);
    if (a === undefined) {
      a = { kind: 'clo', fn, stage, blessed };
      fn.stageAtoms.set(key, a);
    }
    return a;
  }

  // --- フローの組み立て子 ---

  /** マッピングのキーアクセス一段。struct はフィールド、soup は要素、閉包とデータは行き止まり。 */
  private project(cell: Cell, seg: string): Cell {
    const out = this.cell();
    this.listen(cell, (a) => {
      if (a.kind === 'struct') {
        const f = a.fields.get(seg);
        if (f !== undefined) this.flow(f, out);
      } else if (a.kind === 'soup') {
        this.flow(a.elems, out);
      }
    });
    return out;
  }

  /**
   * 構造を回る形（$std.each の分岐、$collect の対象）の要素を out へ流す。
   * マッピングは {key, value} のエントリに分解される（eval.ts の entriesOf と同じ規則）ので、
   * value にフィールド値を合流させたエントリの struct を合成する。soup は両様に読む。
   */
  private elemsInto(cell: Cell, out: Cell): void {
    this.listen(cell, (a) => {
      if (a.kind === 'struct') {
        if (a.source === 'list') {
          for (const f of a.fields.values()) this.flow(f, out);
        } else {
          const values = this.cell();
          for (const f of a.fields.values()) this.flow(f, values);
          this.add(out, this.entryAtom(values));
        }
      } else if (a.kind === 'soup') {
        this.flow(a.elems, out);
        this.add(out, this.entryAtom(a.elems));
      }
    });
  }

  private entryAtom(values: Cell): Atom {
    return {
      kind: 'struct',
      source: 'mapping',
      fields: new Map([
        ['key', this.cell()],
        ['value', values],
      ]),
    };
  }

  /** 既定ハンドラの状態セルへの書き込み（std.set の引数、$std.state の初期値）。フィールド値が書かれる。 */
  private writeState(cell: Cell): void {
    this.listen(cell, (a) => {
      if (a.kind === 'struct') for (const f of a.fields.values()) this.flow(f, this.stateSoup);
      else if (a.kind === 'soup') this.flow(a.elems, this.stateSoup);
    });
  }

  /**
   * 適用。呼び先に現れる各閉包へ引数を流し、結果（部分適用なら次の段、最終段なら Cod）を返す。
   * 継続由来（blessed）でない閉包を包囲する $fn の本体で適用したら、到達グラフの辺に数える。
   */
  private apply(calleeCell: Cell, argCell: Cell): Cell {
    const out = this.cell();
    const enclosing = this.currentFn;
    this.listen(calleeCell, (a) => {
      if (a.kind !== 'clo') return;
      if (enclosing !== undefined && !a.blessed) enclosing.edges.add(a.fn);
      this.flow(argCell, a.fn.paramCells[a.stage]!);
      if (a.stage + 1 < a.fn.params.length) {
        this.add(out, this.stageAtom(a.fn, a.stage + 1, a.blessed));
      } else {
        this.flow(a.fn.cod, out);
      }
    });
    return out;
  }

  /**
   * 演算のサイト。引数は名前ごとのプールへ（文書内の同名の節すべてに流れうる）、
   * 値は $resume で再開されうる値のプールを含む。std の既定の意味はサイトごとに足す。
   * サイトの値から到達しうる閉包（状態や再開経由で戻ってくるものを含む）は包囲する $fn の辺に数える。
   */
  private opSite(name: string, argCell: Cell): Cell {
    this.flow(argCell, this.argPool(name));
    const out = this.cell();
    this.flow(this.resumePool(name), out);
    if (name === 'std.each') this.elemsInto(argCell, out);
    else if (name === 'std.get') this.flow(this.stateSoup, out);
    else if (name === 'std.set') this.writeState(argCell);
    const enclosing = this.currentFn;
    if (enclosing !== undefined) {
      this.watchClosures(out, (a) => enclosing.edges.add(a.fn));
    }
    return out;
  }

  // --- 走査 ---

  /** ノードの値のセルを返す。すべての子を（実行されない分岐も）一度だけ走査する。 */
  walk(node: unknown, scope: Scope, path: string): Cell {
    if (typeof node === 'string') {
      const ref = refPathOf(node);
      if (ref === undefined) return this.cell(); // 演算子・補間の混在は閉包を運べない（実行時エラー）
      const [head, ...rest] = ref;
      let cur = get(scope, head!);
      if (cur === undefined) return this.cell(); // 未定義参照は評価時のエラーに任せる
      for (const seg of rest) cur = this.project(cur, seg);
      return cur;
    }
    if (node === null || node === undefined || typeof node !== 'object') return this.cell();
    if (Array.isArray(node)) {
      const fields = new Map<string, Cell>();
      for (let i = 0; i < node.length; i++) {
        fields.set(String(i), this.walk(node[i], scope, `${path}[${i}]`));
      }
      const out = this.cell();
      this.add(out, { kind: 'struct', source: 'list', fields });
      return out;
    }
    const map = node as NodeMap;
    const shape = mappingShapeOfNode(map);
    switch (shape.kind) {
      case 'plain': {
        const fields = new Map<string, Cell>();
        for (const [rawKey, child] of Object.entries(map)) {
          fields.set(unescapeDollar(rawKey), this.walk(child, scope, childPath(path, rawKey)));
        }
        const out = this.cell();
        this.add(out, { kind: 'struct', source: 'mapping', fields });
        return out;
      }
      case 'lexical': {
        const [head, ...rest] = shape.name.split('.');
        let callee = get(scope, head!) ?? this.cell();
        for (const seg of rest) callee = this.project(callee, seg);
        const arg = this.walk(map[shape.raw], scope, childPath(path, shape.raw));
        return this.apply(callee, arg);
      }
      case 'op':
        return this.operation(shape.name, map, shape.raw, shape.aux, scope, path);
      case 'reserved':
        return this.reserved(shape.main, map, shape.mainRaw, shape.aux, scope, path);
    }
  }

  private operation(
    name: string,
    node: NodeMap,
    raw: string,
    aux: ReadonlyMap<string, string>,
    scope: Scope,
    path: string,
  ): Cell {
    const argCell = this.walk(node[raw], scope, childPath(path, raw));
    const auxCell = (key: string): Cell | undefined => {
      const r = aux.get(key);
      return r === undefined ? undefined : this.walk(node[r], scope, childPath(path, r));
    };
    switch (name) {
      case 'std.list': {
        // 値は全分岐の結果のリスト。長さは静的に分からないので soup にする。
        const out = this.cell();
        this.add(out, { kind: 'soup', elems: argCell });
        return out;
      }
      case 'std.mapping': {
        // 値は {key, value} エントリを集めたマッピング。値の側だけが閉包を運びうる。
        const out = this.cell();
        this.add(out, { kind: 'soup', elems: this.project(argCell, 'value') });
        return out;
      }
      case 'std.first':
        return argCell; // 最初に成功した分岐の値そのもの
      case 'std.opt': {
        const out = this.cell();
        this.flow(argCell, out);
        const d = auxCell('default');
        if (d !== undefined) this.flow(d, out);
        return out;
      }
      case 'std.state': {
        this.writeState(argCell);
        const body = aux.get('in');
        if (body === undefined) return this.cell(); // 位置外の $in なしは評価器がエラーにする
        return this.walk(node[body], scope, childPath(path, body));
      }
      case 'std.param': {
        // パラメータは常にデータ。$default の値だけが流れうる。節（std.param）経由の再開も数える。
        const out = this.opSite(name, argCell);
        const d = auxCell('default');
        if (d !== undefined) this.flow(d, out);
        return out;
      }
      case 'std.where':
        // 導出形（偽なら空の std.each）。値は null かエラーで、閉包は運ばない。
        return this.opSite('std.each', this.cell());
      case 'std.lookup': {
        // 値は in のマッピングのどれかのキーの値。キーの精度は諦めて値の合併にする。
        const out = this.cell();
        this.fieldValuesInto(this.project(argCell, 'in'), out);
        return out;
      }
      case 'std.merge': {
        // 引数はマッピングのリスト。結果の値の集合は、各マッピングの値の合併の soup。
        const mappings = this.cell();
        this.elemsInto(argCell, mappings);
        const values = this.cell();
        this.fieldValuesInto(mappings, values);
        const out = this.cell();
        this.add(out, { kind: 'soup', elems: values });
        return out;
      }
      default:
        return this.opSite(name, argCell);
    }
  }

  /** マッピング（かもしれない値）のフィールド値をすべて out へ合流させる。 */
  private fieldValuesInto(cell: Cell, out: Cell): void {
    this.listen(cell, (a) => {
      if (a.kind === 'struct') for (const f of a.fields.values()) this.flow(f, out);
      else if (a.kind === 'soup') this.flow(a.elems, out);
    });
  }

  private reserved(
    main: string,
    node: NodeMap,
    mainRaw: string,
    aux: ReadonlyMap<string, string>,
    scope: Scope,
    path: string,
  ): Cell {
    const arg = node[mainRaw];
    const argPath = childPath(path, mainRaw);
    const auxRaw = (key: string): string | undefined => aux.get(key);
    switch (main) {
      case 'do': {
        if (!Array.isArray(arg)) return this.walk(arg, scope, argPath); // 形の誤りは評価器に任せる
        return this.statements(arg, scope, argPath);
      }
      case 'let': {
        const inRaw = auxRaw('in');
        const inner = this.letBind(arg, scope, argPath);
        if (inRaw === undefined) return this.cell(); // 位置外の $in なしは評価器がエラーにする
        return this.walk(node[inRaw], inner, childPath(path, inRaw));
      }
      case 'if': {
        this.walk(arg, scope, argPath); // 条件も走査する（中の適用を数える）
        const out = this.cell();
        const t = auxRaw('then');
        const e = auxRaw('else');
        if (t !== undefined) this.flow(this.walk(node[t], scope, childPath(path, t)), out);
        if (e !== undefined) this.flow(this.walk(node[e], scope, childPath(path, e)), out);
        return out;
      }
      case 'fn':
        return this.fn(node, arg, auxRaw('body'), scope, path);
      case 'collect': {
        const target = this.walk(arg, scope, argPath);
        const withRaw = auxRaw('with');
        const f =
          withRaw === undefined
            ? this.cell()
            : this.walk(node[withRaw], scope, childPath(path, withRaw));
        const elems = this.cell();
        this.elemsInto(target, elems);
        // 要素ごとに $with の関数を適用する。関数はリストを返すので、結果はその要素の soup。
        const returned = this.apply(f, elems);
        const flat = this.cell();
        this.elemsInto(returned, flat);
        const intoRaw = auxRaw('into');
        const out = this.cell();
        this.add(out, {
          kind: 'soup',
          elems:
            intoRaw !== undefined && node[intoRaw] === 'mapping'
              ? this.project(flat, 'value')
              : flat,
        });
        return out;
      }
      case 'handle': {
        // 節（とローカル宣言）を先に組んでから、宣言を足した scope で本体を走査する。
        const h = this.prepareHandler(node[auxRaw('with') ?? ''], scope, path);
        return h.frame(this.walk(arg, h.scope, argPath));
      }
      case 'resume': {
        const v = this.walk(arg, scope, argPath);
        const ctx = this.currentResume;
        if (ctx === undefined) return this.cell(); // 節の外の $resume は評価器がエラーにする
        this.flow(v, this.resumePool(ctx.opName));
        // 値はこのハンドラの残りの計算の結果。継続由来の閉包は blessed の印をつけて流す
        // （継続の適用はハンドラの畳み込みで停止し、循環の辺には数えないため）。
        const out = this.cell();
        this.listen(ctx.res, (a) => {
          this.add(out, a.kind === 'clo' ? this.stageAtom(a.fn, a.stage, true) : a);
        });
        return out;
      }
      default:
        // 単独の $with などの位置外の形は評価器がエラーにする。子は走査だけしておく。
        this.walk(arg, scope, argPath);
        return this.cell();
    }
  }

  private fn(
    node: NodeMap,
    paramsRaw: unknown,
    bodyRaw: string | undefined,
    scope: Scope,
    path: string,
  ): Cell {
    const known = this.fns.get(node);
    if (known !== undefined) return known.cell; // YAML の別名で共有されたノードは一度だけ走査する
    const params = fnParamsOf(paramsRaw);
    const info: FnInfo = {
      params,
      defPath: path,
      paramCells: params.map(() => this.cell()),
      cod: this.cell(),
      edges: new Set(),
      stageAtoms: new Map(),
    };
    const out = this.cell();
    this.fns.set(node, { info, cell: out });
    // パラメータに流れ込みうる閉包は、この $fn の型に他の $fn が現れることを意味する（辺に数える）。
    for (const p of info.paramCells) this.watchClosures(p, (a) => info.edges.add(a.fn));
    let inner = scope;
    for (let i = 0; i < params.length; i++) inner = insert(inner, params[i]!, info.paramCells[i]!);
    const saved = this.currentFn;
    this.currentFn = info;
    const body =
      bodyRaw === undefined
        ? this.cell()
        : this.walk(node[bodyRaw], inner, childPath(path, bodyRaw));
    this.currentFn = saved;
    this.flow(body, info.cod);
    this.add(out, this.stageAtom(info, 0, false));
    return out;
  }

  /** $let の束縛（$in 形と $do の文形で共通）。右辺は先行する束縛だけを見る（非再帰）。 */
  private letBind(bindings: unknown, scope: Scope, path: string): Scope {
    if (!isNodeMap(bindings)) return scope; // 形の誤りは評価器に任せる
    let cur = scope;
    for (const [name, rhs] of Object.entries(bindings)) {
      cur = insert(cur, name, this.walk(rhs, cur, childPath(path, name)));
    }
    return cur;
  }

  /**
   * $do の文の並び。文形（$let / $std.state / 単独の $with）は残りの文を本体に取る。
   * 文の数に対して再帰しないよう、ハンドラの枠は積んでおいて最後に値へ巻きつける。
   */
  private statements(stmts: readonly unknown[], scope: Scope, path: string): Cell {
    const frames: ((body: Cell) => Cell)[] = [];
    let cur = scope;
    let last: Cell | undefined;
    for (let i = 0; i < stmts.length; i++) {
      const stmt = stmts[i];
      const stmtPath = `${path}[${i}]`;
      const form = statementFormOf(stmt);
      if (form !== undefined) {
        last = undefined;
        if (form.kind === 'let') {
          cur = this.letBind(form.bindings, cur, childPath(stmtPath, '$let'));
          continue;
        }
        if (form.kind === 'state') {
          this.writeState(this.walk(form.init, cur, childPath(stmtPath, '$std.state')));
          continue;
        }
        {
          // $with 文のローカル宣言は残りの文（＝本体）から見える。
          const h = this.prepareHandler(form.clauses, cur, stmtPath);
          frames.push(h.frame);
          cur = h.scope;
        }
        continue;
      }
      last = this.walk(stmt, cur, stmtPath);
    }
    let value = last ?? this.cell();
    for (let i = frames.length - 1; i >= 0; i--) value = frames[i]!(value);
    return value;
  }

  /**
   * $with の節（$handle と $do の $with 文で共通）。節の演算名を記録し、
   * 引数プールを節の関数に適用して、節の結果とハンドラ本体の値を Res に合流させる。
   * 返す frame が本体の値のセルを受け取り、ハンドラの式全体の値のセルを返す。
   * ローカル作用の宣言（ドットなしの節名）は素通しの関数を本体の scope に束縛する
   * （内部演算名を鋳造するのはここ＝構文パスを持つ唯一の走査である）。
   */
  private prepareHandler(
    withNode: unknown,
    scope: Scope,
    path: string,
  ): { frame: (body: Cell) => Cell; scope: Scope } {
    if (!isNodeMap(withNode)) return { frame: (body) => body, scope }; // 形の誤りは評価器に任せる
    const locals = localDeclsOf(withNode, path);
    const res = this.cell();
    let retCell: Cell | undefined;
    for (const [name, clauseNode] of Object.entries(withNode)) {
      const clausePath = childPath(childPath(path, '$with'), name);
      const local = locals.get(name);
      // 節名の誤りは評価器に任せる。
      if (name !== 'return' && local === undefined && !name.includes('.')) continue;
      const opName = local?.opName ?? name;
      const savedResume = this.currentResume;
      if (name !== 'return') {
        // ローカル作用の内部演算も「節を持つ」側に数える（ホストへは決して渡らない）。
        this.clauseNames.add(opName);
        this.currentResume = { opName, res };
      }
      const cCell = this.walk(clauseNode, scope, clausePath);
      this.currentResume = savedResume;
      if (name === 'return') retCell = cCell;
      else this.flow(this.apply(cCell, this.argPool(opName)), res);
    }
    let inner = scope;
    for (const [name, decl] of locals) {
      inner = insert(
        inner,
        name,
        this.walk(decl.fn, scope, childPath(childPath(path, '$with'), name)),
      );
    }
    const ret = retCell;
    return {
      frame: (body) => {
        this.flow(ret === undefined ? body : this.apply(ret, body), res);
        return res;
      },
      scope: inner,
    };
  }

  // --- 判定 ---

  /** `$fn` の到達グラフの循環を探す。自己ループを含む循環が自己適用の可能性である。 */
  findCycle(): FnInfo[] | undefined {
    const state = new Map<FnInfo, 'grey' | 'black'>();
    const all = [...this.fns.values()].map((e) => e.info);
    for (const root of all) {
      if (state.has(root)) continue;
      // 反復の DFS。スタックに (ノード, 未処理の辺) を積む。
      const stack: { fn: FnInfo; edges: FnInfo[] }[] = [{ fn: root, edges: [...root.edges] }];
      state.set(root, 'grey');
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const next = top.edges.pop();
        if (next === undefined) {
          state.set(top.fn, 'black');
          stack.pop();
          continue;
        }
        const s = state.get(next);
        if (s === 'black') continue;
        if (s === 'grey') {
          const at = stack.findIndex((e) => e.fn === next);
          return stack.slice(at).map((e) => e.fn);
        }
        state.set(next, 'grey');
        stack.push({ fn: next, edges: [...next.edges] });
      }
    }
    return undefined;
  }

  /** 文書内のどの節にも現れない（＝ホストへ渡りうる）演算の引数に、閉包が到達しうるか。 */
  findHostViolation(): string | undefined {
    for (const [name, pool] of this.argPools) {
      if (name.startsWith('std.') || this.clauseNames.has(name)) continue;
      if (this.reachesClosure(pool)) return name;
    }
    return undefined;
  }

  /**
   * 実装が供給されていない演算。境界の既定ハンドラの系列（失敗・パラメータ・ログ・状態）と
   * 選択のハンドラが処理する演算、文書内の節が処理する演算、第一階の標準演算、
   * ホストが登録した演算のいずれでもない名前を返す。
   * 走査は演算の出現に対して全域なので、この検査も全域である。
   */
  findUnsuppliedOp(ops: Readonly<Record<string, unknown>>): string | undefined {
    for (const name of this.argPools.keys()) {
      if (IMPLICIT_OPS.has(name) || this.clauseNames.has(name)) continue;
      if (name in ops || name in BUILTIN_OPS) continue;
      return name;
    }
    return undefined;
  }

  private reachesClosure(cell: Cell): boolean {
    const visited = new Set<Cell>();
    const stack = [cell];
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (visited.has(c)) continue;
      visited.add(c);
      for (const a of c.atoms) {
        if (a.kind === 'clo') return true;
        if (a.kind === 'struct') stack.push(...a.fields.values());
        else stack.push(a.elems);
      }
    }
    return false;
  }
}

/**
 * 実装の登録を要さない演算。境界の既定ハンドラの系列が処理する 5 つと、
 * 選択のハンドラ（$std.list など）が処理する std.each である。
 * std.each がここに在るのは、選択を処理するハンドラが在るかどうかを走査では決められず、
 * 捕まえ手のない選択を評価時のエラーにすると定めたからである（言語仕様の作用境界）。
 */
const IMPLICIT_OPS: ReadonlySet<string> = new Set([
  'std.fail',
  'std.param',
  'std.log',
  'std.get',
  'std.set',
  'std.each',
]);

const describePath = (p: string): string => (p === '' ? 'the document root' : p);

/**
 * 文書全体の評価前の検査。自己適用を含みうる文書、ホスト演算の引数に閉包が流れうる文書、
 * 実装の供給されていない演算を含む文書を EffectfulYamlError で拒否する。
 */
export function typecheck(doc: unknown, ops: Readonly<Record<string, unknown>> = {}): void {
  const checker = new Checker();
  checker.walk(doc, empty, '');
  const cycle = checker.findCycle();
  if (cycle !== undefined) {
    if (cycle.length === 1) {
      throw new EffectfulYamlError(
        `self-application detected: the function defined at ${describePath(cycle[0]!.defPath)} may be applied to itself`,
      );
    }
    const chain = [...cycle, cycle[0]!].map((f) => describePath(f.defPath)).join(' -> ');
    throw new EffectfulYamlError(
      `self-application detected: functions form an application cycle: ${chain}`,
    );
  }
  const host = checker.findHostViolation();
  if (host !== undefined) {
    throw new EffectfulYamlError(`a function value cannot be passed to a host operation: $${host}`);
  }
  const missing = checker.findUnsuppliedOp(ops);
  if (missing !== undefined) throw new EffectfulYamlError(unhandledOpMessage(missing));
}
