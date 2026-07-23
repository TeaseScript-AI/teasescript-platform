export {
  createDiagnostic,
  DiagnosticSeverity,
  type Diagnostic,
} from "./diagnostics.js";
export { lex, type LexResult } from "./lexer.js";
export { parse, type ParseResult } from "./parser.js";
export {
  compileSource,
  type CompilationResult,
  type CompileOptions,
} from "./compiler.js";
export {
  compileProgram,
  INSTRUCTION_PLAN_FORMAT,
  INSTRUCTION_PLAN_VERSION,
  validateInstructionPlan,
  type ArgumentPlan,
  type AssignmentTargetPlan,
  type ExpressionPlan,
  type Instruction,
  type InstructionPlan,
  type PlanValidationError,
  type PlanValidationResult,
} from "./instructions.js";
export {
  validateSemantics,
  type SemanticValidationOptions,
  type SemanticValidationResult,
} from "./semantic.js";
export {
  execute,
  Interpreter,
  type BuiltinCall,
  type BuiltinFunction,
  type ExecutionResult,
  type InterpreterOptions,
  type RandomSource,
} from "./runtime/interpreter.js";
export type { RuntimeErrorInfo } from "./runtime/errors.js";
export type { RuntimeWarningInfo } from "./runtime/warnings.js";
export type {
  ExitEvent,
  CompleteEvent,
  DeveloperWarningEvent,
  InterpreterEvent,
  OutputSpeaker,
  RuntimeFailureEvent,
  SayEvent,
} from "./runtime/events.js";
export {
  executeInstruction,
  run,
  RuntimeDataError,
  stepToEvent,
  type RuntimeBuiltinFunction,
  type RuntimeCapabilities,
  type RuntimeCapabilityCall,
  type RuntimeOperationResult,
  type RuntimeRunOptions,
} from "./runtime/engine.js";
export {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
  type CheckpointErrorInfo,
  type RuntimeCheckpoint,
} from "./runtime/checkpoint.js";
export {
  createFreshRuntimeSnapshot,
  RUNTIME_SNAPSHOT_FORMAT,
  RUNTIME_SNAPSHOT_VERSION,
  validateRuntimeSnapshot,
  type FreshRuntimeOptions,
  type RuntimeBindingSnapshot,
  type RuntimeFailureSnapshot,
  type RuntimeScopeFrameSnapshot,
  type RuntimeSnapshot,
  type RuntimeSpeakerSnapshot,
  type RuntimeStatus,
  type SnapshotValidationResult,
} from "./runtime/state.js";
export {
  DEFAULT_PLAYGROUND_SEED,
  createXorShift32State,
  nextXorShift32,
  XORSHIFT32_ALGORITHM,
  type XorShift32State,
} from "./runtime/random.js";
export {
  cloneSerializableValue,
  createSerializableList,
  createSerializableObject,
  createSerializableSet,
  type SerializableRuntimeList,
  type SerializableRuntimeObject,
  type SerializableRuntimeProperty,
  type SerializableRuntimeScalar,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
  type SerializableSpeakerReference,
} from "./runtime/serializable-values.js";
export {
  createRuntimeList,
  createRuntimeObject,
  createRuntimeSet,
  createRuntimeSpeaker,
  type RuntimeList,
  type RuntimeObject,
  type RuntimeScalar,
  type RuntimeSet,
  type RuntimeSpeaker,
  type RuntimeValue,
} from "./runtime/values.js";
export {
  combineSourceSpans,
  createSourcePosition,
  createSourceSpan,
  type SourcePosition,
  type SourceSpan,
} from "./source.js";
export { createToken, TokenKind, type Token } from "./token.js";
export type {
  AssignmentStatement,
  AssignmentTarget,
  BinaryExpression,
  Block,
  BooleanLiteral,
  CallArgument,
  CallExpression,
  ExitStatement,
  Expression,
  ExpressionStatement,
  Identifier,
  IfStatement,
  IndexExpression,
  InterpolationExpression,
  LetStatement,
  ListLiteral,
  NamedArgument,
  NullLiteral,
  NumberLiteral,
  ObjectLiteral,
  ObjectProperty,
  ParenthesizedExpression,
  PositionalArgument,
  Program,
  PropertyAccessExpression,
  ScalarTypeName,
  SayStatement,
  SetLiteral,
  SpeakerDeclaration,
  SpeakerProperty,
  SpeakerSetterStatement,
  Statement,
  StringExpression,
  StringLiteral,
  TemplateInterpolation,
  TemplateLiteral,
  TemplatePart,
  TemplateText,
  TypeAnnotation,
  UnaryExpression,
} from "./ast.js";
