// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  }
  ,
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/constants/theme",
              message: "Use the design tokens and useTheme from @/design.",
            },
            {
              name: "@/constants/colors",
              message: "Use semantic colors through useTheme.",
            },
            {
              name: "react-native",
              importNames: ["Text"],
              message: "Use Text from @/components/ui.",
            },
          ],
          patterns: [
            {
              group: ["@/components/ui/*"],
              message: "Import canonical components from @/components/ui.",
            },
          ],
        },
      ],
    },
  }
]);
