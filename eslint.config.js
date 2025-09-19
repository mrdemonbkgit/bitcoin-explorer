import js from '@eslint/js';
import pluginN from 'eslint-plugin-n';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules', 'coverage', 'dist', 'views', 'docs']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    plugins: {
      n: pluginN
    },
    rules: {
      ...js.configs.recommended.rules,
      ...pluginN.configs['flat/recommended-module'].rules,
      'n/no-missing-import': 'off',
      'n/no-unpublished-import': ['error', {
        allowModules: [
          '@eslint/js',
          'eslint-plugin-n',
          'eslint-config-prettier',
          'globals',
          'vitest',
          'supertest',
          '@vitest/coverage-v8'
        ]
      }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    },
    settings: {
      node: {
        version: '24.8.0',
        tryExtensions: ['.js', '.mjs', '.json']
      }
    }
  },
  {
    files: ['scripts/**/*.js'],
    rules: {
      'n/hashbang': 'off'
    }
  },
  prettier
];
