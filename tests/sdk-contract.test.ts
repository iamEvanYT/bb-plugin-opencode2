import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

test("uses only public SDK and package-local imports", () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const scan = experimental_scanPublicSdkOnly(packageRoot, {
    allow: [
      /^react$/,
      /^@testing-library\/react$/,
      /^@radix-ui\/react-slot$/,
      /^class-variance-authority$/,
      /^clsx$/,
      /^tailwind-merge$/,
      /^vitest(?:\/config)?$/,
      /^@\//,
    ],
  });

  assert.deepEqual(scan.privateDependencies, []);
  assert.deepEqual(scan.violations, []);
});
