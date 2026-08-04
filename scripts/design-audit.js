const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'src');
const extensions = new Set(['.ts', '.tsx']);
const allowedRawColor = new Set([
  path.join(sourceRoot, 'constants', 'colors.ts'),
  path.join(sourceRoot, 'design', 'tokens.ts'),
  path.join(sourceRoot, 'components', 'ui', 'AssetGlyph.tsx'),
  path.join(sourceRoot, 'components', 'ErrorBoundary.tsx'),
  path.join(sourceRoot, 'app', 'deposit', '[asset]', '[chain].tsx'),
]);
const allowedVisualValues = new Set([
  path.join(sourceRoot, 'design', 'tokens.ts'),
  path.join(sourceRoot, 'design', 'typography.ts'),
  path.join(sourceRoot, 'constants', 'colors.ts'),
  path.join(sourceRoot, 'components', 'ui', 'AssetGlyph.tsx'),
  path.join(sourceRoot, 'components', 'ui', 'Money.tsx'),
  path.join(sourceRoot, 'components', 'ui', 'Text.tsx'),
  path.join(sourceRoot, 'components', 'ErrorBoundary.tsx'),
]);

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(target);
    return extensions.has(path.extname(entry.name)) ? [target] : [];
  });
}

const failures = [];
const advisories = [];

for (const file of filesIn(sourceRoot)) {
  const text = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    if (!allowedRawColor.has(file) && /#[0-9a-fA-F]{3,8}\b/.test(line)) {
      failures.push(`${relative}:${index + 1} raw color`);
    }
    if (/['"]@\/constants\/theme['"]/.test(line)) {
      failures.push(`${relative}:${index + 1} legacy theme import`);
    }
    if (!allowedVisualValues.has(file) && /\bfontSize\s*:/.test(line)) {
      advisories.push(`${relative}:${index + 1} local font size`);
    }
    if (!allowedVisualValues.has(file) && /\bborderRadius\s*:\s*\d/.test(line)) {
      advisories.push(`${relative}:${index + 1} local curve`);
    }
  });
}

if (advisories.length) {
  console.log('Design advisories');
  advisories.forEach((item) => console.log(`  ${item}`));
}

if (failures.length) {
  console.error('Design violations');
  failures.forEach((item) => console.error(`  ${item}`));
  process.exitCode = 1;
} else {
  console.log('Design audit passed');
}
