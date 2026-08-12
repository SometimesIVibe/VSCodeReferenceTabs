// Webview-side syntax-highlighting bundle. Built by esbuild (see
// esbuild.mjs) into `media/hljs.js` as a minified IIFE for the `browser`
// platform, loaded via its own nonce'd <script> tag before `media/panel.js`.
//
// Intentionally uses `highlight.js/lib/core` plus a curated language
// registration list (not the full `highlight.js` bundle) to keep the
// webview payload small — the panel only ever needs to highlight short,
// single-line previews for a handful of common languages.
//
// Exposes `window.refTabsHljs.highlight(code, lang)` to plain-JS
// `media/panel.js`, which has no module system of its own.

import hljs from "highlight.js/lib/core";

import csharp from "highlight.js/lib/languages/csharp";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import java from "highlight.js/lib/languages/java";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";

hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("java", java);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("bash", bash);

/**
 * Highlights a snippet of `code` as `lang`, returning hljs' HTML output
 * (a sequence of `<span class="hljs-...">` wrapped tokens over
 * HTML-escaped text), or `null` if `lang` isn't one of the registered
 * languages above — callers should fall back to plain escaped text.
 */
function highlight(code, lang) {
  if (!lang || !hljs.getLanguage(lang)) {
    return null;
  }
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

window.refTabsHljs = { highlight };
