import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  server: {
    open: true,
  },
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.bin', '**/*.png'],
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'assets', dest: '' },
        { src: 'environment', dest: '' },
        { src: 'charecter', dest: '' },
        { src: 'config.json', dest: '' },
        { src: 'mapdata.json', dest: '' },
      ],
    }),
  ],
});
