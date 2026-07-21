// Minimal ambient declaration for the js-yaml surface the Open Legend importer uses
// (issue #346). The package ships no bundled types and @types/js-yaml is not installed in
// this workspace; we only call `load`, so declaring just that keeps `strict` TS happy
// without pulling in the full DefinitelyTyped package.
declare module 'js-yaml' {
  export function load(input: string, options?: unknown): unknown;
}
