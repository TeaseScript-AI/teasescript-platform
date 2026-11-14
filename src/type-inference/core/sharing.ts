// For the tests (#1203): the published records and the lowered plan must be the same with sharing on or off.

let shared = true;

/** Whether answers may be shared between equivalent values (false only inside `withoutSharing`). */
export function sharing(): boolean {
  return shared;
}

export function withoutSharing<T>(callback: () => T): T {
  const before = shared;
  shared = false;
  try {
    return callback();
  } finally {
    shared = before;
  }
}
