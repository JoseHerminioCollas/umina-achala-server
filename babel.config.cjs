// Jest runs the ES modules through Babel, umina-achala-chain's too (it is a
// dependency, linked or under node_modules; see jest.config.js).
module.exports = { presets: [["@babel/preset-env", { targets: { node: "current" } }]] };
