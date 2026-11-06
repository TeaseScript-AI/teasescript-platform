// Astra B1: an ESM import named `require` is refused too; the walk resolves no scopes.
import { allowed as require } from "../src/allowed.js";

export const imported = require;
