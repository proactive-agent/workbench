// Font files imported from TypeScript resolve to their bundled URL (Vite asset import)
declare module '*.otf' {
  const url: string;
  export default url;
}
