import type { PlayerToolColumnState, PlayerToolId } from "./model.js";

export function addToolColumn(
  columns: readonly PlayerToolColumnState[],
  id: string,
  toolOrder: readonly PlayerToolId[],
): readonly PlayerToolColumnState[] {
  if (columns.some((column) => column.id === id)) {
    throw new Error(`Duplicate Player tool column id: ${id}`);
  }

  const openTools = new Set(columns.flatMap((column) => column.toolId === null ? [] : [column.toolId]));
  const toolId = toolOrder.find((candidate) => !openTools.has(candidate)) ?? null;
  return [...columns, { id, toolId }];
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
  if (!columns.some((column) => column.id === id)) {
    throw new Error(`Unknown Player tool column: ${id}`);
  }
  if (columns.length === 1) {
    throw new Error("Cannot remove the final Player tool column.");
  }
  return columns.filter((column) => column.id !== id);
}
