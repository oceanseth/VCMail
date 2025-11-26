import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        // Preserve directory structure
        entryFileNames: 'src/[name].js',
        chunkFileNames: 'src/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          // Keep CSS in src directory with proper extension
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'src/[name][extname]';
          }
          // Extract CSS files (Vite extracts CSS from JS bundles)
          if (assetInfo.name === 'index.css' || assetInfo.name === 'styles.css') {
            return 'src/styles.css';
          }
          // Keep images in images directory
          if (assetInfo.name && assetInfo.name.match(/\.(webp|png|jpg|jpeg|gif|svg|ico)$/)) {
            return 'images/[name][extname]';
          }
          // Default: preserve name and extension
          const ext = assetInfo.name ? path.extname(assetInfo.name) : '';
          const name = assetInfo.name ? path.basename(assetInfo.name, ext) : 'asset';
          if (ext === '.css') {
            return `src/${name}.css`;
          }
          return `[name][extname]`;
        }
      }
    },
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false, // Keep console logs for debugging
        drop_debugger: true,
      },
      format: {
        comments: false,
      },
    },
    cssMinify: true, // Use esbuild for CSS minification (default, fast and efficient)
    sourcemap: false, // Disable sourcemaps for production
    target: 'es2020', // Modern browsers
  },
  publicDir: 'public',
  server: {
    port: 3000,
    open: true,
  },
});

