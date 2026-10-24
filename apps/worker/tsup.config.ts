import { defineConfig } from 'tsup';

// Bundles workspace packages (TypeScript sources) into one CommonJS file; npm deps stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/^@crm\//],
  skipNodeModulesBundle: true,
  external: ['@prisma/client', '@node-rs/argon2'],
  esbuildOptions(o) {
    o.conditions = ['development'];
  },
});
