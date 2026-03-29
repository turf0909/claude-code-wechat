const fs = require("fs");
const path = require("path");

const files = [
  path.join(__dirname, "..", "dist", "wechat-channel.js"),
  path.join(__dirname, "..", "dist", "setup.js"),
  path.join(__dirname, "..", "dist", "sdk-mode.js"),
];

for (const f of files) {
  const content = fs.readFileSync(f, "utf8");
  const stripped = content.replace(/^\/\/ @bun\r?\n/m, "");
  if (content !== stripped) {
    fs.writeFileSync(f, stripped);
    console.log(`Stripped // @bun from ${path.basename(f)}`);
  }
}
