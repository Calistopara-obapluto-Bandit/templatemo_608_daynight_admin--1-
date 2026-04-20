const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const serverPath = path.join(root, "node-server.js");
const renderPath = path.join(root, "render.yaml");
const packageLockPath = path.join(root, "package-lock.json");
const circleConfigPath = path.join(root, ".circleci", "config.yml");

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

if (!fs.existsSync(packageLockPath)) {
  fail("package-lock.json is missing. Use npm ci for reproducible installs.");
}

try {
  const renderConfig = fs.readFileSync(renderPath, "utf8");
  if (!renderConfig.includes("buildCommand: npm ci && npm test")) {
    fail("Render build command must be 'npm ci && npm test'.");
  }
  if (!renderConfig.includes("plan: free")) {
    fail("Render plan must be 'free' for this deployment.");
  }
  if (!renderConfig.includes("startCommand: npm start")) {
    fail("Render start command must be 'npm start'.");
  }
  if (!renderConfig.includes("healthCheckPath: /healthz")) {
    fail("Render health check path must be '/healthz'.");
  }
  if (!renderConfig.includes("DATABASE_URL")) {
    fail("Render must expose DATABASE_URL for the existing database connection.");
  }
  if (renderConfig.includes("databases:")) {
    fail("Blueprint must not create a second free database in this workspace.");
  }
} catch (error) {
  fail(`Render config validation failed: ${error.message}`);
}

if (fs.existsSync(circleConfigPath)) {
  const circleConfig = fs.readFileSync(circleConfigPath, "utf8");
  if (!circleConfig.includes("command: npm ci")) {
    fail("CircleCI must use npm ci for installs.");
  }
}

console.log("App checks passed.");
