const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')

const createVirtualEntryPlugin = require('./entry-plugin')
const createDev8Plugin = require('./dev8-plugin')

const rootPath = process.cwd()
const distPath = path.join(rootPath, 'dist')
const srcPath = path.join(rootPath, 'src')
const setupPath = path.join(rootPath, 'setup')

/*
 * setup.html is an authoring tool rather than part of the experience, but it is
 * deployed alongside it: served from the real origin, its QR codes encode a
 * public HTTPS URL, which is far easier to open on a phone than a LAN address
 * behind a self-signed certificate. Set EXCLUDE_SETUP=1 to leave it out.
 *
 * Its sources live in setup/ rather than src/ on purpose. entry-plugin.js
 * writes a virtual entry that imports *every* .ts and .js under src/ (skipping
 * only `assets` and `.dependencies`), so anything put there would be pulled
 * into the AR bundle — which would mean the AR page downloading Leaflet, and
 * the picker's DOM bootstrap running against a page that has none of its
 * elements. Outside src/ the plugin never sees it, and the two entries stay
 * genuinely separate.
 */
const includeSetup = process.env.EXCLUDE_SETUP !== '1'

const makeTsLoader = () => ({
  test: /\.ts$/,
  loader: 'ts-loader',
  exclude: /node_modules/,
})

const makeAssetLoader = () => ({
  test: /\..*$/,
  include: [path.join(srcPath, 'assets')],
  loader: path.join(__dirname, 'asset-loader.js'),
})

/*
 * Only the setup page has stylesheets — Leaflet's own, which the map is
 * unusable without, plus the picker's. style-loader injects them from the
 * setup chunk at runtime, so there is no extra file for setup.html to link
 * and no risk of the AR page picking any of it up.
 */
const makeCssLoader = () => ({
  test: /\.css$/,
  // src/assets is the asset-loader's territory; every rule that matches a file
  // runs against it, so keep the two from overlapping.
  exclude: [path.join(srcPath, 'assets')],
  use: ['style-loader', 'css-loader'],
})

/*
 * Leaflet's CSS references images/layers.png and the default marker icons by
 * url(). Nothing here uses the default markers (the pins are divIcons) and the
 * layers control is off, but css-loader still has to resolve them. They are a
 * few hundred bytes each, so inline them as data URIs rather than emitting
 * five files whose paths would then depend on output.publicPath.
 */
const makeLeafletImageLoader = () => ({
  test: /\.(png|gif|jpe?g|svg)$/i,
  include: [path.join(rootPath, 'node_modules', 'leaflet')],
  type: 'asset/inline',
})

const config = {
  entry: {
    // Key names decide the emitted filenames; `bundle` keeps the AR page's
    // script at dist/bundle.js, which src/index.html hard-codes.
    bundle: './entry.js',
    ...(includeSetup ? { setup: path.join(setupPath, 'main.ts') } : {}),
  },
  output: {
    filename: '[name].js',
    path: distPath,
    publicPath: '/',
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: path.join(srcPath, 'index.html'),
      filename: 'index.html',
      scriptLoading: 'blocking',
      inject: false,
      chunks: ['bundle'],
    }),
    /*
     * Netlify serves its own branded "page not found" for any path that does
     * not resolve, which is where the stray "Powered by Netlify" comes from —
     * it is not in our output anywhere. Netlify picks up a 404.html at the
     * publish root automatically, so shipping one replaces it.
     */
    new HtmlWebpackPlugin({
      template: path.join(srcPath, '404.html'),
      filename: '404.html',
      inject: false,
      chunks: [],
    }),
    ...(includeSetup ? [new HtmlWebpackPlugin({
      template: path.join(setupPath, 'setup.html'),
      filename: 'setup.html',
      chunks: ['setup'],
      inject: 'body',
      scriptLoading: 'defer',
      // Relative, so the page also works when the build is served from a
      // subdirectory. output.publicPath is '/' for the AR runtime's sake.
      publicPath: './',
    })] : []),
    new CopyWebpackPlugin({
      patterns: [
        {
          from: path.join(rootPath, 'node_modules/@8thwall/ecs/dist'),
          to: path.join(distPath, 'external/runtime'),
        },
        {
          from: path.join(srcPath, 'assets'),
          to: path.join(distPath, 'assets'),
          noErrorOnMissing: true,
        },
        /*
         * At the publish root, not under assets/: browsers request
         * /favicon.ico on their own without being told to, and with a 404.html
         * in place that request would otherwise be answered with the whole
         * branded not-found page.
         */
        {
          from: path.join(srcPath, 'favicon.ico'),
          to: distPath,
        },
        {
          from: path.join(rootPath, 'image-targets'),
          to: path.join(distPath, 'image-targets'),
          noErrorOnMissing: true,
        },
      ],
    }),
    createVirtualEntryPlugin({
      srcDir: srcPath,
    }),
  ],
  resolve: {extensions: ['.ts', '.js']},
  module: {
    rules: [
      makeTsLoader(),
      makeAssetLoader(),
      makeCssLoader(),
      makeLeafletImageLoader(),
    ],
  },
  mode: 'production',
  context: srcPath,
  externals: {
    '@8thwall/ecs': 'window.ecs',
  },
  devServer: {
    open: false,
    compress: true,
    hot: true,
    liveReload: false,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'X-Requested-With, content-type, Authorization',
    },
    client: {
      webSocketURL: 'ws://0.0.0.0/ws',
      overlay: {
        warnings: false,
        errors: true,
      },
    },
  },
}

module.exports = (_, argv) => {
  if (argv.mode === 'development') {
    return {
      ...config,
      plugins: [
        ...config.plugins,
        createDev8Plugin({src: './external/dev8/dev8.js'}),
        new CopyWebpackPlugin({
          patterns: [{
            from: path.join(rootPath, 'node_modules/@8thwall/ecs/dev8'),
            to: path.join(distPath, 'external/dev8'),
            noErrorOnMissing: true,
          }],
        }),
      ],
    }
  }

  return config
}
