import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'

const plugins = [
  resolve({ browser: true, preferBuiltins: false }),
  commonjs(),
  json(),
]

export default [
  {
    input: 'src/index.js',
    output: {
      file: 'dist/leadtodeed-widget.esm.js',
      format: 'es',
      sourcemap: false,
    },
    plugins,
  },
  {
    input: 'src/index.js',
    output: {
      file: 'dist/leadtodeed-widget.iife.js',
      format: 'iife',
      name: 'Leadtodeed',
      exports: 'named',
      sourcemap: false,
      footer: 'Leadtodeed = Object.assign(Leadtodeed.default, Leadtodeed);',
    },
    plugins,
  },
]
