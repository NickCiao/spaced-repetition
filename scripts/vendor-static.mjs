import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staticDir = join(root, "public", "static");

await mkdir(join(staticDir, "katex"), { recursive: true });
await cp(join(root, "node_modules", "katex", "dist", "katex.min.css"), join(staticDir, "katex", "katex.min.css"));
// woff2 only (like Phosphor below): katex.min.css lists woff2 first, so the
// woff/ttf fallbacks are never fetched by any browser this app supports.
await cp(join(root, "node_modules", "katex", "dist", "fonts"), join(staticDir, "katex", "fonts"), {
  recursive: true,
  filter: (src) => !/\.(woff|ttf)$/.test(src)
});

await mkdir(join(staticDir, "phosphor"), { recursive: true });
await cp(
  join(root, "node_modules", "@phosphor-icons", "web", "src", "regular", "Phosphor.woff2"),
  join(staticDir, "phosphor", "Phosphor.woff2")
);
const phosphorCss = await readFile(
  join(root, "node_modules", "@phosphor-icons", "web", "src", "regular", "style.css"),
  "utf8"
);
const woff2Only = phosphorCss.replace(
  /@font-face\s*\{[^}]+}/,
  `@font-face {
  font-family: "Phosphor";
  src: url("./Phosphor.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: block;
}`
);
await writeFile(join(staticDir, "phosphor", "style.css"), woff2Only);
