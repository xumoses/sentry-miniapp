import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

// Symlinked package stores may resolve outside the checkout. Publish portable
// dependency source names instead of embedding a developer's machine paths.
function sourcemapPathTransform(sourcePath) {
  const normalized = sourcePath.replace(/\\/g, '/');
  const dependencyStart = normalized.lastIndexOf('/node_modules/');
  return dependencyStart >= 0
    ? `../node_modules/${normalized.slice(dependencyStart + '/node_modules/'.length)}`
    : normalized;
}

// 通用构建配置
const baseConfig = {
  build: {
    sourcemap: true,
    minify: 'esbuild',
    target: 'es2015',
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
};

export default defineConfig(({ mode }) => {
  if (mode === 'miniapp') {
    // 小程序构建配置 - 内联所有依赖
    return {
      ...baseConfig,
      build: {
        ...baseConfig.build,
        lib: {
          entry: resolve(__dirname, 'src/index.ts'),
          name: 'SentryMiniapp',
          fileName: 'sentry-miniapp',
          formats: ['cjs'] // 小程序只需要 CommonJS 格式
        },
        outDir: 'examples/wxapp/lib',
        rollupOptions: {
          // 小程序版本内联所有依赖
          external: [],
          output: {
            sourcemapPathTransform,
            format: 'cjs',
            exports: 'auto'
          }
        }
      },
      define: {
        __DEV__: mode === 'development'
      }
    };
  }

  // 标准 npm 包构建配置
  return {
    ...baseConfig,
    build: {
      ...baseConfig.build,
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        name: 'SentryMiniapp',
      },
      outDir: 'dist',
      rollupOptions: {
        external: [],
        output: [
          {
            sourcemapPathTransform,
            format: 'es',
            entryFileNames: 'sentry-miniapp.esm.js',
            exports: 'named'
          },
          {
            sourcemapPathTransform,
            format: 'cjs',
            entryFileNames: 'sentry-miniapp.cjs.js',
            exports: 'auto'
          },
          {
            sourcemapPathTransform,
            format: 'umd',
            entryFileNames: 'sentry-miniapp.umd.js',
            name: 'SentryMiniapp',
            exports: 'auto',
            globals: {}
          }
        ]
      }
    },
    plugins: [
      // 生成 TypeScript 类型定义文件
      dts({
        include: ['src/**/*'],
        exclude: ['src/**/*.test.ts', 'test/**/*'],
        outDir: 'dist/types'
      })
    ],
    define: {
      __DEV__: mode === 'development'
    }
  };
});
