const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "node-server.js");
const renderPath = path.join(root, "render.yaml");

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  const source = fs.readFileSync(serverPath, "utf8");
  new Function(source);
} catch (error) {
  fail(`Server syntax check failed: ${error.message}`);
}

if (!fs.existsSync(renderPath)) {
  fail("Render config is missing.");
}

console.log("App checks passed.");
