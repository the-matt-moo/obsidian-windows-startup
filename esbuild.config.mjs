import esbuild from 'esbuild';
const production = process.argv.includes('production');
const context = await esbuild.context({
  entryPoints: ['main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@electron/remote'],
  platform: 'node',
  target: 'es2020',
  format: 'cjs',
  outfile: 'main.js',
  sourcemap: production ? false : 'inline',
  minify: production,
});
if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
