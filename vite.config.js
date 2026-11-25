import { defineConfig } from 'vite';

// Relative base so the build works both locally and under
// https://<user>.github.io/expense-converter/ on GitHub Pages.
export default defineConfig({
  base: './'
});
