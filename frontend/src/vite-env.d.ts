/// <reference types="svelte" />
/// <reference types="vite/client" />

// esp-web-tools が定義する Custom Element（実装仕様書 §7.2）。svelte-check に
// 未知要素として警告されないよう、Svelte の要素型を拡張する。
declare module "svelte/elements" {
  export interface SvelteHTMLElements {
    "esp-web-install-button": import("svelte/elements").HTMLAttributes<HTMLElement> & {
      manifest?: string;
    };
  }
}
