import type { PlayerToolColumnState, PlayerToolId } from "./model.js";

export function addToolColumn(
  columns: readonly PlayerToolColumnState[],
  id: string,
): readonly PlayerToolColumnState[] {
  if (columns.some((column) => column.id === id)) {
    throw new Error(`Duplicate Player tool column id: ${id}`);
  }

  return [...columns, { id, toolId: null }];
}

export function ensureToolColumn(
  columns: readonly PlayerToolColumnState[],
  id: string,
): readonly PlayerToolColumnState[] {
  return columns.length === 0 ? addToolColumn(columns, id) : columns;
}

export function selectToolColumn(
  columns: readonly PlayerToolColumnState[],
  id: string,
  toolId: PlayerToolId,
): readonly PlayerToolColumnState[] {
  let found = false;
  const next = columns.map((column) => {
    if (column.id !== id) return column;
    found = true;
    return { ...column, toolId };
  });

  if (!found) {
    throw new Error(`Unknown Player tool column: ${id}`);
  }

  return next;
}

export function closeToolColumn(
  columns: readonly PlayerToolColumnState[],
  id: string,
): readonly PlayerToolColumnState[] {
  const next = columns.filter((column) => column.id !== id);
  if (next.length === columns.length) {
    throw new Error(`Unknown Player tool column: ${id}`);
  }
  return next;
}
