/**
 * The objects.ts language's fixtures (#1747), each `objects.ts` in a fixture project (`objects-language.fixture.mjs`),
 * named by the #1921 review round that found them:
 * - Sol's design r1 form probes and witnesses (`r1/`), and r2's witnesses and focused cases (`r2/`);
 * - the language's own cases, one per rule, with an admitted control beside each (`v3/`);
 * - Codex r6's and r9–r13's witnesses, each gate's clause with an admitted control (`r6/`, `r9/` … `r13/`).
 * `expect` is the sorted rules the checker rejects the source by (`[]`: admitted). `residual` marks a witness the
 * lint admits by its stated claim: runtime provenance through carriers is a reviewed boundary, not the lint's.
 */
export const CASES = [
  {
    name: "r1/asyncFacade",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {async joinParts(_p:readonly string[]):Promise<string> {work.charge('objectSteps');return '';}} export async function witness(input:readonly string[]):Promise<string> {work.charge('objectSteps');const facade=budget as unknown as Facade;return await facade.joinParts(input);}\n",
    expect: ["any", "cast", "cast", "class", "local-member", "namespace"],
  },
  {
    name: "r1/callbackParameter",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:readonly (()=>boolean)[]):boolean {work.charge('objectSteps');return some(work,'objectSteps',input,(f)=>f());}\n",
    expect: ["callee", "entry-parameter", "retained-opaque"],
  },
  {
    name: "r1/classFacade",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');const facade:Facade=budget;return facade.joinParts(input);}\n",
    expect: ["class", "local-member", "namespace", "widening"],
  },
  {
    name: "r1/classFacadeAnnotatedSatisfies",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');const facade:Facade=budget satisfies Facade;return facade.joinParts(input);}\n",
    expect: ["class", "local-member", "namespace", "satisfies", "widening"],
  },
  {
    name: "r1/classFacadeAs",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');return (budget as Facade).joinParts(input);}\n",
    expect: ["cast", "class", "local-member", "namespace"],
  },
  {
    name: "r1/classFacadeOptional",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');const facade:Facade=budget;return facade.joinParts?.(input);}\n",
    expect: ["class", "namespace", "optional-call", "widening"],
  },
  {
    name: "r1/classFacadeSatisfies",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');return (budget satisfies Facade).joinParts(input);}\n",
    expect: ["class", "namespace", "retained-collection", "satisfies"],
  },
  {
    name: "r1/defaultFacade",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[],facade:Facade=budget):string {work.charge('objectSteps');return facade.joinParts(input);}\n",
    expect: ["class", "default", "entry-parameter", "local-member", "namespace"],
  },
  {
    name: "r1/defaultFunction",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nfunction local(_p:readonly string[]):string {work.charge('objectSteps');return '';} export function witness(input:readonly string[],f:typeof local=local):string {work.charge('objectSteps');return f(input);}\n",
    expect: ["callee", "default", "entry-parameter", "retained-opaque"],
  },
  {
    name: "r1/functionCast",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');const f=budget.joinParts as (p:readonly string[])=>string;return f(input);}\n",
    expect: ["callee", "cast", "namespace", "retained-opaque", "retained-value"],
  },
  {
    name: "r1/functionParameter",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(f:(p:readonly string[])=>string,input:readonly string[]):string {work.charge('objectSteps');return f(input);}\n",
    expect: ["callee", "entry-parameter", "retained-opaque"],
  },
  {
    name: "r1/generatorFacade",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {*joinParts(_p:readonly string[]):Generator<string> {work.charge('objectSteps');yield '';}} export function* witness(input:readonly string[]):Generator<string> {work.charge('objectSteps');const facade=budget as unknown as Facade;yield* facade.joinParts(input);}\n",
    expect: ["any", "cast", "cast", "class", "local-member", "namespace"],
  },
  {
    name: "r1/genericCallback",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness<F extends ()=>boolean>(input:readonly F[]):boolean {work.charge('objectSteps');return some(work,'objectSteps',input,(f)=>f());}\n",
    expect: ["callee", "entry-parameter", "retained-opaque"],
  },
  {
    name: "r1/genericParameter",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness<F extends (p:readonly string[])=>string>(f:F,input:readonly string[]):string {work.charge('objectSteps');return f(input);}\n",
    expect: ["callee", "entry-parameter", "retained-opaque"],
  },
  {
    name: "r1/getterFacade",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nfunction checked(_p:readonly string[]):string {work.charge('objectSteps');return '';} class Facade {get joinParts():typeof checked {work.charge('objectSteps');return checked;}}export function witness(input:readonly string[]):string {work.charge('objectSteps');const facade:Facade=budget;return facade.joinParts(input);}\n",
    expect: ["class", "local-member", "namespace", "widening"],
  },
  {
    name: "r1/helperIndexed",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:{readonly length:number;at(i:number):string|undefined}):Generator<string> {work.charge('objectSteps');return indexed(work,'objectSteps',input);}\n",
    expect: ["entry-parameter", "indexed-class"],
  },
  {
    name: "r1/helperSome",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:Iterable<string>):boolean {work.charge('objectSteps');return some(work,'objectSteps',input,(s)=>s==='x');}\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r1/helperSortCoercion",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:{toString():string}[]):{toString():string}[] {work.charge('objectSteps');return sorted(work,'objectSteps',input);}\n",
    expect: ["entry-parameter", "sorted-made", "sorted-result"],
  },
  {
    name: "r1/helperSteps",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:Iterable<string>):Generator<void> {work.charge('objectSteps');return steps(work,'objectSteps',()=>some(work,'objectSteps',input,()=>false));}\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r1/implicitGetter",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:{readonly value:string}):string {work.charge('objectSteps');return input.value;}\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r1/namespaceDirect",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');return budget.joinParts(input);}\n",
    expect: ["namespace", "retained-collection"],
  },
  {
    name: "r1/overload",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nfunction checked(p:readonly string[]):string;function checked(_p:readonly string[]):string {work.charge('objectSteps');return '';} export function witness(input:readonly string[]):string {work.charge('objectSteps');return checked(input);}\n",
    expect: ["bodiless", "overload"],
  },
  {
    name: "r1/prototypeFacade",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');const facade:typeof Facade.prototype=budget;return facade.joinParts(input);}\n",
    expect: ["class", "local-member", "namespace", "widening"],
  },
  {
    name: "r1/reexportAlias",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nimport {renamed} from '../barrel.js';\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');return renamed(input);}\n",
    expect: ["retained-collection"],
  },
  {
    name: "r1/reexportNamespace",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nimport {api} from '../barrel.js';\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');return api.joinParts(input);}\n",
    expect: ["retained-collection"],
  },
  {
    name: "r1/spreadMethods",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');const facade:Facade={...budget};return facade.joinParts(input);}\n",
    expect: ["class", "local-member", "namespace", "retained-spread", "widening"],
  },
  {
    name: "r1/structuralSignature",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');const facade:{joinParts(p:readonly string[]):string}=budget;return facade.joinParts(input);}\n",
    expect: ["local-member", "namespace", "widening"],
  },
  {
    name: "r1/symbolMember",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\ndeclare const k:unique symbol; interface F {[k](p:readonly string[]):string} declare const f:F;export function witness(input:readonly string[]):string {work.charge('objectSteps');return f[k](input);}\n",
    expect: ["callee-form", "retained-computed", "retained-unresolved"],
  },
  {
    name: "r1/tagged",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');return budget.joinParts`fixed`;}\n",
    expect: ["namespace", "retained-value", "tagged-template"],
  },
  {
    name: "r1/templateMember",
    source:
      "import * as budget from '../budget.js';\nimport {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness(input:readonly string[]):string {work.charge('objectSteps');return budget[`join${\"Parts\"}`](input);}\n",
    expect: ["callee-form", "namespace", "retained-computed", "retained-unresolved"],
  },
  {
    name: "r1/thisFacade",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';} run(this:this,input:readonly string[]):string {work.charge('objectSteps');return this.joinParts(input);}}\n",
    expect: ["class", "local-member"],
  },
  {
    name: "r1/thisRoute",
    source:
      "import {type WorkLedger} from '../budget.js';\nimport {each,steps,some,mapped,indexed,sorted} from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nclass Facade {joinParts(_p:readonly string[]):string {work.charge('objectSteps');return '';}}\nexport function witness(this:Facade,input:readonly string[]):string {work.charge('objectSteps');return this.joinParts(input);}\n",
    expect: ["class", "entry-parameter", "local-member"],
  },
  {
    name: "r1/designFacadeWitness",
    source:
      "import { each, steps, some, indexed, sorted } from '../charged-iteration.js';\nimport * as designBudget from '../budget.js';\nimport type {WorkLedger as DesignWork} from '../budget.js';\nexport function designFacadeWitness(work:DesignWork,input:readonly string[]):string {\n work.charge('objectSteps');\n class Local {\n  joinParts(_parts:readonly string[]):string {work.charge('objectSteps');return '';}\n }\n const facade:Local=designBudget;\n return facade.joinParts(input);\n}\n",
    expect: ["class", "local-member", "namespace", "widening"],
  },
  {
    name: "r1/designGetterWitness",
    source:
      "import { each, steps, some, indexed, sorted } from '../charged-iteration.js';\nimport * as designBudget from '../budget.js';\nimport type {WorkLedger as DesignWork} from '../budget.js';\nexport function designGetterWitness(work:DesignWork,input:readonly string[]):string {\n work.charge('objectSteps');\n function checked(_parts:readonly string[]):string {work.charge('objectSteps');return '';}\n class Local {get joinParts():typeof checked {work.charge('objectSteps');return checked;}}\n const facade:Local=designBudget;\n return facade.joinParts(input);\n}\n",
    expect: ["class", "local-member", "namespace", "widening"],
  },
  {
    name: "r1/designIndexedWitness",
    source:
      "import { each, steps, some, indexed, sorted } from '../charged-iteration.js';\nimport type {WorkLedger as DesignWork} from '../budget.js';\nexport function designIndexedWitness(work:DesignWork,input:{readonly length:number;at(i:number):string|undefined}):Generator<string> {\n work.charge('objectSteps');\n return indexed(work,'objectSteps',input);\n}\n",
    expect: ["entry-parameter", "indexed-class"],
  },
  {
    name: "r1/designSomeWitness",
    source:
      "import { each, steps, some, indexed, sorted } from '../charged-iteration.js';\nimport type {WorkLedger as DesignWork} from '../budget.js';\nexport function designSomeWitness(work:DesignWork,input:Iterable<string>):boolean {\n work.charge('objectSteps');\n return some(work,'objectSteps',input,(s)=>s==='x');\n}\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r1/designSortWitness",
    source:
      "import { each, steps, some, indexed, sorted } from '../charged-iteration.js';\nimport type {WorkLedger as DesignWork} from '../budget.js';\nexport function designSortWitness(work:DesignWork,input:{toString():string}[]):{toString():string}[] {\n work.charge('objectSteps');\n return sorted(work,'objectSteps',input);\n}\n",
    expect: ["entry-parameter", "sorted-made", "sorted-result"],
  },
  {
    name: "r2/r2Overload",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nfunction r2Scalar(work: R2Work, input: readonly string[]): string;\nfunction r2Scalar(work: R2Work, input: readonly string[]): string | readonly string[] {\n  work.charge('objectSteps');\n  return input;\n}\n\nexport function r2Overload(work: R2Work, input: readonly string[]): string {\n  work.charge('objectSteps');\n  return r2JoinParts(r2Scalar(work, input));\n}\n",
    expect: ["bodiless", "overload"],
  },
  {
    name: "r2/r2ArrayAlias",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nexport function r2ArrayAlias(work: R2Work, input: readonly string[]): string {\n  work.charge('objectSteps');\n  const scalars: string[] = [];\n  const wider: (string | readonly string[])[] = scalars;\n  wider.push(input);\n  return r2JoinParts(scalars[0]!);\n}\n",
    expect: ["mixed-elements", "mixed-elements", "widening"],
  },
  {
    name: "r2/r2SortAlias",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nexport function r2SortAlias(work: R2Work): number {\n  work.charge('objectSteps');\n  let calls = 0;\n  const scalars: string[] = ['z'];\n  const wider: (string | {toString: () => string})[] = scalars;\n  wider.push({toString: () => {\n    work.charge('objectSteps');\n    calls += 1;\n    return 'a';\n  }});\n  r2Sorted(work, 'objectSteps', scalars);\n  return calls;\n}\n",
    expect: ["arrow", "mixed-elements", "mixed-elements", "sorted-made", "widening"],
  },
  {
    name: "r2/r2PathEntry",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nexport function r2PathEntry(work: R2Work, input: R2PathSteps): Generator<string> {\n  work.charge('objectSteps');\n  return r2Indexed(work, 'objectSteps', input);\n}\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r2/r2NominalEntry",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nexport function r2NominalEntry(work: R2Work): void {\n  work.charge('objectSteps');\n  work.charge('objectSteps');\n}\n",
    expect: [],
    residual: true,
  },
  {
    name: "r2/r2NativeEntry",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nexport function r2NativeEntry(work: R2Work, input: readonly string[]): string {\n  work.charge('objectSteps');\n  return r2Joined(work, 'objectSteps', input, '.');\n}\n",
    expect: [],
  },
  {
    name: "r2/r2AliasControl",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nexport function r2AliasControl(work: R2Work, input: readonly string[]): string {\n  work.charge('objectSteps');\n  const alias = input;\n  return r2Joined(work, 'objectSteps', alias, '.');\n}\n",
    expect: [],
  },
  {
    name: "r2/r2CallbackControl",
    source:
      "import { joinParts as r2JoinParts, type WorkLedger as R2Work } from '../budget.js';\nimport { sorted as r2Sorted, joined as r2Joined, indexed as r2Indexed, some as r2Some } from '../charged-iteration.js';\nimport type { PathSteps as R2PathSteps } from './key-ids.js';\nexport function r2CallbackControl(work: R2Work, input: readonly string[]): boolean {\n  work.charge('objectSteps');\n  return r2Some(work, 'objectSteps', input, (part) => part === 'x');\n}\n",
    expect: [],
  },
  {
    name: "r2/v2SortObject",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness() { work.charge('objectSteps'); return sorted(work, 'objectSteps', [{ toString: () => { work.charge('objectSteps'); return 'x'; } }]); }\n",
    expect: ["arrow", "sorted-made", "sorted-result"],
  },
  {
    name: "r2/v2NominalGetter",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nimport type { Other } from '../other.js';\nexport function witness(value: Other) { work.charge('objectSteps'); return value.text; }\n",
    expect: ["entry-parameter", "mixed-elements", "retained-outside"],
  },
  {
    name: "r2/v2Any",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\ndeclare const x: any;\nexport function witness() { work.charge('objectSteps'); return x.value; }\n",
    expect: ["any", "any", "mixed-elements"],
  },
  {
    name: "r2/v2BadWalk",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nimport type { KeyWalk } from './key-ids.js';\ndeclare const walk: KeyWalk;\nexport function witness() { work.charge('objectSteps'); return walk.prefix(1); }\n",
    expect: ["keywalk"],
  },
  {
    name: "r2/missingNativeOrigin",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\ndeclare const a: string[];\nexport function witness() { work.charge('objectSteps'); return a.pop(); }\n",
    expect: ["native-origin"],
  },
  {
    name: "r2/nonInlineCallback",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nfunction test(part: string) { work.charge('objectSteps'); return part === 'x'; }\nexport function witness(input: readonly string[]) { work.charge('objectSteps'); return some(work, 'objectSteps', input, test); }\n",
    expect: ["callback"],
  },
  {
    name: "r2/objectLiteralMethod",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nexport function witness() { work.charge('objectSteps'); return { method() { work.charge('objectSteps'); return 'x'; } }; }\n",
    expect: ["object-method"],
  },
  {
    name: "r2/wrongNominalIndexed",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nimport type { Other } from '../other.js';\nexport function witness(value: Other) { work.charge('objectSteps'); return indexed(work, 'objectSteps', value); }\n",
    expect: ["entry-parameter", "indexed-class", "mixed-elements"],
  },
  {
    name: "r2/nativeCustomConstructor",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { some, sorted, indexed } from '../charged-iteration.js';\ndeclare const work: WorkLedger;\nimport type { Other } from '../other.js';\nexport function witness(value: Other) { work.charge('objectSteps'); return new Set(value); }\n",
    expect: ["entry-parameter", "mixed-elements", "retained-collection"],
  },
  {
    name: "v3/controlEach",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger, input: readonly string[]): number { work.charge('objectSteps'); let n = 0; for (const _ of each(work, 'objectSteps', input)) n += 1; return n; }\n",
    expect: [],
  },
  {
    name: "v3/eachOrigin",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const loose: readonly string[];\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); let n = 0; for (const _ of each(work, 'objectSteps', loose)) n += 1; return n; }\n",
    expect: ["helper-origin"],
  },
  {
    name: "v3/controlCopied",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); const m = new Map<string, number>(); return copied(work, 'objectSteps', m.keys()); }\n",
    expect: [],
  },
  {
    name: "v3/copiedOrigin",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const loose: Iterable<string>;\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); return copied(work, 'objectSteps', loose); }\n",
    expect: ["helper-origin"],
  },
  {
    name: "v3/slicedOrigin",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const loose: readonly string[];\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); return sliced(work, 'objectSteps', loose, 1); }\n",
    expect: ["helper-origin"],
  },
  {
    name: "v3/joinedOrigin",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const loose: readonly string[];\nexport function f(work: WorkLedger): string { work.charge('objectSteps'); return joined(work, 'objectSteps', loose, '.'); }\n",
    expect: ["helper-origin"],
  },
  {
    name: "v3/someOrigin",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const loose: readonly string[];\nexport function f(work: WorkLedger): boolean { work.charge('objectSteps'); return some(work, 'objectSteps', loose, (s) => s === 'x'); }\n",
    expect: ["helper-origin"],
  },
  {
    name: "v3/controlIndexed",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { copied, indexed } from '../charged-iteration.js';\nimport { isPathSteps, keyWalk } from './key-ids.js';\nexport function f(work: WorkLedger, key: string): readonly string[] { work.charge('objectSteps'); const walk = keyWalk(key); return isPathSteps(walk.path) ? copied(work, 'objectSteps', indexed(work, 'objectSteps', walk.path)) : walk.path; }\n",
    expect: [],
  },
  {
    name: "v3/indexedArray",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { copied, indexed } from '../charged-iteration.js';\nexport function f(work: WorkLedger, input: readonly string[]): string[] { work.charge('objectSteps'); return copied(work, 'objectSteps', indexed(work, 'objectSteps', input)); }\n",
    expect: ["indexed-class"],
  },
  {
    name: "v3/controlSteps",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); let n = 0; for (const _ of steps(work, 'objectSteps', () => n < 3)) n += 1; return n; }\n",
    expect: [],
  },
  {
    name: "v3/stepsCallback",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const work: WorkLedger;\nfunction more(): boolean { work.charge('objectSteps'); return false; }\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); let n = 0; for (const _ of steps(work, 'objectSteps', more)) n += 1; return n; }\n",
    expect: ["callback"],
  },
  {
    name: "v3/controlConcatenated",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger, input: readonly string[]): string[] { work.charge('objectSteps'); return concatenated<string>(work, 'objectSteps', [input, ['x']]); }\n",
    expect: [],
  },
  {
    name: "v3/concatenatedOuter",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { concatenated } from '../charged-iteration.js';\nexport function f(work: WorkLedger, input: readonly string[]): string[] { work.charge('objectSteps'); const sources = [input]; return concatenated<string>(work, 'objectSteps', sources); }\n",
    expect: ["concatenated-literal"],
  },
  {
    name: "v3/concatenatedInner",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const loose: readonly string[];\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); return concatenated<string>(work, 'objectSteps', [loose]); }\n",
    expect: ["concatenated-origin"],
  },
  {
    name: "v3/controlSorted",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const m = new Map<string, number>(); const names = copied(work, 'objectSteps', m.keys()); sorted(work, 'objectSteps', names); return names.length; }\n",
    expect: [],
  },
  {
    name: "v3/sortedComparator",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); const names = ['b', 'a']; return sorted(work, 'objectSteps', names, (a, b) => (a < b ? -1 : 1)); }\n",
    expect: ["arrow", "comparator"],
  },
  {
    name: "v3/sortedAliased",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); const names = ['b', 'a']; const other = names; sorted(work, 'objectSteps', names); return other; }\n",
    expect: ["sorted-alias"],
  },
  {
    name: "v3/sortedNotMade",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger, input: string[]): string[] { work.charge('objectSteps'); return sorted(work, 'objectSteps', input); }\n",
    expect: ["sorted-made", "sorted-result"],
  },
  {
    name: "v3/widening",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const scalars: string[] = ['a']; const wider: readonly (string | number)[] = scalars; return wider.length; }\n",
    expect: ["widening"],
  },
  {
    name: "v3/mixedElements",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger, input: readonly (string | readonly string[])[]): number { work.charge('objectSteps'); return input.length; }\n",
    expect: ["entry-parameter", "mixed-elements"],
  },
  {
    name: "v3/controlNullable",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const xs: (Map<string, number> | null)[] = []; return xs.length; }\n",
    expect: [],
  },
  {
    name: "v3/overload",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const work: WorkLedger;\nfunction g(x: string): string;\nfunction g(x: string): string { work.charge('objectSteps'); return x; }\nexport function f(work: WorkLedger): string { work.charge('objectSteps'); return g('a'); }\n",
    expect: ["bodiless", "overload"],
  },
  {
    name: "v3/functionExpression",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): string { work.charge('objectSteps'); const g = function (): string { work.charge('objectSteps'); return 'a'; }; return g(); }\n",
    expect: ["callee", "function-expression"],
  },
  {
    name: "v3/controlConstArrow",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): string { work.charge('objectSteps'); const g = (): string => { work.charge('objectSteps'); return 'a'; }; return g(); }\n",
    expect: [],
  },
  {
    name: "v3/strayArrow",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): () => string { work.charge('objectSteps'); return () => { work.charge('objectSteps'); return 'a'; }; }\n",
    expect: ["arrow"],
  },
  {
    name: "v3/otherClass",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const work: WorkLedger;\nclass Other { #n = 0; m(): number { work.charge('objectSteps'); return this.#n; } }\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); return new Other().m(); }\n",
    expect: ["class", "construction", "local-member"],
  },
  {
    name: "v3/weakMap",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): WeakMap<object, number> { work.charge('objectSteps'); return new WeakMap(); }\n",
    expect: ["construction", "retained-outside"],
  },
  {
    name: "v3/unusedHelper",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { mapped } from '../charged-iteration.js';\nexport function f(work: WorkLedger, input: readonly string[]): string[] { work.charge('objectSteps'); return mapped(work, 'objectSteps', input, (s) => s); }\n",
    expect: ["arrow", "helper"],
  },
  {
    name: "v3/controlKeyWalk",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger, key: string): string { work.charge('objectSteps'); const walk = keyWalk(key); return walk.prefix(1); }\n",
    expect: [],
  },
  {
    name: "v3/keyWalkByName",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const work: WorkLedger;\nimport type { KeyWalk } from './key-ids.js';\nfunction keyWalkLocal(key: string): KeyWalk { work.charge('objectSteps'); return keyWalk(key); }\nexport function f(work: WorkLedger, key: string): string { work.charge('objectSteps'); const walk = keyWalkLocal(key); return walk.prefix(1); }\n",
    expect: ["keywalk"],
  },
  {
    name: "v3/controlNativeOrigin",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\nexport function f(work: WorkLedger): number | undefined { work.charge('objectSteps'); const m = new Map<string, number>(); m.set('a', 1); return m.get('a'); }\n",
    expect: [],
  },
  {
    name: "v3/controlLocalReturn",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const work: WorkLedger;\nfunction made(): Map<string, number> { work.charge('objectSteps'); return new Map(); }\nexport function f(work: WorkLedger): number | undefined { work.charge('objectSteps'); return made().get('a'); }\n",
    expect: [],
  },
  {
    name: "v3/localReturnOrigin",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nimport { each, steps, some, copied, sorted, indexed, concatenated, sliced, joined } from '../charged-iteration.js';\nimport { keyWalk, PathSteps } from './key-ids.js';\ndeclare const work: WorkLedger;\ndeclare const loose: Map<string, number>;\nfunction made(): Map<string, number> { work.charge('objectSteps'); return loose; }\nexport function f(work: WorkLedger): number | undefined { work.charge('objectSteps'); return made().get('a'); }\n",
    expect: ["native-origin"],
  },
  {
    name: "v3/sortedElements",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { copied, sorted } from '../charged-iteration.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const m = new Map<string, { readonly a: number }>(); const items = copied(work, 'objectSteps', m.values()); sorted(work, 'objectSteps', items); return items.length; }\n",
    expect: ["sorted-elements"],
  },
  {
    name: "v3/unresolvedCallee",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): void { work.charge('objectSteps'); undeclared(); }\n",
    expect: ["any", "any", "retained-unresolved", "unresolved"],
  },
  {
    name: "v3/unresolvedMember",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): void { work.charge('objectSteps'); nothing.m(); }\n",
    expect: ["any", "any", "any", "retained-unresolved", "unresolved"],
  },
  {
    name: "v3/mixedShapes",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const xs: ({ readonly a: number } | { readonly b: string })[] = []; return xs.length; }\n",
    expect: ["mixed-elements"],
  },
  {
    name: "v3/angleCast",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger, input: readonly string[]): number { work.charge('objectSteps'); const xs = <readonly string[]>input; return xs.length; }\n",
    expect: ["cast"],
  },
  {
    name: "r6/keyPath",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { keyPath } from '../definitions.js';\nexport function f(work: WorkLedger, key: string): number { work.charge('objectSteps'); return keyPath(key).length; }\n",
    expect: ["callee", "retained-outside"],
  },
  {
    name: "r6/heldReference",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { heldReference, type Item } from './kinds.js';\nexport function f(work: WorkLedger): boolean { work.charge('objectSteps'); const items: readonly Item[] = []; return heldReference(items); }\n",
    expect: ["callee", "retained-outside"],
  },
  {
    name: "r6/keptParts",
    source:
      "import { type WorkLedger, keptParts } from '../budget.js';\nexport function f(work: WorkLedger, input: readonly string[]): string { work.charge('objectSteps'); return keptParts(work, input); }\n",
    expect: ["callee", "retained-outside"],
  },
  {
    name: "r9/freshWrapperWidening",
    source:
      "import { type WorkLedger, joinParts } from '../budget.js';\nexport function f(work: WorkLedger, input: readonly string[]): string { work.charge('objectSteps'); const scalars: string[] = []; const boxes: { values: (string | readonly string[])[] }[] = [{ values: scalars }]; boxes[0]!.values.push(input); return joinParts(scalars[0]!); }\n",
    expect: ["mixed-elements", "widening"],
  },
  {
    name: "r9/freshLiteralWidening",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const items: readonly (string | number)[] = ['a']; return items.length; }\n",
    expect: ["widening"],
  },
  {
    name: "r9/sortedEachAlias",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { each, copied, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); const names = ['b', 'a']; for (const alias of each(work, 'objectSteps', [names])) alias.push('c'); return sorted(work, 'objectSteps', names); }\n",
    expect: ["sorted-alias", "sorted-alias", "sorted-result"],
  },
  {
    name: "r9/sortedCopiedAlias",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { each, copied, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); const names = ['b', 'a']; const aliases = copied(work, 'objectSteps', [names]); aliases[0]!.push('c'); return sorted(work, 'objectSteps', names); }\n",
    expect: ["sorted-alias", "sorted-alias", "sorted-result"],
  },
  {
    name: "r9/controlSortedConcatenated",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { each, copied, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work: WorkLedger): string[] { work.charge('objectSteps'); const names = ['b', 'a']; sorted(work, 'objectSteps', names); return concatenated<string>(work, 'objectSteps', [names, ['<']]); }\n",
    expect: [],
  },
  {
    name: "r9/controlSortedPrimitiveUnion",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { each, copied, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const names = ['b', 1]; sorted(work, 'objectSteps', names); return names.length; }\n",
    expect: [],
  },
  {
    name: "r9/exportListProtocol",
    source:
      "import { type WorkLedger } from '../budget.js';\nfunction g(work: WorkLedger, input: { readonly value: string }): string { work.charge('objectSteps'); return input.value; }\nexport { g };\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r9/exportArrowProtocol",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport const g = (work: WorkLedger, input: { readonly value: string }): string => { work.charge('objectSteps'); return input.value; };\n",
    expect: ["export-form"],
  },
  {
    name: "r9/entryAuditedArray",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger, input: readonly WorkLedger[]): number { work.charge('objectSteps'); return input.length; }\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r9/entryNullableNestedArray",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger, input: readonly (readonly string[] | null)[]): number { work.charge('objectSteps'); return input.length; }\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r9/mixedGenerator",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { each } from '../charged-iteration.js';\nfunction* source(work: WorkLedger, input: readonly string[]): Generator<string | readonly string[]> { work.charge('objectSteps'); yield 'x'; yield input; }\nexport function f(work: WorkLedger, input: readonly string[]): number { work.charge('objectSteps'); const items = source(work, input); let n = 0; for (const item of each(work, 'objectSteps', items)) n += item.length; return n; }\n",
    expect: ["mixed-elements", "mixed-elements"],
  },
  {
    name: "r9/controlGenerator",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { each } from '../charged-iteration.js';\nfunction* source(work: WorkLedger): Generator<string> { work.charge('objectSteps'); yield 'x'; }\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const items = source(work); let n = 0; for (const item of each(work, 'objectSteps', items)) n += item.length; return n; }\n",
    expect: [],
  },
  {
    name: "r9/unknownElement",
    source:
      "import { type WorkLedger } from '../budget.js';\nfunction read(work: WorkLedger, record: { [key: string]: unknown }): boolean { work.charge('objectSteps'); return typeof record['a'] === 'number'; }\nexport function f(work: WorkLedger): boolean { work.charge('objectSteps'); return read(work, { a: 1 }); }\n",
    expect: ["any"],
  },
  {
    name: "r9/anyElement",
    source:
      "import { type WorkLedger } from '../budget.js';\nfunction read(work: WorkLedger, record: { [key: string]: any }): boolean { work.charge('objectSteps'); return typeof record['a'] === 'number'; }\nexport function f(work: WorkLedger): boolean { work.charge('objectSteps'); return read(work, { a: 1 }); }\n",
    expect: ["any"],
  },
  {
    name: "r9/controlElement",
    source:
      "import { type WorkLedger } from '../budget.js';\nfunction read(work: WorkLedger, record: { [key: string]: number }): boolean { work.charge('objectSteps'); return record['a'] === 1; }\nexport function f(work: WorkLedger): boolean { work.charge('objectSteps'); return read(work, { a: 1 }); }\n",
    expect: [],
  },
  {
    name: "r9/nestedReturns",
    source:
      "import { type WorkLedger } from '../budget.js';\ndeclare const loose: Map<string, number>;\nfunction made(work: WorkLedger, choose: boolean): Map<string, number> { work.charge('objectSteps'); if (choose) return loose; return new Map(); }\nexport function f(work: WorkLedger, choose: boolean): number | undefined { work.charge('objectSteps'); return made(work, choose).get('x'); }\n",
    expect: ["native-origin"],
  },
  {
    name: "r9/keyWalkLet",
    source:
      "import { type WorkLedger } from '../budget.js';\nimport { keyWalk } from './key-ids.js';\nexport function f(work: WorkLedger, key: string): string { work.charge('objectSteps'); let walk = keyWalk(key); return walk.prefix(1); }\n",
    expect: ["keywalk"],
  },
  {
    name: "r9/wideningProperty",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const holder = { items: ['x'] }; const wider: readonly (string | number)[] = holder.items; return wider.length; }\n",
    expect: ["widening"],
  },
  {
    name: "r9/mixedSet",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const items = new Set<string | readonly string[]>(); return items.size; }\n",
    expect: ["mixed-elements"],
  },
  {
    name: "r10/newMapArray",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work,input:readonly string[]):string{work.charge('objectSteps');const scalars:string[]=[];const boxes:{values:Map<string,(string|readonly string[])[]>}[]=[{values:new Map([['x',scalars]])}];boxes[0]!.values.get('x')!.push(input);return joinParts(scalars[0]!);}\n",
    expect: ["mixed-elements", "widening"],
  },
  {
    name: "r10/newMapExplicit",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work,input:readonly string[]):string{work.charge('objectSteps');const scalars:string[]=[];const boxes:{values:Map<string,(string|readonly string[])[]>}[]=[{values:new Map<string,(string|readonly string[])[]>([['x',scalars]])}];boxes[0]!.values.get('x')!.push(input);return joinParts(scalars[0]!);}\n",
    expect: ["mixed-elements"],
  },
  {
    name: "r10/shorthand",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work,input:readonly string[]):string{work.charge('objectSteps');const values:string[]=[];const box:{values:(string|readonly string[])[]}={values};box.values.push(input);return joinParts(values[0]!);}\n",
    expect: ["mixed-elements", "native-origin", "widening"],
  },
  {
    name: "r10/conditional",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work,input:readonly string[],choose:boolean):string{work.charge('objectSteps');const scalars:string[]=[];const box:{values:(string|readonly string[])[]}={values:choose?scalars:[]};box.values.push(input);return joinParts(scalars[0]!);}\n",
    expect: ["mixed-elements", "native-origin", "widening"],
  },
  {
    name: "r10/capturedCall",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nfunction identity(work:R10Work,items:string[]):string[]{work.charge('objectSteps');return items;}\nexport function f(work:R10Work):number{work.charge('objectSteps');const xs:string[]=[];const box:{values:(string|readonly string[])[]}={values:identity(work,xs)};return box.values.length;}\n",
    expect: ["widening"],
  },
  {
    name: "r10/controlLiteral",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work):number{work.charge('objectSteps');const box:{values:(string|number)[]}={values:['x',1]};return box.values.length;}\n",
    expect: [],
  },
  {
    name: "r10/controlTrivialNew",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work):number{work.charge('objectSteps');const m:Map<string,number>=new Map();return m.size;}\n",
    expect: [],
  },
  {
    name: "r10/sortLength",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work):number{work.charge('objectSteps');const names=['b','a'];names.length=1;sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r10/sortResult",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work):number{work.charge('objectSteps');const names=['b','a'];const alias=sorted(work,'objectSteps',names);alias.push('c');sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias", "sorted-alias", "sorted-result"],
  },
  {
    name: "r10/sortReturned",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work):string[]{work.charge('objectSteps');const names=['b','a'];return sorted(work,'objectSteps',names);}\n",
    expect: ["sorted-alias", "sorted-result"],
  },
  {
    name: "r10/controlSortedStatement",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work):string[]{work.charge('objectSteps');const names=['b','a'];sorted(work,'objectSteps',names);return concatenated<string>(work,'objectSteps',[names]);}\n",
    expect: [],
  },
  {
    name: "r10/arrowAlias",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nconst arrow=(work:R10Work,input:{readonly value:string}):string=>{work.charge('objectSteps');return input.value;};const entry=arrow;export {entry};\n",
    expect: ["export-form"],
  },
  {
    name: "r10/defaultFunction",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport default function g(work:R10Work,input:{readonly value:string}):string{work.charge('objectSteps');return input.value;}\n",
    expect: ["entry-parameter"],
  },
  {
    name: "r10/defaultArrow",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport default (work:R10Work,input:{readonly value:string}):string=>{work.charge('objectSteps');return input.value;};\n",
    expect: ["arrow", "export-form"],
  },
  {
    name: "r10/defaultConst",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nconst arrow=(work:R10Work,input:{readonly value:string}):string=>{work.charge('objectSteps');return input.value;};export default arrow;\n",
    expect: ["export-form"],
  },
  {
    name: "r10/reexport",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport { heldReference as external } from './kinds.js';\n",
    expect: ["export-form"],
  },
  {
    name: "r10/controlReexportNamespace",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport * as external from './kinds.js';\n",
    expect: [],
  },
  {
    name: "r10/controlFunctionExport",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work,key:string):number{work.charge('objectSteps');return key.length;}\n",
    expect: [],
  },
  {
    name: "r10/genericAlias",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\ntype Stream<T>=Generator<string|T>;\nfunction* source(work:R10Work,input:readonly string[]):Stream<readonly string[]>{work.charge('objectSteps');yield 'x';yield input;}\nexport function f(work:R10Work,input:readonly string[]):number{work.charge('objectSteps');const items=source(work,input);let n=0;for(const item of each(work,'objectSteps',items))n+=item.length;return n;}\n",
    expect: ["mixed-elements", "mixed-elements"],
  },
  {
    name: "r10/permutedAlias",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\ntype Stream<A,B>=Iterable<B>;\nfunction* source(work:R10Work,input:readonly string[]):Stream<number,string|readonly string[]>{work.charge('objectSteps');yield 'x';yield input;}\nexport function f(work:R10Work,input:readonly string[]):number{work.charge('objectSteps');const items=source(work,input);let n=0;for(const item of each(work,'objectSteps',items))n+=item.length;return n;}\n",
    expect: ["mixed-elements", "mixed-elements"],
  },
  {
    name: "r10/yieldStar",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nfunction* source(work:R10Work,input:readonly string[]):Generator<string|readonly string[]>{work.charge('objectSteps');yield 'x';yield input;}\nexport function* f(work:R10Work,input:readonly string[]):Generator<string|readonly string[]>{work.charge('objectSteps');yield* each(work,'objectSteps',source(work,input));}\n",
    expect: ["mixed-elements"],
  },
  {
    name: "r10/iterableElement",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nfunction* source(work:R10Work,input:readonly string[]):Iterable<string|readonly string[]>{work.charge('objectSteps');yield 'x';yield input;}\nexport function f(work:R10Work,input:readonly string[]):number{work.charge('objectSteps');const items=source(work,input);let n=0;for(const item of each(work,'objectSteps',items))n+=item.length;return n;}\n",
    expect: ["mixed-elements", "mixed-elements"],
  },
  {
    name: "r10/controlGenericAlias",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\ntype Stream<T>=Generator<T>;\nfunction* source(work:R10Work):Stream<string>{work.charge('objectSteps');yield 'x';}\nexport function f(work:R10Work):number{work.charge('objectSteps');let n=0;for(const item of each(work,'objectSteps',source(work)))n+=item.length;return n;}\n",
    expect: [],
  },
  {
    name: "r10/unknownThisFunction",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nfunction read(this:unknown,work:R10Work):boolean{work.charge('objectSteps');return typeof this==='object';}\nexport function f(work:R10Work):boolean{work.charge('objectSteps');return read(work);}\n",
    expect: ["any", "mixed-elements"],
  },
  {
    name: "r10/anyThisFunction",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nfunction read(this:any,work:R10Work):boolean{work.charge('objectSteps');return typeof this==='object';}\nexport function f(work:R10Work):boolean{work.charge('objectSteps');return read(work);}\n",
    expect: ["any", "mixed-elements"],
  },
  {
    name: "r10/unknownYield",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nfunction* source(work:R10Work):Generator<string,void,unknown>{work.charge('objectSteps');typeof (yield 'x');}\nexport function f(work:R10Work):void{work.charge('objectSteps');for(const item of each(work,'objectSteps',source(work)))void item;}\n",
    expect: ["any"],
  },
  {
    name: "r10/controlYieldUnused",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nfunction* source(work:R10Work):Generator<string,void,unknown>{work.charge('objectSteps');yield 'x';}\nexport function f(work:R10Work):number{work.charge('objectSteps');let n=0;for(const item of each(work,'objectSteps',source(work)))n+=item.length;return n;}\n",
    expect: [],
  },
  {
    name: "r10/controlConditional",
    source:
      "import { type WorkLedger as R10Work, joinParts } from '../budget.js';\nimport { each, sorted, concatenated } from '../charged-iteration.js';\nexport function f(work:R10Work,choose:boolean):boolean{work.charge('objectSteps');return typeof (choose?1:null)==='number';}\n",
    expect: [],
  },
  {
    name: "r10/controlTypeLiteral",
    source:
      "import { type WorkLedger as R10Work } from '../budget.js';\nfunction g(work: R10Work, key: { readonly keys: readonly string[] }[\"keys\"][number]): number { work.charge('objectSteps'); return key.length; }\nexport function f(work: R10Work): number { work.charge('objectSteps'); return g(work, 'x'); }\n",
    expect: [],
  },
  {
    name: "r10/concatenatedMixedSource",
    source:
      "import { type WorkLedger as R10Work } from '../budget.js';\nimport { concatenated } from '../charged-iteration.js';\nfunction* source(work: R10Work, input: readonly string[]): Generator<string | readonly string[]> { work.charge('objectSteps'); yield 'x'; yield input; }\nexport function f(work: R10Work, input: readonly string[]): number { work.charge('objectSteps'); return concatenated<string | readonly string[]>(work, 'objectSteps', [source(work, input)]).length; }\n",
    expect: ["mixed-elements"],
  },
  {
    name: "r11/bitwise",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const value:string|number=~1;return typeof value === 'number' ? value : 0;}\n",
    expect: ["widening"],
  },
  {
    name: "r11/not",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):boolean{work.charge('objectSteps');const value:string|boolean=!0;return value === true;}\n",
    expect: ["widening"],
  },
  {
    name: "r11/controlSigned",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const value:string|number=-1;return typeof value === 'number' ? value : 0;}\n",
    expect: [],
  },
  {
    name: "r11/controlBoolean",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):boolean{work.charge('objectSteps');const value:string|boolean=true;return value === true;}\n",
    expect: [],
  },
  {
    name: "r11/parenAssign",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const names=['b','a'];(names.length)=1;sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r11/parenIncrement",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const names=['b','a'];++(names.length);sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r11/destructure",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const names=['b','a'];[names.length]=[1];sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r11/objectDestructure",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const names=['b','a'];({n:names.length}={n:1});sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r11/compoundWrite",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const names=['b','a'];names.length+=1;sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r11/controlLengthRead",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const names=['b','a'];const n=[names.length][0]!;sorted(work,'objectSteps',names);return n+names.length;}\n",
    expect: [],
  },
  {
    name: "r11/nullableExport",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nconst arrow=(work:R11Work,input:{value:string}):string=>{work.charge('objectSteps');return input.value;};export const entry='x'.length>0?arrow:null;\n",
    expect: ["export-form"],
  },
  {
    name: "r11/undefinedExport",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nconst arrow=(work:R11Work,input:{value:string}):string=>{work.charge('objectSteps');return input.value;};export const entry='x'.length>0?arrow:undefined;\n",
    expect: ["export-form"],
  },
  {
    name: "r11/constructableExport",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport class Gathered {constructor(work:R11Work){work.charge('objectSteps');}}\n",
    expect: ["export-form"],
  },
  {
    name: "r11/controlDataExport",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport const LIMIT = 4;\n",
    expect: [],
  },
  {
    name: "r11/interface",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\ninterface Stream<T> extends Generator<string|T>{}\nfunction* source(work:R11Work,input:readonly string[]):Stream<readonly string[]>{work.charge('objectSteps');yield 'x';yield input;}\nexport function f(work:R11Work,input:readonly string[]):number{work.charge('objectSteps');let n=0;for(const item of each(work,'objectSteps',source(work,input)))n+=item.length;return n;}\n",
    expect: ["collection-shape"],
  },
  {
    name: "r11/homogeneousInterface",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\ninterface Stream<T> extends Generator<T>{}\nfunction* source(work:R11Work):Stream<string>{work.charge('objectSteps');yield 'x';}\nexport function f(work:R11Work):number{work.charge('objectSteps');let n=0;for(const item of each(work,'objectSteps',source(work)))n+=item.length;return n;}\n",
    expect: ["collection-shape"],
  },
  {
    name: "r11/intersection",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\ntype Labelled<T>=Generator<T>&{readonly label?:string};\nfunction* source(work:R11Work,input:readonly string[]):Labelled<string|readonly string[]>{work.charge('objectSteps');yield 'x';yield input;}\nexport function f(work:R11Work,input:readonly string[]):number{work.charge('objectSteps');let n=0;for(const item of each(work,'objectSteps',source(work,input)))n+=item.length;return n;}\n",
    expect: ["collection-shape"],
  },
  {
    name: "r11/collectionUnion",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work,input:readonly string[],choose:boolean):number{work.charge('objectSteps');const items=choose?['x']:[input];let n=0;for(const item of each<string|readonly string[]>(work,'objectSteps',items))n+=item.length;return n;}\n",
    expect: ["mixed-elements", "mixed-elements"],
  },
  {
    name: "r11/mapStore",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R11Work,input:readonly string[]):number{work.charge('objectSteps');return new Map<string,string|readonly string[]>().set('x',input).size;}\n",
    expect: ["mixed-elements"],
  },
  {
    name: "r11/shorthandUnknown",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nfunction capture(work:R11Work,value:unknown):{value:unknown}{work.charge('objectSteps');return {value};}\nexport function f(work:R11Work):boolean{work.charge('objectSteps');return capture(work,'x') !== null;}\n",
    expect: ["any", "mixed-elements"],
  },
  {
    name: "r11/shorthandAny",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nfunction capture(work:R11Work,value:any):{value:any}{work.charge('objectSteps');return {value};}\nexport function f(work:R11Work):boolean{work.charge('objectSteps');return capture(work,'x') !== null;}\n",
    expect: ["any", "mixed-elements"],
  },
  {
    name: "r11/controlShorthandString",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nfunction capture(work:R11Work,value:string):{value:string}{work.charge('objectSteps');return {value};}\nexport function f(work:R11Work):number{work.charge('objectSteps');return capture(work,'x').value.length;}\n",
    expect: [],
  },
  {
    name: "r11/controlParenUnusedYield",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nfunction* source(work:R11Work):Generator<string,void,unknown>{work.charge('objectSteps');(yield 'x');}\nexport function f(work:R11Work):number{work.charge('objectSteps');let n=0;for(const item of each(work,'objectSteps',source(work)))n+=item.length;return n;}\n",
    expect: [],
  },
  {
    name: "r11/intersectionBinding",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\ntype Labelled<T>=Generator<T>&{readonly label?:string};\nfunction* source(work:R11Work,input:readonly string[]):Labelled<string|readonly string[]>{work.charge('objectSteps');yield 'x';yield input;}\nexport function f(work:R11Work,input:readonly string[]):boolean{work.charge('objectSteps');const items=source(work,input);return items.label===undefined;}\n",
    expect: ["mixed-elements"],
  },
  {
    name: "r11/controlSet",
    source:
      "import { type WorkLedger as R11Work } from '../budget.js';\nexport function f(work:R11Work):number{work.charge('objectSteps');const s=new Set<string>();s.add('x');return s.size;}\n",
    expect: [],
  },
  {
    name: "r12/nonNullNull",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R12Work):number{work.charge('objectSteps');const value:string|number=null!;return typeof value==='number'?value:0;}\n",
    expect: ["widening"],
  },
  {
    name: "r12/nonNullNumber",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R12Work):number{work.charge('objectSteps');const value:string|number=1!;return typeof value==='number'?value:0;}\n",
    expect: ["widening"],
  },
  {
    name: "r12/controlNull",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R12Work):number{work.charge('objectSteps');const value:string|null=null;return value===null?0:1;}\n",
    expect: [],
  },
  {
    name: "r12/shorthandCapture",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R12Work):number{work.charge('objectSteps');const names=['b','a'];const box={names};box.names.length=1;sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r12/exportList",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nfunction g(work:R12Work):number{work.charge('objectSteps');sorted(work,'objectSteps',names);return names.length;}\nconst names=['b','a'];\nexport { names, g };\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r12/exportedConst",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport const names=['b','a'];\nexport function g(work:R12Work):number{work.charge('objectSteps');sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r12/forOfWrite",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R12Work):number{work.charge('objectSteps');const names=['b','a'];for(names.length of each(work,'objectSteps',[1])){}sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r12/nonNullWrite",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport function f(work:R12Work):number{work.charge('objectSteps');const names=['b','a'];names.length!+=1;sorted(work,'objectSteps',names);return names.length;}\n",
    expect: ["sorted-alias"],
  },
  {
    name: "r12/unknownExport",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\nexport declare const hidden:unknown;\n",
    expect: ["export-form", "mixed-elements"],
  },
  {
    name: "r12/localIterable",
    source:
      "import { type WorkLedger as R12Work } from '../budget.js';\nimport { each, sorted } from '../charged-iteration.js';\ninterface Iterable<T> extends Generator<T>{}\nfunction* source(work:R12Work):Iterable<string>{work.charge('objectSteps');yield 'x';}\nexport function f(work:R12Work):number{work.charge('objectSteps');let n=0;for(const item of each(work,'objectSteps',source(work)))n+=item.length;return n;}\n",
    expect: ["collection-shape"],
  },
  {
    name: "r13/parenthesisedLiteral",
    source:
      "import { type WorkLedger } from '../budget.js';\nexport function f(work: WorkLedger): number { work.charge('objectSteps'); const value: string | number = (1); return typeof value === 'number' ? value : 0; }\n",
    expect: ["widening"],
  },
];
