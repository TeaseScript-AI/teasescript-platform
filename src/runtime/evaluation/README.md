# Evaluation

The expression families that `evaluator.ts` calls, as functions that take the evaluator.

- `access.ts`: reading a property or an element.
- `assignment.ts`: assignment and its checks, and preparing, restoring, and resolving prepared references.
- `bindings.ts`: which binding a name refers to.
- `collections.ts`: list, set, and dict methods.
- `draws.ts`: random functions, random elements, shuffles, and image tag queries.
- `effect-facts.ts`: what evaluating an expression may do besides giving its value.
- `handles.ts`: the methods and properties of timer, media, message, camera-view, and permanent-button handles.
- `lowered-operands.ts`: what the plan says about the temporaries that hold lowered operands.
- `operators.ts`: binary operators and their operand diagnostics.
- `speakers.ts`: speakers, the account copy, and the text a say shows.
- `support.ts`: what the evaluator and the families share, such as `USE_DEFAULT`.
