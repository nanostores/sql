let { getDefaultConfig } = require('expo/metro-config')
let path = require('path')

let projectRoot = __dirname
let monorepoRoot = path.resolve(projectRoot, '../..')

let config = getDefaultConfig(projectRoot)

config.watchFolders = [monorepoRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules')
]
config.resolver.disableHierarchicalLookup = true

// Add wasm asset support
config.resolver.assetExts.push('wasm')

// Add COEP and COOP headers to support SharedArrayBuffer
config.server.enhanceMiddleware = middleware => {
  return (req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    middleware(req, res, next)
  }
}

module.exports = config
