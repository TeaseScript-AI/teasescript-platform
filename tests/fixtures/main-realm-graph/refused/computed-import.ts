export const load = (name: string): Promise<{ readonly value: number }> => import(`./${name}.js`);
