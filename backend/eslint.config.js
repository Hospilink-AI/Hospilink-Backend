// ESLint flat config. Errors are bugs (undefined names, unreachable code,
// duplicate keys, ...) and block CI. Style and tidiness are warnings, so the
// existing code can be cleaned up over time without blocking merges.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['node_modules/**', 'coverage/**']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-useless-escape': 'warn',
            'no-prototype-builtins': 'warn',
            'no-case-declarations': 'warn',
            'no-control-regex': 'warn',
            'no-inner-declarations': 'warn',
            // Real bugs: fail the build
            'no-undef': 'error',
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-class-members': 'error',
            'no-const-assign': 'error',
            'no-func-assign': 'error',
            'no-self-assign': 'error',
            'no-unsafe-finally': 'error',
            'no-async-promise-executor': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'eqeqeq': ['warn', 'smart'],
            'no-return-await': 'off'
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.jest } }
    }
];
