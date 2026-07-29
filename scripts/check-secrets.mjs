import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const textFile = /(?:^|\/)[^.]+\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|txt|css|html|py|sh|ini)$/i;
const secretPatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:OPENAI|ANTHROPIC|GOOGLE|AWS)_API_KEY\s*=\s*["']?(?!your_|replace_|<|\$\{|\s*(?:#|$))[A-Za-z0-9_-]{12,}/gi,
];

const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .filter((file) => file === ".gitignore" || textFile.test(file));

const findings = [];
for (const file of candidates) {
  const absolutePath = path.resolve(file);
  if (!statSync(absolutePath).isFile()) continue;
  const contents = readFileSync(absolutePath, "utf8");
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(contents)) findings.push(file);
  }
}

if (findings.length) {
  console.error(`Potential secret found in: ${[...new Set(findings)].join(", ")}`);
  process.exit(1);
}

console.log(`Secret scan passed (${candidates.length} commit-candidate text files).`);
