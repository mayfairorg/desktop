'use strict';
// Mayfair Ghost security-intelligence connectors: the folders under ./connectors are ordinary connector folders (connector.json + run.js + files).
// registerAll() puts them in front of the ConnectorManager as NOT approved; approval, self-test and enabling stay with the user. The tool
// installer and the instance-config helper are exported for the Ghost service to wire to the bridge.
const fs = require('node:fs');
const path = require('node:path');
const { ToolInstaller } = require('./installer');
const { CATALOG } = require('./catalog');
const instanceConfig = require('./instance-config');

const connectorsDir = path.join(__dirname, 'connectors');
const connectorIds = () => fs.readdirSync(connectorsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
function registerAll(manager, ids = connectorIds()) {
  return ids.map((id) => ({ id, ...manager.register(path.join(connectorsDir, id)) }));
}
module.exports = { connectorsDir, connectorIds, registerAll, ToolInstaller, CATALOG, instanceConfig };
