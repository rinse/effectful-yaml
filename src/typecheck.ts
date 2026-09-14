/**
 * 未定義参照の検査、関数値と演算の値の流れの検査（0CFA 流のフロー解析）、
 * ホストの実装に渡る引数の検査。
 * 仕様: docs/grammar.md（草案 0.13）「名前と環境」「関数値の流れと停止性」「ホストの値」。
 *
 * 閉包を作るのは文書内の `$fn` だけである（パラメータとホストの値の結果は常にデータ）。
 * したがって文書の有限個の `$fn` を抽象閉包とするフロー解析は、追跡不能を持たない全域の解析になる。
 * カーネルの AST を一度だけ走査して「どのセルにどの閉包が流れうるか」の制約を組み立て、
 * ワークリストで不動点まで伝播させ、`$fn` の間の到達グラフに循環があれば評価前にエラーにする。
 *
 * 走査は演算のサイトも余さず数えるので、文書の作用シグネチャ（要求するハンドラの一覧）も
 * ここで得られる。実装の要る演算が供給されていない文書は、同じ走査の結果から拒否する。
 *
 * データは追わない（Data の原子は持たず、閉包を運びうる原子だけをセルに入れる）。
 * 出現主義：$if の選ばれない側や $default の中の適用も数える。
 * エラーの位置は評価時の失敗位置と違い、`$` 式の内側へも降りる構文パスで報告する。
 */
import { type ClauseKey, type KNode } from './desugar.js';
import { refPathOf, referencedNames } from './expr.js';
import { empty, get, insert, type PMap } from './pmap.js';
import { EffectfulYamlError, STD_FUNCTIONS, STD_OPS } from './types.js';

// ---------------------------------------------------------------------------
// 原子とセル
// ---------------------------------------------------------------------------

/**
 * セルに入る原子。Data は原子にしない（閉包を運べない値は流れに参加しない）。
 * - clo: `$fn` f のカリー化第 stage 段の閉包。blessed は $resume の結果から出た
 *   継続由来の印（ハンドラの畳み込みで停止が保証される適用を、循環の辺から除くため）。
 * - struct: リテラルのマッピング・リスト。フィールドごとのセルを持つ（キーの精度を保つ）。
 * - soup: 中身のキーが静的に分からない容れ物（ハンドラの値のリストなど）。要素は一つのセルに合流する。
 * - op: 演算の値。適用すると作用のサイトになる。初期環境とローカル作用の宣言だけが作る。
 * - native: 処理系が実装する関数。名前ごとの模型で値と作用を数える（stage はカリー化の段）。
 */
type Atom =
  | { readonly kind: 'clo'; readonly fn: FnInfo; readonly stage: number; readonly blessed: boolean }
  | {
      readonly kind: 'struct';
      readonly source: 'list' | 'mapping';
      readonly fields: ReadonlyMap<string, Cell>;
    }
  | { readonly kind: 'soup'; readonly elems: Cell }
  | { readonly kind: 'op'; readonly name: string }
  | { readonly kind: 'native'; readonly name: string; readonly stage: number };

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

/**
 * $resume が見える文脈（ハンドラの節の本体）。
 * ops は節のキーが解決しうる演算のセル（節の名前は式で与えられうるので一つに定まらない）、
 * res はハンドラの値のセルである。
 */
interface ResumeCtx {
  readonly ops: Cell;
  readonly res: Cell;
}

// ---------------------------------------------------------------------------
// 検査器
// ---------------------------------------------------------------------------

class Checker {
  private readonly fns: FnInfo[] = [];
  private readonly argPools = new Map<string, Cell>();
  private readonly resumePools = new Map<string, Cell>();
  /** 名前ごとに intern した演算と Native の原子（原子の同一性で伝播の重複を除くため）。 */
  private readonly opAtoms = new Map<string, Atom>();
  private readonly nativeAtoms = new Map<string, Atom>();
  private readonly hostOps: ReadonlySet<string>;
  private readonly hostFns: ReadonlySet<string>;

  constructor(hostOps: readonly string[], hostFns: readonly string[]) {
    this.hostOps = new Set(hostOps);
    this.hostFns = new Set(hostFns);
  }
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
    const walkCell = (c: Cell): void => {
      if (visited.has(c)) return;
      visited.add(c);
      this.listen(c, (a) => {
        if (a.kind === 'clo') cb(a);
        else if (a.kind === 'struct') for (const f of a.fields.values()) walkCell(f);
        else if (a.kind === 'soup') walkCell(a.elems);
      });
    };
    walkCell(cell);
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

  private opAtom(name: string): Atom {
    let a = this.opAtoms.get(name);
    if (a === undefined) {
      a = { kind: 'op', name };
      this.opAtoms.set(name, a);
    }
    return a;
  }

  private nativeAtom(name: string, stage: number): Atom {
    const key = `${name}#${stage}`;
    let a = this.nativeAtoms.get(key);
    if (a === undefined) {
      a = { kind: 'native', name, stage };
      this.nativeAtoms.set(key, a);
    }
    return a;
  }

  /** 原子ひとつを持つセル。 */
  private atomCell(atom: Atom): Cell {
    const c = this.cell();
    this.add(c, atom);
    return c;
  }

  /** 走査の途中で包囲する `$fn` を差し替える。listen の遅延発火では文脈が失われるため。 */
  private withFn<T>(fn: FnInfo | undefined, f: () => T): T {
    const saved = this.currentFn;
    this.currentFn = fn;
    try {
      return f();
    } finally {
      this.currentFn = saved;
    }
  }

  /**
   * 初期環境のスコープ。束縛 `std`（演算と Native のマッピング）と、
   * ホストが与えた束縛（名前の区画ごとに入れ子のマッピング）からなる。
   */
  initialScope(): Scope {
    const stdFields = new Map<string, Cell>();
    for (const n of STD_OPS) stdFields.set(n, this.atomCell(this.opAtom(`std.${n}`)));
    for (const n of STD_FUNCTIONS) stdFields.set(n, this.atomCell(this.nativeAtom(`std.${n}`, 0)));
    let scope = insert(empty as Scope, 'std', this.structOf(stdFields));

    interface Tree {
      readonly children: Map<string, Tree>;
      atom?: Atom;
    }
    const roots = new Map<string, Tree>();
    const place = (name: string, atom: Atom): void => {
      const segs = name.split('.');
      let level = roots;
      let node: Tree | undefined;
      for (const seg of segs) {
        let next = level.get(seg);
        if (next === undefined) {
          next = { children: new Map() };
          level.set(seg, next);
        }
        node = next;
        level = next.children;
      }
      node!.atom = atom;
    };
    for (const name of this.hostOps) place(name, this.opAtom(name));
    for (const name of this.hostFns) place(name, this.nativeAtom(name, 0));
    const toCell = (t: Tree): Cell => {
      if (t.atom !== undefined) return this.atomCell(t.atom);
      const fields = new Map<string, Cell>();
      for (const [k, child] of t.children) fields.set(k, toCell(child));
      return this.structOf(fields);
    };
    for (const [name, t] of roots) scope = insert(scope, name, toCell(t));
    return scope;
  }

  private structOf(fields: ReadonlyMap<string, Cell>): Cell {
    return this.atomCell({ kind: 'struct', source: 'mapping', fields });
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
   * 構造を回る形（std.each の分岐、std.collect の対象）の要素を out へ流す。
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

  /** 既定ハンドラの状態セルへの書き込み（std.set の引数、std.state の初期値）。フィールド値が書かれる。 */
  private writeState(cell: Cell): void {
    this.listen(cell, (a) => {
      if (a.kind === 'struct') for (const f of a.fields.values()) this.flow(f, this.stateSoup);
      else if (a.kind === 'soup') this.flow(a.elems, this.stateSoup);
    });
  }

  /**
   * 適用。呼び先にたどり着いた値の種類ごとに、閉包なら引数をパラメータへ流して結果
   * （部分適用なら次の段、最終段なら Cod）を、演算なら作用のサイトを、Native なら
   * 名前ごとの模型の値を返す。
   * 継続由来（blessed）でない閉包を包囲する $fn の本体で適用したら、到達グラフの辺に数える。
   * listen は後から届いた原子にも発火するので、包囲する $fn は呼び出し時のものを捕まえておく。
   */
  private apply(calleeCell: Cell, argCell: Cell): Cell {
    const out = this.cell();
    const enclosing = this.currentFn;
    this.listen(calleeCell, (a) => {
      if (a.kind === 'clo') {
        if (enclosing !== undefined && !a.blessed) enclosing.edges.add(a.fn);
        this.flow(argCell, a.fn.paramCells[a.stage]!);
        if (a.stage + 1 < a.fn.params.length) {
          this.add(out, this.stageAtom(a.fn, a.stage + 1, a.blessed));
        } else {
          this.flow(a.fn.cod, out);
        }
        return;
      }
      if (a.kind === 'op') {
        this.withFn(enclosing, () => this.flow(this.opSite(a.name, argCell), out));
        return;
      }
      if (a.kind === 'native') {
        this.withFn(enclosing, () => this.flow(this.native(a.name, a.stage, argCell), out));
      }
    });
    return out;
  }

  /**
   * Native の模型。値と作用を名前ごとに数える（仕様の展開と観測的に等価な範囲で近似する）。
   * 本体の閉包を受け取る関数は、引数の関数をその場で適用するのと同じに数える
   * （包囲する `$fn` の辺も直接の適用と同じに立つ）。
   */
  private native(name: string, stage: number, argCell: Cell): Cell {
    if (name === 'std.state') {
      // 第一段は初期値（状態のセルへの書き込み）、第二段は本体の閉包の適用。
      if (stage === 0) {
        this.writeState(argCell);
        return this.atomCell(this.nativeAtom('std.state', 1));
      }
      return this.apply(argCell, this.cell());
    }
    switch (name) {
      case 'std.where':
        // {$if: 条件, $then: null, $else: {$std.each: []}}。
        // 値は null と空の選択のサイトの値の合併である（展開の $if の二分岐そのもの）。
        return this.opSite('std.each', this.cell());
      case 'std.range':
        return this.cell();
      case 'std.collect':
        return this.collect(argCell);
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
      case 'std.list':
      case 'std.mapping': {
        // 値は全分岐の結果の容れ物。長さもキーも静的に分からないので soup にする。
        const out = this.cell();
        this.add(out, { kind: 'soup', elems: this.apply(argCell, this.cell()) });
        return out;
      }
      case 'std.first':
        return this.apply(argCell, this.cell()); // 最初に成功した分岐の値そのもの
      default:
        // ホストの関数。結果は常にデータであり、引数はホストへ渡るので引数プールに記録する。
        return this.opSite(name, argCell);
    }
  }

  /** std.collect。要素ごとに `with` の関数を適用し、結果のリストを連ねた容れ物を返す。 */
  private collect(argCell: Cell): Cell {
    const elems = this.cell();
    this.elemsInto(this.project(argCell, 'in'), elems);
    const flat = this.cell();
    this.elemsInto(this.apply(this.project(argCell, 'with'), elems), flat);
    // `into` は静的に分からないので、リストの要素と、エントリの value の両方を数える。
    const all = this.cell();
    this.flow(flat, all);
    this.flow(this.project(flat, 'value'), all);
    const out = this.cell();
    this.add(out, { kind: 'soup', elems: all });
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

  /** マッピング（かもしれない値）のフィールド値をすべて out へ合流させる。 */
  private fieldValuesInto(cell: Cell, out: Cell): void {
    this.listen(cell, (a) => {
      if (a.kind === 'struct') for (const f of a.fields.values()) this.flow(f, out);
      else if (a.kind === 'soup') this.flow(a.elems, out);
    });
  }

  // --- 走査 ---

  /** ノードの値のセルを返す。すべての子を（実行されない分岐も）一度だけ走査する。 */
  walk(node: KNode, scope: Scope): Cell {
    switch (node.k) {
      case 'lit':
        return this.cell();
      case 'str': {
        // 参照の先頭区画は環境の束縛でなければならない（評価を要さないレキシカルな判定）。
        for (const name of referencedNames(node.raw)) this.requireBound(name, scope);
        const ref = refPathOf(node.raw);
        if (ref === undefined) return this.cell(); // 演算子・補間の混在は閉包を運べない
        const [head, ...rest] = ref;
        let cur = get(scope, head!) ?? this.cell();
        for (const seg of rest) cur = this.project(cur, seg);
        return cur;
      }
      case 'list': {
        const fields = new Map<string, Cell>();
        node.items.forEach((item, i) => fields.set(String(i), this.walk(item, scope)));
        const out = this.cell();
        this.add(out, { kind: 'struct', source: 'list', fields });
        return out;
      }
      case 'map': {
        const fields = new Map<string, Cell>();
        for (const [key, child] of node.entries) fields.set(key, this.walk(child, scope));
        const out = this.cell();
        this.add(out, { kind: 'struct', source: 'mapping', fields });
        return out;
      }
      case 'boundary':
        return this.walk(node.body, scope);
      case 'let': {
        // 右辺は先行する束縛だけを見る（非再帰）。名前の無い束縛は値を捨てる文。
        let cur = scope;
        for (const b of node.bindings) {
          const rhs = this.walk(b.rhs, cur);
          if (b.name !== null) cur = insert(cur, b.name, rhs);
        }
        return this.walk(node.body, cur);
      }
      case 'if': {
        this.walk(node.cond, scope); // 条件も走査する（中の適用を数える）
        const out = this.cell();
        this.flow(this.walk(node.then, scope), out);
        this.flow(this.walk(node.else, scope), out);
        return out;
      }
      case 'fn':
        return this.fn(node, scope);
      case 'call': {
        this.requireBound(node.head, scope);
        let callee = get(scope, node.head) ?? this.cell();
        for (const seg of node.keys) callee = this.project(callee, seg);
        return this.apply(callee, this.walk(node.arg, scope));
      }
      case 'handle':
        return this.handle(node, scope);
      case 'resume': {
        const v = this.walk(node.arg, scope);
        const ctx = this.currentResume;
        if (ctx === undefined) return this.cell(); // 節の外の $resume は脱糖器が拒む
        // 節のキーが解決しうる演算ごとに、再開される値のプールへ流す。
        this.listen(ctx.ops, (a) => {
          if (a.kind === 'op') this.flow(v, this.resumePool(a.name));
        });
        // 値はこのハンドラの残りの計算の結果。継続由来の閉包は blessed の印をつけて流す
        // （継続の適用はハンドラの畳み込みで停止し、循環の辺には数えないため）。
        const out = this.cell();
        this.listen(ctx.res, (a) => {
          this.add(out, a.kind === 'clo' ? this.stageAtom(a.fn, a.stage, true) : a);
        });
        return out;
      }
      case 'err': {
        // 評価は拒むが、走査は出現主義なので子まで降りる。
        for (const child of node.children) this.walk(child, scope);
        return this.cell();
      }
    }
  }

  private requireBound(name: string, scope: Scope): void {
    if (get(scope, name) === undefined) {
      throw new EffectfulYamlError(`undefined reference: ${name}`);
    }
  }

  private fn(node: Extract<KNode, { k: 'fn' }>, scope: Scope): Cell {
    const info: FnInfo = {
      params: node.params,
      defPath: node.spath,
      paramCells: node.params.map(() => this.cell()),
      cod: this.cell(),
      edges: new Set(),
      stageAtoms: new Map(),
    };
    this.fns.push(info);
    // パラメータに流れ込みうる閉包は、この $fn の型に他の $fn が現れることを意味する（辺に数える）。
    for (const p of info.paramCells) this.watchClosures(p, (a) => info.edges.add(a.fn));
    let inner = scope;
    for (let i = 0; i < node.params.length; i++) {
      inner = insert(inner, node.params[i]!, info.paramCells[i]!);
    }
    const saved = this.currentFn;
    this.currentFn = info;
    const body = this.walk(node.body, inner);
    this.currentFn = saved;
    this.flow(body, info.cod);
    const out = this.cell();
    this.add(out, this.stageAtom(info, 0, false));
    return out;
  }

  /**
   * ハンドラ。節のキーをスコープで解決し、届いた演算ごとにその引数プールを節の関数に適用して、
   * 節の結果とハンドラ本体の値を Res に合流させる。
   * ローカル作用の宣言は宣言位置ごとの演算の原子を作り、その名前を本体のスコープに束縛する。
   */
  private handle(node: Extract<KNode, { k: 'handle' }>, scope: Scope): Cell {
    const res = this.cell();
    const enclosing = this.currentFn;
    let bodyScope = scope;
    for (const c of node.clauses) {
      const ops = this.clauseOps(c.key, scope);
      if (c.key.kind === 'local') bodyScope = insert(bodyScope, c.key.name, ops);
      const saved = this.currentResume;
      this.currentResume = { ops, res };
      const cell = this.walk(c.fn, scope);
      this.currentResume = saved;
      this.listen(ops, (a) => {
        if (a.kind !== 'op') return;
        this.clauseNames.add(a.name);
        this.withFn(enclosing, () => this.flow(this.apply(cell, this.argPool(a.name)), res));
      });
    }
    // return 節の本体に $resume は見えない。
    const ret = node.ret === undefined ? undefined : this.walk(node.ret, scope);
    const body = this.walk(node.body, bodyScope);
    this.flow(ret === undefined ? body : this.apply(ret, body), res);
    return res;
  }

  /**
   * 節のキーが解決しうる演算のセル。ローカル作用の宣言は宣言位置で一意な演算の原子になる。
   * パスの節名も呼び出しや参照と同じく、先頭区画が環境に無ければ評価前に拒む。
   */
  private clauseOps(key: ClauseKey, scope: Scope): Cell {
    if (key.kind === 'local') return this.atomCell(this.opAtom(`${key.name}@${key.spath}`));
    this.requireBound(key.head, scope);
    let cur = get(scope, key.head) ?? this.cell();
    for (const seg of key.keys) cur = this.project(cur, seg);
    return cur;
  }

  // --- 判定 ---

  /** `$fn` の到達グラフの循環を探す。自己ループを含む循環が自己適用の可能性である。 */
  findCycle(): FnInfo[] | undefined {
    const state = new Map<FnInfo, 'grey' | 'black'>();
    for (const root of this.fns) {
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

  /**
   * ホストの実装へ渡りうる引数に、閉包か演算の値が到達しうるか。
   * 文書内の節が処理する演算はホストへ渡らないので除く（ホストの関数は横取りできないので
   * 節に現れることはない）。
   */
  findHostViolation(): { name: string; kind: 'operation' | 'function' } | undefined {
    for (const [name, pool] of this.argPools) {
      const kind = this.hostOps.has(name)
        ? ('operation' as const)
        : this.hostFns.has(name)
          ? ('function' as const)
          : undefined;
      if (kind === undefined || this.clauseNames.has(name)) continue;
      if (this.reachesNonData(pool)) return { name, kind };
    }
    return undefined;
  }

  /** セルから到達しうる原子に、データでない値（閉包・Native・演算）があるか。 */
  private reachesNonData(cell: Cell): boolean {
    const visited = new Set<Cell>();
    const stack = [cell];
    while (stack.length > 0) {
      const c = stack.pop()!;
      if (visited.has(c)) continue;
      visited.add(c);
      for (const a of c.atoms) {
        if (a.kind === 'clo' || a.kind === 'op' || a.kind === 'native') return true;
        if (a.kind === 'struct') stack.push(...a.fields.values());
        else stack.push(a.elems);
      }
    }
    return false;
  }
}

const describePath = (p: string): string => (p === '' ? 'the document root' : p);

/**
 * 文書全体の評価前の検査。未定義の参照を含む文書、自己適用を含みうる文書、
 * ホストの実装の引数に閉包や演算の値が流れうる文書を EffectfulYamlError で拒否する。
 */
export function typecheck(
  ast: KNode,
  hostOps: readonly string[] = [],
  hostFns: readonly string[] = [],
): void {
  const checker = new Checker(hostOps, hostFns);
  checker.walk(ast, checker.initialScope());
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
    throw new EffectfulYamlError(
      `a function value cannot be passed to a host ${host.kind}: $${host.name}`,
    );
  }
}
