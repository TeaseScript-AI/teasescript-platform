type DefinedProps<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

// Omit missing values instead of forwarding explicit undefined to exact optional props.
export function definedProps<T extends object>(props: T): DefinedProps<T> {
  return Object.fromEntries(
    Object.entries(props).filter(([, value]) => value !== undefined),
  ) as DefinedProps<T>;
}
