import type { SourceSpan } from "../source.js";

export const INSTRUCTION_PLAN_FORMAT = "teasescript-instruction-plan";
export const INSTRUCTION_PLAN_VERSION = 5;

export interface InstructionPlan {
  readonly format: typeof INSTRUCTION_PLAN_FORMAT;
  readonly version: typeof INSTRUCTION_PLAN_VERSION;
  readonly sourceSpan: SourceSpan;
  readonly rootEndInstruction: number;
  readonly temporaryCount: number;
  readonly functions: readonly CompiledFunctionDefinition[];
  readonly instructions: readonly Instruction[];
}

export interface CompiledFunctionParameter {
  readonly name: string;
  readonly index: number;
  readonly hasDefault: boolean;
  readonly declarationSpan: SourceSpan;
  readonly defaultSpan: SourceSpan | null;
}

export interface CompiledFunctionDefinition {
  readonly id: number;
  readonly name: string;
  readonly declarationSpan: SourceSpan;
  readonly parameters: readonly CompiledFunctionParameter[];
  readonly entryInstruction: number;
  readonly bodyEntryInstruction: number;
  readonly implicitReturnInstruction: number;
  readonly endInstruction: number;
  readonly bodySpan: SourceSpan;
}

export type Instruction =
  | DeclareSpeakerInstruction
  | SetDeclaredSpeakerPropertyInstruction
  | SetDefaultSpeakerInstruction
  | EnterScopeInstruction
  | LeaveScopeInstruction
  | DeclareBindingInstruction
  | PrepareReferenceInstruction
  | ValidateAssignmentTargetInstruction
  | AssignInstruction
  | ValidateCallReceiverInstruction
  | EvaluateInstruction
  | JumpIfFalseInstruction
  | JumpInstruction
  | LoopStartInstruction
  | LoopControlInstruction
  | StoreTemporaryInstruction
  | ClearTemporaryInstruction
  | CallFunctionInstruction
  | BindSuppliedParameterInstruction
  | BeginFunctionDefaultsInstruction
  | PrepareParameterDefaultInstruction
  | BindDefaultParameterInstruction
  | EnterFunctionBodyInstruction
  | ReturnValueInstruction
  | ReturnVoidInstruction
  | SayInstruction
  | WaitInstruction
  | InteractionInstruction
  | ExitInstruction;

interface InstructionBase {
  readonly span: SourceSpan;
}

export interface DeclareSpeakerInstruction extends InstructionBase {
  readonly kind: "declareSpeaker";
  readonly name: string;
  readonly properties: readonly PlannedProperty[];
}

export interface SetDeclaredSpeakerPropertyInstruction extends InstructionBase {
  readonly kind: "setDeclaredSpeakerProperty";
  readonly speaker: string;
  readonly name: string;
  readonly value: ExpressionPlan;
}

export interface SetDefaultSpeakerInstruction extends InstructionBase {
  readonly kind: "setDefaultSpeaker";
  readonly name: string;
}

export interface EnterScopeInstruction extends InstructionBase {
  readonly kind: "enterScope";
}

export interface LeaveScopeInstruction extends InstructionBase {
  readonly kind: "leaveScope";
}

export interface DeclareBindingInstruction extends InstructionBase {
  readonly kind: "declareBinding";
  readonly name: string;
  readonly value: ExpressionPlan;
}

export interface AssignInstruction extends InstructionBase {
  readonly kind: "assign";
  readonly target: AssignmentTargetPlan;
  readonly value: ExpressionPlan;
}

export interface ValidateAssignmentTargetInstruction extends InstructionBase {
  readonly kind: "validateAssignmentTarget";
  readonly target: AssignmentTargetPlan;
}

export interface PrepareReferenceInstruction extends InstructionBase {
  readonly kind: "prepareReference";
  readonly expression: ExpressionPlan;
  readonly destinationTemporary: number;
}

export interface ValidateCallReceiverInstruction extends InstructionBase {
  readonly kind: "validateCallReceiver";
  readonly receiver: ExpressionPlan;
  readonly method: string;
}

export interface EvaluateInstruction extends InstructionBase {
  readonly kind: "evaluate";
  readonly expression: ExpressionPlan;
}

export interface JumpIfFalseInstruction extends InstructionBase {
  readonly kind: "jumpIfFalse";
  readonly condition: ExpressionPlan;
  readonly target: number;
}

export interface JumpInstruction extends InstructionBase {
  readonly kind: "jump";
  readonly target: number;
}

export type LoopStartInstruction =
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "repeat";
      readonly loopId: number;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "for";
      readonly loopId: number;
      readonly variable: string;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    })
  | (InstructionBase & {
      readonly kind: "loopStart";
      readonly loopKind: "while";
      readonly loopId: number;
      readonly expression: ExpressionPlan;
      readonly continueTarget: number;
      readonly target: number;
    });

export interface LoopControlInstruction extends InstructionBase {
  readonly kind: "loopControl";
  readonly action: "break" | "continue";
  readonly loopId: number;
  readonly target: number;
}

export interface StoreTemporaryInstruction extends InstructionBase {
  readonly kind: "storeTemporary";
  readonly temporaryId: number;
  readonly value: ExpressionPlan;
  readonly expectBoolean: boolean;
}

export interface ClearTemporaryInstruction extends InstructionBase {
  readonly kind: "clearTemporary";
  readonly temporaryId: number;
}

export interface PreparedCallArgument {
  readonly parameterName: string;
  readonly temporaryId: number;
  readonly span: SourceSpan;
}

export interface CallFunctionInstruction extends InstructionBase {
  readonly kind: "callFunction";
  readonly functionId: number;
  readonly arguments: readonly PreparedCallArgument[];
  readonly destinationTemporary: number;
  readonly returnInstruction: number;
}

interface FunctionParameterInstructionBase extends InstructionBase {
  readonly functionId: number;
  readonly parameterIndex: number;
}

export interface BindSuppliedParameterInstruction extends FunctionParameterInstructionBase {
  readonly kind: "bindSuppliedParameter";
}

export interface BeginFunctionDefaultsInstruction extends InstructionBase {
  readonly kind: "beginFunctionDefaults";
  readonly functionId: number;
}

export interface PrepareParameterDefaultInstruction extends FunctionParameterInstructionBase {
  readonly kind: "prepareParameterDefault";
  readonly target: number;
}

export interface BindDefaultParameterInstruction extends FunctionParameterInstructionBase {
  readonly kind: "bindDefaultParameter";
  readonly value: ExpressionPlan;
}

export interface EnterFunctionBodyInstruction extends InstructionBase {
  readonly kind: "enterFunctionBody";
  readonly functionId: number;
}

export interface ReturnValueInstruction extends InstructionBase {
  readonly kind: "returnValue";
  readonly value: ExpressionPlan;
}

export interface ReturnVoidInstruction extends InstructionBase {
  readonly kind: "returnVoid";
}

export interface SayInstruction extends InstructionBase {
  readonly kind: "say";
  readonly speaker: string | null;
  readonly value: ExpressionPlan;
}

export interface WaitInstruction extends InstructionBase {
  readonly kind: "wait";
  readonly duration: ExpressionPlan;
  readonly unit: "ms" | "s" | "min" | "h" | null;
}

export type InteractionKind = "button" | "text" | "number" | "choice";
export type InteractionResultDomain = "none" | "string" | "number";
export type InteractionAccessibleName =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "localizedDefault"; readonly key: "answer" | "number" | "chooseOption" | "continue" };
export type InteractionChoiceOption =
  | { readonly text: string; readonly label: null }
  | { readonly text: string; readonly label: string }
  | { readonly text: string; readonly label: number };
export type InteractionUiPayload =
  | { readonly kind: "button"; readonly buttonLabel: string; readonly accessibleName: InteractionAccessibleName }
  | { readonly kind: "text" | "number"; readonly hint: string | null; readonly accessibleName: InteractionAccessibleName }
  | { readonly kind: "choice"; readonly labelType: "none" | "identifier" | "number"; readonly options: readonly InteractionChoiceOption[]; readonly accessibleName: InteractionAccessibleName };

/** Compiler/Standard-Library prepared foreground interaction. No source syntax is added by this slice. */
export interface InteractionInstruction extends InstructionBase {
  readonly kind: "interaction";
  readonly interactionKind: InteractionKind;
  readonly target: "standardChat";
  readonly speaker: string | null;
  readonly destinationTemporary: number | null;
  readonly expectedResult: InteractionResultDomain;
  readonly ui: InteractionUiPayload;
}

export interface ExitInstruction extends InstructionBase {
  readonly kind: "exit";
}

export interface PlannedProperty {
  readonly name: string;
  readonly value: ExpressionPlan;
  readonly span: SourceSpan;
}

export type AssignmentTargetPlan =
  | IdentifierExpressionPlan
  | PropertyExpressionPlan
  | IndexExpressionPlan;

export type ExpressionPlan =
  | LiteralExpressionPlan
  | IdentifierExpressionPlan
  | ListExpressionPlan
  | ObjectExpressionPlan
  | SetExpressionPlan
  | GroupExpressionPlan
  | TemplateExpressionPlan
  | PropertyExpressionPlan
  | IndexExpressionPlan
  | CallExpressionPlan
  | UnaryExpressionPlan
  | BinaryExpressionPlan
  | RangeExpressionPlan
  | TemporaryExpressionPlan
  | PreparedReferenceExpressionPlan;

interface ExpressionPlanBase {
  readonly span: SourceSpan;
}

export interface LiteralExpressionPlan extends ExpressionPlanBase {
  readonly kind: "literal";
  readonly value: string | number | boolean | null;
}

export interface IdentifierExpressionPlan extends ExpressionPlanBase {
  readonly kind: "identifier";
  readonly name: string;
}

export interface TemporaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "temporary";
  readonly temporaryId: number;
}

export interface PreparedReferenceExpressionPlan extends ExpressionPlanBase {
  readonly kind: "preparedReference";
  readonly temporaryId: number;
}

export interface ListExpressionPlan extends ExpressionPlanBase {
  readonly kind: "list";
  readonly elements: readonly ExpressionPlan[];
}

export interface ObjectExpressionPlan extends ExpressionPlanBase {
  readonly kind: "object";
  readonly properties: readonly PlannedProperty[];
}

export interface SetExpressionPlan extends ExpressionPlanBase {
  readonly kind: "set";
  readonly elements: readonly ExpressionPlan[];
}

export interface GroupExpressionPlan extends ExpressionPlanBase {
  readonly kind: "group";
  readonly expression: ExpressionPlan;
}

export type TemplatePartPlan =
  | {
      readonly kind: "text";
      readonly value: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "expression";
      readonly expression: ExpressionPlan;
      readonly span: SourceSpan;
    };

export interface TemplateExpressionPlan extends ExpressionPlanBase {
  readonly kind: "template";
  readonly parts: readonly TemplatePartPlan[];
}

export interface PropertyExpressionPlan extends ExpressionPlanBase {
  readonly kind: "property";
  readonly object: ExpressionPlan;
  readonly name: string;
}

export interface IndexExpressionPlan extends ExpressionPlanBase {
  readonly kind: "index";
  readonly object: ExpressionPlan;
  readonly index: ExpressionPlan;
}

export type ArgumentPlan =
  | {
      readonly kind: "positional";
      readonly value: ExpressionPlan;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: "named";
      readonly name: string;
      readonly value: ExpressionPlan;
      readonly span: SourceSpan;
    };

export interface CallExpressionPlan extends ExpressionPlanBase {
  readonly kind: "call";
  readonly callee: ExpressionPlan;
  readonly arguments: readonly ArgumentPlan[];
}

export interface UnaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "unary";
  readonly operator: "+" | "-" | "not";
  readonly operand: ExpressionPlan;
}

export interface BinaryExpressionPlan extends ExpressionPlanBase {
  readonly kind: "binary";
  readonly operator:
    | "*"
    | "/"
    | "%"
    | "+"
    | "-"
    | "=="
    | "!="
    | "<"
    | "<="
    | ">"
    | ">="
    | "and"
    | "or";
  readonly left: ExpressionPlan;
  readonly right: ExpressionPlan;
}

export interface RangeExpressionPlan extends ExpressionPlanBase {
  readonly kind: "range";
  readonly start: ExpressionPlan;
  readonly end: ExpressionPlan;
  readonly inclusive: boolean;
}
