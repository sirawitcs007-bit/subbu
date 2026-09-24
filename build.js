// Builds the installable app from the shared source.
//   src/app.html  -> the page body, also published as the Claude artifact
//   index.html    -> src/app.html wrapped in a full document with PWA tags
//   sw.js         -> cache VERSION stamped with a hash of index.html
// Usage: node build.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const src = fs.readFileSync(path.join(root, "src", "app.html"), "utf8");
const styleEnd = src.indexOf("</style>");
if (styleEnd < 0) throw new Error("src/app.html has no </style>");

const head = `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="ติดตามค่าสมาชิก บิล และค่างวด พร้อมเตือนก่อนตัดเงิน">
<meta name="theme-color" content="#F4F6F5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0D1311" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="SUBBU">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<style>
/* What the Claude artifact viewer normally provides around the page. */
:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0}
img{max-width:100%}
</style>
<script src="firebase-config.js"></script>
`;

const register = `
<script>
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
</script>
`;

const html = head + src.slice(0, styleEnd + 8) + "\n</head>\n<body>" + src.slice(styleEnd + 8) + register + "</body>\n</html>\n";
fs.writeFileSync(path.join(root, "index.html"), html);

const version = "subbu-" + crypto.createHash("sha256").update(html).digest("hex").slice(0, 10);
const swPath = path.join(root, "sw.js");
fs.writeFileSync(swPath, fs.readFileSync(swPath, "utf8").replace(/const VERSION = "[^"]*";/, `const VERSION = "${version}";`));

console.log(`Built index.html (${(html.length / 1024).toFixed(0)} KB), cache ${version}`);
