// Markdown rendering, aligned with the OpenClaw control UI
// (ui/src/ui/markdown.ts): markdown-it + DOMPurify with an allowlist.
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});
md.enable("strikethrough");
md.linkify.set({ fuzzyLink: false });
md.use(markdownItTaskLists, { enabled: false, label: false });

const ALLOWED_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
  "img",
];

const ALLOWED_ATTRS = [
  "checked",
  "class",
  "disabled",
  "href",
  "rel",
  "target",
  "title",
  "start",
  "src",
  "alt",
  "type",
  "aria-label",
];

// Derive the config type from the sanitizer signature so it stays correct
// across dompurify versions (the `DOMPurify.Config` namespace is not always
// exported).
type SanitizeConfig = NonNullable<Parameters<typeof DOMPurify.sanitize>[1]>;

const SANITIZE_OPTIONS: SanitizeConfig = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: ALLOWED_ATTRS,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
};

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      const href = node.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noreferrer noopener");
      } else {
        node.removeAttribute("href");
      }
    }
    if (node.tagName === "IMG" && node.hasAttribute("src")) {
      const src = node.getAttribute("src") ?? "";
      if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(src)) {
        node.removeAttribute("src");
      }
    }
  });
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CHAR_LIMIT = 140_000;

function truncate(input: string): { text: string; truncated: boolean } {
  if (input.length <= CHAR_LIMIT) return { text: input, truncated: false };
  return { text: input.slice(0, CHAR_LIMIT), truncated: true };
}

// Render markdown to a sanitized HTML string. Safe to inject via v-html.
export function toSanitizedMarkdownHtml(markdown: string): string {
  const input = (markdown ?? "").trim();
  if (!input) return "";
  installHooks();
  const { text, truncated } = truncate(input);
  const withSuffix = truncated ? `${text}\n\n… (truncated)` : text;
  let rendered: string;
  try {
    rendered = md.render(withSuffix);
  } catch {
    rendered = `<pre class="code-block">${escapeHtml(withSuffix)}</pre>`;
  }
  return DOMPurify.sanitize(rendered, SANITIZE_OPTIONS) as unknown as string;
}
