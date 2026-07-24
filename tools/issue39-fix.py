from pathlib import Path

path = Path("src/instructions.ts")
text = path.read_text()
gated = '''    const functionErrorCount = errors.length;
    validateFunctionDefinitions(
      value.functions,
      value.instructions,
      value.rootEndInstruction,
      errors,
    );
    if (errors.length === functionErrorCount) {
      validateInstructionControlFlowRegions(
        value.instructions,
        value.rootEndInstruction,
        value.functions,
        errors,
      );
    }'''
direct = '''    validateFunctionDefinitions(
      value.functions,
      value.instructions,
      value.rootEndInstruction,
      errors,
    );
    validateInstructionControlFlowRegions(
      value.instructions,
      value.rootEndInstruction,
      value.functions,
      errors,
    );'''
if gated in text:
    text = text.replace(gated, direct, 1)
elif direct not in text:
    raise SystemExit("instruction region validation call site not found")

replacements = {
    '''        validateInstructionRegionTarget(
instruction.target,
`${instructionPath}.target`,
instructions.length,
region,
errors,
        );''': '''        validateInstructionRegionTarget(
          instruction.target,
          `${instructionPath}.target`,
          instructions.length,
          region,
          errors,
        );''',
    '''        validateInstructionRegionTarget(
instruction.continueTarget,
`${instructionPath}.continueTarget`,
instructions.length,
region,
errors,
        );''': '''        validateInstructionRegionTarget(
          instruction.continueTarget,
          `${instructionPath}.continueTarget`,
          instructions.length,
          region,
          errors,
        );''',
    '''        validateInstructionRegionTarget(
instruction.returnInstruction,
`${instructionPath}.returnInstruction`,
instructions.length,
region,
errors,
        );''': '''        validateInstructionRegionTarget(
          instruction.returnInstruction,
          `${instructionPath}.returnInstruction`,
          instructions.length,
          region,
          errors,
        );''',
}
for old, new in replacements.items():
    text = text.replace(old, new)
path.write_text(text)
