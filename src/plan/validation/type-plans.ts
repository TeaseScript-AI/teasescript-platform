import { VALUE_KIND_NAMES, VALUE_KINDS } from "../../value-kinds.js";
import {
  type PlanValidationError,
  isRecord,
  isOneOf,
  planError,
  rejectUnknownFields,
  requireString,
} from "../validation-support.js";

// The types a plan names: in runtime type checks, type tests, storage key types, and prepared form answers.

/** Validates the optional `typeCheck` of a receiving instruction, call argument, or `add` call. */
export function validateOptionalTypeCheck(
  owner: Record<string, unknown>,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!("typeCheck" in owner)) return;
  const check = owner.typeCheck;
  const checkPath = `${path}.typeCheck`;
  if (!isRecord(check)) {
    errors.push(planError("TSC002", "A type check must be an object.", checkPath));
    return;
  }
  rejectUnknownFields(check, ["type", "place"], checkPath, errors);
  requireString(check.place, `${checkPath}.place`, errors);
  validateTypePlan(check.type, `${checkPath}.type`, errors);
}

/** Validates a type of a runtime type check or a type test, iteratively for deep types. */
export function validateTypePlan(
  root: unknown,
  rootPath: string,
  errors: PlanValidationError[],
): void {
  const pending: { readonly value: unknown; readonly path: string }[] = [
    { value: root, path: rootPath },
  ];
  while (pending.length > 0) {
    const { value: type, path: typePath } = pending.pop()!;
    if (!isRecord(type)) {
      errors.push(planError("TSC002", "A type must be an object.", typePath));
      continue;
    }
    switch (type.kind) {
      case "list":
      case "set":
      case "dict":
        rejectUnknownFields(type, ["kind", "element"], typePath, errors);
        if (type.element !== null)
          pending.push({ value: type.element, path: `${typePath}.element` });
        break;
      case "object": {
        rejectUnknownFields(type, ["kind", "properties"], typePath, errors);
        if (!Array.isArray(type.properties)) {
          errors.push(
            planError(
              "TSC002",
              "Object type properties must be an array.",
              `${typePath}.properties`,
            ),
          );
          break;
        }
        const names = new Set<unknown>();
        type.properties.forEach((property: unknown, index) => {
          const propertyPath = `${typePath}.properties[${index}]`;
          if (!isRecord(property)) {
            errors.push(
              planError("TSC002", "An object type property must be an object.", propertyPath),
            );
            return;
          }
          rejectUnknownFields(property, ["name", "type"], propertyPath, errors);
          requireString(property.name, `${propertyPath}.name`, errors);
          if (names.has(property.name))
            errors.push(
              planError(
                "TSC002",
                "Object type property names must be unique.",
                `${propertyPath}.name`,
              ),
            );
          names.add(property.name);
          pending.push({ value: property.type, path: `${propertyPath}.type` });
        });
        break;
      }
      case "union":
        rejectUnknownFields(type, ["kind", "members"], typePath, errors);
        if (!Array.isArray(type.members) || type.members.length === 0) {
          errors.push(
            planError("TSC002", "A union type needs at least one member.", `${typePath}.members`),
          );
          break;
        }
        type.members.forEach((member: unknown, index) =>
          pending.push({ value: member, path: `${typePath}.members[${index}]` }),
        );
        break;
      default:
        if (isOneOf(type.kind, TYPE_PLAN_NAMES))
          rejectUnknownFields(type, ["kind"], typePath, errors);
        else errors.push(planError("TSC002", "Unknown type kind.", `${typePath}.kind`));
    }
  }
}

/**
 * The types a plan names without parts (`TypePlanName`): every kind of value but collections and objects (`VALUE_KINDS`),
 * and `never`. Each check of a value of one of them validates the value itself.
 */
const TYPE_PLAN_NAMES: readonly string[] = [
  ...VALUE_KIND_NAMES.filter((kind) => VALUE_KINDS[kind].type !== "parts"),
  "never",
];
